import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";
import { AppError } from "../errors.js";
import { packageInventoryIdentity } from "../services/inventoryIdentity.js";
import { requireProviderAdmissions } from "../services/operationalState.js";
import type { CopilotPackageDetail } from "../types/copilotPackage.js";
import { pool, transaction } from "./pool.js";

export type PackageDataScope = { tenantId: string; principalId: string };
export type PackageRefreshInput = {
  authorizationPrincipalId: string;
  tokenMode: "delegated" | "application";
  idempotencyKey: string;
  requestedIds?: readonly string[];
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
export type PackageScanResult = {
  packages: CopilotPackageDetail[];
  totalRecords: number;
  pages: number;
};

type JobRow = {
  id: string;
  authorization_principal_id: string;
  token_mode: PackageRefreshInput["tokenMode"];
  request_hash: string;
  query_hash: string;
  scope_kind: "broad" | "exact";
  requested_ids: string[];
  status: "waiting_authorization" | "running" | "succeeded" | "failed";
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
  expires_at: Date;
};

type ResourceRow = {
  package_data: CopilotPackageDetail;
};

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
    const queryHash = hash({ tokenMode: input.tokenMode, scopeKind, requestedIds });
    const requestHash = hash({ authorizationPrincipalId: input.authorizationPrincipalId, queryHash });
    const id = await transaction(this.database, async client => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`package-refresh:${scope.tenantId}:${scope.principalId}:${input.tokenMode}`]);
      const existing = await client.query<JobRow>(`SELECT job.*,NULL::uuid AS snapshot_id FROM package_refresh_jobs job
        WHERE tenant_id=$1 AND principal_id=$2 AND token_mode=$3 AND idempotency_key=$4`, [scope.tenantId, scope.principalId, input.tokenMode, input.idempotencyKey]);
      if (existing.rows[0]) {
        if (existing.rows[0].request_hash !== requestHash) {
          throw new AppError(409, "idempotency_mismatch", "This idempotency key already belongs to a different package refresh.");
        }
        return existing.rows[0].id;
      }
      const outstanding = await client.query<{ count: number }>(`SELECT count(*)::int AS count FROM package_refresh_jobs
        WHERE tenant_id=$1 AND principal_id=$2 AND status IN ('waiting_authorization','running') AND expires_at>clock_timestamp()`, [scope.tenantId, scope.principalId]);
      if (outstanding.rows[0].count >= 5) {
        throw new AppError(429, "job_limit", "At most five unfinished package refreshes are allowed per principal.");
      }
      const jobId = randomUUID();
      await client.query(`INSERT INTO package_refresh_jobs(id,tenant_id,principal_id,authorization_principal_id,token_mode,idempotency_key,request_hash,query_hash,scope_kind,requested_ids)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)`, [jobId, scope.tenantId, scope.principalId, input.authorizationPrincipalId, input.tokenMode, input.idempotencyKey, requestHash, queryHash, scopeKind, JSON.stringify(requestedIds)]);
      return jobId;
    });
    return (await this.getJob(scope, id))!;
  }

  async getJob(scope: PackageDataScope, id: string) {
    validateScope(scope);
    const { rows } = await this.database.query<JobRow>(`SELECT job.*,snapshot.id AS snapshot_id FROM package_refresh_jobs job
      LEFT JOIN package_inventory_snapshots snapshot ON snapshot.job_id=job.id
      WHERE job.id=$1 AND job.tenant_id=$2 AND job.principal_id=$3 AND job.expires_at>clock_timestamp()`, [id, scope.tenantId, scope.principalId]);
    return rows[0] ? projectJob(rows[0]) : undefined;
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

  async markRunning(scope: PackageDataScope, id: string) {
    const result = await this.database.query(`UPDATE package_refresh_jobs SET status='running',attempted_at=clock_timestamp(),updated_at=clock_timestamp(),error_code=NULL,message=NULL
      WHERE id=$1 AND tenant_id=$2 AND principal_id=$3 AND status='waiting_authorization' AND expires_at>clock_timestamp() AND deadline_at>clock_timestamp() RETURNING id`, [id, scope.tenantId, scope.principalId]);
    return result.rowCount === 1;
  }

  async recordProgress(scope: PackageDataScope, id: string, pageCount: number, observedCount: number, totalRecords: number) {
    const result = await this.database.query(`UPDATE package_refresh_jobs SET page_count=$4,observed_count=$5,total_records=$6,updated_at=clock_timestamp()
      WHERE id=$1 AND tenant_id=$2 AND principal_id=$3 AND status='running' AND expires_at>clock_timestamp() AND deadline_at>clock_timestamp()`, [id, scope.tenantId, scope.principalId, pageCount, observedCount, totalRecords]);
    if (result.rowCount !== 1) throw new AppError(409, "package_refresh_expired", "Package refresh progress arrived after its job expired or stopped.");
  }

  async markWaitingAuthorization(scope: PackageDataScope, id: string) {
    await this.database.query(`UPDATE package_refresh_jobs SET status='waiting_authorization',error_code='interaction_required',message='Explicit resume with current authorization is required.',updated_at=clock_timestamp()
      WHERE id=$1 AND tenant_id=$2 AND principal_id=$3 AND status='running' AND expires_at>clock_timestamp() AND deadline_at>clock_timestamp()`, [id, scope.tenantId, scope.principalId]);
    return this.getJob(scope, id);
  }

  async markFailed(scope: PackageDataScope, id: string, code: string, message: string) {
    await this.database.query(`UPDATE package_refresh_jobs SET status='failed',error_code=$4,message=$5,finished_at=clock_timestamp(),updated_at=clock_timestamp()
      WHERE id=$1 AND tenant_id=$2 AND principal_id=$3 AND status IN ('running','waiting_authorization')`, [id, scope.tenantId, scope.principalId, safeCode(code), message.slice(0, 1024)]);
    return this.getJob(scope, id);
  }

  async recoverInterrupted() {
    const waiting = await this.database.query(`WITH candidates AS (
      SELECT id FROM package_refresh_jobs WHERE status='running' AND expires_at>clock_timestamp() AND deadline_at>clock_timestamp() ORDER BY updated_at,id LIMIT 1000 FOR UPDATE SKIP LOCKED)
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
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`package-refresh:${scope.tenantId}:${scope.principalId}`]);
      const jobResult = await client.query<JobRow>(`SELECT job.*,NULL::uuid AS snapshot_id FROM package_refresh_jobs job
        WHERE id=$1 AND tenant_id=$2 AND principal_id=$3 AND status='running' AND expires_at>clock_timestamp() AND deadline_at>clock_timestamp() FOR UPDATE`, [id, scope.tenantId, scope.principalId]);
      const job = jobResult.rows[0];
      if (!job) throw new AppError(409, "package_refresh_state", "Package refresh is not running for this principal.");
      const newer = await client.query(`SELECT 1 FROM package_refresh_jobs
        WHERE tenant_id=$1 AND principal_id=$2 AND token_mode=$3 AND query_hash=$4 AND status IN ('running','succeeded') AND id<>$5
          AND (created_at,id)>(SELECT created_at,id FROM package_refresh_jobs WHERE id=$5) LIMIT 1`, [scope.tenantId, scope.principalId, job.token_mode, job.query_hash, job.id]);
      if (newer.rowCount) throw new AppError(409, "package_refresh_superseded", "A newer package refresh for this scope superseded publication.");
      validatePublication(job, result);
      await client.query("UPDATE package_inventory_snapshots SET is_current=false,expires_at=LEAST(expires_at,clock_timestamp()) WHERE tenant_id=$1 AND principal_id=$2 AND token_mode=$3 AND query_hash=$4 AND is_current", [scope.tenantId, scope.principalId, job.token_mode, job.query_hash]);
      const createdSnapshotId = randomUUID();
      await client.query(`INSERT INTO package_inventory_snapshots(id,job_id,tenant_id,principal_id,token_mode,query_hash,scope_kind,requested_ids,observed_count,total_records,page_count)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11)`, [createdSnapshotId, id, scope.tenantId, scope.principalId, job.token_mode, job.query_hash, job.scope_kind, JSON.stringify(job.requested_ids), result.packages.length, result.totalRecords, result.pages]);
      if (result.packages.length) {
        const rows = result.packages.map(value => {
          const identity = packageInventoryIdentity(scope.tenantId, value);
          return {
            native_id: value.id,
            display_name: value.displayName,
            is_blocked: value.isBlocked,
            available_to: value.availableTo ?? null,
            deployed_to: value.deployedTo ?? null,
            publisher: value.publisher ?? null,
            last_modified_at: value.lastModifiedDateTime ?? null,
            identifiers: identity.identifiers,
            package_data: value,
          };
        });
        await client.query(`INSERT INTO package_inventory_resources(snapshot_id,tenant_id,principal_id,native_id,display_name,is_blocked,available_to,deployed_to,publisher,last_modified_at,identifiers,package_data)
          SELECT $1,$2,$3,row.native_id,row.display_name,row.is_blocked,row.available_to,row.deployed_to,row.publisher,row.last_modified_at,row.identifiers,row.package_data
          FROM jsonb_to_recordset($4::jsonb) AS row(native_id text,display_name text,is_blocked boolean,available_to text,deployed_to text,publisher text,last_modified_at timestamptz,identifiers jsonb,package_data jsonb)`, [createdSnapshotId, scope.tenantId, scope.principalId, JSON.stringify(rows)]);
        await client.query(`INSERT INTO source_identifiers(id,tenant_id,source,resource_type,environment_id,native_id,identifier_kind,identifier_value)
          SELECT gen_random_uuid(),$1,'graph_packages','microsoft.graph/copilotpackages','',resource.native_id,identifier.kind,identifier.value
          FROM package_inventory_resources resource CROSS JOIN LATERAL jsonb_to_recordset(resource.identifiers) AS identifier(kind text,value text)
          WHERE resource.snapshot_id=$2 ON CONFLICT DO NOTHING`, [scope.tenantId, createdSnapshotId]);
      }
      await client.query(`UPDATE package_refresh_jobs SET status='succeeded',page_count=$4,observed_count=$5,total_records=$6,error_code=NULL,message=NULL,finished_at=clock_timestamp(),updated_at=clock_timestamp()
        WHERE id=$1 AND tenant_id=$2 AND principal_id=$3`, [id, scope.tenantId, scope.principalId, result.pages, result.packages.length, result.totalRecords]);
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
    const { sql, values } = listFilters(snapshot.id, scope, query);
    const [counts, allResources] = await Promise.all([
      this.database.query<{ total: number; allowed: number; blocked: number }>(`WITH scoped AS (
          SELECT * FROM package_inventory_resources WHERE snapshot_id=$1 AND tenant_id=$2 AND principal_id=$3)
        SELECT count(*)::int AS total,count(*) FILTER (WHERE NOT is_blocked)::int AS allowed,
          count(*) FILTER (WHERE is_blocked)::int AS blocked FROM scoped WHERE ${sql}`, values),
      this.database.query<ResourceRow>(`SELECT package_data FROM package_inventory_resources
        WHERE snapshot_id=$1 AND tenant_id=$2 AND principal_id=$3
        ORDER BY native_id COLLATE "C"`, [snapshot.id, scope.tenantId, scope.principalId]),
    ]);
    const summary = summarizePackages(allResources.rows.map(row => row.package_data));
    const filteredSummary = counts.rows[0] ?? { total: 0, allowed: 0, blocked: 0 };
    const sortColumn = { displayName: `display_name COLLATE "C"`, publisher: `publisher COLLATE "C"`, lastModifiedAt: "last_modified_at" }[query.sortBy ?? "displayName"];
    const direction = query.sortDirection === "desc" ? "DESC" : "ASC";
    const limit = Math.min(Math.max(query.limit ?? 100, 1), 5000);
    const offset = Math.min(Math.max(query.offset ?? 0, 0), 100_000);
    const rows = await this.database.query<ResourceRow>(`WITH scoped AS (SELECT * FROM package_inventory_resources WHERE snapshot_id=$1 AND tenant_id=$2 AND principal_id=$3)
      SELECT package_data FROM scoped WHERE ${sql} ORDER BY ${sortColumn} ${direction} NULLS LAST,native_id COLLATE "C" ASC LIMIT $${values.length + 1} OFFSET $${values.length + 2}`, [...values, limit, offset]);
    return {
      value: rows.rows.map(row => row.package_data),
      count: filteredSummary.total,
      snapshot: projectSnapshot(snapshot),
      summary,
      filteredSummary,
      facets: packageFacets(allResources.rows.map(row => row.package_data)),
    };
  }

  async get(scope: PackageDataScope, id: string) {
    validateScope(scope);
    const result = await this.database.query<{ package_data: CopilotPackageDetail | null; observed_at: Date; expires_at: Date; scope_kind: "broad" | "exact" }>(`WITH candidate AS (
      SELECT snapshot.id,snapshot.observed_at,snapshot.expires_at,snapshot.scope_kind FROM package_inventory_snapshots snapshot
      WHERE snapshot.tenant_id=$1 AND snapshot.principal_id=$2 AND snapshot.is_current AND snapshot.expires_at>clock_timestamp()
        AND (snapshot.scope_kind='broad' OR snapshot.requested_ids ? $3)
      ORDER BY snapshot.observed_at DESC,snapshot.id DESC LIMIT 1)
      SELECT resource.package_data,candidate.observed_at,candidate.expires_at,candidate.scope_kind FROM candidate
      LEFT JOIN package_inventory_resources resource ON resource.snapshot_id=candidate.id AND resource.tenant_id=$1 AND resource.principal_id=$2 AND resource.native_id=$3`, [scope.tenantId, scope.principalId, id]);
    return result.rows[0] ? {
      package: result.rows[0].package_data,
      targetState: result.rows[0].package_data ? "present" as const : "absent" as const,
      scopeKind: result.rows[0].scope_kind,
      observedAt: result.rows[0].observed_at.toISOString(),
      expiresAt: result.rows[0].expires_at.toISOString(),
    } : undefined;
  }

  async getMany(scope: PackageDataScope, ids: readonly string[]) {
    validateScope(scope);
    if (!Array.isArray(ids) || !ids.length || ids.length > 5000 || ids.some(id => typeof id !== "string" || !id.trim() || id.length > 512) || new Set(ids).size !== ids.length) {
      throw new AppError(400, "invalid_targets", "Exact package reads require 1-5,000 distinct native IDs.");
    }

    const result = await this.database.query<{ requested_id: string; package_data: CopilotPackageDetail | null }>(`WITH requested AS (
      SELECT requested_id,ordinal FROM unnest($3::text[]) WITH ORDINALITY AS requested(requested_id,ordinal))
      SELECT requested.requested_id,resource.package_data FROM requested
      LEFT JOIN LATERAL (
        SELECT snapshot.id FROM package_inventory_snapshots snapshot
        WHERE snapshot.tenant_id=$1 AND snapshot.principal_id=$2 AND snapshot.is_current AND snapshot.expires_at>clock_timestamp()
          AND (snapshot.scope_kind='broad' OR snapshot.requested_ids ? requested.requested_id)
        ORDER BY snapshot.observed_at DESC,snapshot.id DESC LIMIT 1
      ) snapshot ON true
      LEFT JOIN package_inventory_resources resource ON resource.snapshot_id=snapshot.id
        AND resource.tenant_id=$1 AND resource.principal_id=$2 AND resource.native_id=requested.requested_id
      ORDER BY requested.ordinal`, [scope.tenantId, scope.principalId, ids]);
    return result.rows.map(row => ({ id: row.requested_id, package: row.package_data }));
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
        AND (($3::uuid IS NOT NULL AND id=$3) OR ($3::uuid IS NULL AND scope_kind='broad'))
      ORDER BY observed_at DESC,id DESC LIMIT 1`, [scope.tenantId, scope.principalId, snapshotId ?? null]);
    return rows[0];
  }
}

function validatePublication(job: JobRow, result: PackageScanResult) {
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

function listFilters(snapshotId: string, scope: PackageDataScope, query: PackageListQuery) {
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
      conditions.push("lower(regexp_replace(available_to,'[^a-z0-9]','','g'))=ANY(ARRAY['all','some','allowedforall','allowedforsome'])");
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
    values.push(normalizeBuiltWith(query.platform));
    conditions.push(`regexp_replace(lower(COALESCE(NULLIF(package_data->>'authoringTool',''),NULLIF(package_data->>'platform',''),
      substring(package_data->>'shortDescription' from '(?i)^built\\s+using\\s+(.+?)[.]?$'),'')),'[^a-z0-9]','','g')=$${values.length}`);
  }
  if (query.createdWithinDays !== undefined) {
    values.push(query.createdWithinDays);
    conditions.push(`(package_data->>'createdDateTime')::timestamptz>=clock_timestamp()-($${values.length}::text||' days')::interval`);
  }
  if (query.operationIdPrefix) {
    if (!query.auditPrincipalId) throw new AppError(403, "audit_scope_required", "An authorized audit source is required for operation reference filters.");
    values.push(query.auditPrincipalId, `${escapeLike(query.operationIdPrefix)}%`);
    conditions.push(`EXISTS (SELECT 1 FROM audit_events audit WHERE audit.tenant_id=$2 AND audit.principal_id=$${values.length - 1}
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

function packageFacets(values: readonly CopilotPackageDetail[]): PackageListResult["facets"] {
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
  if ([...availability.keys()].some(value => ["available:all", "available:some", "available:allowedForAll", "available:allowedForSome"].includes(value))) {
    availability.set("__some_or_all__", "Allowed for Some or All");
  }
  const options = (map: Map<string, string>) => [...map].map(([value, label]) => ({ value, label }))
    .sort((left, right) => left.label.localeCompare(right.label) || left.value.localeCompare(right.value));
  return { publishers: options(publishers), availability: options(availability), hosts: options(hosts), platforms: options(platforms) };
}

function builtWithLabel(value: CopilotPackageDetail) {
  const raw = value.authoringTool ?? value.platform ?? value.shortDescription?.trim().match(/^built\s+using\s+(.+?)\.?$/i)?.[1]?.trim();
  if (!raw) return undefined;
  return normalizeBuiltWith(raw).includes("copilotstudio") ? "Copilot Studio" : formatFacetLabel(raw);
}

function formatFacetLabel(value: string) {
  return value.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").trim();
}

function normalizeBuiltWith(value: string) {
  return value.toLocaleLowerCase("en-US").replace(/[^a-z0-9]/g, "");
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