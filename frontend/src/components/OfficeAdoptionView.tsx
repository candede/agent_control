import { useEffect, useEffectEvent, useId, useRef, useState } from "react";
import { Search, X } from "lucide-react";
import { officeApps, type OfficeGroup, type OfficePerson, type OfficeQuery } from "../../../backend/src/types/officeAppAdoption";
import { normalizeReportSearch } from "../api/reportData";
import { useOfficeAdoption, useOfficeHistory, useOfficePage, useOfficeSummary, type AcceptedOfficePerson, type OfficeReadOwner } from "../useOfficeAdoption";
import { usersRouteSearch, workbenchUrl, type UsersRouteState } from "../workbenchRouting";
import { usageCount, usageDate } from "../usageInsights";
import { OfficeObservationContext, OfficeObservationNotices } from "./OfficeObservationContext";
import { OfficeFacet } from "./OfficeFacet";
import { OfficeAppBreakdown } from "./OfficeAppBreakdown";
import { OfficePersonDialog } from "./OfficePersonDialog";
import { FilterPopover } from "./FilterPopover";
import { ReportPageControls, ReportReadStatus } from "./ReportPageControls";
import "./adoption.css";
import "./adoptionDashboard.css";

export function OfficeAdoptionView({ route, change, revision }: {
  route: UsersRouteState; change: (next: UsersRouteState, replace?: boolean) => void; revision: number;
}) {
  const query: OfficeQuery = {
    ...(route.officeSnapshot ? { officeSnapshot: route.officeSnapshot } : {}),
    ...(route.officeBaseline ? { officeBaseline: route.officeBaseline } : {}),
    ...(route.company !== undefined ? { company: route.company } : {}),
    ...(route.department !== undefined ? { department: route.department } : {}),
    ...(normalizeReportSearch(route.search) ? { search: normalizeReportSearch(route.search) } : {}),
    ...(route.app ? { app: route.app } : {}),
  };
  const owner = useOfficeAdoption(query, revision, officeNotice => change({ ...route, officeSnapshot: undefined, officeBaseline: undefined,
    detailId: undefined, officeGroup: undefined, page: 0, officeNotice }));
  const summary = useOfficeSummary(owner), history = useOfficeHistory(owner);
  const groups = useOfficePage<OfficeGroup>(owner, "groups", { pageNumber: route.page + 1 });
  const resolvePage = useEffectEvent((page: number) => change({ ...route, page: page - 1 }, true));
  useEffect(() => {
    if (groups.data && !groups.loading && !groups.error && groups.data.page.number !== route.page + 1) resolvePage(groups.data.page.number);
  }, [groups.data, groups.error, groups.loading, route.page]);
  const title = useId(), searchId = useId(), heading = useRef<HTMLHeadingElement>(null);
  const input = useRef<HTMLInputElement>(null), trigger = useRef<HTMLButtonElement>(null);
  const personTrigger = useRef<HTMLElement>(null);
  const [openedPerson, setOpenedPerson] = useState<string>();
  const [acceptedPerson, setAcceptedPerson] = useState<AcceptedOfficePerson>();
  const peopleScope = JSON.stringify([owner.principal, route.officeSnapshot ?? owner.context?.observation?.id,
    route.company, route.department, route.app, route.search]);
  const [peopleNavigation, setPeopleNavigation] = useState<{ scope: string; pages: Record<string, number> }>({ scope: peopleScope, pages: {} });
  const peoplePages = peopleNavigation.scope === peopleScope ? peopleNavigation.pages : {};
  if (peopleNavigation.scope !== peopleScope) setPeopleNavigation({ scope: peopleScope, pages: {} });
  const fields = [{ key: "company", label: "Company" }, { key: "department", label: "Department" }] as const;
  const chips = [
    ...fields.filter(field => route[field.key] !== undefined).map(field => ({ key: field.key, label: field.label, value: route[field.key] ?? "Not provided" })),
    ...(route.app ? [{ key: "app" as const, label: "Office app", value: officeApps.find(app => app.id === route.app)!.label }] : []),
  ];
  const filtered = chips.length > 0 || Boolean(route.search);
  const clear = () => { change({ ...route, company: undefined, department: undefined, app: undefined, search: "", page: 0, detailId: undefined, officeGroup: undefined }); trigger.current?.focus(); };
  const goToPage = (page: number) => {
    if (!groups.isCurrent() || page < 1 || page > (groups.data?.page.pages ?? 1) || page === groups.data?.page.number) return false;
    change({ ...route, page: page - 1 });
    heading.current?.focus({ preventScroll: true }); heading.current?.scrollIntoView?.({ block: "start" });
    return true;
  };
  const navigation = { ...groups, goToPage,
    next: () => goToPage((groups.data?.page.number ?? 1) + 1), previous: () => goToPage((groups.data?.page.number ?? 1) - 1) };
  const data = summary.data;
  const open = (person: OfficePerson) => {
    if (!owner.isCurrent() || !owner.context?.observation) return;
    setOpenedPerson(person.identity);
    setAcceptedPerson({ person, observationId: owner.context.observation.id, principal: owner.principal, query: owner.query });
    change({ ...route, officeSnapshot: owner.context?.observation?.id, detailId: person.identity, officeGroup: person.groupId, detailTab: undefined });
  };
  return <div className="adoption-view office-adoption-view">
    <div className="agent-overview-metrics" role="group" aria-label="Office adoption summary" aria-busy={summary.loading}>
      {([
        ["Groups", data?.context.observation ? data.matchingGroups : undefined, "Matching company / department"],
        ["Enabled paid Copilot users", data?.matching?.savedLicensedPeople, "Complete matching groups at capture"],
        ["Active Office users", data?.matching?.reportedActiveUsers, "Recent Copilot activity reported"],
        ["No recent Office activity reported", data?.matching?.noRecentEvidencePeople, "Not proof of inactivity"],
      ] as const).map(([label, count, hint]) => <div key={label} className="metric"><span>{label}</span>
        <strong>{count == null ? "Unknown" : usageCount(count)}</strong><small>{hint}</small></div>)}
      <OfficeObservationContext owner={owner} history={history.data?.value} route={route} summaryCard
        change={next => change({ ...route, ...next, detailId: undefined, officeGroup: undefined, page: 0 })} />
    </div>
    <OfficeObservationNotices owner={owner} route={route}
      change={next => change({ ...route, ...next, detailId: undefined, officeGroup: undefined, page: 0 })} />
    <ReportReadStatus read={summary} quietLoading />
    <ReportReadStatus read={history} quietLoading />
    <section className="catalog-controls user-activity-controls agent-grid-toolbar" aria-label="Office adoption filters">
      <div className="agent-query-bar"><div className="agent-search-field agent-search-field-clearable">
        <Search size={17} aria-hidden="true" /><label className="sr-only" htmlFor={searchId}>Search groups</label>
        <input ref={input} id={searchId} type="search" maxLength={256} placeholder="Search company or department" value={route.search}
          onChange={event => change({ ...route, search: event.target.value, page: 0 })} />
        {route.search ? <button type="button" className="agent-search-clear" aria-label="Clear search" onClick={() => {
          change({ ...route, search: "", page: 0 }); input.current?.focus();
        }}><X size={20} aria-hidden="true" /></button> : null}
      </div><div className="agent-query-summary"><span role="status" className="agent-match-count">
        <strong>{groups.data?.context.observation ? usageCount(groups.data.counts.filtered) : groups.loading ? "Updating..." : "Unknown"}</strong> matching groups</span>
        {filtered ? <button type="button" className="clear-filters-button" onClick={clear}>Clear filters</button> : null}</div>
      <FilterPopover label="Filter Office groups" activeCount={chips.length} triggerRef={trigger}>
        <div className="agent-filter-fields">{fields.map(field => <OfficeFacet key={field.key} owner={owner} kind={field.key} value={route[field.key]}
          onChange={value => change({ ...route, [field.key]: value, page: 0, detailId: undefined, officeGroup: undefined })} />)}
          <label>Office app<select aria-label="Office app" value={route.app ?? ""} onChange={event => change({
            ...route, app: officeApps.find(app => app.id === event.target.value)?.id, page: 0, detailId: undefined, officeGroup: undefined,
          })}><option value="">All seven apps</option>{officeApps.map(app => <option key={app.id} value={app.id}>{app.label}</option>)}</select></label>
        </div><footer><button type="button" className="secondary" disabled={!filtered} onClick={clear}>Reset filters</button></footer>
      </FilterPopover></div>
      {chips.length ? <div className="agent-filter-chips" aria-label="Active Office filters">{chips.map(chip =>
        <button key={chip.key} type="button" className="agent-filter-chip" aria-label={`Remove ${chip.label.toLowerCase()} filter`}
          onClick={() => { change({ ...route, [chip.key]: undefined, page: 0 }); trigger.current?.focus(); }}>
          <span>{chip.label}: <strong>{chip.value}</strong></span><X size={13} aria-hidden="true" /></button>)}</div> : null}
    </section>
    {route.app ? <p className="dashboard-notice">{data ? usageCount(data.filteredPeople) : "Unknown"} people match {officeApps.find(app => app.id === route.app)!.label}.
      People and suggestions are filtered; saved licensed denominators and all seven group app totals remain complete.</p> : null}
    <ReportReadStatus read={groups} quietLoading />
    <header className="adoption-results-heading"><h3 ref={element => { heading.current = element; if (!personTrigger.current?.isConnected) personTrigger.current = element; }} id={title} tabIndex={-1}>Office adoption groups</h3>
      <p>People and seven-app participation from the same observation. Office Champs are suggestions, not assigned roles.</p>
      <ReportPageControls {...navigation} compact label="groups" /></header>
    <div className="adoption-groups" aria-labelledby={title} aria-busy={groups.loading}>
      {(groups.data?.value ?? []).map(group => <OfficeGroupCard key={group.id} group={group} owner={owner} route={route} open={open}
        personPage={peoplePages[group.id] ?? 1} openedPerson={openedPerson}
        registerPersonTrigger={element => { personTrigger.current = element ?? heading.current; }}
        onPersonPage={page => setPeopleNavigation({ scope: peopleScope, pages: { ...peoplePages, [group.id]: page } })} />)}
    </div>
    {groups.data?.value.length === 0 ? <p className="adoption-empty">{groups.data.context.observation
      ? "No saved licensed groups match this observation and filters."
      : "No measured Office observation yet. Saved sources synchronize automatically; agent reports are not required."}</p> : null}
    <ReportPageControls {...navigation} showPageNumbers label="groups" />
    {route.detailId && owner.context?.observation?.kind==="weekly" ? <p role="alert">
      Individual-person details are not archived in weekly history. Select Latest to explore current people.</p> : null}
    {route.detailId && owner.context?.observation?.kind!=="weekly" ? <OfficePersonDialog owner={owner} identity={route.detailId} groupId={route.officeGroup ?? ""} accepted={acceptedPerson}
      revision={revision} returnFocusTo={personTrigger}
      onClose={() => change({ ...route, detailId: undefined, detailTab: undefined, officeGroup: undefined })} /> : null}
  </div>;
}

function OfficeGroupCard({ group, owner, route, open, personPage, onPersonPage, openedPerson, registerPersonTrigger }: {
  group: OfficeGroup; owner: OfficeReadOwner; route: UsersRouteState; open: (person: OfficePerson) => void;
  personPage: number; onPersonPage: (page: number) => void; openedPerson?: string;
  registerPersonTrigger: (element: HTMLButtonElement | null) => void;
}) {
  const historical = owner.context?.observation?.kind==="weekly";
  const people = useOfficePage<OfficePerson>(owner, "people", { groupId: group.id, limit: 50, pageNumber: personPage, enabled: !historical });
  const move = (page: number, direction?: "next" | "previous") => {
    if (!people.isCurrent() || page < 1 || page > (people.data?.page.pages ?? 1) || page === people.data?.page.number) return false;
    if (!(direction === "next" ? people.next() : direction === "previous" ? people.previous() : people.goToPage(page))) return false;
    onPersonPage(page); return true;
  };
  const label = `${group.company ?? "Company not provided"} / ${group.department ?? "Department not provided"}`;
  return <section className="adoption-group" aria-label={label}>
    <header><div className="adoption-group-heading"><span>{group.company ?? "Company not provided"}</span>
      <h4>{group.department ?? "Department not provided"}</h4></div>
      <small>{usageCount(group.metrics.reportedActiveUsers)} reported active / {usageCount(group.metrics.savedLicensedPeople)} saved licensed</small></header>
    <div className="adoption-group-columns"><div className="adoption-people">
      {historical ? <p className="adoption-empty">Weekly history retains group and app totals only. Current person details are available under Latest.</p> : <>
      <h5>People <small>{usageCount(group.filteredPeople)} {route.app ? "matching app" : "saved licensed"}</small></h5>
      <ReportReadStatus read={people} quietLoading />
      <ul>{(people.data?.value ?? []).map(person => <li key={person.identity}><div className="office-person-identity"><div className="office-person-heading">
        <button ref={person.identity === openedPerson ? registerPersonTrigger : undefined} type="button" className="adoption-name" aria-disabled={!people.isCurrent()} onClick={() => { if (people.isCurrent()) open(person); }}>
          {person.displayName || person.userPrincipalName}</button>
        {group.champions.some(champion => champion.identity === person.identity) ? <span className="copilot-user-badge"
          title="Office Champ suggestion ranked by recent app breadth, then recency across all matching people. Not an assigned role or productivity rank.">Office Champ</span> : null}
      </div><small className="office-person-date" title={person.unknownReasons.length && !person.latestRecentDate
        ? "App activity evidence is incomplete. Unknown evidence does not prove inactivity; open the person for source details." : undefined}>
        {person.latestRecentDate ? `Last reported app use: ${usageDate(person.latestRecentDate)}` : person.unknownReasons.length ? "Unknown evidence" : "No recent evidence"}</small>
      </div><span className="adoption-count">{person.recentApps.length} {person.recentApps.length===1 ? "app" : "apps"}</span></li>)}</ul>
      <ReportPageControls {...people} goToPage={move} next={() => move((people.data?.page.number ?? 1) + 1, "next")}
        previous={() => move((people.data?.page.number ?? 1) - 1, "previous")} compact label="people" />
      </>}
    </div><div className="adoption-agents"><h5>Office apps <small>{usageCount(group.metrics.appsUsed)} of 7 used</small></h5>
      <OfficeAppBreakdown metrics={group.metrics} href={app => workbenchUrl("users", usersRouteSearch({
        ...route, company: group.company, department: group.department, app, page: 0,
        officeSnapshot: owner.context?.observation?.id, detailId: undefined, officeGroup: undefined,
      }))} />
    </div></div>
  </section>;
}
