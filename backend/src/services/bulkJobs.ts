import { randomUUID } from "node:crypto";
import type {
  BulkActionResult,
  BulkPackageResult,
  PackageAccessUpdate,
} from "../types/copilotPackage.js";
import type { AccessAuditAction, BlockAuditAction } from "../types/audit.js";

const jobRetentionMs = 60 * 60 * 1000;

export type BulkJobStatus = "queued" | "running" | "completed" | "failed";

type BulkActionJobBase = {
  id: string;
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

export type BulkActionJob = BulkActionJobBase &
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

const jobs = new Map<string, { ownerId: string; job: BulkActionJob }>();

export function createBulkActionJob(
  ownerId: string,
  action: BlockAuditAction,
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

  jobs.set(job.id, { ownerId, job });
  return job;
}

export function createBulkAccessJob(
  ownerId: string,
  action: AccessAuditAction,
  accessUpdate: PackageAccessUpdate,
  total: number,
) {
  pruneExpiredJobs();

  const now = new Date().toISOString();
  const job: BulkActionJob = {
    id: randomUUID(),
    action,
    accessUpdate,
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

  jobs.set(job.id, { ownerId, job });
  return job;
}

export function getBulkActionJob(id: string, ownerId: string) {
  pruneExpiredJobs();
  const stored = jobs.get(id);
  return stored?.ownerId === ownerId ? stored.job : undefined;
}

export function startBulkActionPackage(jobId: string, displayName: string) {
  const job = jobs.get(jobId)?.job;

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
  const job = jobs.get(jobId)?.job;

  if (!job || isTerminal(job.status)) {
    return;
  }

  job.status = "running";
  const existingResultIndex = job.results.findIndex(
    (item) => item.id === result.id,
  );

  if (existingResultIndex === -1) {
    job.results.push(result);
  } else {
    job.results[existingResultIndex] = result;
  }
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
  const job = jobs.get(jobId)?.job;

  if (!job || isTerminal(job.status)) {
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
  const job = jobs.get(jobId)?.job;

  if (!job || isTerminal(job.status)) {
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

  for (const [id, stored] of jobs) {
    const { job } = stored;
    const updatedAt = Date.parse(job.updatedAt);

    if (!Number.isNaN(updatedAt) && updatedAt < cutoff) {
      jobs.delete(id);
    }
  }
}
