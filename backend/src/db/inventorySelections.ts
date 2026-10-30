import type pg from "pg";
import { SelectionError, type DependencyRoot, type SelectionIdentity } from "../services/dataSelections.js";
import type { InventoryRoot } from "../types/inventoryRecords.js";
import { normalizeEnvironmentIdentitySql, normalizeNativeIdentitySql } from "./inventoryIdentityNormalization.js";

export async function inventorySelectionRoots(client: pg.PoolClient,
  scope: { id: string; tenantId: string }, expiresAt: Date): Promise<DependencyRoot[]> {
  const root = (await client.query<{
    scope_id: string; baseline_id: string; revision: string; inputs: InventoryRoot[];
  }>(`SELECT r.scope_id,r.baseline_id,r.revision::text,v.inputs
    FROM inventory_roots r JOIN inventory_revisions v ON v.scope_id=r.scope_id AND v.revision=r.revision
    JOIN data_scope_epochs s ON s.id=r.scope_id
    WHERE r.scope_id=$1 AND r.current AND r.tenant_id=$2 AND s.scope_kind='tenant' AND s.token_mode='tenant'`,
  [scope.id, scope.tenantId])).rows[0];
  if (!root) return [];
  return [{ kind: "inventory_delta", scopeId: root.scope_id, generationId: root.baseline_id, revision: root.revision, expiresAt },
    ...root.inputs.map(input => ({ kind: "inventory_delta" as const, scopeId: input.scopeId,
      generationId: input.baselineId, revision: input.revision, expiresAt }))];
}

export async function inventoryAssociationRevision(client: pg.PoolClient, tenantId: string): Promise<string> {
  return (await client.query<{ revision: string }>(
    "SELECT coalesce(inventory_association_revision($1),0)::text AS revision", [tenantId])).rows[0].revision;
}

export async function validateInventoryRoot(client: pg.PoolClient, root: DependencyRoot, identity: SelectionIdentity,
  exportSelectionId?: string) {
  if (root.kind !== "inventory_delta") throw new SelectionError("selection_invalidated");
  const revision = await client.query(`SELECT 1 FROM inventory_revisions v JOIN inventory_roots r ON r.baseline_id=v.baseline_id
    JOIN data_generations g ON g.id=v.generation_id JOIN data_scope_epochs s ON s.id=v.scope_id
    JOIN data_generations anchor ON anchor.id=v.baseline_id
    WHERE v.scope_id=$1 AND v.revision=$2 AND v.baseline_id=$3 AND v.tenant_id=$4 AND r.collected_before<=$2
      AND s.scope_kind='tenant' AND s.token_mode='tenant' AND g.scope_epoch=s.epoch AND g.session_epoch=s.session_epoch
      AND g.state IN ('published','retired') AND g.validated
      AND anchor.state IN ('published','retired')
      AND NOT EXISTS(SELECT 1 FROM jsonb_to_recordset(v.inputs) input("scopeId" uuid,"baselineId" uuid,epoch bigint)
        LEFT JOIN data_scope_epochs source ON source.id=input."scopeId"
        LEFT JOIN data_generations generation ON generation.id=input."baselineId"
        WHERE source.epoch IS DISTINCT FROM input.epoch OR source.tenant_id<>$4 OR source.scope_kind<>'tenant'
          OR generation.id IS NULL OR generation.state NOT IN ('published','retired'))`,
  [root.scopeId, root.revision, root.generationId, identity.tenantId]);
  if (revision.rowCount !== 1) throw new SelectionError("selection_invalidated");
  if (exportSelectionId !== undefined) {
    const changed = await client.query(`SELECT 1 FROM inventory_read_contexts c
      WHERE c.selection_id=$1 AND c.tenant_id=$2 AND c.root_scope_id=$3
        AND c.association_revision IS DISTINCT FROM coalesce(inventory_association_revision($2),0)`,
    [exportSelectionId, identity.tenantId, root.scopeId]);
    if (changed.rowCount) throw new SelectionError("selection_invalidated");
  }
}

// The caller validates every dependency pin before reading these saved sources.
export function selectedInventorySourcesSql(tenant: string, principal: string, agent: string, selection: string) {
  return `SELECT canonical.identity AS agent_id,canonical.generation_id AS control_revision,
      source.scope_id AS source_scope_id,source.generation_id AS source_generation_id,source.identity AS source_identity,
      CASE WHEN source.domain='packages' THEN 'graph_packages' ELSE 'power_platform' END AS source,
      source.native_id,coalesce(source.environment_id,'') AS environment_id,
      CASE WHEN source.domain='power_platform' THEN ${normalizeNativeIdentitySql("source.native_id")} ELSE source.native_id END AS normalized_native_id,
      CASE WHEN source.domain='packages' THEN '' ELSE coalesce(${normalizeEnvironmentIdentitySql("source.environment_id")},'') END AS normalized_environment_id,
      CASE WHEN source.domain='packages' THEN source.generation_id END AS package_snapshot_id,
      CASE WHEN source.domain='power_platform' THEN source.generation_id END AS power_platform_snapshot_id
    FROM data_read_selections selected
    JOIN data_generation_pins pin ON pin.selection_id=selected.id AND pin.root_kind='inventory_delta'
    JOIN data_scope_epochs scope ON scope.id=pin.scope_id
    JOIN inventory_memberships membership ON membership.baseline_id=pin.generation_id
      AND membership.valid_from_revision<=pin.revision AND (membership.valid_to_revision IS NULL OR membership.valid_to_revision>pin.revision)
    JOIN unified_agent_rows canonical ON canonical.generation_id=membership.generation_id AND canonical.identity=membership.identity
    JOIN unified_agent_memberships member ON member.generation_id=canonical.generation_id AND member.identity=canonical.identity
    JOIN inventory_records source ON source.generation_id=member.source_generation_id AND source.identity=member.source_identity
    WHERE selected.id=${selection}::uuid AND selected.tenant_id=${tenant} AND selected.principal_id=${principal}
      AND scope.tenant_id=${tenant} AND scope.scope_kind='tenant'
      AND scope.source='inventory_canonical' AND scope.token_mode='tenant'
      AND (${agent}::text IS NULL OR canonical.identity=${agent})`;
}
