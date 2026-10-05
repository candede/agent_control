import type pg from "pg";

export async function verifyDataGenerationAccountingSchema(database: Pick<pg.Pool,"query">) {
  const row = (await database.query(`SELECT
    EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='data_generation_charges'::regclass
      AND attname='generation_bytes' AND atttypid='bigint'::regtype AND attnotnull AND NOT attisdropped) AS charge,
    (NOT has_table_privilege('agentcontrol_app','data_generation_charges','INSERT,UPDATE,DELETE,TRUNCATE')
      AND NOT has_any_column_privilege('agentcontrol_app','data_generation_charges','INSERT,UPDATE')) AS protected,
    EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='data_generations'::regclass
      AND tgname='data_generation_charge' AND tgtype=29 AND tgenabled='O'
      AND tgfoid=to_regprocedure('data_update_generation_charge()')) AS maintained,
    EXISTS(SELECT 1 FROM pg_index WHERE indexrelid=to_regclass('data_generation_active_admission')
      AND indrelid='data_generations'::regclass AND indisvalid AND indisready AND indpred IS NOT NULL) AS indexed,
    EXISTS(SELECT 1 FROM pg_index WHERE indexrelid=to_regclass('data_generation_tenant_charges')
      AND indrelid='data_generation_charges'::regclass AND indisvalid AND indisready AND indpred IS NOT NULL) AS scoped,
    has_function_privilege('agentcontrol_app','data_update_generation_charge()','EXECUTE') AS callable`)).rows[0];
  if (!row?.charge || !row.protected || !row.maintained || !row.indexed || !row.scoped || row.callable) throw new Error("data_generation_accounting_schema");
}

export async function verifyDataGenerationCharges(database: Pick<pg.Pool, "query">) {
  const row = (await database.query(`SELECT count(*)::int AS mismatches FROM data_scope_epochs scope
    LEFT JOIN data_generation_charges charge ON charge.scope_id=scope.id AND charge.tenant_id=scope.tenant_id
    LEFT JOIN (SELECT scope_id,sum(CASE WHEN collected_at IS NOT NULL THEN 0
      WHEN state IN ('staging','validating') THEN reserved_bytes ELSE byte_count END) AS bytes
      FROM data_generations GROUP BY scope_id) actual ON actual.scope_id=scope.id
    WHERE COALESCE(charge.generation_bytes,0)<>COALESCE(actual.bytes,0)`)).rows[0];
  if (row?.mismatches !== 0) throw new Error("data_generation_charge_mismatch");
}
