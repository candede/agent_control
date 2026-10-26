import pg from "pg";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type { ReportEndpoint, ReportQuery } from "../types/officialReportData.js";
import type { UserSourceMetadata } from "../types/userSources.js";
import { canonicalQuery, type SelectionIdentity } from "./dataSelections.js";
import { LargeTenantUsersReports, reportQuery, reportQueryFields, type ReportReadContext } from "./largeTenantUsersReports.js";
import { OfficialAgentUsage } from "./officialAgentUsage.js";
import { officialAgentUsageMutation } from "./officialAgentUsageInput.js";
import { parseRecordId } from "./agentUsageIdentity.js";
import { unifiedAgentRecordId } from "../types/unifiedAgents.js";
import { AuditLog } from "./auditLog.js";
import { AppError } from "../errors.js";

const endpoints: ReportEndpoint[] = ["copilot_users", "official_users", "official_agents", "relationships",
  "history", "overview", "unresolved", "plans", "observations"];
const identity: SelectionIdentity = {
  tenantId: "report-query-tenant", principalId: "report-query-principal", authorizationHash: "viewer", sessionEpoch: "1",
};
const secret = "synthetic-report-query-regression-secret";
const database = new pg.Pool({ max: 4 });
const reports = new LargeTenantUsersReports(database, secret, 35);

afterEach(() => { vi.restoreAllMocks(); });
afterAll(async () => { await database.end(); });

function sourceMetadata(source: UserSourceMetadata["source"]): UserSourceMetadata {
  return { source, generationId: null, scopeId: null, revision: null, expiresAt: null, observedAt: null,
    attemptedAt: null, attemptStatus: null, attemptObservedCount: null, errorCode: null, message: null,
    rowCount: null, state: "unavailable", reportRefreshDate: null, period: null, reportVersion: null };
}
function readContext(endpoint: ReportEndpoint, search: string): ReportReadContext {
  const query = reportQuery(endpoint, { search });
  return { identity, tokenMode: "delegated", endpoint, query, queryHash: canonicalQuery(query, reportQueryFields),
    evaluatedAt: new Date("2026-01-01T00:00:00Z"),
    selection: { id: "11111111-1111-4111-8111-111111111111", revision: "1",
      evaluatedAt: "2026-01-01T00:00:00Z", expiresAt: "2026-01-01T00:10:00Z", validatedAt: "2026-01-01T00:00:00Z",
      publicationRevisions: { graph_packages: "1".repeat(64), power_platform: "2".repeat(64), users: "3".repeat(64) } },
    metadata: { directory: sourceMetadata("directory"), app_activity: sourceMetadata("app_activity") },
    report: { setId: null, activeSetId: null, activeRevision: "1", historyRevision: "0", historyEpoch: "0",
      availability: "never_imported", staleAfterDays: 35, periodAgeDays: null, acceptedAgeDays: null,
      reportingPeriod: null, acceptedAt: null, expiresAt: null, lineages: [] } };
}

describe.each(endpoints)("%s search normalization", endpoint => {
  it.each([
    { search: "  %_Name ", expected: "%_name" },
    { search: "\u3000\uff26\uff4f\uff4f\u00a0", expected: "foo" },
    { search: " \u00a8 ", expected: "\u0308" },
    { search: "J\u030c", expected: "\u01f0" },
    { search: "\ud835\udc09\u030c", expected: "\u01f0" },
    { search: " ".repeat(256), expected: "" },
    { search: "A".repeat(256), expected: "a".repeat(256) },
    { search: "\u337f".repeat(64), expected: "\u682a\u5f0f\u4f1a\u793e".repeat(64) },
    { search: "\u0130".repeat(128), expected: "i\u0307".repeat(128) },
  ])("keeps accepted search stable across selection revalidation: $search", ({ search, expected }) => {
    const input = { search };
    const query = reportQuery(endpoint, input);
    expect(query.search).toBe(expected);
    expect(query.search!.length).toBeLessThanOrEqual(256);
    expect(input).toEqual({ search });
    const restored = reportQuery(endpoint, query);
    expect(restored).toEqual(query);
    expect(canonicalQuery(restored, reportQueryFields)).toBe(canonicalQuery(query, reportQueryFields));
  });
});

describe("report search admission boundaries", () => {
  it.each([
    { name: "raw length", search: "a".repeat(257) },
    { name: "NFKC expansion", search: "\u337f".repeat(65) },
    { name: "long compatibility expansion", search: "\ufdfa".repeat(15) },
    { name: "lowercase expansion", search: "\u0130".repeat(129) },
    { name: "control character", search: "name\n" },
    { name: "unpaired surrogate", search: "\ud800" },
  ])("rejects $name before acquiring a database connection", async ({ search }) => {
    const connect = vi.spyOn(database, "connect").mockRejectedValue(new Error("Unexpected database acquisition"));
    await expect(reports.capture(identity, "delegated", "official_users", { search }))
      .rejects.toMatchObject({ status: 400, code: "invalid_cursor" });
    expect(connect).not.toHaveBeenCalled();
  });
});

describe("report query admission shapes", () => {
  it.each([{ input: [] }, { input: null }, { input: 0 }, { input: "" }, { input: { sort: null } }])(
    "rejects malformed query shapes before acquiring a database connection: $input", async ({ input }) => {
      const connect = vi.spyOn(database, "connect").mockRejectedValue(new Error("Unexpected database acquisition"));
      await expect(reports.capture(identity, "delegated", "official_users", input as ReportQuery))
        .rejects.toMatchObject({ status: 400, code: "invalid_cursor" });
      expect(connect).not.toHaveBeenCalled();
    },
  );

  it("rejects inherited endpoint names as invalid intent", () => {
    expect(() => reportQuery("toString" as ReportEndpoint)).toThrowError(expect.objectContaining({ code: "invalid_cursor" }));
  });

  it.each([
    { agentId: "Agent-\ud800" }, { username: "User-\udfff" },
    { agentId: "Agent-\u0085" }, { username: "User-\t" },
  ])("rejects malformed exact identities before acquiring a connection: %j", async input => {
    const connect = vi.spyOn(database, "connect").mockRejectedValue(new Error("Unexpected database acquisition"));
    await expect(reports.capture(identity, "delegated", "relationships", input as ReportQuery))
      .rejects.toMatchObject({ status: 400, code: "invalid_cursor" });
    expect(connect).not.toHaveBeenCalled();
  });

  it.each(endpoints)("canonicalizes only the report-set UUID in a %s query", endpoint => {
    const setId = "abcdefab-1234-4567-89ab-abcdefabcdef", input = { setId: setId.toUpperCase() };
    const query = reportQuery(endpoint, input);
    expect(query.setId).toBe(setId);
    expect(canonicalQuery(query, reportQueryFields)).toBe(canonicalQuery(reportQuery(endpoint, { setId }), reportQueryFields));
    expect(input.setId).toBe(setId.toUpperCase());
    if (["official_agents", "official_users", "copilot_users", "relationships"].includes(endpoint)) {
      expect(reportQuery(endpoint, { agentId: input.setId }).agentId).toBe(input.setId);
    }
  });

  it("retains exact Unicode agent IDs and usernames in SQL parameters instead of applying search normalization", () => {
    const input = { agentId: "\uff21gent/Upper", username: "J\u030c" };
    const context = { ...readContext("relationships", ""), query: reportQuery("relationships", input) }, values: unknown[] = [];
    const sql = reports.filter(context, "relationships", values);
    expect(sql).toContain("agent_id=$1");
    expect(sql).toContain("username=$2");
    expect(values).toEqual([input.agentId, input.username]);
    expect(context.query).toMatchObject(input);
  });
});

it.each([" \u00a8 ", "J\u030c", "\ud835\udc09\u030c", "\u337f".repeat(64), "\u0130".repeat(128)])(
  "rereads a saved selection without changing its normalized search or query hash: %s", async search => {
    const saved = readContext("official_users", search);
    const client = Object.assign(new pg.Client(), { release: vi.fn() });
    vi.spyOn(client, "query").mockImplementation(async () => ({
      command: "SELECT", rowCount: 1, oid: 0, fields: [],
      rows: [{
        endpoint: saved.endpoint, query_json: saved.query, query_hash: saved.queryHash, revision: saved.selection.revision,
        evaluated_at: saved.evaluatedAt, expires_at: new Date(saved.selection.expiresAt), validated_at: saved.evaluatedAt,
        token_mode: saved.tokenMode, metadata: { ...saved.metadata, publicationRevisions: saved.selection.publicationRevisions }, report_metadata: saved.report,
      }],
    }));
    const context = await reports.contextInRead(client, identity, saved.selection.id);
    expect(context.query).toEqual(saved.query);
    expect(context.queryHash).toBe(saved.queryHash);
  },
);

describe("report search SQL contracts", () => {
  it.each(endpoints)("normalizes every searched %s column consistently with the query", endpoint => {
    const context = readContext(endpoint, "J\u030c"), values: unknown[] = [];
    const sql = reports.filter(context, endpoint, values);
    const fields = ["COALESCE(name,'')", "identity"];
    if (endpoint === "copilot_users") fields.push("upn_key");
    if (endpoint === "copilot_users" || endpoint === "official_users") {
      fields.push("COALESCE(company,'')", "COALESCE(department,'')", "rf.agent_name", "rf.agent_id");
    }
    if (endpoint === "official_agents" || endpoint === "relationships") fields.push("creator_type");
    if (endpoint === "relationships") fields.push("username", "agent_id");
    for (const field of fields) {
      expect(sql).toContain(`strpos(normalize(lower(normalize(${field},NFKC) COLLATE "default"),NFKC),$`);
    }
    expect(values.filter(value => value === "\u01f0")).toHaveLength(fields.length);
    expect(values).not.toContain("J\u030c");
    expect(values).not.toContain("j\u030c");
  });

  it("uses the same normalization for overview observation matches", () => {
    const { sql, values } = reports.dataset(readContext("overview", "J\u030c"));
    for (const field of ["f.agent_id", "f.agent_name"]) {
      expect(sql).toContain(`strpos(normalize(lower(normalize(${field},NFKC) COLLATE "default"),NFKC),$9)`);
    }
    expect(values[8]).toBe("\u01f0");
  });
});

describe("exact agent usage input normalization", () => {
  it.each([
    ["graph_packages:Package-A", "graph_packages:Package-A"],
    ["agent:abcdefab-1234-4567-89ab-abcdefabcdef", "agent:ABCDEFAB-1234-4567-89AB-ABCDEFABCDEF"],
    ["graph_packages:Package-A", "graph_packages:%50ackage-A"],
    ["power_platform:Default-abcdefab-1234-4567-89ab-abcdefabcdef:abcdefab-1234-4567-89ab-abcdefabcdef",
      "power_platform:DEFAULT-ABCDEFAB-1234-4567-89AB-ABCDEFABCDEF:ABCDEFAB-1234-4567-89AB-ABCDEFABCDEF"],
  ])("rejects duplicate exact summary identities before a saved read: %j, %j", async (first, alias) => {
    const read = vi.spyOn(reports, "read").mockResolvedValue([]);
    await expect(async () => new OfficialAgentUsage(reports).summaries("11111111-1111-4111-8111-111111111111", identity, [first, alias]))
      .rejects.toMatchObject({ status: 400, code: "data_exact_ids_limit" });
    expect(read).not.toHaveBeenCalled();
  });

  it.each(["agent:not-a-uuid", "graph_packages:%", "graph_packages:"])(
    "rejects malformed summary identities before a saved read: %j", async recordId => {
      const read = vi.spyOn(reports, "read").mockResolvedValue([]);
      await expect(async () => new OfficialAgentUsage(reports).summaries("11111111-1111-4111-8111-111111111111", identity, [recordId]))
        .rejects.toMatchObject({ status: 400, code: "invalid_agent_usage_record" });
      expect(read).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["graph_packages:%50ackage-A", "graph_packages:package-a"],
    ["power_platform:Env-A:Opaque-A", "power_platform:env-a:Opaque-A"],
    ["power_platform:Env-A:Opaque-A", "power_platform:Env-A:opaque-a"],
  ])("preserves distinct opaque summary identities: %j, %j", async (first, second) => {
    const f = usersHarness();
    f.saved.report = { ...f.saved.report, setId: f.saved.selection.id, activeSetId: f.saved.selection.id, availability: "active" };
    const summaries = await f.usage.summaries(f.saved.selection.id, identity, [first, second]);
    expect(summaries.map(row => row.recordId)).toEqual([first, second]);
    expect(summaries).toMatchObject([
      { status: "linked", responses: 4, activeUsers: 1, associationCount: 1 },
      { status: "linked", responses: 4, activeUsers: 1, associationCount: 1 },
    ]);
    expect(reports.read).toHaveBeenCalledOnce();
  });

  function usersHarness() {
    const saved = readContext("official_agents", ""), client = Object.assign(new pg.Client(), { release: vi.fn() });
    const query = vi.spyOn(client, "query").mockImplementation(async (sql: string) => {
      const rows = sql.includes("SELECT DISTINCT agent_id,control_revision")
        ? [{ agent_id: "abcdefab-1234-4567-89ab-abcdefabcdef", control_revision: "current-inventory" }]
        : sql.includes("SELECT revision::text") ? [{ revision: "0" }]
          : sql.includes("AS total,") ? [{ total: "2", filtered: "2" }]
            : sql.includes("SELECT count(*)::text AS n,sum(responses)::text")
              ? [{ n: "1", responses: "4", active_users: "1", last_activity: null }]
            : [{ username: "CaseUser", name: "J\u030c", responses: "4" }, { username: "caseuser", name: "Other", responses: "2" }];
      return { command: "SELECT", rowCount: rows.length, oid: 0, fields: [], rows };
    });
    vi.spyOn(reports, "read").mockImplementation((_id, _identity, work) => work(client, saved));
    return { saved, query, usage: new OfficialAgentUsage(reports), recordId: "agent:abcdefab-1234-4567-89ab-abcdefabcdef" };
  }

  it("normalizes agent usernames and display names in SQL without folding exact grouping identities", async () => {
    const f = usersHarness();
    const page = await f.usage.users(f.saved.selection.id, identity, f.recordId, { search: "\uff26\uff4f\uff4f" });
    expect(page.value.map(row => row.username)).toEqual(["CaseUser", "caseuser"]);
    const projections = f.query.mock.calls.filter(([sql]) => String(sql).includes("filtered_users AS"));
    expect(projections).toHaveLength(2);
    for (const [sql, values] of projections) {
      for (const field of ["username", "name"]) {
        expect(String(sql)).toContain(`strpos(normalize(lower(normalize(${field},NFKC) COLLATE "default"),NFKC),$10)`);
      }
      expect(String(sql)).toContain("GROUP BY r.username");
      expect(values?.[9]).toBe("foo");
    }
  });

  it("reuses an agent-user cursor across canonically equivalent searches", async () => {
    const f = usersHarness();
    const first = await f.usage.users(f.saved.selection.id, identity, f.recordId, { search: "J\u030c", limit: 1 });
    expect(first.page.nextCursor).toEqual(expect.any(String));
    await expect(f.usage.users(f.saved.selection.id, identity, f.recordId,
      { search: "\ud835\udc09\u030c", limit: 1, cursor: first.page.nextCursor! })).resolves.toMatchObject({ context: first.context });
    await expect(f.usage.users(f.saved.selection.id, identity, f.recordId,
      { search: "changed", limit: 1, cursor: first.page.nextCursor! })).rejects.toMatchObject({ code: "invalid_cursor" });
  });

  it.each(["\ud800", "\u0085", "\u337f".repeat(65)])("rejects invalid or expanded agent-user search before reading: %j", async search => {
    const f = usersHarness(), read = vi.spyOn(reports, "read");
    await expect(async () => f.usage.users(f.saved.selection.id, identity, f.recordId, { search })).rejects.toMatchObject({ status: 400 });
    expect(read).not.toHaveBeenCalled();
    expect(f.query).not.toHaveBeenCalled();
  });

  it("canonicalizes usage selection/report UUIDs without changing opaque report or source IDs", () => {
    const selectionId = "abcdefab-1234-4567-89ab-abcdefabcdef", reportSetId = "fedcbafe-1234-4567-89ab-fedcbafedcba";
    const input = { selectionId, reportSetId, usageRevision: "a".repeat(64), inventoryRevision: "b".repeat(64),
      reportAgentId: "Report-A", target: { source: "graph_packages", packageId: "Package-A" }, confirmed: true };
    expect(officialAgentUsageMutation({ ...input, selectionId: selectionId.toUpperCase(), reportSetId: reportSetId.toUpperCase() }))
      .toEqual(input);
  });

  it.each(["\ud800", "\udfff", "\u0085"])("rejects malformed text in a supported exact record prefix: %j", character => {
    expect(() => parseRecordId(`graph_packages:Agent-${character}-ID`)).toThrow();
  });

  it.each(["", "ENV-A"])("returns an exact reusable association target for environment %j", async environment => {
    const saved = readContext("official_agents", "");
    const setId = "fedcbafe-1234-4567-89ab-fedcbafedcba", agentId = "abcdefab-1234-4567-89ab-abcdefabcdef";
    saved.report = { ...saved.report, setId, activeSetId: setId, availability: "active" };
    const nativeId = "Opaque/Native%2F-ID", reportAgentId = "Report/Upper:ID", snapshotId = "11111111-1111-4111-8111-111111111111";
    const client = Object.assign(new pg.Client(), { release: vi.fn() });
    vi.spyOn(client, "query").mockImplementation(async (sql: string) => {
      let rows;
      if (sql.includes("SELECT DISTINCT agent_id,control_revision")) rows = [{ agent_id: agentId, control_revision: snapshotId }];
      else if (sql.includes("SELECT revision::text")) rows = [{ revision: "0" }];
      else if (sql.includes("SELECT count(*)::text AS n")) rows = [{ n: "1" }];
      else if (sql.includes("SELECT a.agent_id,a.name,a.responses::text")) rows = [{
        agent_id: reportAgentId, name: "Reported agent", responses: "4", basis: "reviewed",
        source: "power_platform", native_id: nativeId, environment_id: environment,
        package_snapshot_id: null, power_platform_snapshot_id: snapshotId,
      }];
      else throw new Error("Unexpected association query");
      return { command: "SELECT", rowCount: rows.length, oid: 0, fields: [], rows };
    });
    vi.spyOn(reports, "read").mockImplementation((_id, _identity, work) => work(client, saved));
    const target = { source: "power_platform" as const, nativeId, environmentId: environment || null };
    const recordId = unifiedAgentRecordId(target);
    const page = await new OfficialAgentUsage(reports).associations(saved.selection.id, identity, recordId, {});
    expect(page.value).toEqual([{ reportAgentId, agentName: "Reported agent", responses: 4, basis: "reviewed",
      target: { ...target, snapshotId } }]);
    const returned = page.value[0].target;
    if (returned.source !== "power_platform") throw new Error("Expected an exact Power Platform target");
    const { source, nativeId: returnedNativeId, environmentId } = returned;
    const { selectionId, reportSetId, usageRevision, inventoryRevision } = page.context;
    expect(officialAgentUsageMutation({ selectionId, reportSetId, usageRevision, inventoryRevision, reportAgentId, confirmed: true,
      target: { source, nativeId: returnedNativeId, environmentId } }).target).toEqual(target);
  });

  it("pages associations with maximum-length Unicode report IDs in both directions", async () => {
    const saved = readContext("official_agents", "");
    const agentId = "abcdefab-1234-4567-89ab-abcdefabcdef", snapshotId = "22222222-2222-4222-8222-222222222222";
    saved.report = { ...saved.report, setId: snapshotId, activeSetId: snapshotId, availability: "active" };
    const ids = ["a", "b", "c"].map(suffix => "代".repeat(511) + suffix);
    const client = Object.assign(new pg.Client(), { release: vi.fn() });
    const query = vi.spyOn(client, "query").mockImplementation(async (sql: string, values?: unknown[]) => {
      const rows = sql.includes("SELECT DISTINCT agent_id,control_revision") ? [{ agent_id: agentId, control_revision: snapshotId }]
        : sql.includes("SELECT revision::text") ? [{ revision: "0" }]
          : sql.includes("SELECT count(*)::text AS n") ? [{ n: String(ids.length) }]
            : ids.filter(id => sql.includes('ORDER BY a.agent_id COLLATE "C" DESC') ? id < String(values?.[9]) : id > String(values?.[9]))
              .sort((left, right) => sql.includes('ORDER BY a.agent_id COLLATE "C" DESC') ? right.localeCompare(left) : left.localeCompare(right))
              .slice(0, Number(values?.[10])).map(id => ({ agent_id: id, name: "Reported agent", responses: "4",
                basis: "exact_package_id", source: "graph_packages", native_id: id,
                environment_id: "", package_snapshot_id: snapshotId, power_platform_snapshot_id: null }));
      return { command: "SELECT", rowCount: rows.length, oid: 0, fields: [], rows };
    });
    vi.spyOn(reports, "read").mockImplementation((_id, _identity, work) => work(client, saved));
    const usage = new OfficialAgentUsage(reports), recordId = `agent:${agentId}`;
    const first = await usage.associations(saved.selection.id, identity, recordId, { limit: 1 });
    expect(first.value[0].reportAgentId).toBe(ids[0]);
    expect(Buffer.byteLength(first.page.nextCursor!)).toBeLessThanOrEqual(4096);
    const second = await usage.associations(saved.selection.id, identity, recordId, { limit: 1, cursor: first.page.nextCursor! });
    expect(second.value[0].reportAgentId).toBe(ids[1]);
    expect(second.value[0].target).toMatchObject({ packageId: ids[1] });
    const previous = await usage.associations(saved.selection.id, identity, recordId, { limit: 1, cursor: second.page.previousCursor! });
    expect(previous.value).toEqual(first.value);
    expect(query.mock.calls.filter(([sql]) => String(sql).includes("SELECT a.agent_id,a.name,a.responses::text"))
      .map(([, values]) => values?.[9])).toEqual(["", ids[0], ids[1]]);
    await expect(usage.associations(saved.selection.id, identity, `agent:${snapshotId}`,
      { limit: 1, cursor: first.page.nextCursor! })).rejects.toMatchObject({ code: "invalid_cursor" });
  });
});

describe("agent usage mutation failure receipts", () => {
  const recordId = "agent:abcdefab-1234-4567-89ab-abcdefabcdef";
  const actor = { tenantId: identity.tenantId, homeAccountId: identity.principalId,
    username: "reviewer@example.invalid", displayName: "Reviewer" };
  const input = { selectionId: "11111111-1111-4111-8111-111111111111", reportSetId: "22222222-2222-4222-8222-222222222222",
    usageRevision: "a".repeat(64), inventoryRevision: "b".repeat(64), reportAgentId: "Exact-Report-ID",
    confirmed: true as const, target: { source: "graph_packages" as const, packageId: "Exact-Package-ID" } };

  function failureHarness() {
    const primary = new AppError(409, "inventory_changed", "Exact source references changed.");
    vi.spyOn(reports.history.connections, "run").mockRejectedValue(primary);
    const start = vi.spyOn(AuditLog.prototype, "startEvent").mockImplementation(async intent =>
      ({ ...intent, id: "review-event", startedAt: "2026-01-01T00:00:00Z", status: "started" }));
    return { primary, start, usage: new OfficialAgentUsage(reports) };
  }

  it.each(["read", "write"] as const)("preserves the mutation failure when the failure receipt %s fails", async boundary => {
    const { primary, usage } = failureHarness(), cleanup = new Error("Failure receipt unavailable.");
    const get = vi.spyOn(AuditLog.prototype, "getEvent");
    const complete = vi.spyOn(AuditLog.prototype, "completeEvent");
    if (boundary === "read") get.mockRejectedValue(cleanup);
    else { get.mockResolvedValue(undefined); complete.mockRejectedValue(cleanup); }
    await expect(usage.mutate(identity, recordId, input, actor)).rejects.toMatchObject({
      name: "AggregateError", errors: [primary, cleanup],
    });
    if (boundary === "read") expect(complete).not.toHaveBeenCalled();
    else expect(complete).toHaveBeenCalledWith("review-event", { status: "failed", errorCode: "inventory_changed" });
  });

  it("propagates the original failure after persisting its failed receipt", async () => {
    const { primary, start, usage } = failureHarness();
    vi.spyOn(AuditLog.prototype, "getEvent").mockResolvedValue(undefined);
    const complete = vi.spyOn(AuditLog.prototype, "completeEvent").mockImplementation(async (id, update) => ({
      id, ...update, actor, operationId: "review-operation", action: "associate-agent-usage", scope: "single", agentId: recordId,
      requestPath: `/api/agent-inventory/${encodeURIComponent(recordId)}/usage-associations`, startedAt: "2026-01-01T00:00:00Z",
    }));
    await expect(usage.mutate(identity, recordId, input, actor)).rejects.toBe(primary);
    expect(complete).toHaveBeenCalledWith("review-event", { status: "failed", errorCode: "inventory_changed" });
    expect(start).toHaveBeenCalledWith(expect.objectContaining({
      agentId: recordId, actor, requestPath: `/api/agent-inventory/${encodeURIComponent(recordId)}/usage-associations`,
    }));
  });

  it("does not replace a durable success receipt after a transaction completion failure", async () => {
    const { primary, usage } = failureHarness();
    vi.spyOn(AuditLog.prototype, "getEvent").mockResolvedValue({ id: "review-event", actor, operationId: "review-operation", action: "associate-agent-usage",
      scope: "single", agentId: recordId, status: "succeeded", requestPath: `/api/agent-inventory/${encodeURIComponent(recordId)}/usage-associations`,
      startedAt: "2026-01-01T00:00:00Z" });
    const complete = vi.spyOn(AuditLog.prototype, "completeEvent");
    await expect(usage.mutate(identity, recordId, input, actor)).rejects.toBe(primary);
    expect(complete).not.toHaveBeenCalled();
  });
});
