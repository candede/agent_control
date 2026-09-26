import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { testDatabase } from "../../scripts/testDatabase.js";
import type { PowerPlatformResource } from "../types/powerPlatformInventory.js";
import { CopilotStudioQuarantineRepository, createQuarantineConfirmation, type QuarantineScope } from "./copilotStudioQuarantine.js";
import { PowerPlatformInventoryRepository } from "./powerPlatformInventory.js";

let fixture: Awaited<ReturnType<typeof testDatabase>>;
let repository: CopilotStudioQuarantineRepository;
let inventory: PowerPlatformInventoryRepository;
const environmentId = "11111111-1111-4111-8111-111111111111";
const botId = "22222222-2222-4222-8222-222222222222";
const authority = { contractRevision: "a".repeat(64), permissionRevision: "b".repeat(64), configurationRevision: 1 };

beforeAll(async () => {
  fixture = await testDatabase();
  repository = new CopilotStudioQuarantineRepository(fixture.runtime);
  inventory = new PowerPlatformInventoryRepository(fixture.runtime);
});
afterAll(async () => { await fixture?.close(); });

function scopes(label: string) {
  return [
    { tenantId: `${label}-tenant-a`, principalId: "shared-principal" },
    { tenantId: `${label}-tenant-b`, principalId: "shared-principal" },
    { tenantId: `${label}-tenant-a`, principalId: "private-principal" },
  ];
}

async function running(scope: QuarantineScope) {
  const resource: PowerPlatformResource = {
    tenantId: scope.tenantId, nativeId: "shared-native-agent", environmentId, type: "microsoft.copilotstudio/agents",
    displayName: `${scope.tenantId}/${scope.principalId}`, location: null, createdAt: null, createdBy: null, lastPublishedAt: null,
    sourceSystem: "power_platform", authoringTool: "Copilot Studio", creatorType: "unknown", agentKind: "copilot_studio_agent",
    lifecycle: "published", identityConfidence: "exact_native", unknownFieldCount: 0,
    identifiers: [{ kind: "power_platform_resource_id", value: "shared-native-agent" },
      { kind: "environment_id", value: environmentId }, { kind: "cds_bot_id", value: botId }],
    provenance: {}, details: { isQuarantined: false },
  };
  const refresh = await inventory.submit(scope, {
    idempotencyKey: "same-refresh", roleScope: "full", requestedTypes: [resource.type],
  });
  await inventory.markRunning(scope, refresh.id);
  const saved = await inventory.publish(scope, refresh.id, {
    resources: [resource], queriedTypes: [resource.type], environmentScope: null, totalRecords: 1, pages: 1, unknownFieldCount: 0,
  });
  const target = (await inventory.resolveQuarantineTargets(scope, saved.snapshotId, [resource.nativeId]))[0];
  const directStatus = { environmentId, botId, isBotQuarantined: false, lastUpdateTimeUtc: "2026-09-01T00:00:00Z",
    observedAt: new Date().toISOString(), correlationId: randomUUID() };
  const input = {
    action: "quarantine" as const, targets: [{ ...target, directStatus }], authority,
    actor: { tenantId: scope.tenantId, homeAccountId: scope.principalId, username: "operator@example.invalid", displayName: resource.displayName! },
    requestPath: "/api/quarantine/jobs", idempotencyKey: "same-mutation",
  };
  const job = await repository.submit(scope, { ...input, confirmationHash: createQuarantineConfirmation(input).confirmationHash });
  const lease = (await repository.claim(scope, job.id, randomUUID()))!;
  const current = (await repository.beginItem(lease))!;
  return { scope, job: current.job, item: current.item, lease, directStatus, target };
}

describe("quarantine child ownership across tenants and accounts", () => {
  it("does not requeue a foreign item under a valid local job lease", async () => {
    const [owner, ...foreign] = await Promise.all(scopes("pause").map(running));
    for (const other of foreign) {
      expect(await repository.get(owner.scope, other.job.id)).toBeUndefined();
      expect(await repository.claim(owner.scope, other.job.id, randomUUID())).toBeUndefined();
      await expect(repository.pauseItemForAuthorization(owner.lease, other.item))
        .rejects.toMatchObject({ code: "already_dispatched" });
      expect(await repository.get(other.scope, other.job.id)).toMatchObject({ status: "running" });
      const item = (await fixture.runtime.query("SELECT status,correlation_id FROM copilot_quarantine_job_items WHERE id=$1", [other.item.id])).rows[0];
      expect(item).toEqual({ status: "running", correlation_id: other.item.correlation_id });
      expect((await repository.listAudit(other.scope)).value).toHaveLength(2);
    }
    await repository.pauseItemForAuthorization(owner.lease, owner.item);
    expect(await repository.get(owner.scope, owner.job.id)).toMatchObject({ status: "waiting_authorization" });
    expect((await fixture.runtime.query("SELECT status FROM copilot_quarantine_job_items WHERE id=$1", [owner.item.id])).rows)
      .toEqual([{ status: "queued" }]);
  });

  it("fences reconciliation callbacks, writes, observations and audit against the exact scoped parent", async () => {
    const [owner, ...foreign] = await Promise.all(scopes("reconcile").map(running));
    for (const current of [owner, ...foreign]) {
      await repository.finishItem(current.lease, current.item, "inconclusive");
      await repository.release(current.lease);
    }
    const operation = vi.fn(async () => "verified");
    const observed = { ...owner.directStatus, isBotQuarantined: true };
    for (const other of foreign) {
      await expect(repository.withReconciliationLock(owner.scope, other.item, operation))
        .rejects.toMatchObject({ code: "reconciliation_state" });
      await expect(repository.recordReconciliation(owner.scope, other.job, other.item, "verified_applied", observed, "Foreign parent"))
        .rejects.toMatchObject({ code: "reconciliation_state" });
      await expect(repository.recordReconciliation(owner.scope, owner.job, other.item, "verified_applied", observed, "Foreign child"))
        .rejects.toMatchObject({ code: "reconciliation_state" });
      expect(await repository.get(other.scope, other.job.id)).toMatchObject({ status: "inconclusive", canReconcile: true });
      expect(await repository.latestObservation(other.scope, other.target)).toBeUndefined();
      expect((await repository.listAudit(other.scope)).value.some(event => event.phase === "reconciled")).toBe(false);
    }
    expect(operation).not.toHaveBeenCalled();
    expect(await repository.latestObservation(owner.scope, owner.target)).toBeUndefined();
    await expect(repository.recordReconciliation(owner.scope, owner.job, owner.item, "verified_applied",
      { ...observed, botId: randomUUID() }, "Mismatched evidence")).rejects.toMatchObject({ code: "target_mismatch" });
    expect(await repository.get(owner.scope, owner.job.id)).toMatchObject({ status: "inconclusive" });
    expect(await repository.withReconciliationLock(owner.scope, owner.item, operation)).toBe("verified");
    await repository.recordReconciliation(owner.scope, { ...owner.job, actor_name: "Untrusted actor" },
      { ...owner.item, display_name: "Untrusted item" }, "verified_applied", observed, "Verified local target");
    expect(await repository.get(owner.scope, owner.job.id)).toMatchObject({ status: "succeeded" });
    expect(await repository.latestObservation(owner.scope, owner.target)).toEqual(observed);
    expect((await repository.listAudit(owner.scope)).value.find(event => event.phase === "reconciled"))
      .toMatchObject({ jobId: owner.job.id, itemId: owner.item.id, actor: { displayName: owner.job.actor_name } });
    for (const other of foreign) {
      expect(await repository.get(other.scope, other.job.id)).toMatchObject({ status: "inconclusive" });
      expect(await repository.latestObservation(other.scope, other.target)).toBeUndefined();
    }
  });
});
