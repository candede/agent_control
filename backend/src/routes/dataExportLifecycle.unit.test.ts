import { EventEmitter } from "node:events";
import type { Request, RequestHandler, Response } from "express";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "../errors.js";
import { OfficialReportImports } from "../db/officialReportImports.js";
import { LargeTenantUsersReports } from "../services/largeTenantUsersReports.js";
import { createOfficialReportDataRouter } from "./officialReportData.js";

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, RequestHandler>(),
  create: vi.fn(), current: vi.fn(),
  engine: { status: vi.fn(), download: vi.fn(), downloadHeaders: vi.fn(), cancel: vi.fn(),
    connections: { selectedRead: vi.fn() }, selections: { assert: vi.fn() } },
  validateSession: vi.fn(),
}));
vi.mock("./policy.js", () => ({
  policyRoute: (_router: unknown, method: string, path: string, _policy: unknown, ...handlers: RequestHandler[]) =>
    mocks.handlers.set(`${method} ${path}`, handlers[handlers.length - 1]),
}));
vi.mock("../db/pool.js", () => ({ pool: {}, secretValue: (name: string) => name === "TENANTS_JSON" ? "[]"
  : name === "SESSION_SECRET" ? "synthetic-durable-export-session-secret" : undefined }));
vi.mock("../middleware/auth.js", () => ({ requestScope: () => ({ tenantId: "tenant", principalId: "principal" }) }));
vi.mock("../middleware/requestAuthentication.js", () => ({
  requestUser: (request: Request) => request.session.user,
}));
vi.mock("../services/officialReportExports.js", () => ({
  OfficialReportExports: class {
    engine = mocks.engine;
    create = mocks.create;
    status = mocks.engine.status;
  },
}));
vi.mock("../services/csvExport.js", async original => ({
  ...await original<typeof import("../services/csvExport.js")>(),
  createExportPublicationValidator: () => mocks.validateSession,
}));

const id = "11111111-1111-4111-8111-111111111111";
const identity = { tenantId: "tenant", principalId: "principal", authorizationHash: "viewer", sessionEpoch: "1" };
const database = new pg.Pool({ max: 4 });
const reports = new LargeTenantUsersReports(database, "synthetic-durable-export-session-secret", 35);
const enqueue = vi.fn(async () => undefined);
const ready = () => ({ id, status: "ready", rows: 1, bytes: 9, expiresAt: new Date(Date.now() + 60_000) });

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(database, "connect").mockRejectedValue(new Error("Unexpected database acquisition."));
  vi.spyOn(database, "query").mockRejectedValue(new Error("Unexpected database query."));
  mocks.create.mockImplementation(async (_identity, _input, assertCurrent) => { assertCurrent(); return id; });
  mocks.engine.status.mockImplementation(async () => ready());
  mocks.engine.connections.selectedRead.mockImplementation(async work => work({
    query: async () => ({ rows: [{ selection_id: id, filename: "official-users.csv" }] }),
  }));
  mocks.engine.selections.assert.mockResolvedValue(undefined);
  mocks.engine.downloadHeaders.mockReturnValue({ "Content-Disposition": "attachment; filename=official-users.csv",
    "Content-Length": "9", "Content-Type": "text/csv; charset=utf-8" });
  mocks.validateSession.mockImplementation(async source => { await source?.(); return mocks.current; });
  mocks.engine.download.mockImplementation(async function* (_id, _identity, signal, publication) {
    for (const chunk of [Buffer.from("first"), Buffer.from("last")]) {
      const assertCurrent = await publication.validate();
      assertCurrent();
      signal.throwIfAborted();
      yield chunk;
    }
    await publication.validate();
    await publication.finish();
  });
  createOfficialReportDataRouter({ reports, identity: async () => ({ identity }), enqueueExport: enqueue });
});
afterEach(() => {
  expect(database.connect).not.toHaveBeenCalled();
  expect(database.query).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function transport(method = "get", path = "/data-exports/:id/download") {
  const body: Record<string, unknown> = { selectionId: id, kind: "official_users" };
  const request = Object.assign(new EventEmitter(), { path: path.replace(":id", id), params: { id },
    body, aborted: false, session: { user: { tenantId: identity.tenantId, homeAccountId: identity.principalId,
      username: "admin@example.invalid", displayName: "Admin", roles: ["AgentControl.Admin"] } } });
  const response = Object.assign(new EventEmitter(), {
    headersSent: false, destroyed: false, writableEnded: false, writableFinished: false,
    headers: new Map<string, string>(), writes: [] as Buffer[],
    set: vi.fn((headers: Record<string, string>) => {
      Object.entries(headers).forEach(([key, value]) => response.headers.set(key, value));
      return response;
    }),
    setHeader: vi.fn((key: string, value: string) => { response.headers.set(key, value); }),
    removeHeader: vi.fn((key: string) => { response.headers.delete(key); }),
    write: vi.fn((chunk: Buffer) => { response.headersSent = true; response.writes.push(chunk); return true; }),
    end: vi.fn((chunk?: Buffer) => {
      if (chunk) response.writes.push(chunk);
      response.headersSent = true; response.writableEnded = true; response.writableFinished = true;
      response.emit("finish");
    }),
    destroy: vi.fn(() => { response.destroyed = true; response.emit("close"); }),
    status: vi.fn(() => response),
    json: vi.fn(),
  });
  const next = vi.fn();
  const run = () => mocks.handlers.get(`${method} ${path}`)!(request as unknown as Request, response as unknown as Response, next);
  return { request, response, next, run };
}

describe("durable export HTTP publication", () => {
  it("matches confirmation route and body UUIDs canonically, not as report identities", async () => {
    const confirmationId = "abcdefab-1234-4567-89ab-abcdefabcdef", setId = "fedcbafe-1234-4567-89ab-fedcbafedcba";
    const { request, response, next, run } = transport("post", "/official-usage/confirmations/:id");
    request.params.id = confirmationId.toUpperCase();
    request.body = { id: confirmationId, setId, operation: "delete", activeRevision: "4",
      historyRevision: "9", historyEpoch: "2", hash: "a".repeat(64) };
    const confirm = vi.spyOn(OfficialReportImports.prototype, "confirmDeletion").mockResolvedValue({ activeSetId: setId, activeRevision: "5" });
    await run();
    expect(confirm).toHaveBeenCalledWith(identity, request.body);
    expect(response.json).toHaveBeenCalledWith({ activeSetId: setId, activeRevision: "5" });
    expect(next).not.toHaveBeenCalled();
  });

  it("passes creation's synchronous fence into the producer and revalidates before responding", async () => {
    const { response, run } = transport("post", "/data-exports");
    await run();
    expect(mocks.create).toHaveBeenCalledWith(identity, { selectionId: id, kind: "official_users" }, mocks.current);
    expect(mocks.validateSession).toHaveBeenCalledTimes(2);
    expect(response.status).toHaveBeenCalledWith(202);
    expect(response.json).toHaveBeenCalledWith({ id });
  });

  it("withdraws a late admission response after session authority is replaced", async () => {
    const { response, next, run } = transport("post", "/data-exports");
    const primary = AppError.unauthorized();
    mocks.validateSession.mockResolvedValueOnce(mocks.current).mockRejectedValueOnce(primary);
    await run();
    expect(response.json).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith(primary);
  });

  it.each(["get", "delete"])("does not publish a stale %s response after session replacement", async method => {
    const { response, next, run } = transport(method, "/data-exports/:id");
    const primary = AppError.unauthorized();
    mocks.validateSession.mockResolvedValueOnce(mocks.current).mockRejectedValueOnce(primary);
    await run();
    expect(response.json).not.toHaveBeenCalled();
    expect(response.end).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith(primary);
    if (method === "delete") expect(mocks.engine.cancel).toHaveBeenCalledWith(id, identity, mocks.current);
  });

  it("preserves failed dispatch when cancellation cleanup also fails", async () => {
    const { response, next, run } = transport("post", "/data-exports");
    const primary = new AppError(503, "export_queue_full", "Dispatch unavailable.");
    enqueue.mockRejectedValueOnce(primary);
    mocks.engine.cancel.mockRejectedValueOnce(new AppError(409, "selection_invalidated", "Selection retired."));
    await run();
    expect(response.json).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith(primary);
  });

  it("rechecks sources and the synchronous session fence, and withholds the last chunk until finish", async () => {
    const { response, next, request, run } = transport();
    await run();
    expect(Buffer.concat(response.writes).toString()).toBe("firstlast");
    expect(response.write).toHaveBeenCalledOnce();
    expect(response.end).toHaveBeenCalledExactlyOnceWith(Buffer.from("last"));
    expect(mocks.engine.status).toHaveBeenCalledTimes(4);
    expect(mocks.current).toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
    expect(request.listenerCount("aborted")).toBe(0);
    for (const event of ["drain", "finish", "close", "error"]) expect(response.listenerCount(event)).toBe(0);
  });

  it("does not release a chunk when authority changes in the consumer continuation", async () => {
    const { response, next, run } = transport();
    const primary = AppError.unauthorized();
    let current = true;
    mocks.current.mockImplementation(() => { if (!current) throw primary; });
    mocks.engine.download.mockImplementation(async function* (_id, _identity, _signal, publication) {
      await publication.validate();
      queueMicrotask(() => { current = false; });
      yield Buffer.from("first");
    });
    await run();
    expect(response.writes).toHaveLength(0);
    expect(response.end).not.toHaveBeenCalled();
    expect(response.headers.has("Content-Length")).toBe(false);
    expect(next).toHaveBeenCalledWith(primary);
  });

  it("rejects invalidation after a prior status rather than ending a complete-looking download", async () => {
    const { response, next, run } = transport();
    mocks.engine.status.mockResolvedValueOnce(ready()).mockResolvedValueOnce(ready())
      .mockResolvedValueOnce({ ...ready(), status: "cancelled" });
    await run();
    expect(response.writes).toHaveLength(0);
    expect(response.end).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: "export_not_ready" }));
  });

  it("bounds stalled drain by artifact expiry and tears down partial output", async () => {
    vi.useFakeTimers();
    const { response, run, request } = transport();
    mocks.engine.status.mockResolvedValue({ ...ready(), expiresAt: new Date(Date.now() + 30) });
    response.write.mockImplementation(chunk => {
      response.headersSent = true; response.writes.push(chunk); return false;
    });
    const publication = run();
    await vi.advanceTimersByTimeAsync(30);
    await publication;
    expect(response.destroy).toHaveBeenCalledOnce();
    expect(response.end).not.toHaveBeenCalled();
    expect(response.writes).toHaveLength(1);
    expect(request.listenerCount("aborted")).toBe(0);
    expect(response.listenerCount("drain")).toBe(0);
  });

  it("bounds stalled session validation by expiry and observes its late rejection", async () => {
    vi.useFakeTimers();
    const { response, next, run, request } = transport();
    mocks.engine.status.mockResolvedValue({ ...ready(), expiresAt: new Date(Date.now() + 30) });
    const validation = Promise.withResolvers<() => void>();
    mocks.validateSession.mockReturnValue(validation.promise);
    const publication = run();
    await vi.advanceTimersByTimeAsync(30);
    await publication;
    validation.reject(new Error("late synthetic session SQL failure"));
    await Promise.resolve();
    expect(response.writes).toHaveLength(0);
    expect(response.end).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: "export_expired" }));
    expect(request.listenerCount("aborted")).toBe(0);
  });

  it("rejects transport completion at expiry even before the deadline timer can run", async () => {
    vi.useFakeTimers();
    const { response, next, run, request } = transport();
    const expiresAt = new Date(Date.now() + 60_000);
    mocks.engine.status.mockResolvedValue({ ...ready(), expiresAt });
    const end = response.end.getMockImplementation()!;
    response.end.mockImplementation(chunk => {
      vi.setSystemTime(expiresAt);
      return end(chunk);
    });
    await run();
    expect(response.writableFinished).toBe(true);
    expect(next).not.toHaveBeenCalled();
    expect(response.destroy).toHaveBeenCalledWith(expect.objectContaining({ code: "export_expired" }));
    expect(mocks.engine.download.mock.calls[0][2].aborted).toBe(true);
    expect(request.listenerCount("aborted")).toBe(0);
    for (const event of ["drain", "finish", "close", "error"]) expect(response.listenerCount(event)).toBe(0);
  });

  it("does not relabel an on-time finish when its awaiting continuation runs after expiry", async () => {
    vi.useFakeTimers();
    const { response, next, run } = transport();
    const expiresAt = new Date(Date.now() + 60_000);
    mocks.engine.status.mockResolvedValue({ ...ready(), expiresAt });
    const end = response.end.getMockImplementation()!;
    response.end.mockImplementation(chunk => {
      end(chunk);
      vi.setSystemTime(expiresAt);
    });
    await run();
    expect(response.writableFinished).toBe(true);
    expect(response.destroy).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
    expect(mocks.engine.download.mock.calls[0][2].aborted).toBe(false);
  });

  it("sanitizes unexpected database errors before forwarding a problem response", async () => {
    const { response, next, run } = transport();
    mocks.engine.status.mockRejectedValue(new Error("synthetic SELECT private FROM internal_source"));
    await run();
    expect(response.writes).toHaveLength(0);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({
      status: 500, code: "export_failed", message: "The export could not be completed.",
    }));
  });
});
