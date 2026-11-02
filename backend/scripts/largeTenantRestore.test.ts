import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { fixturePassword, testDatabase } from "./testDatabase.js";
import { backup, fingerprints, restore, reopenRestoredDatabase, validateBackupInventory } from "./backup.js";
import { backupTableKeys, fingerprintAlgorithm } from "./backupInventory.js";
import { databaseSettings } from "../src/db/pool.js";
import { schemaFingerprint, verifySchema } from "../src/db/schema.js";
import { inventoryBaseline } from "./inventoryFixtures.js";
import { InventoryGenerations } from "../src/db/inventoryGenerations.js";
import { createApp } from "../src/app.js";
import { officeFixtureActivity, officeFixtureDate, officeFixturePerson, publishOfficeSource } from "./officeAppAdoptionFixtures.js";
import { OfficeAppAdoptionReads } from "../src/services/officeAppAdoptionReads.js";
import { retainRecordData } from "../src/db/dataRetention.js";
import { DataGenerations } from "../src/db/dataGenerations.js";
import { verifyDataGenerationCharges } from "../src/db/dataGenerationAccountingSchema.js";
import { selectionIdentity } from "./largeTenantFixtures.js";

let fixture: Awaited<ReturnType<typeof testDatabase>>;
beforeAll(async () => { fixture = await testDatabase(); });
afterAll(async () => { await fixture?.close(); });

it("exposes the exact final-schema primary-key inventory for forward-only streaming backups", async () => {
  const rows = (await fixture.operator.query(`SELECT c.relname AS name,
    coalesce((SELECT json_agg(a.attname ORDER BY k.ordinality) FROM pg_index i
      CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY k(attnum,ordinality)
      JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.attnum
      WHERE i.indrelid=c.oid AND i.indisprimary),'[]'::json) AS keys
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind='r' ORDER BY c.relname`)).rows;
  expect(rows.every(row => row.keys.length > 0)).toBe(true);
  expect(Object.fromEntries(rows.map(row => [row.name, row.keys]))).toEqual(backupTableKeys);
  process.stdout.write(`BACKUP_SCHEMA_INVENTORY ${JSON.stringify(Object.fromEntries(rows.map(row => [row.name, row.keys])))}\n`);
});

it("rejects an unreviewed table rather than increasing a guessed ceiling", async () => {
  const client = await fixture.operator.connect();
  try {
    await client.query("BEGIN");
    await client.query("CREATE TABLE unreviewed_backup_data(id integer PRIMARY KEY)");
    await expect(validateBackupInventory(client)).rejects.toThrow("inventory mismatch");
  } finally { await client.query("ROLLBACK"); client.release(); }
});

it("dumps and fingerprints one snapshot despite a concurrent commit, restoring only to a separate guarded target", async () => {
  const directory = join(process.cwd(), "artifacts", "test-scratch", `lifecycle-restore-${randomUUID()}`);
  const target = `agentcontrol_restore_${randomUUID().replaceAll("-", "")}`, file = join(directory, "new-schema.dump");
  mkdirSync(directory, { recursive: true });
  const root = await inventoryBaseline(new InventoryGenerations(fixture.runtime), randomUUID(), 3);
  const tenant = randomUUID(), clearedTenant = randomUUID(), correctedTenant = randomUUID();
  const reader = new OfficeAppAdoptionReads(fixture.runtime, "synthetic-office-restore-cursor-secret");
  const previous = new Date(Date.parse(officeFixtureDate) - 86400000).toISOString().slice(0, 10);
  const identity = { ...selectionIdentity, tenantId: tenant };
  for (const tenantId of [tenant, clearedTenant, correctedTenant]) {
    await publishOfficeSource(fixture.runtime, "directory", [officeFixturePerson(), officeFixturePerson(2)], tenantId);
    await publishOfficeSource(fixture.runtime, "app_activity", [
      officeFixtureActivity(1, { word_date: previous, excel_date: previous }, previous), officeFixtureActivity(2, {}, previous),
    ], tenantId);
  }
  const original = await reader.summary(identity, {});
  const observation = original.context.observation!;
  await publishOfficeSource(fixture.runtime, "app_activity", [officeFixtureActivity(1, { teams_date: officeFixtureDate })], tenant);
  const changedPerson = officeFixturePerson(); changedPerson.identity.department = "Today's changed department";
  await publishOfficeSource(fixture.runtime, "directory", [changedPerson], tenant);
  const cleanup = async (database: pg.Pool) => {
    const generations = new DataGenerations(database);
    for (let pass = 0, idle = 0; pass < 200 && idle < 2; pass++) {
      const changed = await generations.connections.run(client => retainRecordData(client, 250));
      idle = Object.values(changed).some(count => count > 0) ? 0 : idle + 1;
    }
    await verifyDataGenerationCharges(database);
  };
  await cleanup(fixture.runtime);
  expect((await fixture.runtime.query("SELECT count(*)::int AS n FROM data_generations WHERE id=ANY($1::uuid[])",
    [[observation.directoryGenerationId, observation.appGenerationId]])).rows[0].n).toBe(0);
  const query = { officeSnapshot: observation.id };
  const selected = await reader.context(identity, query);
  const group = (await reader.groups(identity, query, selected.selection.id)).value[0];
  const facts = (await reader.people(identity, query, group.id, selected.selection.id)).value;
  const frozen = await reader.summary(identity, query, selected.selection.id);
  await fixture.runtime.query("INSERT INTO sessions(sid,sess,expire) VALUES($1,$2,clock_timestamp()+interval '1 hour')",
    [`office-restore-${tenant}`, "{}"]);
  const before = await fingerprints(fixture.operator);
  expect(before.office_observations.count).toBeGreaterThan(0);
  expect(before.office_person_facts.count).toBeGreaterThan(0);
  expect(await fingerprints(fixture.operator)).toEqual(before);
  let changed = false;
  const observed = new WeakSet<pg.PoolClient>();
  const spies: Array<{ mockRestore(): void }> = [];
  const acquired = (client: pg.PoolClient) => {
    if (observed.has(client)) return;
    observed.add(client);
    const query = client.query.bind(client);
    spies.push(vi.spyOn(client, "query").mockImplementation((...args: unknown[]) => {
      const result = (query as (...args: unknown[]) => Promise<unknown>)(...args);
      if (!changed && typeof args[0] === "string" && args[0].startsWith("SELECT pg_export_snapshot()")) {
        changed = true;
        return result.then(async value => {
          await fixture.runtime.query("INSERT INTO data_principal_epochs(tenant_id,principal_id) VALUES('after-backup-snapshot','concurrent')");
          return value;
        });
      }
      return result;
    }));
  };
  fixture.operator.on("acquire", acquired);
  const stop = () => { fixture.operator.off("acquire", acquired); for (const spy of spies) spy.mockRestore(); };
  try {
    expect(await backup(fixture.operator, file)).toEqual(before);
    stop();
    expect(changed).toBe(true);
    await fixture.runtime.query("UPDATE data_scope_epochs SET epoch=epoch+1 WHERE tenant_id=$1 AND source IN ('directory','app_activity')", [clearedTenant]);
    await publishOfficeSource(fixture.runtime, "app_activity", [
      officeFixtureActivity(1, { teams_date: previous }, previous), officeFixtureActivity(2, { word_date: previous }, previous),
    ], correctedTenant);
    const receipt = JSON.parse(readFileSync(`${file}.json`, "utf8"));
    expect(receipt).toMatchObject({ format: "agent-control-backup-v1", schemaFingerprint, fingerprintAlgorithm, tables: before });
    expect(await restore(fixture.operator, file, target)).toEqual(before);
    const runtime = new pg.Pool({ ...databaseSettings(), database: target, user: "agentcontrol_app", password: fixturePassword });
    try {
      await verifySchema(runtime);
      expect((await runtime.query("SELECT mode FROM operational_state")).rows[0])
        .toEqual({ mode: "maintenance" });
      expect((await runtime.query("SELECT count(*)::int AS n FROM data_principal_epochs WHERE tenant_id='after-backup-snapshot'")).rows[0].n).toBe(0);
      expect((await runtime.query("SELECT count(*)::int AS n FROM package_record_rows WHERE scope_id=$1", [root.scopeId])).rows[0].n).toBe(3);
      await expect(runtime.query("TRUNCATE package_record_rows")).rejects.toThrow("permission denied");
      const application = createApp(runtime);
      const server = application.app.listen(0, "127.0.0.1");
      await new Promise<void>((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
      try {
        const address = server.address() as { port: number }, ready = `http://127.0.0.1:${address.port}/api/ready`;
        expect((await fetch(ready)).status).toBe(503);
        expect(await reopenRestoredDatabase(fixture.operator, target)).toEqual({ mode: "normal", providerWorkEnabled: true });
        expect((await fetch(ready)).status).toBe(200);
        expect((await runtime.query("SELECT mode FROM operational_state")).rows[0].mode).toBe("normal");
        expect((await runtime.query("SELECT count(*)::int AS n FROM sessions")).rows[0].n).toBe(0);
        const restoredReader = new OfficeAppAdoptionReads(runtime, "synthetic-office-restore-cursor-secret");
        await expect(restoredReader.context(identity, query, selected.selection.id)).rejects.toMatchObject({ code: "selection_invalidated" });
        const sessionEpoch = (await runtime.query("SELECT epoch::text FROM data_principal_epochs WHERE tenant_id=$1 AND principal_id=$2",
          [identity.tenantId, identity.principalId])).rows[0].epoch;
        const restoredIdentity = { ...identity, sessionEpoch };
        const restoredSummary = await restoredReader.summary(restoredIdentity, query);
        expect(restoredSummary.organization).toEqual(frozen.organization);
        expect(restoredSummary.context.observation).toEqual(observation);
        expect((await restoredReader.people(restoredIdentity, query, group.id)).value).toEqual(facts);
        expect((await restoredReader.history(restoredIdentity, query)).value.map(point => point.observation.id)).toEqual([observation.id]);
        await expect(restoredReader.context({ ...restoredIdentity, tenantId: clearedTenant }, query)).rejects.toMatchObject({ code: "selection_invalidated" });
        for (const tenantId of [clearedTenant, correctedTenant]) {
          const renewedEpoch = (await runtime.query("SELECT epoch::text FROM data_principal_epochs WHERE tenant_id=$1 AND principal_id=$2",
            [tenantId, selectionIdentity.principalId])).rows[0].epoch;
          expect((await restoredReader.context({ ...selectionIdentity, tenantId, sessionEpoch: renewedEpoch }, {})).observation).toBeNull();
        }
        await cleanup(runtime);
        expect((await runtime.query("SELECT count(*)::int AS n FROM office_person_facts WHERE tenant_id=ANY($1::text[])",
          [[clearedTenant, correctedTenant]])).rows[0].n).toBe(0);
        await verifyDataGenerationCharges(runtime);
        process.stdout.write(`OFFICE_RESTORE ${JSON.stringify({ history: observation.id, frozenFacts: facts.length,
          originalSourcesRetired: true, oldSelectionsRevoked: true, sessionsDeleted: true, tenantIsolation: true,
          clearAndCorrectionFences: true, byteAccounting: true, schemaFingerprint })}\n`);
      } finally {
        application.store.close();
        server.closeAllConnections();
        await new Promise<void>(resolve => server.close(() => resolve()));
      }
      process.stdout.write(`LARGE_TENANT_RESTORE ${JSON.stringify({ source: fixture.name, target, algorithm: fingerprintAlgorithm,
        schemaTables: Object.keys(before).length, snapshotConsistent: true, providerWorkEnabled: false, runtimeGrants: true,
        maintenanceReadiness: 503, reviewedReadiness: 200, rows: before.package_record_rows.count, hash: before.package_record_rows.hash })}\n`);
    } finally { await runtime.end(); }
  } finally {
    stop();
    await fixture.operator.query(`DROP DATABASE IF EXISTS "${target}" WITH (FORCE)`);
    rmSync(directory, { recursive: true, force: true });
  }
}, 30_000);
