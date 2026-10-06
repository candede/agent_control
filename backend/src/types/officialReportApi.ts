import type { OfficialUsageReportKind, OfficialUsageReportBase, AgentUsageRow, UserAgentUsageRow, UserUsageRow } from "./officialReportRecords.js";
import type { UserSourceSelection, UserSourceMetadata } from "./userSources.js";
import type { ReportAgent, ReportListPage, ReportMetadata } from "./officialReportData.js";
import type { AgentUsageTarget } from "./agentUsageTarget.js";

export type OfficialReportImportIntent = { bundleId: string; correctionOfSetId?: string; rejectDuplicateKind?: boolean };
export type OfficialReportPreview = {
  id: string; revision: number; kind: OfficialUsageReportKind; bundleId: string; contentHash: string; fileHash: string;
  rowCount: number; storedBytes: number; wireBytes: number; activeRevision: string; expiresAt: string;
  reportingPeriod: OfficialUsageReportBase["reportingPeriod"]; sourceAsOf: string | null;
  sourceAsOfProvenance: string; sourceFreshness: "known" | "unknown"; correctionOfSetId: string | null;
  status: "active" | "accepted"; examples: Array<AgentUsageRow | UserAgentUsageRow | UserUsageRow>; warnings: string[];
  reconciliation: { rows: number; responses: number; agentsUsed: number | null };
};
export type OfficialReportBundlePreview = {
  bundleId: string; expectedActiveRevision: string; complete: boolean; bundleHash: string;
  stages: Array<{ stagingId: string; kind: OfficialUsageReportKind; revision: number; contentHash: string; rowCount: number;
    reconciliation: OfficialReportPreview["reconciliation"] }>;
};
export type OfficialReportBundleAcceptance = { bundleHash: string; expectedActiveRevision: string };
export type OfficialReportAccepted = { setId: string; activeRevision: string; complete: boolean };
export type OfficialReportConfirmation = { id: string; setId: string; operation: "select" | "delete";
  activeRevision: string; historyRevision: string; historyEpoch: string; hash: string };
export type OfficialReportConfirmed = { activeSetId: string | null; activeRevision: string };
export type OfficialReportDiagnostics = {
  value: Array<{ ordinal: number; agentId: string | null; username: string | null;
    code: "users_bridge_mismatch" | "agent_bridge_mismatch" | "missing_user_report" }>;
  counts: { total: number; filtered: number }; preview: { id: string; revision: number; contentHash: string };
  page: { limit: number; nextCursor: string | null; previousCursor: string | null };
};
export type OfficialReportFacetPage = {
  value: Array<{ value: string | null; count: number }>; selection: UserSourceSelection;
  counts: { total: number; filtered: number }; page: { limit: number; nextCursor: string | null; previousCursor: string | null };
};
export type OfficialReportExportRequest = { selectionId: string; idempotencyKey?: string;
  kind: "copilot_users" | "official_agents" | "official_users" | "graph_packages" | "power_platform_agents" | "unified_agents"; ids?: readonly string[] };
export type OfficialReportExportStatus = { id: string; status: "queued" | "building" | "ready" | "failed" | "cancelled" | "expired";
  rows: number; bytes: number; expiresAt: string; error: string | null; limit: number | null; observed: number | null };
export type OfficialReportDetail<T> = { value: T; selection: UserSourceSelection; reports: ReportMetadata;
  sources: { directory: UserSourceMetadata; app_activity: UserSourceMetadata } };
export type CandidateAgentUsageContext = { selectionId: string; reportSetId: string | null; usageRevision: string; inventoryRevision: string; reports: ReportMetadata };
export type CandidateAgentUsageSummary = { recordId: string; status: "unavailable" | "unlinked" | "linked"; responses: number | null;
  activeUsers: number | null; lastActivityDateUtc: string | null; associationCount: number; context: CandidateAgentUsageContext };
export type AgentUsageHistoryPoint = {
  setId: string; reportingStart: string | null; reportingEnd: string | null; periodProvenance: string; acceptedAt: string;
  status: "linked" | "unlinked"; responses: number | null; lastActivityDateUtc: string | null;
  associationCount: number;
};
export type CandidateAgentUsageHistory = {
  recordId: string; context: CandidateAgentUsageContext; value: AgentUsageHistoryPoint[];
  latestReportSetId: string | null;
  latestReported: AgentUsageHistoryPoint | null;
  counts: { total: number; filtered: number }; page: OfficialReportFacetPage["page"];
};
export type CandidateAgentUsageMutation = Pick<CandidateAgentUsageContext, "selectionId" | "reportSetId" | "usageRevision" | "inventoryRevision">
  & { reportAgentId: string; confirmed: true; target?: AgentUsageTarget };
export type CandidateAgentUsageCandidates = { value: Array<ReportAgent & { associated: boolean }>; context: CandidateAgentUsageContext;
  selection: UserSourceSelection; page: OfficialReportFacetPage["page"]; counts: OfficialReportFacetPage["counts"] };
export type CandidateAgentUsageAssociations = { value: Array<{ reportAgentId: string; agentName: string; responses: number;
  basis: "reviewed" | "exact_package_id"; target: AgentUsageTarget & { snapshotId: string } }>;
  context: CandidateAgentUsageContext; page: OfficialReportFacetPage["page"]; counts: OfficialReportFacetPage["counts"] };
export type AgentUsageUser = { username: string; displayName: string; responses: number };
export type CandidateAgentUsageUsers = ReportListPage<AgentUsageUser> & { context: CandidateAgentUsageContext };
