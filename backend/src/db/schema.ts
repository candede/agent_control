import { createHash } from "node:crypto";
import type pg from "pg";
import { currentSchemaSql } from "./currentSchema.js";
import { verifyDataGenerationAccountingSchema } from "./dataGenerationAccountingSchema.js";
import { verifyInventoryCollectionRewindSchema } from "./inventoryCollectionRewindSchema.js";
import { verifyInventoryReconciliationAdmissionSchema } from "./inventoryReconciliationAdmissionSchema.js";
import { verifyReportCapacitySchema } from "./reportCapacitySchema.js";
import { verifyReportMembershipCountsSchema } from "./reportMembershipCountsSchema.js";

export const schemaSql: string = currentSchemaSql;
export const schemaFingerprint: string = createHash("sha256").update(schemaSql).digest("hex");

export async function verifySchema(database: Pick<pg.Pool, "query">): Promise<void> {
  const marker = (await database.query<{ valid: boolean }>(`SELECT
    (SELECT count(*)=3 FROM pg_attribute WHERE attrelid=to_regclass('public.app_schema')
      AND attnum>0 AND NOT attisdropped AND attnotnull AND (
        attname='singleton' AND atttypid='boolean'::regtype
        OR attname='fingerprint' AND atttypid='text'::regtype
        OR attname='initialized_at' AND atttypid='timestamptz'::regtype))
    AND EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid=to_regclass('public.app_schema')
      AND contype='p' AND pg_get_constraintdef(oid)='PRIMARY KEY (singleton)')
    AND EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid=to_regclass('public.app_schema')
      AND contype='c' AND convalidated AND pg_get_expr(conbin,conrelid)='singleton')
    AND EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid=to_regclass('public.app_schema')
      AND contype='c' AND convalidated AND pg_get_expr(conbin,conrelid)=$1) AS valid`,
    ["(fingerprint ~ '^[a-f0-9]{64}$'::text)"])).rows[0];
  if (marker?.valid !== true) {
    throw new Error("Current schema marker is missing or invalid; reset and initialize the database.");
  }
  const { rows } = await database.query<{ singleton: boolean; fingerprint: string; initialized: boolean }>(
    "SELECT singleton,fingerprint,initialized_at IS NOT NULL AS initialized FROM public.app_schema",
  );
  if (rows.length !== 1 || rows[0].singleton !== true || rows[0].initialized !== true ||
    rows[0].fingerprint !== schemaFingerprint) {
    throw new Error("Database schema fingerprint does not match this artifact; reset and initialize the database.");
  }
  const contract = (await database.query<{ associations: string | null; revision: string | null; triggers: number; cascade: boolean }>(`
    SELECT to_regclass('public.agent_usage_associations')::text AS associations,
      to_regclass('public.agent_usage_state')::text AS revision,
      (SELECT count(*)::int FROM pg_trigger WHERE NOT tgisinternal AND tgenabled IN ('O','A') AND (
        (tgrelid=to_regclass('public.agent_usage_associations') AND tgname IN ('protect_agent_usage_association','advance_agent_usage_revision'))
        OR (tgrelid=to_regclass('public.official_usage_sets') AND tgname='delete_agent_usage_report_associations')
      )) AS triggers,
      EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid=to_regclass('public.agent_usage_associations')
        AND contype='f' AND confrelid=to_regclass('public.official_usage_sets') AND confdeltype='c') AS cascade`)).rows[0];
  if (!contract?.associations || !contract.revision || contract.triggers !== 3 || !contract.cascade) {
    throw new Error("Database usage association schema is missing or incomplete; reset and initialize the current schema.");
  }
  const permissions = (await database.query<{ valid: boolean }>(`
    SELECT current_user<>'agentcontrol_app' OR (
      has_table_privilege(current_user,'agent_usage_associations','SELECT')
      AND has_table_privilege(current_user,'agent_usage_associations','INSERT')
      AND has_table_privilege(current_user,'agent_usage_associations','DELETE')
      AND NOT has_any_column_privilege(current_user,'agent_usage_associations','UPDATE')
      AND NOT has_table_privilege(current_user,'agent_usage_associations','TRUNCATE')
      AND has_table_privilege(current_user,'agent_usage_state','SELECT')
      AND NOT has_table_privilege(current_user,'agent_usage_state','INSERT,UPDATE,DELETE,TRUNCATE')
      AND NOT has_any_column_privilege(current_user,'agent_usage_state','INSERT,UPDATE')
    ) AS valid`)).rows[0];
  if (!permissions?.valid) throw new Error("Database usage association runtime grants are invalid; operator recovery required.");
  await verifyDataSyncCleanupSchema(database);
  await verifyDataGenerationSchema(database);
  await verifyUserSourceSchema(database);
  await verifyUserSourceReportSchema(database);
  await verifyInventoryClassificationSchema(database);
  await verifyOfficialReportSchema(database);
  await verifyUsersReportsCutoverSchema(database);
  await verifyInventoryGenerationSchema(database);
  await verifyJobPagesSchema(database);
  await verifyInventoryRefreshTargetsSchema(database);
  await verifyInventoryAuthoritySchema(database);
  await verifyInventoryIdentitySchema(database);
  await verifyInventoryControlQueueSchema(database);
  await verifyInventoryMutationStageSchema(database);
  await verifyInventoryNativeControlSchema(database);
  await verifyInventoryClearSchema(database);
  await verifyInventorySelectionCriteriaSchema(database);
  await verifyInventoryObserverSchema(database);
  await verifyInventoryCutoverSchema(database);
  await verifyInventoryProviderSchema(database);
  await verifyInventoryRefreshContractSchema(database);
  await verifyInventoryIdentityLookupSchema(database);
  await verifyInventoryQueryContextSchema(database);
  await verifyInventoryAttemptSchema(database);
  await verifyInventoryOrderingSchema(database);
  await verifyInventoryIdentityExpirySchema(database);
  await verifyInventoryDetailAdmissionSchema(database);
  await verifyInventoryAuditSelectionSchema(database);
  await verifyInventoryPeopleProjectionSchema(database);
  await verifyInventoryEnvironmentProjectionSchema(database);
  await verifyInventoryDispatchAuthoritySchema(database);
  await verifyDataLifecycleSchema(database);
  await verifyReportCapacitySchema(database);
  await verifyInventoryCollectionSchema(database);
  await verifyInventorySummaryAccessSchema(database);
  await verifyInventorySetPublicationSchema(database);
  await verifyInventorySummaryAggregateSchema(database);
  await verifyInventoryPreparedPublicationSchema(database);
  await verifyDataGenerationAccountingSchema(database);
  await verifyUserReportPageSchema(database);
  await verifyInventoryReconciliationAdmissionSchema(database);
  await verifyOfficialReportPageSchema(database);
  await verifyInventoryCollectionRewindSchema(database);
  await verifyChildInsertFenceSchema(database);
  await verifyReportMembershipCountsSchema(database);
}

async function verifyDataSyncCleanupSchema(database: Pick<pg.Pool, "query">) {
  const definition = `((NOT clear_saved_data) OR ((mode = 'full'::text) AND (source_ids @> '["users", "graph_packages", "power_platform"]'::jsonb) AND (jsonb_array_length(source_ids) = 3)))`;
  const row = (await database.query<{ valid: boolean }>(`SELECT convalidated AND pg_get_expr(conbin,conrelid)=$1 AS valid
    FROM pg_constraint WHERE conrelid='public.data_sync_runs'::regclass
      AND conname='data_sync_cleanup_full_scope' AND contype='c'`, [definition])).rows[0];
  if (row?.valid !== true) throw new Error("Data sync cleanup scope constraint is missing or invalid.");
}

async function verifyInventoryPreparedPublicationSchema(database: Pick<pg.Pool,"query">) {
  const row = (await database.query(`SELECT
    EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='inventory_attempts'::regclass
      AND attname='membership_prepared' AND atttypid='boolean'::regtype AND attnotnull AND NOT attisdropped) AS prepared,
    EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='inventory_attempts'::regclass
      AND attname='prepared_changed_count' AND atttypid='integer'::regtype AND NOT attisdropped) AS changed,
    EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='inventory_attempts'::regclass
      AND conname='inventory_preparation_complete' AND contype='c' AND convalidated) AS complete,
    EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='inventory_memberships'::regclass
      AND tgname='inventory_prepared_member_fence' AND tgenabled='O' AND tgtype=11
      AND tgfoid=to_regprocedure('inventory_prepared_member_guard()')) AS deletion_fence,
    has_function_privilege('agentcontrol_app','inventory_prepared_member_guard()','EXECUTE') AS callable`)).rows[0];
  if (!row?.prepared || !row.changed || !row.complete || !row.deletion_fence || row.callable) {
    throw new Error("inventory_prepared_publication_schema");
  }
}

async function verifyInventoryOrderingSchema(database: Pick<pg.Pool, "query">) {
  const rows = (await database.query(`SELECT c.collname,to_jsonb(c) AS definition FROM pg_collation c
    JOIN pg_namespace n ON n.oid=c.collnamespace
    WHERE n.nspname='public' AND c.collname IN ('inventory_text_order','inventory_version_order')`)).rows;
  const locales: Record<string, string> = {
    inventory_text_order: "en-US-u-ks-level1", inventory_version_order: "en-US-u-kn-true-ks-level1",
  };
  const normalizedLocale = (value: unknown) => {
    try { return typeof value === "string" ? new Intl.Locale(value).toString() : null; }
    catch { return null; }
  };
  if (rows.length !== 2 || rows.some(row => row.definition.collprovider !== "i" || row.definition.collisdeterministic !== false
    || normalizedLocale(row.definition.colliculocale ?? row.definition.colllocale) !== normalizedLocale(locales[row.collname]))) {
    throw new Error("inventory_ordering_schema");
  }
}

async function verifyInventorySelectionCriteriaSchema(database: Pick<pg.Pool, "query">) {
  if (!(await database.query(`SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='inventory_mutation_stages' AND column_name='target_filter_hash'
      AND data_type='text' AND is_nullable='NO'`)).rowCount) throw new Error("inventory_selection_criteria_schema_invalid");
}

async function verifyInventoryIdentityLookupSchema(database: Pick<pg.Pool, "query">) {
  const row = (await database.query(`SELECT
    position('source.agent_id=substr(NEW.record_id,7)' IN pg_get_functiondef('protect_inventory_identity_cache()'::regprocedure))>0
      AS exact_identity,
    position('md5(lower(f.value))=md5(NEW.candidate_id::text)' IN pg_get_functiondef('protect_inventory_identity_cache()'::regprocedure))>0
      AS identifier_index`)).rows[0];
  if (!row?.exact_identity || !row.identifier_index) throw new Error("inventory_identity_lookup_schema");
}

const recordTables = ["package_record_rows", "power_platform_record_rows", "unified_agent_rows"] as const;

async function verifyInventoryGenerationSchema(database: Pick<pg.Pool, "query">) {
  const tables = [...recordTables, "inventory_attempts", "inventory_roots", "inventory_keys", "inventory_facts",
    "inventory_memberships", "inventory_changes", "inventory_pages", "inventory_worker_pins", "inventory_reconciliation",
    "inventory_reconciliation_keys", "inventory_frontier", "inventory_candidate_edges", "unified_agent_memberships",
    "inventory_compaction_refs", "inventory_canonical_ids", "inventory_read_contexts", "inventory_revisions", "inventory_exact_heads"];
  const rows = (await database.query(`SELECT name,to_regclass('public.'||name) AS relation FROM unnest($1::text[]) name`, [tables])).rows;
  if (rows.length !== tables.length || rows.some(row => !row.relation)) throw new Error("inventory_schema_missing");
  const triggers = (await database.query(`SELECT count(*)::int AS count FROM pg_trigger
    WHERE NOT tgisinternal AND tgenabled<>'D' AND tgname IN ('inventory_immutable','inventory_interval_fence','inventory_reachability',
      'inventory_audit_insert','inventory_audit_delete','inventory_control_fence','inventory_revision_fence','inventory_exact_fence')`)).rows[0].count;
  if (triggers !== 14) throw new Error("inventory_schema_guards");
  const indexes = ["inventory_one_root", "inventory_member_open", "inventory_member_asof", "inventory_member_reachability",
    "inventory_member_gc", "inventory_fact_match", "inventory_frontier_pending", "inventory_frontier_component", "unified_member_source",
    "inventory_exact_newer", "inventory_exact_content"];
  if ((await database.query("SELECT count(*)::int AS count FROM pg_indexes WHERE schemaname='public' AND indexname=ANY($1::text[])", [indexes])).rows[0].count !== indexes.length) {
    throw new Error("inventory_schema_indexes");
  }
  const grants = (await database.query(`SELECT EXISTS(SELECT 1 FROM unnest($1::text[]) relation
      WHERE has_table_privilege('agentcontrol_app',relation,'UPDATE')) AS update,
    EXISTS(SELECT 1 FROM unnest($2::text[]) relation WHERE has_table_privilege('agentcontrol_app',relation,'TRUNCATE')) AS truncate,
    (SELECT count(*)=2 FROM pg_constraint WHERE contype='f' AND confrelid='inventory_roots'::regclass AND cardinality(conkey)=3 AND convalidated) AS scoped,
    has_function_privilege('agentcontrol_app','inventory_association_revision(text)','EXECUTE') AS reader,
    (SELECT bool_and(has_table_privilege(current_user,'inventory_exact_heads',privilege))
      FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE']) privilege) AS precedence`,
  [[...recordTables, "inventory_keys", "inventory_facts", "unified_agent_memberships", "inventory_canonical_ids"], tables])).rows[0];
  if (grants.update || grants.truncate || !grants.scoped || !grants.reader || !grants.precedence) throw new Error("inventory_schema_privileges");
}

async function verifyInventoryNativeControlSchema(database: Pick<pg.Pool, "query">) {
  const row = (await database.query(`SELECT to_regclass('public.inventory_native_control_pending') IS NOT NULL
    AND EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='inventory_native_control_fence' AND NOT tgisinternal AND tgenabled='O')
    AND EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='inventory_native_control_pending'::regclass
      AND confrelid='copilot_quarantine_status_observations'::regclass AND contype='f') AS valid`)).rows[0];
  if (!row?.valid) throw new Error("inventory_native_control_schema_invalid");
}

async function verifyInventoryQueryContextSchema(database: Pick<pg.Pool, "query">) {
  if (!(await database.query(`SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='inventory_read_contexts' AND column_name='query_values'
      AND data_type='jsonb' AND is_nullable='NO'`)).rowCount) throw new Error("inventory_query_context_schema");
}

async function verifyUserSourceReportSchema(database: Pick<pg.Pool, "query">) {
  const result = await database.query(`SELECT
    (SELECT count(*)=2 FROM pg_constraint WHERE contype='c' AND convalidated AND
      (conrelid='app_activity_rows'::regclass AND conname='app_activity_rows_period_check'
        OR conrelid='user_source_attempts'::regclass AND conname='user_source_attempts_report_period_check')
      AND pg_get_constraintdef(oid) LIKE '%ARRAY[''D28''::text, ''D30''::text]%') AS periods,
    EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='user_source_attempts'::regclass
      AND tgname='user_source_report_period_fence' AND tgenabled='O'
      AND tgfoid='user_source_protect_report_period()'::regprocedure) AS immutable`);
  if (result.rows[0]?.periods !== true || result.rows[0]?.immutable !== true) {
    throw new Error("User-source report period schema is missing or invalid.");
  }
}

async function verifyInventoryCutoverSchema(database: Pick<pg.Pool, "query">) {
  const row = (await database.query(`SELECT
    NOT EXISTS(SELECT 1 FROM unnest(ARRAY['power_platform_inventory_snapshots','power_platform_inventory_resources',
      'package_detail_cache','unified_agents','unified_agent_sources']) name WHERE to_regclass('public.'||name) IS NOT NULL) AS retired,
    EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='package_inventory_snapshots'::regclass
      AND conname='package_control_only' AND convalidated) AS controls,
    position('power_platform_inventory_snapshots' IN pg_get_functiondef('clear_admitted_data_sync_snapshots()'::regprocedure))=0 AS clear,
    NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname IN ('prepare_unified_agent_source_publication',
        'advance_unified_agent_package_sources','advance_unified_agent_power_platform_sources',
        'clear_admitted_unified_agent_registry','clear_admitted_package_details',
        'unified_agent_package_publication_targets','unified_agent_power_platform_publication_snapshot',
        'lock_unified_agent_publication','package_detail_current_catalog','package_detail_revision','package_detail_has_evidence')) AS functions
  `)).rows[0];
  if (!["retired", "controls", "clear", "functions"].every(key => row?.[key] === true)) throw new Error("inventory_cutover_schema_invalid");
}

async function verifyInventorySetPublicationSchema(database: Pick<pg.Pool,"query">) {
  const row = (await database.query(`SELECT
    EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='inventory_memberships'::regclass
      AND tgname='inventory_interval_fence' AND tgenabled='O' AND tgtype=27
      AND tgfoid=to_regprocedure('inventory_interval_guard()')) AS row_fence,
    EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='inventory_memberships'::regclass
      AND tgname='inventory_interval_insert_fence' AND tgenabled='O' AND tgtype=4
      AND tgnewtable='inserted_inventory_memberships'
      AND tgfoid=to_regprocedure('inventory_interval_insert_guard()')) AS insert_fence,
    has_function_privilege('agentcontrol_app','inventory_interval_insert_guard()','EXECUTE') AS callable`)).rows[0];
  if (!row?.row_fence || !row.insert_fence || row.callable) throw new Error("inventory_set_publication_schema");
}

async function verifyInventoryMutationStageSchema(database: Pick<pg.Pool, "query">) {
  const row = (await database.query(`SELECT to_regclass('public.inventory_mutation_stages') IS NOT NULL
    AND to_regclass('public.inventory_mutation_targets') IS NOT NULL AS valid`)).rows[0];
  if (!row?.valid) throw new Error("inventory_mutation_stage_schema_invalid");
}

async function verifyInventoryIdentityExpirySchema(database: Pick<pg.Pool, "query">) {
  const row = (await database.query(`SELECT
    (SELECT count(*) FROM information_schema.columns WHERE table_schema='public'
      AND table_name IN ('package_record_rows','power_platform_record_rows','unified_agent_rows','inventory_records')
      AND column_name='identity_expires_at' AND data_type='timestamp with time zone')=4
    AND to_regclass('public.inventory_identity_expiry') IS NOT NULL
    AND position('canonical.identity_expires_at' IN pg_get_viewdef('inventory_live_sources'::regclass))>0 AS valid`)).rows[0];
  if (!row?.valid) throw new Error("inventory_identity_expiry_schema");
}

async function verifyDataLifecycleSchema(database: Pick<pg.Pool, "query">) {
  const row = (await database.query(`SELECT
    (SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='data_lifecycle_progress'
      AND column_name IN ('worker','cursor','slices','rows_collected','bytes_collected','updated_at') AND is_nullable='NO')=6
    AND EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='data_lifecycle_progress'::regclass AND contype='p')
    AND (SELECT count(*) FROM data_lifecycle_progress WHERE worker IN
      ('records','inventory','inventory_metadata','operator','report_payloads','report_staging'))=6
    AND (SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='data_exports'
      AND column_name IN ('idempotency_key','request_hash'))=2
    AND EXISTS(SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname='data_export_idempotency')
    AND EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='export_idempotency_guard' AND NOT tgisinternal) AS valid`)).rows[0];
  if (!row?.valid) throw new Error("data_lifecycle_schema_invalid");
}

async function verifyInventoryDispatchAuthoritySchema(database: Pick<pg.Pool, "query">) {
  const row = (await database.query(`SELECT
    (SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='job_items'
      AND column_name IN ('source_generation_id','source_identity','agent_id','authority_expires_at'))=4
    AND (SELECT count(*) FROM information_schema.columns WHERE table_schema='public'
      AND table_name='inventory_mutation_targets' AND column_name IN ('agent_id','authority_expires_at') AND is_nullable='NO')=2
    AND EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='job_items'::regclass AND conname='job_inventory_authority_complete')
    AND EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='job_items'::regclass
      AND tgname='job_inventory_authority_immutable' AND tgenabled IN ('O','A')) AS valid`)).rows[0];
  if (!row?.valid) throw new Error("inventory_dispatch_authority_schema_invalid");
}

async function verifyInventoryClassificationSchema(database: Pick<pg.Pool, "query">) {
  const row = (await database.query(`SELECT
    (SELECT count(*)=12 FROM information_schema.columns WHERE table_schema='public'
      AND table_name IN ('package_record_rows','power_platform_record_rows','unified_agent_rows')
      AND column_name IN ('presence','link_state','availability','management') AND data_type='text') AS columns,
    (SELECT count(*)=3 AND bool_and(convalidated) FROM pg_constraint
      WHERE conname IN ('package_record_rows_classification','power_platform_record_rows_classification',
        'unified_agent_rows_classification') AND contype='c') AS constraints,
    EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='inventory_facts'::regclass
      AND tgname='inventory_classification_write' AND tgenabled='O'
      AND tgfoid='inventory_classification_fact_guard()'::regprocedure) AS fence`)).rows[0];
  if (!row?.columns || !row.constraints || !row.fence) throw new Error("inventory_classification_schema");
}

async function verifyInventoryCollectionSchema(database: Pick<pg.Pool,"query">) {
  const row = (await database.query(`SELECT
    (SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='inventory_collection_progress'
      AND column_name IN ('scope_id','tenant_id','after_generation','after_identity'))=4
    AND EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid=to_regclass('public.inventory_collection_progress') AND contype='p')
    AND EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid=to_regclass('public.inventory_collection_progress')
      AND contype='f' AND confrelid=to_regclass('public.data_scope_epochs') AND confdeltype='c' AND conkey=ARRAY[1,2]::smallint[])
    AND has_table_privilege(current_user,'inventory_collection_progress','SELECT')
    AND has_table_privilege(current_user,'inventory_collection_progress','INSERT')
    AND has_table_privilege(current_user,'inventory_collection_progress','UPDATE')
    AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('public.inventory_keys')
      AND attname='identity' AND NOT attisdropped AND attcollation='"C"'::regcollation)
    AND 3=(SELECT count(*) FROM pg_index i WHERE i.indisvalid AND i.indisready AND (
      i.indexrelid=to_regclass('public.inventory_keys_collection')
        AND pg_get_indexdef(i.indexrelid) LIKE '%ON public.inventory_keys USING btree (scope_id, generation_id, identity)%'
        AND i.indcollation[2]='"C"'::regcollation
      OR i.indexrelid=to_regclass('public.unified_member_generation_source')
        AND pg_get_indexdef(i.indexrelid) LIKE '%ON public.unified_agent_memberships USING btree (source_generation_id, source_identity)%'
      OR i.indexrelid=to_regclass('public.inventory_compaction_source')
        AND pg_get_indexdef(i.indexrelid) LIKE '%ON public.inventory_compaction_refs USING btree (source_generation_id, identity)%')) AS valid`)).rows[0];
  if (!row?.valid) throw new Error("Inventory collection progress, key collation or indexes are invalid.");
}

async function verifyInventoryProviderSchema(database: Pick<pg.Pool, "query">) {
  const rows = (await database.query(`SELECT table_name,column_name,data_type,is_nullable
    FROM information_schema.columns WHERE table_schema='public' AND
      (table_name='inventory_attempts' AND column_name='omitted_fields'
      OR table_name='inventory_roots' AND column_name IN ('catalog_page_count','catalog_omitted_fields'))
    ORDER BY table_name,column_name`)).rows;
  if (rows.length !== 3 || rows.some(row => row.data_type !== "integer" || row.is_nullable !== "NO")) {
    throw new Error("inventory_provider_schema");
  }
}

async function verifyInventoryIdentitySchema(database: Pick<pg.Pool, "query">) {
  const row = (await database.query(`SELECT
    to_regclass('public.inventory_live_sources') IS NOT NULL AS live_sources,
    EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='agent_identity_cache'::regclass
      AND confrelid='data_generations'::regclass AND conname='agent_identity_cache_generation') AS generation_reference,
    NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='agent_identity_cache'::regclass
      AND confrelid=to_regclass('public.power_platform_inventory_snapshots')) AS retired_reference,
    EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='agent_identity_cache'::regclass
      AND tgname='protect_inventory_identity_cache' AND tgenabled IN ('O','A')) AS live_guard`)).rows[0];
  if (!["live_sources", "generation_reference", "retired_reference", "live_guard"]
    .every(key => row?.[key] === true)) throw new Error("inventory_identity_schema");
}

const userSourceTables = [
  "user_source_attempts", "user_source_queries", "user_source_query_members", "user_source_skus",
  "user_source_identity_inputs", "user_source_read_contexts",
] as const;

async function verifyUserSourceSchema(database: Pick<pg.Pool, "query">) {
  const definitions: Record<string, string> = {
    user_source_attempts: "generation_id:uuid scope_id:uuid tenant_id:text source:text status:text error_code:text? message:text? observed_count:int4? report_refresh_date:date? report_period:text",
    user_source_queries: "generation_id:uuid scope_id:uuid tenant_id:text query_key:text kind:text expected_count:int4? wire_count:int4 page_count:int4 complete:bool",
    user_source_query_members: "generation_id:uuid query_key:text identity:text",
    user_source_skus: "generation_id:uuid scope_id:uuid tenant_id:text sku_id:uuid plan_ids:_text",
    user_source_identity_inputs: "generation_id:uuid scope_id:uuid tenant_id:text identity:text checked:bool",
    user_source_read_contexts: "selection_id:uuid tenant_id:text token_mode:text metadata:jsonb",
  };
  const columns = Object.entries(definitions).flatMap(([table, fields]) => fields.split(" ").map(field => {
    const [name, type] = field.split(":");
    return { table, name, type: type.replace("?", ""), nullable: type.endsWith("?") ? "YES" : "NO" };
  }));
  const result = await database.query(`SELECT (SELECT count(*)=6 FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind='r' AND relname=ANY($1))
    AND (SELECT count(*)=6 FROM pg_constraint WHERE contype='f' AND conrelid IN
      (SELECT oid FROM pg_class WHERE relnamespace='public'::regnamespace AND relname=ANY($1)))
    AND (SELECT count(*)=5 FROM pg_trigger WHERE tgname='user_source_fence' AND NOT tgisinternal AND tgenabled IN ('O','A'))
    AND (SELECT count(*)=5 FROM pg_indexes WHERE schemaname='public' AND indexname IN
      ('user_source_attempt_scope','user_source_identity_pending','directory_user_entitlement','directory_user_upn_order','user_source_generation_attempt'))
    AND (SELECT count(*)=jsonb_array_length($2::jsonb) FROM information_schema.columns c
      JOIN jsonb_to_recordset($2::jsonb) expected("table" text,name text,type text,nullable text)
        ON c.table_schema='public' AND c.table_name=expected."table" AND c.column_name=expected.name
          AND c.udt_name=expected.type AND c.is_nullable=expected.nullable)
    AND (SELECT count(*)=jsonb_array_length($2::jsonb) FROM information_schema.columns WHERE table_schema='public' AND table_name=ANY($1))
    AND EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='data_generation_pins'::regclass
      AND conname='data_generation_pins_root_kind_check' AND pg_get_constraintdef(oid) LIKE '%user_sources%')
    AND (current_user<>'agentcontrol_app' OR (
      has_table_privilege(current_user,'user_source_attempts','SELECT,INSERT,UPDATE,DELETE')
      AND has_table_privilege(current_user,'user_source_skus','SELECT,INSERT,DELETE')
      AND NOT has_table_privilege(current_user,'user_source_skus','UPDATE,TRUNCATE')
      AND NOT has_any_column_privilege(current_user,'user_source_read_contexts','UPDATE')
      AND (SELECT bool_and(has_table_privilege(current_user,name,'SELECT,INSERT,DELETE')
        AND NOT has_table_privilege(current_user,name,'TRUNCATE')) FROM unnest($1::text[]) tables(name))
    )) AS valid`, [userSourceTables, JSON.stringify(columns)]);
  if (!result.rows[0]?.valid) throw new Error("User source schema or runtime grants are invalid.");
}

const definitions = [
  ["users", "COALESCE(NULLIF(display_name,''),username)"],
  ["agents", "agent_name"],
  ["userAgents", "agent_name"],
] as const;

async function verifyOfficialReportPageSchema(database: Pick<pg.Pool, "query">) {
  for (const [kind, name] of definitions) {
    const row = (await database.query(`SELECT i.indisvalid AND i.indisready AND i.indnatts=3
      AND i.indrelid='official_usage_row_facts'::regclass
      AND i.indkey[0]=(SELECT attnum FROM pg_attribute WHERE attrelid=i.indrelid AND attname='tenant_id')
      AND i.indkey[2]=(SELECT attnum FROM pg_attribute WHERE attrelid=i.indrelid AND attname='payload_hash')
      AND (SELECT collname FROM pg_collation WHERE oid=i.indcollation[1])='C' AS valid,
      pg_get_expr(i.indpred,i.indrelid) AS predicate,pg_get_indexdef(i.indexrelid,2,true) AS expression
      FROM pg_index i WHERE i.indexrelid=to_regclass($1)`, [`public.official_usage_${kind.toLowerCase()}_name_page`])).rows[0];
    const expression = String(row?.expression ?? "").replace(/["\s]/g,"").toLowerCase();
    const predicate = String(row?.predicate ?? "").replace(/[()\s]/g,"").replace(/::text/g,"");
    if (!row?.valid || predicate !== `kind='${kind}'`
      || !expression.includes("left(lower(normalize(") || !expression.includes(",128)")
      || !expression.includes(name.includes("display_name") ? "display_name" : "agent_name")) {
      throw new Error("official_report_page_schema");
    }
  }
}

async function verifyJobPagesSchema(database: Pick<pg.Pool, "query">) {
  const result = await database.query(`SELECT
    EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='jobs'
      AND column_name='result_revision' AND data_type='bigint' AND is_nullable='NO') AS revision,
    (SELECT count(*)::int FROM pg_trigger WHERE tgrelid='job_items'::regclass AND NOT tgisinternal
      AND tgenabled='O' AND tgname IN ('job_results_insert','job_results_update','job_results_delete')) AS triggers`);
  if (!result.rows[0]?.revision || result.rows[0]?.triggers !== 3) throw new Error("job_pages_schema_required");
}

async function verifyInventoryClearSchema(database: Pick<pg.Pool, "query">) {
  const definition = (await database.query("SELECT pg_get_functiondef('clear_admitted_data_sync_snapshots'::regproc) AS definition")).rows[0]?.definition;
  if (!definition?.includes("inventory_native_control_pending") || !definition.includes("published_sequence=pending_sequence")
    || !definition.includes("generation_id=NULL,revision=revision+1")) throw new Error("inventory_clear_schema_invalid");
}

async function verifyInventoryAttemptSchema(database: Pick<pg.Pool, "query">) {
  if (!(await database.query(`SELECT 1 FROM pg_trigger
    WHERE tgrelid='inventory_attempts'::regclass AND tgname='inventory_attempt_guard'
      AND tgfoid='protect_inventory_attempt()'::regprocedure AND NOT tgisinternal AND tgenabled='O'`)).rowCount) {
    throw new Error("inventory_attempt_schema");
  }
}

async function verifyInventorySummaryAccessSchema(database: Pick<pg.Pool,"query">) {
  const row = (await database.query(`SELECT count(*)=2 AND 6=(
    SELECT count(*) FROM pg_index display WHERE display.indisvalid AND display.indisready
      AND display.indexrelid IN (
        to_regclass('public.package_record_rows_short_display'),to_regclass('public.package_record_rows_long_display'),
        to_regclass('public.power_platform_record_rows_short_display'),to_regclass('public.power_platform_record_rows_long_display'),
        to_regclass('public.unified_agent_rows_short_display'),to_regclass('public.unified_agent_rows_long_display'))
      AND (pg_get_expr(display.indpred,display.indrelid)='(length(sort_key) <= 64)'
        OR pg_get_expr(display.indpred,display.indrelid)='(length(sort_key) > 64)')) AS valid FROM pg_index i
    WHERE i.indisvalid AND i.indisready
      AND pg_get_indexdef(i.indexrelid) LIKE '%USING btree (generation_id, identity) WHERE %' AND (
        i.indexrelid=to_regclass('public.inventory_available_sources')
          AND i.indrelid='public.package_record_rows'::regclass
          AND pg_get_expr(i.indpred,i.indrelid)='(availability = ''available''::text)'
        OR i.indexrelid=to_regclass('public.inventory_teams_sources')
          AND i.indrelid='public.inventory_facts'::regclass
          AND pg_get_expr(i.indpred,i.indrelid) LIKE '%kind = ''host''%lower(btrim(value))%teams%')`)).rows[0];
  if (!row?.valid) throw new Error("Inventory summary access indexes are missing or invalid.");
}

async function verifyInventoryRefreshContractSchema(database: Pick<pg.Pool, "query">) {
  const result = (await database.query(`SELECT
    NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='package_refresh_jobs'::regclass
      AND attname='catalog_only' AND NOT attisdropped) AS retired_mode,
    EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='package_refresh_jobs'::regclass
      AND conname='inventory_refresh_job_mode' AND convalidated) AS bounded_detail_mode`)).rows[0];
  if (!result?.retired_mode || !result.bounded_detail_mode) throw new Error("inventory_refresh_contract_schema");
}

async function verifyOfficialReportSchema(database: Pick<pg.Pool, "query">) {
  const result = await database.query(`SELECT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='official_usage_row_facts'
      AND column_name='responses' AND data_type='bigint')
    AND (SELECT count(*)=5 FROM pg_indexes WHERE schemaname='public' AND indexname IN
      ('official_usage_fact_identity','official_usage_fact_agent','official_usage_fact_responses','official_usage_history_open','official_usage_history_read'))
    AND (SELECT count(*)=4 FROM pg_trigger WHERE tgname IN ('official_history_membership_guard','official_history_state_guard','official_upload_row_guard','official_upload_intent_guard') AND tgenabled IN ('O','A'))
    AND (SELECT count(*)=5 FROM information_schema.tables WHERE table_schema='public' AND table_name IN(
      'official_usage_history_state','official_usage_history_memberships','official_usage_ingestions','official_usage_ingestion_rows','official_usage_read_contexts'))
    AND (SELECT count(*)=2 FROM pg_constraint WHERE conname IN ('official_usage_typed_fact','official_usage_typed_payload') AND convalidated)
    AND has_table_privilege(current_user,'official_usage_history_memberships','SELECT,INSERT,UPDATE,DELETE')
    AND has_table_privilege(current_user,'official_usage_ingestion_rows','SELECT,INSERT,DELETE')
    AND (current_user<>'agentcontrol_app' OR NOT has_any_column_privilege(current_user,'official_usage_read_contexts','UPDATE'))
    AS valid`);
  if (!result.rows[0]?.valid) throw new Error("Official report schema is invalid.");
}

async function verifyInventoryAuditSelectionSchema(database: Pick<pg.Pool, "query">) {
  const definition = (await database.query(`SELECT pg_get_functiondef('inventory_invalidate_audit_reads()'::regprocedure) AS definition`)).rows[0]?.definition;
  if (!definition?.includes("starts_with(lower(a.operation_id),lower(s.query_json->>'operationIdPrefix'))")
    || !definition.includes("a.observed_at<=s.evaluated_at")) throw new Error("inventory_audit_selection_schema");
}

async function verifyInventoryEnvironmentProjectionSchema(database: Pick<pg.Pool, "query">) {
  const definition = (await database.query(`SELECT indexdef FROM pg_indexes
    WHERE schemaname='public' AND indexname='inventory_environment_lookup'`)).rows[0]?.indexdef;
  if (!definition?.includes("(lower(native_id), generation_id, identity)")
    || !definition.includes("power_platform_record_rows")
    || !definition.includes("WHERE (resource_type = 'microsoft.powerplatform/environments'::text)")) {
    throw new Error("inventory_environment_projection_schema");
  }
}

async function verifyInventorySummaryAggregateSchema(database: Pick<pg.Pool,"query">) {
  const row = (await database.query(`SELECT i.indisvalid AND i.indisready AND i.indnatts=4
    AND i.indrelid='inventory_facts'::regclass
    AND pg_get_indexdef(i.indexrelid) LIKE '%USING btree (scope_id, generation_id, identity, kind) WHERE %'
    AND pg_get_expr(i.indpred,i.indrelid)='(kind = ANY (ARRAY[''relevance''::text, ''blocked''::text]))' AS valid
    FROM pg_index i WHERE i.indexrelid=to_regclass('public.inventory_summary_kinds')`)).rows[0];
  if (!row?.valid) throw new Error("inventory_summary_aggregate_schema");
}

async function verifyUserReportPageSchema(database: Pick<pg.Pool, "query">) {
  const row = (await database.query(`SELECT i.indisvalid AND i.indisready AND i.indnatts=3
    AND i.indrelid='directory_user_rows'::regclass
    AND replace(pg_get_indexdef(i.indexrelid),'"','') ILIKE '%USING btree (generation_id,%lower(%normalize(%display_name%upn%identity%'
    AND pg_get_indexdef(i.indexrelid) LIKE '%NFKC%'
    AND i.indcollation[1]='pg_catalog."C"'::regcollation AND i.indcollation[2]='pg_catalog."C"'::regcollation AS valid,
    pg_get_indexdef(i.indexrelid) AS definition
    FROM pg_index i WHERE i.indexrelid=to_regclass('public.directory_report_name_order')`)).rows[0];
  if (!row?.valid) throw new Error(`user_report_page_schema: ${JSON.stringify(row ?? null).slice(0, 4096)}`);
}

async function verifyInventoryRefreshTargetsSchema(database: Pick<pg.Pool, "query">) {
  const result = await database.query(`SELECT to_regclass('inventory_refresh_targets') IS NOT NULL AS targets,
    EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='inventory_attempts'::regclass
      AND attname='target_job_id' AND NOT attisdropped) AS target_job,
    NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='package_refresh_jobs'::regclass
      AND attname IN ('requested_ids','detail_targets') AND NOT attisdropped) AS retired_arrays,
    EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='package_refresh_jobs'::regclass
      AND attname='auto_details' AND NOT attisdropped) AS detail_metadata,
    NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='package_refresh_jobs'::regclass
      AND tgname IN ('reconcile_package_detail_cache','backoff_package_detail_job')) AS retired_triggers,
    current_user<>'agentcontrol_app' OR (has_table_privilege(current_user,'inventory_refresh_targets','SELECT,INSERT,UPDATE,DELETE')
      AND NOT has_table_privilege(current_user,'inventory_refresh_targets','TRUNCATE')) AS permissions`);
  if (!["targets", "target_job", "retired_arrays", "detail_metadata", "retired_triggers", "permissions"]
    .every(key => result.rows[0]?.[key] === true)) throw new Error("inventory_refresh_targets_schema");
}

async function verifyInventoryAuthoritySchema(database: Pick<pg.Pool, "query">) {
  const result = await database.query(`SELECT
    position('public.inventory_roots' IN pg_get_functiondef('protect_agent_usage_association()'::regprocedure))>0 AS current_memberships,
    position('public.unified_agent_sources' IN pg_get_functiondef('protect_agent_usage_association()'::regprocedure))=0 AS retired_registry,
    EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='capability_configuration'::regclass
      AND tgname='fence_inventory_application_configuration' AND tgenabled IN ('O','A')) AS application_fence`);
  if (!["current_memberships", "retired_registry", "application_fence"]
    .every(key => result.rows[0]?.[key] === true)) throw new Error("inventory_authority_schema");
}

async function verifyInventoryPeopleProjectionSchema(database: Pick<pg.Pool, "query">) {
  const definition = (await database.query(`SELECT indexdef FROM pg_indexes
    WHERE schemaname='public' AND indexname='inventory_fact_people'`)).rows[0]?.indexdef;
  if (!definition?.includes("(generation_id, identity, kind)")
    || !["person:owner", "person:createdBy", "person:lastModifiedBy"].every(kind => definition.includes(kind))) {
    throw new Error("inventory_people_projection_schema");
  }
}

async function verifyInventoryDetailAdmissionSchema(database: Pick<pg.Pool, "query">) {
  const row = (await database.query(`SELECT EXISTS(SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='inventory_refresh_targets' AND column_name='catalog_revision_hash'
      AND data_type='text') AND EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='inventory_refresh_targets'::regclass
        AND tgname='inventory_detail_target_revision' AND tgenabled='O') AS valid`)).rows[0];
  if (!row?.valid) throw new Error("inventory_detail_admission_schema");
}

async function verifyInventoryObserverSchema(database: Pick<pg.Pool, "query">) {
  const row = (await database.query(`SELECT to_regclass('public.inventory_people_revisions') IS NOT NULL AS counter,
    (SELECT count(*)::int FROM pg_trigger WHERE NOT tgisinternal AND tgenabled IN ('O','A')
      AND tgrelid='public.agent_people_cache'::regclass
      AND tgname IN ('inventory_observe_people_insert','inventory_observe_people_update','inventory_observe_people_delete')) AS guards`)).rows[0];
  if (!row?.counter || row.guards !== 3) throw new Error("inventory_observer_schema_invalid");
}

async function verifyUsersReportsCutoverSchema(database: Pick<pg.Pool, "query">) {
  const row = (await database.query(`SELECT to_regclass('public.copilot_usage_snapshots') AS snapshots,
    to_regclass('public.copilot_usage_source_state') AS sources,
    to_regclass('public.official_usage_row_facts_observed') AS fact_index,
    EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='data_exports' AND column_name='actor' AND data_type='jsonb') AS actor,
    EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='official_usage_ingestions'
      AND column_name='acceptance_revision' AND data_type='bigint') AS acceptance,
    EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='data_generations'
      AND column_name='collected_at' AND data_type='timestamp with time zone') AS collection,
    position('data_generation_not_collected' IN pg_get_functiondef('data_protect_generation()'::regprocedure))>0
      AND position('data_generation_collection_immutable' IN pg_get_functiondef('data_protect_generation()'::regprocedure))>0 AS collection_guard,
    (SELECT count(*)::int FROM pg_trigger WHERE NOT tgisinternal AND tgenabled IN ('O','A') AND
      (tgrelid='public.agent_people_cache'::regclass AND tgname IN ('invalidate_user_people_insert','invalidate_user_people_update','invalidate_user_people_delete','preserve_user_people_identity')
      OR tgrelid='public.data_exports'::regclass AND tgname='data_export_actor_guard'
      OR tgrelid='public.official_usage_ingestions'::regclass AND tgname='official_acceptance_receipt_guard')) AS guards`)).rows[0];
  if (!row || row.snapshots || row.sources || row.fact_index || !row.actor || !row.acceptance || !row.collection || !row.collection_guard || row.guards !== 6) {
    throw new Error("users_reports_cutover_schema_required");
  }
}

async function verifyInventoryControlQueueSchema(database: Pick<pg.Pool, "query">) {
  const row = (await database.query(`SELECT to_regclass('public.inventory_control_pending') IS NOT NULL
    AND EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='inventory_control_fence' AND NOT tgisinternal) AS valid`)).rows[0];
  if (!row?.valid) throw new Error("inventory_control_queue_schema_invalid");
}

const dataTables = [
  "data_principal_epochs", "data_scope_epochs", "data_generations", "data_generation_heads", "data_generation_batches", "data_generation_pages",
  "directory_user_rows", "directory_service_plan_rows", "app_activity_rows",
  "data_read_selections", "data_generation_pins", "data_exports", "data_export_items", "data_export_chunks",
] as const;

async function verifyDataGenerationSchema(database: Pick<pg.Pool, "query">) {
  const result = await database.query<{ valid: boolean }>(`SELECT (SELECT count(*)=14 FROM pg_class WHERE relnamespace='public'::regnamespace AND relname=ANY($1))
    AND (SELECT count(*)=13 FROM pg_trigger WHERE NOT tgisinternal AND tgname IN ('data_immutable','data_generation_intent','data_head_fence','data_export_intent','data_epoch_guard','data_selection_intent') AND tgenabled IN ('O','A'))
    AND (SELECT count(*)=14 FROM pg_constraint WHERE contype='f' AND conrelid IN
      (SELECT oid FROM pg_class WHERE relnamespace='public'::regnamespace AND relname=ANY($1)))
    AND EXISTS(SELECT 1 FROM pg_index WHERE indrelid='data_scope_epochs'::regclass AND indnullsnotdistinct)
    AND strpos(pg_get_functiondef('data_protect_head()'::regprocedure),'g.expires_at>clock_timestamp()')=0
    AND strpos(pg_get_functiondef('inventory_interval_guard()'::regprocedure),'input."expiresAt">clock_timestamp()')=0
    AND strpos(pg_get_functiondef('inventory_revision_guard()'::regprocedure),'input."expiresAt">clock_timestamp()')=0
    AND (SELECT count(*)=12 FROM pg_indexes WHERE schemaname='public' AND indexname IN
      ('data_one_writer','data_generation_admission','data_generation_expiry','directory_user_order','directory_user_upn',
       'directory_user_company','directory_user_department','directory_plan_user','app_activity_identity',
       'data_selection_admission','data_pin_reachability','data_export_admission'))
    AND (current_user<>'agentcontrol_app' OR (
      NOT has_table_privilege(current_user,'directory_user_rows','UPDATE,TRUNCATE')
      AND has_table_privilege(current_user,'directory_user_rows','SELECT,INSERT,DELETE')
      AND NOT has_table_privilege(current_user,'data_export_chunks','UPDATE,TRUNCATE')
      AND NOT has_any_column_privilege(current_user,'directory_user_rows','UPDATE')
      AND NOT has_table_privilege(current_user,'data_export_items','UPDATE,TRUNCATE')
    )) AS valid`, [dataTables]);
  if (!result.rows[0]?.valid) throw new Error("Data generation schema or runtime grants are invalid.");
}

const children = [
  { table: "directory_service_plan_rows", rowTrigger: "data_immutable", rowFunction: "data_protect_record", inventory: false },
  { table: "inventory_facts", rowTrigger: "inventory_immutable", rowFunction: "inventory_content_guard", inventory: true },
] as const;

async function verifyChildInsertFenceSchema(database: Pick<pg.Pool,"query">) {
  const rows = (await database.query(`SELECT relation,
    EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid=to_regclass('public.'||relation)
      AND t.tgname='child_insert_fence' AND t.tgtype=4 AND t.tgenabled='O'
      AND t.tgnewtable='inserted_children'
      AND t.tgfoid=to_regprocedure('public.'||relation||'_insert_guard()')) AS inserted,
    EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid=to_regclass('public.'||relation)
      AND t.tgname=row_trigger AND t.tgtype=27 AND t.tgenabled='O'
      AND t.tgfoid=to_regprocedure('public.'||row_function||'()')) AS immutable,
    has_function_privilege('agentcontrol_app','public.'||relation||'_insert_guard()','EXECUTE') AS callable
    FROM unnest($1::text[],$2::text[],$3::text[]) expected(relation,row_trigger,row_function)`,
  [children.map(value => value.table),children.map(value => value.rowTrigger),children.map(value => value.rowFunction)])).rows;
  if (rows.length!==children.length || rows.some(row => row.inserted!==true || row.immutable!==true || row.callable!==false)) {
    throw new Error("data_child_insert_fence_schema");
  }
}
