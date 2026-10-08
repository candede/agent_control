import { act, cleanup, renderHook } from "@testing-library/react";
import { StrictMode, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, checkAutomaticRefresh, type AutomaticRefreshResult, type DataSyncSourceId, type DataSyncSourceState } from "./api/client";
import { useAutomaticRefresh } from "./useAutomaticRefresh";

vi.mock("./api/client", async importOriginal => ({
  ...await importOriginal<typeof import("./api/client")>(),
  checkAutomaticRefresh: vi.fn(),
}));

const check = vi.mocked(checkAutomaticRefresh);
const revisions = { users: "3".repeat(64), graph_packages: "1".repeat(64), power_platform: "2".repeat(64) };
function response(overrides: Partial<AutomaticRefreshResult> = {}): AutomaticRefreshResult {
  return {
    run: null,
    detailJob: null,
    revisions,
    nextCheckAt: new Date(Date.now() + 60_000).toISOString(),
    ...overrides,
  };
}
function sourceRun(source: DataSyncSourceId, status: DataSyncSourceState, automatic = true): NonNullable<AutomaticRefreshResult["run"]> {
  const updatedAt = new Date().toISOString();
  return {
    id: "sync-run", mode: "incremental", automatic, status: status === "succeeded" ? "completed" : "running",
    startedAt: updatedAt, updatedAt, completedAt: null,
    sources: [{ source, status, jobId: "source-job", count: null, lastSuccessAt: status === "succeeded" ? updatedAt : null, updatedAt, message: "", canRetry: false }],
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function options(overrides: Partial<Parameters<typeof useAutomaticRefresh>[0]> = {}) {
  return {
    principalKey: "tenant:account:viewer:session-1",
    authorizationKey: "allowed",
    enabled: true,
    onSourcesChanged: vi.fn(),
    onRunsChanged: vi.fn(),
    ...overrides,
  };
}
async function settle() {
  await act(async () => { await Promise.resolve(); });
}
async function advance(ms: number) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}
async function visible(value: boolean) {
  vi.spyOn(document, "visibilityState", "get").mockReturnValue(value ? "visible" : "hidden");
  await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
}
async function online(value: boolean) {
  vi.spyOn(navigator, "onLine", "get").mockReturnValue(value);
  await act(async () => { window.dispatchEvent(new Event(value ? "online" : "offline")); });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-24T10:00:00Z"));
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
  check.mockReset().mockImplementation(async () => response());
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("automatic saved-data refresh", () => {
  it.each(["active", "idle"] as const)("bounds a 45-minute %s session without manufacturing a publication", async mode => {
    const props = options();
    const hook = renderHook(useAutomaticRefresh, { initialProps: props });
    await settle();
    act(() => hook.result.current.admitPublication(revisions));
    if (mode === "idle") await visible(false);
    for (let minute = 0; minute < 45; minute++) {
      await advance(60_000);
      expect(props.onSourcesChanged).not.toHaveBeenCalled();
      expect(check).toHaveBeenCalledTimes(mode === "idle" ? 1 : minute + 2);
    }
    if (mode === "idle") {
      await visible(true);
      expect(check).toHaveBeenCalledTimes(2);
      await advance(59_999);
      expect(check).toHaveBeenCalledTimes(2);
      await advance(1);
      expect(check).toHaveBeenCalledTimes(3);
    }
    expect(props.onSourcesChanged).not.toHaveBeenCalled();
  });

  it.each(["page-first", "observer-first"] as const)("handshakes %s without a no-change startup reread", async order => {
    const pending = deferred<AutomaticRefreshResult>();
    check.mockReturnValueOnce(pending.promise);
    const props = options();
    const hook = renderHook(useAutomaticRefresh, { initialProps: props });
    await settle();
    if (order === "page-first") act(() => hook.result.current.admitPublication(revisions));
    await act(async () => pending.resolve(response()));
    if (order === "observer-first") act(() => hook.result.current.admitPublication(revisions));
    expect(check).toHaveBeenCalledTimes(1);
    expect(props.onSourcesChanged).not.toHaveBeenCalled();
    await advance(60_000);
    expect(check).toHaveBeenCalledTimes(2);
    expect(props.onSourcesChanged).not.toHaveBeenCalled();
  });

  it.each(["page-first", "observer-first"] as const)("synchronizes one racing publication %s and retains acknowledgement across frozen rereads", async order => {
    const pending = deferred<AutomaticRefreshResult>();
    const published = { ...revisions, graph_packages: "4".repeat(64) };
    check.mockReturnValueOnce(pending.promise).mockImplementation(async () => response({ revisions: published }));
    const props = options();
    const hook = renderHook(useAutomaticRefresh, { initialProps: props });
    await settle();
    if (order === "page-first") act(() => hook.result.current.admitPublication(revisions));
    await act(async () => pending.resolve(response({ revisions: published })));
    if (order === "observer-first") act(() => hook.result.current.admitPublication(revisions));
    expect(props.onSourcesChanged).toHaveBeenCalledExactlyOnceWith(["graph_packages"]);
    act(() => hook.result.current.admitPublication(revisions));
    hook.rerender({ ...props });
    await advance(12 * 60_000);
    expect(check).toHaveBeenCalledTimes(13);
    expect(props.onSourcesChanged).toHaveBeenCalledTimes(1);
  });

  it("coalesces publication hints, never treats progress or a provider 504 as content, and preserves retry admission", async () => {
    const props = options();
    const hook = renderHook(useAutomaticRefresh, { initialProps: props });
    await settle();
    act(() => hook.result.current.admitPublication(revisions));
    const pending = deferred<AutomaticRefreshResult>();
    check.mockReturnValueOnce(pending.promise);
    act(() => { for (let i = 0; i < 5; i++) hook.result.current.checkNow(); });
    expect(check).toHaveBeenCalledTimes(2);
    await act(async () => pending.resolve(response({ run: sourceRun("graph_packages", "running") })));
    await advance(0);
    expect(check).toHaveBeenCalledTimes(3);
    expect(props.onSourcesChanged).not.toHaveBeenCalled();
    check.mockRejectedValueOnce(new ApiError(504, "provider_unavailable", "Provider deadline exceeded."));
    act(() => hook.result.current.checkNow());
    await settle();
    expect(check).toHaveBeenCalledTimes(4);
    expect(hook.result.current.phase).toBe("backoff");
    act(() => { for (let i = 0; i < 5; i++) hook.result.current.checkNow(); });
    await advance(59_999);
    expect(check).toHaveBeenCalledTimes(4);
    expect(props.onSourcesChanged).not.toHaveBeenCalled();
    check.mockResolvedValueOnce(response({ revisions: { ...revisions, graph_packages: "4".repeat(64) } }));
    await advance(1);
    expect(check).toHaveBeenCalledTimes(5);
    expect(props.onSourcesChanged).toHaveBeenCalledExactlyOnceWith(["graph_packages"]);
    act(() => { hook.result.current.setPaused(true); hook.result.current.checkNow(); });
    await advance(60_000);
    expect(check).toHaveBeenCalledTimes(5);
  });

  it.each([
    { ...revisions, users: "A".repeat(64) },
    { ...revisions, other_source: "4".repeat(64) },
  ])("rejects an invalid observer vector without acknowledging or invalidating selected content: %j", async invalid => {
    check.mockResolvedValueOnce(response({ revisions: invalid }));
    const props = options();
    const hook = renderHook(useAutomaticRefresh, { initialProps: props });
    await settle();
    act(() => hook.result.current.admitPublication(revisions));
    expect(hook.result.current.phase).toBe("backoff");
    expect(hook.result.current.publicationRevisions).toBeUndefined();
    expect(props.onSourcesChanged).not.toHaveBeenCalled();
    expect(props.onRunsChanged).not.toHaveBeenCalled();
    expect(check).toHaveBeenCalledOnce();
  });

  it("separates active browser checks from ongoing server refreshes and clears activity after failures", async () => {
    const initial = deferred<AutomaticRefreshResult>();
    const later = deferred<AutomaticRefreshResult>();
    check.mockReturnValueOnce(initial.promise).mockReturnValueOnce(later.promise);
    const props = options({ enabled: false });
    const hook = renderHook(useAutomaticRefresh, { initialProps: props });
    expect(hook.result.current.checking).toBe(false);
    hook.rerender({ ...props, enabled: true });
    await settle();
    expect(hook.result.current.checking).toBe(true);
    await act(async () => initial.resolve(response({ run: sourceRun("users", "running") })));
    expect(hook.result.current.phase).toBe("refreshing");
    expect(hook.result.current.checking).toBe(false);
    await advance(59_999);
    expect(hook.result.current.checking).toBe(false);
    await advance(1);
    expect(hook.result.current.checking).toBe(true);
    await act(async () => later.reject(new ApiError(503, "unavailable", "Status check unavailable")));
    expect(hook.result.current.phase).toBe("backoff");
    expect(hook.result.current.checking).toBe(false);
  });

  it("checks after valid sign-in and invalidates only changed admitted source revisions", async () => {
    const props = options({ enabled: false });
    const { rerender, result } = renderHook(useAutomaticRefresh, { initialProps: props });
    await settle();
    expect(check).not.toHaveBeenCalled();
    rerender({ ...props, enabled: true });
    await settle();
    act(() => result.current.admitPublication(revisions));
    expect(check).toHaveBeenCalledTimes(1);
    expect(props.onSourcesChanged).not.toHaveBeenCalled();
    await advance(60_000);
    expect(check).toHaveBeenCalledTimes(2);
    expect(props.onSourcesChanged).not.toHaveBeenCalled();
    expect(props.onRunsChanged).not.toHaveBeenCalled();
    check.mockImplementation(async () => response({ revisions: { ...revisions, users: "4".repeat(64) } }));
    await advance(60_000);
    expect(props.onSourcesChanged).toHaveBeenLastCalledWith(["users"]);
    expect(props.onSourcesChanged).toHaveBeenCalledTimes(1);
  });

  it("admits only one check during StrictMode setup and never overlaps slow requests", async () => {
    const pending = deferred<AutomaticRefreshResult>();
    check.mockReturnValueOnce(pending.promise);
    const props = options();
    const hook = renderHook(useAutomaticRefresh, { initialProps: props, wrapper: ({ children }: { children: ReactNode }) => <StrictMode>{children}</StrictMode> });
    await settle();
    expect(check).toHaveBeenCalledTimes(1);
    expect(hook.result.current.checking).toBe(true);
    await advance(10 * 60_000);
    expect(check).toHaveBeenCalledTimes(1);
    expect(hook.result.current.checking).toBe(false);
    expect(hook.result.current.phase).toBe("backoff");
    await act(async () => pending.resolve(response()));
    await advance(0);
    expect(check).toHaveBeenCalledTimes(2);
    await advance(60_000);
    expect(check).toHaveBeenCalledTimes(3);
  });

  it("does not admit hidden or offline checks, resumes overdue checks immediately, and preserves cadence otherwise", async () => {
    await visible(false);
    renderHook(useAutomaticRefresh, { initialProps: options() });
    await advance(120_000);
    act(() => window.dispatchEvent(new Event("focus")));
    expect(check).not.toHaveBeenCalled();
    await visible(true);
    expect(check).toHaveBeenCalledTimes(1);
    await visible(false);
    await advance(30_000);
    await visible(true);
    expect(check).toHaveBeenCalledTimes(1);
    await online(false);
    await advance(120_000);
    act(() => window.dispatchEvent(new Event("focus")));
    expect(check).toHaveBeenCalledTimes(1);
    await visible(false);
    await online(true);
    expect(check).toHaveBeenCalledTimes(1);
    await visible(true);
    expect(check).toHaveBeenCalledTimes(2);
  });

  it.each(["hidden", "offline", "signout"] as const)("discards in-flight results after %s and waits for a retired transport before resuming", async reason => {
    const pending = deferred<AutomaticRefreshResult>();
    check.mockReturnValueOnce(pending.promise);
    const props = options();
    const hook = renderHook(useAutomaticRefresh, { initialProps: props });
    await settle();
    const signal = check.mock.calls[0][0]!.signal!;
    expect(hook.result.current.checking).toBe(true);
    if (reason === "hidden") await visible(false);
    else if (reason === "offline") await online(false);
    else hook.rerender({ ...props, enabled: false });
    expect(signal.aborted).toBe(true);
    expect(hook.result.current.checking).toBe(false);
    await act(async () => pending.resolve(response()));
    expect(props.onSourcesChanged).not.toHaveBeenCalled();
    expect(props.onRunsChanged).not.toHaveBeenCalled();
    await advance(600_000);
    expect(check).toHaveBeenCalledTimes(1);
    if (reason === "hidden") await visible(true);
    else if (reason === "offline") await online(true);
    else hook.rerender(props);
    await settle();
    expect(check).toHaveBeenCalledTimes(2);
    expect(props.onSourcesChanged).not.toHaveBeenCalled();
  });

  it.each(["principalKey", "authorizationKey"] as const)("fences stale responses and private errors across a changed %s", async field => {
    const pending = deferred<AutomaticRefreshResult>();
    check.mockReturnValueOnce(pending.promise);
    const first = options();
    const hook = renderHook(useAutomaticRefresh, { initialProps: first });
    await settle();
    expect(hook.result.current.checking).toBe(true);
    const next = options({ [field]: "new-scope" });
    hook.rerender(next);
    expect(check.mock.calls[0][0]!.signal!.aborted).toBe(true);
    expect(hook.result.current.checking).toBe(false);
    await settle();
    expect(check).toHaveBeenCalledTimes(1);
    await act(async () => pending.resolve(response({
      run: null,
      detailJob: { id: "private-old-job", status: "failed", updatedAt: "old", message: "private old account result" },
    })));
    expect(first.onSourcesChanged).not.toHaveBeenCalled();
    expect(first.onRunsChanged).not.toHaveBeenCalled();
    expect(next.onSourcesChanged).not.toHaveBeenCalled();
    expect(check).toHaveBeenCalledTimes(2);
    expect(hook.result.current.message).toBeUndefined();
    expect(hook.result.current.phase).toBe("ready");
    expect(hook.result.current.checking).toBe(false);
  });

  it.each((["paused", "hidden", "offline"] as const).flatMap(reason =>
    (["success", "sign-in", "denied", "failure"] as const).map(outcome => ({ reason, outcome })),
  ))("retires a check when $reason before a same-turn $outcome response settles", async ({ reason, outcome }) => {
    const pending = deferred<AutomaticRefreshResult>();
    check.mockReturnValueOnce(pending.promise);
    const props = options();
    const hook = renderHook(useAutomaticRefresh, { initialProps: props });
    await settle();
    const signal = check.mock.calls[0][0]!.signal!;
    await act(async () => {
      if (reason === "paused") hook.result.current.setPaused(true);
      else if (reason === "hidden") {
        vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
        document.dispatchEvent(new Event("visibilitychange"));
      } else {
        vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
        window.dispatchEvent(new Event("offline"));
      }
      if (outcome === "success") pending.resolve(response({ run: sourceRun("users", "failed") }));
      else pending.reject(outcome === "sign-in" ? new ApiError(401, "interaction_required", "Retired sign-in failure")
        : outcome === "denied" ? new ApiError(403, "forbidden", "Retired permission failure")
          : new Error("Retired network failure"));
    });
    expect(props.onSourcesChanged).not.toHaveBeenCalled();
    expect(props.onRunsChanged).not.toHaveBeenCalled();
    expect(signal.aborted).toBe(true);
    expect(hook.result.current.checking).toBe(false);
    expect(hook.result.current.message).toBeUndefined();
    if (reason === "paused") act(() => hook.result.current.setPaused(false));
    else if (reason === "hidden") await visible(true);
    else await online(true);
    await settle();
    expect(check).toHaveBeenCalledTimes(2);
    expect(props.onSourcesChanged).not.toHaveBeenCalled();
    expect(hook.result.current.phase).toBe("ready");
  });

  it("does not admit an overdue focus check in the same turn as a session pause", async () => {
    const hook = renderHook(useAutomaticRefresh, { initialProps: options() });
    await settle();
    vi.setSystemTime(Date.now() + 120_000);
    act(() => {
      hook.result.current.setPaused(true);
      window.dispatchEvent(new Event("focus"));
    });
    await settle();
    expect(check).toHaveBeenCalledTimes(1);
    expect(hook.result.current.paused).toBe(true);
    expect(hook.result.current.checking).toBe(false);
    act(() => hook.result.current.setPaused(false));
    await settle();
    expect(check).toHaveBeenCalledTimes(2);
  });

  it.each(["paused", "hidden", "offline"] as const)("keeps a check retired across batched %s and recovery events", async reason => {
    const retired = deferred<AutomaticRefreshResult>();
    const current = deferred<AutomaticRefreshResult>();
    check.mockReturnValueOnce(retired.promise).mockReturnValueOnce(current.promise);
    const props = options();
    const hook = renderHook(useAutomaticRefresh, { initialProps: props });
    await settle();
    const signal = check.mock.calls[0][0]!.signal!;
    act(() => {
      if (reason === "paused") {
        hook.result.current.setPaused(true);
        hook.result.current.setPaused(false);
      } else if (reason === "hidden") {
        vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
        document.dispatchEvent(new Event("visibilitychange"));
        vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
        document.dispatchEvent(new Event("visibilitychange"));
      } else {
        vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
        window.dispatchEvent(new Event("offline"));
        vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
        window.dispatchEvent(new Event("online"));
      }
      window.dispatchEvent(new Event("focus"));
    });
    expect(signal.aborted).toBe(true);
    expect(hook.result.current.checking).toBe(false);
    await advance(30_000);
    expect(check).toHaveBeenCalledTimes(1);
    expect(hook.result.current.message).toBeUndefined();
    await act(async () => retired.reject(new ApiError(401, "interaction_required", "Retired sign-in failure")));
    await advance(0);
    expect(check).toHaveBeenCalledTimes(2);
    expect(hook.result.current.checking).toBe(true);
    await act(async () => current.resolve(response()));
    expect(props.onSourcesChanged).not.toHaveBeenCalled();
    expect(props.onRunsChanged).not.toHaveBeenCalled();
    expect(hook.result.current.phase).toBe("ready");
    expect(hook.result.current.checking).toBe(false);
  });

  it("does not revive an aborted request indicator when pausing and resuming before the transport settles", async () => {
    const previous = deferred<AutomaticRefreshResult>();
    const current = deferred<AutomaticRefreshResult>();
    check.mockReturnValueOnce(previous.promise).mockReturnValueOnce(current.promise);
    const hook = renderHook(useAutomaticRefresh, { initialProps: options() });
    await settle();
    expect(hook.result.current.checking).toBe(true);
    act(() => hook.result.current.setPaused(true));
    expect(hook.result.current.checking).toBe(false);
    act(() => hook.result.current.setPaused(false));
    await settle();
    expect(hook.result.current.checking).toBe(false);
    expect(check).toHaveBeenCalledTimes(1);
    await act(async () => previous.resolve(response()));
    expect(check).toHaveBeenCalledTimes(2);
    expect(hook.result.current.checking).toBe(true);
    await act(async () => current.resolve(response()));
    expect(hook.result.current.checking).toBe(false);
  });

  it("uses bounded exponential backoff and returns to minute checks after success", async () => {
    check.mockRejectedValue(new ApiError(503, "unavailable", "not available"));
    const hook = renderHook(useAutomaticRefresh, { initialProps: options() });
    await settle();
    expect(hook.result.current.phase).toBe("backoff");
    let calls = 1;
    for (const delay of [60_000, 120_000, 240_000, 300_000, 300_000]) {
      await advance(delay - 1);
      expect(check).toHaveBeenCalledTimes(calls);
      await advance(1);
      expect(check).toHaveBeenCalledTimes(++calls);
    }
    check.mockImplementation(async () => response());
    await advance(300_000);
    expect(hook.result.current.phase).toBe("ready");
    await advance(60_000);
    expect(check).toHaveBeenCalledTimes(calls + 2);
  });

  it("does not bypass backoff on visibility or connectivity return", async () => {
    check.mockRejectedValue(new Error("transport"));
    renderHook(useAutomaticRefresh, { initialProps: options() });
    await settle();
    await visible(false);
    await online(false);
    await advance(30_000);
    await visible(true);
    await online(true);
    expect(check).toHaveBeenCalledTimes(1);
    await advance(30_000);
    expect(check).toHaveBeenCalledTimes(2);
  });

  it("wakes an overdue check on focus after timer suspension without duplicating work", async () => {
    const pending = deferred<AutomaticRefreshResult>();
    const props = options();
    const hook = renderHook(useAutomaticRefresh, { initialProps: props });
    await settle();
    expect(check).toHaveBeenCalledTimes(1);
    check.mockReturnValueOnce(pending.promise);
    vi.setSystemTime(Date.now() + 120_000);
    act(() => {
      window.dispatchEvent(new Event("focus"));
      window.dispatchEvent(new Event("focus"));
    });
    expect(check).toHaveBeenCalledTimes(2);
    await act(async () => pending.resolve(response()));
    expect(props.onSourcesChanged).not.toHaveBeenCalled();
    expect(props.onRunsChanged).not.toHaveBeenCalled();
    await advance(59_999);
    act(() => window.dispatchEvent(new Event("focus")));
    expect(check).toHaveBeenCalledTimes(2);
    await advance(1);
    expect(check).toHaveBeenCalledTimes(3);
    hook.unmount();
    vi.setSystemTime(Date.now() + 120_000);
    act(() => window.dispatchEvent(new Event("focus")));
    expect(check).toHaveBeenCalledTimes(3);
  });

  it("does not bypass retry delays or a session pause on focus", async () => {
    check.mockRejectedValue(new Error("transport"));
    const hook = renderHook(useAutomaticRefresh, { initialProps: options() });
    await settle();
    vi.setSystemTime(Date.now() + 30_000);
    act(() => window.dispatchEvent(new Event("focus")));
    expect(check).toHaveBeenCalledTimes(1);
    act(() => hook.result.current.setPaused(true));
    vi.setSystemTime(Date.now() + 120_000);
    act(() => window.dispatchEvent(new Event("focus")));
    expect(check).toHaveBeenCalledTimes(1);
    expect(hook.result.current.message).not.toContain("Retrying with a delay");
    act(() => hook.result.current.setPaused(false));
    await settle();
    expect(check).toHaveBeenCalledTimes(2);
  });

  it("bounds a stalled check and backs off rather than overlapping it", async () => {
    check.mockImplementationOnce(({ signal } = {}) => new Promise((_resolve, reject) => {
      signal!.addEventListener("abort", () => reject(new ApiError(0, "request_aborted", "aborted", { kind: "aborted" })), { once: true });
    }));
    const hook = renderHook(useAutomaticRefresh, { initialProps: options() });
    await settle();
    expect(hook.result.current.checking).toBe(true);
    await advance(30_000);
    expect(check.mock.calls[0][0]!.signal!.aborted).toBe(true);
    expect(hook.result.current.phase).toBe("backoff");
    expect(hook.result.current.checking).toBe(false);
    await advance(59_999);
    expect(check).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(check).toHaveBeenCalledTimes(2);
  });

  it.each(["resolve", "reject"] as const)("reports a timeout even if the aborted transport settles late by %s", async outcome => {
    const pending = deferred<AutomaticRefreshResult>();
    const props = options();
    check.mockReturnValueOnce(pending.promise);
    const hook = renderHook(useAutomaticRefresh, { initialProps: props });
    await settle();
    await advance(30_000);
    expect(check.mock.calls[0][0]!.signal!.aborted).toBe(true);
    expect(hook.result.current.checking).toBe(false);
    expect(hook.result.current.phase).toBe("backoff");
    expect(hook.result.current.message).toContain("could not be checked");
    await advance(120_000);
    expect(check).toHaveBeenCalledTimes(1);
    expect(props.onSourcesChanged).not.toHaveBeenCalled();
    await act(async () => {
      if (outcome === "resolve") pending.resolve(response({ run: sourceRun("users", "failed") }));
      else pending.reject(new ApiError(401, "interaction_required", "Retired authentication failure"));
    });
    await advance(0);
    expect(check).toHaveBeenCalledTimes(2);
    expect(props.onSourcesChanged).not.toHaveBeenCalled();
    expect(props.onRunsChanged).not.toHaveBeenCalled();
    expect(hook.result.current.phase).toBe("ready");
  });

  it("retains the sign-in requirement across permission changes until the session changes", async () => {
    check.mockRejectedValueOnce(new ApiError(401, "interaction_required", "Sign-in needed"));
    const props = options();
    const hook = renderHook(useAutomaticRefresh, { initialProps: props });
    await settle();
    hook.rerender({ ...props, authorizationKey: "permission-rechecked" });
    await advance(600_000);
    act(() => window.dispatchEvent(new Event("focus")));
    expect(hook.result.current.phase).toBe("sign_in_required");
    expect(check).toHaveBeenCalledTimes(1);
  });

  it("pauses API-session interaction-required results without starting interactive auth or retry storms", async () => {
    check.mockRejectedValue(new ApiError(401, "interaction_required", "MFA required"));
    const props = options();
    const hook = renderHook(useAutomaticRefresh, { initialProps: props });
    await settle();
    expect(hook.result.current.phase).toBe("sign_in_required");
    act(() => hook.result.current.admitPublication(revisions));
    expect(hook.result.current.checking).toBe(false);
    const calls = check.mock.calls.length;
    await advance(3_600_000);
    await visible(false);
    await visible(true);
    act(() => hook.result.current.setPaused(true));
    act(() => hook.result.current.setPaused(false));
    expect(check).toHaveBeenCalledTimes(calls);
    check.mockImplementation(async () => response());
    hook.rerender({ ...props, principalKey: "new-valid-session" });
    await settle();
    expect(check).toHaveBeenCalledTimes(calls + 1);
    expect(hook.result.current.phase).toBe("ready");
  });

  it.each(["source", "detail"] as const)("keeps healthy sources eligible when a %s job needs authorization", async kind => {
    check.mockResolvedValueOnce(response(kind === "source"
      ? { run: sourceRun("graph_packages", "waiting_authorization") }
      : { detailJob: { id: "details", status: "waiting_authorization", errorCode: "interaction_required", updatedAt: "now" } }));
    const props = options();
    const hook = renderHook(useAutomaticRefresh, { initialProps: props });
    await settle();
    act(() => hook.result.current.admitPublication(revisions));
    expect(hook.result.current.phase).toBe("sign_in_required");
    check.mockResolvedValueOnce(response({
      run: sourceRun("users", "succeeded"),
      revisions: { ...revisions, users: "4".repeat(64) },
    }));
    await advance(60_000);
    expect(check).toHaveBeenCalledTimes(2);
    expect(hook.result.current.phase).toBe("sign_in_required");
    expect(hook.result.current.message).toContain("this does not block other eligible sources");
    expect(props.onSourcesChanged).toHaveBeenLastCalledWith(["users"]);
    check.mockResolvedValueOnce(response(kind === "source"
      ? { run: sourceRun("graph_packages", "succeeded") }
      : { detailJob: { id: "details-new", status: "succeeded", updatedAt: "later" } }));
    await advance(60_000);
    expect(hook.result.current.phase).toBe("ready");
  });

  it.each(["source", "detail"] as const)("clears the stale %s sign-in warning when a new attempt starts", async kind => {
    check.mockResolvedValueOnce(response(kind === "source"
      ? { run: sourceRun("graph_packages", "waiting_authorization") }
      : { detailJob: { id: "details", status: "failed", errorCode: "interaction_required", updatedAt: "now" } }));
    const hook = renderHook(useAutomaticRefresh, { initialProps: options() });
    await settle();
    expect(hook.result.current.phase).toBe("sign_in_required");
    check.mockResolvedValueOnce(response(kind === "source"
      ? { run: sourceRun("graph_packages", "running") }
      : { detailJob: { id: "new-details", status: "running", updatedAt: "later" } }));
    await advance(60_000);
    expect(hook.result.current.phase).toBe("refreshing");
    expect(hook.result.current.message).toBeUndefined();
  });

  it.each([
    ["missing_permission", "permission_required"],
    ["capability_unavailable", "permission_required"],
    ["authorization_expired", "sign_in_required"],
    ["provider_timeout", "failed"],
  ] as const)("classifies failed detail enrichment with %s as %s", async (errorCode, phase) => {
    check.mockResolvedValueOnce(response({
      detailJob: { id: "details", status: "failed", errorCode, updatedAt: "now" },
    }));
    const hook = renderHook(useAutomaticRefresh, { initialProps: options() });
    await settle();
    expect(hook.result.current.phase).toBe(phase);
  });

  it("does not mistake a newly claimed detail job for an authentication failure", async () => {
    check.mockResolvedValueOnce(response({
      detailJob: { id: "details", status: "waiting_authorization", updatedAt: "now" },
    }));
    const hook = renderHook(useAutomaticRefresh, { initialProps: options() });
    await settle();
    expect(hook.result.current.phase).toBe("refreshing");
  });

  it("leaves access denials visible and only retries after permission evidence changes", async () => {
    check.mockRejectedValue(new ApiError(403, "forbidden", "denied"));
    const props = options();
    const hook = renderHook(useAutomaticRefresh, { initialProps: props });
    await settle();
    expect(hook.result.current.phase).toBe("permission_required");
    expect(hook.result.current.checking).toBe(false);
    await advance(3_600_000);
    act(() => window.dispatchEvent(new Event("focus")));
    expect(check).toHaveBeenCalledTimes(1);
    check.mockImplementation(async () => response());
    hook.rerender({ ...props, authorizationKey: "new-permission-evidence" });
    await settle();
    expect(check).toHaveBeenCalledTimes(2);
  });

  it("rechecks changed permission evidence without invalidating unchanged publications or jobs", async () => {
    const run = sourceRun("users", "succeeded");
    check.mockImplementation(async () => response({ run }));
    const props = options();
    const hook = renderHook(useAutomaticRefresh, { initialProps: props });
    await settle();
    expect(props.onSourcesChanged).not.toHaveBeenCalled();
    expect(props.onRunsChanged).toHaveBeenCalledOnce();
    hook.rerender({ ...props, authorizationKey: "permission-rechecked" });
    await settle();
    expect(check).toHaveBeenCalledTimes(2);
    expect(props.onSourcesChanged).not.toHaveBeenCalled();
    expect(props.onRunsChanged).toHaveBeenCalledOnce();
  });

  it("lets users pause new work for this session without erasing saved data and resets for another session", async () => {
    const props = options();
    const hook = renderHook(useAutomaticRefresh, { initialProps: props });
    await settle();
    act(() => hook.result.current.setPaused(true));
    await advance(3_600_000);
    expect(check).toHaveBeenCalledTimes(1);
    expect(hook.result.current.paused).toBe(true);
    hook.rerender({ ...props, authorizationKey: "permissions-updated" });
    await settle();
    expect(check).toHaveBeenCalledTimes(1);
    hook.rerender({ ...props, principalKey: "new-session" });
    await settle();
    expect(check).toHaveBeenCalledTimes(2);
    expect(hook.result.current.paused).toBe(false);
  });

  it("does not let a retired account's pause control resume the current account", async () => {
    const props = options();
    const hook = renderHook(useAutomaticRefresh, { initialProps: props });
    await settle();
    const retiredSetPaused = hook.result.current.setPaused;
    hook.rerender({ ...props, principalKey: "another-account" });
    await settle();
    act(() => hook.result.current.setPaused(true));
    act(() => retiredSetPaused(false));
    expect(hook.result.current.paused).toBe(true);
    await advance(120_000);
    expect(check).toHaveBeenCalledTimes(2);
  });

  it("retains source authorization guidance without claiming paused sources are refreshing", async () => {
    check.mockResolvedValueOnce(response({ run: sourceRun("graph_packages", "waiting_authorization") }));
    const hook = renderHook(useAutomaticRefresh, { initialProps: options() });
    await settle();
    act(() => hook.result.current.setPaused(true));
    expect(hook.result.current.phase).toBe("sign_in_required");
    expect(hook.result.current.message).toContain("Some sources require Microsoft authorization");
    expect(hook.result.current.message).not.toContain("other eligible sources continue automatically");
  });

  it("updates Sync history when jobs change even without a new source publication", async () => {
    const props = options();
    renderHook(useAutomaticRefresh, { initialProps: props });
    await settle();
    check.mockImplementation(async () => response({
      detailJob: { id: "detail-job", status: "running", updatedAt: new Date().toISOString() },
    }));
    await advance(60_000);
    expect(props.onSourcesChanged).not.toHaveBeenCalled();
    expect(props.onRunsChanged).toHaveBeenCalledTimes(1);
  });

  it.each(["failed", "permission_required"] as const)("keeps a source %s visible across cooldown checks until a new attempt starts", async status => {
    check.mockResolvedValueOnce(response({ run: sourceRun("graph_packages", status) }));
    const hook = renderHook(useAutomaticRefresh, { initialProps: options() });
    await settle();
    expect(hook.result.current.phase).toBe(status);
    const pending = deferred<AutomaticRefreshResult>();
    check.mockReturnValueOnce(pending.promise);
    await advance(60_000);
    expect(hook.result.current.phase).toBe(status);
    expect(hook.result.current.checking).toBe(true);
    await act(async () => pending.resolve(response()));
    expect(hook.result.current.phase).toBe(status);
    expect(hook.result.current.checking).toBe(false);
    check.mockResolvedValueOnce(response({ run: sourceRun("users", "succeeded") }));
    await advance(60_000);
    expect(hook.result.current.phase).toBe(status);
    check.mockResolvedValueOnce(response({ run: sourceRun("graph_packages", "running") }));
    await advance(60_000);
    expect(hook.result.current.phase).toBe("refreshing");
    check.mockResolvedValueOnce(response({ run: sourceRun("graph_packages", "succeeded") }));
    await advance(60_000);
    expect(hook.result.current.phase).toBe("ready");
    expect(hook.result.current.message).toBeUndefined();
  });

  it("does not clear failed detail collection when the inventory succeeds or an idle check returns no detail job", async () => {
    check.mockResolvedValueOnce(response({
      detailJob: { id: "details", status: "failed", updatedAt: "now" },
    }));
    const hook = renderHook(useAutomaticRefresh, { initialProps: options() });
    await settle();
    await advance(60_000);
    expect(hook.result.current.phase).toBe("failed");
    check.mockResolvedValueOnce(response({ run: sourceRun("graph_packages", "succeeded") }));
    await advance(60_000);
    expect(hook.result.current.phase).toBe("failed");
    check.mockResolvedValueOnce(response({
      detailJob: { id: "details-retry", status: "running", updatedAt: "later" },
    }));
    await advance(60_000);
    expect(hook.result.current.phase).toBe("refreshing");
    check.mockResolvedValueOnce(response({
      detailJob: { id: "details-retry", status: "succeeded", updatedAt: "later" },
    }));
    await advance(60_000);
    expect(hook.result.current.phase).toBe("ready");
  });

  it("defers quietly to a manual active run without treating its authorization request as automatic reauthentication", async () => {
    check.mockImplementation(async () => response({ run: sourceRun("graph_packages", "waiting_authorization", false) }));
    const props = options();
    const hook = renderHook(useAutomaticRefresh, { initialProps: props });
    await settle();
    expect(hook.result.current.phase).toBe("ready");
    expect(hook.result.current.message).toBeUndefined();
    expect(props.onRunsChanged).toHaveBeenCalledOnce();
    await advance(60_000);
    expect(check).toHaveBeenCalledTimes(2);
    expect(hook.result.current.phase).toBe("ready");
  });

  it("allows a successful manual collection to resolve an earlier automatic source failure", async () => {
    check.mockResolvedValueOnce(response({ run: sourceRun("users", "failed") }));
    const hook = renderHook(useAutomaticRefresh, { initialProps: options() });
    await settle();
    expect(hook.result.current.phase).toBe("failed");
    check.mockResolvedValueOnce(response({ run: sourceRun("users", "succeeded", false) }));
    await advance(60_000);
    expect(hook.result.current.phase).toBe("ready");
  });

  it("does not carry retained source failures into another account or session", async () => {
    check.mockResolvedValueOnce(response({ run: sourceRun("users", "failed") }));
    const props = options();
    const hook = renderHook(useAutomaticRefresh, { initialProps: props });
    await settle();
    expect(hook.result.current.phase).toBe("failed");
    hook.rerender({ ...props, principalKey: "new-account" });
    expect(hook.result.current.message).toBeUndefined();
    await settle();
    expect(hook.result.current.phase).toBe("ready");
  });

  it("aborts on unmount and never invokes retired invalidation callbacks", async () => {
    const pending = deferred<AutomaticRefreshResult>();
    check.mockReturnValue(pending.promise);
    const props = options();
    const hook = renderHook(useAutomaticRefresh, { initialProps: props });
    await settle();
    hook.unmount();
    expect(check.mock.calls[0][0]!.signal!.aborted).toBe(true);
    await act(async () => pending.resolve(response()));
    await advance(600_000);
    expect(check).toHaveBeenCalledTimes(1);
    expect(props.onSourcesChanged).not.toHaveBeenCalled();
  });
});
