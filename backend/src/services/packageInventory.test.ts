import { randomUUID } from "node:crypto";
import { getEventListeners } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "../errors.js";
import { activateAccountSession, revokeAccountSessionMutations } from "../db/sessions.js";
import type { AuthenticatedUser } from "../types/session.js";
import { PackageInventoryService } from "./packageInventory.js";
import type { StreamedInventory } from "./streamedInventory.js";
import { inventoryRuntime } from "./inventoryRuntime.js";
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
  inventoryJobInput: async (database: { complete: () => Promise<void> }, scope: unknown, _domain: string, jobId: string) => ({
    database, scope, jobId,
  }),
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
    updatedAt: "2026-09-09T00:00:00.000Z", finishedAt: null,
  };
  const repository = {
    submit: vi.fn(async () => job), getJob: vi.fn(async (_scope?: unknown, id = job.id) => ({ ...job, id })),
    claimDueDetails: vi.fn(async () => null as typeof job | null), latestAutomaticDetailsJob: vi.fn(async () => null as typeof job | null),
    markRunning: vi.fn(async () => true), recordProgress: vi.fn(async () => undefined), complete: vi.fn(async () => undefined),
    markWaitingAuthorization: vi.fn(async () => undefined), markFailed: vi.fn(async () => job),
    cancel: vi.fn(async () => ({ ...job, status: "cancelled" })), recoverInterrupted: vi.fn(async () => 0),
  };
  const collection = vi.fn(async (_token: string, _options: Options) => {});
  const execute = async (_input: unknown, token: string, options: Options) => {
    await options.authorize(options.signal!);
    await collection(token, options);
    await options.authorize(options.signal!);
    expect(options.commitPublication).toBeTypeOf("function");
    await options.commitPublication!(() => options.completeJob!({} as never, {} as never));
  };
  const streams = {
    graphCatalog: vi.fn(execute),
    exactJob: vi.fn(async (input: unknown, token: string, _automatic: boolean, options: Options) => execute(input, token, options)),
  };
  const dependencies = {
    observeOperation: vi.fn(async (_id: unknown, _user: unknown, operation: (failure: (error: unknown) => void) => Promise<unknown>) => operation(() => {})),
    revalidateUser: vi.fn(async () => owner), delegatedToken: vi.fn(async () => "synthetic-delegated"),
    applicationToken: vi.fn(async () => "synthetic-application"), requireAvailable: vi.fn(async () => undefined),
    requireApplicationDataScope: vi.fn(async () => undefined), applicationPrincipalId: vi.fn(() => "synthetic-application-id"),
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
  beforeEach(() => {
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
      [expect.anything(), f.job.id, 1, 5, exact ? 20 : null, expect.stringContaining("30 seconds before retrying (5 targets observed)")],
      [expect.anything(), f.job.id, 2, 20, 20],
    ]);
  });

  it.each(["enqueue", "observer"] as const)("does not turn committed success into provider failure after %s fails", async stage => {
    const f = fixture();
    if (stage === "enqueue") vi.mocked(inventoryRuntime).mockReturnValueOnce({
      enqueue: async () => { throw new Error("private follow-up failure"); },
    } as never);
    else f.dependencies.observeOperation.mockImplementation(async (_id, _user, operation) => {
      const value = await operation(() => {});
      if (f.repository.complete.mock.calls.length) throw new Error("private follow-up failure");
      return value;
    });
    await f.start();
    await vi.waitFor(() => expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("package_inventory_followup_failed")));
    expect(f.repository.complete).toHaveBeenCalledOnce();
    expect(f.repository.markFailed).not.toHaveBeenCalled();
    expect(f.repository.markWaitingAuthorization).not.toHaveBeenCalled();
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain("private follow-up");
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
      const f = fixture(), pending = deferred<AuthenticatedUser>(), deadline = new AbortController();
      vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
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
      deadline.abort(new DOMException("Execution deadline", "TimeoutError"));
      if (settlement === "resolve") pending.resolve(f.owner);
      else pending.reject(new AppError(403, "missing_permission", "Late private rejection."));
      await (draining ?? f.service.drain());
      expect(f.repository.complete).not.toHaveBeenCalled();
      expect(getEventListeners(deadline.signal, "abort")).toHaveLength(0);
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
    let execution!: AbortSignal;
    vi.spyOn(AbortSignal, "timeout").mockImplementation(milliseconds => {
      const controller = new AbortController();
      execution = controller.signal;
      setTimeout(() => controller.abort(new DOMException("Execution deadline", "TimeoutError")), milliseconds);
      return controller.signal;
    });
    await f.start();
    await vi.advanceTimersByTimeAsync(0);
    const limit = autoDetails ? 300_000 : packageRefreshExecutionDeadlineMs;
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
    expect(f.repository.claimDueDetails).toHaveBeenCalledOnce();
    expect(f.dependencies.revalidateUser).not.toHaveBeenCalled();
    expect(f.collection).not.toHaveBeenCalled();
  });

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

  it.each([401, 403])("backs off automatic admission with truthful HTTP %s status", async status => {
    const f = fixture({ autoDetails: true });
    f.repository.claimDueDetails.mockResolvedValue(f.job);
    f.dependencies.requireAvailable.mockRejectedValueOnce(new AppError(status, status === 401 ? "interaction_required" : "missing_permission", "Denied."));
    await f.service.refreshDueDetails(f.owner);
    expect(f.repository.markFailed).toHaveBeenCalledWith(expect.anything(), f.job.id,
      status === 401 ? "interaction_required" : "missing_permission", expect.stringContaining(status === 401 ? "renewed" : "permission"));
    expect(f.repository.complete).not.toHaveBeenCalled();
  });

  it("preserves role inheritance, exact submission, shared application admission, retry intent and cleanup reasons", async () => {
    const f = fixture();
    const admin = { ...f.owner, roles: ["AgentControl.Admin" as const] };
    for (const tokenMode of ["delegated", "application"] as const) {
      await f.service.submit(admin, { tokenMode, requestedIds: ["exact"], idempotencyKey: randomUUID() });
      expect(f.repository.submit).toHaveBeenLastCalledWith({ tenantId: f.owner.tenantId,
        principalId: tokenMode === "application" ? "synthetic-application-id" : f.owner.homeAccountId },
      expect.objectContaining({ tokenMode, authorizationPrincipalId: f.owner.homeAccountId }));
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
