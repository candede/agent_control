import type {
  AccessAuditAction,
  AuditAction,
  BlockAuditAction,
  BulkActionResult,
  PackageAccessUpdate,
} from "../api/client";
import type { ReactNode } from "react";

const showManageAccessActions = false;

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
  activityProgress?: ReactNode;
  busyAction?: AuditAction;
  progress?: BulkProgress;
  result?: BulkActionResult;
  selectedCount: number;
  onBlockAll: () => void;
  onManageAccess: () => void;
  onUnblockAll: () => void;
};

export function BulkActions({
  disabled,
  activityProgress,
  busyAction,
  progress,
  result,
  selectedCount,
  onBlockAll,
  onManageAccess,
  onUnblockAll,
}: BulkActionsProps) {
  const failedResults =
    result?.results.filter((item) => item.status === "failed") ?? [];
  const visibleFailures = failedResults.slice(0, 12);
  const hiddenFailureCount = Math.max(
    0,
    failedResults.length - visibleFailures.length,
  );
  const sideEffectErrors = result?.sideEffectErrors ?? [];

  return (
    <section className="bulk-panel" aria-label="Bulk actions">
      <div>
        <h2>Tenant-wide controls</h2>
        <p>
          Select agents in the table, then run a server-side bulk change with
          throttling-aware retries.
        </p>
        <span className="selected-count">{selectedCount} selected</span>
      </div>
      <div className="bulk-buttons">
        <button
          className="danger"
          type="button"
          disabled={disabled || selectedCount === 0}
          onClick={onBlockAll}
        >
          {busyAction === "block" ? "Blocking selected" : "Block selected"}
        </button>
        <button
          type="button"
          disabled={disabled || selectedCount === 0}
          onClick={onUnblockAll}
        >
          {busyAction === "unblock"
            ? "Unblocking selected"
            : "Unblock selected"}
        </button>
        {showManageAccessActions ? (
          <button
            type="button"
            className="secondary"
            disabled={disabled || selectedCount === 0}
            onClick={onManageAccess}
          >
            {busyAction === "update-availability" ||
            busyAction === "update-installation"
              ? "Updating access"
              : "Manage access"}
          </button>
        ) : null}
      </div>
      {progress ? <BulkProgressMeter progress={progress} /> : null}
      {activityProgress}
      {result ? (
        <div className="bulk-result">
          <strong>{bulkResultLabel(result)} result</strong>
          <span>{result.succeeded} succeeded</span>
          <span>{result.skipped} skipped</span>
          <span>{result.failed} failed</span>
          {sideEffectErrors.length > 0 ? (
            <span>{sideEffectErrors.length} audit/progress errors</span>
          ) : null}
          {failedResults.length > 0 ? (
            <details className="bulk-failures">
              <summary>Review {failedResults.length} failed changes</summary>
              <ul>
                {visibleFailures.map((item) => (
                  <li key={item.id}>
                    <span>{item.displayName}</span>
                    <small>{item.message}</small>
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
        </div>
      ) : null}
    </section>
  );
}

function BulkProgressMeter({ progress }: { progress: BulkProgress }) {
  const actionLabel = bulkProgressLabel(progress);
  const completedPercent =
    progress.total === 0
      ? 100
      : Math.round((progress.completed / progress.total) * 100);

  return (
    <div className="bulk-progress" role="status" aria-live="polite">
      <div className="bulk-progress-header">
        <strong>
          {actionLabel} {progress.completed} of {progress.total}
        </strong>
        <span>{completedPercent}%</span>
      </div>
      <progress value={progress.completed} max={progress.total || 1} />
      <div className="bulk-progress-meta">
        <span>{progress.succeeded} succeeded</span>
        <span>{progress.failed} failed</span>
        <span>{progress.skipped} skipped</span>
      </div>
      {progress.currentAgentName ? (
        <p>Working on {progress.currentAgentName}</p>
      ) : null}
    </div>
  );
}

function bulkResultLabel(result: BulkActionResult) {
  if (result.accessUpdate) {
    return result.accessUpdate.target === "availability"
      ? "Update availability"
      : "Update installation";
  }

  return result.targetBlockedState ? "Block selected" : "Unblock selected";
}

function bulkProgressLabel(progress: BulkProgress) {
  if (progress.accessUpdate) {
    return progress.accessUpdate.target === "availability"
      ? "Updating availability"
      : "Updating installation";
  }

  return progress.targetBlockedState ? "Blocking" : "Unblocking";
}
