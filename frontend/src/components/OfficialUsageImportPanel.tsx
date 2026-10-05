import { useCallback, useContext, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type Ref } from "react";
import { CheckCircle2, FileText, LoaderCircle, Upload, XCircle } from "lucide-react";
import type { OfficialReportPreview, OfficialReportBundlePreview, OfficialReportAccepted,
  OfficialReportBundleAcceptance, OfficialReportConfirmation } from "../../../backend/src/types/officialReportApi";
import type { ReportAgent, ReportPage } from "../../../backend/src/types/officialReportData";
import { acceptReportBundle, confirmReportOperation, discardReportStage, previewReportBundle, previewReportOperation,
  readReportStage, stageReport, reportPages, type ReportUploadMetadata } from "../api/reportData";
import { ApiError } from "../api/client";
import { CapabilityContext } from "../capabilityContext";
import { hasRole } from "../authorization";
import { useReportPrincipalScope } from "../useReportPage";
import { usageCount } from "../usageInsights";
import { companionMetadata, kindLabel } from "./officialUsageImportPresentation";
import "./officialUsage.css";

export type OfficialUsageImportHandle = { dismiss: () => void };
type Props = { ref?: Ref<OfficialUsageImportHandle>; initialStagingId?: string; initialBundleId?: string; correctionOfSetId?: string;
  onChanged: () => void; onDone: (setId: string) => void; onCancel: () => void; onStaged?: (stagingId?: string) => void };
type CheckedFile = { name: string; size: number; preview?: OfficialReportPreview; error?: string };
type Recovery = "resume" | "bundle" | "acceptance" | "verify" | "fresh";
type Busy = "uploading" | "resuming" | "accepting" | "verifying" | "discarding" | "selecting";
type Verified = Pick<ReportPage<ReportAgent>, "reports" | "summary">;
const kinds = ["agents", "userAgents", "users"] as const;

export function OfficialUsageImportPanel(props: Props) {
  const capability = useContext(CapabilityContext), principal = useReportPrincipalScope();
  if (capability && !hasRole(capability.user, "AgentControl.Admin")) return <section className="official-usage-import" aria-label="Import CSV reports">
    <div className="usage-import-body"><p role="alert">Current Admin access is required to import reports.</p></div>
    <footer className="usage-import-footer"><button type="button" onClick={props.onCancel}>Back to Sync</button></footer></section>;
  return <ImportFlow key={JSON.stringify([principal, props.initialStagingId, props.initialBundleId, props.correctionOfSetId])} {...props} />;
}
function ImportFlow({ ref, initialStagingId, initialBundleId, correctionOfSetId, onChanged, onDone, onCancel, onStaged }: Props) {
  const [files, setFiles] = useState<CheckedFile[]>([]), [bundle, setBundle] = useState<OfficialReportBundlePreview>();
  const [accepted, setAccepted] = useState<OfficialReportAccepted>(), [verified, setVerified] = useState<Verified>();
  const [attempt, setAttempt] = useState<{ bundleId: string; input: OfficialReportBundleAcceptance }>();
  const [selection, setSelection] = useState<OfficialReportConfirmation>();
  const [busy, setBusy] = useState<Busy>(), [error, setError] = useState<string>(), [recovery, setRecovery] = useState<Recovery>();
  const [metadata, setMetadata] = useState<ReportUploadMetadata>({});
  const [dragging, setDragging] = useState(false);
  const [cancelConfirm, setCancelConfirm] = useState(false), [denied, setDenied] = useState(false);
  const [correction, setCorrection] = useState(correctionOfSetId);
  const [initialId] = useState(() => initialBundleId ?? crypto.randomUUID());
  const id = useRef(initialId), receipts = useRef(new Map<string, OfficialReportPreview>()), notified = useRef(false);
  const lifetime = useRef<AbortController | undefined>(undefined), operation = useRef<AbortController | undefined>(undefined);
  const work = useRef<Promise<void> | undefined>(undefined), picker = useRef<HTMLInputElement>(null);
  const successTitle = useRef<HTMLHeadingElement>(null), previouslyReady = useRef(false);
  const reviewTitle = useRef<HTMLHeadingElement>(null);
  const readyToImport = Boolean(bundle?.complete && !busy && !accepted && !attempt && !recovery && !cancelConfirm);
  useEffect(() => { if (readyToImport) reviewTitle.current?.focus(); }, [readyToImport]);
  const cancelPrompt = useRef<HTMLElement>(null);
  useEffect(() => { if (cancelConfirm) cancelPrompt.current?.focus(); }, [cancelConfirm]);
  const readyToFinish = Boolean(verified && accepted && verified.reports.activeSetId === accepted.setId && !error);
  useEffect(() => {
    if (readyToFinish && !previouslyReady.current) successTitle.current?.focus();
    previouslyReady.current = readyToFinish;
  }, [readyToFinish]);
  useLayoutEffect(() => {
    const current = new AbortController(); lifetime.current = current;
    return () => { current.abort(); operation.current?.abort(); };
  }, []);
  const failed = useCallback((cause: unknown, next?: Recovery, prefix = "") => {
    if (cause instanceof ApiError && [401, 403].includes(cause.status)) {
      setDenied(true); setFiles([]); setBundle(undefined); setAccepted(undefined); setVerified(undefined); setAttempt(undefined);
      setSelection(undefined); setMetadata({}); receipts.current.clear(); setRecovery(undefined);
    } else if (cause instanceof ApiError && cause.code === "staging_unavailable") {
      setFiles([]); setBundle(undefined); setAttempt(undefined); setMetadata({});
      receipts.current.clear(); setRecovery("fresh");
    } else setRecovery(next);
    setError(`${prefix}${cause instanceof Error ? cause.message : "The import could not be verified."}`);
  }, []);
  const begin = useCallback((kind: Busy, action: (signal: AbortSignal) => Promise<void>, failure: (cause: unknown) => void) => {
    const life = lifetime.current;
    if (!life || life.signal.aborted) return Promise.resolve();
    operation.current?.abort();
    const current = new AbortController(); operation.current = current;
    setBusy(kind); setError(undefined);
    const pending = (async () => {
      try { await action(current.signal); }
      catch (cause) { if (!life.signal.aborted && !current.signal.aborted) failure(cause); }
      finally { if (!life.signal.aborted && operation.current === current) setBusy(undefined); }
    })();
    work.current = pending;
    return pending;
  }, []);
  const remember = useCallback((row: OfficialReportPreview) => {
    if (row.bundleId !== id.current || !receipts.current.has(row.id) && receipts.current.size >= 3
      || [...receipts.current.values()].some(previous => previous.kind === row.kind && previous.id !== row.id)) {
      throw new Error("The returned staging receipt does not belong to this bounded bundle.");
    }
    receipts.current.set(row.id, row);
  }, []);
  const checkedBundle = useCallback((value: OfficialReportBundlePreview) => {
    if (value.bundleId !== id.current || value.stages.length > 3 || new Set(value.stages.map(stage => stage.kind)).size !== value.stages.length
      || value.complete !== kinds.every(kind => value.stages.some(stage => stage.kind === kind))) throw new Error("The returned bundle does not contain a consistent set of companion kinds.");
    return value;
  }, []);
  async function refreshBundle(signal: AbortSignal) {
    const preview = checkedBundle(await previewReportBundle(id.current, signal));
    signal.throwIfAborted(); setBundle(preview); setRecovery(undefined);
    if (preview.stages[0]) onStaged?.(preview.stages[0].stagingId);
    return preview;
  }
  const restore = useCallback(() => {
    return begin("resuming", async signal => {
      let first: OfficialReportPreview | undefined;
      if (initialStagingId) {
        first = await readReportStage(initialStagingId, signal); signal.throwIfAborted();
        id.current = first.bundleId; remember(first);
        setFiles([{ name: kindLabel(first.kind), size: first.wireBytes, preview: first }]);
        setMetadata(companionMetadata(first)); setCorrection(first.correctionOfSetId ?? undefined);
      }
      const preview = checkedBundle(await previewReportBundle(id.current, signal)); signal.throwIfAborted();
      receipts.current.clear();
      const rows: CheckedFile[] = [];
      for (const stage of preview.stages) {
        const row = first?.id === stage.stagingId ? first : await readReportStage(stage.stagingId, signal);
        signal.throwIfAborted(); remember(row); rows.push({ name: kindLabel(row.kind), size: row.wireBytes, preview: row });
      }
      setFiles(rows); setBundle(preview); setRecovery(undefined);
      setMetadata(companionMetadata(first ?? rows[0]?.preview)); setCorrection((first ?? rows[0]?.preview)?.correctionOfSetId ?? correctionOfSetId);
    }, cause => failed(cause, "resume"));
  }, [begin, checkedBundle, correctionOfSetId, failed, initialStagingId, remember]);
  useEffect(() => {
    if (initialStagingId || initialBundleId) void restore();
  }, [initialStagingId, initialBundleId, restore]);
  function upload(selected: FileList | File[]) {
    if (busy || denied || cancelConfirm || attempt || accepted || recovery === "resume" || recovery === "fresh") return;
    if (!selected.length || selected.length + receipts.current.size > 3) {
      setError("Select the remaining companion CSVs, at most three files per report set."); return;
    }
    const next = Array.from(selected);
    const invalid = next.find(file => !file.size || file.size > 268435456 || !/\.csv$/i.test(file.name));
    if (invalid) {
      setError(`${invalid.name}: ${!invalid.size ? "This file is empty." : invalid.size > 268435456 ? "This file exceeds the 256 MiB limit." : "Choose a CSV file."}`); return;
    }
    setFiles(rows => rows.filter(row => row.preview)); setRecovery(undefined);
    return begin("uploading", async signal => {
      let rejected: unknown;
      for (const file of next) {
        setFiles(rows => [...rows.filter(row => row.preview), { name: file.name, size: file.size }]);
        try {
          const row = await stageReport(file, { bundleId: id.current, correctionOfSetId: correction, rejectDuplicateKind: true }, metadata, signal);
          remember(row);
          signal.throwIfAborted();
          setFiles(rows => [...rows.filter(row => row.preview), { name: file.name, size: file.size, preview: row }]);
        } catch (cause) {
          signal.throwIfAborted();
          if (cause instanceof ApiError && [401, 403].includes(cause.status)) throw cause;
          const message = `${file.name}: ${cause instanceof Error ? cause.message : "CSV validation failed."}`;
          setFiles(rows => [...rows.filter(row => row.preview), { name: file.name, size: file.size, error: message }]);
          rejected = cause instanceof ApiError ? new ApiError(cause.status, cause.code, message) : new Error(message);
          break;
        }
      }
      if (receipts.current.size) {
        try { await refreshBundle(signal); } catch (cause) { if (!rejected) throw cause; }
      }
      signal.throwIfAborted();
      if (rejected) throw rejected;
    }, cause => failed(cause, receipts.current.size ? "bundle" : undefined));
  }
  async function inspect(receipt: OfficialReportAccepted, signal: AbortSignal, finish = false) {
    const data = await reportPages.agents({ setId: receipt.setId, limit: 1 }, signal); signal.throwIfAborted();
    if (!receipt.complete || data.reports.setId !== receipt.setId || data.reports.lineages.length !== 3
      || !kinds.every(kind => data.reports.lineages.some(lineage => lineage.kind === kind))) {
      throw new Error("The complete accepted report set could not be verified. No current-report substitute is allowed.");
    }
    setVerified({ reports: data.reports, summary: data.summary }); setRecovery(undefined); setError(undefined);
    if (!notified.current) { notified.current = true; onChanged(); }
    if (finish) {
      if (data.reports.activeSetId !== receipt.setId) setError("The shared report selection changed. Confirm use of the imported report before continuing.");
      else onDone(receipt.setId);
    }
  }
  function accept() {
    if (busy || denied || cancelConfirm || !bundle?.complete && !attempt) return;
    const admitted = attempt ?? { bundleId: bundle!.bundleId,
      input: Object.freeze({ bundleHash: bundle!.bundleHash, expectedActiveRevision: bundle!.expectedActiveRevision }) };
    setAttempt(admitted); setRecovery(undefined);
    return begin("accepting", async signal => {
      const receipt = await acceptReportBundle(admitted.bundleId, admitted.input, signal); signal.throwIfAborted();
      setAccepted(receipt);
      for (const [key, value] of receipts.current) receipts.current.set(key, { ...value, status: "accepted" });
      try { await inspect(receipt, signal); }
      catch (cause) {
        signal.throwIfAborted(); setVerified(undefined); failed(cause, "verify", "Your reports were saved. ");
      }
    }, cause => {
      if (cause instanceof ApiError && [400, 404, 409, 410, 413, 422, 429].includes(cause.status)) {
        setAttempt(undefined); setBundle(undefined);
        failed(cause, cause.code === "deleted_report_duplicate" ? "fresh" : "bundle");
      } else failed(cause, "acceptance", "Acceptance may already have completed. ");
    });
  }
  function verify(finish = false) {
    if (!accepted || busy || denied) return;
    const receipt = accepted;
    setVerified(undefined); setSelection(undefined);
    return begin("verifying", signal => inspect(receipt, signal, finish), cause => failed(cause, "verify", "Your reports were saved. "));
  }
  function prepareImportedSelection() {
    if (!accepted || !verified || busy || denied) return;
    const expected = verified.reports, receipt = accepted;
    return begin("selecting", async signal => {
      const next = await previewReportOperation(receipt.setId, "select", signal); signal.throwIfAborted();
      if (next.setId !== receipt.setId || next.operation !== "select" || next.activeRevision !== expected.activeRevision
        || next.historyRevision !== expected.historyRevision || next.historyEpoch !== expected.historyEpoch) {
        throw new Error("The shared report selection changed. Verify the saved import before preparing a new confirmation.");
      }
      setSelection(next);
    }, cause => failed(cause, "verify"));
  }
  function confirmSelection() {
    if (!accepted || !selection || busy || denied) return;
    const confirmation = selection, receipt = accepted;
    setSelection(undefined);
    return begin("selecting", async signal => {
      await confirmReportOperation(confirmation, signal); signal.throwIfAborted(); await inspect(receipt, signal);
    }, cause => { setVerified(undefined); failed(cause, "verify", "Selection may already have changed. Verify its outcome; do not replay this confirmation. "); });
  }
  function dismiss() {
    if (accepted && busy) return;
    if (busy === "accepting" || attempt && !accepted && !denied) {
      setError("Acceptance may already have completed. Verify its outcome before discarding staged files."); return;
    }
    if (accepted && verified) {
      if (verified.reports.activeSetId === accepted.setId) void verify(true);
      else onCancel();
      return;
    }
    if (!accepted && (receipts.current.size || busy)) setCancelConfirm(true); else onCancel();
  }
  useImperativeHandle(ref, () => ({ dismiss }));
  function discard() {
    if (busy === "accepting" || attempt && !accepted || denied) return;
    const pending = work.current;
    operation.current?.abort();
    setBundle(undefined);
    return begin("discarding", async signal => {
      await pending; signal.throwIfAborted();
      const current = checkedBundle(await previewReportBundle(id.current, signal)); signal.throwIfAborted();
      for (const stage of current.stages) {
        const receipt = await readReportStage(stage.stagingId, signal); signal.throwIfAborted();
        if (receipt.bundleId !== id.current) throw new Error("Cancellation receipt belongs to another bundle.");
        if (receipt.status !== "accepted") await discardReportStage(receipt.id, signal);
        signal.throwIfAborted(); receipts.current.delete(receipt.id);
        setFiles(rows => rows.filter(row => row.preview?.id !== receipt.id));
      }
      receipts.current.clear();
      onCancel();
    }, cause => failed(cause));
  }
  const present = files.filter(file => file.preview), missing = kinds.filter(kind => !present.some(file => file.preview?.kind === kind));
  const selected = Boolean(verified && accepted && verified.reports.activeSetId === accepted.setId);
  const summary = verified && selected && !error;
  const canChoose = !accepted && !attempt && recovery !== "resume" && recovery !== "fresh" && missing.length > 0;
  const status = busy === "uploading" ? "Checking CSV files..."
    : busy === "resuming" ? "Loading your reports..."
      : busy === "accepting" ? "Importing reports..."
        : busy === "discarding" ? "Cancelling import..."
          : busy ? "Verifying import..." : undefined;
  if (denied) return <section className="official-usage-import" aria-label="Import CSV reports">
    <div className="usage-import-body"><p role="alert">{error}</p></div>
    <footer className="usage-import-footer"><button type="button" onClick={onCancel}>Back to Sync</button></footer></section>;
  return <section className="official-usage-import" aria-label="Import CSV reports" aria-busy={Boolean(busy)}>
    <div className="usage-import-body">
    {summary ? <div className="usage-import-success"><CheckCircle2 size={44} aria-hidden="true" /><h3 ref={successTitle} tabIndex={-1}>Reports imported</h3><p role="status">Your report set is ready in Agents.</p><section aria-label="Imported CSV summary"><dl className="usage-import-statistics">
      <div><dt>Agents</dt><dd>{usageCount(verified.reports.lineages.find(lineage => lineage.kind === "agents")?.rowCount)}</dd></div>
      <div><dt>Users</dt><dd>{usageCount(verified.reports.lineages.find(lineage => lineage.kind === "users")?.rowCount)}</dd></div>
      <div><dt>Responses</dt><dd>{usageCount(verified.summary.reportedResponses)}</dd></div></dl></section>
      </div> : <>
      {error ? <div className="report-status error" role="alert"><h3>{accepted ? "Reports saved" : "Import needs attention"}</h3><p>{error}</p>
        {recovery === "fresh" ? <p>Cancel this import and add the three CSV files again.</p> : null}</div> : null}
      {status ? <p className="usage-import-progress" role="status"><LoaderCircle size={20} aria-hidden="true" />{status}</p> : null}
      {bundle && !accepted && !busy && !recovery ? <section aria-label="Confirm report import">
        <h3 ref={reviewTitle} tabIndex={-1}>{bundle.complete ? "Ready to import" : "Add the remaining reports"}</h3>
        <p className="usage-import-hint">{bundle.complete ? "All three reports are ready to add." : `Still needed: ${missing.map(kindLabel).join(", ")}.`}</p>
      </section> : null}
      {files.length && !accepted ? <ul className="usage-upload-files" aria-label="Selected CSV files">{files.map(file => <li key={file.preview?.id ?? file.name}
        data-status={file.preview ? "validated" : file.error ? "rejected" : "validating"}>
        {file.preview ? <CheckCircle2 size={20} aria-hidden="true" /> : file.error ? <XCircle size={20} aria-hidden="true" /> : <FileText size={20} aria-hidden="true" />}
        <div><strong>{file.name}</strong><span>{file.preview
          ? `${kindLabel(file.preview.kind)} - ${file.preview.rowCount.toLocaleString()} ${file.preview.rowCount === 1 ? "row" : "rows"}`
          : file.error ? "Could not import" : "Checking..."}</span></div>
      </li>)}</ul> : null}
      {correction && !accepted ? <p className="usage-context-warning" role="status">This import replaces the saved report and invalidates its existing history and exports.</p> : null}
      {canChoose ? <>
        <div className={`usage-upload-zone${dragging ? " is-dragging" : ""}`}
          onDragOver={event => { event.preventDefault(); if (!busy && !cancelConfirm) setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={event => { event.preventDefault(); setDragging(false); void upload(event.dataTransfer.files); }}>
          <Upload size={28} aria-hidden="true" />
          <strong>{present.length ? "Add the remaining reports" : "Drop your three CSV exports here"}</strong>
          <span>Agents, Users &amp; agents, and Users</span>
          <input ref={picker} type="file" accept=".csv,text/csv" multiple hidden disabled={Boolean(busy || cancelConfirm)}
            aria-label="CSV report files" onChange={event => { if (event.target.files) void upload(event.target.files); event.target.value = ""; }} />
          <button type="button" disabled={Boolean(busy || cancelConfirm)} onClick={() => picker.current?.click()}>Choose CSV files</button>
          <small>CSV files, up to 256 MiB each</small>
        </div>
        <p className="usage-import-hint">Use the same Microsoft 365 reporting period for all three files.</p>
        <a className="usage-export-help" href="https://learn.microsoft.com/en-us/microsoft-365/admin/activity-reports/microsoft-365-copilot-agents-new?view=o365-worldwide"
          target="_blank" rel="noreferrer">How to download official CSV reports</a>
      </> : null}
      {verified && accepted && !selected ? <><p>The imported report is saved, but another report is currently selected.</p>
        <button type="button" disabled={Boolean(busy)} onClick={() => void prepareImportedSelection()}>Use imported reports</button></> : null}
      {selection ? <section className="usage-import-section" aria-label="Confirm imported report selection"><p>This changes the shared current report to {selection.setId}, not existing pinned pages.</p>
        <button type="button" disabled={Boolean(busy)} onClick={() => void confirmSelection()}>Confirm use of imported reports</button>
        <button type="button" disabled={Boolean(busy)} onClick={() => setSelection(undefined)}>Cancel selection</button></section> : null}
      {cancelConfirm ? <section ref={cancelPrompt} tabIndex={-1} className="usage-import-section" role="alertdialog" aria-label="Discard staged import"><p>Discard staged files and cancel the upload? Accepted sets are not deleted.</p>
        <button type="button" disabled={busy === "discarding"} onClick={() => void discard()}>Discard staged import</button>
        <button type="button" disabled={busy === "discarding"} onClick={() => {
          setCancelConfirm(false);
          if (!bundle && present.length) void begin("verifying", async signal => { await refreshBundle(signal); }, cause => failed(cause, "bundle"));
        }}>Continue import</button></section> : null}
    </>}
    </div>
    <footer className="usage-import-footer">
      {summary ? <button type="button" disabled={Boolean(busy)} onClick={() => void verify(true)}>OK</button> : <>
        <button type="button" className="secondary" disabled={cancelConfirm || busy === "accepting" || Boolean(accepted && busy || attempt && !accepted)} onClick={dismiss}>Cancel import</button>
        {recovery === "resume" ? <button type="button" disabled={Boolean(busy) || cancelConfirm} onClick={() => void restore()}>Reload saved draft</button> : null}
        {recovery === "bundle" ? <button type="button" disabled={Boolean(busy) || cancelConfirm} onClick={() => void begin("verifying", async signal => { await refreshBundle(signal); }, cause => failed(cause, "bundle"))}>Refresh bundle validation</button> : null}
        {recovery === "acceptance" ? <button type="button" disabled={Boolean(busy)} onClick={() => void accept()}>Verify acceptance</button> : null}
        {recovery === "verify" ? <button type="button" disabled={Boolean(busy)} onClick={() => void verify()}>Verify saved import</button> : null}
        {bundle?.complete && !accepted && !attempt && !recovery ? <button type="button" disabled={!readyToImport} onClick={() => void accept()}>
          {present.length === 3 && present.every(file => file.preview?.status === "accepted") ? "Verify saved report set" : "Import reports"}</button> : null}
      </>}
    </footer>
  </section>;
}
