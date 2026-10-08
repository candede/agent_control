import { useCallback, useEffect, useRef, useState } from "react";
import { Ban, CheckCircle2, CircleOff, RefreshCw, RotateCw, X } from "lucide-react";
import {
  ApiError,
  cancelQuarantineJob,
  getQuarantineJob,
  getQuarantineJobs,
  getQuarantineStatus,
  previewQuarantine,
  reconcileQuarantineJob,
  resumeQuarantineJob,
  submitQuarantine,
  type QuarantineAction,
  type QuarantineJob,
  type QuarantinePreview,
  type QuarantineStatusView,
} from "../api/client";
import { quarantineTargetKey, quarantineTargetReason, type QuarantineSelectableTarget, type QuarantineSelectionSnapshot } from "../quarantineTarget";
import { useSavedRead } from "../savedQueries";
import { observeDialogFocus, trapDialogFocus } from "../dialogFocus";
import { WorkbenchActionGate } from "../workbenchActionContext";
import { CapabilityGate } from "./CapabilityGate";

type Props = {
  snapshot: QuarantineSelectionSnapshot | null;
  targets: QuarantineSelectableTarget[];
  variant: "detail" | "bulk";
  canManage: boolean;
  active?: boolean;
  pendingTargetCount?: number;
  onClear?: () => void;
  initialJobId?: string;
  onJobChange?: (job: QuarantineJob) => void;
  onReceiptPendingChange?: (pending: boolean) => void;
};

type FrozenPreview = {
  action: QuarantineAction;
  idempotencyKey: string;
  preview: QuarantinePreview;
  resourceNativeIds: string[];
  selectionKey: string;
  selectionRevision: number;
  snapshotId: string;
  invalidated?: boolean;
  submissionAttempted?: boolean;
  submissionError?: string;
};

const quarantineJobPollIntervalMs = 1_000;
const maximumAutomaticJobPolls = 60;
const changedPreviewMessage = "The quarantine job changed this target evidence. Prepare a new confirmation before submitting.";

export function CopilotStudioQuarantineControls(props: Props) {
  const key = props.variant === "detail"
    ? JSON.stringify(props.targets.map(quarantineTargetEvidenceKey).sort())
    : "bulk";
  return <QuarantineControls key={key} {...props} />;
}

function QuarantineControls({ snapshot, targets, variant, canManage, active = true, pendingTargetCount = 0, onClear, initialJobId, onJobChange, onReceiptPendingChange }: Props) {
  const [boundStatus, setBoundStatus] = useState<{ selectionKey: string; status: QuarantineStatusView }>();
  const [frozenPreview, setFrozenPreview] = useState<FrozenPreview>();
  const [confirmed, setConfirmed] = useState(false);
  const [job, setJob] = useState<QuarantineJob>();
  const [resumedJobId, setResumedJobId] = useState<string>();
  const [busyKey, setBusyKey] = useState<string>();
  const [selectionActivity, setSelectionActivity] = useState<"status" | "preview">();
  const [restoringJob, setRestoringJob] = useState(false);
  const [restoreRevision, setRestoreRevision] = useState(0);
  const [boundError, setBoundError] = useState<{ message: string; selectionKey: string }>();
  const [jobError, setJobError] = useState<string>();
  const [, setEligibilityNow] = useState(Date.now);
  const eligibilityNow = Date.now();
  const [previousActive, setPreviousActive] = useState(active);
  if (previousActive !== active) {
    setPreviousActive(active);
    if (!active) {
      // Submitted work still owns its receipt and recovery, even on another tab.
      setFrozenPreview(current => current?.submissionAttempted ? current : undefined);
      setConfirmed(false);
      setBusyKey(current => current === "job" ? current : undefined);
    }
  }
  const mounted = useRef(true);
  const statusRead = useRef<AbortController | undefined>(undefined);
  const previewRead = useRef<{ controller: AbortController; targets: QuarantineSelectableTarget[]; selectionKey: string } | undefined>(undefined);
  const jobRead = useRef<AbortController | undefined>(undefined);
  const jobAction = useRef<AbortController | undefined>(undefined);
  const jobRevision = useRef(0);
  const jobReadVersion = useRef<string | undefined>(undefined);
  const followedJob = useRef<QuarantineJob | undefined>(undefined);
  const callbacks = useRef({ onClear, onJobChange, onReceiptPendingChange });
  const readSaved = useSavedRead();
  const selectionKey = JSON.stringify([canManage, quarantineSelectionKey(snapshot, targets, pendingTargetCount)]);
  const previousSelectionKey = useRef(selectionKey);
  const selectionRevision = useRef(0);
  const status = boundStatus?.selectionKey === selectionKey ? boundStatus.status : undefined;
  const submittedReceipt = Boolean(frozenPreview?.submissionAttempted);
  const preview = frozenPreview?.selectionKey === selectionKey || submittedReceipt ? frozenPreview?.preview : undefined;
  const busy = busyKey === selectionKey || busyKey === "job";
  const jobBusy = busyKey === "job";
  const polledJobId = canManage && !jobBusy && job && shouldPollJob(job, resumedJobId) ? job.id : undefined;
  const error = boundError?.selectionKey === selectionKey ? boundError.message : undefined;
  const eligibilityReason = selectionReason(snapshot, targets, pendingTargetCount, eligibilityNow);
  const eligible = !eligibilityReason;
  const confirmationError = frozenPreview?.submissionError ?? error ?? eligibilityReason ?? (frozenPreview?.invalidated ? changedPreviewMessage : undefined);
  const canSubmit = canManage && (eligible || submittedReceipt) && !frozenPreview?.invalidated;

  const storeJob = useCallback((next: QuarantineJob | undefined) => {
    if (next && (followedJob.current?.id !== next.id || followedJob.current.updatedAt !== next.updatedAt)) {
      setBoundStatus(current => current && jobContainsTarget(next, current.status.target) ? undefined : current);
      // A lost submission response may already have a durable idempotent receipt.
      setFrozenPreview(current => current && !current.submissionAttempted
        && current.preview.statuses.some(status => jobContainsTarget(next, status.target))
        ? { ...current, invalidated: true } : current);
      const pending = previewRead.current;
      if (pending?.targets.some(target => target.quarantineIdentity
        && jobContainsTarget(next, { resourceNativeId: target.nativeId, ...target.quarantineIdentity }))) {
        pending.controller.abort();
        previewRead.current = undefined;
        setBusyKey(current => current === pending.selectionKey ? undefined : current);
        setBoundError({ selectionKey: pending.selectionKey, message: changedPreviewMessage });
      }
    }
    if (next) setJobError(undefined);
    followedJob.current = next;
    setJob(next);
  }, []);

  const beginJobRequest = useCallback((freshSavedRead = false) => {
    jobRead.current?.abort();
    jobAction.current?.abort();
    jobAction.current = undefined;
    setRestoringJob(false);
    setBusyKey(current => current === "job" ? undefined : current);
    if (freshSavedRead) jobReadVersion.current = crypto.randomUUID();
    return ++jobRevision.current;
  }, []);

  const clearDeniedState = useCallback((failure: unknown) => {
    if (!(failure instanceof ApiError) || (failure.status !== 401 && failure.status !== 403)) return;
    selectionRevision.current += 1;
    jobRevision.current += 1;
    jobReadVersion.current = crypto.randomUUID();
    statusRead.current?.abort();
    previewRead.current?.controller.abort();
    statusRead.current = undefined;
    previewRead.current = undefined;
    jobRead.current?.abort();
    jobAction.current?.abort();
    jobAction.current = undefined;
    setBoundStatus(undefined);
    setBoundError(undefined);
    setJobError(undefined);
    setFrozenPreview(undefined);
    setConfirmed(false);
    storeJob(undefined);
    setResumedJobId(undefined);
    setBusyKey(undefined);
    setRestoringJob(false);
  }, [storeJob]);

  useEffect(() => {
    callbacks.current = { onClear, onJobChange, onReceiptPendingChange };
  }, [onClear, onJobChange, onReceiptPendingChange]);

  useEffect(() => {
    callbacks.current.onReceiptPendingChange?.(submittedReceipt);
  }, [submittedReceipt]);

  useEffect(() => {
    if (active) return;
    selectionRevision.current += 1;
    statusRead.current?.abort();
    previewRead.current?.controller.abort();
    statusRead.current = undefined;
    previewRead.current = undefined;
  }, [active]);

  useEffect(() => {
    if (previousSelectionKey.current === selectionKey) return;
    previousSelectionKey.current = selectionKey;
    selectionRevision.current += 1;
    statusRead.current?.abort();
    previewRead.current?.controller.abort();
    statusRead.current = undefined;
    previewRead.current = undefined;
    setBoundStatus(undefined);
    setBoundError(undefined);
    setFrozenPreview(current => canManage && current?.submissionAttempted ? current : undefined);
    setConfirmed(false);
    setBusyKey(current => current === "job" ? current : undefined);
  }, [canManage, selectionKey]);

  useEffect(() => {
    mounted.current = true;
    const timer = window.setInterval(() => setEligibilityNow(Date.now()), 60_000);
    return () => {
      mounted.current = false;
      selectionRevision.current += 1;
      jobRevision.current += 1;
      statusRead.current?.abort();
      previewRead.current?.controller.abort();
      statusRead.current = undefined;
      previewRead.current = undefined;
      jobRead.current?.abort();
      jobAction.current?.abort();
      callbacks.current.onReceiptPendingChange?.(false);
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    // The owner can bookmark the job just published by this control.
    if (variant === "bulk" && canManage && initialJobId && followedJob.current?.id === initialJobId) return;
    const requestedJobRevision = beginJobRequest();
    if (variant !== "bulk" || !canManage) return;
    const controller = new AbortController();
    // A peer may still own the pre-action request after this caller cancels.
    const version = jobReadVersion.current ? [jobReadVersion.current] : [];
    jobRead.current = controller;
    void Promise.resolve().then(() => {
      if (controller.signal.aborted || jobRevision.current !== requestedJobRevision) return;
      storeJob(undefined);
      setRestoringJob(true);
      setResumedJobId(current => current === initialJobId ? current : undefined);
      setJobError(undefined);
      setBusyKey(current => current === "job" ? undefined : current);
      return initialJobId
        ? readSaved(["quarantine-job", initialJobId, ...version], signal =>
            getQuarantineJob(initialJobId, { signal }), controller.signal)
        : readSaved(["quarantine-jobs", 20, ...version], signal =>
            getQuarantineJobs(20, { signal }), controller.signal).then(result =>
            result.value.find(candidate => isActive(candidate) || candidate.canResume || candidate.canReconcile) ?? result.value[0],
          );
    }).then(result => {
      if (!controller.signal.aborted && jobRevision.current === requestedJobRevision) storeJob(result);
    }).catch(requestError => {
      if (!controller.signal.aborted && jobRevision.current === requestedJobRevision) {
        clearDeniedState(requestError);
        setJobError(initialJobId
          ? `The exact quarantine job is unavailable to this account: ${errorMessage(requestError)}`
          : errorMessage(requestError));
      }
    }).finally(() => {
      if (!controller.signal.aborted && jobRevision.current === requestedJobRevision) setRestoringJob(false);
    });
    return () => controller.abort();
  }, [beginJobRequest, canManage, clearDeniedState, initialJobId, readSaved, restoreRevision, storeJob, variant]);

  useEffect(() => {
    if (!polledJobId) return;
    const activeJobId = polledJobId;
    const requestedJobRevision = jobRevision.current;
    const controller = new AbortController();
    jobRead.current = controller;
    let cancelled = false;
    let remaining = maximumAutomaticJobPolls;
    let timer = window.setTimeout(poll, resumedJobId === activeJobId ? 0 : quarantineJobPollIntervalMs);
    async function poll() {
      try {
        const next = await getQuarantineJob(activeJobId, { signal: controller.signal });
        if (cancelled || controller.signal.aborted || jobRevision.current !== requestedJobRevision) return;
        storeJob(next);
        callbacks.current.onJobChange?.(next);
        remaining -= 1;
        if (shouldPollJob(next, resumedJobId) && remaining > 0) timer = window.setTimeout(poll, quarantineJobPollIntervalMs);
        else if (shouldPollJob(next, resumedJobId)) setJobError("Automatic job status checks stopped after one minute. Refresh explicitly to continue recovery.");
      } catch (requestError) {
        if (!cancelled && !controller.signal.aborted && jobRevision.current === requestedJobRevision) {
          clearDeniedState(requestError);
          setJobError(`Job status unavailable: ${errorMessage(requestError)}`);
        }
      }
    }
    return () => { cancelled = true; controller.abort(); window.clearTimeout(timer); };
  }, [clearDeniedState, polledJobId, resumedJobId, storeJob]);

  function currentSelectionEligible() {
    const now = Date.now();
    setEligibilityNow(now);
    const reason = selectionReason(snapshot, targets, pendingTargetCount, now);
    if (reason) setBoundError({ selectionKey, message: reason });
    return !reason;
  }

  async function loadStatus(force: boolean) {
    if (!active || !snapshot || targets.length !== 1 || busy || statusRead.current || previewRead.current || jobAction.current) return;
    if (!currentSelectionEligible()) return;
    const requestedSelectionKey = selectionKey;
    const requestedSelectionRevision = selectionRevision.current;
    const requestedJob = followedJob.current;
    const jobUnchanged = () => followedJob.current?.id === requestedJob?.id && followedJob.current?.updatedAt === requestedJob?.updatedAt;
    const controller = new AbortController();
    statusRead.current = controller;
    setBusyKey(requestedSelectionKey);
    setSelectionActivity("status");
    setBoundError(undefined);
    try {
      const next = await getQuarantineStatus(snapshot.id, targets[0].nativeId, force, { signal: controller.signal });
      if (mounted.current && !controller.signal.aborted && selectionRevision.current === requestedSelectionRevision && jobUnchanged()) setBoundStatus({ selectionKey: requestedSelectionKey, status: next });
    } catch (requestError) {
      if (mounted.current && !controller.signal.aborted && selectionRevision.current === requestedSelectionRevision && jobUnchanged()) {
        clearDeniedState(requestError);
        setBoundStatus(undefined);
        setBoundError({ selectionKey: requestedSelectionKey, message: `Direct status unavailable: ${errorMessage(requestError)}` });
      }
    } finally {
      if (statusRead.current === controller) statusRead.current = undefined;
      if (mounted.current && selectionRevision.current === requestedSelectionRevision) setBusyKey(current => current === requestedSelectionKey ? undefined : current);
    }
  }

  async function beginPreview(action: QuarantineAction) {
    if (!active || !snapshot || !eligible || !canManage || busy || statusRead.current || previewRead.current || jobAction.current) return;
    if (!currentSelectionEligible()) return;
    const requestedSelectionKey = selectionKey;
    const requestedSelectionRevision = selectionRevision.current;
    const snapshotId = snapshot.id;
    const resourceNativeIds = targets.map(target => target.nativeId);
    const controller = new AbortController();
    previewRead.current = { controller, targets, selectionKey: requestedSelectionKey };
    setBusyKey(requestedSelectionKey);
    setSelectionActivity("preview");
    setBoundError(undefined);
    setConfirmed(false);
    try {
      const result = await previewQuarantine({ action, snapshotId, resourceNativeIds }, { signal: controller.signal });
      if (!mounted.current || controller.signal.aborted || selectionRevision.current !== requestedSelectionRevision) return;
      if (!currentSelectionEligible()) return;
      setFrozenPreview({ action, idempotencyKey: crypto.randomUUID(), preview: result, resourceNativeIds, selectionKey: requestedSelectionKey, selectionRevision: requestedSelectionRevision, snapshotId });
      if (resourceNativeIds.length === 1) setBoundStatus({ selectionKey: requestedSelectionKey, status: result.statuses[0] });
    } catch (requestError) {
      if (mounted.current && !controller.signal.aborted && selectionRevision.current === requestedSelectionRevision) {
        clearDeniedState(requestError);
        setBoundError({ selectionKey: requestedSelectionKey, message: errorMessage(requestError) });
      }
    } finally {
      if (previewRead.current?.controller === controller) {
        previewRead.current = undefined;
        if (mounted.current && selectionRevision.current === requestedSelectionRevision) setBusyKey(current => current === requestedSelectionKey ? undefined : current);
      }
    }
  }

  async function submit() {
    if (!active || !frozenPreview || !canSubmit || frozenPreview.selectionKey !== selectionKey && !submittedReceipt || !confirmed || busy
      || statusRead.current || previewRead.current || jobAction.current) return;
    if (!submittedReceipt && !currentSelectionEligible()) return;
    const requestedSelectionKey = frozenPreview.selectionKey;
    const requestedSelectionRevision = frozenPreview.selectionRevision;
    const requestedJobRevision = beginJobRequest(true);
    const controller = new AbortController();
    jobAction.current = controller;
    setFrozenPreview({ ...frozenPreview, submissionAttempted: true, submissionError: undefined });
    setBoundStatus(undefined);
    setResumedJobId(undefined);
    setBusyKey("job");
    setBoundError(undefined);
    try {
      const next = await submitQuarantine({ action: frozenPreview.action, snapshotId: frozenPreview.snapshotId, resourceNativeIds: frozenPreview.resourceNativeIds, confirmationHash: frozenPreview.preview.confirmationHash }, frozenPreview.idempotencyKey, { signal: controller.signal });
      if (!mounted.current || jobRevision.current !== requestedJobRevision) return;
      storeJob(next);
      callbacks.current.onJobChange?.(next);
      setFrozenPreview(current => current?.idempotencyKey === frozenPreview.idempotencyKey ? undefined : current);
      if (mounted.current && selectionRevision.current === requestedSelectionRevision) {
        setConfirmed(false);
        callbacks.current.onClear?.();
      }
    } catch (requestError) {
      if (mounted.current && jobRevision.current === requestedJobRevision) {
        clearDeniedState(requestError);
        setFrozenPreview(current => current?.idempotencyKey === frozenPreview.idempotencyKey
          ? { ...current, submissionError: errorMessage(requestError) } : current);
        setBoundError({ selectionKey: requestedSelectionKey, message: errorMessage(requestError) });
      }
    } finally {
      if (jobAction.current === controller) jobAction.current = undefined;
      if (mounted.current && jobRevision.current === requestedJobRevision) setBusyKey(current => current === "job" ? undefined : current);
    }
  }

  async function updateJob(operation?: (id: string, options: { signal?: AbortSignal }) => Promise<QuarantineJob>, resume = false) {
    if (!active || !job || operation && !canManage || busy || statusRead.current || previewRead.current || jobAction.current) return;
    const requestedJobRevision = beginJobRequest(true);
    const controller = new AbortController();
    if (!operation) jobRead.current = controller;
    jobAction.current = controller;
    if (operation) setBoundStatus(current => current && jobContainsTarget(job, current.status.target) ? undefined : current);
    setBusyKey("job");
    setJobError(undefined);
    try {
      const next = await (operation ? operation(job.id, { signal: controller.signal }) : getQuarantineJob(job.id, { signal: controller.signal }));
      if (!mounted.current || jobRevision.current !== requestedJobRevision) return;
      storeJob(next);
      if (resume) setResumedJobId(next.id);
      callbacks.current.onJobChange?.(next);
    }
    catch (requestError) {
      if (mounted.current && jobRevision.current === requestedJobRevision) {
        clearDeniedState(requestError);
        setJobError(errorMessage(requestError));
      }
    }
    finally {
      if (jobAction.current === controller) jobAction.current = undefined;
      if (mounted.current && jobRevision.current === requestedJobRevision) setBusyKey(current => current === "job" ? undefined : current);
    }
  }

  if (variant === "detail") {
    const resource = targets[0];
    const disabledReason = quarantineTargetReason(resource, snapshot, eligibilityNow);
    if (disabledReason && !job && !preview) return <details className="agent-insight-provenance">
      <summary>Additional control availability</summary>
      <p>Quarantine is unavailable: {disabledReason}</p><a href="/sync">Review inventory coverage</a>
    </details>;
    return <article className="agent-management-card">
      <div className="management-card-heading"><h4>Quarantine and restore</h4></div>
      <section className="inventory-detail-section quarantine-control" aria-labelledby="quarantine-control-title">
      <div className="quarantine-control-heading"><div><h3 id="quarantine-control-title">Copilot Studio quarantine</h3></div>
        <CapabilityGate capability="powerPlatform.quarantine.read" roles={["AgentControl.Viewer"]} compact>
          <button type="button" className="secondary" disabled={Boolean(disabledReason) || busy} onClick={() => void loadStatus(Boolean(status))}><RefreshCw aria-hidden="true" /> {status ? "Recheck direct status" : "Check direct status"}</button>
        </CapabilityGate>
      </div>
      {busy && !jobBusy ? <p role="status">{selectionActivity === "status" ? "Checking direct quarantine status..." : "Preparing exact-target confirmation..."}</p> : null}
      {disabledReason ? <p className="quarantine-disabled"><CircleOff aria-hidden="true" /> {disabledReason}</p> : null}
      <StatusComparison status={status} resource={resource} snapshot={snapshot} />
      <p className="quarantine-maker-note">Quarantine blocks connected channels; makers can still test in Copilot Studio. Package blocking is separate.</p>
      {canManage ? <div className="quarantine-actions">
        <WorkbenchActionGate actionId="quarantine.change" compact><button type="button" className="danger" disabled={!eligible || busy} onClick={() => void beginPreview("quarantine")}><Ban aria-hidden="true" /> Quarantine</button></WorkbenchActionGate>
        <WorkbenchActionGate actionId="quarantine.change" compact><button type="button" className="secondary" disabled={!eligible || busy} onClick={() => void beginPreview("unquarantine")}><CheckCircle2 aria-hidden="true" /> Restore from quarantine</button></WorkbenchActionGate>
      </div> : null}
      {error && !preview && error !== eligibilityReason ? <p className="error-banner" role="alert">{error}</p> : null}
      {jobError ? <p className="error-banner" role="alert">{jobError}</p> : null}
      {job ? <QuarantineJobStatus job={job} busy={busy} canManage={canManage} onRefresh={() => updateJob()} onCancel={() => updateJob(cancelQuarantineJob)} onResume={() => updateJob(resumeQuarantineJob, true)} onReconcile={() => updateJob(reconcileQuarantineJob)} /> : null}
      {active && preview && frozenPreview ? <QuarantineConfirmation preview={preview} action={frozenPreview.action} confirmed={confirmed} busy={busy} receiptPending={submittedReceipt} error={confirmationError} canSubmit={canSubmit} onConfirmed={setConfirmed} onClose={() => { setFrozenPreview(undefined); setConfirmed(false); }} onSubmit={submit} /> : null}
      </section>
    </article>;
  }

  return <section className="quarantine-bulk" aria-label="Copilot Studio quarantine controls">
    <div><strong>{targets.length} of 25 exact Copilot Studio agents selected</strong><span>Selection uses native IDs from one saved inventory snapshot.</span></div>
    {pendingTargetCount > 0 ? <p role="status">Restoring {pendingTargetCount} bookmarked quarantine selection{pendingTargetCount === 1 ? "" : "s"} from exact saved identities. Clear to cancel.</p> : null}
    {targets.length > 0 && !pendingTargetCount && eligibilityReason ? <p className="quarantine-disabled">{eligibilityReason}</p> : null}
    {busy && !jobBusy ? <p role="status">Preparing exact-target confirmation...</p> : null}
    {restoringJob ? <p role="status">Loading quarantine job...</p> : null}
    <div className="quarantine-actions">
      <button type="button" className="secondary" disabled={!targets.length && !pendingTargetCount} onClick={onClear}><X aria-hidden="true" /> Clear</button>
      <WorkbenchActionGate actionId="quarantine.change" compact><button type="button" className="danger" disabled={!eligible || busy || !canManage} onClick={() => void beginPreview("quarantine")}><Ban aria-hidden="true" /> Quarantine selected</button></WorkbenchActionGate>
      <WorkbenchActionGate actionId="quarantine.change" compact><button type="button" className="secondary" disabled={!eligible || busy || !canManage} onClick={() => void beginPreview("unquarantine")}><CheckCircle2 aria-hidden="true" /> Restore selected</button></WorkbenchActionGate>
    </div>
    {error && !preview && error !== eligibilityReason ? <p className="error-banner" role="alert">{error}</p> : null}
    {jobError ? <p className="error-banner" role="alert">{jobError}</p> : null}
    {!job && jobError && !restoringJob && canManage ? <button type="button" className="secondary"
      onClick={() => setRestoreRevision(current => current + 1)}>Retry quarantine job</button> : null}
    {job ? <QuarantineJobStatus job={job} busy={busy} canManage={canManage} onRefresh={() => updateJob()} onCancel={() => updateJob(cancelQuarantineJob)} onResume={() => updateJob(resumeQuarantineJob, true)} onReconcile={() => updateJob(reconcileQuarantineJob)} /> : null}
    {active && preview && frozenPreview ? <QuarantineConfirmation preview={preview} action={frozenPreview.action} confirmed={confirmed} busy={busy} receiptPending={submittedReceipt} error={confirmationError} canSubmit={canSubmit} onConfirmed={setConfirmed} onClose={() => { setFrozenPreview(undefined); setConfirmed(false); }} onSubmit={submit} /> : null}
  </section>;
}

function StatusComparison({ status, resource, snapshot }: { status?: QuarantineStatusView; resource: QuarantineSelectableTarget; snapshot: QuarantineSelectionSnapshot | null }) {
  return <div className="quarantine-status-grid">
    <div><span>Direct provider status</span><strong>{status ? status.direct.isBotQuarantined ? "Quarantined" : "Not quarantined" : "Not checked"}</strong><small>{status ? `${formatDate(status.direct.observedAt)} · ${status.direct.source}` : "Check direct status to load."}</small></div>
    <div><span>Saved inventory status</span><strong>{typeof resource.details.isQuarantined !== "boolean" ? "Unknown" : resource.details.isQuarantined ? "Quarantined" : "Not quarantined"}</strong><small>{snapshot ? formatDate(snapshot.observedAt) : "No saved snapshot"}</small></div>
    <div><span>Provider update time</span><strong>{status ? formatDate(status.direct.providerUpdatedAt) : "Unknown"}</strong>{status?.disagreesWithInventory ? <small>Direct and inventory states disagree.</small> : null}</div>
  </div>;
}

function QuarantineConfirmation({ preview, action, confirmed, busy, receiptPending, error, canSubmit, onConfirmed, onClose, onSubmit }: { preview: QuarantinePreview; action: QuarantineAction; confirmed: boolean; busy: boolean; receiptPending: boolean; error?: string; canSubmit: boolean; onConfirmed: (value: boolean) => void; onClose: () => void; onSubmit: () => Promise<void> }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const dialogMounted = useRef(false);
  useEffect(() => {
    const element = dialog.current;
    dialogMounted.current = true;
    if (typeof element?.showModal === "function") element.showModal();
    else element?.setAttribute("open", "");
    const stopObservingFocus = element ? observeDialogFocus(element) : undefined;
    return () => {
      stopObservingFocus?.();
      dialogMounted.current = false;
      if (element?.open && typeof element.close === "function") element.close();
    };
  }, []);
  function closeDialog() {
    if (busy) return;
    if (typeof dialog.current?.close === "function") dialog.current.close();
    else { dialog.current?.removeAttribute("open"); onClose(); }
  }
  return <dialog ref={dialog} className="quarantine-confirmation" aria-busy={busy} aria-labelledby="quarantine-confirmation-title" onClose={event => {
    event.stopPropagation();
    if (event.target === event.currentTarget && dialogMounted.current && !event.currentTarget.open) onClose();
  }} onCancel={event => { event.stopPropagation(); if (busy) event.preventDefault(); }} onKeyDown={event => {
    if (event.key === "Escape") { event.stopPropagation(); return; }
    if (event.key !== "Tab") return;
    event.stopPropagation();
    trapDialogFocus(event, event.currentTarget);
  }}>
    <header><div><p className="eyebrow">Delegated write confirmation</p><h2 id="quarantine-confirmation-title">{action === "quarantine" ? "Quarantine" : "Restore"} {preview.summary.targetCount} {preview.summary.targetCount === 1 ? "agent" : "agents"}</h2></div><button type="button" className="icon-button" aria-label="Close quarantine confirmation" disabled={busy} onClick={closeDialog}><X aria-hidden="true" /></button></header>
    <div className="quarantine-confirmation-body" tabIndex={busy ? 0 : undefined}>
      <p>{preview.summary.makerBehavior}</p>
      {receiptPending ? <p>This request may already have been accepted. Retrying uses the same receipt; closing does not cancel submitted work.</p> : null}
      <dl><div><dt>Provider</dt><dd>{preview.summary.provider}</dd></div><div><dt>Endpoint</dt><dd>{preview.summary.endpoint}</dd></div><div><dt>Permission</dt><dd>{preview.summary.permission}</dd></div><div><dt>Atomicity</dt><dd>Not provider-atomic; each target is verified independently</dd></div></dl>
      <div className="quarantine-confirmation-targets">{preview.summary.targets.map(target => <div key={target.resourceNativeId}><strong>{target.displayName}</strong><span>{target.environmentId} / {target.botId}</span><span>{target.currentState ? "Quarantined" : "Not quarantined"} to {target.requestedState ? "quarantined" : "not quarantined"}</span></div>)}</div>
      <label className="quarantine-confirm-check"><input type="checkbox" checked={confirmed} disabled={!canSubmit || busy} onChange={event => onConfirmed(event.target.checked)} /><span>I confirm this exact frozen target list and understand partial results are not automatically inverted.</span></label>
      {error ? <p className="error-banner" role="alert">{error}</p> : null}
    </div>
    <footer><button type="button" className="secondary" disabled={busy} onClick={closeDialog}>{receiptPending ? "Close" : "Cancel"}</button><WorkbenchActionGate actionId="quarantine.change" compact><button type="button" className={action === "quarantine" ? "danger" : "primary-link"} disabled={!confirmed || busy || !canSubmit} onClick={() => void onSubmit()}>Confirm {action === "quarantine" ? "quarantine" : "restoration"}</button></WorkbenchActionGate></footer>
  </dialog>;
}

function QuarantineJobStatus({ job, busy, canManage, onRefresh, onCancel, onResume, onReconcile }: { job: QuarantineJob; busy: boolean; canManage: boolean; onRefresh: () => Promise<void>; onCancel: () => Promise<void>; onResume: () => Promise<void>; onReconcile: () => Promise<void> }) {
  return <div className={`quarantine-job ${job.status}`} role="status" aria-live="polite">
    <div><strong>{job.action === "quarantine" ? "Quarantine" : "Restoration"} job: {title(job.status)}</strong><span>{job.completed} of {job.total} complete · {job.succeeded} verified · {job.inconclusive} inconclusive · {job.failed} failed</span></div>
    <div className="quarantine-actions"><button type="button" className="secondary" disabled={busy} onClick={() => void onRefresh()}><RefreshCw aria-hidden="true" /> Refresh job status</button>{canManage && (isActive(job) || job.completed < job.total) ? <WorkbenchActionGate actionId="quarantine.cancel" compact><button type="button" className="secondary" disabled={busy} onClick={() => void onCancel()}>Cancel unsent work</button></WorkbenchActionGate> : null}{canManage && job.canResume ? <WorkbenchActionGate actionId="quarantine.resume" compact><button type="button" className="secondary" disabled={busy} onClick={() => void onResume()}><RotateCw aria-hidden="true" /> Resume unsent work</button></WorkbenchActionGate> : null}{canManage && job.canReconcile ? <WorkbenchActionGate actionId="quarantine.reconcile" compact><button type="button" className="secondary" disabled={busy} onClick={() => void onReconcile()}><RefreshCw aria-hidden="true" /> Reconcile by status read</button></WorkbenchActionGate> : null}</div>
    {job.results.length ? <ul>{job.results.map(result => <li key={result.resourceNativeId}><strong>{result.displayName}</strong><span>{title(result.status)}{result.message ? ` · ${result.message}` : ""}</span></li>)}</ul> : null}
  </div>;
}

function isActive(job: QuarantineJob) { return job.status === "queued" || job.status === "running"; }
function jobContainsTarget(job: QuarantineJob, candidate: Pick<QuarantineStatusView["target"], "resourceNativeId" | "environmentId" | "botId">) {
  const candidateKey = quarantineTargetKey({ nativeId: candidate.resourceNativeId, environmentId: candidate.environmentId });
  return job.confirmation.targets.some(target => quarantineTargetKey({ nativeId: target.resourceNativeId, environmentId: target.environmentId }) === candidateKey
    && target.botId.toLowerCase() === candidate.botId.toLowerCase());
}
function quarantineTargetEvidenceKey(target: QuarantineSelectableTarget) {
  return JSON.stringify([target.type, quarantineTargetKey(target),
    target.quarantineIdentity?.environmentId.toLowerCase(), target.quarantineIdentity?.botId.toLowerCase()]);
}
function quarantineSelectionKey(snapshot: QuarantineSelectionSnapshot | null, targets: QuarantineSelectableTarget[], pendingTargetCount: number) {
  return JSON.stringify([snapshot?.id, snapshot?.observedAt, snapshot?.expiresAt, snapshot?.current !== false, pendingTargetCount,
    targets.map(target => JSON.stringify([quarantineTargetEvidenceKey(target), target.quarantineEligibility?.eligible !== false])).sort()]);
}
function selectionReason(snapshot: QuarantineSelectionSnapshot | null, targets: QuarantineSelectableTarget[], pendingTargetCount: number, now: number) {
  if (pendingTargetCount) return "Wait for the exact bookmarked quarantine targets to finish restoring.";
  if (!targets.length || targets.length > 25) return "Select 1-25 exact Copilot Studio agents.";
  return targets.map(target => quarantineTargetReason(target, snapshot, now)).find(reason => reason !== undefined);
}
function shouldPollJob(job: QuarantineJob, resumedJobId?: string) {
  return isActive(job) || job.id === resumedJobId && job.status === "waiting_authorization";
}
function errorMessage(error: unknown) { return error instanceof Error ? error.message : "Quarantine request failed."; }
function formatDate(value: string) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date) : "Unknown";
}
function title(value: string) { return value.replaceAll("_", " ").replace(/\b\w/g, letter => letter.toUpperCase()); }