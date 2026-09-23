import type { WorkbenchJobSource, WorkbenchJobSummary } from "../api/client";
import { dataSyncRouteSearch, parseSyncReportRoute, workbenchUrl } from "../workbenchRouting";
import { formatSyncInstant, syncDuration } from "./syncPresentation";

export type JobOperation = "resume" | "cancel" | "reconcile";
export type JobOutcome = "complete" | "incomplete" | "failed" | "cancelled" | "expired" | "other";

export const jobSourceLabels: Record<WorkbenchJobSource, string> = {
  "data-sync": "Data sync",
  "package-refresh": "Package refresh",
  "package-controls": "Package controls",
  "power-platform": "Power Platform",
  "official-usage": "CSV imports",
  purview: "Purview audit",
  defender: "Defender",
  quarantine: "Quarantine",
};

export function jobKey(job: WorkbenchJobSummary) {
  return `${job.source}:${job.id}`;
}

export function jobPhase(job: WorkbenchJobSummary): "progress" | "waiting" | "history" {
  if (["queued", "running", "reconciling_create"].includes(job.status)) return "progress";
  if (["waiting", "waiting_authorization", "permission_required", "awaiting_upload"].includes(job.status)
    || (job.source === "official-usage" && job.status === "active")) return "waiting";
  return "history";
}

export function jobOutcome(job: WorkbenchJobSummary): JobOutcome {
  if (job.status === "failed") return "failed";
  if (job.status === "cancelled" || job.status === "discarded") return "cancelled";
  if (job.status === "expired") return "expired";
  if (job.partial || job.status === "partial" || job.status === "inconclusive") return "incomplete";
  if (["completed", "succeeded", "accepted"].includes(job.status)) return "complete";
  return "other";
}

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

export function jobResultLabel(job: WorkbenchJobSummary) {
  const value = jobResultCount(job);
  if (value === undefined) return "Count not reported";
  if (job.source === "official-usage") {
    return `${value.toLocaleString()} ${countUnit("row", value)} ${job.status === "accepted" ? "accepted" : "validated"}`;
  }
  const completed = value.toLocaleString();
  const total = job.total?.toLocaleString();
  const count = total === undefined ? completed : `${completed} of ${total}`;
  if (job.source === "data-sync") return `${count} ${countUnit("source", job.total ?? job.completed)} complete`;
  if (job.source === "package-controls" || job.source === "quarantine") return `${count} ${countUnit("target", job.total ?? job.completed)} processed`;
  if (job.source === "purview" || job.source === "defender") return `${completed} ${countUnit("row", job.completed)} retained`;
  const unit = job.source === "package-refresh" ? "package" : "resource";
  return job.status === "succeeded" && !job.partial ? `${completed} ${countUnit(unit, job.completed)} saved`
    : `${count} ${countUnit(unit, job.total ?? job.completed)} observed`;
}

function countUnit(unit: string, count: number | null) {
  return count === 1 ? unit : `${unit}s`;
}

export function jobResultExplanation(job: WorkbenchJobSummary) {
  switch (job.source) {
    case "data-sync": return "Counts refer to sources completed in this run, not the current workspace. A run and its underlying source jobs are separate records, not additive totals.";
    case "package-refresh":
    case "power-platform": return "Observed counts do not prove the refresh succeeded. Failed or stopped attempts are separate from the last successful saved inventory.";
    case "package-controls":
    case "quarantine": return "Processed targets can include failures and inconclusive changes. Inspect the source job for per-target outcomes and provider readback; a processed count is not a success count.";
    case "purview":
    case "defender": return "Counts are retained investigation rows, not usage metrics. The source view contains the exact query window, coverage and authorized results.";
    case "official-usage": return "This record describes one validated CSV file, not a complete report snapshot. Report history contains the accepted bundles. Overlapping snapshots must not be added together.";
  }
}

export function jobRecordDate(job: WorkbenchJobSummary) {
  for (const [label, value] of [["Created", job.createdAt], ["Started", job.startedAt], ["Updated", job.updatedAt]] as const) {
    if (value && Number.isFinite(Date.parse(value))) return { label, value, timestamp: Date.parse(value) };
  }
  return { label: "Not recorded", value: undefined, timestamp: Number.NEGATIVE_INFINITY };
}

export function compareJobDates(left: WorkbenchJobSummary, right: WorkbenchJobSummary, newestFirst = true) {
  const leftTime = jobRecordDate(left).timestamp;
  const rightTime = jobRecordDate(right).timestamp;
  if (leftTime === rightTime) return jobKey(left).localeCompare(jobKey(right));
  if (leftTime === Number.NEGATIVE_INFINITY) return 1;
  if (rightTime === Number.NEGATIVE_INFINITY) return -1;
  return (leftTime > rightTime ? -1 : 1) * (newestFirst ? 1 : -1);
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

export function jobSourceHref(job: WorkbenchJobSummary) {
  if (job.source === "data-sync") return `/sync?syncRun=${encodeURIComponent(job.id)}`;
  if (job.source === "official-usage") {
    const params = new URL(job.href, "https://agent-control.invalid").searchParams;
    params.set("reports", job.status === "active" ? "import" : params.has("snapshot") ? "snapshot" : "manage");
    const reports = parseSyncReportRoute(params.toString());
    return workbenchUrl("sync", dataSyncRouteSearch({ refreshMode: "delegated", reports }));
  }
  return job.href;
}

export function jobSourceLinkLabel(job: WorkbenchJobSummary) {
  switch (job.source) {
    case "data-sync": return "Open sync details";
    case "package-refresh": return "Open package refresh";
    case "power-platform": return "Open Power Platform refresh";
    case "package-controls": return "Open package controls";
    case "quarantine": return "Open quarantine job";
    case "purview": return "Open audit search";
    case "defender": return "Open investigation";
    case "official-usage": return job.status === "active" ? "Review CSV import"
      : new URL(jobSourceHref(job), "https://agent-control.invalid").searchParams.has("snapshot") ? "View snapshot" : "Manage reports";
  }
}

export function jobActionAvailable(job: WorkbenchJobSummary, operation: JobOperation) {
  if (operation === "resume") return job.canResume && job.source !== "official-usage";
  if (operation === "reconcile") return job.canReconcile && (job.source === "package-controls" || job.source === "quarantine");
  return job.canCancel;
}

export function jobActionId(job: WorkbenchJobSummary, operation: JobOperation) {
  if (job.source === "data-sync") return operation === "resume" ? "data-sync.retry" : "data-sync.cancel";
  if (job.source === "package-controls") return `packages.${operation}`;
  if (job.source === "quarantine") return `quarantine.${operation}`;
  if (job.source === "purview") return `purview.${operation}`;
  if (job.source === "defender") return `defender.${operation}`;
  if (job.source === "power-platform") return `power-platform.${operation}`;
  if (job.source === "package-refresh") return operation === "cancel" ? "packages.refresh.cancel"
    : job.tokenMode === "application" ? "packages.refresh.application.resume"
      : job.target.startsWith("Current principal") ? "packages.refresh.resume" : "packages.refresh.exact.resume";
  return "usage.staging.cancel";
}

export function jobActionLabel(job: WorkbenchJobSummary, operation: JobOperation) {
  if (operation === "reconcile") return "Reconcile changes (read-only)";
  if (job.source === "data-sync") return operation === "resume" ? "Retry incomplete" : "Cancel run";
  if (job.source === "official-usage") return "Discard draft";
  if (job.source === "package-refresh" || job.source === "power-platform") return operation === "resume" ? "Resume refresh" : "Cancel refresh";
  if (job.source === "purview") return operation === "resume" ? "Resume search" : "Cancel search";
  if (job.source === "defender") return operation === "resume" ? "Resume investigation" : "Cancel investigation";
  return operation === "resume" ? "Resume unsent" : "Cancel unsent work";
}
