import { useEffect, useState } from "react";
import { ApiError, getPackageRefreshTargets, type PackageRefreshJob, type PackageRefreshTargetPage } from "../api/client";

export function InventoryRefreshTargets({ job, owner }: { job: PackageRefreshJob; owner?: string }) {
  const key = JSON.stringify([owner, job.id, job.resultRevision]);
  const [navigation, setNavigation] = useState<{ key: string; cursor?: string }>({ key });
  const [result, setResult] = useState<{ key: string; cursor?: string; page?: PackageRefreshTargetPage; error?: string }>({ key });
  const cursor = navigation.key === key ? navigation.cursor : undefined;
  useEffect(() => {
    const controller = new AbortController();
    getPackageRefreshTargets({ id: job.id, tokenMode: job.tokenMode, resultRevision: job.resultRevision }, { cursor, signal: controller.signal })
      .then(page => { if (!controller.signal.aborted) setResult({ key, cursor, page }); })
      .catch(error => {
        if (!controller.signal.aborted) setResult({ key, cursor, error: error instanceof ApiError && error.code === "selection_invalidated"
          ? "Refresh progress changed. Refresh status to restart target pages." : error instanceof Error ? error.message : "Unable to read refresh targets." });
      });
    return () => controller.abort();
  }, [job.id, job.tokenMode, job.resultRevision, key, cursor]);
  const visible = result.key === key && result.cursor === cursor ? result : undefined;
  return <section aria-label="Refresh target results">
    <h3>Refresh targets ({job.targetCount.toLocaleString()})</h3>
    {visible?.error ? <p role="alert">{visible.error}</p> : !visible?.page ? <p aria-live="polite">Loading refresh targets…</p> : <>
      <ul>{visible.page.value.map(target => <li key={target.id}><code>{target.id}</code> — {target.status.replaceAll("_", " ")}</li>)}</ul>
      <nav aria-label="Refresh target pages">
        <button type="button" disabled={!visible.page.page.previousCursor}
          onClick={() => setNavigation({ key, cursor: visible.page!.page.previousCursor! })}>Previous targets</button>
        <button type="button" disabled={!visible.page.page.nextCursor}
          onClick={() => setNavigation({ key, cursor: visible.page!.page.nextCursor! })}>Next targets</button>
      </nav>
    </>}
  </section>;
}
