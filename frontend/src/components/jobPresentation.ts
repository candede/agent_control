import type { WorkbenchJobSummary } from "../api/client";
import { formatSyncInstant, syncDuration } from "./syncPresentation";

export function jobStatusLabel(job: WorkbenchJobSummary) {
  const labels: Record<string, string> = {
    queued: "Queued", running: "Running", reconciling_create: "Checking provider state",
    waiting: "Waiting for input", waiting_authorization: "Sign-in required",
    permission_required: "Permission required", awaiting_upload: "Import needed",
    completed: "Complete", succeeded: "Complete", accepted: "Accepted",
    partial: "Incomplete", inconclusive: "Inconclusive", failed: "Failed",
    cancelled: "Cancelled", discarded: "Discarded", expired: "Expired",
  };
  if (job.source === "official-usage" && job.status === "active") return "Ready for review";
  if (job.partial && ["completed", "succeeded", "accepted"].includes(job.status)) return "Complete with partial results";
  return Object.hasOwn(labels, job.status) ? labels[job.status] : job.status.replaceAll("_", " ");
}

export function jobResultCount(job: WorkbenchJobSummary) {
  return (job.source === "official-usage" ? job.total ?? job.completed : job.completed) ?? undefined;
}

export function formatJobInstant(value?: string) {
  return value && Number.isFinite(Date.parse(value)) ? formatSyncInstant(value) : "Not recorded";
}

export function jobDuration(job: WorkbenchJobSummary) {
  const start = Date.parse(job.startedAt ?? "");
  const end = Date.parse(job.completedAt ?? "");
  return Number.isFinite(start) && Number.isFinite(end) && end >= start
    ? syncDuration(job.startedAt!, job.completedAt!) : "Not recorded";
}
