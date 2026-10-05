import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testDatabase } from "../../scripts/testDatabase.js";
import { nativeInventoryFixture, reconcileInventoryFixture, refreshInventoryFixture } from "../../scripts/inventoryFixtures.js";
import { powerPlatformResourceTypes } from "../types/powerPlatformInventory.js";
import { unifiedAgentRecordId } from "../types/unifiedAgents.js";
import { PowerPlatformRefreshJobs } from "./powerPlatformRefreshJobs.js";
import { LiveInventory } from "./liveInventory.js";

let fixture: Awaited<ReturnType<typeof testDatabase>>;
beforeAll(async () => { fixture = await testDatabase(); });
afterAll(async () => { await fixture?.close(); });
const agentType = "microsoft.copilotstudio/agents";
const environmentId = "11111111-1111-4111-8111-111111111111";
const nativeId = "native-a", botId = "22222222-2222-4222-8222-222222222222";
const recordId = unifiedAgentRecordId({ source: "power_platform", nativeId, environmentId });
const owner = () => ({ tenantId: "native-current-contract", principalId: randomUUID() });
const resource = (displayName = "Native agent") => ({
  nativeId, environmentId, displayName, identifiers: [{ kind: "cds_bot_id" as const, value: botId }],
});

describe("current typed inventory identity reads", () => {
  it("uses one repeatable-read client and evaluated time for exact membership and bounded identity candidates", async () => {
    const scope = owner(), live = new LiveInventory(fixture.runtime);
    await nativeInventoryFixture(fixture.runtime, scope, [resource()]);
    await reconcileInventoryFixture(fixture.runtime, scope);
    await live.withRead(async read => {
      expect((await read.client.query("SHOW transaction_isolation")).rows[0].transaction_isolation).toBe("repeatable read");
      const record = await live.record(scope, recordId, read);
      const candidates = await live.identityCandidates(scope, record, read);
      expect(candidates).toEqual([expect.objectContaining({ tenantId: scope.tenantId, nativeId, environmentId,
        identifiers: [{ kind: "cds_bot_id", value: botId }] })]);
      expect(candidates.length).toBeLessThanOrEqual(6);
    });
    await expect(live.record({ ...scope, principalId: randomUUID() }, recordId)).rejects.toMatchObject({ code: "agent_not_found" });
    await expect(live.record({ ...scope, tenantId: "other-tenant" }, recordId)).rejects.toMatchObject({ code: "agent_not_found" });
  });

  it.each(["replace", "withdraw"] as const)("does not mix snapshots when another transaction performs a %s", async change => {
    const scope = owner(), live = new LiveInventory(fixture.runtime);
    await nativeInventoryFixture(fixture.runtime, scope, [resource("Before")]);
    await reconcileInventoryFixture(fixture.runtime, scope);
    let release!: () => void, entered!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
    const pending = live.withRead(async read => {
      const first = await live.record(scope, recordId, read);
      entered();
      await barrier;
      const second = await live.record(scope, recordId, read);
      expect(second).toEqual(first);
      return first;
    });
    await started;
    try {
      await nativeInventoryFixture(fixture.runtime, scope, change === "replace" ? [resource("After")] : [], { resourceTypes: [agentType] });
      await reconcileInventoryFixture(fixture.runtime, scope);
    } finally { release(); }
    const before = await pending;
    expect(before.displayName).toBe("Before");
    if (change === "replace") expect((await live.record(scope, recordId)).displayName).toBe("After");
    else await expect(live.record(scope, recordId)).rejects.toMatchObject({ code: "agent_not_found" });
    await expect(live.assertCurrent(scope, before.id, before.revision)).rejects.toMatchObject({ code: "inventory_changed" });
  });

  it("fences genuinely expired live authority even inside an already-open repeatable-read transaction", async () => {
    const scope = owner(), live = new LiveInventory(fixture.runtime), expiresAt = new Date(Date.now() + 1500);
    await nativeInventoryFixture(fixture.runtime, scope, [resource()], { expiresAt });
    await reconcileInventoryFixture(fixture.runtime, scope);
    const before = await live.withRead(async read => {
      const record = await live.record(scope, recordId, read);
      await new Promise(resolve => setTimeout(resolve, Math.max(0, expiresAt.getTime() - Date.now()) + 20));
      await expect(live.record(scope, recordId, read)).rejects.toMatchObject({ code: "agent_not_found" });
      return record;
    });
    await expect(live.record(scope, recordId)).rejects.toMatchObject({ code: "agent_not_found" });
    await expect(live.assertCurrent(scope, before.id, before.revision)).rejects.toMatchObject({ code: "inventory_changed" });
  });

  it("propagates errors from the selected transaction without a secondary query or fallback", async () => {
    const failure = new Error("synthetic-selected-read-failure");
    await expect(new LiveInventory(fixture.runtime).withRead(async () => { throw failure; })).rejects.toBe(failure);
  });
});

describe("active native refresh request identity", () => {
  it.each(["full", "ai", "unknown"] as const)("replays a retained %s request without treating a new role hint as new query authority", async roleScope => {
    const scope = owner(), jobs = new PowerPlatformRefreshJobs(fixture.runtime);
    const first = await jobs.submit(scope, { idempotencyKey: "retained", roleScope, requestedTypes: powerPlatformResourceTypes });
    const next = await jobs.submit(scope, { idempotencyKey: "retained", roleScope: roleScope === "full" ? "ai" : "full",
      requestedTypes: [...powerPlatformResourceTypes].reverse() });
    expect(next).toMatchObject({ id: first.id, roleScope });
    expect((await jobs.listJobs(scope)).value).toHaveLength(1);
    expect(await jobs.getJob({ ...scope, principalId: randomUUID() }, first.id)).toBeUndefined();
  });

  it.each([
    { environmentScope: environmentId, requestedTypes: powerPlatformResourceTypes },
    { requestedTypes: [agentType] as const },
  ])("rejects an idempotent replay with a different executed scope: %j", async input => {
    const scope = owner(), jobs = new PowerPlatformRefreshJobs(fixture.runtime);
    await jobs.submit(scope, { idempotencyKey: "retained", roleScope: "full", requestedTypes: powerPlatformResourceTypes });
    await expect(jobs.submit(scope, { idempotencyKey: "retained", roleScope: "unknown", ...input }))
      .rejects.toMatchObject({ code: "idempotency_mismatch" });
    expect((await jobs.listJobs(scope)).value).toHaveLength(1);
  });

  it("refuses an expired retained job instead of returning an accepted undefined job", async () => {
    const scope = owner(), jobs = new PowerPlatformRefreshJobs(fixture.runtime);
    const job = await jobs.submit(scope, { idempotencyKey: "retained", roleScope: "full", requestedTypes: powerPlatformResourceTypes });
    await fixture.operator.query(`UPDATE power_platform_refresh_jobs SET created_at=clock_timestamp()-interval '2 days',
      expires_at=clock_timestamp()-interval '1 second' WHERE id=$1`, [job.id]);
    await expect(jobs.submit(scope, { idempotencyKey: "retained", roleScope: "full", requestedTypes: powerPlatformResourceTypes }))
      .rejects.toMatchObject({ code: "inventory_job_expired" });
  });

  it("uses one role-independent query hash for newly admitted equivalent requests", async () => {
    const scope = owner(), jobs = new PowerPlatformRefreshJobs(fixture.runtime);
    for (const roleScope of ["full", "ai", "unknown"] as const) {
      await jobs.submit(scope, { idempotencyKey: roleScope, roleScope, requestedTypes: powerPlatformResourceTypes });
    }
    expect((await fixture.runtime.query(`SELECT request_hash FROM power_platform_refresh_jobs
      WHERE tenant_id=$1 AND principal_id=$2 GROUP BY request_hash`, [scope.tenantId, scope.principalId])).rows).toHaveLength(1);
  });

  it.each(["full", "ai", "unknown"] as const)("publishes one current root across %s role hints with atomic metadata-only jobs", async roleScope => {
    const scope = owner(), jobs = new PowerPlatformRefreshJobs(fixture.runtime);
    const first = await jobs.submit(scope, { idempotencyKey: "first", roleScope, requestedTypes: powerPlatformResourceTypes });
    expect(await jobs.markRunning(scope, first.id)).toBe(true);
    await refreshInventoryFixture(fixture.runtime, scope, first.id, "power_platform", [], [...powerPlatformResourceTypes]);
    const second = await jobs.submit(scope, { idempotencyKey: "second", roleScope: "unknown", requestedTypes: powerPlatformResourceTypes });
    expect(await jobs.markRunning(scope, second.id)).toBe(true);
    const root = await refreshInventoryFixture(fixture.runtime, scope, second.id, "power_platform", [], [...powerPlatformResourceTypes]);
    expect(await jobs.getJob(scope, second.id)).toMatchObject({ status: "succeeded", snapshotId: root.baselineId });
    expect((await fixture.runtime.query(`SELECT r.baseline_id FROM inventory_roots r JOIN data_scope_epochs s ON s.id=r.scope_id
      WHERE r.current AND r.domain='power_platform' AND s.tenant_id=$1 AND s.principal_id=$2`, [scope.tenantId, scope.principalId])).rows)
      .toEqual([{ baseline_id: root.baselineId }]);
    const list = await jobs.listJobs(scope);
    expect(list.value).toHaveLength(2);
    expect(JSON.stringify(list)).not.toContain('"resources"');
    expect(Buffer.byteLength(JSON.stringify(list))).toBeLessThan(4096);
  });
});
