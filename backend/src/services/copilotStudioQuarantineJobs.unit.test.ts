import pg from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as msal from "../auth/msal.js";
import { CopilotStudioQuarantineRepository, createQuarantineConfirmation, type QuarantineJobRow } from "../db/copilotStudioQuarantine.js";
import { activateAccountSession, revokeAccountSessionMutations } from "../db/sessions.js";
import { AppError } from "../errors.js";
import type { CopilotStudioQuarantineStatus, QuarantineJob } from "../types/copilotStudioQuarantine.js";
import type { AuthenticatedUser } from "../types/session.js";
import type { CopilotStudioQuarantineClient } from "./copilotStudioQuarantine.js";

const settleControls = vi.hoisted(() => vi.fn(async (_scope: unknown, signal: AbortSignal) => { signal.throwIfAborted(); }));
const inventoryAuthority = vi.hoisted(() => vi.fn<(assertCurrent?: () => void) => void>());

vi.mock("../db/pool.js", () => ({
  pool: {},
  secretValue: vi.fn(),
  transaction: vi.fn(async () => { throw new Error("Unit tests must not access a database."); }),
}));
vi.mock("./maintenance.js", () => ({ maintenanceActive: vi.fn(() => false) }));
vi.mock("./operationalState.js", () => ({ requireProviderAdmissions: vi.fn() }));
vi.mock("./inventoryRuntime.js", async importOriginal => ({
  ...await importOriginal<typeof import("./inventoryRuntime.js")>(),
  InventoryRuntime: class {
    constructor(_database: unknown, _authorize: unknown, assertCurrent?: () => void) { inventoryAuthority(assertCurrent); }
    settleControls = settleControls;
  },
}));

import { capabilities } from "./capabilities.js";
import {
  cancelCopilotStudioQuarantineJob, copilotStudioQuarantineJobs, drainCopilotStudioQuarantineJobs,
  launchCopilotStudioQuarantineJob, reconcileCopilotStudioQuarantineJob, runCopilotStudioQuarantineJob, runTrackedCopilotStudioQuarantineJob,
} from "./copilotStudioQuarantineJobs.js";
import { requireProviderAdmissions } from "./operationalState.js";

const scope = { tenantId: "tenant", principalId: "principal" };
const jobId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const target = { environmentId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", botId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" };
const authority = { contractRevision: "a".repeat(64), permissionRevision: "b".repeat(64), configurationRevision: 1 };
const authorization = { accessToken: "fixture-token", authority };
const updatedAt = "2026-09-24T12:00:00.1234567Z";
const now = new Date("2026-09-24T12:01:00Z");
const confirmation = createQuarantineConfirmation({
  action: "quarantine", actor: { tenantId: scope.tenantId, homeAccountId: scope.principalId, displayName: "Operator", username: "operator@example.invalid" },
  authority, requestPath: "/api/quarantine/jobs",
  targets: [{ ...target, resourceNativeId: "native-agent", displayName: "Agent", snapshotId: jobId,
    inventoryObservedAt: now.toISOString(), inventoryExpiresAt: "2026-09-25T12:00:00Z",
    inventoryQuarantineState: false, inventoryQuarantinedAt: null, directStatus: status(false) }],
});
const job: QuarantineJobRow = {
  id: jobId, tenant_id: scope.tenantId, principal_id: scope.principalId, action: "quarantine", status: "running",
  request_hash: confirmation.requestHash, confirmation_hash: confirmation.confirmationHash, confirmation_summary: confirmation.summary,
  actor_name: "Operator", actor_username: "operator@example.invalid", request_path: "/api/quarantine/jobs",
  contract_revision: authority.contractRevision, permission_revision: authority.permissionRevision, configuration_revision: "1",
  is_canary: false, canary_approval_id: null, cancel_requested: false, lease_owner: "worker", lease_version: "1",
  lease_until: now, attempts: 1, created_at: now, updated_at: now, deadline_at: now, expires_at: now,
};
const item: NonNullable<Awaited<ReturnType<CopilotStudioQuarantineRepository["beginItem"]>>>["item"] = {
  id: "item", job_id: jobId, ordinal: 0, resource_native_id: "native-agent", display_name: "Agent", snapshot_id: jobId,
  inventory_observed_at: now, environment_id: target.environmentId, bot_id: target.botId, prestate: false,
  prestate_provider_updated_at: updatedAt, requested_state: true, status: "running", sent_at: null, correlation_id: jobId,
  observed_state: null, observed_provider_updated_at: null, observed_at: null, readback_count: 0,
  reconciliation_status: "not_required", reconciled_at: null, error_code: null, message: null,
};
const summary: QuarantineJob = {
  id: jobId, action: "quarantine", status: "running", confirmationHash: confirmation.confirmationHash, confirmation: confirmation.summary,
  isCanary: false, total: 1, completed: 0, succeeded: 0, failed: 0, skipped: 0, inconclusive: 0, cancelled: 0,
  canResume: false, canReconcile: false, createdAt: now.toISOString(), updatedAt: now.toISOString(), results: [],
};

function status(state: boolean, timestamp = updatedAt): CopilotStudioQuarantineStatus {
  return { ...target, isBotQuarantined: state, lastUpdateTimeUtc: timestamp, observedAt: now.toISOString(), correlationId: jobId };
}

function fixture(repository = new CopilotStudioQuarantineRepository()) {
  vi.spyOn(repository, "get").mockResolvedValue(summary);
  vi.spyOn(repository, "claim").mockResolvedValue({ jobId, scope, owner: "worker", version: 1 });
  vi.spyOn(repository, "waitForAuthorization").mockResolvedValue(undefined);
  vi.spyOn(repository, "beginItem").mockResolvedValue(undefined).mockResolvedValueOnce({ job, item });
  vi.spyOn(repository, "withTargetLock").mockImplementation(async (_lease, _item, operation) => operation(new AbortController().signal));
  vi.spyOn(repository, "assertDispatchReady").mockResolvedValue(undefined);
  vi.spyOn(repository, "markSent").mockResolvedValue(undefined);
  vi.spyOn(repository, "finishItem").mockResolvedValue(undefined);
  vi.spyOn(repository, "pauseItemForAuthorization").mockResolvedValue(undefined);
  vi.spyOn(repository, "release").mockResolvedValue(undefined);
  vi.spyOn(repository, "cancel").mockResolvedValue(summary);
  vi.spyOn(repository, "reconciliationItems").mockResolvedValue({ job, items: [{ ...item, status: "inconclusive", reconciliation_status: "required" }] });
  vi.spyOn(repository, "withReconciliationLock").mockImplementation(async (_scope, _item, operation) => operation(new AbortController().signal));
  vi.spyOn(repository, "assertReconciliationTarget").mockResolvedValue(undefined);
  vi.spyOn(repository, "recordReconciliation").mockResolvedValue(undefined);
  let state = false;
  const provider = {
    getStatus: vi.fn(async (..._args: Parameters<CopilotStudioQuarantineClient["getStatus"]>) => status(state)),
    setQuarantine: vi.fn(async (..._args: Parameters<CopilotStudioQuarantineClient["setQuarantine"]>) => { state = true; return status(state); }),
  };
  const authorize = vi.fn(async () => authorization);
  return { repository, provider, authorize };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise; });
  return { promise, resolve, reject };
}

async function replaceSession() {
  await revokeAccountSessionMutations(scope.tenantId, scope.principalId, async () => undefined);
  await activateAccountSession(scope.tenantId, scope.principalId, async () => undefined);
}

beforeEach(async () => {
  settleControls.mockReset().mockImplementation(async (_scope, signal) => { signal.throwIfAborted(); });
  inventoryAuthority.mockClear();
  await activateAccountSession(scope.tenantId, scope.principalId, async () => undefined);
  vi.mocked(requireProviderAdmissions).mockImplementation(() => undefined);
  vi.spyOn(capabilities, "observeOperation").mockImplementation(async (_id, _user, operation) => operation(() => undefined));
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

describe("quarantine execution session and cancellation boundaries", () => {
  it.each((["execution", "reconciliation"] as const).flatMap(operation =>
    (["session", "capability", "provider-admission"] as const).map(cause => ({ operation, cause }))))(
    "fences inventory settlement commits during $operation after $cause invalidation", async ({ operation, cause }) => {
      const { repository, provider, authorize } = fixture();
      const failure = new AppError(401, "authorization_expired", "Synthetic inventory authority changed.");
      let invalidated = false, published = false;
      vi.spyOn(capabilities, "beginOperationValidation").mockReturnValue(() => {
        if (cause === "capability" && invalidated) throw failure;
      });
      vi.mocked(requireProviderAdmissions).mockImplementation(() => {
        if (cause === "provider-admission" && invalidated) throw failure;
      });
      settleControls.mockImplementationOnce(async () => {
        if (cause === "session") await replaceSession();
        invalidated = true;
        inventoryAuthority.mock.lastCall?.[0]?.();
        published = true;
      });

      const pending = operation === "execution"
        ? runCopilotStudioQuarantineJob(jobId, scope, false, repository, provider, authorize)
        : reconcileCopilotStudioQuarantineJob(jobId, scope, repository, provider, authorize);
      if (cause === "session") await expect(pending).rejects.toMatchObject({ code: "unauthorized" });
      else await expect(pending).rejects.toBe(failure);
      expect(published).toBe(false);
      expect(provider.getStatus).not.toHaveBeenCalled();
      expect(provider.setQuarantine).not.toHaveBeenCalled();
      expect(repository.beginItem).not.toHaveBeenCalled();
      if (operation === "execution") expect(repository.release).toHaveBeenCalledOnce();
    },
  );

  it.each(["authorization", "readback", "commit"] as const)(
    "does not dispatch or publish verified work after capability invalidation during %s", async stage => {
      const { repository, provider, authorize } = fixture();
      const failure = new AppError(401, "authorization_expired", "Authority changed.");
      let invalidated = false, published = false;
      vi.spyOn(capabilities, "beginOperationValidation").mockReturnValue(() => {
        if (invalidated) throw failure;
      });
      if (stage === "authorization") authorize.mockImplementationOnce(async () => { invalidated = true; return authorization; });
      if (stage === "readback") provider.getStatus.mockImplementationOnce(async () => { invalidated = true; return status(false); });
      if (stage === "commit") vi.mocked(repository.finishItem).mockImplementationOnce(async (_lease, _item, _outcome, _evidence, _signal, beforeCommit) => {
        invalidated = true;
        beforeCommit?.();
        published = true;
      });
      const pending = runCopilotStudioQuarantineJob(jobId, scope, false, repository, provider, authorize);
      if (stage === "authorization") await expect(pending).rejects.toBe(failure);
      else await pending;
      expect(published).toBe(false);
      expect(provider.setQuarantine).toHaveBeenCalledTimes(stage === "commit" ? 1 : 0);
      if (stage === "readback") expect(repository.pauseItemForAuthorization).toHaveBeenCalledOnce();
      if (stage === "commit") expect(repository.finishItem).toHaveBeenLastCalledWith(expect.anything(), item, "inconclusive",
        expect.objectContaining({ errorCode: "authorization_expired" }));
    },
  );

  it("does not publish GET-only reconciliation after capability invalidation without a session change", async () => {
    const { repository, provider, authorize } = fixture();
    const failure = new AppError(401, "authorization_expired", "Authority changed.");
    let invalidated = false;
    vi.spyOn(capabilities, "beginOperationValidation").mockReturnValue(() => {
      if (invalidated) throw failure;
    });
    provider.getStatus.mockImplementationOnce(async () => { invalidated = true; return status(true); });
    await expect(reconcileCopilotStudioQuarantineJob(jobId, scope, repository, provider, authorize)).rejects.toBe(failure);
    expect(repository.recordReconciliation).not.toHaveBeenCalled();
    expect(provider.setQuarantine).not.toHaveBeenCalled();
  });

  it.each(["revalidation", "capability", "authority"] as const)(
    "does not request an ordinary worker token after session replacement during %s", async stage => {
      const { repository, provider } = fixture();
      const user: AuthenticatedUser = { tenantId: scope.tenantId, homeAccountId: scope.principalId,
        displayName: "Admin", username: "admin@example.invalid", roles: ["AgentControl.Admin"] };
      vi.spyOn(msal, "revalidateAuthorizedUser").mockImplementation(async () => {
        if (stage === "revalidation") await replaceSession();
        return user;
      });
      vi.spyOn(capabilities, "requireAvailable").mockImplementation(async capabilityId => {
        if (stage === "capability") await replaceSession();
        return { capabilityId, status: "available", authorized: true, fresh: true, previewQualification: "not_required", remediation: [] };
      });
      vi.spyOn(capabilities, "quarantineAuthorityContext").mockImplementation(async () => {
        if (stage === "authority") await replaceSession();
        return authority;
      });
      const token = vi.spyOn(msal, "acquireAuthorizedToken").mockResolvedValue("fixture");

      await expect(runCopilotStudioQuarantineJob(jobId, scope, false, repository, provider))
        .rejects.toMatchObject({ code: "unauthorized" });
      expect(token).not.toHaveBeenCalled();
      expect(repository.claim).not.toHaveBeenCalled();
      expect(provider.getStatus).not.toHaveBeenCalled();
      expect(provider.setQuarantine).not.toHaveBeenCalled();
    },
  );

  it("rejects ordinary resume of an interrupted canary before acquiring fresh authority or dispatching", async () => {
    const { repository, provider, authorize } = fixture();
    vi.mocked(repository.get).mockResolvedValue({ ...summary, isCanary: true,
      status: "waiting_authorization", canResume: false });
    await replaceSession();

    await expect(runCopilotStudioQuarantineJob(jobId, scope, true, repository, provider, authorize))
      .rejects.toMatchObject({ code: "not_resumable" });

    expect(authorize).not.toHaveBeenCalled();
    expect(repository.claim).not.toHaveBeenCalled();
    expect(provider.getStatus).not.toHaveBeenCalled();
    expect(provider.setQuarantine).not.toHaveBeenCalled();
  });

  it("preserves one-shot writes and verified success", async () => {
    const { repository, provider, authorize } = fixture();
    await runCopilotStudioQuarantineJob(jobId, scope, false, repository, provider, authorize);
    expect(repository.markSent).toHaveBeenCalledOnce();
    expect(provider.setQuarantine).toHaveBeenCalledOnce();
    expect(provider.getStatus).toHaveBeenCalledTimes(3);
    expect(repository.finishItem).toHaveBeenCalledWith(expect.anything(), item, "succeeded", expect.objectContaining({ observed: status(true) }), expect.any(AbortSignal), expect.any(Function));
    expect(repository.release).toHaveBeenCalledOnce();
    expect(settleControls).toHaveBeenCalledWith(scope, expect.any(AbortSignal));
  });

  it("revalidates a concurrent publication gap before the first send without duplicating a writer",async()=>{
    const f=fixture();
    vi.mocked(f.repository.assertDispatchReady).mockRejectedValueOnce(new AppError(409,"quarantine_target_unavailable","Concurrent canonical publication."));
    await runCopilotStudioQuarantineJob(jobId,scope,false,f.repository,f.provider,f.authorize);
    expect(f.provider.setQuarantine).toHaveBeenCalledOnce();
    expect(f.repository.markSent).toHaveBeenCalledOnce();
    expect(f.repository.finishItem).toHaveBeenCalledWith(expect.anything(),expect.anything(),"succeeded",expect.anything(),expect.anything(),expect.anything());
  });
  it("bounds revalidation of a genuinely removed native target and never sends",async()=>{
    const f=fixture();
    vi.mocked(f.repository.assertDispatchReady).mockRejectedValue(new AppError(409,"quarantine_target_unavailable","Removed native target."));
    await runCopilotStudioQuarantineJob(jobId,scope,false,f.repository,f.provider,f.authorize);
    expect(f.repository.assertDispatchReady).toHaveBeenCalledTimes(3);
    expect(f.provider.setQuarantine).not.toHaveBeenCalled();
    expect(f.repository.markSent).not.toHaveBeenCalled();
    expect(f.repository.finishItem).toHaveBeenCalledWith(expect.anything(),expect.anything(),"failed",expect.objectContaining({errorCode:"quarantine_target_unavailable"}));
  });
  it("never revalidates or replays a target error after its one-shot send fence",async()=>{
    const f=fixture();
    f.provider.setQuarantine.mockRejectedValue(new AppError(409,"quarantine_target_unavailable","Synthetic error after send."));
    await runCopilotStudioQuarantineJob(jobId,scope,false,f.repository,f.provider,f.authorize);
    expect(f.provider.setQuarantine).toHaveBeenCalledOnce();
    expect(f.repository.markSent).toHaveBeenCalledOnce();
    expect(f.repository.finishItem).toHaveBeenCalledWith(expect.anything(),expect.anything(),"inconclusive",expect.objectContaining({errorCode:"quarantine_target_unavailable"}));
  });
  it("retries only verified evidence persistence after a concurrent canonical publication gap, never the sent writer",async()=>{
    const f=fixture();
    vi.mocked(f.repository.finishItem).mockRejectedValueOnce(new AppError(409,"quarantine_target_unavailable","Concurrent canonical publication before evidence commit."));
    await runCopilotStudioQuarantineJob(jobId,scope,false,f.repository,f.provider,f.authorize);
    expect(f.repository.finishItem).toHaveBeenCalledTimes(2);
    expect(f.repository.finishItem).toHaveBeenLastCalledWith(expect.anything(),expect.anything(),"succeeded",expect.anything(),expect.anything(),expect.anything());
    expect(f.provider.setQuarantine).toHaveBeenCalledOnce();
    expect(f.repository.markSent).toHaveBeenCalledOnce();
  });
  it("keeps provider dispatch closed when pending inventory controls cannot settle", async () => {
    const { repository, provider, authorize } = fixture();
    settleControls.mockRejectedValueOnce(new Error("inventory control publication failed"));
    await expect(runCopilotStudioQuarantineJob(jobId, scope, false, repository, provider, authorize))
      .rejects.toThrow("inventory control publication failed");
    expect(repository.beginItem).not.toHaveBeenCalled();
    expect(provider.setQuarantine).not.toHaveBeenCalled();
    expect(repository.release).toHaveBeenCalledOnce();
  });

  it.each(["session", "capability", "admissions"] as const)(
    "does not begin an item after %s changes while inventory controls settle", async boundary => {
      const { repository, provider, authorize } = fixture();
      const failure = new AppError(boundary === "admissions" ? 503 : 401,
        boundary === "admissions" ? "maintenance" : "unauthorized", "Authority changed.");
      let invalidated = false;
      vi.spyOn(capabilities, "beginOperationValidation").mockReturnValue(() => {
        if (boundary === "capability" && invalidated) throw failure;
      });
      settleControls.mockImplementationOnce(async () => {
        if (boundary === "session") await replaceSession();
        else if (boundary === "admissions") vi.mocked(requireProviderAdmissions).mockImplementation(() => { throw failure; });
        else invalidated = true;
      });
      await expect(runCopilotStudioQuarantineJob(jobId, scope, false, repository, provider, authorize))
        .rejects.toMatchObject({ code: failure.code });
      expect(repository.beginItem).not.toHaveBeenCalled();
      expect(provider.getStatus).not.toHaveBeenCalled();
      expect(provider.setQuarantine).not.toHaveBeenCalled();
      expect(repository.release).toHaveBeenCalledOnce();
    },
  );

  it.each([1, 2, 3, 4])("settles shutdown without waiting for pending authorization %s", async boundary => {
    const { repository, provider, authorize } = fixture();
    const controller = new AbortController();
    const pending = deferred<typeof authorization>();
    let authorizations = 0;
    authorize.mockImplementation(async () => ++authorizations === boundary ? pending.promise : authorization);
    const execution = runCopilotStudioQuarantineJob(jobId, scope, false, repository, provider, authorize, controller.signal);
    try {
      await vi.waitFor(() => expect(authorize).toHaveBeenCalledTimes(boundary));
      controller.abort(new AppError(503, "shutdown", "Stopped."));
      await vi.waitFor(() => {
        if (boundary === 1) expect(repository.waitForAuthorization).toHaveBeenCalledOnce();
        else expect(repository.release).toHaveBeenCalledOnce();
      });
    } finally {
      pending.resolve(authorization);
      await execution;
    }
    expect(provider.setQuarantine).toHaveBeenCalledTimes(boundary === 4 ? 1 : 0);
    if (boundary >= 3) expect(repository.finishItem).toHaveBeenCalledExactlyOnceWith(expect.anything(), item,
      boundary === 4 ? "inconclusive" : "cancelled", expect.objectContaining({ errorCode: "shutdown" }));
    expect(repository.claim).toHaveBeenCalledTimes(boundary === 1 ? 0 : 1);
  });

  it.each(["revalidation", "capability", "authority"] as const)(
    "does not request a worker token after capability invalidation during %s", async boundary => {
      const { repository, provider } = fixture();
      const failure = new AppError(401, "authorization_expired", "Authority changed.");
      let invalidated = false;
      vi.spyOn(capabilities, "beginOperationValidation").mockReturnValue(() => {
        if (invalidated) throw failure;
      });
      vi.spyOn(msal, "revalidateAuthorizedUser").mockImplementation(async () => {
        if (boundary === "revalidation") invalidated = true;
        return { tenantId: scope.tenantId, homeAccountId: scope.principalId,
          displayName: "Admin", username: "admin@example.invalid", roles: ["AgentControl.Admin"] };
      });
      vi.spyOn(capabilities, "requireAvailable").mockImplementation(async capabilityId => {
        if (boundary === "capability") invalidated = true;
        return { capabilityId, status: "available", authorized: true, fresh: true, previewQualification: "not_required", remediation: [] };
      });
      vi.spyOn(capabilities, "quarantineAuthorityContext").mockImplementation(async () => {
        if (boundary === "authority") invalidated = true;
        return authority;
      });
      const token = vi.spyOn(msal, "acquireAuthorizedToken").mockResolvedValue("fixture");
      await expect(runCopilotStudioQuarantineJob(jobId, scope, false, repository, provider)).rejects.toBe(failure);
      expect(token).not.toHaveBeenCalled();
      expect(repository.claim).not.toHaveBeenCalled();
    },
  );

  it("preserves an execution error when releasing its job lease also fails", async () => {
    const { repository, provider, authorize } = fixture();
    const primary = new AppError(409, "inventory_control_conflict", "Sensitive primary details");
    settleControls.mockRejectedValueOnce(primary);
    vi.mocked(repository.release).mockRejectedValueOnce(new Error("Sensitive lease cleanup details"));
    await expect(runCopilotStudioQuarantineJob(jobId, scope, false, repository, provider, authorize)).rejects.toBe(primary);
    expect(provider.setQuarantine).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledOnce();
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain("Sensitive");
  });

  it("surfaces lease-release failure without replacing a committed verified outcome", async () => {
    const { repository, provider, authorize } = fixture();
    const failure = new Error("Lease cleanup failed");
    vi.mocked(repository.release).mockRejectedValueOnce(failure);
    await expect(runCopilotStudioQuarantineJob(jobId, scope, false, repository, provider, authorize)).rejects.toBe(failure);
    expect(provider.setQuarantine).toHaveBeenCalledOnce();
    expect(repository.finishItem).toHaveBeenCalledOnce();
    expect(repository.finishItem).toHaveBeenCalledWith(expect.anything(), item, "succeeded",
      expect.objectContaining({ observed: status(true) }), expect.any(AbortSignal), expect.any(Function));
  });

  it.each(["authorization_wait", "authorization_pause", "terminal_item"] as const)(
    "preserves the primary failure if %s persistence also fails", async stage => {
      const { repository, provider, authorize } = fixture();
      const primary = new AppError(stage === "terminal_item" ? 502 : 401, "provider_error", "Sensitive primary details");
      const secondary = new Error("Sensitive persistence details");
      if (stage === "authorization_wait") {
        authorize.mockRejectedValueOnce(primary);
        vi.mocked(repository.waitForAuthorization).mockRejectedValueOnce(secondary);
      } else if (stage === "authorization_pause") {
        provider.getStatus.mockRejectedValueOnce(primary);
        vi.mocked(repository.pauseItemForAuthorization).mockRejectedValueOnce(secondary);
      } else {
        provider.setQuarantine.mockRejectedValueOnce(primary);
        vi.mocked(repository.finishItem).mockRejectedValueOnce(secondary);
      }
      await expect(runCopilotStudioQuarantineJob(jobId, scope, false, repository, provider, authorize)).rejects.toBe(primary);
      const entries = vi.mocked(console.error).mock.calls.map(([entry]) => JSON.parse(String(entry)));
      expect(entries).toContainEqual(expect.objectContaining({ event: "quarantine_job_cleanup_failed", jobId, stage,
        outcome: "requires_review", errorCode: "internal_error" }));
      expect(JSON.stringify(entries)).not.toContain("Sensitive");
      expect(repository.release).toHaveBeenCalledTimes(stage === "authorization_wait" ? 0 : 1);
    },
  );

  it.each(["initial-authorization", "lock", "pre-read", "immediate", "sent", "post", "readback", "no-op", "publication"] as const)(
    "does not revive stale work after replacement sign-in during %s", async stage => {
      const { repository, provider, authorize } = fixture();
      let replacement: Promise<void> | undefined;
      let reads = 0;
      let authorizations = 0;
      authorize.mockImplementation(async () => {
        authorizations += 1;
        if (stage === "initial-authorization" && authorizations === 1 || stage === "publication" && authorizations === 4) await replaceSession();
        return authorization;
      });
      vi.mocked(repository.withTargetLock).mockImplementation(async (_lease, _item, operation) => {
        if (stage === "lock") await replaceSession();
        return operation(new AbortController().signal);
      });
      vi.mocked(repository.markSent).mockImplementation(async () => {
        if (stage === "sent") replacement = replaceSession();
      });
      provider.setQuarantine.mockImplementation(async () => {
        if (stage === "post") await replaceSession();
        return status(true);
      });
      provider.getStatus.mockImplementation(async () => {
        reads += 1;
        if ((stage === "pre-read" || stage === "no-op") && reads === 1 || stage === "immediate" && reads === 2 || stage === "readback" && reads === 3) await replaceSession();
        return status(stage === "no-op" || reads >= 3);
      });
      const execution = runCopilotStudioQuarantineJob(jobId, scope, false, repository, provider, authorize);
      if (stage === "initial-authorization") await expect(execution).rejects.toMatchObject({ code: "unauthorized" });
      else await execution;
      await replacement;

      expect(provider.setQuarantine).toHaveBeenCalledTimes(["post", "readback", "publication"].includes(stage) ? 1 : 0);
      expect(vi.mocked(repository.finishItem).mock.calls.some(([, , outcome]) => outcome === "succeeded" || outcome === "skipped")).toBe(false);
      if (["sent", "post", "readback", "publication"].includes(stage)) {
        expect(repository.finishItem).toHaveBeenCalledWith(expect.anything(), item, "inconclusive", expect.objectContaining({ errorCode: "unauthorized" }));
      } else if (stage === "initial-authorization") {
        expect(repository.claim).not.toHaveBeenCalled();
      } else {
        expect(repository.pauseItemForAuthorization).toHaveBeenCalledOnce();
      }
    },
  );

  it("does not claim when shutdown wins during pending authorization", async () => {
    const { repository, provider, authorize } = fixture();
    const controller = new AbortController();
    authorize.mockImplementation(async () => {
      controller.abort(new AppError(503, "shutdown", "Stopped."));
      return authorization;
    });
    await runCopilotStudioQuarantineJob(jobId, scope, false, repository, provider, authorize, controller.signal);
    expect(repository.claim).not.toHaveBeenCalled();
    expect(provider.getStatus).not.toHaveBeenCalled();
  });

  it.each([1, 2])("does not admit work interrupted during capability evidence publication %s", async boundary => {
    const { repository, provider, authorize } = fixture();
    const controller = new AbortController();
    let observations = 0;
    vi.mocked(capabilities.observeOperation).mockImplementation(async (_id, _principal, operation) => {
      const result = await operation(() => undefined);
      if (++observations === boundary) controller.abort(new AppError(503, "shutdown", "Stopped."));
      return result;
    });
    await runCopilotStudioQuarantineJob(jobId, scope, false, repository, provider, authorize, controller.signal);
    expect(repository.claim).toHaveBeenCalledTimes(boundary === 1 ? 0 : 1);
    expect(repository.beginItem).not.toHaveBeenCalled();
    expect(provider.getStatus).not.toHaveBeenCalled();
  });

  it.each(["cancelled", "shutdown", "interaction_required"] as const)("retains %s over a late provider failure and stops admitting items", async code => {
    const { repository, provider, authorize } = fixture();
    const controller = new AbortController();
    vi.mocked(repository.beginItem).mockResolvedValue({ job, item });
    provider.getStatus.mockImplementation(async () => {
      controller.abort(new AppError(code === "interaction_required" ? 401 : 409, code, "Stopped."));
      throw new Error("Late transport rejection.");
    });
    await runCopilotStudioQuarantineJob(jobId, scope, false, repository, provider, authorize, controller.signal);
    expect(repository.beginItem).toHaveBeenCalledOnce();
    expect(provider.setQuarantine).not.toHaveBeenCalled();
    if (code === "interaction_required") expect(repository.pauseItemForAuthorization).toHaveBeenCalledOnce();
    else expect(repository.finishItem).toHaveBeenCalledWith(expect.anything(), item, "cancelled", expect.objectContaining({ errorCode: code }));
  });

  it.each([false, true])("preserves prestate timestamp conflicts and existing-state no-ops (no-op=%s)", async noOp => {
    const { repository, provider, authorize } = fixture();
    provider.getStatus.mockResolvedValue(status(noOp, "2026-09-24T12:02:00Z"));
    await runCopilotStudioQuarantineJob(jobId, scope, false, repository, provider, authorize);
    expect(provider.setQuarantine).not.toHaveBeenCalled();
    expect(repository.finishItem).toHaveBeenCalledWith(expect.anything(), item, noOp ? "skipped" : "failed",
      expect.objectContaining(noOp ? { observed: status(true, "2026-09-24T12:02:00Z") } : { errorCode: "quarantine_prestate_conflict" }),
      ...(noOp ? [expect.any(AbortSignal), expect.any(Function)] : []));
  });

  it.each(["authorization", "prestate"] as const)("retains %s failure classification when target unlock also fails", async boundary => {
    const database = new pg.Pool();
    const client = Object.assign(new pg.Client(), { release: vi.fn() });
    vi.spyOn(database, "connect").mockImplementation(async () => client);
    const cleanup = new Error("Sensitive lock cleanup details.");
    vi.spyOn(client, "query").mockImplementation(vi.fn(async text => {
      if (String(text).startsWith("SELECT pg_advisory_unlock")) {
        client.emit("error", cleanup);
        throw cleanup;
      }
      const rows = String(text).startsWith("SELECT * FROM copilot_quarantine_jobs") ? [job] : [];
      return { command: "", oid: 0, fields: [], rowCount: rows.length, rows };
    }));
    const { repository, provider, authorize } = fixture(new CopilotStudioQuarantineRepository(database));
    vi.mocked(repository.withTargetLock).mockRestore();
    if (boundary === "authorization") {
      provider.getStatus.mockRejectedValue(new AppError(401, "provider_authorization_error", "Provider authorization expired."));
    } else provider.getStatus.mockResolvedValue(status(false, "2026-09-24T12:02:00Z"));

    await runCopilotStudioQuarantineJob(jobId, scope, false, repository, provider, authorize);

    expect(provider.setQuarantine).not.toHaveBeenCalled();
    expect(client.release).toHaveBeenCalledExactlyOnceWith(cleanup);
    if (boundary === "authorization") {
      expect(repository.pauseItemForAuthorization).toHaveBeenCalledOnce();
      expect(repository.finishItem).not.toHaveBeenCalled();
    } else {
      expect(repository.pauseItemForAuthorization).not.toHaveBeenCalled();
      expect(repository.finishItem).toHaveBeenCalledExactlyOnceWith(expect.anything(), item, "failed",
        expect.objectContaining({ errorCode: "quarantine_prestate_conflict" }));
    }
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain("Sensitive");
  });

  it("retains the deadline outcome over a late transport rejection", async () => {
    const { repository, provider, authorize } = fixture();
    const controller = new AbortController();
    provider.getStatus.mockImplementation(async () => {
      controller.abort(new DOMException("Deadline exceeded.", "TimeoutError"));
      throw new Error("Late transport rejection.");
    });
    await runCopilotStudioQuarantineJob(jobId, scope, false, repository, provider, authorize, controller.signal);
    expect(repository.finishItem).toHaveBeenCalledWith(expect.anything(), item, "failed", expect.objectContaining({ errorCode: "provider_timeout" }));
    expect(provider.setQuarantine).not.toHaveBeenCalled();
  });

  it.each(["read", "dispatch", "post", "publication"] as const)("fences lock loss during %s without replay or verified publication", async stage => {
    const { repository, provider, authorize } = fixture();
    const controller = new AbortController();
    const failure = new AppError(409, "quarantine_lock_lost", "Synthetic lock loss.");
    vi.mocked(repository.withTargetLock).mockImplementation(async (_lease, _item, operation) => operation(controller.signal));
    const read = provider.getStatus.getMockImplementation()!;
    provider.getStatus.mockImplementation(async (...args) => {
      if (stage === "read") controller.abort(failure);
      return read(...args);
    });
    vi.mocked(repository.markSent).mockImplementation(async () => {
      if (stage === "dispatch") controller.abort(failure);
    });
    const write = provider.setQuarantine.getMockImplementation()!;
    provider.setQuarantine.mockImplementation(async (...args) => {
      if (stage === "post") controller.abort(failure);
      return write(...args);
    });
    let authorizations = 0;
    authorize.mockImplementation(async () => {
      if (++authorizations === 4 && stage === "publication") controller.abort(failure);
      return authorization;
    });

    await runCopilotStudioQuarantineJob(jobId, scope, false, repository, provider, authorize);
    expect(provider.setQuarantine).toHaveBeenCalledTimes(["post", "publication"].includes(stage) ? 1 : 0);
    expect(repository.finishItem).toHaveBeenCalledExactlyOnceWith(expect.anything(), item,
      stage === "read" ? "failed" : "inconclusive", expect.objectContaining({ errorCode: failure.code }));
    expect(provider.getStatus.mock.calls.every(([, , options]) => options?.signal?.aborted)).toBe(true);
  });

  it("does not overwrite a committed result when target-lock cleanup fails", async () => {
    const { repository, provider, authorize } = fixture();
    const failure = new Error("Synthetic lock cleanup failure.");
    vi.mocked(repository.withTargetLock).mockImplementation(async (_lease, _item, operation) => {
      await operation(new AbortController().signal);
      throw failure;
    });
    await expect(runCopilotStudioQuarantineJob(jobId, scope, false, repository, provider, authorize)).rejects.toBe(failure);
    expect(repository.finishItem).toHaveBeenCalledExactlyOnceWith(expect.anything(), item, "succeeded",
      expect.objectContaining({ observed: status(true) }), expect.any(AbortSignal), expect.any(Function));
    expect(provider.setQuarantine).toHaveBeenCalledOnce();
    expect(repository.release).toHaveBeenCalledOnce();
  });

  it("does not publish exhausted readback evidence after the initiating session changes during failure reporting", async () => {
    vi.useFakeTimers();
    try {
      const { repository, provider, authorize } = fixture();
      provider.setQuarantine.mockResolvedValue(status(true));
      vi.mocked(capabilities.observeOperation).mockImplementation(async (_id, _principal, operation) => {
        try { return await operation(() => undefined); }
        catch (error) {
          if (error instanceof AppError && error.code === "verification_inconclusive") await replaceSession();
          throw error;
        }
      });
      let published = false;
      vi.mocked(repository.finishItem).mockImplementation(async (_lease, _item, _outcome, _evidence, _signal, beforeCommit) => {
        beforeCommit?.();
        published = true;
      });
      const assertion = expect(runCopilotStudioQuarantineJob(jobId, scope, false, repository, provider, authorize))
        .rejects.toMatchObject({ code: "verification_inconclusive" });
      await vi.advanceTimersByTimeAsync(3_000);
      await assertion;
      expect(published).toBe(false);
      expect(vi.mocked(console.error).mock.calls.map(([entry]) => JSON.parse(String(entry)))).toContainEqual(
        expect.objectContaining({ event: "quarantine_job_cleanup_failed", stage: "terminal_item", errorCode: "unauthorized" }),
      );
      expect(provider.setQuarantine).toHaveBeenCalledOnce();
      expect(repository.release).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });

  it("preserves the readback failure when persisted authority rejects inconclusive evidence publication", async () => {
    const { repository, provider, authorize } = fixture();
    let primary: AppError | undefined;
    vi.mocked(capabilities.observeOperation).mockImplementation(async (_id, _principal, operation) => {
      try { return await operation(() => undefined); }
      catch (error) {
        if (error instanceof AppError && error.code === "verification_inconclusive") primary = error;
        throw error;
      }
    });
    provider.getStatus.mockResolvedValue(status(false));
    vi.mocked(repository.finishItem).mockRejectedValueOnce(new AppError(409, "cancelled", "Persisted cancellation closed publication."));

    const execution = runCopilotStudioQuarantineJob(jobId, scope, false, repository, provider, authorize);
    await expect(execution).rejects.toMatchObject({ code: "verification_inconclusive" });
    expect(await execution.catch(error => error)).toBe(primary);

    expect(repository.markSent).toHaveBeenCalledOnce();
    expect(provider.setQuarantine).toHaveBeenCalledOnce();
    expect(provider.getStatus).toHaveBeenCalledTimes(7);
    expect(repository.finishItem).toHaveBeenCalledExactlyOnceWith(expect.anything(), item, "inconclusive",
      expect.objectContaining({ observed: status(false), readbackCount: 5, errorCode: "verification_inconclusive" }),
      expect.any(AbortSignal), expect.any(Function));
    expect(repository.release).toHaveBeenCalledOnce();
    expect(vi.mocked(console.error).mock.calls.map(([entry]) => JSON.parse(String(entry)))).toContainEqual(
      expect.objectContaining({ event: "quarantine_job_cleanup_failed", stage: "terminal_item", errorCode: "cancelled" }),
    );
  });
});

describe("quarantine GET-only reconciliation boundaries", () => {
  it.each([1, 2, 3])("bounds pending reconciliation authorization %s by its deadline", async boundary => {
    const { repository, provider, authorize } = fixture();
    const controller = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    const pending = deferred<typeof authorization>();
    let authorizations = 0, settled = false;
    authorize.mockImplementation(async () => ++authorizations === boundary ? pending.promise : authorization);
    const execution = reconcileCopilotStudioQuarantineJob(jobId, scope, repository, provider, authorize);
    const result = execution.then(() => { settled = true; }, error => { settled = true; throw error; });
    const assertion = expect(result).rejects.toMatchObject({ name: "TimeoutError" });
    try {
      await vi.waitFor(() => expect(authorize).toHaveBeenCalledTimes(boundary));
      controller.abort(new DOMException("Deadline exceeded.", "TimeoutError"));
      await vi.waitFor(() => expect(settled).toBe(true));
    } finally {
      pending.resolve(authorization);
      await assertion;
    }
    expect(repository.recordReconciliation).toHaveBeenCalledTimes(boundary === 3 ? 1 : 0);
    expect(provider.setQuarantine).not.toHaveBeenCalled();
  });

  it.each(["lookup", "authorization", "lock", "readback", "next-item", "final-authorization", "response"] as const)(
    "rejects a superseded reconciliation session during %s", async stage => {
      const { repository, provider, authorize } = fixture();
      let replacement: Promise<void> | undefined;
      vi.mocked(repository.reconciliationItems).mockImplementation(async () => {
        if (stage === "lookup") await replaceSession();
        return { job, items: stage === "next-item" ? [item, { ...item, id: "second" }] : [item] };
      });
      let authorizations = 0;
      authorize.mockImplementation(async () => {
        authorizations += 1;
        if (stage === "authorization" && authorizations === 1 || stage === "final-authorization" && authorizations === 3) await replaceSession();
        return authorization;
      });
      vi.mocked(repository.withReconciliationLock).mockImplementation(async (_scope, _item, operation) => {
        if (stage === "lock") await replaceSession();
        return operation(new AbortController().signal);
      });
      provider.getStatus.mockImplementation(async () => {
        if (stage === "readback") await replaceSession();
        return status(true);
      });
      vi.mocked(repository.recordReconciliation).mockImplementation(async () => {
        if (stage === "next-item") replacement = replaceSession();
      });
      vi.mocked(repository.get).mockImplementation(async () => {
        if (stage === "response") await replaceSession();
        return summary;
      });
      await expect(reconcileCopilotStudioQuarantineJob(jobId, scope, repository, provider, authorize))
        .rejects.toMatchObject({ code: "unauthorized" });
      await replacement;
      expect(repository.recordReconciliation).toHaveBeenCalledTimes(["next-item", "final-authorization", "response"].includes(stage) ? 1 : 0);
      expect(provider.getStatus).toHaveBeenCalledTimes(["lookup", "authorization", "lock"].includes(stage) ? 0 : 1);
      expect(provider.setQuarantine).not.toHaveBeenCalled();
    },
  );

  it.each(["verified_applied", "verified_not_applied", "conflict"] as const)("preserves %s evidence without POST", async outcome => {
    const { repository, provider, authorize } = fixture();
    provider.getStatus.mockResolvedValue(status(outcome === "verified_applied", outcome === "conflict" ? "2026-09-24T12:02:00Z" : updatedAt));
    await expect(reconcileCopilotStudioQuarantineJob(jobId, scope, repository, provider, authorize)).resolves.toMatchObject({
      id: jobId, reconciliation: { attempted: 1, failed: 0, errors: [] },
    });
    expect(repository.recordReconciliation).toHaveBeenCalledWith(scope, job, expect.anything(), outcome, expect.anything(), expect.any(String), expect.any(AbortSignal), expect.any(Function));
    expect(provider.setQuarantine).not.toHaveBeenCalled();
  });

  it("returns not found if the receipt expires before the final read", async () => {
    const { repository, provider, authorize } = fixture();
    vi.mocked(repository.get).mockResolvedValue(undefined);
    await expect(reconcileCopilotStudioQuarantineJob(jobId, scope, repository, provider, authorize)).rejects.toMatchObject({ code: "not_found" });
  });

  it("does not call a committed reconciliation a failed read when lock cleanup fails", async () => {
    const { repository, provider, authorize } = fixture();
    provider.getStatus.mockResolvedValue(status(true));
    const failure = new Error("Synthetic lock cleanup failure.");
    vi.mocked(repository.withReconciliationLock).mockImplementation(async (_scope, _item, operation) => {
      await operation(new AbortController().signal);
      throw failure;
    });
    await expect(reconcileCopilotStudioQuarantineJob(jobId, scope, repository, provider, authorize)).rejects.toBe(failure);
    expect(repository.recordReconciliation).toHaveBeenCalledOnce();
    expect(provider.setQuarantine).not.toHaveBeenCalled();
  });

  it("fences GET-only reconciliation publication when its target lock is lost during authorization", async () => {
    const { repository, provider, authorize } = fixture();
    const controller = new AbortController();
    vi.mocked(repository.withReconciliationLock).mockImplementation(async (_scope, _item, operation) => operation(controller.signal));
    let authorizations = 0;
    authorize.mockImplementation(async () => {
      if (++authorizations === 2) controller.abort(new AppError(409, "quarantine_lock_lost", "Synthetic lock loss."));
      return authorization;
    });
    const result = await reconcileCopilotStudioQuarantineJob(jobId, scope, repository, provider, authorize);
    expect(result.reconciliation).toMatchObject({ attempted: 1, failed: 1 });
    expect(repository.recordReconciliation).not.toHaveBeenCalled();
    expect(provider.setQuarantine).not.toHaveBeenCalled();
  });
});

describe("quarantine worker tracking", () => {
  it("retains the original worker after a duplicate tracked claim exits, including UUID-case cancellation", async () => {
    const first = fixture();
    const second = fixture();
    const pending = deferred<CopilotStudioQuarantineStatus>();
    first.provider.getStatus.mockImplementationOnce(() => pending.promise);
    vi.mocked(second.repository.claim).mockResolvedValue(undefined);
    const original = runTrackedCopilotStudioQuarantineJob(jobId, scope, first.repository, first.provider, first.authorize);
    try {
      await vi.waitFor(() => expect(first.provider.getStatus).toHaveBeenCalledOnce());
      await runTrackedCopilotStudioQuarantineJob(jobId, scope, second.repository, second.provider, second.authorize);
      await cancelCopilotStudioQuarantineJob(scope, jobId.toUpperCase(), first.repository);
    } finally {
      pending.resolve(status(false));
      await original;
    }
    expect(first.provider.setQuarantine).not.toHaveBeenCalled();
    expect(first.repository.finishItem).toHaveBeenCalledWith(expect.anything(), item, "cancelled", expect.objectContaining({ errorCode: "cancelled" }));
  });

  it("does not consume capacity for a launch retry of an already tracked UUID alias", async () => {
    const first = fixture();
    const second = fixture();
    const pending = deferred<QuarantineJob>();
    vi.mocked(first.repository.get).mockReturnValue(pending.promise);
    vi.mocked(second.repository.get).mockReturnValue(pending.promise);
    const original = runTrackedCopilotStudioQuarantineJob(jobId, scope, first.repository, first.provider, first.authorize);
    const other = runTrackedCopilotStudioQuarantineJob("other", scope, second.repository, second.provider, second.authorize);
    try {
      expect(() => launchCopilotStudioQuarantineJob(jobId.toUpperCase(), scope)).not.toThrow();
    } finally {
      pending.resolve(summary);
      await Promise.all([original, other]);
    }
  });

  it("surfaces logged background persistence failures to shutdown drain", async () => {
    const { repository } = fixture(copilotStudioQuarantineJobs);
    const pending = deferred<QuarantineJob>();
    vi.mocked(repository.get).mockReturnValue(pending.promise);
    launchCopilotStudioQuarantineJob(jobId, scope);
    const draining = drainCopilotStudioQuarantineJobs();
    const assertion = expect(draining).rejects.toThrow("Receipt persistence failed.");
    pending.reject(new Error("Receipt persistence failed."));
    await assertion;
  });

  it("does not cancel another principal's worker", async () => {
    const { repository, provider, authorize } = fixture();
    const pending = deferred<CopilotStudioQuarantineStatus>();
    provider.getStatus.mockImplementationOnce(() => pending.promise);
    vi.mocked(repository.cancel).mockResolvedValue(undefined);
    const execution = runTrackedCopilotStudioQuarantineJob(jobId, scope, repository, provider, authorize);
    try {
      await vi.waitFor(() => expect(provider.getStatus).toHaveBeenCalledOnce());
      await expect(cancelCopilotStudioQuarantineJob({ ...scope, principalId: "other" }, jobId, repository)).resolves.toBeUndefined();
    } finally {
      pending.resolve(status(false));
      await execution;
    }
    expect(provider.setQuarantine).toHaveBeenCalledOnce();
  });
});
