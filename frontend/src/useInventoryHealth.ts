import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ApiError, getInventoryHealth, type UnifiedAgentInventoryHealth, type UnifiedAgentInventoryUnavailable } from "./api/client";
import { useBrowserAvailability } from "./useBrowserAvailability";
import { useSavedRead } from "./savedQueries";

type Receipt = { owner: string; revision: string; reload: number; inventory?: UnifiedAgentInventoryHealth; unavailable?: UnifiedAgentInventoryUnavailable; error?: string; loading: boolean };

export function useInventoryHealth(principalKey: string, enabled: boolean, revision: string, onDenied?: (error: ApiError) => void) {
  const [receipt, setReceipt] = useState<Receipt>();
  const [reload, setReload] = useState(0);
  const available = useBrowserAvailability();
  const readSaved = useSavedRead();
  const denied = useRef(onDenied);
  useLayoutEffect(() => { denied.current = onDenied; }, [onDenied]);
  useEffect(() => {
    if (!enabled || !available) return;
    const controller = new AbortController();
    const identity = { owner: principalKey, revision, reload };
    let timer: number | undefined;
    let invalidations = 0;
    const read = async () => {
      setReceipt(previous => ({ ...(previous?.owner === principalKey && previous.revision === revision && previous.reload === reload ? previous : {}),
        ...identity, loading: true }));
      try {
        const next = await readSaved(["workspace-inventory-health", principalKey, revision, reload, invalidations],
          signal => getInventoryHealth({ signal }), controller.signal);
        if (controller.signal.aborted) return;
        invalidations = 0;
        setReceipt("state" in next ? { ...identity, unavailable: next, loading: false }
          : { ...identity, inventory: next, loading: false });
        const updating = "state" in next ? next.state === "preparing" : ["catching_up", "reconciling", "stale"].includes(next.freshness.state);
        timer = window.setTimeout(() => void read(), updating ? 1_000 : 30_000);
      } catch (reason) {
        if (controller.signal.aborted) return;
        if (reason instanceof ApiError && ["selection_invalidated", "inventory_changed"].includes(reason.code) && invalidations < 2) {
          invalidations += 1;
          timer = window.setTimeout(() => void read(), 100);
          return;
        }
        setReceipt({ ...identity, loading: false,
          error: reason instanceof Error ? reason.message : "Workspace inventory health could not be checked." });
        if (reason instanceof ApiError && [401, 403].includes(reason.status)) denied.current?.(reason);
      }
    };
    void read();
    return () => { controller.abort(); if (timer !== undefined) window.clearTimeout(timer); };
  }, [available, enabled, principalKey, readSaved, reload, revision]);
  const current = enabled && receipt?.owner === principalKey && receipt.revision === revision && receipt.reload === reload ? receipt : undefined;
  const loading = enabled && (!current || current.loading
    || Boolean(current.inventory && ["catching_up", "reconciling", "stale"].includes(current.inventory.freshness.state)));
  const checking = useRef(false);
  useLayoutEffect(() => { checking.current = enabled && (loading || Boolean(current?.error) || !current?.inventory); },
    [current, enabled, loading]);
  return { inventory: current?.inventory, unavailable: current?.unavailable, error: current?.error,
    loading, isChecking: () => checking.current,
    refresh: () => { checking.current = true; setReload(value => value + 1); } };
}
