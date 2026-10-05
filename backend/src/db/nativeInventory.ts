import type pg from "pg";
import { AppError } from "../errors.js";
import { validateQuarantineTarget } from "../services/copilotStudioQuarantine.js";
import type { InventoryQuarantineTarget } from "../types/copilotStudioQuarantine.js";
import type { InventoryIdentifier, PowerPlatformResource, PowerPlatformResourceType } from "../types/powerPlatformInventory.js";
import { currentInventorySourcesSql } from "./inventoryAuthority.js";
import { dataConnections } from "./dataConnections.js";
import { encodeBatch } from "./dataBounds.js";
import { pool } from "./pool.js";
import { normalizeNativeIdentity } from "../services/inventoryIdentity.js";

type Scope = { tenantId: string; principalId: string };
type Read = { client: pg.PoolClient; at: Date };
type NativeRow = {
  native_id: string; environment_id: string; generation_id: string; root_generation_id: string;
  observed_at: Date; expires_at: Date; residual: Omit<PowerPlatformResource, "identifiers">;
  identifiers: InventoryIdentifier[]; identifier_count: number;
  control: { environmentId: string; botId: string; provenance?: unknown } | null;
};

export class NativeInventory {
  constructor(readonly database: pg.Pool = pool) {}

  withRead<T>(work: (read: Read) => Promise<T>) {
    return dataConnections(this.database).selectedRead(async client =>
      work({ client, at: (await client.query("SELECT clock_timestamp() AS now")).rows[0].now }));
  }

  async exact(scope: Scope, nativeId: string, read: Read, snapshotId?: string, environmentId?: string) {
    const rows = (await read.client.query<NativeRow>(`WITH live AS (${currentInventorySourcesSql}), selected AS (
        SELECT source.*,r.residual,r.observed_at,r.expires_at AS record_expires_at,revision.generation_id AS root_generation_id
        FROM live source JOIN power_platform_record_rows r ON r.generation_id=source.source_generation_id AND r.identity=source.source_identity
        JOIN inventory_roots root ON root.scope_id=source.source_scope_id AND root.current
        JOIN inventory_revisions revision ON revision.scope_id=root.scope_id AND revision.revision=root.revision
        WHERE source.source='power_platform' AND r.resource_type='microsoft.copilotstudio/agents'
          AND source.normalized_native_id=$5 AND ($6::uuid IS NULL OR revision.generation_id=$6)
          AND ($7::text IS NULL OR source.normalized_environment_id=lower($7)) LIMIT 2
      ) SELECT native_id,environment_id,source_generation_id AS generation_id,root_generation_id,
        observed_at,LEAST(record_expires_at,authority_expires_at) AS expires_at,residual,
        (SELECT count(*)::int FROM inventory_facts f WHERE f.generation_id=selected.source_generation_id
          AND f.identity=selected.source_identity AND f.kind='identifier') AS identifier_count,
        (SELECT payload FROM inventory_facts f WHERE f.generation_id=selected.control_revision AND f.identity=selected.agent_id
          AND f.kind='control:quarantine' AND f.value=selected.native_id LIMIT 1) AS control,
        coalesce((SELECT jsonb_agg(jsonb_build_object('kind',kind,'value',value) ORDER BY kind,value COLLATE "C")
          FROM (SELECT kinds.kind,identifier.value FROM (VALUES('environment_id'),('cds_bot_id'),('entra_app_id'),('entra_agent_id')) kinds(kind)
          CROSS JOIN LATERAL (SELECT f.value FROM inventory_facts f
            WHERE f.generation_id=selected.source_generation_id AND f.identity=selected.source_identity
              AND f.kind='identifier' AND f.payload->>'kind'=kinds.kind ORDER BY ordinal LIMIT 2) identifier) ids),'[]'::jsonb) AS identifiers
      FROM selected`, [scope.tenantId, scope.principalId, null, read.at, normalizeNativeIdentity(nativeId), snapshotId ?? null, environmentId ?? null])).rows;
    encodeBatch(rows);
    if (!rows.length) throw new AppError(409, "quarantine_target_unavailable", "The exact target is absent from current authorized inventory. Refresh inventory.");
    if (rows.length !== 1) throw new AppError(409, "quarantine_target_ambiguous", "The native identity has multiple current memberships.");
    return rows[0];
  }

  async getResource(scope: Scope, snapshotId: string, type: PowerPlatformResourceType, environmentId: string, nativeId: string) {
    if (type !== "microsoft.copilotstudio/agents") throw new AppError(400, "invalid_inventory_selection", "Select an exact native agent.");
    return this.withRead(async read => {
      const row = await this.exact(scope, nativeId, read, snapshotId, environmentId);
      return { resource: nativeResource(row), snapshot: observation(row) };
    });
  }

  async getQuarantineSelection(scope: Scope, snapshotId: string, nativeIds: string[]) {
    validateSelection(snapshotId, nativeIds);
    return this.withRead(async read => {
      const value: PowerPlatformResource[] = [];
      let snapshot: ReturnType<typeof observation> | undefined;
      for (const nativeId of nativeIds) {
        const row = await this.exact(scope, nativeId, read, snapshotId);
        value.push(nativeResource(row));
        snapshot ??= observation(row);
      }
      encodeBatch(value);
      return { value, snapshot: snapshot! };
    });
  }

  async resolveQuarantineTargets(scope: Scope, snapshotId: string, nativeIds: readonly string[], maximumAgeMs = 86_400_000) {
    validateSelection(snapshotId, nativeIds);
    return this.withRead(async read => {
      const targets: InventoryQuarantineTarget[] = [];
      for (const nativeId of nativeIds) targets.push(nativeTarget(await this.exact(scope, nativeId, read, snapshotId), read.at, maximumAgeMs));
      return targets;
    });
  }
}

export function nativeTarget(row: NativeRow, at: Date, maximumAgeMs = 86_400_000): InventoryQuarantineTarget {
  if (row.observed_at > at || row.observed_at.getTime() < at.getTime() - maximumAgeMs || row.expires_at <= at) {
    throw new AppError(409, "quarantine_inventory_stale", "The exact native inventory evidence expired. Refresh inventory.");
  }
  const target = row.control;
  if (!target || target.environmentId !== row.environment_id) {
    throw new AppError(409, "quarantine_native_identity_unavailable", "The current inventory does not prove one exact native environment and bot identity.");
  }
  validateQuarantineTarget(target);
  return { resourceNativeId: row.native_id, displayName: row.residual.displayName ?? row.native_id,
    snapshotId: row.root_generation_id, inventoryObservedAt: row.observed_at.toISOString(), inventoryExpiresAt: row.expires_at.toISOString(),
    environmentId: target.environmentId, botId: target.botId,
    inventoryQuarantineState: typeof row.residual.details.isQuarantined === "boolean" ? row.residual.details.isQuarantined : null,
    inventoryQuarantinedAt: typeof row.residual.details.quarantinedAt === "string" ? row.residual.details.quarantinedAt : null };
}

function nativeResource(row: NativeRow): PowerPlatformResource {
  const identifiers = [...row.identifiers];
  if (row.control && !identifiers.some(value => value.kind === "cds_bot_id")) identifiers.push({ kind: "cds_bot_id", value: row.control.botId });
  return { ...row.residual, identifiers, identifierCount: row.identifier_count + identifiers.length - row.identifiers.length,
    identifiersComplete: row.identifier_count === row.identifiers.length, quarantineIdentity: row.control };
}

function observation(row: NativeRow) {
  return { id: row.root_generation_id, observedAt: row.observed_at.toISOString(), expiresAt: row.expires_at.toISOString(), current: true as const };
}

function validateSelection(snapshotId: string, nativeIds: readonly string[]) {
  if (!/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(snapshotId)
    || !Array.isArray(nativeIds) || !nativeIds.length || nativeIds.length > 25
    || nativeIds.some(value => typeof value !== "string" || !value || value.length > 512 || /[\r\n\0]/.test(value))) {
    throw new AppError(400, "invalid_quarantine_target", "Select a current source revision and 1–25 exact native identities.");
  }
  if (new Set(nativeIds).size !== nativeIds.length) throw new AppError(400, "duplicate_target", "Duplicate quarantine targets are not allowed.");
}
