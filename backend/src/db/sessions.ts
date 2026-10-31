import session, { type SessionData } from "express-session";
import connectPgSimple from "connect-pg-simple";
import type pg from "pg";
import { findTenantConfiguration } from "../config.js";
import { AppError } from "../errors.js";
import { isAppRole } from "../services/capabilityRegistry.js";
import { normalizeInventoryProviderRoleIds } from "../services/inventoryRoleScope.js";
import { operationalLog } from "../services/telemetry.js";
import { appRoles, hasAppRole, type AppRole } from "../types/capability.js";
import { DataGenerations } from "./dataGenerations.js";
import { currentAuthority } from "../auth/authorityContext.js";
import type { DelegatedCredentialSource } from "../types/requestPrincipal.js";
import { assertAuthSignal, authCancelled } from "../auth/boundedAuth.js";

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
  await new DataGenerations(database).revokePrincipal(tenantId, principalId, { preserveSources: true });
  await database.query("DELETE FROM sessions WHERE tenant_id=$1 AND principal_id=$2", [tenantId, principalId]);
}

type SessionValidation = { key: string; generation: number; authority?: DelegatedCredentialSource };
type AccountMutationState = { generation: number; revoked: boolean; bearerIssuedAfter: number; tail: Promise<void>; pending: number };
const accountMutations = new Map<string, AccountMutationState>();
let nextGeneration = 0;
const maximumAccountMutationStates = 10_000;

export function beginAccountSessionValidation(tenantId: string, principalId: string, bindAuthority = true): SessionValidation {
  const key = accountMutationKey(tenantId, principalId);
  const state = accountMutationState(key);
  const source = bindAuthority ? currentAuthority() : undefined;
  if (source && (source.principal.tenantId !== tenantId || source.principal.principalId !== principalId)) throw AppError.unauthorized();
  return { key, generation: state.generation, ...(source ? { authority: source } : {}) };
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
  validation.authority?.assertCurrent();
}

export function authorizeAccountBearer<T>(
  tenantId: string, principalId: string, issuedAt: number,
  operation: (validation: SessionValidation) => Promise<T>, signal?: AbortSignal,
) {
  const validation = beginAccountSessionValidation(tenantId, principalId);
  const state = accountMutations.get(validation.key)!;
  const assertCandidate = () => {
    assertAuthSignal(signal);
    if (accountMutations.get(validation.key) !== state || state.generation !== validation.generation
      || !Number.isSafeInteger(issuedAt) || issuedAt <= state.bearerIssuedAfter) {
      throw AppError.unauthorized("The bearer was revoked or superseded.");
    }
    validation.authority?.assertCurrent();
  };
  return enqueueAccountMutation(state, async () => {
    assertCandidate();
    let abort!: () => void;
    const cancelled = new Promise<never>((_resolve, reject) => {
      abort = () => reject(authCancelled());
      signal?.addEventListener("abort", abort, { once: true });
    });
    try {
      const result = await Promise.race([operation(validation), cancelled]);
      assertCandidate();
      // A proven post-revocation assertion opens this generation, not a new one.
      state.revoked = false;
      return result;
    } finally { signal?.removeEventListener("abort", abort); }
  });
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
      AND jsonb_exists_any(COALESCE((sess->'user'->'roles')::jsonb,'[]'::jsonb),$4::text[])`,
  [sessionId, tenantId, principalId, appRoles.filter(role => hasAppRole([role], requiredRole)), tenant.clientId]);
  if (result.rowCount !== 1) throw AppError.unauthorized("The export session or required role is no longer current.");
}

export function activateAccountSession<T>(tenantId: string, principalId: string, operation: () => Promise<T>) {
  const state = accountMutationState(accountMutationKey(tenantId, principalId));
  const generation = ++nextGeneration;
  state.generation = generation;
  state.revoked = true;
  return enqueueAccountMutation(state, async () => {
    if (state.generation !== generation) throw AppError.unauthorized("The sign-in was superseded.");
    const result = await operation();
    if (state.generation !== generation) throw AppError.unauthorized("The sign-in was superseded.");
    state.revoked = false;
    return result;
  });
}

export function revokeAccountSessionMutations<T>(tenantId: string, principalId: string, operation: () => Promise<T>) {
  const state = accountMutationState(accountMutationKey(tenantId, principalId));
  state.generation = ++nextGeneration;
  state.revoked = true;
  state.bearerIssuedAfter = Math.max(state.bearerIssuedAfter, Date.now());
  return enqueueAccountMutation(state, operation);
}

function accountMutationKey(tenantId: string, principalId: string) {
  return `${tenantId}\0${principalId}`;
}

function accountMutationState(key: string) {
  let state = accountMutations.get(key);
  if (!state) {
    state = { generation: ++nextGeneration, revoked: false, bearerIssuedAfter: 0, tail: Promise.resolve(), pending: 0 };
    accountMutations.set(key, state);
    pruneAccountMutationStates(state);
  }
  return state;
}

function pruneAccountMutationStates(protectedState?: AccountMutationState) {
  if (accountMutations.size <= maximumAccountMutationStates) return;
  // Never split an account's queue while a save, sign-in or revocation is pending.
  for (const [key, state] of accountMutations) {
    if (state.pending || state === protectedState) continue;
    accountMutations.delete(key);
    if (accountMutations.size <= maximumAccountMutationStates) break;
  }
}

export function clearAccountSessionMutationsForTest() {
  if (process.env.NODE_ENV !== "test") throw new Error("test_only");
  accountMutations.clear();
}

function enqueueAccountMutation<T>(state: AccountMutationState, operation: () => Promise<T>) {
  state.pending++;
  const result = state.tail.then(operation, operation);
  const settled = () => {
    state.pending--;
    pruneAccountMutationStates();
  };
  state.tail = result.then(settled, settled);
  return result;
}