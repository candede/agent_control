import pg from "pg";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { digest } from "../db/dataBounds.js";
import { UserSourceStages } from "../db/userSourceStages.js";
import type { ReportEndpoint } from "../types/officialReportData.js";
import type { UserSourceMetadata } from "../types/userSources.js";
import { canonicalQuery, SelectionError, type SelectionIdentity } from "./dataSelections.js";
import { parseAgentRow } from "./officialReportFields.js";
import { directorySourceRecord } from "./userSourceRecords.js";
import { LargeTenantUsersReports, reportQuery, reportQueryFields, type ReportReadContext } from "./largeTenantUsersReports.js";
import { reportRelationsSql, selectedDirectoryReportRelationsSql, selectedOfficialReportRelationsSql } from "../db/officialReportQueries.js";
import { officialReportAnalytics, projectReportAnalytics } from "./officialReportAnalytics.js";

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

function mockQuery(client: pg.Client) {
  const query = vi.fn<(statement: unknown, values?: unknown[]) => Promise<pg.QueryResult>>();
  vi.spyOn(client, "query").mockImplementation(query);
  return query;
}

function facetHarness() {
  const saved = context("official_agents"), client = Object.assign(new pg.Client(), { release: vi.fn() });
  const query = mockQuery(client);
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

describe("reported agent ranking labels", () => {
  it("uses exact opaque identities for accepted blank names without changing names, counts or ranking order", () => {
    const agentId = "ABCDEFAB-1234-4567-8901-ABCDEFABCDEF";
    const blank = parseAgentRow({ "agent id": agentId, "agent name": "", "creator type": "",
      "active users (licensed)": "0", "active users (unlicensed)": "0", "responses sent to users": "0" }, 1);
    const most = [{ agent_id: "named", name: "Named agent", responses: "10" },
      { agent_id: blank.agentId, name: blank.agentName, responses: String(blank.responsesSentToUsers) }];
    const agents = projectReportAnalytics({ n: "2", responses: "10", zero: "1", unknown: "0",
      inactive: "0", never: "2", anchor: null, window_agents: "0", window_responses: null, active_users: "0",
      most, least: [...most].reverse() }, context("official_agents")).agents;
    const expected = [
      { agentId: "named", name: "Named agent", responses: 10 },
      { agentId, name: agentId, responses: 0 },
    ];
    expect(agents?.mostResponses).toEqual(expected);
    expect(agents?.leastResponses).toEqual([...expected].reverse());
    expect(agents).toMatchObject({ anchorDateUtc: null, windowResponses: null, windowDistinctActiveUsers: 0 });
  });
});

describe("empty report response analytics", () => {
  it.each(["official_users", "official_agents", "relationships", "unresolved", "copilot_users"] as const)(
    "reports zero for an empty measured %s cohort, not for absent evidence or unknown rows", async endpoint => {
      const saved = context(endpoint), client = Object.assign(new pg.Client(), { release: vi.fn() });
      const totals = { n: "0", responses: null, zero: "0", unknown: "0", review_zero: "0", review_low: "0", review_unknown: "0",
        inactive: "0", never: "0", anchor: null, window_agents: "0", window_responses: null, active_users: "0", most: [], least: [] };
      const query = mockQuery(client);
      query.mockResolvedValue(result([totals]));
      expect((await officialReportAnalytics(client, reports, saved)).responses).toBeNull();
      saved.report.lineages = (["users", "agents", "userAgents"] as const).map(kind => ({
        kind, versionId: `version-${kind}`, contentHash: "a".repeat(64), rowCount: 0,
        sourceAsOf: null, sourceAsOfProvenance: "absent", sourceFreshness: "unknown", periodProvenance: "activity_range",
      }));
      if (endpoint === "copilot_users") {
        expect((await officialReportAnalytics(client, reports, saved)).responses).toBeNull();
        saved.metadata.directory.generationId = "22222222-2222-4222-8222-222222222222";
      }
      const empty = await officialReportAnalytics(client, reports, saved);
      expect(empty).toMatchObject({ rowCount: 0, responses: 0, zeroResponses: 0, unknownResponses: 0 });
      if (endpoint === "official_agents") expect(empty.agents?.windowResponses).toBeNull();
      saved.report.lineages.forEach(lineage => { lineage.rowCount = 10; });
      expect((await officialReportAnalytics(client, reports, saved)).responses).toBe(0);
      if (["official_users", "unresolved", "copilot_users"].includes(endpoint)) {
        query.mockResolvedValue(result([{ ...totals, n: "1", unknown: "1", review_unknown: "1" }]));
        expect((await officialReportAnalytics(client, reports, saved)).responses).toBeNull();
      }
    },
  );
});

describe("report licensing reconciliation after failed verification", () => {
  it.each(["available", "partial", "stale", "unavailable"] as const)(
    "counts active identities requiring a license check with %s directory evidence", async state => {
      const saved = context("official_users"), client = Object.assign(new pg.Client(), { release: vi.fn() });
      saved.query.licenseCohort = "active_without_paid";
      Object.assign(saved.metadata.directory, { state, generationId: "22222222-2222-4222-8222-222222222222",
        rowCount: 2, attemptStatus: state === "partial" ? "failed" : "available" });
      saved.report.setId = "33333333-3333-4333-8333-333333333333";
      const totals = { directory_counts: null, unresolved: "1", unpaid: "1", paid: "1", unknown_license: "1", active_users: "3",
        responses: null, bridge: null, users: null, licensed: null, unlicensed: null };
      mockQuery(client).mockResolvedValue(result([totals]));
      const summary = await reports.summaryInRead(client, saved);
      expect(summary).toMatchObject({ unknownLicenseActiveReportUsers: state === "available" ? 1 : 3,
        activeWithoutPaidUsers: state === "available" ? 1 : null, paidActiveReportUsers: state === "available" ? 1 : null,
        distinctActiveReportUsers: 3 });
    },
  );
});

describe("history selection status", () => {
  it.each([null, false, true])("projects SQL active status %j as a boolean", async active => {
    const saved = context("history"), client = Object.assign(new pg.Client(), { release: vi.fn() });
    const query = mockQuery(client), setId = "22222222-2222-4222-8222-222222222222";
    saved.report.activeSetId = active === null ? null : active ? setId : "33333333-3333-4333-8333-333333333333";
    query.mockResolvedValueOnce(result([])).mockResolvedValueOnce(result([{
      identity: setId, id: setId, bundle_id: "44444444-4444-4444-8444-444444444444", content_hash: "a".repeat(64),
      reporting_start: null, reporting_end: null, period_provenance: "activity_range", supersedes_set_id: null,
      accepted_at: saved.evaluatedAt, visibility: "retained", active, page_key: null, batch_position: "1", batch_total: "1",
      count_total: "1", count_filtered: "1", count_unresolved: false, count_primary_complete: false,
    }]));
    const page = await reports.rowsInRead(client, saved);
    expect(page.value).toMatchObject([{ id: setId, active: active === true }]);
    expect(page.counts).toEqual({ total: 1, filtered: 1 });
    expect(query.mock.calls.at(-1)?.[1]?.[2]).toBe(saved.report.activeSetId);
  });
});

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

describe("positive report identity verification", () => {
  it.each(["lease-read", "selected-page", "staged-batch"] as const)(
    "stops identity enrichment when authority changes during %s", async boundary => {
      const stages = new UserSourceStages(database);
      const lease = { id: "11111111-1111-4111-8111-111111111111", scopeId: "22222222-2222-4222-8222-222222222222",
        tenantId: identity.tenantId, owner: "33333333-3333-4333-8333-333333333333", version: 1,
        epoch: "1", sessionEpoch: identity.sessionEpoch, expectedRevision: "1", schemaVersion: 1 };
      const reason = new Error("Identity collection authority changed.");
      let current = true;
      const assertCurrent = () => { if (!current) throw reason; };
      vi.spyOn(database, "query").mockImplementation(async () => {
        if (boundary === "lease-read") current = false;
        return result([{}]);
      });
      const selectedClient = Object.assign(new pg.Client(), { release: vi.fn() });
      const observations = [[{ identity_key: "person@example.invalid", username: "person@example.invalid" }]];
      const query = vi.spyOn(selectedClient, "query").mockImplementation(async () => result(observations.shift() ?? []));
      const read = vi.spyOn(reports.selections, "read").mockImplementation(async (id, _identity, work) => {
        const rows = await work(selectedClient, { selection: { id, endpoint: "directory_report_inputs", query_json: { setId: null } }, pins: [] });
        if (boundary === "selected-page") current = false;
        return rows;
      });
      const identities = vi.spyOn(stages, "identities").mockImplementation(async () => {
        if (boundary === "staged-batch") current = false;
      });
      await expect(reports.feedPositiveIdentities(context("official_users").selection.id, identity, stages, lease,
        new AbortController().signal, assertCurrent)).rejects.toBe(reason);
      expect(identities).toHaveBeenCalledTimes(boundary === "staged-batch" ? 1 : 0);
      expect(read).toHaveBeenCalledTimes(boundary === "lease-read" ? 0 : 1);
      expect(query).toHaveBeenCalledTimes(boundary === "lease-read" ? 0 : 1);
    },
  );

  it("validates original usernames and continues across folded-key collisions without inventing aliases", async () => {
    const stages = new UserSourceStages(database), client = Object.assign(new pg.Client(), { release: vi.fn() });
    const lease = { id: "11111111-1111-4111-8111-111111111111", scopeId: "22222222-2222-4222-8222-222222222222",
      tenantId: identity.tenantId, owner: "33333333-3333-4333-8333-333333333333", version: 1,
      epoch: "1", sessionEpoch: identity.sessionEpoch, expectedRevision: "1", schemaVersion: 1 };
    const original = "PERSON@example.invalid", concealed = "ｐｅｒｓｏｎ＠ｅｘａｍｐｌｅ．ｉｎｖａｌｉｄ";
    const key = "person@example.invalid", stored: string[][] = [];
    vi.spyOn(database, "query").mockImplementation(async () => result([{}]));
    vi.spyOn(stages.generations.connections, "run").mockImplementation(async work => work(client));
    vi.spyOn(stages.generations, "fence").mockResolvedValue({ state: "staging" });
    vi.spyOn(client, "query").mockImplementation(async (sql: string, values?: unknown[]) => {
      if (sql.includes("INSERT INTO user_source_identity_inputs")) stored.push(JSON.parse(String(values?.[3])));
      return result(sql.includes("SELECT byte_count,reserved_bytes") ? [{ byte_count: "0", reserved_bytes: "1048576" }]
        : sql.includes("SELECT count(*)::int AS n") ? [{ n: 1 }] : []);
    });
    const selectedClient = Object.assign(new pg.Client(), { release: vi.fn() });
    const observations = [[{ identity_key: key, username: original }], [{ identity_key: key, username: concealed }]];
    const query = vi.spyOn(selectedClient, "query").mockImplementation(async () => result(observations.shift() ?? []));
    const saved = context("official_users");
    vi.spyOn(reports.selections, "read").mockImplementation((id, _identity, work) => work(selectedClient, {
      selection: { id, endpoint: "directory_report_inputs", query_json: { setId: saved.report.setId } }, pins: [],
    }));
    await reports.feedPositiveIdentities(saved.selection.id, identity, stages, lease);
    expect(stored).toEqual([[key], []]);
    expect(query.mock.calls[1][1]).toEqual([identity.tenantId, saved.report.setId, key, original]);
    expect(query.mock.calls[2][1]).toEqual([identity.tenantId, saved.report.setId, key, concealed]);
    expect(String(query.mock.calls[0][0])).toContain("f.username COLLATE");
  });
});

describe("shared report row cursor boundaries", () => {
  it("pages warm directory name prefixes with complete compact anchors in both directions", async () => {
    const saved = context("copilot_users"), client = Object.assign(new pg.Client(), { release: vi.fn() });
    vi.spyOn(Date, "now").mockReturnValue(saved.evaluatedAt.getTime());
    Object.assign(saved.metadata.directory, {
      generationId: "22222222-2222-4222-8222-222222222222", rowCount: 3, state: "available",
    });
    const names = ["a", "b", "c"].map(suffix => "\ufdfa".repeat(511) + suffix);
    const rows = names.map((name, index) => ({
      ...directorySourceRecord({
        identity: { objectId: `00000000-0000-0000-0000-00000000000${index}`, userPrincipalName: `user${index}@example.invalid`,
          displayName: name, companyName: null, department: null, accountEnabled: true, userType: null, employeeType: null },
        copilotServiceState: "disabled", servicePlans: [], serviceEvidenceVersion: 1,
      }), name, page_key: name.normalize("NFKC").toLowerCase(), activity_identity: null, activity_state: "unknown", entitlement: "no_paid",
      agent_activity_state: "unknown", report_match: "missing", relationship_count: "0", responses: null, agents_used: null,
      user_last_activity: null, bridge_responses: null, review_cohort: null,
      count_total: "3", count_filtered: "3", count_unresolved: false, count_primary_complete: false,
    }));
    let page = 0;
    const query = vi.fn<(statement: unknown, values?: unknown[]) => Promise<pg.QueryResult>>(async (statement, values) => {
      if (typeof statement !== "string") throw new Error("Unexpected statement");
      if (statement.includes("set_config(")) return result([]);
      if (statement.includes("SELECT page_key,identity FROM ordered")) {
        return result(rows.filter(row => digest(row.identity) === values?.at(-1)));
      }
      const selected = page++ === 0 ? rows.slice(0, 2) : page === 2 ? rows.slice(1) : rows.slice(0, 1);
      return result(selected.map((row, index) => ({ ...row, batch_position: String(index + 1), batch_total: String(selected.length) })));
    });
    vi.spyOn(client, "query").mockImplementation(query);
    const first = await reports.rowsInRead(client, saved, { limit: 1 });
    const next = await reports.rowsInRead(client, saved, { limit: 1, cursor: first.page.nextCursor! });
    const back = await reports.rowsInRead(client, saved, { limit: 1, cursor: next.page.previousCursor! });
    expect(first.value).toMatchObject([{ directory: { displayName: names[0] } }]);
    expect(next.value).toMatchObject([{ directory: { displayName: names[1] } }]);
    expect(back.value).toEqual(first.value);
    const warm = query.mock.calls.filter(([sql]) => typeof sql === "string" && sql.includes("selected_directory AS MATERIALIZED"));
    expect(warm).toHaveLength(2);
    for (const [index, [sql, values]] of warm.entries()) {
      const direction = index === 0 ? "ASC" : "DESC";
      expect(sql).toContain(`ORDER BY left(page_key,128) COLLATE "C" ${direction},page_key COLLATE "C" ${direction},identity COLLATE "C" ${direction}`);
      expect(sql).toContain(`AND left(page_key,128) COLLATE "C" ${index === 0 ? ">=" : "<="}`);
      expect(values).toContain(rows[index].page_key);
    }
  });

  it.each(["Agent", "\ufdfa".repeat(512)])("retains ordinary and compact row continuations", async name => {
    const saved = context("relationships"), client = Object.assign(new pg.Client(), { release: vi.fn() });
    const query = mockQuery(client);
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

describe("exact report directory aliases", () => {
  it("joins original lowercase aliases rather than compatibility-folded report keys", () => {
    expect(reportRelationsSql).toContain('lower(btrim(username) COLLATE "default") COLLATE "C" AS directory_identity_key');
    expect(reportRelationsSql).toContain("WHERE r.directory_identity_key=d.identity_key");
    expect(reportRelationsSql).toContain("ON r.directory_identity_key=d.identity_key");
    expect(reportRelationsSql).not.toContain("r.identity_key=d.identity_key");
    const directory = selectedDirectoryReportRelationsSql("SELECT * FROM directory_user_rows WHERE generation_id=$1", "$8");
    expect(directory).toContain('left(lower(btrim(f.username) COLLATE "default"),128) COLLATE "C"=left(keys.identity_key,128) COLLATE "C"');
    expect(directory).toContain('lower(btrim(f.username) COLLATE "default") COLLATE "C"=keys.identity_key');
    expect(directory).not.toContain("f.identity_key=keys.identity_key");
    const official = selectedOfficialReportRelationsSql("users", "SELECT * FROM official_usage_row_facts");
    expect(official).toContain("d.identity=k.directory_identity_key OR d.upn_key=k.directory_identity_key");
    expect(official).toContain("UNION SELECT directory_identity_key FROM selected_report_keys");
  });

  it("carries original aliases into warm reported-user pages without changing full name boundaries", async () => {
    const saved = context("official_users"), client = Object.assign(new pg.Client(), { release: vi.fn() });
    saved.selection.id = "44444444-4444-4444-8444-444444444444";
    vi.spyOn(Date, "now").mockReturnValue(saved.evaluatedAt.getTime());
    const username = "ＣＡＦＥ\u0301@example.invalid";
    const row = { identity: username, username, name: "Café", object_id: "directory-user", company: null, department: null,
      entitlement: "no_paid", responses: "1", agents_used: "1", bridge_responses: null, relationship_count: "0", active_agent_count: "0",
      user_last_activity: null, last_activity: null, user_rows: "1", review_cohort: "low", has_activity: true,
      page_key: "café", batch_position: "1", batch_total: "2", count_total: "2", count_filtered: "2",
      count_unresolved: false, count_primary_complete: true };
    const query = vi.spyOn(client, "query").mockImplementation(async sql => result(
      String(sql).includes("set_config(") ? [] : [row],
    ));
    const first = await reports.rowsInRead(client, saved, { limit: 1 });
    await reports.rowsInRead(client, saved, { limit: 1, cursor: first.page.nextCursor! });
    const [sql, values] = query.mock.calls.at(-1)!;
    expect(sql).toContain("selected_report_keys AS MATERIALIZED");
    expect(sql).toContain('lower(btrim(f.username) COLLATE "default") COLLATE "C" AS directory_identity_key');
    expect(sql).toContain("d.upn_key=k.directory_identity_key");
    expect(sql).toContain('ORDER BY left(page_key,128) COLLATE "C" ASC,page_key COLLATE "C" ASC');
    expect(values).toEqual(expect.arrayContaining([row.page_key, username]));
  });
});

describe("reported-user source reconciliation", () => {
  it.each([
    { responses: "0", agents: "0", active: "0", relationships: "1", mismatch: false },
    { responses: "5", agents: "1", active: "1", relationships: "2", mismatch: false },
    { responses: "5", agents: "2", active: "1", relationships: "2", mismatch: true },
  ])("compares agents used with response-producing agents, retaining all $relationships relationships", async ({ responses, agents, active, relationships, mismatch }) => {
    const saved = context("official_users"), client = Object.assign(new pg.Client(), { release: vi.fn() });
    const row = { identity: "CaseUser", username: "CaseUser", name: "", object_id: null, company: null, department: null,
      entitlement: null, responses, agents_used: agents, bridge_responses: responses, relationship_count: relationships, active_agent_count: active,
      user_last_activity: null, last_activity: null, user_rows: "1", review_cohort: responses === "0" ? "zero" : "low",
      has_activity: responses !== "0", page_key: null, batch_position: "1", batch_total: "1",
      count_total: "1", count_filtered: "1", count_unresolved: false, count_primary_complete: true };
    const query = mockQuery(client);
    query.mockResolvedValueOnce(result([])).mockResolvedValueOnce(result([row]));
    const page = await reports.rowsInRead(client, saved, { limit: 1 });
    expect(page.value).toMatchObject([{ reportedResponses: Number(responses), reportedAgentsUsed: Number(agents),
      responseProducingAgentCount: Number(active), relationshipCount: Number(relationships), hasReportMismatch: mismatch }]);
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

describe("exact report text filters", () => {
  it.each(["Custom\tAgent", "Custom\nAgent", "Custom\r\nAgent"])(
    "retains imported creator types in exact filters and saved query hashes: %j", creatorType => {
      expect(acceptedCreatorType(creatorType)).toBe(creatorType);
      for (const endpoint of ["copilot_users", "official_users", "official_agents", "relationships"] as const) {
        const query = reportQuery(endpoint, { creatorType });
        expect(query.creatorType).toBe(creatorType);
        expect(reportQuery(endpoint, query)).toEqual(query);
        expect(canonicalQuery(query, reportQueryFields)).toBe(
          canonicalQuery(reportQuery(endpoint, query), reportQueryFields),
        );
        const values: unknown[] = [];
        const sql = reports.filter({ ...context(endpoint), query }, endpoint, values);
        expect(sql).toContain("creator_type=$");
        expect(values).toContain(creatorType);
      }
    },
  );

  it.each(["company", "department", "creatorType"] as const)(
    "rejects unpaired surrogates in %s before database work", async field => {
      for (const value of ["Invalid\ud800", "Invalid\udfff"]) {
        await expect(reports.capture(identity, "delegated", "official_users", { [field]: value }))
          .rejects.toMatchObject({ status: 400, code: "invalid_cursor" });
      }
      expect(database.connect).not.toHaveBeenCalled();
    },
  );

  it.each(["company", "department", "creatorType"] as const)(
    "preserves valid surrogate pairs in %s", field => {
      const value = "Team \ud83e\udd16";
      expect(reportQuery("official_users", { [field]: value })[field]).toBe(value);
    },
  );

  it.each(["Custom\0Agent", "Custom\u000bAgent", "Custom\u0085Agent"])(
    "rejects creator-type characters that imports reject: %j", async creatorType => {
      expect(() => acceptedCreatorType(creatorType)).toThrow();
      await expect(reports.capture(identity, "delegated", "official_agents", { creatorType }))
        .rejects.toMatchObject({ status: 400, code: "invalid_cursor" });
      expect(database.connect).not.toHaveBeenCalled();
    },
  );
});

describe("report facet search", () => {
  it("reuses a cursor for canonically equivalent option searches", async () => {
    const { saved, query } = facetHarness(), first = facetRow("\u01f0"), second = facetRow("\u01f0z");
    const counts = result([{ total: "2", filtered: "2" }]);
    query.mockResolvedValueOnce(counts).mockResolvedValueOnce(result([first, second]))
      .mockResolvedValueOnce(counts).mockResolvedValueOnce(result([second]));
    const page = await reports.facets(saved.selection.id, identity, { field: "creatorType", search: "J\u030c", limit: 1 });
    const next = await reports.facets(saved.selection.id, identity, {
      field: "creatorType", search: "\ud835\udc09\u030c", limit: 1, cursor: page.page.nextCursor!,
    });
    expect(next.value).toEqual([{ value: "\u01f0z", count: 1 }]);
    expect(query.mock.calls[2][1]).toContain("\u01f0");
    query.mockResolvedValueOnce(counts);
    await expect(reports.facets(saved.selection.id, identity, {
      field: "creatorType", search: "changed", limit: 1, cursor: page.page.nextCursor!,
    })).rejects.toMatchObject({ code: "invalid_cursor" });
  });

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
