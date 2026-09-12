import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";
import { AppError } from "../errors.js";
import { resolveExactInventoryIdentity, type InventoryIdentityRecord } from "../services/inventoryIdentity.js";
import { resourceTypesForInventoryScope } from "../services/inventoryRoleScope.js";
import { requireProviderAdmissions } from "../services/operationalState.js";
import { defenderHuntingTemplates, type DefenderHuntingFilters, type DefenderHuntingHistory, type DefenderHuntingJob,
  type DefenderHuntingAuthorityBinding, type DefenderHuntingQualificationBinding, type DefenderHuntingQualificationEvidence,
  type DefenderHuntingQueryResult, type DefenderHuntingResultScope, type DefenderHuntingRetainedScope,
  type DefenderHuntingRetainedScopeBinding,
  type DefenderAgentInventoryRow, type DefenderHuntingRow, type DefenderHuntingRowPage, type DefenderHuntingSnapshot, type DefenderHuntingTokenMode } from "../types/defenderHunting.js";
import type { InventoryRoleScope, PowerPlatformResourceType } from "../types/powerPlatformInventory.js";
import { pool, transaction } from "./pool.js";

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
  qualifications?: Array<{ resultScope: DefenderHuntingResultScope; authority: DefenderHuntingAuthorityBinding }>;
  inventoryIdentityScope?: { principalId: string; roleScope: Exclude<InventoryRoleScope, "unknown">; resourceTypes: PowerPlatformResourceType[] };
};

export type DefenderHuntingExecution = { owner: string; version: number };

type JobRow = {
  id: string; authorization_principal_id: string; result_scope_id: string; result_scope_kind: DefenderHuntingResultScope["kind"];
  result_scope_configuration_revision: string | null; token_mode: DefenderHuntingTokenMode; status: DefenderHuntingJob["status"];
  filters: DefenderHuntingFilters; query_version: 1 | 2 | 3; retained_scope_id: string | null; local_request_id: string; provider_request_id: string | null;
  provider_request_count: number; activation_count: number; execution_version: string; execution_owner: string | null;
  provider_row_count: number; stored_row_count: number; byte_count: number; result_complete: boolean; no_data: boolean;
  partial_reason: DefenderHuntingJob["partialReason"]; observed_start: Date | null; observed_end: Date | null;
  unobserved_start: Date | null; unobserved_end: Date | null; is_qualification: boolean;
  capability_id: DefenderHuntingQualificationBinding["capabilityId"] | null; contract_revision: string | null;
  permission_revision: string | null; qualification_configuration_revision: string | null; approved_by: string | null;
  target_scope_hash: string | null;
  error_code: string | null; message: string | null; cancel_requested: boolean; created_at: Date; attempted_at: Date | null;
  updated_at: Date; finished_at: Date | null; deadline_at: Date; expires_at: Date; snapshot_id: string | null;
  prior_successful_job_id?: string | null;
};

type SnapshotRow = {
  id: string; job_id: string; result_scope_id: string; result_scope_kind: DefenderHuntingResultScope["kind"];
  result_scope_configuration_revision: string | null; filters: DefenderHuntingFilters; source_table: "AgentsInfo" | "CloudAppEvents";
  query_version: 1 | 2 | 3; requested_start: Date; requested_end: Date; observed_start: Date | null; observed_end: Date | null;
  unobserved_start: Date | null; unobserved_end: Date | null; observation_time: Date; result_complete: boolean; no_data: boolean;
  partial_reason: DefenderHuntingSnapshot["partialReason"]; provider_row_count: number; stored_row_count: number; byte_count: number; expires_at: Date;
};

type IdentityRow = { native_id: string; resource_type: string; environment_id: string; identifiers: Array<{ kind: string; value: string }> };

type QualificationEvidenceRow = {
  capability_id: DefenderHuntingAuthorityBinding["capabilityId"]; template_id: DefenderHuntingQualificationEvidence["templateId"];
  target_scope_hash: string; approved_scope: DefenderHuntingQualificationEvidence["approvedScope"];
  contract_revision: string; permission_revision: string; configuration_revision: string; approved_by: string;
  query_version: 3; qualified_at: Date; expires_at: Date;
};

type RetainedScopeRow = {
  id: string; result_scope_id: string; result_scope_kind: DefenderHuntingResultScope["kind"];
  result_scope_configuration_revision: string | null; token_mode: DefenderHuntingTokenMode;
  capability_id: DefenderHuntingAuthorityBinding["capabilityId"]; template_id: DefenderHuntingRetainedScope["templateId"];
  target_scope_hash: string; approved_scope: DefenderHuntingRetainedScope["approvedScope"]; query_version: 3;
  contract_revision: string; permission_revision: string; configuration_revision: string; approved_by: string;
  source_qualification_job_id: string; approved_at: Date; qualified_at: Date; expires_at: Date; revoked_at: Date | null;
};

export class DefenderHuntingRepository {
  constructor(private readonly database: pg.Pool = pool) {}

  async submit(scope: DefenderHuntingScope, input: { idempotencyKey: string; filters: DefenderHuntingFilters;
    qualification?: DefenderHuntingQualificationBinding; retainedScope?: DefenderHuntingRetainedScopeBinding }) {
    requireProviderAdmissions();
    validateScope(scope);
    if (typeof input.idempotencyKey !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(input.idempotencyKey)) {
      throw new AppError(400, "invalid_idempotency_key", "Idempotency-Key must contain 1-128 letters, digits, underscores or hyphens.");
    }
    validateSubmissionBinding(scope, input.filters, input.qualification, input.retainedScope);
    const hash = requestHash(scope, input.filters, input.qualification, input.retainedScope);
    const targetScopeHash = huntingTargetScopeHash(input.filters);
    const id = await transaction(this.database, async client => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`defender-hunting:${scope.tenantId}`]);
      if (input.retainedScope) await requireRetainedScope(client, scope, input.filters, input.retainedScope);
      const existing = await client.query<{ id: string; request_hash: string }>(`SELECT id,request_hash FROM defender_hunting_jobs
        WHERE tenant_id=$1 AND result_scope_kind=$2 AND result_scope_id=$3 AND result_scope_configuration_revision IS NOT DISTINCT FROM $4
          AND token_mode=$5 AND idempotency_key=$6`, [scope.tenantId, scope.resultScope.kind, scope.resultScope.scopeId,
        scope.resultScope.configurationRevision, scope.tokenMode, input.idempotencyKey]);
      if (existing.rows[0]) {
        if (existing.rows[0].request_hash !== hash) throw new AppError(409, "idempotency_mismatch", "This idempotency key belongs to different hunting filters or authority.");
        return existing.rows[0].id;
      }
      const unfinished = await client.query<{ principal_count: number; tenant_count: number }>(`SELECT
        count(*) FILTER (WHERE authorization_principal_id=$2)::int AS principal_count,count(*)::int AS tenant_count
        FROM defender_hunting_jobs WHERE tenant_id=$1 AND status IN ('waiting_authorization','running') AND expires_at>clock_timestamp()`,
      [scope.tenantId, scope.authorizationPrincipalId]);
      if (unfinished.rows[0].principal_count >= 5 || unfinished.rows[0].tenant_count >= 10) throw new AppError(429, "job_limit", "The bounded hunting unfinished-job limit was reached.");
      const jobId = randomUUID();
      const qualification = input.qualification;
      await client.query(`INSERT INTO defender_hunting_jobs
        (id,tenant_id,authorization_principal_id,result_scope_id,result_scope_kind,result_scope_configuration_revision,token_mode,template_id,idempotency_key,request_hash,filters,local_request_id,
          is_qualification,capability_id,contract_revision,permission_revision,qualification_configuration_revision,approved_by,target_scope_hash,query_version,retained_scope_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14,$15,$16,$17,$18,$19,3,$20)`,
      [jobId, scope.tenantId, scope.authorizationPrincipalId, scope.resultScope.scopeId, scope.resultScope.kind, scope.resultScope.configurationRevision,
        scope.tokenMode, input.filters.templateId, input.idempotencyKey, hash, JSON.stringify(input.filters), randomUUID(), Boolean(qualification),
        qualification?.capabilityId ?? null, qualification?.contractRevision ?? null, qualification?.permissionRevision ?? null,
        qualification?.configurationRevision ?? null, qualification?.approvedBy ?? null, targetScopeHash, input.retainedScope?.id ?? null]);
      return jobId;
    });
    return (await this.getJob(scope, id))!;
  }

  async requireQualifiedScope(scope: DefenderHuntingScope, filters: DefenderHuntingFilters, authority: DefenderHuntingAuthorityBinding,
    retainedScopeId?: string | null): Promise<DefenderHuntingRetainedScopeBinding> {
    validateScope(scope);
    validateAuthority(scope, authority);
    const result = await this.database.query<{ id: string }>(`SELECT retained.id FROM defender_hunting_qualification_evidence evidence
      JOIN defender_hunting_jobs qualification_job ON qualification_job.id=evidence.qualified_job_id AND qualification_job.query_version=3
      JOIN defender_hunting_retained_scopes retained ON retained.source_qualification_job_id=evidence.qualified_job_id
      WHERE evidence.tenant_id=$1 AND evidence.authorization_principal_id=$2 AND evidence.result_scope_kind=$3
        AND evidence.result_scope_id=$4 AND evidence.result_scope_configuration_revision IS NOT DISTINCT FROM $5
        AND evidence.token_mode=$6 AND evidence.capability_id=$7 AND evidence.template_id=$8 AND evidence.target_scope_hash=$9
        AND evidence.contract_revision=$10 AND evidence.permission_revision=$11 AND evidence.configuration_revision=$12
        AND evidence.expires_at>clock_timestamp()
        AND retained.tenant_id=evidence.tenant_id AND retained.authorization_principal_id=evidence.authorization_principal_id
        AND retained.result_scope_kind=evidence.result_scope_kind AND retained.result_scope_id=evidence.result_scope_id
        AND retained.result_scope_configuration_revision IS NOT DISTINCT FROM evidence.result_scope_configuration_revision
        AND retained.token_mode=evidence.token_mode AND retained.capability_id=evidence.capability_id
        AND retained.template_id=evidence.template_id AND retained.target_scope_hash=evidence.target_scope_hash
        AND retained.contract_revision=evidence.contract_revision AND retained.permission_revision=evidence.permission_revision
        AND retained.configuration_revision=evidence.configuration_revision AND retained.query_version=qualification_job.query_version
        AND retained.approved_scope=$13::jsonb AND retained.revoked_at IS NULL AND retained.expires_at>clock_timestamp()
        AND ($14::uuid IS NULL OR retained.id=$14::uuid) LIMIT 1`, [scope.tenantId, scope.authorizationPrincipalId, scope.resultScope.kind,
      scope.resultScope.scopeId, scope.resultScope.configurationRevision, scope.tokenMode, authority.capabilityId, filters.templateId,
      huntingTargetScopeHash(filters), authority.contractRevision, authority.permissionRevision, authority.configurationRevision,
      JSON.stringify(huntingTargetScope(filters)), retainedScopeId ?? null]);
    if (!result.rowCount) throw new AppError(403, "hunting_scope_unqualified", "This exact hunting template, identity target, and approved data scope requires current qualification.");
    return { id: result.rows[0].id, authority };
  }

  async listQualificationEvidence(scope: DefenderHuntingReadScope): Promise<DefenderHuntingQualificationEvidence[]> {
    const read = qualificationWhere(scope);
    const result = await this.database.query<QualificationEvidenceRow>(`SELECT evidence.*,qualification_job.query_version
      FROM defender_hunting_qualification_evidence evidence
      JOIN defender_hunting_jobs qualification_job ON qualification_job.id=evidence.qualified_job_id
      JOIN defender_hunting_retained_scopes retained ON retained.id=qualification_job.retained_scope_id
      WHERE ${read.sql} AND qualification_job.query_version=3 AND retained.source_qualification_job_id=evidence.qualified_job_id
        AND retained.revoked_at IS NULL AND retained.expires_at>clock_timestamp() AND evidence.expires_at>clock_timestamp()
      ORDER BY evidence.qualified_at DESC,evidence.id DESC`, read.values);
    return result.rows.map(row => ({ capabilityId: row.capability_id, templateId: row.template_id, targetScopeHash: row.target_scope_hash,
      approvedScope: row.approved_scope, contractRevision: row.contract_revision, permissionRevision: row.permission_revision,
      configurationRevision: Number(row.configuration_revision), queryVersion: row.query_version, approvedBy: row.approved_by,
      qualifiedAt: row.qualified_at.toISOString(), expiresAt: row.expires_at.toISOString() }));
  }

  async listRetainedScopes(scope: DefenderHuntingReadScope): Promise<DefenderHuntingRetainedScope[]> {
    const read = retainedScopeWhere(scope, "retained");
    const result = await this.database.query<RetainedScopeRow>(`SELECT retained.* FROM defender_hunting_retained_scopes retained
      WHERE ${read.sql} AND retained.revoked_at IS NULL AND retained.expires_at>clock_timestamp()
      ORDER BY retained.approved_at DESC,retained.id DESC`, read.values);
    return result.rows.map(projectRetainedScope);
  }

  async revokeRetainedScope(scope: DefenderHuntingReadScope, id: string, tokenMode: DefenderHuntingTokenMode, revokedBy: string) {
    if (!revokedBy || revokedBy.length > 256) throw new AppError(403, "scope_mismatch", "Hunting scope revocation requires an exact current actor.");
    const read = retainedScopeWhere(scope, "retained");
    const result = await this.database.query<RetainedScopeRow>(`UPDATE defender_hunting_retained_scopes retained
      SET revoked_at=clock_timestamp(),revoked_by=$${read.values.length + 3}
      WHERE retained.id=$${read.values.length + 1} AND retained.token_mode=$${read.values.length + 2}
        AND ${read.sql} AND retained.revoked_at IS NULL AND retained.expires_at>clock_timestamp()
      RETURNING retained.*`, [...read.values, id, tokenMode, revokedBy]);
    if (!result.rows[0]) throw new AppError(404, "not_found", "Current retained hunting scope was not found.");
    return projectRetainedScope(result.rows[0]);
  }

  async getJob(scope: DefenderHuntingReadScope | DefenderHuntingScope, id: string) {
    const read = scopedWhere(toReadScope(scope), "job", !("resultScope" in scope));
    const result = await this.database.query<JobRow>(`SELECT job.*,(SELECT id FROM defender_hunting_snapshots WHERE job_id=job.id) AS snapshot_id,
      ${priorSuccessfulJobSelect("job")} AS prior_successful_job_id
      FROM defender_hunting_jobs job WHERE job.id=$${read.values.length + 1} AND ${read.sql} AND job.expires_at>clock_timestamp()`, [...read.values, id]);
    return result.rows[0] ? projectJob(result.rows[0]) : undefined;
  }

  async listJobs(scope: DefenderHuntingReadScope, limit = 20, offset = 0): Promise<DefenderHuntingHistory> {
    const read = scopedWhere(scope, "job", true);
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

  async authorizeProviderRequest(scope: DefenderHuntingScope, id: string, execution: DefenderHuntingExecution) {
    await transaction(this.database, async client => {
      const job = await this.fence(client, scope, id, execution);
      if (job.deadline_at <= new Date()) throw new AppError(409, "hunting_job_expired", "Hunting reached its durable execution deadline.");
      if (job.provider_request_count >= 12) throw new AppError(409, "hunting_provider_request_limit", "Hunting reached its durable provider request limit.");
      await client.query(`UPDATE defender_hunting_jobs SET provider_request_count=provider_request_count+1,
        attempted_at=COALESCE(attempted_at,clock_timestamp()),updated_at=clock_timestamp()
        WHERE id=$1 AND execution_owner=$2 AND execution_version=$3`, [id, execution.owner, execution.version]);
    });
  }

  async recordProviderResponse(scope: DefenderHuntingScope, id: string, execution: DefenderHuntingExecution, providerRequestId: string | null) {
    if (providerRequestId !== null && (providerRequestId.length < 1 || providerRequestId.length > 256 || /[\r\n\0]/.test(providerRequestId))) throw new AppError(502, "provider_schema", "Microsoft Graph returned an invalid request identifier.");
    const result = await this.database.query(`UPDATE defender_hunting_jobs SET provider_request_id=COALESCE($10,provider_request_id),updated_at=clock_timestamp()
      WHERE id=$1 AND tenant_id=$2 AND result_scope_kind=$3 AND result_scope_id=$4 AND result_scope_configuration_revision IS NOT DISTINCT FROM $5
        AND authorization_principal_id=$6 AND token_mode=$7 AND execution_owner=$8 AND execution_version=$9
        AND status='running' AND NOT cancel_requested RETURNING id`,
    [id, scope.tenantId, scope.resultScope.kind, scope.resultScope.scopeId, scope.resultScope.configurationRevision,
      scope.authorizationPrincipalId, scope.tokenMode, execution.owner, execution.version, providerRequestId]);
    if (result.rowCount !== 1) throw executionLost();
  }

  async publish(scope: DefenderHuntingScope, id: string, execution: DefenderHuntingExecution, result: DefenderHuntingQueryResult) {
    validatePublicationEnvelope(result);
    await transaction(this.database, async client => {
      const job = await this.fence(client, scope, id, execution);
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
      await client.query(`UPDATE defender_hunting_jobs SET status=$6,provider_row_count=$7,stored_row_count=$8,byte_count=$9,
        result_complete=$10,no_data=$11,partial_reason=$12,observed_start=$13,observed_end=$14,unobserved_start=$15,unobserved_end=$16,
        error_code=$17,message=$18,finished_at=clock_timestamp(),updated_at=clock_timestamp(),execution_owner=NULL
        WHERE id=$1 AND tenant_id=$2 AND result_scope_kind=$3 AND result_scope_id=$4 AND result_scope_configuration_revision IS NOT DISTINCT FROM $5
          AND execution_owner=$19 AND execution_version=$20`,
      [id, scope.tenantId, scope.resultScope.kind, scope.resultScope.scopeId, scope.resultScope.configurationRevision,
        result.complete ? "succeeded" : "partial", result.providerRowCount, result.storedRowCount, result.byteCount, result.complete,
        result.complete && result.rows.length === 0, result.partialReason, observedStart, observedEnd,
        result.complete ? null : filters.startDateTime, result.complete ? null : filters.endDateTime,
        result.partialReason, result.partialReason ? "The fixed hunting row cap was reached; the requested interval remains incompletely observed." : null,
        execution.owner, execution.version]);
      if (job.is_qualification && result.complete) {
        if (job.token_mode === "application") {
          const configuration = await client.query<{ revision: string }>(`SELECT revision FROM capability_configuration
            WHERE tenant_id=$1 AND capability_id=$2 FOR SHARE`, [scope.tenantId, job.capability_id]);
          if (!configuration.rows[0] || Number(configuration.rows[0].revision) !== Number(job.qualification_configuration_revision)) {
            throw new AppError(409, "qualification_superseded", "Hunting configuration changed before qualification evidence publication.");
          }
        }
        const evidence = await client.query<{ qualified_at: Date }>(`INSERT INTO defender_hunting_qualification_evidence
          (id,tenant_id,authorization_principal_id,result_scope_id,result_scope_kind,result_scope_configuration_revision,token_mode,
            capability_id,template_id,target_scope_hash,approved_scope,contract_revision,permission_revision,configuration_revision,
            approved_by,qualified_job_id,provider_request_id)
          VALUES(gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13,$14,$15,$16)
          RETURNING qualified_at`,
        [scope.tenantId, scope.authorizationPrincipalId, scope.resultScope.scopeId, scope.resultScope.kind,
          scope.resultScope.configurationRevision, scope.tokenMode, job.capability_id, filters.templateId, job.target_scope_hash,
          JSON.stringify(huntingTargetScope(filters)), job.contract_revision, job.permission_revision,
          job.qualification_configuration_revision, job.approved_by, id, job.provider_request_id]);
        const retained = await client.query<{ id: string }>(`INSERT INTO defender_hunting_retained_scopes
          (id,tenant_id,authorization_principal_id,result_scope_id,result_scope_kind,result_scope_configuration_revision,token_mode,
            capability_id,template_id,target_scope_hash,approved_scope,query_version,contract_revision,permission_revision,configuration_revision,
            approved_by,source_qualification_job_id,approved_at,qualified_at,expires_at)
          VALUES(gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13,$14,$15,$16,$17::timestamptz,$18,$17::timestamptz+interval '30 days')
          ON CONFLICT (tenant_id,authorization_principal_id,result_scope_kind,result_scope_id,result_scope_configuration_key,token_mode,
            capability_id,template_id,target_scope_hash,query_version,contract_revision,permission_revision,configuration_revision)
            WHERE revoked_at IS NULL
          DO UPDATE SET approved_scope=EXCLUDED.approved_scope,approved_by=EXCLUDED.approved_by,
            source_qualification_job_id=EXCLUDED.source_qualification_job_id,approved_at=EXCLUDED.approved_at,
            qualified_at=EXCLUDED.qualified_at,expires_at=EXCLUDED.expires_at
          RETURNING id`, [scope.tenantId, scope.authorizationPrincipalId, scope.resultScope.scopeId, scope.resultScope.kind,
          scope.resultScope.configurationRevision, scope.tokenMode, job.capability_id, filters.templateId, job.target_scope_hash,
          JSON.stringify(huntingTargetScope(filters)), job.query_version, job.contract_revision, job.permission_revision,
          job.qualification_configuration_revision, job.approved_by, id, job.created_at, evidence.rows[0].qualified_at]);
        await client.query("UPDATE defender_hunting_jobs SET retained_scope_id=$2 WHERE id=$1", [id, retained.rows[0].id]);
      }
    });
    return (await this.getJob(scope, id))!;
  }

  async markWaitingAuthorization(scope: DefenderHuntingScope, id: string, execution: DefenderHuntingExecution) {
    const result = await this.database.query(`UPDATE defender_hunting_jobs SET
      status=CASE WHEN deadline_at<=clock_timestamp() OR activation_count>=4 OR provider_request_count>=12 THEN 'inconclusive' ELSE 'waiting_authorization' END,
      error_code=CASE WHEN deadline_at<=clock_timestamp() THEN 'hunting_job_expired' WHEN activation_count>=4 THEN 'hunting_activation_limit'
        WHEN provider_request_count>=12 THEN 'hunting_provider_request_limit' ELSE 'interaction_required' END,
      message=CASE WHEN deadline_at<=clock_timestamp() OR activation_count>=4 OR provider_request_count>=12
        THEN 'Hunting reached a durable execution bound before publication.' ELSE 'Explicit resume with current hunting authorization is required.' END,
      finished_at=CASE WHEN deadline_at<=clock_timestamp() OR activation_count>=4 OR provider_request_count>=12 THEN clock_timestamp() ELSE NULL END,
      execution_owner=NULL,updated_at=clock_timestamp()
      WHERE id=$1 AND tenant_id=$2 AND result_scope_kind=$3 AND result_scope_id=$4 AND result_scope_configuration_revision IS NOT DISTINCT FROM $5
        AND execution_owner=$6 AND execution_version=$7 AND status='running' AND NOT cancel_requested RETURNING id`,
    [id, scope.tenantId, scope.resultScope.kind, scope.resultScope.scopeId, scope.resultScope.configurationRevision, execution.owner, execution.version]);
    if (result.rowCount !== 1) throw executionLost();
    return this.getJob(scope, id);
  }

  async fail(scope: DefenderHuntingScope, id: string, execution: DefenderHuntingExecution, code: string, message: string, inconclusive = false) {
    await this.fence(this.database as unknown as pg.PoolClient, scope, id, execution);
    const result = await this.database.query(`UPDATE defender_hunting_jobs SET status=$8,error_code=$9,message=$10,finished_at=clock_timestamp(),updated_at=clock_timestamp(),execution_owner=NULL
      WHERE id=$1 AND tenant_id=$2 AND result_scope_kind=$3 AND result_scope_id=$4 AND result_scope_configuration_revision IS NOT DISTINCT FROM $5
        AND execution_owner=$6 AND execution_version=$7 AND status='running' RETURNING id`,
    [id, scope.tenantId, scope.resultScope.kind, scope.resultScope.scopeId, scope.resultScope.configurationRevision, execution.owner, execution.version,
      inconclusive ? "inconclusive" : "failed", safeCode(code), message.slice(0, 1024)]);
    if (result.rowCount !== 1) throw executionLost();
    return this.getJob(scope, id);
  }

  async cancel(scope: DefenderHuntingReadScope | DefenderHuntingScope, id: string) {
    const read = scopedWhere(toReadScope(scope), "job", !("resultScope" in scope));
    const result = await this.database.query(`UPDATE defender_hunting_jobs AS job SET status='cancelled',cancel_requested=true,
      message='Local hunting execution stopped.',finished_at=clock_timestamp(),updated_at=clock_timestamp(),execution_owner=NULL
      WHERE job.id=$${read.values.length + 1} AND ${read.sql} AND job.status IN ('waiting_authorization','running') RETURNING job.id`, [...read.values, id]);
    if (result.rowCount !== 1) throw new AppError(409, "hunting_job_state", "Only unfinished hunting can be cancelled.");
    return this.getJob(scope, id);
  }

  async delete(scope: DefenderHuntingReadScope | DefenderHuntingScope, id: string) {
    const read = scopedWhere(toReadScope(scope), "job", !("resultScope" in scope));
    const result = await this.database.query(`DELETE FROM defender_hunting_jobs AS job WHERE job.id=$${read.values.length + 1} AND ${read.sql} AND job.status<>'running' RETURNING job.id`, [...read.values, id]);
    if (result.rowCount !== 1) throw new AppError(409, "hunting_job_state", "Stop active hunting before deleting its local cache.");
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
    const associations = await this.resolveAssociations(readScope, rows.rows.map(value => value.row_data));
    return { value: rows.rows.map((value, index) => ({ ...value.row_data, association: associations[index] })), count: job.storedRowCount,
      limit: boundedLimit, offset: boundedOffset, job, snapshot: projectSnapshot(snapshotResult.rows[0]) };
  }

  async relatedInventoryRows(scope: DefenderHuntingReadScope, entraAgentId: string, limit = 20) {
    const read = scopedWhere(scope, "job", true);
    const boundedLimit = Math.min(Math.max(limit, 1), 50);
    const targetOffset = read.values.length;
    const values = [...read.values, entraAgentId, boundedLimit];
    const base = `FROM defender_hunting_rows row JOIN defender_hunting_snapshots snapshot
        ON snapshot.id=row.snapshot_id AND snapshot.tenant_id=row.tenant_id
      JOIN defender_hunting_jobs job ON job.id=snapshot.job_id AND job.tenant_id=snapshot.tenant_id
      WHERE ${read.sql} AND job.expires_at>clock_timestamp() AND job.status IN ('succeeded','partial') AND job.query_version=3
        AND snapshot.expires_at>clock_timestamp() AND snapshot.source_table='AgentsInfo' AND snapshot.query_version=3
        AND row.row_data->>'projectionVersion'='3' AND row.row_data->>'sourceTable'='AgentsInfo'
        AND row.row_data->>'entraAgentObjectId'=$${targetOffset + 1}`;
    const [rows, count] = await Promise.all([
      this.database.query<{ snapshot_id: string; job_id: string; row_data: DefenderAgentInventoryRow }>(
        `SELECT row.snapshot_id,snapshot.job_id,row.row_data ${base}
          ORDER BY row.row_data->>'observationTime' DESC,row.row_ordinal LIMIT $${targetOffset + 2}`, values),
      this.database.query<{ count: number }>(`SELECT count(*)::int AS count ${base}`, values.slice(0, -1)),
    ]);
    return { count: count.rows[0].count, value: rows.rows.map(row => ({
      jobId: row.job_id, snapshotId: row.snapshot_id, nativeRecordId: row.row_data.agentId,
      observedAt: row.row_data.observationTime, platform: row.row_data.platform,
      lifecycleStatus: row.row_data.lifecycleStatus, publishedStatus: row.row_data.publishedStatus,
      matchedKind: "entra_agent_id" as const,
    })) };
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

  private async resolveAssociations(scope: DefenderHuntingReadScope, rows: DefenderHuntingRow[]) {
    const identityScope = scope.inventoryIdentityScope;
    if (!identityScope) return rows.map(() => ({ status: "unresolved" as const, reason: "no_documented_cross_source_relation" as const }));
    const allowed = new Set(resourceTypesForInventoryScope(identityScope.roleScope));
    if (!identityScope.resourceTypes.length || identityScope.resourceTypes.some(value => !allowed.has(value))) throw new AppError(403, "scope_mismatch", "Hunting inventory association requires an exact current Viewer identity scope.");
    const candidates = await this.database.query<IdentityRow>(`SELECT DISTINCT resource.native_id COLLATE "C" AS native_id,resource.resource_type COLLATE "C" AS resource_type,
        resource.environment_id COLLATE "C" AS environment_id,resource.identifiers
      FROM power_platform_inventory_resources resource JOIN power_platform_inventory_snapshots snapshot ON snapshot.id=resource.snapshot_id
      WHERE snapshot.tenant_id=$1 AND snapshot.principal_id=$2 AND snapshot.role_scope=$3 AND snapshot.is_current AND snapshot.expires_at>clock_timestamp()
        AND resource.resource_type=ANY($4::text[]) ORDER BY resource_type,environment_id,native_id,resource.identifiers`,
    [scope.tenantId, identityScope.principalId, identityScope.roleScope, identityScope.resourceTypes]);
    const identities: InventoryIdentityRecord[] = candidates.rows.map(value => ({ nativeId: value.native_id, tenantId: scope.tenantId, environmentId: value.environment_id,
      sourceSystem: "power_platform", resourceType: value.resource_type, identifiers: value.identifiers as InventoryIdentityRecord["identifiers"] }));
    return rows.map(row => {
      const identifiers: InventoryIdentityRecord["identifiers"] = row.sourceTable === "AgentsInfo"
        ? [...(row.entraAgentObjectId ? [{ kind: "entra_agent_id" as const, value: row.entraAgentObjectId }] : []),
          ...(row.entraBlueprintId ? [{ kind: "entra_blueprint_id" as const, value: row.entraBlueprintId }] : [])]
        : [...(row.targetAgentBlueprintId ? [{ kind: "entra_blueprint_id" as const, value: row.targetAgentBlueprintId }] : []),
          ...(row.agentBlueprintId ? [{ kind: "entra_blueprint_id" as const, value: row.agentBlueprintId }] : [])];
      const resolution = resolveExactInventoryIdentity({ nativeId: row.sourceTable === "AgentsInfo" ? row.agentId : row.reportId ?? row.spanId ?? "unidentified",
        tenantId: scope.tenantId, environmentId: null, sourceSystem: "defender_hunting", resourceType: `microsoft.defender/${row.sourceTable}`, identifiers },
      identities, { documentedCrossSourceKinds: ["entra_agent_id"], blueprintParentAcrossSources: true });
      if (resolution.status === "resolved") return { status: "resolved" as const, sourceSystem: resolution.candidate.sourceSystem as "power_platform" | "graph_packages",
        nativeId: resolution.candidate.nativeId, resourceType: resolution.candidate.resourceType, environmentId: resolution.candidate.environmentId, matchedKind: "entra_agent_id" as const };
      if (resolution.status === "ambiguous") return { status: "ambiguous" as const, reason: resolution.reason, candidateCount: resolution.candidateCount ?? resolution.candidates.length };
      return { status: "unresolved" as const, reason: resolution.reason };
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

function validateSubmissionBinding(scope: DefenderHuntingScope, filters: DefenderHuntingFilters,
  qualification?: DefenderHuntingQualificationBinding, retainedScope?: DefenderHuntingRetainedScopeBinding) {
  if (!qualification && !retainedScope) {
    if (scope.tokenMode !== "delegated") {
      throw new AppError(400, "invalid_qualification", "Application hunting requires an exact retained-scope qualification.");
    }
    return;
  }
  if (qualification && retainedScope) {
    throw new AppError(400, "invalid_qualification", "Hunting requires exactly one qualification approval or retained-scope binding.");
  }
  if (retainedScope) {
    if (!/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(retainedScope.id)) {
      throw new AppError(400, "invalid_qualification", "Hunting retained-scope binding is invalid.");
    }
    validateAuthority(scope, retainedScope.authority);
    return;
  }
  if (!qualification) throw new AppError(400, "invalid_qualification", "Hunting qualification approval is invalid.");
  const targetCount = filters.agentIds.length + filters.blueprintIds.length + filters.actorObjectIds.length;
  if (targetCount === 0 || (scope.tokenMode === "delegated") !== (qualification.capabilityId === "defender.hunting.delegated")
    || !/^[a-f0-9]{64}$/.test(qualification.contractRevision) || !/^[a-f0-9]{64}$/.test(qualification.permissionRevision)
    || !Number.isSafeInteger(qualification.configurationRevision) || qualification.configurationRevision < 1
    || !qualification.approvedBy || qualification.approvedBy.length > 256) throw new AppError(400, "invalid_qualification", "Hunting qualification approval is invalid.");
}

function validateAuthority(scope: DefenderHuntingScope, authority: DefenderHuntingAuthorityBinding) {
  if ((scope.tokenMode === "delegated") !== (authority.capabilityId === "defender.hunting.delegated")
    || !/^[a-f0-9]{64}$/.test(authority.contractRevision) || !/^[a-f0-9]{64}$/.test(authority.permissionRevision)
    || !Number.isSafeInteger(authority.configurationRevision) || authority.configurationRevision < 1
    || scope.tokenMode === "application" && authority.configurationRevision !== scope.resultScope.configurationRevision) {
    throw new AppError(403, "hunting_scope_unqualified", "Hunting qualification authority is invalid or no longer current.");
  }
}

function validateScope(scope: DefenderHuntingScope) {
  validateReadScope(toReadScope(scope));
  if (!scope.authorizationPrincipalId) throw new AppError(403, "scope_mismatch", "Hunting requires an exact current authorization scope.");
  if (scope.tokenMode === "delegated" && (scope.resultScope.kind !== "principal" || scope.resultScope.scopeId !== scope.authorizationPrincipalId)) throw new AppError(403, "scope_mismatch", "Delegated hunting results must remain scoped to the authorizing principal.");
  if (scope.tokenMode === "application" && scope.resultScope.kind !== "application") throw new AppError(403, "scope_mismatch", "Application hunting results require the approved shared application scope.");
}

function validateReadScope(scope: DefenderHuntingReadScope) {
  if (!scope.tenantId || !scope.authorizationPrincipalId || !scope.resultScopes.length || scope.resultScopes.length > 2 || scope.resultScopes.some(resultScope => !resultScope.scopeId
    || resultScope.kind === "principal" && resultScope.configurationRevision !== null
    || resultScope.kind === "application" && (!Number.isSafeInteger(resultScope.configurationRevision) || resultScope.configurationRevision < 1))) {
    throw new AppError(403, "scope_mismatch", "Hunting requires an exact current result scope.");
  }
  for (const qualification of scope.qualifications ?? []) validateAuthority({ tenantId: scope.tenantId,
    authorizationPrincipalId: scope.authorizationPrincipalId, resultScope: qualification.resultScope,
    tokenMode: qualification.resultScope.kind === "principal" ? "delegated" : "application" }, qualification.authority);
}

function toReadScope(scope: DefenderHuntingReadScope | DefenderHuntingScope): DefenderHuntingReadScope {
  return "resultScope" in scope ? { tenantId: scope.tenantId, authorizationPrincipalId: scope.authorizationPrincipalId, resultScopes: [scope.resultScope] } : scope;
}

function scopedWhere(scope: DefenderHuntingReadScope, alias = "job", requireQualification = false) {
  validateReadScope(scope);
  const values: unknown[] = [scope.tenantId];
  const clauses = scope.resultScopes.map(resultScope => {
    const offset = values.length + 1;
    values.push(resultScope.kind, resultScope.scopeId, resultScope.configurationRevision);
    return `(${alias}.result_scope_kind=$${offset} AND ${alias}.result_scope_id=$${offset + 1} AND ${alias}.result_scope_configuration_revision IS NOT DISTINCT FROM $${offset + 2})`;
  });
  const qualification = requireQualification ? retainedVisibilityPredicate(scope, alias, values) : "";
  return { sql: `${alias}.tenant_id=$1 AND (${clauses.join(" OR ")})${requireQualification ? qualification ? ` AND (${qualification})` : " AND false" : ""}`, values };
}

function qualificationWhere(scope: DefenderHuntingReadScope) {
  validateReadScope(scope);
  const values: unknown[] = [scope.tenantId];
  const predicate = qualificationEvidencePredicate(scope, "evidence", values);
  return { sql: `evidence.tenant_id=$1${predicate ? ` AND (${predicate})` : " AND false"}`, values };
}

function retainedScopeWhere(scope: DefenderHuntingReadScope, alias: string) {
  validateReadScope(scope);
  const values: unknown[] = [scope.tenantId];
  const predicate = retainedAuthorityPredicate(scope, alias, values);
  return { sql: `${alias}.tenant_id=$1${predicate ? ` AND (${predicate})` : " AND false"}`, values };
}

function qualificationEvidencePredicate(scope: DefenderHuntingReadScope, alias: string, values: unknown[]) {
  return (scope.qualifications ?? []).map(({ resultScope, authority }) => {
    const offset = values.length + 1;
    values.push(resultScope.kind, resultScope.scopeId, resultScope.configurationRevision, authority.capabilityId,
      authority.contractRevision, authority.permissionRevision, authority.configurationRevision);
    return `(${alias}.result_scope_kind=$${offset} AND ${alias}.result_scope_id=$${offset + 1}
      AND ${alias}.result_scope_configuration_revision IS NOT DISTINCT FROM $${offset + 2}
      AND ${alias}.capability_id=$${offset + 3} AND ${alias}.contract_revision=$${offset + 4}
      AND ${alias}.permission_revision=$${offset + 5} AND ${alias}.configuration_revision=$${offset + 6})`;
  }).join(" OR ");
}

function retainedAuthorityPredicate(scope: DefenderHuntingReadScope, alias: string, values: unknown[]) {
  return (scope.qualifications ?? []).map(({ resultScope, authority }) => {
    const offset = values.length + 1;
    values.push(resultScope.kind, resultScope.scopeId, resultScope.configurationRevision, authority.capabilityId,
      authority.contractRevision, authority.permissionRevision, authority.configurationRevision);
    return `(${alias}.result_scope_kind=$${offset} AND ${alias}.result_scope_id=$${offset + 1}
      AND ${alias}.result_scope_configuration_revision IS NOT DISTINCT FROM $${offset + 2}
      AND ${alias}.capability_id=$${offset + 3} AND ${alias}.contract_revision=$${offset + 4}
      AND ${alias}.permission_revision=$${offset + 5} AND ${alias}.configuration_revision=$${offset + 6})`;
  }).join(" OR ");
}

function retainedVisibilityPredicate(scope: DefenderHuntingReadScope, alias: string, values: unknown[]) {
  const principalOffset = values.length + 1;
  values.push(scope.authorizationPrincipalId);
  const ordinaryDelegated = `(${alias}.token_mode='delegated' AND ${alias}.result_scope_kind='principal'
    AND ${alias}.result_scope_id=$${principalOffset} AND ${alias}.authorization_principal_id=$${principalOffset}
    AND NOT ${alias}.is_qualification AND ${alias}.retained_scope_id IS NULL)`;
  const qualified = (scope.qualifications ?? []).map(({ resultScope, authority }) => {
    const offset = values.length + 1;
    values.push(resultScope.kind, resultScope.scopeId, resultScope.configurationRevision, authority.capabilityId,
      authority.contractRevision, authority.permissionRevision, authority.configurationRevision, scope.authorizationPrincipalId);
    const scopeMatch = `${alias}.result_scope_kind=$${offset} AND ${alias}.result_scope_id=$${offset + 1}
      AND ${alias}.result_scope_configuration_revision IS NOT DISTINCT FROM $${offset + 2}`;
    return `(${scopeMatch} AND ((${alias}.is_qualification AND ${alias}.status NOT IN ('succeeded','partial')
      AND ${alias}.authorization_principal_id=$${offset + 7} AND ${alias}.query_version=3
      AND ${alias}.capability_id=$${offset + 3} AND ${alias}.contract_revision=$${offset + 4}
      AND ${alias}.permission_revision=$${offset + 5} AND ${alias}.qualification_configuration_revision=$${offset + 6})
      OR EXISTS (SELECT 1 FROM defender_hunting_retained_scopes retained WHERE retained.id=${alias}.retained_scope_id
        AND retained.tenant_id=${alias}.tenant_id AND retained.authorization_principal_id=${alias}.authorization_principal_id
        AND retained.result_scope_kind=${alias}.result_scope_kind AND retained.result_scope_id=${alias}.result_scope_id
        AND retained.result_scope_configuration_revision IS NOT DISTINCT FROM ${alias}.result_scope_configuration_revision
        AND retained.token_mode=${alias}.token_mode AND retained.template_id=${alias}.template_id
        AND retained.target_scope_hash=${alias}.target_scope_hash AND retained.query_version=${alias}.query_version
        AND retained.capability_id=$${offset + 3} AND retained.contract_revision=$${offset + 4}
        AND retained.permission_revision=$${offset + 5} AND retained.configuration_revision=$${offset + 6}
        AND retained.revoked_at IS NULL AND retained.expires_at>clock_timestamp())))`;
  });
  return [ordinaryDelegated, ...qualified].join(" OR ");
}

async function requireRetainedScope(client: Pick<pg.Pool | pg.PoolClient, "query">, scope: DefenderHuntingScope,
  filters: DefenderHuntingFilters, binding: DefenderHuntingRetainedScopeBinding) {
  const authority = binding.authority;
  const result = await client.query(`SELECT 1 FROM defender_hunting_retained_scopes retained
    JOIN defender_hunting_qualification_evidence evidence ON evidence.qualified_job_id=retained.source_qualification_job_id
    JOIN defender_hunting_jobs qualification_job ON qualification_job.id=evidence.qualified_job_id
    WHERE retained.id=$1 AND retained.tenant_id=$2 AND retained.authorization_principal_id=$3
      AND retained.result_scope_kind=$4 AND retained.result_scope_id=$5
      AND retained.result_scope_configuration_revision IS NOT DISTINCT FROM $6 AND retained.token_mode=$7
      AND retained.capability_id=$8 AND retained.template_id=$9 AND retained.target_scope_hash=$10
      AND retained.approved_scope=$11::jsonb AND retained.query_version=3 AND qualification_job.query_version=retained.query_version
      AND retained.contract_revision=$12 AND retained.permission_revision=$13 AND retained.configuration_revision=$14
      AND retained.revoked_at IS NULL AND retained.expires_at>clock_timestamp() AND evidence.expires_at>clock_timestamp()`,
  [binding.id, scope.tenantId, scope.authorizationPrincipalId, scope.resultScope.kind, scope.resultScope.scopeId,
    scope.resultScope.configurationRevision, scope.tokenMode, authority.capabilityId, filters.templateId, huntingTargetScopeHash(filters),
    JSON.stringify(huntingTargetScope(filters)), authority.contractRevision, authority.permissionRevision, authority.configurationRevision]);
  if (!result.rowCount) throw new AppError(403, "hunting_scope_unqualified", "This exact hunting template, identity target, and approved data scope requires current qualification.");
}

function requestHash(scope: DefenderHuntingScope, filters: DefenderHuntingFilters, qualification?: DefenderHuntingQualificationBinding,
  retainedScope?: DefenderHuntingRetainedScopeBinding) {
  return createHash("sha256").update(JSON.stringify({ cloud: "global", tenantId: scope.tenantId, authorizationPrincipalId: scope.authorizationPrincipalId,
    resultScope: scope.resultScope, tokenMode: scope.tokenMode, filters, qualification: qualification ?? null, retainedScope: retainedScope ?? null })).digest("hex");
}

function priorSuccessfulJobSelect(alias: string) {
  return `CASE WHEN NOT ${alias}.is_qualification AND ${alias}.status IN ('failed','cancelled','inconclusive') THEN
    (SELECT previous.id FROM defender_hunting_jobs previous JOIN defender_hunting_snapshots snapshot ON snapshot.job_id=previous.id
      WHERE previous.tenant_id=${alias}.tenant_id AND previous.authorization_principal_id=${alias}.authorization_principal_id
        AND previous.result_scope_kind=${alias}.result_scope_kind AND previous.result_scope_id=${alias}.result_scope_id
        AND previous.result_scope_configuration_revision IS NOT DISTINCT FROM ${alias}.result_scope_configuration_revision
        AND previous.token_mode=${alias}.token_mode AND previous.template_id=${alias}.template_id
        AND previous.target_scope_hash=${alias}.target_scope_hash AND NOT previous.is_qualification AND previous.status='succeeded'
        AND previous.finished_at<=${alias}.created_at AND previous.expires_at>clock_timestamp() AND snapshot.expires_at>clock_timestamp()
      ORDER BY previous.finished_at DESC,previous.id DESC LIMIT 1) END`;
}

export function huntingTargetScope(filters: DefenderHuntingFilters) {
  return { templateId: filters.templateId, agentIds: [...filters.agentIds].sort(ordinal), blueprintIds: [...filters.blueprintIds].sort(ordinal),
    actorObjectIds: [...filters.actorObjectIds].sort(ordinal), operations: [...filters.operations].sort(ordinal) };
}

export function huntingTargetScopeHash(filters: DefenderHuntingFilters) {
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
  const expectedSource = defenderHuntingTemplates[filters.templateId].sourceTable;
  const start = Date.parse(filters.startDateTime); const end = Date.parse(filters.endDateTime);
  for (const row of rows) {
    const keys = row.sourceTable === "AgentsInfo" ? inventoryPublicationKeys : activityPublicationKeys;
    if (!isPlainObject(row) || row.projectionVersion !== 3 || row.sourceTable !== expectedSource
      || Object.keys(row).some(key => !keys.has(key)) || Object.keys(row).length !== keys.size
      || !hasOnlyTypedPrimitives(row, row.sourceTable === "AgentsInfo" ? "detailStates" : "fieldStates")) throw invalidPublication();
    const timestamp = Date.parse(row.sourceTable === "AgentsInfo" ? row.observationTime : row.timestamp);
    if (!Number.isFinite(timestamp) || timestamp < start || timestamp > end) throw invalidPublication();
    if (row.sourceTable === "AgentsInfo") {
      if (!row.agentId || row.agentId.length > 512 || !isExactStateRecord(row.detailStates, inventoryDetailStateKeys, inventoryDetailStates)
        || filters.agentIds.length && !filters.agentIds.includes(row.agentId)
        || filters.blueprintIds.length && (!row.entraBlueprintId || !filters.blueprintIds.includes(row.entraBlueprintId))) throw invalidPublication();
      continue;
    }
    const expectedOperations = row.actionType === "InvokeAgent" ? ["invoke_agent"] : row.actionType === "InferenceCall" ? ["chat", "output_messages"] : ["execute_tool"];
    const agents = [row.targetAgentId, row.agentId, row.alternatePlatformAgentId];
    const blueprints = [row.targetAgentBlueprintId, row.agentBlueprintId];
    const rootSpanObserved = row.actionType === "InvokeAgent" && row.operation === "invoke_agent" && row.spanId !== null && row.parentSpanId === null;
    if (!filters.operations.includes(row.actionType) || !row.operation || !expectedOperations.includes(row.operation)
      || row.organizationId && row.organizationId !== tenantId.toLowerCase()
      || filters.agentIds.length && !agents.some(value => value && filters.agentIds.includes(value))
      || filters.blueprintIds.length && !blueprints.some(value => value && filters.blueprintIds.includes(value))
      || filters.actorObjectIds.length && ![row.actorAccountObjectId, row.humanActorUserObjectId].some(value => value && filters.actorObjectIds.includes(value))
      || row.rootSpanObserved !== rootSpanObserved || row.spanRole !== (rootSpanObserved ? "root_invoke_agent" : row.parentSpanId ? "child" : "unresolved")
      || row.contentAvailable !== false || !isExactStateRecord(row.fieldStates, activityFieldStateKeys, activityFieldStates)) throw invalidPublication();
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
  const qualification = row.is_qualification ? { capabilityId: row.capability_id!, contractRevision: row.contract_revision!, permissionRevision: row.permission_revision!,
    configurationRevision: Number(row.qualification_configuration_revision), approvedBy: row.approved_by! } : null;
  return { id: row.id, authorizationPrincipalId: row.authorization_principal_id, resultScope: projectResultScope(row), tokenMode: row.token_mode,
    status: row.status, filters: row.filters, queryVersion: row.query_version, retainedScopeId: row.retained_scope_id, localRequestId: row.local_request_id,
    providerRequestId: row.provider_request_id, providerRequestCount: row.provider_request_count, activationCount: row.activation_count,
    providerRowCount: row.provider_row_count, storedRowCount: row.stored_row_count, byteCount: row.byte_count, complete: row.result_complete,
    noData: row.no_data, partialReason: row.partial_reason, observedRange: range(row.observed_start, row.observed_end),
    unobservedRange: range(row.unobserved_start, row.unobserved_end), snapshotId: row.snapshot_id,
    priorSuccessfulJobId: row.prior_successful_job_id ?? null, qualification,
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

function projectRetainedScope(row: RetainedScopeRow): DefenderHuntingRetainedScope {
  return { id: row.id, resultScope: projectResultScope(row), tokenMode: row.token_mode, capabilityId: row.capability_id,
    templateId: row.template_id, targetScopeHash: row.target_scope_hash, approvedScope: row.approved_scope, queryVersion: row.query_version,
    contractRevision: row.contract_revision, permissionRevision: row.permission_revision, configurationRevision: Number(row.configuration_revision),
    approvedBy: row.approved_by, sourceQualificationJobId: row.source_qualification_job_id, approvedAt: row.approved_at.toISOString(),
    qualifiedAt: row.qualified_at.toISOString(), expiresAt: row.expires_at.toISOString(), revokedAt: row.revoked_at?.toISOString() ?? null };
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