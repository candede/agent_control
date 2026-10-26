import pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InventoryQueries, inventoryPackageResidualSql } from "./inventoryQueries.js";
import { digest } from "./dataBounds.js";
import { packageInventoryRecord } from "../services/inventoryRecordProjection.js";
import { allowlistedPackage } from "../services/packageObservation.js";
import { userSourceSearchSql } from "./userSources.js";

const databases: pg.Pool[] = [];
const identity = { tenantId: "tenant", principalId: "reader", authorizationHash: "viewer", sessionEpoch: "1" };
const at = new Date("2030-01-01T00:00:00Z");

afterEach(async () => {
  await Promise.all(databases.splice(0).map(database => database.end()));
  vi.restoreAllMocks();
});

function result(rows: pg.QueryResultRow[] = []): pg.QueryResult {
  return { command: "SELECT", rowCount: rows.length, fields: [], oid: 0, rows };
}

function fixture() {
  const database = new pg.Pool({ max: 4 });
  databases.push(database);
  vi.spyOn(database, "connect").mockRejectedValue(new Error("Unexpected database acquisition."));
  vi.spyOn(database, "query").mockRejectedValue(new Error("Unexpected pool query."));
  const inventory = new InventoryQueries(database, "synthetic-inventory-query-contract-secret");
  const client = Object.assign(new pg.Client(), { release: vi.fn() });
  const source = {
    generationId: null, scopeId: null, revision: null, expiresAt: null, observedAt: null, attemptedAt: null,
    attemptStatus: null, attemptObservedCount: null, errorCode: null, message: null, rowCount: null,
    state: "unavailable" as const, reportRefreshDate: null, period: null, reportVersion: null,
  };
  const data: Parameters<InventoryQueries["pageInRead"]>[1]["data"] = {
    identity, evaluatedAt: at, query: {},
    publicationRevisions: { graph_packages: "a".repeat(64), power_platform: "b".repeat(64), users: "c".repeat(64) },
    metadata: { directory: { ...source, source: "directory" }, app_activity: { ...source, source: "app_activity" } },
    report: {
      setId: null, activeSetId: null, activeRevision: "0", historyRevision: "0", historyEpoch: "0",
      availability: "never_imported", staleAfterDays: 7, periodAgeDays: null, acceptedAgeDays: null,
      reportingPeriod: null, acceptedAt: null, expiresAt: null, lineages: [],
    },
  };
  const readQuery = vi.fn<(sql: string, values?: unknown[]) => pg.QueryResult>().mockImplementation(sql => {
    throw new Error(`Unexpected selected inventory query: ${sql}`);
  });
  const query = vi.spyOn(client, "query").mockImplementation(async (statement: unknown, values?: unknown[]) => {
    if (typeof statement !== "string") throw new Error("Unexpected query shape.");
    if (statement.startsWith("SELECT set_config")) return result();
    if (statement.includes("FROM inventory_read_contexts c")) return result([{
      root_scope_id: "scope", source: "inventory_canonical", token_mode: "delegated",
      association_revision: "0", query_values: {}, report_context: data,
    }]);
    if (statement.includes("inventory_association_revision")) return result([{ revision: "0" }]);
    return readQuery(statement, values);
  });
  const read = vi.spyOn(inventory.selections, "read").mockImplementation(async (_id, _identity, work) =>
    work(client, {
      selection: { revision: "revision", query_hash: "query", query_json: { inventoryQuery: digest("{}") },
        evaluated_at: at, validated_at: at, expires_at: new Date(at.getTime() + 60_000) },
      pins: [{ scope_id: "scope", generation_id: "baseline", revision: "1" }],
    }));
  return { inventory, read, query, readQuery };
}

describe("saved package detail reconstruction", () => {
  it.each([
    {},
    { supportedHosts: [], elementTypes: [], categories: [] },
    { supportedHosts: ["Teams"], elementTypes: ["DeclarativeCopilots"], categories: ["Productivity", "Finance"] },
  ])("restores observed collections and source provenance without changing absence: %j", async collections => {
    const { inventory, readQuery } = fixture();
    const record = packageInventoryRecord(allowlistedPackage({ id: "package", displayName: "Package", isBlocked: false, ...collections }));
    const observedCollections = Object.fromEntries(record.facts.filter(fact => fact.kind === "collection"
      && ["supportedHosts", "elementTypes", "categories"].includes(fact.value)).map(collection => [
      collection.value, record.facts.filter(fact => fact.kind === collection.value).map(fact => fact.value),
    ]));
    readQuery.mockImplementation(sql => {
      if (sql.startsWith("WITH selected AS")) return result([{
        record_id: "canonical", source_scope_id: "source-scope", scope_id: "source-scope",
        identity: record.identity, generation_id: "generation", domain: "packages", evidence: [], current: true,
        observed_at: at, expires_at: new Date(at.getTime() + 60_000),
        residual: { ...record.residual, ...observedCollections, savedSource: { scopeId: "source-scope", identity: record.identity } },
      }]);
      if (sql.startsWith("SELECT count(*)")) return result([{ total: 0, bytes: 0 }]);
      if (sql.startsWith("SELECT 1 FROM inventory_facts")) return result();
      throw new Error("Unexpected package detail query.");
    });

    const detail = await inventory.packageDetail("selection", identity, record.native_id);
    expect(detail).toMatchObject({
      ...collections, savedSource: { scopeId: "source-scope", identity: record.identity },
      selectedSource: { selectionId: "selection", recordId: "canonical", sourceScopeId: "source-scope",
        sourceIdentity: record.identity, generationId: "generation" },
    });
    for (const field of ["supportedHosts", "elementTypes", "categories"] as const) {
      expect(Object.hasOwn(detail, field)).toBe(Object.hasOwn(collections, field));
    }
    const sql = readQuery.mock.calls[0][0];
    expect(sql).toContain("'savedSource',jsonb_build_object('scopeId',selected.scope_id,'identity',selected.identity)");
    expect(sql).toContain("item.generation_id=selected.generation_id AND item.identity=selected.identity");
    expect(sql).toContain("collection.value IN ('supportedHosts','elementTypes','categories')");
    expect(sql).toContain("jsonb_agg(item.value ORDER BY item.ordinal)");
  });

  it("keeps categories out of bounded list and export previews", () => {
    expect(inventoryPackageResidualSql("member")).toContain("collection.value IN ('supportedHosts','elementTypes')");
    expect(inventoryPackageResidualSql("r")).not.toContain("'categories'");
  });

  it("rejects an oversized reconstructed detail instead of silently omitting saved categories", async () => {
    const { inventory, readQuery } = fixture();
    readQuery.mockImplementation(sql => {
      if (sql.startsWith("WITH selected AS")) return result([{
        identity: "package", generation_id: "generation", residual: {
          id: "package", displayName: "Package", isBlocked: false,
          categories: Array.from({ length: 150 }, () => "x".repeat(4096)),
        },
      }]);
      if (sql.startsWith("SELECT count(*)")) return result([{ total: 0, bytes: 0 }]);
      if (sql.startsWith("SELECT 1 FROM inventory_facts")) return result();
      throw new Error("Unexpected package detail query.");
    });
    await expect(inventory.packageDetail("selection", identity, "package"))
      .rejects.toMatchObject({ status: 413, code: "inventory_detail_bytes" });
  });
});

describe("inventory facet search contracts", () => {
  it.each(["publisher", "environmentId", "availableTo"] as const)(
    "uses the shared Unicode folding for %s search and cursor binding", async field => {
      const { inventory, readQuery } = fixture();
      readQuery.mockImplementation((sql, values) => {
        if (sql.includes("SELECT count(*)::text AS n")) return result([{ n: "2" }]);
        if (sql.includes("candidates AS")) return result((values?.at(-2) ? ["second"] : ["first", "second"])
          .map(value => ({ value: `~string:${value}`, label: value, candidate_count: values?.at(-2) ? 1 : 2 })));
        throw new Error("Unexpected facet query.");
      });
      const first = await inventory.facets("selection", identity, field, { limit: 1, search: "J\u030c" });
      expect(first.nextCursor).toBeTruthy();
      const next = await inventory.facets("selection", identity, field, { limit: 1, search: "\u01f0", cursor: first.nextCursor! });
      expect([...first.value, ...next.value].map(row => row.value)).toEqual(["first", "second"]);
      expect(next.nextCursor).toBeNull();
      for (const [sql, values] of readQuery.mock.calls) {
        expect(values?.at(-1)).toBe("\u01f0");
        const label = field === "environmentId" ? "coalesce(f.environment_label,'')" : "coalesce(nullif(x.value,''),'Unknown')";
        expect(sql).toContain(`strpos(${userSourceSearchSql(label)},$${values!.length})>0`);
        if (field === "availableTo") {
          expect(sql).toContain(`strpos(${userSourceSearchSql("'Allowed for Some or All'")},$${values!.length})>0`);
        }
      }
    },
  );

  it("trims compatibility whitespace and binds equivalent searches to the same cursor", async () => {
    const { inventory, readQuery } = fixture();
    readQuery.mockImplementation((sql, values) => sql.includes("SELECT count(*)::text AS n") ? result([{ n: "2" }])
      : result((values?.at(-2) ? ["second"] : ["first", "second"])
        .map(value => ({ value: `~string:${value}`, label: value, candidate_count: values?.at(-2) ? 1 : 2 }))));
    const first = await inventory.facets("selection", identity, "publisher", { limit: 1, search: "\uff21\u3000" });
    await expect(inventory.facets("selection", identity, "publisher", { limit: 1, search: "a", cursor: first.nextCursor! }))
      .resolves.toMatchObject({ value: [{ value: "second", label: "second" }] });
    expect(readQuery.mock.calls.every(([, values]) => values?.at(-1) === "a")).toBe(true);
  });

  it.each(["a\u0085", "\ud800", "x".repeat(257), "\u337f".repeat(65)])(
    "rejects invalid or expanded search before acquiring a selected read: %j", search => {
      const { inventory, read, query } = fixture();
      expect(() => inventory.facets("selection", identity, "publisher", { search }))
        .toThrow(expect.objectContaining({ code: "invalid_cursor" }));
      expect(read).not.toHaveBeenCalled();
      expect(query).not.toHaveBeenCalled();
    },
  );
});
