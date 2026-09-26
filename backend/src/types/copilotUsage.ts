import type { OfficialUsageUserSummary } from "./officialUsage.js";

export const copilotUsagePeriod = "D30" as const;

export type CopilotUsageSnapshotSource = "directory" | "app_activity";
export type CopilotUsageAttemptStatus = "available" | "waiting_authorization" | "permission_required" | "failed";

export type SavedCopilotUsageSource<T> = {
  source: CopilotUsageSnapshotSource;
  attemptStatus: CopilotUsageAttemptStatus | null;
  message: string | null;
  attemptedAt: string | null;
  lastSuccessAt: string | null;
  rowCount: number | null;
  observedAt: string | null;
  value: T | null;
};

export type CopilotDirectoryUser = {
  serviceEvidenceVersion: 1;
  identity: CopilotDirectoryIdentity;
  copilotServiceState: CopilotServiceSummaryState;
  servicePlans: CopilotServicePlan[];
};

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

export type CopilotServiceState = "enabled" | "warning" | "disabled" | "suspended" | "locked_out" | "unknown";
export type CopilotServiceSummaryState = CopilotServiceState | "partially_enabled";

export function isCopilotServiceSummaryState(value: unknown): value is CopilotServiceSummaryState {
  return typeof value === "string"
    && ["enabled", "warning", "disabled", "suspended", "locked_out", "unknown", "partially_enabled"].includes(value);
}

export function isCopilotServiceActive(state: CopilotServiceSummaryState): boolean {
  return state === "enabled" || state === "warning" || state === "partially_enabled";
}

export type CopilotServicePlan = {
  servicePlanId: string;
  service: string;
  displayName: string;
  state: CopilotServiceState;
  assignedDateTime: string | null;
  capabilityStatus: "Enabled" | "Warning" | "Suspended" | "Deleted" | "LockedOut" | null;
};

export type CopilotDirectoryIdentity = {
  objectId: string;
  userPrincipalName: string;
  displayName: string | null;
  accountEnabled: boolean | null;
  userType: string | null;
  employeeType: string | null;
  companyName: string | null;
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
  | "copilot_service_disabled"
  | "copilot_service_unknown"
  | "copilot_service_partial"
  | "copilot_service_warning";

export type CopilotUsageUser = {
  directory: CopilotDirectoryIdentity;
  copilotServiceState: CopilotServiceSummaryState;
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
    // Licensing and adoption metrics use only verified active paid features.
    licensedUsers: number | null;
    measuredActivityUsers: number | null;
    needsAttentionUsers: number | null;
    unknownMetricsUsers: number | null;
    unresolvedImportedIdentities: number;
  };
  // Includes inactive/unverified product candidates for diagnostics and exact identity joins.
  users: CopilotUsageUser[];
  unresolvedImportedIdentities: CopilotUsageUnresolvedImportedIdentity[];
  notices: string[];
};
