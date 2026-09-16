import { createRef } from "react";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
import { DataSyncPanel } from "./DataSyncPanel";

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
  const view = render(<DataSyncPanel {...props} />);
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

    expect(await screen.findByRole("region", { name: "Data sync" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Data sync", level: 2 })).toBeVisible();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Data sync/i })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Set up your saved data" })).toBeVisible();
    expect(screen.getByText(/Agents, Users & agents, and Users/)).toBeVisible();
    expect(screen.getByText(/7- or 30-day selection/)).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Upload three CSVs" }));
    expect(onUpload).toHaveBeenCalledOnce();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Data sync" })).toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: "Start initial sync" }));
    expect(api.start).toHaveBeenCalledWith({ mode: "initial" }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledWith(sourceIds));
    expect(screen.getAllByText("Setup complete")).not.toHaveLength(0);
    await userEvent.click(screen.getByText("View sync details"));
    const users = screen.getByText("Users", { selector: "strong" }).closest("article");
    expect(users).not.toBeNull();
    expect(within(users!).getByText("0")).toBeVisible();
  });

  it("lets viewers run read syncs but reserves report upload for admins without blocking the workbench", async () => {
    api.getState.mockResolvedValue(syncState());
    renderPanel({ canUploadUsage: false });

    await screen.findByRole("heading", { name: "Set up your saved data" });
    expect(screen.getByRole("button", { name: "Start initial sync" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Upload three CSVs" })).not.toBeInTheDocument();
    expect(screen.getAllByText(/Ask an AgentControl.Admin|Uploads require AgentControl.Admin/).length).toBeGreaterThan(0);
    expect(screen.getByText(/Other authorized pages remain available/)).toBeVisible();
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
    await screen.findByText(/Keep existing data available/);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(api.start).not.toHaveBeenCalled();

    expect(screen.getByText(/Keep existing data available/)).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Refresh saved data" }));
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
    expect(screen.queryByRole("button", { name: "Start initial sync" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Refresh saved data" })).not.toBeInTheDocument();
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

  it("shows one completed summary and keeps secondary details collapsed until requested", async () => {
    const sources = sourceIds.map(id => source(id, "succeeded", { count: 42 }));
    const completed = syncState({
      onboardingRequired: false, usageImportRequired: false,
      run: run("completed", sources), sources,
    });
    api.getState.mockResolvedValue(completed);
    renderPanel();
    await screen.findByText("Sync complete");

    const page = within(screen.getByRole("region", { name: "Data sync" }));
    expect(page.getAllByText("Sync complete")).toHaveLength(1);
    expect(page.getByText("4 of 4 sources complete")).toBeVisible();
    expect(page.queryByRole("progressbar")).not.toBeInTheDocument();
    expect(page.queryByText("Keep your saved data up to date")).not.toBeInTheDocument();
    expect(page.queryByRole("button", { name: "Check progress" })).not.toBeInTheDocument();
    expect(page.queryByText(/Closing this window does not cancel sync/)).not.toBeInTheDocument();
    expect(page.getAllByText("Refresh saved data")).toHaveLength(1);
    expect(page.getByText("sync-run-1", { selector: "code" })).not.toBeVisible();
    expect(page.getByText("What does sync include?")).not.toBeVisible();
    expect(page.getByRole("button", { name: "Clear saved data and resync" })).not.toBeVisible();
    expect(api.start).not.toHaveBeenCalled();

    await userEvent.click(page.getByText("View sync details"));
    expect(page.getByText("sync-run-1", { selector: "code" })).toBeVisible();
    expect(page.getByRole("button", { name: "Manage uploads" })).toBeVisible();
    expect(page.getByRole("button", { name: "Clear saved data and resync" })).toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "What does sync include?" }));
    expect(page.getByRole("region", { name: "Sync scope" })).toBeVisible();

    const runningSources = sourceIds.map(id => source(id, "running"));
    const nextRun = run("running", runningSources, { mode: "incremental", id: "new-run" });
    api.start.mockResolvedValue(nextRun);
    api.getState.mockResolvedValue({ ...completed, run: nextRun, sources: runningSources });
    await userEvent.click(page.getByRole("button", { name: "Refresh saved data" }));
    expect(api.start).toHaveBeenCalledWith({ mode: "incremental" }, expect.anything());
    expect(page.getByRole("progressbar")).toBeVisible();
    expect(page.getByRole("article", { name: "Users" })).toBeVisible();
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

  it("keeps current upload requirements visible when viewing a completed historical run", async () => {
    api.getState.mockResolvedValue(syncState());
    api.getRun.mockResolvedValue(run("completed", sourceIds.map(id => source(id, "succeeded")), { id: "historical-run" }));
    renderPanel({ requestedRunId: "historical-run" });
    expect(await screen.findByText("Sync complete")).toBeVisible();
    expect(screen.getByText("historical-run", { selector: "code" })).not.toBeVisible();
    expect(screen.getByText("Three official usage CSVs are still required.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Upload three CSVs" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Start initial sync" })).not.toBeInTheDocument();
  });

  it("does not label a failed attempt's reported records as saved data", async () => {
    const sources = [
      source("users", "succeeded", { count: 3_951 }),
      source("graph_packages", "succeeded", { count: 1_005 }),
      source("power_platform", "failed", { count: 4_173, canRetry: true, message: "The prior snapshot was preserved." }),
      source("usage_reports", "succeeded", { count: 1_061 }),
    ];
    api.getState.mockResolvedValue(syncState({ run: run("partial", sources), sources }));
    renderPanel();

    await screen.findByText("4,173");
    const powerPlatform = within(screen.getByText("Power Platform objects", { selector: "strong" }).closest("article")!);
    expect(powerPlatform.getByText("Reported count")).toBeVisible();
    expect(powerPlatform.getByText("4,173")).toBeVisible();
    expect(powerPlatform.queryByText("Saved count")).not.toBeInTheDocument();
    const packages = within(screen.getByText("Graph packages", { selector: "strong" }).closest("article")!);
    expect(packages.getByText("Saved count")).toBeVisible();
    expect(packages.getByText("1,005")).toBeVisible();
  });

  it("requires fresh confirmation to clear saved data and invalidates the cleared views", async () => {
    const sources = sourceIds.map(id => source(id, "succeeded", { count: 4 }));
    api.getState.mockResolvedValue(syncState({ onboardingRequired: false, usageImportRequired: false, sources }));
    api.start.mockResolvedValue(run("running", sourceIds.map(id => source(id, "queued")), { mode: "full" }));
    const onChanged = vi.fn();
    const view = renderPanel({ onSourcesChanged: onChanged });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Clear saved data and resync" }));
    expect(screen.getByText(/Accepted usage reports, report history, audit records/)).toBeVisible();
    const confirm = screen.getByRole("button", { name: "Clear and start full resync" });
    expect(confirm).toBeDisabled();
    await user.click(screen.getByRole("checkbox", { name: /I understand/ }));
    expect(confirm).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Keep saved data" }));
    expect(api.start).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Clear saved data and resync" }));
    expect(screen.getByRole("checkbox")).not.toBeChecked();
    await user.click(screen.getByRole("checkbox"));
    await act(async () => { view.rerenderPanel({ active: false }); });
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    view.rerenderPanel({ active: true });
    await user.click(screen.getByRole("button", { name: "Clear saved data and resync" }));
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
    expect(screen.getByText("Syncing graph packages, power platform objects")).toBeVisible();
    expect(screen.queryByText("Sync in progress")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Check progress" })).not.toBeInTheDocument();
    expect(screen.getByText("Reading package page 2.")).toBeVisible();
    expect(screen.getByRole("progressbar", { name: "Completed sync sources" })).toHaveAttribute("value", "1");
    expect(screen.getByRole("progressbar")).toHaveAttribute("max", "4");
    expect(screen.getByText("1 of 4 sources complete")).toBeVisible();
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
    expect(screen.getByText("View sync details").closest("details")).not.toHaveAttribute("open");
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
    screen.getByRole("button", { name: "Upload three CSVs" }).focus();
    await userEvent.tab();
    expect(screen.getByRole("button", { name: "After sync" })).toHaveFocus();
    await userEvent.tab({ shift: true });
    expect(screen.getByRole("button", { name: "Upload three CSVs" })).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    expect(screen.getByRole("region", { name: "Data sync" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Upload three CSVs" })).toHaveFocus();
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
    await userEvent.click(await screen.findByRole("button", { name: "Clear saved data and resync" }));
    await userEvent.click(screen.getByRole("checkbox"));
    await userEvent.click(screen.getByRole("button", { name: "Clear and start full resync" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Response lost.");
    expect(onChanged).toHaveBeenCalledWith(["users", "graph_packages", "power_platform"]);
    expect(api.start).toHaveBeenCalledOnce();
  });

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
    expect(screen.getByRole("heading", { name: "Set up your saved data" })).toBeVisible();
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

    expect((await screen.findAllByText("Usage upload required")).length).toBeGreaterThan(0);
    expect(screen.queryByText("Setup complete")).not.toBeInTheDocument();
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
    expect(screen.queryByRole("heading", { name: "Set up your saved data" })).not.toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(api.getState).toHaveBeenCalledTimes(3);
    expect(onChanged).toHaveBeenCalledWith(sourceIds);
    expect(screen.getAllByText("Setup complete")).not.toHaveLength(0);
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
    await screen.findAllByText("Setup complete");

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
    await userEvent.click(screen.getByRole("button", { name: "Return to latest run" }));
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
    expect(await screen.findByText("latest-run", { selector: "code" })).not.toBeVisible();
    await userEvent.click(screen.getByText("View sync details"));
    expect(screen.getByText("latest-run", { selector: "code" })).toBeVisible();
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
    expect(screen.getByRole("button", { name: "Return to latest run" })).toBeVisible();
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
    expect(screen.getByText("Sync complete")).toBeVisible();
    expect(screen.queryByText("latest-run", { selector: "code" })).not.toBeInTheDocument();
    expect(screen.getByText("exact-run", { selector: "code" })).not.toBeVisible();
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

    expect(await screen.findByText("new-run", { selector: "code" })).not.toBeVisible();
    await userEvent.click(screen.getByText("View sync details"));
    expect(screen.getByText("new-run", { selector: "code" })).toBeVisible();
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
});
