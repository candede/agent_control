import type { AgentUsageHistoryPoint } from "../../backend/src/types/officialReportApi";
import { isValidUsageCount, usageCount, usageDate, usageDateRange } from "./usageInsights";

export function usagePeriodLabel(point: AgentUsageHistoryPoint) {
  if (!point.reportingStart || !point.reportingEnd) return "Dates not supplied";
  return usageDateRange(point.reportingStart, point.reportingEnd)
    ? `${usageDate(point.reportingStart)} to ${usageDate(point.reportingEnd)}` : "Report dates unavailable";
}

export function snapshotChange(current: AgentUsageHistoryPoint, previous?: AgentUsageHistoryPoint) {
  if (!isValidUsageCount(current.responses)) return { label: "Usage not reported", comparable: false };
  const currentRange = usageDateRange(current.reportingStart, current.reportingEnd);
  if (!currentRange) return { label: "Report dates unavailable", comparable: false };
  if (!previous) return { label: "Baseline", comparable: false };
  if (!isValidUsageCount(previous.responses)) return { label: "Previous report not reported", comparable: false };
  const previousRange = usageDateRange(previous.reportingStart, previous.reportingEnd);
  if (!previousRange) return { label: "Previous report dates unavailable", comparable: false };
  if (currentRange.end === previousRange.end) return { label: "Same report end date", comparable: false };
  if (currentRange.end < previousRange.end) return { label: "Report dates out of order", comparable: false };
  if (current.periodProvenance !== "activity_range" && previous.periodProvenance !== "activity_range"
    && currentRange.end - currentRange.start !== previousRange.end - previousRange.start) return { label: "Different reporting windows", comparable: false };
  const difference = current.responses - previous.responses;
  if (!difference) return { label: "No change", comparable: true, difference, percentage: 0 };
  if (previous.responses === 0) return { label: `New activity (+${usageCount(difference)} responses)`, comparable: true, difference };
  const percentage = difference / previous.responses * 100;
  const percent = Math.abs(percentage).toLocaleString(undefined, { maximumFractionDigits: 1 });
  return { label: `${difference > 0 ? "+" : "-"}${usageCount(Math.abs(difference))} responses (${percentage > 0 ? "+" : "-"}${percent}%)`,
    comparable: true, difference, percentage };
}
