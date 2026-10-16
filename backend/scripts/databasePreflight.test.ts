import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bootstrap, databaseOperatorFailure, grantRuntime, initializeSchema, preflightSchema, setDeploymentAdmission } from "./database.js";
import { schemaFingerprint } from "../src/db/schema.js";
import { fixturePassword, testDatabase } from "./testDatabase.js";
import { loadOperationalState, providerWorkEnabled, requireProviderAdmissions } from "../src/services/operationalState.js";

const execute = promisify(execFile);
let fixture: Awaited<ReturnType<typeof testDatabase>>;
beforeAll(async () => { fixture = await testDatabase(false); });
afterAll(async () => { await fixture?.close(); });

function databaseCommand(command = "preflight", database = fixture.name, argument?: string) {
  return execute(process.execPath, ["--import", "tsx", fileURLToPath(new URL("./database.ts", import.meta.url)), command,
    ...(argument ? [argument] : [])], { env: { ...process.env, PGDATABASE: database }, timeout: 15_000 });
}

describe.sequential("current-only read-only deployment preflight", () => {
  it("accepts a fresh database without creating schema or bootstrapping runtime access", async () => {
    const expected = { state: "fresh", currentFingerprint: null, targetFingerprint: schemaFingerprint };
    expect(await preflightSchema(fixture.operator)).toEqual(expected);
    const result = await databaseCommand();
    expect(JSON.parse(result.stdout)).toEqual({
      event: "database_operator_command", command: "preflight", outcome: "succeeded", ...expected,
    });
    expect(result.stderr).toBe("");
    expect((await fixture.operator.query("SELECT count(*)::int AS count FROM pg_class WHERE relnamespace='public'::regnamespace")).rows[0].count).toBe(0);
  });

  it.each([
    ["CREATE TABLE preflight_probe(id integer); INSERT INTO preflight_probe VALUES (7)", "DROP TABLE preflight_probe"],
    ["CREATE FUNCTION preflight_probe() RETURNS integer LANGUAGE sql AS 'SELECT 1'", "DROP FUNCTION preflight_probe()"],
    ["CREATE TYPE preflight_probe AS ENUM ('saved')", "DROP TYPE preflight_probe"],
  ])("rejects non-empty unmarked schemas without converting data: %s", async (create, drop) => {
    await fixture.operator.query(create);
    try {
      await expect(preflightSchema(fixture.operator)).rejects.toMatchObject({ code: "database_schema_reset_required" });
      await expect(initializeSchema(fixture.operator)).rejects.toMatchObject({ code: "database_schema_reset_required" });
      if (create.startsWith("CREATE TABLE")) expect((await fixture.operator.query("SELECT id FROM preflight_probe")).rows).toEqual([{ id: 7 }]);
      expect((await fixture.operator.query("SELECT to_regclass('public.app_schema') AS name")).rows[0].name).toBeNull();
    } finally { await fixture.operator.query(drop); }
  });

  it("accepts the current schema and retries initialization without rewriting its identity", async () => {
    await bootstrap(fixture.operator, fixturePassword);
    await initializeSchema(fixture.operator);
    await grantRuntime(fixture.operator);
    const before = (await fixture.operator.query("SELECT * FROM app_schema")).rows;
    expect(await preflightSchema(fixture.operator)).toEqual({
      state: "current", currentFingerprint: schemaFingerprint, targetFingerprint: schemaFingerprint,
    });
    await initializeSchema(fixture.operator);
    expect((await fixture.operator.query("SELECT * FROM app_schema")).rows).toEqual(before);
  });

  it.each([
    "0".repeat(64),
    "f".repeat(64),
  ])("rejects a different fingerprint without changing it: %s", async incompatible => {
    await fixture.operator.query("UPDATE app_schema SET fingerprint=$1", [incompatible]);
    try {
      await expect(preflightSchema(fixture.operator)).rejects.toMatchObject({
        code: "database_schema_reset_required", message: expect.stringContaining("explicitly confirmed database reset"),
      });
      await expect(databaseCommand()).rejects.toMatchObject({
        code: 1, stdout: "", stderr: expect.stringContaining('"code":"database_schema_reset_required"'),
      });
      await expect(initializeSchema(fixture.operator)).rejects.toMatchObject({ code: "database_schema_reset_required" });
      await expect(setDeploymentAdmission(fixture.operator)).rejects.toMatchObject({ code: "database_schema_reset_required" });
      expect((await fixture.operator.query("SELECT fingerprint FROM app_schema")).rows).toEqual([{ fingerprint: incompatible }]);
    } finally { await fixture.operator.query("UPDATE app_schema SET fingerprint=$1", [schemaFingerprint]); }
  });

  it("does not repair a missing schema identity", async () => {
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

  it("detects grant and structural drift without changing the current marker", async () => {
    await fixture.operator.query("GRANT TRUNCATE ON audit_events TO agentcontrol_app");
    await expect(preflightSchema(fixture.operator)).rejects.toThrow("audit_origin_schema_invalid");
    await fixture.operator.query("REVOKE TRUNCATE ON audit_events FROM agentcontrol_app");
    await fixture.operator.query("ALTER TABLE data_principal_epochs RENAME COLUMN bearer_issued_after TO wrong_cutoff");
    await expect(preflightSchema(fixture.operator)).rejects.toThrow("principal_bearer_fence_schema_invalid");
    await fixture.operator.query("ALTER TABLE data_principal_epochs RENAME COLUMN wrong_cutoff TO bearer_issued_after");
    expect((await preflightSchema(fixture.operator)).currentFingerprint).toBe(schemaFingerprint);
  });
});

it("initializes, retries, and resumes normal operation through the actual operator CLI without a second enable step", async () => {
  const isolated = await testDatabase(false);
  try {
    const initialized = await databaseCommand("initialize", isolated.name);
    expect(JSON.parse(initialized.stdout)).toEqual({
      event: "database_operator_command", command: "initialize", outcome: "succeeded", schemaFingerprint,
    });
    const marker = (await isolated.operator.query("SELECT * FROM app_schema")).rows;
    await databaseCommand("initialize", isolated.name);
    expect((await isolated.operator.query("SELECT * FROM app_schema")).rows).toEqual(marker);
    await loadOperationalState(isolated.runtime);
    expect(providerWorkEnabled()).toBe(true);
    expect(() => requireProviderAdmissions()).not.toThrow();
    await databaseCommand("maintenance", isolated.name, "confirmed");
    await loadOperationalState(isolated.runtime);
    expect(providerWorkEnabled()).toBe(false);
    await databaseCommand("resume", isolated.name, "confirmed");
    await loadOperationalState(isolated.runtime);
    expect(providerWorkEnabled()).toBe(true);
    expect((await isolated.operator.query("SELECT mode FROM operational_state")).rows)
      .toEqual([{ mode: "normal" }]);
  } finally { await isolated.close(); }
});

it("rejects an unknown operator command", async () => {
  await expect(databaseCommand("unsupported-command")).rejects.toMatchObject({ code: 1, stdout: "" });
});

describe("database operator diagnostics", () => {
  it.each([new Error("secret-password and private SQL"), { code: "28P01", message: "secret-password", detail: "private SQL" }, null])(
    "does not expose arbitrary database details", error => {
      const result = databaseOperatorFailure(error);
      expect(result).toMatchObject({ event: "database_operator_command", outcome: "failed", code: "database_operator_failed" });
      expect(JSON.stringify(result)).not.toMatch(/secret-password|private SQL|28P01/);
    });
});
