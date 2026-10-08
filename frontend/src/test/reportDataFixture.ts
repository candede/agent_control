import type { CombinedUser, ReportAgent, ReportHistorySet, ReportMetadata, ReportOverviewAgent, ReportPage, ReportSummary, ReportUser } from "../../../backend/src/types/officialReportData";
import type { UserSourceMetadata } from "../../../backend/src/types/userSources";
import type { PublishedSelectedRead } from "../../../backend/src/types/dataSelection";
export const reportSetId = "10000000-0000-4000-8000-000000000001";
export const selectionId = "20000000-0000-4000-8000-000000000002";
const capturedAt = Date.now();
const day = 86_400_000;
const reportingEnd = new Date(capturedAt - day).toISOString().slice(0, 10);
const reportingStart = new Date(Date.parse(reportingEnd) - 30 * day).toISOString().slice(0, 10);
const acceptedAt = new Date(capturedAt).toISOString();

function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

// One capture is reused, never renewed by a retry. Explicit captures model other owners.
export function reportSelection(index = 2, evaluatedAt = capturedAt): PublishedSelectedRead {
  if (!Number.isSafeInteger(index) || index < 1 || index > 999999999999) throw new Error("Invalid report fixture selection index.");
  return {
    id: `20000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    revision: `70000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    evaluatedAt: new Date(evaluatedAt).toISOString(), expiresAt: new Date(evaluatedAt + 600_000).toISOString(),
    validatedAt: new Date(evaluatedAt).toISOString(),
    publicationRevisions: { graph_packages: "1".repeat(64), power_platform: "2".repeat(64), users: "3".repeat(64) },
  };
}
const selection = freeze(reportSelection());
export const reports: ReportMetadata = freeze({
  setId: reportSetId, activeSetId: reportSetId, activeRevision: "4", historyRevision: "35", historyEpoch: "2",
  availability: "active", staleAfterDays: 7, periodAgeDays: 0, acceptedAgeDays: 0,
  reportingPeriod: { startDate: reportingStart, endDate: reportingEnd, days: 31, provenance: "operator_asserted" },
  acceptedAt, expiresAt: new Date(capturedAt + 30 * day).toISOString(),
  lineages: (["users", "agents", "userAgents"] as const).map((kind, index) => ({ kind, versionId: `30000000-0000-4000-8000-00000000000${index}`,
    contentHash: String(index).repeat(64), rowCount: 100000, sourceAsOf: `${reportingEnd}T00:00:00.000Z`, sourceAsOfProvenance: "source_metadata",
    sourceFreshness: "known", periodProvenance: "operator_asserted" })),
});
const summary: ReportSummary = {
  checkedUsers: 100000, licensedUsers: 50000, measuredActivityUsers: 40000, needsAttentionUsers: 20000, usingAgentsUsers: 30000,
  noAgentActivityUsers: 10000, unknownMetricsUsers: 10000, unresolvedIdentities: 25000, activeWithoutPaidUsers: 1000,
  paidActiveReportUsers: 40000, unknownLicenseActiveReportUsers: 50, reportedResponses: 1000000, bridgeResponses: 999999,
  userReportedResponses: 1000001, distinctActiveReportUsers: 41050, licensedOccurrences: 100000, unlicensedOccurrences: 120000,
  responseReconciliation: "mismatch", activeUsersAreNonAdditive: true,
};
export function source(kind: "directory" | "app_activity"): UserSourceMetadata {
  return { source: kind, generationId: `40000000-0000-4000-8000-00000000000${kind === "directory" ? 1 : 2}`,
    scopeId: `80000000-0000-4000-8000-00000000000${kind === "directory" ? 1 : 2}`,
    revision: "2", expiresAt: new Date(capturedAt + 1_800_000).toISOString(), observedAt: acceptedAt, attemptedAt: acceptedAt,
    attemptStatus: "available", attemptObservedCount: 100000, errorCode: null, message: null, rowCount: 100000, state: "available",
    reportRefreshDate: kind === "app_activity" ? acceptedAt.slice(0, 10) : null, period: kind === "app_activity" ? "D30" : null, reportVersion: kind === "app_activity" ? "v1" : null };
}
export function reportPage<T>(value: T[], overrides: Partial<ReportPage<T>> = {}): ReportPage<T> {
  const counts = overrides.counts ?? { total: (overrides.value ?? value).length, filtered: (overrides.value ?? value).length };
  // JSON responses cannot share references with a caller's next response or with templates.
  return structuredClone({ value, page: { limit: 50, nextCursor: null, previousCursor: null },
    selection, counts, reports, sources: { directory: source("directory"), app_activity: source("app_activity") }, filters: {},
    summary, analytics: { basis: "filtered_rows", rowCount: counts.filtered, responses: null, zeroResponses: null, unknownResponses: null,
      review: null, agents: null, history: null, overview: null }, ...overrides });
}
export function combinedUser(index = 1): CombinedUser {
  return { directory: { objectId: `50000000-0000-4000-8000-${String(index).padStart(12, "0")}`, displayName: `User ${index}`,
    userPrincipalName: `user${index}@example.invalid`, companyName: "Contoso", department: "Engineering", accountEnabled: true, userType: "Member", employeeType: "Employee" },
    copilotServiceState: "enabled", servicePlanCount: 800, entitlement: "paid_active", appActivity: null, activityState: "unknown",
    reportedUsername: `user${index}@example.invalid`, reportedResponses: 12, reportedAgentsUsed: 3, bridgeResponses: 13, relationshipCount: 20000,
    agentActivityState: "active", reportMatch: "matched", userLastActivityDateUtc: `${reportingEnd}T00:00:00.000Z`, attention: [] };
}
export function reportUser(index = 1, overrides: Partial<ReportUser> = {}): ReportUser {
  return { username: `user${index}@example.invalid`, displayName: `User ${index}`, objectId: combinedUser(index).directory.objectId,
    company: "Contoso", department: "Engineering", entitlement: "no_paid", reportedResponses: 12, reportedAgentsUsed: 3,
    bridgeResponses: 13, relationshipCount: 20000, responseProducingAgentCount: 3, userLastActivityDateUtc: `${reportingEnd}T00:00:00.000Z`,
    lastActivityDateUtc: `${reportingEnd}T00:00:00.000Z`, missingUserReport: false, hasReportMismatch: true, reviewCohort: "outside", hasActivity: true, ...overrides };
}
export function reportAgent(index = 1, overrides: Partial<ReportAgent> = {}): ReportAgent {
  return { agentId: `agent-${index}`, agentName: `Agent ${index}`, creatorType: "Your org", responses: 100, responseSource: "agents",
    activeUsers: 10, activeUsersBasis: "userAgents_distinct_identity", licensedUserOccurrences: 4, unlicensedUserOccurrences: 7,
    lastActivityDateUtc: `${reportingEnd}T00:00:00.000Z`, reportResponses: 100, bridgeResponses: 100, relationshipCount: 20000,
    responseComparison: "matching", identityStatus: "unresolved", ...overrides };
}
export function historySet(index = 1, overrides: Partial<ReportHistorySet> = {}): ReportHistorySet {
  return { id: `10000000-0000-4000-8000-${String(index).padStart(12, "0")}`, bundleId: `60000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    contentHash: index.toString(16).padStart(64, "0"), reportingStart, reportingEnd, periodProvenance: "operator_asserted",
    supersedesSetId: null, acceptedAt, visibility: "retained", active: index === 1, ...overrides };
}
export function overviewAgent(index = 1, overrides: Partial<ReportOverviewAgent> = {}): ReportOverviewAgent {
  return { agentId: `agent-${index}`, agentName: `Agent ${index}`, observationCount: 32, hasResponses: true,
    earliestActivityDateUtc: reportingStart, lastActivityDateUtc: reportingEnd, active30Days: true, creatorTypeCount: 2,
    latestSetId: reportSetId, latestAcceptedAt: acceptedAt, ...overrides };
}
export function overviewPage(overrides: Partial<ReportPage<ReportOverviewAgent>> = {}): ReportPage<ReportOverviewAgent> {
  const result = reportPage([overviewAgent(1, { agentName: "Researcher" })], { counts: { total: 100000, filtered: 100000 },
    page: { limit: 50, nextCursor: "overview-next", previousCursor: null } });
  return reportPage(result.value, { ...result, analytics: { ...result.analytics, overview: { retainedSets: 32, reportedAgents: 100000, usedAgents: 50000,
    active30Days: 30000, undatedAgents: 10000, earliestActivityDateUtc: reportingStart, latestActivityDateUtc: reportingEnd,
    asOf: acceptedAt.slice(0, 10), activeSinceDateUtc: new Date(capturedAt - 29 * day).toISOString().slice(0, 10) } }, ...overrides });
}
