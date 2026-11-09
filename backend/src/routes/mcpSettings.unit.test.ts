import { EventEmitter } from "node:events";
import type { Request, RequestHandler, Response } from "express";
import session from "express-session";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { config } from "../config.js";
import { account, browserSession, epochAuthority, tenant } from "../auth/authFoundationTestSupport.js";
import { withAuthority } from "../auth/authorityContext.js";
import { createBrowserCredentials } from "../auth/delegatedCredentials.js";
import { browserRequestPrincipal } from "../auth/requestPrincipal.js";
import { activateAccountSession, revokeAccountSessionMutations } from "../db/sessions.js";
import type { McpAccessProfile, McpConnectionSettings as McpSettings } from "../types/mcpSettings.js";
import { createMcpSettingsRouter } from "./mcpSettings.js";

const mocks = vi.hoisted(() => ({ handler: undefined as RequestHandler | undefined,
  discovery: undefined as RequestHandler | undefined, discoveryPolicy: undefined as unknown }));
vi.mock("../services/mcpAccess.js", () => ({
  mcpAccessProfile: () => ({ audience: "adoption", operations: [], staffPreviewAuthorized: true,
    privacy: { hide_employee_details: false, hide_champion_employee: false } }),
}));
vi.mock("./policy.js", () => ({
  policyRoute: (_router: unknown, _method: string, path: string, policy: unknown, handler: RequestHandler) => {
    if (path === "/discovery/connection") { mocks.discovery = handler; mocks.discoveryPolicy = policy; }
    else mocks.handler = handler;
  },
}));
vi.mock("../db/pool.js", () => ({
  pool: {},
  secretValue: (name: string) => name === "TENANTS_JSON" ? "[]"
    : name === "SESSION_SECRET" ? "synthetic-settings-unit-session-secret" : undefined,
}));

const originalTenants = config.tenants;
const settings: McpSettings = { state: "not_configured" };
const reader = vi.fn<(tenantId: string, projection: McpAccessProfile, signal?: AbortSignal) => Promise<McpSettings>>();
const published = { ...settings, privacy: { hide_employee_details: false, hide_champion_employee: false }, privacyScope: "end_user_and_preview" };

beforeEach(async () => {
  config.tenants = [tenant];
  reader.mockReset().mockResolvedValue(settings);
  const data = browserSession();
  await activateAccountSession(tenant.tenantId, data.accountId!, async () => {});
  createMcpSettingsRouter(reader);
});
afterEach(() => { config.tenants = originalTenants; });

function transport() {
  const request = Object.assign(new EventEmitter(), {
    headers: {}, aborted: false, query: { origin: "https://attacker.invalid" },
  });
  new session.MemoryStore().createSession(request as unknown as Request, browserSession());
  const response = Object.assign(new EventEmitter(), {
    destroyed: false, writableEnded: false, setHeader: vi.fn(), json: vi.fn(),
  });
  const run = async () => {
    if (!mocks.handler) throw new Error("Settings handler was not registered.");
    await mocks.handler(request as unknown as Request, response as unknown as Response, error => { if (error) throw error; });
  };
  const expectCleanup = () => {
    expect(request.listenerCount("aborted")).toBe(0);
    expect(response.listenerCount("close")).toBe(0);
  };
  return { request, response, run, expectCleanup };
}

describe("MCP settings request lifecycle without sockets", () => {
  it("registers a browser-only employee connection read with no role/catalog or metadata access", async () => {
    expect(mocks.discoveryPolicy).toEqual({ access: "authenticated", browserOnly: true, dataClass: "employee_discovery" });
    const { request, response } = transport();
    (request as unknown as Request).session.user!.roles = [];
    await mocks.discovery!(request as unknown as Request, response as unknown as Response, error => { if (error) throw error; });
    expect(response.json).toHaveBeenCalledWith({ state: "not_configured" });
    expect(response.setHeader).toHaveBeenCalledWith("Cache-Control", "no-store");
    expect(reader).not.toHaveBeenCalled();
  });
  it("uses only the initiating tenant, disables caching, and removes listeners on success", async () => {
    const { response, run, expectCleanup } = transport();
    await run();
    expect(reader).toHaveBeenCalledExactlyOnceWith(tenant.tenantId, expect.objectContaining({ audience: "adoption" }), expect.any(AbortSignal));
    expect(response.setHeader).toHaveBeenCalledWith("Cache-Control", "no-store");
    expect(response.json).toHaveBeenCalledWith(published);
    expectCleanup();
  });

  it.each(["request-aborted", "response-destroyed", "response-ended"])("does not start a read after %s before handler entry", async state => {
    const { request, response, run, expectCleanup } = transport();
    if (state === "request-aborted") request.aborted = true;
    else if (state === "response-destroyed") response.destroyed = true;
    else response.writableEnded = true;
    await expect(run()).rejects.toMatchObject({ name: "AbortError" });
    expect(reader).not.toHaveBeenCalled();
    expect(response.json).not.toHaveBeenCalled();
    expectCleanup();
  });

  it.each(["aborted", "close"])("cancels the reader and withholds late results on %s", async event => {
    const { request, response, run, expectCleanup } = transport();
    const pending = Promise.withResolvers<McpSettings>();
    reader.mockReturnValueOnce(pending.promise);
    const operation = run();
    const signal = reader.mock.calls[0][2]!;
    if (event === "aborted") request.emit(event);
    else response.emit(event);
    expect(signal.aborted).toBe(true);
    const rejected = expect(operation).rejects.toMatchObject({ name: "AbortError" });
    pending.resolve(settings);
    await rejected;
    expect(response.json).not.toHaveBeenCalled();
    expectCleanup();
  });

  it("propagates read failures and removes listeners", async () => {
    const { response, run, expectCleanup } = transport();
    const failure = new Error("Synthetic metadata read failure.");
    reader.mockRejectedValueOnce(failure);
    await expect(run()).rejects.toBe(failure);
    expect(response.json).not.toHaveBeenCalled();
    expectCleanup();
  });

  it("does not abort when the response closes after successful publication", async () => {
    const { response, run, expectCleanup } = transport();
    response.json.mockImplementationOnce(() => {
      response.writableEnded = true;
      response.emit("close");
    });
    await run();
    expect(reader.mock.calls[0][2]!.aborted).toBe(false);
    expectCleanup();
  });

  it.each([false, true])("rechecks bound browser authority before publication (revoked: %s)", async revoked => {
    const { request, response, run, expectCleanup } = transport();
    const browserRequest = request as unknown as Request;
    const epochs = epochAuthority();
    const source = createBrowserCredentials(await browserRequestPrincipal(browserRequest.session, account(), epochs), epochs);
    browserRequest.authentication = source;
    const acquire = vi.spyOn(source, "acquire");
    const revalidate = vi.spyOn(source, "revalidate");
    const pending = Promise.withResolvers<McpSettings>();
    reader.mockReturnValueOnce(pending.promise);
    const operation = withAuthority(source, run);
    if (revoked) {
      const rejected = expect(operation).rejects.toMatchObject({ status: 401 });
      source.revoke();
      pending.resolve(settings);
      await rejected;
      expect(response.json).not.toHaveBeenCalled();
    } else {
      pending.resolve(settings);
      await operation;
      expect(response.json).toHaveBeenCalledWith(published);
    }
    expect(acquire).not.toHaveBeenCalled();
    expect(revalidate).not.toHaveBeenCalled();
    expectCleanup();
  });

  it.each(["revoked", "superseded", "role-removed", "identity-replaced"])("withholds metadata when the session is %s during a read", async change => {
    const { request, response, run, expectCleanup } = transport();
    const pending = Promise.withResolvers<McpSettings>();
    reader.mockReturnValueOnce(pending.promise);
    const operation = run();
    const rejected = expect(operation).rejects.toMatchObject({ status: 401 });
    const browserRequest = request as unknown as Request;
    const accountId = browserRequest.session.accountId!;
    if (change === "revoked" || change === "superseded") {
      await revokeAccountSessionMutations(tenant.tenantId, accountId, async () => {});
      if (change === "superseded") await activateAccountSession(tenant.tenantId, accountId, async () => {});
    } else if (change === "role-removed") browserRequest.session.user!.roles = [];
    else {
      browserRequest.session.accountId = "replacement-account";
      browserRequest.session.user = { ...browserRequest.session.user!, homeAccountId: "replacement-account" };
    }
    pending.resolve(settings);
    await rejected;
    expect(response.json).not.toHaveBeenCalled();
    expectCleanup();
  });
});
