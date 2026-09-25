import type {
  AccessAuditAction,
  AuditAction,
  BlockAuditAction,
  BulkActionJob,
  BulkActionResult,
  BulkJobStatus,
  PackageAccessUpdate,
} from "../api/client";
import { CircleStop, LoaderCircle, Play, RefreshCw } from "lucide-react";
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
  progress?: BulkProgress;
  result?: BulkActionResult;
  job?: BulkActionJob;
  jobCommand?: BulkJobCommand;
  jobError?: string;
  selectedCount: number;
  onBlockAll: () => void;
  onManageAccess: () => void;
  onUnblockAll: () => void;
  onJobCommand: (operation: BulkJobCommand) => void;
};

export function BulkActions({
  disabled,
  busyAction,
  progress,
  result,
  job,
  jobCommand,
  jobError,
  selectedCount,
  onBlockAll,
  onManageAccess,
  onUnblockAll,
  onJobCommand,
}: BulkActionsProps) {
  const active = Boolean(busyAction || jobCommand || (job && (isJobPolling(job.status) || job.canResume || job.status === "waiting_authorization")));
  const summary = job ?? progress ?? result;
  const outcomes = job?.results ?? result?.results ?? [];
  const inconclusive = outcomes.filter(item => item.status === "inconclusive").length;
  const cancelled = outcomes.filter(item => item.status === "cancelled").length;
  const needsReconciliation = outcomes.some(item => item.status === "inconclusive" && item.reconciliationStatus === "required");
  const completed = job?.completed ?? progress?.completed;
  const total = summary?.total ?? 0;
  const percent = completed === undefined ? undefined : total === 0 ? 100 : Math.round(completed / total * 100);
  const canCancel = job && (isJobPolling(job.status) || job.canResume);
  const message = job?.status === "waiting_authorization" ? "Sign in again, then resume unprocessed tasks."
    : job?.status === "cancelled" ? "Unprocessed tasks were cancelled. Changes already in progress may still finish."
    : needsReconciliation ? "Check uncertain results before starting another change. This only reads the current provider state."
    : undefined;
  const failedResults =
    outcomes.filter((item) => item.status === "failed" || item.status === "inconclusive");
  const visibleFailures = failedResults.slice(0, 12);
  const hiddenFailureCount = Math.max(
    0,
    failedResults.length - visibleFailures.length,
  );
  const sideEffectErrors = (job ? job.result : result)?.sideEffectErrors ?? [];

  return (
    <section className="bulk-panel" aria-label="Exact package bulk actions">
      <div>
        <h2>Access and availability</h2>
        <PreviewBadge />
        <span className="selected-count">{summary && (active || selectedCount === 0)
          ? `${total.toLocaleString()} published version${total === 1 ? "" : "s"} in this job`
          : <><span>{selectedCount} selected</span> · published versions</>}</span>
      </div>
      {!active && selectedCount > 0 ? <div className="bulk-buttons">
        <WorkbenchActionGate actionId="packages.block">
        <button
          className="danger"
          type="button"
          disabled={disabled || selectedCount === 0}
          onClick={onBlockAll}
        >
          Block selected packages
        </button>
        </WorkbenchActionGate>
        <WorkbenchActionGate actionId="packages.unblock">
        <button
          type="button"
          disabled={disabled || selectedCount === 0}
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
      {summary ? <div className="bulk-job" role="group" aria-label="Package job progress">
        <div className="bulk-job-heading">
          <div className="bulk-job-title">
            <strong>{bulkActionLabel(summary)}</strong>
            <span className="bulk-job-status" data-status={job?.status ?? "queued"} role="status">
              {active && (jobCommand || !job || isJobPolling(job.status)) ? <LoaderCircle className="agent-refresh-spinner" size={15} aria-hidden="true" /> : null}
              {jobCommand === "cancel" ? "Cancelling" : jobCommand === "resume" ? "Resuming"
                : jobCommand === "reconcile" ? "Checking results" : jobCommand === "refresh" ? "Checking status"
                  : job ? jobStateLabels[job.status] : progress ? "Starting" : "Finished"}
            </span>
          </div>
          {job ? <div className="bulk-job-actions">
            {jobError || jobCommand === "refresh" ? <button type="button" className="secondary" disabled={Boolean(jobCommand)}
              onClick={() => onJobCommand("refresh")}>
              <RefreshCw size={16} aria-hidden="true" />{jobCommand === "refresh" ? "Checking status..." : "Refresh status"}
            </button> : null}
            {job.status === "waiting_authorization" ? <a className="primary-link secondary" href="/api/auth/login">Sign in again</a> : null}
            {job.canResume ? <WorkbenchActionGate actionId="packages.resume" compact>
              <button type="button" className="secondary" disabled={Boolean(jobCommand)}
                onClick={() => onJobCommand("resume")} title="Resume only tasks that have not started. Uncertain changes are not replayed.">
                <Play size={16} aria-hidden="true" />{jobCommand === "resume" ? "Resuming..." : "Resume unprocessed tasks"}
              </button>
            </WorkbenchActionGate> : null}
            {needsReconciliation ? <WorkbenchActionGate actionId="packages.reconcile" compact>
              <button type="button" className="secondary" disabled={Boolean(jobCommand) || isJobPolling(job.status)}
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
        {completed !== undefined ? <div className="bulk-progress">
          <div className="bulk-progress-header">
            <span>{completed.toLocaleString()} of {total.toLocaleString()} processed</span>
            <span>{percent}%</span>
          </div>
          <progress value={completed} max={total || 1} aria-label={`${bulkActionLabel(summary)} progress`} />
        </div> : null}
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
        {job?.status === "running" && job.currentAgentName ? <p className="bulk-job-current">Current agent: <strong>{job.currentAgentName}</strong></p> : null}
        {message ? <p className="bulk-job-message">{message}</p> : null}
        {failedResults.length > 0 ? (
          <details className="bulk-failures">
            <summary>Review {failedResults.length} {inconclusive ? "failed or uncertain changes" : "failed changes"}</summary>
            <ul>
              {visibleFailures.map((item) => (
                <li key={item.id}>
                  <span>{item.displayName}</span>
                  <small>{item.message}</small>
                  {item.reconciliationStatus && item.reconciliationStatus !== "not_required" ? <small>Reconciliation: {item.reconciliationStatus.replaceAll("_", " ")}{item.retryEligible ? ". Eligible only for a new explicit preview and confirmation." : ""}</small> : null}
                </li>
              ))}
            </ul>
            {hiddenFailureCount > 0 ? (
              <p>
                {hiddenFailureCount} more failures hidden to keep the page
                readable.
              </p>
            ) : null}
          </details>
        ) : null}
      </div> : null}
      {jobError || job?.error ? <p className="bulk-job-error" role="alert">{jobError ?? job?.error}</p> : null}
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
