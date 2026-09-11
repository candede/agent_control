import { useCallback, useEffect, useRef, useState } from "react";
import {
  ApiError,
  cancelBulkActionJob,
  cancelDefenderHunt,
  cancelPurviewAuditSearch,
  cancelQuarantineJob,
  discardOfficialUsageStaging,
  getWorkbenchJobs,
  reconcileBulkActionJob,
  reconcileQuarantineJob,
  resumeBulkActionJob,
  resumeDefenderHunt,
  resumeInventoryRefresh,
  resumePackageRefreshJob,
  resumePurviewAuditSearch,
  resumeQuarantineJob,
  type SessionUser,
  type WorkbenchJobSummary,
  type WorkbenchJobsResponse,
} from "../api/client";
import { WorkbenchActionGate } from "../workbenchActionContext";

const progressingStatuses = new Set(["queued", "running", "reconciling_create"]);
const pollIntervalMs = 2_000;
const pollBudgetMs = 5 * 60_000;

export function JobsView({ user }: { user: SessionUser }) {
  const [state, setState] = useState<WorkbenchJobsResponse>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const generation = useRef(0);
  const request = useRef<AbortController | undefined>(undefined);
  const timer = useRef<number | undefined>(undefined);
  const pollDeadline = useRef(0);
  const actionSequence = useRef(0);
  const actionAdmission = useRef<{ owner: number; token: number } | undefined>(undefined);
  const principalKey = `${user.tenantId ?? ""}:${user.homeAccountId}:${[...user.roles].sort().join(",")}`;

  const stop = useCallback(() => {
    request.current?.abort();
    request.current = undefined;
    if (timer.current !== undefined) window.clearTimeout(timer.current);
    timer.current = undefined;
  }, []);

  const load = useCallback(async (owner: number) => {
    if (request.current) return false;
    const controller = new AbortController();
    request.current = controller;
    try {
      const next = await getWorkbenchJobs({ signal: controller.signal });
      if (owner !== generation.current) return false;
      setState(next);
      setError("");
      const isProgressing = next.value.some(job => progressingStatuses.has(job.status));
      if (isProgressing && pollDeadline.current === 0) pollDeadline.current = Date.now() + pollBudgetMs;
      if (!isProgressing) pollDeadline.current = 0;
      return isProgressing;
    } catch (reason) {
      if (owner !== generation.current || (reason instanceof ApiError && reason.kind === "aborted")) return false;
      if (reason instanceof ApiError && (reason.status === 401 || reason.status === 403)) setState(undefined);
      setError(reason instanceof ApiError
        ? `${reason.message}${reason.requestId ? ` Request ${reason.requestId}.` : ""}`
        : "Job status is unavailable.");
      return false;
    } finally {
      if (request.current === controller) request.current = undefined;
    }
  }, []);

  const startPolling = useCallback((owner: number) => {
    const poll = async () => {
      const progressing = await load(owner);
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
    });
    return () => {
      generation.current += 1;
      stop();
    };
  }, [principalKey, startPolling, stop]);

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
      pollDeadline.current = 0;
      startPolling(owner);
    } catch (reason) {
      if (owner !== generation.current) return;
      if (reason instanceof ApiError && (reason.status === 401 || reason.status === 403)) setState(undefined);
      setError(reason instanceof ApiError
        ? `${reason.message}${reason.requestId ? ` Request ${reason.requestId}.` : ""}`
        : "The job operation failed.");
    } finally {
      if (actionAdmission.current?.token === token) actionAdmission.current = undefined;
      if (owner === generation.current) setBusy("");
    }
  }

  function resume(job: WorkbenchJobSummary) {
    if (job.source === "package-refresh") return resumePackageRefreshJob(job.id);
    if (job.source === "power-platform") return resumeInventoryRefresh(job.id);
    if (job.source === "package-controls") return resumeBulkActionJob(job.id);
    if (job.source === "quarantine") return resumeQuarantineJob(job.id);
    if (job.source === "purview") return resumePurviewAuditSearch(job.id);
    if (job.source === "defender") return resumeDefenderHunt(job.id);
    throw new Error("This job cannot be resumed.");
  }

  function cancel(job: WorkbenchJobSummary) {
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
        <div><span className="eyebrow">Operational metadata</span><h2 id="jobs-heading">Jobs</h2></div>
        <button type="button" className="secondary-button" onClick={() => {
          stop();
          pollDeadline.current = 0;
          startPolling(generation.current);
        }}>Refresh status</button>
      </div>
      <p className="jobs-note">Safe status, correlation, target cardinality, and recovery only. Result rows and staged previews stay in their authorized source views.</p>
      {error ? <div className="error-banner" role="alert">{error}</div> : null}
      {!state ? <div className="screen-state" role="status">Loading authorized job metadata…</div> : null}
      {state?.unavailableSources.length ? (
        <div className="notice" role="status">{state.unavailableSources.length} authorized source{state.unavailableSources.length === 1 ? " is" : "s are"} temporarily unavailable. Other source statuses remain usable.</div>
      ) : null}
      {state && state.value.length === 0 ? <div className="screen-state">No retained jobs are visible to this principal and role set.</div> : null}
      {state?.value.map(job => {
        return (
          <article className="job-card" key={`${job.source}:${job.id}`}>
            <div className="job-card-heading">
              <div><strong>{job.label}</strong><span>{job.target}</span></div>
              <span className={`status-badge status-${job.status.replaceAll("_", "-")}`}>{job.status.replaceAll("_", " ")}</span>
            </div>
            <div className="job-progress">
              <span>{job.completed ?? "—"} / {job.total ?? "—"} complete{job.partial ? " · partial/inconclusive" : ""}</span>
              <span>Updated {new Date(job.updatedAt).toLocaleString()}</span>
            </div>
            <code className="job-id">{job.id}</code>
            <div className="inline-actions">
              <a className="secondary-button" href={job.href}>Open source view</a>
              {job.canResume ? <WorkbenchActionGate actionId={jobActionId(job, "resume")} compact>
                <button type="button" disabled={busy !== ""} onClick={() => void perform(`resume:${job.id}`, () => resume(job))}>
                  {busy === `resume:${job.id}` ? "Resuming…" : "Resume unsent"}
                </button>
              </WorkbenchActionGate> : null}
              {job.canCancel ? <WorkbenchActionGate actionId={jobActionId(job, "cancel")} compact>
                <button type="button" className="danger-button" disabled={busy !== ""} onClick={() => void perform(`cancel:${job.id}`, () => cancel(job))}>
                  {busy === `cancel:${job.id}` ? "Cancelling…" : "Cancel valid unsent"}
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

function jobActionId(job: WorkbenchJobSummary, operation: "resume" | "cancel" | "reconcile") {
  if (job.source === "package-controls") return `packages.${operation}`;
  if (job.source === "quarantine") return `quarantine.${operation}`;
  if (job.source === "purview") return `purview.${operation}`;
  if (job.source === "defender") return `defender.${operation}`;
  if (job.source === "power-platform") return "power-platform.resume";
  if (job.source === "package-refresh") return job.target.startsWith("Current principal") ? "packages.refresh.resume" : "packages.refresh.exact.resume";
  return "usage.staging.cancel";
}
