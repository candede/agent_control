import type { InventoryReportContext, InventoryReportSummary } from "../../../backend/src/types/unifiedAgents";
import type { AgentUsageHistoryPoint, CandidateAgentUsageContext, CandidateAgentUsageHistory } from "../../../backend/src/types/officialReportApi";
import { reports, reportSetId } from "./reportDataFixture";

export const automaticUsagePackageId = "P_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const automaticUsageReportName = "Excel (Agent)";
export function agentUsageHistoryFixture(context: CandidateAgentUsageContext, recordId: string,
  value: AgentUsageHistoryPoint[] = context.reportSetId ? [{
    setId: context.reportSetId, reportingStart: context.reports.reportingPeriod?.startDate ?? null,
    reportingEnd: context.reports.reportingPeriod?.endDate ?? null,
    periodProvenance: context.reports.reportingPeriod?.provenance ?? "unknown", acceptedAt: "2026-10-06T00:00:00.000Z",
    status: "unlinked", responses: null, lastActivityDateUtc: null, associationCount: 0,
  }] : []): CandidateAgentUsageHistory {
  return { recordId, context, value, latestReportSetId: value[0]?.setId ?? null, latestReported: value.find(point => point.responses !== null) ?? null,
    counts: { total: value.length, filtered: value.length }, page: { limit: 50, nextCursor: null, previousCursor: null } };
}
export const automaticUsageContext: InventoryReportContext = {
  revision: "b".repeat(64), reports, expiresAt: reports.expiresAt,
};

export function automaticAgentUsageFixture(overrides: Partial<InventoryReportSummary> = {}): InventoryReportSummary {
  return {
    recordId: "agent:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", status: "linked", reportSetId, responses: 181, activeUsers: 7, associationCount: 1,
    lastActivityDateUtc: "2026-09-12T00:00:00.000Z",
    ...overrides,
  };
}
