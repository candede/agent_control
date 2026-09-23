import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bootstrap, databaseOperatorFailure, migrate, preflightMigrations } from "./database.js";
import { migrations, migrationChecksum } from "../src/db/schema.js";
import { fixturePassword, testDatabase } from "./testDatabase.js";

const execute = promisify(execFile);
let fixture: Awaited<ReturnType<typeof testDatabase>>;
beforeAll(async () => { fixture = await testDatabase(false); });
afterAll(async () => { await fixture?.close(); });

function preflightCommand() {
  return execute(process.execPath, ["--import", "tsx", fileURLToPath(new URL("./database.ts", import.meta.url)), "preflight"], {
    env: { ...process.env, PGDATABASE: fixture.name }, timeout: 15_000,
  });
}

describe.sequential("read-only database deployment preflight", () => {
  it("accepts a fresh database without creating schema or bootstrapping runtime access", async () => {
    const expected = { state: "fresh", currentVersion: 0, targetVersion: migrations.at(-1)!.version };
    expect(await preflightMigrations(fixture.operator)).toEqual(expected);
    const result = await preflightCommand();
    expect(JSON.parse(result.stdout)).toEqual({
      event: "database_operator_command", command: "preflight", outcome: "succeeded", ...expected,
    });
    expect(result.stderr).toBe("");
    expect((await fixture.operator.query("SELECT count(*)::int AS count FROM pg_class WHERE relnamespace='public'::regnamespace")).rows[0].count).toBe(0);
  });

  it("rejects unversioned saved tables without deleting or modifying them", async () => {
    await fixture.operator.query("CREATE TABLE preflight_probe(id integer); INSERT INTO preflight_probe VALUES (7)");
    try {
      await expect(preflightMigrations(fixture.operator)).rejects.toMatchObject({ code: "database_schema_unversioned" });
      expect((await fixture.operator.query("SELECT id FROM preflight_probe")).rows).toEqual([{ id: 7 }]);
      expect((await fixture.operator.query("SELECT to_regclass('public.schema_migrations') AS name")).rows[0].name).toBeNull();
    } finally { await fixture.operator.query("DROP TABLE preflight_probe"); }
  });

  it("accepts a matching migration prefix without applying its pending migrations", async () => {
    await bootstrap(fixture.operator, fixturePassword);
    await migrate(fixture.operator, migrations.slice(0, 1));
    const before = (await fixture.operator.query("SELECT * FROM schema_migrations")).rows;
    expect(await preflightMigrations(fixture.operator)).toEqual({
      state: "compatible", currentVersion: 1, targetVersion: migrations.at(-1)!.version,
    });
    expect((await fixture.operator.query("SELECT * FROM schema_migrations")).rows).toEqual(before);
  });

  it("reports modified checksums explicitly, including through the CLI, without bypassing migration rejection", async () => {
    await fixture.operator.query("UPDATE schema_migrations SET checksum='old-schema' WHERE version=1");
    try {
      await expect(preflightMigrations(fixture.operator)).rejects.toMatchObject({
        code: "database_schema_incompatible", migrationVersion: 1,
        message: expect.stringContaining("fresh development database"),
      });
      await expect(preflightCommand()).rejects.toMatchObject({
        code: 1, stdout: "",
        stderr: expect.stringContaining('"code":"database_schema_incompatible"'),
      });
      await expect(migrate(fixture.operator)).rejects.toMatchObject({ code: "database_schema_incompatible", migrationVersion: 1 });
      expect((await fixture.operator.query("SELECT version,checksum FROM schema_migrations")).rows).toEqual([{ version: 1, checksum: "old-schema" }]);
    } finally {
      await fixture.operator.query("UPDATE schema_migrations SET checksum=$1 WHERE version=1", [migrationChecksum(migrations[0].sql)]);
    }
  });

  it("rejects unknown future versions without altering the saved history", async () => {
    await fixture.operator.query("INSERT INTO schema_migrations(version,checksum) VALUES (999,'future-schema')");
    try {
      await expect(preflightMigrations(fixture.operator)).rejects.toMatchObject({ code: "database_schema_incompatible", migrationVersion: 999 });
      expect((await fixture.operator.query("SELECT count(*)::int AS count FROM schema_migrations")).rows[0].count).toBe(2);
    } finally { await fixture.operator.query("DELETE FROM schema_migrations WHERE version=999"); }
  });

  it("rejects a gap even if the remaining checksum matches a compiled migration", async () => {
    await fixture.operator.query("UPDATE schema_migrations SET version=2,checksum=$1 WHERE version=1", [migrationChecksum(migrations[1].sql)]);
    try {
      await expect(preflightMigrations(fixture.operator)).rejects.toMatchObject({ code: "database_schema_incompatible", migrationVersion: 2 });
    } finally {
      await fixture.operator.query("UPDATE schema_migrations SET version=1,checksum=$1 WHERE version=2", [migrationChecksum(migrations[0].sql)]);
    }
  });

  it("accepts the current schema and leaves the complete history unchanged", async () => {
    await migrate(fixture.operator);
    const before = (await fixture.operator.query("SELECT * FROM schema_migrations ORDER BY version")).rows;
    expect(await preflightMigrations(fixture.operator)).toEqual({
      state: "compatible", currentVersion: migrations.at(-1)!.version, targetVersion: migrations.at(-1)!.version,
    });
    expect((await fixture.operator.query("SELECT * FROM schema_migrations ORDER BY version")).rows).toEqual(before);
  });
});

describe("database operator diagnostics", () => {
  it.each([
    new Error("secret-password and private SQL"),
    { code: "28P01", message: "secret-password", detail: "private SQL" },
    null,
  ])("does not expose arbitrary exception messages or database details", error => {
    const result = databaseOperatorFailure(error);
    expect(result).toMatchObject({ event: "database_operator_command", outcome: "failed", code: "database_operator_failed" });
    expect(JSON.stringify(result)).not.toMatch(/secret-password|private SQL|28P01/);
  });
});
