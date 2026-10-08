import type { ComponentProps } from "react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { UnifiedAgentInventoryPage } from "../api/client";
import { createInventoryVerification, createUnifiedVerification, inventoryPageMetadata } from "../test/inventoryVerification";
import { SavedAgentInventoryVerification } from "./SavedInventoryVerification";

function emptyInventory(): UnifiedAgentInventoryPage {
  const summary = { total: 0, linked: 0, graphOnly: 0, powerPlatformOnly: 0, conflicting: 0, ambiguous: 0 };
  return {
    ...inventoryPageMetadata(),
    inventoryScope: "all", scopeSummary: summary,
    value: [], summary, filteredSummary: summary,
    verification: createUnifiedVerification({ graphPackageCount: 0, powerPlatformAgentCount: 0, logicalAgentCount: 0 }),
    identityCollection: { checkedPackages: 0, pendingPackages: 0 },
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
  it.each([
    { coverage: "covered", count: 0, label: "Authorized query verified" },
    { coverage: "covered", count: null, label: "Authorized query verified" },
    { coverage: "not_requested", count: null, label: "Not requested" },
    { coverage: "not_authorized_scope", count: null, label: "Not queried (role scope)" },
    { coverage: "unknown", count: null, label: "Unknown (not verified)" },
    { coverage: "unknown", count: 0, label: "Unknown (not verified)" },
  ] as const)("keeps $coverage coverage separate from the observed count $count", ({ coverage, count, label }) => {
    const inventory = emptyInventory();
    const observation = inventory.sources.powerPlatform.observation!;
    inventory.sources.powerPlatform.observation = { ...observation, coverage, coveredCount: count };
    render(<SavedAgentInventoryVerification inventory={inventory} />);
    const details = within(screen.getByRole("region", { name: "Saved Power Platform query verification" }));
    expect(details.getByText("Power Platform agents observed").nextElementSibling).toHaveTextContent(count === null ? /^Not established$/ : /^0$/);
    expect(details.getByText("Agent type query").nextElementSibling?.textContent).toBe(label);
    expect(details.getByText(/not a fresh Microsoft read or proof of universal tenant visibility/)).toBeVisible();
  });

  it.each([true, false])("does not describe pending details as failed metadata or certify freshness (counts supplied: %s)", countsSupplied => {
    const inventory = emptyInventory();
    inventory.identityCollection = countsSupplied
      ? { checkedPackages: 0, pendingPackages: 549, pendingDetails: { missing: 0, stale: 549, invalidated: 0 } }
      : undefined;
    inventory.verification = createUnifiedVerification(
      { graphPackageCount: 549, powerPlatformAgentCount: 0, logicalAgentCount: 549 }, { packageMetadata: false },
    );
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

describe("SavedAgentInventoryVerification read lifecycle", () => {
  it.each([
    { state: "loading", props: { loading: true, error: "Previous read failed." }, message: "Checking saved inventory." },
    { state: "failed", props: { error: "The saved selection expired." }, message: "The saved selection expired." },
    { state: "not collected", props: { unavailable: { state: "not_collected", message: "No saved inventory yet." } }, message: "No saved inventory yet." },
    { state: "preparing", props: { unavailable: { state: "preparing", message: "Preparing saved inventory." } }, message: "Preparing saved inventory." },
    { state: "withdrawn", props: { inventory: undefined }, message: "Saved inventory verification is not available." },
  ] satisfies Array<{
    state: string;
    props: Partial<ComponentProps<typeof SavedAgentInventoryVerification>>;
    message: string;
  }>)("withdraws the previous receipt while $state and shows only the replacement receipt on recovery", ({ state, props, message }) => {
    const inventory = emptyInventory();
    const onVerify = vi.fn();
    const view = render(<SavedAgentInventoryVerification inventory={inventory} onVerify={onVerify} />);
    expect(screen.getByText("Saved inventory verified")).toBeVisible();
    expect(screen.getByText("Authorized Power Platform query verified")).toBeVisible();

    view.rerender(<SavedAgentInventoryVerification inventory={inventory} onVerify={onVerify} {...props} />);
    const region = screen.getByRole("region", { name: "Saved agent inventory verification" });
    expect(region).toHaveAttribute("aria-busy", String(state === "loading"));
    expect(within(region).getByRole(state === "failed" ? "alert" : "status")).toHaveTextContent(message);
    expect(screen.queryByText("Saved inventory verified")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Full saved agent accounting")).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Saved Power Platform query verification" })).not.toBeInTheDocument();
    expect(region.querySelector("time")).toBeNull();
    if (state === "loading") {
      expect(screen.getByRole("button", { name: "Verifying saved inventory..." })).toBeDisabled();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    }

    const replacement = emptyInventory();
    replacement.verification = createUnifiedVerification(
      { graphPackageCount: 7, powerPlatformAgentCount: 0, logicalAgentCount: 7 }, {}, "2026-09-18T06:00:00.000Z",
    );
    view.rerender(<SavedAgentInventoryVerification inventory={replacement} onVerify={onVerify} />);
    expect(screen.getByText("Saved inventory verified")).toBeVisible();
    expect(screen.getByText("Graph package targets").nextElementSibling).toHaveTextContent(/^7$/);
    expect(screen.getByText("Saved data verified at").nextElementSibling?.querySelector("time"))
      .toHaveAttribute("datetime", replacement.verification.checkedAt);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(onVerify).not.toHaveBeenCalled();
  });

  it("only requests explicit saved reads and prevents repeated verification while pending", async () => {
    const inventory = emptyInventory();
    const onVerify = vi.fn();
    const view = render(<SavedAgentInventoryVerification inventory={inventory} />);
    expect(screen.getByRole("button", { name: "Verify saved inventory" })).toBeDisabled();

    view.rerender(<SavedAgentInventoryVerification inventory={inventory} onVerify={onVerify} />);
    view.rerender(<SavedAgentInventoryVerification inventory={{ ...inventory }} onVerify={onVerify} />);
    expect(onVerify).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Verify saved inventory" }));
    expect(onVerify).toHaveBeenCalledOnce();

    view.rerender(<SavedAgentInventoryVerification inventory={inventory} onVerify={onVerify} loading />);
    await userEvent.click(screen.getByRole("button", { name: "Verifying saved inventory..." }));
    expect(onVerify).toHaveBeenCalledOnce();

    view.rerender(<SavedAgentInventoryVerification inventory={inventory} onVerify={onVerify} error="Saved read failed." />);
    await userEvent.click(screen.getByRole("button", { name: "Reload saved inventory" }));
    expect(onVerify).toHaveBeenCalledTimes(2);
    view.rerender(<SavedAgentInventoryVerification onVerify={onVerify} loading />);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByText("Saved inventory verified")).not.toBeInTheDocument();
    view.rerender(<SavedAgentInventoryVerification inventory={inventory} onVerify={onVerify} />);
    expect(screen.getByText("Saved inventory verified")).toBeVisible();
    expect(onVerify).toHaveBeenCalledTimes(2);
  });
});
