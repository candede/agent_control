import { useCallback, useEffect, useId, useRef, useState } from "react";
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
import { useSavedRead } from "../savedQueries";
import { JobHistoryView } from "./JobHistoryView";
import { jobKey } from "./jobPresentation";
import { SyncHistoryTable } from "./SyncHistoryTable";

const progressingStatuses = new Set(["queued", "running", "reconciling_create"]);
const pollIntervalMs = 2_000;
const pollBudgetMs = 5 * 60_000;
const syncJobSources = new Set<WorkbenchJobSource>(["data-sync", "package-refresh", "power-platform", "official-usage"]);

export function JobsView({ user, scope = "all", onOpenSyncRun, onChanged, onCollectionCancel, revision = 0 }: {
  user: SessionUser;
  scope?: "all" | "sync";
  onOpenSyncRun?: (runId: string) => void;
  onChanged?: () => void;
  onCollectionCancel?: () => void;
  revision?: number;
}) {
  const [state, setState] = useState<WorkbenchJobsResponse>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [loading, setLoading] = useState(true);
  const [pollingPaused, setPollingPaused] = useState(false);
  const generation = useRef(0);
  const pollingGeneration = useRef(0);
  const request = useRef<AbortController | undefined>(undefined);
  const timer = useRef<number | undefined>(undefined);
  const pollDeadline = useRef(0);
  const actionSequence = useRef(0);
  const actionRevision = useRef(0);
  const actionAdmission = useRef<{ owner: number; token: number } | undefined>(undefined);
  const readOwner = useId();
  const loadedRevision = useRef(revision);
  const readSaved = useSavedRead();
  const principalKey = `${user.tenantId ?? ""}:${user.homeAccountId}:${[...user.roles].sort().join(",")}`;
  const canManageMutationJobs = hasRole(user, "AgentControl.Admin");
  const isVisibleJob = useCallback((job: WorkbenchJobSummary) =>
    (scope === "all" || syncJobSources.has(job.source)) && (canManageMutationJobs || isReadJob(job)),
  [scope, canManageMutationJobs]);
  const authorizedJobs = state?.value.filter(isVisibleJob);

  const stop = useCallback(() => {
    pollingGeneration.current += 1;
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
      const next = await readSaved(
        ["workbench-jobs", principalKey, revision, actionRevision.current ? `${readOwner}:${actionRevision.current}` : 0],
        signal => getWorkbenchJobs({ signal }),
        controller.signal,
      );
      if (controller.signal.aborted || owner !== generation.current) return false;
      setState(next);
      if (!preserveActionError) setError("");
      const isProgressing = next.value.some(job =>
        isVisibleJob(job)
        && (progressingStatuses.has(job.status) || (job.source === "data-sync" && job.status === "waiting")));
      if (scope === "all" && isProgressing && pollDeadline.current === 0) pollDeadline.current = Date.now() + pollBudgetMs;
      if (!isProgressing) pollDeadline.current = 0;
      return isProgressing;
    } catch (reason) {
      if (controller.signal.aborted || owner !== generation.current || (reason instanceof ApiError && reason.kind === "aborted")) return false;
      const denied = reason instanceof ApiError && (reason.status === 401 || reason.status === 403);
      if (denied) setState(undefined);
      const message = reason instanceof ApiError
        ? `${reason.message}${reason.requestId ? ` Request ${reason.requestId}.` : ""}`
        : "Job status is unavailable.";
      setError(current => preserveActionError && !denied && current ? current : message);
      return false;
    } finally {
      if (request.current === controller) request.current = undefined;
      if (!controller.signal.aborted && owner === generation.current) setLoading(false);
    }
  }, [isVisibleJob, principalKey, readOwner, readSaved, revision, scope]);

  const startPolling = useCallback((owner: number, preserveActionError = false) => {
    const pollingOwner = pollingGeneration.current;
    setPollingPaused(false);
    const poll = async () => {
      const progressing = await load(owner, preserveActionError);
      if (owner !== generation.current || pollingOwner !== pollingGeneration.current || !progressing) return;
      if (scope === "sync" || Date.now() < pollDeadline.current) timer.current = window.setTimeout(() => void poll(), pollIntervalMs);
      else {
        pollDeadline.current = 0;
        setPollingPaused(true);
      }
    };
    return poll();
  }, [load, scope]);

  useEffect(() => {
    generation.current += 1;
    const owner = generation.current;
    actionAdmission.current = undefined;
    stop();
    if (loadedRevision.current !== revision) actionRevision.current += 1;
    loadedRevision.current = revision;
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
    // A post-action status check must not join a GET admitted before the mutation.
    actionRevision.current += 1;
    let actionFailed = false;
    let denied = false;
    try {
      await operation();
      if (owner !== generation.current) return;
      onChanged?.();
    } catch (reason) {
      if (owner !== generation.current) return;
      actionFailed = true;
      denied = reason instanceof ApiError && (reason.status === 401 || reason.status === 403);
      if (denied) {
        setState(undefined);
        setLoading(false);
      }
      setError(reason instanceof ApiError
        ? `${reason.message}${reason.requestId ? ` Request ${reason.requestId}.` : ""}`
        : "The job operation failed.");
      if (!denied) onChanged?.();
    } finally {
      if (owner === generation.current && !denied) {
        actionRevision.current += 1;
        stop();
        pollDeadline.current = 0;
        await startPolling(owner, actionFailed);
      }
      if (actionAdmission.current?.token === token) actionAdmission.current = undefined;
      if (owner === generation.current) setBusy("");
    }
  }

  function refresh() {
    if (actionAdmission.current?.owner === generation.current) return;
    actionRevision.current += 1;
    stop();
    pollDeadline.current = 0;
    void startPolling(generation.current);
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
    if (["data-sync", "package-refresh", "power-platform"].includes(job.source)) onCollectionCancel?.();
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
    <SyncHistoryTable key={principalKey} state={state} error={error} loading={loading}
      onOpenSyncRun={onOpenSyncRun} onRefresh={refresh} />
  );

  return <JobHistoryView key={principalKey}
    state={state ? { ...state, value: authorizedJobs ?? [] } : undefined}
    error={error} loading={loading} busy={busy} pollingPaused={pollingPaused} onOpenSyncRun={onOpenSyncRun}
    onRefresh={refresh}
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
