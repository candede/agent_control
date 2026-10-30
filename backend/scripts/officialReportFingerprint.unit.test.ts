import pg from "pg";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SelectionIdentity } from "../src/services/dataSelections.js";
import { LargeTenantUsersReports, type ReportReadContext } from "../src/services/largeTenantUsersReports.js";
import type { ReportPage, ReportRow } from "../src/types/officialReportData.js";
import type { UserSourceMetadata } from "../src/types/userSources.js";
import { officialReportFingerprint } from "./officialReportFingerprint.js";

const database = new pg.Pool({ max: 4 });
const reports = new LargeTenantUsersReports(database, "synthetic-fingerprint-unit-secret", 35);
const identity: SelectionIdentity = {
  tenantId: "fingerprint-tenant", principalId: "fingerprint-principal", authorizationHash: "viewer", sessionEpoch: "1",
};

beforeEach(() => { vi.spyOn(database, "connect").mockRejectedValue(new Error("Unexpected database acquisition")); });
afterEach(() => { vi.restoreAllMocks(); });
afterAll(async () => { await database.end(); });

function source(source: UserSourceMetadata["source"]): UserSourceMetadata {
  return { source, generationId: null, scopeId: null, revision: null, expiresAt: null, observedAt: null,
    attemptedAt: null, attemptStatus: null, attemptObservedCount: null, errorCode: null, message: null,
    rowCount: null, state: "unavailable", reportRefreshDate: null, period: null, reportVersion: null };
}

function fixture() {
  const client = Object.assign(new pg.Client(), { release: vi.fn() });
  vi.spyOn(client, "query").mockRejectedValue(new Error("Unexpected database query"));
  const at = new Date("2030-01-01T00:00:00Z");
  const context: ReportReadContext = {
    identity, endpoint: "official_agents", query: {}, queryHash: "fingerprint-query", evaluatedAt: at,
    selection: { id: "selected", revision: "revision", evaluatedAt: at.toISOString(), validatedAt: at.toISOString(),
      expiresAt: new Date(at.getTime() + 600_000).toISOString(),
      publicationRevisions: { graph_packages: "1".repeat(64), power_platform: "2".repeat(64), users: "3".repeat(64) } },
    metadata: { directory: source("directory"), app_activity: source("app_activity") },
    report: { setId: "active-set", activeSetId: "active-set", activeRevision: "7", historyRevision: "9", historyEpoch: "1",
      availability: "active", staleAfterDays: 35, periodAgeDays: 0, acceptedAgeDays: 0,
      reportingPeriod: null, acceptedAt: at.toISOString(), expiresAt: null,
      lineages: (["users", "agents", "userAgents"] as const).map((kind, index) => ({
        kind, versionId: `00000000-0000-4000-8000-00000000000${[2, 3, 1][index]}`,
        contentHash: String(index + 1).repeat(64), rowCount: index + 10,
        sourceAsOf: null, sourceAsOfProvenance: "absent", sourceFreshness: "unknown", periodProvenance: "activity_range",
      })) },
  };
  const selected = { id: context.selection.id, revision: context.selection.revision, endpoint: context.endpoint,
    queryHash: context.queryHash, evaluatedAt: at, validatedAt: at, expiresAt: new Date(context.selection.expiresAt) };
  const capture = vi.spyOn(reports, "capture").mockResolvedValue(selected);
  const read = vi.spyOn(reports, "read").mockImplementation((_id, _identity, work) => work(client, context));
  const agents: ReportPage<ReportRow> = {
    value: [], counts: { total: 17, filtered: 17 }, page: { limit: 1, nextCursor: null, previousCursor: null },
    selection: context.selection, reports: context.report, sources: context.metadata, filters: context.query,
    summary: { checkedUsers: null, licensedUsers: null, measuredActivityUsers: null, needsAttentionUsers: null,
      usingAgentsUsers: null, noAgentActivityUsers: null, unknownMetricsUsers: null, unresolvedIdentities: 0,
      activeWithoutPaidUsers: null, paidActiveReportUsers: null, unknownLicenseActiveReportUsers: 5,
      reportedResponses: 900, bridgeResponses: 850, userReportedResponses: 800, distinctActiveReportUsers: 5,
      licensedOccurrences: null, unlicensedOccurrences: null, responseReconciliation: "mismatch", activeUsersAreNonAdditive: true },
    analytics: { basis: "filtered_rows", rowCount: 17, responses: 900, zeroResponses: 0, unknownResponses: 0,
      review: null, agents: null, history: null, overview: null },
  };
  const users: Awaited<ReturnType<LargeTenantUsersReports["rowsInRead"]>> = {
    raw: [], value: [], counts: { total: 19, filtered: 19 }, page: { limit: 1, nextCursor: null, previousCursor: null },
    summaryRow: undefined, analyticsRow: undefined,
  };
  const page = vi.spyOn(reports, "pageInRead").mockResolvedValue(agents);
  const rows = vi.spyOn(reports, "rowsInRead").mockResolvedValue(users);
  return { client, context, agents, users, capture, read, page, rows };
}

describe("official report restart fingerprints", () => {
  it("uses full counts and distinct summary metrics from one bounded selected read", async () => {
    const saved = fixture();
    expect(await officialReportFingerprint(reports, identity)).toEqual({
      activeSetId: "active-set", activeRevision: "7",
      lineage: [saved.context.report.lineages[2], saved.context.report.lineages[0], saved.context.report.lineages[1]],
      aggregate: { responses: 900, activeUsers: 5, reportAgents: 17 },
      users: { count: 19, responses: 800, accessRows: 12 },
    });
    expect(saved.capture.mock.calls).toEqual([[identity, "official_agents"]]);
    expect(saved.read).toHaveBeenCalledOnce();
    expect(saved.read).toHaveBeenCalledWith(saved.context.selection.id, identity, expect.any(Function));
    expect(saved.page.mock.calls).toEqual([[saved.client, saved.context, { limit: 1 }]]);
    expect(saved.rows.mock.calls).toEqual([[saved.client, saved.context, { endpoint: "official_users", limit: 1 }]]);
  });

  it("normalizes lineage order without mutating the captured metadata or losing provenance", async () => {
    const saved = fixture(), original = structuredClone(saved.context.report.lineages);
    const first = await officialReportFingerprint(reports, identity);
    expect(saved.context.report.lineages).toEqual(original);
    expect(first.lineage).not.toBe(saved.context.report.lineages);
    saved.context.report.lineages.reverse();
    const reversed = structuredClone(saved.context.report.lineages);
    expect(await officialReportFingerprint(reports, identity)).toEqual(first);
    expect(saved.context.report.lineages).toEqual(reversed);
  });

  it.each([null, 0])("preserves %s response evidence instead of conflating missing reports and measured zero", async metric => {
    const saved = fixture();
    saved.agents.summary.reportedResponses = metric;
    saved.agents.summary.userReportedResponses = metric;
    saved.agents.summary.distinctActiveReportUsers = metric;
    saved.agents.counts.total = 0;
    saved.users.counts.total = 0;
    if (metric === null) {
      Object.assign(saved.context.report, { setId: null, activeSetId: null, availability: "never_imported", lineages: [] });
    } else {
      saved.context.report.lineages.forEach(lineage => { lineage.rowCount = 0; });
    }
    expect(await officialReportFingerprint(reports, identity)).toMatchObject({
      activeSetId: metric === null ? null : "active-set",
      aggregate: { responses: metric, activeUsers: metric, reportAgents: 0 },
      users: { count: 0, responses: metric, accessRows: 0 },
    });
  });

  it.each(["capture", "read", "page", "rows", "validation"] as const)("propagates %s failures without returning a partial fingerprint", async stage => {
    const saved = fixture(), failure = new Error(`Synthetic ${stage} failure`);
    if (stage === "validation") {
      saved.read.mockImplementation(async (_id, _identity, work) => {
        await work(saved.client, saved.context);
        throw failure;
      });
    } else {
      saved[stage].mockRejectedValueOnce(failure);
    }
    await expect(officialReportFingerprint(reports, identity)).rejects.toBe(failure);
    if (stage === "capture" || stage === "read") expect(saved.page).not.toHaveBeenCalled();
    if (stage === "capture" || stage === "read" || stage === "page") expect(saved.rows).not.toHaveBeenCalled();
    if (stage === "validation") expect(saved.rows).toHaveBeenCalledOnce();
  });
});
