import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { X } from "lucide-react";
import {
  ApiError,
  getCopilotUsageUsers,
  type CopilotAppActivity,
  type CopilotUsageSourceSummary,
  type CopilotUsageUser,
  type CopilotUsageUsersResponse,
} from "../api/client";
import type { UsersRouteState } from "../workbenchRouting";
import { ReportedUserActivity } from "./ReportedUserActivity";
import { ReportedUserAgents } from "./ReportedUserAgents";
import "./copilotUsers.css";

type Cohort = "all" | "attention" | "unknown";
type Sort = "responses-desc" | "responses-asc" | "name" | "activity";
type ReadState = { key: object; status: "ready" } | { key: object; status: "failed"; error: string; accessDenied?: boolean };
const pageSize = 50;
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
  route,
  onRouteChange,
}: {
  dataRevision?: number;
  route?: UsersRouteState;
  onRouteChange?: (route: UsersRouteState, replace?: boolean) => void;
}) {
  const [data, setData] = useState<CopilotUsageUsersResponse>();
  const [read, setRead] = useState<ReadState>();
  const [reload, setReload] = useState(0);
  const [internalRoute, setInternalRoute] = useState<UsersRouteState>({ view: "licenses", search: "", page: 0 });
  const [selectedUser, setSelectedUser] = useState<{ id: string; threshold: number; key: object }>();
  const activityViewButton = useRef<HTMLButtonElement>(null);
  const directoryRequest = useRef<AbortController | null>(null);
  const readKey = useMemo(() => ({ dataRevision, reload }), [dataRevision, reload]);
  const scopedRead = read?.key === readKey ? read : undefined;
  const loading = !scopedRead;
  const currentData = scopedRead?.status === "ready" ? data : undefined;
  const error = scopedRead?.status === "failed" ? scopedRead.error : undefined;
  const accessDenied = scopedRead?.status === "failed" && scopedRead.accessDenied;
  const currentRoute = route ?? internalRoute;
  const selectionKey = useMemo(() => ({ readKey, view: currentRoute.view }), [readKey, currentRoute.view]);
  const selected = selectedUser?.key === selectionKey
    ? data?.users.find(user => user.directory.objectId === selectedUser.id)
    : undefined;

  function changeRoute(next: UsersRouteState, replace = false) {
    setInternalRoute(next);
    onRouteChange?.(next, replace);
  }

  useEffect(() => {
    const controller = new AbortController();
    directoryRequest.current = controller;
    void getCopilotUsageUsers({ signal: controller.signal }).then(result => {
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
        setRead({ key: readKey, status: "failed", error: failure instanceof Error ? failure.message : "License usage could not be loaded.", accessDenied: denied });
      }
    });
    return () => controller.abort();
  }, [readKey]);

  return (
    <section className="copilot-users" aria-label="Users and adoption" aria-busy={loading && currentRoute.view === "licenses"}>
      <header className="copilot-users-header">
        <div>
          <h2>Users & adoption</h2>
          <p>{currentRoute.view === "licenses"
            ? "Current Microsoft 365 Copilot assignments, including qualifying bundles. Microsoft 365 or Office 365 base licenses and free Copilot Chat alone are not counted."
            : "Explore reported user activity across all agents, independently of current directory license coverage."}</p>
        </div>
        <div className="copilot-users-header-actions">
          <div className="copilot-users-tabs" role="group" aria-label="User views">
            <button type="button" className="secondary" aria-pressed={currentRoute.view === "licenses"} onClick={() => changeRoute({ view: "licenses", search: "", page: 0 })}>License adoption</button>
            <button ref={activityViewButton} type="button" className="secondary" aria-pressed={currentRoute.view === "activity"} onClick={() => changeRoute({ ...currentRoute, view: "activity" })}>Reported activity</button>
          </div>
        </div>
      </header>
      {error ? <div className="error-banner" role="alert">{error} Use Permissions in the top navigation for connection recovery.
        {" "}<button type="button" className="secondary" onClick={() => setReload(value => value + 1)}>Retry saved users</button></div> : null}
      {loading && currentRoute.view === "licenses" ? <p role="status">Loading saved license assignments and usage snapshots...</p> : null}
      {data && !currentData ? <p className="copilot-users-notice" role="status">Showing the last saved user snapshot. Current license assignments and adoption recommendations are unverified until saved users reload.</p> : null}
      {currentRoute.view === "activity" ? !accessDenied ? <ReportedUserActivity route={currentRoute} onRouteChange={changeRoute} dataRevision={dataRevision} directoryData={currentData}
        onAccessDenied={message => { directoryRequest.current?.abort(); setData(undefined); setRead({ key: readKey, status: "failed", error: message, accessDenied: true }); }} /> : null
        : data ? <CopilotUsersDashboard data={data} current={Boolean(currentData)} onInspectUser={(user, threshold) => setSelectedUser({ id: user.directory.objectId, threshold, key: selectionKey })}
          onViewReportedUser={(username, reportSetId) => changeRoute({ view: "activity", search: username, reportSetId, page: 0 })} /> : null}
      {selected && selectedUser && data ? <CopilotUserDetail user={selected} data={data} current={Boolean(currentData)} threshold={selectedUser.threshold} returnFocusTo={activityViewButton} onClose={() => setSelectedUser(undefined)}
        onViewAgent={(agentId, reportSetId) => {
          setSelectedUser(undefined);
          changeRoute({ view: "activity", agentId, reportSetId, search: "", page: 0 });
        }} /> : null}
    </section>
  );
}

function CopilotUsersDashboard({ data, current, onInspectUser, onViewReportedUser }: {
  data: CopilotUsageUsersResponse; current: boolean; onInspectUser: (user: CopilotUsageUser, threshold: number) => void;
  onViewReportedUser: (username: string, reportSetId: string) => void;
}) {
  const [search, setSearch] = useState("");
  const [cohort, setCohort] = useState<Cohort>("all");
  const [sort, setSort] = useState<Sort>("responses-desc");
  const [threshold, setThreshold] = useState(5);
  const [page, setPage] = useState(0);
  const directoryKnown = data.sources.directory.state === "available";
  const directoryCurrent = current && directoryKnown;
  const agentUsageFresh = current && data.sources.importedAgentUsage.state === "available";
  const appActivityFresh = current && data.sources.appActivity.state === "available";
  const attention = data.users.filter(user => needsAttention(user, threshold, agentUsageFresh, appActivityFresh)).length;
  const measured = data.users.filter(user => responses(user) !== null).length;
  const unknown = data.users.length - measured;
  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return data.users.filter(user => {
      if (query && ![
        user.directory.displayName, user.directory.userPrincipalName, user.directory.objectId, user.directory.department,
        ...(user.importedUsage?.rows.flatMap(row => [row.displayAgentName, row.creatorType]) ?? []),
      ].some(value => value?.toLowerCase().includes(query))) return false;
      if (cohort === "attention") return directoryCurrent && needsAttention(user, threshold, agentUsageFresh, appActivityFresh);
      if (cohort === "unknown") return responses(user) === null;
      return true;
    }).sort((a, b) => {
      if (sort === "name") return name(a).localeCompare(name(b)) || a.directory.objectId.localeCompare(b.directory.objectId);
      if (sort === "activity") return (b.importedUsage?.userLastActivityDateUtc ?? "").localeCompare(a.importedUsage?.userLastActivityDateUtc ?? "") || name(a).localeCompare(name(b));
      const left = responses(a);
      const right = responses(b);
      if (left === null && right !== null) return 1;
      if (right === null && left !== null) return -1;
      return (sort === "responses-asc" ? 1 : -1) * ((left ?? 0) - (right ?? 0)) || name(a).localeCompare(name(b));
    });
  }, [agentUsageFresh, appActivityFresh, cohort, data.users, directoryCurrent, search, sort, threshold]);
  const lastPage = Math.max(0, Math.ceil(filtered.length / pageSize) - 1);
  const currentPage = Math.min(page, lastPage);
  const visible = filtered.slice(currentPage * pageSize, (currentPage + 1) * pageSize);

  function selectCohort(next: Cohort) {
    setCohort(next);
    setPage(0);
  }

  return <>
    {data.snapshot ? (
      <div className={`copilot-users-snapshot${data.snapshot.state === "available" ? " compact" : ""}`} role="status">
        <strong>
          {data.snapshot.state === "not_synced"
            ? "Saved user data has never been collected."
            : data.snapshot.state === "partial" ? "Saved user snapshot is partial." : "Saved user snapshot is available."}
        </strong>
        <span>
          Last successful sync: {data.snapshot.lastSuccessAt ? formatDateTime(data.snapshot.lastSuccessAt) : "never"}.
        </span>
      </div>
    ) : null}
    <div className="copilot-user-metrics" aria-label="Licensed user summary">
      <Metric label="Licensed users" value={directoryCurrent ? data.users.length : null} hint="Microsoft 365 Copilot, not all Microsoft 365 licenses" />
      <Metric label="Using agents" value={directoryCurrent && agentUsageFresh ? data.users.filter(user => (responses(user) ?? 0) > 0).length : null} hint="At least one reported agent response" />
      <Metric label="Needs attention" value={directoryCurrent ? attention : null} hint="Adoption or assignment follow-up" />
      <Metric label="Agent usage unknown" value={directoryCurrent ? unknown : null} hint="Not evidence of an unused license" />
    </div>

    {!directoryKnown ? <div className="copilot-users-notice" role="status"><p>Current license inventory is unverified. {data.sources.directory.message} Use Sync or Permissions in the top navigation to refresh or reconnect.</p></div> : null}
    {data.sources.importedAgentUsage.state !== "available" ? <div className="copilot-users-notice" role="status">
      <p>{data.sources.importedAgentUsage.state === "stale" ? "Agent usage is out of date. Historical totals are shown, but are not used for low-usage recommendations." : "Agent usage is not available yet. Licensed users remain listed; missing usage is not zero."}</p>
      <p>Use Official usage in the top navigation to manage agent reports.</p>
    </div> : null}
    {data.sources.appActivity.state === "unavailable" ? <div className="copilot-users-notice" role="status">
      <p>Office app activity unavailable. {data.sources.appActivity.message}</p>
      <p>Use Permissions in the top navigation to review the connection.</p>
    </div> : data.sources.appActivity.state === "stale" ? <p><small>Office app activity is out of date. Last-known dates remain visible in user details.</small></p> : null}

    <div className="copilot-users-tabs" role="group" aria-label="License usage cohorts">
      {([
        ["all", "All licensed"],
        ["attention", "Needs attention"],
        ["unknown", "Usage unknown"],
      ] as const).map(([value, label]) => <button key={value} type="button" className="secondary" aria-pressed={cohort === value} onClick={() => selectCohort(value)}>{label}</button>)}
    </div>

    <div className="copilot-users-toolbar" aria-label="Licensed user filters">
      <label><span>Search users or agents</span><input type="search" placeholder="Name, email, agent or Microsoft" value={search} onChange={event => { setSearch(event.target.value); setPage(0); }} /></label>
      <label><span>Order by</span><select value={sort} onChange={event => {
        const value = event.target.value;
        if (value === "responses-desc" || value === "responses-asc" || value === "activity" || value === "name") { setSort(value); setPage(0); }
      }}>
        <option value="responses-desc">Most agent responses</option><option value="responses-asc">Fewest agent responses</option><option value="activity">Latest agent-report activity</option><option value="name">Name</option>
      </select></label>
      {cohort === "attention" ? <label><span>Low agent usage threshold</span><select value={threshold} onChange={event => { setThreshold(Number(event.target.value)); setPage(0); }}>
        {[5, 10, 20, 50].map(value => <option key={value} value={value}>{value} responses or fewer</option>)}
      </select></label> : null}
    </div>
    <p><small>{directoryCurrent ? `${filtered.length.toLocaleString()} licensed users` : "Current license count unavailable; any listed assignments are last saved"}{data.sources.importedAgentUsage.period.startDate && data.sources.importedAgentUsage.period.endDate ? ` | Agent report: ${data.sources.importedAgentUsage.period.startDate} to ${data.sources.importedAgentUsage.period.endDate}` : ""}. Rankings use agent responses, not total Copilot utilization.</small></p>

    {visible.length ? <div className="copilot-users-table-shell" role="region" aria-label="Licensed users" tabIndex={0}>
      <table className="copilot-users-table">
        <thead><tr><th scope="col">User</th><th scope="col">License</th><th scope="col">Agent responses</th><th scope="col">Agents used</th><th scope="col">Agent-report last activity</th><th scope="col">Follow-up</th></tr></thead>
        <tbody>{visible.map(user => {
          const followUp = directoryCurrent ? recommendation(user, threshold, agentUsageFresh, appActivityFresh) : { label: "Verify license inventory", tone: "unknown" };
          return <tr key={user.directory.objectId}>
            <td><button type="button" className="user-name-button" aria-haspopup="dialog" onClick={() => onInspectUser(user, threshold)}>{name(user)}</button><small>{user.directory.userPrincipalName}</small>{user.directory.accountEnabled === false ? <small>Account disabled</small> : null}</td>
            <td><span className={`copilot-user-badge ${directoryCurrent ? licenseIssue(user) ? "attention" : "" : "unknown"}`}>{directoryCurrent ? licenseLabel(user) : `Last saved: ${licenseLabel(user)}`}</span></td>
            <td data-numeric>{formatCount(responses(user))}{!agentUsageFresh && responses(user) !== null ? <small>Historical report</small> : null}</td>
            <td data-numeric>{formatCount(user.importedUsage && !user.importedUsage.missingUserReport ? user.importedUsage.reportedAgentsUsed : null)}</td>
            <td>{formatDate(user.importedUsage?.userLastActivityDateUtc)}<small>Users report only</small></td>
            <td><span className={`copilot-user-badge ${followUp.tone}`}>{followUp.label}</span></td>
          </tr>;
        })}</tbody>
      </table>
    </div> : <div className="copilot-users-empty">
      <h3>{directoryKnown ? data.users.length ? "No users match" : "No Microsoft 365 Copilot assignments found" : "Connect the license inventory to see licensed users"}</h3>
      <p>{directoryKnown ? data.users.length ? "Try a different cohort or search." : "Free Copilot Chat and Copilot Studio licenses are not counted as Microsoft 365 Copilot seats." : "Imported identities are retained below, but their license status has not been verified."}</p>
      {search || cohort !== "all" ? <button className="secondary" type="button" onClick={() => { setSearch(""); selectCohort("all"); }}>Reset filters</button> : null}
    </div>}

    {filtered.length > pageSize ? <div className="copilot-users-pagination" aria-label="Licensed user pages">
      <button type="button" className="secondary" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>Previous</button>
      <span>{currentPage * pageSize + 1}-{Math.min((currentPage + 1) * pageSize, filtered.length)} of {filtered.length.toLocaleString()}</span>
      <button type="button" className="secondary" disabled={currentPage >= lastPage} onClick={() => setPage(currentPage + 1)}>Next</button>
    </div> : null}

    <details className="copilot-users-provenance">
      <summary>Data sources and coverage</summary>
      {data.snapshot ? <p>Directory observed: {data.snapshot.directoryObservedAt ? formatDateTime(data.snapshot.directoryObservedAt) : "never"}.
        {" "}App activity observed: {data.snapshot.appActivityObservedAt ? formatDateTime(data.snapshot.appActivityObservedAt) : "never"}.</p> : null}
      <dl>{([
        ["License assignments", data.sources.directory],
        ["Agent activity", data.sources.importedAgentUsage],
        ["Office app activity", data.sources.appActivity],
      ] as const).map(([label, source]) => <div key={label}><dt>{label}: {sourceLabel(source)}</dt><dd>{source.message}</dd><dd>Checked: {formatDate(source.fetchedAt)}{source.reportRefreshDate ? ` | Report refreshed: ${formatDate(source.reportRefreshDate)}` : ""}{source.reportVersion ? ` | Version: ${source.reportVersion}` : ""}</dd>{source.period.startDate || source.period.endDate ? <dd>Range: {source.period.startDate ?? "Unknown"} to {source.period.endDate ?? "Unknown"}</dd> : null}</div>)}</dl>
      <p>{directoryKnown ? `${measured.toLocaleString()} licensed users have matched agent response totals.` : "License coverage cannot be determined until the directory inventory is available."} Identities are matched by exact identifiers, never by display name; renamed, hidden or unmatched users stay unresolved.</p>
      <p>App reports can lag by 48 hours and show last-known dates, not counts of prompts or daily activity. Current assignments do not prove a license was held throughout the usage period.</p>
      <p>Low agent usage is a coaching signal, not a recommendation to remove a license. Review Office app activity and the employee&apos;s context first. No licenses are changed.</p>
      {data.notices.map(notice => <p key={notice}>{notice}</p>)}
    </details>
    {data.unresolvedImportedIdentities.length ? <UnlinkedReportIdentities identities={data.unresolvedImportedIdentities} onViewReportedUser={onViewReportedUser} /> : null}
  </>;
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function UnlinkedReportIdentities({ identities, onViewReportedUser }: {
  identities: CopilotUsageUsersResponse["unresolvedImportedIdentities"];
  onViewReportedUser: (username: string, reportSetId: string) => void;
}) {
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return identities.filter(row => !query || [row.importedUsage.displayName, row.importedUsage.username]
      .some(value => value.toLowerCase().includes(query)));
  }, [identities, search]);
  const lastPage = Math.max(0, Math.ceil(filtered.length / pageSize) - 1);
  const currentPage = Math.min(page, lastPage);
  const visible = filtered.slice(currentPage * pageSize, (currentPage + 1) * pageSize);
  return <details className="copilot-users-provenance">
    <summary>Unlinked report identities ({identities.length.toLocaleString()})</summary>
    <p>These report identities cannot be linked uniquely to a currently licensed directory user. They may be concealed, renamed or no longer licensed; no license status is inferred. Every identity is available below.</p>
    <div className="copilot-users-toolbar"><label><span>Search unlinked report identities</span><input type="search" value={search} maxLength={256} onChange={event => { setSearch(event.target.value); setPage(0); }} /></label></div>
    {visible.length ? <div className="copilot-users-table-shell" role="region" aria-label="Unlinked report identities" tabIndex={0}>
      <table className="copilot-users-table"><thead><tr><th scope="col">Reported identity</th><th scope="col">Responses (Users report)</th><th scope="col">Current license</th><th scope="col">Reported activity</th></tr></thead>
        <tbody>{visible.map(row => {
          const reportSetId = row.importedUsage.datasetScope.reportSetId;
          return <tr key={JSON.stringify([row.importedUsage.datasetScope, row.importedUsage.username])}>
            <td>{row.importedUsage.displayName || row.importedUsage.username}<small>{row.importedUsage.username}</small></td>
            <td>{row.importedUsage.missingUserReport ? "Unknown" : row.importedUsage.reportedResponsesReceived.toLocaleString()}</td>
            <td>Unknown</td>
            <td>{reportSetId ? <button type="button" className="secondary" onClick={() => onViewReportedUser(row.importedUsage.username, reportSetId)}>View reported activity</button> : "Report snapshot unavailable"}</td>
          </tr>;
        })}</tbody>
      </table>
    </div> : <p>No unlinked report identities match. Clear the search to see all saved identities.</p>}
    <div className="copilot-users-pagination" aria-label="Unlinked identity pages">
      <span>{filtered.length ? `${(currentPage * pageSize + 1).toLocaleString()}-${Math.min((currentPage + 1) * pageSize, filtered.length).toLocaleString()} of ${filtered.length.toLocaleString()}` : "No matching identities"}</span>
      <button type="button" className="secondary" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>Previous unlinked identities</button>
      <button type="button" className="secondary" disabled={currentPage === lastPage} onClick={() => setPage(currentPage + 1)}>Next unlinked identities</button>
    </div>
  </details>;
}

function CopilotUserDetail({ user, data, current, threshold, returnFocusTo, onClose, onViewAgent }: {
  user: CopilotUsageUser; data: CopilotUsageUsersResponse; current: boolean; threshold: number; onClose: () => void;
  returnFocusTo: RefObject<HTMLButtonElement | null>;
  onViewAgent: (agentId: string, reportSetId?: string) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const imported = user.importedUsage;
  const fresh = current && data.sources.importedAgentUsage.state === "available";
  const followUp = current && data.sources.directory.state === "available" ? recommendation(user, threshold, fresh, data.sources.appActivity.state === "available") : { label: "Verify license inventory", tone: "unknown" };
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
      <div><h2 id="copilot-user-name">{name(user)}</h2><p>{user.directory.userPrincipalName}{user.directory.department ? ` | ${user.directory.department}` : ""}</p><span className={`copilot-user-badge ${followUp.tone}`}>{followUp.label}</span></div>
      <button ref={close} type="button" className="secondary icon-button" aria-label="Close user details" onClick={onClose}><X size={20} aria-hidden="true" /></button>
    </header>
    <div className="copilot-user-metrics">
      <Metric label="License" value={licenseLabel(user)} hint={current && data.sources.directory.state === "available" ? "Current Entra assignment" : "Last saved Entra assignment"} />
      <Metric label="Agent responses" value={responses(user)} hint={fresh ? "Imported Users report total" : "Historical or missing report"} />
      <Metric label="Agents used" value={imported && !imported.missingUserReport ? imported.reportedAgentsUsed : null} hint="Imported Users report total" />
    </div>
    <section aria-label="User license details">
      <h3>License assignment</h3>
      <p>{user.licenses.map(license => `${license.skuPartNumber}: ${license.state}`).join("; ")}{user.directory.accountEnabled === false ? ". This directory account is disabled." : ""}</p>
      <details className="copilot-users-provenance">
        <summary>License and service-plan details</summary>
        {user.licenses.map(license => <p key={license.skuId}>
          <strong>{license.skuPartNumber}</strong> ({license.skuId})
          {license.assignmentStates.map((assignment, index) => <span key={index}> | {assignment.assignedByGroup ? "Group assignment" : "Direct assignment"}: {assignment.state}{assignment.error ? ` (${assignment.error})` : ""}</span>)}
          {license.disabledPlanIds.length ? <span> | Disabled plans: {license.disabledPlanIds.join(", ")}</span> : null}
        </p>)}
        {user.servicePlans.length ? <ul>{user.servicePlans.map(plan => <li key={plan.servicePlanId}>{plan.service} ({plan.servicePlanId}): <strong>{plan.capabilityStatus}</strong></li>)}</ul> : <p>Service-plan status not reported.</p>}
        <p>SKU assignment and individual service-plan status are separate. Warning is a grace-period state, not disabled.</p>
      </details>
    </section>
    <section aria-label="User agent activity">
      <h3>Agent usage</h3>
      <p>{data.sources.importedAgentUsage.period.startDate ?? "Unknown start"} to {data.sources.importedAgentUsage.period.endDate ?? "unknown end"}. Includes Microsoft-built agents when present in the imported report.</p>
      {imported?.hasReportMismatch ? <p className="copilot-users-notice">The Users total and Users &amp; agents breakdown differ. They are shown separately, not added together.</p> : null}
      {imported ? <>
        <p>Responses in all Users &amp; agents rows: <strong>{imported.rows.length ? imported.bridgeResponsesSentToUsers.toLocaleString() : "Not reported"}</strong>. This independent breakdown never replaces a missing Users-report total.</p>
        <ReportedUserAgents user={imported} onFocusAgent={onViewAgent} />
      </> : <p>No matched agent breakdown. This does not establish zero activity.</p>}
    </section>
    <section aria-label="User Office app activity">
      <h3>Copilot in Office apps</h3>
      <p>{user.appActivity ? `Last known activity by app. Report refreshed ${formatDate(user.appActivity.reportRefreshDate)}${data.sources.appActivity.state === "stale" ? " (out of date)" : ""}; dates can fall outside the selected report period.` : "No uniquely matched app-usage report. Check reporting permissions and whether report identities are concealed."}</p>
      <ul className="copilot-app-activity">{appFields.map(([label, field]) => <li key={field}><strong>{label}</strong><small>{!user.appActivity ? "Unknown" : user.appActivity[field] ? formatDate(user.appActivity[field]) : "No date reported"}</small></li>)}</ul>
    </section>
    <footer>
      <p>For timestamped events, use Audit in the top navigation. Audit metadata is separate from usage totals and excludes prompt/response content.</p>
    </footer>
  </dialog>;
}

function responses(user: CopilotUsageUser): number | null {
  return user.importedUsage && !user.importedUsage.missingUserReport ? user.importedUsage.reportedResponsesReceived : null;
}

function name(user: CopilotUsageUser) {
  return user.directory.displayName || user.directory.userPrincipalName;
}

function licenseIssue(user: CopilotUsageUser) {
  return user.licenses.some(license => license.state === "disabled" || license.state === "error") || user.directory.accountEnabled === false;
}

function licenseLabel(user: CopilotUsageUser) {
  if (user.licenses.some(license => license.state === "error")) return "Assignment issue";
  if (user.licenses.every(license => license.state === "disabled")) return "Assigned, disabled";
  if (user.licenses.some(license => license.state === "enabled")) return "Licensed";
  return "Assigned";
}

function needsAttention(user: CopilotUsageUser, threshold: number, agentUsageFresh: boolean, appActivityFresh: boolean) {
  const count = responses(user);
  return licenseIssue(user) || (appActivityFresh && user.attention.includes("app_activity_inactive")) || (agentUsageFresh && count !== null && count <= threshold);
}

function recommendation(user: CopilotUsageUser, threshold: number, agentUsageFresh: boolean, appActivityFresh: boolean) {
  const count = responses(user);
  if (licenseIssue(user)) return { label: "Review assignment", tone: "attention" };
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
