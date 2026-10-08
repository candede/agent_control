import { useEffect, useState } from "react";
import { ApiError, getBulkActionJobItems, type BulkActionJob, type BulkJobItemPage } from "../api/client";
import { useSavedRead } from "../savedQueries";

export function BulkJobItems({ job, owner, refreshing = false, disabled = false, statusRecoveryAvailable = false, onRefreshStatus }: {
  job: BulkActionJob; owner?: string; refreshing?: boolean; disabled?: boolean;
  statusRecoveryAvailable?: boolean; onRefreshStatus?: () => void;
}) {
  const read = useSavedRead();
  const key = `${owner ?? ""}:${job.id}:${job.resultRevision}`;
  const [attempt, setAttempt] = useState(0);
  const [navigation, setNavigation] = useState<{ key: string; cursor?: string; restarted: boolean }>({ key, restarted: false });
  const [result, setResult] = useState<{ key: string; cursor?: string; page?: BulkJobItemPage; error?: string; invalidated?: boolean }>({ key });
  if (navigation.key !== key) {
    setNavigation({ key, restarted: navigation.key.split(":").slice(0, -1).join(":") === key.split(":").slice(0, -1).join(":") });
    setResult({ key });
  }
  const cursor = navigation.key === key ? navigation.cursor : undefined;
  if (refreshing && (result.page || result.error)) setResult({ key, cursor });
  useEffect(() => {
    if (refreshing) return;
    const controller = new AbortController();
    read(["bulk-job-items", owner ?? "", job.id, job.resultRevision, cursor],
      signal => getBulkActionJobItems(job.id, { revision: job.resultRevision, cursor }, { signal }),
      controller.signal, { staleTime: Infinity, gcTime: 60_000 })
      .then(page => { if (!controller.signal.aborted) setResult({ key, cursor, page }); })
      .catch(error => {
        const invalidated = error instanceof ApiError && error.code === "selection_invalidated";
        if (!controller.signal.aborted) setResult({ key, cursor, invalidated, error: invalidated
          ? "Job results changed. Refresh status to restart the result pages." : error instanceof Error ? error.message : "Unable to read job results." });
      });
    return () => controller.abort();
  }, [job.id, job.resultRevision, key, cursor, owner, attempt, refreshing, read]);
  const visible = !refreshing && result.key === key && result.cursor === cursor ? result : undefined;
  return <div role="group" aria-label="Package job results">
    <h3>Results ({job.total.toLocaleString()} targets)</h3>
    {navigation.restarted && visible?.page ? <p aria-live="polite">Job results changed; showing the first result page.</p> : null}
    {visible?.error ? <>
      <p role="alert">{visible.error}</p>
      {statusRecoveryAvailable ? <p>Use Refresh status to retry these results.</p>
        : visible.invalidated ? onRefreshStatus && <button type="button" disabled={disabled} onClick={onRefreshStatus}>Refresh status</button>
        : <button type="button" disabled={disabled} onClick={() => {
          setResult({ key, cursor });
          setAttempt(current => current + 1);
        }}>Retry results</button>}
    </> : !visible?.page ? <p aria-live="polite">{refreshing ? "Checking job status before loading results…" : "Loading job results…"}</p> : <>
      <ul>{visible.page.value.map(item => <li key={item.id}>
        <strong>{item.displayName}</strong> — {item.status}
        {item.message ? <p>{item.message}</p> : null}
        {item.reconciliationStatus && item.reconciliationStatus !== "not_required"
          ? <p>Reconciliation: {item.reconciliationStatus.replaceAll("_", " ")}{item.retryEligible ? ". Eligible only for a new explicit preview and confirmation." : ""}</p> : null}
      </li>)}</ul>
      {visible.page.value.length === 0 ? <p>No results.</p> : null}
      <nav aria-label="Job result pages">
        <button type="button" disabled={disabled || !visible.page.page.previousCursor}
          onClick={() => setNavigation({ key, cursor: visible.page!.page.previousCursor!, restarted: false })}>Previous results</button>
        <button type="button" disabled={disabled || !visible.page.page.nextCursor}
          onClick={() => setNavigation({ key, cursor: visible.page!.page.nextCursor!, restarted: false })}>Next results</button>
      </nav>
    </>}
  </div>;
}
