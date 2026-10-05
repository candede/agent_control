import { useRef, useState } from "react";
import type { ReportAgent, ReportMetadata, ReportQuery, ReportRelationship, ReportSummary } from "../../../backend/src/types/officialReportData";
import type { OfficialReportDetail } from "../../../backend/src/types/officialReportApi";
import { readReportDetail } from "../api/reportData";
import { ApiError } from "../api/client";
import { useSavedQuery } from "../savedQueries";
import { useReportPage, useReportPrincipalScope } from "../useReportPage";
import { usageCount, usageDate } from "../usageInsights";
import { ReportPageControls, ReportReadStatus } from "./ReportPageControls";
import { ReportExportButton } from "./ReportExportButton";
import { ReportFacet } from "./ReportFacet";
import { UsageReportContext } from "./UsageReportContext";
import "./officialUsage.css";
import "./listTable.css";

export type AgentFilters = Pick<ReportQuery, "search" | "creatorType" | "startDate" | "endDate" | "sort" | "order">;
export function ReportingView({ setId, activityWindowDays = 30, revision = 0 }: { setId?: string; activityWindowDays?: number; revision?: number }) {
  const [query, setQuery] = useState<AgentFilters>({ sort: "responses", order: "desc" });
  const [detail, setDetail] = useState<{ agentId: string; selectionId: string; setId?: string }>();
  const trigger = useRef<HTMLButtonElement>(null);
  const [window, setWindow] = useState(activityWindowDays);
  const [requestedWindow, setRequestedWindow] = useState(activityWindowDays);
  if (requestedWindow !== activityWindowDays) { setRequestedWindow(activityWindowDays); setWindow(activityWindowDays); }
  const dateError = Boolean(query.startDate && query.endDate && query.startDate > query.endDate);
  const read = useReportPage<ReportAgent>("official-usage/aggregate", { ...query, setId, activityWindowDays: window }, revision, !dateError);
  const data = read.data, agents = data?.analytics.agents;
  const principal = useReportPrincipalScope(), snapshotKey = JSON.stringify([principal, setId, setId ? undefined : query, window]);
  const [snapshot, setSnapshot] = useState<{ key: string; summary: ReportSummary; total: number; reports: ReportMetadata }>();
  if (data && (snapshot?.key !== snapshotKey || snapshot.summary !== data.summary)) {
    setSnapshot({ key: snapshotKey, summary: data.summary, total: data.counts.total, reports: data.reports });
  }
  const retainedTotals = Boolean(setId && read.error && (!(read.error instanceof ApiError) || read.error.status === 0));
  if (snapshot && read.error && !retainedTotals) setSnapshot(undefined);
  const context = (!read.error || retainedTotals) && !dateError && snapshot?.key === snapshotKey ? snapshot : undefined;
  const hasEvidence = Boolean(context?.reports.setId && context.reports.lineages.some(lineage => lineage.kind === "agents" || lineage.kind === "userAgents"));
  if (detail && (read.error || detail.setId !== setId || data && detail.selectionId !== data.selection.id)) setDetail(undefined);
  function restartSelection() { setDetail(undefined); read.restart(); }
  const table = useRef<HTMLDivElement>(null);
  function sort(column: NonNullable<ReportQuery["sort"]>) { setQuery({ ...query, sort: column, order: query.sort === column && query.order === "desc" ? "asc" : "desc" }); }
  return <section className="reporting-view" aria-label="Agent activity report">
    <h3>Agent activity</h3><ReportReadStatus read={read} />{dateError ? <p role="alert">The activity start date must be on or before the end date.</p> : null}
    {context ? <UsageReportContext reports={context.reports} /> : null}
    {context && retainedTotals ? <p role="status">Showing previously read snapshot totals; filtered rows are unavailable.</p> : null}
    {hasEvidence && context ? <><div className="report-metric-groups"><section className="agent-overview-metrics" aria-label="Snapshot tenant totals">
      <div className="metric"><span>Responses</span><strong>{usageCount(context.summary.reportedResponses)}</strong></div>
      <div className="metric"><span>Distinct active report users</span><strong>{usageCount(context.summary.distinctActiveReportUsers)}</strong><small>Not additive across agents</small></div></section>
      <div className="agent-overview-metrics"><div className="metric"><span>Reported agents</span><strong>{usageCount(context.total)}</strong></div>
        <div className="metric"><span>Responses in this view</span><strong>{usageCount(data?.analytics.responses)}</strong></div>
        <div className="metric"><span>Licensed occurrences</span><strong>{usageCount(context.summary.licensedOccurrences)}</strong></div>
        <div className="metric"><span>Unlicensed occurrences</span><strong>{usageCount(context.summary.unlicensedOccurrences)}</strong></div></div></div>
      <p>Users/bridge reconciliation: {context.summary.responseReconciliation}. Missing metrics are unknown, not zero.</p>
    </> : context ? <><h4>{context.reports.setId ? "Agent usage evidence unavailable" : "Reports not imported"}</h4>
      <p>Missing reports are not zero activity.</p></> : null}
    <div className="report-filters"><label>Search agents<input type="search" value={query.search ?? ""} maxLength={256} onChange={event => setQuery({ ...query, search: event.target.value || undefined })} /></label>
      <ReportFacet path="official-usage/aggregate" selectionId={data?.selection.id} field="creatorType" value={query.creatorType}
        onChange={creatorType => setQuery({ ...query, creatorType: creatorType ?? undefined })} onRestartSelection={restartSelection} />
      <label>Activity start date<input type="date" value={query.startDate ?? ""} onChange={event => setQuery({ ...query, startDate: event.target.value || undefined })} /></label>
      <label>Activity end date<input type="date" value={query.endDate ?? ""} onChange={event => setQuery({ ...query, endDate: event.target.value || undefined })} /></label>
      <p>Last-activity filters select agents by their reported dates. Responses remain full-snapshot totals for those agents, not totals within the selected dates.</p>
      <label>Activity window (days)<input type="number" min={1} max={365} value={window} onChange={event => {
        const days = Number(event.target.value); if (Number.isInteger(days) && days >= 1 && days <= 365) setWindow(days);
      }} /></label>
      <label>Sort agents<select aria-label="Sort agents" value={`${query.sort}:${query.order}`} onChange={event => {
        const [sort, order] = event.target.value.split(":"); setQuery({ ...query, sort: sort as AgentFilters["sort"], order: order as AgentFilters["order"] });
      }}>{(["responses", "activeUsers", "licensedUsers", "unlicensedUsers", "lastActivity", "name"] as const).flatMap(column => ["asc", "desc"].map(order =>
        <option key={`${column}:${order}`} value={`${column}:${order}`}>{column} {order === "asc" ? "ascending" : "descending"}</option>))}</select></label>
      <button type="button" className="secondary" onClick={() => setQuery({ sort: "responses", order: "desc" })}>Clear filters</button>
      <ReportExportButton key={data?.selection.id} selectionId={data?.selection.id} kind="official_agents" label="Export agent CSV" disabled={read.loading || dateError || !hasEvidence || !data} />
    </div>
    {data && hasEvidence ? <p role="status">{data.counts.filtered.toLocaleString()} matching agents</p> : null}
      <div ref={table} className="table-shell report-agent-table" role="region" aria-label="Reported agent activity" aria-busy={read.loading} tabIndex={0}><table><thead><tr>
        {(["name", "responses", "activeUsers", "lastActivity"] as const).map(column => <th key={column} aria-sort={query.sort === column ? query.order === "asc" ? "ascending" : "descending" : "none"}>
          <button type="button" className="table-sort-heading" onClick={() => sort(column)}>{column === "name" ? "Agent" : column === "responses" ? "Responses" : column === "activeUsers" ? "Active users" : "Last reported activity"}</button></th>)}
        <th>Creator</th><th>Licensed / unlicensed occurrences</th><th>Comparison</th></tr></thead><tbody>{data?.value.map(row => <tr key={row.agentId}>
          <td><button type="button" className="usage-agent-name" onClick={event => { trigger.current = event.currentTarget;
            setDetail(detail?.agentId === row.agentId ? undefined : { agentId: row.agentId, selectionId: data.selection.id, setId });
          }} aria-expanded={detail?.agentId === row.agentId}>{row.agentName || row.agentId}</button><small>{row.agentId}</small></td>
          <td>{usageCount(row.responses)}{row.responseSource === "userAgents" ? <small>Users &amp; agents only</small> : null}</td>
          <td>{usageCount(row.activeUsers)}<small>{row.activeUsersBasis === "unknown" ? "Reach not reported" : "Distinct report identities"}</small></td><td>{usageDate(row.lastActivityDateUtc)}</td>
          <td>{row.creatorType || "Unknown"}</td><td>{usageCount(row.licensedUserOccurrences)} / {usageCount(row.unlicensedUserOccurrences)}</td>
          <td>{row.responseComparison}<small>Agents: {usageCount(row.reportResponses)}; bridge: {usageCount(row.bridgeResponses)}</small></td></tr>)}</tbody></table></div>
      {data && hasEvidence && !data.value.length ? <h4>{data.counts.total === 0 ? "No reported agents" : "No agents on this page"}</h4> : null}
      <ReportPageControls {...read} label="agents" />
      {agents ? <details><summary>Activity analytics</summary><p>{agents.inactive.toLocaleString()} inactive, {agents.neverUsed.toLocaleString()} never used; activity anchor {usageDate(agents.anchorDateUtc)}.</p>
        <p>{agents.windowAgents.toLocaleString()} agents and {usageCount(agents.windowResponses)} responses in {agents.windowDays} days; {agents.windowDistinctActiveUsers.toLocaleString()} distinct active users.</p>
        <h4>Most responses</h4><ol>{agents.mostResponses.map(item => <li key={item.agentId}>{item.name}: {usageCount(item.responses)}</li>)}</ol>
        <h4>Least responses</h4><ol>{agents.leastResponses.map(item => <li key={item.agentId}>{item.name}: {usageCount(item.responses)}</li>)}</ol></details> : null}
      {detail && data ? <ReportAgentDetail key={detail.selectionId + detail.agentId} selectionId={detail.selectionId} agentId={detail.agentId}
        revision={revision}
        onClose={() => { setDetail(undefined); trigger.current?.focus(); }} onRestartSelection={restartSelection} /> : null}
  </section>;
}
export function ReportAgentDetail({ selectionId, agentId, onClose, onRestartSelection, revision = 0 }: {
  selectionId: string; agentId: string; onClose: () => void; onRestartSelection?: () => void; revision?: number;
}) {
  const principal = useReportPrincipalScope();
  const path = `official-usage/agents/${encodeURIComponent(agentId)}`;
  const detail = useSavedQuery<OfficialReportDetail<ReportAgent>>({ queryKey: ["saved", "report-agent-detail", principal, selectionId, agentId, revision], gcTime: 0,
    placeholderData: (previous, previousQuery) => previousQuery?.queryKey[2] === principal
      && previousQuery.queryKey[3] === selectionId && previousQuery.queryKey[4] === agentId ? previous : undefined,
    queryFn: async ({ signal }) => {
      const result = await readReportDetail<ReportAgent>(path, selectionId, signal);
      if (result.selection.id !== selectionId || result.value.agentId !== agentId) {
        throw new ApiError(409, "selection_invalidated", "Exact agent evidence does not match this selection.");
      }
      return result;
    } });
  const [search, setSearch] = useState("");
  const children = useReportPage<ReportRelationship>(`${path}/users`, { selectionId, search: search || undefined, sort: "responses", order: "desc" },
    revision, Boolean(detail.data) && !detail.isError, onRestartSelection);
  return <section className="usage-agent-detail" aria-label="Exact reported agent details"><h4>{!detail.isError && detail.data ? detail.data.value.agentName : agentId}</h4>
    <button type="button" onClick={onClose}>Close agent details</button>{detail.error ? <p role="alert">{detail.error.message}{" "}
      {detail.error instanceof ApiError && detail.error.code === "selection_invalidated" && onRestartSelection
        ? <button type="button" onClick={onRestartSelection}>Restart selection</button>
        : <button type="button" onClick={() => { void detail.refetch(); }}>Retry agent details</button>}</p> : null}
    {detail.data && !detail.isError ? <><p>Exact report identity: {detail.data.value.agentId}; inventory identity unresolved until linked.</p>
      <p>Responses: {usageCount(detail.data.value.responses)}. Distinct active users: {usageCount(detail.data.value.activeUsers)}.</p>
      <p>Licensed occurrences: {usageCount(detail.data.value.licensedUserOccurrences)}. Unlicensed occurrences: {usageCount(detail.data.value.unlicensedUserOccurrences)}.
        {" "}Licensed and unlicensed source categories can overlap and are never added.</p>
      <p>Agents export: {usageCount(detail.data.value.reportResponses)}; Users &amp; agents: {usageCount(detail.data.value.bridgeResponses)};
        {" "}comparison {detail.data.value.responseComparison}.</p></> : null}
    <section aria-label="Agent users"><label>Search reported agent users<input type="search" maxLength={256} value={search} onChange={event => setSearch(event.target.value)} /></label>
    <ReportReadStatus read={children} /><div className="copilot-users-table-shell" role="region" aria-label="Reported agent users" tabIndex={0}>
      <table className="copilot-users-table"><thead><tr><th scope="col">Username</th><th scope="col">Responses</th><th scope="col">Last activity</th></tr></thead><tbody>
      {children.data?.value.map(row => <tr key={row.id}><th scope="row">{row.username}</th><td>{usageCount(row.responses)}</td><td>{usageDate(row.lastActivityDateUtc)}</td></tr>)}</tbody></table></div>
    {children.data && !children.data.value.length ? <p>No users listed in this report.</p> : null}
    <ReportPageControls {...children} label="relationships" /></section>
  </section>;
}
