import assert from "node:assert/strict";
import pg from "pg";
import { createHash } from "node:crypto";
import { writeFileSync, writeSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { CapacityTelemetry, transientHeapProbe, onCapacityWorkerTermination, MiB } from "./capacityTelemetry.js";
import { capacitySeed, fixtureTenant, key } from "./capacityProvider.js";
import { testDatabase } from "./testDatabase.js";
import { databaseSettings,pool } from "../src/db/pool.js";
import { bindCapacityDatabase } from "./capacityDatabase.js";
import { BoundedPool } from "../src/db/boundedPool.js";
import { selectionIdentity } from "./largeTenantFixtures.js";
import { GraphPackagesClient, packageInventoryReadPolicy } from "../src/services/graphPackages.js";
import { StreamedInventory } from "../src/services/streamedInventory.js";
import { InventoryQueries } from "../src/db/inventoryQueries.js";
import { peakCheckpoint } from "../src/services/peakMemory.js";
import { capacityInput, fixtureFetch } from "./capacityRuntime.js";
export { capacityBudgets } from "./capacityRuntime.js";
function percentiles(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return { count: sorted.length, p95: sorted[Math.ceil(sorted.length * .95) - 1], p99: sorted[Math.ceil(sorted.length * .99) - 1], max: sorted.at(-1) };
}
async function queryComparison(database: BoundedPool, telemetry: CapacityTelemetry) {
  const results = [];
  for (const count of [10_000, 100_000]) {
    const principal = `capacity-query-${count}`;
    const stream = new StreamedInventory(database, new GraphPackagesClient(fixtureFetch(count), packageInventoryReadPolicy));
    const start = performance.now();
    const root = await stream.graphCatalog(capacityInput(principal), "synthetic", { authorize: async () => {} });
    telemetry.write({ event: "ingested", count, elapsedMs: performance.now() - start, root });
    const queries = new InventoryQueries(database, "synthetic-capacity-query-cursor-key-32");
    const identity = { ...selectionIdentity, tenantId: fixtureTenant, principalId: principal };
    const query = { sortBy: "displayName", sortDirection: "asc", inventoryScope: "all", source: "all" } as const;
    const selected = await queries.capture(identity, root.scopeId, query);
    const timings: number[] = [];
    const requestWindows = [];
    let cursor: string | undefined, rows = 0;
    const observed = createHash("sha256"), expected = createHash("sha256");
    for (let i = 0; i < count; i++) expected.update(`package-${key(i)}\n`);
    const before = process.memoryUsage();
    for (;;) {
      const started = performance.now();
      const windowIndex = timings.length;
      writeSync(1,`CAPACITY_REQUEST_WINDOW ${JSON.stringify({ state: "begin",pid: process.pid,count,index: windowIndex })}\n`);
      telemetry.beginRequestWindow();
      const page = await queries.page(selected.id, identity, { limit: 100, cursor });
      timings.push(performance.now() - started);
      const serialized = JSON.stringify(page); peakCheckpoint("response.serialize");
      requestWindows.push({ index: windowIndex,...telemetry.endRequestWindow() });
      writeSync(1,`CAPACITY_REQUEST_WINDOW ${JSON.stringify({ state: "end",pid: process.pid,count,index: windowIndex })}\n`);
      assert.ok(Buffer.byteLength(serialized) <= MiB);
      assert.equal(page.counts.total, count); assert.ok(page.value.length <= 100);
      for (const row of page.value) { observed.update(`${row.nativeId}\n`); rows++; }
      telemetry.write({ event: "query", count, rows, elapsedMs: timings.at(-1), heapUsed: process.memoryUsage().heapUsed });
      if (timings.length === 1) {
        if (database.totalCount>=4 && database.idleCount) { const client = await database.connect();client.release(true); }
        const operator = new pg.Pool({ ...databaseSettings(), database: String(database.options.database), max: 1,
          application_name: "agent-control-capacity-operator" });
        try { await operator.query("ANALYZE"); } finally { await operator.end(); }
        telemetry.write({ event: "analyzed", count, afterRequest: 1 });
      }
      cursor = page.page.nextCursor ?? undefined;
      if (!cursor || timings.length === 3) break;
    }
    const prefix = createHash("sha256");
    for (let i = 0; i < rows; i++) prefix.update(`package-${key(i)}\n`);
    assert.equal(rows, 300); assert.equal(observed.digest("hex"), prefix.digest("hex"));
    const plan = await database.query(`EXPLAIN (ANALYZE,BUFFERS,WAL,SETTINGS,FORMAT JSON)
      SELECT identity,generation_id FROM inventory_memberships WHERE baseline_id=$1 AND valid_from_revision<=$2
      AND (valid_to_revision IS NULL OR valid_to_revision>$2) ORDER BY identity COLLATE "C" LIMIT 100`, [root.baselineId, root.revision]);
    await telemetry.capturePlans(database,{ count });
    const result = { count, rows, query, before, after: process.memoryUsage(), latency: percentiles(timings), plan: plan.rows,requestWindows,
      sampledHeapUsedMax: telemetry.sampledHeapUsedMax, stageCheckpointHeapUsedMax: telemetry.stageCheckpointHeapUsedMax };
    telemetry.write({ event: "comparison", ...result }); results.push(result);
  }
  return results;
}

export async function runCapacity(mode: string) {
  if (process.env.AGENT_CONTROL_ISOLATED_TESTS !== "1" || process.env.PGHOST !== "test-postgres"
    || !/^agentcontrol_test_[a-f0-9]{32}_control$/.test(process.env.PGDATABASE ?? "")) throw new Error("capacity_fixture_identity_required");
  const fixture = await testDatabase();
  await fixture.release();
  const database = bindCapacityDatabase(pool,fixture.name);
  const telemetry = new CapacityTelemetry(`/evidence/${mode}-memory.jsonl`, () => ({
    total: database.totalCount, waiting: database.waitingCount, idle: database.idleCount,maximum: database.options.max, ...database.admissionState,
  }));
  telemetry.start();
  let diagnostic: Promise<void> | undefined;
  let applicationConnectionsMax: number | undefined;
  const diagnosticTimer = setInterval(() => {
    if (diagnostic) return;
    diagnostic = database.query(`SELECT
      (SELECT count(*)::int FROM pg_stat_activity WHERE backend_type='client backend'
        AND application_name IN ('agent-control-capacity-app','agent-control-capacity-worker',
          'agent-control-capacity-operator','pg_dump','pg_restore')) AS application_connections,
      (SELECT jsonb_agg(jsonb_build_object('pid',pid,'state',state,'waitType',wait_event_type,'wait',wait_event,
        'queryHash',md5(query),'ageSeconds',extract(epoch FROM clock_timestamp()-query_start)))
        FROM pg_stat_activity WHERE datname=current_database()) AS activity,
      (SELECT jsonb_build_object('tempBytes',temp_bytes::text,'tempFiles',temp_files::text,'deadlocks',deadlocks::text)
        FROM pg_stat_database WHERE datname=current_database()) AS spills,
      (SELECT jsonb_build_object('liveEstimate',sum(n_live_tup)::text,'deadEstimate',sum(n_dead_tup)::text)
        FROM pg_stat_user_tables) AS tuples,
      (SELECT count(*)::int FROM pg_locks WHERE NOT granted AND database=(SELECT oid FROM pg_database WHERE datname=current_database())) AS waiting_locks,
      (SELECT max(extract(epoch FROM clock_timestamp()-waitstart)) FROM pg_locks
        WHERE NOT granted AND database=(SELECT oid FROM pg_database WHERE datname=current_database())) AS longest_lock_wait_seconds`)
      .then(result => {
        const count = result.rows[0].application_connections;
        if (Number.isSafeInteger(count) && count>=1) applicationConnectionsMax = Math.max(applicationConnectionsMax ?? 0,count);
        telemetry.write({ event: "database-diagnostics", at: performance.now(), ...result.rows[0] });
      },
        error => { telemetry.write({ event: "database-diagnostics-failed", at: performance.now(), error: String(error) }); })
      .finally(() => { diagnostic = undefined; });
  }, 5000);
  const outcome: Record<string, unknown> = { seed: capacitySeed, mode, database: fixture.name, startedAt: new Date().toISOString() };
  try {
    const schema = {
      identity: (await database.query("SELECT fingerprint FROM app_schema WHERE singleton=true")).rows[0],
      role: (await database.query(`SELECT current_user AS role,current_database() AS database,
        has_database_privilege(current_user,current_database(),'CREATE') AS can_create_database_objects,
        has_schema_privilege(current_user,'public','CREATE') AS can_create_public_objects`)).rows,
      tables: (await database.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows,
      grants: (await database.query(`SELECT table_name,privilege_type FROM information_schema.role_table_grants
        WHERE grantee=current_user AND table_schema='public' ORDER BY table_name,privilege_type`)).rows,
    };
    writeFileSync(`/evidence/${mode}-schema.json`, JSON.stringify(schema, null, 2));
    const { capacityHttp } = await import("./capacityHttp.js");
    outcome.appBootstrap = await capacityHttp(database,telemetry,undefined,"capacity-bootstrap","bootstrap");
    telemetry.write({ event: "authenticated-app-bootstrap",result: outcome.appBootstrap });
    if (mode === "full") {
      outcome.profiles = await (await import("./capacityWorkloads.js")).fullCapacity(database, telemetry);
      outcome.functionalStatus = (outcome.profiles as { status: string }[]).every(profile => profile.status === "passed") ? "passed" : "failed";
      outcome.status = outcome.functionalStatus === "failed" ? "failed" : "inconclusive";
      outcome.qualificationNote = "Functional receipts alone cannot pass all capacity gates; interpret raw GC, coverage, cgroups and profile completeness.";
      process.exitCode = outcome.status === "failed" ? 1 : 2;
    } else {
      try {
        outcome.identityProbe = await (await import("./capacityWorkloads.js")).capacityIdentityProbe(database,telemetry);
      } catch (error) {
        outcome.identityProbeError = error instanceof Error ? { name: error.name,message: error.message,stack: error.stack } : String(error);
      } finally { await telemetry.capturePlans(database,{ profile: "diagnostic-10k-identity-probe" }); }
      outcome.comparison = await queryComparison(database, telemetry);
      outcome.functionalStatus = outcome.identityProbeError ? "failed" : "passed";
      outcome.status = (outcome.comparison as { latency: { p95: number; p99: number } }[])
        .every(value => value.latency.p95 <= 2000 && value.latency.p99 <= 5000) && !outcome.identityProbeError ? "inconclusive" : "failed";
      outcome.qualificationNote = "Three diagnostic requests/cardinality are not the full request-count or coverage qualification.";
      process.exitCode = outcome.status === "failed" ? 1 : 2;
    }
  } catch (error) {
    outcome.status = "failed"; outcome.error = error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error);
    await telemetry.capturePlans(database,{ profile: `${mode}-failure` });
    throw error;
  } finally {
    clearInterval(diagnosticTimer);
    await diagnostic;
    outcome.applicationConnections = { maximumObserved: applicationConnectionsMax ?? null,limit: 4,
      sharedApplicationPool: database===pool,
      status: applicationConnectionsMax===undefined ? "inconclusive" : applicationConnectionsMax<=4 ? "passed" : "failed",
      coverage: "Five-second server-side samples include named app/lease/operator clients and pg_dump/pg_restore. The app uses one four-slot pool; operator/worker phases explicitly release or reserve slots." };
    if (applicationConnectionsMax!==undefined && applicationConnectionsMax>4) { outcome.status = "failed";process.exitCode = 1; }
    outcome.memory = telemetry.stop();
    outcome.finishedAt = new Date().toISOString();
    try { outcome.storage = (await database.query(`SELECT pg_database_size(current_database())::text AS database_bytes,
      (SELECT temp_bytes::text FROM pg_stat_database WHERE datname=current_database()) AS temp_bytes,
      (SELECT sum(pg_table_size(c.oid))::text FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public' AND c.relkind='r') AS table_bytes,
      (SELECT sum(pg_indexes_size(c.oid))::text FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public' AND c.relkind='r') AS index_bytes`)).rows; } catch (error) { outcome.storageError = String(error); }
    writeFileSync(`/evidence/${mode}-result.json`, JSON.stringify(outcome, null, 2));
    await database.end();
    const admin = new BoundedPool(databaseSettings());
    try { await admin.query(`DROP DATABASE "${fixture.name}"`); } finally { await admin.end(); }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] === "--lease-worker") {
    if (process.env.AGENT_CONTROL_ISOLATED_TESTS !== "1" || process.env.PGHOST !== "test-postgres"
      || !/^agentcontrol_test_[a-f0-9]{32}$/.test(process.env.PGDATABASE ?? "")) throw new Error("capacity_worker_identity");
    const database = new BoundedPool({ ...databaseSettings(),application_name: "agent-control-capacity-worker" });
    const telemetry = new CapacityTelemetry(`/evidence/lease-worker-${process.pid}-memory.jsonl`, () => ({
      total: database.totalCount, waiting: database.waitingCount, idle: database.idleCount,maximum: database.options.max,...database.admissionState,
    }));
    telemetry.start();
    onCapacityWorkerTermination(() => telemetry.stop());
    const { DataGenerations } = await import("../src/db/dataGenerations.js");
    await new DataGenerations(database).execute(capacityInput("capacity-death"), async lease => {
      process.send?.(lease);
      await delay(180_000);
    });
  } else if (process.argv[2] === "--probe" && process.argv[3] === "transient-heap") {
    const telemetry = new CapacityTelemetry("/evidence/probe-memory.jsonl"); telemetry.start();
    const probe = await transientHeapProbe();
    writeFileSync("/evidence/probe-result.json", JSON.stringify({ ...probe, memory: telemetry.stop() }, null, 2));
    console.log("TRANSIENT_HEAP_PROBE", JSON.stringify(probe));
    if (probe.status !== "passed") process.exitCode = 2;
  } else await runCapacity(process.argv[2] ?? "full");
}
