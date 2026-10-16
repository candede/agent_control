import type pg from "pg";

export async function verifyPrincipalBearerFenceSchema(database: Pick<pg.Pool, "query">) {
  const row = (await database.query<{ valid: boolean }>(`SELECT
    EXISTS(SELECT 1 FROM pg_attribute a JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
      WHERE a.attrelid='public.data_principal_epochs'::regclass AND a.attname='bearer_issued_after'
        AND a.atttypid='bigint'::regtype AND a.attnotnull AND NOT a.attisdropped
        AND pg_get_expr(d.adbin,d.adrelid)='0')
    AND EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.data_principal_epochs'::regclass
      AND conname='data_principal_epochs_bearer_issued_after_check' AND contype='c' AND convalidated
      AND pg_get_expr(conbin,conrelid)='(bearer_issued_after >= 0)')
    AND (current_user<>'agentcontrol_app' OR (
      has_table_privilege(current_user,'data_principal_epochs','SELECT')
      AND has_table_privilege(current_user,'data_principal_epochs','INSERT')
      AND has_table_privilege(current_user,'data_principal_epochs','UPDATE')
      AND NOT has_table_privilege(current_user,'data_principal_epochs','DELETE,TRUNCATE')
    )) AS valid`)).rows[0];
  if (row?.valid !== true) throw new Error("principal_bearer_fence_schema_invalid");
}
