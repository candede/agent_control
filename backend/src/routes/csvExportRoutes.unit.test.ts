import type { Request, RequestHandler, Response } from "express";
import type { publishBoundedCsv } from "../services/csvExport.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "../errors.js";
import { capabilities } from "../services/capabilities.js";
import { config } from "../config.js";
import "./audit.js";
import "./defenderHunting.js";
import "./purviewAudit.js";

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, RequestHandler>(),
  audit: {
    startEvent: vi.fn(),
    completeEvent: vi.fn(),
    getExportEvents: vi.fn(),
  },
  hunting: { get: vi.fn(), rows: vi.fn() },
  purview: { get: vi.fn(), records: vi.fn(), submit: vi.fn(), start: vi.fn() },
  publish: vi.fn<typeof publishBoundedCsv>(),
  assertCurrent: vi.fn(),
  log: vi.fn(),
}));

vi.mock("./policy.js", () => ({
  policyRoute: (_router: unknown, method: string, path: string, _policy: unknown, ...handlers: RequestHandler[]) => {
    mocks.handlers.set(`${method} ${path}`, handlers[handlers.length - 1]);
  },
}));
vi.mock("../db/pool.js", () => ({ pool: {}, secretValue: vi.fn() }));
vi.mock("../middleware/auth.js", () => ({ requestScope: () => ({ tenantId: "csv-tenant", principalId: "csv-principal" }) }));
vi.mock("../services/auditLog.js", () => ({ getAuditLog: () => mocks.audit }));
vi.mock("../services/defenderHunting.js", () => ({ defenderHunting: mocks.hunting }));
vi.mock("../services/purviewAudit.js", () => ({ purviewAudit: mocks.purview }));
vi.mock("../services/csvExport.js", () => ({
  createExportPublicationValidator: () => async (source?: () => Promise<void>) => { await source?.(); return mocks.assertCurrent; },
  publishBoundedCsv: mocks.publish,
}));
vi.mock("../services/telemetry.js", async original => ({
  ...await original<typeof import("../services/telemetry.js")>(), operationalLog: mocks.log,
}));

const paths = ["/audit/events/export.csv", "/hunting/jobs/:id/export.csv", "/audit-search/jobs/:id/export.csv"];
const originalTenants = config.tenants;

beforeEach(() => {
  config.tenants = [{ tenantId: "csv-tenant", clientId: "csv-api", clientSecret: "synthetic-unused", domains: ["example.invalid"] }];
  vi.resetAllMocks();
  mocks.audit.startEvent.mockResolvedValue({ id: "csv-receipt" });
  mocks.audit.completeEvent.mockResolvedValue(undefined);
  mocks.audit.getExportEvents.mockResolvedValue([{ id: "event-1", actor: { username: "reader@example.invalid", displayName: "Reader" } }]);
  mocks.hunting.get.mockResolvedValue({});
  mocks.hunting.rows.mockResolvedValue({ count: 0, value: [] });
  mocks.purview.get.mockResolvedValue({ status: "succeeded" });
  mocks.purview.records.mockResolvedValue({ count: 0, value: [], job: { filters: {}, resultScope: {} } });
});
afterEach(() => { vi.restoreAllMocks(); config.tenants = originalTenants; });

function transport(path: string, method = path === "/audit/events/export.csv" ? "post" : "get") {
  const request = {
    path, params: { id: "11111111-1111-4111-8111-111111111111" }, query: {}, body: { ids: ["event-1"] },
    aborted: false, session: { tenantId: "csv-tenant", clientId: "csv-api", accountId: "csv-principal", signedInAt: Date.now(),
      rolesValidatedAt: Date.now(), user: { tenantId: "csv-tenant", homeAccountId: "csv-principal",
        username: "reader@example.invalid", displayName: "Reader", roles: ["AgentControl.Viewer"], providerRoleIds: [] } },
    get: vi.fn(() => undefined),
  } as unknown as Request;
  const response = {
    headersSent: false, destroyed: false, writableEnded: false, writableFinished: false,
    json: vi.fn(),
    destroy: vi.fn(() => { response.destroyed = true; }),
  };
  const handler = mocks.handlers.get(`${method} ${path}`)!;
  return { request, response, run: () => handler(request, response as unknown as Response, vi.fn()) };
}

describe("CSV export route failure handling", () => {
  it.each(["/audit-search/jobs", "/audit-search/jobs/:id/resume"])("does not start provider work after authority changes in an awaited admission for %s", async path => {
    let current = true;
    const failure = new AppError(401, "authorization_expired", "Initiating authority changed.");
    vi.spyOn(capabilities, "beginOperationValidation").mockReturnValue(() => { if (!current) throw failure; });
    const { request, response, run } = transport(path, "post");
    request.body = { tokenMode: "delegated", filters: {} };
    const admitted = async () => { current = false; return { id: request.params.id, tokenMode: "delegated", status: "waiting_authorization" }; };
    if (path.endsWith("/resume")) mocks.purview.get.mockImplementationOnce(admitted);
    else mocks.purview.submit.mockImplementationOnce(admitted);
    await expect(run()).rejects.toBe(failure);
    expect(mocks.purview.start).not.toHaveBeenCalled();
    expect(response.json).not.toHaveBeenCalled();
  });

  it.each(["/audit-search/jobs/:id", "/audit-search/jobs/:id/records"])("withholds saved JSON after initiating authority changes for %s", async path => {
    let current = true;
    const failure = new AppError(401, "authorization_expired", "Audit Search authority changed.");
    vi.spyOn(capabilities, "beginOperationValidation").mockReturnValue(() => { if (!current) throw failure; });
    const { response, run } = transport(path);
    if (path.endsWith("/records")) mocks.audit.completeEvent.mockImplementationOnce(async () => { current = false; });
    else mocks.purview.get.mockImplementationOnce(async () => { current = false; return { status: "succeeded" }; });
    await expect(run()).rejects.toBe(failure);
    expect(response.json).not.toHaveBeenCalled();
  });

  it.each(paths)("preserves the synchronous publication fence and audits success once for %s", async path => {
    const { run } = transport(path);
    mocks.publish.mockImplementation(async (_request, _response, _filename, _csv, options) => {
      const assertCurrent = await options.validate();
      if (path !== "/audit/events/export.csv") {
        expect(assertCurrent).toEqual(expect.any(Function));
        assertCurrent?.();
        expect(mocks.assertCurrent).toHaveBeenCalled();
      } else expect(assertCurrent).toBe(mocks.assertCurrent);
      await options.beforeEnd?.();
      const afterAudit = await options.validate();
      if (path !== "/audit/events/export.csv") {
        expect(afterAudit).toEqual(expect.any(Function));
        afterAudit?.();
        expect(mocks.assertCurrent).toHaveBeenCalled();
      } else expect(afterAudit).toBe(mocks.assertCurrent);
    });
    await run();
    expect(mocks.audit.startEvent).toHaveBeenCalledOnce();
    expect(mocks.audit.completeEvent).toHaveBeenCalledExactlyOnceWith("csv-receipt", {
      status: "succeeded", metadata: expect.objectContaining({ resultingCount: expect.any(Number), resultingBytes: expect.any(Number) }),
    });
  });

  it.each(["/hunting/jobs/:id/export.csv", "/audit-search/jobs/:id/export.csv"])("rejects a capability change before synchronous publication for %s", async path => {
    const { run } = transport(path);
    let current = true;
    const failure = new AppError(401, "authorization_expired", "Defender capability changed.");
    vi.spyOn(capabilities, "beginOperationValidation").mockReturnValue(() => { if (!current) throw failure; });
    mocks.publish.mockImplementation(async (_request, _response, _filename, _csv, options) => {
      const assertCurrent = await options.validate();
      current = false;
      assertCurrent?.();
    });
    await expect(run()).rejects.toBe(failure);
    expect(mocks.audit.completeEvent).toHaveBeenCalledExactlyOnceWith("csv-receipt", { status: "failed", errorCode: "authorization_expired" });
  });

  it.each(paths)("records one ordered correction when publication fails after its success audit for %s", async path => {
    const { run } = transport(path);
    const failure = new AppError(409, "dataset_invalidated", "The export source was revoked after auditing.");
    mocks.publish.mockImplementation(async (_request, _response, _filename, _csv, options) => {
      await options.beforeEnd?.();
      throw failure;
    });
    await expect(run()).rejects.toBe(failure);
    expect(mocks.audit.startEvent).toHaveBeenCalledOnce();
    expect(mocks.audit.completeEvent).toHaveBeenCalledTimes(2);
    expect(mocks.audit.completeEvent).toHaveBeenNthCalledWith(1, "csv-receipt", expect.objectContaining({ status: "succeeded" }));
    expect(mocks.audit.completeEvent).toHaveBeenNthCalledWith(2, "csv-receipt", { status: "failed", errorCode: "dataset_invalidated" });
  });

  it.each(["running", "failed"])("rejects a %s Purview job rather than publishing an empty successful download", async status => {
    const { run } = transport("/audit-search/jobs/:id/export.csv");
    mocks.purview.get.mockResolvedValue({ status });
    await expect(run()).rejects.toMatchObject({ status: 409, code: "audit_job_state" });
    expect(mocks.purview.records).not.toHaveBeenCalled();
    expect(mocks.publish).not.toHaveBeenCalled();
    expect(mocks.audit.completeEvent).toHaveBeenCalledWith("csv-receipt", { status: "failed", errorCode: "audit_job_state" });
  });

  it("retains access to published partial Purview results", async () => {
    const { run } = transport("/audit-search/jobs/:id/export.csv");
    mocks.purview.get.mockResolvedValue({ status: "partial" });
    mocks.publish.mockResolvedValue(undefined);
    await run();
    expect(mocks.purview.records).toHaveBeenCalledOnce();
    expect(mocks.publish).toHaveBeenCalledOnce();
  });

  it.each(paths)("preserves the primary error when failure auditing also fails for %s", async path => {
    const { response, run } = transport(path);
    const primary = new AppError(401, "unauthorized", "The export session expired.");
    const secondary = new Error("synthetic failure auditing error");
    mocks.publish.mockRejectedValue(primary);
    mocks.audit.completeEvent.mockRejectedValue(secondary);
    await expect(run()).rejects.toBe(primary);
    expect(mocks.audit.completeEvent).toHaveBeenCalledWith("csv-receipt", { status: "failed", errorCode: "unauthorized" });
    expect(mocks.log).toHaveBeenCalledWith("error", "export_audit_completion_failed", expect.objectContaining({
      errorCode: "audit_completion_failed", errorKind: "unexpected",
    }));
    expect(response.destroy).not.toHaveBeenCalled();
  });

  it.each(paths)("tears down partial output before awaiting failure auditing for %s", async path => {
    const { response, run } = transport(path);
    const auditStarted = Promise.withResolvers<void>();
    const auditFinished = Promise.withResolvers<void>();
    mocks.publish.mockImplementation(async (_request, stream) => {
      Object.assign(stream, { headersSent: true });
      throw new AppError(409, "dataset_invalidated", "The source was revoked.");
    });
    mocks.audit.completeEvent.mockImplementation(() => { auditStarted.resolve(); return auditFinished.promise; });
    const publication = run();
    await auditStarted.promise;
    try {
      expect(response.destroy).toHaveBeenCalledOnce();
      expect(response.destroyed).toBe(true);
    } finally {
      auditFinished.resolve();
      await publication;
    }
    expect(mocks.audit.completeEvent).toHaveBeenCalledWith("csv-receipt", { status: "failed", errorCode: "dataset_invalidated" });
  });
});
