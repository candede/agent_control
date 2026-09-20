import type { OfficialUsageAggregateView } from "../api/client";
import { usageAvailabilityLabel, usageCoverageLabel, usageDate } from "../usageInsights";

type ReportContext = Pick<OfficialUsageAggregateView, "availability" | "activeSet" | "lineages">;

export function UsageReportContext({ data }: { data: ReportContext }) {
  return <div className="agent-usage-context">
    <span className={`agent-insight-badge ${data.availability === "active" ? "" : "attention"}`}>{usageAvailabilityLabel(data.availability)}</span>
    <span>{usageCoverageLabel(data.activeSet)}</span>
    {data.activeSet?.acceptedAt ? <span>Imported {usageDate(data.activeSet.acceptedAt)}</span> : null}
    {data.availability === "stale" ? <p>Historical totals remain visible. Refresh the reports before making adoption decisions.</p> : null}
    {data.activeSet?.reportingPeriod.provenance === "activity_range" ? <p>These dates describe observed activity, not a proven reporting window.</p> : null}
    {data.lineages.some(lineage => lineage.sourceFreshness === "unknown") ? <p>Source refresh time is not supplied for one or more exports. Import time does not establish source freshness.</p> : null}
  </div>;
}
