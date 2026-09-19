import { fireEvent, render, screen, within } from "@testing-library/react";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";
import { capabilityDefinitions } from "../../../backend/src/services/capabilityRegistry";
import { workbenchActions } from "../../../backend/src/services/workbenchMetadata";
import type { CapabilityView, SessionUser, UnifiedAgentRecord } from "../api/client";
import { CapabilityContext } from "../capabilityContext";
import { quarantineTargetKey } from "../quarantineTarget";
import { UnifiedAgentTable } from "./UnifiedAgentTable";
import { WorkbenchActionProvider } from "../workbenchActionContext";
import { createInventoryVerification } from "../test/inventoryVerification";

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
    packageSelectionAllowed: true, packageOperationsAllowed: true, quarantineSelectionAllowed: true, selectionDisabled: false,
    onToggleSelection: vi.fn(), onViewDetails: vi.fn(), onManageAccess: vi.fn(), onSetBlocked: vi.fn(),
    ...overrides,
  };
  const content = (next: Partial<typeof props> = {}) => <CapabilityContext value={{
    views, user, now: Date.now(), loading: false, pending: false, error: undefined, reload: vi.fn(), openPermissions: vi.fn(),
  }}><WorkbenchActionProvider value={actions}><UnifiedAgentTable {...props} {...next} /></WorkbenchActionProvider></CapabilityContext>;
  const result = render(content());
  return { ...result, props, update: (next: Partial<typeof props>) => result.rerender(content(next)) };
}

describe("UnifiedAgentTable", () => {
  it("shows and hides columns, preserves mandatory identity, and resets defaults", () => {
    renderTable({ records: [{ ...record, packages: record.packages.map(item => ({ ...item, supportedHosts: ["Teams", "Copilot"] })) }] });
    fireEvent.click(screen.getByRole("button", { name: "Columns" }));
    const picker = screen.getByRole("dialog", { name: "Choose agent columns" });
    expect(within(picker).getByRole("checkbox", { name: "Agent Always shown" })).toBeDisabled();
    fireEvent.click(within(picker).getByRole("checkbox", { name: "Hosts" }));
    expect(screen.getByRole("columnheader", { name: "Hosts" })).toBeInTheDocument();
    expect(screen.getByText("Copilot / Teams")).toBeInTheDocument();
    fireEvent.click(within(picker).getByRole("checkbox", { name: "Environment" }));
    expect(screen.queryByRole("columnheader", { name: "Environment" })).not.toBeInTheDocument();
    fireEvent.click(within(picker).getByRole("button", { name: "Reset defaults" }));
    expect(screen.queryByRole("columnheader", { name: "Hosts" })).not.toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Environment" })).toBeInTheDocument();
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
    fireEvent.click(screen.getByRole("button", { name: "Columns" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Responses" }));
    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "Sort by Responses" }));
    expect(onSortChange).toHaveBeenLastCalledWith("responses", "desc");
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
    const { update } = renderTable({ records: [{
      ...record,
      usage: { status: "linked", reportSetId: "report-1", responses: 0, activeUsers: 0, lastActivityDateUtc: null, associations: [] },
    }] });
    fireEvent.click(screen.getByRole("button", { name: "Columns" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Responses" }));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.getByRole("cell", { name: "0" })).toBeInTheDocument();
    update({ records: [record] });
    expect(screen.getByRole("cell", { name: "Unavailable" })).toBeInTheDocument();
    update({ records: [] });
    expect(screen.getByRole("heading", { name: "No matching agents" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Columns" })).toBeEnabled();
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
    const { props } = renderTable({ environmentNames: { [record.environmentId!]: "Production" } });
    expect(screen.getByRole("region", { name: "Unified agents" })).toContainElement(screen.getByRole("table"));
    expect(screen.getAllByRole("row")).toHaveLength(2);
    expect(screen.getAllByRole("columnheader").map(header => header.textContent)).toEqual([
      "Select agents", "Agent", "Environment", "Built with", "Availability", "Status", "Actions",
    ]);
    expect(screen.getAllByRole("checkbox")).toHaveLength(1);
    expect(screen.getByText("Production")).toBeInTheDocument();
    expect(screen.getAllByText("Agent Builder")).toHaveLength(1);
    expect(screen.queryByText(/Graph|Linked by|No verified link|exact quarantine target/)).not.toBeInTheDocument();
    expect(screen.queryByText(/0 .*selected/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Builder agent" }));
    expect(props.onToggleSelection).toHaveBeenCalledExactlyOnceWith(record);
    fireEvent.click(screen.getByRole("button", { name: "View details for Builder agent" }));
    expect(props.onViewDetails).toHaveBeenCalledExactlyOnceWith(record);
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
      },
    };
    renderTable({ records: [builder], selectedPackageIds: new Set(builder.packages.map(item => item.id)) });
    expect(screen.getByRole("checkbox")).toBeChecked();
    expect(screen.getByText("2 published versions selected")).toBeVisible();
    expect(screen.queryByText(/exact quarantine target selected/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "View details for Builder agent" })).toBeEnabled();
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
    expect(screen.getAllByRole("row")).toHaveLength(2);
    expect(screen.getByRole("checkbox")).toBeChecked();
    expect(screen.getByText("2 published versions selected")).toBeVisible();
    expect(within(screen.getAllByRole("row")[1]).getAllByRole("cell")[2]).toHaveTextContent(environmentId ? "Package-declared environment" : "Unknown");
    expect(screen.queryByText(/exact quarantine target selected/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "View details for Builder agent" }));
    expect(props.onViewDetails).toHaveBeenCalledExactlyOnceWith(group);
  });

  it("uses lowercase environment lookup keys with an honest ID fallback", () => {
    const { update } = renderTable({ records: [{ ...record, environmentId: "ENVIRONMENT-A" }], environmentNames: { "environment-a": "Friendly environment" } });
    expect(screen.getByText("Friendly environment")).toBeInTheDocument();
    update({ environmentNames: {} });
    expect(screen.getByText("ENVIRONMENT-A")).toBeInTheDocument();
  });

  it("does not infer availability, blocking, quarantine or authoring from a published resource", () => {
    renderTable({ records: [{ ...record, packages: [], powerPlatformResource: { ...record.powerPlatformResource!, authoringTool: null, details: { createdIn: "FutureProvider.vNext_build-X" } } }] });
    const cells = within(screen.getAllByRole("row")[1]).getAllByRole("cell");
    expect(cells[3]).toHaveTextContent(/^Unknown$/);
    expect(cells[4]).toHaveTextContent(/^Unknown$/);
    expect(cells[5]).toHaveTextContent("Published");
    expect(cells[5]).toHaveTextContent("Quarantine status unknown");
    expect(cells[5]).not.toHaveTextContent(/Active|Allowed|Not blocked|Not quarantined/);
  });

  it("keeps unknown publication and unmatched package metadata honest without source-link clutter", () => {
    renderTable({ records: [{
      ...record, environmentId: null, powerPlatformResource: { ...record.powerPlatformResource!, lifecycle: "unknown" },
      identity: { state: "unmatched", evidence: [], packageEvidence: [], reason: "Matching metadata has not been observed." },
    }] });
    expect(screen.getByText("Publication status unknown")).toBeInTheDocument();
    expect(screen.queryByText(/Active|All allowed|counterpart missing|No verified link/i)).not.toBeInTheDocument();
  });

  it("summarizes known, mixed and partially known availability without inferring access from block state", () => {
    const { update } = renderTable({
      records: [{ ...record, packages: record.packages.map(item => ({ ...item, availableTo: "allowedForAll" })) }],
    });
    expect(screen.getByText("All users")).toBeInTheDocument();
    update({ records: [{ ...record, packages: [{ ...record.packages[0], availableTo: "all" }, { ...record.packages[1], availableTo: "none", isBlocked: true }] }] });
    expect(screen.getByText("Varies by package")).toBeInTheDocument();
    expect(screen.getByText("1 not blocked · 1 blocked")).toBeInTheDocument();
    update({ records: [{ ...record, packages: [{ ...record.packages[0], availableTo: "some" }, record.packages[1]] }] });
    expect(screen.getByText("Partially known")).toBeInTheDocument();
  });

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
