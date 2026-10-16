import { createPublicKey, type KeyObject, type JsonWebKey } from "node:crypto";
import jwt from "jsonwebtoken";
import { config, getTenantConfiguration } from "../config.js";
import { AppError, isApplicationError } from "../errors.js";
import { isAppRole } from "../services/capabilityRegistry.js";
import { normalizeInventoryProviderRoleIds } from "../services/inventoryRoleScope.js";
import type { AppRole } from "../types/capability.js";
import { assertTenantConfiguration, tenantConfigurationFingerprint } from "./flows.js";
import { assertAuthSignal, boundedAuthBody, identityThrottled, SharedAuthOperation } from "./boundedAuth.js";

export const authorizationFreshnessMs = 5 * 60_000;
export const jwksCacheLifetimeMs = 5 * 60_000;
export const jwksRefreshCooldownMs = 30_000;
const guid = /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const assertions = new WeakMap<VerifiedBearer, { assertion: string; fingerprint: string }>();

export type VerifiedBearer = Readonly<{
  tenantId: string; apiClientId: string; integrationClientId: string; localAccountId: string;
  roles: readonly AppRole[]; providerRoleIds: readonly string[];
  issuedAt: number; expiresAt: number;
}>;

export function bearerAssertion(value: VerifiedBearer) {
  const stored = assertions.get(value);
  if (!stored) throw invalidBearer();
  assertTenantConfiguration(value.tenantId, stored.fingerprint);
  const now = Date.now();
  if (value.expiresAt <= now) throw new AppError(401, "authorization_expired", "The API authorization expired.");
  if (now - value.issuedAt >= authorizationFreshnessMs) throw new AppError(401, "authorization_stale", "Obtain a newly issued API access token to revalidate app roles.");
  return stored.assertion;
}

function invalidBearer() {
  return new AppError(401, "invalid_bearer", "The delegated API access token is invalid.");
}

type KeyCache = { keys: Map<string, KeyObject>; expiresAt: number; refreshAfter: number; pending?: SharedAuthOperation<void> };

// Dormant: no instance is created or registered by the application.
export class McpBearerVerifier {
  private readonly cache = new Map<string, KeyCache>();
  constructor(private readonly fetcher: typeof fetch = fetch) {}

  async verify(assertion: string, signal?: AbortSignal): Promise<VerifiedBearer> {
    assertAuthSignal(signal);
    if (typeof assertion !== "string" || assertion.length > 64_000 || !assertion.split(".").every(part =>
      part.length > 0 && /^[A-Za-z0-9_-]+$/.test(part) && Buffer.from(part, "base64url").toString("base64url") === part)
      || assertion.split(".").length !== 3) throw invalidBearer();
    const decoded = jwt.decode(assertion, { complete: true });
    if (!decoded || typeof decoded.payload === "string") throw invalidBearer();
    const header = decoded.header;
    if (header.alg !== "RS256" || typeof header.kid !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(header.kid)
      || header.typ !== undefined && header.typ !== "JWT" && header.typ !== "at+jwt"
      || ["jku", "jwk", "x5u", "crit"].some(key => Object.hasOwn(header, key))) throw invalidBearer();
    const untrustedTenant: unknown = decoded.payload.tid;
    if (typeof untrustedTenant !== "string" || !guid.test(untrustedTenant)) throw invalidBearer();
    let tenant;
    try { tenant = getTenantConfiguration(untrustedTenant); }
    catch { throw invalidBearer(); }
    if (!tenant.integration) throw new AppError(401, "bearer_admission_disabled", "Delegated integration is not enabled for this tenant.");
    const fingerprint = tenantConfigurationFingerprint(tenant);
    const key = await this.signingKey(tenant.tenantId, header.kid, signal);
    assertAuthSignal(signal);
    let payload: jwt.JwtPayload;
    try {
      const verified = jwt.verify(assertion, key, {
        algorithms: ["RS256"], issuer: issuer(tenant.tenantId), audience: tenant.integration.audience,
        clockTolerance: 0,
      });
      if (typeof verified === "string") throw invalidBearer();
      payload = verified;
    } catch { throw invalidBearer(); }
    assertTenantConfiguration(tenant.tenantId, fingerprint);
    const now = Date.now();
    const times = [payload.iat, payload.nbf, payload.exp];
    if (times.some(value => typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0)
      || typeof payload.iat !== "number" || typeof payload.nbf !== "number" || typeof payload.exp !== "number"
      || payload.iat * 1000 > now || payload.nbf * 1000 > now || payload.exp * 1000 <= now
      || payload.exp <= payload.iat || payload.exp - payload.iat > 24 * 60 * 60
      || payload.nbf > payload.exp || payload.ver !== "2.0" || payload.tid !== tenant.tenantId
      || payload.aud !== tenant.integration.audience || payload.azp !== tenant.integration.clientId
      || payload.appid !== undefined || payload.idtyp !== undefined && payload.idtyp !== "user"
      || payload.nonce !== undefined || typeof payload.oid !== "string" || !guid.test(payload.oid)
      || typeof payload.sub !== "string" || !payload.sub || payload.sub.length > 256 || /[\p{Cc}\p{Cs}]/u.test(payload.sub)
      || typeof payload.scp !== "string" || payload.scp.length > 4096
      || !/^[A-Za-z0-9_.-]+(?: [A-Za-z0-9_.-]+)*$/.test(payload.scp)
      || !payload.scp.split(" ").includes(tenant.integration.scope)
      || !Array.isArray(payload.roles) || !payload.roles.length || payload.roles.length > 64
      || payload.roles.some(role => !isAppRole(role))
      || payload.wids !== undefined && (!Array.isArray(payload.wids) || payload.wids.length > 64
        || payload.wids.some(role => typeof role !== "string" || !guid.test(role)))) throw invalidBearer();
    if (now - payload.iat * 1000 >= authorizationFreshnessMs) {
      throw new AppError(401, "authorization_stale", "Obtain a newly issued API access token to revalidate app roles.");
    }
    const roles = payload.roles.filter(isAppRole);
    const result: VerifiedBearer = Object.freeze({
      tenantId: tenant.tenantId, apiClientId: tenant.clientId, integrationClientId: tenant.integration.clientId,
      localAccountId: payload.oid, roles: Object.freeze([...new Set(roles)].sort()),
      providerRoleIds: Object.freeze(normalizeInventoryProviderRoleIds(payload.wids)),
      issuedAt: payload.iat * 1000, expiresAt: payload.exp * 1000,
    });
    assertions.set(result, { assertion, fingerprint });
    return result;
  }

  private async signingKey(tenantId: string, kid: string, signal?: AbortSignal) {
    const configured = new Set(config.tenants.map(value => value.tenantId));
    for (const key of this.cache.keys()) if (!configured.has(key)) { this.cache.get(key)?.pending?.cancel(); this.cache.delete(key); }
    let entry = this.cache.get(tenantId);
    if (!entry) {
      entry = { keys: new Map(), expiresAt: 0, refreshAfter: 0 };
      this.cache.set(tenantId, entry);
    }
    if (entry.expiresAt > Date.now() && entry.keys.has(kid)) return entry.keys.get(kid)!;
    if (!entry.pending || entry.pending.aborted) {
      if (entry.refreshAfter > Date.now()) throw new AppError(503, "signing_keys_unavailable", "Signing keys are unavailable during the refresh cooldown.");
      const current = entry;
      const pending = new SharedAuthOperation(async refreshSignal => {
        current.refreshAfter = Date.now() + jwksRefreshCooldownMs;
        try {
          const response = await this.fetcher(`https://login.microsoftonline.com/${tenantId}/discovery/v2.0/keys`, {
            signal: refreshSignal, redirect: "manual",
          });
          if (response.status === 429) {
            const error = identityThrottled(response.headers.get("retry-after"));
            current.refreshAfter = Date.now() + error.retryAfterSeconds! * 1000;
            await response.body?.cancel();
            throw error;
          }
          if (response.status !== 200) { await response.body?.cancel(); throw new Error("invalid response"); }
          const body: unknown = JSON.parse(await boundedAuthBody(response, 256 * 1024, refreshSignal));
          const keys = parseKeys(body, tenantId);
          assertAuthSignal(refreshSignal);
          current.keys = keys;
          current.expiresAt = Date.now() + jwksCacheLifetimeMs;
        } catch (error) {
          if (isApplicationError(error)) throw error;
          throw new AppError(503, "signing_keys_unavailable", "Microsoft signing keys could not be verified.");
        } finally { if (current.pending === pending) current.pending = undefined; }
      });
      current.pending = pending;
    }
    const pending = entry.pending;
    if (!pending) throw new AppError(503, "signing_keys_unavailable", "Signing key refresh was interrupted.");
    await pending.wait(signal);
    assertAuthSignal(signal);
    const key = entry.expiresAt > Date.now() ? entry.keys.get(kid) : undefined;
    if (!key) throw invalidBearer();
    return key;
  }
}

function issuer(tenantId: string) { return `https://login.microsoftonline.com/${tenantId}/v2.0`; }

function parseKeys(body: unknown, tenantId: string) {
  if (!body || typeof body !== "object" || !("keys" in body) || !Array.isArray(body.keys) || !body.keys.length || body.keys.length > 32) throw invalidBearer();
  const keys = new Map<string, KeyObject>();
  for (const value of body.keys) {
    if (!value || typeof value !== "object" || value.kty !== "RSA" || value.use !== "sig"
      || value.alg !== undefined && value.alg !== "RS256"
      || typeof value.kid !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value.kid)
      || keys.has(value.kid) || typeof value.n !== "string" || typeof value.e !== "string"
      || value.d !== undefined || value.jku !== undefined || value.x5u !== undefined
      || value.issuer !== undefined && value.issuer.replace("{tenantid}", tenantId) !== issuer(tenantId)) throw invalidBearer();
    const key = createPublicKey({ key: { kty: "RSA", n: value.n, e: value.e } satisfies JsonWebKey, format: "jwk" });
    const modulus = key.asymmetricKeyDetails?.modulusLength;
    if (key.asymmetricKeyType !== "rsa" || !modulus || modulus < 2048 || modulus > 8192) throw invalidBearer();
    keys.set(value.kid, key);
  }
  return keys;
}
