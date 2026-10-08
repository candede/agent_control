import pg from "pg";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { digest } from "../db/dataBounds.js";
import type { ReportEndpoint } from "../types/officialReportData.js";
import type { UserSourceMetadata } from "../types/userSources.js";
import { canonicalQuery, SelectionError, type SelectionIdentity } from "./dataSelections.js";
import { parseAgentRow } from "./officialReportFields.js";
import { LargeTenantUsersReports, reportQuery, reportQueryFields, type ReportReadContext } from "./largeTenantUsersReports.js";

const identity: SelectionIdentity = {
  tenantId: "report-unit-tenant", principalId: "report-unit-principal", authorizationHash: "viewer", sessionEpoch: "1",
};
const database = new pg.Pool({ max: 4 });
const reports = new LargeTenantUsersReports(database, "synthetic-report-unit-regression-secret", 35);

beforeEach(() => { vi.spyOn(database, "connect").mockRejectedValue(new Error("Unexpected database acquisition")); });
afterEach(() => { vi.restoreAllMocks(); });
afterAll(async () => { await database.end(); });

function source(source: UserSourceMetadata["source"]): UserSourceMetadata {
  return { source, generationId: null, scopeId: null, revision: null, expiresAt: null, observedAt: null,
    attemptedAt: null, attemptStatus: null, attemptObservedCount: null, errorCode: null, message: null,
    rowCount: null, state: "unavailable", reportRefreshDate: null, period: null, reportVersion: null };
}

function context(endpoint: ReportEndpoint): ReportReadContext {
  const query = reportQuery(endpoint);
  return { identity, tokenMode: "delegated", endpoint, query, queryHash: canonicalQuery(query, reportQueryFields),
    evaluatedAt: new Date("2026-01-01T00:00:00Z"),
    selection: { id: "11111111-1111-4111-8111-111111111111", revision: "1",
      evaluatedAt: "2026-01-01T00:00:00Z", expiresAt: "2026-01-01T00:10:00Z", validatedAt: "2026-01-01T00:00:00Z",
      publicationRevisions: { graph_packages: "1".repeat(64), power_platform: "2".repeat(64), users: "3".repeat(64) } },
    metadata: { directory: source("directory"), app_activity: source("app_activity") },
    report: { setId: null, activeSetId: null, activeRevision: "1", historyRevision: "0", historyEpoch: "0",
      availability: "never_imported", staleAfterDays: 35, periodAgeDays: null, acceptedAgeDays: null,
      reportingPeriod: null, acceptedAt: null, expiresAt: null, lineages: [] } };
}

function result(rows: pg.QueryResultRow[]): pg.QueryResult {
  return { command: "SELECT", rowCount: rows.length, oid: 0, fields: [], rows };
}

function facetHarness() {
  const saved = context("official_agents"), client = Object.assign(new pg.Client(), { release: vi.fn() });
  const query = vi.spyOn(client, "query");
  vi.spyOn(reports, "read").mockImplementation((_id, _identity, work) => work(client, saved));
  return { saved, query, expected: { identity, endpoint: "facets:creatorType", selectionId: saved.selection.id,
    revision: saved.selection.revision, queryHash: digest(`${saved.queryHash}:creatorType:`) } };
}

function facetRow(value: string | null) {
  return { value, count: "1", page_key: value?.normalize("NFKC").toLowerCase() ?? null, identity: value ?? "\u0001" };
}

function acceptedCreatorType(value: string) {
  return parseAgentRow({ "agent id": "agent", "agent name": "Agent", "creator type": value,
    "active users (licensed)": "0", "active users (unlicensed)": "0", "responses sent to users": "0" }, 1).creatorType;
}

describe.each(["history", "directory_report_inputs"] as const)("%s selection expiry maintenance", endpoint => {
  const captureSelection = () => endpoint === "history" ? reports.capture(identity, "delegated", endpoint) : reports.captureReportIdentities(identity);

  it.each([0, 1, 4, 5, 9])("drains %i expired sets before capturing a selection", async expired => {
    vi.spyOn(reports.sources, "ensureScope").mockResolvedValue("source-scope");
    vi.spyOn(reports.history, "ensure").mockResolvedValue("history-scope");
    let remaining = expired;
    const expire = vi.spyOn(reports.history, "expire").mockImplementation(async () => {
      const batch = Math.min(4, remaining);
      remaining -= batch;
      return batch;
    });
    const capture = vi.spyOn(reports.selections, "captureWith").mockImplementation(async () => {
      if (remaining) throw new SelectionError("selection_invalidated");
      const saved = context("history");
      return { id: saved.selection.id, revision: "1", expiresAt: new Date(saved.selection.expiresAt),
        evaluatedAt: saved.evaluatedAt, endpoint, queryHash: saved.queryHash };
    });
    await expect(captureSelection()).resolves.toMatchObject({ endpoint });
    expect(remaining).toBe(0);
    expect(expire).toHaveBeenCalledTimes(Math.ceil(expired / 4) + 1);
    expect(capture).toHaveBeenCalledOnce();
  });

  it("propagates maintenance failures without capturing a partial selection", async () => {
    vi.spyOn(reports.sources, "ensureScope").mockResolvedValue("source-scope");
    vi.spyOn(reports.history, "ensure").mockResolvedValue("history-scope");
    const failure = new Error("expiry maintenance failed");
    vi.spyOn(reports.history, "expire").mockResolvedValueOnce(4).mockRejectedValueOnce(failure);
    const capture = vi.spyOn(reports.selections, "captureWith").mockRejectedValue(new Error("Unexpected selection capture"));
    await expect(captureSelection()).rejects.toBe(failure);
    expect(capture).not.toHaveBeenCalled();
  });
});

describe("shared report row cursor boundaries", () => {
  it.each(["Agent", "\ufdfa".repeat(512)])("retains ordinary and compact row continuations", async name => {
    const saved = context("relationships"), client = Object.assign(new pg.Client(), { release: vi.fn() });
    const query = vi.spyOn(client, "query");
    const row = { identity: "first", agent_id: "agent", name, creator_type: "", username: "user", responses: "1",
      last_activity: null, page_key: name.normalize("NFKC").toLowerCase(), batch_position: "1", batch_total: "2",
      count_total: "2", count_filtered: "2", count_unresolved: false, count_primary_complete: false };
    query.mockResolvedValueOnce(result([])).mockResolvedValueOnce(result([row]));
    const page = await reports.rowsInRead(client, saved, { limit: 1 });
    const expected = { identity, endpoint: "relationships:", selectionId: saved.selection.id, revision: saved.selection.revision,
      queryHash: digest(`${saved.queryHash}:relationships::${canonicalQuery(saved.query, reportQueryFields)}`) };
    const compact = name.length > 256, boundary = reports.codec.decode(page.page.nextCursor!, expected).boundary;
    expect(boundary).toEqual({ key: compact ? "\0" : row.page_key, id: compact ? digest(row.identity) : row.identity, nullRank: 0 });
    query.mockResolvedValueOnce(result([]));
    if (compact) query.mockResolvedValueOnce(result([row]));
    query.mockResolvedValueOnce(result([{ ...row, identity: "second", batch_total: "1" }]));
    const next = await reports.rowsInRead(client, saved, { limit: 1, cursor: page.page.nextCursor! });
    expect(next.value).toMatchObject([{ id: "second" }]);
    expect(next.page.nextCursor).toBeNull();
    expect(next.page.previousCursor).toEqual(expect.any(String));
    expect(query.mock.calls.at(-1)?.[1]).toEqual(expect.arrayContaining([row.page_key, row.identity]));
  });
});

describe("report facet cursors", () => {
  it.each(["", "\ufdfa".repeat(128)])("round-trips accepted blank or wide creator types", value => {
    expect(acceptedCreatorType(value)).toBe(value);
  });

  it.each(["", "\ufdfa".repeat(128)])("continues and reverses across an accepted boundary: %s", async value => {
    const { saved, query, expected } = facetHarness(), first = facetRow(value), second = facetRow(null);
    const counts = result([{ total: "2", filtered: "2" }]);
    query.mockResolvedValueOnce(counts).mockResolvedValueOnce(result([first, second]));
    const page = await reports.facets(saved.selection.id, identity, { field: "creatorType", limit: 1 });
    expect(page.value).toEqual([{ value, count: 1 }]);
    expect(page.counts).toEqual({ total: 2, filtered: 2 });
    expect(Buffer.byteLength(page.page.nextCursor!)).toBeLessThanOrEqual(4096);
    const boundary = reports.codec.decode(page.page.nextCursor!, expected).boundary;
    expect(boundary).toEqual({ key: "\0", id: digest(first.identity), nullRank: 0 });

    query.mockResolvedValueOnce(counts).mockResolvedValueOnce(result([first])).mockResolvedValueOnce(result([second]));
    const next = await reports.facets(saved.selection.id, identity, { field: "creatorType", limit: 1, cursor: page.page.nextCursor! });
    expect(next.value).toEqual([{ value: null, count: 1 }]);
    expect(next.page.nextCursor).toBeNull();
    const lookup = query.mock.calls[3];
    expect(String(lookup[0])).toContain("WHERE encode(sha256(convert_to(identity,'UTF8')),'hex')");
    expect(String(lookup[0])).toContain("LIMIT 2");
    expect(lookup[1]).toContain(digest(first.identity));
    expect(query.mock.calls[4][1]).toEqual(expect.arrayContaining([first.page_key, first.identity]));

    query.mockResolvedValueOnce(counts).mockResolvedValueOnce(result([first]));
    const back = await reports.facets(saved.selection.id, identity, { field: "creatorType", limit: 1, cursor: next.page.previousCursor! });
    expect(back.value).toEqual(page.value);
    expect(back.page.previousCursor).toBeNull();
    expect(reports.codec.decode(back.page.nextCursor!, expected).boundary).toEqual(boundary);
  });

  it.each([0, 2])("rejects a compact cursor resolving to %i selected facet values", async matches => {
    const { saved, query, expected } = facetHarness();
    const cursor = reports.codec.encode({ ...expected, direction: "next", boundary: { key: "\0", id: digest(""), nullRank: 0 } });
    query.mockResolvedValueOnce(result([{ total: "2", filtered: "2" }]))
      .mockResolvedValueOnce(result(Array.from({ length: matches }, () => facetRow(""))));
    await expect(reports.facets(saved.selection.id, identity, { field: "creatorType", limit: 1, cursor }))
      .rejects.toMatchObject({ code: "selection_invalidated" });
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("preserves existing cursors for ordinary values and rejects tampering", async () => {
    const { saved, query, expected } = facetHarness();
    query.mockResolvedValueOnce(result([{ total: "2", filtered: "2" }]))
      .mockResolvedValueOnce(result([facetRow("Team"), facetRow(null)]));
    const page = await reports.facets(saved.selection.id, identity, { field: "creatorType", limit: 1 });
    expect(reports.codec.decode(page.page.nextCursor!, expected).boundary).toEqual({ key: "team", id: "Team", nullRank: 0 });
    query.mockResolvedValueOnce(result([{ total: "2", filtered: "2" }]));
    await expect(reports.facets(saved.selection.id, identity, { field: "creatorType", cursor: page.page.nextCursor! + "x" }))
      .rejects.toMatchObject({ code: "invalid_cursor" });
  });
});

describe("report facet search", () => {
  it.each(["J\u030c", "\u01f0"])("uses canonical search folding for %s", async search => {
    const { saved, query } = facetHarness();
    query.mockResolvedValueOnce(result([{ total: "1", filtered: "1" }])).mockResolvedValueOnce(result([facetRow("\u01f0")]));
    await reports.facets(saved.selection.id, identity, { field: "creatorType", search });
    expect(query.mock.calls[0][1]).toContain("\u01f0");
    expect(String(query.mock.calls[0][0])).toContain('strpos(normalize(lower(normalize(COALESCE(creator_type,\'\'),NFKC) COLLATE "default"),NFKC),$');
  });

  it.each(["name\0", "name\n", "\ud800", "\u337f".repeat(65)])("rejects invalid or expanded search before selected reads", async search => {
    const read = vi.spyOn(reports, "read").mockRejectedValue(new Error("Unexpected selected read"));
    await expect(async () => reports.facets(context("official_agents").selection.id, identity, { field: "creatorType", search }))
      .rejects.toMatchObject({ code: "invalid_cursor" });
    expect(read).not.toHaveBeenCalled();
  });
});
