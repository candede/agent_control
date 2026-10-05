import pg from "pg";
import { randomUUID } from "node:crypto";
import { databaseSettings, secretValue } from "../src/db/pool.js";
import { bootstrap, initializeSchema, grantRuntime } from "./database.js";
import { closeFixtureResources } from "./fixtureSupport.js";
import { prepareTestSchemaTemplate } from "./testDatabaseTemplate.js";
import { verifySchema } from "../src/db/schema.js";

export const fixturePassword = secretValue("APP_PGPASSWORD") ?? "isolated-fixture-password-never-production-01";

export async function testDatabase(initialize = true) {
  const started = performance.now();
  const settings = databaseSettings();
  if (!/^agentcontrol_test_[a-z0-9_]+$/.test(String(settings.database))) {
    throw new Error("Tests require a separately named agentcontrol_test_* database.");
  }
  const admin = new pg.Pool(settings);
  const name = `agentcontrol_test_${randomUUID().replaceAll("-", "")}`;
  let created = false;
  let operator: pg.Pool | undefined;
  let runtime: pg.Pool | undefined;
  const close = () => closeFixtureResources(
    () => operator?.end(),
    () => runtime?.end(),
    async () => {
      if (!created) return;
      for (let attempt = 0; attempt < 40; attempt += 1) {
        try {
          await admin.query(`DROP DATABASE "${name}"`);
          return;
        } catch (error) {
          if (typeof error !== "object" || error === null || !("code" in error) || error.code !== "55006" || attempt === 39) throw error;
          await new Promise(resolve => setTimeout(resolve, 25));
        }
      }
    },
    () => admin.end(),
  );
  try {
    const template = initialize ? await prepareTestSchemaTemplate(admin, settings, fixturePassword) : undefined;
    for (let attempt = 0; ; attempt++) {
      try {
        await admin.query(`CREATE DATABASE "${name}"${template ? ` TEMPLATE "${template}" ALLOW_CONNECTIONS true` : ""}`);
        break;
      } catch (error) {
        if (!template || attempt === 39 || typeof error !== "object" || error === null || !("code" in error) || error.code !== "55006") throw error;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    }
    created = true;
    operator = new pg.Pool({ ...settings, database: name });
    runtime = new pg.Pool({ ...settings, database: name, user: "agentcontrol_app", password: fixturePassword });
    if (initialize) {
      await bootstrap(operator, fixturePassword);
      if (template) await verifySchema(runtime);
      else {
        await initializeSchema(operator);
        await grantRuntime(operator);
      }
    }
    if (process.env.AGENT_CONTROL_ISOLATED_TESTS === "1") process.stdout.write(JSON.stringify({
      event: "test_database_initialization", database: name, template: template ?? null,
      mode: !initialize ? "empty" : template ? "verified-clone" : "fresh-schema",
      elapsedMs: performance.now() - started,
    }) + "\n");
    const release = () => closeFixtureResources(() => operator?.end(), () => runtime?.end(), () => admin.end());
    return { operator, runtime, name, close, release };
  } catch (error) {
    try { await close(); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], "Test database initialization and cleanup failed."); }
    throw error;
  }
}