import pg from "pg";
import { parse as parseCsv } from "csv-parse/sync";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "../errors.js";
import { reportExportColumns, type CombinedUser, type ReportAgent, type ReportUser } from "../types/officialReportData.js";
import type { UserSourceMetadata } from "../types/userSources.js";
import type { ExportSource } from "./dataExports.js";
import { canonicalQuery, type SelectionIdentity } from "./dataSelections.js";
import { csvValue } from "./csvEncoding.js";
import { LargeTenantUsersReports, reportQuery, reportQueryFields, type ReportReadContext } from "./largeTenantUsersReports.js";
import { OfficialReportExports, type OfficialExportKind } from "./officialReportExports.js";

vi.mock("../db/pool.js", () => ({
  pool: {}, secretValue: (name: string) => name === "TENANTS_JSON" ? "[]"
    : name === "SESSION_SECRET" ? "synthetic-official-export-unit-secret" : undefined,
}));

const identity: SelectionIdentity = {
  tenantId: "export-unit-tenant", principalId: "export-unit-principal", authorizationHash: "viewer", sessionEpoch: "1",
};
const database = new pg.Pool({ max: 4 });
const reports = new LargeTenantUsersReports(database, "synthetic-official-export-unit-secret", 35);
const exports = new OfficialReportExports(reports, {
  tenantId: identity.tenantId, homeAccountId: identity.principalId, username: "viewer@example.invalid", displayName: "Viewer",
});
const selectionId = "11111111-1111-4111-8111-111111111111";
const exportId = "22222222-2222-4222-8222-222222222222";

beforeEach(() => {
  vi.spyOn(database, "connect").mockRejectedValue(new Error("Unexpected database acquisition"));
  vi.spyOn(database, "query").mockRejectedValue(new Error("Unexpected unscoped database query"));
});
afterEach(() => {
  expect(database.connect).not.toHaveBeenCalled();
  expect(database.query).not.toHaveBeenCalled();
  vi.restoreAllMocks();
});
afterAll(async () => { await database.end(); });

function source(source: UserSourceMetadata["source"]): UserSourceMetadata {
  return { source, generationId: null, scopeId: null, revision: null, expiresAt: null, observedAt: null,
    attemptedAt: null, attemptStatus: null, attemptObservedCount: null, errorCode: null, message: null,
    rowCount: null, state: "unavailable", reportRefreshDate: null, period: null, reportVersion: null };
}
function context(endpoint: ReportReadContext["endpoint"]): ReportReadContext {
  const query = reportQuery(endpoint);
  return { identity, tokenMode: "delegated", endpoint, query, queryHash: canonicalQuery(query, reportQueryFields),
    evaluatedAt: new Date("2026-10-01T00:00:00Z"),
    selection: { id: selectionId, revision: "1", evaluatedAt: "2026-10-01T00:00:00Z", expiresAt: "2026-10-01T00:10:00Z" },
    metadata: { directory: source("directory"), app_activity: source("app_activity") },
    report: { setId: "33333333-3333-4333-8333-333333333333", activeSetId: null, activeRevision: "1", historyRevision: "2", historyEpoch: "1",
      availability: "active", staleAfterDays: 35, periodAgeDays: null, acceptedAgeDays: 0, reportingPeriod: null,
      acceptedAt: "2026-10-01T00:00:00Z", expiresAt: null, lineages: [] } };
}
function page(value: Awaited<ReturnType<LargeTenantUsersReports["rowsInRead"]>>["value"], nextCursor: string | null = null) {
  return { raw: [], value, counts: { total: value.length, filtered: value.length },
    summaryRow: undefined, analyticsRow: undefined, page: { limit: 100, nextCursor, previousCursor: null } };
}
function job(client: pg.PoolClient, kind: OfficialExportKind, mode: "all" | "explicit" = "all"): Parameters<ExportSource>[1] {
  return { id: exportId, selectionId, kind, mode, query: {},
    selectedIds: async function* () { throw new Error("Unexpected explicit-ID materialization"); },
    read: async work => work(client) };
}
function clientWith(implementation: (text: string, values?: unknown[]) => Promise<pg.QueryResult>) {
  const client = Object.assign(new pg.Client(), { release: vi.fn() });
  const query = vi.fn(implementation);
  vi.spyOn(client, "query").mockImplementation(query);
  return { client, query };
}
function result(rows: pg.QueryResultRow[]): pg.QueryResult {
  return { command: "SELECT", rowCount: rows.length, oid: 0, fields: [], rows };
}
function combined(metrics: number | null): CombinedUser {
  return { directory: { objectId: "ABCDEFAB-1234-4567-89AB-ABCDEFABCDEF", userPrincipalName: "ＣＡＦＥ\u0301@example.invalid",
    displayName: "=PERSON()", companyName: null, department: null, accountEnabled: true, userType: null, employeeType: null },
    copilotServiceState: "unknown", entitlement: "unknown", servicePlanCount: 0, appActivity: null, activityState: "unknown",
    reportedUsername: null, reportedResponses: metrics, reportedAgentsUsed: metrics, userLastActivityDateUtc: null,
    bridgeResponses: null, relationshipCount: 0, agentActivityState: "unknown", reportMatch: "missing", attention: [] };
}
function user(username: string): ReportUser {
  return { username, displayName: username, objectId: null, company: null, department: null, entitlement: null,
    reportedResponses: null, reportedAgentsUsed: null, bridgeResponses: null, relationshipCount: 0, responseProducingAgentCount: 0,
    userLastActivityDateUtc: null, lastActivityDateUtc: null, missingUserReport: true, hasReportMismatch: false, reviewCohort: "unknown", hasActivity: false };
}

describe("official export admission", () => {
  it.each(["official_users", "official_agents"] as const)("canonicalizes request UUIDs without folding UUID-shaped %s identities", async kind => {
    const selection = "abcdefab-1234-4567-89ab-abcdefabcdef", retry = "fedcbafe-1234-4567-89ab-fedcbafedcba";
    const ids = [selection, selection.toUpperCase()];
    const saved = context(kind);
    const { client } = clientWith(async () => { throw new Error("Unexpected SQL"); });
    const read = vi.spyOn(reports, "read").mockImplementation((_id, _identity, work) => work(client, saved));
    const create = vi.spyOn(exports.engine, "create").mockResolvedValue(exportId);
    await exports.create(identity, { selectionId: selection.toUpperCase(), idempotencyKey: retry.toUpperCase(), kind, ids });
    expect(read).toHaveBeenCalledWith(selection, identity, expect.any(Function));
    expect(create).toHaveBeenCalledWith(identity, expect.objectContaining({ selectionId: selection, idempotencyKey: retry, ids }), undefined);
  });

  it("canonicalizes explicit directory IDs to the stored identity before persistence", async () => {
    const objectId = "abcdefab-1234-4567-89ab-abcdefabcdef";
    const ids = Object.freeze([objectId.toUpperCase()]);
    const saved = context("copilot_users");
    const { client } = clientWith(async () => { throw new Error("Unexpected SQL"); });
    vi.spyOn(reports, "read").mockImplementation((_id, _identity, work) => work(client, saved));
    const create = vi.spyOn(exports.engine, "create").mockResolvedValue(exportId);
    await expect(exports.create(identity, { selectionId, kind: "copilot_users", ids })).resolves.toBe(exportId);
    expect(create).toHaveBeenCalledWith(identity, expect.objectContaining({ kind: "copilot_users", ids: [objectId] }), undefined);
    expect(ids).toEqual([objectId.toUpperCase()]);
  });

  async function rejectInput(input: unknown) {
    const read = vi.spyOn(reports, "read").mockRejectedValue(new Error("Unexpected report read"));
    const selectedRead = vi.spyOn(exports.engine.connections, "selectedRead").mockRejectedValue(new Error("Unexpected inventory read"));
    const resolve = vi.spyOn(exports.inventory, "resolveExportReferences").mockRejectedValue(new Error("Unexpected reference read"));
    const create = vi.spyOn(exports.engine, "create").mockRejectedValue(new Error("Unexpected persistence"));
    await expect(exports.create(identity, input)).rejects.toMatchObject({ status: 400, code: "invalid_export_selection" });
    expect(read).not.toHaveBeenCalled();
    expect(selectedRead).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  }

  it("rejects case-variant duplicate directory IDs before selected reads or persistence", async () => {
    const objectId = "abcdefab-1234-4567-89ab-abcdefabcdef";
    await rejectInput({ selectionId, kind: "copilot_users", ids: [objectId, objectId.toUpperCase()] });
  });

  const fields = { selectionId, kind: "official_users", ids: ["person"], idempotencyKey: exportId };
  it.each(["active", "revoked"])("rejects %s proxy input without invoking its traps", async state => {
    const trap = vi.fn(() => Object.prototype);
    const { proxy, revoke } = Proxy.revocable({ ...fields }, { getPrototypeOf: trap });
    if (state === "revoked") revoke();
    await rejectInput(proxy);
    expect(trap).not.toHaveBeenCalled();
  });

  it.each(["kind", "selectionId", "ids", "idempotencyKey"] as const)("rejects inherited %s before reads or persistence", async field => {
    const input: Record<string, unknown> = { ...fields };
    delete input[field];
    Object.setPrototypeOf(input, { [field]: fields[field] });
    await rejectInput(input);
  });

  it.each(["kind", "selectionId", "ids", "idempotencyKey"] as const)("rejects an own %s accessor without invoking it", async field => {
    const input = { ...fields }, getter = vi.fn(() => fields[field]);
    Object.defineProperty(input, field, { get: getter });
    await rejectInput(input);
    expect(getter).not.toHaveBeenCalled();
  });

  it.each([
    { name: "hidden data", key: "extension", accessor: false, enumerable: false },
    { name: "hidden accessor", key: "extension", accessor: true, enumerable: false },
    { name: "symbol data", key: Symbol("extension"), accessor: false, enumerable: true },
    { name: "symbol accessor", key: Symbol("extension"), accessor: true, enumerable: true },
  ])("rejects a $name extension without invoking getters", async ({ key, accessor, enumerable }) => {
    const input = { ...fields }, getter = vi.fn(() => "smuggled");
    Object.defineProperty(input, key, { ...(accessor ? { get: getter } : { value: "smuggled" }), enumerable });
    await rejectInput(input);
    expect(getter).not.toHaveBeenCalled();
  });

  it("rejects an explicit-ID index accessor without invoking it", async () => {
    const ids = ["person"], getter = vi.fn(() => "person");
    Object.defineProperty(ids, "0", { get: getter });
    await rejectInput({ selectionId, kind: "official_users", ids });
    expect(getter).not.toHaveBeenCalled();
  });

  it.each(["some", "slice", "constructor", Symbol.iterator])("rejects an explicit-ID array with an overridden %s accessor", async key => {
    const ids = ["person"], getter = vi.fn(() => Reflect.get(Array.prototype, key));
    Object.defineProperty(ids, key, { get: getter });
    await rejectInput({ selectionId, kind: "official_users", ids });
    expect(getter).not.toHaveBeenCalled();
  });

  it.each(["extension", Symbol("extension")])("rejects a hidden explicit-ID array extension %s", async key => {
    const ids = ["person"];
    Object.defineProperty(ids, key, { value: "smuggled" });
    await rejectInput({ selectionId, kind: "official_users", ids });
  });

  it("rejects an explicit-ID array with an inherited index without invoking its getter", async () => {
    const ids = new Array<string>(1), getter = vi.fn(() => "person");
    Object.setPrototypeOf(ids, Object.create(Array.prototype, { "0": { get: getter } }));
    await rejectInput({ selectionId, kind: "official_users", ids });
    expect(getter).not.toHaveBeenCalled();
  });

  it.each(["active", "revoked"])("rejects %s explicit-ID proxy arrays without invoking their traps", async state => {
    const trap = vi.fn(() => Array.prototype);
    const { proxy, revoke } = Proxy.revocable(["person"], { getPrototypeOf: trap });
    if (state === "revoked") revoke();
    await rejectInput({ selectionId, kind: "official_users", ids: proxy });
    expect(trap).not.toHaveBeenCalled();
  });

  it.each(["sparse", "subclass", "null-prototype"])("rejects a %s explicit-ID array", async shape => {
    class CustomIds extends Array<string> {}
    const ids = shape === "sparse" ? new Array<string>(1) : shape === "subclass" ? new CustomIds("person") : ["person"];
    if (shape === "null-prototype") Object.setPrototypeOf(ids, null);
    await rejectInput({ selectionId, kind: "official_users", ids });
  });

  it.each(["plain", "null-prototype"])("accepts own data properties on a %s input", async shape => {
    const ids = Object.freeze(["ＣＡＦＥ\u0301@example.invalid", "CaseSensitiveUser", "casesensitiveuser", "person😀", "name\n"]);
    const input = Object.create(shape === "plain" ? Object.prototype : null, {
      selectionId: { value: selectionId }, kind: { value: "official_users" }, ids: { value: ids }, idempotencyKey: { value: exportId },
    });
    const saved = context("official_users");
    const { client } = clientWith(async () => { throw new Error("Unexpected SQL"); });
    vi.spyOn(reports, "read").mockImplementation((_id, _identity, work) => work(client, saved));
    const create = vi.spyOn(exports.engine, "create").mockResolvedValue(exportId);
    await expect(exports.create(identity, input)).resolves.toBe(exportId);
    expect(create).toHaveBeenCalledWith(identity, expect.objectContaining({
      selectionId, kind: "official_users", ids, idempotencyKey: exportId,
    }), undefined);
    expect(create.mock.calls[0][1].ids).not.toBe(ids);
  });

  it.each([{ kind: ["graph_packages"] }, { kind: ["official_users"] }, { kind: { toString: "graph_packages" } }, { kind: null }])(
    "rejects a non-scalar kind $kind before selected reads", async ({ kind }) => {
      const read = vi.spyOn(exports.engine.connections, "selectedRead").mockRejectedValue(new Error("Unexpected selected read"));
      const input = JSON.parse(JSON.stringify({ selectionId, kind }));
      await expect(exports.create(identity, input)).rejects.toMatchObject({ status: 400, code: "invalid_export_kind" });
      expect(read).not.toHaveBeenCalled();
    },
  );

  it.each(["name\0", "\ud800", "\udc00"])("rejects an unrepresentable explicit identity %j before persistence", async id => {
    const read = vi.spyOn(reports, "read").mockRejectedValue(new Error("Unexpected selected read"));
    await expect(exports.create(identity, { selectionId, kind: "official_users", ids: [id] }))
      .rejects.toMatchObject({ status: 400, code: "invalid_export_selection" });
    expect(read).not.toHaveBeenCalled();
  });

  it.each(["name\0", "\ud800", "\udc00"])("rejects unrepresentable IDs in direct engine admission: %j", id => {
    const run = vi.spyOn(exports.engine.connections, "run").mockRejectedValue(new Error("Unexpected persistence"));
    expect(() => exports.engine.create(identity, {
      selectionId, kind: "official_users", queryHash: "query", filename: "official-users.csv", ids: [id],
    })).toThrow("export_explicit_ids");
    expect(run).not.toHaveBeenCalled();
  });

  it("retains case, normalization and an immutable explicit intent through admission and its publication fence", async () => {
    const ids = ["ＣＡＦＥ\u0301@example.invalid", "CaseSensitiveUser", "casesensitiveuser", "person😀"];
    const saved = context("official_users"), assertCurrent = vi.fn();
    const { client } = clientWith(async () => { throw new Error("Unexpected SQL"); });
    const read = Promise.withResolvers<void>();
    vi.spyOn(reports, "read").mockImplementation(async (_id, _identity, work) => { await read.promise; return work(client, saved); });
    const create = vi.spyOn(exports.engine, "create").mockResolvedValue(exportId);
    const pending = exports.create(identity, { selectionId, kind: "official_users", ids }, assertCurrent);
    ids.splice(0, ids.length, "replacement");
    read.resolve();
    await expect(pending).resolves.toBe(exportId);
    expect(create).toHaveBeenCalledWith(identity, expect.objectContaining({
      ids: ["ＣＡＦＥ\u0301@example.invalid", "CaseSensitiveUser", "casesensitiveuser", "person😀"], queryHash: saved.queryHash,
    }), assertCurrent);
  });
});

describe("official export build preflight", () => {
  it("does not perform preflight or claim work after its parent is already aborted", async () => {
    const parent = new AbortController(), reason = new Error("export_shutdown");
    parent.abort(reason);
    const read = vi.spyOn(exports.engine.connections, "selectedRead").mockRejectedValue(new Error("Unexpected read"));
    const build = vi.spyOn(exports.engine, "build").mockResolvedValue();
    await expect(exports.build(exportId, identity, "official_users", parent.signal)).rejects.toBe(reason);
    expect(read).not.toHaveBeenCalled();
    expect(build).not.toHaveBeenCalled();
  });

  it.each(["shutdown", "maintenance"] as const)("does not claim work when %s overtakes awaited preflight cleanup", async boundary => {
    const parent = new AbortController(), reason = new AppError(503, "maintenance", "Export admissions are paused.");
    let open = true;
    const { client } = clientWith(async () => result([{ selection_id: selectionId, kind: "official_users" }]));
    vi.spyOn(exports.engine.selections, "assert").mockResolvedValue({ selection: {}, pins: [] });
    vi.spyOn(exports.engine.connections, "selectedRead").mockImplementation(async work => {
      const value = await work(client);
      if (boundary === "shutdown") parent.abort(reason);
      else open = false;
      return value;
    });
    const build = vi.spyOn(exports.engine, "build").mockResolvedValue();
    await expect(exports.build(exportId, identity, "official_users", parent.signal, {
      assertCurrent: () => { if (!open) throw reason; },
    })).rejects.toBe(reason);
    expect(build).not.toHaveBeenCalled();
  });

  it("retains the parent's admission and settlement controls through serialized preflight and the durable builder", async () => {
    const parent = new AbortController(), control = { assertCurrent: vi.fn(), settlementFailed: vi.fn() };
    const { client } = clientWith(async () => result([{ selection_id: selectionId, kind: "official_users" }]));
    vi.spyOn(exports.engine.selections, "assert").mockResolvedValue({ selection: {}, pins: [] });
    const read = vi.spyOn(exports.engine.connections, "selectedRead").mockImplementation(async work => work(client));
    const build = vi.spyOn(exports.engine, "build").mockResolvedValue();
    await exports.build(exportId, identity, "official_users", parent.signal, control);
    expect(read).toHaveBeenCalledWith(expect.any(Function), {
      signal: parent.signal, serializationKey: exportId, beforeCommit: control.assertCurrent,
    });
    expect(build).toHaveBeenCalledWith(exportId, identity, reportExportColumns.official_users,
      expect.any(Function), parent.signal, control);
    expect(control.assertCurrent).toHaveBeenCalledTimes(2);
  });
});

describe("official export row contracts", () => {
  it("serializes missing Copilot report metrics as Unknown, preserves zero and applies formula defense", async () => {
    const saved = context("copilot_users");
    const { client } = clientWith(async () => { throw new Error("Unexpected SQL"); });
    vi.spyOn(reports, "contextInRead").mockResolvedValue(saved);
    vi.spyOn(reports, "rowsInRead").mockResolvedValue(page([combined(null), combined(0)]));
    const rows: Record<string, unknown>[] = [];
    for await (const batch of exports.source(identity)(new AbortController().signal, job(client, "copilot_users"))) rows.push(...batch);
    const columns = reportExportColumns.copilot_users;
    const csv = `${columns.join(",")}\r\n${rows.map(row => columns.map(column => csvValue(row[column])).join(",")).join("\r\n")}\r\n`;
    expect(parseCsv(csv, { columns: true })).toMatchObject([
      { ObjectId: "ABCDEFAB-1234-4567-89AB-ABCDEFABCDEF", UserPrincipalName: "ＣＡＦＥ\u0301@example.invalid",
        DisplayName: "'=PERSON()", ReportedResponses: "Unknown", ReportedAgentsUsed: "Unknown", ReportAvailability: "active" },
      { ReportedResponses: "0", ReportedAgentsUsed: "0" },
    ]);
  });

  it("continues byte-short parent and child pages with exact usernames, unknown rows and the explicit selection fence", async () => {
    const saved = context("official_users"), users = [user("CaseSensitiveUser"), user("casesensitiveuser")];
    Object.assign(users[0], { reportedResponses: 7, reportedAgentsUsed: 2, bridgeResponses: 7, relationshipCount: 2,
      responseProducingAgentCount: 1, missingUserReport: false, reviewCohort: "outside" });
    const responses = [
      [{ parent_ordinal: 0, parent_username: users[0].username, relationship_id: "first", agent_id: "Agent-Exact", agent_name: "=FORMULA",
        creator_type: "", username: users[0].username, responses: "7", last_activity: "2026-10-01", page_key: "=formula", candidate_count: "2" }],
      [{ parent_ordinal: 0, parent_username: users[0].username, relationship_id: "second", agent_id: "agent-exact", agent_name: "Second",
        creator_type: "Custom", username: users[0].username, responses: "0", last_activity: null, page_key: "second", candidate_count: "1" }],
      [{ parent_ordinal: 0, parent_username: users[1].username, relationship_id: null, agent_id: null, agent_name: null,
        creator_type: null, username: null, responses: null, last_activity: null, page_key: null, candidate_count: "1" }],
    ];
    const { client, query } = clientWith(async () => result(responses.shift() ?? []));
    vi.spyOn(reports, "contextInRead").mockResolvedValue(saved);
    const pages = vi.spyOn(reports, "rowsInRead").mockResolvedValueOnce(page([users[0]], "parent-next")).mockResolvedValueOnce(page([users[1]]));
    const rows: Record<string, unknown>[] = [];
    for await (const batch of exports.source(identity)(new AbortController().signal, job(client, "official_users", "explicit"))) rows.push(...batch);
    expect(pages.mock.calls.map(call => call[2])).toEqual([
      { limit: 100, cursor: undefined, explicitExportId: exportId },
      { limit: 100, cursor: "parent-next", explicitExportId: exportId },
    ]);
    expect(query.mock.calls[0][1]?.[2]).toBe(JSON.stringify([{ ordinal: 0, username: users[0].username }]));
    expect(query.mock.calls[1][1]?.slice(3)).toEqual([0, 0, "=formula", "first"]);
    expect(query.mock.calls[2][1]?.slice(3)).toEqual([null, 0, "", ""]);
    expect(rows).toMatchObject([
      { username: users[0].username, agentId: "Agent-Exact", reportedResponsesReceived: 7, responsesSentToUsers: 7,
        agentLastUsedByAnyoneDateUtc: "2026-10-01T00:00:00.000Z", identityStatus: "unresolved" },
      { username: users[0].username, agentId: "agent-exact", reportedResponsesReceived: 7, responsesSentToUsers: 0, agentLastUsedByAnyoneDateUtc: "Unknown" },
      { username: users[1].username, agentId: "", reportedResponsesReceived: "Unknown", responsesSentToUsers: "Unknown", missingBridgeRows: true },
    ]);
  });

  it("does not read another relationship page after cancellation", async () => {
    const saved = context("official_users"), controller = new AbortController();
    const { client, query } = clientWith(async () => result([{
      parent_ordinal: 0, parent_username: "person", relationship_id: "first", agent_id: "Agent", agent_name: "Agent",
      creator_type: "", username: "person", responses: "0", last_activity: null, page_key: "agent", candidate_count: "2",
    }]));
    vi.spyOn(reports, "contextInRead").mockResolvedValue(saved);
    vi.spyOn(reports, "rowsInRead").mockResolvedValue(page([user("person")]));
    const iterator = exports.source(identity)(controller.signal, job(client, "official_users"))[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toHaveLength(1);
    const reason = new Error("export_cancelled");
    controller.abort(reason);
    await expect(iterator.next()).rejects.toBe(reason);
    expect(query).toHaveBeenCalledOnce();
  });

  it("retains authoritative agent totals and blank dates without inventing companion counts or summing license categories", async () => {
    const saved = context("official_agents");
    const agent: ReportAgent = { agentId: "Agent-Exact", agentName: "", creatorType: "", responses: 5, responseSource: "agents",
      activeUsers: null, activeUsersBasis: "unknown", licensedUserOccurrences: 4, unlicensedUserOccurrences: 3, lastActivityDateUtc: null,
      reportResponses: 5, bridgeResponses: null, relationshipCount: 0, responseComparison: "not_comparable", identityStatus: "unresolved" };
    const { client } = clientWith(async () => { throw new Error("Unexpected SQL"); });
    vi.spyOn(reports, "contextInRead").mockResolvedValue(saved);
    vi.spyOn(reports, "rowsInRead").mockResolvedValue(page([agent]));
    const rows: Record<string, unknown>[] = [];
    for await (const batch of exports.source(identity)(new AbortController().signal, job(client, "official_agents"))) rows.push(...batch);
    expect(rows).toMatchObject([{ agentId: "Agent-Exact", activeUsersLicensed: 4, activeUsersUnlicensed: 3,
      activeUsersTotal: "Unknown", activeUsersTotalBasis: "unknown", lastActivityDateUtc: "Unknown",
      responsesSentToUsers: 5, responsesUsersAndAgentsReport: "Unknown", responseDifference: "Unknown", sourceReports: "agents" }]);
  });

  it("propagates the selection fence failure without yielding rows", async () => {
    const { client } = clientWith(async () => { throw new Error("Unexpected SQL"); });
    const reason = new AppError(409, "selection_invalidated", "Selection changed");
    const read: Parameters<ExportSource>[1]["read"] = async () => { throw reason; };
    const iterator = exports.source(identity)(new AbortController().signal, { ...job(client, "official_agents"), read })[Symbol.asyncIterator]();
    await expect(iterator.next()).rejects.toBe(reason);
  });
});
