import pg from "pg";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { digest } from "../db/dataBounds.js";
import type { ReportEndpoint, ReportQuery } from "../types/officialReportData.js";
import type { UserSourceMetadata } from "../types/userSources.js";
import { readAdoptionDepartments, readAdoptionSummary } from "./adoptionDepartments.js";
import { adoptionDataset } from "./adoptionGroups.js";
import { canonicalQuery, type CursorBoundary } from "./dataSelections.js";
import { LargeTenantUsersReports, reportQuery, reportQueryFields, type ReportReadContext } from "./largeTenantUsersReports.js";

const database = new pg.Pool({ max: 4 });
const reports = new LargeTenantUsersReports(database, "synthetic-adoption-departments-unit-secret", 35);
const at = new Date("2026-10-01T00:00:00Z");

function source(source: UserSourceMetadata["source"]): UserSourceMetadata {
  return { source, generationId: null, scopeId: null, revision: null, expiresAt: null, observedAt: null,
    attemptedAt: null, attemptStatus: null, attemptObservedCount: null, errorCode: null, message: null,
    rowCount: null, state: "unavailable", reportRefreshDate: null, period: null, reportVersion: null };
}
function context(endpoint: ReportEndpoint = "adoption_departments", input: ReportQuery = {}): ReportReadContext {
  const query = reportQuery(endpoint, input);
  return { identity: { tenantId: "tenant", principalId: "reader", authorizationHash: "viewer", sessionEpoch: "1" },
    tokenMode: "delegated", endpoint, query, queryHash: canonicalQuery(query, reportQueryFields), evaluatedAt: at,
    selection: { id: "11111111-1111-4111-8111-111111111111", revision: "1", evaluatedAt: at.toISOString(),
      validatedAt: at.toISOString(), expiresAt: "2026-10-01T00:10:00Z",
      publicationRevisions: { graph_packages: "1".repeat(64), power_platform: "2".repeat(64), users: "3".repeat(64) } },
    metadata: { directory: { ...source("directory"), state: "available", rowCount: 5 }, app_activity: source("app_activity") },
    report: { setId: "22222222-2222-4222-8222-222222222222", activeSetId: null, activeRevision: "1",
      historyRevision: "1", historyEpoch: "0", availability: "stale", staleAfterDays: 35, periodAgeDays: 60,
      acceptedAgeDays: 0, reportingPeriod: null, acceptedAt: at.toISOString(), expiresAt: null,
      lineages: (["users", "userAgents", "agents"] as const).map(kind => ({
        kind, versionId: `version-${kind}`, contentHash: digest(kind), rowCount: 5, sourceAsOf: null,
        sourceAsOfProvenance: "unknown", sourceFreshness: "unknown", periodProvenance: "unknown",
      })) } };
}
function result(rows: pg.QueryResultRow[]): pg.QueryResult {
  return { command: "SELECT", rowCount: rows.length, fields: [], oid: 0, rows };
}
function fixture(saved = context()) {
  const client = Object.assign(new pg.Client(), { release: vi.fn() });
  const query = vi.fn<(sql: string, values?: unknown[]) => Promise<pg.QueryResult>>()
    .mockRejectedValue(new Error("Unexpected selected query"));
  vi.spyOn(client, "query").mockImplementation(query);
  return { client, query, saved };
}
function department(position: number) {
  return { position: String(position), identity: digest(String(position)), company: "Contoso",
    department: `Department ${position}`, people: "5", active_people: "2" };
}
function cursorContract(saved: ReportReadContext, limit: number) {
  return { identity: saved.identity, endpoint: "adoption_departments", selectionId: saved.selection.id,
    revision: saved.selection.revision, queryHash: digest(JSON.stringify([saved.queryHash, limit])) };
}

beforeEach(() => {
  vi.spyOn(database, "connect").mockRejectedValue(new Error("Unexpected database acquisition"));
  vi.spyOn(database, "query").mockRejectedValue(new Error("Unexpected unscoped query"));
});
afterEach(() => {
  expect(database.connect).not.toHaveBeenCalled();
  expect(database.query).not.toHaveBeenCalled();
  vi.restoreAllMocks();
});
afterAll(async () => { await database.end(); });

describe("department participation selected reads", () => {
  it.each(["asc", "desc"] as const)("projects bounded %s aggregates without loading group members", async order => {
    const saved = context("adoption_departments", { company: "O'Brien", order });
    const { client, query } = fixture(saved);
    query.mockResolvedValueOnce(result([{ total: "4", filtered: "1" }]))
      .mockResolvedValueOnce(result([{ ...department(1), company: null, department: null, active_people: "0" }]));
    const page = await readAdoptionDepartments(client, reports, saved, { limit: 8 });
    expect(page.value).toEqual([{ id: department(1).identity, company: null, department: null, people: 5, activePeople: 0 }]);
    expect(page.counts).toEqual({ total: 4, filtered: 1 });
    expect(page.page).toEqual({ limit: 8, number: 1, offset: 0, nextCursor: null, previousCursor: null });
    expect(Object.keys(page).sort()).toEqual(["counts", "directory", "page", "reports", "selection", "value"]);
    expect(page.directory).toEqual(saved.metadata.directory);
    expect(page.reports).toEqual(saved.report);
    expect(page.selection).toEqual(saved.selection);
    const [sql, values] = query.mock.calls[1];
    expect(sql).toContain("FROM matching_groups g JOIN adoption_users u ON u.group_id=g.identity");
    expect(sql).toContain("count(*) FILTER(WHERE u.has_activity)::numeric / NULLIF(count(*),0)");
    expect(sql).toContain(`ORDER BY adoption_rate ${order.toUpperCase()} NULLS LAST,sort_key COLLATE "C",identity COLLATE "C"`);
    expect(sql).toContain("ORDER BY position ASC LIMIT $10");
    expect(sql).not.toContain("O'Brien");
    expect(values).toEqual([...adoptionDataset(reports, saved).values, 0, 8]);
    expect(query.mock.calls[0][1]).toEqual(adoptionDataset(reports, saved).values);
    expect(query).toHaveBeenCalledTimes(2);
  });

  it.each(["asc", "desc"] as const)("round-trips %s pages including a partial final page", async order => {
    const saved = context("adoption_departments", { order }), { client, query } = fixture(saved);
    const rows = Array.from({ length: 5 }, (_, index) => department(index + 1));
    const enqueue = (items: pg.QueryResultRow[]) => query.mockResolvedValueOnce(result([{ total: "5", filtered: "5" }]))
      .mockResolvedValueOnce(result(items));
    const read = (cursor?: string) => readAdoptionDepartments(client, reports, saved, { limit: 2, cursor });
    enqueue(rows.slice(0, 2));
    const first = await read();
    enqueue(rows.slice(2, 4));
    const second = await read(first.page.nextCursor!);
    enqueue(rows.slice(4));
    const last = await read(second.page.nextCursor!);
    expect([first, second, last].flatMap(page => page.value.map(row => row.id))).toEqual(rows.map(row => row.identity));
    expect(first.page.previousCursor).toBeNull();
    expect(last.page.nextCursor).toBeNull();
    expect([first, second, last].map(page => [page.page.number, page.page.offset])).toEqual([[1, 0], [2, 2], [3, 4]]);
    expect(reports.codec.decode(first.page.nextCursor!, cursorContract(saved, 2)).boundary)
      .toEqual({ key: "2", id: rows[1].identity, nullRank: 0 });
    enqueue(rows.slice(2, 4));
    const back = await read(last.page.previousCursor!);
    expect(back.value).toEqual(second.value);
    enqueue(rows.slice(0, 2));
    expect((await read(back.page.previousCursor!)).value).toEqual(first.value);
    expect(query.mock.calls[3][1]?.slice(-2)).toEqual([2, 2]);
    expect(query.mock.calls[7][0]).toContain("position > $9::bigint");
    expect(query.mock.calls[7][0]).toContain("ORDER BY position ASC LIMIT $10");
    expect(query.mock.calls[7][1]?.slice(-2)).toEqual([2, 2]);
  });

  it.each([1, 2, 3, 99, Number.MAX_SAFE_INTEGER])("reads page %s directly and clamps to the available results", async requested => {
    const { client, query, saved } = fixture();
    const number = Math.min(requested, 3), offset = (number - 1) * 2;
    const rows = Array.from({ length: Math.min(2, 5 - offset) }, (_, index) => department(offset + index + 1));
    query.mockResolvedValueOnce(result([{ total: "5", filtered: "5" }])).mockResolvedValueOnce(result(rows));
    const page = await readAdoptionDepartments(client, reports, saved, { limit: 2, pageNumber: requested });
    expect(page.value.map(row => row.id)).toEqual(rows.map(row => row.identity));
    expect(page.page).toMatchObject({ limit: 2, number, offset });
    expect(Boolean(page.page.previousCursor)).toBe(number > 1);
    expect(Boolean(page.page.nextCursor)).toBe(number < 3);
    expect(query.mock.calls[1][1]?.slice(-2)).toEqual([offset, 2]);
    expect(query).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["available", "users", true], ["available", "userAgents", true], ["available", "agents", false],
    ["available", null, false], ["stale", "users", false], ["unavailable", "userAgents", false],
  ] as const)("distinguishes zero from missing evidence for %s / %s", async (state, kind, measured) => {
    const { client, query, saved } = fixture();
    saved.metadata.directory.state = state;
    saved.report.lineages = saved.report.lineages.filter(lineage => lineage.kind === kind);
    query.mockResolvedValueOnce(result([{ total: "1", filtered: "1" }]))
      .mockResolvedValueOnce(result([{ ...department(1), active_people: "0" }]));
    expect((await readAdoptionDepartments(client, reports, saved, { limit: 8 })).value[0].activePeople)
      .toBe(measured ? 0 : null);
    expect(query.mock.calls[1][0]).toContain(measured
      ? "count(*) FILTER(WHERE u.has_activity)::numeric / NULLIF(count(*),0) AS adoption_rate"
      : "NULL::numeric AS adoption_rate");
  });

  it("returns an empty filtered cohort without fabricating navigation", async () => {
    const { client, query, saved } = fixture(context("adoption_departments", { company: "missing" }));
    query.mockResolvedValueOnce(result([{ total: "4", filtered: "0" }])).mockResolvedValueOnce(result([]));
    expect(await readAdoptionDepartments(client, reports, saved, { limit: 100 })).toMatchObject({
      value: [], counts: { total: 4, filtered: 0 }, page: { limit: 100, number: 1, offset: 0, nextCursor: null, previousCursor: null },
    });
    expect(query.mock.calls[1][1]?.slice(-2)).toEqual([0, 100]);
  });

  it.each([0, -1, 101, 1.5, NaN, Infinity])("rejects invalid limit %s before querying", async limit => {
    const { client, query, saved } = fixture();
    await expect(readAdoptionDepartments(client, reports, saved, { limit })).rejects.toMatchObject({ code: "invalid_cursor" });
    expect(query).not.toHaveBeenCalled();
  });

  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])("rejects invalid page number %s before querying", async pageNumber => {
    const { client, query, saved } = fixture();
    await expect(readAdoptionDepartments(client, reports, saved, { limit: 10, pageNumber }))
      .rejects.toMatchObject({ code: "invalid_cursor" });
    expect(query).not.toHaveBeenCalled();
  });

  it("rejects simultaneous numbered and cursor positions before querying", async () => {
    const { client, query, saved } = fixture();
    await expect(readAdoptionDepartments(client, reports, saved, { limit: 10, pageNumber: 2, cursor: "next" }))
      .rejects.toMatchObject({ code: "invalid_cursor" });
    expect(query).not.toHaveBeenCalled();
  });

  it.each<CursorBoundary>([
    { key: null, id: "group", nullRank: 1 },
    ...["0", "-1", "01", "1.5", "text", "9007199254740992", "10000000000000000"]
      .map(key => ({ key, id: "group", nullRank: 0 as const })),
  ])("rejects invalid position $key before querying", async boundary => {
    const { client, query, saved } = fixture();
    const cursor = reports.codec.encode({ ...cursorContract(saved, 2), direction: "next", boundary });
    await expect(readAdoptionDepartments(client, reports, saved, { limit: 2, cursor }))
      .rejects.toMatchObject({ code: "invalid_cursor" });
    expect(query).not.toHaveBeenCalled();
  });

  it.each(["limit", "query", "selection", "revision", "tenant", "principal", "authorization", "session", "signature"])(
    "rejects a cursor crossing its %s contract", async field => {
      const { client, query, saved } = fixture();
      let cursor = reports.codec.encode({ ...cursorContract(saved, 2), direction: "next",
        boundary: { key: "1", id: department(1).identity, nullRank: 0 } });
      if (field === "query") saved.queryHash = digest("different-query");
      if (field === "selection") saved.selection.id = "33333333-3333-4333-8333-333333333333";
      if (field === "revision") saved.selection.revision = "2";
      if (field === "tenant") saved.identity.tenantId = "other-tenant";
      if (field === "principal") saved.identity.principalId = "other-reader";
      if (field === "authorization") saved.identity.authorizationHash = "other-role";
      if (field === "session") saved.identity.sessionEpoch = "2";
      if (field === "signature") cursor += "x";
      await expect(readAdoptionDepartments(client, reports, saved, { limit: field === "limit" ? 3 : 2, cursor }))
        .rejects.toMatchObject({ code: "invalid_cursor" });
      expect(query).not.toHaveBeenCalled();
    },
  );

  it.each(["people", "active_people", "total", "filtered"])("rejects an unsafe %s count explicitly", async field => {
    const { client, query, saved } = fixture();
    query.mockResolvedValueOnce(result([{ total: "1", filtered: "1",
      ...(["total", "filtered"].includes(field) ? { [field]: "9007199254740992" } : {}) }]))
      .mockResolvedValueOnce(result([{ ...department(1), [field]: "9007199254740992" }]));
    await expect(readAdoptionDepartments(client, reports, saved, { limit: 8 }))
      .rejects.toMatchObject({ status: 409, code: "official_usage_total_limit" });
  });

  it("enforces the complete response byte limit", async () => {
    const { client, query, saved } = fixture();
    query.mockResolvedValueOnce(result([{ total: "1", filtered: "1" }])).mockResolvedValueOnce(result([department(1)]));
    saved.metadata.directory.message = "x".repeat(1_048_576);
    await expect(readAdoptionDepartments(client, reports, saved, { limit: 8 }))
      .rejects.toMatchObject({ status: 413, code: "data_response_bytes" });
  });
});

describe("organization adoption summaries", () => {
  const summaryRow = { directory_counts: { licensed: "3", using_agents: "2", no_agents: "1", measured: "2",
    attention: "1", unknown: "0" }, unresolved: "1", unpaid: "1", paid: "2", unknown_license: "0",
    active_users: "3", responses: "15", bridge: "15", users: "15", licensed: "3", unlicensed: "0" };

  it("counts suggested champions and reuses the real organization summary without paging member lists", async () => {
    const { client, query, saved } = fixture(context("adoption"));
    query.mockResolvedValueOnce(result([{ champions: "2" }])).mockResolvedValueOnce(result([summaryRow]));
    const page = await readAdoptionSummary(client, reports, saved);
    expect(page.value).toMatchObject([{ champions: 2, organization: {
      checkedUsers: 5, licensedUsers: 3, paidActiveReportUsers: 2, activeWithoutPaidUsers: 1,
      needsAttentionUsers: 1, unresolvedIdentities: 1, reportedResponses: 15, responseReconciliation: "matching",
    } }]);
    expect(page.counts).toEqual({ total: 1, filtered: 1 });
    expect(page.page).toEqual({ limit: 1, nextCursor: null, previousCursor: null });
    expect(page.selection).toEqual(saved.selection);
    expect(page.reports).toEqual(saved.report);
    expect(query.mock.calls[0][0]).toContain("SELECT count(*)::text AS champions FROM adoption_champions");
    expect(query.mock.calls[0][1]).toEqual(adoptionDataset(reports, saved).values);
    expect(query.mock.calls[1][1]).toEqual([...reports.parameters(saved), false]);
    expect(query).toHaveBeenCalledTimes(2);
  });

  it.each(["search", "company", "department", "adoptionChamps", "adoptionAgents"] as const)(
    "rejects a %s-filtered selection before querying", async field => {
      const input: ReportQuery = field === "adoptionChamps" || field === "adoptionAgents" ? { [field]: "with" }
        : { [field]: field === "search" ? "" : null };
      const { client, query, saved } = fixture(context("adoption", input));
      await expect(readAdoptionSummary(client, reports, saved)).rejects.toMatchObject({ code: "invalid_cursor" });
      expect(query).not.toHaveBeenCalled();
    },
  );

  it.each(["directory", "report"] as const)("keeps champions unknown without %s evidence", async missing => {
    const { client, query, saved } = fixture(context("adoption"));
    if (missing === "directory") saved.metadata.directory.state = "unavailable";
    else saved.report.lineages = [];
    query.mockResolvedValueOnce(result([{ ...summaryRow, directory_counts: null }]));
    expect((await readAdoptionSummary(client, reports, saved)).value[0].champions).toBeNull();
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0]).not.toContain("FROM adoption_champions");
  });

  it("rejects an unsafe champion count before reading the organization summary", async () => {
    const { client, query, saved } = fixture(context("adoption"));
    query.mockResolvedValueOnce(result([{ champions: "9007199254740992" }]));
    await expect(readAdoptionSummary(client, reports, saved))
      .rejects.toMatchObject({ status: 409, code: "official_usage_total_limit" });
    expect(query).toHaveBeenCalledTimes(1);
  });
});

describe("adoption aggregate failures", () => {
  it("rejects mismatched endpoints and department sort contracts before querying", async () => {
    const { client, query } = fixture();
    await expect(readAdoptionDepartments(client, reports, context("adoption"), { limit: 8 }))
      .rejects.toMatchObject({ code: "invalid_cursor" });
    await expect(readAdoptionSummary(client, reports, context())).rejects.toMatchObject({ code: "invalid_cursor" });
    const saved = context();
    saved.query.sort = "name";
    await expect(readAdoptionDepartments(client, reports, saved, { limit: 8 }))
      .rejects.toMatchObject({ code: "invalid_cursor" });
    expect(query).not.toHaveBeenCalled();
  });

  it("propagates database failures instead of returning partial aggregates", async () => {
    const { client, query, saved } = fixture(), error = new Error("Synthetic selected query failure");
    query.mockRejectedValueOnce(error);
    await expect(readAdoptionDepartments(client, reports, saved, { limit: 8 })).rejects.toBe(error);
    query.mockResolvedValueOnce(result([{ total: "1", filtered: "1" }])).mockRejectedValueOnce(error);
    await expect(readAdoptionDepartments(client, reports, saved, { limit: 8 })).rejects.toBe(error);
    query.mockRejectedValueOnce(error);
    await expect(readAdoptionSummary(client, reports, context("adoption"))).rejects.toBe(error);
  });
});
