import { describe, expect, it, vi } from "vitest";
import type { AuthenticatedUser } from "../types/session.js";
import { CopilotStudioQuarantineControlService } from "./copilotStudioQuarantineControl.js";

const user: AuthenticatedUser = { tenantId: "tenant-a", homeAccountId: "operator-a", displayName: "Operator", username: "operator@example.invalid", roles: ["AgentControl.Operator"] };
const target = { resourceNativeId: "native-agent", displayName: "Agent", snapshotId: "11111111-1111-4111-8111-111111111111", inventoryObservedAt: "2026-09-09T19:00:00Z",
  inventoryExpiresAt: "2026-09-10T19:00:00Z", environmentId: "22222222-2222-4222-8222-222222222222", botId: "33333333-3333-4333-8333-333333333333",
  inventoryQuarantineState: false, inventoryQuarantinedAt: null };
const direct = { environmentId: target.environmentId, botId: target.botId, isBotQuarantined: true, lastUpdateTimeUtc: "2026-09-09T19:01:00.1234567Z",
  observedAt: "2026-09-09T19:01:01Z", correlationId: "44444444-4444-4444-8444-444444444444" };
const authority = { contractRevision: "a".repeat(64), permissionRevision: "b".repeat(64), configurationRevision: 1 };

function service(cached = false) {
  const repository = {
    existingSubmission: vi.fn(async () => undefined), latestObservation: vi.fn(async () => cached ? direct : undefined), recordObservation: vi.fn(async () => direct),
    isQualified: vi.fn(async () => false), submit: vi.fn(),
  };
  const inventory = { resolveQuarantineTargets: vi.fn(async () => [target]) };
  const provider = { getStatus: vi.fn(async () => direct) };
  const dependencies = {
    revalidateUser: vi.fn(async () => user), delegatedToken: vi.fn(async () => "ephemeral-token"), requireAvailable: vi.fn(async () => undefined),
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
    const { value, repository, provider, dependencies } = service(false);
    await expect(value.status(user, target.snapshotId, target.resourceNativeId, true)).resolves.toMatchObject({ direct: { source: "provider", providerUpdatedAt: direct.lastUpdateTimeUtc } });
    expect(provider.getStatus).toHaveBeenCalledTimes(1);
    expect(dependencies.revalidateUser).toHaveBeenCalledTimes(2);
    expect(repository.recordObservation).toHaveBeenCalledWith({ tenantId: "tenant-a", principalId: "operator-a" }, target, direct);
  });

  it("builds an exact frozen preview and reports qualification independently", async () => {
    const { value } = service(true);
    await expect(value.preview(user, { action: "unquarantine", snapshotId: target.snapshotId, resourceNativeIds: [target.resourceNativeId] })).resolves.toMatchObject({
      confirmationHash: expect.stringMatching(/^[a-f0-9]{64}$/), summary: { targetCount: 1, operation: "unquarantine", packageControlIndependent: true },
      qualification: { qualified: false, requiredForSubmit: true }, statuses: [{ direct: { isBotQuarantined: true }, inventory: { isQuarantined: false } }],
    });
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