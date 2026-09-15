import { describe, expect, it } from "vitest";
import type { PublishedOfficialUsage } from "../types/officialUsage.js";
import { buildOfficialUsageAggregateView, buildOfficialUsageUserView } from "./officialUsageViews.js";

const set = {
  id: "11111111-1111-4111-8111-111111111111",
  bundleId: "22222222-2222-4222-8222-222222222222",
  reportingPeriod: { startDate: "2026-06-07", endDate: "2026-07-06", provenance: "source_metadata" as const },
  supersedesSetId: null,
  complete: true,
  kinds: ["agents", "userAgents", "users"] as const,
  acceptedAt: "2026-07-08T12:00:00.000Z",
  deletedAt: null,
  createdAt: "2026-07-08T12:00:00.000Z",
  expiresAt: "2027-01-04T12:00:00.000Z",
};
const common = {
  parserVersion: "1",
  schemaVersion: "observed-v1",
  reportingPeriod: { startDate: "2026-06-07", endDate: "2026-07-06", days: 30, provenance: "source_metadata" as const },
  sourceAsOf: "2026-07-08T12:00:00.000Z",
  sourceAsOfProvenance: "source_metadata" as const,
  sourceFreshness: "known" as const,
  warnings: [],
};
const lineage = (kind: "agents" | "userAgents" | "users", versionId: string, rowCount: number) => ({
  kind,
  versionId,
  fileHash: "a".repeat(64),
  parserVersion: common.parserVersion,
  schemaVersion: common.schemaVersion,
  reportingPeriod: common.reportingPeriod,
  sourceAsOf: common.sourceAsOf,
  sourceAsOfProvenance: common.sourceAsOfProvenance,
  sourceFreshness: common.sourceFreshness,
  acceptedAt: "2026-07-08T12:00:00.000Z",
  rowCount,
  warnings: [],
  reconciliation: {},
  supersedesVersionId: null,
});

function published(): PublishedOfficialUsage {
  return {
    activeRevision: 2,
    activeSet: { ...set, kinds: [...set.kinds] },
    retainedCompleteSets: 1,
    retainedIncompleteSets: 0,
    hasImportHistory: true,
    activeSelectionIncomplete: false,
    reports: {
      agents: {
        ...common,
        kind: "agents",
        lineage: lineage("agents", "33333333-3333-4333-8333-333333333333", 2),
        rows: [
          { agentId: "usage-a", agentName: "Agent A", creatorType: "Declarative", activeUsersLicensed: 2, activeUsersUnlicensed: 1, responsesSentToUsers: 9, lastActivityDateUtc: "2026-07-06T00:00:00.000Z" },
          { agentId: "usage-b", agentName: "Agent B", creatorType: "Custom", activeUsersLicensed: 1, activeUsersUnlicensed: 0, responsesSentToUsers: 4, lastActivityDateUtc: "2026-06-01T00:00:00.000Z" },
        ],
      },
      userAgents: {
        ...common,
        kind: "userAgents",
        lineage: lineage("userAgents", "44444444-4444-4444-8444-444444444444", 4),
        rows: [
          { agentId: "usage-a", agentName: "Agent A", creatorType: "Declarative", username: "CaseSensitiveUser", responsesSentToUsers: 5, lastActivityDateUtc: "2026-07-06T00:00:00.000Z" },
          { agentId: "usage-b", agentName: "Agent B", creatorType: "Custom", username: "CaseSensitiveUser", responsesSentToUsers: 4, lastActivityDateUtc: "2026-06-01T00:00:00.000Z" },
          { agentId: "usage-a", agentName: "Agent A", creatorType: "Declarative", username: "casesensitiveuser", responsesSentToUsers: 4, lastActivityDateUtc: "2026-07-05T00:00:00.000Z" },
          { agentId: "usage-report-only", agentName: "Report-only agent", creatorType: "Your Users", username: "CaseSensitiveUser", responsesSentToUsers: 2, lastActivityDateUtc: "2026-07-06T00:00:00.000Z" },
        ],
      },
      users: {
        ...common,
        kind: "users",
        lineage: lineage("users", "55555555-5555-4555-8555-555555555555", 2),
        rows: [
          { username: "CaseSensitiveUser", displayName: "Pseudonym A", numberOfAgentsUsed: 2, agentResponsesReceived: 9, lastActivityDateUtc: "2026-07-06T00:00:00.000Z" },
          { username: "casesensitiveuser", displayName: "Pseudonym B", numberOfAgentsUsed: 1, agentResponsesReceived: 4, lastActivityDateUtc: "2026-07-05T00:00:00.000Z" },
        ],
      },
    },
  };
}

describe("official usage views", () => {
  it("computes aggregate metrics without treating active-user counts as additive identities", () => {
    const result = buildOfficialUsageAggregateView(published(), [], {
      staleAfterDays: 35,
      inactiveDays: 30,
      activityWindowDays: 30,
      now: new Date("2026-07-10T00:00:00.000Z"),
    });

    expect(result.availability).toBe("active");
    expect(result.summary.usage).toMatchObject({ totalResponses: 13, totalResponsesBasis: "agents_report", totalResponsesCoverage: "agents_report_only", totalActiveUsers: 2, totalActiveUsersBasis: "users_and_users_agents_distinct_identity", activeUsersAreNonAdditive: true });
    expect(result.summary.usage.responseReconciliation).toMatchObject({ status: "mismatch", sourceValues: { agents: 13, userAgents: 15, users: 13 } });
    expect(result.summary.activityWindow).toMatchObject({ activeAgents: 2, activeUsers: 2, responses: 9, responseBasis: "agents_report" });
    expect(result.agents.count).toBe(3);
    expect(result.agents.value).toEqual(expect.arrayContaining([
      expect.objectContaining({ agentId: "usage-a", identityStatus: "unresolved", activeUsersTotal: 2, activeUsersTotalBasis: "userAgents_distinct_identity" }),
    ]));
    expect(result.missingKinds).toEqual([]);
  });

  it("preserves case-distinct pseudonyms and reports discrepancies without guessed package joins", () => {
    const result = buildOfficialUsageUserView(published(), { staleAfterDays: 35, limit: 1 });

    expect(result.counts).toMatchObject({ users: 2, accessRows: 4, reportOnlyRows: 4, mismatchCount: 1 });
    expect(result.users.count).toBe(2);
    expect(result.users.value).toHaveLength(1);
    expect(result.users.value[0]).toMatchObject({ username: "CaseSensitiveUser", displayName: "Pseudonym A" });
    expect(result.users.value[0].rows.every(row => row.packageStatus === "report-only" && row.identityStatus === "unresolved")).toBe(true);
    expect(result.topUsersByResponses[0]).toMatchObject({ responses: 9, responsesSource: "users", agentsUsed: 2, agentsUsedSource: "users" });
    expect(result.users.value[0].userLastActivityDateUtc).toBe("2026-07-06T00:00:00.000Z");
    expect(result.lineages[0]).toMatchObject({ kind: "agents", schemaVersion: "observed-v1", sourceFreshness: "known" });
  });

  it("distinguishes never imported, incomplete, unselected, and stale states", () => {
    const base = { activeRevision: 1, activeSet: null, reports: {}, activeSelectionIncomplete: false } as const;
    expect(buildOfficialUsageAggregateView({ ...base, retainedCompleteSets: 0, retainedIncompleteSets: 0, hasImportHistory: false }, [], { staleAfterDays: 35 }).availability).toBe("never_imported");
    expect(buildOfficialUsageAggregateView({ ...base, retainedCompleteSets: 0, retainedIncompleteSets: 1, hasImportHistory: true }, [], { staleAfterDays: 35 }).availability).toBe("incomplete");
    expect(buildOfficialUsageAggregateView({ ...base, retainedCompleteSets: 1, retainedIncompleteSets: 0, hasImportHistory: true }, [], { staleAfterDays: 35 }).availability).toBe("not_selected");
    expect(buildOfficialUsageAggregateView({ ...base, retainedCompleteSets: 0, retainedIncompleteSets: 0, hasImportHistory: true }, [], { staleAfterDays: 35 }).availability).toBe("deleted");
    expect(buildOfficialUsageAggregateView(published(), [], { staleAfterDays: 35, now: new Date("2026-09-01T00:00:00.000Z") }).availability).toBe("stale");
    const oldAcceptance = published();
    oldAcceptance.activeSet = { ...oldAcceptance.activeSet!, reportingPeriod: { startDate: "2026-08-03", endDate: "2026-09-01", provenance: "source_metadata" }, acceptedAt: "2026-06-01T00:00:00.000Z" };
    expect(buildOfficialUsageAggregateView(oldAcceptance, [], { staleAfterDays: 35, now: new Date("2026-09-02T00:00:00.000Z") }).availability).toBe("stale");
  });

  it("keeps unknown source coverage dates nullable instead of inventing a reporting period", () => {
    const source = published();
    source.activeSet = {
      ...source.activeSet!,
      reportingPeriod: { startDate: null, endDate: null, provenance: "activity_range" },
      acceptedAt: "2026-09-12T00:00:00.000Z",
    };
    for (const report of Object.values(source.reports)) {
      if (report) report.lineage.reportingPeriod = { startDate: null, endDate: null, days: null, provenance: "activity_range" };
    }

    const result = buildOfficialUsageAggregateView(source, [], {
      staleAfterDays: 35,
      now: new Date("2026-09-12T12:00:00.000Z"),
    });

    expect(result).toMatchObject({ availability: "active", periodAgeDays: null, acceptedAgeDays: 0 });
    expect(result.lineages.every(item => item.reportingPeriod.startDate === null && item.reportingPeriod.endDate === null)).toBe(true);
  });

  it("filters the complete dataset before paging", () => {
    const result = buildOfficialUsageUserView(published(), { staleAfterDays: 35, search: "pseudonym b", limit: 1 });
    expect(result.users).toMatchObject({ count: 1, value: [expect.objectContaining({ username: "casesensitiveuser" })] });
  });

  it("sorts all agent rows before paging and retains undated rows until a date filter is selected", () => {
    const source = published();
    source.reports.agents!.rows.push({
      agentId: "undated",
      agentName: "Undated",
      creatorType: "Agent built by Microsoft",
      activeUsersLicensed: 0,
      activeUsersUnlicensed: 0,
      responsesSentToUsers: 50,
    });
    const sorted = buildOfficialUsageAggregateView(source, [], {
      staleAfterDays: 35,
      agentSortBy: "responses",
      sortDirection: "desc",
      limit: 1,
      offset: 1,
    });
    expect(sorted.agents.count).toBe(4);
    expect(sorted.agents.value[0]).toMatchObject({ agentId: "usage-a", responsesSentToUsers: 9 });

    const dated = buildOfficialUsageAggregateView(source, [], {
      staleAfterDays: 35,
      startDate: "2026-01-01",
      limit: 100,
    });
    expect(dated.agents.value.map(agent => agent.agentId)).not.toContain("undated");
  });

  it("uses inclusive UTC civil date filters while the default retains unknown dates", () => {
    const source = published();
    source.reports.users!.rows.push({
      username: "unknown-date",
      displayName: "Unknown date",
      numberOfAgentsUsed: 0,
      agentResponsesReceived: 0,
    });

    const unfiltered = buildOfficialUsageUserView(source, { staleAfterDays: 35, limit: 100 });
    expect(unfiltered.users.value.map(user => user.username)).toContain("unknown-date");
    expect(unfiltered.cohorts).toMatchObject({ zeroResponses: 1, lowResponses: 1, reviewCandidates: 2, missingBridgeRows: 1, threshold: 5 });

    const filtered = buildOfficialUsageUserView(source, {
      staleAfterDays: 35,
      startDate: "2026-07-05",
      endDate: "2026-07-05",
      limit: 100,
    });
    expect(filtered.users.value.map(user => user.username)).toEqual(["casesensitiveuser"]);
    expect(filtered.filters).toMatchObject({ startDate: "2026-07-05", endDate: "2026-07-05" });
  });

  it("applies cohort boundaries and sorts the full result before paging", () => {
    const source = published();
    source.reports.users!.rows.push(
      { username: "zero", displayName: "Zero", numberOfAgentsUsed: 0, agentResponsesReceived: 0 },
      { username: "boundary", displayName: "Boundary", numberOfAgentsUsed: 1, agentResponsesReceived: 4, lastActivityDateUtc: "2026-07-01T00:00:00.000Z" },
      { username: "above", displayName: "Above", numberOfAgentsUsed: 1, agentResponsesReceived: 5, lastActivityDateUtc: "2026-07-01T00:00:00.000Z" },
    );
    const result = buildOfficialUsageUserView(source, {
      staleAfterDays: 35,
      lowResponseThreshold: 4,
      cohort: "review",
      userSortBy: "responses",
      sortDirection: "desc",
      limit: 1,
    });

    expect(result.cohorts).toMatchObject({ zeroResponses: 1, lowResponses: 2, reviewCandidates: 3, threshold: 4 });
    expect(result.users.count).toBe(3);
    expect(result.users.value[0]).toMatchObject({ reportedResponsesReceived: 4, reviewCohort: "low_responses" });
    expect(result.users.value.map(user => user.username)).not.toContain("above");
  });

  it("anchors user inactivity to the latest observed Users date rather than today's clock", () => {
    const result = buildOfficialUsageUserView(published(), {
      staleAfterDays: 35,
      activity: "recent",
      inactiveDays: 1,
      now: new Date("2036-01-01T00:00:00.000Z"),
      limit: 100,
    });

    expect(result.recencyAnchorDateUtc).toBe("2026-07-06T00:00:00.000Z");
    expect(result.users.value.map(user => user.username)).toEqual(expect.arrayContaining(["CaseSensitiveUser", "casesensitiveuser"]));
  });

  it("ignores old additive scalars and reports unknown per-agent totals without the identity bridge", () => {
    const source = published();
    (source.reports.agents!.rows[0] as typeof source.reports.agents.rows[number] & { activeUsersTotal: number }).activeUsersTotal = 999;
    const withBridge = buildOfficialUsageAggregateView(source, [], { staleAfterDays: 35 });
    expect(withBridge.agents.value.find(agent => agent.agentId === "usage-a")).toMatchObject({
      activeUsersLicensed: 2,
      activeUsersUnlicensed: 1,
      activeUsersTotal: 2,
      activeUsersIdentityCount: 2,
      activeUsersTotalBasis: "userAgents_distinct_identity",
    });

    source.reports.userAgents = undefined;
    const withoutBridge = buildOfficialUsageAggregateView(source, [], { staleAfterDays: 35 });
    expect(withoutBridge.agents.value.find(agent => agent.agentId === "usage-a")).toMatchObject({
      activeUsersLicensed: 2,
      activeUsersUnlicensed: 1,
      activeUsersTotal: null,
      activeUsersIdentityCount: null,
      activeUsersTotalBasis: "unknown",
    });
    expect(withoutBridge.summary.usage.topAgentsByActiveUsers).toEqual([]);
  });

  it("preserves a disjoint 50k plus 50k identity union for export paging", () => {
    const source = published();
    source.reports.agents!.rows = Array.from({ length: 50_000 }, (_, index) => ({
      agentId: `agents-report-${index}`,
      agentName: `Agents report ${index}`,
      creatorType: "Declarative",
      activeUsersLicensed: 1,
      activeUsersUnlicensed: 0,
      responsesSentToUsers: 1,
      lastActivityDateUtc: "2026-07-06T00:00:00.000Z",
    }));
    source.reports.userAgents!.rows = Array.from({ length: 50_000 }, (_, index) => ({
      agentId: `agent-${index}`,
      agentName: `Agent ${index}`,
      creatorType: "Declarative",
      username: `bridge-${String(index).padStart(5, "0")}`,
      responsesSentToUsers: 1,
      lastActivityDateUtc: "2026-07-06T00:00:00.000Z",
    }));
    source.reports.users!.rows = Array.from({ length: 50_000 }, (_, index) => ({
      username: `user-${String(index).padStart(5, "0")}`,
      displayName: `User ${index}`,
      numberOfAgentsUsed: 1,
      agentResponsesReceived: 1,
      lastActivityDateUtc: "2026-07-06T00:00:00.000Z",
    }));

    const result = buildOfficialUsageUserView(source, { staleAfterDays: 35, limit: 100_000 });

    expect(result.counts).toMatchObject({ users: 100_000, userRows: 50_000, accessRows: 50_000 });
    expect(result.users.count).toBe(100_000);
    expect(result.users.value).toHaveLength(100_000);
    expect(result.users.value.some(user => user.username === "bridge-49999")).toBe(true);
    expect(result.users.value.some(user => user.username === "user-00000")).toBe(true);
    const aggregate = buildOfficialUsageAggregateView(source, [], { staleAfterDays: 35, limit: 100_000 });
    expect(aggregate.summary.usage.totalActiveUsers).toBe(100_000);
    expect(aggregate.agents.count).toBe(100_000);
    expect(aggregate.agents.value).toHaveLength(100_000);
  });
});
