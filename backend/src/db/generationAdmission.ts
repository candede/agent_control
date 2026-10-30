import type pg from "pg";
import { AppError } from "../errors.js";
import { dataAdmissionError, dataLimits } from "./dataBounds.js";
import type { GenerationLease } from "./dataGenerations.js";
import { observeDataWork } from "../services/dataMetrics.js";

type Request = {
  begin: () => Promise<GenerationLease>; release: (lease: GenerationLease) => Promise<unknown>;
  deadline: number; signal?: AbortSignal; active: boolean;
  finish: (error?: unknown, lease?: GenerationLease) => void;
};
type Queue = { pending: Request[]; running: boolean; timer?: ReturnType<typeof setTimeout> };
const queues = new WeakMap<pg.Pool, Queue>();

export function admitGeneration(database: pg.Pool, begin: Request["begin"], release: Request["release"],
  deadline: Date, signal?: AbortSignal): Promise<GenerationLease> {
  signal?.throwIfAborted();
  const deadlineAt = deadline.getTime();
  if (!Number.isFinite(deadlineAt)) return Promise.reject(new RangeError("data_ingestion_deadline_invalid"));
  let queue = queues.get(database);
  if (!queue) { queue = { pending: [], running: false }; queues.set(database, queue); }
  if (queue.pending.length >= dataLimits.queue) return Promise.reject(dataAdmissionError("data_ingestion_queue_full"));
  const current = queue;
  return new Promise((resolve, reject) => {
    let expiry: ReturnType<typeof setTimeout> | undefined;
    const request: Request = {
      begin, release, deadline: deadlineAt, signal, active: false,
      finish: (error, lease) => {
        const index = current.pending.indexOf(request);
        if (index < 0) return;
        current.pending.splice(index, 1);
        signal?.removeEventListener("abort", cancelled);
        clearTimeout(expiry);
        if (!current.pending.length && current.timer) { clearTimeout(current.timer); current.timer = undefined; }
        if (lease === undefined) reject(error); else resolve(lease);
      },
    };
    const expire = () => {
      const remaining = request.deadline - Date.now();
      if (remaining <= 0) {
        if (!request.active) request.finish(dataAdmissionError("data_ingestion_deadline", 503));
        return;
      }
      expiry = setTimeout(expire, Math.min(remaining, 2_147_483_647));
      expiry.unref();
    };
    const cancelled = () => { if (!request.active) request.finish(signal!.reason); };
    signal?.addEventListener("abort", cancelled, { once: true });
    current.pending.push(request);
    observeDataWork("admission", { queueDepth: current.pending.length });
    expire();
    void pump(current);
  });
}

async function pump(queue: Queue) {
  if (queue.running || queue.timer) return;
  queue.running = true;
  const attempted = new Set<Request>();
  try {
    for (;;) {
      const request = queue.pending.find(value => !attempted.has(value));
      if (!request || attempted.size >= dataLimits.queue) break;
      attempted.add(request);
      if (request.signal?.aborted) { request.finish(request.signal.reason); continue; }
      if (request.deadline <= Date.now()) { request.finish(dataAdmissionError("data_ingestion_deadline", 503)); continue; }
      request.active = true;
      try {
        const lease = await request.begin();
        if (request.signal?.aborted || request.deadline <= Date.now()) {
          const error = request.signal?.aborted ? request.signal.reason : dataAdmissionError("data_ingestion_deadline", 503);
          try { await request.release(lease); }
          catch (failure) {
            request.finish(new AggregateError([error, failure], "data_admission_release_failed"));
            continue;
          }
          request.finish(error);
        } else request.finish(undefined, lease);
      } catch (error) {
        if (request.signal?.aborted) request.finish(request.signal.reason);
        else if (!(error instanceof AppError) || !["data_ingestion_admission", "data_source_active"].includes(error.code)) request.finish(error);
        else if (request.deadline <= Date.now()) request.finish(dataAdmissionError("data_ingestion_deadline", 503));
      } finally { request.active = false; }
    }
  } finally {
    queue.running = false;
    if (queue.pending.length) {
      queue.timer = setTimeout(() => { queue.timer = undefined; void pump(queue); }, 1000);
      queue.timer.unref();
    }
  }
}
