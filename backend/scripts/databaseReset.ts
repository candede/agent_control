import type pg from "pg";
import { transaction } from "../src/db/pool.js";

type ResetPhase = "validation" | "drop" | "create";

export class DatabaseResetError extends Error {
  readonly code: string;
  readonly phase: ResetPhase;

  constructor(phase: ResetPhase) {
    super(phase === "validation"
      ? "Database reset denied. Require exact application database confirmation, agentcontrol_admin on the postgres maintenance database, and an operator-owned non-template target."
      : `Database reset failed during ${phase}. Application data may already have been deleted. Keep the app in maintenance, resolve the database failure and retry the explicit reset.`);
    this.code = phase === "validation" ? "database_reset_denied" : "database_reset_failed";
    this.phase = phase;
  }
}

function assertResetTarget(target: string, confirmation: string) {
  if ((target !== "agentcontrol" && !/^agentcontrol_test_[a-z0-9_]{1,64}$/.test(target)) || confirmation !== target) {
    throw new DatabaseResetError("validation");
  }
}

async function inspectResetTarget(database: Pick<pg.PoolClient, "query">, target: string) {
  const identity = await database.query<{ name: string; database: string }>("SELECT current_user AS name,current_database() AS database");
  if (identity.rows[0]?.name !== "agentcontrol_admin" || identity.rows[0]?.database !== "postgres") {
    throw new DatabaseResetError("validation");
  }
  const saved = await database.query<{ owner: string; template: boolean }>(
    "SELECT pg_get_userbyid(datdba) AS owner,datistemplate AS template FROM pg_database WHERE datname=$1", [target],
  );
  if (saved.rows.some(row => row.owner !== "agentcontrol_admin" || row.template)) {
    throw new DatabaseResetError("validation");
  }
  return { database: target, exists: saved.rows.length === 1 };
}

export async function preflightDatabaseReset(database: pg.Pool, target: string, confirmation: string) {
  assertResetTarget(target, confirmation);
  return transaction(database, async client => {
    await client.query("SET TRANSACTION READ ONLY");
    return inspectResetTarget(client, target);
  });
}

export async function resetDatabase(database: pg.Pool, target: string, confirmation: string) {
  assertResetTarget(target, confirmation);
  const client = await database.connect();
  let phase: ResetPhase = "validation";
  try {
    await client.query("SELECT pg_advisory_lock(hashtextextended($1,0))", [`agent-control:database-reset:${target}`]);
    const saved = await inspectResetTarget(client, target);
    if (saved.exists) {
      phase = "drop";
      await client.query(`DROP DATABASE "${target}" WITH (FORCE)`);
    }
    phase = "create";
    await client.query(`CREATE DATABASE "${target}" OWNER agentcontrol_admin TEMPLATE template0`);
    return { database: target, state: "fresh" };
  } catch (error) {
    if (error instanceof DatabaseResetError) throw error;
    throw new DatabaseResetError(phase);
  } finally {
    // Closing this session also releases the reset lock after any failure.
    client.release(true);
  }
}
