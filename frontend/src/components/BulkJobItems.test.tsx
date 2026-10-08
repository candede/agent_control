import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getBulkActionJobItems, type BulkActionJob, type BulkJobItemPage } from "../api/client";
import { createSavedQueryClient, readSavedQuery } from "../savedQueries";
import { deferred } from "../test/deferred";
import { BulkJobItems } from "./BulkJobItems";

vi.mock("../api/client", async original => ({
  ...await original<typeof import("../api/client")>(), getBulkActionJobItems: vi.fn(),
}));

const job: BulkActionJob = {
  id: "job", action: "block", targetBlockedState: true, status: "partial", canResume: false,
  total: 100, completed: 100, succeeded: 99, failed: 1, skipped: 0, inconclusive: 0,
  cancelled: 0, queued: 0, reconciliationRequired: 0, retryEligible: 0, resultRevision: "1",
  createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z",
};

function page(name = "First result", revision = "1", nextCursor: string | null = "next", previousCursor: string | null = null): BulkJobItemPage {
  return {
    value: [{ id: name, displayName: name, status: "succeeded" }], revision,
    counts: { total: 100, filtered: 100 }, page: { limit: 50, nextCursor, previousCursor },
  };
}

const clients: ReturnType<typeof createSavedQueryClient>[] = [];
function client() {
  const value = createSavedQueryClient();
  clients.push(value);
  return value;
}

beforeEach(() => { vi.mocked(getBulkActionJobItems).mockReset().mockResolvedValue(page()); });
afterEach(() => { clients.splice(0).forEach(value => value.clear()); });

describe("revision-scoped package result paging", () => {
  it("preserves the selected page without another read when only job status changes", async () => {
    const view = render(<BulkJobItems job={job} owner="session" />);
    await screen.findByText("First result");
    vi.mocked(getBulkActionJobItems).mockResolvedValueOnce(page("Second result", "1", null, "previous"));
    await userEvent.click(screen.getByRole("button", { name: "Next results" }));
    await screen.findByText("Second result");
    view.rerender(<BulkJobItems job={{ ...job, status: "succeeded", updatedAt: "2026-10-01T01:00:00Z" }} owner="session" />);
    expect(screen.getByText("Second result")).toBeVisible();
    expect(getBulkActionJobItems).toHaveBeenCalledTimes(2);
  });

  it("restarts changed revisions without announcing a loaded first page before it arrives", async () => {
    const obsolete = deferred<BulkJobItemPage>();
    const current = deferred<BulkJobItemPage>();
    const view = render(<BulkJobItems job={job} owner="session" />);
    await screen.findByText("First result");
    vi.mocked(getBulkActionJobItems).mockReturnValueOnce(obsolete.promise).mockReturnValueOnce(current.promise);
    await userEvent.click(screen.getByRole("button", { name: "Next results" }));
    const signal = vi.mocked(getBulkActionJobItems).mock.calls[1][2]!.signal!;
    view.rerender(<BulkJobItems job={{ ...job, resultRevision: "2" }} owner="session" />);
    expect(signal.aborted).toBe(true);
    expect(getBulkActionJobItems).toHaveBeenLastCalledWith("job", { revision: "2", cursor: undefined }, expect.anything());
    expect(screen.queryByText("Job results changed; showing the first result page.")).not.toBeInTheDocument();
    expect(screen.getByText("Loading job results…")).toBeVisible();
    await act(async () => obsolete.resolve(page("Obsolete second page")));
    expect(screen.queryByText("Obsolete second page")).not.toBeInTheDocument();
    await act(async () => current.resolve(page("Current first page", "2")));
    expect(screen.getByText("Current first page")).toBeVisible();
    expect(screen.getByText("Job results changed; showing the first result page.")).toBeVisible();
  });

  it.each([
    ["owner", "error"], ["owner", "success"], ["job", "error"],
    ["job", "success"], ["revision", "error"], ["revision", "success"],
  ] as const)("does not revive a retired %s %s while a returning identity is loading", async (boundary, outcome) => {
    const queries = client();
    const abandoned = deferred<BulkJobItemPage>();
    const returning = deferred<BulkJobItemPage>();
    if (outcome === "error") vi.mocked(getBulkActionJobItems).mockRejectedValueOnce(new Error("Retired error"));
    else vi.mocked(getBulkActionJobItems).mockResolvedValueOnce(page("Retired result"));
    vi.mocked(getBulkActionJobItems).mockReturnValueOnce(abandoned.promise).mockReturnValueOnce(returning.promise);
    const renderPanel = (changed: boolean) => <QueryClientProvider client={queries}>
      <BulkJobItems owner={changed && boundary === "owner" ? "other-session" : "session"}
        job={changed ? { ...job, id: boundary === "job" ? "other-job" : job.id,
          resultRevision: boundary === "revision" ? "2" : "1" } : job} />
    </QueryClientProvider>;
    const view = render(renderPanel(false));
    await screen.findByText(outcome === "error" ? "Retired error" : "Retired result");
    view.rerender(renderPanel(true));
    await waitFor(() => expect(getBulkActionJobItems).toHaveBeenCalledTimes(2));
    const signal = vi.mocked(getBulkActionJobItems).mock.calls[1][2]!.signal!;
    // A retired page can be evicted before this identity is visited again.
    queries.removeQueries({ queryKey: ["saved", "bulk-job-items", "session", job.id, "1", undefined], exact: true });
    view.rerender(renderPanel(false));
    expect(signal.aborted).toBe(true);
    expect(screen.queryByText("Retired error")).not.toBeInTheDocument();
    expect(screen.queryByText("Retired result")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry results" })).not.toBeInTheDocument();
    expect(screen.getByText("Loading job results…")).toBeVisible();
    await act(async () => {
      abandoned.resolve(page("Abandoned response"));
      returning.resolve(page("Current result"));
    });
    expect(screen.getByText("Current result")).toBeVisible();
    expect(screen.queryByText("Abandoned response")).not.toBeInTheDocument();
    expect(getBulkActionJobItems).toHaveBeenCalledTimes(3);
  });

  it("pauses and labels result reads during status recovery, discarding late cancelled responses", async () => {
    const obsolete = deferred<BulkJobItemPage>();
    vi.mocked(getBulkActionJobItems).mockReturnValueOnce(obsolete.promise);
    const view = render(<BulkJobItems job={job} owner="session" />);
    await waitFor(() => expect(getBulkActionJobItems).toHaveBeenCalledOnce());
    const signal = vi.mocked(getBulkActionJobItems).mock.calls[0][2]!.signal!;
    view.rerender(<BulkJobItems job={job} owner="session" refreshing />);
    expect(signal.aborted).toBe(true);
    expect(screen.getByText("Checking job status before loading results…")).toBeVisible();
    expect(screen.queryByText("Loading job results…")).not.toBeInTheDocument();
    await act(async () => obsolete.resolve(page("Cancelled response")));
    expect(screen.queryByText("Cancelled response")).not.toBeInTheDocument();
    expect(getBulkActionJobItems).toHaveBeenCalledOnce();
    view.rerender(<BulkJobItems job={job} owner="session" />);
    expect(await screen.findByText("First result")).toBeVisible();
    expect(getBulkActionJobItems).toHaveBeenCalledTimes(2);
  });

  it("reuses a completed page after an unchanged status refresh instead of reloading it", async () => {
    const view = render(<BulkJobItems job={job} owner="session" />);
    await screen.findByText("First result");
    vi.mocked(getBulkActionJobItems).mockResolvedValueOnce(page("Second result", "1", null, "previous"));
    await userEvent.click(screen.getByRole("button", { name: "Next results" }));
    await screen.findByText("Second result");
    view.rerender(<BulkJobItems job={job} owner="session" refreshing />);
    expect(screen.queryByText("Second result")).not.toBeInTheDocument();
    view.rerender(<BulkJobItems job={job} owner="session" />);
    expect(await screen.findByText("Second result")).toBeVisible();
    expect(getBulkActionJobItems).toHaveBeenCalledTimes(2);
  });

  it("leaves a shared follower read alive when status recovery pauses the panel", async () => {
    const queries = client();
    const response = deferred<BulkJobItemPage>();
    vi.mocked(getBulkActionJobItems).mockReturnValueOnce(response.promise);
    const follower = readSavedQuery(queries, ["bulk-job-items", "session", job.id, "1", undefined],
      signal => getBulkActionJobItems(job.id, { revision: "1" }, { signal }), new AbortController().signal,
      { staleTime: Infinity, gcTime: 60_000 });
    const renderPanel = (refreshing: boolean) => <QueryClientProvider client={queries}>
      <BulkJobItems job={job} owner="session" refreshing={refreshing} />
    </QueryClientProvider>;
    const view = render(renderPanel(false));
    expect(getBulkActionJobItems).toHaveBeenCalledOnce();
    const signal = vi.mocked(getBulkActionJobItems).mock.calls[0][2]!.signal!;
    view.rerender(renderPanel(true));
    expect(signal.aborted).toBe(false);
    await act(async () => response.resolve(page()));
    await expect(follower).resolves.toEqual(page());
    expect(screen.queryByText("First result")).not.toBeInTheDocument();
    view.rerender(renderPanel(false));
    expect(await screen.findByText("First result")).toBeVisible();
    expect(getBulkActionJobItems).toHaveBeenCalledOnce();
  });
});
