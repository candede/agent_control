import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type ComponentProps } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { capabilityDefinitions } from "../../../backend/src/services/capabilityRegistry";
import { workbenchActions } from "../../../backend/src/services/workbenchMetadata";
import { getQuarantineJobs, previewQuarantine, submitQuarantine, type CapabilityView, type QuarantineJob, type QuarantinePreview, type SessionUser } from "../api/client";
import { CapabilityContext } from "../capabilityContext";
import { WorkbenchActionProvider } from "../workbenchActionContext";
import { CopilotStudioQuarantineControls } from "./CopilotStudioQuarantineControls";

vi.mock("../api/client", async importOriginal => ({
  ...await importOriginal<typeof import("../api/client")>(),
  getQuarantineJobs: vi.fn(), previewQuarantine: vi.fn(), submitQuarantine: vi.fn(),
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

function renderControls(view: CapabilityView, currentUser = user, props: Partial<ComponentProps<typeof CopilotStudioQuarantineControls>> = {}) {
  const content = <CopilotStudioQuarantineControls snapshot={snapshot} targets={[target]} variant="detail" canManage {...props} />;
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
    vi.mocked(getQuarantineJobs).mockResolvedValue({ value: [] });
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

  it.each([false, true])("keeps detail guidance concise and shows a disagreement warning only when observed (%s)", async disagreesWithInventory => {
    const result = preview();
    result.statuses[0].disagreesWithInventory = disagreesWithInventory;
    result.statuses[0].direct.isBotQuarantined = disagreesWithInventory;
    result.summary.targets[0].currentState = disagreesWithInventory;
    vi.mocked(previewQuarantine).mockResolvedValue(result);
    renderControls(onDemandDecision());
    expect(screen.getByText("Quarantine blocks connected channels; makers can still test in Copilot Studio. Package blocking is separate.")).toBeVisible();
    expect(screen.getByText("Check direct status to load.")).toBeVisible();
    expect(screen.queryByText(/Direct provider state and saved inventory state remain independent|A timestamp is evidence, not provider atomicity/)).not.toBeInTheDocument();
    expect(screen.queryByText("Direct and inventory states disagree.")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Quarantine" }));
    const confirmation = await screen.findByRole("dialog", { name: "Quarantine 1 agent" });
    expect(within(confirmation).getByText("Not provider-atomic; each target is verified independently")).toBeVisible();
    expect(within(confirmation).getByText(result.summary.makerBehavior)).toBeVisible();
    await userEvent.click(within(confirmation).getByRole("button", { name: "Close quarantine confirmation" }));
    if (disagreesWithInventory) expect(screen.getByText("Direct and inventory states disagree.")).toBeVisible();
    else expect(screen.queryByText("Direct and inventory states disagree.")).not.toBeInTheDocument();
    expect(submitQuarantine).not.toHaveBeenCalled();
  });

  it.each([0, 1])("does not preview %s resolved targets while bookmarks are pending and permits cancellation", async count => {
    const onClear = vi.fn();
    renderControls(onDemandDecision(), user, { variant: "bulk", targets: count ? [target] : [], pendingTargetCount: 2, onClear });
    expect(screen.getByText(/Restoring 2 bookmarked quarantine selections/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Quarantine selected" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Restore selected" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Clear" })).toBeEnabled();
    await userEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(onClear).toHaveBeenCalledOnce();
    expect(previewQuarantine).not.toHaveBeenCalled();
    expect(submitQuarantine).not.toHaveBeenCalled();
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

  it("keeps the submitted durable job mounted after clearing its targets", async () => {
    const onJobChange = vi.fn<(job: QuarantineJob) => void>();
    function Harness() {
      const [targets, setTargets] = useState([target]);
      return <CopilotStudioQuarantineControls
        snapshot={snapshot}
        targets={targets}
        variant="bulk"
        canManage
        onClear={() => setTargets([])}
        onJobChange={onJobChange}
      />;
    }
    render(<CapabilityContext value={{
      views: [onDemandDecision()], user, now: Date.now(), loading: false, pending: false,
      error: undefined, reload: vi.fn(), openPermissions: vi.fn(),
    }}>
      <WorkbenchActionProvider value={workbenchActions}><Harness /></WorkbenchActionProvider>
    </CapabilityContext>);

    await userEvent.click(screen.getByRole("button", { name: "Quarantine selected" }));
    const confirmation = await screen.findByRole("dialog", { name: "Quarantine 1 agent" });
    await userEvent.click(within(confirmation).getByRole("checkbox"));
    await userEvent.click(within(confirmation).getByRole("button", { name: "Confirm quarantine" }));

    expect(await screen.findByText("Quarantine job: Succeeded")).toBeInTheDocument();
    expect(screen.getByText("0 of 25 exact Copilot Studio agents selected")).toBeInTheDocument();
    expect(onJobChange).toHaveBeenCalledWith(expect.objectContaining({ id: "job-a" }));
  });
});
