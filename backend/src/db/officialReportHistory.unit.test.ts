import pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OfficialReportHistory } from "./officialReportHistory.js";
import { readableReportVersionSql } from "./reportCapacitySchema.js";
import * as retention from "./dataRetention.js";

const pools: pg.Pool[] = [];
const tenant = "automatic-report-head";
const older = "11111111-1111-4111-8111-111111111111";
const latest = "22222222-2222-4222-8222-222222222222";

afterEach(async () => {
  await Promise.all(pools.splice(0).map(pool => pool.end()));
  vi.restoreAllMocks();
});

function fixture(active: string | null, eligibleHead: string | null) {
  const pool = new pg.Pool({ max: 4 });
  pools.push(pool);
  vi.spyOn(pool, "connect").mockRejectedValue(new Error("Unit tests must not acquire a database."));
  const history = new OfficialReportHistory(pool);
  const client = Object.assign(new pg.Client(), { release: vi.fn() });
  const state = { active_set_id: active, revision: "4" };
  const result = (rows: object[] = []): pg.QueryResult => ({ command: "SELECT", rowCount: rows.length, oid: 0, fields: [], rows });
  const query = vi.spyOn(client, "query").mockImplementation(async (sql: string, values?: unknown[]) => {
    if (sql.startsWith("INSERT INTO data_scope_epochs") || sql.startsWith("SELECT id FROM data_scope_epochs")) return result([{ id: "history-scope" }]);
    if (sql.startsWith("SELECT scope_id")) return result([{ scope_id: "history-scope" }]);
    if (sql.startsWith("SELECT * FROM data_scope_epochs")) return result([{ id: "history-scope" }]);
    if (sql.startsWith("SELECT active_set_id,revision::text")) return result([{ ...state }]);
    if (sql.startsWith("SELECT COALESCE(sum")) return result([{ large: false }]);
    if (sql.includes("SELECT s.id FROM (")) return result(eligibleHead ? [{ id: eligibleHead }] : []);
    if (sql.startsWith("UPDATE official_usage_state")) {
      state.active_set_id = values![1] as string | null;
      state.revision = String(BigInt(state.revision) + 1n);
      return result([{ ...state }]);
    }
    if (sql.startsWith("INSERT INTO official_usage_") || sql.startsWith("SELECT set_config")
      || sql.startsWith("SELECT pg_advisory_xact_lock")) return result();
    throw new Error(`Unexpected unit SQL: ${sql}`);
  });
  vi.spyOn(history.connections, "run").mockImplementation(work => work(client));
  return { history, client, state, query, result };
}

describe("automatic report head reconciliation", () => {
  it("repairs an existing manually selected head during ensure and leaves repeated reads unchanged", async () => {
    const { history, state, query } = fixture(older, latest);
    expect(await history.ensure(tenant)).toBe("history-scope");
    expect(state).toEqual({ active_set_id: latest, revision: "5" });
    await history.ensure(tenant);
    expect(query.mock.calls.filter(([sql]) => sql.startsWith("UPDATE official_usage_state"))).toHaveLength(1);
    const statements = query.mock.calls.map(([sql]) => sql);
    expect(statements.findIndex(sql => sql.includes("data_scope_epochs WHERE id=$1") && sql.includes("FOR UPDATE")))
      .toBeLessThan(statements.findIndex(sql => sql.includes("official_usage_state WHERE tenant_id=$1 FOR UPDATE")));
  });

  it.each([
    { active: latest, eligible: latest, revision: "4", scenario: "historical backfill or correction" },
    { active: older, eligible: latest, revision: "5", scenario: "newest-period publication or correction" },
    { active: latest, eligible: older, revision: "5", scenario: "deletion or expiry fallback" },
    { active: latest, eligible: null, revision: "5", scenario: "last report removal" },
    { active: null, eligible: null, revision: "4", scenario: "normal empty tenant read" },
  ])("changes the revision only when the actual eligible head changes: $scenario", async ({ active, eligible, revision }) => {
    const { history, client, query } = fixture(active, eligible);
    expect(await history.reconcileHead(client, tenant)).toEqual({ active_set_id: eligible, revision });
    expect(query.mock.calls.filter(([sql]) => sql.startsWith("UPDATE official_usage_state")))
      .toHaveLength(active === eligible ? 0 : 1);
  });

  it("orders current published content dates before acceptance time without reviving superseded corrections", async () => {
    const { history, client, query } = fixture(older, latest);
    await history.reconcileHead(client, tenant);
    const [sql, values] = query.mock.calls.find(([sql]) => sql.includes("SELECT s.id FROM ("))!;
    expect(values).toEqual([tenant, null]);
    expect(sql).toContain("ORDER BY s.reporting_end DESC NULLS LAST,s.reporting_start DESC NULLS LAST,s.accepted_at DESC");
    expect(sql).toContain("s.visibility='retained'");
    expect(sql).not.toMatch(/ORDER BY.*downloaded_at/);
    expect(sql).toContain("$2::bigint IS NULL AND m.valid_to_revision IS NULL");
    expect(sql).toContain("s.deleted_at IS NOT NULL OR s.expires_at<=clock_timestamp()");
    expect(sql).toContain("3<>(SELECT count(*)");
    expect(sql).toContain("LEAST(v.expires_at,a.expires_at)");
    expect(sql).toContain(readableReportVersionSql("v.id", "v.tenant_id", "v.kind", "v.row_count"));
  });

  it("reconciles expiry to the next eligible head without an intermediate null head revision", async () => {
    const { history, client, query, result } = fixture(latest, older);
    const original = query.getMockImplementation()!;
    query.mockImplementation(async (sql, values) => {
      if (sql.endsWith("SELECT 1 FROM invalid_sets LIMIT 1")) return result([{ id: latest }]);
      if (sql.includes("SELECT id FROM invalid_sets ORDER BY id")) return result([{ id: latest }]);
      if (sql.startsWith("UPDATE official_usage_sets")) return result();
      return original(sql, values);
    });
    const invalidate = vi.spyOn(history, "invalidate").mockResolvedValue(undefined);
    vi.spyOn(retention, "retireUnreferencedReportVersions").mockResolvedValue(undefined);
    expect(await history.expireInTransaction(client, tenant)).toBe(1);
    expect(invalidate).toHaveBeenCalledWith(client, tenant, latest, true);
    expect(query.mock.calls.filter(([sql]) => sql.startsWith("UPDATE official_usage_state")).map(([, values]) => values))
      .toEqual([[tenant, older]]);
  });
});
