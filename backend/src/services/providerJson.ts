import { isUtf8 } from "node:buffer";
import type { ReadableStreamReadResult } from "node:stream/web";
import { AppError } from "../errors.js";
import { peakCheckpoint } from "./peakMemory.js";

export class ProviderResponseLimitError extends AppError {
  constructor(readonly maximumBytes: number, readonly observedBytes: number) {
    super(502, "provider_result_limit", "Provider response exceeded the byte limit.");
  }
}

type ProviderJsonContext = {
  fields: readonly string[];
  objects?: Readonly<Record<string, string | ((parent: unknown) => string | undefined)>>;
  arrays?: Readonly<Record<string, string>>;
};

export function parseProviderContractJson(text: string, contexts: Readonly<Record<string, ProviderJsonContext>>, maximumDepth: number): unknown {
  const result: unknown = JSON.parse(text);
  const frames: Array<{ context?: string; kind: "object" | "array"; keys: Set<string>; property?: string; value: unknown; index: number }> = [];
  let depth = 0;
  // Scan only contract-bearing containers after syntax validation. Unknown authoring JSON is omitted by its provider projection.
  for (const match of text.matchAll(/"(?:[^"\\]|\\.)*"|[{}[\],]/g)) {
    const token = match[0];
    const frame = depth <= maximumDepth ? frames.at(-1) : undefined;
    if (token === "{" || token === "[") {
      if (++depth > maximumDepth) continue;
      const parent = frame?.context && Object.hasOwn(contexts, frame.context) ? contexts[frame.context] : undefined;
      const mapping = token === "{" ? parent?.objects : parent?.arrays;
      const mapped = frame?.property !== undefined && mapping && Object.hasOwn(mapping, frame.property) ? mapping[frame.property] : undefined;
      // Parsed siblings allow type-specific contexts regardless of JSON member order.
      const context = depth === 1 && token === "{" ? "root"
        : frame?.kind === "array" ? token === "{" ? frame.context : undefined
          : typeof mapped === "function" ? mapped(frame?.value) : mapped;
      const value = depth === 1 ? result
        : frame?.kind === "array" && Array.isArray(frame.value) ? frame.value[frame.index]
          : frame?.property !== undefined && typeof frame.value === "object" && frame.value !== null
            ? Object.getOwnPropertyDescriptor(frame.value, frame.property)?.value : undefined;
      frames.push({ context, kind: token === "{" ? "object" : "array", keys: new Set<string>(), value, index: 0 });
    } else if (token === "}" || token === "]") {
      if (depth-- <= maximumDepth) frames.pop();
    } else if (token === ",") {
      if (frame?.kind === "array") frame.index++;
      else if (frame) frame.property = undefined;
    } else if (frame?.kind === "object") {
      let next = match.index + token.length;
      while (/[\t\n\r ]/.test(text.charAt(next))) next++;
      if (text.charAt(next) !== ":") continue;
      const key: string = JSON.parse(token);
      frame.property = key;
      if (!frame.context || !Object.hasOwn(contexts, frame.context) || !contexts[frame.context].fields.includes(key)) continue;
      if (frame.keys.has(key)) throw new SyntaxError("Provider response contains duplicate contract properties.");
      frame.keys.add(key);
    }
  }
  return result;
}

export async function boundedProviderText(response: Response, maximumBytes = 2_000_000, signal?: AbortSignal) {
  if (signal?.aborted) {
    void response.body?.cancel(signal.reason).catch(() => undefined);
    signal.throwIfAborted();
  }
  if (!response.body) {
    signal?.throwIfAborted();
    throw new AppError(502, "provider_schema", "Provider response was empty.");
  }
  const reader = response.body.getReader();
  let body = Buffer.allocUnsafe(0);
  let length = 0;
  let rejectAbort: ((reason: unknown) => void) | undefined;
  const onAbort = () => {
    rejectAbort?.(signal?.reason ?? new DOMException("The provider response read was aborted.", "AbortError"));
    void reader.cancel(signal?.reason).catch(() => undefined);
  };
  try {
    if (signal?.aborted) {
      onAbort();
      signal.throwIfAborted();
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    for (;;) {
      // Only the active read retains an abort rejection; racing one pending promise per chunk accumulates handlers.
      const chunk = await (signal ? new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
        rejectAbort = reject;
        reader.read().then(resolve, reject);
      }) : reader.read());
      rejectAbort = undefined;
      signal?.throwIfAborted();
      if (chunk.done) break;
      const observedBytes = length + chunk.value.byteLength;
      if (observedBytes > maximumBytes) {
        // Cleanup must neither delay the size failure nor replace it with a transport error.
        void reader.cancel().catch(() => undefined);
        throw new ProviderResponseLimitError(maximumBytes, observedBytes);
      }
      if (observedBytes > body.length) {
        const expanded = Buffer.allocUnsafe(Math.min(maximumBytes, Math.max(16_384, body.length * 2, observedBytes)));
        body.copy(expanded, 0, 0, length);
        body = expanded;
      }
      // Copy borrowed transport storage before the next read; retained memory is bounded by bytes, not chunk count.
      body.set(chunk.value, length);
      length = observedBytes;
    }
  } catch (error) {
    signal?.throwIfAborted();
    throw error;
  } finally {
    rejectAbort = undefined;
    signal?.removeEventListener("abort", onAbort);
    reader.releaseLock();
    signal?.throwIfAborted();
  }
  const bytes = body.subarray(0, length);
  if (!isUtf8(bytes)) throw new AppError(502, "provider_schema", "Provider response was not valid UTF-8.");
  return bytes.toString("utf8");
}

export async function boundedProviderJson<T>(response: Response, signal?: AbortSignal, maximumBytes?: number,
  parse: (text: string) => unknown = JSON.parse): Promise<T> {
  const text = await boundedProviderText(response, maximumBytes, signal);
  signal?.throwIfAborted();
  try {
    peakCheckpoint("provider.parse");
    signal?.throwIfAborted();
    let result: T;
    try { result = parse(text) as T; }
    catch (error) {
      if (error instanceof SyntaxError) throw new AppError(502, "provider_schema", "Provider response was not valid JSON.");
      throw error;
    }
    signal?.throwIfAborted();
    peakCheckpoint("provider.parse");
    signal?.throwIfAborted();
    return result;
  }
  catch (error) {
    signal?.throwIfAborted();
    throw error;
  }
}