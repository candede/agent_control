import { getEventListeners } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRefreshExecutionSignal } from "./refreshExecution.js";

describe("refresh execution signal", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it.each(["deadline", "cancellation"] as const)("preserves the first %s without polling or an execution abort listener", first => {
    const cancellation = new AbortController();
    const deadline = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    const timeout = new DOMException("Execution deadline", "TimeoutError");
    const stopped = new Error("Refresh stopped");
    const firstReason = first === "deadline" ? timeout : stopped;
    const execution = createRefreshExecutionSignal(cancellation.signal, 150_000);

    if (first === "deadline") {
      deadline.abort(timeout);
      cancellation.abort(stopped);
    } else {
      cancellation.abort(stopped);
      deadline.abort(timeout);
    }
    expect(execution.signal.reason).toBe(firstReason);
    expect(AbortSignal.timeout).toHaveBeenCalledWith(150_000);
    execution.dispose();
    expect(getEventListeners(cancellation.signal, "abort")).toHaveLength(0);
    expect(getEventListeners(deadline.signal, "abort")).toHaveLength(0);
  });

  it("removes both listeners on disposal without aborting the execution signal", () => {
    const cancellation = new AbortController();
    const deadline = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    const execution = createRefreshExecutionSignal(cancellation.signal, 45_000);
    expect(getEventListeners(cancellation.signal, "abort")).toHaveLength(1);
    expect(getEventListeners(deadline.signal, "abort")).toHaveLength(1);

    execution.dispose();
    execution.dispose();
    expect(getEventListeners(cancellation.signal, "abort")).toHaveLength(0);
    expect(getEventListeners(deadline.signal, "abort")).toHaveLength(0);
    cancellation.abort(new Error("Refresh stopped"));
    deadline.abort(new DOMException("Execution deadline", "TimeoutError"));
    expect(execution.signal.aborted).toBe(false);
  });

  it.each(["cancellation", "deadline", "both"] as const)("preserves already-aborted %s sources", source => {
    const cancellation = new AbortController();
    const deadline = new AbortController();
    const stopped = new Error("Refresh stopped");
    const timeout = new DOMException("Execution deadline", "TimeoutError");
    if (source !== "deadline") cancellation.abort(stopped);
    if (source !== "cancellation") deadline.abort(timeout);
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    const execution = createRefreshExecutionSignal(cancellation.signal, 45_000);

    expect(execution.signal.aborted).toBe(true);
    expect(execution.signal.reason).toBe(source === "deadline" ? timeout : stopped);
    execution.dispose();
    expect(getEventListeners(cancellation.signal, "abort")).toHaveLength(0);
    expect(getEventListeners(deadline.signal, "abort")).toHaveLength(0);
  });

  it("forwards a native deadline without aborting the cancellation source", async () => {
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
