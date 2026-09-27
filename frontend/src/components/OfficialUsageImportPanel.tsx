import { useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import { CheckCircle2, FileText, LoaderCircle, Upload, XCircle } from "lucide-react";
import {
  ApiError,
  acceptOfficialUsageBundle,
  confirmOfficialUsageSetOperation,
  discardOfficialUsageStaging,
  getOfficialUsageAdminState,
  getOfficialUsageAggregate,
  previewOfficialUsageBundle,
  previewOfficialUsageSetOperation,
  stageOfficialUsageReport,
  type OfficialUsageBundlePreview,
  type OfficialUsageSetSummary,
  type OfficialUsageStagingPreview,
} from "../api/client";
import { useSavedRead } from "../savedQueries";
import { companionMetadata, errorMessage, kindLabel, type FileValidation } from "./officialUsageImportPresentation";
import { usageDate } from "../usageInsights";
import "./officialUsage.css";

const reportGuideUrl = "https://learn.microsoft.com/en-us/microsoft-365/admin/activity-reports/microsoft-365-copilot-agents-new?view=o365-worldwide";
const reportKinds = ["agents", "userAgents", "users"] as const;
type Phase = "files" | "checking" | "saving" | "verifying" | "complete" | "cancelling";
type Recovery = "validate" | "accept" | "verify" | "select" | "resume" | "cancel";
type Accepted = Awaited<ReturnType<typeof acceptOfficialUsageBundle>>;
type Draft = {
  bundleId: string;
  correctionOfSetId?: string;
  metadata: ReturnType<typeof companionMetadata>;
};

export type OfficialUsageImportHandle = { dismiss: () => void };

export function OfficialUsageImportPanel({
  ref, initialStagingId, initialBundleId, onChanged, onDone, onCancel,
}: {
  ref?: Ref<OfficialUsageImportHandle>;
  initialStagingId?: string;
  initialBundleId?: string;
  onChanged: () => void;
  onDone: (setId: string) => void;
  onCancel: () => void;
}) {
  const [phase, setPhase] = useState<Phase>("files");
  const [files, setFiles] = useState<FileValidation[]>([]);
  const [preview, setPreview] = useState<OfficialUsageBundlePreview>();
  const [accepted, setAccepted] = useState<Accepted>();
  const [report, setReport] = useState<OfficialUsageSetSummary>();
  const [problem, setProblem] = useState<{ text: string; recovery?: Recovery; denied?: boolean }>();
  const [dragging, setDragging] = useState(false);
  const [restored, setRestored] = useState(false);
  const [correcting, setCorrecting] = useState(false);
  const [restoreRevision, setRestoreRevision] = useState(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const pickerButton = useRef<HTMLButtonElement>(null);
  const statusHeading = useRef<HTMLHeadingElement>(null);
  const draft = useRef<Draft | undefined>(undefined);
  const stages = useRef(new Map<string, OfficialUsageStagingPreview>());
  const receipt = useRef<OfficialUsageBundlePreview | undefined>(undefined);
  const saved = useRef<Accepted | undefined>(undefined);
  const recovery = useRef<Recovery>("validate");
  const currentPhase = useRef<Phase>("files");
  const busy = useRef(false);
  const cancelling = useRef(false);
  const pending = useRef<Promise<void> | undefined>(undefined);
  const lifetime = useRef<AbortController | undefined>(undefined);
  const upload = useRef<AbortController | undefined>(undefined);
  const readSaved = useSavedRead();

  function changePhase(next: Phase) {
    currentPhase.current = next;
    setPhase(next);
  }

  function live() {
    return Boolean(lifetime.current && !lifetime.current.signal.aborted);
  }

  function reportFailure(error: unknown) {
    if (!live() || cancelling.current) return;
    const denied = error instanceof ApiError && (error.status === 401 || error.status === 403);
    if (denied) {
      setFiles([]);
      setPreview(undefined);
      setReport(undefined);
      setCorrecting(false);
    }
    const context = saved.current ? "Your reports were saved, but we couldn't open them yet. "
      : receipt.current ? "We couldn't confirm whether the import finished. Retry to check; don't upload the files again. "
        : "";
    setProblem({ text: `${context}${errorMessage(error)}`, recovery: denied ? undefined : recovery.current, denied });
    changePhase("files");
  }

  function run(work: () => Promise<void>) {
    if (busy.current || !live()) return;
    busy.current = true;
    setProblem(undefined);
    const task = work().catch(reportFailure).finally(() => { busy.current = false; });
    pending.current = task;
  }

  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    cancelling.current = false;
    if (initialStagingId || initialBundleId) {
      void Promise.resolve().then(async () => {
        if (controller.signal.aborted) return;
        busy.current = true;
        recovery.current = "resume";
        changePhase("checking");
        try {
          const state = await readSaved(["official-usage-admin"],
            signal => getOfficialUsageAdminState({ signal }), controller.signal);
          if (controller.signal.aborted) return;
          const stage = initialStagingId
            ? state.staging.find(item => item.id === initialStagingId && item.status === "active")
            : undefined;
          const set = initialBundleId
            ? state.sets.find(item => item.bundleId === initialBundleId && !item.complete && !item.deletedAt)
            : undefined;
          if (!stage && !set) throw new Error("This saved import is no longer available. Choose the CSV files to start again.");
          const bundleId = stage?.bundleId ?? set!.bundleId;
          draft.current = { bundleId, correctionOfSetId: stage?.correctionOfSetId ?? set?.supersedesSetId ?? undefined,
            metadata: companionMetadata(undefined, set, stage) };
          const companions = state.staging.filter(item => item.bundleId === bundleId && item.status === "active");
          for (const item of companions) {
            stages.current.set(item.id, item);
          }
          setCorrecting(Boolean(draft.current.correctionOfSetId));
          setRestored(true);
          setFiles(companions.map(item => ({
            file: { name: kindLabel(item.kind), size: 0 }, status: "validated", preview: item,
          })));
          const next = await previewOfficialUsageBundle(bundleId, { signal: controller.signal });
          if (controller.signal.aborted || cancelling.current) return;
          draft.current.metadata = companionMetadata(next, set, stage);
          setPreview(next);
          setFiles(next.staging.map(item => ({
            file: { name: kindLabel(item.kind), size: 0 }, status: "validated", preview: item,
          })));
          changePhase("files");
        } catch (error) {
          if (!controller.signal.aborted) reportFailure(error);
        } finally {
          busy.current = false;
        }
      });
    }
    return () => { controller.abort(); upload.current?.abort(); };
    // A new dialog owns a new import; ordinary opening never resumes server staging.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialStagingId, initialBundleId, readSaved, restoreRevision]);

  useEffect(() => {
    if (phase === "complete" || problem) statusHeading.current?.focus({ preventScroll: true });
  }, [phase, problem]);

  async function verifyImport(allowSelectionChange = false) {
    const result = saved.current;
    if (!result) throw new Error("The import result is unavailable. Retry the import.");
    recovery.current = "verify";
    changePhase("verifying");
    const signal = lifetime.current?.signal;
    const [state, snapshot] = await Promise.all([
      getOfficialUsageAdminState({ signal }),
      getOfficialUsageAggregate({ setId: result.setId, limit: 1, offset: 0 }, { signal }),
    ]);
    if (!live()) return;
    if (!result.complete || snapshot.activeSet?.id !== result.setId || !snapshot.activeSet.complete || snapshot.activeSet.deletedAt) {
      throw new Error("This report set is no longer available. It may have been deleted.");
    }
    if (state.activeSetId !== result.setId) {
      recovery.current = "select";
      if (!allowSelectionChange && state.activeRevision !== result.activeRevision) {
        throw new Error("The report selection changed. Select Use imported reports to view this set in Agents.");
      }
      const selection = await previewOfficialUsageSetOperation(result.setId, "select");
      if (!live()) return;
      if (selection.expectedRevision !== state.activeRevision || selection.activeSetId !== state.activeSetId) {
        throw new Error("The report selection changed. Try again to use your imported reports.");
      }
      await confirmOfficialUsageSetOperation(selection);
      if (!live()) return;
      onChanged();
      const verified = await getOfficialUsageAdminState({ signal });
      if (!live()) return;
      if (verified.activeSetId !== result.setId) {
        throw new Error("The report selection changed. Try again to use your imported reports.");
      }
    }
    setReport(snapshot.activeSet);
    setProblem(undefined);
    changePhase("complete");
  }

  async function publish(next: OfficialUsageBundlePreview) {
    if (!live() || cancelling.current) return;
    receipt.current = next;
    recovery.current = "accept";
    changePhase("saving");
    let result: Accepted;
    try {
      result = await acceptOfficialUsageBundle(next);
    } catch (error) {
      // An uncertain response must replay the same fenced request, not a new preview.
      if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
        receipt.current = undefined;
        recovery.current = "validate";
      }
      throw error;
    }
    if (!live()) return;
    saved.current = result;
    receipt.current = undefined;
    setAccepted(result);
    setFiles([]);
    onChanged();
    await verifyImport();
  }

  async function validateAndImport() {
    if (!draft.current || cancelling.current || !live()) return;
    recovery.current = "validate";
    changePhase("checking");
    const next = await previewOfficialUsageBundle(draft.current.bundleId, { signal: lifetime.current?.signal });
    if (!live() || cancelling.current) return;
    setPreview(next);
    if (next.missingKinds.length) {
      changePhase("files");
      return;
    }
    await publish(next);
  }

  async function uploadFiles(selected: File[]) {
    if (!selected.length) return;
    const kept = files.filter(item => item.status === "validated");
    const available = 3 - kept.length - (preview?.acceptedVersions.length ?? 0);
    if (selected.length > available) {
      setProblem({ text: `Choose ${available === 3 ? "the three CSV exports" : `up to ${available} missing CSV ${available === 1 ? "export" : "exports"}`}, one per report type.` });
      return;
    }
    draft.current ??= { bundleId: crypto.randomUUID(), metadata: {} };
    const current = draft.current;
    const controller = new AbortController();
    upload.current = controller;
    const entries: FileValidation[] = [...kept, ...selected.map(file => ({
      file: { name: file.name, size: file.size }, status: "waiting" as const,
    }))];
    setFiles(entries);
    changePhase("checking");
    recovery.current = "validate";
    for (const [index, file] of selected.entries()) {
      if (!live() || cancelling.current) return;
      const position = kept.length + index;
      entries[position] = { ...entries[position], status: "validating" };
      setFiles([...entries]);
      try {
        if (!file.name.toLowerCase().endsWith(".csv")) throw new Error("Choose a CSV file.");
        if (!file.size) throw new Error("This file is empty. Export the report again.");
        if (file.size > 8 * 1024 * 1024) throw new Error("This file exceeds the 8 MB limit.");
        const stage = await stageOfficialUsageReport(file, {
          bundleId: current.bundleId,
          ...(current.correctionOfSetId ? { correctionOfSetId: current.correctionOfSetId } : {}),
          ...current.metadata, rejectDuplicateKind: true,
        }, { signal: controller.signal });
        stages.current.set(stage.id, stage);
        entries[position] = { file: entries[position].file, status: "validated", preview: stage };
      } catch (error) {
        if (!live() || cancelling.current) return;
        if (error instanceof ApiError && (error.status === 401 || error.status === 403)) throw error;
        entries[position] = { file: entries[position].file, status: "rejected", error: errorMessage(error) };
      }
      if (!live() || cancelling.current) return;
      setFiles([...entries]);
    }
    if (entries.some(item => item.status === "rejected")) {
      changePhase("files");
      return;
    }
    await validateAndImport();
  }

  async function discardDraft() {
    if (!draft.current) return;
    const state = await getOfficialUsageAdminState({ signal: lifetime.current?.signal });
    if (!live()) return;
    const active = [...new Map([
      ...stages.current.values(),
      ...state.staging.filter(item => item.bundleId === draft.current?.bundleId && item.status === "active"),
    ].filter(item => !state.staging.some(known => known.id === item.id && known.status !== "active"))
      .map(item => [item.id, item])).values()];
    const outcomes = await Promise.allSettled(active.map(item => discardOfficialUsageStaging(item.id)));
    if (!live()) return;
    const failed = outcomes.flatMap((outcome, index) => {
      if (outcome.status === "fulfilled") { stages.current.delete(active[index].id); return []; }
      return [{ id: active[index].id, reason: outcome.reason }];
    });
    if (failed.length) {
      const refreshed = await getOfficialUsageAdminState({ signal: lifetime.current?.signal });
      if (failed.some(item => !refreshed.staging.some(stage => stage.id === item.id && stage.status !== "active"))) {
        throw new Error(`Some uploaded files could not be removed. ${errorMessage(failed[0].reason)}`);
      }
    }
    stages.current.clear();
    draft.current = undefined;
  }

  async function cancelImport(restart = false) {
    if (!live() || ["saving", "verifying", "cancelling"].includes(currentPhase.current)) return;
    if (saved.current || receipt.current || problem?.denied) { onCancel(); return; }
    cancelling.current = true;
    changePhase("cancelling");
    upload.current?.abort();
    await pending.current;
    if (!live()) return;
    try {
      await discardDraft();
      if (!live()) return;
      if (!restart) { onCancel(); return; }
      cancelling.current = false;
      setFiles([]);
      setPreview(undefined);
      setProblem(undefined);
      setRestored(false);
      setCorrecting(false);
      changePhase("files");
      requestAnimationFrame(() => pickerButton.current?.focus());
    } catch (error) {
      if (!live()) return;
      setProblem({ text: `The import couldn't be cancelled. ${errorMessage(error)}`, recovery: "cancel" });
      changePhase("files");
    }
  }

  function dismiss() {
    if (phase === "complete" && accepted) finish();
    else void cancelImport();
  }
  useImperativeHandle(ref, () => ({ dismiss }));

  function finish() {
    run(async () => {
      await verifyImport();
      if (live() && saved.current) onDone(saved.current.setId);
    });
  }

  function retry() {
    if (problem?.recovery === "cancel") { void cancelImport(); return; }
    if (problem?.recovery === "resume") {
      setProblem(undefined);
      setRestoreRevision(value => value + 1);
      return;
    }
    run(async () => {
      if (saved.current) await verifyImport(problem?.recovery === "select");
      else if (receipt.current) await publish(receipt.current);
      else if (draft.current) await validateAndImport();
      else throw new Error("Choose the CSV files to start a new import.");
    });
  }

  const working = phase !== "files" && phase !== "complete";
  const uncertain = problem?.recovery === "accept";
  const canChoose = phase === "files" && !accepted && !uncertain && !problem?.denied && problem?.recovery !== "cancel";
  const rejected = files.some(item => item.status === "rejected");
  const present = new Set([
    ...files.flatMap(item => item.preview ? [item.preview.kind] : []),
    ...(preview?.acceptedVersions.map(item => item.kind) ?? []),
  ]);
  const missing = reportKinds.filter(kind => !present.has(kind));
  const pickerLabel = rejected ? "Choose replacement CSVs" : files.length || restored ? "Add CSV files" : "Choose CSV files";
  const status = phase === "checking" ? "Checking CSV files..."
    : phase === "saving" ? "Importing reports..."
      : phase === "verifying" ? "Verifying import..."
        : phase === "cancelling" ? "Cancelling import..." : undefined;

  return <section className="official-usage-import" aria-label="CSV report import" aria-busy={working}>
    <div className="usage-import-body">
      {phase === "complete" ? <div className="usage-import-success">
        <CheckCircle2 size={44} aria-hidden="true" />
        <h3 ref={statusHeading} tabIndex={-1}>{accepted?.reusedExistingSet ? "Reports already imported" : "Reports imported"}</h3>
        <p role="status">{accepted?.reusedExistingSet ? "No duplicate was created. " : ""}Your report set is ready in Agents.</p>
        {report?.reportingPeriod.startDate && report.reportingPeriod.endDate ? <p className="usage-import-dates">
          {report.reportingPeriod.provenance === "activity_range" ? "Observed activity" : "Reporting period"}:{" "}
          {usageDate(report.reportingPeriod.startDate)} to {usageDate(report.reportingPeriod.endDate)}
        </p> : null}
      </div> : <>
        {problem ? <div className="report-status error" role="alert">
          <h3 ref={statusHeading} tabIndex={-1}>{accepted ? "Reports saved" : "Import needs attention"}</h3>
          <p>{problem.text}</p>
        </div> : null}
        {status ? <p className="usage-import-progress" role="status"><LoaderCircle size={20} aria-hidden="true" />{status}</p> : null}
        {files.length ? <ul className="usage-upload-files" aria-label="Selected CSV files">
          {files.map((entry, index) => <li key={`${entry.file.name}-${index}`} data-status={entry.status}>
            {entry.status === "validated" ? <CheckCircle2 size={20} aria-hidden="true" />
              : entry.status === "rejected" ? <XCircle size={20} aria-hidden="true" />
                : <FileText size={20} aria-hidden="true" />}
            <div><strong>{entry.file.name}</strong>
              <span>{entry.status === "validated" && entry.preview
                ? `${kindLabel(entry.preview.kind)} · ${entry.preview.rowCount.toLocaleString()} rows`
                : entry.status === "waiting" ? "Waiting" : entry.status === "validating" ? "Checking..." : "Could not import"}</span>
              {entry.error ? <p role="alert">{entry.error}</p> : null}
            </div>
          </li>)}
        </ul> : null}
        {restored && preview?.acceptedVersions.length ? <p className="usage-import-hint">
          Already saved: {preview.acceptedVersions.map(item => kindLabel(item.kind)).join(", ")}.
        </p> : null}
        {correcting ? <p className="usage-context-warning">
          This saved import replaces an earlier report set. Start over to add a separate report set instead.
        </p> : null}
        {canChoose && missing.length ? <>
          {files.length || restored ? <p className="usage-import-hint">Still needed: {missing.map(kindLabel).join(", ")}.</p> : null}
          <div className={`usage-upload-zone${dragging ? " is-dragging" : ""}`}
            onDragOver={event => { event.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={event => {
              event.preventDefault();
              setDragging(false);
              const selected = [...event.dataTransfer.files];
              run(() => uploadFiles(selected));
            }}>
            <Upload size={28} aria-hidden="true" />
            <strong>{files.length || restored ? "Add the remaining reports" : "Drop your three CSV exports here"}</strong>
            <span>Agents, Users &amp; agents, and Users</span>
            <input ref={fileInput} hidden aria-label="Official usage CSV files" type="file" accept=".csv,text/csv" multiple
              onChange={event => {
                const selected = [...(event.currentTarget.files ?? [])];
                event.currentTarget.value = "";
                run(() => uploadFiles(selected));
              }} />
            <button ref={pickerButton} type="button" onClick={() => fileInput.current?.click()}>{pickerLabel}</button>
            <small>CSV files, up to 8 MB each</small>
          </div>
          <p className="usage-import-hint">Use the same Microsoft 365 reporting period for all three files. Valid reports import automatically and become the selected set in Agents and Users.</p>
          <a className="usage-export-help" href={reportGuideUrl} target="_blank" rel="noreferrer">Where to download these reports</a>
        </> : null}
        {canChoose && !missing.length && rejected ? <p className="usage-import-hint">
          An extra file duplicates a report type. Start over and choose one CSV for each report.
        </p> : null}
      </>}
    </div>
    <footer className="usage-import-footer">
      {phase === "complete" && accepted ? <button type="button" onClick={finish}>OK</button> : <>
        <button type="button" className="secondary" disabled={phase === "saving" || phase === "verifying" || phase === "cancelling"}
          onClick={() => void cancelImport()}>{accepted || uncertain || problem?.denied ? "Back to Sync" : "Cancel"}</button>
        {canChoose && (files.length > 0 || restored) ? <button type="button" className="secondary" onClick={() => void cancelImport(true)}>Start over</button> : null}
        {problem?.recovery ? <button type="button" disabled={working} onClick={retry}>
          {problem.recovery === "select" ? "Use imported reports" : "Retry"}
        </button> : canChoose && restored && !missing.length ? <button type="button" onClick={() => run(validateAndImport)}>Continue import</button> : null}
      </>}
    </footer>
  </section>;
}
