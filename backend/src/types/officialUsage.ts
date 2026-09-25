export type OfficialUsageReportKind = "agents" | "userAgents" | "users";

export type OfficialUsagePeriodProvenance = "source_metadata" | "operator_asserted" | "activity_range";

export type OfficialUsageMetadata = {
  reportingPeriod?: {
    startDate: string;
    endDate: string;
    provenance: Exclude<OfficialUsagePeriodProvenance, "activity_range">;
  };
  sourceAsOf?: {
    value: string;
    provenance: "source_metadata" | "operator_asserted";
  };
  downloadedAt?: string;
};

export type OfficialUsageReportBase = {
  kind: OfficialUsageReportKind;
  parserVersion: string;
  schemaVersion: string;
  reportingPeriod: {
    startDate: string | null;
    endDate: string | null;
    days: number | null;
    provenance: OfficialUsagePeriodProvenance;
  };
  sourceAsOf?: string;
  sourceAsOfProvenance: "source_metadata" | "operator_asserted" | "absent";
  sourceFreshness: "known" | "unknown";
  downloadedAt?: string;
  warnings: string[];
};

export type AgentUsageRow = {
  agentId: string;
  agentName: string;
  creatorType: string;
  activeUsersLicensed: number;
  activeUsersUnlicensed: number;
  responsesSentToUsers: number;
  lastActivityDateUtc?: string;
};

export type UserAgentUsageRow = {
  agentId: string;
  agentName: string;
  creatorType: string;
  username: string;
  responsesSentToUsers: number;
  lastActivityDateUtc?: string;
};

export type UserUsageRow = {
  username: string;
  displayName: string;
  numberOfAgentsUsed: number;
  agentResponsesReceived: number;
  lastActivityDateUtc?: string;
};

export type ParsedOfficialUsageReport =
  | (OfficialUsageReportBase & { kind: "agents"; rows: AgentUsageRow[] })
  | (OfficialUsageReportBase & {
      kind: "userAgents";
      rows: UserAgentUsageRow[];
    })
  | (OfficialUsageReportBase & { kind: "users"; rows: UserUsageRow[] });

export type OfficialUsageLineage = {
  kind: OfficialUsageReportKind;
  versionId: string;
  contentHash?: string;
  fileHash: string;
  parserVersion: string;
  schemaVersion: string;
  reportingPeriod: OfficialUsageReportBase["reportingPeriod"];
  sourceAsOf?: string;
  sourceAsOfProvenance: OfficialUsageReportBase["sourceAsOfProvenance"];
  sourceFreshness: OfficialUsageReportBase["sourceFreshness"];
  downloadedAt?: string;
  acceptedAt: string;
  rowCount: number;
  warnings: string[];
  reconciliation: Record<string, unknown>;
  supersedesVersionId: string | null;
};

type AcceptedReport<T extends ParsedOfficialUsageReport> = T & {
  lineage: OfficialUsageLineage;
};

export type AcceptedOfficialUsageReports = {
  agents?: AcceptedReport<Extract<ParsedOfficialUsageReport, { kind: "agents" }>>;
  userAgents?: AcceptedReport<Extract<ParsedOfficialUsageReport, { kind: "userAgents" }>>;
  users?: AcceptedReport<Extract<ParsedOfficialUsageReport, { kind: "users" }>>;
};

export type OfficialUsageSetSummary = {
  id: string;
  bundleId: string;
  contentHash?: string;
  reportingPeriod: {
    startDate: string | null;
    endDate: string | null;
    provenance: OfficialUsagePeriodProvenance;
  };
  supersedesSetId: string | null;
  complete: boolean;
  kinds: OfficialUsageReportKind[];
  acceptedAt: string | null;
  deletedAt: string | null;
  createdAt: string;
  expiresAt: string | null;
};

export type PublishedOfficialUsage = {
  activeRevision: number;
  activeSet: OfficialUsageSetSummary | null;
  reports: AcceptedOfficialUsageReports;
  retainedCompleteSets: number;
  retainedIncompleteSets: number;
  hasImportHistory: boolean;
  activeSelectionIncomplete: boolean;
};

export type OfficialUsageAvailability =
  | "never_imported"
  | "incomplete"
  | "not_selected"
  | "deleted"
  | "active"
  | "stale";

export type OfficialUsageValue = { name: string; value: number };
export type OfficialUsageTopAgent = {
  id: string;
  name: string;
  publisher?: string;
  status: "Report only";
  responses: number;
  activeUsers: number | null;
  activeUsersBasis: "users_and_agents_distinct_identity" | "unknown";
  lastActivityDateUtc?: string;
  creatorType: string;
  identityStatus: "unresolved";
};
export type OfficialUsageTopUser = {
  username: string;
  displayName: string;
  responses: number;
  agentsUsed: number;
  responsesSource: "users" | "userAgents";
  agentsUsedSource: "users" | "userAgents";
  userLastActivityDateUtc?: string;
};

export type OfficialUsageDateFilter = {
  startDate?: string;
  endDate?: string;
};

export type OfficialUsageAgentSort =
  | "agentName"
  | "responses"
  | "activeUsers"
  | "licensedUsers"
  | "unlicensedUsers"
  | "lastActivity";

export type OfficialUsageUserSort =
  | "displayName"
  | "responses"
  | "agentsUsed"
  | "lastActivity";

export type OfficialUsageSourceComparison = {
  sourceValues: Record<string, number | null>;
  status: "matching" | "mismatch" | "not_comparable";
  difference: number | null;
};

export type OfficialUsageReportingSummary = {
  catalog: {
    totalAgents: number;
    allowedAgents: number;
    blockedAgents: number;
    inactiveAgents: number;
    noImportedUsageAgents: number;
    statusDistribution: OfficialUsageValue[];
    availabilityDistribution: OfficialUsageValue[];
    hostDistribution: OfficialUsageValue[];
    publisherDistribution: OfficialUsageValue[];
    platformDistribution: OfficialUsageValue[];
    typeDistribution: OfficialUsageValue[];
  };
  usage: {
    hasAgentUsage: boolean;
    totalResponses: number | null;
    totalResponsesBasis: "agents_report" | "unknown";
    totalResponsesCoverage: "agents_report_only";
    totalActiveUsers: number | null;
    totalActiveUsersBasis: "users_and_users_agents_distinct_identity" | "unknown";
    responseReconciliation: OfficialUsageSourceComparison;
    activeUserReconciliation: OfficialUsageSourceComparison;
    creatorTypeDistribution: OfficialUsageValue[];
    topAgentsByResponses: OfficialUsageTopAgent[];
    topAgentsByActiveUsers: OfficialUsageTopAgent[];
    lastActivityRange?: { earliest: string; latest: string };
    activeUsersAreNonAdditive: true;
    reportedLicensedActiveUserOccurrences: number | null;
    reportedUnlicensedActiveUserOccurrences: number | null;
    activeUserOccurrenceNotice: string;
  };
  activityWindow: {
    anchorDateUtc?: string;
    activeAgents: number;
    totalAgents: number;
    activeUsers: number | null;
    totalActiveUsers: number | null;
    responses: number | null;
    totalResponses: number | null;
    responseBasis: "agents_report" | "unknown";
    agentDistribution: OfficialUsageValue[];
    activeUserDistribution: OfficialUsageValue[];
    creatorTypeDistribution: OfficialUsageValue[];
    topAgentsByResponses: OfficialUsageTopAgent[];
  };
};

export type OfficialUsageAgent = Omit<AgentUsageRow, "activeUsersLicensed" | "activeUsersUnlicensed"> & {
  activeUsersLicensed: number | null;
  activeUsersUnlicensed: number | null;
  activeUsersTotal: number | null;
  sourceReport: "agents" | "userAgents";
  sourceReports: Array<"agents" | "userAgents">;
  activeUsersIdentityCount: number | null;
  activeUsersTotalBasis: "userAgents_distinct_identity" | "unknown";
  responseComparison: OfficialUsageSourceComparison;
  creatorTypeSource: "agents_report" | "users_and_agents_report";
  identityStatus: "unresolved";
};

export type OfficialUsageAggregateView = {
  authority: "Microsoft 365 admin center Copilot Agents usage exports";
  availability: OfficialUsageAvailability;
  staleAfterDays: number;
  periodAgeDays: number | null;
  acceptedAgeDays: number | null;
  activeSet: OfficialUsageSetSummary | null;
  lineages: OfficialUsageLineage[];
  missingKinds: OfficialUsageReportKind[];
  filters: {
    search?: string;
    creatorType?: string;
    startDate?: string;
    endDate?: string;
    sortBy: OfficialUsageAgentSort;
    sortDirection: "asc" | "desc";
    creatorTypes: string[];
  };
  rankings: {
    mostResponses: OfficialUsageTopAgent[];
    leastResponses: OfficialUsageTopAgent[];
    zeroResponseAgents: number;
  };
  summary: OfficialUsageReportingSummary;
  agents: { value: OfficialUsageAgent[]; count: number; limit: number; offset: number };
};

export type OfficialUsageAgentUser = {
  username: string;
  displayName: string;
  responsesSentToUsers: number;
};

export type OfficialUsageAgentDetailView = Pick<OfficialUsageAggregateView,
  | "authority"
  | "availability"
  | "staleAfterDays"
  | "periodAgeDays"
  | "acceptedAgeDays"
  | "activeSet"
  | "lineages"
  | "missingKinds"
> & {
  agent: OfficialUsageAgent;
  summary: {
    reportedUsers: number | null;
    responseProducingUsers: number | null;
    zeroResponseUsers: number | null;
    userBreakdownResponses: number | null;
  };
  filters: {
    search?: string;
    sortBy: "responses" | "displayName";
    sortDirection: "asc" | "desc";
  };
  users: { value: OfficialUsageAgentUser[]; count: number; limit: number; offset: number };
};

export type OfficialUsageUserAgentRow = UserAgentUsageRow & {
  displayAgentName: string;
  packageStatus: "report-only";
  hasResponses: boolean;
  identityStatus: "unresolved";
  creatorTypeSource: "users_and_agents_report";
};

export type OfficialUsageUserSummary = {
  username: string;
  displayName: string;
  reportedAgentsUsed: number;
  reportedResponsesReceived: number;
  userLastActivityDateUtc?: string;
  agentsAccessedTotal: number;
  responseProducingAgentCount: number;
  bridgeResponsesSentToUsers: number;
  missingUserReport: boolean;
  hasReportMismatch: boolean;
  reviewCohort: "zero_responses" | "low_responses" | "outside_threshold" | "unknown";
  reviewCandidate: boolean;
  licenseAssignmentStatus: "unavailable" | "no_active_paid_license";
  creatorTypes: string[];
  rows: OfficialUsageUserAgentRow[];
  searchableText: string;
  datasetScope: {
    reportSetId: string | null;
    usersVersionId: string | null;
    userAgentsVersionId: string | null;
  };
};

export type OfficialUsageUserView = {
  authority: "Microsoft 365 admin center Copilot Agents usage exports";
  availability: OfficialUsageAvailability;
  staleAfterDays: number;
  periodAgeDays: number | null;
  acceptedAgeDays: number | null;
  activeSet: OfficialUsageSetSummary | null;
  lineages: OfficialUsageLineage[];
  licenseCoverage?: {
    state: "available" | "unavailable";
    observedAt: string | null;
    activeReportUsers: number;
    paidUsers: number;
    unpaidUsers: number;
    unknownUsers: number;
    message: string | null;
  };
  filters: {
    creatorTypes: string[];
    search?: string;
    agentId?: string;
    creatorType?: string;
    activity: "all" | "recent" | "inactive" | "no-activity";
    responsesOnly: boolean;
    startDate?: string;
    endDate?: string;
    lowResponseThreshold: number;
    cohort: "all" | "zero" | "low" | "review";
    licenseCohort?: "active_without_paid";
    sortBy: OfficialUsageUserSort;
    sortDirection: "asc" | "desc";
  };
  counts: {
    users: number;
    filteredUsers: number;
    userRows: number;
    accessRows: number;
    reportOnlyRows: number;
    totalResponsesReceived: number | null;
    mismatchCount: number;
  };
  cohorts: {
    zeroResponses: number;
    lowResponses: number;
    reviewCandidates: number;
    unknownUserMetrics: number;
    missingBridgeRows: number;
    threshold: number;
  };
  recencyAnchorDateUtc?: string;
  decisionNotice: string;
  topUsersByResponses: OfficialUsageTopUser[];
  leastUsersByResponses: OfficialUsageTopUser[];
  users: { value: OfficialUsageUserSummary[]; count: number; limit: number; offset: number };
};

export type OfficialUsageHistoryObservationSummary = {
  versionId: string;
  kind: OfficialUsageReportKind;
  contentHash: string;
  rowCount: number;
  uniquePayloadCount: number;
  repeatedRowsReused: number;
  lineage: OfficialUsageLineage;
};

export type OfficialUsageHistoryBundleSummary = OfficialUsageSetSummary & {
  isActive: boolean;
  observationCount: number;
  rowCount: number;
  uniquePayloadCount: number;
  repeatedRowsReused: number;
  reportingWindowKnown: boolean;
  activityRangeIsCoverage: false;
  observations: OfficialUsageHistoryObservationSummary[];
};

export type OfficialUsageHistorySummary = {
  importCount: number;
  uniqueObservationCount: number;
  observationRowCount: number;
  uniquePayloadCount: number;
  repeatedRowsReused: number;
  earliestObservedAt: string | null;
  latestObservedAt: string | null;
  activityDateRange: {
    earliestDateUtc: string | null;
    latestDateUtc: string | null;
    provenance: "last_activity_dates";
    provesReportingCoverage: false;
  };
  reportingWindows: {
    earliestStartDateUtc: string | null;
    latestEndDateUtc: string | null;
    knownCount: number;
    unknownCount: number;
    overlappingKnownWindowCount: number;
    additive: false;
  };
  warning: {
    code: "rolling_snapshots_not_additive";
    message: string;
  };
};

export type OfficialUsageHistoryView = {
  summary: OfficialUsageHistorySummary;
  bundles: {
    value: OfficialUsageHistoryBundleSummary[];
    count: number;
    limit: number;
    offset: number;
  };
};

export type OfficialUsageOverviewView = {
  revision: number;
  summary: {
    retainedSets: number;
    reportedAgents: number;
    usedAgents: number;
    activeAgents30Days: number;
    undatedAgents: number;
    earliestActivityDateUtc: string | null;
    latestActivityDateUtc: string | null;
    asOf: string;
    activeSinceDateUtc: string;
  };
  agents: {
    value: Array<{
      agentId: string;
      agentName: string;
      creatorTypes: string[];
      hasResponses: boolean;
      lastActivityDateUtc: string | null;
      observationCount: number;
      latestSetId: string;
      latestAcceptedAt: string;
    }>;
    count: number;
    limit: number;
    offset: number;
  };
  filters: {
    scope?: "history" | "selected";
    search: string | null;
    startDate: string | null;
    endDate: string | null;
    sortBy: "agentName" | "lastActivity";
    sortDirection: "asc" | "desc";
  };
};