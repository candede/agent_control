import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GraphPackagesClient, packageInventoryReadPolicy, type FetchLike } from "./graphPackages.js";
import { scanPackages } from "./packageInventory.js";
import { allowlistedPackage } from "./packageObservation.js";
import { PackageScanDiagnostics } from "./packageScanDiagnostics.js";
import { withTelemetryContext } from "./telemetry.js";

const timerDelay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const rawPackage = (id = "private-package") => ({ id, displayName: "private-name", isBlocked: false });
const elements = (definition = "private-definition") => [
  { elementType: "DeclarativeAgent", elements: [{ id: "private-element", definition }] },
];

function entries(event: string): Record<string, unknown>[] {
  return [...vi.mocked(console.log).mock.calls, ...vi.mocked(console.warn).mock.calls, ...vi.mocked(console.error).mock.calls]
    .map(([entry]) => JSON.parse(entry)).filter(entry => entry.event === event);
}

function expectPrivateValuesAbsent() {
  const logs = JSON.stringify([...vi.mocked(console.log).mock.calls, ...vi.mocked(console.warn).mock.calls, ...vi.mocked(console.error).mock.calls]);
  expect(logs).not.toMatch(/private-|person@example/);
}

describe("package scan diagnostics", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each([
    ["elementDetails", [], elements(), "private-invalid"],
    ["longDescription", "", "private-description", { value: "private-invalid" }],
  ])("distinguishes missing, null, empty, populated and invalid raw %s fields", (field, empty, populated, invalid) => {
    const diagnostics = new PackageScanDiagnostics("broad");
    diagnostics.catalogPage([{}, { [field]: null }, { [field]: empty }, { [field]: populated }, { [field]: invalid }], 1, false, 50);
    expect(entries("package_catalog_field_coverage").find(entry => entry.field === field)).toMatchObject({
      page: 1, field, count: 5, missingCount: 1, nullCount: 1, emptyCount: 1, nonemptyCount: 1, invalidCount: 1,
    });
    expectPrivateValuesAbsent();
  });

  it("does not equate absent details with empty fields or hide fields missing from a detail GET", () => {
    const diagnostics = new PackageScanDiagnostics("broad");
    const missing = allowlistedPackage(rawPackage());
    const empty = allowlistedPackage({ ...rawPackage(), elementDetails: [] });
    const first = allowlistedPackage({ ...rawPackage(), elementDetails: elements() });
    const changed = allowlistedPackage({ ...rawPackage(), elementDetails: elements("private-changed") });
    for (const [summary, detail] of [[missing, missing], [empty, missing], [missing, empty], [empty, empty], [first, changed]]) {
      diagnostics.compareDetail(summary, detail);
    }
    diagnostics.finish("collected");
    expect(entries("package_detail_comparison").find(entry => entry.field === "elementDetails")).toMatchObject({
      count: 5, matchingCount: 1, differingCount: 1, listOnlyCount: 1, detailOnlyCount: 1, bothMissingCount: 1,
    });
    expect(entries("package_detail_comparison").find(entry => entry.field === "categories")).toMatchObject({
      count: 5, matchingCount: 0, bothMissingCount: 5,
    });
    expect(entries("package_detail_comparison").find(entry => entry.field === "retained_observation")).toMatchObject({
      count: 5, matchingCount: 2, differingCount: 3,
    });
    expectPrivateValuesAbsent();
  });

  it("compares all retained fields, not just the extended detail fields", () => {
    const diagnostics = new PackageScanDiagnostics("broad");
    diagnostics.compareDetail(
      allowlistedPackage({ ...rawPackage(), appId: "private-before", isBlocked: false }),
      allowlistedPackage({ ...rawPackage(), appId: "private-after", isBlocked: true }),
    );
    diagnostics.finish("collected");
    expect(entries("package_detail_comparison").find(entry => entry.field === "retained_observation")).toMatchObject({
      count: 1, matchingCount: 0, differingCount: 1,
    });
    expectPrivateValuesAbsent();
  });

  it("logs actual page sizes and every successful pre-merge comparison without adding or skipping reads", async () => {
    const extended = {
      elementDetails: elements(), longDescription: "private-long-description", categories: ["private-category"],
      sensitivity: "private-sensitivity", allowedUsersAndGroups: [{ resourceId: "private-user", resourceType: "user" }],
      acquireUsersAndGroups: [{ resourceId: "private-group", resourceType: "group" }],
    };
    const listed = [
      { ...rawPackage("private-first"), ...extended, "@odata.type": "#microsoft.graph.copilotPackageDetail" },
      { ...rawPackage("private-second"), longDescription: null, "@odata.type": "#microsoft.graph.copilotPackage" },
      { ...rawPackage("private-third"), ...extended, elementDetails: [], "@odata.type": "private-provider-type" },
    ];
    const details = listed.map(value => ({ ...value, ...extended, privateUnknownProperty: "person@example.invalid" }));
    const next = "https://graph.microsoft.com/v1.0/copilot/admin/catalog/packages?next=private-continuation";
    const fetcher = vi.fn<FetchLike>(async input => {
      const url = new URL(input);
      if (url.pathname.endsWith("/packages")) {
        return Response.json(url.searchParams.has("next") ? { value: listed.slice(2) } : { value: listed.slice(0, 2), "@odata.nextLink": next });
      }
      const detail = details.find(value => url.pathname.endsWith(`/${value.id}`));
      if (!detail) throw new Error("Unexpected test request.");
      return Response.json(detail);
    });
    const progress = vi.fn(async () => undefined);
    const result = await withTelemetryContext({ jobId: "job-diagnostics" }, () =>
      scanPackages("private-token", [], new AbortController().signal, progress, new GraphPackagesClient(fetcher, packageInventoryReadPolicy)));
    expect(fetcher).toHaveBeenCalledTimes(5);
    expect(result.packages.map(value => value.id)).toEqual(listed.map(value => value.id));
    expect(result.packages.every(value => value.identityDetailsCollected && value.elementDetails?.length === 1)).toBe(true);
    expect(result).toMatchObject({ pages: 2, totalRecords: 3 });
    expect(progress).toHaveBeenLastCalledWith(2, 3, 3, "Matching agent records (3/3 identities checked).");
    expect(entries("package_catalog_page")).toMatchObject([
      { jobId: "job-diagnostics", page: 1, pageSize: 2, observedCount: 2, hasContinuation: true },
      { jobId: "job-diagnostics", page: 2, pageSize: 1, observedCount: 3, hasContinuation: false },
    ]);
    expect(entries("package_catalog_field_coverage").filter(entry => entry.field === "elementDetails")).toMatchObject([
      { page: 1, count: 2, missingCount: 1, nonemptyCount: 1, emptyCount: 0 },
      { page: 2, count: 1, missingCount: 0, nonemptyCount: 0, emptyCount: 1 },
    ]);
    expect(entries("package_catalog_field_coverage").find(entry => entry.field === "longDescription" && entry.page === 1))
      .toMatchObject({ count: 2, nullCount: 1, nonemptyCount: 1, missingCount: 0 });
    expect(entries("package_catalog_response_type")).toMatchObject([
      { actualType: "detail", count: 1 }, { actualType: "summary", count: 1 }, { actualType: "other", count: 1 },
    ]);
    expect(entries("package_detail_comparison").find(entry => entry.field === "elementDetails")).toMatchObject({
      count: 3, matchingCount: 1, differingCount: 1, detailOnlyCount: 1, listOnlyCount: 0, bothMissingCount: 0,
    });
    expect(entries("package_detail_comparison").find(entry => entry.field === "retained_observation")).toMatchObject({
      count: 3, matchingCount: 1, differingCount: 2,
    });
    expect(entries("package_scan_summary")).toMatchObject([
      { jobId: "job-diagnostics", stage: "catalog", outcome: "collected", requestCount: 2, retryCount: 0, count: 3 },
      { jobId: "job-diagnostics", stage: "identity", outcome: "collected", requestCount: 3, retryCount: 0, count: 3, observedCount: 3 },
    ]);
    expectPrivateValuesAbsent();
  });

  it.each(["broad", "exact"] as const)("attributes reads of the native ID 'packages' to identity metrics in a %s scan", async mode => {
    let detailAttempts = 0;
    const fetcher = vi.fn<FetchLike>(async input => {
      await timerDelay(20);
      if (new URL(input).pathname === "/v1.0/copilot/admin/catalog/packages") {
        return Response.json({ value: [rawPackage("packages")] });
      }
      if (detailAttempts++ === 0) {
        return Response.json({ error: { code: "TooManyRequests", message: "private-message" } },
          { status: 429, headers: { "Retry-After": "1" } });
      }
      return Response.json(rawPackage("packages"));
    });
    const scan = scanPackages("private-token", mode === "broad" ? [] : ["packages"],
      new AbortController().signal, async () => undefined,
      new GraphPackagesClient(fetcher, { ...packageInventoryReadPolicy, delay: timerDelay }));
    await Promise.all([expect(scan).resolves.toMatchObject({ totalRecords: 1 }), vi.runAllTimersAsync()]);
    expect(fetcher).toHaveBeenCalledTimes(mode === "broad" ? 3 : 2);
    expect(entries("package_scan_summary").filter(entry => entry.stage === "catalog")).toMatchObject(mode === "broad"
      ? [{ requestCount: 1, retryCount: 0, throttleCount: 0, requestDurationMs: 20 }] : []);
    expect(entries("package_scan_summary").find(entry => entry.stage === "identity")).toMatchObject({
      mode, outcome: "collected", count: 1, observedCount: 1, totalRecords: 1,
      requestCount: 2, retryCount: 1, throttleCount: 1, requestDurationMs: 40,
      maxRequestDurationMs: 20, retryWaitMs: 1_000, readIntervalMs: 250,
    });
    expect(entries("package_provider_read_retry")).toMatchObject([{ stage: "identity", retryDelayMs: 1_000 }]);
    expect(entries("package_provider_pacing_changed")).toMatchObject([{ stage: "identity", reason: "throttled" }]);
    expectPrivateValuesAbsent();
  });

  it("keeps accepted trailing-slash continuation reads in the catalog stage", async () => {
    const next = "https://graph.microsoft.com/v1.0/copilot/admin/catalog/packages/?next=private-continuation";
    const fetcher = vi.fn<FetchLike>(async input => {
      await timerDelay(20);
      return Response.json(new URL(input).searchParams.has("next") ? { value: [] } : { value: [], "@odata.nextLink": next });
    });
    const scan = scanPackages("private-token", [], new AbortController().signal, async () => undefined,
      new GraphPackagesClient(fetcher, packageInventoryReadPolicy));
    await Promise.all([expect(scan).resolves.toMatchObject({ packages: [], pages: 2, totalRecords: 0 }), vi.runAllTimersAsync()]);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[1][0]).toBe(next);
    expect(entries("package_scan_summary")).toMatchObject([
      { stage: "catalog", outcome: "collected", pages: 2, count: 0, requestCount: 2, requestDurationMs: 40 },
      { stage: "identity", outcome: "collected", totalRecords: 0, count: 0, requestCount: 0, requestDurationMs: 0 },
    ]);
    expectPrivateValuesAbsent();
  });

  it.each([
    { header: "2", retryDelayMs: 2_000, retryDelaySource: "retry_after" },
    { header: undefined, retryDelayMs: 30_000, retryDelaySource: "fallback" },
  ])("separates request time, shared admission and actual backoff ($retryDelaySource)", async ({ header, retryDelayMs, retryDelaySource }) => {
    let firstAttempts = 0;
    const fetcher = vi.fn<FetchLike>(async input => {
      await timerDelay(20);
      const first = new URL(input).pathname.endsWith("/private-first");
      if (first && firstAttempts++ === 0) {
        return Response.json({ error: { code: "UnknownError", message: "Too many requests private-message person@example.invalid" } },
          { status: 424, headers: header === undefined ? undefined : { "Retry-After": header } });
      }
      return Response.json(rawPackage(first ? "private-first" : "private-second"));
    });
    const client = new GraphPackagesClient(fetcher, { ...packageInventoryReadPolicy, adaptivePacing: false, minimumReadIntervalMs: 250, delay: timerDelay });
    const scan = scanPackages("private-token", ["private-first", "private-second"], new AbortController().signal, async () => undefined, client);
    await Promise.all([expect(scan).resolves.toMatchObject({ totalRecords: 2 }), vi.runAllTimersAsync()]);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(entries("package_scan_summary")).toMatchObject([{
      stage: "identity", outcome: "collected", mode: "exact", count: 2, observedCount: 2,
      requestCount: 3, retryCount: 1, throttleCount: 1, requestDurationMs: 60, maxRequestDurationMs: 20,
      admissionWaitMs: retryDelayMs + 270, retryWaitMs: retryDelayMs, durationMs: retryDelayMs + 290, readIntervalMs: 250,
    }]);
    expect(entries("package_provider_read_retry")).toMatchObject([{ retryDelaySource, retryDelayMs, readIntervalMs: 250 }]);
    if (header === undefined) expect(entries("package_provider_read_retry")[0]).not.toHaveProperty("retryAfterMs");
    else expect(entries("package_provider_read_retry")[0]).toHaveProperty("retryAfterMs", 2_000);
    expect(entries("package_detail_comparison")).toHaveLength(0);
    expectPrivateValuesAbsent();
  });

  it.each([["AbortError", "cancelled"], ["TimeoutError", "timed_out"]])("flushes partial metrics for %s without swallowing cancellation", async (reason, outcome) => {
    const fetcher = vi.fn<FetchLike>(async () => {
      await timerDelay(20);
      return Response.json({ error: { code: "Unavailable", message: "private-error" } }, { status: 503 });
    });
    const controller = new AbortController();
    const error = new DOMException("private-abort-reason", reason);
    const scan = scanPackages("private-token", [], controller.signal, async () => undefined,
      new GraphPackagesClient(fetcher, { ...packageInventoryReadPolicy, delay: timerDelay }));
    const assertion = expect(scan).rejects.toBe(error);
    await vi.advanceTimersByTimeAsync(120);
    controller.abort(error);
    await assertion;
    expect(fetcher).toHaveBeenCalledOnce();
    expect(entries("package_scan_summary")).toMatchObject([{
      stage: "catalog", outcome, count: 0, requestCount: 1, retryCount: 0,
      requestDurationMs: 20, retryWaitMs: 100, durationMs: 120,
    }]);
    expect(entries("package_scan_summary")[0]).not.toHaveProperty("totalRecords");
    expectPrivateValuesAbsent();
  });

  it("preserves terminal schema failures and logs raw type evidence rather than successful empty data", async () => {
    const fetcher = vi.fn<FetchLike>(async () => Response.json({ value: [{ ...rawPackage(), elementDetails: "private-invalid" }] }));
    await expect(scanPackages("private-token", [], new AbortController().signal, async () => undefined, new GraphPackagesClient(fetcher)))
      .rejects.toMatchObject({ code: "provider_schema" });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(entries("package_catalog_field_coverage").find(entry => entry.field === "elementDetails")).toMatchObject({ invalidCount: 1 });
    expect(entries("package_scan_summary")).toMatchObject([{ stage: "catalog", outcome: "failed", requestCount: 1 }]);
    expect(entries("package_detail_comparison")).toHaveLength(0);
    expectPrivateValuesAbsent();
  });

  it("flushes partial detail comparisons on a terminal read failure without classifying it as user cancellation", async () => {
    const fetcher = vi.fn<FetchLike>(async input => {
      const url = new URL(input);
      if (url.pathname.endsWith("/packages")) return Response.json({ value: [rawPackage("private-first"), rawPackage("private-second")] });
      const first = url.pathname.endsWith("/private-first");
      await timerDelay(first ? 10 : 20);
      return first ? Response.json(rawPackage("private-first"))
        : Response.json({ error: { code: "AccessDenied", message: "private-message" } }, { status: 403 });
    });
    const scan = scanPackages("private-token", [], new AbortController().signal, async () => undefined, new GraphPackagesClient(fetcher));
    await Promise.all([expect(scan).rejects.toMatchObject({ status: 403 }), vi.runAllTimersAsync()]);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(entries("package_scan_summary").find(entry => entry.stage === "identity")).toMatchObject({
      outcome: "failed", count: 1, observedCount: 1, totalRecords: 2,
      requestCount: 2, retryCount: 0, requestDurationMs: 30, durationMs: 20,
    });
    expect(entries("package_detail_comparison").find(entry => entry.field === "retained_observation")).toMatchObject({
      outcome: "failed", count: 1, matchingCount: 1, differingCount: 0,
    });
    expectPrivateValuesAbsent();
  });

  it("counts a 404 as a completed absence, not a successful detail comparison", async () => {
    const fetcher = vi.fn<FetchLike>()
      .mockResolvedValueOnce(Response.json({ value: [rawPackage()] }))
      .mockResolvedValueOnce(Response.json({ error: { code: "NotFound", message: "private-message" } }, { status: 404 }));
    await expect(scanPackages("private-token", [], new AbortController().signal, async () => undefined, new GraphPackagesClient(fetcher)))
      .resolves.toMatchObject({ packages: [], totalRecords: 0, pages: 1 });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(entries("package_scan_summary").find(entry => entry.stage === "identity")).toMatchObject({
      outcome: "collected", totalRecords: 1, count: 1, observedCount: 0, requestCount: 1,
    });
    expect(entries("package_detail_comparison")).toHaveLength(0);
    expectPrivateValuesAbsent();
  });

  it("keeps overlapping scans' counters and job correlations separate on a shared client", async () => {
    const fetcher = vi.fn<FetchLike>(async input => {
      const first = new URL(input).pathname.endsWith("/private-first");
      await timerDelay(first ? 50 : 1);
      return Response.json(rawPackage(first ? "private-first" : "private-second"));
    });
    const client = new GraphPackagesClient(fetcher, packageInventoryReadPolicy);
    const first = withTelemetryContext({ jobId: "job-first" }, () =>
      scanPackages("private-token", ["private-first"], new AbortController().signal, async () => undefined, client));
    const second = withTelemetryContext({ jobId: "job-second" }, () =>
      scanPackages("private-token", ["private-second"], new AbortController().signal, async () => undefined, client));
    await Promise.all([expect(Promise.all([first, second])).resolves.toHaveLength(2), vi.runAllTimersAsync()]);
    expect(entries("package_scan_summary")).toMatchObject([
      { jobId: "job-second", requestCount: 1, requestDurationMs: 1, count: 1 },
      { jobId: "job-first", requestCount: 1, requestDurationMs: 50, count: 1 },
    ]);
    expectPrivateValuesAbsent();
  });

  it("bounds progress logging to one event per 100 checks rather than per-package success logs", () => {
    const diagnostics = new PackageScanDiagnostics("broad");
    diagnostics.startDetails(5_000);
    for (let index = 0; index < 5_000; index += 1) diagnostics.completeDetail(true);
    diagnostics.finish("collected");
    expect(entries("package_scan_progress")).toHaveLength(50);
    expect(entries("package_scan_progress").at(-1)).toMatchObject({ count: 5_000, totalRecords: 5_000, observedCount: 5_000 });
    expect(vi.mocked(console.log)).toHaveBeenCalledTimes(52);
  });
});
