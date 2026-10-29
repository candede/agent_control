import { useEffect, useState } from "react";
import { isPublicationRevisions, type SelectedRead } from "../../backend/src/types/dataSelection";
import { compareInventoryInstants, isInventoryTimestamp } from "../../backend/src/types/inventoryTimestamp";
import { ApiError } from "./api/client";
import { savedQueryRetention } from "./savedQueries";

const timings = new WeakMap<SelectedRead, { leaseUntil: number; reuseUntil: number }>();

export function acceptSelectedRead<T extends { selection: SelectedRead }>(data: T, startedAt: number, published = true): T {
  const selection = data.selection;
  if (!selection || typeof selection.id !== "string" || !selection.id || typeof selection.revision !== "string"
    || !selection.revision || !isInventoryTimestamp(selection.evaluatedAt)
    || !isInventoryTimestamp(selection.validatedAt) || !isInventoryTimestamp(selection.expiresAt)
    || compareInventoryInstants(selection.evaluatedAt, selection.validatedAt) > 0
    || compareInventoryInstants(selection.expiresAt, selection.validatedAt) <= 0
    || published && !isPublicationRevisions("publicationRevisions" in selection ? selection.publicationRevisions : undefined)) {
    throw new ApiError(502, "invalid_selected_read", "The server returned incomplete or inconsistent saved-read metadata.");
  }
  // Charge the entire round trip, including time before DB validation. Calendar skew
  // cannot extend a lease; a slow successful response is still readable history.
  const leaseUntil = startedAt + inventoryDurationMilliseconds(selection.expiresAt, selection.validatedAt);
  if (!timings.has(selection)) timings.set(selection, { leaseUntil, reuseUntil: Math.min(leaseUntil, startedAt + savedQueryRetention.staleTime) });
  return data;
}

export function selectedReadRemaining(selection: SelectedRead | undefined) {
  return Math.max(0, (selection && timings.get(selection)?.leaseUntil || 0) - performance.now());
}

export function canReuseSelectedRead(selection: SelectedRead) {
  return (timings.get(selection)?.reuseUntil ?? 0) > performance.now();
}

export function isExpiredSelection(error: unknown) {
  return error instanceof ApiError && error.status === 409 && error.code === "selection_invalidated" && error.details?.reason === "expired";
}

export function withdrawsSelectedRead(error: unknown) {
  return error instanceof ApiError && ([401, 403].includes(error.status)
    || ["invalid_selected_read", "invalid_response", "inventory_changed"].includes(error.code)
    || error.code === "selection_invalidated" && !isExpiredSelection(error));
}

export function useSelectedReadLease(selection: SelectedRead | undefined) {
  const [, update] = useState(0);
  const remaining = selectedReadRemaining(selection);
  useEffect(() => {
    if (!selection) return;
    const check = () => update(value => value + 1);
    const timer = remaining ? window.setTimeout(check, Math.min(remaining, 2_147_483_647)) : undefined;
    window.addEventListener("focus", check);
    window.addEventListener("online", check);
    window.addEventListener("offline", check);
    document.addEventListener("visibilitychange", check);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("focus", check);
      window.removeEventListener("online", check);
      window.removeEventListener("offline", check);
      document.removeEventListener("visibilitychange", check);
    };
  }, [selection, remaining]);
  return Boolean(selection && remaining > 0);
}

function inventoryDurationMilliseconds(later: string, earlier: string) {
  const milliseconds = (value: string) => Date.parse(value.replace(/\.(\d+)(?=Z|[+-]\d{2}:\d{2}$)/,
    (_, fraction: string) => `.${fraction.slice(0, 3).padEnd(3, "0")}`));
  const remainder = (value: string) => Number(value.match(/\.(\d+)(?:Z|[+-]\d{2}:\d{2})$/)?.[1]
    .slice(3).padEnd(6, "0") ?? "0");
  return milliseconds(later) - milliseconds(earlier) + (remainder(later) - remainder(earlier)) / 1_000_000;
}
