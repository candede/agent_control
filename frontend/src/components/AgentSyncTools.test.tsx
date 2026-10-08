import type { ComponentProps, ReactNode } from "react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { powerPlatformResourceTypes, type InventoryRefreshJob, type UnifiedAgentInventoryPage } from "../api/client";
import { AgentSyncTools } from "./AgentSyncTools";
import { createInventoryVerification, createUnifiedVerification, inventoryPageMetadata } from "../test/inventoryVerification";
import { mockNativeDialogs } from "../test/dialog";

mockNativeDialogs();

vi.mock("../workbenchActionContext", () => ({
  WorkbenchActionGate: ({ children }: { children: ReactNode }) => children,
}));

function props(overrides: Partial<ComponentProps<typeof AgentSyncTools>> = {}): ComponentProps<typeof AgentSyncTools> {
  return {
    selectedPackageCount: 0,
    verifyingInventory: false,
    onVerifyInventory: vi.fn(),
    refreshingPackages: false,
    refreshingPowerPlatform: false,
    exportingPowerPlatform: false,
    onRefreshPackages: vi.fn(),
    onRefreshMatchingDetails: vi.fn(),
    onRefreshPowerPlatform: vi.fn(),
    onResumePowerPlatform: vi.fn(),
    onExportPowerPlatform: vi.fn(() => true),
    onInspectPowerPlatformJob: vi.fn(),
    onOpenAgents: vi.fn(),
    ...overrides,
  };
}

function inventory(agentCount: number | null = 1247): UnifiedAgentInventoryPage {
  const summary = { total: 1561, linked: 690, graphOnly: 314, powerPlatformOnly: 557, conflicting: 0, ambiguous: 0 };
  return {
    inventoryScope: "all", scopeSummary: summary,
    ...inventoryPageMetadata({ total: 1561, scoped: 1561, filtered: 1561, packageTargets: 1010 }),
    value: [], summary, filteredSummary: summary,
    verification: createUnifiedVerification({ graphPackageCount: 1010, powerPlatformAgentCount: 1247, logicalAgentCount: 1561 }),
    identityCollection: { checkedPackages: 1010, pendingPackages: 0 },
    sources: {
      graphPackages: { state: "available", observation: {
        id: "graph-snapshot", snapshotId: "graph-snapshot", current: true, tokenMode: "delegated", scopeKind: "broad",
        observedAt: "2026-09-16T15:14:20Z", expiresAt: "2026-09-23T15:14:20Z", observedCount: 1010, totalRecords: 1010,
      }, error: null },
      powerPlatform: { state: "available", observation: {
        id: "pp-snapshot", snapshotId: "pp-snapshot", current: true, roleScope: "unknown", environmentScope: null,
        observedAt: "2026-09-16T14:02:57Z", expiresAt: "2026-10-16T14:02:57Z",
        coverage: "covered", coveredCount: agentCount, observedCount: 4178, totalRecords: 4178, pageCount: 42,
        verification: createInventoryVerification(4178, [...powerPlatformResourceTypes]),
      }, error: null },
    },
    partial: false, errors: [],
  };
}

describe("AgentSyncTools", () => {
  it("keeps technical diagnostics in a separate modal without starting work", async () => {
    const actions = props({ inventory: inventory() });
    render(<AgentSyncTools {...actions} />);
    const disclosure = screen.getByText("View diagnostics");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByText("Saved inventory verified")).not.toBeInTheDocument();
    expect(screen.queryByText("Source-metadata links")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Verify saved inventory" })).not.toBeInTheDocument();
    await userEvent.click(disclosure);
    expect(screen.getByRole("dialog", { name: "Inventory diagnostics" })).toBeVisible();
    expect(screen.getByText("Saved inventory verified")).toBeVisible();
    expect(screen.getByText(/No manual verification or administrator approval is required after sync/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Verify saved inventory" })).toBeEnabled();
    await userEvent.click(screen.getByRole("button", { name: "Close inventory diagnostics" }));
    expect(screen.queryByText("Saved inventory verified")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Refresh agents" })).not.toBeInTheDocument();
    expect(disclosure).toHaveFocus();
    expect(actions.onVerifyInventory).not.toHaveBeenCalled();
    expect(actions.onRefreshPackages).not.toHaveBeenCalled();
    expect(actions.onRefreshMatchingDetails).not.toHaveBeenCalled();
    expect(actions.onRefreshPowerPlatform).not.toHaveBeenCalled();
    expect(actions.onResumePowerPlatform).not.toHaveBeenCalled();
    expect(actions.onExportPowerPlatform).not.toHaveBeenCalled();
    expect(actions.onOpenAgents).not.toHaveBeenCalled();
  });

  it("tabs backwards from the queried resource types disclosure to the preceding action", async () => {
    const actions = props({ inventory: inventory() });
    render(<AgentSyncTools {...actions} />);
    await userEvent.click(screen.getByRole("button", { name: "View diagnostics" }));
    const summary = screen.getByText("Actual queried resource types");
    summary.focus();
    expect(summary).toHaveFocus();
    await userEvent.tab({ shift: true });
    expect(screen.getByRole("button", { name: "Verify saved inventory" })).toHaveFocus();
    expect(actions.onVerifyInventory).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Inventory diagnostics" })).toHaveAttribute("open");
  });

  it.each(["needs_attention", "read_error"] as const)("keeps a concise %s notice visible when diagnostics are collapsed", state => {
    const saved = inventory();
    if (state === "needs_attention") saved.verification = createUnifiedVerification(saved.verification, { sourceScopes: false });
    render(<AgentSyncTools {...props({
      inventory: saved,
      inventoryError: state === "read_error" ? "Saved total and normalized identities disagree." : undefined,
    })} />);
    const notice = screen.getByRole(state === "read_error" ? "alert" : "status", { name: "" });
    expect(notice).toHaveTextContent(state === "read_error"
      ? "Saved total and normalized identities disagree."
      : "Saved source coverage is incomplete.");
    expect(notice).toBeVisible();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Saved agent inventory verification" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Verify saved inventory" })).not.toBeInTheDocument();
  });

  it.each(["details_pending", "needs_attention"] as const)("keeps routine expiry in diagnostics without an admin warning (%s receipt)", async status => {
    const saved = inventory();
    saved.identityCollection = { checkedPackages: 461, pendingPackages: 549, pendingDetails: { missing: 0, stale: 549, invalidated: 0 } };
    saved.verification = { ...createUnifiedVerification(saved.verification, { packageMetadata: false }), status };
    render(<AgentSyncTools {...props({ inventory: saved })} />);
    expect(screen.getByText("Sources checked")).toBeVisible();
    expect(screen.queryByText("Needs attention")).not.toBeInTheDocument();
    expect(screen.queryByText("What needs attention")).not.toBeInTheDocument();
    expect(screen.queryByText(/awaiting identity metadata/)).not.toBeInTheDocument();
    expect(screen.queryByText(/549/)).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await userEvent.click(screen.getByText("View diagnostics"));
    expect(screen.getByText("Saved source accounting verified")).toBeVisible();
    expect(screen.getByText("461 package detail checks current; 549 not current.")).toBeVisible();
    const freshness = within(screen.getByLabelText("Package detail freshness"));
    expect(freshness.getByText("Not yet collected").nextElementSibling).toHaveTextContent(/^0$/);
    expect(freshness.getByText("Previously collected, expired").nextElementSibling).toHaveTextContent(/^549$/);
    expect(screen.getByText(/Repeating a successful read does not guarantee a match/)).toBeVisible();
  });

  it("lists actual source limitations and recovery guidance before diagnostics are opened", () => {
    const saved = inventory();
    saved.errors = [{ source: "power_platform", code: "coverage_unknown", message: "Copilot Studio agent coverage is incomplete." }];
    saved.partial = true;
    saved.identityCollection = { checkedPackages: 1010, pendingPackages: 0, invalidPackages: 2 };
    saved.verification = createUnifiedVerification(saved.verification, { sourceScopes: false }, undefined, saved.identityCollection);
    render(<AgentSyncTools {...props({ inventory: saved })} />);
    expect(screen.getByText("Copilot Studio agent coverage is incomplete.")).toBeVisible();
    expect(screen.getByText(/2 packages with invalid matching metadata/)).toHaveTextContent("Use diagnostics to refresh matching details");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("keeps invalid metadata separate from pending details and withdraws it during replacement verification", async () => {
    const saved = inventory();
    saved.identityCollection = { checkedPackages: 1009, pendingPackages: 1, invalidPackages: 1 };
    saved.verification = createUnifiedVerification(saved.verification, {}, undefined, saved.identityCollection);
    const actions = props({ inventory: saved });
    const view = render(<AgentSyncTools {...actions} />);
    expect(screen.getByText("Needs attention")).toBeVisible();
    expect(screen.getByText(/1 package with invalid matching metadata/)).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "View diagnostics" }));
    expect(screen.getByText("Saved inventory needs attention")).toBeVisible();
    expect(screen.queryByText("Saved source accounting verified")).not.toBeInTheDocument();
    expect(screen.queryByText("Package identity metadata checked and valid.")).not.toBeInTheDocument();
    expect(screen.getByText(/1 package has invalid saved matching metadata/)).toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: "Verify saved inventory" }));
    view.rerender(<AgentSyncTools {...actions} verifyingInventory />);
    expect(screen.queryByText(/invalid.*matching metadata/)).not.toBeInTheDocument();
    const replacement = inventory();
    replacement.identityCollection = { checkedPackages: 1009, pendingPackages: 1, invalidPackages: 0 };
    replacement.verification = createUnifiedVerification(replacement.verification, {}, undefined, replacement.identityCollection);
    view.rerender(<AgentSyncTools {...actions} inventory={replacement} />);
    expect(screen.getByText("Sources checked")).toBeVisible();
    expect(screen.getByText("Saved source accounting verified")).toBeVisible();
    expect(screen.queryByText(/invalid.*matching metadata/)).not.toBeInTheDocument();
    expect(actions.onVerifyInventory).toHaveBeenCalledOnce();
    expect(actions.onRefreshPackages).not.toHaveBeenCalled();
    expect(actions.onRefreshMatchingDetails).not.toHaveBeenCalled();
  });

  it.each([0, 1, 100, 101, 5000, 5001])("requires 1-5000 staged targets for matching refresh, with %s selected", async count => {
    const actions = props({ inventory: inventory(), selectedPackageCount: count });
    render(<AgentSyncTools {...actions} />);
    await userEvent.click(screen.getByText("View diagnostics"));
    const refresh = screen.getByRole("button", { name: "Refresh matching details" });
    if (count > 0 && count <= 5000) {
      expect(refresh).toBeEnabled();
      await userEvent.click(refresh);
      expect(actions.onRefreshMatchingDetails).toHaveBeenCalledOnce();
    } else {
      expect(refresh).toBeDisabled();
    }
    expect(screen.getByRole("button", { name: "Export PP agent inventory CSV" })).toBeEnabled();
    await userEvent.click(screen.getByRole("button", { name: "Select packages on Agents" }));
    expect(actions.onOpenAgents).toHaveBeenCalledOnce();
  });

  it("disables competing Graph refreshes while a refresh is in progress", async () => {
    render(<AgentSyncTools {...props({ selectedPackageCount: 1, refreshingPackages: true })} />);
    await userEvent.click(screen.getByText("View diagnostics"));
    expect(screen.getByRole("button", { name: "Refreshing agents" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Refresh matching details" })).toBeDisabled();
  });

  it("does not enable matching refresh or imply verified counts before saved inventory exists", async () => {
    const actions = props({ selectedPackageCount: 1 });
    render(<AgentSyncTools {...actions} />);
    expect(screen.getByText("Not checked")).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent("No saved inventory receipt is available.");
    await userEvent.click(screen.getByRole("button", { name: "View diagnostics" }));
    expect(screen.getByRole("button", { name: "Refresh matching details" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Export PP agent inventory CSV" })).toBeDisabled();
    expect(actions.onRefreshMatchingDetails).not.toHaveBeenCalled();
  });

  it.each(["not_collected", "preparing"] as const)("withdraws a previous receipt when inventory becomes %s", async state => {
    const actions = props({ inventory: inventory(), selectedPackageCount: 1 });
    const view = render(<AgentSyncTools {...actions} />);
    await userEvent.click(screen.getByRole("button", { name: "View diagnostics" }));
    expect(screen.getByText("Saved inventory verified")).toBeVisible();
    view.rerender(<AgentSyncTools {...actions} inventoryUnavailable={{ state, message: "Waiting for saved inventory." }} />);
    const receipt = within(screen.getByRole("region", { name: "Saved agent inventory verification" }));
    expect(receipt.getByRole("status")).toHaveTextContent("Waiting for saved inventory.");
    expect(screen.queryByText("Saved inventory verified")).not.toBeInTheDocument();
    expect(screen.queryByText("Source-metadata links")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Refresh matching details" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Export PP agent inventory CSV" })).toBeDisabled();
  });

  it.each([true, false])("closes diagnostics only when the export was admitted: %s", async accepted => {
    const actions = props({ inventory: inventory(), onExportPowerPlatform: vi.fn(() => accepted) });
    render(<AgentSyncTools {...actions} />);
    await userEvent.click(screen.getByRole("button", { name: "View diagnostics" }));
    await userEvent.click(screen.getByRole("button", { name: "Export PP agent inventory CSV" }));
    expect(actions.onExportPowerPlatform).toHaveBeenCalledOnce();
    if (accepted) expect(screen.queryByRole("dialog", { name: "Inventory diagnostics" })).not.toBeInTheDocument();
    else expect(screen.getByRole("dialog", { name: "Inventory diagnostics" })).toBeVisible();
  });

  it("leaves Power Platform commands to the open exact source job", async () => {
    const powerPlatformJob: InventoryRefreshJob = {
      id: "waiting-job", status: "waiting_authorization", roleScope: "unknown", environmentScope: null,
      requestedTypes: ["microsoft.copilotstudio/agents"], pageCount: 0, observedCount: 0,
      totalRecords: null, unknownFieldCount: 0, snapshotId: null,
      createdAt: "2026-09-16T15:14:20Z", updatedAt: "2026-09-16T15:14:20Z", attemptedAt: null, finishedAt: null,
    };
    const actions = props({ inventory: inventory(), powerPlatformJob, inspectingPowerPlatformJob: true });
    render(<AgentSyncTools {...actions} />);
    await userEvent.click(screen.getByRole("button", { name: "View diagnostics" }));
    for (const name of ["Refresh PP agent inventory", "Resume PP agent refresh"]) {
      const button = screen.getByRole("button", { name });
      expect(button).toBeDisabled();
      await userEvent.click(button);
    }
    expect(screen.getByText(/Use the open source job/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Export PP agent inventory CSV" })).toBeEnabled();
    expect(actions.onRefreshPowerPlatform).not.toHaveBeenCalled();
    expect(actions.onResumePowerPlatform).not.toHaveBeenCalled();
  });

  it("qualifies retained source-job status when history cannot be read", async () => {
    const powerPlatformJob: InventoryRefreshJob = {
      id: "saved-job", status: "succeeded", roleScope: "unknown", environmentScope: null,
      requestedTypes: ["microsoft.copilotstudio/agents"], pageCount: 1, observedCount: 1,
      totalRecords: 1, unknownFieldCount: 0, snapshotId: "pp-snapshot",
      createdAt: "2026-09-16T15:14:20Z", updatedAt: "2026-09-16T15:14:20Z", attemptedAt: null, finishedAt: null,
    };
    render(<AgentSyncTools {...props({
      inventory: inventory(), powerPlatformJob, powerPlatformHistoryError: "Unable to load source history.",
    })} />);
    await userEvent.click(screen.getByRole("button", { name: "View diagnostics" }));
    const source = within(screen.getByRole("region", { name: "Power Platform agent source" }));
    expect(source.getByRole("alert")).toHaveTextContent("Unable to load source history.");
    expect(source.getByRole("status")).toHaveTextContent("Last observed agent refresh: succeeded");
    expect(source.queryByText(/Latest agent refresh/)).not.toBeInTheDocument();
    expect(source.getByRole("button", { name: "Inspect source job" })).toBeEnabled();
  });

  it.each(["loading", "failed"] as const)("prevents matching refresh against %s saved inventory", async state => {
    const actions = props({ inventory: inventory(), selectedPackageCount: 1,
      verifyingInventory: state === "loading",
      inventoryError: state === "failed" ? "The saved inventory selection is no longer available. Reload saved inventory." : undefined });
    render(<AgentSyncTools {...actions} />);
    await userEvent.click(screen.getByText("View diagnostics"));
    const refresh = screen.getByRole("button", { name: "Refresh matching details" });
    expect(refresh).toBeDisabled();
    await userEvent.click(refresh);
    expect(actions.onRefreshMatchingDetails).not.toHaveBeenCalled();
    if (state === "failed") {
      await userEvent.click(screen.getByRole("button", { name: "Reload saved inventory" }));
      expect(actions.onVerifyInventory).toHaveBeenCalledOnce();
      expect(actions.onRefreshPackages).not.toHaveBeenCalled();
      expect(actions.onRefreshPowerPlatform).not.toHaveBeenCalled();
    }
  });

  it("verifies measured collection and 1x source accounting without a partial warning for absent wids", async () => {
    render(<AgentSyncTools {...props({ inventory: inventory() })} />);
    await userEvent.click(screen.getByText("View diagnostics"));
    expect(screen.getByText("Saved inventory verified")).toBeVisible();
    expect(screen.queryByText(/partial unified inventory|partial inventory|coverage unknown|saved inventory needs attention/i)).not.toBeInTheDocument();
    expect(screen.getByText("Resources stored / provider total").nextElementSibling).toHaveTextContent("4,178 / 4,178");
    expect(screen.getByText("Unique resource identities").nextElementSibling).toHaveTextContent("4,178");
    expect(screen.getByText("Provider pages collected").nextElementSibling).toHaveTextContent("42");
    expect(screen.getByText("Power Platform agents observed").nextElementSibling).toHaveTextContent("1,247");
    expect(screen.getByText("Optional directory-role hint").nextElementSibling).toHaveTextContent("Not supplied");
    expect(screen.getByText("Agent type query").nextElementSibling).toHaveTextContent("Authorized query verified");
    expect(screen.getByText("Environment request scope").nextElementSibling).toHaveTextContent("All environments requested");
    expect(screen.getByText("Targets represented / unique source targets").nextElementSibling).toHaveTextContent("2,257 / 2,257");
    expect(screen.getByText("Logical agents").nextElementSibling).toHaveTextContent("1,561");
    expect(screen.getByText(/Each available source target is represented exactly once/)).toBeVisible();
    expect(screen.getByText("1,010 package detail checks current; 0 not current.")).toBeVisible();
    expect(screen.getByText(/not a count of valid metadata or matched agents/)).toBeVisible();
    expect(screen.getByText(/does not prove every source-only row is a different physical agent/)).toBeVisible();
    expect(screen.getByText(/classic\/V1 bots.*20 minutes/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Export PP agent inventory CSV" })).toBeEnabled();
  });

  it("retains a real environment restriction and identity issues instead of explaining them away as hints", async () => {
    const saved = inventory();
    const observation = saved.sources.powerPlatform.observation;
    if (!observation || !("roleScope" in observation)) throw new Error("Expected Power Platform observation");
    const error = { source: "power_platform" as const, code: "environment_scope_limited" as const, message: "The saved request is restricted to environment finance-only." };
    saved.sources.powerPlatform = { state: "partial", observation: { ...observation, environmentScope: "finance-only" }, error };
    saved.partial = true;
    saved.errors = [error];
    saved.summary = { ...saved.summary, conflicting: 14, ambiguous: 2 };
    saved.identityCollection = { checkedPackages: 1008, pendingPackages: 2, invalidPackages: 1 };
    saved.verification = createUnifiedVerification(saved.verification, { sourceScopes: false, packageMetadata: false, identityLinks: false });
    render(<AgentSyncTools {...props({ inventory: saved })} />);
    expect(screen.getByText(error.message)).toBeVisible();
    expect(screen.getByText(/14 conflicting and 2 ambiguous identity links/)).toBeVisible();
    expect(screen.queryByText(/packages awaiting identity metadata/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByText("View diagnostics"));
    expect(screen.getByText("Saved inventory needs attention")).toBeVisible();
    expect(screen.queryByText("Saved inventory verified")).not.toBeInTheDocument();
    expect(within(screen.getByRole("dialog")).getByText(/The saved request is restricted to environment finance-only/)).toBeVisible();
    expect(screen.getByText("Environment request scope").nextElementSibling).toHaveTextContent("Environment requested: finance-only");
    expect(screen.getByText(/14 conflicting and 2 ambiguous agent records require review/)).toBeVisible();
    expect(screen.getByText("1,008 package detail checks current; 2 not current.")).toBeVisible();
    expect(screen.getByText(/1 package has invalid saved matching metadata/)).toBeVisible();
  });

  it("shows the full receipt under paging and filtering and delegates verification only to saved reads", async () => {
    const saved = { ...inventory(), count: 1, offset: 50, limit: 1 };
    const actions = props({ inventory: saved });
    render(<AgentSyncTools {...actions} />);
    await userEvent.click(screen.getByText("View diagnostics"));
    const receipt = within(screen.getByRole("region", { name: "Saved agent inventory verification" }));
    expect(receipt.getByText("Logical agents").nextElementSibling).toHaveTextContent("1,561");
    expect(receipt.getByText(/all unfiltered saved records, not the current page or display filters/)).toBeVisible();
    await userEvent.click(receipt.getByRole("button", { name: "Verify saved inventory" }));
    expect(actions.onVerifyInventory).toHaveBeenCalledOnce();
    expect(actions.onRefreshPackages).not.toHaveBeenCalled();
    expect(actions.onRefreshPowerPlatform).not.toHaveBeenCalled();
    expect(actions.onRefreshMatchingDetails).not.toHaveBeenCalled();
  });

  it("does not present a previous green receipt as the latest pending or failed verification", async () => {
    const actions = props({ inventory: inventory() });
    const view = render(<AgentSyncTools {...actions} />);
    await userEvent.click(screen.getByText("View diagnostics"));
    expect(screen.getByText("Saved inventory verified")).toBeVisible();
    view.rerender(<AgentSyncTools {...actions} verifyingInventory />);
    expect(screen.queryByText("Saved inventory verified")).not.toBeInTheDocument();
    expect(screen.queryByText("Source-metadata links")).not.toBeInTheDocument();
    expect(screen.queryByText(/package detail checks current;/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Verifying saved inventory..." })).toBeDisabled();
    view.rerender(<AgentSyncTools {...actions} inventoryError="Saved total and normalized identities disagree." />);
    expect(screen.queryByText("Saved inventory verified")).not.toBeInTheDocument();
    expect(screen.queryByText("Authorized Power Platform query verified")).not.toBeInTheDocument();
    expect(screen.queryByText("Source-metadata links")).not.toBeInTheDocument();
    expect(screen.queryByText(/package detail checks current;/)).not.toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Saved agent inventory verification" })).getByRole("alert")).toHaveTextContent("Saved total and normalized identities disagree.");
    expect(screen.getByRole("button", { name: "Reload saved inventory" })).toBeEnabled();
  });

  it.each(["loading", "failed"] as const)("does not export the previous snapshot while saved inventory is %s", async state => {
    const actions = props({ inventory: inventory() });
    const view = render(<AgentSyncTools {...actions} />);
    await userEvent.click(screen.getByRole("button", { name: "View diagnostics" }));
    expect(screen.getByRole("button", { name: "Export PP agent inventory CSV" })).toBeEnabled();
    view.rerender(<AgentSyncTools {...actions}
      verifyingInventory={state === "loading"}
      inventoryError={state === "failed" ? "The saved selection is unavailable." : undefined} />);
    const exportButton = screen.getByRole("button", { name: "Export PP agent inventory CSV" });
    expect(exportButton).toBeDisabled();
    expect(exportButton).toHaveAttribute("title", state === "loading"
      ? "Wait for the current saved inventory check before exporting."
      : "Reload saved inventory successfully before exporting.");
    await userEvent.click(exportButton);
    expect(actions.onExportPowerPlatform).not.toHaveBeenCalled();
    view.rerender(<AgentSyncTools {...actions} />);
    expect(exportButton).toBeEnabled();
    await userEvent.click(exportButton);
    expect(actions.onExportPowerPlatform).toHaveBeenCalledOnce();
  });

  it("distinguishes checked packages, invalid metadata and linked agents with an explicit recovery action", async () => {
    const saved = inventory();
    saved.identityCollection = { checkedPackages: 1010, pendingPackages: 0, invalidPackages: 1 };
    saved.verification = createUnifiedVerification(saved.verification, {}, undefined, saved.identityCollection);
    const actions = props({ inventory: saved, selectedPackageCount: 2 });
    render(<AgentSyncTools {...actions} />);
    await userEvent.click(screen.getByText("View diagnostics"));
    expect(screen.getByText("1,010 package detail checks current; 0 not current.")).toBeVisible();
    expect(screen.getByText("Source-metadata links").nextElementSibling).toHaveTextContent(/^690$/);
    const diagnostic = screen.getByText(/1 package has invalid saved matching metadata/);
    expect(diagnostic).toBeVisible();
    expect(diagnostic.parentElement).toHaveTextContent("Select affected agents on Agents");
    expect(diagnostic.parentElement).toHaveTextContent("Refresh matching details");
    expect(diagnostic.parentElement).toHaveTextContent("Refresh agents");
    expect(screen.getByText(/not a count of valid metadata or matched agents/)).toBeVisible();
    expect(actions.onRefreshPackages).not.toHaveBeenCalled();
    expect(actions.onRefreshMatchingDetails).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Refresh matching details" }));
    expect(actions.onRefreshMatchingDetails).toHaveBeenCalledOnce();
  });

  it.each([undefined, 0])("does not invent invalid metadata diagnostics for an omitted or zero count (%s)", async invalidPackages => {
    const saved = inventory();
    saved.identityCollection = { checkedPackages: 1010, pendingPackages: 0, ...(invalidPackages === undefined ? {} : { invalidPackages }) };
    render(<AgentSyncTools {...props({ inventory: saved })} />);
    await userEvent.click(screen.getByText("View diagnostics"));
    expect(screen.queryByText(/invalid saved matching metadata/)).not.toBeInTheDocument();
  });

  it.each([[null, "Not established"], [0, "0"]] as const)("does not turn unknown agent count %s into a proven zero", async (count, text) => {
    render(<AgentSyncTools {...props({ inventory: inventory(count) })} />);
    await userEvent.click(screen.getByText("View diagnostics"));
    expect(screen.getByText("Power Platform agents observed").nextElementSibling).toHaveTextContent(text);
  });

  it("does not describe an agent-only snapshot as collection of all resource types", async () => {
    const saved = inventory();
    const observation = saved.sources.powerPlatform.observation;
    if (!observation || !("roleScope" in observation)) throw new Error("Expected a saved observation");
    observation.observedCount = 1247;
    observation.totalRecords = 1247;
    observation.verification = createInventoryVerification(1247);
    render(<AgentSyncTools {...props({ inventory: saved })} />);
    await userEvent.click(screen.getByText("View diagnostics"));
    expect(screen.getByText("Resources stored / provider total").nextElementSibling).toHaveTextContent("1,247 / 1,247");
    expect(screen.getByText("Actual resource types queried").nextElementSibling).toHaveTextContent(/^1$/);
    expect(screen.queryByText("All resource types collected")).not.toBeInTheDocument();
  });
});
