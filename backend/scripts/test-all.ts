import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import pg from "pg";
import { databaseSettings } from "../src/db/pool.js";

const operator = new pg.Pool(databaseSettings());
const name = `agentcontrol_test_${randomUUID().replaceAll("-","")}`;
try {
  await operator.query(`CREATE DATABASE "${name}"`);
  for (const args of [["run","test","--workspace","backend"],["run","test","--workspace","frontend"],["run","typecheck","--workspace","backend"],["run","lint","--workspace","frontend"],["run","build"]]) {
    const result = spawnSync("npm",args,{stdio:"inherit",env:{...process.env,PGDATABASE:name},timeout:180000});
    if (result.status !== 0) throw new Error("Container validation failed.");
  }
} catch { console.error("Container validation failed; runtime was not qualified."); process.exitCode=1; }
finally {
  await operator.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  await operator.end();
}