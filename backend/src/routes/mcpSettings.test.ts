import express from "express";
import session from "express-session";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { config } from "../config.js";
import { errorHandler } from "../errors.js";
import { browserFixtureCookie, browserSession, tenant } from "../auth/authFoundationTestSupport.js";
import { activateAccountSession, revokeAccountSessionMutations } from "../db/sessions.js";
import { declaredRoutePolicies } from "./policy.js";
import { createMcpSettingsRouter } from "./mcpSettings.js";

const original = config.tenants;
const store = new session.MemoryStore();
const secret = "synthetic-metadata-browser-secret-32-bytes";
const reader = vi.fn(async (_tenant: string, _signal?: AbortSignal) => ({ state: "not_configured" as const }));
let server: Server, origin: string;
beforeAll(async () => {
  config.tenants = [tenant];
  const app = express();
  app.use(session({ name: "agent-control.sid", secret, store, resave: false, saveUninitialized: false }));
  app.use(createMcpSettingsRouter(reader));
  app.use(errorHandler);
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  config.tenants = original;
  await new Promise<void>(resolve => server.close(() => resolve()));
});
it("declares browser-session Viewer access without a provider prerequisite", () => {
  expect(declaredRoutePolicies.get("GET /mcp/settings")).toEqual({
    access: "authenticated", browserOnly: true, dataClass: "operational_metadata", roles: ["AgentControl.Viewer"],
  });
});
it.each(["AgentControl.Viewer", "AgentControl.UsageReportUploader", "AgentControl.Admin"] as const)("allows %s through the existing hierarchy", async role => {
  const data = browserSession();
  data.user!.roles = [role];
  await activateAccountSession(tenant.tenantId, data.accountId!, async () => {});
  const cookie = await browserFixtureCookie(store, secret, data, role);
  const response = await fetch(origin + "/mcp/settings?origin=https://attacker.invalid", { headers: { Cookie: cookie } });
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({ state: "not_configured" });
  expect(reader).toHaveBeenLastCalledWith(tenant.tenantId, expect.any(AbortSignal));
});
it("denies unauthenticated and roleless requests", async () => {
  expect((await fetch(origin + "/mcp/settings")).status).toBe(401);
  const data = browserSession();
  data.user!.roles = [];
  const cookie = await browserFixtureCookie(store, secret, data, "roleless");
  expect((await fetch(origin + "/mcp/settings", { headers: { Cookie: cookie } })).status).toBe(403);
});
it("withholds metadata after initiating session revocation", async () => {
  const data = browserSession();
  await activateAccountSession(tenant.tenantId, data.accountId!, async () => {});
  const cookie = await browserFixtureCookie(store, secret, data, "revoked");
  reader.mockImplementationOnce(async () => {
    await revokeAccountSessionMutations(tenant.tenantId, data.accountId!, async () => {});
    return { state: "not_configured" };
  });
  expect((await fetch(origin + "/mcp/settings", { headers: { Cookie: cookie } })).status).toBe(401);
});
