import pg from "pg";
import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InventoryQueries, type InventoryQuery } from "../db/inventoryQueries.js";
import { getAgents, getUnifiedAgents } from "../../../frontend/src/api/client.js";
import { lockInventorySelection } from "../db/inventoryAuthority.js";
import * as inventorySelections from "../db/inventorySelections.js";
import { OfficialReportHistory } from "../db/officialReportHistory.js";
import type { UserSourceMetadata } from "../types/userSources.js";
import { CursorCodec, DataSelections, canonicalQuery, type DependencyRoot, type SelectionIdentity } from "./dataSelections.js";
import { flushDataWorkMetrics } from "./dataMetrics.js";

vi.mock("../db/pool.js", () => ({
  pool: {},
  secretValue: (name: string) => name === "TENANTS_JSON" ? "[]"
    : name === "SESSION_SECRET" ? "synthetic-selection-unit-session-secret" : undefined,
}));

afterEach(() => { flushDataWorkMetrics(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const identity: SelectionIdentity = {
  tenantId: "selection-tenant", principalId: "selection-principal", authorizationHash: "a".repeat(64), sessionEpoch: "0",
};
const at = new Date("2030-01-01T00:00:00Z");
const expiresAt = new Date(at.getTime() + 600_000);
const roots: DependencyRoot[] = ["a", "z"].map(scopeId => ({
  kind: "tenant_history", scopeId, revision: "1", expiresAt,
}));
const selection = { id: "selected", revision: "revision", endpoint: "history",
  queryHash: canonicalQuery({}, []), evaluatedAt: at, expiresAt };
function result(rows: pg.QueryResultRow[] = [], command = "SELECT"): pg.QueryResult {
  return { command, oid: 0, fields: [], rowCount: rows.length, rows };
}

function fixture() {
  const database = new pg.Pool({ max: 4 });
  const client = Object.assign(new pg.Client(), { release: vi.fn() });
  vi.spyOn(database, "connect").mockImplementation(async () => client);
  vi.spyOn(database, "query").mockRejectedValue(new Error("Unexpected pool query"));
  const events: string[] = [];
  const query = vi.fn(async (statement: unknown, values?: unknown[]) => {
    if (typeof statement !== "string") throw new Error("Unexpected query shape");
    if (statement.startsWith("SELECT * FROM data_scope_epochs")) {
      events.push(`scope:${values?.[0]}:${statement.endsWith("FOR SHARE") ? "share" : "update"}`);
      return result([{ principal_id: identity.principalId, epoch: "1", session_epoch: "0" }]);
    }
    if (statement.startsWith("SELECT *,expires_at<=clock_timestamp()")) return result(roots.map((root, ordinal) => ({
      scope_id: root.scopeId, root_kind: root.kind, revision: root.revision, expires_at: root.expiresAt,
      scope_epoch: "1", session_epoch: "0", ordinal, expired: false,
    })));
    if (statement.startsWith("SELECT invalidated_at,expires_at<=clock_timestamp()")) {
      return result([{ invalidated_at: null, expired: false }]);
    }
    if (statement.startsWith("SELECT *,clock_timestamp() AS validated_at")) return result([{
      id: selection.id, root_count: roots.length, expires_at: expiresAt, validated_at: at,
      expired: false, dependencies_expired: false,
    }]);
    if (statement.startsWith("SELECT epoch FROM data_principal_epochs")) return result([{ epoch: "0" }]);
    if (statement === "SELECT clock_timestamp() AS now") return result([{ now: at }]);
    if (statement.startsWith("SELECT count(*)::int AS tenant")) return result([{ tenant: 0, principal: 0 }]);
    if (statement.startsWith("INSERT INTO data_")) return result();
    if (statement.includes("pg_advisory_unlock")) return result([{ unlocked: true }]);
    if (statement.includes("pg_advisory_lock") || statement.includes("pg_advisory_xact_lock") || statement.startsWith("BEGIN") || statement === "ROLLBACK") return result();
    if (statement === "COMMIT") return result([], "COMMIT");
    throw new Error(`Unexpected selection query: ${statement}`);
  });
  vi.spyOn(client, "query").mockImplementation(query);
  const validate = vi.fn(async (_client: pg.PoolClient, root: DependencyRoot) => { events.push(`domain:${root.scopeId}`); });
  const selections = new DataSelections(database, validate);
  return { database, client, selections, events, validate, query };
}

describe("inventory selection dependency capacity", () => {
  it.each([
    { sortBy: "displayName", directoryAvailable: false, pinCount: 18 },
    { sortBy: "displayName", directoryAvailable: true, pinCount: 19 },
    { sortBy: "owner", directoryAvailable: true, pinCount: 20 },
  ] as const)("captures and continues $pinCount dependencies for 16 inventory sources", async ({ sortBy, directoryAvailable, pinCount }) => {
    const { database, query } = fixture();
    const inventory = new InventoryQueries(database, "synthetic-selection-unit-cursor-secret");
    const inputs = Array.from({ length: 16 }, (_, index) => ({
      scopeId: `source-${String(index).padStart(2, "0")}`, tenantId: identity.tenantId,
      baselineId: `source-baseline-${index}`, revision: "1", epoch: "1",
    }));
    const source: UserSourceMetadata = {
      source: "directory", generationId: null, scopeId: null, revision: null, expiresAt: null, observedAt: null,
      attemptedAt: null, attemptStatus: null, attemptObservedCount: null, errorCode: null, message: null,
      rowCount: null, state: "unavailable", reportRefreshDate: null, period: null, reportVersion: null,
    };
    vi.spyOn(inventory.reports.sources, "ensureScope").mockResolvedValue("people");
    vi.spyOn(inventory.reports.sources, "validateRoot").mockResolvedValue();
    vi.spyOn(inventory.reports.history, "ensure").mockResolvedValue("history");
    vi.spyOn(inventory.reports.history, "root").mockResolvedValue({
      kind: "tenant_history", scopeId: "history", revision: "1", expiresAt,
    });
    vi.spyOn(inventory.reports.history, "validateRoot").mockResolvedValue();
    vi.spyOn(inventory.reports, "currentInventoryData").mockResolvedValue({
      identity, evaluatedAt: at, query: { lowResponseThreshold: 5 },
      metadata: {
        directory: directoryAvailable
          ? { ...source, generationId: "directory-generation", scopeId: "directory", revision: "1", state: "available" }
          : source,
        app_activity: { ...source, source: "app_activity" },
      },
      report: { setId: null, activeSetId: null, activeRevision: "1", historyRevision: "0", historyEpoch: "0",
        availability: "never_imported", staleAfterDays: 7, periodAgeDays: null, acceptedAgeDays: null,
        reportingPeriod: null, acceptedAt: null, expiresAt: null, lineages: [] },
    });
    const pins: pg.QueryResultRow[] = [];
    let rootCount = 0;
    const original = query.getMockImplementation()!;
    query.mockImplementation(async (statement, values) => {
      if (typeof statement !== "string") throw new Error("Unexpected query shape");
      if (statement.startsWith("SELECT r.scope_id,r.baseline_id,r.revision::text,v.inputs")) {
        return result([{ scope_id: "canonical", baseline_id: "canonical-baseline", revision: "1", inputs }]);
      }
      if (statement.startsWith("SELECT epoch FROM data_scope_epochs")) return result([{ epoch: "1" }]);
      if (statement.startsWith("SELECT min(expires_at)")) return result([{ expires_at: null }]);
      if (statement.startsWith("SELECT g.id")) return result([{ id: values?.[0] }]);
      if (statement.startsWith("SELECT 1 FROM inventory_revisions")) return result([{}]);
      if (statement.includes("inventory_association_revision")) return result([{ revision: "0" }]);
      if (statement.startsWith("INSERT INTO inventory_read_contexts")) return result();
      if (statement.startsWith("INSERT INTO data_read_selections")) rootCount = Number(values?.[11]);
      if (statement.startsWith("INSERT INTO data_generation_pins")) {
        if (!values) throw new Error("Missing pin parameters");
        pins.push({
          ordinal: values[2], scope_id: values[3], scope_epoch: values[4], session_epoch: values[5],
          root_kind: values[6], generation_id: values[7], revision: values[8], expires_at: values[9], expired: false,
        });
      }
      if (statement.startsWith("SELECT *,expires_at<=clock_timestamp()")) return result(pins);
      if (statement.startsWith("SELECT *,clock_timestamp() AS validated_at")) return result([{
        root_count: rootCount, expires_at: expiresAt, validated_at: at, expired: false, dependencies_expired: false,
      }]);
      return original(statement, values);
    });

    const captured = await inventory.capture(identity, "canonical", { sortBy });
    expect(rootCount).toBe(pinCount);
    expect(pins.filter(pin => pin.root_kind === "inventory_delta")).toHaveLength(17);
    expect(pins.map(pin => pin.ordinal)).toEqual(Array.from({ length: pinCount }, (_, index) => index));
    await expect(inventory.selections.read(captured.id, identity, async (_client, selected) => selected.pins))
      .resolves.toEqual(pins);
  });

  it("rejects more than 20 selection dependencies before taking source fences or saving pins", async () => {
    const { selections, query, events } = fixture();
    const oversized: DependencyRoot[] = Array.from({ length: 21 }, (_, index) => ({
      kind: "tenant_history", scopeId: `scope-${index}`, revision: "1", expiresAt,
    }));
    await expect(selections.capture(identity, "inventory", { values: {}, allowed: [] }, oversized))
      .rejects.toThrow("data_selection_roots");
    expect(events).toEqual([]);
    expect(query.mock.calls.some(([statement]) => typeof statement === "string"
      && statement.startsWith("INSERT INTO data_generation_pins"))).toBe(false);
  });
});

describe("selection scope-before-domain lock order", () => {
  it("captures every scope in sorted order before taking any domain revision lock", async () => {
    const { selections, events, query } = fixture();
    await selections.capture(identity, "history", { values: {}, allowed: [] }, [...roots].reverse());
    expect(events).toEqual(["scope:a:share", "scope:z:share", "domain:a", "domain:z"]);
    const pins = query.mock.calls.filter(([statement]) => typeof statement === "string" && statement.startsWith("INSERT INTO data_generation_pins"));
    expect(pins.map(([, values]) => values?.slice(2, 4))).toEqual([[0, "a"], [1, "z"]]);
  });

  it.each(["read", "writer"] as const)("locks all scopes before domain assertions in a %s", async mode => {
    const { selections, events, validate } = fixture();
    if (mode === "read") await selections.read(selection.id, identity, async () => undefined);
    else await selections.connections.run(client => selections.assert(client, selection.id, identity, "export"));
    const lock = mode === "read" ? "share" : "update";
    expect(events).toEqual([`scope:a:${lock}`, `scope:z:${lock}`, "domain:a", "domain:z"]);
    expect(validate).toHaveBeenCalledWith(expect.any(pg.Client), roots[0], identity, mode === "read" ? undefined : selection.id);
  });

  it.each(["epoch", "session_epoch", "principal_id"] as const)(
    "reports owned scope changes without exposing authorization failures (%s)", async field => {
      const { selections, query, validate } = fixture();
      const original = query.getMockImplementation()!;
      query.mockImplementation(async (statement, values) => {
        if (typeof statement === "string" && statement.startsWith("SELECT * FROM data_scope_epochs")) {
          return result([{ principal_id: identity.principalId, epoch: "1", session_epoch: "0", [field]: "changed" }]);
        }
        return original(statement, values);
      });
      await expect(selections.read(selection.id, identity, async () => undefined)).rejects.toMatchObject({
        status: 409, code: "selection_invalidated", details: field === "epoch" ? { reason: "changed" } : undefined,
      });
      expect(validate).not.toHaveBeenCalled();
      expect(query).toHaveBeenCalledWith("ROLLBACK");
      expect(query.mock.calls.some(([statement]) => statement === "COMMIT")).toBe(false);
    });

  it("rejects expired pins after authorization fences and before domain validation", async () => {
    const { selections, query, validate, events } = fixture();
    const original = query.getMockImplementation()!;
    query.mockImplementation(async (statement, values) => {
      const response = await original(statement, values);
      if (typeof statement === "string" && statement.startsWith("SELECT *,expires_at<=clock_timestamp()")) {
        return result(response.rows.map(row => ({ ...row, expired: true })));
      }
      return response;
    });
    await expect(selections.read(selection.id, identity, async () => undefined)).rejects.toMatchObject({
      status: 409, code: "selection_invalidated", details: { reason: "expired" },
    });
    expect(events).toEqual(["scope:a:share", "scope:z:share"]);
    expect(validate).not.toHaveBeenCalled();
  });

  it.each((["session_epoch", "principal_id"] as const).flatMap(field =>
    (["dependency", "expired", "invalidated"] as const).map(failure => ({ field, failure }))))(
    "does not disclose $failure before a later $field rejection", async ({ field, failure }) => {
      const { selections, query, validate } = fixture();
      const original = query.getMockImplementation()!;
      query.mockImplementation(async (statement, values) => {
        if (typeof statement === "string" && statement.startsWith("SELECT * FROM data_scope_epochs")) {
          return result([{ principal_id: identity.principalId, epoch: "1", session_epoch: "0",
            ...(values?.[0] === "a" ? { epoch: failure === "dependency" ? "2" : "1" } : { [field]: "unauthorized" }) }]);
        }
        if (typeof statement === "string" && statement.startsWith("SELECT invalidated_at,expires_at<=clock_timestamp()")) {
          return result([{ invalidated_at: failure === "invalidated" ? at : null, expired: failure === "expired" }]);
        }
        return original(statement, values);
      });
      await expect(selections.read(selection.id, identity, async () => "must not execute")).rejects.toMatchObject({
        code: "selection_invalidated", details: undefined,
      });
      expect(validate).not.toHaveBeenCalled();
      expect(query).toHaveBeenCalledWith("ROLLBACK");
    });

  it("does not apply inventory association invalidation to plain generation exports", async () => {
    const { database, query } = fixture();
    const original = query.getMockImplementation()!;
    query.mockImplementation(async (statement, values) => {
      if (typeof statement === "string" && statement.startsWith("SELECT *,expires_at<=clock_timestamp()")) {
        return result(roots.map((root, ordinal) => ({ scope_id: root.scopeId, root_kind: "generation", generation_id: root.scopeId,
          revision: root.revision, expires_at: root.expiresAt, scope_epoch: "1", session_epoch: "0", ordinal, expired: false })));
      }
      if (typeof statement === "string" && statement.startsWith("SELECT g.id")) return result([{ id: values?.[0] }]);
      return original(statement, values);
    });
    const inventory = new InventoryQueries(database, "synthetic-selection-unit-cursor-secret");
    const validate = vi.spyOn(inventorySelections, "validateInventoryRoot").mockRejectedValue(new Error("Unexpected inventory association fence"));
    await inventory.selections.connections.run(client => inventory.selections.assert(client, selection.id, identity, "export"));
    expect(validate).not.toHaveBeenCalled();
  });

  it.each([
    { initialSort: "displayName", mutatedSort: null, inputExpired: false },
    { initialSort: "displayName", mutatedSort: "owner", inputExpired: false },
    { initialSort: "owner", mutatedSort: "responses", inputExpired: false },
    { initialSort: "displayName", mutatedSort: null, inputExpired: true },
  ] as const)("captures immutable inventory intent and dependencies ($initialSort to $mutatedSort, inputExpired=$inputExpired)", async ({ initialSort, mutatedSort, inputExpired }) => {
    const { database, client, query, events } = fixture();
    const inventory = new InventoryQueries(database, "synthetic-selection-unit-cursor-secret");
    const suppliedIdentity = { ...identity };
    const suppliedQuery: InventoryQuery = {
      operationIdPrefix: "REF_CASE", availableTo: { kind: "some-or-all" }, sortBy: initialSort,
    };
    vi.spyOn(inventory.reports.sources, "ensureScope").mockImplementation(async () => {
      if (mutatedSort) {
        suppliedIdentity.principalId = "other-principal";
        suppliedQuery.operationIdPrefix = "changed-reference";
        suppliedQuery.availableTo = "changed-facet";
        suppliedQuery.sortBy = mutatedSort;
      }
      return "z";
    });
    vi.spyOn(inventory.reports.history, "ensure").mockResolvedValue("m");
    vi.spyOn(inventory.reports.history, "root").mockResolvedValue({ ...roots[0], scopeId: "m" });
    const source = (kind: UserSourceMetadata["source"]): UserSourceMetadata => ({
      source: kind, generationId: null, scopeId: null, revision: null, expiresAt: null, observedAt: null,
      attemptedAt: null, attemptStatus: null, attemptObservedCount: null, errorCode: null, message: null,
      rowCount: null, state: "unavailable", reportRefreshDate: null, period: null, reportVersion: null,
    });
    vi.spyOn(inventory.reports, "currentInventoryData").mockResolvedValue({
      identity, evaluatedAt: at, query: { lowResponseThreshold: 5 },
      metadata: { directory: source("directory"), app_activity: source("app_activity") },
      report: { setId: null, activeSetId: null, activeRevision: "1", historyRevision: "0", historyEpoch: "0",
        availability: "never_imported", staleAfterDays: 7, periodAgeDays: null, acceptedAgeDays: null,
        reportingPeriod: null, acceptedAt: null, expiresAt: null, lineages: [] },
    });
    query.mockImplementation(async (statement: unknown) => {
      if (typeof statement !== "string") throw new Error("Unexpected query shape");
      if (statement.startsWith("SELECT r.scope_id,r.baseline_id,r.revision::text,v.inputs")) return result([{
        scope_id: "a", baseline_id: "baseline", revision: "1",
        inputs: [{ scopeId: "b", tenantId: identity.tenantId, baselineId: "source-baseline", revision: "2", epoch: "1",
          expiresAt: (inputExpired ? new Date(at.getTime() - 1) : expiresAt).toISOString() }],
      }]);
      if (statement.startsWith("SELECT epoch FROM data_scope_epochs")) return result([{ epoch: "1" }]);
      if (statement.startsWith("SELECT min(expires_at)")) return result([{ expires_at: null }]);
      if (statement === "SELECT coalesce(inventory_association_revision($1),0)::text AS revision") {
        events.push("association");
        return result([{ revision: "7" }]);
      }
      if (statement.startsWith("INSERT INTO inventory_read_contexts")) return result();
      throw new Error(`Unexpected inventory capture query: ${statement}`);
    });
    vi.spyOn(inventory.selections, "captureWith").mockImplementation(async (_identity, _endpoint, _query, prepare) => {
      const prepared = await prepare(client, at);
      expect(prepared.roots.some(root => root.kind === "user_sources")).toBe(initialSort === "owner");
      expect(prepared.roots.filter(root => root.kind === "inventory_delta")).toEqual([
        { kind: "inventory_delta", scopeId: "a", generationId: "baseline", revision: "1",
          expiresAt: new Date(at.getTime() + 30 * 60_000) },
        { kind: "inventory_delta", scopeId: "b", generationId: "source-baseline", revision: "2",
          expiresAt: new Date(at.getTime() + 30 * 60_000) },
      ]);
      events.push("scopes");
      await prepared.persist?.(client, selection);
      return selection;
    });
    await inventory.capture(suppliedIdentity, "a", suppliedQuery);
    expect(events).toEqual(["scopes", "association"]);
    const criteria = { availableTo: "~some-or-all", operationIdPrefix: "REF_CASE", sortBy: initialSort };
    expect(inventory.selections.captureWith).toHaveBeenCalledWith(identity, "inventory", {
      values: { inventoryQuery: canonicalQuery(criteria, Object.keys(criteria)), operationIdPrefix: "REF_CASE" },
      allowed: ["inventoryQuery", "operationIdPrefix"],
    }, expect.any(Function));
    expect(query).toHaveBeenCalledWith(expect.stringContaining("SELECT r.scope_id,r.baseline_id,r.revision::text,v.inputs"),
      ["a", identity.tenantId, "delegated"]);
    expect(query).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO inventory_read_contexts"),
      [selection.id, identity.tenantId, expect.any(String), "7", "a", JSON.stringify(criteria)]);
  });

  it("takes the principal fence before inventory writer scopes and nested selection assertions", async () => {
    const { selections, client, query, events } = fixture();
    const original = query.getMockImplementation()!;
    query.mockImplementation(async (statement, values) => {
      if (typeof statement === "string" && statement.startsWith("WITH inventory AS")) {
        return result(roots.map(root => ({ scope_id: root.scopeId })));
      }
      if (typeof statement === "string" && statement.startsWith("SELECT epoch FROM data_principal_epochs")) events.push("principal");
      return original(statement, values);
    });
    await selections.connections.run(async writer => {
      expect(writer).toBe(client);
      await lockInventorySelection(writer, identity, selection.id);
      await selections.assert(writer, selection.id, identity);
    });
    expect(events).toEqual(["principal", "scope:a:update", "scope:z:update",
      "principal", "scope:a:update", "scope:z:update", "domain:a", "domain:z"]);
  });
});

describe("selected-read completion fences", () => {
  it.each([
    { deadline: "selection", expired: true, dependenciesExpired: false, exportId: undefined },
    { deadline: "dependency", expired: false, dependenciesExpired: true, exportId: undefined },
    { deadline: "export", expired: true, dependenciesExpired: false, exportId: "export" },
  ])("rolls back when the $deadline expires during the read callback", async ({ expired, dependenciesExpired, exportId }) => {
    const { selections, query, validate, client } = fixture();
    const original = query.getMockImplementation()!;
    let completed = false;
    query.mockImplementation(async (statement, values) => {
      const response = await original(statement, values);
      if (typeof statement === "string" && statement.startsWith("SELECT *,clock_timestamp() AS validated_at")) {
        expect(values?.[5]).toBe(exportId ?? null);
        return result(response.rows.map(row => ({ ...row,
          expired: completed && expired, dependencies_expired: completed && dependenciesExpired,
        })));
      }
      return response;
    });
    const work = vi.fn(async () => { completed = true; return "must not escape"; });
    await expect(selections.read(selection.id, identity, work, { exportId })).rejects.toMatchObject({
      status: 409, code: "selection_invalidated", details: { reason: "expired" },
    });
    expect(work).toHaveBeenCalledTimes(1);
    expect(validate).toHaveBeenCalledTimes(roots.length);
    expect(query).toHaveBeenCalledWith("ROLLBACK");
    expect(query.mock.calls.some(([statement]) => statement === "COMMIT")).toBe(false);
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it("returns a live result without replaying the callback or domain validators", async () => {
    const { selections, query, validate } = fixture();
    const value = { rows: ["selected-row"] };
    const work = vi.fn(async () => value);
    await expect(selections.read(selection.id, identity, work)).resolves.toBe(value);
    expect(work).toHaveBeenCalledTimes(1);
    expect(validate).toHaveBeenCalledTimes(roots.length);
    expect(query.mock.calls.filter(([statement]) => typeof statement === "string"
      && statement.startsWith("SELECT *,clock_timestamp() AS validated_at"))).toHaveLength(2);
    expect(query).toHaveBeenCalledWith("COMMIT");
  });

  it("keeps a live export readable beyond the page TTL", async () => {
    const { selections, query } = fixture();
    const original = query.getMockImplementation()!;
    query.mockImplementation(async (statement, values) => {
      const response = await original(statement, values);
      if (typeof statement === "string" && statement.startsWith("SELECT *,clock_timestamp() AS validated_at")) {
        expect(values?.[5]).toBe("export");
        expect(statement).toContain("e.status IN ('queued','building','ready')");
        expect(statement).toContain("e.expires_at>clock_timestamp()");
        return result(response.rows.map(row => ({ ...row, expires_at: new Date(at.getTime() - 1) })));
      }
      return response;
    });
    await expect(selections.read(selection.id, identity, async () => "export-row", { exportId: "export" }))
      .resolves.toBe("export-row");
  });

  it("propagates callback failures without attempting a completion check", async () => {
    const { selections, query } = fixture();
    const failure = new Error("selected work failed");
    await expect(selections.read(selection.id, identity, async () => { throw failure; })).rejects.toBe(failure);
    expect(query.mock.calls.filter(([statement]) => typeof statement === "string"
      && statement.startsWith("SELECT *,clock_timestamp() AS validated_at"))).toHaveLength(1);
    expect(query).toHaveBeenCalledWith("ROLLBACK");
    expect(query.mock.calls.some(([statement]) => statement === "COMMIT")).toBe(false);
  });
});

describe("selection cursor authentication", () => {
  const secret = "synthetic-session-secret-not-a-production-secret";
  const codec = new CursorCodec(secret);
  const queryHash = canonicalQuery({ company: "Example", sort: "name" }, ["company", "sort"]);
  const expected = { identity, endpoint: "/users", selectionId: "selected", revision: "one", queryHash };
  const cursor = codec.encode({ ...expected, direction: "next", boundary: { key: null, nullRank: 1, id: "tied" } });

  it("canonicalizes filters and authenticates null/tie/direction boundaries", () => {
    expect(canonicalQuery({ sort: "name", company: "Example" }, ["company", "sort"])).toBe(queryHash);
    expect(codec.decode(cursor, expected).boundary).toEqual({ key: null, nullRank: 1, id: "tied" });
    const previous = codec.encode({ ...expected, direction: "previous", boundary: { key: "same", nullRank: 0, id: "tied" } });
    expect(codec.decode(previous, expected)).toMatchObject({ direction: "previous", boundary: { key: "same", nullRank: 0, id: "tied" } });
    expect(() => canonicalQuery({ all: true }, ["sort"])).toThrow("invalid_cursor");
  });

  it.each(["selectionId", "revision"] as const)("accepts equivalent UUID casing for %s without changing the authenticated payload", field => {
    const value = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA";
    const binding = { ...expected, [field]: value };
    const encoded = codec.encode({ ...binding, direction: "next", boundary: { key: "Exact-Key", nullRank: 0, id: "Exact-ID" } });
    expect(codec.decode(encoded, { ...binding, [field]: value.toLowerCase() })).toMatchObject({
      [field]: value, boundary: { key: "Exact-Key", nullRank: 0, id: "Exact-ID" },
    });
    expect(() => codec.decode(encoded, { ...binding, [field]: value.replace(/^A/, "B") })).toThrow("invalid_cursor");
  });

  it.each(["selectionId", "revision"] as const)("keeps opaque %s values exact", field => {
    const binding = { ...expected, [field]: "Opaque-Exact" };
    const encoded = codec.encode({ ...binding, direction: "next", boundary: { key: null, nullRank: 1, id: "tied" } });
    expect(() => codec.decode(encoded, { ...binding, [field]: "opaque-exact" })).toThrow("invalid_cursor");
  });

  it.each([
    { path: "/api/agents", read: getAgents },
    { path: "/api/agent-inventory", read: getUnifiedAgents },
  ])("accepts the frontend $path continuation for an equivalent uppercase selection UUID", async ({ path, read }) => {
    const selectionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const binding = { ...expected, endpoint: "inventory", selectionId };
    const nextCursor = codec.encode({ ...binding, direction: "next", boundary: { key: "", nullRank: 0, id: "Package-Exact" } });
    const fetch = vi.fn(async (path: string) => {
      const url = new URL(path, "https://fixture.invalid");
      expect(codec.decode(url.searchParams.get("cursor")!, {
        ...binding, selectionId: url.searchParams.get("selectionId")!,
      }).boundary.id).toBe("Package-Exact");
      return Response.json({ value: [], selection: { id: selectionId } });
    });
    vi.stubGlobal("fetch", fetch);
    expect(await read({ selectionId: selectionId.toUpperCase(), cursor: nextCursor })).toMatchObject({
      value: [], selection: { id: selectionId },
    });
    expect(fetch).toHaveBeenCalledExactlyOnceWith(
      `${path}?${new URLSearchParams({ selectionId: selectionId.toUpperCase(), limit: "50", cursor: nextCursor })}`,
      expect.objectContaining({ credentials: "include" }),
    );
  });

  it("rejects tampering and cross-query, selection, endpoint or actor reuse", () => {
    expect(() => codec.decode(`${cursor}x`, expected)).toThrow("invalid_cursor");
    for (const change of [{ queryHash: "other" }, { endpoint: "/other" }, { revision: "two" }, { selectionId: "other" },
      ...(["tenantId", "principalId", "authorizationHash", "sessionEpoch"] as const).map(field => ({ identity: { ...identity, [field]: "other" } }))]) {
      expect(() => codec.decode(cursor, { ...expected, ...change })).toThrow("invalid_cursor");
    }
    const [encoded, signature] = cursor.split(".");
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString());
    payload.direction = "previous";
    const tampered = `${Buffer.from(JSON.stringify(payload)).toString("base64url")}.${signature}`;
    expect(() => codec.decode(tampered, expected)).toThrow("invalid_cursor");
    expect(() => codec.encode({ ...expected, direction: "next", boundary: { key: null, nullRank: 0, id: "tied" } }))
      .toThrow("invalid_cursor");
    expect(() => codec.encode({ ...expected, direction: "next", boundary: { key: "界".repeat(1024), nullRank: 0, id: "tied" } }))
      .toThrow("invalid_cursor");
  });

  it.each(["", "x".repeat(513)])("refuses to emit a boundary ID that cannot be decoded", id => {
    expect(() => codec.encode({ ...expected, direction: "next", boundary: { key: "name", nullRank: 0, id } }))
      .toThrow("invalid_cursor");
  });

  it("rejects noncanonical signatures even when their decoded HMAC bytes are identical", () => {
    const [encoded, signature] = cursor.split(".");
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const last = alphabet.indexOf(signature.at(-1)!);
    const alias = signature.slice(0, -1) + alphabet[last + 1];
    expect(Buffer.from(alias, "base64url")).toEqual(Buffer.from(signature, "base64url"));
    expect(() => codec.decode(`${encoded}.${alias}`, expected)).toThrow("invalid_cursor");
  });

  it.each([null, [], { version: 2 }, { boundary: [] }, { identity: null }, { direction: "sideways" },
    { boundary: { id: "tied", key: 1, nullRank: 0 } }].map(change => ({ change })))("rejects authenticated malformed payloads: $change", ({ change }) => {
    const payload = change && !Array.isArray(change) ? { ...JSON.parse(Buffer.from(cursor.split(".")[0], "base64url").toString()), ...change } : change;
    const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const signature = createHmac("sha256", secret).update(encoded).digest("base64url");
    expect(() => codec.decode(`${encoded}.${signature}`, expected)).toThrow("invalid_cursor");
  });
});

describe("history root expiry authority", () => {
  it.each([true, false])("uses database time even if the host clock disagrees (live=%s)", async live => {
    const { database, client, query } = fixture();
    const history = new OfficialReportHistory(database);
    vi.spyOn(history, "prepareRead").mockResolvedValue(undefined);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(live ? new Date(expiresAt.getTime() + 1000) : new Date(at.getTime() - 1000));
    query.mockImplementation(async (statement, values) => {
      if (typeof statement !== "string") throw new Error("Unexpected query shape");
      if (statement.startsWith("SELECT h.revision")) {
        expect(statement).toContain("$4::timestamptz>clock_timestamp()");
        expect(values).toEqual([identity.tenantId, roots[0].scopeId, roots[0].revision, roots[0].expiresAt]);
        return result(live ? [{ revision: "1" }] : []);
      }
      if (statement.includes("SELECT id FROM invalid_sets")) return result();
      throw new Error(`Unexpected history query: ${statement}`);
    });
    try {
      const assertion = history.validateRoot(client, roots[0], identity);
      if (live) await expect(assertion).resolves.toBeUndefined();
      else await expect(assertion).rejects.toMatchObject({ code: "selection_invalidated" });
      expect(history.prepareRead).toHaveBeenCalledTimes(live ? 1 : 0);
    } finally { vi.useRealTimers(); }
  });
});
