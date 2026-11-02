import type { CopilotAppActivity, CopilotServiceSummaryState } from "./copilotUsage.js";
import type { PublishedSelectedRead } from "./dataSelection.js";
import type { UserSourceFilter } from "./userSources.js";

export const officeApps = [
  { id: "word", label: "Word", activityField: "wordCopilotLastActivityDate", column: "word_date" },
  { id: "excel", label: "Excel", activityField: "excelCopilotLastActivityDate", column: "excel_date" },
  { id: "powerpoint", label: "PowerPoint", activityField: "powerpointCopilotLastActivityDate", column: "powerpoint_date" },
  { id: "outlook", label: "Outlook", activityField: "outlookCopilotLastActivityDate", column: "outlook_date" },
  { id: "onenote", label: "OneNote", activityField: "onenoteCopilotLastActivityDate", column: "onenote_date" },
  { id: "loop", label: "Loop", activityField: "loopCopilotLastActivityDate", column: "loop_date" },
  { id: "teams", label: "Teams", activityField: "microsoftTeamsCopilotLastActivityDate", column: "teams_date" },
] as const satisfies readonly { id: string; label: string; activityField: keyof CopilotAppActivity; column: string }[];
export type OfficeApp = typeof officeApps[number]["id"];
export type OfficeDates = Record<OfficeApp, string | null>;
export type OfficeUnknownReason = "missing_row" | "ambiguous_identity" | "retained_row" | "retained_directory"
  | "wrong_window" | "no_app_dates" | "invalid_app_date" | "future_app_date";
export type OfficePerson = {
  identity: string; userPrincipalName: string; displayName: string | null;
  company: string | null; department: string | null; groupId: string;
  entitlement: NonNullable<UserSourceFilter["entitlement"]>; serviceState: CopilotServiceSummaryState;
  directoryObservedAt: string; appObservedAt: string | null; appReportRefreshDate: string | null;
  dates: OfficeDates; recentApps: OfficeApp[]; latestRecentDate: string | null;
  unknownReasons: OfficeUnknownReason[];
};
export type OfficeMetrics = {
  savedLicensedPeople: number; reportedActiveUsers: number; activeUserAppPairs: number; appsUsed: number;
  noRecentEvidencePeople: number; unknownEvidencePeople: number;
  perApp: Record<OfficeApp, number>;
};
export type OfficeCoverage = {
  directoryPeople: number; paidInactivePeople: number; noPaidPeople: number; unknownLicensePeople: number;
  reportedRows: number; retainedRows: number;
  unknownReasons: Record<OfficeUnknownReason, number>;
  state: "complete" | "partial";
};
export type OfficeObservation = {
  id: string; reportRefreshDate: string; period: "D28"; reportVersion: "v2"; windowStart: string;
  kind: "current" | "weekly";
  capturedAt: string; expiresAt: string; contentHash: string;
  directoryGenerationId: string; appGenerationId: string;
  directoryObservedAt: string; appObservedAt: string;
  coverage: OfficeCoverage;
};
export type OfficeStatus = {
  state: "available" | "preparing" | "waiting_sources" | "unavailable" | "failed";
  errorCode: string | null; message: string | null;
};
export type OfficeQuery = {
  officeSnapshot?: string; officeBaseline?: string;
  company?: string | null; department?: string | null; search?: string; app?: OfficeApp;
};
export type OfficeContext = {
  observation: OfficeObservation | null; baseline: OfficeObservation | null;
  status: OfficeStatus; selection: PublishedSelectedRead; query: OfficeQuery;
};
export type OfficePageInfo = {
  limit: number; number: number; pages: number; offset: number;
  nextCursor: string | null; previousCursor: string | null; anchor: string | null;
};
export type OfficePage<T> = { value: T[]; page: OfficePageInfo; counts: { total: number; filtered: number }; context: OfficeContext };
export type OfficeGroup = {
  id: string; company: string | null; department: string | null;
  metrics: OfficeMetrics; participation: number | null;
  filteredPeople: number; champions: OfficePerson[];
};
export type OfficeSummary = {
  organization: OfficeMetrics | null; matching: OfficeMetrics | null; matchingGroups: number;
  filteredPeople: number; suggestedChampions: number | null; filteredSuggestedChampions: number | null;
  baseline: OfficeMetrics | null; context: OfficeContext;
};
export type OfficeHistoryPoint = { observation: OfficeObservation; metrics: OfficeMetrics };
export type OfficeFacet = { value: string | null; groups: number; people: number };
export type OfficeFacetKind = "company" | "department";
