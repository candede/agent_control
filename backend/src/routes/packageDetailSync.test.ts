import type { Request, RequestHandler, Response, Router } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDataSyncRouter } from "./dataSync.js";
import type { RoutePolicy } from "./policy.js";
import type { PackageDetailSyncState } from "../types/dataSync.js";

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, RequestHandler>(), policies: new Map<string, RoutePolicy>(),
  state: vi.fn(), start: vi.fn(), cancel: vi.fn(),
}));
vi.mock("../middleware/auth.js", () => ({ requestScope: vi.fn() }));
vi.mock("../services/dataSync.js", () => ({ dataSync: {} }));
vi.mock("../services/packageInventory.js", () => ({ packageInventory: {} }));
vi.mock("./policy.js", () => ({
  policyRoute: (_router: Router, method: string, path: string, policy: RoutePolicy, handler: RequestHandler) => {
    mocks.handlers.set(`${method} ${path}`, handler);
    mocks.policies.set(`${method} ${path}`, policy);
  },
}));
const user = { tenantId: "tenant", homeAccountId: "viewer", username: "viewer@example.invalid",
  displayName: "Viewer", roles: ["AgentControl.Viewer"] };
const state: PackageDetailSyncState = {
  status: "ready", total: 1_216, fresh: 140, pending: 1_076, eligible: 1_076, job: null, message: "Details remain pending.",
};
beforeEach(() => {
  for (const mock of [mocks.state, mocks.start, mocks.cancel]) mock.mockReset().mockResolvedValue(state);
  createDataSyncRouter({ state: vi.fn(), getRun: vi.fn(), start: vi.fn(), retry: vi.fn(), cancel: vi.fn(), automaticRefresh: vi.fn() },
    { detailSyncState: mocks.state, startDetailSync: mocks.start, cancelDetailSync: mocks.cancel });
});
async function invoke(method: string, path: string, input: Partial<Request> = {}) {
  const handler = mocks.handlers.get(`${method} ${path}`);
  if (!handler) throw new Error("Expected registered route.");
  const request = { query: {}, body: {}, session: { user, signedInAt: 1234 }, ...input } as Request;
  const response = { status: vi.fn().mockReturnThis(), json: vi.fn(), setHeader: vi.fn() };
  await handler(request, response as unknown as Response, error => { if (error) throw error; });
  return response;
}
describe("explicit exact-detail sync routes", () => {
  it("returns actual saved coverage with no-store and current request ownership", async () => {
    const response = await invoke("get", "/data-sync/package-details");
    expect(mocks.state).toHaveBeenCalledExactlyOnceWith(user);
    expect(response.json).toHaveBeenCalledWith(state);
    expect(response.setHeader).toHaveBeenCalledWith("Cache-Control", "no-store");
  });
  it.each(["start", "cancel"] as const)("exposes CSRF-protected %s with the active session only", async action => {
    const path = `/data-sync/package-details/${action}`;
    const response = await invoke("post", path);
    expect(mocks.policies.get(`post ${path}`)).toMatchObject({ roles: ["AgentControl.Viewer"], csrf: true, dataClass: "private_data_sync_job" });
    expect(response.status).toHaveBeenCalledWith(action === "start" ? 202 : 200);
    if (action === "start") expect(mocks.start).toHaveBeenCalledExactlyOnceWith(user, 1234);
    else expect(mocks.cancel).toHaveBeenCalledExactlyOnceWith(user);
    expect(response.json).toHaveBeenCalledWith(state);
  });
  it.each(["start", "cancel"] as const)("rejects caller-selected scope and options before %s", async action => {
    for (const input of [{ query: { tenantId: "other" } }, { body: { tokenMode: "application" } }, { body: [] }]) {
      await expect(invoke("post", `/data-sync/package-details/${action}`, input)).rejects.toMatchObject({ status: 400 });
    }
    expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.cancel).not.toHaveBeenCalled();
  });
  it("rejects status filters instead of reporting filtered coverage as complete", async () => {
    await expect(invoke("get", "/data-sync/package-details", { query: { selectionId: "frozen" } }))
      .rejects.toMatchObject({ status: 400, code: "invalid_data_sync_query" });
    expect(mocks.state).not.toHaveBeenCalled();
  });
});
