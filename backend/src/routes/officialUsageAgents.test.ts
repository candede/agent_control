import express from "express";
import session from "express-session";
import { request as httpRequest, type Server } from "node:http";
import type pg from "pg";
import { parse as parseCsv } from "csv-parse/sync";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { config } from "../config.js";
import { OfficialUsageRepository } from "../db/officialUsage.js";
import { PackageInventoryRepository } from "../db/packageInventory.js";
import { AppError, errorHandler } from "../errors.js";
import * as auditLog from "../services/auditLog.js";
import * as csvExport from "../services/csvExport.js";
import { parseOfficialUsageReport } from "../services/officialUsageParser.js";
import type { OfficialUsageAgentDetailView, OfficialUsageAggregateView, OfficialUsageUserView, PublishedOfficialUsage } from "../types/officialUsage.js";
import { createOfficialUsageRouter } from "./officialUsage.js";
import { declaredRoutePolicies } from "./policy.js";

vi.hoisted(() => {
  process.env.TENANT_ID = "11111111-1111-1111-1111-111111111111";
  process.env.CLIENT_ID = "22222222-2222-4222-8222-222222222222";
  process.env.SESSION_SECRET = "official-usage-agent-route-test-secret";
});

vi.mock("../services/telemetry.js", async original => ({
  ...await original<typeof import("../services/telemetry.js")>(),
  operationalLog: vi.fn(),
}));

const activeSetId = "11111111-1111-4111-8111-111111111111";
const retainedSetId = "22222222-2222-4222-8222-222222222222";
const missingSetId = "33333333-3333-4333-8333-333333333333";
const detailPath = "/api/official-usage/agents/Report-A";
const usersPath = "/api/official-usage/users";
const database = { query: vi.fn(), connect: vi.fn() };
const readPublished = vi.fn<OfficialUsageRepository["getPublished"]>();
const inventoryRead = vi.fn<PackageInventoryRepository["list"]>();
const providerRead = vi.fn<typeof fetch>();
let active: PublishedOfficialUsage;
let retained: PublishedOfficialUsage;
let server: Server;
let expectedInventoryReads = 0;

beforeAll(async () => {
  const app = express();
  app.use(session({ secret: "official-usage-agent-route-test-secret", resave: false, saveUninitialized: false }));
  app.use((request, _response, next) => {
    const role = request.get("x-test-role");
    if (role) {
      const tenantId = request.get("x-test-tenant") ?? config.tenantId!;
      request.session.accountId = "report-reader";
      request.session.tenantId = tenantId;
      request.session.rolesValidatedAt = Date.now();
      request.session.user = {
        tenantId, homeAccountId: "report-reader", username: "reader@example.invalid", displayName: "Reader",
        roles: role === "viewer" ? ["AgentControl.Viewer"] : role === "admin" ? ["AgentControl.Admin"] : [],
      };
    }
    next();
  });
  app.use("/api", createOfficialUsageRouter(database as unknown as pg.Pool));
  app.use(errorHandler);
  server = await new Promise<Server>(resolve => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
});

beforeEach(() => {
  expectedInventoryReads = 0;
  active = published(activeSetId, 10);
  retained = published(retainedSetId, 25);
  database.query.mockReset().mockRejectedValue(new Error("Unexpected database access"));
  database.connect.mockReset().mockRejectedValue(new Error("Unexpected database connection"));
  readPublished.mockReset().mockImplementation(async (tenantId, setId) => {
    expect(tenantId).toBe(config.tenantId);
    if (setId && setId !== activeSetId && setId !== retainedSetId) {
      throw new AppError(404, "official_usage_set_not_found", "The retained official usage report set was not found.");
    }
    return setId === retainedSetId ? retained : active;
  });
  inventoryRead.mockReset().mockRejectedValue(new Error("Inventory must not be read for report identities"));
  providerRead.mockReset().mockRejectedValue(new Error("Navigation must not read remote providers"));
  vi.spyOn(OfficialUsageRepository.prototype, "getPublished").mockImplementation(readPublished);
  vi.spyOn(PackageInventoryRepository.prototype, "list").mockImplementation(inventoryRead);
  vi.stubGlobal("fetch", providerRead);
});

afterEach(() => {
  try {
    expect(inventoryRead).toHaveBeenCalledTimes(expectedInventoryReads);
    expect(providerRead).not.toHaveBeenCalled();
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

describe("official usage report-agent routes", () => {
  it("uses the distinct active-user order consistently in aggregate JSON and CSV", async () => {
    expectedInventoryReads = 2;
    inventoryRead.mockResolvedValue({
      value: [], count: 0, snapshot: null,
      summary: { total: 0, allowed: 0, blocked: 0 },
      filteredSummary: { total: 0, allowed: 0, blocked: 0 },
      facets: { publishers: [], availability: [], hosts: [], platforms: [] },
    });
    vi.spyOn(auditLog, "getAuditLog").mockReturnValue({
      startEvent: vi.fn().mockResolvedValue({ id: "export-event" }),
      completeEvent: vi.fn().mockResolvedValue(undefined),
    } as unknown as ReturnType<typeof auditLog.getAuditLog>);
    vi.spyOn(csvExport, "createExportPublicationValidator").mockReturnValue(async () => undefined);
    const json = await get<OfficialUsageAggregateView>("/api/official-usage/aggregate?sortBy=activeUsers&sortDirection=desc");
    const csv = await get("/api/official-usage/aggregate.csv?sortBy=activeUsers&sortDirection=desc");
    expect(json.status).toBe(200);
    expect(csv.status).toBe(200);
    expect(json.body.filters.sortBy).toBe("activeUsers");
    const rows = parseCsv(csv.text, { columns: true, bom: true }) as Array<Record<string, string>>;
    expect(rows.map(row => row.agentId)).toEqual(json.body.agents.value.map(agent => agent.agentId));
    expect(json.body.agents.value[0]).toMatchObject({ agentId: "Report-A", activeUsersIdentityCount: 2 });
  });

  it("declares report-agent details as an authenticated Viewer read", () => {
    expect(declaredRoutePolicies.get("GET /official-usage/agents/:agentId")).toEqual({
      access: "authenticated", dataClass: "official_usage_user", roles: ["AgentControl.Viewer"],
    });
    expect(declaredRoutePolicies.has("POST /official-usage/agents/:agentId")).toBe(false);
  });

  it.each([detailPath, `${usersPath}?agentId=Report-A`])("gates %s on the tenant session and Viewer or inherited Admin role", async path => {
    expect(await get(path, null)).toMatchObject({ status: 401, body: { code: "unauthorized" } });
    expect(await get(path, "unassigned")).toMatchObject({ status: 403, body: { code: "missing_internal_role" } });
    expect(await get(path, "viewer", "99999999-9999-4999-8999-999999999999")).toMatchObject({ status: 401, body: { code: "unauthorized" } });
    expect(readPublished).not.toHaveBeenCalled();
    expect((await get(path, "viewer")).status).toBe(200);
    expect((await get(path, "admin")).status).toBe(200);
    expect(readPublished).toHaveBeenCalledTimes(2);
  });

  it("returns only saved report identities and preserves source totals, case-distinct users and zero rows", async () => {
    const response = await get<OfficialUsageAgentDetailView>(detailPath);
    expect(response).toMatchObject({
      status: 200,
      body: {
        activeSet: { id: activeSetId },
        missingKinds: [],
        agent: {
          agentId: "Report-A", identityStatus: "unresolved",
          activeUsersLicensed: 2, activeUsersUnlicensed: 2, activeUsersTotal: 2,
          responsesSentToUsers: 10,
          responseComparison: { sourceValues: { agents: 10, userAgents: 5 }, status: "mismatch", difference: 5 },
        },
        summary: { reportedUsers: 3, responseProducingUsers: 2, zeroResponseUsers: 1, userBreakdownResponses: 5 },
        filters: { sortBy: "responses", sortDirection: "desc" },
        users: {
          value: [
            { username: "CaseUser", displayName: "Alpha", responsesSentToUsers: 4 },
            { username: "caseuser", displayName: "Beta", responsesSentToUsers: 1 },
            { username: "zero-user", displayName: "Zero", responsesSentToUsers: 0 },
          ],
          count: 3, limit: 100, offset: 0,
        },
      },
    });
    for (const user of response.body!.users.value) {
      expect(Object.keys(user).sort()).toEqual(["displayName", "responsesSentToUsers", "username"]);
    }
    expect(readPublished).toHaveBeenCalledExactlyOnceWith(config.tenantId, undefined);
  });

  it("filters and sorts the complete detail breakdown before paging without changing its summary", async () => {
    expect(await get(`${detailPath}?search=USER&sortBy=displayName&sortDirection=desc&limit=1&offset=1`)).toMatchObject({
      status: 200,
      body: {
        filters: { search: "USER", sortBy: "displayName", sortDirection: "desc" },
        users: { value: [{ username: "caseuser", responsesSentToUsers: 1 }], count: 3, limit: 1, offset: 1 },
        summary: { reportedUsers: 3, responseProducingUsers: 2, zeroResponseUsers: 1, userBreakdownResponses: 5 },
      },
    });
    expect(await get(`${detailPath}?search=Alpha&limit=500&offset=100000`)).toMatchObject({
      status: 200, body: { users: { value: [], count: 1, limit: 500, offset: 100_000 }, summary: { reportedUsers: 3 } },
    });
    expect(await get(`${detailPath}?search=missing`)).toMatchObject({
      status: 200, body: { users: { value: [], count: 0 }, summary: { reportedUsers: 3 } },
    });
  });

  it("returns null metrics instead of zero when the user-agent companion is absent", async () => {
    active.reports.userAgents = undefined;
    expect(await get(detailPath)).toMatchObject({
      status: 200,
      body: {
        missingKinds: ["userAgents"],
        agent: { activeUsersTotal: null, responseComparison: { sourceValues: { userAgents: null } } },
        summary: { reportedUsers: null, responseProducingUsers: null, zeroResponseUsers: null, userBreakdownResponses: null },
        users: { value: [], count: 0 },
      },
    });
  });

  it.each(["empty", "other-agent"] as const)(
    "keeps the drilldown active-user summary unknown for %s companion evidence", async evidence => {
      active.reports.userAgents!.rows = evidence === "empty"
        ? []
        : active.reports.userAgents!.rows.filter(row => row.agentId !== "Report-A");
      expect(await get(detailPath)).toMatchObject({
        status: 200,
        body: {
          missingKinds: [],
          agent: { activeUsersTotal: null, activeUsersIdentityCount: null },
          summary: { reportedUsers: 0, responseProducingUsers: null, zeroResponseUsers: 0, userBreakdownResponses: 0 },
          users: { value: [], count: 0 },
        },
      });
    });

  it("preserves explicit zero-response evidence in the drilldown active-user summary", async () => {
    active.reports.userAgents!.rows = active.reports.userAgents!.rows.filter(row =>
      row.agentId === "Report-A" && row.responsesSentToUsers === 0);
    expect(await get(detailPath)).toMatchObject({
      status: 200,
      body: {
        agent: { activeUsersTotal: 0, activeUsersIdentityCount: 0 },
        summary: { reportedUsers: 1, responseProducingUsers: 0, zeroResponseUsers: 1, userBreakdownResponses: 0 },
        users: { count: 1 },
      },
    });
  });

  it("filters user identities by exact agent ID without rewriting their full Users totals or rows", async () => {
    const baseline = (await get<OfficialUsageUserView>(usersPath)).body!;
    const filtered = (await get<OfficialUsageUserView>(`${usersPath}?agentId=Report-A`)).body!;
    expect(baseline.filters).not.toHaveProperty("agentId");
    expect(filtered.filters.agentId).toBe("Report-A");
    expect(filtered.users.count).toBe(3);
    expect(filtered.users.value.map(user => user.username)).toEqual(["CaseUser", "caseuser", "zero-user"]);
    expect(filtered.users.value).toEqual(baseline.users.value.filter(user => user.rows.some(row => row.agentId === "Report-A")));
    expect(filtered.users.value[0]).toMatchObject({ reportedResponsesReceived: 50, bridgeResponsesSentToUsers: 6, agentsAccessedTotal: 2 });
    expect(filtered.users.value[0].rows.map(row => row.agentId)).toEqual(["Report-A", "Other-agent"]);
    expect(filtered.counts).toEqual({ ...baseline.counts, filteredUsers: 3 });
    expect(await get(`${usersPath}?agentId=Report-A&search=user&sortBy=responses&sortDirection=asc&limit=1&offset=1`)).toMatchObject({
      status: 200, body: { users: { value: [{ username: "caseuser", reportedResponsesReceived: 4 }], count: 3, limit: 1, offset: 1 } },
    });
    expect(await get(`${usersPath}?agentId=report-a`)).toMatchObject({
      status: 200, body: { users: { value: [{ username: "only-lower" }], count: 1 } },
    });
    expect(await get(`${usersPath}?agentId=REPORT-A`)).toMatchObject({ status: 200, body: { users: { value: [], count: 0 } } });
  });

  it("uses exactly the requested retained report set without changing the active selection", async () => {
    expect(await get(`${detailPath}?setId=${retainedSetId}`)).toMatchObject({
      status: 200, body: { activeSet: { id: retainedSetId }, agent: { responsesSentToUsers: 25 } },
    });
    expect(readPublished).toHaveBeenLastCalledWith(config.tenantId, retainedSetId);
    expect(await get(`${usersPath}?agentId=retained-only&setId=${retainedSetId}`)).toMatchObject({
      status: 200,
      body: { activeSet: { id: retainedSetId }, users: { value: [{ username: "only-set", datasetScope: { reportSetId: retainedSetId } }], count: 1 } },
    });
    expect(readPublished).toHaveBeenLastCalledWith(config.tenantId, retainedSetId);
    expect(await get("/api/official-usage/agents/retained-only")).toMatchObject({ status: 404, body: { code: "official_usage_agent_not_found" } });
    expect(await get(detailPath)).toMatchObject({ status: 200, body: { activeSet: { id: activeSetId }, agent: { responsesSentToUsers: 10 } } });
    expect(readPublished).toHaveBeenLastCalledWith(config.tenantId, undefined);
  });

  it.each([detailPath, `${usersPath}?agentId=Report-A`])("does not fall back to active data for an unavailable set at %s", async path => {
    const separator = path.includes("?") ? "&" : "?";
    expect(await get(`${path}${separator}setId=${missingSetId}`)).toMatchObject({ status: 404, body: { code: "official_usage_set_not_found" } });
    expect(readPublished).toHaveBeenCalledExactlyOnceWith(config.tenantId, missingSetId);
  });

  it("does not match names, case-folded IDs, inventory IDs or an empty report", async () => {
    expect(await get("/api/official-usage/agents/report-a")).toMatchObject({
      status: 200, body: { agent: { agentId: "report-a", responsesSentToUsers: 7 }, users: { count: 1 } },
    });
    for (const id of ["Same name", "REPORT-A", "inventory-Report-A", " Report-A ", "unknown"]) {
      expect(await get(`/api/official-usage/agents/${encodeURIComponent(id)}`)).toMatchObject({
        status: 404, body: { code: "official_usage_agent_not_found" },
      });
    }
    active.reports = {};
    active.activeSet = null;
    expect(await get(detailPath)).toMatchObject({ status: 404, body: { code: "official_usage_agent_not_found" } });
  });

  it.each(["Report/% Agent?x=1#[]&:=+", "a".repeat(512)])("accepts opaque report IDs without UUID validation or normalization (%s)", async agentId => {
    active.reports.agents!.rows[0].agentId = agentId;
    for (const row of active.reports.userAgents!.rows) if (row.agentId === "Report-A") row.agentId = agentId;
    expect(await get(`/api/official-usage/agents/${encodeURIComponent(agentId)}`)).toMatchObject({
      status: 200, body: { agent: { agentId }, users: { count: 3 } },
    });
    expect(await get(`${usersPath}?${new URLSearchParams({ agentId })}`)).toMatchObject({
      status: 200, body: { filters: { agentId }, users: { count: 3 } },
    });
  });

  it("preserves CSV columns and full user rows with or without the optional agent filter", async () => {
    vi.spyOn(auditLog, "getAuditLog").mockReturnValue({
      startEvent: vi.fn().mockResolvedValue({ id: "export-event" }),
      completeEvent: vi.fn().mockResolvedValue(undefined),
    } as unknown as ReturnType<typeof auditLog.getAuditLog>);
    vi.spyOn(csvExport, "createExportPublicationValidator").mockReturnValue(async () => undefined);
    const baseline = await get(`${usersPath}.csv`);
    const filtered = await get(`${usersPath}.csv?agentId=Report-A`);
    expect(baseline.status).toBe(200);
    expect(filtered.status).toBe(200);
    const baselineRows = parseCsv(baseline.text, { columns: true, bom: true }) as Array<Record<string, string>>;
    const filteredRows = parseCsv(filtered.text, { columns: true, bom: true }) as Array<Record<string, string>>;
    expect(Object.keys(filteredRows[0])).toEqual(Object.keys(baselineRows[0]));
    expect(filteredRows).toEqual(baselineRows.filter(row => ["CaseUser", "caseuser", "zero-user"].includes(row.username)));
    expect(filteredRows).toHaveLength(4);
    expect(filteredRows).toEqual(expect.arrayContaining([
      expect.objectContaining({ username: "CaseUser", agentId: "Other-agent", reportedResponsesReceived: "50", responsesSentToUsers: "2" }),
      expect.objectContaining({ username: "zero-user", agentId: "Report-A", responsesSentToUsers: "0" }),
    ]));
    expect(baselineRows).toEqual(expect.arrayContaining([
      expect.objectContaining({ username: "users-only", agentId: "", reportedResponsesReceived: "200" }),
    ]));
  });

  it("exports all relationships of same-row matching people in the pinned snapshot without UI paging", async () => {
    vi.spyOn(auditLog, "getAuditLog").mockReturnValue({
      startEvent: vi.fn().mockResolvedValue({ id: "export-event" }),
      completeEvent: vi.fn().mockResolvedValue(undefined),
    } as unknown as ReturnType<typeof auditLog.getAuditLog>);
    vi.spyOn(csvExport, "createExportPublicationValidator").mockReturnValue(async () => undefined);
    const response = await get(`${usersPath}.csv?${new URLSearchParams({
      setId: retainedSetId, agentId: "Report-A", creatorType: "Declarative", responsesOnly: "true",
      sortBy: "responses", sortDirection: "asc", limit: "1", offset: "1",
    })}`);
    expect(response.status).toBe(200);
    const rows = parseCsv(response.text, { columns: true, bom: true }) as Array<Record<string, string>>;
    expect(rows.map(row => [row.username, row.agentId, row.reportedResponsesReceived, row.reportSetId])).toEqual([
      ["caseuser", "Report-A", "4", retainedSetId],
      ["CaseUser", "Report-A", "50", retainedSetId],
      ["CaseUser", "Other-agent", "50", retainedSetId],
    ]);
    expect(readPublished.mock.calls.every(([, setId]) => setId === retainedSetId)).toBe(true);
    const noMatch = await get(`${usersPath}.csv?agentId=Report-A&creatorType=Custom&responsesOnly=true`);
    expect(parseCsv(noMatch.text, { columns: true, bom: true })).toEqual([]);
  });

  it("exports missing Users totals and absent relationships as unknown, never inferred zero evidence", async () => {
    vi.spyOn(auditLog, "getAuditLog").mockReturnValue({
      startEvent: vi.fn().mockResolvedValue({ id: "export-event" }),
      completeEvent: vi.fn().mockResolvedValue(undefined),
    } as unknown as ReturnType<typeof auditLog.getAuditLog>);
    vi.spyOn(csvExport, "createExportPublicationValidator").mockReturnValue(async () => undefined);
    active.reports.users!.rows = active.reports.users!.rows.filter(row => row.username !== "caseuser");
    const response = await get(`${usersPath}.csv`);
    expect(response.status).toBe(200);
    const rows = parseCsv(response.text, { columns: true, bom: true }) as Array<Record<string, string>>;
    expect(rows.find(row => row.username === "caseuser")).toMatchObject({
      userMetricSource: "unknown", reportedAgentsUsed: "Unknown", reportedResponsesReceived: "Unknown",
      responsesSentToUsers: "1", bridgeResponsesSentToUsers: "1",
    });
    expect(rows.find(row => row.username === "users-only")).toMatchObject({
      reportedResponsesReceived: "200", bridgeResponsesSentToUsers: "Unknown",
      agentId: "", responsesSentToUsers: "Unknown", hasReportMismatch: "false",
    });
    active.reports.userAgents = undefined;
    const missingCompanion = await get(`${usersPath}.csv?search=CaseUser`);
    const missingRows = parseCsv(missingCompanion.text, { columns: true, bom: true }) as Array<Record<string, string>>;
    expect(missingRows[0]).toMatchObject({
      agentsAccessedTotal: "Unknown", responseProducingAgentCount: "Unknown",
      bridgeResponsesSentToUsers: "Unknown", reportedResponsesReceived: "50",
    });
  });
});

describe("official usage report-agent query validation", () => {
  it.each([usersPath, `${usersPath}.csv`])("rejects invalid date and threshold filters at %s before source reads", async path => {
    for (const query of [
      "startDate=2026-02-29", "endDate=2026-09-31", "startDate=2026-09-10&endDate=2026-09-09",
      "startDate=2026-09-10T00:00:00Z", "lowResponseThreshold=0", "lowResponseThreshold=1.5",
      "lowResponseThreshold=100000001",
    ]) {
      expect(await get(`${path}?${query}`)).toMatchObject({ status: 400, body: { code: "invalid_usage_query" } });
    }
    expect(readPublished).not.toHaveBeenCalled();
  });
  it.each([
    "/api/official-usage/aggregate", "/api/official-usage/aggregate.csv", "/api/official-usage/history",
  ])("rejects ambiguous or unsupported saved-report queries at %s before reading data", async path => {
    vi.spyOn(auditLog, "getAuditLog").mockReturnValue({
      startEvent: vi.fn().mockResolvedValue({ id: "export-event" }),
      completeEvent: vi.fn().mockResolvedValue(undefined),
    } as unknown as ReturnType<typeof auditLog.getAuditLog>);
    vi.spyOn(csvExport, "createExportPublicationValidator").mockReturnValue(async () => undefined);

    for (const query of ["limit=1&limit=2", "offset[]=0", "unknown=value"]) {
      expect(await get(`${path}?${query}`)).toMatchObject({ status: 400, body: { code: "invalid_usage_query" } });
    }
    expect(readPublished).not.toHaveBeenCalled();
  });

  it.each(["/api/official-usage/aggregate", "/api/official-usage/aggregate.csv"])(
    "does not silently choose a report for an ambiguous set selection at %s", async path => {
      vi.spyOn(auditLog, "getAuditLog").mockReturnValue({
        startEvent: vi.fn().mockResolvedValue({ id: "export-event" }),
        completeEvent: vi.fn().mockResolvedValue(undefined),
      } as unknown as ReturnType<typeof auditLog.getAuditLog>);
      vi.spyOn(csvExport, "createExportPublicationValidator").mockReturnValue(async () => undefined);

      for (const query of [`setId=${activeSetId}&setId=${retainedSetId}`, "setId[nested]=value"]) {
        expect(await get(`${path}?${query}`)).toMatchObject({ status: 400, body: { code: "invalid_usage_query" } });
      }
      expect(readPublished).not.toHaveBeenCalled();
    });

  it.each([
    "search=a&search=b", "sortBy=responses&sortBy=displayName", "sortDirection=asc&sortDirection=desc",
    "limit=1&limit=2", "offset=0&offset=1", `setId=${activeSetId}&setId=${retainedSetId}`,
    "search[]=user", "search[nested]=user", "limit[]=1", "setId[nested]=value", "unknown=value",
    "sortBy=agentName", "sortDirection=up",
    "limit=0", "limit=501", "limit=-1", "limit=1.5", "limit=1e2", "limit=", "limit=9007199254740992",
    "offset=-1", "offset=100001", "offset=NaN", "offset=1.5",
    `search=${"x".repeat(257)}`, "search=bad%0Atext", "search=bad%00text",
  ])("rejects duplicate, structured, unsupported or out-of-range query %s before reading reports", async query => {
    for (const path of [detailPath, usersPath]) {
      expect(await get(`${path}?${query}`)).toMatchObject({ status: 400, body: { code: "invalid_usage_query" } });
    }
    expect(readPublished).not.toHaveBeenCalled();
  });

  it.each([
    "agentId=", "agentId=%20", "agentId=Report-A&agentId=report-a", "agentId[]=Report-A", "agentId[nested]=Report-A",
    `agentId=${"x".repeat(513)}`, "agentId=bad%0Atext", "agentId=bad%00text",
  ])("rejects malformed user agent filters (%s)", async query => {
    expect(await get(`${usersPath}?${query}`)).toMatchObject({ status: 400, body: { code: "invalid_usage_query" } });
    expect(readPublished).not.toHaveBeenCalled();
  });

  it.each(["%20", "%00", "%0A", "a".repeat(513)])("rejects malformed detail path identifiers (%s)", async agentId => {
    expect(await get(`/api/official-usage/agents/${agentId}`)).toMatchObject({ status: 400, body: { code: "invalid_identifier" } });
    expect(readPublished).not.toHaveBeenCalled();
  });

  it.each([detailPath, usersPath])("validates retained-set identifiers for %s before reads", async path => {
    expect(await get(`${path}?setId=not-a-uuid`)).toMatchObject({ status: 400, body: { code: "invalid_identifier" } });
    expect(readPublished).not.toHaveBeenCalled();
  });
});

function published(setId: string, responses: number): PublishedOfficialUsage {
  const setOnlyId = setId === retainedSetId ? "retained-only" : "current-only";
  const reports: PublishedOfficialUsage["reports"] = {};
  const csvs = [
    `Agent ID,Agent name,Creator type,Active users (licensed),Active users (unlicensed),Responses sent to users,Last activity date (UTC)
Report-A,Same name,Declarative,2,2,${responses},2026-07-06
report-a,Same name,Declarative,1,0,7,2026-07-06
${setOnlyId},Set-only agent,Declarative,1,0,6,2026-07-06`,
    `Agent ID,Agent name,Creator type,Username,Responses sent to users,Last activity date (UTC)
Report-A,Same name,Declarative,CaseUser,4,2026-07-06
Report-A,Same name,Declarative,caseuser,1,2026-07-06
Report-A,Same name,Declarative,zero-user,0,2026-07-06
Other-agent,Other,Custom,CaseUser,2,2026-07-06
report-a,Same name,Declarative,only-lower,7,2026-07-06
${setOnlyId},Set-only agent,Declarative,only-set,6,2026-07-06`,
    `Username,Display name,Number of agents used,Agent responses received,Last activity date (UTC)
CaseUser,Alpha,2,50,2026-07-06
caseuser,Beta,1,4,2026-07-05
zero-user,Zero,0,0,
only-lower,Lower,1,7,2026-07-06
only-set,Set,1,6,2026-07-06
users-only,Users Only,2,200,2026-07-06`,
  ];
  const acceptedAt = "2026-07-08T12:00:00.000Z";
  for (const csv of csvs) {
    const report = parseOfficialUsageReport(Buffer.from(csv));
    const { rows, ...metadata } = report;
    const lineage = {
      ...metadata, versionId: `${setId}-${report.kind}`, fileHash: "a".repeat(64), acceptedAt,
      rowCount: rows.length, reconciliation: {}, supersedesVersionId: null,
    };
    if (report.kind === "agents") reports.agents = { ...report, lineage };
    else if (report.kind === "userAgents") reports.userAgents = { ...report, lineage };
    else reports.users = { ...report, lineage };
  }
  return {
    activeRevision: 1,
    activeSet: {
      id: setId, bundleId: setId, reportingPeriod: { startDate: "2026-07-05", endDate: "2026-07-06", provenance: "activity_range" },
      supersedesSetId: null, complete: true, kinds: ["agents", "userAgents", "users"],
      acceptedAt, deletedAt: null, createdAt: acceptedAt, expiresAt: null,
    },
    reports, retainedCompleteSets: 2, retainedIncompleteSets: 0, hasImportHistory: true, activeSelectionIncomplete: false,
  };
}

function get<T = Record<string, unknown>>(path: string, role: string | null = "viewer", tenantId?: string) {
  return new Promise<{ status: number; body?: T; text: string }>((resolve, reject) => {
    const request = httpRequest({
      host: "127.0.0.1",
      port: (server.address() as { port: number }).port,
      path,
      headers: { ...(role ? { "x-test-role": role } : {}), ...(tenantId ? { "x-test-tenant": tenantId } : {}) },
    }, response => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", chunk => { text += chunk; });
      response.on("end", () => resolve({
        status: response.statusCode!, text,
        body: response.headers["content-type"]?.includes("json") ? JSON.parse(text) as T : undefined,
      }));
    });
    request.on("error", reject);
    request.end();
  });
}
