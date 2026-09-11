export type OfficialUsageReportKind = "agents" | "userAgents" | "users";

export type OfficialUsageMetadata = {
  reportingPeriod: {
    startDate: string;
    endDate: string;
    provenance: "source_metadata" | "operator_asserted";
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
    startDate: string;
    endDate: string;
    days: number;
    provenance: "source_metadata" | "operator_asserted";
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
  reportingPeriod: { startDate: string; endDate: string };
  supersedesSetId: string | null;
  complete: boolean;
  kinds: OfficialUsageReportKind[];
  acceptedAt: string | null;
  deletedAt: string | null;
  createdAt: string;
  expiresAt: string;
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
  summary: OfficialUsageReportingSummary;
  agents: { value: OfficialUsageAgent[]; count: number; limit: number; offset: number };
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
  filters: { creatorTypes: string[] };
  counts: {
    users: number;
    userRows: number;
    accessRows: number;
    reportOnlyRows: number;
    totalResponsesReceived: number;
    mismatchCount: number;
  };
  topUsersByResponses: OfficialUsageTopUser[];
  users: { value: OfficialUsageUserSummary[]; count: number; limit: number; offset: number };
};