import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { capabilityDefinitions } from "../../../backend/src/services/capabilityRegistry";
import { workbenchActions } from "../../../backend/src/services/workbenchMetadata";
import { cancelQuarantineJob, getQuarantineJob, getQuarantineJobs, getQuarantineStatus, previewQuarantine, reconcileQuarantineJob, resumeQuarantineJob, submitQuarantine, type CapabilityView, type QuarantineJob, type QuarantinePreview, type SessionUser } from "../api/client";
import { CapabilityContext } from "../capabilityContext";
import { deferred } from "../test/deferred";
import { WorkbenchActionProvider } from "../workbenchActionContext";
import { CopilotStudioQuarantineControls } from "./CopilotStudioQuarantineControls";

vi.mock("../api/client", async importOriginal => ({
  ...await importOriginal<typeof import("../api/client")>(),
  getQuarantineJob: vi.fn(), getQuarantineJobs: vi.fn(), previewQuarantine: vi.fn(), submitQuarantine: vi.fn(),
  cancelQuarantineJob: vi.fn(), resumeQuarantineJob: vi.fn(), reconcileQuarantineJob: vi.fn(),
  getQuarantineStatus: vi.fn(),
}));

const user: SessionUser = { homeAccountId: "admin-a", displayName: "Admin", username: "admin@example.invalid", roles: ["AgentControl.Admin"] };
const environmentId = "11111111-1111-4111-8111-111111111111";
const botId = "22222222-2222-4222-8222-222222222222";
const snapshot = { id: "snapshot-a", observedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() };
const target = {
  nativeId: "native-agent", displayName: "Test agent", type: "microsoft.copilotstudio/agents" as const, environmentId,
  identifiers: [{ kind: "environment_id" as const, value: environmentId }, { kind: "cds_bot_id" as const, value: botId }],
  quarantineIdentity: { environmentId, botId },
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
  const wrap = (next: CapabilityView, actor: SessionUser, overrides = props) => <CapabilityContext value={{
    views: [next, {
      ...onDemandDecision(), definition: capabilityDefinitions.find(item => item.id === "powerPlatform.quarantine.read")!,
      decision: { ...onDemandDecision().decision, capabilityId: "powerPlatform.quarantine.read",
        verification: "provider", checkedAt: snapshot.observedAt, expiresAt: snapshot.expiresAt },
    }], user: actor, now: Date.now(), loading: false, pending: false, error: undefined, reload: vi.fn(), openPermissions: vi.fn(),
  }}><WorkbenchActionProvider value={workbenchActions}>
    <CopilotStudioQuarantineControls snapshot={snapshot} targets={[target]} variant="detail" canManage {...overrides} />
  </WorkbenchActionProvider></CapabilityContext>;
  const result = render(wrap(view, currentUser));
  return { ...result,
    changeDecision: (next: CapabilityView, actor = currentUser) => result.rerender(wrap(next, actor)),
    changeProps: (next: Partial<ComponentProps<typeof CopilotStudioQuarantineControls>>) => result.rerender(wrap(view, currentUser, { ...props, ...next })),
  };
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

function completedJob(): QuarantineJob {
  return {
    id: "job-a", action: "quarantine", status: "succeeded", confirmationHash: "c".repeat(64), confirmation: preview().summary,
    isCanary: false, total: 1, completed: 1, succeeded: 1, failed: 0, skipped: 0, inconclusive: 0, cancelled: 0,
    canResume: false, canReconcile: false, createdAt: snapshot.observedAt, updatedAt: snapshot.observedAt, results: [],
  };
}

describe("on-demand quarantine changes", () => {
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(getQuarantineJobs).mockResolvedValue({ value: [] });
    vi.mocked(previewQuarantine).mockResolvedValue(preview());
    vi.mocked(submitQuarantine).mockResolvedValue(completedJob());
    vi.mocked(getQuarantineStatus).mockResolvedValue(preview().statuses[0]);
  });

  it.each(["status", "preview"] as const)("admits only one pending %s request, including same-tick clicks", async operation => {
    const status = deferred<ReturnType<typeof preview>["statuses"][number]>();
    const confirmation = deferred<QuarantinePreview>();
    vi.mocked(getQuarantineStatus).mockReturnValue(status.promise);
    vi.mocked(previewQuarantine).mockReturnValue(confirmation.promise);
    renderControls(onDemandDecision());
    const button = screen.getByRole("button", { name: operation === "status" ? "Check direct status" : "Quarantine" });
    act(() => { fireEvent.click(button); fireEvent.click(button); });
    const request = operation === "status" ? getQuarantineStatus : previewQuarantine;
    expect(request).toHaveBeenCalledTimes(1);
    expect(button).toBeDisabled();
    expect(screen.getByText(operation === "status" ? "Checking direct quarantine status..." : "Preparing exact-target confirmation...")).toBeVisible();
    await act(async () => { status.resolve(preview().statuses[0]); confirmation.resolve(preview()); });
    expect(screen.queryByText(/Checking direct quarantine status|Preparing exact-target confirmation/)).not.toBeInTheDocument();
  });

  it("admits only one explicit job refresh per pending request", async () => {
    const pending = deferred<QuarantineJob>();
    vi.mocked(getQuarantineJob).mockResolvedValueOnce(completedJob()).mockReturnValue(pending.promise);
    renderControls(onDemandDecision(), user, { variant: "bulk", initialJobId: "job-a" });
    const button = await screen.findByRole("button", { name: "Refresh job status" });
    act(() => { fireEvent.click(button); fireEvent.click(button); });
    expect(getQuarantineJob).toHaveBeenCalledTimes(2);
    await act(async () => pending.resolve(completedJob()));
    expect(button).toBeEnabled();
  });

  it("shows pending job restoration and permits an explicit retry after failure", async () => {
    const pending = deferred<QuarantineJob>();
    vi.mocked(getQuarantineJob).mockReturnValueOnce(pending.promise).mockResolvedValue(completedJob());
    renderControls(onDemandDecision(), user, { variant: "bulk", initialJobId: "job-a" });
    expect(await screen.findByText("Loading quarantine job...")).toBeVisible();
    await act(async () => pending.reject(new Error("Saved job temporarily unavailable.")));
    expect(screen.queryByText("Loading quarantine job...")).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Saved job temporarily unavailable.");
    await userEvent.click(screen.getByRole("button", { name: "Retry quarantine job" }));
    expect(await screen.findByText("Quarantine job: Succeeded")).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(getQuarantineJob).toHaveBeenCalledTimes(2);
  });

  it("does not reload the submitted job when its owner echoes the tracked ID", async () => {
    const onJobChange = vi.fn();
    function Harness() {
      const [initialJobId, setInitialJobId] = useState<string>();
      return <CopilotStudioQuarantineControls snapshot={snapshot} targets={[target]} variant="bulk" canManage
        initialJobId={initialJobId} onJobChange={job => { onJobChange(job); setInitialJobId(job.id); }} />;
    }
    render(<CapabilityContext value={{
      views: [onDemandDecision()], user, now: Date.now(), loading: false, pending: false,
      error: undefined, reload: vi.fn(), openPermissions: vi.fn(),
    }}><WorkbenchActionProvider value={workbenchActions}><Harness /></WorkbenchActionProvider></CapabilityContext>);
    await userEvent.click(screen.getByRole("button", { name: "Quarantine selected" }));
    const dialog = await screen.findByRole("dialog", { name: "Quarantine 1 agent" });
    await userEvent.click(within(dialog).getByRole("checkbox"));
    await userEvent.click(within(dialog).getByRole("button", { name: "Confirm quarantine" }));
    expect(await screen.findByText("Quarantine job: Succeeded")).toBeVisible();
    expect(onJobChange).toHaveBeenCalledExactlyOnceWith(completedJob());
    expect(getQuarantineJob).not.toHaveBeenCalled();
  });

  it.each(["waiting_authorization", "inconclusive"] as const)("permits cancelling remaining unsent targets in a %s job", async status => {
    const job = { ...completedJob(), status, total: 2, completed: 1, canResume: status === "waiting_authorization" };
    vi.mocked(getQuarantineJob).mockResolvedValue(job);
    vi.mocked(cancelQuarantineJob).mockResolvedValue({ ...job, status: "cancelled", completed: 2, cancelled: 1, canResume: false });
    renderControls(onDemandDecision(), user, { variant: "bulk", initialJobId: job.id });
    await userEvent.click(await screen.findByRole("button", { name: "Cancel unsent work" }));
    expect(cancelQuarantineJob).toHaveBeenCalledExactlyOnceWith(job.id, { signal: expect.any(AbortSignal) });
    expect(await screen.findByText("Quarantine job: Cancelled")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Cancel unsent work" })).not.toBeInTheDocument();
  });

  it("withdraws pre-mutation direct status instead of presenting it as current after submission", async () => {
    renderControls(onDemandDecision());
    await userEvent.click(screen.getByRole("button", { name: "Quarantine" }));
    const dialog = await screen.findByRole("dialog", { name: "Quarantine 1 agent" });
    await userEvent.click(within(dialog).getByRole("checkbox"));
    await userEvent.click(within(dialog).getByRole("button", { name: "Confirm quarantine" }));
    expect(await screen.findByText("Quarantine job: Succeeded")).toBeVisible();
    expect(screen.getByText("Not checked")).toBeVisible();
    expect(screen.getByRole("button", { name: "Check direct status" })).toBeEnabled();
    expect(getQuarantineStatus).not.toHaveBeenCalled();
  });

  it("does not restore older direct status when a job completes during the status read", async () => {
    const pending = deferred<ReturnType<typeof preview>["statuses"][number]>();
    vi.mocked(getQuarantineStatus).mockReturnValue(pending.promise);
    vi.mocked(submitQuarantine).mockResolvedValue({ ...completedJob(), status: "running", completed: 0, succeeded: 0 });
    vi.mocked(getQuarantineJob).mockResolvedValue({ ...completedJob(), updatedAt: new Date(Date.now() + 1000).toISOString() });
    renderControls(onDemandDecision());
    await userEvent.click(screen.getByRole("button", { name: "Quarantine" }));
    const dialog = await screen.findByRole("dialog", { name: "Quarantine 1 agent" });
    await userEvent.click(within(dialog).getByRole("checkbox"));
    await userEvent.click(within(dialog).getByRole("button", { name: "Confirm quarantine" }));
    await userEvent.click(screen.getByRole("button", { name: "Check direct status" }));
    await screen.findByText("Quarantine job: Succeeded", {}, { timeout: 2000 });
    await act(async () => pending.resolve(preview().statuses[0]));
    expect(screen.getByText("Not checked")).toBeVisible();
  });

  it("cancels preview evidence when the followed job changes the same targets", async () => {
    vi.useFakeTimers();
    const pending = deferred<QuarantinePreview>();
    const replacement = deferred<QuarantinePreview>();
    vi.mocked(previewQuarantine).mockReturnValueOnce(pending.promise).mockReturnValue(replacement.promise);
    vi.mocked(getQuarantineJob).mockResolvedValueOnce({ ...completedJob(), status: "running", completed: 0, succeeded: 0 })
      .mockResolvedValue({ ...completedJob(), updatedAt: new Date(Date.parse(snapshot.observedAt) + 1000).toISOString() });
    renderControls(onDemandDecision(), user, { variant: "bulk", initialJobId: "job-a" });
    await act(async () => {});
    act(() => fireEvent.click(screen.getByRole("button", { name: "Quarantine selected" })));
    const signal = vi.mocked(previewQuarantine).mock.calls[0][1]?.signal;
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(signal?.aborted).toBe(true);
    expect(screen.getByRole("button", { name: "Quarantine selected" })).toBeEnabled();
    expect(screen.getByRole("alert")).toHaveTextContent("Prepare a new confirmation");
    act(() => fireEvent.click(screen.getByRole("button", { name: "Quarantine selected" })));
    await act(async () => pending.resolve(preview()));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Quarantine selected" })).toBeDisabled();
    expect(screen.getByText("Preparing exact-target confirmation...")).toBeVisible();
    await act(async () => replacement.resolve(preview()));
    expect(screen.getByRole("dialog", { name: "Quarantine 1 agent" })).toBeVisible();
  });

  it.each([true, false])("invalidates a ready preview only when a changed job shares its targets (%s)", async related => {
    vi.useFakeTimers();
    const job = completedJob();
    if (!related) job.confirmation.targets[0].resourceNativeId = "another-target";
    vi.mocked(getQuarantineJob).mockResolvedValueOnce({ ...job, status: "running", completed: 0, succeeded: 0 })
      .mockResolvedValue({ ...job, updatedAt: new Date(Date.parse(snapshot.observedAt) + 1000).toISOString() });
    renderControls(onDemandDecision(), user, { variant: "bulk", initialJobId: job.id });
    await act(async () => {});
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Quarantine selected" })));
    const dialog = screen.getByRole("dialog", { name: "Quarantine 1 agent" });
    act(() => fireEvent.click(within(dialog).getByRole("checkbox")));
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    const confirm = within(dialog).getByRole("button", { name: "Confirm quarantine" });
    if (related) {
      expect(confirm).toBeDisabled();
      expect(within(dialog).getByRole("alert")).toHaveTextContent("Prepare a new confirmation");
      act(() => fireEvent.click(confirm));
      expect(submitQuarantine).not.toHaveBeenCalled();
    } else {
      expect(confirm).toBeEnabled();
      expect(within(dialog).queryByRole("alert")).not.toBeInTheDocument();
    }
  });

  it("keeps a stopped job follower's error separate from selection requests and confirmation errors", async () => {
    vi.useFakeTimers();
    vi.mocked(getQuarantineJob).mockResolvedValueOnce({ ...completedJob(), status: "running", completed: 0, succeeded: 0 })
      .mockRejectedValue(new Error("Polling unavailable."));
    vi.mocked(submitQuarantine).mockRejectedValue(new Error("Submission unavailable."));
    renderControls(onDemandDecision(), user, { variant: "bulk", initialJobId: "job-a" });
    await act(async () => {});
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(screen.getByRole("alert")).toHaveTextContent("Polling unavailable.");
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Quarantine selected" })));
    const dialog = screen.getByRole("dialog", { name: "Quarantine 1 agent" });
    expect(within(dialog).queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Polling unavailable.");
    act(() => fireEvent.click(within(dialog).getByRole("checkbox")));
    await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "Confirm quarantine" })));
    expect(within(dialog).getByRole("alert")).toHaveTextContent("Submission unavailable.");
    expect(screen.getAllByRole("alert")).toHaveLength(2);
  });

  it.each(["preview", "submit", "preview-response"] as const)("rejects expired snapshot evidence at the %s boundary without waiting for the timer", async boundary => {
    const pending = deferred<QuarantinePreview>();
    if (boundary === "preview-response") vi.mocked(previewQuarantine).mockReturnValue(pending.promise);
    renderControls(onDemandDecision(), user, { variant: "bulk" });
    if (boundary !== "preview") {
      await userEvent.click(screen.getByRole("button", { name: "Quarantine selected" }));
      if (boundary === "submit") await userEvent.click(within(screen.getByRole("dialog")).getByRole("checkbox"));
    }
    vi.spyOn(Date, "now").mockReturnValue(Date.parse(snapshot.expiresAt) + 1);
    if (boundary === "preview-response") await act(async () => pending.resolve(preview()));
    else act(() => fireEvent.click(screen.getByRole("button", {
      name: boundary === "preview" ? "Quarantine selected" : "Confirm quarantine",
    })));
    expect(submitQuarantine).not.toHaveBeenCalled();
    if (boundary === "preview") expect(previewQuarantine).not.toHaveBeenCalled();
    if (boundary === "preview-response") expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getAllByText(/saved inventory target is stale/).length).toBeGreaterThan(0);
  });

  it.each(["bot", "qualification", "historical"] as const)("retires a pending preview when its %s proof changes within the same snapshot", async change => {
    const pending = deferred<QuarantinePreview>();
    vi.mocked(previewQuarantine).mockReturnValue(pending.promise);
    const controls = renderControls(onDemandDecision(), user, { variant: "bulk" });
    await userEvent.click(screen.getByRole("button", { name: "Quarantine selected" }));
    const signal = vi.mocked(previewQuarantine).mock.calls[0][1]?.signal;
    controls.changeProps(change === "historical" ? { snapshot: { ...snapshot, current: false } } : {
      targets: [{ ...target, ...(change === "bot"
        ? { quarantineIdentity: { environmentId, botId: "33333333-3333-4333-8333-333333333333" } }
        : { quarantineEligibility: { eligible: false, reason: "Exact bot identity was withdrawn." } }) }],
    });
    expect(signal?.aborted).toBe(true);
    await act(async () => pending.resolve(preview()));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(submitQuarantine).not.toHaveBeenCalled();
  });

  it("does not resurrect a retired selection error when that target is selected again", async () => {
    vi.mocked(previewQuarantine).mockRejectedValue(new Error("Old preview unavailable."));
    const controls = renderControls(onDemandDecision(), user, { variant: "bulk" });
    await userEvent.click(screen.getByRole("button", { name: "Quarantine selected" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Old preview unavailable.");
    controls.changeProps({ targets: [{ ...target, nativeId: "replacement" }] });
    controls.changeProps({ targets: [target] });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("preserves a pending preview through equivalent reordered native identities and label updates", async () => {
    const pending = deferred<QuarantinePreview>();
    vi.mocked(previewQuarantine).mockReturnValue(pending.promise);
    const second = { ...target, nativeId: "second-native", environmentId: "abcdefab-1111-4111-8111-111111111111",
      quarantineIdentity: { environmentId: "abcdefab-1111-4111-8111-111111111111", botId: "abcdefab-2222-4222-8222-222222222222" } };
    const controls = renderControls(onDemandDecision(), user, { variant: "bulk", targets: [target, second] });
    await userEvent.click(screen.getByRole("button", { name: "Quarantine selected" }));
    const signal = vi.mocked(previewQuarantine).mock.calls[0][1]?.signal;
    controls.changeProps({ targets: [{ ...second, displayName: "New label", environmentId: second.environmentId.toUpperCase(),
      quarantineIdentity: { environmentId: second.environmentId.toUpperCase(), botId: second.quarantineIdentity.botId.toUpperCase() } }, target] });
    expect(signal?.aborted).toBe(false);
    expect(previewQuarantine).toHaveBeenCalledOnce();
    const result = preview();
    const identity = { resourceNativeId: second.nativeId, displayName: second.displayName, ...second.quarantineIdentity };
    result.statuses.push({ ...result.statuses[0], target: identity });
    result.summary.targetCount = 2;
    result.summary.targets.push({ ...result.summary.targets[0], ...identity });
    await act(async () => pending.resolve(result));
    expect(screen.getByRole("dialog")).toBeVisible();
  });

  it.each(["detail", "bulk"] as const)("keeps a %s preview and its frozen native ID through GUID casing changes", async variant => {
    const pending = deferred<QuarantinePreview>();
    vi.mocked(previewQuarantine).mockReturnValue(pending.promise);
    const nativeId = "abcdefab-2222-4222-8222-222222222222";
    const controls = renderControls(onDemandDecision(), user, { variant, targets: [{ ...target, nativeId }] });
    await userEvent.click(screen.getByRole("button", { name: variant === "detail" ? "Quarantine" : "Quarantine selected" }));
    const signal = vi.mocked(previewQuarantine).mock.calls[0][1]?.signal;
    controls.changeProps({ targets: [{ ...target, nativeId: nativeId.toUpperCase() }] });
    expect(signal?.aborted).toBe(false);
    const result = preview();
    result.summary.targets[0].resourceNativeId = nativeId;
    result.statuses[0].target.resourceNativeId = nativeId;
    await act(async () => pending.resolve(result));
    const dialog = screen.getByRole("dialog");
    await userEvent.click(within(dialog).getByRole("checkbox"));
    await userEvent.click(within(dialog).getByRole("button", { name: "Confirm quarantine" }));
    expect(previewQuarantine).toHaveBeenCalledOnce();
    expect(submitQuarantine).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      resourceNativeIds: [nativeId],
    }), expect.any(String), { signal: expect.any(AbortSignal) });
  });

  it("accepts new current evidence without waiting for the minute tick", async () => {
    const controls = renderControls(onDemandDecision());
    vi.spyOn(Date, "now").mockReturnValue(Date.parse(snapshot.observedAt) + 10_000);
    controls.changeProps({ snapshot: { ...snapshot, observedAt: new Date(Date.now()).toISOString() } });
    expect(screen.getByRole("button", { name: "Quarantine" })).toBeEnabled();
    await userEvent.click(screen.getByRole("button", { name: "Quarantine" }));
    expect(previewQuarantine).toHaveBeenCalledOnce();
  });

  it("keeps detail job recovery available when the replacement snapshot has invalid timestamps", async () => {
    const controls = renderControls(onDemandDecision());
    await userEvent.click(screen.getByRole("button", { name: "Quarantine" }));
    const dialog = screen.getByRole("dialog");
    await userEvent.click(within(dialog).getByRole("checkbox"));
    await userEvent.click(within(dialog).getByRole("button", { name: "Confirm quarantine" }));
    controls.changeProps({ snapshot: { ...snapshot, observedAt: "invalid" } });
    expect(screen.getByRole("button", { name: "Quarantine" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Refresh job status" })).toBeEnabled();
    expect(screen.getByText("Quarantine job: Succeeded")).toBeVisible();
  });

  it("cancels a pending preview when management is withdrawn and does not restore it on recovery", async () => {
    const pending = deferred<QuarantinePreview>();
    vi.mocked(previewQuarantine).mockReturnValue(pending.promise);
    const controls = renderControls(onDemandDecision());
    await userEvent.click(screen.getByRole("button", { name: "Quarantine" }));
    const signal = vi.mocked(previewQuarantine).mock.calls[0][1]?.signal;
    controls.changeProps({ canManage: false });
    expect(signal?.aborted).toBe(true);
    controls.changeProps({ canManage: true });
    await act(async () => pending.resolve(preview()));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Quarantine" })).toBeEnabled();
  });

  it.each(["success", "failure"] as const)("cancels a retired selection preview and ignores its late %s without blocking the replacement", async outcome => {
    const retired = deferred<QuarantinePreview>();
    vi.mocked(previewQuarantine).mockReturnValueOnce(retired.promise).mockResolvedValue(preview());
    const controls = renderControls(onDemandDecision(), user, { variant: "bulk" });
    await userEvent.click(screen.getByRole("button", { name: "Quarantine selected" }));
    const signal = vi.mocked(previewQuarantine).mock.calls[0][1]?.signal;
    controls.changeProps({ snapshot: { ...snapshot, id: "snapshot-b" } });
    expect(signal?.aborted).toBe(true);
    await userEvent.click(screen.getByRole("button", { name: "Quarantine selected" }));
    const dialog = await screen.findByRole("dialog", { name: "Quarantine 1 agent" });
    await userEvent.click(within(dialog).getByRole("checkbox"));
    await act(async () => {
      if (outcome === "success") retired.resolve({ ...preview(), confirmationHash: "retired" });
      else retired.reject(new Error("Retired preview failed."));
    });
    expect(within(dialog).getByRole("button", { name: "Confirm quarantine" })).toBeEnabled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Confirm quarantine" }));
    expect(submitQuarantine).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      snapshotId: "snapshot-b", confirmationHash: preview().confirmationHash,
    }), expect.any(String), { signal: expect.any(AbortSignal) });
  });

  it("keeps the frozen receipt and idempotency key for explicit submission retry", async () => {
    vi.mocked(submitQuarantine).mockRejectedValueOnce(new Error("Submission response unavailable.")).mockResolvedValue(completedJob());
    renderControls(onDemandDecision());
    await userEvent.click(screen.getByRole("button", { name: "Quarantine" }));
    const dialog = await screen.findByRole("dialog", { name: "Quarantine 1 agent" });
    await userEvent.click(within(dialog).getByRole("checkbox"));
    await userEvent.click(within(dialog).getByRole("button", { name: "Confirm quarantine" }));
    expect(within(dialog).getByRole("alert")).toHaveTextContent("Submission response unavailable.");
    expect(within(dialog).getByRole("button", { name: "Close" })).toBeEnabled();
    expect(within(dialog).getByText(/closing does not cancel submitted work/)).toBeVisible();
    expect(previewQuarantine).toHaveBeenCalledOnce();
    await userEvent.click(within(dialog).getByRole("button", { name: "Confirm quarantine" }));
    expect(submitQuarantine).toHaveBeenCalledTimes(2);
    const [first, second] = vi.mocked(submitQuarantine).mock.calls;
    expect(second.slice(0, 2)).toEqual(first.slice(0, 2));
    expect(await screen.findByText("Quarantine job: Succeeded")).toBeVisible();
  });

  it.each(["replacement", "cleared", "expired"] as const)("recovers an attempted bulk receipt after its selection is %s without clearing the newer selection", async boundary => {
    const pending = deferred<QuarantineJob>();
    vi.mocked(submitQuarantine).mockReturnValueOnce(pending.promise).mockResolvedValue(completedJob());
    const onClear = vi.fn();
    const controls = renderControls(onDemandDecision(), user, { variant: "bulk", onClear });
    await userEvent.click(screen.getByRole("button", { name: "Quarantine selected" }));
    const dialog = screen.getByRole("dialog");
    await userEvent.click(within(dialog).getByRole("checkbox"));
    await userEvent.click(within(dialog).getByRole("button", { name: "Confirm quarantine" }));
    const signal = vi.mocked(submitQuarantine).mock.calls[0][2]?.signal;
    controls.changeProps(boundary === "expired"
      ? { snapshot: { ...snapshot, expiresAt: "2020-01-01T00:00:00Z" } }
      : { targets: boundary === "cleared" ? [] : [{ ...target, nativeId: "replacement-agent" }] });
    expect(signal?.aborted).toBe(false);
    await act(async () => pending.reject(new Error("Submission response unavailable.")));
    const recovery = screen.getByRole("dialog");
    expect(within(recovery).getByRole("alert")).toHaveTextContent("Submission response unavailable.");
    expect(within(recovery).getByRole("checkbox")).not.toBeChecked();
    await userEvent.click(within(recovery).getByRole("checkbox"));
    await userEvent.click(within(recovery).getByRole("button", { name: "Confirm quarantine" }));
    expect(submitQuarantine).toHaveBeenCalledTimes(2);
    const [first, second] = vi.mocked(submitQuarantine).mock.calls;
    expect(second.slice(0, 2)).toEqual(first.slice(0, 2));
    expect(previewQuarantine).toHaveBeenCalledOnce();
    expect(onClear).not.toHaveBeenCalled();
    expect(screen.getByText("Quarantine job: Succeeded")).toBeVisible();
  });

  it("retains an attempted submission receipt when a previous job changes during recovery", async () => {
    vi.useFakeTimers();
    vi.mocked(getQuarantineJob).mockResolvedValueOnce({ ...completedJob(), status: "running", completed: 0, succeeded: 0 })
      .mockResolvedValue({ ...completedJob(), updatedAt: new Date(Date.parse(snapshot.observedAt) + 1000).toISOString() });
    vi.mocked(submitQuarantine).mockRejectedValueOnce(new Error("Submission response unavailable."))
      .mockResolvedValue({ ...completedJob(), id: "job-b" });
    renderControls(onDemandDecision(), user, { variant: "bulk", initialJobId: "job-a" });
    await act(async () => {});
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Quarantine selected" })));
    const dialog = screen.getByRole("dialog");
    act(() => fireEvent.click(within(dialog).getByRole("checkbox")));
    await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "Confirm quarantine" })));
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(within(dialog).getByRole("button", { name: "Confirm quarantine" })).toBeEnabled();
    expect(within(dialog).getByRole("alert")).toHaveTextContent("Submission response unavailable.");
    await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "Confirm quarantine" })));
    const [first, second] = vi.mocked(submitQuarantine).mock.calls;
    expect(second.slice(0, 2)).toEqual(first.slice(0, 2));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("releases a cancelled submission's busy state after management is restored", async () => {
    const pending = deferred<QuarantineJob>();
    vi.mocked(submitQuarantine).mockReturnValue(pending.promise);
    const onJobChange = vi.fn();
    const controls = renderControls(onDemandDecision(), user, { onJobChange });
    await userEvent.click(screen.getByRole("button", { name: "Quarantine" }));
    const dialog = screen.getByRole("dialog");
    await userEvent.click(within(dialog).getByRole("checkbox"));
    await userEvent.click(within(dialog).getByRole("button", { name: "Confirm quarantine" }));
    const signal = vi.mocked(submitQuarantine).mock.calls[0][2]?.signal;
    controls.changeProps({ canManage: false });
    expect(signal?.aborted).toBe(true);
    controls.changeProps({ canManage: true });
    expect(screen.getByRole("button", { name: "Quarantine" })).toBeEnabled();
    await act(async () => pending.resolve(completedJob()));
    expect(onJobChange).not.toHaveBeenCalled();
    expect(screen.queryByText("Quarantine job: Succeeded")).not.toBeInTheDocument();
  });

  it("does not clear a newer selection after an earlier submission settles", async () => {
    const pending = deferred<QuarantineJob>();
    vi.mocked(submitQuarantine).mockReturnValue(pending.promise);
    const onClear = vi.fn();
    const onJobChange = vi.fn();
    const controls = renderControls(onDemandDecision(), user, { variant: "bulk", onClear, onJobChange });
    await userEvent.click(screen.getByRole("button", { name: "Quarantine selected" }));
    const dialog = await screen.findByRole("dialog", { name: "Quarantine 1 agent" });
    await userEvent.click(within(dialog).getByRole("checkbox"));
    await userEvent.click(within(dialog).getByRole("button", { name: "Confirm quarantine" }));
    controls.changeProps({ targets: [{ ...target, nativeId: "new-native-agent" }] });
    await act(async () => pending.resolve(completedJob()));
    expect(onClear).not.toHaveBeenCalled();
    expect(onJobChange).toHaveBeenCalledExactlyOnceWith(completedJob());
    expect(await screen.findByText("Quarantine job: Succeeded")).toBeVisible();
  });

  it("follows a resume acknowledgement until current job reads prove completion", async () => {
    vi.useFakeTimers();
    const paused = { ...completedJob(), status: "waiting_authorization" as const, completed: 0, succeeded: 0, canResume: true };
    vi.mocked(getQuarantineJob).mockResolvedValueOnce(paused).mockResolvedValueOnce(paused).mockResolvedValue(completedJob());
    vi.mocked(resumeQuarantineJob).mockResolvedValue(paused);
    const onJobChange = vi.fn();
    renderControls(onDemandDecision(), user, { variant: "bulk", initialJobId: paused.id, onJobChange });
    await act(async () => {});
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Resume unsent work" })));
    expect(resumeQuarantineJob).toHaveBeenCalledExactlyOnceWith(paused.id, { signal: expect.any(AbortSignal) });
    expect(screen.getByText("Quarantine job: Waiting Authorization")).toBeVisible();
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(getQuarantineJob).toHaveBeenCalledTimes(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(screen.getByText("Quarantine job: Succeeded")).toBeVisible();
    expect(onJobChange).toHaveBeenLastCalledWith(completedJob());
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(getQuarantineJob).toHaveBeenCalledTimes(3);
  });

  it("bounds automatic following and restarts it only after an explicit refresh", async () => {
    vi.useFakeTimers();
    const running = { ...completedJob(), status: "running" as const, completed: 0, succeeded: 0 };
    vi.mocked(getQuarantineJob).mockResolvedValue(running);
    renderControls(onDemandDecision(), user, { variant: "bulk", initialJobId: running.id });
    await act(async () => {});
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(getQuarantineJob).toHaveBeenCalledTimes(61);
    expect(screen.getByRole("alert")).toHaveTextContent("Automatic job status checks stopped");
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(getQuarantineJob).toHaveBeenCalledTimes(61);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Refresh job status" })));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(getQuarantineJob).toHaveBeenCalledTimes(63);
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
    }, expect.stringMatching(/^[0-9a-f-]{36}$/), { signal: expect.any(AbortSignal) });
  });

  it.each(["success", "failure"])("cancels a submitted request on unmount and discards late %s", async outcome => {
    let resolve!: (value: QuarantineJob) => void;
    let reject!: (reason: Error) => void;
    vi.mocked(submitQuarantine).mockReturnValue(new Promise((success, failure) => { resolve = success; reject = failure; }));
    const onJobChange = vi.fn();
    const controls = renderControls(onDemandDecision(), user, { onJobChange });
    await userEvent.click(screen.getByRole("button", { name: "Quarantine" }));
    const dialog = await screen.findByRole("dialog", { name: "Quarantine 1 agent" });
    await userEvent.click(within(dialog).getByRole("checkbox"));
    const submit = within(dialog).getByRole("button", { name: "Confirm quarantine" });
    act(() => { fireEvent.click(submit); fireEvent.click(submit); });
    expect(submitQuarantine).toHaveBeenCalledTimes(1);
    const signal = vi.mocked(submitQuarantine).mock.calls[0][2]?.signal;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal?.aborted).toBe(false);
    controls.unmount();
    expect(signal?.aborted).toBe(true);
    await act(async () => {
      if (outcome === "success") resolve(completedJob());
      else reject(new Error("Retired submission failed."));
    });
    expect(onJobChange).not.toHaveBeenCalled();
  });

  it.each([
    ["cancel", cancelQuarantineJob, "Cancel unsent work"],
    ["resume", resumeQuarantineJob, "Resume unsent work"],
    ["reconcile", reconcileQuarantineJob, "Reconcile by status read"],
  ] as const)("cancels a pending %s when its exact job is replaced", async (operation, mutate, label) => {
    const initial: QuarantineJob = {
      ...completedJob(), total: 2,
      status: operation === "cancel" ? "running" : operation === "resume" ? "waiting_authorization" : "inconclusive",
      canResume: operation === "resume", canReconcile: operation === "reconcile",
    };
    const replacement = { ...completedJob(), id: "job-b" };
    vi.mocked(getQuarantineJob).mockImplementation(async id => id === initial.id ? initial : replacement);
    let finish!: (value: QuarantineJob) => void;
    vi.mocked(mutate).mockReturnValue(new Promise(resolve => { finish = resolve; }));
    const onJobChange = vi.fn();
    const controls = (initialJobId: string) => <CapabilityContext value={{
      views: [onDemandDecision()], user, now: Date.now(), loading: false, pending: false,
      error: undefined, reload: vi.fn(), openPermissions: vi.fn(),
    }}><WorkbenchActionProvider value={workbenchActions}>
      <CopilotStudioQuarantineControls snapshot={snapshot} targets={[target]} variant="bulk" canManage
        initialJobId={initialJobId} onJobChange={onJobChange} />
    </WorkbenchActionProvider></CapabilityContext>;
    const view = render(controls(initial.id));
    const command = await screen.findByRole("button", { name: label });
    act(() => { fireEvent.click(command); fireEvent.click(command); });
    expect(mutate).toHaveBeenCalledExactlyOnceWith(initial.id, { signal: expect.any(AbortSignal) });
    const signal = vi.mocked(mutate).mock.calls[0][1]?.signal;
    expect(signal?.aborted).toBe(false);
    view.rerender(controls(replacement.id));
    expect(signal?.aborted).toBe(true);
    expect(await screen.findByText("Quarantine job: Succeeded")).toBeVisible();
    await act(async () => finish(initial));
    expect(onJobChange).not.toHaveBeenCalled();
    expect(screen.getByText("Quarantine job: Succeeded")).toBeVisible();
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

  it("notifies the inventory owner when active job polling reaches a terminal revision", async () => {
    const complete: QuarantineJob = {
      id: "polled-job", action: "quarantine", status: "succeeded", confirmationHash: "c".repeat(64), confirmation: preview().summary,
      isCanary: false, total: 1, completed: 1, succeeded: 1, failed: 0, skipped: 0, inconclusive: 0, cancelled: 0,
      canResume: false, canReconcile: false, createdAt: snapshot.observedAt, updatedAt: snapshot.observedAt, results: [],
    };
    vi.mocked(getQuarantineJob).mockResolvedValueOnce({ ...complete, status: "running", completed: 0, succeeded: 0 })
      .mockResolvedValue(complete);
    const onJobChange = vi.fn();
    renderControls(onDemandDecision(), user, { variant: "bulk", initialJobId: complete.id, onJobChange });
    expect(await screen.findByText("Quarantine job: Running")).toBeInTheDocument();
    expect(onJobChange).not.toHaveBeenCalled();
    await waitFor(() => expect(onJobChange).toHaveBeenCalledWith(complete), { timeout: 2000 });
    expect(screen.getByText("Quarantine job: Succeeded")).toBeInTheDocument();
  });
});
