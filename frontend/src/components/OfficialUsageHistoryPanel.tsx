import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import {
  ApiError,
  getOfficialUsageHistory,
  type OfficialUsageHistoryBundleSummary,
  type OfficialUsageHistoryView,
  type OfficialUsageReportKind,
} from "../api/client";
import "./officialUsage.css";

const pageSize = 25;

export function OfficialUsageHistoryPanel({
  revision,
  selectedSetId,
  onSelect,
}: {
  revision: number;
  selectedSetId?: string;
  onSelect: (setId: string | undefined) => void;
}) {
  const [history, setHistory] = useState<OfficialUsageHistoryView>();
  const [offset, setOffset] = useState(0);
  const [reload, setReload] = useState(0);
  const [read, setRead] = useState<{ key: string; error?: string }>();
  const readKey = JSON.stringify([offset, reload, revision]);
  const scopedRead = read?.key === readKey ? read : undefined;
  const loading = !scopedRead;
  const error = scopedRead?.error;
  const displayedHistory = history?.bundles.offset === offset ? history : undefined;

  useEffect(() => {
    const controller = new AbortController();
    void getOfficialUsageHistory({ limit: pageSize, offset }, { signal: controller.signal })
      .then(next => {
        if (controller.signal.aborted) return;
        setHistory(next);
        setRead({ key: readKey });
        if (offset > 0 && offset >= next.bundles.count) {
          setOffset(Math.max(0, Math.floor(Math.max(0, next.bundles.count - 1) / pageSize) * pageSize));
        }
      })
      .catch(reason => {
        if (controller.signal.aborted || (reason instanceof ApiError && reason.kind === "aborted")) return;
        if (reason instanceof ApiError && (reason.status === 401 || reason.status === 403)) setHistory(undefined);
        setRead({ key: readKey, error: reason instanceof Error ? reason.message : "Official usage history is unavailable." });
      });
    return () => controller.abort();
  }, [offset, readKey]);

  const selected = selectedSetId
    ? displayedHistory?.bundles.value.find(bundle => bundle.id === selectedSetId)
    : undefined;
  const first = displayedHistory?.bundles.count ? displayedHistory.bundles.offset + 1 : 0;
  const last = displayedHistory ? Math.min(displayedHistory.bundles.offset + displayedHistory.bundles.value.length, displayedHistory.bundles.count) : 0;

  return (
    <section className="official-usage-history-panel" aria-labelledby="official-usage-history-title" aria-busy={loading}>
      <header className="report-section-header">
        <div>
          <h3 id="official-usage-history-title">Report history</h3>
          <p>Open a retained snapshot without changing the tenant&apos;s current report selection.</p>
        </div>
        <button type="button" className="secondary" disabled={loading} onClick={() => setReload(value => value + 1)}>
          <RefreshCw size={15} aria-hidden="true" />Refresh history
        </button>
      </header>

      {selectedSetId ? (
        <div className="usage-history-selection" role="status">
          <div>
            <strong>Viewing retained snapshot {selectedSetId.slice(0, 8)}</strong>
            <span>
              {selected ? windowLabel(selected) : "The selected snapshot is outside this history page."}
              {" "}This read-only view does not change the active snapshot.
            </span>
          </div>
          <button type="button" className="secondary" onClick={() => onSelect(undefined)}>Return to current snapshot</button>
        </div>
      ) : null}

      {error ? <div className="error-banner" role="alert">{error}{displayedHistory ? <p>Showing the last loaded history. Refresh successfully before opening another snapshot.</p> : null}</div> : null}
      {loading ? <p role="status">{displayedHistory
        ? "Showing the last loaded history while refreshing. Snapshot actions are unavailable until the refresh succeeds."
        : "Loading retained official usage snapshots..."}</p> : null}
      {displayedHistory ? (
        <>
          <div className="usage-history-warning" role="note">
            <strong>Aggregate snapshots are non-additive.</strong>
            <span>{displayedHistory.summary.warning.message}</span>
          </div>
          <p className="usage-result-summary">{displayedHistory.bundles.count.toLocaleString()} retained snapshots. Each row opens one report, not a cumulative total.</p>
          {displayedHistory.bundles.value.length ? (
            <div className="table-shell usage-history-table" role="region" aria-label="Retained official usage snapshots" tabIndex={0}>
              <table>
                <thead>
                  <tr>
                    <th scope="col">Imported</th>
                    <th scope="col">Reporting coverage</th>
                    <th scope="col">Source files</th>
                    <th scope="col">Status</th>
                    <th scope="col">View</th>
                  </tr>
                </thead>
                <tbody>
                  {displayedHistory.bundles.value.map(bundle => (
                    <tr key={bundle.id}>
                      <td>{bundle.acceptedAt ? formatInstant(bundle.acceptedAt) : "Incomplete"}</td>
                      <td>
                        {windowLabel(bundle)}
                        <small>{windowBasis(bundle)}</small>
                      </td>
                      <td>
                        <details>
                          <summary>{bundle.kinds.length} exports</summary>
                          <p>{bundle.kinds.map(kindLabel).join(", ")}. {bundle.rowCount.toLocaleString()} rows; {bundle.repeatedRowsReused.toLocaleString()} duplicate rows reused.</p>
                          <p>{bundleLineage(bundle)}. {bundleRetention(bundle)}.</p>
                          <ul className="usage-history-observations">
                            {bundle.observations.map(observation => (
                              <li key={observation.versionId}>
                                <strong>{kindLabel(observation.kind)}</strong>: {observation.rowCount.toLocaleString()} rows,{" "}
                                {observation.uniquePayloadCount.toLocaleString()} unique payloads,{" "}
                                {observation.repeatedRowsReused.toLocaleString()} duplicate rows reused
                                <small>
                                  Original acceptance {formatInstant(observation.lineage.acceptedAt)} · content {observation.contentHash.slice(0, 12)}
                                  {observation.lineage.supersedesVersionId
                                    ? ` · corrects observation ${observation.lineage.supersedesVersionId.slice(0, 8)}`
                                    : ""}
                                </small>
                              </li>
                            ))}
                          </ul>
                        </details>
                      </td>
                      <td>
                        <strong>{bundleStatus(bundle)}</strong>
                      </td>
                      <td>
                        {selectedSetId === bundle.id ? (
                          <span className="usage-state">Viewing</span>
                        ) : bundle.isActive && !selectedSetId ? (
                          <span className="usage-state">Current</span>
                        ) : bundle.complete && !bundle.deletedAt ? (
                          <button type="button" className="secondary" disabled={loading || Boolean(error)} onClick={() => onSelect(bundle.id)}>
                            View snapshot
                          </button>
                        ) : <span>Unavailable</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <p>No accepted official usage snapshots are retained.</p>}

          {displayedHistory.bundles.count > pageSize ? (
            <nav className="table-pagination" aria-label="Official usage history pages">
              <button type="button" className="secondary" disabled={offset === 0 || loading} onClick={() => setOffset(value => Math.max(0, value - pageSize))}>Previous</button>
              <span>{first}-{last} of {displayedHistory.bundles.count.toLocaleString()}</span>
              <button type="button" className="secondary" disabled={last >= displayedHistory.bundles.count || loading} onClick={() => setOffset(value => value + pageSize)}>Next</button>
            </nav>
          ) : null}
          <details className="usage-report-details">
            <summary>Retention and source accounting</summary>
            <div className="usage-history-metrics" aria-label="Official usage history summary">
              <HistoryMetric label="Accepted imports" value={displayedHistory.summary.importCount} />
              <HistoryMetric label="Report observations" value={displayedHistory.summary.uniqueObservationCount} />
              <HistoryMetric label="Observed rows" value={displayedHistory.summary.observationRowCount} />
              <HistoryMetric label="Unique payloads" value={displayedHistory.summary.uniquePayloadCount} />
              <HistoryMetric label="Duplicate rows reused" value={displayedHistory.summary.repeatedRowsReused} />
            </div>
            <p>{displayedHistory.summary.reportingWindows.knownCount} source window(s) known;{" "}
              {displayedHistory.summary.reportingWindows.unknownCount} unknown;{" "}
              {displayedHistory.summary.reportingWindows.overlappingKnownWindowCount} overlapping known window(s).</p>
            <p>{activityRangeLabel(displayedHistory)}</p>
            <p>Semantic duplicate observations reuse their original identity and acceptance time; they do not refresh historical acceptance dates.</p>
            <p>Pseudonymous usernames remain scoped to each retained report set and are not assumed to identify the same person across snapshots.</p>
          </details>
        </>
      ) : null}
      {!displayedHistory && !loading && error && offset > 0 ? <button type="button" className="secondary" onClick={() => setOffset(0)}>First history page</button> : null}
    </section>
  );
}

function HistoryMetric({ label, value }: { label: string; value: number }) {
  return <div><span>{label}</span><strong>{value.toLocaleString()}</strong></div>;
}

function activityRangeLabel(history: OfficialUsageHistoryView) {
  const { earliestDateUtc, latestDateUtc } = history.summary.activityDateRange;
  if (!earliestDateUtc || !latestDateUtc) return "No last-activity date range has been observed.";
  return `Observed last-activity dates span ${formatDate(earliestDateUtc)} to ${formatDate(latestDateUtc)}. This does not prove report-window coverage.`;
}

function windowLabel(bundle: OfficialUsageHistoryBundleSummary) {
  const { startDate, endDate } = bundle.reportingPeriod;
  if (bundle.reportingWindowKnown && startDate && endDate) return `${formatDate(startDate)} to ${formatDate(endDate)}`;
  if (startDate && endDate) return `Observed activity ${formatDate(startDate)} to ${formatDate(endDate)}`;
  return "Reporting window unknown";
}

function windowBasis(bundle: OfficialUsageHistoryBundleSummary) {
  if (!bundle.reportingWindowKnown) return "Last-activity range only; not proven report coverage";
  return bundle.reportingPeriod.provenance === "source_metadata"
    ? "Source-supplied reporting window"
    : "Administrator-supplied reporting window";
}

function bundleStatus(bundle: OfficialUsageHistoryBundleSummary) {
  if (bundle.deletedAt) return "Deleted";
  if (bundle.isActive) return "Current";
  if (!bundle.complete) return "Incomplete";
  return "Retained";
}

function bundleLineage(bundle: OfficialUsageHistoryBundleSummary) {
  return bundle.supersedesSetId
    ? `Intentional correction of ${bundle.supersedesSetId.slice(0, 8)}`
    : "Independent cumulative snapshot";
}

function bundleRetention(bundle: OfficialUsageHistoryBundleSummary) {
  if (bundle.deletedAt) return `Deleted ${formatInstant(bundle.deletedAt)}`;
  if (!bundle.expiresAt) return "Retained until explicitly deleted";
  const expiresAt = new Date(bundle.expiresAt);
  if (Number.isNaN(expiresAt.getTime())) return "Retention date unavailable";
  return `Legacy retention timestamp ${formatInstant(bundle.expiresAt)}; accepted history remains retained until explicitly deleted`;
}

function kindLabel(kind: OfficialUsageReportKind) {
  return kind === "agents" ? "Agents" : kind === "userAgents" ? "Users & agents" : "Users";
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeZone: "UTC" }).format(new Date(value));
}

function formatInstant(value: string) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}
