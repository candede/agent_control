import { describe, expect, it, vi } from "vitest";
import { AppError } from "../errors.js";
import { revokeAccountSessionMutations } from "../db/sessions.js";
import type { AuthenticatedUser } from "../types/session.js";
import { inventoryProviderRoleIds } from "./inventoryRoleScope.js";
import { PowerPlatformInventoryService } from "./powerPlatformInventory.js";

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
    query: vi.fn(async () => ({ resources: [], totalRecords: 0, pages: 1, unknownFieldCount: 0 })),
  };
  return { job, repository, dependencies, service: new PowerPlatformInventoryService(repository as never, dependencies as never) };
}

describe("Power Platform inventory refresh service", () => {
  it("starts only after current authorization and publishes complete results", async () => {
    const { service, repository, dependencies } = fixture();
    await expect(service.start(user, "11111111-1111-1111-1111-111111111111")).resolves.toMatchObject({ status: "waiting_authorization" });
    await vi.waitFor(() => expect(repository.publish).toHaveBeenCalledTimes(1));
    expect(dependencies.query).toHaveBeenCalledWith("opaque-token", ["microsoft.copilotstudio/agents"], expect.objectContaining({ expectedTenantId: "tenant-a" }));
    expect(dependencies.requireAvailable).toHaveBeenCalledBefore(dependencies.delegatedToken);
    expect(repository.markRunning).toHaveBeenCalledBefore(dependencies.query);
  });

  it("leaves authorization failures waiting without issuing a provider query", async () => {
    const { service, repository, dependencies } = fixture();
    dependencies.delegatedToken.mockRejectedValue(new AppError(401, "interaction_required", "authorization required"));
    await expect(service.start(user, "11111111-1111-1111-1111-111111111111")).rejects.toMatchObject({ code: "interaction_required" });
    expect(repository.markRunning).not.toHaveBeenCalled();
    expect(dependencies.query).not.toHaveBeenCalled();
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