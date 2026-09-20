import pg from "pg";
import { randomUUID } from "node:crypto";
import { databaseSettings, secretValue } from "../src/db/pool.js";
import { bootstrap, migrate, grantRuntime } from "./database.js";
import { closeFixtureResources } from "./fixtureSupport.js";

export const fixturePassword = secretValue("APP_PGPASSWORD") ?? "isolated-fixture-password-never-production-01";

export async function testDatabase(initialize = true) {
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
    await admin.query(`CREATE DATABASE "${name}"`);
    created = true;
    operator = new pg.Pool({ ...settings, database: name });
    runtime = new pg.Pool({ ...settings, database: name, user: "agentcontrol_app", password: fixturePassword });
    if (initialize) {
      await bootstrap(operator, fixturePassword);
      await migrate(operator);
      await grantRuntime(operator);
    }
    return { operator, runtime, name, close };
  } catch (error) {
    try { await close(); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], "Test database initialization and cleanup failed."); }
    throw error;
  }
}