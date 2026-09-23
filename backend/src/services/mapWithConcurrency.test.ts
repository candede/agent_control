import { setImmediate } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { mapWithConcurrency } from "./mapWithConcurrency.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

describe("mapWithConcurrency", () => {
  it("returns an empty result without calling the mapper for empty input", async () => {
    const mapper = vi.fn(async (item: number) => item);
    await expect(mapWithConcurrency([], 4, mapper)).resolves.toEqual([]);
    expect(mapper).not.toHaveBeenCalled();
  });

  it.each([1, 2, 4, 10, Number.MAX_SAFE_INTEGER])("maps every item once with concurrency %s", async concurrency => {
    const items = Object.freeze([0, 1, 2, 3, 4]);
    let active = 0;
    let maximumActive = 0;
    const mapper = vi.fn(async (item: number) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await Promise.resolve();
      active -= 1;
      return `result-${item}`;
    });

    await expect(mapWithConcurrency(items, concurrency, mapper))
      .resolves.toEqual(items.map(item => `result-${item}`));
    expect(mapper.mock.calls.map(([item]) => item)).toEqual(items);
    expect(maximumActive).toBe(Math.min(concurrency, items.length));
    expect(active).toBe(0);
  });

  it("refills available slots and preserves input order when work finishes out of order", async () => {
    const pending = Array.from({ length: 5 }, () => deferred<string>());
    const mapper = vi.fn((item: number) => pending[item].promise);
    const result = mapWithConcurrency([0, 1, 2, 3, 4], 2, mapper);
    expect(mapper.mock.calls).toEqual([[0], [1]]);

    try {
      for (const item of [1, 2, 3, 4]) {
        pending[item].resolve(`result-${item}`);
        await pending[item].promise;
        expect(mapper).toHaveBeenCalledTimes(Math.min(item + 2, pending.length));
      }
      pending[0].resolve("result-0");
      await expect(result).resolves.toEqual(["result-0", "result-1", "result-2", "result-3", "result-4"]);
    } finally {
      pending.forEach((work, item) => work.resolve(`result-${item}`));
      await result;
    }
  });

  it("preserves falsy mapped values", async () => {
    const items = [undefined, null, false, 0, ""] as const;
    await expect(mapWithConcurrency(items, 2, async item => item)).resolves.toEqual(items);
  });

  describe.each([
    { label: "nonempty", items: [1, 2] },
    { label: "empty", items: [] },
  ])("$label input", ({ items }) => {
    it.each([0, -1, 0.5, 1.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1])(
      "rejects invalid concurrency %s before calling the mapper",
      async concurrency => {
        const mapper = vi.fn(async (item: number) => item);
        await expect(mapWithConcurrency(items, concurrency, mapper)).rejects.toMatchObject({
          name: "RangeError",
          message: "Concurrency must be a positive safe integer.",
        });
        expect(mapper).not.toHaveBeenCalled();
      },
    );
  });

  it("stops queued work and drains running mappers before rejecting", async () => {
    const running = deferred<string>();
    const failing = deferred<string>();
    const failure = new Error("Mapper failed.");
    const mapper = vi.fn<(item: number) => Promise<string>>()
      .mockReturnValueOnce(running.promise)
      .mockReturnValueOnce(failing.promise);
    const result = mapWithConcurrency([0, 1, 2, 3], 2, mapper);
    const settled = vi.fn();
    const observed = result.then(settled, settled);

    try {
      failing.reject(failure);
      await setImmediate();
      expect(settled).not.toHaveBeenCalled();
      expect(mapper.mock.calls).toEqual([[0], [1]]);
      running.resolve("completed");
      await expect(result).rejects.toBe(failure);
      expect(mapper).toHaveBeenCalledTimes(2);
    } finally {
      running.resolve("completed");
      await observed;
    }
  });

  it.each([new Error("First failure."), undefined, null, false, 0, ""])(
    "preserves the first observed failure (%s) while other workers drain",
    async firstFailure => {
      const firstWorker = deferred<string>();
      const secondWorker = deferred<string>();
      const mapper = vi.fn<(item: number) => Promise<string>>()
        .mockReturnValueOnce(firstWorker.promise)
        .mockReturnValueOnce(secondWorker.promise);
      const result = mapWithConcurrency([0, 1, 2], 2, mapper);
      const assertion = expect(result).rejects.toBe(firstFailure);

      secondWorker.reject(firstFailure);
      await setImmediate();
      firstWorker.reject(new Error("Later failure from the earlier worker."));
      await assertion;
      expect(mapper.mock.calls).toEqual([[0], [1]]);
    },
  );

  it("propagates synchronous mapper exceptions without starting more work", async () => {
    const failure = new Error("Synchronous mapper failure.");
    const mapper = vi.fn<(item: number) => Promise<number>>(() => { throw failure; });
    await expect(mapWithConcurrency([0, 1, 2], 2, mapper)).rejects.toBe(failure);
    expect(mapper.mock.calls).toEqual([[0]]);
  });
});
