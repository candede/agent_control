import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ApiError, getPackageRefreshTargets, type PackageRefreshJob } from "../api/client";
import { useSavedQueryClient } from "../savedQueries";

type Props = { job: PackageRefreshJob; owner?: string };

export function InventoryRefreshTargets(props: Props) {
  return <RefreshTargetPage key={JSON.stringify([props.owner, props.job.tokenMode, props.job.id, props.job.resultRevision])} {...props} />;
}

function RefreshTargetPage({ job, owner }: Props) {
  const queries = useSavedQueryClient();
  const [cursor, setCursor] = useState<string>();
  const [invalidated, setInvalidated] = useState(false);
  const revisionKey = ["saved", "inventory-refresh-targets", owner ?? "", job.tokenMode, job.id, job.resultRevision];
  const read = useQuery({
    queryKey: [...revisionKey, cursor],
    queryFn: ({ signal }) => getPackageRefreshTargets({ id: job.id, tokenMode: job.tokenMode, resultRevision: job.resultRevision }, { cursor, signal }),
    enabled: !invalidated, staleTime: Infinity, gcTime: 60_000,
  }, queries);
  const retired = invalidated || read.error instanceof ApiError && read.error.code === "selection_invalidated";
  if (retired && !invalidated) setInvalidated(true);
  const page = !retired && !read.isFetching && !read.isError ? read.data : undefined;
  return <section aria-label="Refresh target results" aria-busy={!retired && read.isFetching}>
    <h3>Refresh targets ({job.targetCount.toLocaleString()})</h3>
    {retired ? <p role="alert">Refresh progress changed. Refresh status to restart target pages.</p> : <>
      {read.isFetching ? <p role="status">Loading refresh targets…</p> : read.isError ? <p role="alert">
        {read.error.message || "Unable to read refresh targets."}{" "}
        <button type="button" onClick={() => { void read.refetch({ cancelRefetch: false }); }}>Retry targets</button>
      </p> : null}
      {page ? <>
        <ul>{page.value.map(target => <li key={target.id}><code>{target.id}</code> — {target.status.replaceAll("_", " ")}</li>)}</ul>
        {page.value.length === 0 ? <p>No refresh targets on this page.</p> : null}
      </> : null}
      <nav aria-label="Refresh target pages">
        {cursor ? <button type="button" disabled={read.isFetching} onClick={() => {
          if (read.error instanceof ApiError && read.error.code === "invalid_cursor") {
            void queries.invalidateQueries({ queryKey: revisionKey, refetchType: "none" });
          }
          setCursor(undefined);
        }}>First targets</button> : null}
        <button type="button" disabled={!page?.page.previousCursor}
          onClick={() => setCursor(page?.page.previousCursor ?? undefined)}>Previous targets</button>
        <button type="button" disabled={!page?.page.nextCursor}
          onClick={() => setCursor(page?.page.nextCursor ?? undefined)}>Next targets</button>
      </nav>
    </>}
  </section>;
}
