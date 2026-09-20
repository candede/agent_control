import { useRef, useState } from "react";
import { ArrowDown, ArrowUp, History, RefreshCw } from "lucide-react";
import type { WorkbenchJobSummary, WorkbenchJobsResponse } from "../api/client";
import { WorkbenchActionGate } from "../workbenchActionContext";
import { WorkbenchDialog } from "./WorkbenchDialog";
import {
  compareJobDates, formatJobInstant, jobActionAvailable, jobActionId, jobActionLabel,
  jobDuration, jobKey, jobOutcome, jobPhase, jobRecordDate, jobResultExplanation,
  jobResultLabel, jobSourceHref, jobSourceLabels, jobSourceLinkLabel, jobStatusLabel,
  type JobOperation,
} from "./jobPresentation";
import "./jobs.css";

const historyPageSize = 15;
const currentPageSize = 10;
const operations = ["resume", "cancel", "reconcile"] as const;

export function JobHistoryView({ state, error, loading, busy, pollingPaused, onRefresh, onAction, onOpenSyncRun }: {
  state?: WorkbenchJobsResponse;
  error: string;
  loading: boolean;
  busy: string;
  pollingPaused: boolean;
  onRefresh: () => void;
  onAction: (job: WorkbenchJobSummary, operation: JobOperation) => void;
  onOpenSyncRun?: (runId: string) => void;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  const [source, setSource] = useState("all");
  const [search, setSearch] = useState("");
  const [outcome, setOutcome] = useState("all");
  const [newestFirst, setNewestFirst] = useState(true);
  const [historyPage, setHistoryPage] = useState(0);
  const [currentPage, setCurrentPage] = useState(0);
  const [selectedKey, setSelectedKey] = useState<string>();
  const selected = state?.value.find(job => jobKey(job) === selectedKey);
  const query = search.trim().toLowerCase();
  const filtered = state?.value.filter(job => (source === "all" || job.source === source)
    && (!query || [job.label, job.target, job.id, jobSourceLabels[job.source]].some(value => value.toLowerCase().includes(query)))) ?? [];
  const current = filtered.filter(job => jobPhase(job) !== "history").sort((left, right) =>
    Number(jobPhase(left) === "waiting") - Number(jobPhase(right) === "waiting") || compareJobDates(left, right));
  const history = filtered.filter(job => jobPhase(job) === "history" && (outcome === "all" || jobOutcome(job) === outcome))
    .sort((left, right) => compareJobDates(left, right, newestFirst));
  const currentIndex = Math.min(currentPage, Math.max(0, Math.ceil(current.length / currentPageSize) - 1));
  const historyIndex = Math.min(historyPage, Math.max(0, Math.ceil(history.length / historyPageSize) - 1));
  const unavailable = state?.unavailableSources ?? [];
  const hasFilters = source !== "all" || query !== "";

  function resetFilters() {
    setSource("all");
    setSearch("");
    setOutcome("all");
    setCurrentPage(0);
    setHistoryPage(0);
  }

  return <section className="jobs-view jobs-dashboard" aria-labelledby="jobs-heading" aria-busy={loading}>
    <header className="jobs-page-header">
      <div className="jobs-page-icon"><History size={24} aria-hidden="true" /></div>
      <div><h2 id="jobs-heading" ref={heading} tabIndex={-1}>Jobs</h2><p>Monitor current work and review recent outcomes for this account.</p></div>
      <button type="button" className="secondary" disabled={loading || Boolean(busy)} onClick={onRefresh}>
        <RefreshCw size={16} aria-hidden="true" />{loading ? "Checking..." : "Refresh status"}
      </button>
    </header>
    <div className="jobs-body">
      {!selectedKey && error ? <div className="error-banner" role="alert">{error}{state ? <p>Showing the last loaded status. Refresh to check for newer outcomes.</p> : null}</div> : null}
      {loading && !state && !error ? <p role="status">Loading authorized job metadata...</p> : null}
      {unavailable.length ? <div className="notice" role="status">
        {unavailable.length} authorized source{unavailable.length === 1 ? " is" : "s are"} temporarily unavailable: {unavailable.map(item => jobSourceLabels[item.source]).join(", ")}.
        {" "}Displayed records may be incomplete; other source statuses remain usable.
      </div> : null}
      {pollingPaused ? <p className="jobs-poll-notice" role="status">Automatic status updates paused after five minutes. Use Refresh status to continue checking; jobs may still be running.</p> : null}
      <div className="jobs-filters">
        <label>Source
          <select aria-label="Filter jobs by source" value={source} onChange={event => { setSource(event.target.value); setCurrentPage(0); setHistoryPage(0); }}>
            <option value="all">All sources</option>
            {Object.entries(jobSourceLabels).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
          </select>
        </label>
        <label className="jobs-search">Search jobs
          <input type="search" value={search} maxLength={256} placeholder="Job name, scope or ID" onChange={event => { setSearch(event.target.value); setCurrentPage(0); setHistoryPage(0); }} />
        </label>
        {hasFilters || outcome !== "all" ? <button type="button" className="jobs-text-button" onClick={resetFilters}>Clear filters</button> : null}
      </div>
      {state && !state.value.length ? <p className="jobs-empty">{unavailable.length || error
        ? "No records were returned by the available sources. A successful status check is needed for a complete recent view."
        : "No retained jobs are visible to this account and role set."}</p> : null}
      {state && state.value.length > 0 ? <>
        <section className="jobs-current" aria-labelledby="current-jobs-heading">
          <div className="jobs-section-heading">
            <div>
              <h3 id="current-jobs-heading">Current work <span>({current.length})</span></h3>
              <p>{current.length
                ? `${current.filter(job => jobPhase(job) === "progress").length} running or queued, ${current.filter(job => jobPhase(job) === "waiting").length} waiting for input. Select a job to review its next step.`
                : hasFilters ? "No current work matches these filters." : "No jobs are in progress or waiting for input in the loaded records."}</p>
            </div>
          </div>
          {current.length ? <>
            <JobTable jobs={current.slice(currentIndex * currentPageSize, (currentIndex + 1) * currentPageSize)} current onSelect={job => setSelectedKey(jobKey(job))} />
            {current.length > currentPageSize ? <JobPagination page={currentIndex} pageSize={currentPageSize} count={current.length} label="current jobs" onChange={setCurrentPage} /> : null}
          </> : null}
        </section>
        <section className="jobs-history" aria-labelledby="job-history-heading">
          <div className="jobs-section-heading">
            <div>
              <h3 id="job-history-heading">Job history</h3>
              <p>Finished and stopped attempts. Select a job for details, results or recovery.</p>
            </div>
            <label className="jobs-outcome-filter">Outcome
              <select aria-label="Filter history by outcome" value={outcome} onChange={event => { setOutcome(event.target.value); setHistoryPage(0); }}>
                <option value="all">All outcomes</option>
                <option value="complete">Complete or accepted</option>
                <option value="incomplete">Incomplete or inconclusive</option>
                <option value="failed">Failed</option>
                <option value="cancelled">Cancelled or discarded</option>
                <option value="expired">Expired</option>
                <option value="other">Other outcomes</option>
              </select>
            </label>
          </div>
          {history.length ? <>
            <JobTable jobs={history.slice(historyIndex * historyPageSize, (historyIndex + 1) * historyPageSize)} onSelect={job => setSelectedKey(jobKey(job))}
              newestFirst={newestFirst} onSort={() => { setNewestFirst(!newestFirst); setHistoryPage(0); }} />
            <JobPagination page={historyIndex} pageSize={historyPageSize} count={history.length} label="history" onChange={setHistoryPage} />
          </> : <p className="jobs-empty">{hasFilters || outcome !== "all" ? "No recent history matches these filters." : "No finished or stopped jobs in the loaded records."}</p>}
        </section>
      </> : null}
      <footer className="jobs-footer">
        {state ? <p>Last checked <time dateTime={state.polledAt}>{formatJobInstant(state.polledAt)}</time>. Status request <code>{state.requestId}</code>.</p> : null}
        <p>Up to 100 recent records, capped per source. Filters apply to this list, not a complete archive. Sync runs and their source jobs are separate records.</p>
        <div className="jobs-related-history">
          <a href="/official-usage?view=history">Report snapshot history</a>
          <a href="/audit?source=local">Administrative audit log</a>
        </div>
      </footer>
    </div>
    <WorkbenchDialog open={Boolean(selectedKey)} title="Job details" description={selected ? `${selected.label} · ${jobSourceLabels[selected.source]}` : undefined}
      className="job-details" fallbackFocusRef={heading} onClose={() => setSelectedKey(undefined)}>
      {error ? <div className="error-banner" role="alert">{error}</div> : null}
      {selected ? <>
        <div className="job-detail-outcome"><JobStatus job={selected} /><strong>{jobResultLabel(selected)}</strong></div>
        <p className="job-detail-explanation">{jobResultExplanation(selected)}</p>
        <a className="job-source-link" href={jobSourceHref(selected)} onClick={event => {
          if (selected.source === "data-sync" && onOpenSyncRun && event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) {
            event.preventDefault();
            setSelectedKey(undefined);
            onOpenSyncRun(selected.id);
          }
        }}>{jobSourceLinkLabel(selected)}</a>
        {operations.some(operation => jobActionAvailable(selected, operation)) ? <section className="job-recovery" aria-labelledby="job-recovery-heading">
          <h3 id="job-recovery-heading">{jobPhase(selected) === "history" ? "Recovery actions" : "Job actions"}</h3>
          <p>{selected.source === "official-usage" ? "Discarding this unaccepted draft does not remove accepted report snapshots."
            : selected.source === "data-sync" ? "Retry resumes incomplete sources only. Cancelling this run does not undo work already completed."
              : "Resume sends only approved unsent work. Cancellation does not undo completed work, and already dispatched operations may still finish. Reconciliation reads provider state without sending another change."}</p>
          <div className="job-recovery-actions">
            {operations.filter(operation => jobActionAvailable(selected, operation)).map(operation => (
              <WorkbenchActionGate key={operation} actionId={jobActionId(selected, operation)}>
                <button type="button" className={operation === "cancel" ? "danger" : "secondary"} disabled={Boolean(busy)} onClick={() => onAction(selected, operation)}>
                  {busy === `${operation}:${jobKey(selected)}`
                    ? operation === "resume" ? "Resuming..." : operation === "cancel" ? "Cancelling..." : "Reconciling..."
                    : jobActionLabel(selected, operation)}
                </button>
              </WorkbenchActionGate>
            ))}
          </div>
        </section> : null}
        <section className="job-detail-record" aria-labelledby="job-record-heading">
          <h3 id="job-record-heading">Record details</h3>
          <dl className="job-detail-facts">
            <div><dt>Job ID</dt><dd><code>{selected.id}</code></dd></div>
            <div><dt>Source</dt><dd>{jobSourceLabels[selected.source]}</dd></div>
            <div className="job-detail-scope"><dt>Scope</dt><dd>{selected.target}</dd></div>
            <div><dt>{selected.source === "official-usage" ? "Staged" : "Created"}</dt><dd>{formatJobInstant(selected.createdAt)}</dd></div>
            <div><dt>Started</dt><dd>{formatJobInstant(selected.startedAt)}</dd></div>
            <div><dt>{selected.source === "official-usage" && selected.status === "accepted" ? "Accepted" : "Finished"}</dt><dd>{formatJobInstant(selected.completedAt)}</dd></div>
            <div><dt>Duration (including waits)</dt><dd>{jobDuration(selected)}</dd></div>
            {selected.source !== "official-usage" ? <div><dt>Last updated</dt><dd>{formatJobInstant(selected.updatedAt)}</dd></div> : null}
            {selected.expiresAt ? <div><dt>Record expires</dt><dd>{formatJobInstant(selected.expiresAt)}</dd></div> : null}
            {state ? <div><dt>Status lookup request</dt><dd><code>{state.requestId}</code></dd></div> : null}
          </dl>
          <p>Missing start or finish times are not inferred from updates. The status lookup request identifies this page's status check, not a provider operation. Detailed results and diagnostics remain in the source view.</p>
          {selected.source === "official-usage" ? <p>Jobs shows at most 50 CSV staging records created in the last 24 hours. Older accepted reports remain in report snapshot history, subject to retention.</p> : null}
        </section>
      </> : <p role="status">{loading ? "Checking the selected job..." : "This job is no longer in the latest authorized recent-records list. Its source may be unavailable, the record may have expired, or access may have changed."}</p>}
    </WorkbenchDialog>
  </section>;
}

function JobStatus({ job }: { job: WorkbenchJobSummary }) {
  const phase = jobPhase(job);
  return <span className={`job-outcome job-outcome-${phase === "history" ? jobOutcome(job) : phase}`}>{jobStatusLabel(job)}</span>;
}

function JobTable({ jobs, current = false, newestFirst = true, onSort, onSelect }: {
  jobs: WorkbenchJobSummary[];
  current?: boolean;
  newestFirst?: boolean;
  onSort?: () => void;
  onSelect: (job: WorkbenchJobSummary) => void;
}) {
  return <div className="job-table-shell">
    <p className="jobs-table-hint">Scroll horizontally for dates and counts. Select a job name for details.</p>
    <div className="jobs-table-scroll" role="region" aria-label={current ? "Scrollable current jobs" : "Scrollable job history"} tabIndex={0}>
      <table className={`job-history-table${current ? " job-current-table" : ""}`} aria-label={current ? "Current jobs" : "Job history"}>
        <thead><tr>
          <th scope="col" className="job-table-name">Job / scope</th>
          <th scope="col" className="job-table-outcome">{current ? "Status" : "Outcome"}</th>
          <th scope="col" className="job-table-date" aria-sort={!current ? newestFirst ? "descending" : "ascending" : undefined}>
            {current ? "Last updated" : <button type="button" className="jobs-text-button" aria-label={`Order history ${newestFirst ? "oldest" : "newest"} first`} onClick={onSort}>
              Created {newestFirst ? <ArrowDown size={14} aria-hidden="true" /> : <ArrowUp size={14} aria-hidden="true" />}
            </button>}
          </th>
          <th scope="col" className="job-table-result">{current ? "Progress" : "Result"}</th>
          {!current ? <th scope="col" title="Recorded time from start to finish, including waits and retries">Duration</th> : null}
        </tr></thead>
        <tbody>{jobs.map(job => {
          const date = jobRecordDate(job);
          return <tr key={jobKey(job)}>
            <th scope="row">
              <button type="button" className="job-title-button" aria-label={`View details for ${job.label}, job ${job.id}`} onClick={() => onSelect(job)}>{job.label}</button>
              <small>{jobSourceLabels[job.source]}</small>
              <p>{job.target}</p>
            </th>
            <td><JobStatus job={job} />{job.partial && !["partial", "inconclusive", "completed", "succeeded", "accepted"].includes(job.status) ? <small>Partial / inconclusive results</small> : null}</td>
            <td>{current ? <time dateTime={job.updatedAt}>{formatJobInstant(job.updatedAt)}</time>
              : date.value ? <><time dateTime={date.value}>{formatJobInstant(date.value)}</time>{date.label !== "Created" ? <small>{date.label === "Started" ? "Start time; creation not recorded" : "Last update; original date not recorded"}</small> : null}</> : "Not recorded"}</td>
            <td>{jobResultLabel(job)}</td>
            {!current ? <td>{jobDuration(job)}</td> : null}
          </tr>;
        })}</tbody>
      </table>
    </div>
  </div>;
}

function JobPagination({ page, pageSize, count, label, onChange }: {
  page: number; pageSize: number; count: number; label: string; onChange: (page: number) => void;
}) {
  return <div className="jobs-pagination">
    <p>{page * pageSize + 1}-{Math.min((page + 1) * pageSize, count)} of {count} {label === "history" ? "recent history records" : "current jobs"}</p>
    {count > pageSize ? <div>
      <button type="button" className="secondary" aria-label={`Previous ${label} page`} disabled={page === 0} onClick={() => onChange(page - 1)}>Previous</button>
      <button type="button" className="secondary" aria-label={`Next ${label} page`} disabled={(page + 1) * pageSize >= count} onClick={() => onChange(page + 1)}>Next</button>
    </div> : null}
  </div>;
}
