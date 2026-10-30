import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { testDatabase } from "../../scripts/testDatabase.js";
import type { FrozenQuarantineTarget, InventoryQuarantineTarget, QuarantineAction, QuarantineActor, QuarantineAuthority } from "../types/copilotStudioQuarantine.js";
import { NativeInventory } from "./nativeInventory.js";
import { nativeInventoryFixture, reconcileInventoryFixture } from "../../scripts/inventoryFixtures.js";
import { CopilotStudioQuarantineRepository, createQuarantineConfirmation } from "./copilotStudioQuarantine.js";

let fixture: Awaited<ReturnType<typeof testDatabase>>;
let repository: CopilotStudioQuarantineRepository;
let inventory: NativeInventory;
const scope = { tenantId: "tenant-a", principalId: "operator-a" };
const actor: QuarantineActor = { tenantId: "tenant-a", homeAccountId: "operator-a", displayName: "Operator", username: "operator@example.invalid" };
const authority: QuarantineAuthority = { contractRevision: "a".repeat(64), permissionRevision: "b".repeat(64), configurationRevision: 1 };
const environmentId = "11111111-1111-4111-8111-111111111111";
const botId = "22222222-2222-4222-8222-222222222222";

beforeAll(async () => {
  fixture = await testDatabase();
  repository = new CopilotStudioQuarantineRepository(fixture.runtime);
  inventory = new NativeInventory(fixture.runtime);
});
afterAll(async () => { await fixture?.close(); });
beforeEach(() => {
  scope.tenantId = randomUUID();
  actor.tenantId = scope.tenantId;
});

async function seedInventory(principalId = scope.principalId, observedAt = new Date(), targetBotId = botId, targetEnvironmentId = environmentId) {
  const owner = { tenantId: scope.tenantId, principalId };
  const root = await nativeInventoryFixture(fixture.runtime, owner, [{
    nativeId: "native-agent", environmentId: targetEnvironmentId, displayName: "Canary agent", lifecycle: "published",
    identifiers: [{ kind: "power_platform_resource_id", value: "native-agent" }, { kind: "environment_id", value: targetEnvironmentId },
      { kind: "cds_bot_id", value: targetBotId }], details: { isQuarantined: false },
  }], { observedAt });
  await reconcileInventoryFixture(fixture.runtime, owner);
  return root.baselineId;
}

function frozen(target: InventoryQuarantineTarget, state = false, updatedAt = "2026-09-09T19:00:00.000Z"): FrozenQuarantineTarget {
  return { ...target, directStatus: { environmentId: target.environmentId, botId: target.botId, isBotQuarantined: state,
    lastUpdateTimeUtc: updatedAt, observedAt: new Date().toISOString(), correlationId: "33333333-3333-4333-8333-333333333333" } };
}

async function unqualifiedInput(action: QuarantineAction = "quarantine") {
  const inputScope = { ...scope, principalId: randomUUID() };
  const snapshotId = await seedInventory(inputScope.principalId, new Date(), randomUUID());
  const target = frozen((await inventory.resolveQuarantineTargets(inputScope, snapshotId, ["native-agent"]))[0], action === "unquarantine");
  const base = { action, targets: [target], actor: { ...actor, homeAccountId: inputScope.principalId },
    authority, requestPath: "/api/quarantine/jobs" };
  return { scope: inputScope, input: { ...base, idempotencyKey: randomUUID(), confirmationHash: createQuarantineConfirmation(base).confirmationHash } };
}

describe.sequential("Copilot Studio quarantine repository", () => {
  it("shares one current tenant-native target between actors without exposing another tenant", async () => {
    const snapshotId = await seedInventory();
    const target = await inventory.resolveQuarantineTargets(scope, snapshotId, ["native-agent"]);
    expect(target).toMatchObject([{ resourceNativeId: "native-agent", environmentId, botId, inventoryQuarantineState: false }]);
    await expect(inventory.resolveQuarantineTargets({ ...scope, principalId: "other" }, snapshotId, ["native-agent"]))
      .resolves.toEqual(target);
    await expect(inventory.resolveQuarantineTargets({ ...scope, tenantId: randomUUID() }, snapshotId, ["native-agent"]))
      .rejects.toMatchObject({ code: "quarantine_target_unavailable" });
    await expect(inventory.resolveQuarantineTargets(scope, snapshotId, ["Canary agent"]))
      .rejects.toMatchObject({ code: "quarantine_target_unavailable" });
  });

  it("rejects stale inventory and duplicate bulk selection", async () => {
    const staleSnapshot = await seedInventory("stale-operator", new Date(Date.now() - 25 * 60 * 60 * 1000));
    await expect(inventory.resolveQuarantineTargets({ ...scope, principalId: "stale-operator" }, staleSnapshot, ["native-agent"]))
      .rejects.toMatchObject({ code: "quarantine_inventory_stale" });
    const snapshotId = await seedInventory("duplicate-operator");
    await expect(inventory.resolveQuarantineTargets({ ...scope, principalId: "duplicate-operator" }, snapshotId, ["native-agent", "native-agent"]))
      .rejects.toMatchObject({ code: "duplicate_target" });
  });

  it("rejects genuine shared native ambiguity instead of choosing another environment's target", async () => {
    const saved = await nativeInventoryFixture(fixture.runtime, scope, [environmentId, randomUUID()].map(environment => ({
      nativeId: "native-agent", environmentId: environment,
      identifiers: [{ kind: "environment_id", value: environment }, { kind: "cds_bot_id", value: randomUUID() }],
    })));
    await reconcileInventoryFixture(fixture.runtime, scope);
    for (const principalId of [scope.principalId, "another-reader"]) {
      await expect(inventory.resolveQuarantineTargets({ ...scope, principalId }, saved.baselineId, ["native-agent"]))
        .rejects.toMatchObject({ code: "quarantine_target_ambiguous" });
    }
  });

  it("reuses direct observations across GUID casing aliases without changing source evidence", async () => {
    const sourceEnvironment = `Default-a${randomUUID().slice(1)}`.toUpperCase(), sourceBot = `b${randomUUID().slice(1)}`.toUpperCase();
    const snapshotId = await seedInventory("status-operator", new Date(), sourceBot, sourceEnvironment);
    const statusScope = { ...scope, principalId: "status-operator" };
    const target = (await inventory.resolveQuarantineTargets(statusScope, snapshotId, ["native-agent"]))[0];
    expect(await repository.latestObservation(statusScope, target)).toBeUndefined();
    const status = { ...frozen(target).directStatus, environmentId: sourceEnvironment.toLowerCase(), botId: sourceBot.toLowerCase() };
    await repository.recordObservation(statusScope, target, status);
    expect(await repository.latestObservation(statusScope, target)).toEqual({ ...status, environmentId: sourceEnvironment, botId: sourceBot });
    expect(await repository.latestObservation(statusScope, { ...target, environmentId: status.environmentId, botId: status.botId })).toEqual(status);
  });

  it("preserves canonical idempotency and frozen provider timestamp evidence without canary qualification", async () => {
    const snapshotId = await seedInventory();
    const target = frozen((await inventory.resolveQuarantineTargets(scope, snapshotId, ["native-agent"]))[0]);
    const base = { action: "quarantine" as const, targets: [target], actor, authority, requestPath: "/api/quarantine/jobs" };
    const confirmation = createQuarantineConfirmation(base);
    expect(await repository.isQualified(scope, authority, [target])).toBe(false);
    const [first, concurrentRetry] = await Promise.all([
      repository.submit(scope, { ...base, idempotencyKey: "same-key", confirmationHash: confirmation.confirmationHash }),
      repository.submit(scope, { ...base, idempotencyKey: "same-key", confirmationHash: confirmation.confirmationHash }),
    ]);
    expect(concurrentRetry.id).toBe(first.id);
    const retry = await repository.submit(scope, { ...base, idempotencyKey: "same-key", confirmationHash: confirmation.confirmationHash });
    expect(retry.id).toBe(first.id);
    const changed = { ...base, targets: [frozen(target, false, "2026-09-09T19:00:01.000Z")] };
    const changedConfirmation = createQuarantineConfirmation(changed);
    await expect(repository.submit(scope, { ...changed, idempotencyKey: "same-key", confirmationHash: changedConfirmation.confirmationHash }))
      .rejects.toMatchObject({ code: "idempotency_mismatch" });
    expect(await repository.isQualified(scope, authority, [target])).toBe(false);
  });

  it.each(["succeeded", "failed"] as const)("does not relabel a committed %s item when cancellation races lease release", async outcome => {
    const submitted = await unqualifiedInput();
    const job = await repository.submit(submitted.scope, submitted.input);
    const lease = (await repository.claim(submitted.scope, job.id, randomUUID()))!;
    const current = (await repository.beginItem(lease))!;
    if (outcome === "succeeded") await repository.markSent(lease, current.item, authority);
    await repository.finishItem(lease, current.item, outcome, outcome === "succeeded"
      ? { observed: { ...submitted.input.targets[0].directStatus, isBotQuarantined: true, lastUpdateTimeUtc: "2026-09-09T19:00:01Z" }, readbackCount: 1 }
      : { errorCode: "provider_error" });

    expect(await repository.cancel(submitted.scope, job.id)).toMatchObject({ status: outcome, cancelled: 0,
      results: [expect.objectContaining({ status: outcome })] });
    await repository.release(lease);
    expect(await repository.get(submitted.scope, job.id)).toMatchObject({ status: outcome, cancelled: 0 });
  });

  it("recovers a sent item as inconclusive and blocks new work until GET reconciliation", async () => {
    const { scope, input } = await unqualifiedInput();
    const existing = await repository.submit(scope, input);
    const lease = await repository.claim(scope, existing.id, "44444444-4444-4444-8444-444444444444");
    const current = await repository.beginItem(lease!);
    await repository.markSent(lease!, current!.item, authority);
    await fixture.operator.query("UPDATE copilot_quarantine_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1", [existing.id]);
    expect(await repository.recoverInterrupted(scope.tenantId)).toBeGreaterThan(0);
    expect(await repository.get(scope, existing.id)).toMatchObject({ status: "inconclusive", canReconcile: true });

    const snapshotId = await seedInventory("blocked-operator", new Date(), input.targets[0].botId, input.targets[0].environmentId);
    const blockedScope = { ...scope, principalId: "blocked-operator" };
    const inventoryTarget = (await inventory.resolveQuarantineTargets(blockedScope, snapshotId, ["native-agent"]))[0];
    const blockedActor = { ...actor, homeAccountId: "blocked-operator" };
    const base = { action: "quarantine" as const, targets: [frozen(inventoryTarget)], actor: blockedActor, authority, requestPath: "/api/quarantine/jobs" };
    const confirmation = createQuarantineConfirmation(base);
    await expect(repository.submit(blockedScope, { ...base, idempotencyKey: "blocked-by-other-principal", confirmationHash: confirmation.confirmationHash }))
      .rejects.toMatchObject({ code: "quarantine_reconciliation_required" });
  });

  it.each([false, true])("recovers cancelled active work without replay (sent=%s)", async sent => {
    const submitted = await unqualifiedInput();
    const job = await repository.submit(submitted.scope, submitted.input);
    const lease = (await repository.claim(submitted.scope, job.id, randomUUID()))!;
    const current = (await repository.beginItem(lease))!;
    if (sent) await repository.markSent(lease, current.item, authority);

    expect(await repository.cancel(submitted.scope, job.id)).toMatchObject({ status: "running", canResume: false });
    await fixture.operator.query("UPDATE copilot_quarantine_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1", [job.id]);
    expect(await repository.recoverJob(submitted.scope, job.id)).toBe(1);
    expect(await repository.get(submitted.scope, job.id)).toMatchObject({
      status: sent ? "inconclusive" : "cancelled", canResume: false, canReconcile: sent,
      results: [expect.objectContaining({ status: sent ? "inconclusive" : "cancelled",
        reconciliationStatus: sent ? "required" : "not_required" })],
    });
  });

  it.each(["before", "during"] as const)("keeps active work recoverable when reconciliation runs %s the next item", async timing => {
    const owner = { ...scope, principalId: randomUUID() };
    const agents = [0, 1].map(index => ({
      nativeId: `native-agent-${index}`, environmentId, botId: randomUUID(),
    }));
    const root = await nativeInventoryFixture(fixture.runtime, owner, agents.map(agent => ({
      nativeId: agent.nativeId, environmentId: agent.environmentId, displayName: agent.nativeId,
      identifiers: [{ kind: "environment_id", value: agent.environmentId }, { kind: "cds_bot_id", value: agent.botId }],
    })));
    await reconcileInventoryFixture(fixture.runtime, owner);
    const targets = (await inventory.resolveQuarantineTargets(owner, root.baselineId, agents.map(agent => agent.nativeId))).map(target => frozen(target));
    const base = { action: "quarantine" as const, targets, actor: { ...actor, homeAccountId: owner.principalId },
      authority, requestPath: "/api/quarantine/jobs" };
    const job = await repository.submit(owner, { ...base, idempotencyKey: randomUUID(), confirmationHash: createQuarantineConfirmation(base).confirmationHash });
    const lease = (await repository.claim(owner, job.id, randomUUID()))!;
    const first = (await repository.beginItem(lease))!;
    await repository.markSent(lease, first.item, authority);
    await repository.finishItem(lease, first.item, "inconclusive");
    const second = timing === "during" ? (await repository.beginItem(lease))! : undefined;
    await repository.recordReconciliation(owner, first.job, first.item, "verified_applied", {
      environmentId: first.item.environment_id, botId: first.item.bot_id, isBotQuarantined: true,
      lastUpdateTimeUtc: "2026-09-09T19:00:01Z", observedAt: new Date().toISOString(), correlationId: randomUUID(),
    }, "Provider GET confirmed the first item.");
    const active = second ?? (await repository.beginItem(lease))!;
    await repository.markSent(lease, active.item, authority);

    expect(await repository.get(owner, job.id)).toMatchObject({ status: "running", succeeded: 1, canResume: false });
    await fixture.operator.query("UPDATE copilot_quarantine_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1", [job.id]);
    expect(await repository.recoverJob(owner, job.id)).toBe(1);
    expect(await repository.get(owner, job.id)).toMatchObject({
      status: "inconclusive", succeeded: 1, inconclusive: 1, canReconcile: true,
    });
  });

  it("blocks native GUID casing aliases at both submission and final dispatch after an uncertain write", async () => {
    const upperEnvironment = `a${randomUUID().slice(1)}`.toUpperCase(), upperBot = `b${randomUUID().slice(1)}`.toUpperCase();
    async function request(principalId: string, environment: string, bot: string, existingSnapshotId?: string) {
      const owner = { ...scope, principalId };
      const snapshotId = existingSnapshotId ?? await seedInventory(principalId, new Date(), bot, environment);
      const saved = (await inventory.resolveQuarantineTargets(owner, snapshotId, ["native-agent"]))[0];
      const target = frozen({ ...saved, environmentId: environment, botId: bot });
      const base = { action: "quarantine" as const, targets: [target], actor: { ...actor, homeAccountId: principalId },
        authority, requestPath: "/api/quarantine/jobs" };
      return { owner, snapshotId, input: { ...base, idempotencyKey: randomUUID(), confirmationHash: createQuarantineConfirmation(base).confirmationHash } };
    }
    const original = await request(randomUUID(), upperEnvironment, upperBot);
    const alias = await request(randomUUID(), upperEnvironment.toLowerCase(), upperBot.toLowerCase(), original.snapshotId);
    const originalJob = await repository.submit(original.owner, original.input);
    const queuedAlias = await repository.submit(alias.owner, alias.input);
    const originalLease = (await repository.claim(original.owner, originalJob.id, randomUUID()))!;
    const originalItem = (await repository.beginItem(originalLease))!;
    await repository.markSent(originalLease, originalItem.item, authority);
    const aliasLease = (await repository.claim(alias.owner, queuedAlias.id, randomUUID()))!;
    const aliasItem = (await repository.beginItem(aliasLease))!;
    await expect(repository.assertDispatchReady(aliasLease, aliasItem.item, authority))
      .rejects.toMatchObject({ code: "quarantine_reconciliation_required" });
    await fixture.operator.query("UPDATE copilot_quarantine_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1", [originalJob.id]);
    await repository.recoverJob(original.owner, originalJob.id);
    expect(await repository.get(original.owner, originalJob.id)).toMatchObject({ status: "inconclusive", canReconcile: true });

    await expect(repository.submit(alias.owner, { ...alias.input, idempotencyKey: randomUUID() }))
      .rejects.toMatchObject({ code: "quarantine_reconciliation_required" });
    await expect(repository.assertDispatchReady(aliasLease, aliasItem.item, authority))
      .rejects.toMatchObject({ code: "quarantine_reconciliation_required" });
    await repository.finishItem(aliasLease, aliasItem.item, "failed", { errorCode: "quarantine_reconciliation_required" });
    await repository.release(aliasLease);
  });

  it("lists bounded tenant audit events without credentials or provider response bodies", async () => {
    const snapshotId = await seedInventory();
    const target = frozen((await inventory.resolveQuarantineTargets(scope, snapshotId, ["native-agent"]))[0]);
    const base = { action: "quarantine" as const, targets: [target], actor, authority, requestPath: "/api/quarantine/jobs" };
    await repository.submit(scope, { ...base, idempotencyKey: randomUUID(), confirmationHash: createQuarantineConfirmation(base).confirmationHash });
    const audit = await repository.listAudit(scope, 10);
    expect(audit.value.length).toBeGreaterThan(0);
    expect(audit.value[0]).toMatchObject({ actor: { username: expect.stringMatching(/@example\.invalid$/) }, target: { environmentId, botId }, requestedState: true });
    expect(JSON.stringify(audit)).not.toMatch(/ephemeral-token|Bearer|accessToken|private-provider-response/);
    expect((await repository.listAudit({ ...scope, principalId: "other-principal" }, 10)).value).toEqual([]);
  });

  it("moves only unclaimed queued work to explicit authorization wait during process-start recovery", async () => {
    const startupBotId = "55555555-5555-4555-8555-555555555555";
    const snapshotId = await seedInventory("startup-operator", new Date(), startupBotId);
    const startupScope = { ...scope, principalId: "startup-operator" };
    const target = frozen((await inventory.resolveQuarantineTargets(startupScope, snapshotId, ["native-agent"]))[0]);
    const base = { action: "quarantine" as const, targets: [target], actor: { ...actor, homeAccountId: startupScope.principalId }, authority, requestPath: "/api/quarantine/jobs" };
    const confirmation = createQuarantineConfirmation(base);
    const job = await repository.submit(startupScope, { ...base, idempotencyKey: "startup-unclaimed", confirmationHash: confirmation.confirmationHash });
    const runningJob = await repository.submit(startupScope, { ...base, idempotencyKey: "startup-running", confirmationHash: confirmation.confirmationHash });
    const lease = await repository.claim(startupScope, runningJob.id, "66666666-6666-4666-8666-666666666666");
    const current = await repository.beginItem(lease!);
    await repository.markSent(lease!, current!.item, authority);
    expect(job.status).toBe("queued");
    await repository.recoverInterrupted(scope.tenantId);
    expect((await repository.get(startupScope, job.id))?.status).toBe("queued");
    expect((await repository.get(startupScope, runningJob.id))?.status).toBe("running");
    while (await repository.recoverInterrupted(scope.tenantId, true) > 0) {}
    expect(await repository.get(startupScope, job.id)).toMatchObject({ status: "waiting_authorization", canResume: true });
    expect(await repository.get(startupScope, runningJob.id)).toMatchObject({ status: "inconclusive", canReconcile: true });
  });

  it.each(["quarantine", "unquarantine"] as const)("admits normal %s without manufacturing qualification or changing ownership and receipts", async action => {
    const { scope, input } = await unqualifiedInput(action);
    expect(await repository.isQualified(scope, authority, input.targets)).toBe(false);
    const job = await repository.submit(scope, input);
    expect(job).toMatchObject({ status: "queued", action, isCanary: false, confirmationHash: input.confirmationHash, total: 1 });
    expect(await repository.isQualified(scope, authority, input.targets)).toBe(false);
    expect(await repository.get({ ...scope, principalId: randomUUID() }, job.id)).toBeUndefined();
    expect((await repository.listAudit(scope)).value).toMatchObject([{ phase: "requested" }]);
    await expect(repository.submit(scope, { ...input, action: action === "quarantine" ? "unquarantine" : "quarantine" }))
      .rejects.toMatchObject({ code: "idempotency_mismatch" });
    expect((await repository.submit(scope, input)).id).toBe(job.id);
  });

  it("preserves actor, frozen target and confirmation validation without canary qualification", async () => {
    const { scope, input } = await unqualifiedInput();
    await expect(repository.submit({ ...scope, principalId: randomUUID() }, input)).rejects.toMatchObject({ code: "scope_mismatch" });
    await expect(repository.submit(scope, { ...input, confirmationHash: "e".repeat(64) })).rejects.toMatchObject({ code: "confirmation_mismatch" });
    const target = input.targets[0];
    await expect(repository.submit(scope, { ...input, targets: [{ ...target, directStatus: { ...target.directStatus, botId: randomUUID() } }] }))
      .rejects.toMatchObject({ code: "invalid_quarantine_target" });
    await expect(repository.submit(scope, { ...input, targets: [target, target] })).rejects.toMatchObject({ code: "duplicate_target" });
    expect((await repository.list(scope)).value).toEqual([]);
  });

  it("requires actual approval for an explicit canary job without restricting normal submission", async () => {
    const { scope, input } = await unqualifiedInput();
    const canaryInput = { ...input, canaryApprovalId: randomUUID() };
    const canaryConfirmation = createQuarantineConfirmation(canaryInput);
    canaryInput.confirmationHash = canaryConfirmation.confirmationHash;
    await expect(repository.submit(scope, canaryInput)).rejects.toMatchObject({ code: "qualification_invalidated" });
    expect((await repository.list(scope)).value).toEqual([]);
    expect(await repository.isQualified(scope, authority, input.targets)).toBe(false);
    await expect(repository.submit(scope, input)).resolves.toMatchObject({ isCanary: false, status: "queued" });
  });
});