import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { Request, Response } from "express";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OfficialReportImports } from "../db/officialReportImports.js";
import { AppError, normalizeError } from "../errors.js";
import { reportBase, schemaRegistry } from "../services/officialReportFields.js";
import { streamOfficialReport } from "../services/officialReportStream.js";
import { officialReportMultipart } from "./officialReportMultipart.js";

const auth = vi.hoisted(() => ({ roles: ["AgentControl.Admin"] }));
vi.mock("../db/pool.js", () => ({
  pool: {}, secretValue: (name: string) => name === "TENANTS_JSON" ? "[]"
    : name === "SESSION_SECRET" ? "synthetic-multipart-unit-session-secret" : undefined,
}));
vi.mock("../middleware/auth.js", () => ({
  requestScope: () => ({ tenantId: "tenant", principalId: "principal" }),
}));
vi.mock("../middleware/requestAuthentication.js", () => ({
  requestUser: () => ({ roles: auth.roles }),
}));
vi.mock("../services/telemetry.js", async original => ({
  ...await original<typeof import("../services/telemetry.js")>(), operationalLog: vi.fn(),
}));

const bundleId = "11111111-1111-4111-8111-111111111111";
const correctionId = "22222222-2222-4222-8222-222222222222";
const identity = { tenantId: "tenant", principalId: "principal", sessionEpoch: "1", authorizationHash: "admin" };
const boundary = "official-multipart-unit";
const contentType = `multipart/form-data; boundary=${boundary}`;
const csv = `${schemaRegistry.users.headers.join(",")}\r\nuser,Name,1,2,2026-07-06\r\n`;
const file = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="users.csv"\r\nContent-Type: text/csv\r\n\r\n${csv}\r\n`;
const close = `--${boundary}--\r\n`;
const field = (name: string, value: string) => `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
const pools = new Set<pg.Pool>();

beforeEach(() => {
  auth.roles = ["AgentControl.Admin"];
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Unexpected provider request.")));
});
afterEach(async () => {
  try {
    expect(fetch).not.toHaveBeenCalled();
    for (const database of pools) {
      expect(database.connect).not.toHaveBeenCalled();
      expect(database.query).not.toHaveBeenCalled();
      await database.end();
    }
  } finally {
    pools.clear();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  }
});

function fixture() {
  const database = new pg.Pool({ max: 4 });
  pools.add(database);
  vi.spyOn(database, "connect").mockRejectedValue(new Error("Unexpected database acquisition."));
  vi.spyOn(database, "query").mockRejectedValue(new Error("Unexpected database query."));
  const imports = new OfficialReportImports(database);
  const cancel = vi.fn(async () => {});
  const finish = vi.fn(async (metadata: Parameters<Awaited<ReturnType<OfficialReportImports["open"]>>["finish"]>[0]) => ({
    id: correctionId, revision: 1, bundleId, correctionOfSetId: null, kind: "users" as const,
    contentHash: "a".repeat(64), fileHash: "b".repeat(64), activeRevision: "1",
    ...reportBase("users", metadata, []), rowCount: 1, storedBytes: 100, wireBytes: Buffer.byteLength(csv),
    expiresAt: "2026-07-06T01:00:00Z", examples: [], warnings: [], reconciliation: {}, status: "active",
  }));
  const receive = vi.fn(async (input: AsyncIterable<Uint8Array>, signal: AbortSignal) => {
    const report = await streamOfficialReport(input, undefined, signal, { batch: async () => {} });
    return { kind: report.kind, rows: report.rowCount, wireBytes: report.wireBytes };
  });
  const open = vi.spyOn(imports, "open").mockImplementation(async (_identity, _intent, signal) => ({
    id: correctionId, signal: signal!, cancel, finish, receive: input => receive(input, signal!),
  }));
  const resolveImports = vi.fn(() => imports), identify = vi.fn(async () => identity);
  const middleware = officialReportMultipart(resolveImports, identify);
  function upload(body = file + close, type = contentType, query: Record<string, unknown> = { bundleId }) {
    const request = Object.assign(new PassThrough(), {
      method: "POST", headers: { "content-type": type, "content-length": String(Buffer.byteLength(body)) },
      query, complete: true,
    });
    const response = Object.assign(new EventEmitter(), {
      writableFinished: false, headersSent: false, destroyed: false,
      setHeader: vi.fn(), status: vi.fn(), json: vi.fn(),
    });
    const result = new Promise<unknown>(resolve => {
      response.status.mockReturnValue(response);
      response.json.mockImplementation(value => {
        response.writableFinished = true; response.emit("finish"); resolve(value);
        return response;
      });
      middleware(request as unknown as Request, response as unknown as Response, failure => {
        response.writableFinished = true; response.emit("finish"); resolve(failure);
      });
    });
    request.end(body);
    return { request, response, result };
  }
  return { upload, open, receive, finish, cancel, identify, resolveImports };
}

describe("official report multipart without services", () => {
  it.each([
    ["missing boundary", "x", "multipart/form-data"],
    ["unsupported multipart content type", "x", "multipart/mixed; boundary=example"],
    ["uppercase unsupported multipart content type", "x", "MULTIPART/MIXED; boundary=example"],
    ["malformed part header", `--${boundary}\r\nBad header\r\n\r\nx\r\n${close}`, contentType],
    ["truncated form", field("downloadedAt", "2026-07-06T00:00:00Z"), contentType],
    ["truncated file", file, contentType],
  ])("rejects a %s as a bounded client error", async (_name, body, type) => {
    const { upload, finish } = fixture();
    const { result } = upload(body, type);
    expect(normalizeError(await result)).toMatchObject({ status: 400, code: "invalid_multipart" });
    expect(finish).not.toHaveBeenCalled();
    await turn();
  });

  it.each([false, true])("retains complete metadata when file-first=%s", async fileFirst => {
    const { upload, open, finish, cancel, identify, resolveImports } = fixture();
    const fields = field("reportingStart", "2026-06-07") + field("reportingEnd", "2026-07-06")
      + field("periodProvenance", "operator_asserted") + field("sourceAsOf", "2026-07-07T00:00:00Z")
      + field("sourceAsOfProvenance", "operator_asserted") + field("downloadedAt", "2026-07-08T00:00:00Z");
    const { request, response, result } = upload((fileFirst ? file + fields : fields + file) + close, contentType,
      { bundleId, correctionOfSetId: correctionId, rejectDuplicateKind: "true" });
    expect(await result).toMatchObject({ bundleId, rowCount: 1 });
    expect(response.status).toHaveBeenCalledWith(201);
    expect(identify).toHaveBeenCalledExactlyOnceWith(request);
    expect(resolveImports).toHaveBeenCalledExactlyOnceWith(request);
    expect(open).toHaveBeenCalledWith(identity, { bundleId, correctionOfSetId: correctionId, rejectDuplicateKind: true }, expect.any(AbortSignal));
    expect(finish).toHaveBeenCalledExactlyOnceWith({
      reportingPeriod: { startDate: "2026-06-07", endDate: "2026-07-06", provenance: "operator_asserted" },
      sourceAsOf: { value: "2026-07-07T00:00:00Z", provenance: "operator_asserted" }, downloadedAt: "2026-07-08T00:00:00Z",
    });
    expect(cancel).not.toHaveBeenCalled();
  });

  it.each([
    new AppError(503, "data_queue_full", "Unexpected end of form"),
    new Error("Unexpected persistence failure."),
    new Error("Unexpected end of form"),
  ])("preserves storage failures instead of misclassifying them as parser syntax (%#)", async failure => {
    const { upload, receive, finish, cancel } = fixture();
    receive.mockRejectedValueOnce(failure);
    expect(await upload().result).toBe(failure);
    expect(normalizeError(failure).status).toBe(failure instanceof AppError ? 503 : 500);
    expect(finish).not.toHaveBeenCalled();
    await turn();
    expect(cancel).toHaveBeenCalled();
  });

  it("preserves finalization failures and cleans the upload", async () => {
    const { upload, finish, cancel } = fixture();
    const failure = new AppError(409, "duplicate_report_kind", "Draft already contains this report kind.");
    finish.mockRejectedValueOnce(failure);
    expect(await upload().result).toBe(failure);
    await turn();
    expect(cancel).toHaveBeenCalled();
  });

  it.each([
    field("downloadedAt", "2026-07-06T00:00:00Z") + field("downloadedAt", "2026-07-07T00:00:00Z"),
    field("unexpected", "value"),
    field("reportingStart", "2026-07-06"),
    field("sourceAsOf", "2026-07-06T00:00:00Z"),
  ])("rejects repeated, unknown or incomplete metadata (%#)", async fields => {
    const { upload, finish, cancel } = fixture();
    expect(await upload(fields + file + close).result).toMatchObject({ status: 400, code: "invalid_metadata" });
    expect(finish).not.toHaveBeenCalled();
    await turn();
    expect(cancel).toHaveBeenCalled();
  });

  it("retains Multer limit errors as client errors and releases admission", async () => {
    const { upload, open } = fixture();
    for (let n = 0; n < 3; n++) {
      expect(await upload(field("downloadedAt", "x".repeat(4097)) + file + close).result)
        .toMatchObject({ status: 400, code: "invalid_multipart" });
      await turn();
    }
    expect(open).not.toHaveBeenCalled();
    expect(await upload().result).toMatchObject({ bundleId, rowCount: 1 });
  });

  it("denies uploader correction intent before identity or import acquisition", async () => {
    const { upload, open, identify, resolveImports } = fixture();
    auth.roles = ["AgentControl.UsageReportUploader"];
    expect(await upload(file + close, contentType, { bundleId, correctionOfSetId: correctionId }).result)
      .toMatchObject({ status: 403, code: "missing_internal_role" });
    expect(open).not.toHaveBeenCalled();
    expect(identify).not.toHaveBeenCalled();
    expect(resolveImports).not.toHaveBeenCalled();
    expect(await upload().result).toMatchObject({ bundleId, rowCount: 1 });
  });

  it.each([
    { bundleId, rejectDuplicateKind: ["true", "false"] },
    { bundleId, rejectDuplicateKind: "TRUE" },
    { bundleId, unexpected: "value" },
    { bundleId: ["one", "two"] },
  ])("rejects malformed immutable intent without acquiring imports (%#)", async query => {
    const { upload, open, identify } = fixture();
    expect(normalizeError(await upload(file + close, contentType, query).result).status).toBe(400);
    expect(open).not.toHaveBeenCalled();
    expect(identify).not.toHaveBeenCalled();
  });

  it("holds admission after a deadline until late import acquisition and cleanup settle", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { upload, open, cancel } = fixture();
    const original = open.getMockImplementation()!;
    let releaseFirst!: () => void, releaseSecond!: () => void;
    const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
    const secondGate = new Promise<void>(resolve => { releaseSecond = resolve; });
    open.mockImplementationOnce(async (...args) => { await firstGate; return original(...args); });
    const first = upload();
    await turn();
    vi.advanceTimersByTime(30 * 60_000);
    expect(await first.result).toMatchObject({ status: 408, code: "upload_deadline" });

    open.mockImplementationOnce(async (...args) => { await secondGate; return original(...args); });
    const second = upload();
    await turn();
    try {
      expect(await upload().result).toMatchObject({ status: 429, code: "upload_admission_full" });
      releaseFirst();
      await turn(); await turn();
      expect(cancel).toHaveBeenCalledOnce();
      expect(await upload().result).toMatchObject({ bundleId, rowCount: 1 });
    } finally { releaseFirst(); releaseSecond(); }
    expect(await second.result).toMatchObject({ bundleId, rowCount: 1 });
  });
});
