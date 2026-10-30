import pg from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "../errors.js";
import { DataConnections } from "../db/dataConnections.js";
import { activateAccountSession, revokeAccountSessionMutations } from "../db/sessions.js";
import type { AuthenticatedUser } from "../types/session.js";
import type { PowerPlatformResourceType } from "../types/powerPlatformInventory.js";
import { inventoryProviderRoleIds } from "./inventoryRoleScope.js";
import { PowerPlatformInventoryService } from "./powerPlatformInventory.js";
import { PowerPlatformResourceQueryClient, type ResourceQueryOptions } from "./powerPlatformResourceQuery.js";
import { measureNativePages } from "./inventoryProviderTestSupport.js";
import { inventoryLimits } from "../types/inventoryRecords.js";
import { withTelemetryContext } from "./telemetry.js";
import * as operationalState from "./operationalState.js";
import { inventoryJobInput, inventoryRuntime } from "./inventoryRuntime.js";

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
vi.mock("./inventoryRuntime.js", () => ({
  inventoryJobInput: vi.fn(async (database: { complete: () => Promise<void> }, scope: unknown, _domain: string, jobId: string) => ({
    database, scope, jobId, deadlineAt: new Date(Date.now() + inventoryLimits.powerPlatformDeadlineMs),
  })),
  completeInventoryJob: (input: { database: { complete: () => Promise<void> } }) => async () => input.database.complete(),
  inventoryRuntime: vi.fn(() => ({ enqueue: async () => false })),
}));

const user: AuthenticatedUser = {
  tenantId: "tenant-a", homeAccountId: "principal-a", displayName: "Reader", username: "reader@example.invalid",
  roles: ["AgentControl.Viewer"], providerRoleIds: [inventoryProviderRoleIds.globalReader],
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function fixture(overrides: Record<string, unknown> = {}) {
  const job = { id: "11111111-1111-1111-1111-111111111111", status: "waiting_authorization", roleScope: "full", requestedTypes: ["microsoft.copilotstudio/agents"], pageCount: 0, observedCount: 0, totalRecords: null, unknownFieldCount: 0, snapshotId: null, environmentScope: null, createdAt: "2026-09-08T00:00:00.000Z", attemptedAt: null, updatedAt: "2026-09-08T00:00:00.000Z", finishedAt: null };
  const repository = {
    submit: vi.fn(async (_scope: unknown, _input: unknown, _assertCurrent?: () => void) => job),
    getJob: vi.fn(async (): Promise<typeof job | undefined> => job), markRunning: vi.fn(async () => true), recordProgress: vi.fn(async (): Promise<void> => {}),
    complete: vi.fn(async (): Promise<void> => {}), markWaitingAuthorization: vi.fn(async () => undefined), markFailed: vi.fn(async (): Promise<void> => {}),
    cancel: vi.fn(async (): Promise<typeof job | undefined> => ({ ...job, status: "cancelled" })), recoverInterrupted: vi.fn(async () => 0),
    ...overrides,
  };
  const dependencies = {
    observeOperation: vi.fn(async (_id, _user, operation: (reportFailure: (error: unknown) => void) => Promise<unknown>) => operation(() => undefined)),
    revalidateUser: vi.fn(async () => user), requireAvailable: vi.fn(async () => undefined), delegatedToken: vi.fn(async () => "opaque-token"),
    beginOperationValidation: vi.fn(() => () => {}),
    query: vi.fn(async (_token: string, _types: readonly PowerPlatformResourceType[], _options: ResourceQueryOptions & {
      signal: AbortSignal; onProgress: NonNullable<ResourceQueryOptions["onProgress"]>;
    }): Promise<unknown> => emptyQueryResult()),
    streams: () => ({ powerPlatformCatalog: async (input: { jobId: string }, token: string, types: PowerPlatformResourceType[], options: {
      signal: AbortSignal; authorize: () => Promise<void>;
      onProgress: NonNullable<ResourceQueryOptions["onProgress"]>;
      assertCurrent?: () => void;
      commitPublication: (operation: () => Promise<void>) => Promise<void>;
      onCommitted: () => void;
      completeJob: (client: unknown, result: { jobId: string; rows: number }) => Promise<void>;
    }) => {
      await options.authorize();
      options.signal.throwIfAborted();
      await dependencies.query(token, types, options);
      await options.authorize();
      expect(options.commitPublication).toBeTypeOf("function");
      await options.commitPublication(() => options.completeJob({}, { jobId: input.jobId, rows: 0 }));
      options.onCommitted();
    } }),
  };
  const deadline = { at: new Date(Date.now() + inventoryLimits.powerPlatformDeadlineMs) };
  const boundedRepository = {
    ...repository, database: { complete: () => repository.complete() },
    getJobForExecution: async () => {
      const current = await repository.getJob();
      return current ? { job: current, deadlineAt: deadline.at } : undefined;
    },
  };
  return { job, repository, dependencies, deadline, service: new PowerPlatformInventoryService(boundedRepository as never, dependencies as never) };
}

function emptyQueryResult(): void {
  return undefined;
}

describe("Power Platform inventory refresh service", () => {
  it.each(["enqueue", "observer", "stream_cleanup", "transaction_cleanup"] as const)("does not relabel committed source success after a %s follow-up failure", async stage => {
    const { service, repository, dependencies, job } = fixture();
    const enqueue = vi.fn(async () => {
      if (stage === "enqueue") throw new Error("private reconciliation enqueue error");
      return false;
    });
    vi.mocked(inventoryRuntime).mockReturnValueOnce({ enqueue } as never);
    if (stage === "observer") dependencies.observeOperation.mockImplementation(async (_id, _user, operation) => {
      const result = await operation(() => undefined);
      if (repository.complete.mock.calls.length) throw new Error("private observation error");
      return result;
    });
    if (stage === "stream_cleanup") {
      const streams = dependencies.streams;
      dependencies.streams = () => ({
        powerPlatformCatalog: async (...args) => {
          await streams().powerPlatformCatalog(...args);
          throw new Error("private post-commit cleanup error");
        },
      });
    }
    if (stage === "transaction_cleanup") {
      const client = Object.assign(new pg.Client(), { release: vi.fn(() => {
        throw new Error("private committed connection release failure");
      }) });
      vi.spyOn(client, "query").mockImplementation(async sql => ({
        command: String(sql).split(" ")[0], rows: [], rowCount: 0, fields: [], oid: 0,
      }));
      const database = new pg.Pool({ max: 4 });
      vi.spyOn(database, "connect").mockImplementation(async () => client);
      const connections = new DataConnections(database);
      dependencies.streams = () => ({
        powerPlatformCatalog: async (input, _token, _types, options) => {
          await options.authorize();
          await options.authorize();
          await options.commitPublication(() => connections.run(
            transactionClient => options.completeJob(transactionClient, { jobId: input.jobId, rows: 0 }),
            false, options.signal, undefined, options.assertCurrent, options.onCommitted,
          ));
        },
      });
    }
    await service.start(user, job.id);
    await vi.waitFor(() => expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('"event":"inventory_followup_failed"')));
    await service.drain();
    expect(repository.complete).toHaveBeenCalledOnce();
    expect(repository.markFailed).not.toHaveBeenCalled();
    expect(repository.markWaitingAuthorization).not.toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalledOnce();
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain("private");
  });

  beforeEach(async () => {
    await operationalState.loadOperationalState({ query: vi.fn().mockResolvedValue({ rowCount: 1, rows: [{
      mode: "normal",
    }] }) });
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it.each(["revalidateUser", "requireAvailable", "delegatedToken"] as const)(
    "expires stalled admission at %s using the persisted deadline, not a fresh execution window", async stage => {
      vi.useFakeTimers();
      const { service, repository, dependencies, job, deadline } = fixture();
      deadline.at = new Date(Date.now() + 1000);
      const pending = deferred<never>();
      dependencies[stage].mockReturnValueOnce(pending.promise);
      let failure: unknown;
      const starting = service.start(user, job.id).catch(error => { failure = error; });
      try {
        await vi.waitFor(() => expect(dependencies[stage]).toHaveBeenCalledOnce());
        await vi.advanceTimersByTimeAsync(1000);
        expect(failure).toMatchObject({ code: "inventory_job_expired" });
        expect(repository.markFailed).toHaveBeenCalledWith(expect.anything(), job.id, "inventory_job_expired",
          expect.stringContaining("Start a new refresh"));
        expect(repository.markRunning).not.toHaveBeenCalled();
        expect(repository.complete).not.toHaveBeenCalled();
        job.id = "22222222-2222-4222-8222-222222222222";
        deadline.at = new Date(Date.now() + inventoryLimits.powerPlatformDeadlineMs);
        await expect(service.start(user, job.id)).resolves.toBeDefined();
      } finally {
        await service.drain();
        pending.reject(new AppError(401, "interaction_required", "Late authorization rejection."));
        await starting;
      }
    },
  );

  it("keeps deadline expiry ahead of sign-out while still joining a pending admission write", async () => {
    vi.useFakeTimers();
    const { service, repository, job, deadline } = fixture();
    deadline.at = new Date(Date.now() + 1000);
    const pending = deferred<boolean>();
    repository.markRunning.mockReturnValueOnce(pending.promise);
    let settled = false;
    const starting = service.start(user, job.id).catch(error => { settled = true; return error; });
    await vi.waitFor(() => expect(repository.markRunning).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(1000);
    expect(settled).toBe(false);
    await service.waitForPrincipalAuthorization({ tenantId: user.tenantId!, principalId: user.homeAccountId });
    pending.resolve(true);
    expect(await starting).toMatchObject({ code: "inventory_job_expired" });
    await service.drain();
    expect(repository.markFailed).toHaveBeenCalledWith(expect.anything(), job.id, "inventory_job_expired", expect.any(String));
    expect(repository.markWaitingAuthorization).not.toHaveBeenCalled();
    expect(repository.complete).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("surfaces expiry-status persistence failure to startup and an in-flight shutdown drain", async () => {
    vi.useFakeTimers();
    const { service, repository, dependencies, job, deadline } = fixture();
    deadline.at = new Date(Date.now() + 1000);
    const authorization = deferred<AuthenticatedUser>();
    const persistence = deferred<void>();
    const failure = new Error("Synthetic expiry-status persistence failure.");
    dependencies.revalidateUser.mockReturnValueOnce(authorization.promise);
    repository.markFailed.mockReturnValueOnce(persistence.promise);
    const starting = service.start(user, job.id).catch(error => error);
    await vi.waitFor(() => expect(dependencies.revalidateUser).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(1000);
    expect(repository.markFailed).toHaveBeenCalledOnce();
    const draining = service.drain().catch(error => error);
    persistence.reject(failure);
    expect(await starting).toBe(failure);
    expect(await draining).toBe(failure);
    authorization.reject(new Error("Observed late authorization failure."));
    await vi.advanceTimersByTimeAsync(0);
    expect(repository.markWaitingAuthorization).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not publish or report progress when repeated totals conceal an oversized native inventory", async () => {
    const { service, repository, dependencies, job } = fixture();
    const fetcher = vi.fn(async () => new Response(
      '{"totalRecords":100001,"totalRecords":0,"count":0,"resultTruncated":false,"data":[]}',
    ));
    const client = new PowerPlatformResourceQueryClient(fetcher);
    dependencies.query.mockImplementationOnce((token, types, options) => measureNativePages(client, token, types, options));
    await service.start(user, job.id);
    await vi.waitFor(() => expect(repository.markFailed).toHaveBeenCalledOnce());
    await service.drain();
    expect(repository.markFailed).toHaveBeenCalledWith(expect.anything(), job.id, "provider_schema", expect.any(String));
    expect(repository.recordProgress).not.toHaveBeenCalled();
    expect(repository.complete).not.toHaveBeenCalled();
    expect(repository.markWaitingAuthorization).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it.each(["capability", "replacement", "maintenance"] as const)(
    "fences submission when %s changes during its final write", async interruption => {
      const { service, repository, dependencies, job } = fixture();
      const owner = { ...user, homeAccountId: `inventory-submit-${interruption}` };
      let invalidated = false;
      let replacement: Promise<void> | undefined;
      dependencies.beginOperationValidation.mockReturnValue(() => {
        if (invalidated && interruption === "capability") throw new AppError(401, "authorization_expired", "Capability authority changed.");
      });
      vi.spyOn(operationalState, "requireProviderAdmissions").mockImplementation(() => {
        if (invalidated && interruption === "maintenance") throw new AppError(503, "maintenance", "Provider admissions closed.");
      });
      repository.submit.mockImplementationOnce(async (_scope, _input, assertCurrent) => {
        invalidated = true;
        if (interruption === "replacement") {
          replacement = activateAccountSession(owner.tenantId!, owner.homeAccountId, async () => undefined);
        }
        assertCurrent?.();
        return job;
      });
      await expect(service.submit(owner, { idempotencyKey: "submit-fence", requestedTypes: ["microsoft.copilotstudio/agents"] }))
        .rejects.toMatchObject({ code: interruption === "capability" ? "authorization_expired" : interruption === "replacement" ? "unauthorized" : "maintenance" });
      await replacement;
      expect(dependencies.query).not.toHaveBeenCalled();
    },
  );

  it.each(["get", "cancel"] as const)("fences a pending %s under a replacement sign-in", async action => {
    const { service, repository, job } = fixture();
    const owner = { ...user, homeAccountId: `inventory-metadata-${action}` };
    const pending = deferred<typeof job>();
    repository.getJob.mockReturnValueOnce(pending.promise);
    const result = service[action](owner, job.id).catch(error => error);
    await vi.waitFor(() => expect(repository.getJob).toHaveBeenCalledOnce());
    await activateAccountSession(owner.tenantId!, owner.homeAccountId, async () => undefined);
    pending.resolve(job);
    expect(await result).toMatchObject({ code: "unauthorized" });
    expect(repository.cancel).not.toHaveBeenCalled();
  });

  it("keeps sync cleanup available after revocation without admitting ordinary cancellation or private reads", async () => {
    const { service, repository, job } = fixture();
    const owner = { ...user, homeAccountId: "inventory-revoked-cleanup" };
    await revokeAccountSessionMutations(owner.tenantId!, owner.homeAccountId, async () => undefined);
    await expect(service.get(owner, job.id)).rejects.toMatchObject({ code: "unauthorized" });
    await expect(service.cancel(owner, job.id)).rejects.toMatchObject({ code: "unauthorized" });
    expect(repository.getJob).not.toHaveBeenCalled();
    await expect(service.cancel(owner, job.id, "sync_cleanup")).resolves.toMatchObject({ status: "cancelled" });
    expect(repository.cancel).toHaveBeenCalledWith(expect.anything(), job.id, "sync_cleanup");
  });

  it("rejects private job reads without Viewer authority", async () => {
    const { service, repository, job } = fixture();
    await expect(service.get({ ...user, roles: [] }, job.id)).rejects.toMatchObject({ code: "missing_internal_role" });
    expect(repository.getJob).not.toHaveBeenCalled();
  });

  it("aborts active collection even when cancellation finishes under replacement authority", async () => {
    const { service, repository, dependencies, job } = fixture();
    const owner = { ...user, homeAccountId: "inventory-cancel-response" };
    dependencies.revalidateUser.mockResolvedValue(owner);
    let signal: AbortSignal | undefined;
    dependencies.query.mockImplementation((_token, _types, options) => new Promise((_resolve, reject) => {
      const querySignal = options.signal;
      signal = querySignal;
      querySignal.addEventListener("abort", () => reject(querySignal.reason), { once: true });
    }));
    await service.start(owner, job.id);
    await vi.waitFor(() => expect(dependencies.query).toHaveBeenCalledOnce());
    const pending = deferred<Awaited<ReturnType<typeof repository.cancel>>>();
    repository.cancel.mockReturnValueOnce(pending.promise);
    const result = service.cancel(owner, job.id).catch(error => error);
    await vi.waitFor(() => expect(repository.cancel).toHaveBeenCalledOnce());
    await activateAccountSession(owner.tenantId!, owner.homeAccountId, async () => undefined);
    pending.resolve({ ...job, status: "cancelled" });
    expect(await result).toMatchObject({ code: "unauthorized" });
    expect(signal?.reason).toMatchObject({ code: "read_job_cancelled" });
    await service.drain();
    expect(repository.complete).not.toHaveBeenCalled();
  });

  it.each(["start", "cancel"] as const)("does not return an undefined %s response when retention expires", async action => {
    const { service, repository, dependencies, job } = fixture();
    if (action === "start") {
      repository.getJob.mockResolvedValueOnce(job).mockResolvedValueOnce(undefined);
      dependencies.query.mockImplementation((_token, _types, options) => new Promise((_resolve, reject) =>
        options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true })));
    } else repository.cancel.mockResolvedValueOnce(undefined);
    try {
      await expect(service[action](user, job.id)).rejects.toMatchObject({ code: "inventory_job_expired" });
    } finally { await service.drain(); }
  });

  it.each(["admission", "collection", "publication"] as const)(
    "pins the initiating capability generation through %s", async stage => {
      const { service, repository, dependencies, job } = fixture();
      let invalidated = false;
      const failure = new AppError(401, "authorization_expired", "Capability authority changed.");
      dependencies.beginOperationValidation.mockReturnValue(() => { if (invalidated) throw failure; });
      if (stage === "admission") dependencies.requireAvailable.mockImplementationOnce(async () => { invalidated = true; });
      else if (stage === "collection") dependencies.query.mockImplementationOnce(async () => { invalidated = true; });
      else dependencies.requireAvailable.mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined)
        .mockImplementationOnce(async () => { invalidated = true; });
      if (stage === "admission") {
        await expect(service.start(user, job.id)).rejects.toBe(failure);
        expect(repository.markRunning).not.toHaveBeenCalled();
        expect(dependencies.query).not.toHaveBeenCalled();
      } else {
        await service.start(user, job.id);
        await vi.waitFor(() => expect(repository.markWaitingAuthorization).toHaveBeenCalledOnce());
      }
      await service.drain();
      expect(dependencies.beginOperationValidation).toHaveBeenCalledExactlyOnceWith("powerPlatform.inventory.read", {
        tenantId: user.tenantId, homeAccountId: user.homeAccountId,
      });
      expect(repository.complete).not.toHaveBeenCalled();
      expect(repository.markFailed).not.toHaveBeenCalled();
    },
  );

  it.each(["capability", "replacement", "maintenance"] as const)(
    "rolls back publication when %s changes during its final write", async interruption => {
      const { service, repository, dependencies, job } = fixture();
      const owner = { ...user, homeAccountId: `inventory-commit-${interruption}` };
      dependencies.revalidateUser.mockResolvedValue(owner);
      let invalidated = false;
      dependencies.beginOperationValidation.mockReturnValue(() => {
        if (invalidated && interruption === "capability") throw new AppError(401, "authorization_expired", "Capability authority changed.");
      });
      vi.spyOn(operationalState, "requireProviderAdmissions").mockImplementation(() => {
        if (invalidated && interruption === "maintenance") throw new AppError(503, "maintenance", "Provider admissions closed.");
      });
      const pending = deferred<void>();
      repository.complete.mockReturnValueOnce(pending.promise);
      const client = Object.assign(new pg.Client(), { release: vi.fn() });
      const query = vi.spyOn(client, "query").mockImplementation(async sql => ({
        command: String(sql).split(" ")[0], rows: [], rowCount: 0, fields: [], oid: 0,
      }));
      const database = new pg.Pool({ max: 4 });
      vi.spyOn(database, "connect").mockImplementation(async () => client);
      const connections = new DataConnections(database);
      dependencies.streams = () => ({
        powerPlatformCatalog: async (input, _token, _types, options) => {
          await options.authorize();
          await options.authorize();
          await options.commitPublication(() => connections.run(
            transactionClient => options.completeJob(transactionClient, { jobId: input.jobId, rows: 0 }),
            false, options.signal, undefined, options.assertCurrent,
          ));
        },
      });
      await service.start(owner, job.id);
      await vi.waitFor(() => expect(repository.complete).toHaveBeenCalledOnce());
      invalidated = true;
      const replacement = interruption === "replacement"
        ? activateAccountSession(owner.tenantId!, owner.homeAccountId, async () => undefined) : Promise.resolve();
      pending.resolve();
      await replacement;
      await vi.waitFor(() => expect(repository.markWaitingAuthorization).toHaveBeenCalledOnce());
      await service.drain();
      expect(query).toHaveBeenCalledWith("ROLLBACK");
      expect(query).not.toHaveBeenCalledWith("COMMIT");
      expect(repository.markFailed).not.toHaveBeenCalled();
    },
  );

  it("does not return a delayed running-job response under replacement capability authority", async () => {
    const { service, repository, dependencies, job } = fixture();
    let invalidated = false;
    dependencies.beginOperationValidation.mockReturnValue(() => {
      if (invalidated) throw new AppError(401, "authorization_expired", "Capability authority changed.");
    });
    const response = deferred<typeof job>();
    const collection = deferred<void>();
    repository.getJob.mockResolvedValueOnce(job).mockReturnValueOnce(response.promise);
    dependencies.query.mockReturnValueOnce(collection.promise);
    const starting = service.start(user, job.id).catch(error => error);
    await vi.waitFor(() => expect(dependencies.query).toHaveBeenCalledOnce());
    invalidated = true;
    response.resolve(job);
    const result = await starting;
    collection.resolve();
    await service.drain();
    expect(result).toMatchObject({ code: "authorization_expired" });
    expect(repository.complete).not.toHaveBeenCalled();
  });

  it.each(["maintenance"])(
    "fences inventory resume and publication when admissions close: %s", async code => {
      for (const stage of ["start", "authorization", "activation", "collection"]) {
        const { service, repository, dependencies, job } = fixture();
        let closed = stage === "start";
        vi.spyOn(operationalState, "requireProviderAdmissions").mockImplementation(() => {
          if (closed) throw new AppError(503, code, "Provider admissions are closed.");
        });
        if (stage === "authorization") dependencies.revalidateUser.mockImplementationOnce(async () => { closed = true; return user; });
        if (stage === "activation") repository.markRunning.mockImplementationOnce(async () => { closed = true; return true; });
        if (stage === "collection") dependencies.query.mockImplementationOnce(async () => { closed = true; return emptyQueryResult(); });
        try {
          if (stage === "collection") {
            await service.start(user, job.id);
            await vi.waitFor(() => expect(repository.markWaitingAuthorization).toHaveBeenCalledOnce());
          } else {
            await expect(service.start(user, job.id)).rejects.toMatchObject({ status: 503, code });
            expect(dependencies.query).not.toHaveBeenCalled();
            if (stage === "activation") expect(repository.markWaitingAuthorization).toHaveBeenCalledOnce();
            else expect(repository.markRunning).not.toHaveBeenCalled();
          }
          expect(repository.complete).not.toHaveBeenCalled();
          expect(repository.markFailed).not.toHaveBeenCalled();
          await expect(service.get(user, job.id)).resolves.toMatchObject({ id: job.id });
        } finally {
          await service.drain();
        }
      }
    },
  );

  it.each(["missing_permission", "capability_unavailable", "provider_error"])(
    "does not turn a Power Platform read 403 (%s) into an expired sign-in", async code => {
      const { service, repository, dependencies, job } = fixture();
      dependencies.query.mockRejectedValue(new AppError(403, code, "Permission denied."));
      await service.start(user, job.id);
      await vi.waitFor(() => expect(repository.markFailed).toHaveBeenCalled());
      expect(repository.markWaitingAuthorization).not.toHaveBeenCalled();
      expect(repository.markFailed).toHaveBeenCalledWith(expect.anything(), job.id,
        code === "provider_error" ? "missing_permission" : code, expect.stringContaining("permission"));
    },
  );

  it("starts only after current authorization and publishes complete results", async () => {
    const { service, repository, dependencies } = fixture();
    await expect(service.start(user, "11111111-1111-1111-1111-111111111111")).resolves.toMatchObject({ status: "waiting_authorization" });
    await vi.waitFor(() => expect(repository.complete).toHaveBeenCalledTimes(1));
    expect(dependencies.query).toHaveBeenCalledWith("opaque-token", ["microsoft.copilotstudio/agents"], expect.objectContaining({ expectedTenantId: "tenant-a" }));
    expect(dependencies.requireAvailable).toHaveBeenCalledBefore(dependencies.delegatedToken);
    expect(repository.markRunning).toHaveBeenCalledBefore(dependencies.query);
  });

  it.each(["load", "query"] as const)("pins inventory authorization through %s across a replacement sign-in", async stage => {
    const { service, repository, dependencies, job } = fixture();
    const owner = { ...user, homeAccountId: `replacement-inventory-${stage}` };
    dependencies.revalidateUser.mockResolvedValue(owner);
    const loaded = deferred<typeof job>();
    const queried = deferred<void>();
    if (stage === "load") repository.getJob.mockReturnValueOnce(loaded.promise);
    else dependencies.query.mockReturnValueOnce(queried.promise);
    const request = service.start(owner, job.id).catch(error => error);
    await vi.waitFor(() => expect(stage === "load" ? repository.getJob : dependencies.query).toHaveBeenCalled());
    await activateAccountSession(owner.tenantId!, owner.homeAccountId, async () => undefined);
    loaded.resolve(job);
    queried.resolve(emptyQueryResult());
    if (stage === "load") {
      expect(await request).toMatchObject({ code: "unauthorized" });
      expect(dependencies.revalidateUser).not.toHaveBeenCalled();
    } else {
      await request;
      await vi.waitFor(() => expect(repository.markWaitingAuthorization).toHaveBeenCalled());
    }
    expect(repository.complete).not.toHaveBeenCalled();
  });

  it("forwards explicit readiness retry and internal cleanup without querying after failure", async () => {
    const { service, repository, dependencies, job } = fixture();
    dependencies.requireAvailable.mockRejectedValueOnce(new AppError(504, "provider_timeout", "Readiness timed out."));
    await expect(service.start(user, job.id, { retryFailed: true })).rejects.toMatchObject({ code: "provider_timeout" });
    expect(dependencies.requireAvailable).toHaveBeenCalledWith("powerPlatform.inventory.read", user, { retryFailed: true });
    expect(repository.markRunning).not.toHaveBeenCalled();
    expect(dependencies.query).not.toHaveBeenCalled();
    expect(repository.markFailed).toHaveBeenCalledWith(expect.anything(), job.id, "provider_timeout", "Readiness timed out.");
    await service.cancel(user, job.id, "sync_cleanup");
    expect(repository.cancel).toHaveBeenCalledWith(
      { tenantId: user.tenantId, principalId: user.homeAccountId }, job.id, "sync_cleanup",
    );
  });

  it.each(["revalidateUser", "requireAvailable", "delegatedToken"] as const)(
    "records non-authorization admission failure at %s as failed work", async stage => {
      const { service, repository, dependencies, job } = fixture();
      dependencies[stage].mockRejectedValueOnce(new AppError(502, "provider_schema", "Provider contract was invalid."));
      await expect(service.start(user, job.id)).rejects.toMatchObject({ code: "provider_schema" });
      expect(repository.markFailed).toHaveBeenCalledWith(expect.anything(), job.id, "provider_schema", "Provider contract was invalid.");
      expect(repository.markRunning).not.toHaveBeenCalled();
      expect(repository.markWaitingAuthorization).not.toHaveBeenCalled();
      expect(dependencies.query).not.toHaveBeenCalled();
    },
  );

  it("does not overwrite a raced activation it did not own", async () => {
    const { service, repository, dependencies, job } = fixture();
    repository.markRunning.mockResolvedValueOnce(false);
    await expect(service.start(user, job.id)).rejects.toMatchObject({ code: "inventory_job_state" });
    expect(repository.markFailed).not.toHaveBeenCalled();
    expect(repository.markWaitingAuthorization).not.toHaveBeenCalled();
    expect(dependencies.query).not.toHaveBeenCalled();
  });

  it.each(["revalidateUser", "requireAvailable", "delegatedToken"] as const)(
    "releases cancelled provider admission at %s without waiting for late authorization", async stage => {
      const { service, repository, dependencies, job } = fixture();
      const pending = deferred<never>();
      dependencies[stage].mockReturnValueOnce(pending.promise);
      const starting = service.start(user, job.id).catch(error => error);
      await vi.waitFor(() => expect(dependencies[stage]).toHaveBeenCalledOnce());
      await service.cancel(user, job.id);
      expect(await starting).toMatchObject({ code: "read_job_cancelled" });
      await service.drain();
      pending.reject(new AppError(403, "missing_permission", "Late permission denial."));
      await Promise.resolve();
      expect(repository.markRunning).not.toHaveBeenCalled();
      expect(repository.markFailed).not.toHaveBeenCalled();
      expect(dependencies.query).not.toHaveBeenCalled();
    },
  );

  it("uses the remaining persisted deadline, including authorization waits, instead of a new execution budget", async () => {
    vi.useFakeTimers();
    const { service, repository, dependencies, job } = fixture();
    const pending = deferred<AuthenticatedUser>();
    dependencies.revalidateUser.mockResolvedValueOnce(user).mockReturnValueOnce(pending.promise);
    vi.mocked(inventoryJobInput).mockResolvedValueOnce({
      scope: { tenantId: user.tenantId!, principalId: null, kind: "tenant", tokenMode: "tenant",
        source: "inventory_power_platform", selector: "complete" },
      actorPrincipalId: user.homeAccountId,
      schemaVersion: 1, sessionEpoch: "0", jobId: job.id, jobKind: "power_platform_refresh",
      observedAt: new Date(), expiresAt: new Date(Date.now() + 60_000),
      deadlineAt: new Date(Date.now() + 1000), reserveBytes: 1024,
    });
    await service.start(user, job.id);
    await vi.advanceTimersByTimeAsync(1000);
    expect(repository.markFailed).toHaveBeenCalledWith(expect.anything(), job.id, "provider_timeout", expect.stringContaining("execution limit"));
    await service.drain();
    pending.resolve(user);
    await vi.advanceTimersByTimeAsync(0);
    expect(repository.complete).not.toHaveBeenCalled();
    expect(dependencies.query).not.toHaveBeenCalled();
  });

  it("does not fail an agent-only query when optional role claims disappear or change to another supported inventory role", async () => {
    for (const providerRoleIds of [[], [inventoryProviderRoleIds.aiReader]]) {
      const { service, job, repository, dependencies } = fixture();
      dependencies.revalidateUser.mockResolvedValue({ ...user, providerRoleIds });
      await service.start(user, job.id);
      await vi.waitFor(() => expect(repository.complete).toHaveBeenCalledOnce());
      expect(repository.markWaitingAuthorization).not.toHaveBeenCalled();
      expect(repository.markFailed).not.toHaveBeenCalled();
      expect(dependencies.requireAvailable).toHaveBeenCalledTimes(3);
    }
  });

  it("preserves the two-type query when changing between supported full and AI roles", async () => {
    const changedUser = { ...user, providerRoleIds: [inventoryProviderRoleIds.aiReader] };
    const duringQuery = fixture();
    duringQuery.job.requestedTypes = ["microsoft.copilotstudio/agents", "microsoft.powerplatform/environments"];
    duringQuery.dependencies.revalidateUser.mockResolvedValueOnce(user).mockResolvedValueOnce(user).mockResolvedValueOnce(changedUser);
    await duringQuery.service.start(user, duringQuery.job.id);
    await vi.waitFor(() => expect(duringQuery.repository.complete).toHaveBeenCalledOnce());
    expect(duringQuery.dependencies.query).toHaveBeenCalledWith(expect.any(String), duringQuery.job.requestedTypes, expect.any(Object));
    expect(duringQuery.repository.markFailed).not.toHaveBeenCalled();
    expect(duringQuery.repository.markWaitingAuthorization).not.toHaveBeenCalled();
  });

  it("leaves authorization failures waiting without issuing a provider query", async () => {
    const { service, repository, dependencies } = fixture();
    dependencies.delegatedToken.mockRejectedValue(new AppError(401, "interaction_required", "authorization required"));
    await expect(service.start(user, "11111111-1111-1111-1111-111111111111")).rejects.toMatchObject({ code: "interaction_required" });
    expect(repository.markRunning).not.toHaveBeenCalled();
    expect(dependencies.query).not.toHaveBeenCalled();
    expect(vi.mocked(console.warn).mock.calls.map(([entry]) => JSON.parse(entry))).toContainEqual(expect.objectContaining({
      event: "inventory_refresh_start_failed", stage: "delegated_token", errorCode: "interaction_required",
    }));
  });

  it.each(["revalidateUser", "requireAvailable", "delegatedToken"] as const)(
    "records an admission permission denial at %s instead of asking for another sign-in", async stage => {
      const { service, repository, dependencies, job } = fixture();
      const failure = new AppError(403, "provider_error", "Private provider denial.");
      dependencies[stage].mockRejectedValueOnce(failure);
      await expect(service.start(user, job.id)).rejects.toBe(failure);
      expect(repository.markFailed).toHaveBeenCalledWith(
        { tenantId: user.tenantId, principalId: user.homeAccountId }, job.id, "missing_permission",
        expect.stringContaining("signing in again does not grant permissions"),
      );
      expect(repository.markRunning).not.toHaveBeenCalled();
      expect(repository.markWaitingAuthorization).not.toHaveBeenCalled();
      expect(dependencies.query).not.toHaveBeenCalled();
    },
  );

  it("does not fail an unowned or already-started job on an admission rejection", async () => {
    for (const status of ["missing", "running"]) {
      const { service, repository, dependencies, job } = fixture(status === "missing" ? { getJob: vi.fn(async () => undefined) } : {});
      if (status === "running") job.status = status;
      await expect(service.start(user, job.id)).rejects.toMatchObject({
        code: status === "missing" ? "not_found" : "inventory_job_state",
      });
      expect(repository.markFailed).not.toHaveBeenCalled();
      expect(dependencies.revalidateUser).not.toHaveBeenCalled();
    }
  });

  it.each(["admission readiness", "admission token", "publication readiness"] as const)(
    "does not hold the account lock during %s", async phase => {
      const { service, repository, dependencies, job } = fixture();
      const owner = { ...user, homeAccountId: `inventory-signout-${phase}` };
      dependencies.revalidateUser.mockResolvedValue(owner);
      const pending = deferred<void>();
      if (phase === "admission token") {
        dependencies.delegatedToken.mockImplementationOnce(async () => { await pending.promise; return "opaque-token"; });
      } else if (phase === "admission readiness") {
        dependencies.requireAvailable.mockImplementationOnce(async () => { await pending.promise; });
      } else {
        dependencies.requireAvailable.mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined).mockImplementationOnce(async () => { await pending.promise; });
      }
      const request = service.start(owner, job.id).catch(error => error);
      const boundary = phase === "admission token" ? dependencies.delegatedToken : dependencies.requireAvailable;
      await vi.waitFor(() => expect(boundary).toHaveBeenCalledTimes(phase === "publication readiness" ? 3 : 1));
      const cleanup = vi.fn(async () => service.waitForPrincipalAuthorization({
        tenantId: owner.tenantId!, principalId: owner.homeAccountId,
      }));
      const logout = revokeAccountSessionMutations(owner.tenantId!, owner.homeAccountId, cleanup);
      try {
        await vi.waitFor(() => expect(cleanup).toHaveBeenCalledOnce());
      } finally {
        pending.resolve();
        await logout;
        await request;
        await service.drain();
      }
      expect(repository.complete).not.toHaveBeenCalled();
      expect(repository.markFailed).not.toHaveBeenCalled();
      expect(repository.markWaitingAuthorization).toHaveBeenCalledTimes(phase === "publication readiness" ? 1 : 0);
    },
  );

  it.each(["replacement", "maintenance"] as const)(
    "stops paging when %s interrupts an awaited progress write", async interruption => {
      const { service, repository, dependencies, job } = fixture();
      const owner = { ...user, tenantId: "11111111-1111-1111-1111-111111111111", homeAccountId: `inventory-progress-${interruption}` };
      dependencies.revalidateUser.mockResolvedValue(owner);
      const pending = deferred<void>();
      let page = 0;
      const fetcher = vi.fn(async () => {
        page += 1;
        return Response.json({
          totalRecords: 2, count: 1, resultTruncated: page === 1 ? 1 : 0,
          ...(page === 1 ? { skipToken: "next" } : {}),
          data: [{ tenantId: owner.tenantId, name: `agent-${page}`, type: "microsoft.copilotstudio/agents", properties: {} }],
        });
      });
      const client = new PowerPlatformResourceQueryClient(fetcher);
      let closed = false;
      vi.spyOn(operationalState, "requireProviderAdmissions").mockImplementation(() => {
        if (closed) throw new AppError(503, "maintenance", "Provider admissions are closed.");
      });
      repository.recordProgress.mockReturnValueOnce(pending.promise);
      dependencies.query.mockImplementationOnce((token, types, options) => measureNativePages(client, token, types, options));
      await service.start(owner, job.id);
      await vi.waitFor(() => expect(repository.recordProgress).toHaveBeenCalledOnce());
      if (interruption === "replacement") await activateAccountSession(owner.tenantId!, owner.homeAccountId, async () => undefined);
      else closed = true;
      pending.resolve();
      await vi.waitFor(() => expect(repository.markWaitingAuthorization).toHaveBeenCalledOnce());
      await service.drain();
      expect(fetcher).toHaveBeenCalledOnce();
      expect(repository.complete).not.toHaveBeenCalled();
      expect(repository.markFailed).not.toHaveBeenCalled();
    },
  );

  it("reports a publication scope mismatch as a data failure, not a consent request", async () => {
    const { service, job, repository } = fixture();
    repository.complete.mockRejectedValue(new AppError(409, "scope_mismatch", "The completed inventory query did not match the authorized resource types and environment."));
    await service.start(user, job.id);
    await vi.waitFor(() => expect(repository.markFailed).toHaveBeenCalledWith(
      { tenantId: user.tenantId, principalId: user.homeAccountId }, job.id, "scope_mismatch",
      expect.stringContaining("completed inventory query"),
    ));
    expect(repository.markWaitingAuthorization).not.toHaveBeenCalled();
  });

  it("correlates accepted requests with background progress and publication", async () => {
    const { service, job, repository, dependencies } = fixture();
    dependencies.query.mockImplementation(async (_token, _types, options) => {
      await options.onProgress({ pages: 1, observedCount: 0, totalRecords: 0 });
      return emptyQueryResult();
    });
    await withTelemetryContext({ requestId: "request-a", route: "/inventory/refresh-jobs" }, () => service.start(user, job.id));
    await vi.waitFor(() => expect(vi.mocked(console.log).mock.calls.map(([entry]) => JSON.parse(entry)))
      .toContainEqual(expect.objectContaining({ event: "inventory_refresh_succeeded" })));
    const entries = vi.mocked(console.log).mock.calls.map(([entry]) => JSON.parse(entry));
    for (const event of ["inventory_refresh_started", "inventory_refresh_progress", "inventory_refresh_succeeded"]) {
      expect(entries).toContainEqual(expect.objectContaining({ event, requestId: "request-a", jobId: job.id, route: "/inventory/refresh-jobs" }));
    }
    expect(entries).toContainEqual(expect.objectContaining({
      event: "inventory_refresh_succeeded", queriedTypeCount: 1,
    }));
    expect(repository.recordProgress).toHaveBeenCalledWith({ tenantId: user.tenantId, principalId: user.homeAccountId }, job.id, 1, 0, 0);
    expect(JSON.stringify(entries)).not.toContain(user.homeAccountId);
    expect(JSON.stringify(entries)).not.toContain(user.username);
  });

  it("logs asynchronous provider failures after submission without exposing error messages", async () => {
    const { service, job, dependencies } = fixture();
    dependencies.query.mockRejectedValue(new AppError(502, "provider_schema", "private-provider-row"));
    await withTelemetryContext({ requestId: "request-failed" }, () => service.start(user, job.id));
    await vi.waitFor(() => expect(vi.mocked(console.error).mock.calls.map(([entry]) => JSON.parse(entry)))
      .toContainEqual(expect.objectContaining({
        event: "inventory_refresh_failed", requestId: "request-failed", jobId: job.id,
        status: "failed", errorCode: "provider_schema", stage: "query",
      })));
    expect(JSON.stringify([...vi.mocked(console.warn).mock.calls, ...vi.mocked(console.error).mock.calls])).not.toContain("private-provider-row");
  });

  it("allows a minute-long enumeration within the existing thirty-minute source budget", async () => {
    vi.useFakeTimers();
    const { service, job, dependencies, repository } = fixture();
    dependencies.query.mockImplementation((_token, _types, options) => new Promise((resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
      setTimeout(() => resolve(emptyQueryResult()), 61_500);
    }));
    await service.start(user, job.id);
    await vi.advanceTimersByTimeAsync(61_500);
    expect(repository.complete).toHaveBeenCalledOnce();
    expect(repository.markFailed).not.toHaveBeenCalled();
    expect(repository.markWaitingAuthorization).not.toHaveBeenCalled();
  });

  it("still cancels a pending startup response after the execution has committed and disposed its deadline", async () => {
    const { service, repository, job } = fixture();
    const response = deferred<typeof job>();
    repository.getJob.mockResolvedValueOnce(job).mockReturnValueOnce(response.promise);
    const starting = service.start(user, job.id);
    const stopped = expect(starting).rejects.toMatchObject({ code: "interaction_required" });
    await vi.waitFor(() => expect(console.log).toHaveBeenCalledWith(expect.stringContaining("inventory_refresh_succeeded")));
    const draining = service.drain();
    response.resolve({ ...job, status: "succeeded" });
    await stopped;
    await draining;
    expect(repository.complete).toHaveBeenCalledOnce();
    expect(repository.markWaitingAuthorization).not.toHaveBeenCalled();
    expect(repository.markFailed).not.toHaveBeenCalled();
  });

  it.each([
    new AppError(504, "provider_timeout", `Power Platform inventory exceeded its ${inventoryLimits.powerPlatformDeadlineMs / 1_000}-second execution limit.`),
    new DOMException("private execution timeout", "TimeoutError"),
  ])("persists a clear timeout failure instead of generic failure or waiting authorization", async error => {
    const { service, job, dependencies, repository } = fixture();
    dependencies.query.mockRejectedValue(error);
    await service.start(user, job.id);
    await vi.waitFor(() => expect(repository.markFailed).toHaveBeenCalledOnce());
    expect(repository.markFailed).toHaveBeenCalledWith(
      { tenantId: user.tenantId, principalId: user.homeAccountId }, job.id, "provider_timeout",
      expect.stringMatching(/1800-second execution limit/),
    );
    expect(repository.complete).not.toHaveBeenCalled();
    expect(repository.markWaitingAuthorization).not.toHaveBeenCalled();
  });

  it("finishes every bounded restart recovery batch without starting provider work", async () => {
    const { service, repository, dependencies } = fixture();
    repository.recoverInterrupted.mockResolvedValueOnce(500).mockResolvedValueOnce(17).mockResolvedValueOnce(0);
    await expect(service.recover()).resolves.toBe(517);
    expect(repository.recoverInterrupted).toHaveBeenCalledTimes(3);
    expect(dependencies.revalidateUser).not.toHaveBeenCalled();
    expect(dependencies.query).not.toHaveBeenCalled();
    expect(repository.markRunning).not.toHaveBeenCalled();
  });

  it.each([0, 1])("stops restart recovery after %s batches when admissions close", async batches => {
    const { service, repository } = fixture();
    repository.recoverInterrupted.mockResolvedValue(500);
    const admissionsOpen = vi.fn(async () => repository.recoverInterrupted.mock.calls.length < batches);
    await expect(service.recover(admissionsOpen)).resolves.toBe(500 * batches);
    expect(repository.recoverInterrupted).toHaveBeenCalledTimes(batches);
  });

  it("propagates failed restart admission checks instead of continuing recovery", async () => {
    const { service, repository } = fixture();
    repository.recoverInterrupted.mockResolvedValue(500);
    const failure = new Error("Recovery admission unavailable.");
    const admissionsOpen = vi.fn().mockResolvedValueOnce(true).mockRejectedValueOnce(failure);
    await expect(service.recover(admissionsOpen)).rejects.toBe(failure);
    expect(repository.recoverInterrupted).toHaveBeenCalledOnce();
  });

  it("turns interrupted work into explicit reauthorization and drains all active refreshes", async () => {
    const first = fixture();
    first.dependencies.query.mockImplementation((_token, _types, options) => new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true })));
    await first.service.start(user, first.job.id);
    await first.service.drain();
    expect(first.repository.markWaitingAuthorization).toHaveBeenCalledTimes(1);
    expect(first.repository.complete).not.toHaveBeenCalled();
  });

  it("lets Admin inherit Viewer authority and fences publication after all roles are lost", async () => {
    const admin = { ...user, roles: ["AgentControl.Admin" as const] };
    const direct = fixture();
    await expect(direct.service.submit(admin, { idempotencyKey: "admin-read", requestedTypes: ["microsoft.copilotstudio/agents"] })).resolves.toBeDefined();
    expect(direct.repository.submit).toHaveBeenCalledOnce();

    const fenced = fixture();
    fenced.dependencies.revalidateUser
      .mockResolvedValueOnce(user)
      .mockResolvedValueOnce(user)
      .mockResolvedValueOnce({ ...user, roles: [] });
    await fenced.service.start(user, fenced.job.id);
    await vi.waitFor(() => expect(fenced.repository.markFailed).toHaveBeenCalledWith(
      expect.anything(), fenced.job.id, "missing_internal_role", expect.stringContaining("application role")));
    expect(fenced.repository.markWaitingAuthorization).not.toHaveBeenCalled();
    expect(fenced.dependencies.query).toHaveBeenCalledOnce();
    expect(fenced.repository.complete).not.toHaveBeenCalled();
  });

  it("lets only the owning Viewer cancel its inventory refresh", async () => {
    const direct = fixture();
    await expect(direct.service.cancel(user, direct.job.id)).resolves.toMatchObject({ status: "cancelled" });
    expect(direct.repository.cancel).toHaveBeenCalledWith({ tenantId: user.tenantId, principalId: user.homeAccountId }, direct.job.id, "requested", expect.any(Function));
    await expect(direct.service.cancel({ ...user, roles: [] }, direct.job.id)).rejects.toMatchObject({ code: "missing_internal_role" });
  });

  it.each(["uppercase", "lowercase"] as const)("matches mixed-case UUID resume and cancellation after %s admission", async casing => {
    const { service, dependencies, job, repository } = fixture();
    job.id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    let querySignal: AbortSignal | undefined;
    dependencies.query.mockImplementation((_token, _types, options) => new Promise((_resolve, reject) => {
      querySignal = options.signal;
      options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
    }));
    const startId = casing === "uppercase" ? job.id.toUpperCase() : job.id;
    const otherId = casing === "uppercase" ? job.id : job.id.toUpperCase();
    await service.start(user, startId);
    try {
      await expect(service.start(user, otherId)).rejects.toMatchObject({ code: "inventory_job_state" });
      await service.cancel(user, otherId);
      expect(querySignal?.aborted).toBe(true);
      expect(querySignal?.reason).toMatchObject({ code: "read_job_cancelled" });
      expect(dependencies.query).toHaveBeenCalledOnce();
      expect(repository.markRunning).toHaveBeenCalledWith({ tenantId: user.tenantId, principalId: user.homeAccountId }, job.id);
    } finally {
      await service.drain();
    }
  });

  it("bounds global refresh execution and recovers capacity after principal cancellation", async () => {
    const bounded = fixture({ getJob: vi.fn(async (_scope, id) => ({ ...fixture().job, id })) });
    bounded.dependencies.query.mockImplementation((_token, _types, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
    }));
    const ids = [1, 2, 3, 4, 5].map(value => `11111111-1111-1111-1111-11111111111${value}`);
    for (const id of ids.slice(0, 4)) await bounded.service.start(user, id);
    await expect(bounded.service.start(user, ids[4])).rejects.toMatchObject({ code: "inventory_capacity" });
    await bounded.service.waitForPrincipalAuthorization({ tenantId: "tenant-a", principalId: "principal-a" });
    await vi.waitFor(() => expect(bounded.repository.markWaitingAuthorization).toHaveBeenCalledTimes(4));
    await Promise.resolve();
    expect(bounded.repository.markWaitingAuthorization).toHaveBeenCalledTimes(4);
    await expect(bounded.service.start(user, ids[4])).resolves.toBeDefined();
    await bounded.service.drain();
  });

  it("does not consume admission capacity when tenant scope is missing", async () => {
    const { service, dependencies, job } = fixture();
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await expect(service.start({ ...user, tenantId: undefined }, job.id)).rejects.toMatchObject({ code: "unauthorized" });
    }
    await expect(service.start(user, job.id)).resolves.toBeDefined();
    await service.drain();
    expect(dependencies.query).toHaveBeenCalledOnce();
  });

  it("counts each job once while its running-job response is pending", async () => {
    const { service, repository, dependencies, job } = fixture();
    const response = deferred<typeof job>();
    repository.getJob.mockResolvedValueOnce(job).mockReturnValueOnce(response.promise);
    dependencies.query.mockImplementation((_token, _types, options) => new Promise((_resolve, reject) =>
      options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true })));
    const starting = service.start(user, job.id);
    await vi.waitFor(() => expect(dependencies.query).toHaveBeenCalledOnce());
    try {
      for (let index = 2; index <= 4; index += 1) {
        await expect(service.start(user, `11111111-1111-1111-1111-11111111111${index}`)).resolves.toBeDefined();
      }
      await expect(service.start(user, "11111111-1111-1111-1111-111111111115")).rejects.toMatchObject({ code: "inventory_capacity" });
    } finally {
      response.resolve(job);
      await starting;
      await service.drain();
    }
  });

  it.each(["getJob", "revalidateUser", "requireAvailable", "delegatedToken", "markRunning"] as const)(
    "stops admission paused at %s when its principal signs out",
    async stage => {
      const { service, repository, dependencies, job } = fixture();
      const pending = deferred<void>();
      if (stage === "getJob") repository.getJob.mockImplementationOnce(async () => { await pending.promise; return job; });
      if (stage === "revalidateUser") dependencies.revalidateUser.mockImplementationOnce(async () => { await pending.promise; return user; });
      if (stage === "requireAvailable") dependencies.requireAvailable.mockImplementationOnce(async () => { await pending.promise; });
      if (stage === "delegatedToken") dependencies.delegatedToken.mockImplementationOnce(async () => { await pending.promise; return "opaque-token"; });
      if (stage === "markRunning") repository.markRunning.mockImplementationOnce(async () => { await pending.promise; return true; });
      const boundary = stage === "getJob" || stage === "markRunning" ? repository[stage] : dependencies[stage];
      const starting = service.start(user, job.id);
      const stopped = expect(starting).rejects.toMatchObject({ code: "interaction_required" });
      await vi.waitFor(() => expect(boundary).toHaveBeenCalledOnce());
      await service.waitForPrincipalAuthorization({ tenantId: user.tenantId!, principalId: user.homeAccountId });
      pending.resolve();
      await stopped;
      await service.drain();
      expect(dependencies.query).not.toHaveBeenCalled();
      expect(repository.complete).not.toHaveBeenCalled();
      expect(repository.markWaitingAuthorization).toHaveBeenCalledTimes(stage === "markRunning" ? 1 : 0);
    },
  );

  it.each(
    (["cancel", "logout", "shutdown"] as const).flatMap(interruption =>
      (["getJob", "revalidateUser", "requireAvailable", "delegatedToken", "markRunning"] as const)
        .map(stage => ({ interruption, stage }))),
  )("preserves $interruption when pending admission at $stage later rejects", async ({ interruption, stage }) => {
    const { service, repository, dependencies, job } = fixture();
    const pending = deferred<never>();
    const boundary = stage === "getJob" || stage === "markRunning" ? repository[stage] : dependencies[stage];
    boundary.mockReturnValueOnce(pending.promise);
    const starting = service.start(user, job.id);
    const result = starting.catch(error => error);
    await vi.waitFor(() => expect(boundary).toHaveBeenCalledOnce());
    if (interruption === "cancel") await service.cancel(user, job.id);
    else if (interruption === "logout") await service.waitForPrincipalAuthorization({ tenantId: user.tenantId!, principalId: user.homeAccountId });
    const draining = service.drain().catch(error => error);
    pending.reject(new AppError(403, "missing_permission", "Late authorization rejection."));
    const [failure, drainFailure] = await Promise.all([result, draining]);
    expect(failure).toMatchObject({ code: interruption === "cancel" ? "read_job_cancelled" : "interaction_required" });
    expect(drainFailure).toBeUndefined();
    expect(repository.markFailed).not.toHaveBeenCalled();
    expect(dependencies.query).not.toHaveBeenCalled();
    expect(repository.complete).not.toHaveBeenCalled();
  });

  it("retains an admission permission-status persistence failure during shutdown", async () => {
    const { service, repository, dependencies, job } = fixture();
    const pending = deferred<void>();
    const failure = new Error("Private admission status write failure.");
    dependencies.delegatedToken.mockRejectedValueOnce(new AppError(403, "missing_permission", "Consent denied."));
    repository.markFailed.mockReturnValueOnce(pending.promise);
    const starting = service.start(user, job.id).catch(error => error);
    await vi.waitFor(() => expect(repository.markFailed).toHaveBeenCalledOnce());
    const draining = service.drain().catch(error => error);
    pending.reject(failure);
    expect(await starting).toBe(failure);
    expect(await draining).toBe(failure);
    expect(dependencies.query).not.toHaveBeenCalled();
  });

  it.each(["replacement", "maintenance"] as const)(
    "keeps interrupted admission waiting when %s precedes a late permission denial", async interruption => {
      const { service, repository, dependencies, job } = fixture();
      const owner = { ...user, homeAccountId: `inventory-admission-${interruption}` };
      const pending = deferred<AuthenticatedUser>();
      let closed = false;
      vi.spyOn(operationalState, "requireProviderAdmissions").mockImplementation(() => {
        if (closed) throw new AppError(503, "maintenance", "Provider admissions are closed.");
      });
      dependencies.revalidateUser.mockReturnValueOnce(pending.promise);
      const request = service.start(owner, job.id).catch(error => error);
      await vi.waitFor(() => expect(dependencies.revalidateUser).toHaveBeenCalledOnce());
      if (interruption === "replacement") await activateAccountSession(owner.tenantId!, owner.homeAccountId, async () => undefined);
      else closed = true;
      pending.reject(new AppError(403, "missing_permission", "Late permission denial."));
      expect(await request).toMatchObject({ code: interruption === "replacement" ? "unauthorized" : "maintenance" });
      await service.drain();
      expect(repository.markRunning).not.toHaveBeenCalled();
      expect(repository.markFailed).not.toHaveBeenCalled();
      expect(dependencies.query).not.toHaveBeenCalled();
    },
  );

  it("drains pending admission writes before shutdown completes and rejects further starts", async () => {
    const { service, repository, dependencies, job } = fixture();
    const pending = deferred<boolean>();
    repository.markRunning.mockReturnValueOnce(pending.promise);
    const starting = service.start(user, job.id);
    const stopped = expect(starting).rejects.toMatchObject({ code: "interaction_required" });
    await vi.waitFor(() => expect(repository.markRunning).toHaveBeenCalledOnce());
    const drained = vi.fn();
    const draining = service.drain().then(drained);
    await Promise.resolve();
    await Promise.resolve();
    const returnedEarly = drained.mock.calls.length > 0;
    pending.resolve(true);
    await stopped;
    await draining;
    expect(returnedEarly).toBe(false);
    expect(repository.markRunning).toHaveBeenCalledOnce();
    expect(repository.markWaitingAuthorization).toHaveBeenCalledOnce();
    expect(dependencies.query).not.toHaveBeenCalled();
    await expect(service.start(user, job.id)).rejects.toMatchObject({ code: "inventory_shutdown" });
  });

  it("rejects duplicate admission without reserving another execution", async () => {
    const { service, dependencies, job } = fixture();
    const pending = deferred<AuthenticatedUser>();
    dependencies.revalidateUser.mockReturnValueOnce(pending.promise);
    const starting = service.start(user, job.id);
    try {
      await expect(service.start(user, job.id)).rejects.toMatchObject({ code: "inventory_job_state" });
    } finally {
      pending.resolve(user);
      await starting;
      await vi.waitFor(() => expect(dependencies.query).toHaveBeenCalledOnce());
      await service.drain();
    }
    expect(dependencies.query).toHaveBeenCalledOnce();
  });

  it.each(["starting", "running"] as const)("conceals a %s job from other principals and tenants", async phase => {
    const { service, dependencies, repository, job } = fixture();
    job.id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const pending = deferred<AuthenticatedUser>();
    if (phase === "starting") dependencies.revalidateUser.mockReturnValueOnce(pending.promise);
    dependencies.query.mockImplementation((_token, _types, options) => new Promise((_resolve, reject) =>
      options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true })));
    const starting = service.start(user, job.id);
    await vi.waitFor(() => expect(dependencies.revalidateUser).toHaveBeenCalledTimes(phase === "running" ? 2 : 1));
    if (phase === "running") await starting;
    try {
      const reads = repository.getJob.mock.calls.length;
      for (const other of [{ ...user, homeAccountId: "other-principal" }, { ...user, tenantId: "other-tenant" }]) {
        await expect(service.start(other, job.id.toUpperCase())).rejects.toMatchObject({ status: 404, code: "not_found" });
      }
      expect(repository.getJob).toHaveBeenCalledTimes(reads);
      expect(dependencies.revalidateUser).toHaveBeenCalledTimes(phase === "running" ? 2 : 1);
    } finally {
      pending.resolve(user);
      await starting;
      await service.drain();
    }
  });

  it.each(
    (["cancel", "logout", "shutdown", "deadline"] as const).flatMap(interruption =>
      (["resolves", "rejects"] as const).map(settlement => ({ interruption, settlement }))),
  )(
    "preserves the $interruption outcome when pending publication authorization $settlement later",
    async ({ interruption, settlement }) => {
      vi.useFakeTimers();
      const { service, dependencies, repository, job } = fixture();
      const pending = deferred<AuthenticatedUser>();
      dependencies.revalidateUser.mockResolvedValueOnce(user).mockResolvedValueOnce(user).mockReturnValueOnce(pending.promise);
      await service.start(user, job.id);
      await vi.waitFor(() => expect(dependencies.revalidateUser).toHaveBeenCalledTimes(3));
      let draining: Promise<void> | undefined;
      if (interruption === "cancel") await service.cancel(user, job.id);
      else if (interruption === "logout") await service.waitForPrincipalAuthorization({ tenantId: user.tenantId!, principalId: user.homeAccountId });
      else if (interruption === "shutdown") draining = service.drain();
      await vi.advanceTimersByTimeAsync(inventoryLimits.powerPlatformDeadlineMs);
      if (settlement === "resolves") pending.resolve(user);
      else pending.reject(interruption === "deadline"
        ? new AppError(401, "interaction_required", "Late authorization failure.")
        : new Error("Late authorization transport failure."));
      await (draining ?? service.drain());
      expect(repository.complete).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
      if (interruption === "deadline") {
        expect(repository.markFailed).toHaveBeenCalledWith(
          { tenantId: user.tenantId, principalId: user.homeAccountId }, job.id,
          "provider_timeout", expect.stringContaining("1800-second execution limit"),
        );
        expect(repository.markWaitingAuthorization).not.toHaveBeenCalled();
      } else {
        expect(repository.markFailed).not.toHaveBeenCalled();
        expect(repository.markWaitingAuthorization).toHaveBeenCalledTimes(interruption === "cancel" ? 0 : 1);
        expect(repository.cancel).toHaveBeenCalledTimes(interruption === "cancel" ? 2 : 0);
      }
    },
  );

  it.each(["cancel", "logout"] as const)("drains pending admission already stopped by %s", async action => {
    const { service, repository, dependencies, job } = fixture();
    const pending = deferred<boolean>();
    repository.markRunning.mockReturnValueOnce(pending.promise);
    const starting = service.start(user, job.id);
    const stopped = expect(starting).rejects.toMatchObject({
      code: action === "cancel" ? "read_job_cancelled" : "interaction_required",
    });
    await vi.waitFor(() => expect(repository.markRunning).toHaveBeenCalledOnce());
    if (action === "cancel") await service.cancel(user, job.id);
    else await service.waitForPrincipalAuthorization({ tenantId: user.tenantId!, principalId: user.homeAccountId });
    const draining = service.drain();
    pending.resolve(true);
    await stopped;
    await draining;
    expect(dependencies.query).not.toHaveBeenCalled();
    expect(repository.markWaitingAuthorization).toHaveBeenCalledTimes(action === "logout" ? 1 : 0);
    expect(repository.cancel).toHaveBeenCalledTimes(action === "cancel" ? 2 : 0);
  });

  it("does not deadlock logout with pending startup authorization", async () => {
    const { service, repository, dependencies, job } = fixture();
    const scopedUser = { ...user, homeAccountId: "inventory-start-lock" };
    const pending = deferred<AuthenticatedUser>();
    dependencies.revalidateUser.mockReturnValueOnce(pending.promise);
    const starting = service.start(scopedUser, job.id);
    const stopped = expect(starting).rejects.toMatchObject({ status: 401 });
    await vi.waitFor(() => expect(dependencies.revalidateUser).toHaveBeenCalledOnce());
    await revokeAccountSessionMutations(user.tenantId!, scopedUser.homeAccountId, async () => {
      pending.resolve(scopedUser);
      await Promise.resolve();
      await service.waitForPrincipalAuthorization({ tenantId: user.tenantId!, principalId: scopedUser.homeAccountId });
    });
    await stopped;
    await service.drain();
    expect(repository.markRunning).not.toHaveBeenCalled();
    expect(dependencies.query).not.toHaveBeenCalled();
  });

  it("observes sanitized background persistence failure without a drain", async () => {
    const { service, repository, dependencies, job } = fixture();
    const failure = new Error("private database failure detail");
    dependencies.query.mockRejectedValue(new AppError(502, "provider_error", "Provider failed."));
    repository.markFailed.mockRejectedValueOnce(failure);
    await withTelemetryContext({ requestId: "request-status-failed" }, () => service.start(user, job.id));
    await vi.waitFor(() => expect(vi.mocked(console.error).mock.calls.map(([entry]) => JSON.parse(entry)))
      .toContainEqual(expect.objectContaining({
        event: "inventory_refresh_status_failed", requestId: "request-status-failed", jobId: job.id, errorCode: "internal_error",
      })));
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(failure.message);
    expect(repository.complete).not.toHaveBeenCalled();
  });

  it("reports background persistence failures to an in-flight drain", async () => {
    const { service, repository, dependencies, job } = fixture();
    const pending = deferred<void>();
    const failure = new Error("private database failure detail");
    dependencies.query.mockRejectedValue(new AppError(502, "provider_error", "Provider failed."));
    repository.markFailed.mockReturnValueOnce(pending.promise);
    await service.start(user, job.id);
    await vi.waitFor(() => expect(repository.markFailed).toHaveBeenCalledOnce());
    const drained = expect(service.drain()).rejects.toBe(failure);
    pending.reject(failure);
    await drained;
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('"event":"inventory_refresh_status_failed"'));
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(failure.message);
  });

  it("still reports persistence failure when shutdown wins over a late authorization rejection", async () => {
    const { service, repository, dependencies, job } = fixture();
    const pending = deferred<AuthenticatedUser>();
    const failure = new Error("private authorization-wait persistence failure");
    dependencies.revalidateUser.mockResolvedValueOnce(user).mockResolvedValueOnce(user).mockReturnValueOnce(pending.promise);
    repository.markWaitingAuthorization.mockRejectedValueOnce(failure);
    await service.start(user, job.id);
    await vi.waitFor(() => expect(dependencies.revalidateUser).toHaveBeenCalledTimes(3));
    const drained = expect(service.drain()).rejects.toBe(failure);
    pending.reject(new Error("Late authorization transport failure."));
    await drained;
    expect(repository.markFailed).not.toHaveBeenCalled();
    expect(repository.complete).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('"event":"inventory_refresh_status_failed"'));
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(failure.message);
  });

  it("does not deadlock logout with pending publication authorization or publish a cancelled scan", async () => {
    const pending = deferred<AuthenticatedUser>();
    const finalValidation = deferred<void>();
    const refresh = fixture();
    const scopedUser = { ...user, homeAccountId: "logout-publication-principal" };
    refresh.dependencies.revalidateUser.mockResolvedValueOnce(scopedUser).mockResolvedValueOnce(scopedUser).mockImplementationOnce(async () => {
      finalValidation.resolve();
      return pending.promise;
    });
    await refresh.service.start(scopedUser, refresh.job.id);
    await finalValidation.promise;
    await revokeAccountSessionMutations("tenant-a", scopedUser.homeAccountId, async () => {
      await refresh.service.waitForPrincipalAuthorization({ tenantId: "tenant-a", principalId: scopedUser.homeAccountId });
      pending.resolve(scopedUser);
    });
    await vi.waitFor(() => expect(refresh.repository.markWaitingAuthorization).toHaveBeenCalledTimes(1));
    expect(refresh.repository.complete).not.toHaveBeenCalled();
  });
});