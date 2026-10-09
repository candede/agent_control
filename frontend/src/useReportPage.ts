import { useContext, useEffect, useEffectEvent, useId, useLayoutEffect, useRef, useState } from "react";
import { hashKey, useQuery, type QueryClient, type QueryKey } from "@tanstack/react-query";
import { CapabilityContext } from "./capabilityContext";
import { ApiError } from "./api/client";
import { readReportPage, type ReportPageRequest } from "./api/reportData";
import { useSavedQueryClient } from "./savedQueries";
import type { ReportListPage, ReportPage } from "../../backend/src/types/officialReportData";
import { acceptSelectedRead, canReuseSelectedRead, isExpiredSelection, selectedReadRemaining, useSelectedReadLease, withdrawsSelectedRead } from "./selectedRead";
import { PublicationContext } from "./publicationContext";

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

async function readCurrentReportPage<T, Page extends ReportListPage<T>>(path: string, request: ReportPageRequest, signal: AbortSignal, cachedKey: QueryKey) {
  const startedAt = performance.now();
  const retirement = retiredCaptures.get(cachedKey);
  const result = await readReportPage<T, Page>(path, request, signal);
  signal.throwIfAborted();
  acceptSelectedRead(result, startedAt);
  if (retiredCaptures.get(cachedKey)?.rejectedSelectionId === result.selection.id.toLowerCase()) {
    throw new ApiError(409, "selection_invalidated", "The returned report selection was invalidated.");
  }
  if (request.selectionId && result.selection.id.toLowerCase() !== request.selectionId.toLowerCase()
    || request.setId && result.reports.setId?.toLowerCase() !== request.setId.toLowerCase()) {
    throw new ApiError(409, "selection_invalidated", "The returned evidence does not match the requested selection.");
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
  const liveKey = hashKey([scope, path, query]);
  const key = hashKey([scope, path, query, query.selectionId ? undefined : revision]);
  const [highestRevision, setHighestRevision] = useState(revision);
  const [navigation, setNavigation] = useState<{ key: string; cursor?: string; selectionId?: string; restart: number; shared?: boolean; publication?: string; renewal?: string }>({ key, restart: 0, shared: !freshCaptureOnMount });
  const [captured, setCaptured] = useState<{ key: string; restart: number; id: string; data: Page; live: boolean }>();
  const [rejected, setRejected] = useState<{ key: string; restart: number }>();
  const [manualRetry, setManualRetry] = useState<{ key: string; token: object }>();
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
  const sharedKey = ["saved", "record-page", key, revision, 0, current.selectionId ?? query.selectionId, current.cursor, enabled];
  let sharedQuery = client.getQueryCache().find({ queryKey: sharedKey, exact: true });
  if (sharedQuery && retiredCaptures.has(sharedQuery.queryKey) && sharedQuery.getObserversCount() === 0) {
    client.removeQueries({ queryKey: sharedKey, exact: true });
    sharedQuery = undefined;
  }
  const retiredShared = !query.selectionId && sharedQuery && retiredCaptures.has(sharedQuery.queryKey)
    && !(captured?.key === key && captured.restart === current.restart);
  if (retiredShared && current.shared) setNavigation({ ...current, shared: false });
  const restartKey = current.renewal ? `renewal:${current.renewal}`
    : current.publication ? `publication:${current.publication}` : current.shared && !retiredShared ? 0 : `${owner}:${current.restart}`;
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
      return readCurrentReportPage<T, Page>(path, request, signal, cachedKey).catch(error => {
        if (!signal.aborted && request.selectionId && error instanceof ApiError && error.code === "selection_invalidated" && !isExpiredSelection(error)) {
          // Actual dependency rejection retires peer evidence; lease age does not.
          invalidateReportPages(client, key, revision, { selectionId: request.selectionId, excludeQueryKey: cachedKey });
        }
        throw error;
      });
    },
    enabled: cached => enabled && !locallyInvalidated
      && (!request.selectionId || !captured || captured.key !== key || captured.restart !== current.restart
        || selectedReadRemaining(captured.data.selection) > 0)
      && !(cached.state.error instanceof ApiError && (cached.state.error.code === "selection_invalidated" || [401, 403].includes(cached.state.error.status))),
    placeholderData: (previous, previousQuery) => previousQuery?.meta?.liveReportKey === liveKey
      && (previousQuery.queryKey[3] !== revision && current.shared || current.renewal !== undefined || current.publication !== undefined
        || previousQuery.queryKey[4] === restartKey && previousQuery.queryKey[6] === current.cursor)
      && previousQuery.queryKey[7] === enabled ? previous : undefined,
    staleTime: Infinity,
    refetchOnMount: cached => retain && (retiredCaptures.has(cached.queryKey)
      || !cached.state.data || !canReuseSelectedRead(cached.state.data.selection)) ? "always" : false,
    structuralSharing: false,
    gcTime: retain ? cohortCacheMs : 0,
    meta: { retainReportPage: retain, liveReportKey: liveKey },
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
  const selected = read.data?.selection ?? (!awaitingCapture ? captured?.data.selection : undefined);
  const leaseActive = useSelectedReadLease(selected);
  useEffect(() => {
    if (!enabled || externallyInvalidated) return;
    const revalidate = () => {
      if (document.visibilityState !== "visible" || !navigator.onLine) return;
      const cached = cachedKey ? client.getQueryState(cachedKey) : undefined;
      const failure = cached?.error;
      const needsRecovery = cached?.fetchStatus === "idle" && !failure
        && (cached.status === "pending" || cached.isInvalidated);
      if (revalidateOnFocus && (!selected || selectedReadRemaining(selected) > 0)
        && !needsRecovery
        && !(failure instanceof ApiError && (failure.code === "selection_invalidated" || [401, 403].includes(failure.status)))) void refetch({ cancelRefetch: false });
    };
    window.addEventListener("focus", revalidate);
    return () => window.removeEventListener("focus", revalidate);
  }, [cachedKey, client, enabled, selected, externallyInvalidated, refetch, revalidateOnFocus]);
  const retiredCapture = awaitingCapture && Boolean(retirement);
  if (read.data && !read.isError && !read.isFetching && !retiredCapture && (awaitingCapture || captured?.data !== read.data)) {
    setCaptured({ key, restart: current.restart, id: read.data.selection.id.toLowerCase(), data: read.data,
      live: leaseActive || captured?.key === key && captured.restart === current.restart
        && captured.id === read.data.selection.id.toLowerCase() && captured.live });
  }
  const expired = Boolean(selected && !leaseActive) || isExpiredSelection(read.error);
  const error = externallyInvalidated ? new ApiError(409, "selection_invalidated", "The report selection changed or expired. Load a new selection.")
    : retiredCapture && read.isFetching ? null : retiredCapture && !read.isFetching
    ? new ApiError(409, "selection_invalidated", "The report selection changed or expired. Load a new selection.") : read.error
      ?? (incompleteRead && !expired ? new Error(pendingRead ? "The saved-data read was cancelled. Retry saved data." : "Saved data needs reloading. Retry saved data.") : null);
  const invalidated = error instanceof ApiError && error.code === "selection_invalidated" && !isExpiredSelection(error);
  const revalidatingCache = retain && awaitingCapture && read.isFetching && !read.isPlaceholderData;
  const historical = isExpiredSelection(error) && !awaitingCapture ? captured?.data : undefined;
  const data = read.isError && !isExpiredSelection(read.error) || withdrawsSelectedRead(read.error) || !enabled || externallyInvalidated || retiredCapture || revalidatingCache || incompleteRead && !expired || manualRetry?.key === retryKey ? undefined : historical ?? read.data;
  const selectedData = enabled && !externallyInvalidated && !retiredCapture && (!error || isExpiredSelection(error))
    && manualRetry?.key !== retryKey ? data ?? (!awaitingCapture ? captured?.data : undefined) : undefined;
  const publication = useContext(PublicationContext);
  const admitPublication = publication?.admit;
  const observedPublication = useRef<{ key: string; revision: string } | undefined>(undefined);
  const publicationRevision = path === "copilot-usage/adoption" && publication?.revisions
    ? JSON.stringify([publication.revisions.users, publication.revisions.graph_packages, publication.revisions.power_platform])
    : publication?.revisions?.users;
  const capturedPublicationRevision = path === "copilot-usage/adoption" && data
    ? JSON.stringify([data.selection.publicationRevisions.users, data.selection.publicationRevisions.graph_packages,
      data.selection.publicationRevisions.power_platform]) : data?.selection.publicationRevisions.users;
  const renewalDue = Boolean(enabled && !query.selectionId && data && expired && !externallyInvalidated && !invalidated
    && (!error || isExpiredSelection(error)) && !incompleteRead && !read.isPlaceholderData
    && !query.inventorySelectionId
    && captured?.key === key && captured.live && captured.id === data.selection.id.toLowerCase()
    && current.renewal !== data.selection.id.toLowerCase());
  const available = document.visibilityState === "visible" && navigator.onLine;
  const renewing = enabled && !invalidated && !externallyInvalidated && (!error || isExpiredSelection(error))
    && (renewalDue || Boolean(query.selectionId && restartParent && expired)
      || Boolean(current.renewal && read.isFetching && read.isPlaceholderData));
  useEffect(() => {
    if (!renewalDue || !available || read.isFetching || !data || !actions.current || actions.current.restarted) return;
    actions.current.restarted = true;
    if (publicationRevision) observedPublication.current = { key, revision: publicationRevision };
    // Independent operation inputs remain valid while the view captures fresh data.
    invalidateReportPages(client, key, revision, { excludeRestartKey: `renewal:${data.selection.id.toLowerCase()}` });
    setNavigation({ key, restart: current.restart + 1, renewal: data.selection.id.toLowerCase() });
  }, [available, client, current.restart, data, key, publicationRevision, read.isFetching, renewalDue, revision]);
  const expiredChild = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!enabled || !available || !expired || !query.selectionId || !restartParent
      || invalidated || read.error && !isExpiredSelection(read.error) || expiredChild.current === query.selectionId) return;
    expiredChild.current = query.selectionId;
    restartParent();
  }, [available, enabled, read.error, expired, invalidated, query.selectionId, restartParent]);
  useEffect(() => {
    if (data) admitPublication?.(data.selection.publicationRevisions);
  }, [admitPublication, data]);
  const capturePublication = useEffectEvent((publicationRevision: string) => {
    observedPublication.current = { key, revision: publicationRevision };
    invalidateReportPages(client, key, revision);
    setNavigation({ key, restart: current.restart + 1, publication: publicationRevision });
  });
  useEffect(() => {
    if (!data || !publicationRevision || read.isFetching || read.isError) return;
    const previous = observedPublication.current?.key === key ? observedPublication.current.revision : undefined;
    if (previous === publicationRevision) return;
    if (!previous && capturedPublicationRevision === publicationRevision) {
      observedPublication.current = { key, revision: publicationRevision };
      return;
    }
    if (query.selectionId || query.inventorySelectionId) {
      // Children follow their parent's replacement rather than changing identity here.
      if (!selectedReadRemaining(data.selection)) return;
      observedPublication.current = { key, revision: publicationRevision };
      void refetch({ cancelRefetch: false });
    } else {
      let active = true;
      queueMicrotask(() => { if (active) capturePublication(publicationRevision); });
      return () => { active = false; };
    }
  }, [actionOwner, capturedPublicationRevision, client, current.cursor, current.restart, data, key, publicationRevision,
    query.inventorySelectionId, query.selectionId, query.setId, read.isError, read.isFetching, refetch, revision]);
  function ownsSelection() { return enabled && actions.current?.owner === actionOwner; }
  function ownsPage() { return ownsSelection() && actions.current?.page === retryKey && !actions.current.moved && !actions.current.restarted; }
  function isCurrentData(allowRevalidation = false, matchesEvidence?: (current: Page) => boolean) {
    // Cache changes precede React's observer notifications and action handlers.
    const cached = client.getQueryCache().find({ queryKey, exact: true });
    const currentData = cached?.state.data as Page | undefined;
    return Boolean(ownsPage() && data && selectedReadRemaining(data.selection) > 0 && cached && cached.state.status === "success"
      && currentData && selectedReadRemaining(currentData.selection) > 0 && (currentData === data || matchesEvidence?.(currentData))
      && (allowRevalidation || cached.state.fetchStatus === "idle")
      && (cached.state.fetchStatus !== "idle" || !cached.state.isInvalidated)
      && retiredCaptures.get(cached.queryKey)?.rejectedSelectionId !== data.selection.id.toLowerCase());
  }
  function move(cursor: string | null | undefined) {
    if (!data || !cursor || cursor === current.cursor || !isCurrentData() || !actions.current
      || !selectedReadRemaining(data.selection)) return;
    actions.current.moved = true;
    setNavigation({ ...current, key, cursor, selectionId: data.selection.id.toLowerCase() });
  }
  return {
    data, selectedData, renewing, loading: enabled && !externallyInvalidated && !invalidated && (read.isFetching || renewalDue && available),
    // A page transition does not replace the validated selection used by facets and exports.
    selectionId: enabled && !error && !expired && !retiredCapture && manualRetry?.key !== retryKey
      ? data?.selection.id.toLowerCase() ?? (!awaitingCapture ? captured?.id : undefined) : undefined,
    error, invalidated, leaseEnded: expired, selectionRevision: current.restart,
    publicationRevisions: data?.selection.publicationRevisions,
    isCurrentData,
    invalidateSelection: (error?: Error) => {
      if (!ownsSelection()) return;
      const rejectedId = data?.selection.id ?? selectionId;
      if (!rejectedId) return;
      if (isExpiredSelection(error)) {
        const cached = client.getQueryCache().find({ queryKey, exact: true });
        cached?.setState({ error, status: "error" });
        return;
      }
      invalidateReportPages(client, key, revision, { selectionId: rejectedId });
      if (read.isPlaceholderData && read.isFetching) return;
      setRejected({ key, restart: current.restart });
    },
    next: () => move(data?.page.nextCursor), previous: () => move(data?.page.previousCursor),
    restartable: !query.selectionId || Boolean(restartParent),
    restart: () => {
      if (renewing) return;
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
      if (expired || selected && !selectedReadRemaining(selected)) return;
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
