import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { AppError } from "../errors.js";
import { findTenantConfiguration, loginScopes, normalizeSignInUsername, type TenantConfiguration } from "../config.js";
import type { AuthFlow } from "../types/session.js";

export const authFlowLifetimeMs = 10 * 60 * 1000;
export const authenticationScopes: readonly string[] = [...loginScopes, "offline_access"];
export const adminManagedPermissionsMessage = "An administrator must add the required API permissions to the existing Entra app registration and select Grant admin consent before app use. Permissions cannot be requested or enabled in Agent Control.";
const maximumAuthFlows = 10_000;
type StoredFlow = { sessionId: string; flow: AuthFlow; binding: string };
const authFlows = new Map<string, StoredFlow>();

export function adminManagedPermissionsError() {
  return new AppError(410, "admin_managed_permissions", adminManagedPermissionsMessage);
}

export function assertLoginAuthFlow(flow: AuthFlow) {
  if (flow.kind !== "login" || "extraScopesToConsent" in flow || "capabilityId" in flow || "accountId" in flow
    || !Array.isArray(flow.scopes) || flow.scopes.length !== authenticationScopes.length
    || flow.scopes.some((scope, index) => scope !== authenticationScopes[index])) {
    throw adminManagedPermissionsError();
  }
  const tenant = assertTenantConfiguration(flow.tenantId, flow.configurationFingerprint);
  let username: string;
  try { username = normalizeSignInUsername(flow.username); }
  catch (error) {
    if (error instanceof AppError && error.code === "invalid_username") {
      throw new AppError(400, "invalid_auth_state", "The authentication request contains an invalid sign-in hint.");
    }
    throw error;
  }
  if (flow.clientId !== tenant.clientId || username !== flow.username) {
    throw new AppError(400, "invalid_auth_state", "The sign-in identity no longer matches this authentication request.");
  }
  if (![flow.state, flow.nonce, flow.codeVerifier].every(value => typeof value === "string" && /^[a-zA-Z0-9_-]{43}$/.test(value))
    || !Number.isFinite(flow.createdAt) || typeof flow.returnTo !== "string") {
    throw new AppError(400, "invalid_auth_state", "The authentication request is invalid. Start again.");
  }
}

export function tenantConfigurationFingerprint(tenant: TenantConfiguration) {
  return createHash("sha256").update(JSON.stringify([
    tenant.tenantId, tenant.clientId, tenant.clientSecret, [...tenant.domains].sort(), tenant.displayName,
  ])).digest("hex");
}

export function assertTenantConfiguration(tenantId: string, fingerprint: string) {
  const tenant = findTenantConfiguration(tenantId);
  if (!tenant || tenantConfigurationFingerprint(tenant) !== fingerprint) {
    throw new AppError(400, "invalid_auth_state", "The tenant configuration changed. Start sign-in again.");
  }
  return tenant;
}

export function storeAuthFlow(sessionId: string, previousHandle: string | undefined, flow: AuthFlow, now = Date.now()) {
  assertLoginAuthFlow(flow);
  if (previousHandle) authFlows.delete(previousHandle);
  pruneAuthFlows(now);
  while (authFlows.size >= maximumAuthFlows) authFlows.delete(authFlows.keys().next().value!);
  let handle: string;
  do { handle = randomBytes(32).toString("base64url"); } while (authFlows.has(handle));
  authFlows.set(handle, { sessionId, flow, binding: flowBinding(flow) });
  return handle;
}

export function consumeAuthFlow(sessionId: string, handle: string | undefined, state: string | undefined, now = Date.now()) {
  const stored = handle ? authFlows.get(handle) : undefined;
  if (handle) authFlows.delete(handle);
  if (!stored || stored.sessionId !== sessionId) throw new AppError(400, "invalid_auth_state", "The sign-in state did not match this session.");
  if (stored.flow.createdAt > now || now - stored.flow.createdAt >= authFlowLifetimeMs) throw new AppError(400, "expired_auth_state", "The authentication request expired. Start again.");
  if (!state || !matches(stored.flow.state, state)) throw new AppError(400, "invalid_auth_state", "The sign-in state did not match this session.");
  assertLoginAuthFlow(stored.flow);
  if (stored.binding !== flowBinding(stored.flow)) throw new AppError(400, "invalid_auth_state", "The authentication request changed. Start again.");
  return stored.flow;
}

function flowBinding(flow: AuthFlow) {
  return createHash("sha256").update(JSON.stringify(flow)).digest("hex");
}

export function clearAuthFlowsForTest() {
  if (process.env.NODE_ENV !== "test") throw new Error("Auth flow reset is unavailable outside tests.");
  authFlows.clear();
}

function pruneAuthFlows(now: number) {
  for (const [handle, stored] of authFlows) if (now - stored.flow.createdAt >= authFlowLifetimeMs) authFlows.delete(handle);
}

function matches(expected: string, actual: string) {
  const left = Buffer.from(expected);
  const right = Buffer.from(actual);
  return left.length === right.length && timingSafeEqual(left, right);
}