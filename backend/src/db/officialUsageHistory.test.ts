import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { retainUntilConverged } from "../../scripts/database.js";
import { testDatabase } from "../../scripts/testDatabase.js";
import { selectionIdentity } from "../../scripts/largeTenantFixtures.js";
import { OfficialReportImports } from "./officialReportImports.js";
import { LargeTenantUsersReports } from "../services/largeTenantUsersReports.js";
import { schemaRegistry } from "../services/officialReportFields.js";
import type { OfficialUsageMetadata } from "../types/officialReportRecords.js";
import type { SelectionIdentity } from "../services/dataSelections.js";
import type { ReportHistorySet, ReportObservation, ReportPage } from "../types/officialReportData.js";

const kinds = ["agents", "userAgents", "users"] as const;
type Kind = typeof kinds[number];
type Rows = { count?: number; changedOrdinal?: number; changedResponses?: number; changedActivityDate?: string };
let fixture: Awaited<ReturnType<typeof testDatabase>>, imports: OfficialReportImports, reports: LargeTenantUsersReports;
beforeAll(async () => {
  fixture = await testDatabase(); imports = new OfficialReportImports(fixture.runtime);
  reports = new LargeTenantUsersReports(fixture.runtime, "synthetic-native-history-regression-secret", 35);
}, 30_000);
afterAll(async () => { await fixture?.close(); });
const owner = (): SelectionIdentity => ({ ...selectionIdentity, tenantId: `native-history-${randomUUID()}` });
const metadata = (startDate: string, endDate: string, sourceAsOf: string, downloadedAt?: string): OfficialUsageMetadata => ({
  reportingPeriod: { startDate, endDate, provenance: "operator_asserted" },
  sourceAsOf: { value: sourceAsOf, provenance: "operator_asserted" }, ...(downloadedAt ? { downloadedAt } : {}),
});
async function bundle(identity: SelectionIdentity, options: {
  metadata?: OfficialUsageMetadata; rows?: Partial<Record<Kind, Rows>>; correctionOfSetId?: string; reformatted?: boolean;
} = {}) {
  const bundleId = randomUUID();
  for (const kind of kinds) {
    async function* chunks() {
      const input = options.rows?.[kind] ?? {}, count = input.count ?? 100;
      const encode = (values: readonly string[]) => options.reformatted
        ? [...values].reverse().map(value => `"${value.replaceAll('"', '""')}"`).join(",") + "\r\n" : values.join(",") + "\n";
      yield Buffer.from(encode(schemaRegistry[kind].headers));
      for (let index = 0; index < count; index++) {
        const ordinal = options.reformatted ? count - index - 1 : index, number = ordinal + 1;
        const responses = ordinal === input.changedOrdinal ? input.changedResponses ?? 5 : 4;
        const date = ordinal === input.changedOrdinal ? input.changedActivityDate ?? "2026-07-02" : "2026-07-01";
        const values = kind === "agents" ? [`agent-${number}`, `Agent ${number}`, "Your org", "1", "1", String(responses), date]
          : kind === "userAgents" ? [`agent-${number}`, `Agent ${number}`, "Your org", `user-${number}@example.invalid`, String(responses), date]
            : [`user-${number}@example.invalid`, `User ${number}`, "1", String(responses), date];
        yield Buffer.from(encode(values));
      }
    }
    await imports.stage(identity, { bundleId, correctionOfSetId: options.correctionOfSetId }, chunks(), options.metadata);
  }
  const preview = await imports.bundle(identity, bundleId);
  return { bundleId, preview, accept: () => imports.acceptBundle(identity, bundleId, preview) };
}
async function history(identity: SelectionIdentity, limit = 50) {
  const selected = await reports.capture(identity, "delegated", "history");
  return reports.page(selected.id, identity, { limit }) as Promise<ReportPage<ReportHistorySet>>;
}
async function observed(identity: SelectionIdentity, selectionId: string, setId: string) {
  await reports.exact(selectionId, identity, setId);
  return reports.page(selectionId, identity, { endpoint: "observations", child: setId, limit: 3 }) as Promise<ReportPage<ReportObservation>>;
}
async function selectedAgents(identity: SelectionIdentity, setId?: string, search?: string) {
  const selected = await reports.capture(identity, "delegated", "official_agents", { ...(setId ? { setId } : {}), ...(search ? { search } : {}) });
  return reports.page(selected.id, identity, { limit: 1 });
}
async function remove(identity: SelectionIdentity, setId: string) {
  return imports.confirm(identity, await imports.confirmPreview(identity, setId, "delete"));
}
const one = (changes: Rows = {}): Record<Kind, Rows> => ({ agents: { count: 1, ...changes }, userAgents: { count: 1, ...changes }, users: { count: 1, ...changes } });

describe("native cumulative history and immutable observations", () => {
  it("retains next-day 99%-repeated snapshots without inflating overlapping totals", async () => {
    const identity = owner();
    const first = await (await bundle(identity, { metadata: metadata("2026-06-02", "2026-07-01", "2026-07-02T08:00:00Z") })).accept();
    const second = await (await bundle(identity, { metadata: metadata("2026-06-03", "2026-07-02", "2026-07-03T08:00:00Z"),
      rows: { agents: { changedOrdinal: 99 }, userAgents: { changedOrdinal: 99 }, users: { changedOrdinal: 99 } } })).accept();
    const firstPage = await history(identity, 1);
    expect(firstPage.analytics.history).toMatchObject({
      imports: 2, uniqueObservations: 6, observationRows: 600, uniquePayloads: 303, repeatedRowsReused: 297,
      earliestReportingStart: "2026-06-02", latestReportingEnd: "2026-07-02", knownWindows: 2, unknownWindows: 0,
      overlappingKnownWindows: 2, additive: false, activityRangeProvesCoverage: false,
    });
    expect(firstPage.analytics.responses).toBeNull();
    expect(firstPage.counts).toEqual({ total: 2, filtered: 2 }); expect(firstPage.value).toHaveLength(1);
    expect(firstPage.page.nextCursor).toEqual(expect.any(String));
    const next = await reports.page(firstPage.selection.id, identity, { limit: 1, cursor: firstPage.page.nextCursor! });
    expect(next.value).toHaveLength(1); expect(next.analytics).toEqual(firstPage.analytics);
    expect((await selectedAgents(identity)).reports.setId).toBe(second.setId);
    expect((await selectedAgents(identity, first.setId, "agent-100")).value).toMatchObject([{ responses: 4 }]);
    expect((await selectedAgents(identity, second.setId, "agent-100")).value).toMatchObject([{ responses: 5 }]);
    const observations = await observed(identity, firstPage.selection.id, first.setId);
    expect(observations.counts).toEqual({ total: 3, filtered: 3 });
    expect(observations.value.map(row => row.rowCount)).toEqual([100, 100, 100]);
  });

  it("reuses reversed and reformatted semantic content across administrators without changing history or storage", async () => {
    const identity = owner(), options = { metadata: metadata("2026-06-03", "2026-07-02", "2026-07-03T08:00:00Z"),
      rows: { agents: { changedOrdinal: 99 }, userAgents: { changedOrdinal: 99 }, users: { changedOrdinal: 99 } } };
    const original = await (await bundle(identity, options)).accept(), before = await history(identity);
    const duplicate = await bundle({ ...identity, principalId: "another-history-administrator" }, { ...options, reformatted: true,
      metadata: { ...options.metadata, downloadedAt: "2026-08-01T12:00:00Z" } });
    expect(await duplicate.accept()).toEqual(original);
    const after = await history(identity);
    expect(after.value).toEqual(before.value); expect(after.analytics).toEqual(before.analytics);
    expect(after.reports.historyRevision).toBe(before.reports.historyRevision);
    expect((await fixture.runtime.query(`SELECT
      (SELECT count(*)::int FROM official_usage_sets WHERE tenant_id=$1) AS sets,
      (SELECT count(*)::int FROM official_usage_versions WHERE tenant_id=$1) AS versions,
      (SELECT count(*)::int FROM official_usage_row_facts WHERE tenant_id=$1) AS facts`, [identity.tenantId])).rows)
      .toEqual([{ sets: 1, versions: 3, facts: 300 }]);
  });

  it("recalculates known reporting envelopes after deletion while excluding drafts and other tenants", async () => {
    const identity = owner();
    const first = await (await bundle(identity, { metadata: metadata("2026-06-02", "2026-07-01", "2026-07-02T08:00:00Z"), rows: one() })).accept();
    const second = await (await bundle(identity, { metadata: metadata("2026-08-01", "2026-08-30", "2026-08-31T08:00:00Z"), rows: one({ count: 0 }) })).accept();
    await (await bundle(identity, { rows: one({ changedOrdinal: 0, changedActivityDate: "2026-05-01" }) })).accept();
    await bundle(identity, { metadata: metadata("2026-09-01", "2026-09-30", "2026-10-01T08:00:00Z"), rows: one({ count: 0 }) });
    expect((await history(identity, 1)).analytics.history).toMatchObject({
      imports: 3, earliestReportingStart: "2026-06-02", latestReportingEnd: "2026-08-30", knownWindows: 2, unknownWindows: 1,
      overlappingKnownWindows: 0, additive: false, earliestActivityDateUtc: "2026-05-01",
    });
    expect((await history(owner())).analytics.history).toMatchObject({
      imports: 0, earliestReportingStart: null, latestReportingEnd: null, knownWindows: 0, unknownWindows: 0,
    });
    for (const setId of [first.setId, second.setId]) {
      await remove(identity, setId);
      expect((await history(identity)).analytics.history).toMatchObject({
        earliestReportingStart: setId === first.setId ? "2026-08-01" : null,
        latestReportingEnd: setId === first.setId ? "2026-08-30" : null,
        knownWindows: setId === first.setId ? 1 : 0, unknownWindows: 1,
      });
    }
  });

  it("derives activity dates from every kind without asserting reporting coverage or adding overlapping metrics", async () => {
    const identity = owner();
    const dated = (dates: [string, string, string]) => bundle(identity, { rows: {
      agents: { count: 1, changedOrdinal: 0, changedActivityDate: dates[0] },
      userAgents: { count: 1, changedOrdinal: 0, changedActivityDate: dates[1] },
      users: { count: 1, changedOrdinal: 0, changedActivityDate: dates[2] },
    } });
    const first = await (await dated(["2026-01-15", "2026-01-01", "2026-02-01"])).accept();
    const second = await (await dated(["2026-09-20", "2026-03-01", "2026-09-10"])).accept();
    await dated(["2025-01-01", "2025-01-01", "2025-01-01"]);
    const view = await history(identity, 1);
    expect(view.analytics.history).toMatchObject({ imports: 2, knownWindows: 0, earliestActivityDateUtc: "2026-01-01",
      latestActivityDateUtc: "2026-09-20", activityRangeProvesCoverage: false });
    const next = await reports.page(view.selection.id, identity, { limit: 1, cursor: view.page.nextCursor! });
    expect(next.analytics.history).toEqual(view.analytics.history);
    await remove(identity, first.setId);
    expect((await history(identity)).analytics.history).toMatchObject({ imports: 1, earliestActivityDateUtc: "2026-03-01",
      latestActivityDateUtc: "2026-09-20", knownWindows: 0, activityRangeProvesCoverage: false });
    expect((await selectedAgents(identity)).reports.setId).toBe(second.setId);
  });

  it("preserves correction observation lineage and explicit historical snapshots when source-as-of advances", async () => {
    const identity = owner(), prior = await (await bundle(identity, {
      metadata: metadata("2026-06-03", "2026-07-02", "2026-07-03T08:00:00Z"), rows: one({ changedOrdinal: 0 }) })).accept();
    const before = await history(identity), previous = await observed(identity, before.selection.id, prior.setId);
    const corrected = await (await bundle(identity, { correctionOfSetId: prior.setId,
      metadata: metadata("2026-06-03", "2026-07-02", "2026-07-04T08:00:00Z"),
      rows: { agents: { count: 1, changedOrdinal: 0, changedResponses: 6 }, userAgents: { count: 1, changedOrdinal: 0 },
        users: { count: 1, changedOrdinal: 0 } } })).accept();
    expect(corrected.setId).not.toBe(prior.setId);
    expect((await selectedAgents(identity, prior.setId)).value).toMatchObject([{ responses: 5 }]);
    expect((await selectedAgents(identity, corrected.setId)).value).toMatchObject([{ responses: 6 }]);
    await expect(reports.page(before.selection.id, identity)).rejects.toMatchObject({ code: "selection_invalidated" });
    const after = await history(identity), observations = await observed(identity, after.selection.id, corrected.setId);
    for (const observation of observations.value) expect(observation).toMatchObject({
      sourceAsOf: "2026-07-04T08:00:00.000Z", supersedesVersionId: previous.value.find(row => row.kind === observation.kind)!.versionId,
    });
    expect(after.analytics.history).toMatchObject({ imports: 2, uniqueObservations: 6, observationRows: 6, uniquePayloads: 4, repeatedRowsReused: 2 });
    expect(after.value.find(row => row.id === prior.setId)?.visibility).toBe("superseded");
    await remove(identity, prior.setId);
    expect((await selectedAgents(identity)).reports.setId).toBe(corrected.setId);
    await expect(selectedAgents(identity, prior.setId)).rejects.toMatchObject({ status: 409 });
  });

  it.each([false, true])("reimports expired bytes without reviving an expired set (reformatted: %s)", async reformatted => {
    const identity = owner(), original = await (await bundle(identity, { rows: one() })).accept();
    const second = await (await bundle(identity, { rows: one({ changedOrdinal: 0, changedResponses: 5, changedActivityDate: "2026-07-01" }) })).accept();
    const pinned = await history(identity);
    expect(pinned.analytics.history).toMatchObject({ imports: 2, knownWindows: 0, unknownWindows: 2, activityRangeProvesCoverage: false });
    await fixture.operator.query("UPDATE official_usage_sets SET expires_at=clock_timestamp()-interval '1 day' WHERE id=$1", [second.setId]);
    await fixture.operator.query(`UPDATE official_usage_versions SET expires_at=clock_timestamp()-interval '1 day'
      WHERE id IN (SELECT version_id FROM official_usage_set_versions WHERE set_id=$1)`, [second.setId]);
    await fixture.operator.query(`UPDATE official_usage_artifacts SET expires_at=clock_timestamp()-interval '1 day'
      WHERE id IN (SELECT v.artifact_id FROM official_usage_versions v JOIN official_usage_set_versions m ON m.version_id=v.id WHERE m.set_id=$1)`, [second.setId]);
    expect((await history(identity)).analytics.history?.imports).toBe(1);
    await expect(reports.page(pinned.selection.id, identity)).rejects.toMatchObject({ code: "selection_invalidated" });
    const reimported = await (await bundle({ ...identity, principalId: "history-reimport" }, {
      reformatted, rows: one({ changedOrdinal: 0, changedResponses: 5, changedActivityDate: "2026-07-01" }) })).accept();
    expect([original.setId, second.setId]).not.toContain(reimported.setId);
    const refreshed = await history(identity);
    expect(refreshed.analytics.history?.imports).toBe(2);
    expect(refreshed.value.find(row => row.id === reimported.setId)?.active).toBe(true);
    expect(refreshed.value.some(row => row.id === second.setId)).toBe(false);
    await expect(selectedAgents(identity, second.setId)).rejects.toMatchObject({ status: 409 });
    expect((await selectedAgents(identity)).reports.setId).toBe(reimported.setId);
    expect((await history(owner())).analytics.history?.imports).toBe(0);
    await expect(selectedAgents(owner(), original.setId)).rejects.toMatchObject({ status: 409 });
  });

  it.each([false, true])("never exposes orphan or partial restored observations (inactive: %s)", async inactive => {
    const identity = owner(), accepted = await (await bundle(identity, { rows: one() })).accept();
    const current = inactive ? await (await bundle(identity, { rows: one({ changedOrdinal: 0, changedResponses: 5 }) })).accept() : null;
    const pinned = await history(identity);
    await fixture.operator.query(`DELETE FROM official_usage_version_rows r USING official_usage_set_versions m
      WHERE m.set_id=$1 AND m.kind='agents' AND r.version_id=m.version_id`, [accepted.setId]);
    expect((await fixture.operator.query(`SELECT count(*)::int AS n FROM official_usage_row_facts f
      WHERE f.tenant_id=$1 AND NOT EXISTS(SELECT 1 FROM official_usage_version_rows r
        WHERE r.tenant_id=f.tenant_id AND r.kind=f.kind AND r.payload_hash=f.payload_hash)`, [identity.tenantId])).rows).toEqual([{ n: 1 }]);
    await expect(reports.page(pinned.selection.id, identity)).rejects.toMatchObject({ code: "selection_invalidated" });
    const historic = await history(identity);
    expect(historic.counts).toEqual({ total: inactive ? 1 : 0, filtered: inactive ? 1 : 0 });
    expect(historic.analytics.history).toMatchObject({
      imports: inactive ? 1 : 0, uniqueObservations: inactive ? 3 : 0, uniquePayloads: inactive ? 3 : 0,
    });
    expect((await selectedAgents(identity)).value).toMatchObject(inactive ? [{ responses: 5 }] : []);
    if (current) expect(historic.reports).toMatchObject({ activeSetId: current.setId, activeRevision: pinned.reports.activeRevision });
    await expect(selectedAgents(identity, accepted.setId)).rejects.toMatchObject({ status: 409 });
    await retainUntilConverged(fixture.operator, { batchSize: 250 });
  });

  it.each([[0, 0, 0], [0, 1, 1], [1, 0, 0]])("counts exactly stored payloads with %i agents, %i bridge and %i users", async (agents, userAgents, users) => {
    const identity = owner(), counts = { agents, userAgents, users }, rowCount = agents + userAgents + users;
    const accepted = await (await bundle(identity, { rows: { agents: { count: agents }, userAgents: { count: userAgents }, users: { count: users } } })).accept();
    const view = await history(identity);
    expect(view.analytics.history).toMatchObject({ imports: 1, uniqueObservations: 3, observationRows: rowCount, uniquePayloads: rowCount, repeatedRowsReused: 0 });
    expect(view.counts).toEqual({ total: 1, filtered: 1 });
    expect(view.value).toMatchObject([{ id: accepted.setId, active: true }]);
    const observations = await observed(identity, view.selection.id, accepted.setId);
    expect(observations.value).toHaveLength(3);
    for (const observation of observations.value) expect(observation.rowCount).toBe(counts[observation.kind]);
  });
});
