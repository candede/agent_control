import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { testDatabase } from "../../scripts/testDatabase.js";
import { inventorySelectionFixture } from "../../scripts/inventoryFixtures.js";
import { OfficialReportImports } from "../db/officialReportImports.js";
import { deleteUsageSet, newUsageScope, publishUsageReports, saveUsageInventory, usageAudit, usageIdentity, usageIntent } from "../db/agentUsageTestSupport.js";
import { OfficialAgentUsage } from "./officialAgentUsage.js";
import { LargeTenantUsersReports } from "./largeTenantUsersReports.js";

let fixture: Awaited<ReturnType<typeof testDatabase>>, reports: LargeTenantUsersReports;
beforeAll(async () => {
  fixture = await testDatabase();
  reports = new LargeTenantUsersReports(fixture.runtime, "synthetic-agent-history-regression-secret", 35);
}, 30_000);
afterEach(() => vi.restoreAllMocks());
afterAll(async () => { await fixture?.close(); });
const dates = (date: string) => (_kind: string, csv: string) => csv.replaceAll(/2026-09-\d{2}/g, date);

describe("exact agent report history", () => {
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
    const optionsSelection = await reports.capture(selected.identity, "delegated", "history");
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

  it("identifies the newest report independently of an older shared selection and reads its details consistently", async () => {
    const scope = newUsageScope(), [record] = await saveUsageInventory(fixture.runtime, scope, [{ packages: ["Report-A"] }]);
    const older = await publishUsageReports(fixture.runtime, scope, 442, dates("2026-09-11"));
    const latest = await publishUsageReports(fixture.runtime, scope, 499, dates("2026-10-05"));
    const imports = new OfficialReportImports(fixture.runtime), identity = await usageIdentity(fixture.runtime, scope);
    await imports.confirm(identity, await imports.confirmPreview(identity, older.setId, "select"));
    const selected = await inventorySelectionFixture(fixture.runtime, scope), usage = new OfficialAgentUsage(reports, selected.queries);
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
    expect((await fixture.runtime.query("SELECT active_set_id FROM official_usage_state WHERE tenant_id=$1", [scope.tenantId])).rows[0].active_set_id).toBe(older.setId);
  });

  it("uses upload time only when every retained report lacks date metadata", async () => {
    const scope = newUsageScope(), [record] = await saveUsageInventory(fixture.runtime, scope, [{ packages: ["Report-A"] }]);
    await publishUsageReports(fixture.runtime, scope, 3, dates(""));
    const latest = await publishUsageReports(fixture.runtime, scope, 4, dates(""));
    const selected = await inventorySelectionFixture(fixture.runtime, scope), usage = new OfficialAgentUsage(reports, selected.queries);
    const history = await usage.history(selected.selection.id, selected.identity, record.id, { limit: 1 });
    expect(history.latestReportSetId).toBe(latest.setId);
    expect(history.value).toMatchObject([{ reportingStart: null, reportingEnd: null }]);
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
