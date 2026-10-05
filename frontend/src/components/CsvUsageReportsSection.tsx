import { Upload } from "lucide-react";
import { reportPages } from "../api/reportData";
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
    queryKey: ["saved", "csv-usage-reports", principalKey, revision], gcTime: 0,
    queryFn: ({ signal }) => reportPages.history({ limit: 1 }, signal),
  });
  const loading = read.isPending || read.isFetching;
  const summary = loading || read.isError ? undefined : read.data?.analytics.history;
  const hasReports = Boolean(summary?.imports);

  return <section className="data-sync-reports" aria-labelledby="sync-reports-heading" aria-busy={loading}>
    <header className="data-sync-page-header">
      <div className="data-sync-page-icon"><Upload size={24} aria-hidden="true" /></div>
      <div>
        <h2 id="sync-reports-heading" tabIndex={-1}>CSV usage reports</h2>
        <p>Import Microsoft 365 usage exports to see agent activity.</p>
      </div>
      <div className="data-sync-toolbar">
        {canUploadUsage ? <button type="button" onClick={onOpenUsageImport}>
          <Upload size={16} aria-hidden="true" />Add CSV reports
        </button> : <p>An AgentControl.Admin can import reports.</p>}
        <button type="button" className="secondary" onClick={onManageUsageReports}>Manage reports</button>
      </div>
    </header>
    <div className="data-sync-details">
      {loading ? <p role="status">Loading reports...</p> : null}
      {read.isError ? <div className="error-banner" role="alert">
        {read.error.message || "The CSV report summary could not be loaded."}
        <button type="button" className="secondary" disabled={loading} onClick={() => void read.refetch()}>Retry</button>
      </div> : null}
      {summary ? <>
        <div className="csv-usage-coverage">
          <div className="sync-health-heading">
            <h3>{hasReports ? `${summary.imports.toLocaleString()} saved report ${summary.imports === 1 ? "set" : "sets"}` : "No reports yet"}</h3>
            <span className={`data-sync-state state-${hasReports ? "success" : "attention"}`}>
              {hasReports ? "Reports available" : "Import needed"}
            </span>
          </div>
          {hasReports ? <>
            <dl className="csv-usage-range">
              <div>
                <dt>Observed activity dates (UTC)</dt>
                <dd>{summary.earliestActivityDateUtc && summary.latestActivityDateUtc
                  ? <DateRange start={summary.earliestActivityDateUtc} end={summary.latestActivityDateUtc} />
                  : "No dates found in imported reports"}</dd>
              </div>
            </dl>
            <p>Observed activity across all saved report sets, not continuous reporting coverage. Report totals are kept separate.</p>
          </> : <p>Add the Agents, Users &amp; agents, and Users CSV exports from the same reporting period.</p>}
        </div>
        {hasReports ? <div className="csv-usage-import-summary">
          {summary.latestAcceptedAt ? <p>Last imported <time dateTime={summary.latestAcceptedAt}>
            {formatSyncInstant(summary.latestAcceptedAt)}</time></p> : null}
        </div> : null}
      </> : null}
    </div>
  </section>;
}

function DateRange({ start, end }: { start: string; end: string }) {
  return <><time dateTime={start}>{usageDate(start)}</time>{" to "}<time dateTime={end}>{usageDate(end)}</time></>;
}
