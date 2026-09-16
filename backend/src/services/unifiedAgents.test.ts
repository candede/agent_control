import { describe, expect, it, vi } from "vitest";
import { AppError } from "../errors.js";
import type { CopilotPackageDetail } from "../types/copilotPackage.js";
import type { InventorySnapshot, PowerPlatformResource } from "../types/powerPlatformInventory.js";
import { resolvePackageAgentLinks } from "./packageAgentIdentity.js";
import { unifiedAgentRecordId } from "../types/unifiedAgents.js";
import { UnifiedAgentsService, type UnifiedAgentDependencies } from "./unifiedAgents.js";

const tenantId = "tenant-unified";
const environmentA = "11111111-1111-4111-8111-111111111111";
const environmentB = "22222222-2222-4222-8222-222222222222";
const botA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function packageValue(id: string, displayName: string, linked = false): CopilotPackageDetail {
  return {
    id,
    displayName,
    isBlocked: id.endsWith("blocked"),
    availableTo: "unknownFutureValue",
    deployedTo: "allowedForNoOne",
    sourceSystem: "graph_packages",
    authoringTool: "Copilot Studio",
    creatorType: "unknown",
    agentKind: "copilot_package",
    lifecycle: "unknown",
    identityConfidence: "exact_native",
    provenance: {},
    allowedUsersAndGroups: [{ resourceId: "secret-principal", resourceType: "user" }],
    elementDetails: linked ? [{
      elementType: "AgentMetadatas",
      elements: [{
        id: "metadata",
        definition: JSON.stringify({ SourceIds: { EnvironmentId: environmentA, CdsBotId: botA } }),
      }],
    }] : undefined,
  };
}

function resource(environmentId: string, nativeId = "shared-native"): PowerPlatformResource {
  return {
    tenantId,
    nativeId,
    type: "microsoft.copilotstudio/agents",
    location: "unitedstates",
    displayName: "Same displayed name",
    environmentId,
    createdAt: "2026-09-01T00:00:00.000Z",
    createdBy: null,
    lastPublishedAt: null,
    sourceSystem: "power_platform",
    authoringTool: "Copilot Studio",
    creatorType: "unknown",
    agentKind: "copilot_studio_agent",
    lifecycle: "published",
    identityConfidence: "exact_native",
    identifiers: [
      { kind: "environment_id", value: environmentId },
      { kind: "power_platform_resource_id", value: nativeId },
      ...(environmentId === environmentA ? [{ kind: "cds_bot_id" as const, value: botA }] : []),
    ],
    provenance: {},
    details: { description: "Provider metadata" },
    unknownFieldCount: 0,
  };
}

function powerPlatformSnapshot(coverage: "covered" | "unknown" = "covered"): InventorySnapshot {
  return {
    id: "22222222-2222-4222-8222-222222222220",
    roleScope: coverage === "covered" ? "full" : "unknown",
    environmentScope: null,
    requestedTypes: ["microsoft.copilotstudio/agents"],
    coverage: [{ type: "microsoft.copilotstudio/agents", status: coverage, count: coverage === "covered" ? 2 : null }],
    observedCount: 2,
    totalRecords: 2,
    pageCount: 1,
    unknownFieldCount: 0,
    observedAt: "2026-09-15T00:00:00.000Z",
    expiresAt: "2026-09-22T00:00:00.000Z",
  };
}

function dependencies(options: {
  packages?: CopilotPackageDetail[];
  resources?: PowerPlatformResource[];
  environmentNames?: Record<string, string>;
  packageSnapshot?: boolean;
  observedAt?: string;
  powerPlatformSnapshot?: InventorySnapshot | null;
} = {}): UnifiedAgentDependencies {
  return {
    packages: {
      readUnifiedSource: vi.fn(async () => ({
        packages: options.packages ?? [],
        observations: Object.fromEntries((options.packages ?? []).map(value => [value.id, {
          snapshotId: "11111111-1111-4111-8111-111111111110",
          scopeKind: "broad" as const,
          observedAt: options.observedAt ?? "2026-09-15T00:00:00.000Z",
          expiresAt: "2026-09-22T00:00:00.000Z",
        }])),
        snapshot: options.packageSnapshot === false ? null : {
          id: "11111111-1111-4111-8111-111111111110",
          tokenMode: "delegated" as const,
          scopeKind: "broad" as const,
          requestedIds: [],
          observedCount: options.packages?.length ?? 0,
          totalRecords: options.packages?.length ?? 0,
          pageCount: 1,
          observedAt: "2026-09-15T00:00:00.000Z",
          expiresAt: "2026-09-22T00:00:00.000Z",
        },
      })),
    },
    powerPlatform: {
      readUnifiedSource: vi.fn(async () => ({
        resources: options.resources ?? [],
        environmentNames: options.environmentNames ?? {},
        snapshot: options.powerPlatformSnapshot === undefined ? powerPlatformSnapshot() : options.powerPlatformSnapshot,
      })),
    },
    resolveLinks: resolvePackageAgentLinks,
    operationPackageIds: vi.fn(async () => []),
  };
}

describe("UnifiedAgentsService", () => {
  it("merges production-shaped source records before counts and paging while keeping identical names separate", async () => {
    const published = {
      ...packageValue("package-a", "Clinical Treatment Plan"),
      identityDetailsCollected: true as const,
      elementDetails: [{
        elementType: "AgentMetadatas",
        elements: [{ id: "metadata", definition: JSON.stringify({
          SourceIds: { EnvironmentId: environmentA, SchemaName: "cr123_clinical", CdsBotId: botA },
        }) }],
      }],
    };
    const observed = {
      ...resource(environmentA, botA), displayName: published.displayName,
      identifiers: [{ kind: "environment_id" as const, value: environmentA }, { kind: "power_platform_resource_id" as const, value: botA }],
      details: { schemaName: "cr123_clinical", isQuarantined: false },
    };
    const service = new UnifiedAgentsService(dependencies({
      packages: [published, { ...published, id: "package-b" }, packageValue("unproven", published.displayName)],
      resources: [observed, { ...resource(environmentB, botA), displayName: published.displayName }],
      observedAt: new Date().toISOString(),
    }));
    const full = await service.list({ tenantId, principalId: "viewer" });
    expect(full).toMatchObject({
      count: 3, summary: { total: 3, linked: 1, graphOnly: 1, powerPlatformOnly: 1 },
      identityCollection: { checkedPackages: 2, pendingPackages: 1 },
    });
    const merged = full.value.find(value => value.presence === "both")!;
    expect(merged.packages.map(value => value.id)).toEqual(["package-a", "package-b"]);
    expect(merged.powerPlatformResource?.identifiers).toContainEqual({ kind: "cds_bot_id", value: botA });
    expect(merged.packages[0]).not.toHaveProperty("identityDetailsCollected");
    expect(merged.packages[0]).not.toHaveProperty("elementDetails");
    const paged = await service.list({ tenantId, principalId: "viewer" }, { limit: 1, offset: 1 });
    expect(paged.count).toBe(3);
    expect(paged.value).toHaveLength(1);
    const exact = await service.list({ tenantId, principalId: "viewer" }, { recordId: "graph_packages:package-a" });
    expect(exact.value.map(value => value.id)).toEqual([merged.id]);
    const filtered = await service.list({ tenantId, principalId: "viewer" }, { search: "does not exist" });
    expect(filtered).toMatchObject({ count: 0, identityCollection: { checkedPackages: 2, pendingPackages: 1 } });
  });

  it("returns all authorized environment and authoring choices independently of filtering and pagination", async () => {
    const pkg = { ...packageValue("custom", "Custom agent"), authoringTool: "CustomSDK" };
    const service = new UnifiedAgentsService(dependencies({
      packages: [pkg],
      resources: [resource(environmentA, "first"), resource(environmentA, "second"), resource(environmentB)],
      environmentNames: { [environmentA]: "Finance production" },
    }));
    const result = await service.list({ tenantId, principalId: "viewer" }, { environmentId: environmentB, search: "absent", offset: 50, limit: 1 });
    expect(result.value).toEqual([]);
    expect(result.facets.environments).toEqual(expect.arrayContaining([
      { value: environmentA, label: "Finance production" },
      { value: environmentB, label: environmentB },
    ]));
    expect(result.facets.environments).toHaveLength(2);
    expect(result.facets.platforms).toEqual([
      { value: "Copilot Studio", label: "Copilot Studio" },
      { value: "Custom SDK", label: "Custom SDK" },
    ]);
    const unavailable = await new UnifiedAgentsService(dependencies({
      resources: [resource(environmentA)], environmentNames: { [environmentA]: "Must not be exposed" }, powerPlatformSnapshot: null,
    })).list({ tenantId, principalId: "viewer" });
    expect(unavailable.facets).toEqual({ environments: [], platforms: [] });
  });

  it("filters Copilot Studio-only agents by saved authoring tool and creation age without inventing package properties", async () => {
    const recent = { ...resource(environmentA, "recent"), createdAt: new Date(Date.now() - 2 * 86_400_000).toISOString() };
    const old = { ...resource(environmentB, "old"), createdAt: new Date(Date.now() - 31 * 86_400_000).toISOString() };
    const undated = { ...resource(environmentB, "undated"), createdAt: null, authoringTool: null };
    const service = new UnifiedAgentsService(dependencies({ resources: [recent, old, undated] }));
    const scope = { tenantId, principalId: "viewer" };
    const result = await service.list(scope, { platform: "Copilot Studio", createdWithinDays: 30 });
    expect(result.value.map(value => value.powerPlatformResource?.nativeId)).toEqual(["recent"]);
    expect((await service.list(scope, { platform: "copilotstudio" })).count).toBe(2);
    expect((await service.list(scope, { createdWithinDays: 1 })).count).toBe(0);
    for (const filter of [{ availableTo: "some" }, { host: "Teams" }, { blocked: false }]) {
      expect((await service.list(scope, filter)).count).toBe(0);
    }
  });

  it("applies authorized operation references to grouped rows before pagination", async () => {
    const deps = dependencies({
      packages: [
        packageValue("grouped-a", "Another package for the same resource", true),
        packageValue("matched", "Unrelated display label", true),
        packageValue("not-matched", "Reference-like name"),
      ],
      resources: [resource(environmentA), resource(environmentB)],
    });
    deps.operationPackageIds = vi.fn(async () => ["matched"]);
    const result = await new UnifiedAgentsService(deps).list({ tenantId, principalId: "viewer" }, { operationIdPrefix: "a5331a93", limit: 1 });
    expect(result.count).toBe(1);
    expect(result.value[0]).toMatchObject({ presence: "both", packages: [{ id: "grouped-a" }, { id: "matched" }] });
    expect(deps.operationPackageIds).toHaveBeenCalledWith({ tenantId, principalId: "viewer" }, ["grouped-a", "matched", "not-matched"], "a5331a93");
    deps.operationPackageIds = vi.fn(async () => []);
    expect(await new UnifiedAgentsService(deps).list({ tenantId, principalId: "viewer" }, { operationIdPrefix: "unmatched" })).toMatchObject({
      count: 0,
      value: [],
    });
  });

  it("resolves an exact row independently of pagination, including grouped package and environment-qualified links", async () => {
    const service = new UnifiedAgentsService(dependencies({
      packages: [packageValue("linked-a", "Package", true), ...Array.from({ length: 60 }, (_, index) => packageValue(`package-${index}`, `A ${index}`))],
      resources: [resource(environmentA), resource(environmentB)],
    }));
    const owner = { tenantId, principalId: "viewer" };
    const packageLink = await service.list(owner, { recordId: unifiedAgentRecordId({ source: "graph_packages", packageId: "linked-a" }) });
    expect(packageLink.count).toBe(1);
    expect(packageLink.value[0]).toMatchObject({ presence: "both", environmentId: environmentA, packages: [{ id: "linked-a" }] });
    const resourceLink = await service.list(owner, { recordId: unifiedAgentRecordId({ source: "power_platform", environmentId: environmentB, nativeId: "shared-native" }) });
    expect(resourceLink.count).toBe(1);
    expect(resourceLink.value[0]).toMatchObject({ presence: "power_platform", environmentId: environmentB });
    expect((await service.list(owner, { recordId: "graph_packages:absent" })).count).toBe(0);
  });

  it("groups every verified package with one resource and paginates only after grouping", async () => {
    const packages = [
      packageValue("linked-a", "Same displayed name", true),
      packageValue("linked-b-blocked", "Same displayed name", true),
      packageValue("graph-only", "Same displayed name"),
    ];
    const service = new UnifiedAgentsService(dependencies({
      packages,
      resources: [resource(environmentA), resource(environmentB)],
    }));
    const result = await service.list({ tenantId, principalId: "viewer" }, { limit: 1, offset: 0 });

    expect(result.summary).toEqual({
      total: 3, linked: 1, graphOnly: 1, powerPlatformOnly: 1, ambiguous: 0, conflicting: 0,
    });
    expect(result.count).toBe(3);
    expect(result.value).toHaveLength(1);
    const linked = (await service.list({ tenantId, principalId: "viewer" }, { source: "both" })).value[0];
    expect(linked.environmentId).toBe(environmentA);
    expect(linked.packages.map(value => value.id)).toEqual(["linked-a", "linked-b-blocked"]);
    expect(linked.packages[1]).toMatchObject({
      isBlocked: true,
      availableTo: "unknownFutureValue",
      deployedTo: "allowedForNoOne",
    });
    expect(linked.packages[0]).not.toHaveProperty("elementDetails");
    expect(linked.packages[0]).not.toHaveProperty("allowedUsersAndGroups");
    expect(linked.powerPlatformResource?.details.description).toBe("Provider metadata");
    expect(linked.packages).toHaveLength(2);
    expect(linked.identity.evidence[0]).toMatchObject({
      basis: "source_declared_metadata",
      elementIds: ["metadata"],
    });
    expect(linked.identity.packageEvidence.map(value => value.packageId)).toEqual([
      "linked-a",
      "linked-b-blocked",
    ]);
    expect(linked.observations.packageSnapshots["linked-a"]).toMatchObject({
      scopeKind: "broad",
      current: true,
    });
  });

  it("preserves environment-separated and same-name source-only rows without deduplication", async () => {
    const service = new UnifiedAgentsService(dependencies({
      packages: [packageValue("graph-a", "Duplicate"), packageValue("graph-b", "Duplicate")],
      resources: [resource(environmentA), resource(environmentB)],
    }));
    const result = await service.list({ tenantId, principalId: "viewer" }, { search: "duplicate" });
    expect(result.count).toBe(2);
    expect(result.value.map(value => value.packages[0].id)).toEqual(["graph-a", "graph-b"]);
    const powerOnly = await service.list({ tenantId, principalId: "viewer" }, { source: "power_platform" });
    expect(powerOnly.value.map(value => value.environmentId).sort()).toEqual([environmentA, environmentB]);
  });

  it("reports expected missing or incomplete sources explicitly while returning the other source", async () => {
    const missingGraph = new UnifiedAgentsService(dependencies({
      packageSnapshot: false,
      resources: [resource(environmentA)],
    }));
    const result = await missingGraph.list({ tenantId, principalId: "viewer" });
    expect(result).toMatchObject({
      partial: true,
      count: 1,
      sources: { graphPackages: { state: "unavailable", error: { code: "snapshot_unavailable" } } },
    });

    const incompletePowerPlatform = new UnifiedAgentsService(dependencies({
      packages: [packageValue("graph-only", "Graph")],
      resources: [resource(environmentA)],
      powerPlatformSnapshot: powerPlatformSnapshot("unknown"),
    }));
    const partial = await incompletePowerPlatform.list({ tenantId, principalId: "viewer" });
    expect(partial.sources.powerPlatform).toMatchObject({ state: "partial", error: { code: "coverage_unknown" } });
    expect(partial.count).toBe(2);
  });

  it("converts only bounded source-limit errors and propagates unexpected repository failures", async () => {
    const limited = dependencies({ resources: [resource(environmentA)] });
    limited.packages.readUnifiedSource = vi.fn(async () => {
      throw new AppError(409, "source_result_limit", "Too many packages.");
    });
    const partial = await new UnifiedAgentsService(limited).list({ tenantId, principalId: "viewer" });
    expect(partial.errors).toEqual([{ source: "graph_packages", code: "source_result_limit", message: "Too many packages." }]);

    const failed = dependencies();
    failed.packages.readUnifiedSource = vi.fn(async () => { throw new Error("database unavailable"); });
    await expect(new UnifiedAgentsService(failed).list({ tenantId, principalId: "viewer" })).rejects.toThrow("database unavailable");
  });

  it("reports global and filtered counts independently", async () => {
    const service = new UnifiedAgentsService(dependencies({
      packages: [packageValue("alpha", "Alpha"), packageValue("beta", "Beta")],
      resources: [resource(environmentA)],
    }));
    const result = await service.list({ tenantId, principalId: "viewer" }, {
      source: "graph_packages", linkState: "unmatched", search: "alpha",
    });
    expect(result.summary.total).toBe(3);
    expect(result.filteredSummary).toMatchObject({ total: 1, graphOnly: 1 });
    expect(result.count).toBe(1);
  });

  it("matches retained package filters against any package in a grouped row", async () => {
    const allowed = packageValue("linked-allowed", "Grouped", true);
    allowed.publisher = "Publisher";
    allowed.availableTo = "some";
    allowed.supportedHosts = ["Teams"];
    allowed.platform = "CopilotStudio";
    allowed.createdDateTime = new Date().toISOString();
    const blocked = packageValue("linked-blocked", "Grouped", true);
    blocked.isBlocked = true;
    const service = new UnifiedAgentsService(dependencies({
      packages: [allowed, blocked],
      resources: [resource(environmentA)],
    }));
    const scope = { tenantId, principalId: "viewer" };

    for (const query of [
      { blocked: true },
      { blocked: false },
      { publisher: "Publisher" },
      { availableTo: "__some_or_all__" },
      { host: "Teams" },
      { platform: "Copilot Studio" },
      { createdWithinDays: 1 },
    ]) {
      const result = await service.list(scope, { source: "both", ...query });
      expect(result.count, JSON.stringify(query)).toBe(1);
      expect(result.value[0].packages).toHaveLength(2);
    }
  });
});
