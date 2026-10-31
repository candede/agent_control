import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { testDatabase } from "../../scripts/testDatabase.js";
import { inventorySelectionFixture } from "../../scripts/inventoryFixtures.js";
import { OfficialReportImports } from "../db/officialReportImports.js";
import { deleteUsageSet, newUsageScope, publishUsageReports, saveUsageInventory, usageAudit, usageIdentity, usageIntent } from "../db/agentUsageTestSupport.js";
import { OfficialAgentUsage } from "./officialAgentUsage.js";
import { LargeTenantUsersReports, reportQuery, type ReportReadContext } from "./largeTenantUsersReports.js";
import { compareAgentHistory, readAgentHistory } from "./officialAgentHistory.js";
import type { UserSourceMetadata } from "../types/userSources.js";

let fixture: Awaited<ReturnType<typeof testDatabase>>, reports: LargeTenantUsersReports;
afterEach(() => vi.restoreAllMocks());
const dates = (date: string) => (_kind: string, csv: string) => csv.replaceAll(/2026-09-\d{2}/g, date);

describe("qualified retained snapshot comparison", () => {
  const from: Parameters<typeof compareAgentHistory>[0] = { id: "30000000-0000-4000-8000-000000000001",
    reporting_start: "2026-01-01", reporting_end: "2026-01-30", period_provenance: "operator_asserted",
    accepted_at: "2026-01-31T00:00:00Z", responses: "0", last_activity: null, association_count: "1", page_key: null,
    cohort_hash: "exact-cohort", candidate_count: "1", matched_count: "1", ambiguous_report_rows: false };
  const to = { ...from, id: "30000000-0000-4000-8000-000000000003", reporting_start: "2026-03-01", reporting_end: "2026-03-30", responses: "50" };
  it("labels new activity without division by a zero baseline", () => {
    expect(compareAgentHistory(from, to)).toMatchObject({ state: "comparable", reasons: ["new_activity"], responsesDelta: 50, responseGrowthPercent: null });
  });
  it("does not qualify partial, ambiguous, unknown or changed association cohorts as growth", () => {
    expect(compareAgentHistory(from, { ...to, candidate_count: "2" })).toMatchObject({ state: "unknown", responseGrowthPercent: null,
      reasons: ["unknown_agent_report_coverage"] });
    expect(compareAgentHistory(from, { ...to, ambiguous_report_rows: true }).state).toBe("unknown");
    expect(compareAgentHistory(from, { ...to, cohort_hash: "other-cohort" })).toMatchObject({ state: "incomparable",
      reasons: ["different_association_cohorts"] });
    expect(compareAgentHistory(from, { ...to, responses: null }).state).toBe("unknown");
  });
});

describe("exact agent report history", () => {
  beforeAll(async () => {
    fixture = await testDatabase();
    reports = new LargeTenantUsersReports(fixture.runtime, "synthetic-agent-history-regression-secret", 35);
  }, 30_000);
  afterAll(async () => { await fixture?.close(); });

  it("compares overlapping snapshots without addition and keeps historical drilldown local", async () => {
    const scope = newUsageScope(), [record] = await saveUsageInventory(fixture.runtime, scope, [{ packages: ["Report-A"] }]);
    const first = await publishUsageReports(fixture.runtime, scope, 200, (_kind, csv) =>
      csv.replaceAll("2026-09-15", "2026-09-01").replaceAll(/2026-09-(16|18)/g, "2026-10-01"));
    const second = await publishUsageReports(fixture.runtime, scope, 210, (_kind, csv) =>
      csv.replaceAll("2026-09-15", "2026-09-05").replaceAll(/2026-09-(16|18)/g, "2026-10-04"));
    const backfill = await publishUsageReports(fixture.runtime, scope, 55, dates("2026-09-12"));
    expect(backfill.activeRevision).toBe(second.activeRevision);
    const selected = await inventorySelectionFixture(fixture.runtime, scope), usage = new OfficialAgentUsage(reports, selected.queries);
    const history = await usage.history(selected.selection.id, selected.identity, record.id);
    expect(history.value.map(point => [point.setId, point.responses]))
      .toEqual([[second.setId, 210], [first.setId, 200], [backfill.setId, 55]]);
    expect(history.latestReported?.setId).toBe(second.setId);
    expect(history.latestReportSetId).toBe(second.setId);
    const optionsSelection = await reports.capture(selected.identity, "history");
    const options = await reports.historyOptions(optionsSelection.id, selected.identity, { limit: 1 });
    expect(options.value).toMatchObject([{ id: second.setId }]);
    expect((await reports.historyOptions(optionsSelection.id, selected.identity, { limit: 1, cursor: options.page.nextCursor! })).value)
      .toMatchObject([{ id: first.setId }]);
    const local = (await usage.summaries(selected.selection.id, selected.identity, [record.id], first.setId))[0];
    expect(local).toMatchObject({ responses: 200, context: { selectionId: selected.selection.id, reportSetId: first.setId } });
    expect((await usage.users(selected.selection.id, selected.identity, record.id, { setId: first.setId })).context).toEqual(local.context);
    expect((await usage.associations(selected.selection.id, selected.identity, record.id, { setId: first.setId })).context).toEqual(local.context);
    expect((await usage.summaries(selected.selection.id, selected.identity, [record.id]))[0].responses).toBe(210);
    expect((await fixture.runtime.query("SELECT active_set_id FROM official_usage_state WHERE tenant_id=$1", [scope.tenantId])).rows[0].active_set_id).toBe(second.setId);
  });

  it("identifies the newest report independently of an older personal selection and reads its details consistently", async () => {
    const scope = newUsageScope(), [record] = await saveUsageInventory(fixture.runtime, scope, [{ packages: ["Report-A"] }]);
    const older = await publishUsageReports(fixture.runtime, scope, 442, dates("2026-09-11"));
    const latest = await publishUsageReports(fixture.runtime, scope, 499, dates("2026-10-05"));
    const selected = await inventorySelectionFixture(fixture.runtime, scope, { setId: older.setId }), usage = new OfficialAgentUsage(reports, selected.queries);
    const history = await usage.history(selected.selection.id, selected.identity, record.id);
    expect(history.context.reportSetId).toBe(older.setId);
    expect(history.latestReportSetId).toBe(latest.setId);
    const summary = (await usage.summaries(selected.selection.id, selected.identity, [record.id], history.latestReportSetId!))[0];
    expect(summary).toMatchObject({ responses: 499, lastActivityDateUtc: "2026-10-05T00:00:00.000Z",
      context: { selectionId: selected.selection.id, reportSetId: latest.setId } });
    expect((await usage.users(selected.selection.id, selected.identity, record.id, { setId: latest.setId })).context).toEqual(summary.context);
    expect((await usage.associations(selected.selection.id, selected.identity, record.id, { setId: latest.setId })).context).toEqual(summary.context);
    expect((await usage.summaries(selected.selection.id, selected.identity, [record.id]))[0])
      .toMatchObject({ responses: 442, lastActivityDateUtc: "2026-09-11T00:00:00.000Z" });
    expect((await fixture.runtime.query("SELECT active_set_id FROM official_usage_state WHERE tenant_id=$1", [scope.tenantId])).rows[0].active_set_id).toBe(latest.setId);
  });

  it("uses upload time only when every retained report lacks date metadata", async () => {
    const scope = newUsageScope(), [record] = await saveUsageInventory(fixture.runtime, scope, [{ packages: ["Report-A"] }]);
    const imported = [await publishUsageReports(fixture.runtime, scope, 0, dates("")),
      await publishUsageReports(fixture.runtime, scope, 4, dates(""))];
    const latest = [...imported].sort((left, right) => left.setId < right.setId ? -1 : 1)[0];
    await fixture.operator.query(`UPDATE official_usage_sets
      SET accepted_at=clock_timestamp()-CASE WHEN id=$2::uuid THEN interval '1 second' ELSE interval '2 seconds' END
      WHERE tenant_id=$1`, [scope.tenantId, latest.setId]);
    const selected = await inventorySelectionFixture(fixture.runtime, scope), usage = new OfficialAgentUsage(reports, selected.queries);
    const history = await usage.history(selected.selection.id, selected.identity, record.id, { limit: 1 });
    expect(history.latestReportSetId).toBe(latest.setId);
    expect(history.latestReported).toMatchObject({ setId: latest.setId, responses: imported[0] === latest ? 0 : 4 });
    expect(history.value[0].setId).not.toBe(latest.setId);
    expect(history.value).toMatchObject([{ reportingStart: null, reportingEnd: null }]);
    const next = await usage.history(selected.selection.id, selected.identity, record.id, { limit: 1, cursor: history.page.nextCursor! });
    expect(next.latestReported).toEqual(history.latestReported);
    expect(next.latestReportSetId).toBe(history.latestReportSetId);
  });

  it("preserves zero, missing, and undated reports and does not use bridge-only agent matches", async () => {
    const scope = newUsageScope(), [record] = await saveUsageInventory(fixture.runtime, scope, [{ packages: ["Report-A"] }]);
    const zero = await publishUsageReports(fixture.runtime, scope, 0, dates("2026-09-12"));
    const missing = await publishUsageReports(fixture.runtime, scope, 3, (kind, csv) =>
      dates("2026-10-04")(kind, kind === "agents" ? csv.split("\n").filter(line => !line.startsWith("Report-A,")).join("\n") : csv));
    const undated = await publishUsageReports(fixture.runtime, scope, 4, dates(""));
    const selected = await inventorySelectionFixture(fixture.runtime, scope), usage = new OfficialAgentUsage(reports, selected.queries);
    const history = await usage.history(selected.selection.id, selected.identity, record.id);
    expect(history.value).toMatchObject([
      { setId: missing.setId, status: "unlinked", responses: null },
      { setId: zero.setId, status: "linked", responses: 0 },
      { setId: undated.setId, reportingStart: null, reportingEnd: null, responses: 4 },
    ]);
    expect(history.latestReported).toMatchObject({ setId: zero.setId, responses: 0 });
    expect(history.latestReportSetId).toBe(missing.setId);
    const first = await usage.history(selected.selection.id, selected.identity, record.id, { limit: 2 });
    const last = await usage.history(selected.selection.id, selected.identity, record.id, { limit: 2, cursor: first.page.nextCursor! });
    expect(last.value.map(point => point.setId)).toEqual([undated.setId]);
    expect(last.latestReportSetId).toBe(missing.setId);
    expect((await usage.history(selected.selection.id, selected.identity, record.id, { limit: 2, cursor: last.page.previousCursor! })).value).toEqual(first.value);
  });

  it("uses report-specific reviewed links and returns discovery beyond the current page", async () => {
    const scope = newUsageScope(), [record] = await saveUsageInventory(fixture.runtime, scope, [{ packages: ["Package-A"] }]);
    const first = await publishUsageReports(fixture.runtime, scope, 10, dates("2026-09-12"));
    const usage = new OfficialAgentUsage(reports);
    await usage.mutate(await usageIdentity(fixture.runtime, scope), record.id,
      await usageIntent(fixture.runtime, scope), usageAudit(scope).actor);
    const later = await publishUsageReports(fixture.runtime, scope, 20, dates("2026-10-04"));
    const selected = await inventorySelectionFixture(fixture.runtime, scope), reader = new OfficialAgentUsage(reports, selected.queries);
    const history = await reader.history(selected.selection.id, selected.identity, record.id, { limit: 1 });
    expect(history.value).toMatchObject([{ setId: later.setId, responses: null }]);
    expect(history.latestReported).toMatchObject({ setId: first.setId, responses: 10 });
    expect(history.latestReportSetId).toBe(later.setId);
    expect(history.page.nextCursor).not.toBeNull();
  });

  it("pages ten reports by period with deterministic ties and reuses bounded cached results", async () => {
    const scope = newUsageScope(), [record] = await saveUsageInventory(fixture.runtime, scope, [{ packages: ["Report-A"] }]);
    for (const index of [3, 7, 0, 9, 4, 2, 6, 1, 8, 5]) {
      await publishUsageReports(fixture.runtime, scope, index, dates(`2026-09-${String(10 + Math.floor(index / 2)).padStart(2, "0")}`));
    }
    const selected = await inventorySelectionFixture(fixture.runtime, scope), usage = new OfficialAgentUsage(reports, selected.queries);
    const query = vi.spyOn(pg.Client.prototype, "query");
    const first = await usage.history(selected.selection.id, selected.identity, record.id, { limit: 3 });
    expect(await usage.history(selected.selection.id, selected.identity, record.id, { limit: 3 })).toEqual(first);
    expect(query.mock.calls.filter(call => typeof call[0] === "string" && call[0].includes("linked_ids AS"))).toHaveLength(1);
    expect(query.mock.calls.find(call => typeof call[0] === "string" && call[0].includes("linked_ids AS"))?.[0]).not.toContain("userAgents");
    const second = await usage.history(selected.selection.id, selected.identity, record.id, { limit: 3, cursor: first.page.nextCursor! });
    expect(first.latestReportSetId).toBe(first.value[0].setId);
    expect(second.latestReportSetId).toBe(first.latestReportSetId);
    expect(second.value.every(point => !first.value.some(prior => prior.setId === point.setId))).toBe(true);
    expect((await usage.history(selected.selection.id, selected.identity, record.id, { limit: 3, cursor: second.page.previousCursor! })).value).toEqual(first.value);
    expect(first.counts.total).toBe(10);
    expect(first.value.map(point => point.reportingEnd)).toEqual(["2026-09-14", "2026-09-14", "2026-09-13"]);
    expect(first.value.map(point => point.responses)).toEqual([8, 9, 6]);
    await expect(usage.history(selected.selection.id, selected.identity, record.id, { limit: 101 })).rejects.toMatchObject({ code: "invalid_cursor" });
  }, 30_000);

  it("fences cached history, foreign identities, and reports outside a saved history revision", async () => {
    const scope = newUsageScope(), [record] = await saveUsageInventory(fixture.runtime, scope, [{ packages: ["Report-A"] }]);
    const first = await publishUsageReports(fixture.runtime, scope);
    const selected = await inventorySelectionFixture(fixture.runtime, scope), usage = new OfficialAgentUsage(reports, selected.queries);
    await usage.history(selected.selection.id, selected.identity, record.id);
    const later = await publishUsageReports(fixture.runtime, scope, 20);
    expect((await usage.history(selected.selection.id, selected.identity, record.id)).value).toHaveLength(1);
    await expect(usage.summaries(selected.selection.id, selected.identity, [record.id], later.setId)).rejects.toMatchObject({ code: "selection_invalidated" });
    for (const identity of [{ ...selected.identity, principalId: "foreign" }, { ...selected.identity, tenantId: "foreign" },
      { ...selected.identity, authorizationHash: "changed" }]) {
      await expect(usage.history(selected.selection.id, identity, record.id)).rejects.toMatchObject({ code: "selection_invalidated" });
    }
    await deleteUsageSet(fixture.runtime, scope, first.setId);
    await expect(usage.history(selected.selection.id, selected.identity, record.id)).rejects.toMatchObject({ code: "selection_invalidated" });
  });

  it("returns explicit empty history without a report", async () => {
    const scope = newUsageScope(), [record] = await saveUsageInventory(fixture.runtime, scope, [{ packages: ["Report-A"] }]);
    const selected = await inventorySelectionFixture(fixture.runtime, scope), usage = new OfficialAgentUsage(reports, selected.queries);
    expect(await usage.history(selected.selection.id, selected.identity, record.id)).toMatchObject({
      value: [], latestReportSetId: null, latestReported: null, counts: { total: 0, filtered: 0 }, page: { nextCursor: null, previousCursor: null },
    });
  });

  it("replaces corrected snapshots rather than adding another trend point", async () => {
    const scope = newUsageScope(), [record] = await saveUsageInventory(fixture.runtime, scope, [{ packages: ["Report-A"] }]);
    const original = await publishUsageReports(fixture.runtime, scope, 10);
    const selected = await inventorySelectionFixture(fixture.runtime, scope), usage = new OfficialAgentUsage(reports, selected.queries);
    await usage.history(selected.selection.id, selected.identity, record.id);
    const corrected = await publishUsageReports(fixture.runtime, scope, 15, undefined, { correctionOfSetId: original.setId });
    await expect(usage.history(selected.selection.id, selected.identity, record.id)).rejects.toMatchObject({ code: "selection_invalidated" });
    const current = await inventorySelectionFixture(fixture.runtime, scope);
    const history = await usage.history(current.selection.id, current.identity, record.id);
    expect(history.value).toMatchObject([{ setId: corrected.setId, responses: 15 }]);
    expect(history.value).toHaveLength(1);
  });
});

describe("agent history discovery query", () => {
  it("orders undated discovery by acceptance time without changing the page's UUID boundary", async () => {
    const database = new pg.Pool({ max: 4 }), client = Object.assign(new pg.Client(), { release: vi.fn() });
    vi.spyOn(database, "connect").mockRejectedValue(new Error("Unexpected database acquisition"));
    const query = vi.spyOn(client, "query");
    const source = (source: UserSourceMetadata["source"]): UserSourceMetadata => ({
      source, generationId: null, scopeId: null, revision: null, expiresAt: null, observedAt: null,
      attemptedAt: null, attemptStatus: null, attemptObservedCount: null, errorCode: null, message: null,
      rowCount: null, state: "unavailable", reportRefreshDate: null, period: null, reportVersion: null,
    });
    const reportMetadata: ReportReadContext["report"] = { setId: null, activeSetId: null, activeRevision: "1", historyRevision: "2", historyEpoch: "0",
      availability: "not_selected", staleAfterDays: 35, periodAgeDays: null, acceptedAgeDays: null,
      acceptedAt: null, expiresAt: null, reportingPeriod: null, lineages: [] };
    const context: ReportReadContext = {
      identity: { tenantId: "history-unit-tenant", principalId: "history-unit-principal", authorizationHash: "viewer", sessionEpoch: "1" },
      tokenMode: "delegated", endpoint: "official_agents", query: reportQuery("official_agents"), queryHash: "query",
      evaluatedAt: new Date(), metadata: { directory: source("directory"), app_activity: source("app_activity") }, report: reportMetadata,
      selection: { id: "11111111-1111-4111-8111-111111111111", revision: "1",
        evaluatedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() },
    };
    const item = { id: "ffffffff-ffff-4fff-8fff-ffffffffffff", reporting_start: null, reporting_end: null,
      period_provenance: "unknown", accepted_at: "2026-10-01T00:00:00Z", responses: "4", association_count: "1", last_activity: null, page_key: null };
    const latest = { ...item, id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", accepted_at: "2026-10-02T00:00:00Z", responses: "0" };
    query.mockImplementationOnce(async () => ({ command: "SELECT", rowCount: 0, oid: 0, fields: [], rows: [] }))
      .mockImplementationOnce(async () => ({ command: "SELECT", rowCount: 1, oid: 0, fields: [],
        rows: [{ item, latest, latest_set_id: latest.id, total: "2" }] }));
    const localReports = new LargeTenantUsersReports(database, "synthetic-agent-history-unit-regression-secret", 35);
    const target = { id: "canonical-agent", context: { selectionId: context.selection.id, reportSetId: null,
      usageRevision: "usage", inventoryRevision: "inventory", reports: reportMetadata } };
    try {
      const history = await readAgentHistory(client, localReports, context, target, "agent:canonical-agent", { limit: 1 });
      expect(history.latestReported).toMatchObject({ setId: latest.id, responses: 0, lastActivityDateUtc: null });
      const sql = String(query.mock.calls[1][0]);
      expect(sql).toMatch(/WHERE responses IS NOT NULL\s+ORDER BY \(page_key IS NULL\)::int,page_key COLLATE "C" DESC,\s+CASE WHEN page_key IS NULL THEN accepted_at END DESC,id DESC/);
      expect(sql).toContain("COALESCE(page_key,'') COLLATE \"C\",id::text COLLATE \"C\"");
      expect(sql).not.toContain("userAgents");
      expect(query.mock.calls[1][1]).toEqual([context.identity.tenantId, "2", context.identity.principalId,
        target.id, context.evaluatedAt, null, "", "", 2, null, null]);
      expect(database.connect).not.toHaveBeenCalled();
    } finally { await database.end(); }
  });
});
