import type { AgentUsageHistoryPoint } from "../../backend/src/types/officialReportApi";
import { usageCount, usageDate } from "./usageInsights";

export function usagePeriodLabel(point: AgentUsageHistoryPoint) {
  return point.reportingStart && point.reportingEnd
    ? `${usageDate(point.reportingStart)} to ${usageDate(point.reportingEnd)}` : "Dates not supplied";
}

export function snapshotChange(current: AgentUsageHistoryPoint, previous?: AgentUsageHistoryPoint) {
  if (current.responses === null) return { label: "Usage not reported", comparable: false };
  if (!current.reportingEnd) return { label: "Report dates unavailable", comparable: false };
  if (!previous) return { label: "Baseline", comparable: false };
  if (previous.responses === null || !previous.reportingEnd) return { label: "Previous report not reported", comparable: false };
  if (current.reportingEnd === previous.reportingEnd) return { label: "Same report end date", comparable: false };
  const days = (point: AgentUsageHistoryPoint) => point.reportingStart && point.reportingEnd
    ? (Date.parse(point.reportingEnd) - Date.parse(point.reportingStart)) / 86400000 + 1 : null;
  if (current.periodProvenance !== "activity_range" && previous.periodProvenance !== "activity_range"
    && days(current) !== days(previous)) return { label: "Different reporting windows", comparable: false };
  const difference = current.responses - previous.responses;
  if (!difference) return { label: "No change", comparable: true, difference, percentage: 0 };
  if (previous.responses === 0) return { label: `New activity (+${usageCount(difference)} responses)`, comparable: true, difference };
  const percentage = difference / previous.responses * 100;
  const percent = Math.abs(percentage).toLocaleString(undefined, { maximumFractionDigits: 1 });
  return { label: `${difference > 0 ? "+" : "-"}${usageCount(Math.abs(difference))} responses (${percentage > 0 ? "+" : "-"}${percent}%)`,
    comparable: true, difference, percentage };
}
