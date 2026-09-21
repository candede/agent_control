import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";
import { AppError } from "../errors.js";
import {
  automaticDataSyncSourceIds,
  dataSyncSourceIds,
  type DataSyncMode,
  type DataSyncRun,
  type DataSyncSourceId,
  type DataSyncSourceState,
  type DataSyncSourceStatus,
  type StartDataSyncInput,
} from "../types/dataSync.js";
import type { CopilotDirectoryUser, CopilotReportResult } from "../services/copilotUsageGraph.js";
import { isCopilotServiceSummaryState } from "../types/copilotUsage.js";
import { pool, transaction } from "./pool.js";

export type DataSyncScope = { tenantId: string; principalId: string };
export type CopilotUsageSnapshotSource = "directory" | "app_activity";
export type CopilotUsageAttemptStatus = "available" | "waiting_authorization" | "permission_required" | "failed";
export type UserSourcePublication = { runId: string; jobId: string };

export type SavedCopilotUsageSource<T> = {
  source: CopilotUsageSnapshotSource;
  attemptStatus: CopilotUsageAttemptStatus | null;
  message: string | null;
  attemptedAt: string | null;
  lastSuccessAt: string | null;
  rowCount: number | null;
  observedAt: string | null;
  value: T | null;
};

type CopilotDirectorySnapshot = {
  serviceEvidenceVersion: 1;
  users: readonly CopilotDirectoryUser[];
};

type RunRow = {
  id: string;
  mode: DataSyncMode;
  status: DataSyncRun["status"];
  started_at: Date;
  updated_at: Date;
  completed_at: Date | null;
};

type SourceRow = {
  run_id: string;
  source_id: DataSyncSourceId;
  status: DataSyncSourceState;
  job_id: string | null;
  attempt: number;
  count: number | null;
  last_success_at: Date | null;
  updated_at: Date;
  message: string;
  can_retry: boolean;
};

type MarkerRow = {
  source_id: DataSyncSourceId;
  count: number | null;
  last_success_at: Date;
  updated_at: Date;
};

type SavedSourceRow = {
  source_id: CopilotUsageSnapshotSource;
  attempt_status: CopilotUsageAttemptStatus | null;
  message: string | null;
  attempted_at: Date | null;
  last_success_at: Date | null;
  row_count: number | null;
  observed_at: Date | null;
  snapshot_data: unknown;
};

type SourceUpdate = {
  status: Exclude<DataSyncSourceState, "not_started">;
  jobId?: string | null;
  count?: number | null;
  lastSuccessAt?: string | null;
  message: string;
  canRetry: boolean;
};

const retryableSourceStates = new Set<DataSyncSourceState>([
  "waiting_authorization", "permission_required", "partial", "failed", "cancelled",
]);

export class DataSyncRepository {
  constructor(private readonly database: pg.Pool = pool) {}

  async submit(scope: DataSyncScope, input: StartDataSyncInput): Promise<{ run: DataSyncRun; created: boolean }> {
    validateScope(scope);
    if (input.clearSavedData !== undefined && typeof input.clearSavedData !== "boolean") {
      throw new AppError(400, "invalid_data_sync_cleanup", "clearSavedData must be a boolean.");
    }
    if (input.clearSavedData === true && (input.mode !== "full" || input.sources !== undefined)) {
      throw new AppError(400, "invalid_data_sync_cleanup", "Clearing saved data requires mode full with all sources; omit sources.");
    }
    const sources = normalizeSources(input.mode, input.sources);
    const requestHash = hash({ mode: input.mode, sources, ...(input.clearSavedData ? { clearSavedData: true } : {}) });
    const result = await transaction(this.database, async client => {
      await lockScope(client, scope);
      const active = await client.query<RunRow>(`SELECT id,mode,status,started_at,updated_at,completed_at
        FROM data_sync_runs
        WHERE tenant_id=$1 AND principal_id=$2 AND status IN ('running','waiting') AND expires_at>clock_timestamp()
        ORDER BY started_at DESC,id DESC LIMIT 1 FOR UPDATE`, [scope.tenantId, scope.principalId]);
      if (active.rows[0]) {
        const existingHash = await client.query<{ request_hash: string }>(
          "SELECT request_hash FROM data_sync_runs WHERE id=$1",
          [active.rows[0].id],
        );
        if (existingHash.rows[0].request_hash !== requestHash) {
          throw new AppError(409, "data_sync_active", "A different data sync run is already active for this account.");
        }
        return { id: active.rows[0].id, created: false };
      }
      const recent = await client.query<{ count: number }>(`SELECT count(*)::int AS count FROM data_sync_runs
        WHERE tenant_id=$1 AND principal_id=$2 AND started_at>clock_timestamp()-interval '1 hour'`,
      [scope.tenantId, scope.principalId]);
      if (recent.rows[0].count >= 20) {
        throw new AppError(429, "data_sync_admission_full", "At most twenty data sync runs may be started per account each hour.");
      }
      const id = randomUUID();
      await client.query(`INSERT INTO data_sync_runs(id,tenant_id,principal_id,mode,source_ids,request_hash,clear_saved_data)
        VALUES($1,$2,$3,$4,$5::jsonb,$6,$7)`,
      [id, scope.tenantId, scope.principalId, input.mode, JSON.stringify(sources), requestHash, input.clearSavedData ?? false]);
      await client.query(`INSERT INTO data_sync_run_sources(
          run_id,tenant_id,principal_id,source_id,status,count,last_success_at,message,can_retry)
        SELECT $1,$2,$3,requested.source_id,'queued',NULL,marker.last_success_at,
          'Waiting for the durable sync worker.',false
        FROM jsonb_array_elements_text($4::jsonb) AS requested(source_id)
        LEFT JOIN data_sync_success_markers marker
          ON marker.tenant_id=$2 AND marker.principal_id=$3 AND marker.source_id=requested.source_id`,
      [id, scope.tenantId, scope.principalId, JSON.stringify(sources)]);
      return { id, created: true };
    }).catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "PDS01") {
        throw new AppError(409, "data_sync_source_active", "Finish or cancel active Graph package and Power Platform refresh jobs before clearing saved data.");
      }
      throw error;
    });
    return { run: (await this.getRun(scope, result.id))!, created: result.created };
  }

  async getRun(scope: DataSyncScope, id: string): Promise<DataSyncRun | undefined> {
    validateScope(scope);
    const run = await this.database.query<RunRow>(`SELECT id,mode,status,started_at,updated_at,completed_at
      FROM data_sync_runs WHERE id=$1 AND tenant_id=$2 AND principal_id=$3 AND expires_at>clock_timestamp()`,
    [id, scope.tenantId, scope.principalId]);
    if (!run.rows[0]) return undefined;
    const sources = await this.database.query<SourceRow>(`SELECT run_id,source_id,status,job_id,attempt,count,last_success_at,updated_at,message,can_retry
      FROM data_sync_run_sources WHERE run_id=$1 AND tenant_id=$2 AND principal_id=$3 ORDER BY source_id`,
    [id, scope.tenantId, scope.principalId]);
    return projectRun(run.rows[0], sources.rows);
  }

  async getLatestRun(scope: DataSyncScope): Promise<DataSyncRun | undefined> {
    validateScope(scope);
    // Retrying a retained run updates its activity, not its original start time.
    const result = await this.database.query<{ id: string }>(`SELECT id FROM data_sync_runs
      WHERE tenant_id=$1 AND principal_id=$2 AND expires_at>clock_timestamp()
      ORDER BY updated_at DESC,started_at DESC,id DESC LIMIT 1`, [scope.tenantId, scope.principalId]);
    return result.rows[0] ? this.getRun(scope, result.rows[0].id) : undefined;
  }

  async listRuns(scope: DataSyncScope, limit = 20): Promise<DataSyncRun[]> {
    validateScope(scope);
    const boundedLimit = boundedRunLimit(limit);
    const runs = await this.database.query<RunRow>(`SELECT id,mode,status,started_at,updated_at,completed_at
      FROM data_sync_runs
      WHERE tenant_id=$1 AND principal_id=$2 AND expires_at>clock_timestamp()
      ORDER BY started_at DESC,id DESC LIMIT $3`, [scope.tenantId, scope.principalId, boundedLimit]);
    if (!runs.rows.length) return [];
    const sources = await this.database.query<SourceRow>(`SELECT run_id,source_id,status,job_id,attempt,count,last_success_at,updated_at,message,can_retry
      FROM data_sync_run_sources
      WHERE tenant_id=$1 AND principal_id=$2 AND run_id=ANY($3::uuid[])
      ORDER BY run_id,source_id`, [scope.tenantId, scope.principalId, runs.rows.map(run => run.id)]);
    const byRun = new Map<string, SourceRow[]>();
    for (const source of sources.rows) {
      const values = byRun.get(source.run_id) ?? [];
      values.push(source);
      byRun.set(source.run_id, values);
    }
    return runs.rows.map(run => projectRun(run, byRun.get(run.id) ?? []));
  }

  async getSourceAttempt(scope: DataSyncScope, runId: string, sourceId: DataSyncSourceId) {
    validateScope(scope);
    const result = await this.database.query<{ attempt: number }>(`SELECT attempt FROM data_sync_run_sources
      WHERE run_id=$1 AND tenant_id=$2 AND principal_id=$3 AND source_id=$4`,
    [runId, scope.tenantId, scope.principalId, sourceId]);
    if (!result.rows[0]) throw new AppError(404, "not_found", "Data sync source was not found.");
    return result.rows[0].attempt;
  }

  async listMarkers(scope: DataSyncScope): Promise<DataSyncSourceStatus[]> {
    validateScope(scope);
    const result = await this.database.query<MarkerRow>(`SELECT source_id,count,last_success_at,updated_at
      FROM data_sync_success_markers WHERE tenant_id=$1 AND principal_id=$2`, [scope.tenantId, scope.principalId]);
    const markers = new Map(result.rows.map(row => [row.source_id, row]));
    return dataSyncSourceIds.map(sourceId => {
      const marker = markers.get(sourceId);
      return marker ? {
        source: sourceId,
        status: "succeeded",
        jobId: null,
        count: marker.count,
        lastSuccessAt: marker.last_success_at.toISOString(),
        updatedAt: marker.updated_at.toISOString(),
        message: successfulMarkerMessage(sourceId, marker.count),
        canRetry: false,
      } : notStarted(sourceId);
    });
  }

  async attachJob(scope: DataSyncScope, runId: string, sourceId: Exclude<DataSyncSourceId, "usage_reports">, jobId: string) {
    validateScope(scope);
    validateUuid(jobId, "source job ID");
    await transaction(this.database, async client => {
      await lockScope(client, scope);
      const source = await client.query<{ attempt: number }>(`SELECT attempt FROM data_sync_run_sources
        WHERE run_id=$1 AND tenant_id=$2 AND principal_id=$3 AND source_id=$4
          AND status IN ('queued','running','waiting_authorization') FOR UPDATE`,
      [runId, scope.tenantId, scope.principalId, sourceId]);
      if (!source.rows[0]) throw new AppError(409, "data_sync_source_state", "The data sync source is no longer awaiting a child job.");
      await client.query(`INSERT INTO data_sync_source_jobs(run_id,tenant_id,principal_id,source_id,attempt,job_id)
        VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT (run_id,source_id,attempt) DO NOTHING`,
      [runId, scope.tenantId, scope.principalId, sourceId, source.rows[0].attempt, jobId]);
      const updated = await client.query(`UPDATE data_sync_run_sources SET job_id=$5,updated_at=clock_timestamp()
        WHERE run_id=$1 AND tenant_id=$2 AND principal_id=$3 AND source_id=$4
          AND (job_id IS NULL OR job_id=$5)`, [runId, scope.tenantId, scope.principalId, sourceId, jobId]);
      if (updated.rowCount !== 1) throw new AppError(409, "data_sync_source_job_conflict", "The data sync source already has a different child job.");
    });
  }

  async updateSource(scope: DataSyncScope, runId: string, sourceId: DataSyncSourceId, update: SourceUpdate) {
    validateScope(scope);
    if (update.message.length < 1 || update.message.length > 1024) throw new AppError(500, "invalid_data_sync_message", "Data sync source status message is invalid.");
    if (update.count !== undefined && update.count !== null && (!Number.isSafeInteger(update.count) || update.count < 0)) {
      throw new AppError(500, "invalid_data_sync_count", "Data sync source count is invalid.");
    }
    if (update.jobId) validateUuid(update.jobId, "source job ID");
    await transaction(this.database, async client => {
      await lockScope(client, scope);
      const result = await client.query<SourceRow>(`UPDATE data_sync_run_sources source SET
          status=$5,
          job_id=COALESCE($6::uuid,source.job_id),
          count=CASE WHEN $7::boolean THEN $8::integer ELSE source.count END,
          last_success_at=CASE
            WHEN $5='succeeded' THEN COALESCE($9::timestamptz,clock_timestamp())
            ELSE source.last_success_at
          END,
          updated_at=clock_timestamp(),
          message=$10,
          can_retry=$11
        FROM data_sync_runs run
        WHERE source.run_id=$1 AND source.tenant_id=$2 AND source.principal_id=$3 AND source.source_id=$4
          AND run.id=source.run_id AND run.tenant_id=source.tenant_id AND run.principal_id=source.principal_id
          AND run.status IN ('running','waiting')
          AND source.status<>'succeeded'
          AND ($6::uuid IS NULL OR source.job_id IS NULL OR source.job_id=$6::uuid)
          AND NOT EXISTS (
            SELECT 1 FROM data_sync_source_jobs previous
            WHERE previous.run_id=source.run_id AND previous.source_id=source.source_id
              AND previous.job_id=$6::uuid AND previous.attempt<>source.attempt)
        RETURNING source.*`,
      [
        runId, scope.tenantId, scope.principalId, sourceId, update.status, update.jobId ?? null,
        update.count !== undefined, update.count ?? null, update.lastSuccessAt ?? null,
        update.message, update.canRetry,
      ]);
      if (!result.rows[0]) return;
      if (update.status === "succeeded") {
        await client.query(`INSERT INTO data_sync_success_markers(
            tenant_id,principal_id,source_id,count,last_success_at)
          VALUES($1,$2,$3,$4,$5)
          ON CONFLICT (tenant_id,principal_id,source_id) DO UPDATE SET
            count=EXCLUDED.count,last_success_at=EXCLUDED.last_success_at,updated_at=clock_timestamp()`,
        [
          scope.tenantId, scope.principalId, sourceId, result.rows[0].count,
          result.rows[0].last_success_at,
        ]);
      }
      await finalizeRun(client, scope, runId);
    });
    return this.getRun(scope, runId);
  }

  async recordSuccessMarker(scope: DataSyncScope, sourceId: DataSyncSourceId, count: number | null, lastSuccessAt: string) {
    validateScope(scope);
    if (count !== null && (!Number.isSafeInteger(count) || count < 0)) throw new AppError(500, "invalid_data_sync_count", "Data sync source count is invalid.");
    await this.database.query(`INSERT INTO data_sync_success_markers(
        tenant_id,principal_id,source_id,count,last_success_at)
      VALUES($1,$2,$3,$4,$5)
      ON CONFLICT (tenant_id,principal_id,source_id) DO UPDATE SET
        count=EXCLUDED.count,last_success_at=EXCLUDED.last_success_at,updated_at=clock_timestamp()
      WHERE data_sync_success_markers.count IS DISTINCT FROM EXCLUDED.count
        OR data_sync_success_markers.last_success_at IS DISTINCT FROM EXCLUDED.last_success_at`,
    [scope.tenantId, scope.principalId, sourceId, count, lastSuccessAt]);
  }

  async retry(scope: DataSyncScope, id: string, requestedSources?: readonly DataSyncSourceId[]) {
    validateScope(scope);
    return transaction(this.database, async client => {
      await lockScope(client, scope);
      const run = await client.query<RunRow>(`SELECT id,mode,status,started_at,updated_at,completed_at
        FROM data_sync_runs WHERE id=$1 AND tenant_id=$2 AND principal_id=$3
          AND expires_at>clock_timestamp() FOR UPDATE`, [id, scope.tenantId, scope.principalId]);
      if (!run.rows[0]) throw new AppError(404, "not_found", "Data sync run was not found.");
      const active = await client.query<{ id: string }>(`SELECT id FROM data_sync_runs
        WHERE tenant_id=$1 AND principal_id=$2 AND id<>$3 AND status IN ('running','waiting')
          AND expires_at>clock_timestamp() LIMIT 1`, [scope.tenantId, scope.principalId, id]);
      if (active.rows[0]) throw new AppError(409, "data_sync_active", "Another data sync run is already active for this account.");
      const rows = await client.query<SourceRow>(`SELECT * FROM data_sync_run_sources
        WHERE run_id=$1 AND tenant_id=$2 AND principal_id=$3 FOR UPDATE`, [id, scope.tenantId, scope.principalId]);
      const available = rows.rows.filter(row => retryableSourceStates.has(row.status)).map(row => row.source_id);
      const selected = requestedSources === undefined ? available : normalizeRetrySources(requestedSources);
      if (!selected.length) throw new AppError(409, "data_sync_nothing_to_retry", "This data sync run has no incomplete sources to retry.");
      if (selected.some(source => !available.includes(source))) {
        throw new AppError(409, "data_sync_source_complete", "Only incomplete data sync sources can be retried.");
      }
      const reset = await client.query(`UPDATE data_sync_run_sources SET
          status='queued',job_id=NULL,count=NULL,attempt=attempt+1,updated_at=clock_timestamp(),
          message='Waiting for the durable sync worker.',can_retry=false
        WHERE run_id=$1 AND tenant_id=$2 AND principal_id=$3 AND source_id=ANY($4::text[])
          AND attempt<20`, [id, scope.tenantId, scope.principalId, selected]);
      if (reset.rowCount !== selected.length) throw new AppError(409, "data_sync_retry_limit", "A data sync source reached its retry limit.");
      await client.query(`UPDATE data_sync_runs SET status='running',completed_at=NULL,updated_at=clock_timestamp()
        WHERE id=$1 AND tenant_id=$2 AND principal_id=$3`, [id, scope.tenantId, scope.principalId]);
      return selected;
    });
  }

  async cancel(scope: DataSyncScope, id: string) {
    validateScope(scope);
    await transaction(this.database, async client => {
      await lockScope(client, scope);
      const run = await client.query(`UPDATE data_sync_runs SET status='cancelled',completed_at=clock_timestamp(),updated_at=clock_timestamp()
        WHERE id=$1 AND tenant_id=$2 AND principal_id=$3 AND status IN ('running','waiting')
          AND expires_at>clock_timestamp() RETURNING id`, [id, scope.tenantId, scope.principalId]);
      if (!run.rows[0]) {
        const exists = await client.query("SELECT 1 FROM data_sync_runs WHERE id=$1 AND tenant_id=$2 AND principal_id=$3 AND expires_at>clock_timestamp()", [id, scope.tenantId, scope.principalId]);
        if (!exists.rows[0]) throw new AppError(404, "not_found", "Data sync run was not found.");
        throw new AppError(409, "data_sync_run_state", "Only an active data sync run can be cancelled.");
      }
      await client.query(`UPDATE data_sync_run_sources SET status='cancelled',
          message='Cancelled by the requesting principal.',can_retry=true,updated_at=clock_timestamp()
        WHERE run_id=$1 AND tenant_id=$2 AND principal_id=$3 AND status<>'succeeded'`,
      [id, scope.tenantId, scope.principalId]);
    });
    return (await this.getRun(scope, id))!;
  }

  async pausePrincipal(scope: DataSyncScope, message = "Explicit resume with current authorization is required.") {
    validateScope(scope);
    const result = await transaction(this.database, async client => {
      await lockScope(client, scope);
      const sources = await client.query(`UPDATE data_sync_run_sources source SET
          status='waiting_authorization',message=$3,can_retry=true,updated_at=clock_timestamp()
        FROM data_sync_runs run
        WHERE source.run_id=run.id AND source.tenant_id=$1 AND source.principal_id=$2
          AND run.tenant_id=$1 AND run.principal_id=$2 AND run.status IN ('running','waiting')
          AND source.source_id<>'usage_reports' AND source.status IN ('queued','running')
        RETURNING source.run_id`, [scope.tenantId, scope.principalId, message]);
      await client.query(`UPDATE data_sync_runs SET status='waiting',updated_at=clock_timestamp()
        WHERE tenant_id=$1 AND principal_id=$2 AND status IN ('running','waiting')
          AND EXISTS (SELECT 1 FROM data_sync_run_sources source
            WHERE source.run_id=data_sync_runs.id AND source.status='waiting_authorization')`,
      [scope.tenantId, scope.principalId]);
      return sources.rowCount ?? 0;
    });
    return result;
  }

  async recoverInterrupted() {
    const sources = await this.database.query(`WITH candidates AS (
        SELECT source.run_id,source.source_id
        FROM data_sync_run_sources source JOIN data_sync_runs run ON run.id=source.run_id
        WHERE run.status IN ('running','waiting') AND run.expires_at>clock_timestamp()
          AND source.source_id<>'usage_reports' AND source.status IN ('queued','running')
        ORDER BY source.updated_at,source.run_id,source.source_id LIMIT 1000
        FOR UPDATE OF source SKIP LOCKED)
      UPDATE data_sync_run_sources source SET status='waiting_authorization',
        message='Application restart requires explicit resume with current authorization.',
        can_retry=true,updated_at=clock_timestamp()
      FROM candidates WHERE source.run_id=candidates.run_id AND source.source_id=candidates.source_id`);
    await this.database.query(`UPDATE data_sync_runs run SET status='waiting',updated_at=clock_timestamp()
      WHERE status IN ('running','waiting') AND expires_at>clock_timestamp()
        AND EXISTS (SELECT 1 FROM data_sync_run_sources source
          WHERE source.run_id=run.id AND source.status IN ('waiting_authorization','permission_required','awaiting_upload'))`);
    return sources.rowCount ?? 0;
  }

  async publishDirectory(scope: DataSyncScope, value: readonly CopilotDirectoryUser[], observedAt: string, message: string, publication?: UserSourcePublication) {
    return this.publishUserSource(scope, "directory", { serviceEvidenceVersion: 1, users: value }, value.length, observedAt, message, publication);
  }

  async publishAppActivity(scope: DataSyncScope, value: CopilotReportResult, observedAt: string, message: string, publication?: UserSourcePublication) {
    return this.publishUserSource(scope, "app_activity", value, value.users.length, observedAt, message, publication);
  }

  async recordUserSourceFailure(
    scope: DataSyncScope,
    sourceId: CopilotUsageSnapshotSource,
    status: Exclude<CopilotUsageAttemptStatus, "available">,
    message: string,
    attemptedAt: string,
    publication?: UserSourcePublication,
  ) {
    validateScope(scope);
    await transaction(this.database, async client => {
      await lockScope(client, scope);
      if (publication) await requireUserPublication(client, scope, publication);
      await client.query(`INSERT INTO copilot_usage_source_state(
          tenant_id,principal_id,source_id,attempt_status,message,attempted_at)
        VALUES($1,$2,$3,$4,$5,$6)
        ON CONFLICT (tenant_id,principal_id,source_id) DO UPDATE SET
          attempt_status=EXCLUDED.attempt_status,message=EXCLUDED.message,
          attempted_at=EXCLUDED.attempted_at,updated_at=clock_timestamp()`,
      [scope.tenantId, scope.principalId, sourceId, status, boundedMessage(message), attemptedAt]);
    });
  }

  async getUserSources(scope: DataSyncScope): Promise<{
    directory: SavedCopilotUsageSource<CopilotDirectoryUser[]>;
    appActivity: SavedCopilotUsageSource<CopilotReportResult>;
  }> {
    const values = await this.readUserSources(scope, ["directory", "app_activity"], this.database);
    return {
      directory: projectSavedSource<CopilotDirectoryUser[]>("directory", values.get("directory")),
      appActivity: projectSavedSource<CopilotReportResult>("app_activity", values.get("app_activity")),
    };
  }

  async getDirectorySource(scope: DataSyncScope, database: Pick<pg.Pool, "query"> = this.database) {
    const values = await this.readUserSources(scope, ["directory"], database);
    return projectSavedSource<CopilotDirectoryUser[]>("directory", values.get("directory"));
  }

  private async readUserSources(scope: DataSyncScope, sources: readonly CopilotUsageSnapshotSource[], database: Pick<pg.Pool, "query">) {
    validateScope(scope);
    const result = await database.query<SavedSourceRow>(`SELECT state.source_id,state.attempt_status,state.message,
        state.attempted_at,state.last_success_at,state.row_count,snapshot.observed_at,snapshot.snapshot_data
      FROM copilot_usage_source_state state
      LEFT JOIN copilot_usage_snapshots snapshot
        ON snapshot.id=state.current_snapshot_id AND snapshot.tenant_id=state.tenant_id
        AND snapshot.principal_id=state.principal_id AND snapshot.source_id=state.source_id
        AND snapshot.is_current AND snapshot.expires_at>clock_timestamp()
      WHERE state.tenant_id=$1 AND state.principal_id=$2 AND state.source_id=ANY($3::text[])`,
    [scope.tenantId, scope.principalId, sources]);
    return new Map(result.rows.map(row => [row.source_id, row]));
  }

  private async publishUserSource(
    scope: DataSyncScope,
    sourceId: CopilotUsageSnapshotSource,
    value: CopilotDirectorySnapshot | CopilotReportResult,
    rowCount: number,
    observedAt: string,
    message: string,
    publication?: UserSourcePublication,
  ) {
    validateScope(scope);
    if (!Number.isSafeInteger(rowCount) || rowCount < 0 || rowCount > 100_000) throw new AppError(413, "copilot_usage_snapshot_limit", "Copilot usage source exceeded the snapshot row limit.");
    const payload = JSON.stringify(value);
    if (Buffer.byteLength(payload, "utf8") > 32 * 1024 * 1024) throw new AppError(413, "copilot_usage_snapshot_limit", "Copilot usage source exceeded the snapshot storage limit.");
    const snapshotId = randomUUID();
    await transaction(this.database, async client => {
      await lockScope(client, scope);
      if (publication) await requireUserPublication(client, scope, publication);
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`copilot-usage:${scope.tenantId}:${scope.principalId}:${sourceId}`]);
      await client.query(`UPDATE copilot_usage_snapshots SET is_current=false
        WHERE tenant_id=$1 AND principal_id=$2 AND source_id=$3 AND is_current`,
      [scope.tenantId, scope.principalId, sourceId]);
      await client.query(`INSERT INTO copilot_usage_snapshots(
          id,tenant_id,principal_id,source_id,snapshot_data,row_count,observed_at)
        VALUES($1,$2,$3,$4,$5::jsonb,$6,$7)`,
      [snapshotId, scope.tenantId, scope.principalId, sourceId, payload, rowCount, observedAt]);
      await client.query(`INSERT INTO copilot_usage_source_state(
          tenant_id,principal_id,source_id,attempt_status,message,attempted_at,
          last_success_at,row_count,current_snapshot_id)
        VALUES($1,$2,$3,'available',$4,$5,$5,$6,$7)
        ON CONFLICT (tenant_id,principal_id,source_id) DO UPDATE SET
          attempt_status='available',message=EXCLUDED.message,attempted_at=EXCLUDED.attempted_at,
          last_success_at=EXCLUDED.last_success_at,row_count=EXCLUDED.row_count,
          current_snapshot_id=EXCLUDED.current_snapshot_id,updated_at=clock_timestamp()`,
      [scope.tenantId, scope.principalId, sourceId, boundedMessage(message), observedAt, rowCount, snapshotId]);
    });
    return snapshotId;
  }
}

function normalizeSources(mode: DataSyncMode, requested: readonly DataSyncSourceId[] | undefined) {
  if (!["initial", "incremental", "full"].includes(mode)) throw new AppError(400, "invalid_data_sync_mode", "Data sync mode is invalid.");
  if (requested !== undefined && (!Array.isArray(requested) || requested.length < 1 || requested.length > dataSyncSourceIds.length || new Set(requested).size !== requested.length)) {
    throw new AppError(400, "invalid_data_sync_sources", "Data sync sources must be a non-empty list without duplicates.");
  }
  const sourceSet = new Set<DataSyncSourceId>(requested ?? automaticDataSyncSourceIds);
  if ([...sourceSet].some(source => !dataSyncSourceIds.includes(source))) throw new AppError(400, "invalid_data_sync_sources", "Data sync source is invalid.");
  return dataSyncSourceIds.filter(source => sourceSet.has(source));
}

function normalizeRetrySources(requested: readonly DataSyncSourceId[]) {
  if (!Array.isArray(requested) || requested.length < 1 || requested.length > dataSyncSourceIds.length || new Set(requested).size !== requested.length
    || requested.some(source => !dataSyncSourceIds.includes(source))) {
    throw new AppError(400, "invalid_data_sync_sources", "Retry sources must be a non-empty list without duplicates.");
  }
  return dataSyncSourceIds.filter(source => requested.includes(source));
}

function projectRun(run: RunRow, sources: SourceRow[]): DataSyncRun {
  return {
    id: run.id,
    mode: run.mode,
    status: run.status,
    startedAt: run.started_at.toISOString(),
    updatedAt: run.updated_at.toISOString(),
    completedAt: run.completed_at?.toISOString() ?? null,
    sources: sources.map(projectSource),
  };
}

function projectSource(row: SourceRow): DataSyncSourceStatus {
  return {
    source: row.source_id,
    status: row.status,
    jobId: row.job_id,
    count: row.count,
    lastSuccessAt: row.last_success_at?.toISOString() ?? null,
    updatedAt: row.updated_at.toISOString(),
    message: row.message,
    canRetry: row.can_retry,
  };
}

function projectSavedSource<T>(source: CopilotUsageSnapshotSource, row: SavedSourceRow | undefined): SavedCopilotUsageSource<T> {
  let value: unknown = row?.snapshot_data ?? null;
  if (source === "directory" && value !== null) {
    if (typeof value === "object" && "serviceEvidenceVersion" in value && value.serviceEvidenceVersion === 1
      && "users" in value && Array.isArray(value.users)
      && value.users.every((user: unknown) => user !== null && typeof user === "object" && !Array.isArray(user)
        && "serviceEvidenceVersion" in user && user.serviceEvidenceVersion === 1
        && "copilotServiceState" in user && isCopilotServiceSummaryState(user.copilotServiceState)
        && "servicePlans" in user && Array.isArray(user.servicePlans))) {
      value = value.users;
    } else {
      throw new AppError(409, "copilot_usage_snapshot_invalid", "Saved Copilot service data has an unsupported format. Refresh Users before retrying.");
    }
  }
  return {
    source,
    attemptStatus: row?.attempt_status ?? null,
    message: row?.message ?? null,
    attemptedAt: row?.attempted_at?.toISOString() ?? null,
    lastSuccessAt: row?.last_success_at?.toISOString() ?? null,
    rowCount: row?.row_count ?? null,
    observedAt: row?.observed_at?.toISOString() ?? null,
    value: value as T | null,
  };
}

async function finalizeRun(client: pg.PoolClient, scope: DataSyncScope, runId: string) {
  const result = await client.query<{ status: DataSyncSourceState }>(`SELECT status FROM data_sync_run_sources
    WHERE run_id=$1 AND tenant_id=$2 AND principal_id=$3`, [runId, scope.tenantId, scope.principalId]);
  const statuses = result.rows.map(row => row.status);
  const status: DataSyncRun["status"] = statuses.some(value => value === "queued" || value === "running")
    ? "running"
    : statuses.some(value => ["waiting_authorization", "permission_required", "awaiting_upload"].includes(value))
      ? "waiting"
      : statuses.length > 0 && statuses.every(value => value === "succeeded")
        ? "completed"
        : statuses.length > 0 && statuses.every(value => value === "cancelled")
          ? "cancelled"
          : "partial";
  const terminal = ["completed", "partial", "cancelled"].includes(status);
  await client.query(`UPDATE data_sync_runs SET status=$4,updated_at=clock_timestamp(),
      completed_at=CASE WHEN $5 THEN COALESCE(completed_at,clock_timestamp()) ELSE NULL END
    WHERE id=$1 AND tenant_id=$2 AND principal_id=$3`,
  [runId, scope.tenantId, scope.principalId, status, terminal]);
}

function notStarted(sourceId: DataSyncSourceId): DataSyncSourceStatus {
  return {
    source: sourceId,
    status: "not_started",
    jobId: null,
    count: null,
    lastSuccessAt: null,
    updatedAt: null,
    message: "This source has not completed a saved-data sync for this account.",
    canRetry: false,
  };
}

function successfulMarkerMessage(sourceId: DataSyncSourceId, count: number | null) {
  const label = sourceId === "users" ? "User and license"
    : sourceId === "graph_packages" ? "Graph package"
      : sourceId === "power_platform" ? "Power Platform"
        : "Official usage report";
  return `${label} saved data is available${count === null ? "." : ` (${count} records).`}`;
}

async function lockScope(client: pg.PoolClient, scope: DataSyncScope) {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`data-sync:${scope.tenantId}:${scope.principalId}`]);
}

export async function requireUserPublication(client: pg.PoolClient, scope: DataSyncScope, publication: UserSourcePublication) {
  const current = await client.query(`SELECT 1 FROM data_sync_runs run
    JOIN data_sync_run_sources source ON source.run_id=run.id
      AND source.tenant_id=run.tenant_id AND source.principal_id=run.principal_id
    WHERE run.id=$1 AND run.tenant_id=$2 AND run.principal_id=$3
      AND run.status IN ('running','waiting') AND run.expires_at>clock_timestamp()
      AND source.source_id='users' AND source.job_id=$4 AND source.status='running'`,
  [publication.runId, scope.tenantId, scope.principalId, publication.jobId]);
  if (!current.rowCount) {
    throw new AppError(409, "data_sync_publication_superseded", "This user-source attempt stopped or was superseded; its saved data was not published.");
  }
}

function validateScope(scope: DataSyncScope) {
  if (!scope.tenantId || !scope.principalId || scope.tenantId.length > 128 || scope.principalId.length > 256) {
    throw new AppError(403, "scope_mismatch", "Data sync requires the current tenant and principal scope.");
  }
}

function boundedRunLimit(value: number) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 50) {
    throw new AppError(400, "invalid_data_sync_limit", "Data sync run limit must be an integer from 1 through 50.");
  }
  return value;
}

function validateUuid(value: string, label: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new AppError(400, "invalid_data_sync_job", `The ${label} is invalid.`);
  }
}

function boundedMessage(message: string) {
  if (!message || message.length > 1024) throw new AppError(500, "invalid_data_sync_message", "Data sync source status message is invalid.");
  return message;
}

function hash(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
