import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const names = [
  "NODE_ENV", "WEBSITE_SITE_NAME", "FRONTEND_ORIGIN", "REDIRECT_URI",
  "TENANT_ID", "TENANT_ID_FILE", "CLIENT_ID", "CLIENT_ID_FILE",
  "CLIENT_SECRET", "CLIENT_SECRET_FILE", "SESSION_SECRET", "SESSION_SECRET_FILE",
  "TENANTS_JSON", "TENANTS_JSON_FILE", "TENANT_DOMAINS", "TENANT_DOMAINS_FILE", "TENANT_DISPLAY_NAME",
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
    const weak = await loadConfig({ WEBSITE_SITE_NAME: "agent-control", NODE_ENV: "production", FRONTEND_ORIGIN: "https://frontend.example", REDIRECT_URI: "https://frontend.example/api/auth/callback", TENANT_ID: "11111111-1111-1111-1111-111111111111", CLIENT_ID: "22222222-2222-2222-2222-222222222222", CLIENT_SECRET: "secret", TENANT_DOMAINS: "example.invalid", SESSION_SECRET: "short" });
    expect(() => weak.validateRuntimeConfig()).toThrow("at least 32 bytes");
    const insecure = await loadConfig({ WEBSITE_SITE_NAME: "agent-control", NODE_ENV: "production", TENANT_ID: "11111111-1111-1111-1111-111111111111", CLIENT_ID: "22222222-2222-2222-2222-222222222222", CLIENT_SECRET: "secret", TENANT_DOMAINS: "example.invalid", SESSION_SECRET: "x".repeat(32) });
    expect(() => insecure.validateRuntimeConfig()).toThrow("Azure requires");
  });

  it("accepts complete Azure settings and derives trusted-proxy behavior", async () => {
    const loaded = await loadConfig({ WEBSITE_SITE_NAME: "agent-control", NODE_ENV: "production", FRONTEND_ORIGIN: "https://frontend.example", REDIRECT_URI: "https://frontend.example/api/auth/callback", TENANT_ID: "11111111-1111-1111-1111-111111111111", CLIENT_ID: "22222222-2222-2222-2222-222222222222", CLIENT_SECRET: "secret", TENANT_DOMAINS: "example.invalid", SESSION_SECRET: "x".repeat(32) });
    expect(() => loaded.validateRuntimeConfig()).not.toThrow();
    expect(loaded.authConfigured).toBe(true);
    expect(loaded.config.trustProxy).toBe(true);
  });

  const tenantA = {
    tenantId: "11111111-1111-1111-1111-111111111111", clientId: "22222222-2222-2222-2222-222222222222",
    clientSecret: "synthetic-tenant-a-secret", domains: ["a.example", "alias.a.example"], displayName: "Organization A",
  };
  const tenantB = {
    tenantId: "33333333-3333-3333-3333-333333333333", clientId: "44444444-4444-4444-4444-444444444444",
    clientSecret: "synthetic-tenant-b-secret", domains: ["b.example"], displayName: "Organization B",
  };

  describe("tenant configuration and username routing", () => {
    it("routes normalized usernames and aliases to the exact configured organization", async () => {
      const loaded = await loadConfig({ TENANTS_JSON: JSON.stringify([tenantA, tenantB]), SESSION_SECRET: "x".repeat(32) });
      loaded.validateRuntimeConfig();
      expect(loaded.authConfigured).toBe(true);
      expect(loaded.resolveTenantForUsername("  Admin@A.Example  ")).toEqual({ username: "admin@a.example", tenant: tenantA });
      expect(loaded.resolveTenantForUsername("admin@alias.a.example").tenant).toEqual(tenantA);
      expect(loaded.resolveTenantForUsername("admin@b.example").tenant).toEqual(tenantB);
      expect(loaded.getTenantConfiguration(tenantB.tenantId)).toEqual(tenantB);
      expect(loaded.findTenantConfiguration("unconfigured")).toBeUndefined();
      expect(() => loaded.getTenantConfiguration("unconfigured")).toThrow("not configured");
    });

    it("does not infer a tenant from a suffix, malformed username, or an unknown domain", async () => {
      const loaded = await loadConfig({ TENANTS_JSON: JSON.stringify([tenantA, tenantB]) });
      for (const username of ["admin@sub.a.example", "admin@a.example.attacker.invalid", "admin@unknown.example"]) {
        expect(() => loaded.resolveTenantForUsername(username)).toThrow(expect.objectContaining({ code: "unknown_tenant" }));
      }
      for (const username of [undefined, [], "admin", "@a.example", "admin@@a.example", "admin @a.example",
        "admin@https://a.example", "admin@a.example/path", "admin@a.example:443", "admin@a.example.",
        "admin@a\u3002example", "admin@a\u200b.example", `${"a".repeat(250)}@a.example`]) {
        expect(() => loaded.resolveTenantForUsername(username)).toThrow(expect.objectContaining({ code: "invalid_username" }));
      }
    });

    it("normalizes internationalized domains without treating canonical usernames as tenant routing", async () => {
      const loaded = await loadConfig({ TENANTS_JSON: JSON.stringify([{ ...tenantA, domains: ["b\u00fccher.example"] }]) });
      expect(loaded.resolveTenantForUsername("Reader@B\u00dcCHER.Example")).toMatchObject({
        username: "reader@xn--bcher-kva.example", tenant: { tenantId: tenantA.tenantId, domains: ["xn--bcher-kva.example"] },
      });
      expect(loaded.normalizeSignInUsername("Renamed@tenant.onmicrosoft.com")).toBe("renamed@tenant.onmicrosoft.com");
      expect(() => loaded.resolveTenantForUsername("Renamed@tenant.onmicrosoft.com"))
        .toThrow(expect.objectContaining({ code: "unknown_tenant" }));
    });

    it("normalizes tenant identifiers and domain configuration without changing credentials", async () => {
      const profile = { ...tenantA, tenantId: "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA", domains: [" A.Example "], clientSecret: "CaseSensitiveSecret" };
      const loaded = await loadConfig({ TENANTS_JSON: JSON.stringify([profile]) });
      expect(loaded.getTenantConfiguration(profile.tenantId)).toMatchObject({
        tenantId: profile.tenantId.toLowerCase(), domains: ["a.example"], clientSecret: profile.clientSecret,
      });
    });

    it("rejects ambiguous profiles and invalid configuration without exposing secrets", async () => {
      const invalid = [
        [tenantA, tenantA],
        [tenantA, { ...tenantB, domains: ["A.EXAMPLE"] }],
        [{ ...tenantA, domains: ["a.example", "A.EXAMPLE"] }],
        [{ ...tenantA, domains: [] }],
        [{ ...tenantA, domains: ["*.a.example"] }],
        [{ ...tenantA, domains: ["https://a.example"] }],
        [{ ...tenantA, domains: ["admin@a.example"] }],
        [{ ...tenantA, domains: ["a\u3002example"] }],
        [{ ...tenantA, domains: ["a\u200b.example"] }],
        [{ ...tenantA, tenantId: "not-a-guid" }],
        [{ ...tenantA, clientId: "not-a-guid" }],
        [{ ...tenantA, clientSecret: "" }],
        [{ ...tenantA, displayName: "" }],
      ];
      for (const profiles of invalid) {
        await expect(loadConfig({ TENANTS_JSON: JSON.stringify(profiles) })).rejects.toThrow();
      }
      await expect(loadConfig({ TENANTS_JSON: "{synthetic-secret" })).rejects.toThrow("TENANTS_JSON must contain a JSON array");
      await expect(loadConfig({ TENANTS_JSON: JSON.stringify(tenantA) })).rejects.toThrow("JSON array");
    });

    it("migrates legacy settings without losing the saved application credentials", async () => {
      const legacy = {
        TENANT_ID: tenantA.tenantId, CLIENT_ID: tenantA.clientId, CLIENT_SECRET: tenantA.clientSecret,
        TENANT_DOMAINS: "a.example, alias.a.example", TENANT_DISPLAY_NAME: tenantA.displayName, SESSION_SECRET: "x".repeat(32),
      };
      const loaded = await loadConfig(legacy);
      loaded.validateRuntimeConfig();
      expect(loaded.config.tenants).toEqual([tenantA]);
      expect(loaded.resolveTenantForUsername("admin@alias.a.example").tenant).toEqual(tenantA);
      const missingDomains = await loadConfig({ ...legacy, TENANT_DOMAINS: "" });
      expect(missingDomains.authConfigured).toBe(false);
      expect(missingDomains.config.tenants[0]).toMatchObject({ tenantId: tenantA.tenantId, clientId: tenantA.clientId, clientSecret: tenantA.clientSecret });
      expect(() => missingDomains.validateRuntimeConfig()).toThrow("Existing tenant credentials are retained");
      expect(() => missingDomains.resolveTenantForUsername("admin@any.example")).toThrow("accepted sign-in domains");
    });

    it("treats the registry as authoritative rather than silently reintroducing a removed legacy tenant", async () => {
      const loaded = await loadConfig({
        TENANTS_JSON: JSON.stringify([tenantB]), TENANT_ID: tenantA.tenantId, CLIENT_ID: tenantA.clientId,
        CLIENT_SECRET: tenantA.clientSecret, TENANT_DOMAINS: "a.example", SESSION_SECRET: "x".repeat(32),
      });
      loaded.validateRuntimeConfig();
      expect(loaded.config.tenants).toEqual([tenantB]);
      expect(() => loaded.resolveTenantForUsername("admin@a.example")).toThrow("not enabled");
      expect(() => loaded.getTenantConfiguration(tenantA.tenantId)).toThrow("not configured");
    });

    it("loads the protected registry file ahead of inline or legacy credentials", async () => {
      const directory = mkdtempSync(join(tmpdir(), "agent-control-tenant-config-"));
      const filename = join(directory, "tenants.json");
      try {
        writeFileSync(filename, JSON.stringify([tenantA, tenantB]), { mode: 0o600 });
        const loaded = await loadConfig({
          TENANTS_JSON_FILE: filename, TENANTS_JSON: "ignored-invalid-inline-value",
          CLIENT_SECRET_FILE: join(directory, "unused-legacy-secret"), SESSION_SECRET: "x".repeat(32),
        });
        loaded.validateRuntimeConfig();
        expect(loaded.config.tenants).toEqual([tenantA, tenantB]);
        expect(loaded.normalizeSignInUsername("ADMIN@canonical.onmicrosoft.com")).toBe("admin@canonical.onmicrosoft.com");
        expect(() => loaded.resolveTenantForUsername("ADMIN@canonical.onmicrosoft.com")).toThrow("not enabled");
      } finally { rmSync(directory, { recursive: true, force: true }); }
    });
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
    const loaded = await loadConfig({ NODE_ENV: "test", SESSION_SECRET: "x".repeat(32), BOOTSTRAP_ADMIN: "true", BOOTSTRAP_ROLES: "AgentControl.Admin", AGENT_CONTROL_ADMIN: "fixture@example.invalid" });
    loaded.validateRuntimeConfig();
    expect(loaded.config).not.toHaveProperty("roles");
    expect(JSON.stringify(loaded.config)).not.toContain("AgentControl.Admin");
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