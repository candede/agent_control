import type { UnifiedAgentInventoryPage } from "../api/client";
import type { UnifiedAgentView } from "../../../backend/src/types/unifiedAgents";
import { useOfficialUsageOverview } from "../useOfficialUsageOverview";
import { usageCount, usageDate } from "../usageInsights";
import "./cumulativeUsage.css";

export function AgentInventoryOverview({ inventory, revision, view, onViewChange }: {
  inventory?: UnifiedAgentInventoryPage;
  revision: number;
  view?: UnifiedAgentView;
  onViewChange?: (view: "all" | "available") => void;
}) {
  const { data, loading, error, retry } = useOfficialUsageOverview({ limit: 1 }, revision);
  const hasInventory = inventory && (inventory.sources.graphPackages.state !== "unavailable"
    || inventory.sources.powerPlatform.state !== "unavailable");
  const reports = data?.summary.retainedSets ? data.summary : undefined;
  return <section className="agent-inventory-overview" aria-label="Agent inventory overview">
    <div className="agent-overview-metrics">
      <Metric label="Agents in repository" value={hasInventory ? inventory.summary.total : null}
        hint={inventory?.partial ? "Includes unavailable agents · Partial data" : "Includes unavailable agents"}
        selected={view === "all"} onClick={onViewChange ? () => onViewChange("all") : undefined} />
      <Metric label="Available to end users" value={hasInventory ? inventory.inventoryOverview?.availableToUsers ?? null : null}
        hint={inventory?.partial ? "All or selected users · Partial data" : "All or selected users"}
        selected={view === "available"} onClick={onViewChange ? () => onViewChange("available") : undefined} />
      <Metric label="Reported used agents" value={reports?.usedAgents ?? null}
        hint={reports ? "Across all imported reports" : "No report data"} />
      <Metric label="Reported active · 30 days" value={reports?.activeAgents30Days ?? null}
        hint={reports && data ? `${usageDate(data.summary.activeSinceDateUtc)} - ${usageDate(data.summary.asOf)} (UTC)` : "No report data"} />
    </div>
    {loading ? <p role="status">Loading retained activity evidence...</p> : null}
    {error ? <p className="error-banner" role="alert">{error} <button className="secondary" type="button" onClick={retry}>Retry activity evidence</button></p> : null}
  </section>;
}

function Metric({ label, value, hint, selected, onClick }: {
  label: string; value: number | null; hint: string; selected?: boolean; onClick?: () => void;
}) {
  const content = <><span>{label}</span><strong>{usageCount(value)}</strong><small>{hint}</small></>;
  return onClick
    ? <button type="button" className="metric agent-overview-filter" aria-label={`Show ${label.toLowerCase()}`}
      aria-pressed={selected} disabled={value === null} onClick={onClick}>{content}</button>
    : <div className="metric">{content}</div>;
}
