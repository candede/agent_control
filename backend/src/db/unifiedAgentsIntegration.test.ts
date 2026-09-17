import { describe, expect, it } from "vitest";
import { testDatabase } from "../../scripts/testDatabase.js";
import { AppError } from "../errors.js";
import { allowlistedPackage } from "../services/packageObservation.js";
import { resolvePackageAgentLinks } from "../services/packageAgentIdentity.js";
import { UnifiedAgentsService } from "../services/unifiedAgents.js";
import { buildUnifiedAgentCsv } from "../services/unifiedAgentExport.js";
import type { CopilotPackageDetail } from "../types/copilotPackage.js";
import type { PowerPlatformResource } from "../types/powerPlatformInventory.js";
import { unifiedAgentRecordId } from "../types/unifiedAgents.js";
import { PackageInventoryRepository } from "./packageInventory.js";
import { PowerPlatformInventoryRepository } from "./powerPlatformInventory.js";
import { UnifiedAgentRegistry } from "./unifiedAgentRegistry.js";
import { readUnifiedInventoryRevision } from "./unifiedInventoryRevision.js";

const scope = { tenantId: "unified-integration-tenant", principalId: "unified-reader" };
const environmentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const manifestId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const botId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const unrelatedId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

function builderPackage(id: string): CopilotPackageDetail {
  return {
    ...allowlistedPackage({
      id, displayName: " Shared agent ", isBlocked: id.endsWith("-blocked"), manifestId,
      platform: "Microsoft 365 Copilot Agent Builder", elementTypes: ["DeclarativeCopilots"],
      availableTo: "allowedForAll", supportedHosts: ["Copilot", "Teams"],
      elementDetails: [{ elementType: "DeclarativeCopilots", elements: [{ id: "", definition: "{}" }] }],
    }),
    identityDetailsCollected: true,
  };
}

function studioPackage(): CopilotPackageDetail {
  return {
    ...allowlistedPackage({
      id: "studio-package", displayName: "Shared agent", isBlocked: false, platform: "Copilot Studio",
      elementDetails: [{ elementType: "AgentMetadatas", elements: [{ id: "", definition: JSON.stringify({
        SourceIds: { EnvironmentId: environmentId, CdsBotId: botId, SchemaName: "cr_studio" },
        AgentIdentityId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      }) }] }],
    }),
    identityDetailsCollected: true,
  };
}

function nativeResource(nativeId: string, schemaName: string): PowerPlatformResource {
  return {
    tenantId: scope.tenantId, nativeId, type: "microsoft.copilotstudio/agents", environmentId,
    displayName: "Shared agent", location: null, createdAt: null, createdBy: null, lastPublishedAt: null,
    sourceSystem: "power_platform", authoringTool: null, creatorType: "unknown", agentKind: "agent",
    lifecycle: "published", identityConfidence: "exact_native",
    identifiers: [{ kind: "environment_id", value: environmentId }, { kind: "power_platform_resource_id", value: nativeId }],
    provenance: {}, details: { schemaName, isQuarantined: false }, unknownFieldCount: 0,
  };
}

async function publishPackages(repository: PackageInventoryRepository, key: string, packages: CopilotPackageDetail[], pages = 1) {
  const job = await repository.submit(scope, {
    authorizationPrincipalId: scope.principalId, tokenMode: "delegated", idempotencyKey: key,
  });
  await repository.markRunning(scope, job.id);
  return repository.publish(scope, job.id, { packages, totalRecords: packages.length, pages });
}

async function publishResources(repository: PowerPlatformInventoryRepository, key: string, resources: PowerPlatformResource[], pages = 1) {
  const job = await repository.submit(scope, {
    idempotencyKey: key, roleScope: "unknown", requestedTypes: ["microsoft.copilotstudio/agents"],
  });
  await repository.markRunning(scope, job.id);
  return repository.publish(scope, job.id, {
    resources, queriedTypes: ["microsoft.copilotstudio/agents"], environmentScope: null,
    totalRecords: resources.length, pages, unknownFieldCount: 0,
  });
}

describe("persisted unified agent inventory", () => {
  it("does not erase canonical ownership when a saved source exceeds the reader bound", async () => {
    const fixture = await testDatabase();
    try {
      const packages = new PackageInventoryRepository(fixture.runtime);
      const powerPlatform = new PowerPlatformInventoryRepository(fixture.runtime);
      const registry = new UnifiedAgentRegistry(fixture.runtime);
      const dependencies = {
        packages, powerPlatform, registry, resolveLinks: resolvePackageAgentLinks, operationPackageIds: async () => [],
        readRevision: (owner: typeof scope, database: Pick<typeof fixture.runtime, "query"> = fixture.runtime) => readUnifiedInventoryRevision(owner, database),
      };
      await publishPackages(packages, "bounded-packages", [builderPackage("builder"), studioPackage()]);
      await publishResources(powerPlatform, "bounded-resources", [nativeResource(manifestId, manifestId)]);
      const service = new UnifiedAgentsService(dependencies);
      const before = await service.list(scope);
      const limited = new UnifiedAgentsService({
        ...dependencies, packages: { readUnifiedSource: async () => { throw new AppError(409, "source_result_limit", "Too many packages."); } },
      });
      await expect(limited.list(scope)).rejects.toMatchObject({ code: "source_result_limit" });
      const after = await service.list(scope);
      expect(after.value.map(record => record.id).sort()).toEqual(before.value.map(record => record.id).sort());
      expect(after.revision).toBe(before.revision);
      await publishPackages(packages, "additional-package", [builderPackage("builder"), studioPackage(), builderPackage("another-wrapper")]);
      const incomplete = new UnifiedAgentsService({
        ...dependencies, registry: {
          withSnapshot: registry.withSnapshot.bind(registry),
          reconcile: async (database, owner, groups) => (await registry.reconcile(database, owner, groups)).slice(1),
        },
      });
      await expect(incomplete.list(scope)).rejects.toMatchObject({ code: "inventory_verification_failed" });
      expect((await fixture.runtime.query(`SELECT count(*)::int AS count FROM unified_agent_sources
        WHERE tenant_id=$1 AND principal_id=$2 AND native_id='another-wrapper'`, [scope.tenantId, scope.principalId])).rows[0].count).toBe(0);
      const verified = await service.list(scope);
      expect(verified.verification).toMatchObject({ status: "verified", representedSourceCount: 4, uniqueSourceCount: 4 });
      expect(verified.value.map(record => record.id).sort()).toEqual(before.value.map(record => record.id).sort());
    } finally {
      await fixture.close();
    }
  });

  it("verifies and exports 5,000 logical agents and all 10,000 source targets within the unchanged read deadline", async () => {
    const fixture = await testDatabase();
    try {
      const packages = new PackageInventoryRepository(fixture.runtime);
      const powerPlatform = new PowerPlatformInventoryRepository(fixture.runtime);
      const service = new UnifiedAgentsService({
        packages, powerPlatform, registry: new UnifiedAgentRegistry(fixture.runtime),
        resolveLinks: resolvePackageAgentLinks, operationPackageIds: async () => [],
        readRevision: (owner, database = fixture.runtime) => readUnifiedInventoryRevision(owner, database),
      });
      const ids = Array.from({ length: 5_000 }, (_, index) => `10000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`);
      await publishPackages(packages, "maximum-packages", ids.map((id, index) => ({ ...builderPackage(`scale-${index}`), manifestId: id })), 5);
      await publishResources(powerPlatform, "maximum-agents", ids.map(id => nativeResource(id, id)), 50);
      const startedAt = performance.now();
      const first = await service.list(scope, { limit: 1 });
      expect(performance.now() - startedAt).toBeLessThan(15_000);
      expect(first).toMatchObject({
        count: 5_000, partial: false,
        summary: { total: 5_000, linked: 5_000, graphOnly: 0, powerPlatformOnly: 0, ambiguous: 0, conflicting: 0 },
        verification: { status: "verified", representedSourceCount: 10_000, uniqueSourceCount: 10_000, logicalAgentCount: 5_000 },
      });
      expect(first.value).toHaveLength(1);
      const deadlineAt = Date.now() + 15_000;
      const exported = await service.forExport(scope, first.revision!);
      const csv = buildUnifiedAgentCsv(exported, deadlineAt);
      expect(csv.rowCount).toBe(5_000);
      expect(csv.buffer.byteLength).toBeLessThanOrEqual(8_000_000);
      expect(Date.now()).toBeLessThan(deadlineAt);
      expect(exported.verification.status).toBe("verified");
    } finally {
      await fixture.close();
    }
  }, 60_000);

  it("reconciles both real source schemas before paging, preserves every control, and retains canonical IDs after refresh", async () => {
    const fixture = await testDatabase();
    try {
      const packages = new PackageInventoryRepository(fixture.runtime);
      const powerPlatform = new PowerPlatformInventoryRepository(fixture.runtime);
      const registry = new UnifiedAgentRegistry(fixture.runtime);
      const service = new UnifiedAgentsService({
        packages, powerPlatform, registry, resolveLinks: resolvePackageAgentLinks, operationPackageIds: async () => [],
        readRevision: (owner, database = fixture.runtime) => readUnifiedInventoryRevision(owner, database),
      });
      const values = [builderPackage("builder-b-blocked"), builderPackage("builder-a"), studioPackage(), {
        ...builderPackage("unrelated-package"), manifestId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
      }];
      const native = [nativeResource(manifestId, manifestId), {
        ...nativeResource(botId, "cr_studio"),
        identifiers: [...nativeResource(botId, "cr_studio").identifiers, { kind: "entra_agent_id" as const, value: unrelatedId }],
      }, nativeResource(unrelatedId, "cr_other")];
      await publishPackages(packages, "packages-one", values);
      await publishResources(powerPlatform, "resources-one", native);
      const first = await service.list(scope, { limit: 1 });
      expect(first).toMatchObject({
        count: 4, partial: false,
        summary: { total: 4, linked: 2, graphOnly: 1, powerPlatformOnly: 1, ambiguous: 0, conflicting: 0 },
        identityCollection: { checkedPackages: 4, pendingPackages: 0 },
        verification: {
          status: "verified", scope: "authorized_saved_sources", graphPackageCount: 4, powerPlatformAgentCount: 3,
          representedSourceCount: 7, uniqueSourceCount: 7, logicalAgentCount: 4,
          checks: { sourceScopes: true, packageMetadata: true, identityLinks: true, sourceMemberships: true },
        },
      });
      expect(first.value).toHaveLength(1);
      const complete = await service.list(scope, { limit: 250 });
      expect(complete.value.every(record => /^agent:[0-9a-f-]{36}$/.test(record.id))).toBe(true);
      expect(complete.value.flatMap(record => record.packages.map(value => value.id)).sort()).toEqual(values.map(value => value.id).sort());
      const builder = complete.value.find(record => record.packages.some(value => value.id === "builder-a"))!;
      expect(builder).toMatchObject({
        displayName: "Shared agent", presence: "both", environmentId,
        packages: [{ id: "builder-a", isBlocked: false }, { id: "builder-b-blocked", isBlocked: true }],
        identity: { evidence: [{ kind: "manifest_schema_native_id" }] },
      });
      expect(builder.powerPlatformResource!.identifiers).not.toContainEqual(expect.objectContaining({ kind: "cds_bot_id" }));
      expect(Object.keys(builder.observations.packageSnapshots).sort()).toEqual(["builder-a", "builder-b-blocked"]);
      const studio = complete.value.find(record => record.packages.some(value => value.id === "studio-package"))!;
      expect(studio.identity.warnings).toMatchObject([{ code: "source_specific_agent_identity" }]);
      expect(studio.powerPlatformResource!.identifiers).toContainEqual({ kind: "cds_bot_id", value: botId });
      for (const recordId of [
        builder.id,
        unifiedAgentRecordId({ source: "graph_packages", packageId: "builder-b-blocked" }),
        unifiedAgentRecordId({ source: "power_platform", environmentId: environmentId.toUpperCase(), nativeId: manifestId.toUpperCase() }),
      ]) expect((await service.list(scope, { recordId })).value[0].id).toBe(builder.id);
      const beforeIds = complete.value.map(record => record.id).sort();
      expect(complete.revision).toMatch(/^[a-f0-9]{64}$/);
      const exported = await service.forExport(scope, complete.revision!, {}, [
        builder.id, unifiedAgentRecordId({ source: "graph_packages", packageId: "builder-b-blocked" }),
      ]);
      expect(exported.count).toBe(1);
      expect(exported.value[0].id).toBe(builder.id);
      await service.assertRevision(scope, complete.revision!);
      await publishPackages(packages, "packages-two", [...values].reverse());
      await publishResources(powerPlatform, "resources-two", [...native].reverse());
      await expect(service.forExport(scope, complete.revision!)).rejects.toMatchObject({ code: "inventory_changed" });
      await expect(service.assertRevision(scope, complete.revision!)).rejects.toMatchObject({ code: "inventory_changed" });
      expect((await service.list(scope, { limit: 250 })).value.map(record => record.id).sort()).toEqual(beforeIds);
      expect((await service.list({ ...scope, principalId: "different-reader" })).value).toEqual([]);
      expect((await service.list(scope, { limit: 250 })).value.map(record => record.id).sort()).toEqual(beforeIds);
    } finally {
      await fixture.close();
    }
  });

  it("removes withdrawn identity proof, splits safely, and never resurrects stale associations or controls", async () => {
    const fixture = await testDatabase();
    try {
      const packages = new PackageInventoryRepository(fixture.runtime);
      const powerPlatform = new PowerPlatformInventoryRepository(fixture.runtime);
      const service = new UnifiedAgentsService({
        packages, powerPlatform, registry: new UnifiedAgentRegistry(fixture.runtime),
        resolveLinks: resolvePackageAgentLinks, operationPackageIds: async () => [],
        readRevision: (owner, database = fixture.runtime) => readUnifiedInventoryRevision(owner, database),
      });
      const value = studioPackage();
      await publishPackages(packages, "initial-package", [value]);
      const native = await publishResources(powerPlatform, "initial-resource", [nativeResource(botId, "cr_studio")]);
      const linked = await service.list(scope);
      expect(linked).toMatchObject({ count: 1, value: [{ presence: "both" }] });
      expect(linked.value[0].powerPlatformResource!.identifiers).toContainEqual({ kind: "cds_bot_id", value: botId });
      await publishPackages(packages, "withdrawn-proof", [{ ...value, elementDetails: undefined, identityDetailsCollected: true }]);
      const split = await service.list(scope);
      expect(split).toMatchObject({ count: 2, summary: { linked: 0, graphOnly: 1, powerPlatformOnly: 1 } });
      expect(new Set(split.value.map(record => record.id)).size).toBe(2);
      const nativeOnly = split.value.find(record => record.powerPlatformResource)!;
      expect(nativeOnly.powerPlatformResource!.identifiers).not.toContainEqual(expect.objectContaining({ kind: "cds_bot_id" }));
      await expect(powerPlatform.resolveQuarantineTargets(scope, native.snapshotId, [botId]))
        .rejects.toMatchObject({ code: "quarantine_native_identity_unavailable" });
      await publishPackages(packages, "package-removed", []);
      const removed = await service.list(scope);
      expect(removed).toMatchObject({ count: 1, value: [{ id: nativeOnly.id, presence: "power_platform", packages: [] }] });
      await fixture.operator.query("DELETE FROM power_platform_inventory_snapshots WHERE id=$1", [native.snapshotId]);
      expect(await service.list(scope)).toMatchObject({ count: 0, value: [], summary: { total: 0 } });
    } finally {
      await fixture.close();
    }
  });
});
