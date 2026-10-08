import pg from "pg";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type { ReportEndpoint } from "../types/officialReportData.js";
import type { UserSourceMetadata } from "../types/userSources.js";
import { canonicalQuery, type SelectionIdentity } from "./dataSelections.js";
import { LargeTenantUsersReports, reportQuery, reportQueryFields, type ReportReadContext } from "./largeTenantUsersReports.js";

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

it.each([" \u00a8 ", "J\u030c", "\ud835\udc09\u030c", "\u337f".repeat(64), "\u0130".repeat(128)])(
  "rereads a saved selection without changing its normalized search or query hash: %s", async search => {
    const saved = readContext("official_users", search);
    const client = Object.assign(new pg.Client(), { release: vi.fn() });
    vi.spyOn(client, "query").mockResolvedValue({
      command: "SELECT", rowCount: 1, oid: 0, fields: [],
      rows: [{
        endpoint: saved.endpoint, query_json: saved.query, query_hash: saved.queryHash, revision: saved.selection.revision,
        evaluated_at: saved.evaluatedAt, expires_at: new Date(saved.selection.expiresAt), validated_at: saved.evaluatedAt,
        token_mode: saved.tokenMode, metadata: { ...saved.metadata, publicationRevisions: saved.selection.publicationRevisions }, report_metadata: saved.report,
      }],
    });
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
