import { describe, expect, it, vi } from "vitest";
import type { UnifiedAgentInventoryPage, UnifiedAgentRecord } from "../types/unifiedAgents.js";
import { csvValue } from "./csvExport.js";
import { agentCapabilityExport } from "./agentContextExport.js";
import type { PowerPlatformResource } from "../types/powerPlatformInventory.js";
import { buildUnifiedAgentCsv } from "./unifiedAgentExport.js";

vi.mock("../db/pool.js", () => ({ pool: {}, secretValue: vi.fn(() => undefined) }));
vi.mock("../db/sessions.js", () => ({
  assertCurrentStoredSession: vi.fn(),
  beginAccountSessionValidation: vi.fn(),
  commitAccountSessionValidation: vi.fn(),
}));

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
    revision: "a".repeat(64), value, count: value.length, limit: 5_000, offset: 0,
    summary, inventoryScope: "all", scopeSummary: summary, filteredSummary: summary,
    verification: {
      status: "needs_attention", scope: "authorized_saved_sources", checkedAt: "2026-09-15T00:00:00.000Z",
      graphPackageCount: value.length, powerPlatformAgentCount: 0, representedSourceCount: value.length,
      uniqueSourceCount: value.length, logicalAgentCount: value.length,
      checks: { sourceScopes: false, packageMetadata: false, identityLinks: true, sourceMemberships: true },
    },
    facets: { environments: [], platforms: [], types: [] },
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

  it.each(["before", "during"] as const)("stops projecting rows when the deadline expires %s projection", phase => {
    const page = inventory();
    let now = Date.now();
    const deadlineAt = now + 15_000;
    const firstName = vi.fn(() => {
      now = deadlineAt;
      return "First";
    });
    const secondName = vi.fn(() => "Second");
    page.value[0] = { ...page.value[0], get displayName() { return firstName(); } };
    page.value[1] = { ...page.value[1], get displayName() { return secondName(); } };
    if (phase === "before") now = deadlineAt;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      expect(() => buildUnifiedAgentCsv(page, deadlineAt))
        .toThrowError(expect.objectContaining({ code: "export_deadline" }));
      expect(firstName).toHaveBeenCalledTimes(phase === "before" ? 0 : 1);
      expect(secondName).not.toHaveBeenCalled();
    } finally {
      clock.mockRestore();
    }
  });

  it("stops projecting rows as soon as the byte limit is exceeded", () => {
    const page = inventory();
    page.value[0].displayName = "x".repeat(8_000_001);
    const secondName = vi.fn(() => "Second");
    page.value[1] = { ...page.value[1], get displayName() { return secondName(); } };
    expect(() => buildUnifiedAgentCsv(page, Date.now() + 15_000))
      .toThrowError(expect.objectContaining({ code: "export_byte_limit" }));
    expect(secondName).not.toHaveBeenCalled();
  });

  it("stops projecting rows after rejecting the first row beyond the row limit", () => {
    const excessName = vi.fn(() => "Excess");
    const page = inventory([
      ...Array.from({ length: 5_001 }, (_, index) => record(`package-${index}`)),
      { ...record("excess"), get displayName() { return excessName(); } },
    ]);
    expect(() => buildUnifiedAgentCsv(page, Date.now() + 15_000))
      .toThrowError(expect.objectContaining({ code: "export_row_limit" }));
    expect(excessName).not.toHaveBeenCalled();
  });

  it("preserves row ordering, quoted formulas, package metadata and the byte count", () => {
    const page = inventory([record("first", "=First"), record("second", 'Second, "quoted"')]);
    const csv = buildUnifiedAgentCsv(page, Date.now() + 15_000);
    const [header, first, second, trailing] = csv.buffer.toString("utf8").split("\r\n");
    expect(header.startsWith("\uFEFFagentId,displayName,environmentId,environmentName,")).toBe(true);
    expect(first.startsWith('"graph_packages:first","\'=First",')).toBe(true);
    expect(second.startsWith('"graph_packages:second","Second, ""quoted""",')).toBe(true);
    expect(first).toContain(csvValue(JSON.stringify([{
      packageId: "first", version: null, isBlocked: false, availableTo: null, deployedTo: null,
      publisher: null, type: null, supportedHosts: [], snapshotId: null, observedAt: null,
    }])));
    expect(trailing).toBe("");
    expect(csv.rowCount).toBe(2);
    expect(csv.byteCount).toBe(csv.buffer.byteLength);
  });

  it("retains a valid header for an empty saved selection", () => {
    const csv = buildUnifiedAgentCsv(inventory([]), Date.now() + 15_000);
    expect(csv.rowCount).toBe(0);
    expect(csv.buffer.toString("utf8").split("\r\n")).toHaveLength(2);
    expect(csv.byteCount).toBe(csv.buffer.byteLength);
  });
});
