import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReportOverviewAgent, ReportPage } from "../../backend/src/types/officialReportData";
import * as api from "./api/reportData";
import { ApiError } from "./api/client";
import { reportPage, selectionId } from "./test/reportDataFixture";
import { deferred } from "./test/deferred";
import { useOfficialUsageOverview } from "./useOfficialUsageOverview";

vi.mock("./api/reportData", async original => ({ ...await original<typeof import("./api/reportData")>(), readReportPage: vi.fn() }));
const page = reportPage<ReportOverviewAgent>([]);
beforeEach(() => { vi.mocked(api.readReportPage).mockResolvedValue(page); });
afterEach(() => { cleanup(); vi.resetAllMocks(); });

describe("selected overview query freshness", () => {
  it("separates selected-set and history queries, aborting the previous read without draining history pages", async () => {
    const { result, rerender } = renderHook(({ scope }: { scope: "selected" | "history" }) => useOfficialUsageOverview({ scope }, 0), {
      initialProps: { scope: "selected" as "selected" | "history" },
    });
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(api.readReportPage).toHaveBeenLastCalledWith("official-usage/overview", expect.objectContaining({ scope: "selected", limit: 50 }), expect.any(AbortSignal));
    rerender({ scope: "history" });
    await waitFor(() => expect(api.readReportPage).toHaveBeenCalledTimes(2));
    expect(api.readReportPage).toHaveBeenLastCalledWith("official-usage/overview", expect.objectContaining({ scope: "history" }), expect.any(AbortSignal));
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
  it("pins passive revision reads and requires an explicit restart after history invalidation", async () => {
    const { result, rerender } = renderHook(({ revision }) => useOfficialUsageOverview({ scope: "history" }, revision), { initialProps: { revision: 0 } });
    await waitFor(() => expect(result.current.data).toBeDefined());
    vi.mocked(api.readReportPage).mockRejectedValueOnce(new ApiError(409, "selection_invalidated", "History changed"));
    rerender({ revision: 1 });
    await waitFor(() => expect(result.current.invalidated).toBe(true));
    expect(result.current.data).toBeUndefined();
    expect(api.readReportPage).toHaveBeenLastCalledWith("official-usage/overview", expect.objectContaining({ selectionId }), expect.any(AbortSignal));
    act(() => result.current.restart());
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(api.readReportPage).toHaveBeenLastCalledWith("official-usage/overview", expect.not.objectContaining({ selectionId }), expect.any(AbortSignal));
  });
});
