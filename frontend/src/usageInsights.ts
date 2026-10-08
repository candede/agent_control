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
  if (!usageDateRange(startDate, endDate)) return "Reporting period unavailable";
  const label = provenance === "activity_range" ? "Observed activity range"
    : provenance === "operator_asserted" ? "Admin-supplied period" : "Reporting period";
  return `${label}: ${startDate} to ${endDate}`;
}

export function isValidUsageCount(value: number | null | undefined): value is number {
  return value != null && Number.isSafeInteger(value) && value >= 0;
}

export function usageCount(value: number | null | undefined) {
  return isValidUsageCount(value) ? (value === 0 ? 0 : value).toLocaleString() : "Unknown";
}

export function isValidLowResponseThreshold(value: string) {
  return /^\d+$/.test(value) && Number(value) >= 1 && Number(value) <= 100_000_000;
}

function usageTimestamp(value: string | null | undefined) {
  if (!value) return null;
  const parts = value.match(/^(\d{4}-\d{2}-\d{2})(?:T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2}))?$/);
  if (!parts) return null;
  const day = Date.parse(parts[1]);
  // Date.parse normalizes impossible calendar days, such as February 30.
  if (!Number.isFinite(day) || new Date(day).toISOString().slice(0, 10) !== parts[1]) return null;
  if (parts[2] !== undefined) {
    const offsetHours = parts[5] === "Z" ? 0 : Number(parts[5].slice(1, 3));
    const offsetMinutes = parts[5] === "Z" ? 0 : Number(parts[5].slice(4, 6));
    if (Number(parts[2]) > 23 || Number(parts[3]) > 59 || Number(parts[4]) > 59
      || offsetHours > 14 || offsetMinutes > 59 || offsetHours === 14 && offsetMinutes !== 0) return null;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

export function usageDateRange(startDate: string | null | undefined, endDate: string | null | undefined) {
  if (startDate?.length !== 10 || endDate?.length !== 10) return null;
  const start = usageTimestamp(startDate), end = usageTimestamp(endDate);
  return start !== null && end !== null && start <= end ? { start, end } : null;
}

export function usageDate(value: string | null | undefined) {
  const timestamp = usageTimestamp(value);
  return timestamp === null ? "Not reported" : new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium", timeZone: "UTC",
  }).format(timestamp);
}
