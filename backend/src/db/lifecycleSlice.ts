import type pg from "pg";
import { observeDataWork } from "../services/dataMetrics.js";
import { inventoryReferenceColumns } from "./inventoryCollectionRewindSchema.js";

export const lifecycleLimits = { rows: 1000, bytes: 1_048_576, milliseconds: 5000 } as const;

/** One transaction's shared budget, including metadata writes. No payload is returned to Node. */
export class LifecycleSlice {
  readonly startedAt = performance.now();
  rows = 1;
  bytes = 512;
  private step = 0;
  private resume = 0;
  private next = 0;
  private stopped = false;
  constructor(readonly client: pg.PoolClient, private readonly limit: number, private readonly worker = "records") {}

  async open() {
    await this.client.query("SET LOCAL transaction_timeout='5s'; SET LOCAL statement_timeout='5s'");
    const progress = (await this.client.query(
      "SELECT cursor->>'step' AS step FROM data_lifecycle_progress WHERE worker=$1 FOR UPDATE", [this.worker])).rows[0];
    if (!progress) throw new Error("lifecycle_progress_missing");
    this.resume = Number(progress.step ?? 0);
  }
  reserve(rows: number, bytes: number) {
    const step = this.step++;
    if (step < this.resume || this.stopped) return false;
    if (this.rows + rows > lifecycleLimits.rows || this.bytes + bytes > lifecycleLimits.bytes
      || performance.now() - this.startedAt > 3500) {
      this.stopped = true; this.next = step; return false;
    }
    this.rows += rows; this.bytes += bytes;
    return true;
  }
  async change(name: string, table: string, where: string, values?: string, parameters: unknown[] = [],
    orderBy: "ctid" | "ordinal" | "worker_id" | "revision" | "sequence" = "ctid", scopeCharge?: "reservation" | "collection") {
    if (scopeCharge && (table !== "data_generations" || !values)) throw new Error("lifecycle_scope_charge");
    const step = this.step++;
    if (step < this.resume || this.stopped) return 0;
    const time = lifecycleLimits.milliseconds - Math.ceil(performance.now() - this.startedAt);
    if (time < 100 || this.rows >= lifecycleLimits.rows || this.bytes >= lifecycleLimits.bytes) {
      this.stopped = true; this.next = step; return 0;
    }
    await this.client.query("SELECT set_config('statement_timeout',$1,true)", [`${time}ms`]);
    const reference = inventoryReferenceColumns.find(value => value.table === table);
    const cursorWrites = Boolean(reference) || table === "data_generations" && Boolean(values);
    const cursorGeneration = reference ? `target.${reference.generation}` : "target.id";
    const cursorIdentity = reference ? `target.${reference.identity}` : "reference_scope.identity";
    if (cursorWrites) await this.client.query(`SELECT set_config('agent_control.inventory_gc_cursor_rows','0',true),
      set_config('agent_control.inventory_gc_cursor_bytes','0',true)`);
    const charge = scopeCharge === "reservation" ? "target.reserved_bytes<>target.byte_count" : "target.byte_count<>0";
    const scopes = scopeCharge ? `selected AS MATERIALIZED (
      SELECT target.ctid,target.scope_id FROM ${table} target WHERE ${where} ORDER BY target.${orderBy} LIMIT $1
    ), scopes AS MATERIALIZED (
      SELECT scope.id,coalesce(octet_length(row_to_json(charge)::text),0) AS bytes FROM data_scope_epochs scope
      LEFT JOIN data_generation_charges charge ON charge.scope_id=scope.id AND charge.tenant_id=scope.tenant_id
      JOIN (SELECT DISTINCT scope_id FROM selected) wanted ON wanted.scope_id=scope.id
      ORDER BY scope.id FOR UPDATE OF scope SKIP LOCKED
    ),` : "";
    const candidate = `SELECT target.ctid,octet_length(row_to_json(target)::text)${scopeCharge ? `+CASE WHEN ${charge} THEN scopes.bytes ELSE 0 END` : ""} AS data_bytes,
        ${scopeCharge ? `CASE WHEN ${charge} THEN 2 ELSE 1 END` : "1"} AS base_row_cost
        ${cursorWrites ? `,reference_scope.scope_id AS cursor_scope,
          CASE WHEN reference_scope.scope_id IS NULL THEN 0 ELSE octet_length(jsonb_build_object(
            'scope_id',reference_scope.scope_id,'tenant_id',reference_scope.tenant_id,
            'after_generation',${cursorGeneration},'after_identity',${cursorIdentity},'after_inclusive',true)::text) END AS cursor_bytes` : ""}
      FROM ${table} target ${scopeCharge ? "JOIN selected ON selected.ctid=target.ctid JOIN scopes ON scopes.id=target.scope_id" : ""}
      ${reference ? `LEFT JOIN LATERAL (SELECT scope_id,tenant_id FROM data_generations
        WHERE id=target.${reference.generation} OFFSET 0) reference_scope ON true` : cursorWrites
        ? `LEFT JOIN LATERAL (SELECT target.scope_id,target.tenant_id,k.identity FROM inventory_keys k
            WHERE k.generation_id=target.id AND k.scope_id=target.scope_id ORDER BY k.identity COLLATE "C" LIMIT 1) reference_scope ON true` : ""}
      WHERE ${where} ORDER BY target.${orderBy} LIMIT $1 ${values ? "FOR UPDATE OF target SKIP LOCKED" : ""}`;
    const candidates = cursorWrites ? `raw_candidates AS MATERIALIZED (${candidate}), candidates AS MATERIALIZED (
      SELECT ctid,data_bytes,base_row_cost,data_bytes+CASE WHEN cursor_scope IS NOT NULL
        AND row_number() OVER(PARTITION BY cursor_scope ORDER BY ctid)=1
        THEN max(cursor_bytes) OVER(PARTITION BY cursor_scope) ELSE 0 END AS bytes,
        base_row_cost+CASE WHEN cursor_scope IS NOT NULL
          AND row_number() OVER(PARTITION BY cursor_scope ORDER BY ctid)=1 THEN 1 ELSE 0 END AS row_cost
      FROM raw_candidates
    )` : `candidates AS MATERIALIZED (
      SELECT target.ctid,octet_length(row_to_json(target)::text)${scopeCharge ? `+CASE WHEN ${charge} THEN scopes.bytes ELSE 0 END` : ""} AS bytes,
        ${scopeCharge ? `CASE WHEN ${charge} THEN 2 ELSE 1 END` : "1"} AS row_cost
      FROM ${table} target ${scopeCharge ? "JOIN selected ON selected.ctid=target.ctid JOIN scopes ON scopes.id=target.scope_id" : ""}
      WHERE ${where} ORDER BY target.${orderBy} LIMIT $1 ${values ? "FOR UPDATE OF target SKIP LOCKED" : ""}
    )`;
    const result = (await this.client.query(`WITH ${scopes} ${candidates}, bounded AS (
      SELECT *,sum(bytes) OVER(ORDER BY ctid) AS total,sum(row_cost) OVER(ORDER BY ctid) AS total_rows FROM candidates
    ), changed AS (
      ${values ? `UPDATE ${table} target SET ${values} FROM bounded` : `DELETE FROM ${table} target USING bounded`}
      WHERE target.ctid=bounded.ctid AND bounded.total<=$2 AND bounded.total_rows<=${lifecycleLimits.rows - this.rows}
      RETURNING bounded.${cursorWrites ? "data_bytes" : "bytes"} AS data_bytes,bounded.bytes,bounded.row_cost,
        bounded.${cursorWrites ? "base_row_cost" : "row_cost"} AS base_rows
    ) SELECT count(*)::int AS rows,coalesce(sum(data_bytes),0)::int AS bytes,coalesce(sum(bytes),0)::int AS reserved_bytes,
      coalesce(sum(row_cost),0)::int AS charged_rows,coalesce(sum(base_rows),0)::int AS base_rows,
      (SELECT coalesce(max(total),0)>$2 OR coalesce(max(total_rows),0)>${lifecycleLimits.rows - this.rows} FROM bounded) AS full FROM changed`,
    [Math.min(this.limit, lifecycleLimits.rows - this.rows), lifecycleLimits.bytes - this.bytes, ...parameters])).rows[0];
    if (cursorWrites) {
      const cursor = (await this.client.query(`SELECT current_setting('agent_control.inventory_gc_cursor_rows') AS rows,
        current_setting('agent_control.inventory_gc_cursor_bytes') AS bytes`)).rows[0];
      const rows = Number(cursor?.rows),bytes = Number(cursor?.bytes);
      if (!result || !Number.isSafeInteger(rows) || !Number.isSafeInteger(bytes) || rows<0 || bytes<0 || rows>result.rows
        || result.base_rows+rows>result.charged_rows || result.bytes+bytes>result.reserved_bytes) throw new Error("lifecycle_cursor_budget");
      result.charged_rows = result.base_rows+rows;result.bytes += bytes;
    }
    if (!result || ![result.rows, result.charged_rows, result.bytes].every(value => Number.isSafeInteger(value) && value >= 0)
      || result.charged_rows < result.rows || this.rows + result.charged_rows > lifecycleLimits.rows
      || this.bytes + result.bytes > lifecycleLimits.bytes) throw new Error("lifecycle_budget_counters");
    this.rows += result.charged_rows;
    this.bytes += result.bytes;
    // Move to the next relation when this slice is full; a busy earlier table cannot starve later children.
    if (result.full || this.rows >= lifecycleLimits.rows || this.bytes >= lifecycleLimits.bytes) {
      this.stopped = true; this.next = step + 1;
    }
    void name;
    return result.rows as number;
  }
  async finish() {
    await this.client.query(`UPDATE data_lifecycle_progress SET cursor=jsonb_set(cursor,'{step}',to_jsonb($1::int)),
      slices=slices+1,rows_collected=rows_collected+$2,bytes_collected=bytes_collected+$3,updated_at=clock_timestamp()
      WHERE worker=$4`, [this.next >= this.step ? 0 : this.next, this.rows, this.bytes, this.worker]);
    observeDataWork("record_gc", { rows: this.rows, bytes: this.bytes, durationMs: Math.ceil(performance.now() - this.startedAt) });
  }
}
