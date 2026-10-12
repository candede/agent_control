// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import { ApiError, request } from "./client";
import { cancelReportExport, createReportExport, mutateAgentReportAssociation, normalizeReportSearch, previewReportBundle, reportExportStatus, stageReport } from "./reportData";
import type { CandidateAgentUsageMutation } from "../../../backend/src/types/officialReportApi";

vi.mock("./client", async original => ({ ...await original<typeof import("./client")>(), request: vi.fn() }));
afterEach(() => { vi.useRealTimers(); vi.mocked(request).mockReset(); });

it("omits absent upload metadata but retains explicit blank assertions for server validation", async () => {
  const file = new File(["CSV"], "users.csv", { type: "text/csv" }), signal = new AbortController().signal;
  await stageReport(file, { bundleId: "owned-bundle", rejectDuplicateKind: true }, {
    reportingStart: undefined, downloadedAt: "", sourceAsOf: "", sourceAsOfProvenance: "operator_asserted",
  }, signal);
  const [path, init] = vi.mocked(request).mock.calls[0];
  expect(path).toBe("/api/official-usage/staging?bundleId=owned-bundle&rejectDuplicateKind=true");
  expect(init).toMatchObject({ method: "POST", signal });
  const body = init!.body;
  expect(body).toBeInstanceOf(FormData);
  expect(Array.from((body as FormData).entries())).toEqual([
    ["downloadedAt", ""], ["sourceAsOf", ""], ["sourceAsOfProvenance", "operator_asserted"], ["file", file],
  ]);
});

it("sends exact association and removal shapes without losing an explicit null environment", async () => {
  const input: CandidateAgentUsageMutation = {
    selectionId: "abcdefab-1234-4567-89ab-abcdefabcdef", reportSetId: "fedcbafe-1234-4567-89ab-fedcbafedcba",
    usageRevision: "a".repeat(64), inventoryRevision: "b".repeat(64), reportAgentId: "Exact/Report-ID", confirmed: true,
  };
  const targets: CandidateAgentUsageMutation["target"][] = [
    { source: "graph_packages", packageId: "ABCDEFAB-1234-4567-89AB-ABCDEFABCDEF" },
    { source: "power_platform", nativeId: "Exact/Native-ID", environmentId: null },
    { source: "power_platform", nativeId: "ABCDEFAB-1234-4567-89AB-ABCDEFABCDEF", environmentId: "Default-ABCDEFAB-1234-4567-89AB-ABCDEFABCDEF" },
  ];
  const recordId = "graph_packages:Exact%2FPackage-ID", signal = new AbortController().signal;
  for (const target of targets) {
    await mutateAgentReportAssociation(recordId, { ...input, target }, "associate", signal);
    expect(request).toHaveBeenLastCalledWith(`/api/agent-inventory/${encodeURIComponent(recordId)}/usage-associations`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...input, target }), signal,
    });
  }
  await mutateAgentReportAssociation(recordId, input, "remove", signal, input.selectionId);
  expect(request).toHaveBeenLastCalledWith(
    `/api/agent-inventory/${encodeURIComponent(recordId)}/usage-associations?inventorySelectionId=${input.selectionId}`, {
      method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input), signal,
    });
});

it.each([
  [" Researcher ", "researcher"],
  [" ＹＯＵＲ　ＯＲＧ ", "your org"],
  ["\u0130", "i\u0307"],
  ["A\u030A", "å"],
  ["J\u030C", "\u01f0"],
  ["", ""],
])("normalizes report search %j consistently with the server", (value, normalized) => {
  expect(normalizeReportSearch(value)).toBe(normalized);
});

it.each([false, true])("uses an explicit cleanup inspection only for cancellation (%s)", async forDiscard => {
  vi.mocked(request).mockResolvedValue({});
  const signal = new AbortController().signal;
  await previewReportBundle("owned-bundle", signal, forDiscard ? { forDiscard: true } : undefined);
  expect(request).toHaveBeenCalledExactlyOnceWith("/api/official-usage/bundles/owned-bundle/preview", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(forDiscard ? { forDiscard: true } : {}), signal,
  });
});

const operations = [
  { name: "admission", send: (signal: AbortSignal) => createReportExport({ selectionId: "selection", kind: "official_users" }, signal) },
  { name: "status", send: (signal: AbortSignal) => reportExportStatus("artifact", signal) },
  { name: "cancellation", send: (signal: AbortSignal) => cancelReportExport("artifact", signal) },
];

it.each(operations)("does not send an already-aborted $name request", async ({ send }) => {
  vi.useFakeTimers();
  const controller = new AbortController();
  controller.abort();
  await expect(send(controller.signal)).rejects.toMatchObject({ code: "request_aborted", kind: "aborted" });
  expect(request).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it.each(operations)("immediately cancels $name backoff without another request", async ({ send }) => {
  vi.useFakeTimers();
  vi.mocked(request).mockRejectedValue(new ApiError(503, "data_snapshot_conflict", "Retry", { retryAfterSeconds: 5 }));
  const controller = new AbortController();
  const pending = send(controller.signal);
  const rejected = expect(pending).rejects.toMatchObject({ code: "request_aborted", kind: "aborted" });
  await vi.advanceTimersByTimeAsync(1);
  controller.abort();
  await rejected;
  expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(request).toHaveBeenCalledOnce();
  expect(vi.mocked(request).mock.calls[0][1]?.signal).toBe(controller.signal);
});

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
