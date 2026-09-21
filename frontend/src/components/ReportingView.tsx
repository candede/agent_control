import { Fragment, useEffect, useId, useMemo, useRef, useState, type RefObject } from "react";
import type { SortingState } from "@tanstack/react-table";
import {
  downloadOfficialUsageCsv,
  type OfficialUsageAgentQuery,
  type OfficialUsageAggregateView,
} from "../api/client";
import { downloadBlob } from "../agentExport";
import { restoreTableSortFocus, useListTable, type ListColumn } from "../listTable";
import { usageAvailabilityLabel, usageCount, usageCoverageLabel, usageDate, usagePageLabel } from "../usageInsights";
import { ListTableHead } from "./ListTableHead";
import "./officialUsage.css";

type AgentFilters = Pick<OfficialUsageAgentQuery, "search" | "creatorType" | "startDate" | "endDate" | "sortBy" | "sortDirection">;
type Agent = OfficialUsageAggregateView["agents"]["value"][number];
type Comparison = OfficialUsageAggregateView["summary"]["usage"]["responseReconciliation"];
type Props = {
  data?: OfficialUsageAggregateView;
  query: AgentFilters;
  offset: number;
  loading?: boolean;
  error?: string;
  onRetry: () => void;
  onAgentPageChange: (offset: number) => void;
  onAgentQueryChange: (query: AgentFilters) => void;
};

const orders = [
  { id: "responses-desc", label: "Most responses", sortBy: "responses", sortDirection: "desc" },
  { id: "responses-asc", label: "Fewest responses (including zero)", sortBy: "responses", sortDirection: "asc" },
  { id: "activeUsers-desc", label: "Most active users", sortBy: "activeUsers", sortDirection: "desc" },
  { id: "activeUsers-asc", label: "Fewest active users", sortBy: "activeUsers", sortDirection: "asc" },
  { id: "lastActivity-desc", label: "Latest activity", sortBy: "lastActivity", sortDirection: "desc" },
  { id: "lastActivity-asc", label: "Oldest activity", sortBy: "lastActivity", sortDirection: "asc" },
  { id: "agentName-asc", label: "Agent name (A-Z)", sortBy: "agentName", sortDirection: "asc" },
  { id: "agentName-desc", label: "Agent name (Z-A)", sortBy: "agentName", sortDirection: "desc" },
] as const;
const sortableAgentColumns = new Set<NonNullable<AgentFilters["sortBy"]>>(["agentName", "responses", "activeUsers", "lastActivity"]);

export function ReportingView({ data, query, offset, loading = false, error, onRetry, onAgentPageChange, onAgentQueryChange }: Props) {
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<{ key: string; message: string }>();
  const exportController = useRef<AbortController | undefined>(undefined);
  const tableRegion = useRef<HTMLDivElement>(null);
  const pendingSortFocus = useRef<string | undefined>(undefined);
  const queryKey = filterKey(query);
  const exportKey = JSON.stringify([data?.activeSet?.id, data?.lineages.map(lineage => lineage.versionId), queryKey]);
  const filtersApplied = Boolean(data && filterKey(data.filters) === queryKey && data.agents.offset === offset);
  const ready = Boolean(data?.activeSet && filtersApplied && !loading && !error);
  const hasAgentEvidence = Boolean(data?.lineages.some(lineage => lineage.kind === "agents" || lineage.kind === "userAgents"));
  const hasFilters = Boolean(query.search || query.creatorType || query.startDate || query.endDate
    || query.sortBy && query.sortBy !== "responses" || query.sortDirection && query.sortDirection !== "desc");
  const dateError = query.startDate && query.endDate && query.startDate > query.endDate
    ? "The activity start date must be on or before the end date." : undefined;
  const pending = !error && !dateError && (loading || Boolean(data && !filtersApplied));
  const sorting: SortingState = [{
    id: query.sortBy ?? "responses",
    desc: (query.sortDirection ?? "desc") === "desc",
  }];

  useEffect(() => () => {
    exportController.current?.abort();
    exportController.current = undefined;
    setExporting(false);
    setExportError(undefined);
  }, [exportKey, loading, error]);

  useEffect(() => {
    if (!ready || !pendingSortFocus.current) return;
    const label = {
      agentName: "Agent",
      responses: "Responses",
      activeUsers: "Active users",
      lastActivity: "Last reported activity",
    }[pendingSortFocus.current];
    restoreTableSortFocus(tableRegion.current, label);
    pendingSortFocus.current = undefined;
  }, [data, ready]);

  async function exportAgents() {
    if (!ready || !data?.activeSet || dateError) return;
    exportController.current?.abort();
    const controller = new AbortController();
    exportController.current = controller;
    setExporting(true);
    setExportError(undefined);
    try {
      const { search, creatorType, startDate, endDate, sortBy, sortDirection } = data.filters;
      const blob = await downloadOfficialUsageCsv("aggregate", {
        setId: data.activeSet.id, search, creatorType, startDate, endDate, sortBy, sortDirection,
      }, controller.signal);
      if (!controller.signal.aborted) downloadBlob("official-agent-usage.csv", blob);
    } catch (failure) {
      if (!controller.signal.aborted) {
        setExportError({ key: exportKey, message: failure instanceof Error ? failure.message : "The agent usage export failed." });
      }
    } finally {
      if (exportController.current === controller) {
        exportController.current = undefined;
        setExporting(false);
      }
    }
  }

  return <section className="reporting-view" aria-label="Agent activity report">
    {error ? <div className="error-banner" role="alert">
      {error} <button type="button" className="secondary" onClick={onRetry}>Retry report</button>
      {data ? <p>The last loaded summary is shown. Agent results and export are unavailable until the report reloads.</p> : null}
    </div> : null}
    {!data && !error && !dateError ? <p role="status">Loading official usage...</p> : null}
    {data ? <>
      <div className="usage-report-context">
        <span className={`usage-state${data.availability === "active" ? "" : " usage-state-attention"}`}>{usageAvailabilityLabel(data.availability)}</span>
        <span>{usageCoverageLabel(data.activeSet)}</span>
        {data.activeSet?.acceptedAt ? <span>Imported {usageDate(data.activeSet.acceptedAt)}</span> : null}
      </div>
      {data.availability === "stale" ? <p className="usage-context-warning" role="status">These reports are out of date. Historical totals remain available, but refresh the source exports before adoption decisions.</p> : null}
      {data.activeSet ? <>
        <section className="summary-grid usage-headline-grid" aria-label="Usage summary">
          <Metric label="Responses" value={data.summary.usage.totalResponses} hint="Agents export total" />
          <Metric label="Active report users" value={data.summary.usage.totalActiveUsers} hint="Distinct identities with positive responses" />
          <Metric label="Reported agents" value={hasAgentEvidence ? data.summary.activityWindow.totalAgents : null} hint="Across the selected report bundle" />
        </section>
        <p className="usage-scope-note">Agent activity only, not total Copilot utilization or license assignments.
          {data.activeSet.reportingPeriod.provenance === "activity_range" ? " Observed dates are last-activity dates, not a proven reporting window." : ""}
        </p>
      </> : null}
    </> : null}

    {data?.activeSet ? <ReportSources data={data} /> : null}
    <section className="usage-agent-explorer" aria-labelledby="agent-comparison-title" aria-busy={pending}>
      <header className="report-section-header">
        <div><h3 id="agent-comparison-title">Agent comparison</h3><p>Compare response volume and reach. Open an agent for its source details.</p></div>
        <button type="button" className="secondary" disabled={!ready || exporting || Boolean(dateError)}
          onClick={() => void exportAgents()}>{exporting ? "Exporting..." : "Export agents CSV"}</button>
      </header>
      <div className="usage-agent-filters" aria-label="Agent usage filters">
        <label><span>Search agents</span><input type="search" maxLength={256} placeholder="Agent name or report ID"
          value={query.search ?? ""} onChange={event => onAgentQueryChange({ ...query, search: event.target.value || undefined })} /></label>
        <label><span>Creator type</span><select value={query.creatorType ?? ""} onChange={event => onAgentQueryChange({ ...query, creatorType: event.target.value || undefined })}>
          <option value="">All creator types</option>
          {data?.filters.creatorTypes.map(creator => <option key={creator}>{creator}</option>)}
        </select></label>
        <label><span>Order agents by</span><select value={`${query.sortBy ?? "responses"}-${query.sortDirection ?? "desc"}`} onChange={event => {
          const order = orders.find(option => option.id === event.target.value);
          if (order) onAgentQueryChange({ ...query, sortBy: order.sortBy, sortDirection: order.sortDirection });
        }}>{orders.map(order => <option key={order.id} value={order.id}>{order.label}</option>)}</select></label>
      </div>
      <div className="usage-agent-filter-options">
        <details className="usage-date-filters">
          <summary>Last-activity filters{query.startDate || query.endDate ? " (applied)" : ""}</summary>
          <div className="usage-agent-date-inputs">
            <label><span>Agent last activity on or after (UTC)</span><input type="date" value={query.startDate ?? ""} max={query.endDate}
              onChange={event => onAgentQueryChange({ ...query, startDate: event.target.value || undefined })} /></label>
            <label><span>Agent last activity on or before (UTC)</span><input type="date" value={query.endDate ?? ""} min={query.startDate}
              onChange={event => onAgentQueryChange({ ...query, endDate: event.target.value || undefined })} /></label>
          </div>
          <p>Dates select agents by their last reported activity. Responses remain full-snapshot totals, not responses within these dates. Undated agents are excluded only when a date filter is applied.</p>
        </details>
        {hasFilters ? <button type="button" className="secondary" onClick={() => onAgentQueryChange({})}>Reset agent filters</button> : null}
        {ready && data && !dateError ? <p className="usage-result-summary" role="status">{usagePageLabel(data.agents, "agents")}</p> : null}
      </div>
      {dateError ? <p className="error-banner" role="alert">{dateError}</p> : null}
      {exportError?.key === exportKey ? <p className="error-banner" role="alert">{exportError.message}</p> : null}
      {data?.activeSet && !error && !dateError ? pending
        ? <p role="status">Updating agent results...</p>
        : <>
          <AgentUsageTable tableRegion={tableRegion} agents={data.agents.value} count={data.agents.count}
            hasFilters={hasFilters} hasAgentEvidence={hasAgentEvidence} sorting={sorting}
            onSortingChange={next => {
              const selected = next[0];
              if (!selected || !sortableAgentColumns.has(selected.id as NonNullable<AgentFilters["sortBy"]>)) return;
              const sortBy = selected.id as NonNullable<AgentFilters["sortBy"]>;
              pendingSortFocus.current = sortBy;
              onAgentQueryChange({ ...query, sortBy, sortDirection: selected.desc ? "desc" : "asc" });
            }} />
          {data.agents.count > data.agents.limit || data.agents.offset > 0 ? <nav className="pagination-controls" aria-label="Agent usage pages">
            <button type="button" className="secondary" disabled={data.agents.offset === 0}
              onClick={() => onAgentPageChange(Math.max(0, data.agents.offset - data.agents.limit))}>Previous agents</button>
            <span>{usagePageLabel(data.agents, "agents")}</span>
            <button type="button" className="secondary" disabled={data.agents.offset + data.agents.limit >= data.agents.count}
              onClick={() => onAgentPageChange(data.agents.offset + data.agents.limit)}>Next agents</button>
          </nav> : null}
          {!data.agents.value.length && data.agents.offset > 0 ? <button type="button" className="secondary" onClick={() => onAgentPageChange(0)}>First agent page</button> : null}
        </> : null}
      {data && !data.activeSet && !error ? <div className="usage-empty-state">
        <h4>{usageAvailabilityLabel(data.availability)}</h4>
        <p>An administrator can import the Agents, Users &amp; agents, and Users CSVs together using Import reports. Accepted snapshots can be explored in Report history.</p>
        <p>Missing reports are not zero activity.</p>
      </div> : null}
    </section>
  </section>;
}

function Metric({ label, value, hint }: { label: string; value: number | null; hint: string }) {
  return <div className="metric"><span>{label}</span><strong>{usageCount(value)}</strong><small>{hint}</small></div>;
}

function AgentUsageTable({
  agents, count, hasFilters, hasAgentEvidence, sorting, onSortingChange, tableRegion,
}: {
  agents: Agent[];
  count: number;
  hasFilters: boolean;
  hasAgentEvidence: boolean;
  sorting: SortingState;
  onSortingChange: (sorting: SortingState) => void;
  tableRegion: RefObject<HTMLDivElement | null>;
}) {
  const [selected, setSelected] = useState<string>();
  const id = useId();
  const columns = useMemo<ListColumn<Agent>[]>(() => [
    { id: "agentName", header: "Agent", accessorFn: agent => agent.agentName || agent.agentId },
    { id: "creatorType", header: "Creator type", enableSorting: false },
    { id: "responses", header: "Responses", accessorFn: agent => agent.responsesSentToUsers, sortDescFirst: true },
    { id: "activeUsers", header: "Active users", accessorFn: agent => agent.activeUsersIdentityCount ?? undefined, sortDescFirst: true },
    { id: "lastActivity", header: "Last reported activity", accessorFn: agent => agent.lastActivityDateUtc, sortDescFirst: true },
  ], []);
  const table = useListTable({
    data: agents,
    columns,
    sorting,
    manualSorting: true,
    getRowId: agent => agent.agentId,
    onSortingChange: updater => onSortingChange(typeof updater === "function" ? updater(sorting) : updater),
  });
  if (!agents.length) return <div className="usage-empty-state">
    <h4>{!hasAgentEvidence ? "Agent usage evidence unavailable" : count ? "No agents on this page" : hasFilters ? "No agents match" : "No reported agents"}</h4>
    <p>{!hasAgentEvidence ? "The selected snapshot has no Agents or Users & agents evidence." : count || hasFilters ? "Change the search or filters, or return to the first page." : "The selected snapshot contains no agent rows."} Missing usage is not zero usage or a measure of total Copilot activity.</p>
  </div>;
  return <div ref={tableRegion} className="table-shell usage-agent-table" role="region" aria-label="Agent comparison rows" tabIndex={0}>
    <table>
      <ListTableHead table={table} titles={{ activeUsers: "Distinct positive-response identities per agent; not additive across agents" }} />
      <tbody>{table.getRowModel().rows.map((row, index) => {
        const agent = row.original;
        const expanded = selected === agent.agentId;
        const detailId = `${id}-${index}`;
        return <Fragment key={agent.agentId}>
          <tr>
            <th scope="row"><button type="button" className="usage-agent-name" aria-expanded={expanded} aria-controls={expanded ? detailId : undefined}
              onClick={() => setSelected(expanded ? undefined : agent.agentId)}>{agent.agentName || agent.agentId}</button>
              {agent.responseComparison.status === "mismatch" ? <small className="usage-inline-warning">Source totals differ</small> : null}
            </th>
            <td>{agent.creatorType || "Unknown"}</td>
            <td className="usage-number">{usageCount(agent.responsesSentToUsers)}{agent.sourceReport === "userAgents" ? <small>Users &amp; agents only</small> : null}</td>
            <td className="usage-number">{usageCount(agent.activeUsersIdentityCount)}</td>
            <td>{usageDate(agent.lastActivityDateUtc)}</td>
          </tr>
          {expanded ? <tr className="usage-agent-expanded"><td colSpan={5}>
            <section id={detailId} aria-label={`Source details for ${agent.agentName || agent.agentId}`}>
              <h4>Report identity and source evidence</h4>
              <p><strong>Report agent ID:</strong> <code>{agent.agentId}</code>. Report IDs are not automatically matched to inventory agents.</p>
              <dl className="usage-evidence-grid">
                <Evidence label="Responses by source" value={comparisonLabel(agent.responseComparison)} />
                <Evidence label="Licensed active users (Agents export)" value={usageCount(agent.activeUsersLicensed)} />
                <Evidence label="Unlicensed active users (Agents export)" value={usageCount(agent.activeUsersUnlicensed)} />
              </dl>
              <p>Licensed and unlicensed source categories can overlap and are never added. Active users above count distinct positive-response Users &amp; agents identities; without companion evidence the count is Unknown.</p>
              <p>Source reports: {agent.sourceReports.map(kindLabel).join(", ")}. Creator type comes from the {agent.creatorTypeSource === "agents_report" ? "Agents" : "Users & agents"} export.</p>
            </section>
          </td></tr> : null}
        </Fragment>;
      })}</tbody>
    </table>
  </div>;
}

function ReportSources({ data }: { data: OfficialUsageAggregateView }) {
  const usage = data.summary.usage;
  const mismatch = usage.responseReconciliation.status === "mismatch" || usage.activeUserReconciliation.status === "mismatch";
  return <details className="usage-report-details">
    <summary>Report quality &amp; sources{mismatch ? <span className="usage-quality-notice">Source totals differ</span> : null}
      {data.missingKinds.length ? <span className="usage-quality-notice">Missing {data.missingKinds.map(kindLabel).join(", ")}</span> : null}</summary>
    <p>{data.authority}. Source discrepancies are preserved, not combined or silently corrected.</p>
    <dl className="usage-evidence-grid">
      <Evidence label="Response totals" value={comparisonLabel(usage.responseReconciliation)} />
      <Evidence label="Active-user totals" value={comparisonLabel(usage.activeUserReconciliation)} />
      <Evidence label="Report age" value={`Period: ${data.periodAgeDays === null ? "unknown" : `${data.periodAgeDays} days`}; import: ${data.acceptedAgeDays === null ? "unknown" : `${data.acceptedAgeDays} days`}. Out of date after ${data.staleAfterDays} days.`} />
    </dl>
    <p>Headline responses use the Agents export only; agents found only in Users &amp; agents remain in the table with their source labeled. Tenant active users deduplicate positive-response identities from Users and Users &amp; agents, not license assignments. Per-agent active users are not additive across agents.</p>
    <p>Licensed active-user occurrences: {usageCount(usage.reportedLicensedActiveUserOccurrences)}. Unlicensed active-user occurrences: {usageCount(usage.reportedUnlicensedActiveUserOccurrences)}. {usage.activeUserOccurrenceNotice}</p>
    {data.activeSet?.reportingPeriod.provenance === "activity_range" ? <p>Observed last-activity ranges do not establish the reporting window or daily coverage.</p> : null}
    <p>Import time does not establish source freshness. Agent activity does not measure all Microsoft 365 Copilot usage and must not, by itself, determine license changes.</p>
    <div className="usage-source-files">{data.lineages.map(lineage => <details key={lineage.kind}>
      <summary>{kindLabel(lineage.kind)} export: {lineage.rowCount.toLocaleString()} rows{lineage.warnings.length ? `; ${lineage.warnings.length} warnings` : ""}</summary>
      <dl className="usage-evidence-grid">
        <Evidence label="Reporting range" value={`${lineage.reportingPeriod.startDate ?? "Unknown"} to ${lineage.reportingPeriod.endDate ?? "Unknown"} (${lineage.reportingPeriod.provenance})`} />
        <Evidence label="Source refresh" value={lineage.sourceAsOf ? usageDate(lineage.sourceAsOf) : "Not supplied"} />
        <Evidence label="Source freshness" value={lineage.sourceFreshness} />
        <Evidence label="Report version" value={lineage.versionId} />
        <Evidence label="File hash" value={lineage.fileHash} />
        <Evidence label="Schema / parser" value={`${lineage.schemaVersion} / ${lineage.parserVersion}`} />
        {lineage.supersedesVersionId ? <Evidence label="Corrects report version" value={lineage.supersedesVersionId} /> : null}
      </dl>
      {lineage.warnings.length ? <ul>{lineage.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul> : null}
    </details>)}</div>
    {usage.creatorTypeDistribution.length ? <details className="usage-creator-breakdown"><summary>Agent counts by creator type</summary>
      <ul>{usage.creatorTypeDistribution.map(item => <li key={item.name}>{item.name}: <strong>{item.value.toLocaleString()}</strong></li>)}</ul>
    </details> : null}
  </details>;
}

function Evidence({ label, value }: { label: string; value: string }) {
  return <div><dt>{label}</dt><dd>{value}</dd></div>;
}

function kindLabel(kind: string) {
  return kind === "agents" ? "Agents" : kind === "userAgents" ? "Users & agents" : kind === "users" ? "Users" : kind;
}

function comparisonLabel(comparison: Comparison) {
  const status = comparison.status === "matching" ? "Matching" : comparison.status === "mismatch" ? "Totals differ" : "Not comparable";
  return `${status}. ${Object.entries(comparison.sourceValues).map(([source, value]) => `${kindLabel(source)}: ${usageCount(value)}`).join("; ")}${comparison.difference === null ? "" : `. Difference: ${comparison.difference.toLocaleString()}`}`;
}

function filterKey(query: AgentFilters) {
  return JSON.stringify([query.search?.trim() || "", query.creatorType || "", query.startDate || "", query.endDate || "", query.sortBy ?? "responses", query.sortDirection ?? "desc"]);
}
