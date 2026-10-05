import type { ReportMetadata } from "../../backend/src/types/officialReportData";

export function usageAvailabilityLabel(value: ReportMetadata["availability"]) {
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

export function usageCoverageLabel(set: Pick<ReportMetadata, "reportingPeriod"> | null) {
  if (!set?.reportingPeriod?.startDate || !set.reportingPeriod.endDate) return "Reporting period not supplied";
  const { startDate, endDate, provenance } = set.reportingPeriod;
  const label = provenance === "activity_range" ? "Observed activity range"
    : provenance === "operator_asserted" ? "Admin-supplied period" : "Reporting period";
  return `${label}: ${startDate} to ${endDate}`;
}

export function usageCount(value: number | null | undefined) {
  return value === null || value === undefined ? "Unknown" : value.toLocaleString();
}

export function isValidLowResponseThreshold(value: string) {
  return /^\d+$/.test(value) && Number(value) >= 1 && Number(value) <= 100_000_000;
}

export function usageDate(value: string | null | undefined) {
  if (!value) return "Not reported";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Not reported" : new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium", timeZone: "UTC",
  }).format(date);
}
