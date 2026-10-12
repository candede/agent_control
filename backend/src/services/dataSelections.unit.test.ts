import pg from "pg";
import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InventoryQueries, type InventoryQuery } from "../db/inventoryQueries.js";
import { getAgents, getUnifiedAgents } from "../../../frontend/src/api/client.js";
import { lockInventorySelection } from "../db/inventoryAuthority.js";
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
    if (statement.startsWith("SELECT * FROM data_generation_pins")) return result(roots.map((root, ordinal) => ({
      scope_id: root.scopeId, root_kind: root.kind, revision: root.revision, expires_at: root.expiresAt,
      scope_epoch: "1", session_epoch: "0", ordinal,
    })));
    if (statement.startsWith("SELECT * FROM data_read_selections")) return result([{
      id: selection.id, root_count: roots.length, expires_at: expiresAt,
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

  it("does not apply inventory association invalidation to plain generation exports", async () => {
    const { database, query } = fixture();
    const original = query.getMockImplementation()!;
    query.mockImplementation(async (statement, values) => {
      if (typeof statement === "string" && statement.startsWith("SELECT * FROM data_generation_pins")) {
        return result(roots.map((root, ordinal) => ({ scope_id: root.scopeId, root_kind: "generation", generation_id: root.scopeId,
          revision: root.revision, expires_at: root.expiresAt, scope_epoch: "1", session_epoch: "0", ordinal })));
      }
      if (typeof statement === "string" && statement.startsWith("SELECT g.id")) return result([{ id: values?.[0] }]);
      return original(statement, values);
    });
    const inventory = new InventoryQueries(database, "synthetic-selection-unit-cursor-secret");
    const validate = vi.spyOn(inventory, "validateRoot").mockRejectedValue(new Error("Unexpected inventory association fence"));
    await inventory.selections.connections.run(client => inventory.selections.assert(client, selection.id, identity, "export"));
    expect(validate).not.toHaveBeenCalled();
  });

  it.each([false, true])("captures immutable inventory intent with scope-before-association fences (mutated=%s)", async mutated => {
    const { database, client, query, events } = fixture();
    const inventory = new InventoryQueries(database, "synthetic-selection-unit-cursor-secret");
    const suppliedIdentity = { ...identity };
    const suppliedQuery: InventoryQuery = {
      operationIdPrefix: "REF_CASE", availableTo: { kind: "some-or-all" }, sortBy: "displayName",
    };
    vi.spyOn(inventory.reports.sources, "ensureScope").mockImplementation(async () => {
      if (mutated) {
        suppliedIdentity.principalId = "other-principal";
        suppliedQuery.operationIdPrefix = "changed-reference";
        suppliedQuery.availableTo = "changed-facet";
        suppliedQuery.sortBy = "responses";
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
      if (statement.startsWith("SELECT r.*,g.expires_at")) return result([{ baseline_id: "baseline", revision: "1", expires_at: expiresAt }]);
      if (statement.startsWith("SELECT epoch FROM data_scope_epochs")) return result([{ epoch: "1" }]);
      if (statement.startsWith("SELECT inputs FROM inventory_revisions")) return result([{ inputs: [] }]);
      if (statement.startsWith("SELECT least(")) return result([{ expires_at: null }]);
      if (statement === "SELECT inventory_association_revision($1)::text AS revision") {
        events.push("association");
        return result([{ revision: "7" }]);
      }
      if (statement.startsWith("INSERT INTO inventory_read_contexts")) return result();
      throw new Error(`Unexpected inventory capture query: ${statement}`);
    });
    vi.spyOn(inventory.selections, "captureWith").mockImplementation(async (_identity, _endpoint, _query, prepare) => {
      const prepared = await prepare(client, at);
      events.push("scopes");
      await prepared.persist?.(client, selection);
      return selection;
    });
    await inventory.capture(suppliedIdentity, "a", suppliedQuery);
    expect(events).toEqual(["scopes", "association"]);
    const criteria = { availableTo: "~some-or-all", operationIdPrefix: "REF_CASE", sortBy: "displayName" };
    expect(inventory.selections.captureWith).toHaveBeenCalledWith(identity, "inventory", {
      values: { inventoryQuery: canonicalQuery(criteria, Object.keys(criteria)), operationIdPrefix: "REF_CASE" },
      allowed: ["inventoryQuery", "operationIdPrefix"],
    }, expect.any(Function));
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
