import { useContext, useEffect, useState } from "react";
import { CapabilityContext } from "./capabilityContext";
import { ApiError } from "./api/client";
import { readReportPage, type ReportPageRequest } from "./api/reportData";
import { useSavedQuery } from "./savedQueries";
import type { ReportPage } from "../../backend/src/types/officialReportData";

export function useReportPrincipalScope() {
  const capability = useContext(CapabilityContext), user = capability?.user;
  return JSON.stringify([user?.tenantId, user?.homeAccountId, [...(user?.roles ?? [])].sort()]);
}

export function useReportPage<T>(path: string, query: ReportPageRequest = {}, revision = 0, enabled = true, restartParent?: () => void) {
  const scope = useReportPrincipalScope();
  const key = JSON.stringify([scope, path, query]);
  const [navigation, setNavigation] = useState<{ key: string; cursor?: string; selectionId?: string; restart: number }>({ key, restart: 0 });
  const [captured, setCaptured] = useState<{ key: string; restart: number; id: string }>();
  const [manualRetry, setManualRetry] = useState<{ key: string; token: object }>();
  if (navigation.key !== key) {
    setNavigation({ key, restart: 0 });
    if (captured) setCaptured(undefined);
  }
  if (manualRetry && manualRetry.key !== key) setManualRetry(undefined);
  const current = navigation.key === key ? navigation : { key, restart: 0 };
  const selectionId = current.selectionId ?? (captured?.key === key && captured.restart === current.restart ? captured.id : undefined);
  const request = { ...query, ...(selectionId ? { selectionId } : {}),
    ...(current.cursor ? { cursor: current.cursor } : {}), limit: query.limit ?? 50 };
  const read = useSavedQuery<ReportPage<T>>({
    queryKey: ["saved", "record-page", key, revision, current.restart, current.selectionId, current.cursor, enabled],
    queryFn: async ({ signal }) => {
      const result = await readReportPage<T>(path, request, signal);
      signal.throwIfAborted();
      if (request.selectionId && result.selection.id !== request.selectionId || query.setId && result.reports.setId !== query.setId) {
        throw new ApiError(409, "selection_invalidated", "The returned evidence does not match the requested selection.");
      }
      return result;
    }, enabled,
    placeholderData: (previous, previousQuery) => previousQuery?.queryKey[2] === key
      && previousQuery.queryKey[4] === current.restart && previousQuery.queryKey[6] === current.cursor
      && previousQuery.queryKey[7] === enabled ? previous : undefined,
    staleTime: Infinity, gcTime: 0,
  });
  const refetch = read.refetch;
  useEffect(() => {
    if (!enabled) return;
    const revalidate = () => { void refetch({ cancelRefetch: false }); };
    window.addEventListener("focus", revalidate);
    return () => window.removeEventListener("focus", revalidate);
  }, [enabled, refetch]);
  if (read.data && (captured?.key !== key || captured.restart !== current.restart || captured.id !== read.data.selection.id)) {
    setCaptured({ key, restart: current.restart, id: read.data.selection.id });
  }
  const invalidated = read.error instanceof ApiError && read.error.code === "selection_invalidated";
  const data = read.isError || !enabled || manualRetry?.key === key ? undefined : read.data;
  function move(cursor: string | null | undefined) {
    if (!data || !cursor) return;
    setNavigation({ key, cursor, selectionId: data.selection.id, restart: current.restart });
  }
  return {
    data, loading: enabled && (read.isPending || read.isFetching), error: read.error, invalidated,
    next: () => move(data?.page.nextCursor), previous: () => move(data?.page.previousCursor),
    restartable: !query.selectionId || Boolean(restartParent),
    restart: () => {
      if (query.selectionId) restartParent?.();
      else setNavigation({ key, restart: current.restart + 1 });
    },
    retry: () => {
      if (!enabled) return;
      const token = {};
      setManualRetry({ key, token });
      void refetch().finally(() => setManualRetry(previous => previous?.token === token ? undefined : previous));
    },
  };
}
