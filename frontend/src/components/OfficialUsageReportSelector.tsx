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
  const [denied, setDenied] = useState<ApiError>(), [seenRevision, setSeenRevision] = useState(revision);
  const read = useReportPage<ReportHistorySet, ReportListPage<ReportHistorySet>>("official-usage/history/options", { sort: "reportingPeriod", order: "desc" }, revision, !denied);
  if (!denied && read.error instanceof ApiError && [401, 403].includes(read.error.status)) setDenied(read.error);
  const capability = useContext(CapabilityContext), canManage = !capability || hasRole(capability.user, "AgentControl.Admin");
  const [candidate, setCandidate] = useState("");
  const [busy, setBusy] = useState<"preview" | "confirm">(), [error, setError] = useState<string>();
  const [interaction, setInteraction] = useState(0), interactionSequence = useRef(0);
  const lifetime = useRef<AbortController | undefined>(undefined);
  const operation = useRef<{ controller: AbortController; confirming: boolean } | undefined>(undefined);
  const completion = useRef({ restart: read.restart, onChanged });
  useLayoutEffect(() => { completion.current = { restart: read.restart, onChanged }; });
  const currentRead = useRef(read.isCurrentData);
  useLayoutEffect(() => { currentRead.current = read.isCurrentData; });
  useLayoutEffect(() => {
    const controller = new AbortController(); lifetime.current = controller;
    return () => { controller.abort(); operation.current?.controller.abort(); };
  }, []);
  const data = denied ? undefined : read.data, active = data?.reports.activeSetId?.toLowerCase();
  const evidence = data ? JSON.stringify([read.selectionRevision, data.selection.id.toLowerCase(),
    data.reports.activeRevision, data.reports.historyRevision, data.reports.historyEpoch]) : undefined;
  const [seenEvidence, setSeenEvidence] = useState(evidence);
  useLayoutEffect(() => () => {
    // Withdraw unsent work with its evidence, but still observe an admitted commit.
    if (operation.current && !operation.current.confirming) operation.current.controller.abort();
  }, [evidence, revision]);
  if (seenEvidence !== evidence) {
    setSeenEvidence(evidence);
    if (busy === "preview") { setCandidate(""); setBusy(undefined); }
  }
  if (seenRevision !== revision) {
    setSeenRevision(revision);
    if (busy !== "confirm") { setCandidate(""); setBusy(undefined); }
    if (!denied) setError(undefined);
  }
  const selected = data?.value.find(set => set.id.toLowerCase() === (candidate || active));
  const placeholder = read.loading ? "Loading report sets..." : !data ? "Report sets unavailable"
    : data.counts.filtered === 0 ? "No report sets available" : "No report set selected";
  function retireHandlers() { setInteraction(++interactionSequence.current); }
  async function selectReport(id: string) {
    if (interactionSequence.current !== interaction || !canManage || busy || read.loading || !data || error || read.error || !read.isCurrentData()
      || !lifetime.current || lifetime.current.signal.aborted) return;
    if (id === "older-reports" && data.page.nextCursor) { retireHandlers(); read.next(); return; }
    if (id === "newer-reports" && data.page.previousCursor) { retireHandlers(); read.previous(); return; }
    id = id.toLowerCase();
    if (!id || id === active || !data.value.some(set => set.id.toLowerCase() === id)) return;
    retireHandlers();
    const abort = new AbortController(), work = { controller: abort, confirming: false };
    operation.current = work;
    setCandidate(id); setBusy("preview"); setError(undefined);
    try {
      const next = await previewReportOperation(id, "select", abort.signal);
      if (abort.signal.aborted) return;
      if (!currentRead.current(true, current => current.selection.id === data.selection.id
        && current.selection.revision === data.selection.revision && sameRevisions(next, current.reports))) { setCandidate(""); return; }
      if (next.operation !== "select" || next.setId.toLowerCase() !== id || !sameRevisions(next, data.reports)) {
        throw new ApiError(409, "selection_invalidated", "The shared report selection or history changed. Reload report selections before confirming.");
      }
      work.confirming = true; setBusy("confirm");
      const result = await confirmReportOperation(next, abort.signal);
      if (abort.signal.aborted) return;
      if (result.activeSetId?.toLowerCase() !== next.setId.toLowerCase()) throw new Error("The returned active report did not match the confirmed selection.");
      setCandidate(""); setError(undefined); completion.current.restart(); completion.current.onChanged(true);
    } catch (cause) {
      if (!abort.signal.aborted) {
        const uncertain = work.confirming && (!(cause instanceof ApiError) || cause.status < 400 || cause.status >= 500);
        setError(`${uncertain ? "Selection may have been saved. " : ""}${cause instanceof Error ? cause.message : "Selection was not confirmed."} Retry to reload report sets before selecting again.`);
        setCandidate("");
        if (cause instanceof ApiError && [401, 403].includes(cause.status)) setDenied(cause);
      }
    } finally {
      if (operation.current === work) operation.current = undefined;
      if (!abort.signal.aborted) setBusy(undefined);
    }
  }
  return <section className="usage-report-selector" aria-label="Report set selection" aria-busy={Boolean(busy) || read.loading}>
    <select aria-label="Report set" value={candidate || active || ""} disabled={Boolean(busy) || read.loading || read.leaseEnded || !data || !data.counts.filtered || !canManage || Boolean(error)}
      title={selected ? reportLabel(selected) : "Report set"}
      onChange={event => void selectReport(event.target.value)}><option value="" disabled>{placeholder}</option>
      {active && !data?.value.some(set => set.id.toLowerCase() === active) ? <option value={active}>Current report {active.slice(0, 8)} (outside this page) - selected</option> : null}
      {data?.value.map(set => <option key={set.id.toLowerCase()} value={set.id.toLowerCase()}>{reportLabel(set)}{set.id.toLowerCase() === active ? " - selected" : ""}</option>)}
      {data?.page.previousCursor ? <option value="newer-reports">Newer report sets...</option> : null}
      {data?.page.nextCursor ? <option value="older-reports">Older report sets...</option> : null}
    </select>
    <span className="sr-only" role="status">{busy ? "Selecting report set..." : read.loading ? "Loading report sets..." : ""}</span>
    {read.leaseEnded && !read.error && !read.renewing ? <p role="status">Showing saved report sets. <button type="button" onClick={read.restart}>Reload report sets</button> before changing the shared report.</p> : null}
    {!canManage ? <p>An administrator can change the shared report selection. Historical reports remain available in Manage reports.</p> : null}
    {error || denied || read.error ? <div className="report-status error" role="alert">{error ?? denied?.message ?? read.error?.message}{" "}
      <button type="button" className="secondary" disabled={Boolean(busy) || read.loading} onClick={() => {
        if (interactionSequence.current !== interaction || busy || read.loading || !lifetime.current || lifetime.current.signal.aborted) return;
        retireHandlers();
        setError(undefined); setCandidate(""); setDenied(undefined); read.restart();
        if (error) onChanged(false);
      }}>Retry</button></div> : null}
  </section>;
}
