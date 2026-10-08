import { randomUUID } from "node:crypto";
import type pg from "pg";
import { InventoryGenerations, inventoryAsOf } from "../db/inventoryGenerations.js";
import { lockDataScope, type BeginGeneration, type GenerationLease } from "../db/dataGenerations.js";
import { dataAdmissionError, dataLimitError, digest, encodeBatch } from "../db/dataBounds.js";
import { assignSurvivors, sourceKey } from "./inventorySurvivors.js";
import { inventoryLimits, type InventoryRoot } from "../types/inventoryRecords.js";
import type { CopilotPackageDetail } from "../types/copilotPackage.js";
import type { PowerPlatformResource } from "../types/powerPlatformInventory.js";
import { buildRecords } from "./inventoryComponent.js";
import { resolvePackageAgentLinks, withVerifiedControlIdentities } from "./packageAgentIdentity.js";
import { nativeInventoryKey, canonicalRecord } from "./inventoryRecordProjection.js";
import { storedInventoryRecord, storedInventoryRecords } from "./streamedInventory.js";
import { normalizeNativeIdentity } from "./inventoryIdentity.js";
import { inventoryNativeRootChoicesSql } from "../db/inventoryInputScopes.js";
import { pendingInventoryIdentityExpirySql } from "../db/inventoryIdentityExpiry.js";
import { projectPackageDetailAge } from "./packageDetailProjection.js";
import { inventoryReconciliationAdmissionSql } from "../db/inventoryReconciliationAdmissionSchema.js";

type CapturedRoot = InventoryRoot & { domain: string; expiresAt: string };
type PreviousRoot = { baseline_id: string; revision: string; nativeScopes: string[] };
type Component = {
  rows: NonNullable<Awaited<ReturnType<typeof storedInventoryRecord>>>[];
  previous: pg.QueryResultRow[];
};
export class InventoryReconciliation {
  readonly stages: InventoryGenerations;
  constructor(readonly database: pg.Pool) { this.stages = new InventoryGenerations(database); }

  private async admit(client: pg.PoolClient, tenantId: string, scopeId: string) {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`inventory-queue:${tenantId}`]);
    const count = (await client.query(inventoryReconciliationAdmissionSql,
    [tenantId, scopeId])).rows[0].count;
    if (count >= 20) throw dataAdmissionError("inventory_queue_admission");
  }

  async request(input: BeginGeneration, inputs: readonly InventoryRoot[]) {
    if (input.scope.source !== "inventory_canonical" || input.scope.tokenMode !== "delegated" || inputs.length > 16 || !inputs.length
      || new Set(inputs.map(root => root.scopeId)).size !== inputs.length) throw new Error("inventory_reconciliation_scope");
    if (input.deadlineAt.getTime() <= Date.now() || input.deadlineAt.getTime() - Date.now() > inventoryLimits.powerPlatformDeadlineMs) throw new Error("inventory_reconciliation_deadline");
    return this.stages.generations.connections.run(async client => {
      await client.query("SET LOCAL enable_seqscan=off; SET LOCAL jit=off");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`data-sync:${input.scope.tenantId}:${input.scope.principalId}`]);
      const s = input.scope;
      await client.query(`INSERT INTO data_scope_epochs(id,tenant_id,scope_kind,principal_id,token_mode,source,selector,session_epoch)
        VALUES($1,$2,'principal',$3,'delegated','inventory_canonical',$4,$5)
        ON CONFLICT(tenant_id,scope_kind,principal_id,token_mode,source,selector) DO NOTHING`,
      [randomUUID(), s.tenantId, s.principalId, s.selector, input.sessionEpoch]);
      const output = (await client.query(`SELECT id FROM data_scope_epochs WHERE tenant_id=$1 AND principal_id=$2
        AND token_mode='delegated' AND source='inventory_canonical' AND selector=$3`, [s.tenantId, s.principalId, s.selector])).rows[0].id;
      for (const scopeId of [output, ...inputs.map(root => root.scopeId)].sort()) await lockDataScope(client, scopeId, input.scope.tenantId);
      const captured: CapturedRoot[] = [];
      for (const root of [...inputs].sort((a, b) => a.scopeId.localeCompare(b.scopeId))) {
        const scope = await lockDataScope(client, root.scopeId, input.scope.tenantId);
        if (scope.principal_id !== input.scope.principalId || scope.token_mode !== "delegated" || scope.epoch !== root.epoch) throw new Error("inventory_input_fenced");
        const current = (await client.query(`SELECT r.domain,r.baseline_id,r.revision,g.expires_at FROM inventory_roots r
          JOIN inventory_revisions v ON v.scope_id=r.scope_id AND v.revision=r.revision JOIN data_generations g ON g.id=v.generation_id
          WHERE r.scope_id=$1 AND r.current AND g.scope_epoch=$2 AND g.session_epoch=$3
            AND g.state IN ('published','retired') AND g.validated`, [root.scopeId, root.epoch, input.sessionEpoch])).rows[0];
        if (!current || !["packages", "power_platform"].includes(current.domain)) throw new Error("inventory_input_fenced");
        captured.push({ ...root, tenantId: input.scope.tenantId, baselineId: current.baseline_id, revision: current.revision,
          domain: current.domain, expiresAt: current.expires_at.toISOString() });
      }
      const existing = (await client.query("SELECT * FROM inventory_reconciliation WHERE scope_id=$1", [output])).rows[0];
      const latest = (existing?.pending_inputs ?? (existing?.active_id ? existing.active_inputs : existing?.published_inputs)) as CapturedRoot[] | undefined;
      if (latest?.length === captured.length && captured.every(root => latest.some(old => old.scopeId === root.scopeId
        && old.baselineId === root.baselineId && old.revision === root.revision && old.epoch === root.epoch))) {
        const expired = !existing.active_id && !existing.pending_inputs
          && (await client.query(`SELECT EXISTS(${pendingInventoryIdentityExpirySql}) AS expired`, [output])).rows[0].expired;
        if (!expired) return { scopeId: output as string, active: existing.active_id as string | null, pendingSequence: existing.pending_sequence as string };
      }
      await this.admit(client, input.scope.tenantId, output);
      const state = (await client.query(`INSERT INTO inventory_reconciliation(scope_id,tenant_id,pending_inputs,pending_deadline,pending_sequence)
        VALUES($1,$2,$3::jsonb,$4,1) ON CONFLICT(scope_id) DO UPDATE SET pending_inputs=EXCLUDED.pending_inputs,
        pending_deadline=EXCLUDED.pending_deadline,pending_sequence=inventory_reconciliation.pending_sequence+1 RETURNING *`,
      [output, s.tenantId, JSON.stringify(captured), input.deadlineAt])).rows[0];
      for (const root of captured) {
        // Earlier pending sequences already own their changed keys. Re-copying
        // everything since the active vector makes sustained 20-key updates quadratic.
        const previous = latest?.find(old => old.scopeId === root.scopeId);
        await client.query(`INSERT INTO inventory_reconciliation_keys(scope_id,sequence,source_scope_id,identity)
          SELECT $1,$2,$3,identity FROM inventory_changes WHERE scope_id=$3
            AND revision>coalesce($4::bigint,(SELECT first_revision-1 FROM inventory_roots WHERE baseline_id=$6))
            AND revision<=$5 ON CONFLICT DO NOTHING`,
        [output, state.pending_sequence, root.scopeId, previous?.revision ?? null, root.revision, root.baselineId]);
      }
      await client.query(`INSERT INTO inventory_reconciliation_keys(scope_id,sequence,source_scope_id,identity)
        SELECT $1,$2,source_scope_id,source_identity FROM (${pendingInventoryIdentityExpirySql}) expired ON CONFLICT DO NOTHING`,
      [output, state.pending_sequence]);
      return { scopeId: output as string, active: state.active_id as string | null, pendingSequence: state.pending_sequence as string };
    });
  }

  async runNext(input: BeginGeneration, authorize: (signal: AbortSignal) => Promise<void>, signal?: AbortSignal) {
    const claim = await this.stages.generations.connections.run(async client => {
      await client.query("SET LOCAL enable_seqscan=off; SET LOCAL jit=off");
      const s = input.scope;
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`data-sync:${s.tenantId}:${s.principalId}`]);
      const scope = (await client.query(`SELECT id,epoch FROM data_scope_epochs WHERE tenant_id=$1 AND principal_id=$2
        AND source='inventory_canonical' AND selector=$3`, [s.tenantId, s.principalId, s.selector])).rows[0];
      if (!scope) return undefined;
      const state = (await client.query("SELECT * FROM inventory_reconciliation WHERE scope_id=$1", [scope.id])).rows[0];
      if (!state || state.active_id && state.active_until > new Date() && state.active_deadline > new Date()) return undefined;
      const roots = ((state.pending_inputs ?? (state.active_id ? state.active_inputs : state.published_inputs)) as CapturedRoot[] | null)?.map(root => ({ ...root }));
      if (!roots?.length) return undefined;
      for (const scopeId of [scope.id, ...roots.map(root => root.scopeId)].sort()) await lockDataScope(client, scopeId, s.tenantId);
      for (const root of roots) {
        const current = (await client.query(`SELECT r.baseline_id,r.revision,epoch.epoch,g.expires_at FROM inventory_roots r
          JOIN data_scope_epochs epoch ON epoch.id=r.scope_id JOIN inventory_revisions v ON v.scope_id=r.scope_id AND v.revision=r.revision
          JOIN data_generations g ON g.id=v.generation_id WHERE r.scope_id=$1 AND r.current AND epoch.tenant_id=$2
            AND epoch.principal_id=$3 AND epoch.token_mode='delegated' AND g.scope_epoch=epoch.epoch AND g.session_epoch=$4
            AND g.state IN ('published','retired') AND g.validated`, [root.scopeId, s.tenantId, s.principalId, input.sessionEpoch])).rows[0];
        if (!current) throw new Error("inventory_input_fenced");
        Object.assign(root, { baselineId: current.baseline_id, revision: current.revision, epoch: current.epoch, expiresAt: current.expires_at.toISOString() });
      }
      const prior = state.published_inputs as CapturedRoot[] | null;
      if (!state.pending_inputs && !state.active_id && prior && roots.every(root => prior.some(old => old.scopeId === root.scopeId
        && old.baselineId === root.baselineId && old.revision === root.revision && old.epoch === root.epoch))) return undefined;
      await this.admit(client, s.tenantId, scope.id);
      const sequence = !state.pending_inputs && !state.active_id ? (BigInt(state.pending_sequence) + 1n).toString() : state.pending_sequence as string;
      await client.query("UPDATE inventory_reconciliation SET pending_inputs=$2::jsonb,pending_sequence=$3,pending_deadline=$4 WHERE scope_id=$1",
        [scope.id, JSON.stringify(roots), sequence, input.deadlineAt]);
      for (const root of roots) await client.query(`INSERT INTO inventory_reconciliation_keys(scope_id,sequence,source_scope_id,identity)
        SELECT $1,$2,$3,identity FROM inventory_changes WHERE scope_id=$3 AND revision>$4 AND revision<=$5 ON CONFLICT DO NOTHING`,
      [scope.id, sequence, root.scopeId, prior?.find(old => old.scopeId === root.scopeId)?.revision ?? "0", root.revision]);
      if (state.active_id) await client.query("DELETE FROM inventory_worker_pins WHERE worker_id=$1", [state.active_id]);
      const job = randomUUID();
      await client.query(`UPDATE inventory_reconciliation SET active_id=$2,active_inputs=coalesce(pending_inputs,active_inputs),active_sequence=pending_sequence,
        active_epoch=$3,active_deadline=$4,active_until=clock_timestamp()+interval '60 seconds',status='running',pending_inputs=NULL WHERE scope_id=$1`, [scope.id, job, scope.epoch, input.deadlineAt]);
      for (const root of roots) await client.query(`INSERT INTO inventory_worker_pins(worker_id,scope_id,tenant_id,baseline_id,revision,epoch,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7)`, [job, root.scopeId, root.tenantId, root.baselineId, root.revision, root.epoch,
        input.deadlineAt]);
      const saved = (await client.query("SELECT * FROM inventory_roots WHERE scope_id=$1 AND current", [scope.id])).rows[0];
      const old: PreviousRoot | undefined = saved ? { ...saved,
        nativeScopes: (prior ?? []).filter(root => root.domain === "power_platform").map(root => root.scopeId) } : undefined;
      const broad = !old || !prior || prior.length !== roots.length
        || roots.some(root => !prior.some(value => value.scopeId === root.scopeId && value.baselineId === root.baselineId));
      const native = (await client.query(`WITH roots AS (
        SELECT "baselineId" AS baseline_id,revision FROM jsonb_to_recordset($1::jsonb) r("baselineId" uuid,revision bigint)
      ) ${inventoryNativeRootChoicesSql("roots")}`, [JSON.stringify(roots)])).rows
        .find(row => row.kind === "microsoft.copilotstudio/agents");
      return { job, scopeId: scope.id as string, sequence, afterSequence: state.published_sequence as string,
        inputRoots: roots, roots: roots.filter(root => root.domain === "packages" || root.scopeId === native?.scope_id), old, broad };
    });
    if (!claim) return null;
    try {
      return await this.stages.execute({ ...input, jobId: claim.job, jobKind: input.jobKind === "fixture" ? "fixture" : "derived" },
        { domain: "canonical", mode: claim.broad ? "baseline" : "delta", channel: "canonical" }, async (lease, abort) => {
          await this.seed(lease, claim);
          for (;;) {
            abort.throwIfAborted();
            if (await this.reconcileIsolated(lease, claim, input.observedAt)) continue;
            if (await this.reconcilePairs(lease, claim, input.observedAt)) continue;
            const component = await this.expand(lease, claim);
            if (!component) break;
            await this.reconcileComponent(lease, claim, component, input.observedAt);
          }
        }, { signal, authorize, validateInputs: async client => {
          await client.query("SET LOCAL enable_seqscan=off; SET LOCAL jit=off");
          await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`data-sync:${input.scope.tenantId}:${input.scope.principalId}`]);
          for (const scopeId of [claim.scopeId, ...claim.inputRoots.map(root => root.scopeId)].sort()) await lockDataScope(client, scopeId, input.scope.tenantId);
          if ((await client.query(`UPDATE inventory_reconciliation SET active_until=clock_timestamp()+interval '60 seconds'
            WHERE scope_id=$1 AND active_id=$2 AND active_until>clock_timestamp()`, [claim.scopeId, claim.job])).rowCount !== 1) throw new Error("inventory_reconciliation_fenced");
          for (const root of claim.inputRoots) {
            const scope = await lockDataScope(client, root.scopeId, root.tenantId);
            if (scope.epoch !== root.epoch || scope.session_epoch !== input.sessionEpoch) throw new Error("inventory_input_fenced");
            if ((await client.query(`SELECT 1 FROM inventory_worker_pins p JOIN inventory_roots r ON r.baseline_id=p.baseline_id
              WHERE p.worker_id=$1 AND p.scope_id=$2 AND p.expires_at>clock_timestamp() AND r.collected_before<=p.revision`,
            [claim.job, root.scopeId])).rowCount !== 1) throw new Error("inventory_input_fenced");
          }
        }, completeJob: async client => {
          const state = (await client.query(`UPDATE inventory_reconciliation SET active_id=NULL,active_deadline=NULL,active_until=NULL,
            published_sequence=active_sequence,published_inputs=active_inputs,
            status=CASE WHEN pending_inputs IS NULL THEN 'idle' ELSE 'catching_up' END
            WHERE scope_id=$1 AND active_id=$2 RETURNING status`, [claim.scopeId, claim.job])).rows[0];
          if (!state) throw new Error("inventory_reconciliation_fenced");
          await client.query("DELETE FROM inventory_worker_pins WHERE worker_id=$1", [claim.job]);
        } });
    } catch (error) {
      await this.stages.generations.connections.run(async client => {
        await client.query(`UPDATE inventory_reconciliation SET active_id=NULL,active_deadline=NULL,status='failed',
          pending_inputs=coalesce(pending_inputs,active_inputs) WHERE scope_id=$1 AND active_id=$2`, [claim.scopeId, claim.job]);
        await client.query("DELETE FROM inventory_worker_pins WHERE worker_id=$1", [claim.job]);
      });
      throw error;
    }
  }

  private async seed(lease: GenerationLease, claim: { job: string; scopeId: string; sequence: string; afterSequence: string; roots: CapturedRoot[]; broad: boolean }) {
    await this.stages.generations.connections.run(async client => {
      await this.stages.fence(client, lease);
      if (claim.broad) for (const root of claim.roots) {
        await client.query(`INSERT INTO inventory_frontier(worker_id,source_scope_id,identity)
          SELECT $3,scope_id,identity FROM inventory_memberships m WHERE ${inventoryAsOf()} ON CONFLICT DO NOTHING`, [root.baselineId, root.revision, claim.job]);
      } else {
        await client.query(`INSERT INTO inventory_frontier(worker_id,source_scope_id,identity)
          SELECT $1,source_scope_id,identity FROM inventory_reconciliation_keys WHERE scope_id=$2 AND sequence<=$3 AND sequence>$4 ON CONFLICT DO NOTHING`,
        [claim.job, claim.scopeId, claim.sequence, claim.afterSequence]);
      }
    });
  }

  private async expand(lease: GenerationLease, claim: { job: string; roots: CapturedRoot[]; old: PreviousRoot | undefined }) {
    let component: string | null = null;
    for (;;) {
      const step = await this.stages.generations.connections.run(async client => {
      await this.stages.fence(client, lease);
      await client.query("SELECT set_config('plan_cache_mode','force_custom_plan',true)");
      if (!component) {
      const seed = (await client.query(`SELECT source_scope_id,identity FROM inventory_frontier
        WHERE worker_id=$1 AND component IS NULL ORDER BY source_scope_id,identity LIMIT 1`, [claim.job])).rows[0];
      if (!seed) return null;
      component = digest(`${seed.source_scope_id}:${seed.identity}`);
      await client.query("UPDATE inventory_frontier SET component=$4 WHERE worker_id=$1 AND source_scope_id=$2 AND identity=$3",
        [claim.job, seed.source_scope_id, seed.identity, component]);
      }
      const roots = JSON.stringify(claim.roots);
        const next = (await client.query(`SELECT source_scope_id,identity FROM inventory_frontier
          WHERE worker_id=$1 AND component=$2 AND NOT expanded ORDER BY source_scope_id,identity LIMIT 1`, [claim.job, component])).rows[0];
        if (!next) return true;
        const joined = await client.query(`WITH roots AS (
            SELECT * FROM jsonb_to_recordset($4::jsonb) r("scopeId" uuid,"baselineId" uuid,revision bigint)),
          own AS (SELECT m.generation_id,m.identity FROM roots r JOIN inventory_memberships m ON m.scope_id=r."scopeId"
            AND m.baseline_id=r."baselineId" AND m.valid_from_revision<=r.revision AND (m.valid_to_revision IS NULL OR m.valid_to_revision>r.revision)
            WHERE r."scopeId"=$2 AND m.identity=$3),
          candidates AS (
            SELECT DISTINCT other.scope_id,other.identity FROM own JOIN inventory_facts f USING(generation_id,identity)
            JOIN inventory_facts other ON other.kind=f.kind AND other.value=f.value
            JOIN roots r ON r."scopeId"=other.scope_id
            JOIN inventory_memberships m ON m.baseline_id=r."baselineId" AND m.identity=other.identity AND m.generation_id=other.generation_id
              AND m.valid_from_revision<=r.revision AND (m.valid_to_revision IS NULL OR m.valid_to_revision>r.revision)
            WHERE f.kind LIKE 'match:%' AND other.kind LIKE 'match:%' LIMIT 10001)
          INSERT INTO inventory_candidate_edges(worker_id,left_scope,left_id,right_scope,right_id)
          SELECT $1,$2,$3,scope_id,identity FROM candidates ON CONFLICT DO NOTHING`, [claim.job, next.source_scope_id, next.identity, roots]);
        if ((joined.rowCount ?? 0) > inventoryLimits.candidateEdges) throw dataLimitError("inventory_dense_edges", inventoryLimits.candidateEdges, joined.rowCount!);
        const edges = (await client.query(`SELECT count(*)::int AS count FROM inventory_candidate_edges e
          JOIN inventory_frontier f ON f.worker_id=e.worker_id AND f.source_scope_id=e.left_scope AND f.identity=e.left_id
          WHERE e.worker_id=$1 AND f.component=$2`, [claim.job, component])).rows[0].count;
        if (edges > inventoryLimits.candidateEdges) throw dataLimitError("inventory_dense_edges", inventoryLimits.candidateEdges, edges);
        await client.query(`INSERT INTO inventory_frontier(worker_id,source_scope_id,identity,component)
          SELECT worker_id,right_scope,right_id,$4 FROM inventory_candidate_edges WHERE worker_id=$1 AND left_scope=$2 AND left_id=$3
          ON CONFLICT(worker_id,source_scope_id,identity) DO UPDATE SET component=coalesce(inventory_frontier.component,EXCLUDED.component)`,
        [claim.job, next.source_scope_id, next.identity, component]);
        if (claim.old) {
          await client.query(`INSERT INTO inventory_frontier(worker_id,source_scope_id,identity,component)
            SELECT $1,s.source_scope_id,s.source_identity,$6 FROM unified_agent_memberships old
            JOIN inventory_memberships m ON m.generation_id=old.generation_id AND m.identity=old.identity
            JOIN unified_agent_memberships s ON s.generation_id=old.generation_id AND s.identity=old.identity
            WHERE old.source_identity=$3 AND (old.source_scope_id=$2 OR old.source_scope_id=ANY($7::uuid[])
              AND EXISTS(SELECT 1 FROM jsonb_to_recordset($8::jsonb) root("scopeId" uuid,domain text)
                WHERE root."scopeId"=$2 AND root.domain='power_platform'))
              AND ${inventoryAsOf("m", "$4", "$5")}
            ON CONFLICT(worker_id,source_scope_id,identity) DO UPDATE SET component=coalesce(inventory_frontier.component,EXCLUDED.component)`,
          [claim.job, next.source_scope_id, next.identity, claim.old.baseline_id, claim.old.revision, component, claim.old.nativeScopes, roots]);
        }
        const count = (await client.query("SELECT count(*)::int AS count FROM inventory_frontier WHERE worker_id=$1 AND component=$2", [claim.job, component])).rows[0].count;
        if (count > inventoryLimits.componentRows) throw dataLimitError("inventory_dense_component", inventoryLimits.componentRows, count);
        await client.query("UPDATE inventory_frontier SET expanded=true WHERE worker_id=$1 AND source_scope_id=$2 AND identity=$3",
          [claim.job, next.source_scope_id, next.identity]);
        return false;
      });
      if (step === null) return null;
      if (step) return component;
      await new Promise<void>(resolve => setImmediate(resolve));
    }
  }

  private async reconcileComponent(lease: GenerationLease, claim: { job: string; roots: CapturedRoot[]; old: PreviousRoot | undefined },
    component: string, evaluatedAt: Date) {
    const loaded = await this.stages.generations.connections.run(async client => {
      await this.stages.fence(client, lease);
      const vertices = (await client.query(`SELECT f.source_scope_id,f.identity,m.generation_id FROM inventory_frontier f
        JOIN jsonb_to_recordset($3::jsonb) r("scopeId" uuid,"baselineId" uuid,revision bigint) ON r."scopeId"=f.source_scope_id
        JOIN inventory_memberships m ON m.baseline_id=r."baselineId" AND m.identity=f.identity
          AND m.valid_from_revision<=r.revision AND (m.valid_to_revision IS NULL OR m.valid_to_revision>r.revision)
        WHERE f.worker_id=$1 AND f.component=$2 ORDER BY f.source_scope_id,f.identity LIMIT 251`, [claim.job, component, JSON.stringify(claim.roots)])).rows;
      const rows = [];
      let bytes = 0;
      for (const vertex of vertices) {
        const row = await storedInventoryRecord(client, vertex.generation_id, vertex.identity, "canonical");
        if (!row) throw new Error("inventory_component_incomplete");
        bytes += row.bytes;
        if (bytes > 1_048_576) throw dataLimitError("inventory_component_bytes", 1_048_576, bytes);
        rows.push(row);
      }
      const previous = claim.old ? (await client.query(`SELECT DISTINCT s.identity AS agent_id,s.source_scope_id,s.source_identity,
        source.domain,source.native_id,source.environment_id,g.created_at FROM inventory_frontier f
        JOIN unified_agent_memberships s ON s.source_scope_id=f.source_scope_id AND s.source_identity=f.identity
        JOIN inventory_memberships m ON m.generation_id=s.generation_id AND m.identity=s.identity
        JOIN inventory_records source ON source.generation_id=s.source_generation_id AND source.identity=s.source_identity
        JOIN inventory_canonical_ids g ON g.id=s.identity::uuid
        WHERE f.worker_id=$1 AND f.component=$2 AND ${inventoryAsOf("m", "$3", "$4")}
        ORDER BY g.created_at,s.identity,source.domain,source.native_id LIMIT 251`, [claim.job, component, claim.old.baseline_id, claim.old.revision])).rows : [];
      if (previous.length > 250) throw dataLimitError("inventory_dense_component", 250, previous.length);
      return { rows, previous };
    });
    await this.publishComponents(lease, [loaded], evaluatedAt);
  }

  private async reconcileIsolated(lease: GenerationLease,
    claim: { job: string; roots: CapturedRoot[]; old: PreviousRoot | undefined }, evaluatedAt: Date) {
    const components = await this.stages.generations.connections.run(async client => {
      await this.stages.fence(client, lease);
      // Keep seed order: processing later isolated rows first would change oldest-ID merge survivors.
      const candidates = (await client.query(`WITH seeds AS MATERIALIZED (
          SELECT source_scope_id,identity,row_number() OVER(ORDER BY source_scope_id,identity) AS ordinal
          FROM inventory_frontier WHERE worker_id=$1 AND component IS NULL ORDER BY source_scope_id,identity LIMIT 100
        ), candidates AS (
        SELECT frontier.source_scope_id,frontier.identity,frontier.ordinal,m.generation_id,previous.agent_id
        FROM seeds frontier
        JOIN jsonb_to_recordset($2::jsonb) root("scopeId" uuid,"baselineId" uuid,revision bigint) ON root."scopeId"=frontier.source_scope_id
        CROSS JOIN LATERAL (SELECT generation_id,identity FROM inventory_memberships m
          WHERE m.baseline_id=root."baselineId" AND m.identity=frontier.identity
            AND m.valid_from_revision<=root.revision AND (m.valid_to_revision IS NULL OR m.valid_to_revision>root.revision)
          OFFSET 0) m
        CROSS JOIN LATERAL (SELECT domain,resource_type FROM inventory_records source
          WHERE source.generation_id=m.generation_id AND source.identity=m.identity OFFSET 0) source
        LEFT JOIN LATERAL (
          SELECT s.identity AS agent_id,s.generation_id,s.source_scope_id AS previous_scope,count(*) OVER() AS matches
          FROM (SELECT identity,generation_id,source_scope_id FROM unified_agent_memberships s
            WHERE s.source_identity=frontier.identity AND (s.source_scope_id=frontier.source_scope_id
              OR source.domain='power_platform' AND s.source_scope_id=ANY($5::uuid[])) OFFSET 0) s
          CROSS JOIN LATERAL (SELECT generation_id,identity FROM inventory_memberships prior
            WHERE prior.baseline_id=$3 AND prior.identity=s.identity AND prior.generation_id=s.generation_id
              AND prior.valid_from_revision<=$4 AND (prior.valid_to_revision IS NULL OR prior.valid_to_revision>$4)
            OFFSET 0) prior LIMIT 2
        ) previous ON true
        WHERE (source.domain='packages' OR source.domain='power_platform' AND source.resource_type='microsoft.copilotstudio/agents')
          AND NOT EXISTS(SELECT 1 FROM inventory_facts fact WHERE fact.generation_id=m.generation_id
            AND fact.identity=m.identity AND fact.kind LIKE 'match:%' AND fact.kind<>'match:native')
          AND (source.domain<>'power_platform' OR NOT EXISTS(
            SELECT 1 FROM jsonb_to_recordset($2::jsonb) other("scopeId" uuid,"baselineId" uuid,revision bigint)
            JOIN inventory_memberships sibling ON sibling.baseline_id=other."baselineId" AND sibling.identity=m.identity
              AND sibling.valid_from_revision<=other.revision AND (sibling.valid_to_revision IS NULL OR sibling.valid_to_revision>other.revision)
            WHERE other."scopeId"<>frontier.source_scope_id))
          AND coalesce(previous.matches,0)<=1
          AND NOT EXISTS(SELECT 1 FROM unified_agent_memberships sibling
            WHERE sibling.generation_id=previous.generation_id AND sibling.identity=previous.agent_id
              AND (sibling.source_scope_id<>previous.previous_scope OR sibling.source_identity<>frontier.identity))
        ), ordered AS (SELECT *,row_number() OVER(ORDER BY ordinal) AS included FROM candidates)
        SELECT source_scope_id,identity,generation_id,agent_id FROM ordered WHERE ordinal=included ORDER BY ordinal`,
      [claim.job, JSON.stringify(claim.roots), claim.old?.baseline_id ?? null, claim.old?.revision ?? null, claim.old?.nativeScopes ?? []])).rows;
      if (!candidates.length) return [];
      const rows = await storedInventoryRecords(client, candidates.map(candidate => ({
        generationId: candidate.generation_id, identity: candidate.identity,
      })), "canonical");
      if (!rows.length) throw new Error("inventory_component_incomplete");
      const result: Component[] = [];
      for (let index = 0; index < rows.length; index++) {
        const row = rows[index], candidate = candidates[index];
        if (row.identity !== candidate.identity || row.generation_id !== candidate.generation_id) throw new Error("inventory_component_incomplete");
        result.push({ rows: [row], previous: candidate.agent_id ? [{ agent_id: candidate.agent_id,
          domain: row.domain, native_id: row.native_id, environment_id: row.environment_id }] : [] });
      }
      return result;
    });
    if (!components.length) return 0;
    await this.publishComponents(lease, components, evaluatedAt);
    const batch = encodeBatch(components.map(component => ({
      scope: component.rows[0].scope_id, identity: component.rows[0].identity,
    })), [claim.job]);
    await this.stages.generations.connections.run(async client => {
      await this.stages.fence(client, lease);
      await client.query(`UPDATE inventory_frontier frontier SET expanded=true,
        component=md5('isolated:'||frontier.source_scope_id::text||frontier.identity)
        FROM jsonb_to_recordset($2::jsonb) source(scope uuid,identity text)
        WHERE frontier.worker_id=$1 AND frontier.source_scope_id=source.scope AND frontier.identity=source.identity`,
      [claim.job, batch.json]);
    });
    return components.length;
  }

  private async reconcilePairs(lease: GenerationLease,
    claim: { job: string; roots: CapturedRoot[]; old: PreviousRoot | undefined }, evaluatedAt: Date) {
    const loaded = await this.stages.generations.connections.run(async client => {
      await this.stages.fence(client, lease);
      await client.query("SELECT set_config('plan_cache_mode','force_custom_plan',true),set_config('jit','off',true)");
      // Cold statistics must not turn per-key match probes into whole partial-index scans.
      // Materialize one key's facts before filtering; retain parameterized scope/kind/value seeks.
      const candidates = (await client.query(`WITH roots AS MATERIALIZED (
          SELECT "scopeId" AS scope_id,"baselineId" AS baseline_id,revision,domain
          FROM jsonb_to_recordset($2::jsonb) r("scopeId" uuid,"baselineId" uuid,revision bigint,domain text)
        ), seeds AS MATERIALIZED (
          SELECT source_scope_id,identity,row_number() OVER(ORDER BY source_scope_id,identity) AS ordinal
          FROM inventory_frontier WHERE worker_id=$1 AND component IS NULL ORDER BY source_scope_id,identity LIMIT 50
        )
        SELECT seed.*,m.generation_id,adjacent.neighbors,
          CASE WHEN jsonb_array_length(adjacent.neighbors)=1 THEN EXISTS(
            WITH source_facts AS MATERIALIZED (
              SELECT kind,value FROM inventory_facts
              WHERE generation_id=(adjacent.neighbors->0->>'generation')::uuid
                AND identity=adjacent.neighbors->0->>'identity'
            )
            SELECT 1 FROM source_facts fact CROSS JOIN roots root
            CROSS JOIN LATERAL (
              SELECT scope_id,identity,generation_id FROM inventory_facts other
              WHERE other.scope_id=root.scope_id AND other.kind=fact.kind AND other.value=fact.value
                AND other.kind LIKE 'match:%' OFFSET 0
            ) other
            JOIN inventory_memberships member ON member.baseline_id=root.baseline_id AND member.identity=other.identity
              AND member.generation_id=other.generation_id AND member.valid_from_revision<=root.revision
              AND (member.valid_to_revision IS NULL OR member.valid_to_revision>root.revision)
            WHERE fact.kind LIKE 'match:%'
              AND NOT (other.scope_id=seed.source_scope_id AND other.identity=seed.identity)
              AND NOT (other.scope_id=(adjacent.neighbors->0->>'scope')::uuid AND other.identity=adjacent.neighbors->0->>'identity')
          ) ELSE true END AS external_edge,prior.members AS previous
        FROM seeds seed JOIN roots own ON own.scope_id=seed.source_scope_id
        JOIN inventory_memberships m ON m.baseline_id=own.baseline_id AND m.identity=seed.identity
          AND m.valid_from_revision<=own.revision AND (m.valid_to_revision IS NULL OR m.valid_to_revision>own.revision)
        CROSS JOIN LATERAL (
          WITH source_facts AS MATERIALIZED (
            SELECT kind,value FROM inventory_facts WHERE generation_id=m.generation_id AND identity=m.identity
          )
          SELECT coalesce(jsonb_agg(neighbor),'[]'::jsonb) AS neighbors FROM (
            SELECT DISTINCT other.scope_id AS scope,other.identity,other.generation_id AS generation
            FROM source_facts fact CROSS JOIN roots root
            CROSS JOIN LATERAL (
              SELECT scope_id,identity,generation_id FROM inventory_facts other
              WHERE other.scope_id=root.scope_id AND other.kind=fact.kind AND other.value=fact.value
                AND other.kind LIKE 'match:%' OFFSET 0
            ) other
            JOIN inventory_memberships member ON member.baseline_id=root.baseline_id AND member.identity=other.identity
              AND member.generation_id=other.generation_id AND member.valid_from_revision<=root.revision
              AND (member.valid_to_revision IS NULL OR member.valid_to_revision>root.revision)
            WHERE fact.kind LIKE 'match:%'
              AND NOT (other.scope_id=seed.source_scope_id AND other.identity=seed.identity)
            LIMIT 2
          ) neighbor
        ) adjacent
        CROSS JOIN LATERAL (
          SELECT coalesce(jsonb_agg(previous ORDER BY created_at,agent_id,domain,native_id),'[]'::jsonb) AS members FROM (
            SELECT DISTINCT sibling.identity AS agent_id,sibling.source_scope_id,sibling.source_identity,
              source.domain,source.native_id,source.environment_id,canonical.created_at
            FROM (VALUES(seed.source_scope_id,seed.identity),
              ((adjacent.neighbors->0->>'scope')::uuid,adjacent.neighbors->0->>'identity')) pair(scope_id,identity)
            JOIN unified_agent_memberships old ON old.source_identity=pair.identity AND (old.source_scope_id=pair.scope_id
              OR old.source_scope_id=ANY($5::uuid[]) AND EXISTS(SELECT 1 FROM roots WHERE scope_id=pair.scope_id AND domain='power_platform'))
            JOIN inventory_memberships membership ON membership.generation_id=old.generation_id AND membership.identity=old.identity
              AND membership.baseline_id=$3 AND membership.valid_from_revision<=$4
              AND (membership.valid_to_revision IS NULL OR membership.valid_to_revision>$4)
            JOIN unified_agent_memberships sibling ON sibling.generation_id=old.generation_id AND sibling.identity=old.identity
            JOIN inventory_records source ON source.generation_id=sibling.source_generation_id AND source.identity=sibling.source_identity
            JOIN inventory_canonical_ids canonical ON canonical.id=sibling.identity::uuid
            ORDER BY canonical.created_at,sibling.identity,source.domain,source.native_id LIMIT 3
          ) previous
        ) prior ORDER BY seed.ordinal`,
      [claim.job, JSON.stringify(claim.roots), claim.old?.baseline_id ?? null, claim.old?.revision ?? null, claim.old?.nativeScopes ?? []])).rows;
      encodeBatch(candidates);
      type Pair = { vertices: { scope: string; identity: string; generation: string }[]; previous: pg.QueryResultRow[] };
      let pairs: Pair[] = [];
      const seen = new Set<string>();
      for (let index = 0; index < candidates.length; index++) {
        const candidate = candidates[index];
        if (Number(candidate.ordinal) !== index + 1 || candidate.neighbors.length !== 1 || candidate.external_edge
          || candidate.previous.length > 2) break;
        const vertices = [{ scope: candidate.source_scope_id, identity: candidate.identity, generation: candidate.generation_id },
          ...candidate.neighbors] as Pair["vertices"];
        if (candidate.previous.some((row: pg.QueryResultRow) => !vertices.some(vertex =>
          vertex.scope === row.source_scope_id && vertex.identity === row.source_identity))) break;
        if (vertices.some(vertex => seen.has(`${vertex.scope}:${vertex.identity}`))) continue;
        for (const vertex of vertices) seen.add(`${vertex.scope}:${vertex.identity}`);
        pairs.push({ vertices, previous: candidate.previous });
      }
      while (pairs.length) {
        try {
          const rows = await storedInventoryRecords(client, pairs.flatMap(pair =>
            pair.vertices.map(vertex => ({ generationId: vertex.generation, identity: vertex.identity }))), "canonical");
          const byKey = new Map(rows.map(row => [`${row.scope_id}:${row.identity}`, row]));
          const components: Component[] = [];
          for (const pair of pairs) {
            const members = pair.vertices.map(vertex => byKey.get(`${vertex.scope}:${vertex.identity}`));
            if (members.some(member => !member)) break;
            components.push({ rows: members as Component["rows"], previous: pair.previous });
          }
          return components;
        } catch (error) {
          if (!(error instanceof Error) || error.message !== "inventory_record_work_bytes") throw error;
          pairs = pairs.slice(0, Math.floor(pairs.length / 2));
        }
      }
      return [];
    });
    if (!loaded.length) return 0;
    await this.publishComponents(lease, loaded, evaluatedAt);
    const batch = encodeBatch(loaded.flatMap(component => component.rows.map(row => ({
      scope: row.scope_id, identity: row.identity,
      component: digest(`pair:${component.rows[0].scope_id}:${component.rows[0].identity}`),
    }))), [claim.job]);
    await this.stages.generations.connections.run(async client => {
      await this.stages.fence(client, lease);
      await client.query(`INSERT INTO inventory_frontier(worker_id,source_scope_id,identity,component,expanded)
        SELECT $1,scope,identity,component,true FROM jsonb_to_recordset($2::jsonb) source(scope uuid,identity text,component text)
        ON CONFLICT(worker_id,source_scope_id,identity) DO UPDATE SET component=EXCLUDED.component,expanded=true`,
      [claim.job, batch.json]);
    });
    return loaded.length;
  }

  private async publishComponents(lease: GenerationLease, components: Component[], evaluatedAt: Date) {
    const output: ReturnType<typeof canonicalRecord>[] = [];
    const membershipRows: { canonical: string; scope: string; identity: string; generation: string; evidence: unknown[] }[] = [];
    const canonicalIds: string[] = [];
    for (const loaded of components) {
    const native = new Map<string, Component["rows"][number]>();
    for (const row of loaded.rows.filter(row => row.domain === "power_platform")) {
      const previous = native.get(row.identity);
      if (!previous || row.read_started_at > previous.read_started_at || row.read_started_at.getTime() === previous.read_started_at.getTime()
        && (row.observed_at > previous.observed_at || row.observed_at.getTime() === previous.observed_at.getTime() && row.scope_id < previous.scope_id)) {
        native.set(row.identity, row);
      }
    }
    const rows = [...loaded.rows.filter(row => row.domain === "packages"), ...native.values()];
    const packages = rows.filter(row => row.domain === "packages")
      .map(row => projectPackageDetailAge(row.value as CopilotPackageDetail, evaluatedAt.getTime()));
    const resources = rows.filter(row => row.domain === "power_platform" && row.resource_type === "microsoft.copilotstudio/agents").map(row => row.value as PowerPlatformResource);
    const links = resolvePackageAgentLinks(lease.tenantId, packages, resources);
    const observations = Object.fromEntries(rows.filter(row => row.domain === "packages" && row.catalog_observed_at).map(row => [
      row.native_id, { observedAt: row.catalog_observed_at.toISOString(), expiresAt: row.catalog_expires_at.toISOString(),
        identityDetails: row.detail_observed_at ? { observedAt: row.detail_observed_at.toISOString(), expiresAt: row.detail_expires_at.toISOString() } : null },
    ]));
    const records = buildRecords(packages, withVerifiedControlIdentities(resources, links, observations), links, null, null);
    const groups = records.map((record, index) => {
      const sources = [
        ...record.packages.map(value => ({ source: "graph_packages" as const, environment_id: "", native_id: value.id,
          normalized_environment_id: "", normalized_native_id: value.id, package_snapshot_id: null, power_platform_snapshot_id: null, matching_evidence: [] })),
        ...record.powerPlatformResource ? [{ source: "power_platform" as const, environment_id: record.powerPlatformResource.environmentId ?? "",
          native_id: record.powerPlatformResource.nativeId, normalized_environment_id: record.powerPlatformResource.environmentId?.toLowerCase() ?? "",
          normalized_native_id: normalizeNativeIdentity(record.powerPlatformResource.nativeId), package_snapshot_id: null, power_platform_snapshot_id: null, matching_evidence: [] }] : [],
      ].sort((a, b) => sourceKey(a).localeCompare(sourceKey(b)));
      return { index, record, sources, sortKey: JSON.stringify(sources.map(sourceKey)) };
    }).sort((a, b) => a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0);
    const previous = loaded.previous.map(row => ({ source: row.domain === "packages" ? "graph_packages" as const : "power_platform" as const,
      normalized_environment_id: row.domain === "packages" ? "" : row.environment_id?.toLowerCase() ?? "",
      normalized_native_id: row.domain === "packages" ? row.native_id : normalizeNativeIdentity(row.native_id), agent_id: row.agent_id }));
    const survivors = assignSurvivors(groups, previous, new Map(previous.map(row => [sourceKey(row), row.agent_id])));
    const kept = new Set<string>();
    for (const group of groups) {
      const id = survivors.get(group.index) ?? randomUUID();
      kept.add(id);
      canonicalIds.push(id);
      const record = canonicalRecord(id, group.record);
      const members = [
        ...group.record.packages.map(value => rows.find(row => row.domain === "packages" && row.native_id === value.id)!),
        ...group.record.powerPlatformResource ? [rows.find(row => row.domain === "power_platform" && row.identity === nativeInventoryKey(group.record.powerPlatformResource!))!] : [],
      ];
      record.observed_at = new Date(Math.max(...members.map(row => row.observed_at.getTime()))).toISOString();
      record.expires_at = new Date(Math.min(...members.map(row => row.expires_at.getTime()))).toISOString();
      output.push(record);
      membershipRows.push(...members.map(row => ({ canonical: id, scope: row.scope_id, identity: row.identity,
        generation: row.generation_id, evidence: group.record.identity.evidence })));
    }
    for (const id of new Set(loaded.previous.map(row => row.agent_id as string))) if (!kept.has(id)) {
      output.push({ identity: id, native_id: id, environment_id: null, display_name: id, sort_key: id,
        presence: null, link_state: null, availability: null, management: null,
        resource_type: null, publisher: null, modified_at: null, residual: {}, facts: [], deleted: true });
    }
    }
    await this.stages.generations.connections.run(async client => {
      await this.stages.fence(client, lease);
      encodeBatch([], [canonicalIds, lease.scopeId, lease.tenantId]);
      await client.query(`INSERT INTO inventory_canonical_ids(id,scope_id,tenant_id)
        SELECT unnest($1::uuid[]),$2,$3 ON CONFLICT DO NOTHING`, [canonicalIds, lease.scopeId, lease.tenantId]);
    });
    await this.stages.appendBounded(lease, output);
    for (let offset = 0; offset < membershipRows.length;) {
      const rows: typeof membershipRows = [];
      let bytes = 0;
      while (offset < membershipRows.length && rows.length < 100) {
        const size = Buffer.byteLength(JSON.stringify(membershipRows[offset]));
        if (rows.length && bytes + size > 524288) break;
        rows.push(membershipRows[offset++]); bytes += size;
      }
      const batch = encodeBatch(rows, [lease.id, lease.scopeId, lease.tenantId]);
      await this.stages.generations.connections.run(async client => {
        await this.stages.fence(client, lease);
        await client.query(`INSERT INTO unified_agent_memberships(generation_id,scope_id,tenant_id,identity,schema_version,
          source_scope_id,source_identity,source_generation_id,evidence)
          SELECT $1,$2,$3,canonical,1,scope,identity,generation,evidence FROM jsonb_to_recordset($4::jsonb)
          r(canonical text,scope uuid,identity text,generation uuid,evidence jsonb)`, [lease.id, lease.scopeId, lease.tenantId, batch.json]);
      });
    }
  }
}
