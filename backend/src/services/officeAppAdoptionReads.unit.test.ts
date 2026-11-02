import pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { digest } from "../db/dataBounds.js";
import { officeRequestQuery } from "../routes/officeAppAdoption.js";
import type { OfficeContext, OfficePerson, OfficeQuery } from "../types/officeAppAdoption.js";
import type { SelectionIdentity } from "./dataSelections.js";
import { emptyOfficeCoverage } from "./officeAppAdoption.js";
import { OfficeAppAdoptionReads } from "./officeAppAdoptionReads.js";
import { directorySourceRecord } from "./userSourceRecords.js";
import { flushDataWorkMetrics } from "./dataMetrics.js";

vi.mock("../db/pool.js", () => ({
  pool: {},
  secretValue: (name: string) => name === "TENANTS_JSON" ? "[]"
    : name === "SESSION_SECRET" ? "synthetic-office-selection-unit-session-secret" : undefined,
}));

const identity: SelectionIdentity = {
  tenantId: "11111111-1111-4111-8111-111111111111", principalId: "office-pagination-reader",
  authorizationHash: digest("office-pagination-role"), sessionEpoch: "0",
};
const groupId = digest("office-pagination-group");
const now = new Date("2026-11-01T12:00:00Z");
const context: OfficeContext = {
  query: {}, baseline: null, status: { state: "available", errorCode: null, message: null },
  observation: {
    id: "22222222-2222-4222-8222-222222222222", kind: "current", period: "D28", reportVersion: "v2",
    reportRefreshDate: "2026-11-01", windowStart: "2026-10-05", capturedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 86400000).toISOString(), contentHash: digest("office-pagination"),
    directoryGenerationId: "33333333-3333-4333-8333-333333333333",
    appGenerationId: "44444444-4444-4444-8444-444444444444",
    directoryObservedAt: now.toISOString(), appObservedAt: now.toISOString(), coverage: emptyOfficeCoverage(),
  },
  selection: {
    id: "55555555-5555-4555-8555-555555555555", revision: "66666666-6666-4666-8666-666666666666",
    evaluatedAt: now.toISOString(), validatedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 600000).toISOString(),
    publicationRevisions: { users: "1", graph_packages: "1", power_platform: "1" },
  },
};

function person(index: number, displayName: string): OfficePerson {
  return {
    identity: `77777777-7777-4777-8777-${String(index).padStart(12, "0")}`, displayName,
    userPrincipalName: `person-${index}@example.invalid`, company: "Example", department: "Office", groupId,
    entitlement: "paid_active", serviceState: "enabled", directoryObservedAt: now.toISOString(),
    appObservedAt: now.toISOString(), appReportRefreshDate: "2026-11-01",
    dates: { word: "2026-11-01", excel: null, powerpoint: null, outlook: null, onenote: null, loop: null, teams: null },
    recentApps: ["word"], latestRecentDate: "2026-11-01", unknownReasons: [],
  };
}

function peopleReads(people: OfficePerson[], observation = context.observation) {
  const database = new pg.Pool({ max: 4 });
  const client = Object.assign(new pg.Client(), { release: vi.fn() });
  vi.spyOn(database, "connect").mockRejectedValue(new Error("Unexpected database connection"));
  vi.spyOn(database, "query").mockRejectedValue(new Error("Unexpected pool query"));
  const result = (rows: pg.QueryResultRow[]): pg.QueryResult =>
    ({ rows, rowCount: rows.length, command: "SELECT", fields: [], oid: 0 });
  const name = (value: OfficePerson) => (value.displayName?.trim() || value.userPrincipalName)
    .normalize("NFKC").toLowerCase().normalize("NFKC");
  const sorted = [...people].sort((a, b) => {
    const order = Buffer.compare(Buffer.from(name(a)), Buffer.from(name(b)));
    return order || a.identity.localeCompare(b.identity);
  });
  const query = vi.fn(async (statement: unknown, values?: unknown[]) => {
    if (typeof statement !== "string" || !values) throw new Error("Unexpected query shape");
    if (statement.startsWith("SELECT count(*)")) return result([{ total: String(people.length), filtered: String(people.length) }]);
    if (statement.includes(" AS sort_name") && !statement.startsWith("SELECT payload")) {
      const boundary = sorted.find(value => value.identity === values[3]);
      return result(boundary ? [{ sort_name: name(boundary) }] : []);
    }
    if (statement.startsWith("SELECT payload,identity")) {
      let rows = sorted;
      if (statement.includes("AND (")) {
        const index = sorted.findIndex(value => value.identity === values[5]);
        rows = statement.includes('COLLATE "C") <') ? sorted.slice(0, index).reverse() : sorted.slice(index + 1);
      } else rows = sorted.slice(Number(values[4]));
      return result(rows.slice(0, Number(values[3])).map(value =>
        ({ identity: value.identity, payload: value, sort_name: name(value) })));
    }
    throw new Error(`Unexpected Office read: ${statement}`);
  });
  vi.spyOn(client, "query").mockImplementation(query);
  class MockOfficeReads extends OfficeAppAdoptionReads {
    override read<T>(actor: SelectionIdentity, input: OfficeQuery, _selectionId: string | undefined,
      work: (connection: pg.PoolClient, read: { context: OfficeContext; identity: SelectionIdentity; queryHash: string }) => Promise<T>) {
      return work(client, { context: { ...context, observation, query: input }, identity: actor, queryHash: digest(JSON.stringify(input)) });
    }
  }
  return { reads: new MockOfficeReads(database, "synthetic-office-pagination-cursor-secret"), query };
}

afterEach(() => { flushDataWorkMetrics(); vi.restoreAllMocks(); });

function selectionReads(weeklyExpiry: Date | null, hasObservation = true) {
  const database = new pg.Pool({ max: 4 });
  const client = Object.assign(new pg.Client(), { release: vi.fn() });
  vi.spyOn(database, "connect").mockImplementation(async () => client);
  vi.spyOn(database, "query").mockRejectedValue(new Error("Unexpected pool query"));
  const historyScope = "88888888-8888-4888-8888-888888888888";
  const observationScope = "99999999-9999-4999-8999-999999999999";
  const pins: pg.QueryResultRow[] = [];
  let saved: pg.QueryResultRow | undefined;
  let clock = now;
  const result = (rows: pg.QueryResultRow[] = [], command = "SELECT"): pg.QueryResult =>
    ({ rows, rowCount: rows.length, command, fields: [], oid: 0 });
  const query = vi.fn(async (statement: unknown, values?: unknown[]) => {
    if (typeof statement !== "string") throw new Error("Unexpected query shape");
    if (statement.startsWith("SELECT id,epoch::text FROM data_scope_epochs")) return result([{ id: historyScope, epoch: "1" }]);
    if (statement.startsWith("SELECT epoch FROM data_principal_epochs")) return result([{ epoch: identity.sessionEpoch }]);
    if (statement === "SELECT clock_timestamp() AS now") return result([{ now: clock }]);
    if (statement.startsWith("SELECT count(*)::int AS tenant")) return result([{ tenant: 0, principal: 0 }]);
    if (statement.startsWith("SELECT o.generation_id,o.scope_id")) return result(hasObservation ? [{
      generation_id: context.observation!.id, scope_id: observationScope, revision: "1",
      expires_at: new Date(context.observation!.expiresAt), report_refresh_date: context.observation!.reportRefreshDate,
    }] : []);
    if (statement.startsWith("SELECT min(g.expires_at)")) {
      expect(statement).toContain("o.kind='weekly'");
      expect(statement).toContain("o.report_refresh_date<=$2::date");
      expect(statement).toContain("g.observed_at<=$3::timestamptz");
      expect(statement).toContain("g.expires_at>$3::timestamptz");
      expect(values).toEqual([identity.tenantId, hasObservation ? context.observation!.reportRefreshDate : null, now]);
      return result([{ expires_at: hasObservation ? weeklyExpiry : null }]);
    }
    if (statement.startsWith("SELECT * FROM data_scope_epochs")) return result([{ principal_id: null, epoch: "1", session_epoch: "0" }]);
    if (statement.startsWith("SELECT id FROM data_scope_epochs")) return result([{ id: historyScope }]);
    if (statement.startsWith("SELECT g.id FROM data_generations") || statement.startsWith("SELECT o.generation_id ")) return result([{ id: context.observation!.id }]);
    if (statement.startsWith("INSERT INTO data_read_selections")) {
      if (!values) throw new Error("Missing selection parameters");
      saved = {
        id: values[0], tenant_id: values[1], principal_id: values[2], authorization_hash: values[3],
        endpoint: values[4], query_hash: values[5], evaluated_at: values[6], expires_at: values[7],
        revision: values[8], session_epoch: values[9], query_json: JSON.parse(String(values[10])), root_count: values[11],
      };
      return result();
    }
    if (statement.startsWith("INSERT INTO data_generation_pins")) {
      if (!values) throw new Error("Missing pin parameters");
      pins.push({
        selection_id: values[0], tenant_id: values[1], ordinal: values[2], scope_id: values[3],
        scope_epoch: values[4], session_epoch: values[5], root_kind: values[6], generation_id: values[7],
        revision: values[8], expires_at: values[9],
      });
      return result();
    }
    if (statement.startsWith("SELECT invalidated_at,expires_at<=clock_timestamp()")) {
      return result(saved ? [{ invalidated_at: null, expired: saved.expires_at <= clock }] : []);
    }
    if (statement.startsWith("SELECT *,expires_at<=clock_timestamp()")) {
      return result(pins.map(pin => ({ ...pin, expired: pin.expires_at <= clock })));
    }
    if (statement.startsWith("SELECT *,clock_timestamp() AS validated_at")) {
      return result(saved ? [{
        ...saved, validated_at: clock, expired: saved.expires_at <= clock,
        dependencies_expired: pins.some(pin => pin.expires_at <= clock),
      }] : []);
    }
    if (statement.startsWith("SELECT o.*,g.observed_at AS captured_at")) return result([{
      kind: context.observation!.kind, report_refresh_date: context.observation!.reportRefreshDate,
      captured_at: now, expires_at: new Date(context.observation!.expiresAt), content_hash: context.observation!.contentHash,
      directory_generation_id: context.observation!.directoryGenerationId, app_generation_id: context.observation!.appGenerationId,
      directory_observed_at: now, app_observed_at: now, coverage: context.observation!.coverage,
    }]);
    if (statement.startsWith("SELECT EXISTS(SELECT 1 FROM office_observations o")) {
      return result([{ expired: weeklyExpiry !== null && weeklyExpiry > now && weeklyExpiry <= clock }]);
    }
    if (statement.startsWith("SELECT g.id,s.id AS scope_id,s.source") || statement.startsWith("WITH markers AS (")) return result();
    if (statement.startsWith("SELECT count(*)::text AS count")) return result([{ count: "0" }]);
    if (statement.startsWith("SELECT o.generation_id,o.metrics")) return result();
    if (statement.startsWith("INSERT INTO data_") || statement.startsWith("BEGIN") || statement === "ROLLBACK") return result();
    if (statement === "COMMIT") return result([], "COMMIT");
    if (statement.includes("pg_advisory_unlock")) return result([{ unlocked: true }]);
    if (statement.includes("pg_advisory_lock")) return result();
    throw new Error(`Unexpected Office selection query: ${statement}`);
  });
  vi.spyOn(client, "query").mockImplementation(query);
  return {
    reads: new OfficeAppAdoptionReads(database, "synthetic-office-selection-unit-cursor-secret"), pins, query,
    setClock: (value: Date) => { clock = value; },
  };
}

describe("Office timeline selection expiry without a database", () => {
  it.each(["界", "\u0001"])("captures complete supported %j directory filters with a multibyte search", async character => {
    const company = character.repeat(256), department = character.repeat(256), search = "界".repeat(256);
    const directory = directorySourceRecord({
      serviceEvidenceVersion: 1, copilotServiceState: "disabled", servicePlans: [],
      identity: {
        objectId: "11111111-1111-4111-8111-111111111111", userPrincipalName: "reader@example.invalid",
        displayName: "Reader", accountEnabled: true, companyName: company, department, userType: null, employeeType: null,
      },
    });
    const { query } = officeRequestQuery({ company: `~string:${directory.company}`, department: `~string:${directory.department}`, search });
    expect(query).toEqual({ company, department, search });
    expect(Buffer.byteLength(JSON.stringify(query))).toBeGreaterThan(2048);
    const { reads, query: statements } = selectionReads(null, false);
    await expect(reads.context(identity, query)).resolves.toMatchObject({ query, observation: null, status: { state: "waiting_sources" } });
    const stored = statements.mock.calls.find(([statement]) => String(statement).startsWith("INSERT INTO data_read_selections"))?.[1]?.[10];
    expect(JSON.parse(String(stored))).toEqual(query);
  });

  it.each([
    { weeklyExpiry: new Date(now.getTime() + 5_000), hasObservation: true, expectedOffset: 5_000 },
    { weeklyExpiry: new Date(now.getTime() + 900_000), hasObservation: true, expectedOffset: 600_000 },
    { weeklyExpiry: null, hasObservation: true, expectedOffset: 600_000 },
    { weeklyExpiry: new Date(now.getTime() + 5_000), hasObservation: false, expectedOffset: 600_000 },
  ])("bounds the history fence to the selected timeline ($expectedOffset ms, observation=$hasObservation)", async ({ weeklyExpiry, hasObservation, expectedOffset }) => {
    const { reads, pins } = selectionReads(weeklyExpiry, hasObservation);
    const captured = await reads.capture(identity);
    const expectedExpiry = new Date(now.getTime() + expectedOffset);
    expect(captured.expiresAt).toEqual(expectedExpiry);
    expect(pins.find(pin => pin.root_kind === "office_history")?.expires_at).toEqual(expectedExpiry);
    expect(pins).toHaveLength(hasObservation ? 2 : 1);
    await expect(reads.context(identity, {}, captured.id)).resolves.toMatchObject({
      observation: hasObservation ? context.observation : null,
      selection: { id: captured.id, expiresAt: expectedExpiry.toISOString() },
    });
  });

  it("automatically serves the first selected context, summary and empty history before sources exist", async () => {
    const { reads } = selectionReads(null, false);
    const initial = await reads.context(identity, {});
    expect(initial.observation).toBeNull();
    expect(initial.status.state).toBe("waiting_sources");
    expect(initial.selection).toMatchObject({
      evaluatedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 600_000).toISOString(),
    });
    await expect(reads.summary(identity, {}, initial.selection.id)).resolves.toMatchObject({
      organization: null, matching: null, matchingGroups: 0, filteredPeople: 0,
    });
    await expect(reads.history(identity, {}, initial.selection.id)).resolves.toMatchObject({
      value: [], counts: { total: 0, filtered: 0 },
      page: { number: 1, pages: 0, nextCursor: null, previousCursor: null },
    });
  });

  it("rejects capture if a selected weekly member expires while preparing the selection", async () => {
    const weeklyExpiry = new Date(now.getTime() + 5_000);
    const { reads, query, setClock } = selectionReads(weeklyExpiry);
    const original = query.getMockImplementation()!;
    query.mockImplementation(async (statement, values) => {
      const response = await original(statement, values);
      if (typeof statement === "string" && statement.startsWith("SELECT min(g.expires_at)")) setClock(weeklyExpiry);
      return response;
    });
    await expect(reads.capture(identity)).rejects.toMatchObject({
      status: 409, code: "selection_invalidated", details: { reason: "expired" },
    });
    expect(query.mock.calls.filter(([statement]) => statement === "COMMIT")).toHaveLength(1);
    expect(query).toHaveBeenCalledWith("ROLLBACK");
  });

  it("rolls back if an earlier weekly observation expires during selected work", async () => {
    const weeklyExpiry = new Date(now.getTime() + 5_000);
    const { reads, query, setClock } = selectionReads(weeklyExpiry);
    const captured = await reads.capture(identity);
    const work = vi.fn(async () => { setClock(weeklyExpiry); return "must not escape"; });
    await expect(reads.read(identity, {}, captured.id, work)).rejects.toMatchObject({
      status: 409, code: "selection_invalidated", details: { reason: "expired" },
    });
    expect(work).toHaveBeenCalledTimes(1);
    expect(query.mock.calls.filter(([statement]) => statement === "COMMIT")).toHaveLength(2);
    expect(query).toHaveBeenCalledWith("ROLLBACK");
    const retry = vi.fn(async () => "must not execute");
    await expect(reads.read(identity, {}, captured.id, retry)).rejects.toMatchObject({
      code: "selection_invalidated", details: { reason: "expired" },
    });
    expect(retry).not.toHaveBeenCalled();
  });
});

describe("Office people selected-read pagination without a database", () => {
  it("paginates supported names whose normalized sort keys exceed the signed cursor budget", async () => {
    const largeName = "\uFDFA".repeat(512);
    expect(largeName.length).toBe(512);
    expect(Buffer.byteLength(largeName.normalize("NFKC"))).toBeGreaterThan(4096);
    const people = Array.from({ length: 5 }, (_, index) => person(index + 1, largeName));
    expect(directorySourceRecord({
      serviceEvidenceVersion: 1, copilotServiceState: "disabled", servicePlans: [],
      identity: {
        objectId: people[0].identity, userPrincipalName: people[0].userPrincipalName, displayName: largeName,
        accountEnabled: true, companyName: "Example", department: "Office", userType: null, employeeType: null,
      },
    }).display_name).toBe(largeName);
    const { reads, query } = peopleReads(people);
    const first = await reads.people(identity, {}, groupId, context.selection.id, { limit: 2 });
    expect(first.value).toEqual(people.slice(0, 2));
    expect(first.page.nextCursor).not.toBeNull();
    expect(Buffer.byteLength(first.page.nextCursor!)).toBeLessThanOrEqual(4096);
    const parsed = officeRequestQuery({ limit: "2", selectionId: context.selection.id, cursor: first.page.nextCursor }, true);
    const second = await reads.people(identity, parsed.query, groupId, parsed.selectionId, parsed.options);
    expect(second.value).toEqual(people.slice(2, 4));
    expect(second.page).toMatchObject({ number: 2, offset: 2, pages: 3 });
    const previous = await reads.people(identity, {}, groupId, context.selection.id, { limit: 2, cursor: second.page.previousCursor! });
    expect(previous.value).toEqual(people.slice(0, 2));
    const last = await reads.people(identity, {}, groupId, context.selection.id, { limit: 2, cursor: second.page.nextCursor! });
    expect(last.value).toEqual([people[4]]);
    expect(last.page.nextCursor).toBeNull();
    expect(query.mock.calls.filter(([sql]) => String(sql).startsWith("SELECT count(*)"))).toHaveLength(1);
    const lookups = query.mock.calls.filter(([sql]) => String(sql).includes(" AS sort_name"));
    expect(lookups).toHaveLength(3);
    for (const [sql, values] of lookups) {
      expect(sql).toContain("generation_id=$1 AND payload->>'groupId'=$3");
      expect(sql).toContain("identity=$4");
      expect(values?.slice(0, 3)).toEqual([context.observation!.id, "{}", groupId]);
    }
  });

  it("rejects a cursor if its selected boundary person is unavailable", async () => {
    const { reads } = peopleReads([person(1, "Alpha"), person(2, "Beta")]);
    const first = await reads.people(identity, {}, groupId, context.selection.id, { limit: 1 });
    const unavailable = peopleReads([person(2, "Beta")]);
    await expect(unavailable.reads.people(identity, {}, groupId, context.selection.id,
      { limit: 1, cursor: first.page.nextCursor! })).rejects.toMatchObject({ status: 400, code: "invalid_cursor" });
  });

  it("preserves signed actor, filter, group, selection and page-size binding", async () => {
    const { reads, query } = peopleReads([person(1, "Alpha"), person(2, "Beta")]);
    const first = await reads.people(identity, {}, groupId, context.selection.id, { limit: 1 });
    for (const field of ["tenantId", "principalId", "authorizationHash", "sessionEpoch"] as const) {
      await expect(reads.people({ ...identity, [field]: `${identity[field]}-changed` }, {}, groupId, context.selection.id,
        { limit: 1, cursor: first.page.nextCursor! })).rejects.toMatchObject({ status: 400, code: "invalid_cursor" });
    }
    await expect(reads.people(identity, { app: "word" }, groupId, context.selection.id,
      { limit: 1, cursor: first.page.nextCursor! })).rejects.toMatchObject({ code: "invalid_cursor" });
    await expect(reads.people(identity, {}, digest("another-group"), context.selection.id,
      { limit: 1, cursor: first.page.nextCursor! })).rejects.toMatchObject({ code: "invalid_cursor" });
    await expect(reads.people(identity, {}, groupId, context.selection.id,
      { limit: 2, cursor: first.page.nextCursor! })).rejects.toMatchObject({ code: "invalid_cursor" });
    const encoded = first.page.nextCursor!;
    const expected = {
      identity, endpoint: `office-app-adoption/people/${groupId}`, selectionId: context.selection.id,
      revision: context.selection.revision, queryHash: digest(JSON.stringify([digest(JSON.stringify({})), 1])),
    };
    expect(() => reads.codec.decode(encoded, { ...expected, selectionId: "88888888-8888-4888-8888-888888888888" })).toThrow();
    expect(() => reads.codec.decode(encoded, { ...expected, revision: "99999999-9999-4999-8999-999999999999" })).toThrow();
    await expect(reads.people(identity, {}, groupId, context.selection.id,
      { limit: 1, cursor: `${encoded}x` })).rejects.toMatchObject({ code: "invalid_cursor" });
    expect(query.mock.calls).toHaveLength(2);
  });

  it("keeps empty Latest reads usable and weekly observations aggregate-only", async () => {
    const empty = peopleReads([], null);
    const page = await empty.reads.people(identity, {}, groupId, context.selection.id);
    expect(page.value).toEqual([]);
    expect(page.counts).toEqual({ total: 0, filtered: 0 });
    expect(page.page).toMatchObject({ number: 1, pages: 0, nextCursor: null, previousCursor: null });
    const weekly = peopleReads([], { ...context.observation!, kind: "weekly" });
    await expect(weekly.reads.people(identity, {}, groupId, context.selection.id))
      .rejects.toMatchObject({ status: 409, code: "office_history_aggregate_only" });
    expect(weekly.query).not.toHaveBeenCalled();
  });
});
