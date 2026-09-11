import pg from "pg";
import { randomUUID } from "node:crypto";
import { databaseSettings, secretValue } from "../src/db/pool.js";
import { bootstrap, migrate, grantRuntime } from "./database.js";

export const fixturePassword = secretValue("APP_PGPASSWORD") ?? "isolated-fixture-password-never-production-01";

export async function testDatabase(initialize = true) {
  const settings = databaseSettings();
  if (!/^agentcontrol_test_[a-z0-9_]+$/.test(String(settings.database))) {
    throw new Error("Tests require a separately named agentcontrol_test_* database.");
  }
  const admin = new pg.Pool(settings);
  const name = `agentcontrol_test_${randomUUID().replaceAll("-", "")}`;
  await admin.query(`CREATE DATABASE "${name}"`);
  const operator = new pg.Pool({ ...settings, database: name });
  const runtime = new pg.Pool({ ...settings, database: name, user: "agentcontrol_app", password: fixturePassword });
  if (initialize) {
    await bootstrap(operator, fixturePassword);
    await migrate(operator);
    await grantRuntime(operator);
  }
  return {
    operator, runtime, name,
    async close() {
      const closes = await Promise.allSettled([operator.end(), runtime.end()]);
      let dropError: unknown;
      try {
        for (let attempt = 0; attempt < 40; attempt += 1) {
          try {
            await admin.query(`DROP DATABASE "${name}"`);
            dropError = undefined;
            break;
          } catch (error) {
            dropError = error;
            if ((error as { code?: string }).code !== "55006" || attempt === 39) break;
            await new Promise(resolve => setTimeout(resolve, 25));
          }
        }
      } finally { await admin.end(); }
      const closeFailure = closes.find((result): result is PromiseRejectedResult => result.status === "rejected");
      if (closeFailure) throw closeFailure.reason;
      if (dropError) throw dropError;
    },
  };
}