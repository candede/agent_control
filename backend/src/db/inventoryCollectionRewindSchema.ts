import type pg from "pg";

export const inventoryReferenceColumns = [
  { table: "inventory_memberships", generation: "generation_id", identity: "identity" },
  { table: "unified_agent_memberships", generation: "source_generation_id", identity: "source_identity" },
  { table: "inventory_compaction_refs", generation: "source_generation_id", identity: "identity" },
  { table: "inventory_exact_heads", generation: "generation_id", identity: "identity" },
] as const;

export async function verifyInventoryCollectionRewindSchema(database: Pick<pg.Pool,"query">) {
  const column = (await database.query(`SELECT a.attnotnull AND a.atttypid='boolean'::regtype AS valid
    FROM pg_attribute a WHERE a.attrelid='inventory_collection_progress'::regclass
      AND a.attname='after_inclusive' AND NOT a.attisdropped`)).rows[0];
  if (!column?.valid) throw new Error("inventory_collection_rewind_schema");
  const triggers: { table: string;operation: string;name: string }[] = inventoryReferenceColumns.flatMap(({ table }) => ["delete","update"].map(operation => ({
    table,operation,name: `ac_${table}_${operation}_rewind`,
  })));
  triggers.push({ table: "data_generations",operation: "update",name: "ac_inventory_generation_collectable_rewind" });
  for (const { table,operation,name } of triggers) {
    const trigger = (await database.query(`SELECT t.tgenabled='O' AND NOT t.tgisinternal AND t.tgtype=$3
      AND t.tgoldtable='old_rows' AND (CASE WHEN $3=16 THEN t.tgnewtable='new_rows' ELSE t.tgnewtable IS NULL END)
      AND t.tgfoid=to_regprocedure($4) AS valid FROM pg_trigger t
      WHERE t.tgrelid=to_regclass($1) AND t.tgname=$2`,[`public.${table}`,name,operation==="delete" ? 8 : 16,`public.${name}()`])).rows[0];
    if (!trigger?.valid) throw new Error("inventory_collection_rewind_schema");
  }
}
