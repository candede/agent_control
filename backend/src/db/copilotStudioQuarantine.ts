import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";
import { AppError } from "../errors.js";
import { requireProviderAdmissions } from "../services/operationalState.js";
import type {
  CopilotStudioQuarantineTarget,
  CopilotStudioQuarantineStatus,
  FrozenQuarantineTarget,
  InventoryQuarantineTarget,
  QuarantineAction,
  QuarantineActor,
  QuarantineAuthority,
  QuarantineConfirmationSummary,
  QuarantineItemStatus,
  QuarantineJob,
  QuarantineJobStatus,
  QuarantineReconciliationStatus,
} from "../types/copilotStudioQuarantine.js";
import { pool, transaction } from "./pool.js";

export type QuarantineScope = { tenantId: string; principalId: string };
export type QuarantineJobInput = {
  action: QuarantineAction;
  targets: FrozenQuarantineTarget[];
  actor: QuarantineActor;
  authority: QuarantineAuthority;
  requestPath: string;
  idempotencyKey: string;
  confirmationHash: string;
  canaryApprovalId?: string;
};

export type QuarantineSubmissionIdentity = {
  action: QuarantineAction;
  snapshotId: string;
  resourceNativeIds: string[];
  confirmationHash: string;
  idempotencyKey: string;
};

export type QuarantineJobRow = {
  id: string; tenant_id: string; principal_id: string; action: QuarantineAction; status: QuarantineJobStatus;
  request_hash: string; confirmation_hash: string; confirmation_summary: QuarantineConfirmationSummary; actor_name: string; actor_username: string;
  request_path: string; contract_revision: string; permission_revision: string; configuration_revision: string; is_canary: boolean;
  canary_approval_id: string | null; cancel_requested: boolean; lease_owner: string | null; lease_version: string; lease_until: Date | null;
  attempts: number; created_at: Date; updated_at: Date; deadline_at: Date; expires_at: Date;
};

export type QuarantineItemRow = {
  id: string; job_id: string; ordinal: number; resource_native_id: string; display_name: string; snapshot_id: string; inventory_observed_at: Date;
  environment_id: string; bot_id: string; prestate: boolean; prestate_provider_updated_at: string; requested_state: boolean;
  status: QuarantineItemStatus; sent_at: Date | null; correlation_id: string | null; observed_state: boolean | null;
  observed_provider_updated_at: string | null; observed_at: Date | null; readback_count: number;
  reconciliation_status: QuarantineReconciliationStatus; reconciled_at: Date | null; error_code: string | null; message: string | null;
};

export type QuarantineLease = { jobId: string; scope: QuarantineScope; owner: string; version: number };

export function createQuarantineConfirmation(input: Omit<QuarantineJobInput, "idempotencyKey" | "confirmationHash">) {
  validateActorAndAuthority(input.actor, input.authority);
  if (!Array.isArray(input.targets) || input.targets.length < 1 || input.targets.length > 25) throw new AppError(400, "invalid_quarantine_target", "Submit 1-25 exact quarantine targets.");
  const requestedState = input.action === "quarantine";
  const targets = [...input.targets].sort((left, right) => ordinal(`${left.environmentId}\0${left.botId}`, `${right.environmentId}\0${right.botId}`));
  const keys = targets.map(target => `${target.environmentId}\0${target.botId}`);
  if (new Set(keys).size !== keys.length) throw new AppError(400, "duplicate_target", "Duplicate quarantine targets are not allowed.");
  if (new Set(targets.map(target => target.snapshotId)).size !== 1) throw new AppError(400, "invalid_quarantine_target", "One quarantine request must freeze targets from one exact inventory snapshot.");
  for (const target of targets) validateFrozenTarget(target);
  const targetSelectionHash = hash(targets.map(target => ({ resourceNativeId: target.resourceNativeId, environmentId: target.environmentId,
    botId: target.botId, snapshotId: target.snapshotId, prestate: target.directStatus.isBotQuarantined,
    providerUpdatedAt: target.directStatus.lastUpdateTimeUtc })));
  const visibleTargets = targets.map(target => ({
    resourceNativeId: target.resourceNativeId, displayName: target.displayName, environmentId: target.environmentId, botId: target.botId,
    currentState: target.directStatus.isBotQuarantined, currentProviderUpdatedAt: target.directStatus.lastUpdateTimeUtc, requestedState,
    inventoryState: target.inventoryQuarantineState, inventoryObservedAt: target.inventoryObservedAt,
  }));
  const summary: QuarantineConfirmationSummary = {
    risk: true, operation: input.action, provider: "Power Platform Copilot Studio", endpoint: "api-version=1 botQuarantine",
    permission: "Delegated CopilotStudio.AdminActions.Invoke", targetCount: targets.length, targetSelectionHash,
    actor: { id: input.actor.homeAccountId, displayName: input.actor.displayName, username: input.actor.username }, packageControlIndependent: true,
    makerBehavior: "Makers may still see and test a quarantined bot; other channels cannot use it.", providerAtomicity: false,
    targets: visibleTargets, additionalTargetCount: targets.length - visibleTargets.length,
  };
  const requestHash = hash({ action: input.action, targetSelectionHash, actorId: input.actor.homeAccountId, authority: input.authority,
    isCanary: Boolean(input.canaryApprovalId), canaryApprovalId: input.canaryApprovalId ?? null });
  return { targets, summary, requestHash, confirmationHash: hash({ requestHash, summary }) };
}

export class CopilotStudioQuarantineRepository {
  constructor(private readonly database: pg.Pool = pool) {}

  async existingSubmission(scope: QuarantineScope, identity: QuarantineSubmissionIdentity) {
    validateScope(scope);
    validateSubmissionIdentity(identity);
    const existing = await this.database.query<QuarantineJobRow>(
      "SELECT * FROM copilot_quarantine_jobs WHERE tenant_id=$1 AND principal_id=$2 AND idempotency_key=$3",
      [scope.tenantId, scope.principalId, identity.idempotencyKey],
    );
    if (!existing.rows[0]) return undefined;
    const items = await this.database.query<QuarantineItemRow>("SELECT * FROM copilot_quarantine_job_items WHERE job_id=$1 ORDER BY ordinal", [existing.rows[0].id]);
    requireMatchingSubmission(existing.rows[0], items.rows, identity);
    return projectJob(existing.rows[0], items.rows);
  }

  async latestObservation(scope: QuarantineScope, target: InventoryQuarantineTarget, maximumAgeMs = 60_000) {
    validateScope(scope);
    const rows = await this.database.query<{ is_bot_quarantined: boolean; provider_updated_at: string; observed_at: Date; correlation_id: string }>(`SELECT is_bot_quarantined,provider_updated_at,observed_at,correlation_id
      FROM copilot_quarantine_status_observations WHERE tenant_id=$1 AND principal_id=$2 AND environment_id=$3 AND bot_id=$4
        AND expires_at>clock_timestamp() AND observed_at>$5 ORDER BY observed_at DESC,id DESC LIMIT 1`,
    [scope.tenantId, scope.principalId, target.environmentId, target.botId, new Date(Date.now() - maximumAgeMs)]);
    return rows.rows[0] ? projectStatus(target, rows.rows[0]) : undefined;
  }

  async recordObservation(scope: QuarantineScope, target: InventoryQuarantineTarget, status: CopilotStudioQuarantineStatus) {
    validateScope(scope);
    if (status.environmentId !== target.environmentId || status.botId !== target.botId) throw new AppError(502, "target_mismatch", "Provider status did not match the exact quarantine target.");
    const id = randomUUID();
    await this.database.query(`INSERT INTO copilot_quarantine_status_observations
      (id,tenant_id,principal_id,resource_native_id,environment_id,bot_id,is_bot_quarantined,provider_updated_at,observed_at,correlation_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [id, scope.tenantId, scope.principalId, target.resourceNativeId, target.environmentId,
      target.botId, status.isBotQuarantined, status.lastUpdateTimeUtc, status.observedAt, status.correlationId]);
    return status;
  }

  async isQualified(scope: Pick<QuarantineScope, "tenantId">, authority: QuarantineAuthority, targets?: readonly CopilotStudioQuarantineTarget[]) {
    const row = await this.database.query(`SELECT DISTINCT target_environment_id,target_bot_id FROM copilot_quarantine_qualifications WHERE tenant_id=$1 AND contract_revision=$2
      AND permission_revision=$3 AND configuration_revision=$4 AND auth_mode='delegated' AND expires_at>clock_timestamp()
      AND ($5::jsonb IS NULL OR (target_environment_id,target_bot_id) IN
        (SELECT value->>0,value->>1 FROM jsonb_array_elements($5::jsonb) value))`,
    [scope.tenantId, authority.contractRevision, authority.permissionRevision, authority.configurationRevision,
      targets ? JSON.stringify(targets.map(target => [target.environmentId, target.botId])) : null]);
    return targets ? row.rowCount === new Set(targets.map(target => `${target.environmentId}\0${target.botId}`)).size : (row.rowCount ?? 0) > 0;
  }

  async submit(scope: QuarantineScope, input: QuarantineJobInput) {
    requireProviderAdmissions();
    validateScope(scope);
    if (input.actor.tenantId !== scope.tenantId || input.actor.homeAccountId !== scope.principalId) throw new AppError(403, "scope_mismatch", "Quarantine job scope does not match the current actor.");
    const identity = submissionIdentity(input);
    const durableReceipt = await this.existingSubmission(scope, identity);
    if (durableReceipt) return durableReceipt;
    const confirmation = createQuarantineConfirmation(input);
    if (input.confirmationHash !== confirmation.confirmationHash) throw new AppError(409, "confirmation_mismatch", "The exact quarantine target or direct status changed. Review and confirm again.");
    const id = await transaction(this.database, async client => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`quarantine-submit:${scope.tenantId}:${scope.principalId}`]);
      const existing = await client.query<QuarantineJobRow>("SELECT * FROM copilot_quarantine_jobs WHERE tenant_id=$1 AND principal_id=$2 AND idempotency_key=$3", [scope.tenantId, scope.principalId, input.idempotencyKey]);
      if (existing.rows[0]) {
        const items = await client.query<QuarantineItemRow>("SELECT * FROM copilot_quarantine_job_items WHERE job_id=$1 ORDER BY ordinal", [existing.rows[0].id]);
        requireMatchingSubmission(existing.rows[0], items.rows, identity);
        return existing.rows[0].id;
      }
      const targetValues = confirmation.targets.flatMap(target => [target.environmentId, target.botId]);
      const unresolved = await client.query(`SELECT 1 FROM copilot_quarantine_job_items item JOIN copilot_quarantine_jobs job ON job.id=item.job_id
        WHERE job.tenant_id=$1 AND job.expires_at>clock_timestamp() AND item.status='inconclusive' AND item.reconciliation_status='required'
          AND (item.environment_id,item.bot_id) IN (SELECT value->>0,value->>1 FROM jsonb_array_elements($2::jsonb) value) LIMIT 1`,
      [scope.tenantId, JSON.stringify(confirmation.targets.map(target => [target.environmentId, target.botId]))]);
      void targetValues;
      if (unresolved.rowCount) throw new AppError(409, "quarantine_reconciliation_required", "An uncertain write on this exact target must be reconciled by GET before new approval.");
      const outstanding = await client.query<{ count: number }>(`SELECT count(*)::int AS count FROM copilot_quarantine_jobs
        WHERE tenant_id=$1 AND principal_id=$2 AND status IN ('queued','running','waiting_authorization') AND expires_at>clock_timestamp()`, [scope.tenantId, scope.principalId]);
      if (outstanding.rows[0].count >= 5) throw new AppError(429, "job_limit", "At most five unfinished quarantine jobs are allowed per principal.");
      const jobId = randomUUID();
      if (input.canaryApprovalId) {
        if (confirmation.targets.length !== 1) throw new AppError(409, "canary_cycle_mismatch", "A quarantine canary job must contain exactly one approved target.");
        const target = confirmation.targets[0];
        const approval = await client.query<{ id: string }>(`SELECT id FROM copilot_quarantine_canary_approvals
          WHERE id=$1 AND tenant_id=$2 AND status='claimed' AND actor_principal_id=$3 AND job_id IS NULL AND approval_expires_at>clock_timestamp()
            AND action=$4 AND resource_native_id=$5 AND environment_id=$6 AND bot_id=$7
            AND prestate=$8 AND (prestate_provider_updated_at IS NULL OR prestate_provider_updated_at=$9) AND poststate=$10
            AND contract_revision=$11 AND permission_revision=$12 AND configuration_revision=$13 AND auth_mode='delegated' FOR UPDATE`,
        [input.canaryApprovalId, scope.tenantId, scope.principalId, input.action, target.resourceNativeId, target.environmentId, target.botId,
          target.directStatus.isBotQuarantined, target.directStatus.lastUpdateTimeUtc, input.action === "quarantine",
          input.authority.contractRevision, input.authority.permissionRevision, input.authority.configurationRevision]);
        if (!approval.rowCount) throw new AppError(409, "qualification_invalidated", "The exact claimed quarantine canary approval no longer authorizes this job.");
      }
      await client.query(`INSERT INTO copilot_quarantine_jobs
        (id,tenant_id,principal_id,idempotency_key,request_hash,action,confirmation_hash,confirmation_summary,actor_name,actor_username,
         request_path,contract_revision,permission_revision,configuration_revision,is_canary,canary_approval_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`, [jobId, scope.tenantId, scope.principalId, input.idempotencyKey,
        confirmation.requestHash, input.action, input.confirmationHash, confirmation.summary, input.actor.displayName, input.actor.username, input.requestPath,
        input.authority.contractRevision, input.authority.permissionRevision, input.authority.configurationRevision, Boolean(input.canaryApprovalId), input.canaryApprovalId ?? null]);
      for (const [index, target] of confirmation.targets.entries()) {
        const itemId = randomUUID();
        const requestedState = input.action === "quarantine";
        await client.query(`INSERT INTO copilot_quarantine_job_items
          (id,job_id,ordinal,resource_native_id,display_name,snapshot_id,inventory_observed_at,environment_id,bot_id,prestate,prestate_provider_updated_at,requested_state)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, [itemId, jobId, index, target.resourceNativeId, target.displayName,
          target.snapshotId, target.inventoryObservedAt, target.environmentId, target.botId, target.directStatus.isBotQuarantined,
          target.directStatus.lastUpdateTimeUtc, requestedState]);
        await insertAudit(client, { scope, actor: input.actor, jobId, itemId, action: input.action, phase: "requested", target, requestedState,
          message: "Quarantine mutation requested and confirmed; provider dispatch has not started." });
      }
      if (input.canaryApprovalId) {
        const attached = await client.query("UPDATE copilot_quarantine_canary_approvals SET job_id=$2 WHERE id=$1 AND job_id IS NULL AND status='claimed'", [input.canaryApprovalId, jobId]);
        if (attached.rowCount !== 1) throw new AppError(409, "canary_cycle_state", "The quarantine canary approval could not be attached atomically to its durable job.");
      }
      return jobId;
    });
    return (await this.get(scope, id))!;
  }

  async get(scope: QuarantineScope, id: string): Promise<QuarantineJob | undefined> {
    validateScope(scope);
    const jobs = await this.database.query<QuarantineJobRow>(`SELECT * FROM copilot_quarantine_jobs WHERE id=$1 AND tenant_id=$2 AND principal_id=$3 AND expires_at>clock_timestamp()`, [id, scope.tenantId, scope.principalId]);
    if (!jobs.rows[0]) return undefined;
    const items = await this.database.query<QuarantineItemRow>("SELECT * FROM copilot_quarantine_job_items WHERE job_id=$1 ORDER BY ordinal", [id]);
    return projectJob(jobs.rows[0], items.rows);
  }

  async list(scope: QuarantineScope, limit = 20) {
    validateScope(scope);
    const rows = await this.database.query<{ id: string }>(`SELECT id FROM copilot_quarantine_jobs WHERE tenant_id=$1 AND principal_id=$2 AND expires_at>clock_timestamp()
      ORDER BY created_at DESC,id DESC LIMIT $3`, [scope.tenantId, scope.principalId, Math.min(Math.max(limit, 1), 50)]);
    return { value: (await Promise.all(rows.rows.map(row => this.get(scope, row.id)))).filter((value): value is QuarantineJob => Boolean(value)) };
  }

  async listAudit(scope: QuarantineScope, limit = 100) {
    validateScope(scope);
    const rows = await this.database.query<{ id: string; principal_id: string; actor_username: string; actor_name: string; job_id: string; item_id: string | null;
      correlation_id: string | null; action: string; phase: string; resource_native_id: string; environment_id: string; bot_id: string;
      requested_state: boolean; observed_state: boolean | null; observed_provider_updated_at: string | null; error_code: string | null; message: string | null; observed_at: Date }>(`SELECT * FROM copilot_quarantine_audit
      WHERE tenant_id=$1 AND principal_id=$2 AND expires_at>clock_timestamp() ORDER BY observed_at DESC,id DESC LIMIT $3`, [scope.tenantId, scope.principalId, Math.min(Math.max(Math.trunc(limit), 1), 500)]);
    return { value: rows.rows.map(row => ({ id: row.id, principalId: row.principal_id, actor: { username: row.actor_username, displayName: row.actor_name },
      jobId: row.job_id, itemId: row.item_id, correlationId: row.correlation_id, action: row.action, phase: row.phase,
      target: { resourceNativeId: row.resource_native_id, environmentId: row.environment_id, botId: row.bot_id }, requestedState: row.requested_state,
      observedState: row.observed_state, observedProviderUpdatedAt: row.observed_provider_updated_at, errorCode: row.error_code, message: row.message,
      observedAt: row.observed_at.toISOString() })) };
  }

  async cancel(scope: QuarantineScope, id: string) {
    validateScope(scope);
    await transaction(this.database, async client => {
      const job = await client.query("UPDATE copilot_quarantine_jobs SET cancel_requested=true,updated_at=clock_timestamp() WHERE id=$1 AND tenant_id=$2 AND principal_id=$3 AND expires_at>clock_timestamp() RETURNING id", [id, scope.tenantId, scope.principalId]);
      if (!job.rowCount) return;
      await client.query("UPDATE copilot_quarantine_job_items SET status='cancelled',error_code='cancelled',message='Cancelled before provider dispatch.',updated_at=clock_timestamp() WHERE job_id=$1 AND status='queued'", [id]);
      await this.aggregate(client, id);
    });
    return this.get(scope, id);
  }

  async claim(scope: QuarantineScope, id: string, owner: string, resume = false): Promise<QuarantineLease | undefined> {
    requireProviderAdmissions();
    const result = await this.database.query<QuarantineJobRow>(`UPDATE copilot_quarantine_jobs SET status='running',lease_owner=$4,lease_version=lease_version+1,
      lease_until=clock_timestamp()+interval '120 seconds',attempts=attempts+1,updated_at=clock_timestamp()
      WHERE id=$1 AND tenant_id=$2 AND principal_id=$3 AND cancel_requested=false AND attempts<10 AND deadline_at>clock_timestamp()
        AND (lease_until IS NULL OR lease_until<clock_timestamp()) AND (status='queued' OR ($5 AND status='waiting_authorization'))
        AND EXISTS(SELECT 1 FROM copilot_quarantine_job_items WHERE job_id=$1 AND status='queued') RETURNING *`, [id, scope.tenantId, scope.principalId, owner, resume]);
    return result.rows[0] ? { jobId: id, scope, owner, version: Number(result.rows[0].lease_version) } : undefined;
  }

  async beginItem(lease: QuarantineLease) {
    return transaction(this.database, async client => {
      const job = await this.fence(client, lease);
      if (job.cancel_requested) return undefined;
      const selected = await client.query<QuarantineItemRow>(`SELECT * FROM copilot_quarantine_job_items WHERE job_id=$1 AND status='queued' ORDER BY ordinal LIMIT 1 FOR UPDATE`, [lease.jobId]);
      if (!selected.rows[0]) return undefined;
      const item = selected.rows[0];
      const correlationId = randomUUID();
      await client.query("UPDATE copilot_quarantine_job_items SET status='running',correlation_id=$2,updated_at=clock_timestamp() WHERE id=$1", [item.id, correlationId]);
      await client.query(`INSERT INTO copilot_quarantine_attempts(id,job_id,item_id,lease_owner,lease_version,correlation_id)
        VALUES(gen_random_uuid(),$1,$2,$3,$4,$5)`, [lease.jobId, item.id, lease.owner, lease.version, correlationId]);
      await insertAudit(client, { scope: lease.scope, actor: actorFromJob(job), jobId: job.id, itemId: item.id, correlationId,
        action: job.action, phase: "started", target: targetFromItem(item), requestedState: item.requested_state });
      return { job, item: { ...item, status: "running" as const, correlation_id: correlationId } };
    });
  }

  async assertDispatchReady(lease: QuarantineLease, item: QuarantineItemRow, authority: QuarantineAuthority) {
    const client = await this.database.connect();
    try {
      const job = await this.fence(client, lease);
      await this.requireCurrentInventoryTarget(client, lease.scope, item, job.is_canary);
      await this.requireCurrentDispatchAuthority(client, job, item, authority);
      await this.requireNoUnresolvedTarget(client, lease.scope.tenantId, item);
    } finally {
      client.release();
    }
  }

  async assertReconciliationTarget(scope: QuarantineScope, item: QuarantineItemRow, isCanary: boolean) {
    validateScope(scope);
    const client = await this.database.connect();
    try {
      await this.requireCurrentInventoryTarget(client, scope, item, isCanary);
    } finally {
      client.release();
    }
  }

  async withTargetLock<T>(lease: QuarantineLease, item: QuarantineItemRow, operation: () => Promise<T>) {
    const client = await this.database.connect();
    try {
      await client.query("SELECT pg_advisory_lock(hashtextextended($1,0))", [`quarantine-target:${lease.scope.tenantId}:${item.environment_id}:${item.bot_id}`]);
      await this.fence(client, lease);
      return await operation();
    } finally {
      await client.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [`quarantine-target:${lease.scope.tenantId}:${item.environment_id}:${item.bot_id}`]).catch(() => undefined);
      client.release();
    }
  }

  async markSent(lease: QuarantineLease, item: QuarantineItemRow, authority: QuarantineAuthority) {
    await transaction(this.database, async client => {
      const job = await this.fence(client, lease);
      await this.requireCurrentInventoryTarget(client, lease.scope, item, job.is_canary);
      await this.requireCurrentDispatchAuthority(client, job, item, authority);
      await this.requireNoUnresolvedTarget(client, lease.scope.tenantId, item);
      const result = await client.query("UPDATE copilot_quarantine_job_items SET sent_at=clock_timestamp() WHERE id=$1 AND job_id=$2 AND status='running' AND sent_at IS NULL", [item.id, lease.jobId]);
      if (result.rowCount !== 1) throw new AppError(409, "already_dispatched", "A quarantine mutation must never be dispatched twice.");
      await client.query("UPDATE copilot_quarantine_attempts SET sent_at=clock_timestamp() WHERE item_id=$1 AND lease_version=$2", [item.id, lease.version]);
      await insertAudit(client, { scope: lease.scope, actor: actorFromJob(job), jobId: job.id, itemId: item.id, correlationId: item.correlation_id!,
        action: job.action, phase: "sent", target: targetFromItem(item), requestedState: item.requested_state,
        message: "The one permitted provider POST is marked sent; HTTP acceptance is not success." });
    });
  }

  async finishItem(lease: QuarantineLease, item: QuarantineItemRow, outcome: Exclude<QuarantineItemStatus, "queued" | "running">, evidence: {
    observed?: CopilotStudioQuarantineStatus; readbackCount?: number; errorCode?: string; message?: string;
  } = {}) {
    await transaction(this.database, async client => {
      const job = await this.fence(client, lease);
      const result = await client.query(`UPDATE copilot_quarantine_job_items SET status=$3,observed_state=$4,observed_provider_updated_at=$5,observed_at=$6,
        readback_count=$7,reconciliation_status=CASE WHEN $3='inconclusive' THEN 'required' ELSE 'not_required' END,error_code=$8,message=$9,updated_at=clock_timestamp()
        WHERE id=$1 AND job_id=$2 AND status='running' RETURNING id`, [item.id, lease.jobId, outcome, evidence.observed?.isBotQuarantined ?? null,
        evidence.observed?.lastUpdateTimeUtc ?? null, evidence.observed?.observedAt ?? null, Math.min(evidence.readbackCount ?? 0, 20), safeCode(evidence.errorCode), evidence.message?.slice(0, 1024) ?? null]);
      if (result.rowCount !== 1) throw new AppError(409, "terminal_item", "Terminal quarantine results cannot be overwritten.");
      await client.query("UPDATE copilot_quarantine_attempts SET finished_at=clock_timestamp(),outcome=$3 WHERE item_id=$1 AND lease_version=$2", [item.id, lease.version, outcome]);
      if (evidence.observed) await insertObservation(client, lease.scope, targetFromItem(item), evidence.observed);
      await insertAudit(client, { scope: lease.scope, actor: actorFromJob(job), jobId: job.id, itemId: item.id, correlationId: item.correlation_id!, action: job.action,
        phase: outcome === "succeeded" ? "succeeded" : outcome === "skipped" ? "skipped" : outcome === "inconclusive" ? "inconclusive" : outcome === "cancelled" ? "failed" : "failed",
        target: targetFromItem(item), requestedState: item.requested_state, observed: evidence.observed, errorCode: evidence.errorCode, message: evidence.message });
    });
  }

  async release(lease: QuarantineLease) {
    await transaction(this.database, async client => {
      await this.fence(client, lease);
      const running = await client.query("SELECT 1 FROM copilot_quarantine_job_items WHERE job_id=$1 AND status='running'", [lease.jobId]);
      if (!running.rowCount) await this.aggregate(client, lease.jobId);
      await client.query("UPDATE copilot_quarantine_jobs SET lease_owner=NULL,lease_until=NULL,updated_at=clock_timestamp() WHERE id=$1", [lease.jobId]);
    });
  }

  async pauseItemForAuthorization(lease: QuarantineLease, item: QuarantineItemRow) {
    await transaction(this.database, async client => {
      await this.fence(client, lease);
      const result = await client.query("UPDATE copilot_quarantine_job_items SET status='queued',correlation_id=NULL,updated_at=clock_timestamp() WHERE id=$1 AND sent_at IS NULL AND status='running'", [item.id]);
      if (result.rowCount !== 1) throw new AppError(409, "already_dispatched", "Sent quarantine work cannot return to authorization wait.");
      await client.query("UPDATE copilot_quarantine_attempts SET finished_at=clock_timestamp(),outcome='cancelled' WHERE item_id=$1 AND lease_version=$2", [item.id, lease.version]);
      await client.query("UPDATE copilot_quarantine_jobs SET status='waiting_authorization',lease_owner=NULL,lease_until=NULL,updated_at=clock_timestamp() WHERE id=$1", [lease.jobId]);
    });
  }

  async waitForAuthorization(scope: QuarantineScope, id?: string) {
    await this.database.query(`UPDATE copilot_quarantine_jobs SET status='waiting_authorization',lease_owner=NULL,lease_until=NULL,updated_at=clock_timestamp()
      WHERE tenant_id=$1 AND principal_id=$2 AND ($3::uuid IS NULL OR id=$3) AND status IN ('queued','running')
        AND NOT EXISTS(SELECT 1 FROM copilot_quarantine_job_items WHERE job_id=copilot_quarantine_jobs.id AND status='running' AND sent_at IS NOT NULL)`,
    [scope.tenantId, scope.principalId, id ?? null]);
  }

  async withReconciliationLock<T>(scope: QuarantineScope, item: QuarantineItemRow, operation: () => Promise<T>) {
    const client = await this.database.connect();
    try {
      await client.query("SELECT pg_advisory_lock(hashtextextended($1,0))", [`quarantine-target:${scope.tenantId}:${item.environment_id}:${item.bot_id}`]);
      return await operation();
    } finally {
      await client.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [`quarantine-target:${scope.tenantId}:${item.environment_id}:${item.bot_id}`]).catch(() => undefined);
      client.release();
    }
  }

  async reconciliationItems(scope: QuarantineScope, id: string) {
    const job = await this.database.query<QuarantineJobRow>("SELECT * FROM copilot_quarantine_jobs WHERE id=$1 AND tenant_id=$2 AND principal_id=$3 AND expires_at>clock_timestamp()", [id, scope.tenantId, scope.principalId]);
    if (!job.rows[0]) return undefined;
    const items = await this.database.query<QuarantineItemRow>(`SELECT * FROM copilot_quarantine_job_items WHERE job_id=$1 AND status='inconclusive' AND reconciliation_status='required' ORDER BY ordinal`, [id]);
    return { job: job.rows[0], items: items.rows };
  }

  async recordReconciliation(scope: QuarantineScope, job: QuarantineJobRow, item: QuarantineItemRow, status: Exclude<QuarantineReconciliationStatus, "not_required" | "required">, observed: CopilotStudioQuarantineStatus, message: string) {
    await transaction(this.database, async client => {
      const result = await client.query(`UPDATE copilot_quarantine_job_items SET status=CASE WHEN $2='verified_applied' THEN 'succeeded' ELSE status END,
        observed_state=$3,observed_provider_updated_at=$4,observed_at=$5,reconciliation_status=$2,reconciled_at=clock_timestamp(),message=$6,updated_at=clock_timestamp()
        WHERE id=$1 AND status='inconclusive' AND reconciliation_status='required' RETURNING id`, [item.id, status, observed.isBotQuarantined,
        observed.lastUpdateTimeUtc, observed.observedAt, message.slice(0, 1024)]);
      if (result.rowCount !== 1) throw new AppError(409, "reconciliation_state", "The quarantine item no longer requires reconciliation.");
      await insertObservation(client, scope, targetFromItem(item), observed);
      await insertAudit(client, { scope, actor: actorFromJob(job), jobId: job.id, itemId: item.id, correlationId: observed.correlationId, action: "reconcile",
        phase: "reconciled", target: targetFromItem(item), requestedState: item.requested_state, observed, message });
      await this.aggregate(client, job.id);
    });
  }

  async recoverInterrupted(processStart = false) {
    return transaction(this.database, async client => {
      const jobs = await client.query<QuarantineJobRow>(`SELECT * FROM copilot_quarantine_jobs WHERE status='running'
        AND ($1::boolean OR lease_until IS NULL OR lease_until<clock_timestamp())
        ORDER BY updated_at,id LIMIT 1000 FOR UPDATE SKIP LOCKED`, [processStart]);
      for (const job of jobs.rows) {
        const items = await client.query<QuarantineItemRow>("SELECT * FROM copilot_quarantine_job_items WHERE job_id=$1 AND status='running'", [job.id]);
        for (const item of items.rows) {
          await client.query(`UPDATE copilot_quarantine_job_items SET status=CASE WHEN sent_at IS NULL THEN 'queued' ELSE 'inconclusive' END,
            reconciliation_status=CASE WHEN sent_at IS NULL THEN 'not_required' ELSE 'required' END,updated_at=clock_timestamp() WHERE id=$1`, [item.id]);
          await client.query("UPDATE copilot_quarantine_attempts SET finished_at=clock_timestamp(),outcome=CASE WHEN sent_at IS NULL THEN 'cancelled' ELSE 'inconclusive' END WHERE item_id=$1 AND finished_at IS NULL", [item.id]);
        }
        await this.aggregate(client, job.id);
        await client.query("UPDATE copilot_quarantine_jobs SET lease_owner=NULL,lease_until=NULL WHERE id=$1", [job.id]);
      }
      if (processStart) {
        await client.query(`UPDATE copilot_quarantine_jobs SET status='waiting_authorization',updated_at=clock_timestamp()
          WHERE status='queued' AND lease_owner IS NULL AND expires_at>clock_timestamp()`);
      }
      return jobs.rowCount ?? 0;
    });
  }

  private async fence(client: pg.PoolClient, lease: QuarantineLease) {
    const result = await client.query<QuarantineJobRow>(`SELECT * FROM copilot_quarantine_jobs WHERE id=$1 AND tenant_id=$2 AND principal_id=$3
      AND lease_owner=$4 AND lease_version=$5 AND lease_until>clock_timestamp() FOR UPDATE`, [lease.jobId, lease.scope.tenantId, lease.scope.principalId, lease.owner, lease.version]);
    if (!result.rows[0]) throw new AppError(409, "lease_lost", "Quarantine job lease expired or was replaced.");
    return result.rows[0];
  }

  private async aggregate(client: pg.PoolClient, id: string) {
    await client.query(`UPDATE copilot_quarantine_jobs SET status=CASE
      WHEN EXISTS(SELECT 1 FROM copilot_quarantine_job_items WHERE job_id=$1 AND status='inconclusive' AND reconciliation_status='required') THEN 'inconclusive'
      WHEN EXISTS(SELECT 1 FROM copilot_quarantine_job_items WHERE job_id=$1 AND status IN ('queued','running')) THEN 'waiting_authorization'
      WHEN cancel_requested OR EXISTS(SELECT 1 FROM copilot_quarantine_job_items WHERE job_id=$1 AND status='cancelled') THEN 'cancelled'
      WHEN NOT EXISTS(SELECT 1 FROM copilot_quarantine_job_items WHERE job_id=$1 AND status<>'failed') THEN 'failed'
      WHEN EXISTS(SELECT 1 FROM copilot_quarantine_job_items WHERE job_id=$1 AND status='failed') THEN 'partial'
      WHEN EXISTS(SELECT 1 FROM copilot_quarantine_job_items WHERE job_id=$1 AND status='inconclusive') THEN 'partial'
      ELSE 'succeeded' END,updated_at=clock_timestamp() WHERE id=$1`, [id]);
  }

  private async requireCurrentInventoryTarget(client: pg.PoolClient, scope: QuarantineScope, item: QuarantineItemRow, isCanary: boolean) {
    const rows = await client.query<{ environment_id: string; identifiers: Array<{ kind: string; value: string }> }>(`WITH selected_snapshot AS (
        SELECT id FROM power_platform_inventory_snapshots WHERE tenant_id=$1 AND principal_id=$2 AND is_current
          AND expires_at>clock_timestamp() AND observed_at>clock_timestamp()-interval '24 hours'
          AND requested_types ? 'microsoft.copilotstudio/agents' AND ($4::boolean OR id=$5)
        ORDER BY CASE WHEN environment_scope='' AND jsonb_array_length(requested_types)=11 THEN 1 ELSE 0 END DESC,observed_at DESC,id DESC LIMIT 1)
      SELECT resource.environment_id,resource.identifiers FROM power_platform_inventory_resources resource
      JOIN selected_snapshot snapshot ON snapshot.id=resource.snapshot_id
      WHERE resource.tenant_id=$1 AND resource.principal_id=$2 AND resource.resource_type='microsoft.copilotstudio/agents' AND resource.native_id=$3`,
    [scope.tenantId, scope.principalId, item.resource_native_id, isCanary, item.snapshot_id]);
    const matching = rows.rows.filter(row => {
      const environments = row.identifiers.filter(identifier => identifier.kind === "environment_id").map(identifier => identifier.value);
      const bots = row.identifiers.filter(identifier => identifier.kind === "cds_bot_id").map(identifier => identifier.value);
      return row.environment_id === item.environment_id && environments.length === 1 && environments[0] === item.environment_id
        && bots.length === 1 && bots[0] === item.bot_id;
    });
    if (matching.length !== 1 || rows.rowCount !== 1) {
      throw new AppError(409, rows.rowCount ? "quarantine_target_ambiguous" : "quarantine_target_unavailable",
        rows.rowCount ? "The current private inventory no longer resolves one exact quarantine target." : "The exact quarantine target is absent from current private inventory.");
    }
  }

  private async requireCurrentDispatchAuthority(client: pg.PoolClient, job: QuarantineJobRow, item: QuarantineItemRow, authority: QuarantineAuthority) {
    if (job.cancel_requested) throw new AppError(409, "cancelled", "The quarantine job was cancelled before provider dispatch.");
    if (job.contract_revision !== authority.contractRevision || job.permission_revision !== authority.permissionRevision
      || Number(job.configuration_revision) !== authority.configurationRevision) {
      throw new AppError(409, "quarantine_authority_changed", "Quarantine contract, permission, or configuration authority changed after confirmation.");
    }
    if (job.is_canary) {
      const approval = await client.query(`SELECT 1 FROM copilot_quarantine_canary_approvals WHERE id=$1 AND tenant_id=$2 AND status='claimed'
        AND actor_principal_id=$3 AND job_id=$4 AND approval_expires_at>clock_timestamp() AND environment_id=$5 AND bot_id=$6
        AND action=$7 AND prestate=$8 AND poststate=$9 AND contract_revision=$10 AND permission_revision=$11 AND configuration_revision=$12 AND auth_mode='delegated'`,
      [job.canary_approval_id, job.tenant_id, job.principal_id, job.id, item.environment_id, item.bot_id, job.action, item.prestate,
        item.requested_state, job.contract_revision, job.permission_revision, job.configuration_revision]);
      if (!approval.rowCount) throw new AppError(401, "qualification_invalidated", "The exact claimed quarantine canary approval is no longer current for dispatch.");
    }
  }

  private async requireNoUnresolvedTarget(client: pg.PoolClient, tenantId: string, item: QuarantineItemRow) {
    const unresolved = await client.query(`SELECT 1 FROM copilot_quarantine_job_items other JOIN copilot_quarantine_jobs job ON job.id=other.job_id
      WHERE job.tenant_id=$1 AND other.environment_id=$2 AND other.bot_id=$3 AND other.status='inconclusive'
        AND other.reconciliation_status='required' AND other.id<>$4 LIMIT 1`, [tenantId, item.environment_id, item.bot_id, item.id]);
    if (unresolved.rowCount) throw new AppError(409, "quarantine_reconciliation_required", "An uncertain write on this exact target must be reconciled before provider dispatch.");
  }
}

function projectStatus(target: InventoryQuarantineTarget, row: { is_bot_quarantined: boolean; provider_updated_at: string; observed_at: Date; correlation_id: string }): CopilotStudioQuarantineStatus {
  return { environmentId: target.environmentId, botId: target.botId, isBotQuarantined: row.is_bot_quarantined,
    lastUpdateTimeUtc: row.provider_updated_at, observedAt: row.observed_at.toISOString(), correlationId: row.correlation_id };
}

function projectJob(job: QuarantineJobRow, items: QuarantineItemRow[]): QuarantineJob {
  const results = items.map(item => ({ resourceNativeId: item.resource_native_id, displayName: item.display_name, environmentId: item.environment_id, botId: item.bot_id,
    status: item.status, requestedState: item.requested_state, observedState: item.observed_state,
    observedProviderUpdatedAt: item.observed_provider_updated_at, observedAt: item.observed_at?.toISOString() ?? null,
    correlationId: item.correlation_id, reconciliationStatus: item.reconciliation_status,
    retryEligible: item.status === "inconclusive" && item.reconciliation_status === "verified_not_applied",
    ...(item.error_code ? { errorCode: item.error_code } : {}), ...(item.message ? { message: item.message } : {}) }));
  const terminal = results.filter(item => !["queued", "running"].includes(item.status));
  return { id: job.id, action: job.action, status: job.status, confirmationHash: job.confirmation_hash, confirmation: job.confirmation_summary,
    isCanary: job.is_canary, total: items.length, completed: terminal.length, succeeded: terminal.filter(item => item.status === "succeeded").length,
    failed: terminal.filter(item => item.status === "failed").length, skipped: terminal.filter(item => item.status === "skipped").length,
    inconclusive: terminal.filter(item => item.status === "inconclusive").length, cancelled: terminal.filter(item => item.status === "cancelled").length,
    canResume: job.status === "waiting_authorization" && job.deadline_at.getTime() > Date.now() && job.attempts < 10 && items.some(item => item.status === "queued"),
    canReconcile: items.some(item => item.status === "inconclusive" && item.reconciliation_status === "required"),
    createdAt: job.created_at.toISOString(), updatedAt: job.updated_at.toISOString(), results };
}

async function insertObservation(client: pg.PoolClient, scope: QuarantineScope, target: InventoryQuarantineTarget, status: CopilotStudioQuarantineStatus) {
  await client.query(`INSERT INTO copilot_quarantine_status_observations
    (id,tenant_id,principal_id,resource_native_id,environment_id,bot_id,is_bot_quarantined,provider_updated_at,observed_at,correlation_id)
    VALUES(gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7,$8,$9)`, [scope.tenantId, scope.principalId, target.resourceNativeId, target.environmentId,
    target.botId, status.isBotQuarantined, status.lastUpdateTimeUtc, status.observedAt, status.correlationId]);
}

async function insertAudit(client: pg.PoolClient, value: { scope: QuarantineScope; actor: QuarantineActor; jobId: string; itemId?: string; correlationId?: string;
  action: QuarantineAction | "reconcile"; phase: string; target: InventoryQuarantineTarget; requestedState: boolean; observed?: CopilotStudioQuarantineStatus;
  errorCode?: string; message?: string }) {
  await client.query(`INSERT INTO copilot_quarantine_audit
    (id,tenant_id,principal_id,actor_username,actor_name,job_id,item_id,correlation_id,action,phase,resource_native_id,environment_id,bot_id,
     requested_state,observed_state,observed_provider_updated_at,error_code,message)
    VALUES(gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`, [value.scope.tenantId, value.scope.principalId,
    value.actor.username, value.actor.displayName, value.jobId, value.itemId ?? null, value.correlationId ?? null, value.action, value.phase,
    value.target.resourceNativeId, value.target.environmentId, value.target.botId, value.requestedState, value.observed?.isBotQuarantined ?? null,
    value.observed?.lastUpdateTimeUtc ?? null, safeCode(value.errorCode), value.message?.slice(0, 1024) ?? null]);
}

function actorFromJob(job: QuarantineJobRow): QuarantineActor {
  return { tenantId: job.tenant_id, homeAccountId: job.principal_id, displayName: job.actor_name, username: job.actor_username };
}

function targetFromItem(item: QuarantineItemRow): InventoryQuarantineTarget {
  return { resourceNativeId: item.resource_native_id, displayName: item.display_name, snapshotId: item.snapshot_id,
    inventoryObservedAt: item.inventory_observed_at.toISOString(), inventoryExpiresAt: item.inventory_observed_at.toISOString(),
    inventoryQuarantineState: null, inventoryQuarantinedAt: null, environmentId: item.environment_id, botId: item.bot_id };
}

function validateScope(scope: QuarantineScope) {
  if (!scope.tenantId || !scope.principalId) throw new AppError(403, "scope_mismatch", "Quarantine requires a tenant and current principal scope.");
}

function submissionIdentity(input: QuarantineJobInput): QuarantineSubmissionIdentity {
  return { action: input.action, snapshotId: input.targets[0]?.snapshotId ?? "", resourceNativeIds: input.targets.map(target => target.resourceNativeId),
    confirmationHash: input.confirmationHash, idempotencyKey: input.idempotencyKey };
}

function validateSubmissionIdentity(identity: QuarantineSubmissionIdentity) {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(identity.idempotencyKey)) throw new AppError(400, "invalid_idempotency_key", "Idempotency-Key must contain 1-128 letters, digits, underscores or hyphens.");
  if (identity.action !== "quarantine" && identity.action !== "unquarantine") throw new AppError(400, "invalid_quarantine_action", "Quarantine action must be quarantine or unquarantine.");
  if (!/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(identity.snapshotId) || !/^[a-f0-9]{64}$/.test(identity.confirmationHash)
    || !Array.isArray(identity.resourceNativeIds) || identity.resourceNativeIds.length < 1 || identity.resourceNativeIds.length > 25
    || identity.resourceNativeIds.some(value => typeof value !== "string" || !value || value.length > 512 || /[\r\n\0]/.test(value))) {
    throw new AppError(400, "invalid_quarantine_target", "The quarantine submission identity is invalid.");
  }
}

function requireMatchingSubmission(job: QuarantineJobRow, items: QuarantineItemRow[], identity: QuarantineSubmissionIdentity) {
  const expectedNativeIds = [...identity.resourceNativeIds].sort(ordinal);
  const actualNativeIds = items.map(item => item.resource_native_id).sort(ordinal);
  if (job.action !== identity.action || job.confirmation_hash !== identity.confirmationHash
    || items.some(item => item.snapshot_id !== identity.snapshotId) || expectedNativeIds.length !== actualNativeIds.length
    || expectedNativeIds.some((value, index) => value !== actualNativeIds[index])) {
    throw new AppError(409, "idempotency_mismatch", "This idempotency key already belongs to a different quarantine request.");
  }
}

function validateActorAndAuthority(actor: QuarantineActor, authority: QuarantineAuthority) {
  if (!actor.tenantId || !actor.homeAccountId || !actor.displayName || !actor.username || actor.displayName.length > 256 || actor.username.length > 256) throw new AppError(400, "invalid_actor", "Quarantine requires a bounded current actor.");
  if (!/^[a-f0-9]{64}$/.test(authority.contractRevision) || !/^[a-f0-9]{64}$/.test(authority.permissionRevision) || !Number.isSafeInteger(authority.configurationRevision) || authority.configurationRevision < 1) {
    throw new AppError(409, "invalid_quarantine_authority", "Quarantine authority revisions are invalid.");
  }
}

function validateFrozenTarget(target: FrozenQuarantineTarget) {
  if (target.directStatus.environmentId !== target.environmentId || target.directStatus.botId !== target.botId || !target.resourceNativeId || !target.snapshotId ||
      !target.displayName || target.displayName.length > 512 || Number.isNaN(Date.parse(target.inventoryObservedAt)) || Number.isNaN(Date.parse(target.directStatus.observedAt)) ||
      Number.isNaN(Date.parse(target.directStatus.lastUpdateTimeUtc))) throw new AppError(400, "invalid_quarantine_target", "Quarantine targets require exact inventory and direct provider status evidence.");
}

function safeCode(value: string | undefined) {
  return value && /^[a-z0-9_]{1,128}$/.test(value) ? value : null;
}

function hash(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function ordinal(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}