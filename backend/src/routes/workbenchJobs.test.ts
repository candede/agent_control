import type { Request, RequestHandler, Response, Router } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "../errors.js";
import type { DefenderHuntingJob } from "../types/defenderHunting.js";
import type { PurviewAuditJob } from "../types/purviewAudit.js";
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
const purviewInvestigation: PurviewAuditJob = {
  id: "investigation", authorizationPrincipalId: "another-principal", tokenMode: "application",
  resultScope: { kind: "application", scopeId: "application", configurationRevision: 1 },
  status: "waiting_authorization", canResume: true, providerRowCount: 0, storedRowCount: 0,
  filters: {
    presetId: "copilot_interactions", startDateTime: dates.createdAt, endDateTime: dates.updatedAt,
    operations: ["CopilotInteraction"], userPrincipalNames: [], ipAddresses: [], objectIds: [], administrativeUnitIds: [],
  },
  displayName: "Audit search", providerQueryId: null, providerStatus: null,
  localRequestId: "local-request", providerRequestId: null, projectionVersion: 1,
  providerRequestCount: 0, activationCount: 0, pageCount: 0, byteCount: 0, unknownFieldCount: 0,
  pageComplete: false, observedRange: null, unobservedRange: null,
  qualificationId: null, cancelRequested: false, remoteWorkMayContinue: false,
  expiresAt: "2026-10-20T08:00:00.000Z", ...dates,
};
const defenderInvestigation: DefenderHuntingJob = {
  id: "investigation", authorizationPrincipalId: "another-principal", tokenMode: "application",
  resultScope: { kind: "application", scopeId: "application", configurationRevision: 1 },
  status: "waiting_authorization", canResume: true, providerRowCount: 0, storedRowCount: 0,
  filters: {
    templateId: "agents_inventory", startDateTime: dates.createdAt, endDateTime: dates.updatedAt,
    agentIds: [], blueprintIds: [], actorObjectIds: [], operations: [],
  },
  queryVersion: 3, retainedScopeId: null, localRequestId: "local-request", providerRequestId: null,
  providerRequestCount: 0, activationCount: 0, byteCount: 0,
  complete: false, noData: false, partialReason: null, observedRange: null, unobservedRange: null,
  snapshotId: null, priorSuccessfulJobId: null, qualification: null, cancelRequested: false,
  expiresAt: "2026-10-20T08:00:00.000Z", ...dates,
};
const controlJob = {
  id: "controls", action: "block", status: "partial", total: 2, completed: 1, inconclusive: 1, canResume: true,
  results: [{ status: "inconclusive", reconciliationStatus: "required" }], ...dates,
};

async function jobs(currentUser = user): Promise<WorkbenchJobsResponse> {
  const handler = mocks.handlers.get("get /workbench/jobs");
  if (!handler) throw new Error("Workbench jobs handler was not registered.");
  const request = { session: { user: currentUser, accountId: currentUser.homeAccountId } } as Request;
  const json = vi.fn<(body: WorkbenchJobsResponse) => void>();
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

describe("workbench jobs aggregation", () => {
  it("uses authenticated Viewer policy and bounded principal-scoped loaders", async () => {
    const result = await jobs();
    expect(mocks.policies.get("get /workbench/jobs")).toEqual({
      access: "authenticated", dataClass: "operational_metadata", roles: ["AgentControl.Viewer"],
    });
    const scope = { tenantId: user.tenantId, principalId: user.homeAccountId };
    expect(mocks.sync).toHaveBeenCalledWith(scope, 20);
    expect(mocks.packages).toHaveBeenCalledWith(scope, user.homeAccountId, 20);
    expect(mocks.inventory).toHaveBeenCalledWith(scope, 20);
    expect(mocks.controls).toHaveBeenCalledWith(scope, 20);
    expect(mocks.quarantine).toHaveBeenCalledWith(scope, 20);
    expect(mocks.purview).toHaveBeenCalledWith(user, 20, 0);
    expect(mocks.defender).toHaveBeenCalledWith(user, 20, 0);
    expect(mocks.usage).not.toHaveBeenCalled();
    expect(result).toMatchObject({ value: [], unavailableSources: [], requestId: "request-1" });
    expect(Number.isFinite(Date.parse(result.polledAt))).toBe(true);
  });

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

  it("reports each unavailable source once and preserves successful loaders", async () => {
    mocks.packages.mockRejectedValue(new Error("private database details"));
    mocks.defender.mockRejectedValue(new Error("private investigation details"));
    mocks.purview.mockResolvedValue({ value: [purviewInvestigation] });
    const result = await jobs();
    expect(result.value.map(job => job.source)).toEqual(["purview"]);
    expect(result.unavailableSources).toEqual([
      { source: "package-refresh", code: "source_unavailable" }, { source: "defender", code: "source_unavailable" },
    ]);
    expect(JSON.stringify(result)).not.toMatch(/private|filters|authorizationPrincipalId/);
  });

  it.each(["purview", "defender"] as const)("does not offer resume for another principal's shared %s job", async source => {
    const investigation = source === "purview" ? purviewInvestigation : defenderInvestigation;
    mocks[source].mockResolvedValue({ value: [investigation, { ...investigation, id: "owned", authorizationPrincipalId: user.homeAccountId }] });
    const result = await jobs();
    expect(result.value.find(job => job.id === "investigation")).toMatchObject({ canResume: false, canCancel: true });
    expect(result.value.find(job => job.id === "owned")).toMatchObject({ canResume: true, canCancel: true });
    expect(result.unavailableSources).toEqual([]);
  });

  it.each([
    { userPrincipalNames: [], href: "/agents" },
    { userPrincipalNames: ["one@example.invalid"], href: "/users" },
    { userPrincipalNames: ["one@example.invalid", "two@example.invalid"], href: "/agents" },
  ])("routes Purview jobs with $userPrincipalNames to $href without exposing filters", async ({ userPrincipalNames, href }) => {
    mocks.purview.mockResolvedValue({ value: [{
      ...purviewInvestigation, filters: { ...purviewInvestigation.filters, userPrincipalNames },
    }] });
    const result = await jobs();
    expect(result.value).toEqual([expect.objectContaining({ id: "investigation", source: "purview", href })]);
    expect(result.unavailableSources).toEqual([]);
    expect(JSON.stringify(result)).not.toMatch(/example\.invalid|filters|authorizationPrincipalId/);
  });

  it.each([
    ["package-controls", "controls", "partial"],
    ["quarantine", "quarantine", "inconclusive"],
  ] as const)("offers Admin cancellation for unfinished %s targets even after an inconclusive write", async (source, loader, status) => {
    mocks[loader].mockResolvedValue({ value: [
      { ...controlJob, status, canReconcile: true },
      { ...controlJob, id: "finished", status, completed: 2, canResume: false, canReconcile: true },
    ] });
    const result = await jobs({ ...user, roles: ["AgentControl.Admin"] });
    expect(result.value.find(job => job.id === "controls")).toMatchObject({ source, canCancel: true, canReconcile: true });
    expect(result.value.find(job => job.id === "finished")).toMatchObject({ canCancel: false, canReconcile: true });
    expect((await jobs()).value.every(job => !job.canCancel && !job.canResume && !job.canReconcile)).toBe(true);
  });

  it("bounds and deterministically orders metadata while retaining the Admin-only staging read", async () => {
    mocks.purview.mockResolvedValue({ value: Array.from({ length: 105 }, (_, index) => ({
      ...purviewInvestigation, id: String(index).padStart(3, "0"),
      updatedAt: index < 5 ? dates.createdAt : dates.updatedAt,
    })).reverse() });
    const result = await jobs({ ...user, roles: ["AgentControl.Admin"] });
    expect(mocks.usage).toHaveBeenCalledWith({ tenantId: user.tenantId, principalId: user.homeAccountId });
    expect(result.value).toHaveLength(100);
    expect(result.value[0].id).toBe("005");
    expect(result.value[99].id).toBe("104");
    expect(result.unavailableSources).toEqual([]);
  });
});
