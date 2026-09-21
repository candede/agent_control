import { useCallback, useEffect, useRef, useState } from "react";
import { Check, FileText, RefreshCw, Trash2, Upload } from "lucide-react";
import {
  ApiError,
  acceptOfficialUsageBundle,
  acknowledgeLegacyUsageCleanup,
  confirmOfficialUsageSetOperation,
  discardOfficialUsageStaging,
  getOfficialUsageAdminState,
  previewOfficialUsageBundle,
  previewOfficialUsageSetOperation,
  stageOfficialUsageReport,
  type OfficialUsageAdminState,
  type OfficialUsageBundlePreview,
  type OfficialUsageConfirmation,
} from "../api/client";
import { clearLegacyUsageStorage, hasLegacyUsageStorage } from "../legacyUsageStorage";
import { trapDialogFocus } from "../dialogFocus";
import { useSavedRead } from "../savedQueries";
import { OfficialUsageImportReview } from "./OfficialUsageImportReview";
import { OfficialUsageManageReports } from "./OfficialUsageManageReports";
import {
  acceptedBundleMessage, companionMetadata, errorMessage, formatCoverage, importSteps, kindLabel,
  type FileValidation, type ImportResult, type ImportStep, type ImportView,
} from "./officialUsageImportPresentation";
import "./officialUsage.css";

const reportGuideUrl = "https://learn.microsoft.com/en-us/microsoft-365/admin/activity-reports/microsoft-365-copilot-agents-new?view=o365-worldwide";

export type OfficialUsageImportPanelProps = {
  initialStagingId?: string;
  onChanged: () => void;
  onLegacyCleared?: () => void;
  active?: boolean;
  view?: ImportView;
  onViewChange?: (view: ImportView) => void;
  onViewSnapshot?: (setId: string) => void;
};

export function OfficialUsageImportPanel({
  initialStagingId,
  onChanged,
  onLegacyCleared,
  active = true,
  view = "import",
  onViewChange,
  onViewSnapshot,
}: OfficialUsageImportPanelProps) {
  const [adminState, setAdminState] = useState<OfficialUsageAdminState>();
  const [adminVerified, setAdminVerified] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const [validation, setValidation] = useState<FileValidation[]>([]);
  const [step, setStep] = useState<ImportStep>("files");
  const [correctionMode, setCorrectionMode] = useState(false);
  const [bundlePreview, setBundlePreview] = useState<OfficialUsageBundlePreview>();
  const [draft, setDraft] = useState<{ bundleId: string; correctionOfSetId?: string }>();
  const [previewVerified, setPreviewVerified] = useState(false);
  const [acceptanceRetry, setAcceptanceRetry] = useState<OfficialUsageBundlePreview>();
  const [result, setResult] = useState<ImportResult>();
  const [confirmation, setConfirmation] = useState<OfficialUsageConfirmation>();
  const [busy, setBusy] = useState(false);
  const [validating, setValidating] = useState(false);
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string }>();
  const [legacyPresent, setLegacyPresent] = useState(hasLegacyUsageStorage);
  const readSaved = useSavedRead();
  const fileInput = useRef<HTMLInputElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const pendingBundleId = useRef<string | undefined>(undefined);
  const pendingCorrection = useRef<string | undefined>(undefined);
  const confirmationReturnFocus = useRef<HTMLElement | null>(null);
  const confirmationFocusPending = useRef(false);
  const loadGeneration = useRef(0);
  const lifetime = useRef<AbortController | undefined>(undefined);
  const activeRef = useRef(active);
  const priorScreen = useRef(view === "manage" ? "manage" : `import:${step}`);
  const previews = bundlePreview?.staging ?? [];
  const readAdminState = useCallback((signal: AbortSignal) =>
    readSaved(["official-usage-admin"], readSignal => getOfficialUsageAdminState({ signal: readSignal }), signal),
  [readSaved]);

  useEffect(() => { activeRef.current = active; }, [active]);
  useEffect(() => {
    const screen = view === "manage" ? "manage" : `import:${step}`;
    if (screen === priorScreen.current) return;
    priorScreen.current = screen;
    if (!active) return;
    const frame = requestAnimationFrame(() => {
      if (activeRef.current && heading.current?.isConnected) {
        heading.current.focus({ preventScroll: true });
        heading.current.closest(".usage-wizard-body")?.scrollTo?.({ top: 0 });
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [step, view, active]);

  useEffect(() => {
    if (!active) {
      confirmationFocusPending.current = false;
      confirmationReturnFocus.current = null;
      return;
    }
    if (!confirmationFocusPending.current || confirmation) return;
    const frame = requestAnimationFrame(() => {
      if (!activeRef.current) return;
      const target = confirmationReturnFocus.current;
      const focused = document.activeElement;
      // A delayed mutation may finish after the user has left the confirmation.
      if (!focused || focused === document.body || !focused.isConnected || focused === target) {
        if (target?.isConnected && !target.matches(":disabled")) target.focus();
        else heading.current?.focus({ preventScroll: true });
      }
      confirmationReturnFocus.current = null;
      confirmationFocusPending.current = false;
    });
    return () => cancelAnimationFrame(frame);
  }, [active, adminState, busy, confirmation]);

  function isLive(generation: number) {
    return !lifetime.current?.signal.aborted && generation === loadGeneration.current;
  }

  function applyBundlePreview(preview: OfficialUsageBundlePreview, state?: OfficialUsageAdminState) {
    pendingBundleId.current = preview.bundleId;
    pendingCorrection.current = preview.staging[0]?.correctionOfSetId
      ?? state?.sets.find(reportSet => reportSet.bundleId === preview.bundleId)?.supersedesSetId
      ?? undefined;
    setDraft({ bundleId: preview.bundleId, correctionOfSetId: pendingCorrection.current });
    setBundlePreview(preview);
    setPreviewVerified(!state || preview.expectedActiveRevision === state.activeRevision);
    setCorrectionMode(Boolean(pendingCorrection.current));
  }

  const clearUnauthorized = useCallback((error: unknown) => {
    if (!(error instanceof ApiError) || (error.status !== 401 && error.status !== 403)) return false;
    loadGeneration.current += 1;
    setAdminState(undefined);
    setAdminVerified(false);
    setBundlePreview(undefined);
    setPreviewVerified(false);
    setAcceptanceRetry(undefined);
    confirmationFocusPending.current = activeRef.current && Boolean(confirmationReturnFocus.current);
    setConfirmation(undefined);
    pendingBundleId.current = undefined;
    pendingCorrection.current = undefined;
    setDraft(undefined);
    setFiles([]);
    setValidation([]);
    if (fileInput.current) fileInput.current.value = "";
    setCorrectionMode(false);
    setResult(undefined);
    setStep("files");
    setBusy(false);
    setValidating(false);
    setMessage({ tone: "error", text: errorMessage(error) });
    return true;
  }, []);

  const showError = useCallback((error: unknown) => {
    if (!clearUnauthorized(error)) setMessage({ tone: "error", text: errorMessage(error) });
  }, [clearUnauthorized]);

  useEffect(() => {
    const generation = ++loadGeneration.current;
    const controller = new AbortController();
    lifetime.current = controller;
    void Promise.resolve().then(async () => {
      if (controller.signal.aborted) return;
      setAdminState(undefined);
      setAdminVerified(false);
      setBundlePreview(undefined);
      setPreviewVerified(false);
      setAcceptanceRetry(undefined);
      setConfirmation(undefined);
      confirmationFocusPending.current = false;
      confirmationReturnFocus.current = null;
      setDraft(undefined);
      pendingBundleId.current = undefined;
      pendingCorrection.current = undefined;
      setFiles([]);
      setValidation([]);
      setResult(undefined);
      setCorrectionMode(false);
      setStep("files");
      setMessage(undefined);
      setValidating(false);
      setBusy(true);
      const state = await readAdminState(controller.signal);
      if (controller.signal.aborted || generation !== loadGeneration.current) return;
      setAdminState(state);
      setAdminVerified(true);
      const exactStage = initialStagingId
        ? state.staging.find(stage => stage.id === initialStagingId && stage.status === "active")
        : undefined;
      if (initialStagingId && !exactStage) {
        setMessage({ tone: "error", text: "The exact staging record is expired, deleted, or unavailable to this account." });
        return;
      }
      const bundleId = exactStage?.bundleId ?? state.staging.find(stage => stage.status === "active")?.bundleId;
      if (bundleId) {
        pendingBundleId.current = bundleId;
        pendingCorrection.current = exactStage?.correctionOfSetId
          ?? state.staging.find(stage => stage.bundleId === bundleId)?.correctionOfSetId ?? undefined;
        setDraft({ bundleId, correctionOfSetId: pendingCorrection.current });
        setCorrectionMode(Boolean(pendingCorrection.current));
        setStep("validation");
        const preview = await previewOfficialUsageBundle(bundleId, { signal: controller.signal });
        if (!controller.signal.aborted && generation === loadGeneration.current) applyBundlePreview(preview, state);
      }
    }).catch(error => {
      if (!controller.signal.aborted && generation === loadGeneration.current) showError(error);
    }).finally(() => {
      if (!controller.signal.aborted && generation === loadGeneration.current) setBusy(false);
    });
    return () => {
      controller.abort();
      loadGeneration.current += 1;
    };
  }, [initialStagingId, readAdminState, showError]);

  async function refresh(preferredBundleId: string | null | undefined = pendingBundleId.current) {
    const signal = lifetime.current?.signal;
    const generation = ++loadGeneration.current;
    setBusy(true);
    setAdminVerified(false);
    setPreviewVerified(false);
    if (result) setResult({ ...result, verifiedState: undefined, refreshError: undefined });
    try {
      if (!signal) return;
      // Explicit refresh/readback must not join metadata fetched before a mutation.
      const state = await getOfficialUsageAdminState({ signal });
      if (!isLive(generation)) return;
      setAdminState(state);
      setAdminVerified(true);
      if (result) {
        setResult({ ...result, verifiedState: state, refreshError: undefined });
        setMessage(undefined);
        return state;
      }
      if (acceptanceRetry) {
        setMessage({ tone: "error", text: "Report metadata was refreshed, but the acceptance response remains unconfirmed. Retry the same acceptance request to recover its original result." });
        return state;
      }
      const retained = state.staging.some(stage => stage.status === "active" && stage.bundleId === preferredBundleId)
        || state.sets.some(reportSet => !reportSet.deletedAt && reportSet.bundleId === preferredBundleId);
      if (preferredBundleId && retained) {
        const preview = await previewOfficialUsageBundle(preferredBundleId, { signal });
        if (!isLive(generation)) return;
        applyBundlePreview(preview, state);
        setAcceptanceRetry(undefined);
        setStep("validation");
        setMessage(undefined);
      } else if (preferredBundleId) {
        pendingBundleId.current = undefined;
        pendingCorrection.current = undefined;
        setDraft(undefined);
        setBundlePreview(undefined);
        setCorrectionMode(false);
        setMessage({ tone: "error", text: "The staged bundle is no longer available. It may have expired or been discarded. Choose the CSV files to import again." });
        setStep("files");
      }
      return state;
    } catch (error) {
      if (!isLive(generation)) return;
      if (clearUnauthorized(error)) return;
      if (result) setResult({ ...result, verifiedState: undefined, refreshError: errorMessage(error) });
      else showError(error);
    } finally {
      if (isLive(generation)) setBusy(false);
    }
  }

  function chooseFiles(next: File[]) {
    setFiles(next);
    setPreviewVerified(false);
    setAcceptanceRetry(undefined);
    setValidation([]);
    setMessage(undefined);
  }

  async function stageFiles() {
    if (busy || !files.length || !adminState || !adminVerified) return;
    const signal = lifetime.current?.signal;
    const generation = ++loadGeneration.current;
    const reportSet = adminState.sets.find(value => value.bundleId === pendingBundleId.current);
    const bundleId = pendingBundleId.current ?? crypto.randomUUID();
    const correctionOfSetId = pendingBundleId.current ? pendingCorrection.current
      : correctionMode ? adminState.activeSetId ?? undefined : undefined;
    const metadata = companionMetadata(bundlePreview, reportSet, adminState.staging.find(stage => stage.bundleId === bundleId && stage.status === "active"));
    const entries: FileValidation[] = files.map(file => ({ file: { name: file.name, size: file.size }, status: "waiting" }));
    const stagedKinds = new Set<string>();
    const rejectedFiles: File[] = [];
    const failures: string[] = [];
    let reviewed: OfficialUsageBundlePreview | undefined;
    setStep("validation");
    setBusy(true);
    setValidating(true);
    setPreviewVerified(false);
    setResult(undefined);
    setAcceptanceRetry(undefined);
    setMessage(undefined);
    setValidation([...entries]);
    for (const [index, file] of files.entries()) {
      const label = { name: file.name, size: file.size };
      entries[index] = { file: label, status: "validating" };
      setValidation([...entries]);
      try {
        const preview = await stageOfficialUsageReport(file, { bundleId, correctionOfSetId, ...metadata });
        if (!isLive(generation)) return;
        pendingBundleId.current = bundleId;
        pendingCorrection.current = correctionOfSetId;
        setDraft({ bundleId, correctionOfSetId });
        entries[index] = { file: label, status: "validated", preview };
        stagedKinds.add(preview.kind);
      } catch (error) {
        if (!isLive(generation) || clearUnauthorized(error)) return;
        rejectedFiles.push(file);
        entries[index] = { file: label, status: "rejected", error: errorMessage(error) };
      }
      setValidation([...entries]);
    }
    setFiles(rejectedFiles);
    if (fileInput.current) fileInput.current.value = "";
    if (pendingBundleId.current) {
      try {
        const preview = await previewOfficialUsageBundle(bundleId, { signal });
        if (!isLive(generation)) return;
        reviewed = preview;
        applyBundlePreview(preview, adminState);
      } catch (error) {
        if (!isLive(generation) || clearUnauthorized(error)) return;
        failures.push(`Could not load the staged bundle preview: ${errorMessage(error)} Use Refresh import state to retry.`);
      }
    }
    try {
      if (!signal) return;
      const state = await getOfficialUsageAdminState({ signal });
      if (!isLive(generation)) return;
      setAdminState(state);
      setAdminVerified(true);
      if (reviewed) {
        const matches = reviewed.expectedActiveRevision === state.activeRevision;
        setPreviewVerified(matches);
        if (!matches) failures.push("The saved report selection changed during validation. Refresh import state before review.");
      }
    } catch (error) {
      if (!isLive(generation) || clearUnauthorized(error)) return;
      setAdminVerified(false);
      setPreviewVerified(false);
      failures.push(`Could not refresh import history: ${errorMessage(error)} Use Refresh import state before review.`);
    }
    setMessage({
      tone: failures.length || rejectedFiles.length ? "error" : "success",
      text: `${stagedKinds.size} report type(s) staged; ${rejectedFiles.length} file(s) rejected.${failures.length ? ` ${failures.join(" ")}` : ""}`,
    });
    setBusy(false);
    setValidating(false);
  }

  async function acceptPreviews(retry = false) {
    const reviewed = retry ? acceptanceRetry : bundlePreview;
    if (busy || !reviewed || reviewed.missingKinds.length || (!retry && (!previewVerified || files.length || step !== "review"))) return;
    const signal = lifetime.current?.signal;
    const generation = ++loadGeneration.current;
    const priorState = adminState;
    setBusy(true);
    setMessage(undefined);
    try {
      const accepted = await acceptOfficialUsageBundle(reviewed);
      if (!isLive(generation)) return;
      const nextResult: ImportResult = { accepted, priorState };
      setResult(nextResult);
      setStep("result");
      pendingBundleId.current = undefined;
      pendingCorrection.current = undefined;
      setDraft(undefined);
      setBundlePreview(undefined);
      setPreviewVerified(false);
      setAcceptanceRetry(undefined);
      setCorrectionMode(false);
      setFiles([]);
      setValidation([]);
      setAdminVerified(false);
      onChanged();
      try {
        if (!signal) return;
        const state = await getOfficialUsageAdminState({ signal });
        if (!isLive(generation)) return;
        setAdminState(state);
        setAdminVerified(true);
        setResult({ ...nextResult, verifiedState: state });
      } catch (error) {
        if (!isLive(generation) || clearUnauthorized(error)) return;
        setResult({ ...nextResult, refreshError: errorMessage(error) });
      }
    } catch (error) {
      if (!isLive(generation) || clearUnauthorized(error)) return;
      setPreviewVerified(false);
      const rejected = error instanceof ApiError && error.status >= 400 && error.status < 500;
      setAcceptanceRetry(rejected ? undefined : reviewed);
      setMessage({ tone: "error", text: `${errorMessage(error)} ${rejected
        ? "Refresh validation and review the bundle again before accepting."
        : "Acceptance was not confirmed. Retry the exact reviewed request to recover its result without creating a new import."}` });
    } finally {
      if (isLive(generation)) setBusy(false);
    }
  }

  async function discardPreviews() {
    if (busy || !previews.length) return;
    const generation = ++loadGeneration.current;
    setBusy(true);
    setPreviewVerified(false);
    const outcomes = await Promise.allSettled(previews.map(async preview => {
      try {
        await discardOfficialUsageStaging(preview.id);
      } catch (error) {
        if (isLive(generation)) clearUnauthorized(error);
        throw error;
      }
    }));
    if (!isLive(generation)) return;
    const failed = outcomes.filter(outcome => outcome.status === "rejected");
    if (failed.some(outcome => clearUnauthorized(outcome.reason))) return;
    if (failed.length) {
      const state = await refresh(bundlePreview?.bundleId);
      if (!state || lifetime.current?.signal.aborted) return;
      setMessage({ tone: "error", text: `${failed.length} staged report(s) could not be discarded and remain available for retry. ${errorMessage(failed[0].reason)}` });
    } else {
      pendingBundleId.current = undefined;
      pendingCorrection.current = undefined;
      setDraft(undefined);
      setBundlePreview(undefined);
      setAcceptanceRetry(undefined);
      setCorrectionMode(false);
      setValidation([]);
      setStep("files");
      const state = await refresh(null);
      if (!state || lifetime.current?.signal.aborted) return;
      setMessage({ tone: "success", text: "All staged rows were discarded." });
    }
  }

  async function resumeSet(bundleId: string) {
    if (busy || !adminVerified) return;
    const signal = lifetime.current?.signal;
    const generation = ++loadGeneration.current;
    setBusy(true);
    setPreviewVerified(false);
    setMessage(undefined);
    try {
      const preview = await previewOfficialUsageBundle(bundleId, { signal });
      if (!isLive(generation)) return;
      if (pendingBundleId.current !== bundleId) {
        setFiles([]);
        setValidation([]);
      }
      applyBundlePreview(preview, adminState);
      setResult(undefined);
      setAcceptanceRetry(undefined);
      setStep("validation");
      onViewChange?.("import");
    } catch (error) {
      if (isLive(generation)) showError(error);
    } finally {
      if (isLive(generation)) setBusy(false);
    }
  }

  async function beginSetOperation(setId: string, operation: "select" | "delete") {
    if (busy || !adminVerified) return;
    const generation = ++loadGeneration.current;
    setBusy(true);
    setMessage(undefined);
    confirmationReturnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    try {
      const preview = await previewOfficialUsageSetOperation(setId, operation);
      if (isLive(generation)) setConfirmation(preview);
    } catch (error) {
      if (isLive(generation)) showError(error);
    } finally {
      if (isLive(generation)) setBusy(false);
    }
  }

  function cancelSetOperation() {
    confirmationFocusPending.current = activeRef.current;
    setConfirmation(undefined);
  }

  async function confirmSetOperation() {
    if (busy || !confirmation) return;
    const generation = ++loadGeneration.current;
    setBusy(true);
    setMessage(undefined);
    try {
      await confirmOfficialUsageSetOperation(confirmation);
      if (!isLive(generation)) return;
      cancelSetOperation();
      setPreviewVerified(false);
      setAcceptanceRetry(undefined);
      onChanged();
      const state = await refresh(null);
      if (!state || lifetime.current?.signal.aborted) return;
      setMessage({ tone: "success", text: confirmation.operation === "select"
        ? "The retained complete set is now selected."
        : "The retained set was deleted; active selection was cleared when applicable." });
    } catch (error) {
      if (isLive(generation)) showError(error);
    } finally {
      if (isLive(generation)) setBusy(false);
    }
  }

  async function acknowledgeLegacy(disposition: "reimported" | "discarded") {
    if (busy) return;
    const generation = ++loadGeneration.current;
    setBusy(true);
    try {
      await acknowledgeLegacyUsageCleanup(disposition);
      if (!isLive(generation)) return;
      clearLegacyUsageStorage();
      setLegacyPresent(false);
      onLegacyCleared?.();
      setMessage({ tone: "success", text: "Legacy browser report storage was removed after explicit acknowledgement." });
    } catch (error) {
      if (isLive(generation)) showError(error);
    } finally {
      if (isLive(generation)) setBusy(false);
    }
  }

  function startAnotherImport() {
    setResult(undefined);
    setMessage(undefined);
    setStep("files");
  }

  const canReview = Boolean(bundlePreview && !bundlePreview.missingKinds.length && previewVerified && adminVerified && !files.length && !busy);
  const acceptedSet = result?.verifiedState?.sets.find(value => value.id === result.accepted.setId && value.complete && !value.deletedAt);
  const activeSet = adminVerified ? adminState?.sets.find(value => value.id === adminState.activeSetId && !value.deletedAt) : undefined;
  const selectedStep = importSteps.find(value => value.id === step)!;

  return (
    <section className="official-usage-import usage-wizard" aria-labelledby="official-usage-import-title">
      {view === "import" ? <ol className="usage-import-steps" aria-label="Import progress">
        {importSteps.map((item, index) => <li key={item.id} aria-current={step === item.id ? "step" : undefined}><span aria-hidden="true">{index + 1}</span>{item.label}</li>)}
      </ol> : null}
      <div className="usage-wizard-body">
        <header className="usage-step-heading">
          <div><p className="usage-step-kicker">{view === "manage" ? "Report administration" : `Step ${importSteps.indexOf(selectedStep) + 1} of 4`}</p>
            <h3 ref={heading} tabIndex={-1} id="official-usage-import-title">{view === "manage" ? "Manage retained reports" : selectedStep.label}</h3>
          </div>
          <button type="button" className="secondary" disabled={busy} onClick={() => void refresh()}>
            <RefreshCw size={16} aria-hidden="true" />Refresh import state
          </button>
        </header>
        {message && !confirmation ? <div className={`report-status ${message.tone}`} role={message.tone === "error" ? "alert" : "status"}>{message.text}</div> : null}
        {view === "manage" && acceptanceRetry ? <p className="usage-context-warning">An acceptance response is unresolved. Return to Add CSV reports and retry the same acceptance before changing reports.</p> : null}
        {view === "manage" ? <OfficialUsageManageReports state={adminState} verified={adminVerified} busy={busy || Boolean(acceptanceRetry)}
          onResume={bundleId => void resumeSet(bundleId)} onOperation={(setId, operation) => void beginSetOperation(setId, operation)}
          onViewSnapshot={onViewSnapshot} /> : (
          <>
            {step === "files" ? (
              <section className="usage-files-step" aria-label="Choose report files">
                <p>Choose the original <strong>Agents</strong>, <strong>Users &amp; agents</strong>, and <strong>Users</strong> CSV exports from the same Microsoft reporting selection.</p>
                <div className="usage-file-picker">
                  <input ref={fileInput} hidden aria-label="Official usage CSV files" type="file" accept=".csv,text/csv" multiple
                    onChange={event => chooseFiles([...(event.currentTarget.files ?? [])])} />
                  <button type="button" className="secondary" disabled={busy} onClick={() => fileInput.current?.click()}><FileText size={16} aria-hidden="true" />Choose CSVs</button>
                  <span>{files.length ? `${files.length} file(s) selected` : "No files selected"}</span>
                </div>
                {files.length ? <ul className="usage-selected-files">{files.map((file, index) => <li key={`${file.name}-${index}`}><span>{file.name}</span><small>{file.size.toLocaleString()} bytes · report type not yet validated</small></li>)}</ul> : null}
                <ol className="usage-export-guide">
                  <li>In Microsoft 365 admin center, open Reports → Usage → Microsoft Copilot → Agents.</li>
                  <li>Select one 7- or 30-day window and export each of the three tables.</li>
                </ol>
                <a href={reportGuideUrl} target="_blank" rel="noreferrer">Microsoft report export guidance</a>
                <p>All rows are imported; no dates need to be entered. The server identifies report types. File names and activity dates do not prove a shared reporting window.</p>
                {draft ? <p className="usage-context-warning">Companions already staged in draft {draft.bundleId.slice(0, 8)} remain available. New files must be validated before review.</p> : null}
                {adminState?.activeSetId || correctionMode ? (
                  <div className="official-usage-correction">
                    <label><input type="checkbox" disabled={busy || Boolean(draft)} checked={correctionMode} onChange={event => setCorrectionMode(event.target.checked)} />{draft?.correctionOfSetId ? "This draft intentionally corrects its original snapshot." : "This upload intentionally corrects the current snapshot."}</label>
                    <p>{draft ? `This draft's correction intent is fixed${draft.correctionOfSetId ? ` to snapshot ${draft.correctionOfSetId.slice(0, 8)}` : " as an independent import"}. Discard staging to change it.` : "Leave this off for ordinary uploads. Use it only to intentionally supersede the selected snapshot; prior observations stay in history."}</p>
                    {activeSet ? <p>Current snapshot: {formatCoverage(activeSet.reportingPeriod)}</p> : null}
                  </div>
                ) : null}
                <p>Ordinary uploads do not require a replacement acknowledgement. For a known reporting window, changed aggregate metrics require intentional correction. Activity-range-only imports have an unknown reporting window and remain independent observations.</p>
              </section>
            ) : null}
            {step === "validation" ? (
              <section className="usage-validation-step" aria-label="Server validation">
                <p role="status">{validating
                  ? `Uploading and validating files with the server. ${validation.filter(value => value.status === "validated" || value.status === "rejected").length} of ${validation.length} files checked.`
                  : busy ? "Refreshing authoritative validation..." : "Validation does not publish reports. Continue only after all three report kinds have a verified preview."}</p>
                {validation.length ? <ul className="usage-validation-files">{validation.map((entry, index) => <li key={`${entry.file.name}-${index}`} data-status={entry.status}>
                  <strong>{entry.file.name}</strong><span>{entry.status === "waiting" ? "Waiting" : entry.status === "validating" ? "Uploading and validating…" : entry.status === "validated" ? `${kindLabel(entry.preview!.kind)} · ${entry.preview!.rowCount.toLocaleString()} rows validated` : "Rejected"}</span>
                  {entry.error ? <p>{entry.file.name}: {entry.error}</p> : null}
                </li>)}</ul> : null}
                {bundlePreview ? <div className="usage-validation-summary">
                  <h4>{bundlePreview.missingKinds.length ? `Missing ${bundlePreview.missingKinds.map(kindLabel).join(", ")}` : "All three report kinds are present"}</h4>
                  <ul>{previews.map(preview => <li key={preview.id}>{kindLabel(preview.kind)}: {preview.rowCount.toLocaleString()} rows staged{preview.warnings.length ? `; ${preview.warnings.length} warning(s) to review` : ""}</li>)}
                    {bundlePreview.acceptedVersions.map(version => <li key={version.versionId}>{kindLabel(version.kind)}: accepted companion retained</li>)}</ul>
                  {!previewVerified ? <p className="usage-context-warning">The displayed preview is not verified for approval. Refresh import state or validate changed files before continuing.</p> : null}
                </div> : null}
                {files.length ? <p>{files.length} file(s) selected for retry. Successfully staged companions are kept in the same bundle.</p> : null}
                {!busy && (!bundlePreview || bundlePreview.missingKinds.length > 0) ? <p>Return to Files to add or replace the missing exports. A filename is not evidence of its report type.</p> : null}
              </section>
            ) : null}
            {step === "review" && bundlePreview ? <>
              {!previewVerified ? <p className="usage-context-warning">Approval is unavailable until validation is refreshed and reviewed again.</p> : null}
              <OfficialUsageImportReview preview={bundlePreview} />
            </> : null}
            {step === "result" && result ? (
              <section className="usage-import-result" aria-label="Import result">
                <h4>{result.verifiedState ? "Accepted bundle" : "Accepted; status not yet verified"}</h4>
                <p role="status">{acceptedBundleMessage(result)}</p>
                <p>Snapshot reference: <strong>{result.accepted.setId.slice(0, 8)}</strong></p>
                {result.refreshError ? <div className="report-status error" role="alert">Acceptance succeeded, but the metadata refresh failed: {result.refreshError}</div> : null}
                {busy ? <p role="status">Verifying retained history and selection...</p> : null}
              </section>
            ) : null}
          </>
        )}
        {view === "import" && previews.length && step !== "result" ? <div className="usage-staging-actions">
          <button type="button" className="secondary" disabled={busy || Boolean(acceptanceRetry)} onClick={() => void discardPreviews()}><Trash2 size={16} aria-hidden="true" />Discard staging</button>
          <span>Only unaccepted staging will be discarded.</span>
        </div> : null}
        {legacyPresent && (view === "manage" || step === "files" || step === "result") ? (
          <section className="usage-legacy-notice" aria-label="Legacy browser data">
            <strong>Legacy browser report data is present in this browser.</strong>
            <p>It was not read or migrated. Re-import the original Microsoft exports, or explicitly discard the legacy copy.</p>
            <div className="report-actions">
              {result?.accepted.complete ? <button type="button" disabled={busy} onClick={() => void acknowledgeLegacy("reimported")}><Check size={16} aria-hidden="true" />Acknowledge re-import and remove</button> : null}
              <button type="button" className="secondary" disabled={busy} onClick={() => void acknowledgeLegacy("discarded")}><Trash2 size={16} aria-hidden="true" />Acknowledge discard and remove</button>
            </div>
          </section>
        ) : null}
      </div>
      {view === "import" ? <footer className="usage-wizard-footer">
        <div className="usage-wizard-secondary">
          {step === "validation" || step === "review" ? <button type="button" className="secondary" disabled={busy || Boolean(acceptanceRetry)} onClick={() => setStep(step === "review" ? "validation" : "files")}>{step === "review" ? "Back to validation" : "Back to files"}</button> : null}
          {step === "files" && bundlePreview ? <button type="button" className="secondary" disabled={busy} onClick={() => setStep("validation")}>Show validation</button> : null}
          {step === "result" ? <button type="button" className="secondary" disabled={busy} onClick={startAnotherImport}>Import another bundle</button> : null}
        </div>
        <div className="usage-wizard-primary">
          {step === "files" ? <button type="button" disabled={busy || !files.length || !adminVerified} onClick={() => void stageFiles()}><Upload size={16} aria-hidden="true" />Validate and stage</button> : null}
          {step === "validation" && files.length ? <button type="button" className="secondary" disabled={busy || !adminVerified} onClick={() => void stageFiles()}>Retry rejected files</button> : null}
          {step === "validation" ? <button type="button" disabled={!canReview} onClick={() => { setMessage(undefined); setStep("review"); }}>Continue to review</button> : null}
          {step === "review" ? <button type="button" disabled={!canReview || Boolean(acceptanceRetry)} onClick={() => void acceptPreviews()}><Check size={16} aria-hidden="true" />{busy ? "Accepting…" : "Accept reviewed bundle"}</button> : null}
          {step === "review" && acceptanceRetry ? <button type="button" disabled={busy} onClick={() => void acceptPreviews(true)}>Retry same acceptance</button> : null}
          {step === "result" && !result?.verifiedState ? <button type="button" disabled={busy} onClick={() => void refresh(null)}>Refresh result</button> : null}
          {step === "result" && acceptedSet && onViewSnapshot ? <button type="button" disabled={busy} onClick={() => onViewSnapshot(acceptedSet.id)}>View snapshot</button> : null}
        </div>
      </footer> : null}
      {confirmation ? <SetConfirmationDialog confirmation={confirmation} reportSet={adminState?.sets.find(reportSet => reportSet.id === confirmation.setId)}
        active={active} busy={busy} error={message?.tone === "error" ? message.text : undefined}
        onCancel={cancelSetOperation} onConfirm={() => void confirmSetOperation()} /> : null}
    </section>
  );
}

function SetConfirmationDialog({ confirmation, reportSet, active, busy, error, onCancel, onConfirm }: {
  confirmation: OfficialUsageConfirmation;
  reportSet?: OfficialUsageAdminState["sets"][number];
  active: boolean;
  busy: boolean;
  error?: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    if (active && element && !element.open) element.showModal();
    else if (!active && element?.open) element.close();
  }, [active]);
  return <dialog ref={dialog} className="confirm-modal" aria-labelledby="usage-set-confirm-title"
    onKeyDown={event => { event.stopPropagation(); trapDialogFocus(event, dialog.current); }}
    onCancel={event => { event.preventDefault(); onCancel(); }} onClose={onCancel}>
    <h2 id="usage-set-confirm-title">Confirm {confirmation.operation}</h2>
    {error ? <p className="report-status error" role="alert">{error}</p> : null}
    <p>Set {confirmation.setId}</p>
    <p>{reportSet ? `Activity coverage / supplied period: ${formatCoverage(reportSet.reportingPeriod)}.` : "Activity coverage unavailable."}</p>
    <p>{confirmation.operation === "delete" ? "Deletion removes retained content. Deleting the active set clears selection and never falls back automatically." : "Selection replaces the active pointer with this retained complete set."}</p>
    <div className="confirm-actions"><button type="button" className="secondary" autoFocus onClick={onCancel}>Cancel</button><button type="button" disabled={busy} onClick={onConfirm}>Confirm</button></div>
  </dialog>;
}
