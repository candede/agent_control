import { domainToASCII } from "node:url";
import { secretValue } from "./db/pool.js";
import { AppError } from "./errors.js";

export type TenantConfiguration = {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  domains: readonly string[];
  displayName: string;
};

const identifierPattern = /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const tenantRegistryValue = secretValue("TENANTS_JSON");
const legacyIdentity = {
  tenantId: tenantRegistryValue === undefined ? secretValue("TENANT_ID") : undefined,
  clientId: tenantRegistryValue === undefined ? secretValue("CLIENT_ID") : undefined,
  clientSecret: tenantRegistryValue === undefined ? secretValue("CLIENT_SECRET") : undefined,
};
const tenants: readonly TenantConfiguration[] = readTenantConfigurations();

const port = Number(process.env.PORT ?? 3001);
const frontendOrigin = process.env.FRONTEND_ORIGIN ?? "http://localhost:3001";
const redirectUri = process.env.REDIRECT_URI ?? `${frontendOrigin}/api/auth/callback`;
const deploymentTarget = process.env.WEBSITE_SITE_NAME ? "azure" : "local";
const officialUsageStaleDays = Number(process.env.OFFICIAL_USAGE_STALE_AFTER_DAYS ?? 35);
export const config = {
  nodeEnv: process.env.NODE_ENV ?? "development",
  deploymentTarget,
  port,
  tenants,
  frontendOrigin,
  redirectUri,
  officialUsageStaleDays,
  sessionSecret: secretValue("SESSION_SECRET") ?? "",
  trustProxy: deploymentTarget === "azure" || process.env.TRUST_PROXY === "1",
};
export const authConfigured = config.tenants.length > 0 && config.tenants.every(tenant => tenant.domains.length > 0);

export function findTenantConfiguration(tenantId: string | undefined) {
  return typeof tenantId === "string" ? config.tenants.find(tenant => tenant.tenantId === tenantId.toLowerCase()) : undefined;
}

export function getTenantConfiguration(tenantId: string): TenantConfiguration {
  const tenant = findTenantConfiguration(tenantId);
  if (!tenant) throw AppError.unauthorized("The organization is not configured for Agent Control.");
  return tenant;
}

export function resolveTenantForUsername(value: unknown) {
  if (!authConfigured) throw AppError.serviceUnavailable("Configure tenant credentials and accepted sign-in domains before signing in.");
  const username = normalizeSignInUsername(value);
  const domain = username.slice(username.lastIndexOf("@") + 1);
  const tenant = config.tenants.find(candidate => candidate.domains.includes(domain));
  if (!tenant) throw new AppError(400, "unknown_tenant", "This username's domain is not enabled for Agent Control. Contact your organization administrator.");
  return { username, tenant };
}

export function normalizeSignInUsername(value: unknown) {
  if (typeof value !== "string") throw invalidUsername();
  const username = value.trim();
  if (username.length > 254 || !/^[^\s@]+@[^\s@]+$/.test(username)) throw invalidUsername();
  const separator = username.lastIndexOf("@");
  const domain = normalizeDomain(username.slice(separator + 1));
  if (!domain) throw invalidUsername();
  return `${username.slice(0, separator).toLowerCase()}@${domain}`;
}

function invalidUsername() {
  return new AppError(400, "invalid_username", "Enter your work or school username, including its organization domain.");
}

function normalizeDomain(value: string) {
  const input = value.trim().toLowerCase();
  if (!/^[\p{L}\p{N}\p{M}.-]+$/u.test(input)) return undefined;
  const domain = domainToASCII(input);
  if (domain.length > 253 || !domain.includes(".") || !domain.split(".").every(label =>
    /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) return undefined;
  return domain;
}

function readTenantConfigurations(): TenantConfiguration[] {
  if (tenantRegistryValue !== undefined) {
    let parsed: unknown;
    try { parsed = JSON.parse(tenantRegistryValue); }
    catch { throw new Error("TENANTS_JSON must contain a JSON array of tenant profiles."); }
    if (!Array.isArray(parsed)) throw new Error("TENANTS_JSON must contain a JSON array of tenant profiles.");
    const profiles = parsed.map((value: unknown, index) => parseTenantConfiguration(value, `TENANTS_JSON entry ${index + 1}`));
    assertUniqueTenants(profiles);
    return profiles;
  }
  const { tenantId, clientId, clientSecret } = legacyIdentity;
  if (!tenantId || !clientId || !clientSecret) return [];
  const domains = secretValue("TENANT_DOMAINS")?.split(",").map(value => value.trim()).filter(Boolean) ?? [];
  return [parseTenantConfiguration({
    tenantId, clientId, clientSecret, domains, displayName: process.env.TENANT_DISPLAY_NAME,
  }, "Legacy tenant settings", true)];
}

function parseTenantConfiguration(value: unknown, label: string, allowMissingDomains = false): TenantConfiguration {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be a tenant profile.`);
  const profile = value as Record<string, unknown>;
  if (typeof profile.tenantId !== "string" || !identifierPattern.test(profile.tenantId)
    || typeof profile.clientId !== "string" || !identifierPattern.test(profile.clientId)) {
    throw new Error(`${label}: tenantId and clientId must be GUIDs.`);
  }
  if (typeof profile.clientSecret !== "string" || !profile.clientSecret.trim() || /[\r\n\0]/.test(profile.clientSecret)) {
    throw new Error(`${label}: clientSecret must be a non-empty, single-line secret value.`);
  }
  if (!Array.isArray(profile.domains) || (!allowMissingDomains && profile.domains.length === 0)) {
    throw new Error(`${label}: domains must contain at least one accepted sign-in domain.`);
  }
  const domains = profile.domains.map((domain: unknown) => {
    const normalized = typeof domain === "string" ? normalizeDomain(domain) : undefined;
    if (!normalized) throw new Error(`${label}: domains must be exact organization domains, without URLs, email addresses, or wildcards.`);
    return normalized;
  });
  if (new Set(domains).size !== domains.length) throw new Error(`${label}: duplicate sign-in domain.`);
  if (profile.displayName !== undefined && (typeof profile.displayName !== "string"
    || !profile.displayName.trim() || profile.displayName.length > 128 || /[\x00-\x1f\x7f]/.test(profile.displayName))) {
    throw new Error(`${label}: displayName must contain 1 to 128 printable characters.`);
  }
  return {
    tenantId: profile.tenantId.toLowerCase(),
    clientId: profile.clientId.toLowerCase(),
    clientSecret: profile.clientSecret,
    domains,
    displayName: typeof profile.displayName === "string" ? profile.displayName.trim() : profile.tenantId.toLowerCase(),
  };
}

function assertUniqueTenants(profiles: readonly TenantConfiguration[]) {
  const tenantIds = new Set<string>();
  const domains = new Set<string>();
  for (const profile of profiles) {
    if (tenantIds.has(profile.tenantId)) throw new Error("TENANTS_JSON contains a duplicate tenant ID.");
    tenantIds.add(profile.tenantId);
    for (const domain of profile.domains) {
      if (domains.has(domain)) throw new Error("TENANTS_JSON assigns a sign-in domain to more than one tenant.");
      domains.add(domain);
    }
  }
}

export function validateRuntimeConfig() {
  if (process.env.AGENT_CONTROL_FIXTURE_MODE) throw new Error("Fixture authentication is forbidden in the application runtime.");
  if ((config.nodeEnv === "production" || config.deploymentTarget === "azure")
    && ["BOOTSTRAP_ADMIN","BOOTSTRAP_ROLES","AGENT_CONTROL_ADMIN"].some(name => process.env[name])) {
    throw new Error("Bootstrap authentication or role configuration is forbidden in production.");
  }
  for (const name of [
    "AGENT_CONTROL_AUTH_BYPASS", "AUTH_BYPASS", "ALLOW_ANY_ORIGIN", "SQLITE_PATH",
    "DATABASE_URL", "ENABLE_RAW_PROVIDER_DATA", "ENABLE_ARBITRARY_KQL", "DISABLE_RETENTION",
  ]) {
    if (process.env[name]) throw new Error(`${name} is unsupported by the production runtime.`);
  }
  if (process.env.TRUST_PROXY && !["0", "1"].includes(process.env.TRUST_PROXY)) throw new Error("TRUST_PROXY must be 0 or 1.");
  const origin = canonicalUrl(config.frontendOrigin, "FRONTEND_ORIGIN");
  if (origin.origin !== config.frontendOrigin || origin.pathname !== "/") throw new Error("FRONTEND_ORIGIN must contain only a canonical origin.");
  const callback = canonicalUrl(config.redirectUri, "REDIRECT_URI");
  if (callback.toString() !== config.redirectUri || callback.pathname !== "/api/auth/callback") throw new Error("REDIRECT_URI must be the canonical /api/auth/callback URL.");
  if (callback.origin !== origin.origin) throw new Error("REDIRECT_URI must use the same origin as FRONTEND_ORIGIN.");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT is invalid.");
  if (!Number.isSafeInteger(config.officialUsageStaleDays) || config.officialUsageStaleDays < 1 || config.officialUsageStaleDays > 365) throw new Error("OFFICIAL_USAGE_STALE_AFTER_DAYS must be an integer from 1 to 365.");
  if (Buffer.byteLength(config.sessionSecret) < 32) throw new Error("SESSION_SECRET requires at least 32 bytes; recover the existing secret file.");
  if (tenantRegistryValue === undefined) {
    const configuredAuthValues = Object.values(legacyIdentity).filter(Boolean).length;
    if (configuredAuthValues !== 0 && configuredAuthValues !== 3) throw new Error("TENANT_ID, CLIENT_ID, and CLIENT_SECRET must be configured together.");
    if (configuredAuthValues === 3 && !authConfigured) {
      throw new Error("Existing tenant credentials are retained. Add TENANT_DOMAINS or migrate them to TENANTS_JSON with accepted sign-in domains.");
    }
  }
  if (config.deploymentTarget === "azure" && (config.nodeEnv !== "production" || origin.protocol !== "https:" || callback.protocol !== "https:" || !authConfigured)) {
    throw new Error("Azure requires production mode, HTTPS origins, and configured Entra authentication.");
  }
}

function canonicalUrl(value: string, name: string) {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new Error(`${name} must be an absolute URL.`); }
  if (url.username || url.password || url.search || url.hash || !["http:", "https:"].includes(url.protocol) || url.protocol === "http:" && url.hostname !== "localhost") {
    throw new Error(`${name} must use HTTPS or local http://localhost without credentials, query, or fragment.`);
  }
  return url;
}

export const loginScopes = ["openid", "profile"];