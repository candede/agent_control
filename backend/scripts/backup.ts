import { createHash } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { databaseSettings, secretValue, transaction } from "../src/db/pool.js";
import { migrations, migrationChecksum, verifySchema } from "../src/db/schema.js";
import { grantRuntime, migrate, retainUntilConverged } from "./database.js";

const checksum = (filename: string) => createHash("sha256").update(readFileSync(filename)).digest("hex");

export function databaseTargetIdentity(database: Pick<pg.Pool, "options">) {
  const host = String(database.options.host ?? "").trim().toLowerCase().replace(/\.$/, "");
  const name = String(database.options.database ?? "").trim();
  if (!host || !name) throw new Error("Database target identity requires an exact server and database.");
  return { host, database: name };
}

export function assertDistinctDatabaseTargets(current: Pick<pg.Pool, "options">, restored: Pick<pg.Pool, "options">) {
  const currentIdentity = databaseTargetIdentity(current);
  const restoredIdentity = databaseTargetIdentity(restored);
  if (currentIdentity.host === restoredIdentity.host && currentIdentity.database === restoredIdentity.database) {
    throw new Error("Restore reopening requires an exact separate server/database target.");
  }
  return { current: currentIdentity, restored: restoredIdentity };
}

export async function fingerprints(database: Pick<pg.Pool,"query">, selectedTables?: string[]) {
  const result: Record<string,{ count: number; hash: string }> = {};
  const tables = selectedTables ?? (await database.query<{ table_name: string }>(`SELECT table_name FROM information_schema.tables
    WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name`)).rows.map(row => row.table_name);
  if (tables.length > 100 || tables.some(table => !/^[a-z][a-z0-9_]{0,62}$/.test(table))) throw new Error("Backup table inventory is invalid.");
  for (const table of tables) {
    const rows = await database.query(`SELECT count(*)::int AS count,md5(coalesce(string_agg(row_to_json(record)::text,E'\n' ORDER BY row_to_json(record)::text COLLATE "C"),'')) AS hash FROM ${table} AS record`);
    result[table] = rows.rows[0];
  }
  return result;
}
function command(name: string, args: string[], database: string) {
  const settings = databaseSettings();
  const result = spawnSync(name,args,{ env:{...process.env,PGHOST:settings.host,PGPORT:String(settings.port),PGUSER:settings.user,PGDATABASE:database,PGPASSWORD:secretValue("PGPASSWORD")}, stdio:["ignore","pipe","pipe"],timeout:120000 });
  if (result.status !== 0) throw new Error(`${name} failed; backup/restore stopped without altering the source database.`);
}

export async function backup(database: pg.Pool, filename: string) {
  if (existsSync(filename) || existsSync(`${filename}.json`)) throw new Error("Backup target already exists; choose a new filename.");
  await verifySchema(database);
  const client = await database.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const snapshot = await client.query("SELECT pg_export_snapshot() AS snapshot,transaction_timestamp() AS snapshot_at");
    const counts = await fingerprints(client);
    command("pg_dump",["--format=custom","--no-owner","--no-privileges",`--snapshot=${snapshot.rows[0].snapshot}`,"--file",filename],String(database.options.database));
    chmodSync(filename,0o600);
    writeFileSync(`${filename}.json`,JSON.stringify({version:3,sha256:checksum(filename),schemaVersion:migrations.length,tables:counts,
      snapshotAt:new Date(snapshot.rows[0].snapshot_at).toISOString(),createdAt:new Date().toISOString()}),{flag:"wx",mode:0o600});
    await client.query("COMMIT");
    return counts;
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}

export async function restore(operator: pg.Pool, filename: string, target: string) {
  if (!/^agentcontrol_restore_[a-z0-9_]{1,40}$/.test(target) || target === operator.options.database) throw new Error("Restore requires a new isolated agentcontrol_restore_* database.");
  const receipt = JSON.parse(readFileSync(`${filename}.json`,"utf8"));
  const restoredFromAt = new Date(receipt.version === 3 ? receipt.snapshotAt : receipt.createdAt);
  if (![1,2,3].includes(receipt.version) || receipt.sha256 !== checksum(filename)
    || !receipt.tables || typeof receipt.tables !== "object" || !Number.isFinite(Date.parse(receipt.createdAt))
    || !Number.isFinite(restoredFromAt.getTime()) || restoredFromAt.getTime() > Date.parse(receipt.createdAt)) {
    throw new Error("Backup receipt/checksum mismatch.");
  }
  await operator.query(`CREATE DATABASE "${target}"`);
  const database = new pg.Pool({...databaseSettings(),database:target});
  try {
    command("pg_restore",["--no-owner","--no-privileges","--exit-on-error","--single-transaction","--dbname",target,filename],target);
    await verifyMigrationPrefix(database);
    const actual = await fingerprints(database, Object.keys(receipt.tables));
    if (JSON.stringify(actual) !== JSON.stringify(receipt.tables)) throw new Error("Restore count/content mismatch; keep target isolated.");
    await migrate(database);
    await verifySchema(database);
    await prepareRestoredDatabase(operator, database, restoredFromAt);
    await grantRuntime(database);
    return actual;
  } finally { await database.end(); }
}

async function verifyMigrationPrefix(database: Pick<pg.Pool, "query">) {
  const applied = await database.query<{ version: number; checksum: string }>("SELECT version,checksum FROM schema_migrations ORDER BY version");
  if (!applied.rowCount || applied.rows.some((row, index) => row.version !== migrations[index]?.version
    || row.checksum !== migrationChecksum(migrations[index].sql))) {
    throw new Error("Backup contains an unknown or modified schema.");
  }
}

export async function prepareRestoredDatabase(current: pg.Pool, restored: pg.Pool, restoredFromAt: Date) {
  if (!Number.isFinite(restoredFromAt.getTime()) || restoredFromAt.getTime() > Date.now() + 300_000) throw new Error("Backup creation time is invalid.");
  assertDistinctDatabaseTargets(current, restored);
  await withCurrentReview(current, async review => transaction(restored, async client => {
    await invalidateRestoredAuthority(client);
    await reconcileCurrentCaches(review, client);
    await client.query(`UPDATE operational_state SET mode='maintenance',provider_work_enabled=false,restored_from_at=$1,
      deletion_reviewed_at=clock_timestamp(),access_reviewed_at=clock_timestamp(),updated_at=clock_timestamp() WHERE singleton=true`, [restoredFromAt]);
  }));
  await retainUntilConverged(restored, { batchSize: 5_000 });
}

async function invalidateRestoredAuthority(restored: pg.PoolClient) {
  await restored.query("DELETE FROM sessions");
  await restored.query("DELETE FROM capability_evidence");
  await restored.query("DELETE FROM package_mutation_qualifications");
  await restored.query("UPDATE purview_audit_jobs SET qualification_id=NULL");
  await restored.query("DELETE FROM purview_audit_qualifications");
  await restored.query("DELETE FROM defender_hunting_qualification_evidence");
  await restored.query("DELETE FROM copilot_quarantine_canary_approvals");
  await restored.query("DELETE FROM copilot_quarantine_qualifications");
  await restored.query("DELETE FROM official_usage_staged_rows");
  await restored.query("DELETE FROM official_usage_confirmations");
  await restored.query("DELETE FROM official_usage_bundle_receipts");
  await restored.query("UPDATE official_usage_staging SET status='expired' WHERE status NOT IN ('accepted','expired')");
  await restored.query("UPDATE job_items SET status=CASE WHEN sent_at IS NULL THEN 'queued' ELSE 'inconclusive' END,error_code=CASE WHEN sent_at IS NULL THEN NULL ELSE 'restored_uncertain_write' END WHERE status='running'");
  await restored.query(`UPDATE jobs SET status=CASE WHEN EXISTS(SELECT 1 FROM job_items item WHERE item.job_id=jobs.id AND item.status='inconclusive') THEN 'partial' ELSE 'waiting_authorization' END,
    lease_owner=NULL,lease_until=NULL,updated_at=clock_timestamp() WHERE status IN ('queued','running','waiting_authorization')`);
  await restored.query("UPDATE power_platform_refresh_jobs SET status='waiting_authorization',finished_at=NULL,updated_at=clock_timestamp() WHERE status='running'");
  await restored.query("UPDATE package_refresh_jobs SET status='waiting_authorization',finished_at=NULL,updated_at=clock_timestamp() WHERE status='running'");
  await restored.query(`UPDATE purview_audit_jobs SET status=CASE WHEN attempted_at IS NULL THEN 'waiting_authorization' ELSE 'inconclusive' END,
    execution_owner=NULL,updated_at=clock_timestamp(),remote_work_may_continue=(attempted_at IS NOT NULL) WHERE status IN ('running','reconciling_create')`);
  await restored.query("UPDATE defender_hunting_jobs SET status='waiting_authorization',execution_owner=NULL,updated_at=clock_timestamp() WHERE status='running'");
  await restored.query("UPDATE copilot_quarantine_job_items SET status=CASE WHEN sent_at IS NULL THEN 'queued' ELSE 'inconclusive' END,reconciliation_status=CASE WHEN sent_at IS NULL THEN 'not_required' ELSE 'required' END,error_code=CASE WHEN sent_at IS NULL THEN NULL ELSE 'restored_uncertain_write' END WHERE status='running'");
  await restored.query(`UPDATE copilot_quarantine_jobs SET status=CASE WHEN EXISTS(SELECT 1 FROM copilot_quarantine_job_items item WHERE item.job_id=copilot_quarantine_jobs.id AND item.status='inconclusive') THEN 'inconclusive' ELSE 'waiting_authorization' END,
    lease_owner=NULL,lease_until=NULL,updated_at=clock_timestamp() WHERE status IN ('queued','running','waiting_authorization')`);
}

async function withCurrentReview<T>(current: pg.Pool, operation: (review: pg.PoolClient) => Promise<T>) {
  const review = await current.connect();
  try {
    await review.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const result = await operation(review);
    await review.query("COMMIT");
    return result;
  } catch (error) {
    try { await review.query("ROLLBACK"); } catch { /* preserve the review failure */ }
    throw error;
  } finally {
    review.release();
  }
}

async function reconcileCurrentCaches(current: pg.PoolClient, restored: pg.PoolClient) {
  const currentIdentity = await current.query<{ database: string }>("SELECT current_database() AS database");
  const restoredIdentity = await restored.query<{ database: string }>("SELECT current_database() AS database");
  if (!currentIdentity.rows[0]?.database || !restoredIdentity.rows[0]?.database) {
    throw new Error("Restore reopening requires available current and restored database identities.");
  }
  await purgeMismatched(restored, "package_inventory_snapshots", await exactCurrentIds(current, restored, `
    SELECT snapshot.id,md5(jsonb_build_array(snapshot.id,snapshot.tenant_id,snapshot.principal_id,snapshot.token_mode,
      snapshot.query_hash,snapshot.scope_kind,snapshot.requested_ids)::text) AS signature
    FROM package_inventory_snapshots snapshot WHERE snapshot.expires_at>clock_timestamp()`));
  await purgeMismatched(restored, "power_platform_inventory_snapshots", await exactCurrentIds(current, restored, `
    SELECT snapshot.id,md5(jsonb_build_array(snapshot.id,snapshot.tenant_id,snapshot.principal_id,snapshot.query_hash,
      snapshot.role_scope,snapshot.cloud,snapshot.environment_scope,snapshot.requested_types)::text) AS signature
    FROM power_platform_inventory_snapshots snapshot WHERE snapshot.expires_at>clock_timestamp()`));
  await purgeMismatched(restored, "purview_audit_jobs", await exactCurrentIds(current, restored, `
    SELECT job.id,md5(jsonb_build_array(job.id,job.tenant_id,job.authorization_principal_id,job.result_scope_id,
      job.result_scope_kind,job.result_scope_configuration_revision,job.token_mode)::text) AS signature
    FROM purview_audit_jobs job WHERE job.expires_at>clock_timestamp()`));
  await purgeMismatched(restored, "copilot_quarantine_status_observations", await exactCurrentIds(current, restored, `
    SELECT observation.id,md5(jsonb_build_array(observation.id,observation.tenant_id,observation.principal_id,
      observation.resource_native_id,observation.environment_id,observation.bot_id)::text) AS signature
    FROM copilot_quarantine_status_observations observation WHERE observation.expires_at>clock_timestamp()`));

  const safeRetainedScopes = await exactCurrentIds(current, restored, `
    SELECT retained.id,md5(jsonb_build_array(retained.id,retained.tenant_id,retained.authorization_principal_id,
      retained.result_scope_id,retained.result_scope_kind,retained.result_scope_configuration_revision,retained.token_mode,
      retained.capability_id,retained.template_id,retained.target_scope_hash,retained.approved_scope,retained.query_version,
      retained.contract_revision,retained.permission_revision,retained.configuration_revision,retained.source_qualification_job_id)::text) AS signature
    FROM defender_hunting_retained_scopes retained
    WHERE retained.revoked_at IS NULL AND retained.expires_at>clock_timestamp()`);
  await restored.query(`UPDATE defender_hunting_retained_scopes SET revoked_at=COALESCE(revoked_at,clock_timestamp()),
    revoked_by=COALESCE(revoked_by,'restore-review') WHERE revoked_at IS NULL AND NOT (id=ANY($1::uuid[]))`, [[...safeRetainedScopes]]);
  await purgeMismatched(restored, "defender_hunting_jobs", await exactCurrentIds(current, restored, `
    SELECT job.id,md5(jsonb_build_array(job.id,job.tenant_id,job.authorization_principal_id,job.result_scope_id,
      job.result_scope_kind,job.result_scope_configuration_revision,job.token_mode,job.retained_scope_id,
      retained.capability_id,retained.template_id,retained.target_scope_hash,retained.approved_scope,retained.contract_revision,
      retained.permission_revision,retained.configuration_revision)::text) AS signature
    FROM defender_hunting_jobs job
    JOIN defender_hunting_retained_scopes retained ON retained.id=job.retained_scope_id
      AND retained.revoked_at IS NULL AND retained.expires_at>clock_timestamp()
    WHERE NOT job.is_qualification AND job.expires_at>clock_timestamp()`));

  const safeSets = await exactCurrentIds(current, restored, `
    SELECT report_set.id,md5(jsonb_build_array(report_set.id,report_set.tenant_id,report_set.actor_principal_id,
      report_set.bundle_id,report_set.reporting_start,report_set.reporting_end,report_set.complete,
      (SELECT jsonb_agg(jsonb_build_array(membership.kind,membership.version_id) ORDER BY membership.kind)
       FROM official_usage_set_versions membership WHERE membership.set_id=report_set.id))::text) AS signature
    FROM official_usage_sets report_set WHERE report_set.deleted_at IS NULL AND report_set.expires_at>clock_timestamp()`);
  await restored.query("UPDATE official_usage_sets SET deleted_at=COALESCE(deleted_at,clock_timestamp()) WHERE deleted_at IS NULL AND NOT (id=ANY($1::uuid[]))", [[...safeSets]]);
  const safeVersions = await exactCurrentIds(current, restored, `
    SELECT version.id,md5(jsonb_build_array(version.id,version.tenant_id,version.accepted_by,version.kind,version.artifact_id,
      membership.set_id)::text) AS signature
    FROM official_usage_versions version
    JOIN official_usage_set_versions membership ON membership.version_id=version.id
    JOIN official_usage_sets report_set ON report_set.id=membership.set_id AND report_set.deleted_at IS NULL
      AND report_set.expires_at>clock_timestamp()
    WHERE version.deleted_at IS NULL AND version.expires_at>clock_timestamp()`);
  await restored.query(`UPDATE official_usage_versions version SET deleted_at=COALESCE(version.deleted_at,clock_timestamp())
    WHERE version.deleted_at IS NULL AND (NOT (version.id=ANY($1::uuid[])) OR EXISTS (
      SELECT 1 FROM official_usage_set_versions membership WHERE membership.version_id=version.id
        AND NOT (membership.set_id=ANY($2::uuid[]))))`, [[...safeVersions], [...safeSets]]);
  await restored.query("DELETE FROM official_usage_version_rows row USING official_usage_versions version WHERE version.id=row.version_id AND version.deleted_at IS NOT NULL");
  await reconcileOfficialSelection(current, restored, safeSets);
}

async function exactCurrentIds(current: pg.PoolClient, restored: pg.PoolClient, query: string) {
  const [currentRows, restoredRows] = await Promise.all([
    boundedReviewRows(current, query),
    boundedReviewRows(restored, query),
  ]);
  const expected = new Map(currentRows.map(row => [row.id, row.signature]));
  return new Set(restoredRows.filter(row => expected.get(row.id) === row.signature).map(row => row.id));
}

async function boundedReviewRows(database: pg.PoolClient, query: string) {
  const result = await database.query<{ id: string; signature: string }>(`SELECT id,signature FROM (${query}) reviewed ORDER BY id LIMIT 100001`);
  if (result.rowCount! > 100_000) throw new Error("Current deletion/access review exceeds its safe bound.");
  return result.rows;
}

async function purgeMismatched(restored: pg.PoolClient, table: string, safeIds: Set<string>) {
  await restored.query(`DELETE FROM ${table} WHERE NOT (id=ANY($1::uuid[]))`, [[...safeIds]]);
}

async function reconcileOfficialSelection(current: pg.PoolClient, restored: pg.PoolClient, safeSets: Set<string>) {
  const states = await current.query<{ tenant_id: string; active_set_id: string | null }>(
    "SELECT tenant_id,active_set_id FROM official_usage_state ORDER BY tenant_id LIMIT 10001");
  if (states.rowCount! > 10_000) throw new Error("Current report selection review exceeds its safe bound.");
  await restored.query("UPDATE official_usage_state SET active_set_id=NULL,revision=revision+1,updated_at=clock_timestamp() WHERE active_set_id IS NOT NULL");
  for (const row of states.rows) {
    if (row.active_set_id && safeSets.has(row.active_set_id)) {
      await restored.query(`UPDATE official_usage_state SET active_set_id=$2,updated_at=clock_timestamp()
        WHERE tenant_id=$1 AND EXISTS(SELECT 1 FROM official_usage_sets
          WHERE id=$2 AND tenant_id=$1 AND deleted_at IS NULL AND expires_at>clock_timestamp())`, [row.tenant_id, row.active_set_id]);
    }
  }
}

export async function reopenPreparedRestoredDatabase(current: pg.Pool, restored: pg.Pool) {
  assertDistinctDatabaseTargets(current, restored);
  await verifySchema(restored);
  await retainUntilConverged(restored, { batchSize: 5_000 });
  await withCurrentReview(current, async review => transaction(restored, async client => {
      const state = await client.query("SELECT * FROM operational_state WHERE singleton=true FOR UPDATE");
      if (state.rows[0]?.mode !== "maintenance" || state.rows[0]?.provider_work_enabled !== false
        || !state.rows[0]?.deletion_reviewed_at || !state.rows[0]?.access_reviewed_at) throw new Error("Restore reopening review is incomplete.");
      await reconcileCurrentCaches(review, client);
      const unsafe = await client.query(`SELECT
        (SELECT count(*) FROM sessions)
        +(SELECT count(*) FROM jobs WHERE lease_owner IS NOT NULL OR lease_until IS NOT NULL)
        +(SELECT count(*) FROM purview_audit_jobs WHERE execution_owner IS NOT NULL)
        +(SELECT count(*) FROM defender_hunting_jobs WHERE execution_owner IS NOT NULL)
        +(SELECT count(*) FROM copilot_quarantine_jobs WHERE lease_owner IS NOT NULL OR lease_until IS NOT NULL)
        +(SELECT count(*) FROM package_mutation_qualifications)
        +(SELECT count(*) FROM purview_audit_qualifications)
        +(SELECT count(*) FROM copilot_quarantine_canary_approvals)
        +(SELECT count(*) FROM copilot_quarantine_qualifications)
        +(SELECT count(*) FROM defender_hunting_qualification_evidence)
        +(SELECT count(*) FROM capability_evidence) AS count`);
      if (Number(unsafe.rows[0].count) !== 0) throw new Error("Restored sessions, ownership or provider authority remains.");
      await client.query(`UPDATE operational_state SET mode='normal',provider_work_enabled=false,
        deletion_reviewed_at=clock_timestamp(),access_reviewed_at=clock_timestamp(),updated_at=clock_timestamp() WHERE singleton=true`);
  }));
  return { mode: "normal", providerWorkEnabled: false };
}

export async function reopenRestoredDatabase(operator: pg.Pool, target: string) {
  if (!/^agentcontrol_restore_[a-z0-9_]{1,40}$/.test(target) || target === operator.options.database) throw new Error("Reopen requires an isolated agentcontrol_restore_* database.");
  const database = new pg.Pool({ ...databaseSettings(), database: target });
  try {
    return await reopenPreparedRestoredDatabase(operator, database);
  } finally { await database.end(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const database = new pg.Pool(databaseSettings());
  const execution = !["backup","restore","reopen"].includes(process.argv[2] ?? "") ? Promise.reject(new Error("Unknown recovery action."))
    : process.argv[2] === "backup" ? backup(database,process.argv[3])
    : process.argv[2] === "restore" ? restore(database,process.argv[3],process.argv[4])
    : reopenRestoredDatabase(database,process.argv[3]);
  execution.then(() => console.log(JSON.stringify({event:"database_recovery_check",outcome:"succeeded"})))
    .catch(() => { console.error(JSON.stringify({event:"database_recovery_check",outcome:"failed"})); process.exitCode=1; })
    .finally(() => database.end());
}