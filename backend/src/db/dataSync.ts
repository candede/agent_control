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
import { pool, transaction } from "./pool.js";
import { readAutomaticInventoryRevisions } from "./inventoryAutomaticRevisions.js";
import { directoryNeedsReportRefresh } from "./officialReportStatus.js";

export type DataSyncScope = { tenantId: string; principalId: string };
export type UserSourcePublication = { runId: string; jobId: string };

type RunRow = {
  id: string;
  mode: DataSyncMode;
  status: DataSyncRun["status"];
  started_at: Date;
  updated_at: Date;
  completed_at: Date | null;
  automatic: boolean;
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

  async submitDue(scope: DataSyncScope, signedInAt?: number): Promise<{ run: DataSyncRun | null; created: boolean }> {
    validateScope(scope);
    const result = await transaction(this.database, async client => {
      await lockScope(client, scope);
      const active = await client.query<{ id: string }>(`SELECT id FROM data_sync_runs
        WHERE tenant_id=$1 AND principal_id=$2 AND status IN ('running','waiting')
          AND expires_at>clock_timestamp()
        ORDER BY started_at DESC LIMIT 1`, [scope.tenantId, scope.principalId]);
      if (active.rows[0]) return { id: active.rows[0].id, created: false };
      const reportChanged = await directoryNeedsReportRefresh(client, scope);
      const due = await client.query<{ source_id: DataSyncSourceId }>(`
        SELECT requested.source_id FROM unnest($3::text[]) requested(source_id)
        LEFT JOIN data_sync_success_markers marker
          ON marker.tenant_id=$1 AND marker.principal_id=$2 AND marker.source_id=requested.source_id
        LEFT JOIN LATERAL (
          SELECT source.status,source.updated_at,run.started_at FROM data_sync_run_sources source
          JOIN data_sync_runs run ON run.id=source.run_id
          WHERE source.tenant_id=$1 AND source.principal_id=$2 AND source.source_id=requested.source_id
          ORDER BY source.updated_at DESC LIMIT 1
        ) attempt ON true
        WHERE ((marker.last_success_at IS NULL OR marker.last_success_at<=clock_timestamp()-interval '15 minutes'
            OR requested.source_id='users' AND $5::boolean)
          AND (attempt.updated_at IS NULL OR requested.source_id='users' AND $5::boolean AND attempt.status='succeeded'
            OR attempt.updated_at<=clock_timestamp()-
            CASE WHEN attempt.status IN ('permission_required','waiting_authorization') THEN interval '1 hour'
              ELSE interval '15 minutes' END))
          OR (attempt.status='waiting_authorization' AND attempt.started_at<$4::timestamptz)
        ORDER BY requested.source_id`, [scope.tenantId, scope.principalId, automaticDataSyncSourceIds,
        signedInAt === undefined ? null : new Date(signedInAt), reportChanged]);
      if (!due.rows.length) return { id: null, created: false };
      const recent = await client.query<{ count: number }>(`SELECT count(*)::int AS count FROM data_sync_runs
        WHERE tenant_id=$1 AND principal_id=$2 AND started_at>clock_timestamp()-interval '1 hour'`,
      [scope.tenantId, scope.principalId]);
      if (recent.rows[0].count >= 20) throw new AppError(429, "data_sync_admission_full", "Automatic refresh is waiting for the hourly sync admission budget.");
      const id = randomUUID();
      const sources = due.rows.map(row => row.source_id);
      await insertRun(client, scope, id, { mode: "incremental" }, sources, true);
      return { id, created: true };
    });
    const run = result.id ? await this.getRun(scope, result.id) : await this.getLatestRun(scope);
    if (result.id && !run) throw new AppError(409, "data_sync_state_changed", "The admitted automatic sync is no longer available. Check saved sync status.");
    return { run: run ?? null, created: result.created };
  }

  async automaticRevisions(scope: DataSyncScope) {
    validateScope(scope);
    return readAutomaticInventoryRevisions(scope, this.database);
  }

  async finishAutomatic(scope: DataSyncScope, runId: string) {
    validateScope(scope);
    await this.database.query(`UPDATE data_sync_runs run SET status='partial',completed_at=clock_timestamp(),updated_at=clock_timestamp()
      WHERE id=$1 AND tenant_id=$2 AND principal_id=$3 AND automatic AND status='waiting'
        AND NOT EXISTS (SELECT 1 FROM data_sync_run_sources source WHERE source.run_id=run.id AND source.status IN ('queued','running'))`,
    [runId, scope.tenantId, scope.principalId]);
  }

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
      await insertRun(client, scope, id, input, sources);
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
    const run = await this.database.query<RunRow>(`SELECT id,mode,status,started_at,updated_at,completed_at,automatic
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
    const runs = await this.database.query<RunRow>(`SELECT id,mode,status,started_at,updated_at,completed_at,automatic
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
      await requireSourceJobScope(client, scope, runId, sourceId, jobId);
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
      if (update.jobId) await requireSourceJobScope(client, scope, runId, sourceId, update.jobId);
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
        const exists = await client.query<{ status: DataSyncRun["status"] }>("SELECT status FROM data_sync_runs WHERE id=$1 AND tenant_id=$2 AND principal_id=$3 AND expires_at>clock_timestamp()", [id, scope.tenantId, scope.principalId]);
        if (!exists.rows[0]) throw new AppError(404, "not_found", "Data sync run was not found.");
        if (exists.rows[0].status !== "cancelled") {
          throw new AppError(409, "data_sync_run_state", "Only an active data sync run can be cancelled.");
        }
      }
      await client.query(`UPDATE data_sync_run_sources SET status='cancelled',
          message='Cancelled by the requesting principal.',can_retry=true,updated_at=clock_timestamp()
        WHERE run_id=$1 AND tenant_id=$2 AND principal_id=$3 AND status<>'succeeded'`,
      [id, scope.tenantId, scope.principalId]);
    });
    return (await this.getRun(scope, id))!;
  }

  async pausePrincipal(scope: DataSyncScope, message = "Explicit resume with current authorization is required.", runId?: string) {
    validateScope(scope);
    const result = await transaction(this.database, async client => {
      await lockScope(client, scope);
      const sources = await client.query(`UPDATE data_sync_run_sources source SET
          status='waiting_authorization',message=$3,can_retry=true,updated_at=clock_timestamp()
        FROM data_sync_runs run
        WHERE source.run_id=run.id AND source.tenant_id=$1 AND source.principal_id=$2
          AND run.tenant_id=$1 AND run.principal_id=$2 AND run.status IN ('running','waiting')
          AND ($4::uuid IS NULL OR run.id=$4::uuid)
          AND source.source_id<>'usage_reports' AND source.status IN ('queued','running')
        RETURNING source.run_id`, [scope.tenantId, scope.principalId, message, runId ?? null]);
      await client.query(`UPDATE data_sync_runs SET status=CASE WHEN automatic THEN 'partial' ELSE 'waiting' END,
          completed_at=CASE WHEN automatic THEN clock_timestamp() ELSE NULL END,updated_at=clock_timestamp()
        WHERE tenant_id=$1 AND principal_id=$2 AND status IN ('running','waiting')
          AND ($3::uuid IS NULL OR id=$3::uuid)
          AND EXISTS (SELECT 1 FROM data_sync_run_sources source
            WHERE source.run_id=data_sync_runs.id AND source.status='waiting_authorization')`,
      [scope.tenantId, scope.principalId, runId ?? null]);
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
    await this.database.query(`UPDATE data_sync_runs run SET status=CASE WHEN automatic THEN 'partial' ELSE 'waiting' END,
        completed_at=CASE WHEN automatic THEN clock_timestamp() ELSE NULL END,updated_at=clock_timestamp()
      WHERE status IN ('running','waiting') AND expires_at>clock_timestamp()
        AND EXISTS (SELECT 1 FROM data_sync_run_sources source
          WHERE source.run_id=run.id AND source.status IN ('waiting_authorization','permission_required','awaiting_upload'))`);
    return sources.rowCount ?? 0;
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
    ...(run.automatic ? { automatic: true } : {}),
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

async function insertRun(client: pg.PoolClient, scope: DataSyncScope, id: string, input: StartDataSyncInput,
  sources: readonly DataSyncSourceId[], automatic = false) {
  const requestHash = hash({ mode: input.mode, sources, ...(input.clearSavedData ? { clearSavedData: true } : {}),
    ...(automatic ? { automatic: true } : {}) });
  await client.query(`INSERT INTO data_sync_runs(id,tenant_id,principal_id,mode,source_ids,request_hash,clear_saved_data,automatic)
    VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,$8)`,
  [id, scope.tenantId, scope.principalId, input.mode, JSON.stringify(sources), requestHash, input.clearSavedData ?? false, automatic]);
  await client.query(`INSERT INTO data_sync_run_sources(
      run_id,tenant_id,principal_id,source_id,status,count,last_success_at,message,can_retry)
    SELECT $1,$2,$3,requested.source_id,'queued',NULL,marker.last_success_at,
      'Waiting for the durable sync worker.',false
    FROM jsonb_array_elements_text($4::jsonb) AS requested(source_id)
    LEFT JOIN data_sync_success_markers marker
      ON marker.tenant_id=$2 AND marker.principal_id=$3 AND marker.source_id=requested.source_id`,
  [id, scope.tenantId, scope.principalId, JSON.stringify(sources)]);
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

async function requireSourceJobScope(client: pg.PoolClient, scope: DataSyncScope, runId: string, sourceId: DataSyncSourceId, jobId: string) {
  // Users sync has an attempt UUID, not a persisted provider job.
  if (sourceId !== "graph_packages" && sourceId !== "power_platform") return;
  const table = sourceId === "graph_packages" ? "package_refresh_jobs" : "power_platform_refresh_jobs";
  const authority = sourceId === "graph_packages" ? "AND token_mode='delegated' AND authorization_principal_id=$3" : "";
  // A previously authorized association survives provider-job retention for failed-source reconciliation.
  const job = await client.query(`SELECT 1 FROM ${table} WHERE id=$1 AND tenant_id=$2 AND principal_id=$3 ${authority}
    UNION ALL SELECT 1 FROM data_sync_source_jobs
      WHERE job_id=$1 AND tenant_id=$2 AND principal_id=$3 AND run_id=$4 AND source_id=$5
        AND NOT EXISTS (SELECT 1 FROM ${table} WHERE id=$1) LIMIT 1`,
  [jobId, scope.tenantId, scope.principalId, runId, sourceId]);
  if (!job.rowCount) throw new AppError(409, "data_sync_source_job_scope", "The provider job was not found in this data sync account scope.");
}

export async function requireUserPublication(client: pg.PoolClient, scope: DataSyncScope, publication: UserSourcePublication) {
  const current = await client.query(`SELECT 1 FROM data_sync_runs run
    JOIN data_sync_run_sources source ON source.run_id=run.id
      AND source.tenant_id=run.tenant_id AND source.principal_id=run.principal_id
    WHERE run.id=$1 AND run.tenant_id=$2 AND run.principal_id=$3
      AND run.status IN ('running','waiting') AND run.expires_at>clock_timestamp()
      AND source.source_id='users' AND source.job_id=$4 AND source.status='running'
    FOR UPDATE OF run, source`,
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

function hash(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
