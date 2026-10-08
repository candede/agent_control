import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, getPackageRefreshTargets, type PackageRefreshJob, type PackageRefreshTargetPage } from "../api/client";
import { createSavedQueryClient } from "../savedQueries";
import { deferred } from "../test/deferred";
import { InventoryRefreshTargets } from "./InventoryRefreshTargets";

vi.mock("../api/client", async original => ({
  ...await original<typeof import("../api/client")>(), getPackageRefreshTargets: vi.fn(),
}));

const job: PackageRefreshJob = {
  id: "job", authorizationPrincipalId: "principal", tokenMode: "delegated", scopeKind: "exact",
  targetCount: 5000, resultRevision: "1", status: "running", pageCount: 0, observedCount: 0,
  totalRecords: 5000, snapshotId: null, createdAt: "2026-10-01", updatedAt: "2026-10-01",
  attemptedAt: null, finishedAt: null,
};
function page(id = "First target", revision = "1", nextCursor: string | null = "next", previousCursor: string | null = null): PackageRefreshTargetPage {
  return { value: [{ id, ordinal: 0, status: "observed_unpublished" }], revision,
    counts: { total: 5000, filtered: 5000 }, page: { limit: 50, nextCursor, previousCursor } };
}
const clients: ReturnType<typeof createSavedQueryClient>[] = [];
function client() {
  const value = createSavedQueryClient();
  clients.push(value);
  return value;
}
beforeEach(() => { vi.mocked(getPackageRefreshTargets).mockReset().mockResolvedValue(page()); });
afterEach(() => { clients.splice(0).forEach(value => value.clear()); });

describe("revision-scoped refresh target paging", () => {
  it("preserves the page across equivalent status renders and reuses visited revision pages", async () => {
    const view = render(<InventoryRefreshTargets job={job} owner="session" />);
    await screen.findByText("First target");
    vi.mocked(getPackageRefreshTargets).mockResolvedValueOnce(page("Second target", "1", null, "previous"));
    await userEvent.click(screen.getByRole("button", { name: "Next targets" }));
    await screen.findByText("Second target");
    view.rerender(<InventoryRefreshTargets job={{ ...job, status: "succeeded", observedCount: 5000 }} owner="session" />);
    act(() => { window.dispatchEvent(new Event("focus")); window.dispatchEvent(new Event("online")); });
    expect(screen.getByText("Second target")).toBeVisible();
    expect(screen.getByRole("heading")).toHaveTextContent("Refresh targets (5,000)");
    await userEvent.click(screen.getByRole("button", { name: "First targets" }));
    expect(await screen.findByText("First target")).toBeVisible();
    expect(getPackageRefreshTargets).toHaveBeenCalledTimes(2);
  });

  it.each(["owner", "mode", "job", "revision"] as const)("resets the cursor and cancels obsolete pages when the %s changes", async boundary => {
    const obsolete = deferred<PackageRefreshTargetPage>(), current = deferred<PackageRefreshTargetPage>();
    const view = render(<InventoryRefreshTargets job={job} owner="session" />);
    await screen.findByText("First target");
    vi.mocked(getPackageRefreshTargets).mockReturnValueOnce(obsolete.promise).mockReturnValueOnce(current.promise);
    await userEvent.click(screen.getByRole("button", { name: "Next targets" }));
    const signal = vi.mocked(getPackageRefreshTargets).mock.calls[1][1]!.signal!;
    const replacement = { ...job, id: boundary === "job" ? "other-job" : job.id,
      tokenMode: boundary === "mode" ? "application" as const : job.tokenMode,
      resultRevision: boundary === "revision" ? "2" : job.resultRevision };
    view.rerender(<InventoryRefreshTargets job={replacement} owner={boundary === "owner" ? "other-session" : "session"} />);
    expect(signal.aborted).toBe(true);
    expect(getPackageRefreshTargets).toHaveBeenLastCalledWith({
      id: replacement.id, tokenMode: replacement.tokenMode, resultRevision: replacement.resultRevision,
    }, expect.objectContaining({ cursor: undefined }));
    expect(screen.getByRole("status")).toHaveTextContent("Loading refresh targets");
    expect(screen.queryByText("First target")).not.toBeInTheDocument();
    await act(async () => obsolete.resolve(page("Retired target")));
    expect(screen.queryByText("Retired target")).not.toBeInTheDocument();
    await act(async () => current.resolve(page("Current target", replacement.resultRevision)));
    expect(await screen.findByText("Current target")).toBeVisible();
    expect(getPackageRefreshTargets).toHaveBeenCalledTimes(3);
  });

  it.each(["success", "error"] as const)("does not revive a retired %s or cursor when returning to an earlier owner", async outcome => {
    const queries = client();
    const abandoned = deferred<PackageRefreshTargetPage>(), returning = deferred<PackageRefreshTargetPage>();
    const panel = (owner: string) => <QueryClientProvider client={queries}><InventoryRefreshTargets job={job} owner={owner} /></QueryClientProvider>;
    const view = render(panel("session"));
    await screen.findByText("First target");
    if (outcome === "success") vi.mocked(getPackageRefreshTargets).mockResolvedValueOnce(page("Retired target"));
    else vi.mocked(getPackageRefreshTargets).mockRejectedValueOnce(new Error("Retired failure"));
    await userEvent.click(screen.getByRole("button", { name: "Next targets" }));
    await screen.findByText(outcome === "success" ? "Retired target" : "Retired failure");
    vi.mocked(getPackageRefreshTargets).mockReturnValueOnce(abandoned.promise).mockReturnValueOnce(returning.promise);
    view.rerender(panel("other-session"));
    const signal = vi.mocked(getPackageRefreshTargets).mock.calls.at(-1)![1]!.signal!;
    queries.removeQueries({ queryKey: ["saved", "inventory-refresh-targets", "session"] });
    view.rerender(panel("session"));
    expect(signal.aborted).toBe(true);
    expect(screen.queryByText("Retired target")).not.toBeInTheDocument();
    expect(screen.queryByText("Retired failure")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry targets" })).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Loading refresh targets");
    expect(getPackageRefreshTargets).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ cursor: undefined }));
    await act(async () => { abandoned.resolve(page("Abandoned target")); returning.resolve(page("Current target")); });
    expect(await screen.findByText("Current target")).toBeVisible();
    expect(screen.queryByText("Abandoned target")).not.toBeInTheDocument();
    expect(getPackageRefreshTargets).toHaveBeenCalledTimes(4);
  });

  it("shares concurrent page reads and only aborts the transport when the final reader leaves", async () => {
    const queries = client(), pending = deferred<PackageRefreshTargetPage>();
    vi.mocked(getPackageRefreshTargets).mockReturnValueOnce(pending.promise);
    const panel = (first: boolean, second: boolean) => <QueryClientProvider client={queries}>
      {first ? <InventoryRefreshTargets key="first" job={job} owner="session" /> : null}
      {second ? <InventoryRefreshTargets key="second" job={job} owner="session" /> : null}
    </QueryClientProvider>;
    const view = render(panel(true, true));
    expect(getPackageRefreshTargets).toHaveBeenCalledOnce();
    const signal = vi.mocked(getPackageRefreshTargets).mock.calls[0][1]!.signal!;
    view.rerender(panel(false, true));
    expect(signal.aborted).toBe(false);
    view.rerender(panel(false, false));
    expect(signal.aborted).toBe(true);
    view.rerender(panel(true, false));
    expect(await screen.findByText("First target")).toBeVisible();
    await act(async () => pending.resolve(page("Cancelled target")));
    expect(screen.queryByText("Cancelled target")).not.toBeInTheDocument();
    expect(getPackageRefreshTargets).toHaveBeenCalledTimes(2);
  });

  it("retries only the failed page once for repeated same-batch clicks, clearing stale errors while loading", async () => {
    const retry = deferred<PackageRefreshTargetPage>();
    const view = render(<InventoryRefreshTargets job={job} owner="session" />);
    await screen.findByText("First target");
    vi.mocked(getPackageRefreshTargets).mockRejectedValueOnce(new Error("Targets unavailable")).mockReturnValueOnce(retry.promise);
    await userEvent.click(screen.getByRole("button", { name: "Next targets" }));
    const button = await screen.findByRole("button", { name: "Retry targets" });
    act(() => { button.click(); button.click(); });
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    expect(screen.getByRole("status")).toHaveTextContent("Loading refresh targets");
    expect(getPackageRefreshTargets).toHaveBeenCalledTimes(3);
    expect(getPackageRefreshTargets).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ cursor: "next" }));
    await act(async () => retry.resolve(page("Recovered target")));
    expect(await screen.findByText("Recovered target")).toBeVisible();
    view.unmount();
  });

  it("revalidates an invalidated cache page without showing previous rows or errors during the read", async () => {
    const queries = client(), update = deferred<PackageRefreshTargetPage>();
    render(<QueryClientProvider client={queries}><InventoryRefreshTargets job={job} owner="session" /></QueryClientProvider>);
    await screen.findByText("First target");
    vi.mocked(getPackageRefreshTargets).mockReturnValueOnce(update.promise);
    act(() => { void queries.invalidateQueries({ queryKey: ["saved", "inventory-refresh-targets"] }); });
    await screen.findByRole("status");
    expect(screen.queryByText("First target")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Next targets" })).toBeDisabled();
    await act(async () => update.reject(new Error("Revalidation failed")));
    expect(await screen.findByRole("alert")).toHaveTextContent("Revalidation failed");
    expect(screen.queryByText("First target")).not.toBeInTheDocument();
    expect(getPackageRefreshTargets).toHaveBeenCalledTimes(2);
  });

  it("retires invalidated revisions instead of retrying their cursors and recovers on a new status revision", async () => {
    const queries = client();
    const panel = (revision: string) => <QueryClientProvider client={queries}>
      <InventoryRefreshTargets job={{ ...job, resultRevision: revision }} owner="session" />
    </QueryClientProvider>;
    const view = render(panel("1"));
    await screen.findByText("First target");
    vi.mocked(getPackageRefreshTargets).mockRejectedValueOnce(new ApiError(409, "selection_invalidated", "Revision changed"));
    await userEvent.click(screen.getByRole("button", { name: "Next targets" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Refresh status to restart target pages");
    expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry targets" })).not.toBeInTheDocument();
    await act(async () => { await queries.invalidateQueries({ queryKey: ["saved", "inventory-refresh-targets"] }); });
    expect(getPackageRefreshTargets).toHaveBeenCalledTimes(2);
    vi.mocked(getPackageRefreshTargets).mockResolvedValueOnce(page("New revision target", "2"));
    view.rerender(panel("2"));
    expect(await screen.findByText("New revision target")).toBeVisible();
    expect(getPackageRefreshTargets).toHaveBeenLastCalledWith(expect.objectContaining({ resultRevision: "2" }),
      expect.objectContaining({ cursor: undefined }));
    expect(getPackageRefreshTargets).toHaveBeenCalledTimes(3);
  });

  it("offers first-page recovery for a rejected cursor and labels empty pages without implying loading", async () => {
    const first = page();
    first.value = [];
    first.page.nextCursor = null;
    const view = render(<InventoryRefreshTargets job={job} owner="session" />);
    await screen.findByText("First target");
    vi.mocked(getPackageRefreshTargets).mockRejectedValueOnce(new ApiError(400, "invalid_cursor", "Cursor unavailable"))
      .mockResolvedValueOnce(page("Recovered first target", "1", "fresh-next"));
    await userEvent.click(screen.getByRole("button", { name: "Next targets" }));
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "First targets" }));
    expect(await screen.findByText("Recovered first target")).toBeVisible();
    expect(getPackageRefreshTargets).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ cursor: undefined }));
    await userEvent.click(screen.getByRole("button", { name: "Next targets" }));
    expect(await screen.findByText("First target")).toBeVisible();
    expect(getPackageRefreshTargets).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ cursor: "fresh-next" }));
    expect(getPackageRefreshTargets).toHaveBeenCalledTimes(4);
    vi.mocked(getPackageRefreshTargets).mockResolvedValueOnce(first);
    view.rerender(<InventoryRefreshTargets job={{ ...job, resultRevision: "2" }} owner="session" />);
    expect(await screen.findByText("No refresh targets on this page.")).toBeVisible();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
