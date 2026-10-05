import type { CombinedUser, ReportAgent, ReportHistorySet, ReportMetadata, ReportOverviewAgent, ReportPage, ReportSummary, ReportUser } from "../../../backend/src/types/officialReportData";
import type { UserSourceMetadata } from "../../../backend/src/types/userSources";
export const reportSetId = "10000000-0000-4000-8000-000000000001";
export const selectionId = "20000000-0000-4000-8000-000000000002";
export const reports: ReportMetadata = {
  setId: reportSetId, activeSetId: reportSetId, activeRevision: "4", historyRevision: "35", historyEpoch: "2",
  availability: "active", staleAfterDays: 7, periodAgeDays: 0, acceptedAgeDays: 0,
  reportingPeriod: { startDate: "2026-01-01", endDate: "2026-01-31", days: 31, provenance: "operator_asserted" },
  acceptedAt: "2026-02-01T00:00:00.000Z", expiresAt: "2030-01-01T00:00:00.000Z",
  lineages: (["users", "agents", "userAgents"] as const).map((kind, index) => ({ kind, versionId: `30000000-0000-4000-8000-00000000000${index}`,
    contentHash: String(index).repeat(64), rowCount: 100000, sourceAsOf: "2026-01-31T00:00:00.000Z", sourceAsOfProvenance: "source_metadata",
    sourceFreshness: "known", periodProvenance: "operator_asserted" })),
};
const summary: ReportSummary = {
  checkedUsers: 100000, licensedUsers: 50000, measuredActivityUsers: 40000, needsAttentionUsers: 20000, usingAgentsUsers: 30000,
  noAgentActivityUsers: 10000, unknownMetricsUsers: 10000, unresolvedIdentities: 25000, activeWithoutPaidUsers: 1000,
  paidActiveReportUsers: 40000, unknownLicenseActiveReportUsers: 50, reportedResponses: 1000000, bridgeResponses: 999999,
  userReportedResponses: 1000001, distinctActiveReportUsers: 80000, licensedOccurrences: 100000, unlicensedOccurrences: 120000,
  responseReconciliation: "mismatch", activeUsersAreNonAdditive: true,
};
export function source(kind: "directory" | "app_activity"): UserSourceMetadata {
  return { source: kind, generationId: `40000000-0000-4000-8000-00000000000${kind === "directory" ? 1 : 2}`, scopeId: selectionId,
    revision: "2", expiresAt: "2030-01-01T00:00:00.000Z", observedAt: "2026-02-01T00:00:00.000Z", attemptedAt: "2026-02-01T00:00:00.000Z",
    attemptStatus: "available", attemptObservedCount: 100000, errorCode: null, message: null, rowCount: 100000, state: "available",
    reportRefreshDate: kind === "app_activity" ? "2026-02-01" : null, period: kind === "app_activity" ? "D30" : null, reportVersion: kind === "app_activity" ? "v1" : null };
}
export function reportPage<T>(value: T[], overrides: Partial<ReportPage<T>> = {}): ReportPage<T> {
  return { value, page: { limit: 50, nextCursor: null, previousCursor: null },
    selection: { id: selectionId, revision: "5", expiresAt: "2030-01-01T00:00:00.000Z", evaluatedAt: "2026-02-01T00:00:00.000Z" },
    counts: { total: 100000, filtered: 50000 }, reports, sources: { directory: source("directory"), app_activity: source("app_activity") }, filters: {},
    summary, analytics: { basis: "filtered_rows", rowCount: 50000, responses: 1000000, zeroResponses: 100, unknownResponses: 500,
      review: { zero: 100, low: 500, unknown: 500 }, agents: null, history: null, overview: null }, ...overrides };
}
export function combinedUser(index = 1): CombinedUser {
  return { directory: { objectId: `50000000-0000-4000-8000-${String(index).padStart(12, "0")}`, displayName: `User ${index}`,
    userPrincipalName: `user${index}@example.invalid`, companyName: "Contoso", department: "Engineering", accountEnabled: true, userType: "Member", employeeType: "Employee" },
    copilotServiceState: "enabled", servicePlanCount: 800, entitlement: "paid_active", appActivity: null, activityState: "unknown",
    reportedUsername: `user${index}@example.invalid`, reportedResponses: 12, reportedAgentsUsed: 3, bridgeResponses: 13, relationshipCount: 20000,
    agentActivityState: "active", reportMatch: "matched", userLastActivityDateUtc: "2026-01-28T00:00:00.000Z", attention: [] };
}
export function reportUser(index = 1, overrides: Partial<ReportUser> = {}): ReportUser {
  return { username: `user${index}@example.invalid`, displayName: `User ${index}`, objectId: combinedUser(index).directory.objectId,
    company: "Contoso", department: "Engineering", entitlement: "no_paid", reportedResponses: 12, reportedAgentsUsed: 3,
    bridgeResponses: 13, relationshipCount: 20000, responseProducingAgentCount: 10000, userLastActivityDateUtc: "2026-01-28T00:00:00.000Z",
    lastActivityDateUtc: "2026-01-31T00:00:00.000Z", missingUserReport: false, hasReportMismatch: true, reviewCohort: "outside", hasActivity: true, ...overrides };
}
export function reportAgent(index = 1, overrides: Partial<ReportAgent> = {}): ReportAgent {
  return { agentId: `agent-${index}`, agentName: `Agent ${index}`, creatorType: "Your org", responses: 100, responseSource: "agents",
    activeUsers: 10, activeUsersBasis: "userAgents_distinct_identity", licensedUserOccurrences: 4, unlicensedUserOccurrences: 7,
    lastActivityDateUtc: "2026-01-31T00:00:00.000Z", reportResponses: 100, bridgeResponses: 100, relationshipCount: 20000,
    responseComparison: "matching", identityStatus: "unresolved", ...overrides };
}
export function historySet(index = 1, overrides: Partial<ReportHistorySet> = {}): ReportHistorySet {
  return { id: `10000000-0000-4000-8000-${String(index).padStart(12, "0")}`, bundleId: `60000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    contentHash: "a".repeat(64), reportingStart: "2026-01-01", reportingEnd: "2026-01-31", periodProvenance: "operator_asserted",
    supersedesSetId: null, acceptedAt: "2026-02-01T00:00:00.000Z", visibility: "retained", active: index === 1, ...overrides };
}
export function overviewAgent(index = 1, overrides: Partial<ReportOverviewAgent> = {}): ReportOverviewAgent {
  return { agentId: `agent-${index}`, agentName: `Agent ${index}`, observationCount: 32, hasResponses: true,
    earliestActivityDateUtc: "2026-01-01", lastActivityDateUtc: "2026-01-31", active30Days: true, creatorTypeCount: 1000,
    latestSetId: reportSetId, latestAcceptedAt: "2026-02-01T00:00:00.000Z", ...overrides };
}
export function overviewPage(overrides: Partial<ReportPage<ReportOverviewAgent>> = {}): ReportPage<ReportOverviewAgent> {
  const result = reportPage([overviewAgent(1, { agentName: "Researcher" })]);
  return { ...result, analytics: { ...result.analytics, overview: { retainedSets: 32, reportedAgents: 100000, usedAgents: 50000,
    active30Days: 30000, undatedAgents: 10000, earliestActivityDateUtc: "2026-01-01", latestActivityDateUtc: "2026-01-31",
    asOf: "2026-02-01", activeSinceDateUtc: "2026-01-02" } }, ...overrides };
}
