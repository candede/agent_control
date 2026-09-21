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
  return new QueryClient({
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
 */
export function readSavedQuery<T>(
  client: QueryClient,
  queryKey: QueryKey,
  read: (signal: AbortSignal) => Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) return Promise.reject(abortedRead());
  return new Promise<T>((resolve, reject) => {
    const observer = new QueryObserver<T, Error>(client, {
      queryKey: ["saved", ...queryKey],
      queryFn: context => read(context.signal),
      enabled: true,
      staleTime: 0,
      refetchOnMount: "always",
    });
    let unsubscribe = () => observer.destroy();
    let settled = false;
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
    const unsubscribeCache = client.getQueryCache().subscribe(event => {
      if (event.type === "removed" && event.query === observer.getCurrentQuery()) cancel();
    });
    signal.addEventListener("abort", cancel, { once: true });
    unsubscribe = observer.subscribe(() => {});
    if (settled) {
      unsubscribe();
      return;
    }
    // Cancellation can revert observer state to old data or idle/pending.
    // Only the admitted fetch promise proves that this read completed.
    const pending = observer.getCurrentQuery().promise;
    if (!pending) {
      finish(() => reject(new Error("The saved-data request did not start.")));
      return;
    }
    void pending.then(
      data => {
        const result = observer.getCurrentResult();
        finish(() => result.isError ? reject(result.error) : resolve(data));
      },
      cause => finish(() => reject(isCancelledError(cause) ? abortedRead() : cause)),
    );
  });
}

export function useSavedRead() {
  const client = useSavedQueryClient();
  return useCallback(<T,>(key: QueryKey, read: (signal: AbortSignal) => Promise<T>, signal: AbortSignal) =>
    readSavedQuery(client, key, read, signal), [client]);
}

function abortedRead() {
  return new ApiError(0, "request_aborted", "The request was cancelled.", { kind: "aborted" });
}
