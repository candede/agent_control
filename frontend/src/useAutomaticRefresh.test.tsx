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
const sources = ["users", "graph_packages", "power_platform"];
function response(overrides: Partial<AutomaticRefreshResult> = {}): AutomaticRefreshResult {
  return {
    run: null,
    detailJob: null,
    revisions: { users: "users-1", graph_packages: "packages-1", power_platform: "pp-1" },
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
  it("checks after valid sign-in, invalidates the first publication, then only changed source revisions", async () => {
    const props = options({ enabled: false });
    const { rerender } = renderHook(useAutomaticRefresh, { initialProps: props });
    await settle();
    expect(check).not.toHaveBeenCalled();
    rerender({ ...props, enabled: true });
    await settle();
    expect(check).toHaveBeenCalledTimes(1);
    expect(props.onSourcesChanged).toHaveBeenCalledExactlyOnceWith(sources);
    await advance(60_000);
    expect(check).toHaveBeenCalledTimes(2);
    expect(props.onSourcesChanged).toHaveBeenCalledTimes(1);
    expect(props.onRunsChanged).not.toHaveBeenCalled();
    check.mockImplementation(async () => response({ revisions: { users: "users-2", graph_packages: "packages-1", power_platform: "pp-1" } }));
    await advance(60_000);
    expect(props.onSourcesChanged).toHaveBeenLastCalledWith(["users"]);
    expect(props.onSourcesChanged).toHaveBeenCalledTimes(2);
  });

  it("admits only one check during StrictMode setup and never overlaps slow requests", async () => {
    const pending = deferred<AutomaticRefreshResult>();
    check.mockReturnValueOnce(pending.promise);
    const props = options();
    renderHook(useAutomaticRefresh, { initialProps: props, wrapper: ({ children }: { children: ReactNode }) => <StrictMode>{children}</StrictMode> });
    await settle();
    expect(check).toHaveBeenCalledTimes(1);
    await advance(10 * 60_000);
    expect(check).toHaveBeenCalledTimes(1);
    await act(async () => pending.resolve(response()));
    await advance(60_000);
    expect(check).toHaveBeenCalledTimes(2);
  });

  it("does not admit hidden or offline checks, resumes overdue checks immediately, and preserves cadence otherwise", async () => {
    await visible(false);
    renderHook(useAutomaticRefresh, { initialProps: options() });
    await advance(120_000);
    expect(check).not.toHaveBeenCalled();
    await visible(true);
    expect(check).toHaveBeenCalledTimes(1);
    await visible(false);
    await advance(30_000);
    await visible(true);
    expect(check).toHaveBeenCalledTimes(1);
    await online(false);
    await advance(120_000);
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
    if (reason === "hidden") await visible(false);
    else if (reason === "offline") await online(false);
    else hook.rerender({ ...props, enabled: false });
    expect(signal.aborted).toBe(true);
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
    expect(props.onSourcesChanged).toHaveBeenCalledExactlyOnceWith(sources);
  });

  it.each(["principalKey", "authorizationKey"] as const)("fences stale responses and private errors across a changed %s", async field => {
    const pending = deferred<AutomaticRefreshResult>();
    check.mockReturnValueOnce(pending.promise);
    const first = options();
    const hook = renderHook(useAutomaticRefresh, { initialProps: first });
    await settle();
    const next = options({ [field]: "new-scope" });
    hook.rerender(next);
    expect(check.mock.calls[0][0]!.signal!.aborted).toBe(true);
    await settle();
    expect(check).toHaveBeenCalledTimes(1);
    await act(async () => pending.resolve(response({
      run: null,
      detailJob: { id: "private-old-job", status: "failed", updatedAt: "old", message: "private old account result" },
    })));
    expect(first.onSourcesChanged).not.toHaveBeenCalled();
    expect(first.onRunsChanged).not.toHaveBeenCalled();
    expect(next.onSourcesChanged).toHaveBeenCalledExactlyOnceWith(sources);
    expect(check).toHaveBeenCalledTimes(2);
    expect(hook.result.current.message).toBeUndefined();
    expect(hook.result.current.phase).toBe("ready");
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

  it("bounds a stalled check and backs off rather than overlapping it", async () => {
    check.mockImplementationOnce(({ signal } = {}) => new Promise((_resolve, reject) => {
      signal!.addEventListener("abort", () => reject(new ApiError(0, "request_aborted", "aborted", { kind: "aborted" })), { once: true });
    }));
    const hook = renderHook(useAutomaticRefresh, { initialProps: options() });
    await settle();
    await advance(30_000);
    expect(check.mock.calls[0][0]!.signal!.aborted).toBe(true);
    expect(hook.result.current.phase).toBe("backoff");
    await advance(59_999);
    expect(check).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(check).toHaveBeenCalledTimes(2);
  });

  it("retains the sign-in requirement across permission changes until the session changes", async () => {
    check.mockRejectedValueOnce(new ApiError(401, "interaction_required", "Sign-in needed"));
    const props = options();
    const hook = renderHook(useAutomaticRefresh, { initialProps: props });
    await settle();
    hook.rerender({ ...props, authorizationKey: "permission-rechecked" });
    await advance(600_000);
    expect(hook.result.current.phase).toBe("sign_in_required");
    expect(check).toHaveBeenCalledTimes(1);
  });

  it("pauses API-session interaction-required results without starting interactive auth or retry storms", async () => {
    check.mockRejectedValue(new ApiError(401, "interaction_required", "MFA required"));
    const props = options();
    const hook = renderHook(useAutomaticRefresh, { initialProps: props });
    await settle();
    expect(hook.result.current.phase).toBe("sign_in_required");
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
    expect(hook.result.current.phase).toBe("sign_in_required");
    check.mockResolvedValueOnce(response({
      run: sourceRun("users", "succeeded"),
      revisions: { users: "users-2", graph_packages: "packages-1", power_platform: "pp-1" },
    }));
    await advance(60_000);
    expect(check).toHaveBeenCalledTimes(2);
    expect(hook.result.current.phase).toBe("sign_in_required");
    expect(hook.result.current.message).toContain("other eligible sources continue automatically");
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
    await advance(3_600_000);
    expect(check).toHaveBeenCalledTimes(1);
    check.mockImplementation(async () => response());
    hook.rerender({ ...props, authorizationKey: "new-permission-evidence" });
    await settle();
    expect(check).toHaveBeenCalledTimes(2);
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

  it("updates Sync history when jobs change even without a new source publication", async () => {
    const props = options();
    renderHook(useAutomaticRefresh, { initialProps: props });
    await settle();
    check.mockImplementation(async () => response({
      detailJob: { id: "detail-job", status: "running", updatedAt: new Date().toISOString() },
    }));
    await advance(60_000);
    expect(props.onSourcesChanged).toHaveBeenCalledTimes(1);
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
    await act(async () => pending.resolve(response()));
    expect(hook.result.current.phase).toBe(status);
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
