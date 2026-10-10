import { useId, useRef, type ReactNode } from "react";
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
  const trigger = useRef<HTMLButtonElement>(null);
  const fields = [{ key: "company", label: "Company" }, { key: "department", label: "Department" }] as const;
  const evidenceFilters = [
    { key: "adoptionChamps", label: "Copilot Champs", with: "With Copilot Champs", without: "Without Copilot Champs" },
    { key: "adoptionAgents", label: "Group agents", with: "With organization-built agents", without: "Without organization-built agents" },
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
    search: normalizeReportSearch(route.search) || undefined, setId: route.reportSetId, limit: 5,
    company: route.company, department: route.department, adoptionChamps: route.adoptionChamps, adoptionAgents: route.adoptionAgents,
  }, revision);
  const data = read.data;
  return <div className="adoption-view">
    <div className="agent-overview-metrics" role="group" aria-label="Adoption summary" aria-busy={read.loading}>
      {([
        ["Groups", data?.counts.filtered, "Company / department"],
        ["People", data?.summary.people, "In matching groups"],
        ["Copilot Champs", data?.summary.champs, "Up to 3 per group"],
        ["Organization agents", data?.summary.agents, "Distinct created or used agents"],
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
            <strong>{read.loading ? "Updating..." : data ? data.counts.filtered.toLocaleString() : "Unavailable"}</strong>{" "}
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
    <ReportReadStatus read={read} quietLoading />
    {data?.directory.state !== undefined && data.directory.state !== "available"
      ? <p role="status" className="reported-users-note">Group membership uses {data.directory.state} saved directory data. Refresh Users in Sync.</p> : null}
    {data && !data.inventoryAvailable ? <p role="status" className="reported-users-note">Agent inventory is unavailable. Refresh Agents in Sync to populate group agents.</p> : null}
    {data && data.reports.availability !== "active" ? <p role="status" className="reported-users-note">
      {data.reports.setId ? "Usage is from a stale saved report." : "Usage is unavailable. Import usage reports in Sync."}
    </p> : null}
    {data?.value.map(group => <section className="adoption-group" key={group.id} aria-label={`${group.company} / ${group.department}`}>
      <header><h3>{group.company} <span>/</span> {group.department}</h3>
        <small>{group.people.length} {group.people.length === 1 ? "user" : "users"} · {group.agents.length} {group.agents.length === 1 ? "agent" : "agents"}</small></header>
      <div className="adoption-group-columns">
        <div className="adoption-people"><h4>People <small>Agents / responses</small></h4>
          <ul>{group.people.map(person => <li key={person.id}>
            <div><button type="button" className="adoption-name" onClick={() => {
              if (read.isCurrentData(true)) onOpenPerson(person.id);
            }}>{person.name}</button>
              {person.champion ? <span className="copilot-user-badge">Copilot Champ</span> : null}</div>
            <span className="adoption-count" title={`${person.agents} agents created or used; ${person.responses === null ? "responses unavailable" : `${person.responses} responses`}`}>
              {usageCount(person.agents)}/{usageCount(person.responses)}
            </span>
          </li>)}</ul>
        </div>
        <div className="adoption-agents"><h4>Agents</h4>
          <ul>{group.agents.map(agent => <li key={agent.id}>
            <div className="adoption-agent-heading">{onOpenAgent ? <button type="button" className="adoption-name" onClick={() => {
              if (read.isCurrentData(true)) onOpenAgent(agent.id);
            }}>{agent.name}</button> : <strong>{agent.name}</strong>}
              {agent.type ? <small>{agent.type.replace("Microsoft 365 Copilot Agent Builder", "Agent Builder")}</small> : null}</div>
            <p>{getAdoptionDescriptionPreview(agent.description) || "Description unavailable"}</p>
          </li>)}</ul>
          {!group.agents.length ? <p className="adoption-empty">No organization-built agents found.</p> : null}
        </div>
      </div>
    </section>)}
    {data && !data.value.length ? <p className="reported-users-empty">{data.counts.total
      ? "No groups match your search and filters." : "No saved users to group. Refresh Users in Sync."}</p> : null}
    <ReportPageControls {...read} label="groups" />
  </div>;
}
