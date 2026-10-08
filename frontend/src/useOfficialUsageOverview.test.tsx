import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReportOverviewAgent, ReportPage } from "../../backend/src/types/officialReportData";
import * as api from "./api/reportData";
import { ApiError } from "./api/client";
import { createSavedQueryClient } from "./savedQueries";
import { overviewPage, reportSelection, selectionId } from "./test/reportDataFixture";
import { deferred } from "./test/deferred";
import { useOfficialUsageOverview } from "./useOfficialUsageOverview";

vi.mock("./api/reportData", async original => ({ ...await original<typeof import("./api/reportData")>(), readReportPage: vi.fn() }));
const clients: ReturnType<typeof createSavedQueryClient>[] = [];
function sharedQueries() {
  const client = createSavedQueryClient();
  clients.push(client);
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}
let page: ReportPage<ReportOverviewAgent>;
beforeEach(() => { page = overviewPage(); vi.mocked(api.readReportPage).mockResolvedValue(page); });
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()); vi.resetAllMocks(); });

describe("selected overview query freshness", () => {
  it.each(["resolve", "reject"] as const)("aborts replaced scope reads and ignores their late %s without draining history pages", async outcome => {
    const previous = deferred<ReportPage<ReportOverviewAgent>>(), replacement = deferred<ReportPage<ReportOverviewAgent>>();
    vi.mocked(api.readReportPage).mockReturnValueOnce(previous.promise).mockReturnValueOnce(replacement.promise);
    const { result, rerender } = renderHook(({ scope }: { scope: "selected" | "history" }) => useOfficialUsageOverview({ scope }, 0), {
      initialProps: { scope: "selected" as "selected" | "history" },
    });
    expect(api.readReportPage).toHaveBeenLastCalledWith("official-usage/overview", expect.objectContaining({ scope: "selected", limit: 50 }), expect.any(AbortSignal));
    const signal = vi.mocked(api.readReportPage).mock.lastCall?.[2];
    rerender({ scope: "history" });
    expect(signal?.aborted).toBe(true);
    expect(result.current.data).toBeUndefined();
    expect(result.current.loading).toBe(true);
    expect(api.readReportPage).toHaveBeenCalledTimes(2);
    expect(api.readReportPage).toHaveBeenLastCalledWith("official-usage/overview", expect.objectContaining({ scope: "history" }), expect.any(AbortSignal));
    const latest = overviewPage({ selection: reportSelection(3), filters: { scope: "history" } });
    await act(async () => replacement.resolve(latest));
    await waitFor(() => expect(result.current.data).toEqual(latest));
    await act(async () => {
      if (outcome === "resolve") previous.resolve(page);
      else previous.reject(new ApiError(409, "selection_invalidated", "Old scope expired"));
    });
    expect(result.current.data).toEqual(latest);
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
    expect(api.readReportPage).toHaveBeenCalledTimes(2);
  });
  it.each(["idle", "initial", "retry"] as const)("withdraws a rejected immutable selection across revisions (state=%s)", async state => {
    const pending = deferred<ReportPage<ReportOverviewAgent>>();
    if (state === "initial") vi.mocked(api.readReportPage).mockReturnValueOnce(pending.promise);
    const { result } = renderHook(() => ({
      previous: useOfficialUsageOverview({ scope: "selected", selectionId }, 0),
      current: useOfficialUsageOverview({ scope: "selected", selectionId }, 1),
    }), { wrapper: sharedQueries() });
    await waitFor(() => expect(result.current.current.data).toBeDefined());
    if (state !== "initial") await waitFor(() => expect(result.current.previous.data).toBeDefined());
    expect(api.readReportPage).toHaveBeenCalledTimes(2);
    let signal = state === "initial" ? vi.mocked(api.readReportPage).mock.calls[0][2] : undefined;
    if (state === "retry") {
      vi.mocked(api.readReportPage).mockReturnValueOnce(pending.promise);
      act(() => result.current.previous.retry());
      signal = vi.mocked(api.readReportPage).mock.lastCall?.[2];
    }
    act(() => result.current.current.invalidateSelection());
    await waitFor(() => expect(result.current.previous.invalidated).toBe(true));
    if (state !== "idle") expect(signal?.aborted).toBe(true);
    expect(result.current.previous.data).toBeUndefined();
    expect(result.current.previous.loading).toBe(false);
    expect(result.current.current.data).toBeUndefined();
    expect(result.current.current.invalidated).toBe(true);
    if (state !== "idle") await act(async () => pending.resolve(page));
    act(() => {
      result.current.previous.retry();
      window.dispatchEvent(new Event("focus"));
    });
    expect(result.current.previous.data).toBeUndefined();
    expect(api.readReportPage).toHaveBeenCalledTimes(state === "retry" ? 3 : 2);
  });
  it.each(["idle", "initial", "retry"] as const)("withdraws peer evidence when the server rejects its selection at another revision (state=%s)", async state => {
    const pending = deferred<ReportPage<ReportOverviewAgent>>();
    const rejection = deferred<ReportPage<ReportOverviewAgent>>();
    if (state === "initial") vi.mocked(api.readReportPage).mockReturnValueOnce(pending.promise);
    else vi.mocked(api.readReportPage).mockResolvedValueOnce(page);
    vi.mocked(api.readReportPage).mockReturnValueOnce(rejection.promise);
    const { result } = renderHook(() => ({
      previous: useOfficialUsageOverview({ scope: "selected", selectionId }, 0),
      current: useOfficialUsageOverview({ scope: "selected", selectionId }, 1),
    }), { wrapper: sharedQueries() });
    if (state !== "initial") await waitFor(() => expect(result.current.previous.data).toBeDefined());
    let signal = state === "initial" ? vi.mocked(api.readReportPage).mock.calls[0][2] : undefined;
    if (state === "retry") {
      vi.mocked(api.readReportPage).mockReturnValueOnce(pending.promise);
      act(() => result.current.previous.retry());
      signal = vi.mocked(api.readReportPage).mock.lastCall?.[2];
    }
    await act(async () => rejection.reject(new ApiError(409, "selection_invalidated", "Selection deleted")));
    await waitFor(() => expect(result.current.current.invalidated).toBe(true));
    await waitFor(() => expect(result.current.previous.invalidated).toBe(true));
    if (state !== "idle") expect(signal?.aborted).toBe(true);
    expect(result.current.previous.data).toBeUndefined();
    expect(result.current.previous.loading).toBe(false);
    if (state !== "idle") await act(async () => pending.resolve(page));
    act(() => {
      result.current.previous.retry();
      window.dispatchEvent(new Event("focus"));
    });
    expect(result.current.previous.data).toBeUndefined();
    expect(result.current.previous.invalidated).toBe(true);
    expect(api.readReportPage).toHaveBeenCalledTimes(state === "retry" ? 3 : 2);
  });
  it("ignores a cancelled revision's late selection rejection after the replacement validates", async () => {
    const pending = deferred<ReportPage<ReportOverviewAgent>>();
    vi.mocked(api.readReportPage).mockReturnValueOnce(pending.promise);
    const { result, rerender } = renderHook(({ revision }) =>
      useOfficialUsageOverview({ scope: "selected", selectionId }, revision), {
      wrapper: sharedQueries(), initialProps: { revision: 0 },
    });
    const signal = vi.mocked(api.readReportPage).mock.lastCall?.[2];
    rerender({ revision: 1 });
    expect(signal?.aborted).toBe(true);
    await waitFor(() => expect(result.current.data).toEqual(page));
    await act(async () => pending.reject(new ApiError(409, "selection_invalidated", "Abandoned selection")));
    expect(result.current.data).toEqual(page);
    expect(result.current.invalidated).toBe(false);
    expect(result.current.error).toBeNull();
    expect(api.readReportPage).toHaveBeenCalledTimes(2);
  });
  it("does not withdraw a peer's newer capture when the server rejects the original selection", async () => {
    const { result } = renderHook(() => ({
      original: useOfficialUsageOverview({ scope: "selected" }, 0),
      current: useOfficialUsageOverview({ scope: "selected" }, 0),
    }), { wrapper: sharedQueries() });
    await waitFor(() => expect(result.current.original.data).toEqual(page));
    const replacement = overviewPage({ selection: reportSelection(3) });
    vi.mocked(api.readReportPage).mockResolvedValueOnce(replacement);
    act(() => result.current.current.restart());
    await waitFor(() => expect(result.current.current.data).toEqual(replacement));
    vi.mocked(api.readReportPage).mockRejectedValueOnce(new ApiError(409, "selection_invalidated", "Original selection deleted"))
      .mockResolvedValueOnce(overviewPage({ selection: reportSelection(4) }));
    act(() => result.current.original.retry());
    await waitFor(() => expect(result.current.original.invalidated).toBe(true));
    expect(api.readReportPage).toHaveBeenCalledTimes(3);
    act(() => result.current.original.restart());
    await waitFor(() => expect(result.current.original.data?.selection.id).toBe(reportSelection(4).id));
    expect(result.current.current.data).toEqual(replacement);
    expect(result.current.current.invalidated).toBe(false);
    expect(result.current.current.loading).toBe(false);
    expect(api.readReportPage).toHaveBeenCalledTimes(4);
  });
  it("never submits invalid date ranges even when Retry is called directly", async () => {
    const { result, rerender } = renderHook(({ startDate, endDate }) => useOfficialUsageOverview({ startDate, endDate }, 0), {
      initialProps: { startDate: "2026-09-20", endDate: "2026-09-01" },
    });
    expect(result.current.validation).toBe("The activity start date must be on or before the end date.");
    expect(result.current.loading).toBe(false);
    await act(async () => result.current.retry());
    expect(api.readReportPage).not.toHaveBeenCalled();
    rerender({ startDate: "2026-09-01", endDate: "2026-09-20" });
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(api.readReportPage).toHaveBeenCalledOnce();
  });
  it.each([401, 403])("hides private data during an explicit retry and after status %s", async status => {
    const pending = deferred<ReportPage<ReportOverviewAgent>>();
    vi.mocked(api.readReportPage).mockResolvedValueOnce(page).mockReturnValueOnce(pending.promise);
    const { result } = renderHook(() => useOfficialUsageOverview({}, 0));
    await waitFor(() => expect(result.current.data).toBeDefined());
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.loading).toBe(true));
    expect(result.current.data).toBeUndefined();
    await act(async () => pending.reject(new ApiError(status, "forbidden", "Access denied")));
    await waitFor(() => expect(result.current.error?.message).toBe("Access denied"));
    expect(result.current.data).toBeUndefined();
    expect(result.current.loading).toBe(false);
    expect(api.readReportPage).toHaveBeenLastCalledWith("official-usage/overview", expect.objectContaining({ selectionId }), expect.any(AbortSignal));
  });
  it("recaptures history on a known revision but requires explicit replacement after invalidation", async () => {
    const { result, rerender } = renderHook(({ revision }) => useOfficialUsageOverview({ scope: "history" }, revision), { initialProps: { revision: 0 } });
    await waitFor(() => expect(result.current.data).toBeDefined());
    const replacement = deferred<ReportPage<ReportOverviewAgent>>();
    vi.mocked(api.readReportPage).mockRejectedValueOnce(new ApiError(409, "selection_invalidated", "History changed"));
    vi.mocked(api.readReportPage).mockReturnValueOnce(replacement.promise);
    rerender({ revision: 1 });
    await waitFor(() => expect(result.current.invalidated).toBe(true));
    expect(api.readReportPage).toHaveBeenCalledTimes(2);
    act(() => result.current.restart());
    await waitFor(() => expect(api.readReportPage).toHaveBeenCalledTimes(3));
    expect(result.current.data).toBeUndefined();
    expect(result.current.loading).toBe(true);
    for (const call of vi.mocked(api.readReportPage).mock.calls.slice(1)) {
      expect(call[1]).toEqual({ scope: "history", limit: 50 });
    }
    const latest = overviewPage({ selection: reportSelection(3), filters: { scope: "history" } });
    await act(async () => replacement.resolve(latest));
    await waitFor(() => expect(result.current.data).toEqual(latest));
    expect(result.current.invalidated).toBe(false);
    expect(api.readReportPage).toHaveBeenCalledTimes(3);
  });
});
