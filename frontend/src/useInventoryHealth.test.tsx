import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, getInventoryHealth, type UnifiedAgentInventoryHealth } from "./api/client";
import { useInventoryHealth } from "./useInventoryHealth";
import { createUnifiedVerification } from "./test/inventoryVerification";

vi.mock("./api/client", async original => ({
  ...await original<typeof import("./api/client")>(), getInventoryHealth: vi.fn(),
}));
const read = vi.mocked(getInventoryHealth);
const receipt: UnifiedAgentInventoryHealth = {
  freshness: { state: "idle", capturedRevision: "8", sources: [] },
  summary: { total: 0, linked: 0, graphOnly: 0, powerPlatformOnly: 0, conflicting: 0, ambiguous: 0 },
  verification: createUnifiedVerification({ graphPackageCount: 0, powerPlatformAgentCount: 0, logicalAgentCount: 0 }),
  identityCollection: { checkedPackages: 0, pendingPackages: 0 },
  sources: { graphPackages: { state: "unavailable", observation: null,
    error: { source: "graph_packages", code: "snapshot_unavailable", message: "No saved source." } },
    powerPlatform: { state: "unavailable", observation: null,
      error: { source: "power_platform", code: "snapshot_unavailable", message: "No saved source." } } },
  partial: false, errors: [],
};
const initial = { principal: "viewer-1", enabled: true, revision: "reports-0:catalog-1" };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function useHealth(props: typeof initial) { return useInventoryHealth(props.principal, props.enabled, props.revision); }
async function settle() { await act(async () => { await Promise.resolve(); }); }
async function advance(ms: number) { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); }
beforeEach(() => {
  vi.useFakeTimers();
  read.mockReset().mockResolvedValue(receipt);
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe("fresh workspace health independent of frozen browsing", () => {
  it("checks saved health without any selection coordinates and rereads rather than reusing a cached receipt", async () => {
    const view = renderHook(useHealth, { initialProps: initial });
    await settle();
    expect(view.result.current.inventory).toEqual(receipt);
    expect(read).toHaveBeenCalledWith({ signal: expect.any(AbortSignal) });
    await advance(5 * 60_000);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it.each([
    new ApiError(0, "network_error", "The server could not be reached.", { kind: "network" }),
    new ApiError(408, "request_timeout", "The request timed out."),
    new ApiError(503, "service_unavailable", "Saved data is temporarily unavailable."),
  ])("recovers automatically after a transient health failure: $code", async error => {
    read.mockRejectedValueOnce(error);
    const view = renderHook(useHealth, { initialProps: initial });
    await settle();
    expect(view.result.current.error).toBe(error.message);
    expect(view.result.current.loading).toBe(false);
    expect(view.result.current.isChecking()).toBe(true);
    await advance(29_999);
    expect(read).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(read).toHaveBeenCalledTimes(2);
    expect(view.result.current.inventory).toEqual(receipt);
    expect(view.result.current.error).toBeUndefined();
    expect(view.result.current.isChecking()).toBe(false);
  });

  it.each([90, 2_147_484])("respects a %s-second Retry-After without overflowing the browser timer", async seconds => {
    read.mockRejectedValueOnce(new ApiError(429, "rate_limited", "Try again later.", { retryAfterSeconds: seconds }));
    const view = renderHook(useHealth, { initialProps: initial });
    await settle();
    expect(view.result.current.error).toBe("Try again later.");
    await advance(seconds * 1_000 - 1);
    expect(read).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(read).toHaveBeenCalledTimes(2);
    expect(view.result.current.inventory).toEqual(receipt);
  });

  it("preserves Retry-After when a hidden tab becomes visible again", async () => {
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    read.mockRejectedValueOnce(new ApiError(429, "rate_limited", "Try again later.", { retryAfterSeconds: 90 }));
    const view = renderHook(useHealth, { initialProps: initial });
    await settle();
    await advance(10_000);
    act(() => {
      visibility.mockReturnValue("hidden");
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await advance(20_000);
    act(() => {
      visibility.mockReturnValue("visible");
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await advance(59_999);
    expect(read).toHaveBeenCalledTimes(1);
    expect(view.result.current.error).toBe("Try again later.");
    await advance(1);
    expect(read).toHaveBeenCalledTimes(2);
    expect(view.result.current.inventory).toEqual(receipt);
  });

  it.each([false, true])("bounds an unresponsive health check and recovers without accepting its late result (background: %s)", async background => {
    const pending = deferred<UnifiedAgentInventoryHealth>();
    if (background) read.mockResolvedValueOnce({ ...receipt, partial: true,
      freshness: { ...receipt.freshness, state: "reconciling" },
      verification: { ...receipt.verification, status: "updating" } });
    read.mockReturnValueOnce(pending.promise);
    const view = renderHook(useHealth, { initialProps: initial });
    await settle();
    if (background) await advance(1_000);
    const signal = read.mock.calls.at(-1)?.[0]?.signal;
    await advance(29_999);
    expect(signal?.aborted).toBe(false);
    await advance(1);
    expect(signal?.aborted).toBe(true);
    expect(view.result.current.loading).toBe(false);
    expect(view.result.current.error).toMatch(/timed out/i);
    expect(view.result.current.inventory).toBeUndefined();
    await advance(30_000);
    expect(view.result.current.inventory).toEqual(receipt);
    expect(view.result.current.error).toBeUndefined();
    await act(async () => pending.resolve({ ...receipt, freshness: { ...receipt.freshness, capturedRevision: "late" } }));
    expect(view.result.current.inventory).toEqual(receipt);
  });

  it.each([401, 403, 400])("keeps status %s terminal rather than retrying an authorization or contract failure", async status => {
    const onDenied = vi.fn();
    const error = new ApiError(status, "request_failed", "Health access failed.");
    read.mockRejectedValueOnce(error);
    const view = renderHook(() => useInventoryHealth(initial.principal, true, initial.revision, onDenied));
    await settle();
    await advance(90_000);
    expect(read).toHaveBeenCalledTimes(1);
    expect(view.result.current.error).toBe(error.message);
    expect(onDenied.mock.calls).toEqual(status === 400 ? [] : [[error]]);
  });

  it("observes first-run saved inventory becoming ready without a manual start", async () => {
    read.mockResolvedValueOnce({ state: "not_collected", message: "No saved inventory yet." })
      .mockResolvedValueOnce({ state: "preparing", message: "Preparing saved inventory." });
    const view = renderHook(useHealth, { initialProps: initial });
    await settle();
    expect(view.result.current.unavailable?.state).toBe("not_collected");
    await advance(1_000);
    expect(view.result.current.unavailable?.state).toBe("preparing");
    await advance(1_000);
    expect(view.result.current.unavailable).toBeUndefined();
    expect(view.result.current.inventory).toEqual(receipt);
  });

  it.each(["hidden", "offline"])("cancels pending checks while %s, resumes automatically and cleans up its timers", async boundary => {
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    const online = vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
    const pending = deferred<UnifiedAgentInventoryHealth>();
    read.mockReturnValueOnce(pending.promise);
    const view = renderHook(useHealth, { initialProps: initial });
    await settle();
    const signal = read.mock.calls[0][0]?.signal;
    act(() => {
      if (boundary === "hidden") {
        visibility.mockReturnValue("hidden");
        document.dispatchEvent(new Event("visibilitychange"));
      } else {
        online.mockReturnValue(false);
        window.dispatchEvent(new Event("offline"));
      }
    });
    await advance(60_000);
    expect(signal?.aborted).toBe(true);
    expect(read).toHaveBeenCalledTimes(1);
    expect(view.result.current.error).toBeUndefined();
    act(() => {
      visibility.mockReturnValue("visible");
      online.mockReturnValue(true);
      if (boundary === "hidden") document.dispatchEvent(new Event("visibilitychange"));
      else window.dispatchEvent(new Event("online"));
    });
    await settle();
    expect(read).toHaveBeenCalledTimes(2);
    expect(view.result.current.inventory).toEqual(receipt);
    await act(async () => pending.resolve({ ...receipt, freshness: { ...receipt.freshness, capturedRevision: "retired" } }));
    expect(view.result.current.inventory).toEqual(receipt);
    view.unmount();
    await advance(60_000);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("allows explicit recovery during retry backoff without leaving a duplicate scheduled check", async () => {
    read.mockRejectedValueOnce(new ApiError(503, "service_unavailable", "Try again later."));
    const view = renderHook(useHealth, { initialProps: initial });
    await settle();
    await advance(5_000);
    act(() => view.result.current.refresh());
    await settle();
    expect(view.result.current.inventory).toEqual(receipt);
    await advance(25_000);
    expect(read).toHaveBeenCalledTimes(2);
    await advance(5 * 60_000 - 25_000);
    expect(read).toHaveBeenCalledTimes(3);
  });

  it.each(["selection_invalidated", "inventory_changed"])("bounds rapid retries for repeated %s failures", async code => {
    read.mockRejectedValue(new ApiError(409, code, "Saved evidence changed."));
    const view = renderHook(useHealth, { initialProps: initial });
    await settle();
    await advance(200);
    expect(read).toHaveBeenCalledTimes(3);
    expect(view.result.current.error).toBe("Saved evidence changed.");
    expect(view.result.current.loading).toBe(false);
    await advance(60_000);
    expect(read).toHaveBeenCalledTimes(3);
  });

  it.each(["reports-1:catalog-1", "reports-0:catalog-2"])("withdraws the old receipt and checks new evidence for %s", async revision => {
    const view = renderHook(useHealth, { initialProps: initial });
    await settle();
    const pending = deferred<UnifiedAgentInventoryHealth>();
    read.mockReturnValueOnce(pending.promise);
    view.rerender({ ...initial, revision });
    expect(view.result.current.inventory).toBeUndefined();
    expect(view.result.current.loading).toBe(true);
    const updated = { ...receipt, freshness: { ...receipt.freshness, capturedRevision: "9" } };
    await act(async () => pending.resolve(updated));
    expect(view.result.current.inventory?.freshness.capturedRevision).toBe("9");
  });

  it("does not retain a Verified receipt on denial and allows a saved-only retry", async () => {
    const view = renderHook(useHealth, { initialProps: initial });
    await settle();
    read.mockRejectedValueOnce(new ApiError(403, "forbidden", "Health access denied."));
    act(() => view.result.current.refresh());
    await settle();
    expect(view.result.current.inventory).toBeUndefined();
    expect(view.result.current.error).toBe("Health access denied.");
    act(() => view.result.current.refresh());
    await settle();
    expect(view.result.current.inventory).toEqual(receipt);
  });

  it("retries report-import invalidation and converges without advising another catalog sync", async () => {
    read.mockRejectedValueOnce(new ApiError(409, "selection_invalidated", "Reports changed."))
      .mockResolvedValueOnce({ ...receipt, freshness: { ...receipt.freshness, state: "catching_up" } });
    const view = renderHook(useHealth, { initialProps: initial });
    await settle();
    await advance(100);
    expect(view.result.current.error).toBeUndefined();
    expect(view.result.current.loading).toBe(false);
    await advance(1_000);
    expect(view.result.current.loading).toBe(false);
    expect(view.result.current.inventory).toEqual(receipt);
    expect(read).toHaveBeenCalledTimes(3);
  });

  it("keeps completed publication progress visible during background polling and converges automatically", async () => {
    const updating: UnifiedAgentInventoryHealth = { ...receipt, partial: true,
      freshness: { ...receipt.freshness, state: "reconciling" },
      verification: { ...receipt.verification, status: "updating" } };
    read.mockResolvedValueOnce(updating);
    const view = renderHook(useHealth, { initialProps: initial });
    await settle();
    expect(view.result.current.inventory).toEqual(updating);
    expect(view.result.current.loading).toBe(false);
    const pending = deferred<UnifiedAgentInventoryHealth>();
    read.mockReturnValueOnce(pending.promise);
    await advance(1_000);
    expect(read).toHaveBeenCalledTimes(2);
    expect(view.result.current.inventory).toEqual(updating);
    expect(view.result.current.loading).toBe(false);
    await act(async () => pending.resolve(receipt));
    expect(view.result.current.inventory).toEqual(receipt);
    expect(view.result.current.loading).toBe(false);
    await advance(5 * 60_000);
    expect(read).toHaveBeenCalledTimes(3);
  });

  it("does not hide genuine failures behind a perpetual Checking label during reconciliation", async () => {
    const failed: UnifiedAgentInventoryHealth = { ...receipt, partial: true,
      freshness: { ...receipt.freshness, state: "reconciling" },
      verification: { ...receipt.verification, status: "needs_attention" } };
    read.mockResolvedValueOnce(failed);
    const view = renderHook(useHealth, { initialProps: initial });
    await settle();
    expect(view.result.current.inventory).toEqual(failed);
    expect(view.result.current.loading).toBe(false);
  });

  it("fences a late response from the previous account and stops reads when Sync is disabled", async () => {
    const pending = deferred<UnifiedAgentInventoryHealth>();
    read.mockReturnValueOnce(pending.promise);
    const view = renderHook(useHealth, { initialProps: initial });
    await settle();
    view.rerender({ ...initial, principal: "viewer-2" });
    await settle();
    await act(async () => pending.resolve({ ...receipt, freshness: { ...receipt.freshness, capturedRevision: "private-old-account" } }));
    expect(view.result.current.inventory).toEqual(receipt);
    view.rerender({ ...initial, principal: "viewer-2", enabled: false });
    await advance(60_000);
    expect(read).toHaveBeenCalledTimes(2);
    expect(view.result.current.inventory).toBeUndefined();
  });
});
