import { useLayoutEffect, useRef, useState } from "react";
import { Trash2 } from "lucide-react";
import type { ReportHistorySet, ReportMetadata } from "../../../backend/src/types/officialReportData";
import { useReportPage, useReportPrincipalScope } from "../useReportPage";
import { usageDate } from "../usageInsights";
import { ReportPageControls, ReportReadStatus } from "./ReportPageControls";
export type ReportHistoryAdminControls = { busy: boolean; onDelete: (report: ReportHistorySet, evidence: ReportMetadata, canAct: () => boolean) => void };
export function OfficialUsageHistoryPanel({ revision, onSelect, admin, freshCaptureOnMount = false, onSelectionRetired }: {
  revision: number; onSelect?: (setId: string) => void; admin?: ReportHistoryAdminControls; freshCaptureOnMount?: boolean;
  onSelectionRetired?: () => void;
}) {
  const read = useReportPage<ReportHistorySet>("official-usage/history", { sort: "reportingPeriod", order: "desc" }, revision, true, undefined, true, freshCaptureOnMount);
  const principal = useReportPrincipalScope(), owner = JSON.stringify([principal, revision, read.selectionRevision]);
  const data = read.data;
  const [pagination, setPagination] = useState({ owner, visible: false });
  const paginated = data ? Boolean(data.page.nextCursor || data.page.previousCursor) : pagination.owner === owner && pagination.visible;
  if (pagination.owner !== owner || pagination.visible !== paginated) setPagination({ owner, visible: paginated });
  const selection = data ? JSON.stringify([owner, data.selection.id.toLowerCase()]) : undefined;
  const previousSelection = useRef<string | undefined>(undefined);
  useLayoutEffect(() => {
    const previous = previousSelection.current;
    previousSelection.current = selection;
    if (previous !== undefined && previous !== selection) onSelectionRetired?.();
  }, [selection, onSelectionRetired]);
  useLayoutEffect(() => {
    if (read.leaseEnded) onSelectionRetired?.();
  }, [read.leaseEnded, onSelectionRetired]);
  const busy = read.loading || Boolean(admin?.busy);
  return <section className="official-usage-history-panel" aria-label="Saved report sets">
    <ReportReadStatus read={read} />
    {data ? <>
      {data.counts.total > 0 ? <p className="usage-history-count">{data.counts.total.toLocaleString()} saved report {data.counts.total === 1 ? "set" : "sets"}</p> : null}
      {data.counts.filtered > 0 ? <div className="table-shell usage-history-table" role="region" aria-label="Saved report history" aria-busy={read.loading} tabIndex={0}><table><thead><tr>
        <th scope="col">Imported</th><th scope="col">Activity dates</th><th scope="col">Status</th><th scope="col"><span className="sr-only">Actions</span></th>
      </tr></thead><tbody>
        {data.value.map(set => <tr key={set.id}><td><span className="usage-mobile-label" aria-hidden="true">Imported</span>{usageDate(set.acceptedAt)}</td><td>
          <span className="usage-mobile-label" aria-hidden="true">Activity dates</span>
          {set.reportingStart || set.reportingEnd ? <>
            {set.reportingStart ? <time dateTime={set.reportingStart}>{usageDate(set.reportingStart)}</time> : "Not reported"} to{" "}
            {set.reportingEnd ? <time dateTime={set.reportingEnd}>{usageDate(set.reportingEnd)}</time> : "Not reported"}
          </> : "No activity dates"}
          <small>{set.periodProvenance === "activity_range" ? "Observed activity" : "Reporting period"}</small></td>
          <td><span className="usage-mobile-label" aria-hidden="true">Status</span>
            <span className={`usage-report-badge${set.active ? " is-current" : ""}`}>{set.active ? "Current" : set.visibility === "superseded" ? "Superseded" : "Saved"}</span>
          </td><td><div className="table-actions">
            <button type="button" className="secondary" disabled={busy} onClick={() => onSelect?.(set.id)}>View report</button>
            {admin ? <button type="button" className="icon-button danger" aria-label="Delete report set" disabled={busy || read.leaseEnded} onClick={() => {
              if (read.isCurrentData()) admin.onDelete(set, data.reports, () => read.isCurrentData(true, current => current.selection.id === data.selection.id
                && current.reports.activeRevision === data.reports.activeRevision && current.reports.historyRevision === data.reports.historyRevision
                && current.reports.historyEpoch === data.reports.historyEpoch));
            }}><Trash2 size={16} aria-hidden="true" /></button> : null}</div></td></tr>)}</tbody></table></div> : null}
      {!data.value.length && !data.counts.filtered ? <div className="usage-empty-state"><h3>No reports yet</h3><p>Add the three Microsoft 365 CSV exports to see agent usage.</p></div> : null}
    </> : null}
    {paginated && !read.invalidated ? <ReportPageControls {...read} loading={busy} disabled={Boolean(admin?.busy)} label="report sets" compact /> : null}
  </section>;
}
