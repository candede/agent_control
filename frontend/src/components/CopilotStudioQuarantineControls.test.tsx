import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { capabilityDefinitions } from "../../../backend/src/services/capabilityRegistry";
import { workbenchActions } from "../../../backend/src/services/workbenchMetadata";
import { previewQuarantine, submitQuarantine, type CapabilityView, type QuarantinePreview, type SessionUser } from "../api/client";
import { CapabilityContext } from "../capabilityContext";
import { WorkbenchActionProvider } from "../workbenchActionContext";
import { CopilotStudioQuarantineControls } from "./CopilotStudioQuarantineControls";

vi.mock("../api/client", async importOriginal => ({
  ...await importOriginal<typeof import("../api/client")>(),
  previewQuarantine: vi.fn(), submitQuarantine: vi.fn(),
}));

const user: SessionUser = { homeAccountId: "admin-a", displayName: "Admin", username: "admin@example.invalid", roles: ["AgentControl.Admin"] };
const environmentId = "11111111-1111-4111-8111-111111111111";
const botId = "22222222-2222-4222-8222-222222222222";
const snapshot = { id: "snapshot-a", observedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() };
const target = {
  nativeId: "native-agent", displayName: "Test agent", type: "microsoft.copilotstudio/agents" as const, environmentId,
  identifiers: [{ kind: "environment_id" as const, value: environmentId }, { kind: "cds_bot_id" as const, value: botId }],
  details: { isQuarantined: false },
};

function onDemandDecision(): CapabilityView {
  return {
    definition: capabilityDefinitions.find(item => item.id === "powerPlatform.quarantine.manage")!,
    decision: {
      capabilityId: "powerPlatform.quarantine.manage", status: "available", authorized: true, fresh: true,
      verification: "on_demand", previewQualification: "not_required", remediation: [],
    },
  };
}

function renderControls(view: CapabilityView, currentUser = user) {
  const content = <CopilotStudioQuarantineControls snapshot={snapshot} targets={[target]} variant="detail" canManage />;
  const wrap = (next: CapabilityView, actor: SessionUser) => <CapabilityContext value={{
    views: [next], user: actor, now: Date.now(), loading: false, pending: false, error: undefined, reload: vi.fn(), openPermissions: vi.fn(),
  }}><WorkbenchActionProvider value={workbenchActions}>{content}</WorkbenchActionProvider></CapabilityContext>;
  const result = render(wrap(view, currentUser));
  return { ...result, changeDecision: (next: CapabilityView, actor = currentUser) => result.rerender(wrap(next, actor)) };
}

function preview(): QuarantinePreview {
  return {
    confirmationHash: "c".repeat(64),
    statuses: [{
      target: { resourceNativeId: target.nativeId, displayName: target.displayName, environmentId, botId },
      direct: { isBotQuarantined: false, providerUpdatedAt: snapshot.observedAt, observedAt: snapshot.observedAt, correlationId: "status-a", source: "provider" },
      inventory: { isQuarantined: false, quarantinedAt: null, observedAt: snapshot.observedAt, snapshotId: snapshot.id },
      disagreesWithInventory: false,
    }],
    summary: {
      risk: true, operation: "quarantine", provider: "Power Platform Copilot Studio", endpoint: "api-version=1 botQuarantine",
      permission: "Delegated CopilotStudio.AdminActions.Invoke", targetCount: 1, targetSelectionHash: "d".repeat(64),
      actor: { id: user.homeAccountId, displayName: user.displayName, username: user.username }, packageControlIndependent: true,
      makerBehavior: "Makers may still see and test this bot while connected channels cannot use it.", providerAtomicity: false,
      targets: [{ resourceNativeId: target.nativeId, displayName: target.displayName, environmentId, botId, currentState: false, requestedState: true, currentProviderUpdatedAt: snapshot.observedAt, inventoryState: false, inventoryObservedAt: snapshot.observedAt }],
      additionalTargetCount: 0,
    },
  };
}

describe("on-demand quarantine changes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(previewQuarantine).mockResolvedValue(preview());
    vi.mocked(submitQuarantine).mockResolvedValue({
      id: "job-a", action: "quarantine", status: "succeeded", confirmationHash: "c".repeat(64), confirmation: preview().summary,
      isCanary: false, total: 1, completed: 1, succeeded: 1, failed: 0, skipped: 0, inconclusive: 0, cancelled: 0,
      canResume: false, canReconcile: false, createdAt: snapshot.observedAt, updatedAt: snapshot.observedAt, results: [],
    });
  });

  it("permits an ordinary change only after exact-target confirmation", async () => {
    const result = preview();
    vi.mocked(previewQuarantine).mockResolvedValue(result);
    renderControls(onDemandDecision());
    expect(screen.getByRole("button", { name: "Quarantine" })).toBeEnabled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(previewQuarantine).not.toHaveBeenCalled();
    expect(submitQuarantine).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Quarantine" }));
    const dialog = await screen.findByRole("dialog", { name: "Quarantine 1 agent" });
    expect(within(dialog).getByText("Not provider-atomic; each target is verified independently")).toBeVisible();
    expect(within(dialog).getByRole("checkbox")).toBeEnabled();
    expect(within(dialog).getByRole("button", { name: "Confirm quarantine" })).toBeDisabled();
    expect(submitQuarantine).not.toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole("checkbox"));
    await userEvent.click(within(dialog).getByRole("button", { name: "Confirm quarantine" }));
    expect(submitQuarantine).toHaveBeenCalledWith({
      action: "quarantine", snapshotId: snapshot.id, resourceNativeIds: [target.nativeId], confirmationHash: result.confirmationHash,
    }, expect.stringMatching(/^[0-9a-f-]{36}$/));
  });

  it.each(["viewer", "stale", "missing-permission", "forged-read"] as const)("does not bypass %s gating", async scenario => {
    const decision = onDemandDecision();
    if (scenario === "stale") decision.decision.fresh = false;
    if (scenario === "missing-permission") decision.decision.status = "missing_permission";
    if (scenario === "forged-read") {
      decision.definition = capabilityDefinitions.find(item => item.id === "powerPlatform.quarantine.read")!;
      decision.decision.capabilityId = decision.definition.id;
    }
    renderControls(decision, scenario === "viewer" ? { ...user, roles: ["AgentControl.Viewer"] } : user);
    expect(screen.getByRole("button", { name: "Quarantine" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Quarantine" }));
    expect(previewQuarantine).not.toHaveBeenCalled();
    expect(submitQuarantine).not.toHaveBeenCalled();
  });

  it.each(["missing-permission", "viewer", "stale"] as const)("blocks an already confirmed preview after %s", async scenario => {
    const state = renderControls(onDemandDecision());
    await userEvent.click(screen.getByRole("button", { name: "Quarantine" }));
    const dialog = await screen.findByRole("dialog", { name: "Quarantine 1 agent" });
    await userEvent.click(within(dialog).getByRole("checkbox"));
    const decision = onDemandDecision();
    if (scenario === "missing-permission") decision.decision.status = "missing_permission";
    if (scenario === "stale") decision.decision.fresh = false;
    state.changeDecision(decision, scenario === "viewer" ? { ...user, roles: ["AgentControl.Viewer"] } : user);
    expect(within(dialog).getByRole("button", { name: "Confirm quarantine" })).toBeDisabled();
    await userEvent.click(within(dialog).getByRole("button", { name: "Confirm quarantine" }));
    expect(submitQuarantine).not.toHaveBeenCalled();
  });
});
