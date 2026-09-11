import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { testDatabase } from "../../scripts/testDatabase.js";
import { CopilotStudioQuarantineRepository, createQuarantineConfirmation, type QuarantineScope } from "../db/copilotStudioQuarantine.js";
import { revokeAccountSessionMutations } from "../db/sessions.js";
import type { FrozenQuarantineTarget, QuarantineActor, QuarantineAuthority } from "../types/copilotStudioQuarantine.js";
import {
  cancelCopilotStudioQuarantineJob,
  reconcileCopilotStudioQuarantineJob,
  runCopilotStudioQuarantineJob,
  runTrackedCopilotStudioQuarantineJob,
} from "./copilotStudioQuarantineJobs.js";

let fixture: Awaited<ReturnType<typeof testDatabase>>;
let repository: CopilotStudioQuarantineRepository;
const authority: QuarantineAuthority = { contractRevision: "a".repeat(64), permissionRevision: "b".repeat(64), configurationRevision: 1 };
const environmentId = "11111111-1111-4111-8111-111111111111";
const botId = "22222222-2222-4222-8222-222222222222";
const updatedAt = "2026-09-09T19:00:00.1234567Z";

beforeAll(async () => { fixture = await testDatabase(); repository = new CopilotStudioQuarantineRepository(fixture.runtime); });
afterAll(async () => { await fixture?.close(); });

function scope(tenantId = `fixture-tenant-${randomUUID()}`): QuarantineScope { return { tenantId, principalId: randomUUID() }; }
function actor(value: QuarantineScope): QuarantineActor { return { tenantId: value.tenantId, homeAccountId: value.principalId, displayName: "Operator", username: "operator@example.invalid" }; }
function target(snapshotId: string, state = false): FrozenQuarantineTarget {
  return { resourceNativeId: "native-agent", displayName: "Canary agent", snapshotId,
    inventoryObservedAt: new Date().toISOString(), inventoryExpiresAt: new Date(Date.now() + 60_000).toISOString(), inventoryQuarantineState: false,
    inventoryQuarantinedAt: null, environmentId, botId, directStatus: { environmentId, botId, isBotQuarantined: state,
      lastUpdateTimeUtc: updatedAt, observedAt: new Date().toISOString(), correlationId: "44444444-4444-4444-8444-444444444444" } };
}
async function ensureQualified(tenantId: string, targetBotId = botId) {
  await fixture.runtime.query(`INSERT INTO copilot_quarantine_qualifications
    (id,tenant_id,target_environment_id,target_bot_id,original_approval_id,restoration_approval_id,original_job_id,restoration_job_id,
     contract_revision,permission_revision,configuration_revision,auth_mode)
    VALUES(gen_random_uuid(),$1,$2,$3,gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),$4,$5,1,'delegated') ON CONFLICT DO NOTHING`,
  [tenantId, environmentId, targetBotId, authority.contractRevision, authority.permissionRevision]);
}
async function submitted(value: QuarantineScope) {
  await ensureQualified(value.tenantId);
  const snapshotId = await seedInventory(value);
  const input = { action: "quarantine" as const, targets: [target(snapshotId)], actor: actor(value), authority, requestPath: "/api/quarantine/jobs" };
  const confirmation = createQuarantineConfirmation(input);
  return repository.submit(value, { ...input, idempotencyKey: randomUUID(), confirmationHash: confirmation.confirmationHash });
}

async function seedInventory(value: QuarantineScope, descriptors = [{ resourceNativeId: "native-agent", botId }]) {
  const job = await fixture.operator.query<{ id: string }>(`INSERT INTO power_platform_refresh_jobs
    (id,tenant_id,principal_id,idempotency_key,request_hash,role_scope,requested_types,status)
    VALUES(gen_random_uuid(),$1,$2,$3,repeat('c',64),'full','["microsoft.copilotstudio/agents"]','succeeded') RETURNING id`,
  [value.tenantId, value.principalId, `inventory-${randomUUID()}`]);
  const snapshot = await fixture.operator.query<{ id: string }>(`INSERT INTO power_platform_inventory_snapshots
    (id,job_id,tenant_id,principal_id,query_hash,role_scope,requested_types,coverage,observed_count,total_records,page_count,unknown_field_count)
    VALUES(gen_random_uuid(),$1,$2,$3,repeat('d',64),'full','["microsoft.copilotstudio/agents"]',$4,$5,$5,1,0) RETURNING id`,
  [job.rows[0].id, value.tenantId, value.principalId, JSON.stringify(Array.from({ length: 11 }, () => ({ type: "fixture", status: "unknown", count: null }))), descriptors.length]);
  for (const descriptor of descriptors) await fixture.operator.query(`INSERT INTO power_platform_inventory_resources
    (snapshot_id,tenant_id,principal_id,native_id,resource_type,environment_id,display_name,source_system,creator_type,agent_kind,lifecycle,identity_confidence,identifiers,provenance,details,unknown_field_count)
    VALUES($1,$2,$3,$6,'microsoft.copilotstudio/agents',$4,'Canary agent','power_platform','unknown','copilot_studio_agent','published','exact_native',$5,'{}','{}',0)`,
  [snapshot.rows[0].id, value.tenantId, value.principalId, environmentId, JSON.stringify([{ kind: "power_platform_resource_id", value: descriptor.resourceNativeId },
    { kind: "environment_id", value: environmentId }, { kind: "cds_bot_id", value: descriptor.botId }]), descriptor.resourceNativeId]);
  return snapshot.rows[0].id;
}
function status(state: boolean, providerUpdatedAt = updatedAt) {
  return { environmentId, botId, isBotQuarantined: state, lastUpdateTimeUtc: providerUpdatedAt, observedAt: new Date().toISOString(), correlationId: randomUUID() };
}
const authorize = async () => ({ accessToken: "ephemeral-token", authority });

describe.sequential("durable Copilot Studio quarantine execution", () => {
  it("exposes all 25 frozen targets in the confirmation and rejects a 26th target", () => {
    const value = scope();
    const snapshotId = randomUUID();
    const targets = Array.from({ length: 26 }, (_, index) => {
      const original = target(snapshotId);
      const targetBotId = randomUUID();
      return { ...original, resourceNativeId: `native-agent-${index}`, botId: targetBotId,
        directStatus: { ...original.directStatus, botId: targetBotId } };
    });
    const input = { action: "quarantine" as const, targets: targets.slice(0, 25), actor: actor(value), authority, requestPath: "/api/quarantine/jobs" };
    const confirmation = createQuarantineConfirmation(input);
    expect(confirmation.summary.targets).toHaveLength(25);
    expect(confirmation.summary.additionalTargetCount).toBe(0);
    expect(confirmation.summary.targets.map(item => item.botId).sort()).toEqual(input.targets.map(item => item.botId).sort());
    expect(() => createQuarantineConfirmation({ ...input, targets })).toThrow("1-25 exact quarantine targets");
  });

  it("keeps partial bulk results independent through delayed convergence, no-op, conflict and GET-only reconciliation", async () => {
    const value = scope();
    const descriptors = ["accepted", "delayed", "already-correct", "conflict"].map((resourceNativeId, index) => ({
      resourceNativeId, botId: `${index + 3}2222222-2222-4222-8222-222222222222`,
    }));
    const snapshotId = await seedInventory(value, descriptors);
    for (const descriptor of descriptors) await ensureQualified(value.tenantId, descriptor.botId);
    const targets = descriptors.map(descriptor => {
      const original = target(snapshotId);
      return { ...original, ...descriptor, directStatus: { ...original.directStatus, botId: descriptor.botId } };
    });

    const input = { action: "quarantine" as const, targets, actor: actor(value), authority, requestPath: "/api/quarantine/jobs" };
    const job = await repository.submit(value, { ...input, idempotencyKey: randomUUID(), confirmationHash: createQuarantineConfirmation(input).confirmationHash });
    const reads = new Map<string, number>();
    const provider = {
      getStatus: vi.fn(async (_token: string, selected: { environmentId: string; botId: string }) => {
        const count = (reads.get(selected.botId) ?? 0) + 1;
        reads.set(selected.botId, count);
        const state = selected.botId === descriptors[2].botId || selected.botId === descriptors[1].botId && count >= 4;
        return { ...status(state, selected.botId === descriptors[3].botId ? "2026-09-09T19:00:02Z" : updatedAt), ...selected };
      }),
      setQuarantine: vi.fn(async (_token: string, selected: { environmentId: string; botId: string }, requestedState: boolean) => ({ ...status(requestedState), ...selected })),
    };
    await runCopilotStudioQuarantineJob(job.id, value, false, repository, provider, authorize);
    expect(await repository.get(value, job.id)).toMatchObject({ status: "inconclusive", total: 4, completed: 4, succeeded: 1, skipped: 1, failed: 1, inconclusive: 1 });
    expect(reads.get(descriptors[0].botId)).toBe(7);
    expect(reads.get(descriptors[1].botId)).toBe(4);
    expect(provider.setQuarantine.mock.calls.map(call => [call[1].botId, call[2]])).toEqual([[descriptors[0].botId, true], [descriptors[1].botId, true]]);
    await runCopilotStudioQuarantineJob(job.id, value, true, repository, provider, authorize);
    const reconciled = await reconcileCopilotStudioQuarantineJob(job.id, value, repository, provider, authorize);
    expect(reconciled).toMatchObject({ status: "partial", succeeded: 1, skipped: 1, failed: 1, reconciliation: { attempted: 1, failed: 0 } });
    expect(reconciled.results.find(result => result.resourceNativeId === "accepted")).toMatchObject({ reconciliationStatus: "verified_not_applied", retryEligible: true });
    expect(provider.setQuarantine).toHaveBeenCalledTimes(2);
  });

  it("emits a redacted alert event when a dispatched write becomes uncertain", async () => {
    const value=scope();
    const job=await submitted(value);
    const log=vi.spyOn(console,"error").mockImplementation(() => undefined);
    const provider = {
      getStatus: vi.fn(async () => status(false)),
      setQuarantine: vi.fn(async () => { throw new Error("synthetic uncertain provider result"); }),
    };
    await runCopilotStudioQuarantineJob(job.id,value,false,repository,provider,authorize);
    expect(await repository.get(value,job.id)).toMatchObject({ status: "inconclusive", inconclusive: 1 });
    expect(log.mock.calls.map(([entry]) => JSON.parse(entry))).toContainEqual({
      event: "quarantine_write_uncertain", jobId: job.id, outcome: "requires_reconciliation",
    });
    log.mockRestore();
  });

  it("emits a redacted stopped event when the finite item deadline expires before dispatch", async () => {
    const value=scope();
    const job=await submitted(value);
    const log=vi.spyOn(console,"error").mockImplementation(() => undefined);
    const provider = {
      getStatus: vi.fn(async () => { throw new DOMException("synthetic deadline","TimeoutError"); }),
      setQuarantine: vi.fn(async () => status(true)),
    };
    await runCopilotStudioQuarantineJob(job.id,value,false,repository,provider,authorize);
    expect(await repository.get(value,job.id)).toMatchObject({ status: "failed", failed: 1 });
    expect(log.mock.calls.map(([entry]) => JSON.parse(entry))).toContainEqual({
      event: "quarantine_job_stopped", jobId: job.id, outcome: "deadline_exceeded",
    });
    log.mockRestore();
  });

  it("persists sent before one POST and requires GET readback for success", async () => {
    const value = scope();
    const job = await submitted(value);
    let quarantined = false;
    const provider = {
      getStatus: vi.fn(async () => status(quarantined)),
      setQuarantine: vi.fn(async () => {
        const sent = await fixture.runtime.query("SELECT 1 FROM copilot_quarantine_job_items WHERE job_id=$1 AND sent_at IS NOT NULL", [job.id]);
        expect(sent.rowCount).toBe(1);
        quarantined = true;
        return status(true);
      }),
    };
    await runCopilotStudioQuarantineJob(job.id, value, false, repository, provider, authorize);
    expect(provider.setQuarantine).toHaveBeenCalledTimes(1);
    expect(provider.getStatus).toHaveBeenCalledTimes(3);
    expect(await repository.get(value, job.id)).toMatchObject({ status: "succeeded", succeeded: 1 });
  });

  it("does not abort another principal's active worker when cancellation is unauthorized", async () => {
    const owner = scope();
    const job = await submitted(owner);
    let release!: (value: ReturnType<typeof status>) => void;
    const held = new Promise<ReturnType<typeof status>>(resolve => { release = resolve; });
    let reads = 0;
    let quarantined = false;
    const provider = {
      getStatus: vi.fn(async () => ++reads === 1 ? held : status(quarantined)),
      setQuarantine: vi.fn(async () => { quarantined = true; return status(true); }),
    };
    const execution = runTrackedCopilotStudioQuarantineJob(job.id, owner, repository, provider, authorize);
    await vi.waitFor(() => expect(reads).toBe(1));

    await expect(cancelCopilotStudioQuarantineJob({ ...owner, principalId: randomUUID() }, job.id, repository)).resolves.toBeUndefined();
    release(status(false));
    await execution;

    expect(provider.setQuarantine).toHaveBeenCalledTimes(1);
    expect(await repository.get(owner, job.id)).toMatchObject({ status: "succeeded", succeeded: 1 });
  });

  it("does not dispatch when persisted cancellation wins during the immediate pre-write read", async () => {
    const value = scope();
    const job = await submitted(value);
    let reads = 0;
    let release!: (value: ReturnType<typeof status>) => void;
    const held = new Promise<ReturnType<typeof status>>(resolve => { release = resolve; });
    const provider = { getStatus: vi.fn(async () => ++reads === 2 ? held : status(false)), setQuarantine: vi.fn(async () => status(true)) };
    const execution = runCopilotStudioQuarantineJob(job.id, value, false, repository, provider, authorize);
    await vi.waitFor(() => expect(reads).toBe(2));
    await repository.cancel(value, job.id);
    release(status(false));
    await execution;
    expect(provider.setQuarantine).not.toHaveBeenCalled();
    expect(await repository.get(value, job.id)).toMatchObject({ status: "cancelled", cancelled: 1 });
  });

  it("rejects provider timestamp drift before dispatch", async () => {
    const value = scope();
    const job = await submitted(value);
    const provider = { getStatus: vi.fn(async () => status(false, "2026-09-09T19:00:01Z")), setQuarantine: vi.fn(async () => status(true)) };
    await runCopilotStudioQuarantineJob(job.id, value, false, repository, provider, authorize);
    expect(provider.setQuarantine).not.toHaveBeenCalled();
    expect(await repository.get(value, job.id)).toMatchObject({ status: "failed", failed: 1, results: [{ errorCode: "quarantine_prestate_conflict" }] });
  });

  it("denies egress when exact-target qualification is revoked before dispatch", async () => {
    const value = scope();
    const job = await submitted(value);
    await fixture.operator.query("DELETE FROM copilot_quarantine_qualifications WHERE tenant_id=$1 AND target_environment_id=$2 AND target_bot_id=$3", [value.tenantId, environmentId, botId]);
    await fixture.operator.query(`INSERT INTO copilot_quarantine_qualifications
      (id,tenant_id,target_environment_id,target_bot_id,original_approval_id,restoration_approval_id,original_job_id,restoration_job_id,contract_revision,permission_revision,configuration_revision,auth_mode)
      VALUES(gen_random_uuid(),$1,$2,'99999999-9999-9999-9999-999999999999',gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),$3,$4,1,'delegated')`,
    [value.tenantId, environmentId, authority.contractRevision, authority.permissionRevision]);
    const provider = { getStatus: vi.fn(async () => status(false)), setQuarantine: vi.fn(async () => status(true)) };
    await runCopilotStudioQuarantineJob(job.id, value, false, repository, provider, authorize);
    expect(provider.getStatus).not.toHaveBeenCalled();
    expect(provider.setQuarantine).not.toHaveBeenCalled();
    expect(await repository.get(value, job.id)).toMatchObject({ status: "failed", results: [{ errorCode: "quarantine_write_unqualified" }] });
  });

  it("denies egress when the frozen target is absent from current private inventory", async () => {
    const value = scope();
    const job = await submitted(value);
    await fixture.operator.query("UPDATE power_platform_inventory_snapshots SET is_current=false WHERE id=(SELECT snapshot_id FROM copilot_quarantine_job_items WHERE job_id=$1)", [job.id]);
    const provider = { getStatus: vi.fn(async () => status(false)), setQuarantine: vi.fn(async () => status(true)) };
    await runCopilotStudioQuarantineJob(job.id, value, false, repository, provider, authorize);
    expect(provider.getStatus).not.toHaveBeenCalled();
    expect(provider.setQuarantine).not.toHaveBeenCalled();
    expect(await repository.get(value, job.id)).toMatchObject({ status: "failed", results: [{ errorCode: "quarantine_target_unavailable" }] });
  });

  it("blocks dispatch tenant-wide while another principal has an unresolved exact-target write", async () => {
    const firstScope = scope();
    const secondScope = scope(firstScope.tenantId);
    const uncertain = await submitted(firstScope);
    const blocked = await submitted(secondScope);
    const lease = await repository.claim(firstScope, uncertain.id, randomUUID());
    const current = await repository.beginItem(lease!);
    await repository.markSent(lease!, current!.item, authority);
    await repository.finishItem(lease!, current!.item, "inconclusive", { errorCode: "provider_error" });
    await repository.release(lease!);
    const provider = { getStatus: vi.fn(async () => status(false)), setQuarantine: vi.fn(async () => status(true)) };
    await runCopilotStudioQuarantineJob(blocked.id, secondScope, false, repository, provider, authorize);
    expect(provider.getStatus).not.toHaveBeenCalled();
    expect(provider.setQuarantine).not.toHaveBeenCalled();
    expect(await repository.get(secondScope, blocked.id)).toMatchObject({ status: "failed", results: [{ errorCode: "quarantine_reconciliation_required" }] });
  });

  it("never replays an uncertain sent write and reconciles with GET only", async () => {
    const value = scope();
    const job = await submitted(value);
    const provider = { getStatus: vi.fn(async () => status(false)), setQuarantine: vi.fn(async () => { throw new Error("connection lost"); }) };
    await runCopilotStudioQuarantineJob(job.id, value, false, repository, provider, authorize);
    expect(await repository.get(value, job.id)).toMatchObject({ status: "inconclusive", inconclusive: 1, canReconcile: true });
    await runCopilotStudioQuarantineJob(job.id, value, true, repository, provider, authorize);
    expect(provider.setQuarantine).toHaveBeenCalledTimes(1);
    const reconcileProvider = { getStatus: vi.fn(async () => status(false)) };
    const result = await reconcileCopilotStudioQuarantineJob(job.id, value, repository, reconcileProvider, authorize);
    expect(reconcileProvider.getStatus).toHaveBeenCalledTimes(1);
    expect(provider.setQuarantine).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ status: "partial", results: [{ reconciliationStatus: "verified_not_applied", retryEligible: true }], reconciliation: { attempted: 1, failed: 0 } });
  });

  it("does not reconcile by provider GET after the target leaves current private inventory", async () => {
    const value = scope();
    const job = await submitted(value);
    const provider = { getStatus: vi.fn(async () => status(false)), setQuarantine: vi.fn(async () => { throw new Error("connection lost"); }) };
    await runCopilotStudioQuarantineJob(job.id, value, false, repository, provider, authorize);
    await fixture.operator.query("UPDATE power_platform_inventory_snapshots SET is_current=false WHERE id=(SELECT snapshot_id FROM copilot_quarantine_job_items WHERE job_id=$1)", [job.id]);
    const reconcileProvider = { getStatus: vi.fn(async () => status(false)) };
    const result = await reconcileCopilotStudioQuarantineJob(job.id, value, repository, reconcileProvider, authorize);
    expect(reconcileProvider.getStatus).not.toHaveBeenCalled();
    expect(result).toMatchObject({ status: "inconclusive", reconciliation: { attempted: 1, failed: 1 } });
  });

  it("rejects stale lease dispatch before an external effect can start", async () => {
    const value = scope();
    const job = await submitted(value);
    const lease = await repository.claim(value, job.id, randomUUID());
    const current = await repository.beginItem(lease!);
    await fixture.operator.query("UPDATE copilot_quarantine_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1", [job.id]);
    await expect(repository.markSent(lease!, current!.item, authority)).rejects.toMatchObject({ code: "lease_lost" });
    expect((await fixture.operator.query("SELECT sent_at FROM copilot_quarantine_job_items WHERE id=$1", [current!.item.id])).rows).toEqual([{ sent_at: null }]);
  });

  it("does not dispatch after account revocation during the immediate GET", async () => {
    const value = scope();
    const job = await submitted(value);
    let reads = 0;
    let release!: (value: ReturnType<typeof status>) => void;
    const held = new Promise<ReturnType<typeof status>>(resolve => { release = resolve; });
    const provider = { getStatus: vi.fn(async () => ++reads === 2 ? held : status(false)), setQuarantine: vi.fn(async () => status(true)) };
    const execution = runCopilotStudioQuarantineJob(job.id, value, false, repository, provider, authorize);
    await vi.waitFor(() => expect(reads).toBe(2));
    await revokeAccountSessionMutations(value.tenantId, value.principalId, async () => undefined);
    release(status(false));
    await execution;
    expect(provider.setQuarantine).not.toHaveBeenCalled();
    expect(await repository.get(value, job.id)).toMatchObject({ status: "waiting_authorization", completed: 0, canResume: true });
  });

  it("does not publish success after account revocation during readback", async () => {
    const value = scope();
    const job = await submitted(value);
    let reads = 0;
    let release!: (value: ReturnType<typeof status>) => void;
    const held = new Promise<ReturnType<typeof status>>(resolve => { release = resolve; });
    const provider = {
      getStatus: vi.fn(async () => ++reads === 3 ? held : status(false)),
      setQuarantine: vi.fn(async () => status(true)),
    };
    const execution = runCopilotStudioQuarantineJob(job.id, value, false, repository, provider, authorize);
    await vi.waitFor(() => expect(reads).toBe(3));
    await revokeAccountSessionMutations(value.tenantId, value.principalId, async () => undefined);
    release(status(true, "2026-09-09T19:00:02Z"));
    await execution;
    expect(provider.setQuarantine).toHaveBeenCalledTimes(1);
    expect(await repository.get(value, job.id)).toMatchObject({ status: "inconclusive", succeeded: 0, inconclusive: 1 });
  });
});