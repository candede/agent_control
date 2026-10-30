import type pg from "pg";
import { getEventListeners } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { admitGeneration } from "./generationAdmission.js";
import { dataAdmissionError } from "./dataBounds.js";
import type { GenerationLease } from "./dataGenerations.js";
import { AppError } from "../errors.js";

const lease = { id: "owned-generation" } as GenerationLease;
function fixture() {
  const database = {} as pg.Pool;
  const begin = vi.fn(async () => lease);
  const release = vi.fn(async () => {});
  const deadline = new Date(Date.now() + 60_000);
  return { database, begin, release, deadline };
}
afterEach(() => { vi.useRealTimers(); });

describe("bounded worker generation admission", () => {
  it.each(["data_ingestion_admission", "data_source_active"])("waits on %s, preserves FIFO order, and never retries unrelated failures", async code => {
    vi.useFakeTimers();
    const f = fixture(), order: number[] = [];
    f.begin.mockRejectedValueOnce(code === "data_source_active"
      ? new AppError(409, code, "This tenant source is already being collected.") : dataAdmissionError(code))
      .mockImplementationOnce(async () => { order.push(1); return lease; });
    const first = admitGeneration(f.database, f.begin, f.release, f.deadline);
    await vi.advanceTimersByTimeAsync(0);
    const second = admitGeneration(f.database, async () => { order.push(2); return lease; }, f.release, f.deadline);
    expect(order).toEqual([]);
    expect(f.release).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(await first).toBe(lease);
    expect(await second).toBe(lease);
    expect(order).toEqual([1, 2]);
    const conflict = Object.assign(new Error("serialization"), { code: "40001" });
    f.begin.mockRejectedValueOnce(conflict);
    await expect(admitGeneration(f.database, f.begin, f.release, f.deadline)).rejects.toBe(conflict);
    expect(f.begin).toHaveBeenCalledTimes(3);
  });

  it("bounds the pending queue at 32 and removes cancelled work without dispatching it", async () => {
    vi.useFakeTimers();
    const f = fixture(), controllers = Array.from({ length: 32 }, () => new AbortController()), reason = new Error("cancelled");
    f.begin.mockRejectedValue(dataAdmissionError("data_ingestion_admission"));
    const pending = controllers.map(controller => admitGeneration(f.database, f.begin, f.release, f.deadline, controller.signal).catch(error => error));
    await vi.advanceTimersByTimeAsync(0);
    await expect(admitGeneration(f.database, f.begin, f.release, f.deadline)).rejects.toMatchObject({ code: "data_ingestion_queue_full", status: 429 });
    const attempts = f.begin.mock.calls.length;
    for (const controller of controllers) controller.abort(reason);
    expect(await Promise.all(pending)).toEqual(Array(32).fill(reason));
    await vi.advanceTimersByTimeAsync(2000);
    expect(f.begin).toHaveBeenCalledTimes(attempts);
    expect(f.release).not.toHaveBeenCalled();
    expect(controllers.every(controller => getEventListeners(controller.signal, "abort").length === 0)).toBe(true);
    f.begin.mockResolvedValue(lease);
    await expect(admitGeneration(f.database, f.begin, f.release, f.deadline)).resolves.toBe(lease);
  });

  it("releases a lease whose SQL admission settles after cancellation, before returning the cancellation", async () => {
    const f = fixture(), controller = new AbortController(), reason = new Error("revoked");
    let resolve!: (value: GenerationLease) => void;
    f.begin.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const pending = admitGeneration(f.database, f.begin, f.release, f.deadline, controller.signal);
    const stopped = expect(pending).rejects.toBe(reason);
    controller.abort(reason);
    expect(f.release).not.toHaveBeenCalled();
    resolve(lease);
    await stopped;
    expect(f.release).toHaveBeenCalledWith(lease);
  });

  it("retains the original deadline while admission is full and does not create an expired generation", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.begin.mockRejectedValue(dataAdmissionError("data_ingestion_admission"));
    const pending = admitGeneration(f.database, f.begin, f.release, new Date(Date.now() + 250));
    const stopped = expect(pending).rejects.toMatchObject({ code: "data_ingestion_deadline" });
    await vi.advanceTimersByTimeAsync(250);
    await stopped;
    expect(f.begin).toHaveBeenCalledOnce();
    expect(f.release).not.toHaveBeenCalled();
  });

  it("expires a new waiter at its own deadline during the retry backoff", async () => {
    vi.useFakeTimers();
    const f = fixture(), controller = new AbortController(), settled = vi.fn();
    f.begin.mockRejectedValue(dataAdmissionError("data_ingestion_admission"));
    const busy = admitGeneration(f.database, f.begin, f.release, f.deadline, controller.signal).catch(error => error);
    await vi.advanceTimersByTimeAsync(0);
    const begin = vi.fn(async () => lease);
    const pending = admitGeneration(f.database, begin, f.release, new Date(Date.now() + 250), controller.signal)
      .then(settled, settled);
    try {
      await vi.advanceTimersByTimeAsync(249);
      expect(settled).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ code: "data_ingestion_deadline", status: 503 }));
      expect(begin).not.toHaveBeenCalled();
      expect(f.begin).toHaveBeenCalledOnce();
    } finally {
      controller.abort(new Error("finished"));
      await Promise.all([busy, pending]);
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it("expires waiting work while another SQL admission remains in flight", async () => {
    vi.useFakeTimers();
    const f = fixture(), controller = new AbortController(), settled = vi.fn();
    const admission = Promise.withResolvers<GenerationLease>();
    f.begin.mockReturnValueOnce(admission.promise);
    const busy = admitGeneration(f.database, f.begin, f.release, f.deadline, controller.signal).catch(error => error);
    const begin = vi.fn(async () => lease);
    const pending = admitGeneration(f.database, begin, f.release, new Date(Date.now() + 250), controller.signal)
      .then(settled, settled);
    try {
      await vi.advanceTimersByTimeAsync(250);
      expect(settled).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ code: "data_ingestion_deadline", status: 503 }));
      expect(begin).not.toHaveBeenCalled();
      expect(f.release).not.toHaveBeenCalled();
    } finally {
      controller.abort(new Error("finished"));
      admission.resolve(lease);
      await Promise.all([busy, pending]);
    }
    expect(f.release).toHaveBeenCalledExactlyOnceWith(lease);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps the active lease owned until deadline cleanup completes", async () => {
    vi.useFakeTimers();
    const f = fixture(), settled = vi.fn();
    const admission = Promise.withResolvers<GenerationLease>(), cleanup = Promise.withResolvers<void>();
    f.begin.mockReturnValueOnce(admission.promise);
    f.release.mockReturnValueOnce(cleanup.promise);
    const pending = admitGeneration(f.database, f.begin, f.release, new Date(Date.now() + 250)).then(settled, settled);
    try {
      await vi.advanceTimersByTimeAsync(250);
      expect(settled).not.toHaveBeenCalled();
      admission.resolve(lease);
      await vi.advanceTimersByTimeAsync(0);
      expect(f.release).toHaveBeenCalledExactlyOnceWith(lease);
      expect(settled).not.toHaveBeenCalled();
    } finally {
      admission.resolve(lease);
      cleanup.resolve();
      await pending;
    }
    expect(settled).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ code: "data_ingestion_deadline", status: 503 }));
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["data_ingestion_admission", "data_source_active"])("does not retry a late %s failure after the deadline timer has fired", async code => {
    vi.useFakeTimers();
    const f = fixture(), settled = vi.fn();
    const admission = Promise.withResolvers<GenerationLease>();
    f.begin.mockReturnValueOnce(admission.promise);
    const pending = admitGeneration(f.database, f.begin, f.release, new Date(Date.now() + 250)).then(settled, settled);
    await vi.advanceTimersByTimeAsync(250);
    expect(settled).not.toHaveBeenCalled();
    admission.reject(dataAdmissionError(code));
    await pending;
    expect(settled).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ code: "data_ingestion_deadline", status: 503 }));
    expect(f.begin).toHaveBeenCalledOnce();
    expect(f.release).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    await expect(admitGeneration(f.database, f.begin, f.release, f.deadline)).resolves.toBe(lease);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not overflow a far-future deadline timer or lose its cleanup", async () => {
    vi.useFakeTimers();
    const f = fixture(), controller = new AbortController();
    f.begin.mockRejectedValue(dataAdmissionError("data_ingestion_admission"));
    const timeout = vi.spyOn(globalThis, "setTimeout");
    const pending = admitGeneration(f.database, f.begin, f.release, new Date(Date.now() + 2_147_483_648), controller.signal)
      .catch(error => error);
    try {
      expect(timeout.mock.calls[0]?.[1]).toBe(2_147_483_647);
      await vi.advanceTimersByTimeAsync(999);
      expect(f.begin).toHaveBeenCalledOnce();
    } finally {
      controller.abort(new Error("finished"));
      await pending;
      timeout.mockRestore();
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retains the deadline error when releasing a late lease fails", async () => {
    vi.useFakeTimers();
    const f = fixture(), failure = new Error("fence failed");
    const admission = Promise.withResolvers<GenerationLease>();
    f.begin.mockReturnValueOnce(admission.promise);
    f.release.mockRejectedValueOnce(failure);
    const pending = admitGeneration(f.database, f.begin, f.release, new Date(Date.now() + 250));
    const stopped = expect(pending).rejects.toMatchObject({
      message: "data_admission_release_failed",
      errors: [expect.objectContaining({ code: "data_ingestion_deadline", status: 503 }), failure],
    });
    await vi.advanceTimersByTimeAsync(250);
    admission.resolve(lease);
    await stopped;
    expect(f.release).toHaveBeenCalledExactlyOnceWith(lease);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("propagates an undefined rejection instead of resolving without a lease", async () => {
    const f = fixture();
    f.begin.mockRejectedValueOnce(undefined);
    await expect(admitGeneration(f.database, f.begin, f.release, f.deadline)).rejects.toBeUndefined();
    expect(f.release).not.toHaveBeenCalled();
    await expect(admitGeneration(f.database, f.begin, f.release, f.deadline)).resolves.toBe(lease);
  });

  it("rejects an invalid deadline without attempting SQL or retaining resources", async () => {
    vi.useFakeTimers();
    const f = fixture(), controller = new AbortController();
    await expect(admitGeneration(f.database, f.begin, f.release, new Date(NaN), controller.signal))
      .rejects.toThrow(RangeError);
    expect(f.begin).not.toHaveBeenCalled();
    expect(f.release).not.toHaveBeenCalled();
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("surfaces a failed late-lease fence rather than hiding it behind cancellation", async () => {
    const f = fixture(), controller = new AbortController(), failure = new Error("fence failed");
    f.release.mockRejectedValueOnce(failure);
    f.begin.mockImplementationOnce(async () => { controller.abort(new Error("cancelled")); return lease; });
    await expect(admitGeneration(f.database, f.begin, f.release, f.deadline, controller.signal))
      .rejects.toMatchObject({ message: "data_admission_release_failed", errors: [expect.any(Error), failure] });
  });

  it("does not prevent another tenant's admissible work while a prior request remains busy", async () => {
    vi.useFakeTimers();
    const f = fixture(), controller = new AbortController();
    f.begin.mockRejectedValue(dataAdmissionError("data_ingestion_admission"));
    const busy = admitGeneration(f.database, f.begin, f.release, f.deadline, controller.signal).catch(error => error);
    const other = admitGeneration(f.database, async () => lease, f.release, f.deadline);
    await vi.advanceTimersByTimeAsync(0);
    expect(await other).toBe(lease);
    controller.abort(new Error("finished"));
    await busy;
  });
});
