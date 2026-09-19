import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bootstrap, grantRuntime, migrate } from "../../scripts/database.js";
import { fixturePassword, testDatabase } from "../../scripts/testDatabase.js";
import { AgentUsageService } from "../services/agentUsage.js";
import {
  newUsageScope, publishUsageReports, saveUsageInventory, usageAudit, usageIntent,
} from "./agentUsageTestSupport.js";
import { migrations, migrationChecksum, verifySchema } from "./schema.js";

let fixture: Awaited<ReturnType<typeof testDatabase>>;
beforeAll(async () => { fixture = await testDatabase(); }, 60_000);
afterAll(async () => { await fixture?.close(); });

describe("usage association migration and runtime boundary", () => {
  it("upgrades nonempty schema33 without rewriting report content, inventory or old checksums", async () => {
    const upgrade = await testDatabase(false);
    try {
      await bootstrap(upgrade.operator, fixturePassword);
      await migrate(upgrade.operator, migrations.filter(step => step.version <= 33));
      await grantRuntime(upgrade.operator);
      const scope = newUsageScope();
      const records = await saveUsageInventory(upgrade.runtime, scope);
      await publishUsageReports(upgrade.runtime, scope);
      const rows = async () => ({
        reports: (await upgrade.runtime.query("SELECT to_jsonb(report) AS value FROM official_usage_sets report ORDER BY id")).rows,
        facts: (await upgrade.runtime.query("SELECT to_jsonb(fact) AS value FROM official_usage_row_facts fact ORDER BY payload_hash")).rows,
        sources: (await upgrade.runtime.query("SELECT to_jsonb(source) AS value FROM unified_agent_sources source ORDER BY native_id")).rows,
      });
      const before = await rows();
      const checksums = (await upgrade.runtime.query("SELECT version,checksum FROM schema_migrations ORDER BY version")).rows;
      await migrate(upgrade.operator);
      await grantRuntime(upgrade.operator);
      await verifySchema(upgrade.runtime);
      expect(await rows()).toEqual(before);
      expect((await upgrade.runtime.query("SELECT version,checksum FROM schema_migrations WHERE version<=33 ORDER BY version")).rows).toEqual(checksums);
      expect((await upgrade.runtime.query("SELECT version,checksum FROM schema_migrations ORDER BY version")).rows)
        .toEqual(migrations.map(step => ({ version: step.version, checksum: migrationChecksum(step.sql) })));
      expect(migrations.at(-1)?.version).toBe(34);
      const service = new AgentUsageService(upgrade.runtime);
      await service.attach(scope, records[0].id, await usageIntent(upgrade.runtime, scope), usageAudit(scope));
      expect((await service.project(scope, records)).summaries.get(records[0].id)).toMatchObject({ responses: 10, activeUsers: 2 });
    } finally { await upgrade.close(); }
  }, 60_000);

  it("denies runtime reassignment, revision tampering, DDL and audit rewriting", async () => {
    const scope = newUsageScope();
    const records = await saveUsageInventory(fixture.runtime, scope);
    await publishUsageReports(fixture.runtime, scope);
    await new AgentUsageService(fixture.runtime).attach(scope, records[0].id, await usageIntent(fixture.runtime, scope), usageAudit(scope));
    for (const sql of [
      "UPDATE agent_usage_associations SET native_id='other'",
      "UPDATE agent_usage_associations SET report_agent_id='other'",
      "TRUNCATE agent_usage_associations",
      "INSERT INTO agent_usage_state(tenant_id) VALUES('forbidden')",
      "UPDATE agent_usage_state SET revision=1",
      "DELETE FROM agent_usage_state",
      "TRUNCATE agent_usage_state",
      "ALTER TABLE agent_usage_associations ADD COLUMN forbidden text",
      "DELETE FROM audit_events",
    ]) await expect(fixture.runtime.query(sql)).rejects.toMatchObject({ code: "42501" });
    await verifySchema(fixture.runtime);
  });

  it("verifies least-privilege association grants through runtime readiness", async () => {
    await fixture.operator.query("GRANT UPDATE ON agent_usage_associations TO agentcontrol_app");
    try { await expect(verifySchema(fixture.runtime)).rejects.toThrow("runtime grants"); }
    finally { await fixture.operator.query("REVOKE UPDATE ON agent_usage_associations FROM agentcontrol_app"); }
    await verifySchema(fixture.runtime);
    await fixture.operator.query("GRANT UPDATE(revision) ON agent_usage_state TO agentcontrol_app");
    try { await expect(verifySchema(fixture.runtime)).rejects.toThrow("runtime grants"); }
    finally { await fixture.operator.query("REVOKE UPDATE(revision) ON agent_usage_state FROM agentcontrol_app"); }
    await verifySchema(fixture.runtime);
  });

  it("fails readiness when an association revision or cleanup trigger is disabled", async () => {
    await fixture.operator.query("ALTER TABLE agent_usage_associations DISABLE TRIGGER advance_agent_usage_revision");
    try { await expect(verifySchema(fixture.runtime)).rejects.toThrow("schema is missing or incomplete"); }
    finally { await fixture.operator.query("ALTER TABLE agent_usage_associations ENABLE TRIGGER advance_agent_usage_revision"); }
    await verifySchema(fixture.runtime);
  });

  it("requires exact tenant, active Agents identity and the reviewer's current source in persisted rows", async () => {
    const scope = newUsageScope();
    await saveUsageInventory(fixture.runtime, scope);
    const report = await publishUsageReports(fixture.runtime, scope);
    const insert = (values: { tenant?: string; principal?: string; reportId?: string; packageId?: string; setId?: string } = {}) => fixture.runtime.query(`
      INSERT INTO agent_usage_associations(tenant_id,report_set_id,report_agent_id,source,native_id,environment_id,reviewed_by)
      VALUES($1,$2,$3,'graph_packages',$4,'',$5)`, [
      values.tenant ?? scope.tenantId, values.setId ?? report.setId, values.reportId ?? "Report-A",
      values.packageId ?? "Package-A", values.principal ?? scope.principalId,
    ]);
    for (const values of [
      { tenant: "foreign" }, { principal: "foreign" }, { reportId: "Bridge-Only" },
      { reportId: "report-a" }, { packageId: "package-a" }, { setId: randomUUID() },
    ]) await expect(insert(values)).rejects.toThrow();
    await insert();
    await expect(insert({ packageId: "Package-B" })).rejects.toMatchObject({ code: "23505" });
    expect((await fixture.runtime.query("SELECT revision::text FROM agent_usage_state WHERE tenant_id=$1", [scope.tenantId])).rows[0].revision).toBe("1");
    await fixture.runtime.query("DELETE FROM agent_usage_associations WHERE tenant_id=$1 AND report_set_id=$2 AND report_agent_id='Report-A'", [scope.tenantId, report.setId]);
    await insert();
    expect((await fixture.runtime.query("SELECT revision::text FROM agent_usage_state WHERE tenant_id=$1", [scope.tenantId])).rows[0].revision).toBe("3");
  });

  it("physically cascades association cleanup by the exact tenant/report-set key", async () => {
    const scope = newUsageScope();
    const records = await saveUsageInventory(fixture.runtime, scope);
    const report = await publishUsageReports(fixture.runtime, scope);
    await new AgentUsageService(fixture.runtime).attach(scope, records[0].id, await usageIntent(fixture.runtime, scope), usageAudit(scope));
    await fixture.operator.query("UPDATE official_usage_state SET active_set_id=NULL,revision=revision+1 WHERE tenant_id=$1", [scope.tenantId]);
    await fixture.operator.query("DELETE FROM official_usage_sets WHERE tenant_id=$1 AND id=$2", [scope.tenantId, report.setId]);
    expect((await fixture.runtime.query("SELECT count(*)::int AS count FROM agent_usage_associations WHERE tenant_id=$1", [scope.tenantId])).rows[0].count).toBe(0);
    expect((await fixture.runtime.query("SELECT revision::text FROM agent_usage_state WHERE tenant_id=$1", [scope.tenantId])).rows[0].revision).toBe("2");
  });

  it.each(["associate-agent-usage", "remove-agent-usage-association"])("admits %s audits only as reporting actions with no blocked state", async action => {
    const event = (blocked: boolean | null) => fixture.runtime.query(`
      INSERT INTO audit_events(id,event_id,operation_id,tenant_id,principal_id,actor_username,actor_name,scope,
        action,target_blocked_state,agent_id,started_at,status,request_path)
      VALUES(gen_random_uuid(),$1,'association-fixture','tenant','principal','fixture@example.invalid','Fixture',
        'single',$2,$3,'agent:fixture',clock_timestamp(),'started','/fixture')`, [randomUUID(), action, blocked]);
    await event(null);
    for (const blocked of [true, false]) await expect(event(blocked)).rejects.toMatchObject({ code: "23514", constraint: "audit_events_action_state" });
  });
});
