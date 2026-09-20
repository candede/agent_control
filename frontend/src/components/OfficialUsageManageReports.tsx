import { Trash2 } from "lucide-react";
import type { OfficialUsageAdminState } from "../api/client";
import { formatCoverage, formatInstant, formatProvenance, kindLabel } from "./officialUsageImportPresentation";

export function OfficialUsageManageReports({
  state, verified, busy, onResume, onOperation, onViewSnapshot,
}: {
  state?: OfficialUsageAdminState;
  verified: boolean;
  busy: boolean;
  onResume: (bundleId: string) => void;
  onOperation: (setId: string, operation: "select" | "delete") => void;
  onViewSnapshot?: (setId: string) => void;
}) {
  const drafts = [...new Set(state?.staging.filter(stage => stage.status === "active").map(stage => stage.bundleId))];
  const disabled = busy || !verified;
  return (
    <>
      <p>Accepted snapshots remain in report history. Viewing a snapshot is read-only; changing the saved selection or deleting a set requires separate confirmation.</p>
      {!verified && state ? <p className="usage-context-warning">Showing last loaded report metadata. Refresh successfully before using report actions or relying on the saved selection.</p> : null}
      {drafts.length ? (
        <section className="usage-managed-drafts" aria-label="Staged imports">
          <h4>Staged imports</h4>
          <ul>{drafts.map(bundleId => {
            const stages = state!.staging.filter(stage => stage.bundleId === bundleId && stage.status === "active");
            return <li key={bundleId}>
              <div><strong>Draft {bundleId.slice(0, 8)}</strong><span>{stages.map(stage => kindLabel(stage.kind)).join(", ")} · not published</span></div>
              <button type="button" className="secondary" disabled={disabled} onClick={() => onResume(bundleId)}>Resume import<span className="sr-only"> {bundleId.slice(0, 8)}</span></button>
            </li>;
          })}</ul>
        </section>
      ) : null}
      <section className="official-usage-history" aria-label="Retained report sets">
        <h4>Retained report sets</h4>
        <p>Coverage is source-supplied or observed activity, never proof of continuous coverage. Overlapping aggregate exports are non-additive. This history is separate from sync runs.</p>
        {state?.sets.length ? (
          <div className="table-shell usage-managed-table" role="region" aria-label="Managed report history" tabIndex={0}>
            <table>
              <thead><tr><th scope="col">Activity coverage / supplied period</th><th scope="col">Reports</th><th scope="col">Status</th><th scope="col">Lineage</th><th scope="col">Accepted</th><th scope="col">Actions</th></tr></thead>
              <tbody>{state.sets.map(reportSet => (
                <tr key={reportSet.id}>
                  <td>{formatCoverage(reportSet.reportingPeriod)}<small>{formatProvenance(reportSet.reportingPeriod.provenance)}</small></td>
                  <td>{reportSet.kinds.map(kindLabel).join(", ")}</td>
                  <td>{reportSet.deletedAt ? "Deleted" : !verified ? "Not verified" : !reportSet.complete ? "Incomplete" : reportSet.id === state.activeSetId ? "Current" : "Retained"}</td>
                  <td>{reportSet.supersedesSetId ? `Corrects ${reportSet.supersedesSetId.slice(0, 8)}` : "Independent snapshot"}</td>
                  <td>{reportSet.acceptedAt ? formatInstant(reportSet.acceptedAt) : "Pending companions"}</td>
                  <td><div className="table-actions">
                    {!reportSet.complete && !reportSet.deletedAt ? <button type="button" className="secondary" disabled={disabled} onClick={() => onResume(reportSet.bundleId)}>Resume</button> : null}
                    {reportSet.complete && !reportSet.deletedAt && onViewSnapshot ? <button type="button" className="secondary" disabled={disabled} onClick={() => onViewSnapshot(reportSet.id)}>View snapshot</button> : null}
                    {reportSet.complete && !reportSet.deletedAt && reportSet.id !== state.activeSetId ? <button type="button" className="secondary" disabled={disabled} onClick={() => onOperation(reportSet.id, "select")}>Make current</button> : null}
                    {!reportSet.deletedAt ? <button type="button" className="icon-button danger" aria-label={`Delete retained set for ${formatCoverage(reportSet.reportingPeriod)}`} disabled={disabled} onClick={() => onOperation(reportSet.id, "delete")}><Trash2 size={16} aria-hidden="true" /></button> : null}
                  </div></td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        ) : <p>{verified ? "No retained official usage sets." : "Report history has not been verified."}</p>}
      </section>
    </>
  );
}
