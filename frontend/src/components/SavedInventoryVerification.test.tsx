import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { UnifiedAgentInventoryPage } from "../api/client";
import { createInventoryVerification, createUnifiedVerification } from "../test/inventoryVerification";
import { SavedAgentInventoryVerification } from "./SavedInventoryVerification";

function emptyInventory(): UnifiedAgentInventoryPage {
  const summary = { total: 0, linked: 0, graphOnly: 0, powerPlatformOnly: 0, conflicting: 0, ambiguous: 0 };
  return {
    inventoryScope: "all", scopeSummary: summary,
    value: [], count: 0, offset: 0, limit: 50, summary, filteredSummary: summary,
    verification: createUnifiedVerification({ graphPackageCount: 0, powerPlatformAgentCount: 0, logicalAgentCount: 0 }),
    identityCollection: { checkedPackages: 0, pendingPackages: 0 },
    facets: { environments: [], platforms: [] },
    sources: {
      graphPackages: { state: "available", observation: {
        id: "graph-snapshot", snapshotId: "graph-snapshot", current: true, tokenMode: "delegated", scopeKind: "broad",
        observedAt: "2026-09-16T15:14:20Z", expiresAt: "2026-09-23T15:14:20Z", observedCount: 0, totalRecords: 0,
      }, error: null },
      powerPlatform: { state: "available", observation: {
        id: "pp-snapshot", snapshotId: "pp-snapshot", current: true, roleScope: "unknown", environmentScope: null,
        observedAt: "2026-09-16T14:02:57Z", expiresAt: "2026-10-16T14:02:57Z",
        coverage: "covered", coveredCount: 0, observedCount: 0, totalRecords: 0, pageCount: 1,
        verification: createInventoryVerification(0),
      }, error: null },
    },
    partial: false, errors: [],
  };
}

function withoutSource(inventory: UnifiedAgentInventoryPage, source: keyof UnifiedAgentInventoryPage["sources"]) {
  const error = {
    source: source === "graphPackages" ? "graph_packages" as const : "power_platform" as const,
    code: "snapshot_unavailable" as const,
    message: source === "graphPackages" ? "No saved Graph snapshot is available." : "No saved Power Platform snapshot is available.",
  };
  inventory.sources[source] = { state: "unavailable", observation: null, error };
  inventory.errors.push(error);
  inventory.partial = true;
  inventory.verification = createUnifiedVerification(inventory.verification, { sourceScopes: false });
}

describe("SavedAgentInventoryVerification source availability", () => {
  it("does not describe stale package details as missing metadata or certify their freshness", () => {
    const inventory = emptyInventory();
    inventory.identityCollection = { checkedPackages: 0, pendingPackages: 549, pendingDetails: { missing: 0, stale: 549, invalidated: 0 } };
    inventory.verification = {
      ...createUnifiedVerification({ graphPackageCount: 549, powerPlatformAgentCount: 0, logicalAgentCount: 549 }, { packageMetadata: false }),
      status: "details_pending",
    };
    render(<SavedAgentInventoryVerification inventory={inventory} />);
    expect(screen.getByText("Saved source accounting verified")).toBeVisible();
    expect(screen.queryByText("Saved inventory needs attention")).not.toBeInTheDocument();
    expect(screen.queryByText("Saved inventory verified")).not.toBeInTheDocument();
    expect(screen.queryByText("Package identity metadata checked and valid.")).not.toBeInTheDocument();
    expect(screen.getByText("Package detail checks are not all current. This is not a missing-agent count.")).toBeVisible();
    expect(screen.getByText("Saved data checked at")).toBeVisible();
  });

  it.each([true, false])("does not attest missing Graph metadata when Power Platform is available: %s", powerPlatformAvailable => {
    const inventory = emptyInventory();
    withoutSource(inventory, "graphPackages");
    if (!powerPlatformAvailable) withoutSource(inventory, "powerPlatform");
    expect(inventory.verification.checks.packageMetadata).toBe(true);

    render(<SavedAgentInventoryVerification inventory={inventory} />);

    expect(screen.getByText("Saved inventory needs attention")).toBeVisible();
    expect(screen.getByText("Graph package targets").nextElementSibling).toHaveTextContent(/^Not available$/);
    expect(screen.queryByText("Package identity metadata checked and valid.")).not.toBeInTheDocument();
    expect(screen.getByText("Package identity metadata is not established: the saved Graph source is unavailable.")).toBeVisible();
    expect(screen.queryByText("Saved data verified at")).not.toBeInTheDocument();
    expect(screen.getByText("Saved data checked at").nextElementSibling?.querySelector("time")).toHaveAttribute("datetime", inventory.verification.checkedAt);
    if (powerPlatformAvailable) {
      expect(screen.getByText("Power Platform agent targets").nextElementSibling).toHaveTextContent(/^0$/);
      expect(screen.getByText("No ambiguous or conflicting identity links.")).toBeVisible();
      expect(screen.getByText("Each available source target is represented exactly once.")).toBeVisible();
    } else {
      expect(screen.getByText("Power Platform agent targets").nextElementSibling).toHaveTextContent(/^Not available$/);
      expect(screen.getByText("Targets represented / unique source targets").nextElementSibling).toHaveTextContent(/^Not established$/);
      expect(screen.getByText("Logical agents").nextElementSibling).toHaveTextContent(/^Not established$/);
      expect(screen.queryByText("No ambiguous or conflicting identity links.")).not.toBeInTheDocument();
      expect(screen.queryByText("Each available source target is represented exactly once.")).not.toBeInTheDocument();
      expect(screen.getByText("Identity-link consistency is not established: no saved agent source is available.")).toBeVisible();
      expect(screen.getByText("Source membership accounting is not established: no saved agent source is available.")).toBeVisible();
      expect(screen.queryByText("Authorized Power Platform query verified")).not.toBeInTheDocument();
    }
  });

  it("retains established Graph checks when only Power Platform is unavailable", () => {
    const inventory = emptyInventory();
    withoutSource(inventory, "powerPlatform");

    render(<SavedAgentInventoryVerification inventory={inventory} />);

    expect(screen.getByText("Saved inventory needs attention")).toBeVisible();
    expect(screen.getByText("Graph package targets").nextElementSibling).toHaveTextContent(/^0$/);
    expect(screen.getByText("Power Platform agent targets").nextElementSibling).toHaveTextContent(/^Not available$/);
    expect(screen.getByText("Targets represented / unique source targets").nextElementSibling).toHaveTextContent(/^0 \/ 0$/);
    expect(screen.getByText("Logical agents").nextElementSibling).toHaveTextContent(/^0$/);
    expect(screen.getByText("Package identity metadata checked and valid.")).toBeVisible();
    expect(screen.getByText("No ambiguous or conflicting identity links.")).toBeVisible();
    expect(screen.getByText("Each available source target is represented exactly once.")).toBeVisible();
  });

  it("distinguishes verified empty snapshots from unavailable sources", () => {
    const inventory = emptyInventory();
    render(<SavedAgentInventoryVerification inventory={inventory} />);

    expect(screen.getByText("Saved inventory verified")).toBeVisible();
    const accounting = within(screen.getByLabelText("Full saved agent accounting"));
    expect(accounting.getByText("Graph package targets").nextElementSibling).toHaveTextContent(/^0$/);
    expect(accounting.getByText("Power Platform agent targets").nextElementSibling).toHaveTextContent(/^0$/);
    expect(accounting.getByText("Targets represented / unique source targets").nextElementSibling).toHaveTextContent(/^0 \/ 0$/);
    expect(accounting.getByText("Logical agents").nextElementSibling).toHaveTextContent(/^0$/);
    expect(screen.getByText("Saved source query scopes verified.")).toBeVisible();
    expect(screen.getByText("Package identity metadata checked and valid.")).toBeVisible();
    expect(screen.getByText("No ambiguous or conflicting identity links.")).toBeVisible();
    expect(screen.getByText("Each available source target is represented exactly once.")).toBeVisible();
    expect(screen.getByText("Authorized Power Platform query verified")).toBeVisible();
    expect(screen.queryByText("Saved data checked at")).not.toBeInTheDocument();
    expect(screen.getByText("Saved data verified at").nextElementSibling?.querySelector("time")).toHaveAttribute("datetime", inventory.verification.checkedAt);
  });
});
