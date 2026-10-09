import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReportOverviewAgent, ReportPage } from "../../../backend/src/types/officialReportData";
import { ApiError, type SessionUser, type UnifiedAgentInventoryPage } from "../api/client";
import * as api from "../api/reportData";
import { CapabilityContext } from "../capabilityContext";
import { createSavedQueryClient } from "../savedQueries";
import { overviewPage, reports } from "../test/reportDataFixture";
import { automaticUsageContext } from "../test/automaticAgentUsageFixture";
import { createUnifiedVerification, inventoryPageMetadata } from "../test/inventoryVerification";
import { deferred } from "../test/deferred";
import { usageAvailabilityLabel, usageCoverageLabel } from "../usageInsights";
import { AgentInventoryOverview } from "./AgentInventoryOverview";

vi.mock("../api/reportData", async original => ({ ...await original<typeof import("../api/reportData")>(), readReportPage: vi.fn() }));
const clients: ReturnType<typeof createSavedQueryClient>[] = [];
function sharedClient() {
  const client = createSavedQueryClient();
  clients.push(client);
  return client;
}
beforeEach(() => { vi.mocked(api.readReportPage).mockResolvedValue(overviewPage()); });
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()); vi.resetAllMocks(); });
const summary = { total: 0, linked: 0, graphOnly: 0, powerPlatformOnly: 0, ambiguous: 0, conflicting: 0 };
const inventory: UnifiedAgentInventoryPage = {
  ...inventoryPageMetadata(),
  value: [], inventoryScope: "catalog", summary, scopeSummary: summary, filteredSummary: summary,
  verification: createUnifiedVerification({ graphPackageCount: 0, powerPlatformAgentCount: 0, logicalAgentCount: 0 }),
  sources: {
    graphPackages: { state: "unavailable", observation: null, error: { source: "graph_packages", code: "snapshot_unavailable", message: "No catalog." } },
    powerPlatform: { state: "unavailable", observation: null, error: { source: "power_platform", code: "snapshot_unavailable", message: "No inventory." } },
  }, partial: true, errors: [], usageContext: automaticUsageContext,
};

describe("inventory dashboard exact report context", () => {
  it("uses authoritative availability totals rather than deriving them from the displayed records", async () => {
    const totals = { ...summary, total: 2000, graphOnly: 2000 };
    render(<AgentInventoryOverview revision={0} onAccessChange={vi.fn()} inventory={{
      ...inventory,
      counts: { total: 2000, scoped: 2000, filtered: 0, packageTargets: 0 },
      summary: totals, scopeSummary: totals,
      verification: createUnifiedVerification({ graphPackageCount: 2000, powerPlatformAgentCount: 0, logicalAgentCount: 2000 }, { sourceScopes: false }),
      sources: { ...inventory.sources, graphPackages: { state: "available", observation: {
        id: "catalog", snapshotId: "catalog", current: true, tokenMode: "delegated", scopeKind: "broad",
        observedAt: "2026-09-20T12:00:00.000Z", expiresAt: "2030-01-01T00:00:00.000Z", observedCount: 2000, totalRecords: 2000,
      }, error: null } },
      inventoryOverview: { availableToUsers: 1250, organizationCreated: 0, teamsAvailable: 0, createdOrAvailable: 1250 },
    }} />);
    expect(screen.getByRole("button", { name: "Show available to end users" })).toHaveTextContent("1,250");
    await waitFor(() => expect(screen.queryByText("Loading selected report evidence...")).not.toBeInTheDocument());
  });

  it("leaves missing inventory unknown and recovers selected report metrics through local retry", async () => {
    vi.mocked(api.readReportPage).mockRejectedValueOnce(new Error("History unavailable"));
    const view = render(<AgentInventoryOverview revision={0} onAccessChange={vi.fn()} onUsageChange={vi.fn()} />);
    const overview = screen.getByRole("region", { name: "Agent inventory overview" });
    expect(within(overview).getAllByText("Unknown")).toHaveLength(4);
    expect(api.readReportPage).not.toHaveBeenCalled();
    view.rerender(<AgentInventoryOverview revision={0} onAccessChange={vi.fn()} onUsageChange={vi.fn()} inventory={{
      ...inventory, sources: { graphPackages: { state: "unavailable", observation: null,
        error: { source: "graph_packages", code: "snapshot_unavailable", message: "No saved package inventory." } },
      powerPlatform: { state: "unavailable", observation: null,
        error: { source: "power_platform", code: "snapshot_unavailable", message: "No saved Power Platform inventory." } } },
    }} />);
    await screen.findByRole("alert");
    expect(screen.getByRole("button", { name: "Show reported used agents" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Retry activity evidence" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Show reported used agents" })).toHaveTextContent("50,000"));
    expect(api.readReportPage).toHaveBeenLastCalledWith("official-usage/overview", expect.objectContaining({ scope: "selected", limit: 1 }), expect.any(AbortSignal));
    expect(within(overview).getByText("Agents in catalog").parentElement).toHaveTextContent("Unknown");
  });
  it.each([0, 2])("uses exact server totals for the %i-used-agent shortcut, including known zero", async usedAgents => {
    const data = overviewPage(); data.analytics.overview!.usedAgents = usedAgents;
    vi.mocked(api.readReportPage).mockResolvedValue(data);
    const onUsageChange = vi.fn(), view = render(<AgentInventoryOverview revision={0} inventory={inventory} reportedUsage="all" onUsageChange={onUsageChange} />);
    const button = screen.getByRole("button", { name: "Show reported used agents" });
    await waitFor(() => expect(button).toBeEnabled());
    expect(button).toHaveTextContent(String(usedAgents));
    fireEvent.click(button);
    expect(onUsageChange).toHaveBeenCalledExactlyOnceWith("used");
    view.rerender(<AgentInventoryOverview revision={0} inventory={inventory} reportedUsage="used" onUsageChange={onUsageChange} />);
    expect(button).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(button);
    expect(onUsageChange).toHaveBeenLastCalledWith("all");
  });
  it("distinguishes loading and failed evidence from an absent selected report and supports local retry", async () => {
    const pending = deferred<ReportPage<ReportOverviewAgent>>();
    vi.mocked(api.readReportPage).mockReturnValueOnce(pending.promise);
    render(<AgentInventoryOverview revision={0} inventory={inventory} onUsageChange={vi.fn()} />);
    const button = screen.getByRole("button", { name: "Show reported used agents" });
    expect(button).toBeDisabled();
    expect(button).toHaveTextContent("Loading selected report evidence");
    expect(button).not.toHaveTextContent("No selected report data");
    expect(screen.getByText("Loading selected report evidence...")).toHaveClass("sr-only");
    await act(async () => pending.reject(new Error("Evidence unavailable")));
    await screen.findByRole("alert");
    expect(button).toHaveTextContent("Selected report evidence unavailable");
    expect(button).not.toHaveTextContent("No selected report data");
    const retry = deferred<ReportPage<ReportOverviewAgent>>();
    vi.mocked(api.readReportPage).mockReturnValueOnce(retry.promise);
    fireEvent.click(screen.getByRole("button", { name: "Retry activity evidence" }));
    expect(button).toBeDisabled();
    expect(button).toHaveTextContent("Loading selected report evidence");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(api.readReportPage).toHaveBeenCalledTimes(2);
    await act(async () => retry.resolve(overviewPage()));
    await waitFor(() => expect(button).toBeEnabled());
    expect(button).toHaveTextContent("50,000");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
  it.each(["not_selected", "deleted", "incomplete", "never_imported"] as const)(
    "does not read the latest report when inventory has no selected report (%s)", availability => {
      render(<AgentInventoryOverview revision={0} inventory={{ ...inventory, usageContext: {
        ...automaticUsageContext, reports: { ...reports, setId: null, activeSetId: null, availability },
      } }} onUsageChange={vi.fn()} />);
      const button = screen.getByRole("button", { name: "Show reported used agents" });
      expect(button).toBeDisabled();
      expect(button).toHaveTextContent("No selected report data");
      expect(screen.queryByText("Loading selected report evidence...")).not.toBeInTheDocument();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(api.readReportPage).not.toHaveBeenCalled();
    });
  it("renders source status beside a provided selector without repeating the selected reporting dates", async () => {
    const view = render(<AgentInventoryOverview revision={0} inventory={inventory} />);
    await screen.findByText(usageCoverageLabel(reports));
    const selector = <select aria-label="Report set"><option>Selected dates</option></select>;
    for (const availability of ["stale", "not_selected", "deleted", "incomplete"] as const) {
      view.rerender(<AgentInventoryOverview revision={0} reportSelector={selector} inventory={{
        ...inventory, usageContext: { ...automaticUsageContext, reports: { ...reports, availability,
          ...(availability === "stale" ? {} : { setId: null, activeSetId: null }) } },
      }} />);
      expect(screen.getByText(usageAvailabilityLabel(availability)).closest(".agent-report-context")).not.toBeNull();
      expect(screen.queryByText(usageCoverageLabel(reports))).not.toBeInTheDocument();
    }
  });
  it("lets the empty selector replace the duplicate never-imported status", () => {
    const emptyInventory: UnifiedAgentInventoryPage = { ...inventory, usageContext: {
      ...automaticUsageContext, reports: { ...reports, setId: null, activeSetId: null, availability: "never_imported" },
    } };
    const view = render(<AgentInventoryOverview revision={0} inventory={emptyInventory} />);
    expect(screen.getByText("Reports not imported")).toBeVisible();
    view.rerender(<AgentInventoryOverview revision={0} inventory={emptyInventory} reportSelector={
      <select aria-label="Report set" disabled><option>No report sets available</option></select>
    } />);
    expect(screen.getByRole("combobox", { name: "Report set" })).toHaveDisplayValue("No report sets available");
    expect(screen.queryByText("Reports not imported")).not.toBeInTheDocument();
    expect(api.readReportPage).not.toHaveBeenCalled();
  });
  it("reads the exact inventory report set and never joins its latest summary onto a different pinned set", async () => {
    const selected = "10000000-0000-4000-8000-000000000099";
    const data = overviewPage({ reports: { ...reports, setId: selected } });
    vi.mocked(api.readReportPage).mockResolvedValue(data);
    render(<AgentInventoryOverview revision={0} inventory={{
      ...inventory, usageContext: { ...automaticUsageContext, reports: { ...reports, setId: selected } },
    }} onUsageChange={vi.fn()} />);
    await waitFor(() => expect(api.readReportPage).toHaveBeenLastCalledWith("official-usage/overview",
      expect.objectContaining({ scope: "selected", setId: selected, limit: 1 }), expect.any(AbortSignal)));
    await waitFor(() => expect(screen.getByRole("button", { name: "Show reported used agents" })).toBeEnabled());
  });

  it("accepts a case-equivalent report UUID without making another request", async () => {
    const setId = "abcdef12-abcd-4abc-8abc-abcdef123456";
    vi.mocked(api.readReportPage).mockResolvedValue(overviewPage({ reports: { ...reports, setId } }));
    render(<AgentInventoryOverview revision={0} inventory={{
      ...inventory, usageContext: { ...automaticUsageContext, reports: { ...reports, setId: setId.toUpperCase() } },
    }} onUsageChange={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Show reported used agents" })).toBeEnabled());
    expect(api.readReportPage).toHaveBeenCalledOnce();
  });

  it("preserves pending and cached overview evidence when inventory changes only the report UUID casing", async () => {
    const setId = "abcdef12-abcd-4abc-8abc-abcdef123456";
    const pending = deferred<ReportPage<ReportOverviewAgent>>();
    vi.mocked(api.readReportPage).mockReturnValueOnce(pending.promise);
    const content = (id: string) => <AgentInventoryOverview revision={0} inventory={{
      ...inventory, usageContext: { ...automaticUsageContext, reports: { ...reports, setId: id } },
    }} onUsageChange={vi.fn()} />;
    const view = render(content(setId.toUpperCase()));
    const signal = vi.mocked(api.readReportPage).mock.lastCall?.[2];
    view.rerender(content(setId));
    expect(signal?.aborted).toBe(false);
    expect(api.readReportPage).toHaveBeenCalledOnce();
    await act(async () => pending.resolve(overviewPage({ reports: { ...reports, setId } })));
    const button = screen.getByRole("button", { name: "Show reported used agents" });
    await waitFor(() => expect(button).toHaveTextContent("50,000"));
    view.rerender(content(setId.toUpperCase()));
    expect(button).toBeEnabled();
    expect(button).toHaveTextContent("50,000");
    expect(screen.queryByText("Loading selected report evidence...")).not.toBeInTheDocument();
    expect(api.readReportPage).toHaveBeenCalledOnce();
  });

  it("rejects a different returned report set without automatic recovery and requires an explicit restart", async () => {
    vi.mocked(api.readReportPage).mockResolvedValue(overviewPage({
      reports: { ...reports, setId: "10000000-0000-4000-8000-000000000099" },
    }));
    render(<AgentInventoryOverview revision={0} inventory={inventory} onUsageChange={vi.fn()} />);
    const button = screen.getByRole("button", { name: "Show reported used agents" });
    expect(await screen.findByRole("alert")).toHaveTextContent("does not match");
    expect(button).toBeDisabled();
    expect(button).not.toHaveTextContent("50,000");
    expect(button).toHaveTextContent("Selected report evidence unavailable");
    expect(api.readReportPage).toHaveBeenCalledTimes(1);
    vi.mocked(api.readReportPage).mockResolvedValueOnce(overviewPage());
    fireEvent.click(screen.getByRole("button", { name: "Restart selection" }));
    await waitFor(() => expect(button).toBeEnabled());
    expect(button).toHaveTextContent("50,000");
    expect(api.readReportPage).toHaveBeenCalledTimes(2);
  });

  it("withdraws failed background evidence and clears its stale error during retry", async () => {
    render(<AgentInventoryOverview revision={0} inventory={inventory} onUsageChange={vi.fn()} />);
    const button = screen.getByRole("button", { name: "Show reported used agents" });
    await waitFor(() => expect(button).toHaveTextContent("50,000"));
    vi.mocked(api.readReportPage).mockRejectedValueOnce(new Error("Summary refresh failed"));
    act(() => window.dispatchEvent(new Event("focus")));
    await screen.findByRole("alert");
    expect(button).toBeDisabled();
    expect(button).not.toHaveTextContent("50,000");
    const pending = deferred<ReportPage<ReportOverviewAgent>>();
    vi.mocked(api.readReportPage).mockReturnValueOnce(pending.promise);
    fireEvent.click(screen.getByRole("button", { name: "Retry activity evidence" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(button).toHaveTextContent("Loading selected report evidence");
    expect(button).toBeDisabled();
    await act(async () => pending.resolve(overviewPage()));
    await waitFor(() => expect(button).toBeEnabled());
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(api.readReportPage).toHaveBeenCalledTimes(3);
  });

  it("cancels old evidence while waiting for report-aware replacement inventory", async () => {
    const pending = deferred<ReportPage<ReportOverviewAgent>>();
    vi.mocked(api.readReportPage).mockReturnValueOnce(pending.promise);
    const view = render(<AgentInventoryOverview revision={0} inventory={inventory} onUsageChange={vi.fn()} />);
    const signal = vi.mocked(api.readReportPage).mock.lastCall?.[2];
    view.rerender(<AgentInventoryOverview revision={0} inventory={inventory} reportPending onUsageChange={vi.fn()} />);
    expect(signal?.aborted).toBe(true);
    await act(async () => pending.resolve(overviewPage()));
    expect(screen.getByRole("button", { name: "Show reported used agents" })).toHaveTextContent("Waiting for saved inventory");
    expect(screen.getByRole("button", { name: "Show reported used agents" })).toBeDisabled();
    expect(api.readReportPage).toHaveBeenCalledOnce();
    view.rerender(<AgentInventoryOverview revision={1} inventory={inventory} onUsageChange={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Show reported used agents" })).toBeEnabled());
    expect(api.readReportPage).toHaveBeenCalledTimes(2);
    expect(vi.mocked(api.readReportPage).mock.lastCall?.[1]?.selectionId).toBeUndefined();
  });

  it("reuses summary evidence across inventory-only changes and recent remounts, but not report revisions", async () => {
    const client = sharedClient();
    const content = (revision: number, loadingInventory = false) => <QueryClientProvider client={client}>
      <AgentInventoryOverview revision={revision} loadingInventory={loadingInventory}
        inventory={{ ...inventory, usageContext: { ...automaticUsageContext, revision: `inventory-${revision}-${loadingInventory}` } }}
        onUsageChange={vi.fn()} />
    </QueryClientProvider>;
    const view = render(content(0));
    await waitFor(() => expect(screen.getByRole("button", { name: "Show reported used agents" })).toHaveTextContent("50,000"));
    view.rerender(content(0, true));
    view.rerender(content(0));
    expect(api.readReportPage).toHaveBeenCalledOnce();
    view.unmount();
    const remount = render(content(0));
    expect(screen.getByRole("button", { name: "Show reported used agents" })).toHaveTextContent("50,000");
    expect(api.readReportPage).toHaveBeenCalledOnce();
    const pending = deferred<ReportPage<ReportOverviewAgent>>();
    vi.mocked(api.readReportPage).mockReturnValueOnce(pending.promise);
    remount.rerender(content(1));
    const button = screen.getByRole("button", { name: "Show reported used agents" });
    expect(button).toBeEnabled();
    expect(button).toHaveTextContent("50,000");
    expect(api.readReportPage).toHaveBeenCalledTimes(2);
    expect(vi.mocked(api.readReportPage).mock.lastCall?.[1]?.selectionId).toBeUndefined();
    const replacement = overviewPage();
    replacement.analytics.overview!.usedAgents = 123;
    await act(async () => pending.resolve(replacement));
    await waitFor(() => expect(button).toHaveTextContent("123"));
  });

  it.each(["resolve", "reject"] as const)("cancels replaced report reads and ignores their late %s", async outcome => {
    const old = deferred<ReportPage<ReportOverviewAgent>>(), current = deferred<ReportPage<ReportOverviewAgent>>();
    vi.mocked(api.readReportPage).mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    const view = render(<AgentInventoryOverview revision={0} inventory={inventory} onUsageChange={vi.fn()} />);
    const oldSignal = vi.mocked(api.readReportPage).mock.lastCall?.[2];
    const setId = "10000000-0000-4000-8000-000000000099";
    view.rerender(<AgentInventoryOverview revision={0} inventory={{
      ...inventory, usageContext: { ...automaticUsageContext, reports: { ...reports, setId } },
    }} onUsageChange={vi.fn()} />);
    expect(oldSignal?.aborted).toBe(true);
    const button = screen.getByRole("button", { name: "Show reported used agents" });
    expect(button).toBeDisabled();
    const replacement = overviewPage({ reports: { ...reports, setId } });
    replacement.analytics.overview!.usedAgents = 123;
    await act(async () => current.resolve(replacement));
    await waitFor(() => expect(button).toHaveTextContent("123"));
    await act(async () => {
      if (outcome === "resolve") old.resolve(overviewPage());
      else old.reject(new ApiError(409, "selection_invalidated", "Obsolete selection"));
    });
    expect(button).toHaveTextContent("123");
    expect(button).toBeEnabled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(api.readReportPage).toHaveBeenCalledTimes(2);
  });

  it("withdraws and cancels evidence when its inventory disappears", async () => {
    const pending = deferred<ReportPage<ReportOverviewAgent>>();
    vi.mocked(api.readReportPage).mockReturnValueOnce(pending.promise);
    const view = render(<AgentInventoryOverview revision={0} inventory={inventory} onUsageChange={vi.fn()} />);
    const signal = vi.mocked(api.readReportPage).mock.lastCall?.[2];
    view.rerender(<AgentInventoryOverview revision={0} onUsageChange={vi.fn()} />);
    expect(signal?.aborted).toBe(true);
    await act(async () => pending.resolve(overviewPage()));
    expect(screen.getByRole("button", { name: "Show reported used agents" })).toBeDisabled();
    expect(screen.queryByText("Loading selected report evidence...")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(api.readReportPage).toHaveBeenCalledOnce();
  });

  it("shares concurrent overview reads without one observer cancelling the other's request", async () => {
    const client = sharedClient(), pending = deferred<ReportPage<ReportOverviewAgent>>();
    vi.mocked(api.readReportPage).mockReturnValueOnce(pending.promise);
    const content = <QueryClientProvider client={client}>
      <AgentInventoryOverview revision={0} inventory={inventory} onUsageChange={vi.fn()} />
    </QueryClientProvider>;
    const first = render(content), second = render(content);
    expect(api.readReportPage).toHaveBeenCalledOnce();
    const signal = vi.mocked(api.readReportPage).mock.lastCall?.[2];
    first.unmount();
    expect(signal?.aborted).toBe(false);
    await act(async () => pending.resolve(overviewPage()));
    await waitFor(() => expect(screen.getByRole("button", { name: "Show reported used agents" })).toHaveTextContent("50,000"));
    second.unmount();
  });

  it.each(["account", "tenant", "roles"] as const)("fences cached and pending report evidence on a %s change", async change => {
    const client = sharedClient();
    const user: SessionUser = { tenantId: "tenant", homeAccountId: "account", displayName: "Viewer",
      username: "viewer@example.invalid", roles: ["AgentControl.Viewer"] };
    const nextUser = { ...user, ...(change === "account" ? { homeAccountId: "other-account" }
      : change === "tenant" ? { tenantId: "other-tenant" } : { roles: ["AgentControl.Admin"] as SessionUser["roles"] }) };
    const content = (principal: SessionUser) => <QueryClientProvider client={client}><CapabilityContext value={{
      user: principal, views: [], now: Date.now(), pending: false, loading: false, error: undefined, reload: vi.fn(), openPermissions: vi.fn(),
    }}><AgentInventoryOverview revision={0} inventory={inventory} onUsageChange={vi.fn()} /></CapabilityContext></QueryClientProvider>;
    const view = render(content(user));
    await waitFor(() => expect(screen.getByRole("button", { name: "Show reported used agents" })).toHaveTextContent("50,000"));
    const old = deferred<ReportPage<ReportOverviewAgent>>(), replacement = deferred<ReportPage<ReportOverviewAgent>>();
    vi.mocked(api.readReportPage).mockReturnValueOnce(old.promise).mockReturnValueOnce(replacement.promise);
    act(() => window.dispatchEvent(new Event("focus")));
    const oldSignal = vi.mocked(api.readReportPage).mock.lastCall?.[2];
    view.rerender(content(nextUser));
    expect(oldSignal?.aborted).toBe(true);
    const button = screen.getByRole("button", { name: "Show reported used agents" });
    expect(button).toBeDisabled();
    expect(button).not.toHaveTextContent("50,000");
    const data = overviewPage();
    data.analytics.overview!.usedAgents = 123;
    await act(async () => replacement.resolve(data));
    await waitFor(() => expect(button).toHaveTextContent("123"));
    await act(async () => old.reject(new Error("Old principal failed")));
    expect(button).toHaveTextContent("123");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(api.readReportPage).toHaveBeenCalledTimes(3);
  });
});
