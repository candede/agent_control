import { useEffect, useEffectEvent, useId, useMemo, useRef, useState } from "react";
import {
  ApiError,
  downloadOfficialUsageCsv,
  getOfficialUsageUsers,
  type CopilotUsageUser,
  type CopilotUsageUsersResponse,
  type OfficialUsageUserQuery,
  type OfficialUsageUserSummary,
  type OfficialUsageUserView,
} from "../api/client";
import { downloadBlob } from "../agentExport";
import type { UsersRouteState } from "../workbenchRouting";
import { usageAvailabilityLabel, usageCount, usageCoverageLabel, usageDate, usagePageLabel } from "../usageInsights";
import { ReportedUserDetail } from "./ReportedUserDetail";
import "./reportedUsers.css";

const pageSize = 50;
type ReadState = { key: object; value: OfficialUsageUserView } | { key: object; error: string };
type ExportState = { key: object; status: "pending" | "done" } | { key: object; status: "failed"; message: string };
type AdvancedFilters = {
  creatorType: string;
  activity: OfficialUsageUserView["filters"]["activity"];
  responsesOnly: boolean;
  startDate: string;
  endDate: string;
  lowResponseThreshold: string;
  cohort: OfficialUsageUserView["filters"]["cohort"];
};
const defaultFilters: AdvancedFilters = {
  creatorType: "", activity: "all", responsesOnly: false, startDate: "", endDate: "", lowResponseThreshold: "5", cohort: "all",
};
const sorts: { value: string; label: string; sortBy: OfficialUsageUserView["filters"]["sortBy"]; sortDirection: "asc" | "desc" }[] = [
  { value: "responses-desc", label: "Most agent responses", sortBy: "responses", sortDirection: "desc" },
  { value: "responses-asc", label: "Fewest agent responses", sortBy: "responses", sortDirection: "asc" },
  { value: "agents-desc", label: "Most reported agents used", sortBy: "agentsUsed", sortDirection: "desc" },
  { value: "agents-asc", label: "Fewest reported agents used", sortBy: "agentsUsed", sortDirection: "asc" },
  { value: "activity-desc", label: "Latest user activity", sortBy: "lastActivity", sortDirection: "desc" },
  { value: "activity-asc", label: "Oldest user activity", sortBy: "lastActivity", sortDirection: "asc" },
  { value: "name", label: "Name", sortBy: "displayName", sortDirection: "asc" },
];

export function ReportedUserActivity({ route, onRouteChange, dataRevision = 0, directoryData, onAccessDenied }: {
  route: UsersRouteState;
  onRouteChange: (route: UsersRouteState, replace?: boolean) => void;
  dataRevision?: number;
  directoryData?: CopilotUsageUsersResponse;
  onAccessDenied?: (message: string) => void;
}) {
  const [result, setResult] = useState<ReadState>();
  const [retry, setRetry] = useState(0);
  const [applied, setApplied] = useState(defaultFilters);
  const [draft, setDraft] = useState(defaultFilters);
  const [sort, setSort] = useState(sorts[0]);
  const [selectedUser, setSelectedUser] = useState<{ key: object; username: string }>();
  const [exportState, setExportState] = useState<ExportState>();
  const exportController = useRef<AbortController | null>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const filterDescription = useId();
  const exportDescription = useId();
  const reportAccessDenied = useEffectEvent((message: string) => onAccessDenied?.(message));
  const { agentId, reportSetId, search, page } = route;
  const query: OfficialUsageUserQuery = useMemo(() => ({
    agentId, setId: reportSetId, search: search.trim() || undefined,
    creatorType: applied.creatorType || undefined, activity: applied.activity, inactiveDays: 30,
    responsesOnly: applied.responsesOnly, startDate: applied.startDate || undefined, endDate: applied.endDate || undefined,
    lowResponseThreshold: Number(applied.lowResponseThreshold), cohort: applied.cohort,
    sortBy: sort.sortBy, sortDirection: sort.sortDirection, limit: pageSize, offset: page * pageSize,
  }), [agentId, applied, page, reportSetId, search, sort]);
  // Revisiting the same filters must not revive an aborted read or export.
  const key = useMemo(() => ({ query, dataRevision, retry }), [query, dataRevision, retry]);
  const exportKey = useMemo(() => ({ key, draft }), [key, draft]);
  const scoped = result?.key === key ? result : undefined;
  const data = scoped && "value" in scoped ? scoped.value : undefined;
  const error = scoped && "error" in scoped ? scoped.error : undefined;
  const scopedExport = exportState?.key === exportKey ? exportState : undefined;
  const draftChanged = JSON.stringify(draft) !== JSON.stringify(applied);
  const invalidDates = Boolean(draft.startDate && draft.endDate && draft.startDate > draft.endDate);
  const validThreshold = /^\d+$/.test(draft.lowResponseThreshold)
    && Number(draft.lowResponseThreshold) >= 1 && Number(draft.lowResponseThreshold) <= 100_000_000;
  const hasRelationships = Boolean(data?.lineages.some(lineage => lineage.kind === "userAgents"));
  const directoryMatches = useMemo(() => {
    const matches = new Map<string, CopilotUsageUser | null>();
    if (directoryData?.sources.directory.state !== "available") return matches;
    for (const user of directoryData.users) {
      if (!user.importedUsage?.datasetScope.reportSetId) continue;
      const identity = reportUserKey(user.importedUsage);
      matches.set(identity, matches.has(identity) ? null : user);
    }
    return matches;
  }, [directoryData]);
  const selected = selectedUser?.key === key ? data?.users.value.find(user => user.username === selectedUser.username) : undefined;
  const hasFilters = Boolean(search || agentId || JSON.stringify(applied) !== JSON.stringify(defaultFilters) || draftChanged);
  const exportDisabled = !data?.activeSet || draftChanged || scopedExport?.status === "pending";
  const focusedName = agentId ? data?.users.value.flatMap(user => user.rows).find(row => row.agentId === agentId)?.displayAgentName : undefined;

  useEffect(() => {
    const controller = new AbortController();
    void getOfficialUsageUsers(query, { signal: controller.signal }).then(value => {
      if (!controller.signal.aborted) setResult({ key, value });
    }).catch((failure: unknown) => {
      if (controller.signal.aborted) return;
      const message = failure instanceof Error ? failure.message : "Reported user activity could not be loaded.";
      setResult({ key, error: message });
      if (isAccessDenied(failure)) reportAccessDenied(message);
    });
    return () => controller.abort();
  }, [key, query]);

  useEffect(() => () => exportController.current?.abort(), [exportKey]);

  function resetFilters() {
    setDraft(defaultFilters);
    setApplied(defaultFilters);
    setSort(sorts[0]);
    onRouteChange({ ...route, search: "", agentId: undefined, page: 0 });
  }

  async function exportUsers() {
    if (!data?.activeSet || exportDisabled) return;
    exportController.current?.abort();
    const controller = new AbortController();
    exportController.current = controller;
    setExportState({ key: exportKey, status: "pending" });
    const filters = data.filters;
    try {
      const blob = await downloadOfficialUsageCsv("users", {
        setId: data.activeSet.id, agentId: filters.agentId, search: filters.search,
        creatorType: filters.creatorType, activity: filters.activity, inactiveDays: 30,
        responsesOnly: filters.responsesOnly, startDate: filters.startDate, endDate: filters.endDate,
        lowResponseThreshold: filters.lowResponseThreshold, cohort: filters.cohort,
        sortBy: filters.sortBy, sortDirection: filters.sortDirection,
      }, controller.signal);
      if (controller.signal.aborted) return;
      downloadBlob("reported-user-activity.csv", blob);
      setExportState({ key: exportKey, status: "done" });
    } catch (failure: unknown) {
      if (controller.signal.aborted) return;
      const message = failure instanceof Error ? failure.message : "Reported user activity could not be exported.";
      setExportState({ key: exportKey, status: "failed", message });
      if (isAccessDenied(failure)) {
        setResult({ key, error: message });
        onAccessDenied?.(message);
      }
    }
  }

  return <section className="reported-users" aria-label="Reported activity" aria-busy={!scoped}>
    <p className="reported-users-intro">All imported report identities, including concealed, unlinked and bridge-only users. Rankings measure agent responses, not all Copilot activity or license utilization.</p>
    <div className="copilot-users-toolbar reported-users-toolbar">
      <label><span>Search reported users or agents</span><input ref={searchInput} type="search" maxLength={256} placeholder="User, agent name, ID or creator" value={search}
        onChange={event => onRouteChange({ ...route, search: event.target.value, page: 0 }, true)} /></label>
      <label><span>Order reported users by</span><select value={sort.value} onChange={event => {
        const next = sorts.find(item => item.value === event.target.value);
        if (next) { setSort(next); onRouteChange({ ...route, page: 0 }); }
      }}>{sorts.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
      <button type="button" className="secondary" aria-describedby={exportDescription} disabled={exportDisabled} onClick={() => void exportUsers()}>{scopedExport?.status === "pending" ? "Exporting users…" : "Export users CSV"}</button>
    </div>
    <p id={exportDescription} className="reported-users-note">CSV exports all agent details for matching users, including relationships outside the selected agent, creator or response filters. All-agent user totals repeat per relationship; do not sum them.</p>
    <details className="reported-users-filters">
      <summary>Advanced user filters{JSON.stringify(applied) !== JSON.stringify(defaultFilters) ? " (applied)" : ""}</summary>
      <form aria-label="Advanced user filters" aria-describedby={filterDescription} onSubmit={event => {
        event.preventDefault();
        if (invalidDates || !validThreshold) return;
        setApplied(draft);
        onRouteChange({ ...route, page: 0 });
      }}>
        <p id={filterDescription}>Creator, exact-agent and response-producing filters select users with a matching relationship. Response cohorts, sorting and dates use the all-agent Users report. All filters apply before user paging.</p>
        <div className="reported-users-filter-grid">
          <label><span>Relationship creator</span><select value={draft.creatorType} onChange={event => setDraft({ ...draft, creatorType: event.target.value })}>
            <option value="">All creator types</option>
            {[...new Set([...(data?.filters.creatorTypes ?? []), draft.creatorType].filter(Boolean))].map(creator => <option key={creator} value={creator}>{creator}</option>)}
          </select></label>
          <label><span>User recency</span><select value={draft.activity} onChange={event => {
            const activity = event.target.value;
            if (activity === "all" || activity === "recent" || activity === "inactive" || activity === "no-activity") setDraft({ ...draft, activity });
          }}><option value="all">Any reported recency</option><option value="recent">Within 30 days of report anchor</option><option value="inactive">Over 30 days before report anchor</option><option value="no-activity">No user date reported</option></select></label>
          <label><span>User activity start (UTC)</span><input type="date" value={draft.startDate} max={draft.endDate || undefined} onChange={event => setDraft({ ...draft, startDate: event.target.value })} /></label>
          <label><span>User activity end (UTC)</span><input type="date" value={draft.endDate} min={draft.startDate || undefined} onChange={event => setDraft({ ...draft, endDate: event.target.value })} /></label>
          <label><span>Users-report response cohort</span><select value={draft.cohort} onChange={event => {
            const cohort = event.target.value;
            if (cohort === "all" || cohort === "zero" || cohort === "low" || cohort === "review") setDraft({ ...draft, cohort });
          }}><option value="all">All reported users</option><option value="zero">Explicitly zero responses</option><option value="low">Low responses (1–threshold)</option><option value="review">Zero or low responses</option></select></label>
          <label><span>Low-response threshold</span><input type="number" min={1} max={100_000_000} step={1} value={draft.lowResponseThreshold} onChange={event => setDraft({ ...draft, lowResponseThreshold: event.target.value })} /></label>
          <label className="reported-users-checkbox"><input type="checkbox" checked={draft.responsesOnly} onChange={event => setDraft({ ...draft, responsesOnly: event.target.checked })} /><span>Require a response-producing relationship</span></label>
        </div>
        <p>Dates are inclusive bounds on the user&apos;s last activity in the Users report, not a recalculation of period totals. Recency is relative to the latest Users-report date ({usageDate(data?.recencyAnchorDateUtc)}), not today or an agent-wide date. Unknown metrics never enter zero/low cohorts.</p>
        {invalidDates ? <p role="alert">User activity start must be on or before the end date.</p> : null}
        {!validThreshold ? <p role="alert">Enter a whole-number threshold between 1 and 100,000,000.</p> : null}
        <div className="reported-users-actions"><button type="submit" className="secondary" disabled={invalidDates || !validThreshold || !draftChanged}>Apply user filters</button>
          <button type="button" className="secondary" onClick={resetFilters}>Reset user filters</button></div>
      </form>
    </details>
    {draftChanged ? <p className="reported-users-note" role="status">Filters have unapplied changes. Apply or reset them before exporting.</p> : null}
    {hasFilters ? <div className="reported-users-applied" aria-label="Applied user filters">
      <span>{appliedFilterLabel(data?.filters ?? query)}</span>
      <button type="button" className="secondary" onClick={resetFilters}>Clear user filters</button>
    </div> : null}
    {agentId ? <div className="reported-users-focus" aria-label="Selected report agent">
      <div><strong>{focusedName || agentId}</strong>{focusedName && focusedName !== agentId ? <small>{agentId}</small> : null}
        <p>Users with an explicitly reported relationship to this exact agent. Table totals still cover all agents; open a user&apos;s details for this agent&apos;s responses.</p></div>
      <button type="button" className="secondary" onClick={() => onRouteChange({ ...route, agentId: undefined, page: 0 })}>Show all agents</button>
    </div> : null}
    {reportSetId ? <p className="reported-users-snapshot">Viewing the exact retained report snapshot. <button type="button" className="secondary" onClick={() => onRouteChange({ ...route, reportSetId: undefined, page: 0 })}>Use current reports</button></p> : null}
    {error ? <div className="error-banner" role="alert">{error} <button type="button" className="secondary" onClick={() => setRetry(value => value + 1)}>Retry reported activity</button></div> : null}
    {scopedExport?.status === "failed" && !error ? <div className="error-banner" role="alert">{scopedExport.message} <button type="button" className="secondary" disabled={exportDisabled} onClick={() => void exportUsers()}>Retry user export</button></div> : null}
    {scopedExport?.status === "done" ? <p role="status">User CSV downloaded with all agent details for matching identities in the displayed report snapshot.</p> : null}
    {!scoped ? <p role="status">Loading reported user activity…</p> : null}
    {data ? <>
      <p className="reported-users-context"><strong>{usageAvailabilityLabel(data.availability)}</strong> · {usageCoverageLabel(data.activeSet)}</p>
      {data.availability === "stale" ? <p className="copilot-users-notice">Historical reports are out of date. Refresh reports before making adoption decisions.</p> : null}
      {!data.activeSet ? <div className="reported-users-empty">
        <h3>No selected user reports</h3>
        <p>{usageAvailabilityLabel(data.availability)}. Use Official usage in the top navigation to select or import reports. Missing reports are not zero activity.</p>
      </div> : <>
        {!hasRelationships ? <p className="reported-users-note">The Users &amp; agents companion is missing. Relationships are unknown, not zero.</p> : null}
        <p className="reported-users-note">Users-report responses and agents used are all-agent totals. Missing Users rows show Unknown, never a substituted relationship sum. Current licenses require a unique exact link to this report snapshot.</p>
        {data.users.value.length ? <div className="copilot-users-table-shell" role="region" aria-label="Reported users" tabIndex={0}>
          <table className="copilot-users-table reported-users-table">
            <thead><tr><th scope="col">Reported user</th><th scope="col">Agent responses<br />(Users report)</th><th scope="col">Agents used<br />(Users report)</th><th scope="col">Current license</th><th scope="col">User last activity<br />(Users report)</th><th scope="col">Details</th></tr></thead>
            <tbody>{data.users.value.slice(0, pageSize).map(user => <tr key={reportUserKey(user)}>
              <th scope="row">{user.displayName || user.username}<small>{user.username}</small></th>
              <td data-numeric>{usageCount(user.missingUserReport ? null : user.reportedResponsesReceived)}{user.hasReportMismatch ? <small>Report totals differ</small> : null}</td>
              <td data-numeric>{usageCount(user.missingUserReport ? null : user.reportedAgentsUsed)}</td>
              <td>{licenseLabel(directoryMatches.get(reportUserKey(user)))}</td>
              <td>{usageDate(user.userLastActivityDateUtc)}</td>
              <td><button type="button" className="secondary" aria-haspopup="dialog" aria-label={`View reported details for ${user.displayName || user.username}`} onClick={() => setSelectedUser({ key, username: user.username })}>View details</button></td>
            </tr>)}</tbody>
          </table>
        </div> : <div className="reported-users-empty">
          <h3>{data.users.count ? "No reported users on this page" : data.counts.users ? "No reported users match" : "No reported user identities"}</h3>
          <p>{data.counts.users ? "Try another search or clear filters. Missing relationships do not establish inactivity."
            : "This snapshot contains no Users or Users & agents identities. Report availability and directory license coverage are independent."}</p>
          {page > 0 ? <button type="button" className="secondary" onClick={() => onRouteChange({ ...route, page: 0 })}>First user page</button> : null}
        </div>}
        <div className="copilot-users-pagination" aria-label="Reported user pages">
          <span>{usagePageLabel(data.users, "reported users")}</span>
          <button type="button" className="secondary" disabled={page === 0} onClick={() => onRouteChange({ ...route, reportSetId: data.activeSet?.id, page: page - 1 })}>Previous users</button>
          <button type="button" className="secondary" disabled={data.users.offset + pageSize >= data.users.count} onClick={() => onRouteChange({ ...route, reportSetId: data.activeSet?.id, page: page + 1 })}>Next users</button>
        </div>
      </>}
      <details className="copilot-users-provenance">
        <summary>Report sources and identity coverage</summary>
        <p>{data.authority}. Snapshot {data.activeSet?.id ?? "not selected"}; imported {usageDate(data.activeSet?.acceptedAt)}.</p>
        <p>{data.counts.users.toLocaleString()} report identities; {data.counts.userRows.toLocaleString()} Users rows; {hasRelationships ? data.counts.accessRows.toLocaleString() : "Unknown"} Users &amp; agents relationships. All identities remain available independently of directory access.</p>
        {data.lineages.map(lineage => <p key={lineage.kind}>{lineage.kind === "userAgents" ? "Users & agents" : lineage.kind === "users" ? "Users" : "Agents"} version: {lineage.versionId}. {lineage.sourceFreshness === "unknown" ? "Source refresh time not supplied; import time does not establish freshness." : ""}</p>)}
        {data.activeSet?.reportingPeriod.provenance === "activity_range" ? <p>Observed activity dates do not establish a complete reporting window.</p> : null}
        <p>{directoryData?.sources.directory.state === "available"
          ? `License inventory observed: ${usageDate(directoryData.snapshot?.directoryObservedAt ?? directoryData.sources.directory.fetchedAt)}. Current assignments do not prove a license was held during the reporting period.`
          : "Current license inventory is unverified or unavailable. Report identities remain visible; Unknown does not mean unlicensed."}</p>
        <p>Concealed identities and case-distinct names are report-scoped. Directory assignments require an existing unique exact saved link with the same report set, Users version and Users &amp; agents version.</p>
        <p>{data.decisionNotice} Collection and connection recovery are available through Sync and Permissions in the top navigation.</p>
        <p>CSV filters select matching people, not individual exported relationships. Every agent relationship of each matching user is exported, not only this page or the selected agent. Repeated all-agent Users-report totals are not additive across relationship rows.</p>
      </details>
      {selected ? <ReportedUserDetail key={reportUserKey(selected)} user={selected} currentLicense={licenseLabel(directoryMatches.get(reportUserKey(selected)))}
        hasRelationships={hasRelationships} filters={data.filters} returnFocusTo={searchInput} onClose={() => setSelectedUser(undefined)}
        onFocusAgent={(id, setId) => {
          setSelectedUser(undefined);
          setApplied(defaultFilters);
          setDraft(defaultFilters);
          onRouteChange({ ...route, agentId: id, reportSetId: setId, search: "", page: 0 });
        }} /> : null}
    </> : null}
  </section>;
}

function reportUserKey(user: OfficialUsageUserSummary) {
  return JSON.stringify([user.username, user.datasetScope.reportSetId, user.datasetScope.usersVersionId, user.datasetScope.userAgentsVersionId]);
}

function licenseLabel(user: CopilotUsageUser | null | undefined) {
  if (!user) return "Unknown";
  if (user.licenses.some(license => license.state === "error")) return "Assignment issue";
  if (user.licenses.length && user.licenses.every(license => license.state === "disabled")) return "Assigned, disabled";
  return "Assigned";
}

function isAccessDenied(failure: unknown) {
  return failure instanceof ApiError && (failure.status === 401 || failure.status === 403);
}

function appliedFilterLabel(filters: OfficialUsageUserQuery) {
  const labels = [
    filters.search ? `Search: ${filters.search}` : "",
    filters.agentId ? `Exact agent: ${filters.agentId}` : "",
    filters.creatorType ? `Creator: ${filters.creatorType}` : "",
    filters.activity && filters.activity !== "all" ? `User recency: ${filters.activity}` : "",
    filters.startDate ? `User activity from ${filters.startDate}` : "",
    filters.endDate ? `through ${filters.endDate}` : "",
    filters.cohort && filters.cohort !== "all" ? `Users-report cohort: ${filters.cohort} (low ≤ ${filters.lowResponseThreshold ?? 5})` : "",
    filters.responsesOnly ? "Response-producing relationships" : "",
  ].filter(Boolean);
  return labels.length ? labels.join(" · ") : "All reported users";
}
