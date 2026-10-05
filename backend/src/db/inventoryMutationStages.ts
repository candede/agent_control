import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";
import { AppError } from "../errors.js";
import { capturePackageMutationState, packageMutationStateHash } from "../services/packageMutationState.js";
import type { SelectionIdentity } from "../services/dataSelections.js";
import type { PackageAccessEntity } from "../types/copilotPackage.js";
import { createJobConfirmation, JobRepository, mutationRetryIntentHash, type JobIntentInput, type MutationConfirmationSummary } from "./jobs.js";
import { InventoryQueries } from "./inventoryQueries.js";
import { config } from "../config.js";
import { dataLimitError, encodeBatch } from "./dataBounds.js";
import { assertCurrentMutationTargets } from "./inventoryMutationAuthority.js";
import { currentInventorySourcesSql } from "./inventoryAuthority.js";

export type StagedMutationIntent = Omit<JobIntentInput, "targets">;
type TargetRow = { id: string; generation_id: string; source_identity: string; display_name: string };

export class InventoryMutationStages {
  readonly queries: InventoryQueries;
  constructor(readonly database: pg.Pool) {
    this.queries = new InventoryQueries(database, config.sessionSecret, config.officialUsageStaleDays, undefined,
      { source: "inventory_canonical", tokenMode: "delegated" });
  }
  async currentSelection(identity: SelectionIdentity) {
    const root = (await this.database.query(`SELECT id FROM data_scope_epochs WHERE tenant_id=$1 AND principal_id=$2
      AND source='inventory_canonical' AND token_mode='delegated' AND selector='complete'`,
    [identity.tenantId, identity.principalId])).rows[0];
    if (!root) throw new AppError(409, "inventory_unavailable", "Refresh inventory before preparing a mutation.");
    return (await this.queries.capture(identity, root.id)).id;
  }
  async count(identity: SelectionIdentity, selectionId: string, ids: readonly string[] | undefined, recordIds: readonly string[] | undefined) {
    validateTargets(ids, recordIds);
    if (!ids && !recordIds) throw new AppError(400, "invalid_targets", "Select exact packages or canonical groups.");
    return this.queries.withCurrentSelection(selectionId, identity, async (client, context) => ({
      count: await this.queries.mutationTargetCount(client, { ...context, query: {} }, ids, recordIds),
    }));
  }
  async preview(identity: SelectionIdentity, selectionId: string, input: StagedMutationIntent, ids?: readonly string[], recordIds?: readonly string[]) {
    if (input.actor.tenantId !== identity.tenantId || input.actor.homeAccountId !== identity.principalId
      || !["block", "unblock", "update-availability", "update-installation"].includes(input.action)
      || !["single", "bulk"].includes(input.scope)) throw new AppError(403, "scope_mismatch", "Use the current delegated mutation scope.");
    validateTargets(ids, recordIds);
    return this.queries.withCurrentSelection(selectionId, identity, async (client, context) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('inventory-mutation-admission:'||$1,0))", [identity.tenantId]);
      const counts = (await client.query(`SELECT count(*)::int AS tenant,count(*) FILTER(WHERE principal_id=$2)::int AS actor
        FROM inventory_mutation_stages WHERE tenant_id=$1 AND expires_at>clock_timestamp() AND job_id IS NULL`,
      [identity.tenantId, identity.principalId])).rows[0];
      if (counts.actor >= 5 || counts.tenant >= 40) throw new AppError(429, "mutation_preview_limit", "Too many unexpired mutation previews.");
      const targetCount = await this.queries.mutationTargetCount(client, context, ids, recordIds);
      if (targetCount > 5000) throw dataLimitError("bulk_target_limit", 5000, targetCount);
      if (input.accessUpdate && targetCount > 100) throw dataLimitError("access_target_limit", 100, targetCount);
      const stageId = randomUUID(), selectionHash = createHash("sha256").update("[");
      const requestHash = createHash("sha256").update(`{"action":${JSON.stringify(input.action)},"targets":[`);
      let after: string | null = null, total = 0, bytes = 0, visibleBytes = 0;
      let intent: StagedMutationIntent | undefined, template: MutationConfirmationSummary | undefined;
      const visible: MutationConfirmationSummary["targets"] = [];
      for (;;) {
        const page = await this.queries.mutationTargets(client, context, after, ids, recordIds);
        if (!page.length) break;
        const authorities = (await client.query(`SELECT native_id,count(*)::int AS memberships,
          min(source_generation_id::text) AS source_generation_id,min(source_identity) AS source_identity,
          min(agent_id) AS agent_id,min(authority_expires_at) AS authority_expires_at
          FROM (${currentInventorySourcesSql}) live
          WHERE source='graph_packages' AND native_id=ANY($5::text[]) GROUP BY native_id`,
        [identity.tenantId, identity.principalId, null, null, page.map(row => row.id)])).rows;
        const authorityById = new Map(authorities.map(row => [row.native_id, row]));
        for (const row of page) {
          if (total >= 5000) throw dataLimitError("bulk_target_limit", 5000, total + 1);
          if (input.accessUpdate && total >= 100) throw dataLimitError("access_target_limit", 100, total + 1);
          if (row.membership_count !== 1 || row.id === after) throw new AppError(409, "inventory_identity_ambiguous", "A package has multiple live source memberships.");
          const prestate = await readMutationState(client, row, input.action);
          const prepared = createJobConfirmation({ ...input, targets: [{ id: row.id, displayName: row.display_name, prestate }] });
          if (!intent) {
            const { targets: _targets, ...metadata } = prepared.prepared;
            intent = metadata; template = prepared.summary;
            await client.query(`INSERT INTO inventory_mutation_stages(id,tenant_id,principal_id,authorization_hash,selection_id,intent,expires_at,target_filter_hash)
              SELECT $1,$2,$3,$4,id,$6,LEAST(expires_at,clock_timestamp()+interval '10 minutes'),$7 FROM data_read_selections WHERE id=$5`,
            [stageId, identity.tenantId, identity.principalId, identity.authorizationHash, selectionId, intent, targetFilterHash(ids, recordIds)]);
          }
          const target = prepared.prepared.targets[0];
          const authority = authorityById.get(row.id);
          if (authority?.memberships !== 1 || authority.source_generation_id !== row.generation_id
            || authority.source_identity !== row.source_identity || authority.agent_id !== row.agent_id) {
            throw new AppError(409, "confirmation_mismatch", "The selected current package authority changed.");
          }
          if (target.id !== row.id) throw new AppError(400, "invalid_targets", "An opaque package ID cannot be normalized for mutation.");
          bytes += Buffer.byteLength(JSON.stringify(target));
          if (bytes > 16_777_216) throw dataLimitError("mutation_stage_bytes", 16_777_216, bytes);
          const preview = prepared.summary.targets[0], size = Buffer.byteLength(JSON.stringify(preview));
          if (visible.length < 20 && visibleBytes + size <= 400_000) { visible.push(preview); visibleBytes += size; }
          selectionHash.update(`${total ? "," : ""}${JSON.stringify({ id: target.id, prestateHash: target.prestateHash })}`);
          requestHash.update(`${total ? "," : ""}${JSON.stringify({ id: target.id, displayName: target.displayName, prestateHash: target.prestateHash })}`);
          const parameters = [stageId, total, target.id, target.displayName, row.generation_id, row.source_identity, target.prestate,
            target.prestateHash, authority.agent_id, authority.authority_expires_at];
          encodeBatch([], parameters);
          await client.query(`INSERT INTO inventory_mutation_targets
            (stage_id,ordinal,target_id,display_name,source_generation_id,source_identity,prestate,prestate_hash,agent_id,authority_expires_at)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, parameters);
          total++; after = row.id;
        }

      }
      if (!total || !intent || !template) throw new AppError(409, "package_target_stale_or_absent", "No selected current package targets are available.");
      if (total !== targetCount) throw new AppError(409, "inventory_selection_changed", "The current filtered target count changed during staging.");
      if (ids && !recordIds && total !== ids.length) throw new AppError(409, "package_target_stale_or_absent", "An exact selected package is absent from the current selection.");
      if (input.scope === "single" && total !== 1) throw new AppError(400, "invalid_targets", "A single mutation requires exactly one target.");
      await assertCurrentMutationTargets(client, identity, stageId, total);
      const targetSelectionHash = selectionHash.update("]").digest("hex");
      const tail = JSON.stringify({ accessUpdate: intent.accessUpdate ?? null, reassignUserId: intent.reassignUserId ?? null,
        actorId: intent.actor.homeAccountId, scope: intent.scope });
      const requestDigest = requestHash.update(`],${tail.slice(1)}`).digest("hex");
      const summary: MutationConfirmationSummary = { ...template, targetCount: total,
        affectedPrincipalCount: intent.accessUpdate?.principals.length ?? total, targetSelectionHash,
        targets: visible, additionalTargetCount: total - visible.length };
      const confirmationHash = createHash("sha256").update(JSON.stringify({ requestHash: requestDigest, summary })).digest("hex");
      await client.query(`UPDATE inventory_mutation_stages SET target_count=$2,request_hash=$3,confirmation_hash=$4,summary=$5 WHERE id=$1`,
        [stageId, total, requestDigest, confirmationHash, summary]);
      return { stageId, selectionId, confirmationHash, summary };
    });
  }

  async submit(identity: SelectionIdentity, input: Omit<StagedMutationIntent, "actor" | "reassignUserId"> & {
    confirmationHash: string; idempotencyKey: string; selectionId?: string; ids?: readonly string[]; recordIds?: readonly string[];
  }) {
    const stage = (await this.database.query<{ id: string; selection_id: string; intent: StagedMutationIntent; target_filter_hash: string }>(`
      SELECT id,selection_id,intent,target_filter_hash FROM inventory_mutation_stages
      WHERE tenant_id=$1 AND principal_id=$2 AND authorization_hash=$3 AND confirmation_hash=$4 AND expires_at>clock_timestamp()
        AND ($5::uuid IS NULL OR selection_id=$5) ORDER BY created_at DESC,id DESC LIMIT 1`,
    [identity.tenantId, identity.principalId, identity.authorizationHash, input.confirmationHash, input.selectionId ?? null])).rows[0];
    if (!stage || stage.target_filter_hash !== targetFilterHash(input.ids, input.recordIds)
      || mutationRetryIntentHash({ ...stage.intent, requestPath: input.requestPath })
      !== mutationRetryIntentHash(input)) throw new AppError(409, "confirmation_mismatch", "Review the selected current mutation intent.");
    const jobs = new JobRepository(this.database);
    const id = await this.queries.withCurrentSelection(stage.selection_id, identity, async client => {
      return jobs.submitStaged(client, identity, stage.id, input);
    });
    return (await jobs.get(id, identity))!;
  }
}

function validateTargets(ids?: readonly string[], recordIds?: readonly string[]) {
  if (ids && (!ids.length || ids.length > 5000 || new Set(ids).size !== ids.length
    || ids.some(id => !id || id.length > 512))) throw new AppError(400, "invalid_targets", "Select 1–5000 distinct exact package IDs.");
  if (recordIds && (!recordIds.length || recordIds.length > 5000 || new Set(recordIds).size !== recordIds.length
    || recordIds.some(id => !/^agent:[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id)))) {
    throw new AppError(400, "invalid_targets", "Select 1–5000 distinct canonical agent groups.");
  }
  encodeBatch([], [ids ?? null, recordIds ?? null]);
}

function targetFilterHash(ids?: readonly string[], recordIds?: readonly string[]) {
  encodeBatch([], [ids ?? null, recordIds ?? null]);
  return createHash("sha256").update(JSON.stringify([ids ? [...ids].sort() : null, recordIds ? [...recordIds].sort() : null])).digest("hex");
}

async function readMutationState(client: pg.PoolClient, row: TargetRow, action: JobIntentInput["action"]) {
  const saved = (await client.query("SELECT residual FROM package_record_rows WHERE generation_id=$1 AND identity=$2",
    [row.generation_id, row.source_identity])).rows[0];
  if (!saved) throw new AppError(409, "package_target_stale_or_absent", "The selected package source is unavailable.");
  const value: Parameters<typeof capturePackageMutationState>[0] = { isBlocked: saved.residual.isBlocked,
    availableTo: saved.residual.availableTo, deployedTo: saved.residual.deployedTo };
  if (action === "block" || action === "unblock") return capturePackageMutationState(value, action);
  const budget = (await client.query(`SELECT coalesce(sum(octet_length(payload::text)+octet_length(kind)+octet_length(value)),0)::text AS bytes
    FROM inventory_facts WHERE generation_id=$1 AND identity=$2 AND
      (kind IN ('allowedUsersAndGroups','acquireUsersAndGroups') OR kind='collection' AND value IN ('allowedUsersAndGroups','acquireUsersAndGroups'))`,
  [row.generation_id, row.source_identity])).rows[0];
  if (Number(budget.bytes) > 60_000) throw dataLimitError("mutation_prestate_bytes", 60_000, Number(budget.bytes));
  let ordinal = -1;
  for (;;) {
    const rows = (await client.query(`SELECT ordinal,kind,value,payload FROM inventory_facts WHERE generation_id=$1 AND identity=$2
      AND ordinal>$3 AND (kind IN ('allowedUsersAndGroups','acquireUsersAndGroups')
        OR kind='collection' AND value IN ('allowedUsersAndGroups','acquireUsersAndGroups'))
      ORDER BY ordinal LIMIT 100`, [row.generation_id, row.source_identity, ordinal])).rows;
    if (!rows.length) break;
    for (const fact of rows) {
      const kind = (fact.kind === "collection" ? fact.value : fact.kind) as "allowedUsersAndGroups" | "acquireUsersAndGroups";
      value[kind] ??= [];
      if (fact.kind !== "collection") value[kind].push(fact.payload as PackageAccessEntity);
    }
    ordinal = rows.at(-1)!.ordinal;
  }
  const state = capturePackageMutationState(value, action);
  if (Buffer.byteLength(JSON.stringify(state)) > 65_000) throw dataLimitError("mutation_prestate_bytes", 65_000, Buffer.byteLength(JSON.stringify(state)));
  packageMutationStateHash(state);
  return state;
}
