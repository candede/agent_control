import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testDatabase } from "../../scripts/testDatabase.js";
import { createJobConfirmation, JobRepository, type JobInput, type JobIntentInput } from "./jobs.js";

let fixture: Awaited<ReturnType<typeof testDatabase>>;
let jobs: JobRepository;
const scope = { tenantId: "tenant-1", principalId: "principal-1" };
const input = (ids = ["package-1"]): JobInput => {
  const intent: JobIntentInput = { targets: ids.map(id => ({ id, displayName: id, prestate: { kind: "block", isBlocked: false } })), action: "block", scope: "bulk", actor: { tenantId: scope.tenantId, homeAccountId: scope.principalId, username: "fixture@example.invalid", displayName: "Fixture" }, requestPath: "/api/agents/block" };
  return { ...intent, idempotencyKey: randomUUID(), confirmationHash: createJobConfirmation(intent).confirmationHash };
};
beforeAll(async () => { fixture = await testDatabase(); jobs = new JobRepository(fixture.runtime); });
afterAll(async () => { await fixture?.close(); });

describe("Durable scoped jobs", () => {
  it("persists immutable scoped idempotency without leaking across tenants/principals", async () => {
    const request = input(); const job = await jobs.submit(scope, request);
    expect((await jobs.submit(scope, request)).id).toBe(job.id);
    expect((await fixture.runtime.query("SELECT agent_id,status,metadata FROM audit_events WHERE operation_id=$1", [job.id])).rows).toEqual([{
      agent_id: "package-1",
      status: "requested",
      metadata: expect.objectContaining({ confirmationHash: request.confirmationHash, prestateHash: expect.stringMatching(/^[a-f0-9]{64}$/), verification: "pending_dispatch" }),
    }]);
    const differentIntent = { ...request, targets: [{ id: "different", displayName: "different", prestate: { kind: "block" as const, isBlocked: false } }] };
    await expect(jobs.submit(scope, { ...differentIntent, confirmationHash: createJobConfirmation(differentIntent).confirmationHash })).rejects.toMatchObject({ code: "idempotency_mismatch" });
    expect(await jobs.get(job.id, { ...scope, principalId: "other" })).toBeUndefined();
    expect(await jobs.get(job.id, { ...scope, tenantId: "other" })).toBeUndefined();
    await expect(fixture.runtime.query("UPDATE jobs SET request_hash=repeat('a',64) WHERE id=$1", [job.id])).rejects.toThrow("immutable");
    await expect(fixture.runtime.query("UPDATE job_items SET prestate=jsonb_build_object('kind','block','isBlocked',true) WHERE job_id=$1", [job.id])).rejects.toThrow("immutable");
    await jobs.cancel(job.id, scope);
  });
  it("rejects stale confirmation hashes and duplicate targets before persistence", async () => {
    const stale = input();
    stale.targets[0].prestate = { kind: "block", isBlocked: true };
    await expect(jobs.submit(scope, stale)).rejects.toMatchObject({ code: "confirmation_mismatch" });
    const duplicate = input(["duplicate"]);
    duplicate.targets.push({ ...duplicate.targets[0] });
    await expect(jobs.submit(scope, duplicate)).rejects.toMatchObject({ code: "duplicate_target" });
  });
  it("compares the complete canonical route intent before returning an idempotent job", async () => {
    const intent: JobIntentInput = {
      action: "update-availability",
      targets: ["package-b", "package-a"].map(id => ({ id, displayName: id, prestate: { kind: "access" as const, availableTo: "none" as const, deployedTo: "none" as const, allowedUsersAndGroups: [], acquireUsersAndGroups: [] } })),
      accessUpdate: { target: "availability", mode: "replace", scope: "specific", principals: [{ resourceType: "user", resourceId: "12345678-1234-1234-1234-123456789abc" }] },
      scope: "bulk",
      actor: { tenantId: scope.tenantId, homeAccountId: scope.principalId, username: "fixture@example.invalid", displayName: "Fixture" },
      requestPath: "/api/agents/access",
    };
    const request = { ...intent, idempotencyKey: randomUUID(), confirmationHash: createJobConfirmation(intent).confirmationHash };
    const job = await jobs.submit(scope, request);
    const capability = "graph.package.access.manage";
    const unchanged = { action: intent.action, accessUpdate: intent.accessUpdate, requestPath: intent.requestPath, scope: intent.scope, targetIds: ["package-b", "package-a"] };
    expect((await jobs.getByIdempotency(scope, capability, request.idempotencyKey, unchanged))?.id).toBe(job.id);
    for (const changed of [
      { ...unchanged, action: "update-installation" as const },
      { ...unchanged, scope: "single" as const },
      { ...unchanged, requestPath: "/api/agents/package-a/access" },
      { ...unchanged, targetIds: ["package-a"] },
      { ...unchanged, accessUpdate: { ...intent.accessUpdate, target: "installation" as const } },
      { ...unchanged, accessUpdate: { ...intent.accessUpdate, principals: [{ resourceType: "group" as const, resourceId: "12345678-1234-1234-1234-123456789abc" }] } },
    ]) {
      await expect(jobs.getByIdempotency(scope, capability, request.idempotencyKey, changed)).rejects.toMatchObject({ code: "idempotency_mismatch" });
    }
    await jobs.cancel(job.id, scope);
  });
  it("allows only one competing lease and rejects expired result commits", async () => {
    const job = await jobs.submit(scope, input());
    const claims = await Promise.all([jobs.claim(job.id, scope, randomUUID()), jobs.claim(job.id, scope, randomUUID())]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    const lease = claims.find(Boolean)!; const work = (await jobs.beginItem(lease))!;
    await jobs.markSent(lease, work.item.id, work.item.prestate_hash);
    await fixture.operator.query("UPDATE jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1", [job.id]);
    await expect(jobs.finishItem(lease, work.item.id, "succeeded")).rejects.toMatchObject({ code: "lease_lost" });
    await jobs.recover(scope.tenantId);
    expect(await jobs.get(job.id, scope)).toMatchObject({ status: "partial", inconclusive: 1, canResume: false });
    expect(await jobs.claim(job.id, scope, randomUUID(), true)).toBeUndefined();
  });
  it("recovers unsent work to authorization wait and never replays success", async () => {
    const job = await jobs.submit(scope, input(["first", "second"]));
    let lease = (await jobs.claim(job.id, scope, randomUUID()))!;
    const first = (await jobs.beginItem(lease))!;
    await jobs.markSent(lease, first.item.id, first.item.prestate_hash);
    await jobs.finishItem(lease, first.item.id, "succeeded");
    await jobs.beginItem(lease);
    await fixture.operator.query("UPDATE jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1", [job.id]);
    await jobs.recover(scope.tenantId);
    expect(await jobs.get(job.id, scope)).toMatchObject({ status: "waiting_authorization", succeeded: 1 });
    expect(await jobs.claim(job.id, scope, randomUUID())).toBeUndefined();
    lease = (await jobs.claim(job.id, scope, randomUUID(), true))!;
    const second = (await jobs.beginItem(lease))!;
    expect(second.item.target_id).toBe("second");
    await jobs.finishItem(lease, second.item.id, "skipped");
    await jobs.release(lease);
    expect(await jobs.get(job.id, scope)).toMatchObject({ status: "succeeded", succeeded: 1, skipped: 1 });
  });
  it("cancels unsent items but preserves sent outcomes", async () => {
    const job = await jobs.submit(scope, input(["cancel-first", "cancel-second"]));
    const lease = (await jobs.claim(job.id, scope, randomUUID()))!;
    const work = (await jobs.beginItem(lease))!;
    await jobs.markSent(lease, work.item.id, work.item.prestate_hash);
    await jobs.cancel(job.id, scope);
    await jobs.finishItem(lease, work.item.id, "inconclusive");
    await jobs.release(lease);
    expect(await jobs.get(job.id, scope)).toMatchObject({ status: "partial", cancelled: 1, inconclusive: 1 });
  });
  it("denies admission and unsent dispatch in maintenance", async () => {
    const job = await jobs.submit(scope, input(["maintenance"]));
    const lease = (await jobs.claim(job.id, scope, randomUUID()))!;
    const work = (await jobs.beginItem(lease))!;
    process.env.MAINTENANCE_MODE = "true";
    try {
      await expect(jobs.submit(scope, input())).rejects.toMatchObject({ code: "maintenance" });
      await expect(jobs.markSent(lease, work.item.id, work.item.prestate_hash)).rejects.toMatchObject({ code: "maintenance" });
    } finally { delete process.env.MAINTENANCE_MODE; }
    await jobs.finishItem(lease, work.item.id, "cancelled");
    await jobs.cancel(job.id, scope);
    await jobs.release(lease);
  });

  it("enforces source identifier scope and job deadlines before dispatch", async () => {
    const job = await jobs.submit(scope, input(["bounded-package"]));
    const lease = (await jobs.claim(job.id, scope, randomUUID()))!;
    await fixture.operator.query("ALTER TABLE jobs DISABLE TRIGGER immutable_job_intent");
    try { await fixture.operator.query("UPDATE jobs SET deadline_at=clock_timestamp()-interval '1 second' WHERE id=$1", [job.id]); }
    finally { await fixture.operator.query("ALTER TABLE jobs ENABLE TRIGGER immutable_job_intent"); }
    expect(await jobs.beginItem(lease)).toBeUndefined();
    await jobs.release(lease);
    expect(await jobs.get(job.id, scope)).toMatchObject({status:"failed",failed:1});
    await expect(fixture.runtime.query("INSERT INTO source_identifiers(id,tenant_id,source,resource_type,native_id,identifier_kind,identifier_value) VALUES ($1,$2,'graph_packages','microsoft.graph/copilotpackages','bounded-package','package_id','bounded-package')",[randomUUID(),scope.tenantId])).rejects.toThrow("duplicate");
    await fixture.runtime.query("INSERT INTO source_identifiers(id,tenant_id,source,resource_type,native_id,identifier_kind,identifier_value) VALUES ($1,'other-tenant','graph_packages','microsoft.graph/copilotpackages','bounded-package','package_id','bounded-package')",[randomUUID()]);
    await fixture.runtime.query("INSERT INTO source_identifiers(id,tenant_id,source,resource_type,environment_id,native_id,identifier_kind,identifier_value) VALUES ($1,$2,'graph_packages','microsoft.graph/copilotpackages','different-environment','bounded-package','package_id','bounded-package')",[randomUUID(),scope.tenantId]);
  });

  it("keeps unfinished dispatched attempts recoverable when result persistence fails", async () => {
    const job = await jobs.submit(scope, input(["commit-failure"]));
    const lease = (await jobs.claim(job.id,scope,randomUUID()))!;
    const item = (await jobs.beginItem(lease))!.item;
    await jobs.markSent(lease,item.id,item.prestate_hash);
    await jobs.release(lease);
    expect(await jobs.get(job.id,scope)).toMatchObject({status:"running"});
    await fixture.operator.query("UPDATE jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",[job.id]);
    await jobs.recover(scope.tenantId);
    expect(await jobs.get(job.id,scope)).toMatchObject({status:"partial",inconclusive:1});
  });

  it("does not advertise or execute resume after exhausting the claim budget", async () => {
    const job = await jobs.submit(scope,input(["attempt-budget"]));
    await fixture.operator.query("UPDATE jobs SET attempts=10,status='waiting_authorization' WHERE id=$1",[job.id]);
    expect(await jobs.get(job.id,scope)).toMatchObject({canResume:false});
    expect(await jobs.claim(job.id,scope,randomUUID(),true)).toBeUndefined();
    await jobs.recover(scope.tenantId);
    expect(await jobs.get(job.id,scope)).toMatchObject({status:"failed",failed:1,canResume:false});
  });
});