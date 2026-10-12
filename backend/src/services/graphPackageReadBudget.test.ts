import { afterEach, describe, expect, it, vi } from "vitest";
import { setTimeout as delay } from "node:timers/promises";
import { AppError } from "../errors.js";
import { GraphPackagesClient, graphError, graphErrorTelemetry, graphResponseDiagnostics, packageInventoryReadPolicy, type FetchLike, type PackageReadOptions } from "./graphPackages.js";
import { measureGraphDetails, tinyGraphCatalog } from "./inventoryProviderTestSupport.js";

const throttledResponse = (headers?: ResponseInit["headers"], status = 424) => Response.json({
  error: { code: "UnknownError", message: "Too many requests private-token person@example.invalid" },
}, { status, headers });
const packageResponse = (id = "package") => Response.json({ id, displayName: id, isBlocked: false });
const timerDelay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Graph inventory read budget", () => {
  it("minimizes hostile diagnostic properties without losing validated provider request evidence", () => {
    const requestId = "ABCDEFAB-1111-2222-3333-ABCDEFABCDEF";
    const getter = vi.fn(() => { throw new Error("private evidence accessor"); });
    const details = Object.defineProperties({ httpStatus: 424, correlationId: requestId }, {
      providerErrorCode: { get: getter, enumerable: true }, throttled: { get: getter, enumerable: true },
    });
    const error = new AppError(424, "private_provider_code", "private", details);
    expect(graphErrorTelemetry(error)).toMatchObject({
      errorCode: "graph_http_424", errorKind: "application", status: 424, providerRequestId: requestId,
    });
    expect(getter).not.toHaveBeenCalled();
    for (const correlationId of [requestId + "\n", " " + requestId, requestId + " ", "private-id"]) {
      expect(graphResponseDiagnostics(new AppError(424, "provider_error", "private", { httpStatus: 424, correlationId })))
        .toHaveProperty("requestId", undefined);
    }
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    expect(graphErrorTelemetry(revoked.proxy)).toMatchObject({ errorCode: "provider_error", errorKind: "unexpected" });
    expect(graphResponseDiagnostics(new AppError(424, "provider_error", "private", revoked.proxy))).toBeUndefined();
  });

  it.each(["detail", "catalog"])("requires an actual caller execution deadline for extended %s retries", async operation => {
    const fetcher = vi.fn<FetchLike>();
    const client = new GraphPackagesClient(fetcher);
    const options = { signal: new AbortController().signal, retryThrottlingUntilAborted: true };
    await expect(operation === "detail" ? client.getPackageDetails("token", "package", options)
      : tinyGraphCatalog(client, "token", options)).rejects.toMatchObject({ code: "invalid_read_policy" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each(["token", "preparation", "dispatch fence", "fetch", "body", "retry", "retry progress", "catalog progress", "catalog visit"])(
    "settles non-cooperative %s work under one caller execution budget", async stage => {
      vi.useFakeTimers();
      vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => {
        const controller = new AbortController();
        setTimeout(() => controller.abort(new DOMException("deadline", "TimeoutError")), ms);
        return controller.signal;
      });
      let reject!: (reason: unknown) => void;
      const stalled = new Promise<never>((_done, fail) => { reject = fail; });
      const caller = new AbortController();
      const cancel = vi.fn();
      const options: PackageReadOptions = {
        signal: caller.signal, executionDeadlineAt: Date.now() + 100,
        getAccessToken: stage === "token" ? () => stalled : undefined,
        beforeRequest: stage === "preparation" ? () => stalled : undefined,
        beforeDispatch: stage === "dispatch fence" ? () => stalled : undefined,
        onRetry: stage === "retry progress" ? () => stalled : undefined,
        onProgress: stage === "catalog progress" ? () => stalled : undefined,
      };
      const fetcher = vi.fn<FetchLike>(async () => stage === "fetch" ? stalled
        : stage === "body" ? new Response(new ReadableStream({ cancel }))
        : stage === "retry" || stage === "retry progress" ? throttledResponse({ "Retry-After": "0" }, 429)
        : stage.startsWith("catalog") ? Response.json({ value: [] }) : packageResponse());
      const client = new GraphPackagesClient(fetcher, { delay: () => stalled });
      const result = stage === "catalog visit" ? (async () => {
        for await (const _page of client.catalogPages("token", { ...options, visit: () => stalled })) {}
      })() : stage === "catalog progress" ? tinyGraphCatalog(client, "token", options)
        : client.getPackageDetails("token", "package", options);
      const assertion = expect(result).rejects.toMatchObject({ name: "TimeoutError" });
      await vi.advanceTimersByTimeAsync(100);
      await assertion;
      expect(caller.signal.aborted).toBe(false);
      expect(fetcher).toHaveBeenCalledTimes(["token", "preparation", "dispatch fence", "catalog visit"].includes(stage) ? 0 : 1);
      if (stage === "body") expect(cancel).toHaveBeenCalledOnce();
      if (stage !== "body") reject(new Error("Observed late failure."));
      await vi.advanceTimersByTimeAsync(0);
    },
  );

  it("does not reset the logical deadline across token, preparation and response waits", async () => {
    let elapsed = 0;
    vi.spyOn(AbortSignal, "timeout").mockImplementation(() => new AbortController().signal);
    const fetcher = vi.fn<FetchLike>(async () => {
      elapsed += 10_000;
      return packageResponse();
    });
    await expect(new GraphPackagesClient(fetcher, { now: () => elapsed }).getPackageDetails("token", "package", {
      signal: new AbortController().signal, executionDeadlineAt: Date.now() + 50_000,
      getAccessToken: async () => { elapsed += 25_000; return "renewed"; },
      beforeRequest: async () => { elapsed += 20_000; },
    })).rejects.toMatchObject({ name: "TimeoutError" });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("does not dispatch another attempt after a retry wait overruns an undelivered logical timer", async () => {
    let elapsed = 0;
    vi.spyOn(AbortSignal, "timeout").mockImplementation(() => new AbortController().signal);
    const fetcher = vi.fn<FetchLike>(async () => new Response(null, { status: 503 }));
    const wait = vi.fn(async () => { elapsed = 31_001; });
    await expect(new GraphPackagesClient(fetcher, { maxRetryAfterMs: 1_000, now: () => elapsed, delay: wait })
      .getPackageDetails("token", "package")).rejects.toMatchObject({ code: "provider_timeout" });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(wait).toHaveBeenCalledOnce();
  });

  it("does not retry early when an injected backoff resolves before Retry-After", async () => {
    const started = performance.now();
    const starts: number[] = [];
    const fetcher = vi.fn<FetchLike>(async () => {
      starts.push(performance.now() - started);
      return starts.length === 1 ? throttledResponse({ "Retry-After": "1" }, 429) : packageResponse();
    });
    const wait = vi.fn(async () => undefined);
    await expect(new GraphPackagesClient(fetcher, { delay: wait }).getPackageDetails("token", "package"))
      .resolves.toMatchObject({ id: "package" });
    expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(1_000);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each(["provider_timeout", "provider_network_error"])("does not retry an HTTP denial whose provider code is %s", async code => {
    const fetcher = vi.fn<FetchLike>(async () => Response.json({ error: { code } }, { status: 403 }));
    const wait = vi.fn(async () => undefined);
    await expect(new GraphPackagesClient(fetcher, { delay: wait }).getPackageDetails("token", "package"))
      .rejects.toMatchObject({ status: 403, code });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(wait).not.toHaveBeenCalled();
    expect(graphErrorTelemetry(await graphError(Response.json({ error: { code } }, { status: 403 }))))
      .toMatchObject({ errorCode: "graph_http_403", errorKind: "application", status: 403 });
  });

  it("does not accept a response after thirty elapsed seconds when timeout delivery is delayed", async () => {
    let elapsed = 0;
    vi.spyOn(AbortSignal, "timeout").mockImplementation(() => new AbortController().signal);
    const cancel = vi.fn();
    const fetcher = vi.fn<FetchLike>(async () => {
      elapsed += 30_001;
      return new Response(new ReadableStream({ cancel }));
    });
    await expect(new GraphPackagesClient(fetcher, { maxAttempts: 1, now: () => elapsed })
      .getPackageDetails("token", "package")).rejects.toMatchObject({ code: "provider_timeout" });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("does not accept a parsed body after thirty elapsed seconds when timeout delivery is delayed", async () => {
    let elapsed = 0;
    vi.spyOn(AbortSignal, "timeout").mockImplementation(() => new AbortController().signal);
    const fetcher = vi.fn<FetchLike>(async () => new Response(new ReadableStream({
      pull(controller) {
        elapsed = 30_001;
        controller.enqueue(new TextEncoder().encode(JSON.stringify({ id: "package", displayName: "Package", isBlocked: false })));
        controller.close();
      },
    }, { highWaterMark: 0 })));
    await expect(new GraphPackagesClient(fetcher, { maxAttempts: 1, now: () => elapsed })
      .getPackageDetails("token", "package")).rejects.toMatchObject({ code: "provider_timeout" });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("does not shorten an oversized positive Retry-After into fallback retries", async () => {
    const fetcher = vi.fn<FetchLike>(async () => throttledResponse({ "Retry-After": "9999999999999999999999" }, 429));
    const wait = vi.fn(async () => undefined);
    await expect(new GraphPackagesClient(fetcher, { delay: wait }).getPackageDetails("token", "package"))
      .rejects.toMatchObject({ status: 429 });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(wait).not.toHaveBeenCalled();
  });

  it("honors extended Retry-After through the caller deadline rather than the ordinary wait cap", async () => {
    let elapsed = 0;
    const wait = vi.fn(async (ms: number) => { elapsed += ms; });
    const fetcher = vi.fn<FetchLike>().mockResolvedValueOnce(throttledResponse({ "Retry-After": "120" }, 429))
      .mockResolvedValueOnce(packageResponse());
    await expect(new GraphPackagesClient(fetcher, { maxRetryAfterMs: 1_000, delay: wait, now: () => elapsed })
      .getPackageDetails("token", "package", { signal: new AbortController().signal,
        executionDeadlineAt: Date.now() + 180_000, retryThrottlingUntilAborted: true })).resolves.toMatchObject({ id: "package" });
    expect(wait.mock.calls.map(([ms]) => ms)).toEqual([120_000]);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("does not retry or dispatch when retry-progress persistence rejects", async () => {
    const reason = new AppError(503, "progress_failed", "Progress could not be saved.");
    const fetcher = vi.fn<FetchLike>(async () => throttledResponse({ "Retry-After": "0" }, 429));
    const wait = vi.fn(async () => undefined);
    await expect(new GraphPackagesClient(fetcher, { delay: wait }).getPackageDetails("token", "package", {
      onRetry: async () => { throw reason; },
    })).rejects.toBe(reason);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(wait).not.toHaveBeenCalled();
  });

  it("shares a header-observed cooldown even while the throttled body's caller expires", async () => {
    vi.useFakeTimers();
    vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException("deadline", "TimeoutError")), ms);
      return controller.signal;
    });
    const cancel = vi.fn();
    const starts: number[] = [];
    const fetcher = vi.fn<FetchLike>(async () => {
      starts.push(performance.now());
      return starts.length === 1 ? new Response(new ReadableStream({ cancel }), {
        status: 429, headers: { "Retry-After": "2" },
      }) : packageResponse();
    });
    const client = new GraphPackagesClient(fetcher, { ...packageInventoryReadPolicy, delay: timerDelay });
    const first = client.getPackageDetails("token", "package", {
      signal: new AbortController().signal, executionDeadlineAt: Date.now() + 100,
    });
    const stopped = expect(first).rejects.toMatchObject({ name: "TimeoutError" });
    await vi.advanceTimersByTimeAsync(0);
    const second = client.getPackageDetails("token", "package");
    await vi.advanceTimersByTimeAsync(100);
    await stopped;
    expect(cancel).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1_900);
    await expect(second).resolves.toMatchObject({ id: "package" });
    expect(starts).toEqual([0, 2_000]);
  });

  it.each([1071, 5000])("checks %i healthy exact details with bounded callers and no artificial four-reads-per-second ceiling", async count => {
    vi.useFakeTimers();
    let active = 0;
    let maximumActive = 0;
    let finishedAt = 0;
    const fetcher = vi.fn<FetchLike>(async input => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await timerDelay(50);
      active -= 1;
      finishedAt = performance.now();
      expect(new URL(input).pathname).not.toBe("/v1.0/copilot/admin/catalog/packages");
      return packageResponse(new URL(input).pathname.split("/").at(-1)!);
    });
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(new DOMException("deadline", "TimeoutError")), 15 * 60_000);
    try {
      const client = new GraphPackagesClient(fetcher, { ...packageInventoryReadPolicy, delay: timerDelay });
      const result = measureGraphDetails(client, count, { signal: controller.signal }).finally(() => clearTimeout(deadline));
      const assertion = expect(result).resolves.toEqual({ observedCount: count });
      await Promise.all([assertion, vi.runAllTimersAsync()]);
      expect(fetcher).toHaveBeenCalledTimes(count);
      expect(maximumActive).toBe(4);
      expect(finishedAt).toBeLessThanOrEqual(Math.ceil(count / 4) * 50);
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
    await expect(new GraphPackagesClient(fetcher, { delay: wait, now: () => elapsed }).getPackageDetails("token", "package", { onRetry: progress }))
      .resolves.toMatchObject({ id: "package" });
    expect(wait.mock.calls.map(([ms]) => ms)).toEqual([30_000, 60_000]);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(progress.mock.calls).toEqual([
      [{ attempt: 1, retryDelayMs: 30_000, throttled: true }],
      [{ attempt: 2, retryDelayMs: 60_000, throttled: true }],
    ]);
  });

  it.each([424, 429, 503])("honors a two-minute Retry-After for HTTP %i without shortening it to 30 seconds", async status => {
    let elapsed = 0;
    const wait = vi.fn(async (ms: number) => { elapsed += ms; });
    const fetcher = vi.fn<FetchLike>()
      .mockResolvedValueOnce(throttledResponse({ "Retry-After": "120" }, status))
      .mockResolvedValueOnce(packageResponse());
    await expect(new GraphPackagesClient(fetcher, { delay: wait, now: () => elapsed }).getPackageDetails("token", "package")).resolves.toMatchObject({ id: "package" });
    expect(wait.mock.calls.map(([ms]) => ms)).toEqual([120_000]);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("honors HTTP-date Retry-After and rejects malformed or negative delay values", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-16T14:00:00Z"));
    try {
      const error = await graphError(throttledResponse({ "Retry-After": "Wed, 16 Sep 2026 14:02:00 GMT" }));
      expect(error.details).toMatchObject({ retryAfterMs: 120_000 });
      for (const value of ["-1", "12junk", "1.5", "Tue, 16 Sep 2026 14:02:00 GMT", "Mon, 31 Feb 2026 14:02:00 GMT"]) {
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
    let elapsed = 0;
    const wait = vi.fn(async (ms: number) => { elapsed += ms; });
    const fetcher = vi.fn<FetchLike>(async () => throttledResponse());
    const client = new GraphPackagesClient(fetcher, { ...packageInventoryReadPolicy, throttledReadIntervalMs: 0, delay: wait, now: () => elapsed });
    await expect(client.getPackageDetails("token", "package")).rejects.toMatchObject({ status: 424 });
    expect(fetcher).toHaveBeenCalledTimes(6);
    expect(wait.mock.calls.map(([ms]) => ms)).toEqual([30_000, 60_000, 120_000, 120_000, 120_000]);
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
    expect(wait).toHaveBeenCalledWith(30_000, expect.any(AbortSignal));
    expect(wait.mock.calls[0]![1]!.aborted).toBe(true);
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

  it("checks all 1,010 exact identities under recurring throttling within a bounded caller deadline", async () => {
    vi.useFakeTimers();
    const reads: number[] = [];
    const windows = new Map<number, number>();
    const progress = vi.fn<NonNullable<PackageReadOptions["onRetry"]>>(async () => undefined);
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
      expect(url.pathname).not.toBe("/v1.0/copilot/admin/catalog/packages");
      return packageResponse(url.pathname.split("/").at(-1)!);
    });
    try {
      const client = new GraphPackagesClient(fetcher, { ...packageInventoryReadPolicy, delay: timerDelay });
      const result = measureGraphDetails(client, 1010, { signal: controller.signal, onRetry: progress }).finally(() => clearTimeout(deadline));
      const assertion = expect(result).resolves.toEqual({ observedCount: 1010 });
      await vi.runAllTimersAsync();
      await assertion;
      const pacedReads = reads.filter(at => at >= 30_000);
      expect(pacedReads.length).toBeGreaterThan(0);
      expect(pacedReads.every((at, index) => index === 0 || at - pacedReads[index - 1]! >= packageInventoryReadPolicy.throttledReadIntervalMs)).toBe(true);
      expect(reads.at(-1)).toBeLessThan(15 * 60_000);
      expect(fetcher.mock.calls.length).toBeGreaterThan(1010);
      expect(progress.mock.calls.some(([notice]) => notice.throttled)).toBe(true);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });
});
