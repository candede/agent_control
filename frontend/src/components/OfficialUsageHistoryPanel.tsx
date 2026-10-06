import { useState } from "react";
import type { ReportHistorySet, ReportMetadata, ReportObservation } from "../../../backend/src/types/officialReportData";
import { useReportPage } from "../useReportPage";
import { usageCount, usageDate } from "../usageInsights";
import { ReportPageControls, ReportReadStatus } from "./ReportPageControls";
export type ReportHistoryAdminControls = { busy: boolean; onDelete: (report: ReportHistorySet, evidence: ReportMetadata) => void };
export function OfficialUsageHistoryPanel({ revision, onSelect, admin }: { revision: number; onSelect?: (setId: string) => void; admin?: ReportHistoryAdminControls }) {
  const read = useReportPage<ReportHistorySet>("official-usage/history", { sort: "reportingPeriod", order: "desc" }, revision);
  const [observations, setObservations] = useState<string>();
  const data = read.data, history = data?.analytics.history;
  const busy = read.loading || Boolean(admin?.busy);
  return <section className="official-usage-history-panel" aria-label="Saved report sets">
    <ReportReadStatus read={read} />
    {data ? <><p>{data.counts.total.toLocaleString()} saved report sets</p>
      {data.counts.filtered > 0 ? <div className="table-shell"><table><thead><tr><th>Imported</th><th>Reporting window</th><th>Status</th><th>Actions</th></tr></thead><tbody>
        {data.value.map(set => <tr key={set.id}><td>{usageDate(set.acceptedAt)}</td><td>
          {set.reportingStart || set.reportingEnd ? <>
            {set.reportingStart ? <time dateTime={set.reportingStart}>{usageDate(set.reportingStart)}</time> : "Not reported"} to{" "}
            {set.reportingEnd ? <time dateTime={set.reportingEnd}>{usageDate(set.reportingEnd)}</time> : "Not reported"}
          </> : "No activity dates"}
          <small>{set.periodProvenance === "activity_range" ? "Observed activity" : "Reporting period"}</small></td>
          <td>{set.active ? "Current" : set.visibility === "superseded" ? "Superseded" : "Saved"}<small>{set.id}</small></td><td>
            <button type="button" disabled={busy} onClick={() => onSelect?.(set.id)}>View report</button>
            <button type="button" disabled={busy} onClick={() => setObservations(set.id)}>Report observations</button>
            {admin ? <button type="button" disabled={busy} onClick={() => admin.onDelete(set, data.reports)}>Delete report set</button> : null}</td></tr>)}</tbody></table></div> : null}
      {!data.value.length && !data.counts.filtered ? <><h4>No reports yet</h4><p>Add all three Microsoft 365 CSV exports.</p></> : null}
      <ReportPageControls {...read} loading={busy} disabled={Boolean(admin?.busy)} label="report sets" />
      <p>Activity dates do not imply continuous coverage. New imports do not change this pinned history selection.</p>
      <button type="button" disabled={busy} onClick={read.restart}>Load current report history</button>
      {history ? <details><summary>History coverage and reuse</summary>
        <p>{history.imports.toLocaleString()} imports; {history.uniqueObservations.toLocaleString()} observations; {history.observationRows.toLocaleString()} observed rows;
          {history.uniquePayloads.toLocaleString()} unique payloads, {history.repeatedRowsReused.toLocaleString()} repeated rows reused.</p>
        <p>{history.knownWindows} known windows, {history.unknownWindows} unknown windows, {history.overlappingKnownWindows} overlapping known windows.</p>
        <p>Observed activity {usageDate(history.earliestActivityDateUtc)} to {usageDate(history.latestActivityDateUtc)} does not prove continuous coverage. Totals are not additive across imports.</p>
      </details> : null}
      {observations ? <HistoryObservations key={data.selection.id + observations} setId={observations} selectionId={data.selection.id}
        onRestartSelection={() => { setObservations(undefined); read.restart(); }} /> : null}
    </> : null}
  </section>;
}
function HistoryObservations({ setId, selectionId, onRestartSelection }: { setId: string; selectionId: string; onRestartSelection: () => void }) {
  const read = useReportPage<ReportObservation>(`official-usage/history/${encodeURIComponent(setId)}/observations`, { selectionId }, 0, true, onRestartSelection);
  return <section aria-label="Report observations"><h4>Observations for {setId}</h4><ReportReadStatus read={read} />
    <ul>{read.data?.value.map(row => <li key={row.versionId}><strong>{row.kind}</strong>: {usageCount(row.rowCount)} rows; imported {usageDate(row.acceptedAt)};
      source as of {usageDate(row.sourceAsOf)} ({row.sourceAsOfProvenance}, {row.sourceFreshness}); version {row.versionId}; hash {row.contentHash}
      {row.supersedesVersionId ? `; corrects ${row.supersedesVersionId}` : ""}</li>)}</ul><ReportPageControls {...read} label="observations" /></section>;
}
