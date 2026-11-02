import { Readable } from "node:stream";
import { AppError, hasNativeErrorPrototype } from "../errors.js";

export function providerTextStream(response: Response, options: {
  signal: AbortSignal; assertCurrent?: () => void; idleTimeoutMs: number;
}) {
  const { signal } = options;
  let cancelBody = (reason?: unknown) => { void response.body?.cancel(reason).catch(() => undefined); };
  const fence = () => {
    try { signal.throwIfAborted(); options.assertCurrent?.(); }
    catch (error) { cancelBody(error); throw error; }
  };
  fence();
  if (!response.body) throw new AppError(502, "provider_schema", "Provider response was empty.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let cancelled = false, paused = false;
  let pendingRead: { pause: () => void; resume: () => void } | undefined;
  const state: { failure?: { error: unknown } } = {};
  cancelBody = reason => {
    if (cancelled) return;
    cancelled = true;
    void reader.cancel(reason).catch(() => undefined);
  };
  const abort = () => cancelBody(signal.reason);
  const decode = (value?: Uint8Array, stream = false) => {
    try { return decoder.decode(value, { stream }); }
    catch { throw new AppError(502, "provider_schema", "Provider response was not valid UTF-8."); }
  };
  async function* text() {
    try {
      for (;;) {
        fence();
        let timer: NodeJS.Timeout | undefined;
        const stalled = new Promise<never>((_resolve, reject) => {
          pendingRead = {
            pause: () => clearTimeout(timer),
            resume: () => {
              clearTimeout(timer);
              timer = setTimeout(() => {
                const error = new AppError(504, "provider_timeout", "Provider response body stopped making progress.");
                reject(error);
                cancelBody(error);
              }, options.idleTimeoutMs);
              timer.unref();
            },
          };
          if (!paused) pendingRead.resume();
        });
        const read = reader.read().catch(error => {
          fence();
          if (hasNativeErrorPrototype(error, TypeError.prototype)) throw new AppError(503, "provider_network_error", "Provider response transport failed.");
          throw error;
        });
        const chunk = await Promise.race([read, stalled]).finally(() => {
          clearTimeout(timer);
          pendingRead = undefined;
        });
        fence();
        if (chunk.done) break;
        const owned = Buffer.from(chunk.value);
        for (let offset = 0; offset < owned.byteLength; offset += 16_384) {
          fence();
          yield decode(owned.subarray(offset, offset + 16_384), true);
        }
      }
      yield decode();
    } catch (error) {
      state.failure = { error };
      // Node streams may inspect error.message; keep borrowed errors outside them.
      throw new AppError(502, "provider_schema", "Provider response could not be read.");
    } finally {
      reader.releaseLock();
    }
  }
  const input = Readable.from(text(), { highWaterMark: 1 });
  signal.addEventListener("abort", abort, { once: true });
  return {
    input, state, fence,
    pause() { paused = true; pendingRead?.pause(); },
    resume() { paused = false; pendingRead?.resume(); },
    close() {
      signal.removeEventListener("abort", abort);
      cancelBody();
      input.destroy();
      // An iterator closed before its first next() never enters its finally block.
      reader.releaseLock();
    },
  };
}
