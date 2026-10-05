import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { retain } from "../../scripts/database.js";
import { testDatabase } from "../../scripts/testDatabase.js";
import { AgentPeopleRepository, type AgentPersonObservation } from "./agentPeople.js";
import { DataSyncRepository } from "./dataSync.js";
import { readAutomaticInventoryRevisions } from "./inventoryAutomaticRevisions.js";
import { nativeInventoryFixture } from "../../scripts/inventoryFixtures.js";
import { DataGenerations } from "./dataGenerations.js";
import { UserSourcesRepository } from "./userSources.js";
import { digest } from "./dataBounds.js";

vi.hoisted(() => { process.env.SESSION_SECRET ??= "synthetic-exact-people-database-secret-32"; });

let fixture: Awaited<ReturnType<typeof testDatabase>>;
let repository: AgentPeopleRepository;
let sync: DataSyncRepository;
const newScope = () => ({ tenantId: randomUUID(), principalId: randomUUID() });
const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const secondId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
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
  it("isolates tenant/account caches, projects null UPNs, and changes only the owning inventory revision", async () => {
    const scope = newScope();
    const context = { generation: await repository.generation(scope) };
    const other = { ...scope, principalId: randomUUID() };
    const before = await readAutomaticInventoryRevisions(scope, fixture.runtime);
    const otherBefore = await readAutomaticInventoryRevisions(other, fixture.runtime);
    await repository.save(scope, [observation({ userPrincipalName: null })], context);
    expect(await repository.read(scope, [id.toUpperCase()])).toEqual([expect.objectContaining({
      objectId: id, status: "resolved", displayName: "Unlicensed creator", userPrincipalName: null,
    })]);
    expect(await repository.read(other, [id])).toEqual([]);
    expect(await repository.read({ ...scope, tenantId: randomUUID() }, [id])).toEqual([]);
    await repository.generation(other);
    await expect(repository.save(other, [observation()], context)).rejects.toMatchObject({ code: "selection_invalidated" });
    expect(await readAutomaticInventoryRevisions(scope, fixture.runtime)).not.toEqual(before);
    expect(await readAutomaticInventoryRevisions(other, fixture.runtime)).toEqual(otherBefore);
    expect(await repository.directoryIds(scope, [id])).toEqual([]);
  });

  it("preserves known names and their observation time on errors, but clears them on conclusive not-found", async () => {
    const scope = newScope();
    const context = { generation: await repository.generation(scope) };
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
    for (const delay of [1_000, 2_000]) {
      const retriedAt = new Date(Date.parse(missingAt) + delay).toISOString();
      await repository.save(scope, [observation({ status: "lookup_failed", displayName: null, userPrincipalName: null,
        checkedAt: retriedAt, errorCode: "provider_timeout" })], context);
      expect((await repository.read(scope, [id]))[0]).toMatchObject({
        status: "lookup_failed", displayName: null, userPrincipalName: null,
        observedAt: missingAt, lastConclusiveAt: missingAt, checkedAt: retriedAt, errorCode: "provider_timeout",
      });
    }
  });

  it("uses bounded status-specific expiry and drops expired cache from reads and revisions", async () => {
    const scope = newScope();
    const context = { generation: await repository.generation(scope) };
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
    const before = await readAutomaticInventoryRevisions(scope, fixture.runtime);
    await fixture.operator.query(`UPDATE agent_people_cache SET checked_at=clock_timestamp()-interval '8 days',
      expires_at=clock_timestamp()-interval '1 second' WHERE tenant_id=$1 AND principal_id=$2`,
    [scope.tenantId, scope.principalId]);
    expect(await repository.read(scope, ids)).toEqual([]);
    expect(await readAutomaticInventoryRevisions(scope, fixture.runtime)).not.toEqual(before);
    await retain(fixture.operator);
    expect((await fixture.operator.query("SELECT count(*)::int AS count FROM agent_people_cache WHERE tenant_id=$1", [scope.tenantId])).rows[0].count).toBe(0);
  });

  it("extracts only exact user IDs from current scoped native agents, without syncing all directory users", async () => {
    const scope = newScope();
    const root = await nativeInventoryFixture(fixture.runtime, scope, [{ nativeId: "agent", environmentId: "environment",
      identifiers: [], createdBy: id.toUpperCase(), details: { ownerId: secondId, lastModifiedBy: "not-a-user-id" } }]);
    expect(await repository.referencedIds(scope)).toEqual([id, secondId]);
    expect(await repository.referencedIds({ ...scope, principalId: "other" })).toEqual([]);
    await new DataGenerations(fixture.runtime).invalidate(root.scopeId, scope.tenantId);
    expect(await repository.referencedIds(scope)).toEqual([]);
  });

  it("requires the current Users attempt for publication and rejects results after a scoped reset", async () => {
    const scope = newScope();
    const context = { generation: await repository.generation(scope) };
    const other = { ...scope, principalId: randomUUID() };
    const { run } = await sync.submit(scope, { mode: "incremental", sources: ["users"] });
    const publication = { runId: run.id, jobId: randomUUID() };
    await expect(repository.save(scope, [observation()], { ...context, publication }))
      .rejects.toMatchObject({ code: "data_sync_publication_superseded" });
    await sync.attachJob(scope, run.id, "users", publication.jobId);
    await sync.updateSource(scope, run.id, "users", { status: "running", message: "Fixture.", canRetry: false, count: null });
    await repository.save(scope, [observation()], { ...context, publication });
    await repository.save(other, [observation()], { generation: await repository.generation(other) });
    await sync.cancel(scope, run.id);
    await expect(repository.save(scope, [observation()], { ...context, publication }))
      .rejects.toMatchObject({ code: "data_sync_publication_superseded" });
    await sync.submit(scope, { mode: "full", clearSavedData: true });
    const current = await repository.generation(scope);
    expect(current).toEqual({ ...context.generation, scopeEpoch: (BigInt(context.generation.scopeEpoch) + 1n).toString() });
    expect(await repository.read(scope, [id])).toEqual([]);
    expect(await repository.read(other, [id])).toHaveLength(1);
    await expect(repository.save(scope, [observation()], context)).rejects.toMatchObject({ code: "selection_invalidated" });
    await repository.save(scope, [observation()], { generation: current });
    expect(await repository.read(scope, [id])).toHaveLength(1);
  });

  it("keeps a write fence stable across cache batches while invalidating dependent read selections", async () => {
    const scope = newScope(), generation = await repository.generation(scope);
    const sources = new UserSourcesRepository(fixture.runtime, process.env.SESSION_SECRET!);
    const identity = { ...scope, sessionEpoch: generation.sessionEpoch, authorizationHash: digest("cache-write-fence") };
    const selection = await sources.capture(identity, "delegated");
    await repository.save(scope, [observation()], { generation });
    await expect(sources.page(selection.id, identity)).rejects.toMatchObject({ code: "selection_invalidated" });
    expect(await repository.generation(scope)).toEqual(generation);
    await repository.save(scope, [observation({ objectId: secondId })], { generation });
    expect(await repository.generation(scope)).toEqual(generation);
    expect(await repository.read(scope, [id, secondId])).toHaveLength(2);
  });

  it("enforces the runtime role and validation, and rolls back cancelled publication", async () => {
    const scope = newScope();
    const context = { generation: await repository.generation(scope) };
    await expect(fixture.runtime.query("DELETE FROM agent_people_cache")).rejects.toThrow("permission denied");
    await expect(repository.save(scope, [observation({ objectId: "not-an-id" })], context)).rejects.toMatchObject({ code: "data_exact_ids_limit" });
    await expect(repository.save(scope, [observation({ displayName: "x".repeat(513) })], context)).rejects.toMatchObject({ code: "invalid_agent_people" });
    await expect(repository.save(scope, [observation(), observation()], context)).rejects.toMatchObject({ code: "invalid_agent_people" });
    const tooMany = Array.from({ length: 101 }, () => randomUUID());
    await expect(repository.read(scope, tooMany)).rejects.toMatchObject({ code: "data_exact_ids_limit" });
    await expect(repository.directoryIds(scope, tooMany)).rejects.toMatchObject({ code: "data_exact_ids_limit" });
    await expect(repository.save(scope, tooMany.map(objectId => observation({ objectId })), context))
      .rejects.toMatchObject({ code: "data_exact_ids_limit" });
    const controller = new AbortController();
    controller.abort(new Error("Fixture cancellation"));
    await expect(repository.save(scope, [observation()], { ...context, signal: controller.signal })).rejects.toThrow("Fixture cancellation");
    expect(await repository.read(scope, [id])).toEqual([]);
  });
});
