import { describe, expect, it, vi } from "vitest";
import type { UnifiedAgentInventoryPage, UnifiedAgentRecord } from "../types/unifiedAgents.js";
import { csvValue } from "./csvEncoding.js";
import { agentCapabilityExport } from "./agentContextExport.js";
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
    expect(first).toContain(csvValue(JSON.stringify([{
      packageId: "first", version: null, isBlocked: false, availableTo: null, deployedTo: null,
      publisher: null, type: null, supportedHosts: [], snapshotId: null, observedAt: null,
    }])));
    expect(rows).toHaveLength(2);
    expect(rows.every(row => row.inventoryRevision === page.selection.revision)).toBe(true);
  });

  it("retains a valid header for an empty saved selection", () => {
    expect([...unifiedAgentExportRows(inventory([]))]).toEqual([]);
    expect(unifiedAgentExportColumns.slice(0, 4)).toEqual(["agentId", "displayName", "environmentId", "environmentName"]);
  });
});
