import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CopilotStudioQuarantineRepository, createQuarantineConfirmation, type QuarantineJobRow } from "../db/copilotStudioQuarantine.js";
import { activateAccountSession, revokeAccountSessionMutations } from "../db/sessions.js";
import { AppError } from "../errors.js";
import type { CopilotStudioQuarantineStatus, QuarantineJob } from "../types/copilotStudioQuarantine.js";

vi.mock("../db/pool.js", () => ({
  pool: {},
  secretValue: vi.fn(),
  transaction: vi.fn(async () => { throw new Error("Unit tests must not access a database."); }),
}));
vi.mock("./maintenance.js", () => ({ maintenanceActive: vi.fn(() => false) }));
vi.mock("./operationalState.js", () => ({ requireProviderAdmissions: vi.fn() }));

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
  vi.spyOn(repository, "withTargetLock").mockImplementation(async (_lease, _item, operation) => operation());
  vi.spyOn(repository, "assertDispatchReady").mockResolvedValue(undefined);
  vi.spyOn(repository, "markSent").mockResolvedValue(undefined);
  vi.spyOn(repository, "finishItem").mockResolvedValue(undefined);
  vi.spyOn(repository, "pauseItemForAuthorization").mockResolvedValue(undefined);
  vi.spyOn(repository, "release").mockResolvedValue(undefined);
  vi.spyOn(repository, "cancel").mockResolvedValue(summary);
  vi.spyOn(repository, "reconciliationItems").mockResolvedValue({ job, items: [{ ...item, status: "inconclusive", reconciliation_status: "required" }] });
  vi.spyOn(repository, "withReconciliationLock").mockImplementation(async (_scope, _item, operation) => operation());
  vi.spyOn(repository, "assertReconciliationTarget").mockResolvedValue(undefined);
  vi.spyOn(repository, "recordReconciliation").mockResolvedValue(undefined);
  let state = false;
  const provider = {
    getStatus: vi.fn(async () => status(state)),
    setQuarantine: vi.fn(async () => { state = true; return status(state); }),
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
  await activateAccountSession(scope.tenantId, scope.principalId, async () => undefined);
  vi.mocked(requireProviderAdmissions).mockImplementation(() => undefined);
  vi.spyOn(capabilities, "observeOperation").mockImplementation(async (_id, _user, operation) => operation(() => undefined));
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

describe("quarantine execution session and cancellation boundaries", () => {
  it("preserves one-shot writes and verified success", async () => {
    const { repository, provider, authorize } = fixture();
    await runCopilotStudioQuarantineJob(jobId, scope, false, repository, provider, authorize);
    expect(repository.markSent).toHaveBeenCalledOnce();
    expect(provider.setQuarantine).toHaveBeenCalledOnce();
    expect(provider.getStatus).toHaveBeenCalledTimes(3);
    expect(repository.finishItem).toHaveBeenCalledWith(expect.anything(), item, "succeeded", expect.objectContaining({ observed: status(true) }));
    expect(repository.release).toHaveBeenCalledOnce();
  });

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
        return operation();
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
      expect(repository.finishItem).not.toHaveBeenCalledWith(expect.anything(), item, "succeeded", expect.anything());
      expect(repository.finishItem).not.toHaveBeenCalledWith(expect.anything(), item, "skipped", expect.anything());
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
      expect.objectContaining(noOp ? { observed: status(true, "2026-09-24T12:02:00Z") } : { errorCode: "quarantine_prestate_conflict" }));
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
});

describe("quarantine GET-only reconciliation boundaries", () => {
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
        return operation();
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
    expect(repository.recordReconciliation).toHaveBeenCalledWith(scope, job, expect.anything(), outcome, expect.anything(), expect.any(String));
    expect(provider.setQuarantine).not.toHaveBeenCalled();
  });

  it("returns not found if the receipt expires before the final read", async () => {
    const { repository, provider, authorize } = fixture();
    vi.mocked(repository.get).mockResolvedValue(undefined);
    await expect(reconcileCopilotStudioQuarantineJob(jobId, scope, repository, provider, authorize)).rejects.toMatchObject({ code: "not_found" });
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
