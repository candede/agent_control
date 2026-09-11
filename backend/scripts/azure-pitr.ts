import pg from "pg";
import { pathToFileURL } from "node:url";
import { databaseSettings } from "../src/db/pool.js";
import { grantRuntime } from "./database.js";
import { assertDistinctDatabaseTargets, prepareRestoredDatabase, reopenPreparedRestoredDatabase } from "./backup.js";

function requiredHost(name: string) {
  const value = process.env[name];
  if (!value || !/^[a-z0-9.-]{1,253}$/i.test(value)) throw new Error(`${name} is missing or invalid.`);
  return value;
}

export async function prepareAzurePointInTimeRestore(
  current: pg.Pool,
  restored: pg.Pool,
  restoredFromAt: Date,
  reopen = false,
) {
  if (!Number.isFinite(restoredFromAt.getTime()) || restoredFromAt.getTime() > Date.now() + 300_000) {
    throw new Error("Approved restore point is invalid.");
  }
  const targets = assertDistinctDatabaseTargets(current, restored);
  if (targets.current.host === targets.restored.host) throw new Error("Azure PITR validation requires a separate isolated restored server.");
  await prepareRestoredDatabase(current, restored, restoredFromAt);
  await grantRuntime(restored);
  if (!reopen) return { mode: "maintenance" as const, providerWorkEnabled: false, servingDatabaseChanged: false };
  const state = await reopenPreparedRestoredDatabase(current, restored);
  return { ...state, servingDatabaseChanged: false };
}

async function main() {
  const current = new pg.Pool({ ...databaseSettings(), host: requiredHost("CURRENT_PGHOST") });
  const restored = new pg.Pool({ ...databaseSettings(), host: requiredHost("PGHOST") });
  try {
    const result = await prepareAzurePointInTimeRestore(current, restored, new Date(process.argv[2]), process.argv[3] === "reopen");
    console.log(JSON.stringify({ event: "azure_pitr_review", outcome: "succeeded", ...result }));
  } finally {
    await Promise.all([current.end(), restored.end()]);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    console.error(JSON.stringify({ event: "azure_pitr_review", outcome: "failed" }));
    process.exitCode = 1;
  });
}
