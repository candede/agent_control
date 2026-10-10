import { useContext, useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { CombinedUser, ReportQuery, UnresolvedReportIdentity } from "../../../backend/src/types/officialReportData";
import { CapabilityContext } from "../capabilityContext";
import { hasRole } from "../authorization";
import { normalizeReportSearch } from "../api/reportData";
import { useReportPage, useReportPrincipalScope } from "../useReportPage";
import { withdrawsSelectedRead } from "../selectedRead";
import type { UsersRouteState } from "../workbenchRouting";
import { usageCount, isValidLowResponseThreshold, usageDate } from "../usageInsights";
import { ReportReadStatus, ReportPageControls } from "./ReportPageControls";
import { UserActivityFilters } from "./UserActivityFilters";
import { ReportSortHeading } from "./ReportSortHeading";
import { ReportExportButton } from "./ReportExportButton";
import { ReportedUserActivity } from "./ReportedUserActivity";
import { UserDetailModal } from "./UserDetailModal";
import { UsageReportContext } from "./UsageReportContext";
import { WorkspaceSkeleton } from "./WorkspaceSkeleton";
import { useUserSourceFailure, useUserSourceProgress } from "../publicationContext";
import { AdoptionView } from "./AdoptionView";
import "./copilotUsers.css";
import "./reportedUsers.css";

type Props = { dataRevision?: number; agentInventoryRevision?: number; route?: UsersRouteState;
  onRouteChange?: (route: UsersRouteState, replace?: boolean) => void; onOpenAgent?: (id: string) => void; reportSelector?: ReactNode };
const cohorts = [
  ["licensed", "Active M365 Copilot licensed users", "licensedUsers", "Licensed users with active paid features"],
  ["using_agents", "Using agents", "usingAgentsUsers", "Licensed users with agent responses"],
  ["needs_attention", "Needs attention", "needsAttentionUsers", "Licensed users needing follow-up"],
  ["no_agent_activity", "No reported agent activity", "noAgentActivityUsers", "Licensed users with no agent activity in the selected reports"],
] as const;
const userSorts = [
  ["responses:desc", "Most agent responses"], ["responses:asc", "Fewest agent responses"],
  ["agentsUsed:desc", "Most reported agents used"], ["agentsUsed:asc", "Fewest reported agents used"],
  ["lastActivity:desc", "Latest user activity"], ["lastActivity:asc", "Oldest user activity"],
  ["name:asc", "Name A–Z"], ["name:desc", "Name Z–A"], ["company:asc", "Company A–Z"], ["company:desc", "Company Z–A"],
  ["department:asc", "Department A–Z"], ["department:desc", "Department Z–A"], ["service:asc", "Paid-feature status ascending"], ["service:desc", "Paid-feature status descending"],
] as const;
export function CopilotUsersView(props: Props) {
  const capability = useContext(CapabilityContext), principal = capability?.user;
  const scope = useReportPrincipalScope();
  if (capability && !hasRole(principal, "AgentControl.Viewer")) return <section aria-label="Users and adoption"><p role="alert">Current Viewer access is required to read saved users.</p></section>;
  return <CopilotUsersSession key={scope} {...props} />;
}
function CopilotUsersSession({ route, onRouteChange, dataRevision = 0, agentInventoryRevision = 0, onOpenAgent, reportSelector }: Props) {
  const cohortDescriptionId = useId();
  const cohort = useRef<HTMLSelectElement>(null);
  const adoptionTrigger = useRef<HTMLButtonElement>(null);
  const [internal, setInternal] = useState<UsersRouteState>({ view: "licenses", search: "", page: 0 });
  const current = route ?? internal;
  const change = (next: UsersRouteState) => { setInternal(next); onRouteChange?.(next, false); };
  const reportContext = <div className="agent-report-context">
    <span className="agent-context-label">Report context</span>
    {reportSelector ?? <span>Selected report set</span>}
    {current.reportSetId ? <p className="reported-users-snapshot">Saved report{" "}
      <button type="button" className="secondary" onClick={() => change({ ...current, reportSetId: undefined, page: 0 })}>Use current reports</button></p> : null}
  </div>;
  return <section className="copilot-users" aria-label="Users and adoption" aria-busy={false}>
    <header className="copilot-users-header"><div><h2>Users</h2><p className="sr-only" id={cohortDescriptionId}>{current.section === "adoption"
      ? "People and organization-built agents grouped by company and department."
      : current.view === "licenses"
      ? "Effective paid M365 Copilot licenses and adoption."
      : "Agent activity by users without paid Copilot."}</p></div>
      <div className="agent-inventory-scopes" role="group" aria-label="Users view">
      <button type="button" className="agent-inventory-scope" aria-label="Users view" aria-pressed={current.section !== "adoption"}
        onClick={() => change({ ...current, section: undefined, search: "", page: 0 })}><span>Users</span></button>
      <button ref={adoptionTrigger} type="button" className="agent-inventory-scope" aria-pressed={current.section === "adoption"}
        onClick={() => change({ ...current, section: "adoption", search: "", page: 0 })}><span>Adoption</span></button>
      </div>
      {current.section !== "adoption" ? <div className="copilot-users-header-actions"><label className="copilot-users-cohort"><span>User cohort</span><select ref={cohort} aria-label="User cohort" aria-describedby={cohortDescriptionId} value={current.view} onChange={event => {
        const view = event.target.value;
        if (view === "licenses" || view === "activity") change({ ...current, view, page: 0 });
      }}><option value="licenses">Paid M365 Copilot users</option><option value="activity">Active users without paid Copilot</option></select></label></div> : null}</header>
    {current.section === "adoption" ? <AdoptionView route={current} change={change} revision={dataRevision + agentInventoryRevision}
      reportContext={reportContext} onOpenAgent={onOpenAgent}
      onOpenPerson={detailId => change({ ...current, detailId, detailTab: undefined })} />
      : <>{current.view === "activity" ? reportContext : null}
    {current.view === "activity" ? <ReportedUserActivity route={current} onRouteChange={change} dataRevision={dataRevision} agentInventoryRevision={agentInventoryRevision} onOpenAgent={onOpenAgent} />
        : <LicensedUsers route={current} change={change} revision={dataRevision} agentInventoryRevision={agentInventoryRevision} onOpenAgent={onOpenAgent} reportContext={reportContext} />}
    </>}
    {current.detailId ? <UserDetailModal key={current.detailId} identity={current.detailId} kind="directory"
      activeTab={current.detailTab} onTabChange={detailTab => change({ ...current, detailTab })}
      returnFocusTo={current.section === "adoption" ? adoptionTrigger : cohort} closeLabel="Close user details" onClose={() => change({ ...current, detailId: undefined, detailTab: undefined })}
      dataRevision={dataRevision} agentInventoryRevision={agentInventoryRevision} onOpenAgent={onOpenAgent} /> : null}
  </section>;
}
function LicensedUsers({ route, change, revision, agentInventoryRevision, onOpenAgent, reportContext }: {
  route: UsersRouteState; change: (route: UsersRouteState) => void; revision: number; agentInventoryRevision: number; onOpenAgent?: (id: string) => void; reportContext: ReactNode;
}) {
  const [filters, setFilters] = useState<ReportQuery>({ cohort: "licensed", sort: "responses", order: "desc" });
  const [threshold, setThreshold] = useState("5");
  const [lastThreshold, setLastThreshold] = useState(5);
  const [selected, setSelected] = useState<{ id: string; selectionId: string; queryKey: string }>();
  const [unresolvedSelectionId, setUnresolvedSelectionId] = useState<string>();
  const focus = useRef<HTMLInputElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const valid = isValidLowResponseThreshold(threshold);
  if (valid && lastThreshold !== Number(threshold)) setLastThreshold(Number(threshold));
  const query = { ...filters, search: normalizeReportSearch(route.search) || undefined, setId: route.reportSetId?.toLowerCase(),
    lowResponseThreshold: valid ? Number(threshold) : lastThreshold };
  const read = useReportPage<CombinedUser>("copilot-usage/users", query, revision);
  const queryKey = JSON.stringify(query);
  const data = read.data;
  const directoryProgress = useUserSourceProgress(data?.sources.directory);
  const directoryFailure = useUserSourceFailure(data?.sources.directory);
  const appProgress = useUserSourceProgress(data?.sources.app_activity);
  const [initialReadComplete, setInitialReadComplete] = useState(false);
  if (!initialReadComplete && (data || read.error || read.invalidated)) setInitialReadComplete(true);
  const [hasShownPageControls, setHasShownPageControls] = useState(false);
  const showPageControls = Boolean(read.loading || read.error || read.invalidated || data && data.counts.filtered > 0);
  if (!hasShownPageControls && initialReadComplete && showPageControls) setHasShownPageControls(true);
  if (selected && withdrawsSelectedRead(read.error)) setSelected(undefined);
  else if (selected && selected.queryKey === queryKey && data && !read.loading && data.selection.id !== selected.selectionId) {
    setSelected({ id: selected.id, selectionId: data.selection.id, queryKey });
  } else if (selected && (selected.queryKey !== queryKey || read.invalidated)) setSelected(undefined);
  if (unresolvedSelectionId && (!data || data.selection.id !== unresolvedSelectionId || !data.summary.unresolvedIdentities)) setUnresolvedSelectionId(undefined);
  function restartSelection() {
    setUnresolvedSelectionId(undefined);
    read.restart();
  }
  if (!initialReadComplete && read.loading && !data && !read.error && !read.invalidated) {
    return <WorkspaceSkeleton view="users" contentOnly />;
  }
  return <>
    <ReportReadStatus read={{ ...read, restart: restartSelection }} quietLoading />
      <div className="agent-overview-metrics" role="group" aria-label="M365 Copilot license summary" aria-busy={read.loading || Boolean(directoryProgress)}>{cohorts.map(([value, label, metric, description]) =>
        <button key={value} type="button" className="metric agent-overview-filter" aria-label={label} aria-pressed={filters.cohort === value}
          aria-description={`${read.loading && !data ? "Loading" : (directoryProgress || read.loading) && data?.summary[metric] == null ? "Updating" : usageCount(data?.summary[metric])}. ${description}`}
          onClick={() => setFilters({ ...filters, cohort: filters.cohort === value ? "licensed" : value })}><span title={label}>{label}</span><strong>{read.loading && !data
            ? <span className="skeleton-block skeleton-count" aria-label="Loading count" />
            : (directoryProgress || read.loading) && data?.summary[metric] == null ? "Updating..." : usageCount(data?.summary[metric])}</strong>
          <small title={description}>{description}</small></button>)}{reportContext}</div>
    {directoryProgress ? <p className="reported-users-note" role="status">{directoryProgress}</p>
      : data && !read.loading && data.sources.directory.state !== "available" ? <p className="copilot-users-notice" role="status">{directoryFailure ?? `License data ${data.sources.directory.state}. Run Users sync in Sync or review Permissions.`}</p> : null}
    {data && !read.loading && data.reports.availability !== "active" ? <p className="copilot-users-notice" role="status">
      {data.reports.availability === "stale" ? "Reports are out of date." : "Agent reports unavailable."}{" "}
      <a href="/sync?reports=manage">Manage reports in Sync</a>.</p> : null}
    {appProgress && !directoryProgress ? <p className="reported-users-note" role="status">{appProgress}</p> : null}
    {!appProgress && data && !read.loading && ["stale", "unavailable"].includes(data.sources.app_activity.state) ? <p className="copilot-users-notice" role="status">
      Office app activity {data.sources.app_activity.state === "stale" ? "is out of date. Run Users sync in Sync." : "unavailable. Review the connection in Permissions."}</p> : null}
    <div className="agent-table-stack user-directory-table" aria-busy={read.loading}>
      <UserActivityFilters path="copilot-usage/users" selectionId={read.selectedData?.selection.id} onRestartSelection={restartSelection}
      onSelectionInvalidated={read.invalidateSelection}
      values={{ company: filters.company, department: filters.department, cohort: filters.cohort ?? "licensed", lowResponseThreshold: threshold }}
      cohorts={cohorts.map(([value, label]) => ({ value, label: value === "licensed" ? "All paid users" : label }))} defaultCohort="licensed" cohortLabel="Activity"
      searchLabel="Search users or agents" search={route.search} searchRef={focus} sort={`${filters.sort}:${filters.order}`}
      sorts={userSorts.map(([value, label]) => ({ value, label }))} matchingCount={data?.counts.filtered} loading={read.loading} validThreshold={valid}
      onSearch={search => change({ ...route, search, page: 0 })} onChange={value => {
        setFilters({ ...filters, company: value.company, department: value.department, cohort: value.cohort }); setThreshold(value.lowResponseThreshold);
      }} onSort={value => { const [sort, order] = value.split(":"); setFilters({ ...filters, sort: sort as ReportQuery["sort"], order: order as ReportQuery["order"] }); }}
      onClear={() => { setFilters({ cohort: "licensed", sort: filters.sort, order: filters.order }); setThreshold("5"); change({ ...route, search: "", page: 0 }); }}
      exportButton={<ReportExportButton key={JSON.stringify([query, read.invalidated || withdrawsSelectedRead(read.error)])} preserveOnRefresh kind="copilot_users" selectionId={read.selectedData?.selection.id} label="Export users CSV"
        admissionAllowed={() => read.isCurrentData(true)}
        onSelectionInvalidated={read.invalidateSelection} disabled={!read.selectedData || !valid} />} />
      <div className="table-shell copilot-users-table-shell" role="region" aria-label="M365 Copilot license status" tabIndex={0}>
        <table className="agent-table copilot-users-table reported-users-table"><thead><tr>{([["User", "name"], ["Agent responses", "responses"], ["Agents used", "agentsUsed"],
          ["Company", "company"], ["Department", "department"], ["Last activity", "lastActivity"]] as const).map(([label, sort]) =>
          <ReportSortHeading key={sort} label={label} sort={sort} query={filters} onChange={setFilters} />)}</tr></thead>
          <tbody>{data?.value.map(user => <tr key={user.directory.objectId}><th scope="row"><button type="button" className="agent-name-button user-name-button" aria-haspopup="dialog" onClick={event => {
            trigger.current = event.currentTarget; setSelected({ id: user.directory.objectId, selectionId: data.selection.id, queryKey });
          }}>
            {user.directory.displayName || user.directory.userPrincipalName}</button><small>{user.directory.userPrincipalName}</small>
            {user.directory.accountEnabled === false ? <small>Account disabled</small> : null}</th>
            <td data-numeric>{usageCount(user.reportedResponses)}</td><td data-numeric>{usageCount(user.reportedAgentsUsed)}</td><td>{user.directory.companyName?.trim() || "Not set"}</td>
            <td>{user.directory.department?.trim() || "Not set"}</td><td>{usageDate(user.userLastActivityDateUtc)}</td></tr>)}</tbody></table>
      </div>
      {data && !data.value.length ? <div className="reported-users-empty">
        <h3>{data.counts.filtered ? "No users on this page" : "No users match"}</h3>
        <p>{data.counts.filtered ? "Continue to the next page." : "Try another search or clear filters."}</p>
      </div> : null}
      {showPageControls || hasShownPageControls ? <ReportPageControls {...read} label="users" /> : null}
    </div>
    {data ? <>
      <details className="copilot-users-provenance" onToggle={event => {
        if (!event.currentTarget.open) setUnresolvedSelectionId(undefined);
      }}><summary>Data sources and coverage</summary>{Object.values(data.sources).map(source => <div key={source.source}>
        <strong>{source.source === "directory" ? "Checked directory users" : "Office app activity"}: {{
          available: "Connected", partial: "Incomplete", stale: "Out of date", unavailable: "Unavailable",
        }[source.state]}</strong><p>{source.message}</p><p>Checked: {usageDate(source.observedAt)}; {usageCount(source.rowCount)} source rows.</p>
        {source.reportRefreshDate ? <p>Report refreshed: {usageDate(source.reportRefreshDate)}; Version: {source.reportVersion}; Period: {source.period}</p> : null}</div>)}
        <UsageReportContext reports={data.reports} />
        <p>Unknown activity metrics: {usageCount(data.summary.unknownMetricsUsers)}</p>
        {data.summary.unresolvedIdentities > 0 ? <button type="button" className="secondary"
          aria-expanded={unresolvedSelectionId === data.selection.id}
          onClick={() => setUnresolvedSelectionId(value => value === data.selection.id ? undefined : data.selection.id)}>
          Unresolved report identities ({data.summary.unresolvedIdentities.toLocaleString()})</button> : null}
        {unresolvedSelectionId === data.selection.id ? <UnresolvedIdentities selectionId={data.selection.id} onRestartSelection={restartSelection}
          onSelectionInvalidated={read.invalidateSelection} /> : null}
      </details>
    </> : null}
    {selected ? <UserDetailModal key={selected.id} identity={selected.id} selectionId={selected.selectionId} kind="directory"
      returnFocusTo={trigger} closeLabel="Close user details" onClose={() => setSelected(undefined)} onOpenAgent={onOpenAgent}
      dataRevision={revision} agentInventoryRevision={agentInventoryRevision} onRestartSelection={restartSelection}
      onSelectionInvalidated={() => { if (selected.selectionId === read.selectedData?.selection.id) read.invalidateSelection(); }} /> : null}
  </>;
}
function UnresolvedIdentities({ selectionId, onRestartSelection, onSelectionInvalidated }: {
  selectionId: string; onRestartSelection: () => void; onSelectionInvalidated: () => void;
}) {
  const read = useReportPage<UnresolvedReportIdentity>("copilot-usage/users/unresolved-identities", { selectionId }, 0, true, onRestartSelection);
  useEffect(() => {
    if (read.invalidated) onSelectionInvalidated();
  }, [read.invalidated, onSelectionInvalidated]);
  if (read.invalidated) return null;
  return <section aria-label="Unresolved report identities"><ReportReadStatus read={read} />
    <ul>{read.data?.value.map(row => <li key={row.username}>{row.username}: {row.reason}; {usageCount(row.responses)} responses</li>)}</ul><ReportPageControls {...read} label="identities" /></section>;
}
