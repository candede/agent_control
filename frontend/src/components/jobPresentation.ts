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
  return formatSyncInstant(value);
}

export function jobDuration(job: WorkbenchJobSummary) {
  return syncDuration(job.startedAt, job.completedAt);
}
