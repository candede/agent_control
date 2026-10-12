import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { AppError } from "../errors.js";
import { encodeBatch } from "../db/dataBounds.js";
import { schemaRegistry } from "./officialReportFields.js";
import { officialReportLimits, streamOfficialReport, type OfficialRow } from "./officialReportStream.js";

const header = `${schemaRegistry.users.headers.join(",")}\n`;
const signal = () => new AbortController().signal;
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
function source(text: string) { return Readable.from([Buffer.from(text)]); }

describe("incremental official CSV ingestion without services", () => {
  it("preserves original bytes, UTF-8, reordered headers, quoted records and exact identities across every byte boundary", async () => {
    const bytes = Buffer.from('\uFEFFDisplay name,Username,Agent responses received,Last activity date (UTC),Number of agents used\r\n\r\n"研究😀 ""assistant""\r\nteam", User@Example.invalid , "1,234" ,2026-07-06,2\r\nOther,user@example.invalid,0,2026-06-30,0\r\n\r\n');
    const rows: OfficialRow[] = [];
    async function* chunks() { for (const byte of bytes) yield Uint8Array.of(byte); }
    const report = await streamOfficialReport(chunks(), undefined, signal(), { batch: async (_kind, batch) => { rows.push(...batch); } });
    expect(report).toMatchObject({
      kind: "users", rowCount: 2, wireBytes: bytes.length, fileHash: createHash("sha256").update(bytes).digest("hex"),
      reportingPeriod: { startDate: "2026-06-30", endDate: "2026-07-06", days: 7, provenance: "activity_range" },
      sourceAsOfProvenance: "absent", sourceFreshness: "unknown",
    });
    expect(rows).toEqual([
      { username: "User@Example.invalid", displayName: '研究😀 "assistant"\r\nteam', numberOfAgentsUsed: 2,
        agentResponsesReceived: 1234, lastActivityDateUtc: "2026-07-06T00:00:00.000Z" },
      { username: "user@example.invalid", displayName: "Other", numberOfAgentsUsed: 0,
        agentResponsesReceived: 0, lastActivityDateUtc: "2026-06-30T00:00:00.000Z" },
    ]);
    expect(report.examples).toEqual(rows);
  });

  it.each([
    [Buffer.from([0xc3, 0x28]), "invalid_utf8"],
    [Buffer.from([0xf0, 0x9f]), "invalid_utf8"],
    [Buffer.from("\0"), "invalid_content"],
    [Buffer.from("\u0085"), "invalid_content"],
  ])("rejects invalid bytes before flushing pending rows (case %#)", async (suffix, code) => {
    async function* chunks() { yield Buffer.from(`${header}user,Name,1,1,\r\n`); yield suffix; }
    const batch = vi.fn(async () => {});
    await expect(streamOfficialReport(chunks(), undefined, signal(), { batch })).rejects.toMatchObject({ status: 400, code });
    expect(batch).not.toHaveBeenCalled();
  });

  it.each([
    ["", "empty_report"],
    ["\uFEFF\r\n\r\n", "empty_report"],
    ["Username,Display name,Number of agents used,Agent responses received, USERNAME \n", "duplicate_header"],
    [`${header.replace("display name", "new column")}user,Name,1,1,\n`, "schema_drift"],
    [`${header}user,Name,1,1\n`, "invalid_csv"],
    [`${header}user,"unterminated`, "invalid_csv"],
    [`${header}user,${"x".repeat(65537)},1,1,\n`, "invalid_csv"],
    [`${header}user,"${" ".repeat(4097)}",1,1,\n`, "field_limit_exceeded"],
  ])("maps header and structural failures without publishing a batch (case %#)", async (csv, code) => {
    const batch = vi.fn(async () => {});
    await expect(streamOfficialReport(source(csv), undefined, signal(), { batch })).rejects.toMatchObject({ status: 400, code });
    expect(batch).not.toHaveBeenCalled();
  });

  it.each(["\n", "\r", "\r\n"])("counts padded UTF-8 fields across byte boundaries with %j records without counting CSV escapes", async delimiter => {
    const name = '研究🤖 "team"\r\nline';
    const padding = " ".repeat(officialReportLimits.fieldBytes - Buffer.byteLength(name));
    const prefix = padding.slice(0, padding.length / 2), suffix = padding.slice(prefix.length);
    const csv = `${schemaRegistry.users.headers.join(",")}${delimiter}User,${prefix}"${name.replaceAll('"', '""')}"${suffix},0,0,${delimiter}`;
    const bytes = Buffer.from(csv), rows: OfficialRow[] = [];
    async function* chunks() { for (const byte of bytes) yield Uint8Array.of(byte); }
    const report = await streamOfficialReport(chunks(), undefined, signal(), { batch: async (_kind, batch) => { rows.push(...batch); } });
    expect(rows).toMatchObject([{ username: "User", displayName: name }]);
    expect(report).toMatchObject({ rowCount: 1, wireBytes: bytes.length, fileHash: createHash("sha256").update(bytes).digest("hex") });
    await expect(streamOfficialReport(source(csv.replace(`${suffix},0`, `${suffix} ,0`)), undefined,
      signal(), { batch: async () => {} })).rejects.toMatchObject({ status: 400, code: "field_limit_exceeded" });
  });

  it("rejects unquoted padding floods without consuming the rest of the field or submitting a batch", async () => {
    let generated = 0;
    const closed = vi.fn(), batch = vi.fn(async () => {});
    async function* chunks() {
      try {
        yield Buffer.from(`${header}User,`);
        for (let n = 0; n < 20; n++) { generated++; yield Buffer.alloc(16384, 32); }
        yield Buffer.from(",0,0,\n");
      } finally { closed(); }
    }
    await expect(streamOfficialReport(chunks(), undefined, signal(), { batch })).rejects.toMatchObject({ status: 400, code: "field_limit_exceeded" });
    expect(generated).toBeLessThanOrEqual(2);
    expect(batch).not.toHaveBeenCalled();
    expect(closed).toHaveBeenCalledOnce();
  });

  it("accepts header-only reports with a byte-exact hash and unknown coverage", async () => {
    const batch = vi.fn(async () => {});
    const report = await streamOfficialReport(source(header), undefined, signal(), { batch });
    expect(report).toMatchObject({ rowCount: 0, examples: [], wireBytes: Buffer.byteLength(header),
      fileHash: createHash("sha256").update(header).digest("hex"),
      reportingPeriod: { startDate: null, endDate: null, days: null, provenance: "activity_range" } });
    expect(batch).not.toHaveBeenCalled();
  });

  it.each([
    { prefix: "", code: "schema_drift" },
    { prefix: header, code: "invalid_csv" },
  ])("rejects a column flood before buffering or consuming the complete record ($code)", async ({ prefix, code }) => {
    let generated = 0;
    async function* chunks() {
      if (prefix) yield Buffer.from(prefix);
      for (let n = 0; n < 20; n++) { generated++; yield Buffer.alloc(16384, 44); }
      yield Buffer.from("\n");
    }
    const batch = vi.fn(async () => {});
    await expect(streamOfficialReport(chunks(), undefined, signal(), { batch })).rejects.toMatchObject({ status: 400, code });
    expect(generated).toBeLessThanOrEqual(2);
    expect(batch).not.toHaveBeenCalled();
  });

  it.each(["numberOfAgentsUsed", "agentResponsesReceived"] as const)("rejects %s aggregate overflow without flushing a pending batch", async metric => {
    const counts = metric === "numberOfAgentsUsed" ? "9007199254740991,0" : "0,9007199254740991";
    const batch = vi.fn(async () => {});
    await expect(streamOfficialReport(source(`${header}first,First,${counts},\nsecond,Second,1,1,\n`),
      undefined, signal(), { batch })).rejects.toMatchObject({ status: 400, code: "numeric_overflow" });
    expect(batch).not.toHaveBeenCalled();
  });

  it.each(["responsesSentToUsers", "activeUsersLicensed", "activeUsersUnlicensed"] as const)(
    "rejects Agents %s aggregate overflow without flushing a pending batch", async metric => {
      const columns = ["activeUsersLicensed", "activeUsersUnlicensed", "responsesSentToUsers"];
      const first = columns.map(column => column === metric ? Number.MAX_SAFE_INTEGER : 0).join(",");
      const second = columns.map(column => column === metric ? 1 : 0).join(",");
      const batch = vi.fn(async () => {});
      await expect(streamOfficialReport(source(`${schemaRegistry.agents.headers.join(",")}\nfirst,First,User,${first},\nsecond,Second,User,${second},\n`),
        undefined, signal(), { batch })).rejects.toMatchObject({ status: 400, code: "numeric_overflow" });
      expect(batch).not.toHaveBeenCalled();
    },
  );

  it("validates metadata before passing rows to the sink", async () => {
    const batch = vi.fn(async () => {});
    await expect(streamOfficialReport(source(`${header}user,Name,1,1,\n`), { downloadedAt: "" },
      signal(), { batch })).rejects.toMatchObject({ status: 400, code: "invalid_metadata" });
    expect(batch).not.toHaveBeenCalled();
  });

  it("preserves a sink failure even if its code resembles a parser failure", async () => {
    const failure = Object.assign(new Error("Sink unavailable"), { code: "CSV_SINK_UNAVAILABLE" });
    await expect(streamOfficialReport(source(`${header}user,Name,1,1,\n`), undefined,
      signal(), { batch: async () => { throw failure; } })).rejects.toBe(failure);
  });

  it("flushes exactly 250 rows at a time and includes the final tail without mutating earlier batches", async () => {
    const batches: Array<readonly OfficialRow[]> = [], wire: number[] = [];
    const csv = `${header}${Array.from({ length: 501 }, (_, n) => `user${n},Name,1,1,\n`).join("")}`;
    const report = await streamOfficialReport(source(csv), undefined, signal(), { batch: async (_kind, rows, bytes) => {
      batches.push(rows); wire.push(bytes);
    } });
    expect(batches.map(rows => rows.length)).toEqual([250, 250, 1]);
    expect(batches.flatMap(rows => rows.map(row => "username" in row ? row.username : undefined)))
      .toEqual(Array.from({ length: 501 }, (_, n) => `user${n}`));
    expect(wire).toEqual([...wire].sort((left, right) => left - right));
    expect(wire.at(-1)).toBe(Buffer.byteLength(csv));
    expect(report).toMatchObject({ rowCount: 501, wireBytes: Buffer.byteLength(csv) });
  });

  it("stops and closes its input after a sink rejects instead of submitting later batches", async () => {
    const failure = new AppError(503, "data_queue_full", "Retry later."), closed = vi.fn();
    async function* chunks() {
      try {
        yield Buffer.from(header);
        for (let offset = 0; offset < 1000; offset += 250) {
          yield Buffer.from(Array.from({ length: 250 }, (_, n) => `user${offset + n},Name,1,1,\n`).join(""));
        }
      } finally { closed(); }
    }
    const batch = vi.fn(async () => { throw failure; });
    await expect(streamOfficialReport(chunks(), undefined, signal(), { batch })).rejects.toBe(failure);
    expect(batch).toHaveBeenCalledOnce();
    expect(closed).toHaveBeenCalledOnce();
  });

  it("preserves the abort reason and settles an in-flight sink before returning", async () => {
    const controller = new AbortController(), reason = new AppError(408, "upload_deadline", "Upload deadline exceeded.");
    let release!: () => void, entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const pending = new Promise<void>(resolve => { release = resolve; });
    let settled = false;
    const report = streamOfficialReport(source(`${header}user,Name,1,1,\n`), undefined,
      controller.signal, { batch: async () => { entered(); await pending; } });
    const outcome = report.catch(error => error).finally(() => { settled = true; });
    await started;
    controller.abort(reason);
    await turn(); await turn();
    try { expect(settled).toBe(false); }
    finally { release(); }
    expect(await outcome).toBe(reason);
  });

  it("does not read input or call the sink when already aborted", async () => {
    const controller = new AbortController(), reason = new AppError(400, "upload_disconnected", "Upload disconnected.");
    const read = vi.fn();
    async function* chunks() { read(); yield Buffer.from(header); }
    const batch = vi.fn(async () => {});
    controller.abort(reason);
    await expect(streamOfficialReport(chunks(), undefined, controller.signal, { batch })).rejects.toBe(reason);
    expect(read).not.toHaveBeenCalled();
    expect(batch).not.toHaveBeenCalled();
  });

  it("serializes bounded UTF-8 batches, retains only 20 examples and limits source lookahead under backpressure", async () => {
    let generated = 0, maximumLookahead = 0, committed = 0, active = 0;
    const retained: Array<readonly OfficialRow[]> = [], sizes: number[] = [], counts: number[] = [];
    async function* chunks() {
      yield Buffer.from(`${schemaRegistry.userAgents.headers.join(",")}\n`);
      for (let n = 0; n < 1000; n++) {
        generated++;
        yield Buffer.from(`${`a${n}`.padEnd(512, "語")},${"語".repeat(512)},${"語".repeat(128)},${`u${n}`.padEnd(512, "語")},1,\n`);
      }
    }
    const report = await streamOfficialReport(chunks(), undefined, signal(), { batch: async (_kind, rows, bytes) => {
      expect(++active).toBe(1);
      maximumLookahead = Math.max(maximumLookahead, generated - committed - rows.length);
      retained.push(rows); counts.push(rows.length);
      sizes.push(encodeBatch(rows.map((row, n) => ({ ordinal: committed + n, row_data: row, natural_key: "f".repeat(64) })),
        ["f".repeat(36), "t".repeat(512), "p".repeat(1024)]).bytes);
      expect(bytes).toBeGreaterThan(0);
      await turn();
      committed += rows.length; active--;
    } });
    expect(committed).toBe(1000);
    expect(report.examples).toHaveLength(20);
    expect(Math.max(...counts)).toBeLessThan(officialReportLimits.batchRows);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(officialReportLimits.batchBytes);
    expect(maximumLookahead).toBeLessThan(20);
    expect(retained.map(rows => rows.length)).toEqual(counts);
  });

  it("counts logical records rather than blank lines or quoted newlines at the real Users row limit", async () => {
    const run = async (rows: number) => {
      async function* chunks() {
        yield Buffer.from(`\n${header}\n`);
        for (let offset = 0; offset < rows; offset += 250) {
          yield Buffer.from(Array.from({ length: Math.min(250, rows - offset) }, (_, n) =>
            `user${offset + n},"Research\nassistant",1,1,\n\n`).join(""));
        }
      }
      return streamOfficialReport(chunks(), undefined, signal(), { batch: async () => {} });
    };
    expect((await run(officialReportLimits.rows.users)).rowCount).toBe(officialReportLimits.rows.users);
    await expect(run(officialReportLimits.rows.users + 1)).rejects.toMatchObject({ status: 413, code: "row_limit_exceeded" });
  }, 60_000);

  it("enforces the exact wire-byte limit without retaining the file", async () => {
    const chunk = Buffer.alloc(16384, 32);
    chunk[chunk.length - 1] = 10;
    const run = async (extra: number) => {
      async function* chunks() {
        yield Buffer.from(header);
        for (let remaining = officialReportLimits.fileBytes - Buffer.byteLength(header) + extra; remaining > 0; remaining -= chunk.length) {
          yield chunk.subarray(0, Math.min(remaining, chunk.length));
        }
      }
      return streamOfficialReport(chunks(), undefined, signal(), { batch: async () => {} });
    };
    expect((await run(0)).wireBytes).toBe(officialReportLimits.fileBytes);
    await expect(run(1)).rejects.toMatchObject({ status: 413, code: "report_too_large" });
  }, 60_000);
});
