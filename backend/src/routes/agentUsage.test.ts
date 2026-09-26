import express from "express";
import session from "express-session";
import { request as httpRequest, type Server } from "node:http";
import type pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { config } from "../config.js";
import { AppError, errorHandler } from "../errors.js";
import { AgentUsageService } from "../services/agentUsage.js";
import type { AgentUsageAssociationInput, AgentUsageCandidatePage, AgentUsageContext } from "../types/agentUsage.js";
import { createAgentUsageRouter } from "./agentUsage.js";
import { declaredRoutePolicies } from "./policy.js";

vi.hoisted(() => {
  process.env.TENANT_ID = "11111111-1111-4111-8111-111111111111";
  process.env.CLIENT_ID = "22222222-2222-4222-8222-222222222222";
  process.env.CLIENT_SECRET = "synthetic-route-test-secret";
  process.env.TENANT_DOMAINS = "example.invalid";
  process.env.SESSION_SECRET = "agent-usage-route-fixture-secret";
});
vi.mock("../services/telemetry.js", async original => ({
  ...await original<typeof import("../services/telemetry.js")>(), operationalLog: vi.fn(),
}));

const recordId = "agent:33333333-3333-4333-8333-333333333333";
const base = `/api/agent-inventory/${encodeURIComponent(recordId)}`;
const context: AgentUsageContext = { reportSet: null, availability: "never_imported", lineages: [], revision: "b".repeat(64) };
const page: AgentUsageCandidatePage = { context, value: [], count: 0, offset: 0, limit: 50 };
const database = { query: vi.fn(), connect: vi.fn() };
const candidates = vi.fn<AgentUsageService["candidates"]>();
const attach = vi.fn<AgentUsageService["attach"]>();
const remove = vi.fn<AgentUsageService["remove"]>();
const provider = vi.fn();
let server: Server;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(session({ secret: "agent-usage-route-fixture-secret", resave: false, saveUninitialized: false }));
  app.use((request, _response, next) => {
    const role = request.get("x-test-role");
    if (role) {
      const tenantId = request.get("x-test-tenant") ?? config.tenants[0].tenantId!;
      request.session.accountId = "admin-reader";
      request.session.tenantId = tenantId;
      request.session.clientId = config.tenants[0].clientId;
      request.session.rolesValidatedAt = Date.now();
      request.session.csrfToken = "fixture-csrf";
      request.session.user = {
        tenantId, homeAccountId: "admin-reader", username: "admin@example.invalid", displayName: "Admin",
        roles: role === "admin" ? ["AgentControl.Admin"] : role === "viewer" ? ["AgentControl.Viewer"] : [],
      };
    }
    next();
  });
  app.use("/api", createAgentUsageRouter(database as unknown as pg.Pool));
  app.use(errorHandler);
  server = await new Promise<Server>(resolve => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
});

beforeEach(() => {
  database.query.mockReset().mockRejectedValue(new Error("Unexpected direct database query"));
  database.connect.mockReset().mockRejectedValue(new Error("Unexpected direct database connection"));
  candidates.mockReset().mockResolvedValue(page);
  attach.mockReset().mockResolvedValue({ context });
  remove.mockReset().mockResolvedValue({ context });
  provider.mockReset().mockRejectedValue(new Error("No provider calls are allowed"));
  vi.spyOn(AgentUsageService.prototype, "candidates").mockImplementation(candidates);
  vi.spyOn(AgentUsageService.prototype, "attach").mockImplementation(attach);
  vi.spyOn(AgentUsageService.prototype, "remove").mockImplementation(remove);
  vi.stubGlobal("fetch", provider);
});

afterEach(() => {
  try {
    expect(provider).not.toHaveBeenCalled();
    expect(database.query).not.toHaveBeenCalled();
    expect(database.connect).not.toHaveBeenCalled();
  } finally {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});
afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});

describe("Admin reviewed usage routes", () => {
  it("declares explicit Admin-only candidate and CSRF-protected reporting mutation policies", () => {
    expect(declaredRoutePolicies.get("GET /agent-inventory/:recordId/usage-candidates")).toEqual({
      access: "authenticated", dataClass: "official_usage_association_candidates", roles: ["AgentControl.Admin"],
    });
    for (const method of ["POST", "DELETE"]) {
      expect(declaredRoutePolicies.get(`${method} /agent-inventory/:recordId/usage-associations`)).toEqual({
        access: "authenticated", dataClass: "official_usage_association", roles: ["AgentControl.Admin"], csrf: true,
      });
    }
  });

  it.each([
    ["GET", "/usage-candidates"], ["POST", "/usage-associations"], ["DELETE", "/usage-associations"],
  ])("enforces session, tenant and Admin on %s %s", async (method, suffix) => {
    for (const [role, status] of [[null, 401], ["viewer", 403], ["unassigned", 403]] as const) {
      expect(await request(method, suffix, input(), { role })).toMatchObject({ status });
    }
    expect(await request(method, suffix, input(), { tenant: "99999999-9999-4999-8999-999999999999" }))
      .toMatchObject({ status: 401 });
    expect(candidates).not.toHaveBeenCalled();
    expect(attach).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it.each(["POST", "DELETE"])("rejects missing or mismatched CSRF before %s services run", async method => {
    expect(await request(method, "/usage-associations", input(), { csrf: null })).toMatchObject({ status: 403, body: { code: "invalid_csrf" } });
    expect(await request(method, "/usage-associations", input(), { csrf: "wrong" })).toMatchObject({ status: 403, body: { code: "invalid_csrf" } });
    expect(attach).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it("browses candidates only through the explicit record-qualified endpoint", async () => {
    expect(await request("GET", "/usage-candidates?search=Report%20A&offset=5&limit=20")).toEqual({ status: 200, body: page });
    expect(candidates).toHaveBeenCalledExactlyOnceWith(
      { tenantId: config.tenants[0].tenantId, principalId: "admin-reader" }, recordId, { search: "Report A", offset: 5, limit: 20 },
    );
    expect(attach).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it.each(["limit=0", "limit=251", "limit=1&limit=2", "offset=-1", "search=a&search=b", "search=a%C2%85b", "target=secret", "limit=1.5"])(
    "rejects candidate query %s without reading saved reports", async query => {
      expect(await request("GET", `/usage-candidates?${query}`)).toMatchObject({ status: 400, body: { code: "invalid_agent_usage_input" } });
      expect(candidates).not.toHaveBeenCalled();
    });

  it("passes only confirmed immutable intent and scoped actor into attachment and removal", async () => {
    expect(await request("POST", "/usage-associations", input())).toEqual({ status: 200, body: { context } });
    expect(attach).toHaveBeenCalledWith(
      { tenantId: config.tenants[0].tenantId, principalId: "admin-reader" }, recordId, input(),
      expect.objectContaining({ actor: expect.objectContaining({ tenantId: config.tenants[0].tenantId, homeAccountId: "admin-reader" }) }),
    );
    const { target: _target, ...removal } = input();
    expect(await request("DELETE", "/usage-associations", removal)).toEqual({ status: 200, body: { context } });
    expect(remove).toHaveBeenCalledWith(expect.anything(), recordId, removal, expect.anything());
    expect(candidates).not.toHaveBeenCalled();
  });

  it.each([
    { confirmed: false }, { confirmed: "true" }, { confirmed: 1 }, { extra: true }, { reportSetId: "invalid" },
    { expectedInventoryRevision: "" }, { reportAgentId: "\u0000" }, { target: { source: "canonical", agentId: recordId } },
    { target: { source: "power_platform", nativeId: "bot" } },
    { target: { source: "power_platform", nativeId: "bot", environmentId: "Environment-\ud800" } },
    { target: { source: "graph_packages", packageId: "Package-\udfff" } },
    { reportAgentId: "Report-\u0085" },
  ])("rejects invalid attachment %j before auditing or querying", async changes => {
    expect(await request("POST", "/usage-associations", { ...input(), ...changes })).toMatchObject({ status: 400 });
    expect(attach).not.toHaveBeenCalled();
  });

  it.each(["\ud800", "\udfff", "\u0085"])("rejects invalid removal identity %j before auditing or querying", async character => {
    const { target: _target, ...removal } = input();
    expect(await request("DELETE", "/usage-associations", { ...removal, reportAgentId: `Report-${character}` }))
      .toMatchObject({ status: 400, body: { code: "invalid_agent_usage_input" } });
    expect(remove).not.toHaveBeenCalled();
  });

  it("rejects targets on removal and query/body field smuggling", async () => {
    expect(await request("DELETE", "/usage-associations", input())).toMatchObject({ status: 400 });
    expect(await request("POST", "/usage-associations?confirmed=true", input())).toMatchObject({ status: 400 });
    expect(remove).not.toHaveBeenCalled();
    expect(attach).not.toHaveBeenCalled();
  });

  it.each(["agent:not-a-uuid", "unqualified", "power_platform:one", "graph_packages:bad%09identity"])(
    "rejects invalid record reference %s", async id => {
      expect(await request("GET", "/usage-candidates", undefined, { recordId: id })).toMatchObject({ status: 400 });
      expect(candidates).not.toHaveBeenCalled();
    });

  it("preserves explicit not-found, conflict and unexpected failure responses", async () => {
    candidates.mockRejectedValueOnce(new AppError(404, "agent_not_found", "Unavailable saved record"));
    expect(await request("GET", "/usage-candidates")).toMatchObject({ status: 404, body: { code: "agent_not_found" } });
    attach.mockRejectedValueOnce(new AppError(409, "agent_usage_changed", "Changed report"));
    expect(await request("POST", "/usage-associations", input())).toMatchObject({ status: 409, body: { code: "agent_usage_changed" } });
    candidates.mockRejectedValueOnce(new Error("Database disconnected"));
    expect(await request("GET", "/usage-candidates")).toMatchObject({ status: 500, body: { code: "internal_error" } });
  });
});

function input(): AgentUsageAssociationInput {
  return {
    reportSetId: "44444444-4444-4444-8444-444444444444", reportAgentId: "Report-A",
    target: { source: "graph_packages", packageId: "exact-package" },
    expectedInventoryRevision: "a".repeat(64), expectedUsageRevision: "b".repeat(64), confirmed: true,
  };
}

function request(method: string, suffix: string, body?: unknown, options: {
  role?: string | null; csrf?: string | null; tenant?: string; recordId?: string;
} = {}): Promise<{ status: number; body: unknown }> {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture address");
  const role = options.role === undefined ? "admin" : options.role;
  const csrf = options.csrf === undefined ? "fixture-csrf" : options.csrf;
  const json = body === undefined || method === "GET" ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      host: "127.0.0.1", port: address.port, method,
      path: `${options.recordId ? `/api/agent-inventory/${encodeURIComponent(options.recordId)}` : base}${suffix}`,
      headers: {
        ...(role ? { "x-test-role": role } : {}), ...(csrf ? { "x-csrf-token": csrf } : {}),
        ...(options.tenant ? { "x-test-tenant": options.tenant } : {}),
        ...(json ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(json) } : {}),
      },
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
