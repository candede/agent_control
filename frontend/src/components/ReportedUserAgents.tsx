import { useState } from "react";
import type { ReportQuery, ReportRelationship } from "../../../backend/src/types/officialReportData";
import { useReportPage } from "../useReportPage";
import { usageCount, usageDate } from "../usageInsights";
import { ReportReadStatus, ReportPageControls } from "./ReportPageControls";
import { ReportSortHeading } from "./ReportSortHeading";

export type UserRelationshipFilters = Pick<ReportQuery, "agentId" | "creatorType" | "responsesOnly">;
export function ReportedUserAgents({ path, selectionId, filters, onFocusAgent, onRestartSelection }: {
  path: string; selectionId: string; filters?: UserRelationshipFilters; onFocusAgent?: (agentId: string, reportSetId: string) => void;
  onRestartSelection?: () => void;
}) {
  const [search, setSearch] = useState(""), [showAll, setShowAll] = useState(false);
  const [sort, setSort] = useState<ReportQuery["sort"]>("responses"), [order, setOrder] = useState<ReportQuery["order"]>("desc");
  const read = useReportPage<ReportRelationship>(path, { selectionId, ...(showAll ? {} : filters), search: search || undefined, sort, order }, 0, true, onRestartSelection);
  const data = read.data;
  const constrained = Boolean(filters?.agentId || filters?.creatorType || filters?.responsesOnly);
  return <section className="reported-user-agents" aria-label="Reported agent relationships"><h3>Reported agents</h3>
    <div className="copilot-users-toolbar"><label><span>Search this user's agents</span><input type="search" maxLength={256} placeholder="Agent name, exact ID or creator" value={search} onChange={event => setSearch(event.target.value)} /></label>
      {constrained ? <button type="button" className="secondary" onClick={() => setShowAll(value => !value)}>{showAll ? "Show matching relationships" : "Show all this user's agents"}</button> : null}
      {search ? <button type="button" className="secondary" onClick={() => setSearch("")}>Clear agent search</button> : null}</div>
    {constrained ? <p className="reported-users-note">{showAll ? "Showing all reported agents for this user." : "Showing agents matching the selected filters."}</p> : null}
    <ReportReadStatus read={read} />
    {!data || data.value.length ? <div className="copilot-users-table-shell" role="region" aria-label="User agent breakdown" tabIndex={0}><table className="copilot-users-table reported-agent-table"><thead><tr>
      {([["Agent", "name"], ["Creator", "creatorType"], ["Responses to this user", "responses"], ["Agent-wide last activity", "lastActivity"]] as const).map(([label, column]) =>
        <ReportSortHeading key={column} label={label} sort={column} query={{ sort, order }} onChange={query => { setSort(query.sort); setOrder(query.order); }} />)}</tr></thead>
      <tbody>{data?.value.map(row => <tr key={row.id}><td>{onFocusAgent && data.reports.setId ? <button type="button" className="reported-agent-button"
        aria-label={`${row.agentName || row.agentId}: active users without paid Copilot`} title={`Show active users without paid Copilot for report agent ${row.agentId}`}
        onClick={() => onFocusAgent(row.agentId, data.reports.setId!)}>{row.agentName || row.agentId}</button> : row.agentName || row.agentId}<small>{row.agentId}</small></td>
        <td>{row.creatorType || "Unknown"}</td><td data-numeric>{usageCount(row.responses)}</td><td>{usageDate(row.lastActivityDateUtc)}</td></tr>)}</tbody></table></div> : null}
    {data && !data.value.length ? <div className="reported-users-empty">
      <h4>{data.counts.total ? "No agent relationships match" : data.reports.lineages.some(lineage => lineage.kind === "userAgents")
        ? "No agent relationships reported" : "Agent relationships unavailable"}</h4>
      <p>{data.counts.filtered > 0 ? "No relationships on this page. Continue to the next page."
        : data.counts.total ? "Clear the agent search or show all this user's agents."
          : data.reports.lineages.some(lineage => lineage.kind === "userAgents") ? "No agents are listed for this user in the selected report."
            : "Add the Users & agents CSV in Sync to see this user's agents."}</p></div> : null}
    {read.loading || data ? <ReportPageControls {...read} label="agents" /> : null}
  </section>;
}
