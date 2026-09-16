import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { capabilityDefinitions } from "../../../backend/src/services/capabilityRegistry";
import { workbenchActions } from "../../../backend/src/services/workbenchMetadata";
import * as api from "../api/client";
import type { CapabilityView, InventorySourceAwareDetail, QuarantinePreview, SessionUser, UnifiedAgentRecord } from "../api/client";
import { CapabilityContext } from "../capabilityContext";
import { mockNativeDialogs } from "../test/dialog";
import { WorkbenchActionProvider } from "../workbenchActionContext";
import { UnifiedAgentDetailModal } from "./UnifiedAgentDetailModal";

mockNativeDialogs();

const record = {
  id: "unified-1",
  displayName: "Unified builder",
  presence: "both",
  environmentId: "environment-1",
  packages: [{
    id: "package-1", displayName: "Package one", isBlocked: false,
    sourceSystem: "graph_packages", authoringTool: "Agent Builder", creatorType: "unknown",
    agentKind: "copilot_package", lifecycle: "unknown", identityConfidence: "exact_native", provenance: {},
  }],
  powerPlatformResource: {
    tenantId: "tenant-1", nativeId: "agent-1", type: "microsoft.copilotstudio/agents",
    location: null, displayName: "Unified builder", environmentId: "environment-1",
    createdAt: null, createdBy: null, lastPublishedAt: null, sourceSystem: "power_platform",
    authoringTool: "Agent Builder", creatorType: "unknown", agentKind: "agent_builder_agent",
    lifecycle: "published", identityConfidence: "exact_native",
    identifiers: [{ kind: "entra_agent_id", value: "agent-identity-1" }],
    provenance: {}, details: {}, unknownFieldCount: 0,
  },
  identity: {
    state: "matched",
    evidence: [{
      kind: "entra_agent_id", basis: "source_declared_metadata", elementIds: ["element-1"],
      packagePath: "elementDetails.AgentMetadatas.definition.AgentIdentityId",
      resourcePath: "identifiers.entra_agent_id",
    }],
    packageEvidence: [{
      packageId: "package-1",
      evidence: [{
        kind: "entra_agent_id", basis: "source_declared_metadata", elementIds: ["element-1"],
        packagePath: "elementDetails.AgentMetadatas.definition.AgentIdentityId",
        resourcePath: "identifiers.entra_agent_id",
      }],
    }],
    reason: null,
  },
  observations: { graphPackages: null, packageSnapshots: {}, powerPlatform: null },
} satisfies UnifiedAgentRecord;

afterEach(() => vi.restoreAllMocks());

const environmentId = "11111111-1111-4111-8111-111111111111";
const botId = "22222222-2222-4222-8222-222222222222";
const user: SessionUser = {
  homeAccountId: "admin-1", displayName: "Admin", username: "admin@example.invalid", roles: ["AgentControl.Admin"],
};

function observedRecord(): UnifiedAgentRecord {
  return {
    ...record, environmentId,
    powerPlatformResource: {
      ...record.powerPlatformResource, environmentId,
      identifiers: [{ kind: "environment_id", value: environmentId }, { kind: "cds_bot_id", value: botId }],
    },
    observations: {
      ...record.observations,
      powerPlatform: {
        id: "snapshot-1", snapshotId: "snapshot-1", current: true,
        observedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(),
        roleScope: "full", environmentScope: null, coverage: "covered", coveredCount: 1,
        observedCount: 1, totalRecords: 1,
      },
    },
  };
}

function corroboratedRecord(withBotIdentifier: boolean): UnifiedAgentRecord {
  const observed = observedRecord();
  const evidence: UnifiedAgentRecord["identity"]["evidence"] = [{
    kind: "environment_schema_native_id", basis: "source_declared_metadata", elementIds: ["metadata-1"],
    packagePath: "elementDetails.AgentMetadatas.definition.SourceIds.EnvironmentId + SourceIds.SchemaName + SourceIds.CdsBotId",
    resourcePath: "environmentId + details.schemaName + nativeId",
  }];
  return {
    ...observed,
    powerPlatformResource: {
      ...observed.powerPlatformResource!, nativeId: botId, details: { schemaName: "verified-schema" },
      identifiers: observed.powerPlatformResource!.identifiers.filter(item => withBotIdentifier || item.kind !== "cds_bot_id"),
    },
    identity: {
      state: "matched", evidence, packageEvidence: [{ packageId: "package-1", evidence }],
      reason: "Corroborated environment, schema and native resource identity from source metadata.",
    },
  };
}

function capabilities(): CapabilityView[] {
  return capabilityDefinitions.filter(item => [
    "graph.package.block.manage", "graph.package.access.manage", "powerPlatform.quarantine.manage",
  ].includes(item.id)).map(definition => ({
    definition,
    decision: {
      capabilityId: definition.id, status: "available", authorized: true, fresh: true,
      verification: "on_demand", previewQualification: "not_required", remediation: [],
    },
  }));
}

function renderDetail(overrides: Partial<ComponentProps<typeof UnifiedAgentDetailModal>> = {}, views = capabilities(), actions = workbenchActions) {
  const props = {
    record, roles: user.roles, onTabChange: vi.fn(), onClose: vi.fn(), onInspectPackage: vi.fn(),
    onManagePackageAccess: vi.fn(), onSetPackageBlocked: vi.fn(), ...overrides,
  };
  const content = (next: Partial<typeof props> = {}, nextViews = views) => <CapabilityContext value={{
    views: nextViews, user: { ...user, roles: next.roles ?? props.roles }, now: Date.now(),
    loading: false, pending: false, error: undefined, reload: vi.fn(), openPermissions: vi.fn(),
  }}><WorkbenchActionProvider value={actions}><UnifiedAgentDetailModal {...props} {...next} /></WorkbenchActionProvider></CapabilityContext>;
  const result = render(content());
  return { ...result, props, update: (next: Partial<typeof props>, nextViews = views) => result.rerender(content(next, nextViews)) };
}

beforeEach(() => {
  const snapshot = observedRecord().observations.powerPlatform!;
  const related: InventorySourceAwareDetail = {
    source: "power_platform", nativeId: record.powerPlatformResource.nativeId,
    resourceType: record.powerPlatformResource.type, environmentId, snapshotId: snapshot.id,
    observedAt: snapshot.observedAt, expiresAt: snapshot.expiresAt, identifiers: [],
    package: { status: "unmatched", reason: "No package association queried." },
    reports: { status: "unavailable", reason: "Usage reports are unavailable." },
    audit: { status: "available", count: 0, value: [] },
    security: { status: "available", count: 0, value: [] },
    controls: { quarantineTarget: { environmentId, botId }, packageTarget: null },
  };
  vi.spyOn(api, "getInventorySourceAwareDetail").mockResolvedValue(related);
  vi.spyOn(api, "previewQuarantine");
  vi.spyOn(api, "submitQuarantine");
});

describe("UnifiedAgentDetailModal", () => {
  it("defaults to Overview with admin facts and collapsed technical evidence", async () => {
    const { props } = renderDetail({ roles: ["AgentControl.Viewer"], environmentNames: { "environment-1": "Production" } });

    const dialog = screen.getByRole("dialog", { name: "Unified builder" });
    const tablist = within(dialog).getByRole("tablist", { name: "Agent details" });
    expect(within(tablist).getAllByRole("tab").map(tab => tab.textContent)).toEqual(["Overview", "Availability", "Configuration", "Usage", "Activity", "Manage"]);
    expect(within(dialog).getByRole("tabpanel", { name: "Overview" })).toBeVisible();
    expect(within(dialog).getByText("Production")).toBeVisible();
    expect(within(dialog).getByText("Agent Builder")).toBeVisible();
    expect(within(dialog).getByText("Quarantine status unknown")).toBeVisible();
    expect(within(dialog).getByText("Linked by source metadata")).not.toBeVisible();
    expect(within(dialog).getByText(/not presented as a publicly documented Microsoft canonical identifier equivalence/)).not.toBeVisible();
    const technical = within(dialog).getByText("Technical details").closest("details");
    expect(technical).not.toHaveAttribute("open");
    await userEvent.click(within(dialog).getByText("Technical details"));
    expect(technical).toHaveAttribute("open");
    expect(within(dialog).getByText("Linked by source metadata")).toBeVisible();
    expect(technical).toHaveTextContent("package-1");
    expect(technical).toHaveTextContent("element-1");
    expect(technical).toHaveTextContent("elementDetails.AgentMetadatas.definition.AgentIdentityId");
    fireEvent.click(within(dialog).getByRole("tab", { name: "Availability" }));
    expect(props.onTabChange).toHaveBeenLastCalledWith("package");
    expect(within(dialog).getByText("Package one")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("tab", { name: "Configuration" }));
    expect(props.onTabChange).toHaveBeenLastCalledWith("power-platform");
    expect(within(dialog).getByText("agent-identity-1")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("tab", { name: "Manage" }));
    expect(props.onTabChange).toHaveBeenLastCalledWith("controls");
    expect(within(dialog).getByRole("heading", { name: "Manage agent" })).toBeVisible();
    expect(within(dialog).getByText(/package blocking and quarantine are independent/)).toBeVisible();
    expect(within(dialog).getByText(/AgentControl.Admin role is required/)).toBeVisible();
  });

  it.each([
    ["identities", "Overview"], ["package", "Availability"], ["power-platform", "Configuration"],
    ["reports", "Usage"], ["audit-security", "Activity"], ["controls", "Manage"],
  ])("preserves the legacy %s route and panel IDs under the %s label", (activeTab, name) => {
    renderDetail({ activeTab });
    expect(screen.getByRole("tab", { name })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name })).toHaveAttribute("id", `unified-agent-tab-${activeTab}`);
    expect(screen.getByRole("tabpanel", { name })).toHaveAttribute("id", `unified-agent-panel-${activeTab}`);
  });

  it("falls back to Overview for an unknown route and supports keyboard tab navigation", () => {
    const { props, update } = renderDetail({ activeTab: "legacy-unknown-tab" });
    expect(screen.getByRole("tab", { name: "Overview" })).toHaveAttribute("aria-selected", "true");
    update({ activeTab: undefined });
    fireEvent.keyDown(screen.getByRole("tab", { name: "Overview" }), { key: "End" });
    expect(screen.getByRole("tab", { name: "Manage" })).toHaveFocus();
    expect(props.onTabChange).toHaveBeenLastCalledWith("controls");
    fireEvent.keyDown(screen.getByRole("tab", { name: "Manage" }), { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: "Overview" })).toHaveFocus();
    expect(props.onTabChange).toHaveBeenLastCalledWith("identities");
    fireEvent.keyDown(screen.getByRole("tab", { name: "Overview" }), { key: "ArrowLeft" });
    expect(screen.getByRole("tab", { name: "Manage" })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole("tab", { name: "Manage" }), { key: "Home" });
    expect(screen.getByRole("tab", { name: "Overview" })).toHaveFocus();
  });

  it("accepts the singular shorthand but always emits the existing identities tab ID", () => {
    const { props } = renderDetail({ activeTab: "identity" });
    expect(screen.getByRole("tabpanel", { name: "Overview" })).toHaveAttribute("id", "unified-agent-panel-identities");
    fireEvent.click(screen.getByRole("tab", { name: "Overview" }));
    expect(props.onTabChange).toHaveBeenCalledExactlyOnceWith("identities");
  });

  it("renders corroborated schema/native evidence in collapsed diagnostics without claiming a Microsoft canonical identity", async () => {
    const corroborated = corroboratedRecord(true);
    renderDetail({ record: corroborated, activeTab: "identities" });
    await waitFor(() => expect(api.getInventorySourceAwareDetail).toHaveBeenCalledOnce());
    const technical = screen.getByText("Technical details").closest("details");
    expect(technical).not.toHaveAttribute("open");
    expect(screen.getAllByText("Environment schema native id")).toHaveLength(2);
    for (const evidence of screen.getAllByText("Environment schema native id")) expect(evidence).not.toBeVisible();
    const qualification = screen.getByText(/not presented as a publicly documented Microsoft canonical identifier equivalence/);
    expect(qualification).not.toBeVisible();
    expect(qualification).toHaveTextContent(corroborated.identity.reason!);
    await userEvent.click(screen.getByText("Technical details"));
    expect(qualification).toBeVisible();
    expect(technical).toHaveTextContent("metadata-1");
    expect(technical).toHaveTextContent(corroborated.identity.evidence[0].packagePath);
    expect(technical).toHaveTextContent(corroborated.identity.evidence[0].resourcePath);
  });

  it.each([false, true])("requires an explicit backend-supplied CDS bot identifier despite corroborated evidence (supplied=%s)", async supplied => {
    renderDetail({ record: corroboratedRecord(supplied), activeTab: "controls" });
    await waitFor(() => expect(api.getInventorySourceAwareDetail).toHaveBeenCalledOnce());
    if (supplied) expect(screen.getByRole("button", { name: "Quarantine" })).toBeEnabled();
    else {
      expect(screen.queryByRole("button", { name: "Quarantine" })).not.toBeInTheDocument();
      expect(screen.getByText(/one valid native CDS bot identity/)).toBeVisible();
    }
    expect(api.previewQuarantine).not.toHaveBeenCalled();
    expect(api.submitQuarantine).not.toHaveBeenCalled();
  });

  it("retains Power Platform ownership, configuration and connector details in Agents", () => {
    const resource = {
      ...record.powerPlatformResource,
      details: {
        ownerId: "native-owner",
        schemaName: "native-schema",
        model: "configured-model",
        authentication: "configured-authentication",
        orchestration: "configured-orchestration",
        connectors: [{ connectorId: "native-connector", operations: [{ operationId: "operation-1", displayName: "Read records", method: "GET" }] }],
        capabilityDetailsTruncated: true,
      },
    };
    render(<WorkbenchActionProvider value={[]}>
      <UnifiedAgentDetailModal
        record={{ ...record, powerPlatformResource: resource }}
        activeTab="power-platform" roles={["AgentControl.Viewer"]}
        onTabChange={vi.fn()} onClose={vi.fn()} onInspectPackage={vi.fn()}
        onManagePackageAccess={vi.fn()} onSetPackageBlocked={vi.fn()}
      />
    </WorkbenchActionProvider>);
    for (const value of ["native-owner", "native-schema", "configured-model", "configured-authentication", "configured-orchestration", "native-connector", "Read records"]) {
      expect(screen.getByText(value)).toBeInTheDocument();
    }
    expect(screen.getByText(/Capability details are partial/)).toBeInTheDocument();
  });

  it("does not retain a prior source lookup error or show endless loading for a package-only record", async () => {
    const lookup = vi.spyOn(api, "getInventorySourceAwareDetail").mockRejectedValue(new Error("Previous source lookup failed"));
    const observed: UnifiedAgentRecord = {
      ...record,
      observations: {
        ...record.observations,
        powerPlatform: {
          id: "snapshot-1", snapshotId: "snapshot-1", current: true,
          observedAt: "2026-09-15T00:00:00Z", expiresAt: "2026-10-15T00:00:00Z",
          roleScope: "full", environmentScope: null, coverage: "covered", coveredCount: 1,
          observedCount: 1, totalRecords: 1,
        },
      },
    };
    const modal = (value: UnifiedAgentRecord) => <WorkbenchActionProvider value={[]}>
      <UnifiedAgentDetailModal record={value} activeTab="reports" roles={["AgentControl.Viewer"]}
        onTabChange={vi.fn()} onClose={vi.fn()} onInspectPackage={vi.fn()}
        onManagePackageAccess={vi.fn()} onSetPackageBlocked={vi.fn()} />
    </WorkbenchActionProvider>;
    const { rerender } = render(modal(observed));
    expect(await screen.findByText("Previous source lookup failed")).toBeInTheDocument();
    rerender(modal({ ...record, id: "package-only", powerPlatformResource: null }));
    expect(screen.queryByText("Previous source lookup failed")).not.toBeInTheDocument();
    expect(screen.queryByText(/Loading authorized exact source associations/)).not.toBeInTheDocument();
    expect(screen.getByText(/No Power Platform resource is linked/)).toBeInTheDocument();
    expect(lookup).toHaveBeenCalledOnce();
  });

  it("offers common Manage controls for every package and quarantine with exact target callbacks", async () => {
    const observed = observedRecord();
    observed.packages = [
      { ...record.packages[0], availableTo: "all", deployedTo: "some" },
      { ...record.packages[0], id: "package-2", displayName: "Package two", isBlocked: true },
    ];
    const { props } = renderDetail({ record: observed, activeTab: "controls" });
    await waitFor(() => expect(api.getInventorySourceAwareDetail).toHaveBeenCalledOnce());
    expect(screen.getByRole("heading", { name: "Access, installation and blocking" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Quarantine and restore" })).toBeVisible();
    expect(screen.getByText(/Available to: All users.*Installed for: Specific users or groups/)).toBeVisible();
    expect(screen.getByText(/Available to: Unknown.*Installed for: Unknown/)).toBeVisible();
    for (const item of observed.packages) {
      await userEvent.click(screen.getByRole("button", { name: `Manage access for ${item.displayName} (${item.id})` }));
      expect(props.onManagePackageAccess).toHaveBeenLastCalledWith(item, "availability");
      await userEvent.click(screen.getByRole("button", { name: `Manage installation for ${item.displayName} (${item.id})` }));
      expect(props.onManagePackageAccess).toHaveBeenLastCalledWith(item, "installation");
      await userEvent.click(screen.getByRole("button", { name: `${item.isBlocked ? "Unblock" : "Block"} ${item.displayName} (${item.id})` }));
      expect(props.onSetPackageBlocked).toHaveBeenLastCalledWith(item, !item.isBlocked);
      await userEvent.click(screen.getByRole("button", { name: `Package details for ${item.displayName} (${item.id})` }));
      expect(props.onInspectPackage).toHaveBeenLastCalledWith(item);
    }
    expect(screen.getByRole("button", { name: "Quarantine" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Restore from quarantine" })).toBeEnabled();
    expect(screen.getByText(/Makers may still see and test a quarantined bot/)).toBeVisible();
    expect(api.previewQuarantine).not.toHaveBeenCalled();
    expect(api.submitQuarantine).not.toHaveBeenCalled();
  });

  it("keeps package-only controls available and explains missing quarantine without inventing a target", () => {
    renderDetail({ record: { ...record, powerPlatformResource: null }, activeTab: "controls" });
    expect(screen.getByRole("button", { name: "Manage access for Package one (package-1)" })).toBeEnabled();
    expect(screen.getByText(/Quarantine is unavailable/)).toBeVisible();
    expect(screen.queryByRole("button", { name: "Quarantine" })).not.toBeInTheDocument();
    expect(api.previewQuarantine).not.toHaveBeenCalled();
  });

  it("offers quarantine for a resource-only agent without inventing package availability", async () => {
    renderDetail({ record: { ...observedRecord(), packages: [] }, activeTab: "controls" });
    await waitFor(() => expect(api.getInventorySourceAwareDetail).toHaveBeenCalledOnce());
    expect(screen.getByText(/Availability and installation have not been observed/)).toBeVisible();
    expect(screen.queryByRole("button", { name: /Manage access|Manage installation|^Block / })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Quarantine" })).toBeEnabled();
    expect(screen.getByText("Saved inventory status").parentElement).toHaveTextContent("Unknown");
  });

  it("keeps viewers read-only even on a directly opened Manage route", async () => {
    renderDetail({ record: observedRecord(), activeTab: "controls", roles: ["AgentControl.Viewer"] });
    await waitFor(() => expect(api.getInventorySourceAwareDetail).toHaveBeenCalledOnce());
    expect(screen.getByText(/AgentControl.Admin role is required/)).toBeVisible();
    expect(screen.getByRole("button", { name: /Package details/ })).toBeEnabled();
    expect(screen.queryByRole("button", { name: /Manage access|Manage installation|^Block |^Quarantine$|Restore from quarantine/ })).not.toBeInTheDocument();
    expect(api.previewQuarantine).not.toHaveBeenCalled();
  });

  it.each(["missing", "stale", "denied", "missing-metadata"] as const)("retains %s capability gates across the common Manage surface", async scenario => {
    const views = scenario === "missing" ? [] : capabilities();
    for (const view of views) {
      if (scenario === "stale") view.decision.fresh = false;
      if (scenario === "denied") view.decision.status = "missing_permission";
    }
    const { props } = renderDetail({ record: observedRecord(), activeTab: "controls" }, views, scenario === "missing-metadata" ? [] : workbenchActions);
    await waitFor(() => expect(api.getInventorySourceAwareDetail).toHaveBeenCalledOnce());
    for (const name of [
      "Manage access for Package one (package-1)", "Manage installation for Package one (package-1)",
      "Block Package one (package-1)", "Quarantine", "Restore from quarantine",
    ]) {
      const button = screen.getByRole("button", { name });
      expect(button).toBeDisabled();
      expect(button).toHaveAttribute("aria-describedby");
      await userEvent.click(button);
    }
    expect(props.onManagePackageAccess).not.toHaveBeenCalled();
    expect(props.onSetPackageBlocked).not.toHaveBeenCalled();
    expect(api.previewQuarantine).not.toHaveBeenCalled();
    expect(api.submitQuarantine).not.toHaveBeenCalled();
  });

  it.each(["missing-snapshot", "stale-snapshot", "missing-bot", "invalid-environment", "duplicate-bot"] as const)(
    "explains an ineligible quarantine target (%s) without guessing a bot identity", async scenario => {
      const observed = observedRecord();
      const resource = observed.powerPlatformResource!;
      if (scenario === "missing-snapshot") observed.observations.powerPlatform = null;
      if (scenario === "stale-snapshot") observed.observations.powerPlatform!.expiresAt = "2020-01-01T00:00:00Z";
      if (scenario === "missing-bot") {
        resource.nativeId = botId;
        resource.identifiers = resource.identifiers.filter(item => item.kind !== "cds_bot_id");
      }
      if (scenario === "invalid-environment") resource.environmentId = "not-an-environment-id";
      if (scenario === "duplicate-bot") resource.identifiers.push({ kind: "cds_bot_id", value: "33333333-3333-4333-8333-333333333333" });
      renderDetail({ record: observed, activeTab: "controls" });
      if (observed.observations.powerPlatform) await waitFor(() => expect(api.getInventorySourceAwareDetail).toHaveBeenCalledOnce());
      expect(screen.getByText(/Quarantine is unavailable/)).toBeVisible();
      if (scenario === "missing-bot") expect(screen.getByText(/one valid native CDS bot identity/)).toBeVisible();
      expect(screen.queryByRole("button", { name: "Quarantine" })).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Block Package one (package-1)" })).toBeEnabled();
      expect(api.previewQuarantine).not.toHaveBeenCalled();
    },
  );

  it("retains explicit frozen-target confirmation and capability rechecks for quarantine", async () => {
    const observed = observedRecord();
    const snapshot = observed.observations.powerPlatform!;
    const preview: QuarantinePreview = {
      confirmationHash: "c".repeat(64),
      statuses: [{
        target: { resourceNativeId: record.powerPlatformResource.nativeId, displayName: record.displayName, environmentId, botId },
        direct: { isBotQuarantined: false, providerUpdatedAt: snapshot.observedAt, observedAt: snapshot.observedAt, correlationId: "status-1", source: "provider" },
        inventory: { isQuarantined: null, quarantinedAt: null, observedAt: snapshot.observedAt, snapshotId: snapshot.id },
        disagreesWithInventory: false,
      }],
      summary: {
        risk: true, operation: "quarantine", provider: "Power Platform Copilot Studio", endpoint: "api-version=1 botQuarantine",
        permission: "Delegated CopilotStudio.AdminActions.Invoke", targetCount: 1, targetSelectionHash: "d".repeat(64),
        actor: { id: user.homeAccountId, displayName: user.displayName, username: user.username }, packageControlIndependent: true,
        makerBehavior: "Makers may still see and test this bot while connected channels cannot use it.", providerAtomicity: false,
        targets: [{
          resourceNativeId: record.powerPlatformResource.nativeId, displayName: record.displayName, environmentId, botId,
          currentState: false, requestedState: true, currentProviderUpdatedAt: snapshot.observedAt,
          inventoryState: null, inventoryObservedAt: snapshot.observedAt,
        }],
        additionalTargetCount: 0,
      },
    };
    vi.mocked(api.previewQuarantine).mockResolvedValue(preview);
    vi.mocked(api.submitQuarantine).mockResolvedValue({
      id: "job-1", action: "quarantine", status: "succeeded", confirmationHash: preview.confirmationHash, confirmation: preview.summary,
      isCanary: false, total: 1, completed: 1, succeeded: 1, failed: 0, skipped: 0, inconclusive: 0, cancelled: 0,
      canResume: false, canReconcile: false, createdAt: snapshot.observedAt, updatedAt: snapshot.observedAt, results: [],
    });
    const { props, update } = renderDetail({ record: observed, activeTab: "controls" });
    await userEvent.click(screen.getByRole("button", { name: "Quarantine" }));
    expect(api.previewQuarantine).toHaveBeenCalledExactlyOnceWith({
      action: "quarantine", snapshotId: snapshot.id, resourceNativeIds: [record.powerPlatformResource.nativeId],
    });
    const confirmation = await screen.findByRole("dialog", { name: "Quarantine 1 agent" });
    expect(within(confirmation).getByText(`${environmentId} / ${botId}`)).toBeVisible();
    expect(within(confirmation).getByText("Not provider-atomic; each target is verified independently")).toBeVisible();
    expect(within(confirmation).getByRole("button", { name: "Confirm quarantine" })).toBeDisabled();
    expect(api.submitQuarantine).not.toHaveBeenCalled();
    await userEvent.click(within(confirmation).getByRole("checkbox"));
    const stale = capabilities().map(view => ({ ...view, decision: { ...view.decision, fresh: false } }));
    update({}, stale);
    expect(within(confirmation).getByRole("button", { name: "Confirm quarantine" })).toBeDisabled();
    await userEvent.click(within(confirmation).getByRole("button", { name: "Confirm quarantine" }));
    expect(api.submitQuarantine).not.toHaveBeenCalled();
    update({}, capabilities());
    await userEvent.click(within(confirmation).getByRole("button", { name: "Confirm quarantine" }));
    expect(api.submitQuarantine).toHaveBeenCalledExactlyOnceWith({
      action: "quarantine", snapshotId: snapshot.id, resourceNativeIds: [record.powerPlatformResource.nativeId], confirmationHash: preview.confirmationHash,
    }, expect.stringMatching(/^[0-9a-f-]{36}$/));
    expect(props.onSetPackageBlocked).not.toHaveBeenCalled();
    expect(props.onManagePackageAccess).not.toHaveBeenCalled();
  });

  it("does not close the parent dialog on Escape while the access editor is open", () => {
    const { props, update } = renderDetail({ externalAccessEditorOpen: true });
    const dialog = screen.getByRole("dialog", { name: record.displayName });
    const cancel = new Event("cancel", { cancelable: true });
    fireEvent(dialog, cancel);
    expect(cancel.defaultPrevented).toBe(true);
    expect(props.onClose).not.toHaveBeenCalled();
    update({ externalAccessEditorOpen: false });
    const nextCancel = new Event("cancel", { cancelable: true });
    fireEvent(dialog, nextCancel);
    expect(nextCancel.defaultPrevented).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Close unified agent details" }));
    expect(props.onClose).toHaveBeenCalledOnce();
  });
});
