import { useMemo, useState } from "react";
import type { SortingState } from "@tanstack/react-table";
import type { OfficialUsageUserSummary, OfficialUsageUserView } from "../api/client";
import { useListTable, type ListColumn } from "../listTable";
import { usageCount, usageDate } from "../usageInsights";
import { ListTableHead } from "./ListTableHead";

export type UserRelationshipFilters = Pick<OfficialUsageUserView["filters"], "agentId" | "creatorType" | "responsesOnly">;
const pageSize = 50;

export function ReportedUserAgents({ user, filters, onFocusAgent }: {
  user: OfficialUsageUserSummary;
  filters?: UserRelationshipFilters;
  onFocusAgent?: (agentId: string, reportSetId: string) => void;
}) {
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [showAll, setShowAll] = useState(false);
  const [sorting, setSorting] = useState<SortingState>([{ id: "responses", desc: true }]);
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
    });
  }, [filters, search, showAll, user.rows]);
  const columns = useMemo<ListColumn<OfficialUsageUserSummary["rows"][number]>[]>(() => [
    { id: "agent", header: "Agent", accessorFn: row => row.displayAgentName || row.agentId },
    { id: "creator", header: "Creator", accessorFn: row => row.creatorType || undefined },
    { id: "responses", header: "Responses to this user", accessorFn: row => row.responsesSentToUsers, sortDescFirst: true },
    { id: "activity", header: "Agent-wide last activity", accessorFn: row => row.lastActivityDateUtc, sortDescFirst: true },
  ], []);
  const table = useListTable({
    data: rows,
    columns,
    sorting,
    getRowId: row => row.agentId,
    onSortingChange: update => {
      setSorting(previous => typeof update === "function" ? update(previous) : update);
      setPage(0);
    },
  });
  const sortedRows = table.getRowModel().rows;
  const lastPage = Math.max(0, Math.ceil(rows.length / pageSize) - 1);
  const currentPage = Math.min(page, lastPage);
  const visible = sortedRows.slice(currentPage * pageSize, (currentPage + 1) * pageSize);
  const reportSetId = user.datasetScope.reportSetId;
  const hasCompanion = Boolean(user.datasetScope.userAgentsVersionId);

  return <section className="reported-user-agents" aria-label="Reported agent relationships">
    <h3>Reported agents</h3>
    <div className="copilot-users-toolbar">
      <label><span>Search this user&apos;s agents</span><input type="search" value={search} maxLength={256} placeholder="Agent name, exact ID or creator" onChange={event => { setSearch(event.target.value); setPage(0); }} /></label>
      {constrained ? <button type="button" className="secondary" onClick={() => { setShowAll(value => !value); setPage(0); }}>
        {showAll ? "Show matching relationships" : "Show all this user's agents"}
      </button> : null}
      {search ? <button type="button" className="secondary" onClick={() => { setSearch(""); setPage(0); }}>Clear agent search</button> : null}
    </div>
    {constrained ? <p className="reported-users-note">{showAll
      ? "Showing all reported agents for this user."
      : "Showing agents matching the selected filters."}</p> : null}
    {visible.length ? <>
      <div className="copilot-users-table-shell" role="region" aria-label="User agent breakdown" tabIndex={0}>
        <table className="copilot-users-table reported-agent-table">
          <ListTableHead table={table} />
          <tbody>{visible.map(tableRow => {
            const row = tableRow.original;
            return <tr key={tableRow.id}>
            <td>{reportSetId && onFocusAgent ? <button type="button" className="reported-agent-button"
              aria-label={`${row.displayAgentName || row.agentId}: active users without paid Copilot`}
              title={`Show active users without paid Copilot for report agent ${row.agentId}`}
              onClick={() => onFocusAgent(row.agentId, reportSetId)}>{row.displayAgentName || row.agentId}</button> : row.displayAgentName || row.agentId}<small>{row.agentId}</small></td>
            <td>{row.creatorType || "Unknown"}</td>
            <td data-numeric>{usageCount(row.responsesSentToUsers)}</td>
            <td>{usageDate(row.lastActivityDateUtc)}</td>
          </tr>;
          })}</tbody>
        </table>
      </div>
      <div className="copilot-users-pagination" aria-label="User agent pages">
        <span>{(currentPage * pageSize + 1).toLocaleString()}-{Math.min((currentPage + 1) * pageSize, rows.length).toLocaleString()} of {rows.length.toLocaleString()} agents</span>
        <button type="button" className="secondary" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>Previous agents</button>
        <button type="button" className="secondary" disabled={currentPage === lastPage} onClick={() => setPage(currentPage + 1)}>Next agents</button>
      </div>
    </> : <div className="reported-users-empty">
      <h4>{user.rows.length ? "No agent relationships match" : hasCompanion ? "No agent relationships reported" : "Agent relationships unavailable"}</h4>
      <p>{user.rows.length ? "Clear the agent search or show all this user's agents."
        : hasCompanion ? "No agents are listed for this user in the selected report."
          : "Add the Users & agents CSV in Sync to see this user's agents."}</p>
    </div>}
  </section>;
}
