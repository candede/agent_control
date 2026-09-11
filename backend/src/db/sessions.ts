import session, { type SessionData } from "express-session";
import connectPgSimple from "connect-pg-simple";
import type pg from "pg";
import { AppError } from "../errors.js";
import { isAppRole } from "../services/capabilityRegistry.js";
import { normalizeInventoryProviderRoleIds } from "../services/inventoryRoleScope.js";

const PgSessionStore = connectPgSimple(session);

export function createSessionStore(database: pg.Pool, tenantId: string) {
  const store = new PgSessionStore({ pool: database, tableName: "sessions", createTableIfMissing: false,
    pruneSessionInterval: false, errorLog: () => console.error(JSON.stringify({ event: "session_store_error" })) });
  const get = store.get.bind(store);
  const set = store.set.bind(store);
  store.get = (id, callback) => get(id, (error, data) => callback(error, data?.tenantId === tenantId ? data : null));
  store.set = (id, data, callback) => {
    if (data.user && (data.user.tenantId !== tenantId || data.accountId !== data.user.homeAccountId)) {
      callback?.(new Error("Session tenant/principal mismatch.")); return;
    }
    const sanitized: SessionData = {
      cookie: data.cookie, tenantId, authFlowHandle: typeof data.authFlowHandle === "string" && /^[a-zA-Z0-9_-]{43}$/.test(data.authFlowHandle) ? data.authFlowHandle : undefined, accountId: data.accountId,
      csrfToken: data.csrfToken, rolesValidatedAt: data.rolesValidatedAt,
      user: data.user ? { tenantId, homeAccountId: data.user.homeAccountId, displayName: data.user.displayName.slice(0,256), username: data.user.username.slice(0,256), roles: [...new Set(data.user.roles.filter(isAppRole))].sort(), providerRoleIds: normalizeInventoryProviderRoleIds(data.user.providerRoleIds) } : undefined,
    };
    set(id, sanitized, callback);
  };
  return store;
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
    if (state.revoked || state.generation !== validation.generation) throw AppError.unauthorized("The session was revoked or superseded.");
    return operation();
  });
}

export async function assertCurrentStoredSession(
  database: pg.Pool,
  sessionId: string,
  tenantId: string,
  principalId: string,
  requiredRole: string,
) {
  const result = await database.query(`SELECT 1 FROM sessions
    WHERE sid=$1 AND tenant_id=$2 AND principal_id=$3 AND expire>clock_timestamp()
      AND jsonb_exists(COALESCE((sess->'user'->'roles')::jsonb,'[]'::jsonb),$4)`,
  [sessionId, tenantId, principalId, requiredRole]);
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