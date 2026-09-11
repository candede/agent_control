import {
  ConfidentialClientApplication,
  type AccountInfo,
  type AuthenticationResult,
  type INetworkModule,
  type NetworkRequestOptions,
  type NetworkResponse,
} from "@azure/msal-node";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { authConfigured, config, loginScopes } from "../config.js";
import { AppError } from "../errors.js";
import { authFlowLifetimeMs } from "./flows.js";
import { getCapabilityDefinition, isAppRole } from "../services/capabilityRegistry.js";
import { normalizeInventoryProviderRoleIds } from "../services/inventoryRoleScope.js";
import type { CapabilityId } from "../types/capability.js";
import type { AuthenticatedUser, AuthFlow } from "../types/session.js";

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
let client: MsalClient | undefined;

export const msalNetworkClient: INetworkModule = {
  sendGetRequestAsync: <T>(url: string, options?: NetworkRequestOptions, timeout?: number) =>
    sendMsalRequest<T>(url, "GET", options, Math.min(timeout ?? msalNetworkTimeoutMs, msalNetworkTimeoutMs)),
  sendPostRequestAsync: <T>(url: string, options?: NetworkRequestOptions) =>
    sendMsalRequest<T>(url, "POST", options, msalNetworkTimeoutMs),
};

export function replaceMsalClientForTest(value: MsalClient | undefined) {
  if (process.env.NODE_ENV !== "test") throw new Error("MSAL test injection is unavailable outside tests.");
  client = value;
}

export function requireAuthConfigured() {
  if (
    !authConfigured ||
    !config.tenantId ||
    !config.clientId ||
    !config.clientSecret
  ) {
    throw AppError.serviceUnavailable(
      "Set TENANT_ID, CLIENT_ID, and CLIENT_SECRET before signing in.",
    );
  }
}

export function getMsalClient() {
  requireAuthConfigured();

  client ??= new ConfidentialClientApplication({
    auth: {
      authority: `https://login.microsoftonline.com/${config.tenantId}`,
      clientId: config.clientId!,
      clientSecret: config.clientSecret!,
    },
    system: { networkClient: msalNetworkClient },
  }) as unknown as MsalClient;

  return client;
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

export function createAuthFlow(kind: "login" | "consent", options: { capabilityId?: CapabilityId; accountId?: string; returnTo?: string } = {}): AuthFlow {
  const scopes = kind === "login"
    ? [...loginScopes]
    : ["openid", "profile", "offline_access", ...capabilityScopes(options.capabilityId!)];
  return {
    kind,
    state: randomValue(),
    nonce: randomValue(),
    codeVerifier: randomValue(),
    scopes,
    createdAt: Date.now(),
    returnTo: safeReturnPath(options.returnTo),
    capabilityId: options.capabilityId,
    accountId: options.accountId,
  };
}

export async function createAuthorizationUrl(flow: AuthFlow) {
  const url = await getMsalClient().getAuthCodeUrl({
    scopes: flow.scopes,
    redirectUri: config.redirectUri,
    state: flow.state,
    nonce: flow.nonce,
    codeChallenge: createHash("sha256").update(flow.codeVerifier).digest("base64url"),
    codeChallengeMethod: "S256",
    prompt: flow.kind === "login" ? "select_account" : "consent",
  });
  return validateAuthorizationUrl(url);
}

export async function redeemAuthorizationCode(code: string, flow: AuthFlow) {
  if (Date.now() - flow.createdAt > authFlowLifetimeMs) throw new AppError(400, "expired_auth_state", "The authentication request expired. Start again.");
  const result = await getMsalClient().acquireTokenByCode({
    code,
    scopes: flow.scopes,
    redirectUri: config.redirectUri,
    codeVerifier: flow.codeVerifier,
  });

  validateAuthenticationPrincipal(result, flow.kind === "consent" ? flow.accountId : undefined);
  const claims = result.idTokenClaims as { nonce?: unknown; tid?: unknown } | undefined;
  if (claims?.nonce !== flow.nonce) throw AppError.unauthorized("Microsoft Entra ID returned an invalid nonce.");

  return result;
}

export async function acquireDelegatedToken(homeAccountId: string, capabilityId: CapabilityId) {
  const definition = getCapabilityDefinition(capabilityId);
  if (!definition || definition.mode !== "delegated") throw new AppError(400, "invalid_token_mode", "The capability does not support delegated tokens.");
  const account = await getAccount(homeAccountId);

  if (!account || account.tenantId !== config.tenantId) throw interactionRequired();

  try {
    const result = await getMsalClient().acquireTokenSilent({ account, scopes: capabilityScopes(capabilityId) });
    validateTokenResult(result, "delegated", definition.audience, definition.permissions, definition.acceptedPermissions, homeAccountId);
    return result.accessToken;
  } catch (error) {
    throw normalizeTokenError(error);
  }
}

export async function acquireApplicationToken(capabilityId: CapabilityId) {
  const definition = getCapabilityDefinition(capabilityId);
  if (!definition || definition.mode !== "application" || definition.provider !== "Microsoft Graph") {
    throw new AppError(400, "invalid_token_mode", "The capability does not support application tokens.");
  }
  try {
    const result = await getMsalClient().acquireTokenByClientCredential({ scopes: ["https://graph.microsoft.com/.default"] });
    validateTokenResult(result, "application", definition.audience, definition.permissions, definition.acceptedPermissions);
    return result!.accessToken;
  } catch (error) {
    throw normalizeTokenError(error);
  }
}

export async function revalidateAuthenticatedUser(homeAccountId: string) {
  const account = await getAccount(homeAccountId);
  if (!account || account.tenantId !== config.tenantId) throw interactionRequired();
  try {
    const result = await getMsalClient().acquireTokenSilent({ account, scopes: loginScopes, forceRefresh: true });
    validateAuthenticationPrincipal(result, homeAccountId);
    return toAuthenticatedUser(result);
  } catch (error) {
    throw normalizeTokenError(error);
  }
}

export async function evictAccount(homeAccountId: string) {
  const account = await getAccount(homeAccountId);
  if (account) await getMsalClient().getTokenCache().removeAccount(account);
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
    username: account.username ?? claims?.preferred_username ?? "",
    homeAccountId: account.homeAccountId,
    tenantId: account.tenantId ?? claims?.tid,
    roles: Array.isArray(claims?.roles) ? [...new Set(claims.roles.filter(isAppRole))].sort() : [],
    providerRoleIds: normalizeInventoryProviderRoleIds(claims?.wids),
  };
}

async function getAccount(homeAccountId: string): Promise<AccountInfo | null> {
  const cache = getMsalClient().getTokenCache();
  const account = await cache.getAccountByHomeId(homeAccountId);
  return account ?? null;
}

export function matchesAuthState(expected: string, actual: string) {
  const left = Buffer.from(expected);
  const right = Buffer.from(actual);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function safeReturnPath(value: string | undefined) {
  if (!value) return "/";
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\") || value.includes("\0")) {
    throw new AppError(400, "invalid_return_url", "Return URL must be a local application path.");
  }
  const parsed = new URL(value, config.frontendOrigin);
  if (parsed.origin !== config.frontendOrigin) throw new AppError(400, "invalid_return_url", "Return URL must be a local application path.");
  return `${parsed.pathname}${parsed.search}${parsed.hash}`;
}

function validateAuthorizationUrl(value: string) {
  const url = new URL(value);
  if (url.origin !== "https://login.microsoftonline.com" || url.username || url.password || !config.tenantId || url.pathname.split("/")[1]?.toLowerCase() !== config.tenantId.toLowerCase()) {
    throw new AppError(502, "invalid_authorization_url", "Microsoft authorization returned an unexpected redirect target.");
  }
  return url.toString();
}

function validateAuthenticationPrincipal(result: AuthenticationResult | null, expectedHomeAccountId?: string): asserts result is AuthenticationResult {
  if (!result?.account) throw AppError.unauthorized("Microsoft Entra ID did not return an account.");
  const claims = result.idTokenClaims as { tid?: unknown } | undefined;
  const tenantValues = [result.tenantId, result.account.tenantId, claims?.tid].filter(value => value !== undefined);
  if (!config.tenantId || tenantValues.length === 0 || tenantValues.some(value => value !== config.tenantId)) {
    throw AppError.unauthorized("The account belongs to a different tenant.");
  }
  if (expectedHomeAccountId && result.account.homeAccountId !== expectedHomeAccountId) {
    throw AppError.unauthorized("Microsoft Entra ID returned a different account.");
  }
}

function validateTokenResult(result: AuthenticationResult | null, mode: "delegated" | "application", audience: string, permissions: string[], accepted: string[] = [], homeAccountId?: string) {
  if (!result?.accessToken) throw interactionRequired();
  if (result.tenantId !== config.tenantId) throw AppError.unauthorized("Microsoft Entra ID returned a token for a different tenant.");
  if (!(result.expiresOn instanceof Date) || !Number.isFinite(result.expiresOn.getTime()) || result.expiresOn.getTime() <= Date.now()) {
    throw new AppError(401, "authorization_expired", "Microsoft authorization expired. Sign in or grant consent again.");
  }

  const claims = tryDecodeJwtPayload(result.accessToken);
  validateOptionalProviderClaims(claims, mode, audience);
  if (mode === "delegated") {
    if (!result.account || result.account.tenantId !== config.tenantId || result.account.homeAccountId !== homeAccountId) {
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
    const applicationId = claims.azp ?? claims.appid;
    if (applicationId !== undefined && applicationId !== config.clientId) {
      throw AppError.unauthorized("Microsoft Entra ID returned a token for a different application.");
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
  if (!hasRequired && !hasAccepted) throw new AppError(403, "missing_permission", "The token does not contain the capability's required permission.");
}

function validateOptionalProviderClaims(claims: Record<string, unknown> | undefined, mode: "delegated" | "application", audience: string) {
  if (!claims) return;
  if (claims.tid !== undefined && claims.tid !== config.tenantId) throw AppError.unauthorized("Microsoft Entra ID returned a token for a different tenant.");
  const audiences = audience === "https://graph.microsoft.com" ? graphAudienceIds : powerPlatformAudienceIds;
  if (claims.aud !== undefined && (typeof claims.aud !== "string" || !audiences.has(claims.aud))) {
    throw AppError.unauthorized("Microsoft Entra ID returned a token for a different resource.");
  }
  const now = Math.floor(Date.now() / 1000);
  if (typeof claims.exp === "number" && claims.exp <= now || typeof claims.nbf === "number" && claims.nbf > now) {
    throw new AppError(401, "authorization_expired", "Microsoft authorization expired. Sign in or grant consent again.");
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
    const text = await response.text();
    return { headers: Object.fromEntries(response.headers.entries()), body: (text ? JSON.parse(text) : {}) as T, status: response.status };
  } finally {
    clearTimeout(timer);
  }
}

function normalizeTokenError(error: unknown) {
  if (error instanceof AppError) return error;
  const code = String((error as { errorCode?: unknown })?.errorCode ?? "").toLowerCase();
  if (["interaction_required", "consent_required", "login_required", "no_tokens_found"].includes(code)) return interactionRequired();
  if (code === "invalid_grant") return new AppError(401, "authorization_expired", "Microsoft authorization expired. Sign in or grant consent again.");
  return new AppError(502, "identity_provider_error", "Microsoft Entra ID could not complete token acquisition.");
}

function interactionRequired() {
  return new AppError(401, "interaction_required", "Microsoft authorization is required for this capability.");
}
