import { setTimeout as delay } from "node:timers/promises";

export function assertCapacityPublicationProgress(milliseconds: number) {
  if (!Number.isFinite(milliseconds) || milliseconds<0) throw new Error("capacity_publication_clock_unavailable");
  if (milliseconds>60_000) throw Object.assign(new Error("capacity_canonical_publication_deadline"),{
    code: "capacity_canonical_publication_deadline",details: { limitMs: 60_000,observedMs: milliseconds },
  });
}

export function capacitySelectionExpired(error: unknown, expiresAt: Date, now = Date.now()) {
  return error !== null && typeof error==="object" && "code" in error && error.code==="selection_invalidated"
    && Number.isFinite(expiresAt.getTime()) && expiresAt.getTime()<=now;
}

export function capacityBackgroundRetryable(error: unknown, depth = 0): boolean {
  if (!error || typeof error !== "object" || depth > 4) return false;
  const code = "code" in error ? error.code : undefined;
  if (typeof code === "string" && [
    "data_read_conflict","data_acquisition_timeout","data_queue_full","data_selection_admission","data_export_admission",
    "40001","40P01","55P03","57014","25P04",
  ].includes(code)) return true;
  if (error instanceof AggregateError) return capacityBackgroundRetryable(error.errors[0],depth+1);
  return "cause" in error && capacityBackgroundRetryable(error.cause,depth+1);
}

export async function capacityBackgroundLoop(options: {
  signal: AbortSignal; intervalMs: number; run: () => Promise<void>; rejected: (error: unknown) => void;
}) {
  let attempts = 0,completed = 0,rejections = 0;
  while (!options.signal.aborted) {
    attempts++;
    let rejected = false;
    try { await options.run();completed++; }
    catch (error) {
      rejected = true;rejections++;options.rejected(error);
      if (!capacityBackgroundRetryable(error)) throw error;
    }
    if (!options.signal.aborted) await delay(rejected ? Math.max(100,options.intervalMs) : options.intervalMs);
  }
  return { attempts,completed,rejections };
}

export async function capacityWithCleanup<T>(work: () => Promise<T>, cleanup: () => Promise<void>): Promise<T> {
  let failed = false,primary: unknown;
  try { return await work(); }
  catch (error) { failed = true;primary = error;throw error; }
  finally {
    try { await cleanup(); }
    catch (error) {
      if (failed) throw new AggregateError([primary,error],"capacity_background_cleanup");
      throw error;
    }
  }
}
