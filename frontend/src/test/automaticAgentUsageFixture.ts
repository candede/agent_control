import type { AgentUsageContext, AgentUsageSummary } from "../api/client";
import { usageFixtureSetId, usageInsightsPublished } from "./usageInsightsFixture";

export const automaticUsagePackageId = "P_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const automaticUsageReportName = "Excel (Agent)";
export const automaticUsageContext: AgentUsageContext = {
  availability: "active", revision: "b".repeat(64), reportSet: usageInsightsPublished.activeSet,
  lineages: [usageInsightsPublished.reports.agents!.lineage],
};

export function automaticAgentUsageFixture(overrides: Partial<AgentUsageSummary> = {}): AgentUsageSummary {
  return {
    status: "linked", reportSetId: usageFixtureSetId, responses: 181, activeUsers: 7,
    lastActivityDateUtc: "2026-09-12T00:00:00.000Z",
    associations: [{
      reportAgentId: automaticUsagePackageId, reportAgentName: automaticUsageReportName,
      basis: "exact_package_id", target: { source: "graph_packages", packageId: automaticUsagePackageId },
    }],
    ...overrides,
  };
}
