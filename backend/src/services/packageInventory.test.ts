import { describe, expect, it, vi } from "vitest";
import { AppError } from "../errors.js";
import type { AuthenticatedUser } from "../types/session.js";
import { PackageInventoryService } from "./packageInventory.js";

const user: AuthenticatedUser = {
  tenantId: "tenant-package",
  homeAccountId: "principal-package",
  displayName: "Package Reader",
  username: "reader@example.invalid",
  roles: ["AgentControl.Viewer"],
};

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
    getJob: vi.fn(async () => job),
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
    delegatedToken: vi.fn(async () => "delegated-token"),
    applicationToken: vi.fn(async () => "application-token"),
    revalidateUser: vi.fn(async () => user),
    requireAvailable: vi.fn(async () => undefined),
    requireApplicationDataScope: vi.fn(async () => undefined),
    scan: vi.fn(async () => ({ packages: [], totalRecords: 0, pages: 1 })),
    applicationPrincipalId: vi.fn(() => "application-id"),
  };
  return { job, repository, dependencies, service: new PackageInventoryService(repository as never, dependencies as never) };
}

describe("Package refresh service", () => {
  it("publishes only after current delegated authorization and a complete explicit scan", async () => {
    const { service, repository, dependencies, job } = fixture();
    await service.start(user, job.id, "delegated");
    await vi.waitFor(() => expect(repository.publish).toHaveBeenCalledTimes(1));
    expect(dependencies.requireAvailable).toHaveBeenCalledWith("graph.package.read.delegated", user);
    expect(repository.markRunning).toHaveBeenCalledBefore(dependencies.scan);
  });

  it("keeps application reads independent and requires approved shared scope", async () => {
    const applicationJob = { ...fixture().job, tokenMode: "application" as const };
    const { service, repository, dependencies } = fixture({ getJob: vi.fn(async () => applicationJob) });
    await service.submit(user, { tokenMode: "application", idempotencyKey: "application-read" });
    expect(repository.submit).toHaveBeenCalledWith({ tenantId: user.tenantId, principalId: "application-id" }, expect.objectContaining({ authorizationPrincipalId: user.homeAccountId, tokenMode: "application" }));
    await service.start(user, applicationJob.id, "application");
    await vi.waitFor(() => expect(repository.publish).toHaveBeenCalledTimes(1));
    expect(dependencies.applicationToken).toHaveBeenCalledWith("graph.package.read.application");
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
    expect(direct.repository.cancel).toHaveBeenCalledWith({ tenantId: user.tenantId, principalId: user.homeAccountId }, direct.job.id, user.homeAccountId);
    await expect(direct.service.cancel({ ...user, roles: [] }, direct.job.id, "delegated")).rejects.toMatchObject({ code: "missing_internal_role" });
  });

  it("leaves authorization failure waiting without starting the scan", async () => {
    const { service, repository, dependencies, job } = fixture();
    dependencies.delegatedToken.mockRejectedValue(new AppError(401, "interaction_required", "reauthenticate"));
    await expect(service.start(user, job.id, "delegated")).rejects.toMatchObject({ code: "interaction_required" });
    expect(repository.markRunning).not.toHaveBeenCalled();
    expect(dependencies.scan).not.toHaveBeenCalled();
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
});