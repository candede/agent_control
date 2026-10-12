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
    await advance(30_000);
    expect(read).toHaveBeenCalledTimes(2);
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
    expect(view.result.current.loading).toBe(true);
    await advance(1_000);
    expect(view.result.current.loading).toBe(false);
    expect(view.result.current.inventory).toEqual(receipt);
    expect(read).toHaveBeenCalledTimes(3);
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
