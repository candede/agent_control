import type pg from "pg";

export const inventoryReconciliationAdmissionSql = `SELECT count(*)::int AS count FROM inventory_reconciliation
  WHERE tenant_id=$1 AND scope_id<>$2 AND (active_id IS NOT NULL AND active_until>clock_timestamp() AND active_deadline>clock_timestamp()
    OR pending_inputs IS NOT NULL AND pending_deadline>clock_timestamp() AND NOT EXISTS(
      SELECT 1 FROM jsonb_to_recordset(pending_inputs) input("scopeId" uuid,epoch bigint,"expiresAt" timestamptz)
      LEFT JOIN data_scope_epochs s ON s.id=input."scopeId" WHERE s.epoch IS DISTINCT FROM input.epoch OR input."expiresAt"<=clock_timestamp()))`;

export async function verifyInventoryReconciliationAdmissionSchema(database: Pick<pg.Pool, "query">) {
  const row = (await database.query(`SELECT i.indisvalid AND i.indisready AND i.indnatts=1
    AND i.indrelid='inventory_reconciliation'::regclass
    AND (SELECT am.amname FROM pg_class c JOIN pg_am am ON am.oid=c.relam WHERE c.oid=i.indexrelid)='btree'
    AND i.indkey[0]=(SELECT attnum FROM pg_attribute WHERE attrelid=i.indrelid AND attname='tenant_id')
    AND regexp_replace(lower(pg_get_expr(i.indpred,i.indrelid)),'[()]','','g')
      ='active_id is not null or pending_inputs is not null' AS valid
    FROM pg_index i WHERE i.indexrelid=to_regclass('public.inventory_reconciliation_tenant_admission')`)).rows[0];
  if (!row?.valid) throw new Error("inventory_reconciliation_admission_schema");
}
