import { createRef } from "react";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryObserver } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  DataSyncPanelHandle,
} from "./DataSyncPanel";
import type {
  DataSyncRun,
  DataSyncSourceId,
  DataSyncSourceState,
  DataSyncSourceStatus,
  DataSyncState,
} from "../api/client";
import { ApiError } from "../api/client";
import { DataSyncPanel } from "./DataSyncPanel";
import { mockNativeDialogs } from "../test/dialog";
import { createSavedQueryClient, readSavedQuery } from "../savedQueries";
import { SavedQueryProvider } from "./SavedQueryProvider";

mockNativeDialogs();

const api = vi.hoisted(() => ({
  cancel: vi.fn(),
  getRun: vi.fn(),
  getState: vi.fn(),
  retry: vi.fn(),
  start: vi.fn(),
}));

vi.mock("../api/client", async importOriginal => ({
  ...await importOriginal<typeof import("../api/client")>(),
  cancelDataSyncRun: api.cancel,
  getDataSyncRun: api.getRun,
  getDataSyncState: api.getState,
  retryDataSyncRun: api.retry,
  startDataSync: api.start,
}));

vi.mock("../workbenchActionContext", () => ({
  WorkbenchActionGate: ({ children }: { children: React.ReactNode }) => children,
}));

const sourceIds: DataSyncSourceId[] = ["users", "graph_packages", "power_platform", "usage_reports"];

function source(
  id: DataSyncSourceId,
  status: DataSyncSourceState,
  overrides: Partial<DataSyncSourceStatus> = {},
): DataSyncSourceStatus {
  return {
    source: id,
    status,
    jobId: null,
    count: null,
    lastSuccessAt: null,
    updatedAt: "2026-09-15T10:00:00.000Z",
    message: "",
    canRetry: false,
    ...overrides,
  };
}

function run(
  status: DataSyncRun["status"],
  sources: DataSyncSourceStatus[],
  overrides: Partial<DataSyncRun> = {},
): DataSyncRun {
  return {
    id: "sync-run-1",
    mode: "initial",
    status,
    startedAt: "2026-09-15T10:00:00.000Z",
    updatedAt: "2026-09-15T10:00:00.000Z",
    completedAt: status === "completed" ? "2026-09-15T10:01:00.000Z" : null,
    sources,
    ...overrides,
  };
}

function syncState(overrides: Partial<DataSyncState> = {}): DataSyncState {
  const sources = sourceIds.map(id => source(id, "not_started"));
  return {
    onboardingRequired: true,
    usageImportRequired: true,
    run: null,
    sources,
    ...overrides,
  };
}

function renderPanel(options: {
  active?: boolean;
  canUploadUsage?: boolean;
  onOpenUsageImport?: () => void;
  onRequestedRunChange?: (runId: string | undefined) => void;
  onSetupRequiredChange?: (required: boolean) => void;
  onSourcesChanged?: (sources: DataSyncSourceId[]) => void;
  principalKey?: string;
  requestedRunId?: string;
  ref?: React.RefObject<DataSyncPanelHandle | null>;
  strictMode?: boolean;
} = {}) {
  const props = {
    ref: options.ref,
    active: options.active,
    principalKey: options.principalKey ?? "tenant:user:viewer",
    canUploadUsage: options.canUploadUsage ?? true,
    requestedRunId: options.requestedRunId,
    onOpenUsageImport: options.onOpenUsageImport ?? vi.fn(),
    onRequestedRunChange: options.onRequestedRunChange ?? vi.fn(),
    onSetupRequiredChange: options.onSetupRequiredChange,
    onSourcesChanged: options.onSourcesChanged ?? vi.fn(),
  };
  const view = render(<DataSyncPanel {...props} />, { reactStrictMode: options.strictMode });
  return {
    ...view,
    rerenderPanel(changes: Partial<typeof options>) {
      Object.assign(props, changes);
      view.rerender(<DataSyncPanel {...props} />);
    },
  };
}

describe("DataSyncPanel", () => {
  beforeEach(() => {
    api.cancel.mockReset();
    api.getRun.mockReset();
    api.getState.mockReset();
    api.retry.mockReset();
    api.start.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("loads onboarding while initially inactive and reports the setup hint without exposing UI", async () => {
    api.getState.mockResolvedValue(syncState());
    const onSetupRequiredChange = vi.fn();
    const overflow = document.body.style.overflow;
    const view = renderPanel({ active: false, onSetupRequiredChange });

    await waitFor(() => expect(onSetupRequiredChange).toHaveBeenLastCalledWith(true));
    expect(view.container).toBeEmptyDOMElement();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(document.body.style.overflow).toBe(overflow);
    expect(api.getState).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(api.start).not.toHaveBeenCalled();
    expect(api.cancel).not.toHaveBeenCalled();

    await act(async () => { view.rerenderPanel({ active: true }); });
    expect(screen.getByRole("region", { name: "Data sync" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Start initial sync" })).toBeEnabled();
    expect(api.getState).toHaveBeenCalledTimes(2);
    expect(api.start).not.toHaveBeenCalled();
  });

  it("keeps the visible page loading until the saved status response makes setup available", async () => {
    let resolveState!: (value: DataSyncState) => void;
    api.getState.mockReturnValueOnce(new Promise<DataSyncState>(resolve => { resolveState = resolve; }));
    renderPanel();

    expect(await screen.findByRole("region", { name: "Data sync" })).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent("Loading saved data sync status...");
    expect(screen.queryByRole("heading", { name: "Workspace data" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Start initial sync" })).not.toBeInTheDocument();
    expect(api.start).not.toHaveBeenCalled();

    await act(async () => resolveState(syncState()));

    expect(await screen.findByRole("heading", { name: "Workspace data" })).toBeVisible();
    expect(screen.queryByText("Loading saved data sync status...")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start initial sync" })).toBeEnabled();
    expect(api.getState).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(api.start).not.toHaveBeenCalled();
  });

  it("renders the setup page by default, keeps it visible during report import, and accepts a zero-row successful sync", async () => {
    const initial = syncState();
    const queuedSources = initial.sources.map(item => source(item.source, "queued"));
    const started = run("running", queuedSources);
    const completedSources = sourceIds.map(id => source(id, "succeeded", {
      count: 0,
      lastSuccessAt: "2026-09-15T10:01:00.000Z",
    }));
    const completed = syncState({
      onboardingRequired: false,
      usageImportRequired: false,
      run: run("completed", completedSources),
      sources: completedSources,
    });
    const onChanged = vi.fn();
    const onUpload = vi.fn();
    api.getState.mockResolvedValueOnce(initial).mockResolvedValueOnce(completed);
    api.start.mockResolvedValue(started);

    renderPanel({ onSourcesChanged: onChanged, onOpenUsageImport: onUpload });

    expect(screen.getByRole("region", { name: "Data sync" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Data sync", level: 2 })).toBeVisible();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Data sync/i })).not.toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Workspace data" })).toBeVisible();
    expect(screen.getByText(/Agents, Users & agents, and Users/)).toBeVisible();
    expect(screen.getByText(/7- or 30-day selection/)).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Add CSV reports" }));
    expect(onUpload).toHaveBeenCalledOnce();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Data sync" })).toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: "Start initial sync" }));
    expect(api.start).toHaveBeenCalledWith({ mode: "initial" }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledWith(sourceIds));
    expect(screen.getAllByText("3 of 3 sources synced")).not.toHaveLength(0);
    const users = screen.getByText("Users", { selector: "strong" }).closest("article");
    expect(users).not.toBeNull();
    expect(within(users!).getByText("0")).toBeVisible();
  });

  it("lets viewers run read syncs but reserves report upload for admins without blocking the workbench", async () => {
    api.getState.mockResolvedValue(syncState());
    renderPanel({ canUploadUsage: false });

    await screen.findByRole("heading", { name: "Workspace data" });
    expect(screen.getByRole("button", { name: "Start initial sync" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Add CSV reports" })).not.toBeInTheDocument();
    expect(screen.getByText("An AgentControl.Admin can import reports.")).toBeVisible();
    expect(screen.getByText(/does not block collecting users or inventory/)).toBeVisible();
  });

  it("starts nondestructive refresh and hidden users-only syncs without provider reads on navigation", async () => {
    const successful = sourceIds.map(id => source(id, "succeeded", { count: 4 }));
    const settled = syncState({
      onboardingRequired: false,
      usageImportRequired: false,
      sources: successful,
    });
    api.getState.mockResolvedValue(settled);
    api.start.mockImplementation((input: { mode: DataSyncRun["mode"]; sources?: DataSyncSourceId[] }) =>
      Promise.resolve(run("running", (input.sources ?? sourceIds).map(id => source(id, "running")), {
        mode: input.mode,
      })));
    const panelRef = createRef<DataSyncPanelHandle>();
    const view = renderPanel({ ref: panelRef });
    await screen.findByText(/Sync keeps previous successful data/);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(api.start).not.toHaveBeenCalled();

    expect(screen.getByText(/Sync keeps previous successful data/)).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Sync all sources" }));
    expect(api.start).toHaveBeenCalledWith({ mode: "incremental" }, expect.anything());
    view.rerenderPanel({ active: false });

    await act(async () => {
      await panelRef.current?.start("incremental", ["users"]);
    });
    expect(api.start).toHaveBeenLastCalledWith(
      { mode: "incremental", sources: ["users"] },
      expect.anything(),
    );
    expect(screen.queryByRole("region", { name: "Data sync" })).not.toBeInTheDocument();
    view.rerenderPanel({ active: true });
    expect(screen.getByRole("region", { name: "Data sync" })).toBeVisible();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(api.start).toHaveBeenCalledTimes(2);
  });

  it("retries only incomplete retryable sources and cancels a server-owned run", async () => {
    const sources = [
      source("users", "succeeded", { count: 10, canRetry: true }),
      source("graph_packages", "failed", { canRetry: true, message: "Temporary failure." }),
      source("power_platform", "partial", { canRetry: false }),
      source("usage_reports", "awaiting_upload", { canRetry: true }),
    ];
    const waiting = run("waiting", sources);
    api.getState.mockResolvedValue(syncState({ run: waiting, sources }));
    api.retry.mockResolvedValue(run("running", sources));
    api.cancel.mockResolvedValue(run("cancelled", sources));
    renderPanel();

    expect(await screen.findByRole("button", { name: "Retry incomplete (2)" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Start initial sync" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Sync all sources" })).not.toBeInTheDocument();
    expect(screen.getByText("Temporary failure.")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Retry incomplete (2)" }));
    expect(api.retry).toHaveBeenCalledWith(
      waiting.id,
      ["graph_packages", "usage_reports"],
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Cancel run" }));
    expect(api.cancel).toHaveBeenCalledWith(waiting.id, expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it.each([
    { label: "the displayed run is executing", currentStatus: "running", requestedRunId: undefined },
    { label: "a different run is executing", currentStatus: "running", requestedRunId: "historical-run" },
    { label: "a different run is waiting", currentStatus: "waiting", requestedRunId: "historical-run" },
  ] as const)("prevents retrying incomplete sources while $label", async ({ currentStatus, requestedRunId }) => {
    const failed = source("users", "failed", { canRetry: true });
    const sources = [
      failed,
      source("graph_packages", currentStatus === "running" ? "running" : "waiting_authorization", {
        canRetry: currentStatus === "waiting",
      }),
    ];
    api.getState.mockResolvedValue(syncState({ run: run(currentStatus, sources), sources }));
    api.getRun.mockResolvedValue(run("partial", [failed], { id: "historical-run" }));
    const panelRef = createRef<DataSyncPanelHandle>();
    renderPanel({ ref: panelRef, requestedRunId });

    const target = requestedRunId ? within(await screen.findByRole("dialog", { name: "Sync run details" })) : screen;
    const retry = await target.findByRole("button", { name: "Retry incomplete (1)" });
    expect(retry).toBeDisabled();
    expect(target.getByText("Finish or cancel the active sync run before retrying these sources.")).toBeVisible();
    await userEvent.click(retry);
    expect(api.retry).not.toHaveBeenCalled();

    const settledSources = [failed, source("graph_packages", "succeeded", { count: 0 })];
    api.getState.mockResolvedValue(syncState({ run: run("partial", settledSources), sources: settledSources }));
    await act(async () => { await panelRef.current?.refresh(); });
    expect(target.getByRole("button", { name: "Retry incomplete (1)" })).toBeEnabled();
    expect(target.queryByText("Finish or cancel the active sync run before retrying these sources.")).not.toBeInTheDocument();
  });

  it("does not invalidate retained snapshots when a failed source is queued for retry", async () => {
    const failed = source("users", "failed", {
      count: 0, lastSuccessAt: "2026-09-15T10:00:00.000Z", canRetry: true,
    });
    const queued = { ...failed, status: "queued" as const, canRetry: false };
    api.getState
      .mockResolvedValueOnce(syncState({ run: run("partial", [failed]), sources: [failed] }))
      .mockResolvedValue(syncState({ run: run("running", [queued]), sources: [queued] }));
    api.retry.mockResolvedValue(run("running", [queued]));
    const onChanged = vi.fn();
    renderPanel({ onSourcesChanged: onChanged });

    await userEvent.click(await screen.findByRole("button", { name: "Retry incomplete (1)" }));
    expect(api.retry).toHaveBeenCalledExactlyOnceWith("sync-run-1", ["users"], expect.anything());
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("keeps overall source data visible and opens completed run details separately", async () => {
    const sources = sourceIds.map(id => source(id, "succeeded", { count: 42 }));
    const completed = syncState({
      onboardingRequired: false, usageImportRequired: false,
      run: run("completed", sources), sources,
    });
    api.getState.mockResolvedValue(completed);
    api.getRun.mockResolvedValue(completed.run);
    const onRequestedRunChange = vi.fn();
    const view = renderPanel({ onRequestedRunChange });
    onRequestedRunChange.mockImplementation((requestedRunId: string | undefined) => view.rerenderPanel({ requestedRunId }));
    await screen.findByText("Sync complete");

    const page = within(screen.getByRole("region", { name: "Data sync" }));
    expect(page.getAllByText("Sync complete")).toHaveLength(1);
    expect(page.getByText("3 of 3 sources synced")).toBeVisible();
    expect(page.getByText(/Last successful collection across all sources/)).toBeVisible();
    expect(page.queryByText(/Verify saved inventory below/)).not.toBeInTheDocument();
    expect(page.queryByRole("progressbar")).not.toBeInTheDocument();
    expect(page.queryByText("Keep your saved data up to date")).not.toBeInTheDocument();
    expect(page.queryByRole("button", { name: "Check progress" })).not.toBeInTheDocument();
    expect(page.queryByText(/Closing this window does not cancel sync/)).not.toBeInTheDocument();
    expect(page.getAllByText("Sync all sources")).toHaveLength(1);
    expect(page.queryByText("sync-run-1", { selector: "code" })).not.toBeInTheDocument();
    expect(page.getByRole("article", { name: "Graph packages" })).toBeVisible();
    expect(page.getByRole("button", { name: "Reset saved data..." })).toBeVisible();
    expect(view.container.querySelector("details")).toBeNull();
    expect(api.start).not.toHaveBeenCalled();

    await userEvent.click(page.getByText("View run details"));
    expect(await screen.findByRole("dialog", { name: "Sync run details" })).toBeVisible();
    expect(page.getByText("sync-run-1", { selector: "code" })).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Back to workspace" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    const runningSources = sourceIds.map(id => source(id, "running"));
    const nextRun = run("running", runningSources, { mode: "incremental", id: "new-run" });
    api.start.mockResolvedValue(nextRun);
    api.getState.mockResolvedValue({ ...completed, run: nextRun });
    await userEvent.click(page.getByRole("button", { name: "Sync all sources" }));
    expect(api.start).toHaveBeenCalledWith({ mode: "incremental" }, expect.anything());
    expect(page.getByRole("progressbar")).toBeVisible();
    expect(page.getByRole("article", { name: "Users" })).toBeVisible();
    expect(within(page.getByRole("article", { name: "Graph packages" })).getByText("42")).toBeVisible();
    expect(page.queryByText("Sync complete")).not.toBeInTheDocument();
    expect(page.queryByText("Sync in progress")).not.toBeInTheDocument();
  });

  it("offers a status retry only after a failed status read without starting another sync", async () => {
    const sources = sourceIds.map(id => source(id, "succeeded"));
    api.getState
      .mockRejectedValueOnce(new Error("Status request failed."))
      .mockResolvedValue(syncState({
        onboardingRequired: false, usageImportRequired: false,
        run: run("completed", sources), sources,
      }));
    renderPanel();
    expect(await screen.findByRole("alert")).toHaveTextContent("Status request failed.");
    await userEvent.click(screen.getByRole("button", { name: "Retry status check" }));
    expect(await screen.findByText("Sync complete")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Retry status check" })).not.toBeInTheDocument();
    expect(api.getState).toHaveBeenCalledTimes(2);
    expect(api.start).not.toHaveBeenCalled();
    expect(api.retry).not.toHaveBeenCalled();
  });

  it.each([
    ["state", 401], ["state", 403], ["run", 401], ["run", 403],
  ] as const)("clears all private sync data after a denied %s read (%s) and fences a concurrent success", async (denied, status) => {
    const sources = [source("users", "succeeded", { count: 42 })];
    const saved = syncState({ onboardingRequired: false, sources });
    const exact = run("partial", [source("users", "failed", { canRetry: true })], { id: "exact-run" });
    api.getState.mockResolvedValue(saved);
    api.getRun.mockResolvedValue(exact);
    const panelRef = createRef<DataSyncPanelHandle>();
    const onSourcesChanged = vi.fn();
    renderPanel({ ref: panelRef, requestedRunId: exact.id, onSourcesChanged });
    await screen.findByText(exact.id, { selector: "code" });
    expect(screen.getByRole("article", { name: "Users" })).toHaveTextContent("42");

    let settleLate!: () => void;
    const failure = new ApiError(status, "forbidden", "Sync access was denied.");
    if (denied === "state") {
      api.getState.mockRejectedValueOnce(failure);
      api.getRun.mockReturnValueOnce(new Promise(resolve => { settleLate = () => resolve(exact); }));
    } else {
      api.getState.mockReturnValueOnce(new Promise(resolve => { settleLate = () => resolve(saved); }));
      api.getRun.mockRejectedValueOnce(failure);
    }
    await act(async () => { void panelRef.current?.refresh(); });
    expect(await screen.findByRole("alert")).toHaveTextContent("Sync access was denied.");
    expect(screen.queryByRole("heading", { name: "Workspace data" })).not.toBeInTheDocument();
    expect(screen.queryByText(exact.id, { selector: "code" })).not.toBeInTheDocument();
    await act(async () => { settleLate(); });
    expect(screen.queryByRole("article", { name: "Users" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Retry incomplete/ })).not.toBeInTheDocument();
    expect(onSourcesChanged).not.toHaveBeenCalled();

    await act(async () => { void panelRef.current?.refresh(); });
    expect(await screen.findByRole("article", { name: "Users" })).toHaveTextContent("42");
    expect(await screen.findByText(exact.id, { selector: "code" })).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("keeps read and command admission busy until the post-command saved status settles", async () => {
    const running = run("running", [source("users", "running")]);
    let resolveStart!: (value: DataSyncRun) => void;
    let resolveStatus!: (value: DataSyncState) => void;
    api.getState.mockResolvedValueOnce(syncState())
      .mockReturnValueOnce(new Promise(resolve => { resolveStatus = resolve; }));
    api.start.mockReturnValueOnce(new Promise(resolve => { resolveStart = resolve; }));
    const panelRef = createRef<DataSyncPanelHandle>();
    renderPanel({ ref: panelRef });
    await userEvent.click(await screen.findByRole("button", { name: "Start initial sync" }));
    await act(async () => { void panelRef.current?.refresh(); });
    expect(api.getState).toHaveBeenCalledOnce();
    await act(async () => { resolveStart(running); });
    expect(api.getState).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("button", { name: "Starting sync..." })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel run" })).toBeDisabled();
    await act(async () => { void panelRef.current?.start("incremental"); });
    expect(api.start).toHaveBeenCalledOnce();
    await act(async () => { resolveStatus(syncState({ run: running })); });
    expect(screen.getByRole("button", { name: "Cancel run" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Check status" })).toBeEnabled();
  });

  it("revalidates the newly selected exact run after a different run's pending mutation settles", async () => {
    const failed = run("partial", [source("users", "failed", { canRetry: true })]);
    const newer = run("completed", [source("users", "succeeded", { count: 2 })], { id: "newer-run" });
    api.getState.mockResolvedValue(syncState());
    api.getRun.mockResolvedValueOnce(failed).mockResolvedValue(newer);
    let resolveRetry!: (value: DataSyncRun) => void;
    api.retry.mockReturnValueOnce(new Promise(resolve => { resolveRetry = resolve; }));
    const view = renderPanel({ requestedRunId: failed.id });
    await userEvent.click(await screen.findByRole("button", { name: "Retry incomplete (1)" }));
    view.rerenderPanel({ requestedRunId: newer.id });
    await screen.findByText(newer.id, { selector: "code" });
    expect(api.getRun).toHaveBeenCalledTimes(2);
    await act(async () => { resolveRetry(run("running", [source("users", "running")])); });
    await waitFor(() => expect(api.getRun).toHaveBeenCalledTimes(3));
    expect(api.getRun).toHaveBeenLastCalledWith(newer.id, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(screen.getByText(newer.id, { selector: "code" })).toBeVisible();
  });

  it.each(["state", "run"] as const)("preserves the %s five-minute budget across navigation and real Strict Mode effect replay", async target => {
    vi.useFakeTimers();
    const active = run("running", [source("users", "running")]);
    api.getState.mockResolvedValue(syncState({ run: target === "state" ? active : null }));
    api.getRun.mockResolvedValue(active);
    const view = renderPanel({ strictMode: true, requestedRunId: target === "run" ? active.id : undefined });
    await act(async () => { await vi.advanceTimersByTimeAsync(240_000); });
    await act(async () => { view.rerenderPanel({ active: false }); });
    await act(async () => { view.rerenderPanel({ active: true }); });
    await act(async () => { await vi.advanceTimersByTimeAsync(60_001); });
    expect(screen.getByRole("button", { name: "Resume updates" })).toBeVisible();
    const reads = api.getState.mock.calls.length;
    const runReads = api.getRun.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(api.getState).toHaveBeenCalledTimes(reads);
    expect(api.getRun).toHaveBeenCalledTimes(runReads);
    expect(api.start).not.toHaveBeenCalled();
  });

  it("refreshes after an external action without joining or cancelling another observer's pre-action read", async () => {
    const client = createSavedQueryClient();
    let resolveOld!: (value: DataSyncState) => void;
    api.getState.mockReturnValueOnce(new Promise(resolve => { resolveOld = resolve; }))
      .mockResolvedValue(syncState({ sources: [source("users", "succeeded", { count: 7 })] }));
    const panelRef = createRef<DataSyncPanelHandle>();
    render(<SavedQueryProvider client={client}><DataSyncPanel
      ref={panelRef} principalKey="tenant:user:viewer" canUploadUsage
      onOpenUsageImport={vi.fn()} onRequestedRunChange={vi.fn()} onSourcesChanged={vi.fn()}
    /></SavedQueryProvider>);
    await waitFor(() => expect(api.getState).toHaveBeenCalledOnce());
    const oldSignal = api.getState.mock.calls[0][0].signal as AbortSignal;
    const query = client.getQueryCache().getAll().find(query => query.state.fetchStatus === "fetching")!;
    const peer = new AbortController();
    const peerRead = readSavedQuery<DataSyncState>(client, query.queryKey.slice(1), () => Promise.reject(new Error("Expected deduplication")), peer.signal);
    await act(async () => { void panelRef.current?.refresh(); });
    expect(api.getState).toHaveBeenCalledTimes(2);
    expect(oldSignal.aborted).toBe(false);
    expect(await screen.findByRole("article", { name: "Users" })).toHaveTextContent("7");
    await act(async () => {
      resolveOld(syncState({ sources: [source("users", "succeeded", { count: 3 })] }));
      await peerRead;
    });
    expect(screen.getByRole("article", { name: "Users" })).toHaveTextContent("7");
    expect(api.start).not.toHaveBeenCalled();
  });

  it("fences denied sibling reads without purging unrelated data or cancelling an independent observer", async () => {
    const client = createSavedQueryClient();
    const unrelatedKey = ["saved", "independent-provider-metadata"];
    const unrelated = new QueryObserver(client, {
      queryKey: unrelatedKey, initialData: "Still authorized", enabled: false,
    });
    const unsubscribe = unrelated.subscribe(() => {});
    const sources = [source("users", "succeeded", { count: 42 })];
    const exact = run("partial", [source("users", "failed", { canRetry: true })], { id: "exact-run" });
    api.getState.mockResolvedValue(syncState({ sources }));
    api.getRun.mockResolvedValue(exact);
    const panelRef = createRef<DataSyncPanelHandle>();
    const onSourcesChanged = vi.fn();
    render(<SavedQueryProvider client={client}><DataSyncPanel
      ref={panelRef} principalKey="tenant:user:viewer" requestedRunId={exact.id} canUploadUsage
      onOpenUsageImport={vi.fn()} onRequestedRunChange={vi.fn()} onSourcesChanged={onSourcesChanged}
    /></SavedQueryProvider>);
    try {
      await screen.findByText(exact.id, { selector: "code" });
      let rejectState!: (reason: Error) => void;
      let resolveRun!: (value: DataSyncRun) => void;
      api.getState.mockReturnValueOnce(new Promise((_resolve, reject) => { rejectState = reject; }));
      api.getRun.mockReturnValueOnce(new Promise(resolve => { resolveRun = resolve; }));
      await act(async () => { void panelRef.current?.refresh(); });
      await waitFor(() => expect(api.getRun).toHaveBeenCalledTimes(2));
      const query = client.getQueryCache().getAll().find(query =>
        query.queryKey[1] === "data-sync-run" && query.state.fetchStatus === "fetching")!;
      const peerRead = readSavedQuery<DataSyncRun>(client, query.queryKey.slice(1),
        () => Promise.reject(new Error("Expected deduplication")), new AbortController().signal);
      const runSignal = api.getRun.mock.calls[1][1].signal as AbortSignal;

      await act(async () => { rejectState(new ApiError(403, "forbidden", "This workflow is no longer authorized.")); });
      expect(screen.getByRole("alert")).toHaveTextContent("This workflow is no longer authorized.");
      expect(screen.queryByRole("article", { name: "Users" })).not.toBeInTheDocument();
      expect(runSignal.aborted).toBe(false);
      expect(client.getQueryData(unrelatedKey)).toBe("Still authorized");

      const lateRun = run("completed", [source("users", "succeeded", { count: 99 })], { id: exact.id });
      await act(async () => {
        resolveRun(lateRun);
        expect(await peerRead).toEqual(lateRun);
      });
      expect(screen.queryByText(exact.id, { selector: "code" })).not.toBeInTheDocument();
      expect(screen.queryByRole("article", { name: "Users" })).not.toBeInTheDocument();
      expect(onSourcesChanged).not.toHaveBeenCalled();
      expect(client.getQueryData(unrelatedKey)).toBe("Still authorized");
    } finally {
      unsubscribe();
    }
  });

  it("aborts an outstanding mutation after a concurrent exact-run denial and ignores its late success", async () => {
    const failed = run("partial", [source("users", "failed", { canRetry: true })]);
    const onSourcesChanged = vi.fn();
    let resolveRetry!: (value: DataSyncRun) => void;
    api.getState.mockResolvedValue(syncState({ sources: [source("users", "succeeded", { count: 42 })] }));
    api.getRun.mockResolvedValueOnce(failed).mockRejectedValue(new ApiError(403, "forbidden", "Run access was denied."));
    api.retry.mockReturnValueOnce(new Promise(resolve => { resolveRetry = resolve; }));
    const view = renderPanel({ requestedRunId: failed.id, onSourcesChanged });
    await userEvent.click(await screen.findByRole("button", { name: "Retry incomplete (1)" }));
    const signal = api.retry.mock.calls[0][2].signal as AbortSignal;
    view.rerenderPanel({ requestedRunId: "no-longer-authorized" });
    expect(await screen.findByRole("alert")).toHaveTextContent("Run access was denied.");
    expect(signal.aborted).toBe(true);
    await act(async () => { resolveRetry(run("completed", [source("users", "succeeded", { count: 99 })])); });
    expect(screen.queryByRole("article", { name: "Users" })).not.toBeInTheDocument();
    expect(screen.queryByText("Sync complete")).not.toBeInTheDocument();
    expect(api.getState).toHaveBeenCalledOnce();
    expect(onSourcesChanged).not.toHaveBeenCalled();
  });

  it("shows saved-status refresh as busy and restores details focus when its opener disappears", async () => {
    const partial = run("partial", [source("users", "failed", { canRetry: true })]);
    api.getState.mockResolvedValueOnce(syncState({ run: partial }));
    api.getRun.mockResolvedValue(partial);
    const panelRef = createRef<DataSyncPanelHandle>();
    const onRequestedRunChange = vi.fn();
    const view = renderPanel({ ref: panelRef, onRequestedRunChange });
    onRequestedRunChange.mockImplementation((requestedRunId: string | undefined) => view.rerenderPanel({ requestedRunId }));
    await userEvent.click(await screen.findByRole("button", { name: "View run details" }));
    await screen.findByText(partial.id, { selector: "code" });
    let resolveState!: (value: DataSyncState) => void;
    api.getState.mockReturnValueOnce(new Promise(resolve => { resolveState = resolve; }));
    await act(async () => { void panelRef.current?.refresh(); });
    expect(screen.getByRole("button", { name: "Check status" })).toBeDisabled();
    await act(async () => { resolveState(syncState()); });
    await userEvent.click(screen.getByRole("button", { name: "Back to workspace" }));
    expect(screen.getByRole("heading", { name: "Data sync" })).toHaveFocus();
    expect(screen.getByRole("button", { name: "Check status" })).toBeEnabled();
  });

  it("does not call an inconsistent completed run cancelled or fully successful", async () => {
    api.getState.mockResolvedValue(syncState({
      run: run("completed", [source("users", "failed", { count: 3, canRetry: true })]),
    }));
    renderPanel();
    expect(await screen.findByText("Sync needs attention")).toBeVisible();
    expect(screen.queryByText("Sync complete")).not.toBeInTheDocument();
    expect(screen.queryByText("Sync cancelled")).not.toBeInTheDocument();
    expect(screen.getByText("reported, not a saved total")).toBeVisible();
  });

  it("keeps current upload requirements visible when viewing a completed historical run", async () => {
    api.getState.mockResolvedValue(syncState());
    api.getRun.mockResolvedValue(run("completed", sourceIds.map(id => source(id, "succeeded")), { id: "historical-run" }));
    renderPanel({ requestedRunId: "historical-run" });
    expect(await screen.findByText("Sync complete")).toBeVisible();
    expect(screen.getByText("historical-run", { selector: "code" })).toBeVisible();
    expect(screen.getByText("Import needed")).toBeVisible();
    expect(screen.getByRole("button", { name: "Add CSV reports" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Start initial sync" })).toBeInTheDocument();
  });

  it("does not label a failed attempt's reported records as saved data", async () => {
    const sources = [
      source("users", "succeeded", { count: 3_951 }),
      source("graph_packages", "succeeded", { count: 1_005 }),
      source("power_platform", "failed", { count: 4_173, canRetry: true, message: "The prior snapshot was preserved." }),
      source("usage_reports", "succeeded", { count: 1_061 }),
    ];
    const saved = sources.map(value => value.source === "power_platform"
      ? source("power_platform", "succeeded", { count: 4_000, lastSuccessAt: "2026-09-14T10:00:00.000Z" }) : value);
    api.getState.mockResolvedValue(syncState({ run: run("partial", sources), sources: saved }));
    renderPanel();

    await screen.findByText("4,173");
    const powerPlatform = within(screen.getByRole("article", { name: "Power Platform" }));
    expect(powerPlatform.getByText("Last saved count")).toBeVisible();
    expect(powerPlatform.getByText("4,000")).toBeVisible();
    expect(powerPlatform.queryByText("4,173")).not.toBeInTheDocument();
    const attempt = screen.getByText("4,173").closest("li")!;
    expect(within(attempt).getByText("reported, not a saved total")).toBeVisible();
    const packages = within(screen.getByRole("article", { name: "Graph packages" }));
    expect(packages.getByText("Last saved count")).toBeVisible();
    expect(packages.getByText("1,005")).toBeVisible();
  });

  it("preserves every last-success count during a users-only sync and after its completion", async () => {
    const saved = [
      source("users", "succeeded", { count: 42, lastSuccessAt: "2026-09-15T10:00:00.000Z" }),
      source("graph_packages", "succeeded", { count: 1_005, lastSuccessAt: "2026-09-14T10:00:00.000Z" }),
      source("power_platform", "succeeded", { count: 4_178, lastSuccessAt: "2026-09-13T10:00:00.000Z" }),
      source("usage_reports", "succeeded", { count: 1_061, lastSuccessAt: "2026-09-12T10:00:00.000Z" }),
    ];
    const current = run("running", [source("users", "running", {
      count: 17, message: "Reading distinct licensed users.",
    })], { mode: "incremental" });
    api.getState.mockResolvedValue(syncState({ onboardingRequired: false, usageImportRequired: false, sources: saved }));
    api.start.mockResolvedValue(current);
    const panelRef = createRef<DataSyncPanelHandle>();
    renderPanel({ ref: panelRef });
    await screen.findByText("3 of 3 sources synced");
    let resolveStatus!: (value: DataSyncState) => void;
    api.getState.mockReturnValueOnce(new Promise<DataSyncState>(resolve => { resolveStatus = resolve; }));

    await userEvent.click(screen.getByRole("button", { name: "Sync users" }));
    expect(screen.getByText("Syncing users")).toBeVisible();
    expect(screen.getByText("17")).toBeVisible();
    expect(screen.getByText("processed in this stage")).toBeVisible();
    expect(within(screen.getByRole("article", { name: "Users" })).getByText("42")).toBeVisible();
    expect(within(screen.getByRole("article", { name: "Graph packages" })).getByText("1,005")).toBeVisible();
    expect(within(screen.getByRole("article", { name: "Power Platform" })).getByText("4,178")).toBeVisible();
    expect(screen.getByText("3 of 3 sources synced")).toBeVisible();
    expect(screen.getByRole("progressbar")).toHaveAttribute("max", "1");

    const completedUsers = source("users", "succeeded", { count: 43, lastSuccessAt: "2026-09-16T10:00:00.000Z" });
    const completed = syncState({
      onboardingRequired: false, usageImportRequired: false,
      run: run("completed", [completedUsers], { mode: "incremental" }),
      sources: saved.map(item => item.source === "users" ? completedUsers : item),
    });
    await act(async () => resolveStatus(completed));
    expect(screen.getByText("Sync complete")).toBeVisible();
    expect(screen.getByText("3 of 3 sources synced")).toBeVisible();
    expect(screen.queryByText(/1 of 1/)).not.toBeInTheDocument();
    expect(within(screen.getByRole("article", { name: "Users" })).getByText("43")).toBeVisible();
    expect(within(screen.getByRole("article", { name: "Graph packages" })).getByText("1,005")).toBeVisible();
    expect(screen.getByText("1,061 report rows across three accepted CSVs.")).toBeVisible();
    expect(api.start).toHaveBeenCalledExactlyOnceWith({ mode: "incremental", sources: ["users"] }, expect.anything());
  });

  it("checks status without collecting data and keeps importing separate from automatic readiness", async () => {
    const automatic = sourceIds.map(id => source(id, id === "usage_reports" ? "not_started" : "succeeded", { count: id === "usage_reports" ? null : 0 }));
    api.getState.mockResolvedValue(syncState({ onboardingRequired: false, sources: automatic }));
    const onOpenUsageImport = vi.fn();
    renderPanel({ onOpenUsageImport });
    await screen.findByText("3 of 3 sources synced");
    expect(screen.getByRole("button", { name: "Sync all sources" })).toBeEnabled();
    expect(screen.getByText("Import needed")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Check status" }));
    expect(api.getState).toHaveBeenCalledTimes(2);
    await userEvent.click(screen.getByRole("button", { name: "Add CSV reports" }));
    expect(onOpenUsageImport).toHaveBeenCalledOnce();
    expect(api.start).not.toHaveBeenCalled();
  });

  it("distinguishes successful unknown counts from never-synced sources and measured zeros", async () => {
    api.getState.mockResolvedValue(syncState({
      sources: [
        source("users", "succeeded", { count: 0 }),
        source("graph_packages", "succeeded"),
        source("power_platform", "not_started"),
        source("usage_reports", "not_started"),
      ],
    }));
    renderPanel();
    const users = within(await screen.findByRole("article", { name: "Users" }));
    const packages = within(screen.getByRole("article", { name: "Graph packages" }));
    expect(users.getByText("0")).toBeVisible();
    expect(packages.getByText("Not reported")).toBeVisible();
    expect(packages.getByText("Not recorded")).toBeVisible();
    expect(packages.queryByText("Not synced")).not.toBeInTheDocument();
    expect(within(screen.getByRole("article", { name: "Power Platform" })).getByText("Never")).toBeVisible();
  });

  it("invalidates fast completed observations without replacing saved counts if the status read fails", async () => {
    const saved = sourceIds.map(id => source(id, "succeeded", { count: 4, lastSuccessAt: "2026-09-15T10:00:00.000Z" }));
    const completedUsers = source("users", "succeeded", { count: 5, jobId: "new-users", lastSuccessAt: "2026-09-16T10:00:00.000Z" });
    api.getState.mockResolvedValueOnce(syncState({ onboardingRequired: false, sources: saved }))
      .mockRejectedValue(new Error("Status read failed."));
    api.start.mockResolvedValue(run("completed", [completedUsers]));
    const onSourcesChanged = vi.fn();
    const panelRef = createRef<DataSyncPanelHandle>();
    renderPanel({ onSourcesChanged, ref: panelRef });
    await userEvent.click(await screen.findByRole("button", { name: "Sync users" }));
    expect(onSourcesChanged).toHaveBeenCalledExactlyOnceWith(["users"]);
    expect(screen.getByRole("alert")).toHaveTextContent("Status read failed.");
    expect(within(screen.getByRole("article", { name: "Graph packages" })).getByText("4")).toBeVisible();

    api.getState.mockResolvedValue(syncState({
      onboardingRequired: false, sources: saved.map(item => item.source === "users" ? { ...completedUsers, jobId: null } : item),
    }));
    await act(async () => { await panelRef.current?.refresh(); });
    expect(onSourcesChanged).toHaveBeenCalledExactlyOnceWith(["users"]);
    expect(within(screen.getByRole("article", { name: "Users" })).getByText("5")).toBeVisible();
  });

  it("removes reset counts immediately after acceptance even when subsequent status is unavailable", async () => {
    const sources = sourceIds.map(id => source(id, "succeeded", { count: 44, lastSuccessAt: "2026-09-15T10:00:00.000Z" }));
    api.getState.mockResolvedValueOnce(syncState({ onboardingRequired: false, usageImportRequired: false, sources }))
      .mockRejectedValue(new Error("Status read failed."));
    api.start.mockResolvedValue(run("running", sourceIds.filter(id => id !== "usage_reports").map(id => source(id, "queued"))));
    const onSourcesChanged = vi.fn();
    renderPanel({ onSourcesChanged });
    await userEvent.click(await screen.findByRole("button", { name: "Reset saved data..." }));
    await userEvent.click(screen.getByRole("checkbox"));
    await userEvent.click(screen.getByRole("button", { name: "Clear and start full resync" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Status read failed.");
    expect(screen.getByText("0 of 3 sources synced")).toBeVisible();
    expect(within(screen.getByRole("article", { name: "Graph packages" })).queryByText("44")).not.toBeInTheDocument();
    expect(screen.getByText("44 report rows across three accepted CSVs.")).toBeVisible();
    expect(onSourcesChanged).toHaveBeenCalledExactlyOnceWith(["users", "graph_packages", "power_platform"]);
  });

  it("requires fresh confirmation to clear saved data and invalidates the cleared views", async () => {
    const sources = sourceIds.map(id => source(id, "succeeded", { count: 4 }));
    api.getState.mockResolvedValue(syncState({ onboardingRequired: false, usageImportRequired: false, sources }));
    api.start.mockResolvedValue(run("running", sourceIds.map(id => source(id, "queued")), { mode: "full" }));
    const onChanged = vi.fn();
    const view = renderPanel({ onSourcesChanged: onChanged });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Reset saved data..." }));
    expect(screen.getByText(/Accepted usage reports, report history, audit records/)).toBeVisible();
    const confirm = screen.getByRole("button", { name: "Clear and start full resync" });
    expect(confirm).toBeDisabled();
    await user.click(screen.getByRole("checkbox", { name: /I understand/ }));
    expect(confirm).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Keep saved data" }));
    expect(api.start).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Reset saved data..." }));
    expect(screen.getByRole("checkbox")).not.toBeChecked();
    await user.click(screen.getByRole("checkbox"));
    await act(async () => { view.rerenderPanel({ active: false }); });
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    view.rerenderPanel({ active: true });
    await user.click(screen.getByRole("button", { name: "Reset saved data..." }));
    expect(screen.getByRole("checkbox")).not.toBeChecked();
    await user.click(screen.getByRole("checkbox"));
    await user.click(screen.getByRole("button", { name: "Clear and start full resync" }));
    expect(api.start).toHaveBeenCalledExactlyOnceWith({ mode: "full", clearSavedData: true }, expect.anything());
    expect(onChanged).toHaveBeenCalledWith(["users", "graph_packages", "power_platform"]);
  });

  it("shows truthful progress and keeps polling and invalidating saved sources while inactive", async () => {
    vi.useFakeTimers();
    const sources = [
      source("users", "succeeded", { count: 0 }),
      source("graph_packages", "running", { message: "Reading package page 2." }),
      source("power_platform", "running"),
      source("usage_reports", "awaiting_upload"),
    ];
    const finished = sources.map(item => source(item.source, "succeeded", { count: 0 }));
    api.getState
      .mockResolvedValueOnce(syncState({ run: run("running", sources), sources }))
      .mockResolvedValue(syncState({
        onboardingRequired: false, usageImportRequired: false,
        run: run("completed", finished), sources: finished,
      }));
    const onChanged = vi.fn();
    const onSetupRequiredChange = vi.fn();
    const view = renderPanel({ onSourcesChanged: onChanged, onSetupRequiredChange });
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByText("Syncing graph packages, power platform")).toBeVisible();
    expect(screen.queryByText("Sync in progress")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Check progress" })).not.toBeInTheDocument();
    expect(screen.getByText("Reading package page 2.")).toBeVisible();
    expect(screen.getByRole("progressbar", { name: "Completed sync sources" })).toHaveAttribute("value", "1");
    expect(screen.getByRole("progressbar")).toHaveAttribute("max", "3");
    expect(screen.getByText(/1 of 3 automatic sources complete/)).toBeVisible();
    expect(screen.queryByText("Sync complete")).not.toBeInTheDocument();
    expect(onSetupRequiredChange).toHaveBeenLastCalledWith(true);
    await act(async () => { view.rerenderPanel({ active: false }); });
    expect(view.container).toBeEmptyDOMElement();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(api.getState).toHaveBeenCalledTimes(2);
    expect(api.start).not.toHaveBeenCalled();
    expect(api.cancel).not.toHaveBeenCalled();
    expect(onChanged).toHaveBeenCalledWith(["graph_packages", "power_platform", "usage_reports"]);
    expect(onSetupRequiredChange).toHaveBeenLastCalledWith(false);
    expect(view.container).toBeEmptyDOMElement();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await act(async () => { view.rerenderPanel({ active: true }); });
    expect(screen.getByText("Sync complete")).toBeVisible();
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "View run details" })).toBeVisible();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("does not reveal an inactive page when an in-flight start responds", async () => {
    let resolveStart!: (value: DataSyncRun) => void;
    api.getState.mockResolvedValue(syncState());
    api.start.mockReturnValue(new Promise(resolve => { resolveStart = resolve; }));
    const view = renderPanel();
    await userEvent.click(await screen.findByRole("button", { name: "Start initial sync" }));
    expect(screen.getByRole("button", { name: "Starting sync..." })).toBeDisabled();
    view.rerenderPanel({ active: false });
    await act(async () => resolveStart(run("running", sourceIds.map(id => source(id, "queued")))));
    expect(view.container).toBeEmptyDOMElement();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(api.start).toHaveBeenCalledOnce();
    await act(async () => { view.rerenderPanel({ active: true }); });
    expect(screen.getByRole("region", { name: "Data sync" })).toBeVisible();
    expect(api.start).toHaveBeenCalledOnce();
  });

  it("never opens a modal, locks body scrolling, steals focus, or traps page keyboard navigation", async () => {
    api.getState.mockResolvedValue(syncState());
    const originalOverflow = document.body.style.overflow;
    render(
      <>
        <button type="button">Before sync</button>
        <DataSyncPanel
          principalKey="tenant:user:viewer"
          canUploadUsage
          onOpenUsageImport={vi.fn()}
          onRequestedRunChange={vi.fn()}
          onSourcesChanged={vi.fn()}
        />
        <button type="button">After sync</button>
      </>,
    );
    const before = screen.getByRole("button", { name: "Before sync" });
    before.focus();
    await screen.findByRole("button", { name: "Start initial sync" });
    expect(before).toHaveFocus();
    expect(document.body.style.overflow).toBe(originalOverflow);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Close data sync|Continue in app|^Data sync/ })).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Data sync" }).querySelector("footer")).toBeNull();
    await userEvent.tab();
    expect(screen.getByRole("button", { name: "Start initial sync" })).toHaveFocus();
    screen.getByRole("button", { name: "Add CSV reports" }).focus();
    await userEvent.tab();
    expect(screen.getByRole("button", { name: "After sync" })).toHaveFocus();
    await userEvent.tab({ shift: true });
    expect(screen.getByRole("button", { name: "Add CSV reports" })).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    expect(screen.getByRole("region", { name: "Data sync" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Add CSV reports" })).toHaveFocus();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(document.body.style.overflow).toBe(originalOverflow);
    expect(api.cancel).not.toHaveBeenCalled();
    expect(api.start).not.toHaveBeenCalled();
  });

  it("invalidates formerly saved sources when a clean start response was lost", async () => {
    const sources = sourceIds.map(id => source(id, "succeeded", { count: 4 }));
    const cleared = sources.map(item => item.source === "usage_reports" ? item : source(item.source, "queued"));
    api.getState
      .mockResolvedValueOnce(syncState({ onboardingRequired: false, usageImportRequired: false, sources }))
      .mockResolvedValue(syncState({ run: run("running", cleared), sources: cleared, usageImportRequired: false }));
    api.start.mockRejectedValue(new Error("Response lost."));
    const onChanged = vi.fn();
    renderPanel({ onSourcesChanged: onChanged });
    await userEvent.click(await screen.findByRole("button", { name: "Reset saved data..." }));
    await userEvent.click(screen.getByRole("checkbox"));
    await userEvent.click(screen.getByRole("button", { name: "Clear and start full resync" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Response lost.");
    expect(onChanged).toHaveBeenCalledWith(["users", "graph_packages", "power_platform"]);
    expect(api.start).toHaveBeenCalledOnce();
  });

  it.each(["failed", "source-limited"] as const)(
    "invalidates cleared saved views after a lost clean-start response following a %s run",
    async previousRun => {
      const saved = sourceIds.map(id => source(id, "succeeded", {
        count: 0, lastSuccessAt: "2026-09-15T10:00:00.000Z",
      }));
      const failed = saved.map(item => item.source === "usage_reports"
        ? item
        : { ...item, status: "failed" as const, canRetry: true });
      const priorSources = previousRun === "source-limited"
        ? failed.filter(item => item.source === "users")
        : failed;
      const cleared = saved.map(item => item.source === "usage_reports" ? item : source(item.source, "queued"));
      api.getState
        .mockResolvedValueOnce(syncState({
          onboardingRequired: false, usageImportRequired: false,
          run: run("partial", priorSources, { id: "previous-run", mode: "incremental" }),
          sources: priorSources,
        }))
        .mockResolvedValue(syncState({
          usageImportRequired: false,
          run: run("running", cleared, { id: "clean-run", mode: "full" }),
          sources: cleared,
        }));
      api.start.mockRejectedValue(new Error("The clean-start response was lost."));
      const onChanged = vi.fn();
      const panelRef = createRef<DataSyncPanelHandle>();
      renderPanel({ ref: panelRef, onSourcesChanged: onChanged });

      await userEvent.click(await screen.findByRole("button", { name: "Reset saved data..." }));
      await userEvent.click(screen.getByRole("checkbox"));
      await userEvent.click(screen.getByRole("button", { name: "Clear and start full resync" }));

      expect(screen.getByRole("alert")).toHaveTextContent("The clean-start response was lost.");
      expect(onChanged).toHaveBeenCalledWith(expect.arrayContaining(["users", "graph_packages", "power_platform"]));
      expect(onChanged).toHaveBeenCalledOnce();
      expect(api.start).toHaveBeenCalledExactlyOnceWith({ mode: "full", clearSavedData: true }, expect.anything());

      onChanged.mockClear();
      await act(async () => { await panelRef.current?.refresh(); });
      expect(onChanged).not.toHaveBeenCalled();
    },
  );

  it("reports setup changes while inactive without exposing onboarding until navigation", async () => {
    const successful = sourceIds.map(id => source(id, "succeeded", { count: 0 }));
    api.getState.mockResolvedValueOnce(syncState({
      onboardingRequired: false,
      usageImportRequired: false,
      sources: successful,
    }));
    const panelRef = createRef<DataSyncPanelHandle>();
    const onSetupRequiredChange = vi.fn();
    const view = renderPanel({ ref: panelRef, active: false, onSetupRequiredChange });
    await act(async () => { await Promise.resolve(); });
    expect(onSetupRequiredChange).toHaveBeenLastCalledWith(false);
    expect(view.container).toBeEmptyDOMElement();

    api.getState.mockResolvedValue(syncState());
    await act(async () => {
      await panelRef.current?.refresh();
    });

    expect(onSetupRequiredChange).toHaveBeenLastCalledWith(true);
    expect(view.container).toBeEmptyDOMElement();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(api.start).not.toHaveBeenCalled();
    await act(async () => { view.rerenderPanel({ active: true }); });
    expect(screen.getByRole("heading", { name: "Workspace data" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Start initial sync" })).toBeVisible();
  });

  it("never presents an unfinished usage step as complete even if summary flags are inconsistent", async () => {
    const sources = sourceIds.map(id => source(id, id === "usage_reports" ? "awaiting_upload" : "succeeded", {
      count: id === "usage_reports" ? null : 0,
    }));
    api.getState.mockResolvedValue(syncState({
      onboardingRequired: false,
      usageImportRequired: false,
      run: run("partial", sources),
      sources,
    }));
    renderPanel();

    expect((await screen.findAllByText("Import needed")).length).toBeGreaterThan(0);
    expect(screen.getByText("3 of 3 sources synced")).toBeVisible();
    expect(within(screen.getByRole("region", { name: "CSV usage reports" })).queryByText("Available")).not.toBeInTheDocument();
  });

  it("polls repeated progress and ignores a stale response after principal or role ownership changes", async () => {
    vi.useFakeTimers();
    const runningSources = sourceIds.map(id => source(id, "running"));
    const completedSources = sourceIds.map(id => source(id, "succeeded", { count: 1 }));
    let resolveOld!: (value: DataSyncState) => void;
    api.getState
      .mockReturnValueOnce(new Promise(resolve => { resolveOld = resolve; }))
      .mockResolvedValueOnce(syncState({
        onboardingRequired: false,
        usageImportRequired: false,
        run: run("running", runningSources),
        sources: runningSources,
      }))
      .mockResolvedValueOnce(syncState({
        onboardingRequired: false,
        usageImportRequired: false,
        run: run("completed", completedSources),
        sources: completedSources,
      }));
    const onChanged = vi.fn();
    const view = renderPanel({ principalKey: "tenant:user:viewer", onSourcesChanged: onChanged });
    await act(async () => {
      view.rerender(
        <DataSyncPanel
          principalKey="tenant:user:admin"
          canUploadUsage
          onOpenUsageImport={vi.fn()}
          onRequestedRunChange={vi.fn()}
          onSourcesChanged={onChanged}
        />,
      );
    });
    await act(async () => resolveOld(syncState()));
    expect(screen.getByRole("heading", { name: "Workspace data" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Start initial sync" })).not.toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(api.getState).toHaveBeenCalledTimes(3);
    expect(onChanged).toHaveBeenCalledWith(sourceIds);
    expect(screen.getAllByText("3 of 3 sources synced")).not.toHaveLength(0);
  });

  it("notifies a new successful observation even when the source stayed succeeded", async () => {
    const completedAt = "2026-09-15T10:01:00.000Z";
    const initialSources = sourceIds.map(id => source(id, "succeeded", {
      jobId: `old-${id}`,
      lastSuccessAt: completedAt,
    }));
    const nextSources = initialSources.map(item => item.source === "users"
      ? source("users", "succeeded", {
          jobId: "new-users",
          lastSuccessAt: "2026-09-15T11:00:00.000Z",
        })
      : item);
    api.getState
      .mockResolvedValueOnce(syncState({
        onboardingRequired: false,
        usageImportRequired: false,
        run: run("completed", initialSources, { id: "old-run" }),
        sources: initialSources,
      }))
      .mockResolvedValue(syncState({
        onboardingRequired: false,
        usageImportRequired: false,
        run: run("completed", nextSources, { id: "new-run" }),
        sources: nextSources,
      }));
    const onChanged = vi.fn();
    const panelRef = createRef<DataSyncPanelHandle>();
    renderPanel({ ref: panelRef, onSourcesChanged: onChanged });
    await screen.findAllByText("3 of 3 sources synced");

    await act(async () => {
      await panelRef.current?.refresh();
    });
    await waitFor(() => expect(onChanged).toHaveBeenCalledWith(["users"]));
    await act(async () => {
      await panelRef.current?.refresh();
    });
    await waitFor(() => expect(api.getState).toHaveBeenCalledTimes(3));
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("reports a fast source completion before a later usage upload completes the run", async () => {
    vi.useFakeTimers();
    const firstSuccessAt = "2026-09-15T10:00:00.000Z";
    const initialSources = sourceIds.map(id => source(id, id === "usage_reports" ? "awaiting_upload" : "succeeded", {
      jobId: id === "usage_reports" ? null : `initial-${id}`,
      lastSuccessAt: id === "usage_reports" ? null : firstSuccessAt,
    }));
    const beforeUploadSources = initialSources.map(item => item.source === "users"
      ? source("users", "succeeded", {
          jobId: "completed-between-polls",
          lastSuccessAt: "2026-09-15T10:30:00.000Z",
        })
      : item);
    const finalSources = beforeUploadSources.map(item => item.source === "usage_reports"
      ? source("usage_reports", "succeeded", {
          jobId: "accepted-upload",
          lastSuccessAt: "2026-09-15T10:31:00.000Z",
        })
      : item);
    api.getState
      .mockResolvedValueOnce(syncState({
        run: run("waiting", initialSources),
        sources: initialSources,
      }))
      .mockResolvedValueOnce(syncState({
        run: run("waiting", beforeUploadSources),
        sources: beforeUploadSources,
      }))
      .mockResolvedValueOnce(syncState({
        onboardingRequired: false,
        usageImportRequired: false,
        run: run("completed", finalSources),
        sources: finalSources,
      }));
    const onChanged = vi.fn();
    renderPanel({ onSourcesChanged: onChanged });
    await act(async () => {
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(onChanged).toHaveBeenNthCalledWith(1, ["users"]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(onChanged).toHaveBeenNthCalledWith(2, ["usage_reports"]);
    expect(onChanged).toHaveBeenCalledTimes(2);
  });

  it("keeps polling after a lost start response without replaying the POST", async () => {
    const initial = syncState();
    const runningSources = sourceIds.map(id => source(id, "running", { jobId: "admitted-run" }));
    const completedSources = sourceIds.map(id => source(id, "succeeded", {
      jobId: "admitted-run",
      lastSuccessAt: "2026-09-15T11:00:00.000Z",
    }));
    api.getState
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(syncState({
        run: run("running", runningSources, { id: "admitted-run" }),
        sources: runningSources,
      }))
      .mockResolvedValueOnce(syncState({
        onboardingRequired: false,
        usageImportRequired: false,
        run: run("completed", completedSources, { id: "admitted-run" }),
        sources: completedSources,
      }));
    api.start.mockRejectedValue(new Error("The start response was lost."));
    const onChanged = vi.fn();
    renderPanel({ onSourcesChanged: onChanged });
    await screen.findByRole("button", { name: "Start initial sync" });
    vi.useFakeTimers();

    await act(async () => {
      screen.getByRole("button", { name: "Start initial sync" }).click();
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(screen.getByRole("alert")).toHaveTextContent("The start response was lost.");
    expect(api.start).toHaveBeenCalledOnce();
    expect(api.getState).toHaveBeenCalledTimes(2);
    expect(screen.getAllByText("Syncing").length).toBeGreaterThan(0);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(api.start).toHaveBeenCalledOnce();
    expect(api.getState).toHaveBeenCalledTimes(3);
    expect(onChanged).toHaveBeenCalledWith(sourceIds);
    expect(screen.getByRole("alert")).toHaveTextContent("The start response was lost.");
  });

  it("never joins post-command state revalidation to a GET admitted before the command", async () => {
    const sources = [source("users", "running")];
    const active = syncState({ run: run("running", sources), sources });
    const cancelled = syncState({ run: run("cancelled", sources), sources });
    let resolveOld!: (value: DataSyncState) => void;
    api.getState
      .mockResolvedValueOnce(active)
      .mockReturnValueOnce(new Promise(resolve => { resolveOld = resolve; }))
      .mockResolvedValue(cancelled);
    api.cancel.mockResolvedValue(run("cancelled", sources));
    const panelRef = createRef<DataSyncPanelHandle>();
    renderPanel({ ref: panelRef });
    await screen.findByRole("button", { name: "Cancel run" });
    await act(async () => { await panelRef.current?.refresh(); });
    await waitFor(() => expect(api.getState).toHaveBeenCalledTimes(2));
    const staleSignal = api.getState.mock.calls[1][0].signal as AbortSignal;

    await userEvent.click(screen.getByRole("button", { name: "Cancel run" }));

    await waitFor(() => expect(api.getState).toHaveBeenCalledTimes(3));
    expect(staleSignal.aborted).toBe(true);
    expect(screen.getByText("Sync cancelled")).toBeVisible();
    await act(async () => resolveOld(active));
    expect(screen.getByText("Sync cancelled")).toBeVisible();
    expect(api.cancel).toHaveBeenCalledOnce();
  });

  it("loads and displays an exact requested run without falling back to the latest state run", async () => {
    const completedSources = sourceIds.map(id => source(id, "succeeded", { count: 3 }));
    api.getState.mockResolvedValue(syncState({
      onboardingRequired: false,
      usageImportRequired: false,
      run: run("completed", completedSources, { id: "latest-run" }),
      sources: completedSources,
    }));
    api.getRun.mockResolvedValue(run("partial", [
      source("users", "succeeded", { count: 2 }),
      source("graph_packages", "failed", { canRetry: true }),
    ], { id: "retained-run" }));
    const onRequestedRunChange = vi.fn();
    const view = renderPanel({ requestedRunId: "retained-run", onRequestedRunChange });

    expect(await screen.findByText("retained-run", { selector: "code" })).toBeVisible();
    expect(api.getRun).toHaveBeenCalledWith("retained-run", expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(screen.queryByText("latest-run", { selector: "code" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Back to workspace" }));
    expect(onRequestedRunChange).toHaveBeenCalledWith(undefined);

    view.rerender(
      <DataSyncPanel
        principalKey="tenant:user:viewer"
        canUploadUsage
        onOpenUsageImport={vi.fn()}
        onRequestedRunChange={onRequestedRunChange}
        onSourcesChanged={vi.fn()}
      />,
    );
    expect(screen.queryByText("latest-run", { selector: "code" })).not.toBeInTheDocument();
    expect(within(screen.getByRole("article", { name: "Users" })).getByText("3")).toBeVisible();
    await userEvent.click(screen.getByText("View run details"));
    expect(onRequestedRunChange).toHaveBeenLastCalledWith("latest-run");
  });

  it("shows an exact-run error instead of silently substituting the latest run", async () => {
    const completedSources = sourceIds.map(id => source(id, "succeeded", { count: 3 }));
    api.getState.mockResolvedValue(syncState({
      onboardingRequired: false,
      usageImportRequired: false,
      run: run("completed", completedSources, { id: "latest-run" }),
      sources: completedSources,
    }));
    api.getRun.mockRejectedValue(new Error("not found"));
    renderPanel({ requestedRunId: "missing-run" });

    expect(await screen.findByRole("alert")).toHaveTextContent("not found");
    expect(screen.queryByText("latest-run", { selector: "code" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Back to workspace" })).toBeVisible();
  });

  it("polls the exact requested run and reports newly completed sources", async () => {
    vi.useFakeTimers();
    const waitingSources = [
      source("users", "succeeded", { count: 2 }),
      source("graph_packages", "failed", { canRetry: true }),
    ];
    const completedSources = waitingSources.map(item => source(item.source, "succeeded", { count: 2 }));
    api.getState.mockResolvedValue(syncState({ onboardingRequired: false, usageImportRequired: false }));
    api.getRun
      .mockResolvedValueOnce(run("running", waitingSources, { id: "exact-run" }))
      .mockResolvedValueOnce(run("completed", completedSources, { id: "exact-run" }));
    const onChanged = vi.fn();
    renderPanel({ requestedRunId: "exact-run", onSourcesChanged: onChanged });

    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByText("exact-run", { selector: "code" })).toBeVisible();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(api.getRun).toHaveBeenCalledTimes(2);
    expect(onChanged).toHaveBeenCalledWith(["graph_packages"]);
  });

  it("continues polling the exact requested run while inactive without showing or substituting another run", async () => {
    vi.useFakeTimers();
    const runningSources = [source("users", "running")];
    const completedSources = [source("users", "succeeded", { count: 0 })];
    api.getState.mockResolvedValue(syncState({
      onboardingRequired: false,
      usageImportRequired: false,
      run: run("completed", completedSources, { id: "latest-run" }),
      sources: completedSources,
    }));
    api.getRun
      .mockResolvedValueOnce(run("running", runningSources, { id: "exact-run" }))
      .mockResolvedValue(run("completed", completedSources, { id: "exact-run" }));
    const onChanged = vi.fn();
    const view = renderPanel({ active: false, requestedRunId: "exact-run", onSourcesChanged: onChanged });

    await act(async () => { await Promise.resolve(); });
    expect(view.container).toBeEmptyDOMElement();
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(api.getRun).toHaveBeenCalledTimes(2);
    expect(onChanged).toHaveBeenCalledExactlyOnceWith(["users"]);
    expect(view.container).toBeEmptyDOMElement();
    await act(async () => { view.rerenderPanel({ active: true }); });
    expect(within(screen.getByRole("dialog", { name: "Sync run details" })).getByText("Sync complete")).toBeVisible();
    expect(screen.queryByText("latest-run", { selector: "code" })).not.toBeInTheDocument();
    expect(screen.getByText("exact-run", { selector: "code" })).toBeVisible();
    expect(api.start).not.toHaveBeenCalled();
    expect(api.cancel).not.toHaveBeenCalled();
  });

  it("retries and cancels the exact requested run rather than the latest run", async () => {
    const waitingSources = [
      source("users", "succeeded", { count: 2 }),
      source("graph_packages", "failed", { canRetry: true }),
    ];
    const exactRun = run("waiting", waitingSources, { id: "exact-run" });
    api.getState.mockResolvedValue(syncState({
      onboardingRequired: false,
      usageImportRequired: false,
      run: run("completed", [source("users", "succeeded")], { id: "latest-run" }),
    }));
    api.getRun.mockResolvedValue(exactRun);
    api.retry.mockResolvedValue(exactRun);
    api.cancel.mockResolvedValue(run("cancelled", waitingSources, { id: "exact-run" }));
    renderPanel({ requestedRunId: "exact-run" });

    await userEvent.click(await screen.findByRole("button", { name: "Retry incomplete (1)" }));
    expect(api.retry).toHaveBeenCalledWith(
      "exact-run",
      ["graph_packages"],
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Cancel run" }));
    expect(api.cancel).toHaveBeenCalledWith("exact-run", expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it("drops an exact-run response owned by an old route and principal", async () => {
    let resolveOld!: (value: DataSyncRun) => void;
    api.getState.mockResolvedValue(syncState({ onboardingRequired: false, usageImportRequired: false }));
    api.getRun
      .mockReturnValueOnce(new Promise(resolve => { resolveOld = resolve; }))
      .mockResolvedValueOnce(run("completed", [source("users", "succeeded")], { id: "new-run" }));
    const view = renderPanel({ principalKey: "tenant:old:viewer", requestedRunId: "old-run" });
    view.rerender(
      <DataSyncPanel
        principalKey="tenant:new:viewer"
        canUploadUsage
        requestedRunId="new-run"
        onOpenUsageImport={vi.fn()}
        onRequestedRunChange={vi.fn()}
        onSourcesChanged={vi.fn()}
      />,
    );

    expect(await screen.findByText("new-run", { selector: "code" })).toBeVisible();
    await act(async () => resolveOld(run("completed", [source("users", "succeeded")], { id: "old-run" })));
    expect(screen.queryByText("old-run", { selector: "code" })).not.toBeInTheDocument();
  });

  it("stops at the foreground polling budget and requires an explicit resume", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const runningSources = sourceIds.map(id => source(id, "running"));
    api.getState.mockResolvedValue(syncState({
      onboardingRequired: false,
      usageImportRequired: false,
      run: run("running", runningSources),
      sources: runningSources,
    }));
    const consoleErrors = vi.spyOn(console, "error");
    const view = renderPanel();
    try {
      await act(async () => { await Promise.resolve(); });
      vi.setSystemTime(301_001);
      await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
      const resume = screen.getByRole("button", { name: "Resume updates" });
      expect(api.getState).toHaveBeenCalledTimes(2);
      await act(async () => { resume.click(); });
      expect(api.getState).toHaveBeenCalledTimes(3);
      expect(consoleErrors.mock.calls.filter(([message]) => typeof message === "string" && message.includes("act("))).toEqual([]);
    } finally {
      view.unmount();
      consoleErrors.mockRestore();
    }
  });

  it("aborts hidden state and exact-run requests on unmount and ignores their late responses", async () => {
    vi.useFakeTimers();
    let resolveState!: (value: DataSyncState) => void;
    let resolveRun!: (value: DataSyncRun) => void;
    api.getState.mockReturnValue(new Promise(resolve => { resolveState = resolve; }));
    api.getRun.mockReturnValue(new Promise(resolve => { resolveRun = resolve; }));
    const onChanged = vi.fn();
    const onSetupRequiredChange = vi.fn();
    const view = renderPanel({
      active: false, requestedRunId: "exact-run", onSourcesChanged: onChanged, onSetupRequiredChange,
    });
    await act(async () => { await Promise.resolve(); });
    const stateSignal = api.getState.mock.calls[0][0].signal as AbortSignal;
    const runSignal = api.getRun.mock.calls[0][1].signal as AbortSignal;
    expect(stateSignal.aborted).toBe(false);
    expect(runSignal.aborted).toBe(false);
    view.unmount();
    expect(stateSignal.aborted).toBe(true);
    expect(runSignal.aborted).toBe(true);
    const setupNotifications = onSetupRequiredChange.mock.calls.length;
    await act(async () => {
      resolveState(syncState());
      resolveRun(run("running", [source("users", "running")], { id: "exact-run" }));
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(api.getState).toHaveBeenCalledOnce();
    expect(api.getRun).toHaveBeenCalledOnce();
    expect(onChanged).not.toHaveBeenCalled();
    expect(onSetupRequiredChange).toHaveBeenCalledTimes(setupNotifications);
    expect(api.cancel).not.toHaveBeenCalled();
  });

  it("cleans up background polling timers without cancelling the server-owned run on unmount", async () => {
    vi.useFakeTimers();
    const sources = sourceIds.map(id => source(id, "running"));
    api.getState.mockResolvedValue(syncState({ run: run("running", sources), sources }));
    const view = renderPanel({ active: false });
    await act(async () => { await Promise.resolve(); });
    expect(api.getState).toHaveBeenCalledOnce();
    view.unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(api.getState).toHaveBeenCalledOnce();
    expect(api.cancel).not.toHaveBeenCalled();
  });

  it.each(["refresh", "principal"] as const)(
    "keeps a replacement polling budget when a superseded request settles after %s",
    async replacement => {
      vi.useFakeTimers();
      const sources = [source("users", "running")];
      const running = syncState({ run: run("running", sources), sources });
      let resolveOld!: (value: DataSyncState) => void;
      let resolveCurrent!: (value: DataSyncState) => void;
      api.getState
        .mockResolvedValueOnce(running)
        .mockReturnValueOnce(new Promise(resolve => { resolveOld = resolve; }))
        .mockReturnValueOnce(new Promise(resolve => { resolveCurrent = resolve; }))
        .mockResolvedValue(running);
      const panelRef = createRef<DataSyncPanelHandle>();
      const view = renderPanel({ ref: panelRef });
      await act(async () => { await Promise.resolve(); });
      await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
      const oldSignal = api.getState.mock.calls[1][0].signal as AbortSignal;

      await act(async () => {
        if (replacement === "refresh") await panelRef.current?.refresh();
        else view.rerenderPanel({ principalKey: "tenant:other:viewer" });
      });
      expect(oldSignal.aborted).toBe(true);
      await act(async () => resolveOld(running));
      await act(async () => resolveCurrent(running));

      expect(screen.queryByRole("button", { name: "Resume updates" })).not.toBeInTheDocument();
      await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
      expect(api.getState).toHaveBeenCalledTimes(4);
      expect(screen.getByText("Syncing users")).toBeVisible();
    },
  );

  it("keeps only the replacement poll when a source notification refreshes status synchronously", async () => {
    vi.useFakeTimers();
    const initialSources = [source("users", "running"), source("usage_reports", "awaiting_upload")];
    const changedSources = [source("users", "running"), source("usage_reports", "succeeded")];
    const running = syncState({ run: run("running", changedSources), sources: changedSources });
    let resolveRefresh!: (value: DataSyncState) => void;
    api.getState
      .mockResolvedValueOnce(syncState({ run: run("running", initialSources), sources: initialSources }))
      .mockResolvedValueOnce(running)
      .mockReturnValueOnce(new Promise(resolve => { resolveRefresh = resolve; }))
      .mockResolvedValue(running);
    const panelRef = createRef<DataSyncPanelHandle>();
    const onChanged = vi.fn(() => { void panelRef.current?.refresh(); });
    renderPanel({ ref: panelRef, onSourcesChanged: onChanged });
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(api.getState).toHaveBeenCalledTimes(3);
    expect(onChanged).toHaveBeenCalledExactlyOnceWith(["usage_reports"]);

    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    await act(async () => resolveRefresh(running));
    expect(screen.queryByRole("button", { name: "Resume updates" })).not.toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(api.getState).toHaveBeenCalledTimes(4);
    expect(onChanged).toHaveBeenCalledOnce();
  });

  it("preserves exact-run observation history across refreshes but not across run or principal changes", async () => {
    const panelRef = createRef<DataSyncPanelHandle>();
    const onChanged = vi.fn();
    api.getState.mockResolvedValue(syncState());
    api.getRun.mockResolvedValueOnce(run("waiting", [source("users", "failed", { canRetry: true })], {
      id: "exact-run",
    }));
    const view = renderPanel({ requestedRunId: "exact-run", ref: panelRef, onSourcesChanged: onChanged });
    await screen.findByText("exact-run", { selector: "code" });
    api.getRun.mockResolvedValue(run("completed", [source("users", "succeeded", {
      jobId: "new-users",
      lastSuccessAt: "2026-09-15T11:00:00.000Z",
    })], { id: "exact-run" }));

    await act(async () => { await panelRef.current?.refresh(); });
    expect(onChanged).toHaveBeenCalledExactlyOnceWith(["users"]);
    await act(async () => { await panelRef.current?.refresh(); });
    expect(onChanged).toHaveBeenCalledOnce();

    api.getRun.mockResolvedValue(run("completed", [source("users", "succeeded", {
      jobId: "historical-users",
      lastSuccessAt: "2026-09-14T11:00:00.000Z",
    })], { id: "historical-run" }));
    await act(async () => { view.rerenderPanel({ requestedRunId: "historical-run" }); });
    expect(onChanged).toHaveBeenCalledOnce();
    api.getRun.mockResolvedValue(run("completed", [source("users", "succeeded", {
      jobId: "other-principal-users",
    })], { id: "historical-run" }));
    await act(async () => { view.rerenderPanel({ principalKey: "tenant:other:viewer" }); });
    expect(onChanged).toHaveBeenCalledOnce();
  });

  it("invalidates current saved sources while a different historical run is displayed", async () => {
    vi.useFakeTimers();
    const runningSources = [source("users", "running")];
    const completedSources = [source("users", "succeeded", { count: 5 })];
    api.getState
      .mockResolvedValueOnce(syncState({ run: run("running", runningSources), sources: runningSources }))
      .mockResolvedValue(syncState({
        run: run("completed", completedSources), sources: completedSources,
        onboardingRequired: false, usageImportRequired: false,
      }));
    api.getRun.mockResolvedValue(run("completed", [source("users", "succeeded", { count: 2 })], {
      id: "historical-run",
    }));
    const onChanged = vi.fn();
    renderPanel({ requestedRunId: "historical-run", onSourcesChanged: onChanged });
    await act(async () => { await Promise.resolve(); });
    expect(onChanged).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(onChanged).toHaveBeenCalledExactlyOnceWith(["users"]);
    expect(screen.getByText("historical-run", { selector: "code" })).toBeInTheDocument();
    expect(screen.queryByText("sync-run-1", { selector: "code" })).not.toBeInTheDocument();
  });

  it.each(["accepted", "lost"] as const)(
    "notifies a fast exact-run retry completion after an %s response without replaying the retry",
    async response => {
      const failed = run("partial", [source("users", "failed", { canRetry: true })], { id: "exact-run" });
      const completed = run("completed", [source("users", "succeeded", {
        count: 0, jobId: "retry-users", lastSuccessAt: "2026-09-15T11:00:00.000Z",
      })], { id: "exact-run" });
      api.getState.mockResolvedValue(syncState());
      api.getRun.mockResolvedValueOnce(failed);
      if (response === "accepted") {
        api.retry.mockResolvedValue(completed);
        api.getRun.mockRejectedValue(new Error("Status read failed after retry."));
      } else {
        api.retry.mockRejectedValue(new Error("Retry response lost."));
        api.getRun.mockResolvedValue(completed);
      }
      const onChanged = vi.fn();
      renderPanel({ requestedRunId: "exact-run", onSourcesChanged: onChanged });
      await userEvent.click(await screen.findByRole("button", { name: "Retry incomplete (1)" }));

      await waitFor(() => {
        expect(onChanged).toHaveBeenCalledExactlyOnceWith(["users"]);
        expect(screen.getByRole("alert")).toHaveTextContent(
          response === "accepted" ? "Status read failed after retry." : "Retry response lost.",
        );
      });
      expect(api.retry).toHaveBeenCalledExactlyOnceWith("exact-run", ["users"], expect.anything());
      expect(api.start).not.toHaveBeenCalled();
    },
  );

  it("detects cleared saved sources after a lost clean-start response from historical details", async () => {
    const sources = sourceIds.map(id => source(id, "succeeded", {
      count: 4, lastSuccessAt: "2026-09-15T10:00:00.000Z",
    }));
    const cleared = sources.map(item => item.source === "usage_reports" ? item : source(item.source, "queued"));
    api.getState
      .mockResolvedValueOnce(syncState({ onboardingRequired: false, usageImportRequired: false, sources }))
      .mockResolvedValue(syncState({ run: run("running", cleared), sources: cleared, usageImportRequired: false }));
    api.getRun.mockResolvedValue(run("completed", sources, { id: "historical-run" }));
    api.start.mockRejectedValue(new Error("Response lost."));
    const onChanged = vi.fn();
    const onRequestedRunChange = vi.fn();
    const view = renderPanel({
      requestedRunId: "historical-run", onSourcesChanged: onChanged, onRequestedRunChange,
    });
    onRequestedRunChange.mockImplementation((requestedRunId: string | undefined) => {
      view.rerenderPanel({ requestedRunId });
    });
    await userEvent.click(await screen.findByRole("button", { name: "Back to workspace" }));
    await userEvent.click(screen.getByRole("button", { name: "Reset saved data..." }));
    await userEvent.click(screen.getByRole("checkbox"));
    await userEvent.click(screen.getByRole("button", { name: "Clear and start full resync" }));

    expect(screen.getByRole("alert")).toHaveTextContent("Response lost.");
    expect(onRequestedRunChange).toHaveBeenCalledExactlyOnceWith(undefined);
    expect(onChanged).toHaveBeenCalledExactlyOnceWith(["users", "graph_packages", "power_platform"]);
    expect(api.start).toHaveBeenCalledExactlyOnceWith({ mode: "full", clearSavedData: true }, expect.anything());
  });

  it.each(["accepted", "lost"] as const)(
    "recovers status after the %s start response even when the selected run changes",
    async response => {
      vi.useFakeTimers();
      const runningSources = [source("users", "running")];
      const completedSources = [source("users", "succeeded", { count: 5 })];
      let resolveStart!: (value: DataSyncRun) => void;
      let rejectStart!: (reason: Error) => void;
      api.start.mockReturnValue(new Promise((resolve, reject) => {
        resolveStart = resolve;
        rejectStart = reject;
      }));
      api.getState
        .mockResolvedValueOnce(syncState())
        .mockResolvedValueOnce(syncState({ run: run("running", runningSources), sources: runningSources }))
        .mockResolvedValue(syncState({
          run: run("completed", completedSources), sources: completedSources,
          onboardingRequired: false, usageImportRequired: false,
        }));
      api.getRun.mockResolvedValue(run("completed", [source("users", "succeeded", { count: 2 })], {
        id: "historical-run",
      }));
      const onChanged = vi.fn();
      const onRequestedRunChange = vi.fn();
      const view = renderPanel({ onSourcesChanged: onChanged, onRequestedRunChange });
      await act(async () => { await Promise.resolve(); });
      await act(async () => { screen.getByRole("button", { name: "Start initial sync" }).click(); });
      await act(async () => { view.rerenderPanel({ requestedRunId: "historical-run" }); });
      await act(async () => {
        if (response === "accepted") resolveStart(run("running", runningSources));
        else rejectStart(new Error("The start response was lost."));
      });

      expect(api.getState).toHaveBeenCalledTimes(2);
      expect(screen.getByText("historical-run", { selector: "code" })).toBeInTheDocument();
      expect(screen.queryByText("sync-run-1", { selector: "code" })).not.toBeInTheDocument();
      if (response === "lost") expect(screen.getByRole("alert")).toHaveTextContent("The start response was lost.");
      await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
      expect(api.getState).toHaveBeenCalledTimes(3);
      expect(onChanged).toHaveBeenCalledWith(["users"]);
      expect(api.start).toHaveBeenCalledOnce();
      await act(async () => { view.rerenderPanel({ requestedRunId: undefined }); });
      expect(within(screen.getByRole("article", { name: "Users" })).getByText("5")).toBeVisible();
      await act(async () => { screen.getByRole("button", { name: "View run details" }).click(); });
      expect(onRequestedRunChange).toHaveBeenLastCalledWith("sync-run-1");
    },
  );

  it("aborts an in-flight start on unmount without replaying it or invalidating the next session", async () => {
    let resolveStart!: (value: DataSyncRun) => void;
    api.getState.mockResolvedValue(syncState());
    api.start.mockReturnValue(new Promise(resolve => { resolveStart = resolve; }));
    const onChanged = vi.fn();
    const view = renderPanel({ onSourcesChanged: onChanged });
    await userEvent.click(await screen.findByRole("button", { name: "Start initial sync" }));
    const actionSignal = api.start.mock.calls[0][1].signal as AbortSignal;
    expect(actionSignal.aborted).toBe(false);
    view.unmount();
    expect(actionSignal.aborted).toBe(true);
    await act(async () => resolveStart(run("completed", sourceIds.map(id => source(id, "succeeded")))));
    expect(api.start).toHaveBeenCalledOnce();
    expect(api.getState).toHaveBeenCalledOnce();
    expect(onChanged).not.toHaveBeenCalled();
    expect(api.cancel).not.toHaveBeenCalled();
  });

  it.each(["accepted", "lost"] as const)(
    "tracks a historical retry as latest activity after selection changes with an %s response",
    async response => {
      vi.useFakeTimers();
      const priorSource = source("users", "failed", {
        canRetry: true, count: 4, lastSuccessAt: "2026-09-15T10:00:00.000Z",
      });
      const older = run("partial", [priorSource], { id: "older-run", mode: "incremental" });
      const newerSources = [source("users", "succeeded", {
        count: 5, jobId: "newer-users", lastSuccessAt: "2026-09-15T11:00:00.000Z",
      })];
      const newer = run("completed", newerSources, { id: "newer-run", mode: "incremental" });
      const retrySources = [{ ...priorSource, status: "running" as const, jobId: "retry-users", canRetry: false }];
      const retried = run("running", retrySources, { id: older.id, mode: "incremental" });
      const completedSources = [source("users", "succeeded", {
        count: 6, jobId: "retry-users", lastSuccessAt: "2026-09-15T12:00:00.000Z",
      })];
      api.getState
        .mockResolvedValueOnce(syncState({ run: newer, sources: newerSources }))
        .mockResolvedValueOnce(syncState({ run: retried, sources: retrySources }))
        .mockResolvedValue(syncState({
          run: run("completed", completedSources, { id: older.id, mode: "incremental" }),
          sources: completedSources,
        }));
      api.getRun.mockResolvedValueOnce(older).mockResolvedValue(newer);
      let resolveRetry!: (value: DataSyncRun) => void;
      let rejectRetry!: (reason: Error) => void;
      api.retry.mockReturnValue(new Promise((resolve, reject) => {
        resolveRetry = resolve;
        rejectRetry = reject;
      }));
      const onChanged = vi.fn();
      const onRequestedRunChange = vi.fn();
      const view = renderPanel({ requestedRunId: older.id, onSourcesChanged: onChanged, onRequestedRunChange });
      await act(async () => { await Promise.resolve(); });
      await act(async () => { screen.getByRole("button", { name: "Retry incomplete (1)" }).click(); });
      await act(async () => { view.rerenderPanel({ requestedRunId: newer.id }); });
      await act(async () => {
        if (response === "accepted") resolveRetry(retried);
        else rejectRetry(new Error("The retry response was lost."));
      });

      expect(api.getState).toHaveBeenCalledTimes(2);
      expect(screen.getByText(newer.id, { selector: "code" })).toBeInTheDocument();
      expect(screen.queryByText(older.id, { selector: "code" })).not.toBeInTheDocument();
      expect(onChanged).not.toHaveBeenCalled();
      await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
      expect(onChanged).toHaveBeenCalledExactlyOnceWith(["users"]);
      expect(api.retry).toHaveBeenCalledExactlyOnceWith(older.id, ["users"], expect.anything());
      if (response === "lost") expect(screen.getByRole("alert")).toHaveTextContent("The retry response was lost.");

      await act(async () => { view.rerenderPanel({ requestedRunId: undefined }); });
      await act(async () => { screen.getByRole("button", { name: "View run details" }).click(); });
      expect(onRequestedRunChange).toHaveBeenLastCalledWith(older.id);
      expect(screen.queryByText(newer.id, { selector: "code" })).not.toBeInTheDocument();
    },
  );
});
