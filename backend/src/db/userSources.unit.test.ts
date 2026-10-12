import pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { digest } from "./dataBounds.js";
import { UserSourcesRepository, userSourceFilter, type UserSourceReadContext } from "./userSources.js";
import { canonicalQuery, type SelectionIdentity } from "../services/dataSelections.js";
import { directorySourceRecord } from "../services/userSourceRecords.js";
import type { UnifiedAgentRecord } from "../types/unifiedAgents.js";

afterEach(() => { vi.restoreAllMocks(); });

const identity: SelectionIdentity = {
  tenantId: "source-tenant", principalId: "source-principal", authorizationHash: "a".repeat(64), sessionEpoch: "0",
};
const literal = "㍍".repeat(256);
const at = new Date("2030-01-01T00:00:00Z");

function result(rows: pg.QueryResultRow[] = []): pg.QueryResult {
  return { command: "SELECT", rowCount: rows.length, oid: 0, fields: [], rows };
}
function fixture() {
  const database = new pg.Pool({ max: 4 }), client = Object.assign(new pg.Client(), { release: vi.fn() });
  vi.spyOn(database, "connect").mockRejectedValue(new Error("Unexpected database acquisition"));
  const repository = new UserSourcesRepository(database, "synthetic-source-unit-cursor-secret");
  const context: UserSourceReadContext = {
    evaluatedAt: at, scope: { ...identity, tokenMode: "delegated" }, query: { sort: "name", order: "asc" }, queryHash: digest("source-query"),
    selection: { id: "selected", revision: "revision", evaluatedAt: at.toISOString(), expiresAt: new Date(at.getTime() + 600_000).toISOString() },
    metadata: {
      directory: { source: "directory", generationId: "generation", scopeId: "scope", revision: "1", expiresAt: "2030-01-02T00:00:00Z",
        observedAt: at.toISOString(), attemptedAt: at.toISOString(), attemptStatus: "available", attemptObservedCount: 3,
        errorCode: null, message: null, rowCount: 3, state: "available", reportRefreshDate: null, period: null, reportVersion: null },
      app_activity: { source: "app_activity", generationId: null, scopeId: null, revision: null, expiresAt: null, observedAt: null,
        attemptedAt: null, attemptStatus: null, attemptObservedCount: null, errorCode: null, message: null, rowCount: null,
        state: "unavailable", reportRefreshDate: null, period: null, reportVersion: null },
    },
  };
  vi.spyOn(repository, "read").mockImplementation(async (_id, _identity, work) => work(client, context));
  vi.spyOn(repository, "countsInRead").mockResolvedValue({ total: 3, filtered: 3 });
  vi.spyOn(repository, "summaryInRead").mockResolvedValue({ checkedUsers: 3, licensedUsers: 0, inactivePaidUsers: 0,
    noPaidUsers: 3, unknownLicenseUsers: 0, activeAppUsers: null, unknownAppUsers: 3 });
  const query = vi.fn<(statement: unknown, values?: unknown[]) => Promise<pg.QueryResult>>();
  vi.spyOn(client, "query").mockImplementation(query);
  return { repository, query, client, context };
}

describe("wide normalized source cursor boundaries", () => {
  it.each(["users", "facets"] as const)("keeps legal Unicode %s pages navigable within 4 KiB", async endpoint => {
    const { repository, query } = fixture();
    const rows = ["a", "b", "c"].map((id, index) => {
      const name = endpoint === "users" ? "\ufdfa".repeat(512) : literal;
      const record = directorySourceRecord({
        identity: { objectId: `00000000-0000-0000-0000-00000000000${index}`, userPrincipalName: `${id}@example.invalid`,
          displayName: name, companyName: literal, department: null, accountEnabled: true, userType: null, employeeType: null },
        copilotServiceState: "disabled", servicePlans: [], serviceEvidenceVersion: 1,
      });
      return endpoint === "users" ? { ...record, page_key: record.sort_key, activity_identity: null, activity_state: "unknown", entitlement: "no_paid" }
        : { identity: `${literal.slice(0, -1)}${id}`, value: `${literal.slice(0, -1)}${id}`,
          page_key: `${literal.slice(0, -1).normalize("NFKC")}${id}`, count: "1" };
    });
    let position = 0;
    query.mockImplementation(async (statement, values) => {
      if (typeof statement !== "string") throw new Error("Unexpected query shape");
      if (statement.includes("SELECT page_key,identity FROM ordered")) {
        const anchor = rows.find(row => digest(row.identity) === values?.at(-1));
        return result(anchor ? [anchor] : []);
      }
      if (statement.includes("AS total")) return result([{ total: "3", filtered: "3" }]);
      const current = position++ === 0 ? rows.slice(0, 2) : position === 2 ? rows.slice(1) : rows.slice(0, 1);
      return result(current);
    });
    const page = (cursor?: string) => endpoint === "users"
      ? repository.page("selected", identity, { limit: 1, cursor })
      : repository.facets("selected", identity, { field: "company", limit: 1, cursor });
    const first = await page();
    expect(Buffer.byteLength(first.page.nextCursor!)).toBeLessThanOrEqual(4096);
    const second = await page(first.page.nextCursor!);
    const previous = await page(second.page.previousCursor!);
    expect(second.value).not.toEqual(first.value);
    expect(previous.value).toEqual(first.value);
    if (endpoint === "users") {
      expect(first.value[0]).toMatchObject({ directory: { displayName: "\ufdfa".repeat(512) } });
      expect(query).toHaveBeenCalledWith(expect.stringContaining('left(coalesce(page_key,\'\'),128) COLLATE "C" ASC,coalesce(page_key,\'\') COLLATE "C" ASC'),
        expect.any(Array));
    }
    const lookups = query.mock.calls.filter(([statement]) => typeof statement === "string" && statement.includes("SELECT page_key,identity FROM ordered"));
    expect(lookups).toHaveLength(2);
    const parameters = ["generation", null, false, ...(endpoint === "facets" ? [""] : [])];
    expect(lookups[0][1]).toEqual([...parameters, digest(rows[0].identity)]);
    expect(query).toHaveBeenCalledWith(expect.stringContaining('identity COLLATE "C")\n      >'),
      [...parameters, 0, rows[0].page_key, rows[0].identity, 2]);
    expect(query).toHaveBeenCalledWith(expect.stringContaining('identity COLLATE "C")\n      <'),
      [...parameters, 0, rows[1].page_key, rows[1].identity, 2]);
    query.mockClear();
    await expect(page(`${first.page.nextCursor}x`)).rejects.toMatchObject({ code: "invalid_cursor" });
    expect(query).not.toHaveBeenCalled();
    query.mockResolvedValue(result());
    await expect(page(first.page.nextCursor!)).rejects.toMatchObject({ code: "selection_invalidated" });
  });
});

describe("source selection search canonicalization", () => {
  it.each(["J\u030c", " \u00a8 ", "\u337f".repeat(64), "\u0130".repeat(128)])(
    "rereads accepted normalized search without changing its query hash: %s", async search => {
      const { repository, query, client, context } = fixture();
      const filters = userSourceFilter({ search });
      const hash = canonicalQuery(filters, ["search", "sort", "order"]);
      query.mockResolvedValue(result([{ token_mode: "delegated", metadata: context.metadata }]));
      const restored = await repository.contextInRead(client, identity, {
        selection: { id: context.selection.id, query_json: filters, query_hash: hash,
          evaluated_at: at, expires_at: new Date(context.selection.expiresAt), revision: context.selection.revision },
        pins: [{ root_kind: "user_sources" }, { generation_id: "generation", scope_id: "scope" }],
      });
      expect(restored.query).toEqual(filters);
      expect(restored.queryHash).toBe(hash);
      expect(filters.search!.length).toBeLessThanOrEqual(256);
    });

  it.each(["\u337f".repeat(65), "\u0130".repeat(129), "a\u0085", "\ud800"])(
    "rejects expanded or invalid search before scope admission: %j", async search => {
      const { repository, query } = fixture();
      const ensure = vi.spyOn(repository, "ensureScope").mockRejectedValue(new Error("Unexpected scope admission"));
      await expect(repository.capture(identity, "delegated", { search })).rejects.toMatchObject({ code: "invalid_cursor", status: 400 });
      expect(ensure).not.toHaveBeenCalled();
      expect(query).not.toHaveBeenCalled();
    });

  it("folds searched SQL columns the same way as a persisted selection", async () => {
    const { repository, query, context } = fixture();
    context.query = userSourceFilter({ search: "J\u030c" });
    query.mockResolvedValue(result());
    await repository.page("selected", identity);
    expect(query).toHaveBeenCalledWith(expect.stringContaining("strpos(normalize(lower(normalize(upn,NFKC) COLLATE \"default\"),NFKC),$4)"),
      ["generation", null, false, "\u01f0", 51]);
  });

  it("reuses facet cursors across equivalent canonical searches", async () => {
    const { repository, query } = fixture();
    query.mockImplementation(async statement => {
      if (typeof statement !== "string") throw new Error("Unexpected query shape");
      if (statement.includes("AS total")) return result([{ total: "2", filtered: "2" }]);
      return result(["a", "b"].map(value => ({ identity: value, value, page_key: value, count: "1" })));
    });
    const first = await repository.facets("selected", identity, { field: "company", search: "J\u030c", limit: 1 });
    await expect(repository.facets("selected", identity, { field: "company", search: "\u01f0", limit: 1, cursor: first.page.nextCursor! }))
      .resolves.toMatchObject({ selection: first.selection });
    expect(query.mock.calls[0][0]).toContain("strpos(normalize(lower(normalize(coalesce(company,''),NFKC) COLLATE \"default\"),NFKC),$4)");
    expect(query.mock.calls[0][1]?.slice(0, 4)).toEqual(["generation", null, false, "\u01f0"]);
  });
});

it("uses a compact facet anchor when a stored identity exceeds the decoder bound, even below 4 KiB", async () => {
  const { repository, query } = fixture();
  const rows = ["a", "b"].map(suffix => ({ identity: `${"x".repeat(512)}${suffix}`, value: `${"x".repeat(512)}${suffix}`,
    page_key: `${"x".repeat(512)}${suffix}`, count: "1" }));
  query.mockImplementation(async (statement, values) => {
    if (typeof statement !== "string") throw new Error("Unexpected query shape");
    if (statement.includes("SELECT page_key,identity FROM ordered")) return result(rows.filter(row => digest(row.identity) === values?.at(-1)));
    if (statement.includes("AS total")) return result([{ total: "2", filtered: "2" }]);
    return result(rows);
  });

  const first = await repository.facets("selected", identity, { field: "company", limit: 1 });
  await expect(repository.facets("selected", identity, { field: "company", limit: 1, cursor: first.page.nextCursor! })).resolves.toBeDefined();
  expect(query).toHaveBeenCalledWith(expect.stringContaining("SELECT page_key,identity FROM ordered"),
    ["generation", null, false, "", digest(rows[0].identity)]);
});

describe("selected people input snapshots", () => {
  it("uses captured exact IDs after selected-read acquisition yields", async () => {
    const { repository, query, client, context } = fixture(), objectId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const ids = [objectId];
    query.mockResolvedValue(result());
    vi.spyOn(repository, "read").mockImplementationOnce(async (_id, _identity, work) => {
      ids[0] = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
      await Promise.resolve();
      return work(client, context);
    });
    await repository.people("selected", identity, ids);
    expect(query).toHaveBeenCalledWith(expect.stringContaining("FROM unnest($4::text[])"),
      [identity.tenantId, identity.principalId, "generation", [objectId], at, "delegated"]);
  });

  it("projects the captured inventory and selection identity rather than post-await caller mutations", async () => {
    const { repository, query, client, context } = fixture(), objectId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const selectedIdentity = { ...identity };
    const records: UnifiedAgentRecord[] = [{
      id: "agent:11111111-1111-4111-8111-111111111111", displayName: "Original", presence: "power_platform",
      columns: { owner: "Old name", createdBy: "Old name", displayName: "Selected display name" },
      environmentId: null, packages: [], identity: { state: "unmatched", reason: null, evidence: [], packageEvidence: [] },
      observations: { graphPackages: null, powerPlatform: null, packageSnapshots: {} },
      powerPlatformResource: { tenantId: identity.tenantId, nativeId: "native", type: "microsoft.copilotstudio/agents",
        environmentId: null, location: null, displayName: "Original", createdAt: null, createdBy: objectId,
        lastPublishedAt: null, sourceSystem: "power_platform", authoringTool: null, creatorType: "unknown",
        agentKind: "agent", lifecycle: "unknown", identityConfidence: "exact_native", identifiers: [], provenance: {},
        details: { ownerId: objectId }, unknownFieldCount: 0 },
    }];
    query.mockResolvedValue(result([{ id: objectId, directory_id: objectId, display_name: "Saved name", upn: null, status: null }]));
    vi.spyOn(repository, "read").mockImplementationOnce(async (_id, capturedIdentity, work) => {
      selectedIdentity.tenantId = "other-tenant";
      records[0].powerPlatformResource!.details.ownerId = "changed-owner";
      records[0].displayName = "Changed";
      await Promise.resolve();
      expect(capturedIdentity).toEqual(identity);
      return work(client, context);
    });
    const [projected] = await repository.projectPeople("selected", selectedIdentity, records);
    expect(projected.displayName).toBe("Original");
    expect(projected.powerPlatformResource?.details.ownerId).toBe(objectId);
    expect(projected.people?.owner?.displayName).toBe("Saved name");
    expect(projected.people?.owner).toBe(projected.people?.createdBy);
    expect(projected.columns).toEqual({ owner: "Saved name", createdBy: "Saved name", displayName: "Selected display name" });
    expect(records[0].columns?.owner).toBe("Old name");
    expect(records[0].people).toBeUndefined();
  });
});
