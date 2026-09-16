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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    void Promise.resolve().then(() => {
      if (controller.signal.aborted) return undefined;
      setLoading(true);
      setError("");
      return getOfficialUsageHistory({ limit: pageSize, offset }, { signal: controller.signal });
    })
      .then(next => {
        if (!next || controller.signal.aborted) return;
        setHistory(next);
        if (offset > 0 && offset >= next.bundles.count) {
          setOffset(Math.max(0, Math.floor(Math.max(0, next.bundles.count - 1) / pageSize) * pageSize));
        }
      })
      .catch(reason => {
        if (controller.signal.aborted || (reason instanceof ApiError && reason.kind === "aborted")) return;
        setError(reason instanceof Error ? reason.message : "Official usage history is unavailable.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [offset, reload, revision]);

  const selected = selectedSetId
    ? history?.bundles.value.find(bundle => bundle.id === selectedSetId)
    : undefined;
  const first = history?.bundles.count ? offset + 1 : 0;
  const last = history ? Math.min(offset + history.bundles.value.length, history.bundles.count) : 0;

  return (
    <section className="official-usage-history-panel" aria-labelledby="official-usage-history-title" aria-busy={loading}>
      <header className="report-section-header">
        <div>
          <h2 id="official-usage-history-title">Accumulated official usage history</h2>
          <p>Browse retained snapshots beyond a rolling 30-day export without changing the tenant’s current selection.</p>
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

      {error ? <div className="error-banner" role="alert">{error}</div> : null}
      {!history && loading ? <p role="status">Loading retained official usage snapshots...</p> : null}
      {history ? (
        <>
          <div className="usage-history-metrics" aria-label="Official usage history summary">
            <HistoryMetric label="Accepted imports" value={history.summary.importCount} />
            <HistoryMetric label="Report observations" value={history.summary.uniqueObservationCount} />
            <HistoryMetric label="Observed rows" value={history.summary.observationRowCount} />
            <HistoryMetric label="Unique payloads" value={history.summary.uniquePayloadCount} />
            <HistoryMetric label="Duplicate rows reused" value={history.summary.repeatedRowsReused} />
          </div>

          <div className="usage-history-warning" role="note">
            <strong>Aggregate snapshots are non-additive.</strong>
            <span>{history.summary.warning.message}</span>
            <span>
              {history.summary.reportingWindows.knownCount} source window(s) known;{" "}
              {history.summary.reportingWindows.unknownCount} unknown;{" "}
              {history.summary.reportingWindows.overlappingKnownWindowCount} overlapping known window(s).
            </span>
            <span>{activityRangeLabel(history)}</span>
            <span>Semantic duplicate observations reuse their original identity and acceptance time; they do not refresh historical acceptance dates.</span>
            <span>Pseudonymous usernames remain scoped to each retained report set and are not assumed to identify the same person across snapshots.</span>
          </div>

          {history.bundles.value.length ? (
            <div className="table-shell usage-history-table" role="region" aria-label="Retained official usage snapshots" tabIndex={0}>
              <table>
                <thead>
                  <tr>
                    <th>Source window / activity range</th>
                    <th>Reports</th>
                    <th>Rows</th>
                    <th>Duplicate rows reused</th>
                    <th>Status / lineage</th>
                    <th>Accepted</th>
                    <th>View</th>
                  </tr>
                </thead>
                <tbody>
                  {history.bundles.value.map(bundle => (
                    <tr key={bundle.id}>
                      <td>
                        {windowLabel(bundle)}
                        <small>{windowBasis(bundle)}</small>
                      </td>
                      <td>
                        {bundle.kinds.map(kindLabel).join(", ")}
                        <details>
                          <summary>{bundle.observationCount} observation(s)</summary>
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
                      <td>{bundle.rowCount.toLocaleString()}</td>
                      <td>{bundle.repeatedRowsReused.toLocaleString()}</td>
                      <td>
                        <strong>{bundleStatus(bundle)}</strong>
                        <small>{bundleLineage(bundle)}</small>
                        <small>{bundleRetention(bundle)}</small>
                      </td>
                      <td>{bundle.acceptedAt ? formatInstant(bundle.acceptedAt) : "Incomplete"}</td>
                      <td>
                        {selectedSetId === bundle.id ? (
                          <span className="usage-state">Viewing</span>
                        ) : bundle.isActive && !selectedSetId ? (
                          <span className="usage-state">Current</span>
                        ) : bundle.complete && !bundle.deletedAt ? (
                          <button type="button" className="secondary" onClick={() => onSelect(bundle.id)}>
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

          {history.bundles.count > pageSize ? (
            <nav className="table-pagination" aria-label="Official usage history pages">
              <button type="button" className="secondary" disabled={offset === 0 || loading} onClick={() => setOffset(value => Math.max(0, value - pageSize))}>Previous</button>
              <span>{first}-{last} of {history.bundles.count.toLocaleString()}</span>
              <button type="button" className="secondary" disabled={last >= history.bundles.count || loading} onClick={() => setOffset(value => value + pageSize)}>Next</button>
            </nav>
          ) : null}
        </>
      ) : null}
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
  return `Legacy finite retention until ${formatInstant(bundle.expiresAt)}`;
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
