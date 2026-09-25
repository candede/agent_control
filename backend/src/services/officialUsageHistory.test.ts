import type pg from "pg";
import { describe, expect, it, vi } from "vitest";
import { AppError } from "../errors.js";
import type { OfficialUsageReportKind } from "../types/officialUsage.js";
import {
  OfficialUsageHistoryService,
  officialUsageHistoryWarning,
  retainedSetIntegritySql,
  validateOfficialUsageHistoryOptions,
} from "./officialUsageHistory.js";

const currentSetId = "00000000-0000-4000-8000-000000000001";
const olderSetId = "00000000-0000-4000-8000-000000000002";

function bundleRow(id = currentSetId) {
  return {
    id, bundle_id: `bundle-${id}`, content_hash: `content-${id}`,
    reporting_start: "2026-06-03", reporting_end: "2026-07-02", period_provenance: "operator_asserted",
    supersedes_set_id: null, complete: true, accepted_at: new Date("2026-07-03T08:00:00.000Z"),
    deleted_at: null, created_at: new Date("2026-07-03T07:00:00.000Z"), expires_at: null,
    active_set_id: currentSetId,
  };
}

function observationRow(setId: string, kind: OfficialUsageReportKind, rowCount: number, uniquePayloadCount: number) {
  return {
    set_id: setId, id: `${setId}-${kind}`, kind, content_hash: `content-${kind}`,
    file_hash: `file-${kind}`, parser_version: "parser-v1", schema_version: "schema-v1",
    reporting_start: "2026-06-03", reporting_end: "2026-07-02", period_provenance: "operator_asserted",
    source_as_of: new Date("2026-07-03T06:00:00.000Z"), source_as_of_provenance: "source_metadata",
    source_freshness: "known", downloaded_at: new Date("2026-07-03T07:00:00.000Z"),
    row_count: rowCount, warnings: ["Source warning."], reconciliation: { mismatchCount: 1 },
    supersedes_version_id: null, accepted_at: new Date("2026-07-03T08:00:00.000Z"),
    unique_payload_count: String(uniquePayloadCount),
  };
}

function databaseFixture({
  bundles = [],
  observations = [],
}: { bundles?: object[]; observations?: object[] } = {}) {
  const summary = {
    import_count: 2, unique_observation_count: 5, observation_row_count: "12",
    unique_payload_count: "7", earliest_observed_at: new Date("2026-07-02T08:00:00.000Z"),
    latest_observed_at: new Date("2026-07-03T08:00:00.000Z"),
    earliest_activity_date: "2026-06-03T00:00:00.000Z", latest_activity_date: "2026-07-02T00:00:00.000Z",
    earliest_reporting_start: "2026-06-02", latest_reporting_end: "2026-07-02",
    known_window_count: 2, unknown_window_count: 0, overlapping_known_window_count: 2,
  };
  const client = {
    query: vi.fn(async (sql: string, _parameters?: unknown[]) => {
      if (sql.startsWith("WITH retained_sets")) return { rows: [summary] };
      if (sql.startsWith("SELECT report_set.id")) return { rows: bundles };
      if (sql.startsWith("SELECT membership.set_id")) return { rows: observations };
      if (["BEGIN", "COMMIT", "ROLLBACK", "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY"].includes(sql)) {
        return { rows: [] };
      }
      throw new Error("Unexpected history query.");
    }),
    release: vi.fn(),
  };
  const database = { connect: vi.fn().mockResolvedValue(client), query: vi.fn() };
  return { service: new OfficialUsageHistoryService(database as unknown as pg.Pool), database, client, summary };
}

describe("official usage history contract", () => {
  it("states that rolling snapshots and activity ranges are not additive coverage", () => {
    expect(officialUsageHistoryWarning).toEqual({
      code: "rolling_snapshots_not_additive",
      message: expect.stringMatching(/not summed or subtracted.*do not prove reporting coverage/i),
    });
  });

  it("pages set metadata without aggregating off-page rows or recounting the retained sets", async () => {
    const { service, client } = databaseFixture();
    const view = await service.getHistory("tenant-A", { limit: 1, offset: 2 });
    expect(view.bundles).toEqual({ value: [], count: 2, limit: 1, offset: 2 });
    expect(view.summary.importCount).toBe(2);
    const statements = client.query.mock.calls.map(([sql]) => sql);
    const bundleSql = statements.find(sql => sql.startsWith("SELECT report_set.id"));
    expect(bundleSql).toContain("LIMIT $2 OFFSET $3");
    expect(bundleSql).not.toContain("GROUP BY report_set.id");
    expect(bundleSql).not.toContain("JOIN official_usage_version_rows row");
    expect(statements.filter(sql => sql.startsWith("SELECT count(*)::int AS count"))).toEqual([]);
    expect(statements.some(sql => sql.startsWith("SELECT membership.set_id"))).toBe(false);
  });

  it("derives bundle accounting from paged observations in the same tenant-scoped read snapshot", async () => {
    const { service, database, client } = databaseFixture({
      bundles: [bundleRow()],
      observations: [
        observationRow(currentSetId, "agents", 4, 2),
        observationRow(currentSetId, "userAgents", 2, 1),
        observationRow(currentSetId, "users", 0, 0),
      ],
    });
    const view = await service.getHistory("tenant-A", { limit: 1, offset: 1 });
    expect(view.bundles).toMatchObject({ count: 2, limit: 1, offset: 1 });
    expect(view.bundles.value).toHaveLength(1);
    expect(view.bundles.value[0]).toMatchObject({
      id: currentSetId, isActive: true, complete: true, kinds: ["agents", "userAgents", "users"],
      observationCount: 3, rowCount: 6, uniquePayloadCount: 3, repeatedRowsReused: 3,
      reportingWindowKnown: true, activityRangeIsCoverage: false,
      reportingPeriod: { startDate: "2026-06-03", endDate: "2026-07-02", provenance: "operator_asserted" },
      acceptedAt: "2026-07-03T08:00:00.000Z", createdAt: "2026-07-03T07:00:00.000Z",
      expiresAt: null, deletedAt: null, supersedesSetId: null,
    });
    expect(view.bundles.value[0]?.observations[0]).toEqual({
      versionId: `${currentSetId}-agents`, kind: "agents", contentHash: "content-agents",
      rowCount: 4, uniquePayloadCount: 2, repeatedRowsReused: 2,
      lineage: {
        kind: "agents", versionId: `${currentSetId}-agents`, contentHash: "content-agents",
        fileHash: "file-agents", parserVersion: "parser-v1", schemaVersion: "schema-v1",
        reportingPeriod: { startDate: "2026-06-03", endDate: "2026-07-02", days: 30, provenance: "operator_asserted" },
        sourceAsOf: "2026-07-03T06:00:00.000Z", sourceAsOfProvenance: "source_metadata", sourceFreshness: "known",
        downloadedAt: "2026-07-03T07:00:00.000Z", acceptedAt: "2026-07-03T08:00:00.000Z",
        rowCount: 4, warnings: ["Source warning."], reconciliation: { mismatchCount: 1 }, supersedesVersionId: null,
      },
    });
    expect(view.summary).toMatchObject({
      importCount: 2, uniqueObservationCount: 5, observationRowCount: 12, uniquePayloadCount: 7, repeatedRowsReused: 5,
      earliestObservedAt: "2026-07-02T08:00:00.000Z", latestObservedAt: "2026-07-03T08:00:00.000Z",
      activityDateRange: {
        earliestDateUtc: "2026-06-03T00:00:00.000Z", latestDateUtc: "2026-07-02T00:00:00.000Z",
        provenance: "last_activity_dates", provesReportingCoverage: false,
      },
      reportingWindows: {
        earliestStartDateUtc: "2026-06-02", latestEndDateUtc: "2026-07-02",
        knownCount: 2, unknownCount: 0, overlappingKnownWindowCount: 2, additive: false,
      },
    });
    expect(database.connect).toHaveBeenCalledOnce();
    expect(database.query).not.toHaveBeenCalled();
    expect(client.query.mock.calls).toEqual([
      ["BEGIN"],
      ["SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY"],
      [expect.stringContaining("WITH retained_sets"), ["tenant-A"]],
      [expect.stringContaining("SELECT report_set.id"), ["tenant-A", 1, 1]],
      [expect.stringContaining("SELECT membership.set_id"), ["tenant-A", [currentSetId]]],
      ["COMMIT"],
    ]);
    for (const index of [2, 3]) {
      const sql = client.query.mock.calls[index]![0];
      expect(sql).toContain("report_set.tenant_id=$1 AND report_set.complete AND report_set.deleted_at IS NULL");
      expect(sql).toContain(retainedSetIntegritySql);
      expect(sql).not.toMatch(/expires_at\s*[<>]/);
    }
    expect(client.query.mock.calls[4]?.[0]).toContain("membership.tenant_id=$1 AND membership.set_id=ANY($2::uuid[])");
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("keeps a reused observation in each containing bundle without double-counting the history summary", async () => {
    const shared = observationRow(olderSetId, "agents", 2, 1);
    shared.accepted_at = new Date("2026-07-02T08:00:00.000Z");
    const { service, summary } = databaseFixture({
      bundles: [bundleRow(), { ...bundleRow(olderSetId), accepted_at: shared.accepted_at }],
      observations: [
        shared,
        observationRow(olderSetId, "userAgents", 1, 1),
        observationRow(olderSetId, "users", 1, 1),
        { ...shared, set_id: currentSetId },
        observationRow(currentSetId, "userAgents", 1, 1),
        observationRow(currentSetId, "users", 1, 1),
      ],
    });
    summary.observation_row_count = "6";
    summary.unique_payload_count = "5";
    const view = await service.getHistory("tenant-A");
    expect(view.summary).toMatchObject({ uniqueObservationCount: 5, observationRowCount: 6, repeatedRowsReused: 1 });
    expect(view.bundles.value.map(bundle => [bundle.id, bundle.isActive])).toEqual([
      [currentSetId, true], [olderSetId, false],
    ]);
    for (const bundle of view.bundles.value) {
      expect(bundle).toMatchObject({ observationCount: 3, rowCount: 4, uniquePayloadCount: 3, repeatedRowsReused: 1 });
      expect(bundle.observations[0]).toMatchObject({
        versionId: shared.id, lineage: { acceptedAt: "2026-07-02T08:00:00.000Z" },
      });
    }
  });

  it.each([
    [0, 0, 0], [0, 1, 1], [1, 0, 0],
  ])("keeps empty exports in bundle accounting with %i agent, %i bridge and %i user rows", async (agents, userAgents, users) => {
    const { service } = databaseFixture({
      bundles: [bundleRow()],
      observations: [
        observationRow(currentSetId, "agents", agents, agents),
        observationRow(currentSetId, "userAgents", userAgents, userAgents),
        observationRow(currentSetId, "users", users, users),
      ],
    });
    const view = await service.getHistory("tenant-A");
    expect(view.bundles.value[0]).toMatchObject({
      kinds: ["agents", "userAgents", "users"], observationCount: 3,
      rowCount: agents + userAgents + users, uniquePayloadCount: agents + userAgents + users, repeatedRowsReused: 0,
    });
    expect(view.bundles.value[0]?.observations.map(observation => observation.rowCount)).toEqual([agents, userAgents, users]);
  });

  it("preserves unknown activity coverage and legacy expiry metadata", async () => {
    const { service } = databaseFixture({
      bundles: [{
        ...bundleRow(), reporting_start: null, reporting_end: null, period_provenance: "activity_range",
        expires_at: new Date("2020-01-01T00:00:00.000Z"),
      }],
      observations: (["agents", "userAgents", "users"] as const).map(kind => ({
        ...observationRow(currentSetId, kind, 0, 0), reporting_start: null, reporting_end: null,
        period_provenance: "activity_range", source_as_of: null, source_as_of_provenance: "absent",
        source_freshness: "unknown", downloaded_at: null,
      })),
    });
    const view = await service.getHistory("tenant-A");
    expect(view.bundles.value[0]).toMatchObject({
      reportingPeriod: { startDate: null, endDate: null, provenance: "activity_range" },
      reportingWindowKnown: false, activityRangeIsCoverage: false, expiresAt: "2020-01-01T00:00:00.000Z",
    });
    expect(view.bundles.value[0]?.observations[0]?.lineage).toMatchObject({
      reportingPeriod: { startDate: null, endDate: null, days: null, provenance: "activity_range" },
      sourceAsOf: undefined, sourceAsOfProvenance: "absent", sourceFreshness: "unknown", downloadedAt: undefined,
    });
  });

  it.each(["WITH retained_sets", "SELECT report_set.id", "SELECT membership.set_id", "COMMIT"])(
    "rolls back and releases the snapshot if %s fails", async failingStatement => {
      const { service, client } = databaseFixture({ bundles: [bundleRow()] });
      const query = client.query.getMockImplementation()!;
      client.query.mockImplementation(async (sql, parameters) => {
        if (sql.startsWith(failingStatement)) throw new Error("History read failed.");
        return query(sql, parameters);
      });
      await expect(service.getHistory("tenant-A")).rejects.toThrow("History read failed.");
      expect(client.query).toHaveBeenLastCalledWith("ROLLBACK");
      expect(client.release).toHaveBeenCalledOnce();
    },
  );

  it("rejects missing scope or invalid paging before opening the database", async () => {
    const { service, database } = databaseFixture();
    await expect(service.getHistory("")).rejects.toMatchObject({ status: 403, code: "scope_mismatch" });
    await expect(service.getHistory("tenant-A", { offset: 0.5 })).rejects.toMatchObject({
      status: 400, code: "invalid_usage_query",
    });
    expect(database.connect).not.toHaveBeenCalled();
  });

  it("applies bounded paging defaults and rejects unbounded archive reads", () => {
    expect(validateOfficialUsageHistoryOptions({})).toEqual({ limit: 25, offset: 0 });
    expect(validateOfficialUsageHistoryOptions({ limit: 100, offset: 100_000 }))
      .toEqual({ limit: 100, offset: 100_000 });
    for (const options of [
      { limit: 0 },
      { limit: 101 },
      { offset: -1 },
      { offset: 100_001 },
      { limit: Number.NaN },
    ]) {
      expect(() => validateOfficialUsageHistoryOptions(options)).toThrowError(
        expect.objectContaining<Partial<AppError>>({ code: "invalid_usage_query", status: 400 }),
      );
    }
  });
});
