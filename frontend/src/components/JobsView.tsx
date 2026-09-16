import { useCallback, useEffect, useRef, useState } from "react";
import {
  ApiError,
  cancelBulkActionJob,
  cancelDataSyncRun,
  cancelDefenderHunt,
  cancelPurviewAuditSearch,
  cancelQuarantineJob,
  discardOfficialUsageStaging,
  getWorkbenchJobs,
  reconcileBulkActionJob,
  reconcileQuarantineJob,
  retryDataSyncRun,
  resumeBulkActionJob,
  resumeDefenderHunt,
  resumeInventoryRefresh,
  resumePackageRefreshJob,
  resumePurviewAuditSearch,
  resumeQuarantineJob,
  type SessionUser,
  type WorkbenchJobSource,
  type WorkbenchJobSummary,
  type WorkbenchJobsResponse,
} from "../api/client";
import { hasRole } from "../authorization";
import { WorkbenchActionGate } from "../workbenchActionContext";

const progressingStatuses = new Set(["queued", "running", "reconciling_create"]);
const pollIntervalMs = 2_000;
const pollBudgetMs = 5 * 60_000;
const sourceLabels: Record<WorkbenchJobSource, string> = {
  "data-sync": "Data sync",
  "package-refresh": "Package refresh",
  "package-controls": "Package controls",
  "power-platform": "Power Platform",
  "official-usage": "Official usage",
  purview: "Purview audit",
  defender: "Defender",
  quarantine: "Quarantine",
};

const syncJobSources = new Set<WorkbenchJobSource>(["data-sync", "package-refresh", "power-platform", "official-usage"]);

export function JobsView({ user, scope = "all", onOpenSyncRun, onChanged, revision = 0 }: {
  user: SessionUser;
  scope?: "all" | "sync";
  onOpenSyncRun?: (runId: string) => void;
  onChanged?: () => void;
  revision?: number;
}) {
  const [state, setState] = useState<WorkbenchJobsResponse>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [sourceFilter, setSourceFilter] = useState<"all" | WorkbenchJobSource>("all");
  const generation = useRef(0);
  const request = useRef<AbortController | undefined>(undefined);
  const timer = useRef<number | undefined>(undefined);
  const pollDeadline = useRef(0);
  const actionSequence = useRef(0);
  const actionAdmission = useRef<{ owner: number; token: number } | undefined>(undefined);
  const principalKey = `${user.tenantId ?? ""}:${user.homeAccountId}:${[...user.roles].sort().join(",")}`;
  const canManageMutationJobs = hasRole(user, "AgentControl.Admin");
  const authorizedJobs = state?.value.filter(job =>
    (scope === "all" || syncJobSources.has(job.source)) && (canManageMutationJobs || isReadJob(job)));
  const visibleJobs = authorizedJobs?.filter(job => sourceFilter === "all" || job.source === sourceFilter);
  const unavailableSources = state?.unavailableSources.filter(source => scope === "all" || syncJobSources.has(source.source)) ?? [];

  const stop = useCallback(() => {
    request.current?.abort();
    request.current = undefined;
    if (timer.current !== undefined) window.clearTimeout(timer.current);
    timer.current = undefined;
  }, []);

  const load = useCallback(async (owner: number, preserveActionError = false) => {
    if (request.current) return false;
    const controller = new AbortController();
    request.current = controller;
    try {
      const next = await getWorkbenchJobs({ signal: controller.signal });
      if (owner !== generation.current) return false;
      setState(next);
      if (!preserveActionError) setError("");
      const isProgressing = next.value.some(job =>
        progressingStatuses.has(job.status) || (job.source === "data-sync" && job.status === "waiting"));
      if (isProgressing && pollDeadline.current === 0) pollDeadline.current = Date.now() + pollBudgetMs;
      if (!isProgressing) pollDeadline.current = 0;
      return isProgressing;
    } catch (reason) {
      if (owner !== generation.current || (reason instanceof ApiError && reason.kind === "aborted")) return false;
      if (reason instanceof ApiError && (reason.status === 401 || reason.status === 403)) setState(undefined);
      const message = reason instanceof ApiError
        ? `${reason.message}${reason.requestId ? ` Request ${reason.requestId}.` : ""}`
        : "Job status is unavailable.";
      setError(current => preserveActionError && current ? current : message);
      return false;
    } finally {
      if (request.current === controller) request.current = undefined;
    }
  }, []);

  const startPolling = useCallback((owner: number, preserveActionError = false) => {
    const poll = async () => {
      const progressing = await load(owner, preserveActionError);
      if (owner !== generation.current || !progressing) return;
      if (Date.now() < pollDeadline.current) timer.current = window.setTimeout(() => void poll(), pollIntervalMs);
      else pollDeadline.current = 0;
    };
    void poll();
  }, [load]);

  useEffect(() => {
    generation.current += 1;
    const owner = generation.current;
    actionAdmission.current = undefined;
    stop();
    pollDeadline.current = 0;
    startPolling(owner);
    void Promise.resolve().then(() => {
      if (owner !== generation.current) return;
      setState(undefined);
      setError("");
      setBusy("");
      setSourceFilter("all");
    });
    return () => {
      generation.current += 1;
      stop();
    };
  }, [principalKey, revision, startPolling, stop]);

  async function perform(key: string, operation: () => Promise<unknown>) {
    const owner = generation.current;
    if (actionAdmission.current?.owner === owner) return;
    const token = ++actionSequence.current;
    actionAdmission.current = { owner, token };
    setBusy(key);
    setError("");
    stop();
    try {
      await operation();
      if (owner !== generation.current) return;
      onChanged?.();
      pollDeadline.current = 0;
      startPolling(owner);
    } catch (reason) {
      if (owner !== generation.current) return;
      if (reason instanceof ApiError && (reason.status === 401 || reason.status === 403)) setState(undefined);
      setError(reason instanceof ApiError
        ? `${reason.message}${reason.requestId ? ` Request ${reason.requestId}.` : ""}`
        : "The job operation failed.");
      pollDeadline.current = 0;
      startPolling(owner, true);
    } finally {
      if (actionAdmission.current?.token === token) actionAdmission.current = undefined;
      if (owner === generation.current) setBusy("");
    }
  }

  function resume(job: WorkbenchJobSummary) {
    if (job.source === "data-sync") return retryDataSyncRun(job.id);
    if (job.source === "package-refresh") return resumePackageRefreshJob(job.id);
    if (job.source === "power-platform") return resumeInventoryRefresh(job.id);
    if (job.source === "package-controls") return resumeBulkActionJob(job.id);
    if (job.source === "quarantine") return resumeQuarantineJob(job.id);
    if (job.source === "purview") return resumePurviewAuditSearch(job.id);
    if (job.source === "defender") return resumeDefenderHunt(job.id);
    throw new Error("This job cannot be resumed.");
  }

  function cancel(job: WorkbenchJobSummary) {
    if (job.source === "data-sync") return cancelDataSyncRun(job.id);
    if (job.source === "package-controls") return cancelBulkActionJob(job.id);
    if (job.source === "quarantine") return cancelQuarantineJob(job.id);
    if (job.source === "purview") return cancelPurviewAuditSearch(job.id);
    if (job.source === "defender") return cancelDefenderHunt(job.id);
    if (job.source === "official-usage") return discardOfficialUsageStaging(job.id);
    throw new Error("This job cannot be cancelled.");
  }

  function reconcile(job: WorkbenchJobSummary) {
    if (job.source === "package-controls") return reconcileBulkActionJob(job.id);
    if (job.source === "quarantine") return reconcileQuarantineJob(job.id);
    throw new Error("This job does not support GET-only reconciliation.");
  }

  return (
    <section className="jobs-view" aria-labelledby="jobs-heading">
      <div className="section-heading">
        <div><span className="eyebrow">Operational metadata</span><h2 id="jobs-heading">{scope === "sync" ? "Sync history" : "Jobs"}</h2></div>
        <button type="button" className="secondary" onClick={() => {
          stop();
          pollDeadline.current = 0;
          startPolling(generation.current);
        }}>Refresh status</button>
      </div>
      <p className="jobs-note">Safe status, correlation, target cardinality, and recovery only. Result rows and staged previews stay in their authorized source views.</p>
      <label className="jobs-source-filter">
        Source
        <select aria-label="Filter jobs by source" value={sourceFilter} onChange={event => setSourceFilter(event.target.value as "all" | WorkbenchJobSource)}>
          <option value="all">All sources</option>
          {(Object.entries(sourceLabels) as Array<[WorkbenchJobSource, string]>).filter(([source]) => scope === "all" || syncJobSources.has(source)).map(([source, label]) => (
            <option key={source} value={source}>{label}</option>
          ))}
        </select>
      </label>
      {error ? <div className="error-banner" role="alert">{error}</div> : null}
      {!state ? <div className="screen-state" role="status">Loading authorized job metadata…</div> : null}
      {unavailableSources.length ? (
        <div className="notice" role="status">{unavailableSources.length} authorized source{unavailableSources.length === 1 ? " is" : "s are"} temporarily unavailable. Other source statuses remain usable.</div>
      ) : null}
      {state && authorizedJobs?.length === 0 ? <div className="screen-state">No retained jobs are visible to this principal and role set.</div> : null}
      {state && authorizedJobs?.length !== 0 && visibleJobs?.length === 0 ? <div className="screen-state">No retained jobs match this source filter.</div> : null}
      {visibleJobs?.map(job => {
        return (
          <article className="job-card" key={`${job.source}:${job.id}`}>
            <div className="job-card-heading">
              <div><strong>{job.label}</strong><span>{sourceLabels[job.source]} · {job.target}</span></div>
              <span className={`status-badge status-${job.status.replaceAll("_", "-")}`}>{job.status.replaceAll("_", " ")}</span>
            </div>
            <div className="job-progress">
              <span>{job.completed ?? "—"} / {job.total ?? "—"} complete{job.partial ? " · partial/inconclusive" : ""}</span>
              <span>Updated {new Date(job.updatedAt).toLocaleString()}</span>
            </div>
            <code className="job-id">{job.id}</code>
            <div className="inline-actions">
              <a className="primary-link secondary" href={jobHref(job)} onClick={event => {
                if (job.source === "data-sync" && onOpenSyncRun && event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) {
                  event.preventDefault();
                  onOpenSyncRun(job.id);
                }
              }}>
                {job.source === "data-sync" ? "Open sync details" : "Open source view"}
              </a>
              {job.canResume ? <WorkbenchActionGate actionId={jobActionId(job, "resume")} compact>
                <button type="button" disabled={busy !== ""} onClick={() => void perform(`resume:${job.id}`, () => resume(job))}>
                  {busy === `resume:${job.id}` ? "Resuming…" : job.source === "data-sync" ? "Retry incomplete" : "Resume unsent"}
                </button>
              </WorkbenchActionGate> : null}
              {job.canCancel ? <WorkbenchActionGate actionId={jobActionId(job, "cancel")} compact>
                <button type="button" className="danger" disabled={busy !== ""} onClick={() => void perform(`cancel:${job.id}`, () => cancel(job))}>
                  {busy === `cancel:${job.id}` ? "Cancelling…" : job.source === "data-sync" ? "Cancel run" : "Cancel valid unsent"}
                </button>
              </WorkbenchActionGate> : null}
              {job.canReconcile ? <WorkbenchActionGate actionId={jobActionId(job, "reconcile")} compact>
                <button type="button" disabled={busy !== ""} onClick={() => void perform(`reconcile:${job.id}`, () => reconcile(job))}>
                  {busy === `reconcile:${job.id}` ? "Reconciling…" : "GET-only reconcile"}
                </button>
              </WorkbenchActionGate> : null}
            </div>
          </article>
        );
      })}
      {state ? <p className="jobs-note">Last authorized projection {new Date(state.polledAt).toLocaleString()} · request {state.requestId}</p> : null}
    </section>
  );
}

function isReadJob(job: WorkbenchJobSummary) {
  return job.source === "data-sync"
    || job.source === "package-refresh"
    || job.source === "power-platform"
    || job.source === "purview"
    || job.source === "defender";
}

function jobHref(job: WorkbenchJobSummary) {
  return job.source === "data-sync" ? `/sync?syncRun=${encodeURIComponent(job.id)}` : job.href;
}

function jobActionId(job: WorkbenchJobSummary, operation: "resume" | "cancel" | "reconcile") {
  if (job.source === "data-sync") return operation === "resume" ? "data-sync.retry" : "data-sync.cancel";
  if (job.source === "package-controls") return `packages.${operation}`;
  if (job.source === "quarantine") return `quarantine.${operation}`;
  if (job.source === "purview") return `purview.${operation}`;
  if (job.source === "defender") return `defender.${operation}`;
  if (job.source === "power-platform") return "power-platform.resume";
  if (job.source === "package-refresh") return job.target.startsWith("Current principal") ? "packages.refresh.resume" : "packages.refresh.exact.resume";
  return "usage.staging.cancel";
}
