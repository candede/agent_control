import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { testDatabase } from "../../scripts/testDatabase.js";
import { selectionIdentity } from "../../scripts/largeTenantFixtures.js";
import { fixtureDirectoryUser, publishFixtureDirectory } from "../../scripts/userSourceFixture.js";
import { dataConnections } from "../db/dataConnections.js";
import { UserSourcesRepository, userSourceObjectIds } from "../db/userSources.js";
import { agentColumnValue } from "../types/agentPresentation.js";
import type { UnifiedAgentRecord } from "../types/unifiedAgents.js";
import { SavedAgentPeopleService } from "./savedAgentPeople.js";

vi.hoisted(() => { process.env.SESSION_SECRET = "saved-people-synthetic-session-secret"; });

const firstId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", secondId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
function record(tenantId: string, ownerId = firstId, createdBy: string | null = firstId, lastModifiedBy = firstId): UnifiedAgentRecord {
  return {
    id: `agent:${randomUUID()}`, displayName: "Agent", presence: "power_platform", environmentId: "environment", packages: [],
    powerPlatformResource: {
      tenantId, nativeId: "native", type: "microsoft.copilotstudio/agents", environmentId: "environment", location: null,
      displayName: "Agent", createdAt: null, createdBy, lastPublishedAt: null, sourceSystem: "power_platform", authoringTool: null,
      creatorType: "unknown", agentKind: "agent", lifecycle: "unknown", identityConfidence: "exact_native",
      identifiers: [], provenance: {}, details: { ownerId, lastModifiedBy }, unknownFieldCount: 0,
    },
    identity: { state: "unmatched", evidence: [], packageEvidence: [], reason: null },
    observations: { graphPackages: null, powerPlatform: null, packageSnapshots: {} },
  };
}

describe("saved exact-ID agent people projection", () => {
  let fixture: Awaited<ReturnType<typeof testDatabase>>;
  beforeAll(async () => { fixture = await testDatabase(); }, 30000);
  afterAll(async () => { await fixture?.close(); });
  afterEach(() => vi.restoreAllMocks());
  function harness() {
    const identity = { ...selectionIdentity, tenantId: "saved-exact-people", principalId: randomUUID() };
    const service = new SavedAgentPeopleService(fixture.runtime), sources = new UserSourcesRepository(fixture.runtime, "synthetic-exact-people-secret-0000000");
    return { identity, service, sources, directory: (users: Parameters<typeof publishFixtureDirectory>[2], options?: Parameters<typeof publishFixtureDirectory>[3]) =>
      publishFixtureDirectory(fixture.runtime, identity, users, options) };
  }

  it("projects only exact case-normalized IDs on the caller's repeatable-read client, without provider calls or inventory mutation", async () => {
    const h = harness(), observedAt = new Date(Date.now() - 60000), provider = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Provider calls forbidden"));
    await h.directory([fixtureDirectoryUser(firstId)], { observedAt });
    const native = record(h.identity.tenantId, firstId.toUpperCase(), firstId, firstId.toUpperCase());
    await dataConnections(fixture.runtime).selectedRead(async client => {
      const query = vi.spyOn(client, "query"), pool = vi.spyOn(fixture.runtime, "query").mockRejectedValue(new Error("Use the supplied snapshot"));
      try {
        const [result] = await h.service.project(h.identity, [native], client);
        expect(result.people).toEqual({
          owner: { objectId: firstId, displayName: "Saved person", userPrincipalName: "person@example.invalid", observedAt: observedAt.toISOString() },
          createdBy: result.people?.owner, lastModifiedBy: result.people?.owner,
        });
        expect(result.people?.owner).toBe(result.people?.createdBy);
        expect(result.people?.owner).toBe(result.people?.lastModifiedBy);
        expect(result.powerPlatformResource).toEqual(native.powerPlatformResource);
        expect(result.powerPlatformResource).not.toBe(native.powerPlatformResource);
        expect(result.identity).toEqual(native.identity); expect(result.packages).toEqual(native.packages);
        expect(native.people).toBeUndefined();
        const exact = query.mock.calls.filter(([sql]) => String(sql).includes("FROM unnest($4::text[])"));
        expect(exact).toHaveLength(1); expect(exact[0][1]?.[3]).toEqual([firstId]);
        expect(query.mock.calls.filter(([sql]) => String(sql).includes("current_setting('transaction_isolation')"))).toHaveLength(1);
      } finally { pool.mockRestore(); query.mockRestore(); }
    });

    expect(provider).not.toHaveBeenCalled();
  });

  it.each([null, "Guest#EXT#@example.onmicrosoft.com"])("retains nullable cached UPNs and exact guest directory UPNs: %s", async upn => {
    const h = harness();
    if (upn === null) {
      await h.sources.capture(h.identity, "delegated");
      await h.sources.savePeople(h.identity, [{ objectId: firstId, displayName: "Known name", userPrincipalName: null,
        status: "resolved", checkedAt: new Date().toISOString() }], async () => {});
    } else await h.directory([fixtureDirectoryUser(firstId, "Known name", upn)]);
    const [value] = await h.service.project(h.identity, [record(h.identity.tenantId)]);
    expect(value.people?.owner).toMatchObject({ objectId: firstId, displayName: "Known name", userPrincipalName: upn });
    expect(agentColumnValue(value, "owner")).toContain("Known name");
  });

  it.each([true, false])("preserves the newest known directory identity after failed lookup with older cached evidence=%s", async cached => {
    const h = harness(), observedAt = new Date(Date.now() - 60000);
    await h.directory([fixtureDirectoryUser(firstId)], { observedAt });
    if (cached) await h.sources.savePeople(h.identity, [{ objectId: firstId, status: "resolved", displayName: "Old name",
      userPrincipalName: null, checkedAt: new Date(observedAt.getTime() - 60000).toISOString() }], async () => {});
    await h.sources.savePeople(h.identity, [{ objectId: firstId, status: "lookup_failed", displayName: null, userPrincipalName: null,
      checkedAt: new Date().toISOString(), errorCode: "provider_timeout" }], async () => {});
    expect((await h.service.project(h.identity, [record(h.identity.tenantId)]))[0].people?.owner).toMatchObject({
      displayName: "Saved person", observedAt: observedAt.toISOString(), status: "lookup_failed", errorCode: "provider_timeout",
    });
  });

  it("lets newer conclusive not-found clear roster names and resolves an unlicensed cached creator without any directory row", async () => {
    const h = harness();
    await h.directory([fixtureDirectoryUser(firstId)], { observedAt: new Date(Date.now() - 60000) });
    await h.sources.savePeople(h.identity, [
      { objectId: firstId, status: "not_found", displayName: null, userPrincipalName: null, checkedAt: new Date().toISOString() },
      { objectId: secondId, status: "resolved", displayName: "Unlicensed creator", userPrincipalName: null, checkedAt: new Date().toISOString() },
    ], async () => {});
    const [value] = await h.service.project(h.identity, [record(h.identity.tenantId, firstId, secondId)]);
    expect(value.people?.owner).toMatchObject({ status: "not_found", displayName: null });
    expect(value.people?.createdBy).toMatchObject({ displayName: "Unlicensed creator", userPrincipalName: null });
  });

  it("does not guess from names, UPNs, report identities, partial GUIDs or another tenant/principal/token mode", async () => {
    const h = harness();
    for (const identity of [{ ...h.identity, tenantId: "other-tenant" }, { ...h.identity, principalId: "other-principal" }]) {
      await publishFixtureDirectory(fixture.runtime, identity, [fixtureDirectoryUser(firstId)]);
    }
    await h.directory([fixtureDirectoryUser(firstId)], { tokenMode: "application" });
    const native = record(h.identity.tenantId);
    expect((await h.service.project(h.identity, [native]))[0].people).toBeUndefined();
    await h.directory([fixtureDirectoryUser(firstId)]);
    const records = [record(h.identity.tenantId, "Saved person", "person@example.invalid", firstId.slice(1)),
      record(h.identity.tenantId, secondId, null, `{${firstId}}`),
      { ...native, powerPlatformResource: null, presence: "graph_packages" as const }];
    expect((await h.service.project(h.identity, records)).every(value => value.people === undefined)).toBe(true);
  });

  it("removes stale attached people after a complete empty replacement without removing native identifiers", async () => {
    const h = harness();
    await h.directory([fixtureDirectoryUser(firstId)]);
    const [enriched] = await h.service.project(h.identity, [record(h.identity.tenantId)]);
    expect(enriched.people?.owner).toBeDefined();
    await h.directory([]);
    const [result] = await h.service.project(h.identity, [enriched]);
    expect(result.people).toBeUndefined();
    expect(result.powerPlatformResource?.details.ownerId).toBe(firstId);
    expect(result.id).toBe(enriched.id);
  });

  it("projects one caller page with three exact IDs per row using only 100-ID reads and one captured snapshot", async () => {
    const h = harness(), rows = Array.from({ length: 100 }, () => record(h.identity.tenantId, randomUUID(), randomUUID(), randomUUID()));
    await dataConnections(fixture.runtime).selectedRead(async client => {
      const query = vi.spyOn(client, "query");
      try {
        expect(await h.service.project(h.identity, rows, client)).toHaveLength(100);
        const exact = query.mock.calls.filter(([sql]) => String(sql).includes("FROM unnest($4::text[])"));
        expect(exact).toHaveLength(3);
        expect(exact.map(([, parameters]: readonly unknown[]) =>
          Array.isArray(parameters) && Array.isArray(parameters[3]) ? parameters[3].length : null)).toEqual([100, 100, 100]);
        expect(new Set(exact.map(call => (call[1]?.[4] as Date).toISOString())).size).toBe(1);
      } finally { query.mockRestore(); }
    });
    await expect(h.service.project(h.identity, [...rows, rows[0]])).rejects.toMatchObject({ code: "data_page_limit" });
    await expect(h.service.read(h.identity, Array.from({ length: 101 }, () => randomUUID()))).rejects.toThrow("100");
  });

  it("rejects a cross-tenant inventory record before reading and rejects a caller transaction weaker than repeatable read", async () => {
    const h = harness(), query = vi.spyOn(fixture.runtime, "query");
    await expect(h.service.project(h.identity, [record("other-tenant")])).rejects.toMatchObject({ code: "scope_mismatch" });
    expect(query).not.toHaveBeenCalled(); query.mockRestore();
    const client = await fixture.runtime.connect();
    try {
      await client.query("BEGIN");
      await expect(h.service.project(h.identity, [record(h.identity.tenantId)], client)).rejects.toThrow("people_selected_snapshot_required");
    } finally { await client.query("ROLLBACK"); client.release(); }
  });

  it("propagates exact evidence-read failures instead of disguising them as unknown people", async () => {
    const h = harness(), failure = new Error("Saved people database unavailable");
    vi.spyOn(fixture.runtime, "connect").mockRejectedValueOnce(failure);
    await expect(h.service.project(h.identity, [record(h.identity.tenantId)])).rejects.toBe(failure);
  });
});

describe("service-free saved people boundaries", () => {
  afterEach(() => vi.restoreAllMocks());
  const at = new Date("2030-01-01T00:00:00Z");
  function result(rows: pg.QueryResultRow[]): pg.QueryResult {
    return { command: "SELECT", rowCount: rows.length, oid: 0, fields: [], rows };
  }
  function harness() {
    const database = new pg.Pool({ max: 4 }), reader = new pg.Pool({ max: 4 }), client = Object.assign(new pg.Client(), { release: vi.fn() });
    vi.spyOn(database, "connect").mockRejectedValue(new Error("Database acquisition forbidden"));
    vi.spyOn(reader, "connect").mockImplementation(async () => client);
    vi.spyOn(database, "query").mockRejectedValue(new Error("Unscoped query forbidden"));
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Provider calls forbidden"));
    const metadata = vi.spyOn(UserSourcesRepository.prototype, "metadataInRead").mockResolvedValue({
      directory: { source: "directory", generationId: "directory-generation", scopeId: "directory-scope", revision: "1",
        expiresAt: "2030-01-02T00:00:00Z", observedAt: at.toISOString(), attemptedAt: null, attemptStatus: "available",
        attemptObservedCount: null, errorCode: null, message: null, rowCount: 1, state: "available",
        reportRefreshDate: null, period: null, reportVersion: null },
      app_activity: { source: "app_activity", generationId: null, scopeId: null, revision: null, expiresAt: null, observedAt: null,
        attemptedAt: null, attemptStatus: null, attemptObservedCount: null, errorCode: null, message: null, rowCount: null,
        state: "unavailable", reportRefreshDate: null, period: null, reportVersion: null },
    });
    const query = vi.fn<(statement: unknown, parameters?: unknown[]) => Promise<pg.QueryResult>>()
      .mockImplementation(async (statement, parameters) => {
      if (typeof statement !== "string") throw new Error("Expected SQL");
      if (statement.startsWith("BEGIN") || statement === "COMMIT" || statement === "ROLLBACK") {
        return { ...result([]), command: statement.split(" ")[0] };
      }
      if (statement.includes("current_setting('transaction_isolation')")) return result([{ isolation: "repeatable read", now: at }]);
      if (statement.includes("FROM unnest($4::text[])")) return result((parameters?.[3] as string[]).map(id => ({
        id, directory_id: id, display_name: "Known person", upn: null, status: null,
      })));
      throw new Error("Unexpected SQL");
      });
    vi.spyOn(client, "query").mockImplementation(query);
    return { database, client, query, metadata, selected: dataConnections(reader).selectedRead.bind(dataConnections(reader)),
      service: new SavedAgentPeopleService(database),
      scope: { tenantId: "people-tenant", principalId: "people-principal" } };
  }

  it("rejects a client with repeatable-read defaults but no owned selected transaction", async () => {
    const h = harness();
    await expect(h.service.read(h.scope, [firstId], h.client)).rejects.toThrow("people_selected_snapshot_required");
    expect(h.query).not.toHaveBeenCalled(); expect(h.metadata).not.toHaveBeenCalled();
  });

  it("does not reuse a released selected-read client or replace a weaker snapshot with a new acquisition", async () => {
    const h = harness();
    await expect(h.selected(async client => {
      h.query.mockResolvedValueOnce(result([{ isolation: "read committed", now: at }]));
      return h.service.read(h.scope, [firstId], client);
    })).rejects.toThrow("people_selected_snapshot_required");
    h.query.mockClear();
    await expect(h.service.read(h.scope, [firstId], h.client)).rejects.toThrow("people_selected_snapshot_required");
    expect(h.query).not.toHaveBeenCalled(); expect(h.metadata).not.toHaveBeenCalled();
    expect(h.database.connect).not.toHaveBeenCalled();
  });

  it.each(["graph presence", "wrong native source", "missing native source"] as const)(
    "rejects %s rather than attaching directory people to invalid source records", async shape => {
      const h = harness(), native = record(h.scope.tenantId);
      if (shape === "graph presence") native.presence = "graph_packages";
      if (shape === "wrong native source") Object.assign(native.powerPlatformResource!, { sourceSystem: "graph_packages" });
      if (shape === "missing native source") Reflect.deleteProperty(native.powerPlatformResource!, "sourceSystem");
      await expect(h.service.project(h.scope, [native], h.client)).rejects.toMatchObject({ code: "saved_source_invalid" });
      expect(h.query).not.toHaveBeenCalled(); expect(h.metadata).not.toHaveBeenCalled();
    },
  );

  it("refreshes derived person columns when old overlays disappear, without changing unrelated columns", async () => {
    const h = harness(), native = record(h.scope.tenantId, ` ${firstId} `, null, "opaque-person");
    native.columns = { owner: "Old directory owner", createdBy: "Old directory creator", displayName: "Selected label" };
    native.people = { owner: { objectId: firstId, displayName: "Old directory owner", userPrincipalName: null, observedAt: at.toISOString() } };
    const [projected] = await h.service.project(h.scope, [native], h.client);
    expect(projected.people).toBeUndefined();
    expect(projected.columns).toEqual({ owner: ` ${firstId} `, createdBy: null, displayName: "Selected label" });
    expect(agentColumnValue(projected, "owner")).toBe(` ${firstId} `);
    expect(agentColumnValue(projected, "createdBy")).toBeNull();
    expect(native.columns.owner).toBe("Old directory owner");
    expect(h.query).not.toHaveBeenCalled();
  });

  it.each(["resolved", "not_found", "lookup_failed", "missing"] as const)(
    "updates existing derived columns with %s selected evidence and preserves the native IDs", async status => {
      const h = harness(), native = record(h.scope.tenantId);
      native.presence = "both";
      native.columns = { owner: "Stale owner", createdBy: "Stale creator", displayName: "Selected label" };
      const [projected] = await h.selected(async client => {
        h.query.mockResolvedValueOnce(result([{ isolation: "repeatable read", now: at }]));
        h.query.mockResolvedValueOnce(result(status === "missing" ? [] : [{
          id: firstId, directory_id: firstId, display_name: "Known person", upn: null, status,
          cached_name: status === "not_found" ? null : "Cached person", cached_upn: null, checked_at: at,
          resolved_at: status === "not_found" ? null : new Date(at.getTime() - (status === "lookup_failed" ? 60_000 : 0)),
          expires_at: new Date(at.getTime() + 60_000), error_code: status === "lookup_failed" ? "provider_timeout" : null,
        }]));
        return h.service.project(h.scope, [native], client);
      });
      const label = status === "resolved" ? "Cached person" : status === "not_found" ? `${firstId} (not found)`
        : status === "lookup_failed" ? "Known person (lookup failed)" : firstId;
      expect(projected.columns).toEqual({ owner: label, createdBy: label, displayName: "Selected label" });
      expect(agentColumnValue(projected, "owner")).toBe(label);
      expect(agentColumnValue(projected, "createdBy")).toBe(label);
      expect(projected.powerPlatformResource).toEqual(native.powerPlatformResource);
      expect(projected.people?.createdBy?.status).toBe(status === "missing" ? undefined : status);
      expect(projected.people?.createdBy?.errorCode).toBe(status === "lookup_failed" ? "provider_timeout" : undefined);
      expect(native.columns.owner).toBe("Stale owner"); expect(native.people).toBeUndefined();
    },
  );

  it("captures the page and exact scope before awaiting evidence and detaches returned inventory", async () => {
    const h = harness(), native = record(h.scope.tenantId);
    const rows = [native], originalScope = { ...h.scope }, original = structuredClone(native);
    const [projected] = await h.selected(async client => {
      let finish!: (value: pg.QueryResult) => void;
      h.query.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
      const pending = h.service.project(h.scope, rows, client);
      h.scope.tenantId = "changed-tenant"; h.scope.principalId = "changed-principal";
      native.displayName = "Changed"; native.powerPlatformResource!.details.ownerId = secondId;
      rows.push(record("other-tenant"));
      finish(result([{ isolation: "repeatable read", now: at }]));
      return pending;
    });
    expect(h.metadata).toHaveBeenCalledWith(h.client, { ...originalScope, tokenMode: "delegated" }, at);
    expect(h.query).toHaveBeenCalledWith(expect.stringContaining("FROM unnest($4::text[])"),
      [originalScope.tenantId, originalScope.principalId, "directory-generation", [firstId], at, "delegated"]);
    expect(projected).toMatchObject(original);
    expect(projected.people?.owner).toBe(projected.people?.createdBy);
    expect(projected.people?.owner).toBe(projected.people?.lastModifiedBy);
    projected.powerPlatformResource!.details.lastModifiedBy = secondId;
    expect(native.powerPlatformResource!.details.lastModifiedBy).toBe(firstId);
    expect(native.people).toBeUndefined();
  });

  it.each(["accessor", "inherited", "proxy", "sparse"] as const)("rejects %s inventory without executing user code or reading evidence", async shape => {
    const h = harness(), native = record(h.scope.tenantId), invoked = vi.fn(() => firstId);
    let rows = [native];
    if (shape === "accessor") Object.defineProperty(native.powerPlatformResource!.details, "ownerId", { get: invoked, enumerable: true });
    if (shape === "inherited") native.powerPlatformResource!.details = Object.create({ get ownerId() { return invoked(); } });
    if (shape === "proxy") native.powerPlatformResource!.details = new Proxy(native.powerPlatformResource!.details, {
      ownKeys: () => { invoked(); throw new Error("Proxy executed"); },
    });
    if (shape === "sparse") rows = new Array<UnifiedAgentRecord>(1);
    await expect(h.service.project(h.scope, rows, h.client)).rejects.toMatchObject({ code: "saved_source_invalid" });
    expect(invoked).not.toHaveBeenCalled(); expect(h.query).not.toHaveBeenCalled(); expect(h.metadata).not.toHaveBeenCalled();
  });

  it.each(["inherited", "accessor", "proxy"] as const)("rejects %s authorization scope before reading evidence", async shape => {
    const h = harness(), invoked = vi.fn(() => h.scope.tenantId);
    const scope = shape === "inherited" ? Object.create(h.scope) : shape === "proxy" ? new Proxy(h.scope, {
      getOwnPropertyDescriptor: () => { invoked(); throw new Error("Proxy executed"); },
    }) : Object.defineProperty({ ...h.scope }, "tenantId", { get: invoked });
    await expect(h.service.read(scope, [firstId], h.client)).rejects.toMatchObject({ code: "scope_mismatch" });
    expect(invoked).not.toHaveBeenCalled(); expect(h.query).not.toHaveBeenCalled();
  });

  it.each(["accessor", "inherited", "proxy"] as const)("rejects %s exact-ID collections without evaluating their entries", shape => {
    const invoked = vi.fn(() => firstId), ids = shape === "inherited" ? Object.create([firstId]) : [firstId];
    if (shape === "accessor") Object.defineProperty(ids, "0", { get: invoked });
    const input = shape === "proxy" ? new Proxy(ids, { get: () => { invoked(); throw new Error("Proxy executed"); } }) : ids;
    expect(() => userSourceObjectIds(input)).toThrow(expect.objectContaining({ code: "data_exact_ids_limit" }));
    expect(invoked).not.toHaveBeenCalled();
  });

  it("bounds multibyte page evidence before database work, not only record count", async () => {
    const h = harness(), native = record(h.scope.tenantId);
    native.displayName = "界".repeat(400_000);
    await expect(h.service.project(h.scope, [native], h.client)).rejects.toMatchObject({ code: "data_response_bytes" });
    expect(h.query).not.toHaveBeenCalled();
  });

  it("bounds the final enriched page as well as the caller's inventory", async () => {
    const h = harness(), native = record(h.scope.tenantId);
    native.displayName = "";
    native.displayName = "x".repeat(1_048_576 - Buffer.byteLength(JSON.stringify([native])) - 256);
    expect(Buffer.byteLength(JSON.stringify([native]))).toBeLessThan(1_048_576);
    await expect(h.selected(client => h.service.project(h.scope, [native], client))).rejects.toMatchObject({ code: "data_response_bytes" });
    expect(h.metadata).toHaveBeenCalledOnce();
    expect(h.query.mock.calls.filter(([sql]) => String(sql).includes("FROM unnest($4::text[])"))).toHaveLength(1);
  });

  it("keeps opaque and padded identities exact, canonicalizes only GUID case and removes stale overlays", async () => {
    const h = harness(), native = record(h.scope.tenantId, ` ${firstId} `, firstId.toUpperCase(), "Opaque_ABC:/?😀");
    native.people = { owner: { objectId: firstId, displayName: "Stale", userPrincipalName: null, observedAt: at.toISOString() } };
    const [projected] = await h.selected(client => h.service.project(h.scope, [native], client));
    expect(projected.people).toEqual({ createdBy: {
      objectId: firstId, displayName: "Known person", userPrincipalName: null, observedAt: at.toISOString(),
    } });
    expect(projected.powerPlatformResource).toEqual(native.powerPlatformResource);
    expect(agentColumnValue(projected, "owner")).toBe(` ${firstId} `);
    expect(h.query).toHaveBeenCalledWith(expect.stringContaining("FROM unnest($4::text[])"),
      [h.scope.tenantId, h.scope.principalId, "directory-generation", [firstId], at, "delegated"]);
  });
});
