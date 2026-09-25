import { RotateCcw, Upload } from "lucide-react";
import { getOfficialUsageHistory } from "../api/client";
import { useSavedQuery } from "../savedQueries";
import { usageDate } from "../usageInsights";
import { formatSyncInstant } from "./syncPresentation";
import "./dataSync.css";

export function CsvUsageReportsSection({
  principalKey, revision, canUploadUsage, onOpenUsageImport, onManageUsageReports,
}: {
  principalKey: string;
  revision: number;
  canUploadUsage: boolean;
  onOpenUsageImport: () => void;
  onManageUsageReports: () => void;
}) {
  const read = useSavedQuery({
    queryKey: ["saved", "csv-usage-reports", principalKey, revision],
    queryFn: ({ signal }) => getOfficialUsageHistory({ limit: 1, offset: 0 }, { signal }),
  });
  const loading = read.isPending || read.isFetching;
  const summary = loading || read.isError ? undefined : read.data?.summary;
  const activity = summary?.activityDateRange;
  const hasReports = Boolean(summary?.importCount);

  return <section className="data-sync-reports" aria-labelledby="sync-reports-heading" aria-busy={loading}>
    <header className="data-sync-page-header">
      <div className="data-sync-page-icon"><Upload size={24} aria-hidden="true" /></div>
      <div>
        <h2 id="sync-reports-heading" tabIndex={-1}>CSV usage reports</h2>
        <p>Manually upload Microsoft 365 usage exports. This is separate from automatic data sync.</p>
      </div>
      <div className="data-sync-toolbar">
        {canUploadUsage ? <button type="button" onClick={onOpenUsageImport}>
          <Upload size={16} aria-hidden="true" />Add CSV reports
        </button> : <p>An AgentControl.Admin can import reports.</p>}
        <button type="button" className="secondary" onClick={onManageUsageReports}>Manage reports</button>
        <button type="button" className="secondary" disabled={loading} onClick={() => void read.refetch()}>
          <RotateCcw size={15} aria-hidden="true" />{read.isError ? "Retry report summary" : "Refresh report summary"}
        </button>
      </div>
    </header>
    <div className="data-sync-details">
      {loading ? <p role="status">Loading retained activity date range...</p> : null}
      {read.isError ? <div className="error-banner" role="alert">
        {read.error.message || "The CSV report summary could not be loaded."}
        <p>The retained activity date range is unavailable. Retry the summary to verify saved reports.</p>
      </div> : null}
      {summary ? <>
        <div className="csv-usage-coverage">
          <div className="sync-health-heading">
            <h3>Retained activity date range</h3>
            <span className={`data-sync-state state-${hasReports ? "success" : "attention"}`}>
              {hasReports ? "Reports available" : "Import needed"}
            </span>
          </div>
          {hasReports ? <>
            <dl className="csv-usage-range">
              <div>
                <dt>Observed activity dates (UTC)</dt>
                <dd>{activity?.earliestDateUtc && activity.latestDateUtc
                  ? <DateRange start={activity.earliestDateUtc.slice(0, 10)} end={activity.latestDateUtc.slice(0, 10)} />
                  : "No dates found in imported reports"}</dd>
              </div>
            </dl>
            <p>Automatically calculated from the earliest and latest activity dates across all retained, complete CSV report sets in history,
              {" "}not just the current selection or latest upload. No manual dates are needed.</p>
            <p>These are observed activity dates, not reporting-window bounds or proof of continuous reporting coverage.
              {" "}The range may contain gaps; it does not imply activity on every day.
              {" "}Overlapping snapshots are not added together.</p>
          </> : <p>No complete CSV report sets are retained. Import Agents, Users &amp; agents, and Users exports
            for the same 7- or 30-day selection to make usage reports available.</p>}
        </div>
        {hasReports ? <div className="csv-usage-import-summary">
          <p>{summary.importCount.toLocaleString()} retained report sets
            {" · "}{summary.uniqueObservationCount.toLocaleString()} distinct CSV reports
            {" · "}{summary.observationRowCount.toLocaleString()} report rows</p>
          {summary.latestObservedAt ? <p>Latest acceptance <time dateTime={summary.latestObservedAt}>
            {formatSyncInstant(summary.latestObservedAt)}</time>. Acceptance time is not the usage date range.</p> : null}
        </div> : null}
      </> : null}
    </div>
  </section>;
}

function DateRange({ start, end }: { start: string; end: string }) {
  return <><time dateTime={start}>{usageDate(start)}</time>{" to "}<time dateTime={end}>{usageDate(end)}</time></>;
}
