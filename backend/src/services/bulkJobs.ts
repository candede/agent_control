import { randomUUID } from "node:crypto";
import type {
  BulkActionResult,
  BulkPackageResult,
} from "../types/copilotPackage.js";
import type { AuditAction } from "../types/audit.js";

const jobRetentionMs = 60 * 60 * 1000;

export type BulkJobStatus = "queued" | "running" | "completed" | "failed";

export type BulkActionJob = {
  id: string;
  action: AuditAction;
  targetBlockedState: boolean;
  status: BulkJobStatus;
  total: number;
  completed: number;
  succeeded: number;
  failed: number;
  skipped: number;
  results: BulkPackageResult[];
  result?: BulkActionResult;
  currentAgentName?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
};

const jobs = new Map<string, BulkActionJob>();

export function createBulkActionJob(
  action: AuditAction,
  targetBlockedState: boolean,
  total: number,
) {
  pruneExpiredJobs();

  const now = new Date().toISOString();
  const job: BulkActionJob = {
    id: randomUUID(),
    action,
    targetBlockedState,
    status: "queued",
    total,
    completed: 0,
    succeeded: 0,
    failed: 0,
    skipped: 0,
    results: [],
    createdAt: now,
    updatedAt: now,
  };

  jobs.set(job.id, job);
  return job;
}

export function getBulkActionJob(id: string) {
  pruneExpiredJobs();
  return jobs.get(id);
}

export function startBulkActionPackage(jobId: string, displayName: string) {
  const job = jobs.get(jobId);

  if (!job || isTerminal(job.status)) {
    return;
  }

  job.status = "running";
  job.currentAgentName = displayName;
  job.updatedAt = new Date().toISOString();
}

export function recordBulkActionPackageResult(
  jobId: string,
  result: BulkPackageResult,
) {
  const job = jobs.get(jobId);

  if (!job || isTerminal(job.status)) {
    return;
  }

  job.status = "running";
  job.results.push(result);
  job.completed = job.results.length;
  job.succeeded = job.results.filter(
    (item) => item.status === "succeeded",
  ).length;
  job.failed = job.results.filter((item) => item.status === "failed").length;
  job.skipped = job.results.filter((item) => item.status === "skipped").length;
  job.currentAgentName = result.displayName;
  job.updatedAt = new Date().toISOString();
}

export function completeBulkActionJob(jobId: string, result: BulkActionResult) {
  const job = jobs.get(jobId);

  if (!job) {
    return;
  }

  const now = new Date().toISOString();
  job.status = "completed";
  job.total = result.total;
  job.completed = result.results.length;
  job.succeeded = result.succeeded;
  job.failed = result.failed;
  job.skipped = result.skipped;
  job.results = result.results;
  job.result = result;
  job.currentAgentName = undefined;
  job.updatedAt = now;
  job.completedAt = now;
}

export function failBulkActionJob(jobId: string, error: unknown) {
  const job = jobs.get(jobId);

  if (!job) {
    return;
  }

  const now = new Date().toISOString();
  job.status = "failed";
  job.error = error instanceof Error ? error.message : "Bulk action failed.";
  job.currentAgentName = undefined;
  job.updatedAt = now;
  job.completedAt = now;
}

function isTerminal(status: BulkJobStatus) {
  return status === "completed" || status === "failed";
}

function pruneExpiredJobs() {
  const cutoff = Date.now() - jobRetentionMs;

  for (const [id, job] of jobs) {
    const updatedAt = Date.parse(job.updatedAt);

    if (!Number.isNaN(updatedAt) && updatedAt < cutoff) {
      jobs.delete(id);
    }
  }
}
