import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CapacityTelemetry, parseGcNvp, transientHeapProbe } from "./capacityTelemetry.js";
import { observePeakMemory, peakCheckpoint } from "../src/services/peakMemory.js";

const io = vi.hoisted(() => ({
  nextFd: 10, contents: new Map<number, Buffer[]>(),
  close: vi.fn(), read: vi.fn(() => { throw new Error("No cgroup access in unit tests."); }),
  write: vi.fn((fd: number, value: string | Buffer, offset = 0, length?: number) => {
    const bytes = typeof value === "string" ? Buffer.from(value) : value.subarray(offset, offset + (length ?? value.length));
    io.contents.get(fd)!.push(Buffer.from(bytes));
    return bytes.length;
  }),
  delay: { max: 2_000_000, enable: vi.fn(), disable: vi.fn(), reset: vi.fn() },
}));
vi.mock("node:fs", () => ({
  openSync: () => { const fd = io.nextFd++; io.contents.set(fd, []); return fd; },
  closeSync: io.close, readFileSync: io.read, writeSync: io.write,
}));
vi.mock("node:perf_hooks", () => ({ monitorEventLoopDelay: () => io.delay }));

function memory(heapUsed: number) {
  return { heapUsed, rss: heapUsed * 2, heapTotal: heapUsed * 2, external: 0, arrayBuffers: 0 };
}
function records(value: CapacityTelemetry) {
  return Buffer.concat(io.contents.get(value.fd)!).toString("utf8").trim().split("\n").map(line => JSON.parse(line));
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(process, "memoryUsage").mockReturnValue(memory(10));
  vi.clearAllMocks();
});
afterEach(() => {
  observePeakMemory();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("owns one unreferenced timer, starts/stops idempotently and preserves monotonic byte maxima", () => {
  const value = new CapacityTelemetry("synthetic-memory.jsonl");
  try {
    const timer = vi.spyOn(globalThis, "setInterval");
    value.start();
    expect(timer.mock.results[0].value.hasRef()).toBe(false);
    value.start();
    expect(timer).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(1);
    vi.mocked(process.memoryUsage).mockReturnValue(memory(30));
    vi.advanceTimersByTime(250);
    vi.mocked(process.memoryUsage).mockReturnValue(memory(20));
    const summary = value.stop();
    expect(summary).toMatchObject({ samples: 3, sampledHeapUsedMax: 30, sampledRssMax: 60 });
    expect(value.stop()).toBe(summary);
    expect(vi.getTimerCount()).toBe(0);
    value.sample();
    peakCheckpoint("sql.result");
    expect(value.samples).toBe(3);
    expect(io.close).toHaveBeenCalledOnce();
    expect(records(value).filter(row => row.event === "summary")).toHaveLength(1);
    expect(() => value.start()).toThrow("capacity_telemetry_stopped");
  } finally { value.stop(); }
});

it("samples both request boundaries even when no interval runs and clears a failed final sample", () => {
  const value = new CapacityTelemetry("synthetic-window.jsonl");
  try {
    value.start();
    vi.mocked(process.memoryUsage).mockReturnValue(memory(30));
    value.beginRequestWindow();
    expect(() => value.beginRequestWindow()).toThrow("capacity_request_window_overlap");
    vi.mocked(process.memoryUsage).mockReturnValue(memory(40));
    peakCheckpoint("response.serialize");
    vi.mocked(process.memoryUsage).mockReturnValue(memory(50));
    expect(value.endRequestWindow()).toMatchObject({ sampledHeapUsedMax: 50, stageCheckpointHeapUsedMax: 40,
      stages: ["response.serialize"] });
    expect(() => value.endRequestWindow()).toThrow("capacity_request_window_missing");
    value.beginRequestWindow();
    vi.mocked(process.memoryUsage).mockImplementationOnce(() => { throw new Error("synthetic sample failure"); });
    expect(() => value.endRequestWindow()).toThrow("synthetic sample failure");
    expect(() => value.beginRequestWindow()).not.toThrow();
    value.endRequestWindow();
  } finally { value.stop(); }
});

it("rejects overlapping isolate samplers without disturbing the owner or replacement hooks", () => {
  const first = new CapacityTelemetry("synthetic-first.jsonl"), second = new CapacityTelemetry("synthetic-second.jsonl");
  try {
    first.start();
    expect(() => second.start()).toThrow("capacity_telemetry_overlap");
    peakCheckpoint("sql.result");
    expect(first.stages.get("sql.result")?.count).toBe(1);
    expect(second.stages.size).toBe(0);
    second.stop();
    peakCheckpoint("sql.result");
    expect(first.stages.get("sql.result")?.count).toBe(2);
    const replacement = vi.fn();
    observePeakMemory(replacement);
    first.stop();
    peakCheckpoint("sql.result");
    expect(replacement).toHaveBeenCalledOnce();
  } finally { first.stop(); second.stop(); }
});

it.each(["start", "interval", "stop"] as const)("cleans timers, hooks, histogram and descriptor when the %s sample throws", boundary => {
  const value = new CapacityTelemetry("synthetic-failure.jsonl");
  if (boundary !== "start") value.start();
  vi.mocked(process.memoryUsage).mockImplementationOnce(() => { throw new Error("synthetic sample failure"); });
  const action = () => boundary === "interval" ? vi.advanceTimersByTime(250) : value[boundary]();
  expect(action).toThrow("synthetic sample failure");
  expect(vi.getTimerCount()).toBe(0);
  expect(io.close).toHaveBeenCalledWith(value.fd);
  expect(io.delay.disable).toHaveBeenCalled();
  const next = new CapacityTelemetry("synthetic-after-failure.jsonl");
  try { expect(() => next.start()).not.toThrow(); }
  finally { next.stop(); }
});

it("completes short UTF-8 writes and includes failed terminal writes in returned drop accounting", () => {
  const value = new CapacityTelemetry("synthetic-write.jsonl");
  const write = io.write.getMockImplementation()!;
  try {
    value.start();
    io.write.mockImplementationOnce((fd, data) => {
      const bytes = typeof data === "string" ? Buffer.from(data) : data;
      return write(fd, bytes, 0, 3);
    });
    value.write({ event: "synthetic-unicode", value: "😀" });
    expect(records(value).at(-1)).toEqual({ event: "synthetic-unicode", value: "😀" });
    io.write.mockImplementation((fd, data, offset, length) => {
      if (String(data).includes('"event":"summary"')) throw new Error("synthetic write failure");
      return write(fd, data, offset, length);
    });
    expect(value.stop()).toMatchObject({ dropped: 1, bytes: value.bytes });
    expect(io.close).toHaveBeenCalledWith(value.fd);
  } finally { io.write.mockImplementation(write); value.stop(); }
});

it("counts serialization failures as incomplete evidence rather than replacing measured work", () => {
  const value = new CapacityTelemetry("synthetic-serialization.jsonl");
  try {
    value.start();
    const cycle = { self: {} };
    cycle.self = cycle;
    expect(() => value.write(cycle)).not.toThrow();
    expect(() => value.write({ toJSON: () => { throw new Error("synthetic serialization failure"); } })).not.toThrow();
    value.write(undefined);
    value.write(Symbol("synthetic"));
    expect(value.stop()).toMatchObject({ dropped: 4 });
    expect(records(value).at(-1)).toMatchObject({ event: "summary", dropped: 4 });
  } finally { value.stop(); }
});

it("retains a failed final sample and cleanup failure without caching a successful stop", () => {
  const value = new CapacityTelemetry("synthetic-double-failure.jsonl");
  value.start();
  const sample = new Error("synthetic sample failure"), close = new Error("synthetic close failure");
  vi.mocked(process.memoryUsage).mockImplementationOnce(() => { throw sample; });
  io.close.mockImplementationOnce(() => { throw close; });
  expect(() => value.stop()).toThrow(expect.objectContaining({ errors: [sample, close] }));
  expect(() => value.stop()).toThrow("capacity_telemetry_incomplete");
  expect(vi.getTimerCount()).toBe(0);
});

it("rejects invalid GC object-byte counters rather than claiming complete numeric evidence", () => {
  for (const bytes of ["-1", "1.5", "1e999", "9007199254740992"]) {
    expect(parseGcNvp(`[7:0xabc:0] 20 ms: gc=s start_object_size=${bytes} end_object_size=0 allocated=0`))
      .toMatchObject({ complete: false });
  }
  expect(parseGcNvp("[7:0xabc:0] 20 ms: gc=s start_object_size=0 end_object_size=0 allocated=0"))
    .toMatchObject({ complete: true, before: 0, after: 0, allocated: 0 });
});

it("clears the transient probe's timer when a live checkpoint fails", async () => {
  const hadGc = Object.hasOwn(globalThis, "gc"), previous = globalThis.gc;
  globalThis.gc = vi.fn();
  observePeakMemory(() => { throw new Error("synthetic checkpoint failure"); });
  try {
    const pending = transientHeapProbe();
    const rejected = expect(pending).rejects.toThrow("synthetic checkpoint failure");
    await vi.advanceTimersByTimeAsync(260);
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    if (hadGc) globalThis.gc = previous;
    else Reflect.deleteProperty(globalThis, "gc");
  }
});
