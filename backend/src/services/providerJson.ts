import { AppError } from "../errors.js";

export async function boundedProviderText(response: Response, maximumBytes = 2_000_000, signal?: AbortSignal) {
  if (!response.body) throw new AppError(502, "provider_schema", "Provider response was empty.");
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
    if (signal?.aborted) throw signal.reason;
    signal?.addEventListener("abort", onAbort, { once: true });
    for (;;) {
      const chunk = await (signal ? Promise.race([reader.read(), aborted]) : reader.read());
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > maximumBytes) {
        await reader.cancel();
        throw new AppError(502, "provider_result_limit", "Provider response exceeded the byte limit.");
      }
      chunks.push(chunk.value);
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function boundedProviderJson<T>(response: Response): Promise<T> {
  const text = await boundedProviderText(response);
  try { return JSON.parse(text) as T; }
  catch { throw new AppError(502, "provider_schema", "Provider response was not valid JSON."); }
}