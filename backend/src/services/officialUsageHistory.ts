import type pg from "pg";
import { AppError } from "../errors.js";
import { pool, transaction } from "../db/pool.js";
import type {
  OfficialUsageHistoryBundleSummary,
  OfficialUsageHistoryObservationSummary,
  OfficialUsageHistoryView,
  OfficialUsagePeriodProvenance,
  OfficialUsageReportKind,
} from "../types/officialUsage.js";

export const officialUsageHistoryWarning = {
  code: "rolling_snapshots_not_additive",
  message: "Official exports are rolling-window snapshots. Overlapping snapshots are not summed or subtracted, and last-activity ranges do not prove reporting coverage.",
} as const;

export type OfficialUsageHistoryOptions = {
  limit?: number;
  offset?: number;
};

type SummaryRow = {
  import_count: number;
  unique_observation_count: number;
  observation_row_count: string;
  unique_payload_count: string;
  earliest_observed_at: Date | null;
  latest_observed_at: Date | null;
  earliest_activity_date: string | null;
  latest_activity_date: string | null;
  known_window_count: number;
  unknown_window_count: number;
  overlapping_known_window_count: number;
};

type BundleRow = {
  id: string;
  bundle_id: string;
  content_hash: string;
  reporting_start: string | Date | null;
  reporting_end: string | Date | null;
  period_provenance: OfficialUsagePeriodProvenance;
  supersedes_set_id: string | null;
  complete: boolean;
  accepted_at: Date | null;
  deleted_at: Date | null;
  created_at: Date;
  expires_at: Date | null;
  active_set_id: string | null;
  observation_count: number;
  row_count: string;
  unique_payload_count: string;
  kinds: OfficialUsageReportKind[];
};

type ObservationRow = {
  set_id: string;
  id: string;
  kind: OfficialUsageReportKind;
  content_hash: string;
  file_hash: string;
  parser_version: string;
  schema_version: string;
  reporting_start: string | Date | null;
  reporting_end: string | Date | null;
  period_provenance: OfficialUsagePeriodProvenance;
  source_as_of: Date | null;
  source_as_of_provenance: "source_metadata" | "operator_asserted" | "absent";
  source_freshness: "known" | "unknown";
  downloaded_at: Date | null;
  row_count: number;
  warnings: string[];
  reconciliation: Record<string, unknown>;
  supersedes_version_id: string | null;
  accepted_at: Date;
  unique_payload_count: string;
};

export class OfficialUsageHistoryService {
  constructor(private readonly database: pg.Pool = pool) {}

  async getHistory(tenantId: string, options: OfficialUsageHistoryOptions = {}): Promise<OfficialUsageHistoryView> {
    if (!tenantId) throw new AppError(403, "scope_mismatch", "Official usage history requires an exact tenant scope.");
    const { limit, offset } = validateOfficialUsageHistoryOptions(options);
    return transaction(this.database, async client => {
      await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const summary = (await client.query<SummaryRow>(historySummarySql, [tenantId])).rows[0];
      const count = (await client.query<{ count: number }>(`SELECT count(*)::int AS count
        FROM official_usage_sets report_set
        WHERE report_set.tenant_id=$1 AND report_set.complete AND report_set.deleted_at IS NULL
          AND ${retainedSetIntegritySql}`, [tenantId])).rows[0].count;
      const bundles = await client.query<BundleRow>(`SELECT report_set.id,report_set.bundle_id,report_set.content_hash,
          report_set.reporting_start,report_set.reporting_end,report_set.period_provenance,
          report_set.supersedes_set_id,report_set.complete,report_set.accepted_at,report_set.deleted_at,
          report_set.created_at,report_set.expires_at,state.active_set_id,
          count(DISTINCT membership.version_id)::int AS observation_count,
          count(row.ordinal)::text AS row_count,
          count(DISTINCT (row.kind,row.payload_hash))
            FILTER (WHERE row.ordinal IS NOT NULL)::text AS unique_payload_count,
          coalesce(array_agg(DISTINCT membership.kind ORDER BY membership.kind)
            FILTER (WHERE membership.kind IS NOT NULL),'{}') AS kinds
        FROM official_usage_sets report_set
        LEFT JOIN official_usage_state state ON state.tenant_id=report_set.tenant_id
        LEFT JOIN official_usage_set_versions membership
          ON membership.set_id=report_set.id AND membership.tenant_id=report_set.tenant_id
        LEFT JOIN official_usage_versions version
          ON version.id=membership.version_id AND version.deleted_at IS NULL
        LEFT JOIN official_usage_version_rows row
          ON row.version_id=version.id AND row.tenant_id=version.tenant_id AND row.kind=version.kind
        WHERE report_set.tenant_id=$1 AND report_set.complete AND report_set.deleted_at IS NULL
          AND ${retainedSetIntegritySql}
        GROUP BY report_set.id,state.active_set_id
        ORDER BY report_set.accepted_at DESC,report_set.id DESC
        LIMIT $2 OFFSET $3`, [tenantId, limit, offset]);
      const setIds = bundles.rows.map(row => row.id);
      const observations = setIds.length
        ? await client.query<ObservationRow>(`SELECT membership.set_id,version.id,version.kind,version.content_hash,
            artifact.file_hash,artifact.parser_version,artifact.schema_version,
            version.reporting_start,version.reporting_end,version.period_provenance,version.source_as_of,
            version.source_as_of_provenance,version.source_freshness,version.downloaded_at,version.row_count,
            version.warnings,version.reconciliation,version.supersedes_version_id,version.accepted_at,
            count(DISTINCT row.payload_hash)::text AS unique_payload_count
          FROM official_usage_set_versions membership
          JOIN official_usage_versions version
            ON version.id=membership.version_id AND version.tenant_id=membership.tenant_id
              AND version.kind=membership.kind AND version.deleted_at IS NULL
          JOIN official_usage_artifacts artifact
            ON artifact.id=version.artifact_id AND artifact.tenant_id=version.tenant_id
              AND artifact.kind=version.kind
          LEFT JOIN official_usage_version_rows row
            ON row.version_id=version.id AND row.tenant_id=version.tenant_id AND row.kind=version.kind
          WHERE membership.tenant_id=$1 AND membership.set_id=ANY($2::uuid[])
          GROUP BY membership.set_id,version.id,artifact.file_hash,artifact.parser_version,artifact.schema_version
          ORDER BY membership.set_id,version.kind`, [tenantId, setIds])
        : { rows: [] as ObservationRow[] };
      const observationsBySet = new Map<string, ObservationRow[]>();
      for (const observation of observations.rows) {
        const existing = observationsBySet.get(observation.set_id);
        if (existing) existing.push(observation);
        else observationsBySet.set(observation.set_id, [observation]);
      }
      return {
        summary: projectSummary(summary),
        bundles: {
          value: bundles.rows.map(row => projectBundle(row, observationsBySet.get(row.id) ?? [])),
          count,
          limit,
          offset,
        },
      };
    });
  }
}

export function validateOfficialUsageHistoryOptions(options: OfficialUsageHistoryOptions) {
  const limit = options.limit ?? 25;
  const offset = options.offset ?? 0;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 ||
      !Number.isSafeInteger(offset) || offset < 0 || offset > 100_000) {
    throw new AppError(400, "invalid_usage_query", "Official usage history paging is outside the supported range.");
  }
  return { limit, offset };
}

export const retainedSetIntegritySql = `(SELECT count(*) FROM official_usage_set_versions candidate
      WHERE candidate.set_id=report_set.id AND candidate.tenant_id=report_set.tenant_id)=3
    AND NOT EXISTS (SELECT 1 FROM official_usage_set_versions candidate
      JOIN official_usage_versions candidate_version ON candidate_version.id=candidate.version_id
        AND candidate_version.tenant_id=candidate.tenant_id AND candidate_version.kind=candidate.kind
      WHERE candidate.set_id=report_set.id AND candidate.tenant_id=report_set.tenant_id
        AND (candidate_version.deleted_at IS NOT NULL OR candidate_version.row_count<>(
          SELECT count(*) FROM official_usage_version_rows candidate_row
          WHERE candidate_row.version_id=candidate_version.id
            AND candidate_row.tenant_id=candidate_version.tenant_id
            AND candidate_row.kind=candidate_version.kind)))`;

const historySummarySql = `WITH retained_sets AS MATERIALIZED (
    SELECT id,accepted_at,reporting_start,reporting_end,period_provenance
    FROM official_usage_sets report_set
    WHERE report_set.tenant_id=$1 AND report_set.complete AND report_set.deleted_at IS NULL
      AND ${retainedSetIntegritySql}
  ), retained_versions AS MATERIALIZED (
    SELECT DISTINCT version.id,version.tenant_id,version.kind
    FROM retained_sets report_set
    JOIN official_usage_set_versions membership ON membership.set_id=report_set.id
    JOIN official_usage_versions version ON version.id=membership.version_id
      AND version.tenant_id=membership.tenant_id AND version.kind=membership.kind
    WHERE version.deleted_at IS NULL
  ), retained_rows AS MATERIALIZED (
    SELECT row.tenant_id,row.kind,row.payload_hash
    FROM retained_versions version
    JOIN official_usage_version_rows row ON row.version_id=version.id
      AND row.tenant_id=version.tenant_id AND row.kind=version.kind
  ), activity AS (
    SELECT min(fact.row_data->>'lastActivityDateUtc') FILTER (
        WHERE NULLIF(fact.row_data->>'lastActivityDateUtc','') IS NOT NULL) AS earliest_activity_date,
      max(fact.row_data->>'lastActivityDateUtc') FILTER (
        WHERE NULLIF(fact.row_data->>'lastActivityDateUtc','') IS NOT NULL) AS latest_activity_date
    FROM retained_rows row
    JOIN official_usage_row_facts fact ON fact.tenant_id=row.tenant_id
      AND fact.kind=row.kind AND fact.payload_hash=row.payload_hash
  )
  SELECT
    (SELECT count(*)::int FROM retained_sets) AS import_count,
    (SELECT count(*)::int FROM retained_versions) AS unique_observation_count,
    (SELECT count(*)::text FROM retained_rows) AS observation_row_count,
    (SELECT count(*)::text FROM (
      SELECT DISTINCT kind,payload_hash FROM retained_rows
    ) payloads) AS unique_payload_count,
    (SELECT min(accepted_at) FROM retained_sets) AS earliest_observed_at,
    (SELECT max(accepted_at) FROM retained_sets) AS latest_observed_at,
    activity.earliest_activity_date,activity.latest_activity_date,
    (SELECT count(*)::int FROM retained_sets
      WHERE period_provenance<>'activity_range'
        AND reporting_start IS NOT NULL AND reporting_end IS NOT NULL) AS known_window_count,
    (SELECT count(*)::int FROM retained_sets
      WHERE period_provenance='activity_range'
        OR reporting_start IS NULL OR reporting_end IS NULL) AS unknown_window_count,
    (SELECT count(*)::int FROM retained_sets report_set
      WHERE report_set.period_provenance<>'activity_range'
        AND report_set.reporting_start IS NOT NULL AND report_set.reporting_end IS NOT NULL
        AND EXISTS (SELECT 1 FROM retained_sets other
          WHERE other.id<>report_set.id AND other.period_provenance<>'activity_range'
            AND other.reporting_start IS NOT NULL AND other.reporting_end IS NOT NULL
            AND other.reporting_start<=report_set.reporting_end
            AND other.reporting_end>=report_set.reporting_start)) AS overlapping_known_window_count
  FROM activity`;

function projectSummary(row: SummaryRow): OfficialUsageHistoryView["summary"] {
  const observationRowCount = Number(row.observation_row_count);
  const uniquePayloadCount = Number(row.unique_payload_count);
  return {
    importCount: row.import_count,
    uniqueObservationCount: row.unique_observation_count,
    observationRowCount,
    uniquePayloadCount,
    repeatedRowsReused: observationRowCount - uniquePayloadCount,
    earliestObservedAt: row.earliest_observed_at?.toISOString() ?? null,
    latestObservedAt: row.latest_observed_at?.toISOString() ?? null,
    activityDateRange: {
      earliestDateUtc: row.earliest_activity_date,
      latestDateUtc: row.latest_activity_date,
      provenance: "last_activity_dates",
      provesReportingCoverage: false,
    },
    reportingWindows: {
      knownCount: row.known_window_count,
      unknownCount: row.unknown_window_count,
      overlappingKnownWindowCount: row.overlapping_known_window_count,
      additive: false,
    },
    warning: officialUsageHistoryWarning,
  };
}

function projectBundle(row: BundleRow, versions: ObservationRow[]): OfficialUsageHistoryBundleSummary {
  const rowCount = Number(row.row_count);
  const uniquePayloadCount = Number(row.unique_payload_count);
  return {
    id: row.id,
    bundleId: row.bundle_id,
    contentHash: row.content_hash,
    reportingPeriod: {
      startDate: dateValue(row.reporting_start),
      endDate: dateValue(row.reporting_end),
      provenance: row.period_provenance,
    },
    supersedesSetId: row.supersedes_set_id,
    complete: row.complete,
    kinds: row.kinds,
    acceptedAt: row.accepted_at?.toISOString() ?? null,
    deletedAt: row.deleted_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    expiresAt: row.expires_at?.toISOString() ?? null,
    isActive: row.active_set_id === row.id,
    observationCount: row.observation_count,
    rowCount,
    uniquePayloadCount,
    repeatedRowsReused: rowCount - uniquePayloadCount,
    reportingWindowKnown: row.period_provenance !== "activity_range" &&
      row.reporting_start !== null && row.reporting_end !== null,
    activityRangeIsCoverage: false,
    observations: versions.map(projectObservation),
  };
}

function projectObservation(row: ObservationRow): OfficialUsageHistoryObservationSummary {
  const uniquePayloadCount = Number(row.unique_payload_count);
  const reportingPeriod = {
    startDate: dateValue(row.reporting_start),
    endDate: dateValue(row.reporting_end),
    days: periodDays(row.reporting_start, row.reporting_end),
    provenance: row.period_provenance,
  };
  return {
    versionId: row.id,
    kind: row.kind,
    contentHash: row.content_hash,
    rowCount: row.row_count,
    uniquePayloadCount,
    repeatedRowsReused: row.row_count - uniquePayloadCount,
    lineage: {
      kind: row.kind,
      versionId: row.id,
      contentHash: row.content_hash,
      fileHash: row.file_hash,
      parserVersion: row.parser_version,
      schemaVersion: row.schema_version,
      reportingPeriod,
      sourceAsOf: row.source_as_of?.toISOString(),
      sourceAsOfProvenance: row.source_as_of_provenance,
      sourceFreshness: row.source_freshness,
      downloadedAt: row.downloaded_at?.toISOString(),
      acceptedAt: row.accepted_at.toISOString(),
      rowCount: row.row_count,
      warnings: row.warnings,
      reconciliation: row.reconciliation,
      supersedesVersionId: row.supersedes_version_id,
    },
  };
}

function dateValue(value: string | Date | null) {
  if (value === null || typeof value === "string") return value;
  return `${String(value.getFullYear()).padStart(4, "0")}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
}

function periodDays(start: string | Date | null, end: string | Date | null) {
  const startDate = dateValue(start);
  const endDate = dateValue(end);
  return startDate && endDate
    ? Math.floor((Date.parse(endDate) - Date.parse(startDate)) / 86_400_000) + 1
    : null;
}
