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
  let queue = queues.get(database);
  if (!queue) { queue = { pending: [], running: false }; queues.set(database, queue); }
  if (queue.pending.length >= dataLimits.queue) return Promise.reject(dataAdmissionError("data_ingestion_queue_full"));
  const current = queue;
  return new Promise((resolve, reject) => {
    const request: Request = {
      begin, release, deadline: deadline.getTime(), signal, active: false,
      finish: (error, lease) => {
        const index = current.pending.indexOf(request);
        if (index < 0) return;
        current.pending.splice(index, 1);
        signal?.removeEventListener("abort", cancelled);
        if (!current.pending.length && current.timer) { clearTimeout(current.timer); current.timer = undefined; }
        if (error !== undefined) reject(error); else resolve(lease!);
      },
    };
    const cancelled = () => { if (!request.active) request.finish(signal!.reason); };
    signal?.addEventListener("abort", cancelled, { once: true });
    current.pending.push(request);
    observeDataWork("admission", { queueDepth: current.pending.length });
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
          try { await request.release(lease); }
          catch (error) {
            request.finish(new AggregateError([request.signal?.reason, error], "data_admission_release_failed"));
            continue;
          }
          request.finish(request.signal?.aborted ? request.signal.reason : dataAdmissionError("data_ingestion_deadline", 503));
        } else request.finish(undefined, lease);
      } catch (error) {
        if (request.signal?.aborted) request.finish(request.signal.reason);
        else if (!(error instanceof AppError) || error.code !== "data_ingestion_admission") request.finish(error);
      } finally { request.active = false; }
    }
  } finally {
    queue.running = false;
    if (queue.pending.length) {
      const remaining = Math.min(...queue.pending.map(request => request.deadline - Date.now()));
      queue.timer = setTimeout(() => { queue.timer = undefined; void pump(queue); }, Math.max(0, Math.min(1000, remaining)));
      queue.timer.unref();
    }
  }
}
