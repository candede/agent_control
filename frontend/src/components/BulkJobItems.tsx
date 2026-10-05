import { useEffect, useState } from "react";
import { ApiError, getBulkActionJobItems, type BulkActionJob, type BulkJobItemPage } from "../api/client";

export function BulkJobItems({ job, owner }: { job: BulkActionJob; owner?: string }) {
  const key = `${owner ?? ""}:${job.id}:${job.resultRevision}`;
  const [navigation, setNavigation] = useState<{ key: string; cursor?: string; restarted: boolean }>({ key, restarted: false });
  const [result, setResult] = useState<{ key: string; cursor?: string; page?: BulkJobItemPage; error?: string }>({ key });
  if (navigation.key !== key) setNavigation({ key, restarted: navigation.key.split(":").slice(0, -1).join(":") === key.split(":").slice(0, -1).join(":") });
  const cursor = navigation.key === key ? navigation.cursor : undefined;
  useEffect(() => {
    const controller = new AbortController();
    getBulkActionJobItems(job.id, { revision: job.resultRevision, cursor }, { signal: controller.signal })
      .then(page => { if (!controller.signal.aborted) setResult({ key, cursor, page }); })
      .catch(error => {
        if (!controller.signal.aborted) setResult({ key, cursor, error: error instanceof ApiError && error.code === "selection_invalidated"
          ? "Job results changed. Refresh status to restart the result pages." : error instanceof Error ? error.message : "Unable to read job results." });
      });
    return () => controller.abort();
  }, [job.id, job.resultRevision, key, cursor]);
  const visible = result.key === key && result.cursor === cursor ? result : undefined;
  return <div role="group" aria-label="Package job results">
    <h3>Results ({job.total.toLocaleString()} targets)</h3>
    {navigation.restarted ? <p aria-live="polite">Job results changed; showing the first result page.</p> : null}
    {visible?.error ? <p role="alert">{visible.error}</p> : !visible?.page ? <p aria-live="polite">Loading job results…</p> : <>
      <ul>{visible.page.value.map(item => <li key={item.id}>
        <strong>{item.displayName}</strong> — {item.status}
        {item.message ? <p>{item.message}</p> : null}
        {item.reconciliationStatus && item.reconciliationStatus !== "not_required"
          ? <p>Reconciliation: {item.reconciliationStatus.replaceAll("_", " ")}{item.retryEligible ? ". Eligible only for a new explicit preview and confirmation." : ""}</p> : null}
      </li>)}</ul>
      {visible.page.value.length === 0 ? <p>No results.</p> : null}
      <nav aria-label="Job result pages">
        <button type="button" disabled={!visible.page.page.previousCursor}
          onClick={() => setNavigation({ key, cursor: visible.page!.page.previousCursor!, restarted: false })}>Previous results</button>
        <button type="button" disabled={!visible.page.page.nextCursor}
          onClick={() => setNavigation({ key, cursor: visible.page!.page.nextCursor!, restarted: false })}>Next results</button>
      </nav>
    </>}
  </div>;
}
