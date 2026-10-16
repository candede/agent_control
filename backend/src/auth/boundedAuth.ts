import { AppError } from "../errors.js";

export const authExchangeTimeoutMs = 10_000;

export function authCancelled() {
  return new AppError(499, "authentication_cancelled", "Authentication was cancelled.");
}

export function assertAuthSignal(signal?: AbortSignal) {
  if (signal?.aborted) throw authCancelled();
}

// Each waiter owns cancellation; only the last departing waiter cancels shared work.
export class SharedAuthOperation<T> {
  private readonly controller = new AbortController();
  private readonly completion: Promise<T>;
  private waiters = 0;
  private settled = false;

  constructor(operation: (signal: AbortSignal) => Promise<T>, timeoutMs = authExchangeTimeoutMs) {
    let timer: ReturnType<typeof setTimeout>;
    let abort: () => void;
    const cancelled = new Promise<never>((_resolve, reject) => {
      abort = () => reject(authCancelled());
      this.controller.signal.addEventListener("abort", abort, { once: true });
    });
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new AppError(504, "authentication_timeout", "Authentication exceeded its deadline."));
        this.controller.abort();
      }, timeoutMs);
    });
    this.completion = Promise.race([Promise.resolve().then(() => operation(this.controller.signal)), timeout, cancelled])
      .finally(() => {
        clearTimeout(timer);
        this.controller.signal.removeEventListener("abort", abort);
        this.settled = true;
      });
    void this.completion.catch(() => undefined);
  }

  get aborted() { return this.controller.signal.aborted; }

  cancel() { this.controller.abort(); }

  async wait(signal?: AbortSignal): Promise<T> {
    assertAuthSignal(signal);
    this.waiters++;
    let abort: (() => void) | undefined;
    const cancelled = new Promise<never>((_resolve, reject) => {
      abort = () => reject(authCancelled());
      signal?.addEventListener("abort", abort, { once: true });
    });
    try {
      const result = await Promise.race([this.completion, cancelled]);
      assertAuthSignal(signal);
      return result;
    } finally {
      if (abort) signal?.removeEventListener("abort", abort);
      if (--this.waiters === 0 && !this.settled) this.cancel();
    }
  }
}

export async function boundedAuthBody(response: Response, maximumBytes: number, signal?: AbortSignal) {
  assertAuthSignal(signal);
  const reader = response.body?.getReader();
  if (!reader) return "";
  const abort = () => { void reader.cancel().catch(() => undefined); };
  signal?.addEventListener("abort", abort, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      assertAuthSignal(signal);
      if (done) break;
      size += value.byteLength;
      if (size > maximumBytes) throw new AppError(502, "invalid_identity_response", "The identity response exceeded its bound.");
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    signal?.removeEventListener("abort", abort);
    await reader.cancel().catch(() => undefined);
  }
}

export function identityThrottled(retryAfter: string | null) {
  const date = retryAfter && /^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(retryAfter) ? Date.parse(retryAfter) : NaN;
  const seconds = retryAfter && /^\d{1,6}$/.test(retryAfter) ? Number(retryAfter)
    : Number.isFinite(date) ? Math.ceil((date - Date.now()) / 1000) : 30;
  const error = new AppError(429, "provider_throttled", "Microsoft Entra ID throttled authentication. Retry after the cooldown.");
  error.retryAfterSeconds = Math.max(1, seconds);
  return error;
}
