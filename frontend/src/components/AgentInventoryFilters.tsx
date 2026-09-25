import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { Search, SlidersHorizontal, X } from "lucide-react";
import type { UnifiedAgentInventoryPage } from "../api/client";
import { agentSortOptions, agentViewOptions } from "../agentColumns";
import type { AgentRouteState } from "../workbenchRouting";
import { EnvironmentFilter } from "./EnvironmentFilter";

export type AgentFilterValues = Pick<AgentRouteState,
  "search" | "agentView" | "platform" | "availability" | "host" | "status"
  | "createdWithinDays" | "publisher" | "environmentId" | "sortBy" | "sortDirection">;

type Option = { value: string; label: string };
type Props = {
  values: AgentFilterValues;
  options: {
    platforms: Option[];
    availability: Option[];
    hosts: Option[];
    publishers: Option[];
    environments: UnifiedAgentInventoryPage["facets"]["environments"];
  };
  loading: boolean;
  onChange: (values: Partial<AgentFilterValues>) => void;
  onClear: () => void;
  onError: (message: string) => void;
};

const statusOptions = [
  { value: "all", label: "All states" },
  { value: "allowed", label: "Not blocked" },
  { value: "blocked", label: "Blocked" },
] as const;

export function AgentInventoryFilters({ values, options, loading, onChange, onClear, onError }: Props) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const popover = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const firstField = useRef<HTMLSelectElement>(null);
  const id = useId();
  const fields = [
    { key: "platform", label: "Built with", all: "All platforms", value: values.platform, options: options.platforms,
      change: (value: string) => onChange({ platform: value }) },
    { key: "availability", label: "Assigned access", all: "Any assignment", value: values.availability, options: options.availability,
      change: (value: string) => onChange({ availability: value }) },
    { key: "host", label: "Host", all: "All hosts", value: values.host, options: options.hosts,
      change: (value: string) => onChange({ host: value }) },
    { key: "publisher", label: "Publisher", all: "All publishers", value: values.publisher, options: options.publishers,
      change: (value: string) => onChange({ publisher: value }) },
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
  const hasFilters = chips.length > 0 || Boolean(values.search.trim()) || values.agentView !== "all";

  useLayoutEffect(() => {
    if (!open) return;
    const positionPopover = () => {
      const panel = popover.current;
      const anchor = root.current;
      if (!panel || !anchor) return;
      if (window.innerWidth <= 760 || window.innerHeight <= 640) {
        panel.dataset.side = "below";
        panel.style.removeProperty("--agent-filter-max-height");
        return;
      }
      const bounds = anchor.getBoundingClientRect();
      // Reserve the 10px anchor gap and a 16px viewport inset.
      const below = Math.max(0, window.innerHeight - bounds.bottom - 26);
      const above = Math.max(0, bounds.top - 26);
      const opensAbove = below < 320 && above > below;
      panel.dataset.side = opensAbove ? "above" : "below";
      panel.style.setProperty("--agent-filter-max-height", `${Math.min(560, opensAbove ? above : below)}px`);
    };
    positionPopover();
    window.addEventListener("resize", positionPopover);
    window.addEventListener("scroll", positionPopover, true);
    return () => {
      window.removeEventListener("resize", positionPopover);
      window.removeEventListener("scroll", positionPopover, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    firstField.current?.focus();
    const dismissOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    };
    const dismissEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
      trigger.current?.focus();
    };
    document.addEventListener("pointerdown", dismissOutside);
    document.addEventListener("keydown", dismissEscape);
    return () => {
      document.removeEventListener("pointerdown", dismissOutside);
      document.removeEventListener("keydown", dismissEscape);
    };
  }, [open]);

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
        <select value={values.agentView} title={agentViewOptions.find(option => option.value === values.agentView)?.description}
          className={values.agentView === "all" ? undefined : "active-filter-select"}
          onChange={event => {
            const option = agentViewOptions.find(item => item.value === event.target.value);
            if (!option) {
              onError("Choose a supported agent view.");
              return;
            }
            onChange({ agentView: option.value });
          }}>
          {agentViewOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
      </label>
      <div className="agent-filter-picker" ref={root} onBlur={event => {
        if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}>
        <button ref={trigger} type="button" className="secondary agent-filter-trigger"
          aria-label={chips.length ? `Filters, ${chips.length} active` : "Filters"}
          title="Filter agents and choose sort order"
          aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined}
          onClick={() => setOpen(value => !value)}>
          <SlidersHorizontal size={16} aria-hidden="true" /> Filters
          {chips.length ? <span className="filter-count" aria-hidden="true">{chips.length}</span> : null}
        </button>
        {open ? <div ref={popover} id={id} className="agent-filter-popover" role="dialog" aria-label="Filter agents">
          <header>
            <div><strong>Filter agents</strong><p>Refine this inventory. Changes apply immediately.</p></div>
            <button type="button" className="secondary icon-button" aria-label="Close filters" onClick={() => {
              setOpen(false);
              trigger.current?.focus();
            }}><X size={18} aria-hidden="true" /></button>
          </header>
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
            <span>You can also sort using column headings.</span>
            <button type="button" className="secondary" disabled={!hasFilters} onClick={() => {
              onClear();
              firstField.current?.focus();
            }}>Reset filters</button>
          </footer>
        </div> : null}
      </div>
    </div>
    {hasFilters ? <div className="agent-filter-chips" aria-label="Active filters">
      {chips.map(chip => <button key={chip.key} type="button" className="agent-filter-chip"
        aria-label={`Remove ${chip.label.toLowerCase()} filter`} title={`${chip.label}: ${chip.value}`}
        onClick={() => {
          chip.remove();
          trigger.current?.focus();
        }}>
        <span>{chip.label}: <strong>{chip.value}</strong></span><X size={13} aria-hidden="true" />
      </button>)}
      <button type="button" className="clear-filters-button" onClick={() => {
        onClear();
        trigger.current?.focus();
      }}>Clear filters</button>
    </div> : null}
  </section>;
}
