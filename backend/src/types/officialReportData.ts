import type { OfficialUsageAvailability, OfficialUsageReportKind, OfficialUsageReportBase } from "./officialReportRecords.js";
import type { UserSourceFacts, UserSourceFilter, UserSourceMetadata, UserSourcePage, UserSourcePlan } from "./userSources.js";

export type ReportEndpoint = "copilot_users" | "official_agents" | "official_users" | "relationships" | "history" | "overview" | "unresolved" | "plans" | "observations";
export type ReportQuery = {
  setId?: string; scope?: "history" | "selected"; search?: string;
  company?: string | null; department?: string | null;
  entitlement?: UserSourceFilter["entitlement"]; serviceState?: UserSourceFilter["serviceState"];
  appActivity?: "active" | "inactive" | "unknown";
  reportActivity?: "all" | "recent" | "inactive" | "no-activity";
  cohort?: "all" | "zero" | "low" | "review" | "licensed" | "using_agents" | "no_agent_activity" | "needs_attention" | "unknown_metrics";
  licenseCohort?: "active_without_paid"; creatorType?: string; agentId?: string; username?: string;
  responsesOnly?: boolean; startDate?: string; endDate?: string;
  lowResponseThreshold?: number; inactiveDays?: number; activityWindowDays?: number;
  sort?: "name" | "upn" | "company" | "department" | "service" | "appActivity" | "responses" | "agentsUsed" | "lastActivity" | "creatorType" | "activeUsers" | "licensedUsers" | "unlicensedUsers" | "acceptedAt";
  order?: "asc" | "desc";
};
export type ReportMetadata = {
  setId: string | null; activeSetId: string | null; activeRevision: string; historyRevision: string; historyEpoch: string;
  availability: OfficialUsageAvailability; staleAfterDays: number; periodAgeDays: number | null; acceptedAgeDays: number | null;
  reportingPeriod: OfficialUsageReportBase["reportingPeriod"] | null;
  acceptedAt: string | null; expiresAt: string | null;
  lineages: Array<{ kind: OfficialUsageReportKind; versionId: string; contentHash: string; rowCount: number;
    sourceAsOf: string | null; sourceAsOfProvenance: string; sourceFreshness: "known" | "unknown"; periodProvenance: string }>;
};
export type CombinedUser = UserSourceFacts & {
  reportedUsername: string | null; reportedResponses: number | null; reportedAgentsUsed: number | null;
  userLastActivityDateUtc: string | null;
  bridgeResponses: number | null; relationshipCount: number; agentActivityState: "active" | "none" | "unknown";
  reportMatch: "matched" | "missing"; attention: string[];
};
export type ReportUser = {
  username: string; displayName: string; objectId: string | null; company: string | null; department: string | null;
  entitlement: UserSourceFilter["entitlement"] | null; reportedResponses: number | null; reportedAgentsUsed: number | null;
  bridgeResponses: number | null; relationshipCount: number; responseProducingAgentCount: number;
  userLastActivityDateUtc: string | null; lastActivityDateUtc: string | null;
  missingUserReport: boolean; hasReportMismatch: boolean; reviewCohort: "unknown" | "zero" | "low" | "outside"; hasActivity: boolean;
};
export type ReportAgent = {
  agentId: string; agentName: string; creatorType: string; responses: number; responseSource: "agents" | "userAgents";
  activeUsers: number | null; activeUsersBasis: "userAgents_distinct_identity" | "unknown";
  licensedUserOccurrences: number | null; unlicensedUserOccurrences: number | null; lastActivityDateUtc: string | null;
  reportResponses: number | null; bridgeResponses: number | null; relationshipCount: number;
  responseComparison: "matching" | "mismatch" | "not_comparable"; identityStatus: "unresolved";
};
export type ReportRelationship = { id: string; agentId: string; agentName: string; creatorType: string; username: string;
  responses: number; lastActivityDateUtc: string | null; identityStatus: "unresolved" };
export type ReportHistorySet = { id: string; bundleId: string; contentHash: string; reportingStart: string | null; reportingEnd: string | null;
  periodProvenance: string; supersedesSetId: string | null; acceptedAt: string; visibility: "retained" | "superseded"; active: boolean };
export type ReportOverviewAgent = { agentId: string; agentName: string; observationCount: number; hasResponses: boolean;
  earliestActivityDateUtc: string | null; lastActivityDateUtc: string | null; active30Days: boolean; creatorTypeCount: number;
  latestSetId: string; latestAcceptedAt: string };
export type ReportObservation = { versionId: string; kind: OfficialUsageReportKind; contentHash: string; rowCount: number;
  acceptedAt: string; sourceAsOf: string | null; sourceAsOfProvenance: string; sourceFreshness: string; supersedesVersionId: string | null };
export type UnresolvedReportIdentity = { username: string; reason: "not_found" | "ambiguous"; responses: number | null; hasActivity: boolean };
export type ReportRow = CombinedUser | ReportUser | ReportAgent | ReportRelationship | ReportHistorySet | ReportOverviewAgent | UnresolvedReportIdentity | UserSourcePlan | ReportObservation;
export type ReportAnalytics = {
  basis: "filtered_rows";
  rowCount: number; responses: number | null; zeroResponses: number | null; unknownResponses: number | null;
  review: { zero: number; low: number; unknown: number } | null;
  agents: { inactive: number; neverUsed: number; anchorDateUtc: string | null; windowDays: number; windowAgents: number; windowResponses: number | null;
    windowDistinctActiveUsers: number; mostResponses: Array<{ agentId: string; name: string; responses: number }>;
    leastResponses: Array<{ agentId: string; name: string; responses: number }> } | null;
  history: { imports: number; uniqueObservations: number; observationRows: number; uniquePayloads: number; repeatedRowsReused: number;
    earliestAcceptedAt: string | null; latestAcceptedAt: string | null; earliestActivityDateUtc: string | null; latestActivityDateUtc: string | null;
    earliestReportingStart: string | null; latestReportingEnd: string | null; knownWindows: number; unknownWindows: number;
    overlappingKnownWindows: number; additive: false; activityRangeProvesCoverage: false } | null;
  overview: { retainedSets: number; reportedAgents: number; usedAgents: number; active30Days: number; undatedAgents: number;
    earliestActivityDateUtc: string | null; latestActivityDateUtc: string | null; asOf: string; activeSinceDateUtc: string } | null;
};
export type ReportSummary = {
  checkedUsers: number | null; licensedUsers: number | null; measuredActivityUsers: number | null; needsAttentionUsers: number | null;
  usingAgentsUsers: number | null; noAgentActivityUsers: number | null;
  unknownMetricsUsers: number | null; unresolvedIdentities: number;
  activeWithoutPaidUsers: number | null; paidActiveReportUsers: number | null; unknownLicenseActiveReportUsers: number;
  reportedResponses: number | null; bridgeResponses: number | null; userReportedResponses: number | null;
  distinctActiveReportUsers: number | null; licensedOccurrences: number | null; unlicensedOccurrences: number | null;
  responseReconciliation: "matching" | "mismatch" | "not_comparable"; activeUsersAreNonAdditive: true;
};
export type ReportListPage<T> = UserSourcePage<T> & { reports: ReportMetadata };
export type ReportPage<T> = ReportListPage<T> & {
  sources: { directory: UserSourceMetadata; app_activity: UserSourceMetadata };
  summary: ReportSummary; analytics: ReportAnalytics; filters: ReportQuery;
};
export const reportExportColumns = {
  copilot_users: ["ObjectId", "UserPrincipalName", "DisplayName", "Company", "Department", "PaidFeatureState", "Entitlement", "AgentActivityState",
    "ReportedResponses", "ReportedAgentsUsed", "AppLastActivityDate", "ReportSetId", "HistoryRevision", "DirectoryObservedAt", "ReportAvailability"],
  official_agents: ["agentId", "agentName", "creatorType", "creatorTypeSource", "activeUsersLicensed", "activeUsersUnlicensed", "activeUsersTotal",
    "activeUsersTotalBasis", "activeUsersIdentityCount", "responsesSentToUsers", "responseComparisonStatus", "responseDifference", "responsesAgentsReport",
    "responsesUsersAndAgentsReport", "lastActivityDateUtc", "sourceReports", "identityStatus", "reportSetId", "reportingStart", "reportingEnd",
    "agentsVersionId", "agentsPeriodProvenance", "agentsSourceFreshness", "userAgentsVersionId", "userAgentsPeriodProvenance", "userAgentsSourceFreshness", "historyRevision"],
  official_users: ["username", "displayName", "licenseAssignmentStatus", "reviewCohort", "reviewCandidate", "userMetricSource", "reportedAgentsUsed",
    "reportedResponsesReceived", "agentsAccessedTotal", "responseProducingAgentCount", "bridgeResponsesSentToUsers", "missingUserReport", "missingBridgeRows",
    "hasReportMismatch", "userLastActivityDateUtc", "agentId", "agentName", "creatorType", "creatorTypeSource", "responsesSentToUsers",
    "agentLastUsedByAnyoneDateUtc", "reportSetId", "reportingStart", "reportingEnd", "usersVersionId", "usersPeriodProvenance", "usersSourceFreshness",
    "userAgentsVersionId", "userAgentsPeriodProvenance", "userAgentsSourceFreshness", "identityStatus", "historyRevision", "entitlement"],
} as const;
