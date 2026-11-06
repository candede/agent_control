import pg from "pg";
import { transaction } from "../src/db/pool.js";

export type ProtectedPrincipalRevocation = {
  tenant_id: string; principal_id: string; epoch: string; bearer_issued_after: string;
};

type ResetPhase = "validation" | "drop" | "create";

export class DatabaseResetError extends Error {
  readonly code: string;
  readonly phase: ResetPhase;

  constructor(phase: ResetPhase) {
    super(phase === "validation"
      ? "Database reset denied. Require exact application database confirmation, agentcontrol_admin on the postgres maintenance database, and an operator-owned non-template target."
      : `Database reset failed during ${phase}. Application data may already have been deleted. Keep the app in maintenance and inspect the exact target and lifecycle record. Resume initialization after recreation; never repeat a completed destructive reset.`);
    this.code = phase === "validation" ? "database_reset_denied" : "database_reset_failed";
    this.phase = phase;
  }
}

function assertResetTarget(target: string, confirmation: string) {
  if (target.length > 63 || (target !== "agentcontrol" && !/^agentcontrol_test_[a-z0-9_]+$/.test(target)) || confirmation !== target) {
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
  let authority: pg.Client | undefined;
  let authorityError: Error | undefined;
  let phase: ResetPhase = "validation";
  try {
    await client.query("SELECT pg_advisory_lock(hashtextextended($1,0))", [`agent-control:database-reset:${target}`]);
    const saved = await inspectResetTarget(client, target);
    let revocations: ProtectedPrincipalRevocation[] = [];
    if (saved.exists) {
      authority = new pg.Client({ ...database.options, password: database.options.password, database: target });
      // DROP WITH FORCE intentionally terminates this lock-holding connection.
      authority.on("error", error => { authorityError ??= error; });
      await authority.connect();
      await authority.query("BEGIN");
      const tables = (await authority.query(`SELECT to_regclass('public.app_schema') AS schema,
        to_regclass('public.data_principal_epochs') AS principals`)).rows[0];
      if (tables.schema && !tables.principals) throw new DatabaseResetError("validation");
      if (tables.principals) {
        await authority.query("LOCK TABLE data_principal_epochs IN SHARE MODE");
        revocations = (await authority.query<ProtectedPrincipalRevocation>(`SELECT tenant_id,principal_id,
          epoch::text,bearer_issued_after::text FROM data_principal_epochs WHERE bearer_issued_after>0`)).rows;
      }
    }
    // Preserve actual revocation authority, never manufacture a reset-time token cutoff.
    await client.query(`CREATE TABLE IF NOT EXISTS public.agentcontrol_principal_revocations(
      database_name text NOT NULL,tenant_id text NOT NULL CHECK(length(tenant_id) BETWEEN 1 AND 128),
      principal_id text NOT NULL CHECK(length(principal_id) BETWEEN 1 AND 256),
      epoch bigint NOT NULL CHECK(epoch>=0),bearer_issued_after bigint NOT NULL CHECK(bearer_issued_after>0),
      PRIMARY KEY(database_name,tenant_id,principal_id));
      REVOKE ALL ON public.agentcontrol_principal_revocations FROM PUBLIC;
      DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='agentcontrol_app') THEN
        REVOKE ALL ON public.agentcontrol_principal_revocations FROM agentcontrol_app;
      END IF; END $$`);
    for (let offset = 0; offset < revocations.length; offset += 1000) {
      await client.query(`INSERT INTO public.agentcontrol_principal_revocations(
        database_name,tenant_id,principal_id,epoch,bearer_issued_after)
        SELECT $1,tenant_id,principal_id,epoch,bearer_issued_after FROM jsonb_to_recordset($2::jsonb)
          AS records(tenant_id text,principal_id text,epoch bigint,bearer_issued_after bigint)
        ON CONFLICT(database_name,tenant_id,principal_id) DO UPDATE SET
          epoch=GREATEST(agentcontrol_principal_revocations.epoch,EXCLUDED.epoch),
          bearer_issued_after=GREATEST(agentcontrol_principal_revocations.bearer_issued_after,EXCLUDED.bearer_issued_after)`,
      [target, JSON.stringify(revocations.slice(offset, offset + 1000))]);
    }
    if (saved.exists) {
      if (authorityError) throw authorityError;
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
    try { await authority?.end(); }
    finally {
      // Closing this session also releases the reset lock after any failure.
      client.release(true);
    }
  }

}
