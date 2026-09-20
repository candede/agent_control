import { describe, expect, it, vi } from "vitest";
import { parse as parseCsv } from "csv-parse/sync";
import pg from "pg";
import { AppError } from "../errors.js";
import type { CopilotPackageDetail } from "../types/copilotPackage.js";
import type { InventorySnapshot, PowerPlatformResource } from "../types/powerPlatformInventory.js";
import { resolvePackageAgentLinks } from "./packageAgentIdentity.js";
import { unifiedAgentRecordId } from "../types/unifiedAgents.js";
import type { UnifiedAgentRecord } from "../types/unifiedAgents.js";
import type { AgentUsageContext, AgentUsageSummary } from "../types/agentUsage.js";
import { agentColumnValue, agentStatusLabels } from "../types/agentPresentation.js";
import { combineAgentInventoryRevision } from "./agentUsage.js";
import { UnifiedAgentsService, type UnifiedAgentDependencies } from "./unifiedAgents.js";
import { buildUnifiedAgentCsv } from "./unifiedAgentExport.js";
import { SavedAgentPeopleService } from "./savedAgentPeople.js";
import type { CopilotDirectoryUser } from "./copilotUsageGraph.js";
import { readUnifiedInventoryRevision } from "../db/unifiedInventoryRevision.js";

const tenantId = "tenant-unified";
const environmentA = "11111111-1111-4111-8111-111111111111";
const environmentB = "22222222-2222-4222-8222-222222222222";
const botA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const usageContext: AgentUsageContext = { availability: "never_imported", reportSet: null, lineages: [], revision: "c".repeat(64) };
const inventoryRevision = combineAgentInventoryRevision("a".repeat(64), usageContext.revision);

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
    verification: {
      status: "verified", scope: "authorized_query", basis: "provider_total_and_saved_rows",
      checkedAt: "2026-09-15T00:00:00.000Z", storedCount: 2, uniqueIdentityCount: 2, queriedTypes: ["microsoft.copilotstudio/agents"],
    },
  };
}

function dependencies(options: {
  packages?: CopilotPackageDetail[];
  resources?: PowerPlatformResource[];
  environmentNames?: Record<string, string>;
  packageSnapshot?: boolean;
  observedAt?: string;
  powerPlatformSnapshot?: InventorySnapshot | null;
  directory?: CopilotDirectoryUser[];
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
    readRevision: vi.fn(async () => "a".repeat(64)),
    people: new SavedAgentPeopleService({
      getDirectorySource: vi.fn(async () => ({
        source: "directory", attemptStatus: options.directory ? "available" : null, message: null,
        attemptedAt: null, lastSuccessAt: null, rowCount: options.directory?.length ?? null,
        observedAt: options.directory ? "2026-09-15T10:00:00.000Z" : null, value: options.directory ?? null,
      })),
    }, { read: vi.fn(async () => []) }),
    usage: {
      project: vi.fn(async (_scope: { tenantId: string; principalId: string }, records: readonly UnifiedAgentRecord[]) => ({
        context: usageContext,
        summaries: new Map(records.map(record => [record.id, {
          status: "unavailable" as const, reportSetId: null, responses: null, activeUsers: null, lastActivityDateUtc: null, associations: [],
        }])),
      })),
      revision: vi.fn(async () => usageContext.revision),
    },
  };
}

describe("UnifiedAgentsService", () => {
  it.each((["owner", "createdBy"] as const).flatMap(sortBy =>
    (["asc", "desc"] as const).map(sortDirection => ({ sortBy, sortDirection })),
  ))("enriches linked and native people before $sortBy $sortDirection sort, search, paging and CSV while retaining source IDs", async query => {
    const ownerA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const ownerB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const directory = [
      { objectId: ownerA.toUpperCase(), displayName: "Zebra Person", userPrincipalName: "zebra@example.com" },
      { objectId: ownerB, displayName: "Alpha Person", userPrincipalName: "alpha@example.com" },
    ].map(identity => ({
      identity: { ...identity, accountEnabled: true, userType: "Member", employeeType: null, department: null, companyName: null },
      licenses: [], servicePlans: [],
    }));
    const resources = [resource(environmentA), resource(environmentB, "native-only")].map((value, index) => ({
      ...value, createdBy: directory[index].identity.objectId,
      details: { ...value.details, ownerId: directory[index].identity.objectId, lastModifiedBy: directory[index].identity.objectId },
    }));
    const deps = dependencies({ packages: [packageValue("linked", "Linked", true)], resources, directory });
    const service = new UnifiedAgentsService(deps);
    const scope = { tenantId, principalId: "viewer" };
    const expected = query.sortDirection === "asc" ? ["native-only", "shared-native"] : ["shared-native", "native-only"];
    const page = await service.list(scope, { ...query, offset: 1, limit: 1 });
    expect(page).toMatchObject({ count: 2, summary: { total: 2, linked: 1, powerPlatformOnly: 1 } });
    expect(page.value[0].powerPlatformResource?.nativeId).toBe(expected[1]);
    expect(page.verification.checks.sourceMemberships).toBe(true);
    const exported = await service.forExport(scope, page.revision!, query);
    expect(exported.value.map(value => value.powerPlatformResource?.nativeId)).toEqual(expected);
    const rows = parseCsv(buildUnifiedAgentCsv(exported, Date.now() + 15_000).buffer, { bom: true, columns: true }) as Array<Record<string, string>>;
    for (const [index, value] of exported.value.entries()) {
      const saved = directory.find(person => person.identity.objectId === value.powerPlatformResource?.createdBy)!;
      expect(value.people?.owner).toEqual({
        objectId: saved.identity.objectId.toLowerCase(), displayName: saved.identity.displayName,
        userPrincipalName: saved.identity.userPrincipalName, observedAt: "2026-09-15T10:00:00.000Z",
      });
      expect(value.people?.owner).toEqual(value.people?.createdBy);
      expect(value.people?.owner).toEqual(value.people?.lastModifiedBy);
      expect(agentColumnValue(value, query.sortBy)).toBe(`${saved.identity.displayName} (${saved.identity.userPrincipalName})`);
      expect(rows[index]).toMatchObject({
        owner: saved.identity.objectId, createdBy: saved.identity.objectId, lastModifiedBy: saved.identity.objectId,
        ownerDisplayName: saved.identity.displayName, ownerUserPrincipalName: saved.identity.userPrincipalName,
        ownerObservedAt: "2026-09-15T10:00:00.000Z",
        ownerResolutionStatus: "resolved", createdByResolutionStatus: "resolved", lastModifiedByResolutionStatus: "resolved",
        createdByDisplayName: saved.identity.displayName, createdByUserPrincipalName: saved.identity.userPrincipalName,
        lastModifiedByDisplayName: saved.identity.displayName, lastModifiedByUserPrincipalName: saved.identity.userPrincipalName,
      });
    }
    const searched = await service.list(scope, { search: "alpha@example.com" });
    expect(searched.count).toBe(1);
    expect(searched.value[0].powerPlatformResource?.nativeId).toBe("native-only");
    expect((await service.list(scope, { search: "Zebra Person" })).count).toBe(1);
    expect((await service.list(scope, { search: ownerA })).count).toBe(1);
  });

  it("uses raw native people IDs without a directory observation and never hides a failed saved-source read", async () => {
    const native = { ...resource(environmentA), createdBy: botA, details: { ownerId: botA, lastModifiedBy: botA } };
    const deps = dependencies({ resources: [native] });
    const service = new UnifiedAgentsService(deps);
    const [record] = (await service.list({ tenantId, principalId: "viewer" })).value;
    expect(record.people).toBeUndefined();
    expect(agentColumnValue(record, "owner")).toBe(botA);
    expect(agentColumnValue(record, "createdBy")).toBe(botA);
    deps.people = { project: vi.fn().mockRejectedValue(new AppError(409, "copilot_usage_snapshot_invalid", "Invalid saved directory.")) };
    await expect(service.list({ tenantId, principalId: "viewer" })).rejects.toMatchObject({ code: "copilot_usage_snapshot_invalid" });
  });

  it("fences saved directory replacements, expiry and replacement during a read using the shared opaque revision", async () => {
    const database = new pg.Pool();
    let directorySnapshot: string | null = environmentA;
    const query = vi.spyOn(database, "query").mockImplementation(async () => ({
      rows: directorySnapshot ? [{
        source: "directory", id: directorySnapshot,
        observed_at: new Date("2026-09-15T10:00:00.000Z"), expires_at: new Date("2026-10-15T10:00:00.000Z"),
      }] : [],
      rowCount: directorySnapshot ? 1 : 0, fields: [], command: "SELECT", oid: 0,
    }));
    try {
      const deps = dependencies({ resources: [resource(environmentA)] });
      deps.readRevision = scope => readUnifiedInventoryRevision(scope, database);
      const service = new UnifiedAgentsService(deps);
      const scope = { tenantId, principalId: "viewer" };
      const before = await service.list(scope);
      const sql = String(query.mock.calls[0][0]);
      for (const predicate of [
        "snapshot.id=state.current_snapshot_id", "snapshot.tenant_id=state.tenant_id",
        "snapshot.principal_id=state.principal_id", "snapshot.source_id=state.source_id",
        "snapshot.is_current", "snapshot.expires_at>clock_timestamp()", "state.source_id='directory'",
        "state.tenant_id=$1", "state.principal_id=$2",
      ]) expect(sql).toContain(predicate);
      await expect(service.assertRevision(scope, before.revision!)).resolves.toBeUndefined();
      directorySnapshot = environmentB;
      await expect(service.assertRevision(scope, before.revision!)).rejects.toMatchObject({ code: "inventory_changed" });
      await expect(service.forExport(scope, before.revision!)).rejects.toMatchObject({ code: "inventory_changed" });
      const replacement = await service.list(scope);
      expect(replacement.revision).not.toBe(before.revision);
      expect(replacement.value.map(value => value.id)).toEqual(before.value.map(value => value.id));
      directorySnapshot = null;
      await expect(service.assertRevision(scope, replacement.revision!)).rejects.toMatchObject({ code: "inventory_changed" });
      directorySnapshot = environmentA;
      deps.people = { project: vi.fn(async (_scope, records) => {
        directorySnapshot = environmentB;
        return [...records];
      }) };
      await expect(service.list(scope)).rejects.toMatchObject({ code: "inventory_changed" });
    } finally {
      query.mockRestore();
      await database.end();
    }
  });

  it("agrees on legacy Power Platform Lite display, facets, filtering, sorting and CSV", async () => {
    const service = new UnifiedAgentsService(dependencies({ resources: [
      { ...resource(environmentB, "lite"), authoringTool: null, details: { createdIn: "Copilot Studio Lite" } },
      { ...resource(environmentB, "studio"), authoringTool: "Copilot Studio" },
      { ...resource(environmentB, "zebra"), authoringTool: "Zebra SDK" },
    ] }));
    const scope = { tenantId, principalId: "viewer" };
    const label = "Microsoft 365 Copilot Agent Builder";
    const page = await service.list(scope, { sortBy: "builtWith", offset: 1, limit: 1 });
    expect(page.facets.platforms).toEqual([
      { value: "Copilot Studio", label: "Copilot Studio" }, { value: label, label }, { value: "Zebra SDK", label: "Zebra SDK" },
    ]);
    expect(page.value[0].powerPlatformResource?.nativeId).toBe("lite");
    expect(agentColumnValue(page.value[0], "builtWith")).toBe(label);
    const filtered = await service.list(scope, { platform: label });
    expect(filtered.count).toBe(1);
    expect(filtered.value[0].powerPlatformResource?.nativeId).toBe("lite");
    expect((await service.list(scope, { platform: "Copilot Studio Lite" })).count).toBe(1);
    const exported = await service.forExport(scope, page.revision!, { sortBy: "builtWith" });
    expect(exported.value.map(value => value.powerPlatformResource?.nativeId)).toEqual(["studio", "lite", "zebra"]);
    const rows = parseCsv(buildUnifiedAgentCsv(exported, Date.now() + 15_000).buffer, { bom: true, columns: true }) as Array<Record<string, string>>;
    expect(rows.map(row => row.builtWith)).toEqual(["Copilot Studio", label, "Zebra SDK"]);
  });

  it("keeps inventory dashboard counts global before search and pagination", async () => {
    const deps = dependencies({ packages: [
      { ...packageValue("created", "Created"), type: "custom", availableTo: "all", supportedHosts: ["Teams"], isBlocked: false },
      { ...packageValue("available", "Available"), type: "external", availableTo: "some", supportedHosts: ["Teams"], isBlocked: false },
      { ...packageValue("other", "Other"), type: "external", availableTo: "none", supportedHosts: ["Teams"], isBlocked: false },
    ] });
    const page = await new UnifiedAgentsService(deps).list({ tenantId, principalId: "viewer" }, { search: "Other", limit: 1 });
    expect(page.count).toBe(1);
    expect(page.summary.total).toBe(3);
    expect(page.inventoryOverview).toEqual({ availableToUsers: 2, organizationCreated: 1, teamsAvailable: 2, createdOrAvailable: 2 });
  });

  it("matches repository availability counts to filtered lists, pagination and exports across hosts", async () => {
    const service = new UnifiedAgentsService(dependencies({ packages: [
      { ...packageValue("available-a", "A"), availableTo: "all", supportedHosts: ["Teams"] },
      { ...packageValue("available-b", "B"), availableTo: "some", supportedHosts: ["Copilot"] },
      { ...packageValue("vendor", "Vendor"), type: "external", availableTo: "none" },
      { ...packageValue("created-blocked", "Created"), type: "custom", availableTo: "all" },
      { ...packageValue("unknown", "Unknown"), type: "microsoft", deployedTo: "all" },
    ] }));
    const scope = { tenantId, principalId: "viewer" };
    const page = await service.list(scope, { view: "available", offset: 1, limit: 1 });
    expect(page).toMatchObject({
      count: 2, summary: { total: 5 }, filteredSummary: { total: 2 }, inventoryOverview: { availableToUsers: 2 },
    });
    expect(page.value.map(value => value.packages[0].id)).toEqual(["available-b"]);
    const unavailable = await service.list(scope, { view: "unavailable" });
    expect(unavailable.value.map(value => value.packages[0].id)).toEqual(["created-blocked", "vendor"]);
    expect((await service.list(scope, { view: "availability_unknown" })).value.map(value => value.packages[0].id)).toEqual(["unknown"]);
    const exported = await service.forExport(scope, page.revision!, { view: "available" });
    expect(exported.value.map(value => value.packages[0].id)).toEqual(["available-a", "available-b"]);
    const rows = parseCsv(buildUnifiedAgentCsv(exported, Date.now() + 15_000).buffer, { bom: true, columns: true }) as Array<Record<string, string>>;
    expect(rows.map(row => row.availability)).toEqual(["All users", "Specific users or groups"]);
  });

  it("projects usage once across canonical records before organization filtering, numeric sorting, paging and export", async () => {
    const scope = { tenantId, principalId: "viewer" };
    const deps = dependencies({ packages: ["low", "high", "zero", "unknown"].map(id => ({
      ...packageValue(id, id), type: "external",
    })) });
    const counts = new Map([["low", 2], ["high", 10], ["zero", 0]]);
    deps.usage.project = vi.fn(async (_scope, records) => ({
      context: usageContext,
      summaries: new Map(records.map(record => {
        const responses = counts.get(record.packages[0].id) ?? null;
        return [record.id, {
          status: responses === null ? "unlinked" : "linked", reportSetId: "report-set",
          responses, activeUsers: responses === 2 ? 10 : responses === 10 ? 2 : responses,
          lastActivityDateUtc: null, associations: [],
        } satisfies AgentUsageSummary];
      })),
    }));
    const service = new UnifiedAgentsService(deps);
    const used = await service.list(scope, { view: "used", sortBy: "responses", sortDirection: "asc", offset: 1, limit: 1 });
    expect(used).toMatchObject({ count: 2, summary: { total: 4 }, filteredSummary: { total: 2 }, usageContext });
    expect(used.value.map(record => record.packages[0].id)).toEqual(["high"]);
    expect(deps.usage.project).toHaveBeenCalledTimes(1);
    expect(vi.mocked(deps.usage.project).mock.calls[0][1]).toHaveLength(4);
    expect((await service.list(scope, { sortBy: "responses", sortDirection: "desc" })).value.map(record => record.usage?.responses))
      .toEqual([10, 2, 0, null]);
    expect((await service.list(scope, { sortBy: "responses", sortDirection: "asc" })).value.map(record => record.usage?.responses))
      .toEqual([0, 2, 10, null]);
    expect((await service.list(scope, { sortBy: "activeUsers", sortDirection: "desc", limit: 1 })).value[0].packages[0].id).toBe("low");
    expect((await service.list(scope, { view: "organization" })).count).toBe(2);
    expect((await service.list(scope, { view: "unknown" })).count).toBe(2);
    const exported = await service.forExport(scope, inventoryRevision, { view: "used", sortBy: "responses", sortDirection: "desc" });
    expect(exported.value.map(record => record.usage?.responses)).toEqual([10, 2]);
  });

  it("uses one locked client for usage projection and the final composite export-revision check", async () => {
    const scope = { tenantId, principalId: "viewer" };
    const client = Object.assign(new pg.Client(), { release: vi.fn() });
    const deps = dependencies({ packages: [packageValue("one", "One")] });
    deps.registry = {
      withSnapshot: (_scope, work) => work(client),
      reconcile: async (_client, _scope, records) => [...records],
    };
    const service = new UnifiedAgentsService(deps);
    const page = await service.list(scope);
    expect(page.revision).toBe(inventoryRevision);
    expect(deps.usage.project).toHaveBeenCalledWith(scope, expect.any(Array), client);
    await service.assertRevision(scope, inventoryRevision);
    expect(deps.usage.revision).toHaveBeenCalledWith(scope, client);
    expect(vi.mocked(deps.readRevision).mock.calls.every(([owner, database]) => owner === scope && database === client)).toBe(true);
    deps.usage.revision = vi.fn(async () => "d".repeat(64));
    await expect(service.assertRevision(scope, inventoryRevision)).rejects.toMatchObject({ code: "inventory_changed" });
  });

  it("propagates usage storage failures and rejects incomplete projections instead of fabricating unused agents", async () => {
    const deps = dependencies({ packages: [packageValue("one", "One")] });
    const service = new UnifiedAgentsService(deps);
    deps.usage.project = vi.fn(async () => { throw new Error("usage database unavailable"); });
    await expect(service.list({ tenantId, principalId: "viewer" })).rejects.toThrow("usage database unavailable");
    deps.usage.project = vi.fn(async () => ({ context: usageContext, summaries: new Map() }));
    await expect(service.list({ tenantId, principalId: "viewer" })).rejects.toMatchObject({ code: "agent_usage_projection_incomplete" });
  });

  it("filters organization agents before counts, pagination and export without treating availability as deployment", async () => {
    const packages = [
      { ...packageValue("catalog", "A catalog-only"), type: "external", availableTo: "all", deployedTo: "none" },
      { ...packageValue("microsoft", "B Microsoft"), type: "microsoft" },
      { ...packageValue("shared", "C User shared"), type: "shared" },
      { ...packageValue("custom", "D Organization"), type: "custom" },
      { ...packageValue("deployed", "E Vendor deployed"), type: "external", deployedTo: "deployedToSome" },
    ];
    const service = new UnifiedAgentsService(dependencies({ packages, resources: [resource(environmentA)] }));
    const scope = { tenantId, principalId: "viewer" };
    const page = await service.list(scope, { view: "organization", limit: 2, offset: 2 });
    expect(page.summary.total).toBe(6);
    expect(page.count).toBe(5);
    expect(page.value.map(value => value.displayName)).toEqual(["D Organization", "E Vendor deployed"]);
    const exported = await service.forExport(scope, inventoryRevision, { view: "organization" });
    expect(exported.value).toHaveLength(5);
    expect(exported.value.some(value => value.packages.some(item => item.id === "catalog"))).toBe(false);
    expect((await service.list(scope, { view: "used" })).count).toBe(0);
    expect((await service.list(scope, { view: "unknown" })).value[0].packages[0].id).toBe("catalog");
  });

  it("sorts newly exposed columns across all rows and orders environments by their displayed names", async () => {
    const packages = [
      { ...packageValue("a", "A"), supportedHosts: ["Teams"] },
      { ...packageValue("b", "B"), supportedHosts: ["Copilot"] },
      packageValue("c", "C"),
    ];
    const service = new UnifiedAgentsService(dependencies({
      packages, resources: [resource(environmentA), resource(environmentB)],
      environmentNames: { [environmentA]: "Zebra", [environmentB]: "Alpha" },
    }));
    const scope = { tenantId, principalId: "viewer" };
    const page = await service.list(scope, { sortBy: "hosts", limit: 1 });
    expect(page.value[0].packages[0].id).toBe("b");
    expect((await service.list(scope, { sortBy: "environment", limit: 1 })).value[0].environmentId).toBe(environmentB);
    expect((await service.list(scope, { sortBy: "hosts", sortDirection: "desc", limit: 1 })).value[0].packages[0].id).toBe("a");
  });

  it.each(["asc", "desc"] as const)("keeps displayed environment labels consistent with %s sorting, paging and CSV", async sortDirection => {
    const mixedCaseEnvironment = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA";
    const service = new UnifiedAgentsService(dependencies({
      packages: [packageValue("unscoped", "Unscoped")],
      resources: [
        resource(environmentA, "zebra"),
        resource(mixedCaseEnvironment, "alpha"),
        resource(environmentB, "unlabelled"),
        resource(mixedCaseEnvironment, "alpha-tie"),
      ],
      environmentNames: { [environmentA]: "Zebra", [mixedCaseEnvironment.toLowerCase()]: "Alpha" },
    }));
    const scope = { tenantId, principalId: "viewer" };
    const query = { sortBy: "environment" as const, sortDirection };
    const expected = sortDirection === "asc"
      ? ["unlabelled", "alpha", "alpha-tie", "zebra", "unscoped"]
      : ["zebra", "alpha-tie", "alpha", "unlabelled", "unscoped"];
    const page = await service.list(scope, { ...query, limit: 1, offset: 2 });
    expect(page.count).toBe(5);
    expect(page.value[0].powerPlatformResource?.nativeId).toBe(expected[2]);
    expect(page.facets.environments).toEqual([
      { value: environmentB, label: environmentB },
      { value: mixedCaseEnvironment, label: "Alpha" },
      { value: environmentA, label: "Zebra" },
    ]);
    const environmentNames = Object.fromEntries(page.facets.environments.map(item => [item.value.toLowerCase(), item.label]));
    const exported = await service.forExport(scope, inventoryRevision, query);
    expect(exported.value.map(item => item.powerPlatformResource?.nativeId ?? item.packages[0].id)).toEqual(expected);
    const displayed = exported.value.map(item => agentColumnValue(item, "environment", environmentNames));
    expect(displayed).toEqual(sortDirection === "asc"
      ? [environmentB, "Alpha", "Alpha", "Zebra", null]
      : ["Zebra", "Alpha", "Alpha", environmentB, null]);
    const rows = parseCsv(buildUnifiedAgentCsv(exported, Date.now() + 15_000).buffer, { bom: true, columns: true }) as Array<Record<string, string>>;
    expect(rows.map(row => row.environmentName)).toEqual(displayed.map(value => value ?? ""));
  });

  it.each(["asc", "desc"] as const)("keeps reported-empty channels distinct from missing data in %s display, sort and CSV", async sortDirection => {
    const service = new UnifiedAgentsService(dependencies({ resources: [
      resource(environmentB, "missing"),
      { ...resource(environmentB, "configured"), details: { channels: ["Teams"] } },
      { ...resource(environmentB, "empty"), details: { channels: [] } },
      { ...resource(environmentB, "blank"), details: { channels: ["", " "] } },
    ] }));
    const scope = { tenantId, principalId: "viewer" };
    const query = { sortBy: "channels" as const, sortDirection };
    const expected = sortDirection === "asc" ? ["empty", "configured", "blank", "missing"] : ["configured", "empty", "missing", "blank"];
    const page = await service.list(scope, { ...query, limit: 1 });
    expect(page.count).toBe(4);
    expect(page.value[0].powerPlatformResource?.nativeId).toBe(expected[0]);
    const exported = await service.forExport(scope, inventoryRevision, query);
    expect(exported.value.map(item => item.powerPlatformResource?.nativeId)).toEqual(expected);
    const displayed = exported.value.map(item => agentColumnValue(item, "channels"));
    expect(displayed).toEqual(sortDirection === "asc" ? ["None reported", "Teams", null, null] : ["Teams", "None reported", null, null]);
    const rows = parseCsv(buildUnifiedAgentCsv(exported, Date.now() + 15_000).buffer, { bom: true, columns: true }) as Array<Record<string, string>>;
    expect(rows.map(row => row.channels)).toEqual(displayed.map(value => value ?? ""));
  });

  it.each((["origin", "versions"] as const).flatMap(sortBy =>
    (["asc", "desc"] as const).map(sortDirection => ({ sortBy, sortDirection })),
  ))("sorts entirely unknown $sortBy last in $sortDirection pages and CSV without changing its displayed meaning", async query => {
    const service = new UnifiedAgentsService(dependencies({ packages: [
      packageValue("unknown", "Unknown"),
      { ...packageValue("known-a", "Known A"), type: "custom", version: "2" },
      { ...packageValue("known-b", "Known B"), type: "microsoft", version: "10" },
    ] }));
    const scope = { tenantId, principalId: "viewer" };
    const known = query.sortBy === "origin" ? ["known-b", "known-a"] : ["known-a", "known-b"];
    if (query.sortDirection === "desc") known.reverse();
    const page = await service.list(scope, { ...query, limit: 1, offset: 1 });
    expect(page.count).toBe(3);
    expect(page.value[0].packages[0].id).toBe(known[1]);
    const exported = await service.forExport(scope, inventoryRevision, query);
    expect(exported.value.map(item => item.packages[0].id)).toEqual([...known, "unknown"]);
    expect(agentColumnValue(exported.value[2], query.sortBy)).toBeNull();
    const rows = parseCsv(buildUnifiedAgentCsv(exported, Date.now() + 15_000).buffer, { bom: true, columns: true }) as Array<Record<string, string>>;
    expect(rows.map(row => row[query.sortBy])).toEqual(exported.value.map(item => agentColumnValue(item, query.sortBy) ?? ""));
  });

  it.each(["asc", "desc"] as const)("sorts entirely unknown native control status last in %s order without hiding its status labels", async sortDirection => {
    const service = new UnifiedAgentsService(dependencies({ resources: [
      { ...resource(environmentB, "unknown"), lifecycle: "unknown" },
      { ...resource(environmentB, "draft"), lifecycle: "draft" },
      resource(environmentB, "published"),
      { ...resource(environmentB, "quarantine-only"), lifecycle: "unknown", details: { isQuarantined: false } },
    ] }));
    const scope = { tenantId, principalId: "viewer" };
    const query = { sortBy: "status" as const, sortDirection };
    const expected = sortDirection === "asc"
      ? ["draft", "quarantine-only", "published", "unknown"]
      : ["published", "quarantine-only", "draft", "unknown"];
    const page = await service.list(scope, { ...query, limit: 1, offset: 1 });
    expect(page.count).toBe(4);
    expect(page.value[0].powerPlatformResource?.nativeId).toBe(expected[1]);
    const exported = await service.forExport(scope, inventoryRevision, query);
    expect(exported.value.map(item => item.powerPlatformResource?.nativeId)).toEqual(expected);
    expect(agentColumnValue(exported.value[3], "status")).toBeNull();
    expect(agentStatusLabels(exported.value[3])).toEqual(["Publication status unknown", "Quarantine status unknown"]);
  });

  it("uses the same saved authoring fallbacks for full-inventory sorting, display values and export", async () => {
    const service = new UnifiedAgentsService(dependencies({ packages: [
      { ...packageValue("a-platform", "Platform"), authoringTool: null, platform: "CopilotStudio" },
      { ...packageValue("b-hint", "Hint"), authoringTool: null, shortDescription: "Built using Agent Builder." },
      { ...packageValue("c-known", "Known"), authoringTool: "Zebra SDK" },
      { ...packageValue("z-unknown", "Unknown"), authoringTool: null },
    ] }));
    const scope = { tenantId, principalId: "viewer" };
    const query = { sortBy: "builtWith" as const };
    const page = await service.list(scope, { ...query, limit: 1 });
    expect(page.count).toBe(4);
    expect(page.value[0].packages[0].id).toBe("b-hint");
    const exported = await service.forExport(scope, inventoryRevision, query);
    expect(exported.value.map(value => value.packages[0].id)).toEqual(["b-hint", "a-platform", "c-known", "z-unknown"]);
    const rows = parseCsv(buildUnifiedAgentCsv(exported, Date.now() + 15_000).buffer, { bom: true, columns: true }) as Array<Record<string, string>>;
    expect(rows.map(row => row.builtWith)).toEqual(["Agent Builder", "Copilot Studio", "Zebra SDK", ""]);
    expect((await service.list(scope, { view: "organization" })).count).toBe(0);
  });

  it("projects only reconciled canonical IDs after both private source reads and membership verification", async () => {
    const scope = { tenantId, principalId: "viewer" };
    const client = Object.assign(new pg.Client(), { release: vi.fn() });
    const deps = dependencies({ packages: [packageValue("linked", "Linked", true)], resources: [resource(environmentA)] });
    const canonicalId = "agent:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    deps.registry = {
      withSnapshot: (_scope, work) => work(client),
      reconcile: vi.fn(async (_client, _scope, records) => records.map(record => ({ ...record, id: canonicalId }))),
    };
    deps.usage.project = vi.fn(async (owner, records, database) => {
      expect(owner).toEqual(scope);
      expect(database).toBe(client);
      expect(deps.packages.readUnifiedSource).toHaveBeenCalledWith(scope, client);
      expect(deps.powerPlatform.readUnifiedSource).toHaveBeenCalledWith(scope, client);
      expect(deps.registry!.reconcile).toHaveBeenCalledOnce();
      expect(records.map(record => record.id)).toEqual([canonicalId]);
      expect(records[0].packages.map(item => item.id)).toEqual(["linked"]);
      return {
        context: usageContext,
        summaries: new Map([[canonicalId, {
          status: "linked", reportSetId: "report", responses: 2, activeUsers: 1, lastActivityDateUtc: null, associations: [],
        } satisfies AgentUsageSummary]]),
      };
    });
    const page = await new UnifiedAgentsService(deps).list(scope, { view: "used", recordId: canonicalId, sortBy: "responses", limit: 1 });
    expect(page).toMatchObject({ count: 1, value: [{ id: canonicalId, usage: { responses: 2 } }] });
  });

  it("exports every matching logical row rather than just the visible page", async () => {
    const packages = Array.from({ length: 301 }, (_, index) => packageValue(`package-${index}`, `Package ${index}`));
    const service = new UnifiedAgentsService(dependencies({ packages, powerPlatformSnapshot: null }));
    const scope = { tenantId, principalId: "viewer" };
    expect((await service.list(scope, { limit: 10 })).value).toHaveLength(10);
    const exported = await service.forExport(scope, inventoryRevision);
    expect(exported.value).toHaveLength(301);
    expect(exported.count).toBe(301);
    expect(exported.revision).toBe(inventoryRevision);
  });

  it("exports grouped capabilities with the unified environment filter and formula-safe labels", async () => {
    const packages = [
      { ...packageValue("linked-a", "Package", true), version: "1.0" },
      { ...packageValue("linked-b-blocked", "Package", true), version: "2.0" },
      packageValue("unrelated", "Other"),
    ];
    const service = new UnifiedAgentsService(dependencies({
      packages, resources: [{ ...resource(environmentA), displayName: "=formula" }, resource(environmentB)],
      environmentNames: { [environmentA]: "Production environment" },
    }));
    const inventory = await service.forExport({ tenantId, principalId: "viewer" }, inventoryRevision, { environmentId: environmentA });
    expect(inventory.count).toBe(1);
    const csv = buildUnifiedAgentCsv(inventory, Date.now() + 15_000);
    expect(csv.rowCount).toBe(1);
    const rows = parseCsv(csv.buffer, { bom: true, columns: true }) as Array<Record<string, string>>;
    expect(rows[0]).toMatchObject({
      displayName: "'=formula", environmentId: environmentA, environmentName: "Production environment", nativeResourceId: "shared-native",
    });
    expect(JSON.parse(rows[0].packageIds)).toEqual(["linked-a", "linked-b-blocked"]);
    expect(JSON.parse(rows[0].packageStates)).toMatchObject([
      { packageId: "linked-a", version: "1.0", isBlocked: false }, { packageId: "linked-b-blocked", version: "2.0", isBlocked: true },
    ]);
    expect(csv.buffer.toString("utf8")).not.toContain("secret-principal");
    expect(csv.buffer.toString("utf8")).not.toContain("Provider metadata");
  });

  it("deduplicates exact aliases into one export row and rejects absent selections or changed revisions", async () => {
    const deps = dependencies({
      packages: [packageValue("linked-a", "Package", true), packageValue("linked-b", "Package", true)],
      resources: [resource(environmentA)],
    });
    const service = new UnifiedAgentsService(deps);
    const scope = { tenantId, principalId: "viewer" };
    const selected = await service.forExport(scope, inventoryRevision, {}, [
      "graph_packages:linked-a", "graph_packages:linked-b",
      unifiedAgentRecordId({ source: "power_platform", environmentId: environmentA.toUpperCase(), nativeId: "shared-native" }),
    ]);
    expect(selected.count).toBe(1);
    expect(selected.value[0].packages).toHaveLength(2);
    await expect(service.forExport(scope, inventoryRevision, {}, ["graph_packages:absent"])).rejects.toMatchObject({ code: "export_selection_changed" });
    await expect(service.forExport(scope, "b".repeat(64))).rejects.toMatchObject({ code: "inventory_changed" });
    await service.assertRevision(scope, inventoryRevision);
    deps.readRevision = vi.fn(async () => "b".repeat(64));
    await expect(service.assertRevision(scope, inventoryRevision)).rejects.toMatchObject({ code: "inventory_changed" });
  });

  it("exports selectable metadata and period-scoped usage without converting unknown counts to zero", async () => {
    const inventory = await new UnifiedAgentsService(dependencies({ packages: [
      { ...packageValue("a", "A"), type: "custom", supportedHosts: ["Teams"], publisher: "=untrusted", version: "2.1", createdDateTime: "2026-09-01T00:00:00Z" },
      packageValue("b", "B"),
    ] })).list({ tenantId, principalId: "viewer" });
    const reportSetId = "33333333-3333-4333-8333-333333333333";
    inventory.usageContext = {
      availability: "stale", revision: "c".repeat(64), lineages: [],
      reportSet: {
        id: reportSetId, bundleId: "44444444-4444-4444-8444-444444444444", complete: true, kinds: ["agents", "users", "userAgents"],
        reportingPeriod: { startDate: "2026-09-01", endDate: "2026-09-15", provenance: "activity_range" },
        supersedesSetId: null, acceptedAt: "2026-09-15T12:00:00Z", deletedAt: null, createdAt: "2026-09-15T12:00:00Z", expiresAt: null,
      },
    };
    inventory.value[0].usage = {
      status: "linked", reportSetId, responses: 0, activeUsers: 0, lastActivityDateUtc: null,
      associations: [{
        reportAgentId: "report/a", reportAgentName: "=reported name", target: { source: "graph_packages", packageId: "a" },
        basis: "admin_reviewed", reviewedAt: "2026-09-15T12:00:00Z",
      }],
    };
    inventory.value[1].usage = { status: "unlinked", reportSetId, responses: null, activeUsers: null, lastActivityDateUtc: null, associations: [] };
    const csv = buildUnifiedAgentCsv(inventory, Date.now() + 15_000);
    const rows = parseCsv(csv.buffer, { bom: true, columns: true }) as Array<Record<string, string>>;
    expect(rows[0]).toMatchObject({
      hosts: "Teams", publisher: "'=untrusted", versions: "2.1", createdAt: "2026-09-01T00:00:00.000Z",
      usageStatus: "linked", responses: "0", activeUsers: "0", lastActivityDateUtc: "", usageReportSetId: reportSetId,
      usageAvailability: "stale", usageReportPeriodProvenance: "activity_range", usageReportPeriodStart: "2026-09-01",
      usageReportPeriodEnd: "2026-09-15", usageRevision: "c".repeat(64),
    });
    expect(JSON.parse(rows[0].usageAssociations)).toMatchObject([{ basis: "admin_reviewed", target: { source: "graph_packages", packageId: "a" } }]);
    expect(rows[1]).toMatchObject({ usageStatus: "unlinked", responses: "", activeUsers: "", lastActivityDateUtc: "", usageAssociations: "[]" });
    expect(JSON.parse(rows[1].packageStates)).toMatchObject([{ packageId: "b", version: null }]);
  });

  it("rejects row and byte limit overflow instead of exporting a successful partial inventory", async () => {
    const resources = Array.from({ length: 2_001 }, (_, index) => ({
      ...resource(environmentA, `native-${index}`),
      identifiers: [{ kind: "power_platform_resource_id" as const, value: `native-${index}` }],
    }));
    const service = new UnifiedAgentsService(dependencies({
      packages: Array.from({ length: 3_000 }, (_, index) => packageValue(`package-${index}`, "Package")), resources,
    }));
    await expect(service.forExport({ tenantId, principalId: "viewer" }, inventoryRevision)).rejects.toMatchObject({ code: "export_row_limit" });
    const large = await new UnifiedAgentsService(dependencies({
      packages: [{ ...packageValue("large", "Large"), publisher: "x".repeat(8_000_001) }],
    })).list({ tenantId, principalId: "viewer" });
    expect(() => buildUnifiedAgentCsv(large, Date.now() + 15_000)).toThrowError(expect.objectContaining({ code: "export_byte_limit" }));
  });

  it("never stamps expiring observations with the revision of a later source set", async () => {
    const deps = dependencies({ packages: [packageValue("old-observation", "Old observation")] });
    deps.readRevision = vi.fn().mockResolvedValueOnce("a".repeat(64)).mockResolvedValue("b".repeat(64));
    await expect(new UnifiedAgentsService(deps).list({ tenantId, principalId: "viewer" })).rejects.toMatchObject({ code: "inventory_changed" });
  });

  it("does not export absent inventory as a successful empty collection", async () => {
    const service = new UnifiedAgentsService(dependencies({ packageSnapshot: false, powerPlatformSnapshot: null }));
    await expect(service.forExport({ tenantId, principalId: "viewer" }, inventoryRevision)).rejects.toMatchObject({ code: "snapshot_unavailable" });
  });

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

  it("keeps schema-conflicting package representations separate before counts and pagination", async () => {
    const packages = ["cr123_agent", "cr123_other"].map((SchemaName, index) => ({
      ...packageValue(`package-${index}`, "Same displayed name"),
      elementDetails: [{
        elementType: "AgentMetadatas",
        elements: [{ id: "metadata", definition: JSON.stringify({
          SourceIds: { EnvironmentId: environmentA, CdsBotId: botA, SchemaName },
        }) }],
      }],
    }));
    const service = new UnifiedAgentsService(dependencies({ packages, resources: [resource(environmentA)] }));
    const full = await service.list({ tenantId, principalId: "viewer" });
    expect(full).toMatchObject({
      count: 3,
      summary: { total: 3, linked: 0, graphOnly: 2, powerPlatformOnly: 1, conflicting: 2 },
    });
    expect(full.value.filter(value => value.presence === "graph_packages").map(value => value.identity.state))
      .toEqual(["conflicting", "conflicting"]);
    const paged = await service.list({ tenantId, principalId: "viewer" }, { limit: 1, offset: 1 });
    expect(paged.count).toBe(3);
    expect(paged.summary).toEqual(full.summary);
    expect(paged.value).toHaveLength(1);
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

  it.each([
    { authoringTool: "MicrosoftCopilotStudio" },
    { authoringTool: null, platform: "Microsoft Copilot Studio" },
    { authoringTool: null, shortDescription: "Built using Microsoft Copilot Studio." },
  ])("round-trips canonical authoring facets for %j", async fields => {
    const service = new UnifiedAgentsService(dependencies({
      packages: [{ ...packageValue("studio", "Studio package"), ...fields }],
      resources: [resource(environmentA)],
    }));
    const scope = { tenantId, principalId: "viewer" };
    const unfiltered = await service.list(scope);
    expect(unfiltered.facets.platforms).toEqual([{ value: "Copilot Studio", label: "Copilot Studio" }]);
    for (const platform of ["Copilot Studio", "MicrosoftCopilotStudio"]) {
      const filtered = await service.list(scope, { platform });
      expect(filtered.count).toBe(2);
      expect(filtered.value.map(value => value.id)).toEqual(unfiltered.value.map(value => value.id));
    }
  });

  it.each([
    ["UTC offsets", "2026-09-16T01:00:00+04:00", "2026-09-15T22:00:00.000Z"],
    ["fractional seconds", "2026-09-15T22:00:00Z", "2026-09-15T22:00:00.500Z"],
  ])("sorts modification times chronologically across %s before paging", async (_case, older, newer) => {
    const service = new UnifiedAgentsService(dependencies({
      packages: [
        { ...packageValue("older", "Z"), lastModifiedDateTime: older },
        { ...packageValue("newer", "A"), lastModifiedDateTime: newer },
        packageValue("undated", "Undated"),
      ],
    }));
    const scope = { tenantId, principalId: "viewer" };
    for (const sortDirection of ["asc", "desc"] as const) {
      const expected = sortDirection === "asc" ? ["undated", "older", "newer"] : ["newer", "older", "undated"];
      const query = { sortBy: "lastModifiedAt" as const, sortDirection };
      const result = await service.list(scope, query);
      expect(result.value.map(value => value.packages[0].id)).toEqual(expected);
      const paged = await service.list(scope, { ...query, offset: 1, limit: 1 });
      expect(paged.count).toBe(3);
      expect(paged.value.map(value => value.packages[0].id)).toEqual(expected.slice(1, 2));
    }
  });

  it("uses exact record IDs to break ties between equivalent modification instants", async () => {
    const service = new UnifiedAgentsService(dependencies({
      packages: [
        { ...packageValue("b", "First name"), lastModifiedDateTime: "2026-09-15T22:00:00.000Z" },
        { ...packageValue("a", "Last name"), lastModifiedDateTime: "2026-09-16T02:00:00+04:00" },
      ],
    }));
    for (const sortDirection of ["asc", "desc"] as const) {
      const result = await service.list({ tenantId, principalId: "viewer" }, { sortBy: "lastModifiedAt", sortDirection });
      expect(result.value.map(value => value.packages[0].id)).toEqual(sortDirection === "asc" ? ["a", "b"] : ["b", "a"]);
    }
  });

  it("sorts grouped rows using the latest instant across both saved sources", async () => {
    const service = new UnifiedAgentsService(dependencies({
      packages: [
        { ...packageValue("linked-old", "Linked older package", true), lastModifiedDateTime: "2026-09-16T01:00:00+04:00" },
        { ...packageValue("linked-older", "Linked oldest package", true), lastModifiedDateTime: "2026-09-15T20:00:00Z" },
        { ...packageValue("graph-newer", "Newer standalone package"), lastModifiedDateTime: "2026-09-15T23:00:00Z" },
      ],
      resources: [
        { ...resource(environmentA), lastPublishedAt: "2026-09-15T22:00:00.000Z" },
        { ...resource(environmentB), createdAt: "2026-09-15T21:30:00.000Z" },
      ],
    }));
    const result = await service.list({ tenantId, principalId: "viewer" }, { sortBy: "lastModifiedAt", sortDirection: "desc" });
    expect(result.value.map(value => value.presence)).toEqual(["graph_packages", "both", "power_platform"]);
    expect(result.value[1].packages).toHaveLength(2);
  });

  it("keeps undated modification ties deterministic without changing name sorting", async () => {
    const service = new UnifiedAgentsService(dependencies({
      packages: [packageValue("a", "Z"), packageValue("b", "A")],
    }));
    const scope = { tenantId, principalId: "viewer" };
    expect((await service.list(scope)).value.map(value => value.packages[0].id)).toEqual(["b", "a"]);
    for (const sortDirection of ["asc", "desc"] as const) {
      const result = await service.list(scope, { sortBy: "lastModifiedAt", sortDirection });
      expect(result.value.map(value => value.packages[0].id)).toEqual(sortDirection === "asc" ? ["a", "b"] : ["b", "a"]);
    }
  });

  it("surfaces invalid saved modification timestamps instead of treating them as a sort tie", async () => {
    const service = new UnifiedAgentsService(dependencies({
      packages: [
        { ...packageValue("invalid", "Invalid date"), lastModifiedDateTime: "invalid-date" },
        { ...packageValue("valid", "Valid date"), lastModifiedDateTime: "2026-09-15T22:00:00.000Z" },
      ],
    }));
    await expect(service.list({ tenantId, principalId: "viewer" }, { sortBy: "lastModifiedAt" }))
      .rejects.toMatchObject({ code: "saved_source_invalid" });
  });

  it.each(["exact", "retained"] as const)("uses %s detail evidence consistently for collection counts and missing-metadata explanations", async evidence => {
    const pkg = packageValue("legacy-detail", "Legacy collected package");
    if (evidence === "retained") pkg.elementDetails = [{
      elementType: "DeclarativeAgents", elements: [{ id: "declarative", definition: "{}" }],
    }];
    const scope = { tenantId, principalId: "viewer" };
    const deps = dependencies({ packages: [pkg] });
    const source = await deps.packages.readUnifiedSource(scope);
    const observation = source.observations[pkg.id];
    if (evidence === "exact") observation.scopeKind = "exact";
    else observation.identityDetails = {
      snapshotId: observation.snapshotId,
      observedAt: observation.observedAt,
      expiresAt: observation.expiresAt,
    };
    deps.packages.readUnifiedSource = vi.fn(async () => source);

    const result = await new UnifiedAgentsService(deps).list(scope);
    expect(result.identityCollection).toEqual({ checkedPackages: 1, pendingPackages: 0 });
    expect(result.value[0].identity.reason).toContain("Package details were collected");
    expect(result.value[0].identity.reason).not.toContain("Refresh package details");
    expect(pkg.identityDetailsCollected).toBeUndefined();
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
    expect(partial.errors[0].message).toContain("does not contain verified Copilot Studio agent collection evidence");
    expect(partial.errors[0].message).not.toContain("wids");
    expect(partial.count).toBe(2);
  });

  it.each(["full", "ai", "unknown"] as const)("accepts verified agent query evidence for %s role hints without requiring every resource type", async roleScope => {
    const result = await new UnifiedAgentsService(dependencies({
      resources: [resource(environmentA)],
      powerPlatformSnapshot: { ...powerPlatformSnapshot(), roleScope },
    })).list({ tenantId, principalId: "viewer" });
    expect(result.partial).toBe(false);
    expect(result.sources.powerPlatform).toMatchObject({ state: "available", error: null });
    expect(result.verification).toMatchObject({
      status: "verified", representedSourceCount: 1, uniqueSourceCount: 1, logicalAgentCount: 1,
    });
    expect(result.count).toBe(1);
  });

  it("keeps an environment-only snapshot partial even with proven type coverage", async () => {
    const result = await new UnifiedAgentsService(dependencies({
      resources: [resource(environmentA)],
      powerPlatformSnapshot: { ...powerPlatformSnapshot(), environmentScope: environmentA },
    })).list({ tenantId, principalId: "viewer" });
    expect(result.partial).toBe(true);
    expect(result.errors[0].code).toBe("environment_scope_limited");
    expect(result.errors[0].message).toContain("restricted to one environment");
    expect(result.errors[0].message).not.toContain("wids");
    expect(result.count).toBe(1);
  });

  it("reports environment restriction and missing query evidence independently of role hints", async () => {
    const result = await new UnifiedAgentsService(dependencies({
      resources: [resource(environmentA)],
      powerPlatformSnapshot: { ...powerPlatformSnapshot("unknown"), environmentScope: environmentA },
    })).list({ tenantId, principalId: "viewer" });
    expect(result.partial).toBe(true);
    expect(result.errors[0].message).toContain("restricted to one environment");
    expect(result.errors[0].message).toContain("does not contain verified Copilot Studio agent collection evidence");
    expect(result.verification.status).toBe("needs_attention");
  });

  it("does not misdiagnose unknown type coverage as missing role evidence when the role is known", async () => {
    const result = await new UnifiedAgentsService(dependencies({
      resources: [resource(environmentA)],
      powerPlatformSnapshot: { ...powerPlatformSnapshot("unknown"), roleScope: "full" },
    })).list({ tenantId, principalId: "viewer" });
    expect(result.partial).toBe(true);
    expect(result.errors[0].message).toContain("does not contain verified Copilot Studio agent collection evidence");
    expect(result.errors[0].message).not.toContain("wids");
  });

  it("verifies every source target before filtering and flags pending identity metadata separately", async () => {
    const packages = [packageValue("linked-a", "Package", true), packageValue("linked-b", "Package", true), packageValue("other", "Other")];
    const result = await new UnifiedAgentsService(dependencies({
      packages, resources: [resource(environmentA), resource(environmentB)],
    })).list({ tenantId, principalId: "viewer" }, { environmentId: environmentA, limit: 1 });
    expect(result).toMatchObject({
      count: 1, partial: false,
      verification: {
        status: "needs_attention", graphPackageCount: 3, powerPlatformAgentCount: 2,
        representedSourceCount: 5, uniqueSourceCount: 5, logicalAgentCount: 3,
        checks: { sourceScopes: true, sourceMemberships: true, packageMetadata: false, identityLinks: true },
      },
    });
    const csv = parseCsv(buildUnifiedAgentCsv(result, Date.now() + 15_000).buffer, { bom: true, columns: true });
    expect(csv[0]).toMatchObject({
      inventoryVerificationStatus: "needs_attention", inventorySourceCount: "5",
      inventoryUniqueSourceCount: "5", inventoryLogicalAgentCount: "3",
    });
  });

  it("rejects repeated source identities instead of reporting a successful reconciliation", async () => {
    const repeated = packageValue("repeated", "Agent");
    await expect(new UnifiedAgentsService(dependencies({ packages: [repeated, repeated] }))
      .list({ tenantId, principalId: "viewer" })).rejects.toMatchObject({ code: "saved_source_invalid" });
    await expect(new UnifiedAgentsService(dependencies({ resources: [resource(environmentA, botA), resource(environmentA.toUpperCase(), botA.toUpperCase())] }))
      .list({ tenantId, principalId: "viewer" })).rejects.toMatchObject({ code: "saved_source_invalid" });
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

  it.each([
    "all", "everyone", "allowedForAll", "availableToAll", "deployedToAll", "installedForAll",
    "some", "allowedForSome", "availableToSome", "deployedToSome", "installedForSome",
    " ALLOWED_FOR-ALL ", "AVAILABLE TO SOME",
  ])("matches the combined availability filter for %s", async availableTo => {
    const service = new UnifiedAgentsService(dependencies({
      packages: [{ ...packageValue("package", "Package"), availableTo }],
    }));
    const result = await service.list({ tenantId, principalId: "viewer" }, { availableTo: "__some_or_all__" });
    expect(result.count).toBe(1);
    expect(result.filteredSummary.total).toBe(1);
    expect(result.value[0].packages[0].availableTo).toBe(availableTo);
  });

  it.each([undefined, "", "none", "allowedForNoOne", "deployedToNone", "unknownFutureValue", "futureStatus"])(
    "excludes status %s from combined availability without changing exact filters", async availableTo => {
      const service = new UnifiedAgentsService(dependencies({
        packages: [{ ...packageValue("package", "Package"), availableTo }],
      }));
      const scope = { tenantId, principalId: "viewer" };
      expect((await service.list(scope, { availableTo: "__some_or_all__" })).count).toBe(0);
      expect((await service.list(scope, { availableTo: `available:${availableTo ?? "__unknown__"}` })).count).toBe(1);
    },
  );
});
