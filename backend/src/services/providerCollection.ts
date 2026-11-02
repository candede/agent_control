import parser, { type Token } from "stream-json/parser.js";
import Assembler from "stream-json/assembler.js";
import { AppError, isApplicationError } from "../errors.js";
import { dataLimits } from "../db/dataBounds.js";
import type { ProviderJsonContext } from "./providerJson.js";
import { providerTextStream } from "./providerTextStream.js";

export type ProviderCollectionMetadata = { rows: number; count?: unknown; nextLink?: unknown };
export type ProviderCollectionEvent =
  | { kind: "record"; value: unknown }
  | { kind: "complete"; metadata: ProviderCollectionMetadata };

export async function* streamProviderCollection(response: Response, options: {
  signal: AbortSignal;
  assertCurrent?: () => void;
  contexts: Readonly<Record<string, ProviderJsonContext>>;
  recordContext: string;
  idleTimeoutMs: number;
}): AsyncGenerator<ProviderCollectionEvent> {
  const body = providerTextStream(response, options);
  const { input, fence } = body;
  const tokenizer = parser.asStream({
    packValues: true, streamValues: true, readableHighWaterMark: 1, writableHighWaterMark: 1,
  });
  input.on("error", error => tokenizer.destroy(error));
  input.pipe(tokenizer);
  type Frame = { kind: "object" | "array"; context?: string; property?: string; keys: Set<string>; collection?: boolean };
  const frames: Frame[] = [];
  const metadata: ProviderCollectionMetadata = { rows: 0 };
  let sawCollection = false;
  let assembler: Assembler | undefined;
  let recordBytes = 0;
  let scalarBytes = 0;
  const schema = () => new AppError(502, "provider_schema", "Provider returned an invalid collection.");
  const recordLimit = (observedBytes: number) => new AppError(502, "provider_result_limit",
    "A provider record or scalar value exceeds the supported working-memory budget.",
    { maximumBytes: dataLimits.agentDefinitionWorkBytes, observedBytes });
  try {
    fence();
    const tokens: AsyncIterable<Token> = tokenizer;
    for await (const token of tokens) {
      // External admission checks belong at input-chunk and record boundaries.
      options.signal.throwIfAborted();
      const parent = frames.at(-1);
      if (token.name === "startKey" || token.name === "startString" || token.name === "startNumber") scalarBytes = 0;
      if (token.name === "stringChunk" || token.name === "numberChunk") {
        const bytes = Buffer.byteLength(token.value);
        scalarBytes += bytes;
        if (scalarBytes > dataLimits.agentDefinitionWorkBytes) {
          throw recordLimit(scalarBytes);
        }
        recordBytes += bytes;
      } else if (token.name.startsWith("start") || token.name.startsWith("end")
        || token.name === "nullValue" || token.name === "trueValue" || token.name === "falseValue") recordBytes += 4;
      if (assembler && recordBytes > dataLimits.agentDefinitionWorkBytes) {
        throw recordLimit(recordBytes);
      }
      if (token.name === "keyValue") {
        if (!parent || parent.kind !== "object") throw schema();
        const context = parent.context ? options.contexts[parent.context] : undefined;
        const contract = frames.length === 1 ? ["value", "@odata.count", "@odata.nextLink"].includes(token.value)
          : context?.fields === "*" || context?.fields.includes(token.value);
        if (contract) {
          if (parent.keys.has(token.value)) throw schema();
          parent.keys.add(token.value);
        }
        parent.property = token.value;
      }
      if (token.name === "startObject" || token.name === "startArray") {
        if (frames.length >= 64) throw new AppError(502, "provider_schema", "Provider collection nesting exceeds the supported record contract.");
        if (!frames.length) {
          if (token.name !== "startObject" || sawCollection) throw schema();
          frames.push({ kind: "object", keys: new Set<string>() });
          continue;
        }
        if (frames.length === 1 && parent?.property === "value") {
          if (token.name !== "startArray" || sawCollection) throw schema();
          sawCollection = true;
          frames.push({ kind: "array", keys: new Set<string>(), collection: true });
          continue;
        }
        if (frames.length === 1 && ["@odata.count", "@odata.nextLink"].includes(parent?.property ?? "")) throw schema();
        let context: string | undefined;
        if (parent?.collection) {
          if (token.name !== "startObject") throw schema();
          assembler = new Assembler();
          recordBytes = 4;
          context = options.recordContext;
        } else if (parent?.kind === "array" && token.name === "startObject") context = parent.context;
        else if (parent?.context && parent.property !== undefined) {
          const mapping = token.name === "startObject" ? options.contexts[parent.context]?.objects : options.contexts[parent.context]?.arrays;
          const mapped = mapping && Object.hasOwn(mapping, parent.property) ? mapping[parent.property] : undefined;
          context = typeof mapped === "function" ? mapped(assembler?.current) : mapped;
        }
        frames.push({ kind: token.name === "startObject" ? "object" : "array", context, keys: new Set<string>() });
      } else if (parent?.collection && token.name !== "endArray") throw schema();
      if (assembler) assembler.consume(token);
      if (token.name === "endObject" || token.name === "endArray") {
        if (!parent) throw schema();
        frames.pop();
        if (assembler?.done) {
          fence();
          const value = assembler.current;
          assembler = undefined;
          metadata.rows += 1;
          if (!Number.isSafeInteger(metadata.rows)) throw new Error("data_count_overflow");
          body.pause();
          try { yield { kind: "record", value }; }
          finally { body.resume(); }
        }
      } else if (!assembler && frames.length === 1 && "value" in token
        && ["stringValue", "numberValue", "nullValue", "trueValue", "falseValue"].includes(token.name)) {
        const value = token.name === "numberValue" ? Number(token.value) : token.value;
        if (parent?.property === "value") throw schema();
        if (parent?.property === "@odata.count") metadata.count = value;
        if (parent?.property === "@odata.nextLink") metadata.nextLink = value;
      } else if (!frames.length && token.name !== "whitespace") throw schema();
    }
    fence();
    if (!sawCollection || frames.length || assembler) throw schema();
    yield { kind: "complete", metadata };
  } catch (error) {
    fence();
    if (body.state.failure) throw body.state.failure.error;
    if (isApplicationError(error)) throw error;
    throw schema();
  } finally {
    tokenizer.destroy();
    body.close();
  }
}
