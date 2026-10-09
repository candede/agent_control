import { useEffect } from "react";
import type { ReportQuery, ReportRelationship } from "../../../backend/src/types/officialReportData";
import { unifiedAgentRecordId } from "../../../backend/src/types/unifiedAgents";
import { normalizeReportSearch } from "../api/reportData";
import { useReportPage } from "../useReportPage";
import { usageCount, usageDate } from "../usageInsights";
import { ReportReadStatus, ReportPageControls } from "./ReportPageControls";
import { ReportSortHeading } from "./ReportSortHeading";

export type UserRelationshipFilters = Pick<ReportQuery, "agentId" | "creatorType" | "responsesOnly">;
export type UserRelationshipQuery = Pick<ReportQuery, "sort" | "order"> & { search: string; showAll: boolean };
export function ReportedUserAgents({ path, selectionId, filters, query, onQueryChange, onFocusAgent, onOpenAgent, onRestartSelection, onSelectionInvalidated }: {
  path: string; selectionId: string; filters?: UserRelationshipFilters; onFocusAgent?: (agentId: string, reportSetId: string) => void;
  onOpenAgent?: (id: string) => void;
  query: UserRelationshipQuery; onQueryChange: (query: UserRelationshipQuery) => void;
  onRestartSelection?: () => void;
  onSelectionInvalidated?: (error: Error) => void;
}) {
  const { search, showAll, sort, order } = query;
  const read = useReportPage<ReportRelationship>(path, { selectionId, ...(showAll ? {} : filters), search: normalizeReportSearch(search) || undefined, sort, order }, 0, true, onRestartSelection);
  useEffect(() => {
    if (read.invalidated && read.error) onSelectionInvalidated?.(read.error);
  }, [read.invalidated, read.error, onSelectionInvalidated]);
  if (read.invalidated && onSelectionInvalidated) return null;
  const data = read.data;
  const constrained = Boolean(filters?.agentId || filters?.creatorType !== undefined || filters?.responsesOnly);
  function focusAgent(agentId: string, reportSetId: string) {
    if (!read.isCurrentData() || !read.isCurrentData(true)) return;
    onFocusAgent?.(agentId, reportSetId);
  }
  return <section className="reported-user-agents" aria-label="Reported agent relationships" aria-busy={read.loading}><h3>Reported agents</h3>
    <div className="copilot-users-toolbar"><label><span>Search this user's agents</span><input type="search" maxLength={256} placeholder="Agent name, exact ID or creator" value={search} onChange={event => onQueryChange({ ...query, search: event.target.value })} /></label>
      {constrained ? <button type="button" className="secondary" onClick={() => onQueryChange({ ...query, showAll: !showAll })}>{showAll ? "Show matching relationships" : "Show all this user's agents"}</button> : null}
      {search ? <button type="button" className="secondary" onClick={() => onQueryChange({ ...query, search: "" })}>Clear agent search</button> : null}</div>
    {constrained ? <p className="reported-users-note">{showAll ? "Showing all reported agents for this user." : "Showing agents matching the selected filters."}</p> : null}
    <ReportReadStatus read={read} />
    <div className="copilot-users-table-shell" role="region" aria-label="User agent breakdown" tabIndex={0}><table className="copilot-users-table reported-agent-table"><thead><tr>
      {([["Agent", "name"], ["Creator", "creatorType"], ["Responses to this user", "responses"], ["Agent-wide last activity", "lastActivity"]] as const).map(([label, column]) =>
        <ReportSortHeading key={column} label={label} sort={column} query={{ sort, order }} onChange={next => onQueryChange({ ...query, sort: next.sort, order: next.order })} />)}</tr></thead>
      <tbody>{data?.value.map(row => <tr key={row.id}><td>{onOpenAgent ? <button type="button" className="reported-agent-button" aria-disabled={read.loading}
        aria-label={`Open agent ${row.agentName || row.agentId}`} title={`Open details for report agent ${row.agentId}`}
        onClick={() => {
          if (!read.isCurrentData() || !read.isCurrentData(true)) return;
          onOpenAgent(unifiedAgentRecordId({ source: "graph_packages", packageId: row.agentId }));
        }}>{row.agentName || row.agentId}</button> : onFocusAgent && data.reports.setId ? <button type="button" className="reported-agent-button" aria-disabled={read.loading}
        aria-label={`${row.agentName || row.agentId}: active users without paid Copilot`} title={`Show active users without paid Copilot for report agent ${row.agentId}`}
        onClick={() => focusAgent(row.agentId, data.reports.setId!)}>{row.agentName || row.agentId}</button> : row.agentName || row.agentId}
        <small>{row.agentId}</small>
        {onOpenAgent && onFocusAgent && data.reports.setId ? <button type="button" className="reported-agent-button" aria-disabled={read.loading}
          aria-label={`${row.agentName || row.agentId}: active users without paid Copilot`} title={`Show active users without paid Copilot for report agent ${row.agentId}`}
          onClick={() => focusAgent(row.agentId, data.reports.setId!)}>Active users without paid Copilot</button> : null}</td>
        <td>{row.creatorType || "Unknown"}</td><td data-numeric>{usageCount(row.responses)}</td><td>{usageDate(row.lastActivityDateUtc)}</td></tr>)}</tbody></table></div>
    {data && !data.value.length ? <div className="reported-users-empty">
      <h4>{data.counts.filtered > 0 ? "No agent relationships on this page" : data.counts.total ? "No agent relationships match" : data.reports.lineages.some(lineage => lineage.kind === "userAgents")
        ? "No agent relationships reported" : "Agent relationships unavailable"}</h4>
      <p>{data.counts.filtered > 0 ? "No relationships on this page. Continue to the next page."
        : data.counts.total ? "Clear the agent search or show all this user's agents."
          : data.reports.lineages.some(lineage => lineage.kind === "userAgents") ? "No agents are listed for this user in the selected report."
            : "Add the Users & agents CSV in Sync to see this user's agents."}</p></div> : null}
    <ReportPageControls {...read} label="agents" />
  </section>;
}
