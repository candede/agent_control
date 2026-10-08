import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSavedQueryClient, readSavedQuery, useSavedQuery } from "./savedQueries";
import { ApiError } from "./api/client";
import { SavedQueryProvider } from "./components/SavedQueryProvider";
import { deferred } from "./test/deferred";

const clients: ReturnType<typeof createSavedQueryClient>[] = [];
function client() {
  const value = createSavedQueryClient();
  clients.push(value);
  return value;
}
afterEach(() => {
  clients.splice(0).forEach(value => value.clear());
  vi.useRealTimers();
});

describe("saved server queries", () => {
  it("shares structurally equivalent keys without normalizing meaningful filter values", async () => {
    const queries = client(), response = deferred<string>();
    const read = vi.fn(() => response.promise);
    const signal = new AbortController().signal;
    const first = readSavedQuery(queries, ["users", { page: 0, filters: { company: "", department: null } }], read, signal);
    const equivalent = readSavedQuery(queries, ["users", { filters: { department: null, company: "" }, page: 0, cursor: undefined }], read, signal);
    expect(read).toHaveBeenCalledOnce();
    const distinct = readSavedQuery(queries, ["users", { page: 0, filters: { department: null } }], read, signal);
    expect(read).toHaveBeenCalledTimes(2);
    response.resolve("saved users");
    await expect(Promise.all([first, equivalent, distinct])).resolves.toEqual(["saved users", "saved users", "saved users"]);
    expect(queries.isFetching()).toBe(0);
    expect(queries.getQueryCache().getAll().every(query => query.getObserversCount() === 0)).toBe(true);
  });

  it.each([false, true])("shares concurrent reads without coupling their cancellation (retained: %s)", async retained => {
    const queries = client();
    const first = new AbortController();
    const second = new AbortController();
    let complete!: (value: string) => void;
    let requestSignal!: AbortSignal;
    const read = vi.fn((signal: AbortSignal) => {
      requestSignal = signal;
      return new Promise<string>(resolve => { complete = resolve; });
    });
    const retention = retained ? { staleTime: Infinity, gcTime: 60_000 } : undefined;
    const left = readSavedQuery(queries, ["users", { page: 0 }], read, first.signal, retention);
    const right = readSavedQuery(queries, ["users", { page: 0 }], read, second.signal, retention);
    const cancelled = expect(left).rejects.toMatchObject({ kind: "aborted" });
    first.abort();
    await cancelled;
    expect(requestSignal.aborted).toBe(false);
    complete("saved users");
    await expect(right).resolves.toBe("saved users");
    expect(read).toHaveBeenCalledOnce();
  });

  it.each(["hook", "imperative"] as const)("preserves the other observer when the %s reader leaves", async departing => {
    const queries = client(), response = deferred<string>(), controller = new AbortController();
    let requestSignal!: AbortSignal;
    const read = vi.fn((signal: AbortSignal) => { requestSignal = signal; return response.promise; });
    const hook = renderHook(() => useSavedQuery({
      queryKey: ["saved", "users"], queryFn: ({ signal }) => read(signal),
    }), { wrapper: ({ children }) => <QueryClientProvider client={queries}>{children}</QueryClientProvider> });
    const pending = readSavedQuery(queries, ["users"], read, controller.signal);
    if (departing === "hook") hook.unmount();
    else {
      const cancelled = expect(pending).rejects.toMatchObject({ kind: "aborted" });
      controller.abort();
      await cancelled;
      expect(hook.result.current.isFetching).toBe(true);
      expect(hook.result.current.error).toBeNull();
    }
    expect(read).toHaveBeenCalledOnce();
    expect(requestSignal.aborted).toBe(false);
    await act(async () => response.resolve("current users"));
    if (departing === "hook") await expect(pending).resolves.toBe("current users");
    else {
      await waitFor(() => expect(hook.result.current.data).toBe("current users"));
      expect(hook.result.current.isFetching).toBe(false);
      hook.unmount();
    }
    expect(queries.isFetching()).toBe(0);
    expect(read).toHaveBeenCalledOnce();
  });

  it.each([false, true])("retires every cancelled observer before a same-key replacement (retained: %s)", async retained => {
    const queries = client(), original = deferred<string>(), replacement = deferred<string>();
    const controllers = [new AbortController(), new AbortController()];
    const signals: AbortSignal[] = [];
    const read = vi.fn((signal: AbortSignal) => {
      signals.push(signal);
      return signals.length === 1 ? original.promise : replacement.promise;
    });
    const retention = retained ? { staleTime: Infinity, gcTime: 60_000 } : undefined;
    const cancelled = controllers.map(controller => expect(
      readSavedQuery(queries, ["users"], read, controller.signal, retention),
    ).rejects.toMatchObject({ kind: "aborted" }));
    controllers[0].abort();
    expect(signals[0].aborted).toBe(false);
    controllers[1].abort();
    expect(signals[0].aborted).toBe(true);
    const current = readSavedQuery(queries, ["users"], read, new AbortController().signal, retention);
    const settled = vi.fn();
    void current.then(settled);
    await Promise.all(cancelled);
    expect(read).toHaveBeenCalledTimes(2);
    original.resolve("abandoned users");
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    expect(queries.getQueryData(["saved", "users"])).toBeUndefined();
    expect(signals[1].aborted).toBe(false);
    replacement.resolve("replacement users");
    await expect(current).resolves.toBe("replacement users");
    expect(queries.getQueryData(["saved", "users"])).toBe("replacement users");
    expect(queries.isFetching()).toBe(0);
  });

  it("aborts the request after its last observer leaves and rejects pre-aborted reads", async () => {
    const queries = client();
    const controller = new AbortController();
    let requestSignal!: AbortSignal;
    const read = vi.fn((signal: AbortSignal) => {
      requestSignal = signal;
      return new Promise<string>(() => {});
    });
    const pending = readSavedQuery(queries, ["users"], read, controller.signal);
    const cancelled = expect(pending).rejects.toMatchObject({ kind: "aborted" });
    controller.abort();
    await cancelled;
    expect(requestSignal.aborted).toBe(true);
    await expect(readSavedQuery(queries, ["users"], read, controller.signal)).rejects.toMatchObject({ kind: "aborted" });
    expect(read).toHaveBeenCalledOnce();
  });

  it.each([
    { eventType: "added", cancellation: "abort" },
    { eventType: "added", cancellation: "clear" },
    { eventType: "observerAdded", cancellation: "abort" },
    { eventType: "observerAdded", cancellation: "clear" },
    { eventType: "updated", cancellation: "abort" },
    { eventType: "updated", cancellation: "clear" },
  ] as const)("honors $cancellation during $eventType admission without starting a request", async ({ eventType, cancellation }) => {
    const queries = client();
    const controller = new AbortController();
    const read = vi.fn().mockResolvedValue("private data");
    const unsubscribe = queries.getQueryCache().subscribe(event => {
      if (event.type !== eventType || event.type === "updated" && event.action.type !== "fetch") return;
      unsubscribe();
      if (cancellation === "abort") controller.abort();
      else queries.clear();
    });
    const pending = readSavedQuery(queries, ["private-users"], read, controller.signal);
    await expect(pending).rejects.toMatchObject({ kind: "aborted" });
    expect(read).not.toHaveBeenCalled();
    if (cancellation === "clear") expect(queries.getQueryCache().getAll()).toHaveLength(0);
    else await waitFor(() => expect(queries.getQueryCache().getAll()).toHaveLength(0));
  });

  it("preserves a peer observer when the admitting caller aborts at fetch start", async () => {
    const queries = client();
    const controller = new AbortController();
    const read = vi.fn().mockResolvedValue("shared data");
    const peer = renderHook(() => useSavedQuery({
      queryKey: ["saved", "users"], queryFn: read, enabled: false,
    }), {
      wrapper: ({ children }) => <QueryClientProvider client={queries}>{children}</QueryClientProvider>,
    });
    const unsubscribe = queries.getQueryCache().subscribe(event => {
      if (event.type !== "updated" || event.action.type !== "fetch") return;
      unsubscribe();
      controller.abort();
    });
    const pending = readSavedQuery(queries, ["users"], read, controller.signal);
    await expect(pending).rejects.toMatchObject({ kind: "aborted" });
    await waitFor(() => expect(peer.result.current.data).toBe("shared data"));
    expect(read).toHaveBeenCalledOnce();
    peer.unmount();
  });

  it("cleans up cancellation triggered synchronously by the reader", async () => {
    const queries = client();
    const controller = new AbortController();
    const response = deferred<string>();
    let requestSignal!: AbortSignal;
    const pending = readSavedQuery(queries, ["private-users"], signal => {
      requestSignal = signal;
      controller.abort();
      return response.promise;
    }, controller.signal);
    await expect(pending).rejects.toMatchObject({ kind: "aborted" });
    expect(requestSignal.aborted).toBe(true);
    response.resolve("obsolete private data");
    await waitFor(() => expect(queries.getQueryCache().getAll()).toHaveLength(0));
  });

  it("does not silently retry failures and permits an explicit fresh read", async () => {
    const queries = client();
    const denied = new ApiError(403, "forbidden", "Access denied");
    const read = vi.fn().mockRejectedValueOnce(denied).mockResolvedValueOnce("authorized");
    await expect(readSavedQuery(queries, ["users"], read, new AbortController().signal)).rejects.toBe(denied);
    expect(read).toHaveBeenCalledOnce();
    await expect(readSavedQuery(queries, ["users"], read, new AbortController().signal)).resolves.toBe("authorized");
    expect(read).toHaveBeenCalledTimes(2);
  });

  it.each([false, true])("shares a failure and deduplicates the next explicit retry (retained: %s)", async retained => {
    const queries = client(), response = deferred<string>();
    const denied = new ApiError(403, "forbidden", "Access denied");
    const read = vi.fn().mockRejectedValueOnce(denied).mockReturnValueOnce(response.promise);
    const load = () => readSavedQuery(queries, ["users"], read, new AbortController().signal,
      retained ? { staleTime: Infinity, gcTime: 60_000 } : undefined);
    const failed = await Promise.allSettled([load(), load()]);
    expect(failed).toEqual([{ status: "rejected", reason: denied }, { status: "rejected", reason: denied }]);
    expect(read).toHaveBeenCalledOnce();
    expect(queries.isFetching()).toBe(0);
    const retried = Promise.all([load(), load()]);
    expect(read).toHaveBeenCalledTimes(2);
    expect(queries.isFetching()).toBe(1);
    response.resolve("authorized");
    await expect(retried).resolves.toEqual(["authorized", "authorized"]);
    expect(queries.isFetching()).toBe(0);
  });

  it.each([
    { outcome: "success", retained: false }, { outcome: "error", retained: false },
    { outcome: "success", retained: true }, { outcome: "error", retained: true },
  ])("follows invalidation at $outcome settlement without publishing stale evidence (retained: $retained)", async ({ outcome, retained }) => {
    const queries = client();
    const original = deferred<string>();
    const replacement = deferred<string>();
    const signals: AbortSignal[] = [];
    const read = vi.fn((signal: AbortSignal) => {
      signals.push(signal);
      return signals.length === 1 ? original.promise : replacement.promise;
    });
    const unsubscribe = queries.getQueryCache().subscribe(event => {
      if (event.type !== "updated" || event.action.type !== outcome) return;
      unsubscribe();
      void queries.invalidateQueries({ queryKey: ["saved", "history"] });
    });
    const pending = readSavedQuery(queries, ["history"], read, new AbortController().signal,
      retained ? { staleTime: Infinity, gcTime: 60_000 } : undefined);
    const settled = vi.fn();
    void pending.then(settled, settled);
    if (outcome === "success") original.resolve("obsolete history");
    else original.reject(new Error("obsolete failure"));
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    expect(settled).not.toHaveBeenCalled();
    expect(signals[1].aborted).toBe(false);
    replacement.resolve("current history");
    await expect(pending).resolves.toBe("current history");
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("shares a replacement read without coupling callers' cancellation", async () => {
    const queries = client();
    const original = deferred<string>();
    const replacement = deferred<string>();
    const signals: AbortSignal[] = [];
    const read = vi.fn((signal: AbortSignal) => {
      signals.push(signal);
      return signals.length === 1 ? original.promise : replacement.promise;
    });
    const unsubscribe = queries.getQueryCache().subscribe(event => {
      if (event.type !== "updated" || event.action.type !== "success") return;
      unsubscribe();
      void queries.invalidateQueries({ queryKey: ["saved", "history"] });
    });
    const controller = new AbortController();
    const left = readSavedQuery(queries, ["history"], read, controller.signal);
    const right = readSavedQuery(queries, ["history"], read, new AbortController().signal);
    const cancelled = expect(left).rejects.toMatchObject({ kind: "aborted" });
    original.resolve("obsolete history");
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    controller.abort();
    await cancelled;
    expect(signals[1].aborted).toBe(false);
    replacement.resolve("current history");
    await expect(right).resolves.toBe("current history");
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("follows invalidation of a cached in-flight read and reports the replacement failure", async () => {
    const queries = client();
    const key = ["saved", "history"];
    queries.setQueryData(key, "cached history");
    const original = deferred<string>();
    const replacement = deferred<string>();
    const signals: AbortSignal[] = [];
    const read = vi.fn((signal: AbortSignal) => {
      signals.push(signal);
      return signals.length === 1 ? original.promise : replacement.promise;
    });
    const pending = readSavedQuery(queries, ["history"], read, new AbortController().signal);
    const settled = vi.fn();
    void pending.then(settled, settled);
    void queries.invalidateQueries({ queryKey: key });
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    expect(signals[0].aborted).toBe(true);
    expect(signals[1].aborted).toBe(false);
    expect(settled).not.toHaveBeenCalled();
    original.resolve("obsolete history");
    const denied = new ApiError(403, "forbidden", "Current history access denied.");
    replacement.reject(denied);
    await expect(pending).rejects.toBe(denied);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("follows repeated invalidation and lets new readers join only the latest replacement", async () => {
    const queries = client(), key = ["saved", "history"];
    const responses = [deferred<string>(), deferred<string>(), deferred<string>()];
    const signals: AbortSignal[] = [];
    const read = vi.fn((signal: AbortSignal) => {
      signals.push(signal);
      return responses[signals.length - 1].promise;
    });
    queries.setQueryData(key, "cached history");
    const first = readSavedQuery(queries, ["history"], read, new AbortController().signal);
    void queries.invalidateQueries({ queryKey: key, exact: true });
    void queries.invalidateQueries({ queryKey: key, exact: true });
    const second = readSavedQuery(queries, ["history"], read, new AbortController().signal);
    const settled = vi.fn();
    void Promise.all([first, second]).then(settled);
    responses[0].resolve("old history");
    responses[1].reject(new Error("old failure"));
    await Promise.resolve();
    await Promise.resolve();
    expect(read).toHaveBeenCalledTimes(3);
    expect(signals.map(signal => signal.aborted)).toEqual([true, true, false]);
    expect(settled).not.toHaveBeenCalled();
    responses[2].resolve("current history");
    await expect(Promise.all([first, second])).resolves.toEqual(["current history", "current history"]);
    expect(queries.getQueryData(key)).toBe("current history");
    expect(queries.isFetching()).toBe(0);
    expect(read).toHaveBeenCalledTimes(3);
  });

  it.each(["abort", "clear", "cancel", "silent"] as const)("settles %s cancellation of a replacement without replaying it", async cancellation => {
    const queries = client();
    const original = deferred<string>();
    const replacement = deferred<string>();
    const signals: AbortSignal[] = [];
    const read = vi.fn((signal: AbortSignal) => {
      signals.push(signal);
      return signals.length === 1 ? original.promise : replacement.promise;
    });
    const unsubscribe = queries.getQueryCache().subscribe(event => {
      if (event.type !== "updated" || event.action.type !== "success") return;
      unsubscribe();
      void queries.invalidateQueries({ queryKey: ["saved", "history"] });
    });
    const controller = new AbortController();
    const pending = readSavedQuery(queries, ["history"], read, controller.signal);
    const cancelled = expect(pending).rejects.toMatchObject({ kind: "aborted" });
    original.resolve("obsolete history");
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    if (cancellation === "abort") controller.abort();
    else if (cancellation === "clear") queries.clear();
    else await queries.cancelQueries({ queryKey: ["saved", "history"] }, { silent: cancellation === "silent" });
    await cancelled;
    expect(signals[1].aborted).toBe(true);
    replacement.resolve("cancelled history");
    await Promise.resolve();
    await Promise.resolve();
    expect(read).toHaveBeenCalledTimes(2);
    expect(queries.getQueryData(["saved", "history"])).not.toBe("cancelled history");
  });

  it("rejects an invalid empty query result instead of reporting a successful saved read", async () => {
    const queries = client();
    await expect(readSavedQuery(queries, ["invalid"], () => Promise.resolve(undefined), new AbortController().signal))
      .rejects.toThrow("data is undefined");
  });

  it("settles pending callers when a session clears its private query client", async () => {
    const queries = client();
    let signal!: AbortSignal;
    const pending = readSavedQuery(queries, ["private-users"], requestSignal => {
      signal = requestSignal;
      return new Promise<string>(() => {});
    }, new AbortController().signal);
    const cancelled = expect(pending).rejects.toMatchObject({ kind: "aborted" });
    queries.clear();
    await cancelled;
    expect(signal.aborted).toBe(true);
    expect(queries.getQueryCache().getAll()).toHaveLength(0);
  });

  it.each([false, true])("does not allow an ignored cancellation to repopulate a cleared client (retained: %s)", async retained => {
    const queries = client();
    let complete!: (value: string) => void;
    const pending = readSavedQuery(queries, ["private-users"], () => new Promise<string>(resolve => {
      complete = resolve;
    }), new AbortController().signal, retained ? { staleTime: Infinity, gcTime: 60_000 } : undefined);
    const cancelled = expect(pending).rejects.toMatchObject({ kind: "aborted" });
    queries.clear();
    await cancelled;
    complete("obsolete private data");
    await Promise.resolve();
    await Promise.resolve();
    expect(queries.getQueryCache().getAll()).toHaveLength(0);
  });

  it.each([
    { cached: false, silent: false }, { cached: true, silent: false },
    { cached: false, silent: true }, { cached: true, silent: true },
  ])("settles shared cancellation without stale data (cached: $cached, silent: $silent)", async ({ cached, silent }) => {
    const queries = client();
    if (cached) queries.setQueryData(["saved", "private-users"], "pre-mutation snapshot");
    const read = vi.fn(() => new Promise<string>(() => {}));
    const first = readSavedQuery(queries, ["private-users"], read, new AbortController().signal);
    const second = readSavedQuery(queries, ["private-users"], read, new AbortController().signal);
    const outcomes = [first, second].map(promise => promise.then(
      value => ({ status: "success", value }),
      (error: unknown) => ({ status: "error", error }),
    ));
    const completed = vi.fn();
    void Promise.all(outcomes).then(completed);
    await queries.cancelQueries({ queryKey: ["saved", "private-users"], exact: true }, { silent });
    await waitFor(() => expect(completed).toHaveBeenCalledOnce());
    expect(completed).toHaveBeenCalledWith([
      { status: "error", error: expect.objectContaining({ kind: "aborted" }) },
      { status: "error", error: expect.objectContaining({ kind: "aborted" }) },
    ]);
    expect(read).toHaveBeenCalledOnce();
  });

  it.each(["standalone", "provider"] as const)("replays %s ownership safely in Strict Mode", async ownership => {
    const signals: AbortSignal[] = [];
    const read = vi.fn(({ signal }: { signal: AbortSignal }) => {
      signals.push(signal);
      return Promise.resolve("current snapshot");
    });
    const hook = renderHook(() => useSavedQuery({ queryKey: ["users"], queryFn: read }), {
      reactStrictMode: true,
      wrapper: ownership === "provider" ? SavedQueryProvider : undefined,
    });
    await waitFor(() => expect(hook.result.current.data).toBe("current snapshot"));
    expect(hook.result.current.isFetching).toBe(false);
    expect(read).toHaveBeenCalledTimes(2);
    expect(signals[0].aborted).toBe(true);
    expect(signals[1].aborted).toBe(false);
    hook.unmount();
  });

  it("separates filters and clients and revalidates completed reads", async () => {
    const queries = client();
    const read = vi.fn().mockResolvedValue("snapshot");
    for (const [owner, page] of [[queries, 0], [queries, 1], [queries, 0], [client(), 0]] as const) {
      await readSavedQuery(owner, ["users", { page }], read, new AbortController().signal);
    }
    expect(read).toHaveBeenCalledTimes(4);
  });

  it("reuses opt-in revision-pinned results but retries failures and clears them with the session", async () => {
    const queries = client();
    const read = vi.fn().mockRejectedValueOnce(new Error("Unavailable")).mockResolvedValue("saved results");
    const retention = { staleTime: Infinity, gcTime: 60_000 };
    const load = (revision = "1") => readSavedQuery(queries, ["bulk-job-items", "owner", "job", revision],
      read, new AbortController().signal, retention);
    await expect(load()).rejects.toThrow("Unavailable");
    await expect(load()).resolves.toBe("saved results");
    await expect(load()).resolves.toBe("saved results");
    expect(read).toHaveBeenCalledTimes(2);
    await expect(load("2")).resolves.toBe("saved results");
    expect(read).toHaveBeenCalledTimes(3);
    queries.clear();
    await expect(load()).resolves.toBe("saved results");
    expect(read).toHaveBeenCalledTimes(4);
  });

  it("revalidates retained data at its freshness boundary and collects it after the last observer", async () => {
    vi.useFakeTimers();
    const queries = client(), replacement = deferred<string>();
    const read = vi.fn().mockResolvedValueOnce("initial").mockReturnValueOnce(replacement.promise).mockResolvedValue("after collection");
    const load = () => readSavedQuery(queries, ["history", "revision"], read, new AbortController().signal,
      { staleTime: 50, gcTime: 100 });
    await expect(load()).resolves.toBe("initial");
    await vi.advanceTimersByTimeAsync(49);
    await expect(load()).resolves.toBe("initial");
    expect(read).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    const first = load(), second = load(), settled = vi.fn();
    void Promise.all([first, second]).then(settled);
    expect(read).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(100);
    expect(settled).not.toHaveBeenCalled();
    expect(queries.getQueryCache().getAll()).toHaveLength(1);
    replacement.resolve("revalidated");
    await expect(Promise.all([first, second])).resolves.toEqual(["revalidated", "revalidated"]);
    await vi.advanceTimersByTimeAsync(99);
    expect(queries.getQueryData(["saved", "history", "revision"])).toBe("revalidated");
    await vi.advanceTimersByTimeAsync(1);
    expect(queries.getQueryCache().getAll()).toHaveLength(0);
    await expect(load()).resolves.toBe("after collection");
    expect(read).toHaveBeenCalledTimes(3);
  });

  it("uses Query observers for hook reads without focus or reconnect refetches", async () => {
    const queries = client();
    const read = vi.fn().mockResolvedValue(["user"]);
    const hook = renderHook(() => useSavedQuery({ queryKey: ["users"], queryFn: read }), {
      wrapper: ({ children }) => <QueryClientProvider client={queries}>{children}</QueryClientProvider>,
    });
    await waitFor(() => expect(hook.result.current.isSuccess).toBe(true));
    act(() => { window.dispatchEvent(new Event("focus")); window.dispatchEvent(new Event("online")); });
    expect(read).toHaveBeenCalledOnce();
    hook.unmount();
  });
});
