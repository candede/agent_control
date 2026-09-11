import { secretValue } from "./db/pool.js";

const port = Number(process.env.PORT ?? 3001);
const frontendOrigin = process.env.FRONTEND_ORIGIN ?? "http://localhost:3001";
const redirectUri = process.env.REDIRECT_URI ?? `${frontendOrigin}/api/auth/callback`;
const deploymentTarget = process.env.WEBSITE_SITE_NAME ? "azure" : "local";
const officialUsageStaleDays = Number(process.env.OFFICIAL_USAGE_STALE_AFTER_DAYS ?? 35);
export const config = {
  nodeEnv: process.env.NODE_ENV ?? "development",
  deploymentTarget,
  port,
  tenantId: secretValue("TENANT_ID"),
  clientId: secretValue("CLIENT_ID"),
  clientSecret: secretValue("CLIENT_SECRET"),
  frontendOrigin,
  redirectUri,
  officialUsageStaleDays,
  sessionSecret: secretValue("SESSION_SECRET") ?? "",
  trustProxy: deploymentTarget === "azure" || process.env.TRUST_PROXY === "1",
};
export const authConfigured = Boolean(config.tenantId && config.clientId && config.clientSecret);

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
  const configuredAuthValues = [config.tenantId, config.clientId, config.clientSecret].filter(Boolean).length;
  if (configuredAuthValues !== 0 && configuredAuthValues !== 3) throw new Error("TENANT_ID, CLIENT_ID, and CLIENT_SECRET must be configured together.");
  for (const value of [config.tenantId, config.clientId]) {
    if (value && !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value)) throw new Error("Tenant and client identifiers must be GUIDs.");
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