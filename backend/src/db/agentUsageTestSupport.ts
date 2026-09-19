import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";
import { parseOfficialUsageReport } from "../services/officialUsageParser.js";
import { allowlistedPackage } from "../services/packageObservation.js";
import type { AgentUsageAssociationInput, AgentUsageTarget } from "../types/agentUsage.js";
import type { PowerPlatformResource } from "../types/powerPlatformInventory.js";
import { powerPlatformResourceTypes } from "../types/powerPlatformInventory.js";
import type { UnifiedAgentRecord } from "../types/unifiedAgents.js";
import { AgentUsageService, combineAgentInventoryRevision } from "../services/agentUsage.js";
import type { AgentUsageScope } from "./agentUsage.js";
import { OfficialUsageRepository } from "./officialUsage.js";
import { readUnifiedInventoryRevision } from "./unifiedInventoryRevision.js";
import { UnifiedAgentRegistry } from "./unifiedAgentRegistry.js";

export const newUsageScope = (): AgentUsageScope => ({ tenantId: `tenant-${randomUUID()}`, principalId: `principal-${randomUUID()}` });
export const usageAudit = (scope: AgentUsageScope) => ({
  actor: { tenantId: scope.tenantId, homeAccountId: scope.principalId, username: "fixture@example.invalid", displayName: "Fixture" },
  requestPath: "/fixture/usage-associations",
});
export type UsageGroup = { packages: string[]; native?: { nativeId: string; environmentId: string | null } };
type SnapshotRow = { id: string; observed_at: Date; expires_at: Date };
const agentType = "microsoft.copilotstudio/agents" as const;

export async function saveUsageInventory(database: pg.Pool, scope: AgentUsageScope,
  groups: UsageGroup[] = [{ packages: ["Package-A", "Package-B"] }, { packages: ["Package-C"] }]) {
  const packages = new Map(groups.flatMap(group => group.packages.map(id => [id, allowlistedPackage({ id, displayName: `Inventory ${id}`, isBlocked: false })] as const)));
  const native = groups.flatMap(group => group.native ? [group.native] : []);
  const packageSnapshot = (await database.query<SnapshotRow>(`INSERT INTO package_inventory_snapshots(
      id,tenant_id,principal_id,token_mode,query_hash,scope_kind,requested_ids,observed_count,total_records,page_count)
    VALUES($1,$2,$3,'delegated',$4,'broad','[]',$5,$5,1) RETURNING id,observed_at,expires_at`,
  [randomUUID(), scope.tenantId, scope.principalId, "a".repeat(64), packages.size])).rows[0];
  if (packages.size) {
    await database.query(`INSERT INTO package_inventory_resources(
        snapshot_id,tenant_id,principal_id,native_id,display_name,is_blocked,identifiers,package_data)
      SELECT $1,$2,$3,value.id,value.display_name,false,
        jsonb_build_array(jsonb_build_object('kind','package_id','value',value.id)),value.package_data
      FROM jsonb_to_recordset($4::jsonb) AS value(id text,display_name text,package_data jsonb)`,
    [packageSnapshot.id, scope.tenantId, scope.principalId, JSON.stringify([...packages.values()].map(value => ({
      id: value.id, display_name: value.displayName, package_data: value,
    })))]);
  }
  const powerPlatformSnapshot = (await database.query<SnapshotRow>(`INSERT INTO power_platform_inventory_snapshots(
      id,tenant_id,principal_id,query_hash,role_scope,requested_types,queried_types,observed_count,total_records,page_count,unknown_field_count)
    VALUES($1,$2,$3,$4,'full',$5::jsonb,$5::jsonb,$6,$6,1,0) RETURNING id,observed_at,expires_at`,
  [randomUUID(), scope.tenantId, scope.principalId, "b".repeat(64), JSON.stringify(powerPlatformResourceTypes), native.length])).rows[0];
  if (native.length) {
    await database.query(`INSERT INTO power_platform_inventory_resources(
        snapshot_id,tenant_id,principal_id,native_id,resource_type,environment_id,display_name,source_system,
        creator_type,agent_kind,lifecycle,identity_confidence,identifiers,provenance,details,unknown_field_count)
      SELECT $1,$2,$3,value.native_id,'microsoft.copilotstudio/agents',value.environment_id,'Inventory native agent',
        'power_platform','unknown','agent','published','exact_native',
        jsonb_build_array(jsonb_build_object('kind','power_platform_resource_id','value',value.native_id)),
        '{}'::jsonb,'{}'::jsonb,0
      FROM jsonb_to_recordset($4::jsonb) AS value(native_id text,environment_id text)`,
    [powerPlatformSnapshot.id, scope.tenantId, scope.principalId, JSON.stringify(native.map(value => ({
      native_id: value.nativeId, environment_id: value.environmentId ?? "",
    })))]);
  }
  const observation = (snapshot: SnapshotRow) => ({
    id: snapshot.id, snapshotId: snapshot.id, observedAt: snapshot.observed_at.toISOString(),
    expiresAt: snapshot.expires_at.toISOString(), current: true as const,
  });
  const records: UnifiedAgentRecord[] = groups.map((group, index) => ({
    id: `fixture-${index}`, displayName: "Inventory record", presence: group.native ? group.packages.length ? "both" : "power_platform" : "graph_packages",
    environmentId: group.native?.environmentId ?? null, packages: group.packages.map(id => packages.get(id)!),
    powerPlatformResource: group.native ? {
      sourceSystem: "power_platform", nativeId: group.native.nativeId, environmentId: group.native.environmentId, tenantId: scope.tenantId,
      type: agentType, displayName: "Inventory native agent", creatorType: "unknown", agentKind: "agent",
      location: null, createdAt: null, createdBy: null, lastPublishedAt: null, authoringTool: null,
      lifecycle: "published", identityConfidence: "exact_native", identifiers: [], provenance: {}, details: {}, unknownFieldCount: 0,
    } satisfies PowerPlatformResource : null,
    identity: { state: group.native && group.packages.length ? "matched" : "unmatched", evidence: [], packageEvidence: [], reason: null },
    observations: {
      graphPackages: { ...observation(packageSnapshot), tokenMode: "delegated", scopeKind: "broad", observedCount: packages.size, totalRecords: packages.size },
      packageSnapshots: Object.fromEntries(group.packages.map(id => [id, {
        ...observation(packageSnapshot), scopeKind: "broad", identityDetails: null,
      }])),
      powerPlatform: group.native ? {
        ...observation(powerPlatformSnapshot), roleScope: "full", environmentScope: null, coverage: "covered",
        coveredCount: native.length, observedCount: native.length, totalRecords: native.length, pageCount: 1,
        verification: { status: "verified", scope: "authorized_query", basis: "provider_total_and_saved_rows",
          checkedAt: new Date().toISOString(), storedCount: native.length, uniqueIdentityCount: native.length,
          queriedTypes: [...powerPlatformResourceTypes] },
      } : null,
    },
  }));
  const registry = new UnifiedAgentRegistry(database);
  return registry.withSnapshot(scope, client => registry.reconcile(client, scope, records));
}

export async function publishUsageReports(database: pg.Pool, scope: AgentUsageScope, responses = 10) {
  const reports = new OfficialUsageRepository(database);
  const bundleId = randomUUID();
  const csvs = [
    `Agent ID,Agent name,Creator type,Active users (licensed),Active users (unlicensed),Responses sent to users,Last activity date (UTC)
Report-A,Reported A,Your org,99,99,${responses},2026-09-16
Report-B,Reported B,Your org,99,99,20,2026-09-18
Report-Zero,Reported Zero,Your org,0,0,0,
Report-Missing,Reported Missing,Your org,1,1,1,2026-09-15`,
    `Agent ID,Agent name,Creator type,Username,Responses sent to users,Last activity date (UTC)
Report-A,Reported A,Your org,CaseUser,4,2026-09-16
Report-A,Reported A,Your org,Shared,6,2026-09-16
Report-B,Reported B,Your org,caseuser,5,2026-09-18
Report-B,Reported B,Your org,Shared,15,2026-09-18
Report-Zero,Reported Zero,Your org,ZeroUser,0,
Bridge-Only,Bridge Only,Your org,BridgeUser,77,2026-09-18`,
    `Username,Display name,Number of agents used,Agent responses received,Last activity date (UTC)
CaseUser,One,1,4,2026-09-16
caseuser,Two,1,5,2026-09-18
Shared,Shared,2,21,2026-09-18
ZeroUser,Zero,1,0,
BridgeUser,Bridge,1,77,2026-09-18`,
  ];
  for (const csv of csvs) {
    await reports.stage(scope, { report: parseOfficialUsageReport(Buffer.from(csv)),
      fileHash: createHash("sha256").update(csv).digest("hex"), bundleId });
  }
  return reports.acceptBundle(scope, bundleId, await reports.previewBundle(scope, bundleId));
}

export async function usageIntent(database: pg.Pool, scope: AgentUsageScope,
  reportAgentId = "Report-A", target: AgentUsageTarget = { source: "graph_packages", packageId: "Package-A" }): Promise<AgentUsageAssociationInput> {
  const service = new AgentUsageService(database);
  const expectedUsageRevision = await service.revision(scope);
  const reportSetId = (await new OfficialUsageRepository(database).getPublished(scope.tenantId)).activeSet!.id;
  return {
    reportSetId, reportAgentId, target, expectedUsageRevision,
    expectedInventoryRevision: combineAgentInventoryRevision(await readUnifiedInventoryRevision(scope, database), expectedUsageRevision),
    confirmed: true,
  };
}

export async function deleteUsageSet(database: pg.Pool, scope: AgentUsageScope, setId: string) {
  const repository = new OfficialUsageRepository(database);
  const preview = await repository.previewSetOperation(scope, "delete", setId);
  return repository.confirmSetOperation(scope, preview.id, {
    operation: "delete", setId, expectedRevision: preview.expectedRevision, confirmationHash: preview.confirmationHash,
  });
}
