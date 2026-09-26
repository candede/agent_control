import session, { type SessionData } from "express-session";
import connectPgSimple from "connect-pg-simple";
import type pg from "pg";
import { findTenantConfiguration } from "../config.js";
import { AppError } from "../errors.js";
import { isAppRole } from "../services/capabilityRegistry.js";
import { normalizeInventoryProviderRoleIds } from "../services/inventoryRoleScope.js";
import { operationalLog } from "../services/telemetry.js";
import type { AppRole } from "../types/capability.js";

const PgSessionStore = connectPgSimple(session);

export function createSessionStore(database: pg.Pool) {
  const store = new PgSessionStore({ pool: database, tableName: "sessions", createTableIfMissing: false,
    pruneSessionInterval: false, errorLog: () => operationalLog("error", "session_store_error") });
  const get = store.get.bind(store);
  const set = store.set.bind(store);
  const destroy = store.destroy.bind(store);
  store.get = (id, callback) => get(id, (error, data) => {
    if (error || !data) { callback(error, null); return; }
    const sanitized = sanitizedSession(data, false);
    if (!sanitized) {
      destroy(id, destroyError => callback(destroyError ?? null, null));
      return;
    }
    callback(null, sanitized);
  });
  store.set = (id, data, callback) => {
    const sanitized = sanitizedSession(data, true);
    if (!sanitized) { callback?.(new Error("Session tenant/principal/client mismatch.")); return; }
    set(id, sanitized, callback);
  };
  return store;
}

export function getValidatedSessionIdentity(data: Partial<SessionData> | undefined) {
  return sessionIdentity(data, false);
}

function sessionIdentity(data: Partial<SessionData> | undefined, allowMissingClientId: boolean) {
  const tenant = findTenantConfiguration(data?.tenantId);
  const user = data?.user;
  if (!tenant || !user || user.tenantId !== tenant.tenantId
    || typeof data.accountId !== "string" || !data.accountId || data.accountId !== user.homeAccountId
    || data.clientId !== tenant.clientId && !(allowMissingClientId && data.clientId === undefined)
    || typeof user.username !== "string" || !user.username.trim() || typeof user.displayName !== "string"
    || !Array.isArray(user.roles) || user.roles.some(role => typeof role !== "string")) return undefined;
  return { tenantId: tenant.tenantId, clientId: tenant.clientId, accountId: data.accountId, user };
}

function sanitizedSession(data: SessionData, allowMissingClientId: boolean): SessionData | undefined {
  const authFlowHandle = typeof data.authFlowHandle === "string" && /^[a-zA-Z0-9_-]{43}$/.test(data.authFlowHandle) ? data.authFlowHandle : undefined;
  if (data.user === undefined && data.tenantId === undefined && data.clientId === undefined && data.accountId === undefined) {
    return { cookie: data.cookie, authFlowHandle };
  }
  const identity = sessionIdentity(data, allowMissingClientId);
  if (!identity) return undefined;
  return {
    cookie: data.cookie, tenantId: identity.tenantId, clientId: identity.clientId, accountId: identity.accountId, authFlowHandle,
    csrfToken: data.csrfToken, rolesValidatedAt: data.rolesValidatedAt, signedInAt: data.signedInAt,
    user: {
      tenantId: identity.tenantId, homeAccountId: identity.accountId,
      displayName: identity.user.displayName.slice(0, 256), username: identity.user.username.slice(0, 256),
      roles: [...new Set(identity.user.roles.filter(isAppRole))].sort(),
      providerRoleIds: normalizeInventoryProviderRoleIds(identity.user.providerRoleIds),
    },
  };
}

export async function revokeAccountSessions(database: pg.Pool, tenantId: string, principalId: string) {
  await database.query("DELETE FROM sessions WHERE tenant_id=$1 AND principal_id=$2", [tenantId, principalId]);
}

type SessionValidation = { key: string; generation: number };
type AccountMutationState = { generation: number; revoked: boolean; tail: Promise<void> };
const accountMutations = new Map<string, AccountMutationState>();
let nextGeneration = 0;
const maximumAccountMutationStates = 10_000;

export function beginAccountSessionValidation(tenantId: string, principalId: string): SessionValidation {
  const key = accountMutationKey(tenantId, principalId);
  const state = accountMutationState(key);
  return { key, generation: state.generation };
}

export function commitAccountSessionValidation<T>(validation: SessionValidation, operation: () => Promise<T>) {
  const state = accountMutations.get(validation.key);
  if (!state) return Promise.reject(AppError.unauthorized("The session was revoked."));
  return enqueueAccountMutation(state, async () => {
    assertAccountSessionValidation(validation);
    return operation();
  });
}

export function assertAccountSessionValidation(validation: SessionValidation) {
  const state = accountMutations.get(validation.key);
  if (!state || state.revoked || state.generation !== validation.generation) {
    throw AppError.unauthorized("The session was revoked or superseded.");
  }
}

export async function assertCurrentStoredSession(
  database: pg.Pool,
  sessionId: string,
  tenantId: string,
  principalId: string,
  requiredRole: AppRole,
) {
  const tenant = findTenantConfiguration(tenantId);
  if (!tenant) throw AppError.unauthorized("The export session or required role is no longer current.");
  const result = await database.query(`SELECT 1 FROM sessions
    WHERE sid=$1 AND tenant_id=$2 AND principal_id=$3 AND expire>clock_timestamp()
      AND sess->>'clientId'=$5 AND sess->'user'->>'tenantId'=$2 AND sess->'user'->>'homeAccountId'=$3
      AND (jsonb_exists(COALESCE((sess->'user'->'roles')::jsonb,'[]'::jsonb),$4)
        OR ($4='AgentControl.Viewer' AND jsonb_exists(COALESCE((sess->'user'->'roles')::jsonb,'[]'::jsonb),'AgentControl.Admin')))`,
  [sessionId, tenantId, principalId, requiredRole, tenant.clientId]);
  if (result.rowCount !== 1) throw AppError.unauthorized("The export session or required role is no longer current.");
}

export function activateAccountSession<T>(tenantId: string, principalId: string, operation: () => Promise<T>) {
  const state = accountMutationState(accountMutationKey(tenantId, principalId));
  const generation = ++nextGeneration;
  state.generation = generation;
  return enqueueAccountMutation(state, async () => {
    if (state.generation !== generation) throw AppError.unauthorized("The sign-in was superseded.");
    state.revoked = false;
    return operation();
  });
}

export function revokeAccountSessionMutations<T>(tenantId: string, principalId: string, operation: () => Promise<T>) {
  const state = accountMutationState(accountMutationKey(tenantId, principalId));
  state.generation = ++nextGeneration;
  state.revoked = true;
  return enqueueAccountMutation(state, operation);
}

function accountMutationKey(tenantId: string, principalId: string) {
  return `${tenantId}\0${principalId}`;
}

function accountMutationState(key: string) {
  let state = accountMutations.get(key);
  if (!state) {
    state = { generation: 0, revoked: false, tail: Promise.resolve() };
    accountMutations.set(key, state);
    while (accountMutations.size > maximumAccountMutationStates) accountMutations.delete(accountMutations.keys().next().value!);
  }
  return state;
}

function enqueueAccountMutation<T>(state: AccountMutationState, operation: () => Promise<T>) {
  const result = state.tail.then(operation, operation);
  state.tail = result.then(() => undefined, () => undefined);
  return result;
}