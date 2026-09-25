import type { ReactNode } from "react";
import type { UnifiedAgentInventoryPage } from "../api/client";
import type { UnifiedAgentInventoryScope, UnifiedAgentView } from "../../../backend/src/types/unifiedAgents";
import { agentInventoryScopeOptions, inventoryScopeAgentCount } from "../agentColumns";
import { useOfficialUsageOverview } from "../useOfficialUsageOverview";
import { usageCount, usageDate } from "../usageInsights";
import "./cumulativeUsage.css";

export function AgentInventoryOverview({ inventory, revision, view, onViewChange, inventoryScope = "catalog", onInventoryScopeChange, reportSelector }: {
  inventory?: UnifiedAgentInventoryPage;
  revision: number;
  view?: UnifiedAgentView;
  onViewChange?: (view: "all" | "available") => void;
  inventoryScope?: UnifiedAgentInventoryScope;
  onInventoryScopeChange?: (scope: UnifiedAgentInventoryScope) => void;
  reportSelector?: ReactNode;
}) {
  const { data, loading, error, retry } = useOfficialUsageOverview({ scope: "selected", limit: 1 }, revision);
  const hasCatalog = inventory?.sources.graphPackages.state !== undefined && inventory.sources.graphPackages.state !== "unavailable";
  const hasPowerPlatform = inventory?.sources.powerPlatform.state !== undefined && inventory.sources.powerPlatform.state !== "unavailable";
  const hasInventory = inventoryScope === "catalog" ? hasCatalog : inventoryScope === "power_platform_only" ? hasPowerPlatform : hasCatalog || hasPowerPlatform;
  const selectedScope = agentInventoryScopeOptions.find(option => option.value === inventoryScope)!;
  const count = (scope: UnifiedAgentInventoryScope) => inventory && (scope === "catalog" ? hasCatalog : scope === "power_platform_only" ? hasPowerPlatform : hasCatalog || hasPowerPlatform)
    ? inventoryScopeAgentCount(inventory.summary, scope) : null;
  const scopedInventory = inventory?.inventoryScope === inventoryScope ? inventory : undefined;
  const reports = data?.summary.retainedSets ? data.summary : undefined;
  return <section className="agent-inventory-overview" aria-label="Agent inventory overview">
    {onInventoryScopeChange ? <div className="agent-inventory-scopes" role="group" aria-label="Inventory scope">
      {agentInventoryScopeOptions.filter(option => option.value !== "all").map(option => <button key={option.value} type="button"
        className="secondary agent-inventory-scope" aria-pressed={inventoryScope === option.value}
        aria-label={option.label} title={option.description}
        onClick={() => onInventoryScopeChange(option.value)}>
        <span>{option.label}</span><strong>{usageCount(count(option.value))}</strong>
      </button>)}
      {reportSelector}
    </div> : null}
    {inventoryScope !== "catalog" && inventory && !hasCatalog ? <p className="agent-inventory-scope-warning" aria-live="polite">
      The package catalog is unavailable. Catalog matching is incomplete until that source is collected.
    </p> : null}
    <div className="agent-overview-metrics">
      <Metric label={selectedScope.metric} value={count(inventoryScope)}
        hint={inventory?.partial ? "Includes unavailable agents · Partial data" : "Includes unavailable agents"}
        selected={view === "all"} onClick={onViewChange ? () => onViewChange("all") : undefined} />
      <Metric label="Available to end users" value={hasInventory ? scopedInventory?.inventoryOverview?.availableToUsers ?? null : null}
        hint={inventory?.partial ? "In this view · Partial data" : "In this view · All or selected users"}
        selected={view === "available"} onClick={onViewChange ? () => onViewChange("available") : undefined} />
      <Metric label="Reported used agents" value={reports?.usedAgents ?? null}
        hint={reports ? "Selected report set · Independent of inventory view" : "No selected report data"} />
      <Metric label="Reported active · 30 days" value={reports?.activeAgents30Days ?? null}
        hint={reports && data ? `${usageDate(data.summary.activeSinceDateUtc)} - ${usageDate(data.summary.asOf)} (UTC) · Selected report set` : "No selected report data"} />
    </div>
    {loading ? <p role="status">Loading selected report evidence...</p> : null}
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
