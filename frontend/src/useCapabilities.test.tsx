import { StrictMode, type ReactNode } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { capabilityDefinitions } from "../../backend/src/services/capabilityRegistry";
import type { CapabilityView, SessionUser } from "./api/client";
import { providerActionAllowed } from "./capabilityState";
import { useCapabilities } from "./useCapabilities";

const user: SessionUser = {
  displayName: "Fixture",
  username: "fixture@example.invalid",
  homeAccountId: "fixture-a",
  tenantId: "tenant-a",
  roles: ["AgentControl.Viewer"],
};

function available(expiresAt = new Date(Date.now() + 60_000).toISOString()): CapabilityView {
  return {
    definition: capabilityDefinitions[0],
    decision: {
      capabilityId: "graph.package.read.delegated",
      status: "available",
      authorized: true,
      fresh: true,
      verification: "provider",
      expiresAt,
      previewQualification: "not_required",
      remediation: [],
    },
  };
}

afterEach(() => {
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
  const fetchMock = vi.fn(async (url: string) => {
    void url;
    return Response.json({ value: [available()] });
  });
  vi.stubGlobal("fetch", fetchMock);

  renderHook(() => useCapabilities(user), {
    wrapper: ({ children }: { children: ReactNode }) => <StrictMode>{children}</StrictMode>,
  });

  await waitFor(() => expect(fetchMock.mock.calls.filter(call => String(call[0]).endsWith("/check"))).toHaveLength(1));
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
