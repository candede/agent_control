import { useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReportHistorySet, ReportMetadata } from "../../../backend/src/types/officialReportData";
import type { OfficialReportConfirmation } from "../../../backend/src/types/officialReportApi";
import { confirmReportOperation, previewReportOperation } from "../api/reportData";
import { ApiError } from "../api/client";
import { CapabilityContext } from "../capabilityContext";
import { hasRole } from "../authorization";
import { useReportPrincipalScope } from "../useReportPage";
import { observeDialogFocus, trapDialogFocus } from "../dialogFocus";
import { OfficialUsageHistoryPanel } from "./OfficialUsageHistoryPanel";

type Props = { revision: number; canManage?: boolean; onChanged?: () => void; onViewSnapshot: (id: string) => void; onCorrect?: (id: string) => void };
type Target = { report: ReportHistorySet; evidence: ReportMetadata; canAct: () => boolean };
type Recovery = "prepare" | "refresh";
export function OfficialUsageManageReports(props: Props) {
  const capability = useContext(CapabilityContext), scope = useReportPrincipalScope();
  const allowed = Boolean(props.canManage && (!capability || hasRole(capability.user, "AgentControl.Admin")));
  return <ManageReports key={JSON.stringify([scope, allowed])} {...props} canManage={allowed} />;
}
function ManageReports({ revision, canManage, onChanged, onViewSnapshot, onCorrect }: Props) {
  const [target, setTarget] = useState<Target>(), [confirmation, setConfirmation] = useState<OfficialReportConfirmation>();
  const [busy, setBusy] = useState<"preview" | "confirm">(), [error, setError] = useState<string>();
  const [reload, setReload] = useState({ sequence: 0, revision });
  const [recovery, setRecovery] = useState<Recovery>(), [denied, setDenied] = useState(false), [notice, setNotice] = useState<string>();
  const [seenRevision, setSeenRevision] = useState(revision);
  const [interaction, setInteraction] = useState(0), interactionSequence = useRef(0);
  const operation = useRef<{ controller: AbortController; kind: "preview" | "confirm" } | undefined>(undefined);
  const management = useRef<HTMLElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const restoreFocus = useRef(false);
  const status = useRef<HTMLParagraphElement>(null), denial = useRef<HTMLParagraphElement>(null);
  useLayoutEffect(() => () => operation.current?.controller.abort(), [revision]);
  useLayoutEffect(() => {
    if (target) restoreFocus.current = true;
    else if (!busy && restoreFocus.current) {
      restoreFocus.current = false;
      const opener = returnFocus.current;
      if (opener?.isConnected) opener.focus();
      if (!opener || document.activeElement !== opener) management.current?.focus();
    }
  }, [target, busy, interaction]);
  useEffect(() => { status.current?.focus(); }, [notice]);
  useEffect(() => { if (denied) denial.current?.focus(); }, [denied]);
  if (seenRevision !== revision) {
    setSeenRevision(revision); setTarget(undefined); setConfirmation(undefined); setBusy(undefined); setRecovery(undefined);
    if (!denied) setError(undefined);
  }
  function retireHandlers() {
    // Retire this render's handlers before React replaces a cancelled or consumed dialog.
    setInteraction(++interactionSequence.current);
  }
  function dismiss() {
    if (interactionSequence.current !== interaction
      || operation.current?.kind === "confirm" && !operation.current.controller.signal.aborted) return false;
    retireHandlers();
    restoreFocus.current = true;
    operation.current?.controller.abort(); setTarget(undefined); setConfirmation(undefined); setError(undefined); setRecovery(undefined); setBusy(undefined);
    return true;
  }
  function failed(cause: unknown, mode: Recovery) {
    setConfirmation(undefined); setRecovery(mode);
    setError(cause instanceof Error ? cause.message : "The report operation could not be verified.");
    if (cause instanceof ApiError && [401, 403].includes(cause.status)) { setDenied(true); setTarget(undefined); }
  }
  function reloadHistory() {
    if (!dismiss()) return;
    setDenied(false); setNotice(undefined); setReload(value => ({ sequence: value.sequence + 1, revision })); onChanged?.();
  }
  async function prepare(nextTarget: Target) {
    if (interactionSequence.current !== interaction || !canManage || !nextTarget.canAct() || busy || operation.current && !operation.current.controller.signal.aborted) return;
    if (!target) {
      const focused = document.activeElement;
      returnFocus.current = focused instanceof HTMLElement && focused !== document.body && focused !== document.documentElement ? focused : null;
    }
    const abort = new AbortController(); operation.current = { controller: abort, kind: "preview" };
    setTarget(nextTarget); setConfirmation(undefined); setBusy("preview"); setError(undefined); setRecovery(undefined); setNotice(undefined);
    try {
      const next = await previewReportOperation(nextTarget.report.id, "delete", abort.signal);
      if (abort.signal.aborted) return;
      if (!nextTarget.canAct()) { dismiss(); return; }
      const evidence = nextTarget.evidence;
      if (next.operation !== "delete" || next.setId !== nextTarget.report.id || next.activeRevision !== evidence.activeRevision
        || next.historyRevision !== evidence.historyRevision || next.historyEpoch !== evidence.historyEpoch) {
        throw new ApiError(409, "selection_invalidated", "The selected report history changed. Reload report history before preparing deletion.");
      }
      setConfirmation(next);
    } catch (cause) {
      if (!abort.signal.aborted) failed(cause, cause instanceof ApiError && [404, 409, 410].includes(cause.status) ? "refresh" : "prepare");
    } finally {
      if (operation.current?.controller === abort) {
        operation.current = undefined;
        if (!abort.signal.aborted) setBusy(undefined);
      }
    }
  }
  async function remove() {
    if (interactionSequence.current !== interaction || !confirmation || !target?.canAct() || !canManage || busy || operation.current && !operation.current.controller.signal.aborted) return;
    retireHandlers();
    const abort = new AbortController(); operation.current = { controller: abort, kind: "confirm" };
    setBusy("confirm"); setError(undefined);
    try {
      await confirmReportOperation(confirmation, abort.signal);
      if (!abort.signal.aborted) {
        setTarget(undefined); setConfirmation(undefined); setRecovery(undefined); setReload(value => ({ sequence: value.sequence + 1, revision }));
        setNotice("Report set deleted."); onChanged?.();
      }
    } catch (cause) {
      if (!abort.signal.aborted) {
        failed(cause, "refresh");
        if (!(cause instanceof ApiError) || cause.status === 0) setError("Deletion may already have completed. Reload report history to verify; do not repeat this confirmation.");
      }
    } finally {
      if (operation.current?.controller === abort) {
        operation.current = undefined;
        if (!abort.signal.aborted) setBusy(undefined);
      }
    }
  }
  return <section ref={management} className="usage-manage-reports" aria-label="Manage saved reports" tabIndex={0}>
    {notice ? <p ref={status} role="status" tabIndex={-1}>{notice}</p> : null}
    {denied ? <p ref={denial} role="alert" tabIndex={-1}>{error} <button type="button" onClick={reloadHistory}>Reload report history</button></p>
      : <OfficialUsageHistoryPanel key={reload.sequence} revision={revision}
        freshCaptureOnMount={reload.sequence > 0 && reload.revision === revision} onSelect={onViewSnapshot}
        onSelectionRetired={() => { if (target && recovery !== "refresh") dismiss(); }}
        admin={canManage ? { busy: Boolean(busy), onDelete: (report, evidence, canAct) => void prepare({ report, evidence, canAct }) } : undefined} />}
    {target && canManage ? <DeleteReportDialog report={target.report} active={target.report.id === target.evidence.activeSetId}
      ready={Boolean(confirmation) && target.canAct()} busy={busy}
      error={error ?? (!busy && !target.canAct() ? "This saved selection is no longer eligible. Reload report history before deleting." : undefined)}
      recovery={!busy && !target.canAct() ? "refresh" : recovery} onCancel={dismiss}
      onConfirm={() => void remove()} onRetry={() => void prepare(target)} onReload={reloadHistory}
      onCorrect={onCorrect ? () => { if (dismiss()) onCorrect(target.report.id); } : undefined} /> : null}
  </section>;
}
function DeleteReportDialog({ report, active, ready, busy, error, recovery, onCancel, onConfirm, onRetry, onReload, onCorrect }: {
  report: ReportHistorySet; active: boolean; ready: boolean; busy?: "preview" | "confirm"; error?: string; recovery?: Recovery;
  onCancel: () => void; onConfirm: () => void; onRetry: () => void; onReload: () => void; onCorrect?: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    const element = dialog.current;
    if (!element) return;
    element.showModal();
    const stopObservingFocus = observeDialogFocus(element);
    return () => { stopObservingFocus(); element.close(); };
  }, []);
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
