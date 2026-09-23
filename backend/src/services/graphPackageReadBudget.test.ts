import { describe, expect, it, vi } from "vitest";
import { setTimeout as delay } from "node:timers/promises";
import { AppError } from "../errors.js";
import { GraphPackagesClient, graphError, graphErrorTelemetry, packageInventoryReadPolicy, type FetchLike } from "./graphPackages.js";
import { scanPackages } from "./packageInventory.js";

const throttledResponse = (headers?: ResponseInit["headers"], status = 424) => Response.json({
  error: { code: "UnknownError", message: "Too many requests private-token person@example.invalid" },
}, { status, headers });
const packageResponse = (id = "package") => Response.json({ id, displayName: id, isBlocked: false });
const timerDelay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

describe("Graph inventory read budget", () => {
  it.each([1071, 5000])("collects %i healthy package details without an artificial four-reads-per-second ceiling", async count => {
    vi.useFakeTimers();
    const listed = Array.from({ length: count }, (_, index) => ({ id: `package-${index}`, displayName: `Agent ${index}`, isBlocked: false }));
    let active = 0;
    let maximumActive = 0;
    let finishedAt = 0;
    const fetcher = vi.fn<FetchLike>(async input => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await timerDelay(50);
      active -= 1;
      finishedAt = performance.now();
      return new URL(input).pathname.endsWith("/packages")
        ? Response.json({ value: listed }) : packageResponse(new URL(input).pathname.split("/").at(-1)!);
    });
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(new DOMException("deadline", "TimeoutError")), 15 * 60_000);
    try {
      const client = new GraphPackagesClient(fetcher, { ...packageInventoryReadPolicy, delay: timerDelay });
      const result = scanPackages("token", [], controller.signal, async () => undefined, client).finally(() => clearTimeout(deadline));
      const assertion = expect(result).resolves.toMatchObject({ totalRecords: count, pages: 1 });
      await Promise.all([assertion, vi.runAllTimersAsync()]);
      expect((await result).packages.map(value => value.id)).toEqual(listed.map(value => value.id));
      expect(fetcher).toHaveBeenCalledTimes(count + 1);
      expect(maximumActive).toBe(4);
      expect(finishedAt).toBeLessThanOrEqual(50 + Math.ceil(count / 4) * 50);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("identifies the observed wrapped throttle without exposing the provider message", async () => {
    const error = await graphError(throttledResponse());
    expect(error.details).toMatchObject({ httpStatus: 424, providerErrorCode: "UnknownError", throttled: true });
    expect(graphErrorTelemetry(error)).toMatchObject({ errorCode: "graph_http_424", status: 424, outcome: "throttled" });
    expect(error.message).toBe("Microsoft Graph request failed with status 424.");
    expect(JSON.stringify(error)).not.toMatch(/private-token|person@/);
  });

  it("waits out a one-minute provider cooldown instead of exhausting retries in six seconds", async () => {
    let elapsed = 0;
    const wait = vi.fn(async (ms: number) => { elapsed += ms; });
    const fetcher = vi.fn<FetchLike>(async () => elapsed < 60_000 ? throttledResponse() : packageResponse());
    const progress = vi.fn();
    await expect(new GraphPackagesClient(fetcher, { delay: wait }).getPackageDetails("token", "package", { onRetry: progress }))
      .resolves.toMatchObject({ id: "package" });
    expect(wait.mock.calls).toEqual([[30_000], [60_000]]);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(progress.mock.calls).toEqual([
      [{ attempt: 1, retryDelayMs: 30_000, throttled: true }],
      [{ attempt: 2, retryDelayMs: 60_000, throttled: true }],
    ]);
  });

  it.each([424, 429, 503])("honors a two-minute Retry-After for HTTP %i without shortening it to 30 seconds", async status => {
    const wait = vi.fn(async () => undefined);
    const fetcher = vi.fn<FetchLike>()
      .mockResolvedValueOnce(throttledResponse({ "Retry-After": "120" }, status))
      .mockResolvedValueOnce(packageResponse());
    await expect(new GraphPackagesClient(fetcher, { delay: wait }).getPackageDetails("token", "package")).resolves.toMatchObject({ id: "package" });
    expect(wait.mock.calls).toEqual([[120_000]]);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("honors HTTP-date Retry-After and rejects malformed or negative delay values", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-16T14:00:00Z"));
    try {
      const error = await graphError(throttledResponse({ "Retry-After": "Wed, 16 Sep 2026 14:02:00 GMT" }));
      expect(error.details).toMatchObject({ retryAfterMs: 120_000 });
      for (const value of ["-1", "12junk", "1.5", "9999999999999999999999"]) {
        expect((await graphError(throttledResponse({ "Retry-After": value }))).details).toMatchObject({ retryAfterMs: undefined });
      }
    } finally { vi.useRealTimers(); }
  });

  it("fails rather than retrying before a provider cooldown beyond the supported wait budget", async () => {
    const fetcher = vi.fn<FetchLike>(async () => throttledResponse({ "Retry-After": "600" }));
    const wait = vi.fn(async () => undefined);
    await expect(new GraphPackagesClient(fetcher, { delay: wait }).getPackageDetails("token", "package"))
      .rejects.toMatchObject({ status: 424, code: "UnknownError" });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(wait).not.toHaveBeenCalled();
  });

  it("does not retry a non-throttling 424 or replay a mutation", async () => {
    const fetcher = vi.fn<FetchLike>()
      .mockResolvedValueOnce(Response.json({ error: { code: "UnknownError", message: "Dependency failed" } }, { status: 424 }))
      .mockResolvedValueOnce(throttledResponse());
    const wait = vi.fn(async () => undefined);
    const client = new GraphPackagesClient(fetcher, { ...packageInventoryReadPolicy, throttledReadIntervalMs: 0, delay: wait });
    await expect(client.getPackageDetails("token", "package")).rejects.toMatchObject({ status: 424 });
    await expect(client.blockPackage("token", "package")).rejects.toMatchObject({ status: 424 });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(wait).not.toHaveBeenCalled();
  });

  it("bounds persistent inventory throttling to six attempts, without increasing other read retries", async () => {
    const wait = vi.fn(async () => undefined);
    const fetcher = vi.fn<FetchLike>(async () => throttledResponse());
    const client = new GraphPackagesClient(fetcher, { ...packageInventoryReadPolicy, throttledReadIntervalMs: 0, delay: wait });
    await expect(client.getPackageDetails("token", "package")).rejects.toMatchObject({ status: 424 });
    expect(fetcher).toHaveBeenCalledTimes(6);
    expect(wait.mock.calls).toEqual([[30_000], [60_000], [120_000], [120_000], [120_000]]);
    fetcher.mockClear().mockImplementation(async () => Response.json({ error: { code: "InternalServerError" } }, { status: 500 }));
    await expect(client.getPackageDetails("token", "package")).rejects.toMatchObject({ status: 500 });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("shares cooldown and pacing across callers while allowing an independently queued read to cancel", async () => {
    vi.useFakeTimers();
    const reads: { id: string; at: number }[] = [];
    const fetcher = vi.fn<FetchLike>(async input => {
      const id = new URL(input).pathname.split("/").at(-1)!;
      reads.push({ id, at: performance.now() });
      return reads.length === 1 ? throttledResponse() : packageResponse(id);
    });
    try {
      const client = new GraphPackagesClient(fetcher, { ...packageInventoryReadPolicy, delay: timerDelay });
      const first = client.getPackageDetails("token-a", "first");
      await vi.advanceTimersByTimeAsync(0);
      const second = client.getPackageDetails("token-b", "second");
      const controller = new AbortController();
      const cancelled = client.getPackageDetails("token-c", "cancelled", { signal: controller.signal });
      const cancellation = expect(cancelled).rejects.toMatchObject({ code: "read_job_cancelled" });
      controller.abort(new AppError(409, "read_job_cancelled", "Cancelled"));
      await cancellation;
      await vi.advanceTimersByTimeAsync(29_999);
      expect(reads).toEqual([{ id: "first", at: 0 }]);
      await vi.advanceTimersByTimeAsync(1_001);
      await expect(Promise.all([first, second])).resolves.toMatchObject([{ id: "first" }, { id: "second" }]);
      expect(reads).toEqual([{ id: "first", at: 0 }, { id: "second", at: 30_000 }, { id: "first", at: 30_250 }]);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("stops a throttled read immediately at the caller's overall deadline", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const fetcher = vi.fn<FetchLike>(async () => throttledResponse());
    try {
      const client = new GraphPackagesClient(fetcher, { ...packageInventoryReadPolicy, delay: timerDelay });
      const result = client.getPackageDetails("token", "package", { signal: controller.signal });
      const assertion = expect(result).rejects.toMatchObject({ name: "TimeoutError" });
      setTimeout(() => controller.abort(new DOMException("deadline", "TimeoutError")), 5_000);
      await vi.advanceTimersByTimeAsync(5_000);
      await assertion;
      expect(fetcher).toHaveBeenCalledOnce();
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("passes cancellation to the backoff timer rather than leaving it alive after the read ends", async () => {
    const controller = new AbortController();
    const timerRejected = vi.fn();
    const wait = vi.fn((ms: number, signal?: AbortSignal) => {
      const timer = delay(ms, undefined, { signal });
      void timer.catch(timerRejected);
      return timer;
    });
    const client = new GraphPackagesClient(async () => throttledResponse(), { delay: wait });
    const result = client.getPackageDetails("token", "package", { signal: controller.signal });
    const assertion = expect(result).rejects.toMatchObject({ code: "read_job_cancelled" });
    await vi.waitFor(() => expect(wait).toHaveBeenCalledOnce());
    controller.abort(new AppError(409, "read_job_cancelled", "Cancelled"));
    await assertion;
    expect(wait).toHaveBeenCalledWith(30_000, controller.signal);
    await vi.waitFor(() => expect(timerRejected).toHaveBeenCalledWith(expect.objectContaining({ name: "AbortError" })));
  });

  it("shares an over-budget cooldown without repeatedly extending it for queued callers", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<FetchLike>()
      .mockResolvedValueOnce(throttledResponse({ "Retry-After": "15000" }))
      .mockResolvedValueOnce(packageResponse());
    try {
      const client = new GraphPackagesClient(fetcher, { ...packageInventoryReadPolicy, delay: timerDelay });
      await expect(client.getPackageDetails("token", "package")).rejects.toMatchObject({ status: 424 });
      await vi.advanceTimersByTimeAsync(100_000);
      await expect(client.getPackageDetails("token", "package")).rejects.toMatchObject({ status: 424 });
      expect(fetcher).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(14_900_001);
      await expect(client.getPackageDetails("token", "package")).resolves.toMatchObject({ id: "package" });
      expect(fetcher).toHaveBeenCalledTimes(2);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("completes all 1,010 identities under recurring throttling within the full-job deadline", async () => {
    vi.useFakeTimers();
    const listed = Array.from({ length: 1010 }, (_, index) => ({ id: `package-${index}`, displayName: `Agent ${index}`, isBlocked: false }));
    const reads: number[] = [];
    const windows = new Map<number, number>();
    const progress = vi.fn<Parameters<typeof scanPackages>[3]>(async () => undefined);
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(new DOMException("deadline", "TimeoutError")), 15 * 60_000);
    const fetcher = vi.fn<FetchLike>(async input => {
      const at = performance.now();
      reads.push(at);
      const window = Math.floor(at / 60_000);
      const count = (windows.get(window) ?? 0) + 1;
      windows.set(window, count);
      if (count > 144) return throttledResponse();
      const url = new URL(input);
      if (url.pathname.endsWith("/packages")) return Response.json(url.searchParams.has("page")
        ? { value: listed.slice(500) }
        : { value: listed.slice(0, 500), "@odata.nextLink": "https://graph.microsoft.com/v1.0/copilot/admin/catalog/packages?page=2" });
      return packageResponse(url.pathname.split("/").at(-1)!);
    });
    try {
      const client = new GraphPackagesClient(fetcher, { ...packageInventoryReadPolicy, delay: timerDelay });
      const result = scanPackages("token", [], controller.signal, progress, client).finally(() => clearTimeout(deadline));
      const assertion = expect(result).resolves.toMatchObject({ totalRecords: 1010, pages: 2 });
      await vi.runAllTimersAsync();
      await assertion;
      const completed = await result;
      expect(completed.packages.map(value => value.id)).toEqual(listed.map(value => value.id));
      expect(completed.packages.every(value => value.identityDetailsCollected === true)).toBe(true);
      const pacedReads = reads.filter(at => at >= 30_000);
      expect(pacedReads.length).toBeGreaterThan(0);
      expect(pacedReads.every((at, index) => index === 0 || at - pacedReads[index - 1]! >= packageInventoryReadPolicy.throttledReadIntervalMs)).toBe(true);
      expect(reads.at(-1)).toBeLessThan(15 * 60_000);
      expect(fetcher.mock.calls.length).toBeGreaterThan(1012);
      expect(progress.mock.calls.some(call => call[3]?.includes("Microsoft Graph is throttling"))).toBe(true);
      expect(progress).toHaveBeenLastCalledWith(2, 1010, 1010, "Matching agent records (1010/1010 identities checked).");
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });
});
