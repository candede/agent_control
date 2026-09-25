import type { Request, RequestHandler, Response, Router } from "express";
import session from "express-session";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { acquireDelegatedToken, revalidateAuthenticatedUser } from "../auth/msal.js";
import { PackageMutationQualificationRepository } from "../db/packageMutationQualifications.js";
import { activateAccountSession, revokeAccountSessionMutations } from "../db/sessions.js";
import { bulkJobs, runTrackedBulkJob } from "../services/bulkJobs.js";
import { capabilities } from "../services/capabilities.js";
import type { RoutePolicy } from "./policy.js";
import "./agents.js";

vi.mock("../db/pool.js", () => ({
  pool: {},
  secretValue: vi.fn((name: string) => name === "TENANT_ID" ? "11111111-1111-4111-8111-111111111111" : undefined),
  transaction: vi.fn(async () => { throw new Error("Unit tests must not access a database."); }),
}));
const handlers = vi.hoisted(() => new Map<string, RequestHandler>());
vi.mock("./policy.js", () => ({
  policyRoute: (_router: Router, method: string, path: string, _policy: RoutePolicy, handler: RequestHandler) => {
    handlers.set(`${method} ${path}`, handler);
  },
}));
vi.mock("../auth/msal.js", async original => ({
  ...await original<typeof import("../auth/msal.js")>(),
  acquireDelegatedToken: vi.fn(),
  revalidateAuthenticatedUser: vi.fn(),
}));
vi.mock("../services/bulkJobs.js", async original => ({
  ...await original<typeof import("../services/bulkJobs.js")>(),
  runTrackedBulkJob: vi.fn(),
}));

const scope = { tenantId: "11111111-1111-4111-8111-111111111111", principalId: "canary-operator" };
const user = {
  tenantId: scope.tenantId, homeAccountId: scope.principalId, displayName: "Admin",
  username: "admin@example.invalid", roles: ["AgentControl.Admin" as const],
};
const identity = {
  capabilityId: "graph.package.block.manage" as const, authMode: "delegated" as const,
  contractRevision: "a".repeat(64), configurationRevision: 1,
};
type Approval = NonNullable<Awaited<ReturnType<PackageMutationQualificationRepository["getApproved"]>>>;
const original: Approval = {
  id: "22222222-2222-4222-8222-222222222222", tenantId: scope.tenantId, targetId: "package-1", action: "block",
  actorPrincipalId: user.homeAccountId, actorName: user.displayName, approvedBy: "Approver", approvedByPrincipalId: "other-admin",
  ...identity, prestate: { kind: "block", isBlocked: false }, poststate: { kind: "block", isBlocked: true },
  restorationCriteria: { requireCurrentEqualsPoststate: true, touchedFields: ["isBlocked"] },
  status: "restoring", workflowVersion: 3, correlationId: "correlation", pairedQualificationId: null,
  jobId: null, cycleStage: "original", approvedAt: "2026-09-24T00:00:00.000Z", attemptedAt: null,
  expiresAt: "2026-09-24T00:30:00.000Z", restoredAt: null, errorCode: null, message: null,
};
const restoration: Approval = {
  ...original, id: "33333333-3333-4333-8333-333333333333", action: "unblock", cycleStage: "restoration",
  prestate: original.poststate, poststate: original.prestate, pairedQualificationId: original.id,
};
const originalJob: NonNullable<Awaited<ReturnType<typeof bulkJobs.get>>> = {
  id: "original-job", capabilityId: identity.capabilityId, tokenMode: "delegated", action: "block",
  status: "succeeded", targetBlockedState: true, confirmationHash: null, confirmation: null, confirmedAt: null,
  total: 1, completed: 1, succeeded: 1, failed: 0, skipped: 0, inconclusive: 0, cancelled: 0,
  results: [], result: undefined, currentAgentName: undefined, canResume: false,
  createdAt: original.approvedAt, updatedAt: original.approvedAt,
};
const restorationJob = { ...originalJob, id: "restoration-job", action: "unblock" as const, targetBlockedState: false };

beforeEach(async () => {
  await activateAccountSession(scope.tenantId, scope.principalId, async () => undefined);
  vi.mocked(revalidateAuthenticatedUser).mockReset().mockResolvedValue(user);
  vi.mocked(acquireDelegatedToken).mockReset().mockResolvedValue("fixture-token");
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Unit tests must not contact providers."); }));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function fixture() {
  const repository = PackageMutationQualificationRepository.prototype;
  const getApproved = vi.spyOn(repository, "getApproved").mockImplementation(async (_user, id) => id === original.id ? original : restoration);
  const createApproved = vi.spyOn(repository, "createApproved").mockResolvedValue(original);
  const claim = vi.spyOn(repository, "claimCycle").mockResolvedValue({ original, restoration });
  const record = vi.spyOn(repository, "recordCycleJob").mockResolvedValue(original);
  const authorize = vi.spyOn(repository, "authorizeCycleJob").mockResolvedValue(original);
  const complete = vi.spyOn(repository, "completeCycle").mockResolvedValue({ original, restoration });
  const qualificationIdentity = vi.spyOn(capabilities, "packageQualificationIdentity").mockResolvedValue(identity);
  const submit = vi.spyOn(bulkJobs, "submit").mockImplementation(async (_scope, input) =>
    ({ ...(input.action === "block" ? originalJob : restorationJob), status: "queued" }));
  const get = vi.spyOn(bulkJobs, "get").mockImplementation(async id => id === originalJob.id ? originalJob : restorationJob);
  const run = vi.mocked(runTrackedBulkJob).mockReset().mockImplementation(async (_id, owner, _repository, _provider, authorizeJob) => {
    if (!authorizeJob) throw new Error("Expected approval-bound authorization.");
    await authorizeJob(owner, identity.capabilityId);
  });
  function request(approve = false) {
    const path = approve ? "/agents/mutation-canaries" : "/agents/mutation-canaries/:id/execute";
    const handler = handlers.get(`post ${path}`);
    if (!handler) throw new Error("Canary handler was not registered.");
    const req: Partial<Request> = {
      path, params: { id: original.id }, sessionID: "canary-session",
      body: approve
        ? { targetId: original.targetId, action: original.action, prestate: original.prestate, poststate: original.poststate }
        : { confirmed: true, restorationApprovalId: restoration.id },
    };
    new session.MemoryStore().createSession(req as Request, {
      cookie: new session.Cookie(), tenantId: scope.tenantId, accountId: scope.principalId, user,
    });
    const json = vi.fn<Response["json"]>();
    const response: Partial<Response> = { json, status: vi.fn().mockReturnThis() };
    const pending = Promise.resolve(handler(req as Request, response as Response, error => { if (error) throw error; }));
    return { pending, json };
  }
  return { getApproved, createApproved, claim, record, authorize, complete, qualificationIdentity, submit, get, run, request };
}

async function replaceSession() {
  await revokeAccountSessionMutations(scope.tenantId, scope.principalId, async () => undefined);
  await activateAccountSession(scope.tenantId, scope.principalId, async () => undefined);
}

describe("package canary session authorization", () => {
  it("approves using the current Admin without acquiring a provider token", async () => {
    const f = fixture();
    const current = { ...user, displayName: "Current Admin" };
    vi.mocked(revalidateAuthenticatedUser).mockResolvedValue(current);
    await f.request(true).pending;
    expect(f.createApproved).toHaveBeenCalledWith(current, expect.objectContaining({ targetId: original.targetId }));
    expect(acquireDelegatedToken).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["tenant", "principal", "role"] as const)("does not approve when the current Admin's %s changes", async change => {
    const f = fixture();
    vi.mocked(revalidateAuthenticatedUser).mockResolvedValue({
      ...user, ...(change === "tenant" ? { tenantId: "other-tenant" }
        : change === "principal" ? { homeAccountId: "other-principal" } : { roles: [] }),
    });
    await expect(f.request(true).pending).rejects.toMatchObject({ status: change === "role" ? 403 : 401 });
    expect(f.createApproved).not.toHaveBeenCalled();
  });

  it("does not persist approval after session replacement while resolving its identity", async () => {
    const f = fixture();
    f.qualificationIdentity.mockImplementationOnce(async () => { await replaceSession(); return identity; });
    await expect(f.request(true).pending).rejects.toMatchObject({ code: "unauthorized" });
    expect(f.createApproved).not.toHaveBeenCalled();
  });

  it("runs both approved durable directions before publishing qualification", async () => {
    const f = fixture();
    const { pending, json } = f.request();
    await pending;
    expect(f.submit).toHaveBeenCalledTimes(2);
    expect(f.authorize).toHaveBeenCalledTimes(2);
    expect(f.complete).toHaveBeenCalledWith(user, original.id, restoration.id, { status: "qualified" }, identity, identity);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ status: "qualified" }));
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not claim approvals after session replacement during their lookup", async () => {
    const f = fixture();
    f.getApproved.mockImplementationOnce(async () => { await replaceSession(); return original; });
    await expect(f.request().pending).rejects.toMatchObject({ code: "unauthorized" });
    expect(f.claim).not.toHaveBeenCalled();
    expect(f.submit).not.toHaveBeenCalled();
  });

  it("does not submit the original job after session replacement during claim persistence", async () => {
    const f = fixture();
    let replacement: Promise<void> | undefined;
    f.claim.mockImplementationOnce(async () => {
      replacement = replaceSession();
      return { original, restoration };
    });
    await expect(f.request().pending).rejects.toMatchObject({ code: "canary_cycle_incomplete" });
    await replacement;
    expect(f.submit).not.toHaveBeenCalled();
    expect(f.run).not.toHaveBeenCalled();
    expect(f.complete.mock.calls.every(call => call[3].status !== "qualified")).toBe(true);
  });

  it.each(["original", "restoration"] as const)("stops the old cycle after session replacement during %s result loading", async stage => {
    const f = fixture();
    f.get.mockImplementation(async id => {
      if (id === (stage === "original" ? originalJob.id : restorationJob.id)) await replaceSession();
      return id === originalJob.id ? originalJob : restorationJob;
    });
    const { pending, json } = f.request();
    await expect(pending).rejects.toMatchObject({ code: "canary_cycle_incomplete" });
    expect(f.submit).toHaveBeenCalledTimes(stage === "original" ? 1 : 2);
    expect(f.complete.mock.calls.every(call => call[3].status !== "qualified")).toBe(true);
    expect(json).not.toHaveBeenCalled();
  });

  it.each(["original", "restoration"] as const)("does not authorize a new %s worker after session replacement during job attachment", async stage => {
    const f = fixture();
    f.record.mockImplementation(async (_user, id) => {
      if (id === (stage === "original" ? original.id : restoration.id)) await replaceSession();
      return id === original.id ? original : restoration;
    });
    await expect(f.request().pending).rejects.toMatchObject({ code: "canary_cycle_incomplete" });
    expect(f.authorize).toHaveBeenCalledTimes(stage === "original" ? 0 : 1);
    expect(f.complete.mock.calls.every(call => call[3].status !== "qualified")).toBe(true);
  });

  it("rejects a delayed original worker using the cycle's starting session", async () => {
    const f = fixture();
    f.run.mockImplementationOnce(async (_id, owner, _repository, _provider, authorizeJob) => {
      if (!authorizeJob) throw new Error("Expected approval-bound authorization.");
      await replaceSession();
      await authorizeJob(owner, identity.capabilityId);
    });
    await expect(f.request().pending).rejects.toMatchObject({ code: "canary_cycle_incomplete" });
    expect(f.authorize).not.toHaveBeenCalled();
    expect(acquireDelegatedToken).not.toHaveBeenCalled();
    expect(f.submit).toHaveBeenCalledOnce();
  });

  it("does not return a job token after session replacement during approval authorization", async () => {
    const f = fixture();
    let replacement: Promise<void> | undefined;
    f.authorize.mockImplementationOnce(async () => {
      replacement = replaceSession();
      return original;
    });
    await expect(f.request().pending).rejects.toMatchObject({ code: "canary_cycle_incomplete" });
    await replacement;
    expect(f.submit).toHaveBeenCalledOnce();
    expect(f.complete.mock.calls.every(call => call[3].status !== "qualified")).toBe(true);
  });
});
