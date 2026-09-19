import type { OfficialUsageAggregateView } from "../api/client";
import { usageAvailabilityLabel, usageCount, usageCoverageLabel, usageDate } from "../usageInsights";

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

export function UsageMetric({ label, value, hint }: { label: string; value: number | string | null | undefined; hint: string }) {
  return <div className="agent-usage-metric"><span>{label}</span><strong>{typeof value === "string" ? value : usageCount(value)}</strong><small>{hint}</small></div>;
}

export function UsageReportRecovery({ availability }: { availability: OfficialUsageAggregateView["availability"] }) {
  return <div className="agent-insight-empty">
    <h4>{usageAvailabilityLabel(availability)}</h4>
    <p>{availability === "not_selected" ? "Choose an accepted report bundle to explore adoption and user-agent relationships."
      : availability === "deleted" ? "The selected bundle was deleted. Choose a retained bundle or import a new one."
        : "Import the Agents, Users & agents, and Users exports together to see responses, adoption, and who is using what."}</p>
    <p>Inventory availability and installation do not establish usage. Missing reports are not zero activity.</p>
    <a href="/official-usage">Open usage reports</a>
  </div>;
}
