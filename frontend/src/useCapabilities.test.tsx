import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { capabilityDefinitions } from "../../backend/src/services/capabilityRegistry";
import { checkCapabilities, getCapabilities, getCurrentUser, subscribeSessionRevalidationRequired, type CapabilityId, type CapabilityView, type SessionUser } from "./api/client";
import { evidenceIsFresh, providerActionAllowed } from "./capabilityState";
import { retryPermissionRead, useCapabilities } from "./useCapabilities";
import { permissionIssues } from "./permissionIssues";
import { createSavedQueryClient } from "./savedQueries";

const user: SessionUser = {
  displayName: "Fixture",
  username: "fixture@example.invalid",
  homeAccountId: "fixture-a",
  tenantId: "tenant-a",
  roles: ["AgentControl.Viewer"],
};

function available(expiresAt = new Date(Date.now() + 60_000).toISOString(), capabilityId: CapabilityId = "graph.package.read.delegated"): CapabilityView {
  return {
    definition: capabilityDefinitions.find(definition => definition.id === capabilityId)!,
    decision: {
      capabilityId,
      status: "available",
      authorized: true,
      fresh: true,
      verification: "provider",
      checkedAt: new Date(Date.now() - 1_000).toISOString(),
      expiresAt,
      previewQualification: "not_required",
      remediation: [],
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("exposes the running check identity and retry mode only for the current session", async () => {
  let release!: (response: Response) => void;
  const held = new Promise<Response>(resolve => { release = resolve; });
  vi.stubGlobal("fetch", vi.fn(async (url: string) => url.startsWith("/api/capabilities/check")
    ? held : Response.json({ value: [available()] })));
  const { result, rerender } = renderHook(({ principal }: { principal: SessionUser | undefined }) => useCapabilities(principal),
    { initialProps: { principal: user as SessionUser | undefined } });
  await waitFor(() => expect(result.current.activeCheck).toMatchObject({ id: 1, retryFailed: false }));
  rerender({ principal: undefined });
  expect(result.current.activeCheck).toBeUndefined();
  await act(async () => release(Response.json({ value: [available()] })));
  expect(result.current.activeCheck).toBeUndefined();
});

it("gives a manual recheck a new run identity and hides completed progress", async () => {
  let release!: (response: Response) => void;
  vi.stubGlobal("fetch", vi.fn(async (url: string) => url.startsWith("/api/capabilities/check")
    ? new Promise<Response>(resolve => { release = resolve; }) : Response.json({ value: [available()] })));
  const { result } = renderHook(() => useCapabilities(user));
  await waitFor(() => expect(result.current.activeCheck).toEqual({ id: 1, retryFailed: false }));
  await act(async () => release(Response.json({ value: [available()] })));
  expect(result.current.activeCheck).toBeUndefined();
  let reload!: Promise<void>;
  await act(async () => { reload = result.current.reload(); });
  expect(result.current.activeCheck).toEqual({ id: 2, retryFailed: true });
  await act(async () => {
    release(Response.json({ value: [available()] }));
    await reload;
  });
  expect(result.current.activeCheck).toBeUndefined();
});

it.each(["catalog", "check"] as const)("shares overlapping manual rechecks while the %s is pending", async phase => {
  let release!: (response: Response) => void;
  let pendingSignal: AbortSignal | null | undefined;
  let hold = false;
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (hold && (phase === "catalog" ? url === "/api/capabilities" : url.startsWith("/api/capabilities/check"))) {
      pendingSignal = init?.signal;
      return new Promise<Response>(resolve => { release = resolve; });
    }
    return Response.json({ value: [available()] });
  });
  vi.stubGlobal("fetch", fetchMock);
  const { result } = renderHook(() => useCapabilities(user));
  await waitFor(() => expect(result.current.awaitingInitialCheck).toBeUndefined());
  hold = true;
  let first!: Promise<void>;
  let second!: Promise<void>;
  await act(async () => { first = result.current.reload(); });
  const signal = pendingSignal;
  const requests = fetchMock.mock.calls.length;
  act(() => { second = result.current.reload(); });
  expect(signal?.aborted).toBe(false);
  expect(fetchMock).toHaveBeenCalledTimes(requests);
  expect(result.current.loading || result.current.pending).toBe(true);
  hold = false;
  await act(async () => {
    release(Response.json({ value: [available()] }));
    await Promise.all([first, second]);
  });
  expect(fetchMock).toHaveBeenCalledTimes(4);
  expect(result.current.loading || result.current.pending).toBe(false);
  await act(async () => result.current.reload());
  expect(fetchMock).toHaveBeenCalledTimes(6);
});

it.each(["catalog", "check"] as const)("clears an earlier %s transport error when a manual retry starts", async phase => {
  let fail = true;
  let release!: (response: Response) => void;
  const fetchMock = vi.fn(async (url: string) => {
    if (fail && (phase === "catalog" ? url === "/api/capabilities" : url.startsWith("/api/capabilities/check"))) {
      return Response.json({ code: "request_throttled", detail: "Retry later." }, { status: 429 });
    }
    if (!fail && url === "/api/capabilities") return new Promise<Response>(resolve => { release = resolve; });
    return Response.json({ value: [available()] });
  });
  vi.stubGlobal("fetch", fetchMock);
  const { result } = renderHook(() => useCapabilities(user));
  await waitFor(() => expect(result.current.error).toBeDefined());
  fail = false;
  let retry!: Promise<void>;
  act(() => { retry = result.current.reload(); });
  expect(result.current.loading).toBe(true);
  expect(result.current.error).toBeUndefined();
  await act(async () => {
    release(Response.json({ value: [available()] }));
    await retry;
  });
  expect(result.current.error).toBeUndefined();
  expect(result.current.loading || result.current.pending).toBe(false);
});

it.each(["catalog", "check"] as const)("retires a manual %s recheck without interfering with the replacement account's recheck", async phase => {
  const held: Array<{ release: (response: Response) => void; signal: AbortSignal | null | undefined }> = [];
  let hold = false;
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (hold && (phase === "catalog" ? url === "/api/capabilities" : url.startsWith("/api/capabilities/check"))) {
      return new Promise<Response>(release => { held.push({ release, signal: init?.signal }); });
    }
    return Response.json({ value: [available()] });
  });
  vi.stubGlobal("fetch", fetchMock);
  const revalidate = vi.fn();
  const unsubscribe = subscribeSessionRevalidationRequired(revalidate);
  try {
    const { result, rerender } = renderHook(({ principal }) => useCapabilities(principal),
      { initialProps: { principal: user } });
    await waitFor(() => expect(result.current.awaitingInitialCheck).toBeUndefined());
    hold = true;
    let oldReload!: Promise<void>;
    await act(async () => { oldReload = result.current.reload(); });
    hold = false;
    rerender({ principal: { ...user, homeAccountId: "fixture-b" } });
    expect(result.current.views).toEqual([]);
    expect(held[0].signal?.aborted).toBe(true);
    await waitFor(() => expect(result.current.awaitingInitialCheck).toBeUndefined());
    hold = true;
    let newReload!: Promise<void>;
    await act(async () => { newReload = result.current.reload(); });
    expect(held).toHaveLength(2);
    await act(async () => {
      held[0].release(Response.json({ code: "session_invalidated" }, { status: 401 }));
      await oldReload;
    });
    const requestCount = fetchMock.mock.calls.length;
    let duplicate!: Promise<void>;
    act(() => { duplicate = result.current.reload(); });
    expect(fetchMock).toHaveBeenCalledTimes(requestCount);
    expect(held[1].signal?.aborted).toBe(false);
    expect(result.current.loading || result.current.pending).toBe(true);
    expect(result.current.error).toBeUndefined();
    expect(revalidate).not.toHaveBeenCalled();
    hold = false;
    await act(async () => {
      held[1].release(Response.json({ value: [available()] }));
      await Promise.all([newReload, duplicate]);
    });
    expect(result.current.views).toHaveLength(1);
    expect(result.current.loading || result.current.pending).toBe(false);
  } finally { unsubscribe(); }
});

it("does not reload capabilities for equivalent accounts or reordered roles", async () => {
  const fetchMock = vi.fn(async () => Response.json({ value: [available()] }));
  vi.stubGlobal("fetch", fetchMock);
  const principal: SessionUser = { ...user, roles: ["AgentControl.Admin", "AgentControl.Viewer"] };
  const { result, rerender } = renderHook(({ principal }) => useCapabilities(principal),
    { initialProps: { principal } });
  await waitFor(() => expect(result.current.awaitingInitialCheck).toBeUndefined());
  const reload = result.current.reload;
  rerender({ principal: { ...principal, roles: [...principal.roles].reverse(), displayName: "Updated display name" } });
  await act(async () => {
    window.dispatchEvent(new Event("focus"));
    document.dispatchEvent(new Event("visibilitychange"));
  });
  expect(result.current.views).toHaveLength(1);
  expect(result.current.user?.displayName).toBe("Updated display name");
  expect(fetchMock).toHaveBeenCalledTimes(2);
  await act(async () => reload());
  expect(fetchMock).toHaveBeenCalledTimes(4);
});

it.each(["account", "tenant", "roles", "epoch", "sign-in"] as const)(
  "ignores a retained reload callback across %s changes without cancelling the current catalog",
  async change => {
    let hold = false;
    let release!: (response: Response) => void;
    let currentSignal: AbortSignal | null | undefined;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (hold && url === "/api/capabilities") {
        currentSignal = init?.signal;
        return new Promise<Response>(resolve => { release = resolve; });
      }
      return Response.json({ value: [available()] });
    });
    vi.stubGlobal("fetch", fetchMock);
    const { result, rerender } = renderHook(
      ({ principal, epoch }: { principal: SessionUser | undefined; epoch: number }) => useCapabilities(principal, epoch),
      { initialProps: { principal: user as SessionUser | undefined, epoch: 0 } },
    );
    await waitFor(() => expect(result.current.awaitingInitialCheck).toBeUndefined());
    const retiredReload = result.current.reload;
    if (change === "sign-in") rerender({ principal: undefined, epoch: 0 });
    hold = true;
    rerender({
      principal: {
        ...user,
        ...(change === "account" ? { homeAccountId: "fixture-b" }
          : change === "tenant" ? { tenantId: "tenant-b" }
            : change === "roles" ? { roles: ["AgentControl.Admin"] as SessionUser["roles"] } : {}),
      },
      epoch: change === "epoch" ? 1 : 0,
    });
    const signal = currentSignal;
    const requests = fetchMock.mock.calls.length;
    act(() => { void retiredReload(); });
    expect(fetchMock).toHaveBeenCalledTimes(requests);
    expect(signal?.aborted).toBe(false);
    expect(result.current.loading).toBe(true);
    expect(result.current.views).toEqual([]);
    hold = false;
    await act(async () => release(Response.json({ value: [available()] })));
    await waitFor(() => expect(result.current.awaitingInitialCheck).toBeUndefined());
    expect(result.current.loading || result.current.pending).toBe(false);
    expect(result.current.error).toBeUndefined();
    await act(async () => result.current.reload());
    expect(fetchMock).toHaveBeenCalledTimes(requests + 3);
  },
);

it.each(["logout", "role removal", "unmount"] as const)("does not admit a retained reload after %s", async change => {
  const fetchMock = vi.fn(async () => Response.json({ value: [available()] }));
  vi.stubGlobal("fetch", fetchMock);
  const { result, rerender, unmount } = renderHook(
    ({ principal }: { principal: SessionUser | undefined }) => useCapabilities(principal),
    { initialProps: { principal: user as SessionUser | undefined } },
  );
  await waitFor(() => expect(result.current.awaitingInitialCheck).toBeUndefined());
  const retiredReload = result.current.reload;
  if (change === "unmount") unmount();
  else rerender({ principal: change === "logout" ? undefined : { ...user, roles: [] } });
  await act(async () => retiredReload());
  expect(fetchMock).toHaveBeenCalledTimes(2);
  if (change !== "unmount") {
    expect(result.current.views).toEqual([]);
    expect(result.current.loading || result.current.pending).toBe(false);
    expect(result.current.error).toBeUndefined();
  }
});

it.each(["reload", "hidden initial check"] as const)("does not admit a %s into a replacement request session before account props update", async trigger => {
  const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue(trigger === "reload" ? "visible" : "hidden");
  const fetchMock = vi.fn(async (url: string) => url === "/api/me"
    ? Response.json({ user, csrfToken: "fixture-csrf", roleAssignmentRequired: false })
    : Response.json({ value: [available()] }));
  vi.stubGlobal("fetch", fetchMock);
  const { result, rerender } = renderHook(({ epoch }) => useCapabilities(user, epoch), { initialProps: { epoch: 0 } });
  await act(async () => {});
  const retiredReload = result.current.reload;
  await act(async () => getCurrentUser());
  const requests = fetchMock.mock.calls.length;

  visibility.mockReturnValue("visible");
  if (trigger === "hidden initial check") {
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(result.current.pending).toBe(false);
    expect(result.current.activeCheck).toBeUndefined();
  }
  await act(async () => {
    if (trigger === "reload") await retiredReload();
    else {
      document.dispatchEvent(new Event("visibilitychange"));
      window.dispatchEvent(new Event("focus"));
    }
  });
  expect(fetchMock).toHaveBeenCalledTimes(requests);
  expect(result.current.loading || result.current.pending).toBe(false);
  expect(result.current.error).toBeUndefined();

  rerender({ epoch: 1 });
  await act(async () => {});
  expect(fetchMock).toHaveBeenCalledTimes(requests + 2);
  expect(result.current.awaitingInitialCheck).toBeUndefined();
  await act(async () => retiredReload());
  expect(fetchMock).toHaveBeenCalledTimes(requests + 2);
});

it.each([
  ["initial", "success"], ["initial", "failure"], ["reload", "success"], ["reload", "failure"],
] as const)("does not publish a %s catalog %s or start its check if the request session changes during cache delivery", async (phase, outcome) => {
  const queries = createSavedQueryClient();
  let revalidation: Promise<unknown> | undefined;
  let observe = phase === "initial";
  let fail = observe && outcome === "failure";
  const unsubscribe = queries.getQueryCache().subscribe(event => {
    if (observe && event.type === "updated" && event.action.type === (outcome === "success" ? "success" : "error") && !revalidation) {
      revalidation = getCurrentUser();
    }
  });
  const fetchMock = vi.fn(async (url: string) => url === "/api/me"
    ? Response.json({ user, csrfToken: "fixture-csrf", roleAssignmentRequired: false })
    : fail ? Response.json({ code: "request_throttled" }, { status: 429 })
      : Response.json({ value: [available()] }));
  vi.stubGlobal("fetch", fetchMock);
  const { result, rerender, unmount } = renderHook(({ epoch }) => useCapabilities(user, epoch), {
    initialProps: { epoch: 0 },
    wrapper: ({ children }) => <QueryClientProvider client={queries}>{children}</QueryClientProvider>,
  });
  try {
    let previous = result.current.views;
    if (phase === "reload") {
      await act(async () => {});
      previous = result.current.views;
      observe = true;
      fail = outcome === "failure";
      await act(async () => result.current.reload());
    }
    await act(async () => {});
    await revalidation;
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      ...(phase === "reload" ? ["/api/capabilities", "/api/capabilities/check"] : []),
      "/api/capabilities", "/api/me",
    ]);
    if (phase === "reload") expect(result.current.views).toBe(previous);
    else expect(result.current.views).toEqual([]);
    expect(result.current.loading || result.current.pending).toBe(false);
    expect(result.current.error).toBeUndefined();
    expect(result.current.awaitingInitialCheck).toBe(phase === "initial" ? true : undefined);
    fail = false;
    rerender({ epoch: 1 });
    await act(async () => {});
    expect(result.current.views).toHaveLength(1);
    expect(result.current.awaitingInitialCheck).toBeUndefined();
  } finally {
    unmount();
    unsubscribe();
    queries.clear();
  }
});

it("shares the initial catalog without letting its first caller's unmount cancel the remaining caller", async () => {
  const queries = createSavedQueryClient();
  let release!: (response: Response) => void;
  let catalogSignal: AbortSignal | null | undefined;
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/api/capabilities") {
      catalogSignal = init?.signal;
      return new Promise<Response>(resolve => { release = resolve; });
    }
    return Response.json({ value: [available()] });
  });
  vi.stubGlobal("fetch", fetchMock);
  const wrapper = ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={queries}>{children}</QueryClientProvider>;
  const first = renderHook(() => useCapabilities(user), { wrapper });
  const second = renderHook(() => useCapabilities(user), { wrapper });
  const retiredReload = first.result.current.reload;
  try {
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(first.result.current.loading && second.result.current.loading).toBe(true);
    first.unmount();
    await act(async () => retiredReload());
    expect(catalogSignal?.aborted).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(second.result.current.loading).toBe(true);

    await act(async () => release(Response.json({ value: [available()] })));
    expect(second.result.current.views).toHaveLength(1);
    expect(second.result.current.loading || second.result.current.pending).toBe(false);
    expect(second.result.current.error).toBeUndefined();
    expect(second.result.current.awaitingInitialCheck).toBeUndefined();
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(["/api/capabilities", "/api/capabilities/check"]);
  } finally {
    first.unmount();
    second.unmount();
    queries.clear();
  }
});

it.each(
  [200, 401, 503].flatMap(status => (["account", "roles", "epoch"] as const).map(boundary => ({ status, boundary }))),
)("fences shared-cache $boundary A-B-A catalog and check responses, including late HTTP $status", async ({ status, boundary }) => {
  const queries = createSavedQueryClient();
  const held: Array<{ release: (response: Response) => void; signal?: AbortSignal | null }> = [];
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
    new Promise<Response>(release => { held.push({ release, signal: init?.signal }); }));
  vi.stubGlobal("fetch", fetchMock);
  const revalidate = vi.fn();
  const unsubscribe = subscribeSessionRevalidationRequired(revalidate);
  const previous = available();
  previous.operationFailure = { status: "missing_role", checkedAt: previous.decision.checkedAt!,
    expiresAt: previous.decision.expiresAt!, remediation: [] };
  const replacement = available(undefined, "graph.directory.read");
  const { result, rerender, unmount } = renderHook(({ principal, epoch }) => useCapabilities(principal, epoch), {
    initialProps: { principal: user, epoch: 0 },
    wrapper: ({ children }) => <QueryClientProvider client={queries}>{children}</QueryClientProvider>,
  });
  try {
    await act(async () => held[0].release(Response.json({ value: [previous] })));
    expect(result.current.pending).toBe(true);
    expect(permissionIssues(result.current.views, result.current.now)).toHaveLength(1);
    const retiredReload = result.current.reload;
    rerender({
      principal: { ...user, ...(boundary === "account" ? { homeAccountId: "fixture-b" }
        : boundary === "roles" ? { roles: ["AgentControl.Admin"] as SessionUser["roles"] } : {}) },
      epoch: boundary === "epoch" ? 1 : 0,
    });
    rerender({ principal: user, epoch: 0 });
    expect(result.current.views).toEqual([]);
    expect(result.current.loading).toBe(true);
    expect(held).toHaveLength(4);
    expect(held[1].signal?.aborted).toBe(true);
    expect(held[2].signal?.aborted).toBe(true);
    await act(async () => retiredReload());
    expect(held).toHaveLength(4);
    expect(held[3].signal?.aborted).toBe(false);
    await act(async () => held[3].release(Response.json({ value: [replacement] })));
    const activeCheck = result.current.activeCheck;
    expect(held).toHaveLength(5);
    await act(async () => {
      const body = status === 200 ? { value: [previous] } : { code: status === 401 ? "session_invalidated" : "temporarily_unavailable" };
      held[1].release(Response.json(body, { status }));
      held[2].release(Response.json(body, { status }));
    });
    expect(result.current.views).toEqual([replacement]);
    expect(result.current.activeCheck).toEqual(activeCheck);
    expect(result.current.pending).toBe(true);
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeUndefined();
    expect(held[4].signal?.aborted).toBe(false);
    expect(revalidate).not.toHaveBeenCalled();
    await act(async () => held[4].release(Response.json({ value: [replacement] })));
    expect(result.current.views).toEqual([replacement]);
    expect(permissionIssues(result.current.views, result.current.now)).toEqual([]);
    expect(result.current.loading || result.current.pending).toBe(false);
    expect(result.current.awaitingInitialCheck).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(5);
  } finally {
    unmount();
    unsubscribe();
    queries.clear();
  }
});

it("waits for an invalidated catalog's replacement before publishing evidence or starting one check", async () => {
  vi.useFakeTimers();
  const queries = createSavedQueryClient();
  const held: Array<{ release: (response: Response) => void; signal?: AbortSignal | null }> = [];
  let hold = false;
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (hold && url === "/api/capabilities") return new Promise<Response>(release => { held.push({ release, signal: init?.signal }); });
    return Response.json({ value: [available()] });
  });
  vi.stubGlobal("fetch", fetchMock);
  const wrapper = ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={queries}>{children}</QueryClientProvider>;
  const initial = renderHook(() => useCapabilities(user), { wrapper });
  await act(async () => {});
  initial.unmount();
  hold = true;
  const { result, unmount } = renderHook(() => useCapabilities(user), { wrapper });
  try {
    expect(held).toHaveLength(1);
    act(() => { void queries.invalidateQueries({ queryKey: ["saved", "capabilities"] }); });
    expect(held).toHaveLength(2);
    expect(held[0].signal?.aborted).toBe(true);
    expect(held[1].signal?.aborted).toBe(false);
    await act(async () => held[0].release(Response.json({ code: "session_invalidated" }, { status: 401 })));
    expect(result.current.views).toEqual([]);
    expect(result.current.loading).toBe(true);
    expect(result.current.pending).toBe(false);
    expect(result.current.error).toBeUndefined();
    await act(async () => held[1].release(Response.json({ value: [available()] })));
    expect(result.current.views).toHaveLength(1);
    expect(result.current.loading || result.current.pending).toBe(false);
    expect(result.current.awaitingInitialCheck).toBeUndefined();
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/capabilities", "/api/capabilities/check",
      "/api/capabilities", "/api/capabilities", "/api/capabilities/check",
    ]);
  } finally {
    unmount();
    queries.clear();
  }
});

it.each(["catalog", "check"] as const)("shares manual rechecks during the %s transport backoff without restarting its timer", async phase => {
  vi.useFakeTimers();
  let fail = false;
  const fetchMock = vi.fn(async (url: string) => {
    const target = phase === "catalog" ? url === "/api/capabilities" : url.startsWith("/api/capabilities/check");
    if (fail && target) {
      fail = false;
      return Response.json({ code: "temporarily_unavailable" }, { status: 503 });
    }
    return Response.json({ value: [available()] });
  });
  vi.stubGlobal("fetch", fetchMock);
  const { result } = renderHook(() => useCapabilities(user));
  await act(async () => {});
  fail = true;
  let first!: Promise<void>;
  await act(async () => { first = result.current.reload(); });
  const requests = fetchMock.mock.calls.length;
  await act(() => vi.advanceTimersByTimeAsync(999));
  let duplicate!: Promise<void>;
  act(() => { duplicate = result.current.reload(); });
  expect(duplicate).toBe(first);
  expect(fetchMock).toHaveBeenCalledTimes(requests);
  expect(result.current.loading || result.current.pending).toBe(true);
  expect(result.current.error).toBeUndefined();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
    await Promise.all([first, duplicate]);
  });
  expect(fetchMock).toHaveBeenCalledTimes(5);
  expect(result.current.loading || result.current.pending).toBe(false);
  expect(result.current.error).toBeUndefined();
});

it("refreshes reported operation issues only on an explicit check", async () => {
  let operationFailure: CapabilityView["operationFailure"];
  const fetchMock = vi.fn(async () => Response.json({ value: [{ ...available(), operationFailure }] }));
  vi.stubGlobal("fetch", fetchMock);
  const { result } = renderHook(() => useCapabilities(user));
  await waitFor(() => expect(result.current.awaitingInitialCheck).toBeUndefined());
  expect(fetchMock).toHaveBeenCalledTimes(2);
  operationFailure = { status: "missing_role", checkedAt: new Date(Date.now() - 1000).toISOString(),
    expiresAt: new Date(Date.now() + 60000).toISOString(), remediation: [] };
  await act(async () => result.current.reload());
  expect(fetchMock).toHaveBeenCalledTimes(4);
  expect(permissionIssues(result.current.views, result.current.now)[0]?.decision.status).toBe("missing_role");
  operationFailure = undefined;
  await act(async () => result.current.reload());
  expect(permissionIssues(result.current.views, result.current.now)).toEqual([]);
  expect(fetchMock).toHaveBeenCalledTimes(6);
});

it("expires an operation issue without running its on-demand operation or another provider check", async () => {
  vi.useFakeTimers();
  const view = available(undefined, "graph.licenses.read");
  view.decision = { capabilityId: view.definition.id, status: "available", authorized: true, fresh: true,
    verification: "on_demand", previewQualification: "not_required", remediation: [] };
  view.operationFailure = { status: "missing_license", checkedAt: new Date(Date.now() - 1000).toISOString(),
    expiresAt: new Date(Date.now() + 1000).toISOString(), remediation: [] };
  const fetchMock = vi.fn(async () => Response.json({ value: [view] }));
  vi.stubGlobal("fetch", fetchMock);
  const { result } = renderHook(() => useCapabilities(user));
  await act(async () => {});
  expect(permissionIssues(result.current.views, result.current.now)).toHaveLength(1);
  expect(providerActionAllowed(result.current.views[0])).toBe(true);
  await act(() => vi.advanceTimersByTimeAsync(1001));
  expect(permissionIssues(result.current.views, result.current.now)).toEqual([]);
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it.each(["catalog", "check"] as const)("retries a transient %s failure without showing a one-off warning", async phase => {
  vi.useFakeTimers();
  let attempts = 0;
  const fetchMock = vi.fn(async (url: string) => {
    const target = phase === "catalog" ? url === "/api/capabilities" : url.startsWith("/api/capabilities/check");
    if (target && ++attempts === 1) return Response.json({ code: "temporarily_unavailable" }, { status: 503 });
    return Response.json({ value: [available()] });
  });
  vi.stubGlobal("fetch", fetchMock);
  const { result } = renderHook(() => useCapabilities(user));
  await act(async () => {});
  expect(result.current.error).toBeUndefined();
  expect(result.current.loading || result.current.pending).toBe(true);
  await act(() => vi.advanceTimersByTimeAsync(999));
  expect(attempts).toBe(1);
  expect(result.current.error).toBeUndefined();
  await act(() => vi.advanceTimersByTimeAsync(1));
  expect(attempts).toBe(2);
  expect(fetchMock).toHaveBeenCalledTimes(3);
  expect(result.current.error).toBeUndefined();
  expect(result.current.pending).toBe(false);
  expect(result.current.loading).toBe(false);
  expect(result.current.awaitingInitialCheck).toBeUndefined();
});

it("reports a persistent transport failure only after retry, without inventing a grant failure", async () => {
  vi.useFakeTimers();
  const fetchMock = vi.fn(async (url: string) => {
    if (url.startsWith("/api/capabilities/check")) throw new TypeError("Synthetic network outage");
    return Response.json({ value: [available()] });
  });
  vi.stubGlobal("fetch", fetchMock);
  const { result } = renderHook(() => useCapabilities(user));
  await act(async () => {});
  expect(result.current.error).toBeUndefined();
  await act(() => vi.advanceTimersByTimeAsync(1000));
  expect(result.current.error).toBe("Permission checks failed after retrying. Use Check status to retry.");
  expect(result.current.views).toHaveLength(1);
  expect(permissionIssues(result.current.views, result.current.now, result.current.awaitingInitialCheck)).toEqual([]);
  await act(() => vi.advanceTimersByTimeAsync(5000));
  expect(fetchMock).toHaveBeenCalledTimes(3);
});

it("cancels a queued retry when the current session is removed", async () => {
  vi.useFakeTimers();
  const fetchMock = vi.fn(async (url: string) => {
    if (url.startsWith("/api/capabilities/check")) throw new TypeError("Synthetic network outage");
    return Response.json({ value: [available()] });
  });
  vi.stubGlobal("fetch", fetchMock);
  const { result, rerender } = renderHook(({ principal }: { principal: SessionUser | undefined }) => useCapabilities(principal),
    { initialProps: { principal: user as SessionUser | undefined } });
  await act(async () => {});
  expect(result.current.pending).toBe(true);
  rerender({ principal: undefined });
  await act(() => vi.advanceTimersByTimeAsync(5000));
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(result.current.views).toEqual([]);
  expect(result.current.pending).toBe(false);
  expect(result.current.error).toBeUndefined();
});

it.each(["catalog", "check"] as const)("does not replay a delayed %s retry into a newly validated request session", async phase => {
  vi.useFakeTimers();
  const path = phase === "catalog" ? "/api/capabilities" : "/api/capabilities/check";
  let attempts = 0;
  const fetchMock = vi.fn(async (url: string) => {
    if (url === "/api/me") return Response.json({
      user: { ...user, homeAccountId: "fixture-b" }, csrfToken: "fixture-csrf", roleAssignmentRequired: false,
    });
    if (url === path && ++attempts === 1) return Response.json({ code: "temporarily_unavailable" }, { status: 503 });
    return Response.json({ value: [available()] });
  });
  vi.stubGlobal("fetch", fetchMock);
  const controller = new AbortController();
  const read = phase === "catalog" ? getCapabilities : checkCapabilities;
  const outcome = Promise.allSettled([retryPermissionRead(() => read({ signal: controller.signal }), controller.signal)]);
  await act(async () => {});
  expect(attempts).toBe(1);

  await getCurrentUser();
  await act(() => vi.advanceTimersByTimeAsync(1_000));

  expect(attempts).toBe(1);
  expect(await outcome).toMatchObject([{ status: "rejected", reason: { kind: "aborted", code: "request_aborted" } }]);
  expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([path, "/api/me"]);
});

it.each([400, 401, 403, 429])("does not retry deterministic/security/throttling API failure %s", async status => {
  vi.useFakeTimers();
  const fetchMock = vi.fn(async (url: string) => url.startsWith("/api/capabilities/check")
    ? Response.json({ code: "request_denied", detail: "Synthetic rejection" }, { status })
    : Response.json({ value: [available()] }));
  vi.stubGlobal("fetch", fetchMock);
  const { result } = renderHook(() => useCapabilities(user));
  await act(async () => {});
  expect(result.current.error).toBeDefined();
  expect(result.current.error).not.toContain("after retrying");
  await act(() => vi.advanceTimersByTimeAsync(5000));
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it("confirms a cached transient failure with retry=failed before exposing it as an issue", async () => {
  let settle!: (value: Response) => void;
  const failed = available();
  failed.decision = { ...failed.decision, status: "provider_error", authorized: false, verification: undefined,
    evidence: { category: "provider_timeout" } };
  const fetchMock = vi.fn(async (url: string) => url === "/api/capabilities"
    ? Response.json({ value: [failed] })
    : new Promise<Response>(resolve => { settle = resolve; }));
  vi.stubGlobal("fetch", fetchMock);
  const { result } = renderHook(() => useCapabilities(user));
  await waitFor(() => expect(result.current.pending).toBe(true));
  expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(["/api/capabilities", "/api/capabilities/check?retry=failed"]);
  expect(permissionIssues(result.current.views, result.current.now, result.current.awaitingInitialCheck)).toEqual([]);
  expect(providerActionAllowed(result.current.views[0], false, result.current.now)).toBe(false);
  await act(async () => settle(Response.json({ value: [available()] })));
  expect(result.current.awaitingInitialCheck).toBeUndefined();
  expect(permissionIssues(result.current.views, result.current.now)).toEqual([]);
  expect(providerActionAllowed(result.current.views[0], false, result.current.now)).toBe(true);
});

it("does not let a timeout that expires while hidden force retries of other fresh failures", async () => {
  vi.useFakeTimers();
  const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  const timeout = available(new Date(Date.now() + 1000).toISOString());
  timeout.decision = { ...timeout.decision, status: "provider_error", authorized: false, verification: undefined,
    evidence: { category: "provider_timeout" } };
  const denied = available(undefined, "graph.directory.read");
  denied.decision = { ...denied.decision, status: "missing_permission", authorized: false, verification: undefined };
  const fetchMock = vi.fn<(url: string) => Promise<Response>>(async () => Response.json({ value: [timeout, denied] }));
  vi.stubGlobal("fetch", fetchMock);
  const { result } = renderHook(() => useCapabilities(user));
  await act(async () => {});
  expect(fetchMock).toHaveBeenCalledTimes(1);
  await act(() => vi.advanceTimersByTimeAsync(1001));
  visibility.mockReturnValue("visible");
  await act(async () => document.dispatchEvent(new Event("visibilitychange")));
  expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(["/api/capabilities", "/api/capabilities/check"]);
  expect(permissionIssues(result.current.views, result.current.now).map(issue => issue.view.definition.id))
    .toEqual(["graph.directory.read"]);
  expect(result.current.pending).toBe(false);
  expect(result.current.awaitingInitialCheck).toBeUndefined();
  await act(async () => window.dispatchEvent(new Event("focus")));
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it("loads decisions then runs one bounded automatic check", async () => {
  const fetchMock = vi.fn(async (url: string) => Response.json({
    value: [available(new Date(Date.now() + (url.endsWith("/check") ? 60_000 : 1_000)).toISOString())],
  }));
  vi.stubGlobal("fetch", fetchMock);

  const { result } = renderHook(() => useCapabilities(user));

  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(result.current.views).toHaveLength(1));
  expect(fetchMock.mock.calls.map(call => call[0])).toEqual([
    "/api/capabilities",
    "/api/capabilities/check",
  ]);
  expect(providerActionAllowed(result.current.views[0], false, result.current.now)).toBe(true);
});

it("does not duplicate automatic checks under StrictMode remounting", async () => {
  const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(
    async () => Response.json({ value: [available()] }),
  );
  vi.stubGlobal("fetch", fetchMock);

  const { result } = renderHook(() => useCapabilities(user), { reactStrictMode: true });

  await waitFor(() => expect(fetchMock.mock.calls.filter(call => String(call[0]).endsWith("/check"))).toHaveLength(1));
  const reads = fetchMock.mock.calls.filter(([url]) => url === "/api/capabilities");
  expect(reads).toHaveLength(2);
  expect(reads[0][1]?.signal?.aborted).toBe(true);
  expect(reads[1][1]?.signal?.aborted).toBe(false);
  await waitFor(() => expect(result.current.pending).toBe(false));
  expect(result.current.views).toHaveLength(1);
});

it.each(["fresh", "unchecked"] as const)("defers the initial provider check for %s evidence until a hidden page becomes visible", async evidence => {
  const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  const saved = available();
  if (evidence === "unchecked") saved.decision = {
    ...saved.decision, status: "unknown", authorized: false, fresh: false,
    checkedAt: undefined, expiresAt: undefined, verification: undefined,
  };
  const fetchMock = vi.fn(async (url: string) => Response.json({ value: [url.endsWith("/check") ? available() : saved] }));
  vi.stubGlobal("fetch", fetchMock);
  renderHook(() => useCapabilities(user));
  await act(async () => {});
  expect(fetchMock).toHaveBeenCalledTimes(1);

  visibility.mockReturnValue("visible");
  await act(async () => document.dispatchEvent(new Event("visibilitychange")));
  expect(fetchMock).toHaveBeenCalledTimes(2);
  act(() => window.dispatchEvent(new Event("focus")));
  await act(async () => {});
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it("keeps known delegated actions usable without rechecking when diagnostic evidence expires", async () => {
  vi.useFakeTimers();
  const sameExpiry = new Date(Date.now() + 1_000).toISOString();
  let checks = 0;
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (!url.endsWith("/check")) return Response.json({ value: [available(sameExpiry)] });
    checks += 1;
    return Response.json({
      value: [available(checks === 1 ? sameExpiry : new Date(Date.now() + 60_000).toISOString())],
    });
  }));

  const { result } = renderHook(() => useCapabilities(user));
  await act(async () => {});
  await act(async () => {});
  expect(checks).toBe(1);

  await act(() => vi.advanceTimersByTimeAsync(1_100));
  await act(async () => {});
  expect(checks).toBe(1);
  expect(evidenceIsFresh(result.current.views[0], result.current.now)).toBe(false);
  expect(result.current.pending).toBe(false);
  expect(providerActionAllowed(result.current.views[0], false, result.current.now)).toBe(true);
});

it("bounds timer delays when the browser clock is far behind the evidence timestamps", async () => {
  vi.useFakeTimers();
  const maximumDelay = 2_147_483_647;
  const saved = available(new Date(Date.now() + maximumDelay + 60_000).toISOString());
  saved.decision.checkedAt = new Date(Date.now() + maximumDelay).toISOString();
  const schedule = vi.spyOn(window, "setTimeout");
  const fetchMock = vi.fn(async () => Response.json({ value: [saved] }));
  vi.stubGlobal("fetch", fetchMock);
  renderHook(() => useCapabilities(user));
  await act(async () => {});
  expect(Math.max(...schedule.mock.calls.map(([, delay]) => delay ?? 0))).toBe(maximumDelay);
  await act(() => vi.advanceTimersByTimeAsync(60_000));
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it.each([false, true])("expires application evidence without an automatic application check (delegated evidence present: %s)", async withDelegated => {
  vi.useFakeTimers();
  const saved = [
    available(new Date(Date.now() + 1_000).toISOString(), "graph.package.read.application"),
    ...(withDelegated ? [available()] : []),
  ];
  const fetchMock = vi.fn(async () => Response.json({ value: saved }));
  vi.stubGlobal("fetch", fetchMock);
  const { result } = renderHook(() => useCapabilities({ ...user, roles: ["AgentControl.Admin"] }));
  await act(async () => {});
  expect(providerActionAllowed(result.current.views[0], false, result.current.now)).toBe(true);
  expect(fetchMock).toHaveBeenCalledTimes(2);

  await act(() => vi.advanceTimersByTimeAsync(1_001));
  expect(providerActionAllowed(result.current.views[0], false, result.current.now)).toBe(false);
  if (withDelegated) expect(providerActionAllowed(result.current.views[1], false, result.current.now)).toBe(true);
  await act(() => vi.advanceTimersByTimeAsync(30_000));
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it.each(["initial check", "catalog reload", "reload check"] as const)(
  "ages diagnostics without disabling known delegated actions while a %s is pending",
  async pendingRequest => {
    vi.useFakeTimers();
    const saved = [
      available(new Date(Date.now() + 1_000).toISOString()),
      available(new Date(Date.now() + 2_000).toISOString(), "powerPlatform.inventory.read"),
    ];
    let reads = 0;
    let checks = 0;
    const fetchMock = vi.fn(async (url: string) => {
      if (url.startsWith("/api/capabilities/check")) {
        checks += 1;
        if (pendingRequest === "initial check" || checks > 1) return new Promise<Response>(() => undefined);
      } else if (++reads > 1 && pendingRequest === "catalog reload") {
        return new Promise<Response>(() => undefined);
      }
      return Response.json({ value: saved });
    });
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useCapabilities(user));
    await act(async () => {});
    if (pendingRequest === "catalog reload" || pendingRequest === "reload check") {
      await act(async () => { void result.current.reload(); });
    }
    expect(result.current.views.every(view => providerActionAllowed(view, false, result.current.now))).toBe(true);

    await act(() => vi.advanceTimersByTimeAsync(1_001));
    expect(result.current.loading || result.current.pending).toBe(true);
    expect(evidenceIsFresh(result.current.views[0], result.current.now)).toBe(false);
    expect(providerActionAllowed(result.current.views[0], false, result.current.now)).toBe(true);
    expect(providerActionAllowed(result.current.views[1], false, result.current.now)).toBe(true);
    const requestCount = fetchMock.mock.calls.length;

    await act(() => vi.advanceTimersByTimeAsync(1_000));
    expect(result.current.views.every(view => !evidenceIsFresh(view, result.current.now))).toBe(true);
    expect(result.current.views.every(view => providerActionAllowed(view, false, result.current.now))).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(requestCount);
  },
);

it("does not start expiry checks after an explicit reload", async () => {
  vi.useFakeTimers();
  const sameExpiry = new Date(Date.now() + 1_000).toISOString();
  let checks = 0;
  let reads = 0;
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (!url.startsWith("/api/capabilities/check")) {
      reads += 1;
      return Response.json({ value: [available(sameExpiry)] });
    }
    checks += 1;
    return Response.json({
      value: [available(checks <= 2 ? sameExpiry : new Date(Date.now() + 60_000).toISOString())],
    });
  }));

  const { result } = renderHook(() => useCapabilities(user));
  await act(async () => {});
  await act(async () => {});
  expect(checks).toBe(1);

  await act(async () => {
    await result.current.reload();
  });
  expect(reads).toBe(2);
  expect(checks).toBe(2);

  await act(() => vi.advanceTimersByTimeAsync(1_100));
  await act(async () => {});
  expect(checks).toBe(2);
});

it("does not load or check protected capabilities without an assigned current role", async () => {
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);

  const { result } = renderHook(() => useCapabilities({
    ...user,
    roles: [],
  } as SessionUser));

  await act(async () => {});
  expect(result.current.views).toEqual([]);
  expect(result.current.loading).toBe(false);
  expect(fetchMock).not.toHaveBeenCalled();
});

it.each(["account", "tenant", "roles"] as const)("hides prior evidence and fences a stale check across %s changes", async scope => {
  let resolveFirstCheck!: (value: Response) => void;
  let resolveSecondRead!: (value: Response) => void;
  let call = 0;
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    call += 1;
    if (call === 1) return Response.json({ value: [available()] });
    if (call === 2 && url.endsWith("/check")) return new Promise<Response>(resolve => { resolveFirstCheck = resolve; });
    return new Promise<Response>(resolve => { resolveSecondRead = resolve; });
  }));
  const { result, rerender } = renderHook(
    ({ principal }) => useCapabilities(principal),
    { initialProps: { principal: user } },
  );
  await waitFor(() => expect(result.current.pending).toBe(true));

  rerender({ principal: {
    ...user,
    ...(scope === "account" ? { homeAccountId: "fixture-b" }
      : scope === "tenant" ? { tenantId: "tenant-b" }
        : { roles: ["AgentControl.Admin"] as SessionUser["roles"] }),
  } });
  expect(result.current.views).toEqual([]);
  await act(async () => {
    resolveFirstCheck(Response.json({ value: [available()] }));
    resolveSecondRead(Response.json({ value: [] }));
  });
  expect(result.current.views).toEqual([]);
});

it("does not resurrect saved decisions when the same principal signs in again", async () => {
  let reads = 0;
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url === "/api/capabilities" && ++reads > 1) return new Promise<Response>(() => undefined);
    return Response.json({ value: [available()] });
  }));
  const { result, rerender } = renderHook(
    ({ principal }: { principal: SessionUser | undefined }) => useCapabilities(principal),
    { initialProps: { principal: user as SessionUser | undefined } },
  );
  await waitFor(() => expect(result.current.views).toHaveLength(1));
  await waitFor(() => expect(result.current.pending).toBe(false));
  rerender({ principal: undefined });
  expect(result.current.views).toEqual([]);
  rerender({ principal: user });
  expect(result.current.views).toEqual([]);
  expect(result.current.loading).toBe(true);
});

it("fences capability evidence when the same principal's session epoch changes", async () => {
  let resolveOldCheck!: (response: Response) => void;
  let reads = 0;
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url === "/api/capabilities") {
      if (++reads > 1) return new Promise<Response>(() => undefined);
      return Response.json({ value: [available()] });
    }
    return new Promise<Response>(resolve => { resolveOldCheck = resolve; });
  }));
  const { result, rerender } = renderHook(
    ({ epoch }) => useCapabilities(user, epoch),
    { initialProps: { epoch: 0 } },
  );
  await waitFor(() => expect(result.current.pending).toBe(true));
  rerender({ epoch: 1 });
  expect(result.current.views).toEqual([]);
  expect(result.current.loading).toBe(true);
  await act(async () => resolveOldCheck(Response.json({ value: [available()] })));
  expect(result.current.views).toEqual([]);
  expect(reads).toBe(2);
});

it.each([
  ["automatic check", 401],
  ["automatic check", 403],
  ["catalog reload", 401],
  ["catalog reload", 403],
  ["reload check", 401],
  ["reload check", 403],
] as const)("discards permission evidence after a denied %s (%s) until an explicit recovery", async (phase, status) => {
  let deny = phase === "automatic check";
  const fetchMock = vi.fn(async (url: string) => {
    const deniedEndpoint = phase === "catalog reload" ? url === "/api/capabilities" : url.startsWith("/api/capabilities/check");
    return deny && deniedEndpoint
      ? Response.json({ code: status === 401 ? "interaction_required" : "forbidden", detail: "Current capability access was denied." }, { status })
      : Response.json({ value: [available()] });
  });
  vi.stubGlobal("fetch", fetchMock);
  const { result } = renderHook(() => useCapabilities(user));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(result.current.pending).toBe(false));
  if (phase !== "automatic check") {
    expect(result.current.views).toHaveLength(1);
    deny = true;
    await act(async () => result.current.reload());
  }
  expect(result.current.views).toEqual([]);
  expect(result.current.error).toMatch(/denied/i);
  const requests = fetchMock.mock.calls.length;
  await act(async () => window.dispatchEvent(new Event("focus")));
  expect(fetchMock).toHaveBeenCalledTimes(requests);
  deny = false;
  await act(async () => result.current.reload());
  expect(result.current.views).toHaveLength(1);
  expect(result.current.error).toBeUndefined();
});

it.each([
  { status: 401, code: "session_invalidated" },
  { status: 403, code: "missing_internal_role" },
])("still discards evidence when a $status denial itself invalidates the request session", async ({ status, code }) => {
  vi.useFakeTimers();
  let deny = true;
  const fetchMock = vi.fn(async (url: string) => deny && url.startsWith("/api/capabilities/check")
    ? Response.json({ code }, { status }) : Response.json({ value: [available()] }));
  vi.stubGlobal("fetch", fetchMock);
  const revalidate = vi.fn();
  const unsubscribe = subscribeSessionRevalidationRequired(revalidate);
  const { result, rerender } = renderHook(({ epoch }) => useCapabilities(user, epoch), { initialProps: { epoch: 0 } });
  try {
    await act(async () => {});
    expect(revalidate).toHaveBeenCalledOnce();
    expect(result.current.views).toEqual([]);
    expect(result.current.error).toMatch(/denied/i);
    expect(result.current.loading || result.current.pending).toBe(false);
    await act(async () => {
      await result.current.reload();
      window.dispatchEvent(new Event("focus"));
      document.dispatchEvent(new Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    deny = false;
    rerender({ epoch: 1 });
    await act(async () => {});
    expect(result.current.views).toHaveLength(1);
    expect(result.current.error).toBeUndefined();
    expect(result.current.awaitingInitialCheck).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(4);
  } finally { unsubscribe(); }
});

it("aborts an in-flight automatic check on logout", async () => {
  let checkSignal: AbortSignal | undefined;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (!url.endsWith("/check")) return Response.json({ value: [available()] });
    checkSignal = init?.signal ?? undefined;
    return new Promise<Response>(() => undefined);
  }));
  const { result, rerender } = renderHook(
    ({ principal }: { principal: SessionUser | undefined }) => useCapabilities(principal),
    { initialProps: { principal: user as SessionUser | undefined } },
  );
  await waitFor(() => expect(result.current.pending).toBe(true));

  rerender({ principal: undefined });

  expect(checkSignal?.aborted).toBe(true);
  expect(result.current.views).toEqual([]);
  expect(result.current.pending).toBe(false);
});

it.each(["initial", "reload"] as const)("aborts an in-flight %s check when the hook unmounts", async trigger => {
  vi.useFakeTimers();
  const initial = available(new Date(Date.now() + 1_000).toISOString());
  let checks = 0;
  let checkSignal: AbortSignal | undefined;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url.startsWith("/api/capabilities/check") && ++checks === (trigger === "initial" ? 1 : 2)) {
      checkSignal = init?.signal ?? undefined;
      return new Promise<Response>(() => undefined);
    }
    return Response.json({ value: [initial] });
  }));
  const { result, unmount } = renderHook(() => useCapabilities(user));
  await act(async () => {});
  if (trigger === "reload") await act(async () => { void result.current.reload(); });
  expect(result.current.pending).toBe(true);
  expect(checkSignal?.aborted).toBe(false);
  unmount();
  expect(checkSignal?.aborted).toBe(true);
});

it.each(["principal change", "reload"] as const)("clears a cancelled check's pending state after a failed catalog read on %s", async recovery => {
  let reads = 0;
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.startsWith("/api/capabilities/check")) return new Promise<Response>(() => undefined);
    if (++reads > 1) throw new Error("Synthetic catalog outage");
    return Response.json({ value: [available()] });
  }));
  const { result, rerender } = renderHook(
    ({ principal }) => useCapabilities(principal),
    { initialProps: { principal: user } },
  );
  await waitFor(() => expect(result.current.pending).toBe(true));

  if (recovery === "reload") await act(async () => result.current.reload());
  else {
    rerender({ principal: { ...user, homeAccountId: "fixture-b" } });
    await act(async () => {});
  }
  await waitFor(() => expect(result.current.error).toContain("Permission checks could not be loaded"), { timeout: 2000 });
  expect(result.current.loading).toBe(false);
  expect(result.current.pending).toBe(false);
});

it("surfaces a failed reload that supersedes the initial catalog request and permits recovery", async () => {
  let resolveInitialRead!: (value: Response) => void;
  let initialSignal: AbortSignal | undefined;
  let reads = 0;
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/api/capabilities") {
      reads += 1;
      if (reads === 1) {
        initialSignal = init?.signal ?? undefined;
        return new Promise<Response>(resolve => { resolveInitialRead = resolve; });
      }
      if (reads === 2 || reads === 3) throw new Error("Synthetic catalog outage");
    }
    return Response.json({ value: [available()] });
  });
  vi.stubGlobal("fetch", fetchMock);
  const { result } = renderHook(() => useCapabilities(user));
  expect(result.current.loading).toBe(true);

  await act(async () => result.current.reload());
  expect(initialSignal?.aborted).toBe(true);
  expect(result.current.loading).toBe(false);
  expect(result.current.pending).toBe(false);
  expect(result.current.error).toContain("Permission checks could not be loaded");

  await act(async () => resolveInitialRead(Response.json({ value: [available()] })));
  expect(result.current.views).toEqual([]);
  expect(result.current.error).toContain("Permission checks could not be loaded");
  await act(async () => result.current.reload());
  expect(result.current.views).toHaveLength(1);
  expect(result.current.error).toBeUndefined();
  expect(result.current.loading).toBe(false);
  expect(fetchMock).toHaveBeenCalledTimes(5);
});

it("preserves loaded decisions after a failed initial check without scheduling periodic retries", async () => {
  vi.useFakeTimers();
  const fetchMock = vi.fn(async (url: string) => {
    if (url.endsWith("/check")) throw new Error("Synthetic outage");
    return Response.json({ value: [available(new Date(Date.now() - 1).toISOString())] });
  });
  vi.stubGlobal("fetch", fetchMock);

  const { result } = renderHook(() => useCapabilities(user));
  await act(async () => {});
  await act(async () => {});
  expect(result.current.views).toHaveLength(1);
  expect(result.current.error).toBeUndefined();
  await act(() => vi.advanceTimersByTimeAsync(1000));
  expect(result.current.error).toContain("Permission checks failed after retrying");

  await act(() => vi.advanceTimersByTimeAsync(30_000));
  await act(() => vi.advanceTimersByTimeAsync(1000));
  await act(async () => {});
  expect(fetchMock).toHaveBeenCalledTimes(3);

  await act(() => vi.advanceTimersByTimeAsync(5 * 60_000));
  act(() => window.dispatchEvent(new Event("focus")));
  await act(async () => {});
  expect(fetchMock).toHaveBeenCalledTimes(3);
});

it.each(["fresh", "expired", "staggered"] as const)("makes no periodic, focus or visibility permission requests after the initial check (%s diagnostics)", async scenario => {
  vi.useFakeTimers();
  const views = [
    available(new Date(Date.now() + (scenario === "expired" ? -1 : 1_000)).toISOString()),
    available(new Date(Date.now() + (scenario === "staggered" ? 90_000 : 1_000)).toISOString(), "powerPlatform.inventory.read"),
  ];
  const fetchMock = vi.fn(async () => Response.json({ value: views }));
  vi.stubGlobal("fetch", fetchMock);
  const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  const { result } = renderHook(() => useCapabilities(user));
  await act(async () => {});
  expect(fetchMock).toHaveBeenCalledTimes(2);
  visibility.mockReturnValue("hidden");
  await act(() => vi.advanceTimersByTimeAsync(10 * 60_000));
  visibility.mockReturnValue("visible");
  await act(async () => {
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("focus"));
  });
  await act(() => vi.advanceTimersByTimeAsync(60 * 60_000));
  expect(fetchMock.mock.calls).toHaveLength(2);
  expect(result.current.pending).toBe(false);
  expect(result.current.views.every(view => !evidenceIsFresh(view, result.current.now))).toBe(true);
  expect(result.current.views.every(view => providerActionAllowed(view, false, Date.now()))).toBe(true);
});

it.each([true, false])("does not run permission requests after logout (initial check succeeded: %s)", async succeeds => {
  vi.useFakeTimers();
  const stale = available(new Date(Date.now() - 1).toISOString());
  const fetchMock = vi.fn(async (url: string) => {
    if (url.endsWith("/check") && !succeeds) throw new Error("Synthetic outage");
    return Response.json({ value: [stale] });
  });
  vi.stubGlobal("fetch", fetchMock);

  const { result, rerender } = renderHook(
    ({ principal }: { principal: SessionUser | undefined }) => useCapabilities(principal),
    { initialProps: { principal: user as SessionUser | undefined } },
  );
  await act(async () => {});
  expect(fetchMock).toHaveBeenCalledTimes(2);
  rerender({ principal: undefined });
  await act(() => vi.advanceTimersByTimeAsync(60_000));
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(result.current.views).toEqual([]);
  expect(result.current.pending).toBe(false);
});

it("surfaces an origin configuration failure without discarding permission evidence", async () => {
  const detail = "A same-origin request is required. Preserve the browser Origin header with --origin-header unchanged.";
  vi.stubGlobal("fetch", vi.fn(async (url: string) => url.endsWith("/check")
    ? Response.json({ code: "invalid_origin", detail }, { status: 403 })
    : Response.json({ value: [available()] })));

  const { result } = renderHook(() => useCapabilities(user));

  await waitFor(() => expect(result.current.error).toContain(detail));
  expect(result.current.error).toContain("Permission checks failed.");
  expect(result.current.views).toHaveLength(1);
  expect(result.current.pending).toBe(false);
});

it("bypasses cached failures only when the user explicitly reloads status", async () => {
  const fetchMock = vi.fn<(url: string) => Promise<Response>>(async () => Response.json({ value: [available()] }));
  vi.stubGlobal("fetch", fetchMock);
  const { result } = renderHook(() => useCapabilities(user));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  await act(async () => { await result.current.reload(); });
  expect(fetchMock.mock.calls.map(call => call[0])).toEqual([
    "/api/capabilities", "/api/capabilities/check",
    "/api/capabilities", "/api/capabilities/check?retry=failed",
  ]);
});
