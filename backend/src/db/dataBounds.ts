import { createHash } from "node:crypto";
import { AppError } from "../errors.js";
import { peakCheckpoint } from "../services/peakMemory.js";
import { operationalLog } from "../services/telemetry.js";
import type pg from "pg";

export const dataLimits = Object.freeze({
  batchRows: 250, batchBytes: 1_048_576, residualBytes: 262_144,
  generationBytes: 8 * 1024 ** 3, tenantBytes: 64 * 1024 ** 3,
  sourceRows: 100_000, derivedRows: 200_000, plansPerUser: 1000, pages: 10_000, wireRows: 5_000_000,
  pageRows: 100, roots: 16, queue: 32, acquireMs: 5_000,
  leaseMs: 60_000, heartbeatMs: 20_000,
});

export function dataLimitError(code: string, limit: number, observed: number) {
  return new AppError(413, code, code, { limit, observed });
}

export function assertResidualBytes(bytes: number, stage: "inventory_projection" | "generation_batch" | "database",
  field: "residual" | "payload" = "residual") {
  if (bytes > dataLimits.residualBytes) {
    operationalLog("warn", "data_residual_limit_exceeded", {
      errorCode: "data_residual_bytes", stage, field, bytes, maximumLength: dataLimits.residualBytes,
    });
    throw dataLimitError("data_residual_bytes", dataLimits.residualBytes, bytes);
  }
}

export function dataAdmissionError(code: string, status: 429 | 503 = 429) {
  const error = new AppError(status, code, code);
  error.retryAfterSeconds = 5;
  return error;
}

export function digest(value: string | Uint8Array) {
  return createHash("sha256").update(value).digest("hex");
}

export function exactCount(value: string | number): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) throw new Error("data_count_overflow");
  return result;
}

export class BatchResidency {
  private readonly batches = new Set<readonly unknown[]>();
  maximum = 0;
  track(batch: readonly unknown[]) {
    this.batches.add(batch);
    this.maximum = Math.max(this.maximum, this.batches.size);
    if (this.maximum > 2) throw new Error("data_batch_residency");
    return () => { this.batches.delete(batch); };
  }
}

export function encodeBatch(rows: readonly unknown[], parameters: readonly unknown[] = []) {
  if (rows.length > dataLimits.batchRows) throw dataLimitError("data_batch_rows", dataLimits.batchRows, rows.length);
  peakCheckpoint("batch.stringify");
  const json = JSON.stringify(rows);
  peakCheckpoint("batch.stringify");
  // PostgreSQL's text Bind parameters: four-byte length prefix plus UTF-8
  // content, not a JSON-escaped copy of the complete parameter array.
  const bytes = [ ...parameters, json ].reduce<number>((total, value) => total + 4 + (value === null || value === undefined
    ? 0 : Buffer.byteLength(typeof value === "string" ? value : JSON.stringify(value))), 0);
  if (bytes > dataLimits.batchBytes) throw dataLimitError("data_batch_bytes", dataLimits.batchBytes, bytes);
  return { json, bytes, hash: digest(json) };
}

export async function assertResidualDatabaseBounds(client: pg.PoolClient, json: string, field: "residual" | "payload" = "residual",
  rows?: readonly { residual?: unknown; payload?: unknown; deleted?: boolean }[]) {
  // Even worst-case JavaScript-number expansion and JSONB punctuation cannot
  // turn a <=512-byte JSON value into a 256-KiB value.
  if (rows?.every(row => row.deleted || row[field] !== undefined && Buffer.byteLength(JSON.stringify(row[field])) <= 512)) return;
  const result = await client.query(`SELECT max(octet_length(${field}::text))::text AS observed
    FROM jsonb_to_recordset($1::jsonb) AS record(${field} jsonb,deleted boolean) WHERE NOT coalesce(deleted,false)`, [json]);
  const bytes = Number(result.rows[0].observed ?? 0);
  assertResidualBytes(bytes, "database", field);
}
