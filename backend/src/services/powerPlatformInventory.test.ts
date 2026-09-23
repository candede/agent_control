import { getEventListeners } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "../errors.js";
import { revokeAccountSessionMutations } from "../db/sessions.js";
import type { AuthenticatedUser } from "../types/session.js";
import type { ResourceQueryResult } from "../types/powerPlatformInventory.js";
import { inventoryProviderRoleIds } from "./inventoryRoleScope.js";
import { PowerPlatformInventoryService } from "./powerPlatformInventory.js";
import { withTelemetryContext } from "./telemetry.js";

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
    submit: vi.fn(async () => job), getJob: vi.fn(async () => job), markRunning: vi.fn(async () => true), recordProgress: vi.fn(async () => undefined),
    publish: vi.fn(async () => undefined), markWaitingAuthorization: vi.fn(async () => undefined), markFailed: vi.fn(async () => undefined),
    cancel: vi.fn(async () => ({ ...job, status: "cancelled" })), recoverInterrupted: vi.fn(async () => 0),
    ...overrides,
  };
  const dependencies = {
    revalidateUser: vi.fn(async () => user), requireAvailable: vi.fn(async () => undefined), delegatedToken: vi.fn(async () => "opaque-token"),
    query: vi.fn(async () => emptyQueryResult()),
  };
  return { job, repository, dependencies, service: new PowerPlatformInventoryService(repository as never, dependencies as never) };
}

function emptyQueryResult(): ResourceQueryResult {
  return { resources: [], queriedTypes: ["microsoft.copilotstudio/agents"], environmentScope: null, totalRecords: 0, pages: 1, unknownFieldCount: 0 };
}

describe("Power Platform inventory refresh service", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it("starts only after current authorization and publishes complete results", async () => {
    const { service, repository, dependencies } = fixture();
    await expect(service.start(user, "11111111-1111-1111-1111-111111111111")).resolves.toMatchObject({ status: "waiting_authorization" });
    await vi.waitFor(() => expect(repository.publish).toHaveBeenCalledTimes(1));
    expect(dependencies.query).toHaveBeenCalledWith("opaque-token", ["microsoft.copilotstudio/agents"], expect.objectContaining({ expectedTenantId: "tenant-a" }));
    expect(dependencies.requireAvailable).toHaveBeenCalledBefore(dependencies.delegatedToken);
    expect(repository.markRunning).toHaveBeenCalledBefore(dependencies.query);
  });

  it("forwards explicit readiness retry and internal cleanup without querying after failure", async () => {
    const { service, repository, dependencies, job } = fixture();
    dependencies.requireAvailable.mockRejectedValueOnce(new AppError(504, "provider_timeout", "Readiness timed out."));
    await expect(service.start(user, job.id, { retryFailed: true })).rejects.toMatchObject({ code: "provider_timeout" });
    expect(dependencies.requireAvailable).toHaveBeenCalledWith("powerPlatform.inventory.read", user, { retryFailed: true });
    expect(repository.markRunning).not.toHaveBeenCalled();
    expect(dependencies.query).not.toHaveBeenCalled();
    await service.cancel(user, job.id, "sync_cleanup");
    expect(repository.cancel).toHaveBeenCalledWith(
      { tenantId: user.tenantId, principalId: user.homeAccountId }, job.id, "sync_cleanup",
    );
  });

  it("does not fail an agent-only query when optional role claims disappear or change to another supported inventory role", async () => {
    for (const providerRoleIds of [[], [inventoryProviderRoleIds.aiReader]]) {
      const { service, job, repository, dependencies } = fixture();
      dependencies.revalidateUser.mockResolvedValue({ ...user, providerRoleIds });
      await service.start(user, job.id);
      await vi.waitFor(() => expect(repository.publish).toHaveBeenCalledOnce());
      expect(repository.markWaitingAuthorization).not.toHaveBeenCalled();
      expect(repository.markFailed).not.toHaveBeenCalled();
      expect(dependencies.requireAvailable).toHaveBeenCalledTimes(2);
    }
  });

  it("rejects a real type-scope change before querying and fails a changed publication scope instead of requesting irrelevant reauthorization", async () => {
    const changedUser = { ...user, providerRoleIds: [inventoryProviderRoleIds.aiReader] };
    const beforeStart = fixture();
    beforeStart.job.requestedTypes = ["microsoft.copilotstudio/agents", "microsoft.powerapps/canvasapps"];
    beforeStart.dependencies.revalidateUser.mockResolvedValue(changedUser);
    await expect(beforeStart.service.start(user, beforeStart.job.id)).rejects.toMatchObject({ code: "inventory_scope_changed" });
    expect(beforeStart.dependencies.query).not.toHaveBeenCalled();
    const duringQuery = fixture();
    duringQuery.job.requestedTypes = [...beforeStart.job.requestedTypes];
    duringQuery.dependencies.revalidateUser.mockResolvedValueOnce(user).mockResolvedValueOnce(changedUser);
    await duringQuery.service.start(user, duringQuery.job.id);
    await vi.waitFor(() => expect(duringQuery.repository.markFailed).toHaveBeenCalledWith(
      { tenantId: user.tenantId, principalId: user.homeAccountId }, duringQuery.job.id,
      "inventory_scope_changed", expect.stringContaining("Submit a new refresh"),
    ));
    expect(duringQuery.repository.publish).not.toHaveBeenCalled();
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

  it("reports a publication scope mismatch as a data failure, not a consent request", async () => {
    const { service, job, repository } = fixture();
    repository.publish.mockRejectedValue(new AppError(409, "scope_mismatch", "The completed inventory query did not match the authorized resource types and environment."));
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

  it("allows a minute-long enumeration before publication with a bounded 150-second execution budget", async () => {
    vi.useFakeTimers();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation(milliseconds => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException("Synthetic deadline", "TimeoutError")), milliseconds);
      return controller.signal;
    });
    const { service, job, dependencies, repository } = fixture();
    dependencies.query.mockImplementation((_token, _types, options) => new Promise((resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
      setTimeout(() => resolve(emptyQueryResult()), 61_500);
    }));
    await service.start(user, job.id);
    await vi.advanceTimersByTimeAsync(61_500);
    expect(timeout).toHaveBeenCalledWith(150_000);
    expect(repository.publish).toHaveBeenCalledOnce();
    expect(repository.markFailed).not.toHaveBeenCalled();
    expect(repository.markWaitingAuthorization).not.toHaveBeenCalled();
  });

  it.each([
    new AppError(504, "provider_timeout", "Power Platform inventory exceeded the 120-second enumeration limit."),
    new DOMException("private execution timeout", "TimeoutError"),
  ])("persists a clear timeout failure instead of generic failure or waiting authorization", async error => {
    const { service, job, dependencies, repository } = fixture();
    dependencies.query.mockRejectedValue(error);
    await service.start(user, job.id);
    await vi.waitFor(() => expect(repository.markFailed).toHaveBeenCalledOnce());
    expect(repository.markFailed).toHaveBeenCalledWith(
      { tenantId: user.tenantId, principalId: user.homeAccountId }, job.id, "provider_timeout",
      expect.stringMatching(/(?:120-second enumeration|150-second execution) limit/),
    );
    expect(repository.publish).not.toHaveBeenCalled();
    expect(repository.markWaitingAuthorization).not.toHaveBeenCalled();
  });

  it("turns interrupted work into explicit reauthorization and drains all active refreshes", async () => {
    const first = fixture();
    first.dependencies.query.mockImplementation((_token, _types, options) => new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true })));
    await first.service.start(user, first.job.id);
    await first.service.drain();
    expect(first.repository.markWaitingAuthorization).toHaveBeenCalledTimes(1);
    expect(first.repository.publish).not.toHaveBeenCalled();
  });

  it("lets Admin inherit Viewer authority and fences publication after all roles are lost", async () => {
    const admin = { ...user, roles: ["AgentControl.Admin" as const] };
    const direct = fixture();
    await expect(direct.service.submit(admin, { idempotencyKey: "admin-read", requestedTypes: ["microsoft.copilotstudio/agents"] })).resolves.toBeDefined();
    expect(direct.repository.submit).toHaveBeenCalledOnce();

    const fenced = fixture();
    fenced.dependencies.revalidateUser
      .mockResolvedValueOnce(user)
      .mockResolvedValueOnce({ ...user, roles: [] });
    await fenced.service.start(user, fenced.job.id);
    await vi.waitFor(() => expect(fenced.repository.markWaitingAuthorization).toHaveBeenCalledTimes(1));
    expect(fenced.repository.publish).not.toHaveBeenCalled();
  });

  it("lets only the owning Viewer cancel its inventory refresh", async () => {
    const direct = fixture();
    await expect(direct.service.cancel(user, direct.job.id)).resolves.toMatchObject({ status: "cancelled" });
    expect(direct.repository.cancel).toHaveBeenCalledWith({ tenantId: user.tenantId, principalId: user.homeAccountId }, direct.job.id, "requested");
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
      expect(repository.publish).not.toHaveBeenCalled();
      expect(repository.markWaitingAuthorization).toHaveBeenCalledTimes(stage === "markRunning" ? 1 : 0);
    },
  );

  it("drains pending admission before shutdown completes and rejects further starts", async () => {
    const { service, repository, dependencies, job } = fixture();
    const pending = deferred<AuthenticatedUser>();
    dependencies.revalidateUser.mockReturnValueOnce(pending.promise);
    const starting = service.start(user, job.id);
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
    await vi.waitFor(() => expect(dependencies.revalidateUser).toHaveBeenCalledOnce());
    if (phase === "running") await starting;
    try {
      const reads = repository.getJob.mock.calls.length;
      for (const other of [{ ...user, homeAccountId: "other-principal" }, { ...user, tenantId: "other-tenant" }]) {
        await expect(service.start(other, job.id.toUpperCase())).rejects.toMatchObject({ status: 404, code: "not_found" });
      }
      expect(repository.getJob).toHaveBeenCalledTimes(reads);
      expect(dependencies.revalidateUser).toHaveBeenCalledOnce();
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
      const { service, dependencies, repository, job } = fixture();
      const pending = deferred<AuthenticatedUser>();
      const deadline = new AbortController();
      vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
      dependencies.revalidateUser.mockResolvedValueOnce(user).mockReturnValueOnce(pending.promise);
      await service.start(user, job.id);
      await vi.waitFor(() => expect(dependencies.revalidateUser).toHaveBeenCalledTimes(2));
      let draining: Promise<void> | undefined;
      if (interruption === "cancel") await service.cancel(user, job.id);
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
          "provider_timeout", expect.stringContaining("150-second execution limit"),
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
    expect(repository.publish).not.toHaveBeenCalled();
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
    dependencies.revalidateUser.mockResolvedValueOnce(user).mockReturnValueOnce(pending.promise);
    repository.markWaitingAuthorization.mockRejectedValueOnce(failure);
    await service.start(user, job.id);
    await vi.waitFor(() => expect(dependencies.revalidateUser).toHaveBeenCalledTimes(2));
    const drained = expect(service.drain()).rejects.toBe(failure);
    pending.reject(new Error("Late authorization transport failure."));
    await drained;
    expect(repository.markFailed).not.toHaveBeenCalled();
    expect(repository.publish).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('"event":"inventory_refresh_status_failed"'));
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(failure.message);
  });

  it("does not deadlock logout with pending publication authorization or publish a cancelled scan", async () => {
    const pending = deferred<AuthenticatedUser>();
    const finalValidation = deferred<void>();
    const refresh = fixture();
    const scopedUser = { ...user, homeAccountId: "logout-publication-principal" };
    refresh.dependencies.revalidateUser.mockResolvedValueOnce(scopedUser).mockImplementationOnce(async () => {
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
    expect(refresh.repository.publish).not.toHaveBeenCalled();
  });
});