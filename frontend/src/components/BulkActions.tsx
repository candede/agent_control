import type {
  AccessAuditAction,
  AuditAction,
  BlockAuditAction,
  BulkActionJob,
  BulkActionResult,
  BulkJobStatus,
  PackageAccessUpdate,
} from "../api/client";
import { CircleStop, LoaderCircle, Play, RefreshCw, X } from "lucide-react";
import { isJobPolling } from "../jobStatus";
import { WorkbenchActionGate } from "../workbenchActionContext";
import { PreviewBadge } from "./PermissionCenter";

export type BulkJobCommand = "resume" | "cancel" | "reconcile" | "refresh";

type BulkProgressBase = {
  total: number;
  completed: number;
  succeeded: number;
  failed: number;
  skipped: number;
  currentAgentName?: string;
};

export type BulkProgress = BulkProgressBase &
  (
    | {
        action: BlockAuditAction;
        targetBlockedState: boolean;
        accessUpdate?: never;
      }
    | {
        action: AccessAuditAction;
        targetBlockedState?: never;
        accessUpdate: PackageAccessUpdate;
      }
  );

type BulkActionsProps = {
  disabled: boolean;
  busyAction?: AuditAction;
  preparingAction?: BlockAuditAction;
  progress?: BulkProgress;
  result?: BulkActionResult;
  job?: BulkActionJob;
  jobId?: string;
  jobCommand?: BulkJobCommand;
  jobError?: string;
  statusUnrecognized?: boolean;
  selectedCount: number;
  onBlockAll: () => void;
  onManageAccess: () => void;
  onUnblockAll: () => void;
  onJobCommand: (operation: BulkJobCommand) => void;
  onDismiss: () => void;
};

export function BulkActions({
  disabled,
  busyAction,
  preparingAction,
  progress,
  result,
  job,
  jobId,
  jobCommand,
  jobError,
  statusUnrecognized = false,
  selectedCount,
  onBlockAll,
  onManageAccess,
  onUnblockAll,
  onJobCommand,
  onDismiss,
}: BulkActionsProps) {
  const active = Boolean(busyAction || jobCommand || statusUnrecognized || (job && (isJobPolling(job.status) || job.canResume || job.status === "waiting_authorization")));
  const summary = job ?? progress ?? result;
  const outcomes = job ? [] : result?.results ?? [];
  const inconclusive = job?.inconclusive ?? outcomes.filter(item => item.status === "inconclusive").length;
  const cancelled = job?.cancelled ?? outcomes.filter(item => item.status === "cancelled").length;
  const needsReconciliation = job ? job.reconciliationRequired > 0 : outcomes.some(item => item.status === "inconclusive" && item.reconciliationStatus === "required");
  const completed = job?.completed ?? progress?.completed;
  const total = summary?.total ?? 0;
  const percent = completed === undefined ? undefined : total === 0 ? 100 : Math.round(completed / total * 100);
  const canCancel = job && !job.cancelRequested && (isJobPolling(job.status) || job.canResume);
  const statusUnavailable = statusUnrecognized || Boolean(job && isJobPolling(job.status) && jobError && !busyAction && !jobCommand);
  const canDismiss = Boolean(summary && !active && (!needsReconciliation || job?.cancelRequested));
  const showProgress = completed !== undefined && active;
  const currentAgentName = job?.status === "running" ? job.currentAgentName : !job ? progress?.currentAgentName : undefined;
  const message = job?.cancelRequested ? `Cancellation was requested. Changes already in progress may still finish.${needsReconciliation ? " Uncertain results remain recorded, but cancelled jobs cannot be reconciled or resumed." : ""}`
    : job?.status === "waiting_authorization" ? "Sign in again, then resume unprocessed tasks."
    : job?.status === "cancelled" ? "Unprocessed tasks were cancelled. Changes already in progress may still finish."
    : needsReconciliation ? "Check uncertain results before starting another change. This only reads the current provider state."
    : undefined;
  const sideEffectErrors = job ? [] : result?.sideEffectErrors ?? [];

  return (
    <section className={`bulk-panel${summary ? " bulk-panel-has-job" : ""}`} aria-label="Exact package bulk actions">
      <div className="bulk-panel-heading">
        <div className="bulk-panel-title">
          <h2>Access and availability</h2>
          <PreviewBadge />
          <span className="selected-count">{summary && (active || selectedCount === 0)
            ? `${total.toLocaleString()} published version${total === 1 ? "" : "s"} in this job`
            : <><span>{selectedCount} selected</span> · published versions</>}</span>
        </div>
        {canDismiss ? <button type="button" className="secondary icon-button bulk-job-dismiss"
          aria-label="Close job summary" title="Close job summary" onClick={onDismiss}>
          <X size={18} aria-hidden="true" />
        </button> : null}
      </div>
      {!active && selectedCount > 0 ? <div className="bulk-buttons">
        <WorkbenchActionGate actionId="packages.block">
        <button
          className="danger"
          type="button"
          disabled={disabled || selectedCount === 0 || preparingAction === "block"}
          onClick={onBlockAll}
        >
          Block selected packages
        </button>
        </WorkbenchActionGate>
        <WorkbenchActionGate actionId="packages.unblock">
        <button
          type="button"
          disabled={disabled || selectedCount === 0 || preparingAction === "unblock"}
          onClick={onUnblockAll}
        >
          Unblock selected packages
        </button>
        </WorkbenchActionGate>
        <WorkbenchActionGate actionId="packages.access">
          <button
            type="button"
            className="secondary"
            disabled={disabled || selectedCount === 0}
            onClick={onManageAccess}
          >
            Manage access
          </button>
        </WorkbenchActionGate>
      </div> : null}
      {preparingAction ? <p role="status">Preparing {preparingAction} preview…</p> : null}
      {!job && jobId && (jobError || jobCommand === "refresh") ? <button type="button" className="secondary"
        disabled={Boolean(jobCommand)} onClick={() => onJobCommand("refresh")}>
        {jobCommand === "refresh" ? "Checking status..." : "Refresh status"}
      </button> : null}
      {summary ? <div className="bulk-job" role="group" aria-label="Package job progress">
        <div className="bulk-job-heading">
          <div className="bulk-job-title">
            <strong>{bulkActionLabel(summary)}</strong>
            <span className="bulk-job-status" data-status={job?.status ?? "queued"} role="status">
              {active && !statusUnavailable && (jobCommand || !job || isJobPolling(job.status)) ? <LoaderCircle className="agent-refresh-spinner" size={15} aria-hidden="true" /> : null}
              {jobCommand === "cancel" ? "Cancelling" : jobCommand === "resume" ? "Resuming"
                : jobCommand === "reconcile" ? "Checking results" : jobCommand === "refresh" ? "Checking status"
                  : job ? `${statusUnavailable ? "Last reported: " : ""}${jobStateLabels[job.status]}` : progress ? "Starting" : "Finished"}
            </span>
          </div>
          {job ? <div className="bulk-job-actions">
            {jobError || jobCommand === "refresh" ? <button type="button" className="secondary" disabled={Boolean(jobCommand)}
              onClick={() => onJobCommand("refresh")}>
              <RefreshCw size={16} aria-hidden="true" />{jobCommand === "refresh" ? "Checking status..." : "Refresh status"}
            </button> : null}
            {job.status === "waiting_authorization" ? <a className="primary-link secondary" href="/api/auth/login">Sign in again</a> : null}
            {job.canResume ? <WorkbenchActionGate actionId="packages.resume" compact>
              <button type="button" className="secondary" disabled={Boolean(jobCommand) || statusUnrecognized}
                onClick={() => onJobCommand("resume")} title="Resume only tasks that have not started. Uncertain changes are not replayed.">
                <Play size={16} aria-hidden="true" />{jobCommand === "resume" ? "Resuming..." : "Resume unprocessed tasks"}
              </button>
            </WorkbenchActionGate> : null}
            {needsReconciliation && !job.cancelRequested ? <WorkbenchActionGate actionId="packages.reconcile" compact>
              <button type="button" className="secondary" disabled={Boolean(jobCommand) || statusUnrecognized || isJobPolling(job.status)}
                onClick={() => onJobCommand("reconcile")} title="Read the provider state to check uncertain outcomes. No changes are retried.">
                <RefreshCw size={16} aria-hidden="true" />{jobCommand === "reconcile" ? "Checking results..." : "Check uncertain results"}
              </button>
            </WorkbenchActionGate> : null}
            {canCancel ? <WorkbenchActionGate actionId="packages.cancel" compact>
              <button type="button" className="secondary bulk-job-cancel" disabled={Boolean(jobCommand)}
                onClick={() => onJobCommand("cancel")} title="Cancel tasks that have not started. Completed changes are kept; changes already in progress may still finish.">
                <CircleStop size={16} aria-hidden="true" />{jobCommand === "cancel" ? "Cancelling..." : "Cancel unprocessed tasks"}
              </button>
            </WorkbenchActionGate> : null}
          </div> : null}
        </div>
        {showProgress ? <div className="bulk-progress">
          <div className="bulk-progress-header">
            {currentAgentName ? <span className="bulk-job-current" title={currentAgentName}>
              {statusUnavailable ? "Last reported agent" : "Current agent"}: <strong>{currentAgentName}</strong>
            </span> : null}
            <span className="bulk-progress-count"><span>{completed.toLocaleString()} of {total.toLocaleString()} processed</span><span>{percent}%</span></span>
          </div>
          <progress value={completed} max={total || 1} aria-label={`${bulkActionLabel(summary)} progress`} />
        </div> : null}
        {message ? <p className="bulk-job-message">{message}</p> : null}
        {jobError || job?.error ? <p className="bulk-job-error" role="alert">{jobError ?? job?.error}</p> : null}
        <div className="bulk-progress-meta">
          <span>{summary.succeeded} succeeded</span>
          <span>{summary.failed} failed</span>
          <span>{summary.skipped} skipped</span>
          {inconclusive > 0 ? <span>{inconclusive} uncertain</span> : null}
          {cancelled > 0 ? <span>{cancelled} cancelled</span> : null}
          {sideEffectErrors.length > 0 ? (
            <span>{sideEffectErrors.length} audit/progress errors</span>
          ) : null}
        </div>
      </div> : null}
      {!summary && jobError ? <p className="bulk-job-error" role="alert">{jobError}</p> : null}
    </section>
  );
}

const jobStateLabels: Record<BulkJobStatus, string> = {
  queued: "Queued", running: "Running", waiting_authorization: "Sign-in required",
  succeeded: "Completed", failed: "Failed", cancelled: "Cancelled", partial: "Needs review",
};

function bulkActionLabel(result: BulkActionResult | BulkProgress | BulkActionJob) {
  if (result.accessUpdate) {
    return result.accessUpdate.target === "availability"
      ? "Update availability"
      : "Update installation";
  }

  return result.targetBlockedState ? "Block packages" : "Unblock packages";
}
