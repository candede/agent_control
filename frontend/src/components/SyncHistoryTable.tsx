import { useMemo, useState } from "react";
import { RefreshCw } from "lucide-react";
import type { SortingState } from "@tanstack/react-table";
import type { WorkbenchJobSummary, WorkbenchJobsResponse } from "../api/client";
import { useListTable, type ListColumn } from "../listTable";
import { ListTableHead } from "./ListTableHead";
import { formatJobInstant, jobDuration, jobStatusLabel } from "./jobPresentation";
import { syncSourceDetails, syncStatusLabel } from "./syncPresentation";
import "./dataSync.css";

const pageSize = 10;
const sourceJobs = new Set(["package-refresh", "power-platform"]);
const defaultSorting: SortingState = [{ id: "started", desc: true }];

export function SyncHistoryTable({ state, error, loading = false, pollingPaused = false, onRefresh, onOpenSyncRun }: {
  state?: WorkbenchJobsResponse;
  error: string;
  loading?: boolean;
  pollingPaused?: boolean;
  onRefresh: () => void;
  onOpenSyncRun?: (runId: string) => void;
}) {
  const [view, setView] = useState<"runs" | "sources">("runs");
  const [outcome, setOutcome] = useState("all");
  const [page, setPage] = useState(0);
  const [sorting, setSorting] = useState<SortingState>(defaultSorting);
  const inView = (source: string) => view === "runs" ? source === "data-sync" : sourceJobs.has(source);
  const jobs = state?.value.filter(job => inView(job.source) && matchesOutcome(job, outcome))
    .sort((left, right) => left.id.localeCompare(right.id))
    ?? [];
  const columns = useMemo<ListColumn<WorkbenchJobSummary>[]>(() => [
    {
      id: "started", header: "Started",
      accessorFn: job => timestamp(startDate(job)),
      sortDescFirst: true,
    },
    {
      id: "scope", header: view === "runs" ? "Scope" : "Source job",
      accessorFn: job => job.source === "data-sync" && job.syncSources?.length
        ? job.syncSources.map(source => syncSourceDetails[source].label).join(", ")
        : job.label,
    },
    { id: "outcome", header: "Outcome", accessorFn: statusLabel },
    { id: "result", header: "Result", accessorFn: resultCount },
    {
      id: "duration", header: "Duration",
      accessorFn: job => durationMilliseconds(job),
      sortDescFirst: true,
    },
    { id: "details", header: "Details", enableSorting: false },
  ], [view]);
  const table = useListTable({
    data: jobs,
    columns,
    sorting,
    getRowId: job => `${job.source}:${job.id}`,
    onSortingChange: update => {
      setSorting(previous => typeof update === "function" ? update(previous) : update);
      setPage(0);
    },
  });
  const sortedRows = table.getRowModel().rows;
  const unavailable = state?.unavailableSources.filter(source => inView(source.source)) ?? [];
  const lastPage = Math.max(0, Math.ceil(jobs.length / pageSize) - 1);
  const currentPage = Math.min(page, lastPage);
  const rows = sortedRows.slice(currentPage * pageSize, (currentPage + 1) * pageSize);

  return (
    <section className="jobs-view sync-history" aria-labelledby="jobs-heading" aria-busy={loading}>
      <div className="section-heading">
        <div>
          <h2 id="jobs-heading">Sync history</h2>
          <p className="jobs-note">Previous collection attempts, separate from your workspace's last successful data.</p>
        </div>
        <button type="button" className="secondary" onClick={onRefresh}>
          <RefreshCw size={15} aria-hidden="true" />Refresh history
        </button>
      </div>
      <div className="sync-history-controls">
        <div className="sync-history-tabs" role="group" aria-label="History type">
          <button type="button" aria-pressed={view === "runs"} onClick={() => { setView("runs"); setPage(0); }}>Sync runs</button>
          <button type="button" aria-pressed={view === "sources"} onClick={() => { setView("sources"); setPage(0); }}>Source jobs</button>
        </div>
        <label className="sync-history-filter">
          Outcome
          <select value={outcome} onChange={event => { setOutcome(event.target.value); setPage(0); }}>
            <option value="all">All outcomes</option>
            <option value="complete">Complete</option>
            <option value="active">In progress</option>
            <option value="incomplete">Incomplete or stopped</option>
          </select>
        </label>
      </div>
      {view === "sources" ? <p className="jobs-note">Standalone refreshes and underlying Graph / Power Platform jobs, including older collection workflows. These are not additional full sync runs.</p> : null}
      {error ? <div className="error-banner" role="alert">{error}</div> : null}
      {pollingPaused ? <p className="notice" role="status">Automatic status updates paused after five minutes. Use Refresh history to continue checking; jobs may still be running.</p> : null}
      {!state && !error ? <p role="status">Loading sync history...</p> : null}
      {unavailable.length ? <p className="notice" role="status">History is temporarily unavailable for {unavailable.map(source => source.source === "data-sync" ? "sync runs" : source.source === "package-refresh" ? "Graph packages" : "Power Platform").join(" and ")}. Displayed rows may be incomplete.</p> : null}
      {state && !error && !unavailable.length && !rows.length ? <p className="screen-state">{outcome !== "all"
        ? "No recent records match this outcome."
        : view === "runs" ? "No retained sync runs yet. Your next sync will appear here." : "No retained source jobs."}</p> : null}
      {rows.length ? (
        <div className="sync-table-scroll" role="region" aria-label="Scrollable sync history" tabIndex={0}>
          <table className="sync-history-table" aria-label={view === "runs" ? "Sync run history" : "Source job history"}>
            <ListTableHead table={table} titles={{ duration: "Time since the original start, including waits and retries" }} />
            <tbody>
              {rows.map(row => {
                const job = row.original;
                return <tr key={row.id}>
                  <td><time dateTime={startDate(job)}>{formatJobInstant(startDate(job))}</time>
                    {timestamp(job.startedAt) === undefined && startDate(job) ? <small>Last update; start not recorded</small> : null}</td>
                  <td className="sync-history-scope">
                    <strong>{job.source === "data-sync" && job.syncSources?.length
                      ? job.syncSources.map(source => syncSourceDetails[source].label).join(", ") : job.label}</strong>
                    <small>{job.source === "data-sync" && job.syncSources?.length ? job.label : job.target}</small>
                  </td>
                  <td><span className={`status-badge status-${job.partial && ["completed", "succeeded"].includes(job.status) ? "partial" : job.status.replaceAll("_", "-")}`}>{statusLabel(job)}</span>
                    {job.partial && !["partial", "succeeded", "completed"].includes(job.status) ? <small>Partial results</small> : null}</td>
                  <td>{resultLabel(job)}</td>
                  <td>{job.startedAt && job.completedAt
                    ? jobDuration(job)
                    : job.status === "running" || job.status === "queued" ? "In progress"
                      : job.status === "waiting" || job.status === "waiting_authorization" ? "Waiting" : "Not recorded"}</td>
                  <td><a href={job.source === "data-sync" ? `/sync?syncRun=${encodeURIComponent(job.id)}` : job.href}
                    aria-label={`View details for ${job.label} from ${formatJobInstant(startDate(job))}`}
                    onClick={event => {
                      if (job.source === "data-sync" && onOpenSyncRun && event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) {
                        event.preventDefault();
                        onOpenSyncRun(job.id);
                      }
                    }}>View details</a></td>
                </tr>;
              })}
            </tbody>
          </table>
        </div>
      ) : null}
      {state ? <div className="sync-history-pagination">
        <p className="jobs-note">{jobs.length ? `${currentPage * pageSize + 1}-${Math.min((currentPage + 1) * pageSize, jobs.length)} of ${jobs.length} recent records. ` : ""}
          {view === "runs" ? "Up to 20 sync runs retained for 30 days." : "Up to 20 recent jobs per source."}
          {" "}Filters apply to these recent records.</p>
        {lastPage > 0 ? <div>
          <button type="button" className="secondary" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>Previous</button>
          <button type="button" className="secondary" disabled={currentPage === lastPage} onClick={() => setPage(currentPage + 1)}>Next</button>
        </div> : null}
      </div> : null}
      <p className="jobs-note">{state ? <>Last checked <time dateTime={state.polledAt}>{formatJobInstant(state.polledAt)}</time>. </> : null}
        CSV imports are retained in Manage reports above. Audit and security investigations stay in their source views.</p>
    </section>
  );
}

function matchesOutcome(job: WorkbenchJobSummary, outcome: string) {
  const complete = !job.partial && (job.status === "completed" || job.status === "succeeded");
  const active = job.status === "running" || job.status === "queued";
  return outcome === "all" || (outcome === "complete" && complete)
    || (outcome === "active" && active) || (outcome === "incomplete" && !complete && !active);
}

function resultCount(job: WorkbenchJobSummary) {
  if (job.source === "data-sync") return job.total !== null ? job.completed ?? undefined : undefined;
  return (job.status === "succeeded" && !job.partial ? job.total ?? job.completed : job.completed) ?? undefined;
}

function resultLabel(job: WorkbenchJobSummary) {
  const count = resultCount(job);
  if (count === undefined) return "Count not reported";
  if (job.source === "data-sync") {
    return `${count} of ${job.total} sources complete`;
  }
  if (job.status === "succeeded" && !job.partial && job.total !== null) return `${count.toLocaleString()} records saved`;
  return `${count.toLocaleString()} reported so far`;
}

function statusLabel(job: WorkbenchJobSummary) {
  return job.partial && ["completed", "succeeded"].includes(job.status) ? jobStatusLabel(job) : syncStatusLabel(job.status);
}

function startDate(job: WorkbenchJobSummary) {
  return timestamp(job.startedAt) !== undefined ? job.startedAt
    : timestamp(job.updatedAt) !== undefined ? job.updatedAt : undefined;
}

function timestamp(value: string | undefined) {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function durationMilliseconds(job: WorkbenchJobSummary) {
  const started = timestamp(job.startedAt);
  const completed = timestamp(job.completedAt);
  return started !== undefined && completed !== undefined && completed >= started ? completed - started : undefined;
}
