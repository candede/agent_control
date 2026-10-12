import type { Request, RequestHandler, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "../errors.js";
import "./defenderHunting.js";

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, RequestHandler>(),
  hunting: {
    beginReadValidation: vi.fn(), catalog: vi.fn(), get: vi.fn(), rows: vi.fn(), cancel: vi.fn(),
  },
  audit: { startEvent: vi.fn(), completeEvent: vi.fn() },
  assertCurrent: vi.fn(),
  log: vi.fn(),
}));

vi.mock("./policy.js", () => ({
  policyRoute: (_router: unknown, method: string, path: string, _policy: unknown, ...handlers: RequestHandler[]) => {
    mocks.handlers.set(`${method} ${path}`, handlers[handlers.length - 1]);
  },
}));
vi.mock("../db/pool.js", () => ({ pool: {}, secretValue: vi.fn() }));
vi.mock("../middleware/auth.js", () => ({ requestScope: () => ({ tenantId: "hunting-tenant", principalId: "hunting-reader" }) }));
vi.mock("../services/defenderHunting.js", () => ({ defenderHunting: mocks.hunting }));
vi.mock("../services/auditLog.js", () => ({ getAuditLog: () => mocks.audit }));
vi.mock("../services/telemetry.js", async original => ({
  ...await original<typeof import("../services/telemetry.js")>(), operationalLog: mocks.log,
}));

beforeEach(() => {
  vi.resetAllMocks();
  mocks.hunting.beginReadValidation.mockReturnValue(mocks.assertCurrent);
  mocks.hunting.catalog.mockResolvedValue({ qualifications: [], retainedScopes: [] });
  mocks.hunting.get.mockResolvedValue({ id: "11111111-1111-4111-8111-111111111111" });
  mocks.hunting.rows.mockResolvedValue({ value: [{ agentId: "saved-agent" }], count: 1 });
  mocks.audit.startEvent.mockResolvedValue({ id: "hunting-event" });
  mocks.audit.completeEvent.mockResolvedValue(undefined);
});

function transport(method: string, path: string) {
  const request = {
    path, params: { id: "11111111-1111-4111-8111-111111111111" }, query: {}, body: {},
    session: { user: { tenantId: "hunting-tenant", homeAccountId: "hunting-reader", roles: ["AgentControl.Viewer"] } },
  } as unknown as Request;
  const response = { status: vi.fn().mockReturnThis(), json: vi.fn() };
  return { response, run: () => mocks.handlers.get(`${method} ${path}`)!(request, response as unknown as Response, vi.fn()) };
}

describe("Hunting JSON publication without services", () => {
  it.each([
    ["/hunting/catalog", "catalog"],
    ["/hunting/jobs/:id", "get"],
  ] as const)("withholds %s when authority changes after its read settles", async (path, operation) => {
    const f = transport("get", path);
    const failure = AppError.unauthorized("The initiating authority expired.");
    mocks.hunting[operation].mockImplementationOnce(async () => {
      mocks.assertCurrent.mockImplementation(() => { throw failure; });
      return {};
    });
    await expect(f.run()).rejects.toBe(failure);
    expect(f.response.json).not.toHaveBeenCalled();
  });

  it("withholds rows when saved scope is revoked during audit completion", async () => {
    const f = transport("get", "/hunting/jobs/:id/rows");
    mocks.audit.completeEvent.mockImplementationOnce(async () => {
      mocks.hunting.get.mockRejectedValueOnce(new AppError(404, "not_found", "The saved hunting scope was revoked."));
    });
    await expect(f.run()).rejects.toMatchObject({ code: "not_found" });
    expect(mocks.hunting.get).toHaveBeenCalledOnce();
    expect(mocks.audit.completeEvent).toHaveBeenLastCalledWith("hunting-event", { status: "failed", errorCode: "not_found" });
    expect(f.response.json).not.toHaveBeenCalled();
  });

  it("withholds rows when the initiating generation changes during audit completion", async () => {
    const f = transport("get", "/hunting/jobs/:id/rows");
    const failure = AppError.unauthorized("The account session changed.");
    mocks.audit.completeEvent.mockImplementationOnce(async () => {
      mocks.assertCurrent.mockImplementation(() => { throw failure; });
    });
    await expect(f.run()).rejects.toBe(failure);
    expect(f.response.json).not.toHaveBeenCalled();
  });

  it.each([
    ["get", "/hunting/jobs/:id/rows", "rows"],
    ["post", "/hunting/jobs/:id/cancel", "cancel"],
  ] as const)("preserves the primary %s %s error when failure auditing also fails", async (method, path, operation) => {
    const f = transport(method, path);
    const primary = AppError.unauthorized("The account is no longer authorized.");
    mocks.hunting[operation].mockRejectedValueOnce(primary);
    mocks.audit.completeEvent.mockRejectedValueOnce(new Error("Synthetic failure audit unavailable."));
    await expect(f.run()).rejects.toBe(primary);
    expect(mocks.log).toHaveBeenCalledWith("error", "hunting_audit_completion_failed", expect.objectContaining({
      errorCode: "audit_completion_failed",
    }));
    expect(f.response.json).not.toHaveBeenCalled();
  });
});
