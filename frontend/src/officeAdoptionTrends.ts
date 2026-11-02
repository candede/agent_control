import type { OfficeHistoryPoint } from "../../backend/src/types/officeAppAdoption";
import { usageCount } from "./usageInsights";

export function orderedOfficeHistory(points: OfficeHistoryPoint[]) {
  return [...points].sort((left, right) => left.observation.reportRefreshDate.localeCompare(right.observation.reportRefreshDate));
}
export function officeChange(before: number | undefined, after: number | undefined) {
  if (before === undefined || after === undefined) return undefined;
  const delta = after - before;
  const percent = before ? ` (${delta > 0 ? "+" : ""}${Math.round(delta / before * 100)}%)` : "";
  return { direction: delta > 0 ? "up" : delta < 0 ? "down" : "flat",
    label: `${delta > 0 ? "+" : delta < 0 ? "-" : ""}${usageCount(Math.abs(delta))}${percent}` };
}
export function officeMonthHistory(points: OfficeHistoryPoint[], end: string) {
  const cutoff = Date.parse(end) - 29 * 86_400_000;
  return orderedOfficeHistory(points).filter(point => Date.parse(point.observation.reportRefreshDate)>=cutoff
    && point.observation.reportRefreshDate<=end);
}
export function officeFourWeekBaseline(points: OfficeHistoryPoint[], end: string) {
  const target = Date.parse(end) - 28 * 86_400_000;
  return orderedOfficeHistory(points).filter(point => {
    const day = Date.parse(point.observation.reportRefreshDate);
    return day<=target && day>=target-7*86_400_000;
  }).at(-1);
}
export function officeParticipationChange(beforeUsers: number, beforeLicensed: number, afterUsers: number, afterLicensed: number) {
  if (!beforeLicensed || !afterLicensed) return undefined;
  // Exact cross-products avoid cancellation and rounding errors in measured cohort ratios.
  const denominator = BigInt(beforeLicensed) * BigInt(afterLicensed);
  const delta = BigInt(afterUsers) * BigInt(beforeLicensed) - BigInt(beforeUsers) * BigInt(afterLicensed);
  const tenths = (delta < 0n ? -delta : delta) * 1000n;
  const rounded = (tenths + denominator / 2n) / denominator;
  const magnitude = tenths > 0n && tenths < denominator ? "<0.1" : `${rounded / 10n}.${rounded % 10n}`;
  return { direction: delta > 0n ? "up" : delta < 0n ? "down" : "flat",
    label: `${delta > 0n ? "+" : delta < 0n ? "-" : ""}${magnitude} percentage points` };
}
