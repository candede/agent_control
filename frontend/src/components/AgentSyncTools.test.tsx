import type { ComponentProps, ReactNode } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
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
});
