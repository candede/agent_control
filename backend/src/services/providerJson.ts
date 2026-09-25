import { isUtf8 } from "node:buffer";
import { AppError } from "../errors.js";

export class ProviderResponseLimitError extends AppError {
  constructor(readonly maximumBytes: number, readonly observedBytes: number) {
    super(502, "provider_result_limit", "Provider response exceeded the byte limit.");
  }
}

export async function boundedProviderText(response: Response, maximumBytes = 2_000_000, signal?: AbortSignal) {
  if (!response.body) {
    signal?.throwIfAborted();
    throw new AppError(502, "provider_schema", "Provider response was empty.");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  let rejectAbort: ((reason: unknown) => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  const onAbort = () => {
    rejectAbort?.(signal?.reason ?? new DOMException("The provider response read was aborted.", "AbortError"));
    void reader.cancel(signal?.reason).catch(() => undefined);
  };
  try {
    if (signal?.aborted) {
      onAbort();
      await aborted;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    for (;;) {
      const chunk = await (signal ? Promise.race([reader.read(), aborted]) : reader.read());
      signal?.throwIfAborted();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > maximumBytes) {
        // Cleanup must neither delay the size failure nor replace it with a transport error.
        void reader.cancel().catch(() => undefined);
        throw new ProviderResponseLimitError(maximumBytes, length);
      }
      chunks.push(chunk.value);
    }
  } catch (error) {
    signal?.throwIfAborted();
    throw error;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
  const body = Buffer.concat(chunks);
  if (!isUtf8(body)) throw new AppError(502, "provider_schema", "Provider response was not valid UTF-8.");
  return body.toString("utf8");
}

export async function boundedProviderJson<T>(response: Response, signal?: AbortSignal, maximumBytes?: number): Promise<T> {
  const text = await boundedProviderText(response, maximumBytes, signal);
  signal?.throwIfAborted();
  try { return JSON.parse(text) as T; }
  catch { throw new AppError(502, "provider_schema", "Provider response was not valid JSON."); }
}