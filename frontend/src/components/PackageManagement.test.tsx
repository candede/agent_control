import { render, screen } from "@testing-library/react";
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
  roles: ["AgentControl.Reader", "AgentControl.Operator"],
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
  it("keeps saved reads usable while preview controls remain visibly disabled", () => {
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
      [capability("graph.package.read.delegated", "available"), capability("graph.package.access.manage", "preview_disabled"), capability("graph.package.block.manage", "preview_disabled")],
    );

    expect(screen.getByRole("button", { name: "View details for Research assistant" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Manage access for Research assistant" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Manage access for Research assistant" })).toHaveAccessibleDescription(/no If-Match or equivalent lost-update protection/i);
    expect(screen.getByRole("button", { name: "Block Research assistant" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Reassign owner for Research assistant" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Reassign owner for Research assistant" })).toHaveAccessibleDescription(/no owner readback field or conditional-write protection/i);
    expect(screen.getByRole("link", { name: "Reassignment documentation for Research assistant" })).toHaveAttribute("href", "https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/api/admin-settings/package/copilotpackage-reassign");
  });

  it("shows package source, maturity, deployment, freshness, and distinct block semantics", () => {
    renderWithCapabilities(
      <AgentDetailModal agent={agent} activeTab="package" onClose={vi.fn()} onUpdateAccess={vi.fn()} />,
      [capability("graph.package.access.manage", "preview_disabled")],
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
      [capability("graph.package.access.manage", "preview_disabled")],
    );

    await input.click(screen.getByRole("tab", { name: "Identities" }));
    expect(screen.getByRole("heading", { name: "Exact package identities and provenance" })).toBeInTheDocument();
    expect(screen.getByText(/not substituted as another source's native target/)).toBeInTheDocument();
    expect(screen.getByText("graph_packages · ga · displayName")).toBeInTheDocument();
  });

  it("confirms the complete server-issued mutation summary", async () => {
    const confirmation: BulkConfirmation = {
      action: "block",
      ids: [agent.id],
      mutationScope: "single",
      preview: {
        confirmationHash: "a".repeat(64),
        summary: {
          risk: true,
          operation: "block",
          provider: "Microsoft Graph",
          endpoint: "POST /beta/copilot/admin/catalog/packages/{id}/block",
          apiMaturity: "preview",
          permission: "Delegated CopilotPackages.ReadWrite.All",
          actor: { id: user.homeAccountId, displayName: user.displayName, username: user.username },
          scope: "single",
          targetCount: 1,
          affectedPrincipalCount: 1,
          rollback: "Possible through a separately confirmed inverse operation after provider readback.",
          targetSelectionHash: "b".repeat(64),
          targets: [{ id: agent.id, displayName: agent.displayName, currentState: { kind: "block", isBlocked: false }, requestedState: { kind: "block", isBlocked: true } }],
          additionalTargetCount: 0,
        },
      },
    };
    const confirm = vi.fn();
    renderWithCapabilities(<BulkConfirmModal confirmation={confirmation} onCancel={vi.fn()} onConfirm={confirm} />, [capability("graph.package.block.manage", "available", "qualified")]);

    expect(screen.getByText("Microsoft Graph")).toBeInTheDocument();
    expect(screen.getByText("Preview write risk")).toBeInTheDocument();
    expect(screen.getByText("Delegated CopilotPackages.ReadWrite.All")).toBeInTheDocument();
    expect(screen.getByText(/Current:/)).toHaveTextContent('"isBlocked":false');
    expect(screen.getByText(/Requested:/)).toHaveTextContent('"isBlocked":true');
    expect(screen.getByText(/separately confirmed inverse operation/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Confirm block" }));
    expect(confirm).toHaveBeenCalledOnce();
  });

  it("projects only the provider-verified access scope while a new saved observation remains explicit", () => {
    expect(projectVerifiedAccessScope(agent, { target: "availability", mode: "replace", scope: "none", principals: [] })).toMatchObject({ availableTo: "none", deployedTo: "none" });
    expect(projectVerifiedAccessScope(agent, { target: "installation", mode: "replace", scope: "specific", principals: [{ resourceType: "user", resourceId: "user-2" }] })).toMatchObject({ availableTo: "some", deployedTo: "some" });
  });
});

function capability(id: CapabilityId, status: CapabilityView["decision"]["status"], previewQualification: CapabilityView["decision"]["previewQualification"] = "unqualified"): CapabilityView {
  const definition = capabilityDefinitions.find(item => item.id === id)!;
  return {
    definition,
    decision: {
      capabilityId: id,
      status,
      authorized: status === "available",
      fresh: true,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      previewQualification,
      remediation: [],
    },
  };
}

function renderWithCapabilities(children: React.ReactNode, views: CapabilityView[]) {
  return render(<CapabilityContext value={{ views, user, loading: false, pending: undefined, error: undefined, now: Date.now(), reload: vi.fn(), refresh: vi.fn(), openPermissions: vi.fn() }}><WorkbenchActionProvider value={workbenchActions}>{children}</WorkbenchActionProvider></CapabilityContext>);
}