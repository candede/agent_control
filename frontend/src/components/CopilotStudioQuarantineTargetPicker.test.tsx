import { act, fireEvent, render as rtlRender, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { workbenchActions } from "../../../backend/src/services/workbenchMetadata";
import {
  cancelQuarantineJob,
  getQuarantineJob,
  getQuarantineJobs,
  getQuarantineStatus,
  getQuarantineTargets,
  previewQuarantine,
  reconcileQuarantineJob,
  resumeQuarantineJob,
  submitQuarantine,
  type QuarantineJob,
  type QuarantineTargetPage,
} from "../api/client";
import { CopilotStudioQuarantineTargetPicker } from "./CopilotStudioQuarantineTargetPicker";
import { CopilotStudioQuarantineControls } from "./CopilotStudioQuarantineControls";
import { WorkbenchActionProvider } from "../workbenchActionContext";

vi.mock("./CapabilityGate", () => ({ CapabilityGate: ({ children }: { children: React.ReactNode }) => children }));
vi.mock("../api/client", async importOriginal => ({
  ...await importOriginal<typeof import("../api/client")>(),
  getQuarantineTargets: vi.fn(),
  getQuarantineJobs: vi.fn(),
  getQuarantineJob: vi.fn(),
  getQuarantineStatus: vi.fn(),
  previewQuarantine: vi.fn(),
  submitQuarantine: vi.fn(),
  cancelQuarantineJob: vi.fn(),
  resumeQuarantineJob: vi.fn(),
  reconcileQuarantineJob: vi.fn(),
}));

const snapshotId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const environmentId = "11111111-1111-4111-8111-111111111111";
const botId = "22222222-2222-4222-8222-222222222222";
const snapshot = { id: snapshotId, observedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() };
const candidate = {
  nativeId: "native-agent",
  type: "microsoft.copilotstudio/agents" as const,
  displayName: "Saved agent",
  environmentId,
  botId,
  identifiers: [{ kind: "environment_id" as const, value: environmentId }, { kind: "cds_bot_id" as const, value: botId }],
  details: { isQuarantined: false },
  quarantineEligibility: { eligible: true, code: "eligible" as const },
};
const targetPage: QuarantineTargetPage = { value: [candidate], count: 1, snapshot };

function render(ui: ReactNode) {
  const wrap = (children: ReactNode) => <WorkbenchActionProvider value={workbenchActions}>{children}</WorkbenchActionProvider>;
  const result = rtlRender(wrap(ui));
  return { ...result, rerender: (next: ReactNode) => result.rerender(wrap(next)) };
}

describe("CopilotStudioQuarantineTargetPicker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getQuarantineTargets).mockResolvedValue(targetPage);
    vi.mocked(getQuarantineJobs).mockResolvedValue({ value: [] });
    vi.mocked(getQuarantineStatus).mockResolvedValue(statusView());
    vi.mocked(previewQuarantine).mockResolvedValue(preview());
    vi.mocked(submitQuarantine).mockResolvedValue(job());
    vi.mocked(cancelQuarantineJob).mockResolvedValue({ ...job(), status: "cancelled" });
    vi.mocked(resumeQuarantineJob).mockResolvedValue({ ...job(), status: "queued" });
    vi.mocked(reconcileQuarantineJob).mockResolvedValue({ ...job(), status: "succeeded", completed: 1, succeeded: 1 });
  });

  afterEach(() => { vi.useRealTimers(); });

  it("loads only saved control targets and performs no provider status read", async () => {
    render(<CopilotStudioQuarantineTargetPicker />);
    expect(await screen.findByText("Saved agent")).toBeInTheDocument();
    expect(screen.getByText(environmentId)).toBeInTheDocument();
    expect(screen.getByText(botId)).toBeInTheDocument();
    expect(screen.getByText("Not linked; independent")).toBeInTheDocument();
    expect(getQuarantineTargets).toHaveBeenCalledWith({ limit: 50, offset: 0 });
    expect(getQuarantineStatus).not.toHaveBeenCalled();
    expect(previewQuarantine).not.toHaveBeenCalled();
  });

  it("submits the exact selected native target only after confirmation", async () => {
    render(<CopilotStudioQuarantineTargetPicker />);
    fireEvent.click(await screen.findByRole("checkbox", { name: "Select Saved agent for quarantine control" }));
    fireEvent.click(screen.getByRole("button", { name: "Quarantine selected" }));
    const dialog = await screen.findByRole("dialog", { name: "Quarantine 1 agent" });
    expect(within(dialog).getByText(`${environmentId} / ${botId}`)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("checkbox"));
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirm quarantine" }));
    await waitFor(() => expect(submitQuarantine).toHaveBeenCalledTimes(1));
    expect(submitQuarantine).toHaveBeenCalledWith({ action: "quarantine", snapshotId, resourceNativeIds: ["native-agent"], confirmationHash: "c".repeat(64) }, expect.stringMatching(/^[0-9a-f-]{36}$/));
  });

  it("freezes the exact native target in the single-agent detail confirmation", async () => {
    render(<CopilotStudioQuarantineControls snapshot={snapshot} targets={[candidate]} variant="detail" canManage />);
    expect(screen.getByText("Direct provider state and saved inventory state remain independent.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Quarantine" }));
    const dialog = await screen.findByRole("dialog", { name: "Quarantine 1 agent" });
    expect(within(dialog).getByText(`${environmentId} / ${botId}`)).toBeInTheDocument();
    expect(within(dialog).getByText("Delegated CopilotStudio.AdminActions.Invoke")).toBeInTheDocument();
    expect(previewQuarantine).toHaveBeenCalledWith({ action: "quarantine", snapshotId, resourceNativeIds: ["native-agent"] });
  });

  it("explains maker behavior and cancellation closes confirmation without a send", async () => {
    render(<CopilotStudioQuarantineTargetPicker />);
    fireEvent.click(await screen.findByRole("checkbox", { name: "Select Saved agent for quarantine control" }));
    fireEvent.click(screen.getByRole("button", { name: "Quarantine selected" }));
    const dialog = await screen.findByRole("dialog", { name: "Quarantine 1 agent" });
    expect(within(dialog).getByText(/Makers may still see and test this bot/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Quarantine 1 agent" })).not.toBeInTheDocument());
    expect(submitQuarantine).not.toHaveBeenCalled();
  });

  it("does not restore a frozen confirmation after the selection changes away and back", async () => {
    render(<CopilotStudioQuarantineTargetPicker />);
    const target = await screen.findByRole("checkbox", { name: "Select Saved agent for quarantine control" });
    fireEvent.click(target);
    fireEvent.click(screen.getByRole("button", { name: "Quarantine selected" }));
    expect(await screen.findByRole("dialog", { name: "Quarantine 1 agent" })).toBeInTheDocument();
    fireEvent.click(target);
    expect(screen.queryByRole("dialog", { name: "Quarantine 1 agent" })).not.toBeInTheDocument();
    fireEvent.click(target);
    expect(screen.queryByRole("dialog", { name: "Quarantine 1 agent" })).not.toBeInTheDocument();
    expect(submitQuarantine).not.toHaveBeenCalled();
  });

  it("discards a delayed preview after the selection changes away and back", async () => {
    let resolvePreview!: (value: ReturnType<typeof preview>) => void;
    vi.mocked(previewQuarantine).mockReturnValueOnce(new Promise(resolve => { resolvePreview = resolve; }));
    render(<CopilotStudioQuarantineTargetPicker />);
    const target = await screen.findByRole("checkbox", { name: "Select Saved agent for quarantine control" });
    fireEvent.click(target);
    fireEvent.click(screen.getByRole("button", { name: "Quarantine selected" }));
    await waitFor(() => expect(previewQuarantine).toHaveBeenCalledTimes(1));
    fireEvent.click(target);
    fireEvent.click(target);
    await act(async () => { resolvePreview(preview()); await Promise.resolve(); });
    expect(screen.queryByRole("dialog", { name: "Quarantine 1 agent" })).not.toBeInTheDocument();
  });

  it("retries a failed submit with the same frozen receipt", async () => {
    vi.mocked(submitQuarantine).mockRejectedValueOnce(new Error("Connection interrupted.")).mockResolvedValueOnce(job());
    render(<CopilotStudioQuarantineTargetPicker />);
    fireEvent.click(await screen.findByRole("checkbox", { name: "Select Saved agent for quarantine control" }));
    fireEvent.click(screen.getByRole("button", { name: "Quarantine selected" }));
    const dialog = await screen.findByRole("dialog", { name: "Quarantine 1 agent" });
    fireEvent.click(within(dialog).getByRole("checkbox"));
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirm quarantine" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Connection interrupted.");
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirm quarantine" }));
    await waitFor(() => expect(submitQuarantine).toHaveBeenCalledTimes(2));
    expect(vi.mocked(submitQuarantine).mock.calls[1][1]).toBe(vi.mocked(submitQuarantine).mock.calls[0][1]);
  });

  it("keeps server-ineligible targets disabled without preview or status egress", async () => {
    vi.mocked(getQuarantineTargets).mockResolvedValue({ ...targetPage, value: [{ ...candidate, botId: null, quarantineEligibility: { eligible: false, code: "native_identity_unavailable", reason: "No exact CDS bot identity." } }] });
    render(<CopilotStudioQuarantineTargetPicker />);
    expect(await screen.findByRole("checkbox", { name: "Select Saved agent for quarantine control" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Inspect direct status for Saved agent" })).toBeDisabled();
    expect(screen.getByText("No exact CDS bot identity.")).toBeInTheDocument();
    expect(previewQuarantine).not.toHaveBeenCalled();
    expect(getQuarantineStatus).not.toHaveBeenCalled();
  });

  it("discards an older target-list response and reads direct state only on command", async () => {
    let resolveInitial!: (value: QuarantineTargetPage) => void;
    vi.mocked(getQuarantineTargets).mockReturnValueOnce(new Promise(resolve => { resolveInitial = resolve; })).mockResolvedValueOnce({ ...targetPage, value: [{ ...candidate, nativeId: "current-agent", displayName: "Current agent" }] });
    render(<CopilotStudioQuarantineTargetPicker />);
    await waitFor(() => expect(getQuarantineTargets).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByLabelText("Search saved targets"), { target: { value: "current" } });
    expect(await screen.findByText("Current agent")).toBeInTheDocument();
    resolveInitial({ ...targetPage, value: [{ ...candidate, nativeId: "stale-agent", displayName: "Stale agent" }] });
    await Promise.resolve();
    expect(screen.queryByText("Stale agent")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Inspect direct status for Current agent" }));
    expect(screen.getByText("Not checked")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Check direct status" }));
    await waitFor(() => expect(getQuarantineStatus).toHaveBeenCalledWith(snapshotId, "current-agent", false));
  });

  it("disables open controls when the saved target crosses the 24-hour boundary", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-10T12:00:00.000Z"));
    const nearlyStale = { id: snapshotId, observedAt: "2026-09-09T12:00:30.000Z", expiresAt: "2026-09-11T12:00:00.000Z" };
    render(<CopilotStudioQuarantineControls snapshot={nearlyStale} targets={[candidate]} variant="detail" canManage />);
    expect(screen.getByRole("button", { name: "Quarantine" })).toBeEnabled();
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(screen.getByRole("button", { name: "Quarantine" })).toBeDisabled();
    expect(screen.getByText(/saved inventory target is stale/i)).toBeInTheDocument();
  });

  it("shows partial inconclusive work and reconciles only on explicit command", async () => {
    const partial = { ...job(), status: "partial" as const, completed: 1, inconclusive: 1, canReconcile: true, results: [{ resourceNativeId: "native-agent", displayName: "Saved agent", environmentId, botId, status: "inconclusive" as const, requestedState: true, observedState: null, observedProviderUpdatedAt: null, observedAt: null, correlationId: null, reconciliationStatus: "required" as const, retryEligible: false, message: "Provider outcome requires GET reconciliation." }] };
    vi.mocked(getQuarantineJobs).mockResolvedValue({ value: [partial] });
    render(<CopilotStudioQuarantineTargetPicker />);
    expect(await screen.findByText(/1 inconclusive/)).toBeInTheDocument();
    expect(reconcileQuarantineJob).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Reconcile by status read" }));
    await waitFor(() => expect(reconcileQuarantineJob).toHaveBeenCalledWith(partial.id));
  });

  it("loads the exact older quarantine job instead of the latest job list entry", async () => {
    const older = { ...job(), id: "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa", status: "succeeded" as const, completed: 1, succeeded: 1 };
    vi.mocked(getQuarantineJobs).mockResolvedValue({ value: [{ ...job(), id: "latest-job" }] });
    vi.mocked(getQuarantineJob).mockResolvedValue(older);
    render(<CopilotStudioQuarantineTargetPicker initialJobId={older.id} />);

    expect(await screen.findByText(/Quarantine job: Succeeded/)).toBeVisible();
    expect(getQuarantineJob).toHaveBeenCalledWith(older.id, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(getQuarantineJobs).not.toHaveBeenCalled();
  });

  it("does not fall back to the latest quarantine job for a wrong-scope link", async () => {
    vi.mocked(getQuarantineJobs).mockResolvedValue({ value: [job()] });
    vi.mocked(getQuarantineJob).mockRejectedValue(new Error("Not found"));
    render(<CopilotStudioQuarantineTargetPicker initialJobId="other-principal-job" />);

    expect(await screen.findByText(/exact quarantine job is unavailable to this account/i)).toBeVisible();
    expect(getQuarantineJobs).not.toHaveBeenCalled();
  });

  it("offers explicit authorization resume and reports target-list failures", async () => {
    const waiting = { ...job(), status: "waiting_authorization" as const, canResume: true };
    vi.mocked(getQuarantineJobs).mockResolvedValueOnce({ value: [waiting] });
    const view = render(<CopilotStudioQuarantineTargetPicker />);
    fireEvent.click(await screen.findByRole("button", { name: "Resume unsent work" }));
    await waitFor(() => expect(resumeQuarantineJob).toHaveBeenCalledWith(waiting.id));
    view.unmount();
    vi.mocked(getQuarantineTargets).mockRejectedValueOnce(new Error("Saved target service unavailable."));
    render(<CopilotStudioQuarantineTargetPicker />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Saved target service unavailable.");
  });

  it("never overlaps automatic job status reads while one request is pending", async () => {
    vi.useFakeTimers();
    let resolvePoll!: (value: ReturnType<typeof job>) => void;
    vi.mocked(getQuarantineJobs).mockResolvedValue({ value: [job()] });
    vi.mocked(getQuarantineJob).mockReturnValue(new Promise(resolve => { resolvePoll = resolve; }));
    render(<CopilotStudioQuarantineTargetPicker />);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(getQuarantineJob).toHaveBeenCalledTimes(1);
    await act(async () => { resolvePoll({ ...job(), status: "succeeded", completed: 1, succeeded: 1 }); await Promise.resolve(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(getQuarantineJob).toHaveBeenCalledTimes(1);
  });

  it("stops automatic job polling after one minute and requires explicit refresh", async () => {
    vi.useFakeTimers();
    vi.mocked(getQuarantineJobs).mockResolvedValue({ value: [job()] });
    vi.mocked(getQuarantineJob).mockResolvedValue(job());
    render(<CopilotStudioQuarantineTargetPicker />);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(getQuarantineJob).toHaveBeenCalledTimes(60);
    expect(screen.getByRole("alert")).toHaveTextContent("Automatic job status checks stopped after one minute");
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(getQuarantineJob).toHaveBeenCalledTimes(60);
  });
});

function statusView() {
  return { target: { resourceNativeId: "native-agent", displayName: "Saved agent", environmentId, botId }, direct: { isBotQuarantined: false, providerUpdatedAt: "2026-09-09T10:00:00.123Z", observedAt: "2026-09-09T10:00:01.000Z", correlationId: "33333333-3333-4333-8333-333333333333", source: "provider" as const }, inventory: { isQuarantined: false, quarantinedAt: null, observedAt: snapshot.observedAt, snapshotId }, disagreesWithInventory: false };
}

function preview() {
  return { confirmationHash: "c".repeat(64), statuses: [statusView()], summary: { risk: true as const, operation: "quarantine" as const, provider: "Power Platform Copilot Studio" as const, endpoint: "api-version=1 botQuarantine" as const, permission: "Delegated CopilotStudio.AdminActions.Invoke" as const, targetCount: 1, targetSelectionHash: "d".repeat(64), actor: { id: "admin-a", displayName: "Admin", username: "admin@example.invalid" }, packageControlIndependent: true as const, makerBehavior: "Makers may still see and test this bot while connected channels cannot use it.", providerAtomicity: false as const, targets: [{ resourceNativeId: "native-agent", displayName: "Saved agent", environmentId, botId, currentState: false, currentProviderUpdatedAt: "2026-09-09T10:00:00.123Z", requestedState: true, inventoryState: false, inventoryObservedAt: snapshot.observedAt }], additionalTargetCount: 0 } };
}

function job(): QuarantineJob {
  const confirmation = preview().summary;
  return { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", action: "quarantine" as const, status: "queued" as const, confirmationHash: "c".repeat(64), confirmation, isCanary: false, total: 1, completed: 0, succeeded: 0, failed: 0, skipped: 0, inconclusive: 0, cancelled: 0, canResume: false, canReconcile: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), results: [] };
}