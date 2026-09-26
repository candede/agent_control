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
import { quarantineTargetReason, type QuarantineSelectableTarget, type QuarantineSelectionSnapshot } from "../quarantineTarget";
import { useSavedRead } from "../savedQueries";
import { trapDialogFocus } from "../dialogFocus";
import { WorkbenchActionGate } from "../workbenchActionContext";
import { CapabilityGate } from "./CapabilityGate";

type Props = {
  snapshot: QuarantineSelectionSnapshot | null;
  targets: QuarantineSelectableTarget[];
  variant: "detail" | "bulk";
  canManage: boolean;
  pendingTargetCount?: number;
  onClear?: () => void;
  initialJobId?: string;
  onJobChange?: (job: QuarantineJob) => void;
};

type FrozenPreview = {
  action: QuarantineAction;
  idempotencyKey: string;
  preview: QuarantinePreview;
  resourceNativeIds: string[];
  selectionKey: string;
  snapshotId: string;
};

const quarantineJobPollIntervalMs = 1_000;
const maximumAutomaticJobPolls = 60;

export function CopilotStudioQuarantineControls(props: Props) {
  const key = props.variant === "detail"
    ? JSON.stringify([props.snapshot?.id, props.targets.map(target => [target.type, target.environmentId, target.nativeId])])
    : "bulk";
  return <QuarantineControls key={key} {...props} />;
}

function QuarantineControls({ snapshot, targets, variant, canManage, pendingTargetCount = 0, onClear, initialJobId, onJobChange }: Props) {
  const [boundStatus, setBoundStatus] = useState<{ selectionKey: string; status: QuarantineStatusView }>();
  const [frozenPreview, setFrozenPreview] = useState<FrozenPreview>();
  const [confirmed, setConfirmed] = useState(false);
  const [job, setJob] = useState<QuarantineJob>();
  const [resumedJobId, setResumedJobId] = useState<string>();
  const [busyKey, setBusyKey] = useState<string>();
  const [boundError, setBoundError] = useState<{ message: string; selectionKey?: string }>();
  const [eligibilityNow, setEligibilityNow] = useState(Date.now);
  const mounted = useRef(true);
  const statusRead = useRef<AbortController | undefined>(undefined);
  const previewRead = useRef<AbortController | undefined>(undefined);
  const jobRead = useRef<AbortController | undefined>(undefined);
  const jobRevision = useRef(0);
  const jobReadVersion = useRef<string | undefined>(undefined);
  const callbacks = useRef({ onClear, onJobChange });
  const readSaved = useSavedRead();
  const selectionKey = JSON.stringify([snapshot?.id, pendingTargetCount,
    targets.map(target => JSON.stringify([target.type, target.environmentId, target.nativeId])).sort()]);
  const previousSelectionKey = useRef(selectionKey);
  const selectionRevision = useRef(0);
  const status = boundStatus?.selectionKey === selectionKey ? boundStatus.status : undefined;
  const preview = frozenPreview?.selectionKey === selectionKey ? frozenPreview.preview : undefined;
  const busy = busyKey === selectionKey || busyKey === "job";
  const jobBusy = busyKey === "job";
  const polledJobId = canManage && !jobBusy && job && shouldPollJob(job, resumedJobId) ? job.id : undefined;
  const error = boundError && (!boundError.selectionKey || boundError.selectionKey === selectionKey) ? boundError.message : undefined;
  const eligible = pendingTargetCount === 0 && Boolean(snapshot) && targets.length > 0 && targets.length <= 25 && targets.every(target => quarantineTargetReason(target, snapshot, eligibilityNow) === undefined);

  const beginJobRequest = useCallback((freshSavedRead = false) => {
    jobRead.current?.abort();
    if (freshSavedRead) jobReadVersion.current = crypto.randomUUID();
    return ++jobRevision.current;
  }, []);

  const clearDeniedState = useCallback((failure: unknown) => {
    if (!(failure instanceof ApiError) || (failure.status !== 401 && failure.status !== 403)) return;
    selectionRevision.current += 1;
    jobRevision.current += 1;
    jobReadVersion.current = crypto.randomUUID();
    statusRead.current?.abort();
    previewRead.current?.abort();
    jobRead.current?.abort();
    setBoundStatus(undefined);
    setFrozenPreview(undefined);
    setConfirmed(false);
    setJob(undefined);
    setResumedJobId(undefined);
    setBusyKey(undefined);
  }, []);

  useEffect(() => {
    callbacks.current = { onClear, onJobChange };
  }, [onClear, onJobChange]);

  useEffect(() => {
    if (previousSelectionKey.current === selectionKey) return;
    previousSelectionKey.current = selectionKey;
    selectionRevision.current += 1;
    statusRead.current?.abort();
    previewRead.current?.abort();
    setBoundStatus(undefined);
    setFrozenPreview(undefined);
    setConfirmed(false);
    setBusyKey(current => current === "job" ? current : undefined);
  }, [selectionKey]);

  useEffect(() => {
    mounted.current = true;
    const timer = window.setInterval(() => setEligibilityNow(Date.now()), 60_000);
    return () => {
      mounted.current = false;
      selectionRevision.current += 1;
      jobRevision.current += 1;
      statusRead.current?.abort();
      previewRead.current?.abort();
      jobRead.current?.abort();
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    const requestedJobRevision = beginJobRequest();
    if (variant !== "bulk" || !canManage) return;
    const controller = new AbortController();
    // A peer may still own the pre-action request after this caller cancels.
    const version = jobReadVersion.current ? [jobReadVersion.current] : [];
    jobRead.current = controller;
    void Promise.resolve().then(() => {
      if (controller.signal.aborted || jobRevision.current !== requestedJobRevision) return;
      setJob(undefined);
      setResumedJobId(current => current === initialJobId ? current : undefined);
      setBoundError(undefined);
      setBusyKey(current => current === "job" ? undefined : current);
      return initialJobId
        ? readSaved(["quarantine-job", initialJobId, ...version], signal =>
            getQuarantineJob(initialJobId, { signal }), controller.signal)
        : readSaved(["quarantine-jobs", 20, ...version], signal =>
            getQuarantineJobs(20, { signal }), controller.signal).then(result =>
            result.value.find(candidate => isActive(candidate) || candidate.canResume || candidate.canReconcile) ?? result.value[0],
          );
    }).then(result => {
      if (!controller.signal.aborted && jobRevision.current === requestedJobRevision) setJob(result);
    }).catch(requestError => {
      if (!controller.signal.aborted && jobRevision.current === requestedJobRevision) {
        clearDeniedState(requestError);
        setBoundError({ message: initialJobId
          ? `The exact quarantine job is unavailable to this account: ${errorMessage(requestError)}`
          : errorMessage(requestError) });
      }
    });
    return () => controller.abort();
  }, [beginJobRequest, canManage, clearDeniedState, initialJobId, readSaved, variant]);

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
        setJob(next);
        remaining -= 1;
        if (shouldPollJob(next, resumedJobId) && remaining > 0) timer = window.setTimeout(poll, quarantineJobPollIntervalMs);
        else if (shouldPollJob(next, resumedJobId)) setBoundError({ message: "Automatic job status checks stopped after one minute. Refresh explicitly to continue recovery." });
      } catch (requestError) {
        if (!cancelled && !controller.signal.aborted && jobRevision.current === requestedJobRevision) {
          clearDeniedState(requestError);
          setBoundError({ message: `Job status unavailable: ${errorMessage(requestError)}` });
        }
      }
    }
    return () => { cancelled = true; controller.abort(); window.clearTimeout(timer); };
  }, [clearDeniedState, initialJobId, polledJobId, resumedJobId]);

  async function loadStatus(force: boolean) {
    if (!snapshot || targets.length !== 1 || busy) return;
    const requestedSelectionKey = selectionKey;
    const requestedSelectionRevision = selectionRevision.current;
    const controller = new AbortController();
    statusRead.current?.abort();
    statusRead.current = controller;
    setBusyKey(requestedSelectionKey);
    setBoundError(undefined);
    try {
      const next = await getQuarantineStatus(snapshot.id, targets[0].nativeId, force, { signal: controller.signal });
      if (mounted.current && !controller.signal.aborted && selectionRevision.current === requestedSelectionRevision) setBoundStatus({ selectionKey: requestedSelectionKey, status: next });
    } catch (requestError) {
      if (mounted.current && !controller.signal.aborted && selectionRevision.current === requestedSelectionRevision) {
        clearDeniedState(requestError);
        setBoundStatus(undefined);
        setBoundError({ selectionKey: requestedSelectionKey, message: `Direct status unavailable: ${errorMessage(requestError)}` });
      }
    } finally {
      if (mounted.current && selectionRevision.current === requestedSelectionRevision) setBusyKey(current => current === requestedSelectionKey ? undefined : current);
    }
  }

  async function beginPreview(action: QuarantineAction) {
    if (!snapshot || !eligible || !canManage || busy) return;
    const requestedSelectionKey = selectionKey;
    const requestedSelectionRevision = selectionRevision.current;
    const snapshotId = snapshot.id;
    const resourceNativeIds = targets.map(target => target.nativeId);
    const controller = new AbortController();
    previewRead.current?.abort();
    previewRead.current = controller;
    setBusyKey(requestedSelectionKey);
    setBoundError(undefined);
    setConfirmed(false);
    try {
      const result = await previewQuarantine({ action, snapshotId, resourceNativeIds }, { signal: controller.signal });
      if (!mounted.current || controller.signal.aborted || selectionRevision.current !== requestedSelectionRevision) return;
      setFrozenPreview({ action, idempotencyKey: crypto.randomUUID(), preview: result, resourceNativeIds, selectionKey: requestedSelectionKey, snapshotId });
      if (resourceNativeIds.length === 1) setBoundStatus({ selectionKey: requestedSelectionKey, status: result.statuses[0] });
    } catch (requestError) {
      if (mounted.current && !controller.signal.aborted && selectionRevision.current === requestedSelectionRevision) {
        clearDeniedState(requestError);
        setBoundError({ selectionKey: requestedSelectionKey, message: errorMessage(requestError) });
      }
    } finally {
      if (mounted.current && selectionRevision.current === requestedSelectionRevision) setBusyKey(current => current === requestedSelectionKey ? undefined : current);
    }
  }

  async function submit() {
    if (!frozenPreview || frozenPreview.selectionKey !== selectionKey || !confirmed || !eligible || !canManage || busy) return;
    const requestedSelectionKey = frozenPreview.selectionKey;
    const requestedSelectionRevision = selectionRevision.current;
    const requestedJobRevision = beginJobRequest(true);
    setResumedJobId(undefined);
    setBusyKey("job");
    setBoundError(undefined);
    try {
      const next = await submitQuarantine({ action: frozenPreview.action, snapshotId: frozenPreview.snapshotId, resourceNativeIds: frozenPreview.resourceNativeIds, confirmationHash: frozenPreview.preview.confirmationHash }, frozenPreview.idempotencyKey);
      if (!mounted.current || jobRevision.current !== requestedJobRevision) return;
      setJob(next);
      callbacks.current.onJobChange?.(next);
      if (mounted.current && selectionRevision.current === requestedSelectionRevision) {
        setFrozenPreview(undefined);
        setConfirmed(false);
        callbacks.current.onClear?.();
      }
    } catch (requestError) {
      if (mounted.current && jobRevision.current === requestedJobRevision) {
        clearDeniedState(requestError);
        setBoundError({ selectionKey: requestedSelectionKey, message: errorMessage(requestError) });
      }
    } finally {
      if (mounted.current && jobRevision.current === requestedJobRevision) setBusyKey(current => current === "job" ? undefined : current);
    }
  }

  async function updateJob(operation?: (id: string) => Promise<QuarantineJob>, resume = false) {
    if (!job || busy) return;
    const requestedJobRevision = beginJobRequest(true);
    const controller = new AbortController();
    if (!operation) jobRead.current = controller;
    setBusyKey("job");
    setBoundError(undefined);
    try {
      const next = await (operation ? operation(job.id) : getQuarantineJob(job.id, { signal: controller.signal }));
      if (!mounted.current || jobRevision.current !== requestedJobRevision) return;
      setJob(next);
      if (resume) setResumedJobId(next.id);
      callbacks.current.onJobChange?.(next);
    }
    catch (requestError) {
      if (mounted.current && jobRevision.current === requestedJobRevision) {
        clearDeniedState(requestError);
        setBoundError({ message: errorMessage(requestError) });
      }
    }
    finally {
      if (mounted.current && jobRevision.current === requestedJobRevision) setBusyKey(current => current === "job" ? undefined : current);
    }
  }

  if (variant === "detail") {
    const resource = targets[0];
    const disabledReason = quarantineTargetReason(resource, snapshot, eligibilityNow);
    return <section className="inventory-detail-section quarantine-control" aria-labelledby="quarantine-control-title">
      <div className="quarantine-control-heading"><div><h3 id="quarantine-control-title">Copilot Studio quarantine</h3></div>
        <CapabilityGate capability="powerPlatform.quarantine.read" roles={["AgentControl.Viewer"]} compact>
          <button type="button" className="secondary" disabled={Boolean(disabledReason) || busy} onClick={() => void loadStatus(Boolean(status))}><RefreshCw aria-hidden="true" /> {status ? "Recheck direct status" : "Check direct status"}</button>
        </CapabilityGate>
      </div>
      {disabledReason ? <p className="quarantine-disabled"><CircleOff aria-hidden="true" /> {disabledReason}</p> : null}
      <StatusComparison status={status} resource={resource} snapshot={snapshot} />
      <p className="quarantine-maker-note">Quarantine blocks connected channels; makers can still test in Copilot Studio. Package blocking is separate.</p>
      {canManage ? <div className="quarantine-actions">
        <WorkbenchActionGate actionId="quarantine.change" compact><button type="button" className="danger" disabled={!eligible || busy} onClick={() => void beginPreview("quarantine")}><Ban aria-hidden="true" /> Quarantine</button></WorkbenchActionGate>
        <WorkbenchActionGate actionId="quarantine.change" compact><button type="button" className="secondary" disabled={!eligible || busy} onClick={() => void beginPreview("unquarantine")}><CheckCircle2 aria-hidden="true" /> Restore from quarantine</button></WorkbenchActionGate>
      </div> : null}
      {error && !preview ? <p className="error-banner" role="alert">{error}</p> : null}
      {job ? <QuarantineJobStatus job={job} busy={busy} onRefresh={() => updateJob()} onCancel={() => updateJob(cancelQuarantineJob)} onResume={() => updateJob(resumeQuarantineJob, true)} onReconcile={() => updateJob(reconcileQuarantineJob)} /> : null}
      {preview && frozenPreview ? <QuarantineConfirmation preview={preview} action={frozenPreview.action} confirmed={confirmed} busy={busy} error={error} canSubmit={eligible && canManage} onConfirmed={setConfirmed} onClose={() => { setFrozenPreview(undefined); setConfirmed(false); }} onSubmit={submit} /> : null}
    </section>;
  }

  return <section className="quarantine-bulk" aria-label="Copilot Studio quarantine controls">
    <div><strong>{targets.length} of 25 exact Copilot Studio agents selected</strong><span>Selection uses native IDs from one saved inventory snapshot.</span></div>
    {pendingTargetCount > 0 ? <p role="status">Restoring {pendingTargetCount} bookmarked quarantine selection{pendingTargetCount === 1 ? "" : "s"} from exact saved identities. Clear to cancel.</p> : null}
    <div className="quarantine-actions">
      <button type="button" className="secondary" disabled={!targets.length && !pendingTargetCount} onClick={onClear}><X aria-hidden="true" /> Clear</button>
      <WorkbenchActionGate actionId="quarantine.change" compact><button type="button" className="danger" disabled={!eligible || busy || !canManage} onClick={() => void beginPreview("quarantine")}><Ban aria-hidden="true" /> Quarantine selected</button></WorkbenchActionGate>
      <WorkbenchActionGate actionId="quarantine.change" compact><button type="button" className="secondary" disabled={!eligible || busy || !canManage} onClick={() => void beginPreview("unquarantine")}><CheckCircle2 aria-hidden="true" /> Restore selected</button></WorkbenchActionGate>
    </div>
    {error && !preview ? <p className="error-banner" role="alert">{error}</p> : null}
    {job ? <QuarantineJobStatus job={job} busy={busy} onRefresh={() => updateJob()} onCancel={() => updateJob(cancelQuarantineJob)} onResume={() => updateJob(resumeQuarantineJob, true)} onReconcile={() => updateJob(reconcileQuarantineJob)} /> : null}
    {preview && frozenPreview ? <QuarantineConfirmation preview={preview} action={frozenPreview.action} confirmed={confirmed} busy={busy} error={error} canSubmit={eligible && canManage} onConfirmed={setConfirmed} onClose={() => { setFrozenPreview(undefined); setConfirmed(false); }} onSubmit={submit} /> : null}
  </section>;
}

function StatusComparison({ status, resource, snapshot }: { status?: QuarantineStatusView; resource: QuarantineSelectableTarget; snapshot: QuarantineSelectionSnapshot | null }) {
  return <div className="quarantine-status-grid">
    <div><span>Direct provider status</span><strong>{status ? status.direct.isBotQuarantined ? "Quarantined" : "Not quarantined" : "Not checked"}</strong><small>{status ? `${formatDate(status.direct.observedAt)} · ${status.direct.source}` : "Check direct status to load."}</small></div>
    <div><span>Saved inventory status</span><strong>{typeof resource.details.isQuarantined !== "boolean" ? "Unknown" : resource.details.isQuarantined ? "Quarantined" : "Not quarantined"}</strong><small>{snapshot ? formatDate(snapshot.observedAt) : "No saved snapshot"}</small></div>
    <div><span>Provider update time</span><strong>{status ? formatDate(status.direct.providerUpdatedAt) : "Unknown"}</strong>{status?.disagreesWithInventory ? <small>Direct and inventory states disagree.</small> : null}</div>
  </div>;
}

function QuarantineConfirmation({ preview, action, confirmed, busy, error, canSubmit, onConfirmed, onClose, onSubmit }: { preview: QuarantinePreview; action: QuarantineAction; confirmed: boolean; busy: boolean; error?: string; canSubmit: boolean; onConfirmed: (value: boolean) => void; onClose: () => void; onSubmit: () => Promise<void> }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const dialogMounted = useRef(false);
  useEffect(() => {
    const element = dialog.current;
    dialogMounted.current = true;
    if (typeof element?.showModal === "function") element.showModal();
    else element?.setAttribute("open", "");
    return () => {
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
      <dl><div><dt>Provider</dt><dd>{preview.summary.provider}</dd></div><div><dt>Endpoint</dt><dd>{preview.summary.endpoint}</dd></div><div><dt>Permission</dt><dd>{preview.summary.permission}</dd></div><div><dt>Atomicity</dt><dd>Not provider-atomic; each target is verified independently</dd></div></dl>
      <div className="quarantine-confirmation-targets">{preview.summary.targets.map(target => <div key={target.resourceNativeId}><strong>{target.displayName}</strong><span>{target.environmentId} / {target.botId}</span><span>{target.currentState ? "Quarantined" : "Not quarantined"} to {target.requestedState ? "quarantined" : "not quarantined"}</span></div>)}</div>
      <label className="quarantine-confirm-check"><input type="checkbox" checked={confirmed} disabled={!canSubmit || busy} onChange={event => onConfirmed(event.target.checked)} /><span>I confirm this exact frozen target list and understand partial results are not automatically inverted.</span></label>
      {error ? <p className="error-banner" role="alert">{error}</p> : null}
    </div>
    <footer><button type="button" className="secondary" disabled={busy} onClick={closeDialog}>Cancel</button><WorkbenchActionGate actionId="quarantine.change" compact><button type="button" className={action === "quarantine" ? "danger" : "primary-link"} disabled={!confirmed || busy || !canSubmit} onClick={() => void onSubmit()}>Confirm {action === "quarantine" ? "quarantine" : "restoration"}</button></WorkbenchActionGate></footer>
  </dialog>;
}

function QuarantineJobStatus({ job, busy, onRefresh, onCancel, onResume, onReconcile }: { job: QuarantineJob; busy: boolean; onRefresh: () => Promise<void>; onCancel: () => Promise<void>; onResume: () => Promise<void>; onReconcile: () => Promise<void> }) {
  return <div className={`quarantine-job ${job.status}`} role="status" aria-live="polite">
    <div><strong>{job.action === "quarantine" ? "Quarantine" : "Restoration"} job: {title(job.status)}</strong><span>{job.completed} of {job.total} complete · {job.succeeded} verified · {job.inconclusive} inconclusive · {job.failed} failed</span></div>
    <div className="quarantine-actions"><button type="button" className="secondary" disabled={busy} onClick={() => void onRefresh()}><RefreshCw aria-hidden="true" /> Refresh job status</button>{isActive(job) ? <WorkbenchActionGate actionId="quarantine.cancel" compact><button type="button" className="secondary" disabled={busy} onClick={() => void onCancel()}>Cancel unsent work</button></WorkbenchActionGate> : null}{job.canResume ? <WorkbenchActionGate actionId="quarantine.resume" compact><button type="button" className="secondary" disabled={busy} onClick={() => void onResume()}><RotateCw aria-hidden="true" /> Resume unsent work</button></WorkbenchActionGate> : null}{job.canReconcile ? <WorkbenchActionGate actionId="quarantine.reconcile" compact><button type="button" className="secondary" disabled={busy} onClick={() => void onReconcile()}><RefreshCw aria-hidden="true" /> Reconcile by status read</button></WorkbenchActionGate> : null}</div>
    {job.results.length ? <ul>{job.results.map(result => <li key={result.resourceNativeId}><strong>{result.displayName}</strong><span>{title(result.status)}{result.message ? ` · ${result.message}` : ""}</span></li>)}</ul> : null}
  </div>;
}

function isActive(job: QuarantineJob) { return job.status === "queued" || job.status === "running"; }
function shouldPollJob(job: QuarantineJob, resumedJobId?: string) {
  return isActive(job) || job.id === resumedJobId && job.status === "waiting_authorization";
}
function errorMessage(error: unknown) { return error instanceof Error ? error.message : "Quarantine request failed."; }
function formatDate(value: string) { return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)); }
function title(value: string) { return value.replaceAll("_", " ").replace(/\b\w/g, letter => letter.toUpperCase()); }