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
  const before = await fingerprints(fixture.operator);
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
    const receipt = JSON.parse(readFileSync(`${file}.json`, "utf8"));
    expect(receipt).toMatchObject({ format: "agent-control-backup-v1", schemaFingerprint, fingerprintAlgorithm, tables: before });
    expect(await restore(fixture.operator, file, target)).toEqual(before);
    const runtime = new pg.Pool({ ...databaseSettings(), database: target, user: "agentcontrol_app", password: fixturePassword });
    try {
      await verifySchema(runtime);
      expect((await runtime.query("SELECT mode,provider_work_enabled FROM operational_state")).rows[0])
        .toEqual({ mode: "maintenance", provider_work_enabled: false });
      expect((await runtime.query("SELECT count(*)::int AS n FROM data_principal_epochs WHERE tenant_id='after-backup-snapshot'")).rows[0].n).toBe(0);
      expect((await runtime.query("SELECT count(*)::int AS n FROM package_record_rows WHERE scope_id=$1", [root.scopeId])).rows[0].n).toBe(3);
      await expect(runtime.query("TRUNCATE package_record_rows")).rejects.toThrow("permission denied");
      const application = createApp(runtime);
      const server = application.app.listen(0, "127.0.0.1");
      await new Promise<void>((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
      try {
        const address = server.address() as { port: number }, ready = `http://127.0.0.1:${address.port}/api/ready`;
        expect((await fetch(ready)).status).toBe(503);
        expect(await reopenRestoredDatabase(fixture.operator, target)).toEqual({ mode: "normal", providerWorkEnabled: false });
        expect((await fetch(ready)).status).toBe(200);
        expect((await runtime.query("SELECT provider_work_enabled FROM operational_state")).rows[0].provider_work_enabled).toBe(false);
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
