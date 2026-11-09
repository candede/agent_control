import type { OfficeContext, OfficeMetrics, OfficePerson, OfficeQuery } from "./officeAppAdoption.js";
import type { PublishedSelectedRead } from "./dataSelection.js";
import type { ReportMetadata, ReportQuery } from "./officialReportData.js";
import type { UserSourceMetadata } from "./userSources.js";

export type OpportunityCohort = "positive" | "no_reported" | "unknown";
export type OpportunityQuery = OfficeQuery & {
  setId?: string; reportSelectionId?: string; officeSelectionId?: string; inventorySelectionId?: string;
};
export type OpportunityContext = {
  office: OfficeContext;
  report: { selection: PublishedSelectedRead; query: ReportQuery; reports: ReportMetadata; directory: UserSourceMetadata };
  inventory: PublishedSelectedRead | null;
  inventoryState: "available" | "unavailable";
};
type EvidenceCoverage = {
  state: "complete" | "partial" | "unavailable";
  reasons: string[]; unresolvedReportIdentities: number; ambiguousOfficePeople: number;
};
type DepartmentOpportunity = {
  id: string; rank: number; company: string | null; department: string | null;
  office: OfficeMetrics;
  denominators: {
    officePaid: number; officeActive: number;
    currentDirectory: number | null; currentAgentPaid: number | null;
  };
  agentEvidence: { positive: number | null; noReported: number | null; unknown: number | null };
  coverage: EvidenceCoverage;
  drilldowns: {
    audience: { path: string; query: OpportunityQuery };
    officePeople: { path: string; query: OfficeQuery & { selectionId: string } };
    peers: { path: string; query: Record<string, unknown>; requiresExactGroupCapture: boolean };
    agents: { path: string; query: Record<string, unknown> };
  };
};
export type OpportunityPage = {
  value: DepartmentOpportunity[]; counts: { total: number; filtered: number };
  summary: { officeActive: number | null; positive: number | null; noReported: number | null; unknown: number | null };
  page: { limit: number; nextCursor: string | null }; context: OpportunityContext;
  definitions: {
    officePaid: string; officeActive: string; currentDirectory: string; currentAgentPaid: string;
    positive: string; noReported: string; unknown: string;
  };
};
export type OpportunityPeoplePage = {
  value: Array<{ person: OfficePerson; agentEvidence: OpportunityCohort; reportedUsername: string | null }>;
  counts: { total: number; returned: number }; page: { limit: number; nextCursor: string | null };
  context: OpportunityContext;
};
