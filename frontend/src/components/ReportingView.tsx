import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type {
  OfficialUsageAggregateView,
  OfficialUsageTopAgent,
  OfficialUsageTopUser,
  OfficialUsageUserView,
  OfficialUsageValue,
} from "../../../backend/src/types/officialUsage";
import { downloadOfficialUsageCsv } from "../api/client";
import { downloadBlob } from "../agentExport";
import { UserAccessView } from "./UserAccessView";
import "./officialUsage.css";

type ReportingViewProps = {
  activityWindowDays: number;
  data?: OfficialUsageAggregateView;
  inactiveDays: number;
  onActivityWindowDaysChange: (activityWindowDays: number) => void;
  onAgentPageChange?: (offset: number) => void;
  onAgentQueryChange?: (query: {
    search?: string;
    creatorType?: string;
    startDate?: string;
    endDate?: string;
    sortBy?: "agentName" | "responses" | "licensedUsers" | "unlicensedUsers" | "lastActivity";
    sortDirection?: "asc" | "desc";
  }) => void;
  onUserPageChange?: (offset: number) => void;
  onUserQueryChange?: Parameters<typeof UserAccessView>[0]["onQueryChange"];
  userData?: OfficialUsageUserView;
};

const chartColors = [
  "#2f645b",
  "#b85c48",
  "#d69c2f",
  "#597a9d",
  "#6b7f4a",
  "#8d6f46",
  "#4d8a8f",
  "#9d6b7d",
  "#b6a06d",
];

export function ReportingView({
  activityWindowDays,
  data,
  inactiveDays,
  onActivityWindowDaysChange,
  onAgentPageChange = () => undefined,
  onAgentQueryChange = () => undefined,
  onUserPageChange = () => undefined,
  onUserQueryChange = () => undefined,
  userData,
}: ReportingViewProps) {
  const [agentSearch, setAgentSearch] = useState("");
  const [agentCreatorType, setAgentCreatorType] = useState("all");
  const [agentStartDate, setAgentStartDate] = useState("");
  const [agentEndDate, setAgentEndDate] = useState("");
  const [agentSortBy, setAgentSortBy] = useState<"agentName" | "responses" | "licensedUsers" | "unlicensedUsers" | "lastActivity">("responses");
  const [agentSortDirection, setAgentSortDirection] = useState<"asc" | "desc">("desc");
  const [exporting, setExporting] = useState<"aggregate" | "users">();
  const [exportError, setExportError] = useState<string>();
  const exportController = useRef<AbortController | null>(null);
  const notifyAgentQueryChange = useEffectEvent(onAgentQueryChange);

  useEffect(() => () => exportController.current?.abort(), []);

  useEffect(() => {
    notifyAgentQueryChange({
      ...(agentSearch.trim() ? { search: agentSearch.trim() } : {}),
      ...(agentCreatorType !== "all" ? { creatorType: agentCreatorType } : {}),
      ...(agentStartDate ? { startDate: agentStartDate } : {}),
      ...(agentEndDate ? { endDate: agentEndDate } : {}),
      sortBy: agentSortBy,
      sortDirection: agentSortDirection,
    });
  }, [agentCreatorType, agentEndDate, agentSearch, agentSortBy, agentSortDirection, agentStartDate]);

  async function handleExport(kind: "aggregate" | "users", filters: object) {
    exportController.current?.abort();
    const controller = new AbortController();
    exportController.current = controller;
    setExportError(undefined);
    setExporting(kind);
    try {
      const setId = (kind === "aggregate" ? data : userData)?.activeSet?.id;
      if (!setId) throw new Error("Load an accepted report set before exporting official usage.");
      const blob = await exportUsage(kind, {
        ...filters,
        setId,
      }, controller.signal);
      if (!controller.signal.aborted) {
        downloadBlob(kind === "aggregate" ? "official-agent-usage.csv" : "official-user-usage.csv", blob);
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        setExportError(error instanceof Error ? error.message : "The official usage export failed.");
      }
    } finally {
      if (exportController.current === controller) {
        exportController.current = null;
        if (!controller.signal.aborted) setExporting(undefined);
      }
    }
  }

  if (!data) return <div className="screen-state">Loading official usage...</div>;
  const summary = data.summary;
  const hasCatalog = summary.catalog.totalAgents > 0;

  return (
    <section className="reporting-view" aria-label="Agent insights dashboard">
      {exportError ? <div className="error-banner" role="alert">{exportError}</div> : null}
      <div className="usage-report-context">
        <span>{hasObservedCoverage(data) ? "Observed activity" : "Source period"}: <strong>{formatCoverage(data.activeSet?.reportingPeriod)}</strong></span>
        <span className={`usage-state ${data.availability === "active" ? "" : "usage-state-attention"}`}>{formatAvailability(data.availability)}</span>
        {data.missingKinds.length ? <span>Missing {data.missingKinds.map(formatKind).join(", ")}</span> : null}
      </div>
      <details className="usage-report-details">
        <summary>Report details{summary.usage.responseReconciliation.status === "mismatch" || summary.usage.activeUserReconciliation.status === "mismatch" ? <span className="usage-quality-notice">Source totals differ</span> : null}</summary>
        <section className="official-usage-lineage" aria-label="Official usage lineage">
          <div><span>Authority</span><strong>{data.authority}</strong></div>
          <div><span>State</span><strong>{formatAvailability(data.availability)}</strong></div>
          <div><span>{hasObservedCoverage(data) ? "Observed activity range" : "Source period"}</span><strong>{formatCoverage(data.activeSet?.reportingPeriod)}</strong></div>
          <div><span>Coverage</span><strong>{data.missingKinds.length ? `Missing ${data.missingKinds.map(formatKind).join(", ")}` : "All three exports"}</strong></div>
          <div><span>Age / staleness</span><strong>{`Coverage ${data.periodAgeDays === null ? "unknown" : `${data.periodAgeDays} day(s)`}; import ${data.acceptedAgeDays === null ? "unknown" : `${data.acceptedAgeDays} day(s)`}; stale after either known age exceeds ${data.staleAfterDays}`}</strong></div>
          <div><span>Source freshness</span><strong>{data.lineages.length ? data.lineages.map(lineage => `${formatKind(lineage.kind)}: ${lineage.sourceFreshness}`).join("; ") : "Unknown"}</strong></div>
          <div><span>Versions</span><strong>{data.lineages.map(lineage => `${formatKind(lineage.kind)} ${lineage.fileHash.slice(0, 10)} / ${lineage.schemaVersion} / ${lineage.reportingPeriod.provenance}${lineage.sourceAsOf ? ` / ${lineage.sourceAsOf}` : " / source as-of absent"}${lineage.warnings.length ? ` / ${lineage.warnings.length} warning(s)` : ""}${lineage.supersedesVersionId ? " / superseding" : ""}`).join("; ") || "None"}</strong></div>
        </section>
        <div className="report-kpi-strip">
          <SmallStat label="Response total basis" value={summary.usage.totalResponsesBasis === "agents_report" ? "Agents report only" : "Unknown"} />
          <SmallStat label="Active-user basis" value={summary.usage.totalActiveUsersBasis === "users_and_users_agents_distinct_identity" ? "Distinct positive-response Users + Users & agents identities" : "Unknown"} />
          <SmallStat label="Response reconciliation" value={formatComparison(summary.usage.responseReconciliation)} />
          <SmallStat label="Active-user reconciliation" value={formatComparison(summary.usage.activeUserReconciliation)} />
          <SmallStat label="Catalog agents not identity-linked to usage" value={summary.catalog.noImportedUsageAgents} />
          <SmallStat label="Last activity range" value={formatDateRange(summary.usage.lastActivityRange)} />
          <SmallStat label="Licensed active-user occurrences" value={summary.usage.reportedLicensedActiveUserOccurrences} />
          <SmallStat label="Unlicensed active-user occurrences" value={summary.usage.reportedUnlicensedActiveUserOccurrences} />
        </div>
        <p className="usage-footnote">{summary.usage.activeUserOccurrenceNotice}</p>
        <div className="usage-decision-notice" role="note">
          <strong>Decision support, not a license ledger.</strong>
          <span>These CSVs do not identify individual license assignments, the tenant&apos;s total licensed population, all Microsoft 365 Copilot app activity, prompts, or sessions. Zero agent responses does not prove an unused license. Confirm assignment and full Copilot usage before reassignment; no changes are made here.</span>
        </div>
      </details>
      <section
        className="summary-grid usage-headline-grid"
        aria-label="Usage summary"
      >
        <Metric
          label="Responses (Agents report)"
          value={summary.usage.totalResponses}
          muted={!summary.usage.hasAgentUsage}
        />
        <Metric
          label="Active users (positive responses)"
          value={summary.usage.totalActiveUsers}
          muted={!summary.usage.hasAgentUsage}
        />
        <Metric label="Agents in report" value={summary.usage.hasAgentUsage ? summary.activityWindow.totalAgents : null} muted={!summary.usage.hasAgentUsage} />
      </section>
      <p className="usage-scope-note">Agent activity only, not a license ledger. Verify full Copilot usage before license changes.</p>

      <section
        className="report-section"
        aria-labelledby="usage-reporting-title"
      >
        <div className="report-section-header">
          <div>
            <h2 id="usage-reporting-title">Usage overview</h2>
          </div>
        </div>

        {summary.usage.hasAgentUsage ? (
          <>
            <div className="report-chart-grid report-chart-grid-two">
              <ChartPanel
                title="Creator types"
                subtitle="Usage rows by creator type"
              >
                <DonutChart data={summary.usage.creatorTypeDistribution} />
              </ChartPanel>
              <ChartPanel title="Top agents" subtitle="Responses sent to users">
                <VerticalBarChart
                  data={summary.usage.topAgentsByResponses.map((agent) => ({
                    name: agent.name,
                    value: agent.responses,
                  }))}
                />
              </ChartPanel>
            </div>
            <div className="report-table-grid">
              <TopAgentsTable
                title="Top agents by responses"
                agents={summary.usage.topAgentsByResponses}
              />
              <TopAgentsTable
                title="Top agents by distinct active users"
                agents={summary.usage.topAgentsByActiveUsers}
              />
              <TopAgentsTable title="Least responses (including zero)" agents={data.rankings.leastResponses} />
            </div>
            <section className="official-usage-explorer" aria-labelledby="all-agent-usage-title">
              <div className="report-section-header">
                <div><p className="eyebrow">Complete source rows</p><h3 id="all-agent-usage-title">All agent usage</h3></div>
                <button type="button" className="secondary" disabled={Boolean(exporting)} onClick={() => void handleExport("aggregate", data.filters)}>
                  {exporting === "aggregate" ? "Exporting..." : "Export filtered agents CSV"}
                </button>
              </div>
              <div className="usage-filter-grid" aria-label="Agent usage filters">
                <label><span>Search</span><input type="search" value={agentSearch} onChange={event => setAgentSearch(event.target.value)} placeholder="Agent name, ID, creator type" /></label>
                <label><span>Creator type</span><select value={agentCreatorType} onChange={event => setAgentCreatorType(event.target.value)}><option value="all">All creator types</option>{data.filters.creatorTypes.map(value => <option key={value}>{value}</option>)}</select></label>
                <label><span>Activity start (UTC)</span><input type="date" value={agentStartDate} max={agentEndDate || undefined} onChange={event => setAgentStartDate(event.target.value)} /></label>
                <label><span>Activity end (UTC)</span><input type="date" value={agentEndDate} min={agentStartDate || undefined} onChange={event => setAgentEndDate(event.target.value)} /></label>
                <label><span>Sort</span><select value={agentSortBy} onChange={event => setAgentSortBy(event.target.value as typeof agentSortBy)}><option value="responses">Responses</option><option value="agentName">Agent name</option><option value="licensedUsers">Licensed active users</option><option value="unlicensedUsers">Unlicensed active users</option><option value="lastActivity">Last activity</option></select></label>
                <label><span>Direction</span><select value={agentSortDirection} onChange={event => setAgentSortDirection(event.target.value as "asc" | "desc")}><option value="desc">Highest / newest first</option><option value="asc">Lowest / oldest first</option></select></label>
                <button type="button" className="secondary" disabled={!agentSearch && agentCreatorType === "all" && !agentStartDate && !agentEndDate && agentSortBy === "responses" && agentSortDirection === "desc"} onClick={() => { setAgentSearch(""); setAgentCreatorType("all"); setAgentStartDate(""); setAgentEndDate(""); setAgentSortBy("responses"); setAgentSortDirection("desc"); }}>Reset agent filters</button>
              </div>
              <p className="usage-footnote">Dates are aggregate last-activity filters. Response counts remain full-export totals for matching rows; they are not daily or recomputed interval totals. Rows without a date stay visible until a date filter is applied.</p>
              <AgentUsageTable data={data} />
              <UsagePagination page={data.agents} label="Agent usage pages" onPageChange={onAgentPageChange} />
            </section>
          </>
        ) : (
          <EmptyReportState message="Import and activate Agents, Users & agents, and Users for one compatible period to add official usage." />
        )}
      </section>

      <section
        className="report-section activity-window-section"
        aria-labelledby="activity-window-title"
      >
        <div className="report-section-header">
          <div>
            <p className="eyebrow">Activity window</p>
            <h2 id="activity-window-title">Active agents</h2>
          </div>
          <div className="report-header-actions">
            <label className="report-window-control">
              <span>Active in last</span>
              <input
                type="number"
                min="1"
                max="365"
                value={activityWindowDays}
                onChange={(event) =>
                  onActivityWindowDaysChange(
                    clampNumber(event.target.value, 1, 365, 30),
                  )
                }
              />
              <span>days</span>
            </label>
            <span className="report-import-status">
              {summary.activityWindow.anchorDateUtc
                ? `Through ${formatReportDate(summary.activityWindow.anchorDateUtc)}`
                : "No activity dates"}
            </span>
          </div>
        </div>

        {summary.usage.hasAgentUsage ? (
          <>
            <div className="report-kpi-strip activity-window-kpis">
              <SmallStat
                label="Active agents"
                value={formatCountRatio(
                  summary.activityWindow.activeAgents,
                  summary.activityWindow.totalAgents,
                )}
              />
              <SmallStat
                label="Active users on active agents"
                value={formatCountRatio(
                  summary.activityWindow.activeUsers,
                  summary.activityWindow.totalActiveUsers,
                )}
              />
              <SmallStat
                label="Responses from active agents"
                value={formatCountRatio(
                  summary.activityWindow.responses,
                  summary.activityWindow.totalResponses,
                )}
              />
              <SmallStat
                label="Window size"
                value={`${activityWindowDays.toLocaleString()} days`}
              />
            </div>
            <div className="report-chart-grid activity-window-grid">
              <ChartPanel
                title="Active coverage"
                subtitle={`${summary.activityWindow.activeAgents.toLocaleString()} of ${summary.activityWindow.totalAgents.toLocaleString()} agents`}
              >
                <DonutChart data={summary.activityWindow.agentDistribution} />
              </ChartPanel>
              <ChartPanel
                title="Active-user coverage"
                subtitle="Users on agents active in the window"
              >
                <DonutChart
                  data={summary.activityWindow.activeUserDistribution}
                />
              </ChartPanel>
              <ChartPanel
                title="Creator types"
                subtitle="Active-window agents by creator type"
              >
                <VerticalBarChart
                  data={summary.activityWindow.creatorTypeDistribution}
                />
              </ChartPanel>
              <ChartPanel
                title="Top active agents"
                subtitle="Responses from agents active in the window"
              >
                <VerticalBarChart
                  data={summary.activityWindow.topAgentsByResponses.map(
                    (agent) => ({
                      name: agent.name,
                      value: agent.responses,
                    }),
                  )}
                />
              </ChartPanel>
            </div>
          </>
        ) : (
          <EmptyReportState message="Import and activate Agents, Users & agents, and Users for one compatible period to analyze activity." />
        )}
      </section>

      {userData ? <section
        className="report-section"
        aria-labelledby="user-reporting-title"
      >
        <div className="report-section-header">
          <div>
            <p className="eyebrow">User reports</p>
            <h2 id="user-reporting-title">User engagement</h2>
          </div>
          <span>
            {userData.counts.users ? "Imported" : "No user import"}
          </span>
        </div>

        {userData.counts.users ? (
          <>
            <div className="report-kpi-strip">
              <SmallStat
                label="Imported users"
                value={userData.counts.userRows}
              />
              <SmallStat
                label="Users with access rows"
                value={userData.counts.users}
              />
              <SmallStat
                label="Responses received"
                value={userData.counts.totalResponsesReceived}
              />
              <SmallStat
                label="Report-only rows"
                value={userData.counts.reportOnlyRows}
              />
              <SmallStat
                label="Report mismatches"
                value={userData.counts.mismatchCount}
              />
            </div>
            <div className="report-table-grid">
              <TopUsersTable title="Most responses" users={userData.topUsersByResponses} />
              <TopUsersTable title="Least responses (including zero)" users={userData.leastUsersByResponses} />
            </div>
            <div className="report-kpi-strip">
              <SmallStat label="Zero-response review candidates" value={userData.cohorts.zeroResponses} />
              <SmallStat label={`1–${userData.cohorts.threshold} response review candidates`} value={userData.cohorts.lowResponses} />
              <SmallStat label="Users missing bridge rows" value={userData.cohorts.missingBridgeRows} />
              <SmallStat label="Unknown user metrics" value={userData.cohorts.unknownUserMetrics} />
            </div>
            <p className="usage-footnote">{userData.decisionNotice}</p>
            <div className="report-section-header"><h3>Every user and agent detail</h3>            <button type="button" className="secondary" disabled={Boolean(exporting)} onClick={() => void handleExport("users", userData.filters)}>{exporting === "users" ? "Exporting..." : "Export filtered user details CSV"}</button></div>
            <UserAccessView data={userData} onPageChange={onUserPageChange} onQueryChange={onUserQueryChange} compact />
          </>
        ) : (
          <EmptyReportState message="Import and activate Agents, Users & agents, and Users for one compatible period to add user totals and comparisons." />
        )}
      </section> : null}

      {hasCatalog ? (
        <details className="catalog-analysis">
          <summary>
            <span>Catalog-only analysis</span>
            <small>Allowed/blocked state, availability, hosts, publishers, platforms, and package types</small>
          </summary>
          <section className="summary-grid report-summary-grid" aria-label="Catalog summary">
            <Metric label="Catalog agents" value={summary.catalog.totalAgents} />
            <Metric label="Allowed" value={summary.catalog.allowedAgents} />
            <Metric label="Blocked" value={summary.catalog.blockedAgents} />
            <Metric label={`No activity >${inactiveDays}d`} value={summary.catalog.inactiveAgents} muted={!summary.usage.hasAgentUsage} />
          </section>
          <div className="report-chart-grid">
            <ChartPanel title="Agent status" subtitle="Catalog blocking state">
              <DonutChart data={summary.catalog.statusDistribution} />
            </ChartPanel>
            <ChartPanel title="Available to" subtitle="Catalog audience scope">
              <DonutChart data={summary.catalog.availabilityDistribution} />
            </ChartPanel>
            <ChartPanel title="Supported hosts" subtitle="Host coverage by package">
              <VerticalBarChart data={summary.catalog.hostDistribution} />
            </ChartPanel>
            <ChartPanel title="Publishers" subtitle="Top catalog publishers">
              <VerticalBarChart data={summary.catalog.publisherDistribution} />
            </ChartPanel>
            <ChartPanel title="Built with" subtitle="Detected package platform">
              <VerticalBarChart data={summary.catalog.platformDistribution} />
            </ChartPanel>
            <ChartPanel title="Package types" subtitle="Catalog type metadata">
              <VerticalBarChart data={summary.catalog.typeDistribution} />
            </ChartPanel>
          </div>
        </details>
      ) : null}
    </section>
  );
}

function Metric({
  label,
  value,
  muted,
}: {
  label: string;
  value: number | null;
  muted?: boolean;
}) {
  return (
    <div className={muted ? "metric report-muted-metric" : "metric"}>
      <span>{label}</span>
      <strong>{value === null ? "Unknown" : value.toLocaleString()}</strong>
    </div>
  );
}

function SmallStat({
  label,
  value,
}: {
  label: string;
  value: number | string | null;
}) {
  return (
    <div className="report-small-stat">
      <span>{label}</span>
      <strong>
        {value === null ? "Unknown" : typeof value === "number" ? value.toLocaleString() : value}
      </strong>
    </div>
  );
}

function ChartPanel({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <section className="report-chart-panel">
      <div className="report-chart-header">
        <h3>{title}</h3>
        <span>{subtitle}</span>
      </div>
      <div className="report-chart-body">{children}</div>
    </section>
  );
}

function DonutChart({ data }: { data: OfficialUsageValue[] }) {
  if (!data.length) {
    return (
      <EmptyReportState message="No values returned for this breakdown." />
    );
  }

  return (
    <ResponsiveContainer width="100%" height="100%">
      <PieChart>
        <Pie
          data={data}
          dataKey="value"
          nameKey="name"
          innerRadius="54%"
          outerRadius="80%"
          paddingAngle={2}
          stroke="#fffdf7"
          strokeWidth={2}
        >
          {data.map((entry, index) => (
            <Cell
              key={entry.name}
              fill={chartColors[index % chartColors.length]}
            />
          ))}
        </Pie>
        <Tooltip formatter={(value) => formatTooltipValue(value)} />
        <Legend />
      </PieChart>
    </ResponsiveContainer>
  );
}

function VerticalBarChart({ data }: { data: OfficialUsageValue[] }) {
  if (!data.length) {
    return (
      <EmptyReportState message="No values returned for this breakdown." />
    );
  }

  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={data} margin={{ top: 8, right: 12, bottom: 44, left: 4 }}>
        <CartesianGrid strokeDasharray="3 3" vertical={false} />
        <XAxis
          dataKey="name"
          interval={0}
          angle={-28}
          textAnchor="end"
          height={72}
          tick={{ fontSize: 11 }}
        />
        <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
        <Tooltip formatter={(value) => formatTooltipValue(value)} />
        <Bar dataKey="value" radius={[5, 5, 0, 0]}>
          {data.map((entry, index) => (
            <Cell
              key={entry.name}
              fill={chartColors[index % chartColors.length]}
            />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

function TopAgentsTable({
  title,
  agents,
}: {
  title: string;
  agents: OfficialUsageTopAgent[];
}) {
  return (
    <section className="report-table-card">
      <h3>{title}</h3>
      {agents.length ? (
        <div className="table-shell report-table-shell">
          <table>
            <thead>
              <tr>
                <th>Agent</th>
                <th>Status</th>
                <th>Responses</th>
                <th>Distinct active users</th>
                <th>Last activity</th>
              </tr>
            </thead>
            <tbody>
              {agents.map((agent) => (
                <tr key={`${title}-${agent.id}`}>
                  <td>
                    <strong>{agent.name}</strong>
                    <small>{agent.publisher || agent.id}</small>
                  </td>
                  <td>{agent.status}</td>
                  <td>{agent.responses.toLocaleString()}</td>
                  <td>{agent.activeUsers === null ? "Unknown" : agent.activeUsers.toLocaleString()}</td>
                  <td>
                    {formatReportDate(agent.lastActivityDateUtc) ?? "Unknown"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyReportState message="No ranked agents are available for this metric." />
      )}
    </section>
  );
}

function TopUsersTable({ title, users }: { title: string; users: OfficialUsageTopUser[] }) {
  return (
    <section className="report-table-card">
      <h3>{title}</h3>
      {users.length ? (
        <div className="table-shell report-table-shell">
          <table>
            <thead>
              <tr>
                <th>User</th>
                <th>Responses</th>
                <th>Agents used</th>
                <th>User last activity (Users report)</th>
              </tr>
            </thead>
            <tbody>
              {users.map((user) => (
                <tr key={user.username}>
                  <td>
                    <strong>{user.displayName}</strong>
                    <small>{user.username}</small>
                  </td>
                  <td>{user.responses.toLocaleString()}</td>
                  <td>{user.agentsUsed.toLocaleString()}<small>Users report</small></td>
                  <td>
                    {formatReportDate(user.userLastActivityDateUtc) ?? "Unknown"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyReportState message="No user response rows are available yet." />
      )}
    </section>
  );
}

function AgentUsageTable({ data }: { data: OfficialUsageAggregateView }) {
  if (!data.agents.value.length) return <EmptyReportState message="No agents match these filters. Reset the filters to return to the entire imported dataset." />;
  return (
    <div className="table-shell usage-full-table" role="region" aria-label="All agent usage rows" tabIndex={0}>
      <table>
        <thead><tr><th>Agent</th><th>Creator type</th><th>Licensed active users</th><th>Unlicensed active users</th><th>Distinct bridge identities</th><th>Responses</th><th>Last activity</th><th>Sources / reconciliation</th></tr></thead>
        <tbody>{data.agents.value.map(agent => <tr key={agent.agentId}>
          <td><strong>{agent.agentName || agent.agentId}</strong><small>{agent.agentId}</small></td>
          <td>{agent.creatorType || "Unknown"}</td>
          <td>{formatNullable(agent.activeUsersLicensed)}</td>
          <td>{formatNullable(agent.activeUsersUnlicensed)}</td>
          <td>{formatNullable(agent.activeUsersIdentityCount)}</td>
          <td>{agent.responsesSentToUsers.toLocaleString()}</td>
          <td>{formatReportDate(agent.lastActivityDateUtc) ?? "Unknown"}</td>
          <td>{agent.sourceReports.join(" + ")}<small>{formatComparison(agent.responseComparison)}</small></td>
        </tr>)}</tbody>
      </table>
    </div>
  );
}

function UsagePagination({ page, label, onPageChange }: {
  page: { count: number; limit: number; offset: number; value: unknown[] };
  label: string;
  onPageChange: (offset: number) => void;
}) {
  if (page.count <= page.limit) return null;
  return <div className="pagination-controls" aria-label={label}>
    <button type="button" className="secondary" disabled={page.offset === 0} onClick={() => onPageChange(Math.max(0, page.offset - page.limit))}>Previous</button>
    <span>{page.offset + 1}-{Math.min(page.offset + page.value.length, page.count)} of {page.count}</span>
    <button type="button" className="secondary" disabled={page.offset + page.limit >= page.count} onClick={() => onPageChange(page.offset + page.limit)}>Next</button>
  </div>;
}

function exportUsage(
  kind: "aggregate" | "users",
  filters: object,
  signal: AbortSignal,
) {
  const query: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(filters)) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") query[key] = value;
  }
  return downloadOfficialUsageCsv(kind, query, signal);
}

function formatNullable(value: number | null) {
  return value === null ? "Unknown" : value.toLocaleString();
}

function EmptyReportState({ message }: { message: string }) {
  return (
    <div className="empty-state compact-empty-state report-empty-state">
      <p>{message}</p>
    </div>
  );
}

function formatReportDate(value?: string) {
  if (!value) {
    return undefined;
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeZone: "UTC",
  }).format(new Date(value));
}

function formatTooltipValue(value: unknown) {
  return typeof value === "number"
    ? value.toLocaleString()
    : String(value ?? "");
}

function formatDateRange(range?: { earliest: string; latest: string }) {
  if (!range) {
    return "Unknown";
  }

  const earliest = formatReportDate(range.earliest);
  const latest = formatReportDate(range.latest);

  return earliest === latest
    ? (earliest ?? "Unknown")
    : `${earliest} to ${latest}`;
}

function hasObservedCoverage(data: OfficialUsageAggregateView) {
  return data.activeSet?.reportingPeriod.provenance === "activity_range";
}

function formatCoverage(period?: { startDate: string | null; endDate: string | null }) {
  if (!period?.startDate && !period?.endDate) return "Unknown; the source export period is not provided";
  if (period.startDate && period.endDate) return `${period.startDate} to ${period.endDate}`;
  return period.startDate ? `From ${period.startDate}` : `Through ${period.endDate}`;
}

function formatCountRatio(value: number | null, total: number | null) {
  return value === null || total === null ? "Unknown" : `${value.toLocaleString()} / ${total.toLocaleString()}`;
}

function formatAvailability(value: OfficialUsageAggregateView["availability"]) {
  return value.split("_").map(part => part[0].toUpperCase() + part.slice(1)).join(" ");
}

function formatKind(value: OfficialUsageAggregateView["missingKinds"][number]) {
  return value === "agents" ? "Agents" : value === "userAgents" ? "Users & agents" : "Users";
}

function formatComparison(value: OfficialUsageAggregateView["summary"]["usage"]["responseReconciliation"]) {
  const sources = Object.entries(value.sourceValues).map(([source, count]) => `${source}: ${count === null ? "unavailable" : count.toLocaleString()}`).join("; ");
  return `${value.status.replace("_", " ")}${value.difference === null ? "" : ` (range ${value.difference.toLocaleString()})`}; ${sources}`;
}

function clampNumber(
  value: string,
  min: number,
  max: number,
  fallback: number,
) {
  const parsed = Number(value);

  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, Math.round(parsed)));
}
import { useEffect, useEffectEvent, useRef, useState } from "react";
