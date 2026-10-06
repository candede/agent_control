import type pg from "pg";
import { lockDataScope } from "./dataGenerations.js";
import type { SelectionIdentity } from "../services/dataSelections.js";

// Parameters: tenant, delegated principal, canonical ID, selected evaluation time.
export const currentInventorySourcesSql = `SELECT * FROM inventory_live_sources
  WHERE tenant_id=$1 AND principal_id=$2 AND ($3::text IS NULL OR agent_id=$3)
    AND authority_expires_at>GREATEST($4::timestamptz,clock_timestamp())`;

// Only use inside a validated inventory selection read, never as mutation authority.
export function selectedInventorySourcesSql(tenant: string, principal: string, agent: string, selection: string) {
  return `SELECT canonical.identity AS agent_id,canonical.generation_id AS control_revision,
      CASE WHEN source.domain='packages' THEN 'graph_packages' ELSE 'power_platform' END AS source,
      source.native_id,coalesce(source.environment_id,'') AS environment_id,
      CASE WHEN source.domain='power_platform' AND source.native_id ~* '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'
        THEN lower(source.native_id) ELSE source.native_id END AS normalized_native_id,
      CASE WHEN source.domain='packages' THEN '' ELSE coalesce(lower(source.environment_id),'') END AS normalized_environment_id,
      CASE WHEN source.domain='packages' THEN source.generation_id END AS package_snapshot_id,
      CASE WHEN source.domain='power_platform' THEN source.generation_id END AS power_platform_snapshot_id
    FROM inventory_read_contexts context
    JOIN data_read_selections selected ON selected.id=context.selection_id
    JOIN data_scope_epochs scope ON scope.id=context.root_scope_id
    JOIN data_generation_pins pin ON pin.selection_id=selected.id AND pin.scope_id=context.root_scope_id
    JOIN inventory_memberships membership ON membership.baseline_id=pin.generation_id
      AND membership.valid_from_revision<=pin.revision AND (membership.valid_to_revision IS NULL OR membership.valid_to_revision>pin.revision)
    JOIN unified_agent_rows canonical ON canonical.generation_id=membership.generation_id AND canonical.identity=membership.identity
    JOIN unified_agent_memberships member ON member.generation_id=canonical.generation_id AND member.identity=canonical.identity
    JOIN inventory_records source ON source.generation_id=member.source_generation_id AND source.identity=member.source_identity
    WHERE selected.id=${selection}::uuid AND selected.tenant_id=${tenant} AND selected.principal_id=${principal}
      AND scope.tenant_id=${tenant} AND scope.principal_id=${principal}
      AND scope.source='inventory_canonical' AND scope.token_mode='delegated'
      AND (${agent}::text IS NULL OR canonical.identity=${agent})
      AND canonical.expires_at>selected.evaluated_at AND source.expires_at>selected.evaluated_at`;
}

export async function lockInventorySelection(client: pg.PoolClient, identity: SelectionIdentity, selectionId: string) {
  return lockInventorySources(client, identity, { id: selectionId, authorizationHash: identity.authorizationHash });
}

export async function lockInventorySources(client: pg.PoolClient, identity: Pick<SelectionIdentity, "tenantId" | "principalId">,
  selection?: { id: string; authorizationHash: string }) {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`data-sync:${identity.tenantId}:${identity.principalId}`]);
  const scopes = (await client.query(`WITH inventory AS (
    SELECT root.scope_id,revision.inputs FROM data_scope_epochs scope
    JOIN inventory_roots root ON root.scope_id=scope.id AND root.current
    JOIN inventory_revisions revision ON revision.scope_id=root.scope_id AND revision.revision=root.revision
    WHERE scope.tenant_id=$1 AND scope.principal_id=$2 AND scope.source='inventory_canonical' AND scope.token_mode='delegated' AND scope.selector='complete'
  ), scopes AS (
    SELECT pin.scope_id FROM data_generation_pins pin JOIN data_read_selections selection ON selection.id=pin.selection_id
      WHERE selection.id=$3 AND selection.tenant_id=$1 AND selection.principal_id=$2 AND selection.authorization_hash=$4
    UNION SELECT scope_id FROM inventory
    UNION SELECT input."scopeId" FROM inventory CROSS JOIN LATERAL jsonb_to_recordset(inventory.inputs) input("scopeId" uuid)
  ) SELECT scopes.scope_id FROM scopes JOIN data_scope_epochs allowed ON allowed.id=scopes.scope_id
    WHERE allowed.tenant_id=$1 AND (allowed.scope_kind='tenant' OR allowed.principal_id=$2) ORDER BY scopes.scope_id`,
  [identity.tenantId, identity.principalId, selection?.id ?? null, selection?.authorizationHash ?? null])).rows;
  for (const scope of scopes) await lockDataScope(client, scope.scope_id, identity.tenantId);
}
