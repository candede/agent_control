import { createHash } from "node:crypto";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { bootstrap, grantRuntime, migrate, retain } from "./database.js";
import { migrations, verifySchema } from "../src/db/schema.js";
import { fixturePassword, testDatabase } from "./testDatabase.js";

let fixture: Awaited<ReturnType<typeof testDatabase>>;
let database: Awaited<ReturnType<typeof testDatabase>>["operator"];
let runtime: Awaited<ReturnType<typeof testDatabase>>["runtime"];

beforeAll(async () => {
  fixture = await testDatabase(false);
  database = fixture.operator;
  runtime = fixture.runtime;
});
afterAll(async () => { await fixture?.close(); });

describe.sequential("PostgreSQL migration and role boundary", () => {
  it("bootstraps the operator/runtime split and upgrades sequentially", async () => {
    await bootstrap(database, fixturePassword);
    await migrate(database, migrations.slice(0, 1));
    await expect(verifySchema(database)).rejects.toThrow("schema");
    await migrate(database);
    await grantRuntime(database);
    await verifySchema(runtime);
  });
  it("serializes duplicate migration commands", async () => {
    await Promise.all([migrate(database), migrate(database)]);
    expect((await database.query("SELECT count(*)::int AS count FROM schema_migrations")).rows[0].count).toBe(migrations.length);
  });
  it("rolls back failure and supports retry", async () => {
    await expect(migrate(database, [...migrations, { version: migrations.length + 1, sql: "CREATE TABLE rollback_probe(id int); SELECT missing_function()" }])).rejects.toThrow();
    expect((await database.query("SELECT to_regclass('rollback_probe') AS name")).rows[0].name).toBeNull();
    await migrate(database);
  });
  it("rejects modified and newer schemas", async () => {
    await expect(migrate(database, [{ version: 1, sql: "SELECT 1" }])).rejects.toThrow("modified");
    await database.query("INSERT INTO schema_migrations VALUES (999,'unknown',clock_timestamp())");
    await expect(verifySchema(runtime)).rejects.toThrow("schema");
    await expect(migrate(database)).rejects.toThrow("Unknown");
    await database.query("DELETE FROM schema_migrations WHERE version=999");
  });
  it("denies runtime DDL, audit mutation, receipt access and escalation", async () => {
    for (const sql of ["CREATE TABLE forbidden(id int)", "DELETE FROM audit_events", "UPDATE audit_events SET message='changed'", "TRUNCATE audit_events", "SELECT * FROM legacy_audit_imports", "SET ROLE agentcontrol_admin"]) {
      await expect(runtime.query(sql)).rejects.toThrow();
    }
    await retain(database);
    await verifySchema(runtime);
  });

  it("grants runtime access to capability state without exposing migration authority", async () => {
    await runtime.query("INSERT INTO capability_configuration(tenant_id,capability_id,updated_by) VALUES ('tenant','graph.package.read.application','administrator')");
    await runtime.query(`INSERT INTO capability_evidence(tenant_id,principal_id,authorization_principal_id,capability_id,resource_audience,environment_id,token_mode,permission_revision,contract_revision,configuration_revision,status,expires_at)
      VALUES ('tenant','principal','principal','graph.package.read.delegated','https://graph.microsoft.com','global','delegated','permission-revision','contract-revision',1,'unknown',clock_timestamp()+interval '5 minutes')`);
    expect((await runtime.query("SELECT count(*)::int AS count FROM capability_evidence")).rows[0].count).toBe(1);
    await expect(runtime.query("ALTER TABLE capability_evidence ADD COLUMN forbidden text")).rejects.toThrow();
    expect((await runtime.query("SELECT mode,provider_work_enabled FROM operational_state")).rows[0]).toEqual({mode:"normal",provider_work_enabled:true});
    for (const sql of ["UPDATE operational_state SET mode='maintenance'", "DELETE FROM operational_state", "TRUNCATE operational_state"]) {
      await expect(runtime.query(sql)).rejects.toThrow();
    }
  });

  it("performs operator-only finite retention without runtime audit deletion", async () => {
    await database.query("INSERT INTO audit_events(id,event_id,operation_id,tenant_id,principal_id,actor_username,actor_name,scope,action,target_blocked_state,agent_id,started_at,observed_at,status,request_path) VALUES (gen_random_uuid(),'expired','fixture','tenant','principal','fixture@example.invalid','Fixture','single','block',true,'fixture',clock_timestamp()-interval '91 days',clock_timestamp()-interval '91 days','started','/fixture')");
    await database.query("INSERT INTO sessions(sid,sess,expire) VALUES ('expired','{}',clock_timestamp()-interval '1 second')");
    await database.query("INSERT INTO source_identifiers(id,tenant_id,source,identifier_kind,identifier_value) VALUES (gen_random_uuid(),'tenant','graph_packages','package_id','unused')");
    await database.query("UPDATE capability_evidence SET expires_at=clock_timestamp()-interval '1 second'");
    await database.query(`INSERT INTO package_mutation_qualifications
      (id,tenant_id,target_id,target_type,action,actor_principal_id,actor_name,approved_by,contract_revision,configuration_revision,auth_mode,prestate,poststate,restoration_criteria,status,qualified_at,expires_at,restored_at)
      VALUES (gen_random_uuid(),'tenant','expired-package','copilot_package','unblock','principal','Fixture','approver',repeat('a',64),1,'delegated','{"kind":"block","isBlocked":true}','{"kind":"block","isBlocked":false}','{"touchedFields":["isBlocked"],"requireCurrentEqualsPoststate":true}','failed',clock_timestamp()-interval '2 days',clock_timestamp()-interval '1 day',NULL)`);
    await retain(database);
    for (const table of ["audit_events","sessions","source_identifiers"]) expect((await runtime.query(`SELECT count(*)::int AS count FROM ${table}`)).rows[0].count).toBe(0);
    expect((await runtime.query("SELECT count(*)::int AS count FROM capability_evidence")).rows[0].count).toBe(0);
    expect((await runtime.query("SELECT count(*)::int AS count FROM package_mutation_qualifications")).rows[0].count).toBe(0);
  });

  it("bounds, dry-runs and serializes retention cleanup", async () => {
    await database.query(`INSERT INTO sessions(sid,sess,expire) VALUES
      ('expired-1','{}',clock_timestamp()-interval '1 second'),
      ('expired-2','{}',clock_timestamp()-interval '1 second'),
      ('expired-3','{}',clock_timestamp()-interval '1 second')`);
    const preview = await retain(database,{batchSize:2,dryRun:true});
    expect(preview.dryRun).toBe(true);
    expect(preview.affected.sessions).toBe(2);
    expect((await database.query("SELECT count(*)::int AS count FROM sessions WHERE sid LIKE 'expired-%'")).rows[0].count).toBe(3);
    const owner = await database.connect();
    try {
      await owner.query("SELECT pg_advisory_lock(3650111)");
      await expect(retain(database,{batchSize:2})).rejects.toThrow("owns the database lock");
    } finally {
      await owner.query("SELECT pg_advisory_unlock(3650111)");
      owner.release();
    }
    expect((await retain(database,{batchSize:2})).affected.sessions).toBe(2);
    expect((await retain(database,{batchSize:2})).affected.sessions).toBe(1);
  });
});

describe("Phase 10 and 11 schema upgrades", () => {
  it("preserves nonempty schema 22 through migrations 23-26 with immutable checksums", async () => {
    const upgrade = await testDatabase(false);
    try {
      await bootstrap(upgrade.operator, fixturePassword);
      await migrate(upgrade.operator, migrations.slice(0, 22));
      const original = (await upgrade.operator.query("SELECT version,checksum FROM schema_migrations ORDER BY version")).rows;
      const append = (action: string) => upgrade.operator.query(`INSERT INTO audit_events
        (id,event_id,operation_id,tenant_id,principal_id,actor_username,actor_name,scope,action,target_blocked_state,agent_id,started_at,status,request_path)
        VALUES(gen_random_uuid(),$1,$1,'tenant','principal','fixture@example.invalid','Fixture','bulk',$1,
          CASE WHEN $1='block' THEN true ELSE NULL END,'fixture',clock_timestamp(),'started','/fixture')`, [action]);
      await append("block");
      await migrate(upgrade.operator, migrations.slice(0, 23));
      await append("export-package-inventory");
      await append("export-power-platform-inventory");
      await migrate(upgrade.operator, migrations.slice(0, 24));
      const previous = (await upgrade.operator.query("SELECT version,checksum FROM schema_migrations ORDER BY version")).rows;
      await migrate(upgrade.operator, migrations.slice(0,25));
      expect((await upgrade.operator.query("SELECT to_regclass('operational_state') AS name")).rows[0].name).toBeNull();
      await migrate(upgrade.operator);
      await migrate(upgrade.operator);
      await grantRuntime(upgrade.operator);
      await verifySchema(upgrade.runtime);
      await append("export-official-usage-aggregate");
      await append("export-official-usage-users");
      await append("export-administrative-audit");
      expect((await upgrade.runtime.query("SELECT version,checksum FROM schema_migrations WHERE version<=22 ORDER BY version")).rows).toEqual(original);
      expect((await upgrade.runtime.query("SELECT version,checksum FROM schema_migrations WHERE version<=24 ORDER BY version")).rows).toEqual(previous);
      expect((await upgrade.runtime.query("SELECT action FROM audit_projection ORDER BY action")).rows).toEqual([
        "block", "export-administrative-audit", "export-official-usage-aggregate", "export-official-usage-users", "export-package-inventory", "export-power-platform-inventory",
      ].map(action => ({ action })));
      await expect(upgrade.runtime.query("DELETE FROM audit_events")).rejects.toThrow();
    } finally {
      await upgrade.close();
    }
  });
});

describe("package mutation audit upgrades", () => {
  it("preserves schema 7 durable jobs and items while adding confirmation, reconciliation, and requested audit evidence", async () => {
    const upgradeFixture = await testDatabase(false);
    try {
      await bootstrap(upgradeFixture.operator, fixturePassword);
      await migrate(upgradeFixture.operator, migrations.slice(0, 7));
      const job = (await upgradeFixture.operator.query<{ id: string }>(`INSERT INTO jobs
        (id,tenant_id,principal_id,token_mode,capability,action,request_hash,idempotency_key,actor_name,actor_username,request_path,scope)
        VALUES (gen_random_uuid(),'tenant','principal','delegated','graph.package.block.manage','block',repeat('a',64),'schema-7-job','Fixture','fixture@example.invalid','/api/agents/block','bulk') RETURNING id`)).rows[0];
      await upgradeFixture.operator.query(`INSERT INTO job_items(id,job_id,target_id,display_name,ordinal,status)
        VALUES (gen_random_uuid(),$1,'package-1','Package 1',0,'queued')`, [job.id]);

      await migrate(upgradeFixture.operator);
      await grantRuntime(upgradeFixture.operator);
      await verifySchema(upgradeFixture.runtime);

      expect((await upgradeFixture.runtime.query("SELECT action,confirmation_hash,confirmation_summary,confirmed_at,reassign_user_id FROM jobs WHERE id=$1", [job.id])).rows).toEqual([{
        action: "block", confirmation_hash: null, confirmation_summary: null, confirmed_at: null, reassign_user_id: null,
      }]);
      expect((await upgradeFixture.runtime.query("SELECT target_id,prestate_hash,prestate,poststate_hash,poststate,reconciliation_status,reconciled_at FROM job_items WHERE job_id=$1", [job.id])).rows).toEqual([{
        target_id: "package-1", prestate_hash: null, prestate: null, poststate_hash: null, poststate: null, reconciliation_status: "not_required", reconciled_at: null,
      }]);
      expect((await upgradeFixture.runtime.query("SELECT to_regclass('package_mutation_qualifications') AS name")).rows[0].name).toBe("package_mutation_qualifications");
      await upgradeFixture.runtime.query(`INSERT INTO audit_events
        (id,event_id,operation_id,tenant_id,principal_id,actor_username,actor_name,scope,action,target_blocked_state,agent_id,started_at,status,request_path)
        VALUES (gen_random_uuid(),'requested-upgrade','requested-upgrade','tenant','principal','fixture@example.invalid','Fixture','single','block',true,'package-1',clock_timestamp(),'requested','/fixture')`);
      expect((await upgradeFixture.runtime.query("SELECT status FROM audit_projection WHERE event_id='requested-upgrade'")).rows).toEqual([{ status: "requested" }]);
    } finally {
      await upgradeFixture.close();
    }
  });
});

describe("migration 13 official usage foundation", () => {
  it("upgrades a nonempty schema 12 database without changing earlier data and grants bounded runtime access", async () => {
    const upgradeFixture = await testDatabase(false);
    try {
      await bootstrap(upgradeFixture.operator, fixturePassword);
      await migrate(upgradeFixture.operator, migrations.slice(0, 12));
      const preserved = await upgradeFixture.operator.query<{ id: string }>(`INSERT INTO package_refresh_jobs
        (id,tenant_id,principal_id,authorization_principal_id,token_mode,idempotency_key,request_hash,query_hash,scope_kind,requested_ids,status)
        VALUES (gen_random_uuid(),'tenant','reader','reader','delegated','usage-upgrade',repeat('a',64),repeat('b',64),'broad','[]','succeeded') RETURNING id`);

      await migrate(upgradeFixture.operator);
      await grantRuntime(upgradeFixture.operator);
      await verifySchema(upgradeFixture.runtime);

      expect((await upgradeFixture.runtime.query("SELECT id FROM package_refresh_jobs WHERE id=$1", [preserved.rows[0].id])).rowCount).toBe(1);
      expect((await upgradeFixture.runtime.query("SELECT to_regclass('official_usage_staging') AS staging,to_regclass('official_usage_versions') AS versions,to_regclass('official_usage_sets') AS sets")).rows[0]).toEqual({
        staging: "official_usage_staging",
        versions: "official_usage_versions",
        sets: "official_usage_sets",
      });
      await upgradeFixture.runtime.query("INSERT INTO official_usage_state(tenant_id) VALUES ('tenant')");
      expect((await upgradeFixture.runtime.query("SELECT revision FROM official_usage_state WHERE tenant_id='tenant'")).rows).toEqual([{ revision: "1" }]);
      await expect(upgradeFixture.runtime.query("DROP TABLE official_usage_staging")).rejects.toThrow();
    } finally {
      await upgradeFixture.close();
    }
  });
});

describe("migration 14 official usage retention and immutability repair", () => {
  it("upgrades schema 13 without rewriting it and decouples accepted provenance from staging lifetime", async () => {
    const upgradeFixture = await testDatabase(false);
    try {
      await bootstrap(upgradeFixture.operator, fixturePassword);
      await migrate(upgradeFixture.operator, migrations.slice(0, 13));
      const stagingId = (await upgradeFixture.operator.query<{ id: string }>(`INSERT INTO official_usage_staging
        (id,tenant_id,actor_principal_id,kind,file_hash,parser_version,schema_version,bundle_id,reporting_start,reporting_end,
         period_provenance,source_as_of_provenance,source_freshness,row_count,stored_bytes,active_revision)
        VALUES(gen_random_uuid(),'tenant','administrator','agents',repeat('a',64),'1','fixture',gen_random_uuid(),
          '2026-06-07','2026-07-06','operator_asserted','absent','unknown',0,2,1) RETURNING id`)).rows[0].id;

      await migrate(upgradeFixture.operator);
      await grantRuntime(upgradeFixture.operator);
      await verifySchema(upgradeFixture.runtime);

      expect((await upgradeFixture.operator.query(`SELECT count(*)::int AS count FROM pg_constraint
        WHERE conrelid='official_usage_versions'::regclass AND confrelid='official_usage_staging'::regclass`)).rows)
        .toEqual([{ count: 0 }]);
      expect((await upgradeFixture.runtime.query("SELECT actor_principal_id FROM official_usage_sets")).rows).toEqual([]);
      await upgradeFixture.runtime.query("DELETE FROM official_usage_staging WHERE id=$1", [stagingId]);
      await upgradeFixture.runtime.query("INSERT INTO official_usage_state(tenant_id) VALUES('tenant')");
      await expect(upgradeFixture.runtime.query("UPDATE official_usage_state SET revision=revision+2 WHERE tenant_id='tenant'"))
        .rejects.toThrow("selection revision");
    } finally {
      await upgradeFixture.close();
    }
  });
});

describe("migration 15 official usage publication receipts and content closure", () => {
  it("upgrades nonempty schema 14, preserves content, grants finite receipts, and blocks published row appends", async () => {
    const upgradeFixture = await testDatabase(false);
    try {
      await bootstrap(upgradeFixture.operator, fixturePassword);
      await migrate(upgradeFixture.operator, migrations.slice(0, 14));
      const ids = (await upgradeFixture.operator.query<{ staging_id: string; artifact_id: string; set_id: string; version_id: string; bundle_id: string }>(`SELECT
        gen_random_uuid() AS staging_id,gen_random_uuid() AS artifact_id,gen_random_uuid() AS set_id,
        gen_random_uuid() AS version_id,gen_random_uuid() AS bundle_id`)).rows[0];
      await upgradeFixture.operator.query(`INSERT INTO official_usage_staging
        (id,tenant_id,actor_principal_id,status,kind,file_hash,parser_version,schema_version,bundle_id,
         reporting_start,reporting_end,period_provenance,source_as_of_provenance,source_freshness,row_count,stored_bytes,
         active_revision,accepted_version_id,accepted_set_id,accepted_result_revision,accepted_at)
        VALUES($1,'tenant-15','administrator','accepted','agents',repeat('a',64),'1','fixture',$2,
          '2026-06-07','2026-07-06','operator_asserted','absent','unknown',1,2,1,$3,$4,2,clock_timestamp())`,
      [ids.staging_id, ids.bundle_id, ids.version_id, ids.set_id]);
      await upgradeFixture.operator.query(`INSERT INTO official_usage_artifacts(id,tenant_id,kind,file_hash,parser_version,schema_version)
        VALUES($1,'tenant-15','agents',repeat('a',64),'1','fixture')`, [ids.artifact_id]);
      await upgradeFixture.operator.query(`INSERT INTO official_usage_sets
        (id,tenant_id,bundle_id,actor_principal_id,reporting_start,reporting_end,complete,accepted_at)
        VALUES($1,'tenant-15',$2,'administrator','2026-06-07','2026-07-06',true,clock_timestamp())`, [ids.set_id, ids.bundle_id]);
      await upgradeFixture.operator.query(`INSERT INTO official_usage_versions
        (id,tenant_id,artifact_id,staging_id,kind,reporting_start,reporting_end,period_provenance,
         source_as_of_provenance,source_freshness,row_count,accepted_by)
        VALUES($1,'tenant-15',$2,$3,'agents','2026-06-07','2026-07-06','operator_asserted','absent','unknown',1,'administrator')`,
      [ids.version_id, ids.artifact_id, ids.staging_id]);
      await upgradeFixture.operator.query(`INSERT INTO official_usage_version_rows(version_id,tenant_id,kind,ordinal,row_data)
        VALUES($1,'tenant-15','agents',0,'{}')`, [ids.version_id]);
      await upgradeFixture.operator.query(`INSERT INTO official_usage_set_versions(set_id,tenant_id,kind,version_id)
        VALUES($1,'tenant-15','agents',$2)`, [ids.set_id, ids.version_id]);

      await migrate(upgradeFixture.operator);
      await grantRuntime(upgradeFixture.operator);
      await verifySchema(upgradeFixture.runtime);

      expect((await upgradeFixture.runtime.query("SELECT count(*)::int AS count FROM official_usage_version_rows WHERE version_id=$1", [ids.version_id])).rows[0].count).toBe(1);
      await expect(upgradeFixture.runtime.query(`INSERT INTO official_usage_version_rows(version_id,tenant_id,kind,ordinal,row_data)
        VALUES($1,'tenant-15','agents',1,'{}')`, [ids.version_id])).rejects.toThrow("published or deleted");
      await upgradeFixture.runtime.query(`INSERT INTO official_usage_bundle_receipts
        (tenant_id,actor_principal_id,bundle_id,bundle_hash,expected_active_revision,result_set_id,result_version_id,result_active_revision,result_complete)
        VALUES('tenant-15','administrator',$1,repeat('b',64),1,$2,$3,2,true)`, [ids.bundle_id, ids.set_id, ids.version_id]);
      expect((await upgradeFixture.runtime.query("SELECT result_set_id FROM official_usage_bundle_receipts WHERE tenant_id='tenant-15'")).rows).toEqual([{ result_set_id: ids.set_id }]);
      await expect(upgradeFixture.runtime.query("UPDATE official_usage_bundle_receipts SET result_complete=false WHERE tenant_id='tenant-15'")).rejects.toThrow();
      await upgradeFixture.operator.query("UPDATE official_usage_bundle_receipts SET expires_at=clock_timestamp()-interval '1 second' WHERE tenant_id='tenant-15'");
      await retain(upgradeFixture.operator);
      expect((await upgradeFixture.runtime.query("SELECT count(*)::int AS count FROM official_usage_bundle_receipts WHERE tenant_id='tenant-15'")).rows[0].count).toBe(0);
      expect((await upgradeFixture.runtime.query("SELECT count(*)::int AS count FROM official_usage_version_rows WHERE version_id=$1", [ids.version_id])).rows[0].count).toBe(1);
    } finally {
      await upgradeFixture.close();
    }
  });
});

describe("migration 11 durable canary cycle upgrade", () => {
  it("invalidates old qualifying rows and marks interrupted version 2 restoration inconclusive", async () => {
    const upgradeFixture = await testDatabase(false);
    try {
      await bootstrap(upgradeFixture.operator, fixturePassword);
      await migrate(upgradeFixture.operator, migrations.slice(0, 9));
      await upgradeFixture.operator.query(`INSERT INTO package_mutation_qualifications
        (id,tenant_id,target_id,target_type,action,actor_principal_id,actor_name,approved_by,contract_revision,configuration_revision,auth_mode,prestate,poststate,restoration_criteria,status,expires_at,restored_at)
        VALUES (gen_random_uuid(),'tenant','legacy-canary','copilot_package','block','legacy-actor','Legacy actor','Legacy approver',repeat('a',64),1,'delegated',
          '{"kind":"block","isBlocked":false}','{"kind":"block","isBlocked":true}','{"touchedFields":["isBlocked"],"requireCurrentEqualsPoststate":true}',
          'qualified',clock_timestamp()+interval '1 day',clock_timestamp())`);
      await migrate(upgradeFixture.operator, migrations.slice(0, 10));
      await upgradeFixture.operator.query(`INSERT INTO package_mutation_qualifications
        (id,tenant_id,target_id,target_type,action,actor_principal_id,actor_name,approved_by,approved_by_principal_id,contract_revision,configuration_revision,auth_mode,prestate,poststate,restoration_criteria,status,expires_at,workflow_version,correlation_id,attempted_at)
        VALUES (gen_random_uuid(),'tenant','interrupted-v2','copilot_package','unblock','operator','Operator','Approver','administrator',repeat('b',64),2,'delegated',
          '{"kind":"block","isBlocked":true}','{"kind":"block","isBlocked":false}','{"touchedFields":["isBlocked"],"requireCurrentEqualsPoststate":true}',
          'restoring',clock_timestamp()+interval '1 day',2,gen_random_uuid(),clock_timestamp())`);

      await migrate(upgradeFixture.operator);
      await grantRuntime(upgradeFixture.operator);
      await verifySchema(upgradeFixture.runtime);

      expect((await upgradeFixture.runtime.query(`SELECT target_id,status,workflow_version,error_code,paired_qualification_id,job_id,cycle_stage
        FROM package_mutation_qualifications ORDER BY target_id`)).rows).toEqual([
        { target_id: "interrupted-v2", status: "inconclusive", workflow_version: 2, error_code: "workflow_invalidated", paired_qualification_id: null, job_id: null, cycle_stage: null },
        { target_id: "legacy-canary", status: "expired", workflow_version: 1, error_code: null, paired_qualification_id: null, job_id: null, cycle_stage: null },
      ]);
      expect((await upgradeFixture.runtime.query("SELECT count(*)::int AS count FROM schema_migrations")).rows[0].count).toBe(migrations.length);
    } finally {
      await upgradeFixture.close();
    }
  });
});

describe("migration 3 upgrade", () => {
  it("converts legacy block and access jobs from schema version 2", async () => {
    const upgradeFixture = await testDatabase(false);
    try {
      await bootstrap(upgradeFixture.operator, fixturePassword);
      await migrate(upgradeFixture.operator, migrations.slice(0, 2));
      await upgradeFixture.operator.query(`INSERT INTO jobs(id,tenant_id,principal_id,token_mode,capability,action,request_hash,idempotency_key,actor_name,actor_username,request_path,scope)
        VALUES (gen_random_uuid(),'tenant','principal','delegated','package_controls','block',repeat('a',64),'block-key','Fixture','fixture@example.invalid','/fixture','single'),
               (gen_random_uuid(),'tenant','principal','delegated','package_controls','update-availability',repeat('b',64),'access-key','Fixture','fixture@example.invalid','/fixture','single')`);

      await migrate(upgradeFixture.operator);
      expect((await upgradeFixture.operator.query("SELECT action,capability FROM jobs ORDER BY action")).rows).toEqual([
        { action: "block", capability: "graph.package.block.manage" },
        { action: "update-availability", capability: "graph.package.access.manage" },
      ]);
      await migrate(upgradeFixture.operator);
      await verifySchema(upgradeFixture.operator);
    } finally {
      await upgradeFixture.close();
    }
  });
});

describe("migration 4 capability evidence upgrade", () => {
  it("retires incomplete evidence while preserving durable configuration", async () => {
    const upgradeFixture = await testDatabase(false);
    try {
      await bootstrap(upgradeFixture.operator, fixturePassword);
      await migrate(upgradeFixture.operator, migrations.slice(0, 3));
      await upgradeFixture.operator.query("INSERT INTO capability_configuration(tenant_id,capability_id,updated_by) VALUES ('tenant','graph.package.read.application','administrator')");
      await upgradeFixture.operator.query(`INSERT INTO capability_evidence(tenant_id,principal_id,capability_id,resource_audience,token_mode,permission_revision,configuration_revision,status,expires_at)
        VALUES ('tenant','application-id','graph.package.read.application','https://graph.microsoft.com','application','old-revision',1,'available',clock_timestamp()+interval '5 minutes')`);

      await migrate(upgradeFixture.operator);
      expect((await upgradeFixture.operator.query("SELECT count(*)::int AS count FROM capability_evidence")).rows[0].count).toBe(0);
      expect((await upgradeFixture.operator.query("SELECT enabled,revision FROM capability_configuration")).rows).toEqual([{ enabled: false, revision: 1 }]);
      await migrate(upgradeFixture.operator);
      await verifySchema(upgradeFixture.operator);
    } finally {
      await upgradeFixture.close();
    }
  });
});

describe("migration 6 inventory retention upgrade", () => {
  for (const priorVersion of [4, 5]) {
    it(`upgrades schema ${priorVersion} and decouples seven-day jobs from retained snapshots`, async () => {
      const upgradeFixture = await testDatabase(false);
      try {
        await bootstrap(upgradeFixture.operator, fixturePassword);
        await migrate(upgradeFixture.operator, migrations.slice(0, priorVersion));
        if (priorVersion === 5) {
          const job = (await upgradeFixture.operator.query<{ id: string }>(`INSERT INTO power_platform_refresh_jobs(id,tenant_id,principal_id,idempotency_key,request_hash,role_scope,requested_types,status)
            VALUES(gen_random_uuid(),'tenant','principal','upgrade',repeat('a',64),'full','["microsoft.copilotstudio/agents"]','succeeded') RETURNING id`)).rows[0].id;
          await upgradeFixture.operator.query(`INSERT INTO power_platform_inventory_snapshots(id,job_id,tenant_id,principal_id,query_hash,role_scope,requested_types,coverage,observed_count,total_records,page_count,unknown_field_count)
            VALUES(gen_random_uuid(),$1,'tenant','principal',repeat('a',64),'full','["microsoft.copilotstudio/agents"]',$2,0,0,1,0)`, [job, JSON.stringify(Array.from({ length: 11 }, () => ({ type: "fixture", status: "unknown", count: null })))]);
        }

        await migrate(upgradeFixture.operator);
        await grantRuntime(upgradeFixture.operator);
        await verifySchema(upgradeFixture.runtime);
        if (priorVersion === 5) {
          await upgradeFixture.operator.query("DELETE FROM power_platform_refresh_jobs");
          expect((await upgradeFixture.operator.query("SELECT job_id FROM power_platform_inventory_snapshots")).rows).toEqual([{ job_id: null }]);
        }
      } finally {
        await upgradeFixture.close();
      }
    });
  }
});

describe("migration 17 Purview result scope upgrade", () => {
  it("upgrades populated principal rows and enforces application revision relationships", async () => {
    const upgradeFixture = await testDatabase(false);
    try {
      await bootstrap(upgradeFixture.operator, fixturePassword);
      await migrate(upgradeFixture.operator, migrations.slice(0, 16));
      const qualificationId = "11111111-1111-4111-8111-111111111111";
      const jobId = "22222222-2222-4222-8222-222222222222";
      const filters = { presetId: "copilot_interactions", startDateTime: "2026-09-09T10:00:00.000Z", endDateTime: "2026-09-09T11:00:00.000Z",
        userPrincipalNames: [], ipAddresses: [], objectIds: [], administrativeUnitIds: [] };
      await upgradeFixture.operator.query(`INSERT INTO purview_audit_qualifications
        (id,tenant_id,authorization_principal_id,result_principal_id,token_mode,capability_id,filters,request_hash,contract_revision,permission_revision,configuration_revision,approved_by)
        VALUES($1,'tenant','principal','principal','delegated','purview.audit.search.delegated',$2,repeat('a',64),repeat('b',64),repeat('c',64),1,'administrator')`,
      [qualificationId, filters]);
      await upgradeFixture.operator.query(`INSERT INTO purview_audit_jobs
        (id,tenant_id,authorization_principal_id,result_principal_id,token_mode,idempotency_key,request_hash,display_name,filters,provider_correlation_id,qualification_id,status)
        VALUES($1,'tenant','principal','principal','delegated','upgrade',repeat('a',64),$2,$3,gen_random_uuid(),$4,'succeeded')`,
      [jobId, `agent-control-audit:${jobId}`, filters, qualificationId]);
      await upgradeFixture.operator.query("UPDATE purview_audit_qualifications SET job_id=$2 WHERE id=$1", [qualificationId, jobId]);
      await upgradeFixture.operator.query(`INSERT INTO purview_audit_records
        (job_id,tenant_id,result_principal_id,wrapper_id,event_time,audit_log_record_type,operation,service,administrative_units,messages,unknown_field_count)
        VALUES($1,'tenant','principal','wrapper','2026-09-09T10:30:00Z','copilotInteraction','CopilotInteraction','Copilot','[]','[]',0)`, [jobId]);

      await migrate(upgradeFixture.operator);
      const upgradedFilters = { presetId: "copilot_interactions", operations: ["CopilotInteraction"], startDateTime: "2026-09-09T10:00:00.000Z", endDateTime: "2026-09-09T11:00:00.000Z",
        userPrincipalNames: [], ipAddresses: [], objectIds: [], administrativeUnitIds: [] };
      const expectedHash = createHash("sha256").update(JSON.stringify({ cloud: "global", tenantId: "tenant", authorizationPrincipalId: "principal",
        resultScope: { kind: "principal", scopeId: "principal", configurationRevision: null }, tokenMode: "delegated", filters: upgradedFilters })).digest("hex");
      expect((await upgradeFixture.operator.query("SELECT filters->'operations' AS operations,result_scope_configuration_key AS scope_key,request_hash FROM purview_audit_jobs WHERE id=$1", [jobId])).rows)
        .toEqual([{ operations: ["CopilotInteraction"], scope_key: "0", request_hash: expectedHash }]);
      expect((await upgradeFixture.operator.query("SELECT request_hash FROM purview_audit_qualifications WHERE id=$1", [qualificationId])).rows)
        .toEqual([{ request_hash: expectedHash }]);
      const applicationOne = "33333333-3333-4333-8333-333333333333";
      const applicationTwo = "44444444-4444-4444-8444-444444444444";
      for (const [id, revision] of [[applicationOne, 7], [applicationTwo, 8]] as const) {
        await upgradeFixture.operator.query(`INSERT INTO purview_audit_jobs
          (id,tenant_id,authorization_principal_id,result_scope_id,result_scope_kind,result_scope_configuration_revision,token_mode,idempotency_key,request_hash,display_name,filters,local_request_id,status)
          VALUES($1,'tenant','principal','application','application',$2,'application','same-key',repeat('d',64),$3,$4,gen_random_uuid(),'succeeded')`,
        [id, revision, `agent-control-audit:${id}`, { ...filters, operations: ["CopilotInteraction"] }]);
      }
      await expect(upgradeFixture.operator.query(`INSERT INTO purview_audit_records
        (job_id,tenant_id,result_scope_id,result_scope_kind,result_scope_configuration_revision,wrapper_id,event_time,audit_log_record_type,operation,service,administrative_units,messages,unknown_field_count)
        VALUES($1,'tenant','application','application',8,'wrong-revision','2026-09-09T10:30:00Z','copilotInteraction','CopilotInteraction','Copilot','[]','[]',0)`, [applicationOne])).rejects.toThrow();
      await upgradeFixture.operator.query("DELETE FROM purview_audit_jobs WHERE id=$1", [jobId]);
      expect((await upgradeFixture.operator.query("SELECT job_id FROM purview_audit_qualifications WHERE id=$1", [qualificationId])).rows).toEqual([{ job_id: null }]);
      await verifySchema(upgradeFixture.operator);
    } finally {
      await upgradeFixture.close();
    }
  });
});

describe("migration 18 Defender hunting foundation", () => {
  it("upgrades a populated schema 17 without changing Purview rows and grants bounded hunting access", async () => {
    const upgradeFixture = await testDatabase(false);
    try {
      await bootstrap(upgradeFixture.operator, fixturePassword);
      await migrate(upgradeFixture.operator, migrations.slice(0, 17));
      const purviewJobId = "55555555-5555-4555-8555-555555555555";
      const filters = { presetId: "copilot_interactions", operations: ["CopilotInteraction"], startDateTime: "2026-09-09T10:00:00.000Z",
        endDateTime: "2026-09-09T11:00:00.000Z", userPrincipalNames: [], ipAddresses: [], objectIds: [], administrativeUnitIds: [] };
      await upgradeFixture.operator.query(`INSERT INTO purview_audit_jobs
        (id,tenant_id,authorization_principal_id,result_scope_id,result_scope_kind,token_mode,idempotency_key,request_hash,display_name,filters,local_request_id,status)
        VALUES($1,'tenant','principal','principal','principal','delegated','phase-08-upgrade',repeat('a',64),$2,$3,gen_random_uuid(),'succeeded')`,
      [purviewJobId, `agent-control-audit:${purviewJobId}`, filters]);

      await migrate(upgradeFixture.operator);
      await grantRuntime(upgradeFixture.operator);
      await verifySchema(upgradeFixture.runtime);

      expect((await upgradeFixture.runtime.query("SELECT id,status,filters FROM purview_audit_jobs WHERE id=$1", [purviewJobId])).rows)
        .toEqual([{ id: purviewJobId, status: "succeeded", filters }]);
      expect((await upgradeFixture.runtime.query("SELECT to_regclass('defender_hunting_jobs') AS jobs,to_regclass('defender_hunting_snapshots') AS snapshots,to_regclass('defender_hunting_rows') AS rows")).rows)
        .toEqual([{ jobs: "defender_hunting_jobs", snapshots: "defender_hunting_snapshots", rows: "defender_hunting_rows" }]);
      await upgradeFixture.runtime.query(`INSERT INTO defender_hunting_jobs
        (id,tenant_id,authorization_principal_id,result_scope_id,result_scope_kind,token_mode,template_id,idempotency_key,request_hash,filters,local_request_id)
        VALUES(gen_random_uuid(),'tenant','security','security','principal','delegated','agents_inventory','upgrade-runtime',repeat('b',64),$1,gen_random_uuid())`,
      [{ templateId: "agents_inventory", startDateTime: "2026-09-09T10:00:00.000Z", endDateTime: "2026-09-09T11:00:00.000Z", agentIds: [], blueprintIds: [], actorObjectIds: [], operations: [] }]);
      await expect(upgradeFixture.runtime.query("ALTER TABLE defender_hunting_jobs ADD COLUMN forbidden text")).rejects.toThrow();
    } finally {
      await upgradeFixture.close();
    }
  });
});

describe("migration 22 Copilot Studio quarantine foundation", () => {
  it("upgrades populated schema 21, keeps qualification beyond job expiry, and enforces runtime grants", async () => {
    const upgradeFixture = await testDatabase(false);
    try {
      await bootstrap(upgradeFixture.operator, fixturePassword);
      await migrate(upgradeFixture.operator, migrations.slice(0, 21));
      const huntingJobId = (await upgradeFixture.operator.query<{ id: string }>(`INSERT INTO defender_hunting_jobs
        (id,tenant_id,authorization_principal_id,result_scope_id,result_scope_kind,token_mode,template_id,idempotency_key,request_hash,filters,local_request_id,status)
        VALUES(gen_random_uuid(),'tenant-22','security','security','principal','delegated','agents_inventory','phase-09-upgrade',repeat('a',64),$1,gen_random_uuid(),'waiting_authorization') RETURNING id`,
      [{ templateId: "agents_inventory", startDateTime: "2026-09-09T10:00:00.000Z", endDateTime: "2026-09-09T11:00:00.000Z", agentIds: [], blueprintIds: [], actorObjectIds: [], operations: [] }])).rows[0].id;

      await migrate(upgradeFixture.operator);
      await grantRuntime(upgradeFixture.operator);
      await verifySchema(upgradeFixture.runtime);

      expect((await upgradeFixture.runtime.query("SELECT id FROM defender_hunting_jobs WHERE id=$1", [huntingJobId])).rowCount).toBe(1);
      expect((await upgradeFixture.runtime.query(`SELECT to_regclass('copilot_quarantine_jobs') AS jobs,
        to_regclass('copilot_quarantine_status_observations') AS observations,
        to_regclass('copilot_quarantine_qualifications') AS qualifications`)).rows[0]).toEqual({
        jobs: "copilot_quarantine_jobs",
        observations: "copilot_quarantine_status_observations",
        qualifications: "copilot_quarantine_qualifications",
      });

      const jobIds = (await upgradeFixture.runtime.query<{ original_id: string; restoration_id: string }>(`SELECT gen_random_uuid() AS original_id,gen_random_uuid() AS restoration_id`)).rows[0];
      for (const [id, key, action] of [[jobIds.original_id, "original", "quarantine"], [jobIds.restoration_id, "restoration", "unquarantine"]] as const) {
        await upgradeFixture.runtime.query(`INSERT INTO copilot_quarantine_jobs
          (id,tenant_id,principal_id,idempotency_key,request_hash,action,status,confirmation_hash,confirmation_summary,
           actor_name,actor_username,request_path,contract_revision,permission_revision,configuration_revision,is_canary,canary_approval_id,expires_at)
          VALUES($1,'tenant-22','operator',$2,repeat('a',64),$3,'succeeded',repeat('b',64),'{}','Operator','operator@example.invalid',
            '/api/quarantine/canary',repeat('c',64),repeat('d',64),1,true,gen_random_uuid(),clock_timestamp()-interval '1 second')`, [id, key, action]);
      }
      await upgradeFixture.runtime.query(`INSERT INTO copilot_quarantine_qualifications
        (id,tenant_id,target_environment_id,target_bot_id,original_approval_id,restoration_approval_id,original_job_id,restoration_job_id,
         contract_revision,permission_revision,configuration_revision,auth_mode)
        VALUES(gen_random_uuid(),'tenant-22','11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222',
          gen_random_uuid(),gen_random_uuid(),$1,$2,repeat('c',64),repeat('d',64),1,'delegated')`, [jobIds.original_id, jobIds.restoration_id]);
      await retain(upgradeFixture.operator);
      expect((await upgradeFixture.runtime.query("SELECT count(*)::int AS count FROM copilot_quarantine_jobs")).rows[0].count).toBe(0);
      expect((await upgradeFixture.runtime.query("SELECT original_job_id,restoration_job_id FROM copilot_quarantine_qualifications")).rows)
        .toEqual([{ original_job_id: jobIds.original_id, restoration_job_id: jobIds.restoration_id }]);
      await expect(upgradeFixture.runtime.query("DELETE FROM copilot_quarantine_qualifications")).rejects.toThrow();
      await expect(upgradeFixture.runtime.query("DELETE FROM copilot_quarantine_audit")).rejects.toThrow();
      await upgradeFixture.operator.query("UPDATE copilot_quarantine_qualifications SET expires_at=clock_timestamp()-interval '1 second'");
      await retain(upgradeFixture.operator);
      expect((await upgradeFixture.runtime.query("SELECT count(*)::int AS count FROM copilot_quarantine_qualifications")).rows[0].count).toBe(0);
    } finally {
      await upgradeFixture.close();
    }
  });
});