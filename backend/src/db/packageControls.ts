import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";
import { AppError } from "../errors.js";
import type { CopilotPackageDetail } from "../types/copilotPackage.js";
import { packageControlIdentityChanged, type SavedPackageControl } from "../services/packageControlProjection.js";
import { capturePackageMutationState, packageMutationStatesEqual, type PackageMutationState } from "../services/packageMutationState.js";
import { restoreInventoryRecord, type InventoryFact } from "../services/inventoryRecordProjection.js";
import { allowlistedPackage } from "../services/packageObservation.js";
import { dataLimitError, dataLimits, encodeBatch, encodeInventoryFactBatch } from "./dataBounds.js";

type Scope = { tenantId: string; principalId: string };

export async function lockPackageInventoryScope(scope: Scope, client: pg.PoolClient) {
  validateScope(scope);
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`data-sync:${scope.tenantId}:${scope.principalId}`]);
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`package-refresh:${scope.tenantId}:${scope.principalId}`]);
}

export async function readPackageInventoryGeneration(scope: Scope, database: Pick<pg.Pool, "query">) {
  validateScope(scope);
  return (await database.query(`SELECT id FROM data_sync_runs WHERE tenant_id=$1 AND principal_id=$2 AND clear_saved_data
    ORDER BY started_at DESC,id DESC LIMIT 1`, [scope.tenantId, scope.principalId])).rows[0]?.id ?? null;
}

export async function publishPackageReadback(scope: Scope, detail: CopilotPackageDetail, client: pg.PoolClient,
  inventoryGeneration: string | null, state: PackageMutationState) {
  await lockPackageInventoryScope(scope, client);
  if (await readPackageInventoryGeneration(scope, client) !== inventoryGeneration) {
    throw new AppError(409, "package_readback_superseded", "Saved inventory was cleared during package work. Reconcile the exact target before publishing a new observation.");
  }
  if (!detail.id || detail.id.length > 512
    || !packageMutationStatesEqual(capturePackageMutationState(detail, state.kind === "block" ? "block" : "update-availability"), state)) {
    throw new AppError(409, "mutation_readback_mismatch", "Only verified exact package control state can be published.");
  }
  const previous = await readControlIdentity(client, scope, detail);
  const identityChanged = Boolean(previous && (previous.identityRevalidationRequired || packageControlIdentityChanged(previous, detail)));
  const saved = allowlistedPackage({
    id: detail.id, displayName: detail.displayName, sourceSystem: "graph_packages", isBlocked: detail.isBlocked,
    appId: detail.appId, manifestId: detail.manifestId, assetId: detail.assetId, version: detail.version, manifestVersion: detail.manifestVersion,
    ...(state.kind === "access" ? { availableTo: detail.availableTo ?? state.availableTo, deployedTo: detail.deployedTo ?? state.deployedTo,
      allowedUsersAndGroups: state.allowedUsersAndGroups, acquireUsersAndGroups: state.acquireUsersAndGroups } : {}),
  });
  encodeBatch([], [saved, state]);
  const queryHash = createHash("sha256").update(JSON.stringify({ tokenMode: "delegated", scopeKind: "exact",
    requestedIds: [detail.id], observationKind: state.kind })).digest("hex");
  await client.query(`UPDATE package_inventory_snapshots SET is_current=false,expires_at=LEAST(expires_at,clock_timestamp())
    WHERE tenant_id=$1 AND principal_id=$2 AND token_mode='delegated' AND query_hash=$3 AND is_current`,
  [scope.tenantId, scope.principalId, queryHash]);
  const id = randomUUID();
  await client.query(`INSERT INTO package_inventory_snapshots
    (id,tenant_id,principal_id,token_mode,query_hash,scope_kind,requested_ids,observed_count,total_records,page_count,
      observation_kind,control_state,expires_at,identity_revalidation_required)
    VALUES($1,$2,$3,'delegated',$4,'exact',$5,1,1,1,$6,$7,clock_timestamp()+interval '30 days',$8)`,
  [id, scope.tenantId, scope.principalId, queryHash, JSON.stringify([detail.id]), state.kind, state, identityChanged]);
  await client.query(`INSERT INTO package_inventory_resources
    (snapshot_id,tenant_id,principal_id,native_id,display_name,is_blocked,available_to,deployed_to,identifiers,package_data)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
  [id, scope.tenantId, scope.principalId, detail.id, saved.displayName, saved.isBlocked, saved.availableTo ?? null, saved.deployedTo ?? null,
    JSON.stringify([{ kind: "package_id", value: detail.id }]), saved]);
  return id;
}

export async function readPackageControls(database: Pick<pg.Pool, "query">, scope: Scope, ids: readonly string[]): Promise<SavedPackageControl[]> {
  validateScope(scope);
  if (!ids.length) return [];
  if (ids.length > 100 || new Set(ids).size !== ids.length || ids.some(id => !id || id.length > 512)) {
    throw new AppError(400, "invalid_targets", "Read at most 100 distinct exact package control targets.");
  }
  const rows = (await database.query(`WITH latest AS (
    SELECT DISTINCT ON (requested_ids->>0,observation_kind) id,requested_ids->>0 AS native_id,control_state,
      observed_at,expires_at,identity_revalidation_required
    FROM package_inventory_snapshots WHERE tenant_id=$1 AND principal_id=$2 AND token_mode='delegated'
      AND observation_kind IN ('block','access') AND is_current AND expires_at>clock_timestamp() AND requested_ids->>0=ANY($3::text[])
    ORDER BY requested_ids->>0,observation_kind,observed_at DESC,id DESC
  ), candidates AS (
    SELECT control.*,resource.package_data FROM latest control LEFT JOIN package_inventory_resources resource
      ON resource.snapshot_id=control.id AND resource.tenant_id=$1 AND resource.principal_id=$2 AND resource.native_id=control.native_id
    ORDER BY control.observed_at,control.id LIMIT 200
  ), sized AS (SELECT *,count(*) OVER()::int AS total,sum(octet_length(row_to_json(candidates)::text))
    OVER(ORDER BY observed_at,id) AS bytes FROM candidates)
  SELECT * FROM sized WHERE bytes<=1048576 ORDER BY observed_at,id`, [scope.tenantId, scope.principalId, ids])).rows;
  if (!rows.length) {
    const exists = (await database.query(`SELECT 1 FROM package_inventory_snapshots WHERE tenant_id=$1 AND principal_id=$2
      AND token_mode='delegated' AND observation_kind IN ('block','access') AND is_current AND expires_at>clock_timestamp()
      AND requested_ids->>0=ANY($3::text[]) LIMIT 1`, [scope.tenantId, scope.principalId, ids])).rowCount;
    if (exists) throw dataLimitError("package_control_bytes", 1_048_576, 1_048_577);
  } else if (rows[0].total !== rows.length) throw dataLimitError("package_control_bytes", 1_048_576, 1_048_577);
  encodeBatch(rows);
  return rows.map(row => {
    if (!row.package_data || row.package_data.id !== row.native_id) throw new AppError(409, "inventory_verification_failed", "The exact control receipt is incomplete.");
    return { detail: row.package_data, state: row.control_state, identityRevalidationRequired: row.identity_revalidation_required,
      observation: { snapshotId: row.id, observedAt: row.observed_at.toISOString(), expiresAt: row.expires_at.toISOString() } };
  });
}

async function readControlIdentity(client: pg.PoolClient, scope: Scope, incoming: CopilotPackageDetail) {
  const saved = (await client.query(`SELECT r.generation_id,r.identity,r.residual FROM data_scope_epochs s
    JOIN inventory_roots root ON root.scope_id=s.id AND root.current
    JOIN inventory_revisions revision ON revision.scope_id=root.scope_id AND revision.revision=root.revision
    JOIN data_generations g ON g.id=revision.generation_id
    JOIN inventory_memberships m ON m.baseline_id=root.baseline_id AND m.valid_from_revision<=root.revision
      AND (m.valid_to_revision IS NULL OR m.valid_to_revision>root.revision)
    JOIN package_record_rows r ON r.generation_id=m.generation_id AND r.identity=m.identity
    WHERE s.tenant_id=$1 AND s.principal_id=$2 AND s.source='inventory_packages' AND s.token_mode='delegated'
      AND r.identity=$3 AND g.session_epoch=s.session_epoch AND g.expires_at>clock_timestamp() AND r.expires_at>clock_timestamp()
    ORDER BY r.read_started_at DESC,r.generation_id DESC LIMIT 1`, [scope.tenantId, scope.principalId, incoming.id])).rows[0];
  if (!saved) return undefined;
  const facts: InventoryFact[] = [];
  let after = -1, bytes = Buffer.byteLength(JSON.stringify(saved.residual));
  for (;;) {
    const rows = (await client.query(`SELECT ordinal,kind,value,payload FROM inventory_facts WHERE generation_id=$1 AND identity=$2
      AND ordinal>$3 AND (kind='elementTypes' OR $4 AND (kind='elementGroup'
        OR kind='element' AND lower(payload->>'elementType') IN ('agentmetadatas','declarativecopilots','bots','customenginecopilots')))
      ORDER BY ordinal LIMIT 1`, [saved.generation_id, saved.identity, after, incoming.elementDetails !== undefined])).rows;
    if (!rows.length) break;
    encodeInventoryFactBatch(rows);
    bytes += Buffer.byteLength(JSON.stringify(rows));
    if (bytes > dataLimits.agentDefinitionWorkBytes) {
      throw dataLimitError("package_control_identity_bytes", dataLimits.agentDefinitionWorkBytes, bytes);
    }
    facts.push(...rows); after = rows.at(-1)!.ordinal;
  }
  return restoreInventoryRecord(saved.residual, facts, "packages") as CopilotPackageDetail;
}

function validateScope(scope: Scope) {
  if (!scope.tenantId || !scope.principalId) throw new AppError(403, "scope_mismatch", "Package controls require a tenant and principal.");
}
