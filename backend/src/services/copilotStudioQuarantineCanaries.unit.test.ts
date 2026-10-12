import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CopilotStudioQuarantineCanaryRepository, type QuarantineCanaryApproval } from "../db/copilotStudioQuarantineCanaries.js";
import { CopilotStudioQuarantineRepository, createQuarantineConfirmation } from "../db/copilotStudioQuarantine.js";
import { NativeInventory } from "../db/nativeInventory.js";
import { pool } from "../db/pool.js";
import { activateAccountSession, revokeAccountSessionMutations } from "../db/sessions.js";
import { AppError } from "../errors.js";
import type { InventoryQuarantineTarget, QuarantineJob } from "../types/copilotStudioQuarantine.js";
import type { AuthenticatedUser } from "../types/session.js";
import { CopilotStudioQuarantineClient } from "./copilotStudioQuarantine.js";
import { CopilotStudioQuarantineCanaryService } from "./copilotStudioQuarantineCanaries.js";
import { runTrackedCopilotStudioQuarantineJob } from "./copilotStudioQuarantineJobs.js";
import { capabilities } from "./capabilities.js";
import { requireProviderAdmissions } from "./operationalState.js";

vi.mock("./copilotStudioQuarantineJobs.js", () => ({ runTrackedCopilotStudioQuarantineJob: vi.fn() }));
vi.mock("./operationalState.js", () => ({ requireProviderAdmissions: vi.fn() }));

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
  vi.mocked(requireProviderAdmissions).mockReset();
  vi.spyOn(pool, "query").mockRejectedValue(new Error("Unexpected database access"));
  vi.spyOn(pool, "connect").mockRejectedValue(new Error("Unexpected database access"));
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Unexpected provider access")));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function fixture(sourceTarget = target) {
  const user: AuthenticatedUser = { tenantId: randomUUID(), homeAccountId: randomUUID(), displayName: "Admin",
    username: "admin@example.invalid", roles: ["AgentControl.Admin"] };
  const scope = { tenantId: user.tenantId!, principalId: user.homeAccountId };
  const original: QuarantineCanaryApproval = {
    ...sourceTarget, id: randomUUID(), tenantId: scope.tenantId, approvedByPrincipalId: randomUUID(), action: "quarantine",
    prestate: false, prestateProviderUpdatedAt: timestamps[0], poststate: true, authority, authMode: "delegated",
    status: "claimed", pairedApprovalId: null, actorPrincipalId: user.homeAccountId, jobId: null,
    approvedAt: timestamps[0], attemptedAt: timestamps[0], finishedAt: null,
    approvalExpiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
    evidenceExpiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString(), errorCode: null,
  };
  const restoration: QuarantineCanaryApproval = {
    ...original, id: randomUUID(), action: "unquarantine", prestate: true, prestateProviderUpdatedAt: null, poststate: false,
    pairedApprovalId: original.id,
  };
  original.pairedApprovalId = restoration.id;
  function job(approval: QuarantineCanaryApproval, index: number): QuarantineJob {
    const input = { action: approval.action, targets: [{ ...sourceTarget, directStatus: {
      environmentId: sourceTarget.environmentId, botId: sourceTarget.botId, isBotQuarantined: approval.prestate,
      lastUpdateTimeUtc: timestamps[index], observedAt: timestamps[index], correlationId: randomUUID(),
    } }], actor: { ...user, tenantId: scope.tenantId }, authority, requestPath: "/canary", canaryApprovalId: approval.id };
    const confirmation = createQuarantineConfirmation(input);
    return {
      id: randomUUID(), action: approval.action, status: "succeeded", confirmationHash: confirmation.confirmationHash,
      confirmation: confirmation.summary, isCanary: true, total: 1, completed: 1, succeeded: 1, failed: 0, skipped: 0,
      inconclusive: 0, cancelled: 0, canResume: false, canReconcile: false, createdAt: timestamps[index], updatedAt: timestamps[index + 1],
      results: [{ resourceNativeId: sourceTarget.resourceNativeId, displayName: sourceTarget.displayName, environmentId: sourceTarget.environmentId,
        botId: sourceTarget.botId, status: "succeeded", requestedState: approval.poststate, observedState: approval.poststate,
        observedProviderUpdatedAt: timestamps[index + 1], observedAt: timestamps[index + 1], correlationId: randomUUID(),
        reconciliationStatus: "not_required", retryEligible: false }],
    };
  }
  const originalJob = job(original, 0);
  const restorationJob = job(restoration, 1);
  const canaries = new CopilotStudioQuarantineCanaryRepository();
  const jobs = new CopilotStudioQuarantineRepository();
  const inventory = new NativeInventory();
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
  const createApproved = vi.spyOn(canaries, "createApproved").mockResolvedValue({
    ...original, status: "approved", pairedApprovalId: null, actorPrincipalId: null, attemptedAt: null,
  });
  const claimCycle = vi.spyOn(canaries, "claimCycle").mockResolvedValue({ original, restoration });
  const completeCycle = vi.spyOn(canaries, "completeCycle").mockImplementation(async (_user, _original, _restoration, completion) => ({
    original: { ...original, status: completion.status, finishedAt: new Date().toISOString(), errorCode: completion.errorCode ?? null },
    restoration: { ...restoration, status: completion.status, finishedAt: new Date().toISOString(), errorCode: completion.errorCode ?? null },
  }));
  const authorizeJob = vi.spyOn(canaries, "authorizeJob").mockImplementation(async (_user, id) => id === original.id ? original : restoration);
  const resolveTargets = vi.spyOn(inventory, "resolveQuarantineTargets").mockResolvedValue([sourceTarget]);
  const submit = vi.spyOn(jobs, "submit").mockImplementation(async (_scope, input) => {
    const approval = input.canaryApprovalId === original.id ? original : restoration;
    const result = approval === original ? originalJob : restorationJob;
    approval.jobId = result.id;
    const confirmation = createQuarantineConfirmation(input);
    result.confirmation = confirmation.summary;
    result.confirmationHash = confirmation.confirmationHash;
    return { ...result, status: "queued", completed: 0, succeeded: 0, results: result.results.map(item => ({
      ...item, status: "queued", observedState: null, observedProviderUpdatedAt: null, observedAt: null, correlationId: null,
    })) };
  });
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
    expect(f.dependencies.revalidateUser).toHaveBeenCalledExactlyOnceWith(f.user.tenantId, f.user.homeAccountId);
    expect(f.createApproved).toHaveBeenCalledWith(current, expect.objectContaining({ target, authority }), expect.any(Function));
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

  it("does not revalidate a superseded approval session or read its authority", async () => {
    const f = fixture();
    f.resolveTargets.mockImplementation(async () => { await f.replaceSession(); return [target]; });
    await expect(f.service.createApproval(f.user, approvalInput)).rejects.toMatchObject({ code: "unauthorized" });
    expect(f.dependencies.revalidateUser).not.toHaveBeenCalled();
    expect(f.dependencies.approvalAuthorityContext).not.toHaveBeenCalled();
  });

  it.each(["revalidation", "capability", "authority"] as const)("does not acquire a canary token after session replacement during %s", async boundary => {
    const f = fixture();
    if (boundary === "revalidation") f.dependencies.revalidateUser.mockImplementation(async () => { await f.replaceSession(); return f.user; });
    else if (boundary === "capability") f.dependencies.requireAvailable.mockImplementation(async capabilityId => {
      await f.replaceSession();
      return { capabilityId, status: "available", authorized: true, fresh: true, previewQualification: "not_required", remediation: [] };
    });
    else f.dependencies.authorityContext.mockImplementation(async () => { await f.replaceSession(); return authority; });
    await expect(f.execute()).rejects.toMatchObject({ code: "unauthorized" });
    expect(f.dependencies.delegatedToken).not.toHaveBeenCalled();
    expect(f.claimCycle).not.toHaveBeenCalled();
    if (boundary === "revalidation") expect(f.dependencies.requireAvailable).not.toHaveBeenCalled();
    if (boundary !== "authority") expect(f.dependencies.authorityContext).not.toHaveBeenCalled();
  });

  it.each(["cancelled", "invalidated"] as const)(
    "does not acquire another token when a worker's canary authorization is %s", async boundary => {
      const f = fixture();
      const controller = new AbortController();
      const failure = new AppError(boundary === "cancelled" ? 503 : 401,
        boundary === "cancelled" ? "shutdown" : "authorization_expired", "Authority stopped.");
      let invalidated = false, tokenCount = 0;
      vi.spyOn(capabilities, "beginOperationValidation").mockReturnValue(() => {
        if (invalidated) throw failure;
      });
      f.run.mockImplementationOnce(async (_id, currentScope, _jobs, _provider, authorize) => {
        if (!authorize) throw new Error("Expected approval-bound authorizer.");
        tokenCount = f.dependencies.delegatedToken.mock.calls.length;
        f.dependencies.requireAvailable.mockImplementationOnce(async capabilityId => {
          if (boundary === "cancelled") controller.abort(failure);
          else invalidated = true;
          return { capabilityId, status: "available", authorized: true, fresh: true, previewQualification: "not_required", remediation: [] };
        });
        await authorize(currentScope, controller.signal);
      });
      await expect(f.execute()).rejects.toBe(failure);
      expect(f.dependencies.delegatedToken).toHaveBeenCalledTimes(tokenCount);
      expect(f.authorizeJob).not.toHaveBeenCalled();
      expect(f.submit).toHaveBeenCalledOnce();
      expect(f.completeCycle.mock.calls.every(call => call[3].status !== "qualified")).toBe(true);
    },
  );

  it("uses the original readback's exact timestamp for restoration before publishing qualification", async () => {
    const f = fixture();
    await expect(f.execute()).resolves.toMatchObject({
      original: { status: "qualified" }, restoration: { status: "qualified" }, qualification: { qualified: true },
    });
    expect(f.submit).toHaveBeenCalledTimes(2);
    expect(f.submit.mock.calls[1][1].targets[0].directStatus).toMatchObject({
      isBotQuarantined: true, lastUpdateTimeUtc: timestamps[1],
    });
    expect(f.authorizeJob).toHaveBeenCalledTimes(2);
    expect(f.authorizeJob).toHaveBeenNthCalledWith(1, f.user, f.original.id, f.originalJob.id, authority);
    expect(f.authorizeJob).toHaveBeenNthCalledWith(2, f.user, f.restoration.id, f.restorationJob.id, authority);
    expect(f.completeCycle).toHaveBeenCalledWith(f.user, f.original.id, f.restoration.id, { status: "qualified" }, authority, expect.any(Function));
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["claim", "submission", "qualification"] as const)("fences provider admission closing before canary %s commit", async boundary => {
    const f = fixture();
    const failure = new AppError(503, "maintenance", "Provider admission closed.");
    const closeAdmission = () => vi.mocked(requireProviderAdmissions).mockImplementation(() => { throw failure; });
    let published = false;
    if (boundary === "claim") f.claimCycle.mockImplementationOnce(async (_user, _original, _restoration, _authority, beforeCommit) => {
      closeAdmission();
      beforeCommit?.();
      published = true;
      return { original: f.original, restoration: f.restoration };
    });
    if (boundary === "submission") f.submit.mockImplementationOnce(async (_scope, _input, beforeCommit) => {
      closeAdmission();
      beforeCommit?.();
      published = true;
      return f.originalJob;
    });
    if (boundary === "qualification") f.completeCycle.mockImplementation(async (_user, _original, _restoration, completion, _authority, beforeCommit) => {
      if (completion.status === "qualified") {
        closeAdmission();
        beforeCommit?.();
        published = true;
      }
      return { original: f.original, restoration: f.restoration };
    });
    await expect(f.execute()).rejects.toBe(failure);
    expect(published).toBe(false);
    expect(f.run).toHaveBeenCalledTimes(boundary === "qualification" ? 2 : 0);
  });

  it("verifies both durable directions when approval and job GUID casing differs", async () => {
    const environmentId = "Default-ABCDEFAB-2222-4222-8222-222222222222", botId = "CDEFABCD-3333-4333-8333-333333333333";
    const f = fixture({ ...target, environmentId, botId });
    Object.assign(f.restoration, { environmentId: environmentId.toLowerCase(), botId: botId.toLowerCase() });
    Object.assign(f.originalJob.results[0], { environmentId: environmentId.toLowerCase(), botId: botId.toLowerCase() });
    Object.assign(f.restorationJob.results[0], { environmentId: environmentId.toUpperCase(), botId: botId.toUpperCase() });
    await expect(f.execute()).resolves.toMatchObject({ qualification: { qualified: true } });
    expect(f.submit).toHaveBeenCalledTimes(2);
    expect(f.completeCycle).toHaveBeenCalledWith(f.user, f.original.id, f.restoration.id,
      { status: "qualified" }, authority, expect.any(Function));
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

  it.each(["state", "target", "environment", "action"] as const)("rejects succeeded original receipts with mismatched %s evidence before restoration", async mismatch => {
    const f = fixture();
    if (mismatch === "state") f.originalJob.results[0].observedState = false;
    else if (mismatch === "target") f.originalJob.results[0].botId = randomUUID();
    else if (mismatch === "environment") f.originalJob.results[0].environmentId = randomUUID();
    else f.originalJob.action = "unquarantine";
    await expect(f.execute()).rejects.toMatchObject({ code: "canary_original_unverified" });
    expect(f.submit).toHaveBeenCalledOnce();
    expect(f.completeCycle).toHaveBeenCalledWith(f.user, f.original.id, f.restoration.id,
      { status: "inconclusive", errorCode: "canary_original_unverified" });
  });

  it("keeps a verified unsent failure distinct from an uncertain execution", async () => {
    const f = fixture();
    f.originalJob.status = "failed";
    f.originalJob.succeeded = 0;
    f.originalJob.failed = 1;
    f.originalJob.results[0].status = "failed";
    f.originalJob.results[0].observedState = null;
    f.originalJob.results[0].observedProviderUpdatedAt = null;
    f.originalJob.results[0].observedAt = null;
    await expect(f.execute()).rejects.toMatchObject({ code: "canary_original_unverified" });
    expect(f.completeCycle).toHaveBeenCalledWith(f.user, f.original.id, f.restoration.id,
      { status: "failed", errorCode: "canary_original_unverified" });
    expect(f.submit).toHaveBeenCalledOnce();
  });

  it("keeps a durable restoration prestate conflict distinct from an uncertain execution", async () => {
    const f = fixture();
    f.restorationJob.status = "failed";
    f.restorationJob.succeeded = 0;
    f.restorationJob.failed = 1;
    Object.assign(f.restorationJob.results[0], {
      status: "failed", observedState: null, observedProviderUpdatedAt: null, observedAt: null,
      errorCode: "quarantine_prestate_conflict",
    });

    await expect(f.execute()).rejects.toMatchObject({ code: "canary_restoration_unverified" });

    expect(f.submit).toHaveBeenCalledTimes(2);
    expect(f.completeCycle).toHaveBeenCalledExactlyOnceWith(f.user, f.original.id, f.restoration.id,
      { status: "conflict", errorCode: "canary_restoration_unverified" });
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
