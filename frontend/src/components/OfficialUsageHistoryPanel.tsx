import { useEffect, useState } from "react";
import { Trash2 } from "lucide-react";
import {
  ApiError,
  getOfficialUsageHistory,
  type OfficialUsageHistoryBundleSummary,
  type OfficialUsageHistoryView,
} from "../api/client";
import { useSavedRead } from "../savedQueries";
import { reportDates } from "./officialUsageImportPresentation";
import { formatSyncInstant } from "./syncPresentation";
import "./officialUsage.css";

const pageSize = 25;

export type ReportHistoryAdminControls = {
  busy: boolean;
  onDelete: (report: OfficialUsageHistoryBundleSummary) => void;
  onResume?: (bundleId: string) => void;
};

export function OfficialUsageHistoryPanel({ revision, onSelect, admin }: {
  revision: number;
  onSelect?: (setId: string) => void;
  admin?: ReportHistoryAdminControls;
}) {
  const [history, setHistory] = useState<OfficialUsageHistoryView>();
  const [offset, setOffset] = useState(0);
  const [reload, setReload] = useState(0);
  const [read, setRead] = useState<{ key: string; error?: string }>();
  const readSaved = useSavedRead();
  const readKey = JSON.stringify([offset, reload, revision]);
  const scopedRead = read?.key === readKey ? read : undefined;
  const loading = !scopedRead;
  const error = scopedRead?.error;
  const displayedHistory = history?.bundles.offset === offset ? history : undefined;
  const verified = !loading && !error && Boolean(displayedHistory);

  useEffect(() => {
    const controller = new AbortController();
    const query = { limit: pageSize, offset };
    void readSaved(["official-usage-history", query, revision, reload],
      signal => getOfficialUsageHistory(query, { signal }), controller.signal)
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
        setRead({ key: readKey, error: reason instanceof Error ? reason.message : "Reports could not be loaded." });
      });
    return () => controller.abort();
  }, [offset, readKey, readSaved, reload, revision]);

  useEffect(() => {
    const refresh = () => { if (!admin?.busy) setReload(value => value + 1); };
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [admin?.busy]);

  const first = displayedHistory?.bundles.count ? offset + 1 : 0;
  const last = displayedHistory ? Math.min(offset + displayedHistory.bundles.value.length, displayedHistory.bundles.count) : 0;
  const disabled = !verified || admin?.busy;

  return <section className="official-usage-history-panel" aria-label="Saved report sets" aria-busy={loading}>
    {error ? <div className="error-banner" role="alert">
      <p>{error}</p>
      {displayedHistory ? <p>The list below could not be updated.</p> : null}
      <button type="button" className="secondary" disabled={admin?.busy} onClick={() => setReload(value => value + 1)}>Retry</button>
    </div> : null}
    {loading ? <p role="status">Loading reports...</p> : null}
    {displayedHistory ? <>
      <p className="usage-history-count">{displayedHistory.bundles.count.toLocaleString()} saved report {displayedHistory.bundles.count === 1 ? "set" : "sets"}</p>
      {displayedHistory.bundles.value.length ? <div className="table-shell usage-history-table" role="region" aria-label="Saved reports" tabIndex={0}>
        <table role="table">
          <thead><tr>
            <th scope="col">Imported</th>
            <th scope="col">Activity dates</th>
            <th scope="col">Reports</th>
            <th scope="col">Status</th>
            <th scope="col"><span className="sr-only">Actions</span></th>
          </tr></thead>
          <tbody>{displayedHistory.bundles.value.map(bundle => <tr key={bundle.id}>
            <td><span className="usage-mobile-label" aria-hidden="true">Imported</span>
              {bundle.acceptedAt ? <time dateTime={bundle.acceptedAt}>{formatSyncInstant(bundle.acceptedAt)}</time> : "Not finished"}</td>
            <td><span className="usage-mobile-label" aria-hidden="true">Activity dates</span>
              {reportDates(bundle)}<small>{bundle.reportingWindowKnown ? "Reporting period" : "Observed activity"}</small></td>
            <td><span className="usage-mobile-label" aria-hidden="true">Reports</span>
              {bundle.kinds.length} CSVs<small>{bundle.rowCount.toLocaleString()} rows</small></td>
            <td><span className="usage-mobile-label" aria-hidden="true">Status</span>
              <span className={`usage-report-badge${bundle.isActive && !bundle.deletedAt ? " is-current" : ""}`}>
              {bundle.deletedAt ? "Deleted" : !bundle.complete ? "Incomplete" : bundle.isActive ? "Current" : "Saved"}
            </span></td>
            <td><div className="table-actions">
              {bundle.complete && !bundle.deletedAt && onSelect ? <button type="button" className="secondary"
                disabled={disabled} onClick={() => onSelect(bundle.id)}>View report</button> : null}
              {!bundle.complete && !bundle.deletedAt && admin?.onResume ? <button type="button" className="secondary"
                disabled={disabled} onClick={() => admin.onResume?.(bundle.bundleId)}>Continue import</button> : null}
              {admin && !bundle.deletedAt ? <button type="button" className="icon-button danger"
                aria-label={`Delete report set: ${reportDates(bundle)}`} disabled={disabled}
                onClick={() => admin.onDelete(bundle)}><Trash2 size={16} aria-hidden="true" /></button> : null}
            </div></td>
          </tr>)}</tbody>
        </table>
      </div> : <div className="usage-empty-state"><h3>No reports yet</h3><p>Add the three Microsoft 365 CSV exports to see agent usage.</p></div>}
      {displayedHistory.bundles.count > pageSize ? <nav className="table-pagination" aria-label="Report history pages">
        <button type="button" className="secondary" disabled={offset === 0 || loading || admin?.busy}
          onClick={() => setOffset(value => Math.max(0, value - pageSize))}>Previous</button>
        <span>{first}-{last} of {displayedHistory.bundles.count.toLocaleString()}</span>
        <button type="button" className="secondary" disabled={last >= displayedHistory.bundles.count || loading || admin?.busy}
          onClick={() => setOffset(value => value + pageSize)}>Next</button>
      </nav> : null}
      {displayedHistory.bundles.count ? <p className="usage-import-hint">Switch report sets in Agents to explore usage. Activity dates do not imply continuous coverage.</p> : null}
    </> : null}
    {!displayedHistory && !loading && error && offset > 0 ? <button type="button" className="secondary" onClick={() => setOffset(0)}>First page</button> : null}
  </section>;
}
