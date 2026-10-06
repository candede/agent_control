import express from "express";
import session from "express-session";
import { request as httpRequest, type Server } from "node:http";
import type pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { config } from "../config.js";
import { AppError, errorHandler } from "../errors.js";
import { OfficialAgentUsage } from "../services/officialAgentUsage.js";
import { LargeTenantUsersReports, reportQuery } from "../services/largeTenantUsersReports.js";
import type { CandidateAgentUsageMutation, CandidateAgentUsageCandidates, CandidateAgentUsageContext } from "../types/officialReportApi.js";
import { selectionIdentity } from "../../scripts/largeTenantFixtures.js";
import { createOfficialReportDataRouter } from "./officialReportData.js";
import { declaredRoutePolicies } from "./policy.js";

vi.hoisted(() => {
  delete process.env.TENANTS_JSON_FILE;
  process.env.TENANTS_JSON = JSON.stringify([{
    tenantId: "11111111-1111-4111-8111-111111111111", clientId: "22222222-2222-4222-8222-222222222222",
    clientSecret: "synthetic-route-test-secret", domains: ["example.invalid"],
  }]);
  process.env.SESSION_SECRET = "native-agent-usage-route-fixture-secret";
});
vi.mock("../services/telemetry.js", async original => ({
  ...await original<typeof import("../services/telemetry.js")>(), operationalLog: vi.fn(),
}));
const recordId = "agent:33333333-3333-4333-8333-333333333333", selectionId = "55555555-5555-4555-8555-555555555555";
const base = `/api/agent-inventory/${encodeURIComponent(recordId)}`;
const identity = { ...selectionIdentity, tenantId: config.tenants[0].tenantId!, principalId: "admin-reader" };
const context: CandidateAgentUsageContext = { selectionId, reportSetId: null, inventoryRevision: "a".repeat(64), usageRevision: "b".repeat(64),
  reports: { setId: null, activeSetId: null, activeRevision: "1", historyRevision: "0", historyEpoch: "0", availability: "never_imported",
    lineages: [], staleAfterDays: 35, periodAgeDays: null, acceptedAgeDays: null, acceptedAt: null, expiresAt: null, reportingPeriod: null } };
const selection = { id: selectionId, revision: "a".repeat(64), evaluatedAt: "2026-09-18T00:00:00Z", expiresAt: "2026-09-18T00:30:00Z" };
const page: CandidateAgentUsageCandidates = { context, selection, value: [], counts: { total: 0, filtered: 0 },
  page: { limit: 50, nextCursor: null, previousCursor: null } };
const database = { options: { max: 4 }, query: vi.fn(), connect: vi.fn() };
const reports = new LargeTenantUsersReports(database as unknown as pg.Pool, "native-agent-usage-route-fixture-secret", 35);
const candidates = vi.fn<OfficialAgentUsage["candidates"]>(), mutate = vi.fn<OfficialAgentUsage["mutate"]>();
const users = vi.fn<OfficialAgentUsage["users"]>();
const history = vi.fn<OfficialAgentUsage["history"]>();
const summaries = vi.fn<OfficialAgentUsage["summaries"]>(), associations = vi.fn<OfficialAgentUsage["associations"]>();
const capture = vi.fn<LargeTenantUsersReports["capture"]>(), provider = vi.fn();
let server: Server;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(session({ secret: "native-agent-usage-route-fixture-secret", resave: false, saveUninitialized: false }));
  app.use((request, _response, next) => {
    const role = request.get("x-test-role");
    if (role) {
      const tenantId = request.get("x-test-tenant") ?? config.tenants[0].tenantId!;
      request.session.accountId = "admin-reader";
      request.session.tenantId = tenantId;
      request.session.clientId = config.tenants[0].clientId;
      request.session.rolesValidatedAt = Date.now();
      request.session.csrfToken = "fixture-csrf";
      request.session.user = { tenantId, homeAccountId: "admin-reader", username: "admin@example.invalid", displayName: "Admin",
        roles: role === "admin" ? ["AgentControl.Admin"] : role === "viewer" ? ["AgentControl.Viewer"] : [] };
    }
    next();
  });
  app.use("/api", createOfficialReportDataRouter({ reports,
    identity: async () => ({ identity, tokenMode: "delegated" }),
    enqueueExport: async () => { throw new Error("Unexpected export"); },
  }));
  app.use(errorHandler);
  server = await new Promise<Server>(resolve => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
});
beforeEach(() => {
  database.query.mockReset().mockRejectedValue(new Error("Unexpected direct database query"));
  database.connect.mockReset().mockRejectedValue(new Error("Unexpected direct database connection"));
  candidates.mockReset().mockResolvedValue(page);
  mutate.mockReset().mockResolvedValue(context);
  users.mockReset().mockResolvedValue({ ...page, value: [], reports: context.reports });
  history.mockReset().mockResolvedValue({ recordId, context, value: [], latestReportSetId: context.reportSetId, latestReported: null, counts: page.counts, page: page.page });
  summaries.mockReset().mockResolvedValue([{ recordId, status: "unavailable", responses: null, activeUsers: null,
    lastActivityDateUtc: null, associationCount: 0, context }]);
  associations.mockReset().mockResolvedValue({ value: [], context, page: page.page, counts: page.counts });
  capture.mockReset().mockResolvedValue(selection);
  provider.mockReset().mockRejectedValue(new Error("No provider calls are allowed"));
  vi.spyOn(OfficialAgentUsage.prototype, "candidates").mockImplementation(candidates);
  vi.spyOn(OfficialAgentUsage.prototype, "mutate").mockImplementation(mutate);
  vi.spyOn(OfficialAgentUsage.prototype, "users").mockImplementation(users);
  vi.spyOn(OfficialAgentUsage.prototype, "history").mockImplementation(history);
  vi.spyOn(OfficialAgentUsage.prototype, "summaries").mockImplementation(summaries);
  vi.spyOn(OfficialAgentUsage.prototype, "associations").mockImplementation(associations);
  vi.spyOn(reports, "capture").mockImplementation(capture);
  vi.stubGlobal("fetch", provider);
});
afterEach(() => {
  try {
    expect(provider).not.toHaveBeenCalled();
    expect(database.query).not.toHaveBeenCalled();
    expect(database.connect).not.toHaveBeenCalled();
  } finally { vi.restoreAllMocks(); vi.unstubAllGlobals(); }
});
afterAll(async () => { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });

describe("native Admin reviewed usage routes", () => {
  it.each(["usage", "usage-associations", "usage-users", "usage-history"])("uses the explicit inventory pin for Viewer %s without capturing another report", async path => {
    expect(await request("GET", `/${path}?inventorySelectionId=${selectionId}&selectionId=${selectionId}`, undefined, { role: "viewer" }))
      .toMatchObject({ status: 200 });
    expect(capture).not.toHaveBeenCalled();
    const calls = path === "usage" ? summaries : path === "usage-associations" ? associations : path === "usage-history" ? history : users;
    expect(calls).toHaveBeenCalledOnce();
    expect(calls.mock.calls[0].slice(0, 2)).toEqual([selectionId, identity]);
    expect(calls.mock.contexts[0]).toMatchObject({ inventory: expect.anything() });
  });
  it.each(["inventorySelectionId=invalid", `inventorySelectionId=${selectionId}&selectionId=66666666-6666-4666-8666-666666666666`,
    `inventorySelectionId=${selectionId}&inventorySelectionId=${selectionId}`, `inventorySelectionId=${selectionId}&setId=invalid`,
    `inventorySelectionId=${selectionId}&search=a&search=b`, `inventorySelectionId=${selectionId}&limit=101`])(
    "rejects mixed or malformed selected usage query %s", async query => {
      expect(await request("GET", `/usage-users?${query}`)).toMatchObject({ status: 400 });
      expect(capture).not.toHaveBeenCalled(); expect(users).not.toHaveBeenCalled();
    });
  it.each(["usage", "usage-users", "usage-associations"])("binds a local report override to the same saved inventory for %s", async path => {
    const setId = "66666666-6666-4666-8666-666666666666";
    expect(await request("GET", `/${path}?inventorySelectionId=${selectionId}&selectionId=${selectionId}&setId=${setId}`, undefined, { role: "viewer" }))
      .toMatchObject({ status: 200 });
    if (path === "usage") expect(summaries).toHaveBeenCalledWith(selectionId, identity, [recordId], setId);
    else expect(path === "usage-users" ? users : associations)
      .toHaveBeenCalledWith(selectionId, identity, recordId, expect.objectContaining({ setId }));
    expect(capture).not.toHaveBeenCalled(); expect(mutate).not.toHaveBeenCalled();
  });
  it("keeps the requested report on an initial legacy capture for its subsequent child reads", async () => {
    const setId = "66666666-6666-4666-8666-666666666666";
    expect(await request("GET", `/usage?setId=${setId}`, undefined, { role: "viewer" })).toMatchObject({ status: 200 });
    expect(capture).toHaveBeenCalledExactlyOnceWith(identity, "delegated", "official_agents", reportQuery("official_agents", { setId }));
    expect(summaries).toHaveBeenCalledWith(selectionId, identity, [recordId], setId);
  });
  it("rejects unauthorized and unsupported history requests before reading evidence", async () => {
    expect(await request("GET", "/usage-history", undefined, { role: null })).toMatchObject({ status: 401 });
    expect(await request("GET", "/usage-history", undefined, { role: "unassigned" })).toMatchObject({ status: 403 });
    expect(await request("GET", `/usage-history?setId=${selectionId}`)).toMatchObject({ status: 400 });
    expect(history).not.toHaveBeenCalled();
  });
  it("binds reviewed removal to the displayed inventory pin without accepting it as a candidate attachment", async () => {
    const { target: _target, ...remove } = input();
    expect(await request("DELETE", `/usage-associations?inventorySelectionId=${selectionId}`, remove)).toMatchObject({ status: 200 });
    expect(mutate.mock.contexts[0]).toMatchObject({ inventory: expect.anything() });
    expect(await request("POST", `/usage-associations?inventorySelectionId=${selectionId}`, input())).toMatchObject({ status: 400 });
    expect(await request("DELETE", "/usage-associations?inventorySelectionId=66666666-6666-4666-8666-666666666666", remove))
      .toMatchObject({ status: 400 });
    expect(mutate).toHaveBeenCalledOnce();
  });

  it("declares Admin candidates, Viewer reads, and CSRF-protected Admin mutations", () => {
    expect(declaredRoutePolicies.get("GET /agent-inventory/:recordId/usage-candidates")).toEqual({
      access: "authenticated", dataClass: "official_usage_association_candidates", roles: ["AgentControl.Admin"],
    });
    for (const path of ["usage", "usage-associations", "usage-users", "usage-history"]) expect(declaredRoutePolicies.get(`GET /agent-inventory/:recordId/${path}`))
      .toEqual({ access: "authenticated", dataClass: "official_usage_association", roles: ["AgentControl.Viewer"] });
    for (const method of ["POST", "DELETE"]) expect(declaredRoutePolicies.get(`${method} /agent-inventory/:recordId/usage-associations`))
      .toEqual({ access: "authenticated", dataClass: "official_usage_association", roles: ["AgentControl.Admin"], csrf: true });
  });
  it.each([["GET", "/usage-candidates"], ["POST", "/usage-associations"], ["DELETE", "/usage-associations"]])(
    "enforces session, tenant and Admin on %s %s", async (method, suffix) => {
      for (const [role, status] of [[null, 401], ["viewer", 403], ["unassigned", 403]] as const) {
        expect(await request(method, suffix, input(), { role })).toMatchObject({ status });
      }
      expect(await request(method, suffix, input(), { tenant: "99999999-9999-4999-8999-999999999999" })).toMatchObject({ status: 401 });
      expect(capture).not.toHaveBeenCalled(); expect(candidates).not.toHaveBeenCalled(); expect(mutate).not.toHaveBeenCalled();
    });
  it.each(["POST", "DELETE"])("rejects missing or mismatched CSRF before %s services run", async method => {
    for (const csrf of [null, "wrong"]) expect(await request(method, "/usage-associations", input(), { csrf }))
      .toMatchObject({ status: 403, body: { code: "invalid_csrf" } });
    expect(mutate).not.toHaveBeenCalled();
  });
  it("browses candidates with one immutable selected query and exact current record", async () => {
    expect(await request("GET", "/usage-candidates?search=Report%20A&limit=20")).toEqual({ status: 200, body: page });
    expect(capture).toHaveBeenCalledExactlyOnceWith(identity, "delegated", "official_agents", reportQuery("official_agents", { search: "Report A" }));
    expect(candidates).toHaveBeenCalledExactlyOnceWith(selectionId, identity, recordId, { limit: 20 });
    expect(mutate).not.toHaveBeenCalled();
  });
  it("allows Viewer to page agent users without candidate or management access", async () => {
    expect(await request("GET", "/usage-users?search=Exact%20User&limit=25", undefined, { role: "viewer" }))
      .toEqual({ status: 200, body: { ...page, value: [], reports: context.reports } });
    expect(users).toHaveBeenCalledExactlyOnceWith(selectionId, identity, recordId, { search: "exact user", limit: 25 });
    expect(capture).toHaveBeenCalledExactlyOnceWith(identity, "delegated", "official_agents", reportQuery("official_agents", {}));
    expect(candidates).not.toHaveBeenCalled(); expect(mutate).not.toHaveBeenCalled();
  });
  it.each(["agentId=other", "search=a&search=b", "limit=101", "limit=1.5", "offset=0", "inventoryRevision=anything", "sort=name"])(
    "rejects unsupported agent-user query %s", async query => {
      expect(await request("GET", `/usage-users?${query}`)).toMatchObject({ status: 400 });
      expect(users).not.toHaveBeenCalled(); expect(capture).not.toHaveBeenCalled();
    });
  it.each([[null, 401], ["unassigned", 403]] as const)("rejects unauthorized agent-user read for %s", async (role, status) => {
    expect(await request("GET", "/usage-users", undefined, { role })).toMatchObject({ status });
    expect(users).not.toHaveBeenCalled();
  });
  it.each(["limit=0", "limit=101", "limit=251", "limit=1&limit=2", "offset=0", "offset=-1", "search=a&search=b", "search=a%C2%85b",
    "target=secret", "limit=1.5", "inventoryRevision=bad"])("rejects query %s before capturing or reading reports", async query => {
      expect(await request("GET", `/usage-candidates?${query}`)).toMatchObject({ status: 400 });
      expect(capture).not.toHaveBeenCalled(); expect(candidates).not.toHaveBeenCalled();
    });
  it("passes only confirmed immutable intent and a scoped actor to native mutation", async () => {
    expect(await request("POST", "/usage-associations", input())).toEqual({ status: 200, body: context });
    expect(mutate).toHaveBeenCalledWith(identity, recordId, input(), expect.objectContaining({ tenantId: identity.tenantId, homeAccountId: identity.principalId }));
    const { target: _target, ...remove } = input();
    expect(await request("DELETE", "/usage-associations", remove)).toEqual({ status: 200, body: context });
    expect(mutate).toHaveBeenLastCalledWith(identity, recordId, remove, expect.anything());
    expect(candidates).not.toHaveBeenCalled();
  });
  it.each([{ confirmed: false }, { confirmed: "true" }, { confirmed: 1 }, { extra: true }, { reportSetId: "invalid" }, { selectionId: "invalid" },
    { inventoryRevision: "" }, { reportAgentId: "\u0000" }, { target: { source: "canonical", agentId: recordId } },
    { target: { source: "power_platform", nativeId: "bot" } }, { target: { source: "power_platform", nativeId: "bot", environmentId: "Environment-\ud800" } },
    { target: { source: "graph_packages", packageId: "Package-\udfff" } }, { reportAgentId: "Report-\u0085" },
  ])("rejects invalid attachment %j before auditing or querying", async changes => {
    expect(await request("POST", "/usage-associations", { ...input(), ...changes })).toMatchObject({ status: 400 });
    expect(mutate).not.toHaveBeenCalled();
  });
  it.each(["\ud800", "\udfff", "\u0085"])("rejects invalid removal identity %j", async character => {
    const { target: _target, ...remove } = input();
    expect(await request("DELETE", "/usage-associations", { ...remove, reportAgentId: `Report-${character}` }))
      .toMatchObject({ status: 400, body: { code: "invalid_agent_usage" } });
    expect(mutate).not.toHaveBeenCalled();
  });
  it("rejects targets on removal and query/body field smuggling", async () => {
    expect(await request("DELETE", "/usage-associations", input())).toMatchObject({ status: 400 });
    expect(await request("POST", "/usage-associations?confirmed=true", input())).toMatchObject({ status: 400 });
    expect(await request("POST", "/usage-associations", { ...input(), reports: {} })).toMatchObject({ status: 400 });
    expect(mutate).not.toHaveBeenCalled();
  });
  it.each(["agent:not-a-uuid", "unqualified", "power_platform:one", "graph_packages:bad%09identity"])("rejects invalid exact record %s before capture", async id => {
    expect(await request("GET", "/usage-candidates", undefined, { recordId: id })).toMatchObject({ status: 400 });
    expect(capture).not.toHaveBeenCalled(); expect(candidates).not.toHaveBeenCalled();
  });
  it("preserves explicit not-found, conflict, serialization and unexpected failure responses", async () => {
    candidates.mockRejectedValueOnce(new AppError(404, "agent_not_found", "Unavailable saved record"));
    expect(await request("GET", "/usage-candidates")).toMatchObject({ status: 404, body: { code: "agent_not_found" } });
    mutate.mockRejectedValueOnce(new AppError(409, "agent_usage_changed", "Changed report"));
    expect(await request("POST", "/usage-associations", input())).toMatchObject({ status: 409, body: { code: "agent_usage_changed" } });
    candidates.mockRejectedValueOnce(new AppError(503, "data_read_conflict", "Retry the selected read"));
    expect(await request("GET", "/usage-candidates")).toMatchObject({ status: 503, body: { code: "data_read_conflict" } });
    candidates.mockRejectedValueOnce(new Error("Database disconnected"));
    expect(await request("GET", "/usage-candidates")).toMatchObject({ status: 500, body: { code: "internal_error" } });
  });
});
function input(): CandidateAgentUsageMutation {
  return { selectionId, reportSetId: "44444444-4444-4444-8444-444444444444", reportAgentId: "Report-A",
    target: { source: "graph_packages", packageId: "exact-package" }, inventoryRevision: "a".repeat(64), usageRevision: "b".repeat(64), confirmed: true };
}
function request(method: string, suffix: string, body?: unknown, options: {
  role?: string | null; csrf?: string | null; tenant?: string; recordId?: string;
} = {}): Promise<{ status: number; body: unknown }> {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture address");
  const role = options.role === undefined ? "admin" : options.role, csrf = options.csrf === undefined ? "fixture-csrf" : options.csrf;
  const json = body === undefined || method === "GET" ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const message = httpRequest({ host: "127.0.0.1", port: address.port, method,
      path: `${options.recordId ? `/api/agent-inventory/${encodeURIComponent(options.recordId)}` : base}${suffix}`,
      headers: { ...(role ? { "x-test-role": role } : {}), ...(csrf ? { "x-csrf-token": csrf } : {}),
        ...(options.tenant ? { "x-test-tenant": options.tenant } : {}),
        ...(json ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(json) } : {}) },
    }, response => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", chunk => { text += chunk; });
      response.on("end", () => resolve({ status: response.statusCode!, body: JSON.parse(text) }));
    });
    message.once("error", reject); message.end(json);
  });
}
