import { useCallback, useEffect, useLayoutEffect, useRef, useState, type MouseEvent } from "react";
import { cancelReportExport, createReportExport, reportExportDownload, reportExportStatus } from "../api/reportData";
import type { OfficialReportExportRequest, OfficialReportExportStatus } from "../../../backend/src/types/officialReportApi";
import { ApiError } from "../api/client";

export function ReportExportButton({ selectionId, kind, ids, label, disabled = false, autoStart = false, onPendingChange, onSelectionInvalidated, admissionAllowed, preserveOnRefresh = false }: {
  selectionId?: string; kind: OfficialReportExportRequest["kind"]; ids?: readonly string[]; label: string; disabled?: boolean;
  autoStart?: boolean; onPendingChange?: (pending: boolean) => void; onSelectionInvalidated?: (error?: ApiError) => void;
  admissionAllowed?: () => boolean;
  preserveOnRefresh?: boolean;
}) {
  const [status, setStatus] = useState<OfficialReportExportStatus>();
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  const [checking, setChecking] = useState(false);
  const [cancellation, setCancellation] = useState<"pending" | "failed">();
  const [retry, setRetry] = useState<"admission" | "status">();
  const [owner, setOwner] = useState<string>();
  const context = JSON.stringify([preserveOnRefresh ? null : selectionId, kind, ids]);
  const withdrawn = disabled && !preserveOnRefresh;
  const visibleStatus = !withdrawn && owner === context ? status : undefined, preparing = !withdrawn && owner === context && pending;
  const cancelling = !withdrawn && owner === context && cancellation === "pending";
  const cancellationFailed = !withdrawn && owner === context && cancellation === "failed";
  const retrying = !withdrawn && owner === context ? retry : undefined;
  const controller = useRef<AbortController | undefined>(undefined);
  const operation = useRef<"preparing" | "checking" | "cancelling" | undefined>(undefined);
  const attempt = useRef<{ input: OfficialReportExportRequest; id?: string; settled: boolean } | undefined>(undefined);
  const admission = useRef(admissionAllowed);
  useLayoutEffect(() => { admission.current = admissionAllowed; }, [admissionAllowed]);
  const currentSelection = useRef(selectionId);
  useLayoutEffect(() => { currentSelection.current = selectionId; }, [selectionId]);
  const nativeDownload = useRef<string | undefined>(undefined);
  const invalidationHandler = useRef(onSelectionInvalidated);
  useEffect(() => { invalidationHandler.current = onSelectionInvalidated; }, [onSelectionInvalidated]);
  const invalidated = useCallback((error?: ApiError) => {
    const rejectedSelection = attempt.current?.input.selectionId;
    attempt.current = undefined;
    setStatus(undefined);
    setRetry(undefined);
    setError("Export selection changed or expired. Restart the selection before exporting.");
    if (!preserveOnRefresh || rejectedSelection === currentSelection.current) invalidationHandler.current?.(error);
  }, [preserveOnRefresh]);
  useEffect(() => {
    return () => {
      controller.current?.abort();
      controller.current = undefined;
      operation.current = undefined;
      attempt.current = undefined;
      nativeDownload.current = undefined;
      setStatus(undefined); setPending(false); setChecking(false); setCancellation(undefined);
      setOwner(undefined); setError(undefined); setRetry(undefined);
    };
  }, [context, withdrawn]);
  useEffect(() => { onPendingChange?.(preparing || cancelling); }, [preparing, cancelling, onPendingChange]);
  useEffect(() => () => { onPendingChange?.(false); }, [onPendingChange]);
  useEffect(() => {
    if (status?.status !== "ready") return;
    const timer = setTimeout(() => setStatus(value => value?.id === status.id ? { ...value, status: "expired" } : value),
      Math.max(0, Date.parse(status.expiresAt) - Date.now()));
    return () => clearTimeout(timer);
  }, [status]);
  const start = useCallback(async () => {
    const retryAttempt = attempt.current && !attempt.current.settled ? attempt.current : undefined;
    const requestedSelection = retryAttempt?.input.selectionId ?? selectionId;
    if (!requestedSelection || operation.current || withdrawn || !retryAttempt && (disabled || admission.current && !admission.current())) return;
    operation.current = "preparing";
    controller.current?.abort();
    const abort = new AbortController(); controller.current = abort;
    const request = retryAttempt ?? {
      input: { selectionId: requestedSelection, kind, ids: ids?.slice(), idempotencyKey: crypto.randomUUID() }, settled: false,
    };
    attempt.current = request;
    nativeDownload.current = undefined; setOwner(context); setChecking(false);
    setPending(true); setStatus(undefined); setError(undefined); setCancellation(undefined); setRetry(undefined);
    try {
      const id = request.id ?? (await createReportExport(request.input, abort.signal)).id;
      abort.signal.throwIfAborted();
      request.id = id;
      let interval = 2000;
      for (;;) {
        await new Promise<void>((resolve, reject) => {
          const stop = () => { clearTimeout(timer); reject(abort.signal.reason); };
          const timer = setTimeout(() => { abort.signal.removeEventListener("abort", stop); resolve(); }, interval);
          abort.signal.addEventListener("abort", stop, { once: true });
        });
        const next = await reportExportStatus(id, abort.signal);
        if (abort.signal.aborted) return;
        setStatus(next);
        if (next.status === "failed" && next.error === "selection_invalidated") invalidated();
        if (!["queued", "building"].includes(next.status)) { request.settled = true; break; }
        interval = Math.min(interval + 1000, 10000);
      }
    } catch (cause) {
      if (!abort.signal.aborted) {
        if (cause instanceof ApiError && ["selection_invalidated", "export_selection_changed"].includes(cause.code)) invalidated(cause);
        else {
          setStatus(undefined);
          request.settled = exportUnavailable(cause);
          setRetry(request.settled ? undefined : request.id ? "status" : "admission");
          setError(cause instanceof Error ? cause.message : "The export could not be created.");
        }
      }
    } finally {
      if (controller.current === abort) { operation.current = undefined; setPending(false); }
    }
  }, [context, disabled, withdrawn, selectionId, kind, ids, invalidated]);
  useEffect(() => {
    let abandoned = false;
    if (autoStart && !disabled) void Promise.resolve().then(() => { if (!abandoned) void start(); });
    return () => { abandoned = true; };
  }, [start, autoStart, disabled]);
  async function cancel() {
    if (withdrawn || operation.current === "cancelling") return;
    operation.current = "cancelling";
    const id = attempt.current?.id;
    controller.current?.abort();
    const cancelled = new AbortController();
    controller.current = cancelled;
    setCancellation("pending"); setError(undefined);
    try {
      if (id) await cancelReportExport(id, cancelled.signal);
      if (controller.current === cancelled && !cancelled.signal.aborted) {
        attempt.current = undefined;
        setStatus(undefined); setCancellation(undefined); setRetry(undefined);
        setError(id ? "Export cancelled." : "Export request cancelled. Any already-admitted work will expire automatically.");
      }
    } catch (cause) {
      if (controller.current === cancelled && !cancelled.signal.aborted) {
        if (cause instanceof ApiError && cause.code === "selection_invalidated") {
          setStatus(undefined); setCancellation(undefined);
          invalidated(cause);
        } else if (exportUnavailable(cause)) {
          attempt.current = undefined;
          setStatus(undefined); setCancellation(undefined); setRetry(undefined);
          setError(cause.message);
        } else {
          if (attempt.current) attempt.current.settled = false;
          setStatus(undefined); setRetry("status");
          setCancellation("failed");
          setError(cause instanceof Error ? cause.message : "Cancellation failed.");
        }
      }
    } finally {
      if (controller.current === cancelled) { operation.current = undefined; setPending(false); setChecking(false); }
    }
  }
  async function download(event: MouseEvent<HTMLAnchorElement>) {
    if (visibleStatus && nativeDownload.current === visibleStatus.id) { nativeDownload.current = undefined; return; }
    event.preventDefault();
    if (operation.current || visibleStatus?.status !== "ready") return;
    const anchor = event.currentTarget, abort = controller.current;
    if (!abort || abort.signal.aborted) return;
    operation.current = "checking";
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
        if (cause instanceof ApiError && cause.code === "selection_invalidated") invalidated(cause);
        else {
          if (attempt.current) attempt.current.settled = exportUnavailable(cause);
          setRetry(exportUnavailable(cause) ? undefined : "status");
          setError(cause instanceof Error ? cause.message : "The export download could not be verified.");
        }
      }
    } finally { if (controller.current === abort) { operation.current = undefined; setChecking(false); } }
  }
  return <div className="report-export">
    <button type="button" className="secondary" disabled={withdrawn || preparing || checking || cancelling
      || !retrying && (disabled || !selectionId || Boolean(admissionAllowed && !admissionAllowed()))} onClick={() => void start()}>{preparing && !cancelling ? "Preparing export..." : retrying === "status" ? "Retry export status" : retrying === "admission" ? "Retry export request" : label}</button>
    {preparing || cancelling || cancellationFailed || retrying || visibleStatus?.status === "ready" ? <button type="button" className="secondary"
      disabled={cancelling} onClick={() => void cancel()}>{cancelling ? "Cancelling export..." : "Cancel export"}</button> : null}
    {visibleStatus ? <p role="status">{visibleStatus.status}: {visibleStatus.rows.toLocaleString()} rows, {visibleStatus.bytes.toLocaleString()} bytes.
      {visibleStatus.status === "ready" && !cancelling ? <> <a href={reportExportDownload(visibleStatus.id)} aria-disabled={checking}
        onClick={event => void download(event)}>Download CSV</a> {checking ? "Verifying download..." : `Expires ${new Date(visibleStatus.expiresAt).toLocaleTimeString()}.`}</> : null}
      {visibleStatus.status === "failed" ? ` ${visibleStatus.error ?? "Export failed; no partial file is available."}` : null}
      {visibleStatus.status === "expired" ? " Create a new export from a current selection." : null}
    </p> : null}
    {!withdrawn && owner === context && error ? <p role="alert">{error}</p> : null}
  </div>;
}

function exportUnavailable(cause: unknown): cause is ApiError {
  return cause instanceof ApiError && ["export_not_found", "export_expired"].includes(cause.code);
}
