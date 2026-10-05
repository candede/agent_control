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

it("retains the original explicit IDs and supplied key when the caller changes its selection during retry", async () => {
  vi.useFakeTimers();
  vi.mocked(request).mockRejectedValueOnce(new ApiError(0, "network_error", "offline", { kind: "network" }))
    .mockResolvedValueOnce({ id: "export" });
  const ids = ["user-one"];
  const idempotencyKey = "11111111-1111-4111-8111-111111111111";
  const pending = createReportExport({ selectionId: "selection", kind: "official_users", ids, idempotencyKey });
  const first = vi.mocked(request).mock.calls[0][1]?.body;
  ids.splice(0, 1, "user-two");
  await vi.advanceTimersByTimeAsync(2000);
  expect(await pending).toEqual({ id: "export" });
  expect(request).toHaveBeenCalledTimes(2);
  expect(vi.mocked(request).mock.calls[1][1]?.body).toBe(first);
  expect(JSON.parse(String(first))).toEqual({ selectionId: "selection", kind: "official_users", ids: ["user-one"], idempotencyKey });
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

it.each([429, 503])("honors the maximum ten-second Retry-After for HTTP %s", async status => {
  vi.useFakeTimers();
  vi.mocked(request).mockRejectedValueOnce(new ApiError(status, "retry_later", "Retry", { retryAfterSeconds: 10 }))
    .mockResolvedValueOnce({ id: "export" });
  const pending = createReportExport({ selectionId: "selection", kind: "official_users" });
  await vi.advanceTimersByTimeAsync(9999);
  expect(request).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(await pending).toEqual({ id: "export" });
  expect(request).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0);
});

it.each([
  new ApiError(503, "retry_later", "Wait longer", { retryAfterSeconds: 11 }),
  new ApiError(403, "forbidden", "Denied"),
  new ApiError(409, "export_idempotency_conflict", "Changed intent"),
  new ApiError(0, "request_aborted", "Cancelled", { kind: "aborted" }),
  new Error("Unexpected failure"),
])("propagates non-retryable failure $message without scheduling more requests", async error => {
  vi.useFakeTimers();
  vi.mocked(request).mockRejectedValue(error);
  await expect(reportExportStatus("artifact")).rejects.toBe(error);
  expect(request).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
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
  expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(20_000);
  expect(request).toHaveBeenCalledTimes(1);
  vi.mocked(request).mockRejectedValueOnce(new ApiError(409, "selection_invalidated", "Invalidated"));
  await expect(reportExportStatus("artifact")).rejects.toMatchObject({ code: "selection_invalidated" });
  expect(request).toHaveBeenCalledTimes(2);
});
