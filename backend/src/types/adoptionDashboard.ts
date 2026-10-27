import type { ReportListPage } from "./officialReportData.js";

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
