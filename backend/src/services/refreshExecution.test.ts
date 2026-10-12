import { getEventListeners } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRefreshExecutionSignal } from "./refreshExecution.js";

describe("refresh execution signal", () => {
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it("releases the parent listener as soon as the deadline wins, before disposal", async () => {
    vi.useFakeTimers();
    const parent = new AbortController();
    const execution = createRefreshExecutionSignal(parent.signal, 1000);
    try {
      await vi.advanceTimersByTimeAsync(1000);
      expect(execution.signal.reason).toMatchObject({ name: "TimeoutError" });
      expect(getEventListeners(parent.signal, "abort")).toHaveLength(0);
    } finally { execution.dispose(); }
  });

  it("cancels its timer on disposal and on parent cancellation", () => {
    vi.useFakeTimers();
    const parent = new AbortController();
    const first = createRefreshExecutionSignal(parent.signal, 60_000);
    const second = createRefreshExecutionSignal(parent.signal, 60_000);
    try {
      expect(vi.getTimerCount()).toBe(2);
      first.dispose();
      first.dispose();
      expect(vi.getTimerCount()).toBe(1);
      const reason = { code: "stopped" };
      parent.abort(reason);
      expect(second.signal.reason).toBe(reason);
      expect(getEventListeners(parent.signal, "abort")).toHaveLength(0);
      expect(vi.getTimerCount()).toBe(0);
      expect(first.signal.aborted).toBe(false);
    } finally { first.dispose(); second.dispose(); }
  });

  it("does not allocate a timer or listener for an already-cancelled parent", () => {
    vi.useFakeTimers();
    const parent = new AbortController();
    const reason = new Error("Already stopped");
    parent.abort(reason);
    const execution = createRefreshExecutionSignal(parent.signal, 60_000);
    try {
      expect(execution.signal.reason).toBe(reason);
      expect(getEventListeners(parent.signal, "abort")).toHaveLength(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally { execution.dispose(); }
  });

  it("treats zero as an already-expired deadline, but preserves an already-cancelled parent", () => {
    const parent = new AbortController();
    const execution = createRefreshExecutionSignal(parent.signal, 0);
    try {
      expect(execution.signal.reason).toMatchObject({ name: "TimeoutError" });
      const reason = new Error("Already stopped");
      parent.abort(reason);
      const cancelled = createRefreshExecutionSignal(parent.signal, 0);
      try { expect(cancelled.signal.reason).toBe(reason); }
      finally { cancelled.dispose(); }
    } finally { execution.dispose(); }
  });

  it("does not overflow a deadline longer than Node's signed timer range", async () => {
    vi.useFakeTimers();
    const parent = new AbortController();
    const execution = createRefreshExecutionSignal(parent.signal, 2 ** 31 + 1000);
    try {
      await vi.advanceTimersByTimeAsync(2 ** 31 - 1);
      expect(execution.signal.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1000);
      expect(execution.signal.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(execution.signal.reason).toMatchObject({ name: "TimeoutError" });
    } finally { execution.dispose(); }
  });

  it("does not renew the remaining budget when a long-deadline timer interval is delivered late", async () => {
    vi.useFakeTimers();
    let elapsed = 0;
    vi.spyOn(performance, "now").mockImplementation(() => elapsed);
    const deadlineMs = 2 ** 31 + 1000;
    const execution = createRefreshExecutionSignal(new AbortController().signal, deadlineMs);
    try {
      elapsed = deadlineMs + 1;
      await vi.advanceTimersByTimeAsync(2 ** 31 - 1);
      expect(execution.signal.reason).toMatchObject({ name: "TimeoutError" });
      expect(vi.getTimerCount()).toBe(0);
    } finally { execution.dispose(); }
  });

  it.each([1000, 2 ** 31 + 1000])("does not consume unelapsed time when a %s-ms timer is delivered early", async deadlineMs => {
    vi.useFakeTimers();
    let elapsed = 0;
    vi.spyOn(performance, "now").mockImplementation(() => elapsed);
    const parent = new AbortController();
    const execution = createRefreshExecutionSignal(parent.signal, deadlineMs);
    const interval = Math.min(deadlineMs, 2 ** 31 - 1);
    try {
      elapsed = interval - 0.25;
      await vi.advanceTimersByTimeAsync(interval);
      expect(execution.signal.aborted).toBe(false);
      elapsed = deadlineMs - 0.25;
      await vi.advanceTimersByTimeAsync(deadlineMs - interval);
      expect(execution.signal.aborted).toBe(false);
      elapsed = deadlineMs;
      await vi.advanceTimersByTimeAsync(1);
      expect(execution.signal.reason).toMatchObject({ name: "TimeoutError" });
      expect(getEventListeners(parent.signal, "abort")).toHaveLength(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally { execution.dispose(); }
  });

  it.each([-1, NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1])("rejects invalid deadline %s without attaching resources", deadlineMs => {
    const parent = new AbortController();
    expect(() => createRefreshExecutionSignal(parent.signal, deadlineMs)).toThrow(RangeError);
    expect(getEventListeners(parent.signal, "abort")).toHaveLength(0);
  });

  it.each(["deadline", "cancellation"] as const)("preserves the first %s and releases its resources immediately", async first => {
    vi.useFakeTimers();
    const cancellation = new AbortController();
    const stopped = new Error("Refresh stopped");
    const execution = createRefreshExecutionSignal(cancellation.signal, 150_000);
    try {
      if (first === "deadline") {
        await vi.advanceTimersByTimeAsync(150_000);
        const timeout = execution.signal.reason;
        expect(timeout).toMatchObject({ name: "TimeoutError" });
        cancellation.abort(stopped);
        expect(execution.signal.reason).toBe(timeout);
      } else {
        cancellation.abort(stopped);
        await vi.advanceTimersByTimeAsync(150_000);
        expect(execution.signal.reason).toBe(stopped);
      }
      expect(getEventListeners(cancellation.signal, "abort")).toHaveLength(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally { execution.dispose(); }
  });

  it("removes its listener and timer on repeated disposal without aborting the execution signal", async () => {
    vi.useFakeTimers();
    const cancellation = new AbortController();
    const execution = createRefreshExecutionSignal(cancellation.signal, 45_000);
    expect(getEventListeners(cancellation.signal, "abort")).toHaveLength(1);

    execution.dispose();
    execution.dispose();
    expect(getEventListeners(cancellation.signal, "abort")).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
    cancellation.abort(new Error("Refresh stopped"));
    await vi.advanceTimersByTimeAsync(45_000);
    expect(execution.signal.aborted).toBe(false);
  });

  it.each([undefined, "stopped", { code: "stopped" }])("forwards the parent's exact default or custom reason (%s)", reason => {
    const cancellation = new AbortController();
    const execution = createRefreshExecutionSignal(cancellation.signal, 45_000);
    try {
      cancellation.abort(reason);
      expect(execution.signal.reason).toBe(cancellation.signal.reason);
      expect(getEventListeners(cancellation.signal, "abort")).toHaveLength(0);
    } finally { execution.dispose(); }
  });

  it("forwards a real deadline without aborting the cancellation source", async () => {
    const cancellation = new AbortController();
    const execution = createRefreshExecutionSignal(cancellation.signal, 1);
    const operation = new Promise<void>((_resolve, reject) => {
      execution.signal.addEventListener("abort", () => reject(execution.signal.reason), { once: true });
    });

    try {
      await expect(operation).rejects.toMatchObject({ name: "TimeoutError" });
    } finally {
      execution.dispose();
    }
    expect(cancellation.signal.aborted).toBe(false);
    expect(getEventListeners(cancellation.signal, "abort")).toHaveLength(0);
  });
});
