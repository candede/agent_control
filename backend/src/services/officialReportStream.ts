import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { peakCheckpoint } from "./peakMemory.js";
import { pipeline } from "node:stream/promises";
import { CsvError, parse, type CastingContext } from "csv-parse";
import { AppError } from "../errors.js";
import { identifySchema, normalizeHeader, parseAgentRow, parseUserAgentRow, parseUserRow, reportBase, schemaRegistry, OfficialUsageValidationError } from "./officialReportFields.js";
import type { AgentUsageRow, UserAgentUsageRow, UserUsageRow, OfficialUsageMetadata, OfficialUsageReportBase, OfficialUsageReportKind } from "../types/officialReportRecords.js";
import { dataLimitError, encodeBatch } from "../db/dataBounds.js";

export const officialReportLimits = Object.freeze({
  fileBytes: 256 * 1024 * 1024, fieldBytes: 4096, batchRows: 250, batchBytes: 1048576,
  rows: { users: 100000, agents: 200000, userAgents: 1000000 },
  actorBytes: 1024 * 1024 * 1024, tenantBytes: 2 * 1024 * 1024 * 1024, bundleBytes: 1024 * 1024 * 1024,
});
const maximumColumns = Math.max(...Object.values(schemaRegistry).map(schema => schema.headers.length));
export type OfficialRow = AgentUsageRow | UserAgentUsageRow | UserUsageRow;
export type StreamedOfficialReport = OfficialUsageReportBase & {
  fileHash: string; rowCount: number; wireBytes: number; examples: OfficialRow[];
};

export async function streamOfficialReport(
  input: AsyncIterable<Uint8Array>, metadata: OfficialUsageMetadata | undefined, signal: AbortSignal,
  sink: { batch(kind: OfficialUsageReportKind, rows: readonly OfficialRow[], wireBytes: number): Promise<void> },
): Promise<StreamedOfficialReport> {
  signal.throwIfAborted();
  let wireBytes = 0, rowCount = 0;
  let responses = 0, agentsUsed = 0, licensed = 0, unlicensed = 0;
  const addMetric = (total: number, value: number) => {
    const next = total + value;
    if (!Number.isSafeInteger(next)) throw new OfficialUsageValidationError("numeric_overflow", "A report metric total exceeds the safe integer range.");
    return next;
  };
  const fileHash = createHash("sha256"), decoder = new TextDecoder("utf-8", { fatal: true });
  const checkPadding = csvFieldPaddingBudget();
  const examples: OfficialRow[] = [];
  let earliest: string | undefined, latest: string | undefined;
  async function* text() {
    for await (const bytes of input) {
      signal.throwIfAborted();
      for (let offset = 0; offset < bytes.length; offset += 16384) {
        const part = bytes.subarray(offset, offset + 16384);
        wireBytes += part.byteLength;
        if (wireBytes > officialReportLimits.fileBytes) throw new AppError(413, "report_too_large", "CSV exceeds 256 MiB.");
        fileHash.update(part);
        let decoded: string;
        try { decoded = decoder.decode(part, { stream: true }); }
        catch { throw new AppError(400, "invalid_utf8", "The report must be valid UTF-8."); }
        if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(decoded)) throw new AppError(400, "invalid_content", "Unsupported control character.");
        checkPadding(decoded);
        yield decoded;
      }
    }
    let tail: string;
    try { tail = decoder.decode(); }
    catch { throw new AppError(400, "invalid_utf8", "Incomplete UTF-8 sequence."); }
    checkPadding(tail, true);
    yield tail;
  }
  const parserOptions = { bom: true, columns: false as const, trim: true, skip_empty_lines: true, relax_column_count: false,
    max_record_size: officialReportLimits.fieldBytes * 16, highWaterMark: 16,
    cast: (value: string, context: CastingContext) => {
      // csv-parse's record-size budget excludes empty delimiters.
      if (context.index >= maximumColumns) throw new AppError(400, context.records === 0 ? "schema_drift" : "invalid_csv",
        "CSV exceeds the supported column count. Supplied column values were not retained.");
      return value;
    } };
  const parser = parse(parserOptions);
  let headers: string[] | undefined, kind: OfficialUsageReportKind | undefined;
  let batch: OfficialRow[] = [];
  // Bind bytes are additive: parameter/array framing, each encoded row, and commas.
  const batchOverhead = encodeBatch([], ["f".repeat(36), "t".repeat(512), "p".repeat(1024)]).bytes;
  let batchBytes = batchOverhead;
  const consume = async () => {
    for await (const values of parser as AsyncIterable<string[]>) {
      signal.throwIfAborted();
      if (values.some(value => Buffer.byteLength(value) > officialReportLimits.fieldBytes)) throw new AppError(400, "field_limit_exceeded", "CSV field exceeds 4 KiB.");
      if (!headers) {
        headers = values.map(normalizeHeader);
        if (new Set(headers).size !== headers.length) throw new AppError(400, "duplicate_header", "Duplicate normalized CSV header.");
        kind = identifySchema(headers);
        reportBase(kind, metadata, []);
        continue;
      }
      if (++rowCount > officialReportLimits.rows[kind!]) throw new AppError(413, "row_limit_exceeded", `CSV ${kind} row limit exceeded.`);
      const record = Object.fromEntries(headers.map((header, column) => [header, values[column]]));
      const row = kind === "agents" ? parseAgentRow(record, rowCount - 1)
        : kind === "users" ? parseUserRow(record, rowCount - 1) : parseUserAgentRow(record, rowCount - 1);
      if ("agentResponsesReceived" in row) {
        responses = addMetric(responses, row.agentResponsesReceived);
        agentsUsed = addMetric(agentsUsed, row.numberOfAgentsUsed);
      } else {
        responses = addMetric(responses, row.responsesSentToUsers);
        if ("activeUsersLicensed" in row) {
          licensed = addMetric(licensed, row.activeUsersLicensed);
          unlicensed = addMetric(unlicensed, row.activeUsersUnlicensed);
        }
      }
      if (row.lastActivityDateUtc) {
        earliest = !earliest || row.lastActivityDateUtc < earliest ? row.lastActivityDateUtc : earliest;
        latest = !latest || row.lastActivityDateUtc > latest ? row.lastActivityDateUtc : latest;
      }
      if (examples.length < 20) examples.push(row);
      peakCheckpoint("import.transform");
      const rowBytes = Buffer.byteLength(JSON.stringify({ ordinal: 999999, row_data: row, natural_key: "f".repeat(64) }));
      if (batchOverhead + rowBytes > officialReportLimits.batchBytes) {
        throw dataLimitError("data_batch_bytes", officialReportLimits.batchBytes, batchOverhead + rowBytes);
      }
      if (batch.length === officialReportLimits.batchRows || batchBytes + rowBytes + (batch.length ? 1 : 0) > officialReportLimits.batchBytes) {
        await sink.batch(kind!, batch, wireBytes); batch = []; batchBytes = batchOverhead;
      }
      batchBytes += rowBytes + (batch.length ? 1 : 0);
      batch.push(row);
    }
    if (!kind || !wireBytes) throw new AppError(400, "empty_report", "The CSV has no supported header.");
    if (batch.length) await sink.batch(kind, batch, wireBytes);
  };
  try { await pipeline(Readable.from(text()), parser, consume, { signal }); }
  catch (error) {
    signal.throwIfAborted();
    if (error instanceof CsvError) throw new AppError(400, "invalid_csv", "Malformed CSV structure or oversized record.");
    throw error;
  }
  const base = reportBase(kind!, metadata, [earliest, latest].filter((date): date is string => Boolean(date)).map(lastActivityDateUtc => ({ lastActivityDateUtc })));
  return { ...base, kind: kind!, fileHash: fileHash.digest("hex"), rowCount, wireBytes, examples };
}

function csvFieldPaddingBudget() {
  let fieldBytes = 0, firstField = true, content = false, padding = false, quoted = false, closingQuote = false;
  let recordDelimiter: string | undefined, pendingCr = "";
  const check = (recordField = false) => {
    if (padding && (recordField || content || !firstField) && fieldBytes > officialReportLimits.fieldBytes) {
      throw new AppError(400, "field_limit_exceeded", "CSV field exceeds 4 KiB.");
    }
  };
  const reset = (first: boolean) => {
    fieldBytes = 0; firstField = first; content = false; padding = false; closingQuote = false;
  };
  const append = (value: string) => {
    if (!value) return;
    fieldBytes += Buffer.byteLength(value);
    if (!quoted) {
      padding ||= /\s/.test(value);
      content ||= /[^ \t\r\n]/.test(value);
      closingQuote = false;
    }
    check();
  };
  return (chunk: string, end = false) => {
    // csv-parse discards unquoted padding before either of its size checks.
    // Count only this omitted budget; csv-parse remains the grammar authority.
    let value = pendingCr + chunk;
    pendingCr = "";
    if (!end && value.endsWith("\r")) { pendingCr = "\r"; value = value.slice(0, -1); }
    let offset = 0;
    for (const match of value.matchAll(/"|\r\n|[\r\n,]/g)) {
      append(value.slice(offset, match.index));
      const token = match[0];
      if (token === '"') {
        if (quoted) { quoted = false; closingQuote = true; }
        else {
          if (closingQuote) fieldBytes++;
          quoted = true; closingQuote = false; content = true;
          check();
        }
      } else if (quoted) {
        append(token);
      } else if (token === ",") {
        check(true); reset(false);
      } else {
        recordDelimiter ??= token;
        if (token === recordDelimiter) {
          check(); reset(true);
        } else if (token === "\r\n" && recordDelimiter === "\n") {
          append("\r"); check(); reset(true);
        } else if (token === "\r\n" && recordDelimiter === "\r") {
          check(); reset(true); append("\n");
        } else {
          append(token);
        }
      }
      offset = match.index + token.length;
    }
    append(value.slice(offset));
    if (end) check();
  };
}
