import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "../errors.js";
import { packageMutationStateHash, type PackageMutationState } from "./packageMutationState.js";
import { activateAccountSession, revokeAccountSessionMutations } from "../db/sessions.js";
import type { JobItem, JobRepository, JobRow, Lease } from "../db/jobs.js";

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
});
afterEach(() => vi.restoreAllMocks());

const scope = { tenantId: "tenant", principalId: "principal" };
const prestate = { kind: "block" as const, isBlocked: false };
type JobSummary = NonNullable<Awaited<ReturnType<JobRepository["get"]>>>;
const jobSummary: JobSummary = {
  id: "job", tokenMode: "delegated", capabilityId: "graph.package.block.manage",
  status: "queued", action: "block", targetBlockedState: true,
  confirmationHash: null, confirmation: null, confirmedAt: null, total: 1, completed: 0,
  succeeded: 0, failed: 0, skipped: 0, inconclusive: 0, cancelled: 0, results: [], result: undefined,
  currentAgentName: undefined, createdAt: "2026-09-24T12:00:00.000Z", updatedAt: "2026-09-24T12:00:00.000Z", canResume: false,
};
const durableJob: JobRow = {
  id: "job", tenant_id: scope.tenantId, principal_id: scope.principalId, token_mode: "delegated",
  capability: "graph.package.block.manage", action: "block", access_update: null, reassign_user_id: null,
  request_hash: "hash", confirmation_hash: "hash", confirmation_summary: null, confirmed_at: null,
  status: "partial", scope: "bulk", actor_username: "operator@example.invalid", actor_name: "Operator",
  request_path: "/agents/block", cancel_requested: false, lease_owner: null, lease_version: 1, lease_until: null,
  attempts: 1, created_at: new Date("2026-09-24T12:00:00Z"), updated_at: new Date("2026-09-24T12:00:00Z"),
};
const durableItem: JobItem = {
  id: "item", job_id: durableJob.id, target_id: "package", display_name: "Package", ordinal: 0,
  status: "inconclusive", sent_at: new Date("2026-09-24T12:00:00Z"), message: null, error_code: null,
  prestate, prestate_hash: packageMutationStateHash(prestate), poststate: null, poststate_hash: null,
  correlation_id: "11111111-1111-4111-8111-111111111111", reconciliation_status: "required", reconciled_at: null,
};
const principal = { resourceType: "user", resourceId: "22222222-2222-4222-8222-222222222222" };
const accessPrestate: PackageMutationState = {
  kind: "access", availableTo: "none", deployedTo: "none", allowedUsersAndGroups: [], acquireUsersAndGroups: [],
};

function fakeRepository(state: PackageMutationState = prestate, action: JobRow["action"] = "block") {
  const lease = { jobId: "job", scope, owner: "worker", version: 1 };
  const job: JobRow = {
    ...durableJob, action, status: "running",
    capability: state.kind === "access" ? "graph.package.access.manage" : "graph.package.block.manage",
    access_update: state.kind === "access" ? {
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
    async withTargetLock<T>(_lease: Lease, _item: JobItem, operation: () => Promise<T>) { return operation(); },
    markSent: vi.fn(async () => undefined),
    finishItem: vi.fn(async () => undefined),
    pauseItemForAuthorization: vi.fn(async () => undefined),
    release: vi.fn(async () => undefined),
  } satisfies Parameters<typeof runBulkJob>[3];
}

function provider(fetcher: FetchLike) {
  return new GraphPackagesClient(fetcher, { maxAttempts: 1, delay: async () => undefined });
}

describe("bulk job execution boundaries", () => {
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

  describe("read-only package reconciliation boundaries", () => {
    it.each(["verified_applied", "verified_not_applied", "conflict"] as const)(
      "preserves read-only %s evidence without requiring write authority", async outcome => {
        vi.spyOn(bulkJobs, "get").mockResolvedValue(jobSummary);
        vi.spyOn(bulkJobs, "reconciliationContext").mockResolvedValue({
          job: { ...durableJob, action: "update-availability",
            access_update: { target: "availability", mode: "replace", scope: "specific", principals: [principal] } },
          items: [{ ...durableItem, prestate: accessPrestate, prestate_hash: packageMutationStateHash(accessPrestate) }],
        });
        vi.spyOn(bulkJobs, "withReconciliationLock").mockImplementation(async (_scope, _item, operation) => operation());
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
          expect.objectContaining({ inventoryGeneration: "generation", details: expect.objectContaining({ id: "package" }) }));
        expect(authorize).toHaveBeenCalledTimes(3);
        expect(authorize.mock.calls.every(([, capability]) => capability === "graph.package.read.delegated")).toBe(true);
        expect(fetcher).toHaveBeenCalledOnce();
        expect(fetcher.mock.calls[0][1]?.method ?? "GET").toBe("GET");
      },
    );

    it("returns not found rather than a success-shaped partial response when the receipt expires", async () => {
      vi.spyOn(bulkJobs, "get").mockResolvedValueOnce(jobSummary).mockResolvedValueOnce(undefined);
      vi.spyOn(bulkJobs, "reconciliationContext").mockResolvedValue({ job: durableJob, items: [] });
      const fetcher = vi.fn<FetchLike>();

      await expect(reconcileBulkJob("job", scope, bulkJobs, provider(fetcher), async () => "token"))
        .rejects.toMatchObject({ code: "not_found" });
      expect(fetcher).not.toHaveBeenCalled();
    });

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
          job: durableJob, items: stage === "next-item" ? [durableItem, { ...durableItem, id: "second", target_id: "second-package" }] : [durableItem],
        });
        vi.spyOn(bulkJobs, "withReconciliationLock").mockImplementation(async (_scope, _item, operation) => operation());
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

  it.each(["block", "unblock", "update-availability", "update-installation", "skipped"] as const)(
    "preserves verified %s behavior and uses only the final dispatch token for a write", async operation => {
      const action = operation === "skipped" ? "block" : operation;
      const initialBlocked = operation === "unblock" || operation === "skipped";
      const state: PackageMutationState = action.startsWith("update-")
        ? accessPrestate : { kind: "block", isBlocked: initialBlocked };
      const repository = fakeRepository(state, action);
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

      await runBulkJob("job", scope, false, repository, provider(fetcher), async () => `token-${++authorizations}`);

      const writes = fetcher.mock.calls.filter(([, request]) => request?.method === "POST" || request?.method === "PATCH");
      expect(writes).toHaveLength(operation === "skipped" ? 0 : 1);
      if (writes[0]) expect(new Headers(writes[0][1]?.headers).get("Authorization")).toBe("Bearer token-3");
      expect(repository.finishItem).toHaveBeenCalledWith(expect.anything(), "item",
        operation === "skipped" ? "skipped" : "succeeded", expect.objectContaining({
          readback: expect.objectContaining(details), readbackCount: 1, inventoryGeneration: "generation",
        }));
      expect(repository.release).toHaveBeenCalledOnce();
    },
  );

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
    releaseAuthorization("token");

    await expect(drained).resolves.toBeUndefined();
    await execution;
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
      if (!admitted) throw new AppError(503, "provider_requalification_required", "Provider work is disabled.");
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
      if (!admitted) throw new AppError(503, "provider_requalification_required", "Provider work is disabled.");
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
      expect.objectContaining({ errorCode: "provider_requalification_required" }),
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
});
