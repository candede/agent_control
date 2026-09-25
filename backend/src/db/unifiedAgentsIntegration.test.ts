import { describe, expect, it } from "vitest";
import { parse as parseCsv } from "csv-parse/sync";
import { testDatabase } from "../../scripts/testDatabase.js";
import { AppError } from "../errors.js";
import { allowlistedPackage } from "../services/packageObservation.js";
import { resolvePackageAgentLinks } from "../services/packageAgentIdentity.js";
import { UnifiedAgentsService } from "../services/unifiedAgents.js";
import { AgentUsageService } from "../services/agentUsage.js";
import { buildUnifiedAgentCsv } from "../services/unifiedAgentExport.js";
import { PowerPlatformResourceQueryClient } from "../services/powerPlatformResourceQuery.js";
import type { CopilotPackageDetail } from "../types/copilotPackage.js";
import type { PowerPlatformResource } from "../types/powerPlatformInventory.js";
import { unifiedAgentRecordId } from "../types/unifiedAgents.js";
import { PackageInventoryRepository } from "./packageInventory.js";
import { PowerPlatformInventoryRepository } from "./powerPlatformInventory.js";
import { UnifiedAgentRegistry } from "./unifiedAgentRegistry.js";
import { readUnifiedInventoryRevision } from "./unifiedInventoryRevision.js";
import { deleteUsageSet, publishUsageReports, saveUsageInventory, usageAudit } from "./agentUsageTestSupport.js";
import { SavedAgentPeopleService } from "../services/savedAgentPeople.js";
import { AgentPeopleRepository } from "./agentPeople.js";
import { DataSyncRepository } from "./dataSync.js";

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
  it("keeps catalog-backed agents deduplicated through sparse detail enrichment, expiry and catalog refresh", async () => {
    const fixture = await testDatabase();
    try {
      const packages = new PackageInventoryRepository(fixture.runtime);
      const powerPlatform = new PowerPlatformInventoryRepository(fixture.runtime);
      const service = new UnifiedAgentsService({
        packages, powerPlatform, usage: new AgentUsageService(fixture.runtime), registry: new UnifiedAgentRegistry(fixture.runtime),
        resolveLinks: resolvePackageAgentLinks, operationPackageIds: async () => [],
        readRevision: (owner, database = fixture.runtime) => readUnifiedInventoryRevision(owner, database),
      });
      const { elementDetails, identityDetailsCollected: _collected, ...summary } = builderPackage("builder");
      const catalog = { ...summary, lastModifiedDateTime: "2026-09-24T08:00:00Z", version: "1" };
      const publishCatalog = async (key: string) => {
        const job = await packages.submit(scope, {
          authorizationPrincipalId: scope.principalId, tokenMode: "delegated", idempotencyKey: key, catalogOnly: true,
        });
        await packages.markRunning(scope, job.id);
        await packages.publish(scope, job.id, { packages: [catalog], totalRecords: 1, pages: 1 });
      };
      await publishResources(powerPlatform, "catalog-native", [
        nativeResource(manifestId, manifestId), nativeResource(unrelatedId, unrelatedId),
      ]);
      await publishCatalog("catalog-first");
      const initial = await service.list(scope);
      expect(initial.summary).toMatchObject({ total: 2, linked: 1, graphOnly: 0, powerPlatformOnly: 1 });
      const canonicalId = initial.value.find(value => value.presence === "both")!.id;
      expect(initial.verification).toMatchObject({ logicalAgentCount: 2, representedSourceCount: 3, uniqueSourceCount: 3 });
      const job = (await packages.claimDueDetails(scope, scope.principalId))!;
      await packages.markRunning(scope, job.id, true);
      const { manifestId: _manifest, ...sparse } = catalog;
      await packages.publish(scope, job.id, {
        packages: [{ ...sparse, elementDetails, identityDetailsCollected: true }], totalRecords: 1, pages: 1, detailFailures: [],
      });
      const fresh = await service.list(scope, { recordId: canonicalId });
      expect(fresh.value[0].packages[0].detailFreshness?.state).toBe("fresh");
      for (const stage of ["fresh", "expired", "refreshed"]) {
        if (stage === "expired") await fixture.operator.query(
          "UPDATE package_detail_cache SET expires_at=clock_timestamp()-interval '1 second' WHERE tenant_id=$1 AND principal_id=$2",
          [scope.tenantId, scope.principalId],
        );
        if (stage === "refreshed") await publishCatalog("catalog-again");
        const page = await service.list(scope, { limit: 1 });
        expect(page.count).toBe(2);
        expect(page.summary).toEqual(initial.summary);
        const selected = await service.list(scope, { recordId: canonicalId });
        expect(selected.count).toBe(1);
        expect(selected.value[0]).toMatchObject({
          id: canonicalId, presence: "both", packages: [{ id: "builder" }],
          powerPlatformResource: { nativeId: manifestId },
        });
        expect(selected.value[0].powerPlatformResource!.identifiers.some(value => value.kind === "cds_bot_id")).toBe(false);
        if (stage !== "fresh") {
          expect(selected.value[0].packages[0].detailFreshness?.state).toBe("stale");
          expect(selected.value[0].observations.packageSnapshots.builder.identityDetails).toBeNull();
        }
        const exported = await service.forExport(scope, page.revision!, {}, [
          "graph_packages:builder", unifiedAgentRecordId({ source: "power_platform", environmentId, nativeId: manifestId }),
        ]);
        expect(buildUnifiedAgentCsv(exported, Date.now() + 15_000).rowCount).toBe(1);
        const stored = await fixture.runtime.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM unified_agents WHERE tenant_id=$1 AND principal_id=$2",
          [scope.tenantId, scope.principalId],
        );
        expect(stored.rows[0].count).toBe(2);
      }
    } finally { await fixture.close(); }
  });

  it("projects scoped cached responsibility outside directory/report cohorts with current canonical navigation after refresh", async () => {
    const fixture = await testDatabase();
    try {
      const packages = new PackageInventoryRepository(fixture.runtime);
      const powerPlatform = new PowerPlatformInventoryRepository(fixture.runtime);
      const cache = new AgentPeopleRepository(fixture.runtime);
      const service = new UnifiedAgentsService({
        packages, powerPlatform, usage: new AgentUsageService(fixture.runtime), registry: new UnifiedAgentRegistry(fixture.runtime),
        people: new SavedAgentPeopleService(new DataSyncRepository(fixture.runtime), cache),
        resolveLinks: resolvePackageAgentLinks, operationPackageIds: async () => [],
        readRevision: (owner, database = fixture.runtime) => readUnifiedInventoryRevision(owner, database),
      });
      await publishResources(powerPlatform, "responsibility", [
        { ...nativeResource(botId, "cr_studio"), createdBy: unrelatedId, details: { schemaName: "cr_studio", ownerId: manifestId, lastModifiedBy: manifestId } },
        { ...nativeResource(unrelatedId, "two"), details: { ownerId: manifestId } },
      ]);
      await publishPackages(packages, "responsibility-packages", [studioPackage()]);
      await cache.save(scope, [{ objectId: manifestId, status: "resolved", displayName: "Outside paid roster",
        userPrincipalName: "owner@example.invalid", checkedAt: new Date().toISOString() }], { generation: await cache.generation(scope) });
      const result = await service.responsibility(scope, { objectId: manifestId, limit: 1 });
      expect(result.selected?.person.evidence?.displayName).toBe("Outside paid roster");
      expect(result.selected?.count).toBe(2);
      expect(result.selected?.agents).toHaveLength(1);
      expect((await service.responsibility(scope, { objectId: manifestId })).selected?.agents.map(agent => agent.presence).sort())
        .toEqual(["both", "power_platform"]);
      const canonicalId = result.selected!.agents[0].id;
      expect(canonicalId).toMatch(/^agent:/);
      expect((await service.list(scope, { recordId: canonicalId })).value).toHaveLength(1);
      expect((await service.responsibility({ ...scope, principalId: "different-reader" })).people).toEqual([]);
      expect((await service.responsibility({ ...scope, tenantId: "different-tenant" })).people).toEqual([]);
      await expect(service.responsibility({ ...scope, principalId: "different-reader" }, { objectId: manifestId }))
        .rejects.toMatchObject({ code: "responsibility_person_unavailable" });
      await publishResources(powerPlatform, "responsibility-refresh", [
        { ...nativeResource(botId, "cr_studio"), createdBy: unrelatedId, details: { schemaName: "cr_studio", ownerId: manifestId } },
        { ...nativeResource(unrelatedId, "two"), details: { ownerId: manifestId } },
      ]);
      const refreshed = await service.responsibility(scope, { objectId: manifestId });
      expect(refreshed.selected?.agents.map(agent => agent.id)).toContain(canonicalId);
      expect(refreshed.revision).not.toBe(result.revision);
      await publishResources(powerPlatform, "responsibility-remove", []);
      expect((await service.responsibility(scope, { objectId: manifestId })).selected?.state).toBe("no_reported_relationships");
      await publishPackages(packages, "responsibility-remove-packages", []);
      expect((await service.list(scope, { recordId: canonicalId })).count).toBe(0);
    } finally { await fixture.close(); }
  });
  it("carries exact scoped environment and configured operations from provider projection through persistence and export", async () => {
    const fixture = await testDatabase();
    try {
      const packages = new PackageInventoryRepository(fixture.runtime);
      const powerPlatform = new PowerPlatformInventoryRepository(fixture.runtime);
      const creator = "52bff06b-5db5-42cd-9919-28f95e3c07af";
      const raw = [
        ...[botId, unrelatedId].map(name => ({
          tenantId: scope.tenantId, name, type: "microsoft.copilotstudio/agents", location: "europe",
          properties: {
            name, environmentId, displayName: "Same agent name", ownerId: manifestId, createdBy: botId,
            powerPlatformConnectors: [{ connectorId: "shared_excelonlinebusiness", operations: [{
              operationId: "RunScriptProd", createdBy: creator, isEnabled: false, requiresEndUserConsent: false,
              usedAs: "Topic Tool", whenCanBeUsed: "ViaDirectReferenceOnly", connectionProvider: "Maker",
              connectionIdSharedByMaker: "secret-connection", callbackUrl: "https://private.invalid/?sig=secret",
            }] }],
            capabilitiesCounts: { distinctPowerPlatformConnectors: 3, distinctPowerPlatformConnectorsOperations: 5 },
            flowIds: [unrelatedId],
          },
        })),
        ...[environmentId, manifestId].map(name => ({
          tenantId: scope.tenantId, name, type: "microsoft.powerplatform/environments", location: "europe",
          properties: { displayName: "Finance production", environmentType: "Production", isManaged: false, environmentGroup: "Finance" },
        })),
      ];
      const query = new PowerPlatformResourceQueryClient(async () => Response.json({
        totalRecords: raw.length, count: raw.length, resultTruncated: false, data: raw,
      }));
      const projected = await query.query("fixture-token", undefined, { expectedTenantId: scope.tenantId });
      const job = await powerPlatform.submit(scope, {
        idempotencyKey: "context", roleScope: "full",
        requestedTypes: ["microsoft.copilotstudio/agents", "microsoft.powerplatform/environments"],
      });
      await powerPlatform.markRunning(scope, job.id);
      const published = await powerPlatform.publish(scope, job.id, projected);
      const graphOnly = {
        ...studioPackage(), id: "unmatched-package",
        elementDetails: [{ elementType: "AgentMetadatas", elements: [{ id: "", definition: JSON.stringify({
          SourceIds: { EnvironmentId: environmentId, CdsBotId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee" },
        }) }] }],
      };
      await publishPackages(packages, "context-packages", [graphOnly]);
      const service = new UnifiedAgentsService({
        packages, powerPlatform, usage: new AgentUsageService(fixture.runtime), registry: new UnifiedAgentRegistry(fixture.runtime),
        resolveLinks: resolvePackageAgentLinks, operationPackageIds: async () => [],
        readRevision: (owner, database = fixture.runtime) => readUnifiedInventoryRevision(owner, database),
      });
      const page = await service.list(scope);
      expect(page.value).toHaveLength(3);
      expect(page.value.filter(record => record.presence === "power_platform")).toHaveLength(2);
      for (const record of page.value) expect(record.environment).toMatchObject({
        id: environmentId, displayName: "Finance production", region: "europe", environmentType: "Production",
        isManaged: false, groupName: "Finance", groupId: null,
        observation: { snapshotId: published.snapshotId, current: true },
        provenance: { isManaged: { path: "properties.isManaged", maturity: "ga" } },
      });
      const native = page.value.find(record => record.powerPlatformResource?.nativeId === botId)!;
      expect(native.powerPlatformResource?.details).toMatchObject({
        ownerId: manifestId, connectorDetailsStatus: "partial",
        connectors: [{ connectorId: "shared_excelonlinebusiness", operations: [{ createdBy: creator, isEnabled: false, requiresEndUserConsent: false }] }],
      });
      expect(native.powerPlatformResource?.createdBy).toBe(botId);
      expect(JSON.stringify(page)).not.toMatch(/secret-connection|private.invalid|flowIds/);
      const rows = parseCsv(buildUnifiedAgentCsv(page, Date.now() + 15_000).buffer, { columns: true, bom: true });
      const exported = rows.find((row: { agentId: string }) => row.agentId === native.id);
      expect(exported).toMatchObject({
        environmentName: "Finance production", managedEnvironment: "false", environmentSnapshotId: published.snapshotId,
        reportedConnectorTotal: "3", reportedOperationTotal: "5", savedConnectorDetails: "1", savedOperationDetails: "1",
        connectorDetailsStatus: "partial", owner: manifestId, createdBy: botId,
      });
      expect(JSON.parse(exported.configuredConnectors)[0].operations[0]).toMatchObject({ createdBy: creator, isEnabled: false });
      expect(exported.invokedFlowContext).toBe("unavailable_from_synced_sources");
      const refreshed = await powerPlatform.submit(scope, {
        idempotencyKey: "new-environment-context", roleScope: "full", requestedTypes: ["microsoft.powerplatform/environments"],
      });
      await powerPlatform.markRunning(scope, refreshed.id);
      const next = await powerPlatform.publish(scope, refreshed.id, {
        queriedTypes: ["microsoft.powerplatform/environments"], environmentScope: null, pages: 1, totalRecords: 1, unknownFieldCount: 0,
        resources: projected.resources.filter(value => value.nativeId === environmentId).map(value => ({ ...value, displayName: "Renamed environment" })),
      });
      const updated = await service.list(scope);
      expect(updated.value.every(record => record.environment?.observation.snapshotId === next.snapshotId)).toBe(true);
      expect(updated.revision).not.toBe(page.revision);
      await expect(service.forExport(scope, page.revision!)).rejects.toMatchObject({ code: "inventory_changed" });
    } finally {
      await fixture.close();
    }
  });

  it("projects reviewed usage into private inventories and fences filtered exports across associations and report changes", async () => {
    const fixture = await testDatabase();
    try {
      const packages = new PackageInventoryRepository(fixture.runtime);
      const powerPlatform = new PowerPlatformInventoryRepository(fixture.runtime);
      const usage = new AgentUsageService(fixture.runtime);
      const service = new UnifiedAgentsService({
        packages, powerPlatform, usage, registry: new UnifiedAgentRegistry(fixture.runtime),
        resolveLinks: resolvePackageAgentLinks, operationPackageIds: async () => [],
        readRevision: (owner, database = fixture.runtime) => readUnifiedInventoryRevision(owner, database),
      });
      await publishPackages(packages, "usage-inventory", ["used", "zero", "unlinked"].map((id, index) => ({
        ...builderPackage(id), type: "external", manifestId: [manifestId, botId, unrelatedId][index],
      })));
      await publishResources(powerPlatform, "usage-native-inventory", []);
      const reports = await publishUsageReports(fixture.runtime, scope);
      const before = await service.list(scope);
      expect(before.value.every(record => record.usage?.status === "unlinked")).toBe(true);
      expect((await service.list(scope, { view: "organization" })).count).toBe(0);
      const used = before.value.find(record => record.packages[0].id === "used")!;
      await usage.attach(scope, used.id, {
        reportSetId: reports.setId, reportAgentId: "Report-A", target: { source: "graph_packages", packageId: "used" },
        expectedInventoryRevision: before.revision!, expectedUsageRevision: before.usageContext!.revision, confirmed: true,
      }, usageAudit(scope));
      const after = await service.list(scope);
      const zero = after.value.find(record => record.packages[0].id === "zero")!;
      await usage.attach(scope, zero.id, {
        reportSetId: reports.setId, reportAgentId: "Report-Zero", target: { source: "graph_packages", packageId: "zero" },
        expectedInventoryRevision: after.revision!, expectedUsageRevision: after.usageContext!.revision, confirmed: true,
      }, usageAudit(scope));
      const sorted = await service.list(scope, { sortBy: "responses", sortDirection: "desc" });
      expect(sorted.value.map(record => record.usage?.responses)).toEqual([10, 0, null]);
      expect(sorted.value.map(record => record.usage?.activeUsers)).toEqual([2, 0, null]);
      const zeroPage = await service.list(scope, { sortBy: "responses", sortDirection: "desc", offset: 1, limit: 1 });
      expect(zeroPage.value[0].id).toBe(zero.id);
      const filtered = await service.list(scope, { view: "used", limit: 1 });
      expect(filtered).toMatchObject({ count: 1, summary: { total: 3 }, filteredSummary: { total: 1 } });
      expect(filtered.value[0].id).toBe(used.id);
      expect((await service.list(scope, { view: "organization" })).value.map(record => record.id)).toEqual([used.id]);
      await expect(service.assertRevision(scope, before.revision!)).rejects.toMatchObject({ code: "inventory_changed" });
      const exported = await service.forExport(scope, sorted.revision!, { view: "used" });
      expect(buildUnifiedAgentCsv(exported, Date.now() + 15_000).rowCount).toBe(1);
      await service.assertRevision(scope, sorted.revision!);

      const otherReader = { ...scope, principalId: "other-usage-reader" };
      expect((await service.list(otherReader, { view: "used" })).count).toBe(0);
      await saveUsageInventory(fixture.runtime, otherReader, [{ packages: ["used"] }]);
      const authorized = await service.list(otherReader, { view: "used" });
      expect(authorized.value[0].usage).toMatchObject({ status: "linked", responses: 10, activeUsers: 2 });
      expect(authorized.value[0].id).not.toBe(used.id);
      expect((await service.list({ tenantId: "unrelated-tenant", principalId: scope.principalId }, { view: "used" })).count).toBe(0);

      const replacement = await publishUsageReports(fixture.runtime, scope, 11);
      expect((await service.list(scope, { view: "used" })).count).toBe(0);
      await expect(service.forExport(scope, sorted.revision!, { view: "used" })).rejects.toMatchObject({ code: "inventory_changed" });
      const replaced = await service.list(scope);
      await deleteUsageSet(fixture.runtime, scope, replacement.setId);
      expect((await service.list(scope)).usageContext).toMatchObject({ reportSet: null, availability: "not_selected" });
      await expect(service.assertRevision(scope, replaced.revision!)).rejects.toMatchObject({ code: "inventory_changed" });
    } finally {
      await fixture.close();
    }
  });

  it("does not erase canonical ownership when a saved source exceeds the reader bound", async () => {
    const fixture = await testDatabase();
    try {
      const packages = new PackageInventoryRepository(fixture.runtime);
      const powerPlatform = new PowerPlatformInventoryRepository(fixture.runtime);
      const registry = new UnifiedAgentRegistry(fixture.runtime);
      const dependencies = {
        packages, powerPlatform, registry, resolveLinks: resolvePackageAgentLinks, operationPackageIds: async () => [],
        usage: new AgentUsageService(fixture.runtime),
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
        usage: new AgentUsageService(fixture.runtime),
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

  it("reconciles both real source schemas before paging and preserves memberships, controls and IDs across scope switches and refresh", async () => {
    const fixture = await testDatabase();
    try {
      const packages = new PackageInventoryRepository(fixture.runtime);
      const powerPlatform = new PowerPlatformInventoryRepository(fixture.runtime);
      const registry = new UnifiedAgentRegistry(fixture.runtime);
      const service = new UnifiedAgentsService({
        packages, powerPlatform, registry, resolveLinks: resolvePackageAgentLinks, operationPackageIds: async () => [],
        usage: new AgentUsageService(fixture.runtime),
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
      const first = await service.list(scope, { inventoryScope: "catalog", limit: 1 });
      expect(first).toMatchObject({
        inventoryScope: "catalog", count: 3, partial: false,
        summary: { total: 4, linked: 2, graphOnly: 1, powerPlatformOnly: 1, ambiguous: 0, conflicting: 0 },
        scopeSummary: { total: 3, linked: 2, graphOnly: 1, powerPlatformOnly: 0, ambiguous: 0, conflicting: 0 },
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
      const memberships = async () => (await fixture.operator.query(
        `SELECT agent_id,source,normalized_environment_id,normalized_native_id FROM unified_agent_sources
         WHERE tenant_id=$1 AND principal_id=$2 ORDER BY source,normalized_environment_id,normalized_native_id`,
        [scope.tenantId, scope.principalId],
      )).rows;
      const beforeMemberships = await memberships();
      expect(beforeMemberships).toHaveLength(7);
      const nativeOnly = complete.value.find(record => !record.packages.length)!;
      for (const inventoryScope of ["power_platform_only", "catalog", "all", "catalog", "power_platform_only"] as const) {
        const scoped = await service.list(scope, { inventoryScope });
        expect(scoped.inventoryScope).toBe(inventoryScope);
        const expected = complete.value.filter(record => inventoryScope === "all"
          || (inventoryScope === "catalog" ? record.packages.length > 0 : record.packages.length === 0));
        expect(scoped.value.map(record => record.id).sort()).toEqual(expected.map(record => record.id).sort());
        expect(scoped.count).toBe(expected.length);
        expect(scoped.scopeSummary.total).toBe(expected.length);
        expect(scoped.summary).toEqual(complete.summary);
        expect(scoped.verification).toMatchObject({ representedSourceCount: 7, uniqueSourceCount: 7, logicalAgentCount: 4 });
        expect(scoped.revision).toBe(complete.revision);
        expect(await memberships()).toEqual(beforeMemberships);
        const filteredExport = await service.forExport(scope, complete.revision!, { inventoryScope });
        expect(filteredExport.inventoryScope).toBe(inventoryScope);
        expect(filteredExport.value.map(record => record.id).sort()).toEqual(expected.map(record => record.id).sort());
        expect(await memberships()).toEqual(beforeMemberships);
      }
      expect((await service.list(scope, { recordId: nativeOnly.id })).value[0].id).toBe(nativeOnly.id);
      expect((await service.forExport(scope, complete.revision!, {}, [nativeOnly.id])).value[0].id).toBe(nativeOnly.id);
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
        usage: new AgentUsageService(fixture.runtime),
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
