import type { ReactNode } from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as api from "../api/client";
import { PowerPlatformSourceJob } from "./PowerPlatformSourceJob";

vi.mock("../api/client", () => ({
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
  it.each(["failed", "waiting_authorization", "running", "succeeded", "cancelled"] as const)("inspects the exact %s job without starting provider work", async status => {
    vi.mocked(api.getInventoryRefreshJob).mockResolvedValue({ ...job(status), message: "Exact source diagnostics" });
    render(<PowerPlatformSourceJob jobId="exact-job" onSelect={vi.fn()} onChanged={vi.fn()} />);
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
    const changed = vi.fn();
    render(<PowerPlatformSourceJob jobId="exact-job" onSelect={vi.fn()} onChanged={changed} />);
    await userEvent.click(await screen.findByRole("button", { name: action === "resume" ? "Resume source job" : "Cancel source job" }));
    expect(mutate).toHaveBeenCalledExactlyOnceWith("exact-job");
    await waitFor(() => expect(changed).toHaveBeenCalledOnce());
    expect(await screen.findByRole("status")).toHaveTextContent(action === "resume" ? "running" : "cancelled");
  });

  it("retries a failed job as a new job with its exact original scope", async () => {
    vi.mocked(api.getInventoryRefreshJob).mockResolvedValue({ ...job("failed"), environmentScope: "environment-a" });
    vi.mocked(api.refreshInventory).mockResolvedValue({ ...job("running"), id: "new-job" });
    const select = vi.fn();
    render(<PowerPlatformSourceJob jobId="exact-job" onSelect={select} onChanged={vi.fn()} />);
    await userEvent.click(await screen.findByRole("button", { name: "Start a new source refresh" }));
    expect(api.refreshInventory).toHaveBeenCalledExactlyOnceWith({
      types: ["microsoft.copilotstudio/agents", "microsoft.powerplatform/environments"], environmentId: "environment-a",
    });
    expect(select).toHaveBeenCalledWith("new-job");
  });

  it("shows denied exact jobs as unavailable rather than substituting history", async () => {
    vi.mocked(api.getInventoryRefreshJob).mockRejectedValue(new Error("This job is unavailable to this account."));
    render(<PowerPlatformSourceJob jobId="private-job" onSelect={vi.fn()} onChanged={vi.fn()} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("This job is unavailable to this account.");
    expect(screen.queryByRole("button", { name: "Resume source job" })).not.toBeInTheDocument();
    expect(screen.queryByText("Unknown")).not.toBeInTheDocument();
  });

  it("does not publish a delayed action after leaving the owning view", async () => {
    vi.mocked(api.getInventoryRefreshJob).mockResolvedValue(job("waiting_authorization"));
    let finish!: (value: api.InventoryRefreshJob) => void;
    vi.mocked(api.resumeInventoryRefresh).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const changed = vi.fn();
    const view = render(<PowerPlatformSourceJob jobId="exact-job" onSelect={vi.fn()} onChanged={changed} />);
    await userEvent.click(await screen.findByRole("button", { name: "Resume source job" }));
    view.unmount();
    await act(async () => finish(job("running")));
    expect(changed).not.toHaveBeenCalled();
  });

  it("retains an action error until explicit reload instead of hiding it with the saved job", async () => {
    vi.mocked(api.getInventoryRefreshJob).mockResolvedValue(job("waiting_authorization"));
    vi.mocked(api.resumeInventoryRefresh).mockRejectedValue(new Error("Current authorization is required."));
    render(<PowerPlatformSourceJob jobId="exact-job" onSelect={vi.fn()} onChanged={vi.fn()} />);
    await userEvent.click(await screen.findByRole("button", { name: "Resume source job" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Current authorization is required.");
    expect(api.getInventoryRefreshJob).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole("button", { name: "Reload source job" }));
    expect(await screen.findByRole("status")).toHaveTextContent("waiting authorization");
    expect(api.getInventoryRefreshJob).toHaveBeenCalledTimes(2);
  });

  it("reloads saved sources when polling observes completion, without launching a refresh", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.mocked(api.getInventoryRefreshJob).mockResolvedValueOnce(job("running")).mockResolvedValue(job("succeeded"));
    const changed = vi.fn();
    render(<PowerPlatformSourceJob jobId="exact-job" onSelect={vi.fn()} onChanged={changed} />);
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("running"));
    expect(changed).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(2500); });
    expect(screen.getByRole("status")).toHaveTextContent("succeeded");
    expect(changed).toHaveBeenCalledTimes(1);
    expect(api.refreshInventory).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(api.getInventoryRefreshJob).toHaveBeenCalledTimes(2);
  });
});
