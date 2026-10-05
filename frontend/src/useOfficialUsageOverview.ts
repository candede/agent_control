import type { ReportOverviewAgent } from "../../backend/src/types/officialReportData";
import type { ReportPageRequest } from "./api/reportData";
import { useReportPage } from "./useReportPage";
export function useOfficialUsageOverview(query: ReportPageRequest, revision: number, enabled = true) {
  const validation = query.startDate && query.endDate && query.startDate > query.endDate
    ? "The activity start date must be on or before the end date." : undefined;
  const read = useReportPage<ReportOverviewAgent>("official-usage/overview", query, revision, enabled && !validation);
  return { ...read, validation };
}
