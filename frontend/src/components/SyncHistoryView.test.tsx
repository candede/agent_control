import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionUser, WorkbenchJobSummary, WorkbenchJobsResponse } from "../api/client";
import { createSavedQueryClient } from "../savedQueries";
import { SavedQueryProvider } from "./SavedQueryProvider";
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
afterEach(() => vi.useRealTimers());

describe("Sync history", () => {
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

  it("refreshes history after its owner reports a new run", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ ...empty, value: [entry("Before")] }))
      .mockResolvedValue(Response.json({ ...empty, value: [entry("After")] }));
    const view = render(<SyncHistoryView user={user} revision={0} />);
    await screen.findByText("Before");
    view.rerender(<SyncHistoryView user={user} revision={1} />);
    expect(await screen.findByText("After")).toBeVisible();
    expect(screen.queryByText("Before")).not.toBeInTheDocument();
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
