import type pg from "pg";
import { lockDataScope } from "./dataGenerations.js";
import type { SelectionIdentity } from "../services/dataSelections.js";

// Parameters: tenant, delegated principal, canonical ID, selected evaluation time.
export const currentInventorySourcesSql = `SELECT * FROM inventory_live_sources
  WHERE tenant_id=$1 AND principal_id=$2 AND ($3::text IS NULL OR agent_id=$3)
    AND authority_expires_at>GREATEST($4::timestamptz,clock_timestamp())`;

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
