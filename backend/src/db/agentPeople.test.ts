import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bootstrap, grantRuntime, migrate, retain } from "../../scripts/database.js";
import { fixturePassword, testDatabase } from "../../scripts/testDatabase.js";
import { AgentPeopleRepository, type AgentPersonObservation } from "./agentPeople.js";
import { DataSyncRepository } from "./dataSync.js";
import { readUnifiedInventoryRevision } from "./unifiedInventoryRevision.js";
import { saveUsageInventory } from "./agentUsageTestSupport.js";
import { migrations, verifySchema } from "./schema.js";

let fixture: Awaited<ReturnType<typeof testDatabase>>;
let repository: AgentPeopleRepository;
let sync: DataSyncRepository;
const newScope = () => ({ tenantId: randomUUID(), principalId: randomUUID() });
const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const secondId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const context = { generation: "initial" };
const observation = (override: Partial<AgentPersonObservation> = {}): AgentPersonObservation => ({
  objectId: id, status: "resolved", displayName: "Unlicensed creator", userPrincipalName: "creator@example.invalid",
  checkedAt: new Date(Date.now() - 120_000).toISOString(), ...override,
});

beforeAll(async () => {
  fixture = await testDatabase();
  repository = new AgentPeopleRepository(fixture.runtime);
  sync = new DataSyncRepository(fixture.runtime);
});
afterAll(async () => { await fixture?.close(); });

describe("agent people persistence", () => {
  it("upgrades schema 34 without changing existing snapshots or historical migration checksums", async () => {
    const upgrade = await testDatabase(false);
    try {
      await bootstrap(upgrade.operator, fixturePassword);
      await migrate(upgrade.operator, migrations.slice(0, 34));
      await grantRuntime(upgrade.operator);
      const saved = new DataSyncRepository(upgrade.runtime);
      const scope = newScope();
      const snapshot = await saved.publishDirectory(scope, [], new Date().toISOString(), "Zero-row fixture.");
      const checksums = (await upgrade.operator.query("SELECT version,checksum FROM schema_migrations ORDER BY version")).rows;
      await migrate(upgrade.operator);
      await grantRuntime(upgrade.operator);
      await verifySchema(upgrade.runtime);
      expect((await upgrade.operator.query("SELECT version,checksum FROM schema_migrations WHERE version<=34 ORDER BY version")).rows).toEqual(checksums);
      expect((await upgrade.runtime.query("SELECT id FROM copilot_usage_snapshots WHERE id=$1", [snapshot])).rowCount).toBe(1);
      await new AgentPeopleRepository(upgrade.runtime).save(scope, [observation()], context);
      expect((await saved.getDirectorySource(scope)).value).toEqual([]);
    } finally {
      await upgrade.close();
    }
  });

  it("isolates tenant/account caches, projects null UPNs, and changes only the owning inventory revision", async () => {
    const scope = newScope();
    const other = { ...scope, principalId: randomUUID() };
    const before = await readUnifiedInventoryRevision(scope, fixture.runtime);
    const otherBefore = await readUnifiedInventoryRevision(other, fixture.runtime);
    await repository.save(scope, [observation({ userPrincipalName: null })], context);
    expect(await repository.read(scope, [id.toUpperCase()])).toEqual([expect.objectContaining({
      objectId: id, status: "resolved", displayName: "Unlicensed creator", userPrincipalName: null,
    })]);
    expect(await repository.read(other, [id])).toEqual([]);
    expect(await repository.read({ ...scope, tenantId: randomUUID() }, [id])).toEqual([]);
    expect(await readUnifiedInventoryRevision(scope, fixture.runtime)).not.toBe(before);
    expect(await readUnifiedInventoryRevision(other, fixture.runtime)).toBe(otherBefore);
    expect((await sync.getDirectorySource(scope)).value).toBeNull();
  });

  it("preserves known names and their observation time on errors, but clears them on conclusive not-found", async () => {
    const scope = newScope();
    const first = observation();
    await repository.save(scope, [first], context);
    const failedAt = new Date(Date.parse(first.checkedAt) + 1_000).toISOString();
    await repository.save(scope, [observation({ status: "lookup_failed", displayName: null, userPrincipalName: null,
      checkedAt: failedAt, errorCode: "provider_timeout" })], context);
    expect((await repository.read(scope, [id]))[0]).toMatchObject({
      status: "lookup_failed", displayName: first.displayName, observedAt: first.checkedAt, checkedAt: failedAt,
      errorCode: "provider_timeout",
    });
    const missingAt = new Date(Date.parse(failedAt) + 1_000).toISOString();
    await repository.save(scope, [observation({ status: "not_found", displayName: null, userPrincipalName: null,
      checkedAt: missingAt })], context);
    expect((await repository.read(scope, [id]))[0]).toMatchObject({
      status: "not_found", displayName: null, userPrincipalName: null, observedAt: missingAt,
    });
    await repository.save(scope, [first], context);
    expect((await repository.read(scope, [id]))[0].status).toBe("not_found");
  });

  it("uses bounded status-specific expiry and drops expired cache from reads and revisions", async () => {
    const scope = newScope();
    const ids: string[] = [];
    for (const [status, hours] of [["resolved", 168], ["not_found", 24], ["lookup_failed", 0.25]] as const) {
      const value = observation({ objectId: randomUUID(), status,
        ...(status !== "resolved" ? { displayName: null, userPrincipalName: null } : {}),
        ...(status === "lookup_failed" ? { errorCode: "provider_error" } : {}) });
      await repository.save(scope, [value], context);
      ids.push(value.objectId);
      const [person] = await repository.read(scope, [value.objectId]);
      expect(Date.parse(person.expiresAt!) - Date.parse(person.checkedAt!)).toBe(hours * 3_600_000);
    }
    const before = await readUnifiedInventoryRevision(scope, fixture.runtime);
    await fixture.operator.query(`UPDATE agent_people_cache SET checked_at=clock_timestamp()-interval '8 days',
      expires_at=clock_timestamp()-interval '1 second' WHERE tenant_id=$1 AND principal_id=$2`,
    [scope.tenantId, scope.principalId]);
    expect(await repository.read(scope, ids)).toEqual([]);
    expect(await readUnifiedInventoryRevision(scope, fixture.runtime)).not.toBe(before);
    await retain(fixture.operator);
    expect((await fixture.operator.query("SELECT count(*)::int AS count FROM agent_people_cache WHERE tenant_id=$1", [scope.tenantId])).rows[0].count).toBe(0);
  });

  it("extracts only exact user IDs from current scoped native agents, without syncing all directory users", async () => {
    const scope = newScope();
    await saveUsageInventory(fixture.runtime, scope, [{ packages: [], native: { nativeId: "agent", environmentId: "environment" } }]);
    await fixture.operator.query(`UPDATE power_platform_inventory_resources SET created_by=$3,
      details=jsonb_build_object('ownerId',$4::text,'lastModifiedBy','not-a-user-id') WHERE tenant_id=$1 AND principal_id=$2`,
    [scope.tenantId, scope.principalId, id.toUpperCase(), secondId]);
    expect(await repository.referencedIds(scope)).toEqual([id, secondId]);
    expect(await repository.referencedIds({ ...scope, principalId: "other" })).toEqual([]);
    await fixture.operator.query("UPDATE power_platform_inventory_snapshots SET is_current=false WHERE tenant_id=$1", [scope.tenantId]);
    expect(await repository.referencedIds(scope)).toEqual([]);
  });

  it("requires the current Users attempt for publication and rejects results after a scoped reset", async () => {
    const scope = newScope();
    const other = { ...scope, principalId: randomUUID() };
    const { run } = await sync.submit(scope, { mode: "incremental", sources: ["users"] });
    const publication = { runId: run.id, jobId: randomUUID() };
    await expect(repository.save(scope, [observation()], { ...context, publication }))
      .rejects.toMatchObject({ code: "data_sync_publication_superseded" });
    await sync.attachJob(scope, run.id, "users", publication.jobId);
    await sync.updateSource(scope, run.id, "users", { status: "running", message: "Fixture.", canRetry: false, count: null });
    await repository.save(scope, [observation()], { ...context, publication });
    await repository.save(other, [observation()], context);
    await sync.cancel(scope, run.id);
    await expect(repository.save(scope, [observation()], { ...context, publication }))
      .rejects.toMatchObject({ code: "data_sync_publication_superseded" });
    const cleared = await sync.submit(scope, { mode: "full", clearSavedData: true });
    expect(await repository.generation(scope)).toBe(cleared.run.id);
    expect(await repository.read(scope, [id])).toEqual([]);
    expect(await repository.read(other, [id])).toHaveLength(1);
    await expect(repository.save(scope, [observation()], context)).rejects.toMatchObject({ code: "dataset_invalidated" });
  });

  it("enforces the runtime role and validation, and rolls back cancelled publication", async () => {
    const scope = newScope();
    await expect(fixture.runtime.query("DELETE FROM agent_people_cache")).rejects.toThrow("permission denied");
    await expect(repository.save(scope, [observation({ objectId: "not-an-id" })], context)).rejects.toMatchObject({ code: "invalid_agent_people" });
    await expect(repository.save(scope, [observation({ displayName: "x".repeat(513) })], context)).rejects.toMatchObject({ code: "invalid_agent_people" });
    await expect(repository.save(scope, [observation(), observation()], context)).rejects.toMatchObject({ code: "invalid_agent_people" });
    const controller = new AbortController();
    controller.abort(new Error("Fixture cancellation"));
    await expect(repository.save(scope, [observation()], { ...context, signal: controller.signal })).rejects.toThrow("Fixture cancellation");
    expect(await repository.read(scope, [id])).toEqual([]);
  });
});
