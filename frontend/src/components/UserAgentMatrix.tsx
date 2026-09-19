import { useEffect, useId, useMemo, useState } from "react";
import {
  getOfficialUsageUsers,
  type CopilotUsageUser,
  type CopilotUsageUsersResponse,
  type OfficialUsageUserSummary,
  type OfficialUsageUserView,
} from "../api/client";
import type { UsersRouteState } from "../workbenchRouting";
import { usageCount, usageDate, usagePageLabel } from "../usageInsights";
import { ReportedAgentUsage } from "./TenantAdoptionInsights";
import { UsageMetric, UsageReportContext, UsageReportRecovery } from "./UsageReportContext";
import "./agentInsights.css";

const pageSize = 50;
const columnPageSize = 6;
type ReadState = { key: string; value: OfficialUsageUserView } | { key: string; error: string };

export function UserAgentMatrix({ route, onRouteChange, dataRevision = 0, directoryData, onInspectUser }: {
  route: UsersRouteState;
  onRouteChange: (route: UsersRouteState, replace?: boolean) => void;
  dataRevision?: number;
  directoryData?: CopilotUsageUsersResponse;
  onInspectUser: (user: CopilotUsageUser) => void;
}) {
  const [result, setResult] = useState<ReadState>();
  const [retry, setRetry] = useState(0);
  const [columnPaging, setColumnPaging] = useState({ key: "", page: 0 });
  const { agentId, reportSetId, search, page } = route;
  const key = JSON.stringify([agentId, reportSetId, search.trim(), page, dataRevision, retry]);
  const scoped = result?.key === key ? result : undefined;
  const data = scoped && "value" in scoped ? scoped.value : undefined;
  const error = scoped && "error" in scoped ? scoped.error : undefined;
  const hasRelationships = data?.lineages.some(lineage => lineage.kind === "userAgents") ?? false;
  const hasReportedUsers = data?.lineages.some(lineage => lineage.kind === "userAgents" || lineage.kind === "users") ?? false;
  const searchId = useId();
  const directoryMatches = useMemo(() => {
    const matches = new Map<string, CopilotUsageUser | null>();
    if (directoryData?.sources.directory.state !== "available") return matches;
    for (const user of directoryData.users) {
      if (!user.importedUsage?.datasetScope.reportSetId) continue;
      const key = reportUserKey(user.importedUsage);
      matches.set(key, matches.has(key) ? null : user);
    }
    return matches;
  }, [directoryData]);
  const agents = useMemo(() => {
    const names = new Map<string, string>();
    for (const user of data?.users.value ?? []) {
      for (const row of user.rows) {
        if (!agentId || row.agentId === agentId) names.set(row.agentId, row.displayAgentName || row.agentId);
      }
    }
    if (agentId && !names.has(agentId)) names.set(agentId, agentId);
    return [...names].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  }, [data, agentId]);
  const lastColumnPage = Math.max(0, Math.ceil(agents.length / columnPageSize) - 1);
  const columnPage = Math.min(columnPaging.key === key ? columnPaging.page : 0, lastColumnPage);
  const columns = agents.slice(columnPage * columnPageSize, (columnPage + 1) * columnPageSize);

  useEffect(() => {
    const controller = new AbortController();
    getOfficialUsageUsers({
      agentId, setId: reportSetId, search: search.trim() || undefined,
      sortBy: "displayName", sortDirection: "asc", limit: pageSize, offset: page * pageSize,
    }, { signal: controller.signal })
      .then(value => { if (!controller.signal.aborted) setResult({ key, value }); })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setResult({ key, error: error instanceof Error ? error.message : "The user-agent matrix could not be loaded." });
      });
    return () => controller.abort();
  }, [agentId, reportSetId, search, page, key]);

  return <section className="user-agent-matrix" aria-label="User-agent matrix">
    <div className="agent-insight-heading"><div>
      <h3>Who is using what?</h3>
      <p>Reported users and agents, including identities without a verified license assignment. Each cell is a response total, not an access permission.</p>
    </div><a href="/official-usage">Manage usage reports</a></div>
    <div className="agent-insight-toolbar">
      <label htmlFor={searchId}>Search the user-agent matrix<input id={searchId} type="search" placeholder="User, reported agent or creator" maxLength={256} value={search} onChange={event => onRouteChange({ ...route, search: event.target.value, page: 0 }, true)} /></label>
      {agentId ? <button type="button" className="secondary" onClick={() => onRouteChange({ ...route, agentId: undefined, page: 0 })}>Show all agents</button> : null}
      {search ? <button type="button" className="secondary" onClick={() => onRouteChange({ ...route, search: "", page: 0 })}>Clear matrix search</button> : null}
      {reportSetId ? <button type="button" className="secondary" onClick={() => onRouteChange({ ...route, reportSetId: undefined, page: 0 })}>Use current reports</button> : null}
    </div>
    {error ? <div className="error-banner" role="alert">{error} <button type="button" className="secondary" onClick={() => setRetry(value => value + 1)}>Retry matrix</button></div> : null}
    {!scoped ? <p role="status">Loading saved user-agent relationships...</p> : null}
    {data ? <>
      <UsageReportContext data={data} />
      {reportSetId ? <p className="agent-insight-note">Viewing the exact retained report snapshot. Current license assignments are shown only for identities linked to the same report versions.</p> : null}
      {!data.activeSet ? <UsageReportRecovery availability={data.availability} /> : <>
        <div className="agent-usage-metrics" aria-label="Matrix coverage">
          <UsageMetric label="Reported users" value={hasReportedUsers ? data.counts.users : null} hint="All identities in this report snapshot" />
          <UsageMetric label="User-agent relationships" value={hasRelationships ? data.counts.accessRows : null} hint="Reported relationships, not access assignments" />
          <UsageMetric label="Users matching filters" value={data.users.count} hint="Including explicitly reported zero-response relationships" />
          <UsageMetric label="Current licensed users" value={directoryData?.sources.directory.state === "available" ? directoryData.counts.licensedUsers : null} hint="Separate current directory inventory" />
        </div>
        {!hasRelationships ? <p className="agent-insight-note">The Users &amp; agents companion is missing. Relationships are unknown, not zero. <a href="/official-usage">Review the report bundle</a>.</p> : null}
        {agentId ? <ReportedAgentUsage key={`${data.activeSet.id}:${agentId}`} agentId={agentId} reportSetId={data.activeSet.id} showUsers={false} /> : null}
        <p className="agent-insight-note">A number, including <strong>0</strong>, was explicitly reported. <strong>Not reported</strong> means the relationship is missing, not zero usage or blocked access. Report agent identities are not automatically matched to inventory agents.</p>
        {data.users.value.length ? <>
          <div className="agent-insight-table-shell" role="region" aria-label="User-agent response matrix" tabIndex={0}>
            <table className="agent-insight-table user-agent-matrix-table">
              <caption>Response totals by reported user and agent{agentId ? " (one selected report agent)" : ""}</caption>
              <thead><tr>
                <th scope="col">Reported user</th><th scope="col">Current license</th>
                {columns.map(agent => <th scope="col" key={agent.id}><button type="button" className="matrix-agent-button" title={`Focus report agent ${agent.id}`} onClick={() => onRouteChange({ ...route, agentId: agent.id, reportSetId: data.activeSet?.id, page: 0 })}>{agent.name}</button><small>{agent.id}</small></th>)}
                <th scope="col">All-agent responses</th>
              </tr></thead>
              <tbody>{data.users.value.map(user => {
                const directory = directoryMatches.get(reportUserKey(user));
                const rows = new Map(user.rows.map(row => [row.agentId, row]));
                return <tr key={user.username}>
                  <th scope="row">{directory ? <button className="matrix-user-button" type="button" aria-haspopup="dialog" onClick={() => onInspectUser(directory)}>{user.displayName || user.username}</button> : <span>{user.displayName || user.username}</span>}<small>{user.username}</small></th>
                  <td>{directory ? directory.licenses.some(license => license.state === "error") ? "Assignment issue" : directory.licenses.every(license => license.state === "disabled") ? "Assigned, disabled" : "Assigned" : "Unknown"}</td>
                  {columns.map(agent => {
                    const row = rows.get(agent.id);
                    const value = row?.responsesSentToUsers;
                    return <td key={agent.id} className={`matrix-response ${value === undefined ? "unreported" : value === 0 ? "zero" : value >= 50 ? "high" : "active"}`}>
                      {value === undefined ? <span>Not reported</span> : usageCount(value)}
                    </td>;
                  })}
                  <td>{user.missingUserReport ? "Unknown" : usageCount(user.reportedResponsesReceived)}{user.hasReportMismatch ? <small>Report totals differ</small> : null}</td>
                </tr>;
              })}</tbody>
            </table>
          </div>
          <div className="agent-insight-pagination" aria-label="Matrix agent columns">
            <span>{agents.length ? `Agent columns ${columnPage * columnPageSize + 1}-${Math.min((columnPage + 1) * columnPageSize, agents.length)} of ${agents.length}` : "No agent relationships reported for these users"}. Columns cover this user page.</span>
            {agents.length > columnPageSize ? <>
              <button type="button" className="secondary" disabled={columnPage === 0} onClick={() => setColumnPaging({ key, page: columnPage - 1 })}>Previous columns</button>
              <button type="button" className="secondary" disabled={columnPage === lastColumnPage} onClick={() => setColumnPaging({ key, page: columnPage + 1 })}>Next columns</button>
            </> : null}
          </div>
        </> : <div className="agent-insight-empty"><h4>{data.users.count ? "No reported users on this page" : "No reported users match"}</h4><p>Try a different search, clear the selected agent, or return to the first page. Missing user-agent rows do not establish inactivity.</p>{page > 0 ? <button type="button" className="secondary" onClick={() => onRouteChange({ ...route, page: 0 })}>First user page</button> : null}</div>}
        <div className="agent-insight-pagination" aria-label="Matrix user pages">
          <span>{usagePageLabel(data.users, "reported users")}</span>
          <button type="button" className="secondary" disabled={page === 0} onClick={() => onRouteChange({ ...route, page: page - 1 })}>Previous users</button>
          <button type="button" className="secondary" disabled={(page + 1) * pageSize >= data.users.count} onClick={() => onRouteChange({ ...route, page: page + 1 })}>Next users</button>
        </div>
        <p><small>All-agent responses come from the Users report and are not the sum of the visible columns. Current license assignments do not prove a license was held during the reporting period. No per-user interaction date is inferred from agent-wide activity.</small></p>
        <p className="agent-insight-provenance">{directoryData?.sources.directory.state === "available"
          ? `License inventory observed: ${usageDate(directoryData.snapshot?.directoryObservedAt ?? directoryData.sources.directory.fetchedAt)}.`
          : <>License inventory is unavailable; report identities remain visible. <a href="/permissions">Review license-data permissions</a>.</>}</p>
      </>}
    </> : null}
  </section>;
}

function reportUserKey(user: OfficialUsageUserSummary) {
  return JSON.stringify([user.username, user.datasetScope.reportSetId, user.datasetScope.usersVersionId, user.datasetScope.userAgentsVersionId]);
}
