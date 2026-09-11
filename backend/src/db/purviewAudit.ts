import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";
import { AppError } from "../errors.js";
import { resolveExactInventoryIdentity, type InventoryIdentityRecord } from "../services/inventoryIdentity.js";
import { resourceTypesForInventoryScope } from "../services/inventoryRoleScope.js";
import { requireProviderAdmissions } from "../services/operationalState.js";
import type {
  PurviewAuditFilters,
  PurviewAuditHistory,
  PurviewAuditJob,
  PurviewAuditPartialReason,
  PurviewAuditQualification,
  PurviewAuditRecord,
  PurviewAuditRecordPage,
  PurviewAuditResultScope,
  PurviewAuditResult,
  PurviewAuditTokenMode,
  PurviewProviderQueryStatus,
} from "../types/purviewAudit.js";
import { purviewAuditPresets } from "../types/purviewAudit.js";
import type { InventoryRoleScope, PowerPlatformResourceType } from "../types/powerPlatformInventory.js";
import { pool, transaction } from "./pool.js";

export type PurviewAuditScope = {
  tenantId: string;
  authorizationPrincipalId: string;
  resultScope: PurviewAuditResultScope;
  tokenMode: PurviewAuditTokenMode;
};

export type PurviewAuditReadScope = {
  tenantId: string;
  resultScopes: PurviewAuditResultScope[];
  inventoryIdentityScope?: { principalId: string; roleScope: Exclude<InventoryRoleScope, "unknown">; resourceTypes: PowerPlatformResourceType[] };
};

export type PurviewAuditExecution = {
  owner: string;
  version: number;
};

export type QualificationInput = {
  filters: PurviewAuditFilters;
  capabilityId: "purview.audit.search.delegated" | "purview.audit.search.application";
  contractRevision: string;
  permissionRevision: string;
  configurationRevision: number;
  approvedBy: string;
};

type JobRow = {
  id: string;
  authorization_principal_id: string;
  result_scope_id: string;
  result_scope_kind: PurviewAuditResultScope["kind"];
  result_scope_configuration_revision: string | null;
  token_mode: PurviewAuditTokenMode;
  status: PurviewAuditJob["status"];
  filters: PurviewAuditFilters;
  display_name: string;
  provider_query_id: string | null;
  provider_status: PurviewProviderQueryStatus | null;
  local_request_id: string;
  provider_request_id: string | null;
  projection_version: 1;
  provider_request_count: number;
  activation_count: number;
  execution_version: string;
  execution_owner: string | null;
  page_count: number;
  provider_row_count: number;
  stored_row_count: number;
  byte_count: number;
  unknown_field_count: number;
  page_complete: boolean;
  observed_start: Date | null;
  observed_end: Date | null;
  unobserved_start: Date | null;
  unobserved_end: Date | null;
  error_code: string | null;
  message: string | null;
  qualification_id: string | null;
  cancel_requested: boolean;
  remote_work_may_continue: boolean;
  created_at: Date;
  attempted_at: Date | null;
  updated_at: Date;
  finished_at: Date | null;
  deadline_at: Date;
  expires_at: Date;
};

type QualificationRow = {
  id: string;
  request_hash: string;
  capability_id: QualificationInput["capabilityId"];
  token_mode: PurviewAuditTokenMode;
  authorization_principal_id: string;
  result_scope_id: string;
  result_scope_kind: PurviewAuditResultScope["kind"];
  result_scope_configuration_revision: string | null;
  filters: PurviewAuditFilters;
  status: PurviewAuditQualification["status"];
  contract_revision: string;
  permission_revision: string;
  configuration_revision: string;
  approved_by: string;
  approved_at: Date;
  expires_at: Date;
  job_id: string | null;
  error_code: string | null;
};

type RecordRow = {
  projection_version: 1;
  wrapper_id: string;
  native_event_id: string | null;
  event_time: Date;
  audit_log_record_type: string;
  operation: string;
  service: string;
  result_status: string | null;
  actor_user_id: string | null;
  actor_user_principal_name: string | null;
  actor_user_type: string | null;
  object_id: string | null;
  client_ip: string | null;
  administrative_units: string[];
  correlation_id: string | null;
  agent_id: string | null;
  app_identity: string | null;
  app_host: string | null;
  bot_id: string | null;
  environment_id: string | null;
  bot_component_id: string | null;
  ai_plugin_operation_id: string | null;
  messages: PurviewAuditRecord["messages"];
  content_available: false;
  unknown_field_count: number;
  association: PurviewAuditRecord["association"] | null;
};

type InventoryIdentityRow = {
  native_id: string;
  resource_type: string;
  environment_id: string;
  identifiers: Array<{ kind: string; value: string }>;
};

export class PurviewAuditRepository {
  constructor(private readonly database: pg.Pool = pool) {}

  async approveQualification(scope: PurviewAuditScope, input: QualificationInput) {
    requireProviderAdmissions();
    validateScope(scope);
    validateQualification(input, scope.tokenMode);
    const id = randomUUID();
    await transaction(this.database, async client => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`purview-qualification:${scope.tenantId}:${input.capabilityId}`]);
      const active = await client.query(`SELECT 1 FROM purview_audit_qualifications
        WHERE tenant_id=$1 AND capability_id=$2 AND status IN ('approved','running') AND expires_at>clock_timestamp() LIMIT 1`, [scope.tenantId, input.capabilityId]);
      if (active.rowCount) throw new AppError(409, "qualification_in_progress", "An unexpired Audit Search qualification already exists for this capability.");
      await client.query(`INSERT INTO purview_audit_qualifications
        (id,tenant_id,authorization_principal_id,result_scope_id,result_scope_kind,result_scope_configuration_revision,token_mode,capability_id,filters,request_hash,contract_revision,permission_revision,configuration_revision,approved_by)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,$14)`, [id, scope.tenantId, scope.authorizationPrincipalId, scope.resultScope.scopeId,
        scope.resultScope.kind, scope.resultScope.configurationRevision, scope.tokenMode, input.capabilityId, JSON.stringify(input.filters), requestHash(scope, input.filters),
        input.contractRevision, input.permissionRevision, input.configurationRevision, input.approvedBy]);
    });
    return (await this.getQualification(scope.tenantId, id))!;
  }

  async getQualification(tenantId: string, id: string) {
    const { rows } = await this.database.query<QualificationRow>(`SELECT * FROM purview_audit_qualifications WHERE tenant_id=$1 AND id=$2`, [tenantId, id]);
    return rows[0] ? projectQualification(rows[0]) : undefined;
  }

  async submit(scope: PurviewAuditScope, input: { idempotencyKey: string; filters: PurviewAuditFilters; qualificationId?: string }) {
    requireProviderAdmissions();
    validateScope(scope);
    if (typeof input.idempotencyKey !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(input.idempotencyKey)) throw new AppError(400, "invalid_idempotency_key", "Idempotency-Key must contain 1-128 letters, digits, underscores or hyphens.");
    const hash = requestHash(scope, input.filters);
    const id = await transaction(this.database, async client => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`purview-job:${scope.tenantId}`]);
      const existing = await client.query<{ id: string; request_hash: string }>(`SELECT id,request_hash FROM purview_audit_jobs
        WHERE tenant_id=$1 AND result_scope_kind=$2 AND result_scope_id=$3 AND result_scope_configuration_revision IS NOT DISTINCT FROM $4
          AND token_mode=$5 AND idempotency_key=$6`, [scope.tenantId, scope.resultScope.kind, scope.resultScope.scopeId, scope.resultScope.configurationRevision, scope.tokenMode, input.idempotencyKey]);
      if (existing.rows[0]) {
        if (existing.rows[0].request_hash !== hash) throw new AppError(409, "idempotency_mismatch", "This idempotency key belongs to different Audit Search filters or authority.");
        return existing.rows[0].id;
      }
      const unfinished = await client.query<{ principal_count: number; tenant_count: number }>(`SELECT
        count(*) FILTER (WHERE authorization_principal_id=$2)::int AS principal_count,count(*)::int AS tenant_count
        FROM purview_audit_jobs WHERE tenant_id=$1 AND status IN ('waiting_authorization','reconciling_create','running') AND expires_at>clock_timestamp()`, [scope.tenantId, scope.authorizationPrincipalId]);
      if (unfinished.rows[0].principal_count >= 5 || unfinished.rows[0].tenant_count >= 10) throw new AppError(429, "job_limit", "The bounded Audit Search unfinished-job limit was reached.");
      if (input.qualificationId) await validateQualificationForJob(client, scope, input.qualificationId, input.filters);
      const jobId = randomUUID();
      await client.query(`INSERT INTO purview_audit_jobs
        (id,tenant_id,authorization_principal_id,result_scope_id,result_scope_kind,result_scope_configuration_revision,token_mode,idempotency_key,request_hash,display_name,filters,local_request_id,qualification_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13)`, [jobId, scope.tenantId, scope.authorizationPrincipalId, scope.resultScope.scopeId,
        scope.resultScope.kind, scope.resultScope.configurationRevision, scope.tokenMode, input.idempotencyKey, hash, `agent-control-audit:${jobId}`, JSON.stringify(input.filters), randomUUID(), input.qualificationId ?? null]);
      if (input.qualificationId) await client.query("UPDATE purview_audit_qualifications SET job_id=$3,updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2", [scope.tenantId, input.qualificationId, jobId]);
      return jobId;
    });
    return (await this.getJob(scope, id))!;
  }

  async getJob(scope: PurviewAuditReadScope | PurviewAuditScope, id: string) {
    const read = scopedWhere(toReadScope(scope));
    const { rows } = await this.database.query<JobRow>(`SELECT * FROM purview_audit_jobs
      WHERE id=$${read.values.length + 1} AND ${read.sql} AND expires_at>clock_timestamp()`, [...read.values, id]);
    return rows[0] ? projectJob(rows[0]) : undefined;
  }

  async listJobs(scope: PurviewAuditReadScope, limit = 20, offset = 0): Promise<PurviewAuditHistory> {
    const read = scopedWhere(scope);
    const bounded = Math.min(Math.max(limit, 1), 50);
    const boundedOffset = Math.min(Math.max(offset, 0), 100_000);
    const { rows } = await this.database.query<JobRow>(`SELECT * FROM purview_audit_jobs
      WHERE ${read.sql} AND expires_at>clock_timestamp()
      ORDER BY created_at DESC,id DESC LIMIT $${read.values.length + 1} OFFSET $${read.values.length + 2}`, [...read.values, bounded, boundedOffset]);
    const count = await this.database.query<{ count: number }>(`SELECT count(*)::int AS count FROM purview_audit_jobs
      WHERE ${read.sql} AND expires_at>clock_timestamp()`, read.values);
    return { value: rows.map(projectJob), count: count.rows[0].count, limit: bounded, offset: boundedOffset };
  }

  async begin(scope: PurviewAuditScope, id: string) {
    validateScope(scope);
    return transaction(this.database, async client => {
      const result = await client.query<Pick<JobRow, "provider_query_id" | "attempted_at" | "activation_count" | "execution_version">>(`SELECT provider_query_id,attempted_at,activation_count,execution_version FROM purview_audit_jobs
        WHERE id=$1 AND tenant_id=$2 AND result_scope_kind=$3 AND result_scope_id=$4 AND result_scope_configuration_revision IS NOT DISTINCT FROM $5
          AND authorization_principal_id=$6 AND token_mode=$7 AND status='waiting_authorization' AND NOT cancel_requested
          AND expires_at>clock_timestamp() AND deadline_at>clock_timestamp() FOR UPDATE`,
      [id, scope.tenantId, scope.resultScope.kind, scope.resultScope.scopeId, scope.resultScope.configurationRevision, scope.authorizationPrincipalId, scope.tokenMode]);
      const job = result.rows[0];
      if (!job) throw new AppError(409, "audit_job_state", "Audit Search is not waiting for this exact current authority.");
      if (job.activation_count >= 12) throw new AppError(409, "audit_activation_limit", "Audit Search reached its durable activation limit.");
      const action: "create" | "reconcile" | "poll" = job.provider_query_id ? "poll" : job.attempted_at ? "reconcile" : "create";
      const owner = randomUUID();
      const updated = await client.query<JobRow>(`UPDATE purview_audit_jobs SET status=$6,updated_at=clock_timestamp(),error_code=NULL,message=NULL,
        activation_count=activation_count+1,execution_version=execution_version+1,execution_owner=$7
        WHERE id=$1 AND tenant_id=$2 AND result_scope_kind=$3 AND result_scope_id=$4 AND result_scope_configuration_revision IS NOT DISTINCT FROM $5 RETURNING *`,
      [id, scope.tenantId, scope.resultScope.kind, scope.resultScope.scopeId, scope.resultScope.configurationRevision, action === "poll" ? "running" : "reconciling_create", owner]);
      await client.query(`UPDATE purview_audit_qualifications SET status='running',attempted_at=COALESCE(attempted_at,clock_timestamp()),updated_at=clock_timestamp()
        WHERE tenant_id=$1 AND job_id=$2 AND status='approved'`, [scope.tenantId, id]);
      const row = updated.rows[0];
      return { action, owner, version: Number(row.execution_version), job: projectJob(row) };
    });
  }

  async authorizeProviderRequest(scope: PurviewAuditScope, id: string, execution: PurviewAuditExecution) {
    await transaction(this.database, async client => {
      const job = await this.fence(client, scope, id, execution);
      if (job.deadline_at <= new Date()) throw new AppError(409, "audit_job_expired", "Audit Search reached its durable execution deadline.");
      if (job.provider_request_count >= 64) throw new AppError(409, "audit_provider_request_limit", "Audit Search reached its durable provider request limit.");
      await client.query(`UPDATE purview_audit_jobs SET provider_request_count=provider_request_count+1,
        attempted_at=COALESCE(attempted_at,clock_timestamp()),updated_at=clock_timestamp()
        WHERE id=$1 AND execution_owner=$2 AND execution_version=$3`, [id, execution.owner, execution.version]);
    });
  }

  async recordProviderResponse(scope: PurviewAuditScope, id: string, execution: PurviewAuditExecution, providerRequestId: string | null) {
    if (providerRequestId !== null && (providerRequestId.length < 1 || providerRequestId.length > 256 || /[\r\n\0]/.test(providerRequestId))) {
      throw new AppError(502, "provider_schema", "Microsoft Graph returned an invalid request identifier.");
    }
    const result = await this.database.query(`UPDATE purview_audit_jobs SET provider_request_id=COALESCE($10,provider_request_id),updated_at=clock_timestamp()
      WHERE id=$1 AND tenant_id=$2 AND result_scope_kind=$3 AND result_scope_id=$4 AND result_scope_configuration_revision IS NOT DISTINCT FROM $5
        AND authorization_principal_id=$6 AND token_mode=$7 AND execution_owner=$8 AND execution_version=$9
        AND status IN ('running','reconciling_create') AND NOT cancel_requested RETURNING id`,
    [id, scope.tenantId, scope.resultScope.kind, scope.resultScope.scopeId, scope.resultScope.configurationRevision, scope.authorizationPrincipalId, scope.tokenMode,
      execution.owner, execution.version, providerRequestId]);
    if (result.rowCount !== 1) throw executionLost();
  }

  async recordProviderQuery(scope: PurviewAuditScope, id: string, execution: PurviewAuditExecution, providerQueryId: string, providerStatus: PurviewProviderQueryStatus) {
    const result = await this.database.query(`UPDATE purview_audit_jobs SET provider_query_id=$8,provider_status=$9,status='running',updated_at=clock_timestamp()
      WHERE id=$1 AND tenant_id=$2 AND result_scope_kind=$3 AND result_scope_id=$4 AND result_scope_configuration_revision IS NOT DISTINCT FROM $5
        AND execution_owner=$6 AND execution_version=$7 AND status='reconciling_create' AND NOT cancel_requested
        AND (provider_query_id IS NULL OR provider_query_id=$8) RETURNING id`,
    [id, scope.tenantId, scope.resultScope.kind, scope.resultScope.scopeId, scope.resultScope.configurationRevision, execution.owner, execution.version, providerQueryId, providerStatus]);
    if (result.rowCount !== 1) throw new AppError(409, "audit_job_state", "Audit Search provider identity arrived after the job stopped or conflicted.");
  }

  async recordProviderStatus(scope: PurviewAuditScope, id: string, execution: PurviewAuditExecution, providerStatus: PurviewProviderQueryStatus) {
    const result = await this.database.query(`UPDATE purview_audit_jobs SET provider_status=$8,updated_at=clock_timestamp()
      WHERE id=$1 AND tenant_id=$2 AND result_scope_kind=$3 AND result_scope_id=$4 AND result_scope_configuration_revision IS NOT DISTINCT FROM $5
        AND execution_owner=$6 AND execution_version=$7 AND status='running' AND NOT cancel_requested RETURNING id`,
    [id, scope.tenantId, scope.resultScope.kind, scope.resultScope.scopeId, scope.resultScope.configurationRevision, execution.owner, execution.version, providerStatus]);
    if (result.rowCount !== 1) throw new AppError(409, "audit_job_state", "Audit Search status arrived after the job stopped.");
  }

  async markWaitingAuthorization(scope: PurviewAuditScope, id: string, execution: PurviewAuditExecution) {
    await transaction(this.database, async client => {
      const result = await client.query<{ status: PurviewAuditJob["status"]; error_code: string }>(`UPDATE purview_audit_jobs SET
        status=CASE WHEN deadline_at<=clock_timestamp() OR expires_at<=clock_timestamp() OR provider_request_count>=64 OR activation_count>=12 THEN 'inconclusive' ELSE 'waiting_authorization' END,
        error_code=CASE WHEN deadline_at<=clock_timestamp() OR expires_at<=clock_timestamp() THEN 'audit_job_expired' WHEN provider_request_count>=64 THEN 'audit_provider_request_limit'
          WHEN activation_count>=12 THEN 'audit_activation_limit' ELSE 'interaction_required' END,
        message=CASE WHEN deadline_at<=clock_timestamp() OR expires_at<=clock_timestamp() THEN 'The local Audit Search deadline expired; remote work may continue.'
          WHEN provider_request_count>=64 THEN 'The durable provider request limit was reached; explicit resume cannot continue this search.'
          WHEN activation_count>=12 THEN 'The durable activation limit was reached; explicit resume cannot continue this search.'
          ELSE 'Explicit resume with current Audit Search authorization is required.' END,
        remote_work_may_continue=CASE WHEN deadline_at<=clock_timestamp() OR expires_at<=clock_timestamp() OR provider_request_count>=64 OR activation_count>=12
          THEN attempted_at IS NOT NULL AND (provider_status IS NULL OR provider_status IN ('notStarted','running')) ELSE remote_work_may_continue END,
        finished_at=CASE WHEN deadline_at<=clock_timestamp() OR expires_at<=clock_timestamp() OR provider_request_count>=64 OR activation_count>=12 THEN clock_timestamp() ELSE NULL END,
        execution_owner=NULL,updated_at=clock_timestamp()
        WHERE id=$1 AND tenant_id=$2 AND result_scope_kind=$3 AND result_scope_id=$4 AND result_scope_configuration_revision IS NOT DISTINCT FROM $5
          AND execution_owner=$6 AND execution_version=$7 AND status IN ('running','reconciling_create') AND NOT cancel_requested RETURNING status,error_code`,
      [id, scope.tenantId, scope.resultScope.kind, scope.resultScope.scopeId, scope.resultScope.configurationRevision, execution.owner, execution.version]);
      if (result.rowCount !== 1) throw executionLost();
      if (result.rows[0].status === "inconclusive") {
        await client.query(`UPDATE purview_audit_qualifications SET status='inconclusive',error_code=$3,finished_at=clock_timestamp(),updated_at=clock_timestamp()
          WHERE tenant_id=$1 AND job_id=$2 AND status IN ('approved','running')`, [scope.tenantId, id, result.rows[0].error_code]);
      }
    });
    return this.getJob(scope, id);
  }

  async publish(scope: PurviewAuditScope, id: string, execution: PurviewAuditExecution, result: PurviewAuditResult) {
    validateScope(scope);
    const partial = partialPublication(result.complete, result.partialReason);
    if (result.records.length !== result.storedRowCount || result.pageCount > 20 || result.providerRowCount > 5001 || result.records.some(record => record.contentAvailable !== false)) {
      throw new AppError(409, "invalid_audit_publication", "Audit Search publication exceeded the minimized result contract.");
    }
    await transaction(this.database, async client => {
      const job = await this.fence(client, scope, id, execution, ["running"]);
      if (job.deadline_at <= new Date()) throw new AppError(409, "audit_job_expired", "Audit Search results arrived after its deadline.");
      if (result.records.length) {
        const rows = result.records.map(record => ({
          wrapper_id: record.wrapperId, native_event_id: record.nativeEventId, event_time: record.eventDateTime, audit_log_record_type: record.auditLogRecordType,
          operation: record.operation, service: record.service, result_status: record.resultStatus, actor_user_id: record.actorUserId,
          actor_user_principal_name: record.actorUserPrincipalName, actor_user_type: record.actorUserType, object_id: record.objectId, client_ip: record.clientIp,
          administrative_units: record.administrativeUnits, correlation_id: record.correlationId, agent_id: record.agentId, app_identity: record.appIdentity,
          app_host: record.appHost, bot_id: record.botId, environment_id: record.environmentId, bot_component_id: record.botComponentId,
          ai_plugin_operation_id: record.aiPluginOperationId, messages: record.messages, content_available: false, unknown_field_count: record.unknownFieldCount,
          association: null,
        }));
        await client.query(`INSERT INTO purview_audit_records
          (job_id,tenant_id,result_scope_id,result_scope_kind,result_scope_configuration_revision,projection_version,wrapper_id,native_event_id,event_time,audit_log_record_type,operation,service,result_status,actor_user_id,
           actor_user_principal_name,actor_user_type,object_id,client_ip,administrative_units,correlation_id,agent_id,app_identity,app_host,bot_id,environment_id,
           bot_component_id,ai_plugin_operation_id,messages,content_available,unknown_field_count,association)
          SELECT $1,$2,$3,$4,$5,1,row.wrapper_id,row.native_event_id,row.event_time,row.audit_log_record_type,row.operation,row.service,row.result_status,row.actor_user_id,
            row.actor_user_principal_name,row.actor_user_type,row.object_id,row.client_ip,row.administrative_units,row.correlation_id,row.agent_id,row.app_identity,row.app_host,
            row.bot_id,row.environment_id,row.bot_component_id,row.ai_plugin_operation_id,row.messages,row.content_available,row.unknown_field_count,row.association
          FROM jsonb_to_recordset($6::jsonb) AS row(wrapper_id text,native_event_id uuid,event_time timestamptz,audit_log_record_type text,operation text,service text,
            result_status text,actor_user_id text,actor_user_principal_name text,actor_user_type text,object_id text,client_ip text,administrative_units jsonb,correlation_id text,
            agent_id text,app_identity text,app_host text,bot_id text,environment_id text,bot_component_id text,ai_plugin_operation_id text,messages jsonb,
            content_available boolean,unknown_field_count integer,association jsonb)`, [id, scope.tenantId, scope.resultScope.scopeId, scope.resultScope.kind,
          scope.resultScope.configurationRevision, JSON.stringify(rows)]);
      }
      const complete = result.complete;
      await client.query(`UPDATE purview_audit_jobs SET status=$6,page_count=$7,provider_row_count=$8,stored_row_count=$9,byte_count=$10,unknown_field_count=$11,page_complete=$12,
        observed_start=(SELECT min(event_time) FROM purview_audit_records WHERE job_id=$1),observed_end=(SELECT max(event_time) FROM purview_audit_records WHERE job_id=$1),
        unobserved_start=CASE WHEN NOT $12 THEN (filters->>'startDateTime')::timestamptz END,unobserved_end=CASE WHEN NOT $12 THEN (filters->>'endDateTime')::timestamptz END,
        error_code=$15,message=$16,finished_at=clock_timestamp(),updated_at=clock_timestamp(),execution_owner=NULL
        WHERE id=$1 AND tenant_id=$2 AND result_scope_kind=$3 AND result_scope_id=$4 AND result_scope_configuration_revision IS NOT DISTINCT FROM $5
          AND execution_owner=$13 AND execution_version=$14`,
      [id, scope.tenantId, scope.resultScope.kind, scope.resultScope.scopeId, scope.resultScope.configurationRevision, complete ? "succeeded" : "partial", result.pageCount,
        result.providerRowCount, result.storedRowCount, Math.min(result.byteCount, 10_000_000), result.unknownFieldCount, complete, execution.owner, execution.version,
        partial?.code ?? null, partial?.message ?? null]);
      await client.query(`UPDATE purview_audit_qualifications SET status=CASE WHEN $3 THEN 'qualified' ELSE 'inconclusive' END,
        error_code=$4,finished_at=clock_timestamp(),updated_at=clock_timestamp()
        WHERE tenant_id=$1 AND job_id=$2 AND status='running'`, [scope.tenantId, id, complete, partial?.code ?? null]);
    });
    return (await this.getJob(scope, id))!;
  }

  async fail(scope: PurviewAuditScope, id: string, execution: PurviewAuditExecution, code: string, message: string, inconclusive = false) {
    const status = inconclusive ? "inconclusive" : "failed";
    await transaction(this.database, async client => {
      await this.fence(client, scope, id, execution);
      await client.query(`UPDATE purview_audit_jobs SET status=$4,error_code=$5,message=$6,
        remote_work_may_continue=$7 AND attempted_at IS NOT NULL AND (provider_status IS NULL OR provider_status IN ('notStarted','running')),
        finished_at=clock_timestamp(),updated_at=clock_timestamp(),execution_owner=NULL
        WHERE id=$1 AND tenant_id=$2 AND result_scope_id=$3 AND execution_owner=$8 AND execution_version=$9`,
      [id, scope.tenantId, scope.resultScope.scopeId, status, safeCode(code), message.slice(0, 1024), inconclusive, execution.owner, execution.version]);
      await client.query(`UPDATE purview_audit_qualifications SET status=$3,error_code=$4,finished_at=clock_timestamp(),updated_at=clock_timestamp()
        WHERE tenant_id=$1 AND job_id=$2 AND status IN ('approved','running')`, [scope.tenantId, id, status, safeCode(code)]);
    });
    return this.getJob(scope, id);
  }

  async cancel(scope: PurviewAuditReadScope | PurviewAuditScope, id: string) {
    const read = scopedWhere(toReadScope(scope));
    await transaction(this.database, async client => {
      const result = await client.query<{ qualification_id: string | null }>(`UPDATE purview_audit_jobs SET status='cancelled',cancel_requested=true,
        remote_work_may_continue=attempted_at IS NOT NULL AND (provider_status IS NULL OR provider_status IN ('notStarted','running')),
        error_code=NULL,message='Local polling and download stopped. Microsoft Graph may continue the remote query.',finished_at=clock_timestamp(),updated_at=clock_timestamp(),execution_owner=NULL
        WHERE id=$${read.values.length + 1} AND ${read.sql} AND status IN ('waiting_authorization','running','reconciling_create') RETURNING qualification_id`, [...read.values, id]);
      if (result.rowCount !== 1) throw new AppError(409, "audit_job_state", "Only an unfinished Audit Search can be cancelled locally.");
      if (result.rows[0].qualification_id) await client.query(`UPDATE purview_audit_qualifications SET status='failed',error_code='audit_cancelled',finished_at=clock_timestamp(),updated_at=clock_timestamp()
        WHERE tenant_id=$1 AND id=$2 AND status IN ('approved','running')`, [read.values[0], result.rows[0].qualification_id]);
    });
    return this.getJob(scope, id);
  }

  async delete(scope: PurviewAuditReadScope | PurviewAuditScope, id: string) {
    const read = scopedWhere(toReadScope(scope));
    await transaction(this.database, async client => {
      const selected = await client.query<{ qualification_id: string | null }>(`SELECT qualification_id FROM purview_audit_jobs WHERE id=$${read.values.length + 1} AND ${read.sql}
        AND status NOT IN ('running','reconciling_create') FOR UPDATE`, [...read.values, id]);
      if (selected.rowCount !== 1) throw new AppError(409, "audit_job_state", "Stop an active Audit Search before deleting its local cache.");
      if (selected.rows[0].qualification_id) await client.query(`UPDATE purview_audit_qualifications SET status='failed',error_code='audit_deleted',finished_at=clock_timestamp(),updated_at=clock_timestamp()
        WHERE tenant_id=$1 AND id=$2 AND status IN ('approved','running')`, [read.values[0], selected.rows[0].qualification_id]);
      await client.query("DELETE FROM purview_audit_jobs WHERE id=$1", [id]);
    });
  }

  async listRecords(scope: PurviewAuditReadScope | PurviewAuditScope, id: string, limit = 100, offset = 0): Promise<PurviewAuditRecordPage> {
    const readScope = toReadScope(scope);
    const job = await this.getJob(readScope, id);
    if (!job) throw new AppError(404, "not_found", "Audit Search job was not found.");
    const boundedLimit = Math.min(Math.max(limit, 1), 5_000);
    const boundedOffset = Math.min(Math.max(offset, 0), 100_000);
    const resultScope = job.resultScope;
    const rows = await this.database.query<RecordRow>(`SELECT * FROM purview_audit_records WHERE job_id=$1 AND tenant_id=$2 AND result_scope_kind=$3 AND result_scope_id=$4
      AND result_scope_configuration_revision IS NOT DISTINCT FROM $5 ORDER BY event_time DESC,wrapper_id COLLATE "C" DESC LIMIT $6 OFFSET $7`,
    [id, readScope.tenantId, resultScope.kind, resultScope.scopeId, resultScope.configurationRevision, boundedLimit, boundedOffset]);
    const count = await this.database.query<{ count: number }>(`SELECT count(*)::int AS count FROM purview_audit_records
      WHERE job_id=$1 AND tenant_id=$2 AND result_scope_kind=$3 AND result_scope_id=$4 AND result_scope_configuration_revision IS NOT DISTINCT FROM $5`,
    [id, readScope.tenantId, resultScope.kind, resultScope.scopeId, resultScope.configurationRevision]);
    const projected = rows.rows.map(projectRecord);
    const associations = await this.resolveAssociations(this.database, readScope, resultScope, projected);
    return { value: projected.map((record, index) => ({ ...record, association: associations[index] })), count: count.rows[0].count, limit: boundedLimit, offset: boundedOffset, job };
  }

  async relatedInventoryRecords(scope: PurviewAuditReadScope | PurviewAuditScope, target: { environmentId: string; botId: string }, limit = 20) {
    const read = scopedWhere(toReadScope(scope), "job");
    const boundedLimit = Math.min(Math.max(limit, 1), 50);
    const targetOffset = read.values.length;
    const filters = [...read.values, target.environmentId, target.botId, purviewAuditPresets.copilot_studio_admin.operationFilters, boundedLimit];
    const base = `FROM purview_audit_records record JOIN purview_audit_jobs job ON job.id=record.job_id AND job.tenant_id=record.tenant_id
      WHERE ${read.sql} AND job.expires_at>clock_timestamp() AND job.status IN ('succeeded','partial')
        AND record.audit_log_record_type='powerPlatformAdministratorActivity' AND record.service='PowerPlatform'
        AND record.environment_id=$${targetOffset + 1} AND record.bot_id=$${targetOffset + 2}
        AND record.operation=ANY($${targetOffset + 3}::text[])`;
    const [rows, count] = await Promise.all([
      this.database.query<{ job_id: string; native_event_id: string | null; wrapper_id: string; event_time: Date; operation: string; result_status: string | null; correlation_id: string | null }>(
        `SELECT record.job_id,record.native_event_id,record.wrapper_id,record.event_time,record.operation,record.result_status,record.correlation_id ${base}
          ORDER BY record.event_time DESC,record.wrapper_id COLLATE "C" DESC LIMIT $${targetOffset + 4}`, filters),
      this.database.query<{ count: number }>(`SELECT count(*)::int AS count ${base}`, filters.slice(0, -1)),
    ]);
    return { count: count.rows[0].count, value: rows.rows.map(row => ({
      jobId: row.job_id, nativeEventId: row.native_event_id, wrapperId: row.wrapper_id, observedAt: row.event_time.toISOString(),
      operation: row.operation, resultStatus: row.result_status, correlationId: row.correlation_id, matchedKind: "cds_bot_id" as const,
    })) };
  }

  async recoverInterrupted() {
    return transaction(this.database, async client => {
      const terminal = await client.query<{ id: string; tenant_id: string; error_code: string }>(`WITH candidates AS (
        SELECT id FROM purview_audit_jobs WHERE status IN ('running','reconciling_create')
          AND (expires_at<=clock_timestamp() OR deadline_at<=clock_timestamp() OR provider_request_count>=64 OR activation_count>=12)
        ORDER BY updated_at,id LIMIT 1000 FOR UPDATE SKIP LOCKED)
        UPDATE purview_audit_jobs job SET status='inconclusive',
          error_code=CASE WHEN expires_at<=clock_timestamp() OR deadline_at<=clock_timestamp() THEN 'audit_job_expired' WHEN provider_request_count>=64 THEN 'audit_provider_request_limit' ELSE 'audit_activation_limit' END,
          message=CASE WHEN expires_at<=clock_timestamp() OR deadline_at<=clock_timestamp() THEN 'The local Audit Search deadline expired; remote work may continue.'
            WHEN provider_request_count>=64 THEN 'The durable provider request limit was reached; explicit resume cannot continue this search.'
            ELSE 'The durable activation limit was reached; explicit resume cannot continue this search.' END,
          remote_work_may_continue=attempted_at IS NOT NULL AND (provider_status IS NULL OR provider_status IN ('notStarted','running')),
          finished_at=clock_timestamp(),execution_owner=NULL,updated_at=clock_timestamp()
        FROM candidates WHERE job.id=candidates.id RETURNING job.id,job.tenant_id,job.error_code`);
      if (terminal.rows.length) await client.query(`UPDATE purview_audit_qualifications qualification SET status='inconclusive',error_code=job.error_code,finished_at=clock_timestamp(),updated_at=clock_timestamp()
        FROM purview_audit_jobs job WHERE qualification.job_id=job.id AND qualification.tenant_id=job.tenant_id AND qualification.status IN ('approved','running')
          AND job.id=ANY($1::uuid[])`, [terminal.rows.map(row => row.id)]);
      const waiting = await client.query(`WITH candidates AS (
        SELECT id FROM purview_audit_jobs WHERE status IN ('running','reconciling_create') AND expires_at>clock_timestamp() AND deadline_at>clock_timestamp()
          AND provider_request_count<64 AND activation_count<12
        ORDER BY updated_at,id LIMIT 1000 FOR UPDATE SKIP LOCKED)
        UPDATE purview_audit_jobs job SET status='waiting_authorization',error_code='interaction_required',message='Explicit resume with current Audit Search authorization is required.',execution_owner=NULL,updated_at=clock_timestamp()
        FROM candidates WHERE job.id=candidates.id`);
      return (waiting.rowCount ?? 0) + (terminal.rowCount ?? 0);
    });
  }

  private async resolveAssociations(database: Pick<pg.Pool, "query">, readScope: PurviewAuditReadScope, resultScope: PurviewAuditResultScope, records: readonly PurviewAuditRecord[]) {
    const identityScope = readScope.inventoryIdentityScope;
    if (resultScope.kind !== "principal" || !identityScope || identityScope.principalId !== resultScope.scopeId) {
      return records.map(() => ({ status: "unresolved" as const, reason: "no_documented_cross_source_relation" as const }));
    }
    const candidates = await database.query<InventoryIdentityRow>(`SELECT DISTINCT resource.native_id COLLATE "C" AS native_id,resource.resource_type COLLATE "C" AS resource_type,
        resource.environment_id COLLATE "C" AS environment_id,resource.identifiers
      FROM power_platform_inventory_resources resource JOIN power_platform_inventory_snapshots snapshot ON snapshot.id=resource.snapshot_id
      WHERE snapshot.tenant_id=$1 AND snapshot.principal_id=$2 AND snapshot.role_scope=$3 AND snapshot.is_current AND snapshot.expires_at>clock_timestamp()
        AND resource.resource_type=ANY($4::text[])
      ORDER BY resource_type,environment_id,native_id,resource.identifiers`, [readScope.tenantId, identityScope.principalId, identityScope.roleScope, identityScope.resourceTypes]);
    const identities: InventoryIdentityRecord[] = candidates.rows.map(candidate => ({ nativeId: candidate.native_id, tenantId: readScope.tenantId, environmentId: candidate.environment_id,
      sourceSystem: "power_platform", resourceType: candidate.resource_type, identifiers: candidate.identifiers as InventoryIdentityRecord["identifiers"] }));
    return records.map(record => {
      if (record.auditLogRecordType !== "powerPlatformAdministratorActivity" || record.service !== "PowerPlatform"
        || !purviewAuditPresets.copilot_studio_admin.operationFilters.includes(record.operation)) {
        return { status: "unresolved" as const, reason: "no_documented_cross_source_relation" as const };
      }
      if (!record.botId && record.agentId) return { status: "unresolved" as const, reason: "no_documented_cross_source_relation" as const };
      if (!record.botId) return { status: "unresolved" as const, reason: "no_documented_exact_identifier" as const };
      if (!record.environmentId) return { status: "unresolved" as const, reason: "missing_environment" as const };
      const resolved = resolveExactInventoryIdentity({ nativeId: record.wrapperId, tenantId: readScope.tenantId, environmentId: record.environmentId, sourceSystem: "power_platform",
        resourceType: "microsoft.copilotstudio/agents", identifiers: [{ kind: "cds_bot_id", value: record.botId }] }, identities);
      if (resolved.status === "resolved") return { status: "resolved" as const, sourceSystem: "power_platform" as const, nativeId: resolved.candidate.nativeId,
        resourceType: resolved.candidate.resourceType, environmentId: resolved.candidate.environmentId!, matchedKind: "cds_bot_id" as const };
      if (resolved.status === "ambiguous") return { status: "ambiguous" as const, reason: "multiple_exact_candidates" as const, candidateCount: resolved.candidateCount ?? resolved.candidates.length };
      return { status: "unresolved" as const, reason: resolved.reason === "no_documented_cross_source_relation" ? resolved.reason : "no_documented_exact_identifier" as const };
    });
  }

  private async fence(client: pg.PoolClient, scope: PurviewAuditScope, id: string, execution: PurviewAuditExecution,
    statuses: PurviewAuditJob["status"][] = ["running", "reconciling_create"]) {
    const result = await client.query<JobRow>(`SELECT * FROM purview_audit_jobs
      WHERE id=$1 AND tenant_id=$2 AND result_scope_kind=$3 AND result_scope_id=$4 AND result_scope_configuration_revision IS NOT DISTINCT FROM $5
        AND authorization_principal_id=$6 AND token_mode=$7 AND execution_owner=$8 AND execution_version=$9
        AND status=ANY($10::text[]) AND NOT cancel_requested FOR UPDATE`,
    [id, scope.tenantId, scope.resultScope.kind, scope.resultScope.scopeId, scope.resultScope.configurationRevision, scope.authorizationPrincipalId, scope.tokenMode,
      execution.owner, execution.version, statuses]);
    if (!result.rows[0]) throw executionLost();
    return result.rows[0];
  }
}

async function validateQualificationForJob(client: pg.PoolClient, scope: PurviewAuditScope, id: string, filters: PurviewAuditFilters) {
  const result = await client.query<Pick<QualificationRow, "authorization_principal_id" | "result_scope_id" | "result_scope_kind" | "result_scope_configuration_revision" | "token_mode" | "request_hash">>(`SELECT authorization_principal_id,result_scope_id,result_scope_kind,result_scope_configuration_revision,token_mode,request_hash
    FROM purview_audit_qualifications WHERE id=$1 AND tenant_id=$2 AND status='approved' AND expires_at>clock_timestamp() AND job_id IS NULL FOR UPDATE`, [id, scope.tenantId]);
  const value = result.rows[0];
  if (!value || value.authorization_principal_id !== scope.authorizationPrincipalId || value.result_scope_id !== scope.resultScope.scopeId || value.result_scope_kind !== scope.resultScope.kind
    || Number(value.result_scope_configuration_revision) !== Number(scope.resultScope.configurationRevision) || value.token_mode !== scope.tokenMode
    || value.request_hash !== requestHash(scope, filters)) throw new AppError(409, "qualification_mismatch", "Audit Search qualification does not match the exact approved scope and filters.");
}

function requestHash(scope: PurviewAuditScope, filters: PurviewAuditFilters) {
  return createHash("sha256").update(JSON.stringify({
    cloud: "global",
    tenantId: scope.tenantId,
    authorizationPrincipalId: scope.authorizationPrincipalId,
    resultScope: {
      kind: scope.resultScope.kind,
      scopeId: scope.resultScope.scopeId,
      configurationRevision: scope.resultScope.configurationRevision,
    },
    tokenMode: scope.tokenMode,
    filters,
  })).digest("hex");
}

function executionLost() {
  return new AppError(409, "audit_execution_lost", "Audit Search execution was stopped or replaced; stale results were not committed.");
}

function projectJob(row: JobRow): PurviewAuditJob {
  return {
    id: row.id, authorizationPrincipalId: row.authorization_principal_id, resultScope: projectResultScope(row), tokenMode: row.token_mode,
    status: row.status, filters: row.filters, displayName: row.display_name, providerQueryId: row.provider_query_id, providerStatus: row.provider_status,
    localRequestId: row.local_request_id, providerRequestId: row.provider_request_id, projectionVersion: row.projection_version,
    providerRequestCount: row.provider_request_count, activationCount: row.activation_count, pageCount: row.page_count, providerRowCount: row.provider_row_count, storedRowCount: row.stored_row_count,
    byteCount: row.byte_count, unknownFieldCount: row.unknown_field_count, pageComplete: row.page_complete,
    observedRange: row.observed_start && row.observed_end ? { startDateTime: row.observed_start.toISOString(), endDateTime: row.observed_end.toISOString() } : null,
    unobservedRange: row.unobserved_start && row.unobserved_end ? { startDateTime: row.unobserved_start.toISOString(), endDateTime: row.unobserved_end.toISOString() } : null,
    ...(row.error_code ? { errorCode: row.error_code } : {}), ...(row.message ? { message: row.message } : {}), qualificationId: row.qualification_id,
    cancelRequested: row.cancel_requested, createdAt: row.created_at.toISOString(), attemptedAt: row.attempted_at?.toISOString() ?? null,
    updatedAt: row.updated_at.toISOString(), finishedAt: row.finished_at?.toISOString() ?? null, expiresAt: row.expires_at.toISOString(),
    canResume: row.status === "waiting_authorization" && !row.cancel_requested && row.deadline_at > new Date()
      && row.activation_count < 12 && row.provider_request_count < 64,
    remoteWorkMayContinue: row.remote_work_may_continue,
  };
}

function projectQualification(row: QualificationRow): PurviewAuditQualification {
  return { id: row.id, capabilityId: row.capability_id, tokenMode: row.token_mode, authorizationPrincipalId: row.authorization_principal_id,
    resultScope: projectResultScope(row), filters: row.filters, status: row.status, contractRevision: row.contract_revision,
    permissionRevision: row.permission_revision, configurationRevision: Number(row.configuration_revision), approvedBy: row.approved_by,
    approvedAt: row.approved_at.toISOString(), expiresAt: row.expires_at.toISOString(), jobId: row.job_id, ...(row.error_code ? { errorCode: row.error_code } : {}) };
}

function projectRecord(row: RecordRow): PurviewAuditRecord {
  return { projectionVersion: row.projection_version, wrapperId: row.wrapper_id, nativeEventId: row.native_event_id, eventDateTime: row.event_time.toISOString(), auditLogRecordType: row.audit_log_record_type,
    operation: row.operation, service: row.service, resultStatus: row.result_status, actorUserId: row.actor_user_id, actorUserPrincipalName: row.actor_user_principal_name,
    actorUserType: row.actor_user_type, objectId: row.object_id, clientIp: row.client_ip, administrativeUnits: row.administrative_units,
    correlationId: row.correlation_id, agentId: row.agent_id, appIdentity: row.app_identity, appHost: row.app_host, botId: row.bot_id,
    environmentId: row.environment_id, botComponentId: row.bot_component_id, aiPluginOperationId: row.ai_plugin_operation_id, messages: row.messages,
    contentAvailable: false, unknownFieldCount: row.unknown_field_count, ...(row.association ? { association: row.association } : {}) };
}

function validateQualification(input: QualificationInput, tokenMode: PurviewAuditTokenMode) {
  if ((tokenMode === "delegated") !== (input.capabilityId === "purview.audit.search.delegated") || !/^[a-f0-9]{64}$/.test(input.contractRevision)
    || !/^[a-f0-9]{64}$/.test(input.permissionRevision) || !Number.isSafeInteger(input.configurationRevision) || input.configurationRevision < 1
    || !input.approvedBy || input.approvedBy.length > 256) throw new AppError(400, "invalid_qualification", "Audit Search qualification approval is invalid.");
}

function validateScope(scope: PurviewAuditScope) {
  validateReadScope(toReadScope(scope));
  if (!scope.authorizationPrincipalId || !(["delegated", "application"] as const).includes(scope.tokenMode)) throw new AppError(403, "scope_mismatch", "Audit Search requires an exact current authorization scope.");
  if (scope.tokenMode === "delegated" && (scope.resultScope.kind !== "principal" || scope.authorizationPrincipalId !== scope.resultScope.scopeId)) throw new AppError(403, "scope_mismatch", "Delegated Audit Search results must remain scoped to the authorizing principal.");
  if (scope.tokenMode === "application" && scope.resultScope.kind !== "application") throw new AppError(403, "scope_mismatch", "Application Audit Search results require the approved shared application scope.");
}

function validateReadScope(scope: PurviewAuditReadScope) {
  if (!scope.tenantId || !scope.resultScopes.length || scope.resultScopes.length > 2 || scope.resultScopes.some(resultScope => !resultScope.scopeId
    || resultScope.kind === "principal" && resultScope.configurationRevision !== null
    || resultScope.kind === "application" && (!Number.isSafeInteger(resultScope.configurationRevision) || resultScope.configurationRevision < 1))) {
    throw new AppError(403, "scope_mismatch", "Audit Search requires an exact current result scope.");
  }
  if (scope.inventoryIdentityScope) {
    const identity = scope.inventoryIdentityScope;
    const allowed = new Set(resourceTypesForInventoryScope(identity.roleScope));
    if (!identity.principalId || !scope.resultScopes.some(resultScope => resultScope.kind === "principal" && resultScope.scopeId === identity.principalId)
      || !identity.resourceTypes.length || identity.resourceTypes.some(resourceType => !allowed.has(resourceType))) {
      throw new AppError(403, "scope_mismatch", "Audit Search inventory association requires an exact current Reader identity scope.");
    }
  }
}

function toReadScope(scope: PurviewAuditReadScope | PurviewAuditScope): PurviewAuditReadScope {
  return "resultScope" in scope ? { tenantId: scope.tenantId, resultScopes: [scope.resultScope] } : scope;
}

function scopedWhere(scope: PurviewAuditReadScope, alias = "") {
  validateReadScope(scope);
  const prefix = alias ? `${alias}.` : "";
  const values: unknown[] = [scope.tenantId];
  const clauses = scope.resultScopes.map(resultScope => {
    const offset = values.length + 1;
    values.push(resultScope.kind, resultScope.scopeId, resultScope.configurationRevision);
    return `(${prefix}result_scope_kind=$${offset} AND ${prefix}result_scope_id=$${offset + 1} AND ${prefix}result_scope_configuration_revision IS NOT DISTINCT FROM $${offset + 2})`;
  });
  return { sql: `${prefix}tenant_id=$1 AND (${clauses.join(" OR ")})`, values };
}

function partialPublication(complete: boolean, reason: PurviewAuditPartialReason | null) {
  if (complete && reason === null) return null;
  const messages: Record<PurviewAuditPartialReason, string> = {
    provider_error: "Microsoft Graph failed while reading a later result page; preserved records are partial and part of the requested range is unobserved.",
    provider_throttled: "Microsoft Graph throttled a later result page; preserved records are partial and part of the requested range is unobserved.",
    provider_result_limit: "A Microsoft Graph result page exceeded the response byte limit; preserved records are partial and part of the requested range is unobserved.",
    audit_provider_request_limit: "The durable provider request limit was reached; preserved records are partial and part of the requested range is unobserved.",
    audit_job_expired: "The Audit Search deadline was reached; preserved records are partial and part of the requested range is unobserved.",
    audit_activation_timeout: "The Audit Search activation deadline was reached; preserved records are partial and part of the requested range is unobserved.",
    audit_page_limit: "The local result page limit was reached; preserved records are partial and part of the requested range is unobserved.",
    audit_row_limit: "The local result row limit was reached; preserved records are partial and part of the requested range is unobserved.",
    audit_byte_limit: "The local result byte limit was reached; preserved records are partial and part of the requested range is unobserved.",
  };
  if (!complete && reason && messages[reason]) return { code: reason, message: messages[reason] };
  throw new AppError(409, "invalid_audit_publication", "Audit Search completion and partial reason are inconsistent.");
}

function projectResultScope(row: Pick<JobRow | QualificationRow, "result_scope_kind" | "result_scope_id" | "result_scope_configuration_revision">): PurviewAuditResultScope {
  return row.result_scope_kind === "application"
    ? { kind: "application", scopeId: row.result_scope_id, configurationRevision: Number(row.result_scope_configuration_revision) }
    : { kind: "principal", scopeId: row.result_scope_id, configurationRevision: null };
}

function safeCode(value: string) {
  return /^[a-z0-9_]{1,128}$/.test(value) ? value : "provider_error";
}