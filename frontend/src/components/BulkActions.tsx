import type { BulkActionResult } from "../api/client";
import type { ReactNode } from "react";

type BulkProgress = {
  action: "block" | "unblock";
  targetBlockedState: boolean;
  total: number;
  completed: number;
  succeeded: number;
  failed: number;
  skipped: number;
  currentAgentName?: string;
};

type BulkActionsProps = {
  disabled: boolean;
  activityProgress?: ReactNode;
  busyAction?: "block" | "unblock";
  progress?: BulkProgress;
  result?: BulkActionResult;
  selectedCount: number;
  onBlockAll: () => void;
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
  onUnblockAll,
}: BulkActionsProps) {
  const failedResults =
    result?.results.filter((item) => item.status === "failed") ?? [];
  const visibleFailures = failedResults.slice(0, 12);
  const hiddenFailureCount = Math.max(
    0,
    failedResults.length - visibleFailures.length,
  );

  return (
    <section className="bulk-panel" aria-label="Bulk actions">
      <div>
        <h2>Tenant-wide controls</h2>
        <p>
          Select agents in the table, then run a one-at-a-time bulk change with
          live progress.
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
      </div>
      {progress ? <BulkProgressMeter progress={progress} /> : null}
      {activityProgress}
      {result ? (
        <div className="bulk-result">
          <strong>
            {result.targetBlockedState ? "Block selected" : "Unblock selected"}{" "}
            result
          </strong>
          <span>{result.succeeded} succeeded</span>
          <span>{result.skipped} skipped</span>
          <span>{result.failed} failed</span>
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
  const actionLabel = progress.targetBlockedState ? "Blocking" : "Unblocking";
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
