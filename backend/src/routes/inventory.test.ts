import type { Request, RequestHandler, Response, Router } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "../errors.js";
import type { InventoryRefreshJob } from "../types/powerPlatformInventory.js";
import type { RoutePolicy } from "./policy.js";
import { createInventoryReadRouter } from "./inventory.js";

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, RequestHandler>(),
  policies: new Map<string, RoutePolicy>(),
  submit: vi.fn(), start: vi.fn(), get: vi.fn(), exact: vi.fn(), selection: vi.fn(),
}));
vi.mock("../db/pool.js", () => ({ pool: {}, secretValue: vi.fn(() => undefined) }));
vi.mock("../db/nativeInventory.js", () => ({
  NativeInventory: class { getResource = mocks.exact; getQuarantineSelection = mocks.selection; },
}));
vi.mock("../middleware/auth.js", () => ({ requestScope: () => ({ tenantId: "tenant", principalId: "principal" }) }));
vi.mock("../services/powerPlatformInventory.js", () => ({
  powerPlatformInventory: { submit: mocks.submit, start: mocks.start, get: mocks.get },
}));
vi.mock("../services/purviewAudit.js", () => ({ purviewAudit: {} }));
vi.mock("./policy.js", () => ({
  policyRoute: (_router: Router, method: string, path: string, policy: RoutePolicy, handler: RequestHandler) => {
    mocks.handlers.set(`${method} ${path}`, handler);
    mocks.policies.set(`${method} ${path}`, policy);
  },
}));

beforeEach(() => {
  for (const mock of [mocks.submit, mocks.start, mocks.get, mocks.exact, mocks.selection]) mock.mockReset();
  createInventoryReadRouter({} as never);
});
afterEach(() => vi.restoreAllMocks());

const user = { tenantId: "tenant", homeAccountId: "principal", username: "reader@example.invalid",
  displayName: "Reader", roles: ["AgentControl.Viewer"] };
const snapshotId = "11111111-1111-4111-8111-111111111111";
async function invoke(method: string, path: string, input: Partial<Request> = {}) {
  const handler = mocks.handlers.get(`${method} ${path}`);
  if (!handler) throw new Error("Expected registered route.");
  const request = { params: {}, query: {}, body: {}, get: () => undefined, session: { user }, ...input } as Request;
  const response = { locals: {}, status: vi.fn().mockReturnThis(), json: vi.fn() };
  await handler(request, response as unknown as Response, error => { if (error) throw error; });
  return response;
}

describe("Power Platform refresh admission and exact live reads", () => {
  it.each(["/inventory/refresh-jobs", "/inventory/refresh-jobs/:id/resume"])(
    "returns the persisted permission failure from %s instead of an authorization wait", async path => {
      const job: InventoryRefreshJob = {
        id: snapshotId, status: "failed", roleScope: "full",
        requestedTypes: ["microsoft.copilotstudio/agents"], environmentScope: null,
        pageCount: 0, observedCount: 0, totalRecords: null, unknownFieldCount: 0, snapshotId: null,
        errorCode: "missing_permission", message: "Review permissions; signing in again does not grant permissions.",
        createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z",
        attemptedAt: null, finishedAt: "2026-09-01T00:00:00Z",
      };
      mocks.submit.mockResolvedValue({ ...job, status: "waiting_authorization" });
      mocks.start.mockRejectedValue(new AppError(403, "missing_permission", "Permission denied."));
      mocks.get.mockResolvedValue(job);
      const response = await invoke("post", path, { params: { id: job.id } });
      expect(response.status).toHaveBeenCalledWith(202);
      expect(response.json).toHaveBeenCalledWith(job);
      expect(mocks.get).toHaveBeenCalledWith(user, job.id);
    });

  it.each(["get", "post"])("has no %s synchronous CSV or full-set resource route", method => {
    for (const path of ["/inventory/export.csv", "/inventory/resources", "/inventory/snapshots"]) {
      expect(mocks.handlers.has(`${method} ${path}`)).toBe(false);
      expect(mocks.policies.has(`${method} ${path}`)).toBe(false);
    }
  });

  it("passes only current request ownership and exact source coordinates to quarantine selection", async () => {
    const value = { value: [{ nativeId: "Native" }], snapshot: { id: snapshotId } };
    mocks.selection.mockResolvedValue(value);
    const response = await invoke("get", "/inventory/quarantine-selection", {
      query: { snapshotId, selected: ["Native", "opaque-native"] },
    });
    expect(mocks.selection).toHaveBeenCalledExactlyOnceWith(
      { tenantId: "tenant", principalId: "principal" }, snapshotId, ["Native", "opaque-native"]);
    expect(response.json).toHaveBeenCalledWith(value);
    expect(mocks.policies.get("get /inventory/quarantine-selection")).toEqual({
      access: "authenticated", dataClass: "private_inventory", roles: ["AgentControl.Viewer"],
    });
  });

  it.each([{}, { snapshotId: "not-a-revision" }, { snapshotId, selected: "bad\nidentity" }])(
    "rejects invalid exact coordinates before invoking current authority: %j", async query => {
      await expect(invoke("get", "/inventory/quarantine-selection", { query })).rejects.toBeInstanceOf(AppError);
      expect(mocks.selection).not.toHaveBeenCalled();
    });

  it("propagates the live-authority fence without substituting a saved snapshot", async () => {
    mocks.selection.mockRejectedValue(new AppError(409, "quarantine_target_unavailable", "Refresh inventory."));
    await expect(invoke("get", "/inventory/quarantine-selection", { query: { snapshotId, selected: "native" } }))
      .rejects.toMatchObject({ code: "quarantine_target_unavailable" });
    expect(mocks.exact).not.toHaveBeenCalled();
  });
});
