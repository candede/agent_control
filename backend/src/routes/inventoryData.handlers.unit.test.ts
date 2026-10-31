import type { Request, RequestHandler, Response } from "express";
import pg from "pg";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "../errors.js";
import { createInventoryDataRouter } from "./inventoryData.js";

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, RequestHandler>(),
  capture: vi.fn(), page: vi.fn(), invalidate: vi.fn(), presentation: vi.fn(),
  identity: vi.fn(), assertCurrent: vi.fn(), log: vi.fn(),
}));
vi.mock("./policy.js", () => ({
  policyRoute: (_router: unknown, method: string, path: string, _policy: unknown, handler: RequestHandler) =>
    mocks.handlers.set(`${method} ${path}`, handler),
}));
vi.mock("../config.js", () => ({
  config: { sessionSecret: "synthetic-inventory-handler-secret", officialUsageStaleDays: 35 },
  getTenantConfiguration: vi.fn(),
}));
vi.mock("../db/inventoryQueries.js", () => ({
  InventoryQueries: class {
    capture = mocks.capture;
    page = mocks.page;
    selections = { invalidate: mocks.invalidate };
  },
}));
vi.mock("../db/packageRefreshJobs.js", () => ({ PackageRefreshJobs: vi.fn() }));
vi.mock("../db/sessions.js", () => ({
  beginAccountSessionValidation: vi.fn(() => ({})),
  assertAccountSessionValidation: mocks.assertCurrent,
  commitAccountSessionValidation: vi.fn(),
}));
vi.mock("../middleware/auth.js", () => ({
  requestScope: (request: Request) => ({
    tenantId: request.session.user!.tenantId, principalId: request.session.user!.homeAccountId,
  }),
}));
vi.mock("../middleware/requestAuthentication.js", () => ({
  requestUser: (request: Request) => request.session.user,
}));
vi.mock("../services/reportIdentity.js", () => ({ reportIdentity: mocks.identity }));
vi.mock("../services/inventoryPresentation.js", () => ({
  inventoryPresentation: mocks.presentation, inventorySourceStatuses: vi.fn(),
}));
vi.mock("../services/capabilities.js", () => ({ capabilities: { beginOperationValidation: vi.fn() } }));
vi.mock("../services/operationalState.js", () => ({ requireProviderAdmissions: vi.fn() }));
vi.mock("./unifiedAgents.js", () => ({ agentResponsibilityQuery: vi.fn(), unifiedAgentInventoryQuery: vi.fn() }));
vi.mock("../services/telemetry.js", async original => ({
  ...await original<typeof import("../services/telemetry.js")>(), operationalLog: mocks.log,
}));

const selectionId = "33333333-3333-4333-8333-333333333333";
const identity = { tenantId: "tenant", principalId: "reader", authorizationHash: "viewer", sessionEpoch: "1" };
const receipt = {
  freshness: { state: "idle" }, summary: { total: 0 }, verification: { state: "unavailable" },
  identityCollection: { state: "unavailable" }, sources: {}, partial: false, errors: [],
};
const database = new pg.Pool({ max: 4 });

beforeEach(() => {
  vi.resetAllMocks();
  mocks.handlers.clear();
  vi.spyOn(database, "connect").mockRejectedValue(new Error("Unexpected database acquisition."));
  vi.spyOn(database, "query").mockResolvedValue({
    command: "SELECT", rowCount: 1, oid: 0, fields: [],
    rows: [{ id: "scope", published: true, previously_published: true, preparing: false }],
  });
  mocks.identity.mockResolvedValue(identity);
  mocks.capture.mockResolvedValue({ id: selectionId });
  mocks.page.mockResolvedValue({ value: [] });
  mocks.presentation.mockReturnValue(receipt);
  mocks.invalidate.mockResolvedValue(undefined);
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Unexpected application/provider request.")));
  createInventoryDataRouter(database);
});
afterEach(() => {
  try {
    expect(database.connect).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});
afterAll(async () => { await database.end(); });

function transport() {
  const request = {
    query: {}, session: { user: { tenantId: identity.tenantId, homeAccountId: identity.principalId,
      username: "reader@example.invalid", displayName: "Reader", roles: ["AgentControl.Viewer"] } },
  };
  const response = {
    setHeader: vi.fn(), status: vi.fn(() => response), json: vi.fn(),
  };
  const run = () => mocks.handlers.get("get /agent-inventory/health")!(
    request as unknown as Request, response as unknown as Response, vi.fn(),
  );
  return { request, response, run };
}

describe("inventory health selection lifecycle without a server", () => {
  it("releases its automatic selection before publishing health", async () => {
    const { response, run } = transport();
    await run();
    expect(mocks.capture).toHaveBeenCalledWith(identity, "scope", {});
    expect(mocks.page).toHaveBeenCalledWith(selectionId, identity, { limit: 1 });
    expect(mocks.invalidate).toHaveBeenCalledExactlyOnceWith(selectionId, identity);
    expect(response.json).toHaveBeenCalledWith(receipt);
    expect(mocks.invalidate.mock.invocationCallOrder[0]).toBeLessThan(response.json.mock.invocationCallOrder[0]);
  });

  it.each(["read", "presentation"])("keeps the primary %s failure when cleanup also fails", async phase => {
    const primary = new AppError(409, "selection_invalidated", "The saved inventory changed.");
    const cleanup = new AppError(503, "data_acquire_timeout", "Selection cleanup could not acquire a connection.");
    if (phase === "read") mocks.page.mockRejectedValue(primary);
    else mocks.presentation.mockImplementation(() => { throw primary; });
    mocks.invalidate.mockRejectedValue(cleanup);
    const { response, run } = transport();
    await expect(run()).rejects.toBe(primary);
    expect(mocks.invalidate).toHaveBeenCalledExactlyOnceWith(selectionId, identity);
    expect(mocks.log).toHaveBeenCalledWith("error", "inventory_health_cleanup_failed",
      expect.objectContaining({ errorCode: "data_acquire_timeout", status: 503 }));
    expect(response.json).not.toHaveBeenCalled();
  });

  it("propagates cleanup failure after a successful read instead of publishing success", async () => {
    const cleanup = new AppError(503, "data_acquire_timeout", "Selection cleanup could not acquire a connection.");
    mocks.invalidate.mockRejectedValue(cleanup);
    const { response, run } = transport();
    await expect(run()).rejects.toBe(cleanup);
    expect(response.json).not.toHaveBeenCalled();
    expect(mocks.log).not.toHaveBeenCalled();
  });

  it("withholds a completed receipt after viewer authority changes during cleanup", async () => {
    const { request, response, run } = transport();
    mocks.invalidate.mockImplementation(async () => { request.session.user.roles = []; });
    await expect(run()).rejects.toMatchObject({ status: 401, code: "unauthorized" });
    expect(response.json).not.toHaveBeenCalled();
  });

  it.each(["not_collected", "preparing", "unavailable"])("returns %s without capturing a selection", async state => {
    vi.mocked(database.query).mockResolvedValue({
      command: "SELECT", rowCount: 1, oid: 0, fields: [],
      rows: [{ id: "scope", published: false, previously_published: state === "unavailable", preparing: state === "preparing" }],
    });
    const { response, run } = transport();
    await run();
    expect(response.json).toHaveBeenCalledWith({ state, message: expect.any(String) });
    expect(mocks.capture).not.toHaveBeenCalled();
    expect(mocks.page).not.toHaveBeenCalled();
    expect(mocks.invalidate).not.toHaveBeenCalled();
  });
});
