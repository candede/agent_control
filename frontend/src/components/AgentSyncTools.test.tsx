import type { ComponentProps, ReactNode } from "react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { powerPlatformResourceTypes, type UnifiedAgentInventoryPage } from "../api/client";
import { AgentSyncTools } from "./AgentSyncTools";
import { createInventoryVerification, createUnifiedVerification } from "../test/inventoryVerification";
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
    onExportPowerPlatform: vi.fn(),
    onInspectPowerPlatformJob: vi.fn(),
    onOpenAgents: vi.fn(),
    ...overrides,
  };
}

function inventory(agentCount: number | null = 1247): UnifiedAgentInventoryPage {
  const summary = { total: 1561, linked: 690, graphOnly: 314, powerPlatformOnly: 557, conflicting: 0, ambiguous: 0 };
  return {
    value: [], count: 1561, offset: 0, limit: 50, summary, filteredSummary: summary,
    verification: createUnifiedVerification({ graphPackageCount: 1010, powerPlatformAgentCount: 1247, logicalAgentCount: 1561 }),
    identityCollection: { checkedPackages: 1010, pendingPackages: 0 },
    facets: { environments: [], platforms: [] },
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

  it("explains pending detail enrichment even when catalog collection and source counts are verified", () => {
    const saved = inventory();
    saved.identityCollection = { checkedPackages: 1000, pendingPackages: 10 };
    render(<AgentSyncTools {...props({ inventory: saved })} />);
    expect(screen.getByText("Needs attention")).toBeVisible();
    expect(screen.getByText(/10 packages awaiting identity metadata/)).toBeVisible();
    expect(screen.getByText(/enriched separately in the background after catalog sync/)).toBeVisible();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("lists actual source limitations and recovery guidance before diagnostics are opened", () => {
    const saved = inventory();
    saved.errors = [{ source: "power_platform", code: "coverage_unknown", message: "Copilot Studio agent coverage is incomplete." }];
    saved.partial = true;
    saved.identityCollection = { checkedPackages: 1010, pendingPackages: 0, invalidPackages: 2 };
    render(<AgentSyncTools {...props({ inventory: saved })} />);
    expect(screen.getByText("Copilot Studio agent coverage is incomplete.")).toBeVisible();
    expect(screen.getByText(/2 packages with invalid matching metadata/)).toHaveTextContent("Use diagnostics to refresh matching details");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it.each([0, 1, 100, 101])("requires 1-100 exact targets for matching refresh, with %s selected", async count => {
    const actions = props({ selectedPackageCount: count });
    render(<AgentSyncTools {...actions} />);
    await userEvent.click(screen.getByText("View diagnostics"));
    const refresh = screen.getByRole("button", { name: "Refresh matching details" });
    if (count > 0 && count <= 100) {
      expect(refresh).toBeEnabled();
      await userEvent.click(refresh);
      expect(actions.onRefreshMatchingDetails).toHaveBeenCalledOnce();
    } else {
      expect(refresh).toBeDisabled();
    }
    expect(screen.getByRole("button", { name: "Export PP agent inventory CSV" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Select packages on Agents" }));
    expect(actions.onOpenAgents).toHaveBeenCalledOnce();
  });

  it("disables competing Graph refreshes while a refresh is in progress", async () => {
    render(<AgentSyncTools {...props({ selectedPackageCount: 1, refreshingPackages: true })} />);
    await userEvent.click(screen.getByText("View diagnostics"));
    expect(screen.getByRole("button", { name: "Refreshing agents" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Refresh matching details" })).toBeDisabled();
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
    expect(screen.getByText("1,010 package identities checked; 0 still need collection.")).toBeVisible();
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
    expect(screen.getByText(/2 packages awaiting identity metadata/)).toBeVisible();
    await userEvent.click(screen.getByText("View diagnostics"));
    expect(screen.getByText("Saved inventory needs attention")).toBeVisible();
    expect(screen.queryByText("Saved inventory verified")).not.toBeInTheDocument();
    expect(within(screen.getByRole("dialog")).getByText(/The saved request is restricted to environment finance-only/)).toBeVisible();
    expect(screen.getByText("Environment request scope").nextElementSibling).toHaveTextContent("Environment requested: finance-only");
    expect(screen.getByText(/14 conflicting and 2 ambiguous agent records require review/)).toBeVisible();
    expect(screen.getByText("1,008 package identities checked; 2 still need collection.")).toBeVisible();
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
    expect(screen.queryByText(/package identities checked;/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Verifying saved inventory..." })).toBeDisabled();
    view.rerender(<AgentSyncTools {...actions} inventoryError="Saved total and normalized identities disagree." />);
    expect(screen.queryByText("Saved inventory verified")).not.toBeInTheDocument();
    expect(screen.queryByText("Authorized Power Platform query verified")).not.toBeInTheDocument();
    expect(screen.queryByText("Source-metadata links")).not.toBeInTheDocument();
    expect(screen.queryByText(/package identities checked;/)).not.toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Saved agent inventory verification" })).getByRole("alert")).toHaveTextContent("Saved total and normalized identities disagree.");
    expect(screen.getByRole("button", { name: "Verify saved inventory" })).toBeEnabled();
  });

  it("distinguishes checked packages, invalid metadata and linked agents with an explicit recovery action", async () => {
    const saved = inventory();
    saved.identityCollection = { checkedPackages: 1010, pendingPackages: 0, invalidPackages: 1 };
    saved.verification = createUnifiedVerification(saved.verification, { packageMetadata: false });
    const actions = props({ inventory: saved, selectedPackageCount: 2 });
    render(<AgentSyncTools {...actions} />);
    await userEvent.click(screen.getByText("View diagnostics"));
    expect(screen.getByText("1,010 package identities checked; 0 still need collection.")).toBeVisible();
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
