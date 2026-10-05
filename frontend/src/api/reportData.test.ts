import { afterEach, expect, it, vi } from "vitest";
import { ApiError, request } from "./client";
import { cancelReportExport, createReportExport, reportExportStatus } from "./reportData";

vi.mock("./client", async original => ({ ...await original<typeof import("./client")>(), request: vi.fn() }));
afterEach(() => { vi.useRealTimers(); vi.mocked(request).mockReset(); });

it("retries setup with one immutable key, honoring the SQL conflict Retry-After", async () => {
  vi.useFakeTimers();
  vi.mocked(request).mockRejectedValueOnce(new ApiError(503, "data_snapshot_conflict", "Retry", { retryAfterSeconds: 5 }))
    .mockResolvedValueOnce({ id: "export" });
  const pending = createReportExport({ selectionId: "selection", kind: "official_users" });
  await vi.advanceTimersByTimeAsync(4999);
  expect(request).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(await pending).toEqual({ id: "export" });
  expect(request).toHaveBeenCalledTimes(2);
  const first = vi.mocked(request).mock.calls[0][1]?.body;
  expect(vi.mocked(request).mock.calls[1][1]?.body).toBe(first);
  expect(JSON.parse(String(first))).toMatchObject({ idempotencyKey: expect.stringMatching(/^[a-f0-9-]{36}$/) });
});

it("bounds cancellation retries and never recreates an artifact", async () => {
  vi.useFakeTimers();
  vi.mocked(request).mockRejectedValue(new ApiError(0, "network_error", "offline", { kind: "network" }));
  const pending = cancelReportExport("artifact");
  const rejected = expect(pending).rejects.toThrow("offline");
  await vi.advanceTimersByTimeAsync(30_000);
  await rejected;
  expect(request).toHaveBeenCalledTimes(3);
  expect(vi.mocked(request).mock.calls.every(([path]) => path === "/api/data-exports/artifact")).toBe(true);
});

it("aborts polling retry waits immediately on logout and does not retry invalidation", async () => {
  vi.useFakeTimers();
  const controller = new AbortController();
  vi.mocked(request).mockRejectedValueOnce(new ApiError(0, "network_error", "offline", { kind: "network" }));
  const pending = reportExportStatus("artifact", controller.signal);
  const rejected = expect(pending).rejects.toMatchObject({ code: "request_aborted", kind: "aborted" });
  await vi.advanceTimersByTimeAsync(1);
  controller.abort(new Error("logout"));
  await rejected;
  await vi.advanceTimersByTimeAsync(20_000);
  expect(request).toHaveBeenCalledTimes(1);
  vi.mocked(request).mockRejectedValueOnce(new ApiError(409, "selection_invalidated", "Invalidated"));
  await expect(reportExportStatus("artifact")).rejects.toMatchObject({ code: "selection_invalidated" });
  expect(request).toHaveBeenCalledTimes(2);
});
