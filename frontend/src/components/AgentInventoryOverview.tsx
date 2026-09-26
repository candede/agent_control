import type { ReactNode } from "react";
import type { UnifiedAgentInventoryPage } from "../api/client";
import type { UnifiedAgentAccessFilter, UnifiedAgentInventoryScope, UnifiedAgentUsageFilter } from "../../../backend/src/types/unifiedAgents";
import { agentInventoryScopeOptions, inventoryScopeAgentCount } from "../agentColumns";
import { useOfficialUsageOverview } from "../useOfficialUsageOverview";
import { usageAvailabilityLabel, usageCount, usageCoverageLabel, usageDate } from "../usageInsights";
import "./cumulativeUsage.css";

function scopeCount(inventory: UnifiedAgentInventoryPage | undefined, scope: UnifiedAgentInventoryScope) {
  const hasCatalog = inventory?.sources.graphPackages.state !== undefined && inventory.sources.graphPackages.state !== "unavailable";
  const hasPowerPlatform = inventory?.sources.powerPlatform.state !== undefined && inventory.sources.powerPlatform.state !== "unavailable";
  return inventory && (scope === "catalog" ? hasCatalog : scope === "power_platform_only" ? hasPowerPlatform : hasCatalog || hasPowerPlatform)
    ? inventoryScopeAgentCount(inventory.summary, scope) : null;
}

export function AgentInventoryScopes({ inventory, value, onChange }: {
  inventory?: UnifiedAgentInventoryPage;
  value: UnifiedAgentInventoryScope;
  onChange: (scope: UnifiedAgentInventoryScope) => void;
}) {
  return <div className="agent-inventory-scopes" role="group" aria-label="Inventory scope">
    {agentInventoryScopeOptions.filter(option => option.value !== "all").map(option => <button key={option.value} type="button"
      className="agent-inventory-scope" aria-pressed={value === option.value}
      aria-label={option.label} title={option.description} onClick={() => onChange(option.value)}>
      <span>{option.value === "catalog" ? "Microsoft 365 catalog" : "Power Platform"}{option.value === "power_platform_only" ? <small>Additional</small> : null}</span>
      <strong>{usageCount(scopeCount(inventory, option.value))}</strong>
    </button>)}
  </div>;
}

export function AgentInventoryOverview({ inventory, revision, allSelected, onClearFilters,
  endUserAccess = "all", reportedUsage = "all", onAccessChange, onUsageChange, inventoryScope = "catalog", reportSelector }: {
  inventory?: UnifiedAgentInventoryPage;
  revision: number;
  allSelected?: boolean;
  onClearFilters?: () => void;
  endUserAccess?: UnifiedAgentAccessFilter;
  reportedUsage?: UnifiedAgentUsageFilter;
  onAccessChange?: (value: UnifiedAgentAccessFilter) => void;
  onUsageChange?: (value: UnifiedAgentUsageFilter) => void;
  inventoryScope?: UnifiedAgentInventoryScope;
  reportSelector?: ReactNode;
}) {
  const { data, loading, error, retry } = useOfficialUsageOverview({ scope: "selected", limit: 1 }, revision);
  const hasCatalog = inventory?.sources.graphPackages.state !== undefined && inventory.sources.graphPackages.state !== "unavailable";
  const hasPowerPlatform = inventory?.sources.powerPlatform.state !== undefined && inventory.sources.powerPlatform.state !== "unavailable";
  const hasInventory = inventoryScope === "catalog" ? hasCatalog : inventoryScope === "power_platform_only" ? hasPowerPlatform : hasCatalog || hasPowerPlatform;
  const selectedScope = agentInventoryScopeOptions.find(option => option.value === inventoryScope)!;
  const scopedInventory = inventory?.inventoryScope === inventoryScope ? inventory : undefined;
  const reports = data?.summary.retainedSets ? data.summary : undefined;
  const usageContext = inventory?.usageContext;
  return <section className="agent-inventory-overview" aria-label="Agent inventory overview">
    {inventoryScope !== "catalog" && inventory && !hasCatalog ? <p className="agent-inventory-scope-warning" aria-live="polite">
      The package catalog is unavailable. Catalog matching is incomplete until that source is collected.
    </p> : null}
    <div className="agent-overview-metrics">
      <Metric label={selectedScope.metric} value={scopeCount(inventory, inventoryScope)}
        hint={inventory?.partial ? "Includes unavailable agents · Partial data" : "Includes unavailable agents"}
        selected={allSelected} onClick={onClearFilters} />
      <Metric label="Available to end users" value={hasInventory ? scopedInventory?.inventoryOverview?.availableToUsers ?? null : null}
        hint={inventory?.partial ? "In this view · Partial data" : "All or selected users"}
        selected={endUserAccess === "available"} onClick={onAccessChange ? () => onAccessChange(endUserAccess === "available" ? "all" : "available") : undefined} />
      <Metric label="Reported used agents" value={reports?.usedAgents ?? null}
        hint={reports ? "In selected report set" : "No selected report data"}
        selected={reportedUsage === "used"} onClick={onUsageChange ? () => onUsageChange(reportedUsage === "used" ? "all" : "used") : undefined} />
      <Metric label="Reported active · 30 days" value={reports?.activeAgents30Days ?? null}
        hint={reports && data ? `${usageDate(data.summary.activeSinceDateUtc)} - ${usageDate(data.summary.asOf)} (UTC)` : "No selected report data"} />
      <div className="agent-report-context" title="Usage columns show one imported report, not lifetime totals. Missing values are unavailable, not zero.">
        <span className="agent-context-label">Report context</span>
        {reportSelector ?? <span>{usageContext ? usageCoverageLabel(usageContext.reportSet) : "Selected report set"}</span>}
        {usageContext && usageContext.availability !== "active"
          ? <span role="status">{usageAvailabilityLabel(usageContext.availability)}</span> : null}
      </div>
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
