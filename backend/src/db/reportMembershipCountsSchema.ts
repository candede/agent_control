import type pg from "pg";

export async function verifyReportMembershipCountsSchema(database: Pick<pg.Pool,"query">) {
  const row = (await database.query(`SELECT
    (SELECT count(*)=4 FROM pg_attribute WHERE attrelid='official_usage_membership_counts'::regclass
      AND attnotnull AND NOT attisdropped AND (
        attname='version_id' AND atttypid='uuid'::regtype OR attname IN ('tenant_id','kind') AND atttypid='text'::regtype
        OR attname='row_count' AND atttypid='bigint'::regtype)) AS columns,
    EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='official_usage_membership_counts'::regclass
      AND contype='p' AND pg_get_constraintdef(oid)='PRIMARY KEY (version_id)') AS keyed,
    EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='official_usage_membership_counts'::regclass
      AND confrelid='official_usage_versions'::regclass AND contype='f' AND convalidated
      AND pg_get_constraintdef(oid)='FOREIGN KEY (version_id, tenant_id, kind) REFERENCES official_usage_versions(id, tenant_id, kind) ON DELETE CASCADE') AS scoped,
    (has_table_privilege('agentcontrol_app','official_usage_membership_counts','SELECT')
      AND NOT has_table_privilege('agentcontrol_app','official_usage_membership_counts','INSERT,UPDATE,DELETE,TRUNCATE')
      AND NOT has_any_column_privilege('agentcontrol_app','official_usage_membership_counts','INSERT,UPDATE')) AS protected,
    (SELECT count(*)=3 FROM pg_trigger WHERE tgrelid='official_usage_version_rows'::regclass
      AND tgfoid=to_regprocedure('official_usage_membership_count()') AND tgenabled='O' AND (
        tgname='official_membership_count_insert' AND tgtype=4 AND tgnewtable='inserted_memberships' AND tgoldtable IS NULL
        OR tgname='official_membership_count_delete' AND tgtype=8 AND tgoldtable='deleted_memberships' AND tgnewtable IS NULL
        OR tgname='official_membership_count_update' AND tgtype=16 AND tgoldtable='deleted_memberships' AND tgnewtable='inserted_memberships')) AS maintained,
    has_function_privilege('agentcontrol_app','official_usage_membership_count()','EXECUTE') AS callable`)).rows[0];
  if (!row?.columns || !row.keyed || !row.scoped || !row.protected || !row.maintained || row.callable) {
    throw new Error("official_membership_count_schema");
  }
}

export async function verifyReportMembershipCounts(database: Pick<pg.Pool,"query">) {
  const row = (await database.query(`WITH observed AS (
    SELECT version_id,count(*) AS row_count FROM official_usage_version_rows GROUP BY version_id
  ) SELECT count(*)::int AS mismatches FROM official_usage_versions version
    LEFT JOIN official_usage_membership_counts tracked ON tracked.version_id=version.id
    LEFT JOIN observed ON observed.version_id=version.id
    WHERE COALESCE(tracked.row_count,0)<>COALESCE(observed.row_count,0)`)).rows[0];
  if (row?.mismatches!==0) throw new Error("official_membership_count_mismatch");
}
