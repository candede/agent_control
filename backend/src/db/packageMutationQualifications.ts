import { randomUUID } from "node:crypto";
import type pg from "pg";
import { AppError } from "../errors.js";
import type { AuditAction } from "../types/audit.js";
import type { AuthenticatedUser } from "../types/session.js";
import { canonicalAccessEntities, packageMutationStatesEqual, type PackageMutationState } from "../services/packageMutationState.js";
import { pool, transaction } from "./pool.js";

export type QualificationInput = {
  targetId: string;
  action: AuditAction;
  contractRevision: string;
  configurationRevision: number;
  prestate: unknown;
  poststate: unknown;
};

export type QualificationIdentity = Pick<QualificationInput, "contractRevision" | "configurationRevision"> & { authMode: "delegated" };
export type QualificationCompletion = { status: "qualified" | "restoration_conflict" | "failed" | "inconclusive"; errorCode?: string; message?: string };
type RestorationCriteria = { requireCurrentEqualsPoststate: true; touchedFields: ["isBlocked" | "allowedUsersAndGroups" | "acquireUsersAndGroups"] };
type PreparedQualificationInput = Omit<QualificationInput, "prestate" | "poststate"> & { prestate: PackageMutationState; poststate: PackageMutationState };

type QualificationRow = {
  id: string;
  tenant_id: string;
  target_id: string;
  action: AuditAction;
  actor_principal_id: string | null;
  actor_name: string | null;
  approved_by: string;
  approved_by_principal_id: string | null;
  contract_revision: string;
  configuration_revision: number;
  auth_mode: "delegated";
  prestate: PackageMutationState;
  poststate: PackageMutationState;
  restoration_criteria: RestorationCriteria;
  status: "approved" | "restoring" | "qualified" | "restoration_conflict" | "failed" | "inconclusive" | "expired";
  workflow_version: 1 | 2 | 3;
  paired_qualification_id: string | null;
  job_id: string | null;
  cycle_stage: "original" | "restoration" | null;
  correlation_id: string | null;
  attempted_at: Date | null;
  error_code: string | null;
  message: string | null;
  qualified_at: Date;
  expires_at: Date;
  restored_at: Date | null;
};

export class PackageMutationQualificationRepository {
  constructor(private readonly database: pg.Pool = pool) {}

  async createApproved(user: AuthenticatedUser, input: QualificationInput) {
    requireQualificationAdministrator(user);
    const tenantId = requireTenant(user);
    const prepared = validateAndProjectInput(input);
    return transaction(this.database, async client => {
      const qualificationKey = JSON.stringify([tenantId, prepared.targetId, prepared.action, "delegated"]);
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [qualificationKey]);
      const active = await client.query(`SELECT 1 FROM package_mutation_qualifications
        WHERE tenant_id=$1 AND target_id=$2 AND action=$3 AND auth_mode='delegated' AND status='restoring' LIMIT 1`, [tenantId, prepared.targetId, prepared.action]);
      if (active.rowCount) throw new AppError(409, "restoration_in_progress", "This exact canary target already has an in-progress restoration attempt.");
      await client.query(`UPDATE package_mutation_qualifications SET status='expired'
        WHERE tenant_id=$1 AND target_id=$2 AND action=$3 AND auth_mode='delegated' AND status='approved'`, [tenantId, prepared.targetId, prepared.action]);
      const { rows } = await client.query<QualificationRow>(`INSERT INTO package_mutation_qualifications
        (id,tenant_id,target_id,target_type,action,approved_by,approved_by_principal_id,contract_revision,configuration_revision,auth_mode,prestate,poststate,restoration_criteria,status,expires_at,workflow_version)
        VALUES($1,$2,$3,'copilot_package',$4,$5,$6,$7,$8,'delegated',$9,$10,$11,'approved',clock_timestamp()+interval '30 minutes',3) RETURNING *`,
      [randomUUID(), tenantId, prepared.targetId, prepared.action, user.displayName.slice(0, 256), user.homeAccountId, prepared.contractRevision, prepared.configurationRevision, prepared.prestate, prepared.poststate, prepared.restorationCriteria]);
      return project(rows[0]);
    });
  }

  async getApproved(user: AuthenticatedUser, id: string) {
    requireQualificationOperator(user);
    const { rows } = await this.database.query<QualificationRow>(`SELECT * FROM package_mutation_qualifications
      WHERE id=$1 AND tenant_id=$2 AND workflow_version=3 AND status='approved' AND expires_at>clock_timestamp()`, [qualificationId(id), requireTenant(user)]);
    return rows[0] ? project(rows[0]) : undefined;
  }

  async claimCycle(user: AuthenticatedUser, originalId: string, restorationId: string, originalIdentity: QualificationIdentity, restorationIdentity: QualificationIdentity) {
    requireQualificationOperator(user);
    const tenantId = requireTenant(user);
    const result = await transaction(this.database, async client => {
      const ids = [qualificationId(originalId), qualificationId(restorationId)];
      if (ids[0] === ids[1]) return { kind: "mismatch" as const };
      const current = await client.query<QualificationRow>(`SELECT * FROM package_mutation_qualifications WHERE id=ANY($1::uuid[]) AND tenant_id=$2 ORDER BY id FOR UPDATE`, [ids, tenantId]);
      const original = current.rows.find(row => row.id === ids[0]);
      const restoration = current.rows.find(row => row.id === ids[1]);
      if (!original || !restoration || [original, restoration].some(row => row.workflow_version !== 3 || row.status !== "approved" || row.expires_at.getTime() <= Date.now())) return { kind: "missing" as const };
      if ([original, restoration].some(row => row.approved_by_principal_id === user.homeAccountId)) return { kind: "same_actor" as const };
      if (!identityMatches(original, originalIdentity) || !identityMatches(restoration, restorationIdentity)) {
        await client.query("UPDATE package_mutation_qualifications SET status='expired' WHERE id=ANY($1::uuid[])", [ids]);
        return { kind: "invalidated" as const };
      }
      if (!isExactInverse(original, restoration)) return { kind: "mismatch" as const };
      const claimed = await client.query<QualificationRow>(`UPDATE package_mutation_qualifications qualification SET
        status='restoring',actor_principal_id=$2,actor_name=$3,correlation_id=gen_random_uuid(),attempted_at=clock_timestamp(),expires_at=clock_timestamp()+interval '30 days',
        paired_qualification_id=CASE WHEN id=$4 THEN $5::uuid ELSE $4::uuid END,
        cycle_stage=CASE WHEN id=$4 THEN 'original' ELSE 'restoration' END
        WHERE id=ANY($1::uuid[]) AND status='approved' RETURNING *`,
      [ids, user.homeAccountId, user.displayName.slice(0, 256), ids[0], ids[1]]);
      if (claimed.rowCount !== 2) throw new AppError(409, "canary_cycle_state", "The canary approvals changed while the cycle was claimed.");
      return { kind: "claimed" as const, value: {
        original: project(claimed.rows.find(row => row.id === ids[0])!),
        restoration: project(claimed.rows.find(row => row.id === ids[1])!),
      } };
    });
    if (result.kind === "same_actor") throw new AppError(409, "separate_approval_required", "The canary cycle Operator must be different from both approving Administrators.");
    if (result.kind === "invalidated") throw new AppError(409, "qualification_invalidated", "The approved canary intent was invalidated by a contract, authentication mode, or configuration revision change.");
    if (result.kind === "mismatch") throw new AppError(409, "canary_cycle_mismatch", "The restoration approval must be the exact inverse action, target, and semantic state of the original approval.");
    if (result.kind === "missing") throw new AppError(409, "canary_cycle_not_approved", "Both canary directions require current, unused workflow-v3 approvals.");
    return result.value;
  }

  async recordCycleJob(user: AuthenticatedUser, id: string, jobId: string) {
    requireQualificationOperator(user);
    const tenantId = requireTenant(user);
    const result = await this.database.query<QualificationRow>(`UPDATE package_mutation_qualifications SET job_id=$4
      WHERE id=$1 AND tenant_id=$2 AND workflow_version=3 AND status='restoring' AND actor_principal_id=$3 AND job_id IS NULL RETURNING *`,
    [qualificationId(id), tenantId, user.homeAccountId, qualificationId(jobId)]);
    if (!result.rows[0]) throw new AppError(409, "canary_cycle_state", "The durable canary job could not be attached to its approval.");
    return project(result.rows[0]);
  }

  async authorizeCycleJob(user: AuthenticatedUser, id: string, jobId: string, identity: QualificationIdentity) {
    requireQualificationOperator(user);
    const { rows } = await this.database.query<QualificationRow>(`SELECT * FROM package_mutation_qualifications
      WHERE id=$1 AND tenant_id=$2 AND workflow_version=3 AND status='restoring' AND actor_principal_id=$3 AND job_id=$4 AND expires_at>clock_timestamp()`,
    [qualificationId(id), requireTenant(user), user.homeAccountId, qualificationId(jobId)]);
    if (!rows[0] || !identityMatches(rows[0], identity)) throw new AppError(401, "qualification_invalidated", "The exact canary approval is no longer current for this job.");
    return project(rows[0]);
  }

  async completeCycle(user: AuthenticatedUser, originalId: string, restorationId: string, completion: QualificationCompletion, originalIdentity?: QualificationIdentity, restorationIdentity?: QualificationIdentity) {
    requireQualificationOperator(user);
    const tenantId = requireTenant(user);
    return transaction(this.database, async client => {
      const ids = [qualificationId(originalId), qualificationId(restorationId)];
      const current = await client.query<QualificationRow>(`SELECT * FROM package_mutation_qualifications
        WHERE id=ANY($1::uuid[]) AND tenant_id=$2 AND workflow_version=3 AND status='restoring' AND actor_principal_id=$3 ORDER BY id FOR UPDATE`, [ids, tenantId, user.homeAccountId]);
      const original = current.rows.find(row => row.id === ids[0]);
      const restoration = current.rows.find(row => row.id === ids[1]);
      if (!original || !restoration || !isExactInverse(original, restoration)) throw new AppError(409, "canary_cycle_state", "The paired canary cycle cannot be completed from its current state.");
      if (completion.status === "qualified") {
        if (!originalIdentity || !restorationIdentity || !identityMatches(original, originalIdentity) || !identityMatches(restoration, restorationIdentity)) {
          throw new AppError(409, "qualification_invalidated", "The canary contract, authentication mode, or configuration changed before qualification publication.");
        }
        await requireVerifiedCycleJobs(client, original, restoration);
        for (const row of [original, restoration]) {
          const qualificationKey = JSON.stringify([tenantId, row.action, row.contract_revision, row.configuration_revision, row.auth_mode]);
          await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [qualificationKey]);
          await client.query(`UPDATE package_mutation_qualifications SET status='expired' WHERE tenant_id=$1 AND action=$2
            AND contract_revision=$3 AND configuration_revision=$4 AND auth_mode=$5 AND status='qualified' AND id<>ALL($6::uuid[])`,
          [tenantId, row.action, row.contract_revision, row.configuration_revision, row.auth_mode, ids]);
        }
      }
      const { rows } = await client.query<QualificationRow>(`UPDATE package_mutation_qualifications SET status=$4,error_code=$5,message=$6,
        restored_at=CASE WHEN $4='qualified' THEN clock_timestamp() ELSE NULL END,expires_at=clock_timestamp()+interval '30 days'
        WHERE id=ANY($1::uuid[]) AND tenant_id=$2 AND actor_principal_id=$3 AND status='restoring' RETURNING *`,
      [ids, tenantId, user.homeAccountId, completion.status, completion.status === "qualified" ? null : safeErrorCode(completion.errorCode), completion.status === "qualified" ? null : safeCompletionMessage(completion.status)]);
      if (rows.length !== 2) throw new AppError(409, "canary_cycle_state", "The paired canary cycle was not completed atomically.");
      return { original: project(rows.find(row => row.id === ids[0])!), restoration: project(rows.find(row => row.id === ids[1])!) };
    });
  }

  async recoverInterrupted(tenantId: string) {
    const result = await this.database.query(`UPDATE package_mutation_qualifications SET status='inconclusive',error_code='process_interrupted',
      message='The canary process ended before the full cycle was durably qualified; no provider write will be replayed.',expires_at=clock_timestamp()+interval '30 days'
      WHERE tenant_id=$1 AND workflow_version=3 AND status='restoring'`, [tenantId]);
    return result.rowCount ?? 0;
  }

  async current(tenantId: string, action: AuditAction, contractRevision: string, configurationRevision: number) {
    const { rows } = await this.database.query<QualificationRow>(`SELECT * FROM package_mutation_qualifications
      WHERE tenant_id=$1 AND action=$2 AND contract_revision=$3 AND configuration_revision=$4 AND auth_mode='delegated'
        AND workflow_version=3 AND status='qualified' AND restored_at IS NOT NULL AND job_id IS NOT NULL AND expires_at>clock_timestamp()
      ORDER BY qualified_at DESC,id DESC LIMIT 1`, [tenantId, action, contractRevision, configurationRevision]);
    return rows[0] ? project(rows[0]) : undefined;
  }

  async list(user: AuthenticatedUser, limit = 50) {
    requireQualificationAdministrator(user);
    const tenantId = requireTenant(user);
    const { rows } = await this.database.query<QualificationRow>(`SELECT * FROM package_mutation_qualifications WHERE tenant_id=$1
      ORDER BY qualified_at DESC,id DESC LIMIT $2`, [tenantId, Math.min(Math.max(Math.trunc(limit), 1), 100)]);
    return { value: rows.map(project) };
  }
}

export function assessCanaryRestoration(prestate: PackageMutationState, poststate: PackageMutationState, current: PackageMutationState) {
  if (packageMutationStatesEqual(current, prestate)) return { status: "already_restored" as const };
  if (!packageMutationStatesEqual(current, poststate)) return { status: "conflict" as const, message: "Current provider state differs from both canary poststate and original prestate; stop for operator review." };
  if (prestate.kind === "block" && poststate.kind === "block" && current.kind === "block") {
    return { status: "restore" as const, touchedFields: { isBlocked: prestate.isBlocked } };
  }
  if (prestate.kind === "access" && poststate.kind === "access" && current.kind === "access") {
    const availabilityChanged = prestate.availableTo !== poststate.availableTo || !sameJson(prestate.allowedUsersAndGroups, poststate.allowedUsersAndGroups);
    const installationChanged = prestate.deployedTo !== poststate.deployedTo || !sameJson(prestate.acquireUsersAndGroups, poststate.acquireUsersAndGroups);
    if (availabilityChanged === installationChanged) return { status: "conflict" as const, message: "A reversible access canary must touch exactly one access target." };
    return availabilityChanged
      ? { status: "restore" as const, touchedFields: { allowedUsersAndGroups: prestate.allowedUsersAndGroups }, preservedFields: { acquireUsersAndGroups: current.acquireUsersAndGroups } }
      : { status: "restore" as const, touchedFields: { acquireUsersAndGroups: prestate.acquireUsersAndGroups }, preservedFields: { allowedUsersAndGroups: current.allowedUsersAndGroups } };
  }
  return { status: "conflict" as const, message: "Canary state types do not match." };
}

function validateAndProjectInput(input: QualificationInput) {
  if (!input.targetId.trim() || input.targetId.length > 512 || !/^[a-f0-9]{64}$/.test(input.contractRevision) || !Number.isSafeInteger(input.configurationRevision) || input.configurationRevision < 1) {
    throw new AppError(400, "invalid_qualification", "Canary qualification target, contract, or configuration revision is invalid.");
  }
  const prestate = projectMutationState(input.prestate);
  const poststate = projectMutationState(input.poststate);
  const prepared = { ...input, targetId: input.targetId.trim(), prestate, poststate };
  const restoration = assessCanaryRestoration(prestate, poststate, poststate);
  const expectedTouchedField = expectedCanaryTouchedField(prepared);
  if (restoration.status !== "restore") throw new AppError(400, "invalid_qualification_state", "Qualification must prove one action-matched reversible transition.");
  return { ...prepared, restorationCriteria: { touchedFields: [expectedTouchedField], requireCurrentEqualsPoststate: true } as RestorationCriteria };
}

function expectedCanaryTouchedField(input: PreparedQualificationInput) {
  const { prestate, poststate } = input;
  if (input.action === "block" || input.action === "unblock") {
    if (prestate.kind !== "block" || poststate.kind !== "block" || prestate.isBlocked === poststate.isBlocked
      || poststate.isBlocked !== (input.action === "block")) return invalidCanaryAction();
    return "isBlocked";
  }
  if (input.action === "reassign" || prestate.kind !== "access" || poststate.kind !== "access") return invalidCanaryAction();
  const availabilityChanged = prestate.availableTo !== poststate.availableTo || !sameJson(prestate.allowedUsersAndGroups, poststate.allowedUsersAndGroups);
  const installationChanged = prestate.deployedTo !== poststate.deployedTo || !sameJson(prestate.acquireUsersAndGroups, poststate.acquireUsersAndGroups);
  if (input.action === "update-availability" && availabilityChanged && !installationChanged) return "allowedUsersAndGroups";
  if (input.action === "update-installation" && installationChanged && !availabilityChanged) return "acquireUsersAndGroups";
  return invalidCanaryAction();
}

function invalidCanaryAction(): never {
  throw new AppError(400, "invalid_qualification_state", "The canary transition does not match the qualified package action.");
}

function requireQualificationAdministrator(user: AuthenticatedUser) {
  if (!user.roles.includes("AgentControl.Administrator")) throw new AppError(403, "missing_internal_role", "AgentControl.Administrator is required to record or inspect mutation qualifications.");
}

function requireQualificationOperator(user: AuthenticatedUser) {
  if (!user.roles.includes("AgentControl.Operator")) throw new AppError(403, "missing_internal_role", "AgentControl.Operator is required to execute canary restoration.");
}

function requireTenant(user: AuthenticatedUser) {
  if (!user.tenantId) throw AppError.unauthorized("Qualification requires a tenant scope.");
  return user.tenantId;
}

function project(row: QualificationRow) {
  return { id: row.id, tenantId: row.tenant_id, targetId: row.target_id, action: row.action, actorPrincipalId: row.actor_principal_id, actorName: row.actor_name, approvedBy: row.approved_by, approvedByPrincipalId: row.approved_by_principal_id, contractRevision: row.contract_revision, configurationRevision: row.configuration_revision, authMode: row.auth_mode, prestate: projectMutationState(row.prestate), poststate: projectMutationState(row.poststate), restorationCriteria: row.restoration_criteria, status: row.status, workflowVersion: row.workflow_version, correlationId: row.correlation_id, pairedQualificationId: row.paired_qualification_id, jobId: row.job_id, cycleStage: row.cycle_stage, approvedAt: row.qualified_at.toISOString(), attemptedAt: row.attempted_at?.toISOString() ?? null, expiresAt: row.expires_at.toISOString(), restoredAt: row.restored_at?.toISOString() ?? null, errorCode: row.error_code, message: row.message };
}

function projectMutationState(value: unknown): PackageMutationState {
  const record = strictRecord(value);
  if (record.kind === "block") {
    exactKeys(record, ["kind", "isBlocked"]);
    if (typeof record.isBlocked !== "boolean") throw invalidState();
    return { kind: "block", isBlocked: record.isBlocked };
  }
  if (record.kind !== "access") throw invalidState();
  exactKeys(record, ["kind", "availableTo", "deployedTo", "allowedUsersAndGroups", "acquireUsersAndGroups"]);
  if (typeof record.availableTo !== "string" || typeof record.deployedTo !== "string"
    || !["all", "some", "none"].includes(record.availableTo) || !["all", "some", "none"].includes(record.deployedTo)) throw invalidState();
  return {
    kind: "access",
    availableTo: record.availableTo as "all" | "some" | "none",
    deployedTo: record.deployedTo as "all" | "some" | "none",
    allowedUsersAndGroups: projectPrincipals(record.allowedUsersAndGroups),
    acquireUsersAndGroups: projectPrincipals(record.acquireUsersAndGroups),
  };
}

function projectPrincipals(value: unknown) {
  if (!Array.isArray(value) || value.length > 500) throw invalidState();
  return canonicalAccessEntities(value.map(item => {
    const record = strictRecord(item);
    exactKeys(record, ["resourceType", "resourceId"]);
    if ((record.resourceType !== "user" && record.resourceType !== "group") || typeof record.resourceId !== "string" || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(record.resourceId)) throw invalidState();
    return { resourceType: record.resourceType, resourceId: record.resourceId };
  }));
}

function strictRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidState();
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: string[]) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) throw invalidState();
}

function invalidState(): never {
  throw new AppError(400, "invalid_qualification_state", "Canary states accept only the exact typed package fields required for restoration.");
}

function qualificationId(value: string) {
  if (!/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value)) throw new AppError(400, "invalid_qualification_id", "Canary qualification ID is invalid.");
  return value;
}

function safeErrorCode(value: string | undefined) {
  return value && /^[a-z0-9_]{1,128}$/.test(value) ? value : "restoration_failed";
}

function safeCompletionMessage(status: Exclude<QualificationCompletion["status"], "qualified">) {
  if (status === "inconclusive") return "The full canary cycle was not conclusively restored; no qualification was published and no write may be replayed.";
  if (status === "restoration_conflict") return "The original canary effect was observed, but exact restoration could not be verified after a state conflict.";
  return "The approved canary cycle stopped without publishing qualification.";
}

function identityMatches(row: QualificationRow, identity: QualificationIdentity) {
  return row.contract_revision === identity.contractRevision
    && row.configuration_revision === identity.configurationRevision
    && row.auth_mode === identity.authMode;
}

function isExactInverse(original: QualificationRow, restoration: QualificationRow) {
  return original.target_id === restoration.target_id
    && inverseAction(original.action) === restoration.action
    && packageMutationStatesEqual(original.prestate, restoration.poststate)
    && packageMutationStatesEqual(original.poststate, restoration.prestate);
}

function inverseAction(action: AuditAction): AuditAction | undefined {
  if (action === "block") return "unblock";
  if (action === "unblock") return "block";
  if (action === "update-availability") return "update-availability";
  if (action === "update-installation") return "update-installation";
  return undefined;
}

async function requireVerifiedCycleJobs(client: pg.PoolClient, original: QualificationRow, restoration: QualificationRow) {
  if (!original.job_id || !restoration.job_id) throw new AppError(409, "canary_cycle_unverified", "Both approved canary directions require durable jobs.");
  const jobs = await client.query<{ id: string; action: AuditAction; status: string; target_id: string; item_status: string; prestate: unknown; poststate: unknown }>(`SELECT job.id,job.action,job.status,item.target_id,item.status AS item_status,item.prestate,item.poststate
    FROM jobs job JOIN job_items item ON item.job_id=job.id
    WHERE job.id=ANY($1::uuid[]) AND job.tenant_id=$2 AND job.principal_id=$3`, [[original.job_id, restoration.job_id], original.tenant_id, original.actor_principal_id]);
  for (const row of [original, restoration]) {
    const job = jobs.rows.find(value => value.id === row.job_id);
    if (!job || job.action !== row.action || job.target_id !== row.target_id || job.status !== "succeeded" || job.item_status !== "succeeded"
      || !packageMutationStatesEqual(projectMutationState(job.prestate), row.prestate)
      || !packageMutationStatesEqual(projectMutationState(job.poststate), row.poststate)) {
      throw new AppError(409, "canary_cycle_unverified", "Durable provider readback does not prove both exact canary directions.");
    }
  }
}

function sameJson(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right);
}