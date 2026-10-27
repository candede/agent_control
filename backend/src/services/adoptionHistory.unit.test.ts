import pg from "pg";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { AppError } from "../errors.js";
import type { UserSourceMetadata } from "../types/userSources.js";
import { readAdoptionHistory } from "./adoptionHistory.js";
import { canonicalQuery, type SelectionIdentity } from "./dataSelections.js";
import { LargeTenantUsersReports, reportQuery, reportQueryFields, type ReportReadContext } from "./largeTenantUsersReports.js";

const identity: SelectionIdentity = {
  tenantId: "adoption-tenant", principalId: "adoption-viewer", authorizationHash: "viewer", sessionEpoch: "1",
};
const database = new pg.Pool({ max: 4 });
const reports = new LargeTenantUsersReports(database, "synthetic-adoption-history-unit-secret", 35);
const at = new Date("2026-10-01T00:00:00Z");
function source(source: "directory" | "app_activity"): UserSourceMetadata {
  return { source, generationId: null, scopeId: null, revision: null, expiresAt: null, observedAt: null,
    attemptedAt: null, attemptStatus: null, attemptObservedCount: null, errorCode: null, message: null,
    rowCount: null, state: "unavailable", reportRefreshDate: null, period: null, reportVersion: null };
}
function context(): ReportReadContext {
  return { identity, tokenMode: "delegated", endpoint: "adoption_history", query: {},
    queryHash: canonicalQuery({}, reportQueryFields), evaluatedAt: at,
    metadata: { directory: source("directory"), app_activity: source("app_activity") },
    selection: { id: "11111111-1111-4111-8111-111111111111", revision: "1", evaluatedAt: at.toISOString(),
      validatedAt: at.toISOString(), expiresAt: "2026-10-01T00:10:00Z",
      publicationRevisions: { graph_packages: "1".repeat(64), power_platform: "2".repeat(64), users: "3".repeat(64) } },
    report: { setId: null, activeSetId: null, activeRevision: "1", historyRevision: "5", historyEpoch: "0",
      availability: "not_selected", staleAfterDays: 35, periodAgeDays: null, acceptedAgeDays: null,
      reportingPeriod: null, acceptedAt: null, expiresAt: null, lineages: [] } };
}
function row(index = 1) {
  return { id: `22222222-2222-4222-8222-${String(index).padStart(12, "0")}`,
    reporting_start: "2025-01-01", reporting_end: "2025-01-31", period_provenance: "activity_range",
    accepted_at: at.toISOString(), page_key: "1/2025-01-31/2025-01-01/2026-10-01T00:00:00.000000",
    active_users: "3", active_agents: "2", responses: "7", user_report_active_users: "2", relationship_active_users: "2",
    user_report_responses: "8", relationship_responses: "9" };
}
function result(rows: pg.QueryResultRow[]): pg.QueryResult {
  return { command: "SELECT", rows, rowCount: rows.length, oid: 0, fields: [] };
}
function fixture() {
  const client = Object.assign(new pg.Client(), { release: vi.fn() });
  const query = vi.fn<(sql: string, values?: unknown[]) => Promise<pg.QueryResult>>();
  vi.spyOn(client, "query").mockImplementation(query);
  vi.spyOn(database, "connect").mockRejectedValue(new Error("Unexpected database acquisition"));
  return { client, query, saved: context() };
}
afterEach(() => { vi.restoreAllMocks(); });
afterAll(async () => { await database.end(); });

describe("retained adoption snapshot projection", () => {
  it("uses independent exact counts and sums with no directory, licensing, or current-set join", async () => {
    const { client, query, saved } = fixture();
    query.mockResolvedValue(result([{ item: row(), total: "1" }]));
    const page = await readAdoptionHistory(client, reports, saved);
    expect(page.value).toEqual([{
      id: row().id, reportingStart: "2025-01-01", reportingEnd: "2025-01-31", periodProvenance: "activity_range",
      acceptedAt: at.toISOString(), activeUsers: 3, activeAgents: 2, responses: 7,
      userReportActiveUsers: 2, relationshipActiveUsers: 2, userReportResponses: 8, relationshipResponses: 9,
    }]);
    expect(page.counts).toEqual({ total: 1, filtered: 1 });
    expect(Object.keys(page).sort()).toEqual(["counts", "page", "reports", "selection", "value"]);
    const [sql, values] = query.mock.calls[0];
    expect(sql).toContain(`count(DISTINCT f.username COLLATE "C") FILTER(WHERE f.kind IN ('users','userAgents') AND f.responses>0)`);
    expect(sql).toContain(`count(DISTINCT f.agent_id COLLATE "C") FILTER(WHERE f.kind IN ('agents','userAgents') AND f.responses>0)`);
    expect(sql).toContain("COALESCE(sum(f.responses) FILTER(WHERE f.kind='agents'),0)");
    expect(sql).toContain("visibility='retained' AND complete AND deleted_at IS NULL");
    expect(sql).toContain("expires_at>GREATEST($3::timestamptz,clock_timestamp())");
    expect(sql).toContain("m.valid_from_revision<=$2::bigint");
    expect(sql).toContain("m.valid_to_revision>$2::bigint");
    expect(sql).not.toMatch(/directory|inventory|licensed|identity_key|supersedes_set_id|interval/i);
    expect(values).toEqual([identity.tenantId, "5", at, null, "", 51]);
  });

  it("preserves explicit zeros and undated provenance without inventing a reporting window", async () => {
    const { client, query, saved } = fixture(), zero = { ...row(), reporting_start: null, reporting_end: null,
      period_provenance: "unknown", active_users: "0", active_agents: "0", responses: "0", user_report_active_users: "0",
      relationship_active_users: "0", user_report_responses: "0", relationship_responses: "0" };
    query.mockResolvedValue(result([{ item: zero, total: "1" }]));
    expect((await readAdoptionHistory(client, reports, saved)).value[0]).toMatchObject({
      reportingStart: null, reportingEnd: null, periodProvenance: "unknown", activeUsers: 0, activeAgents: 0, responses: 0,
      userReportActiveUsers: 0, relationshipActiveUsers: 0, userReportResponses: 0, relationshipResponses: 0,
    });
  });

  it("returns an empty measured history without a selected report or source generation", async () => {
    const { client, query, saved } = fixture();
    query.mockResolvedValue(result([{ item: null, total: "0" }]));
    expect(await readAdoptionHistory(client, reports, saved)).toMatchObject({
      value: [], counts: { total: 0, filtered: 0 }, page: { limit: 50, nextCursor: null, previousCursor: null },
    });
  });

  it.each(["active_users", "active_agents", "responses", "user_report_active_users", "relationship_active_users",
    "user_report_responses", "relationship_responses", "total"])("rejects unsafe %s totals explicitly", async field => {
    const { client, query, saved } = fixture();
    query.mockResolvedValue(result([{ item: { ...row(), [field]: "9007199254740992" },
      total: field === "total" ? "9007199254740992" : "1" }]));
    await expect(readAdoptionHistory(client, reports, saved)).rejects.toMatchObject({
      status: 409, code: "official_usage_total_limit",
    });
  });

  it("bounds both database batches and the encoded response", async () => {
    const { client, query, saved } = fixture();
    query.mockResolvedValue(result([{ item: { ...row(), period_provenance: "x".repeat(1_048_576) }, total: "1" }]));
    await expect(readAdoptionHistory(client, reports, saved)).rejects.toMatchObject({ status: 413, code: "data_batch_bytes" });
    query.mockResolvedValue(result([{ item: row(), total: "1" }]));
    saved.selection.publicationRevisions.users = "x".repeat(1_048_576);
    await expect(readAdoptionHistory(client, reports, saved)).rejects.toMatchObject({ status: 413, code: "data_response_bytes" });
  });
});

describe("historical adoption pagination and selection boundaries", () => {
  it("pages all 137 retained snapshots, including old and undated rows, with deterministic ties and reverse navigation", async () => {
    const { client, query, saved } = fixture();
    const rows = Array.from({ length: 137 }, (_, index) => ({ ...row(index + 1),
      ...(index < 135 ? {} : { reporting_start: null, reporting_end: null, period_provenance: "unknown",
        page_key: "0/2026-10-01T00:00:00.000000" }) }));
    rows.sort((a, b) => a.page_key < b.page_key ? 1 : a.page_key > b.page_key ? -1 : a.id < b.id ? 1 : -1);
    query.mockImplementation(async (sql, values) => {
      const previous = sql.includes('page_key COLLATE "C" ASC'), edgeKey = values![3] as string | null, edgeId = values![4] as string;
      const candidates = rows.filter(item => edgeKey === null || (previous
        ? item.page_key > edgeKey || item.page_key === edgeKey && item.id > edgeId
        : item.page_key < edgeKey || item.page_key === edgeKey && item.id < edgeId));
      if (previous) candidates.reverse();
      const selected = candidates.slice(0, Number(values![5]));
      return result(selected.length ? selected.map(item => ({ item, total: "137" })) : [{ item: null, total: "137" }]);
    });
    const pages = [];
    for (let cursor: string | undefined;;) {
      const page = await readAdoptionHistory(client, reports, saved, { limit: 50, cursor });
      pages.push(page);
      if (!page.page.nextCursor) break;
      cursor = page.page.nextCursor;
    }
    expect(pages.map(page => page.value.length)).toEqual([50, 50, 37]);
    expect(pages.flatMap(page => page.value.map(item => item.id))).toEqual(rows.map(item => item.id));
    expect(pages.at(-1)!.value.at(-1)!.reportingEnd).toBeNull();
    const previous = await readAdoptionHistory(client, reports, saved, { limit: 50, cursor: pages[1].page.previousCursor! });
    expect(previous.value).toEqual(pages[0].value);
    expect(previous.page.previousCursor).toBeNull();
  });

  it.each(["tenantId", "principalId", "authorizationHash", "sessionEpoch", "endpoint", "selectionId", "revision", "queryHash", "signature"])(
    "rejects a cursor crossing %s before running the metrics query", async field => {
      const { client, query, saved } = fixture();
      const expected = { identity, endpoint: "adoption_history", selectionId: saved.selection.id,
        revision: saved.selection.revision, queryHash: saved.queryHash };
      const payload = { ...expected, identity: { ...identity }, direction: "next" as const,
        boundary: { key: row().page_key, id: row().id, nullRank: 0 as const } };
      if (field in identity) Object.assign(payload.identity, { [field]: "foreign" });
      else if (field !== "signature") Object.assign(payload, { [field]: "foreign" });
      const cursor = reports.codec.encode(payload) + (field === "signature" ? "x" : "");
      await expect(readAdoptionHistory(client, reports, saved, { cursor })).rejects.toMatchObject({ status: 400, code: "invalid_cursor" });
      expect(query).not.toHaveBeenCalled();
    },
  );

  it.each([0, 101, 1.5, NaN])("rejects limit %s before database work", async limit => {
    const { client, query, saved } = fixture();
    await expect(readAdoptionHistory(client, reports, saved, { limit })).rejects.toMatchObject({ code: "invalid_cursor" });
    expect(query).not.toHaveBeenCalled();
  });

  it("rejects foreign endpoint selections and all report filters", async () => {
    const { client, query, saved } = fixture();
    saved.endpoint = "history";
    await expect(readAdoptionHistory(client, reports, saved)).rejects.toMatchObject({ code: "invalid_cursor" });
    for (const input of [{ setId: row().id }, { search: "user" }, { scope: "selected" }, { order: "asc" }]) {
      expect(() => reportQuery("adoption_history", input as never)).toThrowError(expect.objectContaining({ code: "invalid_cursor" }));
    }
    expect(query).not.toHaveBeenCalled();
  });
});

describe("history-only dashboard capture", () => {
  it("pins only official history, ignores the selected set and needs no directory or inventory generation", async () => {
    const { client, query } = fixture(), roots = [{ kind: "tenant_history" as const, scopeId: "history", revision: "5",
      expiresAt: new Date("2026-10-01T00:30:00Z") }];
    vi.spyOn(reports.history, "ensure").mockResolvedValue("history");
    vi.spyOn(reports.history, "expire").mockResolvedValue(0);
    vi.spyOn(reports.history, "root").mockResolvedValue(roots[0]);
    const sourceRead = vi.spyOn(reports.sources, "metadataInRead").mockRejectedValue(new Error("Unexpected source dependency"));
    query.mockImplementation(async sql => {
      if (sql.startsWith("SELECT h.revision")) return result([{ history_revision: "5", invalidation_epoch: "0",
        active_set_id: row().id, active_revision: "9", retained: 137, incomplete: 0 }]);
      if (sql.startsWith("WITH markers")) return result([]);
      if (sql.startsWith("INSERT INTO official_usage_read_contexts")) return result([]);
      throw new Error("Unexpected selected-set or source query");
    });
    vi.spyOn(reports.selections, "captureWith").mockImplementation(async (_identity, endpoint, _filters, prepare) => {
      expect(endpoint).toBe("adoption_history");
      const prepared = await prepare(client, at);
      expect(prepared.roots).toEqual(roots);
      expect(prepared.nextTransition).toBeUndefined();
      await prepared.persist!(client, { ...context().selection, endpoint, queryHash: context().queryHash,
        evaluatedAt: at, validatedAt: at, expiresAt: new Date(context().selection.expiresAt) });
      return { ...context().selection, endpoint, queryHash: context().queryHash,
        evaluatedAt: at, validatedAt: at, expiresAt: new Date(context().selection.expiresAt) };
    });
    await reports.capture(identity, "delegated", "adoption_history");
    expect(sourceRead).not.toHaveBeenCalled();
    const saved = query.mock.calls.find(([sql]) => sql.startsWith("INSERT INTO official_usage_read_contexts"))![1]!;
    expect(saved[5]).toBeNull();
    expect(JSON.parse(saved[4] as string)).toMatchObject({ setId: null, historyRevision: "5", lineages: [] });
    expect(JSON.parse(saved[3] as string)).toMatchObject({
      directory: { generationId: null }, app_activity: { generationId: null },
    });
  });

  it("does not bypass selection invalidation around the actual historical read", async () => {
    const { client, saved } = fixture();
    vi.spyOn(reports, "contextInRead").mockResolvedValue(saved);
    vi.spyOn(reports.selections, "read").mockImplementation(async (_id, _identity, work) => work(client, {} as never));
    vi.spyOn(reports.selections, "assert").mockRejectedValue(new AppError(409, "selection_invalidated", "changed"));
    await expect(reports.read(saved.selection.id, identity, async () => ({ value: [] }))).rejects.toMatchObject({
      status: 409, code: "selection_invalidated",
    });
  });
});
