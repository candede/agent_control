import { useEffect, useState } from "react";
import { isPublicationRevisions, type SelectedRead } from "../../backend/src/types/dataSelection";
import { ApiError } from "./api/client";

const timings = new WeakMap<SelectedRead, { leaseUntil: number; reuseUntil: number }>();
export const savedReadCacheMs = 30_000;

export function acceptSelectedRead<T extends { selection: SelectedRead }>(data: T, startedAt: number, published = true): T {
  const selection = data.selection;
  const evaluated = Date.parse(selection?.evaluatedAt);
  const validated = Date.parse(selection?.validatedAt);
  const expires = Date.parse(selection?.expiresAt);
  if (!selection || typeof selection.id !== "string" || !selection.id || typeof selection.revision !== "string"
    || !selection.revision || !Number.isFinite(evaluated) || !Number.isFinite(validated) || !Number.isFinite(expires)
    || evaluated > validated || expires <= validated
    || published && !isPublicationRevisions("publicationRevisions" in selection ? selection.publicationRevisions : undefined)) {
    throw new ApiError(502, "invalid_selected_read", "The server returned incomplete or inconsistent saved-read metadata.");
  }
  // Charge the entire round trip, including time before DB validation. Calendar skew
  // cannot extend a lease; a slow successful response is still readable history.
  const leaseUntil = startedAt + expires - validated;
  if (!timings.has(selection)) timings.set(selection, { leaseUntil, reuseUntil: Math.min(leaseUntil, startedAt + savedReadCacheMs) });
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
