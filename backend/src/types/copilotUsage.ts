import type { OfficialUsageUserSummary } from "./officialUsage.js";

export const copilotUsagePeriod = "D30" as const;

export type CopilotUsageSourceState =
  | "available"
  | "partial"
  | "unavailable"
  | "not_imported"
  | "stale";

export type CopilotUsageSourceSummary = {
  state: CopilotUsageSourceState;
  message: string;
  fetchedAt: string | null;
  reportRefreshDate: string | null;
  reportVersion: "v1" | null;
  period: {
    value: string | null;
    startDate: string | null;
    endDate: string | null;
  };
};

export type CopilotLicenseState = "assigned" | "enabled" | "disabled" | "error";

export type CopilotLicenseAssignment = {
  skuId: string;
  skuPartNumber: string;
  state: CopilotLicenseState;
  disabledPlanIds: string[];
  assignmentStates: Array<{
    state: "Active" | "ActiveWithError" | "Disabled" | "Error";
    error: string | null;
    assignedByGroup: string | null;
  }>;
};

export type CopilotServicePlan = {
  servicePlanId: string;
  service: string;
  assignedDateTime: string | null;
  capabilityStatus: "Enabled" | "Warning" | "Suspended" | "Deleted" | "LockedOut";
};

export type CopilotDirectoryIdentity = {
  objectId: string;
  userPrincipalName: string;
  displayName: string | null;
  accountEnabled: boolean | null;
  userType: string | null;
  employeeType: string | null;
  department: string | null;
};

export type CopilotAppActivity = {
  reportRefreshDate: string;
  lastActivityDate: string | null;
  copilotChatLastActivityDate: string | null;
  microsoftTeamsCopilotLastActivityDate: string | null;
  wordCopilotLastActivityDate: string | null;
  excelCopilotLastActivityDate: string | null;
  powerpointCopilotLastActivityDate: string | null;
  outlookCopilotLastActivityDate: string | null;
  onenoteCopilotLastActivityDate: string | null;
  loopCopilotLastActivityDate: string | null;
};

export type CopilotUsageAttention =
  | "agent_usage_zero"
  | "agent_usage_low"
  | "agent_usage_unknown"
  | "app_activity_inactive"
  | "app_activity_unknown"
  | "license_error"
  | "license_disabled";

export type CopilotUsageUser = {
  directory: CopilotDirectoryIdentity;
  licenses: CopilotLicenseAssignment[];
  servicePlans: CopilotServicePlan[];
  importedUsage: OfficialUsageUserSummary | null;
  appActivity: CopilotAppActivity | null;
  attention: CopilotUsageAttention[];
};

export type CopilotUsageUnresolvedImportedIdentity = {
  normalizedUserPrincipalName: string;
  importedUsage: OfficialUsageUserSummary;
  reason: "no_exact_directory_match" | "ambiguous_directory_match" | "directory_unavailable";
};

export type CopilotUsageUsersRequest = Record<string, never>;

export type CopilotUsageUsersResponse = {
  generatedAt: string;
  readOnly: true;
  period: typeof copilotUsagePeriod;
  snapshot?: {
    state: "not_synced" | "available" | "partial";
    lastAttemptAt: string | null;
    lastSuccessAt: string | null;
    directoryObservedAt: string | null;
    appActivityObservedAt: string | null;
  };
  sources: {
    directory: CopilotUsageSourceSummary;
    appActivity: CopilotUsageSourceSummary;
    importedAgentUsage: CopilotUsageSourceSummary;
  };
  counts: {
    licensedUsers: number | null;
    measuredActivityUsers: number | null;
    needsAttentionUsers: number | null;
    unknownMetricsUsers: number | null;
    unresolvedImportedIdentities: number;
  };
  users: CopilotUsageUser[];
  unresolvedImportedIdentities: CopilotUsageUnresolvedImportedIdentity[];
  notices: string[];
};
