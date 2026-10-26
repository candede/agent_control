import pg from "pg";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { digest } from "../db/dataBounds.js";
import type { UserSourceMetadata } from "../types/userSources.js";
import { adoptionDataset, readAdoptionGroups } from "./adoptionGroups.js";
import { canonicalQuery } from "./dataSelections.js";
import { LargeTenantUsersReports, reportQuery, reportQueryFields, reportSearchSql, type ReportReadContext } from "./largeTenantUsersReports.js";
import { directorySourceRecord } from "./userSourceRecords.js";

const database = new pg.Pool({ max: 4 });
const reports = new LargeTenantUsersReports(database, "synthetic-adoption-unit-regression-secret", 35);

beforeEach(() => {
  vi.spyOn(database, "connect").mockRejectedValue(new Error("Unexpected database acquisition"));
  vi.spyOn(database, "query").mockRejectedValue(new Error("Unexpected unscoped database query"));
});
afterEach(() => {
  expect(database.connect).not.toHaveBeenCalled();
  expect(database.query).not.toHaveBeenCalled();
  vi.restoreAllMocks();
});
afterAll(async () => { await database.end(); });

function source(source: UserSourceMetadata["source"]): UserSourceMetadata {
  return { source, generationId: null, scopeId: null, revision: null, expiresAt: null, observedAt: null,
    attemptedAt: null, attemptStatus: null, attemptObservedCount: null, errorCode: null, message: null,
    rowCount: null, state: "unavailable", reportRefreshDate: null, period: null, reportVersion: null };
}
function context(order: "asc" | "desc" = "asc"): ReportReadContext {
  const query = reportQuery("adoption", { order });
  return { identity: { tenantId: "tenant", principalId: "reader", authorizationHash: "viewer", sessionEpoch: "1" },
    tokenMode: "delegated", endpoint: "adoption", query, queryHash: canonicalQuery(query, reportQueryFields),
    evaluatedAt: new Date("2026-10-01T00:00:00Z"),
    selection: { id: "11111111-1111-4111-8111-111111111111", revision: "1",
      evaluatedAt: "2026-10-01T00:00:00Z", expiresAt: "2026-10-01T00:10:00Z", validatedAt: "2026-10-01T00:00:00Z",
      publicationRevisions: { graph_packages: "1".repeat(64), power_platform: "2".repeat(64), users: "3".repeat(64) } },
    metadata: { directory: source("directory"), app_activity: source("app_activity") },
    report: { setId: null, activeSetId: null, activeRevision: "1", historyRevision: "0", historyEpoch: "0",
      availability: "never_imported", staleAfterDays: 35, periodAgeDays: null, acceptedAgeDays: null,
      reportingPeriod: null, acceptedAt: null, expiresAt: null, lineages: [] } };
}
function result(rows: pg.QueryResultRow[]): pg.QueryResult {
  return { command: "SELECT", rowCount: rows.length, fields: [], oid: 0, rows };
}
function mockPage(headers: pg.QueryResultRow[], preceding?: number) {
  const client = Object.assign(new pg.Client(), { release: vi.fn() });
  const query = vi.spyOn(client, "query")
    .mockResolvedValueOnce(result([{ total: "5", filtered: "5", people: "0", champs: "0", agents: "0" }]));
  if (preceding !== undefined) query.mockResolvedValueOnce(result([{ preceding: String(preceding) }]));
  query.mockResolvedValueOnce(result(headers)).mockResolvedValueOnce(result([])).mockResolvedValueOnce(result([]));
  return { client, query };
}

describe("adoption cursor boundaries", () => {
  it.each(["asc", "desc"] as const)("pages %s groups with accepted long Unicode labels", async order => {
    const saved = context(order);
    const groups = Array.from({ length: 5 }, (_, index) => {
      const company = "\u337f".repeat(256), department = "\u337f".repeat(255) + index;
      const user = directorySourceRecord({ serviceEvidenceVersion: 1, identity: {
        objectId: `50000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
        userPrincipalName: `user${index}@example.invalid`, displayName: `User ${index}`,
        companyName: company, department, accountEnabled: true, employeeType: null, userType: "Member",
      }, copilotServiceState: "disabled", servicePlans: [] });
      return { identity: digest(String(index)), company: user.company, department: user.department,
        sort_key: `${company} / ${department}`.normalize("NFKC").toLowerCase().normalize("NFKC") };
    });
    if (order === "desc") groups.reverse();
    const expected = { identity: saved.identity, endpoint: "adoption", selectionId: saved.selection.id,
      revision: saved.selection.revision, queryHash: digest(JSON.stringify([saved.queryHash, 2])) };
    expect(Buffer.byteLength(groups[1].sort_key)).toBeGreaterThan(4096);
    expect(() => reports.codec.encode({ ...expected, direction: "next",
      boundary: { key: groups[1].sort_key, id: groups[1].identity, nullRank: 0 } })).toThrow("invalid_cursor");
    const firstRead = mockPage(groups.slice(0, 2));
    const first = await readAdoptionGroups(firstRead.client, reports, saved, { limit: 2 });
    expect(first.page).toMatchObject({ number: 1, offset: 0, previousCursor: null });
    expect(Buffer.byteLength(first.page.nextCursor!)).toBeLessThanOrEqual(4096);
    const boundary = reports.codec.decode(first.page.nextCursor!, expected).boundary;
    expect(boundary).toEqual({ key: "\0", id: groups[1].identity, nullRank: 0 });

    const secondRead = mockPage(groups.slice(2, 4), 2);
    const second = await readAdoptionGroups(secondRead.client, reports, saved, { limit: 2, cursor: first.page.nextCursor! });
    expect(second.value.map(group => group.id)).toEqual(groups.slice(2, 4).map(group => group.identity));
    expect(second.page).toMatchObject({ number: 2, offset: 2 });
    const positionSql = String(secondRead.query.mock.calls[1][0]);
    expect(positionSql).toContain("FROM matching_groups g WHERE g.identity=$9::text");
    expect(positionSql).toContain(`) ${order === "asc" ? "<=" : ">="}`);
    expect(secondRead.query.mock.calls[1][1]).toEqual([...adoptionDataset(reports, saved).values, groups[1].identity]);

    const lastRead = mockPage(groups.slice(4), 4);
    const last = await readAdoptionGroups(lastRead.client, reports, saved, { limit: 2, cursor: second.page.nextCursor! });
    expect(last.page).toMatchObject({ number: 3, offset: 4, nextCursor: null });
    expect(Buffer.byteLength(last.page.previousCursor!)).toBeLessThanOrEqual(4096);
    const previousRead = mockPage(groups.slice(2, 4), 4);
    const previous = await readAdoptionGroups(previousRead.client, reports, saved, { limit: 2, cursor: last.page.previousCursor! });
    expect(previous.value).toEqual(second.value);
    expect(previous.page).toMatchObject({ number: 2, offset: 2 });
    expect(String(previousRead.query.mock.calls[1][0])).toContain(`) ${order === "asc" ? "<" : ">"}`);
  });

  it("rejects a boundary outside the matching selected groups", async () => {
    const saved = context();
    const cursor = reports.codec.encode({ identity: saved.identity, endpoint: "adoption", selectionId: saved.selection.id,
      revision: saved.selection.revision, queryHash: digest(JSON.stringify([saved.queryHash, 2])), direction: "next",
      boundary: { key: "\0", id: digest("missing"), nullRank: 0 } });
    const client = Object.assign(new pg.Client(), { release: vi.fn() });
    const query = vi.spyOn(client, "query")
      .mockResolvedValueOnce(result([{ total: "5", filtered: "5", people: "0", champs: "0", agents: "0" }]))
      .mockResolvedValueOnce(result([]));
    await expect(readAdoptionGroups(client, reports, saved, { limit: 2, cursor }))
      .rejects.toMatchObject({ status: 400, code: "invalid_cursor" });
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("resolves signed boundaries by group identity without requiring an embedded sort key", async () => {
    const saved = context();
    const boundaryId = digest("boundary");
    const cursor = reports.codec.encode({ identity: saved.identity, endpoint: "adoption", selectionId: saved.selection.id,
      revision: saved.selection.revision, queryHash: digest(JSON.stringify([saved.queryHash, 2])), direction: "next",
      boundary: { key: "a / hr", id: boundaryId, nullRank: 0 } });
    const { client, query } = mockPage([], 2);
    expect((await readAdoptionGroups(client, reports, saved, { limit: 2, cursor })).page.number).toBe(2);
    expect(query.mock.calls[1][1]).toEqual([...adoptionDataset(reports, saved).values, boundaryId]);
  });
});

describe("adoption organization normalization", () => {
  it("uses report search normalization for group identities, sort/search keys and exact filters", () => {
    const { relations } = adoptionDataset(reports, context());
    for (const field of ["company", "department"]) {
      expect(relations).toContain(reportSearchSql(`nullif(btrim(${field}),'')`));
      expect(relations).toContain(reportSearchSql(`g.${field}`));
      expect(relations).toContain(reportSearchSql(`nullif(btrim($8::jsonb->>'${field}'),'')`));
    }
    expect(relations.replace(/\s+/g, " ")).toContain(reportSearchSql(
      `coalesce(min(company_label COLLATE "C"),'Company not provided')||' / '|| coalesce(min(department_label COLLATE "C"),'Department not provided')`,
    ));
  });

  it.each(["company", "department"] as const)("uses the same normalization when combining %s facet labels", async field => {
    const saved = context();
    const client = Object.assign(new pg.Client(), { release: vi.fn() });
    const query = vi.spyOn(client, "query")
      .mockResolvedValueOnce(result([{ filtered: "0", total: "0" }])).mockResolvedValueOnce(result([]));
    vi.spyOn(reports, "read").mockImplementation((_id, _identity, work) => work(client, saved));
    await reports.facets(saved.selection.id, saved.identity, { field, search: "\u01f0" });
    const sql = String(query.mock.calls[0][0]);
    expect(sql).toContain(`GROUP BY ${reportSearchSql(field)}`);
    expect(sql).toContain(`${reportSearchSql("value")} AS page_key`);
    expect(query.mock.calls[0][1]?.[8]).toBe("\u01f0");
  });
});
