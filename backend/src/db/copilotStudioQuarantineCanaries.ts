import { randomUUID } from "node:crypto";
import type pg from "pg";
import { AppError } from "../errors.js";
import type { InventoryQuarantineTarget, QuarantineAction, QuarantineAuthority } from "../types/copilotStudioQuarantine.js";
import type { AuthenticatedUser } from "../types/session.js";
import { hasAppRole } from "../types/capability.js";
import { pool, transaction } from "./pool.js";

export type QuarantineCanaryApprovalInput = {
  target: InventoryQuarantineTarget;
  action: QuarantineAction;
  prestate: boolean;
  prestateProviderUpdatedAt: string | null;
  poststate: boolean;
  authority: QuarantineAuthority;
};

type CanaryStatus = "approved" | "claimed" | "qualified" | "failed" | "inconclusive" | "conflict" | "expired";
type CanaryRow = {
  id: string; tenant_id: string; approved_by_principal_id: string; resource_native_id: string; display_name: string; snapshot_id: string;
  inventory_observed_at: Date; environment_id: string; bot_id: string; action: QuarantineAction; prestate: boolean;
  prestate_provider_updated_at: string | null; poststate: boolean; contract_revision: string; permission_revision: string;
  configuration_revision: string; auth_mode: "delegated"; status: CanaryStatus; paired_approval_id: string | null;
  actor_principal_id: string | null; job_id: string | null; approved_at: Date; attempted_at: Date | null; finished_at: Date | null;
  approval_expires_at: Date; evidence_expires_at: Date; error_code: string | null;
};

export type QuarantineCanaryApproval = ReturnType<typeof projectApproval>;

export class CopilotStudioQuarantineCanaryRepository {
  constructor(private readonly database: pg.Pool = pool) {}

  async createApproved(user: AuthenticatedUser, input: QuarantineCanaryApprovalInput) {
    requireAdministrator(user);
    validateApprovalInput(input);
    const tenantId = requireTenant(user);
    return transaction(this.database, async client => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`quarantine-canary:${tenantId}:${input.target.environmentId}:${input.target.botId}:${input.action}`]);
      await client.query(`UPDATE copilot_quarantine_canary_approvals SET status='expired'
        WHERE tenant_id=$1 AND environment_id=$2 AND bot_id=$3 AND action=$4 AND status='approved'`, [tenantId, input.target.environmentId, input.target.botId, input.action]);
      const rows = await client.query<CanaryRow>(`INSERT INTO copilot_quarantine_canary_approvals
        (id,tenant_id,approved_by_principal_id,resource_native_id,display_name,snapshot_id,inventory_observed_at,environment_id,bot_id,action,
         prestate,prestate_provider_updated_at,poststate,contract_revision,permission_revision,configuration_revision,auth_mode)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'delegated') RETURNING *`,
      [randomUUID(), tenantId, user.homeAccountId, input.target.resourceNativeId, input.target.displayName, input.target.snapshotId, input.target.inventoryObservedAt,
        input.target.environmentId, input.target.botId, input.action, input.prestate, input.prestateProviderUpdatedAt, input.poststate,
        input.authority.contractRevision, input.authority.permissionRevision, input.authority.configurationRevision]);
      return projectApproval(rows.rows[0]);
    });
  }

  async list(user: AuthenticatedUser, limit = 50) {
    requireAdministrator(user);
    const rows = await this.database.query<CanaryRow>(`SELECT * FROM copilot_quarantine_canary_approvals WHERE tenant_id=$1
      ORDER BY approved_at DESC,id DESC LIMIT $2`, [requireTenant(user), Math.min(Math.max(Math.trunc(limit), 1), 100)]);
    return { value: rows.rows.map(projectApproval) };
  }

  async claimCycle(user: AuthenticatedUser, originalId: string, restorationId: string, authority: QuarantineAuthority) {
    requireOperator(user);
    const tenantId = requireTenant(user);
    const result = await transaction(this.database, async client => {
      const ids = [approvalId(originalId), approvalId(restorationId)];
      if (ids[0] === ids[1]) return { kind: "mismatch" as const };
      const current = await client.query<CanaryRow>(`SELECT * FROM copilot_quarantine_canary_approvals
        WHERE id=ANY($1::uuid[]) AND tenant_id=$2 ORDER BY id FOR UPDATE`, [ids, tenantId]);
      const original = current.rows.find(row => row.id === ids[0]);
      const restoration = current.rows.find(row => row.id === ids[1]);
      if (!original || !restoration || [original, restoration].some(row => row.status !== "approved" || row.approval_expires_at.getTime() <= Date.now())) return { kind: "missing" as const };
      if ([original, restoration].some(row => row.approved_by_principal_id === user.homeAccountId)) return { kind: "same_actor" as const };
      if (![original, restoration].every(row => authorityMatches(row, authority))) {
        await client.query("UPDATE copilot_quarantine_canary_approvals SET status='expired' WHERE id=ANY($1::uuid[])", [ids]);
        return { kind: "invalidated" as const };
      }
      if (!isExactInverse(original, restoration) || original.prestate_provider_updated_at === null || restoration.prestate_provider_updated_at !== null) return { kind: "mismatch" as const };
      const claimed = await client.query<CanaryRow>(`UPDATE copilot_quarantine_canary_approvals SET status='claimed',actor_principal_id=$2,
        paired_approval_id=CASE WHEN id=$3 THEN $4::uuid ELSE $3::uuid END,attempted_at=clock_timestamp()
        WHERE id=ANY($1::uuid[]) AND status='approved' RETURNING *`, [ids, user.homeAccountId, ids[0], ids[1]]);
      if (claimed.rowCount !== 2) throw new AppError(409, "canary_cycle_state", "The quarantine canary approvals changed while being claimed.");
      return { kind: "claimed" as const, value: {
        original: projectApproval(claimed.rows.find(row => row.id === ids[0])!),
        restoration: projectApproval(claimed.rows.find(row => row.id === ids[1])!),
      } };
    });
    if (result.kind === "same_actor") throw new AppError(409, "separate_approval_required", "The Admin executing the quarantine canary must differ from the approving Admin.");
    if (result.kind === "invalidated") throw new AppError(409, "qualification_invalidated", "The quarantine canary contract, permission, or configuration revision changed.");
    if (result.kind === "mismatch") throw new AppError(409, "canary_cycle_mismatch", "Restoration must be the exact inverse target, action, and semantic state, with its future provider timestamp left unset.");
    if (result.kind === "missing") throw new AppError(409, "canary_cycle_not_approved", "Both quarantine canary directions require current unused approvals.");
    return result.value;
  }

  async authorizeJob(user: AuthenticatedUser, approvalIdValue: string, jobId: string, authority: QuarantineAuthority) {
    requireOperator(user);
    const rows = await this.database.query<CanaryRow>(`SELECT * FROM copilot_quarantine_canary_approvals
      WHERE id=$1 AND tenant_id=$2 AND status='claimed' AND actor_principal_id=$3 AND job_id=$4 AND approval_expires_at>clock_timestamp()`,
    [approvalId(approvalIdValue), requireTenant(user), user.homeAccountId, approvalId(jobId)]);
    if (!rows.rows[0] || !authorityMatches(rows.rows[0], authority)) throw new AppError(401, "qualification_invalidated", "The exact quarantine canary approval is no longer current for this job.");
    return projectApproval(rows.rows[0]);
  }

  async completeCycle(user: AuthenticatedUser, originalId: string, restorationId: string, completion: { status: "qualified" | "failed" | "inconclusive" | "conflict"; errorCode?: string }, authority?: QuarantineAuthority) {
    requireOperator(user);
    const tenantId = requireTenant(user);
    return transaction(this.database, async client => {
      const ids = [approvalId(originalId), approvalId(restorationId)];
      const current = await client.query<CanaryRow>(`SELECT * FROM copilot_quarantine_canary_approvals
        WHERE id=ANY($1::uuid[]) AND tenant_id=$2 AND status='claimed' AND actor_principal_id=$3 ORDER BY id FOR UPDATE`, [ids, tenantId, user.homeAccountId]);
      const original = current.rows.find(row => row.id === ids[0]);
      const restoration = current.rows.find(row => row.id === ids[1]);
      if (!original || !restoration || !isExactInverse(original, restoration)) throw new AppError(409, "canary_cycle_state", "The paired quarantine canary cannot be completed from its current state.");
      if (completion.status === "qualified") {
        if (!authority || !authorityMatches(original, authority) || !authorityMatches(restoration, authority)) throw new AppError(409, "qualification_invalidated", "Quarantine authority changed before qualification publication.");
        await requireVerifiedCycleJobs(client, original, restoration);
        if (!original.job_id || !restoration.job_id) throw new AppError(409, "canary_cycle_unverified", "Both quarantine canary directions require durable jobs.");
        await client.query(`INSERT INTO copilot_quarantine_qualifications
          (id,tenant_id,target_environment_id,target_bot_id,original_approval_id,restoration_approval_id,original_job_id,restoration_job_id,
           contract_revision,permission_revision,configuration_revision,auth_mode)
          VALUES(gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'delegated')`, [tenantId, original.environment_id, original.bot_id,
          original.id, restoration.id, original.job_id, restoration.job_id, original.contract_revision, original.permission_revision, original.configuration_revision]);
      }
      const rows = await client.query<CanaryRow>(`UPDATE copilot_quarantine_canary_approvals SET status=$4,finished_at=clock_timestamp(),
        error_code=$5,evidence_expires_at=clock_timestamp()+interval '30 days' WHERE id=ANY($1::uuid[]) AND tenant_id=$2 AND actor_principal_id=$3 AND status='claimed' RETURNING *`,
      [ids, tenantId, user.homeAccountId, completion.status, completion.status === "qualified" ? null : safeErrorCode(completion.errorCode)]);
      if (rows.rowCount !== 2) throw new AppError(409, "canary_cycle_state", "The paired quarantine canary was not completed atomically.");
      return { original: projectApproval(rows.rows.find(row => row.id === ids[0])!), restoration: projectApproval(rows.rows.find(row => row.id === ids[1])!) };
    });
  }

  async recoverInterrupted(tenantId: string) {
    const result = await this.database.query(`UPDATE copilot_quarantine_canary_approvals SET status='inconclusive',finished_at=clock_timestamp(),
      error_code='process_interrupted',evidence_expires_at=clock_timestamp()+interval '30 days' WHERE tenant_id=$1 AND status='claimed'`, [tenantId]);
    return result.rowCount ?? 0;
  }
}

function validateApprovalInput(input: QuarantineCanaryApprovalInput) {
  if (input.poststate !== (input.action === "quarantine") || input.prestate === input.poststate) throw new AppError(400, "invalid_qualification_state", "The quarantine canary action must describe one exact boolean transition.");
  if (input.prestateProviderUpdatedAt !== null && !isUtcDateTime(input.prestateProviderUpdatedAt)) throw new AppError(400, "invalid_qualification_state", "Canary provider timestamp evidence must be exact UTC text or null for the future inverse state.");
  if (!input.target.resourceNativeId || !input.target.displayName || !input.target.snapshotId || !input.target.environmentId || !input.target.botId) throw new AppError(400, "invalid_quarantine_target", "Canary approval requires one exact saved inventory target.");
  if (!/^[a-f0-9]{64}$/.test(input.authority.contractRevision) || !/^[a-f0-9]{64}$/.test(input.authority.permissionRevision) || !Number.isSafeInteger(input.authority.configurationRevision) || input.authority.configurationRevision < 1) throw new AppError(400, "invalid_quarantine_authority", "Canary authority revisions are invalid.");
}

function isExactInverse(original: CanaryRow, restoration: CanaryRow) {
  return original.resource_native_id === restoration.resource_native_id && original.environment_id === restoration.environment_id && original.bot_id === restoration.bot_id
    && original.action !== restoration.action && original.prestate === restoration.poststate && original.poststate === restoration.prestate;
}

function authorityMatches(row: CanaryRow, authority: QuarantineAuthority) {
  return row.contract_revision === authority.contractRevision && row.permission_revision === authority.permissionRevision
    && Number(row.configuration_revision) === authority.configurationRevision && row.auth_mode === "delegated";
}

async function requireVerifiedCycleJobs(client: pg.PoolClient, original: CanaryRow, restoration: CanaryRow) {
  if (!original.job_id || !restoration.job_id) throw new AppError(409, "canary_cycle_unverified", "Both quarantine canary directions require durable jobs.");
  const rows = await client.query<{ id: string; action: QuarantineAction; status: string; canary_approval_id: string; resource_native_id: string; environment_id: string;
    bot_id: string; prestate: boolean; prestate_provider_updated_at: string; requested_state: boolean; item_status: string; observed_state: boolean | null; observed_provider_updated_at: string | null }>(`SELECT job.id,job.action,job.status,job.canary_approval_id,item.resource_native_id,item.environment_id,item.bot_id,item.prestate,
      item.prestate_provider_updated_at,item.requested_state,item.status AS item_status,item.observed_state,item.observed_provider_updated_at
      FROM copilot_quarantine_jobs job JOIN copilot_quarantine_job_items item ON item.job_id=job.id
      WHERE job.id=ANY($1::uuid[]) AND job.tenant_id=$2 AND job.principal_id=$3 AND job.is_canary`,
  [[original.job_id, restoration.job_id], original.tenant_id, original.actor_principal_id]);
  const originalJob = rows.rows.find(row => row.id === original.job_id);
  const restorationJob = rows.rows.find(row => row.id === restoration.job_id);
  const sameTarget = (row: typeof rows.rows[number] | undefined) => row?.resource_native_id === original.resource_native_id && row.environment_id === original.environment_id && row.bot_id === original.bot_id;
  if (!originalJob || !restorationJob || !sameTarget(originalJob) || !sameTarget(restorationJob)
    || originalJob.canary_approval_id !== original.id || restorationJob.canary_approval_id !== restoration.id
    || originalJob.action !== original.action || restorationJob.action !== restoration.action
    || originalJob.status !== "succeeded" || restorationJob.status !== "succeeded" || originalJob.item_status !== "succeeded" || restorationJob.item_status !== "succeeded"
    || originalJob.prestate !== original.prestate || originalJob.prestate_provider_updated_at !== original.prestate_provider_updated_at
    || originalJob.requested_state !== original.poststate || originalJob.observed_state !== original.poststate || !originalJob.observed_provider_updated_at
    || originalJob.observed_provider_updated_at === originalJob.prestate_provider_updated_at
    || restorationJob.prestate !== original.poststate || restorationJob.prestate_provider_updated_at !== originalJob.observed_provider_updated_at
    || restorationJob.requested_state !== original.prestate || restorationJob.observed_state !== original.prestate || !restorationJob.observed_provider_updated_at
    || restorationJob.observed_provider_updated_at === restorationJob.prestate_provider_updated_at
    || restorationJob.observed_provider_updated_at === originalJob.observed_provider_updated_at) {
    throw new AppError(409, "canary_cycle_unverified", "Durable provider readback does not prove both exact quarantine canary directions and restoration.");
  }
}

function projectApproval(row: CanaryRow) {
  return { id: row.id, tenantId: row.tenant_id, approvedByPrincipalId: row.approved_by_principal_id, resourceNativeId: row.resource_native_id,
    displayName: row.display_name, snapshotId: row.snapshot_id, inventoryObservedAt: row.inventory_observed_at.toISOString(), environmentId: row.environment_id,
    botId: row.bot_id, action: row.action, prestate: row.prestate, prestateProviderUpdatedAt: row.prestate_provider_updated_at, poststate: row.poststate,
    authority: { contractRevision: row.contract_revision, permissionRevision: row.permission_revision, configurationRevision: Number(row.configuration_revision) },
    authMode: row.auth_mode, status: row.status, pairedApprovalId: row.paired_approval_id, actorPrincipalId: row.actor_principal_id, jobId: row.job_id,
    approvedAt: row.approved_at.toISOString(), attemptedAt: row.attempted_at?.toISOString() ?? null, finishedAt: row.finished_at?.toISOString() ?? null,
    approvalExpiresAt: row.approval_expires_at.toISOString(), evidenceExpiresAt: row.evidence_expires_at.toISOString(), errorCode: row.error_code };
}

function requireAdministrator(user: AuthenticatedUser) {
  if (!hasAppRole(user.roles, "AgentControl.Admin")) throw new AppError(403, "missing_internal_role", "Admin is required to approve or inspect quarantine canaries.");
}

function requireOperator(user: AuthenticatedUser) {
  if (!hasAppRole(user.roles, "AgentControl.Admin")) throw new AppError(403, "missing_internal_role", "Admin is required to execute quarantine canaries.");
}

function requireTenant(user: AuthenticatedUser) {
  if (!user.tenantId) throw AppError.unauthorized("Quarantine canary work requires a tenant scope.");
  return user.tenantId;
}

function approvalId(value: string) {
  if (!/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value)) throw new AppError(400, "invalid_qualification_id", "Quarantine canary approval ID is invalid.");
  return value;
}

function safeErrorCode(value: string | undefined) {
  return value && /^[a-z0-9_]{1,128}$/.test(value) ? value : "canary_cycle_failed";
}

function isUtcDateTime(value: string) {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?Z$/.test(value) && !Number.isNaN(Date.parse(value));
}