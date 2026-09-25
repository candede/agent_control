import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CopilotStudioQuarantineCanaryRepository, type QuarantineCanaryApproval } from "../db/copilotStudioQuarantineCanaries.js";
import { CopilotStudioQuarantineRepository, createQuarantineConfirmation } from "../db/copilotStudioQuarantine.js";
import { PowerPlatformInventoryRepository } from "../db/powerPlatformInventory.js";
import { pool } from "../db/pool.js";
import { activateAccountSession, revokeAccountSessionMutations } from "../db/sessions.js";
import { AppError } from "../errors.js";
import type { InventoryQuarantineTarget, QuarantineJob } from "../types/copilotStudioQuarantine.js";
import type { AuthenticatedUser } from "../types/session.js";
import { CopilotStudioQuarantineClient } from "./copilotStudioQuarantine.js";
import { CopilotStudioQuarantineCanaryService } from "./copilotStudioQuarantineCanaries.js";
import { runTrackedCopilotStudioQuarantineJob } from "./copilotStudioQuarantineJobs.js";
import type { capabilities } from "./capabilities.js";

vi.mock("./copilotStudioQuarantineJobs.js", () => ({ runTrackedCopilotStudioQuarantineJob: vi.fn() }));

const authority = { contractRevision: "a".repeat(64), permissionRevision: "b".repeat(64), configurationRevision: 1 };
const timestamps = ["2026-09-09T19:00:00.1234567Z", "2026-09-09T19:00:01.1234567Z", "2026-09-09T19:00:02.1234567Z"];
const target: InventoryQuarantineTarget = {
  resourceNativeId: "native-agent", displayName: "Canary agent", snapshotId: "11111111-1111-4111-8111-111111111111",
  inventoryObservedAt: timestamps[0], inventoryExpiresAt: "2026-09-10T19:00:00Z",
  environmentId: "22222222-2222-4222-8222-222222222222", botId: "33333333-3333-4333-8333-333333333333",
  inventoryQuarantineState: false, inventoryQuarantinedAt: null,
};
const approvalInput = {
  snapshotId: target.snapshotId, resourceNativeId: target.resourceNativeId, action: "quarantine" as const,
  prestate: false, prestateProviderUpdatedAt: timestamps[0], poststate: true,
};

beforeEach(() => {
  vi.spyOn(pool, "query").mockRejectedValue(new Error("Unexpected database access"));
  vi.spyOn(pool, "connect").mockRejectedValue(new Error("Unexpected database access"));
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Unexpected provider access")));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function fixture() {
  const user: AuthenticatedUser = { tenantId: randomUUID(), homeAccountId: randomUUID(), displayName: "Admin",
    username: "admin@example.invalid", roles: ["AgentControl.Admin"] };
  const scope = { tenantId: user.tenantId!, principalId: user.homeAccountId };
  const original: QuarantineCanaryApproval = {
    ...target, id: randomUUID(), tenantId: scope.tenantId, approvedByPrincipalId: randomUUID(), action: "quarantine",
    prestate: false, prestateProviderUpdatedAt: timestamps[0], poststate: true, authority, authMode: "delegated",
    status: "claimed", pairedApprovalId: null, actorPrincipalId: user.homeAccountId, jobId: null,
    approvedAt: timestamps[0], attemptedAt: timestamps[0], finishedAt: null,
    approvalExpiresAt: target.inventoryExpiresAt, evidenceExpiresAt: target.inventoryExpiresAt, errorCode: null,
  };
  const restoration: QuarantineCanaryApproval = {
    ...original, id: randomUUID(), action: "unquarantine", prestate: true, prestateProviderUpdatedAt: null, poststate: false,
    pairedApprovalId: original.id,
  };
  original.pairedApprovalId = restoration.id;
  function job(approval: QuarantineCanaryApproval, index: number): QuarantineJob {
    const input = { action: approval.action, targets: [{ ...target, directStatus: {
      environmentId: target.environmentId, botId: target.botId, isBotQuarantined: approval.prestate,
      lastUpdateTimeUtc: timestamps[index], observedAt: timestamps[index], correlationId: randomUUID(),
    } }], actor: { ...user, tenantId: scope.tenantId }, authority, requestPath: "/canary", canaryApprovalId: approval.id };
    const confirmation = createQuarantineConfirmation(input);
    return {
      id: randomUUID(), action: approval.action, status: "succeeded", confirmationHash: confirmation.confirmationHash,
      confirmation: confirmation.summary, isCanary: true, total: 1, completed: 1, succeeded: 1, failed: 0, skipped: 0,
      inconclusive: 0, cancelled: 0, canResume: false, canReconcile: false, createdAt: timestamps[index], updatedAt: timestamps[index + 1],
      results: [{ resourceNativeId: target.resourceNativeId, displayName: target.displayName, environmentId: target.environmentId,
        botId: target.botId, status: "succeeded", requestedState: approval.poststate, observedState: approval.poststate,
        observedProviderUpdatedAt: timestamps[index + 1], observedAt: timestamps[index + 1], correlationId: randomUUID(),
        reconciliationStatus: "not_required", retryEligible: false }],
    };
  }
  const originalJob = job(original, 0);
  const restorationJob = job(restoration, 1);
  const canaries = new CopilotStudioQuarantineCanaryRepository();
  const jobs = new CopilotStudioQuarantineRepository();
  const inventory = new PowerPlatformInventoryRepository();
  const provider = new CopilotStudioQuarantineClient();
  const dependencies = {
    revalidateUser: vi.fn(async () => user),
    delegatedToken: vi.fn(async () => "fixture"),
    requireAvailable: vi.fn<typeof capabilities.requireAvailable>(async capabilityId => ({
      capabilityId, status: "available", authorized: true, fresh: true, previewQualification: "not_required", remediation: [],
    })),
    authorityContext: vi.fn(async () => authority),
    approvalAuthorityContext: vi.fn(async () => authority),
  };
  const createApproved = vi.spyOn(canaries, "createApproved").mockResolvedValue(original);
  const claimCycle = vi.spyOn(canaries, "claimCycle").mockResolvedValue({ original, restoration });
  const completeCycle = vi.spyOn(canaries, "completeCycle").mockResolvedValue({ original, restoration });
  const authorizeJob = vi.spyOn(canaries, "authorizeJob").mockResolvedValue(original);
  const resolveTargets = vi.spyOn(inventory, "resolveQuarantineTargets").mockResolvedValue([target]);
  const submit = vi.spyOn(jobs, "submit").mockImplementation(async (_scope, input) =>
    ({ ...(input.canaryApprovalId === original.id ? originalJob : restorationJob), status: "queued", results: [] }));
  const get = vi.spyOn(jobs, "get").mockImplementation(async (_scope, id) => id === originalJob.id ? originalJob : restorationJob);
  const run = vi.mocked(runTrackedCopilotStudioQuarantineJob).mockReset().mockImplementation(async (_id, currentScope, _jobs, _provider, authorize) => {
    if (!authorize) throw new Error("Expected approval-bound authorizer");
    await authorize(currentScope);
  });
  const service = new CopilotStudioQuarantineCanaryService(canaries, jobs, inventory, provider, dependencies);
  return { user, scope, original, restoration, originalJob, restorationJob, dependencies, createApproved, claimCycle,
    completeCycle, authorizeJob, resolveTargets, submit, get, run, service,
    execute: () => service.execute(user, original.id, restoration.id),
    replaceSession: async () => {
      await revokeAccountSessionMutations(scope.tenantId, scope.principalId, async () => undefined);
      await activateAccountSession(scope.tenantId, scope.principalId, async () => undefined);
    },
  };
}

describe("quarantine canary authorization and evidence boundaries", () => {
  it("approves with a freshly revalidated Admin without requesting provider permission or a delegated token", async () => {
    const f = fixture();
    const current = { ...f.user, displayName: "Current Admin" };
    f.dependencies.revalidateUser.mockResolvedValue(current);
    await f.service.createApproval(f.user, approvalInput);
    expect(f.dependencies.revalidateUser).toHaveBeenCalledExactlyOnceWith(f.user.homeAccountId);
    expect(f.createApproved).toHaveBeenCalledWith(current, expect.objectContaining({ target, authority }));
    expect(f.dependencies.delegatedToken).not.toHaveBeenCalled();
    expect(f.dependencies.requireAvailable).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["tenant", "principal", "role"] as const)("rejects approval after the current Admin's %s changes", async change => {
    const f = fixture();
    f.dependencies.revalidateUser.mockResolvedValue({
      ...f.user, ...(change === "tenant" ? { tenantId: randomUUID() } : change === "principal" ? { homeAccountId: randomUUID() } : { roles: [] }),
    });
    await expect(f.service.createApproval(f.user, approvalInput)).rejects.toMatchObject({ status: 401 });
    expect(f.createApproved).not.toHaveBeenCalled();
  });

  it.each(["inventory", "authority"] as const)("does not approve after session replacement during the %s read", async boundary => {
    const f = fixture();
    if (boundary === "inventory") f.resolveTargets.mockImplementation(async () => { await f.replaceSession(); return [target]; });
    else f.dependencies.approvalAuthorityContext.mockImplementation(async () => { await f.replaceSession(); return authority; });
    await expect(f.service.createApproval(f.user, approvalInput)).rejects.toMatchObject({ code: "unauthorized" });
    expect(f.createApproved).not.toHaveBeenCalled();
  });

  it("uses the original readback's exact timestamp for restoration before publishing qualification", async () => {
    const f = fixture();
    await expect(f.execute()).resolves.toMatchObject({ qualification: { qualified: true } });
    expect(f.submit).toHaveBeenCalledTimes(2);
    expect(f.submit.mock.calls[1][1].targets[0].directStatus).toMatchObject({
      isBotQuarantined: true, lastUpdateTimeUtc: timestamps[1],
    });
    expect(f.authorizeJob).toHaveBeenCalledTimes(2);
    expect(f.completeCycle).toHaveBeenCalledWith(f.user, f.original.id, f.restoration.id, { status: "qualified" }, authority);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("revalidates the executor before admitting a durable job", async () => {
    const f = fixture();
    f.claimCycle.mockImplementation(async () => {
      f.dependencies.revalidateUser.mockResolvedValue({ ...f.user, roles: [] });
      return { original: f.original, restoration: f.restoration };
    });
    await expect(f.execute()).rejects.toMatchObject({ status: 401 });
    expect(f.submit).not.toHaveBeenCalled();
    expect(f.run).not.toHaveBeenCalled();
  });

  it.each(["original", "restoration"] as const)("does not continue an old cycle after session replacement during %s result loading", async stage => {
    const f = fixture();
    f.get.mockImplementation(async (_scope, id) => {
      const result = id === f.originalJob.id ? f.originalJob : f.restorationJob;
      if (result === (stage === "original" ? f.originalJob : f.restorationJob)) await f.replaceSession();
      return result;
    });
    await expect(f.execute()).rejects.toMatchObject({ code: "unauthorized" });
    expect(f.submit).toHaveBeenCalledTimes(stage === "original" ? 1 : 2);
    expect(f.completeCycle.mock.calls.every(call => call[3].status !== "qualified")).toBe(true);
  });

  it.each(["original", "restoration", "publication"] as const)("fences session replacement during %s authorization", async stage => {
    const f = fixture();
    let replace = false;
    f.claimCycle.mockImplementation(async () => {
      replace = stage === "original";
      return { original: f.original, restoration: f.restoration };
    });
    f.get.mockImplementation(async (_scope, id) => {
      replace = stage === "restoration" && id === f.originalJob.id || stage === "publication" && id === f.restorationJob.id;
      return id === f.originalJob.id ? f.originalJob : f.restorationJob;
    });
    f.dependencies.authorityContext.mockImplementation(async () => {
      if (replace) await f.replaceSession();
      return authority;
    });
    await expect(f.execute()).rejects.toMatchObject({ code: "unauthorized" });
    expect(f.submit).toHaveBeenCalledTimes(stage === "original" ? 0 : stage === "restoration" ? 1 : 2);
    expect(f.completeCycle.mock.calls.every(call => call[3].status !== "qualified")).toBe(true);
  });

  it("rejects session replacement while checking a job's exact approval", async () => {
    const f = fixture();
    f.authorizeJob.mockImplementation(async () => { await f.replaceSession(); return f.original; });
    await expect(f.execute()).rejects.toMatchObject({ code: "unauthorized" });
    expect(f.submit).toHaveBeenCalledOnce();
    expect(f.completeCycle).toHaveBeenCalledWith(f.user, f.original.id, f.restoration.id,
      { status: "inconclusive", errorCode: "unauthorized" });
  });

  it.each(["original", "restoration"] as const)("stops when %s state flips without new provider timestamp evidence", async stage => {
    const f = fixture();
    const job = stage === "original" ? f.originalJob : f.restorationJob;
    job.results[0].observedProviderUpdatedAt = stage === "original" ? timestamps[0] : timestamps[1];
    await expect(f.execute()).rejects.toMatchObject({ code: `canary_${stage}_unverified` });
    expect(f.submit).toHaveBeenCalledTimes(stage === "original" ? 1 : 2);
    expect(f.completeCycle).toHaveBeenCalledWith(f.user, f.original.id, f.restoration.id,
      { status: "inconclusive", errorCode: `canary_${stage}_unverified` });
  });

  it.each(["state", "target", "action"] as const)("rejects succeeded original receipts with mismatched %s evidence before restoration", async mismatch => {
    const f = fixture();
    if (mismatch === "state") f.originalJob.results[0].observedState = false;
    else if (mismatch === "target") f.originalJob.results[0].botId = randomUUID();
    else f.originalJob.action = "unquarantine";
    await expect(f.execute()).rejects.toMatchObject({ code: "canary_original_unverified" });
    expect(f.submit).toHaveBeenCalledOnce();
    expect(f.completeCycle).toHaveBeenCalledWith(f.user, f.original.id, f.restoration.id,
      { status: "inconclusive", errorCode: "canary_original_unverified" });
  });

  it("keeps a verified unsent failure distinct from an uncertain execution", async () => {
    const f = fixture();
    f.originalJob.status = "failed";
    f.originalJob.results[0].status = "failed";
    f.originalJob.results[0].observedState = null;
    await expect(f.execute()).rejects.toMatchObject({ code: "canary_original_unverified" });
    expect(f.completeCycle).toHaveBeenCalledWith(f.user, f.original.id, f.restoration.id,
      { status: "failed", errorCode: "canary_original_unverified" });
    expect(f.submit).toHaveBeenCalledOnce();
  });

  it("retains the execution error if persisting the terminal cycle also fails", async () => {
    const f = fixture();
    const error = new AppError(409, "provider_error", "Fixture execution failure");
    f.run.mockRejectedValue(error);
    f.completeCycle.mockRejectedValue(new Error("Fixture persistence failure"));
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(f.execute()).rejects.toBe(error);
    expect(log).toHaveBeenCalledOnce();
    expect(String(log.mock.calls[0][0])).not.toContain("Fixture persistence failure");
  });
});
