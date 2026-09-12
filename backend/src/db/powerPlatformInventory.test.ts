import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { retain } from "../../scripts/database.js";
import { testDatabase } from "../../scripts/testDatabase.js";
import { powerPlatformResourceTypes, type PowerPlatformResource } from "../types/powerPlatformInventory.js";
import { buildCoverage, PowerPlatformInventoryRepository } from "./powerPlatformInventory.js";

let fixture: Awaited<ReturnType<typeof testDatabase>>;
let repository: PowerPlatformInventoryRepository;
const scope = { tenantId: "tenant-a", principalId: "principal-a" };

beforeAll(async () => { fixture = await testDatabase(); repository = new PowerPlatformInventoryRepository(fixture.runtime); });
afterAll(async () => { await fixture?.close(); });

function resource(nativeId: string, overrides: Partial<PowerPlatformResource> = {}): PowerPlatformResource {
  return {
    tenantId: scope.tenantId,
    nativeId,
    type: "microsoft.copilotstudio/agents",
    location: "unitedstates",
    displayName: nativeId,
    environmentId: "environment-a",
    createdAt: "2026-09-08T10:00:00.000Z",
    createdBy: null,
    lastPublishedAt: null,
    sourceSystem: "power_platform",
    authoringTool: "Copilot Studio",
    creatorType: "unknown",
    agentKind: "copilot_studio_agent",
    lifecycle: "draft",
    identityConfidence: "exact_native",
    identifiers: [{ kind: "power_platform_resource_id", value: nativeId }, { kind: "cds_bot_id", value: `bot-${nativeId}` }],
    provenance: { sourceSystem: { sourceSystem: "power_platform", path: "PowerPlatformResources", maturity: "ga" } },
    details: {},
    unknownFieldCount: 0,
    ...overrides,
  };
}

async function submitAndRun(idempotencyKey: string, roleScope: "full" | "ai" | "unknown" = "full", requestedTypes = powerPlatformResourceTypes) {
  const job = await repository.submit(scope, { idempotencyKey, roleScope, requestedTypes });
  expect(await repository.markRunning(scope, job.id)).toBe(true);
  return job.id;
}

describe.sequential("Power Platform inventory repository", () => {
  it("cancels only the owning principal's unfinished read job", async () => {
    const job = await repository.submit(scope, { idempotencyKey: "inventory-cancel", roleScope: "full", requestedTypes: ["microsoft.copilotstudio/agents"] });
    expect(await repository.cancel({ ...scope, principalId: "principal-b" }, job.id)).toBeUndefined();
    expect(await repository.cancel(scope, job.id)).toMatchObject({ status: "cancelled", errorCode: "cancelled" });
  });

  it("publishes complete snapshots atomically and filters private scope before counts and paging", async () => {
    const id = await submitAndRun("broad-a");
    await repository.publish(scope, id, { resources: [resource("agent-b"), resource("agent-a")], totalRecords: 2, pages: 2, unknownFieldCount: 1 });
    const page = await repository.list(scope, { search: "agent", sortBy: "displayName", limit: 1 });
    expect(page).toMatchObject({ count: 2, value: [{ nativeId: "agent-a" }], snapshot: { observedCount: 2, pageCount: 2 } });
    expect(page.typeCounts.find(value => value.type === "microsoft.copilotstudio/agents")).toMatchObject({ status: "covered", count: 2 });
    expect(await repository.list({ ...scope, principalId: "principal-b" })).toMatchObject({ count: 0, value: [], snapshot: null });
    expect((await fixture.runtime.query("SELECT count(*)::int AS count FROM source_identifiers WHERE source='power_platform'")).rows[0].count).toBe(4);
  });

  it("keeps a broad snapshot current when a narrower scan publishes", async () => {
    const id = await submitAndRun("narrow-a", "full", ["microsoft.copilotstudio/agents"]);
    await repository.publish(scope, id, { resources: [resource("agent-c")], totalRecords: 1, pages: 1, unknownFieldCount: 0 });
    expect((await repository.list(scope)).value.map(value => value.nativeId)).toEqual(["agent-a", "agent-b"]);
    const narrowSnapshot = (await repository.getJob(scope, id))!.snapshotId!;
    expect((await repository.list(scope, { snapshotId: narrowSnapshot })).value.map(value => value.nativeId)).toEqual(["agent-c"]);
    expect((await repository.listSnapshots(scope)).value.map(value => value.id)).toContain(narrowSnapshot);
    expect((await repository.listJobs(scope)).value[0].id).toBe(id);
    expect((await repository.listJobs({ ...scope, principalId: "principal-b" })).value).toEqual([]);
  });

  it("rejects stale and expired publication while preserving the prior current snapshot", async () => {
    const stale = await submitAndRun("stale-a", "full", ["microsoft.copilotstudio/agents"]);
    const newer = await submitAndRun("stale-b", "full", ["microsoft.copilotstudio/agents"]);
    await expect(repository.publish(scope, stale, { resources: [resource("stale")], totalRecords: 1, pages: 1, unknownFieldCount: 0 })).rejects.toMatchObject({ code: "inventory_job_superseded" });
    await repository.publish(scope, newer, { resources: [resource("newer")], totalRecords: 1, pages: 1, unknownFieldCount: 0 });
    const snapshotId = (await repository.getJob(scope, newer))!.snapshotId!;

    const expired = await submitAndRun("expired-publication", "full", ["microsoft.copilotstudio/agents"]);
    await fixture.operator.query("UPDATE power_platform_refresh_jobs SET deadline_at=clock_timestamp()-interval '1 second' WHERE id=$1", [expired]);
    await expect(repository.publish(scope, expired, { resources: [resource("expired")], totalRecords: 1, pages: 1, unknownFieldCount: 0 })).rejects.toMatchObject({ code: "inventory_job_state" });
    expect((await repository.list(scope, { snapshotId })).value.map(value => value.nativeId)).toEqual(["newer"]);
  });

  it("orders duplicate display/native values by the full ordinal scoped tuple across pages", async () => {
    const id = await submitAndRun("deterministic-pages", "full", ["microsoft.copilotstudio/agents", "microsoft.powerautomate/agentflows"]);
    await repository.publish(scope, id, {
      resources: [
        resource("same", { displayName: "Tie", environmentId: "environment-b" }),
        resource("same", { displayName: "Tie", environmentId: "environment-a" }),
        resource("same", { displayName: "Tie", environmentId: "environment-a", type: "microsoft.powerautomate/agentflows", agentKind: "agent_flow" }),
      ], totalRecords: 3, pages: 1, unknownFieldCount: 0,
    });
    const snapshotId = (await repository.getJob(scope, id))!.snapshotId!;
    const pages = await Promise.all([0, 1, 2].map(offset => repository.list(scope, { snapshotId, sortBy: "displayName", limit: 1, offset })));
    expect(pages.map(page => `${page.value[0].type}:${page.value[0].environmentId}:${page.value[0].nativeId}`)).toEqual([
      "microsoft.copilotstudio/agents:environment-a:same",
      "microsoft.copilotstudio/agents:environment-b:same",
      "microsoft.powerautomate/agentflows:environment-a:same",
    ]);
  });

  it("keeps old rows visible until atomic commit and restores them after a mid-publication rollback", async () => {
    const initial = await submitAndRun("atomic-initial", "full", ["microsoft.copilotstudio/agents"]);
    await repository.publish(scope, initial, { resources: [resource("old-visible")], totalRecords: 1, pages: 1, unknownFieldCount: 0 });
    const initialSnapshotId = (await repository.getJob(scope, initial))!.snapshotId!;
    await fixture.operator.query(`CREATE FUNCTION hold_inventory_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(404365); RETURN NEW; END $$;
      CREATE TRIGGER hold_inventory_snapshot AFTER INSERT ON power_platform_inventory_snapshots FOR EACH ROW EXECUTE FUNCTION hold_inventory_snapshot()`);
    const lock = await fixture.operator.connect();
    await lock.query("SELECT pg_advisory_lock(404365)");
    try {
      const next = await submitAndRun("atomic-next", "full", ["microsoft.copilotstudio/agents"]);
      const publishing = repository.publish(scope, next, { resources: [resource("new-visible")], totalRecords: 1, pages: 1, unknownFieldCount: 0 });
      await vi.waitFor(async () => expect((await fixture.operator.query("SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() AND wait_event='advisory'")).rows[0].count).toBeGreaterThan(0));
      expect((await repository.list(scope, { snapshotId: initialSnapshotId })).value.map(value => value.nativeId)).toEqual(["old-visible"]);
      await lock.query("SELECT pg_advisory_unlock(404365)");
      await publishing;
      const nextSnapshotId = (await repository.getJob(scope, next))!.snapshotId!;
      expect((await repository.list(scope, { snapshotId: nextSnapshotId })).value.map(value => value.nativeId)).toEqual(["new-visible"]);
    } finally {
      await lock.query("SELECT pg_advisory_unlock_all()");
      lock.release();
      await fixture.operator.query("DROP TRIGGER hold_inventory_snapshot ON power_platform_inventory_snapshots; DROP FUNCTION hold_inventory_snapshot() CASCADE");
    }

    await fixture.operator.query(`CREATE FUNCTION reject_inventory_resource() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.native_id='rollback-new' THEN RAISE EXCEPTION 'fixture rollback'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER reject_inventory_resource BEFORE INSERT ON power_platform_inventory_resources FOR EACH ROW EXECUTE FUNCTION reject_inventory_resource()`);
    try {
      const rollback = await submitAndRun("atomic-rollback", "full", ["microsoft.copilotstudio/agents"]);
      await expect(repository.publish(scope, rollback, { resources: [resource("rollback-new")], totalRecords: 1, pages: 1, unknownFieldCount: 0 })).rejects.toThrow("fixture rollback");
      const currentSnapshotId = (await repository.listSnapshots(scope)).value.find(snapshot => snapshot.requestedTypes.length === 1)!.id;
      expect((await repository.list(scope, { snapshotId: currentSnapshotId })).value.map(value => value.nativeId)).toEqual(["new-visible"]);
    } finally {
      await fixture.operator.query("DROP TRIGGER reject_inventory_resource ON power_platform_inventory_resources; DROP FUNCTION reject_inventory_resource() CASCADE");
    }
  });

  it("preserves prior rows after failed progress and unknown-role omissions", async () => {
    const failedId = await submitAndRun("failed-a");
    await repository.recordProgress(scope, failedId, 1, 1, 2);
    await repository.markFailed(scope, failedId, "provider_error", "The provider query failed.");
    expect(await repository.getJob(scope, failedId)).toMatchObject({ status: "failed", pageCount: 1, observedCount: 1, totalRecords: 2 });
    expect((await repository.list(scope)).count).toBe(2);

    const firstUnknown = await submitAndRun("unknown-a", "unknown");
    await repository.publish(scope, firstUnknown, { resources: [resource("unknown-a"), resource("unknown-b")], totalRecords: 2, pages: 1, unknownFieldCount: 0 });
    const secondUnknown = await submitAndRun("unknown-b", "unknown");
    await expect(repository.publish(scope, secondUnknown, { resources: [resource("unknown-a")], totalRecords: 1, pages: 1, unknownFieldCount: 0 })).rejects.toMatchObject({ code: "incomplete_inventory_coverage" });
    const unknownSnapshot = (await repository.getJob(scope, firstUnknown))!.snapshotId!;
    expect((await repository.list(scope, { snapshotId: unknownSnapshot })).count).toBe(2);
  });

  it("rolls back tenant-mismatched publication and requires explicit authorization resume", async () => {
    const id = await repository.submit(scope, { idempotencyKey: "reauth-a", roleScope: "full", requestedTypes: powerPlatformResourceTypes });
    expect(id.status).toBe("waiting_authorization");
    expect(await repository.markRunning(scope, id.id)).toBe(true);
    await expect(repository.publish(scope, id.id, { resources: [resource("wrong", { tenantId: "tenant-b" })], totalRecords: 1, pages: 1, unknownFieldCount: 0 })).rejects.toMatchObject({ code: "scope_mismatch" });
    expect((await fixture.runtime.query("SELECT count(*)::int AS count FROM power_platform_inventory_snapshots WHERE job_id=$1", [id.id])).rows[0].count).toBe(0);
    await repository.markWaitingAuthorization(scope, id.id);
    expect(await repository.getJob(scope, id.id)).toMatchObject({ status: "waiting_authorization", errorCode: "interaction_required" });
  });

  it("applies finite snapshot and job retention without runtime deletion authority", async () => {
    await fixture.operator.query("UPDATE power_platform_inventory_snapshots SET expires_at=clock_timestamp()-interval '1 second'");
    await fixture.operator.query("UPDATE power_platform_refresh_jobs SET expires_at=clock_timestamp()-interval '1 second' WHERE status='failed'");
    await retain(fixture.operator);
    expect((await repository.list(scope)).snapshot).toBeNull();
    await expect(fixture.runtime.query("DELETE FROM power_platform_inventory_snapshots")).rejects.toThrow();
  });

  it("marks AI-role omissions as unauthorized while preserving unknown coverage", () => {
    const aiCoverage = buildCoverage("ai", powerPlatformResourceTypes, [resource("ai-agent")]);
    expect(aiCoverage.find(value => value.type === "microsoft.powerapps/canvasapps")).toEqual({ type: "microsoft.powerapps/canvasapps", status: "not_authorized_scope", count: null });
    expect(aiCoverage.find(value => value.type === "microsoft.copilotstudio/agents")).toEqual({ type: "microsoft.copilotstudio/agents", status: "covered", count: 1 });
    const unknownCoverage = buildCoverage("unknown", powerPlatformResourceTypes, []);
    expect(unknownCoverage.every(value => value.status === "unknown" && value.count === null)).toBe(true);
  });

  it("resolves identifiers from the entire authorized snapshot before paging without joining other principals", async () => {
    const privateScope = { tenantId: "tenant-a", principalId: "identity-reader" };
    const sharedIdentifier = { kind: "entra_agent_id" as const, value: "exact-fixture-identifier" };
    async function publishFor(principalId: string, names: string[], key: string) {
      const owner = { ...privateScope, principalId };
      const job = await repository.submit(owner, { idempotencyKey: key, roleScope: "full", requestedTypes: powerPlatformResourceTypes });
      await repository.markRunning(owner, job.id);
      await repository.publish(owner, job.id, { resources: names.map(name => resource(name, { identifiers: [sharedIdentifier] })), totalRecords: names.length, pages: 1, unknownFieldCount: 0 });
    }
    await publishFor("other-identity-reader", ["private-collision"], "private");
    await publishFor(privateScope.principalId, ["visible-a"], "unmatched");
    expect((await repository.list(privateScope)).value[0].association).toMatchObject({ status: "unresolved" });
    await publishFor(privateScope.principalId, ["visible-b", "visible-a"], "resolved");
    const resolved = await repository.list(privateScope, { search: "visible-a", limit: 1 });
    expect(resolved).toMatchObject({ count: 1, value: [{ association: { status: "resolved", candidate: { nativeId: "visible-b" } } }] });
    expect(JSON.stringify(resolved)).not.toContain("private-collision");
    await publishFor(privateScope.principalId, ["visible-c", "visible-b", "visible-a"], "ambiguous");
    const first = await repository.list(privateScope, { search: "visible-a", limit: 1 });
    const second = await repository.list(privateScope, { search: "visible-a", limit: 1 });
    expect(first.value[0].association).toMatchObject({ status: "ambiguous", candidates: [{ nativeId: "visible-b" }, { nativeId: "visible-c" }] });
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(JSON.stringify(first)).not.toContain("private-collision");
  });

  it("retains source success and saved data after independent seven-day job expiry", async () => {
    const retainedScope = { ...scope, principalId: "retained-source-reader" };
    const job = await repository.submit(retainedScope, { idempotencyKey: "retention", roleScope: "full", requestedTypes: powerPlatformResourceTypes });
    await repository.markRunning(retainedScope, job.id);
    await repository.publish(retainedScope, job.id, { resources: [resource("retained-source")], totalRecords: 1, pages: 1, unknownFieldCount: 0 });
    const before = await repository.listJobs(retainedScope);
    await fixture.operator.query("UPDATE power_platform_refresh_jobs SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [job.id]);
    await retain(fixture.operator);
    expect((await fixture.operator.query("SELECT id FROM power_platform_refresh_jobs WHERE id=$1", [job.id])).rowCount).toBe(0);
    const after = await repository.listJobs(retainedScope);
    expect(after).toMatchObject({ value: [], lastAttemptAt: null, lastSuccessAt: before.lastSuccessAt });
    expect(after.lastSuccessAt).not.toBeNull();
    expect((await repository.list(retainedScope)).value[0].nativeId).toBe("retained-source");
    expect((await repository.listJobs({ ...retainedScope, principalId: "not-the-owner" })).lastSuccessAt).toBeNull();
  });
});