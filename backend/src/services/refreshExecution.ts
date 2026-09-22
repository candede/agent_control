export function createRefreshExecutionSignal(
  cancellationSignal: AbortSignal,
  deadlineMs: number,
) {
  const controller = new AbortController();
  // Forward eagerly so pending authorization cannot lose the first abort reason.
  const removeListeners = [cancellationSignal, AbortSignal.timeout(deadlineMs)].map(source => {
    const onAbort = () => controller.abort(source.reason);
    if (source.aborted) onAbort();
    else source.addEventListener("abort", onAbort, { once: true });
    return () => source.removeEventListener("abort", onAbort);
  });
  return {
    signal: controller.signal,
    dispose: () => { for (const removeListener of removeListeners) removeListener(); },
  };
}
