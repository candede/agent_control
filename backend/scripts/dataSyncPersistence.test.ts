import { describe, expect, it } from "vitest";
import { DataSyncRepository } from "../src/db/dataSync.js";
import { migrations, verifySchema } from "../src/db/schema.js";
import { prepareRestoredDatabase } from "./backup.js";
import { bootstrap, grantRuntime, migrate, retain } from "./database.js";
import { fixturePassword, testDatabase } from "./testDatabase.js";

const scope = { tenantId: "sync-persistence-tenant", principalId: "sync-reader" };

describe("data sync persistence integration", () => {
  it("upgrades schema 30 without changing prior checksums or administrative audit", async () => {
    const fixture = await testDatabase(false);
    try {
      await bootstrap(fixture.operator, fixturePassword);
      await migrate(fixture.operator, migrations.slice(0, 30));
      const prior = (await fixture.operator.query("SELECT version,checksum FROM schema_migrations ORDER BY version")).rows;
      await fixture.operator.query(`INSERT INTO audit_events
        (id,event_id,operation_id,tenant_id,principal_id,actor_username,actor_name,scope,action,target_blocked_state,agent_id,started_at,status,request_path)
        VALUES(gen_random_uuid(),'preserved-sync-audit','preserved-sync-audit',$1,$2,'fixture@example.invalid','Fixture',
          'single','block',true,'fixture-package',clock_timestamp(),'succeeded','/fixture')`, [scope.tenantId, scope.principalId]);
      await migrate(fixture.operator);
      await grantRuntime(fixture.operator);
      await verifySchema(fixture.runtime);
      expect((await fixture.runtime.query("SELECT version,checksum FROM schema_migrations WHERE version<=30 ORDER BY version")).rows).toEqual(prior);
      expect((await fixture.runtime.query("SELECT event_id FROM audit_events")).rows).toEqual([{ event_id: "preserved-sync-audit" }]);
      const repository = new DataSyncRepository(fixture.runtime);
      const { run } = await repository.submit(scope, { mode: "initial" });
      expect(run.sources).toHaveLength(4);
      await repository.publishAppActivity(scope, { users: [], reportRefreshDate: null }, new Date().toISOString(), "Saved empty activity report.");
      expect((await repository.getUserSources(scope)).appActivity.rowCount).toBe(0);
      for (const table of ["data_sync_runs", "copilot_usage_snapshots", "data_sync_success_markers"]) {
        await expect(fixture.runtime.query(`DELETE FROM ${table}`)).rejects.toThrow();
      }
    } finally {
      await fixture.close();
    }
  });

  it("cleans expired snapshots and runs without resetting successful zero-row markers", async () => {
    const fixture = await testDatabase();
    try {
      const repository = new DataSyncRepository(fixture.runtime);
      const { run } = await repository.submit(scope, { mode: "initial" });
      await repository.updateSource(scope, run.id, "users", { status: "succeeded", count: 0, message: "Saved zero users.", canRetry: false });
      await repository.publishDirectory(scope, [], new Date().toISOString(), "Saved zero users.");
      await fixture.operator.query("UPDATE copilot_usage_snapshots SET expires_at=clock_timestamp()-interval '1 second'");
      await fixture.operator.query(`INSERT INTO data_sync_runs
        (id,tenant_id,principal_id,mode,source_ids,request_hash,status,expires_at)
        VALUES(gen_random_uuid(),$1,$2,'incremental','["users"]',repeat('a',64),'completed',clock_timestamp()-interval '1 second')`,
      [scope.tenantId, scope.principalId]);
      const result = await retain(fixture.operator);
      expect(result.affected).toMatchObject({ copilotUsageSnapshots: 1, dataSyncRuns: 1, copilotUsageMissingSnapshots: 1 });
      expect((await repository.getUserSources(scope)).directory).toMatchObject({ value: null, attemptStatus: "failed", rowCount: null });
      expect((await repository.listMarkers(scope)).find(source => source.source === "users")).toMatchObject({ status: "succeeded", count: 0 });
      expect(await repository.getRun(scope, run.id)).toBeDefined();
    } finally {
      await fixture.close();
    }
  });

  it("fences restored sync work and removes user snapshots no longer retained by the current database", async () => {
    const current = await testDatabase();
    const restored = await testDatabase();
    try {
      const repository = new DataSyncRepository(current.runtime);
      const revoked = { ...scope, principalId: "revoked-reader" };
      await repository.publishDirectory(scope, [], new Date().toISOString(), "Saved current users.");
      await repository.publishDirectory(revoked, [], new Date().toISOString(), "Saved users before removal.");
      const { run } = await repository.submit(scope, { mode: "initial" });
      await repository.updateSource(scope, run.id, "users", { status: "running", message: "Reading users.", canRetry: false });
      for (const table of ["data_sync_runs", "data_sync_run_sources", "copilot_usage_snapshots", "copilot_usage_source_state"]) {
        const rows = (await current.operator.query(`SELECT * FROM ${table}`)).rows;
        await restored.operator.query(`INSERT INTO ${table} SELECT * FROM jsonb_populate_recordset(NULL::${table},$1::jsonb)`, [JSON.stringify(rows)]);
      }
      await current.operator.query("DELETE FROM copilot_usage_snapshots WHERE principal_id=$1", [revoked.principalId]);
      await prepareRestoredDatabase(current.operator, restored.operator, new Date());
      const restoredRepository = new DataSyncRepository(restored.runtime);
      expect((await restoredRepository.getUserSources(scope)).directory).toMatchObject({ value: [], attemptStatus: "available", rowCount: 0 });
      expect((await restoredRepository.getUserSources(revoked)).directory).toMatchObject({ value: null, attemptStatus: "failed", rowCount: null });
      expect((await restoredRepository.getRun(scope, run.id))?.sources.find(source => source.source === "users")).toMatchObject({
        status: "waiting_authorization", canRetry: true,
      });
      expect((await restored.runtime.query("SELECT mode,provider_work_enabled FROM operational_state")).rows[0]).toEqual({
        mode: "maintenance", provider_work_enabled: false,
      });
      expect((await current.runtime.query("SELECT count(*)::int AS count FROM copilot_usage_snapshots")).rows[0].count).toBe(1);
    } finally {
      await restored.close();
      await current.close();
    }
  });
});
