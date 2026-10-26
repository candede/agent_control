import { randomUUID } from "node:crypto";
import type pg from "pg";
import { AppError } from "../errors.js";
import { InventoryMutationStages } from "../db/inventoryMutationStages.js";
import { NativeInventory } from "../db/nativeInventory.js";
import { currentInventorySourcesSql } from "../db/inventoryAuthority.js";
import { selectedInventorySourcesSql } from "../db/inventorySelections.js";
import { digest, encodeBatch } from "../db/dataBounds.js";
import { beginAccountSessionValidation, assertAccountSessionValidation } from "../db/sessions.js";
import { reportIdentity } from "./reportIdentity.js";
import { capabilities } from "./capabilities.js";
import { copilotStudioQuarantineControl } from "./copilotStudioQuarantineControl.js";
import { initiatingOrigin, withAcceptedActionOrigin } from "./actionOrigin.js";
import { submitInventoryBlock } from "../routes/inventoryMutations.js";
import type { AuthenticatedUser } from "../types/session.js";
import type { AuditActor } from "../types/audit.js";
import type { AuditOriginV1 } from "../types/actionOrigin.js";
import type { AgentControlAction, AgentControlPreview, AgentControlExecution, AgentControlChild, AgentControlEligibility } from "../types/agentControls.js";
import { normalizePackageAuthoringTool, type CopilotPackageDetail } from "../types/copilotPackage.js";
import type { PowerPlatformResource } from "../types/powerPlatformInventory.js";
import type { SelectionIdentity } from "./dataSelections.js";
import { requireProviderAdmissions } from "./operationalState.js";
import { JobRepository } from "../db/jobs.js";
import { copilotStudioQuarantineJobs } from "./copilotStudioQuarantineJobs.js";

type Binding = { agent_id: string; source_scope_id: string;
  source_generation_id: string; source_identity: string; native_id: string; environment_id: string;
  control_revision: string; snapshot_id: string; authority_expires_at: Date } & (
    { source: "graph_packages"; residual: CopilotPackageDetail }
    | { source: "power_platform"; residual: PowerPlatformResource });
type ChildIntent =
  | { provider: "graph_packages"; recordIds: string[]; ids: string[]; confirmationHash: string }
  | { provider: "power_platform"; recordIds: string[]; resourceNativeIds: string[]; snapshotId: string; confirmationHash: string };
type Receipt = { preview: AgentControlPreview; bindingHash: string; children: ChildIntent[] };
type ReceiptRow = { id: string; authorization_hash: string; session_epoch: string; receipt: Receipt; confirmation_hash: string;
  expires_at: Date; idempotency_key: string | null; initiating_actor: AuditActor & { tenantId: string } | null;
  origin: AuditOriginV1 | null; accepted_at: Date | null };
type AcceptedReceipt = ReceiptRow & { accepted_at: Date; origin: AuditOriginV1 };
type ChildJob = Awaited<ReturnType<typeof submitInventoryBlock>> | Awaited<ReturnType<typeof copilotStudioQuarantineControl.submit>>;
const requestPath = "/api/agent-controls/execute";

// Only provider routing and durable acceptance live here. Existing child repositories own all outcomes.
export class AgentControls {
  readonly stages: InventoryMutationStages;
  readonly native: NativeInventory;
  constructor(readonly database: pg.Pool) {
    this.stages = new InventoryMutationStages(database);
    this.native = new NativeInventory(database);
  }
  async preview(user: AuthenticatedUser, selectionId: string, recordIds: string[], action: AgentControlAction): Promise<AgentControlPreview> {
    requireProviderAdmissions();
    const validation = beginAccountSessionValidation(user.tenantId!, user.homeAccountId);
    const identity = await reportIdentity(this.database, user);
    const rows = await this.bindings(identity, selectionId, recordIds);
    const targets: AgentControlEligibility[] = [], children: ChildIntent[] = [];
    const packages: Extract<Binding, { source: "graph_packages" }>[] = [], studio: Extract<Binding, { source: "power_platform" }>[] = [];
    for (const recordId of recordIds) {
      const sources = rows.filter(row => `agent:${row.agent_id}` === recordId);
      const target: AgentControlEligibility = { recordId, displayName: sources[0]?.residual.displayName ?? null,
        eligible: false, reason: null, effects: [] };
      targets.push(target);
      if (recordId.startsWith("report:")) { target.reason = "report_only"; continue; }
      if (!sources.length) { target.reason = "incomplete_inventory"; continue; }
      if (new Set(sources.map(row => `${row.source}\0${row.native_id}\0${row.environment_id}`)).size !== sources.length) {
        target.reason = "ambiguous_identity"; continue;
      }
      const natives = sources.filter(row => row.source === "power_platform");
      const exactPackages = sources.filter(row => row.source === "graph_packages");
      if (natives.length) {
        if (natives.length !== 1) { target.reason = "ambiguous_identity"; continue; }
        const native = natives[0];
        if (native.residual.type !== "microsoft.copilotstudio/agents" || !["agent","copilot_studio_agent"].includes(native.residual.agentKind)) {
          target.reason = "unsupported_classic_bot"; continue;
        }
        try {
          await capabilities.requireAvailable("powerPlatform.quarantine.manage", user);
          await this.native.resolveQuarantineTargets(identity, native.snapshot_id, [native.native_id]);
          studio.push(native); target.eligible = true;
        } catch (error) { target.reason = eligibilityReason(error); }
      } else if (exactPackages.length) {
        if (exactPackages.some(row => !row.residual.authoringTool)) { target.reason = "missing_platform"; continue; }
        if (exactPackages.some(row => normalizePackageAuthoringTool(row.residual.authoringTool!) === "copilotstudio")) {
          target.reason = "missing_native_identity"; continue;
        }
        try {
          await capabilities.requireAvailable("graph.package.block.manage", user);
          if (exactPackages.some(row => typeof row.residual.isBlocked !== "boolean")) {
            target.reason = "unknown_prestate"; continue;
          }
          packages.push(...exactPackages); target.eligible = true;
        } catch (error) { target.reason = eligibilityReason(error); }
      } else target.reason = "unsupported_platform";
    }
    if (packages.length > 100 || studio.length > 100) throw new AppError(413, "control_target_limit", "Generic controls support at most 100 exact effects per provider.");
    if (packages.length) {
      const ids = packages.map(row => row.native_id).sort();
      if (new Set(ids).size !== ids.length) throw new AppError(409, "inventory_identity_ambiguous", "A package belongs to more than one selected agent.");
      const preview = await this.stages.preview(identity, selectionId, { actor: user, action, scope: "bulk", requestPath }, ids);
      const selected = targets.filter(target => target.eligible && packages.some(row => `agent:${row.agent_id}` === target.recordId));
      for (const target of selected) target.effects = packages.filter(row => `agent:${row.agent_id}` === target.recordId)
        .map(row => ({ provider: "graph_packages", action, id: row.native_id, displayName: row.residual.displayName,
          alreadyInState: row.residual.isBlocked === (action === "block") }));
      children.push({ provider: "graph_packages", recordIds: selected.map(target => target.recordId), ids, confirmationHash: preview.confirmationHash });
    }
    const snapshots = [...new Set(studio.map(row => row.snapshot_id))].sort();
    for (const snapshotId of snapshots) {
      const matching = studio.filter(row => row.snapshot_id === snapshotId).sort((a,b) => a.native_id.localeCompare(b.native_id));
      for (let offset = 0; offset < matching.length; offset += 25) {
        const chunk = matching.slice(offset, offset + 25), resourceNativeIds = chunk.map(row => row.native_id);
        const quarantineAction = action === "block" ? "quarantine" as const : "unquarantine" as const;
        let preview: Awaited<ReturnType<typeof copilotStudioQuarantineControl.preview>>;
        try {
          preview = await copilotStudioQuarantineControl.preview(user, { action: quarantineAction, snapshotId, resourceNativeIds, forceStatus: true });
        } catch (error) {
          const reason = eligibilityReason(error);
          for (const row of chunk) {
            const target = targets.find(value => value.recordId === `agent:${row.agent_id}`)!;
            target.eligible = false;
            target.reason = reason;
          }
          continue;
        }
        for (const row of chunk) {
          const target = targets.find(value => value.recordId === `agent:${row.agent_id}`)!;
          const observed = preview.statuses.find(value => value.target.resourceNativeId === row.native_id)!;
          target.effects = [{ provider: "power_platform", action: quarantineAction, id: row.native_id, displayName: observed.target.displayName,
            environmentId: observed.target.environmentId, botId: observed.target.botId,
            alreadyInState: observed.direct.isBotQuarantined === (action === "block") }];
        }
        children.push({ provider: "power_platform", recordIds: chunk.map(row => `agent:${row.agent_id}`), resourceNativeIds, snapshotId,
          confirmationHash: preview.confirmationHash });
      }
    }
    assertAccountSessionValidation(validation);
    const receiptId = randomUUID();
    const authorityExpiry = rows.length ? new Date(Math.min(...rows.map(row => row.authority_expires_at.getTime()))) : null;
    const expiresAt = (await this.database.query<{ expires_at: Date }>(`SELECT LEAST(expires_at,clock_timestamp()+interval '10 minutes',
        COALESCE($4::timestamptz,expires_at)) AS expires_at
      FROM data_read_selections WHERE id=$1 AND tenant_id=$2 AND principal_id=$3`, [selectionId, identity.tenantId, identity.principalId, authorityExpiry])).rows[0]?.expires_at;
    if (!expiresAt || expiresAt.getTime() <= Date.now()) throw new AppError(409, "selection_invalidated", "The reviewed inventory expired.");
    const preview: AgentControlPreview = { receiptId, confirmationHash: "", selectionId, action, expiresAt: expiresAt.toISOString(),
      targetCount: targets.length, eligibleCount: targets.filter(value => value.eligible).length,
      ineligibleCount: targets.filter(value => !value.eligible).length,
      alreadyInStateCount: targets.flatMap(value => value.effects).filter(value => value.alreadyInState).length, targets, providerAtomicity: false };
    const receipt: Receipt = { preview, bindingHash: digest(JSON.stringify(rows)), children };
    preview.confirmationHash = digest(JSON.stringify({ receiptId, identity: { ...identity }, receipt }));
    encodeBatch([], [receipt]);
    await this.stages.queries.withCurrentSelection(selectionId, identity, async client => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`agent-control-previews:${identity.tenantId}`]);
      const count = (await client.query(`SELECT count(*) FILTER (WHERE principal_id=$2)::int AS actor,
        count(*)::int AS tenant FROM agent_control_receipts
        WHERE tenant_id=$1 AND accepted_at IS NULL AND expires_at>clock_timestamp()`, [identity.tenantId, identity.principalId])).rows[0];
      if (count.actor >= 5 || count.tenant >= 40) throw new AppError(429, "mutation_preview_limit", "Too many unexpired control previews.");
      if (digest(JSON.stringify(await this.bindingsInRead(client, identity, selectionId, recordIds))) !== receipt.bindingHash) stale();
      await client.query(`INSERT INTO agent_control_receipts(id,tenant_id,principal_id,authorization_hash,session_epoch,selection_id,confirmation_hash,receipt,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [receiptId, identity.tenantId, identity.principalId, identity.authorizationHash,
        identity.sessionEpoch, selectionId, preview.confirmationHash, receipt, expiresAt]);
      assertAccountSessionValidation(validation);
    });
    assertAccountSessionValidation(validation);
    return preview;
  }

  async execute(user: AuthenticatedUser, receiptId: string, confirmationHash: string, idempotencyKey: string): Promise<AgentControlExecution> {
    requireProviderAdmissions();
    const validation = beginAccountSessionValidation(user.tenantId!, user.homeAccountId);
    const identity = await reportIdentity(this.database, user);
    assertAccountSessionValidation(validation);
    let row = (await this.database.query<ReceiptRow>(`SELECT * FROM agent_control_receipts
      WHERE id=$1 AND tenant_id=$2 AND principal_id=$3 AND retained_until>clock_timestamp()`,
    [receiptId, identity.tenantId, identity.principalId])).rows[0];
    if (!row || row.confirmation_hash !== confirmationHash) stale();
    if (row.authorization_hash !== identity.authorizationHash || row.session_epoch !== String(identity.sessionEpoch)) stale();
    if (row.accepted_at && row.idempotency_key !== idempotencyKey) throw new AppError(409, "idempotency_mismatch", "The receipt already belongs to another operation key.");
    if (!row.accepted_at) {
      if (row.expires_at.getTime() <= Date.now()) stale();
      const { preview, bindingHash, children } = row.receipt;
      if (digest(JSON.stringify(await this.bindings(identity, preview.selectionId, preview.targets.map(target => target.recordId)))) !== bindingHash) stale();
      for (const child of children) if (child.provider === "power_platform") {
        const current = await copilotStudioQuarantineControl.preview(user, { action: preview.action === "block" ? "quarantine" : "unquarantine",
          snapshotId: child.snapshotId, resourceNativeIds: child.resourceNativeIds, forceStatus: true });
        if (current.confirmationHash !== child.confirmationHash) stale();
      }
      row = await this.stages.queries.withCurrentSelection(preview.selectionId, identity, async client => {
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`agent-controls:${identity.tenantId}:${identity.principalId}`]);
        const duplicate = (await client.query(`SELECT id FROM agent_control_receipts
          WHERE tenant_id=$1 AND principal_id=$2 AND idempotency_key=$3`, [identity.tenantId, identity.principalId, idempotencyKey])).rows[0];
        if (duplicate && duplicate.id !== receiptId) throw new AppError(409, "idempotency_mismatch", "This key belongs to another receipt.");
        const current = (await client.query<ReceiptRow>("SELECT * FROM agent_control_receipts WHERE id=$1 FOR UPDATE", [receiptId])).rows[0];
        if (current.accepted_at) {
          if (current.idempotency_key !== idempotencyKey) throw new AppError(409, "idempotency_mismatch", "This receipt was already accepted.");
          return current;
        }
        if (current.expires_at.getTime() <= Date.now()
          || digest(JSON.stringify(await this.bindingsInRead(client, identity, preview.selectionId, preview.targets.map(target => target.recordId)))) !== bindingHash) stale();
        const actor = { tenantId: identity.tenantId, homeAccountId: identity.principalId, username: user.username, displayName: user.displayName };
        assertAccountSessionValidation(validation);
        return (await client.query<ReceiptRow>(`UPDATE agent_control_receipts SET accepted_at=clock_timestamp(),idempotency_key=$2,
          initiating_actor=$3,origin=$4 WHERE id=$1 RETURNING *`, [receiptId, idempotencyKey, actor, initiatingOrigin(actor)])).rows[0];
      });
    }
    assertAccountSessionValidation(validation);
    const accepted = row;
    if (!accepted.origin || !accepted.initiating_actor || !accepted.accepted_at) throw new Error("control_acceptance_missing");
    const children: AgentControlChild[] = [];
    for (const [index, child] of accepted.receipt.children.entries()) {
      const key = `agent-control-${receiptId}-${index}`;
      let job: ChildJob | undefined;
      let admissionError: string | null = null;
      try {
        assertAccountSessionValidation(validation);
        if (accepted.expires_at.getTime() <= Date.now()) {
          throw new AppError(409,"child_admission_expired","The accepted receipt can return retained children, but cannot admit new work after expiry.");
        }
        job = await withAcceptedActionOrigin(accepted.origin, accepted.initiating_actor, async () => {
          if (child.provider === "graph_packages") return submitInventoryBlock(this.database, user, {
            action: accepted.receipt.preview.action, selectionId: accepted.receipt.preview.selectionId,
            ids: child.ids, confirmationHash: child.confirmationHash, idempotencyKey: key });
          return copilotStudioQuarantineControl.submit(user, { action: accepted.receipt.preview.action === "block" ? "quarantine" : "unquarantine",
            snapshotId: child.snapshotId, resourceNativeIds: child.resourceNativeIds, confirmationHash: child.confirmationHash, idempotencyKey: key });
        });
      } catch (error) {
        if (!(error instanceof AppError)) throw error;
        admissionError = error.code;
        assertAccountSessionValidation(validation);
        job = await this.retainedChild(identity, accepted, child, key);
        if (job && admissionError === "child_admission_expired") admissionError = null;
      }
      children.push(this.childProjection(child,job,admissionError,accepted.expires_at));
    }
    assertAccountSessionValidation(validation);
    return this.executionProjection({...accepted,accepted_at:accepted.accepted_at,origin:accepted.origin},children);
  }

  async status(user: AuthenticatedUser, receiptId: string): Promise<AgentControlExecution> {
    const validation=beginAccountSessionValidation(user.tenantId!,user.homeAccountId);
    const identity=await reportIdentity(this.database,user);
    const accepted=(await this.database.query<ReceiptRow>(`SELECT * FROM agent_control_receipts
      WHERE id=$1 AND tenant_id=$2 AND principal_id=$3 AND accepted_at IS NOT NULL AND retained_until>clock_timestamp()`,
    [receiptId,identity.tenantId,identity.principalId])).rows[0];
    if (!accepted?.accepted_at || !accepted.origin) throw new AppError(404,"not_found","An accepted control receipt was not found.");
    const children: AgentControlChild[]=[];
    for (const [index,child] of accepted.receipt.children.entries()) {
      assertAccountSessionValidation(validation);
      const job=await this.retainedChild(identity,accepted,child,`agent-control-${receiptId}-${index}`);
      children.push(this.childProjection(child,job,job?null:accepted.expires_at.getTime()<=Date.now()?"child_admission_expired":"child_not_accepted",accepted.expires_at));
    }
    assertAccountSessionValidation(validation);
    return this.executionProjection({...accepted,accepted_at:accepted.accepted_at,origin:accepted.origin},children);
  }

  private retainedChild(identity: SelectionIdentity, accepted: ReceiptRow, child: ChildIntent, key: string) {
    return child.provider === "graph_packages"
      ? new JobRepository(this.database).getByIdempotency(identity,"graph.package.block.manage",key,{
        action:accepted.receipt.preview.action,scope:"bulk",requestPath,targetIds:child.ids})
      : copilotStudioQuarantineJobs.existingSubmission(identity,{
        action:accepted.receipt.preview.action==="block"?"quarantine":"unquarantine",snapshotId:child.snapshotId,
        resourceNativeIds:child.resourceNativeIds,confirmationHash:child.confirmationHash,idempotencyKey:key});
  }
  private childProjection(child: ChildIntent,job: ChildJob | undefined,errorCode: string | null,expiresAt: Date): AgentControlChild {
    const base={provider:child.provider,recordIds:child.recordIds};
    if (job) {
      const url=child.provider==="graph_packages"?`/api/agents/bulk-jobs/${job.id}`:`/api/quarantine/jobs/${job.id}`;
      const readbackUnknown=job.inconclusive>0&&("reconciliationRequired" in job?job.reconciliationRequired>0:job.canReconcile);
      return { ...base, accepted: true, jobId: job.id, status: job.status,
          final: !["queued","running","waiting_authorization"].includes(job.status),
          verified: job.status === "succeeded" && job.succeeded + job.skipped === job.total, errorCode,
          verification: readbackUnknown ? "readback_unknown" : job.status === "succeeded" ? "verified"
            : ["queued","running","waiting_authorization"].includes(job.status) ? "pending" : "unverified",
          statusUrl: url, itemsUrl: child.provider === "graph_packages" ? `${url}/items` : null,
          cancelUrl: `${url}/cancel`, resumeUrl: `${url}/resume`, reconcileUrl: `${url}/reconcile` };
    }
    return { ...base, accepted: false, jobId: null, status: null, final: expiresAt.getTime()<=Date.now(), verified: false,
      verification: "unverified", errorCode,statusUrl: null, itemsUrl: null, cancelUrl: null, resumeUrl: null, reconcileUrl: null };
  }
  private executionProjection(accepted: AcceptedReceipt,children: AgentControlChild[]): AgentControlExecution {
    const admitted = children.filter(child => child.accepted).length;
    return { receiptId:accepted.id, confirmationHash:accepted.confirmation_hash, accepted: true, acceptedAt: accepted.accepted_at.toISOString(), origin: accepted.origin,
      outcome: !children.length ? "ineligible" : !admitted ? "failed" : admitted < children.length || accepted.receipt.preview.ineligibleCount ? "partial" : "accepted",
      final: children.every(child => child.final), verified: children.length > 0 && children.every(child => child.verified),
      providerAtomicity: false, ineligibleCount: accepted.receipt.preview.ineligibleCount, children };
  }

  private bindings(identity: SelectionIdentity, selectionId: string, recordIds: string[]) {
    return this.stages.queries.withCurrentSelection(selectionId, identity,
      client => this.bindingsInRead(client, identity, selectionId, recordIds));
  }
  private async bindingsInRead(client: pg.PoolClient, identity: SelectionIdentity, selectionId: string, recordIds: string[]) {
    const canonical = recordIds.filter(id => id.startsWith("agent:"));
    if (canonical.length) await this.stages.queries.inCurrentSelection(client, selectionId, identity, async (_client, context) => {
      await this.stages.queries.resolveControlReferencesInRead(client, context, canonical);
    });
    const rows = (await client.query<Binding>(`WITH selected AS (
        ${selectedInventorySourcesSql("$1", "$2", "NULL", "$5")}
      ), live AS (${currentInventorySourcesSql})
      SELECT selected.*,root.generation_id AS snapshot_id,record.residual,live.authority_expires_at
      FROM selected JOIN inventory_records record
        ON record.generation_id=selected.source_generation_id AND record.identity=selected.source_identity
      JOIN inventory_roots current_root ON current_root.scope_id=selected.source_scope_id AND current_root.current
      JOIN inventory_revisions root ON root.scope_id=current_root.scope_id AND root.revision=current_root.revision
      JOIN live ON live.agent_id=selected.agent_id AND live.source_generation_id=selected.source_generation_id
        AND live.source_identity=selected.source_identity AND live.control_revision=selected.control_revision
      WHERE selected.agent_id=ANY($6::text[]) ORDER BY selected.agent_id COLLATE "C",selected.source,selected.source_identity COLLATE "C"
      LIMIT 201`, [identity.tenantId, identity.principalId, null, null, selectionId, canonical.map(id => id.slice(6))])).rows;
    if (rows.length > 200) throw new AppError(413, "control_target_limit", "Select fewer exact provider effects.");
    encodeBatch(rows);
    return rows;
  }
}
function stale(): never { throw new AppError(409, "confirmation_mismatch", "The exact control receipt expired or its selection, prestate, membership or authority changed. Preview again."); }
function eligibilityReason(error: unknown) {
  if (!(error instanceof AppError)) throw error;
  if (error.status === 401) throw error;
  if (error.status === 403) return "missing_permission";
  if (error.status === 409) return error.code;
  if (error.status === 502 || error.status === 503 || error.status === 504) return "provider_status_unavailable";
  throw error;
}
