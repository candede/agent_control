import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "../errors.js";
import { revokeAccountSessionMutations } from "../db/sessions.js";
import type { AuthenticatedUser } from "../types/session.js";
import type { ResourceQueryResult } from "../types/powerPlatformInventory.js";
import { inventoryProviderRoleIds } from "./inventoryRoleScope.js";
import { PowerPlatformInventoryService } from "./powerPlatformInventory.js";
import { withTelemetryContext } from "./telemetry.js";

const user: AuthenticatedUser = {
  tenantId: "tenant-a", homeAccountId: "principal-a", displayName: "Reader", username: "reader@example.invalid",
  roles: ["AgentControl.Viewer"], providerRoleIds: [inventoryProviderRoleIds.globalReader],
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
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
    const held = deferred<never>();
    const first = fixture();
    first.dependencies.query.mockImplementation((_token, _types, options) => new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true })));
    await first.service.start(user, first.job.id);
    await first.service.drain();
    expect(first.repository.markWaitingAuthorization).toHaveBeenCalledTimes(1);
    expect(first.repository.publish).not.toHaveBeenCalled();
    held.resolve(undefined as never);
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
    expect(direct.repository.cancel).toHaveBeenCalledWith({ tenantId: user.tenantId, principalId: user.homeAccountId }, direct.job.id);
    await expect(direct.service.cancel({ ...user, roles: [] }, direct.job.id)).rejects.toMatchObject({ code: "missing_internal_role" });
  });

  it("bounds global refresh execution and recovers capacity after principal cancellation", async () => {
    const held = deferred<void>();
    const bounded = fixture({ getJob: vi.fn(async (_scope, id) => ({ ...fixture().job, id })) });
    bounded.dependencies.query.mockImplementation((_token, _types, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
      void held.promise;
    }));
    const ids = [1, 2, 3, 4, 5].map(value => `11111111-1111-1111-1111-11111111111${value}`);
    for (const id of ids.slice(0, 4)) await bounded.service.start(user, id);
    await expect(bounded.service.start(user, ids[4])).rejects.toMatchObject({ code: "inventory_capacity" });
    await bounded.service.waitForPrincipalAuthorization({ tenantId: "tenant-a", principalId: "principal-a" });
    await bounded.service.drain();
    expect(bounded.repository.markWaitingAuthorization).toHaveBeenCalledTimes(4);
    await expect(bounded.service.start(user, ids[4])).resolves.toBeDefined();
    await bounded.service.drain();
    held.resolve();
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