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
    SELECT 'power_platform' AS source,id,observed_at,expires_at FROM power_platform_inventory_snapshots
      WHERE tenant_id=$1 AND principal_id=$2 AND is_current AND expires_at>clock_timestamp()
    ORDER BY source,id`, [scope.tenantId, scope.principalId]);
  return createHash("sha256").update(JSON.stringify(["unified-agent-inventory-v2", scope.tenantId, scope.principalId, rows])).digest("hex");
}
