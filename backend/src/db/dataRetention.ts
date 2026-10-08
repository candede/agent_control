import type pg from "pg";
import { exactCount } from "./dataBounds.js";
import { reportExportAudit } from "../services/reportExportAudit.js";
import { observeDataWork } from "../services/dataMetrics.js";
import { LifecycleSlice } from "./lifecycleSlice.js";

const recordTables = [
  "directory_service_plan_rows", "directory_user_rows", "app_activity_rows",
  "user_source_query_members", "user_source_queries", "user_source_skus", "user_source_identity_inputs",
  "data_generation_batches", "data_generation_pages",
] as const;

export const invalidExportSelectionSql = `EXISTS(SELECT 1 FROM data_read_selections selection
  LEFT JOIN data_principal_epochs principal ON principal.tenant_id=selection.tenant_id AND principal.principal_id=selection.principal_id
  WHERE selection.id=e.selection_id AND (selection.invalidated_at IS NOT NULL OR selection.session_epoch IS DISTINCT FROM principal.epoch
    OR EXISTS(SELECT 1 FROM data_generation_pins pin JOIN data_scope_epochs scope ON scope.id=pin.scope_id
      WHERE pin.selection_id=selection.id AND (pin.scope_epoch<>scope.epoch OR pin.session_epoch<>scope.session_epoch OR pin.expires_at<=clock_timestamp()))))`;

export async function retireUnreferencedReportVersions(client: pg.PoolClient, tenantId: string, setId: string) {
  return (await client.query(`UPDATE official_usage_versions v SET deleted_at=clock_timestamp() WHERE v.id IN (
    SELECT version_id FROM official_usage_set_versions WHERE set_id=$1 AND tenant_id=$2)
    AND v.deleted_at IS NULL AND NOT EXISTS(SELECT 1 FROM official_usage_set_versions m JOIN official_usage_sets s ON s.id=m.set_id
      WHERE m.version_id=v.id AND s.deleted_at IS NULL)`, [setId, tenantId])).rowCount ?? 0;
}

export async function retainDeletedReportRows(client: pg.PoolClient, limit = 250, scope?: { tenantId: string; setId: string }) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 250) throw new Error("data_retention_batch");
  return (await client.query(`WITH candidates AS MATERIALIZED (
    SELECT r.ctid FROM official_usage_version_rows r JOIN official_usage_versions v ON v.id=r.version_id
    WHERE v.deleted_at IS NOT NULL AND ($1::text IS NULL OR v.tenant_id=$1)
      AND ($2::uuid IS NULL OR EXISTS(SELECT 1 FROM official_usage_set_versions m WHERE m.set_id=$2 AND m.version_id=v.id))
      AND NOT EXISTS(SELECT 1 FROM official_usage_set_versions m
        JOIN official_usage_history_memberships h ON h.set_id=m.set_id AND h.tenant_id=m.tenant_id
        JOIN official_usage_history_state s ON s.tenant_id=h.tenant_id
        JOIN data_generation_pins p ON p.scope_id=s.scope_id AND p.root_kind='tenant_history'
          AND p.expires_at>clock_timestamp() AND p.revision::bigint>=h.valid_from_revision
          AND (h.valid_to_revision IS NULL OR p.revision::bigint<h.valid_to_revision)
        WHERE m.version_id=v.id)
    ORDER BY r.version_id,r.ordinal LIMIT $3
  ) DELETE FROM official_usage_version_rows r USING candidates WHERE r.ctid=candidates.ctid`,
  [scope?.tenantId ?? null, scope?.setId ?? null, limit])).rowCount ?? 0;
}

export async function retainRecordData(client: pg.PoolClient, limit = 250, sharedSlice?: LifecycleSlice): Promise<Record<string, number>> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 250) throw new Error("data_retention_batch");
  const affected: Record<string, number> = {};
  if (!(await client.query("SELECT pg_try_advisory_xact_lock(3650111) AS acquired")).rows[0].acquired) return affected;
  const slice = sharedSlice ?? new LifecycleSlice(client, limit);
  if (!sharedSlice) await slice.open();
  const backlog = (await client.query(`SELECT count(*)::text AS roots,
    greatest(0,floor(extract(epoch FROM (clock_timestamp()-min(created_at)))*1000))::text AS age
    FROM data_generations WHERE state='deleting' AND collected_at IS NULL`)).rows[0];
  observeDataWork("record_gc", { backlogRoots: exactCount(backlog.roots), oldestAgeMs: exactCount(backlog.age) });
  const remove = async (name: string, table: string, where: string) => {
    affected[name] = await slice.change(name, table, where);
  };
  const update = async (name: string, table: string, where: string, values: string, scopeCharge?: "reservation" | "collection") => {
    affected[name] = await slice.change(name, table, where, values, [], "ctid", scopeCharge);
  };
  const protectedSelection = `EXISTS(SELECT 1 FROM data_read_selections s
    LEFT JOIN data_principal_epochs p ON p.tenant_id=s.tenant_id AND p.principal_id=s.principal_id
    WHERE s.id=target.selection_id AND s.invalidated_at IS NULL AND s.session_epoch=p.epoch
      AND NOT EXISTS(SELECT 1 FROM data_generation_pins pin JOIN data_scope_epochs source ON source.id=pin.scope_id
        WHERE pin.selection_id=s.id AND (pin.scope_epoch<>source.epoch OR pin.session_epoch<>source.session_epoch
          OR pin.expires_at<=clock_timestamp()))
      AND
      ((s.expires_at>clock_timestamp())
        OR EXISTS(SELECT 1 FROM data_exports e WHERE e.selection_id=s.id
          AND e.status IN ('queued','building','ready') AND e.expires_at>clock_timestamp())))`;

  const exports = (await client.query(`SELECT id,kind,status,row_count,byte_count,actor,octet_length(row_to_json(e)::text) AS bytes FROM data_exports e
    WHERE status IN ('queued','building','ready') AND (expires_at<=clock_timestamp()
      OR (status IN ('queued','building') AND deadline_at<=clock_timestamp())
      OR (status='building' AND lease_until<=clock_timestamp()) OR ${invalidExportSelectionSql})
    ORDER BY expires_at,id LIMIT $1 FOR UPDATE SKIP LOCKED`, [Math.min(limit, 4)])).rows;
  for (const row of exports) {
    await client.query("UPDATE data_exports SET status='expired',error_code='export_expired' WHERE id=$1", [row.id]);
    if (row.status !== "ready" && row.actor) {
      await reportExportAudit(client, { id: row.id, exportId: row.id, kind: row.kind, phase: "build", status: "failed",
        rows: row.row_count, bytes: exactCount(row.byte_count), errorCode: "export_expired" });
    }
  }
  affected.recordExpiredExports = exports.length;
  slice.rows += exports.length * 2;
  slice.bytes += exports.reduce((sum, row) => sum + row.bytes + 16_384, 0);
  for (const table of ["data_export_chunks", "data_export_items"]) {
    await remove(`record_${table}`, table, `EXISTS(SELECT 1 FROM data_exports e
      WHERE e.id=target.export_id AND e.status IN ('failed','cancelled','expired'))`);
  }
  await remove("recordExportMetadata", "data_exports", `target.expires_at<=clock_timestamp()-interval '1 day'
    AND target.status IN ('failed','cancelled','expired')
    AND NOT EXISTS(SELECT 1 FROM data_export_chunks c WHERE c.export_id=target.id)
    AND NOT EXISTS(SELECT 1 FROM data_export_items i WHERE i.export_id=target.id)`);
  await remove("inventoryMutationTargets", "inventory_mutation_targets", `EXISTS(
    SELECT 1 FROM inventory_mutation_stages stage JOIN data_read_selections selection ON selection.id=stage.selection_id
    WHERE stage.id=target.stage_id AND (stage.expires_at<=clock_timestamp() OR selection.invalidated_at IS NOT NULL
      OR selection.expires_at<=clock_timestamp()))`);
  await remove("inventoryMutationStages", "inventory_mutation_stages", `(target.expires_at<=clock_timestamp()
    OR EXISTS(SELECT 1 FROM data_read_selections selection WHERE selection.id=target.selection_id
      AND (selection.invalidated_at IS NOT NULL OR selection.expires_at<=clock_timestamp())))
    AND NOT EXISTS(SELECT 1 FROM inventory_mutation_targets item WHERE item.stage_id=target.id)`);
  await update("recordInvalidSelections", "data_read_selections", `target.invalidated_at IS NULL AND (
    EXISTS(SELECT 1 FROM data_generation_pins pin JOIN data_scope_epochs source ON source.id=pin.scope_id
      WHERE pin.selection_id=target.id AND (pin.scope_epoch<>source.epoch OR pin.session_epoch<>source.session_epoch
        OR pin.expires_at<=clock_timestamp()))
    OR NOT EXISTS(SELECT 1 FROM data_principal_epochs actor WHERE actor.tenant_id=target.tenant_id
      AND actor.principal_id=target.principal_id AND actor.epoch=target.session_epoch))`, "invalidated_at=clock_timestamp()");
  await remove("recordPins", "data_generation_pins", `NOT ${protectedSelection}`);
  for (const table of ["user_source_read_contexts", "official_usage_read_contexts", "inventory_read_contexts"]) {
    await remove(`record_${table}`, table, `NOT ${protectedSelection}
      AND NOT EXISTS(SELECT 1 FROM data_generation_pins p WHERE p.selection_id=target.selection_id)`);
  }
  await remove("recordSelections", "data_read_selections", `(target.expires_at<=clock_timestamp() OR target.invalidated_at IS NOT NULL
      OR NOT EXISTS(SELECT 1 FROM data_principal_epochs p WHERE p.tenant_id=target.tenant_id
        AND p.principal_id=target.principal_id AND p.epoch=target.session_epoch))
    AND NOT EXISTS(SELECT 1 FROM data_exports e WHERE e.selection_id=target.id)
    AND NOT EXISTS(SELECT 1 FROM data_generation_pins p WHERE p.selection_id=target.id)
    AND NOT EXISTS(SELECT 1 FROM user_source_read_contexts c WHERE c.selection_id=target.id)
    AND NOT EXISTS(SELECT 1 FROM official_usage_read_contexts c WHERE c.selection_id=target.id)
    AND NOT EXISTS(SELECT 1 FROM inventory_read_contexts c WHERE c.selection_id=target.id)
    AND NOT EXISTS(SELECT 1 FROM inventory_mutation_stages stage WHERE stage.selection_id=target.id)`);

  const staleScope = `NOT EXISTS(SELECT 1 FROM data_scope_epochs s WHERE s.id=target.scope_id
    AND s.epoch=target.scope_epoch AND s.session_epoch=target.session_epoch)`;
  await update("recordAbandonedGenerations", "data_generations", `target.state IN ('staging','validating')
    AND (target.lease_until<=clock_timestamp() OR target.deadline_at<=clock_timestamp()
      OR ${staleScope})`,
  "state='failed',cancellation=target.cancellation+1,reserved_bytes=target.byte_count", "reservation");
  await update("recordAbandonedAttempts", "user_source_attempts", `target.status='running'
    AND EXISTS(SELECT 1 FROM data_generations g WHERE g.id=target.generation_id AND g.state IN ('failed','cancelled'))`,
  `status=CASE WHEN (SELECT g.state FROM data_generations g WHERE g.id=target.generation_id)='cancelled' THEN 'cancelled' ELSE 'failed' END,
    error_code='data_writer_fenced',message='Collection is no longer current. Retry with current authorization.'`);
  await update("recordExpiredGenerations", "data_generations",
    `target.state='published' AND (${staleScope} OR target.expires_at<=clock_timestamp()
      AND NOT EXISTS(SELECT 1 FROM data_generation_heads head WHERE head.generation_id=target.id))`, "state='retired'");
  await update("recordDeletingGenerations", "data_generations", `target.state IN ('retired','failed','cancelled')
    AND NOT EXISTS(SELECT 1 FROM inventory_attempts a WHERE a.generation_id=target.id)
    AND NOT EXISTS(SELECT 1 FROM inventory_mutation_targets t WHERE t.source_generation_id=target.id)
    AND NOT EXISTS(SELECT 1 FROM data_generation_pins p WHERE p.generation_id=target.id)`, "state='deleting'");
  for (const table of recordTables) {
    const children = table === "directory_user_rows" ? `AND NOT EXISTS(SELECT 1 FROM directory_service_plan_rows p
      WHERE p.generation_id=target.generation_id AND p.user_id=target.identity)`
      : table === "user_source_queries" ? `AND NOT EXISTS(SELECT 1 FROM user_source_query_members m
        WHERE m.generation_id=target.generation_id AND m.query_key=target.query_key)` : "";
    await remove(`record_${table}`, table, `EXISTS(SELECT 1 FROM data_generations g
      WHERE g.id=target.generation_id AND g.state='deleting' AND g.collected_at IS NULL) ${children}`);
  }
  const empty = recordTables.map(table => `NOT EXISTS(SELECT 1 FROM ${table} r WHERE r.generation_id=target.id)`).join(" AND ");
  await update("recordCollectedGenerations", "data_generations", `target.state='deleting' AND target.collected_at IS NULL
    AND ${empty} AND NOT EXISTS(SELECT 1 FROM data_generation_pins p WHERE p.generation_id=target.id)`, "collected_at=clock_timestamp()", "collection");
  await remove("recordOldAttempts", "user_source_attempts", `EXISTS(SELECT 1 FROM data_generations g
    JOIN data_scope_epochs s ON s.id=g.scope_id WHERE g.id=target.generation_id AND g.collected_at IS NOT NULL
      AND (g.scope_epoch<>s.epoch OR g.session_epoch<>s.session_epoch OR EXISTS(
        SELECT 1 FROM user_source_attempts newer JOIN data_generations n ON n.id=newer.generation_id
        WHERE newer.scope_id=g.scope_id AND n.scope_epoch=s.epoch AND n.session_epoch=s.session_epoch
          AND (n.created_at,n.id)>(g.created_at,g.id))))`);
  await remove("recordGenerationMetadata", "data_generations", `target.collected_at IS NOT NULL
    AND NOT EXISTS(SELECT 1 FROM inventory_mutation_targets t WHERE t.source_generation_id=target.id)
    AND NOT EXISTS(SELECT 1 FROM user_source_attempts a WHERE a.generation_id=target.id)
    AND NOT EXISTS(SELECT 1 FROM data_generation_heads h WHERE h.generation_id=target.id)
    AND NOT EXISTS(SELECT 1 FROM data_generation_pins p WHERE p.generation_id=target.id)`);
  await remove("recordDeletedReportRows", "official_usage_version_rows", `EXISTS(
    SELECT 1 FROM official_usage_versions v WHERE v.id=target.version_id AND v.deleted_at IS NOT NULL)
    AND NOT EXISTS(SELECT 1 FROM official_usage_set_versions m
      JOIN official_usage_history_memberships h ON h.set_id=m.set_id AND h.tenant_id=m.tenant_id
      JOIN official_usage_history_state s ON s.tenant_id=h.tenant_id
      JOIN data_generation_pins p ON p.scope_id=s.scope_id AND p.root_kind='tenant_history'
        AND p.expires_at>clock_timestamp() AND p.revision::bigint>=h.valid_from_revision
        AND (h.valid_to_revision IS NULL OR p.revision::bigint<h.valid_to_revision)
      WHERE m.version_id=target.version_id)`);
  if (!sharedSlice) await slice.finish();
  return affected;
}
