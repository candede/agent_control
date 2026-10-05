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
  return <section className="reported-user-agents" aria-label="Reported agent relationships"><h3>Reported agents</h3>
    <div className="copilot-users-toolbar"><label>Search this user's agents<input type="search" maxLength={256} value={search} onChange={event => setSearch(event.target.value)} /></label>
      <label>Sort relationships<select value={sort} onChange={event => setSort(event.target.value as ReportQuery["sort"])}>
        <option value="responses">Responses to this user</option><option value="name">Agent</option><option value="creatorType">Creator</option><option value="lastActivity">Agent-wide last activity</option></select></label>
      <label>Order<select value={order} onChange={event => setOrder(event.target.value as ReportQuery["order"])}><option value="desc">Descending</option><option value="asc">Ascending</option></select></label>
      {filters ? <button type="button" onClick={() => setShowAll(value => !value)}>{showAll ? "Show matching relationships" : "Show all this user's agents"}</button> : null}
      {search ? <button type="button" onClick={() => setSearch("")}>Clear agent search</button> : null}</div>
    <ReportReadStatus read={read} />
    <div className="copilot-users-table-shell" role="region" aria-label="User agent breakdown" tabIndex={0}><table className="copilot-users-table reported-agent-table"><thead><tr>
      {([["Agent", "name"], ["Creator", "creatorType"], ["Responses to this user", "responses"], ["Agent-wide last activity", "lastActivity"]] as const).map(([label, column]) =>
        <ReportSortHeading key={column} label={label} sort={column} query={{ sort, order }} onChange={query => { setSort(query.sort); setOrder(query.order); }} />)}</tr></thead>
      <tbody>{data?.value.map(row => <tr key={row.id}><td>{onFocusAgent && data.reports.setId ? <button type="button" className="reported-agent-button"
        aria-label={`${row.agentName || row.agentId}: active users without paid Copilot`} title={`Show active users without paid Copilot for report agent ${row.agentId}`}
        onClick={() => onFocusAgent(row.agentId, data.reports.setId!)}>{row.agentName || row.agentId}</button> : row.agentName || row.agentId}<small>{row.agentId}</small></td>
        <td>{row.creatorType || "Unknown"}</td><td>{usageCount(row.responses)}</td><td>{usageDate(row.lastActivityDateUtc)}</td></tr>)}</tbody></table></div>
    {data && !data.value.length ? <p>{data.counts.filtered > 0 ? "No relationships on this page. Continue to the next page."
      : data.reports.lineages.some(lineage => lineage.kind === "userAgents") ? "No agent relationships match." : "Agent relationships unavailable. Import Users & agents in Sync."}</p> : null}
    {read.loading || data ? <ReportPageControls {...read} label="agents" /> : null}
  </section>;
}
