import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import type { SessionData } from "express-session";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as flows from "../auth/flows.js";
import * as msal from "../auth/msal.js";
import { config, type TenantConfiguration } from "../config.js";
import * as sessions from "../db/sessions.js";
import { errorHandler } from "../errors.js";
import { capabilities } from "../services/capabilities.js";
import * as bulkJobs from "../services/bulkJobs.js";
import * as quarantineJobs from "../services/copilotStudioQuarantineJobs.js";
import { dataSync } from "../services/dataSync.js";
import { defenderHunting } from "../services/defenderHunting.js";
import { packageInventory } from "../services/packageInventory.js";
import { powerPlatformInventory } from "../services/powerPlatformInventory.js";
import { purviewAudit } from "../services/purviewAudit.js";
import type { AuthenticatedUser } from "../types/session.js";
import { authRouter } from "./auth.js";

const { tenant, otherTenant } = vi.hoisted(() => {
  const tenant: TenantConfiguration = {
    tenantId: "11111111-1111-1111-1111-111111111111", clientId: "22222222-2222-2222-2222-222222222222",
    clientSecret: "fixture", domains: ["example.invalid"], displayName: "First tenant",
  };
  const otherTenant: TenantConfiguration = {
    tenantId: "99999999-9999-9999-9999-999999999999", clientId: "88888888-8888-8888-8888-888888888888",
    clientSecret: "other-fixture", domains: ["other.invalid"], displayName: "Second tenant",
  };
  delete process.env.TENANTS_JSON_FILE;
  process.env.TENANTS_JSON = JSON.stringify([tenant, otherTenant]);
  return { tenant, otherTenant };
});

const originalTenants = config.tenants;
const user: AuthenticatedUser = {
  tenantId: tenant.tenantId, homeAccountId: "viewer-a", roles: ["AgentControl.Viewer"], displayName: "Viewer", username: "viewer@example.invalid",
};
type TestSession = Partial<SessionData> & {
  save: ReturnType<typeof vi.fn>;
  reload: ReturnType<typeof vi.fn>;
  regenerate: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
};
let sessionState: TestSession;
let sessionId: string;
let server: Server;
let origin: string;

function makeSession(selected?: TenantConfiguration): TestSession {
  return {
    ...(selected ? {
      user: { ...user, tenantId: selected.tenantId, username: `viewer@${selected.domains[0]}` },
      accountId: user.homeAccountId, tenantId: selected.tenantId, clientId: selected.clientId, csrfToken: "test-csrf", rolesValidatedAt: Date.now(),
    } : {}),
    save: vi.fn(callback => callback()), reload: vi.fn(callback => callback()),
    regenerate: vi.fn(callback => callback()), destroy: vi.fn(callback => callback()),
  };
}

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => {
    if (request.get("x-test-user") === "anonymous") sessionState = makeSession();
    if (request.get("x-test-user") === "unassigned") sessionState.user = { ...user, roles: [] };
    request.sessionID = sessionId;
    request.session = sessionState as never;
    sessionState.regenerate = vi.fn(callback => {
      sessionState = makeSession();
      request.session = sessionState as never;
      request.sessionID = sessionId = "regenerated-session";
      callback();
    });
    sessionState.destroy = vi.fn(callback => {
      sessionState = makeSession();
      request.session = sessionState as never;
      callback();
    });
    next();
  });
  app.use("/api", authRouter);
  app.use(errorHandler);
  server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
beforeEach(async () => {
  config.tenants = [tenant, otherTenant];
  sessionId = "auth-http-session";
  sessionState = makeSession(tenant);
  vi.spyOn(msal, "createAuthorizationUrl").mockImplementation(async flow => `https://login.microsoftonline.com/${flow.tenantId}/oauth2/v2.0/authorize?login_hint=${encodeURIComponent(flow.username)}`);
  vi.spyOn(msal, "redeemAuthorizationCode").mockRejectedValue(new Error("Unexpected authorization code redemption."));
  vi.spyOn(msal, "evictAccount").mockResolvedValue(undefined);
  vi.spyOn(msal, "revalidateAuthenticatedUser").mockRejectedValue(new Error("Unexpected revalidation."));
  vi.spyOn(flows, "storeAuthFlow");
  vi.spyOn(sessions, "revokeAccountSessions").mockResolvedValue(undefined);
  vi.spyOn(capabilities, "invalidatePrincipal").mockResolvedValue(undefined);
  vi.spyOn(bulkJobs, "pauseBulkJobsForPrincipal").mockResolvedValue(undefined);
  vi.spyOn(quarantineJobs, "pauseCopilotStudioQuarantineForPrincipal").mockResolvedValue(undefined);
  for (const service of [dataSync, defenderHunting, packageInventory, powerPlatformInventory, purviewAudit]) {
    vi.spyOn(service, "waitForPrincipalAuthorization").mockResolvedValue(undefined);
  }
  await Promise.all([tenant, otherTenant].map(value => sessions.activateAccountSession(value.tenantId, user.homeAccountId, async () => undefined)));
});
afterEach(() => { vi.restoreAllMocks(); flows.clearAuthFlowsForTest(); config.tenants = originalTenants; });
afterAll(async () => { server?.closeAllConnections(); await new Promise<void>(resolve => server?.close(() => resolve())); });

function consent(capabilityId = "graph.agentIdentity.read", headers = {}) {
  return fetch(`${origin}/api/auth/consent`, {
    method: "POST", headers: { "content-type": "application/json", "x-csrf-token": "test-csrf", ...headers },
    body: JSON.stringify({ capabilityId, returnTo: "/agents" }),
  });
}

function postLogin(body: unknown, anonymous = false) {
  return fetch(`${origin}/api/auth/login`, {
    method: "POST", headers: { "content-type": "application/json", ...(anonymous ? { "x-test-user": "anonymous" } : {}) },
    body: JSON.stringify(body), redirect: "manual",
  });
}

function pendingFlow() {
  return vi.mocked(flows.storeAuthFlow).mock.calls.at(-1)![2];
}

function successfulRedemption(selected = tenant, username = `viewer@${selected.domains[0]}`) {
  return {
    tenantId: selected.tenantId,
    account: { homeAccountId: user.homeAccountId, tenantId: selected.tenantId, username, name: "Viewer" },
    idTokenClaims: { tid: selected.tenantId, aud: selected.clientId, preferred_username: username, roles: ["AgentControl.Viewer"] },
  } as never;
}

describe("administrator-managed API permission policy", () => {
  it("retains authentication, Viewer and CSRF protection on the retired endpoint", async () => {
    expect((await consent(undefined, { "x-test-user": "anonymous" })).status).toBe(401);
    sessionState = makeSession(tenant);
    expect((await consent(undefined, { "x-test-user": "unassigned" })).status).toBe(403);
    sessionState = makeSession(tenant);
    const badCsrf = await consent(undefined, { "x-csrf-token": "wrong" });
    expect(badCsrf.status).toBe(403);
    expect(await badCsrf.json()).toMatchObject({ code: "invalid_csrf" });
    expect(flows.storeAuthFlow).not.toHaveBeenCalled();
    expect(msal.createAuthorizationUrl).not.toHaveBeenCalled();
  });

  it.each(["graph.agentIdentity.read", "graph.package.read.delegated", "defender.hunting.application", "unknown"])(
    "returns 410 for %s without creating a flow or disturbing a pending normal login", async capabilityId => {
      const login = msal.createAuthFlow("login", { tenantId: tenant.tenantId, username: user.username });
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
      kind: "login", tenantId: tenant.tenantId, clientId: tenant.clientId, username: user.username,
      scopes: ["openid", "profile", "offline_access"], returnTo: "/agents",
    }));
    expect(msal.redeemAuthorizationCode).not.toHaveBeenCalled();
  });

  it.each(["code=legacy", "error=access_denied"])("rejects old pending consent callbacks before redemption or redirect: %s", async suffix => {
    const legacy = msal.createAuthFlow("login", { tenantId: tenant.tenantId, username: user.username });
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
      const login = msal.createAuthFlow("login", { tenantId: tenant.tenantId, username: user.username, returnTo: "/agents" });
      sessionState.authFlowHandle = flows.storeAuthFlow("auth-http-session", undefined, login);
      const response = await fetch(`${origin}/api/auth/callback?state=${login.state}&error=${error}`, { redirect: "manual" });
      expect(response.status).toBe(status);
      if (status === 403) expect(await response.json()).toMatchObject({ code: "missing_permission", detail: expect.stringContaining("Grant admin consent") });
      else expect(response.headers.get("location")).toBe("/agents?view=permissions&authorization=interaction_required");
      expect(msal.redeemAuthorizationCode).not.toHaveBeenCalled();
    }
  });
});

describe("multi-tenant sign-in routes", () => {
  it("starts anonymous login from a normalized username and returns JSON without requiring CSRF", async () => {
    const response = await postLogin({
      username: " Viewer@OTHER.invalid ", returnTo: "/agents?filter=all",
      tenantId: tenant.tenantId, clientId: tenant.clientId, scopes: ["https://graph.microsoft.com/.default"],
    }, true);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ authorizationUrl: expect.stringContaining(`/${otherTenant.tenantId}/`) });
    expect(pendingFlow()).toMatchObject({
      tenantId: otherTenant.tenantId, clientId: otherTenant.clientId, username: "viewer@other.invalid",
      returnTo: "/agents?filter=all", scopes: ["openid", "profile", "offline_access"],
    });
    expect(sessionState.tenantId).toBeUndefined();
    expect(sessionState.clientId).toBeUndefined();
    expect(sessionState.authFlowHandle).toMatch(/^[a-zA-Z0-9_-]{43}$/);
    expect(sessionState.save).toHaveBeenCalledOnce();
  });

  it.each([
    [{ username: "person@unconfigured.invalid" }, "unknown_tenant"],
    [{ username: "person@sub.example.invalid" }, "unknown_tenant"],
    [{ username: "not-an-email" }, "invalid_username"],
    [{ username: ["viewer@example.invalid"] }, "invalid_username"],
    [{}, "invalid_username"],
    [{ username: user.username, returnTo: "//external.invalid" }, "invalid_return_url"],
    [{ username: user.username, returnTo: 12 }, "invalid_return_url"],
  ])("returns a JSON problem for invalid login input: %j", async (body, code) => {
    const response = await postLogin(body, true);
    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toContain("application/problem+json");
    expect(await response.json()).toMatchObject({ code });
    expect(msal.createAuthorizationUrl).not.toHaveBeenCalled();
    expect(flows.storeAuthFlow).not.toHaveBeenCalled();
  });

  it("does not log submitted usernames or source credentials on login failure", async () => {
    const loggers = [vi.spyOn(console, "log"), vi.spyOn(console, "warn"), vi.spyOn(console, "error")];
    for (const logger of loggers) logger.mockImplementation(() => undefined);
    await postLogin({ username: "private-person@unconfigured.invalid", clientSecret: "private-source-credential" }, true);
    const logged = JSON.stringify(loggers.flatMap(logger => logger.mock.calls));
    expect(logged).not.toContain("private-person");
    expect(logged).not.toContain("private-source-credential");
  });

  it("redirects an anonymous GET without a username to the frontend form", async () => {
    const response = await fetch(`${origin}/api/auth/login?returnTo=%2Fagents%3Ftab%3Dinventory`, {
      headers: { "x-test-user": "anonymous" }, redirect: "manual",
    });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/agents?tab=inventory");
    expect(msal.createAuthorizationUrl).not.toHaveBeenCalled();
    expect(flows.storeAuthFlow).not.toHaveBeenCalled();
  });

  it("supports username-bearing anonymous GETs but rejects an unsafe return path", async () => {
    const response = await fetch(`${origin}/api/auth/login?username=viewer%40other.invalid&returnTo=%2Fagents`, {
      headers: { "x-test-user": "anonymous" }, redirect: "manual",
    });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toContain(`/${otherTenant.tenantId}/`);
    expect(pendingFlow()).toMatchObject({ tenantId: otherTenant.tenantId, username: "viewer@other.invalid" });
    const bad = await fetch(`${origin}/api/auth/login?returnTo=https%3A%2F%2Fexternal.invalid`, {
      headers: { "x-test-user": "anonymous" }, redirect: "manual",
    });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ code: "invalid_return_url" });
  });

  it("binds reauthentication links to the validated session and ignores tenant selectors", async () => {
    sessionState = makeSession(otherTenant);
    const response = await fetch(`${origin}/api/auth/login?tenantId=${tenant.tenantId}&clientId=${tenant.clientId}`, { redirect: "manual" });
    expect(response.status).toBe(302);
    expect(pendingFlow()).toMatchObject({ tenantId: otherTenant.tenantId, clientId: otherTenant.clientId, username: "viewer@other.invalid" });
    expect(msal.revalidateAuthenticatedUser).not.toHaveBeenCalled();
    const switched = await fetch(`${origin}/api/auth/login?username=viewer%40example.invalid`, { redirect: "manual" });
    expect(switched.status).toBe(302);
    expect(pendingFlow()).toMatchObject({ tenantId: otherTenant.tenantId, clientId: otherTenant.clientId, username: "viewer@other.invalid" });
    expect(msal.createAuthorizationUrl).toHaveBeenCalledTimes(2);
  });

  it("rejects unknown anonymous GET domains despite caller-supplied tenant selectors", async () => {
    const response = await fetch(`${origin}/api/auth/login?username=canonical%40tenant.onmicrosoft.com&tenantId=${tenant.tenantId}`, {
      headers: { "x-test-user": "anonymous" }, redirect: "manual",
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "unknown_tenant" });
    expect(msal.createAuthorizationUrl).not.toHaveBeenCalled();
    expect(flows.storeAuthFlow).not.toHaveBeenCalled();
  });

  it("does not reauthenticate an old session whose client binding changed", async () => {
    sessionState.clientId = otherTenant.clientId;
    const response = await fetch(`${origin}/api/auth/login?returnTo=%2Fagents`, { redirect: "manual" });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/agents");
    expect(msal.createAuthorizationUrl).not.toHaveBeenCalled();
    expect(sessionState.user).toBeUndefined();
  });

  it("regenerates anonymous login sessions and persists the selected client identity", async () => {
    await postLogin({ username: "viewer@other.invalid", returnTo: "/agents" }, true);
    const flow = pendingFlow();
    const previousSession = sessionState;
    vi.mocked(msal.redeemAuthorizationCode).mockResolvedValue(successfulRedemption(otherTenant));
    const response = await fetch(`${origin}/api/auth/callback?code=fixture-code&state=${flow.state}`, { redirect: "manual" });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/agents");
    expect(msal.redeemAuthorizationCode).toHaveBeenCalledExactlyOnceWith("fixture-code", flow);
    expect(previousSession.regenerate).toHaveBeenCalledOnce();
    expect(sessionState).toMatchObject({
      tenantId: otherTenant.tenantId, clientId: otherTenant.clientId, accountId: user.homeAccountId,
      user: { tenantId: otherTenant.tenantId, username: "viewer@other.invalid" },
    });
    expect(sessionState.csrfToken).toMatch(/^[a-zA-Z0-9_-]{43}$/);
    expect(sessionState.authFlowHandle).toBeUndefined();
    expect(sessionState.save).toHaveBeenCalledOnce();
    expect(msal.evictAccount).not.toHaveBeenCalled();
    const replay = await fetch(`${origin}/api/auth/callback?code=fixture-code&state=${flow.state}`, { redirect: "manual" });
    expect(replay.status).toBe(400);
    expect(msal.redeemAuthorizationCode).toHaveBeenCalledOnce();
  });

  it.each(["Canonical@tenant.onmicrosoft.com", "Viewer@other.invalid"])(
    "accepts a canonical UPN and keeps reauthentication in the selected tenant: %s", async username => {
      await postLogin({ username: "Alias@EXAMPLE.invalid", returnTo: "/agents" }, true);
      const flow = pendingFlow();
      expect(flow.username).toBe("alias@example.invalid");
      vi.mocked(msal.redeemAuthorizationCode).mockResolvedValue(successfulRedemption(tenant, username));
      const callback = await fetch(`${origin}/api/auth/callback?code=fixture&state=${flow.state}`, { redirect: "manual" });
      expect(callback.status).toBe(302);
      expect(sessionState).toMatchObject({
        tenantId: tenant.tenantId, clientId: tenant.clientId, accountId: user.homeAccountId,
        user: { tenantId: tenant.tenantId, username: username.toLowerCase() },
      });
      const reauth = await fetch(`${origin}/api/auth/login?returnTo=%2Fagents`, { redirect: "manual" });
      expect(reauth.status).toBe(302);
      expect(pendingFlow()).toMatchObject({
        tenantId: tenant.tenantId, clientId: tenant.clientId, username: username.toLowerCase(), returnTo: "/agents",
      });
      const alias = await fetch(`${origin}/api/auth/login?username=another-alias%40example.invalid`, { redirect: "manual" });
      expect(alias.status).toBe(302);
      expect(pendingFlow()).toMatchObject({ tenantId: tenant.tenantId, username: username.toLowerCase() });
      const canonicalHint = await fetch(`${origin}/api/auth/login?username=${encodeURIComponent(username)}`, { redirect: "manual" });
      expect(canonicalHint.status).toBe(302);
      expect(pendingFlow()).toMatchObject({ tenantId: tenant.tenantId, clientId: tenant.clientId, username: username.toLowerCase() });
      expect(msal.evictAccount).not.toHaveBeenCalled();
    },
  );

  it("cleans up the previous exact tenant even when the new tenant shares the account ID", async () => {
    await postLogin({ username: "viewer@other.invalid", returnTo: "/agents" });
    const flow = pendingFlow();
    vi.mocked(msal.redeemAuthorizationCode).mockResolvedValue(successfulRedemption(otherTenant));
    const response = await fetch(`${origin}/api/auth/callback?code=fixture&state=${flow.state}`, { redirect: "manual" });
    expect(response.status).toBe(302);
    expect(msal.evictAccount).toHaveBeenCalledExactlyOnceWith(tenant.tenantId, user.homeAccountId);
    expect(sessions.revokeAccountSessions).toHaveBeenCalledWith(expect.anything(), tenant.tenantId, user.homeAccountId);
    const scope = { tenantId: tenant.tenantId, principalId: user.homeAccountId };
    expect(bulkJobs.pauseBulkJobsForPrincipal).toHaveBeenCalledExactlyOnceWith(scope);
    expect(quarantineJobs.pauseCopilotStudioQuarantineForPrincipal).toHaveBeenCalledExactlyOnceWith(scope);
    for (const service of [dataSync, defenderHunting, packageInventory, powerPlatformInventory, purviewAudit]) {
      expect(service.waitForPrincipalAuthorization).toHaveBeenCalledExactlyOnceWith(scope);
    }
    expect(sessionState.tenantId).toBe(otherTenant.tenantId);
  });

  it("does not evict freshly redeemed tokens when reauthenticating the same tenant and account", async () => {
    await postLogin({ username: user.username });
    const flow = pendingFlow();
    vi.mocked(msal.redeemAuthorizationCode).mockResolvedValue(successfulRedemption());
    expect((await fetch(`${origin}/api/auth/callback?code=fixture&state=${flow.state}`, { redirect: "manual" })).status).toBe(302);
    expect(msal.evictAccount).not.toHaveBeenCalled();
    expect(sessions.revokeAccountSessions).not.toHaveBeenCalled();
    expect(capabilities.invalidatePrincipal).toHaveBeenCalledWith(expect.objectContaining({ tenantId: tenant.tenantId, homeAccountId: user.homeAccountId }));
  });

  it("rejects a callback account that differs from the stored selected tenant", async () => {
    await postLogin({ username: "viewer@other.invalid" }, true);
    const flow = pendingFlow();
    const previousSession = sessionState;
    vi.mocked(msal.redeemAuthorizationCode).mockResolvedValue(successfulRedemption());
    const response = await fetch(`${origin}/api/auth/callback?code=fixture&state=${flow.state}`, { redirect: "manual" });
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: "unauthorized" });
    expect(previousSession.regenerate).not.toHaveBeenCalled();
    expect(sessionState.authFlowHandle).toBeUndefined();
  });

  it("consumes changed-configuration callbacks before redemption", async () => {
    await postLogin({ username: "viewer@other.invalid" }, true);
    const flow = pendingFlow();
    config.tenants = [tenant, { ...otherTenant, clientId: tenant.clientId }];
    const response = await fetch(`${origin}/api/auth/callback?code=fixture&state=${flow.state}`, { redirect: "manual" });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "invalid_auth_state" });
    expect(msal.redeemAuthorizationCode).not.toHaveBeenCalled();
    expect(sessionState.authFlowHandle).toBeUndefined();
  });

  it("rechecks the selected configuration before publishing a redeemed session", async () => {
    await postLogin({ username: "viewer@other.invalid" }, true);
    const flow = pendingFlow();
    const previousSession = sessionState;
    vi.mocked(msal.redeemAuthorizationCode).mockResolvedValue(successfulRedemption(otherTenant));
    vi.mocked(capabilities.invalidatePrincipal).mockImplementation(async () => {
      config.tenants = [tenant, { ...otherTenant, clientSecret: "rotated" }];
    });
    const response = await fetch(`${origin}/api/auth/callback?code=fixture&state=${flow.state}`, { redirect: "manual" });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "invalid_auth_state" });
    expect(previousSession.regenerate).not.toHaveBeenCalled();
    expect(sessionState.user).toBeUndefined();
  });

  it("logs out only the validated session tenant and ignores caller tenant parameters", async () => {
    sessionState = makeSession(otherTenant);
    const response = await fetch(`${origin}/api/auth/logout?tenantId=${tenant.tenantId}`, {
      method: "POST", headers: { "x-csrf-token": "test-csrf", "content-type": "application/json" }, body: JSON.stringify({ tenantId: tenant.tenantId }),
    });
    expect(response.status).toBe(204);
    expect(response.headers.get("set-cookie")).toContain("agent-control.sid=;");
    expect(msal.evictAccount).toHaveBeenCalledExactlyOnceWith(otherTenant.tenantId, user.homeAccountId);
    expect(sessions.revokeAccountSessions).toHaveBeenCalledWith(expect.anything(), otherTenant.tenantId, user.homeAccountId);
    expect(dataSync.waitForPrincipalAuthorization).toHaveBeenCalledExactlyOnceWith({ tenantId: otherTenant.tenantId, principalId: user.homeAccountId });
  });
});
