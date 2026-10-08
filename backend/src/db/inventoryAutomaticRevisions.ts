import { createHash } from "node:crypto";
import type pg from "pg";
import { AppError } from "../errors.js";
import { dataConnections } from "./dataConnections.js";
import { encodeBatch } from "./dataBounds.js";
import type { PublicationRevisions } from "../types/dataSelection.js";

export async function readAutomaticInventoryRevisions(scope: { tenantId: string; principalId: string },
  database: pg.Pool | pg.PoolClient): Promise<PublicationRevisions> {
  if (!scope.tenantId || !scope.principalId) throw new AppError(403, "scope_mismatch", "Inventory revision requires a tenant and principal.");
  if ("totalCount" in database) return dataConnections(database).selectedRead(client => readAutomaticInventoryRevisions(scope, client));
  const hashes = { graph_packages: createHash("sha256"), power_platform: createHash("sha256"), users: createHash("sha256") };
  for (const [source, hash] of Object.entries(hashes)) hash.update(JSON.stringify(["publication-observer-v4", source, scope.tenantId, scope.principalId]));
  let afterSource = "", afterId = "";
  for (;;) {
    const rows = (await database.query(`WITH markers AS (
      SELECT CASE s.source WHEN 'inventory_packages' THEN 'graph_packages'
        WHEN 'inventory_power_platform' THEN 'power_platform'
        WHEN 'inventory_canonical' THEN 'canonical' ELSE s.source END AS source,
        jsonb_build_array(s.id,s.epoch,s.session_epoch,h.revision,g.id,g.state,g.validated,r.baseline_id,r.revision)::text AS id
      FROM data_scope_epochs s LEFT JOIN data_generation_heads h ON h.scope_id=s.id
      LEFT JOIN data_generations g ON g.id=h.generation_id
      LEFT JOIN inventory_roots r ON r.scope_id=s.id AND r.current
      WHERE s.tenant_id=$1 AND s.principal_id=$2 AND s.token_mode='delegated'
        AND (h.generation_id IS NOT NULL OR s.epoch>0)
        AND (s.source IN ('inventory_packages','inventory_power_platform','inventory_canonical') OR s.source IN ('directory','app_activity') AND s.selector='complete')
      UNION ALL SELECT 'agent_people',coalesce((SELECT revision FROM inventory_people_revisions WHERE tenant_id=$1 AND principal_id=$2),0)::text
      UNION ALL SELECT 'authorization',coalesce((SELECT epoch FROM data_principal_epochs WHERE tenant_id=$1 AND principal_id=$2),0)::text
      UNION ALL SELECT 'reports',jsonb_build_array(coalesce(h.revision,0),coalesce(h.invalidation_epoch,0),coalesce(s.revision,1),s.active_set_id)::text
        FROM (SELECT $1::text AS tenant_id) tenant LEFT JOIN official_usage_history_state h USING(tenant_id)
        LEFT JOIN official_usage_state s USING(tenant_id)
    ) SELECT source,id FROM markers
      WHERE (source COLLATE "C",id COLLATE "C")>($3::text COLLATE "C",$4::text COLLATE "C")
      ORDER BY source COLLATE "C",id COLLATE "C" LIMIT 250`,
    [scope.tenantId, scope.principalId, afterSource, afterId])).rows;
    if (!rows.length) break;
    encodeBatch(rows);
    for (const row of rows) {
      if (["authorization", "reports"].includes(row.source)) {
        for (const hash of Object.values(hashes)) hash.update(JSON.stringify(row));
      } else {
        const targets = row.source === "canonical" ? ["graph_packages", "power_platform"] as const
          : row.source === "directory" ? ["graph_packages", "power_platform", "users"] as const
            : row.source === "app_activity" ? ["users"] as const
              : row.source === "agent_people" ? ["graph_packages", "power_platform"] as const
                : [row.source as "graph_packages" | "power_platform"];
        for (const target of targets) hashes[target].update(JSON.stringify(row));
      }
    }
    afterSource = rows.at(-1)!.source; afterId = rows.at(-1)!.id;
  }
  return { graph_packages: hashes.graph_packages.digest("hex"), power_platform: hashes.power_platform.digest("hex"), users: hashes.users.digest("hex") };
}
