import pg from "pg";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InventoryQueries } from "../db/inventoryQueries.js";
import type { CombinedUser } from "../types/officialReportData.js";
import type { UserSourceMetadata } from "../types/userSources.js";
import { canonicalQuery } from "./dataSelections.js";
import { LargeTenantUsersReports, reportQuery, reportQueryFields, type ReportReadContext } from "./largeTenantUsersReports.js";
import { SavedReadContracts } from "./savedReadContracts.js";

const database = new pg.Pool({ max: 4 });
const reports = new LargeTenantUsersReports(database, "synthetic-saved-read-unit-cursor-secret", 35);
const inventory = new InventoryQueries(database, "synthetic-saved-read-unit-cursor-secret");
const reads = new SavedReadContracts(reports, inventory);
const inventoryId = "22222222-2222-4222-8222-222222222222";
const objectId = "33333333-3333-4333-8333-333333333333";
const usageLineage: ReportReadContext["report"]["lineages"][number] = {
  kind: "userAgents", versionId: "version", contentHash: "hash", rowCount: 0,
  sourceAsOf: null, sourceAsOfProvenance: "unknown", sourceFreshness: "unknown", periodProvenance: "unknown",
};

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
function context(endpoint: "copilot_users" | "adoption"): ReportReadContext {
  const query = reportQuery(endpoint, endpoint === "adoption" ? { company: "Company", department: "Department" } : {});
  return { identity: { tenantId: "tenant", principalId: "reader", authorizationHash: "viewer", sessionEpoch: "1" },
    tokenMode: "delegated", endpoint, query, queryHash: canonicalQuery(query, reportQueryFields),
    evaluatedAt: new Date("2030-01-01T00:00:00Z"),
    selection: { id: "11111111-1111-4111-8111-111111111111", revision: "1",
      evaluatedAt: "2030-01-01T00:00:00Z", expiresAt: "2030-01-01T00:10:00Z", validatedAt: "2030-01-01T00:00:00Z",
      publicationRevisions: { graph_packages: "a".repeat(64), power_platform: "b".repeat(64), users: "c".repeat(64) } },
    metadata: { directory: source("directory"), app_activity: source("app_activity") },
    report: { setId: null, activeSetId: null, activeRevision: "1", historyRevision: "1", historyEpoch: "1",
      availability: "never_imported", staleAfterDays: 35, periodAgeDays: null, acceptedAgeDays: null,
      reportingPeriod: null, acceptedAt: null, expiresAt: null, lineages: [] } };
}
function result(rows: pg.QueryResultRow[] = []): pg.QueryResult {
  return { command: "SELECT", rowCount: rows.length, fields: [], oid: 0, rows };
}
function fixture(endpoint: "copilot_users" | "adoption" = "copilot_users") {
  const saved = context(endpoint);
  const selected: Awaited<ReturnType<InventoryQueries["contextInRead"]>> = {
    context: { data: { ...saved, publicationRevisions: saved.selection.publicationRevisions },
      selectionId: inventoryId, expiresAt: Date.parse(saved.selection.expiresAt), scopeId: "scope",
      baselineId: "baseline", revision: "1", source: "inventory_canonical", tokenMode: "delegated",
      query: { inventoryScope: "all", view: "all", source: "all" } },
    selection: { revision: "1", evaluated_at: saved.evaluatedAt, expires_at: new Date(saved.selection.expiresAt),
      validated_at: saved.evaluatedAt },
  };
  const client = Object.assign(new pg.Client(), { release: vi.fn() });
  const query = vi.fn<(sql: string, values?: unknown[]) => Promise<pg.QueryResult>>().mockImplementation(async sql => {
    if (sql.includes("AS people")) return result([{ company: "Company", department: "Department", people: [] }]);
    if (sql.includes("AS count FROM relationships")) return result();
    if (sql.includes("AS total,count(DISTINCT id)")) return result([{ total: "0", agents: "0" }]);
    if (sql.includes("ordered AS")) return result();
    throw new Error(`Unexpected saved-read query: ${sql}`);
  });
  vi.spyOn(client, "query").mockImplementation(query);
  vi.spyOn(reports, "read").mockImplementation((_id, _identity, work) => work(client, saved));
  vi.spyOn(inventory, "contextInRead").mockResolvedValue(selected);
  const assert = vi.spyOn(inventory.selections, "assert").mockResolvedValue({ selection: selected.selection, pins: [] });
  const person: CombinedUser = {
    directory: { objectId, userPrincipalName: "person@example.invalid", displayName: "Person", companyName: "Company",
      department: "Department", employeeType: null, accountEnabled: true, userType: "Member" },
    copilotServiceState: "unknown", entitlement: "unknown", servicePlanCount: 0, appActivity: null, activityState: "unknown",
    reportedUsername: null, reportedResponses: null, reportedAgentsUsed: null, userLastActivityDateUtc: null,
    bridgeResponses: null, relationshipCount: 0, agentActivityState: "unknown", reportMatch: "missing", attention: [],
  };
  const exact = vi.spyOn(reports, "exactInRead").mockResolvedValue({
    value: person, selection: saved.selection, reports: saved.report, sources: saved.metadata,
  });
  return { saved, selected, query, assert, exact };
}
function edge(index: number, candidates: number) {
  return { id: `agent:canonical-${index}`, canonical_id: `canonical-${index}`, report_agent_id: `reported-${index}`,
    name: `Agent ${index}`, relationship: "used", person_id: objectId, reported_username: "person@example.invalid",
    responses: "0", last_activity: "2030-01-01", source: "userAgents", identity_state: "canonical",
    edge: String(index).padStart(64, "0"), bytes: String(index * 1024), candidates };
}

describe("saved relationship page bounds", () => {
  it.each([0, -1, 1.5, 101, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid limit %s for both public relationship readers", async limit => {
      const { saved, query } = fixture();
      await expect(reads.relationships(saved.selection.id, saved.identity, inventoryId, objectId, "used", { limit }))
        .rejects.toMatchObject({ status: 400, code: "invalid_cursor" });
      saved.endpoint = "adoption";
      saved.query = reportQuery("adoption", { company: "Company", department: "Department" });
      await expect(reads.champions(saved.selection.id, saved.identity, inventoryId, { limit }))
        .rejects.toMatchObject({ status: 400, code: "invalid_cursor" });
      expect(query.mock.calls.some(([sql]) => sql.includes("FROM requested"))).toBe(false);
    });

  it.each([1, 100])("accepts boundary limit %s and requests only one lookahead edge", async limit => {
    const { saved, query } = fixture();
    saved.report.lineages = [{ ...usageLineage, rowCount: limit + 1 }];
    query.mockResolvedValueOnce(result([{ total: String(limit + 1), agents: String(limit + 1) }]))
      .mockResolvedValueOnce(result(Array.from({ length: limit + 1 }, (_, index) => edge(index + 1, limit + 1))));
    const page = await reads.relationships(saved.selection.id, saved.identity, inventoryId, objectId, "used", { limit });
    expect(page.value).toHaveLength(limit);
    expect(page).toMatchObject({ page: { limit }, counts: { total: limit + 1, distinctAgents: limit + 1, returned: limit },
      relationshipState: "available", missingReasons: [] });
    expect(page.page.nextCursor).not.toBeNull();
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(524288);
    expect(query.mock.calls.at(-1)?.[1]?.slice(-2)).toEqual(["", limit + 1]);
  });

  it("continues a byte-truncated page and binds the cursor to both selections, person, relationship and limit", async () => {
    const { saved, selected, query, assert, exact } = fixture();
    saved.report.lineages = [{ ...usageLineage, rowCount: 3 }];
    const firstEdge = edge(1, 3);
    query.mockResolvedValueOnce(result([{ total: "3", agents: "2" }])).mockResolvedValueOnce(result([firstEdge]));
    const first = await reads.relationships(saved.selection.id, saved.identity, inventoryId, objectId, "used", { limit: 2 });
    expect(first.page.nextCursor).not.toBeNull();
    expect(first.value[0]).toMatchObject({ id: firstEdge.id, canonicalId: firstEdge.id, responses: 0,
      lastActivityDateUtc: "2030-01-01T00:00:00.000Z",
      sourceReferences: { selectionId: inventoryId, path: `/api/agent-inventory/${firstEdge.id}/members` } });
    expect(first.counts).toEqual({ total: 3, distinctAgents: 2, returned: 1 });
    expect(exact).toHaveBeenCalledWith(expect.anything(), saved, objectId);
    expect(assert).toHaveBeenCalledWith(expect.anything(), inventoryId, saved.identity);
    const options = { limit: 2, cursor: first.page.nextCursor! };
    query.mockResolvedValueOnce(result([{ total: "3", agents: "2" }]))
      .mockResolvedValueOnce(result([edge(2, 2), { ...edge(3, 2), id: "agent:canonical-2", canonical_id: "canonical-2" }]));
    const next = await reads.relationships(saved.selection.id, saved.identity, inventoryId, objectId, "used", options);
    expect(next.value.map(row => [row.id, row.reportAgentId])).toEqual([
      ["agent:canonical-2", "reported-2"], ["agent:canonical-2", "reported-3"],
    ]);
    expect(next.page.nextCursor).toBeNull();
    expect(query.mock.calls.at(-1)?.[1]?.slice(-2)).toEqual([firstEdge.edge, 3]);
    const reject = (person = objectId, relationship: "used" | "created" = "used", limit = 2, inventorySelectionId = inventoryId) =>
      expect(reads.relationships(saved.selection.id, saved.identity, inventorySelectionId, person, relationship, { ...options, limit }))
        .rejects.toMatchObject({ code: "invalid_cursor" });
    await reject("other-person");
    await reject(objectId, "created");
    await reject(objectId, "used", 1);
    await reject(objectId, "used", 2, "other-inventory");
    selected.selection.revision = "2";
    await reject();
    selected.selection.revision = "1";
    saved.selection.revision = "2";
    await reject();
    expect(query).toHaveBeenCalledTimes(4);
  });

  it.each([458752, 458753])("enforces the SQL-reported first-edge byte boundary at %s bytes", async bytes => {
    const { saved, query } = fixture();
    query.mockResolvedValueOnce(result([{ total: "1", agents: "1" }]))
      .mockResolvedValueOnce(result([{ ...edge(1, 1), bytes: String(bytes) }]));
    const read = reads.relationships(saved.selection.id, saved.identity, inventoryId, objectId, "used", { limit: 50 });
    if (bytes > 458752) await expect(read).rejects.toMatchObject({ status: 413, code: "data_response_bytes" });
    else expect((await read).value).toHaveLength(1);
  });

  it("distinguishes absent usage evidence from a measured empty result", async () => {
    const { saved } = fixture();
    const missing = await reads.relationships(saved.selection.id, saved.identity, inventoryId, objectId, "used", { limit: 50 });
    expect(missing).toMatchObject({ relationshipState: "unavailable", missingReasons: ["userAgents_report_missing"],
      counts: { total: null, distinctAgents: null, returned: 0 } });
    saved.report.lineages = [usageLineage];
    const measured = await reads.relationships(saved.selection.id, saved.identity, inventoryId, objectId, "used", { limit: 50 });
    expect(measured).toMatchObject({ relationshipState: "available", missingReasons: [],
      counts: { total: 0, distinctAgents: 0, returned: 0 } });
  });

  it("rejects inconsistent compound dependencies and filtered inventory selections before querying edges", async () => {
    const { saved, selected, query } = fixture();
    selected.context.data.metadata = { ...saved.metadata, directory: { ...saved.metadata.directory, generationId: "different" } };
    await expect(reads.relationships(saved.selection.id, saved.identity, inventoryId, objectId, "created", { limit: 50 }))
      .rejects.toMatchObject({ status: 409, code: "selection_invalidated" });
    selected.context.data.metadata = saved.metadata;
    selected.context.query = { view: "copilot_studio" };
    await expect(reads.relationships(saved.selection.id, saved.identity, inventoryId, objectId, "created", { limit: 50 }))
      .rejects.toMatchObject({ status: 400, code: "relationship_inventory_scope" });
    expect(query).not.toHaveBeenCalled();
  });

  it("keeps inventory-only creation available when usage evidence is absent", async () => {
    const { saved } = fixture();
    const page = await reads.relationships(saved.selection.id, saved.identity, inventoryId, objectId, "created", { limit: 50 });
    expect(page).toMatchObject({ value: [], relationshipState: "available", missingReasons: [],
      counts: { total: 0, distinctAgents: 0, returned: 0 } });
  });
});

describe("saved user resolution", () => {
  it.each([
    { matches: "0", exact_report: null, reported_username: null, ambiguous_report: false, state: "directory_missing", reportIdentityState: "missing" },
    { matches: "0", exact_report: "concealed", reported_username: null, ambiguous_report: false, state: "directory_missing", reportIdentityState: "unresolved" },
    { matches: "1", exact_report: null, reported_username: null, ambiguous_report: false, state: "resolved", reportIdentityState: "missing" },
    { matches: "1", exact_report: null, reported_username: "Person@example.invalid", ambiguous_report: false, state: "resolved", reportIdentityState: "matched" },
    { matches: "1", exact_report: null, reported_username: null, ambiguous_report: true, state: "resolved", reportIdentityState: "ambiguous" },
    { matches: "2", exact_report: "person@example.invalid", reported_username: null, ambiguous_report: true, state: "ambiguous", reportIdentityState: "ambiguous" },
  ])("preserves directory/report evidence: $state / $reportIdentityState", async row => {
    const { saved, query } = fixture();
    query.mockResolvedValueOnce(result([{ ...row, object_id: objectId }]));
    const resolution = await reads.resolve(saved.selection.id, saved.identity, "person@example.invalid");
    expect(resolution).toMatchObject({ username: "person@example.invalid", state: row.state, reportIdentityState: row.reportIdentityState,
      objectId: row.matches === "1" ? objectId : null, directoryMatches: Number(row.matches),
      reportedUsername: row.matches === "1" ? row.reported_username : row.exact_report, concealment: "unknown" });
    expect(query.mock.calls[0][1]?.at(-1)).toBe("person@example.invalid");
  });

  it.each([null, "concealed"])("does not claim directory absence when an empty directory generation exists: %s", async exact_report => {
    const { saved, query } = fixture();
    saved.metadata.directory.generationId = "directory";
    query.mockResolvedValueOnce(result([{ matches: "0", object_id: null, exact_report, reported_username: null, ambiguous_report: false }]));
    const resolution = await reads.resolve(saved.selection.id, saved.identity, exact_report ?? "missing");
    expect(resolution).toMatchObject({ state: exact_report ? "concealed_or_unresolved" : "unresolved",
      objectId: null, directoryMatches: 0, concealment: "unknown" });
  });
});

describe("saved champion projection", () => {
  it("preserves portal rank and nullable names/usage metrics while counting full inventory creation", async () => {
    const { saved, query } = fixture("adoption");
    query.mockResolvedValueOnce(result([{ company: "Company", department: "Department",
      people: [{ identity: objectId, name: null, rank: 1, responses: "10", agents: "0" }] }]))
      .mockResolvedValueOnce(result([{ person_id: objectId, count: "4" }]));
    const page = await reads.champions(saved.selection.id, saved.identity, inventoryId, { limit: 50 });
    expect(page.champions).toEqual([{ objectId, name: null, rank: 1, created: 4, responses: 10, agents: null }]);
    expect(page).toMatchObject({ company: "Company", department: "Department", relationshipState: "unavailable",
      missingReasons: ["userAgents_report_missing"] });
    expect(query.mock.calls[0][0]).toContain("FROM adoption_champions");
    expect(query.mock.calls[1][1]?.at(-1)).toEqual([objectId]);
    expect(query.mock.calls[2][0]).toContain("relationship IN ('used','created')");
  });
});
