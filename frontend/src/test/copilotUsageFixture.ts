import type { CopilotUsageUser, CopilotUsageUsersResponse, OfficialUsageUserSummary } from "../api/client";

function importedUsage(username: string, displayName: string, count: number): OfficialUsageUserSummary {
  const rows: OfficialUsageUserSummary["rows"] = count ? [{
    agentId: "synthetic-researcher", agentName: "Researcher", displayAgentName: "Researcher",
    creatorType: "Microsoft", username, responsesSentToUsers: count,
    lastActivityDateUtc: "2026-09-12T00:00:00.000Z", packageStatus: "report-only", hasResponses: true,
    identityStatus: "unresolved", creatorTypeSource: "users_and_agents_report",
  }] : [];
  const creatorTypes = rows.map(row => row.creatorType);
  return {
    username, displayName, reportedAgentsUsed: count ? 1 : 0, reportedResponsesReceived: count,
    userLastActivityDateUtc: count ? "2026-09-11T00:00:00.000Z" : undefined,
    agentsAccessedTotal: count ? 1 : 0, responseProducingAgentCount: count ? 1 : 0,
    bridgeResponsesSentToUsers: count, missingUserReport: false, hasReportMismatch: false,
    reviewCohort: count === 0 ? "zero_responses" : count <= 5 ? "low_responses" : "outside_threshold",
    reviewCandidate: count <= 5, licenseAssignmentStatus: "unavailable", creatorTypes, rows,
    searchableText: [displayName, username, ...creatorTypes, ...rows.flatMap(row => [row.displayAgentName, row.agentId])]
      .filter(Boolean).join(" ").toLowerCase(),
    datasetScope: { reportSetId: "synthetic-set", usersVersionId: "synthetic-users", userAgentsVersionId: "synthetic-bridge" },
  };
}

export function licensedUser(index: number, displayName: string, count: number | null): CopilotUsageUser {
  const username = `${displayName.toLowerCase()}@example.invalid`;
  return {
    directory: {
      objectId: `11111111-1111-4111-8111-${String(index).padStart(12, "0")}`,
      displayName, userPrincipalName: username, accountEnabled: true, userType: "Member", employeeType: null,
      companyName: "Contoso Health", department: "Operations",
    },
    copilotServiceState: "enabled",
    servicePlans: [{
      servicePlanId: "a62f8878-de10-42f3-b68f-6149a25ceb97", service: "M365_COPILOT_APPS",
      displayName: "Microsoft 365 Copilot in Productivity Apps", state: "enabled",
      assignedDateTime: "2026-08-01T00:00:00.000Z", capabilityStatus: "Enabled",
    }],
    importedUsage: count === null ? null : importedUsage(username, displayName, count),
    appActivity: {
      reportRefreshDate: "2026-09-12", lastActivityDate: "2026-09-11",
      copilotChatLastActivityDate: "2026-09-10", microsoftTeamsCopilotLastActivityDate: "2026-09-09",
      wordCopilotLastActivityDate: "2026-09-11", excelCopilotLastActivityDate: null,
      powerpointCopilotLastActivityDate: null, outlookCopilotLastActivityDate: "2026-09-10",
      onenoteCopilotLastActivityDate: null, loopCopilotLastActivityDate: null,
    },
    attention: count === null ? ["agent_usage_unknown"] : count === 0 ? ["agent_usage_zero"] : count <= 5 ? ["agent_usage_low"] : [],
  };
}

export const copilotUsageFixture: CopilotUsageUsersResponse = {
  generatedAt: "2026-09-12T10:00:00.000Z", readOnly: true, period: "D30",
  snapshot: {
    state: "available",
    lastAttemptAt: "2026-09-12T10:00:00.000Z",
    lastSuccessAt: "2026-09-12T10:00:00.000Z",
    directoryObservedAt: "2026-09-12T10:00:00.000Z",
    appActivityObservedAt: "2026-09-12T10:00:00.000Z",
  },
  sources: {
    directory: {
      state: "available", message: "Directory candidates checked for effective paid M365 Copilot entitlement.",
      fetchedAt: "2026-09-12T10:00:00.000Z", reportRefreshDate: null, reportVersion: null,
      period: { value: null, startDate: null, endDate: null },
    },
    appActivity: {
      state: "available", message: "Microsoft Graph Copilot report, v1.",
      fetchedAt: "2026-09-12T10:00:00.000Z", reportRefreshDate: "2026-09-12", reportVersion: "v1",
      period: { value: "D30", startDate: "2026-08-14", endDate: "2026-09-12" },
    },
    importedAgentUsage: {
      state: "available", message: "Microsoft 365 admin center Copilot Agents usage exports",
      fetchedAt: "2026-09-12T09:00:00.000Z", reportRefreshDate: null, reportVersion: null,
      period: { value: "D30", startDate: "2026-08-14", endDate: "2026-09-12" },
    },
  },
  counts: { licensedUsers: 4, measuredActivityUsers: 4, needsAttentionUsers: 2, unknownMetricsUsers: 1, unresolvedImportedIdentities: 1 },
  users: [licensedUser(1, "Ada", 200), licensedUser(2, "Ben", 3), licensedUser(3, "Cleo", 0), licensedUser(4, "Drew", null)],
  unresolvedImportedIdentities: [{
    normalizedUserPrincipalName: "hidden-identity", importedUsage: importedUsage("hidden-identity", "Concealed report user", 12),
    reason: "no_exact_directory_match",
  }],
  notices: [],
};
