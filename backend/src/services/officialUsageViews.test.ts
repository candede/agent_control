import { describe, expect, it } from "vitest";
import type { PublishedOfficialUsage } from "../types/officialUsage.js";
import type { CopilotServiceSummaryState } from "../types/copilotUsage.js";
import type { SavedCopilotUsageSource } from "../db/dataSync.js";
import type { CopilotDirectoryUser } from "./copilotUsageGraph.js";
import { buildOfficialUsageAgentDetailView, buildOfficialUsageAgentUsersView, buildOfficialUsageAggregateView, buildOfficialUsageUserView } from "./officialUsageViews.js";

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

describe("combined agent user list", () => {
  it("deduplicates users and report IDs, sums only this agent's responses, and retains exact report names", () => {
    const view = buildOfficialUsageAgentUsersView(published(), ["usage-a", "usage-b", "usage-a"], { staleAfterDays: 35 });
    expect(view.agentIds).toEqual(["usage-a", "usage-b"]);
    expect(view.users.count).toBe(2);
    expect(view.users.value).toEqual([
      { username: "CaseSensitiveUser", displayName: "Pseudonym A", responsesSentToUsers: 9 },
      { username: "casesensitiveuser", displayName: "Pseudonym B", responsesSentToUsers: 4 },
    ]);
  });

  it("searches before paging, excludes zero activity and does not invent identities or fall back to other agents", () => {
    const data = published();
    data.reports.userAgents!.rows.push({ ...data.reports.userAgents!.rows[0], username: "zero", responsesSentToUsers: 0 });
    expect(buildOfficialUsageAgentUsersView(data, ["usage-a"], { staleAfterDays: 35, search: "Pseudonym", limit: 1, offset: 1 }).users)
      .toMatchObject({ count: 2, value: [{ username: "casesensitiveuser", responsesSentToUsers: 4 }] });
    expect(buildOfficialUsageAgentUsersView(data, ["usage-a"], { staleAfterDays: 35, search: "missing" }).users.count).toBe(0);
    expect(() => buildOfficialUsageAgentUsersView(data, ["USAGE-A"], { staleAfterDays: 35 })).toThrow("not found");
    delete data.reports.userAgents;
    expect(() => buildOfficialUsageAgentUsersView(data, ["usage-a"], { staleAfterDays: 35 })).toThrow("Users and agents CSV");
  });
});

function drilldownPublished() {
  const source = published();
  source.reports.userAgents!.rows.push(
    { agentId: "usage-a", agentName: "Agent A", creatorType: "Declarative", username: "zero-user", responsesSentToUsers: 0, lastActivityDateUtc: "2026-07-06T00:00:00.000Z" },
    { agentId: "usage-a", agentName: "Agent A", creatorType: "Declarative", username: "bridge-only", responsesSentToUsers: 2, lastActivityDateUtc: "2026-07-06T00:00:00.000Z" },
    { agentId: "usage-A", agentName: "Agent A", creatorType: "Declarative", username: "upper-only", responsesSentToUsers: 11, lastActivityDateUtc: "2026-07-06T00:00:00.000Z" },
  );
  source.reports.users!.rows.push(
    { username: "zero-user", displayName: "Zero User", numberOfAgentsUsed: 0, agentResponsesReceived: 0 },
    { username: "users-only", displayName: "No bridge rows", numberOfAgentsUsed: 8, agentResponsesReceived: 900 },
  );
  return source;
}

function savedLicenses(entries: Array<[string, CopilotServiceSummaryState]>): SavedCopilotUsageSource<CopilotDirectoryUser[]> {
  const observedAt = "2026-09-23T00:00:00.000Z";
  return {
    source: "directory", attemptStatus: "available", message: "Saved license evidence.",
    attemptedAt: observedAt, lastSuccessAt: observedAt, observedAt, rowCount: entries.length,
    value: entries.map(([userPrincipalName, copilotServiceState], index) => ({
      serviceEvidenceVersion: 1, copilotServiceState, servicePlans: [],
      identity: {
        objectId: `11111111-1111-4111-8111-${String(index).padStart(12, "0")}`, userPrincipalName,
        displayName: userPrincipalName, accountEnabled: true, userType: "Member", employeeType: null, companyName: null, department: null,
      },
    })),
  };
}

describe("official usage views", () => {
  it("filters active unpaid users before paging, rankings, counts and relationship search", () => {
    const source = published();
    source.reports.users!.rows = [
      { username: "paid@example.com", displayName: "Paid", numberOfAgentsUsed: 1, agentResponsesReceived: 900 },
      { username: "unpaid@example.com", displayName: "Unpaid", numberOfAgentsUsed: 2, agentResponsesReceived: 7 },
      { username: "suspended@example.com", displayName: "Suspended", numberOfAgentsUsed: 1, agentResponsesReceived: 3 },
      { username: "unknown@example.com", displayName: "Unknown", numberOfAgentsUsed: 1, agentResponsesReceived: 50 },
      { username: "unmatched@example.com", displayName: "Unmatched", numberOfAgentsUsed: 1, agentResponsesReceived: 60 },
      { username: "zero@example.com", displayName: "Zero", numberOfAgentsUsed: 0, agentResponsesReceived: 0 },
    ];
    source.reports.userAgents!.rows = [
      { agentId: "agent-a", agentName: "Find me", creatorType: "Custom", username: "unpaid@example.com", responsesSentToUsers: 2 },
      { agentId: "agent-b", agentName: "Another", creatorType: "Custom", username: "unpaid@example.com", responsesSentToUsers: 5 },
      { agentId: "agent-a", agentName: "Find me", creatorType: "Custom", username: "bridge@example.com", responsesSentToUsers: 1 },
    ];
    const licenseDirectory = savedLicenses([
      ["paid@example.com", "enabled"], ["unpaid@example.com", "disabled"],
      ["suspended@example.com", "suspended"], ["unknown@example.com", "unknown"],
      ["zero@example.com", "disabled"], ["bridge@example.com", "disabled"],
    ]);
    const options = { staleAfterDays: 35, licenseCohort: "active_without_paid" as const, licenseDirectory };
    const result = buildOfficialUsageUserView(source, { ...options, limit: 1, offset: 1 });
    expect(result.users).toMatchObject({ count: 3, limit: 1, offset: 1, value: [{ username: "suspended@example.com", licenseAssignmentStatus: "no_active_paid_license" }] });
    expect(result.counts).toMatchObject({ users: 3, filteredUsers: 3, userRows: 2, accessRows: 3, totalResponsesReceived: 10 });
    expect(result.topUsersByResponses.map(user => user.username)).toEqual(["unpaid@example.com", "suspended@example.com", "bridge@example.com"]);
    expect(result.topUsersByResponses.at(-1)).toMatchObject({ responses: 1, responsesSource: "userAgents" });
    expect(result.licenseCoverage).toEqual({
      state: "available", observedAt: licenseDirectory.observedAt, activeReportUsers: 6,
      paidUsers: 1, unpaidUsers: 3, unknownUsers: 2, message: null,
    });
    const searched = buildOfficialUsageUserView(source, { ...options, search: "Find me", limit: 1 });
    expect(searched.users.count).toBe(2);
    expect(searched.users.value[0].rows.map(row => row.agentId)).toEqual(["agent-b", "agent-a"]);
    const bridge = buildOfficialUsageUserView(source, { ...options, search: "bridge@example.com" }).users.value[0];
    expect(bridge).toMatchObject({ missingUserReport: true, reportedResponsesReceived: 0, bridgeResponsesSentToUsers: 1, licenseAssignmentStatus: "no_active_paid_license" });
  });

  it("moves users between exclusive current-license cohorts without consulting the activity period", () => {
    const source = published();
    source.reports.userAgents!.rows = [];
    source.reports.users!.rows = [
      { username: "person@example.com", displayName: "Person", numberOfAgentsUsed: 1, agentResponsesReceived: 1 },
      { username: "paid-no-activity@example.com", displayName: "No activity", numberOfAgentsUsed: 0, agentResponsesReceived: 0 },
    ];
    const licenseDirectory = savedLicenses([["person@example.com", "disabled"], ["paid-no-activity@example.com", "enabled"]]);
    const options = { staleAfterDays: 35, licenseCohort: "active_without_paid" as const, licenseDirectory };
    expect(buildOfficialUsageUserView(source, options).users.count).toBe(1);
    for (const state of ["enabled", "warning", "partially_enabled"] as const) {
      licenseDirectory.value![0].copilotServiceState = state;
      const result = buildOfficialUsageUserView(source, options);
      expect(result.users.count).toBe(0);
      expect(result.licenseCoverage).toMatchObject({ paidUsers: 1, unpaidUsers: 0 });
    }
    for (const state of ["disabled", "suspended", "locked_out"] as const) {
      licenseDirectory.value![0].copilotServiceState = state;
      expect(buildOfficialUsageUserView(source, options).users.count).toBe(1);
    }
    licenseDirectory.value![0].copilotServiceState = "unknown";
    expect(buildOfficialUsageUserView(source, options)).toMatchObject({ users: { count: 0 }, licenseCoverage: { unknownUsers: 1 } });
  });

  it("excludes unknown, expired, failed and ambiguous licensing instead of treating it as unpaid", () => {
    const source = published();
    source.reports.userAgents!.rows = [];
    source.reports.users!.rows = [
      { username: "case@example.com", displayName: "Case", numberOfAgentsUsed: 1, agentResponsesReceived: 2 },
      { username: "CASE@example.com", displayName: "Other", numberOfAgentsUsed: 1, agentResponsesReceived: 3 },
    ];
    const licenseDirectory = savedLicenses([["case@example.com", "disabled"]]);
    const options = { staleAfterDays: 35, licenseCohort: "active_without_paid" as const, licenseDirectory };
    expect(buildOfficialUsageUserView(source, options)).toMatchObject({
      users: { count: 0 }, licenseCoverage: { state: "available", unknownUsers: 2 },
    });
    source.reports.users!.rows.pop();
    source.reports.users!.rows.push({
      username: licenseDirectory.value![0].identity.objectId, displayName: "Object ID alias", numberOfAgentsUsed: 1, agentResponsesReceived: 3,
    });
    expect(buildOfficialUsageUserView(source, options)).toMatchObject({ users: { count: 0 }, licenseCoverage: { unknownUsers: 2 } });
    source.reports.users!.rows.pop();
    for (const directory of [
      undefined,
      { ...licenseDirectory, value: null },
      { ...licenseDirectory, observedAt: null },
      { ...licenseDirectory, attemptStatus: "failed" as const, message: "Directory refresh failed." },
    ]) {
      expect(buildOfficialUsageUserView(source, { ...options, licenseDirectory: directory })).toMatchObject({
        users: { count: 0, value: [] }, licenseCoverage: { state: "unavailable", paidUsers: 0, unpaidUsers: 0, unknownUsers: 1 },
      });
    }
    expect(buildOfficialUsageUserView(source, {
      ...options, licenseDirectory: { ...licenseDirectory, value: null },
    }).licenseCoverage?.message).toBe("Saved license data is missing or expired. Run Users sync.");
    expect(buildOfficialUsageUserView(source, {
      ...options, licenseDirectory: { ...licenseDirectory, value: [] },
    })).toMatchObject({
      users: { count: 0 }, licenseCoverage: { state: "available", unknownUsers: 1 },
    });
  });

  it.each(["report", "directory"] as const)("excludes object-ID aliases of %s-ambiguous users from unpaid licensing", ambiguity => {
    const source = published();
    const licenseDirectory = savedLicenses([
      ["case@example.com", "disabled"], ["control@example.com", "disabled"],
      ...(ambiguity === "directory" ? [["CASE@example.com", "disabled"] as [string, CopilotServiceSummaryState]] : []),
    ]);
    const directory = licenseDirectory.value!;
    source.reports.userAgents!.rows = [];
    source.reports.users!.rows = [
      "case@example.com",
      ambiguity === "directory" ? directory[2].identity.objectId : "CASE@example.com",
      directory[0].identity.objectId,
      "control@example.com",
    ].map(username => ({ username, displayName: username, numberOfAgentsUsed: 1, agentResponsesReceived: 3 }));

    const result = buildOfficialUsageUserView(source, {
      staleAfterDays: 35, licenseCohort: "active_without_paid", licenseDirectory,
    });
    expect(result.licenseCoverage).toMatchObject({
      state: "available", activeReportUsers: 4, paidUsers: 0, unpaidUsers: 1, unknownUsers: 3,
    });
    expect(result.users).toMatchObject({ count: 1, value: [{ username: "control@example.com" }] });
    expect(result.topUsersByResponses.map(user => user.username)).toEqual(["control@example.com"]);
  });

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

  it.each(["asc", "desc"] as const)("ranks distinct active users %s before paging and keeps missing evidence last", sortDirection => {
    const source = published();
    source.reports.agents!.rows.push({
      ...source.reports.agents!.rows[0], agentId: "unknown-reach", activeUsersLicensed: 10_000, activeUsersUnlicensed: 10_000,
    });
    source.reports.userAgents!.rows.push({
      ...source.reports.userAgents!.rows[0], agentId: "explicit-zero", responsesSentToUsers: 0,
    });
    const all = buildOfficialUsageAggregateView(source, [], { staleAfterDays: 35, agentSortBy: "activeUsers", sortDirection });
    expect(all.agents.value.at(-1)).toMatchObject({ agentId: "unknown-reach", activeUsersIdentityCount: null });
    expect(all.agents.value[0]).toMatchObject(sortDirection === "desc"
      ? { agentId: "usage-a", activeUsersIdentityCount: 2 }
      : { agentId: "explicit-zero", activeUsersIdentityCount: 0 });
    const page = buildOfficialUsageAggregateView(source, [], {
      staleAfterDays: 35, agentSortBy: "activeUsers", sortDirection, limit: 1, offset: 1,
    });
    expect(page.agents.value).toEqual(all.agents.value.slice(1, 2));
    expect(page.filters.sortBy).toBe("activeUsers");
  });

  it.each(["responses", "agentsUsed"] as const)("keeps unknown Users-report %s last in both sort directions", userSortBy => {
    const source = drilldownPublished();
    source.reports.userAgents!.rows.find(row => row.username === "bridge-only")!.responsesSentToUsers = 10_000;
    for (const sortDirection of ["asc", "desc"] as const) {
      const result = buildOfficialUsageUserView(source, { staleAfterDays: 35, userSortBy, sortDirection });
      expect(result.users.value.slice(-2).every(user => user.missingUserReport)).toBe(true);
      expect(result.users.value[0]).toMatchObject(sortDirection === "asc"
        ? { username: "zero-user", reportedResponsesReceived: 0 }
        : { username: "users-only", reportedResponsesReceived: 900 });
    }
  });

  it.each(["licensedUsers", "unlicensedUsers", "lastActivity"] as const)(
    "keeps missing agent %s last in both directions without hiding explicit zero", agentSortBy => {
      const source = published();
      source.reports.agents!.rows.push({
        ...source.reports.agents!.rows[0], agentId: "undated-zero", activeUsersLicensed: 0,
        activeUsersUnlicensed: 0, lastActivityDateUtc: undefined,
      });
      for (const sortDirection of ["asc", "desc"] as const) {
        const options = { staleAfterDays: 35, agentSortBy, sortDirection };
        const result = buildOfficialUsageAggregateView(source, [], options);
        expect(result.agents.value.at(-1)?.agentId).toBe(agentSortBy === "lastActivity" ? "undated-zero" : "usage-report-only");
        if (agentSortBy !== "lastActivity" && sortDirection === "asc") {
          expect(result.agents.value[0].agentId).toBe("undated-zero");
        }
        expect(buildOfficialUsageAggregateView(source, [], { ...options, limit: 1, offset: 3 }).agents.value)
          .toEqual(result.agents.value.slice(3));
      }
    },
  );

  it("distinguishes an absent Users report from a present empty report in response totals", () => {
    const source = published();
    source.reports.users = undefined;
    const absent = buildOfficialUsageUserView(source, { staleAfterDays: 35 });
    expect(absent.counts.totalResponsesReceived).toBeNull();
    expect(absent.users.value.every(user => user.missingUserReport && user.reviewCohort === "unknown")).toBe(true);
    source.reports.users = published().reports.users;
    source.reports.users!.rows = [];
    expect(buildOfficialUsageUserView(source, { staleAfterDays: 35 }).counts.totalResponsesReceived).toBe(0);
  });

  it("does not call missing relationship evidence a discrepancy with the Users report", () => {
    const source = published();
    source.reports.userAgents!.rows = source.reports.userAgents!.rows.filter(row => row.username !== "CaseSensitiveUser");
    const absentRows = buildOfficialUsageUserView(source, { staleAfterDays: 35 });
    expect(absentRows.users.value.find(user => user.username === "CaseSensitiveUser")).toMatchObject({
      rows: [], hasReportMismatch: false, reportedResponsesReceived: 9,
    });
    source.reports.userAgents = undefined;
    expect(buildOfficialUsageUserView(source, { staleAfterDays: 35 }).counts.mismatchCount).toBe(0);
  });

  it("rejects inexact Users-report response totals rather than rounding the report-wide count", () => {
    const source = published();
    source.reports.users!.rows[0].agentResponsesReceived = Number.MAX_SAFE_INTEGER;
    source.reports.users!.rows[1].agentResponsesReceived = 1;
    expect(() => buildOfficialUsageUserView(source, { staleAfterDays: 35 }))
      .toThrowError(expect.objectContaining({ code: "official_usage_total_limit" }));
  });

  it.each(["asc", "desc"] as const)("keeps missing user activity dates last when sorting %s before paging", sortDirection => {
    const source = published();
    source.reports.users!.rows.push({
      username: "undated-user", displayName: "Undated", numberOfAgentsUsed: 0, agentResponsesReceived: 0,
    });
    source.reports.userAgents!.rows.push({
      ...source.reports.userAgents!.rows[0], username: "bridge-only", lastActivityDateUtc: "2026-07-08T00:00:00.000Z",
    });
    const options = { staleAfterDays: 35, userSortBy: "lastActivity" as const, sortDirection };
    const result = buildOfficialUsageUserView(source, options);
    expect(result.users.value.slice(0, 2).map(user => user.username)).toEqual(sortDirection === "asc"
      ? ["casesensitiveuser", "CaseSensitiveUser"]
      : ["CaseSensitiveUser", "casesensitiveuser"]);
    expect(result.users.value.slice(2).every(user => !user.userLastActivityDateUtc)).toBe(true);
    expect(buildOfficialUsageUserView(source, { ...options, offset: 2, limit: 2 }).users.value)
      .toEqual(result.users.value.slice(2));
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
    Object.assign(source.reports.agents!.rows[0], { activeUsersTotal: 999 });
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

  it("counts distinct positive-response identities without treating reported zero rows as active users", () => {
    const source = drilldownPublished();
    source.reports.users!.rows.push({
      username: "users-only-zero", displayName: "No responses", numberOfAgentsUsed: 0, agentResponsesReceived: 0,
    });
    const result = buildOfficialUsageAggregateView(source, [], { staleAfterDays: 35 });

    expect(result.summary.usage).toMatchObject({
      totalActiveUsers: 5,
      activeUserReconciliation: { sourceValues: { users: 3, userAgents: 4 }, status: "mismatch", difference: 1 },
    });
    expect(result.summary.activityWindow.activeUsers).toBe(4);
    expect(result.agents.value.find(agent => agent.agentId === "usage-a")).toMatchObject({
      activeUsersTotal: 3, activeUsersIdentityCount: 3, activeUsersTotalBasis: "userAgents_distinct_identity",
    });
    expect(result.summary.usage.topAgentsByActiveUsers.find(agent => agent.id === "usage-a")?.activeUsers).toBe(3);
    expect(buildOfficialUsageUserView(source, { staleAfterDays: 35 }).users.value.map(user => user.username))
      .toEqual(expect.arrayContaining(["zero-user", "users-only-zero"]));
  });

  it("does not infer an active-user zero for an agent absent from an otherwise present companion report", () => {
    const source = published();
    source.reports.userAgents!.rows = source.reports.userAgents!.rows.filter(row => row.agentId !== "usage-a");
    const result = buildOfficialUsageAggregateView(source, [], { staleAfterDays: 35 });

    expect(result.agents.value.find(agent => agent.agentId === "usage-a")).toMatchObject({
      activeUsersTotal: null, activeUsersIdentityCount: null, activeUsersTotalBasis: "unknown",
    });
    expect(result.summary.usage.topAgentsByActiveUsers.map(agent => agent.id)).not.toContain("usage-a");
  });

  it.each(["activeUsersLicensed", "activeUsersUnlicensed"] as const)(
    "fails explicitly instead of publishing an inexact %s occurrence total", metric => {
      const source = published();
      source.reports.agents!.rows[0][metric] = Number.MAX_SAFE_INTEGER;
      source.reports.agents!.rows[1][metric] = 0;
      const safe = buildOfficialUsageAggregateView(source, [], { staleAfterDays: 35 });
      expect(metric === "activeUsersLicensed"
        ? safe.summary.usage.reportedLicensedActiveUserOccurrences
        : safe.summary.usage.reportedUnlicensedActiveUserOccurrences).toBe(Number.MAX_SAFE_INTEGER);

      source.reports.agents!.rows[1][metric] = 1;
      expect(() => buildOfficialUsageAggregateView(source, [], { staleAfterDays: 35 }))
        .toThrowError(expect.objectContaining({ code: "official_usage_total_limit" }));
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

describe("official usage agent detail", () => {
  it("keeps distinct report identities, nonadditive categories and mismatching source totals without inventing user dates", () => {
    const source = drilldownPublished();
    const original = structuredClone(source);
    const options = { staleAfterDays: 35, now: new Date("2026-07-10T00:00:00.000Z") };
    const detail = buildOfficialUsageAgentDetailView(source, "usage-a", options)!;
    const aggregate = buildOfficialUsageAggregateView(source, [], options);

    expect(detail.agent).toEqual(aggregate.agents.value.find(agent => agent.agentId === "usage-a"));
    expect(detail.agent).toMatchObject({
      activeUsersLicensed: 2,
      activeUsersUnlicensed: 1,
      activeUsersTotal: 3,
      activeUsersIdentityCount: 3,
      responsesSentToUsers: 9,
      responseComparison: { status: "mismatch", sourceValues: { agents: 9, userAgents: 11 }, difference: 2 },
      identityStatus: "unresolved",
    });
    expect(detail.summary).toEqual({
      reportedUsers: 4, responseProducingUsers: 3, zeroResponseUsers: 1, userBreakdownResponses: 11,
    });
    expect(detail.users.value).toEqual([
      { username: "CaseSensitiveUser", displayName: "Pseudonym A", responsesSentToUsers: 5 },
      { username: "casesensitiveuser", displayName: "Pseudonym B", responsesSentToUsers: 4 },
      { username: "bridge-only", displayName: "bridge-only", responsesSentToUsers: 2 },
      { username: "zero-user", displayName: "Zero User", responsesSentToUsers: 0 },
    ]);
    for (const user of detail.users.value) {
      expect(Object.keys(user).sort()).toEqual(["displayName", "responsesSentToUsers", "username"]);
    }
    for (const key of ["authority", "availability", "staleAfterDays", "periodAgeDays", "acceptedAgeDays", "activeSet", "lineages", "missingKinds"] as const) {
      expect(detail[key]).toEqual(aggregate[key]);
    }
    expect(source).toEqual(original);
  });

  it.each([
    ["responses", "asc", ["bridge-only", "casesensitiveuser"]],
    ["responses", "desc", ["casesensitiveuser", "bridge-only"]],
    ["displayName", "asc", ["casesensitiveuser", "zero-user"]],
    ["displayName", "desc", ["zero-user", "casesensitiveuser"]],
  ] as const)("sorts the entire user breakdown by %s %s before paging", (sortBy, sortDirection, usernames) => {
    const result = buildOfficialUsageAgentDetailView(drilldownPublished(), "usage-a", {
      staleAfterDays: 35, sortBy, sortDirection, limit: 2, offset: 1,
    })!;

    expect(result.users).toMatchObject({ count: 4, limit: 2, offset: 1 });
    expect(result.users.value.map(user => user.username)).toEqual(usernames);
    expect(result.filters).toEqual({ sortBy, sortDirection });
    expect(result.summary).toEqual({
      reportedUsers: 4, responseProducingUsers: 3, zeroResponseUsers: 1, userBreakdownResponses: 11,
    });
  });

  it("searches report display names and usernames without changing whole-agent metrics", () => {
    const source = drilldownPublished();
    const result = buildOfficialUsageAgentDetailView(source, "usage-a", {
      staleAfterDays: 35, search: " PSEUDONYM ", sortDirection: "asc", limit: 1, offset: 1,
    })!;
    expect(result.filters.search).toBe("PSEUDONYM");
    expect(result.users).toEqual({
      value: [{ username: "CaseSensitiveUser", displayName: "Pseudonym A", responsesSentToUsers: 5 }],
      count: 2, limit: 1, offset: 1,
    });
    const byUsername = buildOfficialUsageAgentDetailView(source, "usage-a", { staleAfterDays: 35, search: "BRIDGE-ONLY" })!;
    expect(byUsername.users.value).toEqual([{ username: "bridge-only", displayName: "bridge-only", responsesSentToUsers: 2 }]);
    const empty = buildOfficialUsageAgentDetailView(source, "usage-a", { staleAfterDays: 35, search: "absent" })!;
    expect(empty.users).toMatchObject({ value: [], count: 0 });
    expect(empty.summary).toEqual(result.summary);
    expect(byUsername.summary).toEqual(result.summary);
    expect(empty.agent.responsesSentToUsers).toBe(9);
  });

  it("breaks sorting ties by the exact username in either direction", () => {
    const source = published();
    source.reports.userAgents!.rows[0].responsesSentToUsers = 4;
    source.reports.users!.rows.forEach(row => { row.displayName = "Same label"; });
    for (const sortBy of ["responses", "displayName"] as const) {
      for (const sortDirection of ["asc", "desc"] as const) {
        const detail = buildOfficialUsageAgentDetailView(source, "usage-a", { staleAfterDays: 35, sortBy, sortDirection })!;
        expect(detail.users.value.map(user => user.username)).toEqual(["CaseSensitiveUser", "casesensitiveuser"]);
      }
    }
  });

  it("distinguishes missing active-user evidence, empty breakdowns and explicit zero-response rows", () => {
    const source = drilldownPublished();
    const zeroOnly = source.reports.userAgents!.rows.find(row => row.username === "zero-user")!;
    source.reports.userAgents!.rows = [zeroOnly];
    const zero = buildOfficialUsageAgentDetailView(source, "usage-a", { staleAfterDays: 35 })!;
    expect(zero.summary).toEqual({ reportedUsers: 1, responseProducingUsers: 0, zeroResponseUsers: 1, userBreakdownResponses: 0 });
    expect(zero.users.value).toEqual([{ username: "zero-user", displayName: "Zero User", responsesSentToUsers: 0 }]);
    expect(zero.agent.responseComparison.sourceValues).toEqual({ agents: 9, userAgents: 0 });
    expect(zero.agent).toMatchObject({
      activeUsersTotal: 0, activeUsersIdentityCount: 0, activeUsersTotalBasis: "userAgents_distinct_identity",
    });

    source.reports.userAgents!.rows = [];
    const empty = buildOfficialUsageAgentDetailView(source, "usage-a", { staleAfterDays: 35 })!;
    expect(empty.summary).toEqual({ reportedUsers: 0, responseProducingUsers: null, zeroResponseUsers: 0, userBreakdownResponses: 0 });
    expect(empty.users).toMatchObject({ value: [], count: 0 });
    expect(empty.agent).toMatchObject({
      activeUsersTotal: null, activeUsersIdentityCount: null, activeUsersTotalBasis: "unknown",
    });

    source.reports.userAgents = undefined;
    const missing = buildOfficialUsageAgentDetailView(source, "usage-a", { staleAfterDays: 35 })!;
    expect(missing.summary).toEqual({ reportedUsers: null, responseProducingUsers: null, zeroResponseUsers: null, userBreakdownResponses: null });
    expect(missing.users).toMatchObject({ value: [], count: 0 });
    expect(missing.missingKinds).toEqual(["userAgents"]);
    expect(missing.agent).toMatchObject({
      activeUsersTotal: null, activeUsersIdentityCount: null, activeUsersTotalBasis: "unknown",
      responseComparison: { status: "not_comparable", sourceValues: { agents: 9, userAgents: null } },
    });
  });

  it("keeps response-producing users unknown when companion rows only describe other agents", () => {
    const source = drilldownPublished();
    source.reports.userAgents!.rows = source.reports.userAgents!.rows.filter(row => row.agentId !== "usage-a");
    expect(source.reports.userAgents!.rows.length).toBeGreaterThan(0);

    const detail = buildOfficialUsageAgentDetailView(source, "usage-a", { staleAfterDays: 35 })!;
    expect(detail.summary).toEqual({
      reportedUsers: 0, responseProducingUsers: null, zeroResponseUsers: 0, userBreakdownResponses: 0,
    });
    expect(detail.agent.activeUsersIdentityCount).toBeNull();
    expect(detail.users).toMatchObject({ value: [], count: 0 });
    expect(detail.missingKinds).not.toContain("userAgents");
  });

  it("uses exact report IDs, never agent names or inferred inventory identities", () => {
    const source = drilldownPublished();
    const upper = buildOfficialUsageAgentDetailView(source, "usage-A", { staleAfterDays: 35 })!;
    expect(upper.agent).toMatchObject({
      agentId: "usage-A", agentName: "Agent A", sourceReport: "userAgents", sourceReports: ["userAgents"],
      activeUsersLicensed: null, activeUsersUnlicensed: null, activeUsersTotal: 1, identityStatus: "unresolved",
    });
    expect(upper.users.value).toEqual([{ username: "upper-only", displayName: "upper-only", responsesSentToUsers: 11 }]);
    for (const id of ["USAGE-A", "Agent A", "package-usage-a", " usage-a ", "unknown"]) {
      expect(buildOfficialUsageAgentDetailView(source, id, { staleAfterDays: 35 })).toBeUndefined();
    }
    expect(buildOfficialUsageAgentDetailView({ ...source, reports: {} }, "usage-a", { staleAfterDays: 35 })).toBeUndefined();
  });

  it("falls back to exact report usernames when the Users companion is absent", () => {
    const source = published();
    source.reports.users = undefined;
    const detail = buildOfficialUsageAgentDetailView(source, "usage-a", { staleAfterDays: 35 })!;
    expect(detail.missingKinds).toEqual(["users"]);
    expect(detail.users.value).toEqual([
      { username: "CaseSensitiveUser", displayName: "CaseSensitiveUser", responsesSentToUsers: 5 },
      { username: "casesensitiveuser", displayName: "casesensitiveuser", responsesSentToUsers: 4 },
    ]);
  });

  it("bounds user pages independently of whole-agent metrics", () => {
    const source = published();
    source.reports.userAgents!.rows = Array.from({ length: 550 }, (_, index) => ({
      agentId: "usage-a", agentName: "Agent A", creatorType: "Declarative", username: `user-${index}`, responsesSentToUsers: 1,
    }));
    const defaults = buildOfficialUsageAgentDetailView(source, "usage-a", { staleAfterDays: 35 })!;
    expect(defaults.users).toMatchObject({ count: 550, limit: 100, offset: 0 });
    expect(defaults.users.value).toHaveLength(100);
    const bounded = buildOfficialUsageAgentDetailView(source, "usage-a", { staleAfterDays: 35, limit: 100_000 })!;
    expect(bounded.users).toMatchObject({ count: 550, limit: 500, offset: 0 });
    expect(bounded.users.value).toHaveLength(500);
    expect(bounded.summary).toEqual({ reportedUsers: 550, responseProducingUsers: 550, zeroResponseUsers: 0, userBreakdownResponses: 550 });
    const beyond = buildOfficialUsageAgentDetailView(source, "usage-a", { staleAfterDays: 35, limit: 0, offset: 1_000_000 })!;
    expect(beyond.users).toEqual({ value: [], count: 550, limit: 1, offset: 100_000 });
    expect(beyond.summary).toEqual(bounded.summary);
  });
});

describe("official usage users agent filter", () => {
  it("selects exact bridge identities, including zero rows, while retaining each full Users total and all rows", () => {
    const source = drilldownPublished();
    const baseline = buildOfficialUsageUserView(source, { staleAfterDays: 35 });
    const filtered = buildOfficialUsageUserView(source, { staleAfterDays: 35, agentId: "usage-a" });

    expect(baseline.filters).not.toHaveProperty("agentId");
    expect(filtered.filters.agentId).toBe("usage-a");
    expect(filtered.users.count).toBe(4);
    expect(filtered.users.value.map(user => user.username)).toEqual(["CaseSensitiveUser", "casesensitiveuser", "zero-user", "bridge-only"]);
    for (const user of filtered.users.value) {
      expect(user).toEqual(baseline.users.value.find(candidate => candidate.username === user.username));
    }
    expect(filtered.users.value[0]).toMatchObject({
      reportedResponsesReceived: 9, bridgeResponsesSentToUsers: 11, reportedAgentsUsed: 2, agentsAccessedTotal: 3,
    });
    expect(filtered.users.value[0].rows.map(row => row.agentId)).toEqual(["usage-a", "usage-b", "usage-report-only"]);
    expect(filtered.counts).toEqual({ ...baseline.counts, filteredUsers: 4 });
    expect(filtered.cohorts).toEqual(baseline.cohorts);
    expect(filtered.topUsersByResponses[0]).toMatchObject({ username: "CaseSensitiveUser", responses: 9, responsesSource: "users" });
    expect(filtered.users.value.find(user => user.username === "zero-user")).toMatchObject({
      username: "zero-user", reportedResponsesReceived: 0, rows: [expect.objectContaining({ agentId: "usage-a", responsesSentToUsers: 0 })],
    });
  });

  it("applies the agent filter, search and sorting before counts and pagination", () => {
    const result = buildOfficialUsageUserView(drilldownPublished(), {
      staleAfterDays: 35, agentId: "usage-a", search: "PSEUDONYM", userSortBy: "responses", sortDirection: "asc", limit: 1, offset: 1,
    });

    expect(result.users).toMatchObject({
      value: [expect.objectContaining({ username: "CaseSensitiveUser", reportedResponsesReceived: 9 })],
      count: 2, limit: 1, offset: 1,
    });
    expect(result.counts).toMatchObject({ users: 6, filteredUsers: 2, totalResponsesReceived: 913 });
  });

  it("applies agent, creator and response filters to the same relationship without truncating user details", () => {
    const source = drilldownPublished();
    source.reports.userAgents!.rows.push({
      agentId: "usage-b", agentName: "Agent B", creatorType: "Custom", username: "zero-user", responsesSentToUsers: 20,
    });
    const responses = buildOfficialUsageUserView(source, {
      staleAfterDays: 35, agentId: "usage-a", responsesOnly: true,
    });
    expect(responses.users.value.map(user => user.username)).not.toContain("zero-user");
    expect(responses.users.value[0].rows).toHaveLength(3);
    const wrongCreator = buildOfficialUsageUserView(source, {
      staleAfterDays: 35, agentId: "usage-a", creatorType: "Custom",
    });
    expect(wrongCreator.users.count).toBe(0);
    expect(buildOfficialUsageUserView(source, {
      staleAfterDays: 35, creatorType: "Custom", responsesOnly: true,
    }).users.value.map(user => user.username)).toContain("zero-user");
  });

  it("keeps case-distinct report IDs separate and never infers missing access rows", () => {
    const source = drilldownPublished();
    const upper = buildOfficialUsageUserView(source, { staleAfterDays: 35, agentId: "usage-A" });
    expect(upper.users.value.map(user => user.username)).toEqual(["upper-only"]);
    for (const agentId of ["USAGE-A", "Agent A", "unknown"]) {
      expect(buildOfficialUsageUserView(source, { staleAfterDays: 35, agentId }).users).toMatchObject({ value: [], count: 0 });
    }
    source.reports.userAgents = undefined;
    const missing = buildOfficialUsageUserView(source, { staleAfterDays: 35, agentId: "usage-a" });
    expect(missing.users).toMatchObject({ value: [], count: 0 });
    expect(missing.counts).toMatchObject({ users: 4, filteredUsers: 0, totalResponsesReceived: 913 });
  });
});
