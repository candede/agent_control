import type { AccountInfo, AuthenticationResult } from "@azure/msal-node";
import type { SessionData } from "express-session";
import type pg from "pg";
import { getTenantConfiguration, normalizeSignInUsername } from "../config.js";
import { beginAccountSessionValidation, assertAccountSessionValidation, authorizeAccountBearer, getValidatedSessionIdentity } from "../db/sessions.js";
import { DataGenerations } from "../db/dataGenerations.js";
import { AppError } from "../errors.js";
import { isAppRole } from "../services/capabilityRegistry.js";
import { normalizeInventoryProviderRoleIds } from "../services/inventoryRoleScope.js";
import { principalAuthorizationHash } from "../services/reportIdentity.js";
import type { RequestPrincipal } from "../types/requestPrincipal.js";
import type { AuthenticatedUser } from "../types/session.js";
import { authorizationFreshnessMs, bearerAssertion, type VerifiedBearer } from "./mcpBearer.js";
import { assertAuthSignal } from "./boundedAuth.js";

const verifiedPrincipals = new WeakSet<RequestPrincipal>();
const accountValidations = new WeakMap<RequestPrincipal, ReturnType<typeof beginAccountSessionValidation>>();
export type PrincipalEpochAuthority = {
  sessionEpoch(tenantId: string, principalId: string): Promise<string>;
  bearerAuthority(tenantId: string, principalId: string): Promise<{ epoch: string; issuedAfter: string }>;
};

export function principalEpochAuthority(database: pg.Pool): PrincipalEpochAuthority {
  return new DataGenerations(database);
}

export async function browserRequestPrincipal(
  session: Partial<SessionData>, account: AccountInfo | null, epochs: PrincipalEpochAuthority,
): Promise<RequestPrincipal> {
  const identity = getValidatedSessionIdentity(session);
  if (!identity || account && (account.tenantId !== identity.tenantId || account.homeAccountId !== identity.accountId
    || !account.localAccountId)) throw AppError.unauthorized("The browser account binding is invalid.");
  const now = Date.now();
  const expiresAt = session.cookie?.expires?.getTime();
  const signedInAt = session.signedInAt;
  const validatedAt = session.rolesValidatedAt;
  if (!validTime(signedInAt, now) || !validTime(validatedAt, now)
    || !expiresAt || !Number.isFinite(expiresAt) || expiresAt <= now
    || signedInAt + 8 * 60 * 60_000 <= now
    || identity.user.roles.some(role => !isAppRole(role))) throw AppError.unauthorized("The browser authority metadata is invalid.");
  const validation = beginAccountSessionValidation(identity.tenantId, identity.accountId);
  assertAccountSessionValidation(validation);
  const epoch = await epochs.sessionEpoch(identity.tenantId, identity.accountId);
  assertAccountSessionValidation(validation);
  return freezePrincipal({
    tenantId: identity.tenantId, principalId: identity.accountId, apiClientId: identity.clientId,
    localAccountId: account?.localAccountId ?? "", username: identity.user.username, displayName: identity.user.displayName,
    roles: identity.user.roles, providerRoleIds: normalizeInventoryProviderRoleIds(identity.user.providerRoleIds),
    transport: "browser", integrationClientId: identity.clientId,
    rolesValidatedAt: validatedAt, authenticatedAt: signedInAt,
    expiresAt: Math.min(expiresAt, signedInAt + 8 * 60 * 60_000), sessionEpoch: epoch, authorizationHash: "",
  }, validation);
}

export async function bearerRequestPrincipal(
  verified: VerifiedBearer, result: AuthenticationResult, clientInfo: string | undefined, epochs: PrincipalEpochAuthority,
  validateExchange: (principalId: string) => void, signal?: AbortSignal,
): Promise<RequestPrincipal> {
  bearerAssertion(verified);
  const account = result.account;
  const claims = result.idTokenClaims as Record<string, unknown>;
  const now = Math.floor(Date.now() / 1000);
  let home: unknown;
  try {
    if (!clientInfo || clientInfo.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(clientInfo)) throw new Error("missing");
    home = JSON.parse(Buffer.from(clientInfo, "base64url").toString("utf8"));
  } catch { throw mappingUnavailable(); }
  const guid = /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
  if (!home || typeof home !== "object" || !("uid" in home) || !("utid" in home)
    || typeof home.uid !== "string" || !guid.test(home.uid) || typeof home.utid !== "string" || !guid.test(home.utid)
    || !account || account.homeAccountId !== `${home.uid}.${home.utid}`
    || account.tenantId !== verified.tenantId || account.localAccountId !== verified.localAccountId
    || result.tenantId !== verified.tenantId || result.uniqueId !== verified.localAccountId
    || result.fromCache || !claims || claims.tid !== verified.tenantId || claims.oid !== verified.localAccountId
    || claims.aud !== verified.apiClientId
    || claims.iss !== `https://login.microsoftonline.com/${verified.tenantId}/v2.0`
    || typeof claims.iat !== "number" || !Number.isSafeInteger(claims.iat) || claims.iat <= 0 || claims.iat > now
    || typeof claims.exp !== "number" || !Number.isSafeInteger(claims.exp) || claims.exp <= now
    || claims.nbf !== undefined && (typeof claims.nbf !== "number" || !Number.isSafeInteger(claims.nbf) || claims.nbf > now)
    || [claims.azp, claims.appid].some(value => value !== undefined && value !== verified.apiClientId)
    || account.idTokenClaims && (account.idTokenClaims.tid !== verified.tenantId
      || account.idTokenClaims.oid !== verified.localAccountId || account.idTokenClaims.aud !== verified.apiClientId)
    || !["login.microsoftonline.com", "login.windows.net"].includes(account.environment)) throw mappingUnavailable();
  let username: string;
  try { username = normalizeSignInUsername(claims.preferred_username ?? account.username); }
  catch { throw mappingUnavailable(); }
  const displayName = typeof claims.name === "string" ? claims.name : account.name ?? username;
  if (displayName.length > 256 || /[\p{Cc}\p{Cs}]/u.test(displayName)) throw mappingUnavailable();
  validateExchange(account.homeAccountId);
  return authorizeAccountBearer(verified.tenantId, account.homeAccountId, verified.issuedAt, async validation => {
    assertAuthSignal(signal);
    const authority = await epochs.bearerAuthority(verified.tenantId, account.homeAccountId);
    assertAuthSignal(signal);
    if (!/^\d+$/.test(authority.epoch) || !/^\d+$/.test(authority.issuedAfter)
      || BigInt(verified.issuedAt) <= BigInt(authority.issuedAfter)) {
      throw AppError.unauthorized("The bearer predates account revocation.");
    }
    bearerAssertion(verified);
    return freezePrincipal({
      tenantId: verified.tenantId, principalId: account.homeAccountId, apiClientId: verified.apiClientId,
      localAccountId: verified.localAccountId, username, displayName,
      roles: verified.roles, providerRoleIds: verified.providerRoleIds,
      transport: "bearer", integrationClientId: verified.integrationClientId,
      rolesValidatedAt: verified.issuedAt, authenticatedAt: verified.issuedAt, expiresAt: verified.expiresAt,
      sessionEpoch: authority.epoch, authorizationHash: "",
    }, validation);
  }, signal);
}

function freezePrincipal(value: RequestPrincipal, validation: ReturnType<typeof beginAccountSessionValidation>): RequestPrincipal {
  const tenant = getTenantConfiguration(value.tenantId);
  if (tenant.clientId !== value.apiClientId || !value.principalId || value.transport === "bearer" && !value.localAccountId
    || !/^\d+$/.test(value.sessionEpoch) || value.roles.some(role => !isAppRole(role))
    || value.transport === "browser" && value.integrationClientId !== tenant.clientId
    || value.transport === "bearer" && value.integrationClientId !== tenant.integration?.clientId) throw AppError.unauthorized();
  const roles = Object.freeze([...new Set(value.roles)].sort());
  const providerRoleIds = Object.freeze(normalizeInventoryProviderRoleIds(value.providerRoleIds));
  const principal = Object.freeze({ ...value, roles, providerRoleIds,
    authorizationHash: principalAuthorizationHash(value.tenantId, value.principalId, roles, providerRoleIds) });
  verifiedPrincipals.add(principal);
  accountValidations.set(principal, validation);
  return principal;
}

export function principalAccountValidation(principal: RequestPrincipal) {
  assertVerifiedPrincipal(principal);
  return accountValidations.get(principal)!;
}

export function assertVerifiedPrincipal(principal: RequestPrincipal) {
  if (!verifiedPrincipals.has(principal)) throw AppError.unauthorized("A verified principal is required.");
}

export function refreshBrowserPrincipal(principal: RequestPrincipal, user: AuthenticatedUser) {
  assertVerifiedPrincipal(principal);
  if (principal.transport !== "browser" || user.tenantId !== principal.tenantId || user.homeAccountId !== principal.principalId) throw AppError.unauthorized();
  return freezePrincipal({ ...principal, username: user.username, displayName: user.displayName,
    roles: user.roles, providerRoleIds: user.providerRoleIds ?? [], rolesValidatedAt: Date.now() }, principalAccountValidation(principal));
}

export function assertFreshPrincipal(principal: RequestPrincipal) {
  assertVerifiedPrincipal(principal);
  const now = Date.now();
  if (!validTime(principal.rolesValidatedAt, now) || !validTime(principal.authenticatedAt, now)
    || !Number.isFinite(principal.expiresAt) || principal.expiresAt <= now) {
    throw new AppError(401, "authorization_expired", "The authorization expired.");
  }
  if (now - principal.rolesValidatedAt >= authorizationFreshnessMs) {
    throw new AppError(401, "authorization_stale", "Reauthorization is required to revalidate app roles.");
  }
}

function validTime(value: unknown, now: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= now;
}

export function mappingUnavailable() {
  return new AppError(401, "principal_mapping_unavailable", "Microsoft did not return supported same-user home-account evidence. Delegated integration admission is closed.");
}
