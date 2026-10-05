import { createHash } from "node:crypto";
import type pg from "pg";
import { AppError } from "../errors.js";
import { dataConnections } from "./dataConnections.js";
import { encodeBatch } from "./dataBounds.js";

export async function readAutomaticInventoryRevisions(scope: { tenantId: string; principalId: string },
  database: pg.Pool | pg.PoolClient, evaluatedAt?: Date): Promise<{ graph_packages: string; power_platform: string }> {
  if (!scope.tenantId || !scope.principalId) throw new AppError(403, "scope_mismatch", "Inventory revision requires a tenant and principal.");
  if ("totalCount" in database) return dataConnections(database).selectedRead(client => readAutomaticInventoryRevisions(scope, client, evaluatedAt));
  const at = evaluatedAt ?? (await database.query("SELECT clock_timestamp() AS now")).rows[0].now;
  const hashes = { graph_packages: createHash("sha256"), power_platform: createHash("sha256") };
  for (const [source, hash] of Object.entries(hashes)) hash.update(JSON.stringify(["inventory-observer-v3", source, scope.tenantId, scope.principalId]));
  let afterSource = "", afterId = "";
  for (;;) {
    const rows = (await database.query(`WITH markers AS (
      SELECT CASE s.source WHEN 'inventory_packages' THEN 'graph_packages'
        WHEN 'inventory_power_platform' THEN 'power_platform'
        WHEN 'inventory_canonical' THEN 'canonical' ELSE 'directory' END AS source,
        jsonb_build_array(s.id,s.epoch,s.session_epoch,h.revision,g.id)::text AS id,g.observed_at,g.expires_at
      FROM data_scope_epochs s LEFT JOIN data_generation_heads h ON h.scope_id=s.id
      LEFT JOIN data_generations g ON g.id=h.generation_id AND g.scope_epoch=s.epoch AND g.session_epoch=s.session_epoch
        AND g.state='published' AND g.validated AND g.expires_at>$3
      WHERE s.tenant_id=$1 AND s.principal_id=$2 AND s.token_mode='delegated'
        AND g.id IS NOT NULL
        AND (s.source IN ('inventory_packages','inventory_power_platform','inventory_canonical') OR s.source='directory' AND s.selector='complete')
      UNION ALL SELECT 'agent_people',coalesce((SELECT revision FROM inventory_people_revisions WHERE tenant_id=$1 AND principal_id=$2),0)::text,NULL::timestamptz,
        (SELECT min(expires_at) FROM agent_people_cache WHERE tenant_id=$1 AND principal_id=$2 AND expires_at>$3)
    ) SELECT source,id,observed_at,expires_at FROM markers
      WHERE (source COLLATE "C",id COLLATE "C")>($4::text COLLATE "C",$5::text COLLATE "C")
      ORDER BY source COLLATE "C",id COLLATE "C" LIMIT 250`,
    [scope.tenantId, scope.principalId, at, afterSource, afterId])).rows;
    if (!rows.length) break;
    encodeBatch(rows);
    for (const row of rows) {
      if (row.source === "canonical") {
        for (const hash of Object.values(hashes)) hash.update(JSON.stringify(row));
      } else hashes[row.source === "graph_packages" ? "graph_packages" : "power_platform"].update(JSON.stringify(row));
    }
    afterSource = rows.at(-1)!.source; afterId = rows.at(-1)!.id;
  }
  return { graph_packages: hashes.graph_packages.digest("hex"), power_platform: hashes.power_platform.digest("hex") };
}
