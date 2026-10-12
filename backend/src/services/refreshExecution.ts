export type RefreshCancellationReason = "requested" | "sync_cleanup";

export function refreshCancellation(reason: RefreshCancellationReason) {
  return reason === "sync_cleanup"
    ? { code: "data_sync_cleanup", message: "Stopped during data sync cleanup. See the sync source for the original failure or interruption." }
    : { code: "cancelled", message: "Cancelled by the requesting principal." };
}

export function createRefreshExecutionSignal(
  cancellationSignal: AbortSignal,
  deadlineMs: number,
) {
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 0) {
    throw new RangeError("Refresh deadlines must be non-negative safe integer milliseconds.");
  }
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const dispose = () => {
    clearTimeout(timer);
    cancellationSignal.removeEventListener("abort", onCancellation);
  };
  const abort = (reason: unknown) => {
    dispose();
    controller.abort(reason);
  };
  const onCancellation = () => abort(cancellationSignal.reason);
  const onDeadline = () => abort(new DOMException("Refresh execution deadline expired.", "TimeoutError"));
  // Native timeout signals cannot be disposed, and oversized Node timers expire in 1 ms.
  const startedAt = performance.now();
  let remainingMs = deadlineMs;
  const schedule = () => {
    const duration = Math.min(remainingMs, 2 ** 31 - 1);
    timer = setTimeout(() => {
      // Timer delivery is not elapsed-time evidence: early callbacks must rearm.
      remainingMs = Math.max(0, Math.ceil(deadlineMs - (performance.now() - startedAt)));
      if (remainingMs > 0) schedule();
      else onDeadline();
    }, duration);
    timer.unref();
  };
  if (cancellationSignal.aborted) onCancellation();
  else if (deadlineMs === 0) onDeadline();
  else {
    cancellationSignal.addEventListener("abort", onCancellation, { once: true });
    schedule();
  }
  return { signal: controller.signal, dispose };
}
