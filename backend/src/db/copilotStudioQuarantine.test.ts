import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testDatabase } from "../../scripts/testDatabase.js";
import type { FrozenQuarantineTarget, InventoryQuarantineTarget, QuarantineAction, QuarantineActor, QuarantineAuthority } from "../types/copilotStudioQuarantine.js";
import { PowerPlatformInventoryRepository } from "./powerPlatformInventory.js";
import { CopilotStudioQuarantineRepository, createQuarantineConfirmation } from "./copilotStudioQuarantine.js";

let fixture: Awaited<ReturnType<typeof testDatabase>>;
let repository: CopilotStudioQuarantineRepository;
let inventory: PowerPlatformInventoryRepository;
const scope = { tenantId: "tenant-a", principalId: "operator-a" };
const actor: QuarantineActor = { tenantId: "tenant-a", homeAccountId: "operator-a", displayName: "Operator", username: "operator@example.invalid" };
const authority: QuarantineAuthority = { contractRevision: "a".repeat(64), permissionRevision: "b".repeat(64), configurationRevision: 1 };
const environmentId = "11111111-1111-4111-8111-111111111111";
const botId = "22222222-2222-4222-8222-222222222222";

beforeAll(async () => {
  fixture = await testDatabase();
  repository = new CopilotStudioQuarantineRepository(fixture.runtime);
  inventory = new PowerPlatformInventoryRepository(fixture.runtime);
});
afterAll(async () => { await fixture?.close(); });

async function seedInventory(principalId = scope.principalId, observedAt = new Date(), targetBotId = botId) {
  const queryHash = createHash("sha256").update(`${principalId}:${observedAt.toISOString()}:${randomUUID()}`).digest("hex");
  const jobId = (await fixture.operator.query<{ id: string }>(`INSERT INTO power_platform_refresh_jobs
    (id,tenant_id,principal_id,idempotency_key,request_hash,role_scope,requested_types,status)
    VALUES(gen_random_uuid(),'tenant-a',$1,$2,repeat('c',64),'full','["microsoft.copilotstudio/agents"]','succeeded') RETURNING id`,
  [principalId, `inventory-${principalId}-${observedAt.getTime()}`])).rows[0].id;
  const snapshotId = (await fixture.operator.query<{ id: string }>(`INSERT INTO power_platform_inventory_snapshots
    (id,job_id,tenant_id,principal_id,query_hash,role_scope,requested_types,coverage,observed_count,total_records,page_count,unknown_field_count,observed_at)
    VALUES(gen_random_uuid(),$1,'tenant-a',$2,$3,'full','["microsoft.copilotstudio/agents"]',$4,1,1,1,0,$5) RETURNING id`,
  [jobId, principalId, queryHash, JSON.stringify(Array.from({ length: 11 }, () => ({ type: "fixture", status: "unknown", count: null }))), observedAt])).rows[0].id;
  await fixture.operator.query(`INSERT INTO power_platform_inventory_resources
    (snapshot_id,tenant_id,principal_id,native_id,resource_type,environment_id,display_name,source_system,creator_type,agent_kind,lifecycle,identity_confidence,identifiers,provenance,details,unknown_field_count)
    VALUES($1,'tenant-a',$2,'native-agent','microsoft.copilotstudio/agents',$3,'Canary agent','power_platform','unknown','copilot_studio_agent','published','exact_native',$4,'{}',$5,0)`,
  [snapshotId, principalId, environmentId, JSON.stringify([{ kind: "power_platform_resource_id", value: "native-agent" }, { kind: "environment_id", value: environmentId }, { kind: "cds_bot_id", value: targetBotId }]),
    JSON.stringify({ isQuarantined: false, quarantinedAt: null })]);
  return snapshotId;
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
  it("resolves only one current principal-scoped native environment and bot target", async () => {
    const snapshotId = await seedInventory();
    const target = await inventory.resolveQuarantineTargets(scope, snapshotId, ["native-agent"]);
    expect(target).toMatchObject([{ resourceNativeId: "native-agent", environmentId, botId, inventoryQuarantineState: false }]);
    const candidates = await inventory.listQuarantineTargets(scope);
    expect(candidates).toMatchObject({ count: 1, snapshot: { id: snapshotId }, value: [{ nativeId: "native-agent", environmentId, botId, quarantineEligibility: { eligible: true, code: "eligible" } }] });
    expect(candidates.value[0]).not.toHaveProperty("tenantId");
    expect(await inventory.listQuarantineTargets({ ...scope, principalId: "other" })).toEqual({ value: [], count: 0, snapshot: null });
    await expect(inventory.resolveQuarantineTargets({ ...scope, principalId: "other" }, snapshotId, ["native-agent"]))
      .rejects.toMatchObject({ code: "quarantine_inventory_unavailable" });
    await expect(inventory.resolveQuarantineTargets(scope, snapshotId, ["Canary agent"]))
      .rejects.toMatchObject({ code: "quarantine_target_unavailable" });
  });

  it("rejects stale inventory and duplicate bulk selection", async () => {
    const staleSnapshot = await seedInventory("stale-operator", new Date(Date.now() - 25 * 60 * 60 * 1000));
    expect(await inventory.listQuarantineTargets({ tenantId: "tenant-a", principalId: "stale-operator" })).toMatchObject({
      snapshot: { id: staleSnapshot }, value: [{ quarantineEligibility: { eligible: false, code: "stale_snapshot" } }],
    });
    await expect(inventory.resolveQuarantineTargets({ tenantId: "tenant-a", principalId: "stale-operator" }, staleSnapshot, ["native-agent"]))
      .rejects.toMatchObject({ code: "quarantine_inventory_stale" });
    const snapshotId = await seedInventory("duplicate-operator");
    await expect(inventory.resolveQuarantineTargets({ tenantId: "tenant-a", principalId: "duplicate-operator" }, snapshotId, ["native-agent", "native-agent"]))
      .rejects.toMatchObject({ code: "duplicate_target" });
  });

  it("retains a short direct observation without converting missing state to false", async () => {
    const snapshotId = await seedInventory("status-operator");
    const statusScope = { tenantId: "tenant-a", principalId: "status-operator" };
    const target = (await inventory.resolveQuarantineTargets(statusScope, snapshotId, ["native-agent"]))[0];
    expect(await repository.latestObservation(statusScope, target)).toBeUndefined();
    const status = frozen(target).directStatus;
    await repository.recordObservation(statusScope, target, status);
    expect(await repository.latestObservation(statusScope, target)).toEqual(status);
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

  it("recovers a sent item as inconclusive and blocks new work until GET reconciliation", async () => {
    const existing = (await repository.list(scope)).value.find(job => job.status === "queued")!;
    const lease = await repository.claim(scope, existing.id, "44444444-4444-4444-8444-444444444444");
    const current = await repository.beginItem(lease!);
    await repository.markSent(lease!, current!.item, authority);
    await fixture.operator.query("UPDATE copilot_quarantine_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1", [existing.id]);
    expect(await repository.recoverInterrupted()).toBeGreaterThan(0);
    expect(await repository.get(scope, existing.id)).toMatchObject({ status: "inconclusive", canReconcile: true });

    const snapshotId = await seedInventory("blocked-operator");
    const blockedScope = { tenantId: "tenant-a", principalId: "blocked-operator" };
    const inventoryTarget = (await inventory.resolveQuarantineTargets(blockedScope, snapshotId, ["native-agent"]))[0];
    const blockedActor = { ...actor, homeAccountId: "blocked-operator" };
    const base = { action: "quarantine" as const, targets: [frozen(inventoryTarget)], actor: blockedActor, authority, requestPath: "/api/quarantine/jobs" };
    const confirmation = createQuarantineConfirmation(base);
    await expect(repository.submit(blockedScope, { ...base, idempotencyKey: "blocked-by-other-principal", confirmationHash: confirmation.confirmationHash }))
      .rejects.toMatchObject({ code: "quarantine_reconciliation_required" });
  });

  it("lists bounded tenant audit events without credentials or provider response bodies", async () => {
    const audit = await repository.listAudit(scope, 10);
    expect(audit.value.length).toBeGreaterThan(0);
    expect(audit.value[0]).toMatchObject({ actor: { username: expect.stringMatching(/@example\.invalid$/) }, target: { environmentId, botId }, requestedState: true });
    expect(JSON.stringify(audit)).not.toMatch(/ephemeral-token|Bearer|accessToken|private-provider-response/);
    expect((await repository.listAudit({ tenantId: "tenant-a", principalId: "other-principal" }, 10)).value).toEqual([]);
  });

  it("moves only unclaimed queued work to explicit authorization wait during process-start recovery", async () => {
    const startupBotId = "55555555-5555-4555-8555-555555555555";
    const snapshotId = await seedInventory("startup-operator", new Date(), startupBotId);
    const startupScope = { tenantId: "tenant-a", principalId: "startup-operator" };
    const target = frozen((await inventory.resolveQuarantineTargets(startupScope, snapshotId, ["native-agent"]))[0]);
    const base = { action: "quarantine" as const, targets: [target], actor: { ...actor, homeAccountId: startupScope.principalId }, authority, requestPath: "/api/quarantine/jobs" };
    const confirmation = createQuarantineConfirmation(base);
    const job = await repository.submit(startupScope, { ...base, idempotencyKey: "startup-unclaimed", confirmationHash: confirmation.confirmationHash });
    const runningJob = await repository.submit(startupScope, { ...base, idempotencyKey: "startup-running", confirmationHash: confirmation.confirmationHash });
    const lease = await repository.claim(startupScope, runningJob.id, "66666666-6666-4666-8666-666666666666");
    const current = await repository.beginItem(lease!);
    await repository.markSent(lease!, current!.item, authority);
    expect(job.status).toBe("queued");
    await repository.recoverInterrupted();
    expect((await repository.get(startupScope, job.id))?.status).toBe("queued");
    expect((await repository.get(startupScope, runningJob.id))?.status).toBe("running");
    await repository.recoverInterrupted(true);
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