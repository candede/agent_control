import { randomUUID } from "node:crypto";
import type pg from "pg";
import { AppError } from "../errors.js";
import { normalizeNativeIdentity, powerPlatformAgentKey } from "../services/inventoryIdentity.js";
import type {
  UnifiedAgentLinkEvidence,
  UnifiedAgentRecord,
  UnifiedAgentSource,
  UnifiedAgentSourceObservation,
} from "../types/unifiedAgents.js";
import { pool, transaction } from "./pool.js";

export type UnifiedAgentRegistryScope = { tenantId: string; principalId: string };

type SourceIdentity = {
  source: UnifiedAgentSource;
  normalized_environment_id: string;
  normalized_native_id: string;
};
type SourceInput = SourceIdentity & {
  environment_id: string;
  native_id: string;
  package_snapshot_id: string | null;
  power_platform_snapshot_id: string | null;
  matching_evidence: UnifiedAgentLinkEvidence[];
};
type StoredSource = SourceIdentity & { agent_id: string };
type Group = { index: number; record: UnifiedAgentRecord; sources: SourceInput[]; sortKey: string };

const sourceLimit = 5_000;
const batchSize = 1_000;
const evidenceLimit = 16_384;
const evidenceKinds = new Set<UnifiedAgentLinkEvidence["kind"]>([
  "entra_agent_id", "environment_entra_app_id", "environment_cds_bot_id",
  "environment_schema_native_id", "manifest_schema_native_id", "shared_custom_engine_bot_id",
]);

export class UnifiedAgentRegistry {
  private readonly snapshots = new WeakMap<pg.PoolClient, UnifiedAgentRegistryScope>();

  constructor(private readonly database: pg.Pool = pool) {}

  async withSnapshot<T>(scope: UnifiedAgentRegistryScope, work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    validateScope(scope);
    const lockedScope = { ...scope };
    return transaction(this.database, async client => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`package-refresh:${lockedScope.tenantId}:${lockedScope.principalId}`]);
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`power-platform:${lockedScope.tenantId}:${lockedScope.principalId}`]);
      this.snapshots.set(client, lockedScope);
      try {
        return await work(client);
      } finally {
        this.snapshots.delete(client);
      }
    });
  }

  async reconcile(
    client: pg.PoolClient,
    scope: UnifiedAgentRegistryScope,
    records: readonly UnifiedAgentRecord[],
  ): Promise<UnifiedAgentRecord[]> {
    validateScope(scope);
    const lockedScope = this.snapshots.get(client);
    if (lockedScope?.tenantId !== scope.tenantId || lockedScope.principalId !== scope.principalId) {
      throw new AppError(500, "unified_agent_snapshot_required", "Canonical reconciliation requires this scope's locked source transaction.");
    }
    const groups = await sourceGroups(client, scope, records);
    const sources = groups.flatMap(group => group.sources);
    await lockObservations(client, scope, sources);
    // Separate scoped reads avoid quadratic join plans while a newly populated cache has stale statistics.
    const agents = await client.query<{ id: string }>(`SELECT id FROM unified_agents
      WHERE tenant_id=$1 AND principal_id=$2 ORDER BY created_at,id FOR UPDATE`, [scope.tenantId, scope.principalId]);
    const memberships = await client.query<StoredSource>(`SELECT source,
        normalized_environment_id,normalized_native_id,agent_id FROM unified_agent_sources
      WHERE tenant_id=$1 AND principal_id=$2
      ORDER BY source,normalized_environment_id,normalized_native_id FOR UPDATE`, [scope.tenantId, scope.principalId]);
    const byAgent = new Map<string, StoredSource[]>();
    for (const membership of memberships.rows) {
      const values = byAgent.get(membership.agent_id) ?? [];
      values.push(membership);
      byAgent.set(membership.agent_id, values);
    }
    const existing = agents.rows.flatMap(agent => byAgent.get(agent.id) ?? []);
    if (existing.length !== memberships.rows.length) invalidRecord("A canonical source has no parent in its authorized scope.");
    const previous = new Map(existing.map(value => [sourceKey(value), value.agent_id]));
    const survivors = assignSurvivors(groups, existing, previous);
    const newIds: string[] = [];
    const resolved = groups.map(group => {
      let agentId = survivors.get(group.index);
      if (!agentId) {
        agentId = randomUUID();
        newIds.push(agentId);
      }
      return { ...group, agentId };
    });
    if (newIds.length) {
      await client.query(`INSERT INTO unified_agents(id,tenant_id,principal_id)
        SELECT id,$1,$2 FROM unnest($3::uuid[]) AS ids(id)`, [scope.tenantId, scope.principalId, newIds]);
    }
    const desired = resolved.flatMap(group => group.sources.map(source => ({ ...source, agent_id: group.agentId })));
    const wanted = new Set(desired.map(sourceKey));
    const stale = existing.filter(source => !wanted.has(sourceKey(source)));
    const changedAgents = new Set<string>();
    for (let offset = 0; offset < stale.length; offset += batchSize) {
      const removed = await client.query<{ agent_id: string }>(`DELETE FROM unified_agent_sources membership
        USING jsonb_to_recordset($3::jsonb) AS stale(source text,normalized_environment_id text,normalized_native_id text)
        WHERE membership.tenant_id=$1 AND membership.principal_id=$2 AND membership.source=stale.source
          AND membership.normalized_environment_id=stale.normalized_environment_id
          AND membership.normalized_native_id=stale.normalized_native_id
        RETURNING membership.agent_id`, [scope.tenantId, scope.principalId, JSON.stringify(stale.slice(offset, offset + batchSize))]);
      for (const value of removed.rows) changedAgents.add(value.agent_id);
    }
    for (let offset = 0; offset < desired.length; offset += batchSize) {
      const changed = await client.query<StoredSource>(`INSERT INTO unified_agent_sources AS membership(
          tenant_id,principal_id,agent_id,source,environment_id,native_id,package_snapshot_id,power_platform_snapshot_id,matching_evidence)
        SELECT $1,$2,desired.agent_id,desired.source,desired.environment_id,desired.native_id,
          desired.package_snapshot_id,desired.power_platform_snapshot_id,desired.matching_evidence
        FROM jsonb_to_recordset($3::jsonb) AS desired(agent_id uuid,source text,environment_id text,native_id text,
          package_snapshot_id uuid,power_platform_snapshot_id uuid,matching_evidence jsonb)
        ON CONFLICT(tenant_id,principal_id,source,normalized_environment_id,normalized_native_id) DO UPDATE SET
          agent_id=EXCLUDED.agent_id,environment_id=EXCLUDED.environment_id,native_id=EXCLUDED.native_id,
          package_snapshot_id=EXCLUDED.package_snapshot_id,power_platform_snapshot_id=EXCLUDED.power_platform_snapshot_id,
          matching_evidence=EXCLUDED.matching_evidence,updated_at=clock_timestamp()
        WHERE (membership.agent_id,membership.environment_id,membership.native_id,membership.package_snapshot_id,
            membership.power_platform_snapshot_id,membership.matching_evidence)
          IS DISTINCT FROM (EXCLUDED.agent_id,EXCLUDED.environment_id,EXCLUDED.native_id,EXCLUDED.package_snapshot_id,
            EXCLUDED.power_platform_snapshot_id,EXCLUDED.matching_evidence)
        RETURNING agent_id,source,normalized_environment_id,normalized_native_id`,
      [scope.tenantId, scope.principalId, JSON.stringify(desired.slice(offset, offset + batchSize))]);
      for (const value of changed.rows) {
        changedAgents.add(value.agent_id);
        const oldAgent = previous.get(sourceKey(value));
        if (oldAgent) changedAgents.add(oldAgent);
      }
    }
    if (changedAgents.size) {
      await client.query(`UPDATE unified_agents agent SET updated_at=clock_timestamp()
        WHERE tenant_id=$1 AND principal_id=$2 AND id=ANY($3::uuid[])`,
      [scope.tenantId, scope.principalId, [...changedAgents]]);
    }
    await client.query(`DELETE FROM unified_agents WHERE tenant_id=$1 AND principal_id=$2 AND NOT (id=ANY($3::uuid[]))`,
    [scope.tenantId, scope.principalId, resolved.map(group => group.agentId)]);
    return resolved.sort((left, right) => left.index - right.index)
      .map(group => ({ ...group.record, id: `agent:${group.agentId}` }));
  }
}

async function lockObservations(client: pg.PoolClient, scope: UnifiedAgentRegistryScope, sources: SourceInput[]) {
  const packages = [...new Set(sources.flatMap(source => source.package_snapshot_id ? [source.package_snapshot_id] : []))];
  const powerPlatform = [...new Set(sources.flatMap(source => source.power_platform_snapshot_id ? [source.power_platform_snapshot_id] : []))];
  for (const [table, ids] of [
    ["package_inventory_snapshots", packages], ["power_platform_inventory_snapshots", powerPlatform],
  ] as const) {
    if (!ids.length) continue;
    const result = await client.query(`SELECT id FROM ${table}
      WHERE tenant_id=$1 AND principal_id=$2 AND id=ANY($3::uuid[]) AND is_current AND expires_at>clock_timestamp()
      ORDER BY id FOR KEY SHARE`, [scope.tenantId, scope.principalId, ids]);
    if (result.rowCount !== ids.length) {
      invalidRecord("Every canonical source requires an existing, current, unexpired observation in the authorized scope.");
    }
  }
}

async function sourceGroups(client: pg.PoolClient, scope: UnifiedAgentRegistryScope, records: readonly UnifiedAgentRecord[]): Promise<Group[]> {
  if (records.length > sourceLimit * 2) invalidRecord("Canonical inventory exceeds the complete source bounds.");
  const environments = [...new Set(records.flatMap(record => record.powerPlatformResource
    ? [record.powerPlatformResource.environmentId ?? ""] : []))];
  if (environments.some(value => !validText(value, 512, true))) invalidRecord("Canonical Power Platform environments are invalid.");
  // PostgreSQL and JavaScript differ on some Unicode lowercase mappings; use the generated index's rules.
  const normalizedEnvironments = new Map(environments.length ? (await client.query<{
    environment_id: string; normalized_environment_id: string;
  }>(`SELECT environment_id,lower(environment_id) AS normalized_environment_id
    FROM unnest($1::text[]) AS environments(environment_id)`, [environments])).rows
    .map(value => [value.environment_id, value.normalized_environment_id]) : []);
  const seen = new Set<string>();
  const counts = { graph_packages: 0, power_platform: 0 };
  return records.map((record, index) => {
    const sources: SourceInput[] = [];
    const packageIds = new Set(record.packages.map(value => value.id));
    const evidence = new Map<string, UnifiedAgentLinkEvidence[]>();
    for (const item of record.identity.packageEvidence) {
      if (!packageIds.has(item.packageId) || evidence.has(item.packageId)) {
        invalidRecord("Package matching evidence must identify a single package in its canonical row.");
      }
      evidence.set(item.packageId, matchingEvidence(item.evidence));
    }
    for (const value of record.packages) {
      if (!validText(value.id, 512)) invalidRecord("Canonical Graph sources require an exact opaque package ID.");
      const observation = Object.hasOwn(record.observations.packageSnapshots, value.id)
        ? record.observations.packageSnapshots[value.id] : undefined;
      sources.push({
        source: "graph_packages", environment_id: "", normalized_environment_id: "",
        native_id: value.id, normalized_native_id: value.id,
        package_snapshot_id: snapshotId(observation), power_platform_snapshot_id: null,
        matching_evidence: evidence.get(value.id) ?? [],
      });
    }
    const resource = record.powerPlatformResource;
    if (resource) {
      if (normalizeNativeIdentity(resource.tenantId) !== normalizeNativeIdentity(scope.tenantId)) {
        throw new AppError(403, "scope_mismatch", "A canonical Power Platform resource belongs to another tenant.");
      }
      if (resource.sourceSystem !== "power_platform" || resource.type !== "microsoft.copilotstudio/agents"
        || !validText(resource.nativeId, 512) || !validText(resource.environmentId ?? "", 512, true)) {
        invalidRecord("Canonical Power Platform sources require an exact agent environment and native ID.");
      }
      const normalizedEnvironment = normalizedEnvironments.get(resource.environmentId ?? "");
      if (normalizedEnvironment === undefined) throw new Error("Canonical environment normalization lost an observed environment.");
      sources.push({
        source: "power_platform", environment_id: resource.environmentId ?? "",
        normalized_environment_id: normalizedEnvironment,
        native_id: resource.nativeId, normalized_native_id: normalizeNativeIdentity(resource.nativeId),
        package_snapshot_id: null, power_platform_snapshot_id: snapshotId(record.observations.powerPlatform),
        matching_evidence: [],
      });
    }
    if (!sources.length) invalidRecord("Every canonical row must contain at least one observed source.");
    for (const source of sources) {
      const key = sourceKey(source);
      if (seen.has(key)) invalidRecord("A source record cannot belong to multiple canonical memberships.");
      seen.add(key);
      if (++counts[source.source] > sourceLimit) invalidRecord("Canonical inventory exceeds the complete source bounds.");
    }
    sources.sort((left, right) => ordinal(sourceKey(left), sourceKey(right)));
    return { index, record, sources, sortKey: JSON.stringify(sources.map(sourceKey)) };
  }).sort((left, right) => ordinal(left.sortKey, right.sortKey) || ordinal(left.record.id, right.record.id));
}

function assignSurvivors(groups: Group[], existing: StoredSource[], previous: Map<string, string>) {
  const candidates = new Map<string, number[]>();
  for (const group of groups) {
    for (const agentId of new Set(group.sources.flatMap(source => {
      const id = previous.get(sourceKey(source));
      return id ? [id] : [];
    }))) {
      const choices = candidates.get(agentId) ?? [];
      choices.push(group.index);
      candidates.set(agentId, choices);
    }
  }
  const groupOwners = new Map<number, string>();
  const agentGroups = new Map<string, number>();
  // Oldest-first augmenting paths retain the most existing UUIDs even during a simultaneous merge and split.
  for (const agentId of new Set(existing.map(source => source.agent_id))) {
    const queue = [agentId];
    const visited = new Set<string>(queue);
    const paths = new Map<number, string>();
    let freeGroup: number | undefined;
    for (let offset = 0; offset < queue.length && freeGroup === undefined; offset += 1) {
      const candidate = queue[offset];
      for (const group of candidates.get(candidate) ?? []) {
        if (paths.has(group)) continue;
        paths.set(group, candidate);
        const owner = groupOwners.get(group);
        if (!owner) {
          freeGroup = group;
          break;
        }
        if (!visited.has(owner)) {
          visited.add(owner);
          queue.push(owner);
        }
      }
    }
    while (freeGroup !== undefined) {
      const owner = paths.get(freeGroup);
      if (!owner) throw new Error("Canonical survivor assignment lost its membership path.");
      const previousGroup = agentGroups.get(owner);
      groupOwners.set(freeGroup, owner);
      agentGroups.set(owner, freeGroup);
      freeGroup = previousGroup;
    }
  }
  return groupOwners;
}

function matchingEvidence(values: readonly UnifiedAgentLinkEvidence[]): UnifiedAgentLinkEvidence[] {
  const evidence = values.map(value => {
    if (!evidenceKinds.has(value.kind) || value.basis !== "source_declared_metadata"
      || !Array.isArray(value.elementIds) || !value.elementIds.every(id => validText(id, 512, true))
      || !validText(value.packagePath, 1024) || !validText(value.resourcePath, 1024)
      || value.relatedPackageIds !== undefined
        && (!Array.isArray(value.relatedPackageIds) || !value.relatedPackageIds.every(id => validText(id, 512)))) {
      invalidRecord("Canonical matching evidence must contain bounded source-declared identity fields only.");
    }
    return {
      kind: value.kind, basis: value.basis, elementIds: [...new Set(value.elementIds)].sort(ordinal),
      packagePath: value.packagePath, resourcePath: value.resourcePath,
      ...(value.relatedPackageIds === undefined ? {} : { relatedPackageIds: [...new Set(value.relatedPackageIds)].sort(ordinal) }),
    };
  });
  const result = [...new Map(evidence.map(value => [JSON.stringify(value), value])).entries()]
    .sort(([left], [right]) => ordinal(left, right)).map(([, value]) => value);
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > evidenceLimit) {
    invalidRecord("Canonical package matching evidence exceeds its 16 KiB storage bound.");
  }
  return result;
}

function snapshotId(observation: UnifiedAgentSourceObservation | null | undefined) {
  if (!observation || observation.current !== true || typeof observation.snapshotId !== "string"
    || observation.snapshotId.length !== 36 || !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(observation.snapshotId)) {
    invalidRecord("Canonical membership requires its source snapshot observation.");
  }
  return observation.snapshotId.toLowerCase();
}

function sourceKey(value: SourceIdentity) {
  return value.source === "power_platform"
    ? JSON.stringify([value.source, powerPlatformAgentKey(value.normalized_environment_id, value.normalized_native_id)])
    : JSON.stringify([value.source, value.normalized_environment_id, value.normalized_native_id]);
}

function ordinal(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function validText(value: string, maximum: number, allowEmpty = false) {
  return typeof value === "string" && (allowEmpty || value.length > 0) && value.length <= maximum && !/[\r\n\0]/.test(value);
}

function validateScope(scope: UnifiedAgentRegistryScope) {
  if (!validText(scope.tenantId, 128) || !validText(scope.principalId, 256)) {
    throw new AppError(403, "scope_mismatch", "Canonical inventory requires a valid tenant and principal scope.");
  }
}

function invalidRecord(message: string): never {
  throw new AppError(500, "saved_source_invalid", message);
}
