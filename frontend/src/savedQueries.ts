import { useCallback, useContext, useEffect, useState } from "react";
import {
  QueryClient,
  QueryClientContext,
  QueryObserver,
  isCancelledError,
  useQuery,
  type QueryKey,
  type UseQueryOptions,
} from "@tanstack/react-query";
import { ApiError } from "./api/client";

export function createSavedQueryClient() {
  const client = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        staleTime: 0,
        gcTime: 0,
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
        networkMode: "always",
      },
    },
  });
  client.getQueryCache().subscribe(event => {
    if (event.type !== "observerRemoved" || !event.query.meta?.retainReportPage) return;
    if (event.query.getObserversCount() === 0 && event.query.state.error instanceof ApiError
      && event.query.state.error.code === "selection_invalidated") {
      // A rejected capture cannot be reused; let the next visit retain a fresh one.
      client.removeQueries({ queryKey: event.query.queryKey, exact: true });
      return;
    }
    // QueryObserver switches its current query before detaching from the old one.
    const currentQuery = event.observer.getCurrentQuery();
    const incomingQuery = currentQuery !== event.query ? currentQuery : undefined;
    const idle = client.getQueryCache().getAll()
      .filter(query => query !== incomingQuery && query.meta?.retainReportPage && query.getObserversCount() === 0
        && query.state.status !== "pending" && query.state.fetchStatus === "idle")
      .sort((left, right) => right.state.dataUpdatedAt - left.state.dataUpdatedAt);
    for (const query of idle.slice(4)) client.removeQueries({ queryKey: query.queryKey, exact: true });
  });
  return client;
}

export function useSavedQueryClient() {
  const shared = useContext<QueryClient | undefined>(QueryClientContext);
  // Standalone panels own an isolated client; the signed-in workbench shares one.
  const [owned] = useState(() => shared ? undefined : createSavedQueryClient());
  useEffect(() => () => owned?.clear(), [owned]);
  const client = shared ?? owned;
  if (!client) throw new Error("Saved reads require a query client.");
  return client;
}

export function useSavedQuery<T>(options: UseQueryOptions<T, Error, T, QueryKey>) {
  return useQuery(options, useSavedQueryClient());
}

/**
 * An observer lets existing fenced workflows share saved reads without letting
 * one caller's cancellation abort another caller's request.
 * Retention is opt-in for keys that include the server's immutable revision.
 */
export function readSavedQuery<T>(
  client: QueryClient,
  queryKey: QueryKey,
  read: (signal: AbortSignal) => Promise<T>,
  signal: AbortSignal,
  retention?: { staleTime: number; gcTime: number },
): Promise<T> {
  if (signal.aborted) return Promise.reject(abortedRead());
  return new Promise<T>((resolve, reject) => {
    const cache = client.getQueryCache();
    let settled = false;
    const observer = new QueryObserver<T, Error>(client, {
      queryKey: ["saved", ...queryKey],
      queryFn: context => {
        const query = observer.getCurrentQuery();
        // Fetch notifications run before TanStack wires up request cancellation.
        if (settled && (query.getObserversCount() === 0 || cache.get(query.queryHash) !== query)) {
          return Promise.reject(abortedRead());
        }
        return read(context.signal);
      },
      enabled: () => !settled,
      staleTime: 0,
      ...retention,
      refetchOnMount: retention ? true : "always",
    });
    let unsubscribe = () => observer.destroy();
    const finish = (complete: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", cancel);
      unsubscribeCache();
      unsubscribe();
      observer.destroy();
      complete();
    };
    const cancel = () => finish(() => reject(abortedRead()));
    const unsubscribeCache = cache.subscribe(event => {
      if (event.type === "removed" && event.query === observer.getCurrentQuery()) cancel();
    });
    signal.addEventListener("abort", cancel, { once: true });
    // Query construction notifies cache subscribers before our listeners exist.
    const query = observer.getCurrentQuery();
    if (signal.aborted || cache.get(query.queryHash) !== query) {
      cancel();
      return;
    }
    unsubscribe = observer.subscribe(() => {});
    if (settled) {
      unsubscribe();
      return;
    }
    const cached = observer.getCurrentResult();
    if (retention && cached.isSuccess && !cached.isFetching && !cached.isStale) {
      finish(() => resolve(cached.data));
      return;
    }
    // Cancellation can revert observer state to old data or idle/pending.
    // Without a fresh retained result, only the admitted fetch proves completion.
    const pending = observer.getCurrentQuery().promise;
    if (!pending) {
      finish(() => reject(new Error("The saved-data request did not start.")));
      return;
    }
    observeFetch(pending);

    function observeFetch(admitted: Promise<T>) {
      const settle = (complete: () => void) => {
        if (settled) return;
        const replacement = observer.getCurrentQuery().promise;
        // Invalidation can replace a fetch before its completion reaches this caller.
        if (replacement && replacement !== admitted) observeFetch(replacement);
        else finish(complete);
      };
      void admitted.then(
        data => settle(() => {
          const result = observer.getCurrentResult();
          if (result.isError) reject(result.error);
          else resolve(data);
        }),
        cause => settle(() => reject(isCancelledError(cause) ? abortedRead() : cause)),
      );
    }
  });
}

export function useSavedRead() {
  const client = useSavedQueryClient();
  return useCallback(<T,>(key: QueryKey, read: (signal: AbortSignal) => Promise<T>, signal: AbortSignal,
    retention?: { staleTime: number; gcTime: number }) =>
    readSavedQuery(client, key, read, signal, retention), [client]);
}

function abortedRead() {
  return new ApiError(0, "request_aborted", "The request was cancelled.", { kind: "aborted" });
}
