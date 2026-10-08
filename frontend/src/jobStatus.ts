import type { BulkJobStatus } from "./api/client";

const statusMessages: Record<BulkJobStatus, string | undefined> = {
  queued: undefined,
  running: undefined,
  waiting_authorization: "Waiting for sign-in and explicit resume approval.",
  succeeded: undefined,
  failed: "The job failed.",
  cancelled: "Cancelled. Already dispatched changes may have finished.",
  partial: "Partially finished. Inconclusive changes require reconciliation before another attempt.",
};

export function isKnownJobStatus(status: unknown): status is BulkJobStatus {
  return typeof status === "string" && Object.hasOwn(statusMessages, status);
}

export function isJobPolling(status: unknown) {
  return status === "queued" || status === "running";
}

export function jobStatusMessage(status: unknown) {
  return isKnownJobStatus(status) ? statusMessages[status]
    : "The server returned an unrecognized job status. Refresh status before starting another change.";
}