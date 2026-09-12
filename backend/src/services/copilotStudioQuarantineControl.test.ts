import { describe, expect, it, vi } from "vitest";
import { AppError } from "../errors.js";
import type { AuthenticatedUser } from "../types/session.js";
import { CopilotStudioQuarantineControlService } from "./copilotStudioQuarantineControl.js";

const user: AuthenticatedUser = { tenantId: "tenant-a", homeAccountId: "operator-a", displayName: "Operator", username: "operator@example.invalid", roles: ["AgentControl.Admin"] };
const viewer: AuthenticatedUser = { ...user, displayName: "Viewer", roles: ["AgentControl.Viewer"] };
const target = { resourceNativeId: "native-agent", displayName: "Agent", snapshotId: "11111111-1111-4111-8111-111111111111", inventoryObservedAt: "2026-09-09T19:00:00Z",
  inventoryExpiresAt: "2026-09-10T19:00:00Z", environmentId: "22222222-2222-4222-8222-222222222222", botId: "33333333-3333-4333-8333-333333333333",
  inventoryQuarantineState: false, inventoryQuarantinedAt: null };
const direct = { environmentId: target.environmentId, botId: target.botId, isBotQuarantined: true, lastUpdateTimeUtc: "2026-09-09T19:01:00.1234567Z",
  observedAt: "2026-09-09T19:01:01Z", correlationId: "44444444-4444-4444-8444-444444444444" };
const authority = { contractRevision: "a".repeat(64), permissionRevision: "b".repeat(64), configurationRevision: 1 };

function service(cached = false, currentUser = user) {
  const repository = {
    existingSubmission: vi.fn(async () => undefined), latestObservation: vi.fn(async () => cached ? direct : undefined), recordObservation: vi.fn(async () => direct),
    isQualified: vi.fn(async () => false), submit: vi.fn(),
  };
  const inventory = { resolveQuarantineTargets: vi.fn(async () => [target]) };
  const provider = { getStatus: vi.fn(async () => direct) };
  const dependencies = {
    revalidateUser: vi.fn(async () => currentUser), delegatedToken: vi.fn(async () => "ephemeral-token"), requireAvailable: vi.fn(async () => undefined),
    authorityContext: vi.fn(async () => authority), launch: vi.fn(),
  };
  return { repository, inventory, provider, dependencies, value: new CopilotStudioQuarantineControlService(repository as never, inventory as never, provider as never, dependencies as never) };
}

describe("Copilot Studio quarantine control", () => {
  it("returns only a current direct cache entry and preserves inventory disagreement", async () => {
    const { value, provider, dependencies } = service(true);
    await expect(value.status(user, target.snapshotId, target.resourceNativeId)).resolves.toMatchObject({ direct: { isBotQuarantined: true, source: "cache" }, inventory: { isQuarantined: false }, disagreesWithInventory: true });
    expect(provider.getStatus).not.toHaveBeenCalled();
    expect(dependencies.delegatedToken).not.toHaveBeenCalled();
  });

  it("uses one bounded provider status call and fences durable observation publication", async () => {
    const { value, repository, provider, dependencies } = service(false, viewer);
    await expect(value.status(viewer, target.snapshotId, target.resourceNativeId, true)).resolves.toMatchObject({ direct: { source: "provider", providerUpdatedAt: direct.lastUpdateTimeUtc } });
    expect(provider.getStatus).toHaveBeenCalledTimes(1);
    expect(dependencies.requireAvailable).toHaveBeenCalledWith("powerPlatform.quarantine.read", viewer);
    expect(dependencies.delegatedToken).toHaveBeenCalledWith(viewer.homeAccountId, "powerPlatform.quarantine.read");
    expect(dependencies.revalidateUser).toHaveBeenCalledTimes(2);
    expect(repository.recordObservation).toHaveBeenCalledWith({ tenantId: "tenant-a", principalId: "operator-a" }, target, direct);
  });

  it("propagates Microsoft denial without publishing a status observation", async () => {
    const providerAuthorizedUser = { ...viewer, providerRoleIds: [] };
    const { value, repository, provider } = service(false, providerAuthorizedUser);
    provider.getStatus.mockRejectedValueOnce(new Error("Microsoft denied the exact status request."));
    await expect(value.status(providerAuthorizedUser, target.snapshotId, target.resourceNativeId, true))
      .rejects.toThrow("Microsoft denied the exact status request.");
    expect(repository.recordObservation).not.toHaveBeenCalled();
  });

  it("builds an exact frozen preview without consulting optional canary qualification", async () => {
    const { value, repository } = service(true);
    repository.isQualified.mockRejectedValue(new Error("Optional qualification evidence is unavailable."));
    const preview = await value.preview(user, { action: "unquarantine", snapshotId: target.snapshotId, resourceNativeIds: [target.resourceNativeId] });
    expect(preview).toMatchObject({
      confirmationHash: expect.stringMatching(/^[a-f0-9]{64}$/), summary: { targetCount: 1, operation: "unquarantine", packageControlIndependent: true },
      statuses: [{ direct: { isBotQuarantined: true }, inventory: { isQuarantined: false } }],
    });
    expect(preview).not.toHaveProperty("qualification");
    expect(repository.isQualified).not.toHaveBeenCalled();
  });

  it("keeps preview and submit Admin-only", async () => {
    const { value, inventory, repository, dependencies } = service(true, viewer);
    await expect(value.preview(viewer, { action: "quarantine", snapshotId: target.snapshotId, resourceNativeIds: [target.resourceNativeId] }))
      .rejects.toMatchObject({ code: "missing_internal_role" });
    await expect(value.submit(viewer, { action: "quarantine", snapshotId: target.snapshotId, resourceNativeIds: [target.resourceNativeId],
      confirmationHash: "e".repeat(64), idempotencyKey: "viewer-submit" })).rejects.toMatchObject({ code: "missing_internal_role" });
    expect(inventory.resolveQuarantineTargets).not.toHaveBeenCalled();
    expect(repository.submit).not.toHaveBeenCalled();
    expect(dependencies.launch).not.toHaveBeenCalled();
  });

  it("keeps exact inventory resolution and delegated authorization before a normal submission", async () => {
    const { value, inventory, repository, dependencies, provider } = service();
    const input = { action: "unquarantine" as const, snapshotId: target.snapshotId, resourceNativeIds: [target.resourceNativeId],
      confirmationHash: "e".repeat(64), idempotencyKey: "normal-submit" };
    inventory.resolveQuarantineTargets.mockRejectedValueOnce(new AppError(409, "quarantine_target_unavailable", "Exact target is unavailable."));
    await expect(value.submit(user, input)).rejects.toMatchObject({ code: "quarantine_target_unavailable" });
    expect(provider.getStatus).not.toHaveBeenCalled();
    expect(repository.submit).not.toHaveBeenCalled();

    dependencies.delegatedToken.mockRejectedValueOnce(AppError.unauthorized("Delegated token is unavailable."));
    await expect(value.submit(user, input)).rejects.toMatchObject({ status: 401 });
    expect(provider.getStatus).not.toHaveBeenCalled();
    expect(repository.submit).not.toHaveBeenCalled();
    expect(dependencies.launch).not.toHaveBeenCalled();

    repository.submit.mockResolvedValue({ id: "55555555-5555-4555-8555-555555555555", isCanary: false });
    await expect(value.submit(user, input)).resolves.toMatchObject({ isCanary: false });
    expect(inventory.resolveQuarantineTargets).toHaveBeenLastCalledWith({ tenantId: user.tenantId, principalId: user.homeAccountId }, target.snapshotId, [target.resourceNativeId]);
    expect(dependencies.requireAvailable).toHaveBeenCalledWith("powerPlatform.quarantine.manage", user);
    expect(dependencies.delegatedToken).toHaveBeenCalledWith(user.homeAccountId, "powerPlatform.quarantine.manage");
    expect(provider.getStatus).toHaveBeenCalledWith("ephemeral-token", target, { correlationId: expect.any(String) });
    expect(repository.submit).toHaveBeenCalledWith({ tenantId: user.tenantId, principalId: user.homeAccountId }, {
      action: input.action, targets: [{ ...target, directStatus: direct }],
      actor: { tenantId: user.tenantId, homeAccountId: user.homeAccountId, displayName: user.displayName, username: user.username },
      authority, requestPath: "/api/quarantine/jobs",
      idempotencyKey: input.idempotencyKey, confirmationHash: input.confirmationHash,
    });
    expect(dependencies.launch).toHaveBeenCalledWith("55555555-5555-4555-8555-555555555555", { tenantId: user.tenantId, principalId: user.homeAccountId });
    expect(repository.isQualified).not.toHaveBeenCalled();
  });

  it("returns an immutable idempotent receipt before inventory or provider access", async () => {
    const { value, repository, inventory, provider, dependencies } = service(false);
    const receipt = { id: "55555555-5555-4555-8555-555555555555", status: "succeeded" };
    repository.existingSubmission.mockResolvedValue(receipt);
    await expect(value.submit(user, { action: "quarantine", snapshotId: target.snapshotId, resourceNativeIds: [target.resourceNativeId],
      confirmationHash: "e".repeat(64), idempotencyKey: "durable-retry" })).resolves.toBe(receipt);
    expect(inventory.resolveQuarantineTargets).not.toHaveBeenCalled();
    expect(provider.getStatus).not.toHaveBeenCalled();
    expect(dependencies.authorityContext).not.toHaveBeenCalled();
    expect(dependencies.launch).not.toHaveBeenCalled();
  });
});