import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReportOverviewAgent, ReportPage } from "../../../backend/src/types/officialReportData";
import type { UnifiedAgentInventoryPage } from "../api/client";
import * as api from "../api/reportData";
import { overviewPage, reports } from "../test/reportDataFixture";
import { automaticUsageContext } from "../test/automaticAgentUsageFixture";
import { createUnifiedVerification, inventoryPageMetadata } from "../test/inventoryVerification";
import { deferred } from "../test/deferred";
import { usageAvailabilityLabel, usageCoverageLabel } from "../usageInsights";
import { AgentInventoryOverview } from "./AgentInventoryOverview";

vi.mock("../api/reportData", async original => ({ ...await original<typeof import("../api/reportData")>(), readReportPage: vi.fn() }));
beforeEach(() => { vi.mocked(api.readReportPage).mockResolvedValue(overviewPage()); });
afterEach(() => { cleanup(); vi.resetAllMocks(); });
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
  it("keeps the used shortcut disabled while loading and when there is no selected report", async () => {
    const pending = deferred<ReportPage<ReportOverviewAgent>>();
    vi.mocked(api.readReportPage).mockReturnValue(pending.promise);
    render(<AgentInventoryOverview revision={0} inventory={{ ...inventory, usageContext: {
      ...automaticUsageContext, reports: { ...reports, setId: null, activeSetId: null, availability: "not_selected" },
    } }} onUsageChange={vi.fn()} />);
    const button = screen.getByRole("button", { name: "Show reported used agents" });
    expect(button).toBeDisabled();
    expect(screen.getByText("Loading selected report evidence...")).toHaveClass("sr-only");
    const data = overviewPage({ value: [], reports: { ...reports, setId: null, activeSetId: null, availability: "not_selected" } });
    data.analytics.overview!.retainedSets = 0; data.analytics.overview!.usedAgents = 0;
    await act(async () => pending.resolve(data));
    await waitFor(() => expect(screen.queryByText("Loading selected report evidence...")).not.toBeInTheDocument());
    expect(button).toBeDisabled();
    expect(button).toHaveTextContent("No selected report data");
  });
  it("renders source status beside a provided selector without repeating the selected reporting dates", async () => {
    const view = render(<AgentInventoryOverview revision={0} inventory={inventory} />);
    await screen.findByText(usageCoverageLabel(reports));
    const selector = <select aria-label="Report set"><option>Selected dates</option></select>;
    for (const availability of ["stale", "not_selected", "deleted", "incomplete", "never_imported"] as const) {
      view.rerender(<AgentInventoryOverview revision={0} reportSelector={selector} inventory={{
        ...inventory, usageContext: { ...automaticUsageContext, reports: { ...reports, availability } },
      }} />);
      expect(screen.getByText(usageAvailabilityLabel(availability)).closest(".agent-report-context")).not.toBeNull();
      expect(screen.queryByText(usageCoverageLabel(reports))).not.toBeInTheDocument();
    }
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
});
