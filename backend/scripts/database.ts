import pg from "pg";
import { pathToFileURL } from "node:url";
import { databaseSettings, secretValue, transaction } from "../src/db/pool.js";
import { schemaFingerprint, schemaSql, verifySchema } from "../src/db/schema.js";
import { DatabaseResetError, preflightDatabaseReset, resetDatabase } from "./databaseReset.js";
import { OfficialReportHistory } from "../src/db/officialReportHistory.js";
import { retainRecordData } from "../src/db/dataRetention.js";
import { LifecycleSlice } from "../src/db/lifecycleSlice.js";
import { emptyReportStaging, orphanReportVersion } from "../src/db/officialReportRetention.js";

class DatabaseSchemaError extends Error {
  readonly code = "database_schema_reset_required";

  constructor() {
    super("The saved database does not match this build's current schema. Explicitly reset the owned development database before initialization. No data was converted or reset.");
  }
}

async function inspectSchema(database: Pick<pg.PoolClient, "query">) {
  const marker = await database.query<{ name: string | null }>("SELECT to_regclass('public.app_schema')::text AS name");
  if (!marker.rows[0]?.name) {
    const objects = await database.query<{ populated: boolean }>(`SELECT EXISTS (
      SELECT 1 FROM pg_class WHERE relnamespace='public'::regnamespace
      UNION ALL SELECT 1 FROM pg_proc WHERE pronamespace='public'::regnamespace
      UNION ALL SELECT 1 FROM pg_type WHERE typnamespace='public'::regnamespace
    ) AS populated`);
    if (objects.rows[0]?.populated !== false) throw new DatabaseSchemaError();
    return { state: "fresh" as const, currentFingerprint: null, targetFingerprint: schemaFingerprint };
  }
  const saved = await database.query<{ fingerprint: string }>("SELECT fingerprint FROM app_schema WHERE singleton=true");
  if (saved.rows.length !== 1 || saved.rows[0].fingerprint !== schemaFingerprint) throw new DatabaseSchemaError();
  return { state: "current" as const, currentFingerprint: schemaFingerprint, targetFingerprint: schemaFingerprint };
}

export async function preflightSchema(database: pg.Pool) {
  return transaction(database, async client => {
    await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
    return inspectSchema(client);
  });
}

export function databaseOperatorFailure(error: unknown) {
  if (error instanceof DatabaseResetError) {
    return { event: "database_operator_command", outcome: "failed", code: error.code, message: error.message, phase: error.phase };
  }
  return {
    event: "database_operator_command", outcome: "failed",
    ...(error instanceof DatabaseSchemaError
      ? { code: error.code, message: error.message }
      : { code: "database_operator_failed", message: "Database command failed. Check operator connectivity, secret files, runtime credentials and database permissions. No automatic reset was attempted." }),
  };
}

export async function initializeSchema(database: pg.Pool) {
  await transaction(database, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(3650101)");
    if ((await inspectSchema(client)).state === "fresh") {
      await client.query(schemaSql);
      await client.query("INSERT INTO app_schema(singleton,fingerprint) VALUES (true,$1)", [schemaFingerprint]);
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
    REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM agentcontrol_app;
    GRANT SELECT ON app_schema TO agentcontrol_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON sessions, jobs, job_items, job_attempts, source_identifiers, capability_configuration, capability_evidence TO agentcontrol_app;
    GRANT SELECT, INSERT, UPDATE ON power_platform_refresh_jobs TO agentcontrol_app;
    GRANT SELECT, INSERT, UPDATE ON package_refresh_jobs, package_inventory_snapshots TO agentcontrol_app;
    GRANT SELECT, INSERT ON package_inventory_resources TO agentcontrol_app;
    GRANT SELECT, INSERT, UPDATE ON package_mutation_qualifications TO agentcontrol_app;
    GRANT SELECT, INSERT ON audit_events TO agentcontrol_app;
    GRANT SELECT ON audit_projection TO agentcontrol_app;
    GRANT SELECT,INSERT,UPDATE ON data_principal_epochs,data_scope_epochs TO agentcontrol_app;
    GRANT SELECT,INSERT,UPDATE,DELETE ON data_generations,data_generation_heads,
      data_read_selections,data_exports TO agentcontrol_app;
    GRANT SELECT,INSERT,DELETE ON directory_user_rows,directory_service_plan_rows,app_activity_rows,
      data_generation_batches,data_generation_pages,data_generation_pins,data_export_chunks,data_export_items TO agentcontrol_app;
    GRANT SELECT ON data_generation_charges,official_usage_membership_counts TO agentcontrol_app;
    GRANT SELECT,INSERT,UPDATE,DELETE ON user_source_attempts,user_source_queries,user_source_identity_inputs TO agentcontrol_app;
    GRANT SELECT,INSERT,DELETE ON user_source_query_members,user_source_skus,user_source_read_contexts TO agentcontrol_app;
    GRANT SELECT,INSERT,UPDATE ON official_usage_history_state TO agentcontrol_app;
    GRANT SELECT,INSERT,UPDATE,DELETE ON official_usage_history_memberships,official_usage_ingestions TO agentcontrol_app;
    GRANT SELECT,INSERT,DELETE ON official_usage_ingestion_rows,official_usage_read_contexts TO agentcontrol_app;
    GRANT SELECT ON inventory_records,inventory_live_sources,inventory_people_revisions TO agentcontrol_app;
    GRANT EXECUTE ON FUNCTION inventory_association_revision(text) TO agentcontrol_app;
    GRANT SELECT,INSERT,DELETE ON package_record_rows,power_platform_record_rows,unified_agent_rows,
      inventory_keys,inventory_facts,unified_agent_memberships,inventory_changes,inventory_read_contexts,inventory_revisions,
      inventory_compaction_refs,inventory_canonical_ids TO agentcontrol_app;
    GRANT SELECT,INSERT,UPDATE,DELETE ON inventory_attempts,inventory_roots,inventory_memberships,inventory_pages,
      inventory_worker_pins,inventory_reconciliation,inventory_reconciliation_keys,inventory_frontier,inventory_candidate_edges,inventory_exact_heads,
      inventory_refresh_targets,inventory_mutation_stages,inventory_mutation_targets TO agentcontrol_app;
    GRANT SELECT,DELETE ON inventory_control_pending,inventory_native_control_pending TO agentcontrol_app;
    GRANT SELECT ON operational_state TO agentcontrol_app;
    GRANT SELECT,UPDATE ON data_lifecycle_progress TO agentcontrol_app;
    GRANT SELECT,INSERT,UPDATE ON inventory_collection_progress TO agentcontrol_app;
    GRANT SELECT,INSERT,UPDATE ON data_sync_runs,data_sync_run_sources,data_sync_success_markers TO agentcontrol_app;
    GRANT SELECT,INSERT ON data_sync_source_jobs TO agentcontrol_app;
    GRANT SELECT,INSERT,UPDATE ON agent_people_cache TO agentcontrol_app;
    GRANT SELECT,INSERT,UPDATE,DELETE ON agent_identity_cache TO agentcontrol_app;
    GRANT SELECT,INSERT,UPDATE ON purview_audit_qualifications TO agentcontrol_app;
    GRANT SELECT,INSERT,UPDATE,DELETE ON purview_audit_jobs TO agentcontrol_app;
    GRANT SELECT,INSERT ON purview_audit_records TO agentcontrol_app;
    GRANT SELECT,INSERT,UPDATE,DELETE ON defender_hunting_jobs TO agentcontrol_app;
    GRANT SELECT,INSERT ON defender_hunting_snapshots,defender_hunting_rows,defender_hunting_qualification_evidence TO agentcontrol_app;
    GRANT SELECT,INSERT,UPDATE ON defender_hunting_retained_scopes TO agentcontrol_app;
    GRANT SELECT,INSERT ON copilot_quarantine_status_observations,copilot_quarantine_audit,copilot_quarantine_qualifications TO agentcontrol_app;
    GRANT SELECT,INSERT,UPDATE ON copilot_quarantine_jobs,copilot_quarantine_job_items,copilot_quarantine_attempts,copilot_quarantine_canary_approvals TO agentcontrol_app;
    GRANT SELECT,INSERT,UPDATE,DELETE ON official_usage_staging,official_usage_staged_rows,official_usage_confirmations TO agentcontrol_app;
    GRANT SELECT,INSERT,UPDATE ON official_usage_artifacts,official_usage_sets,official_usage_versions,official_usage_state TO agentcontrol_app;
    GRANT SELECT,INSERT,DELETE ON official_usage_version_rows,official_usage_set_versions TO agentcontrol_app;
    GRANT SELECT,INSERT ON official_usage_bundle_receipts,official_usage_audit,official_usage_row_facts TO agentcontrol_app;
    GRANT EXECUTE ON FUNCTION official_usage_payload_hash(jsonb) TO agentcontrol_app;
    GRANT SELECT,INSERT,DELETE ON agent_usage_associations TO agentcontrol_app;
    GRANT SELECT ON agent_usage_state TO agentcontrol_app;
  `);
}

export type RetentionResult = { dryRun: boolean; batchSize: number; affected: Record<string, number>; pending: boolean };
export type RetentionCompletionResult = { passes: number; affected: Record<string, number> };

export async function retainOfficialReportReceipts(database: Pick<pg.Pool, "query">, limit: number) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 250) throw new Error("official_receipt_retention_batch");
  return (await database.query(`WITH candidates AS MATERIALIZED (
    SELECT ctid FROM official_usage_bundle_receipts WHERE expires_at<clock_timestamp() LIMIT $1 FOR UPDATE SKIP LOCKED
  ) DELETE FROM official_usage_bundle_receipts target USING candidates WHERE target.ctid=candidates.ctid`, [limit])).rowCount ?? 0;
}

export function retain(database: pg.Pool, options: { batchSize?: number; dryRun?: boolean } = {}): Promise<RetentionResult> {
  return retainSlice(database,options);
}

async function retainSlice(database: pg.Pool, options: { batchSize?: number; dryRun?: boolean },
  verifiedClient?: pg.PoolClient): Promise<RetentionResult> {
  const batchSize = options.batchSize ?? 1_000;
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 5_000) throw new Error("Retention batch size must be 1-5000.");
  if (!verifiedClient) await verifySchema(database);
  const client = verifiedClient ?? await database.connect();
  const affected: Record<string, number> = {};
  const slice = new LifecycleSlice(client, Math.min(batchSize, 250), "operator");
  const remove = async (name: string, table: string, where: string) => {
    affected[name] = await slice.change(name, table, where.replaceAll(`${table}.`, "target."));
  };
  const update = async (name: string, table: string, where: string, changes: string) => {
    affected[name] = await slice.change(name, table, where.replaceAll(`${table}.`, "target."), changes);
  };
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='15s'");
    if (!(await client.query("SELECT pg_try_advisory_xact_lock(3650111) AS acquired")).rows[0].acquired) {
      throw new Error("Another retention cleanup owns the database lock.");
    }
    await slice.open();
    Object.assign(affected, await retainRecordData(client, Math.min(batchSize, 250), slice));
    await remove("sessions", "sessions", "expire<clock_timestamp()");
    const expiredJob = "EXISTS(SELECT 1 FROM jobs j WHERE j.id=target.job_id AND j.expires_at<clock_timestamp() AND (j.lease_until IS NULL OR j.lease_until<clock_timestamp()))";
    await remove("jobAttempts", "job_attempts", expiredJob);
    await remove("jobItems", "job_items", `${expiredJob} AND NOT EXISTS(SELECT 1 FROM job_attempts a WHERE a.item_id=target.id)`);
    await update("jobStageReceipts", "inventory_mutation_stages", expiredJob, "job_id=NULL");
    await remove("jobs", "jobs", `expires_at<clock_timestamp() AND (lease_until IS NULL OR lease_until<clock_timestamp())
      AND NOT EXISTS(SELECT 1 FROM job_items i WHERE i.job_id=target.id)
      AND NOT EXISTS(SELECT 1 FROM job_attempts a WHERE a.job_id=target.id)
      AND NOT EXISTS(SELECT 1 FROM inventory_mutation_stages s WHERE s.job_id=target.id)`);
    await remove("administrativeAudit", "audit_events", "observed_at<clock_timestamp()-interval '90 days'");
    await remove("capabilityEvidence", "capability_evidence", "expires_at<clock_timestamp()");
    if ((await client.query("SELECT to_regclass('public.data_sync_runs') AS name")).rows[0].name) {
      for (const table of ["data_sync_source_jobs", "data_sync_run_sources"]) await remove(table, table,
        "EXISTS(SELECT 1 FROM data_sync_runs r WHERE r.id=target.run_id AND r.expires_at<clock_timestamp())");
      await remove("dataSyncRuns", "data_sync_runs", `expires_at<clock_timestamp()
        AND NOT EXISTS(SELECT 1 FROM data_sync_source_jobs s WHERE s.run_id=target.id)
        AND NOT EXISTS(SELECT 1 FROM data_sync_run_sources s WHERE s.run_id=target.id)`);
    }
    await update("powerPlatformExpiredWork", "power_platform_refresh_jobs",
      "status='running' AND (expires_at<=clock_timestamp() OR deadline_at<=clock_timestamp())",
      "status='failed',error_code='inventory_job_expired',message='The inventory refresh expired during retention.',finished_at=clock_timestamp(),updated_at=clock_timestamp()");
    await remove("powerPlatformJobs", "power_platform_refresh_jobs", "expires_at<clock_timestamp() AND status<>'running'");
    await update("packageExpiredWork", "package_refresh_jobs",
      "status='running' AND (expires_at<=clock_timestamp() OR deadline_at<=clock_timestamp())",
      "status='failed',error_code='package_refresh_expired',message='The package refresh expired during retention.',finished_at=clock_timestamp(),updated_at=clock_timestamp()");
    await remove("packageSnapshotRows", "package_inventory_resources", `EXISTS(SELECT 1 FROM package_inventory_snapshots s
      WHERE s.id=target.snapshot_id AND s.expires_at<clock_timestamp()
        AND NOT EXISTS(SELECT 1 FROM inventory_control_pending p WHERE p.observation_id=s.id))`);
    await remove("packageSnapshots", "package_inventory_snapshots", `expires_at<clock_timestamp()
      AND NOT EXISTS(SELECT 1 FROM inventory_control_pending p WHERE p.observation_id=target.id)
      AND NOT EXISTS(SELECT 1 FROM package_inventory_resources r WHERE r.snapshot_id=target.id)`);
    if ((await client.query("SELECT to_regclass('public.agent_people_cache') AS name")).rows[0].name) {
      await remove("agentPeople", "agent_people_cache", "expires_at<clock_timestamp()");
    }
    if ((await client.query("SELECT to_regclass('public.agent_identity_cache') AS name")).rows[0].name) {
      await remove("agentIdentities", "agent_identity_cache", "expires_at<clock_timestamp()");
    }
    await remove("packageJobs", "package_refresh_jobs", "expires_at<clock_timestamp() AND status<>'running'");
    await remove("packageQualifications", "package_mutation_qualifications", "expires_at<clock_timestamp()");
    await update("purviewExpiredWork", "purview_audit_jobs",
      "status IN ('running','reconciling_create') AND deadline_at<=clock_timestamp()",
      "status='inconclusive',error_code='audit_job_expired',message='The local Audit Search deadline expired; remote work may continue.',remote_work_may_continue=attempted_at IS NOT NULL,finished_at=clock_timestamp(),execution_owner=NULL,updated_at=clock_timestamp()");
    await remove("purviewRecords", "purview_audit_records", `EXISTS(SELECT 1 FROM purview_audit_jobs j
      WHERE j.id=target.job_id AND j.expires_at<clock_timestamp() AND j.status NOT IN ('running','reconciling_create'))`);
    await update("purviewQualificationJobs", "purview_audit_qualifications", `EXISTS(SELECT 1 FROM purview_audit_jobs j
      WHERE j.id=target.job_id AND j.expires_at<clock_timestamp() AND j.status NOT IN ('running','reconciling_create'))`, "job_id=NULL");
    await remove("purviewJobs", "purview_audit_jobs", `expires_at<clock_timestamp() AND status NOT IN ('running','reconciling_create')
      AND NOT EXISTS(SELECT 1 FROM purview_audit_records r WHERE r.job_id=target.id)
      AND NOT EXISTS(SELECT 1 FROM purview_audit_qualifications q WHERE q.job_id=target.id)`);
    await update("purviewQualificationExpiry", "purview_audit_qualifications",
      "expires_at<clock_timestamp() AND status IN ('approved','qualified')", "status='expired',updated_at=clock_timestamp()");
    await remove("purviewQualifications", "purview_audit_qualifications", "expires_at<clock_timestamp()-interval '30 days' AND job_id IS NULL");
    await update("defenderExpiredWork", "defender_hunting_jobs",
      "status IN ('running','waiting_authorization') AND (deadline_at<=clock_timestamp() OR activation_count>=4 OR provider_request_count>=12)",
      "status='inconclusive',error_code=CASE WHEN deadline_at<=clock_timestamp() THEN 'hunting_job_expired' WHEN activation_count>=4 THEN 'hunting_activation_limit' ELSE 'hunting_provider_request_limit' END,message='The bounded hunting deadline expired before publication.',finished_at=clock_timestamp(),execution_owner=NULL,updated_at=clock_timestamp()");
    await remove("defenderRows", "defender_hunting_rows", `EXISTS(SELECT 1 FROM defender_hunting_snapshots s JOIN defender_hunting_jobs j
      ON j.id=s.job_id WHERE s.id=target.snapshot_id AND j.expires_at<clock_timestamp() AND j.status<>'running')`);
    await remove("defenderSnapshots", "defender_hunting_snapshots", `EXISTS(SELECT 1 FROM defender_hunting_jobs j
      WHERE j.id=target.job_id AND j.expires_at<clock_timestamp() AND j.status<>'running')
      AND NOT EXISTS(SELECT 1 FROM defender_hunting_rows r WHERE r.snapshot_id=target.id)`);
    await remove("defenderJobs", "defender_hunting_jobs", `expires_at<clock_timestamp() AND status<>'running'
      AND NOT EXISTS(SELECT 1 FROM defender_hunting_snapshots s WHERE s.job_id=target.id)`);
    await remove("defenderQualifications", "defender_hunting_qualification_evidence", "expires_at<clock_timestamp()");
    await remove("defenderRetainedScopes", "defender_hunting_retained_scopes",
      "expires_at<clock_timestamp() AND NOT EXISTS (SELECT 1 FROM defender_hunting_jobs job WHERE job.retained_scope_id=defender_hunting_retained_scopes.id)");
    await update("quarantineExpiredWork", "copilot_quarantine_jobs",
      "status='running' AND (deadline_at<=clock_timestamp() OR attempts>=10)",
      "status='inconclusive',lease_owner=NULL,lease_until=NULL,updated_at=clock_timestamp()");
    const expiredQuarantine = "EXISTS(SELECT 1 FROM copilot_quarantine_jobs j WHERE j.id=target.job_id AND j.expires_at<clock_timestamp() AND j.status<>'running')";
    await remove("quarantineAttempts", "copilot_quarantine_attempts", expiredQuarantine);
    await remove("quarantineItems", "copilot_quarantine_job_items", `${expiredQuarantine}
      AND NOT EXISTS(SELECT 1 FROM copilot_quarantine_attempts a WHERE a.item_id=target.id)
      AND NOT EXISTS(SELECT 1 FROM copilot_quarantine_audit a WHERE a.item_id=target.id)`);
    await remove("quarantineJobs", "copilot_quarantine_jobs", `expires_at<clock_timestamp() AND status<>'running'
      AND NOT EXISTS(SELECT 1 FROM copilot_quarantine_job_items i WHERE i.job_id=target.id)
      AND NOT EXISTS(SELECT 1 FROM copilot_quarantine_attempts a WHERE a.job_id=target.id)
      AND NOT EXISTS(SELECT 1 FROM copilot_quarantine_audit a WHERE a.job_id=target.id)`);
    await remove("quarantineObservations", "copilot_quarantine_status_observations", "expires_at<clock_timestamp()");
    await remove("quarantineAudit", "copilot_quarantine_audit", "expires_at<clock_timestamp()");
    await update("quarantineApprovalExpiry", "copilot_quarantine_canary_approvals",
      "status='approved' AND approval_expires_at<clock_timestamp()", "status='expired',finished_at=COALESCE(finished_at,clock_timestamp())");
    await remove("quarantineApprovals", "copilot_quarantine_canary_approvals", "evidence_expires_at<clock_timestamp()");
    await remove("quarantineQualifications", "copilot_quarantine_qualifications", "expires_at<clock_timestamp()");
    const history = new OfficialReportHistory(database);
    if (slice.reserve(120, 524_288)) {
      const tenant = (await client.query(`SELECT tenant_id FROM official_usage_history_state WHERE tenant_id COLLATE "C">
        coalesce((SELECT cursor->>'tenant' FROM data_lifecycle_progress WHERE worker='operator'),'') COLLATE "C"
        ORDER BY tenant_id COLLATE "C" LIMIT 1`)).rows[0];
      if (tenant) {
        affected.officialHistoryExpired = await history.expireInTransaction(client, tenant.tenant_id, 1);
        affected.officialHistoryCollected = await history.collectInTransaction(client, tenant.tenant_id);
      }
      await client.query("UPDATE data_lifecycle_progress SET cursor=jsonb_set(cursor,'{tenant}',to_jsonb($1::text)) WHERE worker='operator'", [tenant?.tenant_id ?? ""]);
    }
    await update("officialIngestionsExpired", "official_usage_ingestions",
      "state IN ('streaming','validating','ready','accepting') AND (expires_at<=clock_timestamp() OR state<>'ready' AND lease_until<=clock_timestamp())",
      "state='cancelled'");
    await remove("officialIngestionRows", "official_usage_ingestion_rows",
      "EXISTS(SELECT 1 FROM official_usage_ingestions i WHERE i.id=official_usage_ingestion_rows.ingestion_id AND i.state IN ('accepted','cancelled','failed'))");
    await update("officialStagingExpiry", "official_usage_staging", "status='active' AND expires_at<clock_timestamp()", "status='expired'");
    await remove("officialStagedRows", "official_usage_staged_rows",
      "EXISTS (SELECT 1 FROM official_usage_staging staging WHERE staging.id=official_usage_staged_rows.staging_id AND staging.status IN ('accepted','expired','replaced','cancelled'))");
    await update("officialStagingReservations", "official_usage_ingestions",
      `state IN ('accepted','cancelled','failed') AND stored_bytes<>0 AND ${emptyReportStaging("target")}`, "stored_bytes=0");
    await remove("officialConfirmations", "official_usage_confirmations", "expires_at<clock_timestamp() OR consumed_at<clock_timestamp()-interval '1 day'");
    await update("officialVersionsExpired", "official_usage_versions",
      `deleted_at IS NULL
        AND EXISTS (SELECT 1 FROM official_usage_set_versions membership
          JOIN official_usage_sets report_set ON report_set.id=membership.set_id
          WHERE membership.version_id=official_usage_versions.id AND report_set.deleted_at IS NOT NULL)
        AND NOT EXISTS (SELECT 1 FROM official_usage_set_versions membership
          JOIN official_usage_sets report_set ON report_set.id=membership.set_id
          WHERE membership.version_id=official_usage_versions.id AND report_set.deleted_at IS NULL)`,
      "deleted_at=clock_timestamp()");
    await update("officialOrphanVersions", "official_usage_versions",
      `deleted_at IS NULL AND ${orphanReportVersion("target")}`, "deleted_at=clock_timestamp(),expires_at=clock_timestamp()");
    affected.officialRows = affected.recordDeletedReportRows ?? 0;
    await remove("officialRowFacts", "official_usage_row_facts",
      `NOT EXISTS (SELECT 1 FROM official_usage_version_rows row
        WHERE row.tenant_id=official_usage_row_facts.tenant_id AND row.kind=official_usage_row_facts.kind
          AND row.payload_hash=official_usage_row_facts.payload_hash)`);
    await remove("officialIngestions", "official_usage_ingestions",
      `state IN ('accepted','cancelled','failed') AND expires_at<clock_timestamp()-interval '1 day'
        AND ${emptyReportStaging("target")}
        AND NOT EXISTS(SELECT 1 FROM official_usage_versions v WHERE v.id=target.version_id AND v.deleted_at IS NULL
          AND ${orphanReportVersion("v")})`);
    await remove("officialStaging", "official_usage_staging", `status<>'active' AND created_at<clock_timestamp()-interval '1 day'
      AND NOT EXISTS(SELECT 1 FROM official_usage_ingestions i WHERE i.staging_id=official_usage_staging.id)
      AND NOT EXISTS(SELECT 1 FROM official_usage_staged_rows r WHERE r.staging_id=official_usage_staging.id)`);
    await remove("officialBundleReceipts", "official_usage_bundle_receipts", "expires_at<clock_timestamp()");
    await remove("officialAudit", "official_usage_audit", "expires_at<clock_timestamp()");
    if ((await client.query("SELECT to_regclass('public.agent_usage_associations') AS name")).rows[0].name) {
      await remove("agentUsageAssociations", "agent_usage_associations",
        `EXISTS (SELECT 1 FROM official_usage_sets report_set
          WHERE report_set.id=agent_usage_associations.report_set_id
            AND report_set.tenant_id=agent_usage_associations.tenant_id
            AND (report_set.deleted_at IS NOT NULL OR report_set.expires_at<=clock_timestamp()))`);
    }
    await remove("officialMemberships", "official_usage_set_versions",
      `EXISTS (SELECT 1 FROM official_usage_sets report_set WHERE report_set.id=official_usage_set_versions.set_id AND report_set.deleted_at<clock_timestamp()-interval '90 days')
        AND NOT EXISTS(SELECT 1 FROM official_usage_history_memberships h WHERE h.set_id=official_usage_set_versions.set_id)`);
    await remove("officialVersions", "official_usage_versions",
      `deleted_at<clock_timestamp()-interval '90 days'
        AND NOT EXISTS (SELECT 1 FROM official_usage_set_versions membership WHERE membership.version_id=official_usage_versions.id)
        AND NOT EXISTS (SELECT 1 FROM official_usage_version_rows r WHERE r.version_id=official_usage_versions.id)
        AND NOT EXISTS (SELECT 1 FROM official_usage_ingestions ingestion WHERE ingestion.version_id=official_usage_versions.id)`);
    await remove("officialArtifacts", "official_usage_artifacts",
      "NOT EXISTS (SELECT 1 FROM official_usage_versions version WHERE version.artifact_id=official_usage_artifacts.id)");
    // The overview still needs accepted correction markers after their payloads are purged.
    await remove("officialSets", "official_usage_sets",
      `deleted_at<clock_timestamp()-interval '90 days'
        AND NOT EXISTS (SELECT 1 FROM official_usage_set_versions membership WHERE membership.set_id=official_usage_sets.id)
        AND NOT EXISTS (SELECT 1 FROM official_usage_history_memberships h WHERE h.set_id=official_usage_sets.id)
        AND NOT EXISTS (SELECT 1 FROM official_usage_read_contexts c WHERE c.set_id=official_usage_sets.id)
        AND NOT EXISTS (SELECT 1 FROM official_usage_ingestions i WHERE i.correction_of=official_usage_sets.id)
        AND NOT (complete AND accepted_at IS NOT NULL AND EXISTS (
          SELECT 1 FROM official_usage_sets original
          WHERE original.id=official_usage_sets.supersedes_set_id
            AND original.tenant_id=official_usage_sets.tenant_id AND original.deleted_at IS NULL))`);
    await remove("sourceIdentifiers", "source_identifiers", `
      (source='graph_packages'
        AND NOT EXISTS (SELECT 1 FROM job_items JOIN jobs ON jobs.id=job_items.job_id WHERE jobs.tenant_id=source_identifiers.tenant_id AND source_identifiers.resource_type='microsoft.graph/copilotpackages' AND job_items.target_id=source_identifiers.native_id AND job_items.target_id=source_identifiers.identifier_value)
        AND NOT EXISTS (SELECT 1 FROM package_inventory_resources resource JOIN package_inventory_snapshots snapshot ON snapshot.id=resource.snapshot_id AND snapshot.is_current AND snapshot.expires_at>clock_timestamp()
          CROSS JOIN LATERAL jsonb_to_recordset(resource.identifiers) AS identifier(kind text,value text)
          WHERE resource.tenant_id=source_identifiers.tenant_id AND source_identifiers.resource_type='microsoft.graph/copilotpackages'
            AND resource.native_id=source_identifiers.native_id AND identifier.kind=source_identifiers.identifier_kind AND identifier.value=source_identifiers.identifier_value)
        AND NOT EXISTS (SELECT 1 FROM package_record_rows resource JOIN data_generations generation ON generation.id=resource.generation_id
          JOIN inventory_facts identifier ON identifier.generation_id=resource.generation_id AND identifier.identity=resource.identity
          WHERE resource.tenant_id=source_identifiers.tenant_id AND source_identifiers.resource_type='microsoft.graph/copilotpackages'
            AND resource.native_id=source_identifiers.native_id AND identifier.kind='identifier'
            AND identifier.payload->>'kind'=source_identifiers.identifier_kind AND identifier.value=source_identifiers.identifier_value
            AND generation.state IN ('published','retired') AND generation.expires_at>clock_timestamp() AND resource.expires_at>clock_timestamp()))
      OR (source='power_platform' AND NOT EXISTS (
        SELECT 1 FROM power_platform_record_rows resource JOIN data_generations generation ON generation.id=resource.generation_id
        JOIN inventory_facts identifier ON identifier.generation_id=resource.generation_id AND identifier.identity=resource.identity
        WHERE resource.tenant_id=source_identifiers.tenant_id AND resource.environment_id=source_identifiers.environment_id
          AND resource.resource_type=source_identifiers.resource_type AND resource.native_id=source_identifiers.native_id
          AND identifier.kind='identifier' AND identifier.payload->>'kind'=source_identifiers.identifier_kind
          AND identifier.value=source_identifiers.identifier_value AND generation.state IN ('published','retired')
          AND generation.expires_at>clock_timestamp() AND resource.expires_at>clock_timestamp()))`);
    await slice.finish();
    const cursor = (await client.query("SELECT cursor FROM data_lifecycle_progress WHERE worker='operator'")).rows[0].cursor;
    const pending = Number(cursor.step ?? 0) !== 0 || Boolean(cursor.tenant);
    if (options.dryRun) await client.query("ROLLBACK");
    else await client.query("COMMIT");
    return { dryRun: Boolean(options.dryRun), batchSize, affected, pending };
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { /* preserve original failure */ }
    throw error;
  } finally {
    if (!verifiedClient) client.release();
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
  const batchSize = options.batchSize ?? 1_000;
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 5_000) throw new Error("Retention batch size must be 1-5000.");
  const client = await database.connect();
  let locked = false,discard = false;
  try {
    locked = (await client.query("SELECT pg_try_advisory_lock_shared(3650101) AS acquired")).rows[0].acquired;
    if (!locked) throw new Error("Schema initialization owns the database lock; retry retention after it completes.");
    await verifySchema(client);
    const affected: Record<string, number> = {};
    // A resumed partial traversal says nothing about tenants already passed.
    // Require a complete, quiet traversal after reaching the first cursor boundary.
    let cycleChanged = true;
    for (let passes = 1; passes <= maximumPasses; passes += 1) {
      const result = await retainSlice(database, { batchSize },client);
      for (const [name, count] of Object.entries(result.affected)) affected[name] = (affected[name] ?? 0) + count;
      cycleChanged ||= Object.values(result.affected).some(count => count !== 0);
      if (!result.pending) {
        if (!cycleChanged) return { passes, affected };
        cycleChanged = false;
      }
    }
    throw new Error("Retention cleanup did not converge within its bounded pass limit; keep the database in maintenance.");
  } finally {
    try {
      if (locked && (await client.query("SELECT pg_advisory_unlock_shared(3650101) AS unlocked")).rows[0].unlocked!==true) {
        throw new Error("Retention schema lock ownership was lost.");
      }
    } catch (error) { discard = true; throw error; }
    finally { client.release(discard); }
  }
}

async function main() {
  const command = process.argv[2] ?? "initialize";
  const settings = databaseSettings();
  const resetting = command === "preflight-reset" || command === "reset";
  const database = new pg.Pool(resetting ? { ...settings, database: "postgres" } : settings);
  try {
    if (!["preflight", "preflight-reset", "reset", "initialize", "retain"].includes(command)) throw new Error("Unsupported database operator command.");
    if (resetting) {
      const operation = command === "reset" ? resetDatabase : preflightDatabaseReset;
      const result = await operation(database, settings.database ?? "", process.argv[3] ?? "");
      console.log(JSON.stringify({ event: "database_operator_command", command, outcome: "succeeded", ...result }));
    } else if (command === "preflight") {
      const schema = await preflightSchema(database);
      console.log(JSON.stringify({ event: "database_operator_command", command, outcome: "succeeded", ...schema }));
    } else if (command === "retain") {
      if (process.argv[3] !== "confirmed") throw new Error("Retention requires an explicit confirmed target.");
      const batchSize = Number(process.argv[4] ?? 1_000);
      const result = await retain(database, { batchSize, dryRun: process.argv[5] === "dry-run" });
      console.log(JSON.stringify({ event: "retention_cleanup", outcome: "succeeded", ...result }));
    }
    else {
      await bootstrap(database, secretValue("APP_PGPASSWORD") ?? "");
      await initializeSchema(database);
      await grantRuntime(database);
      await verifySchema(database);
    }
    if (command === "initialize") console.log(JSON.stringify({ event: "database_operator_command", command, outcome: "succeeded", schemaFingerprint }));
  } finally { await database.end(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(JSON.stringify(databaseOperatorFailure(error))); process.exitCode = 1; });
}