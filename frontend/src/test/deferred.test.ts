// @vitest-environment node
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { deferred } from "./deferred";

describe("deferred request fixture", () => {
  it("stays pending until resolved and notifies every observer asynchronously", async () => {
    const pending = deferred<string>();
    const first = vi.fn(), second = vi.fn();
    const observations = [pending.promise.then(first), pending.promise.then(second)];
    expect(pending.promise).toBeInstanceOf(Promise);
    await Promise.resolve();
    expect(first).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();
    pending.resolve("saved data");
    expect(first).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();
    await Promise.all(observations);
    expect(first).toHaveBeenCalledExactlyOnceWith("saved data");
    expect(second).toHaveBeenCalledExactlyOnceWith("saved data");
    await expect(pending.promise).resolves.toBe("saved data");
  });

  it.each(["resolve", "reject"] as const)("keeps observers asynchronous after synchronous %s", async settlement => {
    const pending = deferred<string>(), observed = vi.fn();
    pending[settlement]("result");
    const observation = pending.promise.then(
      value => observed("resolved", value),
      reason => observed("rejected", reason),
    );
    expect(observed).not.toHaveBeenCalled();
    await observation;
    expect(observed).toHaveBeenCalledExactlyOnceWith(settlement === "resolve" ? "resolved" : "rejected", "result");
  });

  it.each(["resolve", "reject"] as const)("preserves the first %s for all observers despite later settlements", async first => {
    const pending = deferred<object>(), original = { request: "original" };
    const observations = Promise.allSettled([pending.promise, pending.promise]);
    pending[first](original);
    pending.resolve({ request: "replacement" });
    pending.reject(new Error("late failure"));
    const expected = first === "resolve"
      ? { status: "fulfilled", value: original } : { status: "rejected", reason: original };
    expect(await observations).toEqual([expected, expected]);
    expect(await Promise.allSettled([pending.promise])).toEqual([expected]);
  });

  it.each(["resolve", "reject"] as const)("adopts a pending thenable's %s without allowing a later settlement to replace it", async settlement => {
    const pending = deferred<string>(), adopted = deferred<string>(), observed = vi.fn();
    const then = vi.fn();
    const thenable: PromiseLike<string> = {
      then(onfulfilled, onrejected) {
        then();
        return adopted.promise.then(onfulfilled, onrejected);
      },
    };
    const observation = pending.promise.then(
      value => observed("resolved", value),
      reason => observed("rejected", reason),
    );
    pending.resolve(thenable);
    pending.resolve("replacement");
    pending.reject(new Error("late failure"));
    expect(then).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(then).toHaveBeenCalledOnce();
    expect(observed).not.toHaveBeenCalled();
    adopted[settlement]("adopted result");
    await observation;
    expect(observed).toHaveBeenCalledExactlyOnceWith(settlement === "resolve" ? "resolved" : "rejected", "adopted result");
  });

  it("keeps an A-B-A replacement independent from earlier request settlements", async () => {
    const original = deferred<string>(), other = deferred<string>(), returning = deferred<string>();
    expect(new Set([original.promise, other.promise, returning.promise]).size).toBe(3);
    const observed = vi.fn();
    const current = returning.promise.then(observed);
    original.resolve("obsolete A");
    other.resolve("B");
    await expect(Promise.all([original.promise, other.promise])).resolves.toEqual(["obsolete A", "B"]);
    expect(observed).not.toHaveBeenCalled();
    returning.resolve("current A");
    await current;
    expect(observed).toHaveBeenCalledExactlyOnceWith("current A");
  });

  it.each(["resolve", "reject"] as const)("allows a mocked transport to %s after its request is aborted", async settlement => {
    const pending = deferred<string>(), controller = new AbortController(), observed = vi.fn();
    const read = vi.fn<(signal: AbortSignal) => Promise<string>>(() => pending.promise);
    const first = read(controller.signal), second = read(controller.signal);
    expect(read).toHaveBeenCalledTimes(2);
    expect(first).toBe(second);
    const observations = [first, second].map(promise => promise.then(
      value => observed("resolved", value),
      reason => observed("rejected", reason),
    ));
    controller.abort();
    await Promise.resolve();
    expect(observed).not.toHaveBeenCalled();
    pending[settlement]("late result");
    await Promise.all(observations);
    expect(observed).toHaveBeenCalledTimes(2);
    expect(observed).toHaveBeenNthCalledWith(1, settlement === "resolve" ? "resolved" : "rejected", "late result");
    expect(observed).toHaveBeenNthCalledWith(2, settlement === "resolve" ? "resolved" : "rejected", "late result");
  });

  it("does not conceal an unobserved rejection from the runtime", () => {
    // Isolate the intentional unhandled rejection from Vitest's own error reporting.
    const helperUrl = pathToFileURL(resolve(import.meta.dirname, "deferred.ts")).href;
    const output = execFileSync(process.execPath, ["--input-type=module", "--unhandled-rejections=throw", "--eval", `
      import { deferred } from ${JSON.stringify(helperUrl)};
      const pending = deferred();
      process.on("unhandledRejection", (reason, promise) => {
        if (reason === "unobserved failure" && promise === pending.promise) {
          console.log("unhandled rejection observed");
        } else {
          process.exitCode = 1;
        }
      });
      pending.reject("unobserved failure");
    `], { encoding: "utf8", timeout: 5000 });
    expect(output.trim()).toBe("unhandled rejection observed");
  });
});
