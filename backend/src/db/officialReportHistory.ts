import { randomUUID } from "node:crypto";
import type pg from "pg";
import { dataConnections } from "./dataConnections.js";
import { dataLimits } from "./dataBounds.js";
import { lockDataScope } from "./dataGenerations.js";
import { retireUnreferencedReportVersions } from "./dataRetention.js";
import { SelectionError, type DependencyRoot, type SelectionIdentity } from "../services/dataSelections.js";
import { readableReportVersionSql } from "./reportCapacitySchema.js";

const historyIntegritySql = `WITH snapshot_sets AS MATERIALIZED (
  SELECT s.id,s.tenant_id,s.complete,s.deleted_at,s.expires_at FROM official_usage_history_memberships m
    JOIN official_usage_sets s ON s.id=m.set_id AND s.tenant_id=m.tenant_id WHERE m.tenant_id=$1
    AND (($2::bigint IS NULL AND m.valid_to_revision IS NULL)
      OR (m.valid_from_revision<=$2 AND (m.valid_to_revision IS NULL OR m.valid_to_revision>$2)))
), snapshot_versions AS MATERIALIZED (
  SELECT DISTINCT v.id,v.tenant_id,v.kind,v.row_count,v.deleted_at,LEAST(v.expires_at,a.expires_at) AS expires_at
  FROM snapshot_sets s JOIN official_usage_set_versions m ON m.set_id=s.id AND m.tenant_id=s.tenant_id
    JOIN official_usage_versions v ON v.id=m.version_id AND v.tenant_id=m.tenant_id AND v.kind=m.kind
    JOIN official_usage_artifacts a ON a.id=v.artifact_id AND a.tenant_id=v.tenant_id
), valid_versions AS MATERIALIZED (
  SELECT v.id FROM snapshot_versions v WHERE v.deleted_at IS NULL AND (v.expires_at IS NULL OR v.expires_at>clock_timestamp())
    AND ${readableReportVersionSql("v.id","v.tenant_id","v.kind","v.row_count")}
), invalid_sets AS (
  SELECT s.id FROM snapshot_sets s WHERE NOT s.complete OR s.deleted_at IS NOT NULL OR s.expires_at<=clock_timestamp()
    OR 3<>(SELECT count(*) FROM official_usage_set_versions m JOIN valid_versions v ON v.id=m.version_id
      WHERE m.set_id=s.id AND m.tenant_id=s.tenant_id)
)`;

export class OfficialReportHistory {
  readonly connections;
  constructor(readonly database: pg.Pool) { this.connections = dataConnections(database); }

  async prepareRead(client: pg.PoolClient, tenantId: string) {
    const large = (await client.query(`SELECT COALESCE(sum(v.row_count),0)>$2::integer AS large
      FROM official_usage_history_memberships h JOIN official_usage_set_versions m
        ON m.set_id=h.set_id AND m.tenant_id=h.tenant_id
      JOIN official_usage_versions v ON v.id=m.version_id AND v.tenant_id=m.tenant_id AND v.kind=m.kind
      WHERE h.tenant_id=$1 AND h.valid_to_revision IS NULL`, [tenantId, dataLimits.batchRows])).rows[0].large as boolean;
    await client.query("SELECT set_config('jit','off',true)"
      + (large ? ",set_config('enable_nestloop','off',true),set_config('enable_mergejoin','off',true)" : ""));
  }

  ensure(tenantId: string) {
    return this.connections.run(async client => {
      const inserted = (await client.query(`INSERT INTO data_scope_epochs(id,tenant_id,scope_kind,principal_id,token_mode,source,selector)
        VALUES($1,$2,'tenant',NULL,'tenant','official_history','complete')
        ON CONFLICT(tenant_id,scope_kind,principal_id,token_mode,source,selector) DO NOTHING RETURNING id`,
      [randomUUID(), tenantId])).rows[0];
      const scope = (inserted ?? (await client.query(`SELECT id FROM data_scope_epochs WHERE tenant_id=$1
        AND scope_kind='tenant' AND principal_id IS NULL AND token_mode='tenant' AND source='official_history' AND selector='complete'`,
      [tenantId])).rows[0])?.id as string | undefined;
      if (!scope) throw new Error("official_history_scope_missing");
      await client.query(`INSERT INTO official_usage_history_state(tenant_id,scope_id) VALUES($1,$2) ON CONFLICT DO NOTHING`, [tenantId, scope]);
      return scope;
    });
  }

  async root(client: pg.PoolClient, tenantId: string, evaluatedAt: Date): Promise<DependencyRoot> {
    await this.prepareRead(client, tenantId);
    const state = (await client.query(`SELECT scope_id,revision::text FROM official_usage_history_state WHERE tenant_id=$1`, [tenantId])).rows[0];
    if (!state) throw new SelectionError("selection_invalidated");
    const expiry = (await client.query(`SELECT min(LEAST(s.expires_at,v.expires_at,a.expires_at)) AS expiry FROM official_usage_history_memberships m
      JOIN official_usage_sets s ON s.id=m.set_id AND s.tenant_id=m.tenant_id
      JOIN official_usage_set_versions sv ON sv.set_id=s.id AND sv.tenant_id=s.tenant_id
      JOIN official_usage_versions v ON v.id=sv.version_id AND v.tenant_id=s.tenant_id
      JOIN official_usage_artifacts a ON a.id=v.artifact_id AND a.tenant_id=v.tenant_id
      WHERE m.tenant_id=$1 AND m.valid_to_revision IS NULL AND LEAST(s.expires_at,v.expires_at,a.expires_at)>$2`, [tenantId, evaluatedAt])).rows[0].expiry as Date | null;
    return { kind: "tenant_history", scopeId: state.scope_id, revision: state.revision,
      expiresAt: new Date(Math.min(evaluatedAt.getTime() + 30 * 60_000, expiry?.getTime() ?? Infinity)) };
  }

  async validateRoot(client: pg.PoolClient, root: DependencyRoot, identity: SelectionIdentity) {
    if (root.kind !== "tenant_history") throw new SelectionError("selection_invalidated");
    const state = (await client.query(`SELECT h.revision FROM official_usage_history_state h JOIN data_scope_epochs s ON s.id=h.scope_id
      WHERE h.tenant_id=$1 AND h.scope_id=$2 AND h.revision>=$3::bigint AND h.invalidation_epoch=s.epoch
        AND s.scope_kind='tenant' AND s.principal_id IS NULL AND s.source='official_history'`,
    [identity.tenantId, root.scopeId, root.revision])).rows[0];
    if (!state || root.expiresAt <= new Date()) throw new SelectionError("selection_invalidated");
    await this.prepareRead(client, identity.tenantId);
    const expired = await client.query(`${historyIntegritySql} SELECT id FROM invalid_sets LIMIT 1`, [identity.tenantId, root.revision]);
    if (expired.rowCount) throw new SelectionError("selection_invalidated");
  }

  // Caller holds this tenant scope BEFORE the report head. No imported actor
  // condition belongs in tenant history visibility.
  async lock(client: pg.PoolClient, tenantId: string) {
    const row = (await client.query("SELECT scope_id FROM official_usage_history_state WHERE tenant_id=$1", [tenantId])).rows[0];
    if (!row) throw new Error("official_history_not_initialized");
    await lockDataScope(client, row.scope_id, tenantId);
    return row.scope_id as string;
  }

  async accepted(client: pg.PoolClient, tenantId: string, setId: string, correctionOf?: string | null) {
    const scopeId = await this.lock(client, tenantId);
    const existing = await client.query(`SELECT 1 FROM official_usage_history_memberships WHERE tenant_id=$1 AND set_id=$2 AND valid_to_revision IS NULL`,
      [tenantId, setId]);
    if (existing.rowCount) return;
    const revision = (await client.query(`UPDATE official_usage_history_state SET revision=revision+1,
      invalidation_epoch=invalidation_epoch+$2 WHERE tenant_id=$1 RETURNING revision::text`,
    [tenantId, correctionOf ? 1 : 0])).rows[0].revision as string;
    if (correctionOf) {
      await client.query("UPDATE data_scope_epochs SET epoch=epoch+1 WHERE id=$1", [scopeId]);
      await client.query(`UPDATE official_usage_history_memberships SET valid_to_revision=$3
        WHERE tenant_id=$1 AND set_id=$2 AND valid_to_revision IS NULL`, [tenantId, correctionOf, revision]);
      await client.query(`INSERT INTO official_usage_history_memberships(tenant_id,set_id,valid_from_revision,visibility)
        VALUES($1,$2,$3,'superseded')`, [tenantId, correctionOf, revision]);
    }
    await client.query(`INSERT INTO official_usage_history_memberships(tenant_id,set_id,valid_from_revision,visibility)
      VALUES($1,$2,$3,'retained')`, [tenantId, setId, revision]);
  }

  async invalidate(client: pg.PoolClient, tenantId: string, setId: string, remove: boolean) {
    const scopeId = await this.lock(client, tenantId);
    const revision = (await client.query(`UPDATE official_usage_history_state SET revision=revision+1,
      invalidation_epoch=invalidation_epoch+1 WHERE tenant_id=$1 RETURNING revision::text`, [tenantId])).rows[0].revision;
    await client.query("UPDATE data_scope_epochs SET epoch=epoch+1 WHERE id=$1", [scopeId]);
    await client.query(`UPDATE official_usage_history_memberships SET valid_to_revision=$3
      WHERE tenant_id=$1 AND set_id=$2 AND valid_to_revision IS NULL`, [tenantId, setId, revision]);
    if (!remove) await client.query(`INSERT INTO official_usage_history_memberships(tenant_id,set_id,valid_from_revision,visibility)
      VALUES($1,$2,$3,'retained')`, [tenantId, setId, revision]);
  }

  async expire(tenantId: string) {
    return this.connections.run(async client => {
      await client.query("SET LOCAL transaction_timeout='5s'; SET LOCAL statement_timeout='5s'");
      return this.expireInTransaction(client, tenantId);
    });
  }
  async expireInTransaction(client: pg.PoolClient, tenantId: string, limit = 4) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 4) throw new Error("official_history_expiry_batch");
      await this.lock(client, tenantId);
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`official-usage:${tenantId}`]);
      await this.prepareRead(client, tenantId);
      const rows = (await client.query(`${historyIntegritySql} SELECT id FROM invalid_sets ORDER BY id LIMIT $3`, [tenantId, null, limit])).rows;
      for (const row of rows) {
        await this.invalidate(client, tenantId, row.id, true);
        await client.query("UPDATE official_usage_sets SET deleted_at=COALESCE(deleted_at,clock_timestamp()) WHERE id=$1", [row.id]);
        await retireUnreferencedReportVersions(client, tenantId, row.id);
        await client.query(`UPDATE official_usage_state SET active_set_id=NULL,revision=revision+1,updated_at=clock_timestamp()
          WHERE tenant_id=$1 AND active_set_id=$2`, [tenantId, row.id]);
      }
      return rows.length;
  }

  collect(tenantId: string) {
    return this.connections.run(async client => {
      await client.query("SET LOCAL transaction_timeout='5s'; SET LOCAL statement_timeout='5s'");
      return this.collectInTransaction(client, tenantId);
    });
  }
  async collectInTransaction(client: pg.PoolClient, tenantId: string) {
      await this.lock(client, tenantId);
      return (await client.query(`DELETE FROM official_usage_history_memberships m WHERE (tenant_id,set_id,valid_from_revision) IN (
        SELECT h.tenant_id,h.set_id,h.valid_from_revision FROM official_usage_history_memberships h
        JOIN official_usage_history_state s ON s.tenant_id=h.tenant_id
        WHERE h.tenant_id=$1 AND h.valid_to_revision IS NOT NULL AND NOT EXISTS(
          SELECT 1 FROM data_generation_pins p WHERE p.scope_id=s.scope_id AND p.root_kind='tenant_history'
            AND p.expires_at>clock_timestamp() AND p.revision::bigint>=h.valid_from_revision AND p.revision::bigint<h.valid_to_revision)
        ORDER BY h.valid_to_revision,h.set_id LIMIT 100)`, [tenantId])).rowCount ?? 0;
  }
}

export const readableHistorySql = `SELECT s.*,m.visibility FROM official_usage_history_memberships m
  JOIN official_usage_sets s ON s.id=m.set_id AND s.tenant_id=m.tenant_id
  WHERE m.tenant_id=$1 AND m.valid_from_revision<=$2::bigint
    AND (m.valid_to_revision IS NULL OR m.valid_to_revision>$2::bigint)`;
