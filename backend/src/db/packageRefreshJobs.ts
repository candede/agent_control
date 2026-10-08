import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";
import { AppError } from "../errors.js";
import { config } from "../config.js";
import { dataSyncFailureStatus } from "../types/dataSync.js";
import { requireProviderAdmissions } from "../services/operationalState.js";
import { refreshCancellation, type RefreshCancellationReason } from "../services/refreshExecution.js";
import { packageRefreshExecutionDeadlineMs } from "../services/packageRefreshPolicy.js";
import { CursorCodec, SelectionError, type SelectionIdentity } from "../services/dataSelections.js";
import { pool, transaction } from "./pool.js";
import { dataConnections } from "./dataConnections.js";
import { dataLimitError, encodeBatch } from "./dataBounds.js";
import { InventoryQueries } from "./inventoryQueries.js";
import { lockPackageInventoryScope } from "./packageControls.js";

export type PackageDataScope = { tenantId: string; principalId: string; tokenMode?: "delegated" | "application" };
const catalogRevisionHashSql = `encode(sha256(convert_to(jsonb_build_array(
  r.residual->'lastModifiedDateTime',r.residual->'appId',r.residual->'manifestId',
  r.residual->'assetId',r.residual->'version',r.residual->'manifestVersion')::text,'UTF8')),'hex')`;
export type PackageRefreshInput = {
  authorizationPrincipalId: string;
  tokenMode: "delegated" | "application";
  idempotencyKey: string;
  requestedIds?: readonly string[];
};
type JobRow = {
  target_count: number;
  result_revision: string;
  id: string;
  authorization_principal_id: string;
  token_mode: PackageRefreshInput["tokenMode"];
  request_hash: string;
  scope_kind: "broad" | "exact";
  auto_details: boolean;
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
  snapshot_id: string | null;
};
const jobColumns = `job.id,job.authorization_principal_id,job.token_mode,job.request_hash,job.scope_kind,
  job.auto_details,job.status,job.page_count,job.observed_count,job.total_records,
  job.error_code,job.message,job.created_at,job.attempted_at,job.updated_at,job.finished_at,
  job.updated_at::text AS result_revision,
  (SELECT count(*)::int FROM inventory_refresh_targets WHERE job_id=job.id) AS target_count`;

export class PackageRefreshJobs {
  constructor(readonly database: pg.Pool = pool) {}

  async submitSelected(scope: PackageDataScope, identity: SelectionIdentity, input: {
    selectionId: string; idempotencyKey: string; ids?: readonly string[]; recordIds?: readonly string[];
  }) {
    requireProviderAdmissions();
    validateScope(scope);
    if (scope.tenantId !== identity.tenantId || scope.principalId !== identity.principalId || scope.tokenMode === "application") {
      throw new AppError(403, "scope_mismatch", "Selected refreshes require the current delegated inventory owner.");
    }
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(input.idempotencyKey)
      || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(input.selectionId)) {
      throw new AppError(400, "invalid_request", "Use one inventory selection and bounded idempotency key.");
    }
    const ids = input.ids === undefined ? undefined : normalizeRequestedIds(input.ids);
    if (ids && !ids.length || input.recordIds !== undefined && (!Array.isArray(input.recordIds)
      || !input.recordIds.length || input.recordIds.length > 5000
      || input.recordIds.some(id => typeof id !== "string" || !/^agent:[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id)))) {
      throw new AppError(400, "invalid_targets", "Choose nonempty exact package IDs or canonical group IDs.");
    }
    const recordIds = input.recordIds === undefined ? undefined : [...new Set(input.recordIds)].sort(ordinal);
    if ((ids?.length ?? 0) + (recordIds?.length ?? 0) > 5000) {
      throw new AppError(400, "invalid_targets", "Choose at most 5,000 explicit references.");
    }
    const queryHash = hash({ selectionId: input.selectionId, ids: ids ?? null, recordIds: recordIds ?? null });
    const requestHash = hash({ authorizationPrincipalId: identity.principalId, queryHash, tokenMode: "delegated", scopeKind: "exact" });
    const selected = new InventoryQueries(this.database, config.sessionSecret);
    const id = await transaction(this.database, async client => {
      await lockPackageInventoryScope(scope, client);
      const existing = (await client.query(`SELECT id,request_hash FROM package_refresh_jobs
        WHERE tenant_id=$1 AND principal_id=$2 AND token_mode='delegated' AND idempotency_key=$3`,
      [scope.tenantId, scope.principalId, input.idempotencyKey])).rows[0];
      if (existing) {
        if (existing.request_hash !== requestHash) throw new AppError(409, "idempotency_mismatch", "This key belongs to another refresh selection.");
        return existing.id as string;
      }
      return selected.inCurrentSelection(client, input.selectionId, identity, async (client, captured) => {
        const context = ids || recordIds ? { ...captured, query: {} } : captured;
        const total = await selected.mutationTargetCount(client, context, ids, recordIds);
        if (!total) throw new AppError(400, "inventory_refresh_empty", "The selection contains no published package targets.");
        if (total > 5000) throw dataLimitError("inventory_refresh_targets", 5000, total);
        const outstanding = (await client.query(`SELECT count(*)::int AS total FROM package_refresh_jobs
          WHERE tenant_id=$1 AND principal_id=$2 AND NOT auto_details AND status IN ('waiting_authorization','running')
            AND expires_at>clock_timestamp() AND deadline_at>clock_timestamp()`, [scope.tenantId, scope.principalId])).rows[0].total;
        if (outstanding >= 5) throw new AppError(429, "job_limit", "At most five unfinished package refreshes are allowed per principal.");
        const jobId = randomUUID();
        await client.query(`INSERT INTO package_refresh_jobs(id,tenant_id,principal_id,authorization_principal_id,
          token_mode,idempotency_key,request_hash,query_hash,scope_kind)
          VALUES($1,$2,$3,$3,'delegated',$4,$5,$6,'exact')`,
        [jobId, scope.tenantId, scope.principalId, input.idempotencyKey, requestHash, queryHash]);
        let after: string | null = null, ordinal = 0;
        for (;;) {
          const rows = await selected.refreshTargetIds(client, context, after, ids, recordIds);
          if (!rows.length) break;
          const batch = encodeBatch(rows.map(row => ({ target_id: row.id, ordinal: ordinal++ })), [jobId]);
          await client.query(`INSERT INTO inventory_refresh_targets(job_id,ordinal,target_id)
            SELECT $1,ordinal,target_id FROM jsonb_to_recordset($2::jsonb) r(ordinal integer,target_id text)`, [jobId, batch.json]);
          after = rows[rows.length - 1].id;
        }
        if (ordinal !== total) throw new SelectionError("selection_invalidated");
        return jobId;
      });
    });
    const job = await this.getJob(scope, id);
    if (!job) throw new AppError(409, "package_refresh_expired", "The selected refresh expired.");
    return job;
  }

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
    const queryHash = hash({ tokenMode: input.tokenMode, scopeKind, requestedIds });
    const requestHash = hash({ authorizationPrincipalId: input.authorizationPrincipalId, queryHash });
    const id = await transaction(this.database, async client => {
      await lockPackageInventoryScope(scope, client);
      const existing = (await client.query<Pick<JobRow, "id" | "request_hash">>(`SELECT id,request_hash FROM package_refresh_jobs
        WHERE tenant_id=$1 AND principal_id=$2 AND token_mode=$3 AND idempotency_key=$4`,
      [scope.tenantId, scope.principalId, input.tokenMode, input.idempotencyKey])).rows[0];
      if (existing) {
        if (existing.request_hash !== requestHash) throw new AppError(409, "idempotency_mismatch", "This idempotency key already belongs to a different package refresh.");
        return existing.id;
      }
      const outstanding = await client.query<{ count: number }>(`SELECT count(*)::int AS count FROM package_refresh_jobs
        WHERE tenant_id=$1 AND principal_id=$2 AND status IN ('waiting_authorization','running') AND NOT auto_details
          AND expires_at>clock_timestamp() AND deadline_at>clock_timestamp()`, [scope.tenantId, scope.principalId]);
      if (outstanding.rows[0].count >= 5) throw new AppError(429, "job_limit", "At most five unfinished package refreshes are allowed per principal.");
      const jobId = randomUUID();
      await client.query(`INSERT INTO package_refresh_jobs(id,tenant_id,principal_id,authorization_principal_id,token_mode,
        idempotency_key,request_hash,query_hash,scope_kind) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [jobId, scope.tenantId, scope.principalId, input.authorizationPrincipalId, input.tokenMode, input.idempotencyKey,
        requestHash, queryHash, scopeKind]);
      await insertRefreshTargets(client, jobId, requestedIds);
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
      const latest = await client.query<Pick<JobRow, "error_code" | "created_at"> & { cooling_down: boolean; requested_ids: string[] }>(`
        SELECT error_code,created_at,ARRAY(SELECT target_id FROM inventory_refresh_targets
          WHERE job_id=package_refresh_jobs.id ORDER BY ordinal LIMIT 20) AS requested_ids,
          status='failed' AND updated_at>clock_timestamp()-interval '1 hour' AS cooling_down
        FROM package_refresh_jobs WHERE tenant_id=$1 AND principal_id=$2 AND auto_details
        ORDER BY created_at DESC,id DESC LIMIT 1`, [scope.tenantId, scope.principalId]);
      const previous = latest.rows[0];
      const failure = dataSyncFailureStatus(previous?.error_code ?? "");
      const renewed = previous?.cooling_down && failure === "waiting_authorization"
        && signedInAt !== undefined && previous.created_at.getTime() < signedInAt;
      if (previous?.cooling_down && failure !== "failed" && !renewed) return null;
      const due = await client.query<{ native_id: string; catalog_revision_hash: string }>(`
        SELECT r.native_id,${catalogRevisionHashSql} AS catalog_revision_hash
        FROM data_scope_epochs s JOIN inventory_roots root ON root.scope_id=s.id AND root.current
        JOIN inventory_revisions v ON v.scope_id=root.scope_id AND v.revision=root.revision
        JOIN data_generations g ON g.id=v.generation_id
        JOIN inventory_memberships m ON m.baseline_id=root.baseline_id AND m.valid_from_revision<=root.revision
          AND (m.valid_to_revision IS NULL OR m.valid_to_revision>root.revision)
        JOIN package_record_rows r ON r.generation_id=m.generation_id AND r.identity=m.identity
        WHERE s.tenant_id=$1 AND s.principal_id=$2 AND s.token_mode='delegated' AND s.source='inventory_packages'
          AND g.scope_epoch=s.epoch AND g.session_epoch=s.session_epoch AND g.expires_at>clock_timestamp()
          AND r.expires_at>clock_timestamp()
          AND (r.detail_generation IS NULL OR r.residual->'detailFreshness'->>'state'<>'fresh'
            OR (r.residual->'detailFreshness'->>'expiresAt')::timestamptz<=clock_timestamp())
          AND (r.native_id=ANY($3::text[]) OR NOT EXISTS(SELECT 1 FROM package_refresh_jobs attempted
            WHERE attempted.tenant_id=$1 AND attempted.principal_id=$2 AND attempted.auto_details
              AND EXISTS(SELECT 1 FROM inventory_refresh_targets t WHERE t.job_id=attempted.id AND t.target_id=r.native_id
                AND t.catalog_revision_hash=${catalogRevisionHashSql})
              AND attempted.updated_at>clock_timestamp()-interval '1 hour'))
        ORDER BY CASE WHEN r.detail_generation IS NULL OR r.residual->'detailFreshness'->>'state' IN ('missing','invalidated')
          THEN 0 ELSE 1 END,r.native_id COLLATE "C" LIMIT 20`,
      [scope.tenantId, scope.principalId, renewed ? previous.requested_ids : []]);
      if (!due.rows.length) return null;
      const jobId = randomUUID(), requestedIds = due.rows.map(target => target.native_id);
      const queryHash = hash({ tokenMode: "delegated", scopeKind: "exact", requestedIds, autoDetails: true });
      await client.query(`INSERT INTO package_refresh_jobs(id,tenant_id,principal_id,authorization_principal_id,
        token_mode,idempotency_key,request_hash,query_hash,scope_kind,auto_details,deadline_at)
        VALUES($1,$2,$3,$3,'delegated',$4,$5,$6,'exact',true,clock_timestamp()+interval '10 minutes')`,
      [jobId, scope.tenantId, scope.principalId, `auto_details_${jobId}`, hash({ authorizationPrincipalId, queryHash }), queryHash]);
      await insertRefreshTargets(client, jobId, requestedIds, due.rows.map(target => target.catalog_revision_hash));
      return jobId;
    });
    return id ? (await this.getJob(scope, id)) ?? null : null;
  }

  async getJob(scope: PackageDataScope, id: string) {
    validateScope(scope);
    const { rows } = await this.database.query<JobRow>(`SELECT ${jobColumns},snapshot.id AS snapshot_id FROM package_refresh_jobs job
      LEFT JOIN data_generations snapshot ON snapshot.job_id=job.id AND snapshot.state IN ('published','retired')
      WHERE job.id=$1 AND job.tenant_id=$2 AND job.principal_id=$3 AND job.expires_at>clock_timestamp()`, [id, scope.tenantId, scope.principalId]);
    return rows[0] ? projectJob(rows[0]) : undefined;
  }

  async latestAutomaticDetailsJob(scope: PackageDataScope, authorizationPrincipalId: string) {
    validateScope(scope);
    const { rows } = await this.database.query<JobRow>(`SELECT ${jobColumns},snapshot.id AS snapshot_id FROM package_refresh_jobs job
      LEFT JOIN data_generations snapshot ON snapshot.job_id=job.id AND snapshot.state IN ('published','retired')
      WHERE job.tenant_id=$1 AND job.principal_id=$2 AND job.authorization_principal_id=$3
        AND job.token_mode='delegated' AND job.auto_details AND job.expires_at>clock_timestamp()
      ORDER BY job.created_at DESC,job.id DESC LIMIT 1`, [scope.tenantId, scope.principalId, authorizationPrincipalId]);
    return rows[0] ? projectJob(rows[0]) : null;
  }

  async listJobs(scope: PackageDataScope, authorizationPrincipalId: string, limit = 20) {
    validateScope(scope);
    const boundedLimit = Math.min(Math.max(limit, 1), 50);
    const { rows } = await this.database.query<JobRow>(`SELECT ${jobColumns},snapshot.id AS snapshot_id FROM package_refresh_jobs job
      LEFT JOIN data_generations snapshot ON snapshot.job_id=job.id AND snapshot.state IN ('published','retired')
      WHERE job.tenant_id=$1 AND job.principal_id=$2 AND job.authorization_principal_id=$3 AND job.expires_at>clock_timestamp()
      ORDER BY job.created_at DESC,job.id DESC LIMIT $4`, [scope.tenantId, scope.principalId, authorizationPrincipalId, boundedLimit]);
    const summary = await this.database.query<{ last_attempt_at: Date | null; last_success_at: Date | null }>(`SELECT
      (SELECT max(attempted_at) FROM package_refresh_jobs WHERE tenant_id=$1 AND principal_id=$2
        AND authorization_principal_id=$3 AND expires_at>clock_timestamp()) AS last_attempt_at,
      (SELECT max(g.observed_at) FROM data_generations g JOIN data_scope_epochs s ON s.id=g.scope_id
        WHERE s.tenant_id=$1 AND s.principal_id=$2 AND s.source='inventory_packages'
          AND g.state='published' AND g.scope_epoch=s.epoch AND g.session_epoch=s.session_epoch
          AND g.validated AND EXISTS(SELECT 1 FROM inventory_roots r JOIN inventory_revisions v
            ON v.scope_id=r.scope_id AND v.revision=r.revision
            WHERE r.current AND r.scope_id=s.id AND v.generation_id=g.id)) AS last_success_at`,
    [scope.tenantId, scope.principalId, authorizationPrincipalId]);
    return { value: rows.map(projectJob), lastAttemptAt: summary.rows[0].last_attempt_at?.toISOString() ?? null,
      lastSuccessAt: summary.rows[0].last_success_at?.toISOString() ?? null };
  }

  targets(scope: PackageDataScope, identity: SelectionIdentity, id: string, options: { limit?: number; revision?: string; cursor?: string }) {
    const limit = options.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || options.cursor && !options.revision) throw new SelectionError("invalid_cursor");
    return dataConnections(this.database).selectedRead(async client => {
      const job = (await client.query(`SELECT job.updated_at::text AS revision,job.status FROM package_refresh_jobs job
        JOIN data_principal_epochs p ON p.tenant_id=job.tenant_id AND p.principal_id=job.authorization_principal_id
        WHERE job.id=$1 AND job.tenant_id=$2 AND job.principal_id=$3 AND job.authorization_principal_id=$4
          AND p.epoch=$5 AND job.expires_at>clock_timestamp() FOR SHARE OF p`,
      [id, scope.tenantId, scope.principalId, identity.principalId, identity.sessionEpoch])).rows[0];
      if (!job || scope.tenantId !== identity.tenantId) throw new AppError(404, "not_found", "Refresh job was not found.");
      if (options.revision && options.revision !== job.revision) throw new SelectionError("selection_invalidated");
      const codec = new CursorCodec(config.sessionSecret);
      const binding = { identity, endpoint: "inventory-refresh-targets", selectionId: id, revision: job.revision, queryHash: hash("ordinal") };
      const cursor = options.cursor ? codec.decode(options.cursor, binding) : undefined;
      const reverse = cursor?.direction === "previous", ordinal = cursor ? Number(cursor.boundary.id) : -1;
      if (!Number.isSafeInteger(ordinal) || ordinal < -1 || ordinal > 4999) throw new SelectionError("invalid_cursor");
      const candidates = (await client.query<{ ordinal: number; id: string; status: string }>(`
        SELECT t.ordinal,t.target_id AS id,CASE WHEN job.status='succeeded' THEN CASE WHEN k.deleted THEN 'absent' ELSE 'published' END
          WHEN k.identity IS NOT NULL THEN 'observed_unpublished' ELSE job.status END AS status
        FROM inventory_refresh_targets t JOIN package_refresh_jobs job ON job.id=t.job_id
        LEFT JOIN LATERAL(SELECT id FROM data_generations WHERE job_id=job.id ORDER BY created_at DESC,id DESC LIMIT 1) g ON true
        LEFT JOIN inventory_keys k ON k.generation_id=g.id AND k.identity=t.target_id
        WHERE t.job_id=$1 AND t.ordinal ${reverse ? "<" : ">"} $2 ORDER BY t.ordinal ${reverse ? "DESC" : "ASC"} LIMIT $3`,
      [id, ordinal, limit + 1])).rows;
      encodeBatch(candidates);
      const more = candidates.length > limit, value = candidates.slice(0, limit);
      if (reverse) value.reverse();
      const token = (row: typeof value[number] | undefined, direction: "next" | "previous") => row
        ? codec.encode({ ...binding, direction, boundary: { id: String(row.ordinal), key: null, nullRank: 1 } }) : null;
      const total = (await client.query("SELECT count(*)::int AS count FROM inventory_refresh_targets WHERE job_id=$1", [id])).rows[0].count;
      return { value, revision: job.revision, counts: { total, filtered: total }, page: { limit,
        nextCursor: !reverse && more || reverse && cursor ? token(value.at(-1), "next") : null,
        previousCursor: reverse && more || !reverse && cursor ? token(value[0], "previous") : null } };
    });
  }

  async markRunning(scope: PackageDataScope, id: string, autoDetails = false) {
    const result = await this.database.query(`UPDATE package_refresh_jobs SET status='running',attempted_at=clock_timestamp(),
      updated_at=clock_timestamp(),error_code=NULL,message=NULL,deadline_at=clock_timestamp()+($4::int*interval '1 millisecond')
      WHERE id=$1 AND tenant_id=$2 AND principal_id=$3 AND status='waiting_authorization' AND expires_at>clock_timestamp()
        AND deadline_at>clock_timestamp() RETURNING id`,
    [id, scope.tenantId, scope.principalId, autoDetails ? 10 * 60_000 : packageRefreshExecutionDeadlineMs]);
    return result.rowCount === 1;
  }

  async recordProgress(scope: PackageDataScope, id: string, pageCount: number, observedCount: number, totalRecords: number | null, message?: string) {
    const result = await this.database.query(`UPDATE package_refresh_jobs SET page_count=$4,observed_count=$5,total_records=$6,message=$7,
      updated_at=clock_timestamp() WHERE id=$1 AND tenant_id=$2 AND principal_id=$3 AND status='running'
        AND expires_at>clock_timestamp() AND deadline_at>clock_timestamp()`,
    [id, scope.tenantId, scope.principalId, pageCount, observedCount, totalRecords, message?.slice(0, 1024) ?? null]);
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
    await this.database.query(`UPDATE package_refresh_jobs SET status='failed',error_code=$4,message=$5,finished_at=clock_timestamp(),
      updated_at=clock_timestamp() WHERE id=$1 AND tenant_id=$2 AND principal_id=$3 AND status IN ('running','waiting_authorization')`,
    [id, scope.tenantId, scope.principalId, safeCode(code), message.slice(0, 1024)]);
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
      SELECT id FROM package_refresh_jobs WHERE status='running' AND NOT auto_details AND expires_at>clock_timestamp()
        AND deadline_at>clock_timestamp() ORDER BY updated_at,id LIMIT 250 FOR UPDATE SKIP LOCKED)
      UPDATE package_refresh_jobs job SET status='waiting_authorization',error_code='interaction_required',
        message='Explicit resume with current authorization is required.',updated_at=clock_timestamp()
      FROM candidates WHERE job.id=candidates.id`);
    const expired = await this.database.query(`WITH candidates AS (
      SELECT id FROM package_refresh_jobs WHERE status='running' AND (expires_at<=clock_timestamp() OR deadline_at<=clock_timestamp())
        ORDER BY updated_at,id LIMIT 250 FOR UPDATE SKIP LOCKED)
      UPDATE package_refresh_jobs job SET status='failed',error_code='package_refresh_expired',
        message='The package refresh expired before recovery.',finished_at=clock_timestamp(),updated_at=clock_timestamp()
      FROM candidates WHERE job.id=candidates.id`);
    return (waiting.rowCount ?? 0) + (expired.rowCount ?? 0);
  }
}

function projectJob(row: JobRow) {
  return { id: row.id, authorizationPrincipalId: row.authorization_principal_id, tokenMode: row.token_mode, scopeKind: row.scope_kind,
    targetCount: row.target_count, resultRevision: row.result_revision,
    autoDetails: row.auto_details ?? false, status: row.status, pageCount: row.page_count, observedCount: row.observed_count,
    totalRecords: row.total_records, snapshotId: row.snapshot_id, ...(row.error_code ? { errorCode: row.error_code } : {}),
    ...(row.message ? { message: row.message } : {}), createdAt: row.created_at.toISOString(),
    attemptedAt: row.attempted_at?.toISOString() ?? null, updatedAt: row.updated_at.toISOString(),
    finishedAt: row.finished_at?.toISOString() ?? null };
}

async function insertRefreshTargets(client: pg.PoolClient, jobId: string, ids: readonly string[], catalogRevisionHashes?: readonly string[]) {
  if (catalogRevisionHashes && catalogRevisionHashes.length !== ids.length) throw new Error("inventory_detail_target_revisions");
  let ordinal = 0;
  while (ordinal < ids.length) {
    let size = Math.min(250, ids.length - ordinal), batch;
    for (;;) {
      try { batch = encodeBatch(ids.slice(ordinal, ordinal + size).map((target_id, index) => ({
        target_id, ordinal: ordinal + index, catalog_revision_hash: catalogRevisionHashes?.[ordinal + index] ?? null,
      })), [jobId]); break; }
      catch (error) { if (size === 1) throw error; size = Math.max(1, Math.floor(size / 2)); }
    }
    await client.query(`INSERT INTO inventory_refresh_targets(job_id,ordinal,target_id,catalog_revision_hash)
      SELECT $1,ordinal,target_id,catalog_revision_hash FROM jsonb_to_recordset($2::jsonb)
      r(ordinal integer,target_id text,catalog_revision_hash text)`, [jobId, batch.json]);
    ordinal += size;
  }
}

function normalizeRequestedIds(values: readonly string[] | undefined) {
  if (!values) return [];
  if (!Array.isArray(values) || values.length > 5000) throw new AppError(400, "invalid_targets", "A package refresh accepts at most 5,000 exact native IDs.");
  const result = [...new Set(values.map(value => {
    if (typeof value !== "string" || !value.trim() || value.length > 512) throw new AppError(400, "invalid_targets", "Each package target must be a non-empty native ID of at most 512 characters.");
    return value;
  }))].sort(ordinal);
  if (!result.length && values.length) throw new AppError(400, "invalid_targets", "Exact package refresh targets cannot be empty.");
  return result;
}
function validateScope(scope: PackageDataScope) {
  if (!scope.tenantId || !scope.principalId) throw new AppError(403, "scope_mismatch", "Package inventory requires a tenant and principal scope.");
}
function hash(value: unknown) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function safeCode(value: string) { return /^[a-z0-9_]{1,128}$/.test(value) ? value : "provider_error"; }
function ordinal(left: string, right: string) { return left < right ? -1 : left > right ? 1 : 0; }
