import pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CursorCodec, type SelectionIdentity } from "../services/dataSelections.js";
import { readInventoryResponsibility } from "./inventoryResponsibility.js";
import { InventoryQueries } from "./inventoryQueries.js";
import { digest } from "./dataBounds.js";

afterEach(() => vi.restoreAllMocks());

const objectId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", otherId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const identity: SelectionIdentity = { tenantId: "tenant", principalId: "principal", sessionEpoch: "1", authorizationHash: "viewer" };
const at = new Date("2030-01-01T00:00:00Z");
function result(rows: pg.QueryResultRow[]): pg.QueryResult {
  return { command: "SELECT", rowCount: rows.length, oid: 0, fields: [], rows };
}
function fixture() {
  const client = Object.assign(new pg.Client(), { release: vi.fn() });
  const query = vi.spyOn(client, "query").mockImplementation(async (statement: unknown, parameters?: unknown[]) => {
    if (typeof statement !== "string") throw new Error("Expected SQL");
    if (statement.includes("AS filtered")) return result([{ total: "2", filtered: "2", invalid: "0" }]);
    if (statement.includes("FROM unnest($4::text[])")) return result((parameters?.[3] as string[]).map(id => ({
      id, directory_id: id, display_name: "J\u030c", upn: null, status: null,
    })));
    return result([objectId, otherId].map(id => ({ id, roles: ["owner"], bytes: 100, candidate_count: 2, agent_count: "1" })));
  });
  const source = {
    generationId: null, scopeId: null, revision: null, expiresAt: null, observedAt: null, attemptedAt: null,
    attemptStatus: null, attemptObservedCount: null, errorCode: null, message: null, rowCount: null,
    state: "unavailable" as const, reportRefreshDate: null, period: null, reportVersion: null,
  };
  const data: Parameters<typeof readInventoryResponsibility>[2] = {
    identity, evaluatedAt: at, query: {},
    publicationRevisions: { graph_packages: "a".repeat(64), power_platform: "b".repeat(64), users: "c".repeat(64) },
    metadata: {
      directory: { ...source, source: "directory", generationId: "directory", observedAt: at.toISOString() },
      app_activity: { ...source, source: "app_activity" },
    }, report: {
      setId: null, activeSetId: null, activeRevision: "0", historyRevision: "0", historyEpoch: "0",
      availability: "never_imported", staleAfterDays: 7, periodAgeDays: null, acceptedAgeDays: null,
      reportingPeriod: null, acceptedAt: null, expiresAt: null, lineages: [],
    },
  };
  const selection = {
    revision: "1", query_hash: "query", evaluated_at: at, validated_at: at,
    expires_at: new Date(at.getTime() + 60_000),
  };
  const cursors = new CursorCodec("synthetic-responsibility-cursor-secret");
  const read = (search: string, cursor?: string) => readInventoryResponsibility(client, { sql: "WITH people AS (SELECT NULL)", values: [] },
    data, selection, "selection", identity, cursors, { search, cursor, limit: 1 });
  return { read, query, client, data, selection };
}

describe("responsibility Unicode search contracts", () => {
  it("folds both sides identically and accepts a cursor with a canonically equivalent search", async () => {
    const { read, query } = fixture();
    const first = await read("J\u030c");
    expect(first.people[0].evidence?.displayName).toBe("J\u030c");
    expect(query).toHaveBeenCalledWith(expect.stringContaining('strpos(normalize(lower(normalize(name,NFKC) COLLATE "default"),NFKC),$1)'),
      ["\u01f0"]);
    expect(first.page.nextCursor).not.toBeNull();
    await expect(read("\u01f0", first.page.nextCursor!)).resolves.toMatchObject({ selection: first.selection });
  });

  it.each(["\u337f".repeat(65), "\u0130".repeat(129), "a\u0085", "\ud800"])(
    "rejects expanded or invalid search %j before any SQL", async search => {
      const { read, query } = fixture();
      await expect(read(search)).rejects.toMatchObject({ code: "invalid_cursor" });
      expect(query).not.toHaveBeenCalled();
    },
  );
});

it("captures inventory exact-person requests before selected acquisition yields", async () => {
  const { client, query, data, selection } = fixture(), database = new pg.Pool({ max: 4 });
  vi.spyOn(database, "connect").mockRejectedValue(new Error("Database acquisition forbidden"));
  const inventory = new InventoryQueries(database, "synthetic-inventory-people-cursor-secret"), ids = [objectId];
  vi.spyOn(inventory.selections, "read").mockImplementationOnce(async (_id, _identity, work) => {
    ids[0] = otherId;
    await Promise.resolve();
    return work(client, { selection: { ...selection, query_json: { inventoryQuery: digest("{}") } },
      pins: [{ scope_id: "scope", generation_id: "baseline", revision: "1" }] });
  });
  query.mockImplementation(async (statement: unknown, parameters?: unknown[]) => {
    const sql = String(statement);
    if (sql.startsWith("SELECT set_config")) return result([]);
    if (sql.includes("FROM inventory_read_contexts")) return result([{
      source: "inventory_canonical", token_mode: "delegated", root_scope_id: "scope",
      association_revision: "0", report_context: data, query_values: {},
    }]);
    if (sql.includes("inventory_association_revision")) return result([{ revision: "0" }]);
    if (sql.includes("FROM unnest($4::text[])")) return result((parameters?.[3] as string[]).map(id => ({
      id, directory_id: id, display_name: "Saved person", upn: null, status: null,
    })));
    throw new Error("Unexpected inventory query");
  });
  expect((await inventory.people("selection", identity, ids))[0].objectId).toBe(objectId);
  expect(query).toHaveBeenCalledWith(expect.stringContaining("FROM unnest($4::text[])"),
    [identity.tenantId, identity.principalId, "directory", [objectId], at, "delegated", false]);
});
