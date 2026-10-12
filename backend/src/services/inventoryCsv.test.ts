import { describe, expect, it, vi } from "vitest";
import type { UnifiedAgentInventoryPage, UnifiedAgentRecord } from "../types/unifiedAgents.js";
import { csvValue } from "./csvEncoding.js";
import { agentCapabilityExport, exportPackageElement } from "./agentContextExport.js";
import type { PowerPlatformResource } from "../types/powerPlatformInventory.js";
import { unifiedAgentExportColumns, unifiedAgentExportRows } from "./inventoryCsv.js";

function record(id: string, displayName = id): UnifiedAgentRecord {
  return {
    id: `graph_packages:${id}`, displayName, environmentId: null, presence: "graph_packages",
    packages: [{
      id, displayName, isBlocked: false, sourceSystem: "graph_packages", authoringTool: null,
      creatorType: "unknown", agentKind: "copilot_package", lifecycle: "unknown",
      identityConfidence: "exact_native", provenance: {},
    }],
    powerPlatformResource: null,
    identity: { state: "unmatched", evidence: [], packageEvidence: [], reason: null },
    observations: { graphPackages: null, packageSnapshots: {}, powerPlatform: null },
  };
}

function inventory(value = [record("first"), record("second")]): UnifiedAgentInventoryPage {
  const summary = {
    total: value.length, linked: 0, graphOnly: value.length, powerPlatformOnly: 0, ambiguous: 0, conflicting: 0,
  };
  return {
    value, selection: { id: "selected-inventory", revision: "a".repeat(64),
      evaluatedAt: "2026-09-15T00:00:00.000Z", expiresAt: "2026-09-22T00:00:00.000Z" },
    page: { limit: 100, nextCursor: null, previousCursor: null },
    counts: { total: value.length, scoped: value.length, filtered: value.length, packageTargets: value.length },
    freshness: { state: "idle", capturedRevision: "1", sources: [] },
    inventoryOverview: { availableToUsers: 0, organizationCreated: 0, teamsAvailable: 0, createdOrAvailable: 0 },
    usageContext: { revision: "1", expiresAt: "2026-09-22T00:00:00.000Z", reports: {
      setId: null, activeSetId: null, activeRevision: "0", historyRevision: "0", historyEpoch: "0",
      availability: "never_imported", staleAfterDays: 7, periodAgeDays: null, acceptedAgeDays: null,
      reportingPeriod: null, acceptedAt: null, expiresAt: null, lineages: [],
    } },
    summary, inventoryScope: "all", scopeSummary: summary, filteredSummary: summary,
    verification: {
      status: "needs_attention", scope: "authorized_saved_sources", checkedAt: "2026-09-15T00:00:00.000Z",
      graphPackageCount: value.length, powerPlatformAgentCount: 0, representedSourceCount: value.length,
      uniqueSourceCount: value.length, logicalAgentCount: value.length,
      checks: { sourceScopes: false, packageMetadata: false, identityLinks: true, sourceMemberships: true },
    },
    sources: {
      graphPackages: {
        state: "available", error: null,
        observation: {
          id: "snapshot", snapshotId: "snapshot", observedAt: "2026-09-15T00:00:00.000Z",
          expiresAt: "2026-09-22T00:00:00.000Z", current: true, tokenMode: "delegated", scopeKind: "broad",
          observedCount: value.length, totalRecords: value.length,
        },
      },
      powerPlatform: {
        state: "unavailable", observation: null,
        error: { source: "power_platform", code: "snapshot_unavailable", message: "No saved snapshot." },
      },
    },
    partial: true,
    errors: [{ source: "power_platform", code: "snapshot_unavailable", message: "No saved snapshot." }],
  };
}

describe("unified agent CSV projection", () => {
  it.each([" aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa ", "Opaque_ABC:/?😀"])(
    "does not export a saved directory identity for a non-GUID native reference %j", nativeId => {
      const value = record("native"), objectId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
      value.presence = "power_platform"; value.packages = [];
      value.powerPlatformResource = {
        tenantId: "tenant", nativeId: "native", type: "microsoft.copilotstudio/agents",
        environmentId: null, location: null, displayName: "Agent", createdAt: null, createdBy: objectId.toUpperCase(),
        lastPublishedAt: null, sourceSystem: "power_platform", authoringTool: null, creatorType: "unknown",
        agentKind: "agent", lifecycle: "unknown", identityConfidence: "exact_native", identifiers: [], provenance: {},
        details: { ownerId: nativeId }, unknownFieldCount: 0,
      };
      const person = { objectId: nativeId.startsWith(" ") ? objectId : nativeId.toLowerCase(),
        displayName: "Wrong owner", userPrincipalName: "wrong@example.invalid", observedAt: "2026-09-15T00:00:00Z" };
      value.people = { owner: person, createdBy: { ...person, objectId, displayName: "Exact creator" } };
      const row = [...unifiedAgentExportRows(inventory([value]))][0];
      expect(row.owner).toBe(nativeId);
      expect(row.ownerDisplayName).toBeUndefined();
      expect(JSON.parse(row.peopleEvidence).owner).toBeNull();
      expect(row.createdByDisplayName).toBe("Exact creator");
    },
  );

  it("exports unknown, explicit empty, zero and false distinctly and never exports connection credentials", () => {
    expect(agentCapabilityExport(null)).toMatchObject({ connectorDetailsStatus: "not_supplied", configuredConnectors: null });
    const resource = { details: {
      connectors: [], connectorDetailsStatus: "complete", distinctPowerPlatformConnectors: 0, distinctPowerPlatformConnectorsOperations: 0,
    }, provenance: {} } as unknown as PowerPlatformResource;
    expect(agentCapabilityExport(resource)).toMatchObject({
      connectorDetailsStatus: "complete", configuredConnectors: "[]", reportedConnectorTotal: 0, reportedOperationTotal: 0,
      savedConnectorDetails: 0, savedOperationDetails: 0,
    });
    resource.details.connectors = [{
      connectorId: "shared_test", operations: [{
        operationId: "read", isEnabled: false, requiresEndUserConsent: false,
        createdBy: "52bff06b-5db5-42cd-9919-28f95e3c07af", connectionProvider: "Maker",
        ...{ connectionIdSharedByMaker: "secret", callbackUrl: "https://private.invalid" },
      }],
    }];
    const exported = agentCapabilityExport(resource);
    expect(exported.configuredConnectors).toContain('"isEnabled":false');
    expect(exported.configuredConnectors).toContain('"requiresEndUserConsent":false');
    expect(JSON.stringify(exported)).not.toMatch(/secret|private.invalid/);
  });

  it.each(["before", "during"] as const)("does not project abandoned rows when its consumer stops %s iteration", phase => {
    const page = inventory();
    const firstName = vi.fn(() => "First");
    const secondName = vi.fn(() => "Second");
    page.value[0] = { ...page.value[0], get displayName() { return firstName(); } };
    page.value[1] = { ...page.value[1], get displayName() { return secondName(); } };
    const rows = unifiedAgentExportRows(page);
    if (phase === "during") expect(rows.next().value).toMatchObject({ displayName: "First" });
    rows.return(undefined);
    expect(rows.next().done).toBe(true);
    expect(firstName).toHaveBeenCalledTimes(phase === "before" ? 0 : 1);
    expect(secondName).not.toHaveBeenCalled();
  });

  it("preserves legal wide Unicode cells without truncating or reordering them", () => {
    const value = record("wide");
    value.packages[0].publisher = "界".repeat(60_000);
    const row = unifiedAgentExportRows(inventory([value])).next().value!;
    expect(row.publisher).toBe(value.packages[0].publisher);
    expect(Buffer.byteLength(csvValue(row.publisher))).toBe(180_002);
  });

  it("refuses a full-set input before reading any row beyond its 100-record page contract", () => {
    const excessName = vi.fn(() => "Excess");
    const page = inventory([
      ...Array.from({ length: 100 }, (_, index) => record(`package-${index}`)),
      { ...record("excess"), get displayName() { return excessName(); } },
    ]);
    expect(() => unifiedAgentExportRows(page).next()).toThrow("inventory_csv_page_limit");
    expect(excessName).not.toHaveBeenCalled();
  });

  it("preserves column and row ordering, formula defenses and package metadata for the durable encoder", () => {
    const page = inventory([record("first", "=First"), record("second", 'Second, "quoted"')]);
    const rows = [...unifiedAgentExportRows(page)];
    const [first, second] = rows.map(row => unifiedAgentExportColumns.map(column => csvValue(row[column])).join(","));
    expect(unifiedAgentExportColumns.join(",").startsWith("agentId,displayName,environmentId,environmentName,")).toBe(true);
    expect(first.startsWith('"graph_packages:first","\'=First",')).toBe(true);
    expect(second.startsWith('"graph_packages:second","Second, ""quoted""",')).toBe(true);
    expect(JSON.parse(rows[0].packageStates)).toEqual([expect.objectContaining({
      packageId: "first", version: null, isBlocked: false, availableTo: null, deployedTo: null,
      publisher: null, type: null, supportedHosts: null, snapshotId: null, observedAt: null,
      expiresAt: null, current: null, scopeKind: null, identityDetails: null, detailFreshness: null,
      controlObservations: null, provenance: {},
    })]);
    expect(first).toContain(csvValue(rows[0].packageStates));
    expect(rows).toHaveLength(2);
    expect(rows.every(row => row.inventoryRevision === page.selection.revision)).toBe(true);
  });

  it("retains a valid header for an empty saved selection", () => {
    expect([...unifiedAgentExportRows(inventory([]))]).toEqual([]);
    expect(unifiedAgentExportColumns.slice(0, 4)).toEqual(["agentId", "displayName", "environmentId", "environmentName"]);
  });

  it("distinguishes missing host evidence from a confirmed empty or supplied collection", () => {
    const missing = record("missing"), empty = record("empty"), supplied = record("supplied");
    empty.packages[0].supportedHosts = [];
    supplied.packages[0].supportedHosts = ["Teams"];
    const rows = [...unifiedAgentExportRows(inventory([missing, empty, supplied]))];
    expect(rows.map(row => JSON.parse(row.packageStates)[0].supportedHosts)).toEqual([null, [], ["Teams"]]);
  });

  it("retains confirmed empty connector facts after native collections have been split into child rows", () => {
    const resource = { details: { connectorDetailsStatus: "complete" }, provenance: {},
      connectorCounts: { connectors: 0, operations: 0 } } as PowerPlatformResource;
    expect(agentCapabilityExport(resource)).toMatchObject({
      configuredConnectors: "[]", savedConnectorDetails: 0, savedOperationDetails: 0,
    });
    resource.connectorCounts = { connectors: 1, operations: 0 };
    expect(agentCapabilityExport(resource).configuredConnectors).toBeNull();
    resource.connectorCounts = null;
    expect(agentCapabilityExport(resource).configuredConnectors).toBeNull();
  });

  it.each(["missing", "stale", "invalidated"] as const)("preserves %s per-package details independently of the catalog", state => {
    const value = record("package");
    const catalogAt = "2026-09-01T00:00:00.000Z", detailAt = state === "missing" ? null : "2026-09-02T00:00:00.000Z";
    value.packages[0].detailFreshness = { state, observedAt: detailAt, expiresAt: detailAt };
    value.observations.packageSnapshots.package = { id: "catalog", snapshotId: "catalog",
      observedAt: catalogAt, expiresAt: catalogAt, current: false, scopeKind: "broad",
      identityDetails: state === "stale" ? { id: "detail", snapshotId: "detail",
        observedAt: detailAt!, expiresAt: detailAt!, current: false } : null };
    const row = unifiedAgentExportRows(inventory([value])).next().value!;
    expect(JSON.parse(row.packageStates)[0]).toMatchObject({
      snapshotId: "catalog", observedAt: catalogAt, current: false,
      detailFreshness: value.packages[0].detailFreshness,
      identityDetails: value.observations.packageSnapshots.package.identityDetails,
    });
  });

  it("exports only typed element identities, with explicit omission or invalidity instead of raw definitions", () => {
    const botId = "52BFF06B-5DB5-42CD-9919-28F95E3C07AF";
    expect(exportPackageElement({ elementType: "Bots", id: "bot", definition: JSON.stringify({
      botId, password: "private-password", endpoint: "https://private.invalid",
    }) })).toEqual({ elementType: "Bots", id: "bot", definition: JSON.stringify({ botId }), definitionStatus: "identity_only" });
    expect(exportPackageElement({ elementType: "CustomEngineCopilots", id: "engine", definition: JSON.stringify({
      id: botId, type: "bot", connectionToken: "private-token",
    }) })).toEqual({ elementType: "CustomEngineCopilots", id: "engine",
      definition: JSON.stringify({ type: "bot", id: botId }), definitionStatus: "identity_only" });
    for (const definition of ['{"SourceIds":{"CdsBotId":{"token":"private-token"}}}', '{"AgentIdentityId":"https://private.invalid"}', "{"]) {
      expect(exportPackageElement({ elementType: "AgentMetadatas", id: "metadata", definition }))
        .toEqual({ elementType: "AgentMetadatas", id: "metadata", definition: null, definitionStatus: "invalid" });
    }
    expect(exportPackageElement({ elementType: "DeclarativeCopilots", id: "declarative", definition: '{"instructions":"private"}' }))
      .toEqual({ elementType: "DeclarativeCopilots", id: "declarative", definition: null, definitionStatus: "not_exported" });
    expect(exportPackageElement({ elementType: "CustomEngineCopilots", id: "conflict", definition: JSON.stringify({
      type: "bot", id: botId, botId: "11111111-1111-4111-8111-111111111111",
    }) })).toEqual({ elementType: "CustomEngineCopilots", id: "conflict", definition: null, definitionStatus: "invalid" });
  });

  it.each([
    { elementType: "AgentMetadatas", definition: '{"SourceIds":{"CdsBotId":"11111111-1111-4111-8111-111111111111","CdsBot\\u0049d":"22222222-2222-4222-8222-222222222222"}}' },
    { elementType: "Bots", definition: '{"botId":"11111111-1111-4111-8111-111111111111","botId":"22222222-2222-4222-8222-222222222222"}' },
    { elementType: "CustomEngineCopilots", definition: '{"type":"other","type":"bot","id":"22222222-2222-4222-8222-222222222222"}' },
  ])("does not export last-property-wins $elementType identity evidence", payload => {
    expect(exportPackageElement({ ...payload, id: "element" })).toEqual({
      elementType: payload.elementType, id: "element", definition: null, definitionStatus: "invalid",
    });
  });

  it("does not correlate or export a bot application inherited from an unrestricted JSON object's prototype", () => {
    const botId = "52bff06b-5db5-42cd-9919-28f95e3c07af";
    const fields = { type: "bot", id: botId };
    const descriptors = Object.getOwnPropertyDescriptors(Object.prototype);
    let exported: ReturnType<typeof exportPackageElement> | undefined;
    try {
      for (const [key, value] of Object.entries(fields)) Object.defineProperty(Object.prototype, key, { value, configurable: true });
      exported = exportPackageElement({ elementType: "CustomEngineCopilots", id: "engine", definition: "{}" });
    } finally {
      for (const key of Object.keys(fields)) {
        if (Object.hasOwn(descriptors, key)) Object.defineProperty(Object.prototype, key, descriptors[key]);
        else Reflect.deleteProperty(Object.prototype, key);
      }
    }
    expect(exported).toEqual({ elementType: "CustomEngineCopilots", id: "engine", definition: null, definitionStatus: "not_exported" });
  });

  it("does not export inherited payload definitions or invoke payload accessors", () => {
    const definition = JSON.stringify({ botId: "52bff06b-5db5-42cd-9919-28f95e3c07af" });
    const inherited = Object.assign(Object.create({ definition }), { elementType: "Bots", id: "bot" });
    expect(exportPackageElement(inherited)).toMatchObject({ definition: null, definitionStatus: "invalid" });
    const getter = vi.fn(() => definition);
    const accessor = { elementType: "Bots", id: "bot" };
    Object.defineProperty(accessor, "definition", { get: getter });
    expect(exportPackageElement(accessor)).toMatchObject({ definition: null, definitionStatus: "invalid" });
    expect(getter).not.toHaveBeenCalled();
  });

  it("exports source timestamps and booleans rather than lossy display-layer fallbacks", () => {
    const value = record("exact");
    value.columns = { createdAt: 0, lastModifiedAt: 0, lastPublishedAt: 0, observedAt: 0, webSearch: "Yes", managed: "Yes" };
    value.powerPlatformResource = {
      tenantId: "tenant", nativeId: "native", type: "microsoft.copilotstudio/agents", environmentId: null, location: null,
      displayName: "Native", createdAt: "2026-09-15T00:00:00.1234567+00:00", createdBy: null,
      lastPublishedAt: "2026-09-16T00:00:00.7654321Z", sourceSystem: "power_platform", authoringTool: null,
      creatorType: "unknown", agentKind: "agent", lifecycle: "published", identityConfidence: "exact_native",
      identifiers: [], provenance: {}, unknownFieldCount: 0, details: { isWebSearchEnabledForKnowledge: false, isManaged: false },
    };
    value.observations.packageSnapshots.exact = { id: "catalog", snapshotId: "catalog",
      observedAt: "2026-09-17T00:00:00.123100Z", expiresAt: "2026-09-20T00:00:00Z", current: true, scopeKind: "broad",
      identityDetails: { id: "detail", snapshotId: "detail", observedAt: "2026-09-17T00:00:00.123900Z",
        expiresAt: "2026-09-20T00:00:00Z", current: true } };
    const page = inventory([value]);
    value.usage = { recordId: value.id, reportSetId: "report", status: "linked",
      responses: Number.MAX_SAFE_INTEGER, activeUsers: 0, lastActivityDateUtc: null, associationCount: 1 };
    const row = [...unifiedAgentExportRows(page)][0];
    expect(row).toMatchObject({
      createdAt: value.powerPlatformResource.createdAt, lastModifiedAt: null,
      lastPublishedAt: value.powerPlatformResource.lastPublishedAt,
      lastObservedAt: value.observations.packageSnapshots.exact.identityDetails!.observedAt,
      webSearch: false, managedSolution: false, responses: Number.MAX_SAFE_INTEGER, activeUsers: 0,
    });
    expect(csvValue(row.responses)).toBe('"9007199254740991"');
    expect(JSON.parse(row.usageEvidence!)).toEqual({ summary: value.usage, context: page.usageContext });
  });

  it("retains scoped people and environment evidence without attributing a mismatched person or environment", () => {
    const value = record("people");
    const creatorId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    value.environmentId = "default-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    value.environment = { id: value.environmentId.toUpperCase(), displayName: "", region: null, environmentType: null, isManaged: false,
      groupName: null, groupId: null, provenance: {}, observation: { id: "environment-source", snapshotId: "environment-source",
        current: false, observedAt: "2026-09-14T00:00:00.123456Z", expiresAt: "2026-09-15T00:00:00Z" } };
    value.powerPlatformResource = {
      tenantId: "tenant", nativeId: "native", type: "microsoft.copilotstudio/agents", environmentId: value.environmentId,
      location: null, displayName: "Native", createdAt: null, createdBy: creatorId, lastPublishedAt: null,
      sourceSystem: "power_platform", authoringTool: null, creatorType: "unknown", agentKind: "agent",
      lifecycle: "unknown", identityConfidence: "exact_native", identifiers: [], provenance: {}, unknownFieldCount: 0,
      details: { ownerId: "owner" },
    };
    value.people = {
      owner: { objectId: "former-owner", displayName: "Wrong owner", userPrincipalName: null, observedAt: "2026-09-14T00:00:00Z" },
      createdBy: { objectId: creatorId, displayName: "", userPrincipalName: null, observedAt: "2026-09-14T00:00:00Z",
        status: "lookup_failed", checkedAt: "2026-09-15T00:00:00Z", expiresAt: "2026-09-16T00:00:00Z", errorCode: "lookup_failed" },
    };
    const row = [...unifiedAgentExportRows(inventory([value]))][0];
    expect(row).toMatchObject({ environmentName: "", managedEnvironment: false, ownerResolutionStatus: null,
      ownerDisplayName: undefined, createdByDisplayName: "", createdByResolutionStatus: "lookup_failed" });
    expect(JSON.parse(row.peopleEvidence)).toEqual({ owner: null, createdBy: value.people.createdBy, lastModifiedBy: null });
    expect(JSON.parse(row.environmentObservation!)).toEqual(value.environment.observation);
    value.environment.id = "other-environment";
    expect([...unifiedAgentExportRows(inventory([value]))][0]).toMatchObject({
      environmentName: undefined, environmentObservation: null, environmentContextStatus: "saved_metadata_unavailable",
    });
    value.environmentId = "Environment-A";
    value.environment.id = "environment-a";
    expect([...unifiedAgentExportRows(inventory([value]))][0]).toMatchObject({
      environmentName: undefined, environmentObservation: null, environmentContextStatus: "saved_metadata_unavailable",
    });
  });

  it("marks representatives incomplete and retains exact identity, source, people, environment and usage evidence", () => {
    const value = record("representative"), page = inventory([value]);
    value.packageCount = 3; value.memberCount = 3; value.packagesComplete = false;
    value.packages[0].lastModifiedDateTime = "2026-09-10T00:00:00.000123Z";
    value.columns = { lastModifiedAt: Date.parse("2026-09-20T00:00:00Z") };
    value.identity = { ...value.identity, reason: "matching details invalid", invalidMetadata: true,
      warnings: [{ code: "source_specific_agent_identity", message: "Source identity differs." }] };
    page.identityCollection = { checkedPackages: 0, pendingPackages: 3, invalidPackages: 1,
      pendingDetails: { missing: 1, stale: 1, invalidated: 1 } };
    const row = [...unifiedAgentExportRows(page)][0];
    expect(row).toMatchObject({ packageCount: 3, memberCount: 3, packagesComplete: false, powerPlatformCount: 0, lastModifiedAt: null });
    expect(JSON.parse(row.packageStates)[0].lastModifiedDateTime).toBe(value.packages[0].lastModifiedDateTime);
    expect(JSON.parse(row.identityDetails)).toEqual(value.identity);
    expect(JSON.parse(row.inventorySelection)).toEqual(page.selection);
    expect(JSON.parse(row.inventorySources)).toEqual(page.sources);
    expect(JSON.parse(row.inventoryFreshness)).toEqual(page.freshness);
    expect(JSON.parse(row.inventoryIdentityCollection!)).toEqual(page.identityCollection);
  });

  it("serializes nested saved evidence deterministically without changing array order", () => {
    const page = inventory([record("stable")]);
    const path = { sourceSystem: "graph_packages" as const, path: "publisher", maturity: "ga" as const };
    page.value[0].packages[0].provenance = { z: path, a: { maturity: "ga", path: "name", sourceSystem: "graph_packages" } };
    const first = [...unifiedAgentExportRows(page)][0];
    page.value[0].packages[0].provenance = { a: { sourceSystem: "graph_packages", path: "name", maturity: "ga" }, z: path };
    const second = [...unifiedAgentExportRows(page)][0];
    expect(second.packageStates).toBe(first.packageStates);
    expect(JSON.parse(second.packageIds)).toEqual(["stable"]);
  });
});
