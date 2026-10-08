import type { CopilotAppActivity, CopilotDirectoryIdentity, CopilotServicePlan, CopilotServiceSummaryState } from "./copilotUsage.js";

// Candidate contracts only. Official report metrics are composed by 02A.
export type UserSourceKind = "directory" | "app_activity";
export type UserSourceScope = { tenantId: string; principalId: string; tokenMode: "delegated" | "application" };
export type UserSourceFilter = {
  search?: string;
  company?: string | null;
  department?: string | null;
  entitlement?: "paid_active" | "paid_inactive" | "no_paid" | "unknown";
  serviceState?: CopilotServiceSummaryState;
  activity?: "active" | "inactive" | "unknown";
  sort?: "name" | "upn" | "company" | "department" | "service" | "activity";
  order?: "asc" | "desc";
};
export type UserSourceMetadata = {
  source: UserSourceKind;
  generationId: string | null;
  scopeId: string | null;
  revision: string | null;
  expiresAt: string | null;
  observedAt: string | null;
  attemptedAt: string | null;
  attemptStatus: "running" | "available" | "failed" | "cancelled" | "waiting_authorization" | "permission_required" | null;
  attemptObservedCount: number | null;
  errorCode: string | null;
  message: string | null;
  rowCount: number | null;
  state: "available" | "partial" | "stale" | "unavailable";
  reportRefreshDate: string | null;
  period: "D28" | "D30" | null;
  reportVersion: "v1" | "v2" | null;
};
export type UserSourceFacts = {
  directory: CopilotDirectoryIdentity;
  copilotServiceState: CopilotServiceSummaryState;
  servicePlanCount: number;
  entitlement: NonNullable<UserSourceFilter["entitlement"]>;
  appActivity: CopilotAppActivity | null;
  activityState: NonNullable<UserSourceFilter["activity"]>;
};
export type UserSourceSelection = import("./dataSelection.js").SelectedRead;
export type UserSourcePage<T> = {
  value: T[];
  page: { limit: number; nextCursor: string | null; previousCursor: string | null };
  selection: UserSourceSelection;
  counts: { total: number; filtered: number };
};
export type UserSourceSummary = {
  checkedUsers: number | null;
  licensedUsers: number | null;
  inactivePaidUsers: number | null;
  noPaidUsers: number | null;
  unknownLicenseUsers: number | null;
  activeAppUsers: number | null;
  unknownAppUsers: number | null;
};
export type UserSourcePeople = {
  objectId: string;
  displayName: string | null;
  userPrincipalName: string | null;
  observedAt: string;
  status?: "resolved" | "not_found" | "lookup_failed";
  checkedAt?: string;
  expiresAt?: string;
  errorCode?: string;
};
export type UserSourcePlan = CopilotServicePlan;
