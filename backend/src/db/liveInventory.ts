import type pg from "pg";
import { AppError } from "../errors.js";
import { parseUnifiedAgentRecordId, type UnifiedAgentRecord } from "../types/unifiedAgents.js";
import type { InventoryIdentifier, PowerPlatformResource } from "../types/powerPlatformInventory.js";
import { normalizeNativeIdentity, type InventoryIdentityRecord } from "../services/inventoryIdentity.js";
import { currentInventorySourcesSql } from "./inventoryAuthority.js";
import { dataConnections } from "./dataConnections.js";
import { dataLimitError, digest } from "./dataBounds.js";
import { pool } from "./pool.js";

type Scope = { tenantId: string; principalId: string };
export type LiveInventoryRead = { client: pg.PoolClient; evaluatedAt: Date };
export type LiveInventoryRecord = {
  id: string; revision: string; displayName: string; environmentId: string | null;
  identity: UnifiedAgentRecord["identity"];
  people: Partial<Record<"owner" | "createdBy" | "lastModifiedBy", string>>;
  native: null | {
    resource: Omit<PowerPlatformResource, "identifiers">;
    identifiers: InventoryIdentifier[];
    observation: { snapshotId: string; observedAt: string; expiresAt: string; current: true };
  };
};

export class LiveInventory {
  constructor(readonly database: pg.Pool = pool) {}

  withRead<T>(work: (read: LiveInventoryRead) => Promise<T>) {
    return dataConnections(this.database).selectedRead(async client =>
      work({ client, evaluatedAt: (await client.query("SELECT clock_timestamp() AS now")).rows[0].now }));
  }

  record(scope: Scope, recordId: string, read?: LiveInventoryRead): Promise<LiveInventoryRecord> {
    const target = parseUnifiedAgentRecordId(recordId);
    if (!target) throw new AppError(400, "invalid_agent_record", "Use an exact canonical or source-qualified record.");
    const load = async ({ client, evaluatedAt: at }: LiveInventoryRead) => {
      const values: unknown[] = [scope.tenantId, scope.principalId, target.source === "canonical" ? target.agentId : null, at];
      const where = target.source === "canonical" ? "true" : target.source === "graph_packages"
        ? "source='graph_packages' AND native_id=$5" : "source='power_platform' AND normalized_native_id=$5 AND normalized_environment_id=$6";
      if (target.source === "graph_packages") values.push(target.packageId);
      if (target.source === "power_platform") values.push(normalizeNativeIdentity(target.nativeId), target.environmentId?.toLowerCase() ?? "");
      const records = (await client.query(`WITH current AS (${currentInventorySourcesSql}),
        selected AS (SELECT DISTINCT agent_id,control_revision FROM current WHERE ${where} LIMIT 2)
        SELECT r.identity,r.generation_id,r.display_name,r.environment_id,r.link_state,r.residual
        FROM selected s JOIN unified_agent_rows r ON r.generation_id=s.control_revision AND r.identity=s.agent_id`, values)).rows;
      if (!records.length) throw new AppError(404, "agent_not_found", "This agent is not available in the current saved inventory.");
      if (records.length !== 1) throw new AppError(409, "inventory_identity_ambiguous", "The exact source has multiple current canonical memberships.");
      const row = records[0];
      const sources = (await client.query(`WITH current AS (${currentInventorySourcesSql})
        SELECT r.generation_id,r.identity,r.residual,r.observed_at,r.expires_at FROM current c
        JOIN power_platform_record_rows r ON r.generation_id=c.source_generation_id AND r.identity=c.source_identity
        WHERE c.source='power_platform' AND r.resource_type='microsoft.copilotstudio/agents' LIMIT 2`,
      [scope.tenantId, scope.principalId, row.identity, at])).rows;
      if (sources.length > 1) throw new AppError(409, "inventory_identity_ambiguous", "The canonical agent has multiple current native resources.");
      const resource = sources[0];
      const identifiers: InventoryIdentifier[] = resource ? (await client.query(`SELECT kinds.kind,identifier.value
        FROM (VALUES('entra_agent_id'),('entra_app_id'),('cds_bot_id')) kinds(kind)
        CROSS JOIN LATERAL (SELECT DISTINCT lower(f.value) COLLATE "C" AS value FROM inventory_facts f
          WHERE f.generation_id=$1 AND f.identity=$2 AND f.kind='identifier' AND f.payload->>'kind'=kinds.kind
          ORDER BY value LIMIT 2) identifier ORDER BY kinds.kind,identifier.value COLLATE "C"`,
      [resource.generation_id, resource.identity])).rows.map(value => ({ kind: value.kind, value: value.value })) : [];
      const people = (await client.query(`SELECT substr(kind,8) AS role,value FROM inventory_facts
        WHERE generation_id=$1 AND identity=$2 AND kind IN ('person:owner','person:createdBy','person:lastModifiedBy')
        ORDER BY kind,ordinal LIMIT 4`, [row.generation_id, row.identity])).rows;
      if (people.length > 3) throw new AppError(409, "inventory_identity_ambiguous", "The saved responsibility fields are ambiguous.");
      const record: LiveInventoryRecord = {
        id: `agent:${row.identity}`, revision: digest(JSON.stringify(["live-inventory", scope.tenantId, scope.principalId, row.identity, row.generation_id])),
        displayName: row.display_name, environmentId: row.environment_id,
        identity: { ...row.residual.identity, state: row.link_state },
        people: Object.fromEntries(people.map(value => [value.role, value.value])),
        native: resource ? { resource: resource.residual as Omit<PowerPlatformResource, "identifiers">, identifiers,
          observation: { snapshotId: resource.generation_id, observedAt: resource.observed_at.toISOString(),
            expiresAt: resource.expires_at.toISOString(), current: true } } : null,
      };
      const bytes = Buffer.byteLength(JSON.stringify(record));
      if (bytes > 524288) throw dataLimitError("inventory_live_record_bytes", 524288, bytes);
      return record;
    };
    return read ? load(read) : this.withRead(load);
  }

  async assertCurrent(scope: Scope, recordId: string, revision: string) {
    const record = await this.record(scope, recordId).catch(error => {
      if (error instanceof AppError && error.code === "agent_not_found") {
        throw new AppError(409, "inventory_changed", "The current source membership changed.");
      }
      throw error;
    });
    if (record.revision !== revision) {
      throw new AppError(409, "inventory_changed", "The current source membership changed.");
    }
  }

  identityCandidates(scope: Scope, record: LiveInventoryRecord, read?: LiveInventoryRead): Promise<InventoryIdentityRecord[]> {
    const load = async ({ client, evaluatedAt: at }: LiveInventoryRead) => {
      const result: InventoryIdentityRecord[] = [];
      for (const kind of ["entra_agent_id", "entra_app_id", "cds_bot_id"] as const) {
        const identifiers = record.native?.identifiers.filter(identifier => identifier.kind === kind) ?? [];
        if (identifiers.length !== 1) continue;
        const value = identifiers[0].value;
        const rows = (await client.query(`WITH current AS (${currentInventorySourcesSql})
          SELECT DISTINCT c.normalized_native_id COLLATE "C" AS normalized_native_id,
            c.normalized_environment_id COLLATE "C" AS normalized_environment_id,c.tenant_id
          FROM current c JOIN inventory_facts f ON f.generation_id=c.source_generation_id AND f.identity=c.source_identity
          WHERE c.source='power_platform' AND f.kind='identifier' AND f.payload->>'kind'=$5
            AND md5(lower(f.value))=md5($6) AND lower(f.value)=$6
            AND ($5<>'cds_bot_id' OR c.normalized_environment_id=$7)
          ORDER BY normalized_native_id,normalized_environment_id LIMIT 2`,
        [scope.tenantId, scope.principalId, null, at, kind, value, record.environmentId?.toLowerCase() ?? ""])).rows;
        result.push(...rows.map(row => ({ nativeId: row.normalized_native_id, environmentId: row.normalized_environment_id || null,
          tenantId: row.tenant_id, sourceSystem: "power_platform" as const, resourceType: "microsoft.copilotstudio/agents",
          identifiers: [{ kind, value }] })));
      }
      return result;
    };
    return read ? load(read) : this.withRead(load);
  }
}

export const liveInventory = new LiveInventory();
