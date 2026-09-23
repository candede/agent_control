import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "../errors.js";
import { GraphPackagesClient, packageInventoryReadPolicy, type FetchLike } from "./graphPackages.js";
import { scanPackages } from "./packageInventory.js";

const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const value = (id = "package") => ({ id, displayName: id, isBlocked: false });
const throttled = (seconds = "1") => Response.json(
  { error: { code: "UnknownError", message: "Too many requests" } }, { status: 424, headers: { "Retry-After": seconds } },
);

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function pacingEvents() {
  return vi.mocked(console.log).mock.calls.map(([entry]) => JSON.parse(entry))
    .filter(entry => entry.event === "package_provider_pacing_changed");
}

describe("adaptive package read pacing", () => {
  it("backs off repeatedly throttled rates but applies one penalty to a concurrent burst", async () => {
    let attempts = 0;
    const fetcher = vi.fn<FetchLike>(async input => {
      const attempt = ++attempts;
      await wait(10);
      return attempt <= 4 ? throttled() : Response.json(value(new URL(input).pathname.split("/").at(-1)));
    });
    const client = new GraphPackagesClient(fetcher, { ...packageInventoryReadPolicy, delay: wait });
    const reads = Promise.all(["a", "b", "c", "d"].map(id => client.getPackageDetails("token", id)));
    await Promise.all([expect(reads).resolves.toHaveLength(4), vi.runAllTimersAsync()]);
    expect(pacingEvents().map(entry => entry.readIntervalMs)).toEqual([250]);
    expect(fetcher).toHaveBeenCalledTimes(8);

    fetcher.mockResolvedValueOnce(throttled()).mockResolvedValueOnce(Response.json(value()));
    const next = client.getPackageDetails("token", "package");
    await Promise.all([expect(next).resolves.toMatchObject({ id: "package" }), vi.runAllTimersAsync()]);
    expect(pacingEvents().map(entry => entry.readIntervalMs)).toEqual([250, 500]);

    await vi.advanceTimersByTimeAsync(60_000);
    fetcher.mockResolvedValueOnce(Response.json(value()));
    await client.getPackageDetails("token", "package");
    expect(pacingEvents().at(-1)).toMatchObject({ reason: "recovering", readIntervalMs: 400 });
  });

  it("does not retain the four-per-second ceiling after a transient throttle clears", async () => {
    async function collect(adaptivePacing: boolean) {
      const started = performance.now();
      const listed = Array.from({ length: 1_072 }, (_, index) => value(`package-${index}`));
      let throttleCount = 0;
      let calls = 0;
      const fetcher: FetchLike = async input => {
        calls += 1;
        const url = new URL(input);
        await wait(20);
        if (url.pathname.endsWith("/packages")) return Response.json({ value: listed });
        if (!throttleCount) { throttleCount += 1; return throttled(); }
        return Response.json(value(url.pathname.split("/").at(-1)));
      };
      const client = new GraphPackagesClient(fetcher, { ...packageInventoryReadPolicy, adaptivePacing, delay: wait });
      const scan = scanPackages("token", [], new AbortController().signal, async () => undefined, client);
      await Promise.all([expect(scan).resolves.toMatchObject({ totalRecords: 1_072 }), vi.runAllTimersAsync()]);
      return { elapsedMs: performance.now() - started, calls, throttleCount };
    }
    const fixed = await collect(false);
    const adaptive = await collect(true);
    expect(adaptive.calls).toBe(fixed.calls);
    expect(adaptive.throttleCount).toBe(1);
    expect(adaptive.elapsedMs).toBeLessThan(fixed.elapsedMs * 0.9);
  });

  it("allows an inventory throttle to recover after six failures when governed by the job deadline", async () => {
    let attempts = 0;
    const fetcher = vi.fn<FetchLike>(async () => ++attempts <= 8 ? throttled("0") : Response.json(value()));
    const client = new GraphPackagesClient(fetcher, { ...packageInventoryReadPolicy, delay: wait });
    const read = client.getPackageDetails("token", "package", {
      signal: new AbortController().signal, retryThrottlingUntilAborted: true,
    });
    await Promise.all([expect(read).resolves.toMatchObject({ id: "package" }), vi.runAllTimersAsync()]);
    expect(fetcher).toHaveBeenCalledTimes(9);
    await expect(client.getPackageDetails("token", "package", { retryThrottlingUntilAborted: true }))
      .rejects.toMatchObject({ code: "invalid_read_policy" });
    expect(fetcher).toHaveBeenCalledTimes(9);
  });

  it("honors a ten-minute provider Retry-After inside the four-hour inventory job", async () => {
    const fetcher = vi.fn<FetchLike>().mockResolvedValueOnce(throttled("600")).mockResolvedValueOnce(Response.json(value()));
    const client = new GraphPackagesClient(fetcher, { ...packageInventoryReadPolicy, delay: wait });
    const read = client.getPackageDetails("token", "package", { signal: new AbortController().signal });
    await vi.advanceTimersByTimeAsync(599_999);
    expect(fetcher).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    await expect(read).resolves.toMatchObject({ id: "package" });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("still cancels deadline-controlled throttle retries immediately", async () => {
    const fetcher = vi.fn<FetchLike>(async () => throttled("600"));
    const client = new GraphPackagesClient(fetcher, { ...packageInventoryReadPolicy, delay: wait });
    const controller = new AbortController();
    const read = client.getPackageDetails("token", "package", { signal: controller.signal, retryThrottlingUntilAborted: true });
    const stopped = expect(read).rejects.toMatchObject({ code: "read_job_cancelled" });
    await vi.advanceTimersByTimeAsync(1_000);
    controller.abort(new AppError(409, "read_job_cancelled", "Cancelled"));
    await stopped;
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("renews tokens before admission so delayed renewal cannot bypass request pacing", async () => {
    const starts: number[] = [];
    const fetcher = vi.fn<FetchLike>(async (input, init) => {
      starts.push(performance.now());
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer renewed");
      return Response.json(value(new URL(input).pathname.split("/").at(-1)));
    });
    const client = new GraphPackagesClient(fetcher, { ...packageInventoryReadPolicy, minimumReadIntervalMs: 250, delay: wait });
    const getAccessToken = vi.fn(async () => { await wait(1_000); return "renewed"; });
    const reads = Promise.all(["a", "b", "c", "d"].map(id => client.getPackageDetails("expired", id, { getAccessToken })));
    await Promise.all([expect(reads).resolves.toHaveLength(4), vi.runAllTimersAsync()]);
    expect(starts).toEqual([1_000, 1_250, 1_500, 1_750]);
    expect(getAccessToken).toHaveBeenCalledTimes(4);
  });

  it("never dispatches a read after cancellation wins over pending token renewal", async () => {
    let release!: (token: string) => void;
    const getAccessToken = vi.fn(() => new Promise<string>(resolve => { release = resolve; }));
    const fetcher = vi.fn<FetchLike>();
    const client = new GraphPackagesClient(fetcher);
    const controller = new AbortController();
    const read = client.getPackageDetails("expired", "package", { signal: controller.signal, getAccessToken });
    const stopped = expect(read).rejects.toMatchObject({ code: "read_job_cancelled" });
    await vi.advanceTimersByTimeAsync(0);
    controller.abort(new AppError(409, "read_job_cancelled", "Cancelled"));
    await stopped;
    release("late");
    await vi.advanceTimersByTimeAsync(0);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("renews tokens that aged in another request's hour-long cooldown and re-enters pacing", async () => {
    const starts: number[] = [];
    const fetcher = vi.fn<FetchLike>(async (input, init) => {
      starts.push(performance.now());
      expect(new Headers(init?.headers).get("Authorization")).toBe(performance.now() >= 3_600_000 ? "Bearer fresh" : "Bearer initial");
      return starts.length === 1 ? throttled("3600") : Response.json(value(new URL(input).pathname.split("/").at(-1)));
    });
    const client = new GraphPackagesClient(fetcher, { ...packageInventoryReadPolicy, delay: wait });
    const getAccessToken = vi.fn(async () => performance.now() >= 3_600_000 ? "fresh" : "initial");
    const first = client.getPackageDetails("expired", "first", { getAccessToken });
    await vi.advanceTimersByTimeAsync(0);
    const second = client.getPackageDetails("expired", "second", { getAccessToken });
    await Promise.all([expect(Promise.all([first, second])).resolves.toHaveLength(2), vi.runAllTimersAsync()]);
    expect(starts).toHaveLength(3);
    expect(starts[1]).toBeGreaterThanOrEqual(3_600_000);
    expect(starts[2] - starts[1]).toBeGreaterThanOrEqual(250);
    expect(getAccessToken).toHaveBeenCalledTimes(4);
  });
});
