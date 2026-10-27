import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ApiError, getInventoryHealth, type UnifiedAgentInventoryHealth, type UnifiedAgentInventoryUnavailable } from "./api/client";
import { useBrowserAvailability } from "./useBrowserAvailability";
import { useSavedRead } from "./savedQueries";
import { inventoryUpdating } from "./inventoryVerification";

const checkIntervalMs = 30_000;
const requestTimeoutMs = 30_000;
type Receipt = { owner: string; revision: string; reload: number; inventory?: UnifiedAgentInventoryHealth; unavailable?: UnifiedAgentInventoryUnavailable; error?: string; loading: boolean };

export function useInventoryHealth(principalKey: string, enabled: boolean, revision: string, onDenied?: (error: ApiError) => void) {
  const [receipt, setReceipt] = useState<Receipt>();
  const [reload, setReload] = useState(0);
  const available = useBrowserAvailability();
  const readSaved = useSavedRead();
  const denied = useRef(onDenied);
  const retry = useRef<(Pick<Receipt, "owner" | "revision" | "reload"> & { dueAt: number }) | undefined>(undefined);
  useLayoutEffect(() => { denied.current = onDenied; }, [onDenied]);
  useEffect(() => {
    if (!enabled || !available) return;
    let active = true;
    let request: AbortController | undefined;
    let requestTimeout: number | undefined;
    const identity = { owner: principalKey, revision, reload };
    let timer: number | undefined;
    let invalidations = 0;
    const schedule = (delay: number) => {
      if (!active) return;
      // Longer Retry-After values must not overflow into immediate retries.
      const interval = Math.min(delay, 2_147_483_647);
      timer = window.setTimeout(() => {
        if (delay > interval) schedule(delay - interval);
        else void read();
      }, interval);
    };
    const read = async () => {
      if (!active) return;
      retry.current = undefined;
      const controller = new AbortController();
      request = controller;
      let timedOut = false;
      requestTimeout = window.setTimeout(() => { timedOut = true; controller.abort(); }, requestTimeoutMs);
      setReceipt(previous => ({ ...(previous?.owner === principalKey && previous.revision === revision && previous.reload === reload ? previous : {}),
        ...identity, loading: true }));
      try {
        const next = await readSaved(["workspace-inventory-health", principalKey, revision, reload, invalidations],
          signal => getInventoryHealth({ signal }), controller.signal);
        if (!active || controller.signal.aborted) return;
        invalidations = 0;
        setReceipt("state" in next ? { ...identity, unavailable: next, loading: false }
          : { ...identity, inventory: next, loading: false });
        const updating = "state" in next ? next.state === "preparing" : ["catching_up", "reconciling", "stale"].includes(next.freshness.state);
        schedule(updating ? 1_000 : checkIntervalMs);
      } catch (reason) {
        if (!active) return;
        const failure = timedOut ? new Error("Workspace inventory health check timed out.") : reason;
        if (failure instanceof ApiError && ["selection_invalidated", "inventory_changed"].includes(failure.code) && invalidations < 2) {
          invalidations += 1;
          schedule(100);
          return;
        }
        setReceipt({ ...identity, loading: false,
          error: failure instanceof Error ? failure.message : "Workspace inventory health could not be checked." });
        if (failure instanceof ApiError && [401, 403].includes(failure.status)) denied.current?.(failure);
        else if (timedOut || failure instanceof ApiError
          && (failure.kind === "network" || [408, 429].includes(failure.status) || failure.status >= 500)) {
          const delay = Math.max(checkIntervalMs, failure instanceof ApiError ? (failure.retryAfterSeconds ?? 0) * 1_000 : 0);
          retry.current = { ...identity, dueAt: Date.now() + delay };
          schedule(delay);
        }
      } finally {
        window.clearTimeout(requestTimeout);
        requestTimeout = undefined;
        request = undefined;
      }
    };
    const backoff = retry.current;
    const delay = backoff?.owner === principalKey && backoff.revision === revision && backoff.reload === reload
      ? backoff.dueAt - Date.now() : 0;
    if (delay > 0) schedule(delay);
    else void read();
    return () => {
      active = false;
      request?.abort();
      if (requestTimeout !== undefined) window.clearTimeout(requestTimeout);
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [available, enabled, principalKey, readSaved, reload, revision]);
  const current = enabled && receipt?.owner === principalKey && receipt.revision === revision && receipt.reload === reload ? receipt : undefined;
  const loading = enabled && (!current || current.loading && !inventoryUpdating(current.inventory));
  const checking = useRef(false);
  useLayoutEffect(() => { checking.current = enabled && (loading || Boolean(current?.error) || !current?.inventory); },
    [current, enabled, loading]);
  return { inventory: current?.inventory, unavailable: current?.unavailable, error: current?.error,
    loading, isChecking: () => checking.current,
    refresh: () => { checking.current = true; setReload(value => value + 1); } };
}
