import { afterEach, describe, expect, it } from "vitest";
import { createAuthFlow } from "./msal.js";
import { authFlowLifetimeMs, clearAuthFlowsForTest, consumeAuthFlow, storeAuthFlow } from "./flows.js";

afterEach(() => clearAuthFlowsForTest());

describe("ephemeral authorization flows", () => {
  it("binds a flow to one session and consumes it atomically", () => {
    const flow = createAuthFlow("login");
    const handle = storeAuthFlow("session-a", undefined, flow);
    expect(consumeAuthFlow("session-a", handle, flow.state)).toBe(flow);
    expect(() => consumeAuthFlow("session-a", handle, flow.state)).toThrow("did not match");
  });

  it("consumes a transaction after a session or state mismatch", () => {
    const flow = createAuthFlow("login");
    const handle = storeAuthFlow("session-a", undefined, flow);
    expect(() => consumeAuthFlow("session-b", handle, flow.state)).toThrow("did not match");
    expect(() => consumeAuthFlow("session-a", handle, flow.state)).toThrow("did not match");
  });

  it("expires flows after ten minutes", () => {
    const now = Date.now();
    const flow = { ...createAuthFlow("login"), createdAt: now };
    const handle = storeAuthFlow("session-a", undefined, flow, now);
    expect(() => consumeAuthFlow("session-a", handle, flow.state, now + authFlowLifetimeMs + 1)).toThrow("expired");
  });

  it("replaces a session's prior transaction", () => {
    const first = createAuthFlow("login");
    const firstHandle = storeAuthFlow("session-a", undefined, first);
    const second = createAuthFlow("login");
    const secondHandle = storeAuthFlow("session-a", firstHandle, second);
    expect(() => consumeAuthFlow("session-a", firstHandle, first.state)).toThrow("did not match");
    expect(consumeAuthFlow("session-a", secondHandle, second.state)).toBe(second);
  });

  it("refuses to store a permission flow without replacing a legitimate pending login", () => {
    const login = createAuthFlow("login");
    const handle = storeAuthFlow("session-a", undefined, login);
    const legacy = createAuthFlow("login");
    Object.assign(legacy, { kind: "consent" });
    expect(() => storeAuthFlow("session-a", handle, legacy)).toThrow("Permissions cannot be requested or enabled");
    expect(consumeAuthFlow("session-a", handle, login.state)).toBe(login);
  });

  it.each([{ kind: "consent" }, { extraScopesToConsent: ["https://graph.microsoft.com/AgentIdentity.Read.All"] }])(
    "consumes and rejects an old pending permission flow instead of treating it as login: %j", change => {
      const flow = createAuthFlow("login");
      const handle = storeAuthFlow("session-a", undefined, flow);
      Object.assign(flow, change);
      expect(() => consumeAuthFlow("session-a", handle, flow.state)).toThrow("Permissions cannot be requested or enabled");
      expect(() => consumeAuthFlow("session-a", handle, flow.state)).toThrow("did not match");
    },
  );
});