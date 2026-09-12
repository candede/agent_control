import { useEffect, useRef, useState } from "react";
import { Ban, CheckCircle2, CircleOff, RefreshCw, RotateCw, X } from "lucide-react";
import {
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
import { WorkbenchActionGate } from "../workbenchActionContext";
import { CapabilityGate } from "./CapabilityGate";

type Props = {
  snapshot: QuarantineSelectionSnapshot | null;
  targets: QuarantineSelectableTarget[];
  variant: "detail" | "bulk";
  canManage: boolean;
  onClear?: () => void;
  initialJobId?: string;
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

export function CopilotStudioQuarantineControls({ snapshot, targets, variant, canManage, onClear, initialJobId }: Props) {
  const [boundStatus, setBoundStatus] = useState<{ selectionKey: string; status: QuarantineStatusView }>();
  const [frozenPreview, setFrozenPreview] = useState<FrozenPreview>();
  const [confirmed, setConfirmed] = useState(false);
  const [job, setJob] = useState<QuarantineJob>();
  const [busyKey, setBusyKey] = useState<string>();
  const [boundError, setBoundError] = useState<{ message: string; selectionKey?: string }>();
  const [eligibilityNow, setEligibilityNow] = useState(Date.now);
  const mounted = useRef(true);
  const selectionKey = `${snapshot?.id ?? ""}\u001f${targets.map(target => `${target.type}:${target.environmentId ?? ""}:${target.nativeId}`).sort().join("\u001e")}`;
  const previousSelectionKey = useRef(selectionKey);
  const selectionRevision = useRef(0);
  const status = boundStatus?.selectionKey === selectionKey ? boundStatus.status : undefined;
  const preview = frozenPreview?.selectionKey === selectionKey ? frozenPreview.preview : undefined;
  const busy = busyKey === selectionKey || busyKey === "job";
  const error = boundError && (!boundError.selectionKey || boundError.selectionKey === selectionKey) ? boundError.message : undefined;
  const eligible = Boolean(snapshot) && targets.length > 0 && targets.length <= 25 && targets.every(target => quarantineTargetReason(target, snapshot, eligibilityNow) === undefined);

  useEffect(() => {
    if (previousSelectionKey.current === selectionKey) return;
    previousSelectionKey.current = selectionKey;
    selectionRevision.current += 1;
    setFrozenPreview(undefined);
    setConfirmed(false);
    setBusyKey(current => current === "job" ? current : undefined);
  }, [selectionKey]);

  useEffect(() => {
    mounted.current = true;
    const timer = window.setInterval(() => setEligibilityNow(Date.now()), 60_000);
    return () => { mounted.current = false; window.clearInterval(timer); };
  }, []);

  useEffect(() => {
    if (variant !== "bulk" || !canManage) return;
    const controller = new AbortController();
    const load = initialJobId
      ? getQuarantineJob(initialJobId, { signal: controller.signal })
      : getQuarantineJobs().then(result =>
          result.value.find(candidate => isActive(candidate) || candidate.canResume || candidate.canReconcile) ?? result.value[0],
        );
    void Promise.resolve().then(() => {
      if (controller.signal.aborted) return undefined;
      setJob(undefined);
      setBoundError(undefined);
      return load;
    }).then(result => {
      if (!controller.signal.aborted) setJob(result);
    }).catch(requestError => {
      if (!controller.signal.aborted) {
        setBoundError({ message: initialJobId
          ? `The exact quarantine job is unavailable to this account: ${errorMessage(requestError)}`
          : errorMessage(requestError) });
      }
    });
    return () => controller.abort();
  }, [canManage, initialJobId, variant]);

  useEffect(() => {
    const jobId = job?.id;
    const jobStatus = job?.status;
    if (!jobId || !jobStatus || !isActiveStatus(jobStatus)) return;
    const activeJobId = jobId;
    let cancelled = false;
    let remaining = maximumAutomaticJobPolls;
    let timer = window.setTimeout(poll, quarantineJobPollIntervalMs);
    async function poll() {
      try {
        const next = await getQuarantineJob(activeJobId);
        if (cancelled) return;
        setJob(next);
        remaining -= 1;
        if (isActive(next) && remaining > 0) timer = window.setTimeout(poll, quarantineJobPollIntervalMs);
        else if (isActive(next)) setBoundError({ message: "Automatic job status checks stopped after one minute. Refresh explicitly to continue recovery." });
      } catch (requestError) {
        if (!cancelled) setBoundError({ message: `Job status unavailable: ${errorMessage(requestError)}` });
      }
    }
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [job?.id, job?.status]);

  async function loadStatus(force: boolean) {
    if (!snapshot || targets.length !== 1) return;
    const requestedSelectionKey = selectionKey;
    const requestedSelectionRevision = selectionRevision.current;
    setBusyKey(requestedSelectionKey);
    setBoundError(undefined);
    try {
      const next = await getQuarantineStatus(snapshot.id, targets[0].nativeId, force);
      if (mounted.current && selectionRevision.current === requestedSelectionRevision) setBoundStatus({ selectionKey: requestedSelectionKey, status: next });
    } catch (requestError) {
      if (mounted.current && selectionRevision.current === requestedSelectionRevision) {
        setBoundStatus(undefined);
        setBoundError({ selectionKey: requestedSelectionKey, message: `Direct status unavailable: ${errorMessage(requestError)}` });
      }
    } finally {
      if (mounted.current && selectionRevision.current === requestedSelectionRevision) setBusyKey(current => current === requestedSelectionKey ? undefined : current);
    }
  }

  async function beginPreview(action: QuarantineAction) {
    if (!snapshot || !eligible || !canManage) return;
    const requestedSelectionKey = selectionKey;
    const requestedSelectionRevision = selectionRevision.current;
    const snapshotId = snapshot.id;
    const resourceNativeIds = targets.map(target => target.nativeId);
    setBusyKey(requestedSelectionKey);
    setBoundError(undefined);
    setConfirmed(false);
    try {
      const result = await previewQuarantine({ action, snapshotId, resourceNativeIds });
      if (!mounted.current || selectionRevision.current !== requestedSelectionRevision) return;
      setFrozenPreview({ action, idempotencyKey: crypto.randomUUID(), preview: result, resourceNativeIds, selectionKey: requestedSelectionKey, snapshotId });
      if (resourceNativeIds.length === 1) setBoundStatus({ selectionKey: requestedSelectionKey, status: result.statuses[0] });
    } catch (requestError) {
      if (mounted.current && selectionRevision.current === requestedSelectionRevision) setBoundError({ selectionKey: requestedSelectionKey, message: errorMessage(requestError) });
    } finally {
      if (mounted.current && selectionRevision.current === requestedSelectionRevision) setBusyKey(current => current === requestedSelectionKey ? undefined : current);
    }
  }

  async function submit() {
    if (!frozenPreview || frozenPreview.selectionKey !== selectionKey || !confirmed || !eligible || !canManage) return;
    const requestedSelectionKey = frozenPreview.selectionKey;
    setBusyKey(requestedSelectionKey);
    setBoundError(undefined);
    try {
      const next = await submitQuarantine({ action: frozenPreview.action, snapshotId: frozenPreview.snapshotId, resourceNativeIds: frozenPreview.resourceNativeIds, confirmationHash: frozenPreview.preview.confirmationHash }, frozenPreview.idempotencyKey);
      setJob(next);
      setFrozenPreview(undefined);
      setConfirmed(false);
      onClear?.();
    } catch (requestError) { setBoundError({ selectionKey: requestedSelectionKey, message: errorMessage(requestError) }); }
    finally { setBusyKey(current => current === requestedSelectionKey ? undefined : current); }
  }

  async function updateJob(operation: (id: string) => Promise<QuarantineJob>) {
    if (!job) return;
    setBusyKey("job");
    setBoundError(undefined);
    try { setJob(await operation(job.id)); }
    catch (requestError) { setBoundError({ message: errorMessage(requestError) }); }
    finally { setBusyKey(current => current === "job" ? undefined : current); }
  }

  if (variant === "detail") {
    const resource = targets[0];
    const disabledReason = quarantineTargetReason(resource, snapshot, eligibilityNow);
    return <section className="inventory-detail-section quarantine-control" aria-labelledby="quarantine-control-title">
      <div className="quarantine-control-heading"><div><h3 id="quarantine-control-title">Copilot Studio quarantine</h3><p>Direct provider state and saved inventory state remain independent.</p></div>
        <CapabilityGate capability="powerPlatform.quarantine.read" roles={["AgentControl.Viewer"]} compact>
          <button type="button" className="secondary" disabled={Boolean(disabledReason) || busy} onClick={() => void loadStatus(Boolean(status))}><RefreshCw aria-hidden="true" /> {status ? "Recheck direct status" : "Check direct status"}</button>
        </CapabilityGate>
      </div>
      {disabledReason ? <p className="quarantine-disabled"><CircleOff aria-hidden="true" /> {disabledReason}</p> : null}
      <StatusComparison status={status} resource={resource} snapshot={snapshot} />
      <p className="quarantine-maker-note">Makers may still see and test a quarantined bot in Copilot Studio while users cannot use it through connected channels. Package blocking is a separate control.</p>
      {canManage ? <div className="quarantine-actions">
        <WorkbenchActionGate actionId="quarantine.change" compact><button type="button" className="danger" disabled={!eligible || busy} onClick={() => void beginPreview("quarantine")}><Ban aria-hidden="true" /> Quarantine</button></WorkbenchActionGate>
        <WorkbenchActionGate actionId="quarantine.change" compact><button type="button" className="secondary" disabled={!eligible || busy} onClick={() => void beginPreview("unquarantine")}><CheckCircle2 aria-hidden="true" /> Restore from quarantine</button></WorkbenchActionGate>
      </div> : null}
      {error ? <p className="error-banner" role="alert">{error}</p> : null}
      {job ? <QuarantineJobStatus job={job} busy={busy} onRefresh={() => updateJob(getQuarantineJob)} onCancel={() => updateJob(cancelQuarantineJob)} onResume={() => updateJob(resumeQuarantineJob)} onReconcile={() => updateJob(reconcileQuarantineJob)} /> : null}
      {preview && frozenPreview ? <QuarantineConfirmation preview={preview} action={frozenPreview.action} confirmed={confirmed} busy={busy} canSubmit={eligible && canManage} onConfirmed={setConfirmed} onClose={() => { setFrozenPreview(undefined); setConfirmed(false); }} onSubmit={submit} /> : null}
    </section>;
  }

  return <section className="quarantine-bulk" aria-label="Copilot Studio quarantine controls">
    <div><strong>{targets.length} of 25 exact Copilot Studio agents selected</strong><span>Selection uses native IDs from one saved inventory snapshot.</span></div>
    <div className="quarantine-actions">
      <button type="button" className="secondary" disabled={!targets.length} onClick={onClear}><X aria-hidden="true" /> Clear</button>
      <WorkbenchActionGate actionId="quarantine.change" compact><button type="button" className="danger" disabled={!eligible || busy || !canManage} onClick={() => void beginPreview("quarantine")}><Ban aria-hidden="true" /> Quarantine selected</button></WorkbenchActionGate>
      <WorkbenchActionGate actionId="quarantine.change" compact><button type="button" className="secondary" disabled={!eligible || busy || !canManage} onClick={() => void beginPreview("unquarantine")}><CheckCircle2 aria-hidden="true" /> Restore selected</button></WorkbenchActionGate>
    </div>
    {error ? <p className="error-banner" role="alert">{error}</p> : null}
    {job ? <QuarantineJobStatus job={job} busy={busy} onRefresh={() => updateJob(getQuarantineJob)} onCancel={() => updateJob(cancelQuarantineJob)} onResume={() => updateJob(resumeQuarantineJob)} onReconcile={() => updateJob(reconcileQuarantineJob)} /> : null}
    {preview && frozenPreview ? <QuarantineConfirmation preview={preview} action={frozenPreview.action} confirmed={confirmed} busy={busy} canSubmit={eligible && canManage} onConfirmed={setConfirmed} onClose={() => { setFrozenPreview(undefined); setConfirmed(false); }} onSubmit={submit} /> : null}
  </section>;
}

function StatusComparison({ status, resource, snapshot }: { status?: QuarantineStatusView; resource: QuarantineSelectableTarget; snapshot: QuarantineSelectionSnapshot | null }) {
  return <div className="quarantine-status-grid">
    <div><span>Direct provider status</span><strong>{status ? status.direct.isBotQuarantined ? "Quarantined" : "Not quarantined" : "Not checked"}</strong><small>{status ? `${formatDate(status.direct.observedAt)} · ${status.direct.source}` : "Run an explicit target-scoped read."}</small></div>
    <div><span>Saved inventory status</span><strong>{typeof resource.details.isQuarantined !== "boolean" ? "Unknown" : resource.details.isQuarantined ? "Quarantined" : "Not quarantined"}</strong><small>{snapshot ? formatDate(snapshot.observedAt) : "No saved snapshot"}</small></div>
    <div><span>Provider update time</span><strong>{status ? formatDate(status.direct.providerUpdatedAt) : "Unknown"}</strong><small>{status?.disagreesWithInventory ? "Direct and inventory states disagree." : "A timestamp is evidence, not provider atomicity."}</small></div>
  </div>;
}

function QuarantineConfirmation({ preview, action, confirmed, busy, canSubmit, onConfirmed, onClose, onSubmit }: { preview: QuarantinePreview; action: QuarantineAction; confirmed: boolean; busy: boolean; canSubmit: boolean; onConfirmed: (value: boolean) => void; onClose: () => void; onSubmit: () => Promise<void> }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    if (typeof element?.showModal === "function") element.showModal();
    else element?.setAttribute("open", "");
    return () => { if (element?.open && typeof element.close === "function") element.close(); };
  }, []);
  function closeDialog() {
    if (typeof dialog.current?.close === "function") dialog.current.close();
    else { dialog.current?.removeAttribute("open"); onClose(); }
  }
  return <dialog ref={dialog} className="quarantine-confirmation" aria-labelledby="quarantine-confirmation-title" onClose={onClose} onKeyDown={event => {
    if (event.key !== "Tab") return;
    const controls = event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),a[href],[tabindex="0"]');
    const first = controls[0];
    const last = controls[controls.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  }}>
    <header><div><p className="eyebrow">Delegated write confirmation</p><h2 id="quarantine-confirmation-title">{action === "quarantine" ? "Quarantine" : "Restore"} {preview.summary.targetCount} {preview.summary.targetCount === 1 ? "agent" : "agents"}</h2></div><button type="button" className="icon-button" aria-label="Close quarantine confirmation" onClick={closeDialog}><X aria-hidden="true" /></button></header>
    <div className="quarantine-confirmation-body">
      <p>{preview.summary.makerBehavior}</p>
      <dl><div><dt>Provider</dt><dd>{preview.summary.provider}</dd></div><div><dt>Endpoint</dt><dd>{preview.summary.endpoint}</dd></div><div><dt>Permission</dt><dd>{preview.summary.permission}</dd></div><div><dt>Atomicity</dt><dd>Not provider-atomic; each target is verified independently</dd></div></dl>
      <div className="quarantine-confirmation-targets">{preview.summary.targets.map(target => <div key={target.resourceNativeId}><strong>{target.displayName}</strong><span>{target.environmentId} / {target.botId}</span><span>{target.currentState ? "Quarantined" : "Not quarantined"} to {target.requestedState ? "quarantined" : "not quarantined"}</span></div>)}</div>
      <label className="quarantine-confirm-check"><input type="checkbox" checked={confirmed} disabled={!canSubmit || busy} onChange={event => onConfirmed(event.target.checked)} /><span>I confirm this exact frozen target list and understand partial results are not automatically inverted.</span></label>
    </div>
    <footer><button type="button" className="secondary" onClick={closeDialog}>Cancel</button><WorkbenchActionGate actionId="quarantine.change" compact><button type="button" className={action === "quarantine" ? "danger" : "primary-link"} disabled={!confirmed || busy || !canSubmit} onClick={() => void onSubmit()}>Confirm {action === "quarantine" ? "quarantine" : "restoration"}</button></WorkbenchActionGate></footer>
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
function isActiveStatus(status: QuarantineJob["status"]) { return status === "queued" || status === "running"; }
function errorMessage(error: unknown) { return error instanceof Error ? error.message : "Quarantine request failed."; }
function formatDate(value: string) { return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)); }
function title(value: string) { return value.replaceAll("_", " ").replace(/\b\w/g, letter => letter.toUpperCase()); }