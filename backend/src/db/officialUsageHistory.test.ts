import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { retain } from "../../scripts/database.js";
import { testDatabase } from "../../scripts/testDatabase.js";
import { OfficialUsageHistoryService } from "../services/officialUsageHistory.js";
import { parseOfficialUsageReport } from "../services/officialUsageParser.js";
import type { OfficialUsageMetadata, OfficialUsageReportKind } from "../types/officialUsage.js";
import { OfficialUsageRepository, type OfficialUsageScope } from "./officialUsage.js";

let fixture: Awaited<ReturnType<typeof testDatabase>>;
let repository: OfficialUsageRepository;
let history: OfficialUsageHistoryService;
const scope = { tenantId: "tenant-official-history", principalId: "history-administrator-a" };
let dayOneSetId: string;
let dayTwoSetId: string;

beforeAll(async () => {
  fixture = await testDatabase();
  repository = new OfficialUsageRepository(fixture.runtime);
  history = new OfficialUsageHistoryService(fixture.runtime);
});
afterAll(async () => { await fixture?.close(); });

function metadata(startDate: string, endDate: string, sourceAsOf: string, downloadedAt?: string): OfficialUsageMetadata {
  return {
    reportingPeriod: { startDate, endDate, provenance: "operator_asserted" },
    sourceAsOf: { value: sourceAsOf, provenance: "operator_asserted" },
    ...(downloadedAt ? { downloadedAt } : {}),
  };
}

function reportCsv(kind: OfficialUsageReportKind, input: {
  count?: number;
  changedOrdinal?: number;
  changedResponses?: number;
  changedActivityDate?: string;
  reformatted?: boolean;
} = {}) {
  const count = input.count ?? 100;
  const rows = Array.from({ length: count }, (_, ordinal) => {
    const number = ordinal + 1;
    const responses = ordinal === input.changedOrdinal ? input.changedResponses ?? 5 : 4;
    const lastActivity = ordinal === input.changedOrdinal ? input.changedActivityDate ?? "2026-07-02" : "2026-07-01";
    if (kind === "agents") return [`agent-${number}`, `Agent ${number}`, "Your org", "1", "1", String(responses), lastActivity];
    if (kind === "userAgents") return [`agent-${number}`, `Agent ${number}`, "Your org", `user-${number}@example.invalid`, String(responses), lastActivity];
    return [`user-${number}@example.invalid`, `User ${number}`, "1", String(responses), lastActivity];
  });
  const headers = kind === "agents"
    ? ["Agent ID", "Agent name", "Creator type", "Active users (licensed)", "Active users (unlicensed)", "Responses sent to users", "Last activity date (UTC)"]
    : kind === "userAgents"
      ? ["Agent ID", "Agent name", "Creator type", "Username", "Responses sent to users", "Last activity date (UTC)"]
      : ["Username", "Display name", "Number of agents used", "Agent responses received", "Last activity date (UTC)"];
  if (!input.reformatted) return [headers.join(","), ...rows.map(row => row.join(","))].join("\n");
  return [
    [...headers].reverse().map(value => JSON.stringify(value)).join(","),
    ...rows.reverse().map(row => [...row].reverse().map(value => JSON.stringify(value)).join(",")),
  ].join("\r\n");
}

async function importBundle(input: {
  owner?: OfficialUsageScope;
  reportMetadata?: OfficialUsageMetadata;
  changedKinds?: Partial<Record<OfficialUsageReportKind, Parameters<typeof reportCsv>[1]>>;
  correctionOfSetId?: string;
  reformatted?: boolean;
}) {
  const owner = input.owner ?? scope;
  const bundleId = randomUUID();
  await Promise.all((["agents", "userAgents", "users"] as const).map(async kind => {
    const content = reportCsv(kind, { ...input.changedKinds?.[kind], reformatted: input.reformatted });
    await repository.stage(owner, {
      report: parseOfficialUsageReport(Buffer.from(content), input.reportMetadata),
      fileHash: createHash("sha256").update(content).digest("hex"),
      bundleId,
      correctionOfSetId: input.correctionOfSetId,
    });
  }));
  const preview = await repository.previewBundle(owner, bundleId);
  return {
    bundleId,
    preview,
    accept: () => repository.acceptBundle(owner, bundleId, preview),
  };
}

describe.sequential("official usage cumulative history", () => {
  it("retains next-day 99%-repeated snapshots without inflating overlapping totals", async () => {
    const first = await importBundle({
      reportMetadata: metadata("2026-06-02", "2026-07-01", "2026-07-02T08:00:00Z", "2026-07-02T09:00:00Z"),
    });
    dayOneSetId = (await first.accept()).setId;
    const second = await importBundle({
      reportMetadata: metadata("2026-06-03", "2026-07-02", "2026-07-03T08:00:00Z", "2026-07-03T09:00:00Z"),
      changedKinds: {
        agents: { changedOrdinal: 99 },
        userAgents: { changedOrdinal: 99 },
        users: { changedOrdinal: 99 },
      },
    });
    dayTwoSetId = (await second.accept()).setId;

    const view = await history.getHistory(scope.tenantId, { limit: 1, offset: 0 });
    expect(view.summary).toMatchObject({
      importCount: 2,
      uniqueObservationCount: 6,
      observationRowCount: 600,
      uniquePayloadCount: 303,
      repeatedRowsReused: 297,
      reportingWindows: {
        knownCount: 2,
        unknownCount: 0,
        overlappingKnownWindowCount: 2,
        additive: false,
      },
      activityDateRange: { provesReportingCoverage: false },
    });
    expect(view.summary).not.toHaveProperty("totalResponses");
    expect(view.bundles).toMatchObject({ count: 2, limit: 1, offset: 0 });
    expect(view.bundles.value[0]).toMatchObject({ expiresAt: null });
    expect((await history.getHistory(scope.tenantId, { limit: 1, offset: 1 })).bundles.value).toHaveLength(1);
    expect((await repository.getPublished(scope.tenantId)).activeSet?.id).toBe(dayTwoSetId);
    expect((await repository.getPublished(scope.tenantId, dayOneSetId)).reports.agents?.rows[99].responsesSentToUsers).toBe(4);
    expect((await repository.getPublished(scope.tenantId, dayTwoSetId)).reports.agents?.rows[99].responsesSentToUsers).toBe(5);
  });

  it("idempotently reuses semantic content across bundle IDs, administrators and CSV formatting", async () => {
    const before = await repository.getPublished(scope.tenantId);
    const acceptedAt = (await fixture.runtime.query<{ accepted_at: Date }>(
      "SELECT accepted_at FROM official_usage_sets WHERE id=$1", [dayTwoSetId])).rows[0].accepted_at;
    const duplicate = await importBundle({
      owner: { ...scope, principalId: "history-administrator-b" },
      reportMetadata: metadata("2026-06-03", "2026-07-02", "2026-07-03T08:00:00Z", "2026-08-01T12:00:00Z"),
      changedKinds: {
        agents: { changedOrdinal: 99 },
        userAgents: { changedOrdinal: 99 },
        users: { changedOrdinal: 99 },
      },
      reformatted: true,
    });
    const result = await duplicate.accept();
    expect(result).toMatchObject({ setId: dayTwoSetId, activeRevision: before.activeRevision, complete: true });
    expect((await fixture.runtime.query<{ sets: number; versions: number; facts: number }>(`SELECT
      (SELECT count(*)::int FROM official_usage_sets WHERE tenant_id=$1) AS sets,
      (SELECT count(*)::int FROM official_usage_versions WHERE tenant_id=$1) AS versions,
      (SELECT count(*)::int FROM official_usage_row_facts WHERE tenant_id=$1) AS facts`, [scope.tenantId])).rows[0])
      .toEqual({ sets: 2, versions: 6, facts: 303 });
    expect((await fixture.runtime.query<{ accepted_at: Date }>(
      "SELECT accepted_at FROM official_usage_sets WHERE id=$1", [dayTwoSetId])).rows[0].accepted_at)
      .toEqual(acceptedAt);
  });

  it("requires correction for a known-window revision even when source-as-of advances", async () => {
    const changedKinds = {
      agents: { changedOrdinal: 99, changedResponses: 6 },
      userAgents: { changedOrdinal: 99 },
      users: { changedOrdinal: 99 },
    };
    const prior = await repository.getPublished(scope.tenantId, dayTwoSetId);
    const advancedSource = metadata("2026-06-03", "2026-07-02", "2026-07-04T08:00:00Z");
    const unlabelled = await importBundle({ reportMetadata: advancedSource, changedKinds });
    await expect(unlabelled.accept()).rejects.toMatchObject({ code: "correction_required" });

    const correction = await importBundle({
      reportMetadata: advancedSource,
      changedKinds,
      correctionOfSetId: dayTwoSetId,
    });
    const corrected = await correction.accept();
    expect(corrected.setId).not.toBe(dayTwoSetId);
    expect((await repository.getPublished(scope.tenantId)).activeSet).toMatchObject({
      id: corrected.setId,
      supersedesSetId: dayTwoSetId,
    });
    expect((await repository.getPublished(scope.tenantId, dayTwoSetId)).reports.agents?.rows[99].responsesSentToUsers).toBe(5);
    const correctedPublished = await repository.getPublished(scope.tenantId, corrected.setId);
    expect(correctedPublished.reports.agents?.rows[99].responsesSentToUsers).toBe(6);
    expect(correctedPublished.reports.agents?.lineage).toMatchObject({
      sourceAsOf: "2026-07-04T08:00:00.000Z",
      supersedesVersionId: prior.reports.agents?.lineage.versionId,
    });
    expect(correctedPublished.reports.userAgents?.lineage).toMatchObject({
      sourceAsOf: "2026-07-04T08:00:00.000Z",
      supersedesVersionId: prior.reports.userAgents?.lineage.versionId,
    });
    expect(correctedPublished.reports.users?.lineage).toMatchObject({
      sourceAsOf: "2026-07-04T08:00:00.000Z",
      supersedesVersionId: prior.reports.users?.lineage.versionId,
    });
    expect((await history.getHistory(scope.tenantId)).summary).toMatchObject({
      importCount: 3,
      uniqueObservationCount: 9,
      observationRowCount: 900,
      uniquePayloadCount: 304,
      repeatedRowsReused: 596,
    });

    const deletion = await repository.previewSetOperation(scope, "delete", dayTwoSetId);
    await repository.confirmSetOperation(scope, deletion.id, {
      ...deletion,
      operation: "delete",
      setId: dayTwoSetId,
    });
    expect((await repository.getPublished(scope.tenantId)).activeSet?.id).toBe(corrected.setId);
    expect((await repository.getPublished(scope.tenantId, corrected.setId)).reports.userAgents?.rows).toHaveLength(100);
    await expect(repository.getPublished(scope.tenantId, dayTwoSetId))
      .rejects.toMatchObject({ code: "official_usage_set_not_found" });
  });

  it("keeps unknown activity ranges non-coverage, survives old expiry dates, and never resurrects deletion", async () => {
    const unknownScope = { tenantId: "tenant-official-history-unknown", principalId: "history-unknown-a" };
    const imported = await importBundle({
      owner: unknownScope,
      changedKinds: {
        agents: { count: 1 },
        userAgents: { count: 1 },
        users: { count: 1 },
      },
    });
    await imported.accept();
    const nextUnknown = await importBundle({
      owner: unknownScope,
      changedKinds: {
        agents: { count: 1, changedOrdinal: 0, changedResponses: 5, changedActivityDate: "2026-07-01" },
        userAgents: { count: 1, changedOrdinal: 0, changedResponses: 5, changedActivityDate: "2026-07-01" },
        users: { count: 1, changedOrdinal: 0, changedResponses: 5, changedActivityDate: "2026-07-01" },
      },
    });
    const accepted = await nextUnknown.accept();
    await fixture.operator.query(`UPDATE official_usage_sets
      SET accepted_at=clock_timestamp()-interval '181 days',expires_at=clock_timestamp()-interval '1 day'
      WHERE id=$1`, [accepted.setId]);
    await fixture.operator.query(`UPDATE official_usage_versions SET expires_at=clock_timestamp()-interval '1 day'
      WHERE id IN (SELECT version_id FROM official_usage_set_versions WHERE set_id=$1)`, [accepted.setId]);
    await retain(fixture.operator);

    expect((await history.getHistory(unknownScope.tenantId)).summary).toMatchObject({
      importCount: 2,
      reportingWindows: { knownCount: 0, unknownCount: 2, additive: false },
      activityDateRange: { provenance: "last_activity_dates", provesReportingCoverage: false },
    });
    expect((await repository.getPublished(unknownScope.tenantId, accepted.setId)).activeSet?.id).toBe(accepted.setId);

    const deletion = await repository.previewSetOperation(unknownScope, "delete", accepted.setId);
    await repository.confirmSetOperation(unknownScope, deletion.id, {
      ...deletion,
      operation: "delete",
      setId: accepted.setId,
    });
    const reupload = await importBundle({
      owner: { ...unknownScope, principalId: "history-unknown-b" },
      changedKinds: {
        agents: { count: 1, changedOrdinal: 0, changedResponses: 5, changedActivityDate: "2026-07-01" },
        userAgents: { count: 1, changedOrdinal: 0, changedResponses: 5, changedActivityDate: "2026-07-01" },
        users: { count: 1, changedOrdinal: 0, changedResponses: 5, changedActivityDate: "2026-07-01" },
      },
      reformatted: true,
    });
    await expect(reupload.accept()).rejects.toMatchObject({ code: "deleted_report_duplicate" });
    expect((await history.getHistory(unknownScope.tenantId)).summary.importCount).toBe(1);
    await expect(repository.getPublished(unknownScope.tenantId, accepted.setId))
      .rejects.toMatchObject({ code: "official_usage_set_not_found" });

    expect((await history.getHistory("tenant-official-history-other")).summary.importCount).toBe(0);
    await expect(repository.getPublished("tenant-official-history-other", dayOneSetId))
      .rejects.toMatchObject({ code: "official_usage_set_not_found" });
  });

  it("never exposes orphan facts or a partially disassociated restored observation", async () => {
    const restoreScope = { tenantId: "tenant-official-history-restore", principalId: "history-restore" };
    const imported = await importBundle({
      owner: restoreScope,
      reportMetadata: metadata("2026-06-02", "2026-07-01", "2026-07-02T08:00:00Z"),
      changedKinds: {
        agents: { count: 1 },
        userAgents: { count: 1 },
        users: { count: 1 },
      },
    });
    const accepted = await imported.accept();
    await fixture.operator.query(`DELETE FROM official_usage_version_rows row
      USING official_usage_set_versions membership
      WHERE membership.set_id=$1 AND membership.kind='agents'
        AND row.version_id=membership.version_id`, [accepted.setId]);

    expect((await fixture.operator.query<{ count: number }>(`SELECT count(*)::int AS count
      FROM official_usage_row_facts fact
      WHERE fact.tenant_id=$1 AND NOT EXISTS (
        SELECT 1 FROM official_usage_version_rows row
        WHERE row.tenant_id=fact.tenant_id AND row.kind=fact.kind AND row.payload_hash=fact.payload_hash)`,
    [restoreScope.tenantId])).rows[0].count).toBe(1);
    expect(await history.getHistory(restoreScope.tenantId)).toMatchObject({
      summary: { importCount: 0, uniqueObservationCount: 0, uniquePayloadCount: 0 },
      bundles: { count: 0, value: [] },
    });
    expect(await repository.getPublished(restoreScope.tenantId)).toMatchObject({
      activeSet: null,
      reports: {},
      activeSelectionIncomplete: true,
    });
    await expect(repository.getPublished(restoreScope.tenantId, accepted.setId))
      .rejects.toMatchObject({ code: "official_usage_set_not_found" });
  });

  it.each([
    [0, 0, 0],
    [0, 1, 1],
    [1, 0, 0],
  ])("counts only stored payloads with %i agent, %i user-agent and %i user rows", async (agents, userAgents, users) => {
    const owner = {
      tenantId: `tenant-official-history-empty-${agents}-${userAgents}-${users}`,
      principalId: "history-empty",
    };
    const counts = { agents, userAgents, users };
    const rowCount = agents + userAgents + users;
    const imported = await importBundle({
      owner,
      changedKinds: {
        agents: { count: agents },
        userAgents: { count: userAgents },
        users: { count: users },
      },
    });
    const accepted = await imported.accept();

    const view = await history.getHistory(owner.tenantId);
    expect(view.summary).toMatchObject({
      importCount: 1,
      uniqueObservationCount: 3,
      observationRowCount: rowCount,
      uniquePayloadCount: rowCount,
      repeatedRowsReused: 0,
    });
    expect(view.bundles.count).toBe(1);
    expect(view.bundles.value).toHaveLength(1);
    expect(view.bundles.value[0]).toMatchObject({
      id: accepted.setId,
      isActive: true,
      observationCount: 3,
      rowCount,
      uniquePayloadCount: rowCount,
      repeatedRowsReused: 0,
    });
    expect(view.bundles.value[0].observations).toHaveLength(3);
    for (const observation of view.bundles.value[0].observations) {
      expect(observation).toMatchObject({
        rowCount: counts[observation.kind],
        uniquePayloadCount: counts[observation.kind],
        repeatedRowsReused: 0,
      });
    }
  });
});
