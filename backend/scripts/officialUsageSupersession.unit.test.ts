import pg from "pg";
import { describe, expect, it, vi } from "vitest";
import { prepareRestoredDatabase } from "./backup.js";
import { retain } from "./database.js";
import { verifySchema } from "../src/db/schema.js";

vi.mock("../src/db/schema.js", async original => ({
  ...await original<typeof import("../src/db/schema.js")>(),
  verifySchema: vi.fn(async () => undefined),
}));

const setId = "11111111-1111-4111-8111-111111111111";
const capturedAt = new Date("2026-01-01T00:00:00Z");

function databaseFixture(name: string, superseded = false) {
  const reviews = new Map<string, Array<{ id: string; signature: string; verified: boolean }>>();
  const query = vi.fn(async (sql: string, parameters?: unknown[]) => {
    if (sql === "SELECT current_database() AS database") {
      return { rows: [{ database: name }], rowCount: 1 };
    }
    if (sql === "SELECT transaction_timestamp() AS now") return { rows: [{ now: capturedAt }], rowCount: 1 };
    if (sql.includes("pg_try_advisory_xact_lock")) return { rows: [{ acquired: true }], rowCount: 1 };
    if (sql.includes("pg_try_advisory_lock_shared")) return { rows: [{ acquired: true }],rowCount: 1 };
    if (sql.includes("pg_advisory_unlock_shared")) return { rows: [{ unlocked: true }],rowCount: 1 };
    if (sql.includes("SELECT cursor->>'step'")) return { rows: [{ step: "0" }],rowCount: 1 };
    if (sql.startsWith("SELECT cursor FROM data_lifecycle_progress")) return { rows: [{ cursor: {} }],rowCount: 1 };
    if (sql.includes("AS roots,") && sql.includes("FROM data_generations")) return { rows: [{ roots: "0",age: "0" }],rowCount: 1 };
    if (sql.startsWith("SELECT current_setting('agent_control.inventory_gc_cursor_rows')")) {
      return { rows: [{ rows: "0",bytes: "0" }],rowCount: 1 };
    }
    if (sql.includes("AS charged_rows")) return { rows: [{ rows: 0,base_rows: 0,charged_rows: 0,bytes: 0,reserved_bytes: 0,full: false }],rowCount: 1 };
    if (sql.includes("to_regclass")) return { rows: [{ name: null }], rowCount: 1 };
    if (sql.includes("SELECT report_set.id,md5")) {
      return parameters?.[0] === null
        ? { rows: [{ id: setId, signature: `same-content:superseded=${superseded}` }], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    }
    const inserted = /^INSERT INTO (restore_review_[a-f0-9]+)/.exec(sql);
    if (inserted) reviews.set(inserted[1], (JSON.parse(String(parameters?.[0])) as Array<{ id: string; signature: string }>)
      .map(row => ({ ...row, verified: false })));
    const updated = /^UPDATE (restore_review_[a-f0-9]+) expected SET verified=true/.exec(sql);
    if (updated) for (const row of JSON.parse(String(parameters?.[0])) as Array<{ id: string; signature: string }>) {
      for (const expected of reviews.get(updated[1]) ?? []) if (row.id === expected.id && row.signature === expected.signature) expected.verified = true;
    }
    return { rows: [], rowCount: 0 };
  });
  const client = Object.assign(new pg.Client(),{ query,release: vi.fn() });
  const database = {
    options: { host: "fixture.invalid", database: name, max: 4 }, query,
    connect: vi.fn().mockResolvedValue(client),
  };
  return { database: database as unknown as pg.Pool, client, reviews };
}

describe("official usage supersession lifecycle SQL", () => {
  it.each([false, true])("preserves accepted correction markers during retention (dryRun=%s)", async dryRun => {
    const { database, client } = databaseFixture("retention");
    await retain(database, { dryRun, batchSize: 25 });
    expect(verifySchema).toHaveBeenCalledWith(database);
    const [sql, parameters] = client.query.mock.calls.find(([sql]) =>
      sql.includes("DELETE FROM official_usage_sets target"))!;
    expect(sql.replace(/\s+/g, " ")).toContain(
      "AND NOT (complete AND accepted_at IS NOT NULL AND EXISTS (" +
      " SELECT 1 FROM official_usage_sets original" +
      " WHERE original.id=target.supersedes_set_id" +
      " AND original.tenant_id=target.tenant_id AND original.deleted_at IS NULL))",
    );
    expect(sql).toContain("LIMIT $1");
    expect(sql).toContain("bounded.total<=$2");
    expect(parameters).toEqual([25,523776]);
    const [membershipSql] = client.query.mock.calls.find(([sql]) =>
      sql.includes("DELETE FROM official_usage_set_versions target"))!;
    expect(membershipSql).not.toContain("supersedes_set_id");
    expect(client.query).toHaveBeenLastCalledWith(dryRun ? "ROLLBACK" : "COMMIT");
    expect(client.release).toHaveBeenCalledOnce();
  });

  it.each([
    [false, false, [setId]],
    [true, true, [setId]],
    [true, false, []],
    [false, true, []],
  ])("fences restore when current supersession=%s and restored supersession=%s", async (currentSuperseded, restoredSuperseded, safeSets) => {
    const current = databaseFixture("current", currentSuperseded);
    const restored = databaseFixture("restored", restoredSuperseded);
    await prepareRestoredDatabase(current.database, restored.database, new Date("2026-01-01T00:00:00Z"));

    const [signatureSql] = current.client.query.mock.calls.find(([sql]) =>
      sql.includes("SELECT report_set.id,md5"))!;
    expect(signatureSql.replace(/\s+/g, " ")).toContain(
      "EXISTS (SELECT 1 FROM official_usage_sets replacement" +
      " WHERE replacement.tenant_id=report_set.tenant_id AND replacement.supersedes_set_id=report_set.id" +
      " AND replacement.complete AND replacement.accepted_at IS NOT NULL)",
    );
    expect(signatureSql).not.toContain("replacement.deleted_at");
    expect(signatureSql).toContain("WHERE ($1::uuid IS NULL OR id>$1::uuid)");
    expect(signatureSql).toContain("ORDER BY id LIMIT 250");
    expect(restored.client.query).toHaveBeenCalledWith(signatureSql, [null, capturedAt]);
    expect(restored.client.query).toHaveBeenCalledWith(signatureSql, [setId, capturedAt]);
    const review = [...restored.reviews.entries()].find(([, rows]) => rows.some(row => row.id === setId))!;
    expect(review[1].filter(row => row.verified).map(row => row.id)).toEqual(safeSets);
    const safeSelection = `SELECT id FROM ${review[0]} WHERE verified`;
    const queries = restored.client.query.mock.calls.map(([sql]) => sql);
    expect(queries.some(sql => sql.startsWith("DECLARE ") && sql.includes(`FROM official_usage_sets AS record WHERE deleted_at IS NULL AND id NOT IN (${safeSelection})`))).toBe(true);
    expect(queries.some(sql => sql.startsWith("DECLARE ") && sql.includes(`FROM official_usage_set_versions AS record WHERE set_id NOT IN (${safeSelection})`))).toBe(true);
    expect(queries.some(sql => sql.startsWith("FETCH FORWARD 250 FROM "))).toBe(true);
    expect(current.client.query).toHaveBeenNthCalledWith(1, "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    expect(current.client.query).toHaveBeenLastCalledWith("COMMIT");
    expect(current.client.release).toHaveBeenCalledOnce();
    for (const [, parameters] of [...current.client.query.mock.calls, ...restored.client.query.mock.calls]) {
      expect(Buffer.byteLength(JSON.stringify(parameters ?? []))).toBeLessThanOrEqual(1024 * 1024);
    }
  });
});
