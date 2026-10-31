import {
  AuthError,
  ConfidentialClientApplication,
  ServerError,
  type AccountInfo,
  type AuthenticationResult,
  type INetworkModule,
  type NetworkRequestOptions,
  type NetworkResponse,
} from "@azure/msal-node";
import { createHash, randomBytes } from "node:crypto";
import { types } from "node:util";
import { authConfigured, config, getTenantConfiguration, loginScopes, normalizeSignInUsername, type TenantConfiguration } from "../config.js";
import { AppError, isApplicationError } from "../errors.js";
import { adminManagedPermissionsError, adminManagedPermissionsMessage, assertLoginAuthFlow, assertTenantConfiguration, authenticationScopes, authFlowLifetimeMs, tenantConfigurationFingerprint } from "./flows.js";
import { getCapabilityDefinition, isAppRole } from "../services/capabilityRegistry.js";
import { normalizeInventoryProviderRoleIds } from "../services/inventoryRoleScope.js";
import { isApplicationCollectionCapability, type CapabilityId } from "../types/capability.js";
import type { AuthenticatedUser, AuthFlow } from "../types/session.js";
import { authorityUser, currentAuthority, requireAuthority } from "./authorityContext.js";
import { boundedAuthBody, identityThrottled } from "./boundedAuth.js";

type TokenCache = {
  getAccountByHomeId(homeAccountId: string): Promise<AccountInfo | null>;
  removeAccount(account: AccountInfo): Promise<void>;
};

export type MsalClient = {
  getAuthCodeUrl(request: Record<string, unknown>): Promise<string>;
  acquireTokenByCode(request: Record<string, unknown>): Promise<AuthenticationResult | null>;
  acquireTokenSilent(request: Record<string, unknown>): Promise<AuthenticationResult>;
  acquireTokenByClientCredential(request: Record<string, unknown>): Promise<AuthenticationResult | null>;
  getTokenCache(): TokenCache;
};

export const msalNetworkTimeoutMs = 10_000;
const graphAudienceIds = new Set(["https://graph.microsoft.com", "00000003-0000-0000-c000-000000000000"]);
const powerPlatformAudienceIds = new Set(["https://api.powerplatform.com", "8578e004-a5c6-46e7-913e-12f58912df43"]);
const clients = new Map<string, { client: MsalClient; fingerprint: string }>();

export const msalNetworkClient: INetworkModule = {
  sendGetRequestAsync: <T>(url: string, options?: NetworkRequestOptions, timeout?: number) =>
    sendMsalRequest<T>(url, "GET", options, Math.min(timeout ?? msalNetworkTimeoutMs, msalNetworkTimeoutMs)),
  sendPostRequestAsync: <T>(url: string, options?: NetworkRequestOptions) =>
    sendMsalRequest<T>(url, "POST", options, msalNetworkTimeoutMs),
};

export function replaceMsalClientForTest(tenantId: string, value: MsalClient | undefined) {
  if (process.env.NODE_ENV !== "test") throw new Error("MSAL test injection is unavailable outside tests.");
  for (const key of clients.keys()) if (key.startsWith(`${tenantId}\0`)) clients.delete(key);
  if (value) {
    const tenant = getTenantConfiguration(tenantId);
    clients.set(clientKey(tenant), { client: value, fingerprint: tenantConfigurationFingerprint(tenant) });
  }
}

function requireAuthConfigured() {
  if (!authConfigured || config.tenants.length === 0) {
    throw AppError.serviceUnavailable(
      "Configure an Entra tenant, application credentials, and organizational email domains before signing in.",
    );
  }
}

export function getMsalClient(tenantId: string) {
  requireAuthConfigured();
  const tenant = getTenantConfiguration(tenantId);
  const activeConfigurations = new Map(config.tenants.map(value => [clientKey(value), tenantConfigurationFingerprint(value)]));
  for (const [key, value] of clients) {
    if (activeConfigurations.get(key) !== value.fingerprint) clients.delete(key);
  }
  const key = clientKey(tenant);
  const existing = clients.get(key);
  if (existing) return existing.client;
  const client = new ConfidentialClientApplication({
    auth: {
      authority: tenantAuthority(tenant.tenantId),
      clientId: tenant.clientId,
      clientSecret: tenant.clientSecret,
    },
    system: { networkClient: msalNetworkClient },
  }) as unknown as MsalClient;
  clients.set(key, { client, fingerprint: tenantConfigurationFingerprint(tenant) });
  return client;
}

function clientKey(tenant: TenantConfiguration) {
  return `${tenant.tenantId}\0${tenant.clientId}`;
}

function tenantAuthority(tenantId: string) {
  return `https://login.microsoftonline.com/${tenantId}`;
}

function randomValue() {
  return randomBytes(32).toString("base64url");
}

export function capabilityScopes(capabilityId: CapabilityId) {
  const definition = getCapabilityDefinition(capabilityId);
  if (!definition || definition.mode === "local") throw new AppError(400, "invalid_capability", "This capability does not use Microsoft authorization.");
  const resource = definition.provider === "Power Platform" ? "https://api.powerplatform.com" : "https://graph.microsoft.com";
  return definition.permissions.map(permission => `${resource}/${permission}`);
}

export function createAuthFlow(kind: "login", options: { tenantId: string; username: string; returnTo?: string }): AuthFlow {
  if (kind !== "login" || Object.keys(options ?? {}).some(key => !["tenantId", "username", "returnTo"].includes(key))) throw adminManagedPermissionsError();
  // Reauthentication can use a canonical UPN outside the tenant's initial-login routing domains.
  const tenant = getTenantConfiguration(options?.tenantId);
  return {
    kind,
    tenantId: tenant.tenantId,
    clientId: tenant.clientId,
    username: normalizedPrincipalUsername(options.username),
    configurationFingerprint: tenantConfigurationFingerprint(tenant),
    state: randomValue(),
    nonce: randomValue(),
    codeVerifier: randomValue(),
    scopes: [...authenticationScopes],
    createdAt: Date.now(),
    returnTo: safeReturnPath(options.returnTo),
  };
}

export async function createAuthorizationUrl(flow: AuthFlow) {
  assertLiveAuthFlow(flow);
  const url = await getMsalClient(flow.tenantId).getAuthCodeUrl({
    authority: tenantAuthority(flow.tenantId),
    loginHint: flow.username,
    scopes: [...authenticationScopes],
    redirectUri: config.redirectUri,
    state: flow.state,
    nonce: flow.nonce,
    codeChallenge: createHash("sha256").update(flow.codeVerifier).digest("base64url"),
    codeChallengeMethod: "S256",
    // MSAL suppresses login_hint for select_account.
    prompt: "login",
  });
  assertLiveAuthFlow(flow);
  return validateAuthorizationUrl(url, flow.tenantId);
}

export async function redeemAuthorizationCode(code: string, flow: AuthFlow) {
  assertLiveAuthFlow(flow);
  const result = await getMsalClient(flow.tenantId).acquireTokenByCode({
    authority: tenantAuthority(flow.tenantId),
    code,
    scopes: [...authenticationScopes],
    redirectUri: config.redirectUri,
    codeVerifier: flow.codeVerifier,
  });

  assertLiveAuthFlow(flow);
  validateAuthenticationPrincipal(getTenantConfiguration(flow.tenantId), result);
  const claims = result.idTokenClaims as { nonce?: unknown; tid?: unknown } | undefined;
  if (claims?.nonce !== flow.nonce) throw AppError.unauthorized("Microsoft Entra ID returned an invalid nonce.");

  return result;
}

function assertLiveAuthFlow(flow: AuthFlow) {
  assertLoginAuthFlow(flow);
  const now = Date.now();
  if (flow.createdAt > now || now - flow.createdAt >= authFlowLifetimeMs) throw new AppError(400, "expired_auth_state", "The authentication request expired. Start again.");
}

export async function acquireDelegatedToken(tenantId: string, homeAccountId: string, capabilityId: CapabilityId) {
  const source = currentAuthority();
  if (source) return requireAuthority(tenantId, homeAccountId).acquire(capabilityId);
  return (await acquireDelegatedTokenResult(tenantId, homeAccountId, capabilityId)).accessToken;
}

export async function acquireAuthorizedToken(tenantId: string, homeAccountId: string, capabilityId: CapabilityId) {
  return requireAuthority(tenantId, homeAccountId).acquire(capabilityId);
}

export async function revalidateAuthorizedUser(tenantId: string, homeAccountId: string) {
  const source = requireAuthority(tenantId, homeAccountId);
  await source.revalidate();
  return authorityUser(source);
}

export async function acquireDelegatedTokenResult(tenantId: string, homeAccountId: string, capabilityId: CapabilityId) {
  const definition = getCapabilityDefinition(capabilityId);
  if (!definition || definition.mode !== "delegated") throw new AppError(400, "invalid_token_mode", "The capability does not support delegated tokens.");
  const tenant = getTenantConfiguration(tenantId);
  const fingerprint = tenantConfigurationFingerprint(tenant);
  const client = getMsalClient(tenantId);
  const account = await getAccount(client, homeAccountId);
  assertTenantConfiguration(tenantId, fingerprint);
  if (!account || account.tenantId !== tenantId || account.homeAccountId !== homeAccountId) throw interactionRequired();

  try {
    validateOptionalIdentityClaims(tenant, account.idTokenClaims);
    const result = await client.acquireTokenSilent({ authority: tenantAuthority(tenantId), account, scopes: capabilityScopes(capabilityId) });
    assertTenantConfiguration(tenantId, fingerprint);
    validateTokenResult(tenant, result, "delegated", definition.audience, definition.permissions, definition.acceptedPermissions, homeAccountId);
    return result;
  } catch (error) {
    throw normalizeTokenError(error);
  }
}

export async function acquireApplicationToken(tenantId: string, capabilityId: CapabilityId) {
  const source = currentAuthority();
  if (source) requireAuthority(tenantId);
  if (source?.principal.transport === "bearer" && !isApplicationCollectionCapability(capabilityId)) {
    throw new AppError(403, "invalid_token_mode", "Integration investigations require delegated authorization.");
  }
  const definition = getCapabilityDefinition(capabilityId);
  if (!definition || definition.mode !== "application" || definition.provider !== "Microsoft Graph") {
    throw new AppError(400, "invalid_token_mode", "The capability does not support application tokens.");
  }
  const tenant = getTenantConfiguration(tenantId);
  const fingerprint = tenantConfigurationFingerprint(tenant);
  const client = getMsalClient(tenantId);
  try {
    const result = await client.acquireTokenByClientCredential({ authority: tenantAuthority(tenantId), scopes: ["https://graph.microsoft.com/.default"] });
    assertTenantConfiguration(tenantId, fingerprint);
    validateTokenResult(tenant, result, "application", definition.audience, definition.permissions, definition.acceptedPermissions);
    return result!.accessToken;
  } catch (error) {
    const normalized = normalizeTokenError(error);
    if (normalized.status === 401) {
      throw new AppError(502, "application_authorization_failed",
        "The configured tenant application could not be authorized. An administrator must verify its registration, credentials and consent, then retry.",
        normalized.details);
    }
    throw normalized;
  }
}

export async function revalidateAuthenticatedUser(tenantId: string, homeAccountId: string) {
  const source = currentAuthority();
  if (source) {
    await requireAuthority(tenantId, homeAccountId).revalidate();
    return authorityUser(source);
  }
  return toAuthenticatedUser(await revalidateAuthenticatedUserResult(tenantId, homeAccountId));
}

export async function revalidateAuthenticatedUserResult(tenantId: string, homeAccountId: string) {
  const tenant = getTenantConfiguration(tenantId);
  const fingerprint = tenantConfigurationFingerprint(tenant);
  const client = getMsalClient(tenantId);
  const account = await getAccount(client, homeAccountId);
  assertTenantConfiguration(tenantId, fingerprint);
  if (!account || account.tenantId !== tenantId || account.homeAccountId !== homeAccountId) throw interactionRequired();
  try {
    validateOptionalIdentityClaims(tenant, account.idTokenClaims);
    const result = await client.acquireTokenSilent({ authority: tenantAuthority(tenantId), account, scopes: loginScopes, forceRefresh: true });
    assertTenantConfiguration(tenantId, fingerprint);
    validateAuthenticationPrincipal(tenant, result, homeAccountId);
    return result;
  } catch (error) {
    throw normalizeTokenError(error);
  }
}

export async function evictAccount(tenantId: string, homeAccountId: string) {
  const client = getMsalClient(tenantId);
  const account = await getAccount(client, homeAccountId);
  if (account?.tenantId === tenantId && account.homeAccountId === homeAccountId) await client.getTokenCache().removeAccount(account);
}

export function toAuthenticatedUser(
  result: AuthenticationResult,
): AuthenticatedUser {
  const account = result.account;

  if (!account) {
    throw AppError.unauthorized(
      "Microsoft Entra ID did not return an account.",
    );
  }

  const claims = result.idTokenClaims as
    | { name?: string; preferred_username?: string; tid?: string; roles?: unknown; wids?: unknown }
    | undefined;

  return {
    displayName: account.name ?? claims?.name ?? account.username,
    username: normalizedPrincipalUsername(claims?.preferred_username ?? account.username),
    homeAccountId: account.homeAccountId,
    tenantId: account.tenantId ?? claims?.tid,
    roles: Array.isArray(claims?.roles) ? [...new Set(claims.roles.filter(isAppRole))].sort() : [],
    providerRoleIds: normalizeInventoryProviderRoleIds(claims?.wids),
  };
}

async function getAccount(client: MsalClient, homeAccountId: string): Promise<AccountInfo | null> {
  const cache = client.getTokenCache();
  const account = await cache.getAccountByHomeId(homeAccountId);
  return account ?? null;
}

export function safeReturnPath(value: unknown) {
  if (value === undefined || value === "") return "/";
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//") || /[\\\u0000-\u001f\u007f]/.test(value)) {
    throw new AppError(400, "invalid_return_url", "Return URL must be a local application path.");
  }
  const parsed = new URL(value, config.frontendOrigin);
  if (parsed.origin !== config.frontendOrigin || parsed.pathname.startsWith("//")) throw new AppError(400, "invalid_return_url", "Return URL must be a local application path.");
  return `${parsed.pathname}${parsed.search}${parsed.hash}`;
}

function validateAuthorizationUrl(value: string, tenantId: string) {
  const url = new URL(value);
  if (url.origin !== "https://login.microsoftonline.com" || url.username || url.password || url.pathname.split("/")[1]?.toLowerCase() !== tenantId.toLowerCase()) {
    throw new AppError(502, "invalid_authorization_url", "Microsoft authorization returned an unexpected redirect target.");
  }
  return url.toString();
}

function validateAuthenticationPrincipal(tenant: TenantConfiguration, result: AuthenticationResult | null, expectedHomeAccountId?: string): asserts result is AuthenticationResult {
  if (!result?.account) throw AppError.unauthorized("Microsoft Entra ID did not return an account.");
  const claims = result.idTokenClaims as Record<string, unknown> | undefined;
  if ([result.tenantId, result.account.tenantId, claims?.tid].some(value => value !== tenant.tenantId)) {
    throw AppError.unauthorized("The account belongs to a different tenant.");
  }
  if (!result.account.homeAccountId || expectedHomeAccountId && result.account.homeAccountId !== expectedHomeAccountId) {
    throw AppError.unauthorized("Microsoft Entra ID returned a different account.");
  }
  if (claims?.aud !== tenant.clientId) throw AppError.unauthorized("Microsoft Entra ID returned an identity for a different application.");
  validateClientClaims(tenant, claims);
  validateOptionalIdentityClaims(tenant, result.account.idTokenClaims);
  normalizedPrincipalUsername(claims?.preferred_username ?? result.account.username);
  if (claims?.oid !== undefined && claims.oid !== result.account.localAccountId
    || result.uniqueId && result.uniqueId !== result.account.localAccountId) {
    throw AppError.unauthorized("Microsoft Entra ID returned a different account.");
  }
}

function normalizedPrincipalUsername(value: unknown) {
  try { return normalizeSignInUsername(value); }
  catch (error) {
    if (error instanceof AppError && error.code === "invalid_username") {
      throw AppError.unauthorized("Microsoft Entra ID did not return a valid account username.");
    }
    throw error;
  }
}

function validateOptionalIdentityClaims(tenant: TenantConfiguration, claims: Record<string, unknown> | undefined) {
  if (claims?.tid !== undefined && claims.tid !== tenant.tenantId) throw AppError.unauthorized("Microsoft Entra ID returned an identity for a different tenant.");
  if (claims?.aud !== undefined && claims.aud !== tenant.clientId) throw AppError.unauthorized("Microsoft Entra ID returned an identity for a different application.");
  validateClientClaims(tenant, claims);
}

export function validateTokenResult(tenant: TenantConfiguration, result: AuthenticationResult | null, mode: "delegated" | "application", audience: string, permissions: string[], accepted: string[] = [], homeAccountId?: string) {
  if (!result?.accessToken) {
    if (mode === "application") throw new AppError(502, "identity_provider_error",
      "Microsoft Entra ID did not return an application token. An administrator must verify the existing app registration and its credentials.");
    throw interactionRequired();
  }
  if (result.tenantId !== tenant.tenantId && (mode !== "application" || result.tenantId !== "")) {
    throw AppError.unauthorized("Microsoft Entra ID returned a token for a different tenant.");
  }
  if (mode === "application" && (result.tenantId === "" || result.authority !== undefined)) {
    if (typeof result.authority !== "string" || !URL.canParse(result.authority)) {
      throw new AppError(502, "identity_provider_error", "Microsoft Entra ID returned invalid application authority metadata.");
    }
    const authority = new URL(result.authority);
    if (authority.origin !== "https://login.microsoftonline.com" || authority.username || authority.password
      || authority.search || authority.hash || authority.pathname.replace(/\/$/, "").toLowerCase() !== `/${tenant.tenantId.toLowerCase()}`) {
      throw AppError.unauthorized("Microsoft Entra ID returned an application token from a different tenant authority.");
    }
  }
  const identityClaims = result.idTokenClaims as Record<string, unknown> | undefined;
  validateOptionalIdentityClaims(tenant, identityClaims);
  validateOptionalIdentityClaims(tenant, result.account?.idTokenClaims);
  if (!(result.expiresOn instanceof Date) || !Number.isFinite(result.expiresOn.getTime())) {
    throw new AppError(502, "identity_provider_error", "Microsoft Entra ID returned invalid token expiry metadata.");
  }
  if (result.expiresOn.getTime() <= Date.now()) {
    throw new AppError(401, "authorization_expired", "Microsoft authorization expired. Sign in again.");
  }

  const claims = tryDecodeJwtPayload(result.accessToken);
  validateOptionalProviderClaims(tenant, claims, mode, audience);
  if (mode === "delegated") {
    if (!result.account || result.account.tenantId !== tenant.tenantId || result.account.homeAccountId !== homeAccountId
      || claims?.oid !== undefined && claims.oid !== result.account.localAccountId
      || identityClaims?.oid !== undefined && identityClaims.oid !== result.account.localAccountId) {
      throw AppError.unauthorized("Microsoft Entra ID returned a token for a different account.");
    }
    const granted = responsePermissions(result.scopes, audience);
    requirePermission(granted, permissions, accepted);
    if (claims?.idtyp === "app" || typeof claims?.scp !== "string" && Array.isArray(claims?.roles)) {
      throw new AppError(401, "invalid_token_mode", "Microsoft Entra ID returned an application token for a delegated request.");
    }
    return;
  }

  if (result.account) throw new AppError(401, "invalid_token_mode", "Microsoft Entra ID returned a delegated token for an application request.");
  validateApplicationScopeMetadata(result.scopes, audience);
  if (claims) {
    if (typeof claims.scp === "string" || claims.idtyp !== undefined && claims.idtyp !== "app") {
      throw new AppError(401, "invalid_token_mode", "Microsoft Entra ID returned a delegated token for an application request.");
    }
    const granted = new Set(Array.isArray(claims.roles) ? claims.roles.filter((role): role is string => typeof role === "string").map(role => role.toLowerCase()) : []);
    requirePermission(granted, permissions, accepted);
  }
}

function responsePermissions(scopes: string[], audience: string) {
  const granted = new Set<string>();
  const scopeResource = audience === "8578e004-a5c6-46e7-913e-12f58912df43" ? "https://api.powerplatform.com" : audience;
  for (const scope of scopes) {
    if (scope.includes("/")) {
      const separator = scope.lastIndexOf("/");
      if (scope.slice(0, separator).toLowerCase() !== scopeResource.toLowerCase()) {
        throw AppError.unauthorized("Microsoft Entra ID returned a token for a different resource.");
      }
      granted.add(scope.slice(separator + 1).toLowerCase());
    } else {
      granted.add(scope.toLowerCase());
    }
  }
  return granted;
}

function validateApplicationScopeMetadata(scopes: string[], audience: string) {
  for (const scope of scopes) {
    if (scope.toLowerCase() !== `${audience}/.default`.toLowerCase()) {
      throw AppError.unauthorized("Microsoft Entra ID returned a token for a different resource.");
    }
  }
}

function requirePermission(granted: Set<string>, permissions: string[], accepted: string[]) {
  const hasRequired = permissions.every(permission => granted.has(permission.toLowerCase()));
  const hasAccepted = accepted.some(permission => granted.has(permission.toLowerCase()));
  if (!hasRequired && !hasAccepted) throw new AppError(403, "missing_permission",
    `The token does not contain the required permission: ${permissions.join(", ")}. ${adminManagedPermissionsMessage}`);
}

function validateClientClaims(tenant: TenantConfiguration, claims: Record<string, unknown> | undefined) {
  if ([claims?.azp, claims?.appid].some(value => value !== undefined && value !== tenant.clientId)) {
    throw AppError.unauthorized("Microsoft Entra ID returned a token for a different application.");
  }
}

function validateOptionalProviderClaims(tenant: TenantConfiguration, claims: Record<string, unknown> | undefined, mode: "delegated" | "application", audience: string) {
  if (!claims) return;
  if (claims.tid !== undefined && claims.tid !== tenant.tenantId) throw AppError.unauthorized("Microsoft Entra ID returned a token for a different tenant.");
  validateClientClaims(tenant, claims);
  const audiences = audience === "https://graph.microsoft.com" ? graphAudienceIds : powerPlatformAudienceIds;
  if (claims.aud !== undefined && (typeof claims.aud !== "string" || !audiences.has(claims.aud))) {
    throw AppError.unauthorized("Microsoft Entra ID returned a token for a different resource.");
  }
  const now = Math.floor(Date.now() / 1000);
  if (typeof claims.exp === "number" && claims.exp <= now) {
    throw new AppError(401, "authorization_expired", "Microsoft authorization expired. Sign in again.");
  }
  if (typeof claims.nbf === "number" && claims.nbf > now) {
    throw new AppError(502, "authorization_not_yet_valid", "The Microsoft token is not yet valid. Check the application host clock before retrying.");
  }
  if (mode === "application" && claims.idtyp === "user") {
    throw new AppError(401, "invalid_token_mode", "Microsoft Entra ID returned a delegated token for an application request.");
  }
}

function tryDecodeJwtPayload(token: string): Record<string, unknown> | undefined {
  const parts = token.split(".");
  if (parts.length !== 3 || token.length > 64_000) return undefined;
  try {
    const value: unknown = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid");
    return value as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

async function sendMsalRequest<T>(url: string, method: "GET" | "POST", options: NetworkRequestOptions | undefined, timeout: number): Promise<NetworkResponse<T>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("Microsoft Entra ID request timed out.")), timeout);
  try {
    const response = await fetch(url, { method, headers: options?.headers, body: method === "POST" ? options?.body : undefined, redirect: "manual", signal: controller.signal });
    if (response.status === 429) {
      const { retryAfterSeconds } = identityThrottled(response.headers.get("retry-after"));
      await response.body?.cancel().catch(() => undefined);
      // MSAL replaces non-AuthError transport failures with a generic network error.
      throw Object.assign(new ServerError("temporarily_unavailable", "", "Microsoft Entra ID throttled token acquisition.", undefined, undefined, 429), { retryAfterSeconds });
    }
    let text: string;
    try { text = await boundedAuthBody(response, 128 * 1024, controller.signal); }
    catch (error) {
      if (isApplicationError(error) && error.code === "invalid_identity_response") {
        throw new AuthError("token_parsing_error", "", "Microsoft Entra ID returned an oversized response.");
      }
      throw error;
    }
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : {};
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Invalid identity response.");
    } catch {
      if (response.status >= 500) {
        throw new ServerError("server_error", "", "Microsoft Entra ID returned a non-JSON error response.", undefined, undefined, response.status);
      }
      throw new AuthError("token_parsing_error", "", "Microsoft Entra ID returned malformed JSON.");
    }
    return { headers: Object.fromEntries(response.headers.entries()), body: body as T, status: response.status };
  } finally {
    clearTimeout(timer);
  }
}

function ownErrorField(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object" || types.isProxy(value)) return undefined;
  const property = Object.getOwnPropertyDescriptor(value, key);
  return property && Object.hasOwn(property, "value") ? property.value : undefined;
}

export function isRetryableIdentityProviderError(error: unknown): boolean {
  if (!isApplicationError(error)) return false;
  const code = ownErrorField(error, "code");
  const status = ownErrorField(error, "status");
  const details = ownErrorField(error, "details");
  return code === "identity_provider_error" && typeof status === "number" && Number.isFinite(status) && status >= 500
    && ownErrorField(details, "retryable") === true;
}

export function normalizeTokenError(error: unknown) {
  if (isApplicationError(error)) return error;
  const errorCode = ownErrorField(error, "errorCode");
  const errorSubCode = ownErrorField(error, "subError");
  const errorNumber = ownErrorField(error, "errorNo");
  const errorMessage = ownErrorField(error, "errorMessage");
  const errorCorrelationId = ownErrorField(error, "correlationId");
  const errorStatus = ownErrorField(error, "status");
  const retryAfterSeconds = ownErrorField(error, "retryAfterSeconds");
  const code = typeof errorCode === "string" ? errorCode.toLowerCase() : "";
  const subError = typeof errorSubCode === "string" ? errorSubCode.toLowerCase() : "";
  const errorNo = typeof errorNumber === "string" ? errorNumber
    : typeof errorMessage === "string" ? errorMessage.match(/\bAADSTS(\d{5,9})\b/)?.[1] : undefined;
  const correlationId = typeof errorCorrelationId === "string"
    && /^[a-zA-Z0-9-]{1,128}$/.test(errorCorrelationId) ? errorCorrelationId : undefined;
  const httpStatus = typeof errorStatus === "number" && Number.isInteger(errorStatus)
    && errorStatus >= 400 && errorStatus <= 599 ? errorStatus : undefined;
  const details = {
    ...(correlationId ? { correlationId } : {}),
    ...(httpStatus === undefined ? {} : { httpStatus }),
    ...(errorNo && /^\d{5,9}$/.test(errorNo) ? { providerErrorCode: `AADSTS${errorNo}` } : {}),
    ...(["request_timeout", "network_error", "no_network_connectivity", "temporarily_unavailable", "server_error"].includes(code)
      ? { retryable: true } : {}),
  };
  if (code === "consent_required" || subError === "consent_required" || ["65001", "65004", "90094"].includes(errorNo ?? "")) {
    return new AppError(403, "missing_permission", adminManagedPermissionsMessage, details);
  }
  if (["700082", "700084", "70043", "50173"].includes(errorNo ?? "")) {
    return new AppError(401, "authorization_expired", "Microsoft authorization expired or was revoked. Sign in again.", details);
  }
  if (["interaction_required", "login_required", "no_tokens_found", "invalid_grant"].includes(code)
    || ["interaction_required", "login_required", "basic_action", "additional_action"].includes(subError)
    || ["50076", "50079", "50158", "53000", "53001", "53003"].includes(errorNo ?? "")) {
    return new AppError(401, "interaction_required", "Sign in again to complete MFA or account verification. Contact your administrator if Conditional Access blocks sign-in; this is not a request for API permissions.", details);
  }
  if (httpStatus === 429) {
    const throttled = identityThrottled(null);
    throttled.details = details;
    if (typeof retryAfterSeconds === "number" && Number.isSafeInteger(retryAfterSeconds) && retryAfterSeconds > 0) {
      throttled.retryAfterSeconds = retryAfterSeconds;
    }
    return throttled;
  }
  return new AppError(502, "identity_provider_error", "Microsoft Entra ID could not complete token acquisition.", details);
}

function interactionRequired() {
  return new AppError(401, "interaction_required", "Sign in again to renew the account session or complete MFA. API permission grants remain administrator-managed.");
}
