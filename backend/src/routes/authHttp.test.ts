import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import type { SessionData } from "express-session";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as flows from "../auth/flows.js";
import * as msal from "../auth/msal.js";
import { AppError, errorHandler } from "../errors.js";
import type { AuthenticatedUser } from "../types/session.js";
import { authRouter } from "./auth.js";

vi.mock("../middleware/auth.js", async original => {
  const actual = await original<typeof import("../middleware/auth.js")>();
  const requireSession: express.RequestHandler = (request, _response, next) =>
    request.session.user ? next() : next(AppError.unauthorized());
  return { ...actual, requireSession };
});

const user: AuthenticatedUser = {
  tenantId: "tenant-a", homeAccountId: "viewer-a", roles: ["AgentControl.Viewer"], displayName: "Viewer", username: "viewer@example.invalid",
};
let sessionState: Partial<SessionData> & { save: (callback: () => void) => void };
let server: Server;
let origin: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => {
    sessionState.user = request.get("x-test-user") === "anonymous" ? undefined
      : { ...user, roles: request.get("x-test-user") === "unassigned" ? [] : user.roles };
    request.sessionID = "auth-http-session";
    request.session = sessionState as never;
    next();
  });
  app.use("/api", authRouter);
  app.use(errorHandler);
  server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
beforeEach(() => {
  sessionState = { user, accountId: user.homeAccountId, tenantId: user.tenantId, csrfToken: "test-csrf", save: callback => callback() };
  vi.spyOn(msal, "createAuthorizationUrl").mockResolvedValue("https://login.microsoftonline.com/synthetic");
  vi.spyOn(msal, "redeemAuthorizationCode").mockRejectedValue(new Error("Unexpected authorization code redemption."));
  vi.spyOn(flows, "storeAuthFlow");
});
afterEach(() => { vi.restoreAllMocks(); flows.clearAuthFlowsForTest(); });
afterAll(async () => { server?.closeAllConnections(); await new Promise<void>(resolve => server?.close(() => resolve())); });

function consent(capabilityId = "graph.agentIdentity.read", headers = {}) {
  return fetch(`${origin}/api/auth/consent`, {
    method: "POST", headers: { "content-type": "application/json", "x-csrf-token": "test-csrf", ...headers },
    body: JSON.stringify({ capabilityId, returnTo: "/agents" }),
  });
}

describe("administrator-managed API permission policy", () => {
  it("retains authentication, Viewer and CSRF protection on the retired endpoint", async () => {
    expect((await consent(undefined, { "x-test-user": "anonymous" })).status).toBe(401);
    expect((await consent(undefined, { "x-test-user": "unassigned" })).status).toBe(403);
    expect((await consent(undefined, { "x-csrf-token": "wrong" })).status).toBe(403);
    expect(flows.storeAuthFlow).not.toHaveBeenCalled();
    expect(msal.createAuthorizationUrl).not.toHaveBeenCalled();
  });

  it.each(["graph.agentIdentity.read", "graph.package.read.delegated", "defender.hunting.application", "unknown"])(
    "returns 410 for %s without creating a flow or disturbing a pending normal login", async capabilityId => {
      const login = msal.createAuthFlow("login");
      const handle = flows.storeAuthFlow("auth-http-session", undefined, login);
      sessionState.authFlowHandle = handle;
      vi.mocked(flows.storeAuthFlow).mockClear();
      const response = await consent(capabilityId);
      expect(response.status).toBe(410);
      const body = await response.json();
      expect(body).toMatchObject({ code: "admin_managed_permissions", detail: expect.stringContaining("Grant admin consent") });
      expect(body).not.toHaveProperty("authorizationUrl");
      expect(sessionState.authFlowHandle).toBe(handle);
      expect(flows.consumeAuthFlow("auth-http-session", handle, login.state)).toBe(login);
      expect(flows.storeAuthFlow).not.toHaveBeenCalled();
      expect(msal.createAuthorizationUrl).not.toHaveBeenCalled();
      expect(msal.redeemAuthorizationCode).not.toHaveBeenCalled();
    },
  );

  it("preserves normal sign-in and ignores caller-supplied API scope selectors", async () => {
    const response = await fetch(`${origin}/api/auth/login?returnTo=%2Fagents&scope=https%3A%2F%2Fgraph.microsoft.com%2FAgentIdentity.Read.All`, { redirect: "manual" });
    expect(response.status).toBe(302);
    expect(msal.createAuthorizationUrl).toHaveBeenCalledWith(expect.objectContaining({
      kind: "login", scopes: ["openid", "profile", "offline_access"], returnTo: "/agents",
    }));
    expect(msal.redeemAuthorizationCode).not.toHaveBeenCalled();
  });

  it.each(["code=legacy", "error=access_denied"])("rejects old pending consent callbacks before redemption or redirect: %s", async suffix => {
    const legacy = msal.createAuthFlow("login");
    sessionState.authFlowHandle = flows.storeAuthFlow("auth-http-session", undefined, legacy);
    Object.assign(legacy, { kind: "consent" });
    const response = await fetch(`${origin}/api/auth/callback?state=${legacy.state}&${suffix}`, { redirect: "manual" });
    expect(response.status).toBe(410);
    expect(await response.json()).toMatchObject({ code: "admin_managed_permissions" });
    expect(sessionState.authFlowHandle).toBeUndefined();
    expect(msal.redeemAuthorizationCode).not.toHaveBeenCalled();
    expect(response.headers.get("location")).toBeNull();
    expect((await fetch(`${origin}/api/auth/callback?state=${legacy.state}&${suffix}`, { redirect: "manual" })).status).toBe(400);
  });

  it("distinguishes provider-reported missing grants from MFA during normal sign-in", async () => {
    for (const [error, status] of [["consent_required", 403], ["interaction_required", 302]] as const) {
      const login = msal.createAuthFlow("login", { returnTo: "/agents" });
      sessionState.authFlowHandle = flows.storeAuthFlow("auth-http-session", undefined, login);
      const response = await fetch(`${origin}/api/auth/callback?state=${login.state}&error=${error}`, { redirect: "manual" });
      expect(response.status).toBe(status);
      if (status === 403) expect(await response.json()).toMatchObject({ code: "missing_permission", detail: expect.stringContaining("Grant admin consent") });
      else expect(response.headers.get("location")).toBe("/agents?view=permissions&authorization=interaction_required");
      expect(msal.redeemAuthorizationCode).not.toHaveBeenCalled();
    }
  });
});
