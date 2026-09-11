import pg from "pg";
import { pathToFileURL } from "node:url";
import { databaseSettings, secretValue, transaction } from "../src/db/pool.js";
import { migrations, migrationChecksum, verifySchema } from "../src/db/schema.js";

export type AzureDatabaseMode = "fresh" | "upgrade" | "legacy_import";

export type AzureDatabasePreflight = {
  mode: AzureDatabaseMode;
  database: string;
  currentVersion: number;
  tableCount: number;
};

async function identity(database: Pick<pg.Pool, "query">, expectedDatabase: string) {
  if (expectedDatabase !== "agentcontrol" && !/^agentcontrol_test_[a-z0-9_]{1,64}$/.test(expectedDatabase)) {
    throw new Error("Expected database identity is invalid.");
  }
  const result = await database.query<{ user_name: string; database_name: string }>(
    "SELECT current_user AS user_name,current_database() AS database_name",
  );
  if (result.rows[0]?.user_name !== "agentcontrol_admin" || result.rows[0]?.database_name !== expectedDatabase) {
    throw new Error("Azure database orchestration requires agentcontrol_admin on the exact agentcontrol database.");
  }
  return result.rows[0];
}

export async function preflightAzureDatabase(
  database: Pick<pg.Pool, "query">,
  mode: AzureDatabaseMode,
  expectedCurrentVersion: number,
  expectedDatabase = "agentcontrol",
): Promise<AzureDatabasePreflight> {
  const current = await identity(database, expectedDatabase);
  if (!Number.isInteger(expectedCurrentVersion) || expectedCurrentVersion < 0 || expectedCurrentVersion > migrations.length) {
    throw new Error("Expected schema version is outside the compiled migration range.");
  }
  const tables = await database.query<{ count: number }>(
    "SELECT count(*)::int AS count FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'",
  );
  const tableCount = tables.rows[0]?.count ?? 0;
  const migrationTable = await database.query<{ table_name: string | null }>(
    "SELECT to_regclass('public.schema_migrations')::text AS table_name",
  );
  if (mode === "fresh") {
    if (expectedCurrentVersion !== 0 || migrationTable.rows[0]?.table_name || tableCount !== 0) {
      throw new Error("Fresh install requires an explicitly approved empty database; existing schema is never replaced.");
    }
    return { mode, database: current.database_name, currentVersion: 0, tableCount };
  }
  if (!migrationTable.rows[0]?.table_name) {
    throw new Error("Expected existing schema is missing; initialization fallback is forbidden.");
  }
  const applied = await database.query<{ version: number; checksum: string }>(
    "SELECT version,checksum FROM schema_migrations ORDER BY version",
  );
  if (applied.rowCount !== expectedCurrentVersion) {
    throw new Error("Existing schema version differs from the exact approved deployment baseline.");
  }
  for (const [index, row] of applied.rows.entries()) {
    if (row.version !== migrations[index]?.version || row.checksum !== migrationChecksum(migrations[index].sql)) {
      throw new Error("Existing schema contains an unknown or modified migration.");
    }
  }
  return { mode, database: current.database_name, currentVersion: applied.rowCount, tableCount };
}

export async function enterAzureMaintenance(database: Pick<pg.Pool, "query">, expectedDatabase = "agentcontrol") {
  await identity(database, expectedDatabase);
  await verifySchema(database as pg.Pool);
  const result = await database.query(
    "UPDATE operational_state SET mode='maintenance',updated_at=clock_timestamp() WHERE singleton=true RETURNING provider_work_enabled",
  );
  if (result.rowCount !== 1) throw new Error("Operational state is missing; maintenance was not entered.");
  return { mode: "maintenance" as const, providerWorkEnabledBefore: Boolean(result.rows[0].provider_work_enabled) };
}

export async function verifyAzureDrain(database: Pick<pg.Pool, "query">, expectedDatabase = "agentcontrol") {
  await identity(database, expectedDatabase);
  await verifySchema(database as pg.Pool);
  const result = await database.query<{
    execution_owners: number;
    inconclusive_writes: number;
  }>(`SELECT
    ((SELECT count(*) FROM jobs WHERE lease_owner IS NOT NULL OR lease_until IS NOT NULL)
      +(SELECT count(*) FROM purview_audit_jobs WHERE execution_owner IS NOT NULL)
      +(SELECT count(*) FROM defender_hunting_jobs WHERE execution_owner IS NOT NULL)
      +(SELECT count(*) FROM copilot_quarantine_jobs WHERE lease_owner IS NOT NULL OR lease_until IS NOT NULL))::int AS execution_owners,
    ((SELECT count(*) FROM job_items WHERE status='inconclusive')
      +(SELECT count(*) FROM copilot_quarantine_job_items WHERE status='inconclusive')
      +(SELECT count(*) FROM purview_audit_jobs WHERE status='inconclusive'))::int AS inconclusive_writes`);
  const summary = result.rows[0];
  if (!summary || summary.execution_owners !== 0) {
    throw new Error("Execution owners remain after the bounded drain; keep maintenance and reconcile without replay.");
  }
  return summary;
}

export async function reopenAzureDatabase(database: Pick<pg.Pool, "query">, expectedDatabase = "agentcontrol") {
  await identity(database, expectedDatabase);
  await verifySchema(database as pg.Pool);
  const drained = await verifyAzureDrain(database, expectedDatabase);
  const result = await database.query(
    `UPDATE operational_state SET mode='normal',provider_work_enabled=false,updated_at=clock_timestamp()
      WHERE singleton=true AND mode='maintenance' RETURNING mode,provider_work_enabled`,
  );
  if (result.rowCount !== 1) throw new Error("Reopen requires the exact database to remain in maintenance.");
  return { mode: "normal" as const, providerWorkEnabled: false, inconclusiveWrites: drained.inconclusive_writes };
}

export async function verifyAzureRuntimePrivileges(database: Pick<pg.Pool, "query">, expectedDatabase = "agentcontrol") {
  const result = await database.query<{
    user_name: string;
    database_name: string;
    schema_create: boolean;
    migration_read: boolean;
    operational_write: boolean;
    audit_append: boolean;
    audit_update: boolean;
    audit_delete: boolean;
    excessive_role: boolean;
  }>(`SELECT current_user AS user_name,current_database() AS database_name,
    has_schema_privilege(current_user,'public','CREATE') AS schema_create,
    has_table_privilege(current_user,'schema_migrations','SELECT') AS migration_read,
    has_table_privilege(current_user,'operational_state','UPDATE') AS operational_write,
    has_table_privilege(current_user,'audit_events','INSERT') AS audit_append,
    has_table_privilege(current_user,'audit_events','UPDATE') AS audit_update,
    has_table_privilege(current_user,'audit_events','DELETE') AS audit_delete,
    EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND
      (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)) AS excessive_role`);
  const row = result.rows[0];
  if (!row || row.user_name !== "agentcontrol_app" || row.database_name !== expectedDatabase || row.schema_create ||
    !row.migration_read || row.operational_write || !row.audit_append || row.audit_update || row.audit_delete || row.excessive_role) {
    throw new Error("Runtime database privilege separation failed.");
  }
  return { user: row.user_name, database: row.database_name, ddlDenied: true, auditMutationDenied: true };
}

export async function rotateAzureRuntimeCredential(database: pg.Pool, password: string, expectedDatabase = "agentcontrol") {
  await identity(database, expectedDatabase);
  if (password.length < 32 || password.length > 256 || /[\r\n\0]/.test(password)) {
    throw new Error("Approved runtime database password is invalid.");
  }
  await transaction(database, async client => {
    await client.query("SELECT pg_advisory_xact_lock(3650101)");
    const role = await client.query("SELECT 1 FROM pg_roles WHERE rolname='agentcontrol_app'");
    if (role.rowCount !== 1) throw new Error("Runtime role is missing; credential rotation cannot initialize a replacement.");
    const quoted = await client.query<{ password: string }>("SELECT quote_literal($1) AS password", [password]);
    await client.query(`ALTER ROLE agentcontrol_app PASSWORD ${quoted.rows[0].password}`);
  });
  const runtime = new pg.Pool({ ...databaseSettings(), host: database.options.host, database: expectedDatabase, user: "agentcontrol_app", password, max: 1 });
  try {
    await verifyAzureRuntimePrivileges(runtime, expectedDatabase);
  } finally { await runtime.end(); }
  return { runtimeCredentialRotated: true, valueRedacted: true };
}

async function main() {
  const action = process.argv[2];
  const database = new pg.Pool(databaseSettings());
  try {
    const result = action === "preflight"
      ? await preflightAzureDatabase(database, process.argv[3] as AzureDatabaseMode, Number(process.argv[4]))
      : action === "maintenance" ? await enterAzureMaintenance(database)
      : action === "drain" ? await verifyAzureDrain(database)
      : action === "reopen" ? await reopenAzureDatabase(database)
      : action === "runtime" ? await verifyAzureRuntimePrivileges(database)
      : action === "rotate-runtime" ? await rotateAzureRuntimeCredential(database, secretValue("APP_PGPASSWORD") ?? "")
      : action === "verify" ? await verifySchema(database)
      : Promise.reject(new Error("Unknown Azure database action."));
    console.log(JSON.stringify({ event: "azure_database_orchestration", action, outcome: "succeeded", ...result }));
  } finally {
    await database.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    console.error(JSON.stringify({ event: "azure_database_orchestration", outcome: "failed" }));
    process.exitCode = 1;
  });
}
