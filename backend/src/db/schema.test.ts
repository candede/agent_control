import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import type pg from "pg";
import * as schema from "./schema.js";
import { schemaSql, schemaFingerprint, verifySchema } from "./schema.js";
import { verifyReportCapacitySchema } from "./reportCapacitySchema.js";

function markerRows() {
  return [{ singleton: true, fingerprint: schemaFingerprint, initialized: true }];
}

const usageContract = {
  associations: "agent_usage_associations", revision: "agent_usage_state", triggers: 3, cascade: true,
};
const cutoverContract = { snapshots: null, sources: null, fact_index: null, actor: true, acceptance: true, collection: true, collection_guard: true, guards: 6 };
const environmentIndex = "CREATE INDEX inventory_environment_lookup ON public.power_platform_record_rows USING btree (lower(native_id), generation_id, identity) WHERE (resource_type = 'microsoft.powerplatform/environments'::text)";
const inventoryGrants = { update: false, truncate: false, scoped: true, reader: true, precedence: true };

function schemaResults(): Array<{ name: string; rows: unknown[] }> {
  return [
    { name: "marker definition", rows: [{ valid: true }] },
    { name: "fingerprint", rows: markerRows() },
    { name: "usage structures", rows: [usageContract] },
    { name: "usage grants", rows: [{ valid: true }] },
    { name: "data sync cleanup", rows: [{ valid: true }] },
    { name: "data generations", rows: [{ valid: true }] },
    { name: "user sources", rows: [{ valid: true }] },
    { name: "user report periods", rows: [{ periods: true, immutable: true }] },
    { name: "inventory classification", rows: [{ columns: true, constraints: true, fence: true }] },
    { name: "official reports", rows: [{ valid: true }] },
    { name: "users/reports cutover", rows: [cutoverContract] },
    { name: "inventory tables", rows: Array.from({ length: 21 }, () => ({ relation: "inventory_roots" })) },
    { name: "inventory guards", rows: [{ count: 14 }] },
    { name: "inventory indexes", rows: [{ count: 11 }] },
    { name: "inventory grants", rows: [inventoryGrants] },
    { name: "job pages", rows: [{ revision: true, triggers: 3 }] },
    { name: "refresh targets", rows: [{ targets: true, target_job: true, retired_arrays: true,
      detail_metadata: true, retired_triggers: true, permissions: true }] },
    { name: "inventory authority", rows: [{ current_memberships: true, retired_registry: true, application_fence: true }] },
    { name: "live identity", rows: [{ live_sources: true, generation_reference: true, retired_reference: true, live_guard: true }] },
    { name: "control queue", rows: [{ valid: true }] },
    { name: "mutation stages", rows: [{ valid: true }] },
    { name: "native control", rows: [{ valid: true }] },
    { name: "clear", rows: [{ definition: "inventory_native_control_pending published_sequence=pending_sequence generation_id=NULL,revision=revision+1" }] },
    { name: "selection criteria", rows: [{ present: 1 }] },
    { name: "observer", rows: [{ counter: true, guards: 3 }] },
    { name: "inventory cutover", rows: [{ retired: true, controls: true, clear: true, functions: true }] },
    { name: "provider metadata", rows: Array.from({ length: 3 }, () => ({ data_type: "integer", is_nullable: "NO" })) },
    { name: "refresh contract", rows: [{ retired_mode: true, bounded_detail_mode: true }] },
    { name: "identity lookup", rows: [{ exact_identity: true, identifier_index: true }] },
    { name: "query context", rows: [{ present: 1 }] },
    { name: "attempt fence", rows: [{ present: 1 }] },
    { name: "ordering", rows: [
      { collname: "inventory_text_order", definition: { collprovider: "i", collisdeterministic: false, colliculocale: "en-US-u-ks-level1" } },
      { collname: "inventory_version_order", definition: { collprovider: "i", collisdeterministic: false, colliculocale: "en-US-u-kn-true-ks-level1" } },
    ] },
    { name: "identity expiry", rows: [{ valid: true }] },
    { name: "detail admission", rows: [{ valid: true }] },
    { name: "audit selection", rows: [{ definition: "starts_with(lower(a.operation_id),lower(s.query_json->>'operationIdPrefix')) a.observed_at<=s.evaluated_at" }] },
    { name: "people lookup", rows: [{ indexdef: "(generation_id, identity, kind) person:owner person:createdBy person:lastModifiedBy" }] },
    { name: "environment lookup", rows: [{ indexdef: environmentIndex }] },
    { name: "dispatch authority", rows: [{ valid: true }] },
    { name: "lifecycle progress", rows: [{ valid: true }] },
    { name: "report capacity", rows: [{ valid: true,keys: true }] },
    { name: "inventory collection", rows: [{ valid: true }] },
    { name: "inventory summary access", rows: [{ valid: true }] },
    { name: "inventory set publication", rows: [{ row_fence: true,insert_fence: true,callable: false }] },
    { name: "inventory summary aggregate", rows: [{ valid: true }] },
    { name: "inventory prepared publication", rows: [{ prepared: true,changed: true,complete: true,deletion_fence: true,callable: false }] },
    { name: "generation accounting", rows: [{ charge: true,protected: true,maintained: true,indexed: true,scoped: true,callable: false }] },
    { name: "user report page", rows: [{ valid: true }] },
    { name: "reconciliation admission", rows: [{ valid: true }] },
    ...["users","agents","userAgents"].map(kind => ({ name: `official ${kind} name page`,rows: [{ valid: true,
      predicate: `(kind = '${kind}'::text)`,
      expression: `left(lower(normalize(${kind==="users" ? "display_name" : "agent_name"},NFKC)),128)` }] })),
    { name: "inclusive collection cursor",rows: [{ valid: true }] },
    ...Array.from({ length: 9 },(_,index) => ({ name: `reference rewind trigger ${index}`,rows: [{ valid: true }] })),
    { name: "set-based child insert fences",rows: Array.from({ length: 2 },() => ({ inserted: true,immutable: true,callable: false })) },
    { name: "report membership counts",rows: [{ columns: true,keyed: true,scoped: true,protected: true,maintained: true,callable: false }] },
  ];
}

function databaseWithResults(...rows: unknown[][]) {
  const query = vi.fn();
  for (const result of rows) query.mockResolvedValueOnce({ rows: result, rowCount: result.length });
  return { query } as pg.Pool & { query: typeof query };
}

function resultsBefore(name: string) {
  const results = schemaResults();
  const index = results.findIndex(result => result.name === name);
  if (index < 0) throw new Error(`Unknown schema verification stage: ${name}`);
  return results.slice(0, index).map(result => result.rows);
}

describe("current schema source contracts", () => {
  const topLevel = schemaSql.replace(/\$\$[\s\S]*?\$\$/g, "");

  it("exports only the current schema, its exact SHA-256 fingerprint and verification", () => {
    expect(Object.keys(schema).sort()).toEqual(["schemaFingerprint", "schemaSql", "verifySchema"]);
    expect(schemaFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(schemaFingerprint).toBe(createHash("sha256").update(schemaSql).digest("hex"));
    expect(schemaFingerprint).not.toBe(createHash("sha256").update(schemaSql + "\n").digest("hex"));
  });

  it("constructs the final objects once without upgrades, backfills or preservation branches", () => {
    for (const [kind, count] of [["TABLE", 106], ["VIEW", 3], ["FUNCTION", 75], ["TRIGGER", 99], ["COLLATION", 2]] as const) {
      const names = [...topLevel.matchAll(new RegExp("^CREATE " + kind + " ([a-z_]+)", "gm"))].map(match => match[1]);
      expect(names).toHaveLength(count);
      if (kind !== "TRIGGER") expect(new Set(names).size).toBe(count);
    }
    expect([...topLevel.matchAll(/^CREATE (?:UNIQUE )?INDEX /gm)]).toHaveLength(157);
    const alterations = topLevel.split(";").map(statement => statement.trim()).filter(statement => /^ALTER /i.test(statement));
    expect(alterations).toHaveLength(94);
    for (const statement of alterations) {
      expect(statement).toMatch(/^ALTER TABLE [a-z0-9_]+ ADD CONSTRAINT [a-z0-9_]+ FOREIGN KEY /);
    }
    expect(topLevel).not.toMatch(/^(?:DROP|RENAME|UPDATE|DELETE|TRUNCATE|DO)\b|CREATE OR REPLACE|IF NOT EXISTS/im);
    expect(schemaSql).not.toMatch(/schema_migrations|fresh_application_database_required|legacy_audit_imports|legacy_source_id|legacy_content_hash/);
    expect(schemaSql).not.toMatch(/CREATE TABLE (?:copilot_usage_snapshots|copilot_usage_source_state|unified_agents|unified_agent_sources|package_detail_cache|power_platform_inventory_snapshots|power_platform_inventory_resources)\b/);
    expect(schemaSql).not.toContain("official_usage_untyped_facts");
    expect(schemaSql).not.toContain("typed_version");
    expect(schemaSql).not.toMatch(/COLLATE public\s*,/);
    expect(topLevel).not.toMatch(/^(?:SET|SELECT|CREATE SCHEMA|\\restrict|\\unrestrict)\b/m);
    expect(schemaSql).toContain("official_usage_typed_fact CHECK");
    expect(schemaSql).toContain("official_usage_typed_payload CHECK");
    expect(schemaSql).toContain("defender_hunting_jobs_query_version_check CHECK (query_version = 3)");
    expect(schemaSql).toContain("defender_hunting_snapshots_query_version_check CHECK (query_version = 3)");
    expect(schemaSql).toContain("defender_hunting_rows_projection_version_check CHECK (projection_version = 3)");
  });

  it("creates but does not populate the fingerprint marker and retains required fresh seed rows", () => {
    expect(topLevel).toMatch(/CREATE TABLE app_schema[\s\S]*?PRIMARY KEY[\s\S]*?CHECK \(singleton\)/);
    expect(topLevel).toContain("fingerprint ~ '^[a-f0-9]{64}$'");
    const inserts = topLevel.split(";").map(statement => statement.trim()).filter(statement => /^INSERT /i.test(statement));
    expect(inserts).toHaveLength(2);
    expect(inserts[0]).toMatch(/^INSERT INTO operational_state/);
    expect(inserts[1]).toMatch(/^INSERT INTO data_lifecycle_progress/);
    for (const worker of ["records", "inventory", "inventory_metadata", "operator", "report_payloads", "report_staging"]) {
      expect(inserts[1]).toContain("'" + worker + "'");
    }
  });

  it("allows cleanup only for the complete three-source automatic scope", () => {
    const cleanup = schemaSql.match(/CONSTRAINT data_sync_cleanup_full_scope CHECK[\s\S]*?(?=\n  , CONSTRAINT)/)?.[0];
    expect(cleanup).toContain("NOT clear_saved_data");
    expect(cleanup).toContain("mode = CAST('full' AS text)");
    expect(cleanup).toContain('["users", "graph_packages", "power_platform"]');
    expect(cleanup).toContain("jsonb_array_length(source_ids) = 3");
    expect(cleanup).not.toContain("usage_reports");
    expect(cleanup).not.toContain("= 4");
  });
});

describe("schema verification without a database", () => {
  it("requires typed facts and the exact membership foreign key",async () => {
    const database = databaseWithResults([{ valid: true,keys: true }]);
    await expect(verifyReportCapacitySchema(database)).resolves.toBeUndefined();
    const foreignKey = "FOREIGN KEY (tenant_id, kind, payload_hash) REFERENCES official_usage_row_facts(tenant_id, kind, payload_hash) ON DELETE RESTRICT";
    expect(database.query.mock.calls[0][0]).toContain(foreignKey);
    expect(schemaSql.replace(/\s+/g, " ").replace(/REFERENCES official_usage_row_facts \(/g, "REFERENCES official_usage_row_facts("))
      .toContain(foreignKey);
    for (const rows of [[],[{ valid: false,keys: true }],[{ valid: true,keys: false }]]) {
      await expect(verifyReportCapacitySchema(databaseWithResults(rows))).rejects.toThrow("typed-fact contract");
    }
  });
  it("requires the partial exact environment index without changing source or membership authority", async () => {
    const indexdef = environmentIndex;
    const database = databaseWithResults(...schemaResults().map(result => result.rows));
    await expect(verifySchema(database)).resolves.toBeUndefined();
    expect(database.query.mock.calls[0][0].trim()).toMatch(/^SELECT\s/);
    for (const invalid of [undefined, indexdef.replace("lower(native_id)", "native_id"),
      indexdef.replace("microsoft.powerplatform/environments", "microsoft.copilotstudio/agents")]) {
      await expect(verifySchema(databaseWithResults(...resultsBefore("environment lookup"), invalid ? [{ indexdef: invalid }] : [])))
        .rejects.toThrow("inventory_environment_projection_schema");
    }
  });

  it("accepts the matching fingerprint, current structures and runtime grants using read-only queries", async () => {
    const database = databaseWithResults(...schemaResults().map(result => result.rows));
    const transactionClient: Pick<pg.PoolClient, "query"> = { query: database.query };
    await expect(verifySchema(transactionClient)).resolves.toBeUndefined();
    expect(database.query).toHaveBeenCalledTimes(schemaResults().length);
    for (const [sql] of database.query.mock.calls) expect(sql.trim()).toMatch(/^SELECT\s/);
  });

  it("rejects incomplete active official-report structures", async () => {
    const previous = resultsBefore("official reports");
    const database = databaseWithResults(...previous, [{ valid: false }]);
    await expect(verifySchema(database)).rejects.toThrow("Official report schema is invalid.");
    expect(database.query).toHaveBeenCalledTimes(previous.length + 1);
  });

  it.each([[], [{ valid: false }]].map(rows => ({ rows })))(
    "rejects a missing or obsolete cleanup scope constraint: $rows", async ({ rows }) => {
      const database = databaseWithResults(...resultsBefore("data sync cleanup"), rows);
      await expect(verifySchema(database)).rejects.toThrow("Data sync cleanup scope constraint");
      const definition = database.query.mock.calls.at(-1)?.[1]?.[0];
      expect(definition).toContain("jsonb_array_length(source_ids) = 3");
      expect(definition).not.toContain("usage_reports");
    });

  it.each([
    { rows: [] },
    { rows: [{ periods: false, immutable: true }] },
    { rows: [{ periods: true, immutable: false }] },
  ])("rejects missing or invalid report-period evidence: $rows", async ({ rows }) => {
      const database = databaseWithResults(...resultsBefore("user report periods"), rows);
      await expect(verifySchema(database)).rejects.toThrow("User-source report period schema is missing or invalid.");
    });

  it.each([
    undefined, { snapshots: "copilot_usage_snapshots" }, { sources: "copilot_usage_source_state" },
    { fact_index: "official_usage_row_facts_observed" },
    { actor: false }, { acceptance: false }, { collection: false }, { collection_guard: false }, { guards: 5 },
  ])("rejects incomplete cutover structures: %j", async override => {
    const previous = resultsBefore("users/reports cutover");
    const database = databaseWithResults(...previous,
      override === undefined ? [] : [{ ...cutoverContract, ...override }]);
    await expect(verifySchema(database)).rejects.toThrow("users_reports_cutover_schema_required");
    expect(database.query).toHaveBeenCalledTimes(previous.length + 1);
  });

  it.each([
    [],
    [{ singleton: true, fingerprint: "0".repeat(64), initialized: true }],
    [...markerRows(), ...markerRows()],
    [{ ...markerRows()[0], singleton: false }],
    [{ ...markerRows()[0], initialized: false }],
  ].map(rows => ({ rows })))("rejects absent, mismatched or invalid singleton markers: %j", async ({ rows }) => {
    const database = databaseWithResults([{ valid: true }], rows);
    await expect(verifySchema(database)).rejects.toThrow("Database schema fingerprint does not match this artifact");
    expect(database.query).toHaveBeenCalledTimes(2);
  });

  it.each([[], [{ valid: false }]].map(rows => ({ rows })))("rejects invalid marker definitions: %j", async ({ rows }) => {
    const database = databaseWithResults(rows);
    await expect(verifySchema(database)).rejects.toThrow("Current schema marker is missing or invalid");
    expect(database.query).toHaveBeenCalledOnce();
  });

  it.each([
    [],
    [{ ...usageContract, associations: null }],
    [{ ...usageContract, revision: null }],
    [{ ...usageContract, triggers: 2 }],
    [{ ...usageContract, cascade: false }],
  ])("rejects incomplete usage structures: %j", async (...contract) => {
    const database = databaseWithResults(...resultsBefore("usage structures"), contract);
    await expect(verifySchema(database)).rejects.toThrow("Database usage association schema is missing or incomplete");
    expect(database.query).toHaveBeenCalledTimes(3);
  });

  it.each([[], [{ valid: false }]])("rejects missing or invalid runtime grants: %j", async (...permissions) => {
    const database = databaseWithResults(...resultsBefore("usage grants"), permissions);
    await expect(verifySchema(database)).rejects.toThrow("Database usage association runtime grants are invalid");
  });

  it.each([
    ["inventory tables", [{ relation: null }], "inventory_schema_missing"],
    ["inventory guards", [{ count: 13 }], "inventory_schema_guards"],
    ["inventory indexes", [{ count: 10 }], "inventory_schema_indexes"],
  ] as const)("rejects incomplete active inventory structures at %s", async (stage, rows, message) => {
    const database = databaseWithResults(...resultsBefore(stage), [...rows]);
    await expect(verifySchema(database)).rejects.toThrow(message);
  });

  it.each(["update", "truncate", "scoped", "reader", "precedence"] as const)(
    "rejects invalid current inventory %s privileges", async key => {
      const database = databaseWithResults(...resultsBefore("inventory grants"),
        [{ ...inventoryGrants, [key]: !inventoryGrants[key] }]);
      await expect(verifySchema(database)).rejects.toThrow("inventory_schema_privileges");
    });

  it.each(["refresh targets", "inventory authority", "live identity", "inventory cutover", "inventory classification"])(
    "requires every named inventory contract flag at %s", async stage => {
    const row = schemaResults().find(result => result.name === stage)!.rows[0] as Record<string, boolean>;
    for (const key of Object.keys(row)) for (const missing of [false, true]) {
      const invalid = { ...row, [key]: false };
      if (missing) delete invalid[key];
      const database = databaseWithResults(...resultsBefore(stage), [invalid]);
      await expect(verifySchema(database)).rejects.toThrow(/inventory_.*schema/);
    }
  });

  it.each([[], [{ valid: false }]])("rejects missing or invalid user-source schema/grants: %j", async (...contract) => {
    const database = databaseWithResults(...resultsBefore("user sources"), contract);
    await expect(verifySchema(database)).rejects.toThrow("User source schema or runtime grants are invalid");
  });

  it.each(schemaResults().map((result, index) => ({ ...result, index })))(
    "fails closed when $name returns no schema evidence", async ({ index }) => {
      const database = databaseWithResults(...schemaResults().slice(0, index).map(result => result.rows), []);
      await expect(verifySchema(database)).rejects.toThrow();
      expect(database.query).toHaveBeenCalledTimes(index + 1);
    });

  it.each(schemaResults().map((_result, index) => index))("propagates a query failure at step %i without returning success", async failedQuery => {
    const database = databaseWithResults(...schemaResults().slice(0, failedQuery).map(result => result.rows));
    const failure = new Error("Database query failed");
    database.query.mockRejectedValueOnce(failure);
    await expect(verifySchema(database)).rejects.toBe(failure);
    expect(database.query).toHaveBeenCalledTimes(failedQuery + 1);
  });
});
