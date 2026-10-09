import { randomUUID } from "node:crypto";
import type pg from "pg";
import { allowlistedPackage } from "../services/packageObservation.js";
import type { AgentUsageTarget } from "../types/agentUsageTarget.js";
import type { CandidateAgentUsageMutation } from "../types/officialReportApi.js";
import type { OfficialUsageReportKind } from "../types/officialReportRecords.js";
import type { PowerPlatformResource } from "../types/powerPlatformInventory.js";
import { powerPlatformResourceTypes } from "../types/powerPlatformInventory.js";
import { unifiedAgentRecordId, type UnifiedAgentRecord } from "../types/unifiedAgents.js";
import { OfficialAgentUsage } from "../services/officialAgentUsage.js";
import { LargeTenantUsersReports } from "../services/largeTenantUsersReports.js";
import { OfficialReportImports } from "./officialReportImports.js";
import { DataGenerations } from "./dataGenerations.js";
import { selectionIdentity } from "../../scripts/largeTenantFixtures.js";
import { inventoryInput } from "../../scripts/inventoryFixtures.js";
import { InventoryGenerations, inventorySelector } from "./inventoryGenerations.js";
import { InventoryReconciliation } from "../services/inventoryReconciliation.js";
import { canonicalRecord, nativeInventoryKey, packageInventoryRecord, powerPlatformInventoryRecord,
  type InventoryRecord } from "../services/inventoryRecordProjection.js";
import { assignSurvivors, sourceKey } from "../services/inventorySurvivors.js";
import { normalizeNativeIdentity } from "../services/inventoryIdentity.js";
import type { CopilotPackageDetail } from "../types/copilotPackage.js";

export type AgentUsageScope = { tenantId: string; principalId: string };
export const newUsageScope = (): AgentUsageScope => ({ tenantId: `tenant-${randomUUID()}`, principalId: `principal-${randomUUID()}` });
export async function usageIdentity(database: pg.Pool, scope: AgentUsageScope) {
  return { ...selectionIdentity, ...scope, sessionEpoch: await new DataGenerations(database).sessionEpoch(scope.tenantId, scope.principalId) };
}
export const usageAudit = (scope: AgentUsageScope) => ({
  actor: { tenantId: scope.tenantId, homeAccountId: scope.principalId, username: "fixture@example.invalid", displayName: "Fixture" },
  requestPath: "/fixture/usage-associations",
});
export type UsageGroup = { packages: string[]; native?: { nativeId: string; environmentId: string | null; createdBy?: string };
  packageFields?: Partial<Omit<CopilotPackageDetail, "id">> };
const agentType = "microsoft.copilotstudio/agents" as const;

export async function saveUsageInventory(database: pg.Pool, scope: AgentUsageScope,
  groups: UsageGroup[] = [{ packages: ["Package-A", "Package-B"] }, { packages: ["Package-C"] }],
  options: { expiresAt?: Date } = {}) {
  if (groups.length > 100 || groups.reduce((count, group) => count + group.packages.length + Number(Boolean(group.native)), 0) > 250) {
    throw new Error("Grouped usage inventory accepts only small synthetic fixtures.");
  }
  const packages = new Map(groups.flatMap(group => group.packages.map(id => [id,
    allowlistedPackage({ displayName: `Inventory ${id}`, isBlocked: false, ...group.packageFields, id })] as const)));
  const native = groups.flatMap(group => group.native ? [group.native] : []);
  const resources = native.map(value => ({
    sourceSystem: "power_platform" as const, nativeId: value.nativeId, environmentId: value.environmentId, tenantId: scope.tenantId,
    type: agentType, displayName: "Inventory native agent", creatorType: "unknown" as const, agentKind: "agent",
    location: null, createdAt: null, createdBy: value.createdBy ?? null, lastPublishedAt: null, authoringTool: null,
    lifecycle: "published" as const, identityConfidence: "exact_native" as const, identifiers: [], provenance: {}, details: {}, unknownFieldCount: 0,
  } satisfies PowerPlatformResource));
  const stages = new InventoryGenerations(database);
  const observedAt = new Date(Date.now() - 60_000), expiresAt = options.expiresAt ?? new Date(Date.now() + 600_000);
  const source = async (domain: "packages" | "power_platform", rows: InventoryRecord[]) => {
    const input = { ...inventoryInput(scope.principalId, domain), observedAt, expiresAt,
      sessionEpoch: await stages.generations.sessionEpoch(scope.tenantId, scope.principalId) };
    input.scope.tenantId = scope.tenantId;
    const intent = { domain, mode: "baseline" as const, channel: "catalog" as const,
      ...domain === "power_platform" ? { resourceTypes: [...powerPlatformResourceTypes], roleScope: "full" as const } : {} };
    input.scope.selector = inventorySelector(intent);
    return stages.execute(input, intent, async lease => {
      await stages.visit(lease, "fixture");
      await stages.appendBounded(lease, rows);
      await stages.acceptPage(lease, { token: "fixture", nextToken: null, records: rows, rawCount: rows.length,
        expectedCount: rows.length, page: 1 }, rows.length);
    }, { authorize: async () => {} });
  };
  const packageRoot = await source("packages", [...packages.values()].map(packageInventoryRecord));
  const nativeRoot = await source("power_platform", resources.map(powerPlatformInventoryRecord));
  const observation = (snapshotId: string) => ({
    id: snapshotId, snapshotId, observedAt: observedAt.toISOString(),
    expiresAt: expiresAt.toISOString(), current: true as const,
  });
  const records: UnifiedAgentRecord[] = groups.map((group, index) => ({
    id: `fixture-${index}`, displayName: "Inventory record", presence: group.native ? group.packages.length ? "both" : "power_platform" : "graph_packages",
    environmentId: group.native?.environmentId ?? null, packages: group.packages.map(id => packages.get(id)!),
    powerPlatformResource: group.native ? resources.find(value => value.nativeId === group.native!.nativeId
      && value.environmentId === group.native!.environmentId)! : null,
    identity: { state: group.native && group.packages.length ? "matched" : "unmatched", evidence: [], packageEvidence: [], reason: null },
    observations: {
      graphPackages: { ...observation(packageRoot.baselineId), tokenMode: "delegated", scopeKind: "broad", observedCount: packages.size, totalRecords: packages.size },
      packageSnapshots: Object.fromEntries(group.packages.map(id => [id, {
        ...observation(packageRoot.baselineId), scopeKind: "broad", identityDetails: null,
      }])),
      powerPlatform: group.native ? {
        ...observation(nativeRoot.baselineId), roleScope: "full", environmentScope: null, coverage: "covered",
        coveredCount: native.length, observedCount: native.length, totalRecords: native.length, pageCount: 1,
        verification: { status: "verified", scope: "authorized_query", basis: "provider_total_and_saved_rows",
          checkedAt: new Date().toISOString(), storedCount: native.length, uniqueIdentityCount: native.length,
          queriedTypes: [...powerPlatformResourceTypes] },
      } : null,
    },
  }));
  const input = { ...inventoryInput(scope.principalId, "canonical"), observedAt, expiresAt,
    sessionEpoch: await stages.generations.sessionEpoch(scope.tenantId, scope.principalId) };
  input.scope.tenantId = scope.tenantId;
  const queue = await new InventoryReconciliation(database).request(input, [packageRoot, nativeRoot]);
  const previous = (await database.query(`SELECT r.native_id,r.environment_id,r.domain,s.identity AS agent_id
    FROM inventory_roots root JOIN inventory_memberships m ON m.baseline_id=root.baseline_id
      AND m.valid_from_revision<=root.revision AND (m.valid_to_revision IS NULL OR m.valid_to_revision>root.revision)
    JOIN unified_agent_memberships s ON s.generation_id=m.generation_id AND s.identity=m.identity
    JOIN inventory_records r ON r.generation_id=s.source_generation_id AND r.identity=s.source_identity
    JOIN inventory_canonical_ids known ON known.id=s.identity::uuid
    WHERE root.scope_id=$1 AND root.current ORDER BY known.created_at,known.id,r.identity LIMIT 251`, [queue.scopeId])).rows.map(row => ({
    source: row.domain === "packages" ? "graph_packages" as const : "power_platform" as const, agent_id: row.agent_id as string,
    normalized_native_id: row.domain === "packages" ? row.native_id as string : normalizeNativeIdentity(row.native_id),
    normalized_environment_id: row.domain === "packages" ? "" : row.environment_id?.toLowerCase() ?? "",
  }));
  if (previous.length > 250) throw new Error("Grouped usage fixture previous membership exceeds its synthetic bound.");
  const candidates = records.map((record, index) => ({ record, index, sortKey: String(index),
    sources: [...record.packages.map(value => ({ source: "graph_packages" as const, native_id: value.id, normalized_native_id: value.id,
      environment_id: "", normalized_environment_id: "", package_snapshot_id: packageRoot.baselineId, power_platform_snapshot_id: null, matching_evidence: [] })),
    ...record.powerPlatformResource ? [{ source: "power_platform" as const, native_id: record.powerPlatformResource.nativeId,
      normalized_native_id: normalizeNativeIdentity(record.powerPlatformResource.nativeId), environment_id: record.environmentId ?? "",
      normalized_environment_id: record.environmentId?.toLowerCase() ?? "", package_snapshot_id: null,
      power_platform_snapshot_id: nativeRoot.baselineId, matching_evidence: [] }] : []] }));
  const survivors = assignSurvivors(candidates, previous, new Map(previous.map(value => [sourceKey(value), value.agent_id])));
  await database.query(`UPDATE inventory_reconciliation SET active_id=$2,active_inputs=pending_inputs,active_sequence=pending_sequence,
    active_epoch=(SELECT epoch FROM data_scope_epochs WHERE id=$1),active_deadline=$3,active_until=clock_timestamp()+interval '60 seconds',
    pending_inputs=NULL,status='running' WHERE scope_id=$1`, [queue.scopeId, input.jobId, input.deadlineAt]);
  await stages.execute(input, { domain: "canonical", mode: "baseline", channel: "canonical" }, async lease => {
    for (const candidate of candidates) {
      const id = survivors.get(candidate.index) ?? randomUUID();
      candidate.record.id = `agent:${id}`;
      await database.query("INSERT INTO inventory_canonical_ids(id,scope_id,tenant_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
        [id, queue.scopeId, scope.tenantId]);
      await stages.append(lease, [canonicalRecord(id, candidate.record)]);
      for (const member of candidate.sources) {
        const root = member.source === "graph_packages" ? packageRoot : nativeRoot;
        const sourceIdentity = member.source === "graph_packages" ? member.native_id : nativeInventoryKey(candidate.record.powerPlatformResource!);
        await database.query(`INSERT INTO unified_agent_memberships(generation_id,scope_id,tenant_id,identity,schema_version,
          source_scope_id,source_identity,source_generation_id,evidence) VALUES($1,$2,$3,$4,1,$5,$6,$7,'[]')`,
        [lease.id, queue.scopeId, scope.tenantId, id, root.scopeId, sourceIdentity, root.baselineId]);
      }
    }
  }, { authorize: async () => {}, completeJob: async client => {
    await client.query(`UPDATE inventory_reconciliation SET active_id=NULL,active_until=NULL,active_deadline=NULL,
      published_sequence=active_sequence,published_inputs=active_inputs,status='idle' WHERE scope_id=$1 AND active_id=$2`, [queue.scopeId, input.jobId]);
  } });
  return records;
}

export async function awaitUsageInventoryExpiry(database: pg.Pool, scope: AgentUsageScope) {
  const seconds = Number((await database.query(`SELECT GREATEST(extract(epoch FROM g.expires_at-clock_timestamp()),0)+0.05 AS seconds
    FROM data_scope_epochs s JOIN inventory_roots r ON r.scope_id=s.id AND r.current
    JOIN inventory_revisions v ON v.scope_id=r.scope_id AND v.revision=r.revision
    JOIN data_generations g ON g.id=v.generation_id WHERE s.tenant_id=$1 AND s.principal_id=$2 AND s.source='inventory_canonical'`,
  [scope.tenantId, scope.principalId])).rows[0]?.seconds);
  if (!Number.isFinite(seconds) || seconds > 3.1) throw new Error("Expiry fixture requires a deliberately short-lived source.");
  await database.query("SELECT pg_sleep($1)", [seconds]);
}

export async function publishUsageReports(database: pg.Pool, scope: AgentUsageScope, responses = 10,
  transform?: (kind: OfficialUsageReportKind, content: string) => string, options: { correctionOfSetId?: string } = {}) {
  const reports = new OfficialReportImports(database), identity = await usageIdentity(database, scope);
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
  const kinds = ["agents", "userAgents", "users"] as const;
  for (const [index, csv] of csvs.entries()) {
    await reports.stage(identity, { bundleId, ...options }, (async function* () { yield Buffer.from(transform?.(kinds[index], csv) ?? csv); })());
  }
  return reports.acceptBundle(identity, bundleId, await reports.bundle(identity, bundleId));
}

export async function usageIntent(database: pg.Pool, scope: AgentUsageScope,
  reportAgentId = "Report-A", target: AgentUsageTarget = { source: "graph_packages", packageId: "Package-A" }): Promise<CandidateAgentUsageMutation> {
  const reports = new LargeTenantUsersReports(database, "synthetic-fixture-selected-report-key", 35), identity = await usageIdentity(database, scope);
  const selection = await reports.capture(identity, "delegated", "official_agents");
  const [summary] = await new OfficialAgentUsage(reports).summaries(selection.id, identity, [unifiedAgentRecordId(target)]);
  const { selectionId, reportSetId, usageRevision, inventoryRevision } = summary.context;
  return { selectionId, reportSetId, usageRevision, inventoryRevision, reportAgentId, target, confirmed: true };
}

export async function deleteUsageSet(database: pg.Pool, scope: AgentUsageScope, setId: string) {
  const repository = new OfficialReportImports(database), identity = await usageIdentity(database, scope);
  return repository.confirm(identity, await repository.confirmPreview(identity, setId, "delete"));
}
