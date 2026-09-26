import type { WorkbenchJobSummary } from "../api/client";
import { formatSyncInstant, syncDuration, syncStatusLabel } from "./syncPresentation";

export function jobStatusLabel(job: WorkbenchJobSummary) {
  if (job.partial && ["completed", "succeeded"].includes(job.status)) return "Complete with partial results";
  return syncStatusLabel(job.status);
}

export function jobResultCount(job: WorkbenchJobSummary) {
  return job.completed ?? undefined;
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
