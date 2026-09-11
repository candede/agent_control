import { afterEach, describe, expect, it, vi } from "vitest";

const names = [
  "NODE_ENV", "WEBSITE_SITE_NAME", "FRONTEND_ORIGIN", "REDIRECT_URI",
  "TENANT_ID", "TENANT_ID_FILE", "CLIENT_ID", "CLIENT_ID_FILE",
  "CLIENT_SECRET", "CLIENT_SECRET_FILE", "SESSION_SECRET", "SESSION_SECRET_FILE",
  "TRUST_PROXY", "BOOTSTRAP_ADMIN", "BOOTSTRAP_ROLES", "AGENT_CONTROL_ADMIN", "AGENT_CONTROL_FIXTURE_MODE", "OFFICIAL_USAGE_STALE_AFTER_DAYS",
  "AGENT_CONTROL_AUTH_BYPASS", "AUTH_BYPASS", "ALLOW_ANY_ORIGIN", "SQLITE_PATH", "DATABASE_URL",
  "ENABLE_RAW_PROVIDER_DATA", "ENABLE_ARBITRARY_KQL", "DISABLE_RETENTION",
];
const originalValues = new Map(names.map(name => [name, process.env[name]]));

async function loadConfig(values: Record<string, string> = {}) {
  for (const name of names) delete process.env[name];
  Object.assign(process.env, values);
  vi.resetModules();
  return import("./config.js");
}

afterEach(() => {
  for (const name of names) {
    const value = originalValues.get(name);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  vi.resetModules();
});

describe("runtime configuration", () => {
  it("rejects fixture authentication in every runtime environment", async () => {
    for (const nodeEnv of ["production", "development", "test"]) {
      const loaded = await loadConfig({ NODE_ENV: nodeEnv, SESSION_SECRET: "x".repeat(32), AGENT_CONTROL_FIXTURE_MODE: "browser" });
      expect(() => loaded.validateRuntimeConfig()).toThrow("Fixture authentication is forbidden");
    }
  });
  it("accepts unconfigured localhost mode without assigning authority", async () => {
    const loaded = await loadConfig({ NODE_ENV: "test", SESSION_SECRET: "x".repeat(32) });
    expect(() => loaded.validateRuntimeConfig()).not.toThrow();
    expect(loaded.authConfigured).toBe(false);
    expect(loaded.config).toMatchObject({ deploymentTarget: "local", frontendOrigin: "http://localhost:3001", redirectUri: "http://localhost:3001/api/auth/callback", trustProxy: false });
    expect(loaded.config.officialUsageStaleDays).toBe(35);
    expect(loaded.config).not.toHaveProperty("roles");
  });

  it("validates the configurable official usage staleness threshold", async () => {
    const accepted = await loadConfig({ NODE_ENV: "test", SESSION_SECRET: "x".repeat(32), OFFICIAL_USAGE_STALE_AFTER_DAYS: "45" });
    expect(() => accepted.validateRuntimeConfig()).not.toThrow();
    expect(accepted.config.officialUsageStaleDays).toBe(45);
    const rejected = await loadConfig({ NODE_ENV: "test", SESSION_SECRET: "x".repeat(32), OFFICIAL_USAGE_STALE_AFTER_DAYS: "0" });
    expect(() => rejected.validateRuntimeConfig()).toThrow("OFFICIAL_USAGE_STALE_AFTER_DAYS");
  });

  it("rejects incomplete, insecure, or weak Azure production configuration", async () => {
    const incomplete = await loadConfig({ WEBSITE_SITE_NAME: "agent-control", NODE_ENV: "production", FRONTEND_ORIGIN: "https://frontend.example", REDIRECT_URI: "https://frontend.example/api/auth/callback", SESSION_SECRET: "x".repeat(32) });
    expect(() => incomplete.validateRuntimeConfig()).toThrow("Azure requires");
    const weak = await loadConfig({ WEBSITE_SITE_NAME: "agent-control", NODE_ENV: "production", FRONTEND_ORIGIN: "https://frontend.example", REDIRECT_URI: "https://frontend.example/api/auth/callback", TENANT_ID: "11111111-1111-1111-1111-111111111111", CLIENT_ID: "22222222-2222-2222-2222-222222222222", CLIENT_SECRET: "secret", SESSION_SECRET: "short" });
    expect(() => weak.validateRuntimeConfig()).toThrow("at least 32 bytes");
    const insecure = await loadConfig({ WEBSITE_SITE_NAME: "agent-control", NODE_ENV: "production", TENANT_ID: "11111111-1111-1111-1111-111111111111", CLIENT_ID: "22222222-2222-2222-2222-222222222222", CLIENT_SECRET: "secret", SESSION_SECRET: "x".repeat(32) });
    expect(() => insecure.validateRuntimeConfig()).toThrow("Azure requires");
  });

  it("accepts complete Azure settings and derives trusted-proxy behavior", async () => {
    const loaded = await loadConfig({ WEBSITE_SITE_NAME: "agent-control", NODE_ENV: "production", FRONTEND_ORIGIN: "https://frontend.example", REDIRECT_URI: "https://frontend.example/api/auth/callback", TENANT_ID: "11111111-1111-1111-1111-111111111111", CLIENT_ID: "22222222-2222-2222-2222-222222222222", CLIENT_SECRET: "secret", SESSION_SECRET: "x".repeat(32) });
    expect(() => loaded.validateRuntimeConfig()).not.toThrow();
    expect(loaded.authConfigured).toBe(true);
    expect(loaded.config.trustProxy).toBe(true);
  });

  it("rejects callbacks on another origin, including another localhost port", async () => {
    for (const [origin, callback] of [
      ["https://app.example", "https://other.example/api/auth/callback"],
      ["http://localhost:3001", "http://localhost:3002/api/auth/callback"],
    ]) {
      const loaded = await loadConfig({ FRONTEND_ORIGIN: origin, REDIRECT_URI: callback, SESSION_SECRET: "x".repeat(32) });
      expect(() => loaded.validateRuntimeConfig()).toThrow("same origin");
    }
  });

  it("ignores bootstrap role and administrator environment variables", async () => {
    const loaded = await loadConfig({ NODE_ENV: "test", SESSION_SECRET: "x".repeat(32), BOOTSTRAP_ADMIN: "true", BOOTSTRAP_ROLES: "AgentControl.Administrator", AGENT_CONTROL_ADMIN: "fixture@example.invalid" });
    loaded.validateRuntimeConfig();
    expect(loaded.config).not.toHaveProperty("roles");
    expect(JSON.stringify(loaded.config)).not.toContain("AgentControl.Administrator");
    expect(JSON.stringify(loaded.config)).not.toContain("fixture@example.invalid");
  });

  it("rejects bootstrap role and administrator variables in production", async () => {
    for (const name of ["BOOTSTRAP_ADMIN","BOOTSTRAP_ROLES","AGENT_CONTROL_ADMIN"]) {
      const loaded = await loadConfig({NODE_ENV:"production",SESSION_SECRET:"x".repeat(32),[name]:"fixture"});
      expect(() => loaded.validateRuntimeConfig()).toThrow("forbidden in production");
    }
  });

  it("rejects runtime bypass, alternate persistence, raw data, arbitrary KQL and disabled retention", async () => {
    for (const name of ["AGENT_CONTROL_AUTH_BYPASS", "ALLOW_ANY_ORIGIN", "SQLITE_PATH", "DATABASE_URL", "ENABLE_RAW_PROVIDER_DATA", "ENABLE_ARBITRARY_KQL", "DISABLE_RETENTION"]) {
      const loaded = await loadConfig({ NODE_ENV: "production", SESSION_SECRET: "x".repeat(32), [name]: "true" });
      expect(() => loaded.validateRuntimeConfig()).toThrow("unsupported");
    }
  });
});