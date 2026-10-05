import type pg from "pg";
import { getEventListeners } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { admitGeneration } from "./generationAdmission.js";
import { dataAdmissionError } from "./dataBounds.js";
import type { GenerationLease } from "./dataGenerations.js";

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
  it("waits before acquiring a lease, preserves FIFO order, and never retries non-admission failures", async () => {
    vi.useFakeTimers();
    const f = fixture(), order: number[] = [];
    f.begin.mockRejectedValueOnce(dataAdmissionError("data_ingestion_admission"))
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
