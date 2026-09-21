import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bootstrap, grantRuntime, migrate } from "../../scripts/database.js";
import { fixturePassword, testDatabase } from "../../scripts/testDatabase.js";
import { CopilotUsageService } from "../services/copilotUsage.js";
import type { CopilotDirectoryUser } from "../services/copilotUsageGraph.js";
import { AgentPeopleRepository } from "./agentPeople.js";
import { publishUsageReports, saveUsageInventory } from "./agentUsageTestSupport.js";
import { DataSyncRepository, type CopilotUsageSnapshotSource, type DataSyncScope } from "./dataSync.js";
import { migrations, verifySchema } from "./schema.js";

let fixture: Awaited<ReturnType<typeof testDatabase>>;
let repository: DataSyncRepository;
const scopes = [
  { tenantId: randomUUID(), principalId: randomUUID() },
  { tenantId: randomUUID(), principalId: randomUUID() },
];
const observedAt = new Date().toISOString();
const oldUser = {
  identity: { objectId: randomUUID(), userPrincipalName: "old@example.invalid", displayName: "Old saved user" },
  licenses: [{ skuPartNumber: "MICROSOFT_365_E7", state: "enabled" }],
  servicePlans: [],
};

beforeAll(async () => {
  fixture = await testDatabase(false);
  await bootstrap(fixture.operator, fixturePassword);
  await migrate(fixture.operator, migrations.slice(0, 36));
  await grantRuntime(fixture.operator);
  repository = new DataSyncRepository(fixture.runtime);
  for (const [index, scope] of scopes.entries()) {
    await seedSnapshot(scope, "directory", index === 0 ? [oldUser] : [], index === 0 ? 1 : 0);
    await seedSnapshot(scope, "app_activity", { users: [], reportRefreshDate: null }, 0);
    for (const source of ["users", "graph_packages", "power_platform", "usage_reports"] as const) {
      await repository.recordSuccessMarker(scope, source, index + 1, observedAt);
    }
  }
  await saveUsageInventory(fixture.runtime, scopes[0], [{
    packages: ["Preserved-package"], native: { nativeId: "preserved-agent", environmentId: "preserved-environment" },
  }]);
  await publishUsageReports(fixture.runtime, scopes[0]);
  await new AgentPeopleRepository(fixture.runtime).save(scopes[0], [{
    objectId: randomUUID(), status: "resolved", displayName: "Preserved owner",
    userPrincipalName: "owner@example.invalid", checkedAt: observedAt,
  }], { generation: "initial" });
  await fixture.runtime.query(
    "INSERT INTO sessions(sid,sess,expire) VALUES($1,$2::json,clock_timestamp()+interval '1 hour')",
    [randomUUID(), JSON.stringify({ tenantId: scopes[0].tenantId, accountId: scopes[0].principalId })],
  );
});
afterAll(async () => { await fixture?.close(); });

describe.sequential("Copilot service snapshot reset migration", () => {
  it("deletes only Users-sync caches and markers, leaving inventory, reports, sessions and people intact", async () => {
    const before = await preservedRows();
    const checksums = (await fixture.operator.query("SELECT version,checksum FROM schema_migrations ORDER BY version")).rows;
    const otherMarkers = await nonUserMarkers();
    expect((await fixture.operator.query("SELECT count(*)::int AS count FROM copilot_usage_snapshots")).rows[0].count).toBe(4);

    await migrate(fixture.operator);
    await grantRuntime(fixture.operator);
    await verifySchema(fixture.runtime);

    expect((await fixture.operator.query("SELECT version,checksum FROM schema_migrations WHERE version<=36 ORDER BY version")).rows).toEqual(checksums);
    expect(await preservedRows()).toEqual(before);
    expect(await nonUserMarkers()).toEqual(otherMarkers);
    for (const table of ["copilot_usage_snapshots", "copilot_usage_source_state"]) {
      expect((await fixture.runtime.query(`SELECT count(*)::int AS count FROM ${table}`)).rows[0].count).toBe(0);
    }
    for (const scope of scopes) {
      const saved = await repository.getUserSources(scope);
      expect(saved.directory).toMatchObject({ value: null, rowCount: null, lastSuccessAt: null });
      expect(saved.appActivity).toMatchObject({ value: null, rowCount: null, lastSuccessAt: null });
      expect((await repository.listMarkers(scope)).find(source => source.source === "users"))
        .toMatchObject({ status: "not_started", count: null, lastSuccessAt: null });
      const response = await new CopilotUsageService(fixture.runtime).users(viewer(scope));
      expect(response.users).toEqual([]);
      expect(response.counts.licensedUsers).toBeNull();
      expect(response.snapshot?.state).toBe("not_synced");
    }
  });

  it("accepts fresh service snapshots and never repeats the deletion after the migration is applied", async () => {
    const user: CopilotDirectoryUser = {
      serviceEvidenceVersion: 1,
      identity: {
        objectId: randomUUID(), userPrincipalName: "fresh@example.invalid", displayName: "Fresh user",
        accountEnabled: true, userType: "Member", employeeType: null, companyName: null, department: null,
      },
      copilotServiceState: "enabled",
      servicePlans: [{
        servicePlanId: "a62f8878-de10-42f3-b68f-6149a25ceb97", service: "M365_COPILOT_APPS",
        displayName: "Microsoft 365 Copilot in Productivity Apps", state: "enabled",
        capabilityStatus: "Enabled", assignedDateTime: observedAt,
      }],
    };
    await repository.publishDirectory(scopes[0], [user], observedAt, "Fresh Copilot service evidence.");
    await repository.publishAppActivity(scopes[0], { users: [], reportRefreshDate: null }, observedAt, "Fresh app activity.");
    await repository.recordSuccessMarker(scopes[0], "users", 1, observedAt);
    await migrate(fixture.operator);
    const response = await new CopilotUsageService(fixture.runtime).users(viewer(scopes[0]));
    expect(response.users).toHaveLength(1);
    expect(response.users[0]).toMatchObject({ directory: user.identity, copilotServiceState: "enabled" });
    expect(response.counts.licensedUsers).toBe(1);
    expect(response.snapshot?.state).toBe("available");
    expect((await repository.listMarkers(scopes[0])).find(source => source.source === "users"))
      .toMatchObject({ status: "succeeded", count: 1 });
  });

  it.each([
    [], [oldUser], {}, { users: [] }, { serviceEvidenceVersion: 0, users: [] },
    { serviceEvidenceVersion: 1, users: null },
  ])("rejects an old or incomplete directory format instead of accepting it again: %j", async payload => {
    await expect(fixture.runtime.query(`INSERT INTO copilot_usage_snapshots
      (id,tenant_id,principal_id,source_id,snapshot_data,row_count,observed_at)
      VALUES($1,$2,$3,'directory',$4::jsonb,0,$5)`,
    [randomUUID(), scopes[0].tenantId, randomUUID(), JSON.stringify(payload), observedAt]))
      .rejects.toMatchObject({ code: "23514", constraint: "copilot_directory_service_format" });
  });

  it("does not grant the runtime general deletion privileges to perform the one-time reset", async () => {
    const result = await fixture.runtime.query(`SELECT
      has_table_privilege(current_user,'copilot_usage_snapshots','DELETE') AS snapshots,
      has_table_privilege(current_user,'copilot_usage_source_state','DELETE') AS sources,
      has_table_privilege(current_user,'data_sync_success_markers','DELETE') AS markers`);
    expect(result.rows[0]).toEqual({ snapshots: false, sources: false, markers: false });
  });
});

async function seedSnapshot(scope: DataSyncScope, source: CopilotUsageSnapshotSource, value: unknown, count: number) {
  const id = randomUUID();
  await fixture.operator.query(`INSERT INTO copilot_usage_snapshots
    (id,tenant_id,principal_id,source_id,snapshot_data,row_count,observed_at)
    VALUES($1,$2,$3,$4,$5::jsonb,$6,$7)`, [id, scope.tenantId, scope.principalId, source, JSON.stringify(value), count, observedAt]);
  await fixture.operator.query(`INSERT INTO copilot_usage_source_state
    (tenant_id,principal_id,source_id,attempt_status,message,attempted_at,last_success_at,row_count,current_snapshot_id)
    VALUES($1,$2,$3,'available','Old cached source.',$4,$4,$5,$6)`,
  [scope.tenantId, scope.principalId, source, observedAt, count, id]);
}

async function preservedRows() {
  return (await fixture.runtime.query(`
    SELECT 'packages' AS kind,id::text AS id FROM package_inventory_snapshots
    UNION ALL SELECT 'power_platform',id::text FROM power_platform_inventory_snapshots
    UNION ALL SELECT 'agents',id::text FROM unified_agents
    UNION ALL SELECT 'reports',id::text FROM official_usage_sets
    UNION ALL SELECT 'report_versions',id::text FROM official_usage_versions
    UNION ALL SELECT 'sessions',sid FROM sessions
    UNION ALL SELECT 'people',object_id::text FROM agent_people_cache
    ORDER BY kind,id`)).rows;
}

async function nonUserMarkers() {
  return (await fixture.runtime.query(`SELECT tenant_id,principal_id,source_id,count,last_success_at
    FROM data_sync_success_markers WHERE source_id<>'users' ORDER BY tenant_id,principal_id,source_id`)).rows;
}

function viewer(scope: DataSyncScope) {
  return {
    tenantId: scope.tenantId, homeAccountId: scope.principalId,
    username: "viewer@example.invalid", displayName: "Viewer", roles: ["AgentControl.Viewer"],
  };
}
