import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "../errors.js";
import { packageMutationStateHash, type PackageMutationState } from "./packageMutationState.js";
import { activateAccountSession, revokeAccountSessionMutations } from "../db/sessions.js";
import type { JobItem, JobRepository, JobRow, Lease } from "../db/jobs.js";
import type { PackageAccessUpdate } from "../types/copilotPackage.js";

vi.mock("../db/pool.js", () => ({
  pool: {},
  secretValue: vi.fn(),
  transaction: vi.fn(async () => { throw new Error("Unit tests must not access a database."); }),
}));
vi.mock("./maintenance.js", () => ({ maintenanceActive: vi.fn(() => false) }));
vi.mock("./operationalState.js", () => ({ requireProviderAdmissions: vi.fn() }));

import { bulkJobs, drainBulkJobs, launchBulkJob, reconcileBulkJob, requireWorkerCapacity, runBulkJob, runTrackedBulkJob } from "./bulkJobs.js";
import { GraphPackagesClient, type FetchLike } from "./graphPackages.js";
import { requireProviderAdmissions } from "./operationalState.js";
import { capabilities } from "./capabilities.js";

beforeEach(async () => {
  await activateAccountSession(scope.tenantId, scope.principalId, async () => undefined);
  vi.mocked(requireProviderAdmissions).mockImplementation(() => undefined);
  vi.spyOn(capabilities, "observeOperation").mockImplementation(async (_id, _user, operation) => operation(() => undefined));
  vi.spyOn(bulkJobs, "settleControlPublications").mockResolvedValue(undefined);
});
afterEach(() => vi.restoreAllMocks());

const scope = { tenantId: "tenant", principalId: "principal" };
const prestate = { kind: "block" as const, isBlocked: false };
type JobSummary = NonNullable<Awaited<ReturnType<JobRepository["get"]>>>;
const jobSummary: JobSummary = {
  id: "job", tokenMode: "delegated", capabilityId: "graph.package.block.manage",
  status: "queued", action: "block", targetBlockedState: true,
  confirmationHash: null, confirmation: null, confirmedAt: null, total: 1, completed: 0,
  succeeded: 0, failed: 0, skipped: 0, inconclusive: 0, cancelled: 0,
  queued: 1, reconciliationRequired: 0, retryEligible: 0, resultRevision: "1",
  currentAgentName: undefined, createdAt: "2026-09-24T12:00:00.000Z", updatedAt: "2026-09-24T12:00:00.000Z", canResume: false,
};
const durableJob: JobRow = {
  id: "job", tenant_id: scope.tenantId, principal_id: scope.principalId, token_mode: "delegated",
  capability: "graph.package.block.manage", action: "block", access_update: null, reassign_user_id: null,
  request_hash: "hash", confirmation_hash: "hash", confirmation_summary: null, confirmed_at: null,
  status: "partial", scope: "bulk", actor_username: "operator@example.invalid", actor_name: "Operator",
  request_path: "/agents/block", cancel_requested: false, lease_owner: null, lease_version: 1, lease_until: null,
  attempts: 1, created_at: new Date("2026-09-24T12:00:00Z"), updated_at: new Date("2026-09-24T12:00:00Z"),
  result_revision: "1",
};
const durableItem: JobItem = {
  id: "item", job_id: durableJob.id, target_id: "package", display_name: "Package", ordinal: 0,
  status: "inconclusive", sent_at: new Date("2026-09-24T12:00:00Z"), message: null, error_code: null,
  prestate, prestate_hash: packageMutationStateHash(prestate), poststate: null, poststate_hash: null,
  correlation_id: "11111111-1111-4111-8111-111111111111", reconciliation_status: "required", reconciled_at: null,
};
const reconciliationItem = { ...durableItem, candidate_count: "1" };
const principal = { resourceType: "user", resourceId: "22222222-2222-4222-8222-222222222222" };
const accessPrestate: PackageMutationState = {
  kind: "access", availableTo: "none", deployedTo: "none", allowedUsersAndGroups: [], acquireUsersAndGroups: [],
};

function fakeRepository(state: PackageMutationState = prestate, action: JobRow["action"] = "block", accessUpdate?: PackageAccessUpdate) {
  const lease = { jobId: "job", scope, owner: "worker", version: 1 };
  const job: JobRow = {
    ...durableJob, action, status: "running",
    capability: state.kind === "access" ? "graph.package.access.manage" : "graph.package.block.manage",
    access_update: state.kind === "access" ? accessUpdate ?? {
      target: action === "update-installation" ? "installation" : "availability",
      mode: "replace", scope: "specific", principals: [principal],
    } : null,
  };
  let begun = false;
  return {
    get: vi.fn(async () => ({ ...jobSummary, capabilityId: job.capability })),
    waitForAuthorization: vi.fn(async () => undefined),
    claim: vi.fn(async () => lease),
    pauseForAuthorization: vi.fn(async () => undefined),
    beginItem: vi.fn<JobRepository["beginItem"]>(async () => {
      if (begun) return undefined;
      begun = true;
      return {
        item: {
          ...durableItem, status: "running", sent_at: null,
          prestate: state, prestate_hash: packageMutationStateHash(state),
        },
        job,
        inventoryGeneration: "generation",
      };
    }),
    async withTargetLock<T>(_lease: Lease, _item: JobItem, operation: (signal: AbortSignal) => Promise<T>) {
      return operation(new AbortController().signal);
    },
    settleInventoryControls: vi.fn<JobRepository["settleInventoryControls"]>(async () => undefined), markSent: vi.fn(async () => undefined),
    finishItem: vi.fn<JobRepository["finishItem"]>(async () => undefined),
    pauseItemForAuthorization: vi.fn(async () => undefined),
    release: vi.fn(async () => undefined),
  } satisfies Parameters<typeof runBulkJob>[3];
}

function provider(fetcher: FetchLike) {
  return new GraphPackagesClient(fetcher, { maxAttempts: 1, delay: async () => undefined });
}

describe("bulk job execution boundaries", () => {
  it("durably records an inconclusive write without trying to persist an oversized divergent readback", async () => {
    const repository = fakeRepository(accessPrestate, "update-availability");
    repository.finishItem.mockImplementation(async (_lease, _item, _outcome, evidence) => {
      if (evidence?.poststate && Buffer.byteLength(JSON.stringify(evidence.poststate)) > 65_536) {
        throw new Error("Synthetic durable poststate byte constraint.");
      }
    });
    let written = false;
    const divergent = Array.from({ length: 1000 }, (_, index) => ({
      resourceType: "user", resourceId: `11111111-1111-4111-8111-${String(index).padStart(12, "0")}`,
    }));
    const fetcher = vi.fn<FetchLike>(async (_url, request) => {
      if (request?.method === "PATCH") {
        written = true;
        return new Response(null, { status: 204 });
      }
      return Response.json({
        id: "package", displayName: "Package", isBlocked: false, ...accessPrestate,
        ...(written ? { availableTo: "some", allowedUsersAndGroups: divergent } : {}),
      });
    });
    await expect(runBulkJob("job", scope, false, repository, provider(fetcher), async () => "token"))
      .resolves.toBeUndefined();
    expect(repository.markSent).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls.filter(([, request]) => request?.method === "PATCH")).toHaveLength(1);
    expect(repository.finishItem).toHaveBeenCalledExactlyOnceWith(expect.anything(), "item", "inconclusive", {
      message: "Provider write outcome is inconclusive; do not retry without reconciliation.",
      errorCode: "verification_inconclusive", readbackCount: 4,
    });
  });

  it.each(["update-availability", "update-installation"] as const)("does not dispatch an old %s intent whose projected state exceeds durable storage", async action => {
    const principals = Array.from({ length: 1000 }, (_, index) => ({
      resourceType: "user", resourceId: `11111111-1111-4111-8111-${String(index).padStart(12, "0")}`,
    }));
    const state: PackageMutationState = {
      ...accessPrestate, [action === "update-availability" ? "availableTo" : "deployedTo"]: "some",
      [action === "update-availability" ? "allowedUsersAndGroups" : "acquireUsersAndGroups"]: principals.slice(0, 500),
    };
    const repository = fakeRepository(state, action, {
      target: action === "update-availability" ? "availability" : "installation",
      mode: "add", scope: "specific", principals: principals.slice(500),
    });
    const fetcher = vi.fn<FetchLike>(async (_url, request) => request?.method === "PATCH"
      ? new Response(null, { status: 204 }) : Response.json({ id: "package", displayName: "Package", isBlocked: false, ...state }));
    await runBulkJob("job", scope, false, repository, provider(fetcher), async () => "token");
    expect(fetcher).toHaveBeenCalledOnce();
    expect(repository.markSent).not.toHaveBeenCalled();
    expect(repository.finishItem).toHaveBeenCalledExactlyOnceWith(expect.anything(), "item", "failed",
      expect.objectContaining({ errorCode: "mutation_state_too_large" }));
  });

  it("rejects a durable access action/target mismatch before the dispatch marker", async () => {
    const repository = fakeRepository(accessPrestate, "update-installation", {
      target: "availability", mode: "replace", scope: "specific", principals: [principal],
    });
    const fetcher = vi.fn<FetchLike>(async (_url, request) => request?.method === "PATCH"
      ? new Response(null, { status: 204 }) : Response.json({ id: "package", displayName: "Package", isBlocked: false, ...accessPrestate }));
    await runBulkJob("job", scope, false, repository, provider(fetcher), async () => "token");
    expect(fetcher).toHaveBeenCalledOnce();
    expect(repository.markSent).not.toHaveBeenCalled();
    expect(repository.finishItem).toHaveBeenCalledExactlyOnceWith(expect.anything(), "item", "failed",
      expect.objectContaining({ errorCode: "mutation_state_mismatch" }));
  });

  it.each(["update-availability", "update-installation"] as const)("stops an old confirmed %s write that cannot preserve the untouched scope", async action => {
    const state: PackageMutationState = {
      ...accessPrestate, [action === "update-availability" ? "deployedTo" : "availableTo"]: "all",
    };
    const repository = fakeRepository(state, action);
    const fetcher = vi.fn<FetchLike>(async () => Response.json({ id: "package", displayName: "Package", isBlocked: false, ...state }));
    await runBulkJob("job", scope, false, repository, provider(fetcher), async () => "token");
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0][1]?.method ?? "GET").toBe("GET");
    expect(repository.markSent).not.toHaveBeenCalled();
    expect(repository.finishItem).toHaveBeenCalledExactlyOnceWith(expect.anything(), "item", "failed",
      expect.objectContaining({ errorCode: "unpreservable_access_scope" }));
  });

  it.each([false, true])("rejects ordinary execution of an abandoned canary (resume: %s)", async resume => {
    const repository = fakeRepository(), fetcher = vi.fn<FetchLike>();
    repository.get.mockResolvedValue({ ...jobSummary, isCanary: true });
    await expect(runBulkJob("job", scope, resume, repository, provider(fetcher)))
      .rejects.toMatchObject({ code: "canary_cycle_authorization_required" });
    expect(repository.claim).not.toHaveBeenCalled();
    expect(repository.waitForAuthorization).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each(["opaque_user", " Opaque_User "])("does not dispatch after an opaque preserved principal changes to %j", async resourceId => {
    const state: PackageMutationState = {
      ...accessPrestate, deployedTo: "some",
      acquireUsersAndGroups: [{ resourceType: "user", resourceId: "Opaque_User" }],
    };
    const repository = fakeRepository(state, "update-availability");
    let reads = 0;
    const fetcher = vi.fn<FetchLike>(async () => {
      reads += 1;
      return Response.json({
        id: "package", displayName: "Package", isBlocked: false, ...state,
        acquireUsersAndGroups: [{ resourceType: "user", resourceId: reads === 1 ? "Opaque_User" : resourceId }],
      });
    });
    await runBulkJob("job", scope, false, repository, provider(fetcher), async () => "token");
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls.every(([, request]) => request?.method === undefined || request.method === "GET")).toBe(true);
    expect(repository.markSent).not.toHaveBeenCalled();
    expect(repository.finishItem).toHaveBeenCalledExactlyOnceWith(expect.anything(), "item", "failed",
      expect.objectContaining({ errorCode: "mutation_prestate_conflict" }));
  });

  it("does not claim work when shutdown interrupts pending authorization", async () => {
    const repository = fakeRepository();
    const controller = new AbortController();
    const stopped = new AppError(503, "shutdown", "Application shutdown stopped package work.");
    const authorize = vi.fn(async () => { controller.abort(stopped); return "token"; });
    const fetcher = vi.fn<FetchLike>();

    await runBulkJob("job", scope, false, repository, provider(fetcher), authorize, controller.signal);

    expect(repository.waitForAuthorization).toHaveBeenCalledOnce();
    expect(repository.claim).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("bounds a non-cooperative initial token callback and observes its late failure", async () => {
    const repository = fakeRepository(), deadline = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValueOnce(deadline.signal);
    let rejectToken!: (reason: Error) => void;
    const authorize = vi.fn(() => new Promise<string>((_resolve, reject) => { rejectToken = reject; }));
    const fetcher = vi.fn<FetchLike>();
    const execution = runBulkJob("job", scope, false, repository, provider(fetcher), authorize);
    const outcome = expect(execution).rejects.toMatchObject({ code: "provider_timeout" });
    await vi.waitFor(() => expect(authorize).toHaveBeenCalledOnce());
    deadline.abort(new DOMException("Synthetic authorization deadline.", "TimeoutError"));
    await outcome;
    rejectToken(new Error("Late private token failure."));
    await Promise.resolve();
    expect(repository.waitForAuthorization).toHaveBeenCalledOnce();
    expect(repository.claim).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects a late initial authorization when elapsed time expires but abort delivery is delayed", async () => {
    let elapsed = 0;
    vi.spyOn(performance, "now").mockImplementation(() => elapsed);
    vi.spyOn(AbortSignal, "timeout").mockImplementation(() => new AbortController().signal);
    const repository = fakeRepository();
    const fetcher = vi.fn<FetchLike>();
    await expect(runBulkJob("job", scope, false, repository, provider(fetcher), async () => {
      elapsed = 30_001;
      return "late-token";
    })).rejects.toMatchObject({ code: "provider_timeout" });
    expect(repository.waitForAuthorization).toHaveBeenCalledOnce();
    expect(repository.claim).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each(["retry", "publication", "response"] as const)("pins the initiating capability through %s", async stage => {
    const repository = fakeRepository(), failure = new AppError(401, "authorization_expired", "The initiating capability changed.");
    let current = true, written = false, authorizations = 0;
    vi.spyOn(capabilities, "beginOperationValidation").mockReturnValue(() => { if (!current) throw failure; });
    const fetcher = vi.fn<FetchLike>(async (_url, request) => {
      if (stage === "retry") { current = false; return new Response(null, { status: 503 }); }
      if (request?.method === "POST") { written = true; return new Response(null, { status: 204 }); }
      return Response.json({ id: "package", displayName: "Package", isBlocked: written });
    });
    const authorize = vi.fn(async () => {
      if (++authorizations === 4 && stage === "publication") current = false;
      return "token";
    });
    if (stage === "response") repository.finishItem.mockImplementation(async () => { current = false; });
    const execution = runBulkJob("job", scope, false, repository, new GraphPackagesClient(fetcher, { delay: async () => undefined }), authorize);
    if (stage === "response") await expect(execution).rejects.toBe(failure);
    else await execution;
    if (stage === "retry") {
      expect(fetcher).toHaveBeenCalledOnce();
      expect(repository.pauseItemForAuthorization).toHaveBeenCalledOnce();
      expect(repository.markSent).not.toHaveBeenCalled();
      expect(repository.finishItem).not.toHaveBeenCalled();
    } else {
      if (stage === "response") {
        expect(repository.finishItem).toHaveBeenCalledExactlyOnceWith(expect.anything(), "item", "succeeded",
          expect.anything(), expect.any(AbortSignal), expect.any(Function));
      } else {
        expect(repository.finishItem).toHaveBeenCalledExactlyOnceWith(expect.anything(), "item", "inconclusive",
          expect.objectContaining({ errorCode: "authorization_expired" }));
      }
      expect(fetcher.mock.calls.filter(([, request]) => request?.method === "POST")).toHaveLength(1);
    }
  });

  describe("read-only package reconciliation boundaries", () => {
    it("leaves reconciliation unresolved when the saved prestate does not match its frozen hash", async () => {
      vi.spyOn(bulkJobs, "get").mockResolvedValue(jobSummary);
      vi.spyOn(bulkJobs, "reconciliationContext").mockResolvedValue({
        job: durableJob, items: [{ ...reconciliationItem, prestate: { kind: "block", isBlocked: true } }], hasMore: false,
      });
      vi.spyOn(bulkJobs, "withReconciliationLock").mockImplementation(async (_scope, _item, operation) => operation(new AbortController().signal));
      vi.spyOn(bulkJobs, "inventoryGeneration").mockResolvedValue("generation");
      const records = vi.spyOn(bulkJobs, "recordReconciliation").mockResolvedValue(undefined);
      const fetcher = vi.fn<FetchLike>(async () => Response.json({ id: "package", displayName: "Package", isBlocked: true }));
      await expect(reconcileBulkJob("job", scope, bulkJobs, provider(fetcher), async () => "token"))
        .resolves.toMatchObject({ reconciliation: { attempted: 1, failed: 1 } });
      expect(records).not.toHaveBeenCalled();
      expect(fetcher).not.toHaveBeenCalled();
    });

    it.each(["verified_applied", "verified_not_applied", "conflict"] as const)("can still reconcile %s for an old sent intent with an unrepresentable untouched scope", async outcome => {
      const state: PackageMutationState = { ...accessPrestate, deployedTo: "all" };
      vi.spyOn(bulkJobs, "get").mockResolvedValue(jobSummary);
      vi.spyOn(bulkJobs, "reconciliationContext").mockResolvedValue({
        job: { ...durableJob, action: "update-availability",
          access_update: { target: "availability", mode: "replace", scope: "specific", principals: [principal] } },
        items: [{ ...reconciliationItem, prestate: state, prestate_hash: packageMutationStateHash(state) }], hasMore: false,
      });
      vi.spyOn(bulkJobs, "withReconciliationLock").mockImplementation(async (_scope, _item, operation) => operation(new AbortController().signal));
      vi.spyOn(bulkJobs, "inventoryGeneration").mockResolvedValue("generation");
      const records = vi.spyOn(bulkJobs, "recordReconciliation").mockResolvedValue(undefined);
      const fetcher = vi.fn<FetchLike>(async () => Response.json({
        id: "package", displayName: "Package", isBlocked: false, ...state,
        availableTo: outcome === "verified_not_applied" ? "none" : "some",
        allowedUsersAndGroups: outcome === "verified_not_applied" ? [] : [principal],
        deployedTo: outcome === "conflict" ? "none" : "all",
      }));
      await expect(reconcileBulkJob("job", scope, bulkJobs, provider(fetcher), async () => "token"))
        .resolves.toMatchObject({ reconciliation: { attempted: 1, failed: 0 } });
      expect(records).toHaveBeenCalledExactlyOnceWith(scope, "item", outcome, expect.anything(), expect.any(String),
        expect.objectContaining({ inventoryGeneration: "generation" }), expect.any(AbortSignal), expect.any(Function));
      expect(fetcher).toHaveBeenCalledOnce();
      expect(fetcher.mock.calls[0][1]?.method ?? "GET").toBe("GET");
    });

    it("records a conflict rather than verified application when a preserved opaque principal differs only in case", async () => {
      const state: PackageMutationState = {
        ...accessPrestate, deployedTo: "some",
        acquireUsersAndGroups: [{ resourceType: "user", resourceId: "Opaque_User" }],
      };
      vi.spyOn(bulkJobs, "get").mockResolvedValue(jobSummary);
      vi.spyOn(bulkJobs, "reconciliationContext").mockResolvedValue({
        job: { ...durableJob, action: "update-availability",
          access_update: { target: "availability", mode: "replace", scope: "specific", principals: [principal] } },
        items: [{ ...reconciliationItem, prestate: state, prestate_hash: packageMutationStateHash(state) }], hasMore: false,
      });
      vi.spyOn(bulkJobs, "withReconciliationLock").mockImplementation(async (_scope, _item, operation) => operation(new AbortController().signal));
      vi.spyOn(bulkJobs, "inventoryGeneration").mockResolvedValue("generation");
      const records = vi.spyOn(bulkJobs, "recordReconciliation").mockResolvedValue(undefined);
      const fetcher = vi.fn<FetchLike>(async () => Response.json({
        id: "package", displayName: "Package", isBlocked: false, availableTo: "some", deployedTo: "some",
        allowedUsersAndGroups: [principal], acquireUsersAndGroups: [{ resourceType: "user", resourceId: "opaque_user" }],
      }));
      await expect(reconcileBulkJob("job", scope, bulkJobs, provider(fetcher), async () => "token"))
        .resolves.toMatchObject({ reconciliation: { attempted: 1, failed: 0 } });
      expect(records).toHaveBeenCalledExactlyOnceWith(scope, "item", "conflict", expect.anything(), expect.any(String),
        expect.objectContaining({ inventoryGeneration: "generation" }), expect.any(AbortSignal), expect.any(Function));
      expect(fetcher).toHaveBeenCalledOnce();
      expect(fetcher.mock.calls[0][1]?.method ?? "GET").toBe("GET");
    });

    it("does not dispatch or publish when a non-cooperative token exceeds the reconciliation deadline", async () => {
      const deadline = new AbortController();
      vi.spyOn(AbortSignal, "timeout").mockReturnValueOnce(deadline.signal);
      vi.spyOn(bulkJobs, "get").mockResolvedValue(jobSummary);
      vi.spyOn(bulkJobs, "reconciliationContext").mockResolvedValue({ job: durableJob, items: [reconciliationItem], hasMore: false });
      const records = vi.spyOn(bulkJobs, "recordReconciliation");
      const fetcher = vi.fn<FetchLike>();
      const authorize = vi.fn(async () => "token").mockImplementationOnce(() => new Promise<string>(() => undefined));
      const execution = reconcileBulkJob("job", scope, bulkJobs, provider(fetcher), authorize);
      await vi.waitFor(() => expect(authorize).toHaveBeenCalledOnce());
      deadline.abort(new DOMException("Synthetic reconciliation deadline.", "TimeoutError"));
      await expect(execution).resolves.toMatchObject({ reconciliation: { attempted: 1, failed: 1 } });
      expect(fetcher).not.toHaveBeenCalled();
      expect(records).not.toHaveBeenCalled();
    });

    it("preserves initiating capability invalidation over a rejected provider read", async () => {
      const failure = new AppError(401, "authorization_expired", "The initiating capability changed.");
      let current = true;
      vi.spyOn(capabilities, "beginOperationValidation").mockReturnValue(() => { if (!current) throw failure; });
      vi.spyOn(bulkJobs, "get").mockResolvedValue(jobSummary);
      vi.spyOn(bulkJobs, "reconciliationContext").mockResolvedValue({ job: durableJob, items: [reconciliationItem], hasMore: false });
      vi.spyOn(bulkJobs, "withReconciliationLock").mockImplementation(async (_scope, _item, operation) => operation(new AbortController().signal));
      vi.spyOn(bulkJobs, "inventoryGeneration").mockResolvedValue("generation");
      const records = vi.spyOn(bulkJobs, "recordReconciliation");
      const fetcher = vi.fn<FetchLike>(async () => { current = false; throw new Error("Private transport failure."); });
      await expect(reconcileBulkJob("job", scope, bulkJobs, provider(fetcher), async () => "token")).rejects.toBe(failure);
      expect(records).not.toHaveBeenCalled();
      expect(fetcher).toHaveBeenCalledOnce();
    });

    it.each(["authorization", "preflight", "readback", "publication"] as const)(
      "keeps reconciliation unresolved when its elapsed deadline expires during %s with delayed abort delivery", async stage => {
        const startedAt = Date.now();
        let elapsed = 0, authorizations = 0;
        vi.spyOn(Date, "now").mockImplementation(() => startedAt + elapsed);
        vi.spyOn(AbortSignal, "timeout").mockImplementation(() => new AbortController().signal);
        vi.spyOn(bulkJobs, "get").mockResolvedValue(jobSummary);
        vi.spyOn(bulkJobs, "reconciliationContext").mockResolvedValue({ job: durableJob, items: [reconciliationItem], hasMore: false });
        vi.spyOn(bulkJobs, "withReconciliationLock").mockImplementation(async (_scope, _item, operation) => operation(new AbortController().signal));
        vi.spyOn(bulkJobs, "inventoryGeneration").mockImplementation(async () => {
          if (stage === "preflight") elapsed = 30_001;
          return "generation";
        });
        const settlement = vi.spyOn(bulkJobs, "settleInventoryControls");
        const records = vi.spyOn(bulkJobs, "recordReconciliation").mockResolvedValue(undefined);
        const fetcher = vi.fn<FetchLike>(async () => {
          if (stage === "readback") elapsed = 30_001;
          return Response.json({ id: "package", displayName: "Package", isBlocked: true });
        });
        const graph = new GraphPackagesClient(fetcher, { maxAttempts: 1, now: () => elapsed });
        const result = await reconcileBulkJob("job", scope, bulkJobs, graph, async () => {
          authorizations += 1;
          if (authorizations === 1 && stage !== "authorization") elapsed = 15_000;
          if (stage === "authorization" && authorizations === 1 || stage === "publication" && authorizations === 2) elapsed = 30_001;
          return "read-token";
        });
        expect(result).toMatchObject({ reconciliation: { attempted: 1, failed: 1 } });
        expect(records).not.toHaveBeenCalled();
        expect(fetcher).toHaveBeenCalledTimes(["authorization", "preflight"].includes(stage) ? 0 : 1);
        expect(settlement).not.toHaveBeenCalled();
      },
    );

    it.each(["verified_applied", "verified_not_applied", "conflict"] as const)(
      "preserves read-only %s evidence without requiring write authority", async outcome => {
        vi.spyOn(bulkJobs, "get").mockResolvedValue(jobSummary);
        vi.spyOn(bulkJobs, "reconciliationContext").mockResolvedValue({
          job: { ...durableJob, action: "update-availability",
            access_update: { target: "availability", mode: "replace", scope: "specific", principals: [principal] } },
          items: [{ ...reconciliationItem, prestate: accessPrestate, prestate_hash: packageMutationStateHash(accessPrestate) }], hasMore: false,
        });
        vi.spyOn(bulkJobs, "withReconciliationLock").mockImplementation(async (_scope, _item, operation) => operation(new AbortController().signal));
        vi.spyOn(bulkJobs, "inventoryGeneration").mockResolvedValue("generation");
        const records = vi.spyOn(bulkJobs, "recordReconciliation").mockResolvedValue(undefined);
        const authorize = vi.fn<NonNullable<Parameters<typeof reconcileBulkJob>[4]>>(async () => "read-token");
        const fetcher = vi.fn<FetchLike>(async () => Response.json({
          id: "package", displayName: "Package", isBlocked: false,
          availableTo: outcome === "verified_not_applied" ? "none" : "some", deployedTo: "none",
          allowedUsersAndGroups: outcome === "verified_not_applied" ? [] : [outcome === "verified_applied" ? principal
            : { resourceType: "user", resourceId: "33333333-3333-4333-8333-333333333333" }],
          acquireUsersAndGroups: [],
        }));

        expect(await reconcileBulkJob("job", scope, bulkJobs, provider(fetcher), authorize))
          .toMatchObject({ id: "job", reconciliation: { attempted: 1, failed: 0, errors: [] } });
        expect(records).toHaveBeenCalledWith(scope, "item", outcome, expect.anything(), expect.any(String),
          expect.objectContaining({ inventoryGeneration: "generation", details: expect.objectContaining({ id: "package" }) }), expect.any(AbortSignal), expect.any(Function));
        expect(authorize).toHaveBeenCalledTimes(3);
        expect(authorize.mock.calls.every(([, capability]) => capability === "graph.package.read.delegated")).toBe(true);
        expect(fetcher).toHaveBeenCalledOnce();
        expect(fetcher.mock.calls[0][1]?.method ?? "GET").toBe("GET");
      },
    );

    it("returns not found rather than a success-shaped partial response when the receipt expires", async () => {
      vi.spyOn(bulkJobs, "get").mockResolvedValueOnce(jobSummary).mockResolvedValueOnce(undefined);
      vi.spyOn(bulkJobs, "reconciliationContext").mockResolvedValue({ job: durableJob, items: [], hasMore: false });
      const fetcher = vi.fn<FetchLike>();

      await expect(reconcileBulkJob("job", scope, bulkJobs, provider(fetcher), async () => "token"))
        .rejects.toMatchObject({ code: "not_found" });
      expect(fetcher).not.toHaveBeenCalled();
    });

    it.each(["verified_applied", "verified_not_applied", "conflict"] as const)(
      "propagates cleanup failure after committing %s instead of reporting a failed read with no publication", async outcome => {
        const failure = new Error("Synthetic reconciliation lock cleanup failure.");
        vi.spyOn(bulkJobs, "get").mockResolvedValue(jobSummary);
        vi.spyOn(bulkJobs, "reconciliationContext").mockResolvedValue({
          job: { ...durableJob, action: "update-availability",
            access_update: { target: "availability", mode: "replace", scope: "specific", principals: [principal] } },
          items: [{ ...reconciliationItem, prestate: accessPrestate, prestate_hash: packageMutationStateHash(accessPrestate) }], hasMore: false,
        });
        vi.spyOn(bulkJobs, "withReconciliationLock").mockImplementation(async (_scope, _item, operation) => {
          await operation(new AbortController().signal);
          throw failure;
        });
        vi.spyOn(bulkJobs, "inventoryGeneration").mockResolvedValue("generation");
        const records = vi.spyOn(bulkJobs, "recordReconciliation").mockResolvedValue(undefined);
        const fetcher = vi.fn<FetchLike>(async () => Response.json({
          id: "package", displayName: "Package", isBlocked: false, deployedTo: "none", acquireUsersAndGroups: [],
          availableTo: outcome === "verified_not_applied" ? "none" : "some",
          allowedUsersAndGroups: outcome === "verified_not_applied" ? [] : [outcome === "verified_applied" ? principal
            : { resourceType: "user", resourceId: "33333333-3333-4333-8333-333333333333" }],
        }));

        await expect(reconcileBulkJob("job", scope, bulkJobs, provider(fetcher), async () => "read-token")).rejects.toBe(failure);
        expect(records).toHaveBeenCalledExactlyOnceWith(scope, "item", outcome, expect.anything(), expect.any(String),
          expect.objectContaining({ inventoryGeneration: "generation" }), expect.any(AbortSignal), expect.any(Function));
        expect(fetcher).toHaveBeenCalledOnce();
        expect(fetcher.mock.calls[0][1]?.method ?? "GET").toBe("GET");
      },
    );

    it.each(["lock", "readback", "publication"] as const)(
      "keeps reconciliation unresolved when its target lock is lost during %s", async stage => {
        const controller = new AbortController();
        const loseLock = () => controller.abort(new AppError(409, "package_lock_lost", "Synthetic target-lock loss."));
        vi.spyOn(bulkJobs, "get").mockResolvedValue(jobSummary);
        vi.spyOn(bulkJobs, "reconciliationContext").mockResolvedValue({ job: durableJob, items: [reconciliationItem], hasMore: false });
        vi.spyOn(bulkJobs, "withReconciliationLock").mockImplementation(async (_scope, _item, operation) => {
          if (stage === "lock") loseLock();
          return operation(controller.signal);
        });
        vi.spyOn(bulkJobs, "inventoryGeneration").mockResolvedValue("generation");
        const records = vi.spyOn(bulkJobs, "recordReconciliation").mockResolvedValue(undefined);
        let authorizations = 0;
        const authorize = vi.fn<NonNullable<Parameters<typeof reconcileBulkJob>[4]>>(async () => {
          if (++authorizations === 2 && stage === "publication") loseLock();
          return "read-token";
        });
        const fetcher = vi.fn<FetchLike>(async () => {
          if (stage === "readback") loseLock();
          return Response.json({ id: "package", displayName: "Package", isBlocked: true });
        });

        expect(await reconcileBulkJob("job", scope, bulkJobs, provider(fetcher), authorize))
          .toMatchObject({ reconciliation: { attempted: 1, failed: 1 } });
        expect(records).not.toHaveBeenCalled();
        expect(fetcher).toHaveBeenCalledTimes(stage === "lock" ? 0 : 1);
        expect(authorize.mock.calls.every(([, capability]) => capability === "graph.package.read.delegated")).toBe(true);
      },
    );

    it.each(["lookup", "authorization", "readback", "next-item", "response"] as const)(
      "keeps reconciliation bound to its original session during %s", async stage => {
        const replaceSession = async () => {
          await revokeAccountSessionMutations(scope.tenantId, scope.principalId, async () => undefined);
          await activateAccountSession(scope.tenantId, scope.principalId, async () => undefined);
        };
        let loads = 0;
        vi.spyOn(bulkJobs, "get").mockImplementation(async () => {
          loads += 1;
          if (stage === "lookup" && loads === 1 || stage === "response" && loads === 2) await replaceSession();
          return jobSummary;
        });
        vi.spyOn(bulkJobs, "reconciliationContext").mockResolvedValue({
          job: durableJob, items: stage === "next-item" ? [reconciliationItem, { ...reconciliationItem, id: "second", target_id: "second-package" }] : [reconciliationItem],
          hasMore: false,
        });
        vi.spyOn(bulkJobs, "withReconciliationLock").mockImplementation(async (_scope, _item, operation) => operation(new AbortController().signal));
        vi.spyOn(bulkJobs, "inventoryGeneration").mockResolvedValue("generation");
        let replacement: Promise<void> | undefined;
        const records = vi.spyOn(bulkJobs, "recordReconciliation").mockImplementation(async () => {
          if (stage === "next-item") replacement = replaceSession();
        });
        let authorizations = 0;
        const authorize = vi.fn(async () => {
          authorizations += 1;
          if (stage === "authorization" && authorizations === 1) await replaceSession();
          return "token";
        });
        const fetcher = vi.fn<FetchLike>(async url => {
          if (stage === "readback") await replaceSession();
          return Response.json({ id: new URL(url).pathname.split("/").at(-1), displayName: "Package", isBlocked: true });
        });

        await expect(reconcileBulkJob("job", scope, bulkJobs, provider(fetcher), authorize))
          .rejects.toMatchObject({ code: "unauthorized" });
        await replacement;

        expect(records).toHaveBeenCalledTimes(["next-item", "response"].includes(stage) ? 1 : 0);
        expect(fetcher).toHaveBeenCalledTimes(["lookup", "authorization"].includes(stage) ? 0 : 1);
        expect(fetcher.mock.calls.every(([, request]) => !request?.method || request.method === "GET")).toBe(true);
      },
    );
  });

  it("waits for verified control publication before releasing the completed job", async () => {
    const repository = fakeRepository();
    let publish!: () => void;
    repository.finishItem.mockImplementationOnce(() => new Promise<void>(resolve => { publish = resolve; }));
    let blocked = false;
    const fetcher = vi.fn<FetchLike>(async (_url, request) => {
      if (request?.method === "POST") { blocked = true; return new Response(null, { status: 204 }); }
      return Response.json({ id: "package", displayName: "Package", isBlocked: blocked });
    });
    const execution = runBulkJob("job", scope, false, repository, provider(fetcher), async () => "token");
    await vi.waitFor(() => expect(repository.finishItem).toHaveBeenCalledOnce());
    expect(repository.finishItem).toHaveBeenCalledWith(expect.anything(), "item", "succeeded",
      expect.anything(), expect.any(AbortSignal), expect.any(Function));
    expect(repository.release).not.toHaveBeenCalled();
    publish();
    await execution;
    expect(repository.release).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls.filter(([, request]) => request?.method === "POST")).toHaveLength(1);
  });

  it("records an inconclusive outcome when verified publication fails without replaying the write", async () => {
    const repository = fakeRepository();
    const failure = new Error("Saved inventory publication failed.");
    repository.finishItem.mockRejectedValueOnce(failure).mockResolvedValueOnce(undefined);
    let blocked = false;
    const fetcher = vi.fn<FetchLike>(async (_url, request) => {
      if (request?.method === "POST") { blocked = true; return new Response(null, { status: 204 }); }
      return Response.json({ id: "package", displayName: "Package", isBlocked: blocked });
    });
    await expect(runBulkJob("job", scope, false, repository, provider(fetcher), async () => "token")).resolves.toBeUndefined();
    expect(repository.finishItem).toHaveBeenCalledTimes(2);
    expect(repository.finishItem).toHaveBeenNthCalledWith(1, expect.anything(), "item", "succeeded",
      expect.anything(), expect.any(AbortSignal), expect.any(Function));
    expect(repository.finishItem).toHaveBeenNthCalledWith(2, expect.anything(), "item", "inconclusive",
      expect.objectContaining({ errorCode: "provider_error" }));
    expect(repository.release).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls.filter(([, request]) => request?.method === "POST")).toHaveLength(1);
  });

  it.each((["block", "update-availability", "update-installation"] as const).flatMap(action =>
    (["pre-read", "dispatch", "readback"] as const).map(stage => ({ action, stage })) ))(
    "fences a superseded session during $action $stage even when the same account signs in again",
    async ({ action, stage }) => {
      const repository = fakeRepository(action === "block" ? prestate : accessPrestate, action);
      let replaced: Promise<unknown> | undefined;
      const replaceSession = () => {
        replaced = Promise.all([
          revokeAccountSessionMutations(scope.tenantId, scope.principalId, async () => undefined),
          activateAccountSession(scope.tenantId, scope.principalId, async () => undefined),
        ]);
      };
      if (stage === "dispatch") repository.markSent.mockImplementation(async () => { replaceSession(); });
      let blocked = false;
      const fetcher = vi.fn<FetchLike>(async (_url, request) => {
        if (request?.method === "POST" || request?.method === "PATCH") { blocked = true; return new Response(null, { status: 204 }); }
        if (!replaced && (stage === "pre-read" || stage === "readback" && blocked)) {
          replaceSession();
          await replaced;
        }
        return Response.json({
          id: "package", displayName: "Package", isBlocked: blocked,
          availableTo: blocked && action === "update-availability" ? "some" : "none",
          deployedTo: blocked && action === "update-installation" ? "some" : "none",
          allowedUsersAndGroups: blocked && action === "update-availability" ? [principal] : [],
          acquireUsersAndGroups: blocked && action === "update-installation" ? [principal] : [],
        });
      });

      await runBulkJob("job", scope, false, repository, provider(fetcher), async () => "token");
      await replaced;

      expect(fetcher.mock.calls.filter(([, request]) => request?.method === "POST" || request?.method === "PATCH"))
        .toHaveLength(stage === "readback" ? 1 : 0);
      if (stage === "pre-read") {
        expect(repository.markSent).not.toHaveBeenCalled();
        expect(repository.pauseItemForAuthorization).toHaveBeenCalledOnce();
        expect(repository.finishItem).not.toHaveBeenCalled();
      } else {
        expect(repository.finishItem).toHaveBeenCalledWith(expect.anything(), "item", "inconclusive", expect.anything());
      }
    },
  );

  it.each((["block", "unblock", "update-availability", "update-installation", "skipped"] as const).flatMap(operation =>
    [false, true].map(cleanupFailure => ({ operation, cleanupFailure }))))(
    "preserves verified $operation behavior with cleanupFailure=$cleanupFailure and uses only the final dispatch token for a write", async ({ operation, cleanupFailure }) => {
      const action = operation === "skipped" ? "block" : operation;
      const initialBlocked = operation === "unblock" || operation === "skipped";
      const state: PackageMutationState = action.startsWith("update-")
        ? accessPrestate : { kind: "block", isBlocked: initialBlocked };
      const repository = fakeRepository(state, action);
      const cleanupError = new Error("Synthetic target-lock cleanup failure.");
      if (cleanupFailure) vi.spyOn(repository, "withTargetLock").mockImplementation(async (_lease, _item, execute) => {
        await execute(new AbortController().signal);
        throw cleanupError;
      });
      let details = {
        id: "package", displayName: "Package", isBlocked: initialBlocked,
        availableTo: "none", deployedTo: "none",
        allowedUsersAndGroups: [] as typeof principal[], acquireUsersAndGroups: [] as typeof principal[],
      };
      const fetcher = vi.fn<FetchLike>(async (_url, request) => {
        if (request?.method === "POST") {
          details = { ...details, isBlocked: action === "block" };
          return new Response(null, { status: 204 });
        }
        if (request?.method === "PATCH") {
          const availability = action === "update-availability";
          expect(JSON.parse(String(request.body))).toEqual({
            allowedUsersAndGroups: availability ? [principal] : [],
            acquireUsersAndGroups: availability ? [] : [principal],
          });
          details = { ...details, availableTo: availability ? "some" : "none", deployedTo: availability ? "none" : "some",
            allowedUsersAndGroups: availability ? [principal] : [], acquireUsersAndGroups: availability ? [] : [principal] };
          return new Response(null, { status: 204 });
        }
        return Response.json(details);
      });
      let authorizations = 0;

      const execution = runBulkJob("job", scope, false, repository, provider(fetcher), async () => `token-${++authorizations}`);
      if (cleanupFailure) await expect(execution).rejects.toBe(cleanupError);
      else await execution;

      const writes = fetcher.mock.calls.filter(([, request]) => request?.method === "POST" || request?.method === "PATCH");
      expect(writes).toHaveLength(operation === "skipped" ? 0 : 1);
      if (writes[0]) expect(new Headers(writes[0][1]?.headers).get("Authorization")).toBe("Bearer token-3");
      expect(repository.finishItem).toHaveBeenCalledWith(expect.anything(), "item",
        operation === "skipped" ? "skipped" : "succeeded", expect.objectContaining({
          readback: expect.objectContaining(details), readbackCount: 1, inventoryGeneration: "generation",
        }), expect.any(AbortSignal), expect.any(Function));
      expect(repository.finishItem).toHaveBeenCalledOnce();
      expect(repository.release).toHaveBeenCalledOnce();
    },
  );

  it.each((["block", "update-availability", "update-installation"] as const).flatMap(action =>
    (["pre-read", "immediate-read", "marker", "write", "readback", "publication"] as const).map(stage => ({ action, stage }))))(
    "stops $action dispatch or verified publication after target-lock loss during $stage", async ({ action, stage }) => {
      const repository = fakeRepository(action === "block" ? prestate : accessPrestate, action);
      const controller = new AbortController();
      const failure = new AppError(409, "package_lock_lost", "Synthetic target-lock loss.");
      vi.spyOn(repository, "withTargetLock").mockImplementation((_lease, _item, execute) => execute(controller.signal));
      if (stage === "marker") repository.markSent.mockImplementation(async () => { controller.abort(failure); });
      let reads = 0, written = false, authorizations = 0;
      const fetcher = vi.fn<FetchLike>(async (_url, request) => {
        if (request?.method === "POST" || request?.method === "PATCH") {
          written = true;
          if (stage === "write") controller.abort(failure);
          return new Response(null, { status: 204 });
        }
        reads += 1;
        if (stage === "pre-read" && reads === 1 || stage === "immediate-read" && reads === 2
          || stage === "readback" && written) controller.abort(failure);
        return Response.json({
          id: "package", displayName: "Package", isBlocked: written,
          availableTo: written && action === "update-availability" ? "some" : "none",
          deployedTo: written && action === "update-installation" ? "some" : "none",
          allowedUsersAndGroups: written && action === "update-availability" ? [principal] : [],
          acquireUsersAndGroups: written && action === "update-installation" ? [principal] : [],
        });
      });

      await runBulkJob("job", scope, false, repository, provider(fetcher), async () => {
        authorizations += 1;
        if (stage === "publication" && authorizations === 4) controller.abort(failure);
        return "token";
      });

      const sent = !["pre-read", "immediate-read"].includes(stage);
      expect(repository.markSent).toHaveBeenCalledTimes(sent ? 1 : 0);
      expect(fetcher.mock.calls.filter(([, request]) => request?.method === "POST" || request?.method === "PATCH"))
        .toHaveLength(["write", "readback", "publication"].includes(stage) ? 1 : 0);
      expect(repository.finishItem).toHaveBeenCalledExactlyOnceWith(expect.anything(), "item", sent ? "inconclusive" : "failed",
        expect.objectContaining({ errorCode: "package_lock_lost" }));
      expect(repository.release).toHaveBeenCalledOnce();
    },
  );

  it("does not publish a skipped readback after losing its target lock during authorization", async () => {
    const repository = fakeRepository({ kind: "block", isBlocked: true });
    const controller = new AbortController();
    vi.spyOn(repository, "withTargetLock").mockImplementation((_lease, _item, execute) => execute(controller.signal));
    let authorizations = 0;
    const fetcher = vi.fn<FetchLike>(async () => Response.json({ id: "package", displayName: "Package", isBlocked: true }));

    await runBulkJob("job", scope, false, repository, provider(fetcher), async () => {
      if (++authorizations === 3) controller.abort(new AppError(409, "package_lock_lost", "Synthetic target-lock loss."));
      return "token";
    });

    expect(repository.markSent).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledOnce();
    expect(repository.finishItem).toHaveBeenCalledExactlyOnceWith(expect.anything(), "item", "failed",
      expect.objectContaining({ errorCode: "package_lock_lost" }));
  });

  it("retains lock loss over a late authorization denial rather than requeueing the interrupted item", async () => {
    const repository = fakeRepository(), controller = new AbortController();
    vi.spyOn(repository, "withTargetLock").mockImplementation((_lease, _item, execute) => execute(controller.signal));
    const fetcher = vi.fn<FetchLike>(async () => Response.json({ id: "package", displayName: "Package", isBlocked: false }));
    let authorizations = 0;

    await runBulkJob("job", scope, false, repository, provider(fetcher), async () => {
      if (++authorizations === 3) {
        controller.abort(new AppError(409, "package_lock_lost", "Synthetic target-lock loss."));
        throw new AppError(401, "interaction_required", "Synthetic late authorization denial.");
      }
      return "token";
    });

    expect(repository.pauseItemForAuthorization).not.toHaveBeenCalled();
    expect(repository.finishItem).toHaveBeenCalledExactlyOnceWith(expect.anything(), "item", "failed",
      expect.objectContaining({ errorCode: "package_lock_lost" }));
    expect(repository.markSent).not.toHaveBeenCalled();
  });

  it("stops admitting items after interruption and preserves its cause over a late authorization error", async () => {
    const repository = fakeRepository();
    const controller = new AbortController();
    const stopped = new AppError(503, "shutdown", "Application shutdown stopped package work.");
    const authorize = vi.fn(async () => "token");
    authorize.mockImplementationOnce(async () => "token").mockImplementationOnce(async () => "token")
      .mockImplementationOnce(async () => {
        controller.abort(stopped);
        throw new Error("Late authorization transport failure.");
      });
    const fetcher = vi.fn<FetchLike>(async () => Response.json({ id: "package", displayName: "Package", isBlocked: false }));

    await runBulkJob("job", scope, false, repository, provider(fetcher), authorize, controller.signal);

    expect(repository.beginItem).toHaveBeenCalledOnce();
    expect(repository.finishItem).toHaveBeenCalledWith(
      expect.anything(), "item", "cancelled", expect.objectContaining({ errorCode: "shutdown" }),
    );
    expect(authorize).toHaveBeenCalledTimes(3);
    expect(repository.markSent).not.toHaveBeenCalled();
  });

  it("reports a tracked persistence failure to shutdown instead of treating its log as a successful drain", async () => {
    const failure = new Error("Outcome storage failed.");
    let rejectRead!: (error: Error) => void;
    vi.spyOn(bulkJobs, "get").mockImplementation(() => new Promise((_resolve, reject) => { rejectRead = reject; }));
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    launchBulkJob("job", scope);
    const drained = drainBulkJobs();
    rejectRead(failure);

    await expect(drained).rejects.toBe(failure);
  });

  it("propagates a failed cancellation outcome commit while draining an active item", async () => {
    const repository = fakeRepository();
    const failure = new Error("Outcome storage failed.");
    repository.finishItem.mockRejectedValue(failure);
    let finishRead!: (value: Response) => void;
    const fetcher = vi.fn<FetchLike>(() => new Promise(resolve => { finishRead = resolve; }));
    const execution = runTrackedBulkJob("job", scope, repository, provider(fetcher), async () => "token");
    const completed = expect(execution).rejects.toBe(failure);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());

    const drained = drainBulkJobs();
    finishRead(Response.json({ id: "package", displayName: "Package", isBlocked: false }));

    await expect(drained).rejects.toBe(failure);
    await completed;
    expect(repository.finishItem).toHaveBeenCalledWith(expect.anything(), "item", "cancelled", expect.anything());
  });

  it("drains an interrupted authorization once its waiting state is safely persisted", async () => {
    vi.spyOn(bulkJobs, "get").mockResolvedValue(jobSummary);
    vi.spyOn(bulkJobs, "waitForAuthorization").mockResolvedValue(undefined);
    const claim = vi.spyOn(bulkJobs, "claim");
    let releaseAuthorization!: (token: string) => void;
    const authorize = vi.fn(() => new Promise<string>(resolve => { releaseAuthorization = resolve; }));
    const execution = runTrackedBulkJob("job", scope, bulkJobs, provider(vi.fn()), authorize);
    await vi.waitFor(() => expect(authorize).toHaveBeenCalledOnce());

    const drained = drainBulkJobs();
    await expect(drained).resolves.toBeUndefined();
    await execution;
    releaseAuthorization("token");
    expect(bulkJobs.waitForAuthorization).toHaveBeenCalledOnce();
    expect(claim).not.toHaveBeenCalled();
  });

  it("persists authorization wait when shutdown closes admissions during the initial saved read", async () => {
    let finishRead!: (value: JobSummary) => void;
    vi.spyOn(bulkJobs, "get").mockImplementation(() => new Promise(resolve => { finishRead = resolve; }));
    vi.spyOn(bulkJobs, "waitForAuthorization").mockResolvedValue(undefined);
    const claim = vi.spyOn(bulkJobs, "claim");
    launchBulkJob("job", scope);

    const drained = drainBulkJobs();
    vi.mocked(requireProviderAdmissions).mockImplementation(() => {
      throw new AppError(503, "maintenance", "Maintenance is active.");
    });
    finishRead(jobSummary);

    await expect(drained).resolves.toBeUndefined();
    expect(bulkJobs.waitForAuthorization).toHaveBeenCalledOnce();
    expect(claim).not.toHaveBeenCalled();
  });

  it("does not consume another worker slot for an already admitted same-principal queued retry", async () => {
    let finishRead!: (value: JobSummary) => void;
    const read = new Promise<JobSummary>(resolve => { finishRead = resolve; });
    vi.spyOn(bulkJobs, "get").mockReturnValue(read);
    vi.spyOn(bulkJobs, "waitForAuthorization").mockResolvedValue(undefined);

    try {
      launchBulkJob("ABCDEFAB-1234-4234-8234-123456789ABC", scope);
      launchBulkJob("abcdefab-1234-4234-8234-123456789abc", scope);
      expect(bulkJobs.get).toHaveBeenCalledOnce();
      expect(() => requireWorkerCapacity()).not.toThrow();
    } finally {
      const drained = drainBulkJobs();
      finishRead(jobSummary);
      await drained;
    }
  });

  it("pauses unsent work when provider admission closes during the pre-read", async () => {
    let admitted = true;
    vi.mocked(requireProviderAdmissions).mockImplementation(() => {
      if (!admitted) throw new AppError(503, "maintenance", "Provider work is disabled.");
    });
    const repository = fakeRepository();
    const fetcher = vi.fn<FetchLike>(async () => {
      admitted = false;
      return Response.json({ id: "package", displayName: "Package", isBlocked: false });
    });

    await runBulkJob("job", scope, false, repository, provider(fetcher), async () => "token");

    expect(repository.pauseItemForAuthorization).toHaveBeenCalledWith(expect.anything(), "item");
    expect(repository.markSent).not.toHaveBeenCalled();
    expect(repository.finishItem).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("keeps a sent write inconclusive when admission closes before readback", async () => {
    let admitted = true;
    vi.mocked(requireProviderAdmissions).mockImplementation(() => {
      if (!admitted) throw new AppError(503, "maintenance", "Provider work is disabled.");
    });
    const repository = fakeRepository();
    const fetcher = vi.fn<FetchLike>(async (_url, request) => {
      if (request?.method === "POST") {
        admitted = false;
        return new Response(null, { status: 204 });
      }
      return Response.json({ id: "package", displayName: "Package", isBlocked: false });
    });

    await runBulkJob("job", scope, false, repository, provider(fetcher), async () => "token");

    expect(repository.markSent).toHaveBeenCalledOnce();
    expect(repository.finishItem).toHaveBeenCalledWith(
      expect.anything(),
      "item",
      "inconclusive",
      expect.objectContaining({ errorCode: "maintenance" }),
    );
    expect(fetcher.mock.calls.filter(([, request]) => request?.method === "POST")).toHaveLength(1);
  });

  it("records a controlled shutdown before dispatch as cancellation", async () => {
    vi.mocked(requireProviderAdmissions).mockImplementation(() => undefined);
    const repository = fakeRepository();
    const controller = new AbortController();
    const stopped = new AppError(503, "shutdown", "Application shutdown stopped package work.");
    const fetcher = vi.fn<FetchLike>(async () => {
      controller.abort(stopped);
      return Response.json({ id: "package", displayName: "Package", isBlocked: false });
    });

    await runBulkJob("job", scope, false, repository, provider(fetcher), async () => "token", controller.signal);

    expect(repository.markSent).not.toHaveBeenCalled();
    expect(repository.finishItem).toHaveBeenCalledWith(
      expect.anything(),
      "item",
      "cancelled",
      expect.objectContaining({ errorCode: "shutdown" }),
    );
  });

  it("persists the bounded item deadline as a provider timeout", async () => {
    vi.mocked(requireProviderAdmissions).mockImplementation(() => undefined);
    const repository = fakeRepository();
    const fetcher = vi.fn<FetchLike>(async () => {
      throw new DOMException("The item execution deadline expired.", "TimeoutError");
    });

    await runBulkJob("job", scope, false, repository, provider(fetcher), async () => "token");

    expect(repository.finishItem).toHaveBeenCalledWith(
      expect.anything(),
      "item",
      "failed",
      expect.objectContaining({ errorCode: "provider_timeout" }),
    );
    expect(repository.pauseItemForAuthorization).not.toHaveBeenCalled();
  });

  it.each((["authorization-start", "authorization-return", "settled"] as const).flatMap(stage =>
    [false, true].map(delayedWallClock => ({ stage, delayedWallClock }))))(
    "fences control preflight at $stage despite delayed abort delivery (delayed wall clock: $delayedWallClock)", async ({ stage, delayedWallClock }) => {
      const repository = fakeRepository(), startedAt = Date.now();
      let elapsed = 0, publications = 0, authorizations = 0;
      vi.spyOn(Date, "now").mockImplementation(() => startedAt + (delayedWallClock ? 0 : elapsed));
      vi.spyOn(performance, "now").mockImplementation(() => elapsed);
      vi.spyOn(AbortSignal, "timeout").mockImplementation(() => new AbortController().signal);
      const lock = vi.spyOn(repository, "withTargetLock");
      repository.settleInventoryControls.mockImplementation(async (_lease, _itemId, signal, authorize) => {
        expect(signal.aborted).toBe(false);
        elapsed = stage === "authorization-start" ? 90_001 : 65_000;
        if (stage !== "settled") {
          await authorize();
          publications += 1;
        }
        elapsed = 90_001;
      });
      const fetcher = vi.fn<FetchLike>();
      const authorize = vi.fn(async () => {
        if (++authorizations === 3 && stage === "authorization-return") elapsed = 90_001;
        return "token";
      });

      await runBulkJob("job", scope, false, repository, provider(fetcher), authorize);

      expect(publications).toBe(0);
      expect(lock).not.toHaveBeenCalled();
      expect(fetcher).not.toHaveBeenCalled();
      expect(repository.markSent).not.toHaveBeenCalled();
      expect(repository.finishItem).toHaveBeenCalledExactlyOnceWith(expect.anything(), "item", "failed",
        expect.objectContaining({ errorCode: "provider_timeout" }));
      expect(repository.pauseItemForAuthorization).not.toHaveBeenCalled();
      expect(repository.release).toHaveBeenCalledOnce();
    },
  );

  it("allows in-budget control settlement followed by exactly one verified provider write", async () => {
    const repository = fakeRepository(), startedAt = Date.now();
    let elapsed = 0, written = false, publications = 0;
    vi.spyOn(Date, "now").mockImplementation(() => startedAt + elapsed);
    vi.spyOn(performance, "now").mockImplementation(() => elapsed);
    vi.spyOn(AbortSignal, "timeout").mockImplementation(() => new AbortController().signal);
    repository.settleInventoryControls.mockImplementation(async (_lease, _itemId, _signal, authorize, assertCurrent) => {
      elapsed = 65_000;
      await authorize();
      elapsed = 75_000;
      assertCurrent?.();
      publications += 1;
    });
    const fetcher = vi.fn<FetchLike>(async (_url, request) => {
      if (request?.method === "POST") { written = true; return new Response(null, { status: 204 }); }
      return Response.json({ id: "package", displayName: "Package", isBlocked: written });
    });

    await runBulkJob("job", scope, false, repository, new GraphPackagesClient(fetcher, { maxAttempts: 1, now: () => elapsed }), async () => "token");

    expect(publications).toBe(2);
    expect(repository.markSent).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls.filter(([, request]) => request?.method === "POST")).toHaveLength(1);
    expect(repository.finishItem).toHaveBeenCalledExactlyOnceWith(expect.anything(), "item", "succeeded",
      expect.objectContaining({ readback: expect.objectContaining({ isBlocked: true }) }), expect.any(AbortSignal), expect.any(Function));
  });

  it.each(["session", "capability", "provider"] as const)(
    "does not publish control preflight after its initiating %s authority changes", async cause => {
      const repository = fakeRepository(), fetcher = vi.fn<FetchLike>();
      let current = true, publications = 0;
      vi.spyOn(capabilities, "beginOperationValidation").mockReturnValue(() => {
        if (!current) throw new AppError(401, "authorization_expired", "Synthetic capability change.");
      });
      repository.settleInventoryControls.mockImplementation(async (_lease, _itemId, _signal, authorize, assertCurrent) => {
        await authorize();
        if (cause === "session") {
          await revokeAccountSessionMutations(scope.tenantId, scope.principalId, async () => undefined);
          await activateAccountSession(scope.tenantId, scope.principalId, async () => undefined);
        } else if (cause === "capability") current = false;
        else vi.mocked(requireProviderAdmissions).mockImplementation(() => {
          throw new AppError(503, "maintenance", "Synthetic provider admission closure.");
        });
        assertCurrent?.();
        publications += 1;
      });

      await runBulkJob("job", scope, false, repository, provider(fetcher), async () => "token");

      expect(publications).toBe(0);
      expect(fetcher).not.toHaveBeenCalled();
      expect(repository.markSent).not.toHaveBeenCalled();
      expect(repository.finishItem).not.toHaveBeenCalled();
      expect(repository.pauseItemForAuthorization).toHaveBeenCalledOnce();
      expect(repository.release).toHaveBeenCalledOnce();
    },
  );

  it.each([
    ...(["block", "update-availability"] as const).flatMap(action =>
      (["pre-read", "authorization", "marker", "readback", "publication"] as const).map(stage => ({ action, stage, delayedWallClock: false }))),
    ...(["block", "update-availability"] as const).map(action => ({ action, stage: "authorization" as const, delayedWallClock: true })),
  ])(
    "enforces the elapsed $action item deadline during $stage with delayed abort delivery (delayed wall clock: $delayedWallClock)", async ({ action, stage, delayedWallClock }) => {
      const repository = fakeRepository(action === "block" ? prestate : accessPrestate, action);
      const startedAt = Date.now();
      let elapsed = 0, written = false, authorizations = 0;
      vi.spyOn(Date, "now").mockImplementation(() => startedAt + (delayedWallClock ? 0 : elapsed));
      if (delayedWallClock) vi.spyOn(performance, "now").mockImplementation(() => elapsed);
      vi.spyOn(AbortSignal, "timeout").mockImplementation(() => new AbortController().signal);
      repository.settleInventoryControls.mockImplementation(async () => { elapsed = 65_000; });
      if (stage === "marker") repository.markSent.mockImplementation(async () => { elapsed = 90_001; });
      const fetcher = vi.fn<FetchLike>(async (_url, request) => {
        if (request?.method === "POST" || request?.method === "PATCH") {
          written = true;
          return new Response(null, { status: 204 });
        }
        if (stage === "pre-read" || stage === "readback" && written) elapsed = 90_001;
        return Response.json({
          id: "package", displayName: "Package", isBlocked: written,
          availableTo: written && action === "update-availability" ? "some" : "none",
          deployedTo: "none", allowedUsersAndGroups: written && action === "update-availability" ? [principal] : [],
          acquireUsersAndGroups: [],
        });
      });
      const graph = new GraphPackagesClient(fetcher, { maxAttempts: 1, now: () => elapsed });
      await runBulkJob("job", scope, false, repository, graph, async () => {
        authorizations += 1;
        if (stage === "authorization" && authorizations === 3 || stage === "publication" && authorizations === 4) elapsed = 90_001;
        return "token";
      });
      const sent = ["marker", "readback", "publication"].includes(stage);
      expect(repository.markSent).toHaveBeenCalledTimes(sent ? 1 : 0);
      expect(fetcher.mock.calls.filter(([, request]) => request?.method === "POST" || request?.method === "PATCH"))
        .toHaveLength(["readback", "publication"].includes(stage) ? 1 : 0);
      expect(repository.finishItem).toHaveBeenCalledExactlyOnceWith(expect.anything(), "item", sent ? "inconclusive" : "failed",
        expect.objectContaining({ errorCode: "provider_timeout" }));
      expect(repository.pauseItemForAuthorization).not.toHaveBeenCalled();
      expect(repository.release).toHaveBeenCalledOnce();
    },
  );
});
