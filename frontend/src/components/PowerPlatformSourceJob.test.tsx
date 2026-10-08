import type { ReactNode } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as api from "../api/client";
import { PowerPlatformSourceJob } from "./PowerPlatformSourceJob";
import { SavedQueryProvider } from "./SavedQueryProvider";
import { createSavedQueryClient } from "../savedQueries";

vi.mock("../api/client", async importOriginal => ({
  ...await importOriginal<typeof api>(),
  getInventoryRefreshJob: vi.fn(), resumeInventoryRefresh: vi.fn(),
  cancelInventoryRefresh: vi.fn(), refreshInventory: vi.fn(),
}));
vi.mock("../workbenchActionContext", () => ({
  WorkbenchActionGate: ({ children }: { children: ReactNode }) => children,
}));

function job(status: api.InventoryRefreshJob["status"]): api.InventoryRefreshJob {
  return {
    id: "exact-job", status, roleScope: "unknown", environmentScope: null,
    requestedTypes: ["microsoft.copilotstudio/agents", "microsoft.powerplatform/environments"],
    pageCount: 1, observedCount: 1, totalRecords: null, unknownFieldCount: 2, snapshotId: null,
    createdAt: "2026-09-23T00:00:00Z", attemptedAt: "2026-09-23T00:00:01Z", updatedAt: "2026-09-23T00:00:02Z", finishedAt: null,
  };
}
afterEach(() => { vi.useRealTimers(); vi.resetAllMocks(); });

describe("Power Platform source job", () => {
  it("shares an identical in-flight job across different poll revisions and cancels only the departing consumer", async () => {
    vi.useFakeTimers();
    const client = createSavedQueryClient(), first = vi.fn(), second = vi.fn();
    let resolve!: (value: api.InventoryRefreshJob) => void;
    vi.mocked(api.getInventoryRefreshJob).mockReturnValue(new Promise(yes => { resolve = yes; }));
    const panel = (id: string, initial = false) => <PowerPlatformSourceJob key={id} jobId="exact-job"
      initialJob={initial ? job("running") : undefined} onSelect={vi.fn()} onObserved={id === "first" ? first : second} />;
    const view = render(<SavedQueryProvider client={client}>{panel("first", true)}</SavedQueryProvider>);
    await act(() => vi.advanceTimersByTimeAsync(2500));
    expect(api.getInventoryRefreshJob).toHaveBeenCalledTimes(1);
    const signal = vi.mocked(api.getInventoryRefreshJob).mock.calls[0][1]!.signal!;
    view.rerender(<SavedQueryProvider client={client}>{panel("first", true)}{panel("second")}</SavedQueryProvider>);
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(api.getInventoryRefreshJob).toHaveBeenCalledTimes(1);
    view.rerender(<SavedQueryProvider client={client}>{panel("second")}</SavedQueryProvider>);
    expect(signal.aborted).toBe(false);
    await act(async () => resolve(job("succeeded")));
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(api.getInventoryRefreshJob).toHaveBeenCalledTimes(1);
    expect(api.refreshInventory).not.toHaveBeenCalled();
    view.unmount();
    client.clear();
  });

  it("suspends an owned status transport while offline and does not resume a completed observation", async () => {
    vi.useFakeTimers();
    const online = vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    vi.mocked(api.getInventoryRefreshJob).mockResolvedValue(job("succeeded"));
    const view = render(<PowerPlatformSourceJob jobId="exact-job" onSelect={vi.fn()} onObserved={vi.fn()} />);
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(api.getInventoryRefreshJob).not.toHaveBeenCalled();
    online.mockReturnValue(true);
    await act(async () => { window.dispatchEvent(new Event("online")); });
    expect(api.getInventoryRefreshJob).toHaveBeenCalledTimes(1);
    online.mockReturnValue(false);
    await act(async () => { window.dispatchEvent(new Event("offline")); });
    online.mockReturnValue(true);
    await act(async () => { window.dispatchEvent(new Event("online")); });
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(api.getInventoryRefreshJob).toHaveBeenCalledTimes(1);
    view.unmount();
    online.mockRestore();
  });

  it("does not join another consumer's pre-command status after an explicit resume", async () => {
    vi.useFakeTimers();
    const client = createSavedQueryClient(), observed = vi.fn();
    let resolve!: (value: api.InventoryRefreshJob) => void;
    vi.mocked(api.getInventoryRefreshJob).mockReturnValueOnce(new Promise(yes => { resolve = yes; }))
      .mockResolvedValueOnce(job("succeeded"));
    vi.mocked(api.resumeInventoryRefresh).mockResolvedValue(job("running"));
    const view = render(<SavedQueryProvider client={client}>
      <PowerPlatformSourceJob jobId="exact-job" onSelect={vi.fn()} onObserved={vi.fn()} />
      <PowerPlatformSourceJob jobId="exact-job" initialJob={job("waiting_authorization")} onSelect={vi.fn()} onObserved={observed} />
    </SavedQueryProvider>);
    await act(() => vi.advanceTimersByTimeAsync(0));
    const oldSignal = vi.mocked(api.getInventoryRefreshJob).mock.calls[0][1]?.signal;
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Resume source job" })));
    await act(() => vi.advanceTimersByTimeAsync(2500));
    expect(api.resumeInventoryRefresh).toHaveBeenCalledOnce();
    expect(api.getInventoryRefreshJob).toHaveBeenCalledTimes(2);
    expect(observed).toHaveBeenLastCalledWith(job("succeeded"), job("running"));
    expect(oldSignal?.aborted).toBe(false);
    await act(async () => resolve(job("waiting_authorization")));
    view.unmount();
    client.clear();
  });

  it("observes a different job after the previous selected job completed", async () => {
    vi.useFakeTimers();
    vi.mocked(api.getInventoryRefreshJob).mockResolvedValueOnce(job("succeeded"))
      .mockResolvedValueOnce({ ...job("succeeded"), id: "next-job" });
    const observed = vi.fn();
    const view = render(<PowerPlatformSourceJob jobId="exact-job" onSelect={vi.fn()} onObserved={observed} />);
    await act(() => vi.advanceTimersByTimeAsync(0));
    view.rerender(<PowerPlatformSourceJob jobId="next-job" onSelect={vi.fn()} onObserved={observed} />);
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(api.getInventoryRefreshJob).toHaveBeenCalledTimes(2);
    expect(observed).toHaveBeenLastCalledWith({ ...job("succeeded"), id: "next-job" }, undefined);
  });

  it.each(["failed", "waiting_authorization", "running", "succeeded", "cancelled"] as const)("inspects the exact %s job without starting provider work", async status => {
    vi.mocked(api.getInventoryRefreshJob).mockResolvedValue({ ...job(status), message: "Exact source diagnostics" });
    render(<PowerPlatformSourceJob jobId="exact-job" onSelect={vi.fn()} onObserved={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(status.replaceAll("_", " ")));
    expect(screen.getByRole("status")).toHaveTextContent("Exact source diagnostics");
    expect(screen.getByText("Unknown")).toBeVisible();
    expect(api.getInventoryRefreshJob).toHaveBeenCalledWith("exact-job", expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(api.refreshInventory).not.toHaveBeenCalled();
    expect(api.resumeInventoryRefresh).not.toHaveBeenCalled();
    expect(api.cancelInventoryRefresh).not.toHaveBeenCalled();
  });

  it.each(["resume", "cancel"] as const)("sends %s only to the inspected waiting job", async action => {
    vi.mocked(api.getInventoryRefreshJob).mockResolvedValue(job("waiting_authorization"));
    const mutate = action === "resume" ? api.resumeInventoryRefresh : api.cancelInventoryRefresh;
    vi.mocked(mutate).mockImplementation(async () => {
      const updated = job(action === "resume" ? "running" : "cancelled");
      vi.mocked(api.getInventoryRefreshJob).mockResolvedValue(updated);
      return updated;
    });
    const observed = vi.fn();
    render(<PowerPlatformSourceJob jobId="exact-job" onSelect={vi.fn()} onObserved={observed} />);
    await userEvent.click(await screen.findByRole("button", { name: action === "resume" ? "Resume source job" : "Cancel source job" }));
    expect(mutate).toHaveBeenCalledExactlyOnceWith("exact-job", { signal: expect.any(AbortSignal) });
    await waitFor(() => expect(observed).toHaveBeenCalledWith(
      job(action === "resume" ? "running" : "cancelled"), job("waiting_authorization"),
    ));
    expect(await screen.findByRole("status")).toHaveTextContent(action === "resume" ? "running" : "cancelled");
  });

  it("retries a failed job as a new job with its exact original scope", async () => {
    vi.mocked(api.getInventoryRefreshJob).mockResolvedValue({ ...job("failed"), environmentScope: "environment-a" });
    vi.mocked(api.refreshInventory).mockResolvedValue({ ...job("running"), id: "new-job" });
    const select = vi.fn();
    const observed = vi.fn();
    render(<PowerPlatformSourceJob jobId="exact-job" onSelect={select} onObserved={observed} />);
    await userEvent.click(await screen.findByRole("button", { name: "Start a new source refresh" }));
    expect(api.refreshInventory).toHaveBeenCalledExactlyOnceWith({
      types: ["microsoft.copilotstudio/agents", "microsoft.powerplatform/environments"], environmentId: "environment-a",
    }, { signal: expect.any(AbortSignal) });
    expect(select).toHaveBeenCalledWith("new-job", { ...job("running"), id: "new-job" });
    expect(api.getInventoryRefreshJob).toHaveBeenCalledTimes(1);
    expect(observed).toHaveBeenCalledTimes(2);
  });

  it.each(["running", "waiting_authorization", "succeeded", "failed", "cancelled"] as const)(
    "does not reread or republish a handed-off %s job, and polls only a running result",
    async status => {
      vi.useFakeTimers();
      const submitted = job(status);
      const observed = vi.fn();
      vi.mocked(api.getInventoryRefreshJob).mockResolvedValue(job("succeeded"));
      render(<PowerPlatformSourceJob jobId="exact-job" initialJob={submitted} onSelect={vi.fn()} onObserved={observed} />);
      expect(screen.getByRole("status")).toHaveTextContent(status.replaceAll("_", " "));
      expect(screen.getByRole("region")).toHaveAttribute("aria-busy", "false");
      expect(api.getInventoryRefreshJob).not.toHaveBeenCalled();
      expect(observed).not.toHaveBeenCalled();
      await act(() => vi.advanceTimersByTimeAsync(2499));
      expect(api.getInventoryRefreshJob).not.toHaveBeenCalled();
      await act(() => vi.advanceTimersByTimeAsync(5001));
      if (status === "running") {
        expect(api.getInventoryRefreshJob).toHaveBeenCalledTimes(1);
        expect(observed).toHaveBeenCalledExactlyOnceWith(job("succeeded"), submitted);
      } else {
        expect(api.getInventoryRefreshJob).not.toHaveBeenCalled();
        expect(observed).not.toHaveBeenCalled();
      }
    },
  );

  it("retains the handed-off authorization wait as the predecessor of explicit resume", async () => {
    const submitted = job("waiting_authorization");
    const observed = vi.fn();
    vi.mocked(api.resumeInventoryRefresh).mockResolvedValue(job("succeeded"));
    render(<PowerPlatformSourceJob jobId="exact-job" initialJob={submitted} onSelect={vi.fn()} onObserved={observed} />);
    await userEvent.click(screen.getByRole("button", { name: "Resume source job" }));
    expect(api.resumeInventoryRefresh).toHaveBeenCalledTimes(1);
    expect(api.getInventoryRefreshJob).not.toHaveBeenCalled();
    expect(observed).toHaveBeenCalledExactlyOnceWith(job("succeeded"), submitted);
    expect(screen.getByRole("status")).toHaveTextContent("succeeded");
  });

  it("shows denied exact jobs as unavailable rather than substituting history", async () => {
    vi.mocked(api.getInventoryRefreshJob).mockRejectedValue(new Error("This job is unavailable to this account."));
    render(<PowerPlatformSourceJob jobId="private-job" onSelect={vi.fn()} onObserved={vi.fn()} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("This job is unavailable to this account.");
    expect(screen.queryByRole("button", { name: "Resume source job" })).not.toBeInTheDocument();
    expect(screen.queryByText("Unknown")).not.toBeInTheDocument();
  });

  it("returns reauthorization to the exact source job without starting or resuming it", async () => {
    vi.mocked(api.getInventoryRefreshJob).mockResolvedValue(job("waiting_authorization"));
    render(<PowerPlatformSourceJob jobId="exact-job" onSelect={vi.fn()} onObserved={vi.fn()} />);
    const link = await screen.findByRole("link", { name: "Sign in again" });
    const login = new URL(link.getAttribute("href")!, window.location.origin);
    expect(login.pathname).toBe("/api/auth/login");
    expect(login.searchParams.get("returnTo")).toBe("/sync?powerPlatformJob=exact-job");
    expect(api.refreshInventory).not.toHaveBeenCalled();
    expect(api.resumeInventoryRefresh).not.toHaveBeenCalled();
  });

  it.each(["resume", "cancel", "retry"] as const)("does not publish a delayed %s after leaving the owning view", async action => {
    vi.mocked(api.getInventoryRefreshJob).mockResolvedValue(job(action === "retry" ? "failed" : "waiting_authorization"));
    const mutate = action === "resume" ? api.resumeInventoryRefresh : action === "cancel" ? api.cancelInventoryRefresh : api.refreshInventory;
    let finish!: (value: api.InventoryRefreshJob) => void;
    vi.mocked(mutate).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const observed = vi.fn();
    const select = vi.fn();
    const view = render(<PowerPlatformSourceJob jobId="exact-job" onSelect={select} onObserved={observed} />);
    const name = action === "resume" ? "Resume source job" : action === "cancel" ? "Cancel source job" : "Start a new source refresh";
    await userEvent.click(await screen.findByRole("button", { name }));
    const signal = vi.mocked(mutate).mock.calls[0][1]?.signal;
    expect(signal).toBeInstanceOf(AbortSignal);
    observed.mockClear();
    view.unmount();
    expect(signal?.aborted).toBe(true);
    await act(async () => finish(job("running")));
    expect(observed).not.toHaveBeenCalled();
    expect(select).not.toHaveBeenCalled();
  });

  it("retains an action error until explicit reload instead of hiding it with the saved job", async () => {
    vi.mocked(api.getInventoryRefreshJob).mockResolvedValue(job("waiting_authorization"));
    vi.mocked(api.resumeInventoryRefresh).mockRejectedValue(new Error("Current authorization is required."));
    render(<PowerPlatformSourceJob jobId="exact-job" onSelect={vi.fn()} onObserved={vi.fn()} />);
    await userEvent.click(await screen.findByRole("button", { name: "Resume source job" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Current authorization is required.");
    expect(api.getInventoryRefreshJob).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole("button", { name: "Reload source job" }));
    expect(await screen.findByRole("status")).toHaveTextContent("waiting authorization");
    expect(api.getInventoryRefreshJob).toHaveBeenCalledTimes(2);
  });

  it("waits for a pending workspace command before reading or admitting exact-job work", async () => {
    vi.mocked(api.getInventoryRefreshJob).mockResolvedValue(job("waiting_authorization"));
    const observed = vi.fn();
    const view = render(<PowerPlatformSourceJob jobId="exact-job" onSelect={vi.fn()} onObserved={observed} paused />);
    expect(screen.getByRole("region")).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("status")).toHaveTextContent("Waiting for the current source command");
    expect(screen.queryByRole("button", { name: "Resume source job" })).not.toBeInTheDocument();
    expect(api.getInventoryRefreshJob).not.toHaveBeenCalled();
    view.rerender(<PowerPlatformSourceJob jobId="exact-job" onSelect={vi.fn()} onObserved={observed} />);
    expect(await screen.findByRole("button", { name: "Resume source job" })).toBeEnabled();
    expect(screen.getByRole("region")).toHaveAttribute("aria-busy", "false");
    expect(api.getInventoryRefreshJob).toHaveBeenCalledTimes(1);
    expect(api.resumeInventoryRefresh).not.toHaveBeenCalled();
  });

  it("reports exact status transitions without launching a refresh", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.mocked(api.getInventoryRefreshJob).mockResolvedValueOnce(job("running")).mockResolvedValue(job("succeeded"));
    const observed = vi.fn();
    render(<PowerPlatformSourceJob jobId="exact-job" onSelect={vi.fn()} onObserved={observed} />);
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("running"));
    expect(observed).toHaveBeenCalledExactlyOnceWith(job("running"), undefined);
    await act(async () => { await vi.advanceTimersByTimeAsync(2500); });
    expect(screen.getByRole("status")).toHaveTextContent("succeeded");
    expect(observed).toHaveBeenCalledTimes(2);
    expect(observed).toHaveBeenLastCalledWith(job("succeeded"), job("running"));
    expect(api.refreshInventory).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(api.getInventoryRefreshJob).toHaveBeenCalledTimes(2);
  });

  it.each(["resume", "cancel"] as const)("uses the %s response without a duplicate status read or publication", async action => {
    vi.useFakeTimers();
    const initial = job("waiting_authorization");
    const updated = job(action === "resume" ? "running" : "cancelled");
    const mutate = action === "resume" ? api.resumeInventoryRefresh : api.cancelInventoryRefresh;
    vi.mocked(api.getInventoryRefreshJob).mockResolvedValue(initial);
    vi.mocked(mutate).mockResolvedValue(updated);
    const observed = vi.fn();
    render(<PowerPlatformSourceJob jobId="exact-job" onSelect={vi.fn()} onObserved={observed} />);
    await act(() => vi.advanceTimersByTimeAsync(0));
    fireEvent.click(screen.getByRole("button", { name: action === "resume" ? "Resume source job" : "Cancel source job" }));
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(screen.getByRole("status")).toHaveTextContent(updated.status);
    expect(api.getInventoryRefreshJob).toHaveBeenCalledTimes(1);
    expect(observed).toHaveBeenCalledTimes(2);
    expect(observed).toHaveBeenLastCalledWith(updated, initial);
    vi.mocked(api.getInventoryRefreshJob).mockResolvedValue(job("succeeded"));
    await act(() => vi.advanceTimersByTimeAsync(2499));
    expect(api.getInventoryRefreshJob).toHaveBeenCalledTimes(1);
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(api.getInventoryRefreshJob).toHaveBeenCalledTimes(action === "resume" ? 2 : 1);
    await act(() => vi.advanceTimersByTimeAsync(5000));
    expect(api.getInventoryRefreshJob).toHaveBeenCalledTimes(action === "resume" ? 2 : 1);
  });

  it("aborts an in-flight poll before cancelling and ignores its delayed completion", async () => {
    vi.useFakeTimers();
    let finishPoll!: (value: api.InventoryRefreshJob) => void;
    vi.mocked(api.getInventoryRefreshJob).mockResolvedValueOnce(job("running"))
      .mockImplementationOnce(() => new Promise(resolve => { finishPoll = resolve; }))
      .mockResolvedValue(job("cancelled"));
    let finishCancel!: (value: api.InventoryRefreshJob) => void;
    vi.mocked(api.cancelInventoryRefresh).mockImplementation(() => new Promise(resolve => { finishCancel = resolve; }));
    const observed = vi.fn();
    render(<PowerPlatformSourceJob jobId="exact-job" onSelect={vi.fn()} onObserved={observed} />);
    await act(() => vi.advanceTimersByTimeAsync(2500));
    expect(api.getInventoryRefreshJob).toHaveBeenCalledTimes(2);
    const pollSignal = vi.mocked(api.getInventoryRefreshJob).mock.calls[1][1]?.signal;
    const cancel = screen.getByRole("button", { name: "Cancel source job" });
    act(() => { cancel.click(); cancel.click(); });
    expect(api.cancelInventoryRefresh).toHaveBeenCalledTimes(1);
    expect(pollSignal?.aborted).toBe(true);
    expect(cancel).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("Updating source job");
    await act(() => vi.advanceTimersByTimeAsync(10000));
    expect(api.getInventoryRefreshJob).toHaveBeenCalledTimes(2);
    await act(async () => finishCancel(job("cancelled")));
    await act(async () => finishPoll(job("succeeded")));
    expect(screen.getByRole("status")).toHaveTextContent("cancelled");
    expect(observed).toHaveBeenCalledTimes(2);
    expect(observed).toHaveBeenLastCalledWith(job("cancelled"), job("running"));
    await act(() => vi.advanceTimersByTimeAsync(5000));
    expect(api.getInventoryRefreshJob).toHaveBeenCalledTimes(2);
  });

  it("keeps slow polls single-flight and reloads a failed poll only on explicit request", async () => {
    vi.useFakeTimers();
    let fail!: (error: Error) => void;
    vi.mocked(api.getInventoryRefreshJob).mockResolvedValueOnce(job("running"))
      .mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }))
      .mockResolvedValue(job("succeeded"));
    const observed = vi.fn();
    render(<PowerPlatformSourceJob jobId="exact-job" onSelect={vi.fn()} onObserved={observed} />);
    await act(() => vi.advanceTimersByTimeAsync(15000));
    expect(api.getInventoryRefreshJob).toHaveBeenCalledTimes(2);
    await act(async () => fail(new Error("Status is temporarily unavailable.")));
    expect(screen.getByRole("alert")).toHaveTextContent("Status is temporarily unavailable.");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(10000));
    expect(api.getInventoryRefreshJob).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole("button", { name: "Reload source job" }));
    expect(screen.getByRole("status")).toHaveTextContent("Loading source job");
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(screen.getByRole("status")).toHaveTextContent("succeeded");
    expect(api.getInventoryRefreshJob).toHaveBeenCalledTimes(3);
    expect(observed).toHaveBeenLastCalledWith(job("succeeded"), job("running"));
  });

  it("does not let a same-batch poll timer reread a completed cancellation", async () => {
    vi.useFakeTimers();
    vi.mocked(api.getInventoryRefreshJob).mockResolvedValue(job("running"));
    vi.mocked(api.cancelInventoryRefresh).mockResolvedValue(job("cancelled"));
    const observed = vi.fn();
    render(<PowerPlatformSourceJob jobId="exact-job" onSelect={vi.fn()} onObserved={observed} />);
    await act(() => vi.advanceTimersByTimeAsync(0));
    const cancel = screen.getByRole("button", { name: "Cancel source job" });
    await act(async () => { vi.advanceTimersByTime(2500); cancel.click(); });
    expect(screen.getByRole("status")).toHaveTextContent("cancelled");
    expect(api.getInventoryRefreshJob).toHaveBeenCalledTimes(1);
    expect(observed).toHaveBeenCalledTimes(2);
    await act(() => vi.advanceTimersByTimeAsync(5000));
    expect(api.getInventoryRefreshJob).toHaveBeenCalledTimes(1);
  });

  it("cancels a pending exact read and does not publish its late result after closing", async () => {
    let finish!: (value: api.InventoryRefreshJob) => void;
    vi.mocked(api.getInventoryRefreshJob).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const observed = vi.fn();
    const view = render(<PowerPlatformSourceJob jobId="exact-job" onSelect={vi.fn()} onObserved={observed} />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading source job");
    expect(screen.getByRole("region")).toHaveAttribute("aria-busy", "true");
    const signal = vi.mocked(api.getInventoryRefreshJob).mock.calls[0][1]?.signal;
    view.unmount();
    expect(signal?.aborted).toBe(true);
    await act(async () => finish(job("succeeded")));
    expect(observed).not.toHaveBeenCalled();
  });

  it.each(["read", "resume", "cancel"] as const)("rejects a different job returned by an exact %s", async action => {
    const other = { ...job("succeeded"), id: "different-job" };
    vi.mocked(api.getInventoryRefreshJob).mockResolvedValue(action === "read" ? other : job("waiting_authorization"));
    vi.mocked(api.resumeInventoryRefresh).mockResolvedValue(other);
    vi.mocked(api.cancelInventoryRefresh).mockResolvedValue(other);
    const observed = vi.fn();
    render(<PowerPlatformSourceJob jobId="exact-job" onSelect={vi.fn()} onObserved={observed} />);
    if (action !== "read") {
      const button = await screen.findByRole("button", { name: action === "resume" ? "Resume source job" : "Cancel source job" });
      observed.mockClear();
      await userEvent.click(button);
    }
    expect(await screen.findByRole("alert")).toHaveTextContent("The source returned a different job");
    expect(observed).not.toHaveBeenCalled();
    expect(api.getInventoryRefreshJob).toHaveBeenCalledTimes(1);
  });
});
