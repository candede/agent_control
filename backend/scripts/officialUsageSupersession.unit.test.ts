import type pg from "pg";
import { describe, expect, it, vi } from "vitest";
import { prepareRestoredDatabase } from "./backup.js";
import { retain } from "./database.js";

function databaseFixture(name: string, superseded = false) {
  const query = vi.fn(async (sql: string, _parameters?: unknown[]) => {
    if (sql === "SELECT current_database() AS database") {
      return { rows: [{ database: name }], rowCount: 1 };
    }
    if (sql.includes("pg_try_advisory_xact_lock")) return { rows: [{ acquired: true }], rowCount: 1 };
    if (sql.includes("to_regclass")) return { rows: [{ name: null }], rowCount: 1 };
    if (sql.includes("SELECT report_set.id,md5")) {
      return { rows: [{ id: "original-set", signature: `same-content:superseded=${superseded}` }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
  const client = { query, release: vi.fn() };
  const database = {
    options: { host: "fixture.invalid", database: name },
    connect: vi.fn().mockResolvedValue(client),
  };
  return { database: database as unknown as pg.Pool, client };
}

describe("official usage supersession lifecycle SQL", () => {
  it.each([false, true])("preserves accepted correction markers during retention (dryRun=%s)", async dryRun => {
    const { database, client } = databaseFixture("retention");
    await retain(database, { dryRun, batchSize: 25 });
    const [sql, parameters] = client.query.mock.calls.find(([sql]) =>
      sql.includes("DELETE FROM official_usage_sets target"))!;
    expect(sql.replace(/\s+/g, " ")).toContain(
      "AND NOT (complete AND accepted_at IS NOT NULL AND EXISTS (" +
      " SELECT 1 FROM official_usage_sets original" +
      " WHERE original.id=official_usage_sets.supersedes_set_id" +
      " AND original.tenant_id=official_usage_sets.tenant_id AND original.deleted_at IS NULL))",
    );
    expect(sql).toContain("LIMIT $1 FOR UPDATE SKIP LOCKED");
    expect(parameters).toEqual([25]);
    const [membershipSql] = client.query.mock.calls.find(([sql]) =>
      sql.includes("DELETE FROM official_usage_set_versions target"))!;
    expect(membershipSql).not.toContain("supersedes_set_id");
    expect(client.query).toHaveBeenLastCalledWith(dryRun ? "ROLLBACK" : "COMMIT");
    expect(client.release).toHaveBeenCalledOnce();
  });

  it.each([
    [false, false, ["original-set"]],
    [true, true, ["original-set"]],
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
    expect(restored.client.query).toHaveBeenCalledWith(signatureSql);
    expect(restored.client.query).toHaveBeenCalledWith(
      "UPDATE official_usage_sets SET deleted_at=COALESCE(deleted_at,clock_timestamp()) WHERE deleted_at IS NULL AND NOT (id=ANY($1::uuid[]))",
      [safeSets],
    );
    expect(restored.client.query).toHaveBeenCalledWith(
      "DELETE FROM official_usage_set_versions WHERE NOT (set_id=ANY($1::uuid[]))", [safeSets],
    );
    expect(current.client.query).toHaveBeenLastCalledWith("COMMIT");
  });
});
