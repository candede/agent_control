import { createHash } from "node:crypto";
import type pg from "pg";
import { AppError } from "../errors.js";
import type { PackageDataScope } from "./packageInventory.js";
import { pool } from "./pool.js";

export async function readUnifiedInventoryRevision(scope: PackageDataScope, database: Pick<pg.Pool, "query"> = pool) {
  if (!scope.tenantId || !scope.principalId) throw new AppError(403, "scope_mismatch", "Inventory revision requires a tenant and principal.");
  const { rows } = await database.query<{ source: string; id: string; observed_at: Date; expires_at: Date }>(`
    SELECT 'graph_packages' AS source,id,observed_at,expires_at FROM package_inventory_snapshots
      WHERE tenant_id=$1 AND principal_id=$2 AND token_mode='delegated' AND is_current AND expires_at>clock_timestamp()
    UNION ALL
    SELECT 'graph_package_details' AS source,generation AS id,observed_at,expires_at FROM package_detail_cache
      WHERE tenant_id=$1 AND principal_id=$2 AND token_mode='delegated' AND observed_at IS NOT NULL AND expires_at>clock_timestamp()
    UNION ALL
    SELECT 'power_platform' AS source,id,observed_at,expires_at FROM power_platform_inventory_snapshots
      WHERE tenant_id=$1 AND principal_id=$2 AND is_current AND expires_at>clock_timestamp()
    UNION ALL
    SELECT 'directory' AS source,snapshot.id,snapshot.observed_at,snapshot.expires_at
      FROM copilot_usage_source_state state
      JOIN copilot_usage_snapshots snapshot
        ON snapshot.id=state.current_snapshot_id AND snapshot.tenant_id=state.tenant_id
        AND snapshot.principal_id=state.principal_id AND snapshot.source_id=state.source_id
        AND snapshot.is_current AND snapshot.expires_at>clock_timestamp()
      WHERE state.tenant_id=$1 AND state.principal_id=$2 AND state.source_id='directory'
    UNION ALL
    SELECT 'agent_people' AS source,revision AS id,checked_at AS observed_at,expires_at FROM agent_people_cache
      WHERE tenant_id=$1 AND principal_id=$2 AND expires_at>clock_timestamp()
    ORDER BY source,id`, [scope.tenantId, scope.principalId]);
  return createHash("sha256").update(JSON.stringify(["unified-agent-inventory-v5", scope.tenantId, scope.principalId, rows])).digest("hex");
}
