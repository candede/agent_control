import { EventEmitter } from "node:events";
import type { Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { parse as parseCsv } from "csv-parse/sync";
import { activateAccountSession, revokeAccountSessionMutations } from "../db/sessions.js";
import { AppError } from "../errors.js";
import { buildBoundedCsv, createExportPublicationValidator, csvValue, publishBoundedCsv } from "./csvExport.js";

const storedSession = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../db/pool.js", () => ({ pool: storedSession, secretValue: () => undefined }));
vi.mock("../config.js", () => ({
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

  setHeader(name: string, value: string) {
    this.headers.set(name, value);
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
  it("neutralizes formulas and quotes nonempty values", () => {
    expect(["=1", "+1", "-1", "@x", "\tcmd", "\rcmd", "−1"].map(csvValue)).toEqual([
      "\"'=1\"", "\"'+1\"", "\"'-1\"", "\"'@x\"", "\"'\tcmd\"", "\"'\rcmd\"", "\"'−1\"",
    ]);
    expect(csvValue("a\"b")).toBe("\"a\"\"b\"");
  });

  it("uses compact empty cells without conflating zero, false, unknown or formula-safe text", () => {
    const csv = buildBoundedCsv(["empty", "missing", "unknown", "zero", "disabled", "formula"], [{
      empty: "", missing: undefined, unknown: null, zero: 0, disabled: false, formula: "=SUM(1,1)",
    }], { maximumRows: 1, maximumBytes: 1_000, deadlineAt: Date.now() + 10_000 });
    expect(csv.buffer.toString("utf8")).toContain('\r\n,,,"0","false","\'=SUM(1,1)"\r\n');
    expect(parseCsv(csv.buffer, { columns: true, bom: true })).toEqual([{
      empty: "", missing: "", unknown: "", zero: "0", disabled: "false", formula: "'=SUM(1,1)",
    }]);
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
});
