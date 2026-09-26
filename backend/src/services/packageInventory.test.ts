import { getEventListeners } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "../errors.js";
import { activateAccountSession, revokeAccountSessionMutations } from "../db/sessions.js";
import type { AuthenticatedUser } from "../types/session.js";
import { PackageInventoryService, scanPackages, type PackageRefreshScan } from "./packageInventory.js";
import { allowlistedPackage } from "./packageObservation.js";
import { GraphPackagesClient, packageInventoryReadPolicy, type FetchLike, type PackageReadOptions } from "./graphPackages.js";
import { packageRefreshExecutionDeadlineMs } from "./packageRefreshPolicy.js";
import * as operationalState from "./operationalState.js";

vi.mock("../db/pool.js", () => ({
  pool: {},
  secretValue: vi.fn(),
  transaction: vi.fn(async () => { throw new Error("Unit tests must not access a database."); }),
}));
vi.mock("connect-pg-simple", () => ({
  default: () => class {
    constructor() { throw new Error("Unit tests must not construct a session store."); }
  },
}));

const user: AuthenticatedUser = {
  tenantId: "tenant-package",
  homeAccountId: "principal-package",
  displayName: "Package Reader",
  username: "reader@example.invalid",
  roles: ["AgentControl.Viewer"],
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function fixture(overrides: Record<string, unknown> = {}) {
  const job = {
    id: "11111111-1111-1111-1111-111111111111",
    authorizationPrincipalId: user.homeAccountId,
    tokenMode: "delegated" as const,
    scopeKind: "broad" as const,
    requestedIds: [],
    status: "waiting_authorization" as const,
    pageCount: 0,
    observedCount: 0,
    totalRecords: null,
    snapshotId: null,
    createdAt: "2026-09-09T00:00:00.000Z",
    attemptedAt: null,
    updatedAt: "2026-09-09T00:00:00.000Z",
    finishedAt: null,
  };
  const repository = {
    submit: vi.fn(async () => job),
    claimDueDetails: vi.fn(async () => null as typeof job | null),
    latestAutomaticDetailsJob: vi.fn(async () => null as typeof job | null),
    getJob: vi.fn(async (_scope?: unknown, id = job.id) => ({ ...job, id })),
    markRunning: vi.fn(async () => true),
    recordProgress: vi.fn(async () => undefined),
    publish: vi.fn(async () => undefined),
    markWaitingAuthorization: vi.fn(async () => undefined),
    markFailed: vi.fn(async () => undefined),
    cancel: vi.fn(async () => ({ ...job, status: "cancelled" as const })),
    recoverInterrupted: vi.fn(async () => 0),
    ...overrides,
  };
  const dependencies = {
    observeOperation: vi.fn(async (_id, _user, operation: (reportFailure: (error: unknown) => void) => Promise<unknown>) => operation(() => undefined)),
    delegatedToken: vi.fn(async () => "delegated-token"),
    applicationToken: vi.fn(async () => "application-token"),
    revalidateUser: vi.fn(async () => user),
    requireAvailable: vi.fn(async () => undefined),
    requireApplicationDataScope: vi.fn(async () => undefined),
    scan: vi.fn<PackageRefreshScan>(async () => ({ packages: [], totalRecords: 0, pages: 1 })),
    applicationPrincipalId: vi.fn(() => "application-id"),
    wait: vi.fn(async (_milliseconds: number, signal: AbortSignal) => { signal.throwIfAborted(); }),
  };
  return { job, repository, dependencies, service: new PackageInventoryService(repository as never, dependencies as never) };
}

describe("Package refresh service", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it.each(["maintenance", "provider_requalification_required"])(
    "retains the operational pause reason for automatic enrichment instead of requesting sign-in: %s", async code => {
      const { service, repository, dependencies, job } = fixture();
      const automaticJob = { ...job, autoDetails: true };
      repository.getJob.mockResolvedValue(automaticJob);
      let closed = false;
      vi.spyOn(operationalState, "requireProviderAdmissions").mockImplementation(() => {
        if (closed) throw new AppError(503, code, "Provider admissions are closed.");
      });
      dependencies.scan.mockImplementationOnce(async () => {
        closed = true;
        return { packages: [], totalRecords: 0, pages: 1 };
      });
      await service.start(user, job.id, "delegated");
      await vi.waitFor(() => expect(repository.markFailed).toHaveBeenCalledWith(
        expect.anything(), job.id, code, "Provider admissions are closed. Saved package data is unchanged.",
      ));
      await service.drain();
      expect(repository.publish).not.toHaveBeenCalled();
    },
  );

  it.each(["maintenance", "provider_requalification_required"])(
    "fences package resume and publication when admissions close: %s", async code => {
      for (const stage of ["start", "authorization", "activation", "collection"]) {
        const { service, repository, dependencies, job } = fixture();
        let closed = stage === "start";
        vi.spyOn(operationalState, "requireProviderAdmissions").mockImplementation(() => {
          if (closed) throw new AppError(503, code, "Provider admissions are closed.");
        });
        if (stage === "authorization") dependencies.revalidateUser.mockImplementationOnce(async () => { closed = true; return user; });
        if (stage === "activation") repository.markRunning.mockImplementationOnce(async () => { closed = true; return true; });
        if (stage === "collection") dependencies.scan.mockImplementationOnce(async () => {
          closed = true;
          return { packages: [], totalRecords: 0, pages: 1 };
        });
        try {
          if (stage === "collection") {
            await service.start(user, job.id, "delegated");
            await vi.waitFor(() => expect(repository.markWaitingAuthorization).toHaveBeenCalledOnce());
          } else {
            await expect(service.start(user, job.id, "delegated")).rejects.toMatchObject({ status: 503, code });
            expect(dependencies.scan).not.toHaveBeenCalled();
            if (stage === "activation") expect(repository.markWaitingAuthorization).toHaveBeenCalledOnce();
            else expect(repository.markRunning).not.toHaveBeenCalled();
          }
          expect(repository.publish).not.toHaveBeenCalled();
          expect(repository.markFailed).not.toHaveBeenCalled();
          await expect(service.get(user, job.id, "delegated")).resolves.toMatchObject({ id: job.id });
        } finally {
          await service.drain();
        }
      }
    },
  );

  it("publishes only after current delegated authorization and a complete explicit scan", async () => {
    const { service, repository, dependencies, job } = fixture();
    await service.start(user, job.id, "delegated");
    await vi.waitFor(() => expect(repository.publish).toHaveBeenCalledTimes(1));
    expect(dependencies.requireAvailable).toHaveBeenLastCalledWith("graph.package.read.delegated", user, { retryFailed: true });
    expect(repository.markRunning).toHaveBeenCalledBefore(dependencies.scan);
  });

  it("passes persisted catalog-only mode to resumed execution", async () => {
    const { service, repository, dependencies, job } = fixture();
    repository.getJob.mockResolvedValue({ ...job, catalogOnly: true } as typeof job);
    await service.start(user, job.id, "delegated");
    await vi.waitFor(() => expect(repository.publish).toHaveBeenCalledOnce());
    expect(dependencies.scan.mock.calls[0][4]).toMatchObject({ catalogOnly: true });
  });

  it("does nothing when another tab owns enrichment or no package is due", async () => {
    const { service, repository, dependencies } = fixture();
    await expect(service.refreshDueDetails(user)).resolves.toBeNull();
    expect(repository.claimDueDetails).toHaveBeenCalledWith({ tenantId: user.tenantId, principalId: user.homeAccountId }, user.homeAccountId, undefined);
    expect(repository.latestAutomaticDetailsJob).toHaveBeenCalledWith({ tenantId: user.tenantId, principalId: user.homeAccountId }, user.homeAccountId);
    expect(dependencies.scan).not.toHaveBeenCalled();
  });

  it.each(["claim", "start"] as const)("joins cancellation during automatic detail %s without launching collection", async stage => {
    const { service, repository, dependencies, job } = fixture();
    const controller = new AbortController();
    const claimed = deferred<typeof job>();
    const revalidated = deferred<AuthenticatedUser>();
    repository.claimDueDetails.mockImplementationOnce(async () => stage === "claim" ? claimed.promise : job);
    if (stage === "start") dependencies.revalidateUser.mockReturnValueOnce(revalidated.promise);
    const request = service.refreshDueDetails(user, undefined, controller.signal).catch(error => error);
    await vi.waitFor(() => expect(stage === "claim" ? repository.claimDueDetails : dependencies.revalidateUser).toHaveBeenCalled());
    const reason = new AppError(401, "interaction_required", "Coordinator shutdown.");
    controller.abort(reason);
    claimed.resolve(job);
    revalidated.resolve(user);
    expect(await request).toBe(reason);
    expect(dependencies.scan).not.toHaveBeenCalled();
    expect(repository.markFailed).toHaveBeenCalled();
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });

  it.each(["load", "scan"] as const)("pins package authorization through %s across a replacement sign-in", async stage => {
    const { service, repository, dependencies, job } = fixture();
    const owner = { ...user, homeAccountId: `replacement-package-${stage}` };
    job.authorizationPrincipalId = owner.homeAccountId;
    dependencies.revalidateUser.mockResolvedValue(owner);
    const loaded = deferred<typeof job>();
    const scanned = deferred<Awaited<ReturnType<PackageRefreshScan>>>();
    if (stage === "load") repository.getJob.mockReturnValueOnce(loaded.promise);
    else dependencies.scan.mockReturnValueOnce(scanned.promise);
    const request = service.start(owner, job.id, "delegated").catch(error => error);
    await vi.waitFor(() => expect(stage === "load" ? repository.getJob : dependencies.scan).toHaveBeenCalled());
    await activateAccountSession(owner.tenantId!, owner.homeAccountId, async () => undefined);
    loaded.resolve(job);
    scanned.resolve({ packages: [], totalRecords: 0, pages: 1 });
    if (stage === "load") {
      expect(await request).toMatchObject({ code: "unauthorized" });
      expect(dependencies.revalidateUser).not.toHaveBeenCalled();
    } else {
      await request;
      await vi.waitFor(() => expect(repository.markWaitingAuthorization).toHaveBeenCalled());
    }
    expect(repository.publish).not.toHaveBeenCalled();
  });

  it.each(["waiting_authorization", "running", "failed", "succeeded", "cancelled"])(
    "returns the latest %s automatic job without starting more provider work when nothing can be claimed", async status => {
      const { service, repository, dependencies, job } = fixture();
      const latest = { ...job, autoDetails: true, status } as typeof job;
      repository.latestAutomaticDetailsJob.mockResolvedValue(latest);
      await expect(service.refreshDueDetails(user)).resolves.toBe(latest);
      expect(dependencies.scan).not.toHaveBeenCalled();
      expect(repository.markRunning).not.toHaveBeenCalled();
    },
  );

  it("keeps the latest detail history available during drain without admitting more work", async () => {
    const { service, repository, job } = fixture();
    repository.latestAutomaticDetailsJob.mockResolvedValue(job);
    await service.drain();
    await expect(service.refreshDueDetails(user)).resolves.toBe(job);
    expect(repository.claimDueDetails).not.toHaveBeenCalled();
  });

  it("authorizes automatic details and executes the persisted low-impact enrichment mode", async () => {
    const { service, repository, dependencies, job } = fixture();
    const details = { ...job, requestedIds: ["one"], scopeKind: "exact", autoDetails: true };
    repository.claimDueDetails.mockResolvedValue(details as typeof job);
    repository.getJob.mockResolvedValue(details as typeof job);
    await service.refreshDueDetails(user);
    await vi.waitFor(() => expect(repository.publish).toHaveBeenCalledOnce());
    expect(repository.markRunning).toHaveBeenCalledWith(expect.anything(), job.id, true);
    expect(dependencies.scan.mock.calls[0][4]).toMatchObject({ autoDetails: true, retryThrottlingUntilAborted: false });
    expect(dependencies.revalidateUser).toHaveBeenCalled();
  });

  it("backs off an auto-detail admission that cannot obtain current authorization", async () => {
    const { service, repository, dependencies, job } = fixture();
    const details = { ...job, autoDetails: true };
    repository.claimDueDetails.mockResolvedValue(details);
    repository.getJob.mockResolvedValue(details);
    const failed = { ...details, status: "failed", errorCode: "interaction_required" };
    repository.markFailed.mockResolvedValue(failed as never);
    dependencies.revalidateUser.mockRejectedValue(new AppError(401, "interaction_required", "Sign in."));
    await expect(service.refreshDueDetails(user)).resolves.toBe(failed);
    expect(repository.markFailed).toHaveBeenCalledWith(expect.anything(), job.id, "interaction_required", expect.any(String));
    expect(dependencies.scan).not.toHaveBeenCalled();
  });

  it("preserves automatic detail permission failures instead of asking the user to sign in", async () => {
    const { service, repository, dependencies, job } = fixture();
    repository.claimDueDetails.mockResolvedValue({ ...job, autoDetails: true });
    repository.markFailed.mockResolvedValue({ ...job, status: "failed" } as never);
    dependencies.requireAvailable.mockRejectedValue(new AppError(403, "missing_permission", "Administrator consent required."));
    await service.refreshDueDetails(user);
    expect(repository.markFailed).toHaveBeenCalledWith(expect.anything(), job.id, "missing_permission",
      expect.stringContaining("permission"));
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("package_detail_admission_failed"));
  });

  it.each(["missing_permission", "capability_unavailable", "provider_error"])(
    "does not turn a package read 403 (%s) into an expired sign-in", async code => {
      const { service, repository, dependencies, job } = fixture();
      dependencies.scan.mockRejectedValue(new AppError(403, code, "Permission denied."));
      await service.start(user, job.id, "delegated");
      await vi.waitFor(() => expect(repository.markFailed).toHaveBeenCalled());
      expect(repository.markWaitingAuthorization).not.toHaveBeenCalled();
      expect(repository.markFailed).toHaveBeenCalledWith(expect.anything(), job.id,
        code === "provider_error" ? "missing_permission" : code, expect.stringContaining("permission"));
    },
  );

  it("never logs success for an automatic batch containing failed detail reads", async () => {
    const { service, repository, dependencies, job } = fixture();
    repository.getJob.mockResolvedValue({ ...job, autoDetails: true } as typeof job);
    dependencies.scan.mockResolvedValue({
      packages: [], totalRecords: 0, pages: 1,
      detailFailures: [{ id: "one", missing: false, errorCode: "provider_error" }],
    });
    await service.start(user, job.id, "delegated");
    await vi.waitFor(() => expect(vi.mocked(console.warn).mock.calls.flat().join("\n")).toContain("package_detail_read_failed"));
    expect(repository.publish).toHaveBeenCalledOnce();
    expect(vi.mocked(console.log).mock.calls.flat().join("\n")).not.toContain("package_refresh_succeeded");
  });

  it.each(["provider_timeout", "provider_network_error", "provider_throttled"])(
    "retains complete collection and retries transient publication readiness: %s", async code => {
      const { service, repository, dependencies, job } = fixture();
      const result = { packages: [allowlistedPackage({ id: "complete", displayName: "Complete", isBlocked: false })], totalRecords: 1, pages: 2 };
      dependencies.scan.mockResolvedValue(result);
      dependencies.requireAvailable.mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new AppError(code === "provider_throttled" ? 429 : 504, code, "Transient readiness failure."));
      await service.start(user, job.id, "delegated");
      await vi.waitFor(() => expect(repository.publish).toHaveBeenCalledOnce());
      expect(dependencies.scan).toHaveBeenCalledOnce();
      expect(dependencies.wait).toHaveBeenCalledWith(1_000, expect.any(AbortSignal));
      expect(dependencies.revalidateUser).toHaveBeenCalledTimes(3);
      expect(dependencies.requireAvailable).toHaveBeenLastCalledWith("graph.package.read.delegated", user, { retryFailed: true });
      expect(repository.recordProgress).toHaveBeenCalledWith(expect.anything(), job.id, 2, 1, 1, expect.stringContaining("no packages are being downloaded again"));
      expect(repository.publish).toHaveBeenCalledWith(expect.anything(), job.id, result);
      expect(repository.markFailed).not.toHaveBeenCalled();
      expect(repository.markWaitingAuthorization).not.toHaveBeenCalled();
    },
  );

  it("honors the remaining readiness throttle cache rather than repeatedly probing during its cooldown", async () => {
    const { service, repository, dependencies, job } = fixture();
    const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
    dependencies.requireAvailable.mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new AppError(429, "provider_throttled", "Cooling down.", { expiresAt }));
    await service.start(user, job.id, "delegated");
    await vi.waitFor(() => expect(repository.publish).toHaveBeenCalledOnce());
    expect(dependencies.wait.mock.calls[0][0]).toBeGreaterThan(299_000);
    expect(dependencies.wait.mock.calls[0][0]).toBeLessThanOrEqual(300_001);
    expect(dependencies.scan).toHaveBeenCalledOnce();
  });

  it.each([
    new AppError(401, "interaction_required", "Sign in again."),
    new AppError(403, "missing_permission", "Permission revoked."),
    new AppError(503, "provider_error", "Provider denied access.", { evidence: { httpStatus: 403 } }),
    new AppError(502, "provider_schema", "Invalid observation."),
  ])("never retries a permanent publication authorization or schema failure: $code", async error => {
    const { service, repository, dependencies, job } = fixture();
    dependencies.requireAvailable.mockResolvedValueOnce(undefined).mockRejectedValueOnce(error);
    await service.start(user, job.id, "delegated");
    await vi.waitFor(() => expect(repository.markFailed.mock.calls.length + repository.markWaitingAuthorization.mock.calls.length).toBe(1));
    expect(repository.publish).not.toHaveBeenCalled();
    expect(dependencies.wait).not.toHaveBeenCalled();
    expect(dependencies.scan).toHaveBeenCalledOnce();
  });

  it("does not retry an uncertain publication as if it were a readiness failure", async () => {
    const { service, repository, dependencies, job } = fixture();
    repository.publish.mockRejectedValueOnce(new AppError(504, "provider_timeout", "Publication failed."));
    await service.start(user, job.id, "delegated");
    await vi.waitFor(() => expect(repository.markFailed).toHaveBeenCalledOnce());
    expect(repository.publish).toHaveBeenCalledOnce();
    expect(dependencies.wait).not.toHaveBeenCalled();
    expect(dependencies.scan).toHaveBeenCalledOnce();
  });

  it.each(["principal", "role"] as const)("rechecks the %s before retrying publication rather than reusing old authority", async changed => {
    const { service, repository, dependencies, job } = fixture();
    dependencies.requireAvailable.mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new AppError(504, "provider_timeout", "Transient readiness failure."));
    dependencies.wait.mockImplementation(async (_ms, signal) => {
      signal.throwIfAborted();
      dependencies.revalidateUser.mockResolvedValueOnce(changed === "principal"
        ? { ...user, homeAccountId: "different-reader" } : { ...user, roles: [] });
    });
    await service.start(user, job.id, "delegated");
    await vi.waitFor(() => expect(repository.markFailed.mock.calls.length + repository.markWaitingAuthorization.mock.calls.length).toBe(1));
    expect(repository.publish).not.toHaveBeenCalled();
    expect(dependencies.wait).toHaveBeenCalledOnce();
    expect(dependencies.requireAvailable).toHaveBeenCalledTimes(2);
    expect(dependencies.scan).toHaveBeenCalledOnce();
  });

  it.each(["cancel", "logout"] as const)("interrupts publication recovery promptly on %s without holding the account lock", async action => {
    const { service, repository, dependencies, job } = fixture();
    const currentUser = { ...user, homeAccountId: `publication-recovery-${action}` };
    job.authorizationPrincipalId = currentUser.homeAccountId;
    dependencies.revalidateUser.mockResolvedValue(currentUser);
    dependencies.requireAvailable.mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new AppError(504, "provider_timeout", "Transient failure."));
    dependencies.wait.mockImplementation((_ms, signal) => new Promise<void>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }));
    await service.start(currentUser, job.id, "delegated");
    await vi.waitFor(() => expect(dependencies.wait).toHaveBeenCalledOnce());
    if (action === "cancel") await service.cancel(currentUser, job.id, "delegated");
    else await revokeAccountSessionMutations(currentUser.tenantId!, currentUser.homeAccountId, () =>
      service.waitForPrincipalAuthorization({ tenantId: currentUser.tenantId!, principalId: currentUser.homeAccountId }));
    await service.drain();
    expect(repository.publish).not.toHaveBeenCalled();
    expect(repository.markFailed).not.toHaveBeenCalled();
    expect(dependencies.scan).toHaveBeenCalledOnce();
    expect(dependencies.requireAvailable).toHaveBeenCalledTimes(2);
    expect(repository.markWaitingAuthorization).toHaveBeenCalledTimes(action === "logout" ? 1 : 0);
  });

  it.each([{ requestedIds: [] }, { requestedIds: ["one"] }, { requestedIds: ["one", "two"] }])(
    "keeps package collection active for three hours within the four-hour ceiling ($requestedIds)", async ({ requestedIds }) => {
    vi.useFakeTimers();
    const initial = fixture().job;
    const { service, repository, dependencies, job } = fixture({
      getJob: vi.fn(async () => ({ ...initial, requestedIds, scopeKind: requestedIds.length ? "exact" : "broad" })),
    });
    const pending = deferred<{ packages: []; totalRecords: number; pages: number }>();
    dependencies.scan.mockReturnValue(pending.promise);
    const deadline = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation(milliseconds => {
      setTimeout(() => deadline.abort(new DOMException("Execution deadline", "TimeoutError")), milliseconds);
      return deadline.signal;
    });
    try {
      await service.start(user, job.id, "delegated");
      expect(timeout).toHaveBeenCalledWith(packageRefreshExecutionDeadlineMs);
      expect(packageRefreshExecutionDeadlineMs).toBe(4 * 60 * 60_000);
      await vi.advanceTimersByTimeAsync(3 * 60 * 60_000);
      expect(dependencies.scan.mock.calls[0][2].aborted).toBe(false);
      expect(repository.markFailed).not.toHaveBeenCalled();
      pending.resolve({ packages: [], totalRecords: 0, pages: 1 });
      await vi.advanceTimersByTimeAsync(0);
      expect(repository.publish).toHaveBeenCalledOnce();
    } finally {
      pending.resolve({ packages: [], totalRecords: 0, pages: 1 });
      await service.drain();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("stops pending collection exactly at the four-hour execution ceiling", async () => {
    vi.useFakeTimers();
    const { service, repository, dependencies, job } = fixture();
    vi.spyOn(AbortSignal, "timeout").mockImplementation(milliseconds => {
      const deadline = new AbortController();
      setTimeout(() => deadline.abort(new DOMException("Execution deadline", "TimeoutError")), milliseconds);
      return deadline.signal;
    });
    dependencies.scan.mockImplementation((_token, _ids, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }));
    try {
      await service.start(user, job.id, "delegated");
      await vi.advanceTimersByTimeAsync(4 * 60 * 60_000 - 1);
      expect(dependencies.scan.mock.calls[0][2].aborted).toBe(false);
      expect(repository.markFailed).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(repository.markFailed).toHaveBeenCalledWith(
        { tenantId: user.tenantId, principalId: user.homeAccountId }, job.id,
        "package_refresh_timeout", expect.stringContaining("four-hour execution deadline"),
      );
      expect(repository.publish).not.toHaveBeenCalled();
      expect(repository.markWaitingAuthorization).not.toHaveBeenCalled();
    } finally {
      await service.drain();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("does not hold the account lock during a slow publication probe or publish after session revocation", async () => {
    const { service, repository, dependencies, job } = fixture();
    const currentUser = { ...user, homeAccountId: "publication-probe-revocation" };
    job.authorizationPrincipalId = currentUser.homeAccountId;
    dependencies.revalidateUser.mockResolvedValue(currentUser);
    const pending = deferred<undefined>();
    dependencies.requireAvailable.mockResolvedValueOnce(undefined).mockReturnValueOnce(pending.promise);
    await service.start(currentUser, job.id, "delegated");
    await vi.waitFor(() => expect(dependencies.requireAvailable).toHaveBeenCalledTimes(2));
    await revokeAccountSessionMutations(currentUser.tenantId!, currentUser.homeAccountId, () =>
      service.waitForPrincipalAuthorization({ tenantId: currentUser.tenantId!, principalId: currentUser.homeAccountId }));
    expect(repository.publish).not.toHaveBeenCalled();
    pending.resolve(undefined);
    await service.drain();
    expect(repository.publish).not.toHaveBeenCalled();
    expect(repository.markWaitingAuthorization).toHaveBeenCalledOnce();
  });

  it("supplies renewable tokens and deadline-controlled throttle retries to the real scanner", async () => {
    const { service, repository, dependencies, job } = fixture();
    let reads = 0;
    const fetcher = vi.fn<FetchLike>(async (input, init) => {
      reads += 1;
      expect(new Headers(init?.headers).get("Authorization")).toBe(`Bearer renewed-${reads}`);
      return Response.json(new URL(input).pathname.endsWith("/packages")
        ? { value: [{ id: "one", displayName: "One", isBlocked: false }] }
        : { id: "one", displayName: "One", isBlocked: false });
    });
    dependencies.delegatedToken.mockResolvedValueOnce("admission-token")
      .mockResolvedValueOnce("renewed-1").mockResolvedValueOnce("renewed-2");
    const client = new GraphPackagesClient(fetcher);
    dependencies.scan.mockImplementation((token, ids, signal, progress, options) => scanPackages(token, ids, signal, progress, client, options));
    await service.start(user, job.id, "delegated");
    await vi.waitFor(() => expect(repository.publish).toHaveBeenCalledOnce());
    expect(reads).toBe(2);
    expect(dependencies.scan.mock.calls[0][4]).toMatchObject({ retryThrottlingUntilAborted: true });
    expect(dependencies.delegatedToken).toHaveBeenCalledTimes(3);
  });

  describe("bounded identity detail refresh", () => {
    const packageValue = (id: string) => allowlistedPackage({ id, displayName: id, isBlocked: false });

    it.each([401, 403])("stops automatic detail batches on HTTP %s rather than retrying every remaining target", async status => {
      const failure = new AppError(status, "provider_error", "Read authorization failed.");
      const client = {
        listCopilotAgents: vi.fn(),
        getPackageDetails: vi.fn(async () => { throw failure; }),
      };
      await expect(scanPackages("token", Array.from({ length: 20 }, (_, index) => `package-${index}`),
        new AbortController().signal, async () => undefined, client, { autoDetails: true })).rejects.toBe(failure);
      expect(client.getPackageDetails).toHaveBeenCalledTimes(2);
    });

    it("completes a 1,010-package identity scan through the real client despite transient detail failures", async () => {
      const listed = Array.from({ length: 1010 }, (_, index) => ({ id: `package-${index}`, displayName: `Agent ${index}`, isBlocked: false }));
      const definition = JSON.stringify({ SourceIds: { EnvironmentId: "environment", CdsBotId: "bot", SchemaName: "agent_schema" } });
      let attempts = 0;
      const fetcher = vi.fn<FetchLike>(async input => {
        const url = new URL(input);
        if (url.pathname.endsWith("/packages")) return Response.json(url.searchParams.has("page")
          ? { value: listed.slice(500) }
          : { value: listed.slice(0, 500), "@odata.nextLink": "https://graph.microsoft.com/v1.0/copilot/admin/catalog/packages?page=2" });
        const id = url.pathname.split("/").at(-1)!;
        if (id === "package-20" && ++attempts <= 2) {
          return Response.json({ error: { code: "InternalServerError", message: "private provider message" } }, { status: attempts === 1 ? 500 : 502 });
        }
        return Response.json({ id, displayName: id, isBlocked: false,
          elementDetails: [{ elementType: "AgentMetadatas", elements: [{ id: "metadata", definition }] }] });
      });
      const retryDelay = vi.fn(async () => undefined);
      const client = new GraphPackagesClient(fetcher, { delay: retryDelay });
      const { service, repository, dependencies, job } = fixture();
      dependencies.scan.mockImplementation((token, ids, signal, progress) => scanPackages(token, ids, signal, progress, client));

      await service.start(user, job.id, "delegated");
      await vi.waitFor(() => expect(repository.publish).toHaveBeenCalledOnce(), { timeout: 5_000 });

      expect(repository.publish).toHaveBeenCalledWith(expect.anything(), job.id, expect.objectContaining({
        totalRecords: 1010, pages: 2, packages: expect.arrayContaining([
          expect.objectContaining({ id: "package-20", identityDetailsCollected: true,
            elementDetails: [{ elementType: "AgentMetadatas", elements: [{ id: "metadata", definition }] }] }),
        ]),
      }));
      expect(repository.recordProgress).toHaveBeenLastCalledWith(expect.anything(), job.id, 2, 1010, 1010,
        "Matching agent records (1010/1010 identities checked).");
      expect(repository.markFailed).not.toHaveBeenCalled();
      expect(fetcher).toHaveBeenCalledTimes(1014);
      expect(retryDelay.mock.calls).toEqual([[2000, expect.any(AbortSignal)], [4000, expect.any(AbortSignal)]]);
    });

    it.each([400, 424, 500])("retains the old snapshot and sanitized HTTP %i diagnostics when a real detail read fails", async status => {
      const requestId = "22222222-2222-2222-2222-222222222222";
      const providerCode = status === 500 ? "InternalServerError" : status === 424 ? "UnknownError" : "BadRequest";
      const fetcher = vi.fn<FetchLike>(async input => new URL(input).pathname.endsWith("/packages")
        ? Response.json({ value: [{ id: "package", displayName: "Agent", isBlocked: false }] })
        : Response.json({ error: { code: providerCode, message: `${status === 424 ? "Too many requests " : ""}private-token person@example.invalid` } },
          { status, headers: { "request-id": requestId } }));
      const client = new GraphPackagesClient(fetcher, { ...packageInventoryReadPolicy, throttledReadIntervalMs: 0, delay: async () => undefined });
      const { service, repository, dependencies, job } = fixture();
      dependencies.scan.mockImplementation((token, ids, signal, progress) => scanPackages(token, ids, signal, progress, client));
      const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
      try {
        await service.start(user, job.id, "delegated");
        await vi.waitFor(() => expect(repository.markFailed).toHaveBeenCalledOnce());
        expect(repository.publish).not.toHaveBeenCalled();
        expect(repository.markFailed).toHaveBeenCalledWith(expect.anything(), job.id, `graph_http_${status}`,
          expect.stringContaining(`HTTP ${status}, ${providerCode}`));
        expect(repository.markFailed).toHaveBeenCalledWith(expect.anything(), job.id, `graph_http_${status}`,
          expect.stringContaining(requestId));
        expect(fetcher).toHaveBeenCalledTimes(status === 500 ? 4 : status === 424 ? 7 : 2);
        expect(log.mock.calls.flat().join("\n")).toContain('"event":"package_refresh_failed"');
        expect(log.mock.calls.flat().join("\n")).toContain(`"status":${status}`);
        expect(JSON.stringify([repository.markFailed.mock.calls, log.mock.calls])).not.toMatch(/private-token|person@/);
      } finally { log.mockRestore(); }
    });

    it("collects every listed identity automatically beyond the manual 100-target limit", async () => {
      const listed = Array.from({ length: 105 }, (_, index) => ({ ...packageValue(`package-${index}`), publisher: "Saved publisher" }));
      let active = 0;
      let maximumActive = 0;
      const client = {
        listCopilotAgents: vi.fn(async () => listed),
        getPackageDetails: vi.fn(async (_token: string, id: string) => {
          active += 1;
          maximumActive = Math.max(maximumActive, active);
          await Promise.resolve();
          active -= 1;
          if (id === "package-104") throw new AppError(404, "not_found", "Removed after listing");
          return { ...packageValue(id), elementDetails: [{ elementType: "AgentMetadatas", elements: [] }] };
        }),
      };
      const progress = vi.fn(async () => undefined);
      const result = await scanPackages("token", [], new AbortController().signal, progress, client);
      expect(result).toMatchObject({ totalRecords: 104, pages: 1 });
      expect(result.packages.every(value => value.identityDetailsCollected === true && value.publisher === "Saved publisher")).toBe(true);
      expect(result.packages.map(value => value.id)).toEqual(listed.slice(0, 104).map(value => value.id));
      expect(client.getPackageDetails).toHaveBeenCalledTimes(105);
      expect(maximumActive).toBe(4);
      expect(progress).toHaveBeenLastCalledWith(1, 105, 105, "Matching agent records (105/105 identities checked).");
    });

    it("publishes a catalog scan without issuing any per-package detail reads", async () => {
      const client = {
        listCopilotAgents: vi.fn(async () => [packageValue("one"), packageValue("two")]),
        getPackageDetails: vi.fn(async () => { throw new Error("Catalog-only must not hydrate details."); }),
      };
      const result = await scanPackages("token", [], new AbortController().signal, async () => undefined, client, { catalogOnly: true });
      expect(result).toMatchObject({ totalRecords: 2, pages: 1 });
      expect(result.packages.every(value => !value.identityDetailsCollected)).toBe(true);
      expect(client.getPackageDetails).not.toHaveBeenCalled();
    });

    it("isolates automatic detail failures, limits concurrency to two and never lists packages", async () => {
      let active = 0;
      let maximum = 0;
      const client = {
        listCopilotAgents: vi.fn(async () => []),
        getPackageDetails: vi.fn(async (_token: string, id: string) => {
          active += 1;
          maximum = Math.max(maximum, active);
          await Promise.resolve();
          active -= 1;
          if (id === "missing") throw new AppError(404, "not_found", "Missing.");
          if (id === "failed") throw new AppError(429, "provider_throttled", "Retry later.");
          return packageValue(id);
        }),
      };
      const result = await scanPackages("token", ["one", "missing", "failed", "two"], new AbortController().signal,
        async () => undefined, client, { autoDetails: true });
      expect(client.listCopilotAgents).not.toHaveBeenCalled();
      expect(maximum).toBe(2);
      expect(result.packages.map(value => value.id)).toEqual(["one", "two"]);
      expect(result.detailFailures).toEqual([
        { id: "missing", missing: true, errorCode: "not_found" },
        { id: "failed", missing: false, errorCode: "provider_throttled" },
      ]);
    });

    it("distinguishes a completed detail read with no metadata from a broad summary", async () => {
      const client = {
        listCopilotAgents: vi.fn(async () => [packageValue("one")]),
        getPackageDetails: vi.fn(async () => packageValue("one")),
      };
      const result = await scanPackages("token", [], new AbortController().signal, async () => undefined, client);
      expect(result.packages[0]).toMatchObject({ id: "one", identityDetailsCollected: true });
      expect(result.packages[0].elementDetails).toBeUndefined();
    });

    it("keeps free detail workers busy while one package is slow and preserves catalog order", async () => {
      const slow = deferred<ReturnType<typeof packageValue>>();
      const ids = Array.from({ length: 9 }, (_, index) => `package-${index}`);
      const client = {
        listCopilotAgents: vi.fn(async () => ids.map(packageValue)),
        getPackageDetails: vi.fn(async (_token: string, id: string) =>
          id === ids[0] ? slow.promise : packageValue(id)),
      };
      const progress = vi.fn(async () => undefined);
      const result = scanPackages("token", [], new AbortController().signal, progress, client);
      try {
        await vi.waitFor(() => expect(client.getPackageDetails).toHaveBeenCalledTimes(ids.length));
        expect(progress).toHaveBeenLastCalledWith(1, 8, 9, "Matching agent records (8/9 identities checked).");
      } finally {
        slow.resolve(packageValue(ids[0]));
        await result;
      }
      expect((await result).packages.map(value => value.id)).toEqual(ids);
      expect(progress).toHaveBeenLastCalledWith(1, 9, 9, "Matching agent records (9/9 identities checked).");
    });

    it("serializes progress persistence without stopping all available detail workers", async () => {
      const pending = deferred<void>();
      const counts: number[] = [];
      const client = {
        listCopilotAgents: vi.fn(async () => Array.from({ length: 9 }, (_, index) => packageValue(`package-${index}`))),
        getPackageDetails: vi.fn(async (_token: string, id: string) => packageValue(id)),
      };
      const progress = vi.fn(async (_pages: number, count: number) => {
        counts.push(count);
        if (count === 4) await pending.promise;
      });
      const result = scanPackages("token", [], new AbortController().signal, progress, client);
      try {
        await vi.waitFor(() => expect(client.getPackageDetails).toHaveBeenCalledTimes(9));
        expect(counts).toEqual([0, 4]);
      } finally {
        pending.resolve();
        await result;
      }
      expect(counts).toEqual([0, 4, 8, 9]);
    });

    it("retains a retry notice while other workers report completed details", async () => {
      vi.useFakeTimers();
      const slow = deferred<ReturnType<typeof packageValue>>();
      const client = {
        listCopilotAgents: vi.fn(async () => Array.from({ length: 9 }, (_, index) => packageValue(`package-${index}`))),
        getPackageDetails: vi.fn(async (_token: string, id: string, options: PackageReadOptions) => {
          if (id !== "package-0") return packageValue(id);
          await options.onRetry?.({ attempt: 1, retryDelayMs: 30_000, throttled: true });
          return slow.promise;
        }),
      };
      const progress = vi.fn(async () => undefined);
      const result = scanPackages("token", [], new AbortController().signal, progress, client);
      try {
        await vi.advanceTimersByTimeAsync(0);
        expect(progress).toHaveBeenLastCalledWith(1, 8, 9,
          "Microsoft Graph is throttling package reads. Waiting 30 seconds before retrying (8/9 identities checked).");
        await vi.advanceTimersByTimeAsync(30_000);
        slow.resolve(packageValue("package-0"));
        await result;
        expect(progress).toHaveBeenLastCalledWith(1, 9, 9, "Matching agent records (9/9 identities checked).");
      } finally {
        slow.resolve(packageValue("package-0"));
        await result;
        vi.useRealTimers();
      }
    });

    it.each(["provider", "progress"] as const)("aborts and drains in-flight reads after a %s failure", async source => {
      const pending = deferred<ReturnType<typeof packageValue>>();
      const error = new AppError(502, "provider_error", "Read failed.");
      const signals: AbortSignal[] = [];
      const client = {
        listCopilotAgents: vi.fn(async () => Array.from({ length: 20 }, (_, index) => packageValue(`package-${index}`))),
        getPackageDetails: vi.fn(async (_token: string, id: string, options: PackageReadOptions) => {
          signals.push(options.signal!);
          if (id === "package-0") return pending.promise;
          if (source === "provider" && id === "package-1") throw error;
          return packageValue(id);
        }),
      };
      const progress = vi.fn(async (_pages: number, count: number) => {
        if (source === "progress" && count === 4) throw error;
      });
      const result = scanPackages("token", [], new AbortController().signal, progress, client);
      const assertion = expect(result).rejects.toBe(error);
      let settled = false;
      void result.then(() => { settled = true; }, () => { settled = true; });
      try {
        await vi.waitFor(() => expect(signals[0]?.aborted).toBe(true));
        expect(signals.every(signal => signal.reason === error)).toBe(true);
        expect(settled).toBe(false);
        expect(client.getPackageDetails.mock.calls.length).toBeLessThan(20);
        const calls = client.getPackageDetails.mock.calls.length;
        const updates = progress.mock.calls.length;
        pending.resolve(packageValue("package-0"));
        await assertion;
        expect(client.getPackageDetails).toHaveBeenCalledTimes(calls);
        expect(progress).toHaveBeenCalledTimes(updates);
      } finally {
        pending.resolve(packageValue("package-0"));
        await assertion;
      }
    });

    it("does not advance identity collection after cancellation or a failed detail read", async () => {
      const controller = new AbortController();
      const client = {
        listCopilotAgents: vi.fn(async () => Array.from({ length: 8 }, (_, index) => packageValue(`package-${index}`))),
        getPackageDetails: vi.fn(async (_token: string, id: string) => {
          if (id === "package-1") controller.abort(new AppError(409, "read_job_cancelled", "Cancelled"));
          return packageValue(id);
        }),
      };
      await expect(scanPackages("token", [], controller.signal, async () => undefined, client))
        .rejects.toMatchObject({ code: "read_job_cancelled" });
      expect(client.getPackageDetails).toHaveBeenCalledTimes(2);
      client.getPackageDetails.mockClear();
      client.getPackageDetails.mockRejectedValue(new AppError(403, "missing_permission", "Denied"));
      await expect(scanPackages("token", [], new AbortController().signal, async () => undefined, client))
        .rejects.toMatchObject({ code: "missing_permission" });
      expect(client.getPackageDetails).toHaveBeenCalledTimes(4);
    });

    it("reads exact details with bounded workers and retains complete deterministic results", async () => {
      let active = 0;
      let maximumActive = 0;
      const client = {
        listCopilotAgents: vi.fn(),
        getPackageDetails: vi.fn(async (_token: string, id: string) => {
          active += 1;
          maximumActive = Math.max(maximumActive, active);
          await Promise.resolve();
          active -= 1;
          return packageValue(id);
        }),
      };
      const progress = vi.fn(async () => undefined);
      const ids = Array.from({ length: 9 }, (_, index) => `package-${index}`);
      const result = await scanPackages("token", ids, new AbortController().signal, progress, client);
      expect(result.packages.map(value => value.id)).toEqual(ids);
      expect(result).toMatchObject({ pages: 9, totalRecords: 9 });
      expect(maximumActive).toBe(4);
      expect(progress.mock.calls).toEqual([[4, 4, 4, undefined], [8, 8, 8, undefined], [9, 9, 9, undefined]]);
      expect(client.listCopilotAgents).not.toHaveBeenCalled();
    });

    it("records a missing exact package as absence without substituting another identity", async () => {
      const client = {
        listCopilotAgents: vi.fn(),
        getPackageDetails: vi.fn(async (_token: string, id: string) => {
          if (id === "gone") throw new AppError(404, "not_found", "No longer present");
          return packageValue(id);
        }),
      };
      expect(await scanPackages("token", ["gone", "present"], new AbortController().signal, async () => undefined, client))
        .toMatchObject({ packages: [{ id: "present" }], totalRecords: 1, pages: 2 });
      client.getPackageDetails.mockResolvedValue(packageValue("different"));
      await expect(scanPackages("token", ["requested"], new AbortController().signal, async () => undefined, client))
        .rejects.toMatchObject({ code: "target_mismatch" });
    });

    it("does not publish a partial scan or dispatch more reads after an error", async () => {
      const client = {
        listCopilotAgents: vi.fn(),
        getPackageDetails: vi.fn(async (_token: string, id: string) => {
          if (id === "bad") throw new AppError(403, "not_authorized", "Denied");
          return packageValue(id);
        }),
      };
      const progress = vi.fn(async () => undefined);
      await expect(scanPackages("token", ["a", "bad", "b", "c", "not-dispatched"], new AbortController().signal, progress, client))
        .rejects.toMatchObject({ code: "not_authorized" });
      expect(client.getPackageDetails).toHaveBeenCalledTimes(4);
      expect(progress).not.toHaveBeenCalled();
    });
  });

  it("keeps application reads independent and requires approved shared scope", async () => {
    const applicationJob = { ...fixture().job, tokenMode: "application" as const };
    const { service, repository, dependencies } = fixture({ getJob: vi.fn(async () => applicationJob) });
    await service.submit(user, { tokenMode: "application", idempotencyKey: "application-read" });
    expect(repository.submit).toHaveBeenCalledWith({ tenantId: user.tenantId, principalId: "application-id" }, expect.objectContaining({ authorizationPrincipalId: user.homeAccountId, tokenMode: "application" }));
    await service.start(user, applicationJob.id, "application");
    await vi.waitFor(() => expect(repository.publish).toHaveBeenCalledTimes(1));
    expect(dependencies.applicationToken).toHaveBeenCalledWith(user.tenantId, "graph.package.read.application");
    expect(dependencies.delegatedToken).not.toHaveBeenCalled();
    expect(dependencies.requireApplicationDataScope).toHaveBeenCalled();
  });

  it("lets Admin inherit every Viewer package read mode", async () => {
    const admin = { ...user, roles: ["AgentControl.Admin" as const] };
    const direct = fixture();
    await expect(direct.service.submit(admin, { tokenMode: "delegated", idempotencyKey: "broad" })).resolves.toBeDefined();
    await expect(direct.service.submit(admin, { tokenMode: "application", idempotencyKey: "application" })).resolves.toBeDefined();
    await expect(direct.service.submit(admin, { tokenMode: "delegated", idempotencyKey: "exact", requestedIds: ["package-1"] })).resolves.toBeDefined();
  });

  it("lets only the owning Viewer cancel a read refresh", async () => {
    const direct = fixture();
    await expect(direct.service.cancel(user, direct.job.id, "delegated")).resolves.toMatchObject({ status: "cancelled" });
    expect(direct.repository.cancel).toHaveBeenCalledWith({ tenantId: user.tenantId, principalId: user.homeAccountId }, direct.job.id, user.homeAccountId, "requested");
    await expect(direct.service.cancel({ ...user, roles: [] }, direct.job.id, "delegated")).rejects.toMatchObject({ code: "missing_internal_role" });
  });

  it("leaves authorization failure waiting without starting the scan", async () => {
    const { service, repository, dependencies, job } = fixture();
    dependencies.delegatedToken.mockRejectedValue(new AppError(401, "interaction_required", "reauthenticate"));
    await expect(service.start(user, job.id, "delegated")).rejects.toMatchObject({ code: "interaction_required" });
    expect(repository.markRunning).not.toHaveBeenCalled();
    expect(dependencies.scan).not.toHaveBeenCalled();
  });

  it.each(["revalidateUser", "requireAvailable", "delegatedToken"] as const)(
    "persists permission-denied admission at %s instead of returning a sign-in-only job", async stage => {
      const { service, repository, dependencies, job } = fixture();
      dependencies[stage].mockRejectedValueOnce(new AppError(403, "missing_permission", "Consent is required."));
      await expect(service.start(user, job.id, "delegated")).rejects.toMatchObject({ code: "missing_permission" });
      expect(repository.markFailed).toHaveBeenCalledWith(
        { tenantId: user.tenantId, principalId: user.homeAccountId }, job.id, "missing_permission",
        expect.stringContaining("Review Permissions; signing in again does not grant permissions"),
      );
      expect(repository.markRunning).not.toHaveBeenCalled();
      expect(dependencies.scan).not.toHaveBeenCalled();
    },
  );

  it.each(["revalidateUser", "requireAvailable", "delegatedToken"] as const)(
    "keeps interrupted admission waiting when %s later denies permission", async stage => {
      const { service, repository, dependencies, job } = fixture();
      const pending = deferred<never>();
      dependencies[stage].mockReturnValueOnce(pending.promise);
      const starting = service.start(user, job.id, "delegated");
      const stopped = expect(starting).rejects.toMatchObject({ code: "interaction_required" });
      await vi.waitFor(() => expect(dependencies[stage]).toHaveBeenCalledOnce());
      await service.waitForPrincipalAuthorization({ tenantId: user.tenantId!, principalId: user.homeAccountId });
      pending.reject(new AppError(403, "missing_permission", "Late consent failure."));
      await stopped;
      expect(repository.markFailed).not.toHaveBeenCalled();
      expect(dependencies.scan).not.toHaveBeenCalled();
    },
  );

  it("forwards explicit readiness retry and internal cleanup without weakening admission", async () => {
    const { service, repository, dependencies, job } = fixture();
    dependencies.requireAvailable.mockRejectedValueOnce(new AppError(504, "provider_timeout", "Readiness timed out."));
    await expect(service.start(user, job.id, "delegated", { retryFailed: true }))
      .rejects.toMatchObject({ code: "provider_timeout" });
    expect(dependencies.requireAvailable).toHaveBeenCalledWith("graph.package.read.delegated", user, { retryFailed: true });
    expect(repository.markRunning).not.toHaveBeenCalled();
    expect(dependencies.scan).not.toHaveBeenCalled();
    await service.cancel(user, job.id, "delegated", "sync_cleanup");
    expect(repository.cancel).toHaveBeenCalledWith(
      { tenantId: user.tenantId, principalId: user.homeAccountId }, job.id, user.homeAccountId, "sync_cleanup",
    );
  });

  it("aborts logout work and never publishes after the principal changes", async () => {
    const { service, repository, dependencies, job } = fixture();
    dependencies.scan.mockImplementation((_token, _ids, signal) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })));
    await service.start(user, job.id, "delegated");
    await service.waitForPrincipalAuthorization({ tenantId: user.tenantId!, principalId: user.homeAccountId });
    await service.drain();
    expect(repository.markWaitingAuthorization).toHaveBeenCalledTimes(1);
    expect(repository.publish).not.toHaveBeenCalled();
  });

  it("does not consume capacity when tenant or application scope validation fails", async () => {
    const { service, dependencies, job } = fixture();
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await expect(service.start({ ...user, tenantId: undefined }, job.id, "delegated"))
        .rejects.toMatchObject({ code: "unauthorized" });
    }
    dependencies.applicationPrincipalId.mockReturnValue("");
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await expect(service.start(user, job.id, "application")).rejects.toMatchObject({ code: "not_configured" });
    }
    await expect(service.start(user, job.id, "delegated")).resolves.toBeDefined();
    await service.drain();
  });

  it("counts each refresh once while its running-job response is pending", async () => {
    const { service, repository, dependencies, job } = fixture();
    const response = deferred<typeof job>();
    repository.getJob.mockResolvedValueOnce(job).mockReturnValueOnce(response.promise);
    dependencies.scan.mockImplementation((_token, _ids, signal) => new Promise((_resolve, reject) =>
      signal.addEventListener("abort", () => reject(signal.reason), { once: true })));
    const first = service.start(user, job.id, "delegated");
    await vi.waitFor(() => expect(dependencies.scan).toHaveBeenCalledTimes(1));
    try {
      for (let index = 2; index <= 4; index += 1) {
        await expect(service.start(user, `job-${index}`, "delegated")).resolves.toBeDefined();
      }
      await expect(service.start(user, "job-5", "delegated")).rejects.toMatchObject({ code: "package_refresh_capacity" });
    } finally {
      response.resolve(job);
      await first;
      await service.drain();
    }
  });

  it("uses persisted automatic-detail mode to reserve at most two resumptions before provider authorization", async () => {
    const { service, repository, dependencies, job } = fixture();
    repository.getJob.mockImplementation(async (_scope, id = job.id) => ({ ...job, id, autoDetails: true }));
    const authorizing = deferred<AuthenticatedUser>();
    dependencies.revalidateUser.mockReturnValue(authorizing.promise);
    dependencies.scan.mockImplementation((_token, _ids, signal) => new Promise((_resolve, reject) =>
      signal.addEventListener("abort", () => reject(signal.reason), { once: true })));
    const starts = [service.start(user, "automatic-one", "delegated"), service.start(user, "automatic-two", "delegated")];
    try {
      await vi.waitFor(() => expect(dependencies.revalidateUser).toHaveBeenCalledTimes(2));
      const third = service.start(user, "automatic-three", "delegated");
      const rejected = expect(third).rejects.toMatchObject({ code: "package_refresh_capacity" });
      authorizing.resolve(user);
      await Promise.all([...starts, rejected]);
      expect(dependencies.revalidateUser).toHaveBeenCalledTimes(2);
      expect(dependencies.scan).toHaveBeenCalledTimes(2);
    } finally {
      authorizing.resolve(user);
      await Promise.allSettled(starts);
      await service.drain();
    }
  });

  it("keeps four foreground and two persisted automatic-detail jobs in independent capacity lanes", async () => {
    const { service, repository, dependencies, job } = fixture();
    repository.getJob.mockImplementation(async (_scope, id = job.id) => ({
      ...job, id, autoDetails: id.startsWith("automatic"),
    }));
    dependencies.scan.mockImplementation((_token, _ids, signal) => new Promise((_resolve, reject) =>
      signal.addEventListener("abort", () => reject(signal.reason), { once: true })));
    try {
      for (let index = 1; index <= 4; index += 1) await service.start(user, `foreground-${index}`, "delegated");
      for (let index = 1; index <= 2; index += 1) await service.start(user, `automatic-${index}`, "delegated");
      expect(dependencies.scan).toHaveBeenCalledTimes(6);
      for (const id of ["foreground-extra", "automatic-extra"]) {
        await expect(service.start(user, id, "delegated")).rejects.toMatchObject({ code: "package_refresh_capacity" });
      }
    } finally {
      await service.drain();
    }
  });

  it.each(["getJob", "revalidateUser", "requireAvailable", "delegatedToken", "markRunning"] as const)(
    "stops startup paused at %s when its principal signs out",
    async stage => {
      const { service, repository, dependencies, job } = fixture();
      const pending = deferred<void>();
      if (stage === "getJob") repository.getJob.mockImplementationOnce(async () => { await pending.promise; return job; });
      if (stage === "revalidateUser") dependencies.revalidateUser.mockImplementationOnce(async () => { await pending.promise; return user; });
      if (stage === "requireAvailable") dependencies.requireAvailable.mockImplementationOnce(async () => { await pending.promise; });
      if (stage === "delegatedToken") dependencies.delegatedToken.mockImplementationOnce(async () => { await pending.promise; return "token"; });
      if (stage === "markRunning") repository.markRunning.mockImplementationOnce(async () => { await pending.promise; return true; });
      const boundary = stage === "getJob" || stage === "markRunning" ? repository[stage] : dependencies[stage];
      const starting = service.start(user, job.id, "delegated");
      const stopped = expect(starting).rejects.toMatchObject({ code: "interaction_required" });
      await vi.waitFor(() => expect(boundary).toHaveBeenCalledOnce());
      await service.waitForPrincipalAuthorization({ tenantId: user.tenantId!, principalId: user.homeAccountId });
      pending.resolve();
      await stopped;
      await service.drain();
      expect(dependencies.scan).not.toHaveBeenCalled();
      expect(repository.publish).not.toHaveBeenCalled();
      expect(repository.markWaitingAuthorization).toHaveBeenCalledTimes(stage === "markRunning" ? 1 : 0);
    },
  );

  it("drains in-flight admission before completing shutdown and rejects new starts", async () => {
    const { service, repository, dependencies, job } = fixture();
    const pending = deferred<AuthenticatedUser>();
    dependencies.revalidateUser.mockReturnValueOnce(pending.promise);
    const starting = service.start(user, job.id, "delegated");
    const stopped = expect(starting).rejects.toMatchObject({ code: "interaction_required" });
    await vi.waitFor(() => expect(dependencies.revalidateUser).toHaveBeenCalledOnce());
    const drained = vi.fn();
    const draining = service.drain().then(drained);
    await Promise.resolve();
    await Promise.resolve();
    const returnedEarly = drained.mock.calls.length > 0;
    pending.resolve(user);
    await stopped;
    await draining;
    expect(returnedEarly).toBe(false);
    expect(repository.markRunning).not.toHaveBeenCalled();
    expect(dependencies.scan).not.toHaveBeenCalled();
    await expect(service.start(user, "after-shutdown", "delegated")).rejects.toMatchObject({ code: "package_refresh_shutdown" });
  });

  it.each(
    (["getJob", "revalidateUser", "requireAvailable", "delegatedToken", "markRunning"] as const).flatMap(stage =>
      (["cancel", "logout", "shutdown"] as const).map(interruption => ({ stage, interruption }))),
  )("preserves $interruption when startup at $stage rejects later", async ({ stage, interruption }) => {
    const { service, repository, dependencies, job } = fixture();
    const pending = deferred<never>();
    const boundary = stage === "getJob" || stage === "markRunning" ? repository[stage] : dependencies[stage];
    boundary.mockReturnValueOnce(pending.promise);
    const starting = service.start(user, job.id, "delegated");
    const stopped = expect(starting).rejects.toMatchObject({
      code: interruption === "cancel" ? "read_job_cancelled" : "interaction_required",
    });
    await vi.waitFor(() => expect(boundary).toHaveBeenCalledOnce());
    if (interruption === "cancel") await service.cancel(user, job.id, "delegated");
    else if (interruption === "logout") await service.waitForPrincipalAuthorization({ tenantId: user.tenantId!, principalId: user.homeAccountId });
    const drained = expect(service.drain()).resolves.toBeUndefined();
    pending.reject(new Error("Late startup dependency failure."));
    await Promise.all([stopped, drained]);
    expect(dependencies.scan).not.toHaveBeenCalled();
    expect(repository.publish).not.toHaveBeenCalled();
    expect(repository.markFailed).not.toHaveBeenCalled();
  });

  it.each(["getJob", "revalidateUser", "requireAvailable", "delegatedToken", "markRunning"] as const)(
    "propagates a startup failure at %s when not interrupted",
    async stage => {
      const { service, repository, dependencies, job } = fixture();
      const failure = new Error("Startup dependency failure.");
      const boundary = stage === "getJob" || stage === "markRunning" ? repository[stage] : dependencies[stage];
      boundary.mockRejectedValueOnce(failure);
      await expect(service.start(user, job.id, "delegated")).rejects.toBe(failure);
      expect(dependencies.scan).not.toHaveBeenCalled();
      await service.drain();
    },
  );

  it.each(["cancel", "shutdown"] as const)("surfaces persistence failure while cleaning up %s during startup", async interruption => {
    const { service, repository, dependencies, job } = fixture();
    const pending = deferred<boolean>();
    const failure = new Error("Startup cleanup persistence failure.");
    repository.markRunning.mockReturnValueOnce(pending.promise);
    const starting = service.start(user, job.id, "delegated");
    const stopped = expect(starting).rejects.toBe(failure);
    await vi.waitFor(() => expect(repository.markRunning).toHaveBeenCalledOnce());
    if (interruption === "cancel") {
      await service.cancel(user, job.id, "delegated");
      repository.cancel.mockRejectedValueOnce(failure);
    } else {
      repository.markWaitingAuthorization.mockRejectedValueOnce(failure);
    }
    const drained = expect(service.drain()).rejects.toBe(failure);
    pending.resolve(true);
    await Promise.all([stopped, drained]);
    expect(dependencies.scan).not.toHaveBeenCalled();
    expect(repository.publish).not.toHaveBeenCalled();
  });

  it("rejects a duplicate admission without consuming another slot", async () => {
    const { service, dependencies, job } = fixture();
    const pending = deferred<AuthenticatedUser>();
    dependencies.revalidateUser.mockReturnValueOnce(pending.promise);
    const starting = service.start(user, job.id, "delegated");
    await expect(service.start(user, job.id, "delegated")).rejects.toMatchObject({ code: "package_refresh_state" });
    pending.resolve(user);
    await starting;
    await service.drain();
    expect(dependencies.scan).toHaveBeenCalledOnce();
  });

  it.each(["cancel", "logout"] as const)("drains admission already stopped by %s", async action => {
    const { service, repository, dependencies, job } = fixture();
    const pending = deferred<boolean>();
    repository.markRunning.mockReturnValueOnce(pending.promise);
    const starting = service.start(user, job.id, "delegated");
    const stopped = expect(starting).rejects.toMatchObject({
      code: action === "cancel" ? "read_job_cancelled" : "interaction_required",
    });
    await vi.waitFor(() => expect(repository.markRunning).toHaveBeenCalledOnce());
    if (action === "cancel") await service.cancel(user, job.id, "delegated");
    else await service.waitForPrincipalAuthorization({ tenantId: user.tenantId!, principalId: user.homeAccountId });
    const draining = service.drain();
    pending.resolve(true);
    await stopped;
    await draining;
    expect(dependencies.scan).not.toHaveBeenCalled();
    expect(repository.markWaitingAuthorization).toHaveBeenCalledTimes(action === "logout" ? 1 : 0);
    expect(repository.cancel).toHaveBeenCalledTimes(action === "cancel" ? 2 : 0);
  });

  it.each(["starting", "running"] as const)("conceals a %s job from other principals and tenants", async phase => {
    const { service, dependencies, repository, job } = fixture();
    const pending = deferred<AuthenticatedUser>();
    if (phase === "starting") dependencies.revalidateUser.mockReturnValueOnce(pending.promise);
    dependencies.scan.mockImplementation((_token, _ids, signal) => new Promise((_resolve, reject) =>
      signal.addEventListener("abort", () => reject(signal.reason), { once: true })));
    const starting = service.start(user, job.id, "delegated");
    await vi.waitFor(() => expect(dependencies.revalidateUser).toHaveBeenCalledOnce());
    if (phase === "running") await starting;
    try {
      const reads = repository.getJob.mock.calls.length;
      for (const other of [{ ...user, homeAccountId: "other-principal" }, { ...user, tenantId: "other-tenant" }]) {
        await expect(service.start(other, job.id, "delegated")).rejects.toMatchObject({ status: 404, code: "not_found" });
      }
      expect(repository.getJob).toHaveBeenCalledTimes(reads);
      expect(dependencies.revalidateUser).toHaveBeenCalledOnce();
    } finally {
      pending.resolve(user);
      await starting;
      await service.drain();
    }
  });

  it.each(["uppercase", "lowercase"] as const)("matches mixed-case UUID resume and cancellation after %s admission", async casing => {
    const { service, dependencies, job, repository } = fixture();
    job.id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    repository.markRunning.mockResolvedValueOnce(true).mockResolvedValue(false);
    let scanSignal: AbortSignal | undefined;
    dependencies.scan.mockImplementation((_token, _ids, signal) => new Promise((_resolve, reject) => {
      scanSignal = signal;
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }));
    const startId = casing === "uppercase" ? job.id.toUpperCase() : job.id;
    const otherId = casing === "uppercase" ? job.id : job.id.toUpperCase();
    await service.start(user, startId, "delegated");
    try {
      await expect(service.start(user, otherId, "delegated")).rejects.toMatchObject({ code: "package_refresh_state" });
      await service.cancel(user, otherId, "delegated");
      expect(scanSignal?.aborted).toBe(true);
      expect(scanSignal?.reason).toMatchObject({ code: "read_job_cancelled" });
      expect(dependencies.scan).toHaveBeenCalledOnce();
      expect(repository.markRunning).toHaveBeenCalledWith({ tenantId: user.tenantId, principalId: user.homeAccountId }, job.id);
    } finally {
      await service.drain();
    }
  });

  it.each(
    (["cancel", "logout", "shutdown", "deadline"] as const).flatMap(interruption =>
      (["resolves", "rejects"] as const).map(settlement => ({ interruption, settlement }))),
  )(
    "preserves the $interruption outcome when pending publication authorization $settlement later",
    async ({ interruption, settlement }) => {
      const { service, dependencies, repository, job } = fixture();
      const pending = deferred<AuthenticatedUser>();
      const deadline = new AbortController();
      vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
      dependencies.revalidateUser.mockResolvedValueOnce(user).mockReturnValueOnce(pending.promise);
      await service.start(user, job.id, "delegated");
      await vi.waitFor(() => expect(dependencies.revalidateUser).toHaveBeenCalledTimes(2));
      let draining: Promise<void> | undefined;
      if (interruption === "cancel") await service.cancel(user, job.id, "delegated");
      else if (interruption === "logout") await service.waitForPrincipalAuthorization({ tenantId: user.tenantId!, principalId: user.homeAccountId });
      else if (interruption === "shutdown") draining = service.drain();
      deadline.abort(new DOMException("Execution deadline", "TimeoutError"));
      if (settlement === "resolves") pending.resolve(user);
      else pending.reject(interruption === "deadline"
        ? new AppError(401, "interaction_required", "Late authorization failure.")
        : new Error("Late authorization transport failure."));
      await (draining ?? service.drain());
      expect(repository.publish).not.toHaveBeenCalled();
      expect(getEventListeners(deadline.signal, "abort")).toHaveLength(0);
      if (interruption === "deadline") {
        expect(repository.markFailed).toHaveBeenCalledWith(
          { tenantId: user.tenantId, principalId: user.homeAccountId }, job.id,
          "package_refresh_timeout", expect.stringContaining("execution deadline"),
        );
        expect(repository.markWaitingAuthorization).not.toHaveBeenCalled();
      } else {
        expect(repository.markFailed).not.toHaveBeenCalled();
        expect(repository.markWaitingAuthorization).toHaveBeenCalledTimes(interruption === "cancel" ? 0 : 1);
        expect(repository.cancel).toHaveBeenCalledTimes(interruption === "cancel" ? 2 : 0);
      }
    },
  );

  it("does not join pending authorization while logout holds the account mutation lock", async () => {
    const { service, repository, dependencies, job } = fixture();
    const scopedUser = { ...user, homeAccountId: "package-start-lock" };
    repository.getJob.mockResolvedValue({ ...job, authorizationPrincipalId: scopedUser.homeAccountId });
    const pending = deferred<AuthenticatedUser>();
    dependencies.revalidateUser.mockReturnValueOnce(pending.promise);
    const starting = service.start(scopedUser, job.id, "delegated");
    const stopped = expect(starting).rejects.toMatchObject({ status: 401 });
    await vi.waitFor(() => expect(dependencies.revalidateUser).toHaveBeenCalledOnce());
    await revokeAccountSessionMutations(user.tenantId!, scopedUser.homeAccountId, async () => {
      pending.resolve(scopedUser);
      await Promise.resolve();
      await service.waitForPrincipalAuthorization({ tenantId: user.tenantId!, principalId: scopedUser.homeAccountId });
    });
    await stopped;
    await service.drain();
    expect(dependencies.scan).not.toHaveBeenCalled();
  });

  it.each([
    { mode: "delegated", stage: "requireAvailable" },
    { mode: "delegated", stage: "delegatedToken" },
    { mode: "application", stage: "requireApplicationDataScope" },
    { mode: "application", stage: "requireAvailable" },
    { mode: "application", stage: "applicationToken" },
  ] as const)("does not block sign-out while $mode admission waits for $stage", async ({ mode, stage }) => {
    const currentUser = { ...user, homeAccountId: `admission-signout-${mode}-${stage}` };
    const currentJob = { ...fixture().job, tokenMode: mode, authorizationPrincipalId: currentUser.homeAccountId };
    const { service, repository, dependencies } = fixture({ getJob: vi.fn(async () => currentJob) });
    const pending = deferred<void>();
    dependencies.revalidateUser.mockResolvedValue(currentUser);
    if (stage === "requireAvailable" || stage === "requireApplicationDataScope") {
      dependencies[stage].mockImplementationOnce(async () => { await pending.promise; });
    } else {
      dependencies[stage].mockImplementationOnce(async () => { await pending.promise; return "token"; });
    }
    const starting = service.start(currentUser, currentJob.id, mode);
    const stopped = expect(starting).rejects.toMatchObject({ code: "interaction_required" });
    await vi.waitFor(() => expect(dependencies[stage]).toHaveBeenCalledOnce());
    let signedOut = false;
    const revoking = revokeAccountSessionMutations(currentUser.tenantId!, currentUser.homeAccountId, async () => {
      await service.waitForPrincipalAuthorization({ tenantId: currentUser.tenantId!, principalId: currentUser.homeAccountId });
      signedOut = true;
    });
    try {
      await vi.waitFor(() => expect(signedOut).toBe(true), { timeout: 200 });
    } finally {
      pending.resolve();
      await Promise.all([stopped, revoking]);
      await service.drain();
    }
    expect(repository.markRunning).not.toHaveBeenCalled();
    expect(dependencies.scan).not.toHaveBeenCalled();
    expect(repository.publish).not.toHaveBeenCalled();
  });

  it.each(["delegated", "application"] as const)(
    "fences %s admission against revocation even before cancellation is delivered",
    async mode => {
      const currentUser = { ...user, homeAccountId: `admission-generation-${mode}` };
      const currentJob = { ...fixture().job, tokenMode: mode, authorizationPrincipalId: currentUser.homeAccountId };
      const { service, repository, dependencies } = fixture({ getJob: vi.fn(async () => currentJob) });
      const pending = deferred<void>();
      dependencies.revalidateUser.mockResolvedValue(currentUser);
      dependencies.requireAvailable.mockReturnValueOnce(pending.promise);
      const starting = service.start(currentUser, currentJob.id, mode);
      const stopped = expect(starting).rejects.toMatchObject({ code: "unauthorized" });
      await vi.waitFor(() => expect(dependencies.requireAvailable).toHaveBeenCalledOnce());
      const revoking = revokeAccountSessionMutations(currentUser.tenantId!, currentUser.homeAccountId, async () => undefined);
      pending.resolve();
      try {
        await Promise.all([stopped, revoking]);
        expect(repository.markRunning).not.toHaveBeenCalled();
        expect(dependencies.scan).not.toHaveBeenCalled();
        expect(repository.publish).not.toHaveBeenCalled();
      } finally {
        await service.drain();
      }
    },
  );

  it.each(["cancel", "logout", "shutdown", "deadline"] as const)(
    "does not begin a publication capability check after %s interrupts application-scope authorization",
    async interruption => {
      const applicationJob = { ...fixture().job, tokenMode: "application" as const };
      const { service, repository, dependencies } = fixture({ getJob: vi.fn(async () => applicationJob) });
      const pending = deferred<void>();
      const deadline = new AbortController();
      vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
      dependencies.requireApplicationDataScope.mockResolvedValueOnce(undefined).mockReturnValueOnce(pending.promise);
      await service.start(user, applicationJob.id, "application");
      await vi.waitFor(() => expect(dependencies.requireApplicationDataScope).toHaveBeenCalledTimes(2));
      if (interruption === "cancel") await service.cancel(user, applicationJob.id, "application");
      else if (interruption === "logout") await service.waitForPrincipalAuthorization({ tenantId: user.tenantId!, principalId: user.homeAccountId });
      else if (interruption === "deadline") deadline.abort(new DOMException("Execution deadline", "TimeoutError"));
      const draining = service.drain();
      pending.resolve();
      await draining;
      expect(dependencies.requireAvailable).toHaveBeenCalledTimes(1);
      expect(repository.publish).not.toHaveBeenCalled();
      expect(getEventListeners(deadline.signal, "abort")).toHaveLength(0);
      if (interruption === "deadline") {
        expect(repository.markFailed).toHaveBeenCalledWith(
          expect.anything(), applicationJob.id, "package_refresh_timeout", expect.stringContaining("execution deadline"),
        );
        expect(repository.markWaitingAuthorization).not.toHaveBeenCalled();
      } else {
        expect(repository.markFailed).not.toHaveBeenCalled();
        expect(repository.markWaitingAuthorization).toHaveBeenCalledTimes(interruption === "cancel" ? 0 : 1);
        expect(repository.cancel).toHaveBeenCalledTimes(interruption === "cancel" ? 2 : 0);
      }
    },
  );

  it.each(["requireApplicationDataScope", "applicationToken"] as const)(
    "stops an application read paused at %s using the authorizing user's scope",
    async stage => {
      const applicationJob = { ...fixture().job, tokenMode: "application" as const };
      const { service, repository, dependencies } = fixture({ getJob: vi.fn(async () => applicationJob) });
      const pending = deferred<void>();
      if (stage === "requireApplicationDataScope") dependencies.requireApplicationDataScope.mockImplementationOnce(async () => { await pending.promise; });
      else dependencies.applicationToken.mockImplementationOnce(async () => { await pending.promise; return "token"; });
      const starting = service.start(user, applicationJob.id, "application");
      const stopped = expect(starting).rejects.toMatchObject({ code: "interaction_required" });
      await vi.waitFor(() => expect(dependencies[stage]).toHaveBeenCalledOnce());
      await service.waitForPrincipalAuthorization({ tenantId: user.tenantId!, principalId: user.homeAccountId });
      pending.resolve();
      await stopped;
      await service.drain();
      expect(repository.markRunning).not.toHaveBeenCalled();
      expect(dependencies.scan).not.toHaveBeenCalled();
    },
  );

  it.each([
    { ...user, roles: [] },
    { ...user, homeAccountId: "different-principal" },
    { ...user, tenantId: "different-tenant" },
  ])("does not publish when the current user changes to %j", async freshUser => {
    const { service, repository, dependencies, job } = fixture();
    dependencies.revalidateUser.mockResolvedValueOnce(user).mockResolvedValueOnce(freshUser);
    await service.start(user, job.id, "delegated");
    if (!freshUser.roles.length) {
      await vi.waitFor(() => expect(repository.markFailed).toHaveBeenCalledWith(
        expect.anything(), job.id, "missing_internal_role", expect.stringContaining("permission")));
      expect(repository.markWaitingAuthorization).not.toHaveBeenCalled();
    } else await vi.waitFor(() => expect(repository.markWaitingAuthorization).toHaveBeenCalledOnce());
    expect(repository.publish).not.toHaveBeenCalled();
    await service.drain();
  });

  it("reports background persistence failure even when no caller is draining", async () => {
    const { service, repository, dependencies, job } = fixture();
    const failure = new Error("private database failure detail");
    dependencies.scan.mockRejectedValue(new AppError(502, "provider_error", "Provider failed."));
    repository.markFailed.mockRejectedValueOnce(failure);
    await service.start(user, job.id, "delegated");
    await vi.waitFor(() => expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('"event":"package_refresh_status_failed"'),
    ));
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(failure.message);
    expect(repository.publish).not.toHaveBeenCalled();
  });

  it("observes sanitized background persistence failures and still rejects an in-flight drain", async () => {
    const { service, repository, dependencies, job } = fixture();
    const pending = deferred<void>();
    const failure = new Error("private database failure detail");
    dependencies.scan.mockRejectedValue(new AppError(502, "provider_error", "Provider failed."));
    repository.markFailed.mockReturnValueOnce(pending.promise);
    await service.start(user, job.id, "delegated");
    await vi.waitFor(() => expect(repository.markFailed).toHaveBeenCalledOnce());
    const drained = expect(service.drain()).rejects.toBe(failure);
    pending.reject(failure);
    await drained;
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('"event":"package_refresh_status_failed"'));
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining(`"jobId":"${job.id}"`));
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(failure.message);
  });

  it("still reports persistence failure when shutdown wins over a late authorization rejection", async () => {
    const { service, repository, dependencies, job } = fixture();
    const pending = deferred<AuthenticatedUser>();
    const failure = new Error("private authorization-wait persistence failure");
    dependencies.revalidateUser.mockResolvedValueOnce(user).mockReturnValueOnce(pending.promise);
    repository.markWaitingAuthorization.mockRejectedValueOnce(failure);
    await service.start(user, job.id, "delegated");
    await vi.waitFor(() => expect(dependencies.revalidateUser).toHaveBeenCalledTimes(2));
    const drained = expect(service.drain()).rejects.toBe(failure);
    pending.reject(new Error("Late authorization transport failure."));
    await drained;
    expect(repository.markFailed).not.toHaveBeenCalled();
    expect(repository.publish).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('"event":"package_refresh_status_failed"'));
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(failure.message);
  });
});