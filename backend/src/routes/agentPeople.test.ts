import express from "express";
import session from "express-session";
import { request as httpRequest, type Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { config } from "../config.js";
import { AppError, errorHandler } from "../errors.js";
import { unifiedAgentsRouter } from "./unifiedAgents.js";

const mocks = vi.hoisted(() => {
  process.env.TENANT_ID = "11111111-1111-4111-8111-111111111111";
  process.env.CLIENT_ID = "22222222-2222-4222-8222-222222222222";
  process.env.SESSION_SECRET = "agent-people-fixture-secret";
  return { list: vi.fn(), generation: vi.fn(), resolve: vi.fn(), project: vi.fn(), requireAvailable: vi.fn() };
});
vi.mock("../services/unifiedAgents.js", () => ({ unifiedAgents: { list: mocks.list } }));
vi.mock("../services/agentPeople.js", () => ({ agentPeople: { generation: mocks.generation, resolve: mocks.resolve } }));
vi.mock("../services/savedAgentPeople.js", () => ({ savedAgentPeople: { project: mocks.project } }));
vi.mock("../services/capabilities.js", () => ({ capabilities: { requireAvailable: mocks.requireAvailable } }));
vi.mock("../services/telemetry.js", async original => ({
  ...await original<typeof import("../services/telemetry.js")>(), operationalLog: vi.fn(),
}));
const recordId = "agent:33333333-3333-4333-8333-333333333333";
const creatorId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ownerId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const record = { id: recordId, powerPlatformResource: { createdBy: creatorId, details: { ownerId, lastModifiedBy: "non-user-id" } } };
const people = { createdBy: { objectId: creatorId, status: "not_found", displayName: null, userPrincipalName: null,
  observedAt: "2026-09-20T12:00:00.000Z" } };
let server: Server;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(session({ secret: "agent-people-fixture-secret", resave: false, saveUninitialized: false }));
  app.use((request, _response, next) => {
    const role = request.get("x-test-role");
    if (role) {
      const tenantId = request.get("x-test-tenant") ?? config.tenantId!;
      request.session.accountId = "reader";
      request.session.tenantId = tenantId;
      request.session.rolesValidatedAt = Date.now();
      request.session.csrfToken = "fixture-csrf";
      request.session.user = { tenantId, homeAccountId: "reader", username: "reader@example.invalid", displayName: "Reader",
        roles: role === "viewer" ? ["AgentControl.Viewer"] : role === "admin" ? ["AgentControl.Admin"] : [] };
    }
    next();
  });
  app.use("/api", unifiedAgentsRouter);
  app.use(errorHandler);
  server = await new Promise<Server>(resolve => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
});
beforeEach(() => {
  vi.resetAllMocks();
  mocks.generation.mockResolvedValue("initial");
  mocks.list.mockResolvedValue({ count: 1, value: [record] });
  mocks.resolve.mockResolvedValue({ changed: true, notFound: 1, resolved: 0, failed: 0 });
  mocks.project.mockResolvedValue([{ ...record, people }]);
  mocks.requireAvailable.mockResolvedValue({ authorized: true });
});
afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});

describe("persisted agent people endpoint", () => {
  it.each(["viewer", "admin"])("resolves only the saved record's exact user IDs under the %s account scope", async role => {
    expect(await request({ recordId, force: true }, { role })).toEqual({ status: 200, body: { people, changed: true } });
    const scope = { tenantId: config.tenantId, principalId: "reader" };
    expect(mocks.generation).toHaveBeenCalledWith(scope);
    expect(mocks.generation.mock.invocationCallOrder[0]).toBeLessThan(mocks.list.mock.invocationCallOrder[0]);
    expect(mocks.list).toHaveBeenCalledExactlyOnceWith(scope, { recordId, limit: 1 });
    expect(mocks.resolve).toHaveBeenCalledWith(expect.objectContaining({ tenantId: config.tenantId, homeAccountId: "reader" }),
      [creatorId, ownerId], { generation: "initial", force: true, signal: expect.any(AbortSignal) });
    expect(mocks.project).toHaveBeenCalledWith(scope, [record]);
  });

  it("rejects missing sessions, roles, CSRF, wrong tenants and unavailable capability before reading private data", async () => {
    for (const [options, status] of [
      [{ role: null }, 401], [{ role: "none" }, 403], [{ csrf: null }, 403],
      [{ tenant: "99999999-9999-4999-8999-999999999999" }, 401],
    ] as const) expect((await request({ recordId }, options)).status).toBe(status);
    mocks.requireAvailable.mockRejectedValueOnce(new AppError(403, "capability_unavailable", "Unavailable"));
    expect((await request({ recordId })).status).toBe(403);
    expect(mocks.list).not.toHaveBeenCalled();
    expect(mocks.resolve).not.toHaveBeenCalled();
  });

  it("refuses arbitrary user queries, absent records and failed saved reads without invoking Graph", async () => {
    expect((await request({ recordId, userIds: [creatorId] })).status).toBe(400);
    mocks.list.mockResolvedValueOnce({ count: 0, value: [] });
    expect((await request({ recordId })).status).toBe(404);
    mocks.list.mockRejectedValueOnce(new AppError(409, "snapshot_unavailable", "Unavailable"));
    expect((await request({ recordId })).status).toBe(409);
    expect(mocks.resolve).not.toHaveBeenCalled();
  });

  it("propagates reset conflicts rather than returning stale people", async () => {
    mocks.resolve.mockRejectedValueOnce(new AppError(409, "dataset_invalidated", "Saved data was cleared"));
    expect(await request({ recordId })).toMatchObject({ status: 409, body: { code: "dataset_invalidated" } });
    expect(mocks.project).not.toHaveBeenCalled();
  });
});

function request(body: unknown, options: { role?: string | null; csrf?: string | null; tenant?: string } = {}):
Promise<{ status: number; body: unknown }> {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture address");
  const role = options.role === undefined ? "viewer" : options.role;
  const csrf = options.csrf === undefined ? "fixture-csrf" : options.csrf;
  const json = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      host: "127.0.0.1", port: address.port, method: "POST", path: "/api/agent-inventory/people/resolve",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(json),
        ...(role ? { "x-test-role": role } : {}), ...(csrf ? { "x-csrf-token": csrf } : {}),
        ...(options.tenant ? { "x-test-tenant": options.tenant } : {}) },
    }, response => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", chunk => { text += chunk; });
      response.on("end", () => resolve({ status: response.statusCode!, body: JSON.parse(text) }));
    });
    request.once("error", reject);
    request.end(json);
  });
}
