import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";
import { pool, transaction } from "./pool.js";
import { AppError } from "../errors.js";
import { AuditLog, type DataScope } from "../services/auditLog.js";
import { requireProviderAdmissions } from "../services/operationalState.js";
import type { AuditAction, AuditActor, AuditScope } from "../types/audit.js";
import type { CopilotPackageDetail, PackageAccessUpdate } from "../types/copilotPackage.js";
import type { CapabilityId } from "../types/capability.js";
import { canonicalAccessEntities, capturePackageMutationState, expectedPackageMutationState, packageMutationStateHash, type PackageMutationState } from "../services/packageMutationState.js";
import { lockPackageInventoryScope, publishPackageReadback, readPackageInventoryGeneration } from "./packageControls.js";
import { exactCount, encodeBatch, digest, dataLimitError } from "./dataBounds.js";
import { dataConnections } from "./dataConnections.js";
import { CursorCodec, SelectionError, type SelectionIdentity } from "../services/dataSelections.js";
import { config } from "../config.js";
import { assertCurrentJobTarget, assertCurrentMutationTargets } from "./inventoryMutationAuthority.js";
import { lockInventorySelection, lockInventorySources } from "./inventoryAuthority.js";
import { InventoryRuntime } from "../services/inventoryRuntime.js";
import { lifecycleLimits } from "./lifecycleSlice.js";

export type JobStatus = "queued" | "running" | "waiting_authorization" | "succeeded" | "failed" | "cancelled" | "partial";
export type ItemOutcome = "succeeded" | "failed" | "cancelled" | "inconclusive" | "skipped";
export type FrozenMutationTarget = { id: string; displayName: string; prestate: PackageMutationState };
export type JobIntentInput = { action: AuditAction; targets: FrozenMutationTarget[]; accessUpdate?: PackageAccessUpdate; reassignUserId?: string; actor: AuditActor; requestPath: string; scope: AuditScope };
export type MutationConfirmationSummary = {
  risk: true;
  operation: AuditAction;
  provider: "Microsoft Graph";
  endpoint: string;
  apiMaturity: "preview";
  permission: "Delegated CopilotPackages.ReadWrite.All";
  actor: { id: string; displayName: string; username: string };
  scope: AuditScope;
  targetCount: number;
  affectedPrincipalCount: number;
  rollback: string;
  targetSelectionHash: string;
  targets: Array<{ id: string; displayName: string; currentState: PackageMutationState; requestedState: PackageMutationState }>;
  additionalTargetCount: number;
};
export type JobInput = JobIntentInput & { idempotencyKey: string; confirmationHash: string };
export type MutationRetryIntent = Pick<JobIntentInput, "action" | "accessUpdate" | "requestPath" | "scope"> & { targetIds?: string[] };
export type JobRow = {
  id: string; tenant_id: string; principal_id: string; token_mode: "delegated" | "application"; capability: CapabilityId; action: AuditAction;
  access_update: PackageAccessUpdate | null; reassign_user_id: string | null; request_hash: string; confirmation_hash: string | null; confirmation_summary: MutationConfirmationSummary | null; confirmed_at: Date | null; status: JobStatus; scope: AuditScope;
  actor_username: string; actor_name: string; request_path: string; cancel_requested: boolean;
  lease_owner: string | null; lease_version: number; lease_until: Date | null; attempts: number;
  created_at: Date; updated_at: Date;
  result_revision: string;
};
export type ReconciliationStatus = "not_required" | "required" | "verified_applied" | "verified_not_applied" | "conflict";
export type JobItem = { id: string; job_id: string; target_id: string; display_name: string; ordinal: number; status: "queued" | "running" | ItemOutcome; sent_at: Date | null; message: string | null; error_code: string | null; prestate_hash: string; prestate: PackageMutationState; poststate_hash: string | null; poststate: PackageMutationState | null; correlation_id: string | null; reconciliation_status: ReconciliationStatus; reconciled_at: Date | null };
export type Lease = { jobId: string; owner: string; version: number; scope: DataScope };
export type FinishItemEvidence = {
  message?: string; errorCode?: string; poststate?: PackageMutationState; readbackCount?: number;
} & ({ readback: CopilotPackageDetail; inventoryGeneration: string | null } | { readback?: never; inventoryGeneration?: never });

const jobCountNames = ["total", "completed", "succeeded", "failed", "skipped", "inconclusive", "cancelled",
  "queued", "reconciliationRequired", "retryEligible"] as const;
type JobMetadataRow = Omit<JobRow, "confirmation_summary"> & {
  confirmation_summary: Omit<MutationConfirmationSummary, "targets"> | null;
  within_budget: boolean; counts: Record<typeof jobCountNames[number], string>; current_agent_name: string | null;
};
const jobMetadataSql = `SELECT job.id,job.token_mode,job.capability,job.action,job.access_update,job.reassign_user_id,
  job.status,job.confirmation_hash,job.confirmation_summary-'targets' AS confirmation_summary,job.confirmed_at,
  job.cancel_requested,job.created_at,job.updated_at,job.result_revision,
  job.attempts<10 AND job.deadline_at>clock_timestamp() AS within_budget,
  (SELECT display_name FROM job_items WHERE job_id=job.id AND status='running' ORDER BY ordinal LIMIT 1) AS current_agent_name,
  counts.value AS counts FROM jobs job
  CROSS JOIN LATERAL (SELECT jsonb_build_object(
    'total',count(*)::text,
    'completed',count(*) FILTER(WHERE status NOT IN ('queued','running'))::text,
    'succeeded',count(*) FILTER(WHERE status='succeeded')::text,
    'failed',count(*) FILTER(WHERE status='failed')::text,
    'skipped',count(*) FILTER(WHERE status='skipped')::text,
    'inconclusive',count(*) FILTER(WHERE status='inconclusive')::text,
    'cancelled',count(*) FILTER(WHERE status='cancelled')::text,
    'queued',count(*) FILTER(WHERE status='queued')::text,
    'reconciliationRequired',count(*) FILTER(WHERE status='inconclusive' AND reconciliation_status='required')::text,
    'retryEligible',count(*) FILTER(WHERE status='inconclusive' AND reconciliation_status='verified_not_applied')::text
  ) AS value FROM job_items WHERE job_id=job.id) counts`;

function jobMetadata(job: JobMetadataRow) {
  const counts = Object.fromEntries(jobCountNames.map(name => [name, exactCount(job.counts[name])])) as Record<typeof jobCountNames[number], number>;
  const action = job.access_update ? { action: job.action, accessUpdate: job.access_update }
    : job.action === "reassign" ? { action: job.action, reassignUserId: job.reassign_user_id }
      : { action: job.action, targetBlockedState: job.action === "block" };
  return { id: job.id, capabilityId: job.capability, tokenMode: job.token_mode, status: job.status,
    confirmationHash: job.confirmation_hash, confirmation: job.confirmation_summary, confirmedAt: job.confirmed_at?.toISOString() ?? null,
    ...action, ...counts, resultRevision: job.result_revision, currentAgentName: job.current_agent_name ?? undefined,
    createdAt: job.created_at.toISOString(), updatedAt: job.updated_at.toISOString(),
    canResume: job.token_mode === "delegated" && job.within_budget && !job.cancel_requested
      && counts.queued > 0 && ["waiting_authorization", "partial"].includes(job.status) };
}

function jobItemResult(item: JobItem) {
  return { id: item.target_id, displayName: item.display_name, status: item.status,
    message: item.message ?? undefined, errorCode: item.error_code ?? undefined, correlationId: item.correlation_id ?? undefined,
    prestateHash: item.prestate_hash, poststateHash: item.poststate_hash ?? undefined,
    reconciliationStatus: item.reconciliation_status,
    retryEligible: item.status === "inconclusive" && item.reconciliation_status === "verified_not_applied" };
}

export function createJobConfirmation(input: JobIntentInput) {
  const prepared = prepareIntent(input);
  const targetSelectionHash = hash(prepared.targets.map(target => ({ id: target.id, prestateHash: target.prestateHash })));
  const visibleTargets = prepared.targets.slice(0, 20).map(target => ({
    id: target.id,
    displayName: target.displayName,
    currentState: target.prestate,
    requestedState: expectedPackageMutationState(target.prestate, prepared.action, prepared.accessUpdate),
  }));
  const summary: MutationConfirmationSummary = {
    risk: true,
    operation: prepared.action,
    provider: "Microsoft Graph",
    endpoint: mutationEndpoint(prepared.action),
    apiMaturity: "preview",
    permission: "Delegated CopilotPackages.ReadWrite.All",
    actor: { id: prepared.actor.homeAccountId, displayName: prepared.actor.displayName, username: prepared.actor.username },
    scope: prepared.scope,
    targetCount: prepared.targets.length,
    affectedPrincipalCount: prepared.accessUpdate?.principals.length ?? (prepared.reassignUserId ? 1 : prepared.targets.length),
    rollback: rollbackDescription(prepared.action),
    targetSelectionHash,
    targets: visibleTargets,
    additionalTargetCount: prepared.targets.length - visibleTargets.length,
  };
  const requestHash = hash(canonicalIntent(prepared));
  return { confirmationHash: hash({ requestHash, summary }), requestHash, summary, prepared };
}

export class JobRepository {
  constructor(private database: pg.Pool = pool) {}

  async submit(scope: DataScope, input: JobInput) {
    requireProviderAdmissions();
    if (!scope.tenantId || !scope.principalId || input.actor.tenantId !== scope.tenantId || input.actor.homeAccountId !== scope.principalId) throw new AppError(403, "scope_mismatch", "Job scope mismatch.");
    if (typeof input.idempotencyKey !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(input.idempotencyKey)) throw new AppError(400, "invalid_idempotency_key", "Idempotency-Key must contain 1-128 letters, digits, underscores or hyphens.");
    const confirmation = createJobConfirmation(input);
    if (!/^[a-f0-9]{64}$/.test(input.confirmationHash) || input.confirmationHash !== confirmation.confirmationHash) throw new AppError(409, "confirmation_mismatch", "The confirmed package selection or current state changed. Review and confirm the mutation again.");
    const { prepared, requestHash, summary } = confirmation;
    const jobId = await transaction(this.database, async client => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`${scope.tenantId}:${scope.principalId}`]);
      const capabilityId = jobCapability(prepared.action);
      const existing = await client.query<JobRow>("SELECT * FROM jobs WHERE tenant_id=$1 AND principal_id=$2 AND capability=$3 AND idempotency_key=$4", [scope.tenantId, scope.principalId, capabilityId, input.idempotencyKey]);
      if (existing.rows[0]) {
        if (existing.rows[0].request_hash !== requestHash || existing.rows[0].confirmation_hash !== input.confirmationHash) throw new AppError(409, "idempotency_mismatch", "This idempotency key already belongs to a different request.");
        return existing.rows[0].id;
      }
      const outstanding = await client.query("SELECT count(*)::int AS count FROM jobs WHERE tenant_id=$1 AND principal_id=$2 AND status IN ('queued','running','waiting_authorization')", [scope.tenantId, scope.principalId]);
      if (outstanding.rows[0].count >= 5) throw new AppError(429, "job_limit", "At most five unfinished jobs are allowed per principal.");
      const id = randomUUID();
      await client.query(`INSERT INTO jobs (id,tenant_id,principal_id,token_mode,capability,action,request_hash,idempotency_key,access_update,confirmation_hash,confirmation_summary,confirmed_at,reassign_user_id,actor_name,actor_username,request_path,scope)
        VALUES ($1,$2,$3,'delegated',$4,$5,$6,$7,$8,$9,$10,clock_timestamp(),$11,$12,$13,$14,$15)`, [id, scope.tenantId, scope.principalId, capabilityId, prepared.action, requestHash, input.idempotencyKey, prepared.accessUpdate ?? null, input.confirmationHash, summary, prepared.reassignUserId ?? null, prepared.actor.displayName.slice(0,256), prepared.actor.username.slice(0,256), prepared.requestPath.slice(0,1024), prepared.scope]);
      for (let offset = 0; offset < prepared.targets.length;) {
        let size = Math.min(250, prepared.targets.length - offset);
        let targets = prepared.targets.slice(offset, offset + size);
        const rows = () => targets.map((target, ordinal) => ({ ordinal: offset + ordinal, target_id: target.id,
          display_name: target.displayName, prestate_hash: target.prestateHash, prestate: target.prestate }));
        while (Buffer.byteLength(JSON.stringify(rows())) + 128 > 1_048_576 && size > 1) {
          size = Math.max(1, Math.floor(size / 2)); targets = prepared.targets.slice(offset, offset + size);
        }
        const batch = encodeBatch(rows(), [id]);
        await client.query(`INSERT INTO job_items(id,job_id,ordinal,target_id,display_name,prestate_hash,prestate)
          SELECT gen_random_uuid(),$1,row.ordinal,row.target_id,row.display_name,row.prestate_hash,row.prestate
          FROM jsonb_to_recordset($2::jsonb) AS row(ordinal integer,target_id text,display_name text,prestate_hash text,prestate jsonb)`, [id, batch.json]);
        await client.query(`INSERT INTO source_identifiers(id,tenant_id,source,resource_type,native_id,identifier_kind,identifier_value)
          SELECT gen_random_uuid(),$1,'graph_packages','microsoft.graph/copilotpackages',target,'package_id',target FROM unnest($2::text[]) AS target ON CONFLICT DO NOTHING`, [scope.tenantId, targets.map(target => target.id)]);
        await new AuditLog(scope, client).requestEvents(targets.map(target => ({
        operationId: id,
        scope: prepared.scope,
        ...(prepared.action === "block" || prepared.action === "unblock" ? { action: prepared.action, targetBlockedState: prepared.action === "block" } : { action: prepared.action }),
        agentId: target.id,
        agentDisplayName: target.displayName,
        actor: prepared.actor,
        requestPath: prepared.requestPath,
        message: "Package mutation requested and confirmed; provider dispatch has not started.",
        metadata: { confirmationHash: input.confirmationHash, targetSelectionHash: summary.targetSelectionHash, prestateHash: target.prestateHash, verification: "pending_dispatch" },
        })));
        offset += size;
      }
      return id;
    });
    return (await this.get(jobId, scope))!;
  }

  async getByIdempotency(scope: DataScope, capabilityId: CapabilityId, idempotencyKey: string, retryIntent?: MutationRetryIntent) {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(idempotencyKey)) throw new AppError(400, "invalid_idempotency_key", "Idempotency-Key must contain 1-128 letters, digits, underscores or hyphens.");
    const result = await this.database.query<Pick<JobRow, "id" | "action" | "access_update" | "request_path" | "scope"> & { target_ids_match: boolean }>(`SELECT id,action,access_update,request_path,scope,
      ($5::text[] IS NULL OR (SELECT count(*) FROM job_items WHERE job_id=jobs.id)=cardinality($5::text[])
        AND NOT EXISTS(SELECT 1 FROM job_items WHERE job_id=jobs.id AND NOT(target_id=ANY($5::text[])))) AS target_ids_match FROM jobs
      WHERE tenant_id=$1 AND principal_id=$2 AND capability=$3 AND idempotency_key=$4 AND expires_at>clock_timestamp()`,
    [scope.tenantId, scope.principalId, capabilityId, idempotencyKey, retryIntent?.targetIds ?? null]);
    const existing = result.rows[0];
    if (existing && retryIntent && (!existing.target_ids_match || mutationRetryIntentHash({
      action: existing.action,
      accessUpdate: existing.access_update ?? undefined,
      requestPath: existing.request_path,
      scope: existing.scope,
      targetIds: retryIntent.targetIds,
    }) !== mutationRetryIntentHash(retryIntent))) {
      throw new AppError(409, "idempotency_mismatch", "This idempotency key already belongs to a different request.");
    }
    return existing ? this.get(existing.id, scope) : undefined;
  }

  async submitStaged(client: pg.PoolClient, identity: SelectionIdentity, stageId: string,
    input: { confirmationHash: string; idempotencyKey: string; requestPath: string }) {
    requireProviderAdmissions();
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(input.idempotencyKey)) {
      throw new AppError(400, "invalid_idempotency_key", "Use a bounded idempotency key.");
    }
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`data-sync:${identity.tenantId}:${identity.principalId}`]);
    const stage = (await client.query<{ selection_id: string; intent: Omit<JobIntentInput, "targets">; target_count: number;
      request_hash: string; confirmation_hash: string; summary: MutationConfirmationSummary }>(`
      SELECT selection_id,intent,target_count,request_hash,confirmation_hash,summary FROM inventory_mutation_stages
      WHERE id=$1 AND tenant_id=$2 AND principal_id=$3 AND authorization_hash=$4 AND expires_at>clock_timestamp()
        AND confirmation_hash=$5 FOR UPDATE`,
    [stageId, identity.tenantId, identity.principalId, identity.authorizationHash, input.confirmationHash])).rows[0];
    if (!stage || !stage.target_count || stage.target_count > 5000) throw new AppError(409, "confirmation_mismatch", "Review a current mutation preview.");
    await lockInventorySelection(client, identity, stage.selection_id);
    const assertLive = () => assertCurrentMutationTargets(client, identity, stageId, stage.target_count);
    await assertLive();
    const intent = stage.intent, scope = { tenantId: identity.tenantId, principalId: identity.principalId };
    if (intent.actor.tenantId !== scope.tenantId || intent.actor.homeAccountId !== scope.principalId) throw new AppError(403, "scope_mismatch", "Mutation actor changed.");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`${scope.tenantId}:${scope.principalId}`]);
    const capability = jobCapability(intent.action);
    const existing = (await client.query(`SELECT id,confirmation_hash,request_hash FROM jobs
      WHERE tenant_id=$1 AND principal_id=$2 AND capability=$3 AND idempotency_key=$4`,
    [scope.tenantId, scope.principalId, capability, input.idempotencyKey])).rows[0];
    if (existing) {
      if (existing.confirmation_hash !== input.confirmationHash || existing.request_hash !== stage.request_hash) {
        throw new AppError(409, "idempotency_mismatch", "This key already belongs to another confirmed mutation.");
      }
      return existing.id as string;
    }
    if ((await client.query(`SELECT count(*)::int AS count FROM jobs WHERE tenant_id=$1 AND principal_id=$2
      AND status IN ('queued','running','waiting_authorization')`, [scope.tenantId, scope.principalId])).rows[0].count >= 5) {
      throw new AppError(429, "job_limit", "At most five unfinished jobs are allowed per principal.");
    }
    const id = randomUUID();
    await client.query(`INSERT INTO jobs(id,tenant_id,principal_id,token_mode,capability,action,request_hash,idempotency_key,
      access_update,confirmation_hash,confirmation_summary,confirmed_at,reassign_user_id,actor_name,actor_username,request_path,scope)
      VALUES($1,$2,$3,'delegated',$4,$5,$6,$7,$8,$9,$10,clock_timestamp(),$11,$12,$13,$14,$15)`,
    [id, scope.tenantId, scope.principalId, capability, intent.action, stage.request_hash, input.idempotencyKey,
      intent.accessUpdate ?? null, input.confirmationHash, stage.summary, intent.reassignUserId ?? null,
      intent.actor.displayName.slice(0, 256), intent.actor.username.slice(0, 256), input.requestPath.slice(0, 1024), intent.scope]);
    let ordinal = -1, inserted = 0;
    for (;;) {
      const targets = (await client.query<{ ordinal: number; target_id: string; display_name: string; prestate_hash: string }>(`
        WITH candidates AS (SELECT * FROM inventory_mutation_targets WHERE stage_id=$1 AND ordinal>$3 ORDER BY ordinal LIMIT 100),
        bounded AS (SELECT *,sum(octet_length(row_to_json(candidate)::text)) OVER(ORDER BY ordinal) AS bytes FROM candidates candidate)
        INSERT INTO job_items(id,job_id,ordinal,target_id,display_name,prestate_hash,prestate,source_generation_id,source_identity,agent_id,authority_expires_at)
        SELECT gen_random_uuid(),$2,ordinal,target_id,display_name,prestate_hash,prestate,source_generation_id,source_identity,agent_id,authority_expires_at
        FROM bounded WHERE bytes<=524288 ORDER BY ordinal
        RETURNING ordinal,target_id,display_name,prestate_hash`, [stageId, id, ordinal])).rows;
      if (!targets.length) break;
      encodeBatch(targets);
      await client.query(`INSERT INTO source_identifiers(id,tenant_id,source,resource_type,native_id,identifier_kind,identifier_value)
        SELECT gen_random_uuid(),$1,'graph_packages','microsoft.graph/copilotpackages',target,'package_id',target
        FROM unnest($2::text[]) target ON CONFLICT DO NOTHING`, [scope.tenantId, targets.map(target => target.target_id)]);
      await new AuditLog(scope, client).requestEvents(targets.map(target => ({
        operationId: id, scope: intent.scope,
        ...(intent.action === "block" || intent.action === "unblock"
          ? { action: intent.action, targetBlockedState: intent.action === "block" } : { action: intent.action }),
        agentId: target.target_id, agentDisplayName: target.display_name, actor: intent.actor, requestPath: input.requestPath,
        message: "Package mutation requested and confirmed; provider dispatch has not started.",
        metadata: { confirmationHash: input.confirmationHash, targetSelectionHash: stage.summary.targetSelectionHash,
          prestateHash: target.prestate_hash, verification: "pending_dispatch" },
      })));
      inserted += targets.length;
      ordinal = Math.max(...targets.map(target => target.ordinal));
    }
    if (inserted !== stage.target_count) throw new AppError(409, "confirmation_mismatch", "The staged target set changed before submission.");
    await assertLive();
    await client.query("UPDATE inventory_mutation_stages SET job_id=$2 WHERE id=$1", [stageId, id]);
    return id;
  }

  async get(id: string, scope: DataScope) {
    const result = await this.database.query<JobMetadataRow>(`${jobMetadataSql}
      WHERE job.id=$1 AND job.tenant_id=$2 AND job.principal_id=$3 AND job.expires_at>clock_timestamp()`,
    [id, scope.tenantId, scope.principalId]);
    return result.rows[0] ? jobMetadata(result.rows[0]) : undefined;
  }

  async list(scope: DataScope, limit = 20) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new SelectionError("invalid_cursor");
    const result = await this.database.query<JobMetadataRow>(`WITH candidates AS (${jobMetadataSql}
      WHERE job.tenant_id=$1 AND job.principal_id=$2 AND job.expires_at>clock_timestamp()
      ORDER BY job.created_at DESC,job.id DESC LIMIT $3),
      sized AS (SELECT *,sum(octet_length(row_to_json(candidate)::text)) OVER(ORDER BY created_at DESC,id DESC) AS bytes FROM candidates candidate)
      SELECT * FROM sized WHERE bytes<=524288 ORDER BY created_at DESC,id DESC`, [scope.tenantId, scope.principalId, limit]);
    return { value: result.rows.map(jobMetadata) };
  }

  items(id: string, identity: SelectionIdentity, options: { revision?: string; cursor?: string; limit?: number } = {}) {
    const limit = options.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || options.cursor && !options.revision) throw new SelectionError("invalid_cursor");
    return dataConnections(this.database).selectedRead(async client => {
      const job = (await client.query<Pick<JobRow, "id" | "result_revision">>(`SELECT job.id,job.result_revision FROM jobs job
        JOIN data_principal_epochs principal ON principal.tenant_id=job.tenant_id AND principal.principal_id=job.principal_id
        WHERE job.id=$1 AND job.tenant_id=$2 AND job.principal_id=$3 AND principal.epoch=$4
          AND job.expires_at>clock_timestamp() FOR SHARE OF principal`, [id, identity.tenantId, identity.principalId, identity.sessionEpoch])).rows[0];
      if (!job) throw new AppError(404, "not_found", "Job was not found.");
      if (options.revision !== undefined && options.revision !== job.result_revision) throw new SelectionError("selection_invalidated");
      const codec = new CursorCodec(config.sessionSecret);
      const binding = { identity, endpoint: "job-items", selectionId: id, revision: job.result_revision, queryHash: digest("ordinal") };
      const cursor = options.cursor ? codec.decode(options.cursor, binding) : undefined;
      const reverse = cursor?.direction === "previous";
      const ordinal = cursor ? Number(cursor.boundary.id) : -1;
      if (!Number.isSafeInteger(ordinal) || ordinal < -1) throw new SelectionError("invalid_cursor");
      const results = await client.query<JobItem & { bytes: string; candidate_count: string }>(`WITH candidates AS (SELECT target_id,display_name,ordinal,status,message,error_code,correlation_id,
        prestate_hash,poststate_hash,reconciliation_status FROM job_items
        WHERE job_id=$1 AND ordinal ${reverse ? "<" : ">"} $2 ORDER BY ordinal ${reverse ? "DESC" : "ASC"} LIMIT $3),
        sized AS (SELECT *,count(*) OVER() AS candidate_count,row_number() OVER(ORDER BY ordinal ${reverse ? "DESC" : "ASC"}) AS position,
          sum(octet_length(row_to_json(candidate)::text)) OVER(ORDER BY ordinal ${reverse ? "DESC" : "ASC"}) AS bytes FROM candidates candidate)
        SELECT * FROM sized WHERE bytes<=524288 OR position=1 ORDER BY ordinal ${reverse ? "DESC" : "ASC"}`,
      [id, ordinal, limit + 1]);
      if (results.rows.length && exactCount(results.rows[0].bytes) > 524288) throw dataLimitError("job_item_bytes", 524288, exactCount(results.rows[0].bytes));
      const rows = results.rows.slice(0, limit);
      const more = results.rows.length > 0 && exactCount(results.rows[0].candidate_count) > rows.length;
      if (reverse) rows.reverse();
      const next = (row: JobItem | undefined, direction: "next" | "previous") => row
        ? codec.encode({ ...binding, direction, boundary: { id: String(row.ordinal), key: null, nullRank: 1 } }) : null;
      const total = exactCount((await client.query("SELECT count(*)::text AS total FROM job_items WHERE job_id=$1", [id])).rows[0].total);
      return { value: rows.map(jobItemResult), revision: job.result_revision, counts: { total, filtered: total },
        page: { limit,
          nextCursor: (!reverse && more || reverse && Boolean(cursor)) ? next(rows.at(-1), "next") : null,
          previousCursor: (reverse && more || !reverse && Boolean(cursor)) ? next(rows[0], "previous") : null } };
    });
  }

  async claim(id: string, scope: DataScope, owner: string, authorizedResume = false): Promise<Lease | undefined> {
    requireProviderAdmissions();
    const result = await this.database.query<JobRow>(`UPDATE jobs SET status='running',lease_owner=$4,lease_version=lease_version+1,
      lease_until=clock_timestamp()+interval '120 seconds',attempts=attempts+1,updated_at=clock_timestamp()
      WHERE id=$1 AND tenant_id=$2 AND principal_id=$3 AND cancel_requested=false AND attempts<10 AND deadline_at>clock_timestamp()
      AND (lease_until IS NULL OR lease_until<clock_timestamp())
      AND (status='queued' OR ($5 AND status IN ('waiting_authorization','partial')))
      AND EXISTS (SELECT 1 FROM job_items WHERE job_id=jobs.id AND status='queued') RETURNING *`, [id, scope.tenantId, scope.principalId, owner, authorizedResume]);
    return result.rows[0] ? { jobId: id, scope, owner, version: result.rows[0].lease_version } : undefined;
  }

  private async fence(client: pg.PoolClient, lease: Lease) {
    const result = await client.query<JobRow>(`SELECT * FROM jobs WHERE id=$1 AND tenant_id=$2 AND principal_id=$3
      AND lease_owner=$4 AND lease_version=$5 AND lease_until>clock_timestamp() FOR UPDATE`, [lease.jobId, lease.scope.tenantId, lease.scope.principalId, lease.owner, lease.version]);
    if (!result.rows[0]) throw new AppError(409, "lease_lost", "Job lease expired or was replaced; results were not committed.");
    return result.rows[0];
  }

  async beginItem(lease: Lease) {
    requireProviderAdmissions();
    return transaction(this.database, async client => {
      const job = await this.fence(client, lease);
      if (job.cancel_requested) return undefined;
      const budget = await client.query("SELECT deadline_at>clock_timestamp() AS valid FROM jobs WHERE id=$1", [lease.jobId]);
      if (!budget.rows[0].valid) {
        await client.query("UPDATE job_items SET status='failed',message='Job deadline expired before dispatch.' WHERE job_id=$1 AND status='queued'", [lease.jobId]);
        return undefined;
      }
      const result = await client.query<JobItem>("SELECT * FROM job_items WHERE job_id=$1 AND status='queued' ORDER BY ordinal LIMIT 1 FOR UPDATE", [lease.jobId]);
      const item = result.rows[0];
      if (!item) return undefined;
      const correlationId = randomUUID();
      await client.query("UPDATE jobs SET lease_until=clock_timestamp()+interval '120 seconds' WHERE id=$1", [lease.jobId]);
      const running = await client.query<JobItem>("UPDATE job_items SET status='running',correlation_id=$2,updated_at=clock_timestamp() WHERE id=$1 RETURNING *", [item.id, correlationId]);
      await client.query("INSERT INTO job_attempts(id,job_id,item_id,lease_owner,lease_version,correlation_id,prestate_hash) VALUES ($1,$2,$3,$4,$5,$6,$7)", [randomUUID(), job.id, item.id, lease.owner, lease.version, correlationId, item.prestate_hash]);
      await new AuditLog(lease.scope, client).startEvent({ id: `${item.id}:${lease.version}`, operationId: job.id, scope: job.scope,
        ...(job.action === "block" || job.action === "unblock" ? { action: job.action, targetBlockedState: job.action === "block" } : { action: job.action }),
        agentId: item.target_id, agentDisplayName: item.display_name,
        actor: { tenantId: job.tenant_id, homeAccountId: job.principal_id, username: job.actor_username, displayName: job.actor_name }, requestPath: job.request_path, metadata: { leaseVersion: lease.version, correlationId, prestateHash: item.prestate_hash } });
      return { item: running.rows[0], job, inventoryGeneration: await readPackageInventoryGeneration(lease.scope, client) };
    });
  }

  async settleInventoryControls(lease: Lease, itemId: string, signal: AbortSignal, authorize: () => Promise<void>) {
    if ((await this.database.query(`SELECT 1 FROM job_items item JOIN jobs job ON job.id=item.job_id
      WHERE item.id=$1 AND job.id=$2 AND job.tenant_id=$3 AND job.principal_id=$4 AND item.source_generation_id IS NOT NULL`,
    [itemId, lease.jobId, lease.scope.tenantId, lease.scope.principalId])).rowCount) {
      await new InventoryRuntime(this.database, authorize).settleControls(lease.scope, signal);
    }
  }

  async markSent(lease: Lease, itemId: string, observedPrestateHash: string) {
    requireProviderAdmissions();
    await transaction(this.database, async client => {
      await lockInventorySources(client, lease.scope);
      const job = await this.fence(client, lease);
      if (job.cancel_requested) throw new AppError(409, "cancelled", "Cancellation stopped unsent work.");
      const budget = await client.query("SELECT deadline_at>clock_timestamp() AS valid FROM jobs WHERE id=$1", [lease.jobId]);
      if (!budget.rows[0].valid) throw new AppError(409, "deadline_expired", "Job deadline expired before dispatch.");
      await assertCurrentJobTarget(client, lease.scope, lease.jobId, itemId);
      const result = await client.query("UPDATE job_items SET sent_at=clock_timestamp() WHERE id=$1 AND job_id=$2 AND status='running' AND sent_at IS NULL AND prestate_hash=$3", [itemId, lease.jobId, observedPrestateHash]);
      if (result.rowCount !== 1) throw new AppError(409, "already_dispatched", "An item must never be dispatched twice.");
      await client.query("UPDATE job_attempts SET sent_at=clock_timestamp(),prestate_hash=$3 WHERE item_id=$1 AND lease_version=$2", [itemId, lease.version, observedPrestateHash]);
      await client.query("UPDATE jobs SET lease_until=clock_timestamp()+interval '120 seconds' WHERE id=$1", [lease.jobId]);
    });
  }

  async finishItem(lease: Lease, itemId: string, outcome: ItemOutcome, evidence: FinishItemEvidence = {}) {
    await transaction(this.database, async client => {
      if (evidence.readback) await lockPackageInventoryScope(lease.scope, client);
      const job = await this.fence(client, lease);
      const poststateHash = evidence.poststate ? packageMutationStateHash(evidence.poststate) : null;
      const result = await client.query<{ target_id: string }>(`UPDATE job_items SET status=$3,message=$4,error_code=$5,poststate=$6,poststate_hash=$7,
        reconciliation_status=CASE WHEN $3='inconclusive' THEN 'required' ELSE 'not_required' END,updated_at=clock_timestamp()
        WHERE id=$1 AND job_id=$2 AND status='running' RETURNING target_id`, [itemId, lease.jobId, outcome, evidence.message?.slice(0,1024) ?? null, evidence.errorCode?.slice(0,128) ?? null, evidence.poststate ?? null, poststateHash]);
      if (!result.rowCount) throw new AppError(409, "terminal_item", "Terminal items cannot be overwritten.");
      let snapshotId: string | undefined;
      if (evidence.readback) {
        if (!["succeeded", "skipped"].includes(outcome) || !evidence.poststate
          || evidence.readback.id !== result.rows[0].target_id
          || packageMutationStateHash(capturePackageMutationState(evidence.readback, job.action)) !== poststateHash) {
          throw new AppError(409, "mutation_readback_mismatch", "The saved readback must match the exact target and verified mutation state.");
        }
        snapshotId = await publishPackageReadback(lease.scope, evidence.readback, client, evidence.inventoryGeneration, evidence.poststate);
      }
      await client.query("UPDATE job_attempts SET finished_at=clock_timestamp(),outcome=$3,readback_count=$4 WHERE item_id=$1 AND lease_version=$2", [itemId, lease.version, outcome, Math.min(Math.max(evidence.readbackCount ?? 0, 0), 20)]);
      await new AuditLog(lease.scope, client).completeEvent(`${itemId}:${lease.version}`, { status: outcome, message: evidence.message, errorCode: evidence.errorCode, metadata: { poststateHash: poststateHash ?? "", readbackCount: evidence.readbackCount ?? 0, reconciliationStatus: outcome === "inconclusive" ? "required" : "not_required", verification: outcome === "succeeded" || snapshotId ? "provider_readback" : "not_verified", ...(snapshotId ? { snapshotId } : {}) } });
    });
  }

  async withTargetLock<T>(lease: Lease, item: JobItem, operation: () => Promise<T>) {
    const client = await this.database.connect();
    const key = `package-mutation:${lease.scope.tenantId}:${item.target_id}`;
    try {
      await client.query("SELECT pg_advisory_lock(hashtextextended($1,0))", [key]);
      await this.fence(client, lease);
      return await operation();
    } finally {
      await client.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [key]).catch(() => undefined);
      client.release();
    }
  }

  async reconciliationContext(id: string, scope: DataScope, after = -1) {
    const job = await this.database.query<Pick<JobRow, "action" | "access_update">>("SELECT action,access_update FROM jobs WHERE id=$1 AND tenant_id=$2 AND principal_id=$3 AND expires_at>clock_timestamp()", [id, scope.tenantId, scope.principalId]);
    if (!job.rows[0]) return undefined;
    const items = await this.database.query<JobItem & { candidate_count: string }>(`WITH candidates AS (
      SELECT * FROM job_items WHERE job_id=$1 AND ordinal>$2 AND status='inconclusive'
        AND reconciliation_status='required' ORDER BY ordinal LIMIT 100),
      sized AS (SELECT *,count(*) OVER() AS candidate_count,sum(octet_length(row_to_json(candidate)::text)) OVER(ORDER BY ordinal) AS bytes
        FROM candidates candidate)
      SELECT * FROM sized WHERE bytes<=524288 ORDER BY ordinal`, [id, after]);
    return { job: job.rows[0], items: items.rows, hasMore: items.rows.length === 100
      || items.rows.length > 0 && exactCount(items.rows[0].candidate_count) > items.rows.length };
  }

  async withReconciliationLock<T>(scope: DataScope, item: JobItem, operation: () => Promise<T>) {
    const client = await this.database.connect();
    const key = `package-mutation:${scope.tenantId}:${item.target_id}`;
    try {
      await client.query("SELECT pg_advisory_lock(hashtextextended($1,0))", [key]);
      const current = await client.query("SELECT 1 FROM job_items item JOIN jobs job ON job.id=item.job_id WHERE item.id=$1 AND job.tenant_id=$2 AND job.principal_id=$3 AND job.cancel_requested=false AND item.status='inconclusive' AND item.reconciliation_status='required'", [item.id, scope.tenantId, scope.principalId]);
      if (!current.rowCount) throw new AppError(409, "reconciliation_state", "The package item no longer requires reconciliation.");
      return await operation();
    } finally {
      await client.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [key]).catch(() => undefined);
      client.release();
    }
  }

  async inventoryGeneration(scope: DataScope) {
    return readPackageInventoryGeneration(scope, this.database);
  }

  async recordReconciliation(scope: DataScope, itemId: string, status: Exclude<ReconciliationStatus, "not_required" | "required">, observed: PackageMutationState, message: string, observation?: { details: CopilotPackageDetail; inventoryGeneration: string | null }) {
    await transaction(this.database, async client => {
      if (observation) await lockPackageInventoryScope(scope, client);
      const item = await client.query<JobItem & { job_id: string; lease_version: number; action: AuditAction }>(`SELECT item.*,attempt.lease_version,job.action FROM job_items item
        JOIN jobs job ON job.id=item.job_id
        JOIN LATERAL (SELECT lease_version FROM job_attempts WHERE item_id=item.id ORDER BY lease_version DESC LIMIT 1) attempt ON true
        WHERE item.id=$1 AND job.tenant_id=$2 AND job.principal_id=$3 AND job.cancel_requested=false AND item.status='inconclusive' AND item.reconciliation_status='required' FOR UPDATE`, [itemId, scope.tenantId, scope.principalId]);
      if (!item.rows[0]) throw new AppError(409, "reconciliation_state", "The package item no longer requires reconciliation.");
      const poststateHash = packageMutationStateHash(observed);
      let snapshotId: string | undefined;
      if (observation) {
        if (observation.details.id !== item.rows[0].target_id
          || packageMutationStateHash(capturePackageMutationState(observation.details, item.rows[0].action)) !== poststateHash) {
          throw new AppError(409, "mutation_readback_mismatch", "The saved readback must match the exact reconciled target and observed state.");
        }
        snapshotId = await publishPackageReadback(scope, observation.details, client, observation.inventoryGeneration, observed);
      }
      await client.query(`UPDATE job_items SET status=CASE WHEN $2='verified_applied' THEN 'succeeded' ELSE status END,
        poststate=$3,poststate_hash=$4,reconciliation_status=$2,reconciled_at=clock_timestamp(),message=$5,updated_at=clock_timestamp() WHERE id=$1`, [itemId, status, observed, poststateHash, message.slice(0,1024)]);
      await new AuditLog(scope, client).completeEvent(`${itemId}:${item.rows[0].lease_version}`, {
        status: status === "verified_applied" ? "succeeded" : "inconclusive",
        message,
        metadata: { poststateHash, reconciliationStatus: status, verification: "provider_reconciliation", ...(snapshotId ? { snapshotId } : {}) },
      });
      await this.aggregate(client, item.rows[0].job_id);
    });
  }

  async release(lease: Lease) {
    await transaction(this.database, async client => {
      await this.fence(client, lease);
      const pendingCommit = await client.query("SELECT 1 FROM job_items WHERE job_id=$1 AND status='running'", [lease.jobId]);
      if (pendingCommit.rowCount) return;
      await this.aggregate(client, lease.jobId);
      await client.query("UPDATE jobs SET lease_owner=NULL,lease_until=NULL,updated_at=clock_timestamp() WHERE id=$1", [lease.jobId]);
    });
  }

  private async aggregate(client: pg.PoolClient, id: string) {
    await client.query(`UPDATE jobs SET status=CASE
      WHEN EXISTS (SELECT 1 FROM job_items WHERE job_id=$1 AND status='inconclusive') THEN 'partial'
      WHEN EXISTS (SELECT 1 FROM job_items WHERE job_id=$1 AND status IN ('queued','running')) THEN 'waiting_authorization'
      WHEN cancel_requested OR EXISTS (SELECT 1 FROM job_items WHERE job_id=$1 AND status='cancelled') THEN 'cancelled'
      WHEN NOT EXISTS (SELECT 1 FROM job_items WHERE job_id=$1 AND status<>'failed') THEN 'failed'
      WHEN EXISTS (SELECT 1 FROM job_items WHERE job_id=$1 AND status='failed') THEN 'partial'
      ELSE 'succeeded' END,updated_at=clock_timestamp() WHERE id=$1`, [id]);
  }

  async cancel(id: string, scope: DataScope) {
    await transaction(this.database, async client => {
      const job = await client.query("UPDATE jobs SET cancel_requested=true WHERE id=$1 AND tenant_id=$2 AND principal_id=$3 AND status IN ('queued','running','waiting_authorization','partial') RETURNING id", [id, scope.tenantId, scope.principalId]);
      if (!job.rowCount) return;
      await client.query("UPDATE job_items SET status='cancelled',updated_at=clock_timestamp() WHERE job_id=$1 AND status='queued'", [id]);
      const running = await client.query("SELECT 1 FROM job_items WHERE job_id=$1 AND status='running'", [id]);
      if (!running.rowCount) await this.aggregate(client, id);
    });
    return this.get(id, scope);
  }

  async recover(tenantId: string, includeQueued = false, jobId?: string) {
    if (!tenantId) throw new AppError(400, "scope_mismatch", "Recovery requires an exact tenant.");
    return transaction(this.database, async client => {
      const started = performance.now();
      await client.query("SET LOCAL transaction_timeout='5s'; SET LOCAL statement_timeout='5s'");
      const jobs = await client.query(`SELECT id,tenant_id,principal_id,lease_version,cancel_requested,
        deadline_at<clock_timestamp() OR attempts>=10 AS expired,octet_length(row_to_json(j)::text) AS bytes
        FROM jobs j WHERE tenant_id=$1 AND
        (status='running' OR ($2 AND status='queued') OR (status IN ('queued','waiting_authorization','partial')
          AND (deadline_at<clock_timestamp() OR attempts>=10) AND EXISTS(
            SELECT 1 FROM job_items i WHERE i.job_id=j.id AND i.status IN ('queued','running'))))
        AND (lease_until IS NULL OR lease_until<clock_timestamp()) AND ($3::uuid IS NULL OR id=$3)
        ORDER BY updated_at,id LIMIT 1 FOR UPDATE SKIP LOCKED`, [tenantId, includeQueued, jobId ?? null]);
      let progress = 0;
      for (const job of jobs.rows) {
        if (job.bytes > 131_072) throw new Error("job_recovery_metadata_limit");
        // Each item UPDATE fires the statement-level result-revision trigger and writes the full parent.
        // Parent settlement writes twice more. Bound scalar growth by their maximum encoded lengths:
        // bigint revision (19), timestamp (35), and the longest resulting status (21 including quotes).
        const parentBytes = job.bytes + 19 + 35 + 21;
        const running = await client.query(`WITH candidates AS (
          SELECT i.id,i.sent_at,i.status,octet_length(row_to_json(i)::text)
            +coalesce((SELECT sum(octet_length(row_to_json(a)::text)) FROM job_attempts a WHERE a.item_id=i.id AND a.finished_at IS NULL),0)
            +coalesce((SELECT sum(octet_length(row_to_json(a)::text)) FROM audit_events a WHERE a.event_id=i.id::text||':'||$3::text),0)+4096+$4 AS bytes,
            2+(SELECT count(*) FROM job_attempts a WHERE a.item_id=i.id AND a.finished_at IS NULL)
              +CASE WHEN i.status='running' THEN 1 ELSE 0 END AS changed_rows
          FROM job_items i WHERE job_id=$1 AND (status='running' OR $2 AND status='queued') ORDER BY ordinal LIMIT 64
        ), bounded AS (SELECT *,sum(bytes) OVER(ORDER BY id) AS total,sum(changed_rows) OVER(ORDER BY id) AS total_rows FROM candidates)
        SELECT id,sent_at,status FROM bounded WHERE total<=$5 AND total_rows<=$6 ORDER BY id`,
        [job.id, job.expired, job.lease_version, parentBytes, Math.min(786432, lifecycleLimits.bytes - 2 * parentBytes), lifecycleLimits.rows - 2]);
        for (const item of running.rows) {
          if (performance.now() - started > 4000) break;
          progress++;
          if (item.status === "queued") {
            await client.query("UPDATE job_items SET status='failed',message='Job execution budget expired before dispatch.',updated_at=clock_timestamp() WHERE id=$1", [item.id]);
            continue;
          }
          const outcome = item.sent_at ? "inconclusive" : "cancelled";
          await client.query("UPDATE job_items SET status=$2,reconciliation_status=CASE WHEN sent_at IS NOT NULL THEN 'required' ELSE 'not_required' END,updated_at=clock_timestamp() WHERE id=$1", [item.id, item.sent_at ? "inconclusive" : job.cancel_requested ? "cancelled" : "queued"]);
          await client.query("UPDATE job_attempts SET outcome=$2,finished_at=clock_timestamp() WHERE item_id=$1 AND finished_at IS NULL", [item.id, outcome]);
          await new AuditLog({ tenantId: job.tenant_id, principalId: job.principal_id }, client).completeEvent(`${item.id}:${job.lease_version}`, { status: outcome, message: item.sent_at ? "Dispatch outcome is unknown; explicit reconciliation is required." : "Attempt ended before dispatch; reauthorization is required." });
        }
        const unfinished = await client.query(`SELECT 1 FROM job_items WHERE job_id=$1
          AND (status='running' OR $2 AND status='queued') LIMIT 1`, [job.id, job.expired]);
        if (unfinished.rowCount) {
          if (!progress) throw new Error("job_recovery_item_limit");
          await client.query("UPDATE jobs SET updated_at=clock_timestamp() WHERE id=$1", [job.id]);
          continue;
        }
        await this.aggregate(client, job.id);
        await client.query("UPDATE jobs SET lease_owner=NULL,lease_until=NULL WHERE id=$1", [job.id]);
        progress++;
      }
      return progress;
    });
  }

  async waitForAuthorization(id: string, scope: DataScope) {
    await this.database.query("UPDATE jobs SET status='waiting_authorization',updated_at=clock_timestamp() WHERE id=$1 AND tenant_id=$2 AND principal_id=$3 AND status='queued' AND lease_owner IS NULL", [id, scope.tenantId, scope.principalId]);
  }

  async pauseForAuthorization(lease: Lease) {
    await transaction(this.database, async client => {
      await this.fence(client, lease);
      const running = await client.query("SELECT 1 FROM job_items WHERE job_id=$1 AND status='running'", [lease.jobId]);
      if (running.rowCount) throw new AppError(409, "lease_lost", "An unfinished item prevents releasing the job for authorization.");
      await this.aggregate(client, lease.jobId);
      await client.query("UPDATE jobs SET lease_owner=NULL,lease_until=NULL,updated_at=clock_timestamp() WHERE id=$1", [lease.jobId]);
    });
  }

  async pauseItemForAuthorization(lease: Lease, itemId: string) {
    await transaction(this.database, async client => {
      await this.fence(client, lease);
      const item = await client.query("UPDATE job_items SET status='queued',message=NULL,error_code=NULL,updated_at=clock_timestamp() WHERE id=$1 AND job_id=$2 AND status='running' AND sent_at IS NULL RETURNING id", [itemId, lease.jobId]);
      if (item.rowCount !== 1) throw new AppError(409, "already_dispatched", "Sent work cannot return to authorization wait.");
      await client.query("UPDATE job_attempts SET finished_at=clock_timestamp(),outcome='cancelled' WHERE item_id=$1 AND lease_version=$2 AND sent_at IS NULL AND finished_at IS NULL", [itemId, lease.version]);
      await new AuditLog(lease.scope, client).completeEvent(`${itemId}:${lease.version}`, { status: "cancelled", message: "Attempt ended before dispatch because current authorization is required." });
      await this.aggregate(client, lease.jobId);
      await client.query("UPDATE jobs SET lease_owner=NULL,lease_until=NULL,updated_at=clock_timestamp() WHERE id=$1", [lease.jobId]);
    });
  }

  async waitForPrincipalAuthorization(scope: DataScope) {
    await this.database.query(`UPDATE jobs SET status='waiting_authorization',updated_at=clock_timestamp()
      WHERE tenant_id=$1 AND principal_id=$2 AND token_mode='delegated' AND status='queued' AND lease_owner IS NULL
      AND EXISTS (SELECT 1 FROM job_items WHERE job_id=jobs.id AND status='queued')`, [scope.tenantId, scope.principalId]);
  }
}

export function mutationRetryIntentHash(input: MutationRetryIntent) {
  return hash({
    action: input.action,
    scope: input.scope,
    requestPath: input.requestPath,
    targetIds: input.targetIds === undefined ? undefined : [...input.targetIds].sort(ordinal),
    accessUpdate: input.accessUpdate ? {
      mode: input.accessUpdate.mode,
      target: input.accessUpdate.target,
      principals: canonicalAccessEntities(input.accessUpdate.principals),
    } : null,
  });
}

function prepareIntent(input: JobIntentInput) {
  if (!Array.isArray(input.targets) || input.targets.length < 1 || input.targets.length > 5000) throw new AppError(400, "invalid_targets", "Submit 1-5000 exact package targets.");
  if (input.targets.some(target => typeof target?.id !== "string")) throw new AppError(400, "invalid_targets", "Each package target requires an exact native ID of at most 512 characters.");
  const ids = input.targets.map(target => target.id);
  if (ids.some(id => !id || id.length > 512)) throw new AppError(400, "invalid_targets", "Each package target requires an exact native ID of at most 512 characters.");
  if (new Set(ids).size !== ids.length) throw new AppError(400, "duplicate_target", "Duplicate package mutation targets are not allowed.");
  const targets = input.targets.map((target, index) => {
    const displayName = target.displayName.trim();
    if (!displayName || displayName.length > 256 || Buffer.byteLength(JSON.stringify(target.prestate)) > 65_000) throw new AppError(400, "invalid_targets", "Each package target requires a bounded display name and prestate.");
    expectedPackageMutationState(target.prestate, input.action, input.accessUpdate);
    return { id: ids[index], displayName, prestate: target.prestate, prestateHash: packageMutationStateHash(target.prestate) };
  }).sort((left, right) => ordinal(left.id, right.id));
  const accessUpdate = input.accessUpdate ? { ...input.accessUpdate, principals: canonicalAccessEntities(input.accessUpdate.principals) } as PackageAccessUpdate : undefined;
  if (accessUpdate && Buffer.byteLength(JSON.stringify(accessUpdate)) > 60_000) throw new AppError(400, "request_too_large", "Access intent is too large.");
  if ((input.action === "update-availability" || input.action === "update-installation") !== Boolean(accessUpdate)) throw new AppError(400, "invalid_mutation_intent", "The package mutation action and access payload do not match.");
  if (accessUpdate && input.action !== (accessUpdate.target === "availability" ? "update-availability" : "update-installation")) throw new AppError(400, "invalid_mutation_intent", "The package access action does not match its selected target.");
  const reassignUserId = input.reassignUserId?.trim();
  if (input.action === "reassign" || reassignUserId) throw new AppError(409, "reassign_verification_unavailable", "Reassign owner is disabled because the documented package detail contract has no owner field for provider verification.");
  return { ...input, targets, accessUpdate, reassignUserId };
}

function canonicalIntent(input: ReturnType<typeof prepareIntent>) {
  return { action: input.action, targets: input.targets.map(target => ({ id: target.id, displayName: target.displayName, prestateHash: target.prestateHash })), accessUpdate: input.accessUpdate ?? null, reassignUserId: input.reassignUserId ?? null, actorId: input.actor.homeAccountId, scope: input.scope };
}

function mutationEndpoint(action: AuditAction) {
  if (action === "block" || action === "unblock" || action === "reassign") return `POST /beta/copilot/admin/catalog/packages/{id}/${action}`;
  return "PATCH /beta/copilot/admin/catalog/packages/{id}";
}

function rollbackDescription(action: AuditAction) {
  if (action === "block" || action === "unblock") return "Possible through a separately confirmed inverse operation after provider readback.";
  if (action === "reassign") return "Unavailable because the current owner is not exposed for verification.";
  return "Touched access fields can be restored only when readback still matches this change and no external update intervened.";
}

function hash(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function ordinal(left: string, right: string) {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

function jobCapability(action: AuditAction): "graph.package.block.manage" | "graph.package.access.manage" | "graph.package.reassign.manage" {
  return action === "block" || action === "unblock" ? "graph.package.block.manage" : action === "reassign" ? "graph.package.reassign.manage" : "graph.package.access.manage";
}