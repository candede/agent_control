import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";
import { AppError } from "../errors.js";
import { requireProviderAdmissions } from "../services/operationalState.js";
import { refreshCancellation, type RefreshCancellationReason } from "../services/refreshExecution.js";
import { powerPlatformResourceTypes, type InventoryRefreshJob, type InventoryRefreshJobList,
  type InventoryRoleScope, type PowerPlatformResourceType } from "../types/powerPlatformInventory.js";
import { pool, transaction } from "./pool.js";

export type InventoryDataScope = { tenantId: string; principalId: string };
export type InventoryRefreshInput = {
  roleScope: InventoryRoleScope;
  environmentScope?: string;
  requestedTypes: readonly PowerPlatformResourceType[];
  idempotencyKey: string;
};
type JobRow = {
  id: string;
  role_scope: InventoryRoleScope;
  environment_scope: string;
  requested_types: PowerPlatformResourceType[];
  status: InventoryRefreshJob["status"];
  page_count: number;
  observed_count: number;
  total_records: number | null;
  unknown_field_count: number;
  error_code: string | null;
  message: string | null;
  created_at: Date;
  attempted_at: Date | null;
  updated_at: Date;
  finished_at: Date | null;
  snapshot_id: string | null;
};
const jobColumns = `job.id,job.role_scope,job.environment_scope,job.requested_types,job.status,job.page_count,
  job.observed_count,job.total_records,job.unknown_field_count,job.error_code,job.message,job.created_at,
  job.attempted_at,job.updated_at,job.finished_at`;

export class PowerPlatformRefreshJobs {
  constructor(readonly database: pg.Pool = pool) {}

  async submit(scope: InventoryDataScope, input: InventoryRefreshInput) {
    requireProviderAdmissions();
    validateScope(scope);
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(input.idempotencyKey)) throw new AppError(400, "invalid_idempotency_key", "Idempotency-Key must contain 1-128 letters, digits, underscores or hyphens.");
    if (!(["full", "ai", "unknown"] as const).includes(input.roleScope)) throw new AppError(400, "invalid_inventory_scope", "Inventory role scope is invalid.");
    const requestedTypes = validateTypes(input.requestedTypes), environmentScope = validateEnvironment(input.environmentScope);
    const requestHash = queryHash(environmentScope, requestedTypes);
    const id = await transaction(this.database, async client => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`power-platform:${scope.tenantId}:${scope.principalId}`]);
      const existing = (await client.query<Pick<JobRow, "id" | "environment_scope" | "requested_types">>(`
        SELECT id,environment_scope,requested_types FROM power_platform_refresh_jobs
        WHERE tenant_id=$1 AND principal_id=$2 AND idempotency_key=$3`, [scope.tenantId, scope.principalId, input.idempotencyKey])).rows[0];
      if (existing) {
        if (queryHash(existing.environment_scope, existing.requested_types) !== requestHash) throw new AppError(409, "idempotency_mismatch", "This idempotency key already belongs to a different inventory request.");
        return existing.id;
      }
      const outstanding = await client.query(`SELECT count(*)::int AS count FROM power_platform_refresh_jobs
        WHERE tenant_id=$1 AND principal_id=$2 AND status IN ('waiting_authorization','running') AND expires_at>clock_timestamp()`,
      [scope.tenantId, scope.principalId]);
      if (outstanding.rows[0].count >= 5) throw new AppError(429, "job_limit", "At most five unfinished inventory refresh jobs are allowed per principal.");
      const jobId = randomUUID();
      await client.query(`INSERT INTO power_platform_refresh_jobs
        (id,tenant_id,principal_id,idempotency_key,request_hash,role_scope,environment_scope,requested_types)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`, [jobId, scope.tenantId, scope.principalId, input.idempotencyKey,
        requestHash, input.roleScope, environmentScope, JSON.stringify(requestedTypes)]);
      return jobId;
    });
    const job = await this.getJob(scope, id);
    if (!job) throw new AppError(409, "inventory_job_expired", "The inventory refresh expired. Submit a new refresh with a new idempotency key.");
    return job;
  }

  async getJob(scope: InventoryDataScope, id: string) {
    validateScope(scope);
    const { rows } = await this.database.query<JobRow>(`SELECT ${jobColumns},snapshot.id AS snapshot_id
      FROM power_platform_refresh_jobs job LEFT JOIN data_generations snapshot ON snapshot.job_id=job.id AND snapshot.state IN ('published','retired')
      WHERE job.id=$1 AND job.tenant_id=$2 AND job.principal_id=$3 AND job.expires_at>clock_timestamp()`, [id, scope.tenantId, scope.principalId]);
    return rows[0] ? projectJob(rows[0]) : undefined;
  }

  async listJobs(scope: InventoryDataScope, limit = 20): Promise<InventoryRefreshJobList> {
    validateScope(scope);
    const boundedLimit = Math.min(Math.max(limit, 1), 50);
    const { rows } = await this.database.query<JobRow>(`SELECT ${jobColumns},snapshot.id AS snapshot_id
      FROM power_platform_refresh_jobs job LEFT JOIN data_generations snapshot ON snapshot.job_id=job.id AND snapshot.state IN ('published','retired')
      WHERE job.tenant_id=$1 AND job.principal_id=$2 AND job.expires_at>clock_timestamp()
      ORDER BY job.created_at DESC,job.id DESC LIMIT $3`, [scope.tenantId, scope.principalId, boundedLimit]);
    const summary = await this.database.query<{ last_attempt_at: Date | null; last_success_at: Date | null }>(`SELECT
      (SELECT max(attempted_at) FROM power_platform_refresh_jobs WHERE tenant_id=$1 AND principal_id=$2 AND expires_at>clock_timestamp()) AS last_attempt_at,
      (SELECT max(g.observed_at) FROM data_generations g JOIN data_scope_epochs s ON s.id=g.scope_id
        WHERE s.tenant_id=$1 AND s.principal_id=$2 AND s.source='inventory_power_platform'
          AND g.state='published' AND g.scope_epoch=s.epoch AND g.session_epoch=s.session_epoch
          AND g.validated AND EXISTS(SELECT 1 FROM inventory_roots r JOIN inventory_revisions v
            ON v.scope_id=r.scope_id AND v.revision=r.revision
            WHERE r.current AND r.scope_id=s.id AND v.generation_id=g.id)) AS last_success_at`,
    [scope.tenantId, scope.principalId]);
    return { value: rows.map(projectJob), lastAttemptAt: summary.rows[0].last_attempt_at?.toISOString() ?? null,
      lastSuccessAt: summary.rows[0].last_success_at?.toISOString() ?? null };
  }

  async markRunning(scope: InventoryDataScope, id: string) {
    const result = await this.database.query(`UPDATE power_platform_refresh_jobs SET status='running',attempted_at=clock_timestamp(),
      updated_at=clock_timestamp(),error_code=NULL,message=NULL WHERE id=$1 AND tenant_id=$2 AND principal_id=$3
        AND status='waiting_authorization' AND expires_at>clock_timestamp() AND deadline_at>clock_timestamp() RETURNING id`,
    [id, scope.tenantId, scope.principalId]);
    return result.rowCount === 1;
  }

  async recordProgress(scope: InventoryDataScope, id: string, pageCount: number, observedCount: number, totalRecords: number) {
    const result = await this.database.query(`UPDATE power_platform_refresh_jobs SET page_count=$4,observed_count=$5,total_records=$6,
      updated_at=clock_timestamp() WHERE id=$1 AND tenant_id=$2 AND principal_id=$3 AND status='running'
        AND expires_at>clock_timestamp() AND deadline_at>clock_timestamp()`,
    [id, scope.tenantId, scope.principalId, pageCount, observedCount, totalRecords]);
    if (result.rowCount !== 1) throw new AppError(409, "inventory_job_expired", "Inventory refresh progress arrived after its job expired or stopped.");
  }

  async markWaitingAuthorization(scope: InventoryDataScope, id: string) {
    await this.database.query(`UPDATE power_platform_refresh_jobs SET
      status=CASE WHEN expires_at>clock_timestamp() AND deadline_at>clock_timestamp() THEN 'waiting_authorization' ELSE 'failed' END,
      error_code=CASE WHEN expires_at>clock_timestamp() AND deadline_at>clock_timestamp() THEN 'interaction_required' ELSE 'inventory_job_expired' END,
      message=CASE WHEN expires_at>clock_timestamp() AND deadline_at>clock_timestamp() THEN 'Current delegated authorization is required.' ELSE 'The inventory refresh deadline expired.' END,
      finished_at=CASE WHEN expires_at>clock_timestamp() AND deadline_at>clock_timestamp() THEN NULL ELSE clock_timestamp() END,
      updated_at=clock_timestamp() WHERE id=$1 AND tenant_id=$2 AND principal_id=$3 AND status='running'`,
    [id, scope.tenantId, scope.principalId]);
    return this.getJob(scope, id);
  }

  async recoverInterrupted() {
    const waiting = await this.database.query(`WITH candidates AS (
      SELECT id FROM power_platform_refresh_jobs WHERE status='running' AND expires_at>clock_timestamp()
        AND deadline_at>clock_timestamp() ORDER BY updated_at,id LIMIT 250 FOR UPDATE SKIP LOCKED)
      UPDATE power_platform_refresh_jobs job SET status='waiting_authorization',error_code='interaction_required',
        message='Explicit resume with current delegated authorization is required.',updated_at=clock_timestamp()
      FROM candidates WHERE job.id=candidates.id`);
    const expired = await this.database.query(`WITH candidates AS (
      SELECT id FROM power_platform_refresh_jobs WHERE status='running' AND (expires_at<=clock_timestamp() OR deadline_at<=clock_timestamp())
        ORDER BY updated_at,id LIMIT 250 FOR UPDATE SKIP LOCKED)
      UPDATE power_platform_refresh_jobs job SET status='failed',error_code='inventory_job_expired',
        message='The inventory refresh expired before recovery.',finished_at=clock_timestamp(),updated_at=clock_timestamp()
      FROM candidates WHERE job.id=candidates.id`);
    return (waiting.rowCount ?? 0) + (expired.rowCount ?? 0);
  }

  async markFailed(scope: InventoryDataScope, id: string, code: string, message: string) {
    await this.database.query(`UPDATE power_platform_refresh_jobs SET status='failed',error_code=$4,message=$5,
      finished_at=clock_timestamp(),updated_at=clock_timestamp()
      WHERE id=$1 AND tenant_id=$2 AND principal_id=$3 AND status IN ('running','waiting_authorization')`,
    [id, scope.tenantId, scope.principalId, safeCode(code), message.slice(0, 1024)]);
    return this.getJob(scope, id);
  }

  async cancel(scope: InventoryDataScope, id: string, reason: RefreshCancellationReason = "requested") {
    validateScope(scope);
    const cancellation = refreshCancellation(reason);
    await this.database.query(`UPDATE power_platform_refresh_jobs SET status='cancelled',error_code=$4,message=$5,
      finished_at=clock_timestamp(),updated_at=clock_timestamp()
      WHERE id=$1 AND tenant_id=$2 AND principal_id=$3 AND status IN ('waiting_authorization','running') AND expires_at>clock_timestamp()`,
    [id, scope.tenantId, scope.principalId, cancellation.code, cancellation.message]);
    return this.getJob(scope, id);
  }
}

function projectJob(row: JobRow): InventoryRefreshJob {
  return { id: row.id, status: row.status, roleScope: row.role_scope, environmentScope: row.environment_scope || null,
    requestedTypes: row.requested_types, pageCount: row.page_count, observedCount: row.observed_count,
    totalRecords: row.total_records, unknownFieldCount: row.unknown_field_count, snapshotId: row.snapshot_id,
    ...(row.error_code ? { errorCode: row.error_code } : {}), ...(row.message ? { message: row.message } : {}),
    createdAt: row.created_at.toISOString(), attemptedAt: row.attempted_at?.toISOString() ?? null,
    updatedAt: row.updated_at.toISOString(), finishedAt: row.finished_at?.toISOString() ?? null };
}
function validateScope(scope: InventoryDataScope) {
  if (!scope.tenantId || !scope.principalId) throw new AppError(403, "scope_mismatch", "Inventory requires a tenant and current principal scope.");
}
function validateTypes(types: readonly PowerPlatformResourceType[]) {
  const allowed = new Set<string>(powerPlatformResourceTypes), unique = [...new Set(types)].sort(ordinal);
  if (!unique.length || unique.some(type => !allowed.has(type))) throw new AppError(400, "invalid_inventory_scope", "Inventory resource types must use the supported allowlist.");
  return unique;
}
function validateEnvironment(value: string | undefined) {
  if (value === undefined || value === "") return "";
  if (typeof value !== "string" || value.length > 512 || /[\r\n\0]/.test(value)) throw new AppError(400, "invalid_inventory_scope", "Inventory environment scope is invalid.");
  return value;
}
function queryHash(environmentScope: string, requestedTypes: readonly PowerPlatformResourceType[]) {
  return createHash("sha256").update(JSON.stringify({ cloud: "global", environmentScope, requestedTypes })).digest("hex");
}
function safeCode(value: string) { return /^[a-z0-9_]{1,128}$/.test(value) ? value : "provider_error"; }
function ordinal(left: string, right: string) { return left < right ? -1 : left > right ? 1 : 0; }
