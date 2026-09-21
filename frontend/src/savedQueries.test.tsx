import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSavedQueryClient, readSavedQuery, useSavedQuery } from "./savedQueries";
import { ApiError } from "./api/client";
import { SavedQueryProvider } from "./components/SavedQueryProvider";

const clients: ReturnType<typeof createSavedQueryClient>[] = [];
function client() {
  const value = createSavedQueryClient();
  clients.push(value);
  return value;
}
afterEach(() => { clients.splice(0).forEach(value => value.clear()); });

describe("saved server queries", () => {
  it("shares concurrent reads without coupling their cancellation", async () => {
    const queries = client();
    const first = new AbortController();
    const second = new AbortController();
    let complete!: (value: string) => void;
    let requestSignal!: AbortSignal;
    const read = vi.fn((signal: AbortSignal) => {
      requestSignal = signal;
      return new Promise<string>(resolve => { complete = resolve; });
    });
    const left = readSavedQuery(queries, ["users", { page: 0 }], read, first.signal);
    const right = readSavedQuery(queries, ["users", { page: 0 }], read, second.signal);
    const cancelled = expect(left).rejects.toMatchObject({ kind: "aborted" });
    first.abort();
    await cancelled;
    expect(requestSignal.aborted).toBe(false);
    complete("saved users");
    await expect(right).resolves.toBe("saved users");
    expect(read).toHaveBeenCalledOnce();
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

  it("does not silently retry failures and permits an explicit fresh read", async () => {
    const queries = client();
    const denied = new ApiError(403, "forbidden", "Access denied");
    const read = vi.fn().mockRejectedValueOnce(denied).mockResolvedValueOnce("authorized");
    await expect(readSavedQuery(queries, ["users"], read, new AbortController().signal)).rejects.toBe(denied);
    expect(read).toHaveBeenCalledOnce();
    await expect(readSavedQuery(queries, ["users"], read, new AbortController().signal)).resolves.toBe("authorized");
    expect(read).toHaveBeenCalledTimes(2);
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

  it("does not allow an ignored cancellation to repopulate a cleared client", async () => {
    const queries = client();
    let complete!: (value: string) => void;
    const pending = readSavedQuery(queries, ["private-users"], () => new Promise<string>(resolve => {
      complete = resolve;
    }), new AbortController().signal);
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
