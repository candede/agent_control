import { describe, expect, it, vi } from "vitest";
import { createQuarantineConfirmation } from "../db/copilotStudioQuarantine.js";
import { activateAccountSession, revokeAccountSessionMutations } from "../db/sessions.js";
import { AppError } from "../errors.js";
import type { QuarantineJob } from "../types/copilotStudioQuarantine.js";
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
    existingSubmission: vi.fn<() => Promise<Pick<QuarantineJob, "id" | "status"> | undefined>>(async () => undefined), latestObservation: vi.fn(async () => cached ? direct : undefined), recordObservation: vi.fn(async () => direct),
    isQualified: vi.fn(async () => false), submit: vi.fn(),
  };
  const inventory = { resolveQuarantineTargets: vi.fn(async () => [target]) };
  const provider = { getStatus: vi.fn(async () => direct) };
  const dependencies = {
    observeOperation: vi.fn(async (_id, _user, operation: (reportFailure: (error: unknown) => void) => Promise<unknown>) => operation(() => undefined)),
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

    repository.submit.mockResolvedValue({ id: "55555555-5555-4555-8555-555555555555", status: "queued", isCanary: false });
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
    const receipt: Pick<QuarantineJob, "id" | "status"> = { id: "55555555-5555-4555-8555-555555555555", status: "succeeded" };
    repository.existingSubmission.mockResolvedValue(receipt);
    await expect(value.submit(user, { action: "quarantine", snapshotId: target.snapshotId, resourceNativeIds: [target.resourceNativeId],
      confirmationHash: "e".repeat(64), idempotencyKey: "durable-retry" })).resolves.toBe(receipt);
    expect(inventory.resolveQuarantineTargets).not.toHaveBeenCalled();
    expect(provider.getStatus).not.toHaveBeenCalled();
    expect(dependencies.authorityContext).not.toHaveBeenCalled();
    expect(dependencies.launch).not.toHaveBeenCalled();
  });

  it("revalidates cached-status submissions before creating a durable job", async () => {
    const { value, repository, provider, dependencies } = service(true);
    dependencies.requireAvailable.mockRejectedValueOnce(new AppError(403, "capability_unavailable", "Admin authority was revoked."));
    await expect(value.submit(user, { action: "quarantine", snapshotId: target.snapshotId, resourceNativeIds: [target.resourceNativeId],
      confirmationHash: "e".repeat(64), idempotencyKey: "cached-revoked" })).rejects.toMatchObject({ code: "capability_unavailable" });
    expect(dependencies.revalidateUser).toHaveBeenCalledWith(user.homeAccountId);
    expect(dependencies.requireAvailable).toHaveBeenCalledWith("powerPlatform.quarantine.manage", user);
    expect(provider.getStatus).not.toHaveBeenCalled();
    expect(repository.submit).not.toHaveBeenCalled();
    expect(dependencies.launch).not.toHaveBeenCalled();
  });

  it.each([
    { ...user, tenantId: "another-tenant" },
    { ...user, homeAccountId: "another-principal" },
  ])("rejects a changed cached-status submission actor: %j", async currentUser => {
    const { value, repository, dependencies } = service(true, currentUser);
    await expect(value.submit(user, { action: "quarantine", snapshotId: target.snapshotId, resourceNativeIds: [target.resourceNativeId],
      confirmationHash: "e".repeat(64), idempotencyKey: "changed-actor" })).rejects.toMatchObject({ code: "unauthorized" });
    expect(repository.submit).not.toHaveBeenCalled();
    expect(dependencies.launch).not.toHaveBeenCalled();
  });

  it("keeps preview and submission bound to the same revalidated actor", async () => {
    const current = { ...user, displayName: "Current Operator", username: "current@example.invalid" };
    const { value, repository, dependencies } = service(true, current);
    repository.submit.mockResolvedValue({ id: "55555555-5555-4555-8555-555555555555", status: "queued" });
    const preview = await value.preview(user, { action: "quarantine", snapshotId: target.snapshotId, resourceNativeIds: [target.resourceNativeId] });
    expect(preview.summary.actor).toEqual({ id: current.homeAccountId, displayName: current.displayName, username: current.username });
    await value.submit(user, { action: "quarantine", snapshotId: target.snapshotId, resourceNativeIds: [target.resourceNativeId],
      confirmationHash: preview.confirmationHash, idempotencyKey: "current-actor" });
    expect(dependencies.authorityContext).toHaveBeenCalledWith(current);
    expect(repository.submit).toHaveBeenCalledWith({ tenantId: user.tenantId, principalId: user.homeAccountId }, expect.objectContaining({
      actor: { tenantId: current.tenantId, homeAccountId: current.homeAccountId, displayName: current.displayName, username: current.username },
    }));
    expect(createQuarantineConfirmation(repository.submit.mock.calls[0][1]).confirmationHash).toBe(preview.confirmationHash);
  });

  it.each([true, false])("fences submission after logout and re-login with cached status=%s", async cached => {
    const current = { ...user, homeAccountId: `revoked-submit-${cached}` };
    const { value, repository, dependencies } = service(cached, current);
    repository.submit.mockResolvedValue({ id: "55555555-5555-4555-8555-555555555555", status: "queued" });
    dependencies.authorityContext.mockImplementationOnce(async () => {
      await revokeAccountSessionMutations(current.tenantId!, current.homeAccountId, async () => undefined);
      await activateAccountSession(current.tenantId!, current.homeAccountId, async () => undefined);
      return authority;
    });
    await expect(value.submit(current, { action: "quarantine", snapshotId: target.snapshotId, resourceNativeIds: [target.resourceNativeId],
      confirmationHash: "e".repeat(64), idempotencyKey: "revoked-submit" })).rejects.toMatchObject({ code: "unauthorized" });
    expect(repository.submit).not.toHaveBeenCalled();
    expect(dependencies.launch).not.toHaveBeenCalled();
  });

  it("captures the submission session before the first asynchronous receipt lookup", async () => {
    const current = { ...user, homeAccountId: "revoked-receipt-lookup" };
    const { value, repository, dependencies } = service(true, current);
    repository.submit.mockResolvedValue({ id: "55555555-5555-4555-8555-555555555555", status: "queued" });
    repository.existingSubmission.mockImplementationOnce(async () => {
      await revokeAccountSessionMutations(current.tenantId!, current.homeAccountId, async () => undefined);
      await activateAccountSession(current.tenantId!, current.homeAccountId, async () => undefined);
      return undefined;
    });
    await expect(value.submit(current, { action: "quarantine", snapshotId: target.snapshotId, resourceNativeIds: [target.resourceNativeId],
      confirmationHash: "e".repeat(64), idempotencyKey: "revoked-lookup" })).rejects.toMatchObject({ code: "unauthorized" });
    expect(repository.submit).not.toHaveBeenCalled();
    expect(dependencies.launch).not.toHaveBeenCalled();
  });

  it.each(["status", "preview", "submit"] as const)(
    "keeps %s in its initiating session across inventory resolution", async operation => {
      const current = { ...user, homeAccountId: `inventory-session-${operation}` };
      const { value, inventory, repository, provider, dependencies } = service(false, current);
      inventory.resolveQuarantineTargets.mockImplementationOnce(async () => {
        await revokeAccountSessionMutations(current.tenantId!, current.homeAccountId, async () => undefined);
        await activateAccountSession(current.tenantId!, current.homeAccountId, async () => undefined);
        return [target];
      });
      const input = { action: "quarantine" as const, snapshotId: target.snapshotId, resourceNativeIds: [target.resourceNativeId],
        confirmationHash: "e".repeat(64), idempotencyKey: "inventory-session" };
      const result = operation === "status" ? value.status(current, input.snapshotId, target.resourceNativeId)
        : operation === "preview" ? value.preview(current, input) : value.submit(current, input);
      await expect(result).rejects.toMatchObject({ code: "unauthorized" });
      expect(provider.getStatus).not.toHaveBeenCalled();
      expect(repository.recordObservation).not.toHaveBeenCalled();
      expect(repository.submit).not.toHaveBeenCalled();
      expect(dependencies.launch).not.toHaveBeenCalled();
    },
  );

  it.each([true, false])("fences a status read during cache lookup, cached=%s", async cached => {
    const current = { ...user, homeAccountId: `cache-session-${cached}` };
    const { value, repository, provider } = service(cached, current);
    repository.latestObservation.mockImplementationOnce(async () => {
      await revokeAccountSessionMutations(current.tenantId!, current.homeAccountId, async () => undefined);
      await activateAccountSession(current.tenantId!, current.homeAccountId, async () => undefined);
      return cached ? direct : undefined;
    });
    await expect(value.status(current, target.snapshotId, target.resourceNativeId)).rejects.toMatchObject({ code: "unauthorized" });
    expect(provider.getStatus).not.toHaveBeenCalled();
    expect(repository.recordObservation).not.toHaveBeenCalled();
  });

  it("does not dispatch a provider read after token acquisition crosses sessions", async () => {
    const current = { ...user, homeAccountId: "token-session" };
    const { value, repository, provider, dependencies } = service(false, current);
    dependencies.delegatedToken.mockImplementationOnce(async () => {
      await revokeAccountSessionMutations(current.tenantId!, current.homeAccountId, async () => undefined);
      await activateAccountSession(current.tenantId!, current.homeAccountId, async () => undefined);
      return "ephemeral-token";
    });
    await expect(value.status(current, target.snapshotId, target.resourceNativeId)).rejects.toMatchObject({ code: "unauthorized" });
    expect(provider.getStatus).not.toHaveBeenCalled();
    expect(repository.recordObservation).not.toHaveBeenCalled();
  });

  it("stops bulk reads after the initiating session is revoked", async () => {
    const current = { ...user, homeAccountId: "bulk-status-session" };
    const { value, inventory, repository, provider } = service(false, current);
    const other = { ...target, resourceNativeId: "other-agent", botId: "66666666-6666-4666-8666-666666666666" };
    inventory.resolveQuarantineTargets.mockResolvedValue([target, other]);
    provider.getStatus.mockImplementationOnce(async () => {
      await revokeAccountSessionMutations(current.tenantId!, current.homeAccountId, async () => undefined);
      await activateAccountSession(current.tenantId!, current.homeAccountId, async () => undefined);
      return direct;
    });
    await expect(value.preview(current, { action: "quarantine", snapshotId: target.snapshotId,
      resourceNativeIds: [target.resourceNativeId, other.resourceNativeId] })).rejects.toMatchObject({ code: "unauthorized" });
    expect(provider.getStatus).toHaveBeenCalledTimes(1);
    expect(repository.recordObservation).not.toHaveBeenCalled();
  });

  it("does not return a preview if authority lookup crosses sessions", async () => {
    const current = { ...user, homeAccountId: "preview-authority-session" };
    const { value, dependencies } = service(true, current);
    dependencies.authorityContext.mockImplementationOnce(async () => {
      await revokeAccountSessionMutations(current.tenantId!, current.homeAccountId, async () => undefined);
      await activateAccountSession(current.tenantId!, current.homeAccountId, async () => undefined);
      return authority;
    });
    await expect(value.preview(current, { action: "quarantine", snapshotId: target.snapshotId,
      resourceNativeIds: [target.resourceNativeId] })).rejects.toMatchObject({ code: "unauthorized" });
  });

  it("stops publishing a bulk observation batch when the session is revoked", async () => {
    const current = { ...user, homeAccountId: "observation-session" };
    const { value, inventory, repository, provider } = service(false, current);
    const other = { ...target, resourceNativeId: "other-agent", botId: "66666666-6666-4666-8666-666666666666" };
    inventory.resolveQuarantineTargets.mockResolvedValue([target, other]);
    provider.getStatus.mockResolvedValueOnce(direct).mockResolvedValueOnce({ ...direct, botId: other.botId });
    let revocation: Promise<void> | undefined;
    repository.recordObservation.mockImplementationOnce(async () => {
      revocation = revokeAccountSessionMutations(current.tenantId!, current.homeAccountId, async () => undefined);
      return direct;
    });
    await expect(value.preview(current, { action: "quarantine", snapshotId: target.snapshotId,
      resourceNativeIds: [target.resourceNativeId, other.resourceNativeId] })).rejects.toMatchObject({ code: "unauthorized" });
    await revocation;
    expect(provider.getStatus).toHaveBeenCalledTimes(2);
    expect(repository.recordObservation).toHaveBeenCalledTimes(1);
  });

  it("does not return status if capability evidence publication crosses sessions", async () => {
    const current = { ...user, homeAccountId: "operation-evidence-session" };
    const { value, dependencies } = service(false, current);
    dependencies.observeOperation.mockImplementationOnce(async (_id, _user, operation) => {
      const result = await operation(() => undefined);
      await revokeAccountSessionMutations(current.tenantId!, current.homeAccountId, async () => undefined);
      await activateAccountSession(current.tenantId!, current.homeAccountId, async () => undefined);
      return result;
    });
    await expect(value.status(current, target.snapshotId, target.resourceNativeId)).rejects.toMatchObject({ code: "unauthorized" });
  });

  it("does not return a saved terminal receipt across sessions", async () => {
    const current = { ...user, homeAccountId: "terminal-receipt-session" };
    const { value, repository, inventory, dependencies } = service(false, current);
    repository.existingSubmission.mockImplementationOnce(async () => {
      await revokeAccountSessionMutations(current.tenantId!, current.homeAccountId, async () => undefined);
      await activateAccountSession(current.tenantId!, current.homeAccountId, async () => undefined);
      return { id: "55555555-5555-4555-8555-555555555555", status: "succeeded" };
    });
    await expect(value.submit(current, { action: "quarantine", snapshotId: target.snapshotId, resourceNativeIds: [target.resourceNativeId],
      confirmationHash: "e".repeat(64), idempotencyKey: "terminal-receipt-session" })).rejects.toMatchObject({ code: "unauthorized" });
    expect(inventory.resolveQuarantineTargets).not.toHaveBeenCalled();
    expect(dependencies.launch).not.toHaveBeenCalled();
  });

  it("does not launch a new queued job if its session is revoked during persistence", async () => {
    const current = { ...user, homeAccountId: "persist-session" };
    const { value, repository, dependencies } = service(true, current);
    let revocation: Promise<void> | undefined;
    repository.submit.mockImplementationOnce(async () => {
      revocation = revokeAccountSessionMutations(current.tenantId!, current.homeAccountId, async () => undefined);
      return { id: "55555555-5555-4555-8555-555555555555", status: "queued", isCanary: false };
    });
    await expect(value.submit(current, { action: "quarantine", snapshotId: target.snapshotId, resourceNativeIds: [target.resourceNativeId],
      confirmationHash: "e".repeat(64), idempotencyKey: "persist-session" })).rejects.toMatchObject({ code: "unauthorized" });
    await revocation;
    expect(repository.submit).toHaveBeenCalledTimes(1);
    expect(dependencies.launch).not.toHaveBeenCalled();
  });

  it("retries dispatch of an existing queued receipt after worker capacity recovers", async () => {
    const { value, repository, inventory, provider, dependencies } = service(true);
    const receipt: Pick<QuarantineJob, "id" | "status"> = { id: "55555555-5555-4555-8555-555555555555", status: "queued" };
    repository.submit.mockResolvedValue(receipt);
    dependencies.launch.mockImplementationOnce(() => { throw new AppError(429, "workers_busy", "Workers are busy."); });
    const input = { action: "quarantine" as const, snapshotId: target.snapshotId, resourceNativeIds: [target.resourceNativeId],
      confirmationHash: "e".repeat(64), idempotencyKey: "queued-retry" };
    await expect(value.submit(user, input)).rejects.toMatchObject({ code: "workers_busy" });
    repository.existingSubmission.mockResolvedValue(receipt);
    await expect(value.submit(user, input)).resolves.toBe(receipt);
    expect(dependencies.launch).toHaveBeenCalledTimes(2);
    expect(dependencies.launch).toHaveBeenLastCalledWith(receipt.id, { tenantId: user.tenantId, principalId: user.homeAccountId });
    expect(repository.submit).toHaveBeenCalledTimes(1);
    expect(inventory.resolveQuarantineTargets).toHaveBeenCalledTimes(1);
    expect(provider.getStatus).not.toHaveBeenCalled();
  });

  it.each([false, true])("keeps a queued canary receipt on its approval-controlled execution path, concurrent=%s", async concurrent => {
    const { value, repository, dependencies } = service(true);
    const receipt: Pick<QuarantineJob, "id" | "status" | "isCanary"> = {
      id: "55555555-5555-4555-8555-555555555555", status: "queued", isCanary: true,
    };
    if (concurrent) repository.submit.mockResolvedValue(receipt);
    else repository.existingSubmission.mockResolvedValue(receipt);
    await expect(value.submit(user, { action: "quarantine", snapshotId: target.snapshotId, resourceNativeIds: [target.resourceNativeId],
      confirmationHash: "e".repeat(64), idempotencyKey: "canary-receipt" })).resolves.toBe(receipt);
    expect(dependencies.launch).not.toHaveBeenCalled();
  });

  it("does not launch a queued retry after its session changes during authorization", async () => {
    const current = { ...user, homeAccountId: "revoked-queued-retry" };
    const { value, repository, dependencies } = service(true, current);
    repository.existingSubmission.mockResolvedValue({ id: "55555555-5555-4555-8555-555555555555", status: "queued" });
    dependencies.requireAvailable.mockImplementationOnce(async () => {
      await revokeAccountSessionMutations(current.tenantId!, current.homeAccountId, async () => undefined);
      await activateAccountSession(current.tenantId!, current.homeAccountId, async () => undefined);
      return undefined;
    });
    await expect(value.submit(current, { action: "quarantine", snapshotId: target.snapshotId, resourceNativeIds: [target.resourceNativeId],
      confirmationHash: "e".repeat(64), idempotencyKey: "revoked-retry" })).rejects.toMatchObject({ code: "unauthorized" });
    expect(dependencies.launch).not.toHaveBeenCalled();
    expect(repository.submit).not.toHaveBeenCalled();
  });

  it("does not relaunch a terminal receipt won by a concurrent submission", async () => {
    const { value, repository, dependencies } = service(true);
    const receipt: Pick<QuarantineJob, "id" | "status"> = { id: "55555555-5555-4555-8555-555555555555", status: "succeeded" };
    repository.submit.mockResolvedValue(receipt);
    await expect(value.submit(user, { action: "quarantine", snapshotId: target.snapshotId, resourceNativeIds: [target.resourceNativeId],
      confirmationHash: "e".repeat(64), idempotencyKey: "concurrent-receipt" })).resolves.toBe(receipt);
    expect(dependencies.launch).not.toHaveBeenCalled();
  });

  it.each(["running", "waiting_authorization", "succeeded", "failed", "cancelled", "partial", "inconclusive"] as const)(
    "does not relaunch an existing %s receipt", async status => {
      const { value, repository, dependencies } = service();
      const receipt: Pick<QuarantineJob, "id" | "status"> = { id: "55555555-5555-4555-8555-555555555555", status };
      repository.existingSubmission.mockResolvedValue(receipt);
      await expect(value.submit(user, { action: "quarantine", snapshotId: target.snapshotId, resourceNativeIds: [target.resourceNativeId],
        confirmationHash: "e".repeat(64), idempotencyKey: "nonqueued-retry" })).resolves.toBe(receipt);
      expect(dependencies.launch).not.toHaveBeenCalled();
      expect(repository.submit).not.toHaveBeenCalled();
    },
  );
});