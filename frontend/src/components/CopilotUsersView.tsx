import { useEffect, useMemo, useRef, useState } from "react";
import { RefreshCw, X } from "lucide-react";
import {
  ApiError,
  getCopilotUsageUsers,
  type CopilotAppActivity,
  type CopilotUsageSourceSummary,
  type CopilotUsageUser,
  type CopilotUsageUsersResponse,
} from "../api/client";
import "./copilotUsers.css";

type Cohort = "all" | "attention" | "most" | "least" | "unknown";
type Sort = "responses-desc" | "responses-asc" | "name" | "activity";
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
  onSyncUsers,
}: {
  dataRevision?: number;
  onSyncUsers?: () => Promise<void>;
}) {
  const [data, setData] = useState<CopilotUsageUsersResponse>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    void Promise.resolve().then(() => {
      if (controller.signal.aborted) return undefined;
      setLoading(true);
      setError(undefined);
      return getCopilotUsageUsers({ signal: controller.signal });
    }).then(result => {
      if (!result) return;
      if (!controller.signal.aborted) setData(result);
    }).catch((failure: unknown) => {
      if (!controller.signal.aborted) {
        if (failure instanceof ApiError && (failure.status === 401 || failure.status === 403)) {
          setData(undefined);
        }
        setError(failure instanceof Error ? failure.message : "License usage could not be loaded.");
      }
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [dataRevision]);

  async function syncUsers() {
    if (!onSyncUsers) return;
    setSyncing(true);
    setError(undefined);
    try {
      await onSyncUsers();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "The users sync could not be started.");
    } finally {
      setSyncing(false);
    }
  }

  return (
    <section className="copilot-users" aria-label="Copilot license usage" aria-busy={loading}>
      <header className="copilot-users-header">
        <div>
          <h2>Copilot license usage</h2>
          <p>Current Microsoft 365 Copilot assignments, including qualifying bundles. Microsoft 365 or Office 365 base licenses and free Copilot Chat alone are not counted.</p>
        </div>
        <button type="button" className="secondary" disabled={!onSyncUsers || syncing} onClick={() => void syncUsers()}>
          <RefreshCw size={16} className={syncing ? "spin" : undefined} aria-hidden="true" />{syncing ? "Starting sync..." : "Sync users"}
        </button>
      </header>
      {error ? <div className="error-banner" role="alert">{error} <a href="/permissions">Check permissions</a>, then retry.</div> : null}
      {loading ? <p role="status">Loading saved license assignments and usage snapshots...</p> : null}
      {data ? <CopilotUsersDashboard data={data} /> : null}
    </section>
  );
}

function CopilotUsersDashboard({ data }: { data: CopilotUsageUsersResponse }) {
  const [search, setSearch] = useState("");
  const [cohort, setCohort] = useState<Cohort>("all");
  const [sort, setSort] = useState<Sort>("responses-desc");
  const [threshold, setThreshold] = useState(5);
  const [page, setPage] = useState(0);
  const [selectedId, setSelectedId] = useState<string>();
  const directoryKnown = data.sources.directory.state === "available";
  const agentUsageFresh = data.sources.importedAgentUsage.state === "available";
  const attention = data.users.filter(user => needsAttention(user, threshold, agentUsageFresh)).length;
  const measured = data.users.filter(user => responses(user) !== null).length;
  const unknown = data.users.length - measured;
  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return data.users.filter(user => {
      if (query && ![
        user.directory.displayName, user.directory.userPrincipalName, user.directory.objectId, user.directory.department,
        ...(user.importedUsage?.rows.flatMap(row => [row.displayAgentName, row.creatorType]) ?? []),
      ].some(value => value?.toLowerCase().includes(query))) return false;
      if (cohort === "attention") return needsAttention(user, threshold, agentUsageFresh);
      if (cohort === "unknown") return responses(user) === null;
      if (cohort === "most" || cohort === "least") return responses(user) !== null;
      return true;
    }).sort((a, b) => {
      if (sort === "name") return name(a).localeCompare(name(b)) || a.directory.objectId.localeCompare(b.directory.objectId);
      if (sort === "activity") return (lastActivity(b) ?? "").localeCompare(lastActivity(a) ?? "") || name(a).localeCompare(name(b));
      const left = responses(a);
      const right = responses(b);
      if (left === null && right !== null) return 1;
      if (right === null && left !== null) return -1;
      return (sort === "responses-asc" ? 1 : -1) * ((left ?? 0) - (right ?? 0)) || name(a).localeCompare(name(b));
    });
  }, [agentUsageFresh, cohort, data.users, search, sort, threshold]);
  const lastPage = Math.max(0, Math.ceil(filtered.length / pageSize) - 1);
  const currentPage = Math.min(page, lastPage);
  const visible = filtered.slice(currentPage * pageSize, (currentPage + 1) * pageSize);
  const selected = data.users.find(user => user.directory.objectId === selectedId);

  function selectCohort(next: Cohort) {
    setCohort(next);
    setSort(next === "least" ? "responses-asc" : "responses-desc");
    setPage(0);
  }

  return <>
    {data.snapshot ? (
      <div className="copilot-users-snapshot" role="status">
        <strong>
          {data.snapshot.state === "not_synced"
            ? "Saved user data has never been collected."
            : data.snapshot.state === "partial" ? "Saved user snapshot is partial." : "Saved user snapshot is available."}
        </strong>
        <span>
          Last successful sync: {data.snapshot.lastSuccessAt ? formatDateTime(data.snapshot.lastSuccessAt) : "never"}.
          Directory observed: {data.snapshot.directoryObservedAt ? formatDateTime(data.snapshot.directoryObservedAt) : "never"}.
          App activity observed: {data.snapshot.appActivityObservedAt ? formatDateTime(data.snapshot.appActivityObservedAt) : "never"}.
        </span>
      </div>
    ) : null}
    <div className="copilot-user-metrics" aria-label="Licensed user summary">
      <Metric label="Licensed users" value={directoryKnown ? data.users.length : null} hint="Microsoft 365 Copilot, not all Microsoft 365 licenses" />
      <Metric label="Using agents" value={directoryKnown && agentUsageFresh ? data.users.filter(user => (responses(user) ?? 0) > 0).length : null} hint="At least one reported agent response" />
      <Metric label="Needs attention" value={directoryKnown ? attention : null} hint="Adoption or assignment follow-up" />
      <Metric label="Agent usage unknown" value={directoryKnown ? unknown : null} hint="Not evidence of an unused license" />
    </div>

    {!directoryKnown ? <div className="copilot-users-notice" role="status"><p>License inventory unavailable. {data.sources.directory.message}</p><a href="/permissions">Connect license data</a></div> : null}
    {data.sources.importedAgentUsage.state !== "available" ? <div className="copilot-users-notice" role="status">
      <p>{data.sources.importedAgentUsage.state === "stale" ? "Agent usage is out of date. Historical totals are shown, but are not used for low-usage recommendations." : "Agent usage is not available yet. Licensed users remain listed; missing usage is not zero."}</p>
      <a href="/official-usage">Manage agent reports</a>
    </div> : null}
    {data.sources.appActivity.state === "unavailable" ? <div className="copilot-users-notice" role="status">
      <p>Office app activity unavailable. {data.sources.appActivity.message}</p>
      <a href="/permissions">Check connection</a>
    </div> : data.sources.appActivity.state === "stale" ? <p><small>Office app activity is out of date. Last-known dates remain visible in user details.</small></p> : null}

    <div className="copilot-users-tabs" role="group" aria-label="License usage cohorts">
      {([
        ["all", "All licensed"],
        ["attention", "Needs attention"],
        ["most", "Most active"],
        ["least", "Least active"],
        ["unknown", "Usage unknown"],
      ] as const).map(([value, label]) => <button key={value} type="button" className="secondary" aria-pressed={cohort === value} onClick={() => selectCohort(value)}>{label}</button>)}
    </div>

    <div className="copilot-users-toolbar" aria-label="Licensed user filters">
      <label><span>Search users or agents</span><input type="search" placeholder="Name, email, agent or Microsoft" value={search} onChange={event => { setSearch(event.target.value); setPage(0); }} /></label>
      <label><span>Order by</span><select value={sort} onChange={event => { setSort(event.target.value as Sort); setPage(0); }}>
        <option value="responses-desc">Most agent responses</option><option value="responses-asc">Fewest agent responses</option><option value="activity">Latest reported activity</option><option value="name">Name</option>
      </select></label>
      <label><span>Low agent usage threshold</span><select value={threshold} onChange={event => { setThreshold(Number(event.target.value)); setPage(0); }}>
        {[5, 10, 20, 50].map(value => <option key={value} value={value}>{value} responses or fewer</option>)}
      </select></label>
    </div>
    <p><small>{directoryKnown ? `${filtered.length.toLocaleString()} licensed users` : "License count unavailable"}{data.sources.importedAgentUsage.period.startDate && data.sources.importedAgentUsage.period.endDate ? ` | Agent report: ${data.sources.importedAgentUsage.period.startDate} to ${data.sources.importedAgentUsage.period.endDate}` : ""}. Rankings use agent responses, not total Copilot utilization.</small></p>

    {visible.length ? <div className="copilot-users-table-shell" role="region" aria-label="Licensed users" tabIndex={0}>
      <table className="copilot-users-table">
        <thead><tr><th scope="col">User</th><th scope="col">License</th><th scope="col">Agent responses</th><th scope="col">Agents used</th><th scope="col">Last reported activity</th><th scope="col">Follow-up</th></tr></thead>
        <tbody>{visible.map(user => {
          const followUp = recommendation(user, threshold, agentUsageFresh);
          return <tr key={user.directory.objectId}>
            <td><button type="button" className="user-name-button" aria-haspopup="dialog" onClick={() => setSelectedId(user.directory.objectId)}>{name(user)}</button><small>{user.directory.userPrincipalName}</small>{user.directory.accountEnabled === false ? <small>Account disabled</small> : null}</td>
            <td><span className={`copilot-user-badge ${licenseIssue(user) ? "attention" : ""}`}>{licenseLabel(user)}</span></td>
            <td data-numeric>{formatCount(responses(user))}{!agentUsageFresh && responses(user) !== null ? <small>Historical report</small> : null}</td>
            <td data-numeric>{formatCount(user.importedUsage && !user.importedUsage.missingUserReport ? user.importedUsage.reportedAgentsUsed : null)}</td>
            <td>{formatDate(lastActivity(user))}</td>
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
    {data.unresolvedImportedIdentities.length ? <details className="copilot-users-provenance">
      <summary>Unlinked report identities ({data.unresolvedImportedIdentities.length.toLocaleString()})</summary>
      <p>These report identities cannot be linked uniquely to a currently licensed directory user. They may be anonymized, renamed or no longer licensed; no license status is inferred.</p>
      <div className="copilot-users-table-shell" role="region" aria-label="Unlinked report identities" tabIndex={0}>
        <table className="copilot-users-table"><thead><tr><th scope="col">Reported identity</th><th scope="col">Responses</th><th scope="col">License status</th></tr></thead>
          <tbody>{data.unresolvedImportedIdentities.slice(0, pageSize).map((row, index) => <tr key={`${row.importedUsage.username}:${index}`}><td>{row.importedUsage.displayName}<small>{row.importedUsage.username}</small></td><td>{row.importedUsage.missingUserReport ? "Unknown" : row.importedUsage.reportedResponsesReceived.toLocaleString()}</td><td>Unknown</td></tr>)}</tbody>
        </table>
      </div>
      {data.unresolvedImportedIdentities.length > pageSize ? <p>First {pageSize} shown. <a href="/official-usage">View all imported identities and agent details</a>.</p> : null}
    </details> : null}
    {selected ? <CopilotUserDetail user={selected} data={data} threshold={threshold} onClose={() => setSelectedId(undefined)} /> : null}
  </>;
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function CopilotUserDetail({ user, data, threshold, onClose }: { user: CopilotUsageUser; data: CopilotUsageUsersResponse; threshold: number; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const imported = user.importedUsage;
  const fresh = data.sources.importedAgentUsage.state === "available";
  const followUp = recommendation(user, threshold, fresh);
  const auditUrl = `/audit?${new URLSearchParams({ source: "purview", user: user.directory.userPrincipalName })}`;
  useEffect(() => {
    const element = dialog.current;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    element?.showModal();
    close.current?.focus();
    document.body.style.overflow = "hidden";
    return () => {
      element?.close();
      document.body.style.overflow = previousOverflow;
      previousFocus?.focus();
    };
  }, []);
  return <dialog ref={dialog} className="copilot-user-dialog" aria-labelledby="copilot-user-name" onCancel={event => { event.preventDefault(); onClose(); }}>
    <header>
      <div><h2 id="copilot-user-name">{name(user)}</h2><p>{user.directory.userPrincipalName}{user.directory.department ? ` | ${user.directory.department}` : ""}</p><span className={`copilot-user-badge ${followUp.tone}`}>{followUp.label}</span></div>
      <button ref={close} type="button" className="secondary icon-button" aria-label="Close user details" onClick={onClose}><X size={20} aria-hidden="true" /></button>
    </header>
    <div className="copilot-user-metrics">
      <Metric label="License" value={licenseLabel(user)} hint="Current Entra assignment" />
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
      {imported?.rows.length ? <div className="copilot-users-table-shell" role="region" aria-label="User agent breakdown" tabIndex={0}>
        <table className="copilot-users-table"><thead><tr><th scope="col">Agent</th><th scope="col">Creator</th><th scope="col">Responses to this user</th></tr></thead>
          <tbody>{[...imported.rows].sort((a, b) => b.responsesSentToUsers - a.responsesSentToUsers).map(row => <tr key={row.agentId}><td>{row.displayAgentName}<small>{row.agentId}</small></td><td>{row.creatorType || "Unknown"}</td><td>{row.responsesSentToUsers.toLocaleString()}</td></tr>)}</tbody>
        </table>
      </div> : <p>No matched agent breakdown. This does not establish zero activity.</p>}
      <p><small>Period totals, not a daily event log. Agent-wide last-use dates are not attributed to this user.</small></p>
    </section>
    <section aria-label="User Office app activity">
      <h3>Copilot in Office apps</h3>
      <p>{user.appActivity ? `Last known activity by app. Report refreshed ${formatDate(user.appActivity.reportRefreshDate)}${data.sources.appActivity.state === "stale" ? " (out of date)" : ""}; dates can fall outside the selected report period.` : "No uniquely matched app-usage report. Check reporting permissions and whether report identities are concealed."}</p>
      <ul className="copilot-app-activity">{appFields.map(([label, field]) => <li key={field}><strong>{label}</strong><small>{!user.appActivity ? "Unknown" : user.appActivity[field] ? formatDate(user.appActivity[field]) : "No date reported"}</small></li>)}</ul>
    </section>
    <footer>
      <p>Need timestamped events? Search Purview for this user. Audit metadata is separate from usage totals and excludes prompt/response content.</p>
      <a href={auditUrl}>Search interaction log</a>
    </footer>
  </dialog>;
}

function responses(user: CopilotUsageUser): number | null {
  return user.importedUsage && !user.importedUsage.missingUserReport ? user.importedUsage.reportedResponsesReceived : null;
}

function name(user: CopilotUsageUser) {
  return user.directory.displayName || user.directory.userPrincipalName;
}

function lastActivity(user: CopilotUsageUser) {
  return [user.appActivity?.lastActivityDate, user.importedUsage?.userLastActivityDateUtc].filter((date): date is string => Boolean(date)).sort().at(-1);
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

function needsAttention(user: CopilotUsageUser, threshold: number, agentUsageFresh: boolean) {
  const count = responses(user);
  return licenseIssue(user) || user.attention.includes("app_activity_inactive") || (agentUsageFresh && count !== null && count <= threshold);
}

function recommendation(user: CopilotUsageUser, threshold: number, agentUsageFresh: boolean) {
  const count = responses(user);
  if (licenseIssue(user)) return { label: "Review assignment", tone: "attention" };
  if (agentUsageFresh && count === 0) return { label: "Explore agents", tone: "attention" };
  if (agentUsageFresh && count !== null && count <= threshold) return { label: "Offer adoption help", tone: "attention" };
  if (user.attention.includes("app_activity_inactive")) return { label: "Review app activity", tone: "attention" };
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
