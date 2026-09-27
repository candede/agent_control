import { useEffect, useRef, useState } from "react";
import {
  acknowledgeLegacyUsageCleanup,
  confirmOfficialUsageSetOperation,
  previewOfficialUsageSetOperation,
  type OfficialUsageConfirmation,
  type OfficialUsageHistoryBundleSummary,
} from "../api/client";
import { trapDialogFocus } from "../dialogFocus";
import { clearLegacyUsageStorage, hasLegacyUsageStorage } from "../legacyUsageStorage";
import { errorMessage, reportDates } from "./officialUsageImportPresentation";
import { OfficialUsageHistoryPanel } from "./OfficialUsageHistoryPanel";

export function OfficialUsageManageReports({
  revision, canManage = false, onChanged, onLegacyCleared, onViewSnapshot, onResumeImport,
}: {
  revision: number;
  canManage?: boolean;
  onChanged?: () => void;
  onLegacyCleared?: () => void;
  onViewSnapshot: (setId: string) => void;
  onResumeImport?: (bundleId: string) => void;
}) {
  const [reload, setReload] = useState(0);
  const [target, setTarget] = useState<OfficialUsageHistoryBundleSummary>();
  const [confirmation, setConfirmation] = useState<OfficialUsageConfirmation>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ error: boolean; text: string }>();
  const [deleteError, setDeleteError] = useState<string>();
  const [legacyPresent, setLegacyPresent] = useState(hasLegacyUsageStorage);
  const live = useRef(false);
  const operation = useRef(false);
  const returnFocus = useRef<HTMLElement | null>(null);
  const section = useRef<HTMLElement>(null);

  useEffect(() => {
    live.current = true;
    return () => { live.current = false; };
  }, []);

  function dismissDelete() {
    if (operation.current) return;
    setTarget(undefined);
    setConfirmation(undefined);
    setDeleteError(undefined);
    const button = returnFocus.current;
    requestAnimationFrame(() => {
      if (!live.current) return;
      if (button?.isConnected && !button.matches(":disabled")) button.focus({ preventScroll: true });
      else section.current?.focus({ preventScroll: true });
    });
  }

  async function prepareDelete(report: OfficialUsageHistoryBundleSummary) {
    if (!canManage || operation.current) return;
    operation.current = true;
    setBusy(true);
    setMessage(undefined);
    setDeleteError(undefined);
    setConfirmation(undefined);
    if (!target) returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setTarget(report);
    try {
      const next = await previewOfficialUsageSetOperation(report.id, "delete");
      if (live.current) setConfirmation(next);
    } catch (error) {
      if (live.current) setDeleteError(errorMessage(error));
    } finally {
      operation.current = false;
      if (live.current) setBusy(false);
    }
  }

  async function deleteReport() {
    if (!canManage || operation.current || !confirmation) return;
    operation.current = true;
    setBusy(true);
    setDeleteError(undefined);
    try {
      await confirmOfficialUsageSetOperation(confirmation);
      if (!live.current) return;
      operation.current = false;
      dismissDelete();
      setMessage({ error: false, text: "Report set deleted." });
      setReload(value => value + 1);
      onChanged?.();
    } catch (error) {
      if (!live.current) return;
      setConfirmation(undefined);
      setDeleteError(`${errorMessage(error)} The deletion could not be confirmed. Cancel to check the updated list, or retry.`);
      setReload(value => value + 1);
      onChanged?.();
    } finally {
      operation.current = false;
      if (live.current) setBusy(false);
    }
  }

  async function removeLegacy() {
    if (!canManage || operation.current) return;
    operation.current = true;
    setBusy(true);
    setMessage(undefined);
    try {
      await acknowledgeLegacyUsageCleanup("discarded");
      if (!live.current) return;
      clearLegacyUsageStorage();
      setLegacyPresent(false);
      onLegacyCleared?.();
      setMessage({ error: false, text: "Old browser report data removed." });
    } catch (error) {
      if (live.current) setMessage({ error: true, text: errorMessage(error) });
    } finally {
      operation.current = false;
      if (live.current) setBusy(false);
    }
  }

  return <section ref={section} className="usage-manage-reports" aria-label="Manage saved reports" tabIndex={-1}>
    {message ? <p className={`report-status ${message.error ? "error" : "success"}`}
      role={message.error ? "alert" : "status"}>{message.text}</p> : null}
    <OfficialUsageHistoryPanel revision={revision + reload} onSelect={onViewSnapshot}
      admin={canManage ? { busy: busy || Boolean(target), onDelete: report => void prepareDelete(report), onResume: onResumeImport } : undefined} />
    {canManage && legacyPresent ? <section className="usage-legacy-notice" aria-label="Old browser reports">
      <h3>Old browser reports</h3>
      <p>These local reports are no longer used. Remove them after importing the original CSVs.</p>
      <button type="button" className="secondary" disabled={busy || Boolean(target)} onClick={() => void removeLegacy()}>Remove old browser data</button>
    </section> : null}
    {target ? <DeleteReportDialog report={target} current={confirmation ? confirmation.activeSetId === target.id : target.isActive}
      busy={busy} ready={Boolean(confirmation)} error={deleteError} onCancel={dismissDelete}
      onConfirm={() => void deleteReport()} onRetry={() => void prepareDelete(target)} /> : null}
  </section>;
}

function DeleteReportDialog({ report, current, busy, ready, error, onCancel, onConfirm, onRetry }: {
  report: OfficialUsageHistoryBundleSummary;
  current: boolean;
  busy: boolean;
  ready: boolean;
  error?: string;
  onCancel: () => void;
  onConfirm: () => void;
  onRetry: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { dialog.current?.showModal(); }, []);
  return <dialog ref={dialog} className="confirm-modal" aria-labelledby="usage-delete-title" aria-describedby="usage-delete-description"
    onKeyDown={event => { event.stopPropagation(); trapDialogFocus(event, dialog.current); }}
    onCancel={event => { event.preventDefault(); if (!busy) onCancel(); }}>
    <h2 id="usage-delete-title">Delete report set?</h2>
    <p><strong>{reportDates(report)}</strong></p>
    <p id="usage-delete-description">This removes these reports permanently.{current ? " Agents and Users will have no report selected until you choose another set." : ""}</p>
    {busy ? <p role="status">{ready ? "Deleting report set..." : "Checking report set..."}</p> : null}
    {error ? <p className="report-status error" role="alert">{error}</p> : null}
    <div className="confirm-actions">
      <button type="button" className="secondary" autoFocus disabled={busy} onClick={onCancel}>Cancel</button>
      <button type="button" className={ready ? "danger" : undefined} disabled={busy || (!ready && !error)}
        onClick={ready ? onConfirm : onRetry}>{ready ? "Delete report set" : error ? "Retry" : "Delete report set"}</button>
    </div>
  </dialog>;
}
