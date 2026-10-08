import { fireEvent, render, screen, within } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { capabilityDefinitions } from "../../../backend/src/services/capabilityRegistry";
import { workbenchActions } from "../../../backend/src/services/workbenchMetadata";
import type { CapabilityView, SessionUser, UnifiedAgentRecord } from "../api/client";
import { CapabilityContext } from "../capabilityContext";
import { quarantineTargetKey } from "../quarantineTarget";
import { UnifiedAgentTable } from "./UnifiedAgentTable";
import { WorkbenchActionProvider } from "../workbenchActionContext";
import { createInventoryVerification } from "../test/inventoryVerification";
import { automaticAgentUsageFixture, automaticUsageContext } from "../test/automaticAgentUsageFixture";
import { usageCoverageLabel } from "../usageInsights";
import { defaultAgentColumnVisibility, loadAgentColumns, saveAgentColumns } from "../agentColumns";
import { projectVerifiedAgentMutation } from "../packageMutationState";

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
});

const packageBase = {
  displayName: "Builder package",
  isBlocked: false,
  sourceSystem: "graph_packages" as const,
  authoringTool: "Agent Builder",
  creatorType: "unknown" as const,
  agentKind: "copilot_package" as const,
  lifecycle: "unknown" as const,
  identityConfidence: "exact_native" as const,
  provenance: {},
};

const record: UnifiedAgentRecord = {
  id: "unified-1",
  displayName: "Builder agent",
  presence: "both",
  environmentId: "11111111-1111-4111-8111-111111111111",
  packages: [
    { ...packageBase, id: "package-1" },
    { ...packageBase, id: "package-2", displayName: "Builder package alternate" },
  ],
  powerPlatformResource: {
    tenantId: "tenant-1",
    nativeId: "agent-1",
    type: "microsoft.copilotstudio/agents",
    location: null,
    displayName: "Builder agent",
    environmentId: "11111111-1111-4111-8111-111111111111",
    createdAt: null,
    createdBy: null,
    lastPublishedAt: null,
    sourceSystem: "power_platform",
    authoringTool: "Agent Builder",
    creatorType: "unknown",
    agentKind: "agent_builder_agent",
    lifecycle: "published",
    identityConfidence: "exact_native",
    identifiers: [
      { kind: "environment_id", value: "11111111-1111-4111-8111-111111111111" },
      { kind: "cds_bot_id", value: "22222222-2222-4222-8222-222222222222" },
    ],
    quarantineIdentity: { environmentId: "11111111-1111-4111-8111-111111111111", botId: "22222222-2222-4222-8222-222222222222" },
    provenance: {},
    details: {},
    unknownFieldCount: 0,
  },
  identity: {
    state: "matched",
    evidence: [{
      kind: "environment_cds_bot_id",
      basis: "source_declared_metadata",
      elementIds: ["metadata-1"],
      packagePath: "elementDetails.AgentMetadatas.SourceIds",
      resourcePath: "environmentId+identifiers.cds_bot_id",
    }],
    packageEvidence: [],
    reason: null,
  },
  observations: {
    graphPackages: {
      id: "package-snapshot",
      snapshotId: "package-snapshot",
      observedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      current: true,
      tokenMode: "delegated",
      scopeKind: "broad",
      observedCount: 2,
      totalRecords: 2,
    },
    packageSnapshots: {},
    powerPlatform: {
      id: "inventory-snapshot",
      snapshotId: "inventory-snapshot",
      pageCount: 1,
      verification: createInventoryVerification(1),
      observedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      current: true,
      roleScope: "ai",
      environmentScope: null,
      coverage: "covered",
      coveredCount: 1,
      observedCount: 1,
      totalRecords: 1,
    },
  },
};

const selectedResourceKey = quarantineTargetKey(record.powerPlatformResource!);

const user: SessionUser = {
  homeAccountId: "admin-1", displayName: "Admin", username: "admin@example.invalid", roles: ["AgentControl.Admin"],
};

function capabilities(): CapabilityView[] {
  return capabilityDefinitions.filter(item => ["graph.package.block.manage", "graph.package.access.manage"].includes(item.id)).map(definition => ({
    definition,
    decision: {
      capabilityId: definition.id, status: "available", authorized: true, fresh: true,
      verification: "on_demand", previewQualification: "not_required", remediation: [],
    },
  }));
}

function renderTable(overrides: Partial<ComponentProps<typeof UnifiedAgentTable>> = {}, views = capabilities(), actions = workbenchActions) {
  const props = {
    records: [record], selectedPackageIds: new Set<string>(), selectedPowerPlatformKeys: new Set<string>(),
    selectedPackageCount: overrides.selectedPackageIds?.size ?? 0, allPackagesSelected: false,
    packageSelectionAllowed: true, packageOperationsAllowed: true, quarantineSelectionAllowed: true, selectionDisabled: false,
    onToggleSelection: vi.fn(), onViewDetails: vi.fn(), onManageAccess: vi.fn(), onSetBlocked: vi.fn(),
    ...overrides,
  };
  const content = (next: Partial<typeof props> = {}) => <CapabilityContext value={{
    views, user, now: Date.now(), loading: false, pending: false, error: undefined, reload: vi.fn(), openPermissions: vi.fn(),
  }}><WorkbenchActionProvider value={actions}><UnifiedAgentTable {...props} {...next}
    selectedPackageCount={next.selectedPackageCount ?? next.selectedPackageIds?.size ?? props.selectedPackageCount}
    /></WorkbenchActionProvider></CapabilityContext>;
  const result = render(content());
  return { ...result, props, update: (next: Partial<typeof props>) => result.rerender(content(next)) };
}

describe("UnifiedAgentTable", () => {
  it.each([false, true])("shows all 5000 server-counted group targets with all-matching mode %s", allPackagesSelected => {
    const { props } = renderTable({ records: [{ ...record, packages: [record.packages[0]], packageCount: 5_000, packagesComplete: false }],
      quarantineSelectionAllowed: false, selectedPackageCount: 5_000, allPackagesSelected,
      selectedRecordIds: allPackagesSelected ? undefined : new Set([record.id]) });
    expect(screen.getByText("5000 published versions selected")).toBeVisible();
    const checkbox = screen.getByRole("checkbox", { name: `Select ${record.displayName}` });
    expect(checkbox).toBeChecked();
    if (allPackagesSelected) {
      expect(checkbox).toBeDisabled();
      expect(checkbox).toHaveAttribute("title", "Clear the all-matching package selection before selecting individual agent targets.");
      fireEvent.click(checkbox);
      expect(props.onToggleSelection).not.toHaveBeenCalled();
    } else expect(checkbox).toBeEnabled();
  });

  it("keeps exact package actions available while changing selection is disabled for a saved-data refresh", () => {
    const singlePackage = { ...record, packages: [record.packages[0]] };
    const { props, update } = renderTable({ records: [singlePackage], selectionDisabled: true, packageActionsDisabled: false });
    expect(screen.getByRole("checkbox", { name: `Select ${record.displayName}` })).toBeDisabled();
    const block = screen.getByRole("button", { name: `Block ${record.displayName}` });
    const access = screen.getByRole("button", { name: `Manage access for ${record.displayName}` });
    expect(block).toBeEnabled();
    expect(access).toBeEnabled();
    fireEvent.click(block);
    fireEvent.click(access);
    expect(props.onSetBlocked).toHaveBeenCalledWith(singlePackage, true);
    expect(props.onManageAccess).toHaveBeenCalledWith(singlePackage);
    update({ packageActionsDisabled: true });
    expect(block).toBeDisabled();
    expect(access).toBeDisabled();
  });

  it("shows and hides columns, preserves mandatory identity, and resets defaults", () => {
    renderTable({ records: [{ ...record, packages: record.packages.map(item => ({ ...item, supportedHosts: ["Teams", "Copilot"] })) }] });
    fireEvent.click(screen.getByRole("button", { name: "Columns" }));
    const picker = screen.getByRole("dialog", { name: "Choose agent columns" });
    expect(within(picker).getByRole("checkbox", { name: "Agent Always shown" })).toBeDisabled();
    fireEvent.click(within(picker).getByRole("checkbox", { name: "Hosts" }));
    expect(screen.getByRole("columnheader", { name: "Hosts" })).toBeInTheDocument();
    expect(screen.getByText("Copilot / Teams")).toBeInTheDocument();
    fireEvent.click(within(picker).getByRole("checkbox", { name: "Environment" }));
    expect(screen.getByRole("columnheader", { name: "Environment" })).toBeInTheDocument();
    fireEvent.click(within(picker).getByRole("checkbox", { name: "Publisher" }));
    fireEvent.click(within(picker).getByRole("checkbox", { name: "Responses" }));
    expect(screen.queryByRole("columnheader", { name: "Publisher" })).not.toBeInTheDocument();
    expect(screen.queryByRole("columnheader", { name: "Responses" })).not.toBeInTheDocument();
    fireEvent.click(within(picker).getByRole("button", { name: "Reset defaults" }));
    expect(screen.queryByRole("columnheader", { name: "Hosts" })).not.toBeInTheDocument();
    expect(screen.queryByRole("columnheader", { name: "Environment" })).not.toBeInTheDocument();
    expect(screen.getAllByRole("columnheader").map(header => header.textContent)).toEqual([
      "Select agents", "Agent", "Publisher", "Built with", "Responses", "End-user access", "Status", "Actions",
    ]);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Choose agent columns" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Columns" })).toHaveFocus();
  });

  it("requests server sorting without reordering the supplied page and updates accessible sort state", () => {
    const onSortChange = vi.fn();
    const { update } = renderTable({ onSortChange, sortBy: "displayName", sortDirection: "asc", records: [
      { ...record, id: "agent-z", displayName: "Zulu" },
      { ...record, id: "agent-a", displayName: "Alpha" },
    ] });
    expect(screen.getAllByRole("button", { name: /^(Zulu|Alpha)$/ }).map(element => element.textContent)).toEqual(["Zulu", "Alpha"]);
    fireEvent.click(screen.getByRole("button", { name: "Sort by Agent" }));
    expect(onSortChange).toHaveBeenCalledWith("displayName", "desc");
    update({ sortDirection: "desc" });
    expect(screen.getByRole("columnheader", { name: "Agent" })).toHaveAttribute("aria-sort", "descending");
    fireEvent.click(screen.getByRole("button", { name: "Sort by Responses" }));
    expect(onSortChange).toHaveBeenLastCalledWith("responses", "desc");
  });

  it("switches account and tenant column preferences without requesting data or changing sort", () => {
    const owner = JSON.stringify(["tenant-a", "user-a"]);
    const otherAccount = JSON.stringify(["tenant-a", "user-b"]);
    const otherTenant = JSON.stringify(["tenant-b", "user-a"]);
    saveAgentColumns(owner, { ...defaultAgentColumnVisibility, hosts: true });
    saveAgentColumns(otherAccount, { ...defaultAgentColumnVisibility, publisher: false });
    const fetch = vi.spyOn(globalThis, "fetch");
    const onSortChange = vi.fn();
    const { update, props } = renderTable({ columnPreferenceOwner: owner, onSortChange });
    expect(screen.getByRole("columnheader", { name: "Hosts" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Columns" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Environment" }));
    update({ columnPreferenceOwner: otherAccount });
    expect(screen.queryByRole("columnheader", { name: "Hosts" })).not.toBeInTheDocument();
    expect(screen.queryByRole("columnheader", { name: "Environment" })).not.toBeInTheDocument();
    expect(screen.queryByRole("columnheader", { name: "Publisher" })).not.toBeInTheDocument();
    update({ columnPreferenceOwner: otherTenant });
    expect(screen.getByRole("columnheader", { name: "Publisher" })).toBeVisible();
    update({ columnPreferenceOwner: owner });
    expect(screen.getByRole("columnheader", { name: "Hosts" })).toBeVisible();
    expect(screen.getByRole("columnheader", { name: "Environment" })).toBeVisible();
    update({ columnPreferenceOwner: undefined });
    expect(screen.queryByRole("columnheader", { name: "Hosts" })).not.toBeInTheDocument();
    expect(screen.queryByRole("columnheader", { name: "Environment" })).not.toBeInTheDocument();
    expect(loadAgentColumns(otherAccount).visibility.publisher).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
    expect(onSortChange).not.toHaveBeenCalled();
    expect(props.onToggleSelection).not.toHaveBeenCalled();
    expect(props.onViewDetails).not.toHaveBeenCalled();
    expect(props.onManageAccess).not.toHaveBeenCalled();
    expect(props.onSetBlocked).not.toHaveBeenCalled();
  });

  it("shows unsaved column choices with a warning, without carrying them to another account", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new DOMException("Full", "QuotaExceededError"); });
    const { update } = renderTable({ columnPreferenceOwner: "owner-a" });
    fireEvent.click(screen.getByRole("button", { name: "Columns" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Hosts" }));
    expect(screen.getByRole("columnheader", { name: "Hosts" })).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent("Column preferences could not be saved.");
    update({ columnPreferenceOwner: "owner-b" });
    expect(screen.queryByRole("columnheader", { name: "Hosts" })).not.toBeInTheDocument();
    expect(screen.queryByText(/Column preferences could not be saved/)).not.toBeInTheDocument();
  });

  it.each([
    JSON.stringify(["tenant-a", "user-b"]),
    JSON.stringify(["tenant-b", "user-a"]),
    undefined,
  ])("retires the open column picker and its search when the preference owner changes to %s", nextOwner => {
    const { update } = renderTable({ columnPreferenceOwner: JSON.stringify(["tenant-a", "user-a"]) });
    fireEvent.click(screen.getByRole("button", { name: "Columns" }));
    const search = screen.getByRole("searchbox", { name: "Find columns" });
    fireEvent.change(search, { target: { value: "Hosts" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Hosts" }));
    update({ records: [{ ...record, displayName: "Updated agent" }] });
    expect(screen.getByRole("searchbox", { name: "Find columns" })).toBe(search);
    expect(search).toHaveValue("Hosts");
    expect(screen.getByRole("columnheader", { name: "Hosts" })).toBeVisible();
    update({ columnPreferenceOwner: nextOwner });
    expect(screen.queryByRole("dialog", { name: "Choose agent columns" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Columns" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("columnheader", { name: "Hosts" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Columns" }));
    expect(screen.getByRole("searchbox", { name: "Find columns" })).toHaveValue("");
    expect(screen.getByRole("checkbox", { name: "Publisher" })).toBeChecked();
  });

  it("keeps column choices through loading and replacement rows without duplicate storage or data requests", () => {
    const get = vi.spyOn(Storage.prototype, "getItem");
    const set = vi.spyOn(Storage.prototype, "setItem");
    const fetch = vi.spyOn(globalThis, "fetch");
    const onSortChange = vi.fn();
    const { update } = renderTable({ columnPreferenceOwner: "owner", onSortChange });
    expect(get).toHaveBeenCalledTimes(1);
    expect(set).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Columns" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Hosts" }));
    expect(set).toHaveBeenCalledTimes(1);
    update({ records: [], loading: true });
    expect(screen.getByRole("status")).toHaveTextContent("Loading Copilot agents...");
    expect(screen.getByRole("checkbox", { name: "Hosts" })).toBeChecked();
    fireEvent.click(screen.getByRole("checkbox", { name: "Environment" }));
    expect(set).toHaveBeenCalledTimes(2);
    update({ records: [{ ...record, displayName: "Replacement agent" }], loading: false });
    expect(screen.getByRole("columnheader", { name: "Hosts" })).toBeVisible();
    expect(screen.getByRole("columnheader", { name: "Environment" })).toBeVisible();
    expect(screen.queryByText("Loading Copilot agents...")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Reset defaults" }));
    expect(set).toHaveBeenCalledTimes(3);
    expect(screen.queryByRole("columnheader", { name: "Hosts" })).not.toBeInTheDocument();
    expect(screen.queryByRole("columnheader", { name: "Environment" })).not.toBeInTheDocument();
    expect(get).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
    expect(onSortChange).not.toHaveBeenCalled();
  });

  it("keeps storage failures visible until an explicit successful save, without blocking column changes", () => {
    saveAgentColumns("owner", defaultAgentColumnVisibility);
    const key = window.localStorage.key(0)!;
    window.localStorage.setItem(key, "{");
    const set = vi.spyOn(Storage.prototype, "setItem").mockImplementationOnce(() => {
      throw new DOMException("Full", "QuotaExceededError");
    });
    const { update } = renderTable({ columnPreferenceOwner: "owner" });
    expect(screen.getByRole("status")).toHaveTextContent("Column preferences could not be loaded. Default columns are shown.");
    expect(set).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(key)).toBe("{");
    fireEvent.click(screen.getByRole("button", { name: "Columns" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Hosts" }));
    expect(screen.getByRole("columnheader", { name: "Hosts" })).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent("Column preferences could not be saved.");
    update({ records: [] });
    expect(screen.getByRole("status")).toHaveTextContent("Column preferences could not be saved.");
    expect(screen.getByRole("checkbox", { name: "Hosts" })).toBeChecked();
    expect(set).toHaveBeenCalledTimes(1);
    expect(window.localStorage.getItem(key)).toBe("{");
    fireEvent.click(screen.getByRole("button", { name: "Reset defaults" }));
    expect(set).toHaveBeenCalledTimes(2);
    expect(loadAgentColumns("owner")).toEqual({ visibility: defaultAgentColumnVisibility });
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("preserves mounted controls and uses current callbacks after a parent render", () => {
    const { update, props } = renderTable();
    const checkbox = screen.getByRole("checkbox", { name: `Select ${record.displayName}` });
    const detail = screen.getByRole("button", { name: record.displayName });
    detail.focus();
    const onToggleSelection = vi.fn();
    const onViewDetails = vi.fn();
    update({ onToggleSelection, onViewDetails, selectedPackageIds: new Set([record.packages[0].id]) });
    expect(screen.getByRole("checkbox", { name: `Select ${record.displayName}` })).toBe(checkbox);
    expect(screen.getByRole("button", { name: record.displayName })).toBe(detail);
    expect(detail).toHaveFocus();
    fireEvent.click(checkbox);
    fireEvent.click(detail);
    expect(onToggleSelection).toHaveBeenCalledWith(record);
    expect(onViewDetails).toHaveBeenCalledWith(record);
    expect(props.onToggleSelection).not.toHaveBeenCalled();
    expect(props.onViewDetails).not.toHaveBeenCalled();
  });

  it("keeps zero responses distinct from unlinked usage and makes columns available for an empty view", () => {
    const { update } = renderTable({ usageContext: automaticUsageContext, records: [{
      ...record,
      usage: automaticAgentUsageFixture({ responses: 0, activeUsers: 0, lastActivityDateUtc: null }),
    }] });
    expect(screen.getByRole("cell", { name: "0" })).toBeInTheDocument();
    update({ records: [record] });
    expect(screen.getByRole("cell", { name: "Unavailable" })).toBeInTheDocument();
    update({ records: [] });
    expect(screen.getByRole("heading", { name: "No matching agents" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Columns" })).toBeEnabled();
  });

  it.each([false, true])("shows report values only for an available matching snapshot (projected=%s)", projected => {
    const usage = automaticAgentUsageFixture();
    const { update } = renderTable({
      records: [{
        ...record, usage,
        ...(projected ? { columns: { responses: usage.responses, activeUsers: usage.activeUsers,
          lastActivity: Date.parse(usage.lastActivityDateUtc!) } } : {}),
      }], usageContext: automaticUsageContext,
    });
    fireEvent.click(screen.getByRole("button", { name: "Columns" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Active users" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Last used" }));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.getByRole("cell", { name: "181" })).toBeVisible();
    expect(screen.getByRole("cell", { name: "7" })).toBeVisible();
    expect(document.querySelector("time")).toHaveAttribute("datetime", usage.lastActivityDateUtc);
    const range = screen.getByText(usageCoverageLabel(automaticUsageContext.reports));
    expect(range.closest(".agent-grid-toolbar")).not.toBeNull();
    expect(screen.queryByText(/Usage covers the selected Microsoft 365 report/)).not.toBeInTheDocument();
    expect(screen.queryByText("Selected report.")).not.toBeInTheDocument();
    update({ usageContext: { ...automaticUsageContext, reports: { ...automaticUsageContext.reports, setId: "different-snapshot" } } });
    expect(screen.getAllByRole("cell", { name: "Unavailable" })).toHaveLength(3);
    expect(screen.queryByRole("cell", { name: "181" })).not.toBeInTheDocument();
    update({ usageContext: undefined });
    expect(screen.getAllByRole("cell", { name: "Unavailable" })).toHaveLength(3);
    update({ usageContext: { ...automaticUsageContext, reports: { ...automaticUsageContext.reports, availability: "deleted" } } });
    expect(screen.getAllByRole("cell", { name: "Unavailable" })).toHaveLength(3);
    update({ usageContext: { ...automaticUsageContext, reports: { ...automaticUsageContext.reports, availability: "stale" } } });
    expect(screen.getByRole("cell", { name: "181" })).toBeVisible();
  });

  it("leaves report context to the overview when embedded with inventory controls", () => {
    const { update } = renderTable({
      controls: <section aria-label="Filters">Inventory controls</section>,
      records: [{ ...record, usage: automaticAgentUsageFixture() }], usageContext: automaticUsageContext,
    });
    expect(screen.getByRole("cell", { name: "181" })).toBeVisible();
    expect(document.querySelector(".agent-report-note")).toBeNull();
    expect(screen.queryByText(usageCoverageLabel(automaticUsageContext.reports))).not.toBeInTheDocument();
    update({ controls: undefined });
    expect(screen.getByText(usageCoverageLabel(automaticUsageContext.reports))).toBeVisible();
  });

  it("surfaces malformed optional timestamps without crashing the table or inventing dates", () => {
    renderTable({ records: [{ ...record, packages: [{ ...record.packages[0], lastModifiedDateTime: "not a date" }] }] });
    fireEvent.click(screen.getByRole("button", { name: "Columns" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Modified" }));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.getByText("Invalid saved value")).toHaveAttribute("role", "status");
    expect(screen.getByText("Invalid saved value")).toHaveAttribute("title", "Saved agent inventory contains an invalid timestamp.");
    expect(screen.getByRole("button", { name: record.displayName })).toBeEnabled();
  });

  it("does not repeat the authoring tool because its sources use different spelling", () => {
    renderTable({
      records: [{
        ...record,
        packages: record.packages.map(item => ({ ...item, authoringTool: "CopilotStudio" })),
        powerPlatformResource: { ...record.powerPlatformResource!, authoringTool: "Copilot Studio" },
      }],
    });
    expect(screen.getAllByText("Copilot Studio")).toHaveLength(1);
    expect(screen.queryByText("Copilot Studio / CopilotStudio")).not.toBeInTheDocument();
  });

  it("renders one logical agent with friendly columns, one checkbox, and one detail entry point", () => {
    const { props } = renderTable({
      environmentNames: { [record.environmentId!]: "Production" },
      records: [{ ...record, packages: record.packages.map(item => ({ ...item, publisher: "Synthetic publisher" })) }],
    });
    expect(screen.getByRole("region", { name: "Unified agents" })).toContainElement(screen.getByRole("table"));
    expect(screen.getAllByRole("row")).toHaveLength(2);
    expect(screen.getAllByRole("columnheader").map(header => header.textContent)).toEqual([
      "Select agents", "Agent", "Publisher", "Built with", "Responses", "End-user access", "Status", "Actions",
    ]);
    expect(screen.getAllByRole("checkbox")).toHaveLength(1);
    expect(screen.getByText("Synthetic publisher")).toBeInTheDocument();
    expect(screen.queryByText("Production")).not.toBeInTheDocument();
    expect(screen.getAllByText("Agent Builder")).toHaveLength(1);
    expect(screen.queryByText(/Graph|Linked by|No verified link|exact quarantine target/)).not.toBeInTheDocument();
    expect(screen.queryByText(/0 .*selected/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Builder agent" }));
    expect(props.onToggleSelection).toHaveBeenCalledExactlyOnceWith(props.records[0]);
    fireEvent.click(screen.getByRole("button", { name: "View details for Builder agent" }));
    expect(props.onViewDetails).toHaveBeenCalledExactlyOnceWith(props.records[0]);
    expect(screen.queryByRole("button", { name: "Manage Builder agent" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Manage access|^Block / })).not.toBeInTheDocument();
  });

  it("computes checked and mixed state over all exact package and quarantine targets", () => {
    const { update } = renderTable();
    const checkbox = screen.getByRole("checkbox");
    expect(checkbox).not.toBeChecked();
    expect(checkbox).not.toBePartiallyChecked();
    update({ selectedPackageIds: new Set(["package-1"]) });
    expect(checkbox).toBePartiallyChecked();
    update({ selectedPackageIds: new Set(["package-1", "package-2"]) });
    expect(checkbox).toBePartiallyChecked();
    update({ selectedPowerPlatformKeys: new Set([selectedResourceKey]) });
    expect(checkbox).toBePartiallyChecked();
    update({ selectedPackageIds: new Set(["package-1", "package-2"]), selectedPowerPlatformKeys: new Set([selectedResourceKey]) });
    expect(checkbox).toBeChecked();
    expect(checkbox).not.toBePartiallyChecked();
    expect(screen.getByText("1 agent selected on this page")).toBeInTheDocument();
    update({ selectedPackageIds: new Set(), selectedPowerPlatformKeys: new Set() });
    expect(checkbox).not.toBeChecked();
    expect(checkbox).not.toBePartiallyChecked();
  });

  it("preserves mixed selection when the parent declines a target change", () => {
    const { props, update } = renderTable({ selectedPackageIds: new Set(["package-1"]) });
    const checkbox = screen.getByRole("checkbox");
    expect(checkbox).toBePartiallyChecked();
    fireEvent.click(checkbox);
    expect(props.onToggleSelection).toHaveBeenCalledExactlyOnceWith(record);
    expect(checkbox).toBePartiallyChecked();
    update({ records: [...props.records] });
    expect(checkbox).toBePartiallyChecked();
    update({ selectedPackageIds: new Set(["package-1", "package-2"]), selectedPowerPlatformKeys: new Set([selectedResourceKey]) });
    expect(checkbox).toBeChecked();
    expect(checkbox).not.toBePartiallyChecked();
    update({ selectedPackageIds: new Set(), selectedPowerPlatformKeys: new Set() });
    expect(checkbox).not.toBeChecked();
    expect(checkbox).not.toBePartiallyChecked();
  });

  it.each([
    { packageSelectionAllowed: false, quarantineSelectionAllowed: true, checked: true },
    { packageSelectionAllowed: true, quarantineSelectionAllowed: false, checked: true },
    { packageSelectionAllowed: false, quarantineSelectionAllowed: false, checked: false },
  ])("counts only selectable targets with flags $packageSelectionAllowed/$quarantineSelectionAllowed", flags => {
    const { props } = renderTable({
      ...flags, selectedPackageIds: new Set(["package-1", "package-2"]), selectedPowerPlatformKeys: new Set([selectedResourceKey]),
    });
    const checkbox = screen.getByRole("checkbox");
    expect(checkbox).toHaveProperty("checked", flags.checked);
    expect(checkbox).not.toBePartiallyChecked();
    expect(checkbox).toHaveProperty("disabled", !flags.checked);
    fireEvent.click(checkbox);
    expect(props.onToggleSelection).toHaveBeenCalledTimes(flags.checked ? 1 : 0);
  });

  it("ignores previously selected targets when their selection permission is removed", () => {
    const { update } = renderTable({ selectedPackageIds: new Set(["package-1"]), selectedPowerPlatformKeys: new Set([selectedResourceKey]) });
    expect(screen.getByRole("checkbox")).toBePartiallyChecked();
    update({ packageSelectionAllowed: false });
    expect(screen.getByRole("checkbox")).toBeChecked();
    update({ quarantineSelectionAllowed: false });
    expect(screen.getByRole("checkbox")).toBePartiallyChecked();
  });

  it("disables selection and writes while busy, without disabling details", () => {
    const single = { ...record, packages: [record.packages[0]] };
    const { props } = renderTable({
      records: [single], selectionDisabled: true, selectedPackageIds: new Set(["package-1"]), selectedPowerPlatformKeys: new Set([selectedResourceKey]),
    });
    expect(screen.getByRole("checkbox")).toBeChecked();
    expect(screen.getByRole("checkbox")).toBeDisabled();
    for (const name of ["Manage access for Builder agent", "Block Builder agent"]) {
      const button = screen.getByRole("button", { name });
      expect(button).toBeDisabled();
      fireEvent.click(button);
    }
    fireEvent.click(screen.getByRole("checkbox"));
    expect(props.onToggleSelection).not.toHaveBeenCalled();
    expect(props.onManageAccess).not.toHaveBeenCalled();
    expect(props.onSetBlocked).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /View details/ })).toBeEnabled();
  });

  it("waits for bookmarked native selection without blocking saved details or package controls", () => {
    const single = { ...record, packages: [record.packages[0]] };
    const { props, update } = renderTable({ records: [single], quarantineSelectionRestoring: true });
    expect(screen.getByRole("checkbox")).toBeDisabled();
    expect(screen.getByRole("checkbox")).toHaveAttribute("title", expect.stringContaining("Restoring saved quarantine selections"));
    expect(screen.getByRole("button", { name: "View details for Builder agent" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Manage access for Builder agent" })).toBeEnabled();
    fireEvent.click(screen.getByRole("checkbox"));
    expect(props.onToggleSelection).not.toHaveBeenCalled();
    update({ records: [{ ...single, powerPlatformResource: null }] });
    expect(screen.getByRole("checkbox")).toBeEnabled();
  });

  it.each(["missing-snapshot", "stale-snapshot", "missing-bot", "invalid-environment", "duplicate-bot"] as const)(
    "excludes an ineligible quarantine target (%s), while retaining exact package selection", scenario => {
      const resource = { ...record.powerPlatformResource! };
      let snapshot = record.observations.powerPlatform;
      if (scenario === "missing-snapshot") snapshot = null;
      if (scenario === "stale-snapshot") snapshot = { ...snapshot!, expiresAt: "2020-01-01T00:00:00Z" };
      if (scenario === "missing-bot") resource.identifiers = resource.identifiers.filter(item => item.kind !== "cds_bot_id");
      if (scenario === "invalid-environment") resource.environmentId = "not-an-environment-id";
      if (scenario === "duplicate-bot") resource.identifiers = [...resource.identifiers, { kind: "cds_bot_id", value: "33333333-3333-4333-8333-333333333333" }];
      if (scenario === "missing-bot" || scenario === "duplicate-bot") resource.quarantineIdentity = null;
      const invalid = { ...record, powerPlatformResource: resource, observations: { ...record.observations, powerPlatform: snapshot } };
      const { update } = renderTable({ records: [invalid], selectedPackageIds: new Set(["package-1", "package-2"]), selectedPowerPlatformKeys: new Set([selectedResourceKey]) });
      expect(screen.getByRole("checkbox")).toBeChecked();
      expect(screen.getByRole("checkbox")).toBeEnabled();
      update({ records: [{ ...invalid, packages: [] }] });
      expect(screen.getByRole("checkbox")).toBeDisabled();
      expect(screen.getByRole("checkbox")).not.toBeChecked();
      expect(screen.getByRole("button", { name: "View details for Builder agent" })).toBeEnabled();
    },
  );

  it("keeps identical names and native IDs distinct across environment-scoped records", () => {
    const secondEnvironment = "33333333-3333-4333-8333-333333333333";
    const second: UnifiedAgentRecord = {
      ...record, id: "unified-2", environmentId: secondEnvironment, packages: [],
      powerPlatformResource: {
        ...record.powerPlatformResource!, environmentId: secondEnvironment,
        quarantineIdentity: { ...record.powerPlatformResource!.quarantineIdentity!, environmentId: secondEnvironment },
        identifiers: record.powerPlatformResource!.identifiers.map(item => item.kind === "environment_id" ? { ...item, value: secondEnvironment } : item),
      },
    };
    const { props } = renderTable({
      records: [{ ...record, packages: [] }, second], selectedPowerPlatformKeys: new Set([selectedResourceKey]),
    });
    expect(screen.getAllByRole("row")).toHaveLength(3);
    const checkboxes = within(screen.getByRole("region", { name: "Unified agents" })).getAllByRole("checkbox", { name: "Select Builder agent" });
    expect(checkboxes[0]).toBeChecked();
    expect(checkboxes[1]).not.toBeChecked();
    fireEvent.click(checkboxes[1]);
    expect(props.onToggleSelection).toHaveBeenCalledExactlyOnceWith(second);
    fireEvent.click(screen.getAllByRole("button", { name: "View details for Builder agent" })[1]);
    expect(props.onViewDetails).toHaveBeenCalledExactlyOnceWith(second);
  });

  it.each([false, true])("uses only backend-supplied quarantine identifiers, not schema/native evidence (supplied=%s)", supplied => {
    const resource = record.powerPlatformResource!;
    const evidence: UnifiedAgentRecord["identity"]["evidence"] = [{
      kind: "environment_schema_native_id", basis: "source_declared_metadata", elementIds: ["metadata-1"],
      packagePath: "elementDetails.AgentMetadatas.definition.SourceIds.EnvironmentId + SourceIds.SchemaName + SourceIds.CdsBotId",
      resourcePath: "environmentId + details.schemaName + nativeId",
    }];
    renderTable({
      packageSelectionAllowed: false,
      records: [{
        ...record,
        powerPlatformResource: {
          ...resource, nativeId: "22222222-2222-4222-8222-222222222222", details: { schemaName: "verified-schema" },
          identifiers: resource.identifiers.filter(item => supplied || item.kind !== "cds_bot_id"),
          quarantineIdentity: supplied ? resource.quarantineIdentity : null,
        },
        identity: { state: "matched", evidence, packageEvidence: [{ packageId: "package-1", evidence }], reason: null },
      }],
    });
    expect(screen.getByRole("checkbox")).toHaveProperty("disabled", !supplied);
    expect(screen.queryByText(/schema|native|source metadata/i)).not.toBeInTheDocument();
  });

  it("keeps exact native selection across canonical row IDs without selecting newly linked packages", () => {
    const initial = { ...record, id: "agent:33333333-3333-4333-8333-333333333333", packages: [] };
    const merged = { ...record, id: "agent:44444444-4444-4444-8444-444444444444" };
    const { update, props } = renderTable({ records: [initial], selectedPowerPlatformKeys: new Set([selectedResourceKey]) });
    expect(screen.getByRole("checkbox")).toBeChecked();
    update({ records: [merged] });
    expect(screen.getByRole("checkbox")).toBePartiallyChecked();
    fireEvent.click(screen.getByRole("checkbox"));
    expect(props.onToggleSelection).toHaveBeenCalledExactlyOnceWith(merged);
    update({ records: [merged], selectedPackageIds: new Set(merged.packages.map(item => item.id)) });
    expect(screen.getByRole("checkbox")).toBeChecked();
    expect(screen.getByText("1 exact quarantine target selected")).toBeVisible();
  });

  it("retains every linked manifest package without promoting a Builder native ID to a quarantine target", () => {
    const manifestId = "44444444-4444-4444-8444-444444444444";
    const builder: UnifiedAgentRecord = {
      ...record,
      packages: record.packages.map(item => ({ ...item, manifestId })),
      powerPlatformResource: {
        ...record.powerPlatformResource!,
        nativeId: manifestId,
        details: { schemaName: manifestId },
        identifiers: [{ kind: "environment_id", value: record.environmentId! }],
        quarantineIdentity: null,
      },
    };
    renderTable({ records: [builder], selectedPackageIds: new Set(builder.packages.map(item => item.id)) });
    expect(screen.getByRole("checkbox")).toBeChecked();
    expect(screen.getByText("2 published versions selected")).toBeVisible();
    expect(screen.queryByText(/exact quarantine target selected/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "View details for Builder agent" })).toBeEnabled();
  });

  it("uses the explicit native control summary without treating the bounded identifier preview as complete", () => {
    const selected: UnifiedAgentRecord = { ...record, packages: [], powerPlatformResource: {
      ...record.powerPlatformResource!, identifiers: [], identifierCount: 9000, identifiersComplete: false,
    } };
    const { props } = renderTable({ records: [selected], packageSelectionAllowed: false });
    const checkbox = screen.getByRole("checkbox");
    expect(checkbox).toBeEnabled();
    fireEvent.click(checkbox);
    expect(props.onToggleSelection).toHaveBeenCalledExactlyOnceWith(selected);
  });

  it.each([null, record.environmentId])("renders one graph-only group with all package selections and optional environment %s", environmentId => {
    const group: UnifiedAgentRecord = {
      ...record, id: "agent:33333333-3333-4333-8333-333333333333",
      presence: "graph_packages", environmentId, powerPlatformResource: null,
      identity: { state: "unmatched", evidence: [], packageEvidence: [], reason: "No verified Power Platform counterpart." },
    };
    const { props } = renderTable({
      records: [group], selectedPackageIds: new Set(group.packages.map(item => item.id)),
      environmentNames: { [record.environmentId!]: "Package-declared environment" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Columns" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Environment" }));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.getAllByRole("row")).toHaveLength(2);
    expect(screen.getByRole("checkbox")).toBeChecked();
    expect(screen.getByText("2 published versions selected")).toBeVisible();
    expect(within(screen.getAllByRole("row")[1]).getAllByRole("cell")[3]).toHaveTextContent(environmentId ? "Package-declared environment" : "Unknown");
    expect(screen.queryByText(/exact quarantine target selected/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "View details for Builder agent" }));
    expect(props.onViewDetails).toHaveBeenCalledExactlyOnceWith(group);
  });

  it("uses lowercase environment lookup keys with an honest ID fallback", () => {
    const { update } = renderTable({ records: [{ ...record, environmentId: "ENVIRONMENT-A" }], environmentNames: { "environment-a": "Friendly environment" } });
    fireEvent.click(screen.getByRole("button", { name: "Columns" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Environment" }));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.getByText("Friendly environment")).toBeInTheDocument();
    update({ environmentNames: {} });
    expect(screen.getByText("ENVIRONMENT-A")).toBeInTheDocument();
  });

  it("does not infer availability, blocking, quarantine or authoring from a published resource", () => {
    renderTable({ records: [{ ...record, packages: [], powerPlatformResource: { ...record.powerPlatformResource!, authoringTool: null, details: { createdIn: "FutureProvider.vNext_build-X" } } }] });
    const cells = within(screen.getAllByRole("row")[1]).getAllByRole("cell");
    expect(cells[3]).toHaveTextContent(/^Unknown$/);
    expect(cells[5]).toHaveTextContent(/^Unknown$/);
    expect(cells[6]).toHaveTextContent("Published");
    expect(cells[6]).toHaveTextContent("Quarantine status unknown");
    expect(cells[6]).not.toHaveTextContent(/Active|Allowed|Not blocked|Not quarantined/);
  });

  it("keeps unknown publication and unmatched package metadata honest without source-link clutter", () => {
    renderTable({ records: [{
      ...record, environmentId: null, powerPlatformResource: { ...record.powerPlatformResource!, lifecycle: "unknown" },
      identity: { state: "unmatched", evidence: [], packageEvidence: [], reason: "Matching metadata has not been observed." },
    }] });
    expect(screen.getByText("Publication status unknown")).toBeInTheDocument();
    expect(screen.queryByText(/Active|All allowed|counterpart missing|No verified link/i)).not.toBeInTheDocument();
  });

  it("shows the widest confirmed unblocked user scope without inventing unknown access", () => {
    const { update } = renderTable({
      records: [{ ...record, packages: record.packages.map(item => ({ ...item, availableTo: "allowedForAll" })) }],
    });
    expect(screen.getByText("All users")).toBeInTheDocument();
    update({ records: [{ ...record, packages: [{ ...record.packages[0], availableTo: "all" }, { ...record.packages[1], availableTo: "none", isBlocked: true }] }] });
    expect(screen.getByText("All users")).toBeInTheDocument();
    expect(screen.getByText("1 not blocked · 1 blocked")).toBeInTheDocument();
    update({ records: [{ ...record, packages: [{ ...record.packages[0], availableTo: "some" }, record.packages[1]] }] });
    expect(screen.getByText("Specific users or groups")).toBeInTheDocument();
    update({ records: [{ ...record, packages: [{ ...record.packages[0], availableTo: "all", isBlocked: true }] }] });
    expect(screen.getByText("Not available")).toBeInTheDocument();
  });

  it.each((["block", "unblock", "availability", "installation"] as const).flatMap(operation =>
    [true, false].map(complete => ({ operation, complete }))))(
    "replaces only mutation-dependent saved columns for $operation (complete=$complete)",
    ({ operation, complete }) => {
      const initiallyBlocked = operation === "unblock";
      const saved: UnifiedAgentRecord = { ...record, powerPlatformResource: null,
        packages: [{ ...record.packages[0], isBlocked: initiallyBlocked, availableTo: "all", deployedTo: "all" }],
        packagesComplete: complete, packageCount: complete ? 1 : 40,
        columns: { status: initiallyBlocked ? "Blocked" : "Not blocked",
          availability: initiallyBlocked ? "Not available" : "All users", deployment: "All users",
          publisher: "Saved publisher", versions: "1 / 2" } };
      const original = structuredClone(saved);
      const mutation = operation === "block" || operation === "unblock" ? { isBlocked: operation === "block" }
        : { accessUpdate: { target: operation, mode: "replace" as const, scope: "none" as const, principals: [] } };
      const projected = projectVerifiedAgentMutation(saved, new Set([saved.packages[0].id]), mutation);
      const { update } = renderTable({ records: [projected] });
      fireEvent.click(screen.getByRole("button", { name: "Columns" }));
      fireEvent.click(screen.getByRole("checkbox", { name: "Installed for" }));
      fireEvent.keyDown(document, { key: "Escape" });
      const cells = () => within(screen.getAllByRole("row")[1]).getAllByRole("cell");
      const blockChange = "isBlocked" in mutation;
      expect(cells()[5]).toHaveTextContent(!complete && (blockChange || operation === "availability") ? "Unknown"
        : operation === "block" || operation === "availability" ? "Not available" : "All users");
      expect(cells()[6]).toHaveTextContent(!complete && blockChange ? "Unknown" : operation === "block" ? "Blocked" : "Not blocked");
      expect(cells()[7]).toHaveTextContent(operation === "installation" ? complete ? "No users" : "Unknown" : "All users");
      expect(screen.getByText("Saved publisher")).toBeVisible();
      expect(projected.columns?.versions).toBe("1 / 2");
      expect(saved).toEqual(original);
      expect(projectVerifiedAgentMutation(saved, new Set(), mutation)).toBe(saved);
      const unrelated = projectVerifiedAgentMutation(saved, new Set(["off-preview-package"]), mutation);
      if (complete) expect(unrelated).toBe(saved);
      else expect(unrelated.columns).toEqual(projected.columns);
      update({ records: [saved] });
      expect(cells()[5]).toHaveTextContent(String(saved.columns!.availability));
      expect(cells()[6]).toHaveTextContent(String(saved.columns!.status));
      expect(cells()[7]).toHaveTextContent("All users");
    },
  );

  it.each([false, true])("retains exact one-package quick action callbacks (blocked=%s)", isBlocked => {
    const single = { ...record, packages: [{ ...record.packages[0], isBlocked }] };
    const { props, update } = renderTable({ records: [single] });
    fireEvent.click(screen.getByRole("button", { name: "Manage access for Builder agent" }));
    expect(props.onManageAccess).toHaveBeenCalledExactlyOnceWith(single);
    fireEvent.click(screen.getByRole("button", { name: `${isBlocked ? "Unblock" : "Block"} Builder agent` }));
    expect(props.onSetBlocked).toHaveBeenCalledExactlyOnceWith(single, !isBlocked);
    update({ busyPackageId: "package-1" });
    expect(screen.getByRole("button", { name: `${isBlocked ? "Unblock" : "Block"} Builder agent` })).toBeDisabled();
  });

  it.each([false, true])("does not mistake a bounded package preview for a single-version action target (blocked=%s)", isBlocked => {
    const grouped = { ...record, packages: [{ ...record.packages[0], isBlocked }], packageCount: 40, packagesComplete: false };
    const { props, update } = renderTable({ records: [grouped] });
    expect(screen.queryAllByRole("button", { name: /^Manage access for |^Block |^Unblock / })).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: `View details for ${record.displayName}` }));
    expect(props.onViewDetails).toHaveBeenCalledExactlyOnceWith(grouped);
    fireEvent.click(screen.getByRole("checkbox", { name: `Select ${record.displayName}` }));
    expect(props.onToggleSelection).toHaveBeenCalledExactlyOnceWith(grouped);
    expect(props.onManageAccess).not.toHaveBeenCalled();
    expect(props.onSetBlocked).not.toHaveBeenCalled();
    update({ records: [{ ...grouped, packageCount: 1, packagesComplete: true }] });
    expect(screen.getByRole("button", { name: `Manage access for ${record.displayName}` })).toBeEnabled();
    expect(screen.getByRole("button", { name: `${isBlocked ? "Unblock" : "Block"} ${record.displayName}` })).toBeEnabled();
    update({ records: [grouped] });
    expect(screen.queryAllByRole("button", { name: /^Manage access for |^Block |^Unblock / })).toHaveLength(0);
  });

  it.each(["missing", "stale", "denied", "missing-metadata"] as const)("does not bypass %s capability gates for quick actions", scenario => {
    const views = scenario === "missing" ? [] : capabilities();
    for (const view of views) {
      if (scenario === "stale") view.decision.fresh = false;
      if (scenario === "denied") view.decision.authorized = false;
    }
    const { props } = renderTable({ records: [{ ...record, packages: [record.packages[0]] }] }, views, scenario === "missing-metadata" ? [] : workbenchActions);
    for (const name of ["Manage access for Builder agent", "Block Builder agent"]) {
      expect(screen.getByRole("button", { name })).toBeDisabled();
      fireEvent.click(screen.getByRole("button", { name }));
    }
    expect(props.onManageAccess).not.toHaveBeenCalled();
    expect(props.onSetBlocked).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "View details for Builder agent" })).toBeEnabled();
  });

  it("retains viewer selection and details without exposing administrative entry points", () => {
    renderTable({ packageOperationsAllowed: false, quarantineSelectionAllowed: false });
    expect(screen.getByRole("checkbox")).toBeEnabled();
    expect(screen.getByRole("button", { name: /View details/ })).toBeEnabled();
    expect(screen.queryByRole("button", { name: /^Manage|^Block|^Unblock/ })).not.toBeInTheDocument();
  });

  it("disables a record without either target and preserves the empty state", () => {
    const { update } = renderTable({ records: [{ ...record, packages: [], powerPlatformResource: null }] });
    expect(screen.getByRole("checkbox")).toBeDisabled();
    expect(screen.getByRole("checkbox")).not.toBeChecked();
    update({ records: [] });
    expect(screen.getByRole("heading", { name: "No matching agents" })).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });
});
