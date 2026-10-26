import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Search, X } from "lucide-react";
import type { AdoptionGroup, AdoptionPage } from "../../../backend/src/types/adoption";
import { normalizeReportSearch } from "../api/reportData";
import { getAdoptionDescriptionPreview } from "../agentDetails";
import { useReportPage } from "../useReportPage";
import { usageCount } from "../usageInsights";
import type { UsersRouteState } from "../workbenchRouting";
import { ReportPageControls, ReportReadStatus } from "./ReportPageControls";
import { FilterPopover } from "./FilterPopover";
import { ReportFacet } from "./ReportFacet";
import "./adoption.css";

function creatorLabel(value: string | null) {
  const key = value?.trim().toLowerCase();
  if (key === "agent built by microsoft" || key === "microsoft") return "Microsoft";
  if (["agent built by third party", "third-party", "third party", "external"].includes(key ?? "")) return "Third-party";
  if (["user-created agent", "agent built by your org", "your org"].includes(key ?? "")) return "Organization-built";
  return value?.trim() || "Creator unknown";
}

export function AdoptionView({ route, change, revision, reportContext, onOpenAgent, onOpenPerson }: {
  route: UsersRouteState;
  change: (route: UsersRouteState) => void;
  revision: number;
  reportContext: ReactNode;
  onOpenAgent?: (id: string) => void;
  onOpenPerson: (id: string) => void;
}) {
  const search = useRef<HTMLInputElement>(null);
  const searchId = useId();
  const resultsHeading = useRef<HTMLHeadingElement>(null);
  const resultsId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const normalizedSearch = normalizeReportSearch(route.search);
  const [settledSearch, setSettledSearch] = useState(normalizedSearch);
  const searchPending = settledSearch !== normalizedSearch;
  useEffect(() => {
    if (!searchPending) return;
    const timer = window.setTimeout(() => setSettledSearch(normalizedSearch), 300);
    return () => window.clearTimeout(timer);
  }, [normalizedSearch, searchPending]);
  const fields = [{ key: "company", label: "Company" }, { key: "department", label: "Department" }] as const;
  const evidenceFilters = [
    { key: "adoptionChamps", label: "Copilot Champs", with: "With Copilot Champs", without: "Without Copilot Champs" },
    { key: "adoptionAgents", label: "Group agents", with: "With agent usage", without: "Without agent usage" },
  ] as const;
  const chips = [
    ...fields.filter(field => route[field.key] !== undefined).map(field => ({
      key: field.key, label: field.label, value: route[field.key] ?? "Not provided",
    })),
    ...evidenceFilters.filter(field => route[field.key] !== undefined).map(field => ({
      key: field.key, label: field.label, value: route[field.key] === "with" ? field.with : field.without,
    })),
  ];
  const hasFilters = chips.length > 0 || Boolean(route.search.trim());
  function clearFilters() {
    change({ ...route, company: undefined, department: undefined, adoptionChamps: undefined, adoptionAgents: undefined, search: "", page: 0 });
    trigger.current?.focus();
  }
  const read = useReportPage<AdoptionGroup, AdoptionPage>("copilot-usage/adoption", {
    search: normalizedSearch || undefined, setId: route.reportSetId, limit: 5,
    company: route.company, department: route.department, adoptionChamps: route.adoptionChamps, adoptionAgents: route.adoptionAgents,
  }, revision, !searchPending);
  const loading = searchPending || read.loading;
  const data = read.data;
  const agentsAvailable = data?.reports.lineages.some(lineage => lineage.kind === "userAgents");
  function goToPage(page: number) {
    if (!read.goToPage?.(page)) return false;
    resultsHeading.current?.focus({ preventScroll: true });
    resultsHeading.current?.scrollIntoView({ block: "start" });
    return true;
  }
  const navigation = {
    ...read, loading, label: "groups", goToPage,
    previous: () => goToPage((data?.page.number ?? 1) - 1),
    next: () => goToPage((data?.page.number ?? 1) + 1),
  };
  return <div className="adoption-view">
    <div className="agent-overview-metrics" role="group" aria-label="Adoption summary" aria-busy={loading}>
      {([
        ["Groups", data?.counts.filtered, "Company / department"],
        ["People", data?.summary.people, "In matching groups"],
        ["Copilot Champs", data?.summary.champs, "Up to 3 per group"],
        ["Agents used", data?.summary.agents, "Distinct agents with reported responses"],
      ] as const).map(([label, count, hint]) => <div key={label} className="metric"><span>{label}</span>
        <strong>{usageCount(count)}</strong><small>{hint}</small></div>)}
      {reportContext}
    </div>
    <section className="catalog-controls user-activity-controls agent-grid-toolbar" aria-label="Adoption filters">
      <div className="agent-query-bar">
        <div className="agent-search-field agent-search-field-clearable">
          <Search size={17} aria-hidden="true" /><label className="sr-only" htmlFor={searchId}>Search groups</label>
          <input ref={search} id={searchId} type="search" maxLength={256} placeholder="Search company or department"
            value={route.search} onChange={event => change({ ...route, search: event.target.value, page: 0 })} />
          {route.search.length > 0 ? <button type="button" className="agent-search-clear" aria-label="Clear search" title="Clear search" onClick={() => {
            change({ ...route, search: "", page: 0 }); search.current?.focus();
          }}><X size={20} aria-hidden="true" /></button> : null}
        </div>
        <div className="agent-query-summary">
          <span className="agent-match-count" role="status" aria-label="Matching groups" aria-atomic="true">
            <strong>{data ? data.counts.filtered.toLocaleString() : loading ? "Updating..." : "Unavailable"}</strong>{" "}
            <span>{data?.counts.filtered === 1 ? "matching group" : "matching groups"}</span>
          </span>
          {hasFilters ? <button type="button" className="clear-filters-button" onClick={clearFilters}>Clear filters</button> : null}
        </div>
        <FilterPopover label="Filter groups" activeCount={chips.length} triggerRef={trigger}>
          <div className="agent-filter-fields">
            {fields.map(field => <ReportFacet key={field.key} compact alwaysShowSearch path="copilot-usage/adoption" field={field.key}
              selectionId={read.selectedData?.selection.id} value={route[field.key]}
              onChange={value => change({ ...route, [field.key]: value, page: 0 })}
              onRestartSelection={read.restart} onSelectionInvalidated={read.invalidateSelection} />)}
            {evidenceFilters.map(field => <label key={field.key}><span>{field.label}</span>
              <select value={route[field.key] ?? "all"} className={route[field.key] ? "active-filter-select" : undefined}
                onChange={event => {
                  const value = event.target.value;
                  if (value === "all" || value === "with" || value === "without") change({ ...route, [field.key]: value === "all" ? undefined : value, page: 0 });
                }}>
                <option value="all">All groups</option><option value="with">{field.with}</option><option value="without">{field.without}</option>
              </select></label>)}
          </div>
          <footer><button type="button" className="secondary" disabled={!hasFilters} onClick={clearFilters}>Reset filters</button></footer>
        </FilterPopover>
      </div>
      {chips.length ? <div className="agent-filter-chips" aria-label="Active filters">
        {chips.map(chip => <button key={chip.key} type="button" className="agent-filter-chip" aria-label={`Remove ${chip.label.toLowerCase()} filter`}
          title={`${chip.label}: ${chip.value}`} onClick={() => { change({ ...route, [chip.key]: undefined, page: 0 }); trigger.current?.focus(); }}>
          <span>{chip.label}: <strong>{chip.value}</strong></span><X size={13} aria-hidden="true" />
        </button>)}
      </div> : null}
    </section>
    <ReportReadStatus read={{ ...read, loading }} quietLoading />
    {data?.directory.state !== undefined && data.directory.state !== "available"
      ? <p role="status" className="reported-users-note">Group membership uses {data.directory.state} saved directory data. Refresh Users in Sync.</p> : null}
    {data && !agentsAvailable ? <p role="status" className="reported-users-note">Agent usage is unavailable. Add the Users &amp; agents report in Sync. Group agents populate automatically when report data is published.</p> : null}
    {data && data.reports.availability !== "active" ? <p role="status" className="reported-users-note">
      {data.reports.setId ? "Usage is from a stale saved report." : "Usage is unavailable. Import usage reports in Sync."}
    </p> : null}
    <div className="adoption-results-heading">
      <h3 ref={resultsHeading} id={resultsId} tabIndex={-1}>Company &amp; department adoption</h3>
      <p>Explore people, Copilot Champs, and all agents used in each group, including Microsoft and third-party agents.</p>
      <ReportPageControls {...navigation} compact />
    </div>
    <section className="adoption-groups" aria-labelledby={resultsId} aria-busy={loading}>
    {data?.value.map(group => <section className="adoption-group" key={group.id} aria-label={`${group.company} / ${group.department}`}>
      <header><div className="adoption-group-heading"><span>{group.company}</span><h4>{group.department}</h4></div>
        <small>{group.people.length} {group.people.length === 1 ? "user" : "users"} · {agentsAvailable ? group.agents.length : "Unknown"} {agentsAvailable && group.agents.length === 1 ? "agent" : "agents"}</small></header>
      <div className="adoption-group-columns">
        <div className="adoption-people"><h5>People <small>Agents / responses</small></h5>
          <ul>{group.people.map(person => <li key={person.id}>
            <div><button type="button" className="adoption-name" onClick={() => {
              if (read.isCurrentData(true)) onOpenPerson(person.id);
            }}>{person.name}</button>
              {person.champion ? <span className="copilot-user-badge">Copilot Champ</span> : null}</div>
            <span className="adoption-count" title={`${person.agents ?? "Unknown"} agents used with reported responses; ${person.responses === null ? "responses unavailable" : `${person.responses} responses`}`}>
              {usageCount(person.agents)}/{usageCount(person.responses)}
            </span>
          </li>)}</ul>
        </div>
        <div className="adoption-agents"><h5>Agents</h5>
          <ul>{group.agents.map(agent => <li key={agent.id}>
            <div className="adoption-agent-heading">{onOpenAgent && agent.inventoryId ? <button type="button" className="adoption-name" onClick={() => {
              if (read.isCurrentData(true) && agent.inventoryId) onOpenAgent(agent.inventoryId);
            }}>{agent.name}</button> : <strong>{agent.name}</strong>}
              <small title={agent.creatorType ?? undefined}>{creatorLabel(agent.creatorType)}</small></div>
            {!agent.inventoryId ? <small className="adoption-empty">Reported usage only; inventory details unavailable.</small> : null}
            <p aria-label="Saved description preview">{getAdoptionDescriptionPreview(agent.description) || "Description unavailable"}</p>
          </li>)}</ul>
          {!group.agents.length ? <p className="adoption-empty">{agentsAvailable
            ? "No agent usage reported." : "Agent usage data is unavailable."}</p> : null}
        </div>
      </div>
    </section>)}
    {data && !data.value.length ? <p className="reported-users-empty">{data.counts.total
      ? "No groups match your search and filters." : "No saved users to group. Refresh Users in Sync."}</p> : null}
    </section>
    <ReportPageControls {...navigation} />
  </div>;
}
