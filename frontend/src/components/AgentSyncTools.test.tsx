import type { ComponentProps, ReactNode } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { UnifiedAgentInventoryPage } from "../api/client";
import { AgentSyncTools } from "./AgentSyncTools";

vi.mock("../workbenchActionContext", () => ({
  WorkbenchActionGate: ({ children }: { children: ReactNode }) => children,
}));

function props(overrides: Partial<ComponentProps<typeof AgentSyncTools>> = {}): ComponentProps<typeof AgentSyncTools> {
  return {
    selectedPackageCount: 0,
    refreshingPackages: false,
    refreshingPowerPlatform: false,
    exportingPowerPlatform: false,
    onRefreshPackages: vi.fn(),
    onRefreshMatchingDetails: vi.fn(),
    onRefreshPowerPlatform: vi.fn(),
    onResumePowerPlatform: vi.fn(),
    onExportPowerPlatform: vi.fn(),
    onOpenAgents: vi.fn(),
    ...overrides,
  };
}

function inventory(agentCount: number | null = 1246): UnifiedAgentInventoryPage {
  const summary = { total: 2203, linked: 53, graphOnly: 957, powerPlatformOnly: 1193, conflicting: 14, ambiguous: 0 };
  const error = { source: "power_platform" as const, code: "coverage_unknown" as const, message: "Inventory role evidence is unknown." };
  return {
    value: [], count: 2203, offset: 0, limit: 50, summary, filteredSummary: summary,
    identityCollection: { checkedPackages: 1010, pendingPackages: 0 },
    facets: { environments: [], platforms: [] },
    sources: {
      graphPackages: { state: "available", observation: {
        id: "graph-snapshot", snapshotId: "graph-snapshot", current: true, tokenMode: "delegated", scopeKind: "broad",
        observedAt: "2026-09-16T15:14:20Z", expiresAt: "2026-09-23T15:14:20Z", observedCount: 1010, totalRecords: 1010,
      }, error: null },
      powerPlatform: { state: "partial", observation: {
        id: "pp-snapshot", snapshotId: "pp-snapshot", current: true, roleScope: "unknown", environmentScope: null,
        observedAt: "2026-09-16T14:02:57Z", expiresAt: "2026-10-16T14:02:57Z",
        coverage: "unknown", coveredCount: agentCount, observedCount: 4177, totalRecords: 4177,
      }, error },
    },
    partial: true, errors: [error],
  };
}

describe("AgentSyncTools", () => {
  it.each([0, 1, 100, 101])("requires 1-100 exact targets for matching refresh, with %s selected", async count => {
    const actions = props({ selectedPackageCount: count });
    render(<AgentSyncTools {...actions} />);
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

  it("disables competing Graph refreshes while a refresh is in progress", () => {
    render(<AgentSyncTools {...props({ selectedPackageCount: 1, refreshingPackages: true })} />);
    expect(screen.getByRole("button", { name: "Refreshing agents" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Refresh matching details" })).toBeDisabled();
  });

  it("separates completed collection, observed agent counts, role coverage and identity conflicts", () => {
    render(<AgentSyncTools {...props({ inventory: inventory() })} />);
    expect(screen.getByText("Partial unified inventory.")).toBeVisible();
    expect(screen.getByText("Resources collected in saved scope").nextElementSibling).toHaveTextContent("4,177 / 4,177");
    expect(screen.getByText("Copilot Studio agents observed").nextElementSibling).toHaveTextContent("1,246");
    expect(screen.getByText("Provider role scope").nextElementSibling).toHaveTextContent("Unknown");
    expect(screen.getByText("Copilot Studio type coverage").nextElementSibling).toHaveTextContent("Unknown");
    expect(screen.getByText("1,010 package identities checked; 0 still need collection.")).toBeVisible();
    expect(screen.getByText(/not that Microsoft supplied matching identity metadata/)).toBeVisible();
    expect(screen.getByText(/14 conflicting and 0 ambiguous package identities remain unlinked/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Export PP agent inventory CSV" })).toBeEnabled();
  });

  it.each([[null, "Not established"], [0, "0"]] as const)("does not turn unknown agent count %s into a proven zero", (count, text) => {
    render(<AgentSyncTools {...props({ inventory: inventory(count) })} />);
    expect(screen.getByText("Copilot Studio agents observed").nextElementSibling).toHaveTextContent(text);
  });

  it("does not describe an agent-only snapshot as collection of all resource types", () => {
    const saved = inventory();
    const observation = saved.sources.powerPlatform.observation;
    if (!observation) throw new Error("Expected a saved observation");
    observation.observedCount = 1246;
    observation.totalRecords = 1246;
    render(<AgentSyncTools {...props({ inventory: saved })} />);
    expect(screen.getByText("Resources collected in saved scope").nextElementSibling).toHaveTextContent("1,246 / 1,246");
    expect(screen.queryByText("All resource types collected")).not.toBeInTheDocument();
  });
});
