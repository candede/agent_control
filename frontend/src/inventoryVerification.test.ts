// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { UnifiedAgentInventoryPage } from "./api/client";
import { inventoryAttentionReasons, inventoryCoverageLabel, inventoryDetailsPending, inventoryRequestScope, inventoryRoleHint, savedInventoryTime } from "./inventoryVerification";
import { createInventoryVerification, createUnifiedVerification, inventoryPageMetadata } from "./test/inventoryVerification";

function savedInventory(): UnifiedAgentInventoryPage {
  const summary = { total: 2, linked: 0, graphOnly: 2, powerPlatformOnly: 0, conflicting: 0, ambiguous: 0 };
  const observedAt = "2026-09-20T12:00:00.000Z", expiresAt = "2030-01-01T00:00:00.000Z";
  return {
    ...inventoryPageMetadata({ total: 2, scoped: 2, filtered: 0, packageTargets: 0 }),
    inventoryScope: "all", summary, scopeSummary: summary, value: [],
    filteredSummary: { ...summary, total: 0, graphOnly: 0 },
    verification: createUnifiedVerification({ graphPackageCount: 2, powerPlatformAgentCount: 0, logicalAgentCount: 2 }),
    identityCollection: { checkedPackages: 2, pendingPackages: 0 },
    sources: {
      graphPackages: { state: "available", error: null, observation: {
        id: "graph", snapshotId: "graph", current: true, tokenMode: "delegated", scopeKind: "broad",
        observedAt, expiresAt, observedCount: 2, totalRecords: 2,
      } },
      powerPlatform: { state: "available", error: null, observation: {
        id: "platform", snapshotId: "platform", current: true, roleScope: "unknown", environmentScope: null,
        observedAt, expiresAt, coverage: "covered", coveredCount: 0, observedCount: 0, totalRecords: 0,
        pageCount: 1, verification: createInventoryVerification(0),
      } },
    },
    partial: false, errors: [],
  };
}

describe("saved inventory evidence labels", () => {
  it("keeps optional role hints separate from collection and permission evidence", () => {
    expect(inventoryRoleHint("unknown")).toBe("Not supplied");
    expect(inventoryRoleHint(undefined)).toBe("Not supplied");
    expect(inventoryRoleHint(null)).toBe("Not supplied");
    expect(inventoryRoleHint("ai")).toBe("AI (hint only)");
    expect(inventoryRoleHint("full")).toBe("Full (hint only)");
    expect(inventoryRequestScope(null)).toBe("All environments requested");
    expect(inventoryRequestScope("finance-env")).toBe("Environment requested: finance-env");
  });

  it("labels every coverage state without promoting an unverified query to complete coverage", () => {
    expect(inventoryCoverageLabel("covered")).toBe("Authorized query verified");
    expect(inventoryCoverageLabel("not_requested")).toBe("Not requested");
    expect(inventoryCoverageLabel("not_authorized_scope")).toBe("Not queried (role scope)");
    expect(inventoryCoverageLabel("unknown")).toBe("Unknown (not verified)");
  });

  it("identifies an invalid saved timestamp explicitly", () => {
    expect(savedInventoryTime("invalid")).toBe("Invalid saved timestamp");
  });
});

describe("saved inventory attention and pending evidence", () => {
  it("does not invent an error or pending details before a saved read exists", () => {
    expect(inventoryAttentionReasons()).toEqual([]);
    expect(inventoryDetailsPending()).toBe(false);
    expect(inventoryAttentionReasons(undefined, "Saved read failed.")).toEqual(["Saved read failed."]);
  });

  it("keeps a read failure separate from a retained receipt and recovers without remembered errors", () => {
    const inventory = savedInventory();
    inventory.errors.push({ source: "power_platform", code: "coverage_unknown", message: "Previous coverage was incomplete." });
    expect(inventoryAttentionReasons(inventory, "Current verification failed.")).toEqual(["Current verification failed."]);
    const replacement = savedInventory();
    expect(inventoryAttentionReasons(replacement)).toEqual([]);
    expect(inventoryDetailsPending(replacement)).toBe(false);
    expect(inventoryAttentionReasons(inventory)).toEqual(["Previous coverage was incomplete."]);
  });

  it("deduplicates source errors without replacing their specific recovery information", () => {
    const inventory = savedInventory();
    const error = { source: "power_platform" as const, code: "coverage_unknown" as const, message: "Agent query was not collected." };
    inventory.errors.push(error);
    inventory.sources.powerPlatform = { state: "unavailable", observation: null, error };
    inventory.partial = true;
    inventory.verification = createUnifiedVerification(inventory.verification, { sourceScopes: false });
    expect(inventoryAttentionReasons(inventory)).toEqual([error.message]);
    inventory.errors = [];
    expect(inventoryAttentionReasons(inventory)).toEqual([error.message]);
  });

  it.each(["missing", "stale", "invalidated"] as const)("separates %s package detail freshness from collection failures", kind => {
    const inventory = savedInventory();
    inventory.identityCollection = { checkedPackages: 0, pendingPackages: 2,
      pendingDetails: { missing: 0, stale: 0, invalidated: 0, [kind]: 2 } };
    inventory.verification = createUnifiedVerification(inventory.verification, {}, undefined, inventory.identityCollection);
    expect(inventoryDetailsPending(inventory)).toBe(true);
    expect(inventoryAttentionReasons(inventory)).toEqual([]);
    inventory.verification.status = "needs_attention";
    expect(inventoryAttentionReasons(inventory)).toEqual([]);
  });

  it.each([1, 2])("reports %s invalid package metadata records even while other detail checks are pending", invalidPackages => {
    const inventory = savedInventory();
    inventory.identityCollection = { checkedPackages: 1, pendingPackages: 1, invalidPackages };
    inventory.verification = createUnifiedVerification(inventory.verification, {}, undefined, inventory.identityCollection);
    expect(inventoryDetailsPending(inventory)).toBe(true);
    expect(inventoryAttentionReasons(inventory)).toEqual([
      `${invalidPackages} package${invalidPackages === 1 ? "" : "s"} with invalid matching metadata. Use diagnostics to refresh matching details for the affected packages.`,
    ]);
  });

  it("does not let pending metadata hide independent source and identity failures", () => {
    const inventory = savedInventory();
    inventory.identityCollection = { checkedPackages: 0, pendingPackages: 2 };
    inventory.summary = { ...inventory.summary, graphOnly: 0, conflicting: 1, ambiguous: 1 };
    inventory.verification = createUnifiedVerification(inventory.verification, { sourceScopes: false, packageMetadata: false, identityLinks: false });
    expect(inventoryAttentionReasons(inventory)).toEqual([
      "Saved source coverage is incomplete. Check source permissions and refresh the affected source in Data sync.",
      "1 conflicting and 1 ambiguous identity links. Review the affected agents' matching details; names alone cannot resolve them.",
    ]);
  });

  it("distinguishes unverified metadata without pending counts from a pending receipt", () => {
    const inventory = savedInventory();
    inventory.identityCollection = undefined;
    inventory.verification = { ...createUnifiedVerification(inventory.verification, { packageMetadata: false }), status: "needs_attention" };
    expect(inventoryDetailsPending(inventory)).toBe(false);
    expect(inventoryAttentionReasons(inventory)).toEqual([
      "Package identity metadata has not been verified. Open diagnostics to inspect or refresh matching details.",
    ]);
    inventory.verification.status = "details_pending";
    expect(inventoryDetailsPending(inventory)).toBe(true);
    expect(inventoryAttentionReasons(inventory)).toEqual([]);
  });

  it("does not promote unexplained partial evidence to a verified result", () => {
    const inventory = savedInventory();
    inventory.partial = true;
    expect(inventoryAttentionReasons(inventory)).toEqual([
      "Saved inventory checks are incomplete. Open diagnostics to recheck source coverage and identity accounting.",
    ]);
  });
});
