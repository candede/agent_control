import type pg from "pg";
import { AppError } from "../errors.js";
import type { SelectionIdentity } from "../services/dataSelections.js";
import { currentInventorySourcesSql } from "./inventoryAuthority.js";

export async function assertCurrentMutationTargets(client: pg.PoolClient, identity: SelectionIdentity, stageId: string, expected: number) {
  const result = (await client.query(`WITH current_sources AS MATERIALIZED (
      SELECT native_id,min(source_generation_id::text) AS generation_id,min(source_identity) AS identity,
        min(agent_id) AS agent_id,count(*) AS memberships
      FROM (${currentInventorySourcesSql}) live WHERE source='graph_packages' GROUP BY native_id
    )
    SELECT count(*)::int AS total,count(*) FILTER(WHERE source.memberships=1
      AND source.generation_id=target.source_generation_id::text AND source.identity=target.source_identity
      AND source.agent_id=target.agent_id::text AND target.authority_expires_at>clock_timestamp())::int AS valid
    FROM inventory_mutation_targets target JOIN inventory_mutation_stages stage ON stage.id=target.stage_id
    LEFT JOIN current_sources source ON source.native_id=target.target_id
    WHERE target.stage_id=$5 AND stage.tenant_id=$1 AND stage.principal_id=$2`,
  [identity.tenantId, identity.principalId, null, null, stageId])).rows[0];
  if (!expected || result.total !== expected || result.valid !== expected) {
    throw new AppError(409, "confirmation_mismatch", "The selected current membership or source/control revision changed.");
  }
}

export async function assertCurrentJobTarget(client: pg.PoolClient, scope: Pick<SelectionIdentity, "tenantId" | "principalId">,
  jobId: string, itemId: string) {
  const target = (await client.query(`SELECT source_generation_id,source_identity,agent_id,target_id,
    authority_expires_at>clock_timestamp() AS unexpired
    FROM job_items WHERE id=$1 AND job_id=$2`, [itemId, jobId])).rows[0];
  if (!target) throw new AppError(409, "confirmation_mismatch", "The frozen target is unavailable.");
  // Exact canary jobs have their own approved-cycle authority and provider reauthorization.
  if (target.source_generation_id === null) return;
  if (!target.unexpired) throw new AppError(409, "confirmation_mismatch", "The frozen mutation authority expired before dispatch.");
  const current = (await client.query(`SELECT count(*)::int AS total,count(*) FILTER(
      WHERE source_generation_id=$6 AND source_identity=$7 AND agent_id=$8)::int AS valid
    FROM (${currentInventorySourcesSql}) live WHERE source='graph_packages' AND native_id=$5`,
  [scope.tenantId, scope.principalId, null, null, target.target_id,
    target.source_generation_id, target.source_identity, target.agent_id])).rows[0];
  if (current.total !== 1 || current.valid !== 1) {
    throw new AppError(409, "confirmation_mismatch", "The frozen current membership or source/control revision changed before dispatch.");
  }
}
