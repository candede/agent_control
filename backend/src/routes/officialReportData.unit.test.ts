import express from "express";
import session from "express-session";
import pg from "pg";
import { request as httpRequest, type Server } from "node:http";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { config } from "../config.js";
import { errorHandler } from "../errors.js";
import { OfficialReportImports } from "../db/officialReportImports.js";
import { canonicalQuery, SelectionError, type SelectionIdentity } from "../services/dataSelections.js";
import { LargeTenantUsersReports, reportQuery, reportQueryFields, type ReportReadContext } from "../services/largeTenantUsersReports.js";
import { reportBase } from "../services/officialReportFields.js";
import { streamOfficialReport } from "../services/officialReportStream.js";
import type { ReportEndpoint, ReportQuery } from "../types/officialReportData.js";
import type { UserSourceMetadata } from "../types/userSources.js";
import { reportQueryString } from "../../../frontend/src/api/reportData.js";
import { adoptionDepartmentPage, adoptionSummaryPage } from "../../../frontend/src/test/reportDataFixture.js";
import { createOfficialReportDataRouter } from "./officialReportData.js";
import * as adoptionHistory from "../services/adoptionHistory.js";
import * as adoptionDepartments from "../services/adoptionDepartments.js";

vi.hoisted(() => {
  delete process.env.TENANTS_JSON_FILE;
  process.env.TENANTS_JSON = JSON.stringify([{
    tenantId: "11111111-1111-4111-8111-111111111111", clientId: "22222222-2222-4222-8222-222222222222",
    clientSecret: "synthetic-route-test-secret", domains: ["example.invalid"],
  }]);
  process.env.SESSION_SECRET = "synthetic-official-report-route-secret";
});
vi.mock("../services/telemetry.js", async original => ({
  ...await original<typeof import("../services/telemetry.js")>(), operationalLog: vi.fn(),
}));

const selectionId = "33333333-3333-4333-8333-333333333333";
const setId = "44444444-4444-4444-8444-444444444444";
const objectId = "55555555-5555-4555-8555-555555555555";
const identity: SelectionIdentity = { tenantId: config.tenants[0].tenantId!, principalId: "report-reader",
  authorizationHash: "viewer", sessionEpoch: "1" };
const database = new pg.Pool({ max: 4 });
const client = Object.assign(new pg.Client(), { release: vi.fn() });
const reports = new LargeTenantUsersReports(database, "synthetic-official-report-route-secret", 35);
let server: Server, saved: ReportReadContext;
let signedIn = true, roles = ["AgentControl.Admin"], identified = identity;

function source(source: UserSourceMetadata["source"]): UserSourceMetadata {
  return { source, generationId: null, scopeId: null, revision: null, expiresAt: null, observedAt: null,
    attemptedAt: null, attemptStatus: null, attemptObservedCount: null, errorCode: null, message: null,
    rowCount: null, state: "unavailable", reportRefreshDate: null, period: null, reportVersion: null };
}
function context(endpoint: ReportEndpoint, input: ReportQuery = {}): ReportReadContext {
  const query = reportQuery(endpoint, input);
  return { identity, endpoint, query, queryHash: canonicalQuery(query, reportQueryFields),
    evaluatedAt: new Date("2026-10-01T00:00:00Z"),
    selection: { id: selectionId, revision: "1", evaluatedAt: "2026-10-01T00:00:00Z", expiresAt: "2026-10-01T00:10:00Z",
      validatedAt: "2026-10-01T00:00:00Z", publicationRevisions: { graph_packages: "1".repeat(64), power_platform: "2".repeat(64), users: "3".repeat(64) } },
    metadata: { directory: source("directory"), app_activity: source("app_activity") },
    report: { setId, activeSetId: setId, activeRevision: "1", historyRevision: "1", historyEpoch: "0",
      availability: "active", staleAfterDays: 35, periodAgeDays: null, acceptedAgeDays: 0,
      reportingPeriod: null, acceptedAt: "2026-10-01T00:00:00Z", expiresAt: null, lineages: [] } };
}
function rows() {
  return { raw: [], value: [], counts: { total: 0, filtered: 0 },
    summaryRow: undefined, analyticsRow: undefined,
    page: { limit: 50, nextCursor: null, previousCursor: null } };
}

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(session({ secret: "synthetic-official-report-route-secret", resave: false, saveUninitialized: false }));
  app.use((request, _response, next) => {
    if (!signedIn) { next(); return; }
    request.session.accountId = identity.principalId;
    request.session.tenantId = identity.tenantId;
    request.session.clientId = config.tenants[0].clientId;
    request.session.rolesValidatedAt = Date.now();
    request.session.csrfToken = "fixture-csrf";
    request.session.user = { tenantId: identity.tenantId, homeAccountId: identity.principalId,
      username: "reader@example.invalid", displayName: "Reader", roles };
    next();
  });
  app.use("/api", createOfficialReportDataRouter({ reports, identity: async () => ({ identity: identified }),
    enqueueExport: async () => { throw new Error("Unexpected export dispatch"); } }));
  app.use(errorHandler);
  server = await new Promise<Server>(resolve => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
});
beforeEach(() => {
  signedIn = true; roles = ["AgentControl.Admin"]; identified = identity;
  saved = context("official_agents");
  vi.spyOn(database, "connect").mockRejectedValue(new Error("Unexpected database acquisition"));
  vi.spyOn(database, "query").mockRejectedValue(new Error("Unexpected database query"));
  vi.spyOn(client, "query").mockRejectedValue(new Error("Unexpected client query"));
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Unexpected provider request")));
  vi.spyOn(reports, "capture").mockImplementation(async (_identity, endpoint, query) => {
    saved = context(endpoint, query);
    return { ...saved.selection, endpoint: saved.endpoint, queryHash: saved.queryHash,
      evaluatedAt: saved.evaluatedAt, expiresAt: new Date(saved.selection.expiresAt) };
  });
  vi.spyOn(reports, "read").mockImplementation((_id, _identity, work) => work(client, saved));
  vi.spyOn(reports, "rowsInRead").mockImplementation(async () => rows());
  vi.spyOn(reports, "summaryInRead").mockRejectedValue(new Error("Unexpected report summary"));
  vi.spyOn(reports, "pageInRead").mockImplementation(async () => {
    throw new Error("Unexpected full report page");
  });
  vi.spyOn(reports, "exactInRead").mockImplementation(async () => ({
    value: { agentId: "agent", agentName: "Agent", creatorType: "", responses: 0, responseSource: "agents",
      activeUsers: 0, activeUsersBasis: "userAgents_distinct_identity", licensedUserOccurrences: 0,
      unlicensedUserOccurrences: 0, lastActivityDateUtc: null, reportResponses: 0, bridgeResponses: 0,
      relationshipCount: 0, responseComparison: "matching", identityStatus: "unresolved" },
    selection: saved.selection, reports: saved.report, sources: saved.metadata,
  }));
});
afterEach(() => {
  try {
    expect(database.connect).not.toHaveBeenCalled();
    expect(database.query).not.toHaveBeenCalled();
    expect(client.query).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  } finally { vi.restoreAllMocks(); vi.unstubAllGlobals(); }
});
afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  await database.end();
});

function allowPage() {
  vi.mocked(reports.pageInRead).mockResolvedValue({
    ...rows(), selection: saved.selection, reports: saved.report, sources: saved.metadata,
    filters: saved.query, summary: { checkedUsers: null, licensedUsers: null, measuredActivityUsers: null,
      needsAttentionUsers: null, usingAgentsUsers: null, noAgentActivityUsers: null, unknownMetricsUsers: null,
      unresolvedIdentities: 0, activeWithoutPaidUsers: null, paidActiveReportUsers: null, unknownLicenseActiveReportUsers: 0,
      reportedResponses: null, bridgeResponses: null, userReportedResponses: null, distinctActiveReportUsers: null,
      licensedOccurrences: null, unlicensedOccurrences: null, responseReconciliation: "not_comparable", activeUsersAreNonAdditive: true },
    analytics: { basis: "filtered_rows", rowCount: 0, responses: null, zeroResponses: null, unknownResponses: null,
      review: null, agents: null, history: null, overview: null },
  });
  return vi.spyOn(reports, "page");
}

describe("department adoption HTTP contract", () => {
  it.each(["AgentControl.Viewer", "AgentControl.Admin"])("serves aggregate saved departments to %s", async role => {
    roles = [role];
    const read = vi.spyOn(adoptionDepartments, "readAdoptionDepartments").mockResolvedValue({
      ...adoptionDepartmentPage(),
      value: [], counts: { total: 0, filtered: 0 }, page: { limit: 8, number: 1, offset: 0, nextCursor: null, previousCursor: null },
      directory: source("directory"),
      selection: context("adoption_departments").selection, reports: context("adoption_departments").report,
    });
    expect(await request("GET", "/copilot-usage/adoption/departments?company=~string%3AContoso&limit=8")).toMatchObject({ status: 200 });
    expect(reports.capture).toHaveBeenCalledExactlyOnceWith(identity, "adoption_departments",
      reportQuery("adoption_departments", { company: "Contoso" }));
    expect(read).toHaveBeenCalledExactlyOnceWith(client, reports, expect.objectContaining({ endpoint: "adoption_departments",
      query: expect.objectContaining({ sort: "adoptionRate", order: "desc" }) }), { limit: 8 });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("passes direct page requests through the same saved department selection", async () => {
    saved = context("adoption_departments");
    const read = vi.spyOn(adoptionDepartments, "readAdoptionDepartments").mockResolvedValue({
      ...adoptionDepartmentPage(), selection: saved.selection, reports: saved.report,
      page: { limit: 10, number: 7, offset: 60, nextCursor: "next", previousCursor: "previous" },
    });
    expect(await request("GET", `/copilot-usage/adoption/departments?selectionId=${selectionId}&pageNumber=7&limit=10`))
      .toMatchObject({ status: 200, body: { page: { number: 7, offset: 60 } } });
    expect(reports.capture).not.toHaveBeenCalled();
    expect(reports.read).toHaveBeenCalledWith(selectionId, identity, expect.any(Function));
    expect(read).toHaveBeenCalledExactlyOnceWith(client, reports, saved, { limit: 10, pageNumber: 7 });
  });

  it.each(["pageNumber=0", "pageNumber=-1", "pageNumber=2.5", "pageNumber=text", "pageNumber=",
    "pageNumber=9007199254740992", "pageNumber[]=2", "pageNumber=1&pageNumber=2",
    "pageNumber=1&cursor=next"])("rejects invalid department position %s before capturing data", async query => {
    const read = vi.spyOn(adoptionDepartments, "readAdoptionDepartments");
    expect(await request("GET", `/copilot-usage/adoption/departments?${query}`)).toMatchObject({ status: 400 });
    expect(reports.capture).not.toHaveBeenCalled();
    expect(reports.read).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });

  it("reads organization metrics separately without allowing department filters or cursors", async () => {
    const read = vi.spyOn(adoptionDepartments, "readAdoptionSummary").mockResolvedValue(adoptionSummaryPage());
    expect(await request("GET", "/copilot-usage/adoption/summary?limit=1")).toMatchObject({ status: 200 });
    expect(read).toHaveBeenCalledExactlyOnceWith(client, reports, expect.objectContaining({ endpoint: "adoption" }));
    for (const query of ["company=Contoso", "cursor=next", "order=asc"]) {
      expect(await request("GET", `/copilot-usage/adoption/summary?${query}`)).toMatchObject({ status: 400 });
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("retains normal authentication and rejects unrelated filters", async () => {
    signedIn = false;
    expect(await request("GET", "/copilot-usage/adoption/summary")).toMatchObject({ status: 401 });
    expect(await request("GET", "/copilot-usage/adoption/departments")).toMatchObject({ status: 401 });
    signedIn = true;
    expect(await request("GET", "/copilot-usage/adoption/summary?cohort=licensed")).toMatchObject({ status: 400 });
    expect(await request("GET", "/copilot-usage/adoption/departments?sort=name")).toMatchObject({ status: 400 });
  });
});

describe("retained adoption history HTTP contract", () => {
  let read: ReturnType<typeof vi.spyOn<typeof adoptionHistory, "readAdoptionHistory">>;
  beforeEach(() => {
    saved = context("adoption_history");
    read = vi.spyOn(adoptionHistory, "readAdoptionHistory").mockImplementation(async (_client, _reports, context, options) => ({
      value: [], reports: context.report, selection: context.selection, counts: { total: 0, filtered: 0 },
      page: { limit: options?.limit ?? 50, nextCursor: null, previousCursor: null },
    }));
  });
  it.each(["AgentControl.Viewer", "AgentControl.UsageReportUploader", "AgentControl.Admin"])("serves saved adoption to %s without provider or source reads", async role => {
    roles = [role];
    expect(await request("GET", "/official-usage/history/adoption?limit=100")).toMatchObject({
      status: 200, body: { value: [], counts: { total: 0, filtered: 0 }, page: { limit: 100 } },
    });
    expect(reports.capture).toHaveBeenCalledExactlyOnceWith(identity, "adoption_history", {});
    expect(read).toHaveBeenCalledExactlyOnceWith(client, reports, saved, { limit: 100 });
  });
  it.each([
    "setId=44444444-4444-4444-8444-444444444444", "scope=history", "startDate=2025-01-01", "search=user",
    "sort=reportingPeriod", "company=Contoso", "tenantId=foreign", "all=true", "offset=0",
    "limit=0", "limit=101", "limit=1.5", "limit=1&limit=2", "cursor=a&cursor=b",
    "selectionId=invalid", "selectionId=one&selectionId=two",
  ])("rejects malformed or filtered intent before capture: %s", async query => {
    expect(await request("GET", `/official-usage/history/adoption?${query}`)).toMatchObject({ status: 400 });
    expect(reports.capture).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });
  it("reuses the frozen selection explicitly or from a continuation", async () => {
    const cursor = reports.codec.encode({ identity, endpoint: "adoption_history", selectionId, revision: saved.selection.revision,
      queryHash: saved.queryHash, direction: "next", boundary: { key: "1/2025-01-01", id: setId, nullRank: 0 } });
    for (const query of [`selectionId=${selectionId}`, `cursor=${cursor}`]) {
      expect(await request("GET", `/official-usage/history/adoption?${query}`)).toMatchObject({ status: 200 });
    }
    expect(reports.capture).not.toHaveBeenCalled();
    expect(read).toHaveBeenCalledTimes(2);
    expect(read.mock.calls[1][3]).toEqual({ limit: 50, cursor });
  });
  it("rejects a foreign report selection without recapture", async () => {
    saved = context("history");
    expect(await request("GET", `/official-usage/history/adoption?selectionId=${selectionId}`)).toMatchObject({
      status: 400, body: { code: "invalid_cursor" },
    });
    expect(read).not.toHaveBeenCalled();
    expect(reports.capture).not.toHaveBeenCalled();
  });
  it("propagates deleted, corrected, expired, or damaged selection invalidation without a fallback", async () => {
    vi.mocked(reports.read).mockRejectedValue(new SelectionError("selection_invalidated"));
    expect(await request("GET", `/official-usage/history/adoption?selectionId=${selectionId}`)).toMatchObject({
      status: 409, body: { code: "selection_invalidated" },
    });
    expect(read).not.toHaveBeenCalled();
    expect(reports.capture).not.toHaveBeenCalled();
  });
  it("requires a real authenticated application role", async () => {
    roles = [];
    expect(await request("GET", "/official-usage/history/adoption")).toMatchObject({
      status: 403, body: { code: "missing_internal_role" },
    });
    signedIn = false;
    expect(await request("GET", "/official-usage/history/adoption")).toMatchObject({ status: 401 });
    expect(reports.capture).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });
  it.each(["tenantId", "principalId"] as const)("rejects an injected %s mismatch", async key => {
    identified = { ...identity, [key]: "foreign" };
    expect(await request("GET", "/official-usage/history/adoption")).toMatchObject({ status: 401 });
    expect(reports.capture).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });
});

describe("report query HTTP contracts", () => {
  it.each(["official-usage/overview", "official-usage/aggregate", "official-usage/users", "official-usage/agent-users", "copilot-usage/users"])(
    "rejects PostgreSQL's unsupported year zero before capturing %s", async path => {
      for (const field of ["startDate", "endDate"]) {
        expect(await request("GET", `/${path}?${field}=0000-01-01`))
          .toMatchObject({ status: 400, body: { code: "invalid_cursor" } });
      }
      expect(reports.capture).not.toHaveBeenCalled();
      expect(reports.pageInRead).not.toHaveBeenCalled();
    },
  );

  it.each(["", "/service-plans", "/agents"])("canonicalizes Graph directory GUIDs for exact Users%s reads", async child => {
    const objectId = "AAAAAAAA-AAAA-7AAA-1AAA-AAAAAAAAAAAA";
    saved = context("copilot_users");
    allowPage();
    expect(await request("GET", `/copilot-usage/users/${objectId}${child}${reportQueryString({ selectionId })}`))
      .toMatchObject({ status: 200 });
    expect(reports.exactInRead).toHaveBeenCalledWith(client, saved, objectId.toLowerCase());
    if (child) expect(reports.pageInRead).toHaveBeenCalledWith(client, saved, expect.objectContaining({
      endpoint: child === "/agents" ? "relationships" : "plans", child: objectId.toLowerCase(),
    }));
  });

  it("preserves opaque reported-user GUID spelling instead of treating it as a directory ID", async () => {
    const username = "AAAAAAAA-AAAA-7AAA-1AAA-AAAAAAAAAAAA";
    saved = context("official_users");
    expect(await request("GET", `/official-usage/users/${username}${reportQueryString({ selectionId })}`))
      .toMatchObject({ status: 200 });
    expect(reports.exactInRead).toHaveBeenCalledExactlyOnceWith(client, saved, username);
  });

  it.each([
    "/official-usage/agents/Agent%C2%85", "/official-usage/agents/Agent%09/users",
    "/official-usage/users/User%C2%85", "/official-usage/users/User%09/agents",
  ])("rejects malformed exact path identities before capturing a selection: %s", async path => {
    expect(await request("GET", path)).toMatchObject({ status: 400, body: { code: "invalid_usage_query" } });
    expect(reports.capture).not.toHaveBeenCalled();
    expect(reports.exactInRead).not.toHaveBeenCalled();
  });

  it("canonicalizes a historical set UUID before checking cohort membership and reading observations", async () => {
    const historicalSetId = "ABCDEFAB-1234-4567-89AB-ABCDEFABCDEF";
    saved = context("history");
    allowPage();
    expect(await request("GET", `/official-usage/history/${historicalSetId}/observations${reportQueryString({ selectionId })}`))
      .toMatchObject({ status: 200 });
    expect(reports.exactInRead).toHaveBeenCalledExactlyOnceWith(client, saved, historicalSetId.toLowerCase());
    expect(reports.pageInRead).toHaveBeenCalledExactlyOnceWith(client, saved, {
      limit: 50, endpoint: "observations", child: historicalSetId.toLowerCase(),
    });
  });

  it.each([
    ["official-usage/aggregate", "official_agents"],
    ["official-usage/users", "official_users"],
    ["copilot-usage/users", "copilot_users"],
    ["official-usage/history", "history"],
    ["official-usage/overview", "overview"],
  ] as const)("retains an immutable %s selection when the report-set UUID changes casing", async (path, endpoint) => {
    const historicalSetId = "abcdefab-1234-4567-89ab-abcdefabcdef";
    saved = context(endpoint, { setId: historicalSetId });
    allowPage();
    expect(await request("GET", `/${path}${reportQueryString({ selectionId, setId: historicalSetId.toUpperCase() })}`))
      .toMatchObject({ status: 200 });
    expect(reports.capture).not.toHaveBeenCalled();
    expect(await request("GET", `/${path}${reportQueryString({ selectionId, setId })}`))
      .toMatchObject({ status: 400, body: { code: "invalid_cursor" } });
    expect(reports.pageInRead).toHaveBeenCalledOnce();
  });

  it.each(["official-usage/aggregate", "official-usage/users", "copilot-usage/users", "official-usage/agent-users"])(
    "round-trips a literal empty creator type through %s", async path => {
      allowPage();
      expect(await request("GET", `/${path}${reportQueryString({ creatorType: "" })}`)).toMatchObject({ status: 200 });
      expect(reports.capture).toHaveBeenCalledWith(identity, expect.any(String),
        expect.objectContaining({ creatorType: "" }));
    },
  );
  it.each(["creatorType=&creatorType=Custom", "creatorType=%00", "creatorType=Custom%0BAgent", "creatorType=Custom%C2%85Agent",
    `creatorType=${"x".repeat(257)}`, "agentId=", "agentId=Agent%09ID", "limit="])(
    "still rejects malformed scalars: %s", async query => {
      expect(await request("GET", `/official-usage/aggregate?${query}`)).toMatchObject({ status: 400 });
      expect(reports.capture).not.toHaveBeenCalled();
    },
  );
  it("retains literal creator-type values and their length boundary", async () => {
    allowPage();
    for (const creatorType of ["~null", "~string:", "x".repeat(256)]) {
      expect(await request("GET", `/official-usage/aggregate${reportQueryString({ creatorType })}`)).toMatchObject({ status: 200 });
      expect(reports.capture).toHaveBeenLastCalledWith(identity, "official_agents",
        reportQuery("official_agents", { creatorType }));
    }
  });
  it.each(["Custom\tAgent", "Custom\nAgent", "Custom\r\nAgent"])(
    "round-trips imported creator-type whitespace through capture and selected rereads: %j", async creatorType => {
      allowPage();
      for (const [path, endpoint] of [
        ["official-usage/aggregate", "official_agents"],
        ["official-usage/users", "official_users"],
        ["copilot-usage/users", "copilot_users"],
        ["official-usage/agent-users", "relationships"],
      ] as const) {
        expect(await request("GET", `/${path}${reportQueryString({ creatorType })}`))
          .toMatchObject({ status: 200 });
        expect(reports.capture).toHaveBeenLastCalledWith(identity, endpoint,
          expect.objectContaining({ creatorType }));
        expect(await request("GET", `/${path}${reportQueryString({ selectionId, creatorType })}`))
          .toMatchObject({ status: 200 });
        expect(saved.query.creatorType).toBe(creatorType);
      }
    },
  );
  it("reuses an immutable empty creator-type filter", async () => {
    saved = context("official_agents", { creatorType: "" });
    allowPage();
    expect(await request("GET", `/official-usage/aggregate${reportQueryString({ selectionId, creatorType: "" })}`))
      .toMatchObject({ status: 200 });
    expect(await request("GET", `/official-usage/aggregate${reportQueryString({ selectionId, creatorType: "Custom" })}`))
      .toMatchObject({ status: 400, body: { code: "invalid_cursor" } });
    expect(reports.capture).not.toHaveBeenCalled();
  });
  it("keeps the compact history route ahead of parameterized history paths", async () => {
    const response = await request("GET", "/official-usage/history/options");
    expect(response).toMatchObject({ status: 200, body: { value: [], selection: { id: selectionId } } });
    expect(Object.keys(response.body).sort()).toEqual(["counts", "page", "reports", "selection", "value"]);
    expect(reports.capture).toHaveBeenCalledWith(identity, "history", reportQuery("history"));
    expect(reports.pageInRead).not.toHaveBeenCalled();
    expect(reports.summaryInRead).not.toHaveBeenCalled();
  });
});

describe.each([
  [`/copilot-usage/users/${objectId}/agents`, "copilot_users"],
  ["/official-usage/agents/agent/users", "official_agents"],
  ["/official-usage/users/user%40example.invalid/agents", "official_users"],
] as const)("relationship parent selection: %s", (path, endpoint) => {
  beforeEach(() => {
    saved = context(endpoint);
    allowPage();
  });
  it("captures the requested historical set without applying child filters to the parent", async () => {
    expect(await request("GET", `${path}${reportQueryString({ setId, search: "Child", sort: "creatorType" })}`))
      .toMatchObject({ status: 200 });
    expect(reports.capture).toHaveBeenCalledExactlyOnceWith(identity, endpoint, reportQuery(endpoint, { setId }));
    const options = endpoint === "copilot_users" ? vi.mocked(reports.pageInRead).mock.calls[0][2] : vi.mocked(reports.page).mock.calls[0][2];
    expect(options?.childQuery).toEqual(reportQuery("relationships", { search: "Child", sort: "creatorType" }));
  });
  it("accepts the pinned set independently of the parent's row filters", async () => {
    saved = context(endpoint, { search: "Parent" });
    expect(await request("GET", `${path}${reportQueryString({ selectionId, setId, search: "Child" })}`))
      .toMatchObject({ status: 200 });
    expect(reports.capture).not.toHaveBeenCalled();
  });
  it("recovers the pinned selection from a continuation without repeating setId", async () => {
    const childFilters = { creatorType: "", sort: "responses" as const, order: "desc" as const };
    expect(await request("GET", `${path}${reportQueryString({ setId, ...childFilters })}`)).toMatchObject({ status: 200 });
    const firstOptions = vi.mocked(reports.pageInRead).mock.calls[0][2];
    const cursor = reports.codec.encode({ identity, endpoint: `relationships:${firstOptions?.child}`,
      selectionId, revision: saved.selection.revision, queryHash: "a".repeat(64), direction: "next",
      boundary: { id: "first", key: "0", nullRank: 0 } });
    expect(await request("GET", `${path}${reportQueryString({ cursor, ...childFilters })}`)).toMatchObject({ status: 200 });
    expect(reports.capture).toHaveBeenCalledOnce();
    expect(vi.mocked(reports.pageInRead).mock.calls[1][2]).toEqual({ ...firstOptions, cursor });
    expect(reports.read).toHaveBeenCalledWith(selectionId, identity, expect.any(Function));
  });
  it("propagates an unavailable historical set without falling back to the active report", async () => {
    vi.mocked(reports.capture).mockRejectedValue(new SelectionError("selection_invalidated"));
    expect(await request("GET", `${path}${reportQueryString({ setId })}`))
      .toMatchObject({ status: 409, body: { code: "selection_invalidated" } });
    expect(reports.capture).toHaveBeenCalledExactlyOnceWith(identity, endpoint, reportQuery(endpoint, { setId }));
    expect(reports.exactInRead).not.toHaveBeenCalled();
    expect(reports.pageInRead).not.toHaveBeenCalled();
  });
  it("rejects switching a pinned selection to another set", async () => {
    expect(await request("GET", `${path}${reportQueryString({ selectionId, setId: objectId })}`))
      .toMatchObject({ status: 400, body: { code: "invalid_cursor" } });
    expect(reports.exactInRead).not.toHaveBeenCalled();
    expect(reports.page).not.toHaveBeenCalled();
  });
  it.each(["setId=bad", "setId=one&setId=two", "search=a&search=b", "sort=acceptedAt", "company=Contoso"])(
    "rejects malformed parent/child intent before capturing: %s", async query => {
      expect(await request("GET", `${path}?${query}`)).toMatchObject({ status: 400 });
      expect(reports.capture).not.toHaveBeenCalled();
      expect(reports.exactInRead).not.toHaveBeenCalled();
    },
  );
});

describe("report confirmation HTTP input", () => {
  it.each([`/official-usage/sets/${setId}/preview`, `/official-usage/confirmations/${selectionId}`])(
    "rejects a missing body as a client error: %s", async path => {
      expect(await request("POST", path)).toMatchObject({ status: 400 });
    },
  );
  it.each([null, {}, []])("rejects malformed confirmation bodies: %j", async body => {
    for (const path of [`/official-usage/sets/${setId}/preview`, `/official-usage/confirmations/${selectionId}`]) {
      expect(await request("POST", path, body)).toMatchObject({ status: 400 });
    }
  });
  it("previews and confirms an actor-bound deletion", async () => {
    const confirmation = { id: selectionId, setId, operation: "delete" as const, activeRevision: "1",
      historyRevision: "1", historyEpoch: "0", hash: "a".repeat(64) };
    const preview = vi.spyOn(OfficialReportImports.prototype, "previewDeletion").mockResolvedValue(confirmation);
    expect(await request("POST", `/official-usage/sets/${setId}/preview`, { operation: "delete" }))
      .toMatchObject({ status: 200, body: confirmation });
    expect(preview).toHaveBeenCalledExactlyOnceWith(identity, setId);
    const confirm = vi.spyOn(OfficialReportImports.prototype, "confirmDeletion").mockResolvedValue({ activeSetId: setId, activeRevision: "2" });
    expect(await request("POST", `/official-usage/confirmations/${selectionId}`, confirmation)).toMatchObject({ status: 200 });
    expect(confirm).toHaveBeenCalledExactlyOnceWith(identity, confirmation);
  });
  it("rejects the removed tenant selection operation before preview or persistence", async () => {
    const preview = vi.spyOn(OfficialReportImports.prototype, "previewDeletion");
    const confirm = vi.spyOn(OfficialReportImports.prototype, "confirmDeletion");
    expect(await request("POST", `/official-usage/sets/${setId}/preview`, { operation: "select" }))
      .toMatchObject({ status: 400, body: { code: "invalid_operation" } });
    expect(await request("POST", `/official-usage/confirmations/${selectionId}`, {
      id: selectionId, setId, operation: "select", activeRevision: "1", historyRevision: "1", historyEpoch: "0", hash: "a".repeat(64),
    })).toMatchObject({ status: 400, body: { code: "invalid_operation" } });
    expect(preview).not.toHaveBeenCalled();
    expect(confirm).toHaveBeenCalledOnce();
  });
});

describe("report uploader HTTP role boundaries", () => {
  const bundle = { bundleId: setId, bundleHash: "a".repeat(64), expectedActiveRevision: "1", stages: [], complete: true };
  const accepted = { setId, activeRevision: "2", complete: true };
  const preview = { id: selectionId, revision: 1, kind: "users" as const, bundleId: setId, contentHash: "a".repeat(64),
    fileHash: "b".repeat(64), rowCount: 0, storedBytes: 2, wireBytes: 100, activeRevision: "1",
    expiresAt: "2026-10-01T01:00:00Z", reportingPeriod: { startDate: null, endDate: null, provenance: "activity_range", days: null },
    sourceAsOf: null, sourceAsOfProvenance: "absent", sourceFreshness: "unknown", correctionOfSetId: null,
    status: "active", examples: [], warnings: [], reconciliation: {} };

  it.each(["AgentControl.UsageReportUploader", "AgentControl.Admin"])("allows new report upload, review, publication and own draft cleanup for %s", async role => {
    roles = [role];
    const opened = vi.spyOn(OfficialReportImports.prototype, "open").mockImplementation(async () => ({
      id: selectionId, signal: new AbortController().signal, cancel: async () => {},
      receive: async input => {
        for await (const chunk of input) void chunk;
        return { kind: "users", rows: 0, wireBytes: 100 };
      },
      finish: async () => preview,
    }));
    const boundary = "role-upload";
    const value = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="users.csv"\r\nContent-Type: text/csv\r\n\r\nCSV\r\n--${boundary}--\r\n`;
    expect(await request("POST", `/official-usage/staging?bundleId=${setId}`, undefined,
      { value, type: `multipart/form-data; boundary=${boundary}` })).toMatchObject({ status: 201 });
    expect(opened).toHaveBeenCalledWith(identity, { bundleId: setId, rejectDuplicateKind: false }, expect.any(AbortSignal));
    vi.spyOn(OfficialReportImports.prototype, "preview").mockResolvedValue(preview);
    vi.spyOn(OfficialReportImports.prototype, "bundle").mockResolvedValue(bundle);
    vi.spyOn(OfficialReportImports.prototype, "acceptBundle").mockResolvedValue(accepted);
    vi.spyOn(OfficialReportImports.prototype, "accept").mockResolvedValue(accepted);
    vi.spyOn(OfficialReportImports.prototype, "discard").mockResolvedValue(undefined);
    vi.spyOn(OfficialReportImports.prototype, "diagnostics").mockResolvedValue({
      value: [], page: { limit: 50, nextCursor: null, previousCursor: null },
    });
    for (const [method, path, body] of [
      ["GET", `/official-usage/staging/${selectionId}`],
      ["GET", `/official-usage/staging/${selectionId}/diagnostics`],
      ["POST", `/official-usage/bundles/${setId}/preview`, {}],
      ["POST", `/official-usage/bundles/${setId}/accept`, bundle],
      ["POST", `/official-usage/staging/${selectionId}/accept`, {}],
    ] as const) expect(await request(method, path, body)).toMatchObject({ status: 200 });
    expect(await request("DELETE", `/official-usage/staging/${selectionId}`)).toMatchObject({ status: 204 });
  });

  it("denies correction upload intent before starting multipart ingestion", async () => {
    roles = ["AgentControl.UsageReportUploader"];
    const opened = vi.spyOn(OfficialReportImports.prototype, "open");
    expect(await request("POST", `/official-usage/staging?bundleId=${setId}&correctionOfSetId=${selectionId}`))
      .toMatchObject({ status: 403, body: { code: "missing_internal_role" } });
    expect(opened).not.toHaveBeenCalled();
  });

  it.each(["AgentControl.Viewer", "AgentControl.UsageReportUploader"])("keeps published report management and associations Admin-only for %s", async role => {
    roles = [role];
    for (const [method, path] of [
      ["POST", `/official-usage/sets/${setId}/preview`],
      ["POST", `/official-usage/confirmations/${selectionId}`],
      ["GET", `/agent-inventory/${objectId}/usage-candidates`],
      ["POST", `/agent-inventory/${objectId}/usage-associations`],
      ["DELETE", `/agent-inventory/${objectId}/usage-associations`],
    ]) expect(await request(method, path, {})).toMatchObject({ status: 403, body: { code: "missing_internal_role" } });
  });

  it("does not grant any import routes to ordinary Viewers", async () => {
    roles = ["AgentControl.Viewer"];
    for (const [method, path] of [
      ["POST", `/official-usage/staging?bundleId=${setId}`],
      ["GET", `/official-usage/staging/${selectionId}`],
      ["GET", `/official-usage/staging/${selectionId}/diagnostics`],
      ["POST", `/official-usage/bundles/${setId}/preview`],
      ["POST", `/official-usage/bundles/${setId}/accept`],
      ["POST", `/official-usage/staging/${selectionId}/accept`],
      ["DELETE", `/official-usage/staging/${selectionId}`],
    ]) expect(await request(method, path, {})).toMatchObject({ status: 403, body: { code: "missing_internal_role" } });
  });

  it("keeps upload authentication and CSRF checks authoritative", async () => {
    signedIn = false;
    expect(await request("POST", `/official-usage/staging?bundleId=${setId}`)).toMatchObject({ status: 401 });
    signedIn = true; roles = ["AgentControl.UsageReportUploader"];
    expect(await request("POST", `/official-usage/bundles/${setId}/accept`, {}, undefined, "wrong-csrf"))
      .toMatchObject({ status: 403, body: { code: "invalid_csrf" } });
  });
});

describe("report multipart metadata validation without persistence", () => {
  function upload(fields: Array<[string, string]>) {
    const cancelled = vi.fn(async () => {});
    vi.spyOn(OfficialReportImports.prototype, "open").mockImplementation(async () => {
      const controller = new AbortController();
      return {
        id: selectionId, signal: controller.signal, cancel: cancelled,
        receive: async input => {
          const report = await streamOfficialReport(input, undefined, controller.signal, { batch: async () => {} });
          return { kind: report.kind, rows: report.rowCount, wireBytes: report.wireBytes };
        },
        finish: async metadata => {
          reportBase("users", metadata, []);
          throw new Error("Unexpected successful import");
        },
      };
    });
    const boundary = "official-report-fixture";
    const value = [
      ...fields.map(([name, value]) => `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`),
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="users.csv"\r\nContent-Type: text/csv\r\n\r\nUsername,Display name,Number of agents used,Agent responses received,Last activity date (UTC)\r\n`,
      `--${boundary}--\r\n`,
    ].join("");
    return { cancelled, response: request("POST", `/official-usage/staging?bundleId=${setId}`, undefined,
      { value, type: `multipart/form-data; boundary=${boundary}` }) };
  }

  it.each(([
    [["downloadedAt", ""]], [["sourceAsOf", ""], ["sourceAsOfProvenance", ""]],
    [["sourceAsOf", ""]], [["sourceAsOfProvenance", "operator_asserted"]],
    [["downloadedAt", "2026-02-30T12:00:00Z"]], [["downloadedAt", "2026-07-08T12:00:00"]],
    [["reportingStart", "2026-06-08"], ["reportingEnd", "2026-07-06"], ["periodProvenance", "operator_asserted"]],
  ] satisfies Array<Array<[string, string]>>).map(fields => ({ fields })))("returns actionable 400 errors rather than dropping assertions or reporting 500: %j", async ({ fields }) => {
    const { response, cancelled } = upload(fields);
    expect(await response).toMatchObject({ status: 400, body: {
      code: fields.some(([key]) => key === "reportingStart") ? "invalid_reporting_period" : "invalid_metadata",
    } });
    expect(cancelled).toHaveBeenCalledOnce();
  });
});

describe("report multipart parser error contracts without persistence", () => {
  const header = "Username,Display name,Number of agents used,Agent responses received,Last activity date (UTC)\n";
  it.each([
    ["Username,Unknown\n", "schema_drift"],
    [header.replace("Display name", "username"), "duplicate_header"],
    [`${header}user,"unterminated`, "invalid_csv"],
    [`${header}first,First,9007199254740991,0,\nsecond,Second,1,0,\n`, "numeric_overflow"],
    [`${header}user,Name,1,-1,\n`, "invalid_number"],
    [`${header}user,Name,1,1,2026-02-30\n`, "invalid_date"],
    [`${header}user,Name,1,1,\0\n`, "invalid_content"],
    [`${header}user,${" ".repeat(4097)},1,1,\n`, "field_limit_exceeded"],
  ])("returns the actionable parser code through real multipart handling (case %#)", async (csv, code) => {
    const cancelled = vi.fn(async () => {});
    vi.spyOn(OfficialReportImports.prototype, "open").mockImplementation(async (_identity, _intent, parent) => {
      const signal = parent ?? new AbortController().signal;
      return {
        id: selectionId, signal, cancel: cancelled,
        receive: async input => {
          const report = await streamOfficialReport(input, undefined, signal, { batch: async () => {} });
          return { kind: report.kind, rows: report.rowCount, wireBytes: report.wireBytes };
        },
        finish: async () => { throw new Error("Unexpected parser acceptance."); },
      };
    });
    const boundary = "official-parser-fixture";
    const value = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="users.csv"\r\nContent-Type: text/csv\r\n\r\n${csv}\r\n--${boundary}--\r\n`;
    expect(await request("POST", `/official-usage/staging?bundleId=${setId}`, undefined,
      { value, type: `multipart/form-data; boundary=${boundary}` })).toMatchObject({ status: 400, body: { code } });
    expect(cancelled).toHaveBeenCalled();
  });
});

function request(method: string, path: string, body?: unknown, raw?: { value: string; type: string }, csrf = "fixture-csrf"): Promise<{ status: number; body: Record<string, unknown> }> {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture address");
  const content = raw?.value ?? (body === undefined ? undefined : JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const message = httpRequest({ host: "127.0.0.1", port: address.port, method, path: `/api${path}`,
      headers: { "x-csrf-token": csrf,
        ...(content ? { "Content-Type": raw?.type ?? "application/json", "Content-Length": Buffer.byteLength(content) } : {}) },
    }, response => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", chunk => { text += chunk; });
      response.on("end", () => resolve({ status: response.statusCode!, body: text ? JSON.parse(text) : {} }));
    });
    message.once("error", reject);
    message.end(content);
  });
}
