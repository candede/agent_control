import { EventEmitter, getEventListeners } from "node:events";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import type { Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { parse as parseCsv } from "csv-parse/sync";
import { activateAccountSession, revokeAccountSessionMutations } from "../db/sessions.js";
import { AppError } from "../errors.js";
import { buildBoundedCsv, csvValue } from "./csvEncoding.js";
import { createExportPublicationValidator, publishBoundedCsv } from "./csvExport.js";

const storedSession = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../db/pool.js", () => ({ pool: storedSession, secretValue: () => undefined }));
vi.mock("../config.js", async original => ({
  ...await original<typeof import("../config.js")>(),
  findTenantConfiguration: (tenantId: string) => tenantId === "csv-tenant" ? { tenantId, clientId: "csv-client" } : undefined,
}));

beforeEach(() => storedSession.query.mockReset().mockResolvedValue({ rowCount: 1, rows: [{}] }));

class FakeResponse extends EventEmitter {
  headers = new Map<string, string>();
  writes: Buffer[] = [];
  destroyed = false;
  writableEnded = false;
  writableFinished = false;
  forceBackpressure = false;

  get headersSent() { return this.writes.some(chunk => chunk.byteLength > 0); }

  setHeader(name: string, value: string) {
    this.headers.set(name, value);
  }

  removeHeader(name: string) { this.headers.delete(name); }

  destroy() {
    this.destroyed = true;
    this.emit("close");
  }

  write(value: Buffer) {
    this.writes.push(Buffer.from(value));
    if (!this.forceBackpressure) return true;
    this.forceBackpressure = false;
    queueMicrotask(() => this.emit("drain"));
    return false;
  }

  end() {
    this.writableEnded = true;
    this.writableFinished = true;
    this.emit("finish");
  }
}

function transport() {
  const request = Object.assign(new EventEmitter(), { aborted: false }) as unknown as Request;
  const response = new FakeResponse();
  return { request, response };
}

describe("bounded CSV publication", () => {
  it.each([undefined, 3])("cleans listeners across many drain cycles and stops at disconnect %s", async disconnectAt => {
    const { request, response } = transport();
    const writes = vi.spyOn(response, "write").mockImplementation(chunk => {
      response.writes.push(Buffer.from(chunk));
      queueMicrotask(() => {
        if (response.writes.length === disconnectAt) {
          response.destroyed = true;
          response.emit("close");
        } else response.emit("drain");
      });
      return false;
    });
    const publication = publishBoundedCsv(request, response as unknown as Response, "fixture.csv", Buffer.alloc(52 * 1024), {
      deadlineAt: Date.now() + 5000, chunkBytes: 1024, validate: async () => undefined,
    });
    if (disconnectAt) await expect(publication).rejects.toMatchObject({ code: "export_disconnected" });
    else await publication;
    expect(writes).toHaveBeenCalledTimes(disconnectAt ?? 52);
    expect(response.writableFinished).toBe(!disconnectAt);
    for (const event of ["drain", "close", "error"]) expect(response.listenerCount(event)).toBe(0);
  });

  it("neutralizes formulas and quotes nonempty values", () => {
    expect(["=1", "+1", "-1", "@x", "\tcmd", "\rcmd", "−1"].map(csvValue)).toEqual([
      "\"'=1\"", "\"'+1\"", "\"'-1\"", "\"'@x\"", "\"'\tcmd\"", "\"'\rcmd\"", "\"'−1\"",
    ]);
    expect(csvValue("a\"b")).toBe("\"a\"\"b\"");
  });

  it("neutralizes LF and whitespace-hidden formula prefixes without stripping source text", () => {
    const formulas = ["\n=1", " =1", "  +1", "\u00a0-1", "\uFEFF@value", " \tcmd", " \rcmd", " \ncmd", " \u22121"];
    const plain = '  A, "quoted"\r\n界😀\tend  ';
    const buffer = Buffer.from(`\uFEFFtext\r\n${formulas.map(text => `"'${text}"\r\n`).join("")}"  A, ""quoted""\r\n界😀\tend  "\r\n`);
    const budget = { maximumRows: formulas.length + 1, maximumBytes: buffer.byteLength, deadlineAt: Date.now() + 10_000 };
    const rows = [...formulas, plain].map(text => ({ text }));

    expect(buildBoundedCsv(["text"], rows, budget)).toEqual({
      buffer, byteCount: buffer.byteLength, rowCount: rows.length,
    });
    expect(parseCsv(buffer, { columns: true, bom: true })).toEqual([
      ...formulas.map(text => ({ text: `'${text}` })), { text: plain },
    ]);
    expect(() => buildBoundedCsv(["text"], rows, { ...budget, maximumBytes: buffer.byteLength - 1 }))
      .toThrowError(expect.objectContaining({ code: "export_byte_limit" }));
  });

  it("quotes explicit empty cells distinctly from null and missing while retaining zero and false", () => {
    const csv = buildBoundedCsv(["empty", "missing", "unknown", "zero", "disabled", "formula"], [{
      empty: "", missing: undefined, unknown: null, zero: 0, disabled: false, formula: "=SUM(1,1)",
    }], { maximumRows: 1, maximumBytes: 1_000, deadlineAt: Date.now() + 10_000 });
    expect(csv.buffer.toString("utf8")).toContain('\r\n"",,,"0","false","\'=SUM(1,1)"\r\n');
    expect(parseCsv(csv.buffer, { columns: true, bom: true })).toEqual([{
      empty: "", missing: "", unknown: "", zero: "0", disabled: "false", formula: "'=SUM(1,1)",
    }]);
  });

  it("rejects duplicate and oversized schemas even for empty selections", () => {
    const budget = { maximumRows: 1, maximumBytes: 10_000, deadlineAt: Date.now() + 10_000 };
    for (const columns of [["id", "id"], Array.from({ length: 129 }, (_, index) => `column${index}`), ["a".repeat(129)]]) {
      expect(() => buildBoundedCsv(columns, [], budget)).toThrow(expect.objectContaining({ code: "invalid_export_schema" }));
    }
  });

  it("rejects row, byte, and deadline budget violations before publication", () => {
    const future = Date.now() + 10_000;
    expect(() => buildBoundedCsv(["id"], [{ id: "1" }, { id: "2" }], {
      maximumRows: 1, maximumBytes: 1_000, deadlineAt: future,
    })).toThrowError(expect.objectContaining({ code: "export_row_limit" }));
    expect(() => buildBoundedCsv(["id"], [{ id: "x".repeat(200) }], {
      maximumRows: 1, maximumBytes: 20, deadlineAt: future,
    })).toThrowError(expect.objectContaining({ code: "export_byte_limit" }));
    expect(() => buildBoundedCsv(["id"], [{ id: "1" }], {
      maximumRows: 1, maximumBytes: 1_000, deadlineAt: Date.now() - 1,
    })).toThrowError(expect.objectContaining({ code: "export_deadline" }));
  });

  it.each(["byte", "deadline"] as const)("stops formatting later cells after exceeding the %s budget", budget => {
    let now = Date.now();
    const deadlineAt = now + 10_000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    const laterCell = vi.fn(() => "must not be formatted");
    try {
      expect(() => buildBoundedCsv(["first", "later"], [{
        get first() {
          if (budget === "deadline") now = deadlineAt;
          return "x".repeat(100);
        },
        get later() { return laterCell(); },
      }], { maximumRows: 1, maximumBytes: budget === "byte" ? 100 : 1_000, deadlineAt }))
        .toThrowError(expect.objectContaining({ code: `export_${budget === "byte" ? "byte_limit" : "deadline"}` }));
      expect(laterCell).not.toHaveBeenCalled();
    } finally {
      clock.mockRestore();
    }
  });

  it("counts UTF-8, escaped quotes, formula prefixes and delimiters at the exact byte boundary", () => {
    const buffer = Buffer.from('\uFEFFfirst,later\r\n"\'=é""","😀"\r\n', "utf8");
    const rows = [{ first: '=é"', later: "😀" }];
    const budget = { maximumRows: 1, maximumBytes: buffer.byteLength, deadlineAt: Date.now() + 10_000 };
    expect(buildBoundedCsv(["first", "later"], rows, budget)).toEqual({ buffer, rowCount: 1, byteCount: buffer.byteLength });
    expect(() => buildBoundedCsv(["first", "later"], rows, { ...budget, maximumBytes: buffer.byteLength - 1 }))
      .toThrowError(expect.objectContaining({ code: "export_byte_limit" }));
  });

  it.each(["row generation", "cell formatting", "iterator completion"])(
    "rejects a build that reaches its deadline during %s",
    phase => {
      let now = Date.now();
      const deadlineAt = now + 10_000;
      const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
      function* rows() {
        if (phase === "row generation") now = deadlineAt;
        yield { get id() {
          if (phase === "cell formatting") now = deadlineAt;
          return "1";
        } };
        if (phase === "iterator completion") now = deadlineAt;
      }
      try {
        expect(() => buildBoundedCsv(["id"], rows(), {
          maximumRows: 1, maximumBytes: 1_000, deadlineAt,
        })).toThrowError(expect.objectContaining({ code: "export_deadline" }));
      } finally {
        clock.mockRestore();
      }
    },
  );

  it.each([1, 3])("rejects publication when validation %i reaches the deadline before the timer runs", async check => {
    const { request, response } = transport();
    let now = Date.now();
    const deadlineAt = now + 10_000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    let checks = 0;
    const beforeEnd = vi.fn(async () => undefined);
    try {
      await expect(publishBoundedCsv(request, response as unknown as Response, "safe.csv", Buffer.alloc(2_048), {
        deadlineAt,
        chunkBytes: 1_024,
        validate: async () => {
          checks += 1;
          if (checks === check) now = deadlineAt;
        },
        beforeEnd,
      })).rejects.toMatchObject({ code: "export_deadline" });
      expect(response.writes).toHaveLength(check === 1 ? 0 : 1);
      expect(response.headers.size).toBe(check === 1 ? 0 : 4);
      expect(response.writableEnded).toBe(false);
      expect(beforeEnd).not.toHaveBeenCalled();
      expect(request.listenerCount("aborted")).toBe(0);
      expect(response.listenerCount("close")).toBe(0);
      expect(response.listenerCount("error")).toBe(0);
    } finally {
      clock.mockRestore();
    }
  });

  it("withholds the final chunk when audit completion reaches the deadline before the timer runs", async () => {
    const { request, response } = transport();
    let now = Date.now();
    const deadlineAt = now + 10_000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      await expect(publishBoundedCsv(request, response as unknown as Response, "safe.csv", Buffer.from("private\r\n"), {
        deadlineAt, validate: async () => undefined,
        beforeEnd: async () => { now = deadlineAt; },
      })).rejects.toMatchObject({ code: "export_deadline" });
      expect(response.writes).toHaveLength(0);
      expect(response.headers.size).toBe(0);
      expect(response.writableEnded).toBe(false);
      expect(request.listenerCount("aborted")).toBe(0);
    } finally {
      clock.mockRestore();
    }
  });

  it.each(["write", "finish"])("rejects a final transport %s that reaches the deadline before the timer runs", async phase => {
    const { request, response } = transport();
    let now = Date.now();
    const deadlineAt = now + 10_000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    const write = response.write.bind(response);
    const end = response.end.bind(response);
    response.write = value => {
      if (phase === "write") now = deadlineAt;
      return write(value);
    };
    response.end = () => {
      if (phase === "finish") now = deadlineAt;
      end();
    };
    try {
      await expect(publishBoundedCsv(request, response as unknown as Response, "safe.csv", Buffer.from("id\r\n"), {
        deadlineAt, validate: async () => undefined,
      })).rejects.toMatchObject({ code: "export_deadline" });
      expect(response.writes).toHaveLength(1);
      expect(response.writableEnded).toBe(phase === "finish");
      expect(request.listenerCount("aborted")).toBe(0);
    } finally {
      clock.mockRestore();
    }
  });

  it("honors backpressure and removes lifecycle listeners after success", async () => {
    const { request, response } = transport();
    response.forceBackpressure = true;
    const validate = vi.fn(async () => undefined);
    await publishBoundedCsv(request, response as unknown as Response, "safe.csv", Buffer.alloc(2_500, 65), {
      deadlineAt: Date.now() + 10_000, validate, chunkBytes: 1_024,
    });
    expect(response.writes).toHaveLength(3);
    expect(validate).toHaveBeenCalledTimes(4);
    expect(response.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
    expect(response.writableEnded).toBe(true);
    expect(request.listenerCount("aborted")).toBe(0);
    expect(response.listenerCount("close")).toBe(0);
    expect(response.listenerCount("error")).toBe(0);
    expect(response.listenerCount("drain")).toBe(0);
  });

  it("stops publication when authorization is invalidated between chunks", async () => {
    const { request, response } = transport();
    let checks = 0;
    await expect(publishBoundedCsv(request, response as unknown as Response, "safe.csv", Buffer.alloc(3_000, 65), {
      deadlineAt: Date.now() + 10_000,
      validate: async () => {
        checks += 1;
        if (checks === 3) throw new AppError(401, "session_invalidated", "Session invalidated.");
      },
      chunkBytes: 1_024,
    })).rejects.toMatchObject({ code: "session_invalidated" });
    expect(response.writes).toHaveLength(1);
    expect(request.listenerCount("aborted")).toBe(0);
    expect(response.listenerCount("close")).toBe(0);
  });

  it("stops after a client disconnect without publishing remaining chunks", async () => {
    const { request, response } = transport();
    const write = response.write.bind(response);
    response.write = (value: Buffer) => {
      const accepted = write(value);
      request.emit("aborted");
      return accepted;
    };
    await expect(publishBoundedCsv(request, response as unknown as Response, "safe.csv", Buffer.alloc(3_000, 65), {
      deadlineAt: Date.now() + 10_000, validate: async () => undefined, chunkBytes: 1_024,
    })).rejects.toMatchObject({ code: "export_disconnected" });
    expect(response.writes).toHaveLength(1);
    expect(request.listenerCount("aborted")).toBe(0);
  });

  it("bounds stalled backpressure and removes listeners on deadline", async () => {
    const { request, response } = transport();
    response.write = () => false;
    await expect(publishBoundedCsv(request, response as unknown as Response, "safe.csv", Buffer.alloc(3_000), {
      deadlineAt: Date.now() + 30, validate: async () => undefined, chunkBytes: 1_024,
    })).rejects.toMatchObject({ code: "export_deadline" });
    expect(response.listenerCount("drain")).toBe(0);
    expect(response.listenerCount("close")).toBe(0);
    expect(request.listenerCount("aborted")).toBe(0);
  });

  it("bounds a stalled authorization read before publishing headers", async () => {
    const { request, response } = transport();
    await expect(publishBoundedCsv(request, response as unknown as Response, "safe.csv", Buffer.from("id\r\n"), {
      deadlineAt: Date.now() + 30, validate: () => new Promise<void>(() => undefined),
    })).rejects.toMatchObject({ code: "export_deadline" });
    expect(response.headers.size).toBe(0);
    expect(request.listenerCount("aborted")).toBe(0);
  });

  it("revalidates after the awaited final audit before releasing the last chunk", async () => {
    const { request, response } = transport();
    let valid = true;
    await expect(publishBoundedCsv(request, response as unknown as Response, "safe.csv", Buffer.from("private\r\n"), {
      deadlineAt: Date.now() + 1_000,
      validate: async () => { if (!valid) throw new AppError(409, "dataset_invalidated", "Source invalidated."); },
      beforeEnd: async () => {
        await new Promise<void>(resolve => setImmediate(resolve));
        valid = false;
      },
    })).rejects.toMatchObject({ code: "dataset_invalidated" });
    expect(response.writes).toHaveLength(0);
  });

  it("enforces header budgets and deadlines even for an empty dataset", () => {
    expect(() => buildBoundedCsv(["id"], [], {
      maximumRows: 1, maximumBytes: 1, deadlineAt: Date.now() + 1_000,
    })).toThrowError(expect.objectContaining({ code: "export_byte_limit" }));
    expect(() => buildBoundedCsv(["id"], [], {
      maximumRows: 1, maximumBytes: 1_000, deadlineAt: Date.now() - 1,
    })).toThrowError(expect.objectContaining({ code: "export_deadline" }));
  });

  it("rejects unsafe download filenames before setting response headers", async () => {
    for (const filename of ["../private.csv", "rows.csv\r\nX-Injected: true", "rows.html"]) {
      const { request, response } = transport();
      await expect(publishBoundedCsv(request, response as unknown as Response, filename, Buffer.from("id\r\n"), {
        deadlineAt: Date.now() + 1_000, validate: async () => undefined,
      })).rejects.toMatchObject({ code: "invalid_export_filename" });
      expect(response.headers.size).toBe(0);
    }
  });

  it("bounds a stalled final transport finish", async () => {
    const { request, response } = transport();
    response.end = () => { response.writableEnded = true; };
    await expect(publishBoundedCsv(request, response as unknown as Response, "safe.csv", Buffer.from("id\r\n"), {
      deadlineAt: Date.now() + 30, validate: async () => undefined,
    })).rejects.toMatchObject({ code: "export_deadline" });
    expect(response.listenerCount("finish")).toBe(0);
    expect(response.listenerCount("close")).toBe(0);
    expect(request.listenerCount("aborted")).toBe(0);
  });

  it("ends immediately after the final authorized write even when it reports backpressure", async () => {
    const { request, response } = transport();
    let current = true;
    const end = vi.spyOn(response, "end").mockImplementation(() => {
      expect(current).toBe(true);
      response.writableEnded = true;
      response.writableFinished = true;
      response.emit("finish");
    });
    response.write = chunk => {
      response.writes.push(Buffer.from(chunk));
      queueMicrotask(() => { current = false; response.emit("drain"); });
      return false;
    };
    await publishBoundedCsv(request, response as unknown as Response, "safe.csv", Buffer.from("private\r\n"), {
      deadlineAt: Date.now() + 1_000,
      validate: async () => { if (!current) throw AppError.unauthorized(); },
    });
    expect(end).toHaveBeenCalledOnce();
    expect(response.listenerCount("drain")).toBe(0);
  });

  it.each([0, 1, 1_024, 1_025, 2_048])("audits once and publishes the exact %i-byte payload at chunk boundaries", async size => {
    const { request, response } = transport();
    const csv = Buffer.alloc(size, 65);
    const end = vi.spyOn(response, "end");
    const beforeEnd = vi.fn(async () => {
      const published = Buffer.concat(response.writes).byteLength;
      if (size) expect(published).toBeLessThan(size);
      else expect(published).toBe(0);
    });
    await publishBoundedCsv(request, response as unknown as Response, "safe.csv", csv, {
      deadlineAt: Date.now() + 1_000, validate: async () => undefined, chunkBytes: 1_024, beforeEnd,
    });
    expect(Buffer.concat(response.writes)).toEqual(csv);
    expect(response.headers.get("Content-Length")).toBe(String(size));
    expect(beforeEnd).toHaveBeenCalledOnce();
    expect(end).toHaveBeenCalledOnce();
  });

  it.each(["drain", "finish"] as const)("preserves a primary transport error during %s and cleans listeners", async phase => {
    const { request, response } = transport();
    const failure = new Error("synthetic transport failure");
    if (phase === "drain") {
      response.write = chunk => {
        response.writes.push(Buffer.from(chunk));
        queueMicrotask(() => response.emit("error", failure));
        return false;
      };
    } else {
      response.end = () => { queueMicrotask(() => response.emit("error", failure)); };
    }
    await expect(publishBoundedCsv(request, response as unknown as Response, "safe.csv", Buffer.alloc(2_048), {
      deadlineAt: Date.now() + 1_000, validate: async () => undefined, chunkBytes: 1_024,
    })).rejects.toBe(failure);
    expect(response.destroyed).toBe(true);
    for (const event of ["drain", "finish", "close", "error"]) expect(response.listenerCount(event)).toBe(0);
    expect(request.listenerCount("aborted")).toBe(0);
  });

  it.each([false, true])("cleans synchronous end failures after prior bytes %s", async partial => {
    const { request, response } = transport();
    const failure = new Error("synthetic end failure");
    if (!partial) response.write = () => true;
    response.end = () => { throw failure; };
    await expect(publishBoundedCsv(request, response as unknown as Response, "safe.csv", Buffer.from("id\r\n"), {
      deadlineAt: Date.now() + 1_000, validate: async () => undefined,
    })).rejects.toBe(failure);
    expect(response.destroyed).toBe(partial);
    expect(response.headers.has("Content-Disposition")).toBe(partial);
    expect(response.headers.has("Content-Length")).toBe(partial);
    for (const event of ["drain", "finish", "close", "error"]) expect(response.listenerCount(event)).toBe(0);
    expect(request.listenerCount("aborted")).toBe(0);
  });

  it("terminates partial downloads on deadline while waiting for the final audit to settle", async () => {
    const { request, response } = transport();
    const auditStarted = Promise.withResolvers<void>();
    const auditFinished = Promise.withResolvers<void>();
    const closed = Promise.withResolvers<void>();
    response.once("close", () => closed.resolve());
    const publication = publishBoundedCsv(request, response as unknown as Response, "safe.csv", Buffer.alloc(2_048), {
      deadlineAt: Date.now() + 30, validate: async () => undefined, chunkBytes: 1_024,
      beforeEnd: () => { auditStarted.resolve(); return auditFinished.promise; },
    });
    const rejected = expect(publication).rejects.toMatchObject({ code: "export_deadline" });
    await auditStarted.promise;
    try {
      await Promise.race([closed.promise, new Promise<void>(resolve => setTimeout(resolve, 100))]);
      expect(response.destroyed).toBe(true);
      expect(response.writes).toHaveLength(1);
    } finally {
      auditFinished.resolve();
      await rejected;
    }
    for (const event of ["drain", "finish", "close", "error"]) expect(response.listenerCount(event)).toBe(0);
  });

  it("does not replace a rejected final audit or release its last chunk", async () => {
    const { request, response } = transport();
    const failure = new Error("synthetic audit failure");
    const end = vi.spyOn(response, "end");
    await expect(publishBoundedCsv(request, response as unknown as Response, "safe.csv", Buffer.alloc(2_048), {
      deadlineAt: Date.now() + 1_000, validate: async () => undefined, chunkBytes: 1_024,
      beforeEnd: async () => { throw failure; },
    })).rejects.toBe(failure);
    expect(response.writes).toHaveLength(1);
    expect(response.destroyed).toBe(true);
    expect(end).not.toHaveBeenCalled();
  });

  it("preserves a disconnect while waiting for a final audit that later rejects", async () => {
    const { request, response } = transport();
    const auditStarted = Promise.withResolvers<void>();
    const auditFinished = Promise.withResolvers<void>();
    const publication = publishBoundedCsv(request, response as unknown as Response, "safe.csv", Buffer.alloc(2_048), {
      deadlineAt: Date.now() + 1_000, validate: async () => undefined, chunkBytes: 1_024,
      beforeEnd: () => { auditStarted.resolve(); return auditFinished.promise; },
    });
    const rejected = expect(publication).rejects.toMatchObject({ code: "export_disconnected" });
    await auditStarted.promise;
    request.emit("aborted");
    auditFinished.reject(new Error("late synthetic audit failure"));
    await rejected;
    expect(response.destroyed).toBe(true);
    expect(response.writes).toHaveLength(1);
    expect(request.listenerCount("aborted")).toBe(0);
  });

  it("observes late rejected validation after disconnect without publishing or retaining listeners", async () => {
    const { request, response } = transport();
    const readStarted = Promise.withResolvers<void>();
    const readFinished = Promise.withResolvers<void>();
    const publication = publishBoundedCsv(request, response as unknown as Response, "safe.csv", Buffer.from("id\r\n"), {
      deadlineAt: Date.now() + 1_000,
      validate: () => { readStarted.resolve(); return readFinished.promise; },
    });
    const rejected = expect(publication).rejects.toMatchObject({ code: "export_disconnected" });
    await readStarted.promise;
    request.emit("aborted");
    await rejected;
    readFinished.reject(new Error("late synthetic validation failure"));
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(response.headers.size).toBe(0);
    for (const event of ["drain", "finish", "close", "error"]) expect(response.listenerCount(event)).toBe(0);
    expect(request.listenerCount("aborted")).toBe(0);
  });

  it("does not write to or end a response that ended during validation", async () => {
    const { request, response } = transport();
    const end = vi.spyOn(response, "end");
    await expect(publishBoundedCsv(request, response as unknown as Response, "safe.csv", Buffer.from("id\r\n"), {
      deadlineAt: Date.now() + 1_000,
      validate: async () => { response.end(); },
    })).rejects.toMatchObject({ code: "export_disconnected" });
    expect(response.headers.size).toBe(0);
    expect(response.writes).toHaveLength(0);
    expect(end).toHaveBeenCalledOnce();
  });

  it.each(["during read", "before subscription"] as const)("removes cancelled read listeners %s even if the read never settles", async phase => {
    const { request, response } = transport();
    const cancellation = new AbortController();
    const controller = vi.spyOn(globalThis, "AbortController").mockImplementation(function () { return cancellation; });
    const readStarted = Promise.withResolvers<void>();
    const readFinished = Promise.withResolvers<void>();
    try {
      const publication = publishBoundedCsv(request, response as unknown as Response, "safe.csv", Buffer.from("id\r\n"), {
        deadlineAt: Date.now() + 1_000,
        validate: () => {
          readStarted.resolve();
          if (phase === "before subscription") request.emit("aborted");
          return readFinished.promise;
        },
      });
      const rejected = expect(publication).rejects.toMatchObject({ code: "export_disconnected" });
      await readStarted.promise;
      if (phase === "during read") request.emit("aborted");
      await rejected;
      expect(getEventListeners(cancellation.signal, "abort")).toHaveLength(0);
      expect(response.writes).toHaveLength(0);
    } finally {
      readFinished.reject(new Error("late synthetic read failure"));
      controller.mockRestore();
    }
  });

  it("does not retroactively fail a timely finish when the publication continuation runs after the deadline", async () => {
    const socket = new Socket();
    const output: Buffer[] = [];
    socket._write = (chunk, _encoding, callback) => { output.push(Buffer.from(chunk)); callback(); };
    socket._writev = (chunks, callback) => {
      output.push(...chunks.map(({ chunk }) => Buffer.from(chunk)));
      callback();
    };
    const request = new IncomingMessage(socket);
    Object.assign(request, { method: "GET", httpVersionMajor: 1, httpVersionMinor: 1, complete: true });
    const response = new ServerResponse(request);
    response.assignSocket(socket);
    let now = Date.now();
    const deadlineAt = now + 10_000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    const end = response.end.bind(response);
    response.end = () => {
      end();
      response.once("finish", () => { now = deadlineAt; });
      return response;
    };
    try {
      const csv = Buffer.from("\uFEFFid\r\n\"界😀\"\r\n");
      await publishBoundedCsv(request as unknown as Request, response as unknown as Response, "safe.csv", csv, {
        deadlineAt, validate: async () => undefined,
      });
      expect(response.writableFinished).toBe(true);
      expect(response.destroyed).toBe(false);
      const wire = Buffer.concat(output);
      const boundary = wire.indexOf("\r\n\r\n") + 4;
      expect(wire.subarray(boundary)).toEqual(csv);
      expect(wire.subarray(0, boundary).toString()).toContain(`Content-Length: ${csv.byteLength}\r\n`);
      for (const event of ["drain", "finish", "close", "error"]) expect(response.listenerCount(event)).toBe(0);
    } finally {
      socket.destroy();
      clock.mockRestore();
    }
  });
});

describe("export session publication fence", () => {
  let sequence = 0;
  function authorizedTransport() {
    const { request, response } = transport();
    const accountId = `csv-principal-${++sequence}`;
    Object.assign(request, {
      sessionID: `session-${accountId}`,
      session: { accountId, tenantId: "csv-tenant", clientId: "csv-client", user: { tenantId: "csv-tenant", homeAccountId: accountId,
        roles: ["AgentControl.Admin"], username: "reader@example.invalid", displayName: "Reader" } },
    });
    return { request, response };
  }

  it.each(["logout", "superseding login", "role removal", "session destruction", "session replacement", "tenant replacement", "client replacement"] as const)(
    "rejects %s during an in-flight stored-session read",
    async change => {
      const { request, response } = authorizedTransport();
      const readStarted = Promise.withResolvers<void>();
      const readFinished = Promise.withResolvers<{ rowCount: number; rows: object[] }>();
      storedSession.query.mockResolvedValueOnce({ rowCount: 1, rows: [{}] }).mockImplementationOnce(() => {
        readStarted.resolve();
        return readFinished.promise;
      });
      const validate = createExportPublicationValidator(request, "AgentControl.Viewer");
      const publication = publishBoundedCsv(request, response as unknown as Response, "safe.csv", Buffer.from("private\r\n"), {
        deadlineAt: Date.now() + 10_000, validate,
      });
      const rejected = expect(publication).rejects.toMatchObject({ code: "unauthorized" });
      await readStarted.promise;
      let mutation: Promise<unknown> | undefined;
      if (change === "logout") {
        mutation = revokeAccountSessionMutations("csv-tenant", request.session.accountId!, async () => undefined);
      } else if (change === "superseding login") {
        mutation = activateAccountSession("csv-tenant", request.session.accountId!, async () => undefined);
      } else if (change === "role removal") {
        request.session.user!.roles = [];
      } else if (change === "session destruction") {
        Reflect.deleteProperty(request, "session");
      } else if (change === "tenant replacement") {
        request.session.tenantId = "another-tenant";
      } else if (change === "client replacement") {
        request.session.clientId = "another-client";
      } else {
        request.sessionID = "replacement-session";
      }
      readFinished.resolve({ rowCount: 1, rows: [{}] });
      await mutation;
      await rejected;
      expect(response.writes).toHaveLength(0);
      expect(response.headers.size).toBe(0);
    },
  );

  it.each(["first chunk", "between chunks", "after audit"] as const)(
    "rejects logout during the %s source fence without blocking logout on that read", async phase => {
      const { request, response } = authorizedTransport();
      const sourceStarted = Promise.withResolvers<void>();
      const sourceFinished = Promise.withResolvers<void>();
      const beforeEnd = phase === "after audit" ? vi.fn(async () => undefined) : undefined;
      const pendingCheck = phase === "first chunk" ? 2 : 3;
      let checks = 0;
      const validateSession = createExportPublicationValidator(request, "AgentControl.Viewer");
      const validate = () => validateSession(async () => {
        if (++checks !== pendingCheck) return;
        sourceStarted.resolve();
        await sourceFinished.promise;
      });
      const publication = publishBoundedCsv(request, response as unknown as Response, "safe.csv", Buffer.alloc(phase === "between chunks" ? 2_048 : 512), {
        deadlineAt: Date.now() + 10_000, validate, beforeEnd, chunkBytes: 1_024,
      });
      const rejected = expect(publication).rejects.toMatchObject({ code: "unauthorized" });
      await Promise.race([sourceStarted.promise, publication]);
      await revokeAccountSessionMutations("csv-tenant", request.session.accountId!, async () => undefined);
      sourceFinished.resolve();
      await rejected;
      expect(checks).toBe(pendingCheck);
      expect(response.writes).toHaveLength(phase === "between chunks" ? 1 : 0);
      expect(response.headers.size).toBe(phase === "between chunks" ? 4 : 0);
      expect(response.writableEnded).toBe(false);
      if (beforeEnd) expect(beforeEnd).toHaveBeenCalledOnce();
    },
  );

  it("accepts inherited Viewer access but propagates absent stored sessions and invalid sources", async () => {
    const { request } = authorizedTransport();
    const validateSource = vi.fn(async () => undefined);
    const validateSession = createExportPublicationValidator(request, "AgentControl.Viewer");
    const validate = () => validateSession(validateSource);
    await validate();
    expect(storedSession.query).toHaveBeenCalledWith(expect.any(String), [
      request.sessionID, "csv-tenant", request.session.accountId, "AgentControl.Viewer", "csv-client",
    ]);
    expect(validateSource).toHaveBeenCalledOnce();
    validateSource.mockRejectedValueOnce(new AppError(409, "dataset_invalidated", "Source expired."));
    await expect(validate()).rejects.toMatchObject({ code: "dataset_invalidated" });
    storedSession.query.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    await expect(validate()).rejects.toMatchObject({ code: "unauthorized" });
    expect(validateSource).toHaveBeenCalledTimes(2);
  });

  it("rechecks durable session revocation after a source read without holding the logout lock", async () => {
    const { request, response } = authorizedTransport();
    const sourceStarted = Promise.withResolvers<void>();
    const sourceFinished = Promise.withResolvers<void>();
    let checks = 0;
    const validateSession = createExportPublicationValidator(request, "AgentControl.Viewer");
    const publication = publishBoundedCsv(request, response as unknown as Response, "safe.csv", Buffer.from("private\r\n"), {
      deadlineAt: Date.now() + 1_000,
      validate: () => validateSession(async () => {
        if (++checks !== 2) return;
        sourceStarted.resolve();
        await sourceFinished.promise;
      }),
    });
    const rejected = expect(publication).rejects.toMatchObject({ code: "unauthorized" });
    await sourceStarted.promise;
    storedSession.query.mockResolvedValue({ rowCount: 0, rows: [] });
    sourceFinished.resolve();
    await rejected;
    expect(response.headers.size).toBe(0);
    expect(response.writes).toHaveLength(0);
  });

  it.each([
    ["logout", "first chunk"], ["superseding login", "first chunk"], ["role removal", "first chunk"],
    ["logout", "between chunks"], ["logout", "after audit"], ["logout", "empty payload"],
  ] as const)(
    "rejects %s after async validation resolves for the %s", async (change, phase) => {
      const { request, response } = authorizedTransport();
      const validateSession = createExportPublicationValidator(request, "AgentControl.Viewer");
      let checks = 0;
      let mutation: Promise<unknown> | undefined;
      const size = phase === "empty payload" ? 0 : phase === "between chunks" ? 2_048 : 512;
      const pendingCheck = phase === "between chunks" || phase === "after audit" ? 3 : 2;
      const beforeEnd = phase === "after audit" ? vi.fn(async () => undefined) : undefined;
      const publication = publishBoundedCsv(request, response as unknown as Response, "safe.csv", Buffer.alloc(size), {
        deadlineAt: Date.now() + 1_000, chunkBytes: 1_024, beforeEnd,
        validate: () => {
          const validated = validateSession(async () => undefined);
          if (++checks === pendingCheck) void validated.then(() => {
            if (change === "logout") {
              mutation = revokeAccountSessionMutations("csv-tenant", request.session.accountId!, async () => undefined);
            } else if (change === "superseding login") {
              mutation = activateAccountSession("csv-tenant", request.session.accountId!, async () => undefined);
            } else request.session.user!.roles = [];
          });
          return validated;
        },
      });
      await expect(publication).rejects.toMatchObject({ code: "unauthorized" });
      await mutation;
      expect(response.writes).toHaveLength(phase === "between chunks" ? 1 : 0);
      expect(response.headers.size).toBe(phase === "between chunks" ? 4 : 0);
      expect(response.destroyed).toBe(phase === "between chunks");
      if (beforeEnd) expect(beforeEnd).toHaveBeenCalledOnce();
    },
  );
});
