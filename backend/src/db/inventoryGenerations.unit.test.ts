import pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { currentSchemaSql } from "./currentSchema.js";
import { InventoryGenerations } from "./inventoryGenerations.js";
import { LifecycleSlice } from "./lifecycleSlice.js";

afterEach(() => vi.restoreAllMocks());

function result(rows: pg.QueryResultRow[] = []): pg.QueryResult {
  return { command: "SELECT", rowCount: rows.length, oid: 0, fields: [], rows };
}

describe("inventory provenance metadata retention", () => {
  it.each([null, "collectable"])("checks provenance before collecting generation metadata (candidate=%s)", async candidate => {
    const database = new pg.Pool({ max: 4 });
    vi.spyOn(database, "connect").mockRejectedValue(new Error("Unit tests must not connect to a database."));
    vi.spyOn(database, "query").mockRejectedValue(new Error("Unit tests must not access a database."));
    const client = Object.assign(new pg.Client(), { release: vi.fn() });
    const query = vi.spyOn(client, "query").mockImplementation(async statement => {
      const sql = String(statement);
      if (sql.startsWith("SET LOCAL") || sql.startsWith("UPDATE inventory_roots")) return result();
      if (sql.startsWith("SELECT principal_id") || sql.startsWith("SELECT id FROM data_scope_epochs")) {
        return result([{ id: "scope", principal_id: null }]);
      }
      if (sql.includes("pg_try_advisory_xact_lock")) return result([{ acquired: true }]);
      if (sql.startsWith("SELECT baseline_id") || sql.startsWith("SELECT g.job_id")) return result();
      if (sql.startsWith("SELECT g.id FROM data_generations")) {
        expect(sql).toMatch(/NOT EXISTS\(SELECT 1 FROM inventory_records r WHERE r\.catalog_generation=g\.id\s+OR r\.detail_generation=g\.id OR r\.control_generation=g\.id LIMIT 1 OFFSET 0\)/);
        return result(candidate ? [{ id: candidate }] : []);
      }
      throw new Error(`Unexpected query: ${sql}`);
    });
    vi.spyOn(LifecycleSlice.prototype, "open").mockResolvedValue(undefined);
    const change = vi.spyOn(LifecycleSlice.prototype, "change").mockResolvedValue(0);
    vi.spyOn(LifecycleSlice.prototype, "finish").mockResolvedValue(undefined);

    await new InventoryGenerations(database).gcMetadataSlice("scope", "tenant", client);

    expect(query).toHaveBeenCalledWith(expect.stringContaining("r.catalog_generation=g.id"), ["scope"]);
    for (const table of ["inventory_pages", "inventory_attempts", "data_generations"]) {
      expect(change.mock.calls.find(([, target]) => target === table)?.[4]).toEqual([candidate]);
    }
  });

  it.each(["package_record_rows", "power_platform_record_rows", "unified_agent_rows"])(
    "indexes every provenance lookup on %s",
    table => {
      for (const column of ["catalog_generation", "detail_generation", "control_generation"]) {
        expect(currentSchemaSql.includes(`CREATE INDEX ${table}_${column}\n  ON ${table} (${column});`)).toBe(true);
      }
    },
  );

  it("rejects deleting a generation still referenced as inventory provenance", () => {
    const guard = currentSchemaSql.slice(currentSchemaSql.indexOf("CREATE FUNCTION inventory_reachability_guard()"),
      currentSchemaSql.indexOf("CREATE FUNCTION inventory_content_guard()"));
    expect(guard).toMatch(/EXISTS\(SELECT 1 FROM inventory_records WHERE catalog_generation=NEW\.id\s+OR detail_generation=NEW\.id OR control_generation=NEW\.id\)/);
  });
});
