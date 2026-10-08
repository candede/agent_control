import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type pg from "pg";
import { AppError } from "../errors.js";
import { LifecycleSlice } from "./lifecycleSlice.js";
import { emptyReportStaging } from "./officialReportRetention.js";
import { dataConnections } from "./dataConnections.js";
import { retainDeletedReportRows, retireUnreferencedReportVersions } from "./dataRetention.js";
import { digest, encodeBatch } from "./dataBounds.js";
import { officialReportCount as exactCount } from "./officialReportBounds.js";
import { generationHeartbeat } from "./dataGenerations.js";
import { OfficialReportHistory } from "./officialReportHistory.js";
import { streamOfficialReport, officialReportLimits, type OfficialRow, type StreamedOfficialReport } from "../services/officialReportStream.js";
import { reportBase } from "../services/officialReportFields.js";
import type { OfficialUsageMetadata, OfficialUsageReportKind } from "../types/officialReportRecords.js";
import type { OfficialReportBundleAcceptance, OfficialReportBundleInspection } from "../types/officialReportApi.js";
import { CursorCodec, type SelectionIdentity } from "../services/dataSelections.js";
import { measurePublication } from "../services/peakMemory.js";
import { completeReportVersionSql } from "./reportCapacitySchema.js";
import { operationalLog } from "../services/telemetry.js";

type Lease = { id: string; owner: string; identity: SelectionIdentity };
export type ReportImportIntent = { bundleId: string; correctionOfSetId?: string; rejectDuplicateKind?: boolean };
export type ReportAcceptance = { stagingId: string; revision: number; contentHash: string; expectedActiveRevision: string };
export type ReportConfirmation = { id: string; setId: string; operation: "select" | "delete"; activeRevision: string; historyRevision: string; historyEpoch: string; hash: string };
const unavailable = () => new AppError(409, "staging_unavailable", "The report preview is unavailable or its lease was fenced.");
class AcceptancePending extends Error {
  constructor(readonly deadline: number) { super("official_report_acceptance_pending"); }
}
async function settleAcceptance<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  for (;;) {
    signal?.throwIfAborted();
    try { return await work(); }
    catch (error) {
      if (!(error instanceof AcceptancePending)) throw error;
      const remaining = error.deadline - Date.now();
      if (remaining <= 0) throw unavailable();
      await delay(Math.min(250, remaining), undefined, { signal });
    }
  }
}
function compatible(rows: readonly pg.QueryResultRow[]) {
  for (const row of rows) for (const other of rows) {
    if (row.period_provenance !== other.period_provenance || row.source_as_of_provenance !== other.source_as_of_provenance
      || row.source_as_of?.toISOString() !== other.source_as_of?.toISOString()
      || row.period_provenance !== "activity_range" && (String(row.reporting_start) !== String(other.reporting_start)
        || String(row.reporting_end) !== String(other.reporting_end))) {
      throw new AppError(409, "incompatible_bundle", "Report observation bases differ.");
    }
  }
}
function confirmationInput(input: unknown, hash: string) {
  if (!input || typeof input !== "object" || Array.isArray(input) || typeof (input as Record<string, unknown>)[hash] !== "string"
    || !/^[a-f0-9]{64}$/.test((input as Record<string, string>)[hash])) throw new AppError(400, "invalid_import_confirmation", "Review a valid immutable confirmation.");
}
function revision(value: unknown) { if (typeof value !== "string" || !/^\d{1,19}$/.test(value)) throw new AppError(400, "invalid_import_confirmation", "Expected a decimal revision."); }
export function reportUuid(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value)) throw new AppError(400, "invalid_identifier", "Expected a UUID.");
  return value;
}

export class OfficialReportImports {
  readonly connections;
  readonly history;
  constructor(readonly database: pg.Pool) {
    this.connections = dataConnections(database);
    this.history = new OfficialReportHistory(database);
  }

  private async authorize(client: pg.PoolClient, identity: SelectionIdentity) {
    await client.query("INSERT INTO data_principal_epochs(tenant_id,principal_id) VALUES($1,$2) ON CONFLICT DO NOTHING", [identity.tenantId, identity.principalId]);
    const row = (await client.query("SELECT epoch FROM data_principal_epochs WHERE tenant_id=$1 AND principal_id=$2 FOR SHARE",
      [identity.tenantId, identity.principalId])).rows[0];
    if (row.epoch !== identity.sessionEpoch) throw unavailable();
  }
  private async fence(client: pg.PoolClient, lease: Lease) {
    await this.authorize(client, lease.identity);
    const row = (await client.query(`SELECT * FROM official_usage_ingestions WHERE id=$1 AND owner=$2 AND tenant_id=$3 AND principal_id=$4
      AND session_epoch=$5 AND state IN ('streaming','validating','accepting') AND lease_until>clock_timestamp()
      AND deadline_at>clock_timestamp() AND expires_at>clock_timestamp() FOR UPDATE`,
    [lease.id, lease.owner, lease.identity.tenantId, lease.identity.principalId, lease.identity.sessionEpoch])).rows[0];
    if (!row) throw unavailable();
    return row;
  }
  private async tenant(client: pg.PoolClient, tenantId: string) {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`official-usage:${tenantId}`]);
    await client.query("INSERT INTO official_usage_state(tenant_id) VALUES($1) ON CONFLICT DO NOTHING", [tenantId]);
    return (await client.query("SELECT active_set_id,revision::text FROM official_usage_state WHERE tenant_id=$1 FOR UPDATE", [tenantId])).rows[0];
  }
  private async quotas(client: pg.PoolClient, identity: SelectionIdentity, bundleId: string, extra: number) {
    const row = (await client.query(`SELECT COALESCE(sum(stored_bytes),0)::text AS tenant,
      COALESCE(sum(stored_bytes) FILTER(WHERE principal_id=$2),0)::text AS actor,
      COALESCE(sum(stored_bytes) FILTER(WHERE bundle_id=$3),0)::text AS bundle
      FROM official_usage_ingestions WHERE tenant_id=$1`,
    [identity.tenantId, identity.principalId, bundleId])).rows[0];
    for (const [key, limit] of [["tenant", officialReportLimits.tenantBytes], ["actor", officialReportLimits.actorBytes], ["bundle", officialReportLimits.bundleBytes]] as const) {
      if (exactCount(row[key]) + extra > limit) throw new AppError(413, "staging_limit_exceeded", `${key} staged bytes exceed ${limit}.`);
    }
  }

  async open(identity: SelectionIdentity, intent: ReportImportIntent, parent?: AbortSignal) {
    reportUuid(intent.bundleId);
    if (intent.correctionOfSetId) reportUuid(intent.correctionOfSetId);
    if (intent.rejectDuplicateKind !== undefined && typeof intent.rejectDuplicateKind !== "boolean") throw new AppError(400, "invalid_upload_intent", "Duplicate-kind guard must be a boolean.");
    await this.history.ensure(identity.tenantId);
    const lease: Lease = { id: randomUUID(), owner: randomUUID(), identity };
    await this.connections.run(async client => {
      await this.authorize(client, identity);
      await client.query("SELECT pg_advisory_xact_lock(3650147)");
      await this.tenant(client, identity.tenantId);
      const counts = (await client.query(`SELECT count(DISTINCT tenant_id||':'||CASE WHEN state='accepting' THEN 'bundle:'||bundle_id::text ELSE 'file:'||id::text END)::int AS n,
        count(DISTINCT tenant_id||':'||CASE WHEN state='accepting' THEN 'bundle:'||bundle_id::text ELSE 'file:'||id::text END) FILTER(WHERE tenant_id=$1)::int AS tenant
        FROM official_usage_ingestions WHERE state IN ('streaming','validating','accepting') AND lease_until>clock_timestamp()`,
      [identity.tenantId])).rows[0];
      const generations = (await client.query(`SELECT count(*)::int AS n,count(*) FILTER(WHERE tenant_id=$1)::int AS tenant
        FROM data_generations WHERE state IN ('staging','validating') AND lease_until>clock_timestamp()`, [identity.tenantId])).rows[0];
      if (counts.n + generations.n >= 4 || counts.tenant + generations.tenant >= 2) throw new AppError(429, "upload_admission_full", "Retry after an active stream finishes.");
      const drafts = (await client.query(`SELECT count(*)::int AS tenant,count(*) FILTER(WHERE principal_id=$2)::int AS actor
        FROM official_usage_ingestions WHERE tenant_id=$1 AND state NOT IN ('accepted','cancelled','failed') AND expires_at>clock_timestamp()`,
      [identity.tenantId, identity.principalId])).rows[0];
      if (drafts.tenant >= 30 || drafts.actor >= 9) throw new AppError(429, "staging_count_limit", "Discard or accept an existing draft.");
      if ((await client.query(`SELECT 1 FROM official_usage_ingestions WHERE tenant_id=$1 AND bundle_id=$2 AND principal_id<>$3
        UNION ALL SELECT 1 FROM official_usage_sets WHERE tenant_id=$1 AND bundle_id=$2 AND actor_principal_id<>$3 LIMIT 1`,
      [identity.tenantId, intent.bundleId, identity.principalId])).rowCount) throw new AppError(409, "bundle_owner_mismatch", "The draft belongs to another administrator.");
      if (intent.correctionOfSetId && !(await client.query(`SELECT 1 FROM official_usage_sets WHERE id=$1 AND tenant_id=$2 AND complete AND deleted_at IS NULL`,
        [intent.correctionOfSetId, identity.tenantId])).rowCount) throw new AppError(409, "invalid_correction", "Correction target is unavailable.");
      await this.quotas(client, identity, intent.bundleId, 0);
      await client.query(`INSERT INTO official_usage_ingestions(id,tenant_id,principal_id,bundle_id,correction_of,owner,session_epoch,state,lease_until,deadline_at,expires_at,reject_duplicate_kind)
        VALUES($1,$2,$3,$4,$5,$6,$7,'streaming',clock_timestamp()+interval '60 seconds',clock_timestamp()+interval '30 minutes',clock_timestamp()+interval '30 minutes',$8)`,
      [lease.id, identity.tenantId, identity.principalId, intent.bundleId, intent.correctionOfSetId ?? null, lease.owner, identity.sessionEpoch, intent.rejectDuplicateKind ?? false]);
    }, false, parent);
    const heartbeat = generationHeartbeat(() => this.connections.run(async client => {
      await this.fence(client, lease);
      await client.query("UPDATE official_usage_ingestions SET lease_until=LEAST(deadline_at,clock_timestamp()+interval '60 seconds') WHERE id=$1", [lease.id]);
    }, true), parent);
    let result: StreamedOfficialReport | undefined;
    const cancel = async () => {
      await heartbeat.stop();
      await this.cancel(identity, lease.id);
    };
    return {
      id: lease.id, signal: heartbeat.signal,
      receive: async (stream: AsyncIterable<Uint8Array>) => {
        try {
          result = await streamOfficialReport(stream, undefined, heartbeat.signal, {
            batch: (kind, rows, wireBytes) => this.append(lease, kind, rows, wireBytes),
          });
          return { kind: result.kind, rows: result.rowCount, wireBytes: result.wireBytes };
        } catch (error) { await cancel(); throw error; }
      },
      finish: async (metadata?: OfficialUsageMetadata) => {
        try {
          if (!result) throw unavailable();
          heartbeat.signal.throwIfAborted();
          const finalized = await this.finalize(lease, result, metadata, heartbeat.signal);
          await heartbeat.pause();
          const replaced = await this.connections.run(async client => {
            await this.tenant(client, identity.tenantId);
            await this.fence(client, lease);
            const previous = (await client.query(`SELECT id,staging_id FROM official_usage_ingestions WHERE tenant_id=$1 AND bundle_id=$2
              AND kind=$3 AND id<>$4 AND state='ready' AND expires_at>clock_timestamp() FOR UPDATE`,
            [identity.tenantId, finalized.bundleId, result!.kind, lease.id])).rows;
            if (previous.length > 1 || previous.length && intent.rejectDuplicateKind) throw new AppError(409, "duplicate_report_kind", "Draft already contains this report kind.");
            for (const other of previous) {
              await client.query("UPDATE official_usage_ingestions SET state='cancelled' WHERE id=$1", [other.id]);
              await client.query("UPDATE official_usage_staging SET status='replaced' WHERE id=$1", [other.staging_id]);
              await this.audit(client, identity, "discarded", result!.kind, other.staging_id, null);
            }
            await client.query("UPDATE official_usage_ingestions SET state='ready' WHERE id=$1", [lease.id]);
            await this.audit(client, identity, "staged", result!.kind, finalized.id, result!.rowCount);
            return previous.map(other => other.id as string);
          }, false, heartbeat.signal);
          await heartbeat.stop();
          for (const other of replaced) await this.cleanupIngestion(other);
          return await this.preview(identity, finalized.id);
        } catch (error) { await cancel(); throw error; }
      },
      cancel,
    };
  }

  async stage(identity: SelectionIdentity, intent: ReportImportIntent, stream: AsyncIterable<Uint8Array>, metadata?: OfficialUsageMetadata, signal?: AbortSignal) {
    const upload = await this.open(identity, intent, signal);
    await upload.receive(stream);
    return upload.finish(metadata);
  }

  private append(lease: Lease, kind: OfficialUsageReportKind, rows: readonly OfficialRow[], wireBytes: number) {
    return this.connections.run(async client => {
      await this.tenant(client, lease.identity.tenantId);
      const current = await this.fence(client, lease);
      if (current.kind && current.kind !== kind) throw unavailable();
      const previous = (await client.query(`SELECT id,state,staging_id FROM official_usage_ingestions WHERE tenant_id=$1 AND bundle_id=$2 AND kind=$3 AND id<>$4
        AND state NOT IN ('cancelled','failed') AND expires_at>clock_timestamp() LIMIT 1`,
      [lease.identity.tenantId, current.bundle_id, kind, lease.id])).rows[0];
      if (previous) {
        if (current.reject_duplicate_kind || previous.state !== "ready") throw new AppError(409, "duplicate_report_kind", "Draft already contains this report kind.");
      }
      const normalized = rows.map((row, n) => ({
        ordinal: current.row_count + n, row_data: row,
        natural_key: digest(JSON.stringify(["agentId" in row ? row.agentId : null, "username" in row ? row.username : null])),
      }));
      const batch = encodeBatch(normalized, [lease.id, lease.identity.tenantId, lease.identity.principalId]);
      if (current.row_count + rows.length > officialReportLimits.rows[kind]) throw new AppError(413, "row_limit_exceeded", "Report row limit exceeded.");
      // Reserve both the ingestion and preview copies before writing either.
      await this.quotas(client, lease.identity, current.bundle_id, batch.bytes * 2);
      try {
        await client.query(`INSERT INTO official_usage_ingestion_rows(ingestion_id,tenant_id,principal_id,ordinal,natural_key,payload_hash,row_data)
          SELECT $1,$2,$3,ordinal,natural_key,official_usage_payload_hash(row_data),row_data
          FROM jsonb_to_recordset($4::jsonb) r(ordinal integer,natural_key text,row_data jsonb)`,
        [lease.id, lease.identity.tenantId, lease.identity.principalId, batch.json]);
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "23505") throw new AppError(400, "duplicate_identity", "Report contains a duplicate natural identity.");
        throw error;
      }
      await client.query(`UPDATE official_usage_ingestions SET kind=$2,row_count=row_count+$3,stored_bytes=stored_bytes+$4,wire_bytes=$5 WHERE id=$1`,
        [lease.id, kind, rows.length, batch.bytes * 2, wireBytes]);
    });
  }

  private async finalize(lease: Lease, report: StreamedOfficialReport, metadata: OfficialUsageMetadata | undefined, signal: AbortSignal) {
    const dates = [report.reportingPeriod.startDate, report.reportingPeriod.endDate]
      .filter((date): date is string => date !== null).map(date => ({ lastActivityDateUtc: `${date}T00:00:00.000Z` }));
    const base = reportBase(report.kind, metadata, dates);
    await this.append(lease, report.kind, [], report.wireBytes);
    await this.connections.run(async client => {
      await this.fence(client, lease);
      await client.query("UPDATE official_usage_ingestions SET state='validating',kind=$2,wire_bytes=$3 WHERE id=$1", [lease.id, report.kind, report.wireBytes]);
    });
    const { downloadedAt: _downloadedAt, warnings: _warnings, ...contentBase } = base;
    const hash = createHash("sha256").update(JSON.stringify({ kind: report.kind, ...contentBase }));
    let boundary = "", ordinal = -1;
    for (;;) {
      signal.throwIfAborted();
      const rows = await this.connections.run(async client => {
        await this.fence(client, lease);
        return (await client.query(`SELECT payload_hash,ordinal FROM official_usage_ingestion_rows WHERE ingestion_id=$1
          AND (payload_hash,ordinal)>($2,$3) ORDER BY payload_hash,ordinal LIMIT 250`, [lease.id, boundary, ordinal])).rows;
      }, false, signal);
      if (!rows.length) break;
      for (const row of rows) hash.update(row.payload_hash);
      boundary = rows.at(-1)!.payload_hash; ordinal = rows.at(-1)!.ordinal;
    }
    const contentHash = hash.digest("hex"), id = randomUUID();
    const preview = await this.connections.run(async client => {
      const state = await this.tenant(client, lease.identity.tenantId);
      const upload = await this.fence(client, lease);
      const sums = (await client.query(`SELECT count(*)::text AS rows,
        sum(COALESCE((row_data->>'responsesSentToUsers')::numeric,(row_data->>'agentResponsesReceived')::numeric,0))::text AS responses,
        sum(COALESCE((row_data->>'numberOfAgentsUsed')::numeric,0))::text AS agents
        FROM official_usage_ingestion_rows WHERE ingestion_id=$1`, [lease.id])).rows[0];
      if (exactCount(sums.rows) !== report.rowCount) throw new Error("official_report_count_mismatch");
      exactCount(sums.responses ?? "0"); exactCount(sums.agents ?? "0");
      const reconciliation = { rows: report.rowCount, responses: exactCount(sums.responses ?? "0"), agentsUsed: report.kind === "users" ? exactCount(sums.agents ?? "0") : null };
      await client.query(`INSERT INTO official_usage_staging(id,tenant_id,actor_principal_id,kind,file_hash,content_hash,parser_version,schema_version,
        bundle_id,correction_of_set_id,reporting_start,reporting_end,period_provenance,source_as_of,source_as_of_provenance,source_freshness,
        downloaded_at,row_count,stored_bytes,warnings,reconciliation,active_revision,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,'[]',$20::jsonb,$21,$22)`,
      [id, lease.identity.tenantId, lease.identity.principalId, report.kind, report.fileHash, contentHash, base.parserVersion, base.schemaVersion,
        upload.bundle_id, upload.correction_of, base.reportingPeriod.startDate, base.reportingPeriod.endDate, base.reportingPeriod.provenance,
        base.sourceAsOf ?? null, base.sourceAsOfProvenance, base.sourceFreshness, base.downloadedAt ?? null, report.rowCount,
        Math.max(2, exactCount(upload.stored_bytes)), JSON.stringify(reconciliation), state.revision, upload.expires_at]);
      await client.query("UPDATE official_usage_ingestions SET staging_id=$2 WHERE id=$1", [lease.id, id]);
      return { id, revision: 1, bundleId: upload.bundle_id as string, correctionOfSetId: upload.correction_of as string | null,
        kind: report.kind, contentHash, fileHash: report.fileHash, activeRevision: state.revision as string,
        reportingPeriod: base.reportingPeriod, sourceAsOf: base.sourceAsOf ?? null, sourceAsOfProvenance: base.sourceAsOfProvenance,
        sourceFreshness: base.sourceFreshness, rowCount: report.rowCount, wireBytes: report.wireBytes,
        expiresAt: (upload.expires_at as Date).toISOString(), examples: report.examples, warnings: [] as string[], reconciliation };
    }, false, signal);
    for (let offset = 0; offset < report.rowCount; offset += 50) {
      await this.connections.run(async client => {
        await this.fence(client, lease);
        await client.query(`INSERT INTO official_usage_staged_rows(staging_id,tenant_id,actor_principal_id,ordinal,row_data)
          SELECT $1,tenant_id,principal_id,ordinal,row_data FROM official_usage_ingestion_rows
          WHERE ingestion_id=$2 AND ordinal>=$3 AND ordinal<$3+50 ORDER BY ordinal`, [id, lease.id, offset]);
      }, false, signal);
    }
    return preview;
  }

  preview(identity: SelectionIdentity, stagingId: string) {
    return this.connections.selectedRead(async client => {
      await this.authorize(client, identity);
      const row = (await client.query(`SELECT s.id,s.revision,s.kind,s.bundle_id,s.content_hash,s.file_hash,s.row_count,s.stored_bytes::text,
        s.active_revision::text,s.expires_at,s.reporting_start::text,s.reporting_end::text,s.period_provenance,
        s.source_as_of,s.source_as_of_provenance,s.source_freshness,s.reconciliation,s.correction_of_set_id,s.status,i.wire_bytes::text
        FROM official_usage_staging s JOIN official_usage_ingestions i ON i.staging_id=s.id
        WHERE s.id=$1 AND s.tenant_id=$2 AND s.actor_principal_id=$3 AND s.expires_at>clock_timestamp()
          AND i.session_epoch=$4 AND i.state IN ('ready','accepted')`, [reportUuid(stagingId), identity.tenantId, identity.principalId, identity.sessionEpoch])).rows[0];
      if (!row) throw unavailable();
      const examples = (await client.query(`SELECT row_data FROM official_usage_staged_rows WHERE staging_id=$1 ORDER BY ordinal LIMIT 20`, [stagingId])).rows.map(value => value.row_data);
      return { id: row.id as string, revision: row.revision as number, kind: row.kind as OfficialUsageReportKind,
        bundleId: row.bundle_id as string, contentHash: row.content_hash as string, fileHash: row.file_hash as string,
        rowCount: row.row_count as number, storedBytes: exactCount(row.stored_bytes), wireBytes: exactCount(row.wire_bytes), activeRevision: row.active_revision as string,
        expiresAt: (row.expires_at as Date).toISOString(), reportingPeriod: { startDate: row.reporting_start as string | null,
          endDate: row.reporting_end as string | null, provenance: row.period_provenance as string,
          days: row.reporting_start && row.reporting_end ? (Date.parse(row.reporting_end) - Date.parse(row.reporting_start)) / 86400000 + 1 : null },
        sourceAsOf: row.source_as_of?.toISOString() ?? null, sourceAsOfProvenance: row.source_as_of_provenance as string,
        sourceFreshness: row.source_freshness as string, reconciliation: row.reconciliation as Record<string, unknown>,
        correctionOfSetId: row.correction_of_set_id as string | null, status: row.status as string, examples: examples as OfficialRow[],
        warnings: [...(row.source_freshness === "unknown" ? ["source_refresh_unknown"] : []),
          ...(row.period_provenance === "activity_range" ? ["activity_range_not_coverage"] : [])] };
    });
  }

  async bundle(identity: SelectionIdentity, bundleId: string, options: OfficialReportBundleInspection = {}) {
    reportUuid(bundleId);
    return this.connections.selectedRead(async client => {
      await this.authorize(client, identity);
      const state = (await client.query("SELECT revision::text FROM official_usage_state WHERE tenant_id=$1", [identity.tenantId])).rows[0];
      const rows = (await client.query(`SELECT s.id,s.kind,s.revision,s.content_hash,s.row_count,s.reconciliation,
        s.period_provenance,s.source_as_of_provenance,s.source_as_of,s.reporting_start,s.reporting_end
        FROM official_usage_staging s JOIN official_usage_ingestions i ON i.staging_id=s.id
        WHERE s.tenant_id=$1 AND s.actor_principal_id=$2 AND s.bundle_id=$3
          AND ((s.status='active' AND i.state IN ('ready','accepting')) OR (s.status='accepted' AND i.state='accepted'))
          AND i.session_epoch=$4 AND s.expires_at>clock_timestamp() ORDER BY s.kind LIMIT 4`,
      [identity.tenantId, identity.principalId, bundleId, identity.sessionEpoch])).rows;
      if (rows.length > 3) throw unavailable();
      if (options.forDiscard !== true) compatible(rows);
      const stages = rows.map(row => ({ stagingId: row.id as string, kind: row.kind as OfficialUsageReportKind,
        revision: row.revision as number, contentHash: row.content_hash as string, rowCount: row.row_count as number,
        reconciliation: row.reconciliation as Record<string, unknown> }));
      const expectedActiveRevision = state?.revision ?? "1";
      return { bundleId, expectedActiveRevision, stages, complete: new Set(stages.map(stage => stage.kind)).size === 3,
        bundleHash: digest(JSON.stringify({ bundleId, expectedActiveRevision, stages })) };
    });
  }

  acceptBundle(identity: SelectionIdentity, bundleId: string, input: OfficialReportBundleAcceptance, signal?: AbortSignal) {
    return settleAcceptance(() => this.acceptReviewedBundle(identity, bundleId, input, signal), signal);
  }
  private async acceptReviewedBundle(identity: SelectionIdentity, bundleId: string, input: OfficialReportBundleAcceptance, signal?: AbortSignal) {
    confirmationInput(input, "bundleHash"); revision(input.expectedActiveRevision);
    if (input.preserveSelection !== undefined && typeof input.preserveSelection !== "boolean") {
      throw new AppError(400, "invalid_import_intent", "Preserving the report selection must be a boolean.");
    }
    const receipt = await this.connections.selectedRead(async client => {
      await this.authorize(client, identity);
      return (await client.query(`SELECT r.result_set_id,r.result_active_revision::text,s.deleted_at FROM official_usage_bundle_receipts r
        JOIN official_usage_sets s ON s.id=r.result_set_id AND s.tenant_id=r.tenant_id
        WHERE r.tenant_id=$1 AND r.actor_principal_id=$2 AND r.bundle_id=$3 AND r.bundle_hash=$4
          AND r.expected_active_revision=$5 AND r.expires_at>clock_timestamp()`,
      [identity.tenantId, identity.principalId, reportUuid(bundleId), input.bundleHash, input.expectedActiveRevision])).rows[0];
    });
    if (receipt) {
      if (receipt.deleted_at) throw new AppError(409, "deleted_report_duplicate", "This accepted report was deleted.");
      return { setId: receipt.result_set_id as string, activeRevision: receipt.result_active_revision as string, complete: true };
    }
    const preview = await this.bundle(identity, bundleId);
    if (!preview.complete || preview.bundleHash !== input.bundleHash || preview.expectedActiveRevision !== input.expectedActiveRevision) {
      throw new AppError(409, "bundle_fence_mismatch", "Review the current complete bundle before accepting.");
    }
    return this.acceptStages(identity, preview.stages.map(stage => ({ ...stage, expectedActiveRevision: input.expectedActiveRevision })), signal,
      { bundleId, hash: input.bundleHash, preserveSelection: input.preserveSelection });
  }
  accept(identity: SelectionIdentity, input: ReportAcceptance, signal?: AbortSignal) {
    confirmationInput(input, "contentHash"); revision(input.expectedActiveRevision);
    if (!Number.isInteger(input.revision) || input.revision < 1) throw new AppError(400, "invalid_import_confirmation", "Invalid preview revision.");
    return settleAcceptance(() => this.acceptStages(identity, [input], signal), signal);
  }

  private async duplicate(client: pg.PoolClient, tenantId: string, contentHash: string, correctionOf: string | null) {
    return (await client.query(`SELECT s.id FROM official_usage_sets s WHERE s.tenant_id=$1 AND s.content_hash=$2
      AND s.complete AND s.deleted_at IS NULL AND (s.expires_at IS NULL OR s.expires_at>clock_timestamp())
      AND ($3::uuid IS NULL OR s.id=$3 OR s.supersedes_set_id=$3)
      AND 3=(SELECT count(*) FROM official_usage_set_versions m JOIN official_usage_versions v ON v.id=m.version_id
        JOIN official_usage_artifacts a ON a.id=v.artifact_id WHERE m.set_id=s.id AND m.tenant_id=s.tenant_id
          AND v.deleted_at IS NULL AND (LEAST(v.expires_at,a.expires_at) IS NULL OR LEAST(v.expires_at,a.expires_at)>clock_timestamp())
          AND ${completeReportVersionSql("v.id","v.tenant_id","v.kind","v.row_count")})
      ORDER BY s.accepted_at,s.id LIMIT 1`, [tenantId, contentHash, correctionOf])).rows[0] as { id: string } | undefined;
  }

  private async recordAcceptance(client: pg.PoolClient, identity: SelectionIdentity, stages: readonly pg.QueryResultRow[],
    result: { setId: string; activeRevision: string; complete: boolean }, bundle?: { bundleId: string; hash: string; expectedRevision: string }) {
    for (const stage of stages) {
      await client.query(`UPDATE official_usage_staging SET status='accepted',accepted_version_id=$2,accepted_set_id=$3,
        accepted_result_revision=$4,accepted_at=clock_timestamp() WHERE id=$1`,
      [stage.id, stage.version, result.setId, result.activeRevision]);
      await client.query("UPDATE official_usage_ingestions SET state='accepted',version_id=$2 WHERE id=$1", [stage.ingestion_id, stage.version]);
      await this.audit(client, identity, "accepted", stage.kind, stage.version, stage.row_count);
    }
    if (bundle) await client.query(`INSERT INTO official_usage_bundle_receipts(tenant_id,bundle_id,actor_principal_id,bundle_hash,
      expected_active_revision,result_set_id,result_version_id,result_active_revision,result_complete)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [identity.tenantId, bundle.bundleId, identity.principalId, bundle.hash, bundle.expectedRevision, result.setId,
      stages.at(-1)!.version, result.activeRevision, result.complete]);
  }

  private async acceptStages(identity: SelectionIdentity, inputs: readonly ReportAcceptance[], parent?: AbortSignal, bundle?: { bundleId: string; hash: string; preserveSelection?: boolean }) {
    if (!inputs.length || inputs.length > 3) throw unavailable();
    await this.history.ensure(identity.tenantId);
    const prepared = await this.connections.run(async client => {
      await this.authorize(client, identity);
      await client.query("SELECT pg_advisory_xact_lock(3650147)");
      await this.history.lock(client, identity.tenantId);
      const state = await this.tenant(client, identity.tenantId);
      const stages: pg.QueryResultRow[] = [];
      let acceptedBundle: string | undefined;
      let receipt: { setId: string; activeRevision: string; complete: boolean } | undefined;
      for (const input of inputs) {
        const stage = (await client.query(`SELECT s.*,i.id AS ingestion_id,i.owner,i.version_id AS pending_version,
          i.state AS ingestion_state,i.acceptance_revision::text,i.lease_until,i.deadline_at
          FROM official_usage_staging s JOIN official_usage_ingestions i ON i.staging_id=s.id
          WHERE s.id=$1 AND s.tenant_id=$2 AND s.actor_principal_id=$3 AND s.expires_at>clock_timestamp()
            AND i.session_epoch=$4 AND i.state IN ('ready','accepting','accepted') FOR UPDATE OF s,i`,
        [reportUuid(input.stagingId), identity.tenantId, identity.principalId, identity.sessionEpoch])).rows[0];
        if (!stage || stage.revision !== input.revision || stage.content_hash !== input.contentHash) throw unavailable();
        if (stage.ingestion_state === "accepting") {
          if (stage.lease_until <= new Date()) throw unavailable();
          throw new AcceptancePending(Math.min(stage.deadline_at.getTime(), stage.expires_at.getTime()));
        }
        if (stages.some(other => other.bundle_id !== stage.bundle_id) || acceptedBundle && acceptedBundle !== stage.bundle_id) throw unavailable();
        if (stage.status === "accepted") {
          if (!bundle && stage.acceptance_revision !== input.expectedActiveRevision) {
            throw new AppError(409, "active_revision_mismatch", "The acceptance receipt belongs to a different reviewed revision.");
          }
          const accepted = (await client.query(`SELECT s.complete FROM official_usage_sets s WHERE s.id=$1 AND s.tenant_id=$2
            AND (s.deleted_at IS NULL OR (NOT s.complete AND EXISTS (
              SELECT 1 FROM official_usage_staging receipt JOIN official_usage_sets canonical
                ON canonical.id=receipt.accepted_set_id AND canonical.tenant_id=receipt.tenant_id
              WHERE receipt.tenant_id=s.tenant_id AND receipt.bundle_id=$3 AND receipt.actor_principal_id=$4
                AND receipt.status='accepted' AND canonical.complete AND canonical.deleted_at IS NULL
                AND canonical.id<>s.id AND EXISTS (
                  SELECT 1 FROM official_usage_set_versions m JOIN official_usage_versions v
                    ON v.id=m.version_id AND v.tenant_id=m.tenant_id AND v.kind=m.kind
                  WHERE m.set_id=canonical.id AND m.tenant_id=canonical.tenant_id AND m.kind=$5 AND v.content_hash=$6)
                AND (canonical.expires_at IS NULL OR canonical.expires_at>clock_timestamp())
            )))`, [stage.accepted_set_id, identity.tenantId, stage.bundle_id, identity.principalId, stage.kind, stage.content_hash])).rows[0];
          if (!accepted || receipt && receipt.setId !== stage.accepted_set_id) throw unavailable();
          acceptedBundle = stage.bundle_id as string;
          const activeRevision = stage.accepted_result_revision as string;
          receipt = { setId: stage.accepted_set_id as string,
            activeRevision: receipt && BigInt(receipt.activeRevision) > BigInt(activeRevision) ? receipt.activeRevision : activeRevision,
            complete: accepted.complete as boolean };
          continue;
        }
        if (state.revision !== input.expectedActiveRevision) throw new AppError(409, "active_revision_mismatch", "Active report selection changed.");
        if (!stages.length) {
          const admission = (await client.query(`SELECT count(*)::int AS active,count(*) FILTER(WHERE tenant_id=$1)::int AS tenant
            FROM (
              SELECT tenant_id,'generation:'||id::text AS operation FROM data_generations WHERE state IN ('staging','validating') AND lease_until>clock_timestamp()
              UNION ALL SELECT DISTINCT tenant_id,CASE WHEN state='accepting' THEN 'bundle:'||bundle_id::text ELSE 'file:'||id::text END
                FROM official_usage_ingestions WHERE state IN ('streaming','validating','accepting') AND lease_until>clock_timestamp()
                  AND NOT(state='accepting' AND tenant_id=$1 AND bundle_id=$2)
            ) admitted`, [identity.tenantId, stage.bundle_id])).rows[0];
          if (admission.active >= 4 || admission.tenant >= 2) throw new AppError(429, "upload_admission_full", "Retry after an active ingestion finishes.");
        }
        await client.query(`UPDATE official_usage_ingestions SET state='accepting',acceptance_revision=$2,
          lease_until=LEAST(deadline_at,clock_timestamp()+interval '60 seconds') WHERE id=$1`,
        [stage.ingestion_id, input.expectedActiveRevision]);
        stages.push(stage);
      }
      if (!stages.length) {
        if (!receipt) throw unavailable();
        return { receipt, stages: [] };
      }
      if (receipt?.complete) throw unavailable();
      const kinds = new Set(stages.map(stage => stage.kind));
      if (kinds.size !== stages.length) throw unavailable();
      const first = stages[0];
      let set = (await client.query(`SELECT * FROM official_usage_sets WHERE tenant_id=$1 AND bundle_id=$2 FOR UPDATE`,
        [identity.tenantId, first.bundle_id])).rows[0];
      const companions = set ? (await client.query(`SELECT v.* FROM official_usage_set_versions m JOIN official_usage_versions v ON v.id=m.version_id
        WHERE m.set_id=$1 AND m.tenant_id=$2`, [set.id, identity.tenantId])).rows : [];
      compatible([...stages, ...companions]);
      for (const stage of stages) {
        if (stage.correction_of_set_id && !(await client.query(`SELECT 1 FROM official_usage_sets WHERE id=$1 AND tenant_id=$2
          AND complete AND deleted_at IS NULL AND (expires_at IS NULL OR expires_at>clock_timestamp())
          AND period_provenance=$3 AND ($3='activity_range'
            OR reporting_start IS NOT DISTINCT FROM $4::date AND reporting_end IS NOT DISTINCT FROM $5::date)`,
        [stage.correction_of_set_id, identity.tenantId, stage.period_provenance, stage.reporting_start, stage.reporting_end])).rowCount) {
          throw new AppError(409, "invalid_correction", "Correction reporting window differs or its target is unavailable.");
        }
        if (stage.correction_of_set_id !== first.correction_of_set_id) throw unavailable();
      }
      if (!set && stages.length === 3) {
        const contentHash = digest(JSON.stringify([...stages].sort((a, b) => a.kind.localeCompare(b.kind)).map(stage => [stage.kind, stage.content_hash])));
        const duplicate = await this.duplicate(client, identity.tenantId, contentHash, first.correction_of_set_id);
        if (duplicate) {
          const versions = (await client.query("SELECT kind,version_id FROM official_usage_set_versions WHERE set_id=$1 AND tenant_id=$2 ORDER BY kind",
            [duplicate.id, identity.tenantId])).rows;
          for (const stage of stages) stage.version = versions.find(version => version.kind === stage.kind)!.version_id;
          const result = { setId: duplicate.id, activeRevision: state.revision as string, complete: true };
          await this.recordAcceptance(client, identity, stages, result, bundle ? { ...bundle, expectedRevision: inputs[0].expectedActiveRevision } : undefined);
          return { receipt: result, stages: [], cleanup: stages.map(stage => stage.ingestion_id as string) };
        }
      }
      const counts = (await client.query(`SELECT
        (SELECT count(*) FROM official_usage_sets WHERE tenant_id=$1 AND deleted_at IS NULL)::text AS sets,
        (SELECT count(*) FROM official_usage_versions WHERE tenant_id=$1 AND deleted_at IS NULL)::text AS versions,
        (SELECT COALESCE(sum(row_count),0) FROM official_usage_versions WHERE tenant_id=$1 AND deleted_at IS NULL)::text AS rows`,
      [identity.tenantId])).rows[0];
      if (exactCount(counts.sets) + (set ? 0 : 1) > 5000 || exactCount(counts.versions) + stages.length > 15000
        || exactCount(counts.rows) + stages.reduce((sum, stage) => sum + stage.row_count, 0) > 25000000) throw new AppError(429, "official_usage_history_quota", "Retained report quota exceeded.");
      if (!set) {
        set = (await client.query(`INSERT INTO official_usage_sets(id,tenant_id,bundle_id,actor_principal_id,
          reporting_start,reporting_end,period_provenance,supersedes_set_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [randomUUID(), identity.tenantId, first.bundle_id, identity.principalId, first.reporting_start, first.reporting_end,
          first.period_provenance, first.correction_of_set_id])).rows[0];
      }
      if (set.complete || set.deleted_at || set.actor_principal_id !== identity.principalId || receipt && receipt.setId !== set.id) throw unavailable();
      for (const stage of stages) {
        if (set.supersedes_set_id !== stage.correction_of_set_id) throw unavailable();
        const existing = companions.find(value => value.kind === stage.kind);
        if (existing) throw new AppError(409, "bundle_kind_conflict", "Bundle kind is already accepted.");
        const reusable = (await client.query(`SELECT v.id FROM official_usage_versions v JOIN official_usage_artifacts a
          ON a.id=v.artifact_id AND a.tenant_id=v.tenant_id WHERE v.tenant_id=$1 AND v.kind=$2 AND v.content_hash=$3
          AND v.deleted_at IS NULL AND (LEAST(v.expires_at,a.expires_at) IS NULL OR LEAST(v.expires_at,a.expires_at)>clock_timestamp())
          AND ${completeReportVersionSql("v.id","v.tenant_id","v.kind","v.row_count")}
          ORDER BY v.accepted_at,v.id LIMIT 1`, [identity.tenantId, stage.kind, stage.content_hash])).rows[0];
        const artifact = (await client.query(`INSERT INTO official_usage_artifacts(id,tenant_id,kind,file_hash,parser_version,schema_version)
          VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(tenant_id,kind,file_hash) DO UPDATE SET expires_at=NULL RETURNING id`,
        [randomUUID(), identity.tenantId, stage.kind, stage.file_hash, stage.parser_version, stage.schema_version])).rows[0];
        stage.version = reusable?.id ?? stage.pending_version ?? randomUUID();
        stage.copy = !reusable;
        if (!reusable && !stage.pending_version) await client.query(`INSERT INTO official_usage_versions(id,tenant_id,artifact_id,staging_id,kind,content_hash,
          reporting_start,reporting_end,period_provenance,source_as_of,source_as_of_provenance,source_freshness,downloaded_at,row_count,
          warnings,reconciliation,accepted_by,supersedes_version_id)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,
            (SELECT version_id FROM official_usage_set_versions WHERE set_id=$18 AND tenant_id=$2 AND kind=$5))`,
        [stage.version, identity.tenantId, artifact.id, stage.id, stage.kind, stage.content_hash, stage.reporting_start, stage.reporting_end,
          stage.period_provenance, stage.source_as_of, stage.source_as_of_provenance, stage.source_freshness, stage.downloaded_at, stage.row_count,
          JSON.stringify(stage.warnings), JSON.stringify(stage.reconciliation), identity.principalId, stage.correction_of_set_id]);
        await client.query("UPDATE official_usage_ingestions SET version_id=$2 WHERE id=$1", [stage.ingestion_id, stage.version]);
      }
      return { receipt: null, stages, setId: set.id as string, correctionOf: set.supersedes_set_id as string | null };
    }, false, parent);
    if (prepared.receipt) {
      if ("cleanup" in prepared) for (const id of prepared.cleanup!) await this.cleanupAccepted(id);
      return prepared.receipt;
    }
    const leases = prepared.stages.map(stage => ({ id: stage.ingestion_id as string, owner: stage.owner as string, identity }));
    const heartbeat = generationHeartbeat(() => this.connections.run(async client => {
      for (const lease of leases) {
        await this.fence(client, lease);
        await client.query("UPDATE official_usage_ingestions SET lease_until=LEAST(deadline_at,clock_timestamp()+interval '60 seconds') WHERE id=$1", [lease.id]);
      }
    }, true), parent);
    try {
      for (const [index, stage] of prepared.stages.entries()) {
        if (!stage.copy) continue;
        for (let offset = 0; offset < stage.row_count; offset += 50) {
          await this.connections.run(async client => {
            await this.fence(client, leases[index]);
            await client.query(`INSERT INTO official_usage_row_facts(tenant_id,kind,payload_hash,row_data,first_observed_at,
              identity_key,agent_id,username,agent_name,display_name,creator_type,responses,agents_used,licensed_users,unlicensed_users,last_activity)
              SELECT tenant_id,$3,payload_hash,row_data,clock_timestamp(),
                lower(normalize(trim(row_data->>'username'),NFKC)),row_data->>'agentId',row_data->>'username',
                row_data->>'agentName',row_data->>'displayName',row_data->>'creatorType',
                COALESCE(row_data->>'responsesSentToUsers',row_data->>'agentResponsesReceived')::bigint,
                (row_data->>'numberOfAgentsUsed')::bigint,(row_data->>'activeUsersLicensed')::bigint,
                (row_data->>'activeUsersUnlicensed')::bigint,(row_data->>'lastActivityDateUtc')::date
              FROM official_usage_ingestion_rows WHERE ingestion_id=$1 AND ordinal>=$2 AND ordinal<$2+50
              ON CONFLICT(tenant_id,kind,payload_hash) DO NOTHING`, [leases[index].id, offset, stage.kind]);
            await client.query(`INSERT INTO official_usage_version_rows(version_id,tenant_id,kind,ordinal,payload_hash)
              SELECT $1,tenant_id,$3,ordinal,payload_hash FROM official_usage_ingestion_rows WHERE ingestion_id=$2 AND ordinal>=$4 AND ordinal<$4+50
              ON CONFLICT(version_id,ordinal) DO NOTHING`, [stage.version, leases[index].id, stage.kind, offset]);
          }, false, heartbeat.signal);
        }
      }
      await heartbeat.pause();
      const publicationKind = prepared.stages.reduce((total,stage) => total+stage.row_count,0)>=1000 ? "official-report-large" : "official-report-bounded";
      const result = await measurePublication(publicationKind,() => this.connections.run(async client => {
        await this.authorize(client, identity);
        await this.history.lock(client, identity.tenantId);
        const state = await this.tenant(client, identity.tenantId);
        if (state.revision !== inputs[0].expectedActiveRevision) throw new AppError(409, "active_revision_mismatch", "Active selection changed during validation.");
        if (prepared.correctionOf && !(await client.query(`SELECT 1 FROM official_usage_sets WHERE id=$1 AND tenant_id=$2
          AND complete AND deleted_at IS NULL AND (expires_at IS NULL OR expires_at>clock_timestamp())`,
        [prepared.correctionOf, identity.tenantId])).rowCount) throw new AppError(409, "invalid_correction", "The correction target became unavailable during acceptance.");
        for (const [index, stage] of prepared.stages.entries()) {
          await this.fence(client, leases[index]);
          await client.query("SELECT set_config('jit','off',true)");
          const checked = (await client.query(`SELECT ${completeReportVersionSql("$1","$2","$3","$4")} AS complete`,
            [stage.version, identity.tenantId, stage.kind, stage.row_count])).rows[0];
          if (!checked.complete) throw new Error("official_report_count_mismatch");
          await client.query("INSERT INTO official_usage_set_versions(set_id,tenant_id,kind,version_id) VALUES($1,$2,$3,$4)",
            [prepared.setId, identity.tenantId, stage.kind, stage.version]);
        }
        const versions = (await client.query(`SELECT m.kind,v.content_hash,v.reporting_start::text,v.reporting_end::text FROM official_usage_set_versions m
          JOIN official_usage_versions v ON v.id=m.version_id WHERE m.set_id=$1 AND m.tenant_id=$2 ORDER BY m.kind`, [prepared.setId, identity.tenantId])).rows;
        let setId = prepared.setId!, complete = versions.length === 3;
        let revision = state.revision as string;
        if (complete) {
          const contentHash = digest(JSON.stringify(versions.map(row => [row.kind, row.content_hash])));
          const duplicate = await this.duplicate(client, identity.tenantId, contentHash, prepared.correctionOf);
          if (duplicate) {
            await client.query("UPDATE official_usage_sets SET deleted_at=clock_timestamp() WHERE id=$1", [setId]);
            setId = duplicate.id;
          } else {
            const starts = versions.map(row => row.reporting_start as string | null).filter((value): value is string => value !== null).sort();
            const ends = versions.map(row => row.reporting_end as string | null).filter((value): value is string => value !== null).sort();
            await client.query(`UPDATE official_usage_sets SET complete=true,accepted_at=clock_timestamp(),content_hash=$2,reporting_start=$3,reporting_end=$4
              WHERE id=$1`, [setId, contentHash, starts[0] ?? null, ends.at(-1) ?? null]);
            const historyRevision = await this.history.accepted(client, identity.tenantId, setId, prepared.correctionOf);
            // History survives deletion, so later imports cannot reset the first-report exception.
            const firstReport = historyRevision === "1" && !state.active_set_id;
            const activePeriod = state.active_set_id && !prepared.correctionOf ? (await client.query(
              "SELECT reporting_start::text,reporting_end::text FROM official_usage_sets WHERE tenant_id=$1 AND id=$2",
              [identity.tenantId, state.active_set_id])).rows[0] : undefined;
            const backfill = activePeriod?.reporting_end && (!ends.length
              || `${ends.at(-1)}/${starts[0] ?? ""}` < `${activePeriod.reporting_end}/${activePeriod.reporting_start ?? ""}`);
            if (firstReport || !bundle?.preserveSelection && (!state.active_set_id || prepared.correctionOf === state.active_set_id || !prepared.correctionOf && !backfill)) {
              revision = (await client.query(`UPDATE official_usage_state SET active_set_id=$2,revision=revision+1,updated_at=clock_timestamp()
                WHERE tenant_id=$1 RETURNING revision::text`, [identity.tenantId, setId])).rows[0].revision;
            }
          }
        }
        const result = { setId, activeRevision: revision, complete };
        await this.recordAcceptance(client, identity, prepared.stages, result, bundle ? { ...bundle, expectedRevision: inputs[0].expectedActiveRevision } : undefined);
        return result;
      }, false, heartbeat.signal));
      for (const lease of leases) await this.cleanupAccepted(lease.id);
      return result;
    } catch (error) {
      for (const lease of leases) await this.connections.run(async client => {
        await client.query("UPDATE official_usage_ingestions SET state='ready' WHERE id=$1 AND state='accepting'", [lease.id]);
      });
      throw error;
    } finally { await heartbeat.stop(); }
  }

  async confirmPreview(identity: SelectionIdentity, setId: string, operation: "select" | "delete"): Promise<ReportConfirmation> {
    reportUuid(setId);
    if (!["select", "delete"].includes(operation)) throw new AppError(400, "invalid_operation", "Unsupported operation.");
    await this.history.ensure(identity.tenantId);
    return this.connections.run(async client => {
      await this.authorize(client, identity);
      await this.history.lock(client, identity.tenantId);
      const active = await this.tenant(client, identity.tenantId);
      await this.confirmable(client, identity, setId, operation);
      const history = (await client.query("SELECT revision::text,invalidation_epoch::text FROM official_usage_history_state WHERE tenant_id=$1", [identity.tenantId])).rows[0];
      const result = { id: randomUUID(), setId, operation, activeRevision: active.revision as string,
        historyRevision: history.revision as string, historyEpoch: history.invalidation_epoch as string };
      const hash = digest(JSON.stringify({ ...result, identity }));
      await client.query(`INSERT INTO official_usage_confirmations(id,tenant_id,actor_principal_id,operation,target_set_id,expected_revision,
        confirmation_hash,history_revision,history_epoch) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [result.id, identity.tenantId, identity.principalId, operation, setId, result.activeRevision, hash, result.historyRevision, result.historyEpoch]);
      return { ...result, hash };
    });
  }
  confirm(identity: SelectionIdentity, input: ReportConfirmation) {
    confirmationInput(input, "hash"); reportUuid(input.id); reportUuid(input.setId);
    revision(input.activeRevision); revision(input.historyRevision); revision(input.historyEpoch);
    if (!["select", "delete"].includes(input.operation)) throw new AppError(400, "invalid_operation", "Unsupported operation.");
    const { hash: _hash, ...intent } = input;
    if (digest(JSON.stringify({ id: intent.id, setId: intent.setId, operation: intent.operation, activeRevision: intent.activeRevision,
      historyRevision: intent.historyRevision, historyEpoch: intent.historyEpoch, identity })) !== input.hash) throw new AppError(409, "confirmation_mismatch", "The confirmation belongs to another authorization epoch.");
    return this.connections.run(async client => {
      await this.authorize(client, identity);
      await this.history.lock(client, identity.tenantId);
      const active = await this.tenant(client, identity.tenantId);
      const valid = (await client.query(`SELECT c.id FROM official_usage_confirmations c JOIN official_usage_history_state h ON h.tenant_id=c.tenant_id
        WHERE c.id=$1 AND c.tenant_id=$2 AND c.actor_principal_id=$3 AND c.operation=$4 AND c.target_set_id=$5 AND c.expected_revision=$6
          AND c.confirmation_hash=$7 AND c.history_revision=$8 AND c.history_epoch=$9 AND c.history_revision=h.revision
          AND c.history_epoch=h.invalidation_epoch AND c.expires_at>clock_timestamp() AND c.consumed_at IS NULL FOR UPDATE OF c`,
      [input.id, identity.tenantId, identity.principalId, input.operation, input.setId, input.activeRevision, input.hash, input.historyRevision, input.historyEpoch])).rowCount;
      if (!valid || active.revision !== input.activeRevision) throw new AppError(409, "confirmation_mismatch", "Review a new immutable confirmation.");
      await this.confirmable(client, identity, input.setId, input.operation);
      if (input.operation === "delete") {
        await this.history.invalidate(client, identity.tenantId, input.setId, true);
        await client.query("UPDATE official_usage_sets SET deleted_at=clock_timestamp() WHERE id=$1 AND tenant_id=$2", [input.setId, identity.tenantId]);
        await retireUnreferencedReportVersions(client, identity.tenantId, input.setId);
        await retainDeletedReportRows(client, 250, { tenantId: identity.tenantId, setId: input.setId });
        if (active.active_set_id === input.setId) await client.query(`UPDATE official_usage_state SET active_set_id=NULL,revision=revision+1,updated_at=clock_timestamp() WHERE tenant_id=$1`, [identity.tenantId]);
      } else await client.query(`UPDATE official_usage_state SET active_set_id=$2,revision=revision+1,updated_at=clock_timestamp() WHERE tenant_id=$1`, [identity.tenantId, input.setId]);
      await client.query("UPDATE official_usage_confirmations SET consumed_at=clock_timestamp() WHERE id=$1", [input.id]);
      await this.audit(client, identity, input.operation === "delete" ? "deleted" : "selected", null, input.setId, null);
      return (await client.query(`SELECT active_set_id AS "activeSetId",revision::text AS "activeRevision" FROM official_usage_state WHERE tenant_id=$1`, [identity.tenantId])).rows[0];
    });
  }

  private async confirmable(client: pg.PoolClient, identity: SelectionIdentity, setId: string, operation: "select" | "delete") {
    await client.query("SELECT set_config('jit','off',true)");
    const valid = await client.query(`SELECT 1 FROM official_usage_sets s WHERE s.id=$1 AND s.tenant_id=$2 AND s.deleted_at IS NULL
      AND ($3='delete' OR (s.complete AND (s.expires_at IS NULL OR s.expires_at>clock_timestamp())
        AND EXISTS(SELECT 1 FROM official_usage_history_memberships m WHERE m.tenant_id=s.tenant_id AND m.set_id=s.id AND m.valid_to_revision IS NULL)
        AND 3=(SELECT count(*) FROM official_usage_set_versions sv JOIN official_usage_versions v ON v.id=sv.version_id AND v.tenant_id=sv.tenant_id
          JOIN official_usage_artifacts a ON a.id=v.artifact_id AND a.tenant_id=v.tenant_id
          WHERE sv.set_id=s.id AND sv.tenant_id=s.tenant_id AND v.deleted_at IS NULL
            AND (LEAST(v.expires_at,a.expires_at) IS NULL OR LEAST(v.expires_at,a.expires_at)>clock_timestamp())
            AND ${completeReportVersionSql("v.id","v.tenant_id","v.kind","v.row_count")}) ))`, [setId, identity.tenantId, operation]);
    if (!valid.rowCount) throw unavailable();
  }

  async cancel(identity: SelectionIdentity, ingestionId: string) {
    await this.connections.run(async client => {
      const row = (await client.query(`UPDATE official_usage_ingestions SET state='cancelled'
        WHERE id=$1 AND tenant_id=$2 AND principal_id=$3 AND state IN ('streaming','validating','ready','accepting') RETURNING staging_id,kind,row_count`,
      [ingestionId, identity.tenantId, identity.principalId])).rows[0];
      if (row?.staging_id) await client.query("UPDATE official_usage_staging SET status='cancelled' WHERE id=$1 AND status='active'", [row.staging_id]);
      if (row) await client.query(`INSERT INTO official_usage_audit(id,tenant_id,actor_principal_id,action,target_kind,target_id,row_count,outcome,error_code)
        VALUES($1,$2,$3,'discarded',$4,$5,$6,'rejected','upload_cancelled')`,
      [randomUUID(), identity.tenantId, identity.principalId, row.kind, row.staging_id ?? ingestionId, row.row_count]);
    });
    await this.cleanupIngestion(ingestionId);
  }
  async sweep(tenantId?: string) {
    const rows = (await this.database.query(`SELECT id,tenant_id,principal_id,session_epoch::text FROM official_usage_ingestions
      WHERE ($1::text IS NULL OR tenant_id=$1) AND
        ((stored_bytes>0 AND state IN ('cancelled','failed','accepted'))
          OR state IN ('streaming','validating','ready','accepting') AND expires_at<=clock_timestamp()
          OR state IN ('streaming','validating','accepting') AND lease_until<=clock_timestamp())
      ORDER BY expires_at,id LIMIT 1`, [tenantId ?? null])).rows;
    for (const row of rows) {
      await this.cancel({ tenantId: row.tenant_id, principalId: row.principal_id, sessionEpoch: row.session_epoch, authorizationHash: "" }, row.id);
    }
    return rows.length;
  }
  async discard(identity: SelectionIdentity, stagingId: string) {
    const ingestionId = await this.connections.run(async client => {
      await this.authorize(client, identity);
      const row = (await client.query(`SELECT i.id,s.kind,s.row_count FROM official_usage_ingestions i
        JOIN official_usage_staging s ON s.id=i.staging_id WHERE s.id=$1 AND i.tenant_id=$2 AND i.principal_id=$3
        AND s.status='active' AND i.state='ready' AND i.session_epoch=$4 FOR UPDATE OF s,i`,
      [stagingId, identity.tenantId, identity.principalId, identity.sessionEpoch])).rows[0];
      if (!row) throw unavailable();
      await client.query("UPDATE official_usage_ingestions SET state='cancelled' WHERE id=$1", [row.id]);
      await client.query("UPDATE official_usage_staging SET status='cancelled' WHERE id=$1", [stagingId]);
      await this.audit(client, identity, "discarded", row.kind, stagingId, row.row_count);
      return row.id as string;
    });
    await this.cleanupIngestion(ingestionId);
  }
  diagnostics(identity: SelectionIdentity, stagingId: string, options: { limit?: number; cursor?: string }, codec: CursorCodec) {
    const limit = options.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new AppError(400, "invalid_cursor", "Diagnostics page limit must be 1..100.");
    return this.connections.selectedRead(async client => {
      await this.authorize(client, identity);
      const stage = (await client.query(`SELECT s.* FROM official_usage_staging s JOIN official_usage_ingestions i ON i.staging_id=s.id
        WHERE s.id=$1 AND s.tenant_id=$2 AND s.actor_principal_id=$3 AND s.status='active' AND i.state='ready'
          AND s.expires_at>clock_timestamp() AND i.session_epoch=$4 AND i.expires_at>clock_timestamp()`,
      [stagingId, identity.tenantId, identity.principalId, identity.sessionEpoch])).rows[0];
      if (!stage) throw unavailable();
      const expected = { identity, endpoint: "/official-usage/staging/diagnostics", selectionId: stage.id,
        revision: String(stage.revision), queryHash: digest(stage.content_hash) };
      const cursor = options.cursor ? codec.decode(options.cursor, expected) : undefined, previous = cursor?.direction === "previous";
      const values: unknown[] = [identity.tenantId, identity.principalId, stage.bundle_id, stage.id, identity.sessionEpoch];
      const sql = `WITH companions AS (
        SELECT s.kind,r.row_data FROM official_usage_staging s JOIN official_usage_staged_rows r ON r.staging_id=s.id
          JOIN official_usage_ingestions i ON i.staging_id=s.id AND i.state='ready'
          WHERE s.tenant_id=$1 AND s.actor_principal_id=$2 AND s.bundle_id=$3 AND s.status='active'
            AND i.session_epoch=$5 AND LEAST(i.expires_at,s.expires_at)>clock_timestamp()
        UNION ALL
        SELECT f.kind,f.row_data FROM official_usage_sets s JOIN official_usage_set_versions m ON m.set_id=s.id
          JOIN official_usage_version_rows r ON r.version_id=m.version_id JOIN official_usage_row_facts f
            ON f.tenant_id=r.tenant_id AND f.kind=r.kind AND f.payload_hash=r.payload_hash
          WHERE s.tenant_id=$1 AND s.actor_principal_id=$2 AND s.bundle_id=$3 AND s.deleted_at IS NULL
      ), diagnostics AS (
        SELECT r.ordinal,r.row_data->>'agentId' AS agent_id,r.row_data->>'username' AS username,
          CASE WHEN s.kind='users' AND EXISTS(SELECT 1 FROM companions c WHERE c.kind='userAgents' AND c.row_data->>'username'=r.row_data->>'username')
            AND ((r.row_data->>'agentResponsesReceived')::numeric<>(SELECT sum((c.row_data->>'responsesSentToUsers')::numeric) FROM companions c
              WHERE c.kind='userAgents' AND c.row_data->>'username'=r.row_data->>'username')
            OR (r.row_data->>'numberOfAgentsUsed')::numeric<>(SELECT count(*) FROM companions c WHERE c.kind='userAgents' AND c.row_data->>'username'=r.row_data->>'username'))
            THEN 'users_bridge_mismatch'
          WHEN s.kind='agents' AND EXISTS(SELECT 1 FROM companions c WHERE c.kind='userAgents' AND c.row_data->>'agentId'=r.row_data->>'agentId')
            AND (r.row_data->>'responsesSentToUsers')::numeric<>(SELECT sum((c.row_data->>'responsesSentToUsers')::numeric) FROM companions c
              WHERE c.kind='userAgents' AND c.row_data->>'agentId'=r.row_data->>'agentId') THEN 'agent_bridge_mismatch'
          WHEN s.kind='userAgents' AND NOT EXISTS(SELECT 1 FROM companions c WHERE c.kind='users' AND c.row_data->>'username'=r.row_data->>'username')
            THEN 'missing_user_report' ELSE NULL END AS code
        FROM official_usage_staged_rows r JOIN official_usage_staging s ON s.id=r.staging_id WHERE r.staging_id=$4
      )`;
      const count = exactCount((await client.query(`${sql} SELECT count(*)::text AS n FROM diagnostics WHERE code IS NOT NULL`, values)).rows[0].n);
      values.push(cursor ? Number(cursor.boundary.id) : previous ? 1000000 : -1, limit + 1);
      const rows = (await client.query(`${sql} SELECT ordinal,agent_id,username,code FROM diagnostics WHERE code IS NOT NULL AND ordinal ${previous ? "<" : ">"} $6
        ORDER BY ordinal ${previous ? "DESC" : "ASC"} LIMIT $7`, values)).rows;
      const more = rows.length > limit, page = rows.slice(0, limit);
      if (previous) page.reverse();
      const encode = (row: pg.QueryResultRow, direction: "next" | "previous") => codec.encode({ ...expected, direction,
        boundary: { key: String(row.ordinal), id: String(row.ordinal), nullRank: 0 } });
      return { value: page.map(row => ({ ordinal: row.ordinal as number, agentId: row.agent_id as string | null, username: row.username as string | null,
        code: row.code as "users_bridge_mismatch" | "agent_bridge_mismatch" | "missing_user_report" })),
      counts: { total: count, filtered: count }, preview: { id: stage.id as string, revision: stage.revision as number, contentHash: stage.content_hash as string },
      page: { limit, nextCursor: page.length && (previous ? Boolean(cursor) : more) ? encode(page.at(-1)!, "next") : null,
        previousCursor: page.length && (previous ? more : Boolean(cursor)) ? encode(page[0], "previous") : null } };
    });
  }
  private async cleanupAccepted(id: string) {
    try { await this.cleanupIngestion(id); }
    catch {
      // The acceptance receipt is durable. Background retention resumes cleanup.
      operationalLog("warn","official_report_staging_cleanup_deferred",{ errorCode: "post_commit_cleanup_failed",count: 1 });
    }
  }
  async cleanupIngestion(id: string) {
    return this.connections.run(async client => {
        const slice = new LifecycleSlice(client, 25, "report_staging");
        await slice.open();
        const parent = (await client.query(`SELECT staging_id FROM official_usage_ingestions WHERE id=$1
          AND (state IN ('cancelled','failed','accepted') OR expires_at<=clock_timestamp())`, [id])).rows[0];
        if (!parent) return 0;
        const rows = await slice.change("ingestion", "official_usage_ingestion_rows", "target.ingestion_id=$3", undefined, [id],"ordinal");
        const staged = await slice.change("staging", "official_usage_staged_rows", "target.staging_id=$3", undefined, [parent.staging_id],"ordinal");
        await slice.change("reservation", "official_usage_ingestions", `target.id=$3 AND target.stored_bytes<>0
          AND ${emptyReportStaging("target")}`,
        "stored_bytes=0", [id]);
        await slice.finish();
        return rows + staged;
      });
  }
  private async audit(client: pg.PoolClient, identity: SelectionIdentity, action: "staged" | "accepted" | "selected" | "deleted" | "discarded", kind: OfficialUsageReportKind | null, id: string, rows: number | null) {
    await client.query(`INSERT INTO official_usage_audit(id,tenant_id,actor_principal_id,action,target_kind,target_id,row_count,outcome)
      VALUES($1,$2,$3,$4,$5,$6,$7,'succeeded')`, [randomUUID(), identity.tenantId, identity.principalId, action, kind, id, rows]);
  }
}
