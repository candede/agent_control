export const copilotAppActivityStaleAfterDays = 3;
export const copilotAppActivityPeriod = "D28";
export const copilotAppActivityReportVersion = "v2";

export function isCopilotAppActivityFresh(reportRefreshDate: string | null, now: Date): boolean {
  if (reportRefreshDate === null) return false;
  const endOfDay = Date.parse(`${reportRefreshDate}T23:59:59.999Z`);
  const ageDays = Math.max(0, Math.floor((now.getTime() - endOfDay) / 86_400_000));
  return ageDays <= copilotAppActivityStaleAfterDays;
}

export type CopilotDirectoryUser = {
  serviceEvidenceVersion: 1;
  identity: CopilotDirectoryIdentity;
  copilotServiceState: CopilotServiceSummaryState;
  servicePlans: CopilotServicePlan[];
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
