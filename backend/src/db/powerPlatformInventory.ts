import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";
import { AppError } from "../errors.js";
import { requireProviderAdmissions } from "../services/operationalState.js";
import { powerPlatformInventoryIdentity, resolveExactInventoryIdentity, type InventoryIdentityRecord } from "../services/inventoryIdentity.js";
import {
  powerPlatformResourceTypes,
  type InventoryRefreshJob,
  type InventoryRefreshJobList,
  type InventoryResourcePage,
  type InventoryRoleScope,
  type InventorySnapshot,
  type InventorySnapshotList,
  type InventoryTypeCoverage,
  type PowerPlatformResource,
  type PowerPlatformResourceType,
  type ResourceQueryResult,
} from "../types/powerPlatformInventory.js";
import type { InventoryQuarantineTarget, QuarantineTargetCandidate, QuarantineTargetEligibilityCode, QuarantineTargetPage } from "../types/copilotStudioQuarantine.js";
import { validateQuarantineTarget } from "../services/copilotStudioQuarantine.js";
import { pool, transaction } from "./pool.js";

export type InventoryDataScope = { tenantId: string; principalId: string };
export type InventoryRefreshInput = {
  roleScope: InventoryRoleScope;
  environmentScope?: string;
  requestedTypes: readonly PowerPlatformResourceType[];
  idempotencyKey: string;
};
export type InventoryListQuery = {
  includeAssociations?: boolean;
  snapshotId?: string;
  type?: PowerPlatformResourceType;
  environmentId?: string;
  search?: string;
  sortBy?: "displayName" | "type" | "environmentId" | "createdAt" | "lastPublishedAt";
  sortDirection?: "asc" | "desc";
  limit?: number;
  offset?: number;
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
  request_hash: string;
  query_hash: string;
  deadline_at: Date;
};

type SnapshotRow = {
  id: string;
  role_scope: InventoryRoleScope;
  environment_scope: string;
  requested_types: PowerPlatformResourceType[];
  coverage: InventoryTypeCoverage[];
  observed_count: number;
  total_records: number;
  page_count: number;
  unknown_field_count: number;
  observed_at: Date;
  expires_at: Date;
};

type ResourceRow = {
  tenant_id: string;
  native_id: string;
  resource_type: PowerPlatformResourceType;
  environment_id: string;
  location: string | null;
  display_name: string | null;
  created_at: Date | null;
  created_by: string | null;
  last_published_at: Date | null;
  source_system: "power_platform";
  authoring_tool: string | null;
  creator_type: "unknown";
  agent_kind: string;
  lifecycle: PowerPlatformResource["lifecycle"];
  identity_confidence: PowerPlatformResource["identityConfidence"];
  identifiers: PowerPlatformResource["identifiers"];
  provenance: PowerPlatformResource["provenance"];
  details: PowerPlatformResource["details"];
  unknown_field_count: number;
};

export class PowerPlatformInventoryRepository {
  constructor(private readonly database: pg.Pool = pool) {}

  async submit(scope: InventoryDataScope, input: InventoryRefreshInput) {
    requireProviderAdmissions();
    validateScope(scope);
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(input.idempotencyKey)) throw new AppError(400, "invalid_idempotency_key", "Idempotency-Key must contain 1-128 letters, digits, underscores or hyphens.");
    if (!(["full", "ai", "unknown"] as const).includes(input.roleScope)) throw new AppError(400, "invalid_inventory_scope", "Inventory role scope is invalid.");
    const requestedTypes = validateTypes(input.requestedTypes);
    const environmentScope = validateEnvironment(input.environmentScope);
    const requestHash = queryHash(input.roleScope, environmentScope, requestedTypes);
    const id = await transaction(this.database, async client => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`power-platform:${scope.tenantId}:${scope.principalId}`]);
      const existing = await client.query<JobRow>("SELECT *,NULL::uuid AS snapshot_id FROM power_platform_refresh_jobs WHERE tenant_id=$1 AND principal_id=$2 AND idempotency_key=$3", [scope.tenantId, scope.principalId, input.idempotencyKey]);
      if (existing.rows[0]) {
        if (existing.rows[0].request_hash !== requestHash) throw new AppError(409, "idempotency_mismatch", "This idempotency key already belongs to a different inventory request.");
        return existing.rows[0].id;
      }
      const outstanding = await client.query("SELECT count(*)::int AS count FROM power_platform_refresh_jobs WHERE tenant_id=$1 AND principal_id=$2 AND status IN ('waiting_authorization','running') AND expires_at>clock_timestamp()", [scope.tenantId, scope.principalId]);
      if (outstanding.rows[0].count >= 5) throw new AppError(429, "job_limit", "At most five unfinished inventory refresh jobs are allowed per principal.");
      const jobId = randomUUID();
      await client.query(`INSERT INTO power_platform_refresh_jobs(id,tenant_id,principal_id,idempotency_key,request_hash,role_scope,environment_scope,requested_types)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`, [jobId, scope.tenantId, scope.principalId, input.idempotencyKey, requestHash, input.roleScope, environmentScope, JSON.stringify(requestedTypes)]);
      return jobId;
    });
    return (await this.getJob(scope, id))!;
  }

  async getJob(scope: InventoryDataScope, id: string) {
    validateScope(scope);
    const { rows } = await this.database.query<JobRow>(`SELECT job.*,snapshot.id AS snapshot_id
      FROM power_platform_refresh_jobs job LEFT JOIN power_platform_inventory_snapshots snapshot ON snapshot.job_id=job.id
      WHERE job.id=$1 AND job.tenant_id=$2 AND job.principal_id=$3 AND job.expires_at>clock_timestamp()`, [id, scope.tenantId, scope.principalId]);
    return rows[0] ? projectJob(rows[0]) : undefined;
  }

  async listJobs(scope: InventoryDataScope, limit = 20): Promise<InventoryRefreshJobList> {
    validateScope(scope);
    const boundedLimit = Math.min(Math.max(limit, 1), 50);
    const { rows } = await this.database.query<JobRow>(`SELECT job.*,snapshot.id AS snapshot_id
      FROM power_platform_refresh_jobs job LEFT JOIN power_platform_inventory_snapshots snapshot ON snapshot.job_id=job.id
      WHERE job.tenant_id=$1 AND job.principal_id=$2 AND job.expires_at>clock_timestamp()
      ORDER BY job.created_at DESC,job.id DESC LIMIT $3`, [scope.tenantId, scope.principalId, boundedLimit]);
    const value = rows.map(projectJob);
    const summary = await this.database.query<{ last_attempt_at: Date | null; last_success_at: Date | null }>(`SELECT
      (SELECT max(attempted_at) FROM power_platform_refresh_jobs WHERE tenant_id=$1 AND principal_id=$2 AND expires_at>clock_timestamp()) AS last_attempt_at,
      (SELECT max(observed_at) FROM power_platform_inventory_snapshots WHERE tenant_id=$1 AND principal_id=$2 AND is_current AND expires_at>clock_timestamp()) AS last_success_at`, [scope.tenantId, scope.principalId]);
    return {
      value,
      lastAttemptAt: summary.rows[0].last_attempt_at?.toISOString() ?? null,
      lastSuccessAt: summary.rows[0].last_success_at?.toISOString() ?? null,
    };
  }

  async listSnapshots(scope: InventoryDataScope, limit = 50): Promise<InventorySnapshotList> {
    validateScope(scope);
    const boundedLimit = Math.min(Math.max(limit, 1), 50);
    const { rows } = await this.database.query<SnapshotRow>(`SELECT * FROM power_platform_inventory_snapshots
      WHERE tenant_id=$1 AND principal_id=$2 AND is_current AND expires_at>clock_timestamp()
      ORDER BY observed_at DESC,id DESC LIMIT $3`, [scope.tenantId, scope.principalId, boundedLimit]);
    return { value: rows.map(projectSnapshot) };
  }

  async markRunning(scope: InventoryDataScope, id: string) {
    const result = await this.database.query(`UPDATE power_platform_refresh_jobs SET status='running',attempted_at=clock_timestamp(),updated_at=clock_timestamp(),error_code=NULL,message=NULL
      WHERE id=$1 AND tenant_id=$2 AND principal_id=$3 AND status='waiting_authorization' AND expires_at>clock_timestamp() AND deadline_at>clock_timestamp() RETURNING id`, [id, scope.tenantId, scope.principalId]);
    return result.rowCount === 1;
  }

  async recordProgress(scope: InventoryDataScope, id: string, pageCount: number, observedCount: number, totalRecords: number) {
    const result = await this.database.query(`UPDATE power_platform_refresh_jobs SET page_count=$4,observed_count=$5,total_records=$6,updated_at=clock_timestamp()
      WHERE id=$1 AND tenant_id=$2 AND principal_id=$3 AND status='running' AND expires_at>clock_timestamp() AND deadline_at>clock_timestamp()`, [id, scope.tenantId, scope.principalId, pageCount, observedCount, totalRecords]);
    if (result.rowCount !== 1) throw new AppError(409, "inventory_job_expired", "Inventory refresh progress arrived after its job expired or stopped.");
  }

  async markWaitingAuthorization(scope: InventoryDataScope, id: string) {
    await this.database.query(`UPDATE power_platform_refresh_jobs SET
      status=CASE WHEN expires_at>clock_timestamp() AND deadline_at>clock_timestamp() THEN 'waiting_authorization' ELSE 'failed' END,
      error_code=CASE WHEN expires_at>clock_timestamp() AND deadline_at>clock_timestamp() THEN 'interaction_required' ELSE 'inventory_job_expired' END,
      message=CASE WHEN expires_at>clock_timestamp() AND deadline_at>clock_timestamp() THEN 'Current delegated authorization is required.' ELSE 'The inventory refresh deadline expired.' END,
      finished_at=CASE WHEN expires_at>clock_timestamp() AND deadline_at>clock_timestamp() THEN NULL ELSE clock_timestamp() END,updated_at=clock_timestamp()
      WHERE id=$1 AND tenant_id=$2 AND principal_id=$3 AND status='running'`, [id, scope.tenantId, scope.principalId]);
    return this.getJob(scope, id);
  }

  async recoverInterrupted() {
    const waiting = await this.database.query(`WITH candidates AS (
      SELECT id FROM power_platform_refresh_jobs WHERE status='running' AND expires_at>clock_timestamp() AND deadline_at>clock_timestamp() ORDER BY updated_at,id LIMIT 1000 FOR UPDATE SKIP LOCKED)
      UPDATE power_platform_refresh_jobs job SET status='waiting_authorization',error_code='interaction_required',message='Explicit resume with current delegated authorization is required.',updated_at=clock_timestamp()
      FROM candidates WHERE job.id=candidates.id`);
    const expired = await this.database.query(`WITH candidates AS (
      SELECT id FROM power_platform_refresh_jobs WHERE status='running' AND (expires_at<=clock_timestamp() OR deadline_at<=clock_timestamp()) ORDER BY updated_at,id LIMIT 1000 FOR UPDATE SKIP LOCKED)
      UPDATE power_platform_refresh_jobs job SET status='failed',error_code='inventory_job_expired',message='The inventory refresh expired before recovery.',finished_at=clock_timestamp(),updated_at=clock_timestamp()
      FROM candidates WHERE job.id=candidates.id`);
    return (waiting.rowCount ?? 0) + (expired.rowCount ?? 0);
  }

  async markFailed(scope: InventoryDataScope, id: string, code: string, message: string) {
    await this.database.query(`UPDATE power_platform_refresh_jobs SET status='failed',error_code=$4,message=$5,finished_at=clock_timestamp(),updated_at=clock_timestamp()
      WHERE id=$1 AND tenant_id=$2 AND principal_id=$3 AND status IN ('running','waiting_authorization')`, [id, scope.tenantId, scope.principalId, safeCode(code), message.slice(0, 1024)]);
    return this.getJob(scope, id);
  }

  async cancel(scope: InventoryDataScope, id: string) {
    validateScope(scope);
    await this.database.query(`UPDATE power_platform_refresh_jobs SET status='cancelled',error_code='cancelled',message='Cancelled by the requesting principal.',
      finished_at=clock_timestamp(),updated_at=clock_timestamp()
      WHERE id=$1 AND tenant_id=$2 AND principal_id=$3 AND status IN ('waiting_authorization','running') AND expires_at>clock_timestamp()`,
    [id, scope.tenantId, scope.principalId]);
    return this.getJob(scope, id);
  }

  async publish(scope: InventoryDataScope, id: string, result: ResourceQueryResult) {
    validateScope(scope);
    const snapshotId = await transaction(this.database, async client => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`power-platform:${scope.tenantId}:${scope.principalId}`]);
      const jobResult = await client.query<JobRow>(`SELECT job.*,job.request_hash AS query_hash,NULL::uuid AS snapshot_id FROM power_platform_refresh_jobs job
        WHERE id=$1 AND tenant_id=$2 AND principal_id=$3 AND status='running' AND expires_at>clock_timestamp() AND deadline_at>clock_timestamp() FOR UPDATE`, [id, scope.tenantId, scope.principalId]);
      const job = jobResult.rows[0];
      if (!job) throw new AppError(409, "inventory_job_state", "Inventory refresh is not running for this principal.");
      const newer = await client.query(`SELECT 1 FROM power_platform_refresh_jobs
        WHERE tenant_id=$1 AND principal_id=$2 AND request_hash=$3 AND status IN ('running','succeeded') AND id<>$4
          AND (created_at,id)>(SELECT created_at,id FROM power_platform_refresh_jobs WHERE id=$4) LIMIT 1`, [scope.tenantId, scope.principalId, job.request_hash, job.id]);
      if (newer.rowCount) throw new AppError(409, "inventory_job_superseded", "A newer refresh for this scope superseded this publication.");
      validatePublication(scope, job, result);
      const identities = new Set(result.resources.map(resource => resourceIdentity(resource)));
      if (job.role_scope === "unknown") {
        const previous = await client.query<{ resource_type: PowerPlatformResourceType; environment_id: string; native_id: string }>(`SELECT resource.resource_type,resource.environment_id,resource.native_id
          FROM power_platform_inventory_snapshots snapshot JOIN power_platform_inventory_resources resource ON resource.snapshot_id=snapshot.id
          WHERE snapshot.tenant_id=$1 AND snapshot.principal_id=$2 AND snapshot.query_hash=$3 AND snapshot.is_current`, [scope.tenantId, scope.principalId, job.query_hash]);
        if (previous.rows.some(row => !identities.has(`${row.resource_type}\0${row.environment_id}\0${row.native_id}`))) throw new AppError(409, "incomplete_inventory_coverage", "Unknown role scope omitted previously retained resources; the prior snapshot was preserved.");
      }
      const coverage = buildCoverage(job.role_scope, job.requested_types, result.resources);
      await client.query("UPDATE power_platform_inventory_snapshots SET is_current=false,expires_at=LEAST(expires_at,clock_timestamp()) WHERE tenant_id=$1 AND principal_id=$2 AND query_hash=$3 AND is_current", [scope.tenantId, scope.principalId, job.query_hash]);
      const createdSnapshotId = randomUUID();
      await client.query(`INSERT INTO power_platform_inventory_snapshots(id,job_id,tenant_id,principal_id,query_hash,role_scope,environment_scope,requested_types,coverage,observed_count,total_records,page_count,unknown_field_count)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11,$12,$13)`, [createdSnapshotId, id, scope.tenantId, scope.principalId, job.query_hash, job.role_scope, job.environment_scope, JSON.stringify(job.requested_types), JSON.stringify(coverage), result.resources.length, result.totalRecords, result.pages, result.unknownFieldCount]);
      if (result.resources.length) {
        const rows = result.resources.map(resource => ({
          native_id: resource.nativeId, resource_type: resource.type, environment_id: resource.environmentId ?? "", location: resource.location,
          display_name: resource.displayName, created_at: resource.createdAt, created_by: resource.createdBy, last_published_at: resource.lastPublishedAt,
          source_system: resource.sourceSystem, authoring_tool: resource.authoringTool, creator_type: resource.creatorType, agent_kind: resource.agentKind,
          lifecycle: resource.lifecycle, identity_confidence: resource.identityConfidence, identifiers: resource.identifiers, provenance: resource.provenance,
          details: resource.details, unknown_field_count: resource.unknownFieldCount,
        }));
        await client.query(`INSERT INTO power_platform_inventory_resources(snapshot_id,tenant_id,principal_id,native_id,resource_type,environment_id,location,display_name,created_at,created_by,last_published_at,source_system,authoring_tool,creator_type,agent_kind,lifecycle,identity_confidence,identifiers,provenance,details,unknown_field_count)
          SELECT $1,$2,$3,row.native_id,row.resource_type,row.environment_id,row.location,row.display_name,row.created_at,row.created_by,row.last_published_at,row.source_system,row.authoring_tool,row.creator_type,row.agent_kind,row.lifecycle,row.identity_confidence,row.identifiers,row.provenance,row.details,row.unknown_field_count
          FROM jsonb_to_recordset($4::jsonb) AS row(native_id text,resource_type text,environment_id text,location text,display_name text,created_at timestamptz,created_by text,last_published_at timestamptz,source_system text,authoring_tool text,creator_type text,agent_kind text,lifecycle text,identity_confidence text,identifiers jsonb,provenance jsonb,details jsonb,unknown_field_count integer)`, [createdSnapshotId, scope.tenantId, scope.principalId, JSON.stringify(rows)]);
        await client.query(`INSERT INTO source_identifiers(id,tenant_id,source,resource_type,environment_id,native_id,identifier_kind,identifier_value)
          SELECT gen_random_uuid(),$1,'power_platform',resource.resource_type,resource.environment_id,resource.native_id,identifier.kind,identifier.value
          FROM power_platform_inventory_resources resource CROSS JOIN LATERAL jsonb_to_recordset(resource.identifiers) AS identifier(kind text,value text)
          WHERE resource.snapshot_id=$2 ON CONFLICT DO NOTHING`, [scope.tenantId, createdSnapshotId]);
      }
      await client.query(`UPDATE power_platform_refresh_jobs SET status='succeeded',page_count=$4,observed_count=$5,total_records=$6,unknown_field_count=$7,error_code=NULL,message=NULL,finished_at=clock_timestamp(),updated_at=clock_timestamp()
        WHERE id=$1 AND tenant_id=$2 AND principal_id=$3`, [id, scope.tenantId, scope.principalId, result.pages, result.resources.length, result.totalRecords, result.unknownFieldCount]);
      return createdSnapshotId;
    });
    return { job: (await this.getJob(scope, id))!, snapshotId };
  }

  async list(scope: InventoryDataScope, query: InventoryListQuery = {}): Promise<InventoryResourcePage> {
    validateScope(scope);
    const snapshot = await this.resolveSnapshot(scope, query.snapshotId);
    if (!snapshot && query.snapshotId) throw new AppError(404, "not_found", "Inventory snapshot was not found.");
    if (!snapshot) return { value: [], count: 0, typeCounts: emptyCoverage(), snapshot: null };
    const { sql, values } = listFilters(snapshot.id, scope, query);
    const countResult = await this.database.query<{ count: number }>(`WITH scoped AS (SELECT * FROM power_platform_inventory_resources WHERE snapshot_id=$1 AND tenant_id=$2 AND principal_id=$3) SELECT count(*)::int AS count FROM scoped WHERE ${sql}`, values);
    const countRows = await this.database.query<{ resource_type: PowerPlatformResourceType; count: number }>(`WITH scoped AS (SELECT * FROM power_platform_inventory_resources WHERE snapshot_id=$1 AND tenant_id=$2 AND principal_id=$3) SELECT resource_type,count(*)::int AS count FROM scoped WHERE ${sql} GROUP BY resource_type`, values);
    const sortColumn = { displayName: `display_name COLLATE "C"`, type: `resource_type COLLATE "C"`, environmentId: `environment_id COLLATE "C"`, createdAt: "created_at", lastPublishedAt: "last_published_at" }[query.sortBy ?? "displayName"];
    const direction = query.sortDirection === "desc" ? "DESC" : "ASC";
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 5000);
    const offset = Math.min(Math.max(query.offset ?? 0, 0), 100_000);
    const rows = await this.database.query<ResourceRow>(`WITH scoped AS (SELECT * FROM power_platform_inventory_resources WHERE snapshot_id=$1 AND tenant_id=$2 AND principal_id=$3)
      SELECT * FROM scoped WHERE ${sql} ORDER BY ${sortColumn} ${direction} NULLS LAST,resource_type COLLATE "C" ASC,environment_id COLLATE "C" ASC,native_id COLLATE "C" ASC LIMIT $${values.length + 1} OFFSET $${values.length + 2}`, [...values, limit, offset]);
    const filteredCounts = new Map(countRows.rows.map(row => [row.resource_type, row.count]));
    const typeCounts = snapshot.coverage.map(item => ({ ...item, count: item.count === null ? null : filteredCounts.get(item.type) ?? 0 }));
    const resources = rows.rows.map(projectResource);
    if (resources.length && query.includeAssociations !== false) {
      const candidates = await this.database.query<Pick<ResourceRow, "tenant_id" | "native_id" | "resource_type" | "environment_id" | "identifiers">>(
        `SELECT tenant_id,native_id,resource_type,environment_id,identifiers FROM power_platform_inventory_resources
          WHERE snapshot_id=$1 AND tenant_id=$2 AND principal_id=$3 ORDER BY resource_type COLLATE "C",environment_id COLLATE "C",native_id COLLATE "C" LIMIT 5000`,
        [snapshot.id, scope.tenantId, scope.principalId]);
      const identities: InventoryIdentityRecord[] = candidates.rows.map(row => ({ tenantId: row.tenant_id, nativeId: row.native_id, resourceType: row.resource_type, environmentId: row.environment_id || null, sourceSystem: "power_platform", identifiers: row.identifiers }));
      for (const resource of resources) {
        resource.association = resolveExactInventoryIdentity(powerPlatformInventoryIdentity(resource), identities.filter(candidate =>
          candidate.nativeId !== resource.nativeId || candidate.resourceType !== resource.type || candidate.environmentId !== resource.environmentId));
      }
    }
    return { value: resources, count: countResult.rows[0].count, typeCounts, snapshot: projectSnapshot(snapshot) };
  }

  async getResource(scope: InventoryDataScope, snapshotId: string, resourceType: PowerPlatformResourceType, environmentId: string, nativeId: string) {
    validateScope(scope);
    const snapshot = await this.resolveSnapshot(scope, snapshotId);
    if (!snapshot) throw new AppError(404, "not_found", "Inventory snapshot was not found.");
    const row = await this.database.query<ResourceRow>(`SELECT * FROM power_platform_inventory_resources
      WHERE snapshot_id=$1 AND tenant_id=$2 AND principal_id=$3 AND resource_type=$4 AND environment_id=$5 AND native_id=$6`,
    [snapshot.id, scope.tenantId, scope.principalId, resourceType, environmentId, nativeId]);
    if (!row.rows[0]) throw new AppError(404, "not_found", "Inventory resource was not found in the exact authorized snapshot.");
    return { resource: projectResource(row.rows[0]), snapshot: projectSnapshot(snapshot) };
  }

  async getQuarantineSelection(scope: InventoryDataScope, snapshotId: string, nativeIds: string[]) {
    validateScope(scope);
    if (!nativeIds.length || nativeIds.length > 25 || new Set(nativeIds).size !== nativeIds.length) throw new AppError(400, "invalid_inventory_selection", "Selection must contain 1 to 25 unique native IDs.");
    const snapshot = await this.resolveSnapshot(scope, snapshotId);
    if (!snapshot) throw new AppError(404, "not_found", "Inventory snapshot was not found.");
    const rows = await this.database.query<ResourceRow>(`SELECT * FROM power_platform_inventory_resources
      WHERE snapshot_id=$1 AND tenant_id=$2 AND principal_id=$3 AND resource_type='microsoft.copilotstudio/agents' AND native_id=ANY($4::text[])
      ORDER BY environment_id COLLATE "C",native_id COLLATE "C"`,
    [snapshot.id, scope.tenantId, scope.principalId, nativeIds]);
    if (rows.rows.length !== nativeIds.length) throw new AppError(409, "inventory_selection_stale", "One or more exact selected resources are absent or ambiguous in the authorized snapshot.");
    return { value: rows.rows.map(projectResource), snapshot: projectSnapshot(snapshot) };
  }

  async listQuarantineTargets(scope: InventoryDataScope, query: { search?: string; limit?: number; offset?: number } = {}): Promise<QuarantineTargetPage> {
    validateScope(scope);
    const snapshotResult = await this.database.query<SnapshotRow>(`SELECT * FROM power_platform_inventory_snapshots
      WHERE tenant_id=$1 AND principal_id=$2 AND is_current AND expires_at>clock_timestamp()
        AND requested_types @> '["microsoft.copilotstudio/agents"]'::jsonb
      ORDER BY observed_at DESC,id DESC LIMIT 1`, [scope.tenantId, scope.principalId]);
    const snapshot = snapshotResult.rows[0];
    if (!snapshot) return { value: [], count: 0, snapshot: null };
    const resources = await this.database.query<ResourceRow>(`SELECT * FROM power_platform_inventory_resources
      WHERE snapshot_id=$1 AND tenant_id=$2 AND principal_id=$3 AND resource_type='microsoft.copilotstudio/agents'
      ORDER BY native_id COLLATE "C",environment_id COLLATE "C"`, [snapshot.id, scope.tenantId, scope.principalId]);
    const grouped = new Map<string, ResourceRow[]>();
    for (const resource of resources.rows) grouped.set(resource.native_id, [...(grouped.get(resource.native_id) ?? []), resource]);
    const stale = snapshot.observed_at.getTime() < Date.now() - 24 * 60 * 60 * 1000;
    const normalizedSearch = query.search?.trim().toLocaleLowerCase("en-US") ?? "";
    const candidates = [...grouped.values()].map(matches => projectQuarantineCandidate(snapshot, matches, stale)).filter(candidate => !normalizedSearch
      || [candidate.displayName, candidate.nativeId, candidate.environmentId, candidate.botId].some(value => value?.toLocaleLowerCase("en-US").includes(normalizedSearch)));
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 100);
    const offset = Math.min(Math.max(query.offset ?? 0, 0), 100_000);
    return {
      value: candidates.slice(offset, offset + limit),
      count: candidates.length,
      snapshot: { id: snapshot.id, observedAt: snapshot.observed_at.toISOString(), expiresAt: snapshot.expires_at.toISOString() },
    };
  }

  async assertSnapshotCurrent(scope: InventoryDataScope, snapshotId: string) {
    validateScope(scope);
    const result = await this.database.query<{ current: boolean }>(`SELECT (is_current AND expires_at>clock_timestamp()) AS current FROM power_platform_inventory_snapshots
      WHERE id=$1 AND tenant_id=$2 AND principal_id=$3`,
    [snapshotId, scope.tenantId, scope.principalId]);
    if (result.rowCount !== 1) throw new AppError(404, "not_found", "Power Platform snapshot was not found.");
    if (!result.rows[0].current) throw new AppError(409, "snapshot_invalidated", "The Power Platform snapshot was deleted, expired, superseded, or left the current source scope.");
  }

  async resolveQuarantineTargets(scope: InventoryDataScope, snapshotId: string, nativeIds: readonly string[], maximumAgeMs = 24 * 60 * 60 * 1000): Promise<InventoryQuarantineTarget[]> {
    validateScope(scope);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(snapshotId)) {
      throw new AppError(400, "invalid_quarantine_target", "Quarantine targeting requires an exact inventory snapshot ID.");
    }
    if (!Array.isArray(nativeIds) || nativeIds.length < 1 || nativeIds.length > 25 || nativeIds.some(value => typeof value !== "string" || !value || value.length > 512 || /[\r\n\0]/.test(value))) {
      throw new AppError(400, "invalid_quarantine_target", "Select 1-25 exact native inventory resources.");
    }
    if (new Set(nativeIds).size !== nativeIds.length) throw new AppError(400, "duplicate_target", "Duplicate quarantine targets are not allowed.");
    const snapshot = await this.database.query<SnapshotRow>(`SELECT * FROM power_platform_inventory_snapshots
      WHERE id=$1 AND tenant_id=$2 AND principal_id=$3 AND is_current AND expires_at>clock_timestamp()`, [snapshotId, scope.tenantId, scope.principalId]);
    const selectedSnapshot = snapshot.rows[0];
    if (!selectedSnapshot) throw new AppError(409, "quarantine_inventory_unavailable", "The selected current inventory snapshot is unavailable. Refresh inventory explicitly.");
    if (selectedSnapshot.observed_at.getTime() < Date.now() - maximumAgeMs) {
      throw new AppError(409, "quarantine_inventory_stale", "The selected inventory snapshot is stale. Refresh inventory explicitly before quarantine status or control work.");
    }
    const resources = await this.database.query<ResourceRow>(`SELECT * FROM power_platform_inventory_resources
      WHERE snapshot_id=$1 AND tenant_id=$2 AND principal_id=$3 AND resource_type='microsoft.copilotstudio/agents' AND native_id=ANY($4::text[])
      ORDER BY native_id COLLATE "C",environment_id COLLATE "C"`, [snapshotId, scope.tenantId, scope.principalId, nativeIds]);
    const byNativeId = new Map<string, ResourceRow[]>();
    for (const resource of resources.rows) byNativeId.set(resource.native_id, [...(byNativeId.get(resource.native_id) ?? []), resource]);
    return nativeIds.map(resourceNativeId => {
      const matches = byNativeId.get(resourceNativeId) ?? [];
      if (!matches.length) throw new AppError(409, "quarantine_target_unavailable", "The native Copilot Studio inventory target is missing from the selected current snapshot.");
      const resolution = quarantineTargetResolution(selectedSnapshot, matches);
      if (!resolution.target) throw new AppError(409, resolution.errorCode!, resolution.reason!);
      return resolution.target;
    });
  }

  private async resolveSnapshot(scope: InventoryDataScope, snapshotId?: string) {
    const { rows } = await this.database.query<SnapshotRow>(`SELECT * FROM power_platform_inventory_snapshots
      WHERE tenant_id=$1 AND principal_id=$2 AND expires_at>clock_timestamp()
        AND is_current AND ($3::uuid IS NOT NULL AND id=$3 OR $3::uuid IS NULL)
      ORDER BY CASE WHEN environment_scope='' AND jsonb_array_length(requested_types)=11 THEN 1 ELSE 0 END DESC,observed_at DESC LIMIT 1`, [scope.tenantId, scope.principalId, snapshotId ?? null]);
    return rows[0];
  }
}

function validatePublication(scope: InventoryDataScope, job: JobRow, result: ResourceQueryResult) {
  if (!Number.isSafeInteger(result.totalRecords) || result.totalRecords !== result.resources.length || result.pages < 1 || result.pages > 50) throw new AppError(409, "incomplete_inventory_coverage", "Only a completely enumerated inventory result can be published.");
  const requested = new Set(job.requested_types);
  for (const resource of result.resources) {
    if (resource.tenantId !== scope.tenantId || !requested.has(resource.type) || job.environment_scope && resource.environmentId !== job.environment_scope) {
      throw new AppError(403, "scope_mismatch", "Inventory publication did not match the requested tenant, environment, or resource types.");
    }
  }
}

export function buildCoverage(roleScope: InventoryRoleScope, requestedTypes: readonly PowerPlatformResourceType[], resources: readonly PowerPlatformResource[]): InventoryTypeCoverage[] {
  const requested = new Set(requestedTypes);
  const aiTypes = new Set<PowerPlatformResourceType>([
    "microsoft.powerapps/codeapps", "microsoft.powerapps/apps", "microsoft.powerautomate/agentflows", "microsoft.powerautomate/m365agentflows",
    "microsoft.copilotstudio/agents", "microsoft.powerplatform/environments", "microsoft.powerplatform/environmentgroups",
  ]);
  const counts = new Map<PowerPlatformResourceType, number>();
  for (const resource of resources) counts.set(resource.type, (counts.get(resource.type) ?? 0) + 1);
  return powerPlatformResourceTypes.map(type => {
    if (roleScope === "ai" && !aiTypes.has(type)) return { type, status: "not_authorized_scope", count: null };
    if (!requested.has(type)) return { type, status: "unknown", count: null };
    if (roleScope === "unknown") return { type, status: "unknown", count: counts.has(type) ? counts.get(type)! : null };
    return { type, status: "covered", count: counts.get(type) ?? 0 };
  });
}

function emptyCoverage(): InventoryTypeCoverage[] {
  return powerPlatformResourceTypes.map(type => ({ type, status: "unknown", count: null }));
}

function listFilters(snapshotId: string, scope: InventoryDataScope, query: InventoryListQuery) {
  const conditions = ["true"];
  const values: unknown[] = [snapshotId, scope.tenantId, scope.principalId];
  if (query.type) { values.push(query.type); conditions.push(`resource_type=$${values.length}`); }
  if (query.environmentId) { values.push(query.environmentId); conditions.push(`environment_id=$${values.length}`); }
  if (query.search) { values.push(`%${query.search}%`); conditions.push(`(display_name ILIKE $${values.length} OR native_id ILIKE $${values.length})`); }
  return { sql: conditions.join(" AND "), values };
}

function projectResource(row: ResourceRow): PowerPlatformResource {
  return {
    tenantId: row.tenant_id, nativeId: row.native_id, type: row.resource_type, environmentId: row.environment_id || null, location: row.location,
    displayName: row.display_name, createdAt: row.created_at?.toISOString() ?? null, createdBy: row.created_by, lastPublishedAt: row.last_published_at?.toISOString() ?? null,
    sourceSystem: row.source_system, authoringTool: row.authoring_tool, creatorType: row.creator_type, agentKind: row.agent_kind, lifecycle: row.lifecycle,
    identityConfidence: row.identity_confidence, identifiers: row.identifiers, provenance: row.provenance, details: row.details, unknownFieldCount: row.unknown_field_count,
  };
}

function projectSnapshot(row: SnapshotRow): InventorySnapshot {
  return {
    id: row.id, roleScope: row.role_scope, environmentScope: row.environment_scope || null, requestedTypes: row.requested_types, coverage: row.coverage,
    observedCount: row.observed_count, totalRecords: row.total_records, pageCount: row.page_count, unknownFieldCount: row.unknown_field_count,
    observedAt: row.observed_at.toISOString(), expiresAt: row.expires_at.toISOString(),
  };
}

function projectQuarantineCandidate(snapshot: SnapshotRow, matches: ResourceRow[], stale: boolean): QuarantineTargetCandidate {
  const resolution = quarantineTargetResolution(snapshot, matches);
  const resource = matches[0];
  const target = resolution.target;
  const identifiers = resource.identifiers.filter((identifier): identifier is { kind: "environment_id" | "cds_bot_id"; value: string } => identifier.kind === "environment_id" || identifier.kind === "cds_bot_id");
  const details = {
    ...(typeof resource.details.isQuarantined === "boolean" ? { isQuarantined: resource.details.isQuarantined } : {}),
    ...(typeof resource.details.quarantinedAt === "string" ? { quarantinedAt: resource.details.quarantinedAt } : {}),
  };
  if (stale) return { nativeId: resource.native_id, type: "microsoft.copilotstudio/agents", displayName: resource.display_name ?? resource.native_id,
    environmentId: matches.length === 1 ? resource.environment_id || null : null, botId: matches.length === 1 ? singleIdentifier(identifiers, "cds_bot_id") : null, identifiers, details,
    quarantineEligibility: { eligible: false, code: "stale_snapshot", reason: "The saved inventory target is older than 24 hours. A Viewer must refresh inventory explicitly before quarantine work." } };
  return { nativeId: resource.native_id, type: "microsoft.copilotstudio/agents", displayName: resource.display_name ?? resource.native_id,
    environmentId: target?.environmentId ?? null, botId: target?.botId ?? null, identifiers, details,
    quarantineEligibility: target ? { eligible: true, code: "eligible" } : { eligible: false, code: eligibilityCode(resolution.errorCode!), reason: resolution.reason } };
}

function quarantineTargetResolution(snapshot: SnapshotRow, matches: ResourceRow[]): { target?: InventoryQuarantineTarget; errorCode?: string; reason?: string } {
  if (matches.length !== 1) return { errorCode: "quarantine_target_ambiguous", reason: "The native inventory target is ambiguous across environments." };
  const resource = matches[0];
  const botIds = resource.identifiers.filter(identifier => identifier.kind === "cds_bot_id").map(identifier => identifier.value);
  const environmentIds = resource.identifiers.filter(identifier => identifier.kind === "environment_id").map(identifier => identifier.value);
  if (!resource.environment_id || botIds.length !== 1 || environmentIds.length !== 1 || environmentIds[0] !== resource.environment_id) {
    return { errorCode: "quarantine_native_identity_unavailable", reason: "The inventory target does not have one exact native environment and bot identity." };
  }
  try { validateQuarantineTarget({ environmentId: resource.environment_id, botId: botIds[0] }); }
  catch { return { errorCode: "quarantine_native_identity_unavailable", reason: "The inventory target does not have valid native environment and bot identities." }; }
  return { target: {
    resourceNativeId: resource.native_id, displayName: resource.display_name ?? resource.native_id, snapshotId: snapshot.id,
    inventoryObservedAt: snapshot.observed_at.toISOString(), inventoryExpiresAt: snapshot.expires_at.toISOString(), environmentId: resource.environment_id, botId: botIds[0],
    inventoryQuarantineState: typeof resource.details.isQuarantined === "boolean" ? resource.details.isQuarantined : null,
    inventoryQuarantinedAt: typeof resource.details.quarantinedAt === "string" ? resource.details.quarantinedAt : null,
  } };
}

function singleIdentifier(identifiers: QuarantineTargetCandidate["identifiers"], kind: "environment_id" | "cds_bot_id") {
  const values = identifiers.filter(identifier => identifier.kind === kind).map(identifier => identifier.value);
  return values.length === 1 ? values[0] : null;
}

function eligibilityCode(errorCode: string): QuarantineTargetEligibilityCode {
  return errorCode === "quarantine_target_ambiguous" ? "ambiguous_native_id" : "native_identity_unavailable";
}

function projectJob(row: JobRow): InventoryRefreshJob {
  return {
    id: row.id, status: row.status, roleScope: row.role_scope, environmentScope: row.environment_scope || null, requestedTypes: row.requested_types,
    pageCount: row.page_count, observedCount: row.observed_count, totalRecords: row.total_records, unknownFieldCount: row.unknown_field_count, snapshotId: row.snapshot_id,
    ...(row.error_code ? { errorCode: row.error_code } : {}), ...(row.message ? { message: row.message } : {}),
    createdAt: row.created_at.toISOString(), attemptedAt: row.attempted_at?.toISOString() ?? null, updatedAt: row.updated_at.toISOString(), finishedAt: row.finished_at?.toISOString() ?? null,
  };
}

function validateScope(scope: InventoryDataScope) {
  if (!scope.tenantId || !scope.principalId) throw new AppError(403, "scope_mismatch", "Inventory requires a tenant and current principal scope.");
}

function validateTypes(types: readonly PowerPlatformResourceType[]) {
  const allowed = new Set<string>(powerPlatformResourceTypes);
  const unique = [...new Set(types)].sort(ordinal);
  if (!unique.length || unique.some(type => !allowed.has(type))) throw new AppError(400, "invalid_inventory_scope", "Inventory resource types must use the supported allowlist.");
  return unique;
}

function validateEnvironment(value: string | undefined) {
  if (value === undefined || value === "") return "";
  if (typeof value !== "string" || value.length > 512 || /[\r\n\0]/.test(value)) throw new AppError(400, "invalid_inventory_scope", "Inventory environment scope is invalid.");
  return value;
}

function queryHash(roleScope: InventoryRoleScope, environmentScope: string, requestedTypes: readonly PowerPlatformResourceType[]) {
  return createHash("sha256").update(JSON.stringify({ cloud: "global", roleScope, environmentScope, requestedTypes })).digest("hex");
}

function resourceIdentity(resource: PowerPlatformResource) {
  return `${resource.type}\0${resource.environmentId ?? ""}\0${resource.nativeId}`;
}

function safeCode(value: string) {
  return /^[a-z0-9_]{1,128}$/.test(value) ? value : "provider_error";
}

function ordinal(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}