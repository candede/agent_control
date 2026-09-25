import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";
import { AppError } from "../errors.js";
import { dataSyncFailureStatus } from "../types/dataSync.js";
import { packageInventoryIdentity } from "../services/inventoryIdentity.js";
import { requireProviderAdmissions } from "../services/operationalState.js";
import { refreshCancellation, type RefreshCancellationReason } from "../services/refreshExecution.js";
import { packageRefreshExecutionDeadlineMs } from "../services/packageRefreshPolicy.js";
import { packageControlIdentityChanged, projectPackageControl, type SavedPackageControl } from "../services/packageControlProjection.js";
import { capturePackageMutationState, packageMutationStatesEqual, type PackageMutationState } from "../services/packageMutationState.js";
import { packageDetailRevision, projectPackageDetails } from "../services/packageDetailProjection.js";
import {
  formatAgentAuthoringTool, formatPackageFacetLabel as formatFacetLabel, normalizePackageAuthoringTool as normalizeBuiltWith,
  normalizePackageStatus, packageStatusAliases,
  type CopilotPackageDetail,
} from "../types/copilotPackage.js";
import { pool, transaction } from "./pool.js";

export type PackageDataScope = { tenantId: string; principalId: string };
export type PackageRefreshInput = {
  authorizationPrincipalId: string;
  tokenMode: "delegated" | "application";
  idempotencyKey: string;
  requestedIds?: readonly string[];
  catalogOnly?: boolean;
};
export type PackageListQuery = {
  snapshotId?: string;
  ids?: readonly string[];
  search?: string;
  blocked?: boolean;
  publisher?: string;
  availableTo?: string;
  deployedTo?: string;
  host?: string;
  platform?: string;
  createdWithinDays?: number;
  operationIdPrefix?: string;
  auditPrincipalId?: string;
  sortBy?: "displayName" | "publisher" | "lastModifiedAt";
  sortDirection?: "asc" | "desc";
  limit?: number;
  offset?: number;
};
export type PackageFacetOption = { value: string; label: string };
export type PackageListResult = {
  value: CopilotPackageDetail[];
  count: number;
  snapshot: ReturnType<typeof projectSnapshot> | null;
  summary: { total: number; allowed: number; blocked: number };
  filteredSummary: { total: number; allowed: number; blocked: number };
  facets: {
    publishers: PackageFacetOption[];
    availability: PackageFacetOption[];
    hosts: PackageFacetOption[];
    platforms: PackageFacetOption[];
  };
};
export type UnifiedPackageSourceResult = {
  packages: CopilotPackageDetail[];
  observations: Record<string, {
    snapshotId: string;
    scopeKind: "broad" | "exact";
    observedAt: string;
    expiresAt: string;
    identityDetails?: {
      snapshotId: string;
      observedAt: string;
      expiresAt: string;
    };
  }>;
  snapshot: ReturnType<typeof projectSnapshot> | null;
};
export type PackageScanResult = {
  packages: CopilotPackageDetail[];
  totalRecords: number;
  pages: number;
  detailFailures?: Array<{ id: string; missing: boolean; errorCode: string }>;
};

type JobRow = {
  id: string;
  authorization_principal_id: string;
  token_mode: PackageRefreshInput["tokenMode"];
  request_hash: string;
  query_hash: string;
  scope_kind: "broad" | "exact";
  requested_ids: string[];
  catalog_only: boolean;
  auto_details: boolean;
  detail_targets: Array<{ id: string; generation: string }>;
  status: "waiting_authorization" | "running" | "succeeded" | "failed" | "cancelled";
  page_count: number;
  observed_count: number;
  total_records: number | null;
  error_code: string | null;
  message: string | null;
  created_at: Date;
  attempted_at: Date | null;
  updated_at: Date;
  finished_at: Date | null;
  deadline_at: Date;
  snapshot_id: string | null;
};

type SnapshotRow = {
  id: string;
  token_mode: PackageRefreshInput["tokenMode"];
  scope_kind: "broad" | "exact";
  requested_ids: string[];
  observed_count: number;
  total_records: number;
  page_count: number;
  observed_at: Date;
  read_started_at: Date;
  catalog_only?: boolean;
  expires_at: Date;
};

type ResourceRow = {
  package_data: CopilotPackageDetail;
};

type SnapshotQuery = Pick<JobRow, "token_mode" | "query_hash" | "scope_kind" | "requested_ids"> & { catalog_only?: boolean };

export async function lockPackageInventoryScope(scope: PackageDataScope, client: pg.PoolClient) {
  validateScope(scope);
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`package-refresh:${scope.tenantId}:${scope.principalId}`]);
}

export async function readPackageInventoryGeneration(scope: PackageDataScope, database: Pick<pg.Pool, "query">) {
  validateScope(scope);
  const result = await database.query<{ id: string }>(`SELECT id FROM data_sync_runs
    WHERE tenant_id=$1 AND principal_id=$2 AND clear_saved_data
    ORDER BY started_at DESC,id DESC LIMIT 1`, [scope.tenantId, scope.principalId]);
  return result.rows[0]?.id ?? null;
}

// The caller's transaction also commits the fenced job outcome and its audit receipt.
export async function publishPackageReadback(scope: PackageDataScope, detail: CopilotPackageDetail, client: pg.PoolClient,
  inventoryGeneration: string | null, state: PackageMutationState) {
  await lockPackageInventoryScope(scope, client);
  if (await readPackageInventoryGeneration(scope, client) !== inventoryGeneration) {
    throw new AppError(409, "package_readback_superseded", "Saved inventory was cleared during package work. Reconcile the exact target before publishing a new observation.");
  }
  if (!packageMutationStatesEqual(capturePackageMutationState(detail, state.kind === "block" ? "block" : "update-availability"), state)) {
    throw new AppError(409, "mutation_readback_mismatch", "Only verified package control state can be published.");
  }
  const requestedIds = normalizeRequestedIds([detail.id]);
  const previous = await readSavedPackageTarget(client, scope, detail.id, "delegated");
  const identityRevalidationRequired = Boolean(previous?.package
    && (previous.package.identityRevalidationRequired || packageControlIdentityChanged(previous.package, detail)));
  return writePackageSnapshot(client, scope, {
    token_mode: "delegated", scope_kind: "exact", requested_ids: requestedIds,
    query_hash: hash({ tokenMode: "delegated", scopeKind: "exact", requestedIds, observationKind: state.kind }),
  }, null, { packages: [detail], totalRecords: 1, pages: 1 }, { controlState: state, identityRevalidationRequired });
}

export class PackageInventoryRepository {
  constructor(private readonly database: pg.Pool = pool) {}

  async submit(scope: PackageDataScope, input: PackageRefreshInput) {
    requireProviderAdmissions();
    validateScope(scope);
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(input.idempotencyKey)) {
      throw new AppError(400, "invalid_idempotency_key", "Idempotency-Key must contain 1-128 letters, digits, underscores or hyphens.");
    }
    if (!input.authorizationPrincipalId || input.authorizationPrincipalId.length > 256) {
      throw new AppError(400, "invalid_authorization_principal", "The package refresh authorization principal is invalid.");
    }
    const requestedIds = normalizeRequestedIds(input.requestedIds);
    const scopeKind = requestedIds.length ? "exact" : "broad";
    if (input.catalogOnly !== undefined && typeof input.catalogOnly !== "boolean"
      || input.catalogOnly && scopeKind !== "broad") {
      throw new AppError(400, "invalid_package_refresh_mode", "Catalog-only refresh is supported only for broad package inventory.");
    }
    const queryHash = hash({ tokenMode: input.tokenMode, scopeKind, requestedIds });
    const requestHash = hash({ authorizationPrincipalId: input.authorizationPrincipalId, queryHash, ...(input.catalogOnly ? { catalogOnly: true } : {}) });
    const id = await transaction(this.database, async client => {
      await lockPackageInventoryScope(scope, client);
      const existing = await client.query<JobRow>(`SELECT job.*,NULL::uuid AS snapshot_id FROM package_refresh_jobs job
        WHERE tenant_id=$1 AND principal_id=$2 AND token_mode=$3 AND idempotency_key=$4`, [scope.tenantId, scope.principalId, input.tokenMode, input.idempotencyKey]);
      if (existing.rows[0]) {
        if (existing.rows[0].request_hash !== requestHash) {
          throw new AppError(409, "idempotency_mismatch", "This idempotency key already belongs to a different package refresh.");
        }
        return existing.rows[0].id;
      }
      const outstanding = await client.query<{ count: number }>(`SELECT count(*)::int AS count FROM package_refresh_jobs
        WHERE tenant_id=$1 AND principal_id=$2 AND status IN ('waiting_authorization','running')
          AND NOT auto_details
          AND expires_at>clock_timestamp() AND deadline_at>clock_timestamp()`, [scope.tenantId, scope.principalId]);
      if (outstanding.rows[0].count >= 5) {
        throw new AppError(429, "job_limit", "At most five unfinished package refreshes are allowed per principal.");
      }
      const jobId = randomUUID();
      await client.query(`INSERT INTO package_refresh_jobs(id,tenant_id,principal_id,authorization_principal_id,token_mode,idempotency_key,request_hash,query_hash,scope_kind,requested_ids,catalog_only)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11)`, [jobId, scope.tenantId, scope.principalId, input.authorizationPrincipalId, input.tokenMode, input.idempotencyKey, requestHash, queryHash, scopeKind, JSON.stringify(requestedIds), input.catalogOnly ?? false]);
      return jobId;
    });
    const job = await this.getJob(scope, id);
    if (!job) throw new AppError(409, "package_refresh_expired", "The package refresh is no longer available. Submit a new refresh with a new idempotency key.");
    return job;
  }

  async claimDueDetails(scope: PackageDataScope, authorizationPrincipalId: string, signedInAt?: number) {
    requireProviderAdmissions();
    validateScope(scope);
    if (authorizationPrincipalId !== scope.principalId) throw new AppError(403, "scope_mismatch", "Automatic details require the signed-in delegated scope.");
    const id = await transaction(this.database, async client => {
      await lockPackageInventoryScope(scope, client);
      await client.query(`UPDATE package_refresh_jobs SET status='failed',error_code='package_refresh_expired',
        message='Automatic detail enrichment expired; the next authorized check may retry after backoff.',
        finished_at=clock_timestamp(),updated_at=clock_timestamp()
        WHERE tenant_id=$1 AND principal_id=$2 AND auto_details AND status IN ('waiting_authorization','running')
          AND (deadline_at<=clock_timestamp() OR expires_at<=clock_timestamp())`, [scope.tenantId, scope.principalId]);
      const outstanding = await client.query(`SELECT 1 FROM package_refresh_jobs
        WHERE tenant_id=$1 AND principal_id=$2 AND auto_details AND status IN ('waiting_authorization','running')
          AND deadline_at>clock_timestamp() AND expires_at>clock_timestamp() LIMIT 1`, [scope.tenantId, scope.principalId]);
      if (outstanding.rowCount) return null;
      const latest = await client.query<Pick<JobRow, "error_code" | "created_at" | "requested_ids"> & { cooling_down: boolean }>(`
        SELECT error_code,created_at,requested_ids,
          status='failed' AND updated_at>clock_timestamp()-interval '1 hour' AS cooling_down
        FROM package_refresh_jobs WHERE tenant_id=$1 AND principal_id=$2 AND auto_details
        ORDER BY created_at DESC,id DESC LIMIT 1`, [scope.tenantId, scope.principalId]);
      const previous = latest.rows[0];
      const failure = dataSyncFailureStatus(previous?.error_code ?? "");
      const renewed = previous?.cooling_down && failure === "waiting_authorization"
        && signedInAt !== undefined && previous.created_at.getTime() < signedInAt;
      if (previous?.cooling_down && failure !== "failed" && !renewed) return null;
      const due = await client.query<{ native_id: string; package_data: CopilotPackageDetail }>(`
        SELECT current.native_id,current.package_data
        FROM package_detail_current_catalog($1,$2,'delegated') current
        LEFT JOIN package_detail_cache cache ON cache.tenant_id=$1 AND cache.principal_id=$2
          AND cache.token_mode='delegated' AND cache.native_id=current.native_id
        WHERE (cache.native_id IS NULL OR cache.next_attempt_at<=clock_timestamp() OR current.native_id=ANY($3::text[]))
        ORDER BY CASE WHEN cache.native_id IS NULL OR cache.catalog_revision<>package_detail_revision(current.package_data)
          OR cache.observed_at IS NULL OR cache.package_data IS NULL THEN 0 ELSE 1 END,
          cache.observed_at NULLS FIRST,current.native_id COLLATE "C"
        LIMIT 20`, [scope.tenantId, scope.principalId, renewed ? previous.requested_ids : []]);
      if (!due.rows.length) return null;
      const reservations = await client.query<{ id: string; generation: string }>(`
        INSERT INTO package_detail_cache(tenant_id,principal_id,token_mode,native_id,catalog_revision,next_attempt_at)
        SELECT $1,$2,'delegated',target.id,target.revision,clock_timestamp()+interval '10 minutes'
        FROM jsonb_to_recordset($3::jsonb) target(id text,revision jsonb)
        ON CONFLICT(tenant_id,principal_id,token_mode,native_id) DO UPDATE SET next_attempt_at=EXCLUDED.next_attempt_at
        RETURNING native_id AS id,generation`, [scope.tenantId, scope.principalId, JSON.stringify(due.rows.map(row => ({
          id: row.native_id, revision: packageDetailRevision(row.package_data),
        })))]);
      const jobId = randomUUID();
      const requestedIds = due.rows.map(target => target.native_id);
      const queryHash = hash({ tokenMode: "delegated", scopeKind: "exact", requestedIds, autoDetails: true });
      await client.query(`INSERT INTO package_refresh_jobs(id,tenant_id,principal_id,authorization_principal_id,
        token_mode,idempotency_key,request_hash,query_hash,scope_kind,requested_ids,auto_details,detail_targets,deadline_at)
        VALUES($1,$2,$3,$3,'delegated',$4,$5,$6,'exact',$7::jsonb,true,$8::jsonb,clock_timestamp()+interval '10 minutes')`,
      [jobId, scope.tenantId, scope.principalId, `auto_details_${jobId}`,
        hash({ authorizationPrincipalId, queryHash }), queryHash, JSON.stringify(requestedIds), JSON.stringify(reservations.rows)]);
      return jobId;
    });
    return id ? (await this.getJob(scope, id)) ?? null : null;
  }

  async getJob(scope: PackageDataScope, id: string) {
    validateScope(scope);
    const { rows } = await this.database.query<JobRow>(`SELECT job.*,snapshot.id AS snapshot_id FROM package_refresh_jobs job
      LEFT JOIN package_inventory_snapshots snapshot ON snapshot.job_id=job.id
      WHERE job.id=$1 AND job.tenant_id=$2 AND job.principal_id=$3 AND job.expires_at>clock_timestamp()`, [id, scope.tenantId, scope.principalId]);
    return rows[0] ? projectJob(rows[0]) : undefined;
  }

  async latestAutomaticDetailsJob(scope: PackageDataScope, authorizationPrincipalId: string) {
    validateScope(scope);
    const { rows } = await this.database.query<JobRow>(`SELECT job.*,NULL::uuid AS snapshot_id FROM package_refresh_jobs job
      WHERE job.tenant_id=$1 AND job.principal_id=$2 AND job.authorization_principal_id=$3
        AND job.token_mode='delegated' AND job.auto_details AND job.expires_at>clock_timestamp()
      ORDER BY job.created_at DESC,job.id DESC LIMIT 1`, [scope.tenantId, scope.principalId, authorizationPrincipalId]);
    return rows[0] ? projectJob(rows[0]) : null;
  }

  async listJobs(scope: PackageDataScope, authorizationPrincipalId: string, limit = 20) {
    validateScope(scope);
    const boundedLimit = Math.min(Math.max(limit, 1), 50);
    const { rows } = await this.database.query<JobRow>(`SELECT job.*,snapshot.id AS snapshot_id FROM package_refresh_jobs job
      LEFT JOIN package_inventory_snapshots snapshot ON snapshot.job_id=job.id
      WHERE job.tenant_id=$1 AND job.principal_id=$2 AND job.authorization_principal_id=$3 AND job.expires_at>clock_timestamp()
      ORDER BY job.created_at DESC,job.id DESC LIMIT $4`, [scope.tenantId, scope.principalId, authorizationPrincipalId, boundedLimit]);
    const summary = await this.database.query<{ last_attempt_at: Date | null; last_success_at: Date | null }>(`SELECT
      (SELECT max(attempted_at) FROM package_refresh_jobs WHERE tenant_id=$1 AND principal_id=$2 AND authorization_principal_id=$3 AND expires_at>clock_timestamp()) AS last_attempt_at,
      (SELECT max(observed_at) FROM package_inventory_snapshots WHERE tenant_id=$1 AND principal_id=$2 AND is_current AND expires_at>clock_timestamp()) AS last_success_at`, [scope.tenantId, scope.principalId, authorizationPrincipalId]);
    return {
      value: rows.map(projectJob),
      lastAttemptAt: summary.rows[0].last_attempt_at?.toISOString() ?? null,
      lastSuccessAt: summary.rows[0].last_success_at?.toISOString() ?? null,
    };
  }

  async listSnapshots(scope: PackageDataScope, limit = 50) {
    validateScope(scope);
    const { rows } = await this.database.query<SnapshotRow>(`SELECT * FROM package_inventory_snapshots
      WHERE tenant_id=$1 AND principal_id=$2 AND is_current AND expires_at>clock_timestamp()
      ORDER BY observed_at DESC,id DESC LIMIT $3`, [scope.tenantId, scope.principalId, Math.min(Math.max(limit, 1), 50)]);
    return { value: rows.map(projectSnapshot) };
  }

  async markRunning(scope: PackageDataScope, id: string, autoDetails = false) {
    const result = await this.database.query(`UPDATE package_refresh_jobs SET status='running',attempted_at=clock_timestamp(),updated_at=clock_timestamp(),error_code=NULL,message=NULL,
      deadline_at=clock_timestamp()+($4::int*interval '1 millisecond')
      WHERE id=$1 AND tenant_id=$2 AND principal_id=$3 AND status='waiting_authorization' AND expires_at>clock_timestamp() AND deadline_at>clock_timestamp() RETURNING id`, [id, scope.tenantId, scope.principalId, autoDetails ? 10 * 60_000 : packageRefreshExecutionDeadlineMs]);
    return result.rowCount === 1;
  }

  async recordProgress(scope: PackageDataScope, id: string, pageCount: number, observedCount: number, totalRecords: number, message?: string) {
    const result = await this.database.query(`UPDATE package_refresh_jobs SET page_count=$4,observed_count=$5,total_records=$6,message=$7,updated_at=clock_timestamp()
      WHERE id=$1 AND tenant_id=$2 AND principal_id=$3 AND status='running' AND expires_at>clock_timestamp() AND deadline_at>clock_timestamp()`, [id, scope.tenantId, scope.principalId, pageCount, observedCount, totalRecords, message?.slice(0, 1024) ?? null]);
    if (result.rowCount !== 1) throw new AppError(409, "package_refresh_expired", "Package refresh progress arrived after its job expired or stopped.");
  }

  async markWaitingAuthorization(scope: PackageDataScope, id: string) {
    await this.database.query(`UPDATE package_refresh_jobs SET
      status=CASE WHEN expires_at>clock.checked_at AND deadline_at>clock.checked_at THEN 'waiting_authorization' ELSE 'failed' END,
      error_code=CASE WHEN expires_at>clock.checked_at AND deadline_at>clock.checked_at THEN 'interaction_required' ELSE 'package_refresh_expired' END,
      message=CASE WHEN expires_at>clock.checked_at AND deadline_at>clock.checked_at THEN 'Explicit resume with current authorization is required.' ELSE 'The package refresh expired before authorization could resume.' END,
      finished_at=CASE WHEN expires_at>clock.checked_at AND deadline_at>clock.checked_at THEN NULL ELSE clock.checked_at END,updated_at=clock.checked_at
      FROM (SELECT clock_timestamp() AS checked_at) AS clock
      WHERE id=$1 AND tenant_id=$2 AND principal_id=$3 AND status='running'`, [id, scope.tenantId, scope.principalId]);
    return this.getJob(scope, id);
  }

  async markFailed(scope: PackageDataScope, id: string, code: string, message: string) {
    await this.database.query(`UPDATE package_refresh_jobs SET status='failed',error_code=$4,message=$5,finished_at=clock_timestamp(),updated_at=clock_timestamp()
      WHERE id=$1 AND tenant_id=$2 AND principal_id=$3 AND status IN ('running','waiting_authorization')`, [id, scope.tenantId, scope.principalId, safeCode(code), message.slice(0, 1024)]);
    return this.getJob(scope, id);
  }

  async cancel(scope: PackageDataScope, id: string, authorizationPrincipalId: string, reason: RefreshCancellationReason = "requested") {
    validateScope(scope);
    const cancellation = refreshCancellation(reason);
    await this.database.query(`UPDATE package_refresh_jobs SET status='cancelled',error_code=$5,message=$6,
      finished_at=clock_timestamp(),updated_at=clock_timestamp()
      WHERE id=$1 AND tenant_id=$2 AND principal_id=$3 AND authorization_principal_id=$4
        AND status IN ('waiting_authorization','running') AND expires_at>clock_timestamp()`,
    [id, scope.tenantId, scope.principalId, authorizationPrincipalId, cancellation.code, cancellation.message]);
    return this.getJob(scope, id);
  }

  async recoverInterrupted() {
    const waiting = await this.database.query(`WITH candidates AS (
      SELECT id FROM package_refresh_jobs WHERE status='running' AND NOT auto_details AND expires_at>clock_timestamp() AND deadline_at>clock_timestamp() ORDER BY updated_at,id LIMIT 1000 FOR UPDATE SKIP LOCKED)
      UPDATE package_refresh_jobs job SET status='waiting_authorization',error_code='interaction_required',message='Explicit resume with current authorization is required.',updated_at=clock_timestamp()
      FROM candidates WHERE job.id=candidates.id`);
    const expired = await this.database.query(`WITH candidates AS (
      SELECT id FROM package_refresh_jobs WHERE status='running' AND (expires_at<=clock_timestamp() OR deadline_at<=clock_timestamp()) ORDER BY updated_at,id LIMIT 1000 FOR UPDATE SKIP LOCKED)
      UPDATE package_refresh_jobs job SET status='failed',error_code='package_refresh_expired',message='The package refresh expired before recovery.',finished_at=clock_timestamp(),updated_at=clock_timestamp()
      FROM candidates WHERE job.id=candidates.id`);
    return (waiting.rowCount ?? 0) + (expired.rowCount ?? 0);
  }

  async publish(scope: PackageDataScope, id: string, result: PackageScanResult) {
    validateScope(scope);
    const snapshotId = await transaction(this.database, async client => {
      await lockPackageInventoryScope(scope, client);
      const jobResult = await client.query<JobRow>(`SELECT job.*,NULL::uuid AS snapshot_id FROM package_refresh_jobs job
        WHERE id=$1 AND tenant_id=$2 AND principal_id=$3 AND status='running' AND expires_at>clock_timestamp() AND deadline_at>clock_timestamp() FOR UPDATE`, [id, scope.tenantId, scope.principalId]);
      const job = jobResult.rows[0];
      if (!job) throw new AppError(409, "package_refresh_state", "Package refresh is not running for this principal.");
      const newer = job.auto_details ? { rowCount: 0 } : await client.query(`SELECT 1 FROM package_refresh_jobs
        WHERE tenant_id=$1 AND principal_id=$2 AND token_mode=$3 AND query_hash=$4 AND status IN ('running','succeeded') AND id<>$5
          AND (created_at,id)>(SELECT created_at,id FROM package_refresh_jobs WHERE id=$5) LIMIT 1`, [scope.tenantId, scope.principalId, job.token_mode, job.query_hash, job.id]);
      if (newer.rowCount) throw new AppError(409, "package_refresh_superseded", "A newer package refresh for this scope superseded publication.");
      const createdSnapshotId = job.auto_details ? await publishAutomaticDetails(client, scope, job, result)
        : await writePackageSnapshot(client, scope, job, id, result, { readStartedAt: job.attempted_at ?? job.created_at });
      const detailsFailed = job.auto_details && Boolean(result.detailFailures?.length);
      const completion = await client.query(`UPDATE package_refresh_jobs SET status='${detailsFailed ? "failed" : "succeeded"}',page_count=$4,observed_count=$5,total_records=$6,
        error_code=${detailsFailed ? "'package_detail_read_failed'" : "NULL"},message=${job.auto_details ? "$7" : "NULL"},finished_at=clock_timestamp(),updated_at=clock_timestamp()
        WHERE id=$1 AND tenant_id=$2 AND principal_id=$3 AND status='running' AND expires_at>clock_timestamp() AND deadline_at>clock_timestamp()`,
      [id, scope.tenantId, scope.principalId, result.pages, result.packages.length, result.totalRecords,
        ...(job.auto_details ? [`Automatic detail enrichment: ${result.packages.length} read; ${result.detailFailures?.length ?? 0} deferred. Catalog membership and control state are unchanged.`] : [])]);
      if (completion.rowCount !== 1) throw new AppError(409, "package_refresh_expired", "Package refresh expired or stopped before publication completed.");
      return createdSnapshotId;
    });
    return { job: (await this.getJob(scope, id))!, snapshotId };
  }

  async list(scope: PackageDataScope, query: PackageListQuery = {}): Promise<PackageListResult> {
    validateScope(scope);
    const snapshot = await this.resolveSnapshot(scope, query.snapshotId);
    if (!snapshot && query.snapshotId) throw new AppError(404, "not_found", "Package snapshot was not found.");
    if (!snapshot) return {
      value: [], count: 0, snapshot: null,
      summary: { total: 0, allowed: 0, blocked: 0 },
      filteredSummary: { total: 0, allowed: 0, blocked: 0 },
      facets: { publishers: [], availability: [], hosts: [], platforms: [] },
    };
    const allResources = await this.database.query<PackageProjectionRow & { native_id: string }>(`WITH selected AS (
      SELECT native_id FROM package_inventory_resources WHERE snapshot_id=$1 AND tenant_id=$2 AND principal_id=$3
    )
    SELECT selected.native_id,resource.package_data,candidate.id,candidate.read_started_at,candidate.scope_kind,candidate.catalog_only,
      ${savedDetailColumns} FROM selected
    JOIN LATERAL (
      SELECT id,read_started_at,scope_kind,catalog_only FROM package_inventory_snapshots
      WHERE tenant_id=$2 AND principal_id=$3 AND token_mode=$4 AND observation_kind='inventory'
        AND is_current AND expires_at>clock_timestamp() AND (scope_kind='broad' OR requested_ids ? selected.native_id)
      ORDER BY date_trunc('milliseconds',read_started_at) DESC,id DESC LIMIT 1
    ) candidate ON true
    LEFT JOIN package_inventory_resources resource ON resource.snapshot_id=candidate.id
      AND resource.tenant_id=$2 AND resource.principal_id=$3 AND resource.native_id=selected.native_id
    ${savedIdentityJoin("selected.native_id", "$4", "$2", "$3")}
    ORDER BY selected.native_id COLLATE "C"`, [snapshot.id, scope.tenantId, scope.principalId, snapshot.token_mode]);
    const controls = controlsByTarget(snapshot.token_mode === "delegated"
      ? await readPackageControls(this.database, scope, allResources.rows.map(row => row.native_id)) : []);
    const packages = allResources.rows.flatMap(row => {
      const value = applyPackageControls(withSavedIdentity(row), row.read_started_at, controls.get(row.native_id) ?? []);
      return value ? [value] : [];
    });
    const packageById = new Map(packages.map(value => [value.id, value]));
    const { sql, values } = listFilters(snapshot.id, scope, query, packages);
    values.push(JSON.stringify(packages.map(package_data => ({
      native_id: package_data.id, display_name: package_data.displayName, is_blocked: package_data.isBlocked,
      publisher: package_data.publisher, available_to: package_data.availableTo, deployed_to: package_data.deployedTo,
      last_modified_at: package_data.lastModifiedDateTime,
      package_data: { supportedHosts: package_data.supportedHosts, createdDateTime: package_data.createdDateTime },
    }))));
    const projected = `SELECT projected.*,$2::text AS tenant_id,$3::text AS principal_id
      FROM jsonb_to_recordset($${values.length}::jsonb) AS projected(native_id text,display_name text,is_blocked boolean,
        publisher text,available_to text,deployed_to text,last_modified_at timestamptz,package_data jsonb)
      WHERE $1::uuid IS NOT NULL`;
    const sortColumn = { displayName: `display_name COLLATE "C"`, publisher: `publisher COLLATE "C"`, lastModifiedAt: "last_modified_at" }[query.sortBy ?? "displayName"];
    const direction = query.sortDirection === "desc" ? "DESC" : "ASC";
    const limit = Math.min(Math.max(query.limit ?? 100, 1), 5000);
    const offset = Math.min(Math.max(query.offset ?? 0, 0), 100_000);
    const [counts, rows] = await Promise.all([
      this.database.query<{ total: number; allowed: number; blocked: number }>(`WITH scoped AS (${projected})
        SELECT count(*)::int AS total,count(*) FILTER (WHERE NOT is_blocked)::int AS allowed,
          count(*) FILTER (WHERE is_blocked)::int AS blocked FROM scoped WHERE ${sql}`, values),
      this.database.query<{ native_id: string }>(`WITH scoped AS (${projected})
        SELECT native_id FROM scoped WHERE ${sql} ORDER BY ${sortColumn} ${direction} NULLS LAST,native_id COLLATE "C" ASC LIMIT $${values.length + 1} OFFSET $${values.length + 2}`, [...values, limit, offset]),
    ]);
    const filteredSummary = counts.rows[0] ?? { total: 0, allowed: 0, blocked: 0 };
    return {
      value: rows.rows.map(row => {
        const value = packageById.get(row.native_id);
        if (!value) throw packageVerificationFailed();
        return value;
      }),
      count: filteredSummary.total,
      snapshot: projectSnapshot(snapshot),
      summary: summarizePackages(packages),
      filteredSummary,
      facets: packageFacets(packages),
    };
  }

  async readUnifiedSource(scope: PackageDataScope, database: Pick<pg.Pool, "query"> = this.database): Promise<UnifiedPackageSourceResult> {
    validateScope(scope);
    const snapshotResult = await database.query<SnapshotRow>(`SELECT * FROM package_inventory_snapshots
      WHERE tenant_id=$1 AND principal_id=$2 AND token_mode='delegated' AND scope_kind='broad'
        AND observation_kind='inventory' AND is_current AND expires_at>clock_timestamp()
      ORDER BY observed_at DESC,id DESC LIMIT 1`, [scope.tenantId, scope.principalId]);
    const snapshot = snapshotResult.rows[0];
    if (!snapshot) return { packages: [], observations: {}, snapshot: null };
    const base = await database.query<ResourceRow & { native_id: string }>(`SELECT native_id,package_data FROM package_inventory_resources
      WHERE snapshot_id=$1 AND tenant_id=$2 AND principal_id=$3
      ORDER BY native_id COLLATE "C" LIMIT 5001`, [snapshot.id, scope.tenantId, scope.principalId]);
    if (base.rows.length > 5000) {
      throw new AppError(409, "source_result_limit", "Saved Graph package inventory exceeds the 5,000-row unified inventory limit.");
    }
    const overlays = await database.query<{
      native_id: string;
      package_data: CopilotPackageDetail | null;
      snapshot_id: string;
      observed_at: Date;
      read_started_at: Date;
      expires_at: Date;
    }>(`WITH exact_targets AS (
        SELECT snapshot.id,snapshot.observed_at,snapshot.read_started_at,snapshot.expires_at,target.native_id
        FROM package_inventory_snapshots snapshot
        CROSS JOIN LATERAL jsonb_array_elements_text(snapshot.requested_ids) target(native_id)
        WHERE snapshot.tenant_id=$1 AND snapshot.principal_id=$2 AND snapshot.is_current
          AND snapshot.expires_at>clock_timestamp() AND snapshot.token_mode='delegated' AND snapshot.scope_kind='exact'
          AND snapshot.observation_kind='inventory'
      ), latest AS (
        SELECT DISTINCT ON (native_id) id,native_id,observed_at,read_started_at,expires_at FROM exact_targets
        ORDER BY native_id,date_trunc('milliseconds',read_started_at) DESC,id DESC
      )
      SELECT latest.native_id,latest.id AS snapshot_id,latest.observed_at,latest.read_started_at,latest.expires_at,resource.package_data FROM latest
      LEFT JOIN package_inventory_resources resource ON resource.snapshot_id=latest.id
        AND resource.tenant_id=$1 AND resource.principal_id=$2 AND resource.native_id=latest.native_id
      ORDER BY latest.native_id COLLATE "C" LIMIT 5001`,
    [scope.tenantId, scope.principalId]);
    if (overlays.rows.length > 5000) {
      throw new AppError(409, "source_result_limit", "Saved exact Graph package observations exceed the 5,000-row unified inventory limit.");
    }
    const details = await database.query<{
      native_id: string;
      package_data: CopilotPackageDetail | null;
      snapshot_id: string;
      observed_at: Date | null;
      expires_at: Date | null;
      from_cache?: boolean;
      catalog_revision?: ReturnType<typeof packageDetailRevision> | null;
    }>(`WITH detailed AS (
        SELECT snapshot.id,snapshot.read_started_at AS observed_at,
          LEAST(snapshot.expires_at,snapshot.read_started_at+interval '1 hour') AS expires_at,
          resource.native_id,resource.package_data || '{"identityDetailsCollected":true}'::jsonb AS package_data,false AS from_cache,
          NULL::jsonb AS catalog_revision
        FROM package_inventory_snapshots snapshot
        JOIN package_inventory_resources resource ON resource.snapshot_id=snapshot.id
          AND resource.tenant_id=$1 AND resource.principal_id=$2
        WHERE snapshot.tenant_id=$1 AND snapshot.principal_id=$2 AND snapshot.is_current
          AND snapshot.expires_at>clock_timestamp() AND snapshot.token_mode='delegated' AND snapshot.observation_kind='inventory'
          AND NOT snapshot.catalog_only
          AND (package_detail_has_evidence(resource.package_data) OR (snapshot.scope_kind='exact' AND snapshot.job_id IS NOT NULL))
          AND NOT EXISTS (SELECT 1 FROM package_detail_cache cache WHERE cache.tenant_id=$1 AND cache.principal_id=$2
            AND cache.token_mode='delegated' AND cache.native_id=resource.native_id)
        UNION ALL
        SELECT cache.detail_snapshot_id,cache.observed_at,cache.expires_at,cache.native_id,cache.package_data,true AS from_cache,
          cache.catalog_revision
        FROM package_detail_cache cache WHERE cache.tenant_id=$1 AND cache.principal_id=$2
          AND cache.token_mode='delegated'
      ), latest AS (
        SELECT DISTINCT ON (native_id) * FROM detailed
        ORDER BY native_id,date_trunc('milliseconds',observed_at) DESC,id DESC
      )
      SELECT native_id,package_data,id AS snapshot_id,observed_at,expires_at,from_cache,catalog_revision FROM latest
      ORDER BY native_id COLLATE "C" LIMIT 5001`, [scope.tenantId, scope.principalId]);
    if (details.rows.length > 5000) {
      throw new AppError(409, "source_result_limit", "Saved detailed Graph package observations exceed the 5,000-row unified inventory limit.");
    }
    if (base.rows.length !== snapshot.observed_count
      || [...base.rows, ...overlays.rows, ...details.rows].some(row => row.package_data && row.package_data.id !== row.native_id)) {
      throw packageVerificationFailed();
    }
    const snapshotIds = [...new Set([snapshot.id, ...overlays.rows.map(row => row.snapshot_id),
      ...details.rows.filter(row => !row.from_cache).map(row => row.snapshot_id)])];
    const verified = await database.query<{
      id: string; observed_count: number; total_records: number; page_count: number; stored_count: number;
    }>(`WITH counts AS (
      SELECT snapshot_id,count(*)::int AS stored_count FROM package_inventory_resources
      WHERE tenant_id=$1 AND principal_id=$2 AND snapshot_id=ANY($3::uuid[]) GROUP BY snapshot_id
    )
    SELECT saved.id,saved.observed_count,saved.total_records,saved.page_count,COALESCE(counts.stored_count,0) AS stored_count
    FROM package_inventory_snapshots saved LEFT JOIN counts ON counts.snapshot_id=saved.id
    WHERE saved.tenant_id=$1 AND saved.principal_id=$2 AND saved.token_mode='delegated'
      AND saved.is_current AND saved.expires_at>clock_timestamp() AND saved.id=ANY($3::uuid[])`,
    [scope.tenantId, scope.principalId, snapshotIds]);
    if (verified.rows.length !== snapshotIds.length || verified.rows.some(row =>
      row.stored_count !== row.observed_count || row.observed_count !== row.total_records
      || !Number.isSafeInteger(row.total_records) || row.total_records < 0 || row.total_records > 5000
      || !Number.isSafeInteger(row.page_count) || row.page_count < 1 || row.page_count > 100)) {
      throw packageVerificationFailed();
    }
    const packages = new Map(base.rows.map(row => [row.package_data.id, row.package_data]));
    const readStarted = new Map<string, Date>();
    const observations = new Map<string, UnifiedPackageSourceResult["observations"][string]>(base.rows.map(row => [row.package_data.id, {
      snapshotId: snapshot.id,
      scopeKind: "broad",
      observedAt: snapshot.observed_at.toISOString(),
      expiresAt: snapshot.expires_at.toISOString(),
    }]));
    for (const overlay of overlays.rows) {
      const overlayIsNewer = newerObservation(
        overlay.read_started_at,
        overlay.snapshot_id,
        snapshot.read_started_at,
        snapshot.id,
      );
      if (overlay.package_data && overlayIsNewer) {
        readStarted.set(overlay.native_id, overlay.read_started_at);
        packages.set(overlay.native_id, overlay.package_data);
        observations.set(overlay.native_id, {
          snapshotId: overlay.snapshot_id,
          scopeKind: "exact",
          observedAt: overlay.observed_at.toISOString(),
          expiresAt: overlay.expires_at.toISOString(),
        });
      } else if (!overlay.package_data && overlayIsNewer) {
        readStarted.set(overlay.native_id, overlay.read_started_at);
        packages.delete(overlay.native_id);
        observations.delete(overlay.native_id);
      }
    }
    const detailsByTarget = new Map(details.rows.map(detail => [detail.native_id, detail]));
    for (const [id, current] of packages) {
      const detail = detailsByTarget.get(id);
      const observation = observations.get(id)!;
      const value = projectPackageDetails(current, detail?.observed_at && detail.expires_at ? {
        package: detail.package_data, observedAt: detail.observed_at.toISOString(), expiresAt: detail.expires_at.toISOString(),
        catalogRevision: detail.catalog_revision,
      } : undefined, detail?.snapshot_id === observation.snapshotId && (observation.scopeKind === "exact" || !snapshot.catalog_only),
      Date.now(), (readStarted.get(id) ?? snapshot.read_started_at).getTime());
      packages.set(id, value);
      delete observation.identityDetails;
      if (value.detailFreshness?.state === "fresh" && value.elementDetails?.length && detail?.observed_at && detail.expires_at) observation.identityDetails = {
          snapshotId: detail.snapshot_id,
          observedAt: detail.observed_at.toISOString(),
          expiresAt: detail.expires_at.toISOString(),
        };
    }
    const controls = controlsByTarget(await readPackageControls(database, scope));
    for (const [id, values] of controls) {
      const boundary = readStarted.get(id) ?? snapshot.read_started_at;
      const current = packages.get(id);
      const projected = applyPackageControls(current ?? null, boundary, values);
      if (!projected) continue;
      packages.set(id, projected);
      const latest = values.at(-1)!.observation;
      if (!current) observations.set(id, {
        snapshotId: latest.snapshotId, scopeKind: "exact",
        observedAt: latest.observedAt, expiresAt: latest.expiresAt,
      });
    }
    if (packages.size > 5000) {
      throw new AppError(409, "source_result_limit", "Combined saved Graph package observations exceed the 5,000-row unified inventory limit.");
    }
    return {
      packages: [...packages.values()].sort((left, right) => ordinal(left.id, right.id)),
      observations: Object.fromEntries(observations),
      snapshot: projectSnapshot(snapshot),
    };
  }

  async get(scope: PackageDataScope, id: string) {
    validateScope(scope);
    return readSavedPackageTarget(this.database, scope, id);
  }

  async getMany(scope: PackageDataScope, ids: readonly string[]) {
    validateScope(scope);
    if (!Array.isArray(ids) || !ids.length || ids.length > 5000 || ids.some(id => typeof id !== "string" || !id.trim() || id.length > 512) || new Set(ids).size !== ids.length) {
      throw new AppError(400, "invalid_targets", "Exact package reads require 1-5,000 distinct native IDs.");
    }

    const result = await this.database.query<Omit<PackageProjectionRow, "read_started_at"> & { requested_id: string; read_started_at: Date | null; token_mode: string | null }>(`WITH requested AS (
      SELECT requested_id,ordinal FROM unnest($3::text[]) WITH ORDINALITY AS requested(requested_id,ordinal))
      SELECT requested.requested_id,resource.package_data,snapshot.id,snapshot.read_started_at,snapshot.token_mode,snapshot.scope_kind,snapshot.catalog_only,
        ${savedDetailColumns} FROM requested
      LEFT JOIN LATERAL (
        SELECT snapshot.id,snapshot.read_started_at,snapshot.token_mode,snapshot.scope_kind,snapshot.catalog_only FROM package_inventory_snapshots snapshot
        WHERE snapshot.tenant_id=$1 AND snapshot.principal_id=$2 AND snapshot.is_current AND snapshot.expires_at>clock_timestamp()
          AND snapshot.observation_kind='inventory' AND (snapshot.scope_kind='broad' OR snapshot.requested_ids ? requested.requested_id)
        ORDER BY date_trunc('milliseconds',snapshot.read_started_at) DESC,snapshot.id DESC LIMIT 1
      ) snapshot ON true
      LEFT JOIN package_inventory_resources resource ON resource.snapshot_id=snapshot.id
        AND resource.tenant_id=$1 AND resource.principal_id=$2 AND resource.native_id=requested.requested_id
      ${savedIdentityJoin("requested.requested_id", "snapshot.token_mode", "$1", "$2")}
      ORDER BY requested.ordinal`, [scope.tenantId, scope.principalId, ids]);
    const controls = controlsByTarget(await readPackageControls(this.database, scope, ids));
    return result.rows.map(row => ({ id: row.requested_id, package: row.token_mode === "application" ? withSavedIdentity(row)
      : applyPackageControls(withSavedIdentity(row), row.read_started_at ?? undefined, controls.get(row.requested_id) ?? []) }));
  }

  async assertSnapshotCurrent(scope: PackageDataScope, snapshotId: string) {
    validateScope(scope);
    const result = await this.database.query<{ current: boolean }>(`SELECT (is_current AND expires_at>clock_timestamp()) AS current FROM package_inventory_snapshots
      WHERE id=$1 AND tenant_id=$2 AND principal_id=$3`,
    [snapshotId, scope.tenantId, scope.principalId]);
    if (result.rowCount !== 1) throw new AppError(404, "not_found", "Package snapshot was not found.");
    if (!result.rows[0].current) throw new AppError(409, "snapshot_invalidated", "The package snapshot was deleted, expired, superseded, or left the current source scope.");
  }

  private async resolveSnapshot(scope: PackageDataScope, snapshotId?: string) {
    const { rows } = await this.database.query<SnapshotRow>(`SELECT * FROM package_inventory_snapshots
      WHERE tenant_id=$1 AND principal_id=$2 AND is_current AND expires_at>clock_timestamp()
        AND observation_kind='inventory'
        AND (($3::uuid IS NOT NULL AND id=$3) OR ($3::uuid IS NULL AND scope_kind='broad'))
      ORDER BY observed_at DESC,id DESC LIMIT 1`, [scope.tenantId, scope.principalId, snapshotId ?? null]);
    return rows[0];
  }
}

function packageVerificationFailed() {
  return new AppError(409, "inventory_verification_failed",
    "Saved Graph package inventory failed verification of collected totals or source identities. Refresh package inventory before using these snapshots.");
}

async function readPackageControls(database: Pick<pg.Pool, "query">, scope: PackageDataScope, ids?: readonly string[]): Promise<SavedPackageControl[]> {
  if (ids?.length === 0) return [];
  const { rows } = await database.query<{
    id: string; native_id: string; package_data: CopilotPackageDetail | null; control_state: PackageMutationState;
    observed_at: Date; expires_at: Date;
    identity_revalidation_required: boolean;
  }>(`WITH latest_controls AS (
    SELECT DISTINCT ON (requested_ids->>0,observation_kind) id,requested_ids->>0 AS native_id,control_state,observed_at,expires_at,identity_revalidation_required
    FROM package_inventory_snapshots
    WHERE tenant_id=$1 AND principal_id=$2 AND token_mode='delegated' AND observation_kind IN ('block','access')
      AND is_current AND expires_at>clock_timestamp() AND ($3::text[] IS NULL OR requested_ids->>0=ANY($3::text[]))
    ORDER BY requested_ids->>0,observation_kind,observed_at DESC,id DESC
  )
  SELECT control.*,resource.package_data FROM latest_controls control
  LEFT JOIN package_inventory_resources resource ON resource.snapshot_id=control.id
    AND resource.tenant_id=$1 AND resource.principal_id=$2 AND resource.native_id=control.native_id
  ORDER BY control.observed_at,control.id LIMIT 10001`, [scope.tenantId, scope.principalId, ids ?? null]);
  if (rows.length > 10_000) throw new AppError(409, "source_result_limit", "Saved package control observations exceed the 5,000-target inventory limit.");
  return rows.map(row => {
    if (!row.package_data || row.package_data.id !== row.native_id) throw packageVerificationFailed();
    return {
      detail: row.package_data, state: row.control_state,
      identityRevalidationRequired: row.identity_revalidation_required,
      observation: { snapshotId: row.id, observedAt: row.observed_at.toISOString(), expiresAt: row.expires_at.toISOString() },
    };
  });
}

async function readSavedPackageTarget(database: Pick<pg.Pool, "query">, scope: PackageDataScope, id: string, tokenMode?: PackageRefreshInput["tokenMode"]) {
  const result = await database.query<PackageProjectionRow & Pick<SnapshotRow, "observed_at" | "expires_at" | "token_mode">>(`WITH candidate AS (
    SELECT snapshot.id,snapshot.observed_at,snapshot.read_started_at,snapshot.expires_at,snapshot.scope_kind,snapshot.token_mode,snapshot.catalog_only FROM package_inventory_snapshots snapshot
    WHERE snapshot.tenant_id=$1 AND snapshot.principal_id=$2 AND snapshot.is_current AND snapshot.expires_at>clock_timestamp()
      AND snapshot.observation_kind='inventory'
      AND ($4::text IS NULL OR snapshot.token_mode=$4)
      AND (snapshot.scope_kind='broad' OR snapshot.requested_ids ? $3)
    ORDER BY date_trunc('milliseconds',snapshot.read_started_at) DESC,snapshot.id DESC LIMIT 1)
    SELECT resource.package_data,candidate.*,${savedDetailColumns} FROM candidate
    LEFT JOIN package_inventory_resources resource ON resource.snapshot_id=candidate.id AND resource.tenant_id=$1 AND resource.principal_id=$2 AND resource.native_id=$3
    ${savedIdentityJoin("$3", "candidate.token_mode", "$1", "$2")}`,
  [scope.tenantId, scope.principalId, id, tokenMode ?? null]);
  const saved = result.rows[0];
  const controls = saved?.token_mode === "application" ? [] : await readPackageControls(database, scope, [id]);
  const value = applyPackageControls(saved ? withSavedIdentity(saved) : null, saved?.read_started_at, controls);
  const observation = saved
    ? { observedAt: saved.observed_at.toISOString(), expiresAt: saved.expires_at.toISOString() }
    : controls.at(-1)?.observation;
  if (!observation) return undefined;
  return {
    package: value, targetState: value ? "present" as const : "absent" as const,
    scopeKind: saved?.scope_kind ?? "exact" as const,
    observedAt: observation.observedAt, expiresAt: observation.expiresAt,
  };
}

type PackageProjectionRow = {
  package_data: CopilotPackageDetail | null;
  identity_data: CopilotPackageDetail | null;
  read_started_at: Date;
  scope_kind: "broad" | "exact";
  id?: string;
  catalog_only?: boolean;
  identity_snapshot_id?: string;
  identity_observed_at?: Date;
  identity_expires_at?: Date;
  identity_catalog_revision?: ReturnType<typeof packageDetailRevision> | null;
};

const savedDetailColumns = `identity_detail.package_data AS identity_data,
  identity_detail.snapshot_id AS identity_snapshot_id,identity_detail.observed_at AS identity_observed_at,
  identity_detail.expires_at AS identity_expires_at,identity_detail.catalog_revision AS identity_catalog_revision`;

function savedIdentityJoin(nativeId: string, tokenMode: string, tenant: string, principal: string) {
  return `LEFT JOIN LATERAL (
    SELECT saved.* FROM (
      SELECT detail.package_data || '{"identityDetailsCollected":true}'::jsonb AS package_data,
        identity_snapshot.id AS snapshot_id,identity_snapshot.read_started_at AS observed_at,
        LEAST(identity_snapshot.expires_at,identity_snapshot.read_started_at+interval '1 hour') AS expires_at,
        NULL::jsonb AS catalog_revision
      FROM package_inventory_snapshots identity_snapshot
      LEFT JOIN package_inventory_resources detail ON detail.snapshot_id=identity_snapshot.id
        AND detail.tenant_id=${tenant} AND detail.principal_id=${principal} AND detail.native_id=${nativeId}
      WHERE identity_snapshot.tenant_id=${tenant} AND identity_snapshot.principal_id=${principal}
        AND identity_snapshot.token_mode=${tokenMode} AND identity_snapshot.observation_kind='inventory'
        AND NOT identity_snapshot.catalog_only AND identity_snapshot.is_current AND identity_snapshot.expires_at>clock_timestamp()
        AND (package_detail_has_evidence(detail.package_data)
          OR (identity_snapshot.scope_kind='exact' AND identity_snapshot.job_id IS NOT NULL))
        AND (identity_snapshot.scope_kind='broad' OR identity_snapshot.requested_ids ? ${nativeId})
        AND NOT EXISTS (SELECT 1 FROM package_detail_cache cache WHERE cache.tenant_id=${tenant}
          AND cache.principal_id=${principal} AND cache.token_mode=${tokenMode} AND cache.native_id=${nativeId})
      UNION ALL
      SELECT cache.package_data,cache.detail_snapshot_id,cache.observed_at,cache.expires_at,cache.catalog_revision
      FROM package_detail_cache cache WHERE cache.tenant_id=${tenant} AND cache.principal_id=${principal}
        AND cache.token_mode=${tokenMode} AND cache.native_id=${nativeId}
    ) saved
    ORDER BY date_trunc('milliseconds',saved.observed_at) DESC,saved.snapshot_id DESC LIMIT 1
  ) identity_detail ON true`;
}

function withSavedIdentity(row: Omit<PackageProjectionRow, "read_started_at"> & { read_started_at: Date | null }) {
  if (!row.package_data) return null;
  return projectPackageDetails(row.package_data, row.identity_observed_at && row.identity_expires_at ? {
    package: row.identity_data,
    observedAt: row.identity_observed_at.toISOString(),
    expiresAt: row.identity_expires_at.toISOString(),
    catalogRevision: row.identity_catalog_revision,
  } : undefined, !row.catalog_only && Boolean(row.id && row.id === row.identity_snapshot_id),
  Date.now(), row.read_started_at?.getTime());
}

function applyPackageControls(value: CopilotPackageDetail | null, readStartedAt: Date | undefined, controls: readonly SavedPackageControl[]) {
  const applicable = controls.filter(control => (!value || control.detail.id === value.id)
    && (!readStartedAt || Date.parse(control.observation.observedAt) >= readStartedAt.getTime()));
  const fallback = applicable.at(-1)?.detail;
  let result = value ?? (fallback ? {
    ...projectPackageDetails(fallback, undefined), identityRevalidationRequired: true as const,
  } : null);
  if (!result) return null;
  for (const control of applicable) {
    result = projectPackageControl(result, control);
  }
  return result;
}

function controlsByTarget(controls: readonly SavedPackageControl[]) {
  const result = new Map<string, SavedPackageControl[]>();
  for (const control of controls) {
    const values = result.get(control.detail.id) ?? [];
    values.push(control);
    result.set(control.detail.id, values);
  }
  return result;
}

async function publishAutomaticDetails(client: pg.PoolClient, scope: PackageDataScope, job: JobRow, result: PackageScanResult) {
  validatePublication(job, result);
  const failures = result.detailFailures ?? [];
  const completed = [...result.packages.map(value => value.id), ...failures.map(value => value.id)];
  if (completed.length !== job.requested_ids.length || new Set(completed).size !== completed.length
    || completed.some(id => !job.requested_ids.includes(id))) {
    throw new AppError(409, "incomplete_package_coverage", "Automatic enrichment must account for every reserved target.");
  }
  const targets = new Map(job.detail_targets.map(target => [target.id, target.generation]));
  const observations = [
    ...result.packages.map(value => ({ id: value.id, package_data: { ...value, identityDetailsCollected: true }, failed: false, missing: false })),
    ...failures.map(value => ({ id: value.id, package_data: null, failed: true, missing: value.missing })),
  ].map(value => ({ ...value, generation: targets.get(value.id) }));
  if (observations.some(value => !value.generation)) throw packageVerificationFailed();
  await client.query(`WITH current AS MATERIALIZED (SELECT * FROM package_detail_current_catalog($1,$2,'delegated'))
    UPDATE package_detail_cache cache SET
      package_data=CASE WHEN result.failed AND NOT result.missing THEN cache.package_data ELSE result.package_data END,
      detail_snapshot_id=CASE WHEN result.failed AND NOT result.missing THEN cache.detail_snapshot_id ELSE $4::uuid END,
      observed_at=CASE WHEN result.failed AND NOT result.missing THEN cache.observed_at ELSE $5::timestamptz END,
      read_started_at=CASE WHEN result.failed AND NOT result.missing THEN cache.read_started_at ELSE $5::timestamptz END,
      expires_at=CASE WHEN result.failed AND NOT result.missing THEN cache.expires_at ELSE $5::timestamptz+interval '1 hour' END,
      failure_count=CASE WHEN result.failed THEN LEAST(cache.failure_count+1,10) ELSE 0 END,
      next_attempt_at=CASE WHEN result.failed
        THEN clock_timestamp()+LEAST(60,5*power(2,LEAST(cache.failure_count,4)))*interval '1 minute'
        ELSE $5::timestamptz+interval '1 hour' END
    FROM jsonb_to_recordset($3::jsonb) result(id text,generation uuid,package_data jsonb,failed boolean,missing boolean)
    WHERE cache.tenant_id=$1 AND cache.principal_id=$2 AND cache.token_mode='delegated'
      AND cache.native_id=result.id AND cache.generation=result.generation
      AND (cache.read_started_at IS NULL OR cache.read_started_at<=$5::timestamptz)
      AND EXISTS (SELECT 1 FROM current
        WHERE current.native_id=cache.native_id AND package_detail_revision(current.package_data)=cache.catalog_revision)`,
  [scope.tenantId, scope.principalId, JSON.stringify(observations), job.id, job.attempted_at ?? job.created_at]);
  return null;
}

async function writePackageSnapshot(client: pg.PoolClient, scope: PackageDataScope, query: SnapshotQuery, jobId: string | null, result: PackageScanResult,
  observation: { controlState?: PackageMutationState; readStartedAt?: Date; identityRevalidationRequired?: boolean } = {}) {
  validatePublication(query, result);
  await client.query("UPDATE package_inventory_snapshots SET is_current=false,expires_at=LEAST(expires_at,clock_timestamp()) WHERE tenant_id=$1 AND principal_id=$2 AND token_mode=$3 AND query_hash=$4 AND is_current", [scope.tenantId, scope.principalId, query.token_mode, query.query_hash]);
  const snapshotId = randomUUID();
  await client.query(`INSERT INTO package_inventory_snapshots(id,job_id,tenant_id,principal_id,token_mode,query_hash,scope_kind,requested_ids,observed_count,total_records,page_count,
      observation_kind,control_state,read_started_at,expires_at,identity_revalidation_required,catalog_only)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13,COALESCE($14,clock_timestamp()),COALESCE($14,clock_timestamp())+interval '30 days',$15,$16)`,
  [snapshotId, jobId, scope.tenantId, scope.principalId, query.token_mode, query.query_hash, query.scope_kind, JSON.stringify(query.requested_ids),
    result.packages.length, result.totalRecords, result.pages, observation.controlState?.kind ?? "inventory", observation.controlState ?? null,
    observation.readStartedAt ?? null, observation.identityRevalidationRequired ?? false, query.catalog_only ?? false]);
  if (result.packages.length) {
    const rows = result.packages.map(value => ({
      native_id: value.id, display_name: value.displayName, is_blocked: value.isBlocked,
      available_to: value.availableTo ?? null, deployed_to: value.deployedTo ?? null,
      publisher: value.publisher ?? null, last_modified_at: value.lastModifiedDateTime ?? null,
      identifiers: packageInventoryIdentity(scope.tenantId, value).identifiers, package_data: value,
    }));
    await client.query(`INSERT INTO package_inventory_resources(snapshot_id,tenant_id,principal_id,native_id,display_name,is_blocked,available_to,deployed_to,publisher,last_modified_at,identifiers,package_data)
      SELECT $1,$2,$3,row.native_id,row.display_name,row.is_blocked,row.available_to,row.deployed_to,row.publisher,row.last_modified_at,row.identifiers,row.package_data
      FROM jsonb_to_recordset($4::jsonb) AS row(native_id text,display_name text,is_blocked boolean,available_to text,deployed_to text,publisher text,last_modified_at timestamptz,identifiers jsonb,package_data jsonb)`, [snapshotId, scope.tenantId, scope.principalId, JSON.stringify(rows)]);
    await client.query(`INSERT INTO source_identifiers(id,tenant_id,source,resource_type,environment_id,native_id,identifier_kind,identifier_value)
      SELECT gen_random_uuid(),$1,'graph_packages','microsoft.graph/copilotpackages','',resource.native_id,identifier.kind,identifier.value
      FROM package_inventory_resources resource CROSS JOIN LATERAL jsonb_to_recordset(resource.identifiers) AS identifier(kind text,value text)
      WHERE resource.snapshot_id=$2 ON CONFLICT DO NOTHING`, [scope.tenantId, snapshotId]);
  }
  return snapshotId;
}

function validatePublication(job: Pick<SnapshotQuery, "requested_ids" | "scope_kind">, result: PackageScanResult) {
  if (!Number.isSafeInteger(result.totalRecords) || result.totalRecords !== result.packages.length || !Number.isSafeInteger(result.pages) || result.pages < 1 || result.pages > 100 || result.packages.length > 5000) {
    throw new AppError(409, "incomplete_package_coverage", "Only a completely enumerated package result can be published.");
  }
  const requested = new Set(job.requested_ids);
  const identities = new Set<string>();
  for (const value of result.packages) {
    if (!value.id || value.sourceSystem !== "graph_packages" || identities.has(value.id) || (job.scope_kind === "exact" && !requested.has(value.id))) {
      throw new AppError(409, "package_scope_mismatch", "Package publication contained an invalid, duplicate, or out-of-scope native identity.");
    }
    identities.add(value.id);
  }
}

function listFilters(snapshotId: string, scope: PackageDataScope, query: PackageListQuery, packages: readonly CopilotPackageDetail[]) {
  const conditions = ["true"];
  const values: unknown[] = [snapshotId, scope.tenantId, scope.principalId];
  if (query.search) {
    values.push(`%${escapeLike(query.search)}%`);
    conditions.push(`(display_name ILIKE $${values.length} ESCAPE '\\' OR native_id ILIKE $${values.length} ESCAPE '\\'
      OR publisher ILIKE $${values.length} ESCAPE '\\')`);
  }
  if (query.blocked !== undefined) { values.push(query.blocked); conditions.push(`is_blocked=$${values.length}`); }
  if (query.publisher) {
    if (query.publisher === "__unknown__") conditions.push("publisher IS NULL");
    else { values.push(query.publisher); conditions.push(`publisher=$${values.length}`); }
  }
  if (query.availableTo) {
    const availableTo = query.availableTo.startsWith("available:") ? query.availableTo.slice("available:".length) : query.availableTo;
    if (availableTo === "__unknown__") conditions.push("available_to IS NULL");
    else if (availableTo === "__some_or_all__") {
      values.push([...packageStatusAliases.all, ...packageStatusAliases.some]);
      conditions.push(`regexp_replace(lower(available_to),'[^a-z0-9]','','g')=ANY($${values.length}::text[])`);
    } else {
      values.push(availableTo);
      conditions.push(`available_to=$${values.length}`);
    }
  }
  if (query.deployedTo) { values.push(query.deployedTo); conditions.push(`deployed_to=$${values.length}`); }
  if (query.host) {
    if (query.host === "__unknown_host__") {
      conditions.push(`(package_data->'supportedHosts' IS NULL OR jsonb_array_length(COALESCE(package_data->'supportedHosts','[]'::jsonb))=0
        OR EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(package_data->'supportedHosts','[]'::jsonb)) host
          WHERE jsonb_typeof(host)<>'string' OR btrim(host #>> '{}')=''))`);
    } else {
      values.push(query.host);
      conditions.push(`EXISTS (SELECT 1 FROM jsonb_array_elements_text(COALESCE(package_data->'supportedHosts','[]'::jsonb)) host
        WHERE btrim(host)=$${values.length})`);
    }
  }
  if (query.platform) {
    const platform = normalizeBuiltWith(query.platform);
    values.push(packages.filter(value => {
      const label = builtWithLabel(value);
      return label && normalizeBuiltWith(label) === platform;
    }).map(value => value.id));
    conditions.push(`native_id=ANY($${values.length}::text[])`);
  }
  if (query.createdWithinDays !== undefined) {
    values.push(query.createdWithinDays);
    conditions.push(`(package_data->>'createdDateTime')::timestamptz>=clock_timestamp()-($${values.length}::text||' days')::interval`);
  }
  if (query.operationIdPrefix) {
    if (!query.auditPrincipalId) throw new AppError(403, "audit_scope_required", "An authorized audit source is required for operation reference filters.");
    values.push(query.auditPrincipalId, `${escapeLike(query.operationIdPrefix)}%`);
    conditions.push(`EXISTS (SELECT 1 FROM audit_events audit WHERE audit.tenant_id=$2 AND audit.principal_id=$${values.length - 1}
      AND audit.observed_at>clock_timestamp()-interval '90 days'
      AND audit.agent_id=scoped.native_id AND audit.scope='bulk' AND audit.operation_id ILIKE $${values.length} ESCAPE '\\')`);
  }
  if (query.ids) {
    if (!query.ids.length || query.ids.length > 5000 || query.ids.some(id => typeof id !== "string" || !id || id.length > 512)) {
      throw new AppError(400, "invalid_targets", "Package inventory export requires 1-5,000 exact native IDs.");
    }
    values.push([...query.ids]);
    conditions.push(`native_id=ANY($${values.length}::text[])`);
  }
  return { sql: conditions.join(" AND "), values };
}

function summarizePackages(values: readonly CopilotPackageDetail[]) {
  const blocked = values.filter(value => value.isBlocked).length;
  return { total: values.length, allowed: values.length - blocked, blocked };
}

export function packageFacets(values: readonly CopilotPackageDetail[]): PackageListResult["facets"] {
  const publishers = new Map<string, string>();
  const availability = new Map<string, string>();
  const hosts = new Map<string, string>();
  const platforms = new Map<string, string>();
  for (const value of values) {
    publishers.set(value.publisher ?? "__unknown__", value.publisher ?? "Unknown");
    const available = value.availableTo ?? "__unknown__";
    availability.set(`available:${available}`, value.availableTo ?? "Unknown");
    for (const host of value.supportedHosts ?? []) {
      if (typeof host === "string" && host.trim()) hosts.set(host.trim(), formatFacetLabel(host.trim()));
    }
    if (!value.supportedHosts?.length || value.supportedHosts.some(host => typeof host !== "string" || !host.trim())) {
      hosts.set("__unknown_host__", "Unknown");
    }
    const builtWith = builtWithLabel(value);
    if (builtWith) platforms.set(builtWith, builtWith);
  }
  if (values.some(value => {
    const status = normalizePackageStatus(value.availableTo);
    return status === "all" || status === "some";
  })) {
    availability.set("__some_or_all__", "Allowed for Some or All");
  }
  const options = (map: Map<string, string>) => [...map].map(([value, label]) => ({ value, label }))
    .sort((left, right) => left.label.localeCompare(right.label) || left.value.localeCompare(right.value));
  return { publishers: options(publishers), availability: options(availability), hosts: options(hosts), platforms: options(platforms) };
}

function builtWithLabel(value: CopilotPackageDetail) {
  const raw = value.authoringTool ?? value.platform ?? value.shortDescription?.trim().match(/^built\s+using\s+(.+?)\.?$/i)?.[1]?.trim();
  if (!raw) return undefined;
  return formatAgentAuthoringTool(raw);
}

function escapeLike(value: string) {
  return value.replace(/[\\%_]/g, match => `\\${match}`);
}

function projectSnapshot(row: SnapshotRow) {
  return {
    id: row.id,
    tokenMode: row.token_mode,
    scopeKind: row.scope_kind,
    requestedIds: row.requested_ids,
    observedCount: row.observed_count,
    totalRecords: row.total_records,
    pageCount: row.page_count,
    observedAt: row.observed_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
  };
}

function projectJob(row: JobRow) {
  return {
    id: row.id,
    authorizationPrincipalId: row.authorization_principal_id,
    tokenMode: row.token_mode,
    scopeKind: row.scope_kind,
    requestedIds: row.requested_ids,
    catalogOnly: row.catalog_only ?? false,
    autoDetails: row.auto_details ?? false,
    status: row.status,
    pageCount: row.page_count,
    observedCount: row.observed_count,
    totalRecords: row.total_records,
    snapshotId: row.snapshot_id,
    ...(row.error_code ? { errorCode: row.error_code } : {}),
    ...(row.message ? { message: row.message } : {}),
    createdAt: row.created_at.toISOString(),
    attemptedAt: row.attempted_at?.toISOString() ?? null,
    updatedAt: row.updated_at.toISOString(),
    finishedAt: row.finished_at?.toISOString() ?? null,
  };
}

function normalizeRequestedIds(values: readonly string[] | undefined) {
  if (!values) return [];
  if (!Array.isArray(values) || values.length > 5000) throw new AppError(400, "invalid_targets", "A package refresh accepts at most 5,000 exact native IDs.");
  const result = [...new Set(values.map(value => {
    if (typeof value !== "string" || !value.trim() || value.length > 512) throw new AppError(400, "invalid_targets", "Each package target must be a non-empty native ID of at most 512 characters.");
    return value.trim();
  }))].sort(ordinal);
  if (!result.length && values.length) throw new AppError(400, "invalid_targets", "Exact package refresh targets cannot be empty.");
  return result;
}

function validateScope(scope: PackageDataScope) {
  if (!scope.tenantId || !scope.principalId) throw new AppError(403, "scope_mismatch", "Package inventory requires a tenant and principal scope.");
}

function hash(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function safeCode(value: string) {
  return /^[a-z0-9_]{1,128}$/.test(value) ? value : "provider_error";
}

function ordinal(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function newerObservation(leftAt: Date, leftId: string, rightAt: Date, rightId: string) {
  const difference = leftAt.getTime() - rightAt.getTime();
  return difference > 0 || difference === 0 && ordinal(leftId, rightId) > 0;
}
