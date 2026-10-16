import { randomUUID } from "node:crypto";
import {
  ConfidentialClientApplication, type INetworkModule, type NetworkRequestOptions, type NetworkResponse,
  type AuthenticationResult,
} from "@azure/msal-node";
import { getTenantConfiguration } from "../config.js";
import { assertAccountSessionValidation } from "../db/sessions.js";
import { AppError, isApplicationError } from "../errors.js";
import { getCapabilityDefinition, hasAnyRole } from "../services/capabilityRegistry.js";
import type { CapabilityId } from "../types/capability.js";
import type { CredentialReference, DelegatedCredentialSource, RequestPrincipal } from "../types/requestPrincipal.js";
import { acquireDelegatedTokenResult, capabilityScopes, normalizeTokenError, revalidateAuthenticatedUserResult, toAuthenticatedUser, validateTokenResult } from "./msal.js";
import { assertTenantConfiguration, tenantConfigurationFingerprint } from "./flows.js";
import { assertFreshPrincipal, assertVerifiedPrincipal, bearerRequestPrincipal, mappingUnavailable, principalAccountValidation, refreshBrowserPrincipal, type PrincipalEpochAuthority } from "./requestPrincipal.js";
import { assertAuthSignal, boundedAuthBody, identityThrottled, SharedAuthOperation } from "./boundedAuth.js";
import { bearerAssertion, type VerifiedBearer } from "./mcpBearer.js";

type OboResult = { result: AuthenticationResult; clientInfo: string | undefined };
type CredentialOperations = {
  revalidate(signal: AbortSignal): Promise<RequestPrincipal>;
  acquire(capabilityId: CapabilityId, signal: AbortSignal): Promise<AuthenticationResult>;
};
const identityScopes = ["https://graph.microsoft.com/User.ReadBasic.All", "openid", "profile"];

export async function createBearerCredentials(
  verified: VerifiedBearer, epochs: PrincipalEpochAuthority,
  options: { signal?: AbortSignal; fetcher?: typeof fetch } = {},
): Promise<DelegatedCredentialSource> {
  assertAuthSignal(options.signal);
  const tenant = getTenantConfiguration(verified.tenantId);
  const fingerprint = tenantConfigurationFingerprint(tenant);
  const exchange = new SharedAuthOperation(async signal => {
    const response = await obo(verified, identityScopes, signal, options.fetcher ?? fetch);
    assertTenantConfiguration(verified.tenantId, fingerprint);
    const principal = await bearerRequestPrincipal(verified, response.result, response.clientInfo, epochs,
      principalId => validateTokenResult(tenant, response.result, "delegated", "https://graph.microsoft.com", ["User.ReadBasic.All"], [], principalId), signal);
    assertAuthSignal(signal);
    return { principal, expiresAt: response.result.expiresOn!.getTime() };
  });
  const { principal, expiresAt } = await exchange.wait(options.signal);
  return new CredentialSource(principal, epochs, {
    revalidate: async signal => {
      bearerAssertion(verified);
      const fresh = await obo(verified, identityScopes, signal, options.fetcher ?? fetch);
      const mapped = await bearerRequestPrincipal(verified, fresh.result, fresh.clientInfo, epochs,
        principalId => validateTokenResult(getTenantConfiguration(principal.tenantId), fresh.result, "delegated",
          "https://graph.microsoft.com", ["User.ReadBasic.All"], [], principalId), signal);
      requireSamePrincipal(principal, mapped);
      return mapped;
    },
    acquire: async (capabilityId, signal) => {
      const definition = getCapabilityDefinition(capabilityId)!;
      const response = await obo(verified, [...capabilityScopes(capabilityId), "openid", "profile"], signal, options.fetcher ?? fetch);
      const mapped = await bearerRequestPrincipal(verified, response.result, response.clientInfo, epochs,
        principalId => validateTokenResult(getTenantConfiguration(principal.tenantId), response.result, "delegated",
          definition.audience, definition.permissions, definition.acceptedPermissions, principalId), signal);
      requireSamePrincipal(principal, mapped);
      return response.result;
    },
  }, expiresAt);
}

export function createBrowserCredentials(principal: RequestPrincipal, epochs: PrincipalEpochAuthority): DelegatedCredentialSource {
  if (principal.transport !== "browser") throw AppError.unauthorized();
  return new CredentialSource(principal, epochs, {
    revalidate: async () => {
      const result = await revalidateAuthenticatedUserResult(principal.tenantId, principal.principalId);
      if (principal.localAccountId && result.account?.localAccountId !== principal.localAccountId) throw AppError.unauthorized("Microsoft returned a different local account.");
      const user = toAuthenticatedUser(result);
      if (user.tenantId !== principal.tenantId || user.homeAccountId !== principal.principalId) throw AppError.unauthorized();
      return refreshBrowserPrincipal(principal, user);
    },
    acquire: (capabilityId) => acquireDelegatedTokenResult(principal.tenantId, principal.principalId, capabilityId),
  });
}

class CredentialSource implements DelegatedCredentialSource {
  #principal: RequestPrincipal;
  #id = randomUUID();
  #revoked = false;
  #controller = new AbortController();
  #pending = new Map<string, SharedAuthOperation<string | RequestPrincipal>>();
  #cooldownUntil = 0;
  #providerExpiresAt = Infinity;
  #validation;
  #fingerprint;
  #epochs: PrincipalEpochAuthority;
  #operations: CredentialOperations;

  constructor(principal: RequestPrincipal, epochs: PrincipalEpochAuthority, operations: CredentialOperations, providerExpiresAt = Infinity) {
    assertVerifiedPrincipal(principal);
    this.#principal = principal;
    this.#epochs = epochs;
    this.#operations = operations;
    this.#providerExpiresAt = providerExpiresAt;
    this.#validation = principalAccountValidation(principal);
    this.#fingerprint = tenantConfigurationFingerprint(getTenantConfiguration(principal.tenantId));
    this.assertBinding();
  }

  get principal() { return this.#principal; }
  get expiresAt() { return Math.min(this.#principal.expiresAt, this.#providerExpiresAt); }
  get reference(): CredentialReference {
    const { tenantId, principalId, apiClientId, transport, integrationClientId, sessionEpoch, authorizationHash, expiresAt } = this.#principal;
    return Object.freeze({ id: this.#id, tenantId, principalId, apiClientId, transport, integrationClientId, sessionEpoch, authorizationHash, expiresAt });
  }

  assertCurrent() { this.assertBinding(); assertFreshPrincipal(this.#principal); }

  private assertBinding() {
    if (this.#revoked || this.expiresAt <= Date.now()) throw authorizationRequired();
    assertAccountSessionValidation(this.#validation);
    assertTenantConfiguration(this.#principal.tenantId, this.#fingerprint);
  }

  private async assertEpoch(signal: AbortSignal) {
    this.assertBinding();
    assertAuthSignal(signal);
    const epoch = await this.#epochs.sessionEpoch(this.#principal.tenantId, this.#principal.principalId);
    assertAuthSignal(signal);
    this.assertBinding();
    if (epoch !== this.#principal.sessionEpoch) throw authorizationRequired();
  }

  async revalidate(signal?: AbortSignal) {
    this.assertBinding();
    const result = await this.run("roles", async activeSignal => {
      await this.assertEpoch(activeSignal);
      const principal = await this.#operations.revalidate(activeSignal);
      await this.assertEpoch(activeSignal);
      requireSamePrincipal(this.#principal, principal);
      assertFreshPrincipal(principal);
      this.#principal = principal;
      return principal;
    }, signal);
    if (typeof result === "string") throw new Error("invalid credential operation");
    return result;
  }

  async acquire(capabilityId: CapabilityId, signal?: AbortSignal) {
    this.assertCurrent();
    const definition = getCapabilityDefinition(capabilityId);
    if (!definition || definition.mode !== "delegated") throw new AppError(400, "invalid_token_mode", "Only capability-specific delegated acquisition is supported.");
    if (!hasAnyRole(this.#principal.roles, definition.internalRoles)) throw new AppError(403, "missing_internal_role", "The required Agent Control role is not assigned.");
    const authorizationHash = this.#principal.authorizationHash;
    const result = await this.run(`token:${capabilityId}:${authorizationHash}`, async activeSignal => {
      await this.assertEpoch(activeSignal);
      this.assertCurrent();
      const result = await this.#operations.acquire(capabilityId, activeSignal);
      await this.assertEpoch(activeSignal);
      this.assertCurrent();
      if (this.#principal.authorizationHash !== authorizationHash) throw authorizationRequired();
      if (!(result.expiresOn instanceof Date) || !Number.isFinite(result.expiresOn.getTime())
        || result.expiresOn.getTime() - 1000 <= Date.now()) throw authorizationRequired();
      this.#providerExpiresAt = Math.min(this.#providerExpiresAt, result.expiresOn.getTime() - 1000);
      return result.accessToken;
    }, signal);
    if (typeof result !== "string") throw new Error("invalid credential operation");
    return result;
  }

  private async run(key: string, operation: (signal: AbortSignal) => Promise<string | RequestPrincipal>, signal?: AbortSignal) {
    assertAuthSignal(signal);
    if (this.#cooldownUntil > Date.now()) {
      const error = identityThrottled(String(Math.ceil((this.#cooldownUntil - Date.now()) / 1000)));
      throw error;
    }
    let pending = this.#pending.get(key);
    if (!pending || pending.aborted) {
      const current = new SharedAuthOperation(async activeSignal => {
        const linked = AbortSignal.any([activeSignal, this.#controller.signal]);
        try { return await operation(linked); }
        catch (error) {
          if (isApplicationError(error) && error.status === 429) this.#cooldownUntil = Date.now() + (error.retryAfterSeconds ?? 30) * 1000;
          if (isApplicationError(error) && error.status === 401) {
            const capabilitySpecific = this.#principal.transport === "browser" && key.startsWith("token:")
              && ["interaction_required", "authorization_expired"].includes(error.code);
            // Provider token renewal does not invalidate the authenticated browser identity.
            if (!capabilitySpecific) {
              if (this.#pending.get(key) === current) this.#pending.delete(key);
              this.revoke();
            }
          }
          throw error;
        } finally { if (this.#pending.get(key) === current) this.#pending.delete(key); }
      });
      this.#pending.set(key, current);
      pending = current;
    }
    const result = await pending.wait(signal);
    this.assertBinding();
    return result;
  }

  revoke() {
    this.#revoked = true;
    this.#controller.abort();
    for (const operation of this.#pending.values()) operation.cancel();
    this.#pending.clear();
  }

  toJSON() { return { principal: this.principal, reference: this.reference }; }
}

// API-owned memory only. A durable reference is deliberately unusable after restart.
export class DelegatedCredentialStore {
  #sources = new Map<string, DelegatedCredentialSource>();
  constructor(private readonly maximumSources = 10_000) {
    if (!Number.isSafeInteger(maximumSources) || maximumSources < 1 || maximumSources > 10_000) throw new Error("Invalid credential capacity.");
  }

  retain(source: DelegatedCredentialSource) {
    source.assertCurrent();
    this.prune();
    if (this.#sources.size >= this.maximumSources && !this.#sources.has(source.reference.id)) {
      throw new AppError(503, "credential_capacity", "Ephemeral authorization capacity is full.");
    }
    this.#sources.set(source.reference.id, source);
    return source.reference;
  }

  resolve(reference: CredentialReference, principal: RequestPrincipal) {
    assertFreshPrincipal(principal);
    if (["tenantId", "principalId", "apiClientId", "sessionEpoch", "authorizationHash"].some(key =>
      reference[key as keyof CredentialReference] !== principal[key as keyof RequestPrincipal])) throw authorizationRequired();
    const source = this.#sources.get(reference.id);
    if (!source || Object.keys(source.reference).some(key =>
      source.reference[key as keyof CredentialReference] !== reference[key as keyof CredentialReference])) throw authorizationRequired();
    source.assertCurrent();
    return source;
  }

  reauthorize(reference: CredentialReference, source: DelegatedCredentialSource) {
    source.assertCurrent();
    if (reference.tenantId !== source.principal.tenantId || reference.principalId !== source.principal.principalId
      || reference.apiClientId !== source.principal.apiClientId || reference.sessionEpoch !== source.principal.sessionEpoch) throw authorizationRequired();
    const retained = this.#sources.get(reference.id);
    if (retained && (retained.principal.tenantId !== reference.tenantId || retained.principal.principalId !== reference.principalId
      || retained.principal.apiClientId !== reference.apiClientId || retained.principal.sessionEpoch !== reference.sessionEpoch)) throw authorizationRequired();
    if (reference.id !== source.reference.id) this.disconnect(reference.id);
    return this.retain(source);
  }

  disconnect(id: string) { this.#sources.get(id)?.revoke(); this.#sources.delete(id); }

  revokePrincipal(tenantId: string, principalId: string) {
    for (const [id, source] of this.#sources) if (source.principal.tenantId === tenantId && source.principal.principalId === principalId) this.disconnect(id);
  }

  private prune() {
    for (const [id, source] of this.#sources) {
      try { source.assertCurrent(); }
      catch (error) {
        if (!isApplicationError(error) || error.status !== 401) throw error;
        this.disconnect(id);
      }
    }
  }
}

async function obo(verified: VerifiedBearer, scopes: string[], signal: AbortSignal, fetcher: typeof fetch): Promise<OboResult> {
  const assertion = bearerAssertion(verified);
  const tenant = getTenantConfiguration(verified.tenantId);
  const authority = `https://login.microsoftonline.com/${tenant.tenantId}`;
  const endpoint = `${authority}/oauth2/v2.0/token`;
  let clientInfo: string | undefined;
  let responseExpiresAt: number | undefined;
  let networkFailure: AppError | undefined;
  const network: INetworkModule = {
    sendGetRequestAsync: async () => {
      networkFailure = new AppError(502, "invalid_identity_endpoint", "Unexpected identity discovery endpoint.");
      throw networkFailure;
    },
    sendPostRequestAsync: async <T>(url: string, options?: NetworkRequestOptions): Promise<NetworkResponse<T>> => {
      try {
        assertAuthSignal(signal);
        const parsedUrl = new URL(url);
        if (`${parsedUrl.origin}${parsedUrl.pathname}` !== endpoint || parsedUrl.username || parsedUrl.password || parsedUrl.hash
          || [...parsedUrl.searchParams].some(([key, value]) => key !== "client-request-id" || !/^[a-f0-9-]{36}$/.test(value))
          || parsedUrl.searchParams.getAll("client-request-id").length > 1) {
          throw new AppError(502, "invalid_identity_endpoint", "Unexpected identity exchange endpoint.");
        }
        let response: Response;
        const requestedAt = Date.now();
        try { response = await fetcher(url, { method: "POST", body: options?.body, headers: options?.headers, redirect: "manual", signal }); }
        catch { assertAuthSignal(signal); throw new AppError(502, "identity_provider_error", "Microsoft token acquisition failed.", { retryable: true }); }
        if (response.status === 429) { await response.body?.cancel(); throw identityThrottled(response.headers.get("retry-after")); }
        if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); throw new AppError(502, "invalid_identity_endpoint", "Identity redirects are not accepted."); }
        const text = await boundedAuthBody(response, 128 * 1024, signal);
        let body: unknown;
        try { body = JSON.parse(text); }
        catch { throw new AppError(502, "invalid_identity_response", "Microsoft returned malformed token metadata."); }
        if (!body || typeof body !== "object" || Array.isArray(body)) throw mappingUnavailable();
        if (response.status === 200) {
          const lifetime = "expires_in" in body && typeof body.expires_in === "string" && /^\d{1,6}$/.test(body.expires_in)
            ? Number(body.expires_in) : "expires_in" in body ? body.expires_in : undefined;
          if (typeof lifetime !== "number" || !Number.isSafeInteger(lifetime) || lifetime <= 0 || lifetime > 48 * 3600
            || !("scope" in body) || typeof body.scope !== "string" || !body.scope || body.scope.length > 4096
            || !("token_type" in body) || body.token_type !== "Bearer") {
            throw new AppError(502, "invalid_identity_response", "Microsoft returned incomplete or invalid delegated token metadata.");
          }
          responseExpiresAt = requestedAt + lifetime * 1000;
        }
        if (response.status >= 400 && "claims" in body) {
          const claims = boundedClaimsChallenge(body.claims);
          if (claims) throw new AppError(401, "claims_challenge", "Fresh sign-in is required to satisfy Microsoft authorization.", { claims });
        }
        if (response.status === 200 && "client_info" in body && typeof body.client_info === "string") clientInfo = body.client_info;
        return { status: response.status, headers: Object.fromEntries(response.headers), body: body as T };
      } catch (error) {
        if (isApplicationError(error)) networkFailure = error;
        throw error;
      }
    },
  };
  const client = new ConfidentialClientApplication({
    auth: {
      authority, clientId: tenant.clientId, clientSecret: tenant.clientSecret,
      cloudDiscoveryMetadata: JSON.stringify({ metadata: [{
        preferred_network: "login.microsoftonline.com", preferred_cache: "login.windows.net",
        aliases: ["login.microsoftonline.com", "login.windows.net"],
      }] }),
      authorityMetadata: JSON.stringify({
        issuer: `${authority}/v2.0`, authorization_endpoint: `${authority}/oauth2/v2.0/authorize`,
        token_endpoint: endpoint, end_session_endpoint: `${authority}/oauth2/v2.0/logout`,
      }),
    },
    system: { networkClient: network, loggerOptions: { piiLoggingEnabled: false, loggerCallback: () => {} } },
  });
  try {
    const result = await client.acquireTokenOnBehalfOf({ authority, oboAssertion: assertion, scopes, skipCache: true });
    assertAuthSignal(signal);
    if (!result || !(result.expiresOn instanceof Date) || responseExpiresAt === undefined) throw mappingUnavailable();
    // MSAL rounds request time to seconds; never extend the token endpoint's exact deadline.
    const expiresOn = new Date(Math.min(result.expiresOn.getTime(), responseExpiresAt));
    return { result: { ...result, expiresOn }, clientInfo };
  } catch (error) {
    assertAuthSignal(signal);
    if (networkFailure) throw networkFailure;
    throw normalizeTokenError(error);
  }
}

export function boundedClaimsChallenge(value: unknown): string | undefined {
  if (typeof value !== "string" || Buffer.byteLength(value) > 4096) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || Object.keys(parsed).length !== 1 || !("access_token" in parsed)) return undefined;
    const claims = parsed.access_token;
    if (!claims || typeof claims !== "object" || Array.isArray(claims) || Object.keys(claims).length > 16) return undefined;
    for (const [key, claim] of Object.entries(claims)) {
      if (!/^[A-Za-z0-9_]{1,64}$/.test(key) || !claim || typeof claim !== "object" || Array.isArray(claim)
        || Object.keys(claim).some(field => !["essential", "value", "values"].includes(field))
        || claim.essential !== undefined && typeof claim.essential !== "boolean"
        || claim.value !== undefined && !challengeValue(claim.value)
        || claim.values !== undefined && (!Array.isArray(claim.values) || claim.values.length > 16 || !claim.values.every(challengeValue))) return undefined;
    }
    return JSON.stringify(parsed);
  } catch { return undefined; }
}

function challengeValue(value: unknown) {
  return typeof value === "string" && /^[A-Za-z0-9_.:-]{1,256}$/.test(value);
}

function requireSamePrincipal(expected: RequestPrincipal, actual: RequestPrincipal) {
  if (["tenantId", "principalId", "localAccountId", "apiClientId", "integrationClientId", "transport", "sessionEpoch"].some(key =>
    expected[key as keyof RequestPrincipal] !== actual[key as keyof RequestPrincipal])) throw mappingUnavailable();
}

function authorizationRequired() {
  return new AppError(401, "authorization_required", "Fresh same-principal authorization is required; the job must pause.");
}
