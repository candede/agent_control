import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { X } from "lucide-react";
import type { SortingState } from "@tanstack/react-table";
import {
  ApiError,
  getCopilotUsageUsers,
  isCopilotServiceActive,
  type CopilotAppActivity,
  type CopilotUsageSourceSummary,
  type CopilotUsageUser,
  type CopilotUsageUsersResponse,
} from "../api/client";
import { copilotServicePresentation } from "../copilotServicePresentation";
import { useListTable, type ListColumn } from "../listTable";
import { useSavedRead } from "../savedQueries";
import type { UsersRouteState } from "../workbenchRouting";
import { ListTableHead } from "./ListTableHead";
import { CopilotLicenseStatus } from "./CopilotLicenseStatus";
import { CopilotServiceDetails } from "./CopilotServiceDetails";
import { ReportedUserActivity } from "./ReportedUserActivity";
import { ReportedUserAgents } from "./ReportedUserAgents";
import { UserAgentResponsibility } from "./UserAgentResponsibility";
import { UserPurviewAudit } from "./UserPurviewAudit";
import "./copilotUsers.css";

type Cohort = "licensed" | "attention" | "unknown";
type ReadState = { key: object; status: "ready" } | { key: object; status: "failed"; error: string; accessDenied?: boolean };
const pageSize = 50;
const defaultLicenseSorting: SortingState = [{ id: "responses", desc: true }];
const licenseSorts = [
  ["responses-desc", "Most agent responses", "responses", true],
  ["responses-asc", "Fewest agent responses", "responses", false],
  ["name", "Name A–Z", "user", false],
  ["name-desc", "Name Z–A", "user", true],
  ["license-asc", "Paid feature state A–Z", "license", false],
  ["license-desc", "Paid feature state Z–A", "license", true],
  ["agents-desc", "Most reported agents used", "agentsUsed", true],
  ["agents-asc", "Fewest reported agents used", "agentsUsed", false],
  ["activity", "Latest agent-report activity", "activity", true],
  ["activity-asc", "Oldest agent-report activity", "activity", false],
  ["follow-up-asc", "Follow-up A–Z", "followUp", false],
  ["follow-up-desc", "Follow-up Z–A", "followUp", true],
] as const;
const appFields = [
  ["Copilot Chat", "copilotChatLastActivityDate"],
  ["Teams", "microsoftTeamsCopilotLastActivityDate"],
  ["Word", "wordCopilotLastActivityDate"],
  ["Excel", "excelCopilotLastActivityDate"],
  ["PowerPoint", "powerpointCopilotLastActivityDate"],
  ["Outlook", "outlookCopilotLastActivityDate"],
  ["OneNote", "onenoteCopilotLastActivityDate"],
  ["Loop", "loopCopilotLastActivityDate"],
] as const satisfies ReadonlyArray<readonly [string, keyof CopilotAppActivity]>;

export function CopilotUsersView({
  dataRevision = 0,
  agentInventoryRevision = 0,
  route,
  onRouteChange,
  onOpenAgent,
}: {
  dataRevision?: number;
  agentInventoryRevision?: number;
  route?: UsersRouteState;
  onRouteChange?: (route: UsersRouteState, replace?: boolean) => void;
  onOpenAgent?: (id: string) => void;
}) {
  const [data, setData] = useState<CopilotUsageUsersResponse>();
  const [read, setRead] = useState<ReadState>();
  const [reload, setReload] = useState(0);
  const [internalRoute, setInternalRoute] = useState<UsersRouteState>({ view: "licenses", search: "", page: 0 });
  const [selectedUser, setSelectedUser] = useState<{ id: string; threshold: number; key: object }>();
  const cohortSelect = useRef<HTMLSelectElement>(null);
  const directoryRequest = useRef<AbortController | null>(null);
  const readSaved = useSavedRead();
  const currentRoute = route ?? internalRoute;
  const needsDirectory = currentRoute.view !== "responsibility";
  const readKey = useMemo(() => ({ dataRevision, reload, needsDirectory }), [dataRevision, reload, needsDirectory]);
  const scopedRead = read?.key === readKey ? read : undefined;
  const loading = !scopedRead;
  const currentData = scopedRead?.status === "ready" ? data : undefined;
  const error = scopedRead?.status === "failed" ? scopedRead.error : undefined;
  const accessDenied = scopedRead?.status === "failed" && scopedRead.accessDenied;
  const selectionKey = useMemo(() => ({ readKey, view: currentRoute.view }), [readKey, currentRoute.view]);
  const selected = selectedUser?.key === selectionKey
    ? data?.users.find(user => user.directory.objectId === selectedUser.id)
    : undefined;

  function changeRoute(next: UsersRouteState, replace = false) {
    setInternalRoute(next);
    onRouteChange?.(next, replace);
  }

  useEffect(() => {
    if (!needsDirectory) return;
    const controller = new AbortController();
    directoryRequest.current = controller;
    void readSaved(["copilot-usage-users", dataRevision, reload], signal => getCopilotUsageUsers({ signal }), controller.signal).then(result => {
      if (!controller.signal.aborted) {
        setData(result);
        setRead({ key: readKey, status: "ready" });
      }
    }).catch((failure: unknown) => {
      if (!controller.signal.aborted) {
        const denied = failure instanceof ApiError && (failure.status === 401 || failure.status === 403);
        if (denied) {
          setData(undefined);
        }
        setRead({ key: readKey, status: "failed", error: failure instanceof Error ? failure.message : "Paid Copilot licenses and usage could not be loaded.", accessDenied: denied });
      }
    });
    return () => controller.abort();
  }, [needsDirectory, dataRevision, readKey, readSaved, reload]);

  return (
    <section className="copilot-users" aria-label="Users and adoption" aria-busy={loading && currentRoute.view === "licenses"}>
      <header className="copilot-users-header">
        <div>
          <h2>Users & adoption</h2>
          <p>{currentRoute.view === "licenses"
            ? "Effective paid M365 Copilot licenses and adoption."
            : currentRoute.view === "responsibility" ? "People explicitly responsible for saved agents, independent of licenses and usage."
              : "Active report users with verified current non-paid Copilot status."}</p>
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
      {error && currentRoute.view !== "responsibility" ? <div className="error-banner" role="alert">{error} Use Permissions in the top navigation for connection recovery.
        {" "}<button type="button" className="secondary" onClick={() => setReload(value => value + 1)}>Retry saved users</button></div> : null}
      {loading && currentRoute.view === "licenses" ? <p role="status">Loading saved Copilot license status and usage snapshots...</p> : null}
      {data && !currentData && currentRoute.view !== "responsibility" ? <p className="copilot-users-notice" role="status">Showing the last saved user snapshot. Current licensing and adoption recommendations are unverified until saved users reload.</p> : null}
      {currentRoute.view === "responsibility" ? <UserAgentResponsibility key={currentRoute.personId ?? "people"} route={currentRoute} onRouteChange={changeRoute} dataRevision={dataRevision} agentInventoryRevision={agentInventoryRevision} onOpenAgent={onOpenAgent} />
        : currentRoute.view === "activity" ? !accessDenied ? <ReportedUserActivity route={currentRoute} onRouteChange={changeRoute} dataRevision={dataRevision} agentInventoryRevision={agentInventoryRevision} directoryData={currentData} onOpenAgent={onOpenAgent}
        onAccessDenied={message => { directoryRequest.current?.abort(); setData(undefined); setRead({ key: readKey, status: "failed", error: message, accessDenied: true }); }} /> : null
        : data ? <CopilotUsersDashboard data={data} current={Boolean(currentData)} onInspectUser={(user, threshold) => setSelectedUser({ id: user.directory.objectId, threshold, key: selectionKey })} /> : null}
      {selected && selectedUser && data ? <CopilotUserDetail user={selected} data={data} current={Boolean(currentData)} threshold={selectedUser.threshold} returnFocusTo={cohortSelect} onClose={() => setSelectedUser(undefined)} onOpenAgent={onOpenAgent} dataRevision={dataRevision} agentInventoryRevision={agentInventoryRevision} /> : null}
    </section>
  );
}

function CopilotUsersDashboard({ data, current, onInspectUser }: {
  data: CopilotUsageUsersResponse; current: boolean; onInspectUser: (user: CopilotUsageUser, threshold: number) => void;
}) {
  const [search, setSearch] = useState("");
  const [cohort, setCohort] = useState<Cohort>("licensed");
  const [sorting, setSorting] = useState<SortingState>(defaultLicenseSorting);
  const [threshold, setThreshold] = useState(5);
  const [page, setPage] = useState(0);
  const directoryKnown = data.sources.directory.state === "available";
  const directoryCurrent = current && directoryKnown;
  const agentUsageFresh = current && data.sources.importedAgentUsage.state === "available";
  const appActivityFresh = current && data.sources.appActivity.state === "available";
  const licensedUsers = useMemo(() => data.users.filter(user => isCopilotServiceActive(user.copilotServiceState)), [data.users]);
  const attention = licensedUsers.filter(user => needsAttention(user, threshold, agentUsageFresh, appActivityFresh)).length;
  const measured = licensedUsers.filter(user => responses(user) !== null).length;
  const unknown = licensedUsers.length - measured;
  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return licensedUsers.filter(user => {
      if (query && ![
        user.directory.displayName, user.directory.userPrincipalName, user.directory.objectId,
        user.directory.companyName, user.directory.department,
        ...(user.importedUsage?.rows.flatMap(row => [row.displayAgentName, row.creatorType]) ?? []),
      ].some(value => value?.toLowerCase().includes(query))) return false;
      if (cohort === "attention") return directoryCurrent && needsAttention(user, threshold, agentUsageFresh, appActivityFresh);
      if (cohort === "unknown") return responses(user) === null;
      return true;
    });
  }, [agentUsageFresh, appActivityFresh, cohort, directoryCurrent, licensedUsers, search, threshold]);
  const columns = useMemo<ListColumn<CopilotUsageUser>[]>(() => [
    { id: "user", header: "User", accessorFn: name },
    { id: "license", header: "M365 Copilot license", accessorFn: user => copilotServicePresentation(user.copilotServiceState).label },
    { id: "responses", header: "Agent responses", accessorFn: user => responses(user) ?? undefined, sortDescFirst: true },
    {
      id: "agentsUsed", header: "Agents used",
      accessorFn: user => user.importedUsage && !user.importedUsage.missingUserReport ? user.importedUsage.reportedAgentsUsed : undefined,
      sortDescFirst: true,
    },
    { id: "activity", header: "Agent-report last activity", accessorFn: user => user.importedUsage?.userLastActivityDateUtc, sortDescFirst: true },
    {
      id: "followUp", header: "Follow-up",
      accessorFn: user => directoryCurrent
        ? recommendation(user, threshold, agentUsageFresh, appActivityFresh).label
        : "Verify paid license inventory",
    },
  ], [agentUsageFresh, appActivityFresh, directoryCurrent, threshold]);
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
  const noLicensedUsers = cohort === "licensed" && licensedUsers.length === 0 && !search.trim();

  function selectCohort(next: Cohort) {
    setCohort(next);
    setPage(0);
  }

  return <>
    {data.snapshot?.state === "not_synced" ? <p className="copilot-users-notice" role="status">No saved user data. Run Users sync from Sync in the top navigation.</p>
      : data.snapshot?.state === "partial" ? <p className="copilot-users-notice" role="status">Saved user snapshot is partial. Run Users sync from Sync in the top navigation.</p> : null}
    <div className="copilot-user-metrics" aria-label="M365 Copilot license summary">
      <Metric label="Active M365 Copilot licensed users" value={directoryCurrent ? data.counts.licensedUsers : null} hint="Verified paid access, not recent usage" />
      <Metric label="Using agents" value={directoryCurrent && agentUsageFresh ? licensedUsers.filter(user => (responses(user) ?? 0) > 0).length : null} hint="Licensed users with agent responses" />
      <Metric label="Needs attention" value={directoryCurrent ? attention : null} hint="Licensed users needing follow-up" />
      <Metric label="Agent usage unknown" value={directoryCurrent ? unknown : null} hint="Licensed users; not proof of inactivity" />
    </div>

    {!directoryKnown ? <div className="copilot-users-notice" role="status"><p>Current paid license inventory is unverified. {data.sources.directory.message} Use Sync or Permissions in the top navigation to refresh or reconnect.</p></div> : null}
    {data.sources.importedAgentUsage.state !== "available" ? <div className="copilot-users-notice" role="status">
      <p>{data.sources.importedAgentUsage.state === "stale" ? "Agent usage is out of date. Historical totals are shown, but are not used for low-usage recommendations." : "Agent usage is not available yet. Saved license status remains visible; missing usage is not zero."}</p>
      <p>Use <a href="/sync?reports=manage">Sync &gt; Manage reports</a> to inspect saved agent reports.</p>
    </div> : null}
    {data.sources.appActivity.state === "unavailable" ? <div className="copilot-users-notice" role="status">
      <p>Office app activity unavailable. {data.sources.appActivity.message}</p>
      <p>Use Permissions in the top navigation to review the connection.</p>
    </div> : data.sources.appActivity.state === "stale" ? <p><small>Office app activity is out of date. Last-known dates remain visible in user details.</small></p> : null}

    <div className="copilot-users-tabs" role="group" aria-label="Copilot user cohorts">
      {([
        ["licensed", "Licensed users"],
        ["attention", "Needs attention"],
        ["unknown", "Usage unknown"],
      ] as const).map(([value, label]) => <button key={value} type="button" className="secondary" aria-pressed={cohort === value} onClick={() => selectCohort(value)}>{label}</button>)}
    </div>

    <div className="copilot-users-toolbar" aria-label="Copilot user filters">
      <label><span>Search users or agents</span><input type="search" placeholder="Name, email, company, department or agent" value={search} onChange={event => { setSearch(event.target.value); setPage(0); }} /></label>
      <label><span>Order by</span><select value={licenseSorts.find(([, , id, desc]) => id === sorting[0]?.id && desc === sorting[0]?.desc)?.[0]} onChange={event => {
        const next = licenseSorts.find(([value]) => value === event.target.value);
        if (next) {
          setSorting([{ id: next[2], desc: next[3] }]);
          setPage(0);
        }
      }}>{licenseSorts.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      {cohort === "attention" ? <label><span>Low agent usage threshold</span><select value={threshold} onChange={event => { setThreshold(Number(event.target.value)); setPage(0); }}>
        {[5, 10, 20, 50].map(value => <option key={value} value={value}>{value} responses or fewer</option>)}
      </select></label> : null}
    </div>
    <p><small>{directoryCurrent
      ? `${filtered.length.toLocaleString()} licensed users shown`
      : `Last saved: ${filtered.length.toLocaleString()} previously licensed users shown; current licensing unverified`}{data.sources.importedAgentUsage.period.startDate && data.sources.importedAgentUsage.period.endDate ? ` | Agent report: ${data.sources.importedAgentUsage.period.startDate} to ${data.sources.importedAgentUsage.period.endDate}` : ""}. Rankings use agent responses, not total Copilot utilization.</small></p>

    {visible.length ? <div className="copilot-users-table-shell" role="region" aria-label="M365 Copilot license status" tabIndex={0}>
      <table className="copilot-users-table">
        <ListTableHead table={table} />
        <tbody>{visible.map(row => {
          const user = row.original;
          const followUp = directoryCurrent ? recommendation(user, threshold, agentUsageFresh, appActivityFresh) : { label: "Verify paid license inventory", tone: "unknown" };
          return <tr key={row.id}>
            <td><button type="button" className="user-name-button" aria-haspopup="dialog" onClick={() => onInspectUser(user, threshold)}>{name(user)}</button><small>{user.directory.userPrincipalName}</small>{user.directory.accountEnabled === false ? <small>Account disabled</small> : null}</td>
            <td><CopilotLicenseStatus user={user} current={directoryCurrent} /></td>
            <td data-numeric>{formatCount(responses(user))}{!agentUsageFresh && responses(user) !== null ? <small>Historical report</small> : null}</td>
            <td data-numeric>{formatCount(user.importedUsage && !user.importedUsage.missingUserReport ? user.importedUsage.reportedAgentsUsed : null)}</td>
            <td>{formatDate(user.importedUsage?.userLastActivityDateUtc)}<small>Users report only</small></td>
            <td><span className={`copilot-user-badge ${followUp.tone}`}>{followUp.label}</span></td>
          </tr>;
        })}</tbody>
      </table>
    </div> : <div className="copilot-users-empty">
      <h3>{directoryCurrent ? noLicensedUsers ? "No active M365 Copilot licenses found" : "No users match" : "No last-saved users in this cohort"}</h3>
      <p>{directoryCurrent
        ? noLicensedUsers ? "No users have verified active paid features in the saved inventory." : "Try a different cohort or search."
        : "Current licensing is unverified. Run Users sync from Sync in the top navigation."}</p>
      {search || cohort !== "licensed" ? <button className="secondary" type="button" onClick={() => { setSearch(""); selectCohort("licensed"); }}>Reset filters</button> : null}
    </div>}

    {filtered.length > pageSize ? <div className="copilot-users-pagination" aria-label="Copilot user pages">
      <button type="button" className="secondary" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>Previous</button>
      <span>{currentPage * pageSize + 1}-{Math.min((currentPage + 1) * pageSize, filtered.length)} of {filtered.length.toLocaleString()}</span>
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
      <p>{directoryCurrent ? `${measured.toLocaleString()} licensed users have matched agent response totals.` : "Current licensing cannot be determined until the directory inventory is available."} Identities are matched by exact identifiers, never by display name; renamed, hidden or unmatched users stay unresolved.</p>
      <p>Only verified active paid features establish current M365 Copilot licensing.</p>
      <p>App reports can lag by 48 hours and show last-known dates, not counts of prompts or daily activity. Current paid entitlement does not prove activity or coverage throughout the usage period.</p>
      <p>Low agent usage is a coaching signal, not a recommendation to remove a paid license. Review Office app activity and the employee&apos;s context first. No assignments are changed.</p>
      {data.notices.map(notice => <p key={notice}>{notice}</p>)}
    </details>
  </>;
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function CopilotUserDetail({ user, data, current, threshold, returnFocusTo, onClose, onOpenAgent, dataRevision, agentInventoryRevision }: {
  user: CopilotUsageUser; data: CopilotUsageUsersResponse; current: boolean; threshold: number; onClose: () => void;
  returnFocusTo: RefObject<HTMLSelectElement | null>;
  onOpenAgent?: (id: string) => void;
  dataRevision: number;
  agentInventoryRevision: number;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const imported = user.importedUsage;
  const fresh = current && data.sources.importedAgentUsage.state === "available";
  const directoryCurrent = current && data.sources.directory.state === "available";
  const followUp = directoryCurrent ? recommendation(user, threshold, fresh, data.sources.appActivity.state === "available") : { label: "Verify paid license inventory", tone: "unknown" };
  useEffect(() => {
    const element = dialog.current;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const fallbackFocus = returnFocusTo.current;
    const previousOverflow = document.body.style.overflow;
    element?.showModal();
    close.current?.focus();
    document.body.style.overflow = "hidden";
    return () => {
      element?.close();
      document.body.style.overflow = previousOverflow;
      (previousFocus?.isConnected ? previousFocus : fallbackFocus)?.focus();
    };
  }, [returnFocusTo]);
  return <dialog ref={dialog} className="copilot-user-dialog" aria-labelledby="copilot-user-name"
    onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); onClose(); } }}
    onCancel={event => { event.preventDefault(); onClose(); }}>
    <header>
      <div><h2 id="copilot-user-name">{name(user)}</h2><p>{user.directory.userPrincipalName}</p><span className={`copilot-user-badge ${followUp.tone}`}>{followUp.label}</span></div>
      <button ref={close} type="button" className="secondary icon-button" aria-label="Close user details" onClick={onClose}><X size={20} aria-hidden="true" /></button>
    </header>
    <div className="copilot-user-metrics">
      <div className="copilot-user-metric">
        <span>M365 Copilot license</span>
        <CopilotLicenseStatus user={user} current={directoryCurrent} />
        <small>{directoryCurrent ? "Current entitlement is not evidence of activity or historical coverage" : "Last saved evidence; current license and paid features unverified"}</small>
      </div>
      <Metric label="Agent responses" value={responses(user)} hint={fresh ? "Imported Users report total" : "Historical or missing report"} />
      <Metric label="Agents used" value={imported && !imported.missingUserReport ? imported.reportedAgentsUsed : null} hint="Imported Users report total" />
    </div>
    <section aria-label="Saved directory organization">
      <h3>Organization</h3>
      <p>Company: {user.directory.companyName || "Not reported"}</p>
      <p>Department: {user.directory.department || "Not reported"}</p>
      <p>Directory account: {user.directory.accountEnabled === false ? "Account disabled" : user.directory.accountEnabled === true ? "Enabled" : "Unknown"}</p>
    </section>
    <CopilotServiceDetails servicePlans={user.servicePlans} copilotServiceState={user.copilotServiceState} current={directoryCurrent} />
    <UserAgentResponsibility key={user.directory.objectId} objectId={directoryCurrent ? user.directory.objectId : undefined} dataRevision={dataRevision} agentInventoryRevision={agentInventoryRevision} onOpenAgent={onOpenAgent} />
    <section aria-label="User agent activity">
      <h3>Agent usage</h3>
      <p>{data.sources.importedAgentUsage.period.startDate ?? "Unknown start"} to {data.sources.importedAgentUsage.period.endDate ?? "unknown end"}. Includes Microsoft-built agents when present in the imported report.</p>
      {imported?.hasReportMismatch ? <p className="copilot-users-notice">The Users total and Users &amp; agents breakdown differ. They are shown separately, not added together.</p> : null}
      {imported ? <>
        <p>Responses in all Users &amp; agents rows: <strong>{imported.rows.length ? imported.bridgeResponsesSentToUsers.toLocaleString() : "Not reported"}</strong>. This independent breakdown never replaces a missing Users-report total.</p>
        <ReportedUserAgents user={imported} />
      </> : <p>No matched agent breakdown. This does not establish zero activity.</p>}
    </section>
    <section aria-label="User Office app activity">
      <h3>Copilot in Office apps</h3>
      <p>{user.appActivity ? `Last known activity by app. Report refreshed ${formatDate(user.appActivity.reportRefreshDate)}${data.sources.appActivity.state === "stale" ? " (out of date)" : ""}; dates can fall outside the selected report period.` : "No uniquely matched app-usage report. Check reporting permissions and whether report identities are concealed."}</p>
      <ul className="copilot-app-activity">{appFields.map(([label, field]) => <li key={field}><strong>{label}</strong><small>{!user.appActivity ? "Unknown" : user.appActivity[field] ? formatDate(user.appActivity[field]) : "No date reported"}</small></li>)}</ul>
    </section>
    <UserPurviewAudit userPrincipalName={directoryCurrent ? user.directory.userPrincipalName : undefined} />
  </dialog>;
}

function responses(user: CopilotUsageUser): number | null {
  return user.importedUsage && !user.importedUsage.missingUserReport ? user.importedUsage.reportedResponsesReceived : null;
}

function name(user: CopilotUsageUser) {
  return user.directory.displayName || user.directory.userPrincipalName;
}

function needsAttention(user: CopilotUsageUser, threshold: number, agentUsageFresh: boolean, appActivityFresh: boolean) {
  const count = responses(user);
  return copilotServicePresentation(user.copilotServiceState).needsAttention || user.directory.accountEnabled === false
    || (appActivityFresh && user.attention.includes("app_activity_inactive")) || (agentUsageFresh && count !== null && count <= threshold);
}

function recommendation(user: CopilotUsageUser, threshold: number, agentUsageFresh: boolean, appActivityFresh: boolean) {
  const count = responses(user);
  const service = copilotServicePresentation(user.copilotServiceState);
  if (user.directory.accountEnabled === false) return { label: "Review disabled account", tone: "attention" };
  if (service.needsAttention) return { label: user.copilotServiceState === "unknown" ? "Verify paid features" : "Review paid features", tone: service.tone };
  if (agentUsageFresh && count === 0) return { label: "Explore agents", tone: "attention" };
  if (agentUsageFresh && count !== null && count <= threshold) return { label: "Offer adoption help", tone: "attention" };
  if (appActivityFresh && user.attention.includes("app_activity_inactive")) return { label: "Review app activity", tone: "attention" };
  if (!agentUsageFresh && count !== null) return { label: "Refresh agent report", tone: "unknown" };
  if (count === null) return { label: "Usage unknown", tone: "unknown" };
  return { label: "Using agents", tone: "" };
}

function Metric({ label, value, hint }: { label: string; value: number | string | null; hint: string }) {
  return <div className="copilot-user-metric"><span>{label}</span><strong>{typeof value === "string" ? value : formatCount(value)}</strong><small>{hint}</small></div>;
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
