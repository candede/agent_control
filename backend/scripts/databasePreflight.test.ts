import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bootstrap, databaseOperatorFailure, initializeSchema, preflightSchema } from "./database.js";
import { schemaFingerprint } from "../src/db/schema.js";
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
    const expected = { state: "fresh", currentFingerprint: null, targetFingerprint: schemaFingerprint };
    expect(await preflightSchema(fixture.operator)).toEqual(expected);
    const result = await preflightCommand();
    expect(JSON.parse(result.stdout)).toEqual({
      event: "database_operator_command", command: "preflight", outcome: "succeeded", ...expected,
    });
    expect(result.stderr).toBe("");
    expect((await fixture.operator.query("SELECT count(*)::int AS count FROM pg_class WHERE relnamespace='public'::regnamespace")).rows[0].count).toBe(0);
  });

  it("requires an explicit reset for an unrelated saved schema without changing its data", async () => {
    await fixture.operator.query("CREATE TABLE preflight_probe(id integer); INSERT INTO preflight_probe VALUES (7)");
    try {
      await expect(preflightSchema(fixture.operator)).rejects.toMatchObject({ code: "database_schema_reset_required" });
      await expect(initializeSchema(fixture.operator)).rejects.toMatchObject({ code: "database_schema_reset_required" });
      expect((await fixture.operator.query("SELECT id FROM preflight_probe")).rows).toEqual([{ id: 7 }]);
      expect((await fixture.operator.query("SELECT to_regclass('public.app_schema') AS name")).rows[0].name).toBeNull();
    } finally { await fixture.operator.query("DROP TABLE preflight_probe"); }
  });

  it("rejects leftover functions and types even when no tables exist", async () => {
    for (const [create, drop] of [
      ["CREATE FUNCTION preflight_probe() RETURNS integer LANGUAGE sql AS 'SELECT 1'", "DROP FUNCTION preflight_probe()"],
      ["CREATE TYPE preflight_probe AS ENUM ('saved')", "DROP TYPE preflight_probe"],
    ]) {
      await fixture.operator.query(create);
      try {
        await expect(preflightSchema(fixture.operator)).rejects.toMatchObject({ code: "database_schema_reset_required" });
        await expect(initializeSchema(fixture.operator)).rejects.toMatchObject({ code: "database_schema_reset_required" });
      } finally { await fixture.operator.query(drop); }
    }
  });

  it("accepts the current schema without changing its singleton identity", async () => {
    await bootstrap(fixture.operator, fixturePassword);
    await initializeSchema(fixture.operator);
    const before = (await fixture.operator.query("SELECT * FROM app_schema")).rows;
    expect(await preflightSchema(fixture.operator)).toEqual({
      state: "current", currentFingerprint: schemaFingerprint, targetFingerprint: schemaFingerprint,
    });
    await initializeSchema(fixture.operator);
    expect((await fixture.operator.query("SELECT * FROM app_schema")).rows).toEqual(before);
  });

  it("reports an incompatible fingerprint explicitly through preflight and initialization without changing it", async () => {
    const incompatible = "0".repeat(64);
    await fixture.operator.query("UPDATE app_schema SET fingerprint=$1", [incompatible]);
    try {
      await expect(preflightSchema(fixture.operator)).rejects.toMatchObject({
        code: "database_schema_reset_required",
        message: expect.stringContaining("Explicitly reset"),
      });
      await expect(preflightCommand()).rejects.toMatchObject({
        code: 1, stdout: "",
        stderr: expect.stringContaining('"code":"database_schema_reset_required"'),
      });
      await expect(initializeSchema(fixture.operator)).rejects.toMatchObject({ code: "database_schema_reset_required" });
      expect((await fixture.operator.query("SELECT fingerprint FROM app_schema")).rows).toEqual([{ fingerprint: incompatible }]);
    } finally {
      await fixture.operator.query("UPDATE app_schema SET fingerprint=$1", [schemaFingerprint]);
    }
  });

  it("requires reset when the schema identity row is missing instead of repairing it", async () => {
    const before = (await fixture.operator.query("DELETE FROM app_schema RETURNING *")).rows[0];
    try {
      await expect(preflightSchema(fixture.operator)).rejects.toMatchObject({ code: "database_schema_reset_required" });
      await expect(initializeSchema(fixture.operator)).rejects.toMatchObject({ code: "database_schema_reset_required" });
      expect((await fixture.operator.query("SELECT * FROM app_schema")).rows).toEqual([]);
    } finally {
      await fixture.operator.query("INSERT INTO app_schema(singleton,fingerprint,initialized_at) VALUES (true,$1,$2)",
        [before.fingerprint, before.initialized_at]);
    }
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
