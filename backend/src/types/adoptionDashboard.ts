import type { ReportListPage, ReportSummary } from "./officialReportData.js";
import type { UserSourceMetadata } from "./userSources.js";

export type AdoptionSnapshot = {
  id: string;
  reportingStart: string | null;
  reportingEnd: string | null;
  periodProvenance: string;
  acceptedAt: string;
  activeUsers: number;
  activeAgents: number;
  responses: number;
  userReportActiveUsers: number;
  relationshipActiveUsers: number;
  userReportResponses: number;
  relationshipResponses: number;
};

export type AdoptionHistoryPage = ReportListPage<AdoptionSnapshot>;

export type AdoptionDepartment = {
  id: string;
  company: string | null;
  department: string | null;
  people: number;
  activePeople: number | null;
};

export type AdoptionDepartmentPage = ReportListPage<AdoptionDepartment> & {
  directory: UserSourceMetadata;
};

export type AdoptionSummary = {
  organization: ReportSummary;
  champions: number | null;
};

export type AdoptionSummaryPage = ReportListPage<AdoptionSummary>;
