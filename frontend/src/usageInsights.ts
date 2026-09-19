import type { OfficialUsageAggregateView, OfficialUsageSetSummary } from "./api/client";
import { usersRouteSearch, workbenchUrl } from "./workbenchRouting";

export function usageAvailabilityLabel(value: OfficialUsageAggregateView["availability"]) {
  const labels = {
    active: "Selected report",
    stale: "Out-of-date report",
    never_imported: "Reports not imported",
    incomplete: "Incomplete report bundle",
    not_selected: "No report selected",
    deleted: "Selected report deleted",
  };
  return labels[value];
}

export function usageCoverageLabel(set: OfficialUsageSetSummary | null) {
  if (!set?.reportingPeriod.startDate || !set.reportingPeriod.endDate) return "Reporting period not supplied";
  const { startDate, endDate, provenance } = set.reportingPeriod;
  const label = provenance === "activity_range" ? "Observed activity range"
    : provenance === "operator_asserted" ? "Admin-supplied period" : "Reporting period";
  return `${label}: ${startDate} to ${endDate}`;
}

export function usageCount(value: number | null | undefined) {
  return value === null || value === undefined ? "Unknown" : value.toLocaleString();
}

export function usageDate(value: string | null | undefined) {
  if (!value) return "Not reported";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Not reported" : new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium", timeZone: "UTC",
  }).format(date);
}

export function usagePageLabel(page: { value: readonly unknown[]; count: number; offset: number }, items: string) {
  if (!page.count) return `No matching ${items}`;
  if (!page.value.length) return `No ${items} on this page (${page.count.toLocaleString()} matching)`;
  return `${(page.offset + 1).toLocaleString()}-${Math.min(page.offset + page.value.length, page.count).toLocaleString()} of ${page.count.toLocaleString()} ${items}`;
}

export function userAgentMatrixUrl(agentId?: string, reportSetId?: string, search = "") {
  return workbenchUrl("users", usersRouteSearch({ view: "matrix", agentId, reportSetId, search, page: 0 }));
}
