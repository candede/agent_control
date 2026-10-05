import pg from "pg";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { bootstrap, grantRuntime, initializeSchema, preflightSchema, retain, retainOfficialReportReceipts, retainUntilConverged } from "./database.js";
import { schemaFingerprint, verifySchema } from "../src/db/schema.js";
import { fixturePassword, testDatabase } from "./testDatabase.js";
import { seedDisjointReportUnion } from "./officialReportFixtures.js";

let fixture: Awaited<ReturnType<typeof testDatabase>>;
let database: Awaited<ReturnType<typeof testDatabase>>["operator"];
let runtime: Awaited<ReturnType<typeof testDatabase>>["runtime"];

beforeAll(async () => {
  fixture = await testDatabase(false);
  database = fixture.operator;
  runtime = fixture.runtime;
});
afterAll(async () => { await fixture?.close(); });

describe.sequential("PostgreSQL initialization and role boundary", () => {
  it("verifies bounded convergence once while fencing initialization on its single connection",async () => {
    const isolated = await testDatabase();
    const contender = new pg.Pool({ ...isolated.operator.options,max: 1 });
    let checks = 0;
    const wrapped = new WeakSet<pg.PoolClient>();
    isolated.operator.on("acquire",(client: pg.PoolClient) => {
      if (wrapped.has(client)) return;
      wrapped.add(client);
      const original = client.query;
      client.query = function(this: pg.PoolClient,...args: unknown[]) {
        const sql = typeof args[0]==="string" ? args[0] : (args[0] as { text?: string })?.text ?? "";
        if (/SELECT singleton,\s*fingerprint,\s*initialized_at IS NOT NULL AS initialized FROM public\.app_schema/.test(sql)) checks++;
        return Reflect.apply(original,this,args);
      } as typeof client.query;
    });
    const blocker = await contender.connect();
    try {
      expect((await retainUntilConverged(isolated.operator,{ batchSize: 250 })).passes).toBeGreaterThanOrEqual(2);
      expect(checks).toBe(1);
      expect(isolated.operator.totalCount).toBe(1);
      await blocker.query("BEGIN");
      expect((await blocker.query("SELECT pg_try_advisory_xact_lock(3650101) AS acquired")).rows[0].acquired).toBe(true);
      await expect(retainUntilConverged(isolated.operator,{ batchSize: 250 })).rejects.toThrow("Schema initialization owns");
      expect(checks).toBe(1);
      await blocker.query("ROLLBACK");
      await retainUntilConverged(isolated.operator,{ batchSize: 250 });
      expect(checks).toBe(2);
    } finally {
      await blocker.query("ROLLBACK"); blocker.release();
      await contender.end(); await isolated.close();
    }
  });

  it("bootstraps the operator/runtime split and initializes the current fingerprint", async () => {
    await bootstrap(database, fixturePassword);
    expect(await preflightSchema(database)).toEqual({
      state: "fresh", currentFingerprint: null, targetFingerprint: schemaFingerprint,
    });
    await expect(verifySchema(database)).rejects.toThrow("schema");
    await initializeSchema(database);
    await grantRuntime(database);
    await verifySchema(runtime);
    expect(await preflightSchema(database)).toEqual({
      state: "current", currentFingerprint: schemaFingerprint, targetFingerprint: schemaFingerprint,
    });
  });

  it("serializes concurrent fresh initialization and preserves the singleton on repetition", async () => {
    const isolated = await testDatabase(false);
    try {
      await bootstrap(isolated.operator, fixturePassword);
      await Promise.all([initializeSchema(isolated.operator), initializeSchema(isolated.operator)]);
      const initialized = (await isolated.operator.query("SELECT singleton,fingerprint,initialized_at FROM app_schema")).rows;
      expect(initialized).toEqual([{ singleton: true, fingerprint: schemaFingerprint, initialized_at: expect.any(Date) }]);
      await initializeSchema(isolated.operator);
      expect((await isolated.operator.query("SELECT singleton,fingerprint,initialized_at FROM app_schema")).rows).toEqual(initialized);
      await grantRuntime(isolated.operator);
      await verifySchema(isolated.runtime);
    } finally { await isolated.close(); }
  });

  it("rolls back the complete DDL on marker insertion failure and supports retry", async () => {
    const isolated = await testDatabase(false);
    let injected = false;
    const wrapped = new Map<pg.PoolClient, pg.PoolClient["query"]>();
    const injectFailure = (client: pg.PoolClient) => {
      if (wrapped.has(client)) return;
      const original = client.query;
      wrapped.set(client, original);
      client.query = function(this: pg.PoolClient,...args: unknown[]) {
        const sql = typeof args[0]==="string" ? args[0] : (args[0] as { text?: string })?.text ?? "";
        if (!injected && /^INSERT INTO app_schema\b/.test(sql)) {
          injected = true;
          return Promise.reject(new Error("synthetic_schema_marker_failure"));
        }
        return Reflect.apply(original,this,args);
      } as typeof client.query;
    };
    try {
      await bootstrap(isolated.operator, fixturePassword);
      isolated.operator.on("acquire", injectFailure);
      await expect(initializeSchema(isolated.operator)).rejects.toThrow("synthetic_schema_marker_failure");
      expect(injected).toBe(true);
      expect((await isolated.operator.query(`SELECT
        (SELECT count(*)::int FROM pg_class WHERE relnamespace='public'::regnamespace) AS relations,
        (SELECT count(*)::int FROM pg_proc WHERE pronamespace='public'::regnamespace) AS functions,
        (SELECT count(*)::int FROM pg_type WHERE typnamespace='public'::regnamespace) AS types,
        (SELECT count(*)::int FROM pg_collation WHERE collnamespace='public'::regnamespace) AS collations`)).rows)
        .toEqual([{ relations: 0, functions: 0, types: 0, collations: 0 }]);
      expect(await preflightSchema(isolated.operator)).toEqual({
        state: "fresh", currentFingerprint: null, targetFingerprint: schemaFingerprint,
      });
      await initializeSchema(isolated.operator);
      await grantRuntime(isolated.operator);
      await verifySchema(isolated.runtime);
      expect(await preflightSchema(isolated.operator)).toEqual({
        state: "current", currentFingerprint: schemaFingerprint, targetFingerprint: schemaFingerprint,
      });
    } finally {
      isolated.operator.removeListener("acquire", injectFailure);
      for (const [client, original] of wrapped) client.query = original;
      await isolated.close();
    }
  });

  it("requires an explicit reset for a mismatched fingerprint without rewriting its marker", async () => {
    const mismatch = "0".repeat(64);
    await database.query("UPDATE app_schema SET fingerprint=$1 WHERE singleton", [mismatch]);
    try {
      await expect(preflightSchema(database)).rejects.toMatchObject({ code: "database_schema_reset_required" });
      await expect(initializeSchema(database)).rejects.toMatchObject({ code: "database_schema_reset_required" });
      await expect(verifySchema(runtime)).rejects.toThrow("fingerprint");
      expect((await database.query("SELECT fingerprint FROM app_schema")).rows).toEqual([{ fingerprint: mismatch }]);
    } finally {
      await database.query("UPDATE app_schema SET fingerprint=$1 WHERE singleton", [schemaFingerprint]);
    }
    await verifySchema(runtime);
  });

  it("rejects a nonempty unmarked schema without deleting or converting its data", async () => {
    const isolated = await testDatabase(false);
    try {
      await bootstrap(isolated.operator, fixturePassword);
      await isolated.operator.query("CREATE TABLE unexpected_data(value integer); INSERT INTO unexpected_data VALUES(7)");
      await expect(preflightSchema(isolated.operator)).rejects.toMatchObject({ code: "database_schema_reset_required" });
      await expect(initializeSchema(isolated.operator)).rejects.toMatchObject({ code: "database_schema_reset_required" });
      expect((await isolated.operator.query("SELECT value FROM unexpected_data")).rows).toEqual([{ value: 7 }]);
      expect((await isolated.operator.query("SELECT to_regclass('public.app_schema') AS marker")).rows).toEqual([{ marker: null }]);
    } finally { await isolated.close(); }
  });

  it("denies runtime DDL, audit mutation, schema-marker mutation and escalation", async () => {
    for (const sql of [
      "CREATE TABLE forbidden(id int)", "DELETE FROM audit_events", "UPDATE audit_events SET message='changed'",
      "TRUNCATE audit_events", "SET ROLE agentcontrol_admin",
      "INSERT INTO app_schema(singleton,fingerprint) VALUES(true,repeat('0',64))",
      "UPDATE app_schema SET fingerprint=repeat('0',64)", "DELETE FROM app_schema", "TRUNCATE app_schema",
    ]) await expect(runtime.query(sql)).rejects.toMatchObject({ code: "42501" });
    expect((await runtime.query("SELECT singleton,fingerprint FROM app_schema")).rows)
      .toEqual([{ singleton: true, fingerprint: schemaFingerprint }]);
    await retain(database);
    await verifySchema(runtime);
  });

  it("grants runtime access to capability state without exposing schema authority", async () => {
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

  it("cancels expired ingestion leases without assuming generation-only columns or discarding unexpired ready drafts", async () => {
    await runtime.query("INSERT INTO data_principal_epochs(tenant_id,principal_id) VALUES('retention-uploads','operator-fixture')");
    const rows = (await runtime.query(`INSERT INTO official_usage_ingestions
      (id,tenant_id,principal_id,bundle_id,owner,session_epoch,state,lease_until,deadline_at,expires_at)
      SELECT gen_random_uuid(),'retention-uploads','operator-fixture',gen_random_uuid(),gen_random_uuid(),1,
        input.state,clock_timestamp()+input.days*interval '1 day',clock_timestamp()+interval '1 day',clock_timestamp()+interval '1 day'
      FROM (VALUES ('streaming',-1),('ready',-1),('streaming',1)) input(state,days)
      RETURNING id,state,lease_until`)).rows;
    const expired = rows.find(row => row.state === "streaming" && row.lease_until < new Date())!;
    const preview = await retain(database, { batchSize: 1, dryRun: true });
    expect(preview.affected.officialIngestionsExpired).toBe(1);
    expect((await runtime.query("SELECT state FROM official_usage_ingestions WHERE id=$1", [expired.id])).rows[0].state).toBe("streaming");
    const result = await retain(database, { batchSize: 1 });
    expect(result.affected.officialIngestionsExpired).toBe(1);
    for (const row of rows) expect((await runtime.query("SELECT state FROM official_usage_ingestions WHERE id=$1", [row.id])).rows[0].state)
      .toBe(row.id === expired.id ? "cancelled" : row.state);
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

describe("current publication and qualification retention", () => {
  it("bounds immutable receipt expiry without reopening or deleting accepted report rows", async () => {
    const current = await testDatabase();
    try {
      const tenant = "receipt-retention";
      const report = await seedDisjointReportUnion(current.operator, tenant, 1);
      await expect(current.runtime.query(`INSERT INTO official_usage_version_rows(version_id,tenant_id,kind,ordinal,payload_hash)
        SELECT version_id,tenant_id,kind,ordinal+1,payload_hash FROM official_usage_version_rows WHERE version_id=$1`,
      [report.versions.agents])).rejects.toThrow("published or deleted");
      const receipts = (await current.runtime.query<{ bundle_id: string }>(`INSERT INTO official_usage_bundle_receipts
        (tenant_id,actor_principal_id,bundle_id,bundle_hash,expected_active_revision,result_set_id,result_version_id,result_active_revision,result_complete)
        SELECT $1,'administrator',gen_random_uuid(),repeat('b',64),1,$2,$3,2,true FROM generate_series(1,3)
        RETURNING bundle_id`, [tenant, report.id, report.versions.agents])).rows;
      await expect(current.runtime.query("UPDATE official_usage_bundle_receipts SET result_complete=false WHERE tenant_id=$1", [tenant]))
        .rejects.toMatchObject({ code: "42501" });
      await current.operator.query(`UPDATE official_usage_bundle_receipts SET expires_at=clock_timestamp()-interval '1 second'
        WHERE tenant_id=$1 AND bundle_id=ANY($2::uuid[])`, [tenant, receipts.slice(0, 2).map(receipt => receipt.bundle_id)]);
      expect(await retainOfficialReportReceipts(current.operator, 1)).toBe(1);
      expect((await current.runtime.query("SELECT count(*)::int AS count FROM official_usage_bundle_receipts")).rows[0].count).toBe(2);
      expect(await retainOfficialReportReceipts(current.operator, 1)).toBe(1);
      expect(await retainOfficialReportReceipts(current.operator, 1)).toBe(0);
      expect((await current.runtime.query("SELECT bundle_id FROM official_usage_bundle_receipts")).rows)
        .toEqual([{ bundle_id: receipts[2].bundle_id }]);
      expect((await current.runtime.query("SELECT count(*)::int AS count FROM official_usage_version_rows")).rows[0].count).toBe(3);
      expect((await current.runtime.query("SELECT count(*)::int AS count FROM official_usage_row_facts")).rows[0].count).toBe(3);
    } finally { await current.close(); }
  });

  it("keeps qualification beyond job expiry and enforces runtime grants", async () => {
    const current = await testDatabase();
    try {
      const jobIds = (await current.runtime.query<{ original_id: string; restoration_id: string }>(`SELECT gen_random_uuid() AS original_id,gen_random_uuid() AS restoration_id`)).rows[0];
      for (const [id, key, action] of [[jobIds.original_id, "original", "quarantine"], [jobIds.restoration_id, "restoration", "unquarantine"]] as const) {
        await current.runtime.query(`INSERT INTO copilot_quarantine_jobs
          (id,tenant_id,principal_id,idempotency_key,request_hash,action,status,confirmation_hash,confirmation_summary,
           actor_name,actor_username,request_path,contract_revision,permission_revision,configuration_revision,is_canary,canary_approval_id,expires_at)
          VALUES($1,'qualification-retention','operator',$2,repeat('a',64),$3,'succeeded',repeat('b',64),'{}','Operator','operator@example.invalid',
            '/api/quarantine/canary',repeat('c',64),repeat('d',64),1,true,gen_random_uuid(),clock_timestamp()-interval '1 second')`, [id, key, action]);
      }
      await current.runtime.query(`INSERT INTO copilot_quarantine_qualifications
        (id,tenant_id,target_environment_id,target_bot_id,original_approval_id,restoration_approval_id,original_job_id,restoration_job_id,
         contract_revision,permission_revision,configuration_revision,auth_mode)
        VALUES(gen_random_uuid(),'qualification-retention','11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222',
          gen_random_uuid(),gen_random_uuid(),$1,$2,repeat('c',64),repeat('d',64),1,'delegated')`, [jobIds.original_id, jobIds.restoration_id]);
      await retain(current.operator);
      expect((await current.runtime.query("SELECT count(*)::int AS count FROM copilot_quarantine_jobs")).rows[0].count).toBe(0);
      expect((await current.runtime.query("SELECT original_job_id,restoration_job_id FROM copilot_quarantine_qualifications")).rows)
        .toEqual([{ original_job_id: jobIds.original_id, restoration_job_id: jobIds.restoration_id }]);
      await expect(current.runtime.query("DELETE FROM copilot_quarantine_qualifications")).rejects.toThrow();
      await expect(current.runtime.query("DELETE FROM copilot_quarantine_audit")).rejects.toThrow();
      await current.operator.query("UPDATE copilot_quarantine_qualifications SET expires_at=clock_timestamp()-interval '1 second'");
      await retain(current.operator);
      expect((await current.runtime.query("SELECT count(*)::int AS count FROM copilot_quarantine_qualifications")).rows[0].count).toBe(0);
    } finally { await current.close(); }
  });
});
