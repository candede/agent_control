import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { capabilityDefinitions } from "../../backend/src/services/capabilityRegistry";
import type { CapabilityId, CapabilityView, SessionUser } from "./api/client";
import { providerActionAllowed } from "./capabilityState";
import { useCapabilities } from "./useCapabilities";

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

it("checks again when GET and the initial check return the same fresh expiry", async () => {
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
  expect(checks).toBe(2);
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

it.each(["initial check", "expiry check", "catalog reload", "reload check"] as const)(
  "continues expiring evidence while a %s is pending",
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
    expect(providerActionAllowed(result.current.views[0], false, result.current.now)).toBe(false);
    expect(providerActionAllowed(result.current.views[1], false, result.current.now)).toBe(true);
    const requestCount = fetchMock.mock.calls.length;

    await act(() => vi.advanceTimersByTimeAsync(1_000));
    expect(providerActionAllowed(result.current.views[0], false, result.current.now)).toBe(false);
    expect(providerActionAllowed(result.current.views[1], false, result.current.now)).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(requestCount);
  },
);

it("preserves same-signature expiry scheduling across an explicit reload", async () => {
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
  expect(checks).toBe(3);
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

it("hides prior evidence and fences a stale check across principal changes", async () => {
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

  rerender({ principal: { ...user, homeAccountId: "fixture-b" } });
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

it.each(["expiry", "reload"] as const)("aborts an in-flight %s check when the hook unmounts", async trigger => {
  vi.useFakeTimers();
  const initial = available(new Date(Date.now() + 1_000).toISOString());
  let checks = 0;
  let checkSignal: AbortSignal | undefined;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url.startsWith("/api/capabilities/check") && ++checks === 2) {
      checkSignal = init?.signal ?? undefined;
      return new Promise<Response>(() => undefined);
    }
    return Response.json({ value: [initial] });
  }));
  const { result, unmount } = renderHook(() => useCapabilities(user));
  await act(async () => {});
  if (trigger === "expiry") await act(() => vi.advanceTimersByTimeAsync(1_100));
  else await act(async () => { void result.current.reload(); });
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
  expect(result.current.error).toContain("Capability status could not be loaded");
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
      if (reads === 2) throw new Error("Synthetic catalog outage");
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
  expect(result.current.error).toContain("Capability status could not be loaded");

  await act(async () => resolveInitialRead(Response.json({ value: [available()] })));
  expect(result.current.views).toEqual([]);
  expect(result.current.error).toContain("Capability status could not be loaded");
  await act(async () => result.current.reload());
  expect(result.current.views).toHaveLength(1);
  expect(result.current.error).toBeUndefined();
  expect(result.current.loading).toBe(false);
  expect(fetchMock).toHaveBeenCalledTimes(4);
});

it("preserves loaded decisions and retries an expiry failure once without looping", async () => {
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
  expect(result.current.error).toContain("Automatic permission check failed");

  await act(() => vi.advanceTimersByTimeAsync(60_000));
  await act(async () => {});
  expect(fetchMock).toHaveBeenCalledTimes(3);

  await act(() => vi.advanceTimersByTimeAsync(5 * 60_000));
  act(() => window.dispatchEvent(new Event("focus")));
  await act(async () => {});
  expect(fetchMock).toHaveBeenCalledTimes(3);
});

it("schedules later capability expiries after an earlier expiry exhausts its retry", async () => {
  vi.useFakeTimers();
  const initial = [
    available(new Date(Date.now() + 1_000).toISOString()),
    available(new Date(Date.now() + 90_000).toISOString(), "powerPlatform.inventory.read"),
  ];
  let checks = 0;
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (!url.endsWith("/check")) return Response.json({ value: initial });
    checks += 1;
    if (checks === 2 || checks === 3) throw new Error("Synthetic outage");
    return Response.json({ value: checks === 1 ? initial : [
      available(),
      available(undefined, "powerPlatform.inventory.read"),
    ] });
  }));

  const { result } = renderHook(() => useCapabilities(user));
  await act(async () => {});
  expect(checks).toBe(1);
  await act(() => vi.advanceTimersByTimeAsync(31_100));
  expect(checks).toBe(3);
  expect(providerActionAllowed(result.current.views[0], false, result.current.now)).toBe(false);
  expect(providerActionAllowed(result.current.views[1], false, result.current.now)).toBe(true);

  await act(() => vi.advanceTimersByTimeAsync(59_000));
  expect(checks).toBe(4);
  expect(result.current.error).toBeUndefined();
  expect(result.current.views.every(view => providerActionAllowed(view, false, result.current.now))).toBe(true);
});

it("retries a successful check that reuses locally expired evidence without a request loop", async () => {
  vi.useFakeTimers();
  const expiry = new Date(Date.now() + 1_000).toISOString();
  let checks = 0;
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.endsWith("/check")) checks += 1;
    return Response.json({ value: [available(checks < 3 ? expiry : undefined)] });
  }));

  const { result } = renderHook(() => useCapabilities(user));
  await act(async () => {});
  expect(checks).toBe(1);
  await act(() => vi.advanceTimersByTimeAsync(1_100));
  expect(checks).toBe(2);
  expect(providerActionAllowed(result.current.views[0], false, result.current.now)).toBe(false);

  await act(() => vi.advanceTimersByTimeAsync(30_000));
  expect(checks).toBe(3);
  expect(providerActionAllowed(result.current.views[0], false, result.current.now)).toBe(true);
});

it("preserves a queued retry when a later check renews only another capability", async () => {
  vi.useFakeTimers();
  const initial = [
    available(new Date(Date.now() + 1_000).toISOString()),
    available(new Date(Date.now() + 10_000).toISOString(), "powerPlatform.inventory.read"),
  ];
  let checks = 0;
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.endsWith("/check")) checks += 1;
    const value = checks < 3 ? initial : [
      checks === 3 ? initial[0] : available(),
      available(new Date(Date.now() + 120_000).toISOString(), "powerPlatform.inventory.read"),
    ];
    return Response.json({ value });
  }));
  const { result } = renderHook(() => useCapabilities(user));
  await act(async () => {});
  await act(() => vi.advanceTimersByTimeAsync(10_100));
  expect(checks).toBe(3);
  expect(providerActionAllowed(result.current.views[0], false, result.current.now)).toBe(false);

  await act(() => vi.advanceTimersByTimeAsync(21_000));
  expect(checks).toBe(4);
  expect(result.current.views.every(view => providerActionAllowed(view, false, result.current.now))).toBe(true);
});

it.each([true, false])("settles an overdue retry after an intervening check finishes (evidence still expired: %s)", async stillExpired => {
  vi.useFakeTimers();
  const initial = [
    available(new Date(Date.now() + 1_000).toISOString()),
    available(new Date(Date.now() + 10_000).toISOString(), "powerPlatform.inventory.read"),
  ];
  let checks = 0;
  let resolveInterveningCheck!: (value: Response) => void;
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.endsWith("/check")) checks += 1;
    if (checks === 3) return new Promise<Response>(resolve => { resolveInterveningCheck = resolve; });
    return Response.json({ value: checks < 4 ? initial : [
      available(),
      available(undefined, "powerPlatform.inventory.read"),
    ] });
  }));
  const { result } = renderHook(() => useCapabilities(user));
  await act(async () => {});
  await act(() => vi.advanceTimersByTimeAsync(1_001));
  expect(checks).toBe(2);
  await act(() => vi.advanceTimersByTimeAsync(9_000));
  expect(checks).toBe(3);
  expect(result.current.pending).toBe(true);

  await act(() => vi.advanceTimersByTimeAsync(21_000));
  expect(checks).toBe(3);
  await act(async () => resolveInterveningCheck(Response.json({ value: [
    stillExpired ? initial[0] : available(),
    available(undefined, "powerPlatform.inventory.read"),
  ] })));
  expect(checks).toBe(stillExpired ? 4 : 3);
  expect(result.current.views.every(view => providerActionAllowed(view, false, result.current.now))).toBe(true);
  await act(() => vi.advanceTimersByTimeAsync(30_000));
  expect(checks).toBe(stillExpired ? 4 : 3);
});

it("does not spend the retry budget when an intervening expiry replaces a queued timer", async () => {
  vi.useFakeTimers();
  const initial = [
    available(new Date(Date.now() + 1_000).toISOString()),
    available(new Date(Date.now() + 10_000).toISOString(), "powerPlatform.inventory.read"),
    available(new Date(Date.now() + 20_000).toISOString(), "graph.directory.read"),
  ];
  let checks = 0;
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.endsWith("/check")) checks += 1;
    return Response.json({ value: checks < 4 ? initial : [
      checks === 4 ? initial[0] : available(),
      available(undefined, "powerPlatform.inventory.read"),
      available(undefined, "graph.directory.read"),
    ] });
  }));
  const { result } = renderHook(() => useCapabilities(user));
  await act(async () => {});
  await act(() => vi.advanceTimersByTimeAsync(1_100));
  expect(checks).toBe(2);
  await act(() => vi.advanceTimersByTimeAsync(9_000));
  expect(checks).toBe(3);
  await act(() => vi.advanceTimersByTimeAsync(10_000));
  expect(checks).toBe(4);
  await act(() => vi.advanceTimersByTimeAsync(30_000));
  expect(checks).toBe(5);
  expect(result.current.views.every(view => providerActionAllowed(view, false, result.current.now))).toBe(true);
});

it("recovers from an early cached check with staggered expiries before the reported stale screenshot", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-16T15:05:56.150Z"));
  const firstExpiry = Date.parse("2026-09-16T15:10:47.952Z");
  const laterExpiry = Date.parse("2026-09-16T15:10:56.150Z");
  let views = [
    available(new Date(firstExpiry).toISOString(), "powerPlatform.inventory.read"),
    available(new Date(laterExpiry).toISOString()),
  ];
  let checks = 0;
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.endsWith("/check")) {
      checks += 1;
      // The browser can reach expiry while the server still reuses fresh evidence.
      const serverNow = Date.now() - 52;
      views = views.map(view => Date.parse(view.decision.expiresAt!) > serverNow ? view : {
        ...view,
        decision: {
          ...view.decision,
          checkedAt: new Date(serverNow).toISOString(),
          expiresAt: new Date(serverNow + 5 * 60_000).toISOString(),
        },
      });
    }
    return Response.json({ value: views });
  }));

  const { result } = renderHook(() => useCapabilities(user));
  await act(async () => {});
  await act(() => vi.advanceTimersByTimeAsync(firstExpiry - Date.now() + 1));
  expect(checks).toBe(2);
  expect(Date.now() - 52).toBe(Date.parse("2026-09-16T15:10:47.901Z"));
  expect(Date.parse(result.current.views[0].decision.expiresAt!)).toBe(firstExpiry);
  expect(providerActionAllowed(result.current.views[0], false, result.current.now)).toBe(false);

  await act(() => vi.advanceTimersByTimeAsync(laterExpiry - Date.now() + 1));
  expect(checks).toBe(3);
  await act(() => vi.advanceTimersByTimeAsync(30_000));
  expect(checks).toBe(4);
  await act(() => vi.advanceTimersByTimeAsync(Date.parse("2026-09-16T15:15:39Z") - Date.now()));
  expect(checks).toBe(4);
  expect(result.current.views.every(view => providerActionAllowed(view, false, Date.now()))).toBe(true);
});

it("bounds retries when successful checks never renew expired evidence", async () => {
  vi.useFakeTimers();
  const stale = available(new Date(Date.now() - 1).toISOString());
  const fetchMock = vi.fn(async () => Response.json({ value: [stale] }));
  vi.stubGlobal("fetch", fetchMock);

  const { result } = renderHook(() => useCapabilities(user));
  await act(async () => {});
  expect(fetchMock).toHaveBeenCalledTimes(2);
  await act(() => vi.advanceTimersByTimeAsync(30_000));
  expect(fetchMock).toHaveBeenCalledTimes(3);
  await act(() => vi.advanceTimersByTimeAsync(5 * 60_000));
  act(() => window.dispatchEvent(new Event("focus")));
  await act(async () => {});
  expect(fetchMock).toHaveBeenCalledTimes(3);
  expect(result.current.pending).toBe(false);
  expect(providerActionAllowed(result.current.views[0], false, result.current.now)).toBe(false);
});

it("defers an expiry retry while hidden and resumes when the page becomes visible", async () => {
  vi.useFakeTimers();
  const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  const stale = available(new Date(Date.now() - 1).toISOString());
  let checks = 0;
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.endsWith("/check")) checks += 1;
    return Response.json({ value: [checks < 2 ? stale : available()] });
  }));

  const { result } = renderHook(() => useCapabilities(user));
  await act(async () => {});
  expect(checks).toBe(1);
  visibility.mockReturnValue("hidden");
  await act(() => vi.advanceTimersByTimeAsync(30_000));
  expect(checks).toBe(1);

  visibility.mockReturnValue("visible");
  await act(async () => document.dispatchEvent(new Event("visibilitychange")));
  expect(checks).toBe(2);
  expect(providerActionAllowed(result.current.views[0], false, result.current.now)).toBe(true);
});

it.each([true, false])("cancels a scheduled expiry retry on logout after a successful check: %s", async succeeds => {
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
  expect(result.current.error).toContain("Existing decisions and saved-data permissions are unchanged");
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
