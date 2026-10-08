import { useEffect, useRef, useState } from "react";
import type { ReportAgent, ReportMetadata, ReportQuery, ReportRelationship, ReportSummary } from "../../../backend/src/types/officialReportData";
import type { OfficialReportDetail } from "../../../backend/src/types/officialReportApi";
import { normalizeReportSearch, readReportDetail } from "../api/reportData";
import { ApiError } from "../api/client";
import { useSavedQuery } from "../savedQueries";
import { useReportPage, useReportPrincipalScope } from "../useReportPage";
import { usageAvailabilityLabel, usageCount, usageDate } from "../usageInsights";
import { ReportPageControls, ReportReadStatus } from "./ReportPageControls";
import { ReportExportButton } from "./ReportExportButton";
import { ReportFacet } from "./ReportFacet";
import { UsageReportContext } from "./UsageReportContext";
import "./officialUsage.css";
import "./listTable.css";

export type AgentFilters = Pick<ReportQuery, "search" | "creatorType" | "startDate" | "endDate" | "sort" | "order">;
type Props = { setId?: string; activityWindowDays?: number; revision?: number };
export function ReportingView(props: Props) {
  const principal = useReportPrincipalScope();
  return <ReportingSession key={principal} {...props} />;
}
function ReportingSession({ setId: requestedSetId, activityWindowDays = 30, revision = 0 }: Props) {
  const setId = requestedSetId?.toLowerCase();
  const [query, setQuery] = useState<AgentFilters>({ sort: "responses", order: "desc" });
  const [detail, setDetail] = useState<{ agentId: string; selectionId: string; owner: string }>();
  const trigger = useRef<HTMLButtonElement>(null);
  const [windowDays, setWindow] = useState(activityWindowDays);
  const [requestedWindow, setRequestedWindow] = useState(activityWindowDays);
  if (requestedWindow !== activityWindowDays) { setRequestedWindow(activityWindowDays); setWindow(activityWindowDays); }
  const dateError = Boolean(query.startDate && query.endDate && query.startDate > query.endDate);
  const request = { ...query, search: normalizeReportSearch(query.search ?? "") || undefined, setId, activityWindowDays: windowDays };
  const read = useReportPage<ReportAgent>("official-usage/aggregate", request, revision, !dateError);
  const data = read.data, agents = data?.analytics.agents;
  const principal = useReportPrincipalScope(), owner = JSON.stringify([principal, request, revision, read.recoveryRevision]);
  const snapshotKey = JSON.stringify([principal, setId, setId ? undefined : request, windowDays, revision, read.recoveryRevision]);
  const [snapshot, setSnapshot] = useState<{ key: string; summary: ReportSummary; total: number; reports: ReportMetadata; expiresAt: number }>();
  const [now, setNow] = useState(Date.now);
  const expiresAt = snapshot?.expiresAt;
  useEffect(() => {
    if (expiresAt === undefined) return;
    // Totals can outlive a filter request, but not the evidence that supplied them.
    const checkExpiry = () => setNow(Date.now());
    window.addEventListener("focus", checkExpiry);
    const timer = expiresAt > now
      ? window.setTimeout(checkExpiry, Math.min(2_147_483_647, Math.max(0, expiresAt - Date.now()))) : undefined;
    return () => { window.removeEventListener("focus", checkExpiry); window.clearTimeout(timer); };
  }, [expiresAt, now]);
  const retainedTotals = Boolean(setId && read.error && (!(read.error instanceof ApiError) || read.error.status === 0));
  const retiredSnapshot = snapshot && (snapshot.key !== snapshotKey || snapshot.expiresAt <= now
    || read.invalidated || read.error && !retainedTotals);
  if (data && (snapshot?.key !== snapshotKey || snapshot.summary !== data.summary || snapshot.reports !== data.reports
    || snapshot.total !== data.counts.total || snapshot.expiresAt !== Date.parse(data.selection.expiresAt))) {
    setSnapshot({ key: snapshotKey, summary: data.summary, total: data.counts.total, reports: data.reports,
      expiresAt: Date.parse(data.selection.expiresAt) });
  } else if (retiredSnapshot) setSnapshot(undefined);
  const context = !retiredSnapshot && !dateError ? snapshot : undefined;
  const hasEvidence = Boolean(context?.reports.setId && context.reports.lineages.some(lineage => lineage.kind === "agents" || lineage.kind === "userAgents"));
  if (detail && (detail.owner !== owner || read.error || read.invalidated || !data && !read.loading
    || data && detail.selectionId !== data.selection.id.toLowerCase())) setDetail(undefined);
  function restartSelection() { setDetail(undefined); read.restart(); }
  const table = useRef<HTMLDivElement>(null);
  function sort(column: NonNullable<ReportQuery["sort"]>) { setQuery({ ...query, sort: column, order: query.sort === column && query.order === "desc" ? "asc" : "desc" }); }
  return <section className="reporting-view" aria-label="Agent activity report">
    <h3>Agent activity</h3><ReportReadStatus read={{ ...read, restart: restartSelection }} />{dateError ? <p role="alert">The activity start date must be on or before the end date.</p> : null}
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
    </> : context ? <><h4>{context.reports.setId ? "Agent usage evidence unavailable" : usageAvailabilityLabel(context.reports.availability)}</h4>
      <p>Missing reports are not zero activity.</p></> : null}
    <div className="report-filters"><label>Search agents<input type="search" value={query.search ?? ""} maxLength={256} onChange={event => setQuery({ ...query, search: event.target.value || undefined })} /></label>
      <ReportFacet path="official-usage/aggregate" selectionId={read.selectionId} field="creatorType" value={query.creatorType}
        onChange={creatorType => setQuery({ ...query, creatorType: creatorType ?? undefined })} onRestartSelection={restartSelection}
        onSelectionInvalidated={read.invalidateSelection} />
      <label>Activity start date<input type="date" value={query.startDate ?? ""} onChange={event => setQuery({ ...query, startDate: event.target.value || undefined })} /></label>
      <label>Activity end date<input type="date" value={query.endDate ?? ""} onChange={event => setQuery({ ...query, endDate: event.target.value || undefined })} /></label>
      <p>Last-activity filters select agents by their reported dates. Responses remain full-snapshot totals for those agents, not totals within the selected dates.</p>
      <label>Activity window (days)<input type="number" min={1} max={365} value={windowDays} onChange={event => {
        const days = Number(event.target.value); if (Number.isInteger(days) && days >= 1 && days <= 365) setWindow(days);
      }} /></label>
      <label>Sort agents<select aria-label="Sort agents" value={`${query.sort}:${query.order}`} onChange={event => {
        const [sort, order] = event.target.value.split(":"); setQuery({ ...query, sort: sort as AgentFilters["sort"], order: order as AgentFilters["order"] });
      }}>{(["responses", "activeUsers", "licensedUsers", "unlicensedUsers", "lastActivity", "name"] as const).flatMap(column => ["asc", "desc"].map(order =>
        <option key={`${column}:${order}`} value={`${column}:${order}`}>{column} {order === "asc" ? "ascending" : "descending"}</option>))}</select></label>
      <button type="button" className="secondary" onClick={() => setQuery({ sort: "responses", order: "desc" })}>Clear filters</button>
      <ReportExportButton key={read.selectionId} selectionId={read.selectionId} kind="official_agents" label="Export agent CSV"
        onSelectionInvalidated={read.invalidateSelection} disabled={dateError || !hasEvidence || !read.selectionId} />
    </div>
    {data && hasEvidence ? <p role="status">{data.counts.filtered.toLocaleString()} matching agents</p> : null}
      <div ref={table} className="table-shell report-agent-table" role="region" aria-label="Reported agent activity" aria-busy={read.loading} tabIndex={0}><table><thead><tr>
        {(["name", "responses", "activeUsers", "lastActivity"] as const).map(column => <th key={column} aria-sort={query.sort === column ? query.order === "asc" ? "ascending" : "descending" : "none"}>
          <button type="button" className="table-sort-heading" onClick={() => sort(column)}>{column === "name" ? "Agent" : column === "responses" ? "Responses" : column === "activeUsers" ? "Active users" : "Last reported activity"}</button></th>)}
        <th>Creator</th><th>Licensed / unlicensed occurrences</th><th>Comparison</th></tr></thead><tbody>{data?.value.map(row => <tr key={row.agentId}>
          <td><button type="button" className="usage-agent-name" onClick={event => { trigger.current = event.currentTarget;
            setDetail(detail?.agentId === row.agentId ? undefined : { agentId: row.agentId, selectionId: data.selection.id.toLowerCase(), owner });
          }} aria-expanded={detail?.agentId === row.agentId}>{row.agentName || row.agentId}</button><small>{row.agentId}</small></td>
          <td>{usageCount(row.responses)}{row.responseSource === "userAgents" ? <small>Users &amp; agents only</small> : null}</td>
          <td>{usageCount(row.activeUsers)}<small>{row.activeUsersBasis === "unknown" ? "Reach not reported" : "Distinct report identities"}</small></td><td>{usageDate(row.lastActivityDateUtc)}</td>
          <td>{row.creatorType || "Unknown"}</td><td>{usageCount(row.licensedUserOccurrences)} / {usageCount(row.unlicensedUserOccurrences)}</td>
          <td>{row.responseComparison}<small>Agents: {usageCount(row.reportResponses)}; bridge: {usageCount(row.bridgeResponses)}</small></td></tr>)}</tbody></table></div>
      {data && hasEvidence && !data.value.length ? <h4>{data.counts.total === 0 ? "No reported agents"
        : data.counts.filtered === 0 ? "No agents match these filters" : "No agents on this page"}</h4> : null}
      <ReportPageControls {...read} label="agents" />
      {agents && hasEvidence ? <details><summary>Activity analytics</summary><p>{agents.inactive.toLocaleString()} inactive by reported date; {agents.neverUsed.toLocaleString()} without a reported last-activity date; activity anchor {usageDate(agents.anchorDateUtc)}.</p>
        <p>{agents.windowAgents.toLocaleString()} agents last active within {agents.windowDays} days of the activity anchor.
          {" "}Full-snapshot totals for those agents: {usageCount(agents.windowResponses)} responses; {agents.windowDistinctActiveUsers.toLocaleString()} distinct active users.</p>
        <h4>Most responses</h4><ol>{agents.mostResponses.map(item => <li key={item.agentId}>{item.name}: {usageCount(item.responses)}</li>)}</ol>
        <h4>Least responses</h4><ol>{agents.leastResponses.map(item => <li key={item.agentId}>{item.name}: {usageCount(item.responses)}</li>)}</ol></details> : null}
      {detail ? <ReportAgentDetail key={detail.selectionId + detail.agentId} selectionId={detail.selectionId} agentId={detail.agentId}
        revision={revision}
        onClose={() => { setDetail(undefined); trigger.current?.focus(); }} onRestartSelection={restartSelection}
        onSelectionInvalidated={read.invalidateSelection} /> : null}
  </section>;
}
export function ReportAgentDetail({ selectionId: requestedSelectionId, agentId, onClose, onRestartSelection, onSelectionInvalidated, revision = 0 }: {
  selectionId: string; agentId: string; onClose: () => void; onRestartSelection?: () => void; revision?: number;
  onSelectionInvalidated?: () => void;
}) {
  const principal = useReportPrincipalScope(), selectionId = requestedSelectionId.toLowerCase();
  const owner = JSON.stringify([principal, selectionId, agentId, revision]);
  const [rejected, setRejected] = useState<{ owner: string; error: Error }>();
  const [now, setNow] = useState(Date.now);
  if (rejected && rejected.owner !== owner) setRejected(undefined);
  const path = `official-usage/agents/${encodeURIComponent(agentId)}`;
  const detail = useSavedQuery<OfficialReportDetail<ReportAgent>>({ queryKey: ["saved", "report-agent-detail", principal, selectionId, agentId, revision], gcTime: 0, staleTime: Infinity,
    queryFn: async ({ signal }) => {
      const result = await readReportDetail<ReportAgent>(path, selectionId, signal);
      signal.throwIfAborted();
      if (result.selection.id.toLowerCase() !== selectionId || result.value.agentId !== agentId) {
        throw new ApiError(409, "selection_invalidated", "Exact agent evidence does not match this selection.");
      }
      if (!(Date.parse(result.selection.expiresAt) > Date.now())) {
        throw new ApiError(409, "selection_invalidated", "The agent selection has expired. Load a new selection.");
      }
      return result;
    } });
  const expiresAt = detail.data ? Date.parse(detail.data.selection.expiresAt) : undefined;
  useEffect(() => {
    const checkExpiry = () => setNow(Date.now());
    window.addEventListener("focus", checkExpiry);
    const timer = expiresAt !== undefined && expiresAt > now
      ? window.setTimeout(checkExpiry, Math.min(2_147_483_647, Math.max(0, expiresAt - Date.now()))) : undefined;
    return () => { window.removeEventListener("focus", checkExpiry); window.clearTimeout(timer); };
  }, [expiresAt, now]);
  const error = detail.error ?? (rejected?.owner === owner ? rejected.error : null) ?? (expiresAt !== undefined && expiresAt <= now
    ? new ApiError(409, "selection_invalidated", "The agent selection has expired. Load a new selection.") : null);
  const invalidated = error instanceof ApiError && error.code === "selection_invalidated";
  useEffect(() => {
    if (invalidated) onSelectionInvalidated?.();
  }, [invalidated, onSelectionInvalidated]);
  const data = error || detail.isFetching ? undefined : detail.data;
  const [search, setSearch] = useState("");
  const children = useReportPage<ReportRelationship>(`${path}/users`, { selectionId, search: normalizeReportSearch(search) || undefined, sort: "responses", order: "desc" },
    revision, Boolean(data), onRestartSelection);
  if (!error && children.invalidated && children.error) setRejected({ owner, error: children.error });
  return <section className="usage-agent-detail" aria-label="Exact reported agent details"><h4>{data ? data.value.agentName : agentId}</h4>
    <button type="button" onClick={onClose}>Close agent details</button>
    {detail.isPending || detail.isFetching ? <p role="status">Loading exact agent details...</p>
      : error && !(invalidated && onSelectionInvalidated) ? <p role="alert">{error.message}{" "}
        {invalidated ? onRestartSelection ? <button type="button" onClick={onRestartSelection}>Restart selection</button>
          : "Close this detail and restart its parent selection."
          : <button type="button" onClick={() => { void detail.refetch({ cancelRefetch: false }); }}>Retry agent details</button>}</p> : null}
    {data ? <><p>Exact report identity: {data.value.agentId}; inventory identity unresolved until linked.</p>
      <p>Responses: {usageCount(data.value.responses)}. Distinct active users: {usageCount(data.value.activeUsers)}.</p>
      <p>Licensed occurrences: {usageCount(data.value.licensedUserOccurrences)}. Unlicensed occurrences: {usageCount(data.value.unlicensedUserOccurrences)}.
        {" "}Licensed and unlicensed source categories can overlap and are never added.</p>
      <p>Agents export: {usageCount(data.value.reportResponses)}; Users &amp; agents: {usageCount(data.value.bridgeResponses)};
        {" "}comparison {data.value.responseComparison}.</p></> : null}
    <section aria-label="Agent users"><label>Search reported agent users<input type="search" maxLength={256} value={search} onChange={event => setSearch(event.target.value)} /></label>
    <ReportReadStatus read={children} /><div className="copilot-users-table-shell" role="region" aria-label="Reported agent users" tabIndex={0}>
      <table className="copilot-users-table"><thead><tr><th scope="col">Username</th><th scope="col">Responses</th><th scope="col">Last activity</th></tr></thead><tbody>
      {children.data?.value.map(row => <tr key={row.id}><th scope="row">{row.username}</th><td>{usageCount(row.responses)}</td><td>{usageDate(row.lastActivityDateUtc)}</td></tr>)}</tbody></table></div>
    {children.data && !children.data.value.length ? <p>{children.data.counts.filtered > 0
      ? "No users on this page. Use the page controls to continue."
      : children.data.counts.total > 0 ? "No users match this search." : "No users listed for this agent in the selected report."}</p> : null}
    <ReportPageControls {...children} label="relationships" /></section>
  </section>;
}
