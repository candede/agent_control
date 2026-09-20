import { useCallback, useEffect, useRef, useState } from "react";
import {
  ApiError,
  cancelBulkActionJob,
  cancelDataSyncRun,
  cancelDefenderHunt,
  cancelInventoryRefresh,
  cancelPackageRefreshJob,
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
import { JobHistoryView } from "./JobHistoryView";
import { jobKey } from "./jobPresentation";
import { SyncHistoryTable } from "./SyncHistoryTable";

const progressingStatuses = new Set(["queued", "running", "reconciling_create"]);
const pollIntervalMs = 2_000;
const pollBudgetMs = 5 * 60_000;
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
  const [loading, setLoading] = useState(true);
  const [pollingPaused, setPollingPaused] = useState(false);
  const generation = useRef(0);
  const request = useRef<AbortController | undefined>(undefined);
  const timer = useRef<number | undefined>(undefined);
  const pollDeadline = useRef(0);
  const actionSequence = useRef(0);
  const actionAdmission = useRef<{ owner: number; token: number } | undefined>(undefined);
  const principalKey = `${user.tenantId ?? ""}:${user.homeAccountId}:${[...user.roles].sort().join(",")}`;
  const canManageMutationJobs = hasRole(user, "AgentControl.Admin");
  const isVisibleJob = useCallback((job: WorkbenchJobSummary) =>
    (scope === "all" || syncJobSources.has(job.source)) && (canManageMutationJobs || isReadJob(job)),
  [scope, canManageMutationJobs]);
  const authorizedJobs = state?.value.filter(isVisibleJob);

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
    setLoading(true);
    try {
      const next = await getWorkbenchJobs({ signal: controller.signal });
      if (controller.signal.aborted || owner !== generation.current) return false;
      setState(next);
      if (!preserveActionError) setError("");
      const isProgressing = next.value.some(job =>
        isVisibleJob(job)
        && (progressingStatuses.has(job.status) || (job.source === "data-sync" && job.status === "waiting")));
      if (isProgressing && pollDeadline.current === 0) pollDeadline.current = Date.now() + pollBudgetMs;
      if (!isProgressing) pollDeadline.current = 0;
      return isProgressing;
    } catch (reason) {
      if (controller.signal.aborted || owner !== generation.current || (reason instanceof ApiError && reason.kind === "aborted")) return false;
      if (reason instanceof ApiError && (reason.status === 401 || reason.status === 403)) setState(undefined);
      const message = reason instanceof ApiError
        ? `${reason.message}${reason.requestId ? ` Request ${reason.requestId}.` : ""}`
        : "Job status is unavailable.";
      setError(current => preserveActionError && current ? current : message);
      return false;
    } finally {
      if (request.current === controller) request.current = undefined;
      if (!controller.signal.aborted && owner === generation.current) setLoading(false);
    }
  }, [isVisibleJob]);

  const startPolling = useCallback((owner: number, preserveActionError = false) => {
    setPollingPaused(false);
    const poll = async () => {
      const progressing = await load(owner, preserveActionError);
      if (owner !== generation.current || !progressing) return;
      if (Date.now() < pollDeadline.current) timer.current = window.setTimeout(() => void poll(), pollIntervalMs);
      else {
        pollDeadline.current = 0;
        setPollingPaused(true);
      }
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
    if (job.source === "package-refresh") return resumePackageRefreshJob(job.id, job.tokenMode);
    if (job.source === "power-platform") return resumeInventoryRefresh(job.id);
    if (job.source === "package-controls") return resumeBulkActionJob(job.id);
    if (job.source === "quarantine") return resumeQuarantineJob(job.id);
    if (job.source === "purview") return resumePurviewAuditSearch(job.id);
    if (job.source === "defender") return resumeDefenderHunt(job.id);
    throw new Error("This job cannot be resumed.");
  }

  function cancel(job: WorkbenchJobSummary) {
    if (job.source === "data-sync") return cancelDataSyncRun(job.id);
    if (job.source === "package-refresh") return cancelPackageRefreshJob(job.id, job.tokenMode);
    if (job.source === "power-platform") return cancelInventoryRefresh(job.id);
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

  if (scope === "sync") return (
    <SyncHistoryTable state={state} error={error} pollingPaused={pollingPaused} onOpenSyncRun={onOpenSyncRun} onRefresh={() => {
      stop();
      pollDeadline.current = 0;
      startPolling(generation.current);
    }} />
  );

  return <JobHistoryView key={principalKey}
    state={state ? { ...state, value: authorizedJobs ?? [] } : undefined}
    error={error} loading={loading} busy={busy} pollingPaused={pollingPaused} onOpenSyncRun={onOpenSyncRun}
    onRefresh={() => {
      stop();
      pollDeadline.current = 0;
      startPolling(generation.current);
    }}
    onAction={(job, operation) => {
      const actions = { resume: () => resume(job), cancel: () => cancel(job), reconcile: () => reconcile(job) };
      void perform(`${operation}:${jobKey(job)}`, actions[operation]);
    }}
  />;
}

function isReadJob(job: WorkbenchJobSummary) {
  return job.source === "data-sync"
    || job.source === "package-refresh"
    || job.source === "power-platform"
    || job.source === "purview"
    || job.source === "defender";
}
