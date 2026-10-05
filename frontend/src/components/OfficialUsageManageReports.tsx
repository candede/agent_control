import { useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReportHistorySet, ReportMetadata } from "../../../backend/src/types/officialReportData";
import type { OfficialReportConfirmation } from "../../../backend/src/types/officialReportApi";
import { confirmReportOperation, previewReportOperation } from "../api/reportData";
import { ApiError } from "../api/client";
import { CapabilityContext } from "../capabilityContext";
import { hasRole } from "../authorization";
import { useReportPrincipalScope } from "../useReportPage";
import { trapDialogFocus } from "../dialogFocus";
import { OfficialUsageHistoryPanel } from "./OfficialUsageHistoryPanel";

type Props = { revision: number; canManage?: boolean; onChanged?: () => void; onViewSnapshot: (id: string) => void; onCorrect?: (id: string) => void };
type Target = { report: ReportHistorySet; evidence: ReportMetadata };
type Recovery = "prepare" | "refresh";
export function OfficialUsageManageReports(props: Props) {
  const capability = useContext(CapabilityContext), scope = useReportPrincipalScope();
  const allowed = Boolean(props.canManage && (!capability || hasRole(capability.user, "AgentControl.Admin")));
  return <ManageReports key={JSON.stringify([scope, allowed])} {...props} canManage={allowed} />;
}
function ManageReports({ revision, canManage, onChanged, onViewSnapshot, onCorrect }: Props) {
  const [target, setTarget] = useState<Target>(), [confirmation, setConfirmation] = useState<OfficialReportConfirmation>();
  const [busy, setBusy] = useState<"preview" | "confirm">(), [error, setError] = useState<string>(), [reload, setReload] = useState(0);
  const [recovery, setRecovery] = useState<Recovery>(), [denied, setDenied] = useState(false), [notice, setNotice] = useState<string>();
  const [seenRevision, setSeenRevision] = useState(revision);
  const operation = useRef<AbortController | undefined>(undefined), returnFocus = useRef<HTMLElement | null>(null);
  const restoreFocus = useRef(false);
  const status = useRef<HTMLParagraphElement>(null);
  useLayoutEffect(() => () => operation.current?.abort(), [revision]);
  useLayoutEffect(() => {
    if (!target && !busy && restoreFocus.current) {
      restoreFocus.current = false;
      returnFocus.current?.focus();
    }
  }, [target, busy]);
  useEffect(() => { status.current?.focus(); }, [notice]);
  if (seenRevision !== revision) {
    setSeenRevision(revision); setTarget(undefined); setConfirmation(undefined); setBusy(undefined); setError(undefined); setRecovery(undefined);
  }
  function dismiss() {
    restoreFocus.current = true;
    operation.current?.abort(); setTarget(undefined); setConfirmation(undefined); setError(undefined); setRecovery(undefined); setBusy(undefined);
  }
  function failed(cause: unknown, mode: Recovery) {
    setConfirmation(undefined); setRecovery(mode);
    setError(cause instanceof Error ? cause.message : "The report operation could not be verified.");
    if (cause instanceof ApiError && [401, 403].includes(cause.status)) { setDenied(true); setTarget(undefined); }
  }
  function reloadHistory() {
    dismiss(); setDenied(false); setNotice(undefined); setReload(value => value + 1); onChanged?.();
  }
  async function prepare(nextTarget: Target) {
    if (!canManage || busy) return;
    if (!target) returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    operation.current?.abort();
    const abort = new AbortController(); operation.current = abort;
    setTarget(nextTarget); setConfirmation(undefined); setBusy("preview"); setError(undefined); setRecovery(undefined); setNotice(undefined);
    try {
      const next = await previewReportOperation(nextTarget.report.id, "delete", abort.signal);
      if (abort.signal.aborted) return;
      const evidence = nextTarget.evidence;
      if (next.operation !== "delete" || next.setId !== nextTarget.report.id || next.activeRevision !== evidence.activeRevision
        || next.historyRevision !== evidence.historyRevision || next.historyEpoch !== evidence.historyEpoch) {
        throw new ApiError(409, "selection_invalidated", "The selected report history changed. Reload report history before preparing deletion.");
      }
      setConfirmation(next);
    } catch (cause) {
      if (!abort.signal.aborted) failed(cause, cause instanceof ApiError && [404, 409, 410].includes(cause.status) ? "refresh" : "prepare");
    } finally { if (!abort.signal.aborted) setBusy(undefined); }
  }
  async function remove() {
    if (!confirmation || !target || !canManage || busy) return;
    operation.current?.abort();
    const abort = new AbortController(); operation.current = abort;
    setBusy("confirm"); setError(undefined);
    try {
      await confirmReportOperation(confirmation, abort.signal);
      if (!abort.signal.aborted) {
        setTarget(undefined); setConfirmation(undefined); setRecovery(undefined); setReload(value => value + 1);
        setNotice("Report set deleted."); onChanged?.();
      }
    } catch (cause) {
      if (!abort.signal.aborted) {
        failed(cause, "refresh");
        if (!(cause instanceof ApiError) || cause.status === 0) setError("Deletion may already have completed. Reload report history to verify; do not repeat this confirmation.");
      }
    } finally { if (!abort.signal.aborted) setBusy(undefined); }
  }
  return <section className="usage-manage-reports" aria-label="Manage saved reports" tabIndex={0}>
    {notice ? <p ref={status} role="status" tabIndex={-1}>{notice}</p> : null}
    {denied ? <p role="alert">{error} <button type="button" onClick={reloadHistory}>Reload report history</button></p>
      : <OfficialUsageHistoryPanel key={reload} revision={revision} onSelect={onViewSnapshot}
        admin={canManage ? { busy: Boolean(busy), onDelete: (report, evidence) => void prepare({ report, evidence }) } : undefined} />}
    {target && canManage ? <DeleteReportDialog report={target.report} active={target.report.id === target.evidence.activeSetId}
      ready={Boolean(confirmation)} busy={busy} error={error} recovery={recovery} onCancel={dismiss}
      onConfirm={() => void remove()} onRetry={() => void prepare(target)} onReload={reloadHistory}
      onCorrect={onCorrect ? () => { const id = target.report.id; dismiss(); onCorrect(id); } : undefined} /> : null}
  </section>;
}
function DeleteReportDialog({ report, active, ready, busy, error, recovery, onCancel, onConfirm, onRetry, onReload, onCorrect }: {
  report: ReportHistorySet; active: boolean; ready: boolean; busy?: "preview" | "confirm"; error?: string; recovery?: Recovery;
  onCancel: () => void; onConfirm: () => void; onRetry: () => void; onReload: () => void; onCorrect?: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => { const element = dialog.current; element?.showModal(); return () => element?.close(); }, []);
  return <dialog ref={dialog} className="confirm-modal" aria-labelledby="usage-delete-title" aria-describedby="usage-delete-description"
    onKeyDown={event => { event.stopPropagation(); trapDialogFocus(event, dialog.current); }}
    onCancel={event => { event.preventDefault(); if (busy !== "confirm") onCancel(); }}>
    <h2 id="usage-delete-title">Delete report set?</h2><p>{report.reportingStart ?? "Unknown start"} to {report.reportingEnd ?? "Unknown end"}</p>
    <p id="usage-delete-description">This removes report {report.id}. History pages, overview and exports will be invalidated.
      {active ? " No report will be selected until you choose another set." : " The active report selection stays unchanged."}</p>
    {busy ? <p role="status">{busy === "confirm" ? "Deleting saved report..." : "Checking report operation..."}</p> : null}
    {error ? <p role="alert">{error}</p> : null}
    <button type="button" className="secondary" autoFocus disabled={busy === "confirm"} onClick={onCancel}>Cancel</button>
    <button type="button" className="danger" disabled={Boolean(busy) || !ready} onClick={onConfirm}>Delete report set</button>
    {recovery === "prepare" ? <button type="button" disabled={Boolean(busy)} onClick={onRetry}>Retry preparation</button> : null}
    {recovery === "refresh" ? <button type="button" disabled={Boolean(busy)} onClick={onReload}>Reload report history</button> : null}
    {onCorrect ? <button type="button" disabled={Boolean(busy)} onClick={onCorrect}>Import correction instead</button> : null}
  </dialog>;
}
