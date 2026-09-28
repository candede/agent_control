import { useRef } from "react";
import { Search, X } from "lucide-react";
import type { UnifiedAgentInventoryPage } from "../api/client";
import { agentAccessOptions, agentManagementOptions, agentRelevanceOptions, agentSortOptions, agentUsageOptions } from "../agentColumns";
import type { AgentRouteState } from "../workbenchRouting";
import { EnvironmentFilter } from "./EnvironmentFilter";
import { FilterPopover } from "./FilterPopover";

export type AgentFilterValues = Pick<AgentRouteState,
  "search" | "packageType" | "endUserAccess" | "reportedUsage" | "management" | "relevance" | "platform" | "availability" | "host" | "status"
  | "createdWithinDays" | "publisher" | "environmentId" | "sortBy" | "sortDirection">;

type Option = { value: string; label: string };
type Props = {
  values: AgentFilterValues;
  options: {
    types: Option[];
    platforms: Option[];
    availability: Option[];
    hosts: Option[];
    publishers: Option[];
    environments: UnifiedAgentInventoryPage["facets"]["environments"];
  };
  loading: boolean;
  matchingCount?: number;
  onChange: (values: Partial<AgentFilterValues>) => void;
  onClear: () => void;
  onError: (message: string) => void;
};

const statusOptions = [
  { value: "all", label: "All states" },
  { value: "allowed", label: "Not blocked" },
  { value: "blocked", label: "Blocked" },
] as const;

export function AgentInventoryFilters({ values, options, loading, matchingCount, onChange, onClear, onError }: Props) {
  const trigger = useRef<HTMLButtonElement>(null);
  const firstField = useRef<HTMLSelectElement>(null);
  function changeChoice<T extends string>(value: string, choices: readonly { value: T }[], change: (value: T) => void) {
    const choice = choices.find(option => option.value === value);
    if (!choice) {
      onError("Choose a supported agent filter.");
      return;
    }
    change(choice.value);
  }
  const fields = [
    { key: "platform", label: "Built with", all: "All platforms", value: values.platform, options: options.platforms,
      change: (value: string) => onChange({ platform: value }) },
    { key: "endUserAccess", label: "End-user access", all: agentAccessOptions[0].label, value: values.endUserAccess, options: agentAccessOptions.slice(1),
      change: (value: string) => changeChoice(value, agentAccessOptions, endUserAccess => onChange({ endUserAccess })) },
    { key: "reportedUsage", label: "Reported usage", all: agentUsageOptions[0].label, value: values.reportedUsage, options: agentUsageOptions.slice(1),
      change: (value: string) => changeChoice(value, agentUsageOptions, reportedUsage => onChange({ reportedUsage })) },
    { key: "management", label: "Management", all: agentManagementOptions[0].label, value: values.management, options: agentManagementOptions.slice(1),
      change: (value: string) => changeChoice(value, agentManagementOptions, management => onChange({ management })) },
    { key: "availability", label: "Assigned access", all: "Any assignment", value: values.availability, options: options.availability,
      change: (value: string) => onChange({ availability: value }) },
    { key: "host", label: "Host", all: "All hosts", value: values.host, options: options.hosts,
      change: (value: string) => onChange({ host: value }) },
    { key: "publisher", label: "Publisher", all: "All publishers", value: values.publisher, options: options.publishers,
      change: (value: string) => onChange({ publisher: value }) },
    { key: "relevance", label: "Organization/usage evidence", all: agentRelevanceOptions[0].label, value: values.relevance, options: agentRelevanceOptions.slice(1),
      change: (value: string) => changeChoice(value, agentRelevanceOptions, relevance => onChange({ relevance })) },
  ];
  const chips = fields.filter(field => field.value !== "all").map(field => ({
    key: field.key, label: field.label,
    value: field.options.find(option => option.value === field.value)?.label ?? field.value,
    remove: () => field.change("all"),
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
  if (values.environmentId) chips.push({
    key: "environment", label: "Environment",
    value: options.environments.find(option => option.value.toLowerCase() === values.environmentId.toLowerCase())?.label ?? values.environmentId,
    remove: () => onChange({ environmentId: "" }),
  });
  const hasFilters = chips.length > 0 || Boolean(values.search.trim()) || Boolean(values.packageType);

  return <section className="catalog-controls" aria-label="Filters">
    <div className="agent-query-bar">
      <label className="agent-search-field">
        <Search size={17} aria-hidden="true" />
        <span className="sr-only">Search</span>
        <input type="search" value={values.search} placeholder="Search agents by name, publisher or ID"
          onChange={event => onChange({ search: event.target.value })} />
      </label>
      <label className="agent-view-control">
        <span className="sr-only">Show agents</span>
        <select value={values.packageType} title={values.packageType ? `Graph package type: ${values.packageType}` : "Filter by the type returned by the Graph package catalog."}
          className={values.packageType ? "active-filter-select" : undefined}
          onChange={event => {
            const type = event.target.value;
            if (event.target.selectedIndex < 0 || type && !options.types.some(item => item.value === type) && type !== values.packageType) {
              onError("Choose a package type from the saved catalog.");
              return;
            }
            onChange({ packageType: type });
          }}>
          <option value="">All agents</option>
          {values.packageType && !options.types.some(option => option.value === values.packageType)
            ? <option value={values.packageType}>Not in saved catalog: {values.packageType}</option> : null}
          {options.types.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
      </label>
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
            {fields.map((field, index) => <label key={field.key}>
              <span>{field.label}</span>
              <select ref={index === 0 ? firstField : undefined} value={field.value}
                className={field.value === "all" ? undefined : "active-filter-select"}
                onChange={event => field.change(event.target.value)}>
                <option value="all">{field.all}</option>
                {field.options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
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
            <EnvironmentFilter options={options.environments} value={values.environmentId}
              loading={loading} onChange={environmentId => onChange({ environmentId })} />
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
