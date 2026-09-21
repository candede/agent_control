import { act, fireEvent, render as rtlRender, screen, waitFor, within, type RenderOptions } from "@testing-library/react";
import { useState, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { workbenchActions } from "../../../backend/src/services/workbenchMetadata";
import {
  ApiError,
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
import { SavedQueryProvider } from "./SavedQueryProvider";
import { createSavedQueryClient } from "../savedQueries";

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

function render(ui: ReactNode, options: Pick<RenderOptions, "reactStrictMode"> = {}) {
  const wrap = (children: ReactNode) => <WorkbenchActionProvider value={workbenchActions}>{children}</WorkbenchActionProvider>;
  const result = rtlRender(wrap(ui), options);
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
    expect(getQuarantineTargets).toHaveBeenCalledWith(
      { limit: 50, offset: 0 },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
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
    expect(previewQuarantine).toHaveBeenCalledWith(
      { action: "quarantine", snapshotId, resourceNativeIds: ["native-agent"] },
      { signal: expect.any(AbortSignal) },
    );
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

  it("does not equate an opaque native ID containing separators with a different target list", async () => {
    const joinedId = `a\u001emicrosoft.copilotstudio/agents:${environmentId}:b`;
    const first = { ...candidate, nativeId: joinedId };
    const receipt = preview();
    receipt.summary.targets[0].resourceNativeId = joinedId;
    receipt.statuses[0].target.resourceNativeId = joinedId;
    vi.mocked(previewQuarantine).mockResolvedValue(receipt);
    const { rerender } = render(<CopilotStudioQuarantineControls snapshot={snapshot} targets={[first]} variant="bulk" canManage />);
    fireEvent.click(screen.getByRole("button", { name: "Quarantine selected" }));
    const confirmation = await screen.findByRole("dialog", { name: "Quarantine 1 agent" });
    fireEvent.click(within(confirmation).getByRole("checkbox"));
    rerender(<CopilotStudioQuarantineControls snapshot={snapshot}
      targets={[{ ...candidate, nativeId: "a" }, { ...candidate, nativeId: "b" }]} variant="bulk" canManage />);
    expect(screen.queryByRole("dialog", { name: "Quarantine 1 agent" })).not.toBeInTheDocument();
    expect(submitQuarantine).not.toHaveBeenCalled();
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
    expect(within(dialog).getByRole("alert")).toHaveTextContent("Connection interrupted.");
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
    let initialSignal: AbortSignal | undefined;
    vi.mocked(getQuarantineTargets).mockImplementationOnce((_query, options) => {
      initialSignal = options?.signal;
      return new Promise(resolve => { resolveInitial = resolve; });
    }).mockResolvedValueOnce({ ...targetPage, value: [{ ...candidate, nativeId: "current-agent", displayName: "Current agent" }] });
    render(<CopilotStudioQuarantineTargetPicker />);
    await waitFor(() => expect(getQuarantineTargets).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByLabelText("Search saved targets"), { target: { value: "current" } });
    expect(await screen.findByText("Current agent")).toBeInTheDocument();
    expect(initialSignal?.aborted).toBe(true);
    resolveInitial({ ...targetPage, value: [{ ...candidate, nativeId: "stale-agent", displayName: "Stale agent" }] });
    await Promise.resolve();
    expect(screen.queryByText("Stale agent")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Inspect direct status for Current agent" }));
    expect(screen.getByText("Not checked")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Check direct status" }));
    await waitFor(() => expect(getQuarantineStatus).toHaveBeenCalledWith(snapshotId, "current-agent", false, { signal: expect.any(AbortSignal) }));
  });

  it("keeps a clamped page loading instead of claiming the authorized snapshot has no matching targets", async () => {
    const corrected = deferred<QuarantineTargetPage>();
    const currentSnapshot = { ...snapshot, id: "current-snapshot" };
    vi.mocked(getQuarantineTargets)
      .mockResolvedValueOnce({ ...targetPage, count: 51, value: Array.from({ length: 50 }, (_, index) => ({
        ...candidate, nativeId: `native-${index}`, displayName: `Saved target ${index}`,
      })) })
      .mockResolvedValueOnce({ value: [], count: 1, snapshot: currentSnapshot })
      .mockReturnValueOnce(corrected.promise);
    render(<CopilotStudioQuarantineTargetPicker />);
    expect(await screen.findByText("Saved target 0")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Next quarantine target page" }));
    await waitFor(() => expect(getQuarantineTargets).toHaveBeenCalledTimes(3));
    expect(vi.mocked(getQuarantineTargets).mock.calls.map(([query]) => query?.offset)).toEqual([0, 50, 0]);
    expect(screen.queryByText("No matching targets")).not.toBeInTheDocument();
    expect(screen.queryByText("No current saved targets")).not.toBeInTheDocument();
    expect(screen.getByText("Loading saved quarantine targets...")).toBeVisible();
    await act(async () => corrected.resolve({ ...targetPage, snapshot: currentSnapshot }));
    expect(screen.getByText("Saved agent")).toBeVisible();
    expect(screen.getByText("Page 1 of 1")).toBeVisible();
    expect(screen.getByRole("button", { name: "Next quarantine target page" })).toBeDisabled();
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
    expect(screen.queryByText("No current saved targets")).not.toBeInTheDocument();
  });

  it.each([401, 403])("removes saved targets and pending private job reads after a %s denial", async status => {
    const pendingJobs = deferred<{ value: QuarantineJob[] }>();
    vi.mocked(getQuarantineJobs).mockReturnValue(pendingJobs.promise);
    vi.mocked(getQuarantineTargets).mockResolvedValueOnce(targetPage)
      .mockRejectedValueOnce(new ApiError(status, "forbidden", "Saved target access denied."));
    render(<CopilotStudioQuarantineTargetPicker />);
    fireEvent.click(await screen.findByRole("checkbox", { name: "Select Saved agent for quarantine control" }));
    fireEvent.click(screen.getByRole("button", { name: "Inspect direct status for Saved agent" }));
    fireEvent.click(screen.getByRole("button", { name: "Refresh saved target list" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Saved target access denied.");
    expect(screen.queryByText("Saved target source")).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: "Select Saved agent for quarantine control" })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Direct quarantine control for Saved agent" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Quarantine selected" })).not.toBeInTheDocument();
    expect(vi.mocked(getQuarantineJobs).mock.calls[0][1]?.signal?.aborted).toBe(true);
    await act(async () => pendingJobs.resolve({ value: [{ ...job(), status: "succeeded" }] }));
    expect(screen.queryByText("Quarantine job: Succeeded")).not.toBeInTheDocument();
    expect(screen.queryByText("No current saved targets")).not.toBeInTheDocument();
  });

  it("does not replace a newly submitted durable job or cancel a peer sharing its initial saved list", async () => {
    const pendingJobs = deferred<{ value: QuarantineJob[] }>();
    vi.mocked(getQuarantineJobs).mockReturnValue(pendingJobs.promise);
    vi.mocked(submitQuarantine).mockResolvedValue({ ...job(), id: "new-job", status: "succeeded" });
    const client = createSavedQueryClient();
    const peer = render(<SavedQueryProvider client={client}>
      <CopilotStudioQuarantineControls snapshot={snapshot} targets={[]} variant="bulk" canManage />
    </SavedQueryProvider>);
    const current = render(<SavedQueryProvider client={client}>
      <CopilotStudioQuarantineControls snapshot={snapshot} targets={[candidate]} variant="bulk" canManage />
    </SavedQueryProvider>);
    await confirmQuarantine("Quarantine selected", current.container);
    expect(await within(current.container).findByText("Quarantine job: Succeeded")).toBeVisible();
    expect(getQuarantineJobs).toHaveBeenCalledOnce();
    expect(vi.mocked(getQuarantineJobs).mock.calls[0][1]?.signal?.aborted).toBe(false);
    await act(async () => pendingJobs.resolve({ value: [{ ...job(), id: "old-job", status: "cancelled" }] }));
    expect(within(current.container).getByText("Quarantine job: Succeeded")).toBeVisible();
    expect(within(current.container).queryByText("Quarantine job: Cancelled")).not.toBeInTheDocument();
    expect(within(peer.container).getByText("Quarantine job: Cancelled")).toBeVisible();
  });

  it.each(["reconcile", "refresh"] as const)("does not reattach to a peer's pre-action exact job when %s pins the route", async action => {
    const oldRead = deferred<QuarantineJob>();
    const previous = { ...job(), status: "partial" as const, canReconcile: true };
    const current = { ...job(), status: "succeeded" as const, completed: 1, succeeded: 1 };
    vi.mocked(getQuarantineJobs).mockResolvedValue({ value: [previous] });
    vi.mocked(getQuarantineJob).mockReturnValueOnce(oldRead.promise).mockResolvedValue(current);
    vi.mocked(reconcileQuarantineJob).mockResolvedValue(current);
    const client = createSavedQueryClient();
    const peer = render(<SavedQueryProvider client={client}>
      <CopilotStudioQuarantineControls snapshot={snapshot} targets={[]} variant="bulk" canManage initialJobId={previous.id} />
    </SavedQueryProvider>);
    function RouteOwner() {
      const [initialJobId, setInitialJobId] = useState<string>();
      return <CopilotStudioQuarantineControls snapshot={snapshot} targets={[]} variant="bulk" canManage
        initialJobId={initialJobId} onJobChange={next => setInitialJobId(next.id)} />;
    }
    const actor = render(<SavedQueryProvider client={client}><RouteOwner /></SavedQueryProvider>);
    fireEvent.click(await within(actor.container).findByRole("button", {
      name: action === "reconcile" ? "Reconcile by status read" : "Refresh job status",
    }));

    await waitFor(() => expect(getQuarantineJob).toHaveBeenCalledTimes(action === "reconcile" ? 2 : 3));
    expect(vi.mocked(getQuarantineJob).mock.calls[0][1]?.signal?.aborted).toBe(false);
    expect(within(actor.container).getByText("Quarantine job: Succeeded")).toBeVisible();
    await act(async () => oldRead.resolve(previous));
    expect(within(actor.container).getByText("Quarantine job: Succeeded")).toBeVisible();
    expect(within(actor.container).queryByText("Quarantine job: Partial")).not.toBeInTheDocument();
    expect(within(peer.container).getByText("Quarantine job: Partial")).toBeVisible();
  });

  it("freshly restores after a scoped denial without joining or cancelling the peer-held denied-era request", async () => {
    const oldRead = deferred<{ value: QuarantineJob[] }>();
    const previous = { ...job(), status: "partial" as const, canReconcile: true };
    const current = { ...job(), status: "succeeded" as const };
    vi.mocked(getQuarantineJobs).mockReturnValueOnce(oldRead.promise).mockResolvedValue({ value: [current] });
    vi.mocked(previewQuarantine).mockRejectedValueOnce(new ApiError(403, "missing_permission", "Scoped preview denied."));
    const client = createSavedQueryClient();
    const peer = render(<SavedQueryProvider client={client}>
      <CopilotStudioQuarantineControls snapshot={snapshot} targets={[]} variant="bulk" canManage />
    </SavedQueryProvider>);
    const content = (canManage: boolean) => <SavedQueryProvider client={client}>
      <CopilotStudioQuarantineControls snapshot={snapshot} targets={[candidate]} variant="bulk" canManage={canManage} />
    </SavedQueryProvider>;
    const actor = render(content(true));
    fireEvent.click(within(actor.container).getByRole("button", { name: "Quarantine selected" }));
    expect(await within(actor.container).findByRole("alert")).toHaveTextContent("Scoped preview denied.");
    expect(getQuarantineJobs).toHaveBeenCalledOnce();
    expect(vi.mocked(getQuarantineJobs).mock.calls[0][1]?.signal?.aborted).toBe(false);
    actor.rerender(content(false));
    actor.rerender(content(true));
    await waitFor(() => expect(getQuarantineJobs).toHaveBeenCalledTimes(2));
    expect(within(actor.container).getByText("Quarantine job: Succeeded")).toBeVisible();
    await act(async () => oldRead.resolve({ value: [previous] }));
    expect(within(actor.container).getByText("Quarantine job: Succeeded")).toBeVisible();
    expect(within(actor.container).queryByText("Quarantine job: Partial")).not.toBeInTheDocument();
    expect(within(peer.container).getByText("Quarantine job: Partial")).toBeVisible();
  });

  it("fences every target-picker sibling after denial while an independent shared observer remains live", async () => {
    const pendingJobs = deferred<{ value: QuarantineJob[] }>();
    const pendingStatus = deferred<ReturnType<typeof statusView>>();
    vi.mocked(getQuarantineJobs).mockReturnValue(pendingJobs.promise);
    vi.mocked(getQuarantineStatus).mockReturnValue(pendingStatus.promise);
    vi.mocked(getQuarantineTargets).mockResolvedValueOnce(targetPage)
      .mockRejectedValueOnce(new ApiError(403, "forbidden", "Target scope denied."));
    const client = createSavedQueryClient();
    const peer = render(<SavedQueryProvider client={client}>
      <CopilotStudioQuarantineControls snapshot={snapshot} targets={[]} variant="bulk" canManage />
    </SavedQueryProvider>);
    const actor = render(<SavedQueryProvider client={client}><CopilotStudioQuarantineTargetPicker /></SavedQueryProvider>);
    fireEvent.click(await within(actor.container).findByRole("button", { name: "Inspect direct status for Saved agent" }));
    fireEvent.click(within(actor.container).getByRole("button", { name: "Check direct status" }));
    fireEvent.click(within(actor.container).getByRole("button", { name: "Refresh saved target list" }));
    expect(await within(actor.container).findByRole("alert")).toHaveTextContent("Target scope denied.");
    expect(getQuarantineJobs).toHaveBeenCalledOnce();
    expect(vi.mocked(getQuarantineJobs).mock.calls[0][1]?.signal?.aborted).toBe(false);
    expect(vi.mocked(getQuarantineStatus).mock.calls[0][3]?.signal?.aborted).toBe(true);

    await act(async () => {
      pendingJobs.resolve({ value: [{ ...job(), status: "succeeded" }] });
      pendingStatus.resolve(statusView());
    });
    expect(within(actor.container).queryByText("Saved target source")).not.toBeInTheDocument();
    expect(within(actor.container).queryByText("Quarantine job: Succeeded")).not.toBeInTheDocument();
    expect(within(actor.container).queryByText("Direct provider status")).not.toBeInTheDocument();
    expect(within(peer.container).getByText("Quarantine job: Succeeded")).toBeVisible();
  });

  it("does not notify an unmounted control after its accepted submit completes", async () => {
    const submitted = deferred<QuarantineJob>();
    vi.mocked(submitQuarantine).mockReturnValue(submitted.promise);
    const onClear = vi.fn();
    const onJobChange = vi.fn();
    const { unmount } = render(<CopilotStudioQuarantineControls snapshot={snapshot} targets={[candidate]}
      variant="bulk" canManage onClear={onClear} onJobChange={onJobChange} />);
    await confirmQuarantine("Quarantine selected");
    unmount();
    await act(async () => submitted.resolve({ ...job(), status: "succeeded" }));
    expect(onClear).not.toHaveBeenCalled();
    expect(onJobChange).not.toHaveBeenCalled();
  });

  it("does not carry a detail job or its recovery controls into another exact target", async () => {
    vi.mocked(submitQuarantine).mockResolvedValue({ ...job(), status: "partial", canReconcile: true });
    const { rerender } = render(<CopilotStudioQuarantineControls snapshot={snapshot} targets={[candidate]} variant="detail" canManage />);
    await confirmQuarantine("Quarantine");
    expect(await screen.findByRole("button", { name: "Reconcile by status read" })).toBeVisible();
    rerender(<CopilotStudioQuarantineControls snapshot={snapshot}
      targets={[{ ...candidate, nativeId: "other-native-target" }]} variant="detail" canManage />);
    expect(screen.queryByText("Quarantine job: Partial")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reconcile by status read" })).not.toBeInTheDocument();
    expect(screen.getByText("Not checked")).toBeVisible();
    expect(getQuarantineStatus).not.toHaveBeenCalled();
  });

  it("notifies the latest callback without clearing a newer selection after submit", async () => {
    const submitted = deferred<QuarantineJob>();
    vi.mocked(submitQuarantine).mockReturnValue(submitted.promise);
    const previousClear = vi.fn();
    const currentClear = vi.fn();
    const previousChange = vi.fn();
    const currentChange = vi.fn();
    const { rerender } = render(<CopilotStudioQuarantineControls snapshot={snapshot} targets={[candidate]}
      variant="bulk" canManage onClear={previousClear} onJobChange={previousChange} />);
    await confirmQuarantine("Quarantine selected");
    rerender(<CopilotStudioQuarantineControls snapshot={snapshot} targets={[{ ...candidate, nativeId: "new-selection" }]}
      variant="bulk" canManage onClear={currentClear} onJobChange={currentChange} />);
    const accepted = { ...job(), status: "succeeded" as const };
    await act(async () => submitted.resolve(accepted));
    expect(currentChange).toHaveBeenCalledExactlyOnceWith(accepted);
    expect(previousChange).not.toHaveBeenCalled();
    expect(previousClear).not.toHaveBeenCalled();
    expect(currentClear).not.toHaveBeenCalled();
    expect(screen.getByText("Quarantine job: Succeeded")).toBeVisible();
  });

  it("discards a recovery response after navigation to a different exact job", async () => {
    const recovery = deferred<QuarantineJob>();
    const previous = { ...job(), id: "previous-job", status: "partial" as const, canReconcile: true };
    vi.mocked(getQuarantineJob).mockResolvedValueOnce(previous)
      .mockResolvedValueOnce({ ...job(), id: "current-job", status: "succeeded" });
    vi.mocked(reconcileQuarantineJob).mockReturnValue(recovery.promise);
    const onJobChange = vi.fn();
    const { rerender } = render(<CopilotStudioQuarantineControls snapshot={snapshot} targets={[]}
      variant="bulk" canManage initialJobId="previous-job" onJobChange={onJobChange} />);
    fireEvent.click(await screen.findByRole("button", { name: "Reconcile by status read" }));
    rerender(<CopilotStudioQuarantineControls snapshot={snapshot} targets={[]}
      variant="bulk" canManage initialJobId="current-job" onJobChange={onJobChange} />);
    expect(await screen.findByText("Quarantine job: Succeeded")).toBeVisible();
    await act(async () => recovery.resolve({ ...previous, status: "cancelled" }));
    expect(screen.getByText("Quarantine job: Succeeded")).toBeVisible();
    expect(onJobChange).not.toHaveBeenCalled();
  });

  it("does not restore a delayed preview after the saved job read denies access", async () => {
    const pendingJobs = deferred<{ value: QuarantineJob[] }>();
    const pendingPreview = deferred<ReturnType<typeof preview>>();
    vi.mocked(getQuarantineJobs).mockReturnValue(pendingJobs.promise);
    vi.mocked(previewQuarantine).mockReturnValue(pendingPreview.promise);
    render(<CopilotStudioQuarantineControls snapshot={snapshot} targets={[candidate]} variant="bulk" canManage />);
    fireEvent.click(screen.getByRole("button", { name: "Quarantine selected" }));
    await act(async () => pendingJobs.reject(new ApiError(403, "forbidden", "Job access denied.")));
    expect(screen.getByRole("alert")).toHaveTextContent("Job access denied.");
    await act(async () => pendingPreview.resolve(preview()));
    expect(screen.queryByRole("dialog", { name: "Quarantine 1 agent" })).not.toBeInTheDocument();
  });

  it("keeps a pending submit confirmation open until it can show the outcome", async () => {
    const submitted = deferred<QuarantineJob>();
    vi.mocked(submitQuarantine).mockReturnValue(submitted.promise);
    render(<CopilotStudioQuarantineControls snapshot={snapshot} targets={[candidate]} variant="detail" canManage />);
    const dialog = await confirmQuarantine("Quarantine");
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "Close quarantine confirmation" })).toBeDisabled();
    const cancel = new Event("cancel", { cancelable: true });
    fireEvent(dialog, cancel);
    expect(cancel.defaultPrevented).toBe(true);
    const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    fireEvent(dialog, tab);
    expect(tab.defaultPrevented).toBe(true);
    expect(dialog.querySelector(".quarantine-confirmation-body")).toHaveFocus();
    await act(async () => submitted.reject(new Error("Submit could not be confirmed.")));
    expect(within(dialog).getByRole("alert")).toHaveTextContent("Submit could not be confirmed.");
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeEnabled();
  });

  it("keeps a newer explicit job read when an older automatic poll completes", async () => {
    vi.useFakeTimers();
    const oldPoll = deferred<QuarantineJob>();
    const running = { ...job(), status: "running" as const, total: 3 };
    vi.mocked(getQuarantineJobs).mockResolvedValue({ value: [running] });
    vi.mocked(getQuarantineJob).mockReturnValueOnce(oldPoll.promise)
      .mockResolvedValueOnce({ ...running, completed: 2, succeeded: 2 });
    render(<CopilotStudioQuarantineControls snapshot={snapshot} targets={[]} variant="bulk" canManage />);
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(getQuarantineJob).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Refresh job status" }));
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByText(/2 of 3 complete/)).toBeVisible();
    await act(async () => oldPoll.resolve(running));
    expect(screen.getByText(/2 of 3 complete/)).toBeVisible();
    expect(vi.mocked(getQuarantineJob).mock.calls[0][1]?.signal?.aborted).toBe(true);
  });

  it("reads current job state after an accepted resume returns its pre-resume waiting state", async () => {
    vi.useFakeTimers();
    const waiting = { ...job(), status: "waiting_authorization" as const, canResume: true };
    vi.mocked(getQuarantineJobs).mockResolvedValue({ value: [waiting] });
    vi.mocked(resumeQuarantineJob).mockResolvedValue(waiting);
    vi.mocked(getQuarantineJob).mockResolvedValueOnce(waiting)
      .mockResolvedValue({ ...job(), status: "succeeded", completed: 1, succeeded: 1 });
    render(<CopilotStudioQuarantineControls snapshot={snapshot} targets={[]} variant="bulk" canManage />);
    await act(async () => { await Promise.resolve(); });
    fireEvent.click(screen.getByRole("button", { name: "Resume unsent work" }));
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(getQuarantineJob).toHaveBeenCalledExactlyOnceWith(waiting.id, { signal: expect.any(AbortSignal) });
    expect(screen.getByText("Quarantine job: Waiting Authorization")).toBeVisible();
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(screen.getByText("Quarantine job: Succeeded")).toBeVisible();
    expect(resumeQuarantineJob).toHaveBeenCalledExactlyOnceWith(waiting.id);
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(getQuarantineJob).toHaveBeenCalledTimes(2);
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

  function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<T>((complete, fail) => { resolve = complete; reject = fail; });
    return { promise, resolve, reject };
  }

  async function confirmQuarantine(buttonName: string, container?: HTMLElement) {
    const controls = container ? within(container) : screen;
    fireEvent.click(controls.getByRole("button", { name: buttonName }));
    const dialog = await controls.findByRole("dialog", { name: "Quarantine 1 agent" });
    fireEvent.click(within(dialog).getByRole("checkbox"));
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirm quarantine" }));
    return dialog;
  }

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

  it("does not reset the automatic read budget when a queued job starts running", async () => {
    vi.useFakeTimers();
    vi.mocked(getQuarantineJobs).mockResolvedValue({ value: [job()] });
    vi.mocked(getQuarantineJob).mockResolvedValue({ ...job(), status: "running" });
    render(<CopilotStudioQuarantineControls snapshot={snapshot} targets={[]} variant="bulk" canManage />);
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(screen.getByText("Quarantine job: Running")).toBeVisible();
    await act(async () => { await vi.advanceTimersByTimeAsync(69_000); });
    expect(getQuarantineJob).toHaveBeenCalledTimes(60);
    expect(screen.getByRole("alert")).toHaveTextContent("Automatic job status checks stopped");
  });

  it.each(["latest", "exact"] as const)("admits only the surviving Strict Mode saved reads and aborts an unfinished %s job restoration", async source => {
    if (source === "exact") vi.mocked(getQuarantineJob).mockReturnValue(new Promise(() => {}));
    else vi.mocked(getQuarantineJobs).mockReturnValue(new Promise(() => {}));
    const { unmount } = render(<CopilotStudioQuarantineTargetPicker initialJobId={source === "exact" ? job().id : undefined} />, { reactStrictMode: true });
    expect(await screen.findByText("Saved agent")).toBeVisible();
    expect(getQuarantineTargets).toHaveBeenCalledOnce();
    expect(source === "exact" ? getQuarantineJob : getQuarantineJobs).toHaveBeenCalledOnce();
    expect(source === "exact" ? getQuarantineJobs : getQuarantineJob).not.toHaveBeenCalled();
    expect(getQuarantineStatus).not.toHaveBeenCalled();
    expect(previewQuarantine).not.toHaveBeenCalled();
    unmount();
    const signal = source === "exact"
      ? vi.mocked(getQuarantineJob).mock.calls[0][1]?.signal
      : vi.mocked(getQuarantineJobs).mock.calls[0][1]?.signal;
    expect(signal?.aborted).toBe(true);
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