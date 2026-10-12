import { randomUUID } from "node:crypto";
import { getEventListeners } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "../errors.js";
import { activateAccountSession, revokeAccountSessionMutations } from "../db/sessions.js";
import type { AuthenticatedUser } from "../types/session.js";
import { PackageInventoryService } from "./packageInventory.js";
import type { StreamedInventory } from "./streamedInventory.js";
import { graphError } from "./graphPackages.js";
import { inventoryJobInput, inventoryRuntime } from "./inventoryRuntime.js";
import { packageRefreshExecutionDeadlineMs } from "./packageRefreshPolicy.js";
import * as operationalState from "./operationalState.js";

vi.mock("../db/pool.js", () => ({
  pool: {}, secretValue: vi.fn(),
  transaction: vi.fn(async () => { throw new Error("Unit tests must not access a database."); }),
}));
vi.mock("connect-pg-simple", () => ({
  default: () => class { constructor() { throw new Error("Unit tests must not construct a session store."); } },
}));
vi.mock("./inventoryRuntime.js", () => ({
  inventoryJobInput: vi.fn(async (database: { complete: () => Promise<void> }, scope: unknown, _domain: string, jobId: string) => ({
    database, scope, jobId, deadlineAt: new Date(Date.now() + packageRefreshExecutionDeadlineMs),
  })),
  completeInventoryJob: (input: { database: { complete: () => Promise<void> } }) => async () => input.database.complete(),
  inventoryRuntime: vi.fn(() => ({ enqueue: async () => false })),
}));

type Options = Parameters<StreamedInventory["graphCatalog"]>[2];
const services: PackageInventoryService[] = [];
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
function fixture(options: { autoDetails?: boolean; exact?: boolean; application?: boolean } = {}) {
  const owner: AuthenticatedUser = { tenantId: "synthetic-package-tenant", homeAccountId: randomUUID(),
    displayName: "Reader", username: "synthetic@example.invalid", roles: ["AgentControl.Viewer"] };
  const job = {
    id: randomUUID(), authorizationPrincipalId: owner.homeAccountId, tokenMode: options.application ? "application" as const : "delegated" as const,
    scopeKind: options.exact || options.autoDetails ? "exact" as const : "broad" as const,
    autoDetails: options.autoDetails ?? false, targetCount: options.exact || options.autoDetails ? 20 : 0,
    status: "waiting_authorization", pageCount: 0, observedCount: 0, totalRecords: null as number | null,
    snapshotId: null, createdAt: "2026-09-09T00:00:00.000Z", attemptedAt: null,
    updatedAt: "2026-09-09T00:00:00.000Z", resultRevision: "2026-09-09 00:00:00+00", finishedAt: null,
  };
  const repository = {
    detailCoverage: vi.fn(async () => ({ catalog_available: true, total: 40, fresh: 0, eligible: 40 })),
    submit: vi.fn(async () => job), getJob: vi.fn(async (_scope?: unknown, id = job.id): Promise<typeof job | undefined> => ({ ...job, id })),
    claimDueDetails: vi.fn(async () => null as typeof job | null), latestAutomaticDetailsJob: vi.fn(async () => null as typeof job | null),
    markRunning: vi.fn(async () => true), recordProgress: vi.fn(async () => undefined), complete: vi.fn(async () => undefined),
    markWaitingAuthorization: vi.fn(async () => undefined), markFailed: vi.fn(async () => job),
    cancel: vi.fn(async (): Promise<typeof job | undefined> => ({ ...job, status: "cancelled" })), recoverInterrupted: vi.fn(async () => 0),
  };
  const collection = vi.fn(async (_token: string, _options: Options) => {});
  const execute = async (_input: unknown, token: string, options: Options) => {
    await options.authorize(options.signal!);
    await collection(token, options);
    await options.authorize(options.signal!);
    expect(options.commitPublication).toBeTypeOf("function");
    await options.commitPublication!(() => options.completeJob!({} as never, {} as never));
    options.onCommitted?.();
  };
  const streams = {
    graphCatalog: vi.fn(execute),
    exactJob: vi.fn(async (input: unknown, token: string, _automatic: boolean, options: Options) => execute(input, token, options)),
  };
  const dependencies = {
    observeOperation: vi.fn(async (_id: unknown, _user: unknown, operation: (failure: (error: unknown) => void) => Promise<unknown>) => operation(() => {})),
    revalidateUser: vi.fn(async () => owner), delegatedToken: vi.fn(async () => "synthetic-delegated"),
    applicationToken: vi.fn(async () => "synthetic-application"), requireAvailable: vi.fn(async () => undefined),
    beginOperationValidation: vi.fn(() => () => undefined),
    requireApplicationDataScope: vi.fn(async (): Promise<void> => undefined), applicationPrincipalId: vi.fn(() => "synthetic-application-id"),
    wait: vi.fn(async (_milliseconds: number, signal: AbortSignal) => { signal.throwIfAborted(); }),
    streams: () => streams,
  };
  const service = new PackageInventoryService({ ...repository, database: { complete: () => repository.complete() } } as never, dependencies as never);
  services.push(service);
  const start = () => service.start(owner, job.id, job.tokenMode);
  return { owner, job, repository, dependencies, streams, collection, service, start };
}
function pendingCollection(f: ReturnType<typeof fixture>) {
  f.collection.mockImplementation((_token, options) => new Promise((_resolve, reject) => {
    options.signal!.addEventListener("abort", () => reject(options.signal!.reason), { once: true });
  }));
}

describe("streamed package refresh service", () => {
  beforeEach(async () => {
    await operationalState.loadOperationalState({ query: vi.fn().mockResolvedValue({ rowCount: 1, rows: [{
      mode: "normal", provider_work_enabled: true, restored_from_at: null, deletion_reviewed_at: null, access_reviewed_at: null,
    }] }) });
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(inventoryRuntime).mockReset().mockReturnValue({ enqueue: async () => false } as never);
  });
  afterEach(async () => {
    await Promise.allSettled(services.splice(0).map(service => service.drain()));
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("exposes exact-detail completeness independently of catalog publication and distinguishes an empty catalog from no catalog", async () => {
    const f = fixture();
    await expect(f.service.detailSyncState(f.owner)).resolves.toMatchObject({
      status: "ready", total: 40, fresh: 0, pending: 40, eligible: 40, job: null,
    });
    f.repository.detailCoverage.mockResolvedValue({ catalog_available: false, total: 0, fresh: 0, eligible: 0 });
    await expect(f.service.detailSyncState(f.owner)).resolves.toMatchObject({ status: "not_collected", total: 0 });
    f.repository.detailCoverage.mockResolvedValue({ catalog_available: true, total: 0, fresh: 0, eligible: 0 });
    await expect(f.service.detailSyncState(f.owner)).resolves.toMatchObject({ status: "complete", pending: 0 });
  });

  it("continues paced detail batches to completion without another browser request", async () => {
    const f = fixture({ autoDetails: true });
    const first = { ...f.job, status: "succeeded" as const, observedCount: 20 };
    const second = { ...first, id: randomUUID() };
    const refresh = vi.spyOn(f.service, "refreshDueDetails").mockResolvedValueOnce(first)
      .mockImplementationOnce(async () => {
        f.repository.detailCoverage.mockResolvedValue({ catalog_available: true, total: 40, fresh: 40, eligible: 0 });
        f.repository.latestAutomaticDetailsJob.mockResolvedValue(second);
        return second;
      }).mockResolvedValue(null);
    await f.service.startDetailSync(f.owner);
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(3));
    await expect(f.service.detailSyncState(f.owner)).resolves.toMatchObject({
      status: "complete", total: 40, fresh: 40, pending: 0, job: { targetCount: 20 },
    });
  });

  it("stops the detail collection on a failed batch and reports the actual permission failure", async () => {
    const f = fixture({ autoDetails: true });
    const failed = { ...f.job, status: "failed" as const, errorCode: "missing_permission", message: "Microsoft package read permission is required." };
    f.repository.latestAutomaticDetailsJob.mockResolvedValue(failed);
    const refresh = vi.spyOn(f.service, "refreshDueDetails").mockResolvedValue(failed);
    await f.service.startDetailSync(f.owner);
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    await expect(f.service.detailSyncState(f.owner)).resolves.toMatchObject({
      status: "permission_required", pending: 40, message: failed.message,
    });
  });

  it("deduplicates detail collection starts and aborts an outstanding job observation on cancellation", async () => {
    const f = fixture({ autoDetails: true });
    const running = { ...f.job, status: "running" as const };
    const cancelled = { ...f.job, status: "cancelled" as const };
    const held = deferred<typeof f.job | undefined>();
    f.repository.getJob.mockReturnValueOnce(held.promise).mockResolvedValue(running);
    f.repository.latestAutomaticDetailsJob.mockResolvedValue(running);
    f.repository.cancel.mockImplementation(async () => {
      f.repository.latestAutomaticDetailsJob.mockResolvedValue(cancelled);
      return cancelled;
    });
    const refresh = vi.spyOn(f.service, "refreshDueDetails").mockResolvedValue(running);
    await Promise.all([f.service.startDetailSync(f.owner), f.service.startDetailSync(f.owner)]);
    await vi.waitFor(() => expect(f.repository.getJob).toHaveBeenCalledOnce());
    await expect(f.service.cancelDetailSync(f.owner)).resolves.toMatchObject({ status: "paused", pending: 40 });
    expect(refresh).toHaveBeenCalledOnce();
    held.resolve(cancelled);
  });

  it("does not let a previously admitted catalog run restart cancelled details and permits an explicit resume", async () => {
    const f = fixture({ autoDetails: true });
    const requestedAt = Date.now() - 1;
    await f.service.cancelDetailSync(f.owner);
    const refresh = vi.spyOn(f.service, "refreshDueDetails").mockResolvedValue(null);
    await expect(f.service.startDetailSync(f.owner, undefined, requestedAt)).resolves.toMatchObject({ status: "paused" });
    expect(refresh).not.toHaveBeenCalled();
    await f.service.startDetailSync(f.owner);
    expect(refresh).toHaveBeenCalledOnce();
  });
  it("honors persisted automatic detail cancellation after a process or browser restart", async () => {
    const f = fixture({ autoDetails: true });
    f.repository.latestAutomaticDetailsJob.mockResolvedValue({ ...f.job, status: "cancelled" });
    await expect(f.service.detailSyncState(f.owner)).resolves.toMatchObject({ status: "paused", pending: 40 });
    await expect(f.service.refreshDueDetails(f.owner)).resolves.toMatchObject({ status: "cancelled" });
    expect(f.repository.claimDueDetails).not.toHaveBeenCalled();
    expect(f.dependencies.delegatedToken).not.toHaveBeenCalled();
  });
  it("persists cancellation even when its first batch claim finishes after the cancellation request", async () => {
    const f = fixture({ autoDetails: true }), pending = deferred<typeof f.job>();
    f.repository.claimDueDetails.mockReturnValueOnce(pending.promise);
    f.repository.cancel.mockImplementation(async () => {
      const cancelled = { ...f.job, status: "cancelled" };
      f.repository.latestAutomaticDetailsJob.mockResolvedValue(cancelled);
      return cancelled;
    });
    const starting = expect(f.service.startDetailSync(f.owner)).rejects.toMatchObject({ code: "read_job_cancelled" });
    await vi.waitFor(() => expect(f.repository.claimDueDetails).toHaveBeenCalledOnce());
    const cancelling = f.service.cancelDetailSync(f.owner);
    await vi.waitFor(() => expect(f.repository.latestAutomaticDetailsJob).toHaveBeenCalledTimes(2));
    pending.resolve(f.job);
    await starting;
    await expect(cancelling).resolves.toMatchObject({ status: "paused", job: { status: "cancelled" } });
    expect(f.repository.cancel).toHaveBeenCalledWith(expect.any(Object), f.job.id, f.owner.homeAccountId);
    expect(f.repository.markFailed).not.toHaveBeenCalled();
    expect(f.dependencies.delegatedToken).not.toHaveBeenCalled();
  });

  it.each([{ exact: false }, { exact: true }, { autoDetails: true }])(
    "chooses only the persisted bounded pipeline and authorizes admission, collection and publication: %j", async mode => {
      const f = fixture(mode);
      await f.start();
      await vi.waitFor(() => expect(f.repository.complete).toHaveBeenCalledOnce());
      expect(f.dependencies.revalidateUser).toHaveBeenCalledTimes(3);
      expect(f.dependencies.requireAvailable).toHaveBeenCalledTimes(3);
      expect(f.dependencies.requireAvailable).toHaveBeenLastCalledWith("graph.package.read.delegated", f.owner, { retryFailed: true });
      expect(f.repository.markRunning).toHaveBeenCalledBefore(f.collection);
      expect(f.collection).toHaveBeenCalledOnce();
      expect(f.collection.mock.calls[0][1].retryThrottlingUntilAborted).toBe(!mode.autoDetails);
      expect(f.collection.mock.calls[0][1].executionDeadlineAt).toBeGreaterThan(Date.now());
      expect(f.streams.graphCatalog).toHaveBeenCalledTimes(mode.exact || mode.autoDetails ? 0 : 1);
      expect(f.streams.exactJob).toHaveBeenCalledTimes(mode.exact || mode.autoDetails ? 1 : 0);
      if (mode.exact || mode.autoDetails) expect(f.streams.exactJob.mock.calls[0][2]).toBe(Boolean(mode.autoDetails));
      expect(f.job).not.toHaveProperty("requestedIds");
      expect(f.job).not.toHaveProperty("catalogOnly");
    },
  );

  it.each([false, true])("renews %s-mode tokens through the fenced page callback", async application => {
    const f = fixture({ application });
    const token = application ? f.dependencies.applicationToken : f.dependencies.delegatedToken;
    token.mockResolvedValueOnce("initial").mockResolvedValue("renewed");
    f.collection.mockImplementation(async (initial, options) => {
      expect(initial).toBe("initial");
      expect(await options.getAccessToken!()).toBe("renewed");
      expect(await options.getAccessToken!()).toBe("renewed");
    });
    await f.start();
    await vi.waitFor(() => expect(f.repository.complete).toHaveBeenCalledOnce());
    expect(token).toHaveBeenCalledTimes(3);
    if (application) {
      expect(f.dependencies.delegatedToken).not.toHaveBeenCalled();
      expect(f.dependencies.requireApplicationDataScope).toHaveBeenCalledTimes(3);
      expect(inventoryRuntime).not.toHaveBeenCalled();
    } else expect(inventoryRuntime).toHaveBeenCalledOnce();
  });

  it.each([false, true])("persists scalar progress and retry notices without source arrays (exact=%s)", async exact => {
    const f = fixture({ exact });
    f.collection.mockImplementation(async (_token, options) => {
      await options.onProgress!({ pages: 1, observedCount: 5 });
      await options.onRetry!({ attempt: 1, retryDelayMs: 30_000, throttled: true });
      await options.onProgress!({ pages: 2, observedCount: 20, totalRecords: 20 });
    });
    await f.start();
    await vi.waitFor(() => expect(f.repository.complete).toHaveBeenCalledOnce());
    expect(f.repository.recordProgress.mock.calls).toEqual([
      [expect.anything(), f.job.id, 1, 5, exact ? 20 : null],
      [expect.anything(), f.job.id, 1, 5, exact ? 20 : null,
        expect.stringContaining(`30 seconds before retrying (5 ${exact ? "targets checked" : "packages observed"})`)],
      [expect.anything(), f.job.id, 2, 20, 20],
    ]);
  });

  it.each([false, true])("resets resumed %s-scope progress before a new attempt observes any packages", async exact => {
    const f = fixture({ exact });
    Object.assign(f.job, { pageCount: 7, observedCount: 12, totalRecords: 20 });
    f.collection.mockImplementation(async (_token, options) => {
      await options.onRetry!({ attempt: 1, retryDelayMs: 1_000, throttled: true });
      await options.onProgress!({ pages: exact ? 0 : 1, observedCount: 1 });
    });
    await f.start();
    await vi.waitFor(() => expect(f.repository.complete).toHaveBeenCalledOnce());
    expect(f.repository.recordProgress.mock.calls).toEqual([
      [expect.anything(), f.job.id, 0, 0, null, expect.stringContaining(`(0 ${exact ? "targets checked" : "packages observed"})`)],
      [expect.anything(), f.job.id, exact ? 0 : 1, 1, exact ? 20 : null],
    ]);
    expect(f.collection).toHaveBeenCalledOnce();
  });

  it.each(["start", "cancel"] as const)("rejects an expired %s status handoff instead of returning an empty successful response", async action => {
    const f = fixture();
    pendingCollection(f);
    if (action === "start") f.repository.getJob.mockResolvedValueOnce(f.job).mockResolvedValueOnce(undefined);
    else f.repository.cancel.mockResolvedValueOnce(undefined);
    await expect(action === "start" ? f.start() : f.service.cancel(f.owner, f.job.id, "delegated"))
      .rejects.toMatchObject({ status: 409, code: "package_refresh_expired" });
    expect(f.repository.complete).not.toHaveBeenCalled();
  });

  it.each(["collection", "publication"])("settles a stalled %s progress write without publishing or leaving the refresh running", async stage => {
    vi.useFakeTimers();
    vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException("deadline", "TimeoutError")), ms);
      return controller.signal;
    });
    const f = fixture({ exact: true }), pending = deferred<undefined>();
    f.repository.recordProgress.mockReturnValueOnce(pending.promise);
    if (stage === "collection") f.collection.mockImplementation(async (_token, options) => {
      await options.onProgress!({ pages: 0, observedCount: 1 });
    });
    else f.dependencies.requireAvailable.mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new AppError(504, "provider_timeout", "Publication readiness is temporarily unavailable."));
    await f.start();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(f.repository.markFailed).toHaveBeenCalledWith(expect.anything(), f.job.id, "provider_timeout",
      expect.stringContaining("bounded deadline"));
    expect(f.repository.complete).not.toHaveBeenCalled();
    pending.reject(new Error("Observed late progress rejection."));
    await vi.advanceTimersByTimeAsync(0);
    expect(f.repository.markFailed).toHaveBeenCalledOnce();
  });

  it("rejects a late admission token even when its thirty-second timer is delayed", async () => {
    let elapsed = 0;
    vi.spyOn(performance, "now").mockImplementation(() => elapsed);
    vi.spyOn(AbortSignal, "timeout").mockImplementation(() => new AbortController().signal);
    const f = fixture();
    f.dependencies.delegatedToken.mockImplementationOnce(async () => {
      elapsed = 30_001;
      return "late-token";
    });
    await expect(f.start()).rejects.toMatchObject({ code: "provider_timeout" });
    expect(f.collection).not.toHaveBeenCalled();
    expect(f.repository.markRunning).not.toHaveBeenCalled();
  });

  it("reports execution expiry truthfully even when the deadline timer has not been delivered", async () => {
    let elapsed = 0;
    vi.spyOn(performance, "now").mockImplementation(() => elapsed);
    vi.spyOn(AbortSignal, "timeout").mockImplementation(() => new AbortController().signal);
    const f = fixture();
    f.collection.mockImplementation(async (_token, options) => {
      elapsed = packageRefreshExecutionDeadlineMs + 1;
      await options.onProgress!({ pages: 1, observedCount: 1 });
    });
    await f.start();
    await vi.waitFor(() => expect(f.repository.markFailed).toHaveBeenCalledOnce());
    expect(f.repository.markFailed).toHaveBeenCalledWith(expect.anything(), f.job.id, "package_refresh_timeout",
      expect.stringContaining("four-hour execution deadline"));
    expect(f.repository.complete).not.toHaveBeenCalled();
  });

  it("interrupts pending authorization at an earlier persisted deadline instead of renewing the package budget", async () => {
    vi.useFakeTimers();
    vi.spyOn(AbortSignal, "timeout").mockImplementation(() => new AbortController().signal);
    const f = fixture(), pending = deferred<AuthenticatedUser>();
    f.dependencies.revalidateUser.mockResolvedValueOnce(f.owner).mockReturnValueOnce(pending.promise);
    vi.mocked(inventoryJobInput).mockResolvedValueOnce({
      scope: { tenantId: f.owner.tenantId!, principalId: f.owner.homeAccountId, kind: "principal",
        tokenMode: "delegated", source: "inventory_packages", selector: "complete" },
      schemaVersion: 1, sessionEpoch: "0", jobId: f.job.id, jobKind: "package_refresh",
      observedAt: new Date(), expiresAt: new Date(Date.now() + 60_000),
      deadlineAt: new Date(Date.now() + 1000), reserveBytes: 1024,
    });
    try {
      await f.start();
      await vi.advanceTimersByTimeAsync(1000);
      expect(f.repository.markFailed).toHaveBeenCalledWith(expect.anything(), f.job.id, "package_refresh_timeout",
        expect.stringContaining("previous complete inventory is unchanged"));
      expect(f.collection).not.toHaveBeenCalled();
      expect(f.repository.complete).not.toHaveBeenCalled();
    } finally {
      await f.service.drain();
      pending.reject(new AppError(401, "interaction_required", "Late authorization rejection."));
    }
  });

  it("does not relabel cancellation diagnostics when a joined collection settles after the deadline", async () => {
    vi.useFakeTimers();
    const f = fixture(), pending = deferred<void>();
    f.collection.mockReturnValueOnce(pending.promise);
    await f.start();
    await vi.waitFor(() => expect(f.collection).toHaveBeenCalledOnce());
    await f.service.cancel(f.owner, f.job.id, "delegated");
    vi.spyOn(performance, "now").mockReturnValue(performance.now() + packageRefreshExecutionDeadlineMs + 1);
    pending.reject(new Error("Late collection failure."));
    await f.service.drain();
    const summaries = vi.mocked(console.log).mock.calls.map(([entry]) => JSON.parse(entry))
      .filter(entry => entry.event === "package_scan_summary");
    expect(summaries).toMatchObject([{ outcome: "cancelled" }]);
    expect(f.repository.markFailed).not.toHaveBeenCalled();
    expect(f.repository.complete).not.toHaveBeenCalled();
  });

  it.each(["enqueue", "observer", "stream_cleanup"] as const)("does not turn committed success into provider failure after %s fails", async stage => {
    const f = fixture();
    if (stage === "enqueue") vi.mocked(inventoryRuntime).mockReturnValueOnce({
      enqueue: async () => { throw new Error("private follow-up failure"); },
    } as never);
    else if (stage === "observer") f.dependencies.observeOperation.mockImplementation(async (_id, _user, operation) => {
      const value = await operation(() => {});
      if (f.repository.complete.mock.calls.length) throw new Error("private follow-up failure");
      return value;
    });
    else {
      const publish = f.streams.graphCatalog.getMockImplementation();
      if (!publish) throw new Error("Expected the fixture publication implementation.");
      f.streams.graphCatalog.mockImplementationOnce(async (...args) => {
        await publish(...args);
        throw new Error("private stream cleanup failure");
      });
    }
    await f.start();
    await vi.waitFor(() => expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("package_inventory_followup_failed")));
    expect(f.repository.complete).toHaveBeenCalledOnce();
    expect(f.repository.markFailed).not.toHaveBeenCalled();
    expect(f.repository.markWaitingAuthorization).not.toHaveBeenCalled();
    expect(inventoryRuntime).toHaveBeenCalledOnce();
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain("private follow-up");
  });

  it.each(["TypeError", "private_followup_error"])("bounds committed follow-up exception labels: %s", async name => {
    const f = fixture();
    vi.mocked(inventoryRuntime).mockReturnValueOnce({
      enqueue: async () => { throw Object.assign(new Error("private-message"), { name }); },
    } as never);
    await f.start();
    await vi.waitFor(() => expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("package_inventory_followup_failed")));
    const followup = vi.mocked(console.warn).mock.calls.map(([entry]) => JSON.parse(entry))
      .find(entry => entry.event === "package_inventory_followup_failed");
    if (name === "TypeError") expect(followup).toHaveProperty("reason", "TypeError");
    else expect(followup).not.toHaveProperty("reason");
    expect(f.repository.markFailed).not.toHaveBeenCalled();
    expect(JSON.stringify(followup)).not.toMatch(/private[-_]/);
  });

  it.each([false, true])("finishes %s-scope collection metrics before failed publication readiness", async exact => {
    let elapsed = 0;
    vi.spyOn(performance, "now").mockImplementation(() => elapsed);
    const f = fixture({ exact });
    f.collection.mockImplementation(async (_token, options) => {
      elapsed = 25;
      if (exact) options.diagnostics!.completeDetail(true);
      else options.diagnostics!.catalogPage([{}], 1, false, 25, 999);
      await options.onProgress!({ pages: exact ? 0 : 1, observedCount: 1, totalRecords: exact ? 20 : 1 });
    });
    f.dependencies.requireAvailable.mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined)
      .mockImplementationOnce(async () => {
        const summaries = vi.mocked(console.log).mock.calls.map(([entry]) => JSON.parse(entry))
          .filter(entry => entry.event === "package_scan_summary");
        expect(summaries).toMatchObject([{
          stage: exact ? "identity" : "catalog", outcome: "collected", count: 1, durationMs: 25,
          totalRecords: exact ? 20 : 1,
        }]);
        elapsed = 50_000;
        throw new AppError(403, "missing_permission", "private publication denial");
      });
    await f.start();
    await vi.waitFor(() => expect(f.repository.markFailed).toHaveBeenCalledOnce());
    expect(f.repository.markFailed).toHaveBeenCalledWith(expect.anything(), f.job.id, "missing_permission", expect.any(String));
    expect(f.repository.complete).not.toHaveBeenCalled();
    const summaries = vi.mocked(console.log).mock.calls.map(([entry]) => JSON.parse(entry))
      .filter(entry => entry.event === "package_scan_summary");
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({ outcome: "collected", durationMs: 25 });
    expect(JSON.stringify(vi.mocked(console.log).mock.calls)).not.toContain("package_refresh_succeeded");
  });

  it.each([false, true])("logs readiness retries only after %s-scope collection has finished", async exact => {
    const f = fixture({ exact });
    const retry = new AppError(504, "provider_timeout", "private readiness failure");
    f.dependencies.requireAvailable.mockResolvedValueOnce(undefined).mockRejectedValueOnce(retry)
      .mockResolvedValueOnce(undefined).mockRejectedValueOnce(retry);
    f.collection.mockImplementation(async (_token, options) => {
      if (exact) options.diagnostics!.completeDetail(true);
      else options.diagnostics!.catalogPage([{}], 1, false, 0);
      await options.onProgress!({ pages: exact ? 0 : 1, observedCount: 1, totalRecords: exact ? 20 : 1 });
    });
    await f.start();
    await vi.waitFor(() => expect(f.repository.complete).toHaveBeenCalledOnce());
    const logs = [...vi.mocked(console.log).mock.calls, ...vi.mocked(console.warn).mock.calls]
      .map(([entry]) => JSON.parse(entry));
    expect(logs.filter(entry => entry.event === "package_publication_readiness_retry")).toMatchObject([{
      jobId: f.job.id, stage: "publication_authorization", count: 1, attempt: 1, retryDelayMs: 1_000,
      errorCode: "provider_timeout",
    }]);
    expect(f.collection).toHaveBeenCalledOnce();
    expect(f.dependencies.wait).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(logs)).not.toContain("private readiness");
  });

  it.each([
    { status: 500, code: "interaction_required", expected: "graph_http_500", waiting: false },
    { status: 401, code: "private_provider_code", expected: "interaction_required", waiting: true },
    { status: 400, code: "private_provider_code", expected: "graph_http_400", waiting: false },
  ])("uses HTTP $status rather than provider code $code for scan job state and messages", async ({ status, code, expected, waiting }) => {
    const f = fixture();
    const error = await graphError(Response.json({ error: { code, message: "private-message" } }, {
      status, headers: { "request-id": "private-request-id" },
    }));
    f.collection.mockRejectedValueOnce(error);
    await f.start();
    await vi.waitFor(() => expect(f.repository.markFailed.mock.calls.length + f.repository.markWaitingAuthorization.mock.calls.length).toBe(1));
    if (waiting) expect(f.repository.markWaitingAuthorization).toHaveBeenCalledOnce();
    else expect(f.repository.markFailed).toHaveBeenCalledWith(expect.anything(), f.job.id, expected, expect.any(String));
    expect(f.repository.complete).not.toHaveBeenCalled();
    const output = JSON.stringify([...vi.mocked(console.log).mock.calls, ...vi.mocked(console.warn).mock.calls,
      ...vi.mocked(console.error).mock.calls, ...f.repository.markFailed.mock.calls]);
    expect(output).not.toMatch(/private[-_]/);
  });

  it("releases a committed refresh after bounded canonical follow-up without losing durable success", async () => {
    vi.useFakeTimers();
    vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException("deadline", "TimeoutError")), ms);
      return controller.signal;
    });
    const f = fixture(), pending = deferred<boolean>();
    const enqueue = vi.fn((_scope: unknown, _schedule: boolean, _signal: AbortSignal) => pending.promise);
    vi.mocked(inventoryRuntime).mockReturnValueOnce({ enqueue } as never);
    await f.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.repository.complete).toHaveBeenCalledOnce();
    expect(enqueue).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(enqueue.mock.calls[0][2].aborted).toBe(true);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("package_inventory_followup_failed"));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("package_refresh_succeeded"));
    expect(f.repository.markFailed).not.toHaveBeenCalled();
    expect(f.repository.markWaitingAuthorization).not.toHaveBeenCalled();
    await expect(f.start()).resolves.toMatchObject({ id: f.job.id });
    pending.reject(new Error("Observed late canonical follow-up rejection."));
    await vi.advanceTimersByTimeAsync(0);
    expect(f.repository.markFailed).not.toHaveBeenCalled();
  });

  it.each(["provider_timeout", "provider_network_error", "provider_throttled"])(
    "retries transient publication authorization without recollecting records: %s", async code => {
      const f = fixture();
      f.dependencies.requireAvailable.mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new AppError(code === "provider_throttled" ? 429 : 504, code, "Transient."));
      await f.start();
      await vi.waitFor(() => expect(f.repository.complete).toHaveBeenCalledOnce());
      expect(f.collection).toHaveBeenCalledOnce();
      expect(f.dependencies.revalidateUser).toHaveBeenCalledTimes(4);
      expect(f.dependencies.wait).toHaveBeenCalledWith(1_000, expect.any(AbortSignal));
      expect(f.repository.recordProgress).toHaveBeenCalledWith(expect.anything(), f.job.id, 0, 0, null,
        expect.stringContaining("no packages are being downloaded again"));
    },
  );

  it("honors a five-minute provider cooldown and records collection readiness truthfully", async () => {
    const f = fixture();
    f.dependencies.requireAvailable.mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new AppError(429, "provider_throttled", "Cooldown.", { expiresAt: new Date(Date.now() + 300_000).toISOString() }));
    f.dependencies.wait.mockImplementation(async () => { expect(f.collection).not.toHaveBeenCalled(); });
    await f.start();
    await vi.waitFor(() => expect(f.repository.complete).toHaveBeenCalledOnce());
    expect(f.dependencies.wait.mock.calls[0][0]).toBeGreaterThan(299_000);
    expect(f.dependencies.wait.mock.calls[0][0]).toBeLessThanOrEqual(300_001);
    expect(f.repository.recordProgress).toHaveBeenCalledWith(expect.anything(), f.job.id, 0, 0, null,
      expect.stringContaining("before collection. No provider reads"));
  });

  it.each(["collection", "publication"] as const)("retries transient Entra revalidation at %s without repeating package reads", async stage => {
    const f = fixture();
    f.dependencies.revalidateUser.mockResolvedValueOnce(f.owner);
    if (stage === "publication") f.dependencies.revalidateUser.mockResolvedValueOnce(f.owner);
    f.dependencies.revalidateUser.mockRejectedValueOnce(new AppError(502, "identity_provider_error", "Token acquisition failed.", { retryable: true }));
    await f.start();
    await vi.waitFor(() => expect(f.repository.complete).toHaveBeenCalledOnce());
    expect(f.dependencies.revalidateUser).toHaveBeenCalledTimes(4);
    expect(f.dependencies.wait).toHaveBeenCalledWith(1_000, expect.any(AbortSignal));
    expect(f.collection).toHaveBeenCalledOnce();
    expect(f.repository.markFailed).not.toHaveBeenCalled();
    expect(f.repository.recordProgress).toHaveBeenCalledWith(expect.anything(), f.job.id, 0, 0, null,
      expect.stringContaining(stage === "publication" ? "no packages are being downloaded again" : "No provider reads are running"));
  });

  it.each(["collection", "publication"] as const)("never retries permanent %s authorization failures", async stage => {
    for (const error of [new AppError(401, "interaction_required", "Sign in."),
      new AppError(403, "missing_permission", "Permission."), new AppError(502, "provider_schema", "Schema."),
      new AppError(502, "identity_provider_error", "Unclassified identity error.")]) {
      const f = fixture();
      f.dependencies.requireAvailable.mockResolvedValueOnce(undefined);
      if (stage === "publication") f.dependencies.requireAvailable.mockResolvedValueOnce(undefined);
      f.dependencies.requireAvailable.mockRejectedValueOnce(error);
      await f.start();
      await vi.waitFor(() => expect(f.repository.markFailed.mock.calls.length + f.repository.markWaitingAuthorization.mock.calls.length).toBe(1));
      expect(f.repository.complete).not.toHaveBeenCalled();
      expect(f.dependencies.wait).not.toHaveBeenCalled();
      expect(f.collection).toHaveBeenCalledTimes(stage === "publication" ? 1 : 0);
      expect(f.repository.markWaitingAuthorization).toHaveBeenCalledTimes(error.status === 401 ? 1 : 0);
    }
  });

  it.each(["collection", "progress", "commit"] as const)("retains prior success and never retries an uncertain %s write", async stage => {
    const f = fixture({ autoDetails: true });
    const error = new AppError(504, "provider_timeout", "Bounded operation failed.");
    if (stage === "collection") f.collection.mockRejectedValueOnce(error);
    if (stage === "progress") {
      f.repository.recordProgress.mockRejectedValueOnce(error);
      f.collection.mockImplementationOnce(async (_token, options) => { await options.onProgress!({ pages: 0, observedCount: 1 }); });
    }
    if (stage === "commit") f.repository.complete.mockRejectedValueOnce(error);
    await f.start();
    await vi.waitFor(() => expect(f.repository.markFailed).toHaveBeenCalledOnce());
    expect(f.repository.complete).toHaveBeenCalledTimes(stage === "commit" ? 1 : 0);
    expect(f.dependencies.wait).not.toHaveBeenCalled();
    expect(JSON.stringify(vi.mocked(console.log).mock.calls)).not.toContain("package_refresh_succeeded");
    const summaries = vi.mocked(console.log).mock.calls.map(([entry]) => JSON.parse(entry))
      .filter(entry => entry.event === "package_scan_summary");
    expect(summaries).toMatchObject([{ stage: "identity", outcome: stage === "commit" ? "collected" : "failed" }]);
    expect(inventoryRuntime).not.toHaveBeenCalled();
  });

  it.each(["maintenance", "provider_requalification_required"])("fences every admission/publication boundary under %s", async code => {
    for (const stage of ["start", "authorization", "activation", "collection"]) {
      const f = fixture();
      let closed = stage === "start";
      vi.spyOn(operationalState, "requireProviderAdmissions").mockImplementation(() => {
        if (closed) throw new AppError(503, code, "Provider admissions are closed.");
      });
      if (stage === "authorization") f.dependencies.revalidateUser.mockImplementationOnce(async () => { closed = true; return f.owner; });
      if (stage === "activation") f.repository.markRunning.mockImplementationOnce(async () => { closed = true; return true; });
      if (stage === "collection") f.collection.mockImplementationOnce(async () => { closed = true; });
      if (stage === "collection") {
        await f.start();
        await vi.waitFor(() => expect(f.repository.markWaitingAuthorization).toHaveBeenCalledOnce());
      } else await expect(f.start()).rejects.toMatchObject({ code });
      expect(f.repository.complete).not.toHaveBeenCalled();
      expect(f.repository.markFailed).not.toHaveBeenCalled();
      await expect(f.service.get(f.owner, f.job.id, f.job.tokenMode)).resolves.toMatchObject({ id: f.job.id });
      await f.service.drain();
    }
  });

  it.each(["maintenance", "provider_requalification_required"])("keeps automatic pause %s distinct from sign-in failure", async code => {
    const f = fixture({ autoDetails: true });
    let closed = false;
    vi.spyOn(operationalState, "requireProviderAdmissions").mockImplementation(() => {
      if (closed) throw new AppError(503, code, "Provider admissions are closed.");
    });
    f.collection.mockImplementationOnce(async () => { closed = true; });
    await f.start();
    await vi.waitFor(() => expect(f.repository.markFailed).toHaveBeenCalledWith(expect.anything(), f.job.id, code,
      "Provider admissions are closed. Saved package data is unchanged."));
    expect(f.repository.complete).not.toHaveBeenCalled();
  });

  it.each(["revalidateUser", "requireAvailable", "delegatedToken"] as const)(
    "persists admission permission failure at %s without starting provider reads", async stage => {
      const f = fixture();
      f.dependencies[stage].mockRejectedValueOnce(new AppError(403, "missing_permission", "Consent."));
      await expect(f.start()).rejects.toMatchObject({ code: "missing_permission" });
      expect(f.repository.markFailed).toHaveBeenCalledWith(expect.anything(), f.job.id, "missing_permission",
        expect.stringContaining("signing in again does not grant permissions"));
      expect(f.repository.markRunning).not.toHaveBeenCalled();
      expect(f.collection).not.toHaveBeenCalled();
    },
  );

  it.each(["missing_permission", "capability_unavailable", "provider_error"])("does not relabel provider 403 %s as an expired sign-in", async code => {
    const f = fixture();
    f.collection.mockRejectedValueOnce(new AppError(403, code, "Denied."));
    await f.start();
    await vi.waitFor(() => expect(f.repository.markFailed).toHaveBeenCalledWith(expect.anything(), f.job.id,
      code === "provider_error" ? "missing_permission" : code, expect.stringContaining("permission")));
    expect(f.repository.markWaitingAuthorization).not.toHaveBeenCalled();
    expect(f.repository.complete).not.toHaveBeenCalled();
  });

  const admissionStages = ["getJob", "revalidateUser", "requireAvailable", "delegatedToken", "markRunning"] as const;
  it.each(admissionStages.flatMap(stage => (["cancel", "logout", "shutdown", "replace"] as const).map(action => ({ stage, action }))))(
    "fences $stage admission on $action without running a late provider request", async ({ stage, action }) => {
      const f = fixture(), pending = deferred<unknown>();
      const method = stage === "getJob" || stage === "markRunning" ? f.repository[stage] : f.dependencies[stage];
      method.mockReturnValueOnce(pending.promise as never);
      const starting = f.start();
      const stopped = expect(starting).rejects.toMatchObject({ code: action === "cancel" ? "read_job_cancelled"
        : action === "replace" ? "unauthorized" : "interaction_required" });
      await vi.waitFor(() => expect(method).toHaveBeenCalledOnce());
      let draining: Promise<void> | undefined;
      let sessionMutation: Promise<unknown> | undefined;
      if (action === "cancel") await f.service.cancel(f.owner, f.job.id, f.job.tokenMode);
      if (action === "logout") sessionMutation = revokeAccountSessionMutations(f.owner.tenantId!, f.owner.homeAccountId, () =>
        f.service.waitForPrincipalAuthorization({ tenantId: f.owner.tenantId!, principalId: f.owner.homeAccountId }));
      if (action === "replace") sessionMutation = activateAccountSession(f.owner.tenantId!, f.owner.homeAccountId, async () => {});
      if (stage !== "markRunning") await sessionMutation;
      if (action === "shutdown") draining = f.service.drain();
      pending.resolve(stage === "getJob" ? f.job : stage === "revalidateUser" ? f.owner : stage === "markRunning" ? true : "synthetic");
      await stopped;
      await sessionMutation;
      await draining;
      expect(f.collection).not.toHaveBeenCalled();
      expect(f.repository.complete).not.toHaveBeenCalled();
    },
  );

  it.each((["collection", "publication"] as const).flatMap(stage =>
    (["cancel", "logout", "shutdown", "deadline"] as const).flatMap(action =>
      (["resolve", "reject"] as const).map(settlement => ({ stage, action, settlement })))))(
    "keeps $action authoritative after pending $stage authorization $settlement", async ({ stage, action, settlement }) => {
      vi.useFakeTimers();
      const f = fixture(), pending = deferred<AuthenticatedUser>();
      vi.spyOn(AbortSignal, "timeout").mockImplementation(() => new AbortController().signal);
      f.dependencies.revalidateUser.mockResolvedValueOnce(f.owner);
      if (stage === "publication") f.dependencies.revalidateUser.mockResolvedValueOnce(f.owner);
      f.dependencies.revalidateUser.mockReturnValueOnce(pending.promise);
      await f.start();
      await vi.waitFor(() => expect(f.dependencies.revalidateUser).toHaveBeenCalledTimes(stage === "publication" ? 3 : 2));
      let draining: Promise<void> | undefined;
      if (action === "cancel") await f.service.cancel(f.owner, f.job.id, f.job.tokenMode);
      if (action === "logout") await revokeAccountSessionMutations(f.owner.tenantId!, f.owner.homeAccountId, () =>
        f.service.waitForPrincipalAuthorization({ tenantId: f.owner.tenantId!, principalId: f.owner.homeAccountId }));
      if (action === "shutdown") draining = f.service.drain();
      await vi.advanceTimersByTimeAsync(packageRefreshExecutionDeadlineMs);
      if (settlement === "resolve") pending.resolve(f.owner);
      else pending.reject(new AppError(403, "missing_permission", "Late private rejection."));
      await (draining ?? f.service.drain());
      expect(f.repository.complete).not.toHaveBeenCalled();
      const summaries = vi.mocked(console.log).mock.calls.map(([entry]) => JSON.parse(entry))
        .filter(entry => entry.event === "package_scan_summary");
      expect(summaries).toHaveLength(1);
      if (stage === "publication") expect(summaries[0]).toHaveProperty("outcome", "collected");
      expect(vi.getTimerCount()).toBe(0);
      expect(f.repository.markFailed).toHaveBeenCalledTimes(action === "deadline" ? 1 : 0);
      if (action === "deadline") expect(f.repository.markFailed).toHaveBeenCalledWith(expect.anything(), f.job.id,
        "package_refresh_timeout", expect.stringContaining("four-hour execution deadline"));
      else expect(f.repository.markWaitingAuthorization).toHaveBeenCalledTimes(action === "cancel" ? 0 : 1);
    },
  );

  it.each(["principal", "tenant", "role"] as const)("rechecks current %s on publication retry", async change => {
    const f = fixture();
    f.dependencies.requireAvailable.mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new AppError(504, "provider_timeout", "Retry."));
    f.dependencies.wait.mockImplementationOnce(async () => {
      f.dependencies.revalidateUser.mockResolvedValueOnce({ ...f.owner,
        ...(change === "principal" ? { homeAccountId: "other" } : change === "tenant" ? { tenantId: "other" } : { roles: [] }) });
    });
    await f.start();
    await vi.waitFor(() => expect(f.repository.markFailed.mock.calls.length + f.repository.markWaitingAuthorization.mock.calls.length).toBe(1));
    expect(f.collection).toHaveBeenCalledOnce();
    expect(f.repository.complete).not.toHaveBeenCalled();
    expect(f.dependencies.requireAvailable).toHaveBeenCalledTimes(3);
  });

  it.each([false, true])("retains the exact execution deadline and releases listeners (automatic=%s)", async autoDetails => {
    vi.useFakeTimers();
    const f = fixture({ autoDetails });
    pendingCollection(f);
    const limit = autoDetails ? 300_000 : packageRefreshExecutionDeadlineMs;
    vi.spyOn(AbortSignal, "timeout").mockImplementation(milliseconds => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException("Execution deadline", "TimeoutError")), milliseconds);
      return controller.signal;
    });
    await f.start();
    await vi.advanceTimersByTimeAsync(0);
    const execution = f.collection.mock.calls[0][1].signal!;
    expect(packageRefreshExecutionDeadlineMs).toBe(4 * 60 * 60_000);
    await vi.advanceTimersByTimeAsync(limit - 1);
    expect(execution.aborted).toBe(false);
    expect(f.repository.markFailed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(f.repository.markFailed).toHaveBeenCalledWith(expect.anything(), f.job.id, "package_refresh_timeout",
      expect.stringContaining(autoDetails ? "five-minute" : "four-hour"));
    expect(f.repository.complete).not.toHaveBeenCalled();
    expect(getEventListeners(execution, "abort")).toHaveLength(0);
  });

  it.each(["token", "publication"] as const)("cannot adopt a replacement capability generation during %s", async stage => {
    const f = fixture(), reason = new AppError(401, "authorization_expired", "Capability authority changed.");
    let current = true;
    f.dependencies.beginOperationValidation.mockReturnValue(() => { if (!current) throw reason; });
    if (stage === "token") f.dependencies.delegatedToken.mockImplementationOnce(async () => {
      current = false;
      return "late-token";
    });
    else f.collection.mockImplementationOnce(async () => { current = false; });
    if (stage === "token") await expect(f.start()).rejects.toBe(reason);
    else {
      await f.start();
      await vi.waitFor(() => expect(f.repository.markWaitingAuthorization).toHaveBeenCalledOnce());
    }
    expect(f.dependencies.beginOperationValidation).toHaveBeenCalledExactlyOnceWith("graph.package.read.delegated", f.owner);
    expect(f.repository.complete).not.toHaveBeenCalled();
    expect(f.collection).toHaveBeenCalledTimes(stage === "token" ? 0 : 1);
  });

  it("settles cancelled non-cooperative token acquisition without retaining the admission lane", async () => {
    const f = fixture(), pending = deferred<string>();
    f.dependencies.delegatedToken.mockReturnValueOnce(pending.promise);
    const starting = f.start();
    const assertion = expect(starting).rejects.toMatchObject({ code: "read_job_cancelled" });
    await vi.waitFor(() => expect(f.dependencies.delegatedToken).toHaveBeenCalledOnce());
    await f.service.cancel(f.owner, f.job.id, "delegated");
    await assertion;
    expect(f.repository.markRunning).not.toHaveBeenCalled();
    expect(f.collection).not.toHaveBeenCalled();
    pending.reject(new Error("private late token error"));
    await f.service.drain();
  });

  it("reserves four foreground and two persisted automatic lanes, counts a job once, and conceals active jobs", async () => {
    const f = fixture(), automatic = new Set([randomUUID(), randomUUID()]);
    pendingCollection(f);
    f.repository.getJob.mockImplementation(async (_scope, id = f.job.id) => ({ ...f.job, id, autoDetails: automatic.has(id) }));
    const foreground = Array.from({ length: 4 }, () => randomUUID());
    for (const id of foreground) await f.service.start(f.owner, id, "delegated");
    await expect(f.service.start(f.owner, randomUUID(), "delegated")).rejects.toMatchObject({ code: "package_refresh_capacity" });
    for (const id of automatic) await f.service.start(f.owner, id, "delegated");
    await vi.waitFor(() => expect(f.collection).toHaveBeenCalledTimes(6));
    await expect(f.service.start(f.owner, randomUUID(), "delegated")).rejects.toMatchObject({ code: "package_refresh_capacity" });
    await expect(f.service.start(f.owner, foreground[0].toUpperCase(), "delegated")).rejects.toMatchObject({ code: "package_refresh_state" });
    for (const other of [{ ...f.owner, tenantId: "other" }, { ...f.owner, homeAccountId: "other" }]) {
      await expect(f.service.start(other, foreground[0], "delegated")).rejects.toMatchObject({ code: "not_found", status: 404 });
    }
    await f.service.cancel(f.owner, foreground[0].toUpperCase(), "delegated");
    await vi.waitFor(() => expect(f.repository.cancel).toHaveBeenCalledTimes(2));
    expect(f.repository.complete).not.toHaveBeenCalled();
  });

  it.each(["requireApplicationDataScope", "applicationToken"] as const)("does not hold the account mutation lock while application %s waits", async stage => {
    const f = fixture({ application: true }), pending = deferred<void>();
    f.dependencies[stage].mockImplementationOnce(async () => { await pending.promise; return "synthetic" as never; });
    const starting = f.start();
    const stopped = expect(starting).rejects.toMatchObject({ code: "interaction_required" });
    await vi.waitFor(() => expect(f.dependencies[stage]).toHaveBeenCalledOnce());
    let revoked = false;
    const revoking = revokeAccountSessionMutations(f.owner.tenantId!, f.owner.homeAccountId, async () => {
      await f.service.waitForPrincipalAuthorization({ tenantId: f.owner.tenantId!, principalId: f.owner.homeAccountId });
      revoked = true;
    });
    try { await vi.waitFor(() => expect(revoked).toBe(true), { timeout: 200 }); }
    finally { pending.resolve(); await Promise.all([stopped, revoking]); }
    expect(f.repository.markRunning).not.toHaveBeenCalled();
    expect(f.repository.complete).not.toHaveBeenCalled();
  });

  it.each(["waiting_authorization", "running", "failed", "succeeded", "cancelled"])("returns latest automatic %s history without authorizing provider work", async status => {
    const f = fixture({ autoDetails: true }), latest = { ...f.job, status };
    f.repository.latestAutomaticDetailsJob.mockResolvedValue(latest);
    await expect(f.service.refreshDueDetails(f.owner)).resolves.toBe(latest);
    await f.service.drain();
    await expect(f.service.refreshDueDetails(f.owner)).resolves.toBe(latest);
    expect(f.repository.claimDueDetails).toHaveBeenCalledTimes(status === "cancelled" ? 0 : 1);
    expect(f.dependencies.revalidateUser).not.toHaveBeenCalled();
    expect(f.collection).not.toHaveBeenCalled();
  });

  it.each((["unclaimed", "draining", "capacity"] as const).flatMap(branch =>
    (["logout", "replace", "capability"] as const).map(action => ({ branch, action }))))(
    "rejects pending automatic history on $action in the $branch fallback without provider work", async ({ branch, action }) => {
      const f = fixture({ autoDetails: true }), pending = deferred<typeof f.job>();
      const reason = new AppError(401, "authorization_expired", "Capability authority changed.");
      let current = true;
      f.dependencies.beginOperationValidation.mockReturnValue(() => { if (!current) throw reason; });
      if (branch === "draining") await f.service.drain();
      if (branch === "capacity") {
        pendingCollection(f);
        await f.start();
        await f.service.start(f.owner, randomUUID(), "delegated");
        await vi.waitFor(() => expect(f.collection).toHaveBeenCalledTimes(2));
        f.dependencies.revalidateUser.mockClear();
        f.dependencies.requireAvailable.mockClear();
        f.dependencies.delegatedToken.mockClear();
        f.repository.markRunning.mockClear();
        f.collection.mockClear();
      }
      f.repository.latestAutomaticDetailsJob.mockReturnValueOnce(pending.promise);
      const request = f.service.refreshDueDetails(f.owner);
      const stopped = expect(request).rejects.toMatchObject({ code: action === "capability" ? reason.code : "unauthorized" });
      await vi.waitFor(() => expect(f.repository.latestAutomaticDetailsJob).toHaveBeenCalledOnce());
      if (action === "capability") current = false;
      else if (action === "replace") await activateAccountSession(f.owner.tenantId!, f.owner.homeAccountId, async () => {});
      else await revokeAccountSessionMutations(f.owner.tenantId!, f.owner.homeAccountId, async () => {});
      pending.resolve(f.job);
      await stopped;
      expect(f.repository.claimDueDetails).not.toHaveBeenCalled();
      expect(f.dependencies.revalidateUser).not.toHaveBeenCalled();
      expect(f.dependencies.requireAvailable).not.toHaveBeenCalled();
      expect(f.dependencies.delegatedToken).not.toHaveBeenCalled();
      expect(f.repository.markRunning).not.toHaveBeenCalled();
      expect(f.repository.markFailed).not.toHaveBeenCalled();
      expect(f.collection).not.toHaveBeenCalled();
    },
  );

  it.each(["claim", "start"] as const)("joins coordinator cancellation during automatic %s without collecting", async stage => {
    const f = fixture({ autoDetails: true }), pending = deferred<unknown>(), controller = new AbortController();
    f.repository.claimDueDetails.mockResolvedValue(f.job);
    if (stage === "claim") f.repository.claimDueDetails.mockReturnValueOnce(pending.promise as never);
    else f.dependencies.revalidateUser.mockReturnValueOnce(pending.promise as never);
    const request = f.service.refreshDueDetails(f.owner, undefined, controller.signal);
    const stopped = expect(request).rejects.toMatchObject({ code: "interaction_required" });
    await vi.waitFor(() => expect(stage === "claim" ? f.repository.claimDueDetails : f.dependencies.revalidateUser).toHaveBeenCalledOnce());
    controller.abort(new AppError(401, "interaction_required", "Coordinator stopped."));
    pending.resolve(stage === "claim" ? f.job : f.owner);
    await stopped;
    expect(f.collection).not.toHaveBeenCalled();
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });

  it.each(["claim", "token", "publication"] as const)(
    "retains the initiating automatic capability generation through %s", async stage => {
      const f = fixture({ autoDetails: true });
      const reason = new AppError(401, "authorization_expired", "Capability authority changed.");
      let generation = 0;
      f.dependencies.beginOperationValidation.mockImplementation(() => {
        const initiating = generation;
        return () => { if (generation !== initiating) throw reason; };
      });
      f.repository.claimDueDetails.mockImplementationOnce(async () => {
        if (stage === "claim") generation++;
        return f.job;
      });
      if (stage === "token") f.dependencies.delegatedToken.mockImplementationOnce(async () => {
        generation++;
        return "replacement-token";
      });
      const publication = deferred<void>();
      if (stage === "publication") f.collection.mockImplementationOnce(async () => {
        await publication.promise;
        generation++;
      });
      if (stage === "publication") {
        await f.service.refreshDueDetails(f.owner);
        publication.resolve();
        await vi.waitFor(() => expect(f.repository.markFailed).toHaveBeenCalledWith(expect.anything(), f.job.id,
          "interaction_required", expect.stringContaining("renewed")));
      } else await expect(f.service.refreshDueDetails(f.owner)).rejects.toBe(reason);
      expect(f.dependencies.beginOperationValidation).toHaveBeenCalledExactlyOnceWith("graph.package.read.delegated", f.owner);
      expect(f.dependencies.beginOperationValidation).toHaveBeenCalledBefore(f.repository.claimDueDetails);
      expect(f.repository.markRunning).toHaveBeenCalledTimes(stage === "publication" ? 1 : 0);
      expect(f.collection).toHaveBeenCalledTimes(stage === "publication" ? 1 : 0);
      expect(f.repository.complete).not.toHaveBeenCalled();
      if (stage === "claim") {
        expect(f.dependencies.revalidateUser).not.toHaveBeenCalled();
        expect(f.dependencies.requireAvailable).not.toHaveBeenCalled();
        expect(f.dependencies.delegatedToken).not.toHaveBeenCalled();
        expect(f.repository.markFailed).toHaveBeenCalledWith(expect.anything(), f.job.id, "authorization_expired",
          expect.stringContaining("renewed"), f.job.resultRevision);
      }
    },
  );

  it.each([401, 403])("backs off automatic admission with truthful HTTP %s status", async status => {
    const f = fixture({ autoDetails: true });
    f.repository.claimDueDetails.mockResolvedValue(f.job);
    f.dependencies.requireAvailable.mockRejectedValueOnce(new AppError(status, status === 401 ? "interaction_required" : "missing_permission", "Denied."));
    await f.service.refreshDueDetails(f.owner);
    expect(f.repository.markFailed).toHaveBeenCalledWith(expect.anything(), f.job.id,
      status === 401 ? "interaction_required" : "missing_permission", expect.stringContaining(status === 401 ? "renewed" : "permission"),
      f.job.resultRevision);
    expect(f.repository.complete).not.toHaveBeenCalled();
  });

  it("preserves role inheritance, exact submission, shared application admission, retry intent and cleanup reasons", async () => {
    const f = fixture();
    const admin = { ...f.owner, roles: ["AgentControl.Admin" as const] };
    for (const tokenMode of ["delegated", "application"] as const) {
      await f.service.submit(admin, { tokenMode, requestedIds: ["exact"], idempotencyKey: randomUUID() });
      expect(f.repository.submit).toHaveBeenLastCalledWith({ tenantId: f.owner.tenantId,
        principalId: tokenMode === "application" ? "synthetic-application-id" : f.owner.homeAccountId },
      expect.objectContaining({ tokenMode, authorizationPrincipalId: f.owner.homeAccountId }), expect.any(Function));
    }
    await expect(f.service.submit({ ...f.owner, roles: [] }, { tokenMode: "delegated", idempotencyKey: randomUUID() }))
      .rejects.toMatchObject({ code: "missing_internal_role" });
    await expect(f.service.cancel({ ...f.owner, roles: [] }, f.job.id, "delegated")).rejects.toMatchObject({ code: "missing_internal_role" });
    f.dependencies.requireAvailable.mockRejectedValueOnce(new AppError(504, "provider_timeout", "Retry."));
    await expect(f.service.start(f.owner, f.job.id, "delegated", { retryFailed: true })).rejects.toMatchObject({ code: "provider_timeout" });
    expect(f.dependencies.requireAvailable).toHaveBeenLastCalledWith("graph.package.read.delegated", f.owner, { retryFailed: true });
    await f.service.cancel(f.owner, f.job.id, "delegated", "sync_cleanup");
    expect(f.repository.cancel).toHaveBeenLastCalledWith(expect.anything(), f.job.id, f.owner.homeAccountId, "sync_cleanup");
    await f.service.recover();
    expect(f.repository.recoverInterrupted).toHaveBeenCalledOnce();
  });

  it.each(["logout", "replace", "capability"] as const)("rejects stale application submission on %s before creating a job", async action => {
    const f = fixture({ application: true }), pending = deferred<void>();
    const reason = new AppError(401, "authorization_expired", "Capability authority changed.");
    let current = true;
    f.dependencies.beginOperationValidation.mockReturnValue(() => { if (!current) throw reason; });
    f.dependencies.requireApplicationDataScope.mockReturnValueOnce(pending.promise);
    const submitted = f.service.submit(f.owner, { tokenMode: "application", idempotencyKey: randomUUID() });
    const stopped = expect(submitted).rejects.toMatchObject({ code: action === "capability" ? reason.code : "unauthorized" });
    await vi.waitFor(() => expect(f.dependencies.requireApplicationDataScope).toHaveBeenCalledOnce());
    if (action === "capability") current = false;
    else if (action === "replace") await activateAccountSession(f.owner.tenantId!, f.owner.homeAccountId, async () => {});
    else await revokeAccountSessionMutations(f.owner.tenantId!, f.owner.homeAccountId, async () => {});
    pending.resolve();
    await stopped;
    expect(f.repository.submit).not.toHaveBeenCalled();
    expect(f.collection).not.toHaveBeenCalled();
  });

  it.each(["logout", "replace"] as const)("rejects a pending saved status read on %s without checking provider availability", async action => {
    const f = fixture(), pending = deferred<typeof f.job>();
    f.repository.getJob.mockReturnValueOnce(pending.promise);
    const reading = f.service.get(f.owner, f.job.id, f.job.tokenMode);
    const stopped = expect(reading).rejects.toMatchObject({ code: "unauthorized" });
    await vi.waitFor(() => expect(f.repository.getJob).toHaveBeenCalledOnce());
    if (action === "replace") await activateAccountSession(f.owner.tenantId!, f.owner.homeAccountId, async () => {});
    else await revokeAccountSessionMutations(f.owner.tenantId!, f.owner.homeAccountId, async () => {});
    pending.resolve(f.job);
    await stopped;
    expect(f.dependencies.requireAvailable).not.toHaveBeenCalled();
    expect(f.dependencies.revalidateUser).not.toHaveBeenCalled();
    expect(f.dependencies.delegatedToken).not.toHaveBeenCalled();
  });

  it.each(["requested", "sync_cleanup"] as const)("keeps %s cancellation's authority contract after account revocation during lookup", async reason => {
    const f = fixture(), pending = deferred<typeof f.job>();
    f.repository.getJob.mockReturnValueOnce(pending.promise);
    const cancelling = f.service.cancel(f.owner, f.job.id, f.job.tokenMode, reason);
    const outcome = reason === "requested" ? expect(cancelling).rejects.toMatchObject({ code: "unauthorized" })
      : expect(cancelling).resolves.toMatchObject({ status: "cancelled" });
    await revokeAccountSessionMutations(f.owner.tenantId!, f.owner.homeAccountId, async () => {});
    pending.resolve(f.job);
    await outcome;
    expect(f.repository.cancel).toHaveBeenCalledTimes(reason === "requested" ? 0 : 1);
    if (reason === "sync_cleanup") expect(f.repository.cancel).toHaveBeenCalledWith(expect.anything(), f.job.id, f.owner.homeAccountId, reason);
    expect(f.dependencies.requireAvailable).not.toHaveBeenCalled();
  });

  it.each(["background", "drain"] as const)("surfaces sanitized status persistence failures to %s", async mode => {
    const f = fixture(), pending = deferred<void>(), failure = new Error("private database failure");
    f.collection.mockRejectedValueOnce(new AppError(502, "provider_error", "Provider failed."));
    f.repository.markFailed.mockImplementationOnce(async () => { await pending.promise; throw failure; });
    await f.start();
    await vi.waitFor(() => expect(f.repository.markFailed).toHaveBeenCalledOnce());
    const draining = mode === "drain" ? expect(f.service.drain()).rejects.toBe(failure) : undefined;
    pending.resolve();
    await draining;
    await vi.waitFor(() => expect(console.error).toHaveBeenCalledWith(expect.stringContaining("package_refresh_status_failed")));
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain("private database");
    expect(f.repository.complete).not.toHaveBeenCalled();
  });
});
