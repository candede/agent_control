import { useContext, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { hashKey, useQuery, type QueryClient, type QueryKey } from "@tanstack/react-query";
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
const retiredCaptures = new WeakMap<QueryKey, { rejectedSelectionId?: string }>();

function invalidateReportPages(client: QueryClient, key: string, revision: number,
  { excludeRestartKey, excludeQueryKey, selectionId }: { excludeRestartKey?: string | number; excludeQueryKey?: QueryKey; selectionId?: string } = {}) {
  const rejectedSelectionId = selectionId?.toLowerCase();
  for (const cached of client.getQueryCache().findAll({
    // Revalidating a pinned selection at another revision cannot make rejected evidence usable.
    queryKey: rejectedSelectionId ? ["saved", "record-page", key] : ["saved", "record-page", key, revision],
    predicate: query => query.queryKey !== excludeQueryKey && query.queryKey[4] !== excludeRestartKey
      && (!rejectedSelectionId || query.queryKey[5] === rejectedSelectionId
        || (query.state.data as ReportListPage<unknown> | undefined)?.selection.id.toLowerCase() === rejectedSelectionId),
  })) {
    // Retirement blocks capture reuse; only rejection invalidates a peer's validated page.
    retiredCaptures.set(cached.queryKey, { rejectedSelectionId: rejectedSelectionId ?? retiredCaptures.get(cached.queryKey)?.rejectedSelectionId });
    if (rejectedSelectionId) {
      void client.cancelQueries({ queryKey: cached.queryKey, exact: true });
      // Idle observers may not track staleness, so publish rejected evidence as an error too.
      cached.setState({
        error: new ApiError(409, "selection_invalidated", "The report selection changed or expired. Load a new selection."),
        errorUpdatedAt: Date.now(), errorUpdateCount: cached.state.errorUpdateCount + 1, status: "error", isInvalidated: true,
      });
    }
  }
}

async function readCurrentReportPage<T, Page extends ReportListPage<T>>(path: string, request: ReportPageRequest, signal: AbortSignal, cachedKey: QueryKey, knownExpiresAt?: number) {
  if (request.selectionId && knownExpiresAt !== undefined && knownExpiresAt <= Date.now()) {
    throw new ApiError(409, "selection_invalidated", "The report selection has expired. Load a new selection.");
  }
  const retirement = retiredCaptures.get(cachedKey);
  const result = await readReportPage<T, Page>(path, request, signal);
  signal.throwIfAborted();
  if (retiredCaptures.get(cachedKey)?.rejectedSelectionId === result.selection.id.toLowerCase()) {
    throw new ApiError(409, "selection_invalidated", "The returned report selection was invalidated.");
  }
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

export function useReportPage<T, Page extends ReportListPage<T> = ReportPage<T>>(path: string, input: ReportPageRequest = {}, revision = 0, enabled = true, restartParent?: () => void, revalidateOnFocus = true, freshCaptureOnMount = false) {
  const query = { ...input, limit: input.limit ?? 50 };
  for (const field of ["setId", "selectionId", "inventorySelectionId"] as const) {
    if (query[field] !== undefined) query[field] = query[field].toLowerCase();
  }
  const scope = useReportPrincipalScope();
  const client = useSavedQueryClient();
  const owner = useId();
  const key = hashKey([scope, path, query, query.selectionId ? undefined : revision]);
  const [highestRevision, setHighestRevision] = useState(revision);
  const [navigation, setNavigation] = useState<{ key: string; cursor?: string; selectionId?: string; restart: number; shared?: boolean }>({ key, restart: 0, shared: !freshCaptureOnMount });
  const [captured, setCaptured] = useState<{ key: string; restart: number; id: string; expiresAt: number }>();
  const [rejected, setRejected] = useState<{ key: string; restart: number }>();
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
  const locallyInvalidated = rejected?.key === key && rejected.restart === current.restart;
  const selectionId = current.selectionId ?? (captured?.key === key && captured.restart === current.restart ? captured.id : undefined);
  const request = { ...query, ...(selectionId ? { selectionId } : {}),
    ...(current.cursor ? { cursor: current.cursor } : {}) };
  // Recent top-level reads can be reused; explicit restarts and details stay observer-owned.
  const restartKey = current.shared ? 0 : `${owner}:${current.restart}`;
  const retain = enabled && restartKey === 0 && reusablePage && !current.cursor;
  const queryKey = ["saved", "record-page", key, revision, restartKey, current.selectionId ?? query.selectionId, current.cursor, enabled];
  const retryKey = JSON.stringify(queryKey);
  // Child invalidation follows the selection; navigation and retry belong to one committed page.
  const actionKey = JSON.stringify([key, revision, current.restart, enabled]);
  const [actionOwner, setActionOwner] = useState({ client, key: actionKey });
  if (actionOwner.client !== client || actionOwner.key !== actionKey) setActionOwner({ client, key: actionKey });
  const actions = useRef<{ owner: typeof actionOwner; page: string; moved: boolean; restarted: boolean } | undefined>(undefined);
  useLayoutEffect(() => {
    actions.current = { owner: actionOwner, page: retryKey, moved: false, restarted: false };
    return () => { actions.current = undefined; };
  }, [actionOwner, retryKey]);
  if (manualRetry && manualRetry.key !== retryKey) setManualRetry(undefined);
  const read = useQuery<Page>({
    queryKey,
    queryFn: ({ signal, queryKey: cachedKey }) => {
      const cached = client.getQueryData<Page>(cachedKey);
      const knownExpiresAt = captured?.key === key && captured.restart === current.restart ? captured.expiresAt
        : cached ? Date.parse(cached.selection.expiresAt) : undefined;
      return readCurrentReportPage<T, Page>(path, request, signal, cachedKey, knownExpiresAt).catch(error => {
        if (!signal.aborted && request.selectionId && error instanceof ApiError && error.code === "selection_invalidated") {
          // Preserve this read's recovery while retiring peer evidence before observers render.
          invalidateReportPages(client, key, revision, { selectionId: request.selectionId, excludeQueryKey: cachedKey });
        }
        throw error;
      });
    },
    enabled: cached => enabled && !locallyInvalidated
      && !(cached.state.error instanceof ApiError && (cached.state.error.code === "selection_invalidated" || [401, 403].includes(cached.state.error.status)))
      && !(request.selectionId && (captured?.key === key && captured.restart === current.restart && captured.expiresAt <= now
        || cached.state.data && Date.parse(cached.state.data.selection.expiresAt) <= now)),
    placeholderData: (previous, previousQuery) => previousQuery?.queryKey[2] === key
      && previousQuery.queryKey[4] === restartKey && previousQuery.queryKey[6] === current.cursor
      && previousQuery.queryKey[7] === enabled ? previous : undefined,
    staleTime: retain ? cached => retiredCaptures.has(cached.queryKey) ? 0 : Math.max(0, Math.min(cohortCacheMs,
      Date.parse(cached.state.data?.selection.expiresAt ?? "") - cached.state.dataUpdatedAt) || 0) : Infinity,
    gcTime: retain ? cohortCacheMs : 0,
    meta: { retainReportPage: retain },
  }, client);
  const refetch = read.refetch;
  const awaitingCapture = captured?.key !== key || captured.restart !== current.restart;
  const cachedKey = client.getQueryCache().find({ queryKey, exact: true })?.queryKey;
  const cachedState = cachedKey ? client.getQueryState(cachedKey) : undefined;
  // Placeholder success does not prove the current revision's read completed.
  const pendingRead = read.isPending || cachedState?.status === "pending";
  const incompleteRead = enabled && !read.isFetching && !read.isError
    && (pendingRead || Boolean(cachedState?.isInvalidated));
  const retirement = cachedKey ? retiredCaptures.get(cachedKey) : undefined;
  const rejectedCapture = !awaitingCapture && retirement?.rejectedSelectionId === captured?.id;
  const externallyInvalidated = locallyInvalidated || rejectedCapture;
  if (rejectedCapture && !locallyInvalidated) setRejected({ key, restart: current.restart });
  const expiresAt = read.data ? Date.parse(read.data.selection.expiresAt) : !awaitingCapture ? captured?.expiresAt : undefined;
  useEffect(() => {
    if (!enabled || externallyInvalidated) return;
    const revalidate = () => {
      setNow(Date.now());
      const cached = cachedKey ? client.getQueryState(cachedKey) : undefined;
      const failure = cached?.error;
      const needsRecovery = cached?.fetchStatus === "idle" && !failure
        && (cached.status === "pending" || cached.isInvalidated);
      if (revalidateOnFocus && !(expiresAt !== undefined && expiresAt <= Date.now())
        && !needsRecovery
        && !(failure instanceof ApiError && (failure.code === "selection_invalidated" || [401, 403].includes(failure.status)))) void refetch({ cancelRefetch: false });
    };
    window.addEventListener("focus", revalidate);
    return () => window.removeEventListener("focus", revalidate);
  }, [cachedKey, client, enabled, expiresAt, externallyInvalidated, refetch, revalidateOnFocus]);
  const retiredCapture = awaitingCapture && Boolean(retirement);
  if (read.data && !read.isFetching && !retiredCapture && (awaitingCapture || captured?.id !== read.data.selection.id.toLowerCase()
    || captured?.expiresAt !== Date.parse(read.data.selection.expiresAt))) {
    setCaptured({ key, restart: current.restart, id: read.data.selection.id.toLowerCase(), expiresAt: Date.parse(read.data.selection.expiresAt) });
  }
  useEffect(() => {
    if (!enabled || expiresAt === undefined || expiresAt <= now) return;
    const timer = window.setTimeout(() => setNow(Date.now()), Math.min(2_147_483_647, Math.max(0, expiresAt - Date.now())));
    return () => window.clearTimeout(timer);
  }, [enabled, expiresAt, now]);
  const expired = expiresAt !== undefined && expiresAt <= now;
  const expiredCapture = expired && (!awaitingCapture || Boolean(query.selectionId) || !read.isFetching);
  useEffect(() => {
    if (enabled && expiredCapture && cachedKey) void client.cancelQueries({ queryKey: cachedKey, exact: true });
  }, [cachedKey, client, enabled, expiredCapture]);
  const denied = read.error instanceof ApiError && [401, 403].includes(read.error.status);
  const error = externallyInvalidated ? new ApiError(409, "selection_invalidated", "The report selection changed or expired. Load a new selection.")
    : retiredCapture && read.isFetching ? null : expiredCapture || retiredCapture && !read.isFetching
    ? new ApiError(409, "selection_invalidated", "The report selection changed or expired. Load a new selection.") : read.error
      ?? (incompleteRead ? new Error(pendingRead ? "The saved-data read was cancelled. Retry saved data." : "Saved data needs reloading. Retry saved data.") : null);
  const invalidated = error instanceof ApiError && error.code === "selection_invalidated";
  const recovering = invalidated && !denied && !externallyInvalidated && !query.selectionId && automaticallyRestartedThrough < current.restart;
  if (recovering) {
    setAutomaticallyRestartedThrough(current.restart + 1);
    setNavigation({ key, restart: current.restart + 1 });
  }
  useEffect(() => {
    if (automaticallyRestartedThrough !== current.restart) return;
    invalidateReportPages(client, key, revision, { excludeRestartKey: restartKey });
  }, [automaticallyRestartedThrough, client, current.restart, key, restartKey, revision]);
  const revalidatingCache = retain && awaitingCapture && read.isFetching && read.isStale;
  const data = read.isError || !enabled || expired || externallyInvalidated || retiredCapture || revalidatingCache || incompleteRead || manualRetry?.key === retryKey ? undefined : read.data;
  function ownsSelection() { return enabled && actions.current?.owner === actionOwner; }
  function ownsPage() { return ownsSelection() && actions.current?.page === retryKey && !actions.current.moved && !actions.current.restarted; }
  function isCurrentData(allowRevalidation = false) {
    // Cache changes precede React's observer notifications and action handlers.
    const cached = client.getQueryCache().find({ queryKey, exact: true });
    return Boolean(ownsPage() && data && cached && cached.state.status === "success" && cached.state.data === data
      && (allowRevalidation || cached.state.fetchStatus === "idle")
      && (cached.state.fetchStatus !== "idle" || !cached.state.isInvalidated)
      && retiredCaptures.get(cached.queryKey)?.rejectedSelectionId !== data.selection.id.toLowerCase());
  }
  function move(cursor: string | null | undefined) {
    if (!data || !cursor || cursor === current.cursor || !isCurrentData() || !actions.current
      || !(Date.parse(data.selection.expiresAt) > Date.now())) return;
    actions.current.moved = true;
    setNavigation({ key, cursor, selectionId: data.selection.id.toLowerCase(), restart: current.restart, shared: current.shared });
  }
  return {
    data, loading: enabled && !externallyInvalidated && (!invalidated || recovering) && (read.isFetching || recovering),
    // A page transition does not replace the validated selection used by facets and exports.
    selectionId: enabled && !error && !retiredCapture && manualRetry?.key !== retryKey
      ? data?.selection.id.toLowerCase() ?? (!awaitingCapture ? captured?.id : undefined) : undefined,
    error: recovering ? null : error, invalidated: invalidated && !recovering,
    recoveryRevision: automaticallyRestartedThrough,
    isCurrentData,
    invalidateSelection: () => {
      if (!ownsSelection()) return;
      const rejectedId = data?.selection.id ?? selectionId;
      if (!rejectedId) return;
      invalidateReportPages(client, key, revision, { selectionId: rejectedId });
      setRejected({ key, restart: current.restart });
    },
    next: () => move(data?.page.nextCursor), previous: () => move(data?.page.previousCursor),
    restartable: !query.selectionId || Boolean(restartParent),
    restart: () => {
      if (!ownsSelection() || !actions.current || actions.current.restarted) return;
      const action = actions.current;
      action.restarted = true;
      if (query.selectionId) {
        try { restartParent?.(); }
        finally { queueMicrotask(() => { action.restarted = false; }); }
      } else {
        invalidateReportPages(client, key, revision);
        setNavigation({ key, restart: current.restart + 1 });
      }
    },
    retry: () => {
      const failure = cachedKey ? client.getQueryState(cachedKey)?.error : undefined;
      if (!ownsPage() || invalidated || read.error && read.error !== failure
        || failure instanceof ApiError && failure.code === "selection_invalidated") return;
      if (expiresAt !== undefined && expiresAt <= Date.now()) {
        setNow(Date.now());
        return;
      }
      if (current.cursor && failure instanceof ApiError && failure.code === "invalid_cursor") {
        if (actions.current) actions.current.moved = true;
        // Cursor recovery replaces the page request, not its immutable selection or deadline.
        setCaptured(previous => previous?.key === key && previous.restart === current.restart
          ? { ...previous, restart: current.restart + 1 } : previous);
        setNavigation({ ...current, cursor: undefined, restart: current.restart + 1, shared: false });
        return;
      }
      const token = {};
      setManualRetry({ key: retryKey, token });
      void refetch({ cancelRefetch: false }).finally(() => setManualRetry(previous => previous?.token === token ? undefined : previous));
    },
  };
}
