import type { InventoryReportContext, InventoryReportSummary } from "../../../backend/src/types/unifiedAgents";
import type { AgentUsageHistoryPoint, CandidateAgentUsageContext, CandidateAgentUsageHistory } from "../../../backend/src/types/officialReportApi";
import { reports, reportSetId } from "./reportDataFixture";

export const automaticUsagePackageId = "P_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const automaticUsageReportName = "Excel (Agent)";
export function agentUsageHistoryFixture(context: CandidateAgentUsageContext, recordId: string,
  value?: readonly AgentUsageHistoryPoint[], options: { limit?: number; cursor?: string } = {}): CandidateAgentUsageHistory {
  const limit = options.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Agent history fixture limit must be 1..100.");
  if (!value) {
    if (context.reportSetId && !context.reports.acceptedAt) throw new Error("A saved report fixture requires its import timestamp.");
    value = context.reportSetId ? [{
      setId: context.reportSetId, reportingStart: context.reports.reportingPeriod?.startDate ?? null,
      reportingEnd: context.reports.reportingPeriod?.endDate ?? null,
      periodProvenance: context.reports.reportingPeriod?.provenance ?? "unknown", acceptedAt: context.reports.acceptedAt!,
      status: "unlinked", responses: null, lastActivityDateUtc: null, associationCount: 0,
    }] : [];
  }
  const descending = (left: string, right: string) => left < right ? 1 : left > right ? -1 : 0;
  const byImport = (left: AgentUsageHistoryPoint, right: AgentUsageHistoryPoint) =>
    Date.parse(right.acceptedAt) - Date.parse(left.acceptedAt) || descending(left.setId, right.setId);
  // Match officialAgentHistory: dated reports sort by period/import, undated pages by ID.
  const points = structuredClone([...value]).sort((left, right) => {
    if (!left.reportingEnd || !right.reportingEnd) {
      return left.reportingEnd ? -1 : right.reportingEnd ? 1 : descending(left.setId, right.setId);
    }
    return descending(left.reportingEnd, right.reportingEnd)
      || descending(left.reportingStart ?? "", right.reportingStart ?? "") || byImport(left, right);
  });
  const latest = points[0]?.reportingEnd ? points[0] : [...points].sort(byImport)[0];
  const owner = JSON.stringify([recordId, context]);
  const cursor = (point: AgentUsageHistoryPoint, direction: "next" | "previous") => `${owner}:${direction}:${point.setId}`;
  let start = 0, end = limit;
  if (options.cursor) {
    const boundary = points.findIndex(point => cursor(point, "next") === options.cursor || cursor(point, "previous") === options.cursor);
    if (boundary < 0) throw new Error("Invalid agent history fixture cursor.");
    if (cursor(points[boundary], "previous") === options.cursor) {
      start = Math.max(0, boundary - limit); end = boundary;
    } else {
      start = boundary + 1; end = start + limit;
    }
  }
  const page = points.slice(start, end);
  return { recordId, context: structuredClone(context), value: page, latestReportSetId: latest?.setId ?? null,
    latestReported: structuredClone(points.find(point => point.responses !== null) ?? null),
    counts: { total: points.length, filtered: points.length }, page: { limit,
      nextCursor: page.length && end < points.length ? cursor(page.at(-1)!, "next") : null,
      previousCursor: page.length && start > 0 ? cursor(page[0], "previous") : null } };
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
