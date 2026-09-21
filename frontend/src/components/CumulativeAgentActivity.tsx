import { useEffect, useMemo, useRef, useState } from "react";
import type { SortingState } from "@tanstack/react-table";
import { type OfficialUsageOverviewQuery, type OfficialUsageOverviewView } from "../api/client";
import { restoreTableSortFocus, useListTable, type ListColumn } from "../listTable";
import { useOfficialUsageOverview } from "../useOfficialUsageOverview";
import { usageDate, usagePageLabel } from "../usageInsights";
import { ListTableHead } from "./ListTableHead";
import "./cumulativeUsage.css";

const pageSize = 25;
const orders = [
  { value: "recent", label: "Latest reported activity", sortBy: "lastActivity", sortDirection: "desc" },
  { value: "oldest", label: "Oldest reported activity", sortBy: "lastActivity", sortDirection: "asc" },
  { value: "name", label: "Agent name (A-Z)", sortBy: "agentName", sortDirection: "asc" },
  { value: "name-desc", label: "Agent name (Z-A)", sortBy: "agentName", sortDirection: "desc" },
] as const;
type OverviewAgent = OfficialUsageOverviewView["agents"]["value"][number];

export function CumulativeAgentActivity({ revision, onSnapshot, initialQuery = {}, onQueryChange }: {
  revision: number;
  onSnapshot: (setId: string) => void;
  initialQuery?: OfficialUsageOverviewQuery;
  onQueryChange?: (query: OfficialUsageOverviewQuery) => void;
}) {
  const [query, setQuery] = useState(initialQuery);
  const tableRegion = useRef<HTMLDivElement>(null);
  const pendingSortFocus = useRef<string | undefined>(undefined);
  const order = orders.find(item => item.sortBy === (query.sortBy ?? "lastActivity")
    && item.sortDirection === (query.sortDirection ?? "desc")) ?? orders[0];
  const { data, loading, error, retry } = useOfficialUsageOverview({ ...query, limit: pageSize }, revision);
  const sorting: SortingState = [{ id: order.sortBy, desc: order.sortDirection === "desc" }];
  const columns = useMemo<ListColumn<OverviewAgent>[]>(() => [
    { id: "agentName", header: "Agent", accessorFn: agent => agent.agentName || agent.agentId },
    { id: "creatorTypes", header: "Creator types", enableSorting: false },
    { id: "usageEvidence", header: "Usage evidence", enableSorting: false },
    { id: "lastActivity", header: "Latest observed activity", accessorFn: agent => agent.lastActivityDateUtc ?? undefined, sortDescFirst: true },
    { id: "source", header: "Source", enableSorting: false },
  ], []);
  function update(next: OfficialUsageOverviewQuery) {
    setQuery(next);
    onQueryChange?.(next);
  }
  function change(next: OfficialUsageOverviewQuery) {
    update({ ...next, offset: 0 });
  }
  const filtered = Boolean(query.search || query.startDate || query.endDate);
  const table = useListTable({
    data: data?.agents.value ?? [],
    columns,
    sorting,
    manualSorting: true,
    getRowId: agent => agent.agentId,
    onSortingChange: updater => {
      const next = typeof updater === "function" ? updater(sorting) : updater;
      const selected = next[0];
      if (!selected || (selected.id !== "agentName" && selected.id !== "lastActivity")) return;
      pendingSortFocus.current = selected.id;
      change({ ...query, sortBy: selected.id, sortDirection: selected.desc ? "desc" : "asc" });
    },
  });

  useEffect(() => {
    if (!data || loading || !pendingSortFocus.current) return;
    const column = columns.find(item => item.id === pendingSortFocus.current);
    const label = typeof column?.header === "string" ? column.header : undefined;
    restoreTableSortFocus(tableRegion.current, label);
    pendingSortFocus.current = undefined;
  }, [columns, data, loading]);

  return <section className="cumulative-agent-activity" aria-label="Cumulative agent activity" aria-busy={loading}>
    <p className="usage-scope-note">All retained imports, not just the latest bundle. Exact agent IDs are deduplicated across Agents and Users &amp; agents exports.
      {" "}Overlapping response totals are not added; inspect a source snapshot for its original totals and CSV exports.</p>
    {data?.summary.retainedSets ? <section className="summary-grid usage-headline-grid" aria-label="Retained activity summary">
      <div className="metric"><span>Reported agents</span><strong>{data.summary.reportedAgents.toLocaleString()}</strong><small>Distinct IDs across all retained imports</small></div>
      <div className="metric"><span>Reported used agents</span><strong>{data.summary.usedAgents.toLocaleString()}</strong><small>Positive-response evidence in any retained report</small></div>
      <div className="metric"><span>Reported active · 30 days</span><strong>{data.summary.activeAgents30Days.toLocaleString()}</strong><small>{usageDate(data.summary.activeSinceDateUtc)} through {usageDate(data.summary.asOf)} (UTC)</small></div>
    </section> : null}
    {data ? <p className="usage-result-summary">
      {data.summary.retainedSets.toLocaleString()} retained bundles. Observed agent activity: {usageDate(data.summary.earliestActivityDateUtc ?? undefined)} to {usageDate(data.summary.latestActivityDateUtc ?? undefined)}.
      {" "}Last-activity dates are not complete daily coverage. {data.summary.undatedAgents.toLocaleString()} agents have no dated evidence.
    </p> : null}
    <div className="cumulative-activity-filters">
      <label>Search retained agents<input type="search" maxLength={256} value={query.search ?? ""}
        onChange={event => change({ ...query, search: event.target.value || undefined })} /></label>
      <label>Order retained agents<select value={order.value} onChange={event => {
        const next = orders.find(item => item.value === event.target.value);
        if (next) change({ ...query, sortBy: next.sortBy, sortDirection: next.sortDirection });
      }}>{orders.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
      <label>Observed activity on or after (UTC)<input type="date" value={query.startDate ?? ""}
        onChange={event => change({ ...query, startDate: event.target.value || undefined })} /></label>
      <label>Observed activity on or before (UTC)<input type="date" value={query.endDate ?? ""}
        onChange={event => change({ ...query, endDate: event.target.value || undefined })} /></label>
    </div>
    {filtered ? <button type="button" className="secondary" onClick={() => change({})}>Clear activity filters</button> : null}
    <p className="agent-overview-note">Dates select retained observations of an agent&apos;s last activity, not responses occurring within an interval.
      {" "}Summary cards remain history-wide. Inventory associations and report identities are not automatically matched.</p>
    {error ? <div className="error-banner" role="alert">{error}
      <button type="button" className="secondary" onClick={retry}>Retry retained activity</button>
    </div> : null}
    {loading ? <p role="status">Loading retained agent activity...</p> : null}
    {data ? <>
      {!data.summary.retainedSets ? <div className="usage-empty-state"><h3>No retained reports</h3><p>Import the three companion exports to begin collecting activity history. Missing reports do not mean zero tenant usage.</p></div>
        : data.agents.value.length ? <div ref={tableRegion} className="table-shell cumulative-agent-table" role="region" aria-label="Retained agent activity rows" tabIndex={0}>
          <table><ListTableHead table={table} />
            <tbody>{table.getRowModel().rows.map(row => {
              const agent = row.original;
              return <tr key={row.id}>
              <th scope="row">{agent.agentName || agent.agentId}<small>{agent.agentId}</small></th>
              <td>{agent.creatorTypes.join(", ") || "Not reported"}</td>
              <td>{agent.hasResponses ? "Positive responses reported" : "No positive-response evidence"}<small>{agent.observationCount.toLocaleString()} source observations</small></td>
              <td>{usageDate(agent.lastActivityDateUtc ?? undefined)}</td>
              <td><button type="button" className="secondary" onClick={() => onSnapshot(agent.latestSetId)}
                aria-label={`View source snapshot for ${agent.agentName || agent.agentId}`}>View source snapshot</button><small>Latest matching import: {usageDate(agent.latestAcceptedAt)}</small></td>
            </tr>;
            })}</tbody>
          </table>
        </div> : <div className="usage-empty-state"><h3>No retained agents on this page</h3><p>Change the activity filters or return to the first page. Missing evidence is not zero activity.</p></div>}
      <nav className="pagination-controls" aria-label="Retained agent pages">
        <span>{usagePageLabel(data.agents, "agents")}</span>
        <button type="button" className="secondary" disabled={!data.agents.offset} onClick={() => update({ ...query, offset: Math.max(0, data.agents.offset - pageSize) })}>Previous retained agents</button>
        <button type="button" className="secondary" disabled={data.agents.offset + data.agents.limit >= data.agents.count} onClick={() => update({ ...query, offset: data.agents.offset + pageSize })}>Next retained agents</button>
        {data.agents.offset > 0 && !data.agents.value.length ? <button type="button" className="secondary" onClick={() => change(query)}>First retained agent page</button> : null}
      </nav>
    </> : null}
  </section>;
}
