/**
 * Maps in input order with a positive safe-integer concurrency limit.
 * Stops scheduling on the first observed failure and drains started work before rethrowing it.
 */
export async function mapWithConcurrency<T, U>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T) => Promise<U>,
) {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
    throw new RangeError("Concurrency must be a positive safe integer.");
  }

  const results: U[] = [];
  let index = 0;
  let stopped = false;
  let firstError: unknown;

  async function worker() {
    try {
      while (!stopped && index < items.length) {
        const currentIndex = index++;
        results[currentIndex] = await mapper(items[currentIndex]);
      }
    } catch (error) {
      if (!stopped) {
        stopped = true;
        firstError = error;
      }
      throw error;
    }
  }

  await Promise.allSettled(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker()),
  );
  if (stopped) throw firstError;
  return results;
}
