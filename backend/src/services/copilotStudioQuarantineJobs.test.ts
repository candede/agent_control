import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { testDatabase } from "../../scripts/testDatabase.js";
import { CopilotStudioQuarantineCanaryRepository } from "../db/copilotStudioQuarantineCanaries.js";
import { CopilotStudioQuarantineRepository, createQuarantineConfirmation, type QuarantineScope } from "../db/copilotStudioQuarantine.js";
import { activateAccountSession, revokeAccountSessionMutations } from "../db/sessions.js";
import { AppError } from "../errors.js";
import type { FrozenQuarantineTarget, QuarantineAction, QuarantineActor, QuarantineAuthority } from "../types/copilotStudioQuarantine.js";
import {
  cancelCopilotStudioQuarantineJob,
  copilotStudioQuarantineJobs,
  pauseCopilotStudioQuarantineForPrincipal,
  reconcileCopilotStudioQuarantineJob,
  runCopilotStudioQuarantineJob,
  runTrackedCopilotStudioQuarantineJob,
} from "./copilotStudioQuarantineJobs.js";
import { loadOperationalState } from "./operationalState.js";
import { capabilities } from "./capabilities.js";

let fixture: Awaited<ReturnType<typeof testDatabase>>;
let repository: CopilotStudioQuarantineRepository;
const authority: QuarantineAuthority = { contractRevision: "a".repeat(64), permissionRevision: "b".repeat(64), configurationRevision: 1 };
const environmentId = "11111111-1111-4111-8111-111111111111";
const botId = "22222222-2222-4222-8222-222222222222";
const updatedAt = "2026-09-09T19:00:00.1234567Z";

beforeAll(async () => { fixture = await testDatabase(); repository = new CopilotStudioQuarantineRepository(fixture.runtime); });
beforeEach(() => { vi.spyOn(capabilities, "observeOperation").mockImplementation(async (_id, _user, operation) => operation(() => undefined)); });
afterEach(() => vi.restoreAllMocks());
afterAll(async () => { await fixture?.close(); });

function scope(tenantId = `fixture-tenant-${randomUUID()}`): QuarantineScope { return { tenantId, principalId: randomUUID() }; }
function actor(value: QuarantineScope): QuarantineActor { return { tenantId: value.tenantId, homeAccountId: value.principalId, displayName: "Operator", username: "operator@example.invalid" }; }
function target(snapshotId: string, state = false): FrozenQuarantineTarget {
  return { resourceNativeId: "native-agent", displayName: "Canary agent", snapshotId,
    inventoryObservedAt: new Date().toISOString(), inventoryExpiresAt: new Date(Date.now() + 60_000).toISOString(), inventoryQuarantineState: false,
    inventoryQuarantinedAt: null, environmentId, botId, directStatus: { environmentId, botId, isBotQuarantined: state,
      lastUpdateTimeUtc: updatedAt, observedAt: new Date().toISOString(), correlationId: "44444444-4444-4444-8444-444444444444" } };
}
async function submitted(value: QuarantineScope, action: QuarantineAction = "quarantine") {
  const snapshotId = await seedInventory(value);
  const input = { action, targets: [target(snapshotId, action === "unquarantine")], actor: actor(value), authority, requestPath: "/api/quarantine/jobs" };
  const confirmation = createQuarantineConfirmation(input);
  return repository.submit(value, { ...input, idempotencyKey: randomUUID(), confirmationHash: confirmation.confirmationHash });
}

async function seedInventory(value: QuarantineScope, descriptors = [{ resourceNativeId: "native-agent", botId }]) {
  const job = await fixture.operator.query<{ id: string }>(`INSERT INTO power_platform_refresh_jobs
    (id,tenant_id,principal_id,idempotency_key,request_hash,role_scope,requested_types,status)
    VALUES(gen_random_uuid(),$1,$2,$3,repeat('c',64),'full','["microsoft.copilotstudio/agents"]','succeeded') RETURNING id`,
  [value.tenantId, value.principalId, `inventory-${randomUUID()}`]);
  const snapshot = await fixture.operator.query<{ id: string }>(`INSERT INTO power_platform_inventory_snapshots
    (id,job_id,tenant_id,principal_id,query_hash,role_scope,requested_types,queried_types,observed_count,total_records,page_count,unknown_field_count)
    VALUES(gen_random_uuid(),$1,$2,$3,repeat('d',64),'full','["microsoft.copilotstudio/agents"]',$4,$5,$5,1,0) RETURNING id`,
  [job.rows[0].id, value.tenantId, value.principalId, JSON.stringify(["microsoft.copilotstudio/agents"]), descriptors.length]);
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
      timestamp: expect.any(String), level: "error",
      event: "quarantine_write_uncertain", jobId: job.id, outcome: "requires_reconciliation",
    });
  });

  it.each([
    new DOMException("synthetic deadline", "TimeoutError"),
    new AppError(504, "provider_timeout", "synthetic provider deadline"),
  ])("emits a redacted stopped event when the finite item deadline expires before dispatch (%s)", async error => {
    const value=scope();
    const job=await submitted(value);
    const log=vi.spyOn(console,"error").mockImplementation(() => undefined);
    const provider = {
      getStatus: vi.fn(async () => { throw error; }),
      setQuarantine: vi.fn(async () => status(true)),
    };
    await runCopilotStudioQuarantineJob(job.id,value,false,repository,provider,authorize);
    expect(await repository.get(value,job.id)).toMatchObject({ status: "failed", failed: 1 });
    expect(provider.setQuarantine).not.toHaveBeenCalled();
    expect(log.mock.calls.map(([entry]) => JSON.parse(entry))).toContainEqual({
      timestamp: expect.any(String), level: "error",
      event: "quarantine_job_stopped", jobId: job.id, outcome: "deadline_exceeded",
    });
  });

  it.each(["quarantine", "unquarantine"] as const)("dispatches normal %s without qualification, persisting sent before one POST and verifying GET readback", async action => {
    const value = scope();
    const job = await submitted(value, action);
    expect(job.isCanary).toBe(false);
    expect(await repository.isQualified(value, authority, [{ environmentId, botId }])).toBe(false);
    let quarantined = action === "unquarantine";
    const requestedState = !quarantined;
    const authorized = vi.fn(authorize);
    const provider = {
      getStatus: vi.fn(async () => status(quarantined)),
      setQuarantine: vi.fn(async () => {
        const sent = await fixture.runtime.query("SELECT 1 FROM copilot_quarantine_job_items WHERE job_id=$1 AND sent_at IS NOT NULL", [job.id]);
        expect(sent.rowCount).toBe(1);
        quarantined = requestedState;
        return status(requestedState);
      }),
    };
    await runCopilotStudioQuarantineJob(job.id, value, false, repository, provider, authorized);
    expect(provider.setQuarantine).toHaveBeenCalledTimes(1);
    expect(provider.setQuarantine).toHaveBeenCalledWith("ephemeral-token", { environmentId, botId }, requestedState, expect.objectContaining({ correlationId: expect.any(String) }));
    expect(provider.getStatus).toHaveBeenCalledTimes(3);
    expect(await repository.get(value, job.id)).toMatchObject({ status: "succeeded", succeeded: 1 });
    expect(authorized).toHaveBeenCalledWith(value);
    expect(await repository.isQualified(value, authority, [{ environmentId, botId }])).toBe(false);
    const audit = (await repository.listAudit(value)).value.filter(event => event.jobId === job.id);
    expect(audit.map(event => event.phase).sort()).toEqual(["requested", "sent", "started", "succeeded"]);
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

  it.each(["current", "expired"] as const)("rechecks the actual %s approval for an explicit canary job at final dispatch", async approvalState => {
    const value = scope();
    const snapshotId = await seedInventory(value);
    const frozen = target(snapshotId);
    const canaries = new CopilotStudioQuarantineCanaryRepository(fixture.runtime);
    const operator = { ...actor(value), roles: ["AgentControl.Admin" as const] };
    const administrator = { ...operator, homeAccountId: randomUUID() };
    const original = await canaries.createApproved(administrator, {
      target: frozen, action: "quarantine", prestate: false, prestateProviderUpdatedAt: updatedAt, poststate: true, authority,
    });
    const restoration = await canaries.createApproved(administrator, {
      target: frozen, action: "unquarantine", prestate: true, prestateProviderUpdatedAt: null, poststate: false, authority,
    });
    await canaries.claimCycle(operator, original.id, restoration.id, authority);
    const input = { action: "quarantine" as const, targets: [frozen], actor: actor(value), authority,
      requestPath: "/api/quarantine/canary-approvals/execute", canaryApprovalId: original.id };
    const job = await repository.submit(value, { ...input, idempotencyKey: randomUUID(), confirmationHash: createQuarantineConfirmation(input).confirmationHash });
    expect(job.isCanary).toBe(true);
    let reads = 0;
    let quarantined = false;
    const provider = {
      getStatus: vi.fn(async () => {
        if (++reads === 2 && approvalState === "expired") await fixture.operator.query("UPDATE copilot_quarantine_canary_approvals SET status='expired' WHERE id=$1", [original.id]);
        return status(quarantined);
      }),
      setQuarantine: vi.fn(async () => { quarantined = true; return status(true); }),
    };
    await runCopilotStudioQuarantineJob(job.id, value, false, repository, provider, authorize);
    if (approvalState === "current") {
      expect(provider.getStatus).toHaveBeenCalledTimes(3);
      expect(provider.setQuarantine).toHaveBeenCalledTimes(1);
      expect(await repository.get(value, job.id)).toMatchObject({ status: "succeeded", succeeded: 1 });
    } else {
      expect(provider.getStatus).toHaveBeenCalledTimes(2);
      expect(provider.setQuarantine).not.toHaveBeenCalled();
      expect(await repository.get(value, job.id)).toMatchObject({ status: "waiting_authorization", completed: 0, canResume: true });
      expect((await fixture.operator.query("SELECT sent_at FROM copilot_quarantine_job_items WHERE job_id=$1", [job.id])).rows).toEqual([{ sent_at: null }]);
    }
    expect(await repository.isQualified(value, authority, [frozen])).toBe(false);
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

  it.each(["maintenance", "provider_requalification_required"] as const)(
    "stops quarantine execution at admission boundaries when %s applies",
    async errorCode => {
      for (const stage of ["start", "authorization", "lock", "pre-read", "immediate", "immediate-no-op", "sent", "post", "readback", "readback-retry", "publication", "no-op"] as const) {
        const value = scope();
        const job = await submitted(value);
        const closeAdmissions = async () => {
          if (errorCode === "maintenance") vi.stubEnv("MAINTENANCE_MODE", "true");
          else {
            await fixture.operator.query("UPDATE operational_state SET provider_work_enabled=false WHERE singleton=true");
            await loadOperationalState(fixture.runtime);
          }
        };
        let reads = 0;
        const provider = {
          getStatus: vi.fn(async () => {
            reads += 1;
            if (stage === "pre-read" && reads === 1 || (stage === "immediate" || stage === "immediate-no-op") && reads === 2
              || (stage === "readback" || stage === "readback-retry") && reads === 3) await closeAdmissions();
            return status(stage === "no-op" || stage === "immediate-no-op" && reads === 2 || reads >= 3 && stage !== "readback-retry");
          }),
          setQuarantine: vi.fn(async () => {
            if (stage === "post") await closeAdmissions();
            return status(true);
          }),
        };
        const lock = repository.withTargetLock.bind(repository);
        vi.spyOn(repository, "withTargetLock").mockImplementation((lease, item, operation) => lock(lease, item, async () => {
          if (stage === "lock") await closeAdmissions();
          return operation();
        }));
        const markSent = repository.markSent.bind(repository);
        vi.spyOn(repository, "markSent").mockImplementation(async (...args) => {
          await markSent(...args);
          if (stage === "sent") await closeAdmissions();
        });
        let authorizations = 0;
        const authorized = vi.fn(async () => {
          authorizations += 1;
          if (stage === "authorization" && authorizations === 2 || stage === "publication" && authorizations === 4
            || stage === "no-op" && authorizations === 3) await closeAdmissions();
          return authorize();
        });
        try {
          if (stage === "start") await closeAdmissions();
          const execution = runCopilotStudioQuarantineJob(job.id, value, false, repository, provider, authorized);
          if (stage === "start") {
            await expect(execution, stage).rejects.toMatchObject({ code: errorCode });
            expect(authorized).not.toHaveBeenCalled();
            expect(await repository.get(value, job.id)).toMatchObject({ status: "queued", completed: 0 });
          } else {
            await execution;
            const sent = ["sent", "post", "readback", "readback-retry", "publication"].includes(stage);
            expect(await repository.get(value, job.id), stage).toMatchObject(sent
              ? { status: "inconclusive", succeeded: 0, inconclusive: 1, canReconcile: true }
              : { status: "waiting_authorization", completed: 0, canResume: true });
          }
          expect(provider.setQuarantine, stage).toHaveBeenCalledTimes(["post", "readback", "readback-retry", "publication"].includes(stage) ? 1 : 0);
          expect(reads, stage).toBe(["readback", "readback-retry", "publication"].includes(stage) ? 3
            : ["immediate", "immediate-no-op", "sent", "post"].includes(stage) ? 2 : ["pre-read", "no-op"].includes(stage) ? 1 : 0);
        } finally {
          vi.unstubAllEnvs();
          await fixture.operator.query("UPDATE operational_state SET provider_work_enabled=true WHERE singleton=true");
          await loadOperationalState(fixture.runtime);
          vi.restoreAllMocks();
        }
      }
    },
  );

  it.each(["maintenance", "provider_requalification_required"] as const)(
    "stops quarantine reconciliation at every admission boundary when %s applies",
    async errorCode => {
      for (const stage of ["start", "authorization", "lock", "readback", "publication", "next-item"] as const) {
        const value = scope();
        const descriptors = Array.from({ length: stage === "next-item" ? 2 : 1 }, (_, index) => ({
          resourceNativeId: `native-agent-${index}`, botId: `${index + 3}2222222-2222-4222-8222-222222222222`,
        }));
        const snapshotId = await seedInventory(value, descriptors);
        const targets = descriptors.map(descriptor => {
          const original = target(snapshotId);
          return { ...original, ...descriptor, directStatus: { ...original.directStatus, botId: descriptor.botId } };
        });
        const input = { action: "quarantine" as const, targets, actor: actor(value), authority, requestPath: "/api/quarantine/jobs" };
        const job = await repository.submit(value, { ...input, idempotencyKey: randomUUID(), confirmationHash: createQuarantineConfirmation(input).confirmationHash });
        const provider = {
          getStatus: vi.fn(async (_token: string, selected: { environmentId: string; botId: string }) => ({ ...status(false), ...selected })),
          setQuarantine: vi.fn(async () => { throw new Error("uncertain write"); }),
        };
        await runCopilotStudioQuarantineJob(job.id, value, false, repository, provider, authorize);
        const closeAdmissions = async () => {
          if (errorCode === "maintenance") vi.stubEnv("MAINTENANCE_MODE", "true");
          else {
            await fixture.operator.query("UPDATE operational_state SET provider_work_enabled=false WHERE singleton=true");
            await loadOperationalState(fixture.runtime);
          }
        };
        const read = provider.getStatus.mockImplementation(async (_token, selected) => {
          if (stage === "readback") await closeAdmissions();
          return { ...status(false), ...selected };
        }).mockClear();
        const lock = repository.withReconciliationLock.bind(repository);
        vi.spyOn(repository, "withReconciliationLock").mockImplementation((owner, item, operation) => lock(owner, item, async () => {
          if (stage === "lock") await closeAdmissions();
          return operation();
        }));
        const record = repository.recordReconciliation.bind(repository);
        const publications = vi.spyOn(repository, "recordReconciliation").mockImplementation(async (...args) => {
          await record(...args);
          if (stage === "next-item") await closeAdmissions();
        });
        let authorizations = 0;
        const authorized = vi.fn(async () => {
          authorizations += 1;
          if (stage === "authorization" && authorizations === 1 || stage === "publication" && authorizations === 2) await closeAdmissions();
          return authorize();
        });
        try {
          if (stage === "start") await closeAdmissions();
          await expect(reconcileCopilotStudioQuarantineJob(job.id, value, repository, provider, authorized), stage).rejects.toMatchObject({ code: errorCode });
          expect(publications, stage).toHaveBeenCalledTimes(stage === "next-item" ? 1 : 0);
          expect(read, stage).toHaveBeenCalledTimes(["readback", "publication", "next-item"].includes(stage) ? 1 : 0);
          expect(authorized, stage).toHaveBeenCalledTimes(stage === "start" ? 0 : ["publication", "next-item"].includes(stage) ? 2 : 1);
          expect((await repository.get(value, job.id))?.results.filter(item => item.reconciliationStatus === "required"), stage).toHaveLength(1);
        } finally {
          vi.unstubAllEnvs();
          await fixture.operator.query("UPDATE operational_state SET provider_work_enabled=true WHERE singleton=true");
          await loadOperationalState(fixture.runtime);
          vi.restoreAllMocks();
        }
        provider.getStatus.mockImplementation(async (_token, selected) => ({ ...status(false), ...selected }));
        const reconciled = await reconcileCopilotStudioQuarantineJob(job.id, value, repository, provider, authorize);
        expect(reconciled.reconciliation, stage).toMatchObject({ attempted: 1, failed: 0 });
        expect(provider.setQuarantine).toHaveBeenCalledTimes(descriptors.length);
      }
    },
  );

  it.each([0, 1, 2, 3])("preserves recoverable item state when logout interrupts execution boundary %s", async heldRead => {
    const value = scope();
    const job = await submitted(value);
    let release!: (value: ReturnType<typeof status>) => void;
    const held = new Promise<ReturnType<typeof status>>(resolve => { release = resolve; });
    let reads = 0;
    let quarantined = false;
    const provider = {
      getStatus: vi.fn(async () => ++reads === heldRead ? held : status(quarantined)),
      setQuarantine: vi.fn(async () => { quarantined = true; return status(true); }),
    };
    vi.spyOn(copilotStudioQuarantineJobs, "waitForAuthorization").mockImplementation((...args) => repository.waitForAuthorization(...args));
    let authorizations = 0;
    const execution = runTrackedCopilotStudioQuarantineJob(job.id, value, repository, provider, async () => {
      if (++authorizations === 2 && heldRead === 0) await held;
      return authorize();
    });
    const outcome = execution.then(() => ({ error: undefined }), (error: unknown) => ({ error }));
    try {
      await vi.waitFor(() => expect(heldRead === 0 ? authorizations : reads).toBe(heldRead === 0 ? 2 : heldRead));
      await revokeAccountSessionMutations(value.tenantId, value.principalId, () => pauseCopilotStudioQuarantineForPrincipal(value));
    } finally {
      release(status(quarantined));
    }
    expect((await outcome).error).toBeUndefined();
    const result = await repository.get(value, job.id);
    expect(result).toMatchObject(heldRead === 3
      ? { status: "inconclusive", succeeded: 0, inconclusive: 1, canReconcile: true }
      : { status: "waiting_authorization", completed: 0, canResume: true });
    expect(provider.setQuarantine).toHaveBeenCalledTimes(heldRead === 3 ? 1 : 0);
    await repository.recoverInterrupted(true);
    expect(await repository.get(value, job.id)).toEqual(result);
    if (heldRead !== 3) {
      await activateAccountSession(value.tenantId, value.principalId, async () => undefined);
      await runCopilotStudioQuarantineJob(job.id, value, true, repository, provider, authorize);
      expect(await repository.get(value, job.id)).toMatchObject({ status: "succeeded", succeeded: 1 });
      expect(provider.setQuarantine).toHaveBeenCalledTimes(1);
    }
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