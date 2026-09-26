import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { config, type TenantConfiguration } from "../config.js";
import { createAuthFlow } from "./msal.js";
import { authFlowLifetimeMs, clearAuthFlowsForTest, consumeAuthFlow, storeAuthFlow } from "./flows.js";

const { tenant, otherTenant } = vi.hoisted(() => {
  const tenant: TenantConfiguration = {
    tenantId: "11111111-1111-1111-1111-111111111111", clientId: "22222222-2222-2222-2222-222222222222",
    clientSecret: "flow-fixture", domains: ["example.invalid"], displayName: "Flow tenant",
  };
  const otherTenant: TenantConfiguration = {
    tenantId: "99999999-9999-9999-9999-999999999999", clientId: "88888888-8888-8888-8888-888888888888",
    clientSecret: "other-flow-fixture", domains: ["other.invalid"], displayName: "Other flow tenant",
  };
  delete process.env.TENANTS_JSON_FILE;
  process.env.TENANTS_JSON = JSON.stringify([tenant, otherTenant]);
  return { tenant, otherTenant };
});
const login = { tenantId: tenant.tenantId, username: "fixture@example.invalid" };
const originalTenants = config.tenants;
beforeEach(() => { config.tenants = [tenant, otherTenant]; });
afterEach(() => { clearAuthFlowsForTest(); config.tenants = originalTenants; });

describe("ephemeral authorization flows", () => {
  it("binds a flow to one session and consumes it atomically", () => {
    const flow = createAuthFlow("login", login);
    const handle = storeAuthFlow("session-a", undefined, flow);
    expect(consumeAuthFlow("session-a", handle, flow.state)).toBe(flow);
    expect(() => consumeAuthFlow("session-a", handle, flow.state)).toThrow("did not match");
  });

  it("consumes a transaction after a session or state mismatch", () => {
    const flow = createAuthFlow("login", login);
    const handle = storeAuthFlow("session-a", undefined, flow);
    expect(() => consumeAuthFlow("session-b", handle, flow.state)).toThrow("did not match");
    expect(() => consumeAuthFlow("session-a", handle, flow.state)).toThrow("did not match");
  });

  it.each([undefined, "wrong-state"])("consumes the transaction after an invalid callback state: %s", state => {
    const flow = createAuthFlow("login", login);
    const handle = storeAuthFlow("session-a", undefined, flow);
    expect(() => consumeAuthFlow("session-a", handle, state)).toThrow("did not match");
    expect(() => consumeAuthFlow("session-a", handle, flow.state)).toThrow("did not match");
  });

  it("expires flows after ten minutes", () => {
    const now = Date.now();
    const flow = { ...createAuthFlow("login", login), createdAt: now };
    const handle = storeAuthFlow("session-a", undefined, flow, now);
    expect(() => consumeAuthFlow("session-a", handle, flow.state, now + authFlowLifetimeMs + 1)).toThrow("expired");
  });

  it("replaces a session's prior transaction", () => {
    const first = createAuthFlow("login", login);
    const firstHandle = storeAuthFlow("session-a", undefined, first);
    const second = createAuthFlow("login", login);
    const secondHandle = storeAuthFlow("session-a", firstHandle, second);
    expect(() => consumeAuthFlow("session-a", firstHandle, first.state)).toThrow("did not match");
    expect(consumeAuthFlow("session-a", secondHandle, second.state)).toBe(second);
  });

  it("refuses to store a permission flow without replacing a legitimate pending login", () => {
    const flow = createAuthFlow("login", login);
    const handle = storeAuthFlow("session-a", undefined, flow);
    const legacy = createAuthFlow("login", login);
    Object.assign(legacy, { kind: "consent" });
    expect(() => storeAuthFlow("session-a", handle, legacy)).toThrow("Permissions cannot be requested or enabled");
    expect(consumeAuthFlow("session-a", handle, flow.state)).toBe(flow);
  });

  it.each([{ kind: "consent" }, { extraScopesToConsent: ["https://graph.microsoft.com/AgentIdentity.Read.All"] }])(
    "consumes and rejects an old pending permission flow instead of treating it as login: %j", change => {
      const flow = createAuthFlow("login", login);
      const handle = storeAuthFlow("session-a", undefined, flow);
      Object.assign(flow, change);
      expect(() => consumeAuthFlow("session-a", handle, flow.state)).toThrow("Permissions cannot be requested or enabled");
      expect(() => consumeAuthFlow("session-a", handle, flow.state)).toThrow("did not match");
    },
  );

  it.each([
    { clientId: otherTenant.clientId }, { clientSecret: "rotated" }, { domains: ["changed.invalid"] },
  ])("invalidates only flows for a changed tenant configuration: %j", change => {
    const first = createAuthFlow("login", login);
    const second = createAuthFlow("login", { tenantId: otherTenant.tenantId, username: "fixture@other.invalid" });
    const firstHandle = storeAuthFlow("session-a", undefined, first);
    const secondHandle = storeAuthFlow("session-b", undefined, second);
    config.tenants = [{ ...tenant, ...change }, otherTenant];
    expect(() => consumeAuthFlow("session-a", firstHandle, first.state)).toThrow("configuration changed");
    expect(() => consumeAuthFlow("session-a", firstHandle, first.state)).toThrow("did not match");
    expect(consumeAuthFlow("session-b", secondHandle, second.state)).toBe(second);
  });

  it("rejects a removed configured tenant without falling back to another one", () => {
    const flow = createAuthFlow("login", login);
    const handle = storeAuthFlow("session-a", undefined, flow);
    config.tenants = [otherTenant];
    expect(() => consumeAuthFlow("session-a", handle, flow.state)).toThrow("configuration changed");
  });

  it.each([
    { tenantId: otherTenant.tenantId }, { clientId: otherTenant.clientId }, { username: "another@example.invalid" },
    { returnTo: "https://untrusted.invalid" }, { nonce: "n".repeat(43) }, { codeVerifier: "v".repeat(43) },
  ])("rejects tampering with a stored transaction binding: %j", change => {
    const flow = createAuthFlow("login", login);
    const handle = storeAuthFlow("session-a", undefined, flow);
    Object.assign(flow, change);
    expect(() => consumeAuthFlow("session-a", handle, flow.state)).toThrow(expect.objectContaining({ code: "invalid_auth_state" }));
    expect(() => consumeAuthFlow("session-a", handle, flow.state)).toThrow("did not match");
  });

  it("reports malformed stored email hints as invalid authentication state", () => {
    const flow = createAuthFlow("login", login);
    const handle = storeAuthFlow("session-a", undefined, flow);
    flow.username = "not-an-email";
    expect(() => consumeAuthFlow("session-a", handle, flow.state)).toThrow(expect.objectContaining({ code: "invalid_auth_state" }));
    expect(() => consumeAuthFlow("session-a", handle, flow.state)).toThrow("did not match");
  });

  it("rejects flows at the lifetime boundary and with future creation times", () => {
    const now = Date.now();
    for (const createdAt of [now - authFlowLifetimeMs, now + 1]) {
      const flow = { ...createAuthFlow("login", login), createdAt };
      const handle = storeAuthFlow("session-a", undefined, flow, createdAt);
      expect(() => consumeAuthFlow("session-a", handle, flow.state, now)).toThrow("expired");
    }
  });
});