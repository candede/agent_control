import type { ReactNode } from "react";
import type { UnifiedAgentInventoryPage } from "../api/client";
import type { UnifiedAgentAccessFilter, UnifiedAgentInventoryScope, UnifiedAgentUsageFilter } from "../../../backend/src/types/unifiedAgents";
import { agentInventoryScopeOptions, inventoryScopeAgentCount } from "../agentColumns";
import { useOfficialUsageOverview } from "../useOfficialUsageOverview";
import { usageAvailabilityLabel, usageCount, usageCoverageLabel, usageDate } from "../usageInsights";
import "./workspaceSkeleton.css";

function scopeCount(inventory: UnifiedAgentInventoryPage | undefined, scope: UnifiedAgentInventoryScope) {
  const hasCatalog = inventory?.sources.graphPackages.state !== undefined && inventory.sources.graphPackages.state !== "unavailable";
  const hasPowerPlatform = inventory?.sources.powerPlatform.state !== undefined && inventory.sources.powerPlatform.state !== "unavailable";
  return inventory && (scope === "catalog" ? hasCatalog : scope === "power_platform_only" ? hasPowerPlatform : hasCatalog || hasPowerPlatform)
    ? inventoryScopeAgentCount(inventory.summary, scope) : null;
}

export function AgentInventoryScopes({ inventory, value, onChange, loading = false }: {
  inventory?: UnifiedAgentInventoryPage;
  loading?: boolean;
  value: UnifiedAgentInventoryScope;
  onChange: (scope: UnifiedAgentInventoryScope) => void;
}) {
  return <div className="agent-inventory-scopes" role="group" aria-label="Inventory scope">
    {agentInventoryScopeOptions.filter(option => option.value !== "all").map(option => <button key={option.value} type="button"
      className="agent-inventory-scope" aria-pressed={value === option.value}
      aria-label={option.label} title={option.description} onClick={() => onChange(option.value)}>
      <span>{option.value === "catalog" ? "Microsoft 365 catalog" : "Power Platform"}{option.value === "power_platform_only" ? <small>Additional</small> : null}</span>
      <strong>{loading && !inventory ? <span className="skeleton-block skeleton-count" aria-label="Loading count" /> : usageCount(scopeCount(inventory, option.value))}</strong>
    </button>)}
  </div>;
}

export function AgentInventoryOverview({ inventory, revision, allSelected, onClearFilters,
  endUserAccess = "all", reportedUsage = "all", onAccessChange, onUsageChange, inventoryScope = "catalog", reportSelector, loadingInventory = false }: {
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
  loadingInventory?: boolean;
}) {
  const usageContext = inventory?.usageContext;
  const { data, loading, error, retry, invalidated, restart } = useOfficialUsageOverview({
    scope: "selected", setId: usageContext?.reports.setId ?? undefined, limit: 1,
  }, revision, Boolean(inventory));
  const hasCatalog = inventory?.sources.graphPackages.state !== undefined && inventory.sources.graphPackages.state !== "unavailable";
  const hasPowerPlatform = inventory?.sources.powerPlatform.state !== undefined && inventory.sources.powerPlatform.state !== "unavailable";
  const hasInventory = inventoryScope === "catalog" ? hasCatalog : inventoryScope === "power_platform_only" ? hasPowerPlatform : hasCatalog || hasPowerPlatform;
  const selectedScope = agentInventoryScopeOptions.find(option => option.value === inventoryScope)!;
  const scopedInventory = inventory?.inventoryScope === inventoryScope ? inventory : undefined;
  const reports = data?.reports.setId && data.analytics.overview && data.analytics.overview.retainedSets > 0
    && (!usageContext || data.reports.setId === usageContext.reports.setId) ? data.analytics.overview : null;
  return <section className="agent-inventory-overview" aria-label="Agent inventory overview">
    {inventoryScope !== "catalog" && inventory && !hasCatalog ? <p className="agent-inventory-scope-warning" aria-live="polite">
      The package catalog is unavailable. Catalog matching is incomplete until that source is collected.
    </p> : null}
    <div className="agent-overview-metrics">
      <Metric label={selectedScope.metric} value={scopeCount(inventory, inventoryScope)}
        loading={loadingInventory && !inventory}
        hint={inventory?.partial ? "Includes unavailable agents · Partial data" : "Includes unavailable agents"}
        selected={allSelected} onClick={onClearFilters} />
      <Metric label="Available to end users" value={hasInventory ? scopedInventory?.inventoryOverview?.availableToUsers ?? null : null}
        loading={loadingInventory && !scopedInventory}
        hint={inventory?.partial ? "In this view · Partial data" : "All or selected users"}
        selected={endUserAccess === "available"} onClick={onAccessChange ? () => onAccessChange(endUserAccess === "available" ? "all" : "available") : undefined} />
      <Metric label="Reported used agents" value={reports?.usedAgents ?? null}
        loading={loading && !data || loadingInventory && !inventory}
        hint={reports ? "In selected report set" : "No selected report data"}
        selected={reportedUsage === "used"} onClick={onUsageChange ? () => onUsageChange(reportedUsage === "used" ? "all" : "used") : undefined} />
      <Metric label="Reported active · 30 days" value={reports?.active30Days ?? null}
        loading={loading && !data || loadingInventory && !inventory}
        hint={reports ? `${usageDate(reports.activeSinceDateUtc)} - ${usageDate(reports.asOf)} (UTC)` : "No selected report data"} />
      <div className="agent-report-context" title="Usage columns show one imported report, not lifetime totals. Missing values are unavailable, not zero.">
        <span className="agent-context-label">Report context</span>
        {reportSelector ?? <span>{usageContext ? usageCoverageLabel(usageContext.reports) : "Selected report set"}</span>}
        {usageContext && usageContext.reports.availability !== "active"
          ? <span role="status">{usageAvailabilityLabel(usageContext.reports.availability)}</span> : null}
      </div>
    </div>
    {loading ? <p className="sr-only" role="status">Loading selected report evidence...</p> : null}
    {error ? <p className="error-banner" role="alert">{error.message} <button className="secondary" type="button" onClick={invalidated ? restart : retry}>{invalidated ? "Restart selection" : "Retry activity evidence"}</button></p> : null}
  </section>;
}

function Metric({ label, value, hint, selected, onClick, loading = false }: {
  label: string; value: number | null; hint: string; selected?: boolean; onClick?: () => void; loading?: boolean;
}) {
  const content = <><span title={label}>{label}</span><strong>{loading
    ? <span className="skeleton-block skeleton-count" aria-label="Loading count" /> : usageCount(value)}</strong><small title={hint}>{hint}</small></>;
  return onClick
    ? <button type="button" className="metric agent-overview-filter" aria-label={`Show ${label.toLowerCase()}`}
      aria-pressed={selected} disabled={value === null} onClick={onClick}>{content}</button>
    : <div className="metric">{content}</div>;
}
