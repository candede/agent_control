import { useEffect, useRef, useState } from "react";
import { Search, X } from "lucide-react";
import { agentAccessOptions, agentManagementOptions, agentRelevanceOptions, agentSortOptions, agentUsageOptions } from "../agentColumns";
import type { AgentRouteState } from "../workbenchRouting";
import { FilterPopover } from "./FilterPopover";
import { InventoryFacetSelect } from "./InventoryFacetSelect";
import { ApiError, getInventoryFacets, type InventoryFacetField } from "../api/client";
import { encodeInventoryFacet, inventoryFacetLabel, type InventoryFacetValue } from "../../../backend/src/types/inventoryFacets";
import { formatPackageType } from "../../../backend/src/types/copilotPackage";

export type AgentFilterValues = Pick<AgentRouteState,
  "search" | "packageType" | "endUserAccess" | "reportedUsage" | "management" | "relevance" | "platform" | "availability" | "host" | "status"
  | "createdWithinDays" | "publisher" | "environmentId" | "sortBy" | "sortDirection">;

type Option = { value: InventoryFacetValue; label: string };
type Props = {
  selectionId?: string;
  readOwnerKey?: string;
  values: AgentFilterValues;
  options: {
    types: Option[];
    platforms: Option[];
    availability: Option[];
    hosts: Option[];
    publishers: Option[];
    environments: Option[];
  };
  loading: boolean;
  matchingCount?: number;
  onChange: (values: Partial<AgentFilterValues>) => void;
  onClear: () => void;
  onError: (message: string) => void;
  onInvalidated?: () => void;
};

const statusOptions = [
  { value: "all", label: "All states" },
  { value: "allowed", label: "Not blocked" },
  { value: "blocked", label: "Blocked" },
] as const;

export function AgentInventoryFilters({ values, options, loading, matchingCount, selectionId, readOwnerKey, onChange, onClear, onError, onInvalidated }: Props) {
  const trigger = useRef<HTMLButtonElement>(null);
  const firstField = useRef<HTMLSelectElement>(null);
  const [environmentLabel, setEnvironmentLabel] = useState<{ key: string; label: string }>();
  const callbacks = useRef({ onError, onInvalidated });
  useEffect(() => { callbacks.current = { onError, onInvalidated }; }, [onError, onInvalidated]);
  useEffect(() => {
    if (!selectionId || values.environmentId === undefined) return;
    const controller = new AbortController(), key = encodeInventoryFacet(values.environmentId);
    void getInventoryFacets(selectionId, "environmentId", { selected: true }, { signal: controller.signal }).then(page => {
      if (controller.signal.aborted) return;
      const option = page.value.find(option => encodeInventoryFacet(option.value) === key);
      if (option) setEnvironmentLabel({ key, label: option.label || inventoryFacetLabel(option.value) });
    }).catch(error => {
      if (controller.signal.aborted) return;
      if (error instanceof ApiError && ["selection_invalidated", "selection_expired", "unauthorized", "forbidden"].includes(error.code)) {
        callbacks.current.onInvalidated?.();
      } else callbacks.current.onError(error instanceof Error ? error.message : "Selected environment label unavailable.");
    });
    return () => controller.abort();
  }, [selectionId, values.environmentId]);
  function changeChoice<T extends string>(value: InventoryFacetValue | undefined, choices: readonly { value: T }[], change: (value: T) => void) {
    const choice = choices.find(option => option.value === value);
    if (!choice) {
      onError("Choose a supported agent filter.");
      return;
    }
    change(choice.value);
  }
  function changeLiteral(key: "platform" | "host" | "publisher" | "environmentId" | "packageType", value: InventoryFacetValue | undefined) {
    if (value !== null && typeof value === "object") { onError("Choose a supported agent filter."); return; }
    onChange({ [key]: value });
  }
  const fields = [
    { key: "platform", dynamic: true, label: "Built with", all: "All platforms", value: values.platform, options: options.platforms,
      change: (value: InventoryFacetValue | undefined) => changeLiteral("platform", value) },
    { key: "endUserAccess", label: "End-user access", all: agentAccessOptions[0].label, value: values.endUserAccess, options: agentAccessOptions.slice(1),
      change: (value: InventoryFacetValue | undefined) => changeChoice(value, agentAccessOptions, endUserAccess => onChange({ endUserAccess })) },
    { key: "reportedUsage", label: "Reported usage", all: agentUsageOptions[0].label, value: values.reportedUsage, options: agentUsageOptions.slice(1),
      change: (value: InventoryFacetValue | undefined) => changeChoice(value, agentUsageOptions, reportedUsage => onChange({ reportedUsage })) },
    { key: "management", label: "Management", all: agentManagementOptions[0].label, value: values.management, options: agentManagementOptions.slice(1),
      change: (value: InventoryFacetValue | undefined) => changeChoice(value, agentManagementOptions, management => onChange({ management })) },
    { key: "availability", dynamic: true, label: "Assigned access", all: "Any assignment", value: values.availability, options: options.availability,
      change: (value: InventoryFacetValue | undefined) => onChange({ availability: value }) },
    { key: "host", dynamic: true, label: "Host", all: "All hosts", value: values.host, options: options.hosts,
      change: (value: InventoryFacetValue | undefined) => changeLiteral("host", value) },
    { key: "publisher", dynamic: true, label: "Publisher", all: "All publishers", value: values.publisher, options: options.publishers,
      change: (value: InventoryFacetValue | undefined) => changeLiteral("publisher", value) },
    { key: "relevance", label: "Organization/usage evidence", all: agentRelevanceOptions[0].label, value: values.relevance, options: agentRelevanceOptions.slice(1),
      change: (value: InventoryFacetValue | undefined) => changeChoice(value, agentRelevanceOptions, relevance => onChange({ relevance })) },
  ];
  const chips = fields.filter(field => field.dynamic ? field.value !== undefined : field.value !== "all").map(field => ({
    key: field.key, label: field.label,
    value: field.options.find(option => option.value === field.value)?.label ?? (field.value === undefined ? "" : inventoryFacetLabel(field.value)),
    remove: () => field.change(field.dynamic ? undefined : "all"),
  }));
  if (values.status !== "all") chips.push({
    key: "status", label: "Package status",
    value: statusOptions.find(option => option.value === values.status)!.label,
    remove: () => onChange({ status: "all" }),
  });
  if (values.createdWithinDays) chips.push({
    key: "created", label: "Created within", value: `${values.createdWithinDays} days`,
    remove: () => onChange({ createdWithinDays: "" }),
  });
  if (values.environmentId !== undefined) chips.push({
    key: "environment", label: "Environment",
    value: environmentLabel?.key === encodeInventoryFacet(values.environmentId) ? environmentLabel.label
      : options.environments.find(option => typeof option.value === "string" && typeof values.environmentId === "string"
      && option.value.toLowerCase() === values.environmentId.toLowerCase())?.label ?? inventoryFacetLabel(values.environmentId),
    remove: () => onChange({ environmentId: undefined }),
  });
  const hasFilters = chips.length > 0 || Boolean(values.search.trim()) || values.packageType !== undefined;

  return <section className="catalog-controls" aria-label="Filters">
    <div className="agent-query-bar">
      <label className="agent-search-field">
        <Search size={17} aria-hidden="true" />
        <span className="sr-only">Search</span>
        <input type="search" value={values.search} placeholder="Search agents by name, publisher or ID"
          onChange={event => onChange({ search: event.target.value })} />
      </label>
      {selectionId ? <InventoryFacetSelect key="type" selectionId={selectionId} scopeKey={readOwnerKey} compact field="type" loading={loading} onInvalidated={onInvalidated} onError={onError}
        label="Show agents" allLabel="All agents" value={values.packageType}
        onChange={type => changeLiteral("packageType", type)} /> : <label className="agent-view-control">
        <span className="sr-only">Show agents</span>
        <select disabled value={values.packageType === undefined ? "" : encodeInventoryFacet(values.packageType)} title="Load a current inventory selection to choose a package type.">
          <option value="">All agents</option>
          {values.packageType !== undefined ? <option value={encodeInventoryFacet(values.packageType)}>
            {typeof values.packageType === "string" ? formatPackageType(values.packageType) : inventoryFacetLabel(values.packageType)}</option> : null}
        </select>
      </label>}
      <div className="agent-query-summary">
        <span className="agent-match-count" role="status" aria-label="Matching agents" aria-atomic="true">
          <strong>{loading ? "Updating..." : matchingCount === undefined ? "Unavailable" : matchingCount.toLocaleString()}</strong>{" "}
          <span>{!loading && matchingCount === 1 ? "matching agent" : "matching agents"}</span>
        </span>
        {hasFilters ? <button type="button" className="clear-filters-button" onClick={() => {
          onClear();
          trigger.current?.focus();
        }}>Clear filters</button> : null}
      </div>
      <FilterPopover label="Filter agents" activeCount={chips.length} triggerRef={trigger}
        description="Refine this inventory. Changes apply immediately.">
          <div className="agent-filter-fields">
            {fields.map((field, index) => selectionId && ["platform", "availability", "host", "publisher"].includes(field.key)
              ? <InventoryFacetSelect key={field.key} selectionId={selectionId} scopeKey={readOwnerKey} loading={loading} onInvalidated={onInvalidated} onError={onError}
                selectRef={index === 0 ? firstField : undefined}
                field={(field.key === "availability" ? "availableTo" : field.key) as InventoryFacetField}
                value={field.value} label={field.label} allLabel={field.all} onChange={field.change} />
              : <label key={field.key}>
              <span>{field.label}</span>
              <select ref={index === 0 ? firstField : undefined} value={field.dynamic
                ? field.value === undefined ? "" : encodeInventoryFacet(field.value) : String(field.value)}
                disabled={["platform", "availability", "host", "publisher"].includes(field.key)}
                className={(field.dynamic ? field.value === undefined : field.value === "all") ? undefined : "active-filter-select"}
                onChange={event => field.change(event.target.value)}>
                <option value={field.dynamic ? "" : "all"}>{field.all}</option>
                {field.options.map(option => <option key={encodeInventoryFacet(option.value)}
                  value={field.dynamic ? encodeInventoryFacet(option.value) : String(option.value)}>{option.label}</option>)}
              </select>
            </label>)}
            <label>
              <span>Package status</span>
              <select value={values.status} className={values.status === "all" ? undefined : "active-filter-select"}
                onChange={event => {
                  const option = statusOptions.find(item => item.value === event.target.value);
                  if (!option) {
                    onError("Choose a supported package status.");
                    return;
                  }
                  onChange({ status: option.value });
                }}>
                {statusOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            </label>
            <label>
              <span>Created within</span>
              <div className="number-with-unit">
                <input type="number" min="1" max="3650" value={values.createdWithinDays} placeholder="Any"
                  onChange={event => onChange({ createdWithinDays: event.target.value })} />
                <span>days</span>
              </div>
            </label>
            {selectionId ? <InventoryFacetSelect key="environmentId" selectionId={selectionId} scopeKey={readOwnerKey} field="environmentId" loading={loading} onInvalidated={onInvalidated} onError={onError}
              label="Environment" allLabel="All environments" value={values.environmentId}
              onOptionLabel={(value, label) => setEnvironmentLabel(current => {
                const key = encodeInventoryFacet(value);
                const display = label || inventoryFacetLabel(value);
                return current?.key === key && current.label === display ? current : { key, label: display };
              })}
              onChange={environmentId => changeLiteral("environmentId", environmentId)} />
              : <label><span>Environment</span><select disabled value={values.environmentId === undefined ? "" : encodeInventoryFacet(values.environmentId)}>
                <option value="">All environments</option>
                {values.environmentId !== undefined ? <option value={encodeInventoryFacet(values.environmentId)}>{inventoryFacetLabel(values.environmentId)}</option> : null}
              </select></label>}
            <label className="agent-sort-control">
              <span>Sort</span>
              <select value={`${values.sortBy}:${values.sortDirection}`} onChange={event => {
                const option = agentSortOptions.find(item => item.value === event.target.value);
                if (!option) {
                  onError("Choose a supported agent sort order.");
                  return;
                }
                onChange({ sortBy: option.sortBy, sortDirection: option.direction });
              }}>
                {agentSortOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            </label>
          </div>
          <footer>
            <span>Filters combine with the Graph package type. Missing management evidence stays unknown.</span>
            <button type="button" className="secondary" disabled={!hasFilters} onClick={() => {
              onClear();
              firstField.current?.focus();
            }}>Reset filters</button>
          </footer>
      </FilterPopover>
    </div>
    {values.management !== "all"
      ? <p className="notice" role="note">Management views show confirmed evidence only. Sharing, installation or missing data alone does not establish who manages an agent.</p> : null}
    {chips.length ? <div className="agent-filter-chips" aria-label="Active filters">
      {chips.map(chip => <button key={chip.key} type="button" className="agent-filter-chip"
        aria-label={`Remove ${chip.label.toLowerCase()} filter`} title={`${chip.label}: ${chip.value}`}
        onClick={() => {
          chip.remove();
          trigger.current?.focus();
        }}>
        <span>{chip.label}: <strong>{chip.value}</strong></span><X size={13} aria-hidden="true" />
      </button>)}
    </div> : null}
  </section>;
}
