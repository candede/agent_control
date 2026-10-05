import type pg from "pg";
import { AppError } from "../errors.js";
import { normalizeNativeIdentity, type IdentityResolution, type InventoryIdentityRecord } from "../services/inventoryIdentity.js";
import { powerPlatformResourceTypes, type PowerPlatformResourceType } from "../types/powerPlatformInventory.js";
import { exactCount } from "./dataBounds.js";
import { dataConnections } from "./dataConnections.js";

type Scope = { tenantId: string; principalId: string };
export type InventoryIdentityReadScope = { principalId: string; resourceTypes: PowerPlatformResourceType[] };
export const currentNativeInventorySql = `WITH selected AS (
  SELECT DISTINCT ON (kind) root.baseline_id,root.revision,kind FROM inventory_roots root
  JOIN data_scope_epochs scope ON scope.id=root.scope_id
  JOIN inventory_revisions revision ON revision.scope_id=root.scope_id AND revision.revision=root.revision
  JOIN data_generations generation ON generation.id=revision.generation_id
  JOIN data_principal_epochs principal ON principal.tenant_id=scope.tenant_id AND principal.principal_id=scope.principal_id
  JOIN inventory_attempts attempt ON attempt.generation_id=generation.id
  CROSS JOIN LATERAL unnest(attempt.resource_types) kind
  WHERE root.current AND root.domain='power_platform' AND root.tenant_id=$1 AND scope.principal_id=$2
    AND scope.token_mode='delegated' AND generation.scope_epoch=scope.epoch
    AND generation.session_epoch=scope.session_epoch AND generation.session_epoch=principal.epoch
    AND generation.state='published' AND generation.validated AND generation.expires_at>clock_timestamp()
    AND kind=ANY($3::text[])
  ORDER BY kind,(coalesce(attempt.environment_id,'')='') DESC,root.catalog_observed_at DESC NULLS LAST,root.scope_id
), native AS (
  SELECT row.* FROM selected root JOIN inventory_memberships member ON member.baseline_id=root.baseline_id
    AND member.valid_from_revision<=root.revision AND (member.valid_to_revision IS NULL OR member.valid_to_revision>root.revision)
  JOIN power_platform_record_rows row ON row.generation_id=member.generation_id AND row.identity=member.identity
    AND row.resource_type=root.kind AND row.expires_at>clock_timestamp()
)`;
const normalize = (value: string) => `CASE WHEN ${value} ~* '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$' THEN lower(${value}) ELSE ${value} END`;

export class InventoryIdentityQueries {
  constructor(readonly database: pg.Pool) {}
  read<T>(work: (client: pg.PoolClient) => Promise<T>) {
    return dataConnections(this.database).selectedRead(work);
  }
  async resolve(client: pg.PoolClient, scope: Scope, types: readonly PowerPlatformResourceType[],
    source: InventoryIdentityRecord, options: { blueprintParentAcrossSources?: boolean } = {}): Promise<IdentityResolution> {
    if (!scope.tenantId || !scope.principalId || source.tenantId !== scope.tenantId || !types.length
      || types.length > powerPlatformResourceTypes.length || types.some(type => !powerPlatformResourceTypes.includes(type))
      || source.identifiers.length > 25) throw new AppError(403, "scope_mismatch", "Use an exact authorized native identity query.");
    const identifiers = source.identifiers.map(value => ({ kind: value.kind, value: normalizeNativeIdentity(value.value) }));
    const values = [scope.tenantId, scope.principalId, types, JSON.stringify(identifiers), source.environmentId?.toLowerCase() ?? null,
      source.resourceType, source.sourceSystem === "power_platform"];
    const matches = (await client.query(`${currentNativeInventorySql}, requested AS (
      SELECT * FROM jsonb_to_recordset($4::jsonb) item(kind text,value text)
    ), matches AS (
      SELECT DISTINCT ${normalize("n.native_id")} COLLATE "C" AS native_id,
        lower(n.environment_id) COLLATE "C" AS environment_id,n.resource_type COLLATE "C" AS resource_type,min(requested.kind) AS kind
      FROM native n JOIN inventory_facts fact ON fact.generation_id=n.generation_id AND fact.identity=n.identity AND fact.kind='identifier'
      JOIN requested ON requested.kind=fact.payload->>'kind' AND md5(lower(fact.value))=md5(lower(requested.value))
        AND requested.value=${normalize("fact.value")}
      WHERE $7::boolean AND requested.kind IN ('power_platform_resource_id','cds_bot_id','entra_app_id','entra_agent_id',
        'package_id','package_app_id','manifest_id','asset_id')
        AND (requested.kind NOT IN ('power_platform_resource_id','cds_bot_id') OR lower(n.environment_id)=$5)
        AND (requested.kind<>'power_platform_resource_id' OR n.resource_type=$6)
      GROUP BY ${normalize("n.native_id")},lower(n.environment_id),n.resource_type
    ) SELECT *,count(*) OVER()::text AS total FROM matches ORDER BY resource_type,environment_id,native_id LIMIT 20`, values)).rows;
    const candidates = matches.map(row => ({ nativeId: row.native_id, tenantId: scope.tenantId, environmentId: row.environment_id || null,
      resourceType: row.resource_type, sourceSystem: "power_platform" as const }));
    if (matches.length === 1) return { status: "resolved", candidate: candidates[0], matchedKind: matches[0].kind };
    if (matches.length) {
      const count = exactCount(matches[0].total);
      return { status: "ambiguous", reason: "multiple_exact_candidates", candidates,
        ...count > 20 ? { candidateCount: count, candidatesTruncated: true } : {} };
    }
    const evidence = (await client.query(`${currentNativeInventorySql} SELECT EXISTS(SELECT 1 FROM native) AS present,
      EXISTS(SELECT 1 FROM native n JOIN inventory_facts fact ON fact.generation_id=n.generation_id AND fact.identity=n.identity
        WHERE fact.kind='identifier' AND fact.payload->>'kind'='entra_blueprint_id'
          AND ${normalize("fact.value")}=ANY($4::text[])) AS blueprint`,
    [scope.tenantId, scope.principalId, types, identifiers.filter(value => value.kind === "entra_blueprint_id").map(value => value.value)])).rows[0];
    return { status: "unresolved", reason: evidence.blueprint && (source.sourceSystem === "power_platform" || options.blueprintParentAcrossSources)
      ? "blueprint_is_parent_not_equivalence" : evidence.present && source.sourceSystem !== "power_platform"
        ? "no_documented_cross_source_relation" : "no_documented_exact_identifier" };
  }
}
