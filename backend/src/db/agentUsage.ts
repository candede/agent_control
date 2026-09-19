import type pg from "pg";
import { AppError } from "../errors.js";
import { normalizeNativeIdentity } from "../services/inventoryIdentity.js";
import type { AgentUsageTarget } from "../types/agentUsage.js";
import type { PublishedOfficialUsage } from "../types/officialUsage.js";
import { parseUnifiedAgentRecordId, type UnifiedAgentTarget } from "../types/unifiedAgents.js";
import { OfficialUsageRepository } from "./officialUsage.js";
import { PackageInventoryRepository } from "./packageInventory.js";
import { PowerPlatformInventoryRepository } from "./powerPlatformInventory.js";
import { pool, transaction } from "./pool.js";

export type AgentUsageScope = { tenantId: string; principalId: string };
export type AgentUsageSource = {
  source: AgentUsageTarget["source"];
  native_id: string;
  environment_id: string;
  normalized_native_id: string;
  normalized_environment_id: string;
};
export type StoredAgentUsageAssociation = AgentUsageSource & {
  report_agent_id: string;
  reviewed_at: Date;
};
export type AuthorizedAgentUsageSource = AgentUsageSource & {
  agent_id: string;
  package_snapshot_id: string | null;
  power_platform_snapshot_id: string | null;
  expires_at: Date;
};
export type AgentUsageSnapshot = {
  published: PublishedOfficialUsage;
  associations: StoredAgentUsageAssociation[];
  associationRevision: string;
  now: Date;
  expiresAt: Date | null;
};
export type AuthorizedUsageRecord = {
  id: string;
  sources: AuthorizedAgentUsageSource[];
};

export class AgentUsageRepository {
  private readonly official: OfficialUsageRepository;

  constructor(readonly database: pg.Pool = pool) {
    this.official = new OfficialUsageRepository(database);
  }

  async withSnapshot<T>(scope: AgentUsageScope, work: (client: pg.PoolClient) => Promise<T>, database?: pg.PoolClient) {
    validateScope(scope);
    const run = async (client: pg.PoolClient) => {
      for (const key of [
        `package-refresh:${scope.tenantId}:${scope.principalId}`,
        `power-platform:${scope.tenantId}:${scope.principalId}`,
        `official-usage:${scope.tenantId}`,
      ]) await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [key]);
      return work(client);
    };
    return database ? run(database) : transaction(this.database, run);
  }

  async read(scope: AgentUsageScope, client: pg.PoolClient): Promise<AgentUsageSnapshot> {
    // Report mutations take the tenant advisory lock; row locks also fence operator retention.
    const sets = await client.query<{ expires_at: Date | null }>(`
      SELECT report_set.expires_at FROM official_usage_state state
      JOIN official_usage_sets report_set ON report_set.id=state.active_set_id AND report_set.tenant_id=state.tenant_id
      WHERE state.tenant_id=$1 FOR SHARE OF report_set`, [scope.tenantId]);
    const versions = await client.query<{ version_expiry: Date | null; artifact_expiry: Date | null }>(`
      SELECT version.expires_at AS version_expiry,artifact.expires_at AS artifact_expiry
      FROM official_usage_state state
      JOIN official_usage_set_versions membership ON membership.set_id=state.active_set_id AND membership.tenant_id=state.tenant_id
      JOIN official_usage_versions version ON version.id=membership.version_id
        AND version.tenant_id=membership.tenant_id AND version.kind=membership.kind
      JOIN official_usage_artifacts artifact ON artifact.id=version.artifact_id
        AND artifact.tenant_id=version.tenant_id AND artifact.kind=version.kind
      WHERE state.tenant_id=$1 ORDER BY version.id FOR SHARE OF version,artifact`, [scope.tenantId]);
    const published = await this.official.getPublishedInTransaction(scope.tenantId, client, undefined, { respectExpiry: true });
    const associations = published.activeSet
      ? (await client.query<StoredAgentUsageAssociation>(`
          SELECT report_agent_id,source,native_id,environment_id,normalized_native_id,normalized_environment_id,reviewed_at
          FROM agent_usage_associations WHERE tenant_id=$1 AND report_set_id=$2
          ORDER BY report_agent_id COLLATE "C"`, [scope.tenantId, published.activeSet.id])).rows
      : [];
    const state = (await client.query<{ revision: string }>(
      "SELECT revision::text AS revision FROM agent_usage_state WHERE tenant_id=$1", [scope.tenantId])).rows[0];
    const now = (await client.query<{ now: Date }>("SELECT clock_timestamp() AS now")).rows[0].now;
    const expiries = [...sets.rows.map(row => row.expires_at),
      ...versions.rows.flatMap(row => [row.version_expiry, row.artifact_expiry])]
      .filter((value): value is Date => value !== null);
    const expiresAt = published.activeSet && expiries.length
      ? new Date(Math.min(...expiries.map(value => value.getTime()))) : null;
    if (expiresAt && expiresAt <= now) throw usageChanged();
    return { published, associations, associationRevision: state?.revision ?? "0", now, expiresAt };
  }

  async readSources(scope: AgentUsageScope, client: pg.PoolClient): Promise<AuthorizedAgentUsageSource[]> {
    for (const table of ["package_inventory_snapshots", "power_platform_inventory_snapshots"]) {
      await client.query(`SELECT id FROM ${table}
        WHERE tenant_id=$1 AND principal_id=$2 AND is_current AND expires_at>clock_timestamp()
        ORDER BY id FOR SHARE`, [scope.tenantId, scope.principalId]);
    }
    const result = await client.query<AuthorizedAgentUsageSource>(`
      SELECT membership.agent_id,membership.source,membership.native_id,membership.environment_id,
        membership.normalized_native_id,membership.normalized_environment_id,
        membership.package_snapshot_id,membership.power_platform_snapshot_id,
        COALESCE(package.expires_at,native.expires_at) AS expires_at
      FROM unified_agent_sources membership
      LEFT JOIN package_inventory_snapshots package ON package.id=membership.package_snapshot_id
        AND package.tenant_id=membership.tenant_id AND package.principal_id=membership.principal_id
      LEFT JOIN power_platform_inventory_snapshots native ON native.id=membership.power_platform_snapshot_id
        AND native.tenant_id=membership.tenant_id AND native.principal_id=membership.principal_id
      WHERE membership.tenant_id=$1 AND membership.principal_id=$2
        AND ((membership.source='graph_packages' AND package.is_current AND package.token_mode='delegated'
          AND package.expires_at>clock_timestamp())
          OR (membership.source='power_platform' AND native.is_current AND native.expires_at>clock_timestamp()
            AND native.queried_types @> '["microsoft.copilotstudio/agents"]'::jsonb))
      ORDER BY membership.agent_id,membership.source,membership.normalized_environment_id,membership.normalized_native_id
      LIMIT 10001`, [scope.tenantId, scope.principalId]);
    if (result.rows.length > 10_000) throw new AppError(409, "source_result_limit", "The authorized source inventory exceeds the association limit.");
    return result.rows;
  }

  async resolveRecord(scope: AgentUsageScope, recordId: string, client: pg.PoolClient): Promise<AuthorizedUsageRecord> {
    const target = parseRecordId(recordId);
    const sources = await this.readSources(scope, client);
    const targetKey = target.source === "canonical" ? null : await this.targetKey(target, client);
    const selected = sources.find(source => target.source === "canonical"
      ? source.agent_id === target.agentId : agentUsageSourceKey(source) === targetKey);
    if (!selected) throw recordNotFound();
    const members = sources.filter(source => source.agent_id === selected.agent_id);
    const [packages, powerPlatform] = await Promise.all([
      new PackageInventoryRepository(this.database).readUnifiedSource(scope, client),
      new PowerPlatformInventoryRepository(this.database).readUnifiedSource(scope, client),
    ]);
    const packageIds = new Set(packages.packages.map(value => value.id));
    const nativeIds = new Map(powerPlatform.resources.map(value => [
      JSON.stringify([value.environmentId ?? "", value.nativeId]), value,
    ]));
    const coverage = powerPlatform.snapshot?.coverage.find(item => item.type === "microsoft.copilotstudio/agents");
    for (const member of members) {
      if (member.source === "graph_packages") {
        if (!packages.snapshot || !packageIds.has(member.native_id)
          || packages.observations[member.native_id]?.snapshotId !== member.package_snapshot_id) throw recordNotFound();
      } else if (!powerPlatform.snapshot || coverage?.status === "not_authorized_scope"
        || coverage?.status === "unknown" || powerPlatform.snapshot.id !== member.power_platform_snapshot_id
        || !nativeIds.has(JSON.stringify([member.environment_id, member.native_id]))) throw recordNotFound();
    }
    return { id: `agent:${selected.agent_id}`, sources: members };
  }

  async targetKey(target: AgentUsageTarget, client: pg.PoolClient) {
    if (target.source === "graph_packages") return JSON.stringify([target.source, "", target.packageId]);
    const normalized = (await client.query<{ environment_id: string }>(
      "SELECT lower($1::text) AS environment_id", [target.environmentId ?? ""])).rows[0].environment_id;
    return JSON.stringify([target.source, normalized, normalizeNativeIdentity(target.nativeId)]);
  }

  async insert(scope: AgentUsageScope, reportSetId: string, reportAgentId: string, source: AgentUsageSource, client: pg.PoolClient) {
    await client.query(`INSERT INTO agent_usage_associations(
      tenant_id,report_set_id,report_agent_id,source,native_id,environment_id,reviewed_by)
      VALUES($1,$2,$3,$4,$5,$6,$7)`,
    [scope.tenantId, reportSetId, reportAgentId, source.source, source.native_id, source.environment_id, scope.principalId]);
  }

  async remove(scope: AgentUsageScope, reportSetId: string, reportAgentId: string, client: pg.PoolClient) {
    const removed = await client.query(`DELETE FROM agent_usage_associations
      WHERE tenant_id=$1 AND report_set_id=$2 AND report_agent_id=$3`, [scope.tenantId, reportSetId, reportAgentId]);
    if (removed.rowCount !== 1) throw new AppError(404, "usage_association_not_found", "The reviewed usage association was not found.");
  }
}

export function agentUsageSourceKey(value: AgentUsageSource) {
  return JSON.stringify([value.source, value.normalized_environment_id, value.normalized_native_id]);
}

export function agentUsageTarget(value: AgentUsageSource): AgentUsageTarget {
  return value.source === "graph_packages" ? { source: value.source, packageId: value.native_id }
    : { source: value.source, nativeId: value.native_id, environmentId: value.environment_id || null };
}

export function parseRecordId(value: string): UnifiedAgentTarget {
  try {
    if (typeof value !== "string" || !value || value.length > 10_000 || /[\u0000-\u001f\u007f]/.test(value)) throw new Error();
    const target = parseUnifiedAgentRecordId(value);
    if (target) {
      const ids = target.source === "canonical" ? [target.agentId]
        : target.source === "graph_packages" ? [target.packageId] : [target.nativeId, ...(target.environmentId ? [target.environmentId] : [])];
      if (ids.every(id => id === id.trim() && id.length > 0 && !/[\u0000-\u001f\u007f]/.test(id))) return target;
    }
  } catch { /* Invalid encodings must not reach database lookups. */ }
  throw new AppError(400, "invalid_agent_usage_record", "Select an exact canonical or source-qualified agent reference.");
}

export function usageChanged() {
  return new AppError(409, "agent_usage_changed", "The accepted report or reviewed associations changed or expired. Refresh Agents and review the association again.");
}

function recordNotFound() {
  return new AppError(404, "agent_not_found", "The exact agent is absent from the current authorized saved inventory. Refresh Agents first.");
}

function validateScope(scope: AgentUsageScope) {
  if (!scope.tenantId || scope.tenantId.length > 128 || !scope.principalId || scope.principalId.length > 256) {
    throw new AppError(403, "scope_mismatch", "Usage associations require an authorized tenant and principal.");
  }
}
