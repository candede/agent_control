import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";
import { AppError } from "../errors.js";
import type { InventoryIdentityRecord } from "../services/inventoryIdentity.js";
import { requireProviderAdmissions } from "../services/operationalState.js";
import { defenderHuntingTemplates, defenderHuntingFieldAvailable, isDefenderHuntingRequestId,
  type DefenderHuntingFilters, type DefenderHuntingHistory, type DefenderHuntingJob,
  type DefenderHuntingQueryResult, type DefenderHuntingResultScope,
  type DefenderHuntingRow, type DefenderHuntingRowPage, type DefenderHuntingSnapshot, type DefenderHuntingTokenMode } from "../types/defenderHunting.js";
import { InventoryIdentityQueries, type InventoryIdentityReadScope } from "./inventoryIdentityQueries.js";
import { pool, transaction } from "./pool.js";
import { currentActionOrigin, parseStoredOrigin, initiatingOrigin } from "../services/actionOrigin.js";
import type { AuditActor } from "../types/audit.js";

export type DefenderHuntingScope = {
  tenantId: string;
  authorizationPrincipalId: string;
  resultScope: DefenderHuntingResultScope;
  tokenMode: DefenderHuntingTokenMode;
};

export type DefenderHuntingReadScope = {
  tenantId: string;
  authorizationPrincipalId: string;
  resultScopes: DefenderHuntingResultScope[];
  inventoryIdentityScope?: InventoryIdentityReadScope;
  entraAgentIds?: string[];
  entraAgentApplicationIds?: string[];
  userObjectId?: string;
};

export type DefenderHuntingExecution = { owner: string; version: number };

type JobRow = {
  origin?: unknown; initiating_actor?: AuditActor | null;
  id: string; authorization_principal_id: string; result_scope_id: string; result_scope_kind: DefenderHuntingResultScope["kind"];
  result_scope_configuration_revision: string | null; token_mode: DefenderHuntingTokenMode; status: DefenderHuntingJob["status"];
  filters: DefenderHuntingFilters; query_version: 3; local_request_id: string; provider_request_id: string | null;
  provider_request_count: number; activation_count: number; execution_version: string; execution_owner: string | null;
  provider_row_count: number; stored_row_count: number; byte_count: number; result_complete: boolean; no_data: boolean;
  partial_reason: DefenderHuntingJob["partialReason"]; observed_start: Date | null; observed_end: Date | null;
  unobserved_start: Date | null; unobserved_end: Date | null;
  error_code: string | null; message: string | null; cancel_requested: boolean; created_at: Date; attempted_at: Date | null;
  updated_at: Date; finished_at: Date | null; deadline_at: Date; expires_at: Date; snapshot_id: string | null;
  prior_successful_job_id?: string | null;
};

type SnapshotRow = {
  id: string; job_id: string; result_scope_id: string; result_scope_kind: DefenderHuntingResultScope["kind"];
  result_scope_configuration_revision: string | null; filters: DefenderHuntingFilters; source_table: "AgentsInfo" | "CloudAppEvents";
  query_version: 3; requested_start: Date; requested_end: Date; observed_start: Date | null; observed_end: Date | null;
  unobserved_start: Date | null; unobserved_end: Date | null; observation_time: Date; result_complete: boolean; no_data: boolean;
  partial_reason: DefenderHuntingSnapshot["partialReason"]; provider_row_count: number; stored_row_count: number; byte_count: number; expires_at: Date;
};

export class DefenderHuntingRepository {
  constructor(private readonly database: pg.Pool = pool) {}

  async submit(scope: DefenderHuntingScope, input: { idempotencyKey: string; filters: DefenderHuntingFilters;
    actor?: AuditActor }, publicationFence?: () => void) {
    requireProviderAdmissions();
    validateScope(scope);
    if (input.actor) {
      if (input.actor.tenantId !== scope.tenantId || input.actor.homeAccountId !== scope.authorizationPrincipalId) throw new AppError(400, "invalid_audit_actor", "Audit actor must match the hunting owner.");
      initiatingOrigin(input.actor);
    }
    if (typeof input.idempotencyKey !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(input.idempotencyKey)) {
      throw new AppError(400, "invalid_idempotency_key", "Idempotency-Key must contain 1-128 letters, digits, underscores or hyphens.");
    }
    const hash = requestHash(scope, input.filters);
    const targetScopeHash = huntingTargetScopeHash(input.filters);
    const id = await transaction(this.database, async client => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`defender-hunting:${scope.tenantId}`]);
      publicationFence?.();
      const existing = await client.query<{ id: string; request_hash: string }>(`SELECT id,request_hash FROM defender_hunting_jobs
        WHERE tenant_id=$1 AND result_scope_kind=$2 AND result_scope_id=$3 AND result_scope_configuration_revision IS NOT DISTINCT FROM $4
          AND token_mode=$5 AND idempotency_key=$6`, [scope.tenantId, scope.resultScope.kind, scope.resultScope.scopeId,
        scope.resultScope.configurationRevision, scope.tokenMode, input.idempotencyKey]);
      if (existing.rows[0]) {
        if (existing.rows[0].request_hash !== hash) throw new AppError(409, "idempotency_mismatch", "This idempotency key belongs to different hunting filters or authority.");
        publicationFence?.();
        return existing.rows[0].id;
      }
      const unfinished = await client.query<{ principal_count: number; tenant_count: number }>(`SELECT
        count(*) FILTER (WHERE authorization_principal_id=$2)::int AS principal_count,count(*)::int AS tenant_count
        FROM defender_hunting_jobs WHERE tenant_id=$1 AND status IN ('waiting_authorization','running') AND expires_at>clock_timestamp()`,
      [scope.tenantId, scope.authorizationPrincipalId]);
      if (unfinished.rows[0].principal_count >= 5 || unfinished.rows[0].tenant_count >= 10) throw new AppError(429, "job_limit", "The bounded hunting unfinished-job limit was reached.");
      const jobId = randomUUID();
      await client.query(`INSERT INTO defender_hunting_jobs
        (id,tenant_id,authorization_principal_id,result_scope_id,result_scope_kind,result_scope_configuration_revision,token_mode,template_id,idempotency_key,request_hash,filters,local_request_id,
          target_scope_hash,query_version,origin,initiating_actor)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,3,$14::jsonb,$15::jsonb)`,
      [jobId, scope.tenantId, scope.authorizationPrincipalId, scope.resultScope.scopeId, scope.resultScope.kind, scope.resultScope.configurationRevision,
        scope.tokenMode, input.filters.templateId, input.idempotencyKey, hash, JSON.stringify(input.filters), randomUUID(), targetScopeHash,
        JSON.stringify(currentActionOrigin()), input.actor ? JSON.stringify({ tenantId: input.actor.tenantId, homeAccountId: input.actor.homeAccountId,
          username: input.actor.username, displayName: input.actor.displayName }) : null]);
      publicationFence?.();
      return jobId;
    }, undefined, publicationFence);
    return (await this.getJob(scope, id))!;
  }

  async getJob(scope: DefenderHuntingReadScope | DefenderHuntingScope, id: string) {
    const read = scopedWhere(toReadScope(scope));
    const result = await this.database.query<JobRow>(`SELECT job.*,(SELECT id FROM defender_hunting_snapshots WHERE job_id=job.id) AS snapshot_id,
      ${priorSuccessfulJobSelect("job")} AS prior_successful_job_id
      FROM defender_hunting_jobs job WHERE job.id=$${read.values.length + 1} AND ${read.sql} AND job.expires_at>clock_timestamp()`, [...read.values, id]);
    return result.rows[0] ? projectJob(result.rows[0]) : undefined;
  }

  async listJobs(scope: DefenderHuntingReadScope, limit = 20, offset = 0): Promise<DefenderHuntingHistory> {
    const read = scopedWhere(scope);
    const boundedLimit = Math.min(Math.max(limit, 1), 50);
    const boundedOffset = Math.min(Math.max(offset, 0), 100_000);
    const rows = await this.database.query<JobRow>(`SELECT job.*,(SELECT id FROM defender_hunting_snapshots WHERE job_id=job.id) AS snapshot_id,
      ${priorSuccessfulJobSelect("job")} AS prior_successful_job_id
      FROM defender_hunting_jobs job WHERE ${read.sql} AND job.expires_at>clock_timestamp()
      ORDER BY job.created_at DESC,job.id DESC LIMIT $${read.values.length + 1} OFFSET $${read.values.length + 2}`,
    [...read.values, boundedLimit, boundedOffset]);
    const count = await this.database.query<{ count: number }>(`SELECT count(*)::int AS count FROM defender_hunting_jobs job
      WHERE ${read.sql} AND job.expires_at>clock_timestamp()`, read.values);
    return { value: rows.rows.map(projectJob), count: count.rows[0].count, limit: boundedLimit, offset: boundedOffset };
  }

  async begin(scope: DefenderHuntingScope, id: string) {
    validateScope(scope);
    const outcome = await transaction(this.database, async client => {
      const exhausted = await client.query<{ error_code: string }>(`UPDATE defender_hunting_jobs SET status='inconclusive',
        error_code=CASE WHEN deadline_at<=clock_timestamp() THEN 'hunting_job_expired'
          WHEN activation_count>=4 THEN 'hunting_activation_limit' ELSE 'hunting_provider_request_limit' END,
        message='Hunting reached a durable execution bound before activation.',finished_at=clock_timestamp(),execution_owner=NULL,updated_at=clock_timestamp()
        WHERE id=$1 AND tenant_id=$2 AND result_scope_kind=$3 AND result_scope_id=$4 AND result_scope_configuration_revision IS NOT DISTINCT FROM $5
          AND authorization_principal_id=$6 AND token_mode=$7 AND status='waiting_authorization' AND NOT cancel_requested
          AND (deadline_at<=clock_timestamp() OR activation_count>=4 OR provider_request_count>=12) RETURNING error_code`,
      [id, scope.tenantId, scope.resultScope.kind, scope.resultScope.scopeId, scope.resultScope.configurationRevision, scope.authorizationPrincipalId, scope.tokenMode]);
      if (exhausted.rows[0]) return { kind: "terminal" as const, terminalCode: exhausted.rows[0].error_code };
      const selected = await client.query<Pick<JobRow, "activation_count" | "execution_version">>(`SELECT activation_count,execution_version FROM defender_hunting_jobs
        WHERE id=$1 AND tenant_id=$2 AND result_scope_kind=$3 AND result_scope_id=$4 AND result_scope_configuration_revision IS NOT DISTINCT FROM $5
          AND authorization_principal_id=$6 AND token_mode=$7 AND status='waiting_authorization' AND NOT cancel_requested
          AND expires_at>clock_timestamp() AND deadline_at>clock_timestamp() FOR UPDATE`,
      [id, scope.tenantId, scope.resultScope.kind, scope.resultScope.scopeId, scope.resultScope.configurationRevision, scope.authorizationPrincipalId, scope.tokenMode]);
      if (!selected.rows[0]) throw new AppError(409, "hunting_job_state", "Hunting is not waiting for this exact current authority.");
      if (selected.rows[0].activation_count >= 4) throw new AppError(409, "hunting_activation_limit", "Hunting reached its durable activation limit.");
      const owner = randomUUID();
      const updated = await client.query<JobRow>(`UPDATE defender_hunting_jobs SET status='running',activation_count=activation_count+1,
        execution_version=execution_version+1,execution_owner=$8,error_code=NULL,message=NULL,updated_at=clock_timestamp()
        WHERE id=$1 AND tenant_id=$2 AND result_scope_kind=$3 AND result_scope_id=$4 AND result_scope_configuration_revision IS NOT DISTINCT FROM $5
          AND authorization_principal_id=$6 AND token_mode=$7 RETURNING *`,
      [id, scope.tenantId, scope.resultScope.kind, scope.resultScope.scopeId, scope.resultScope.configurationRevision, scope.authorizationPrincipalId, scope.tokenMode, owner]);
      return { kind: "execution" as const, execution: { owner, version: Number(updated.rows[0].execution_version), job: projectJob({ ...updated.rows[0], snapshot_id: null }) } };
    });
    if (outcome.kind === "terminal") throw new AppError(409, outcome.terminalCode, "Hunting reached a durable execution bound before activation.");
    return outcome.execution;
  }

  async authorizeProviderRequest(scope: DefenderHuntingScope, id: string, execution: DefenderHuntingExecution, admissionFence?: () => void) {
    await transaction(this.database, async client => {
      const job = await this.fence(client, scope, id, execution);
      if (job.deadline_at <= new Date()) throw new AppError(409, "hunting_job_expired", "Hunting reached its durable execution deadline.");
      if (job.provider_request_count >= 12) throw new AppError(409, "hunting_provider_request_limit", "Hunting reached its durable provider request limit.");
      await client.query(`UPDATE defender_hunting_jobs SET provider_request_count=provider_request_count+1,
        attempted_at=COALESCE(attempted_at,clock_timestamp()),updated_at=clock_timestamp()
        WHERE id=$1 AND execution_owner=$2 AND execution_version=$3`, [id, execution.owner, execution.version]);
      if (job.deadline_at <= new Date()) throw new AppError(409, "hunting_job_expired", "Hunting admission exceeded its durable deadline.");
    }, undefined, admissionFence);
  }

  async recordProviderResponse(scope: DefenderHuntingScope, id: string, execution: DefenderHuntingExecution, providerRequestId: string | null,
    publicationFence?: () => void) {
    if (providerRequestId !== null && !isDefenderHuntingRequestId(providerRequestId)) throw new AppError(502, "provider_schema", "Microsoft Graph returned an invalid request identifier.");
    await transaction(this.database, async client => {
      publicationFence?.();
      await this.fence(client, scope, id, execution);
      const result = await client.query(`UPDATE defender_hunting_jobs SET provider_request_id=COALESCE($10,provider_request_id),updated_at=clock_timestamp()
        WHERE id=$1 AND tenant_id=$2 AND result_scope_kind=$3 AND result_scope_id=$4 AND result_scope_configuration_revision IS NOT DISTINCT FROM $5
          AND authorization_principal_id=$6 AND token_mode=$7 AND execution_owner=$8 AND execution_version=$9
          AND status='running' AND NOT cancel_requested RETURNING id`,
      [id, scope.tenantId, scope.resultScope.kind, scope.resultScope.scopeId, scope.resultScope.configurationRevision,
        scope.authorizationPrincipalId, scope.tokenMode, execution.owner, execution.version, providerRequestId]);
      if (result.rowCount !== 1) throw executionLost();
    }, undefined, publicationFence);
  }

  async publish(scope: DefenderHuntingScope, id: string, execution: DefenderHuntingExecution, result: DefenderHuntingQueryResult,
    publicationFence?: () => void) {
    validatePublicationEnvelope(result);
    return transaction(this.database, async client => {
      const job = await this.fence(client, scope, id, execution);
      publicationFence?.();
      if (job.deadline_at <= new Date()) throw new AppError(409, "hunting_job_expired", "Hunting results arrived after its deadline.");
      validatePublicationRows(result.rows, job.filters, scope.tenantId);
      const snapshotId = randomUUID();
      const instants = result.rows.map(row => new Date(row.sourceTable === "AgentsInfo" ? row.observationTime : row.timestamp));
      const observedStart = instants.length ? new Date(Math.min(...instants.map(value => value.getTime()))) : null;
      const observedEnd = instants.length ? new Date(Math.max(...instants.map(value => value.getTime()))) : null;
      const filters = job.filters;
      const sourceTable = defenderHuntingTemplates[filters.templateId].sourceTable;
      await client.query(`INSERT INTO defender_hunting_snapshots
        (id,job_id,tenant_id,result_scope_id,result_scope_kind,result_scope_configuration_revision,template_id,source_table,filters,requested_start,requested_end,
          observed_start,observed_end,unobserved_start,unobserved_end,result_complete,no_data,partial_reason,provider_row_count,stored_row_count,byte_count)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`,
      [snapshotId, id, scope.tenantId, scope.resultScope.scopeId, scope.resultScope.kind, scope.resultScope.configurationRevision,
        filters.templateId, sourceTable, JSON.stringify(filters), filters.startDateTime, filters.endDateTime, observedStart, observedEnd,
        result.complete ? null : filters.startDateTime, result.complete ? null : filters.endDateTime, result.complete, result.complete && result.rows.length === 0,
        result.partialReason, result.providerRowCount, result.storedRowCount, result.byteCount]);
      if (result.rows.length) {
        await client.query(`INSERT INTO defender_hunting_rows
          (snapshot_id,row_ordinal,tenant_id,result_scope_id,result_scope_kind,result_scope_configuration_revision,source_table,row_data)
          SELECT $1,row.row_ordinal,$2,$3,$4,$5,$6,row.row_data
          FROM jsonb_to_recordset($7::jsonb) AS row(row_ordinal integer,row_data jsonb)`,
        [snapshotId, scope.tenantId, scope.resultScope.scopeId, scope.resultScope.kind, scope.resultScope.configurationRevision,
          sourceTable, JSON.stringify(result.rows.map((row, row_ordinal) => ({ row_ordinal, row_data: row }))) ]);
      }
      const updated = await client.query<JobRow>(`UPDATE defender_hunting_jobs SET status=$6,provider_row_count=$7,stored_row_count=$8,byte_count=$9,
        result_complete=$10,no_data=$11,partial_reason=$12,observed_start=$13,observed_end=$14,unobserved_start=$15,unobserved_end=$16,
        error_code=$17,message=$18,finished_at=clock_timestamp(),updated_at=clock_timestamp(),execution_owner=NULL
        WHERE id=$1 AND tenant_id=$2 AND result_scope_kind=$3 AND result_scope_id=$4 AND result_scope_configuration_revision IS NOT DISTINCT FROM $5
          AND execution_owner=$19 AND execution_version=$20 RETURNING *`,
      [id, scope.tenantId, scope.resultScope.kind, scope.resultScope.scopeId, scope.resultScope.configurationRevision,
        result.complete ? "succeeded" : "partial", result.providerRowCount, result.storedRowCount, result.byteCount, result.complete,
        result.complete && result.rows.length === 0, result.partialReason, observedStart, observedEnd,
        result.complete ? null : filters.startDateTime, result.complete ? null : filters.endDateTime,
        result.partialReason, result.partialReason ? "The fixed hunting row cap was reached; the requested interval remains incompletely observed." : null,
        execution.owner, execution.version]);
      publicationFence?.();
      if (job.deadline_at <= new Date()) throw new AppError(409, "hunting_job_expired", "Hunting publication exceeded its durable deadline.");
      return projectJob({ ...updated.rows[0], snapshot_id: snapshotId });
    }, undefined, publicationFence);
  }

  async markWaitingAuthorization(scope: DefenderHuntingScope, id: string, execution: DefenderHuntingExecution) {
    const result = await this.database.query<JobRow>(`UPDATE defender_hunting_jobs AS job SET
      status=CASE WHEN deadline_at<=clock_timestamp() OR activation_count>=4 OR provider_request_count>=12 THEN 'inconclusive' ELSE 'waiting_authorization' END,
      error_code=CASE WHEN deadline_at<=clock_timestamp() THEN 'hunting_job_expired' WHEN activation_count>=4 THEN 'hunting_activation_limit'
        WHEN provider_request_count>=12 THEN 'hunting_provider_request_limit' ELSE 'interaction_required' END,
      message=CASE WHEN deadline_at<=clock_timestamp() OR activation_count>=4 OR provider_request_count>=12
        THEN 'Hunting reached a durable execution bound before publication.' ELSE 'Explicit resume with current hunting authorization is required.' END,
      finished_at=CASE WHEN deadline_at<=clock_timestamp() OR activation_count>=4 OR provider_request_count>=12 THEN clock_timestamp() ELSE NULL END,
      execution_owner=NULL,updated_at=clock_timestamp()
      WHERE id=$1 AND tenant_id=$2 AND result_scope_kind=$3 AND result_scope_id=$4 AND result_scope_configuration_revision IS NOT DISTINCT FROM $5
        AND execution_owner=$6 AND execution_version=$7 AND status='running' AND NOT cancel_requested
      RETURNING job.*,${priorSuccessfulJobSelect("job")} AS prior_successful_job_id`,
    [id, scope.tenantId, scope.resultScope.kind, scope.resultScope.scopeId, scope.resultScope.configurationRevision, execution.owner, execution.version]);
    if (result.rowCount !== 1) throw executionLost();
    return projectJob({ ...result.rows[0], snapshot_id: null });
  }

  async fail(scope: DefenderHuntingScope, id: string, execution: DefenderHuntingExecution, code: string, message: string, inconclusive = false) {
    await this.fence(this.database, scope, id, execution);
    const result = await this.database.query<JobRow>(`UPDATE defender_hunting_jobs AS job SET status=$8,error_code=$9,message=$10,finished_at=clock_timestamp(),updated_at=clock_timestamp(),execution_owner=NULL
      WHERE id=$1 AND tenant_id=$2 AND result_scope_kind=$3 AND result_scope_id=$4 AND result_scope_configuration_revision IS NOT DISTINCT FROM $5
        AND execution_owner=$6 AND execution_version=$7 AND status='running'
      RETURNING job.*,${priorSuccessfulJobSelect("job")} AS prior_successful_job_id`,
    [id, scope.tenantId, scope.resultScope.kind, scope.resultScope.scopeId, scope.resultScope.configurationRevision, execution.owner, execution.version,
      inconclusive ? "inconclusive" : "failed", safeCode(code), message.slice(0, 1024)]);
    if (result.rowCount !== 1) throw executionLost();
    return projectJob({ ...result.rows[0], snapshot_id: null });
  }

  async cancel(scope: DefenderHuntingReadScope | DefenderHuntingScope, id: string, mutationFence?: () => void) {
    return transaction(this.database, async client => {
      mutationFence?.();
      const read = await this.requireMutationJob(client, scope, id);
      mutationFence?.();
      const result = await client.query<JobRow>(`UPDATE defender_hunting_jobs AS job SET status='cancelled',cancel_requested=true,
      message='Local hunting execution stopped.',finished_at=clock_timestamp(),updated_at=clock_timestamp(),execution_owner=NULL
      WHERE job.id=$${read.values.length + 1} AND ${read.sql} AND job.status IN ('waiting_authorization','running')
      RETURNING job.*,${priorSuccessfulJobSelect("job")} AS prior_successful_job_id`, [...read.values, id]);
      if (!result.rows[0]) throw new AppError(409, "hunting_job_state", "Only unfinished hunting can be cancelled.");
      return projectJob({ ...result.rows[0], snapshot_id: null });
    }, undefined, mutationFence);
  }

  async delete(scope: DefenderHuntingReadScope | DefenderHuntingScope, id: string, mutationFence?: () => void) {
    await transaction(this.database, async client => {
      mutationFence?.();
      const read = await this.requireMutationJob(client, scope, id);
      mutationFence?.();
      const result = await client.query(`DELETE FROM defender_hunting_jobs AS job WHERE job.id=$${read.values.length + 1} AND ${read.sql} AND job.status<>'running' RETURNING job.id`, [...read.values, id]);
      if (result.rowCount !== 1) throw new AppError(409, "hunting_job_state", "Stop active hunting before deleting its local cache.");
    }, undefined, mutationFence);
  }

  async listRows(scope: DefenderHuntingReadScope | DefenderHuntingScope, id: string, limit = 100, offset = 0): Promise<DefenderHuntingRowPage> {
    const readScope = toReadScope(scope);
    const job = await this.getJob(scope, id);
    if (!job?.snapshotId) throw new AppError(404, "not_found", "Hunting snapshot was not found.");
    const read = scopedWhere(readScope, "snapshot");
    const snapshotResult = await this.database.query<SnapshotRow>(`SELECT snapshot.* FROM defender_hunting_snapshots snapshot
      WHERE snapshot.id=$${read.values.length + 1} AND ${read.sql} AND snapshot.expires_at>clock_timestamp()`, [...read.values, job.snapshotId]);
    if (!snapshotResult.rows[0]) throw new AppError(404, "not_found", "Hunting snapshot was not found.");
    const boundedLimit = Math.min(Math.max(limit, 1), 200);
    const boundedOffset = Math.min(Math.max(offset, 0), 100_000);
    const rows = await this.database.query<{ row_data: DefenderHuntingRow }>(`SELECT row.row_data FROM defender_hunting_rows row
      WHERE row.snapshot_id=$1 AND row.tenant_id=$2 AND row.result_scope_kind=$3 AND row.result_scope_id=$4
        AND row.result_scope_configuration_revision IS NOT DISTINCT FROM $5 ORDER BY row.row_ordinal LIMIT $6 OFFSET $7`,
    [job.snapshotId, readScope.tenantId, job.resultScope.kind, job.resultScope.scopeId, job.resultScope.configurationRevision, boundedLimit, boundedOffset]);
    if (readScope.entraAgentIds || readScope.entraAgentApplicationIds) validatePublicationRows(rows.rows.map(value => value.row_data), job.filters, readScope.tenantId);
    const associations = await this.resolveAssociations(readScope, rows.rows.map(value => value.row_data));
    const current = await this.getJob(scope, id);
    if (!current || current.snapshotId !== job.snapshotId || snapshotResult.rows[0].expires_at <= new Date()) {
      throw new AppError(404, "not_found", "The current hunting snapshot was not found.");
    }
    return { value: rows.rows.map((value, index) => ({ ...value.row_data, association: associations[index] })), count: job.storedRowCount,
      limit: boundedLimit, offset: boundedOffset, job: current, snapshot: projectSnapshot(snapshotResult.rows[0]) };
  }

  async recoverInterrupted() {
    return transaction(this.database, async client => {
      const terminal = await client.query(`WITH candidates AS (SELECT id FROM defender_hunting_jobs WHERE status IN ('running','waiting_authorization')
        AND (deadline_at<=clock_timestamp() OR activation_count>=4 OR provider_request_count>=12)
        ORDER BY updated_at,id LIMIT 1000 FOR UPDATE SKIP LOCKED)
        UPDATE defender_hunting_jobs job SET status='inconclusive',error_code=CASE WHEN deadline_at<=clock_timestamp() THEN 'hunting_job_expired'
          WHEN activation_count>=4 THEN 'hunting_activation_limit' ELSE 'hunting_provider_request_limit' END,
          message='Hunting reached a durable execution bound before publication.',finished_at=clock_timestamp(),execution_owner=NULL,updated_at=clock_timestamp()
        FROM candidates WHERE job.id=candidates.id`);
      const waiting = await client.query(`WITH candidates AS (SELECT id FROM defender_hunting_jobs WHERE status='running'
        AND deadline_at>clock_timestamp() AND activation_count<4 AND provider_request_count<12
        ORDER BY updated_at,id LIMIT 1000 FOR UPDATE SKIP LOCKED)
        UPDATE defender_hunting_jobs job SET status='waiting_authorization',error_code='interaction_required',
          message='Explicit resume with current hunting authorization is required.',execution_owner=NULL,updated_at=clock_timestamp()
        FROM candidates WHERE job.id=candidates.id`);
      return (terminal.rowCount ?? 0) + (waiting.rowCount ?? 0);
    });
  }

  private async requireMutationJob(client: Pick<pg.PoolClient, "query">, scope: DefenderHuntingReadScope | DefenderHuntingScope, id: string) {
    const read = scopedWhere(toReadScope(scope));
    read.values.push(scope.authorizationPrincipalId);
    read.sql += ` AND job.authorization_principal_id=$${read.values.length}`;
    const result = await client.query(`SELECT job.id FROM defender_hunting_jobs AS job
      WHERE job.id=$${read.values.length + 1} AND ${read.sql} AND job.expires_at>clock_timestamp() FOR UPDATE`, [...read.values, id]);
    if (result.rowCount !== 1) throw new AppError(404, "not_found", "Hunting job was not found.");
    return read;
  }

  private async resolveAssociations(scope: DefenderHuntingReadScope, rows: DefenderHuntingRow[]) {
    const identityScope = scope.inventoryIdentityScope;
    if (!identityScope) return rows.map(() => ({ status: "unresolved" as const, reason: "no_documented_cross_source_relation" as const }));
    if (identityScope.principalId !== scope.authorizationPrincipalId) throw new AppError(403, "scope_mismatch", "Hunting inventory association requires the current reader's private identity scope.");
    const inventory = new InventoryIdentityQueries(this.database);
    return inventory.read(async client => {
    const result = [];
    for (const row of rows) {
      const identifiers: InventoryIdentityRecord["identifiers"] = row.sourceTable === "AgentsInfo"
        ? [...(row.entraAgentObjectId ? [{ kind: "entra_agent_id" as const, value: row.entraAgentObjectId }] : []),
          ...(row.entraBlueprintId ? [{ kind: "entra_blueprint_id" as const, value: row.entraBlueprintId }] : [])]
        : [...(row.targetAgentBlueprintId ? [{ kind: "entra_blueprint_id" as const, value: row.targetAgentBlueprintId }] : []),
          ...(row.agentBlueprintId ? [{ kind: "entra_blueprint_id" as const, value: row.agentBlueprintId }] : [])];
      const resolution = await inventory.resolve(client, { tenantId: scope.tenantId, principalId: identityScope.principalId },
        identityScope.resourceTypes, { nativeId: row.sourceTable === "AgentsInfo" ? row.agentId : row.reportId ?? row.spanId ?? "unidentified",
        tenantId: scope.tenantId, environmentId: null, sourceSystem: "defender_hunting", resourceType: `microsoft.defender/${row.sourceTable}`, identifiers },
      { blueprintParentAcrossSources: true });
      if (resolution.status === "resolved") result.push({ status: "resolved" as const, sourceSystem: resolution.candidate.sourceSystem as "power_platform" | "graph_packages",
        nativeId: resolution.candidate.nativeId, resourceType: resolution.candidate.resourceType, environmentId: resolution.candidate.environmentId, matchedKind: "entra_agent_id" as const });
      else if (resolution.status === "ambiguous") result.push({ status: "ambiguous" as const, reason: resolution.reason, candidateCount: resolution.candidateCount ?? resolution.candidates.length });
      else result.push({ status: "unresolved" as const, reason: resolution.reason });
    }
    return result;
    });
  }

  private async fence(client: Pick<pg.Pool | pg.PoolClient, "query">, scope: DefenderHuntingScope, id: string, execution: DefenderHuntingExecution) {
    const result = await client.query<JobRow>(`SELECT job.*,(SELECT snapshot.id FROM defender_hunting_snapshots snapshot WHERE snapshot.job_id=job.id) AS snapshot_id
      FROM defender_hunting_jobs job WHERE job.id=$1 AND job.tenant_id=$2 AND job.result_scope_kind=$3 AND job.result_scope_id=$4
        AND job.result_scope_configuration_revision IS NOT DISTINCT FROM $5 AND job.authorization_principal_id=$6 AND job.token_mode=$7
        AND job.execution_owner=$8 AND job.execution_version=$9 AND job.status='running' AND NOT job.cancel_requested FOR UPDATE`,
    [id, scope.tenantId, scope.resultScope.kind, scope.resultScope.scopeId, scope.resultScope.configurationRevision,
      scope.authorizationPrincipalId, scope.tokenMode, execution.owner, execution.version]);
    if (!result.rows[0]) throw executionLost();
    return result.rows[0];
  }
}

function validateScope(scope: DefenderHuntingScope) {
  validateReadScope(toReadScope(scope));
  if (!scope.authorizationPrincipalId) throw new AppError(403, "scope_mismatch", "Hunting requires an exact current authorization scope.");
  if (scope.tokenMode === "delegated" && (scope.resultScope.kind !== "principal" || scope.resultScope.scopeId !== scope.authorizationPrincipalId)) throw new AppError(403, "scope_mismatch", "Delegated hunting results must remain scoped to the authorizing principal.");
  if (scope.tokenMode === "application" && scope.resultScope.kind !== "application") throw new AppError(403, "scope_mismatch", "Application hunting results require the configured shared application scope.");
}

function validateReadScope(scope: DefenderHuntingReadScope) {
  if (!scope.tenantId || !scope.authorizationPrincipalId || !scope.resultScopes.length || scope.resultScopes.length > 2 || scope.resultScopes.some(resultScope => !resultScope.scopeId
    || resultScope.kind === "principal" && resultScope.configurationRevision !== null
    || resultScope.kind === "application" && (!Number.isSafeInteger(resultScope.configurationRevision) || resultScope.configurationRevision < 1))) {
    throw new AppError(403, "scope_mismatch", "Hunting requires an exact current result scope.");
  }
  if (scope.resultScopes.some(resultScope => resultScope.kind === "principal" && resultScope.scopeId !== scope.authorizationPrincipalId)) {
    throw new AppError(403, "scope_mismatch", "Delegated hunting results must remain private to the current principal.");
  }
}

function toReadScope(scope: DefenderHuntingReadScope | DefenderHuntingScope): DefenderHuntingReadScope {
  return "resultScope" in scope ? { tenantId: scope.tenantId, authorizationPrincipalId: scope.authorizationPrincipalId, resultScopes: [scope.resultScope] } : scope;
}

function scopedWhere(scope: DefenderHuntingReadScope, alias = "job") {
  validateReadScope(scope);
  const values: unknown[] = [scope.tenantId];
  const clauses = scope.resultScopes.map(resultScope => {
    const offset = values.length + 1;
    values.push(resultScope.kind, resultScope.scopeId, resultScope.configurationRevision);
    return `(${alias}.result_scope_kind=$${offset} AND ${alias}.result_scope_id=$${offset + 1} AND ${alias}.result_scope_configuration_revision IS NOT DISTINCT FROM $${offset + 2})`;
  });
  const agent = agentScopePredicate(scope, `${alias}.filters`, values);
  return { sql: `${alias}.tenant_id=$1 AND (${clauses.join(" OR ")})${agent}`, values };
}

function agentScopePredicate(scope: DefenderHuntingReadScope, filters: string, values: unknown[]) {
  let user = "";
  if (scope.userObjectId !== undefined) {
    if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(scope.userObjectId)) {
      throw new AppError(403, "scope_mismatch", "An exact directory user identity is required.");
    }
    values.push(scope.userObjectId);
    user = ` AND ${filters}->>'userObjectId'=$${values.length}`;
  }
  if (scope.entraAgentIds === undefined && scope.entraAgentApplicationIds === undefined) return user;
  const objects = scope.entraAgentIds ?? [];
  const applications = scope.entraAgentApplicationIds ?? [];
  if (!objects.length && !applications.length || [objects, applications].some(ids => ids.length > 1
    || ids.some(id => !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id)))) {
    throw new AppError(403, "scope_mismatch", "An exact server-derived Entra agent identity is required.");
  }
  const clauses: string[] = [];
  if (objects.length) {
    values.push(JSON.stringify(objects));
    clauses.push(`(${filters}->>'templateId'='agents_inventory' AND ${filters}->'entraAgentIds'=$${values.length}::jsonb
      AND COALESCE(${filters}->'entraAgentApplicationIds','[]'::jsonb)='[]'::jsonb)`);
  }
  if (applications.length) {
    values.push(JSON.stringify(applications));
    clauses.push(`(${filters}->>'templateId' IN ('agent_activity','agent_tools') AND ${filters}->'entraAgentApplicationIds'=$${values.length}::jsonb
      AND COALESCE(${filters}->'entraAgentIds','[]'::jsonb)='[]'::jsonb)`);
  }
  return `${user} AND (${clauses.join(" OR ")}) AND ${filters}->'agentIds'='[]'::jsonb AND ${filters}->'blueprintIds'='[]'::jsonb`;
}

function requestHash(scope: DefenderHuntingScope, filters: DefenderHuntingFilters) {
  return createHash("sha256").update(JSON.stringify({ cloud: "global", tenantId: scope.tenantId, authorizationPrincipalId: scope.authorizationPrincipalId,
    resultScope: scope.resultScope, tokenMode: scope.tokenMode, filters })).digest("hex");
}

function priorSuccessfulJobSelect(alias: string) {
  return `CASE WHEN ${alias}.status IN ('failed','cancelled','inconclusive') THEN
    (SELECT previous.id FROM defender_hunting_jobs previous JOIN defender_hunting_snapshots snapshot ON snapshot.job_id=previous.id
      WHERE previous.tenant_id=${alias}.tenant_id AND previous.authorization_principal_id=${alias}.authorization_principal_id
        AND previous.result_scope_kind=${alias}.result_scope_kind AND previous.result_scope_id=${alias}.result_scope_id
        AND previous.result_scope_configuration_revision IS NOT DISTINCT FROM ${alias}.result_scope_configuration_revision
        AND previous.token_mode=${alias}.token_mode AND previous.template_id=${alias}.template_id
        AND previous.target_scope_hash=${alias}.target_scope_hash AND previous.status='succeeded'
        AND previous.finished_at<=${alias}.created_at AND previous.expires_at>clock_timestamp() AND snapshot.expires_at>clock_timestamp()
      ORDER BY previous.finished_at DESC,previous.id DESC LIMIT 1) END`;
}

function huntingTargetScope(filters: DefenderHuntingFilters) {
  return { templateId: filters.templateId, agentIds: [...filters.agentIds].sort(ordinal), blueprintIds: [...filters.blueprintIds].sort(ordinal),
    actorObjectIds: [...filters.actorObjectIds].sort(ordinal), operations: [...filters.operations].sort(ordinal),
    ...(filters.userObjectId !== undefined ? { userObjectId: filters.userObjectId } : {}),
    ...(filters.entraAgentIds !== undefined ? { entraAgentIds: [...filters.entraAgentIds].sort(ordinal) } : {}),
    ...(filters.entraAgentApplicationIds !== undefined ? { entraAgentApplicationIds: [...filters.entraAgentApplicationIds].sort(ordinal) } : {}) };
}

function huntingTargetScopeHash(filters: DefenderHuntingFilters) {
  return createHash("sha256").update(JSON.stringify(huntingTargetScope(filters))).digest("hex");
}

function validatePublicationEnvelope(result: DefenderHuntingQueryResult) {
  if (result.rows.length !== result.storedRowCount || result.rows.length > 200 || result.providerRowCount > 201 || result.byteCount > 2_000_000
    || result.complete !== (result.partialReason === null) || result.providerRowCount < result.storedRowCount
    || result.complete && result.providerRowCount !== result.storedRowCount || !result.complete && result.providerRowCount !== 201) {
    throw new AppError(409, "invalid_hunting_publication", "Hunting publication exceeded the minimized result contract.");
  }
}

const inventoryPublicationKeys = new Set(["projectionVersion", "sourceTable", "observationTime", "agentId", "agentName", "platform", "agentDescription",
  "version", "sourceAgentId", "entraAgentObjectId", "entraBlueprintId", "observabilityId", "publishedStatus", "lifecycleStatus", "availability",
  "createdDateTime", "lastPublishedDateTime", "lastUpdatedDateTime", "instanceCount", "model", "ownerCount", "sharedWithCount",
  "permissionMetadataKeyCount", "authenticationMetadataKeyCount", "detailStates"]);
const activityPublicationKeys = new Set(["projectionVersion", "sourceTable", "timestamp", "actionType", "cloudApplication", "cloudApplicationId", "cloudAppInstanceId",
  "actorAccountObjectId", "actorProviderAccountId", "objectId", "reportId", "oauthAppId", "operation", "organizationId", "targetAgentId", "targetAgentName",
  "targetAgentBlueprintId", "agentId", "agentName", "agentBlueprintId", "alternatePlatformAgentId", "platformAgentType", "conversationId",
  "conversationThreadId", "sessionIdentity", "channelName", "humanActorUserObjectId", "humanActorUserPrincipalName", "agentUserObjectId",
  "agentUserPrincipalName", "targetAgentUserObjectId", "spanId", "parentSpanId", "creationTime", "completionTime", "errorType", "toolName", "toolType",
  "toolCallId", "invokeSource", "durationMilliseconds", "outcome", "spanRole", "rootSpanObserved", "fieldStates", "contentAvailable"]);
const inventoryDetailStateKeys = ["owners", "sharing", "permissions", "authentication", "risk"] as const;
const inventoryDetailStates = new Set(["not_supplied", "empty", "present_unqualified_shape", "not_exposed"]);
const activityFieldStateKeys = ["conversationId", "conversationThreadId", "channelName", "humanActorUserObjectId", "agentUserObjectId",
  "targetAgentUserObjectId", "completionTime", "errorType", "platformAgentId", "platformAgentType"] as const;
const activityFieldStates = new Set(["value", "null", "empty", "unavailable"]);

function validatePublicationRows(rows: DefenderHuntingRow[], filters: DefenderHuntingFilters, tenantId: string) {
  if (filters.templateId === "agents_inventory" ? filters.entraAgentApplicationIds?.length : filters.entraAgentIds?.length) throw invalidPublication();
  const expectedSource = defenderHuntingTemplates[filters.templateId].sourceTable;
  const start = Date.parse(filters.startDateTime); const end = Date.parse(filters.endDateTime);
  const selectedBlueprintIds = filters.blueprintIds.map(value => value.toLowerCase());
  const selectedActorIds = filters.actorObjectIds.map(value => value.toLowerCase());
  for (const row of rows) {
    const keys = row.sourceTable === "AgentsInfo" ? inventoryPublicationKeys : activityPublicationKeys;
    if (!isPlainObject(row) || row.projectionVersion !== 3 || row.sourceTable !== expectedSource
      || Object.keys(row).some(key => !keys.has(key)) || Object.keys(row).length !== keys.size
      || !hasOnlyTypedPrimitives(row, row.sourceTable === "AgentsInfo" ? "detailStates" : "fieldStates")) throw invalidPublication();
    const timestamp = Date.parse(row.sourceTable === "AgentsInfo" ? row.observationTime : row.timestamp);
    if (!Number.isFinite(timestamp) || timestamp < start || timestamp > end) throw invalidPublication();
    if (row.sourceTable === "AgentsInfo") {
      if (!row.agentId || row.agentId.length > 512 || !isExactStateRecord(row.detailStates, inventoryDetailStateKeys, inventoryDetailStates)
        || inventoryDetailStateKeys.some(key => (key === "risk") !== (row.detailStates[key] === "not_exposed"))
        || filters.agentIds.length && !filters.agentIds.includes(row.agentId)
        || filters.entraAgentIds?.length && (!row.entraAgentObjectId || !filters.entraAgentIds.includes(row.entraAgentObjectId.toLowerCase()))
        || selectedBlueprintIds.length && (!row.entraBlueprintId || !selectedBlueprintIds.includes(row.entraBlueprintId.toLowerCase()))) throw invalidPublication();
      continue;
    }
    const expectedOperations = row.actionType === "InvokeAgent" ? ["invoke_agent"] : row.actionType === "InferenceCall" ? ["chat", "output_messages"] : ["execute_tool"];
    const agents = [row.targetAgentId, row.agentId, row.alternatePlatformAgentId];
    const blueprints = [row.targetAgentBlueprintId, row.agentBlueprintId];
    const rootSpanObserved = row.actionType === "InvokeAgent" && row.operation === "invoke_agent" && row.spanId !== null && row.parentSpanId === null;
    if (!filters.operations.includes(row.actionType) || !row.operation || !expectedOperations.includes(row.operation)
      || row.organizationId && row.organizationId !== tenantId.toLowerCase()
      || filters.agentIds.length && !agents.some(value => value && filters.agentIds.includes(value))
      || filters.entraAgentApplicationIds?.length && ![row.targetAgentId, row.agentId].some(value => value && filters.entraAgentApplicationIds!.includes(value.toLowerCase()))
      || selectedBlueprintIds.length && !blueprints.some(value => value && selectedBlueprintIds.includes(value.toLowerCase()))
      || selectedActorIds.length && (!row.actorAccountObjectId || !selectedActorIds.includes(row.actorAccountObjectId.toLowerCase()))
      || filters.userObjectId && (row.actionType !== "InvokeAgent" || row.humanActorUserObjectId !== filters.userObjectId)
      || row.rootSpanObserved !== rootSpanObserved || row.spanRole !== (rootSpanObserved ? "root_invoke_agent" : row.parentSpanId ? "child" : "unresolved")
      || !defenderHuntingFieldAvailable(row.actionType, "humanActorUserObjectId") && row.humanActorUserPrincipalName !== null
      || !defenderHuntingFieldAvailable(row.actionType, "agentUserObjectId") && row.agentUserPrincipalName !== null
      || row.contentAvailable !== false || !isExactStateRecord(row.fieldStates, activityFieldStateKeys, activityFieldStates)
      || activityFieldStateKeys.some(key => {
        const state = row.fieldStates[key];
        const value = key === "platformAgentId" ? row.alternatePlatformAgentId : row[key];
        return (state !== "unavailable") !== defenderHuntingFieldAvailable(row.actionType, key)
          || (state === "value" ? typeof value !== "string" || value === "" : value !== null);
      })) throw invalidPublication();
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function hasOnlyTypedPrimitives(value: Record<string, unknown>, nestedStateKey: string) {
  return Object.entries(value).every(([key, field]) => key === nestedStateKey && isPlainObject(field)
    || field === null || typeof field === "string" || typeof field === "boolean" || typeof field === "number" && Number.isFinite(field));
}
function isExactStateRecord(value: unknown, keys: readonly string[], states: ReadonlySet<string>) {
  return isPlainObject(value) && Object.keys(value).sort(ordinal).join(",") === [...keys].sort(ordinal).join(",")
    && keys.every(key => typeof value[key] === "string" && states.has(value[key]));
}
function invalidPublication() { return new AppError(409, "invalid_hunting_publication", "Hunting rows did not match the exact minimized request and publication allowlist."); }
function ordinal(left: string, right: string) { return left < right ? -1 : left > right ? 1 : 0; }

function projectResultScope(row: Pick<JobRow | SnapshotRow, "result_scope_kind" | "result_scope_id" | "result_scope_configuration_revision">): DefenderHuntingResultScope {
  return row.result_scope_kind === "application"
    ? { kind: "application", scopeId: row.result_scope_id, configurationRevision: Number(row.result_scope_configuration_revision) }
    : { kind: "principal", scopeId: row.result_scope_id, configurationRevision: null };
}

function projectJob(row: JobRow): DefenderHuntingJob {
  return { id: row.id, authorizationPrincipalId: row.authorization_principal_id, resultScope: projectResultScope(row), tokenMode: row.token_mode,
    origin: parseStoredOrigin(row.origin), initiatingActor: row.initiating_actor ?? null,
    status: row.status, filters: row.filters, queryVersion: row.query_version, localRequestId: row.local_request_id,
    providerRequestId: row.provider_request_id, providerRequestCount: row.provider_request_count, activationCount: row.activation_count,
    providerRowCount: row.provider_row_count, storedRowCount: row.stored_row_count, byteCount: row.byte_count, complete: row.result_complete,
    noData: row.no_data, partialReason: row.partial_reason, observedRange: range(row.observed_start, row.observed_end),
    unobservedRange: range(row.unobserved_start, row.unobserved_end), snapshotId: row.snapshot_id,
    priorSuccessfulJobId: row.prior_successful_job_id ?? null,
    ...(row.error_code ? { errorCode: row.error_code } : {}), ...(row.message ? { message: row.message } : {}), cancelRequested: row.cancel_requested,
    createdAt: row.created_at.toISOString(), attemptedAt: row.attempted_at?.toISOString() ?? null, updatedAt: row.updated_at.toISOString(),
    finishedAt: row.finished_at?.toISOString() ?? null, expiresAt: row.expires_at.toISOString(),
    canResume: row.status === "waiting_authorization" && !row.cancel_requested && row.deadline_at > new Date()
      && row.activation_count < 4 && row.provider_request_count < 12 };
}

function projectSnapshot(row: SnapshotRow): DefenderHuntingSnapshot {
  return { id: row.id, jobId: row.job_id, resultScope: projectResultScope(row), filters: row.filters, sourceTable: row.source_table,
    queryVersion: row.query_version, requestedRange: { startDateTime: row.requested_start.toISOString(), endDateTime: row.requested_end.toISOString() },
    observedRange: range(row.observed_start, row.observed_end), unobservedRange: range(row.unobserved_start, row.unobserved_end),
    observationTime: row.observation_time.toISOString(), complete: row.result_complete, noData: row.no_data, partialReason: row.partial_reason,
    providerRowCount: row.provider_row_count, storedRowCount: row.stored_row_count, byteCount: row.byte_count, expiresAt: row.expires_at.toISOString() };
}

function range(start: Date | null, end: Date | null) {
  return start && end ? { startDateTime: start.toISOString(), endDateTime: end.toISOString() } : null;
}

function executionLost() {
  return new AppError(409, "hunting_execution_lost", "Hunting execution was stopped or replaced; stale results were not committed.");
}

function safeCode(value: string) {
  return /^[a-z0-9_]{1,128}$/.test(value) ? value : "provider_error";
}