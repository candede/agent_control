import { useMemo, useState } from "react";
import type { OfficialUsageUserSummary, OfficialUsageUserView } from "../api/client";
import { usageCount, usageDate } from "../usageInsights";

export type UserRelationshipFilters = Pick<OfficialUsageUserView["filters"], "agentId" | "creatorType" | "responsesOnly">;
const pageSize = 50;

export function ReportedUserAgents({ user, filters, onFocusAgent }: {
  user: OfficialUsageUserSummary;
  filters?: UserRelationshipFilters;
  onFocusAgent: (agentId: string, reportSetId: string) => void;
}) {
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [showAll, setShowAll] = useState(false);
  const constrained = Boolean(filters?.agentId || filters?.creatorType || filters?.responsesOnly);
  const rows = useMemo(() => {
    const query = search.trim().toLowerCase();
    return user.rows.filter(row => {
      if (!showAll && filters) {
        if (filters.agentId !== undefined && row.agentId !== filters.agentId) return false;
        if (filters.creatorType && row.creatorType !== filters.creatorType) return false;
        if (filters.responsesOnly && !row.hasResponses) return false;
      }
      return !query || [row.displayAgentName, row.agentId, row.creatorType].some(value => value.toLowerCase().includes(query));
    }).sort((a, b) => b.responsesSentToUsers - a.responsesSentToUsers
      || a.displayAgentName.localeCompare(b.displayAgentName) || a.agentId.localeCompare(b.agentId));
  }, [filters, search, showAll, user.rows]);
  const lastPage = Math.max(0, Math.ceil(rows.length / pageSize) - 1);
  const currentPage = Math.min(page, lastPage);
  const visible = rows.slice(currentPage * pageSize, (currentPage + 1) * pageSize);
  const reportSetId = user.datasetScope.reportSetId;
  const hasCompanion = Boolean(user.datasetScope.userAgentsVersionId);

  return <section className="reported-user-agents" aria-label="Reported agent relationships">
    <h3>Reported agents</h3>
    <p>Each row is a Users &amp; agents relationship, not an access permission. An explicit <strong>0</strong> is different from a missing relationship.</p>
    <div className="copilot-users-toolbar">
      <label><span>Search this user&apos;s agents</span><input type="search" value={search} maxLength={256} placeholder="Agent name, exact ID or creator" onChange={event => { setSearch(event.target.value); setPage(0); }} /></label>
      {constrained ? <button type="button" className="secondary" onClick={() => { setShowAll(value => !value); setPage(0); }}>
        {showAll ? "Show matching relationships" : "Show all this user's agents"}
      </button> : null}
      {search ? <button type="button" className="secondary" onClick={() => { setSearch(""); setPage(0); }}>Clear agent search</button> : null}
    </div>
    {constrained ? <p className="reported-users-note">{showAll
      ? "Showing all this user's reported relationships; the user-table relationship filters are not applied here."
      : "Showing relationships matching the selected agent, creator and response filters. Users-report totals still cover all agents."}</p> : null}
    {visible.length ? <>
      <div className="copilot-users-table-shell" role="region" aria-label="User agent breakdown" tabIndex={0}>
        <table className="copilot-users-table reported-agent-table">
          <thead><tr><th scope="col">Agent</th><th scope="col">Creator</th><th scope="col">Responses to this user</th><th scope="col">Agent-wide last activity</th></tr></thead>
          <tbody>{visible.map(row => <tr key={row.agentId}>
            <td>{reportSetId ? <button type="button" className="reported-agent-button" title={`Show users of report agent ${row.agentId}`} onClick={() => onFocusAgent(row.agentId, reportSetId)}>{row.displayAgentName || row.agentId}</button> : row.displayAgentName || row.agentId}<small>{row.agentId}</small></td>
            <td>{row.creatorType || "Unknown"}</td>
            <td data-numeric>{usageCount(row.responsesSentToUsers)}</td>
            <td>{usageDate(row.lastActivityDateUtc)}<small>Anyone, not this user</small></td>
          </tr>)}</tbody>
        </table>
      </div>
      <div className="copilot-users-pagination" aria-label="User agent pages">
        <span>{(currentPage * pageSize + 1).toLocaleString()}-{Math.min((currentPage + 1) * pageSize, rows.length).toLocaleString()} of {rows.length.toLocaleString()} relationships</span>
        <button type="button" className="secondary" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>Previous agents</button>
        <button type="button" className="secondary" disabled={currentPage === lastPage} onClick={() => setPage(currentPage + 1)}>Next agents</button>
      </div>
    </> : <div className="reported-users-empty">
      <h4>{user.rows.length ? "No agent relationships match" : hasCompanion ? "No agent relationships reported" : "Agent relationships unavailable"}</h4>
      <p>{user.rows.length ? "Clear the agent search or show all this user's agents."
        : hasCompanion ? "The imported Users & agents report contains no agent rows for this user. Missing relationships do not establish zero activity or an unused license."
          : "The Users & agents companion report is missing. Relationships are unknown, not zero activity or an unused license."}</p>
    </div>}
    <p className="reported-users-note">Period totals, not a daily event log. Agent-wide last-use dates are never attributed to this user. Report agent IDs are not automatically matched to inventory agents.</p>
  </section>;
}
