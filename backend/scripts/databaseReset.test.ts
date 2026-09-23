import pg from "pg";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { databaseSettings } from "../src/db/pool.js";
import { verifySchema } from "../src/db/schema.js";
import { bootstrap, databaseOperatorFailure, grantRuntime, migrate, preflightMigrations } from "./database.js";
import { DatabaseResetError, preflightDatabaseReset, resetDatabase } from "./databaseReset.js";
import { fixturePassword, testDatabase } from "./testDatabase.js";

const execute = promisify(execFile);
const settings = databaseSettings();
const maintenance = new pg.Pool({ ...settings, database: "postgres" });
let fixture: Awaited<ReturnType<typeof testDatabase>>;

async function useDatabase<T>(name: string, read: (database: pg.Pool) => Promise<T>) {
  const database = new pg.Pool({ ...settings, database: name });
  try { return await read(database); } finally { await database.end(); }
}

function command(name: string, ...args: string[]) {
  return execute(process.execPath, ["--import", "tsx", fileURLToPath(new URL("./database.ts", import.meta.url)), ...args], {
    env: { ...process.env, PGDATABASE: name }, timeout: 15_000,
  });
}

beforeAll(async () => {
  const roles = await testDatabase();
  await roles.close();
});
beforeEach(async () => { fixture = await testDatabase(false); });
afterEach(async () => { await fixture?.close(); });
afterAll(async () => { await maintenance.end(); });

describe.sequential("explicit application database reset", () => {
  it("replaces an incompatible database, preserves other databases and roles, and bootstraps with the same credentials", async () => {
    const sibling = await testDatabase(false);
    try {
      await useDatabase(sibling.name, database => database.query("CREATE TABLE sibling_probe(id integer); INSERT INTO sibling_probe VALUES (9)"));
      await useDatabase(fixture.name, async database => {
        await bootstrap(database, fixturePassword);
        await migrate(database);
        await grantRuntime(database);
        await database.query("CREATE TABLE reset_probe(id integer); INSERT INTO reset_probe VALUES (7)");
        await database.query("UPDATE schema_migrations SET checksum='retired-schema' WHERE version IN (5,33)");
      });
      const roleBefore = (await maintenance.query("SELECT oid FROM pg_roles WHERE rolname='agentcontrol_app'")).rows;
      expect(await preflightDatabaseReset(maintenance, fixture.name, fixture.name)).toEqual({ database: fixture.name, exists: true });
      expect(await useDatabase(fixture.name, async database => (await database.query("SELECT id FROM reset_probe")).rows)).toEqual([{ id: 7 }]);
      await expect(command(fixture.name, "reset")).rejects.toMatchObject({
        code: 1, stderr: expect.stringContaining('"code":"database_reset_denied"'),
      });
      const reset = await command(fixture.name, "reset", fixture.name);
      expect(JSON.parse(reset.stdout)).toEqual({
        event: "database_operator_command", command: "reset", outcome: "succeeded", database: fixture.name, state: "fresh",
      });
      await useDatabase(fixture.name, async database => {
        expect(await preflightMigrations(database)).toMatchObject({ state: "fresh", currentVersion: 0 });
        expect((await database.query("SELECT count(*)::int AS count FROM pg_class WHERE relnamespace='public'::regnamespace")).rows[0].count).toBe(0);
      });
      await command(fixture.name, "migrate");
      const runtime = new pg.Pool({ ...settings, database: fixture.name, user: "agentcontrol_app", password: fixturePassword });
      try {
        await verifySchema(runtime);
        expect((await runtime.query("SELECT count(*)::int AS count FROM sessions")).rows[0].count).toBe(0);
        expect((await runtime.query("SELECT to_regclass('public.reset_probe') AS name")).rows[0].name).toBeNull();
      } finally { await runtime.end(); }
      expect((await maintenance.query("SELECT oid FROM pg_roles WHERE rolname='agentcontrol_app'")).rows).toEqual(roleBefore);
      expect(await useDatabase(sibling.name, async database => (await database.query("SELECT id FROM sibling_probe")).rows)).toEqual([{ id: 9 }]);
    } finally { await sibling.close(); }
  });

  it.each(["postgres", "template0", "agentcontrol_other", 'agentcontrol_test_bad";DROP DATABASE postgres;--'])(
    "rejects an unsupported reset target %s", async target => {
      await expect(preflightDatabaseReset(maintenance, target, target)).rejects.toMatchObject({ code: "database_reset_denied" });
      await expect(resetDatabase(maintenance, target, target)).rejects.toMatchObject({ code: "database_reset_denied" });
    },
  );

  it("rejects a confirmation for a different database", async () => {
    await expect(resetDatabase(maintenance, fixture.name, "agentcontrol")).rejects.toMatchObject({ code: "database_reset_denied" });
    expect((await maintenance.query("SELECT datname FROM pg_database WHERE datname=$1", [fixture.name])).rowCount).toBe(1);
  });

  it("rejects a connection to the application database instead of maintenance", async () => {
    await useDatabase(fixture.name, async database => {
      await expect(preflightDatabaseReset(database, fixture.name, fixture.name)).rejects.toMatchObject({ code: "database_reset_denied" });
      await expect(resetDatabase(database, fixture.name, fixture.name)).rejects.toMatchObject({ code: "database_reset_denied" });
    });
  });

  it("rejects the runtime identity", async () => {
    const runtime = new pg.Pool({ ...settings, database: "postgres", user: "agentcontrol_app", password: fixturePassword });
    try {
      await expect(preflightDatabaseReset(runtime, fixture.name, fixture.name)).rejects.toMatchObject({ code: "database_reset_denied" });
      await expect(resetDatabase(runtime, fixture.name, fixture.name)).rejects.toMatchObject({ code: "database_reset_denied" });
    } finally { await runtime.end(); }
  });

  it("refuses a database owned by another role", async () => {
    await maintenance.query(`ALTER DATABASE "${fixture.name}" OWNER TO agentcontrol_app`);
    try {
      await expect(resetDatabase(maintenance, fixture.name, fixture.name)).rejects.toMatchObject({ code: "database_reset_denied" });
      expect((await maintenance.query("SELECT pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname=$1", [fixture.name])).rows[0].owner).toBe("agentcontrol_app");
    } finally { await maintenance.query(`ALTER DATABASE "${fixture.name}" OWNER TO agentcontrol_admin`); }
  });

  it("refuses a template even with an otherwise allowed name", async () => {
    await maintenance.query(`ALTER DATABASE "${fixture.name}" IS_TEMPLATE true`);
    try {
      await expect(resetDatabase(maintenance, fixture.name, fixture.name)).rejects.toMatchObject({ code: "database_reset_denied" });
    } finally { await maintenance.query(`ALTER DATABASE "${fixture.name}" IS_TEMPLATE false`); }
  });

  it("can retry explicit initialization when a previous reset left the database absent", async () => {
    await maintenance.query(`DROP DATABASE "${fixture.name}"`);
    expect(await preflightDatabaseReset(maintenance, fixture.name, fixture.name)).toEqual({ database: fixture.name, exists: false });
    expect(await resetDatabase(maintenance, fixture.name, fixture.name)).toEqual({ database: fixture.name, state: "fresh" });
    expect(await useDatabase(fixture.name, preflightMigrations)).toMatchObject({ state: "fresh" });
  });

  it("serializes simultaneous explicit resets of the same database", async () => {
    const results = await Promise.all([
      resetDatabase(maintenance, fixture.name, fixture.name),
      resetDatabase(maintenance, fixture.name, fixture.name),
    ]);
    expect(results).toEqual([
      { database: fixture.name, state: "fresh" },
      { database: fixture.name, state: "fresh" },
    ]);
    expect(await useDatabase(fixture.name, preflightMigrations)).toMatchObject({ state: "fresh" });
  });

  it("reports destructive-phase failures without suggesting that data was preserved", () => {
    const error = databaseOperatorFailure(new DatabaseResetError("create"));
    expect(error).toMatchObject({
      code: "database_reset_failed", phase: "create", message: expect.stringContaining("data may already have been deleted"),
    });
    expect(error.message).not.toContain("No automatic reset");
  });
});
