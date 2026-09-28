import { useContext, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import type { SortingState } from "@tanstack/react-table";
import {
  ApiError,
  copilotAgentActivity,
  getCopilotUsageUsers,
  hasReportedAgentActivity,
  isCopilotServiceActive,
  type CopilotUsageSourceSummary,
  type CopilotUsageUser,
  type CopilotUsageUsersResponse,
} from "../api/client";
import { hasRole } from "../authorization";
import { CapabilityContext } from "../capabilityContext";
import { copilotServicePresentation } from "../copilotServicePresentation";
import { useListTable, type ListColumn } from "../listTable";
import { useSavedRead } from "../savedQueries";
import type { UsersRouteState } from "../workbenchRouting";
import { isValidLowResponseThreshold } from "../usageInsights";
import { ListTableHead } from "./ListTableHead";
import { ReportedUserActivity } from "./ReportedUserActivity";
import { UserActivityFilters, type UserActivityFilterValues } from "./UserActivityFilters";
import { UserAgentResponsibility } from "./UserAgentResponsibility";
import { UserDetailModal } from "./UserDetailModal";
import "./copilotUsers.css";

type Cohort = "licensed" | "using" | "attention" | "no-activity";
const defaultFilters: UserActivityFilterValues<Cohort> = {
  company: "", department: "", cohort: "licensed", lowResponseThreshold: "5",
};
const cohorts = [
  { value: "licensed", label: "All paid users" },
  { value: "using", label: "Using agents" },
  { value: "attention", label: "Needs attention" },
  { value: "no-activity", label: "No reported agent activity" },
] as const;
type ReadKey = { dataRevision: number; reload: number; needsDirectory: boolean };
type ReadState = { key: ReadKey; status: "ready" } | { key: ReadKey; status: "failed"; error: string; accessDenied?: boolean };
const pageSize = 50;
const defaultLicenseSorting: SortingState = [{ id: "responses", desc: true }];
const licenseSorts = [
  ["responses-desc", "Most agent responses", "responses", true],
  ["responses-asc", "Fewest agent responses", "responses", false],
  ["name", "Name A–Z", "user", false],
  ["name-desc", "Name Z–A", "user", true],
  ["agents-desc", "Most reported agents used", "agentsUsed", true],
  ["agents-asc", "Fewest reported agents used", "agentsUsed", false],
  ["activity", "Latest user activity", "activity", true],
  ["activity-asc", "Oldest user activity", "activity", false],
] as const;

type Props = {
  dataRevision?: number;
  agentInventoryRevision?: number;
  route?: UsersRouteState;
  onRouteChange?: (route: UsersRouteState, replace?: boolean) => void;
  onOpenAgent?: (id: string) => void;
  reportSelector?: ReactNode;
};

export function CopilotUsersView(props: Props) {
  const capability = useContext(CapabilityContext);
  const principal = capability?.user;
  const scope = JSON.stringify([principal?.tenantId, principal?.homeAccountId, [...(principal?.roles ?? [])].sort()]);
  if (capability && !hasRole(principal, "AgentControl.Viewer")) {
    return <section aria-label="Users and adoption"><p role="alert">Current Viewer access is required to read saved users.</p></section>;
  }
  return <CopilotUsersSession key={scope} {...props} scope={scope} />;
}

function CopilotUsersSession({
  dataRevision = 0,
  agentInventoryRevision = 0,
  route,
  onRouteChange,
  onOpenAgent,
  reportSelector,
  scope,
}: Props & { scope: string }) {
  const [data, setData] = useState<CopilotUsageUsersResponse>();
  const [read, setRead] = useState<ReadState>();
  const [reload, setReload] = useState(0);
  const [internalRoute, setInternalRoute] = useState<UsersRouteState>({ view: "licenses", search: "", page: 0 });
  const [selectedUser, setSelectedUser] = useState<{ id: string; threshold: number; key: object; removed?: boolean }>();
  const cohortSelect = useRef<HTMLSelectElement>(null);
  const directoryRequest = useRef<AbortController | null>(null);
  const readSaved = useSavedRead();
  const currentRoute = route ?? internalRoute;
  const needsDirectory = currentRoute.view !== "responsibility";
  const readKey = useMemo(() => ({ dataRevision, reload, needsDirectory }), [dataRevision, reload, needsDirectory]);
  const scopedRead = read?.key === readKey ? read : undefined;
  const loading = !scopedRead;
  const currentData = read?.status === "ready" ? data : undefined;
  const error = scopedRead?.status === "failed" ? scopedRead.error : undefined;
  const accessDenied = scopedRead?.status === "failed" && scopedRead.accessDenied;
  const selectionKey = useMemo(() => ({ view: currentRoute.view }), [currentRoute.view]);
  const selected = selectedUser?.key === selectionKey && !selectedUser.removed
    ? currentData?.users.find(user => user.directory.objectId === selectedUser.id)
    : undefined;

  function changeRoute(next: UsersRouteState, replace = false) {
    setInternalRoute(next);
    onRouteChange?.(next, replace);
  }

  useEffect(() => {
    if (!needsDirectory) return;
    const controller = new AbortController();
    directoryRequest.current = controller;
    void readSaved(["copilot-usage-users", scope, dataRevision, reload], signal => getCopilotUsageUsers({ signal }), controller.signal).then(result => {
      if (!controller.signal.aborted) {
        setData(result);
        setRead({ key: readKey, status: "ready" });
        setSelectedUser(selection => {
          if (!selection) return selection;
          return result.users.some(user => user.directory.objectId === selection.id)
            ? selection.removed ? undefined : selection
            : { ...selection, removed: true };
        });
      }
    }).catch((failure: unknown) => {
      if (!controller.signal.aborted) {
        const denied = failure instanceof ApiError && (failure.status === 401 || failure.status === 403);
        if (denied) setData(undefined);
        setSelectedUser(undefined);
        setRead({ key: readKey, status: "failed", error: failure instanceof Error ? failure.message : "Paid Copilot licenses and usage could not be loaded.", accessDenied: denied });
      }
    });
    return () => controller.abort();
  }, [needsDirectory, scope, dataRevision, readKey, readSaved, reload]);

  return (
    <section className="copilot-users" aria-label="Users and adoption" aria-busy={loading && !currentData && currentRoute.view === "licenses"}>
      <header className="copilot-users-header">
        <div>
          <h2>Users & adoption</h2>
          <p>{currentRoute.view === "licenses"
            ? "Effective paid M365 Copilot licenses and adoption."
            : currentRoute.view === "responsibility" ? "People explicitly responsible for saved agents, independent of licenses and usage."
              : "Agent activity by users without paid Copilot."}</p>
        </div>
        <div className="copilot-users-header-actions">
          <label className="copilot-users-cohort"><span>User cohort</span>
            <select ref={cohortSelect} value={currentRoute.view} onChange={event => {
              if (event.target.value === "licenses") changeRoute({ view: "licenses", search: "", page: 0 });
              else if (event.target.value === "activity") changeRoute({ ...currentRoute, view: "activity" });
              else if (event.target.value === "responsibility") changeRoute({ view: "responsibility", search: "", page: 0 });
            }}>
              <option value="licenses">Paid M365 Copilot users</option>
              <option value="activity">Active users without paid Copilot</option>
              <option value="responsibility">Agent responsibility</option>
            </select>
          </label>
        </div>
      </header>
      {currentRoute.view !== "responsibility" ? reportSelector : null}
      {error && currentRoute.view !== "responsibility" ? <div className="error-banner" role="alert">{error} Use Permissions in the top navigation for connection recovery.
        {" "}<button type="button" className="secondary" onClick={() => setReload(value => value + 1)}>Retry saved users</button></div> : null}
      {loading && !currentData && currentRoute.view === "licenses" ? <p role="status">Loading saved Copilot license status and usage snapshots...</p> : null}
      {loading && currentData && currentRoute.view !== "responsibility" ? <p className="sr-only" role="status">Refreshing saved users. Showing the last loaded snapshot.</p> : null}
      {selectedUser?.key === selectionKey && selectedUser.removed ? <p className="copilot-users-notice" role="status">The selected user is no longer present in this saved user snapshot.</p> : null}
      {currentRoute.view === "responsibility" ? <UserAgentResponsibility key={currentRoute.personId ?? "people"} route={currentRoute} onRouteChange={changeRoute} dataRevision={dataRevision} agentInventoryRevision={agentInventoryRevision} onOpenAgent={onOpenAgent} />
        : currentRoute.view === "activity" ? !accessDenied ? <ReportedUserActivity route={currentRoute} onRouteChange={changeRoute} dataRevision={dataRevision} agentInventoryRevision={agentInventoryRevision} directoryData={currentData} directoryDataRevision={read?.key.dataRevision} directoryPending={loading} onOpenAgent={onOpenAgent}
        onAccessDenied={message => { directoryRequest.current?.abort(); setData(undefined); setSelectedUser(undefined); setRead({ key: readKey, status: "failed", error: message, accessDenied: true }); }} /> : null
        : data ? <CopilotUsersDashboard data={data} current={Boolean(currentData)} refreshing={loading} onInspectUser={(user, threshold) => setSelectedUser({ id: user.directory.objectId, threshold, key: selectionKey })} /> : null}
      {selected && selectedUser && data ? <CopilotUserDetail user={selected} data={data} current={Boolean(currentData)} refreshing={loading} threshold={selectedUser.threshold} returnFocusTo={cohortSelect} onClose={() => setSelectedUser(undefined)} onOpenAgent={onOpenAgent} dataRevision={dataRevision} agentInventoryRevision={agentInventoryRevision} /> : null}
    </section>
  );
}

function CopilotUsersDashboard({ data, current, refreshing, onInspectUser }: {
  data: CopilotUsageUsersResponse; current: boolean; refreshing: boolean; onInspectUser: (user: CopilotUsageUser, threshold: number) => void;
}) {
  const [search, setSearch] = useState("");
  const [filters, setFilters] = useState(defaultFilters);
  const [draft, setDraft] = useState(defaultFilters);
  const [sorting, setSorting] = useState<SortingState>(defaultLicenseSorting);
  const [page, setPage] = useState(0);
  const searchInput = useRef<HTMLInputElement>(null);
  const { cohort, company, department } = filters;
  const threshold = Number(filters.lowResponseThreshold);
  const validThreshold = isValidLowResponseThreshold(draft.lowResponseThreshold);
  const directoryKnown = data.sources.directory.state === "available";
  const directoryCurrent = current && directoryKnown;
  const agentUsageFresh = current && data.sources.importedAgentUsage.state === "available";
  const appActivityFresh = current && ["available", "partial"].includes(data.sources.appActivity.state);
  const hasUnresolvedIdentities = data.unresolvedImportedIdentities.length > 0;
  const licensedUsers = useMemo(() => data.users.filter(user => isCopilotServiceActive(user.copilotServiceState)), [data.users]);
  const organizations = useMemo(() => ({
    companies: [...new Set(licensedUsers.map(user => user.directory.companyName?.trim()).filter((value): value is string => Boolean(value)))].sort((a, b) => a.localeCompare(b)),
    departments: [...new Set(licensedUsers.map(user => user.directory.department?.trim()).filter((value): value is string => Boolean(value)))].sort((a, b) => a.localeCompare(b)),
  }), [licensedUsers]);
  const attention = licensedUsers.filter(user => needsAttention(user, threshold, agentUsageFresh, appActivityFresh, hasUnresolvedIdentities)).length;
  const noActivity = licensedUsers.filter(user => copilotAgentActivity(user.importedUsage, agentUsageFresh, hasUnresolvedIdentities) === "none").length;
  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return licensedUsers.filter(user => {
      if (company && user.directory.companyName?.trim() !== company) return false;
      if (department && user.directory.department?.trim() !== department) return false;
      if (query && ![
        user.directory.displayName, user.directory.userPrincipalName, user.directory.objectId,
        user.directory.companyName, user.directory.department,
        ...(user.importedUsage?.rows.flatMap(row => [row.displayAgentName, row.creatorType]) ?? []),
      ].some(value => value?.toLowerCase().includes(query))) return false;
      if (cohort === "using") return hasAgentResponses(user);
      if (cohort === "attention") return directoryCurrent && needsAttention(user, threshold, agentUsageFresh, appActivityFresh, hasUnresolvedIdentities);
      if (cohort === "no-activity") return copilotAgentActivity(user.importedUsage, agentUsageFresh, hasUnresolvedIdentities) === "none";
      return true;
    });
  }, [agentUsageFresh, appActivityFresh, cohort, company, department, directoryCurrent, hasUnresolvedIdentities, licensedUsers, search, threshold]);
  const columns = useMemo<ListColumn<CopilotUsageUser>[]>(() => [
    { id: "user", header: "User", accessorFn: name },
    { id: "responses", header: "Agent responses", accessorFn: user => responses(user) ?? undefined, sortDescFirst: true },
    {
      id: "agentsUsed", header: "Agents used",
      accessorFn: user => user.importedUsage && !user.importedUsage.missingUserReport ? user.importedUsage.reportedAgentsUsed : undefined,
      sortDescFirst: true,
    },
    { id: "company", header: "Company", enableSorting: false },
    { id: "department", header: "Department", enableSorting: false },
    { id: "activity", header: "Last activity", accessorFn: user => user.importedUsage?.userLastActivityDateUtc, sortDescFirst: true },
  ], []);
  const table = useListTable({
    data: filtered,
    columns,
    sorting,
    getRowId: user => user.directory.objectId,
    onSortingChange: update => {
      setSorting(previous => typeof update === "function" ? update(previous) : update);
      setPage(0);
    },
  });
  const sortedRows = table.getRowModel().rows;
  const lastPage = Math.max(0, Math.ceil(filtered.length / pageSize) - 1);
  const currentPage = Math.min(page, lastPage);
  const visible = sortedRows.slice(currentPage * pageSize, (currentPage + 1) * pageSize);
  const noLicensedUsers = cohort === "licensed" && licensedUsers.length === 0 && !search.trim() && !company && !department;

  function selectCohort(next: Cohort) {
    const value = cohort === next ? "licensed" : next;
    setFilters(previous => ({ ...previous, cohort: value }));
    setDraft(previous => ({ ...previous, cohort: value }));
    setPage(0);
  }

  function updateFilters(next: UserActivityFilterValues<Cohort>) {
    setDraft(next);
    if (!isValidLowResponseThreshold(next.lowResponseThreshold)) return;
    setFilters(next);
    setPage(0);
  }

  function resetFilters() {
    setSearch("");
    setFilters(defaultFilters);
    setDraft(defaultFilters);
    setPage(0);
  }

  // A failed read removes presentation, but a saved-read retry must not reset local filters.
  if (!current) return null;

  return <>
    {data.snapshot?.state === "not_synced" ? <p className="copilot-users-notice" role="status">No saved user data. Run Users sync from Sync in the top navigation.</p>
      : data.snapshot?.state === "partial" ? <p className="copilot-users-notice" role="status">Saved user snapshot is partial. Run Users sync from Sync in the top navigation.</p> : null}
    <div className="copilot-user-metrics" role="group" aria-label="M365 Copilot license summary">
      <Metric label="Active M365 Copilot licensed users" value={directoryCurrent ? data.counts.licensedUsers : null} hint="Licensed users with active paid features"
        selected={cohort === "licensed"} onClick={() => selectCohort("licensed")} />
      <Metric label="Using agents" value={directoryCurrent && agentUsageFresh ? licensedUsers.filter(hasAgentResponses).length : null} hint="Licensed users with agent responses"
        selected={cohort === "using"} onClick={() => selectCohort("using")} />
      <Metric label="Needs attention" value={directoryCurrent ? attention : null} hint="Licensed users needing follow-up"
        selected={cohort === "attention"} onClick={() => selectCohort("attention")} />
      <Metric label="No reported agent activity" value={directoryCurrent && agentUsageFresh ? noActivity : null} hint="Licensed users with no agent activity in the selected reports"
        selected={cohort === "no-activity"} onClick={() => selectCohort("no-activity")} />
    </div>

    {!directoryKnown ? <p className="copilot-users-notice" role="status">License data unavailable. Run Users sync in Sync or review Permissions.</p> : null}
    {data.sources.importedAgentUsage.state !== "available" ? <div className="copilot-users-notice" role="status">
      <p>{data.sources.importedAgentUsage.state === "stale" ? "Reports are out of date." : "Agent reports unavailable."}{" "}
        <a href="/sync?reports=manage">Manage reports in Sync</a>.</p>
    </div> : null}
    {data.sources.appActivity.state === "unavailable" ? <p className="copilot-users-notice" role="status">
      Office app activity unavailable. Review the connection in Permissions.
    </p> : data.sources.appActivity.state === "stale" ? <p className="copilot-users-notice" role="status">Office app activity is out of date. Run Users sync in Sync.</p> : null}

    <UserActivityFilters values={draft} companies={organizations.companies} departments={organizations.departments}
      cohorts={cohorts} defaultCohort="licensed" cohortLabel="Activity" searchLabel="Search users or agents"
      search={search} searchRef={searchInput} sort={licenseSorts.find(([, , id, desc]) => id === sorting[0]?.id && desc === sorting[0]?.desc)?.[0] ?? licenseSorts[0][0]}
      sorts={licenseSorts.map(([value, label]) => ({ value, label }))} matchingCount={filtered.length}
      loading={refreshing} validThreshold={validThreshold} onChange={updateFilters}
      onSearch={value => { setSearch(value); setPage(0); }}
      onSort={value => {
        const next = licenseSorts.find(([key]) => key === value);
        if (next) {
          setSorting([{ id: next[2], desc: next[3] }]);
          setPage(0);
        }
      }} onClear={resetFilters} />

    {visible.length ? <div className="copilot-users-table-shell" role="region" aria-label="M365 Copilot license status" tabIndex={0}>
      <table className="copilot-users-table reported-users-table">
        <ListTableHead table={table} />
        <tbody>{visible.map(row => {
          const user = row.original;
          const noReportedActivity = copilotAgentActivity(user.importedUsage, agentUsageFresh, hasUnresolvedIdentities) === "none";
          const responseCount = responses(user);
          const agentCount = user.importedUsage && !user.importedUsage.missingUserReport ? user.importedUsage.reportedAgentsUsed : null;
          return <tr key={row.id}>
            <th scope="row"><button type="button" className="user-name-button" aria-haspopup="dialog" onClick={() => onInspectUser(user, threshold)}>{name(user)}</button><small>{user.directory.userPrincipalName}</small>{user.directory.accountEnabled === false ? <small>Account disabled</small> : null}</th>
            <td data-numeric>{responseCount === null && noReportedActivity ? "Not reported" : formatCount(responseCount)}{!agentUsageFresh && responseCount !== null ? <small>Historical report</small> : null}</td>
            <td data-numeric>{agentCount === null && noReportedActivity ? "Not reported" : formatCount(agentCount)}</td>
            <td>{user.directory.companyName?.trim() || "Not set"}</td>
            <td>{user.directory.department?.trim() || "Not set"}</td>
            <td>{formatDate(user.importedUsage?.userLastActivityDateUtc)}</td>
          </tr>;
        })}</tbody>
      </table>
    </div> : <div className="reported-users-empty">
      <h3>{directoryCurrent ? cohort === "no-activity" && !agentUsageFresh ? "Agent usage unavailable" : noLicensedUsers ? "No active M365 Copilot licenses found" : "No users match" : "No last-saved users in this cohort"}</h3>
      <p>{directoryCurrent
        ? cohort === "no-activity" && !agentUsageFresh ? "Select a complete, current usage report in Sync." : noLicensedUsers ? "No users have verified active paid features in the saved inventory." : "Try another search or clear filters."
        : "Current licensing is unverified. Run Users sync from Sync in the top navigation."}</p>
    </div>}

    {filtered.length ? <div className="copilot-users-pagination" aria-label="Copilot user pages">
      <span>{currentPage * pageSize + 1}-{Math.min((currentPage + 1) * pageSize, filtered.length)} of {filtered.length.toLocaleString()} users</span>
      <button type="button" className="secondary" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>Previous</button>
      <button type="button" className="secondary" disabled={currentPage >= lastPage} onClick={() => setPage(currentPage + 1)}>Next</button>
    </div> : null}

    <details className="copilot-users-provenance">
      <summary>Data sources and coverage</summary>
      {data.snapshot ? <p>Directory observed: {data.snapshot.directoryObservedAt ? formatDateTime(data.snapshot.directoryObservedAt) : "never"}.
        {" "}App activity observed: {data.snapshot.appActivityObservedAt ? formatDateTime(data.snapshot.appActivityObservedAt) : "never"}.</p> : null}
      <dl>{([
        ["Checked directory users", data.sources.directory],
        ["Agent activity", data.sources.importedAgentUsage],
        ["Office app activity", data.sources.appActivity],
      ] as const).map(([label, source]) => <div key={label}><dt>{label}: {sourceLabel(source)}</dt><dd>{source.message}</dd><dd>Checked: {formatDate(source.fetchedAt)}{source.reportRefreshDate ? ` | Report refreshed: ${formatDate(source.reportRefreshDate)}` : ""}{source.reportVersion ? ` | Version: ${source.reportVersion}` : ""}</dd>{source.period.startDate || source.period.endDate ? <dd>Range: {source.period.startDate ?? "Unknown"} to {source.period.endDate ?? "Unknown"}</dd> : null}</div>)}</dl>
    </details>
  </>;
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function CopilotUserDetail({ user, data, current, refreshing, threshold, returnFocusTo, onClose, onOpenAgent, dataRevision, agentInventoryRevision }: {
  user: CopilotUsageUser; data: CopilotUsageUsersResponse; current: boolean; refreshing: boolean; threshold: number; onClose: () => void;
  returnFocusTo: RefObject<HTMLSelectElement | null>;
  onOpenAgent?: (id: string) => void;
  dataRevision: number;
  agentInventoryRevision: number;
}) {
  const fresh = current && data.sources.importedAgentUsage.state === "available";
  const directoryCurrent = current && data.sources.directory.state === "available";
  const hasUnresolvedIdentities = data.unresolvedImportedIdentities.length > 0;
  const noReportedActivity = copilotAgentActivity(user.importedUsage, fresh, hasUnresolvedIdentities) === "none";
  const followUp = directoryCurrent ? recommendation(user, threshold, fresh, ["available", "partial"].includes(data.sources.appActivity.state), hasUnresolvedIdentities) : { label: "Verify paid license inventory", tone: "unknown" };
  return <UserDetailModal identity={user.directory.objectId} displayName={name(user)} username={user.directory.userPrincipalName}
    directoryUser={user} directoryCurrent={directoryCurrent} reportUser={user.importedUsage}
    reportPeriod={data.sources.importedAgentUsage.period} reportCurrent={fresh} appActivityState={data.sources.appActivity.state}
    noReportedAgentActivity={noReportedActivity}
    followUp={followUp} returnFocusTo={returnFocusTo} closeLabel="Close user details" onClose={onClose}
    onOpenAgent={onOpenAgent} dataRevision={dataRevision} agentInventoryRevision={agentInventoryRevision} refreshing={refreshing} />;
}

function responses(user: CopilotUsageUser): number | null {
  return user.importedUsage && !user.importedUsage.missingUserReport ? user.importedUsage.reportedResponsesReceived : null;
}

function hasAgentResponses(user: CopilotUsageUser) {
  return user.importedUsage !== null && hasReportedAgentActivity(user.importedUsage);
}

function name(user: CopilotUsageUser) {
  return user.directory.displayName || user.directory.userPrincipalName;
}

function needsAttention(user: CopilotUsageUser, threshold: number, agentUsageFresh: boolean, appActivityFresh: boolean, hasUnresolvedIdentities: boolean) {
  const count = responses(user);
  const activity = copilotAgentActivity(user.importedUsage, agentUsageFresh, hasUnresolvedIdentities);
  return copilotServicePresentation(user.copilotServiceState).needsAttention || user.directory.accountEnabled === false
    || (appActivityFresh && user.attention.includes("app_activity_inactive")) || activity === "none"
    || (activity === "active" && count !== null && count > 0 && count <= threshold);
}

function recommendation(user: CopilotUsageUser, threshold: number, agentUsageFresh: boolean, appActivityFresh: boolean, hasUnresolvedIdentities: boolean) {
  const count = responses(user);
  const activity = copilotAgentActivity(user.importedUsage, agentUsageFresh, hasUnresolvedIdentities);
  const service = copilotServicePresentation(user.copilotServiceState);
  if (user.directory.accountEnabled === false) return { label: "Review disabled account", tone: "attention" };
  if (service.needsAttention) return { label: user.copilotServiceState === "unknown" ? "Verify paid features" : "Review paid features", tone: service.tone };
  if (activity === "none") return { label: "No reported agent activity", tone: "attention" };
  if (activity === "active" && count !== null && count > 0 && count <= threshold) return { label: "Offer adoption help", tone: "attention" };
  if (appActivityFresh && user.attention.includes("app_activity_inactive")) return { label: "Review app activity", tone: "attention" };
  if (!agentUsageFresh && count !== null) return { label: "Refresh agent report", tone: "unknown" };
  if (activity === "unknown") return { label: "Usage unknown", tone: "unknown" };
  return { label: "Using agents", tone: "" };
}

function Metric({ label, value, hint, selected, onClick }: {
  label: string; value: number | null; hint: string; selected: boolean; onClick: () => void;
}) {
  return <button type="button" className="copilot-user-metric copilot-user-filter" aria-label={label}
    aria-description={`${formatCount(value)}. ${hint}`} aria-pressed={selected} onClick={onClick}>
    <span>{label}</span><strong>{formatCount(value)}</strong><small>{hint}</small>
  </button>;
}

function formatCount(value: number | null) {
  return value === null ? "Unknown" : value.toLocaleString();
}

function formatDate(value: string | null | undefined) {
  if (!value) return "Not reported";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Unknown" : date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

function sourceLabel(source: CopilotUsageSourceSummary) {
  if (source.state === "available") return "Connected";
  if (source.state === "stale") return "Out of date";
  if (source.state === "not_imported") return "Not imported";
  if (source.state === "partial") return "Incomplete";
  return "Unavailable";
}
