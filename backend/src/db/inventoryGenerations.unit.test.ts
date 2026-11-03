import pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { currentSchemaSql } from "./currentSchema.js";
import { InventoryGenerations } from "./inventoryGenerations.js";
import { LifecycleSlice } from "./lifecycleSlice.js";
import type { GenerationLease } from "./dataGenerations.js";
import type { InventoryRecord } from "../services/inventoryRecordProjection.js";

afterEach(() => vi.restoreAllMocks());

function result(rows: pg.QueryResultRow[] = []): pg.QueryResult {
  return { command: "SELECT", rowCount: rows.length, oid: 0, fields: [], rows };
}

describe("inventory delta target identity", () => {
  const guid = "ABCDEFAB-ABCD-4ABC-8ABC-ABCDEFABCDEF";
  it.each([
    ["power_platform", "control", guid, guid.toLowerCase(), true],
    ["power_platform", "exact", guid, guid.toLowerCase(), false],
    ["packages", "control", guid, guid.toLowerCase(), false],
    ["packages", "exact", guid, guid.toLowerCase(), false],
    ["power_platform", "control", guid, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", false],
    ["power_platform", "control", "OpaqueAgent", "opaqueagent", false],
    ["power_platform", "control", "OpaqueAgent", "OpaqueAgent", true],
  ] as const)("checks %s %s target %s against %s (accepted=%s)", async (domain, channel, target, nativeId, accepted) => {
    const database = new pg.Pool({ max: 4 });
    vi.spyOn(database, "connect").mockRejectedValue(new Error("Unit tests must not connect to a database."));
    vi.spyOn(database, "query").mockRejectedValue(new Error("Unit tests must not access a database."));
    const client = Object.assign(new pg.Client(), { release: vi.fn() });
    const query = vi.spyOn(client, "query").mockImplementation(async statement => {
      const sql = String(statement);
      if (sql.startsWith("SELECT * FROM inventory_attempts")) return result([{
        domain, channel, mode: "delta", exact_targets: [target], resource_types: ["microsoft.copilotstudio/agents"],
      }]);
      if (sql.startsWith("SELECT max(octet_length")) return result([{ observed: "1024" }]);
      return result();
    });
    const store = new InventoryGenerations(database);
    vi.spyOn(store.generations.connections, "run").mockImplementation(async work => work(client));
    vi.spyOn(store, "fence").mockResolvedValue({
      state: "staging", batch_count: 0, byte_count: "0", reserved_bytes: "1048576",
    });
    vi.spyOn(store.generations, "abort").mockResolvedValue(undefined);
    const lease: GenerationLease = {
      id: "generation", scopeId: "scope", tenantId: "tenant", owner: "owner", version: 1,
      epoch: "0", sessionEpoch: "0", expectedRevision: "0", schemaVersion: 1,
    };
    const record: InventoryRecord = {
      identity: "identity", native_id: nativeId, environment_id: null, display_name: "Agent", sort_key: "agent",
      resource_type: "microsoft.copilotstudio/agents", publisher: null, modified_at: null,
      presence: null, link_state: null, availability: null, management: null,
      residual: { tenantId: "tenant" }, facts: [],
    };
    const append = store.append(lease, [record]);
    if (accepted) await expect(append).resolves.toMatchObject({ rows: 1, replay: false });
    else await expect(append).rejects.toThrow("inventory_exact_target_mismatch");
    expect(query.mock.calls.some(([sql]) => String(sql).startsWith("INSERT INTO inventory_keys"))).toBe(accepted);
    await database.end();
  });
});

describe("inventory publication dependency inputs", () => {
  it.each(["baseline", "compact"] as const)("uses the matching dependency vector for %s publication", async mode => {
    const database = new pg.Pool({ max: 4 });
    vi.spyOn(database, "connect").mockRejectedValue(new Error("Unit tests must not connect to a database."));
    vi.spyOn(database, "query").mockRejectedValue(new Error("Unit tests must not access a database."));
    const client = Object.assign(new pg.Client(), { release: vi.fn() });
    const store = new InventoryGenerations(database);
    const lease: GenerationLease = {
      id: "generation", scopeId: "scope", tenantId: "tenant", owner: "owner", version: 1,
      epoch: "3", sessionEpoch: "0", expectedRevision: "4", schemaVersion: 1,
    };
    const prior = { baseline_id: "prior", revision: "4", observation_epoch: "3" };
    const attempt = {
      domain: "canonical", mode, channel: "canonical", baseline_id: prior.baseline_id,
      base_revision: prior.revision, membership_prepared: true, prepared_changed_count: 0,
    };
    const query = vi.fn<(statement: unknown, values?: unknown[]) => Promise<pg.QueryResult>>(async statement => {
      const sql = String(statement);
      if (sql.startsWith("SET LOCAL") || sql.startsWith("INSERT INTO inventory_attempts")
        || sql.startsWith("INSERT INTO inventory_revisions")) return result();
      if (sql.startsWith("SELECT r.* FROM inventory_roots") || sql.startsWith("SELECT * FROM inventory_roots")) {
        return result([prior]);
      }
      if (sql.startsWith("SELECT * FROM inventory_attempts")) return result([attempt]);
      if (sql.startsWith("UPDATE inventory_roots SET current=true")) return result([{ row_count: 1, observation_epoch: "3" }]);
      if (sql.startsWith("UPDATE inventory_roots")) return result();
      throw new Error(`Unexpected query: ${sql}`);
    });
    vi.spyOn(client, "query").mockImplementation(query);
    vi.spyOn(store.generations.connections, "run").mockImplementation(async work => work(client));
    vi.spyOn(store.generations, "execute").mockImplementation(async (_input, work) => work(lease, new AbortController().signal));
    vi.spyOn(store, "fence").mockResolvedValue({});
    vi.spyOn(store, "validate").mockResolvedValue(undefined);
    vi.spyOn(store.generations, "publish").mockImplementation(async (_lease, options) => {
      await options?.completeJob?.(client, { jobId: "job", runId: null, rows: 1, bytes: 100 });
      return "5";
    });

    await store.execute({
      scope: { tenantId: "tenant", kind: "tenant", principalId: null, tokenMode: "tenant",
        source: "inventory_canonical", selector: "complete" },
      schemaVersion: 1, jobId: "job", jobKind: "fixture", sessionEpoch: "0", reserveBytes: 1024,
      observedAt: new Date(), expiresAt: new Date(Date.now() + 60_000), deadlineAt: new Date(Date.now() + 30_000),
    }, { domain: "canonical", mode, channel: "canonical" }, async () => {}, { authorize: async () => {} });

    const publication = query.mock.calls.find(([statement]) => String(statement).startsWith("INSERT INTO inventory_revisions"));
    expect(publication).toBeDefined();
    expect(publication![1]).toEqual(["scope", "tenant", "5", "generation", "generation", mode === "compact" ? "4" : null]);
    expect(String(publication![0])).toContain("CASE WHEN $6::bigint IS NOT NULL");
    expect(String(publication![0])).toContain("SELECT inputs FROM inventory_revisions WHERE scope_id=$1 AND revision=$6");
    expect(String(publication![0])).toContain("ELSE coalesce((SELECT active_inputs FROM inventory_reconciliation WHERE scope_id=$1),'[]'::jsonb) END");
    await database.end();
  });
});

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
