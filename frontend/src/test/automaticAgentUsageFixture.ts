import type { InventoryReportContext, InventoryReportSummary } from "../../../backend/src/types/unifiedAgents";
import { reports, reportSetId } from "./reportDataFixture";

export const automaticUsagePackageId = "P_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const automaticUsageReportName = "Excel (Agent)";
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
