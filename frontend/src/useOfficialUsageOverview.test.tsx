import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as api from "./api/client";
import { usageOverviewFixture } from "./test/usageInsightsFixture";
import { useOfficialUsageOverview } from "./useOfficialUsageOverview";

afterEach(() => vi.restoreAllMocks());

describe("saved overview query freshness", () => {
  it("does not submit invalid date ranges when Retry is requested", async () => {
    const read = vi.spyOn(api, "getOfficialUsageOverview").mockResolvedValue(usageOverviewFixture());
    const { result, rerender } = renderHook(({ startDate, endDate }) => useOfficialUsageOverview({ startDate, endDate }, 0), {
      initialProps: { startDate: "2026-09-20", endDate: "2026-09-01" },
    });
    expect(result.current.error).toBe("The activity start date must be on or before the end date.");
    expect(result.current.loading).toBe(false);
    await act(async () => result.current.retry());
    expect(read).not.toHaveBeenCalled();
    rerender({ startDate: "2026-09-01", endDate: "2026-09-20" });
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(read).toHaveBeenCalledOnce();
  });

  it.each([401, 403])("hides previous private data during revalidation and after a %s response", async status => {
    let rejectRead!: (error: Error) => void;
    const read = vi.spyOn(api, "getOfficialUsageOverview").mockResolvedValueOnce(usageOverviewFixture())
      .mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectRead = reject; }));
    const { result } = renderHook(() => useOfficialUsageOverview({}, 0));
    await waitFor(() => expect(result.current.data).toBeDefined());
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.loading).toBe(true));
    expect(result.current.data).toBeUndefined();
    act(() => rejectRead(new api.ApiError(status, "forbidden", "Access denied")));
    await waitFor(() => expect(result.current.error).toBe("Access denied"));
    expect(result.current.data).toBeUndefined();
    expect(result.current.loading).toBe(false);
    expect(read).toHaveBeenCalledTimes(2);
  });
});
