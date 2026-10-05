import { useContext, useLayoutEffect, useRef, useState } from "react";
import type { ReportHistorySet, ReportListPage, ReportMetadata } from "../../../backend/src/types/officialReportData";
import type { OfficialReportConfirmation } from "../../../backend/src/types/officialReportApi";
import { confirmReportOperation, previewReportOperation } from "../api/reportData";
import { ApiError } from "../api/client";
import { useReportPage, useReportPrincipalScope } from "../useReportPage";
import { CapabilityContext } from "../capabilityContext";
import { hasRole } from "../authorization";
import "./officialUsage.css";
export function OfficialUsageReportSelector({ principalKey, revision, onChanged }: {
  principalKey: string; revision: number; onChanged: (selectionChanged: boolean) => void;
}) {
  const scope = useReportPrincipalScope();
  return <Selector key={JSON.stringify([principalKey, scope])} revision={revision} onChanged={onChanged} />;
}
function sameRevisions(confirmation: OfficialReportConfirmation, reports: ReportMetadata) {
  return confirmation.activeRevision === reports.activeRevision && confirmation.historyRevision === reports.historyRevision
    && confirmation.historyEpoch === reports.historyEpoch;
}
function reportLabel(set: ReportHistorySet) {
  const dates = set.reportingStart && set.reportingEnd ? `${set.reportingStart} to ${set.reportingEnd}` : "No activity dates";
  return `${set.periodProvenance === "activity_range" ? "Observed activity" : "Reporting window"}: ${dates} | ${set.id.slice(0, 8)}`;
}
function Selector({ revision, onChanged }: { revision: number; onChanged: (selected: boolean) => void }) {
  const read = useReportPage<ReportHistorySet, ReportListPage<ReportHistorySet>>("official-usage/history/options", { sort: "acceptedAt", order: "desc" }, revision);
  const capability = useContext(CapabilityContext), canManage = !capability || hasRole(capability.user, "AgentControl.Admin");
  const [candidate, setCandidate] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState<string>();
  const [denied, setDenied] = useState(false), [seenRevision, setSeenRevision] = useState(revision);
  const lifetime = useRef<AbortController | undefined>(undefined);
  useLayoutEffect(() => { const controller = new AbortController(); lifetime.current = controller; return () => controller.abort(); }, [revision]);
  if (seenRevision !== revision) {
    setSeenRevision(revision); setCandidate(""); setBusy(false);
    if (!denied) setError(undefined);
  }
  const data = denied ? undefined : read.data, active = data?.reports.activeSetId;
  const selected = data?.value.find(set => set.id === (candidate || active));
  const placeholder = read.loading ? "Loading report sets..." : !data ? "Report sets unavailable"
    : data.counts.filtered === 0 ? "No report sets available" : "No report set selected";
  async function selectReport(id: string) {
    const abort = lifetime.current;
    if (!canManage || busy || read.loading || !data || error || !abort) return;
    if (id === "older-reports" && data.page.nextCursor) { read.next(); return; }
    if (id === "newer-reports" && data.page.previousCursor) { read.previous(); return; }
    if (!id || id === active || !data.value.some(set => set.id === id)) return;
    setCandidate(id); setBusy(true); setError(undefined);
    let confirming = false;
    try {
      const next = await previewReportOperation(id, "select", abort.signal);
      if (abort.signal.aborted) return;
      if (next.operation !== "select" || next.setId !== id || !sameRevisions(next, data.reports)) {
        throw new ApiError(409, "selection_invalidated", "The shared report selection or history changed. Reload report selections before confirming.");
      }
      confirming = true;
      const result = await confirmReportOperation(next, abort.signal);
      if (abort.signal.aborted) return;
      if (result.activeSetId !== next.setId) throw new Error("The returned active report did not match the confirmed selection.");
      setCandidate(""); setError(undefined); read.restart(); onChanged(true);
    } catch (cause) {
      if (!abort.signal.aborted) {
        const uncertain = confirming && (!(cause instanceof ApiError) || cause.status < 400 || cause.status >= 500);
        setError(`${uncertain ? "Selection may have been saved. " : ""}${cause instanceof Error ? cause.message : "Selection was not confirmed."} Retry to reload report sets before selecting again.`);
        setCandidate("");
        if (cause instanceof ApiError && [401, 403].includes(cause.status)) setDenied(true);
      }
    } finally { if (!abort.signal.aborted) setBusy(false); }
  }
  return <section className="usage-report-selector" aria-label="Report set selection" aria-busy={busy || read.loading}>
    <select aria-label="Report set" value={candidate || active || ""} disabled={busy || read.loading || !data || !data.counts.filtered || !canManage || Boolean(error)}
      title={selected ? reportLabel(selected) : "Report set"}
      onChange={event => void selectReport(event.target.value)}><option value="" disabled>{placeholder}</option>
      {active && !data?.value.some(set => set.id === active) ? <option value={active}>Current report {active.slice(0, 8)} (outside this page) - selected</option> : null}
      {data?.value.map(set => <option key={set.id} value={set.id}>{reportLabel(set)}{set.id === active ? " - selected" : ""}</option>)}
      {data?.page.previousCursor ? <option value="newer-reports">Newer report sets...</option> : null}
      {data?.page.nextCursor ? <option value="older-reports">Older report sets...</option> : null}
    </select>
    <span className="sr-only" role="status">{busy ? "Selecting report set..." : read.loading ? "Loading report sets..." : ""}</span>
    {!canManage ? <p>An administrator can change the shared report selection. Historical reports remain available in Manage reports.</p> : null}
    {error || read.error ? <div className="report-status error" role="alert">{error ?? read.error?.message}{" "}
      <button type="button" className="secondary" disabled={busy || read.loading} onClick={() => {
        setError(undefined); setCandidate(""); setDenied(false); read.restart(); onChanged(false);
      }}>Retry</button></div> : null}
  </section>;
}
