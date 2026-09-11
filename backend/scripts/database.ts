import pg from "pg";
import { pathToFileURL } from "node:url";
import { databaseSettings, secretValue, transaction } from "../src/db/pool.js";
import { migrations, migrationChecksum, verifySchema } from "../src/db/schema.js";

export async function migrate(database: pg.Pool, steps: ReadonlyArray<{ version: number; sql: string }> = migrations) {
  await transaction(database, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(3650101)");
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version integer PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT clock_timestamp())`);
    const applied = await client.query<{ version: number; checksum: string }>("SELECT version, checksum FROM schema_migrations ORDER BY version");
    for (const [index, row] of applied.rows.entries()) {
      if (steps[index]?.version !== row.version || migrationChecksum(steps[index].sql) !== row.checksum) {
        throw new Error("Unknown or modified applied migration; no changes applied.");
      }
    }
    for (const step of steps.slice(applied.rows.length)) {
      await client.query(step.sql);
      await client.query("INSERT INTO schema_migrations(version,checksum) VALUES ($1,$2)", [step.version, migrationChecksum(step.sql)]);
    }
  });
}

export async function bootstrap(database: pg.Pool, password: string) {
  if (password.length < 32 || password.length > 256 || /[\r\n\0]/.test(password)) {
    throw new Error("Runtime database password is missing or invalid; recover the existing secret.");
  }
  await transaction(database, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(3650101)");
    const identity = await client.query("SELECT current_user AS name, current_database() AS database");
    if (identity.rows[0].name !== "agentcontrol_admin") throw new Error("Bootstrap requires agentcontrol_admin.");
    await client.query("REVOKE CREATE ON SCHEMA public FROM PUBLIC");
    const exists = await client.query("SELECT 1 FROM pg_roles WHERE rolname='agentcontrol_app'");
    if (!exists.rowCount) {
      const quoted = await client.query<{ password: string }>("SELECT quote_literal($1) AS password", [password]);
      await client.query(`CREATE ROLE agentcontrol_app LOGIN PASSWORD ${quoted.rows[0].password} NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION`);
    }
    const role = await client.query("SELECT rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls FROM pg_roles WHERE rolname='agentcontrol_app'");
    const memberships = await client.query("SELECT 1 FROM pg_auth_members WHERE member='agentcontrol_app'::regrole");
    if (Object.values(role.rows[0]).some(Boolean) || memberships.rowCount) throw new Error("Runtime role has excessive privileges; operator recovery required.");
    const name = identity.rows[0].database.replaceAll('"', '""');
    await client.query(`REVOKE ALL ON DATABASE "${name}" FROM PUBLIC`);
    await client.query(`GRANT CONNECT ON DATABASE "${name}" TO agentcontrol_app`);
    await client.query("GRANT USAGE ON SCHEMA public TO agentcontrol_app");
  });
  const runtime = new pg.Pool({ ...databaseSettings(), host: database.options.host, database: database.options.database, port: database.options.port, user: "agentcontrol_app", password, max: 1 });
  try { await runtime.query("SELECT 1"); } finally { await runtime.end(); }
}

export async function grantRuntime(database: pg.Pool) {
  const owned = await database.query("SELECT 1 FROM pg_class WHERE relnamespace='public'::regnamespace AND relowner='agentcontrol_app'::regrole UNION ALL SELECT 1 FROM pg_namespace WHERE nspowner='agentcontrol_app'::regrole");
  if (owned.rowCount) throw new Error("Runtime role must not own schema objects.");
  await database.query(`
    REVOKE ALL ON ALL TABLES IN SCHEMA public FROM agentcontrol_app;
    REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;
    GRANT SELECT ON schema_migrations TO agentcontrol_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON sessions, jobs, job_items, job_attempts, source_identifiers, capability_configuration, capability_evidence TO agentcontrol_app;
    GRANT SELECT, INSERT, UPDATE ON power_platform_refresh_jobs, power_platform_inventory_snapshots TO agentcontrol_app;
    GRANT SELECT, INSERT ON power_platform_inventory_resources TO agentcontrol_app;
    GRANT SELECT, INSERT, UPDATE ON package_refresh_jobs, package_inventory_snapshots TO agentcontrol_app;
    GRANT SELECT, INSERT ON package_inventory_resources TO agentcontrol_app;
    GRANT SELECT, INSERT, UPDATE ON package_mutation_qualifications TO agentcontrol_app;
    GRANT SELECT, INSERT ON audit_events TO agentcontrol_app;
    GRANT SELECT ON audit_projection TO agentcontrol_app;
  `);
  if ((await database.query("SELECT to_regclass('public.operational_state') AS table_name")).rows[0].table_name) {
    await database.query("GRANT SELECT ON operational_state TO agentcontrol_app");
  }
  if ((await database.query("SELECT to_regclass('public.purview_audit_jobs') AS table_name")).rows[0].table_name) {
    await database.query(`
      GRANT SELECT, INSERT, UPDATE ON purview_audit_qualifications TO agentcontrol_app;
      GRANT SELECT, INSERT, UPDATE, DELETE ON purview_audit_jobs TO agentcontrol_app;
      GRANT SELECT, INSERT ON purview_audit_records TO agentcontrol_app;
    `);
  }
  if ((await database.query("SELECT to_regclass('public.defender_hunting_jobs') AS table_name")).rows[0].table_name) {
    await database.query(`
      GRANT SELECT, INSERT, UPDATE, DELETE ON defender_hunting_jobs TO agentcontrol_app;
      GRANT SELECT, INSERT ON defender_hunting_snapshots, defender_hunting_rows TO agentcontrol_app;
      GRANT SELECT, INSERT ON defender_hunting_qualification_evidence TO agentcontrol_app;
      GRANT SELECT, INSERT, UPDATE ON defender_hunting_retained_scopes TO agentcontrol_app;
    `);
  }
  if ((await database.query("SELECT to_regclass('public.copilot_quarantine_jobs') AS table_name")).rows[0].table_name) {
    await database.query(`
      GRANT SELECT, INSERT ON copilot_quarantine_status_observations, copilot_quarantine_audit, copilot_quarantine_qualifications TO agentcontrol_app;
      GRANT SELECT, INSERT, UPDATE ON copilot_quarantine_jobs, copilot_quarantine_job_items, copilot_quarantine_attempts, copilot_quarantine_canary_approvals TO agentcontrol_app;
    `);
  }
  if ((await database.query("SELECT to_regclass('public.official_usage_staging') AS table_name")).rows[0].table_name) {
    await database.query(`
      GRANT SELECT, INSERT, UPDATE, DELETE ON official_usage_staging, official_usage_staged_rows TO agentcontrol_app;
      GRANT SELECT, INSERT, UPDATE ON official_usage_artifacts, official_usage_sets, official_usage_versions, official_usage_state TO agentcontrol_app;
      GRANT SELECT, INSERT, UPDATE, DELETE ON official_usage_confirmations TO agentcontrol_app;
      GRANT SELECT, INSERT, DELETE ON official_usage_version_rows, official_usage_set_versions TO agentcontrol_app;
      GRANT SELECT, INSERT ON official_usage_bundle_receipts TO agentcontrol_app;
      GRANT SELECT, INSERT ON official_usage_audit TO agentcontrol_app;
    `);
  }
}

export type RetentionResult = { dryRun: boolean; batchSize: number; affected: Record<string, number> };
export type RetentionCompletionResult = { passes: number; affected: Record<string, number> };

export async function retain(database: pg.Pool, options: { batchSize?: number; dryRun?: boolean } = {}): Promise<RetentionResult> {
  const batchSize = options.batchSize ?? 1_000;
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 5_000) throw new Error("Retention batch size must be 1-5000.");
  const client = await database.connect();
  const affected: Record<string, number> = {};
  const run = async (name: string, sql: string) => {
    const result = await client.query(sql, [batchSize]);
    affected[name] = result.rowCount ?? 0;
  };
  const remove = (name: string, table: string, where: string) => run(name,
    `WITH candidates AS (SELECT ctid FROM ${table} WHERE ${where} LIMIT $1 FOR UPDATE SKIP LOCKED)
     DELETE FROM ${table} target USING candidates WHERE target.ctid=candidates.ctid`);
  const update = (name: string, table: string, where: string, changes: string) => run(name,
    `WITH candidates AS (SELECT ctid FROM ${table} WHERE ${where} LIMIT $1 FOR UPDATE SKIP LOCKED)
     UPDATE ${table} target SET ${changes} FROM candidates WHERE target.ctid=candidates.ctid`);
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='15s'");
    if (!(await client.query("SELECT pg_try_advisory_xact_lock(3650111) AS acquired")).rows[0].acquired) {
      throw new Error("Another retention cleanup owns the database lock.");
    }
    await remove("sessions", "sessions", "expire<clock_timestamp()");
    await remove("jobs", "jobs", "expires_at<clock_timestamp() AND (lease_until IS NULL OR lease_until<clock_timestamp())");
    await remove("administrativeAudit", "audit_events", "observed_at<clock_timestamp()-interval '90 days'");
    await remove("legacyImportReceipts", "legacy_audit_imports", "imported_at<clock_timestamp()-interval '90 days'");
    await remove("capabilityEvidence", "capability_evidence", "expires_at<clock_timestamp()");
    await update("powerPlatformExpiredWork", "power_platform_refresh_jobs",
      "status='running' AND (expires_at<=clock_timestamp() OR deadline_at<=clock_timestamp())",
      "status='failed',error_code='inventory_job_expired',message='The inventory refresh expired during retention.',finished_at=clock_timestamp(),updated_at=clock_timestamp()");
    await remove("powerPlatformSnapshots", "power_platform_inventory_snapshots", "expires_at<clock_timestamp()");
    await remove("powerPlatformJobs", "power_platform_refresh_jobs", "expires_at<clock_timestamp() AND status<>'running'");
    await update("packageExpiredWork", "package_refresh_jobs",
      "status='running' AND (expires_at<=clock_timestamp() OR deadline_at<=clock_timestamp())",
      "status='failed',error_code='package_refresh_expired',message='The package refresh expired during retention.',finished_at=clock_timestamp(),updated_at=clock_timestamp()");
    await remove("packageSnapshots", "package_inventory_snapshots", "expires_at<clock_timestamp()");
    await remove("packageJobs", "package_refresh_jobs", "expires_at<clock_timestamp() AND status<>'running'");
    await remove("packageQualifications", "package_mutation_qualifications", "expires_at<clock_timestamp()");
    await update("purviewExpiredWork", "purview_audit_jobs",
      "status IN ('running','reconciling_create') AND deadline_at<=clock_timestamp()",
      "status='inconclusive',error_code='audit_job_expired',message='The local Audit Search deadline expired; remote work may continue.',remote_work_may_continue=attempted_at IS NOT NULL,finished_at=clock_timestamp(),execution_owner=NULL,updated_at=clock_timestamp()");
    await remove("purviewJobs", "purview_audit_jobs", "expires_at<clock_timestamp() AND status NOT IN ('running','reconciling_create')");
    await update("purviewQualificationExpiry", "purview_audit_qualifications",
      "expires_at<clock_timestamp() AND status IN ('approved','qualified')", "status='expired',updated_at=clock_timestamp()");
    await remove("purviewQualifications", "purview_audit_qualifications", "expires_at<clock_timestamp()-interval '30 days' AND job_id IS NULL");
    await update("defenderExpiredWork", "defender_hunting_jobs",
      "status IN ('running','waiting_authorization') AND (deadline_at<=clock_timestamp() OR activation_count>=4 OR provider_request_count>=12)",
      "status='inconclusive',error_code=CASE WHEN deadline_at<=clock_timestamp() THEN 'hunting_job_expired' WHEN activation_count>=4 THEN 'hunting_activation_limit' ELSE 'hunting_provider_request_limit' END,message='The bounded hunting deadline expired before publication.',finished_at=clock_timestamp(),execution_owner=NULL,updated_at=clock_timestamp()");
    await remove("defenderJobs", "defender_hunting_jobs", "expires_at<clock_timestamp() AND status<>'running'");
    await remove("defenderQualifications", "defender_hunting_qualification_evidence", "expires_at<clock_timestamp()");
    await remove("defenderRetainedScopes", "defender_hunting_retained_scopes",
      "expires_at<clock_timestamp() AND NOT EXISTS (SELECT 1 FROM defender_hunting_jobs job WHERE job.retained_scope_id=defender_hunting_retained_scopes.id)");
    await update("quarantineExpiredWork", "copilot_quarantine_jobs",
      "status='running' AND (deadline_at<=clock_timestamp() OR attempts>=10)",
      "status='inconclusive',lease_owner=NULL,lease_until=NULL,updated_at=clock_timestamp()");
    await remove("quarantineJobs", "copilot_quarantine_jobs", "expires_at<clock_timestamp() AND status<>'running'");
    await remove("quarantineObservations", "copilot_quarantine_status_observations", "expires_at<clock_timestamp()");
    await remove("quarantineAudit", "copilot_quarantine_audit", "expires_at<clock_timestamp()");
    await update("quarantineApprovalExpiry", "copilot_quarantine_canary_approvals",
      "status='approved' AND approval_expires_at<clock_timestamp()", "status='expired',finished_at=COALESCE(finished_at,clock_timestamp())");
    await remove("quarantineApprovals", "copilot_quarantine_canary_approvals", "evidence_expires_at<clock_timestamp()");
    await remove("quarantineQualifications", "copilot_quarantine_qualifications", "expires_at<clock_timestamp()");
    await update("officialStagingExpiry", "official_usage_staging", "status='active' AND expires_at<clock_timestamp()", "status='expired'");
    await remove("officialStagedRows", "official_usage_staged_rows",
      "EXISTS (SELECT 1 FROM official_usage_staging staging WHERE staging.id=official_usage_staged_rows.staging_id AND staging.status IN ('expired','replaced','cancelled'))");
    await remove("officialConfirmations", "official_usage_confirmations", "expires_at<clock_timestamp() OR consumed_at<clock_timestamp()-interval '1 day'");
    await update("officialActiveSelection", "official_usage_state",
      "EXISTS (SELECT 1 FROM official_usage_sets report_set WHERE report_set.id=official_usage_state.active_set_id AND report_set.expires_at<clock_timestamp())",
      "active_set_id=NULL,revision=revision+1,updated_at=clock_timestamp()");
    await update("officialSetsExpired", "official_usage_sets", "deleted_at IS NULL AND expires_at<clock_timestamp()", "deleted_at=clock_timestamp()");
    await update("officialVersionsExpired", "official_usage_versions",
      "deleted_at IS NULL AND (expires_at<clock_timestamp() OR EXISTS (SELECT 1 FROM official_usage_set_versions membership JOIN official_usage_sets report_set ON report_set.id=membership.set_id WHERE membership.version_id=official_usage_versions.id AND report_set.deleted_at IS NOT NULL))",
      "deleted_at=clock_timestamp()");
    await remove("officialRows", "official_usage_version_rows",
      "EXISTS (SELECT 1 FROM official_usage_versions version WHERE version.id=official_usage_version_rows.version_id AND version.deleted_at IS NOT NULL)");
    await remove("officialStaging", "official_usage_staging", "status<>'active' AND created_at<clock_timestamp()-interval '1 day'");
    await remove("officialBundleReceipts", "official_usage_bundle_receipts", "expires_at<clock_timestamp()");
    await remove("officialAudit", "official_usage_audit", "expires_at<clock_timestamp()");
    await remove("officialMemberships", "official_usage_set_versions",
      "EXISTS (SELECT 1 FROM official_usage_sets report_set WHERE report_set.id=official_usage_set_versions.set_id AND report_set.deleted_at<clock_timestamp()-interval '90 days')");
    await remove("officialVersions", "official_usage_versions",
      "deleted_at<clock_timestamp()-interval '90 days' AND NOT EXISTS (SELECT 1 FROM official_usage_set_versions membership WHERE membership.version_id=official_usage_versions.id)");
    await remove("officialArtifacts", "official_usage_artifacts",
      "expires_at<clock_timestamp() AND NOT EXISTS (SELECT 1 FROM official_usage_versions version WHERE version.artifact_id=official_usage_artifacts.id)");
    await remove("officialSets", "official_usage_sets",
      "deleted_at<clock_timestamp()-interval '90 days' AND NOT EXISTS (SELECT 1 FROM official_usage_set_versions membership WHERE membership.set_id=official_usage_sets.id)");
    await remove("sourceIdentifiers", "source_identifiers", `
      (source='graph_packages'
        AND NOT EXISTS (SELECT 1 FROM job_items JOIN jobs ON jobs.id=job_items.job_id WHERE jobs.tenant_id=source_identifiers.tenant_id AND source_identifiers.resource_type='microsoft.graph/copilotpackages' AND job_items.target_id=source_identifiers.native_id AND job_items.target_id=source_identifiers.identifier_value)
        AND NOT EXISTS (SELECT 1 FROM package_inventory_resources resource JOIN package_inventory_snapshots snapshot ON snapshot.id=resource.snapshot_id AND snapshot.is_current AND snapshot.expires_at>clock_timestamp()
          CROSS JOIN LATERAL jsonb_to_recordset(resource.identifiers) AS identifier(kind text,value text)
          WHERE resource.tenant_id=source_identifiers.tenant_id AND source_identifiers.resource_type='microsoft.graph/copilotpackages'
            AND resource.native_id=source_identifiers.native_id AND identifier.kind=source_identifiers.identifier_kind AND identifier.value=source_identifiers.identifier_value))
      OR (source='power_platform' AND NOT EXISTS (
        SELECT 1 FROM power_platform_inventory_resources resource
        JOIN power_platform_inventory_snapshots snapshot ON snapshot.id=resource.snapshot_id AND snapshot.is_current AND snapshot.expires_at>clock_timestamp()
        CROSS JOIN LATERAL jsonb_to_recordset(resource.identifiers) AS identifier(kind text,value text)
        WHERE resource.tenant_id=source_identifiers.tenant_id AND resource.environment_id=source_identifiers.environment_id
          AND resource.resource_type=source_identifiers.resource_type AND resource.native_id=source_identifiers.native_id
          AND identifier.kind=source_identifiers.identifier_kind AND identifier.value=source_identifiers.identifier_value))`);
    if (options.dryRun) await client.query("ROLLBACK");
    else await client.query("COMMIT");
    return { dryRun: Boolean(options.dryRun), batchSize, affected };
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { /* preserve original failure */ }
    throw error;
  } finally {
    client.release();
  }
}

export async function retainUntilConverged(
  database: pg.Pool,
  options: { batchSize?: number; maximumPasses?: number } = {},
): Promise<RetentionCompletionResult> {
  const maximumPasses = options.maximumPasses ?? 1_000;
  if (!Number.isInteger(maximumPasses) || maximumPasses < 1 || maximumPasses > 1_000) {
    throw new Error("Retention convergence pass limit must be 1-1000.");
  }
  const affected: Record<string, number> = {};
  for (let passes = 1; passes <= maximumPasses; passes += 1) {
    const result = await retain(database, { batchSize: options.batchSize });
    for (const [name, count] of Object.entries(result.affected)) affected[name] = (affected[name] ?? 0) + count;
    if (Object.values(result.affected).every(count => count === 0)) return { passes, affected };
  }
  throw new Error("Retention cleanup did not converge within its bounded pass limit; keep the database in maintenance.");
}

async function main() {
  const database = new pg.Pool(databaseSettings());
  try {
    if (process.argv[2] === "retain") {
      if (process.argv[3] !== "confirmed") throw new Error("Retention requires an explicit confirmed target.");
      const batchSize = Number(process.argv[4] ?? 1_000);
      const result = await retain(database, { batchSize, dryRun: process.argv[5] === "dry-run" });
      console.log(JSON.stringify({ event: "retention_cleanup", outcome: "succeeded", ...result }));
    }
    else {
      await bootstrap(database, secretValue("APP_PGPASSWORD") ?? "");
      await migrate(database);
      await grantRuntime(database);
      await verifySchema(database);
    }
    if (process.argv[2] !== "retain") console.log(JSON.stringify({ event: "database_operator_command", outcome: "succeeded" }));
  } finally { await database.end(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { console.error(JSON.stringify({event:"database_operator_command",outcome:"failed"})); process.exitCode = 1; });
}