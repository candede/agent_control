import type { Request, RequestHandler, Response, Router } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "../errors.js";
import type { AuthenticatedUser } from "../types/session.js";
import type { WorkbenchJobsResponse } from "../types/workbench.js";
import type { RoutePolicy } from "./policy.js";

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, RequestHandler>(),
  policies: new Map<string, RoutePolicy>(),
  packages: vi.fn(),
  inventory: vi.fn(),
  usage: vi.fn(),
  sync: vi.fn(),
  controls: vi.fn(),
  quarantine: vi.fn(),
  purview: vi.fn(),
  defender: vi.fn(),
  applicationScope: vi.fn(),
}));

vi.mock("../config.js", () => ({ getTenantConfiguration: (tenantId: string) => ({
  tenantId, clientId: tenantId === "tenant" ? "application" : "other-application",
}) }));
vi.mock("../middleware/auth.js", () => ({
  requestScope: (request: Request) => ({ tenantId: request.session.user!.tenantId, principalId: request.session.accountId }),
}));
vi.mock("./policy.js", () => ({
  policyRoute: (_router: Router, method: string, path: string, policy: RoutePolicy, handler: RequestHandler) => {
    mocks.handlers.set(`${method} ${path}`, handler);
    mocks.policies.set(`${method} ${path}`, policy);
  },
}));
vi.mock("../db/packageInventory.js", () => ({
  PackageInventoryRepository: class { listJobs = mocks.packages; },
}));
vi.mock("../db/powerPlatformInventory.js", () => ({
  PowerPlatformInventoryRepository: class { listJobs = mocks.inventory; },
}));
vi.mock("../db/officialUsage.js", () => ({
  OfficialUsageRepository: class { getAdminState = mocks.usage; },
}));
vi.mock("../services/dataSync.js", () => ({ dataSync: { listRuns: mocks.sync } }));
vi.mock("../services/bulkJobs.js", () => ({ bulkJobs: { list: mocks.controls } }));
vi.mock("../services/copilotStudioQuarantineJobs.js", () => ({ copilotStudioQuarantineJobs: { list: mocks.quarantine } }));
vi.mock("../services/purviewAudit.js", () => ({ purviewAudit: { list: mocks.purview } }));
vi.mock("../services/defenderHunting.js", () => ({ defenderHunting: { list: mocks.defender } }));
vi.mock("../services/capabilities.js", () => ({ capabilities: { requireApplicationDataScope: mocks.applicationScope } }));
import "./workbench.js";

const user: AuthenticatedUser = {
  tenantId: "tenant", homeAccountId: "principal", username: "reader@example.invalid",
  displayName: "Reader", roles: ["AgentControl.Viewer"],
};
const dates = { createdAt: "2026-09-20T07:00:00.000Z", updatedAt: "2026-09-20T08:00:00.000Z", attemptedAt: null, finishedAt: null };
const packageJob = {
  id: "package-job", tokenMode: "delegated", scopeKind: "broad", requestedIds: [],
  authorizationPrincipalId: user.homeAccountId, status: "waiting_authorization", observedCount: 0, totalRecords: null, ...dates,
};
const inventoryJob = {
  id: "inventory-job", status: "succeeded", requestedTypes: ["microsoft.copilotstudio/agents"],
  environmentScope: null, observedCount: 7, totalRecords: 7, ...dates,
};

async function jobs(currentUser = user): Promise<WorkbenchJobsResponse> {
  const handler = mocks.handlers.get("get /workbench/jobs");
  if (!handler) throw new Error("Workbench jobs handler was not registered.");
  const request = { session: { user: currentUser, accountId: currentUser.homeAccountId } } as Request;
  const json = vi.fn<(body: WorkbenchJobsResponse) => Response>().mockReturnThis();
  const response = { locals: { requestId: "request-1" }, json } as Partial<Response>;
  await handler(request, response as Response, error => { if (error) throw error; });
  expect(json).toHaveBeenCalledOnce();
  return json.mock.calls[0][0];
}

beforeEach(() => {
  for (const load of [mocks.packages, mocks.inventory, mocks.controls, mocks.quarantine, mocks.purview, mocks.defender]) {
    load.mockReset().mockResolvedValue({ value: [] });
  }
  mocks.sync.mockReset().mockResolvedValue([]);
  mocks.usage.mockReset().mockResolvedValue({ staging: [] });
  mocks.applicationScope.mockReset().mockResolvedValue({ enabled: true, sharedDataScope: true });
});

describe("sync history aggregation", () => {
  it("uses authenticated Viewer policy and bounded principal-scoped collection loaders", async () => {
    const result = await jobs();
    expect(mocks.policies.get("get /workbench/jobs")).toEqual({
      access: "authenticated", dataClass: "operational_metadata", roles: ["AgentControl.Viewer"],
    });
    const scope = { tenantId: user.tenantId, principalId: user.homeAccountId };
    expect(mocks.sync).toHaveBeenCalledWith(scope, 20);
    expect(mocks.packages).toHaveBeenCalledWith(scope, user.homeAccountId, 20);
    expect(mocks.inventory).toHaveBeenCalledWith(scope, 20);
    expect(result).toMatchObject({ value: [], unavailableSources: [], requestId: "request-1" });
    expect(Number.isFinite(Date.parse(result.polledAt))).toBe(true);
  });

  it.each(["AgentControl.Viewer", "AgentControl.Admin"] as const)(
    "does not query or expose retired task-dashboard sources for %s", async role => {
      mocks.packages.mockResolvedValue({ value: [packageJob] });
      mocks.inventory.mockResolvedValue({ value: [inventoryJob] });
      for (const load of [mocks.controls, mocks.quarantine, mocks.purview, mocks.defender, mocks.usage]) {
        load.mockRejectedValue(new Error("Unrelated source unavailable"));
      }
      const result = await jobs({ ...user, roles: [role] });
      for (const load of [mocks.controls, mocks.quarantine, mocks.purview, mocks.defender, mocks.usage]) {
        expect(load).not.toHaveBeenCalled();
      }
      expect(result.value.map(job => job.source)).toEqual(["power-platform", "package-refresh", "package-refresh"]);
      expect(result.unavailableSources).toEqual([]);
      expect(JSON.stringify(result)).not.toMatch(/canResume|canCancel|canReconcile|authorizationPrincipalId/);
    },
  );

  it("includes the requesting principal's approved application package jobs with their mode", async () => {
    mocks.packages.mockImplementation(async (scope: { principalId: string }) => ({
      value: [{ ...packageJob, id: scope.principalId, tokenMode: scope.principalId === "application" ? "application" : "delegated" }],
    }));
    const result = await jobs();
    expect(mocks.applicationScope).toHaveBeenCalledWith("graph.package.read.application", user);
    expect(mocks.packages).toHaveBeenCalledWith({ tenantId: user.tenantId, principalId: "application" }, user.homeAccountId, 20);
    expect(result.value).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "application", source: "package-refresh", tokenMode: "application", href: "/sync?refreshJob=application&mode=application" }),
      expect.objectContaining({ id: "principal", source: "package-refresh", tokenMode: "delegated" }),
    ]));
  });

  it("loads shared application jobs using the signed-in tenant's client ID", async () => {
    const otherUser = { ...user, tenantId: "other-tenant" };
    await jobs(otherUser);
    expect(mocks.packages).toHaveBeenCalledWith(
      { tenantId: otherUser.tenantId, principalId: "other-application" }, user.homeAccountId, 20,
    );
    expect(mocks.packages.mock.calls.every(([scope]) => scope.tenantId === otherUser.tenantId)).toBe(true);
    expect(mocks.packages).not.toHaveBeenCalledWith(
      expect.objectContaining({ principalId: "application" }), expect.anything(), expect.anything(),
    );
  });

  it("does not read an unapproved application scope or mark disabled collection as a failed source", async () => {
    mocks.applicationScope.mockRejectedValue(new AppError(403, "not_configured", "Shared application scope is disabled."));
    mocks.packages.mockResolvedValue({ value: [packageJob] });
    const result = await jobs();
    expect(mocks.packages).toHaveBeenCalledOnce();
    expect(result.value).toHaveLength(1);
    expect(result.unavailableSources).toEqual([]);
  });

  it("retains delegated jobs when the application-scope read fails", async () => {
    mocks.applicationScope.mockRejectedValue(new Error("private storage failure"));
    mocks.packages.mockResolvedValue({ value: [packageJob] });
    const result = await jobs();
    expect(result.value).toHaveLength(1);
    expect(result.unavailableSources).toEqual([{ source: "package-refresh", code: "source_unavailable" }]);
    expect(JSON.stringify(result)).not.toContain("private storage failure");
  });

  it("reports each unavailable collection source once and preserves successful loaders", async () => {
    mocks.packages.mockRejectedValue(new Error("private database details"));
    mocks.sync.mockRejectedValue(new Error("private sync details"));
    mocks.inventory.mockResolvedValue({ value: [inventoryJob] });
    const result = await jobs();
    expect(result.value.map(job => job.source)).toEqual(["power-platform"]);
    expect(result.unavailableSources).toEqual([
      { source: "data-sync", code: "source_unavailable" }, { source: "package-refresh", code: "source_unavailable" },
    ]);
    expect(JSON.stringify(result)).not.toMatch(/private|authorizationPrincipalId/);
  });

  it("bounds and deterministically orders collection metadata", async () => {
    mocks.inventory.mockResolvedValue({ value: Array.from({ length: 105 }, (_, index) => ({
      ...inventoryJob, id: String(index).padStart(3, "0"),
      updatedAt: index < 5 ? dates.createdAt : dates.updatedAt,
    })).reverse() });
    const result = await jobs({ ...user, roles: ["AgentControl.Admin"] });
    expect(result.value).toHaveLength(100);
    expect(result.value[0].id).toBe("005");
    expect(result.value[99].id).toBe("104");
    expect(result.unavailableSources).toEqual([]);
  });
});
