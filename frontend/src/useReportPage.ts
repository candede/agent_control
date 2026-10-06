import { useContext, useEffect, useId, useState } from "react";
import { useQuery, type QueryClient, type QueryKey } from "@tanstack/react-query";
import { CapabilityContext } from "./capabilityContext";
import { ApiError } from "./api/client";
import { readReportPage, type ReportPageRequest } from "./api/reportData";
import { useSavedQueryClient } from "./savedQueries";
import type { ReportListPage, ReportPage } from "../../backend/src/types/officialReportData";

const cohortCacheMs = 30_000;
const retainedPagePaths = new Set([
  "copilot-usage/users", "official-usage/users", "official-usage/overview", "official-usage/history/options",
]);
// Cache-owned key objects keep retirement alive across responses, but not beyond query collection.
const retiredCaptures = new WeakMap<QueryKey, object>();

function invalidateReportPages(client: QueryClient, key: string, revision: number, excludeRestartKey?: string | number) {
  for (const cached of client.getQueryCache().findAll({
    queryKey: ["saved", "record-page", key, revision],
    predicate: query => query.queryKey[4] !== excludeRestartKey,
  })) {
    retiredCaptures.set(cached.queryKey, {});
    cached.invalidate();
  }
}

async function readCurrentReportPage<T, Page extends ReportListPage<T>>(path: string, request: ReportPageRequest, signal: AbortSignal, cachedKey: QueryKey) {
  const retirement = retiredCaptures.get(cachedKey);
  const result = await readReportPage<T, Page>(path, request, signal);
  signal.throwIfAborted();
  if (request.selectionId && result.selection.id.toLowerCase() !== request.selectionId.toLowerCase()
    || request.setId && result.reports.setId?.toLowerCase() !== request.setId.toLowerCase()) {
    throw new ApiError(409, "selection_invalidated", "The returned evidence does not match the requested selection.");
  }
  const expiresAt = Date.parse(result.selection.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    throw new ApiError(409, "selection_invalidated", "The returned report selection has expired. Load a new selection.");
  }
  if (!request.selectionId && !request.cursor && retiredCaptures.get(cachedKey) === retirement) retiredCaptures.delete(cachedKey);
  return result;
}

export function useReportPrincipalScope() {
  const capability = useContext(CapabilityContext), user = capability?.user;
  return JSON.stringify([user?.tenantId, user?.homeAccountId, [...(user?.roles ?? [])].sort()]);
}

export function useReportPage<T, Page extends ReportListPage<T> = ReportPage<T>>(path: string, query: ReportPageRequest = {}, revision = 0, enabled = true, restartParent?: () => void) {
  const scope = useReportPrincipalScope();
  const client = useSavedQueryClient();
  const owner = useId();
  const key = JSON.stringify([scope, path, query, query.selectionId ? undefined : revision]);
  const [highestRevision, setHighestRevision] = useState(revision);
  const [navigation, setNavigation] = useState<{ key: string; cursor?: string; selectionId?: string; restart: number; shared?: boolean }>({ key, restart: 0, shared: true });
  const [captured, setCaptured] = useState<{ key: string; restart: number; id: string }>();
  const [manualRetry, setManualRetry] = useState<{ key: string; token: object }>();
  const [automaticallyRestartedThrough, setAutomaticallyRestartedThrough] = useState(-1);
  const [now, setNow] = useState(Date.now);
  const reusablePage = retainedPagePaths.has(path) && !query.selectionId;
  const current = navigation.key === key ? navigation : { key, restart: navigation.restart + 1, shared: reusablePage || revision > highestRevision };
  if (revision > highestRevision) setHighestRevision(revision);
  if (navigation.key !== key) {
    setNavigation(current);
    if (captured) setCaptured(undefined);
  }
  const selectionId = current.selectionId ?? (captured?.key === key && captured.restart === current.restart ? captured.id : undefined);
  const request = { ...query, ...(selectionId ? { selectionId } : {}),
    ...(current.cursor ? { cursor: current.cursor } : {}), limit: query.limit ?? 50 };
  // Recent top-level reads can be reused; explicit restarts and details stay observer-owned.
  const restartKey = current.shared ? 0 : `${owner}:${current.restart}`;
  const retain = enabled && restartKey === 0 && reusablePage && !current.cursor;
  const queryKey = ["saved", "record-page", key, revision, restartKey, current.selectionId, current.cursor, enabled];
  const retryKey = JSON.stringify(queryKey);
  if (manualRetry && manualRetry.key !== retryKey) setManualRetry(undefined);
  const read = useQuery<Page>({
    queryKey,
    queryFn: ({ signal, queryKey: cachedKey }) => readCurrentReportPage<T, Page>(path, request, signal, cachedKey), enabled,
    placeholderData: (previous, previousQuery) => previousQuery?.queryKey[2] === key
      && previousQuery.queryKey[4] === restartKey && previousQuery.queryKey[6] === current.cursor
      && previousQuery.queryKey[7] === enabled ? previous : undefined,
    staleTime: retain ? cached => retiredCaptures.has(cached.queryKey) ? 0 : Math.max(0, Math.min(cohortCacheMs,
      Date.parse(cached.state.data?.selection.expiresAt ?? "") - cached.state.dataUpdatedAt) || 0) : Infinity,
    gcTime: retain ? cohortCacheMs : 0,
    meta: { retainReportPage: retain },
  }, client);
  const refetch = read.refetch;
  useEffect(() => {
    if (!enabled) return;
    const revalidate = () => { setNow(Date.now()); void refetch({ cancelRefetch: false }); };
    window.addEventListener("focus", revalidate);
    return () => window.removeEventListener("focus", revalidate);
  }, [enabled, refetch]);
  const awaitingCapture = captured?.key !== key || captured.restart !== current.restart;
  const retiredCapture = retain && awaitingCapture && Boolean(client.getQueryCache().find({
    queryKey, exact: true, predicate: cached => retiredCaptures.has(cached.queryKey),
  }));
  if (read.data && !read.isFetching && !retiredCapture && (awaitingCapture || captured?.id !== read.data.selection.id)) {
    setCaptured({ key, restart: current.restart, id: read.data.selection.id });
  }
  const expiresAt = read.data ? Date.parse(read.data.selection.expiresAt) : undefined;
  useEffect(() => {
    if (!enabled || expiresAt === undefined || expiresAt <= now) return;
    const timer = window.setTimeout(() => setNow(Date.now()), Math.min(2_147_483_647, Math.max(0, expiresAt - Date.now())));
    return () => window.clearTimeout(timer);
  }, [enabled, expiresAt, now]);
  const expired = expiresAt !== undefined && expiresAt <= now;
  const error = read.error ?? ((expired || retiredCapture) && !read.isFetching
    ? new ApiError(409, "selection_invalidated", "The report selection changed or expired. Load a new selection.") : null);
  const invalidated = error instanceof ApiError && error.code === "selection_invalidated";
  const recovering = invalidated && !query.selectionId && automaticallyRestartedThrough < current.restart;
  if (recovering) {
    setAutomaticallyRestartedThrough(current.restart + 1);
    setNavigation({ key, restart: current.restart + 1 });
  }
  useEffect(() => {
    if (automaticallyRestartedThrough !== current.restart) return;
    invalidateReportPages(client, key, revision, restartKey);
  }, [automaticallyRestartedThrough, client, current.restart, key, restartKey, revision]);
  const revalidatingCache = retain && read.isFetching && read.isStale;
  const data = read.isError || !enabled || expired || retiredCapture || revalidatingCache || manualRetry?.key === retryKey ? undefined : read.data;
  function move(cursor: string | null | undefined) {
    if (!data || !cursor) return;
    setNavigation({ key, cursor, selectionId: data.selection.id, restart: current.restart, shared: current.shared });
  }
  return {
    data, loading: enabled && (read.isPending || read.isFetching || recovering),
    error: recovering ? null : error, invalidated: invalidated && !recovering,
    recoveryRevision: automaticallyRestartedThrough,
    next: () => move(data?.page.nextCursor), previous: () => move(data?.page.previousCursor),
    restartable: !query.selectionId || Boolean(restartParent),
    restart: () => {
      if (query.selectionId) restartParent?.();
      else {
        invalidateReportPages(client, key, revision);
        setNavigation({ key, restart: current.restart + 1 });
      }
    },
    retry: () => {
      if (!enabled) return;
      const token = {};
      setManualRetry({ key: retryKey, token });
      void refetch().finally(() => setManualRetry(previous => previous?.token === token ? undefined : previous));
    },
  };
}
