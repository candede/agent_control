import type { AdoptionSnapshot } from "../../backend/src/types/adoptionDashboard";
import { isValidUsageCount, usageCount, usageDate, usageDateRange } from "./usageInsights";

export type AdoptionMetric = "activeUsers" | "activeAgents" | "responses";
export type AdoptionChange = {
  direction: "up" | "down" | "flat" | "unknown";
  label: string;
  difference?: number;
  percentage?: number;
};

export function adoptionSnapshotLabel(snapshot: AdoptionSnapshot) {
  return usageDateRange(snapshot.reportingStart, snapshot.reportingEnd)
    ? `${usageDate(snapshot.reportingStart)} to ${usageDate(snapshot.reportingEnd)}`
    : "Activity dates unavailable";
}

export function orderedAdoptionSnapshots(snapshots: readonly AdoptionSnapshot[]) {
  return [...snapshots].sort((a, b) => (a.reportingEnd ?? "").localeCompare(b.reportingEnd ?? "")
    || (a.reportingStart ?? "").localeCompare(b.reportingStart ?? "")
    || a.acceptedAt.localeCompare(b.acceptedAt) || a.id.localeCompare(b.id));
}

export function adoptionChange(previous: AdoptionSnapshot | undefined, current: AdoptionSnapshot, metric: AdoptionMetric): AdoptionChange {
  const unknown = (label: string): AdoptionChange => ({ direction: "unknown", label });
  if (!previous) return unknown("No earlier report");
  if (!isValidUsageCount(previous[metric]) || !isValidUsageCount(current[metric])) return unknown("Count unavailable");
  const a = usageDateRange(previous.reportingStart, previous.reportingEnd);
  const b = usageDateRange(current.reportingStart, current.reportingEnd);
  if (!a || !b) return unknown("Report dates unavailable");
  if (b.end === a.end) return unknown("Same report end / observed date");
  if (b.end < a.end) return unknown("Report dates out of order");
  if (previous.periodProvenance !== "activity_range" && current.periodProvenance !== "activity_range"
    && b.end - b.start !== a.end - a.start) return unknown("Different reporting window lengths");
  const difference = current[metric] - previous[metric];
  if (difference === 0) return { direction: "flat", difference, percentage: 0, label: "No change" };
  const signed = `${difference > 0 ? "+" : "-"}${usageCount(Math.abs(difference))}`;
  if (previous[metric] === 0) return { direction: "up", difference, label: `${signed} (from zero)` };
  const percentage = difference / previous[metric] * 100;
  return { direction: difference > 0 ? "up" : "down", difference, percentage,
    label: `${signed} (${percentage > 0 ? "+" : "-"}${Math.abs(percentage).toLocaleString(undefined, { maximumFractionDigits: 1 })}%)` };
}

export function adoptionDirection(previous: AdoptionSnapshot | undefined, current: AdoptionSnapshot, metric: AdoptionMetric) {
  const change = adoptionChange(previous, current, metric);
  return change.direction === "unknown" ? change.label
    : `${change.direction === "up" ? "Higher" : change.direction === "down" ? "Lower" : "Unchanged"} than the previous saved report`;
}
