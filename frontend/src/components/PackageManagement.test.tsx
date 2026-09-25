import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { capabilityDefinitions } from "../../../backend/src/services/capabilityRegistry";
import { workbenchActions } from "../../../backend/src/services/workbenchMetadata";
import type { CapabilityId, CapabilityView, CopilotPackageDetail, SessionUser } from "../api/client";
import { BulkConfirmModal, type BulkConfirmation } from "../App";
import { CapabilityContext } from "../capabilityContext";
import { projectVerifiedAccessScope } from "../packageMutationState";
import { AgentDetailModal } from "./AgentDetailModal";
import { AgentTable } from "./AgentTable";
import { WorkbenchActionProvider } from "../workbenchActionContext";

const user: SessionUser = {
  displayName: "Package operator",
  username: "operator@example.invalid",
  homeAccountId: "operator-1",
  tenantId: "tenant-1",
  roles: ["AgentControl.Admin"],
};

const agent: CopilotPackageDetail = {
  id: "package-1",
  displayName: "Research assistant",
  isBlocked: false,
  availableTo: "some",
  deployedTo: "none",
  allowedUsersAndGroups: [{ resourceType: "user", resourceId: "user-1" }],
  acquireUsersAndGroups: [],
  sourceSystem: "graph_packages",
  authoringTool: null,
  creatorType: "unknown",
  agentKind: "copilot_package",
  lifecycle: "unknown",
  identityConfidence: "exact_native",
  provenance: { displayName: { sourceSystem: "graph_packages", path: "displayName", maturity: "ga" } },
  observation: {
    observedAt: "2026-09-08T10:00:00.000Z",
    expiresAt: "2026-09-15T10:00:00.000Z",
    scopeKind: "broad",
    source: "Microsoft Graph package catalog",
    apiMaturity: "v1.0 read; preview controls",
  },
};

describe("package management UI", () => {
  it.each(["AgentControl.Admin", "AgentControl.Viewer"] as const)("keeps package changes scoped to %s", async role => {
    const block = vi.fn();
    const access = vi.fn();
    renderWithCapabilities(
      <AgentTable
        agents={[agent]} selectedIds={new Set()} recentlyChangedIds={new Set()} operationsAllowed
        selectionDisabled={false} usageByAgentId={new Map()} allMatchingSelected={false} selectedCount={0}
        onToggleAgentSelection={vi.fn()} onToggleMatchingSelection={vi.fn()} onViewDetails={vi.fn()}
        onManageAccess={access} onBlock={block} onUnblock={vi.fn()}
      />,
      [onDemandCapability("graph.package.access.manage"), onDemandCapability("graph.package.block.manage")],
      { ...user, roles: [role] },
    );
    const blockButton = screen.getByRole("button", { name: "Block Research assistant" });
    const accessButton = screen.getByRole("button", { name: "Manage access for Research assistant" });
    if (role === "AgentControl.Admin") {
      expect(blockButton).toBeEnabled();
      expect(accessButton).toBeEnabled();
    } else {
      expect(blockButton).toBeDisabled();
      expect(accessButton).toBeDisabled();
    }
    expect(screen.getByRole("button", { name: "Reassign owner for Research assistant" })).toBeDisabled();
    expect(block).not.toHaveBeenCalled();
    expect(access).not.toHaveBeenCalled();
    await userEvent.click(blockButton);
    await userEvent.click(accessButton);
    expect(block).toHaveBeenCalledTimes(role === "AgentControl.Admin" ? 1 : 0);
    expect(access).toHaveBeenCalledTimes(role === "AgentControl.Admin" ? 1 : 0);
  });
  it("keeps saved reads usable when provider permission is missing", () => {
    renderWithCapabilities(
      <AgentTable
        agents={[agent]}
        selectedIds={new Set()}
        recentlyChangedIds={new Set()}
        operationsAllowed
        selectionDisabled={false}
        usageByAgentId={new Map()}
        allMatchingSelected={false}
        selectedCount={0}
        onToggleAgentSelection={vi.fn()}
        onToggleMatchingSelection={vi.fn()}
        onViewDetails={vi.fn()}
        onManageAccess={vi.fn()}
        onBlock={vi.fn()}
        onUnblock={vi.fn()}
      />,
      [capability("graph.package.read.delegated", "available"), capability("graph.package.access.manage", "missing_permission"), capability("graph.package.block.manage", "missing_permission")],
    );

    expect(screen.getByRole("button", { name: "View details for Research assistant" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Manage access for Research assistant" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Manage access for Research assistant" })).toHaveAccessibleDescription(
      "Admin prerequisite: add delegated CopilotPackages.ReadWrite.All for https://graph.microsoft.com in the app registration and grant admin consent.",
    );
    expect(screen.getByRole("button", { name: "Block Research assistant" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Reassign owner for Research assistant" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Reassign owner for Research assistant" })).toHaveAccessibleDescription(/Owner reassignment is not implemented in this app/i);
    expect(screen.getByRole("link", { name: "Reassignment documentation for Research assistant" })).toHaveAttribute("href", "https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/api/admin-settings/package/copilotpackage-reassign");
  });

  it("shows package source, maturity, deployment, freshness, and distinct block semantics", () => {
    renderWithCapabilities(
      <AgentDetailModal agent={agent} activeTab="package" onClose={vi.fn()} onUpdateAccess={vi.fn()} />,
      [onDemandCapability("graph.package.access.manage")],
    );

    expect(screen.getByText("Package block")).toBeInTheDocument();
    expect(screen.getByText("Installed for", { selector: "dt" })).toBeInTheDocument();
    expect(screen.getByText("Microsoft Graph package catalog")).toBeInTheDocument();
    expect(screen.getByText("v1.0 read; preview controls")).toBeInTheDocument();
    expect(screen.getByText("Not exposed by the Graph package detail contract")).toBeInTheDocument();
    expect(screen.getByText(/not Copilot Studio quarantine/i)).toBeInTheDocument();
  });

  it("keeps package provenance independent from other source authorities", async () => {
    const input = userEvent.setup();
    renderWithCapabilities(
      <AgentDetailModal agent={agent} onClose={vi.fn()} onUpdateAccess={vi.fn()} />,
      [onDemandCapability("graph.package.access.manage")],
    );

    await input.click(screen.getByRole("tab", { name: "Identities" }));
    expect(screen.getByRole("heading", { name: "Exact package identities and provenance" })).toBeInTheDocument();
    expect(screen.getByText(/not substituted as another source's native target/)).toBeInTheDocument();
    expect(screen.getByText("graph_packages · ga · displayName")).toBeInTheDocument();
  });

  it.each(["block", "unblock", "update-availability"] as const)("confirms the server-issued %s summary with appropriate detail", async operation => {
    const confirmation = mutationConfirmation(operation);
    const confirm = vi.fn();
    const isBlockAction = operation !== "update-availability";
    renderWithCapabilities(<BulkConfirmModal confirmation={confirmation} onCancel={vi.fn()} onConfirm={confirm} />, [onDemandCapability(isBlockAction ? "graph.package.block.manage" : "graph.package.access.manage")]);

    if (isBlockAction) {
      const action = operation === "block" ? "Block" : "Unblock";
      const dialog = screen.getByRole("dialog", { name: `${action} package?` });
      expect(dialog).toHaveAccessibleDescription(operation === "block"
        ? "Users won't be able to use this package." : "Users with access will be able to use this package again.");
      expect(screen.getByText(/Availability and installation settings won't change/)).toBeVisible();
      expect(screen.getByText("Uses a Microsoft Graph preview API.")).toBeVisible();
      expect(screen.queryByText(/affected principals/)).not.toBeInTheDocument();
      const changes = within(screen.getByRole("list", { name: "Package changes" }));
      expect(changes.getByText(agent.displayName)).toBeVisible();
      expect(changes.getByText(/Current:/).parentElement).toHaveTextContent(operation === "block" ? "Not blocked" : "Blocked");
      expect(changes.getByText(/Requested:/).parentElement).toHaveTextContent(operation === "block" ? "Blocked" : "Not blocked");
      expect(screen.getByText(confirmation.preview.summary.endpoint)).not.toBeVisible();
      expect(screen.getByText(agent.id)).not.toBeVisible();
      expect(screen.getByText(confirmation.preview.summary.targetSelectionHash)).not.toBeVisible();
      await userEvent.click(screen.getByText("Technical details"));
      expect(screen.getByText(confirmation.preview.summary.endpoint)).toBeVisible();
      expect(screen.getByText(agent.id)).toBeVisible();
      expect(screen.getByText(confirmation.preview.summary.targetSelectionHash)).toBeVisible();
      const submit = screen.getByRole("button", { name: `${action} package` });
      if (operation === "block") expect(submit).toHaveClass("danger");
      else expect(submit).not.toHaveClass("danger");
    } else {
      expect(screen.getByText("Preview write risk")).toBeInTheDocument();
      expect(screen.getByRole("note")).toHaveTextContent("Access updates can overwrite concurrent administrator changes.");
    }
    expect(screen.getByText("Microsoft Graph")).toBeInTheDocument();
    expect(screen.getByText("Delegated CopilotPackages.ReadWrite.All")).toBeInTheDocument();
    const rawPreview = within(screen.getByRole("list", { name: "Exact package mutation preview" }));
    expect(rawPreview.getByText(/Current:/)).toHaveTextContent(`"isBlocked":${operation === "unblock"}`);
    expect(rawPreview.getByText(/Requested:/)).toHaveTextContent(`"isBlocked":${operation !== "unblock"}`);
    expect(screen.getByText(/separately confirmed inverse operation/)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(confirm).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: operation === "update-availability" ? "Confirm update availability" : operation === "block" ? "Block package" : "Unblock package" }));
    expect(confirm).toHaveBeenCalledOnce();
  });

  it.each(["block", "unblock"] as const)("shows the full bulk %s count without inventing a user-impact count", operation => {
    const confirmation = mutationConfirmation(operation);
    const summary = confirmation.preview.summary;
    confirmation.mutationScope = summary.scope = "bulk";
    confirmation.ids = Array.from({ length: 25 }, (_, index) => `package-${index}`);
    summary.targetCount = 25;
    summary.affectedPrincipalCount = 25;
    summary.targets = confirmation.ids.slice(0, 20).map(id => ({ ...summary.targets[0], id }));
    summary.additionalTargetCount = 5;
    renderWithCapabilities(<BulkConfirmModal confirmation={confirmation} onCancel={vi.fn()} onConfirm={vi.fn()} />, [onDemandCapability("graph.package.block.manage")]);
    const action = operation === "block" ? "Block" : "Unblock";
    expect(screen.getByRole("dialog", { name: `${action} 25 packages?` })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: `${action} 25 packages` })).toBeEnabled();
    const list = screen.getByRole("list", { name: "Package changes" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(20);
    expect(within(list).getByText("package-0")).toBeVisible();
    expect(within(list).getByText("package-19")).toBeVisible();
    expect(screen.getByText(`Showing 20 of 25 packages. All 25 will be ${operation === "block" ? "blocked" : "unblocked"}.`)).toBeVisible();
    expect(screen.queryByText(/affected principals/)).not.toBeInTheDocument();
  });

  it("keeps unknown and unchanged block states truthful", () => {
    const confirmation = mutationConfirmation("block");
    confirmation.preview.summary.targets = [
      { ...confirmation.preview.summary.targets[0], currentState: { kind: "block" } },
      { ...confirmation.preview.summary.targets[0], id: "already-blocked", currentState: { kind: "block", isBlocked: true } },
    ];
    confirmation.preview.summary.targetCount = 2;
    renderWithCapabilities(<BulkConfirmModal confirmation={confirmation} onCancel={vi.fn()} onConfirm={vi.fn()} />, [onDemandCapability("graph.package.block.manage")]);
    const items = within(screen.getByRole("list", { name: "Package changes" })).getAllByRole("listitem");
    expect(within(items[0]).getByText(/Current:/).parentElement).toHaveTextContent("Unknown");
    expect(within(items[1]).getByText(/Current:/).parentElement).toHaveTextContent("Blocked");
    expect(within(items[1]).getByText(/Requested:/).parentElement).toHaveTextContent("Blocked");
  });

  it.each(["block", "unblock"] as const)("cancels %s without confirming or bypassing authorization", async operation => {
    const confirm = vi.fn();
    const cancel = vi.fn();
    renderWithCapabilities(<BulkConfirmModal confirmation={mutationConfirmation(operation)} onCancel={cancel} onConfirm={confirm} />,
      [capability("graph.package.block.manage", "missing_permission")]);
    expect(screen.getByRole("button", { name: operation === "block" ? "Block package" : "Unblock package" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(cancel).toHaveBeenCalledOnce();
    expect(confirm).not.toHaveBeenCalled();
  });

  it("projects only the provider-verified access scope while a new saved observation remains explicit", () => {
    expect(projectVerifiedAccessScope(agent, { target: "availability", mode: "replace", scope: "none", principals: [] })).toMatchObject({ availableTo: "none", deployedTo: "none" });
    expect(projectVerifiedAccessScope(agent, { target: "installation", mode: "replace", scope: "specific", principals: [{ resourceType: "user", resourceId: "user-2" }] })).toMatchObject({ availableTo: "some", deployedTo: "some" });
  });
});

function mutationConfirmation(operation: "block" | "unblock" | "update-availability"): BulkConfirmation {
  return {
    action: operation,
    ...(operation === "update-availability" ? { accessUpdate: { target: "availability" as const, mode: "replace" as const, scope: "none" as const, principals: [] } } : {}),
    ids: [agent.id],
    mutationScope: "single",
    preview: {
      confirmationHash: "a".repeat(64),
      summary: {
        risk: true, operation, provider: "Microsoft Graph",
        endpoint: operation === "update-availability" ? "PATCH /beta/copilot/admin/catalog/packages/{id}/access" : `POST /beta/copilot/admin/catalog/packages/{id}/${operation}`,
        apiMaturity: "preview", permission: "Delegated CopilotPackages.ReadWrite.All",
        actor: { id: user.homeAccountId, displayName: user.displayName, username: user.username },
        scope: "single", targetCount: 1, affectedPrincipalCount: 1,
        rollback: "Possible through a separately confirmed inverse operation after provider readback.",
        targetSelectionHash: "b".repeat(64),
        targets: [{ id: agent.id, displayName: agent.displayName, currentState: { kind: "block", isBlocked: operation === "unblock" }, requestedState: { kind: "block", isBlocked: operation !== "unblock" } }],
        additionalTargetCount: 0,
      },
    },
  };
}

function capability(id: CapabilityId, status: CapabilityView["decision"]["status"]): CapabilityView {
  const definition = capabilityDefinitions.find(item => item.id === id)!;
  return {
    definition,
    decision: {
      capabilityId: id,
      status,
      authorized: status === "available",
      fresh: true,
      verification: "provider",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      previewQualification: "not_required",
      remediation: [],
    },
  };
}

function onDemandCapability(id: CapabilityId): CapabilityView {
  return {
    definition: capabilityDefinitions.find(item => item.id === id)!,
    decision: { capabilityId: id, status: "available", authorized: true, fresh: true, verification: "on_demand", previewQualification: "not_required", remediation: [] },
  };
}

function renderWithCapabilities(children: React.ReactNode, views: CapabilityView[], currentUser = user) {
  return render(<CapabilityContext value={{ views, user: currentUser, loading: false, pending: false, error: undefined, now: Date.now(), reload: vi.fn(), openPermissions: vi.fn() }}><WorkbenchActionProvider value={workbenchActions}>{children}</WorkbenchActionProvider></CapabilityContext>);
}