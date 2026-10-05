import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import pg from "pg";
import { databaseSettings } from "../src/db/pool.js";

if (process.env.AGENT_CONTROL_ISOLATED_TESTS !== "1") throw new Error("fixture_only");
const receiptFile = `/app/backend/.owned-restart-${randomUUID()}.json`;
const control = new pg.Pool(databaseSettings());
async function run(args: string[], environment: NodeJS.ProcessEnv, expected = 0) {
  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    const child = spawn(process.execPath, args, { env: environment, stdio: "inherit", signal: AbortSignal.timeout(180000) });
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  assert.deepEqual(result, { code: expected, signal: null });
}
const tool = ["/app/node_modules/tsx/dist/cli.mjs", "/app/backend/scripts/restart-fixture.ts"];
const runtimeEnvironment = {
  PATH: process.env.PATH, HOME: "/app", TMPDIR: "/app", NODE_ENV: "test", NODE_OPTIONS: "--max-old-space-size=768",
  PGHOST: "127.0.0.1", PGPORT: process.env.PGPORT, PGUSER: "agentcontrol_app", PGPASSWORD: process.env.APP_PGPASSWORD,
  SESSION_SECRET: "synthetic-owned-compiled-restart-secret",
};
let database: string | undefined;
try {
  await run([...tool, "seed", receiptFile], process.env);
  const receipt = JSON.parse(await readFile(receiptFile, "utf8"));
  assert.match(receipt.database, /^agentcontrol_test_[a-f0-9]{32}$/);
  database = receipt.database;
  for (const mode of ["crash-quarantine", "crash-canary", "crash-bulk"]) {
    await run(["/app/backend/scripts/restart-runtime.mjs", mode, receiptFile], runtimeEnvironment, 17);
  }
  await run([...tool, "expire", receiptFile], process.env);
  await run(["/app/backend/scripts/restart-runtime.mjs", "recover", receiptFile], runtimeEnvironment);
} finally {
  try {
    if (!database) {
      const receipt = await readFile(receiptFile, "utf8").then(JSON.parse).catch(() => undefined);
      if (receipt) { assert.match(receipt.database, /^agentcontrol_test_[a-f0-9]{32}$/); database = receipt.database; }
    }
    if (database) await control.query(`DROP DATABASE "${database}" WITH (FORCE)`);
  } finally { await control.end(); await rm(receiptFile, { force: true }); }
}
