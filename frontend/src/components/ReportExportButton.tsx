import { useCallback, useEffect, useRef, useState, type MouseEvent } from "react";
import { cancelReportExport, createReportExport, reportExportDownload, reportExportStatus } from "../api/reportData";
import type { OfficialReportExportRequest, OfficialReportExportStatus } from "../../../backend/src/types/officialReportApi";
import { ApiError } from "../api/client";

export function ReportExportButton({ selectionId, kind, ids, label, disabled = false, autoStart = false, onPendingChange, onSelectionInvalidated }: {
  selectionId?: string; kind: OfficialReportExportRequest["kind"]; ids?: readonly string[]; label: string; disabled?: boolean;
  autoStart?: boolean; onPendingChange?: (pending: boolean) => void; onSelectionInvalidated?: () => void;
}) {
  const [status, setStatus] = useState<OfficialReportExportStatus>();
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  const [checking, setChecking] = useState(false);
  const [owner, setOwner] = useState<string>();
  const context = JSON.stringify([selectionId, kind, ids]);
  const visibleStatus = !disabled && owner === context ? status : undefined, preparing = !disabled && owner === context && pending;
  const controller = useRef<AbortController | undefined>(undefined);
  const job = useRef<string | undefined>(undefined);
  const nativeDownload = useRef<string | undefined>(undefined);
  const invalidationHandler = useRef(onSelectionInvalidated);
  useEffect(() => { invalidationHandler.current = onSelectionInvalidated; }, [onSelectionInvalidated]);
  const invalidated = useCallback(() => {
    setError("Export selection changed or expired. Restart the selection before exporting.");
    invalidationHandler.current?.();
  }, []);
  useEffect(() => {
    if (disabled) controller.current?.abort();
    return () => { controller.current?.abort(); setStatus(undefined); setPending(false); setChecking(false); };
  }, [context, disabled]);
  useEffect(() => { onPendingChange?.(preparing); }, [preparing, onPendingChange]);
  useEffect(() => () => { onPendingChange?.(false); }, [onPendingChange]);
  useEffect(() => {
    if (status?.status !== "ready") return;
    const timer = setTimeout(() => setStatus(value => value?.id === status.id ? { ...value, status: "expired" } : value),
      Math.max(0, Date.parse(status.expiresAt) - Date.now()));
    return () => clearTimeout(timer);
  }, [status]);
  const start = useCallback(async () => {
    const [selectionId, kind, ids] = JSON.parse(context) as [string | null, OfficialReportExportRequest["kind"], string[] | null];
    if (!selectionId) return;
    controller.current?.abort();
    const abort = new AbortController(); controller.current = abort;
    job.current = undefined; nativeDownload.current = undefined; setOwner(context); setChecking(false);
    setPending(true); setStatus(undefined); setError(undefined);
    try {
      const created = await createReportExport({ selectionId, kind, ids: ids ?? undefined }, abort.signal);
      abort.signal.throwIfAborted();
      job.current = created.id;
      let interval = 2000;
      for (;;) {
        await new Promise<void>((resolve, reject) => {
          const stop = () => { clearTimeout(timer); reject(abort.signal.reason); };
          const timer = setTimeout(() => { abort.signal.removeEventListener("abort", stop); resolve(); }, interval);
          abort.signal.addEventListener("abort", stop, { once: true });
        });
        const next = await reportExportStatus(created.id, abort.signal);
        if (abort.signal.aborted) return;
        setStatus(next);
        if (next.status === "failed" && next.error === "selection_invalidated") invalidated();
        if (!["queued", "building"].includes(next.status)) break;
        interval = Math.min(interval + 1000, 10000);
      }
    } catch (cause) {
      if (!abort.signal.aborted) {
        if (cause instanceof ApiError && cause.code === "selection_invalidated") invalidated();
        else setError(cause instanceof Error ? cause.message : "The export could not be created.");
      }
    } finally { if (controller.current === abort) setPending(false); }
  }, [context, invalidated]);
  useEffect(() => {
    let abandoned = false;
    if (autoStart && !disabled) void Promise.resolve().then(() => { if (!abandoned) void start(); });
    return () => { abandoned = true; };
  }, [start, autoStart, disabled]);
  async function cancel() {
    const id = job.current;
    controller.current?.abort();
    const cancelled = new AbortController();
    controller.current = cancelled;
    if (!id) { setPending(false); setChecking(false); setError("Export request cancelled. Any already-admitted work will expire automatically."); return; }
    try {
      await cancelReportExport(id, cancelled.signal);
      if (controller.current === cancelled) { setStatus(undefined); setError("Export cancelled."); }
    } catch (cause) {
      if (controller.current === cancelled) setError(cause instanceof Error ? cause.message : "Cancellation failed.");
    } finally { if (controller.current === cancelled) { setPending(false); setChecking(false); } }
  }
  async function download(event: MouseEvent<HTMLAnchorElement>) {
    if (visibleStatus && nativeDownload.current === visibleStatus.id) { nativeDownload.current = undefined; return; }
    event.preventDefault();
    if (checking || visibleStatus?.status !== "ready") return;
    const anchor = event.currentTarget, abort = controller.current;
    if (!abort || abort.signal.aborted) return;
    setChecking(true); setError(undefined);
    try {
      const current = await reportExportStatus(visibleStatus.id, abort.signal);
      if (abort.signal.aborted) return;
      setStatus(current);
      if (current.status === "ready" && Date.parse(current.expiresAt) > Date.now() && anchor.isConnected) {
        nativeDownload.current = current.id;
        try { anchor.click(); } finally { nativeDownload.current = undefined; }
      } else if (current.error === "selection_invalidated") {
        invalidated();
      }
    } catch (cause) {
      if (!abort.signal.aborted) {
        setStatus(undefined);
        if (cause instanceof ApiError && cause.code === "selection_invalidated") invalidated();
        else setError(cause instanceof Error ? cause.message : "The export download could not be verified.");
      }
    } finally { if (controller.current === abort) setChecking(false); }
  }
  return <div className="report-export">
    <button type="button" className="secondary" disabled={disabled || !selectionId || preparing || checking} onClick={() => void start()}>{preparing ? "Preparing export..." : label}</button>
    {preparing || visibleStatus?.status === "ready" ? <button type="button" className="secondary" onClick={() => void cancel()}>Cancel export</button> : null}
    {visibleStatus ? <p role="status">{visibleStatus.status}: {visibleStatus.rows.toLocaleString()} rows, {visibleStatus.bytes.toLocaleString()} bytes.
      {visibleStatus.status === "ready" ? <> <a href={reportExportDownload(visibleStatus.id)} aria-disabled={checking}
        onClick={event => void download(event)}>Download CSV</a> {checking ? "Verifying download..." : `Expires ${new Date(visibleStatus.expiresAt).toLocaleTimeString()}.`}</> : null}
      {visibleStatus.status === "failed" ? ` ${visibleStatus.error ?? "Export failed; no partial file is available."}` : null}
      {visibleStatus.status === "expired" ? " Create a new export from a current selection." : null}
    </p> : null}
    {owner === context && error ? <p role="alert">{error}</p> : null}
  </div>;
}
