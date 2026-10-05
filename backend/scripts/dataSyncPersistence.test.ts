import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import pg from "pg";
import { DataSyncRepository } from "../src/db/dataSync.js";
import { DataGenerations } from "../src/db/dataGenerations.js";
import { UserSourcesRepository } from "../src/db/userSources.js";
import { databaseSettings } from "../src/db/pool.js";
import { verifySchema } from "../src/db/schema.js";
import { backup, restore } from "./backup.js";
import { retain, retainUntilConverged } from "./database.js";
import { fixturePassword, testDatabase } from "./testDatabase.js";
import { selectionIdentity } from "./largeTenantFixtures.js";
import { fixtureDirectoryUser, publishFixtureDirectory, publishFixtureEmptyActivity } from "./userSourceFixture.js";

const scope = { tenantId: "sync-persistence-tenant", principalId: "sync-reader" };
const identity = (owner = scope, sessionEpoch = "0") => ({ ...selectionIdentity, ...owner, sessionEpoch });
async function sourcePage(database: pg.Pool, owner = scope, sessionEpoch = "0") {
  const reader = new UserSourcesRepository(database, "synthetic-persistence-source-read-secret");
  const actor = identity(owner, sessionEpoch), selected = await reader.capture(actor, "delegated");
  return reader.page(selected.id, actor);
}

describe("data sync persistence integration", () => {
  it("enforces the current clean-full scope and automatic source sequence", async () => {
    const fixture = await testDatabase();
    try {
      await verifySchema(fixture.runtime);
      const repository = new DataSyncRepository(fixture.runtime);
      const current = await repository.submit(scope, { mode: "full", clearSavedData: true });
      expect(current.run.sources.map(source => source.source)).toEqual(["graph_packages", "power_platform", "users"]);
      for (const [mode, sources] of [
        ["full", ["users", "graph_packages"]],
        ["full", ["users", "graph_packages", "power_platform", "usage_reports"]],
        ["full", ["users", "graph_packages", "power_platform", "users"]],
        ["full", ["users", "graph_packages", "power_platform", "unknown"]],
        ["incremental", ["users", "graph_packages", "power_platform"]],
      ] as const) {
        await expect(fixture.runtime.query(`INSERT INTO data_sync_runs
          (id,tenant_id,principal_id,mode,source_ids,request_hash,clear_saved_data)
          VALUES(gen_random_uuid(),$1,'invalid-clean-scope',$2,$3::jsonb,repeat('b',64),true)`,
        [scope.tenantId, mode, JSON.stringify(sources)])).rejects.toMatchObject({
          code: "23514", constraint: "data_sync_cleanup_full_scope",
        });
      }
      await expect(fixture.runtime.query("DELETE FROM data_sync_success_markers")).rejects.toMatchObject({ code: "42501" });
    } finally {
      await fixture.close();
    }
  });

  it("initializes current sources with empty activity and least-privilege persistence", async () => {
    const fixture = await testDatabase();
    try {
      await verifySchema(fixture.runtime);
      const repository = new DataSyncRepository(fixture.runtime);
      const { run } = await repository.submit(scope, { mode: "initial" });
      expect(run.sources.map(source => source.source)).toEqual(["graph_packages", "power_platform", "users"]);
      await publishFixtureEmptyActivity(fixture.runtime, identity());
      expect((await sourcePage(fixture.runtime)).sources.app_activity.rowCount).toBe(0);
      for (const table of ["data_sync_runs", "data_sync_success_markers", "agent_people_cache"]) {
        await expect(fixture.runtime.query(`DELETE FROM ${table}`)).rejects.toMatchObject({ code: "42501" });
      }
    } finally {
      await fixture.close();
    }
  });

  it("collects expired native records and runs without resetting successful zero-row markers", async () => {
    const fixture = await testDatabase();
    try {
      const repository = new DataSyncRepository(fixture.runtime);
      const { run } = await repository.submit(scope, { mode: "initial" });
      await repository.updateSource(scope, run.id, "users", { status: "succeeded", count: 0, message: "Saved zero users.", canRetry: false });
      const expiresAt = new Date(Date.now() + 1500);
      const published = await publishFixtureDirectory(fixture.runtime, identity(), [], { expiresAt });
      await new Promise(resolve => setTimeout(resolve, Math.max(0, expiresAt.getTime() - Date.now()) + 25));
      await fixture.operator.query(`INSERT INTO data_sync_runs
        (id,tenant_id,principal_id,mode,source_ids,request_hash,status,expires_at)
        VALUES(gen_random_uuid(),$1,$2,'incremental','["users"]',repeat('a',64),'completed',clock_timestamp()-interval '1 second')`,
      [scope.tenantId, scope.principalId]);
      const result = await retain(fixture.operator);
      expect(result.affected).toMatchObject({ recordExpiredGenerations: 1, recordCollectedGenerations: 1, dataSyncRuns: 1 });
      expect((await sourcePage(fixture.runtime)).sources.directory).toMatchObject({ generationId: null, state: "unavailable", rowCount: null });
      expect((await fixture.runtime.query("SELECT collected_at FROM data_generations WHERE id=$1", [published.generationId])).rows[0].collected_at)
        .toBeInstanceOf(Date);
      expect((await repository.listMarkers(scope)).find(source => source.source === "users")).toMatchObject({ status: "succeeded", count: 0 });
      expect(await repository.getRun(scope, run.id)).toBeDefined();
    } finally {
      await fixture.close();
    }
  });

  it("fences restored sync work and requires fresh principal evidence after an actual backup/restore", async () => {
    const current = await testDatabase();
    const target = `agentcontrol_restore_${randomUUID().replaceAll("-", "")}`;
    const directory = resolve("artifacts");
    mkdirSync(directory, { recursive: true });
    const filename = resolve(directory, `sync-restore-${randomUUID()}.dump`);
    let restored: pg.Pool | undefined;
    try {
      const repository = new DataSyncRepository(current.runtime);
      const revoked = { ...scope, principalId: "revoked-reader" };
      await publishFixtureDirectory(current.runtime, identity(), [fixtureDirectoryUser(randomUUID(), "Current user", "current@example.invalid")]);
      const removed = await publishFixtureDirectory(current.runtime, identity(revoked),
        [fixtureDirectoryUser(randomUUID(), "Removed user", "removed@example.invalid")]);
      const { run } = await repository.submit(scope, { mode: "initial" });
      await repository.updateSource(scope, run.id, "users", { status: "running", message: "Reading users.", canRetry: false });
      await backup(current.operator, filename);
      const removedScope = (await current.runtime.query("SELECT scope_id FROM data_generations WHERE id=$1", [removed.generationId])).rows[0].scope_id;
      await new DataGenerations(current.runtime).invalidate(removedScope, revoked.tenantId);
      await retainUntilConverged(current.operator);
      await restore(current.operator, filename, target);
      restored = new pg.Pool({ ...databaseSettings(), database: target, user: "agentcontrol_app", password: fixturePassword });
      const restoredRepository = new DataSyncRepository(restored);
      for (const owner of [scope, revoked]) {
        const epoch = await new DataGenerations(restored).sessionEpoch(owner.tenantId, owner.principalId);
        expect((await sourcePage(restored, owner, epoch)).sources.directory).toMatchObject({ generationId: null, state: "unavailable", rowCount: null });
      }
      expect((await restoredRepository.getRun(scope, run.id))?.sources.find(source => source.source === "users")).toMatchObject({
        status: "waiting_authorization", canRetry: true,
      });
      expect((await restored.query("SELECT mode,provider_work_enabled FROM operational_state")).rows[0]).toEqual({
        mode: "maintenance", provider_work_enabled: false,
      });
      expect((await current.runtime.query("SELECT count(*)::int AS count FROM directory_user_rows")).rows[0].count).toBe(1);
      expect((await restored.query("SELECT count(*)::int AS count FROM directory_user_rows")).rows[0].count).toBe(0);
    } finally {
      await restored?.end();
      await current.operator.query(`DROP DATABASE IF EXISTS "${target}"`);
      rmSync(filename, { force: true }); rmSync(`${filename}.json`, { force: true });
      await current.close();
    }
  });
});
