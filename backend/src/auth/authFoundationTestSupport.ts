import { createHmac, generateKeyPairSync } from "node:crypto";
import jwt from "jsonwebtoken";
import session, { type SessionData } from "express-session";
import type { AccountInfo, AuthenticationResult } from "@azure/msal-node";
import { vi } from "vitest";
import type { TenantConfiguration } from "../config.js";
import { McpBearerVerifier } from "./mcpBearer.js";

export const tenant: TenantConfiguration = {
  tenantId: "11111111-1111-1111-1111-111111111111", clientId: "22222222-2222-2222-2222-222222222222",
  clientSecret: "synthetic-foundation-secret", domains: ["example.invalid"], displayName: "Synthetic",
  integration: { clientId: "33333333-3333-3333-3333-333333333333", audience: "22222222-2222-2222-2222-222222222222", scope: "AgentControl.Access" },
};
export const native = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
export const guest = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
export const guestHome = "cccccccc-cccc-cccc-cccc-cccccccccccc";
export const guestTenant = "dddddddd-dddd-dddd-dddd-dddddddddddd";
export const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
export const jwk = { ...keys.publicKey.export({ format: "jwk" }), use: "sig", alg: "RS256", kid: "fixture-key" };

export function apiClaims(changes: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  const result: Record<string, unknown> = { aud: tenant.clientId, iss: `https://login.microsoftonline.com/${tenant.tenantId}/v2.0`,
    tid: tenant.tenantId, oid: native, sub: "api-specific-subject", azp: tenant.integration!.clientId,
    ver: "2.0", idtyp: "user", scp: "AgentControl.Access", roles: ["AgentControl.Viewer"],
    iat: now, nbf: now, exp: now + 3600, ...changes };
  for (const key of Object.keys(result)) if (result[key] === undefined) delete result[key];
  return result;
}

export function apiToken(changes: Record<string, unknown> = {}, kid = "fixture-key") {
  return jwt.sign(apiClaims(changes), keys.privateKey, { algorithm: "RS256", keyid: kid,
    ...(Object.hasOwn(changes, "iat") && changes.iat === undefined ? { noTimestamp: true } : {}) });
}

export function signingFetcher() {
  return vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ keys: [jwk] }), { status: 200 }));
}

export async function verifiedBearer(changes: Record<string, unknown> = {}) {
  return new McpBearerVerifier(signingFetcher()).verify(apiToken(changes));
}

export function sdkResponse(options: {
  oid?: string; uid?: string; utid?: string; clientInfo?: boolean; idToken?: boolean;
  claims?: Record<string, unknown>; expiresIn?: number; scope?: string; accessToken?: string;
} = {}, request?: RequestInit) {
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    aud: tenant.clientId, tid: tenant.tenantId, oid: options.oid ?? native, sub: "app-specific-id-sub",
    iss: `https://login.microsoftonline.com/${tenant.tenantId}/v2.0`,
    preferred_username: "alex@example.invalid", name: "Synthetic Alex", iat: now, exp: now + 3600,
    ...options.claims,
  };
  const scope = options.scope ?? new URLSearchParams(String(request?.body ?? "")).get("scope") ?? "User.ReadBasic.All openid profile";
  return new Response(JSON.stringify({
    token_type: "Bearer", access_token: options.accessToken ?? "synthetic-opaque-provider-access",
    scope, expires_in: options.expiresIn ?? 3600,
    ...(options.idToken === false ? {} : { id_token: jwt.sign(claims, keys.privateKey, { algorithm: "RS256" }) }),
    ...(options.clientInfo === false ? {} : { client_info: Buffer.from(JSON.stringify({
      uid: options.uid ?? options.oid ?? native, utid: options.utid ?? tenant.tenantId,
    })).toString("base64url") }),
  }), { status: 200 });
}

export function oboFetcher(options: Parameters<typeof sdkResponse>[0] = {}) {
  return vi.fn<typeof fetch>(async (_url, request) => sdkResponse(options, request));
}

export function account(oid = native, uid = oid, utid = tenant.tenantId): AccountInfo {
  return { localAccountId: oid, homeAccountId: `${uid}.${utid}`, tenantId: tenant.tenantId,
    environment: "login.windows.net", username: "alex@example.invalid", name: "Synthetic Alex" };
}

export function browserSession(selectedAccount = account()): SessionData {
  return {
    tenantId: tenant.tenantId, clientId: tenant.clientId, accountId: selectedAccount.homeAccountId,
    cookie: new session.Cookie({ maxAge: 8 * 60 * 60_000 }), signedInAt: Date.now(), rolesValidatedAt: Date.now(),
    user: { tenantId: tenant.tenantId, homeAccountId: selectedAccount.homeAccountId,
      username: selectedAccount.username, displayName: selectedAccount.name!, roles: ["AgentControl.Viewer"], providerRoleIds: [] },
  };
}

export async function browserFixtureCookie(store: Pick<session.Store, "set">, secret: string, data: SessionData,
  id = "synthetic-auth-integration") {
  await new Promise<void>((resolve, reject) => store.set(id, data, error => error ? reject(error) : resolve()));
  const signature = createHmac("sha256", secret).update(id).digest("base64").replace(/=+$/, "");
  return `agent-control.sid=${encodeURIComponent(`s:${id}.${signature}`)}`;
}

export function epochAuthority() {
  return {
    sessionEpoch: vi.fn(async (_tenant: string, _principal: string) => "1"),
    bearerAuthority: vi.fn(async (_tenant: string, _principal: string) => ({ epoch: "1", issuedAfter: "0" })),
  };
}

export function browserAuthenticationResult(): AuthenticationResult {
  return {
    authority: `https://login.microsoftonline.com/${tenant.tenantId}`, uniqueId: native, tenantId: tenant.tenantId,
    scopes: ["openid", "profile"], account: account(), idToken: "synthetic-identity-token",
    idTokenClaims: { aud: tenant.clientId, tid: tenant.tenantId, oid: native, preferred_username: "alex@example.invalid",
      roles: ["AgentControl.Admin"] }, accessToken: "synthetic-revalidation-access",
    fromCache: false, expiresOn: new Date(Date.now() + 3600_000), tokenType: "Bearer", correlationId: "",
  };
}
