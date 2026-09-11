import type { BulkJobStatus } from "./api/client";

export function isJobPolling(status: BulkJobStatus) { return status === "queued" || status === "running"; }
export function jobStatusMessage(status: BulkJobStatus) {
  switch (status) {
    case "waiting_authorization": return "Waiting for sign-in and explicit resume approval.";
    case "partial": return "Partially finished. Inconclusive changes require reconciliation before another attempt.";
    case "cancelled": return "Cancelled. Already dispatched changes may have finished.";
    case "failed": return "The job failed.";
    default: return undefined;
  }
}