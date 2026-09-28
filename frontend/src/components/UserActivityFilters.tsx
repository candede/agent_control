import { useRef, type ReactNode, type RefObject } from "react";
import { Search, X } from "lucide-react";
import type { OfficialUsageUserView } from "../api/client";
import { FilterPopover } from "./FilterPopover";

export type UserActivityFilterValues<Cohort extends string = OfficialUsageUserView["filters"]["cohort"]> = {
  company: string;
  department: string;
  cohort: Cohort;
  lowResponseThreshold: string;
};

export function UserActivityFilters<Cohort extends string>({ values, companies, departments, cohorts, defaultCohort,
  cohortLabel = "Agent responses", searchLabel = "Search reported users or agents", search, searchRef, sort, sorts, matchingCount,
  loading, validThreshold, agent, onChange, onSearch, onSort, onClear, onClearAgent, exportButton }: {
  values: UserActivityFilterValues<Cohort>;
  companies: string[];
  departments: string[];
  cohorts: readonly { value: Cohort; label: string }[];
  defaultCohort: Cohort;
  cohortLabel?: string;
  searchLabel?: string;
  search: string;
  searchRef: RefObject<HTMLInputElement | null>;
  sort: string;
  sorts: readonly { value: string; label: string }[];
  matchingCount?: number;
  loading: boolean;
  validThreshold: boolean;
  agent?: string;
  onChange: (values: UserActivityFilterValues<Cohort>) => void;
  onSearch: (value: string) => void;
  onSort: (value: string) => void;
  onClear: () => void;
  onClearAgent?: () => void;
  exportButton?: ReactNode;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const firstField = useRef<HTMLSelectElement>(null);
  const fields = [
    { key: "company", label: "Company", all: "All companies", options: companies },
    { key: "department", label: "Department", all: "All departments", options: departments },
  ] as const;
  const chips: { key: string; label: string; value: string; remove: () => void }[] = fields.filter(field => values[field.key]).map(field => ({
    key: field.key, label: field.label, value: values[field.key],
    remove: () => onChange({ ...values, [field.key]: "" }),
  }));
  if (values.cohort !== defaultCohort) chips.push({
    key: "cohort", label: cohortLabel, value: cohorts.find(item => item.value === values.cohort)!.label,
    remove: () => onChange({ ...values, cohort: defaultCohort }),
  });
  if (values.lowResponseThreshold !== "5") chips.push({
    key: "threshold", label: "Low-response threshold", value: values.lowResponseThreshold,
    remove: () => onChange({ ...values, lowResponseThreshold: "5" }),
  });
  if (agent && onClearAgent) chips.push({ key: "agent", label: "Agent", value: agent, remove: onClearAgent });
  const hasFilters = chips.length > 0 || Boolean(search.trim());

  return <section className="catalog-controls user-activity-controls" aria-label="User filters">
    <div className="agent-query-bar">
      <label className="agent-search-field">
        <Search size={17} aria-hidden="true" /><span className="sr-only">{searchLabel}</span>
        <input ref={searchRef} type="search" maxLength={256} placeholder="Search users or agents" value={search}
          onChange={event => onSearch(event.target.value)} />
      </label>
      <div className="agent-query-summary">
        <span className="agent-match-count" role="status" aria-label="Matching users" aria-atomic="true">
          <strong>{loading ? "Updating..." : matchingCount === undefined ? "Unavailable" : matchingCount.toLocaleString()}</strong>{" "}
          <span>{!loading && matchingCount === 1 ? "matching user" : "matching users"}</span>
        </span>
        {hasFilters ? <button type="button" className="clear-filters-button" onClick={() => {
          onClear(); trigger.current?.focus();
        }}>Clear filters</button> : null}
      </div>
      <FilterPopover label="Filter users" activeCount={chips.length} triggerRef={trigger}>
        <div className="agent-filter-fields">
          {fields.map((field, index) => <label key={field.key}>
            <span>{field.label}</span>
            <select ref={index === 0 ? firstField : undefined} value={values[field.key]}
              className={values[field.key] ? "active-filter-select" : undefined}
              onChange={event => onChange({ ...values, [field.key]: event.target.value })}>
              <option value="">{field.all}</option>
              {values[field.key] && !field.options.includes(values[field.key])
                ? <option value={values[field.key]}>{values[field.key]}</option> : null}
              {field.options.map(value => <option key={value} value={value}>{value}</option>)}
            </select>
          </label>)}
          <label><span>{cohortLabel}</span><select value={values.cohort} className={values.cohort === defaultCohort ? undefined : "active-filter-select"}
            onChange={event => {
              const choice = cohorts.find(item => item.value === event.target.value);
              if (choice) onChange({ ...values, cohort: choice.value });
            }}>{cohorts.map(choice => <option key={choice.value} value={choice.value}>{choice.label}</option>)}</select></label>
          <label><span>Low-response threshold</span><input type="number" min={1} max={100_000_000} step={1}
            value={values.lowResponseThreshold} aria-invalid={!validThreshold}
            onChange={event => onChange({ ...values, lowResponseThreshold: event.target.value })} /></label>
          <label className="agent-sort-control"><span>Sort</span><select value={sort} onChange={event => onSort(event.target.value)}>
            {sorts.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}
          </select></label>
        </div>
        <footer><button type="button" className="secondary" disabled={!hasFilters} onClick={() => {
          onClear(); firstField.current?.focus();
        }}>Reset filters</button></footer>
      </FilterPopover>
      {exportButton}
    </div>
    {!validThreshold ? <p role="alert">Enter a whole-number threshold between 1 and 100,000,000.</p> : null}
    {chips.length ? <div className="agent-filter-chips" aria-label="Active filters">
      {chips.map(chip => <button key={chip.key} type="button" className="agent-filter-chip"
        aria-label={`Remove ${chip.label.toLowerCase()} filter`} title={`${chip.label}: ${chip.value}`}
        onClick={() => { chip.remove(); trigger.current?.focus(); }}>
        <span>{chip.label}: <strong>{chip.value}</strong></span><X size={13} aria-hidden="true" />
      </button>)}
    </div> : null}
  </section>;
}
