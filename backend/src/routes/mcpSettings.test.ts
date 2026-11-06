import { EventEmitter } from "node:events";
import type { Request, Response } from "express";
import session from "express-session";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { config } from "../config.js";
import { account, browserSession, epochAuthority, tenant } from "../auth/authFoundationTestSupport.js";
import { createBrowserCredentials } from "../auth/delegatedCredentials.js";
import { browserRequestPrincipal } from "../auth/requestPrincipal.js";
import { activateAccountSession, revokeAccountSessionMutations } from "../db/sessions.js";
import type { AppRole } from "../types/capability.js";
import { parseMcpSettingsJson, type McpAccessProfile, type McpConnectionSettings } from "../types/mcpSettings.js";
import { declaredRoutePolicies } from "./policy.js";
import { createMcpSettingsRouter } from "./mcpSettings.js";

vi.mock("../db/pool.js", () => ({
  pool: {},
  secretValue: (name: string) => name === "TENANTS_JSON" ? "[]"
    : name === "SESSION_SECRET" ? "synthetic-settings-contract-session-secret" : undefined,
}));

const original = config.tenants;
const reader = vi.fn<(tenantId: string, projection: McpAccessProfile, signal?: AbortSignal) => Promise<McpConnectionSettings>>();
let router: ReturnType<typeof createMcpSettingsRouter>;
beforeEach(async () => {
  config.tenants = [tenant];
  reader.mockReset().mockResolvedValue({ state: "not_configured" });
  router = createMcpSettingsRouter(reader);
  await activateAccountSession(tenant.tenantId, account().homeAccountId, async () => {});
});
afterEach(() => {
  config.tenants = original;
});

async function invoke(roles?: AppRole[]) {
  const store = new session.MemoryStore();
  const request = Object.assign(new EventEmitter(), {
    headers: {}, rawHeaders: [], aborted: false, query: { origin: "https://attacker.invalid" },
    sessionStore: store, sessionID: "synthetic-settings-contract", get: () => undefined,
  }) as unknown as Request;
  const data = browserSession();
  if (roles) data.user!.roles = roles;
  store.createSession(request, roles ? data : { cookie: data.cookie });
  if (roles) {
    const epochs = epochAuthority();
    request.authentication = createBrowserCredentials(await browserRequestPrincipal(request.session, account(), epochs), epochs);
  }
  const response = Object.assign(new EventEmitter(), {
    destroyed: false, writableEnded: false, setHeader: vi.fn(),
    locals: { requestId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" },
  });
  const route = router.stack.find(layer => layer.route?.path === "/mcp/settings")!.route!;
  const body = await new Promise<unknown>((resolve, reject) => {
    const output = Object.assign(response, {
      json: (value: unknown) => { response.writableEnded = true; resolve(value); },
    }) as unknown as Response;
    let index = 0;
    const next = (error?: unknown) => {
      if (error) { reject(error); return; }
      const layer = route.stack[index++];
      if (!layer) { reject(new Error("Settings route completed without a response.")); return; }
      try { Promise.resolve(layer.handle(request, output, next)).catch(reject); }
      catch (failure) { reject(failure); }
    };
    next();
  });
  return { body, response };
}

it("declares browser-session Viewer access without a provider prerequisite", () => {
  expect(declaredRoutePolicies.get("GET /mcp/settings")).toEqual({
    access: "authenticated", browserOnly: true, dataClass: "operational_metadata", roles: ["AgentControl.Viewer"],
  });
});
it.each(["AgentControl.Viewer", "AgentControl.UsageReportUploader", "AgentControl.Admin"] as const)("allows %s through the existing hierarchy", async role => {
  const { body, response } = await invoke([role]);
  expect(response.setHeader).toHaveBeenCalledWith("Cache-Control", "no-store");
  expect(body).toEqual({ state: "not_configured", privacy: config.employeePrivacy, privacyScope: "end_user_and_preview" });
  expect(parseMcpSettingsJson(JSON.stringify(body))).toEqual(body);
  expect(reader).toHaveBeenCalledExactlyOnceWith(tenant.tenantId, {
    audience: role === "AgentControl.Admin" ? "admin" : "adoption",
    operations: [], staffPreviewAuthorized: true, privacy: config.employeePrivacy,
  }, expect.any(AbortSignal));
});
it("denies unauthenticated and roleless requests", async () => {
  await expect(invoke()).rejects.toMatchObject({ status: 401 });
  await expect(invoke([])).rejects.toMatchObject({ status: 403 });
  expect(reader).not.toHaveBeenCalled();
});
it("withholds metadata after initiating session revocation", async () => {
  reader.mockImplementationOnce(async () => {
    await revokeAccountSessionMutations(tenant.tenantId, account().homeAccountId, async () => {});
    return { state: "not_configured" };
  });
  await expect(invoke(["AgentControl.Viewer"])).rejects.toMatchObject({ status: 401 });
});
