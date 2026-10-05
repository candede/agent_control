import { createHash, randomUUID } from "node:crypto";
import { chmodSync, createReadStream, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { verifyDataGenerationCharges } from "../src/db/dataGenerationAccountingSchema.js";
import { databaseSettings, secretValue, transaction } from "../src/db/pool.js";
import { schemaFingerprint, verifySchema } from "../src/db/schema.js";
import { verifyReportMembershipCounts } from "../src/db/reportMembershipCountsSchema.js";
import { grantRuntime, preflightSchema, retainUntilConverged } from "./database.js";
import { dataConnections } from "../src/db/dataConnections.js";
import { OfficialReportHistory } from "../src/db/officialReportHistory.js";
import { backupTableKeys, fingerprintAlgorithm } from "./backupInventory.js";
import { copyFingerprint } from "./backupFingerprintStream.js";
import { checkpointQueries } from "../src/services/peakMemory.js";

export async function validateBackupInventory(database: Pick<pg.Pool, "query">) {
  const tables = Object.keys(backupTableKeys).sort();
  const actual = (await database.query(`SELECT c.relname AS name,
    coalesce((SELECT json_agg(a.attname ORDER BY k.ordinality) FROM pg_index i
      CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY k(attnum,ordinality)
      JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.attnum
      WHERE i.indrelid=c.oid AND i.indisprimary),'[]'::json) AS keys
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind IN ('r','p') ORDER BY c.relname LIMIT $1`, [tables.length + 1])).rows;
  if (actual.length !== tables.length || actual.some((row, i) =>
    row.name !== tables[i] || JSON.stringify(row.keys) !== JSON.stringify(backupTableKeys[row.name]))) {
    throw new Error("Backup schema inventory mismatch; review the explicit table/primary-key contract.");
  }
  return tables;
}

async function checksum(filename: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest("hex");
}

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

export async function fingerprints(database: Pick<pg.Pool,"query">, selectedTables?: string[]): Promise<Record<string, { count: number; hash: string }>> {
  if ("totalCount" in database && "idleCount" in database) {
    return dataConnections(database as pg.Pool).selectedRead(client => fingerprints(client, selectedTables));
  }
  if ((await database.query("SHOW transaction_isolation")).rows[0].transaction_isolation !== "repeatable read") {
    throw new Error("Backup fingerprints require one repeatable-read snapshot.");
  }
  const result: Record<string,{ count: number; hash: string }> = {};
  const tables = selectedTables ? [...selectedTables].sort() : await validateBackupInventory(database);
  if (new Set(tables).size !== tables.length || tables.some(table => !Object.hasOwn(backupTableKeys, table))) throw new Error("Backup table inventory is invalid.");
  for (const table of tables) {
    const hash = createHash("sha256"), keys = backupTableKeys[table].map(key => `"${key}"`);
    let count = 0;
    let after = "", afterValues: unknown[] = [];
    for (;;) {
      const parameterBoundary = afterValues.length ? `WHERE (${keys.join(",")})>(${keys.map((_key, index) => `$${index+1}`).join(",")})` : "";
      const tail = (await database.query(`SELECT ${keys.join(",")} FROM ${table} ${parameterBoundary}
        ORDER BY ${keys.join(",")} OFFSET 249 LIMIT 1`, afterValues)).rows[0];
      const copied = await copyFingerprint(database, `COPY (
        SELECT chunks.first,chunks.chunk FROM (
          SELECT convert_to(row_to_json(record)::text,'UTF8') AS body FROM ${table} AS record ${after}
          ORDER BY ${keys.join(",")} LIMIT 250 OFFSET 0
        ) ordered CROSS JOIN LATERAL (
          SELECT chunk_offset=0 AS first,substring(body FROM chunk_offset+1 FOR 32768) AS chunk
          FROM generate_series(0,octet_length(body)-1,32768) chunk_offset ORDER BY chunk_offset OFFSET 0
        ) chunks) TO STDOUT (FORMAT BINARY)`, hash, count > 0);
      count += copied;
      if (!Number.isSafeInteger(count)) throw new Error("Backup fingerprint count overflow.");
      if (!tail || copied < 250) break;
      const literals = backupTableKeys[table].map(key => {
        const value = tail[key];
        if (value === null || value === undefined) throw new Error("Backup fingerprint primary key is missing.");
        return pg.escapeLiteral(value instanceof Date ? value.toISOString() : Buffer.isBuffer(value) ? `\\x${value.toString("hex")}` : String(value));
      });
      afterValues = backupTableKeys[table].map(key => tail[key]);
      after = `WHERE (${keys.join(",")})>(${literals.join(",")})`;
    }
    result[table] = { count, hash: hash.digest("hex") };
  }
  return result;
}
async function command(name: string, args: string[], database: string) {
  const settings = databaseSettings();
  await new Promise<void>((resolve, reject) => {
    const started = performance.now();
    const child = spawn(name,args,{ env:{...process.env,NPM_CONFIG_REGISTRY:"https://packagefeedproxy.microsoft.io/npm/",
      PGHOST:settings.host,PGPORT:String(settings.port),PGUSER:settings.user,PGDATABASE:database,PGPASSWORD:secretValue("PGPASSWORD")},
      stdio:["ignore","pipe","pipe"],timeout:120000 });
    let outputBytes = 0;
    for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk: Buffer) => {
      outputBytes = Math.min(Number.MAX_SAFE_INTEGER, outputBytes + chunk.length);
    });
    child.once("error", () => reject(new Error(`${name} failed to start; source unchanged.`)));
    child.once("close", (code, signal) => code === 0 ? resolve()
      : reject(new Error(`${name} failed (exit=${code},signal=${signal},killed=${child.killed},elapsedMs=${Math.round(performance.now()-started)},timeoutMs=120000,outputBytes=${outputBytes}); source unchanged.`)));
  });
}

export async function backup(database: pg.Pool, filename: string) {
  if (existsSync(filename) || existsSync(`${filename}.json`)) throw new Error("Backup target already exists; choose a new filename.");
  await verifySchema(database);
  const client = await database.connect();
  try {
    checkpointQueries(client);
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const snapshot = await client.query("SELECT pg_export_snapshot() AS snapshot,transaction_timestamp() AS snapshot_at");
    await verifyReportMembershipCounts(client);
    const counts = await fingerprints(client);
    await command("pg_dump",["--format=custom","--no-owner","--no-privileges",`--snapshot=${snapshot.rows[0].snapshot}`,"--file",filename],String(database.options.database));
    chmodSync(filename,0o600);
    writeFileSync(`${filename}.json`,JSON.stringify({format:"agent-control-backup-v1",fingerprintAlgorithm,sha256:await checksum(filename),schemaFingerprint,tables:counts,
      snapshotAt:new Date(snapshot.rows[0].snapshot_at).toISOString(),createdAt:new Date().toISOString()}),{flag:"wx",mode:0o600});
    await client.query("COMMIT");
    return counts;
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}

export async function restore(operator: pg.Pool, filename: string, target: string) {
  if (!/^agentcontrol_restore_[a-z0-9_]{1,40}$/.test(target) || target === operator.options.database) throw new Error("Restore requires a new isolated agentcontrol_restore_* database.");
  if (statSync(`${filename}.json`).size > 1_048_576) throw new Error("Backup receipt exceeds its bound.");
  const receipt = JSON.parse(readFileSync(`${filename}.json`,"utf8"));
  const restoredFromAt = new Date(receipt.snapshotAt);
  if (receipt.format !== "agent-control-backup-v1" || receipt.schemaFingerprint !== schemaFingerprint || receipt.fingerprintAlgorithm !== fingerprintAlgorithm
    || receipt.sha256 !== await checksum(filename)
    || !receipt.tables || typeof receipt.tables !== "object" || !Number.isFinite(Date.parse(receipt.createdAt))
    || !Number.isFinite(restoredFromAt.getTime()) || restoredFromAt.getTime() > Date.parse(receipt.createdAt)) {
    throw new Error("Backup receipt/checksum mismatch.");
  }
  if (JSON.stringify(Object.keys(receipt.tables).sort()) !== JSON.stringify(Object.keys(backupTableKeys).sort())) {
    throw new Error("Backup schema inventory mismatch.");
  }
  await operator.query(`CREATE DATABASE "${target}"`);
  const database = new pg.Pool({...databaseSettings(),database:target});
  try {
    await command("pg_restore",["--no-owner","--no-privileges","--exit-on-error","--single-transaction","--dbname",target,filename],target);
    if ((await preflightSchema(database)).state !== "current") throw new Error("Backup does not contain the current schema.");
    await validateBackupInventory(database);
    const actual = await fingerprints(database, Object.keys(receipt.tables));
    if (JSON.stringify(actual) !== JSON.stringify(receipt.tables)) throw new Error("Restore count/content mismatch; keep target isolated.");
    await verifyReportMembershipCounts(database);
    // pg_restore omits ACLs. Retention checks the protected count's read grant;
    // all mutable runtime authority still follows the restored-authority review.
    await database.query("REVOKE ALL ON FUNCTION inventory_interval_insert_guard() FROM PUBLIC");
    await database.query("REVOKE ALL ON FUNCTION inventory_prepared_member_guard() FROM PUBLIC");
    await database.query("REVOKE ALL ON FUNCTION data_update_generation_charge() FROM PUBLIC");
    await database.query("REVOKE ALL ON FUNCTION directory_service_plan_rows_insert_guard(),inventory_facts_insert_guard() FROM PUBLIC");
    await database.query("REVOKE ALL ON FUNCTION official_usage_membership_count() FROM PUBLIC");
    await database.query("GRANT SELECT ON app_schema,official_usage_membership_counts TO agentcontrol_app");
    await prepareRestoredDatabase(operator, database, restoredFromAt);
    await grantRuntime(database);
    await verifySchema(database);
    await verifyDataGenerationCharges(database);
    await verifyReportMembershipCounts(database);
    return actual;
  } finally { await database.end(); }
}

export async function prepareRestoredDatabase(current: pg.Pool, restored: pg.Pool, restoredFromAt: Date) {
  if (!Number.isFinite(restoredFromAt.getTime()) || restoredFromAt.getTime() > Date.now() + 300_000) throw new Error("Backup creation time is invalid.");
  assertDistinctDatabaseTargets(current, restored);
  await withCurrentReview(current, async review => transaction(restored, async client => {
    await invalidateRestoredAuthority(client);
    await reconcileCurrentCaches(review, client, new OfficialReportHistory(restored));
    await client.query(`UPDATE operational_state SET mode='maintenance',provider_work_enabled=false,restored_from_at=$1,
      deletion_reviewed_at=clock_timestamp(),access_reviewed_at=clock_timestamp(),updated_at=clock_timestamp() WHERE singleton=true`, [restoredFromAt]);
  }));
  await retainUntilConverged(restored, { batchSize: 250 });
}

async function invalidateRestoredAuthority(restored: pg.PoolClient) {
  await mutateReviewRows(restored, "sessions");
  await mutateReviewRows(restored, "data_principal_epochs", "true", "epoch=epoch+1");
  await mutateReviewRows(restored, "data_scope_epochs", "record.scope_kind='principal'",
    `epoch=epoch+1,session_epoch=(SELECT epoch FROM data_principal_epochs principal
      WHERE principal.tenant_id=record.tenant_id AND principal.principal_id=record.principal_id)`);
  await mutateReviewRows(restored, "data_read_selections", "invalidated_at IS NULL", "invalidated_at=clock_timestamp()");
  await mutateReviewRows(restored, "data_generations", "state IN ('staging','validating')",
    "state='cancelled',cancellation=cancellation+1,reserved_bytes=byte_count");
  await mutateReviewRows(restored, "data_generations", "state='published' AND scope_id IN (SELECT id FROM data_scope_epochs WHERE scope_kind='principal')", "state='retired'");
  await mutateReviewRows(restored, "data_generation_heads", "scope_id IN (SELECT id FROM data_scope_epochs WHERE scope_kind='principal')");
  await mutateReviewRows(restored, "official_usage_ingestions", "state IN ('streaming','validating','ready','accepting')", "state='cancelled'");
  await mutateReviewRows(restored, "capability_evidence");
  await mutateReviewRows(restored, "package_mutation_qualifications");
  await mutateReviewRows(restored, "purview_audit_jobs", "qualification_id IS NOT NULL", "qualification_id=NULL");
  await mutateReviewRows(restored, "purview_audit_qualifications");
  await mutateReviewRows(restored, "defender_hunting_qualification_evidence");
  await mutateReviewRows(restored, "copilot_quarantine_canary_approvals");
  await mutateReviewRows(restored, "copilot_quarantine_qualifications");
  await mutateReviewRows(restored, "official_usage_staged_rows");
  await mutateReviewRows(restored, "official_usage_confirmations");
  await mutateReviewRows(restored, "official_usage_bundle_receipts");
  await mutateReviewRows(restored, "official_usage_staging", "status NOT IN ('accepted','expired')", "status='expired'");
  await mutateReviewRows(restored, "job_items", "status='running'",
    "status=CASE WHEN sent_at IS NULL THEN 'queued' ELSE 'inconclusive' END,error_code=CASE WHEN sent_at IS NULL THEN NULL ELSE 'restored_uncertain_write' END");
  await mutateReviewRows(restored, "jobs", "status IN ('queued','running','waiting_authorization')",
    `status=CASE WHEN EXISTS(SELECT 1 FROM job_items item WHERE item.job_id=record.id AND item.status='inconclusive') THEN 'partial' ELSE 'waiting_authorization' END,
      lease_owner=NULL,lease_until=NULL,updated_at=clock_timestamp()`);
  await mutateReviewRows(restored, "power_platform_refresh_jobs", "status='running'", "status='waiting_authorization',finished_at=NULL,updated_at=clock_timestamp()");
  await mutateReviewRows(restored, "package_refresh_jobs", "status='running'", "status='waiting_authorization',finished_at=NULL,updated_at=clock_timestamp()");
  await mutateReviewRows(restored, "data_sync_run_sources", `source_id<>'usage_reports' AND status IN ('queued','running') AND EXISTS(
    SELECT 1 FROM data_sync_runs run WHERE record.run_id=run.id AND record.tenant_id=run.tenant_id
      AND record.principal_id=run.principal_id AND run.status IN ('running','waiting'))`,
    "status='waiting_authorization',message='Restore requires explicit resume with current authorization.',can_retry=true,updated_at=clock_timestamp()");
  await mutateReviewRows(restored, "data_sync_runs", "status IN ('running','waiting')", "status='waiting',completed_at=NULL,updated_at=clock_timestamp()");
  await mutateReviewRows(restored, "purview_audit_jobs", "status IN ('running','reconciling_create')",
    `status=CASE WHEN attempted_at IS NULL THEN 'waiting_authorization' ELSE 'inconclusive' END,
      execution_owner=NULL,updated_at=clock_timestamp(),remote_work_may_continue=(attempted_at IS NOT NULL)`);
  await mutateReviewRows(restored, "defender_hunting_jobs", "status='running'", "status='waiting_authorization',execution_owner=NULL,updated_at=clock_timestamp()");
  await mutateReviewRows(restored, "copilot_quarantine_job_items", "status='running'",
    "status=CASE WHEN sent_at IS NULL THEN 'queued' ELSE 'inconclusive' END,reconciliation_status=CASE WHEN sent_at IS NULL THEN 'not_required' ELSE 'required' END,error_code=CASE WHEN sent_at IS NULL THEN NULL ELSE 'restored_uncertain_write' END");
  await mutateReviewRows(restored, "copilot_quarantine_jobs", "status IN ('queued','running','waiting_authorization')",
    `status=CASE WHEN EXISTS(SELECT 1 FROM copilot_quarantine_job_items item WHERE item.job_id=record.id AND item.status='inconclusive') THEN 'inconclusive' ELSE 'waiting_authorization' END,
      lease_owner=NULL,lease_until=NULL,updated_at=clock_timestamp()`);
}

async function mutateReviewRows(database: pg.PoolClient, table: string, predicate = "true", assignments?: string) {
  const cursor = `restore_mutation_${randomUUID().replaceAll("-", "")}`;
  await database.query("SET LOCAL statement_timeout='5s'");
  await database.query(`DECLARE ${cursor} NO SCROLL CURSOR FOR
    SELECT ctid::text AS row_id,octet_length(row_to_json(record)::text) AS bytes FROM ${table} AS record WHERE ${predicate}`);
  for (;;) {
    const rows = (await database.query<{ row_id: string; bytes: number }>(`FETCH FORWARD 250 FROM ${cursor}`)).rows;
    if (!rows.length) break;
    const operation = assignments ? `UPDATE ${table} AS record SET ${assignments}` : `DELETE FROM ${table} AS record`;
    let batch: string[] = [], bytes = 0;
    const flush = async () => {
      if (!batch.length) return;
      await database.query(`${operation} WHERE record.ctid=ANY($1::tid[])`, [batch]);
      batch = []; bytes = 0;
      await new Promise<void>(resolve => setImmediate(resolve));
    };
    for (const row of rows) {
      if (row.bytes > 1_048_576) throw new Error("Restore review row exceeds its byte bound.");
      if (bytes + row.bytes > 1_048_576) await flush();
      batch.push(row.row_id); bytes += row.bytes;
    }
    await flush();
  }
  await database.query(`CLOSE ${cursor}`);
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

async function reconcileCurrentCaches(current: pg.PoolClient, restored: pg.PoolClient, history: OfficialReportHistory) {
  const currentIdentity = await current.query<{ database: string }>("SELECT current_database() AS database");
  const restoredIdentity = await restored.query<{ database: string }>("SELECT current_database() AS database");
  if (!currentIdentity.rows[0]?.database || !restoredIdentity.rows[0]?.database) {
    throw new Error("Restore reopening requires available current and restored database identities.");
  }
  await purgeMismatched(restored, "package_inventory_snapshots", await exactCurrentIds(current, restored, `
    SELECT snapshot.id,md5(jsonb_build_array(snapshot.id,snapshot.tenant_id,snapshot.principal_id,snapshot.token_mode,
      snapshot.query_hash,snapshot.scope_kind,snapshot.requested_ids)::text) AS signature
    FROM package_inventory_snapshots snapshot WHERE snapshot.expires_at>clock_timestamp()`));
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
  await mutateReviewRows(restored, "defender_hunting_retained_scopes",
    `revoked_at IS NULL AND id NOT IN (${safeRetainedScopes})`,
    "revoked_at=COALESCE(revoked_at,clock_timestamp()),revoked_by=COALESCE(revoked_by,'restore-review')");
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
      report_set.bundle_id,report_set.content_hash,report_set.reporting_start,report_set.reporting_end,
      report_set.period_provenance,report_set.supersedes_set_id,report_set.complete,report_set.accepted_at,
      EXISTS (SELECT 1 FROM official_usage_sets replacement
        WHERE replacement.tenant_id=report_set.tenant_id AND replacement.supersedes_set_id=report_set.id
          AND replacement.complete AND replacement.accepted_at IS NOT NULL),
      (SELECT jsonb_agg(jsonb_build_array(membership.kind,membership.version_id) ORDER BY membership.kind)
       FROM official_usage_set_versions membership WHERE membership.set_id=report_set.id))::text) AS signature
    FROM official_usage_sets report_set WHERE report_set.complete AND report_set.deleted_at IS NULL`);
  await mutateReviewRows(restored, "official_usage_sets", `deleted_at IS NULL AND id NOT IN (${safeSets})`, "deleted_at=clock_timestamp()");
  await mutateReviewRows(restored, "official_usage_set_versions", `set_id NOT IN (${safeSets})`);
  const safeVersions = await exactCurrentIds(current, restored, `
    SELECT version.id,md5(jsonb_build_array(version.id,version.tenant_id,version.accepted_by,version.kind,version.artifact_id,
      version.staging_id,version.content_hash,version.reporting_start,version.reporting_end,version.period_provenance,
      version.source_as_of,version.source_as_of_provenance,version.source_freshness,version.downloaded_at,
      version.warnings,version.reconciliation,version.supersedes_version_id,version.accepted_at,version.row_count)::text) AS signature
    FROM official_usage_versions version
    WHERE version.deleted_at IS NULL AND EXISTS (
      SELECT 1 FROM official_usage_set_versions membership
      JOIN official_usage_sets report_set ON report_set.id=membership.set_id AND report_set.deleted_at IS NULL
      WHERE membership.version_id=version.id AND membership.tenant_id=version.tenant_id)`, true);
  await mutateReviewRows(restored, "official_usage_versions",
    `deleted_at IS NULL AND (id NOT IN (${safeVersions}) OR NOT EXISTS (
      SELECT 1 FROM official_usage_set_versions membership WHERE membership.version_id=record.id
        AND membership.set_id IN (${safeSets})))`, "deleted_at=clock_timestamp()");
  await mutateReviewRows(restored, "official_usage_version_rows", `EXISTS(
    SELECT 1 FROM official_usage_versions version WHERE version.id=record.version_id AND version.deleted_at IS NOT NULL)`);
  await mutateReviewRows(restored, "official_usage_sets", `deleted_at IS NULL AND complete AND (
      (SELECT count(*) FROM official_usage_set_versions membership WHERE membership.set_id=record.id)<>3
      OR EXISTS (
        SELECT 1 FROM official_usage_set_versions membership JOIN official_usage_versions version ON version.id=membership.version_id
        WHERE membership.set_id=record.id AND (version.deleted_at IS NOT NULL OR version.row_count<>(
          SELECT count(*) FROM official_usage_version_rows row WHERE row.version_id=version.id))))`, "deleted_at=clock_timestamp()");
  for (;;) {
    const invalid = (await restored.query<{ tenant_id: string; set_id: string }>(`SELECT membership.tenant_id,membership.set_id
      FROM official_usage_history_memberships membership JOIN official_usage_sets report_set ON report_set.id=membership.set_id
      WHERE membership.valid_to_revision IS NULL AND report_set.deleted_at IS NOT NULL
      ORDER BY membership.tenant_id,membership.set_id LIMIT 250`)).rows;
    if (!invalid.length) break;
    for (const row of invalid) await history.invalidate(restored, row.tenant_id, row.set_id, true);
  }
  await reconcileOfficialSelection(current, restored, safeSets);
}

async function exactCurrentIds(current: pg.PoolClient, restored: pg.PoolClient, query: string, reportRows = false) {
  const table = `restore_review_${randomUUID().replaceAll("-", "")}`;
  const capturedAt = (await current.query<{ now: Date }>("SELECT transaction_timestamp() AS now")).rows[0].now;
  await restored.query(`CREATE TEMPORARY TABLE ${table}(id uuid PRIMARY KEY,signature text NOT NULL,verified boolean NOT NULL DEFAULT false) ON COMMIT DROP`);
  for await (const rows of boundedReviewRows(current, query, capturedAt, reportRows)) {
    await restored.query(`INSERT INTO ${table}(id,signature) SELECT id,signature FROM jsonb_to_recordset($1::jsonb) AS review(id uuid,signature text)`,
      [JSON.stringify(rows)]);
  }
  for await (const rows of boundedReviewRows(restored, query, capturedAt, reportRows)) {
    await restored.query(`UPDATE ${table} expected SET verified=true
      FROM jsonb_to_recordset($1::jsonb) AS review(id uuid,signature text)
      WHERE expected.id=review.id AND expected.signature=review.signature`, [JSON.stringify(rows)]);
  }
  return `SELECT id FROM ${table} WHERE verified`;
}

async function* boundedReviewRows(database: pg.PoolClient, query: string, capturedAt: Date, reportRows: boolean) {
  let after: string | null = null, count = 0;
  for (;;) {
    const rows: { id: string; signature: string }[] = (await database.query(`SELECT id,signature
      FROM (${query.replaceAll("clock_timestamp()", "$2::timestamptz")}) reviewed
      WHERE ($1::uuid IS NULL OR id>$1::uuid) AND $2::timestamptz IS NOT NULL ORDER BY id LIMIT 250`, [after, capturedAt])).rows;
    if (!rows.length) return;
    count += rows.length;
    if (count > 100_000) throw new Error("Current deletion/access review exceeds its safe bound.");
    if (reportRows) for (const row of rows) row.signature += await reportVersionRowsHash(database, row.id);
    yield rows;
    after = rows.at(-1)!.id;
  }
}

async function reportVersionRowsHash(database: pg.PoolClient, id: string) {
  const hash = createHash("sha256");
  let after = -1, count = 0;
  for (;;) {
    const rows = (await database.query<{ ordinal: number; body: string }>(`SELECT ordinal,jsonb_build_array(ordinal,payload_hash)::text AS body
      FROM official_usage_version_rows WHERE version_id=$1 AND ordinal>$2 ORDER BY ordinal LIMIT 250`, [id, after])).rows;
    if (!rows.length) return `${count}:${hash.digest("hex")}`;
    for (const row of rows) {
      if (count++) hash.update("\n");
      hash.update(row.body);
    }
    after = rows.at(-1)!.ordinal;
  }
}

async function purgeMismatched(restored: pg.PoolClient, table: string, safeIds: string) {
  let predicate = `record.id NOT IN (${safeIds})`;
  if (table === "package_inventory_snapshots") {
    predicate += " AND NOT EXISTS(SELECT 1 FROM inventory_control_pending p WHERE p.observation_id=record.id)";
    await mutateReviewRows(restored, "package_inventory_resources", `snapshot_id IN (
      SELECT record.id FROM package_inventory_snapshots record WHERE ${predicate})`);
  } else if (table === "purview_audit_jobs") {
    await mutateReviewRows(restored, "purview_audit_records", `job_id NOT IN (${safeIds})`);
  } else if (table === "defender_hunting_jobs") {
    await mutateReviewRows(restored, "defender_hunting_rows", `snapshot_id IN (
      SELECT id FROM defender_hunting_snapshots WHERE job_id NOT IN (${safeIds}))`);
    await mutateReviewRows(restored, "defender_hunting_snapshots", `job_id NOT IN (${safeIds})`);
    await mutateReviewRows(restored, "defender_hunting_qualification_evidence", `qualified_job_id NOT IN (${safeIds})`);
  }
  await mutateReviewRows(restored, table, predicate);
}

async function reconcileOfficialSelection(current: pg.PoolClient, restored: pg.PoolClient, safeSets: string) {
  await mutateReviewRows(restored, "official_usage_state", "active_set_id IS NOT NULL",
    "active_set_id=NULL,revision=revision+1,updated_at=clock_timestamp()");
  let after: string | null = null, count = 0;
  for (;;) {
    const rows: { tenant_id: string; active_set_id: string | null }[] = (await current.query(
      `SELECT tenant_id,active_set_id FROM official_usage_state WHERE ($1::text IS NULL OR tenant_id>$1)
        ORDER BY tenant_id LIMIT 250`, [after])).rows;
    if (!rows.length) return;
    count += rows.length;
    if (count > 10_000) throw new Error("Current report selection review exceeds its safe bound.");
    await restored.query(`UPDATE official_usage_state state SET active_set_id=review.active_set_id,updated_at=clock_timestamp()
      FROM jsonb_to_recordset($1::jsonb) AS review(tenant_id text,active_set_id uuid)
      WHERE state.tenant_id=review.tenant_id AND review.active_set_id IN (${safeSets}) AND EXISTS(
        SELECT 1 FROM official_usage_sets report_set WHERE report_set.id=review.active_set_id
          AND report_set.tenant_id=review.tenant_id AND report_set.complete AND report_set.deleted_at IS NULL)`, [JSON.stringify(rows)]);
    after = rows.at(-1)!.tenant_id;
  }
}

export async function reopenPreparedRestoredDatabase(current: pg.Pool, restored: pg.Pool) {
  assertDistinctDatabaseTargets(current, restored);
  await verifySchema(restored);
  await retainUntilConverged(restored, { batchSize: 250 });
  await withCurrentReview(current, async review => transaction(restored, async client => {
      const state = await client.query("SELECT * FROM operational_state WHERE singleton=true FOR UPDATE");
      if (state.rows[0]?.mode !== "maintenance" || state.rows[0]?.provider_work_enabled !== false
        || !state.rows[0]?.deletion_reviewed_at || !state.rows[0]?.access_reviewed_at) throw new Error("Restore reopening review is incomplete.");
      await reconcileCurrentCaches(review, client, new OfficialReportHistory(restored));
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