import { useLayoutEffect } from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionUser, WorkbenchJobSummary, WorkbenchJobsResponse } from "../api/client";
import { createSavedQueryClient } from "../savedQueries";
import { SavedQueryProvider } from "./SavedQueryProvider";
import * as historyTable from "./SyncHistoryTable";
import { SyncHistoryView } from "./SyncHistoryView";

const user: SessionUser = {
  displayName: "Viewer", username: "viewer@example.invalid", homeAccountId: "principal", tenantId: "tenant",
  roles: ["AgentControl.Viewer"],
};
const empty: WorkbenchJobsResponse = {
  value: [], unavailableSources: [], polledAt: "2026-09-10T07:00:00.000Z", requestId: "history-request",
};
const entry = (label: string, overrides: Partial<WorkbenchJobSummary> = {}): WorkbenchJobSummary => ({
  id: label, label, source: "data-sync", target: "3 sources", status: "completed",
  total: 3, completed: 3, partial: false,
  updatedAt: empty.polledAt, href: `/sync?syncRun=${label}`, ...overrides,
});
const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset().mockResolvedValue(Response.json(empty));
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("Sync history", () => {
  it("retires refresh callbacks after revisions, account replacement and unmount", async () => {
    fetchMock.mockImplementation(async () => Response.json(empty));
    const table = vi.spyOn(historyTable, "SyncHistoryTable");
    const view = render(<SyncHistoryView user={user} />);
    await screen.findByText(/No recent sync history/);
    const originalRefresh = table.mock.lastCall![0].onRefresh;
    view.rerender(<SyncHistoryView user={user} revision={1} />);
    await screen.findByText(/No recent sync history/);
    const revisedRefresh = table.mock.lastCall![0].onRefresh;
    await act(async () => originalRefresh());
    expect(fetchMock).toHaveBeenCalledTimes(2);
    view.rerender(<SyncHistoryView user={{ ...user, homeAccountId: "other" }} revision={1} />);
    await screen.findByText(/No recent sync history/);
    await act(async () => revisedRefresh());
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const currentRefresh = table.mock.lastCall![0].onRefresh;
    await act(async () => currentRefresh());
    expect(fetchMock).toHaveBeenCalledTimes(4);
    const unmountedRefresh = table.mock.lastCall![0].onRefresh;
    view.unmount();
    await act(async () => unmountedRefresh());
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("keeps collection history and ignores retired task-dashboard sources in an older server response", async () => {
    fetchMock.mockResolvedValue(Response.json({ ...empty, value: [
      { ...entry("Retained sync", { status: "partial" }), canResume: true, canCancel: true, canReconcile: true },
      { ...entry("Control work"), source: "package-controls" },
      { ...entry("CSV import"), source: "official-usage" },
      { ...entry("Investigation"), source: "defender" },
    ], unavailableSources: [{ source: "defender", code: "source_unavailable" }] }));
    const onOpenSyncRun = vi.fn();
    render(<SyncHistoryView user={user} onOpenSyncRun={onOpenSyncRun} />);
    expect(await screen.findByText("Retained sync")).toBeVisible();
    for (const label of ["Control work", "CSV import", "Investigation"]) expect(screen.queryByText(label)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /retry|resume|cancel/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/History is temporarily unavailable/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("link", { name: /View details for Retained sync/ }));
    expect(onOpenSyncRun).toHaveBeenCalledExactlyOnceWith("Retained sync");
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith("/api/workbench/jobs",
      expect.objectContaining({ credentials: "include", signal: expect.any(AbortSignal) }));
  });

  it("does not replace refreshed history with an aborted older response", async () => {
    let resolveOld!: (response: Response) => void;
    fetchMock.mockReturnValueOnce(new Promise<Response>(resolve => { resolveOld = resolve; }))
      .mockResolvedValue(Response.json({ ...empty, value: [entry("New history")] }));
    render(<SyncHistoryView user={user} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const signal = fetchMock.mock.calls[0][1].signal as AbortSignal;
    await userEvent.click(screen.getByRole("button", { name: "Refresh history" }));
    expect(signal.aborted).toBe(true);
    expect(await screen.findByText("New history")).toBeVisible();
    await act(async () => resolveOld(Response.json({ ...empty, value: [entry("Old history")] })));
    expect(screen.queryByText("Old history")).not.toBeInTheDocument();
  });

  it("admits only one pending manual refresh, including same-tick clicks, without dropping focus", async () => {
    let resolveRefresh!: (response: Response) => void;
    fetchMock.mockResolvedValueOnce(Response.json({ ...empty, value: [entry("Before")] }))
      .mockImplementation(() => new Promise<Response>(resolve => { resolveRefresh = resolve; }));
    render(<SyncHistoryView user={user} />);
    await screen.findByText("Before");
    const button = screen.getByRole("button", { name: "Refresh history" });
    button.focus();
    act(() => { button.click(); button.click(); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const signal = fetchMock.mock.calls[1][1].signal as AbortSignal;
    expect(signal.aborted).toBe(false);
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(button).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await act(async () => resolveRefresh(Response.json({ ...empty, value: [entry("After")] })));
    expect(await screen.findByText("After")).toBeVisible();
    expect(button).toHaveAttribute("aria-disabled", "false");
    expect(button).toHaveFocus();
  });

  it("isolates account changes and aborts the previous principal's read", async () => {
    let resolveOld!: (response: Response) => void;
    fetchMock.mockReturnValueOnce(new Promise<Response>(resolve => { resolveOld = resolve; }))
      .mockResolvedValue(Response.json({ ...empty, value: [entry("New account")] }));
    const view = render(<SyncHistoryView user={user} />);
    const signal = fetchMock.mock.calls[0][1].signal as AbortSignal;
    view.rerender(<SyncHistoryView user={{ ...user, homeAccountId: "other" }} />);
    expect(await screen.findByText("New account")).toBeVisible();
    expect(signal.aborted).toBe(true);
    await act(async () => resolveOld(Response.json({ ...empty, value: [entry("Old account")] })));
    expect(screen.queryByText("Old account")).not.toBeInTheDocument();
  });

  it.each([
    ["account", { ...user, homeAccountId: "other" }],
    ["tenant", { ...user, tenantId: "other" }],
    ["roles", { ...user, roles: ["AgentControl.Admin" as const] }],
  ])("withdraws loaded history on the first %s commit and resets local controls", async (_scope, nextUser) => {
    let resolveNew!: (response: Response) => void;
    fetchMock.mockResolvedValueOnce(Response.json({ ...empty, value: [entry("Private history")] }))
      .mockImplementation(() => new Promise<Response>(resolve => { resolveNew = resolve; }));
    const observed: Array<string | null> = [];
    function Owner({ currentUser }: { currentUser: SessionUser }) {
      useLayoutEffect(() => {
        observed.push(screen.getByRole("region", { name: "Sync history" }).textContent);
      }, [currentUser]);
      return <SyncHistoryView user={currentUser} />;
    }
    const view = render(<Owner currentUser={user} />);
    await screen.findByText("Private history");
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Outcome" }), "complete");
    await userEvent.click(screen.getByRole("button", { name: "Sort by Scope" }));
    view.rerender(<Owner currentUser={nextUser} />);
    expect(observed.at(-1)).not.toContain("Private history");
    expect(screen.queryByText("Private history")).not.toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Outcome" })).toHaveValue("all");
    await act(async () => resolveNew(Response.json({ ...empty, value: [entry("New history")] })));
    expect(await screen.findByText("New history")).toBeVisible();
    expect(screen.getByRole("columnheader", { name: "Started" })).toHaveAttribute("aria-sort", "descending");
  });

  it("refreshes history after its owner reports a new run", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ ...empty, value: [entry("Before")] }))
      .mockResolvedValue(Response.json({ ...empty, value: [entry("After")] }));
    const view = render(<SyncHistoryView user={user} revision={0} />);
    await screen.findByText("Before");
    view.rerender(<SyncHistoryView user={user} revision={1} />);
    expect(await screen.findByText("After")).toBeVisible();
    expect(screen.queryByText("Before")).not.toBeInTheDocument();
  });

  it("keeps local sort controls and focus across revision reads without extra requests", async () => {
    let resolveReload!: (response: Response) => void;
    fetchMock.mockResolvedValueOnce(Response.json({ ...empty, value: [entry("Before")] }))
      .mockImplementation(() => new Promise<Response>(resolve => { resolveReload = resolve; }));
    const view = render(<SyncHistoryView user={user} revision={0} />);
    await screen.findByText("Before");
    const heading = screen.getByRole("button", { name: "Sort by Scope" });
    heading.focus();
    await userEvent.keyboard("{Enter}");
    expect(fetchMock).toHaveBeenCalledOnce();
    view.rerender(<SyncHistoryView user={user} revision={1} />);
    await act(async () => {});
    expect(heading).toHaveFocus();
    expect(screen.getByText("Before")).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent("Updating sync history");
    await userEvent.keyboard(" ");
    expect(screen.getByRole("columnheader", { name: "Scope" })).toHaveAttribute("aria-sort", "descending");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await act(async () => resolveReload(Response.json(empty)));
    expect(await screen.findByText(/No recent sync history/)).toBeVisible();
    expect(heading).toHaveFocus();
    expect(screen.getByRole("button", { name: "Sort by Scope" })).toBe(heading);
  });

  it("preserves history and local sorting when equivalent roles are reordered", async () => {
    const currentUser: SessionUser = { ...user, roles: ["AgentControl.Viewer", "AgentControl.Admin"] };
    fetchMock.mockResolvedValue(Response.json({ ...empty, value: [entry("Current history")] }));
    const view = render(<SyncHistoryView user={currentUser} />);
    await screen.findByText("Current history");
    const heading = screen.getByRole("button", { name: "Sort by Scope" });
    heading.focus();
    await userEvent.keyboard("{Enter}");
    view.rerender(<SyncHistoryView user={{ ...currentUser, roles: ["AgentControl.Admin", "AgentControl.Viewer"] }} />);
    expect(screen.getByText("Current history")).toBeVisible();
    expect(heading).toHaveFocus();
    expect(screen.getByRole("columnheader", { name: "Scope" })).toHaveAttribute("aria-sort", "ascending");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("cancels obsolete revision reads and ignores their late errors without settling the newer read", async () => {
    let resolveOld!: (response: Response) => void;
    let resolveNew!: (response: Response) => void;
    fetchMock.mockResolvedValueOnce(Response.json({ ...empty, value: [entry("Retained history")] }))
      .mockImplementationOnce(() => new Promise<Response>(resolve => { resolveOld = resolve; }))
      .mockImplementationOnce(() => new Promise<Response>(resolve => { resolveNew = resolve; }));
    const view = render(<SyncHistoryView user={user} revision={0} />);
    await screen.findByText("Retained history");
    view.rerender(<SyncHistoryView user={user} revision={1} />);
    const obsoleteSignal = fetchMock.mock.calls[1][1].signal as AbortSignal;
    view.rerender(<SyncHistoryView user={user} revision={2} />);
    expect(obsoleteSignal.aborted).toBe(true);
    await act(async () => resolveOld(Response.json({ detail: "Old failure" }, { status: 503 })));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Sync history" })).toHaveAttribute("aria-busy", "true");
    expect(screen.getByText("Retained history")).toBeVisible();
    await act(async () => resolveNew(Response.json({ ...empty, value: [entry("Newest history")] })));
    expect(await screen.findByText("Newest history")).toBeVisible();
    expect(screen.queryByText("Retained history")).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it.each([401, 403])("clears retained history when a refresh is denied with %s", async status => {
    fetchMock.mockResolvedValueOnce(Response.json({ ...empty, value: [entry("Private history")] }))
      .mockResolvedValue(Response.json({ code: "forbidden", detail: "History access denied." }, { status }));
    render(<SyncHistoryView user={user} />);
    await screen.findByText("Private history");
    await userEvent.click(screen.getByRole("button", { name: "Refresh history" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("History access denied.");
    expect(screen.queryByText("Private history")).not.toBeInTheDocument();
  });

  it("keeps loaded history after a transient failure without reporting empty success", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ ...empty, value: [entry("Retained history")] }))
      .mockResolvedValue(Response.json({ code: "service_unavailable", detail: "History temporarily unavailable." }, { status: 503 }));
    render(<SyncHistoryView user={user} />);
    await screen.findByText("Retained history");
    await userEvent.click(screen.getByRole("button", { name: "Refresh history" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("History temporarily unavailable.");
    expect(screen.getByText("Retained history")).toBeVisible();
    expect(screen.queryByText(/No recent sync history/)).not.toBeInTheDocument();
  });

  it("shows a pending retry rather than the old failure or a successful empty result", async () => {
    let resolveRetry!: (response: Response) => void;
    fetchMock.mockResolvedValueOnce(Response.json(empty))
      .mockResolvedValueOnce(Response.json({ code: "service_unavailable", detail: "History temporarily unavailable." }, { status: 503 }))
      .mockImplementation(() => new Promise<Response>(resolve => { resolveRetry = resolve; }));
    render(<SyncHistoryView user={user} />);
    await screen.findByText(/No recent sync history/);
    await userEvent.click(screen.getByRole("button", { name: "Refresh history" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("History temporarily unavailable.");
    await userEvent.click(screen.getByRole("button", { name: "Refresh history" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByText(/No recent sync history/)).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Updating sync history");
    await act(async () => resolveRetry(Response.json(empty)));
    expect(await screen.findByText(/No recent sync history/)).toBeVisible();
  });

  it("withdraws cancelled cache evidence and offers an explicit retry without replaying the read", async () => {
    const client = createSavedQueryClient();
    let resolveCancelled!: (response: Response) => void;
    fetchMock.mockResolvedValueOnce(Response.json({ ...empty, value: [entry("Retained history")] }))
      .mockImplementationOnce(() => new Promise<Response>(resolve => { resolveCancelled = resolve; }))
      .mockResolvedValue(Response.json({ ...empty, value: [entry("Recovered history")] }));
    render(<SavedQueryProvider client={client}><SyncHistoryView user={user} /></SavedQueryProvider>);
    await screen.findByText("Retained history");
    await userEvent.click(screen.getByRole("button", { name: "Refresh history" }));
    const signal = fetchMock.mock.calls[1][1].signal as AbortSignal;
    await act(async () => client.clear());
    expect(signal.aborted).toBe(true);
    expect(await screen.findByRole("alert")).toHaveTextContent(/cancelled.*Refresh history/);
    expect(screen.queryByText("Retained history")).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Sync history" })).toHaveAttribute("aria-busy", "false");
    await act(async () => resolveCancelled(Response.json({ ...empty, value: [entry("Cancelled history")] })));
    expect(screen.queryByText("Cancelled history")).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await userEvent.click(screen.getByRole("button", { name: "Refresh history" }));
    expect(await screen.findByText("Recovered history")).toBeVisible();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("keeps an invalidated read pending until its already-started replacement settles", async () => {
    vi.useFakeTimers();
    const client = createSavedQueryClient();
    let resolveReplacement!: (response: Response) => void;
    fetchMock.mockResolvedValueOnce(Response.json({ ...empty, value: [entry("Invalidated history")] }))
      .mockImplementationOnce(() => new Promise<Response>(resolve => { resolveReplacement = resolve; }))
      .mockResolvedValue(Response.json({ ...empty, value: [entry("Completed history")] }));
    const unsubscribe = client.getQueryCache().subscribe(event => {
      if (event.type !== "updated" || event.action.type !== "success") return;
      unsubscribe();
      void client.invalidateQueries({ queryKey: ["saved", "workbench-jobs"] });
    });
    render(<SavedQueryProvider client={client}><SyncHistoryView user={user} /></SavedQueryProvider>);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(screen.queryByText("Invalidated history")).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Sync history" })).toHaveAttribute("aria-busy", "true");
    expect(fetchMock.mock.calls[1][1].signal.aborted).toBe(false);
    await act(async () => resolveReplacement(Response.json({ ...empty, value: [entry("Current history", { status: "running" })] })));
    expect(screen.getByText("Current history")).toBeVisible();
    expect(screen.getByRole("region", { name: "Sync history" })).toHaveAttribute("aria-busy", "false");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(screen.getByText("Completed history")).toBeVisible();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("shares Strict Mode reads without cancelling the remaining consumer", async () => {
    const client = createSavedQueryClient();
    let resolveRead!: (response: Response) => void;
    fetchMock.mockImplementation(() => new Promise<Response>(resolve => { resolveRead = resolve; }));
    const content = (both: boolean) => <SavedQueryProvider client={client}>
      {both ? <SyncHistoryView user={user} /> : null}
      <SyncHistoryView user={user} />
    </SavedQueryProvider>;
    const view = render(content(true), { reactStrictMode: true });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const signal = fetchMock.mock.calls[1][1].signal as AbortSignal;
    view.rerender(content(false));
    expect(signal.aborted).toBe(false);
    await act(async () => resolveRead(Response.json({ ...empty, value: [entry("Shared history")] })));
    expect(await screen.findByText("Shared history")).toBeVisible();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("uses fresh manual-read epochs without cancelling another observer's shared initial read", async () => {
    const client = createSavedQueryClient();
    let resolveInitial!: (response: Response) => void;
    let resolveRefresh!: (response: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>(resolve => { resolveInitial = resolve; }))
      .mockImplementationOnce(() => new Promise<Response>(resolve => { resolveRefresh = resolve; }));
    render(<SavedQueryProvider client={client}>
      <SyncHistoryView user={user} />
      <SyncHistoryView user={user} />
    </SavedQueryProvider>);
    expect(fetchMock).toHaveBeenCalledOnce();
    const signal = fetchMock.mock.calls[0][1].signal as AbortSignal;
    const refresh = screen.getAllByRole("button", { name: "Refresh history" })[0];
    act(() => { refresh.click(); refresh.click(); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(signal.aborted).toBe(false);
    await act(async () => resolveRefresh(Response.json({ ...empty, value: [entry("Fresh history")] })));
    expect(await screen.findByText("Fresh history")).toBeVisible();
    await act(async () => resolveInitial(Response.json({ ...empty, value: [entry("Initial history")] })));
    expect(await screen.findByText("Initial history")).toBeVisible();
    expect(screen.getAllByText("Fresh history")).toHaveLength(1);
    expect(screen.getAllByText("Initial history")).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("aborts pending reads when unmounted without restarting polling from a late response", async () => {
    vi.useFakeTimers();
    let resolveRead!: (response: Response) => void;
    fetchMock.mockImplementation(() => new Promise<Response>(resolve => { resolveRead = resolve; }));
    const view = render(<SyncHistoryView user={user} />);
    const signal = fetchMock.mock.calls[0][1].signal as AbortSignal;
    view.unmount();
    expect(signal.aborted).toBe(true);
    await act(async () => {
      resolveRead(Response.json({ ...empty, value: [entry("Late active job", { status: "running" })] }));
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("polls active sync past thirty minutes and stops when it finishes, ignoring other work", async () => {
    vi.useFakeTimers();
    let completed = false;
    fetchMock.mockImplementation(async () => Response.json({ ...empty, value: [
      entry("Active sync", { status: completed ? "completed" : "running" }),
      { ...entry("Active control", { status: "running" }), source: "package-controls" },
    ] }));
    render(<SyncHistoryView user={user} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    vi.setSystemTime(Date.now() + 30 * 60_000);
    await act(async () => { await vi.advanceTimersByTimeAsync(6_000); });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    completed = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(fetchMock).toHaveBeenCalledTimes(5);
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });
});
