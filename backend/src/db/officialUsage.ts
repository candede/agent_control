import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";
import { AppError } from "../errors.js";
import { requireAdmissions } from "../services/maintenance.js";
import type { ParsedOfficialUsageReport, PublishedOfficialUsage } from "../types/officialUsage.js";
import { pool, transaction } from "./pool.js";

export type OfficialUsageScope = {
  tenantId: string;
  principalId: string;
};

export type StageOfficialUsageInput = {
  report: ParsedOfficialUsageReport;
  fileHash: string;
  bundleId: string;
  correctionOfSetId?: string;
  rejectDuplicateKind?: boolean;
  warnings?: string[];
  signal?: AbortSignal;
};

type StateRow = { active_set_id: string | null; revision: string };
type StagingRow = {
  id: string;
  revision: number;
  status: "active" | "accepted" | "replaced" | "expired" | "cancelled";
  kind: ParsedOfficialUsageReport["kind"];
  file_hash: string;
  content_hash: string;
  parser_version: string;
  schema_version: string;
  bundle_id: string;
  correction_of_set_id: string | null;
  reporting_start: string | Date | null;
  reporting_end: string | Date | null;
  period_provenance: ParsedOfficialUsageReport["reportingPeriod"]["provenance"];
  source_as_of: Date | null;
  source_as_of_provenance: ParsedOfficialUsageReport["sourceAsOfProvenance"];
  source_freshness: ParsedOfficialUsageReport["sourceFreshness"];
  downloaded_at: Date | null;
  row_count: number;
  warnings: string[];
  reconciliation: Record<string, unknown>;
  active_revision: string;
  accepted_version_id: string | null;
  accepted_set_id: string | null;
  accepted_result_revision: string | null;
  created_at: Date;
  expires_at: Date;
  accepted_at: Date | null;
};
type SetRow = {
  id: string;
  bundle_id: string;
  content_hash: string | null;
  actor_principal_id: string;
  reporting_start: string | Date | null;
  reporting_end: string | Date | null;
  period_provenance: ParsedOfficialUsageReport["reportingPeriod"]["provenance"];
  supersedes_set_id: string | null;
  complete: boolean;
  accepted_at: Date | null;
  deleted_at: Date | null;
  created_at: Date;
  expires_at: Date | null;
  kinds: ParsedOfficialUsageReport["kind"][];
};
type ConfirmationRow = {
  id: string;
  operation: "select" | "delete";
  target_set_id: string;
  expected_revision: string;
  confirmation_hash: string;
};
type BundleReceiptRow = {
  actor_principal_id: string;
  bundle_hash: string;
  expected_active_revision: string;
  result_set_id: string;
  result_version_id: string;
  result_active_revision: string;
  result_complete: boolean;
  expires_at: Date;
};
type PublishedVersionRow = {
  id: string;
  kind: ParsedOfficialUsageReport["kind"];
  content_hash: string;
  file_hash: string;
  parser_version: string;
  schema_version: string;
  reporting_start: string | Date | null;
  reporting_end: string | Date | null;
  period_provenance: ParsedOfficialUsageReport["reportingPeriod"]["provenance"];
  source_as_of: Date | null;
  source_as_of_provenance: ParsedOfficialUsageReport["sourceAsOfProvenance"];
  source_freshness: ParsedOfficialUsageReport["sourceFreshness"];
  downloaded_at: Date | null;
  row_count: number;
  warnings: string[];
  reconciliation: Record<string, unknown>;
  supersedes_version_id: string | null;
  accepted_at: Date;
  rows: ParsedOfficialUsageReport["rows"];
};

export class OfficialUsageRepository {
  constructor(private readonly database: pg.Pool = pool) {}

  async stage(scope: OfficialUsageScope, input: StageOfficialUsageInput) {
    requireAdmissions();
    throwIfCancelled(input.signal);
    validateScope(scope);
    validateHash(input.fileHash);
    validateUuid(input.bundleId, "bundle ID");
    if (input.correctionOfSetId) validateUuid(input.correctionOfSetId, "superseded set ID");
    const rowPayload = input.report.rows.map((row, ordinal) => ({ ordinal, row_data: row }));
    const storedBytes = Buffer.byteLength(JSON.stringify(rowPayload), "utf8");
    if (storedBytes > 32 * 1024 * 1024) {
      throw new AppError(413, "staging_limit_exceeded", "Validated report rows exceed the staging storage limit.");
    }
    const stagingId = randomUUID();

    await transaction(this.database, async client => {
      await lockTenant(client, scope.tenantId);
      throwIfCancelled(input.signal);
      const conflictingOwner = await client.query(`SELECT 1 FROM official_usage_sets
        WHERE tenant_id=$1 AND bundle_id=$2 AND actor_principal_id<>$3
        UNION ALL SELECT 1 FROM official_usage_staging
        WHERE tenant_id=$1 AND bundle_id=$2 AND actor_principal_id<>$3 AND status='active' AND expires_at>clock_timestamp()
        LIMIT 1`, [scope.tenantId, input.bundleId, scope.principalId]);
      if (conflictingOwner.rowCount) {
        throw new AppError(409, "bundle_owner_mismatch", "This unpublished report bundle belongs to another administrator.");
      }
      if (input.rejectDuplicateKind) {
        const duplicateKind = await client.query(`SELECT 1 FROM official_usage_staging
          WHERE tenant_id=$1 AND actor_principal_id=$2 AND bundle_id=$3 AND kind=$4
            AND status='active' AND expires_at>clock_timestamp() LIMIT 1`,
        [scope.tenantId, scope.principalId, input.bundleId, input.report.kind]);
        if (duplicateKind.rowCount) {
          throw new AppError(409, "duplicate_report_kind", `This draft already contains a ${input.report.kind} report. Discard the draft before uploading a replacement for that report kind.`);
        }
      }
      await purgeExpiredPreviews(client, scope.tenantId, 10);
      const state = await ensureState(client, scope.tenantId);
      if (input.correctionOfSetId) {
        const correction = await client.query(`SELECT 1 FROM official_usage_sets
          WHERE id=$1 AND tenant_id=$2 AND complete AND deleted_at IS NULL`, [input.correctionOfSetId, scope.tenantId]);
        if (!correction.rowCount) throw new AppError(409, "invalid_correction", "The superseded report set is unavailable.");
      }
      await client.query(`UPDATE official_usage_staging SET status='replaced'
        WHERE tenant_id=$1 AND actor_principal_id=$2 AND bundle_id=$3 AND kind=$4 AND status='active'`, [scope.tenantId, scope.principalId, input.bundleId, input.report.kind]);
      await client.query(`DELETE FROM official_usage_staged_rows row USING official_usage_staging staging
        WHERE row.staging_id=staging.id AND staging.tenant_id=$1 AND staging.actor_principal_id=$2
          AND staging.bundle_id=$3 AND staging.kind=$4 AND staging.status='replaced'`,
      [scope.tenantId, scope.principalId, input.bundleId, input.report.kind]);
      const quotas = (await client.query<{
        actor_count: number; tenant_count: number; actor_bytes: string; tenant_bytes: string;
        actor_rows: string; tenant_rows: string; bundle_bytes: string;
      }>(`SELECT
        count(*) FILTER (WHERE actor_principal_id=$2)::int AS actor_count,
        count(*)::int AS tenant_count,
        COALESCE(sum(stored_bytes) FILTER (WHERE actor_principal_id=$2),0)::text AS actor_bytes,
        COALESCE(sum(stored_bytes),0)::text AS tenant_bytes,
        COALESCE(sum(row_count) FILTER (WHERE actor_principal_id=$2),0)::text AS actor_rows,
        COALESCE(sum(row_count),0)::text AS tenant_rows,
        COALESCE(sum(stored_bytes) FILTER (WHERE actor_principal_id=$2 AND bundle_id=$3),0)::text AS bundle_bytes
        FROM official_usage_staging staging
        WHERE tenant_id=$1 AND ((status='active' AND expires_at>clock_timestamp()) OR EXISTS (
          SELECT 1 FROM official_usage_staged_rows row WHERE row.staging_id=staging.id))`,
      [scope.tenantId, scope.principalId, input.bundleId])).rows[0];
      if (quotas.actor_count >= 9 || quotas.tenant_count >= 30 ||
          Number(quotas.actor_bytes) + storedBytes > 96 * 1024 * 1024 ||
          Number(quotas.tenant_bytes) + storedBytes > 256 * 1024 * 1024 ||
          Number(quotas.actor_rows) + input.report.rows.length > 150_000 ||
          Number(quotas.tenant_rows) + input.report.rows.length > 500_000 ||
          Number(quotas.bundle_bytes) + storedBytes > 96 * 1024 * 1024) {
        throw new AppError(429, "staging_quota", "The finite official usage staging count, row, or byte quota is full.");
      }
      const overlapCount = input.report.reportingPeriod.provenance === "activity_range" ? 0
        : (await client.query<{ count: number }>(`SELECT count(*)::int AS count FROM official_usage_versions
          WHERE tenant_id=$1 AND kind=$2 AND deleted_at IS NULL
            AND reporting_start<=$4::date AND reporting_end>=$3::date`,
        [scope.tenantId, input.report.kind, input.report.reportingPeriod.startDate, input.report.reportingPeriod.endDate])).rows[0].count;
      const companions = await companionMetrics(client, scope, input.bundleId);
      const warnings = [...new Set([...(input.report.warnings ?? []), ...(input.warnings ?? []),
        ...(overlapCount ? [`${overlapCount} retained ${input.report.kind} observation(s) overlap this known reporting window; snapshots are not additive.`] : [])])].slice(0, 100);
      const reconciliation = buildReconciliation(input.report, companions);
      await client.query(`INSERT INTO official_usage_staging
        (id,tenant_id,actor_principal_id,kind,file_hash,parser_version,schema_version,bundle_id,correction_of_set_id,
         reporting_start,reporting_end,period_provenance,source_as_of,source_as_of_provenance,source_freshness,downloaded_at,
         row_count,stored_bytes,warnings,reconciliation,content_hash,active_revision)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::date,$11::date,$12,$13,$14,$15,$16,$17,$18,$19::jsonb,$20::jsonb,
          official_usage_report_content_hash($4,$7,$10::date,$11::date,$12,$13,$14,$15,$21::jsonb),$22)`,
      [stagingId, scope.tenantId, scope.principalId, input.report.kind, input.fileHash, input.report.parserVersion,
        input.report.schemaVersion, input.bundleId, input.correctionOfSetId ?? null, input.report.reportingPeriod.startDate,
        input.report.reportingPeriod.endDate, input.report.reportingPeriod.provenance, input.report.sourceAsOf ?? null,
        input.report.sourceAsOfProvenance, input.report.sourceFreshness, input.report.downloadedAt ?? null,
        input.report.rows.length, storedBytes, JSON.stringify(warnings), JSON.stringify(reconciliation),
        JSON.stringify(input.report.rows), state.revision]);
      if (rowPayload.length) {
        await client.query(`INSERT INTO official_usage_staged_rows(staging_id,tenant_id,actor_principal_id,ordinal,row_data)
          SELECT $1,$2,$3,row.ordinal,row.row_data FROM jsonb_to_recordset($4::jsonb) AS row(ordinal integer,row_data jsonb)`,
        [stagingId, scope.tenantId, scope.principalId, JSON.stringify(rowPayload)]);
      }
      await insertAudit(client, scope, "staged", input.report.kind, stagingId, input.report.rows.length);
      throwIfCancelled(input.signal);
    }, input.signal);

    return (await this.getStaging(scope, stagingId))!;
  }

  async getStaging(scope: OfficialUsageScope, id: string) {
    validateScope(scope);
    const result = await this.database.query<StagingRow>(`SELECT * FROM official_usage_staging
      WHERE id=$1 AND tenant_id=$2 AND actor_principal_id=$3`, [id, scope.tenantId, scope.principalId]);
    return result.rows[0] ? projectStaging(result.rows[0]) : undefined;
  }

  async accept(scope: OfficialUsageScope, id: string, input: {
    stagingRevision: number;
    fileHash: string;
    expectedActiveRevision: number;
  }) {
    requireAdmissions();
    validateScope(scope);
    validateHash(input.fileHash);
    if (!Number.isSafeInteger(input.stagingRevision) || input.stagingRevision < 1 ||
        !Number.isSafeInteger(input.expectedActiveRevision) || input.expectedActiveRevision < 1) {
      throw new AppError(400, "invalid_revision", "Staging and active revisions must be positive integers.");
    }
    return transaction(this.database, async client => {
      await lockTenant(client, scope.tenantId);
      const state = await ensureState(client, scope.tenantId);
      return this.acceptLocked(client, scope, id, input, state);
    });
  }

  private async acceptLocked(client: pg.PoolClient, scope: OfficialUsageScope, id: string, input: {
    stagingRevision: number;
    fileHash: string;
    expectedActiveRevision: number;
  }, state: StateRow) {
      const stageResult = await client.query<StagingRow>(`SELECT * FROM official_usage_staging
        WHERE id=$1 AND tenant_id=$2 AND actor_principal_id=$3 FOR UPDATE`, [id, scope.tenantId, scope.principalId]);
      const stage = stageResult.rows[0];
      if (!stage) throw new AppError(404, "staging_not_found", "The official usage preview was not found for this administrator.");
      if (stage.revision !== input.stagingRevision || stage.file_hash !== input.fileHash) {
        throw new AppError(409, "staging_fence_mismatch", "The official usage preview hash or revision changed.");
      }
      if (Number(stage.active_revision) !== input.expectedActiveRevision) {
        throw new AppError(409, "active_revision_mismatch", "The acceptance intent does not match this preview's active selection revision.");
      }
      if (stage.status === "accepted") {
        const retained = await client.query(`SELECT 1 FROM official_usage_sets
          WHERE id=$1 AND tenant_id=$2 AND complete AND deleted_at IS NULL`,
        [stage.accepted_set_id, scope.tenantId]);
        return {
          setId: stage.accepted_set_id!,
          versionId: stage.accepted_version_id!,
          activeRevision: Number(stage.accepted_result_revision),
          complete: Boolean(retained.rowCount),
        };
      }
      if (stage.status !== "active" || stage.expires_at.getTime() <= Date.now()) {
        throw new AppError(409, "staging_unavailable", "The official usage preview expired or was replaced.");
      }
      if (Number(state.revision) !== input.expectedActiveRevision) {
        throw new AppError(409, "active_revision_mismatch", "The active official usage selection changed; create a new preview.");
      }
      if (stage.correction_of_set_id) {
        await validateCorrectionTarget(client, scope, stage.correction_of_set_id, stage.period_provenance,
          dateValue(stage.reporting_start), dateValue(stage.reporting_end));
      }

      const duplicateTargetSetId = stage.correction_of_set_id ?? state.active_set_id;
      if (duplicateTargetSetId) {
        const duplicates = await client.query<StagingRow & { version_id: string }>(`SELECT staging.*,membership.version_id
          FROM official_usage_staging staging
          JOIN official_usage_sets report_set ON report_set.id=$4 AND report_set.tenant_id=staging.tenant_id
            AND report_set.complete AND report_set.deleted_at IS NULL
          JOIN official_usage_set_versions membership ON membership.set_id=report_set.id
            AND membership.tenant_id=staging.tenant_id AND membership.kind=staging.kind
          JOIN official_usage_versions version ON version.id=membership.version_id
            AND version.tenant_id=membership.tenant_id AND version.kind=membership.kind AND version.deleted_at IS NULL
          WHERE staging.tenant_id=$1 AND staging.actor_principal_id=$2 AND staging.bundle_id=$3
            AND staging.status='active' AND staging.expires_at>clock_timestamp()
            AND staging.correction_of_set_id IS NOT DISTINCT FROM $5::uuid
            AND version.content_hash=staging.content_hash`,
        [scope.tenantId, scope.principalId, stage.bundle_id, duplicateTargetSetId, stage.correction_of_set_id]);
        if (duplicates.rows.length === 3 && new Set(duplicates.rows.map(row => row.kind)).size === 3) {
          for (const duplicate of duplicates.rows) {
            await markAccepted(client, scope, duplicate, duplicate.version_id, duplicateTargetSetId, Number(state.revision));
            await insertAudit(client, scope, "accepted", duplicate.kind, duplicate.version_id, duplicate.row_count);
          }
          const versionId = duplicates.rows.find(row => row.id === stage.id)!.version_id;
          return { setId: duplicateTargetSetId, versionId, activeRevision: Number(state.revision), complete: true };
        }
      }

      let reportSet = (await client.query<SetRow>(`SELECT report_set.*,'{}'::text[] AS kinds FROM official_usage_sets report_set
        WHERE tenant_id=$1 AND bundle_id=$2 FOR UPDATE`, [scope.tenantId, stage.bundle_id])).rows[0];
      if (!reportSet) {
        await enforceHistoryQuota(client, scope.tenantId, { sets: 1 });
        const setId = randomUUID();
        reportSet = (await client.query<SetRow>(`INSERT INTO official_usage_sets
          (id,tenant_id,bundle_id,actor_principal_id,reporting_start,reporting_end,period_provenance,supersedes_set_id)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *,'{}'::text[] AS kinds`,
        [setId, scope.tenantId, stage.bundle_id, scope.principalId, stage.reporting_start, stage.reporting_end,
          stage.period_provenance, stage.correction_of_set_id])).rows[0];
      }
      if (reportSet.actor_principal_id !== scope.principalId) {
        throw new AppError(409, "bundle_owner_mismatch", "This unpublished report bundle belongs to another administrator.");
      }
      if (reportSet.deleted_at || reportSet.period_provenance !== stage.period_provenance ||
          reportSet.supersedes_set_id !== stage.correction_of_set_id) {
        throw new AppError(409, "incompatible_bundle", "This preview is incompatible with the retained report bundle.");
      }
      const companions = await client.query<Pick<StagingRow,
        "reporting_start" | "reporting_end" | "period_provenance" | "source_as_of" | "source_as_of_provenance">>(
        `SELECT version.reporting_start,version.reporting_end,version.period_provenance,
          version.source_as_of,version.source_as_of_provenance
        FROM official_usage_set_versions membership JOIN official_usage_versions version ON version.id=membership.version_id
        WHERE membership.set_id=$1 AND membership.tenant_id=$2`, [reportSet.id, scope.tenantId]);
      if (companions.rows.some(companion => !compatibleReportBasis(companion, stage))) {
        throw new AppError(409, "incompatible_bundle", "The report period or source snapshot basis is incompatible with this retained bundle.");
      }
      if (stage.period_provenance === "activity_range") {
        const coverage = unionCoverage(reportSet, stage);
        if (dateValue(reportSet.reporting_start) !== coverage.startDate || dateValue(reportSet.reporting_end) !== coverage.endDate) {
          reportSet = (await client.query<SetRow>(`UPDATE official_usage_sets
            SET reporting_start=$3::date,reporting_end=$4::date WHERE id=$1 AND tenant_id=$2
            RETURNING *,'{}'::text[] AS kinds`,
          [reportSet.id, scope.tenantId, coverage.startDate, coverage.endDate])).rows[0];
        }
      } else if (dateValue(reportSet.reporting_start) !== dateValue(stage.reporting_start) ||
          dateValue(reportSet.reporting_end) !== dateValue(stage.reporting_end)) {
        throw new AppError(409, "incompatible_bundle", "This preview is incompatible with the retained report bundle.");
      }
      const existing = await client.query<{
        version_id: string; content_hash: string;
      }>(`SELECT membership.version_id,version.content_hash
        FROM official_usage_set_versions membership JOIN official_usage_versions version ON version.id=membership.version_id
        WHERE membership.set_id=$1 AND membership.tenant_id=$2 AND membership.kind=$3`, [reportSet.id, scope.tenantId, stage.kind]);
      if (existing.rows[0]) {
        if (!sameImmutableVersionIntent(existing.rows[0], stage)) {
          throw new AppError(409, "bundle_kind_conflict", "This report bundle already has a different immutable version for that kind.");
        }
        await markAccepted(client, scope, stage, existing.rows[0].version_id, reportSet.id, Number(state.revision));
        return { setId: reportSet.id, versionId: existing.rows[0].version_id, activeRevision: Number(state.revision), complete: reportSet.complete };
      }

      const reusable = (await client.query<{ id: string }>(`SELECT id FROM official_usage_versions
        WHERE tenant_id=$1 AND kind=$2 AND content_hash=$3 AND deleted_at IS NULL
        ORDER BY accepted_at,id LIMIT 1`, [scope.tenantId, stage.kind, stage.content_hash])).rows[0];
      let versionId = reusable?.id;
      if (!versionId) {
        await enforceHistoryQuota(client, scope.tenantId, { versions: 1, rows: stage.row_count });
        const artifactId = randomUUID();
        const artifact = await client.query<{ id: string }>(`INSERT INTO official_usage_artifacts
          (id,tenant_id,kind,file_hash,parser_version,schema_version) VALUES($1,$2,$3,$4,$5,$6)
          ON CONFLICT(tenant_id,kind,file_hash) DO UPDATE SET expires_at=official_usage_artifacts.expires_at RETURNING id`,
        [artifactId, scope.tenantId, stage.kind, stage.file_hash, stage.parser_version, stage.schema_version]);
        const superseded = stage.correction_of_set_id ? await client.query<{ version_id: string }>(`SELECT version_id FROM official_usage_set_versions
          WHERE set_id=$1 AND tenant_id=$2 AND kind=$3`, [stage.correction_of_set_id, scope.tenantId, stage.kind]) : undefined;
        versionId = randomUUID();
        await client.query(`INSERT INTO official_usage_versions
          (id,tenant_id,artifact_id,staging_id,kind,content_hash,reporting_start,reporting_end,period_provenance,source_as_of,
           source_as_of_provenance,source_freshness,downloaded_at,row_count,warnings,reconciliation,accepted_by,supersedes_version_id)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16::jsonb,$17,$18)`,
        [versionId, scope.tenantId, artifact.rows[0].id, stage.id, stage.kind, stage.content_hash,
          stage.reporting_start, stage.reporting_end, stage.period_provenance, stage.source_as_of,
          stage.source_as_of_provenance, stage.source_freshness, stage.downloaded_at, stage.row_count,
          JSON.stringify(stage.warnings), JSON.stringify(stage.reconciliation), scope.principalId,
          superseded?.rows[0]?.version_id ?? null]);
        await client.query(`INSERT INTO official_usage_row_facts(tenant_id,kind,payload_hash,row_data,first_observed_at)
          SELECT tenant_id,$3,official_usage_payload_hash(row_data),row_data,clock_timestamp()
          FROM official_usage_staged_rows
          WHERE staging_id=$1 AND tenant_id=$2 AND actor_principal_id=$4
          GROUP BY tenant_id,row_data
          ON CONFLICT(tenant_id,kind,payload_hash) DO NOTHING`,
        [stage.id, scope.tenantId, stage.kind, scope.principalId]);
        const factCount = Number((await client.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM official_usage_row_facts WHERE tenant_id=$1", [scope.tenantId])).rows[0].count);
        if (factCount > 2_000_000) {
          throw new AppError(429, "official_usage_history_quota", "The finite official usage history payload quota is full.");
        }
        const associated = await client.query(`INSERT INTO official_usage_version_rows(version_id,tenant_id,kind,ordinal,payload_hash)
          SELECT $1,$2,$3,row.ordinal,official_usage_payload_hash(row.row_data)
          FROM official_usage_staged_rows row
          JOIN official_usage_row_facts fact ON fact.tenant_id=row.tenant_id AND fact.kind=$3
            AND fact.payload_hash=official_usage_payload_hash(row.row_data) AND fact.row_data=row.row_data
          WHERE row.staging_id=$4 AND row.tenant_id=$2 AND row.actor_principal_id=$5
          ORDER BY row.ordinal`,
        [versionId, scope.tenantId, stage.kind, stage.id, scope.principalId]);
        if (associated.rowCount !== stage.row_count) {
          throw new AppError(500, "official_usage_payload_integrity", "The official usage row payload association could not be verified.");
        }
      }
      await client.query(`INSERT INTO official_usage_set_versions(set_id,tenant_id,kind,version_id) VALUES($1,$2,$3,$4)`,
      [reportSet.id, scope.tenantId, stage.kind, versionId]);
      const membershipCount = (await client.query<{ count: number }>("SELECT count(*)::int AS count FROM official_usage_set_versions WHERE set_id=$1 AND tenant_id=$2", [reportSet.id, scope.tenantId])).rows[0].count;
      let activeRevision = Number(state.revision);
      if (membershipCount === 3) {
        const completed = await client.query<{ content_hash: string }>(`UPDATE official_usage_sets report_set
          SET complete=true,accepted_at=clock_timestamp(),content_hash=(
            SELECT official_usage_bundle_content_hash(jsonb_agg(
              jsonb_build_object('kind',membership.kind,'contentHash',version.content_hash)
              ORDER BY membership.kind))
            FROM official_usage_set_versions membership
            JOIN official_usage_versions version ON version.id=membership.version_id
            WHERE membership.set_id=report_set.id AND membership.tenant_id=report_set.tenant_id)
          WHERE report_set.id=$1 AND report_set.tenant_id=$2 RETURNING content_hash`,
        [reportSet.id, scope.tenantId]);
        if (!completed.rows[0]?.content_hash) {
          throw new AppError(500, "official_usage_content_identity", "The official usage bundle content identity could not be verified.");
        }
        const activate = !reportSet.supersedes_set_id || !state.active_set_id ||
          reportSet.supersedes_set_id === state.active_set_id;
        if (activate) {
          const updated = await client.query<{ revision: string }>(`UPDATE official_usage_state
            SET active_set_id=$2,revision=revision+1,updated_at=clock_timestamp()
            WHERE tenant_id=$1 RETURNING revision`, [scope.tenantId, reportSet.id]);
          activeRevision = Number(updated.rows[0].revision);
        }
      }
      await markAccepted(client, scope, stage, versionId, reportSet.id, activeRevision);
      await insertAudit(client, scope, "accepted", stage.kind, versionId, stage.row_count);
      return { setId: reportSet.id, versionId, activeRevision, complete: membershipCount === 3 };
  }

  async previewBundle(scope: OfficialUsageScope, bundleId: string) {
    validateScope(scope);
    validateUuid(bundleId, "bundle ID");
    return transaction(this.database, async client => {
      await lockTenant(client, scope.tenantId);
      const state = await ensureState(client, scope.tenantId);
      return bundlePreview(client, scope, bundleId, Number(state.revision));
    });
  }

  async acceptBundle(scope: OfficialUsageScope, bundleId: string, input: {
    bundleHash: string;
    expectedActiveRevision: number;
  }) {
    requireAdmissions();
    validateScope(scope);
    validateUuid(bundleId, "bundle ID");
    validateHash(input.bundleHash);
    if (!Number.isSafeInteger(input.expectedActiveRevision) || input.expectedActiveRevision < 1) {
      throw new AppError(400, "invalid_revision", "The active revision must be a positive integer.");
    }
    return transaction(this.database, async client => {
      await lockTenant(client, scope.tenantId);
      const state = await ensureState(client, scope.tenantId);
      const receipt = (await client.query<BundleReceiptRow>(`SELECT actor_principal_id,bundle_hash,expected_active_revision,
          result_set_id,result_version_id,result_active_revision,result_complete,expires_at
        FROM official_usage_bundle_receipts WHERE tenant_id=$1 AND bundle_id=$2`,
      [scope.tenantId, bundleId])).rows[0];
      if (receipt) {
        if (receipt.actor_principal_id !== scope.principalId) {
          throw new AppError(409, "bundle_owner_mismatch", "This reviewed report bundle belongs to another administrator.");
        }
        if (receipt.bundle_hash !== input.bundleHash || Number(receipt.expected_active_revision) !== input.expectedActiveRevision) {
          throw new AppError(409, "bundle_fence_mismatch", "The bundle acceptance intent does not match the original reviewed publication.");
        }
        if (receipt.expires_at.getTime() <= Date.now()) {
          throw new AppError(409, "bundle_unavailable", "The reviewed report bundle receipt expired and cannot be republished.");
        }
        const retained = await client.query<{ deleted_at: Date | null; bundle_id: string }>(`SELECT deleted_at,bundle_id FROM official_usage_sets
          WHERE id=$1 AND tenant_id=$2`, [receipt.result_set_id, scope.tenantId]);
        if (retained.rows[0]?.deleted_at) {
          throw new AppError(409, "deleted_report_duplicate", "This exact report bundle was explicitly deleted and cannot be silently restored.");
        }
        if (!retained.rows[0]) {
          throw new AppError(409, "bundle_unavailable", "The retained report bundle no longer exists.");
        }
        return {
          setId: receipt.result_set_id,
          versionId: receipt.result_version_id,
          activeRevision: Number(receipt.result_active_revision),
          complete: receipt.result_complete,
          reusedExistingSet: retained.rows[0].bundle_id !== bundleId,
        };
      }
      const preview = await bundlePreview(client, scope, bundleId, Number(state.revision));
      if (preview.bundleHash !== input.bundleHash || preview.expectedActiveRevision !== input.expectedActiveRevision) {
        throw new AppError(409, "bundle_fence_mismatch", "The staged report bundle changed; review the current bundle before accepting it.");
      }
      if (preview.missingKinds.length) {
        throw new AppError(409, "incomplete_bundle", "All three compatible report kinds must be reviewed before atomic publication.");
      }
      await validateBundleHistoryIntent(client, scope, preview);
      let result: { setId: string; versionId: string; activeRevision: number; complete: boolean } | undefined;
      if (preview.contentHash && preview.staging.length === requiredKinds.length && preview.acceptedVersions.length === 0) {
        const correctionOfSetId = preview.staging[0].correctionOfSetId;
        const duplicate = (await client.query<SetRow>(`SELECT report_set.*,'{}'::text[] AS kinds
          FROM official_usage_sets report_set
          WHERE report_set.tenant_id=$1 AND report_set.content_hash=$2 AND report_set.complete
          ORDER BY report_set.deleted_at NULLS FIRST,
            CASE WHEN report_set.id=$3::uuid THEN 0 WHEN report_set.supersedes_set_id=$3::uuid THEN 1 ELSE 2 END,
            report_set.accepted_at,report_set.id
          LIMIT 1 FOR UPDATE`, [scope.tenantId, preview.contentHash, correctionOfSetId])).rows[0];
        if (duplicate?.deleted_at) {
          throw new AppError(409, "deleted_report_duplicate", "This exact report bundle was explicitly deleted and cannot be silently restored.");
        }
        if (duplicate && (!correctionOfSetId || duplicate.id === correctionOfSetId || duplicate.supersedes_set_id === correctionOfSetId)) {
          const versions = await client.query<{ kind: ParsedOfficialUsageReport["kind"]; version_id: string }>(
            `SELECT kind,version_id FROM official_usage_set_versions
             WHERE set_id=$1 AND tenant_id=$2 ORDER BY kind`, [duplicate.id, scope.tenantId]);
          const versionByKind = new Map(versions.rows.map(version => [version.kind, version.version_id]));
          const stages = await client.query<StagingRow>(`SELECT * FROM official_usage_staging
            WHERE tenant_id=$1 AND actor_principal_id=$2 AND bundle_id=$3 AND status='active'
            ORDER BY kind FOR UPDATE`, [scope.tenantId, scope.principalId, bundleId]);
          if (stages.rows.length !== requiredKinds.length || versions.rows.length !== requiredKinds.length) {
            throw new AppError(409, "bundle_unavailable", "The exact retained bundle is incomplete and cannot satisfy this import.");
          }
          for (const stage of stages.rows) {
            const versionId = versionByKind.get(stage.kind);
            if (!versionId) throw new AppError(409, "bundle_unavailable", "The exact retained bundle is missing a report observation.");
            await markAccepted(client, scope, stage, versionId, duplicate.id, Number(state.revision));
            await insertAudit(client, scope, "accepted", stage.kind, versionId, stage.row_count);
          }
          result = {
            setId: duplicate.id,
            versionId: versionByKind.get(preview.staging[0].kind)!,
            activeRevision: Number(state.revision),
            complete: true,
          };
        }
      }
      if (!result) {
        for (const stage of preview.staging) {
          result = await this.acceptLocked(client, scope, stage.id, {
            stagingRevision: stage.revision,
            fileHash: stage.fileHash,
            expectedActiveRevision: preview.expectedActiveRevision,
          }, state);
        }
      }
      if (!result) {
        const reportSet = await client.query<{ id: string }>(`SELECT id FROM official_usage_sets
          WHERE tenant_id=$1 AND bundle_id=$2 AND actor_principal_id=$3 AND complete
            AND deleted_at IS NULL`, [scope.tenantId, bundleId, scope.principalId]);
        if (!reportSet.rows[0]) throw new AppError(409, "bundle_unavailable", "The reviewed report bundle is no longer available.");
        result = { setId: reportSet.rows[0].id, versionId: preview.acceptedVersions[0]!.versionId, activeRevision: Number(state.revision), complete: true };
      }
      await client.query(`INSERT INTO official_usage_bundle_receipts
        (tenant_id,actor_principal_id,bundle_id,bundle_hash,expected_active_revision,result_set_id,
         result_version_id,result_active_revision,result_complete)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [scope.tenantId, scope.principalId, bundleId, input.bundleHash, input.expectedActiveRevision,
        result.setId, result.versionId, result.activeRevision, result.complete]);
      const retained = await client.query<{ bundle_id: string }>(`SELECT bundle_id FROM official_usage_sets
        WHERE id=$1 AND tenant_id=$2`, [result.setId, scope.tenantId]);
      return { ...result, reusedExistingSet: retained.rows[0].bundle_id !== bundleId };
    });
  }

  async getAdminState(scope: OfficialUsageScope) {
    validateScope(scope);
    const [state, stages, sets] = await Promise.all([
      this.database.query<StateRow>(`SELECT active_set_id,revision FROM official_usage_state WHERE tenant_id=$1`, [scope.tenantId]),
      this.database.query<StagingRow>(`SELECT * FROM official_usage_staging WHERE tenant_id=$1 AND actor_principal_id=$2
        AND created_at>clock_timestamp()-interval '1 day' ORDER BY created_at DESC,id DESC LIMIT 50`, [scope.tenantId, scope.principalId]),
      this.database.query<SetRow>(`SELECT report_set.*,coalesce(array_agg(membership.kind ORDER BY membership.kind) FILTER (WHERE membership.kind IS NOT NULL),'{}') AS kinds
        FROM official_usage_sets report_set LEFT JOIN official_usage_set_versions membership ON membership.set_id=report_set.id AND membership.tenant_id=report_set.tenant_id
        WHERE report_set.tenant_id=$1 GROUP BY report_set.id ORDER BY report_set.created_at DESC,report_set.id DESC LIMIT 100`, [scope.tenantId]),
    ]);
    return {
      activeSetId: state.rows[0]?.active_set_id ?? null,
      activeRevision: Number(state.rows[0]?.revision ?? 1),
      staging: stages.rows.map(projectStaging),
      sets: sets.rows.map(projectSet),
    };
  }

  async getPublished(tenantId: string, setId?: string): Promise<PublishedOfficialUsage> {
    validateTenant(tenantId);
    if (setId) validateUuid(setId, "report set ID");
    return transaction(this.database, async client => {
      await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      return this.getPublishedInTransaction(tenantId, client, setId);
    });
  }

  async getPublishedInTransaction(tenantId: string, client: pg.PoolClient, setId?: string,
    options: { respectExpiry?: boolean } = {}): Promise<PublishedOfficialUsage> {
    validateTenant(tenantId);
    if (setId) validateUuid(setId, "report set ID");
    const state = await client.query<StateRow>("SELECT active_set_id,revision FROM official_usage_state WHERE tenant_id=$1", [tenantId]);
    const retained = await client.query<{ complete: boolean; count: number }>(`SELECT complete,count(*)::int AS count FROM official_usage_sets
      WHERE tenant_id=$1 AND deleted_at IS NULL
        AND (NOT $2::boolean OR expires_at IS NULL OR expires_at>clock_timestamp()) GROUP BY complete`,
    [tenantId, options.respectExpiry ?? false]);
    const history = await client.query(`SELECT 1 FROM official_usage_sets WHERE tenant_id=$1
      UNION ALL SELECT 1 FROM official_usage_audit
      WHERE tenant_id=$1 AND action='accepted' AND outcome='succeeded' LIMIT 1`, [tenantId]);
    const retainedCounts = Object.fromEntries(retained.rows.map(row => [String(row.complete), row.count]));
    const selectedSetId = setId ?? state.rows[0]?.active_set_id ?? null;
    if (!selectedSetId) {
      return { activeRevision: Number(state.rows[0]?.revision ?? 1), activeSet: null, reports: {}, retainedCompleteSets: retainedCounts.true ?? 0, retainedIncompleteSets: retainedCounts.false ?? 0, hasImportHistory: Boolean(history.rowCount), activeSelectionIncomplete: false };
    }
    const reportSet = (await client.query<SetRow>(`SELECT report_set.*,coalesce(array_agg(membership.kind ORDER BY membership.kind),'{}') AS kinds
      FROM official_usage_sets report_set JOIN official_usage_set_versions membership ON membership.set_id=report_set.id AND membership.tenant_id=report_set.tenant_id
      WHERE report_set.id=$1 AND report_set.tenant_id=$2 AND report_set.complete AND report_set.deleted_at IS NULL
        AND (NOT $3::boolean OR report_set.expires_at IS NULL OR report_set.expires_at>clock_timestamp())
        AND (SELECT count(*) FROM official_usage_set_versions candidate
          WHERE candidate.set_id=report_set.id AND candidate.tenant_id=report_set.tenant_id)=3
        AND NOT EXISTS (SELECT 1 FROM official_usage_set_versions candidate
          JOIN official_usage_versions candidate_version ON candidate_version.id=candidate.version_id
            AND candidate_version.tenant_id=candidate.tenant_id AND candidate_version.kind=candidate.kind
          WHERE candidate.set_id=report_set.id AND candidate.tenant_id=report_set.tenant_id
            AND (candidate_version.deleted_at IS NOT NULL OR ($3::boolean AND candidate_version.expires_at<=clock_timestamp()) OR candidate_version.row_count<>(
              SELECT count(*) FROM official_usage_version_rows candidate_row
              WHERE candidate_row.version_id=candidate_version.id
                AND candidate_row.tenant_id=candidate_version.tenant_id
                AND candidate_row.kind=candidate_version.kind)))
      GROUP BY report_set.id`, [selectedSetId, tenantId, options.respectExpiry ?? false])).rows[0];
    if (!reportSet) {
      if (setId) throw new AppError(404, "official_usage_set_not_found", "The retained official usage report set was not found.");
      return { activeRevision: Number(state.rows[0]?.revision ?? 1), activeSet: null, reports: {}, retainedCompleteSets: retainedCounts.true ?? 0, retainedIncompleteSets: retainedCounts.false ?? 0, hasImportHistory: Boolean(history.rowCount), activeSelectionIncomplete: true };
    }
    const versions = await client.query<PublishedVersionRow>(`SELECT version.id,version.kind,version.content_hash,
      artifact.file_hash,artifact.parser_version,artifact.schema_version,
      version.reporting_start,version.reporting_end,version.period_provenance,version.source_as_of,version.source_as_of_provenance,
      version.source_freshness,version.downloaded_at,version.row_count,version.warnings,version.reconciliation,
      version.supersedes_version_id,version.accepted_at,
      coalesce(jsonb_agg(fact.row_data ORDER BY row.ordinal) FILTER (WHERE row.version_id IS NOT NULL),'[]'::jsonb) AS rows
      FROM official_usage_set_versions membership
      JOIN official_usage_versions version ON version.id=membership.version_id AND version.tenant_id=membership.tenant_id AND version.kind=membership.kind
      JOIN official_usage_artifacts artifact ON artifact.id=version.artifact_id AND artifact.tenant_id=version.tenant_id AND artifact.kind=version.kind
      LEFT JOIN official_usage_version_rows row ON row.version_id=version.id AND row.tenant_id=version.tenant_id AND row.kind=version.kind
      LEFT JOIN official_usage_row_facts fact ON fact.tenant_id=row.tenant_id AND fact.kind=row.kind AND fact.payload_hash=row.payload_hash
      WHERE membership.set_id=$1 AND membership.tenant_id=$2 AND version.deleted_at IS NULL
        AND (NOT $3::boolean OR version.expires_at IS NULL OR version.expires_at>clock_timestamp())
        AND (NOT $3::boolean OR artifact.expires_at IS NULL OR artifact.expires_at>clock_timestamp())
        AND artifact.id IS NOT NULL
      GROUP BY version.id,artifact.file_hash,artifact.parser_version,artifact.schema_version
      HAVING count(row.ordinal)=version.row_count
      ORDER BY version.kind`, [selectedSetId, tenantId, options.respectExpiry ?? false]);
    if (versions.rows.length !== 3 || new Set(versions.rows.map(version => version.kind)).size !== 3) {
      return { activeRevision: Number(state.rows[0]?.revision ?? 1), activeSet: null, reports: {}, retainedCompleteSets: retainedCounts.true ?? 0, retainedIncompleteSets: retainedCounts.false ?? 0, hasImportHistory: Boolean(history.rowCount), activeSelectionIncomplete: true };
    }
    const reports = Object.fromEntries(versions.rows.map(version => [version.kind, {
      kind: version.kind,
      parserVersion: version.parser_version,
      schemaVersion: version.schema_version,
      reportingPeriod: {
        startDate: dateValue(version.reporting_start),
        endDate: dateValue(version.reporting_end),
        days: periodDays(version.reporting_start, version.reporting_end),
        provenance: version.period_provenance,
      },
      sourceAsOf: version.source_as_of?.toISOString(),
      sourceAsOfProvenance: version.source_as_of_provenance,
      sourceFreshness: version.source_freshness,
      downloadedAt: version.downloaded_at?.toISOString(),
      warnings: version.warnings,
      rows: version.rows,
      lineage: {
        kind: version.kind,
        versionId: version.id,
        contentHash: version.content_hash,
        fileHash: version.file_hash,
        parserVersion: version.parser_version,
        schemaVersion: version.schema_version,
        reportingPeriod: {
          startDate: dateValue(version.reporting_start),
          endDate: dateValue(version.reporting_end),
          days: periodDays(version.reporting_start, version.reporting_end),
          provenance: version.period_provenance,
        },
        sourceAsOf: version.source_as_of?.toISOString(),
        sourceAsOfProvenance: version.source_as_of_provenance,
        sourceFreshness: version.source_freshness,
        downloadedAt: version.downloaded_at?.toISOString(),
        acceptedAt: version.accepted_at.toISOString(),
        rowCount: version.row_count,
        warnings: version.warnings,
        reconciliation: version.reconciliation,
        supersedesVersionId: version.supersedes_version_id,
      },
    }])) as PublishedOfficialUsage["reports"];
    return {
      activeRevision: Number(state.rows[0]?.revision ?? 1),
      activeSet: projectSet(reportSet),
      reports,
      retainedCompleteSets: retainedCounts.true ?? 0,
      retainedIncompleteSets: retainedCounts.false ?? 0,
      hasImportHistory: Boolean(history.rowCount),
      activeSelectionIncomplete: false,
    };
  }

  async previewSetOperation(scope: OfficialUsageScope, operation: "select" | "delete", setId: string) {
    validateScope(scope);
    validateUuid(setId, "report set ID");
    return transaction(this.database, async client => {
      await lockTenant(client, scope.tenantId);
      const state = await ensureState(client, scope.tenantId);
      await client.query(`DELETE FROM official_usage_confirmations WHERE id IN (
        SELECT id FROM official_usage_confirmations WHERE tenant_id=$1 AND actor_principal_id=$2
          AND (expires_at<=clock_timestamp() OR consumed_at IS NOT NULL)
        ORDER BY created_at LIMIT 100)`, [scope.tenantId, scope.principalId]);
      const confirmationCount = await client.query<{ count: number }>(`SELECT count(*)::int AS count FROM official_usage_confirmations
        WHERE tenant_id=$1 AND actor_principal_id=$2 AND consumed_at IS NULL AND expires_at>clock_timestamp()`,
      [scope.tenantId, scope.principalId]);
      if (confirmationCount.rows[0].count >= 20) {
        throw new AppError(429, "confirmation_quota", "The finite official usage confirmation quota is full.");
      }
      const reportSet = (await client.query<SetRow>(`SELECT report_set.*,'{}'::text[] AS kinds FROM official_usage_sets report_set
        WHERE id=$1 AND tenant_id=$2 AND deleted_at IS NULL`, [setId, scope.tenantId])).rows[0];
      if (!reportSet || operation === "select" && !reportSet.complete) {
        throw new AppError(409, "set_unavailable", operation === "select" ? "Only a retained complete report set can be selected." : "The retained report set cannot be deleted.");
      }
      const confirmationId = randomUUID();
      const expectedRevision = Number(state.revision);
      const confirmationHash = hash({ tenantId: scope.tenantId, principalId: scope.principalId, operation, setId, expectedRevision });
      const created = await client.query<{ expires_at: Date }>(`INSERT INTO official_usage_confirmations
        (id,tenant_id,actor_principal_id,operation,target_set_id,expected_revision,confirmation_hash)
        VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING expires_at`,
      [confirmationId, scope.tenantId, scope.principalId, operation, setId, expectedRevision, confirmationHash]);
      return { id: confirmationId, operation, setId, expectedRevision, confirmationHash, activeSetId: state.active_set_id, expiresAt: created.rows[0].expires_at.toISOString() };
    });
  }

  async confirmSetOperation(scope: OfficialUsageScope, confirmationId: string, input: {
    operation: "select" | "delete";
    setId: string;
    expectedRevision: number;
    confirmationHash: string;
  }) {
    requireAdmissions();
    validateScope(scope);
    validateUuid(confirmationId, "confirmation ID");
    validateUuid(input.setId, "report set ID");
    validateHash(input.confirmationHash);
    return transaction(this.database, async client => {
      await lockTenant(client, scope.tenantId);
      const state = await ensureState(client, scope.tenantId);
      const confirmation = (await client.query<ConfirmationRow>(`SELECT id,operation,target_set_id,expected_revision,confirmation_hash
        FROM official_usage_confirmations WHERE id=$1 AND tenant_id=$2 AND actor_principal_id=$3 AND consumed_at IS NULL
          AND expires_at>clock_timestamp() FOR UPDATE`, [confirmationId, scope.tenantId, scope.principalId])).rows[0];
      if (!confirmation || confirmation.operation !== input.operation || confirmation.target_set_id !== input.setId ||
          Number(confirmation.expected_revision) !== input.expectedRevision || confirmation.confirmation_hash !== input.confirmationHash) {
        throw new AppError(409, "confirmation_mismatch", "The official usage confirmation is expired or does not match the preview.");
      }
      if (Number(state.revision) !== input.expectedRevision) {
        throw new AppError(409, "active_revision_mismatch", "The active official usage selection changed; create a new preview.");
      }
      const reportSet = (await client.query<SetRow>(`SELECT report_set.*,'{}'::text[] AS kinds FROM official_usage_sets report_set
        WHERE id=$1 AND tenant_id=$2 AND deleted_at IS NULL FOR UPDATE`, [input.setId, scope.tenantId])).rows[0];
      if (!reportSet || input.operation === "select" && !reportSet.complete) {
        throw new AppError(409, "set_unavailable", "The retained report set is incomplete, deleted, or expired.");
      }
      if (input.operation === "select") {
        await client.query("UPDATE official_usage_state SET active_set_id=$2,revision=revision+1,updated_at=clock_timestamp() WHERE tenant_id=$1", [scope.tenantId, input.setId]);
        await insertAudit(client, scope, "selected", null, input.setId, null);
      } else {
        await client.query("UPDATE official_usage_state SET active_set_id=NULL,revision=revision+1,updated_at=clock_timestamp() WHERE tenant_id=$1 AND active_set_id=$2", [scope.tenantId, input.setId]);
        if (state.active_set_id !== input.setId) {
          await client.query("UPDATE official_usage_state SET revision=revision+1,updated_at=clock_timestamp() WHERE tenant_id=$1", [scope.tenantId]);
        }
        await client.query("UPDATE official_usage_sets SET deleted_at=clock_timestamp() WHERE id=$1 AND tenant_id=$2", [input.setId, scope.tenantId]);
        await client.query(`UPDATE official_usage_versions version SET deleted_at=clock_timestamp()
          FROM official_usage_set_versions membership
          WHERE membership.set_id=$1 AND membership.tenant_id=$2 AND version.id=membership.version_id
            AND NOT EXISTS (SELECT 1 FROM official_usage_set_versions live_membership
              JOIN official_usage_sets live_set ON live_set.id=live_membership.set_id
                AND live_set.tenant_id=live_membership.tenant_id
              WHERE live_membership.version_id=version.id AND live_set.deleted_at IS NULL)`,
        [input.setId, scope.tenantId]);
        await client.query(`DELETE FROM official_usage_version_rows row USING official_usage_versions version
          WHERE row.tenant_id=$1 AND row.version_id=version.id AND version.deleted_at IS NOT NULL`, [scope.tenantId]);
        await insertAudit(client, scope, "deleted", null, input.setId, null);
      }
      await client.query("UPDATE official_usage_confirmations SET consumed_at=clock_timestamp() WHERE id=$1", [confirmationId]);
      const updated = await client.query<StateRow>("SELECT active_set_id,revision FROM official_usage_state WHERE tenant_id=$1", [scope.tenantId]);
      return { activeSetId: updated.rows[0].active_set_id, activeRevision: Number(updated.rows[0].revision) };
    });
  }

  async discardStaging(scope: OfficialUsageScope, id: string) {
    validateScope(scope);
    const result = await transaction(this.database, async client => {
      const changed = await client.query<{ kind: ParsedOfficialUsageReport["kind"]; row_count: number }>(`UPDATE official_usage_staging SET status='cancelled'
        WHERE id=$1 AND tenant_id=$2 AND actor_principal_id=$3 AND status='active' RETURNING kind,row_count`, [id, scope.tenantId, scope.principalId]);
      if (!changed.rows[0]) throw new AppError(409, "staging_unavailable", "The official usage preview cannot be discarded.");
      await client.query("DELETE FROM official_usage_staged_rows WHERE staging_id=$1 AND tenant_id=$2 AND actor_principal_id=$3", [id, scope.tenantId, scope.principalId]);
      await insertAudit(client, scope, "discarded", changed.rows[0].kind, id, changed.rows[0].row_count);
      return true;
    });
    return result;
  }

  async cleanupExpiredStaging() {
    return transaction(this.database, async client => {
      const purged = await purgeExpiredPreviews(client, undefined, 20);
      await client.query(`DELETE FROM official_usage_confirmations WHERE id IN (
        SELECT id FROM official_usage_confirmations
        WHERE expires_at<=clock_timestamp() OR consumed_at<clock_timestamp()-interval '1 day'
        ORDER BY expires_at,id LIMIT 100)`);
      return purged;
    });
  }

  async acknowledgeLegacyCleanup(scope: OfficialUsageScope) {
    validateScope(scope);
    await transaction(this.database, async client => {
      await insertAudit(client, scope, "legacy_cleanup_acknowledged", null, randomUUID(), null);
    });
  }
}

async function ensureState(client: pg.PoolClient, tenantId: string) {
  await client.query("INSERT INTO official_usage_state(tenant_id) VALUES($1) ON CONFLICT DO NOTHING", [tenantId]);
  return (await client.query<StateRow>("SELECT active_set_id,revision FROM official_usage_state WHERE tenant_id=$1 FOR UPDATE", [tenantId])).rows[0];
}

async function lockTenant(client: pg.PoolClient, tenantId: string) {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`official-usage:${tenantId}`]);
}

async function markAccepted(client: pg.PoolClient, scope: OfficialUsageScope, stage: StagingRow, versionId: string, setId: string, resultRevision: number) {
  await client.query(`UPDATE official_usage_staging SET status='accepted',accepted_version_id=$4,accepted_set_id=$5,
      accepted_result_revision=$6,accepted_at=clock_timestamp()
    WHERE id=$1 AND tenant_id=$2 AND actor_principal_id=$3`, [stage.id, scope.tenantId, scope.principalId, versionId, setId, resultRevision]);
  await client.query("DELETE FROM official_usage_staged_rows WHERE staging_id=$1 AND tenant_id=$2 AND actor_principal_id=$3", [stage.id, scope.tenantId, scope.principalId]);
}

async function insertAudit(client: pg.PoolClient, scope: OfficialUsageScope, action: "staged" | "accepted" | "selected" | "deleted" | "discarded" | "legacy_cleanup_acknowledged", kind: ParsedOfficialUsageReport["kind"] | null, targetId: string, rowCount: number | null) {
  await client.query(`INSERT INTO official_usage_audit(id,tenant_id,actor_principal_id,action,target_kind,target_id,row_count,outcome)
    VALUES($1,$2,$3,$4,$5,$6,$7,'succeeded')`, [randomUUID(), scope.tenantId, scope.principalId, action, kind, targetId, rowCount]);
}

async function companionMetrics(client: pg.PoolClient, scope: OfficialUsageScope, bundleId: string) {
  const result = await client.query<{ kind: ParsedOfficialUsageReport["kind"]; rows: unknown[] }>(`SELECT membership.kind,jsonb_agg(fact.row_data ORDER BY row.ordinal) AS rows
    FROM official_usage_sets report_set JOIN official_usage_set_versions membership ON membership.set_id=report_set.id
    JOIN official_usage_version_rows row ON row.version_id=membership.version_id
    JOIN official_usage_row_facts fact ON fact.tenant_id=row.tenant_id AND fact.kind=row.kind AND fact.payload_hash=row.payload_hash
    WHERE report_set.tenant_id=$1 AND report_set.actor_principal_id=$2 AND report_set.bundle_id=$3 GROUP BY membership.kind
    UNION ALL
    SELECT staging.kind,jsonb_agg(row.row_data ORDER BY row.ordinal) AS rows
    FROM official_usage_staging staging JOIN official_usage_staged_rows row ON row.staging_id=staging.id
      AND row.tenant_id=staging.tenant_id AND row.actor_principal_id=staging.actor_principal_id
    WHERE staging.tenant_id=$1 AND staging.actor_principal_id=$2 AND staging.bundle_id=$3
      AND staging.status='active' AND staging.expires_at>clock_timestamp()
    GROUP BY staging.kind`, [scope.tenantId, scope.principalId, bundleId]);
  return Object.fromEntries(result.rows.map(value => [value.kind, metrics(value.kind, value.rows as ParsedOfficialUsageReport["rows"])]));
}

async function bundlePreview(client: pg.PoolClient, scope: OfficialUsageScope, bundleId: string, expectedActiveRevision: number) {
  const reportSet = await client.query<{
    id: string; actor_principal_id: string; reporting_start: string | Date | null; reporting_end: string | Date | null;
    supersedes_set_id: string | null;
  }>(`SELECT id,actor_principal_id,reporting_start,reporting_end,supersedes_set_id FROM official_usage_sets
    WHERE tenant_id=$1 AND bundle_id=$2 AND deleted_at IS NULL`, [scope.tenantId, bundleId]);
  if (reportSet.rows[0] && reportSet.rows[0].actor_principal_id !== scope.principalId) {
    throw new AppError(409, "bundle_owner_mismatch", "This unpublished report bundle belongs to another administrator.");
  }
  const stages = await client.query<StagingRow>(`SELECT * FROM official_usage_staging
    WHERE tenant_id=$1 AND actor_principal_id=$2 AND bundle_id=$3 AND status='active' AND expires_at>clock_timestamp()
    ORDER BY kind,id FOR UPDATE`, [scope.tenantId, scope.principalId, bundleId]);
  const accepted = await client.query<{
    kind: ParsedOfficialUsageReport["kind"]; version_id: string; file_hash: string; content_hash: string;
    reporting_start: string | Date | null; reporting_end: string | Date | null; period_provenance: StagingRow["period_provenance"];
    source_as_of: Date | null; source_as_of_provenance: StagingRow["source_as_of_provenance"];
  }>(`SELECT membership.kind,membership.version_id,artifact.file_hash,version.content_hash,
      version.reporting_start,version.reporting_end,
      version.period_provenance,version.source_as_of,version.source_as_of_provenance
    FROM official_usage_sets report_set JOIN official_usage_set_versions membership ON membership.set_id=report_set.id AND membership.tenant_id=report_set.tenant_id
    JOIN official_usage_versions version ON version.id=membership.version_id
    JOIN official_usage_artifacts artifact ON artifact.id=version.artifact_id
    WHERE report_set.tenant_id=$1 AND report_set.bundle_id=$2 AND report_set.actor_principal_id=$3
      AND report_set.deleted_at IS NULL AND version.deleted_at IS NULL
    ORDER BY membership.kind`, [scope.tenantId, bundleId, scope.principalId]);
  if (!stages.rowCount && !accepted.rowCount) throw new AppError(404, "bundle_not_found", "The official usage bundle was not found for this administrator.");
  if (stages.rows.some(stage => Number(stage.active_revision) !== expectedActiveRevision)) {
    throw new AppError(409, "active_revision_mismatch", "The active official usage selection changed; create a new preview.");
  }
  const kinds = new Set([...accepted.rows.map(row => row.kind), ...stages.rows.map(row => row.kind)]);
  if (kinds.size !== accepted.rows.length + stages.rows.length) {
    throw new AppError(409, "bundle_kind_conflict", "The bundle contains more than one intent for a report kind.");
  }
  const bases = [
    ...stages.rows.map(stage => ({
      reportingStart: stage.reporting_start,
      reportingEnd: stage.reporting_end,
      periodProvenance: stage.period_provenance,
      sourceAsOf: stage.source_as_of,
      sourceAsOfProvenance: stage.source_as_of_provenance,
      correctionOfSetId: stage.correction_of_set_id,
    })),
    ...accepted.rows.map(version => ({
      reportingStart: version.reporting_start,
      reportingEnd: version.reporting_end,
      periodProvenance: version.period_provenance,
      sourceAsOf: version.source_as_of,
      sourceAsOfProvenance: version.source_as_of_provenance,
      correctionOfSetId: reportSet.rows[0]?.supersedes_set_id ?? null,
    })),
  ];
  const basis = bases[0];
  if (basis && bases.some(candidate =>
    candidate.correctionOfSetId !== basis.correctionOfSetId ||
    !compatibleReportBasis({
      reporting_start: candidate.reportingStart,
      reporting_end: candidate.reportingEnd,
      period_provenance: candidate.periodProvenance,
      source_as_of: candidate.sourceAsOf,
      source_as_of_provenance: candidate.sourceAsOfProvenance,
    }, {
      reporting_start: basis.reportingStart,
      reporting_end: basis.reportingEnd,
      period_provenance: basis.periodProvenance,
      source_as_of: basis.sourceAsOf,
      source_as_of_provenance: basis.sourceAsOfProvenance,
    }))) {
    throw new AppError(409, "incompatible_bundle", "The report period, source snapshot basis, or correction target differs across bundle companions.");
  }
  const metricsByKind = await companionMetrics(client, scope, bundleId);
  const intent = {
    tenantId: scope.tenantId,
    principalId: scope.principalId,
    bundleId,
    expectedActiveRevision,
    staging: stages.rows.map(stage => ({
      id: stage.id,
      revision: stage.revision,
      kind: stage.kind,
      contentHash: stage.content_hash,
      fileHash: stage.file_hash,
      reportingStart: dateValue(stage.reporting_start),
      reportingEnd: dateValue(stage.reporting_end),
      periodProvenance: stage.period_provenance,
      sourceAsOf: stage.source_as_of?.toISOString() ?? null,
      sourceAsOfProvenance: stage.source_as_of_provenance,
    })),
    accepted: accepted.rows.map(version => ({
      kind: version.kind,
      versionId: version.version_id,
      fileHash: version.file_hash,
      contentHash: version.content_hash,
    })),
  };
  const contentHash = kinds.size === requiredKinds.length
    ? (await client.query<{ content_hash: string }>(`SELECT official_usage_bundle_content_hash($1::jsonb) AS content_hash`, [
        JSON.stringify([
          ...stages.rows.map(stage => ({ kind: stage.kind, contentHash: stage.content_hash })),
          ...accepted.rows.map(version => ({ kind: version.kind, contentHash: version.content_hash })),
        ]),
      ])).rows[0].content_hash
    : null;
  return {
    bundleId,
    bundleHash: hash(intent),
    contentHash,
    expectedActiveRevision,
    staging: stages.rows.map(projectStaging),
    acceptedVersions: accepted.rows.map(version => ({
      kind: version.kind,
      versionId: version.version_id,
      contentHash: version.content_hash,
      fileHash: version.file_hash,
      reportingPeriod: { startDate: dateValue(version.reporting_start), endDate: dateValue(version.reporting_end), provenance: version.period_provenance },
      sourceAsOf: version.source_as_of?.toISOString() ?? null,
      sourceAsOfProvenance: version.source_as_of_provenance,
    })),
    missingKinds: requiredKinds.filter(kind => !kinds.has(kind)),
    reconciliation: {
      kinds: Object.fromEntries(Object.entries(metricsByKind).sort(([left], [right]) => ordinal(left, right))),
      responses: sourceComparisonFromMetrics(metricsByKind, "responses"),
      distinctUsers: sourceComparisonFromMetrics(metricsByKind, "distinctUsers"),
    },
  };
}

const requiredKinds = ["agents", "userAgents", "users"] as const;

async function validateBundleHistoryIntent(
  client: pg.PoolClient,
  scope: OfficialUsageScope,
  preview: Awaited<ReturnType<typeof bundlePreview>>,
) {
  if (!preview.contentHash || !preview.staging.length) return;
  const basis = preview.staging[0];
  if (basis.correctionOfSetId) {
    await validateCorrectionTarget(client, scope, basis.correctionOfSetId, basis.reportingPeriod.provenance,
      basis.reportingPeriod.startDate, basis.reportingPeriod.endDate);
  }
}

async function validateCorrectionTarget(
  client: pg.PoolClient,
  scope: OfficialUsageScope,
  correctionOfSetId: string,
  periodProvenance: StagingRow["period_provenance"],
  reportingStart: string | null,
  reportingEnd: string | null,
) {
  const correction = await client.query(`SELECT 1 FROM official_usage_sets report_set
      WHERE report_set.id=$1 AND report_set.tenant_id=$2 AND report_set.complete AND report_set.deleted_at IS NULL
        AND report_set.period_provenance=$3
        AND ($3='activity_range' OR (
          report_set.reporting_start IS NOT DISTINCT FROM $4::date
          AND report_set.reporting_end IS NOT DISTINCT FROM $5::date))`,
  [correctionOfSetId, scope.tenantId, periodProvenance, reportingStart, reportingEnd]);
  if (!correction.rowCount) {
    throw new AppError(409, "invalid_correction", "A correction must target a retained observation with the same reporting-window provenance and, when known, dates.");
  }
}

async function enforceHistoryQuota(
  client: pg.PoolClient,
  tenantId: string,
  additions: { sets?: number; versions?: number; rows?: number },
) {
  const counts = (await client.query<{ sets: number; versions: number; rows: string }>(`SELECT
      (SELECT count(*)::int FROM official_usage_sets WHERE tenant_id=$1 AND deleted_at IS NULL) AS sets,
      (SELECT count(*)::int FROM official_usage_versions WHERE tenant_id=$1 AND deleted_at IS NULL) AS versions,
      (SELECT count(*)::text FROM official_usage_version_rows row
        JOIN official_usage_versions version ON version.id=row.version_id
        WHERE row.tenant_id=$1 AND version.deleted_at IS NULL) AS rows`,
  [tenantId])).rows[0];
  if (counts.sets + (additions.sets ?? 0) > 5_000 ||
      counts.versions + (additions.versions ?? 0) > 15_000 ||
      Number(counts.rows) + (additions.rows ?? 0) > 25_000_000) {
    throw new AppError(429, "official_usage_history_quota", "The finite official usage history set, observation, or row-association quota is full.");
  }
}

function sourceComparisonFromMetrics(metricsByKind: Record<string, unknown>, field: string) {
  return Object.fromEntries(Object.entries(metricsByKind).map(([kind, value]) => [kind,
    typeof value === "object" && value && typeof (value as Record<string, unknown>)[field] === "number"
      ? (value as Record<string, number>)[field]
      : null]));
}

function ordinal(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function buildReconciliation(report: ParsedOfficialUsageReport, companions: Record<string, unknown>) {
  return { current: metrics(report.kind, report.rows), companions, acceptedKinds: Object.keys(companions).sort(), projectedComplete: Object.keys(companions).length === 2 };
}

function metrics(kind: ParsedOfficialUsageReport["kind"], rows: ParsedOfficialUsageReport["rows"]) {
  if (kind === "agents") {
    const typed = rows as Extract<ParsedOfficialUsageReport, { kind: "agents" }>["rows"];
    return { rows: typed.length, responses: typed.reduce((sum, row) => sum + row.responsesSentToUsers, 0), activeUsersAreNonAdditive: true };
  }
  if (kind === "userAgents") {
    const typed = rows as Extract<ParsedOfficialUsageReport, { kind: "userAgents" }>["rows"];
    return { rows: typed.length, responses: typed.reduce((sum, row) => sum + row.responsesSentToUsers, 0), distinctUsers: new Set(typed.map(row => row.username)).size, distinctAgents: new Set(typed.map(row => row.agentId)).size };
  }
  const typed = rows as Extract<ParsedOfficialUsageReport, { kind: "users" }>["rows"];
  return { rows: typed.length, responses: typed.reduce((sum, row) => sum + row.agentResponsesReceived, 0), distinctUsers: new Set(typed.map(row => row.username)).size };
}

function projectStaging(row: StagingRow) {
  return {
    id: row.id,
    revision: row.revision,
    status: row.status,
    kind: row.kind,
    fileHash: row.file_hash,
    contentHash: row.content_hash,
    parserVersion: row.parser_version,
    schemaVersion: row.schema_version,
    bundleId: row.bundle_id,
    correctionOfSetId: row.correction_of_set_id,
    reportingPeriod: { startDate: dateValue(row.reporting_start), endDate: dateValue(row.reporting_end), provenance: row.period_provenance },
    sourceAsOf: row.source_as_of?.toISOString() ?? null,
    sourceAsOfProvenance: row.source_as_of_provenance,
    sourceFreshness: row.source_freshness,
    downloadedAt: row.downloaded_at?.toISOString() ?? null,
    rowCount: row.row_count,
    warnings: row.warnings,
    reconciliation: row.reconciliation,
    activeRevision: Number(row.active_revision),
    acceptedVersionId: row.accepted_version_id,
    acceptedSetId: row.accepted_set_id,
    createdAt: row.created_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
    acceptedAt: row.accepted_at?.toISOString() ?? null,
  };
}

function projectSet(row: SetRow) {
  return {
    id: row.id,
    bundleId: row.bundle_id,
    contentHash: row.content_hash ?? undefined,
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
  };
}

function validateScope(scope: OfficialUsageScope) {
  if (!scope.tenantId || !scope.principalId) throw new AppError(403, "scope_mismatch", "Official usage requires an exact tenant and principal scope.");
}

function validateTenant(tenantId: string) {
  if (!tenantId) throw new AppError(403, "scope_mismatch", "Official usage requires an exact tenant scope.");
}

function dateValue(value: string | Date | null) {
  if (value === null || typeof value === "string") return value;
  // pg decodes DATE as local midnight, not a UTC instant. Preserve its civil date.
  return `${String(value.getFullYear()).padStart(4, "0")}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
}

function periodDays(start: string | Date | null, end: string | Date | null) {
  const startDate = dateValue(start);
  const endDate = dateValue(end);
  return startDate && endDate
    ? Math.floor((Date.parse(endDate) - Date.parse(startDate)) / 86_400_000) + 1
    : null;
}

function compatibleSourceBasis(
  left: Pick<StagingRow, "period_provenance" | "source_as_of" | "source_as_of_provenance">,
  right: Pick<StagingRow, "period_provenance" | "source_as_of" | "source_as_of_provenance">,
) {
  if (left.period_provenance !== right.period_provenance || left.source_as_of_provenance !== right.source_as_of_provenance) return false;
  if (!left.source_as_of || !right.source_as_of) return left.source_as_of === right.source_as_of;
  return left.source_as_of.getTime() === right.source_as_of.getTime();
}

function compatibleReportBasis(
  left: Pick<StagingRow, "reporting_start" | "reporting_end" | "period_provenance" | "source_as_of" | "source_as_of_provenance">,
  right: Pick<StagingRow, "reporting_start" | "reporting_end" | "period_provenance" | "source_as_of" | "source_as_of_provenance">,
) {
  if (!compatibleSourceBasis(left, right)) return false;
  return left.period_provenance === "activity_range" ||
    dateValue(left.reporting_start) === dateValue(right.reporting_start) &&
    dateValue(left.reporting_end) === dateValue(right.reporting_end);
}

function unionCoverage(
  left: Pick<SetRow, "reporting_start" | "reporting_end">,
  right: Pick<StagingRow, "reporting_start" | "reporting_end">,
) {
  const starts = [dateValue(left.reporting_start), dateValue(right.reporting_start)]
    .filter((value): value is string => value !== null);
  const ends = [dateValue(left.reporting_end), dateValue(right.reporting_end)]
    .filter((value): value is string => value !== null);
  return {
    startDate: starts.length ? starts.sort()[0] : null,
    endDate: ends.length ? ends.sort().at(-1)! : null,
  };
}

function sameImmutableVersionIntent(
  version: { content_hash: string },
  stage: StagingRow,
) {
  return version.content_hash === stage.content_hash;
}

async function purgeExpiredPreviews(client: pg.PoolClient, tenantId: string | undefined, limit: number) {
  const expired = await client.query<{ id: string }>(`WITH candidates AS (
      SELECT id FROM official_usage_staging WHERE status='active' AND expires_at<=clock_timestamp()
        AND ($1::text IS NULL OR tenant_id=$1) ORDER BY expires_at,id LIMIT $2 FOR UPDATE SKIP LOCKED)
    UPDATE official_usage_staging staging SET status='expired' FROM candidates
      WHERE staging.id=candidates.id RETURNING staging.id`, [tenantId ?? null, limit]);
  await client.query(`DELETE FROM official_usage_staged_rows row WHERE row.staging_id IN (
    SELECT id FROM official_usage_staging WHERE status IN ('expired','replaced','cancelled')
      AND ($1::text IS NULL OR tenant_id=$1) ORDER BY expires_at,id LIMIT $2)`, [tenantId ?? null, limit]);
  return expired.rowCount ?? 0;
}

function validateHash(value: string) {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new AppError(400, "invalid_hash", "The official usage content hash is invalid.");
}

function throwIfCancelled(signal: AbortSignal | undefined) {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new AppError(400, "upload_disconnected", "The official usage upload was cancelled.");
}

function validateUuid(value: string, label: string) {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)) {
    throw new AppError(400, "invalid_identifier", `The ${label} is invalid.`);
  }
}

function hash(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}