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

type ReportingViewProps = {
  activityWindowDays: number;
  data?: OfficialUsageAggregateView;
  inactiveDays: number;
  onActivityWindowDaysChange: (activityWindowDays: number) => void;
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
  userData,
}: ReportingViewProps) {
  if (!data) return <div className="screen-state">Loading official usage...</div>;
  const summary = data.summary;
  const hasCatalog = summary.catalog.totalAgents > 0;

  return (
    <section className="reporting-view" aria-label="Agent insights dashboard">
      <section className="official-usage-lineage" aria-label="Official usage lineage">
        <div><span>Authority</span><strong>{data.authority}</strong></div>
        <div><span>State</span><strong>{formatAvailability(data.availability)}</strong></div>
        <div><span>Source period</span><strong>{data.activeSet ? `${data.activeSet.reportingPeriod.startDate} to ${data.activeSet.reportingPeriod.endDate}` : "Unavailable"}</strong></div>
        <div><span>Coverage</span><strong>{data.missingKinds.length ? `Missing ${data.missingKinds.map(formatKind).join(", ")}` : "All three exports"}</strong></div>
        <div><span>Age / staleness</span><strong>{data.periodAgeDays === null ? "Unknown" : `Period ${data.periodAgeDays} day(s); import ${data.acceptedAgeDays} day(s); stale after either exceeds ${data.staleAfterDays}`}</strong></div>
        <div><span>Source freshness</span><strong>{data.lineages.length ? data.lineages.map(lineage => `${formatKind(lineage.kind)}: ${lineage.sourceFreshness}`).join("; ") : "Unknown"}</strong></div>
        <div><span>Versions</span><strong>{data.lineages.map(lineage => `${formatKind(lineage.kind)} ${lineage.fileHash.slice(0, 10)} / ${lineage.schemaVersion} / ${lineage.reportingPeriod.provenance}${lineage.sourceAsOf ? ` / ${lineage.sourceAsOf}` : " / source as-of absent"}${lineage.warnings.length ? ` / ${lineage.warnings.length} warning(s)` : ""}${lineage.supersedesVersionId ? " / superseding" : ""}`).join("; ") || "None"}</strong></div>
      </section>
      <section
        className="summary-grid report-summary-grid"
        aria-label="Report summary"
      >
        <Metric label="Catalog agents" value={summary.catalog.totalAgents} />
        <Metric label="Allowed" value={summary.catalog.allowedAgents} />
        <Metric label="Blocked" value={summary.catalog.blockedAgents} />
        <Metric
          label={`Inactive >${inactiveDays}d`}
          value={summary.catalog.inactiveAgents}
          muted={!summary.usage.hasAgentUsage}
        />
        <Metric
          label="Responses (Agents report)"
          value={summary.usage.totalResponses}
          muted={!summary.usage.hasAgentUsage}
        />
        <Metric
          label="Distinct users (dataset union)"
          value={summary.usage.totalActiveUsers}
          muted={!summary.usage.hasAgentUsage}
        />
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

      <section
        className="report-section"
        aria-labelledby="usage-reporting-title"
      >
        <div className="report-section-header">
          <div>
            <p className="eyebrow">Usage import</p>
            <h2 id="usage-reporting-title">Usage signals</h2>
          </div>
          <span>
            {summary.usage.hasAgentUsage ? "Imported" : "No usage import"}
          </span>
        </div>

        {summary.usage.hasAgentUsage ? (
          <>
            <div className="report-kpi-strip">
              <SmallStat label="Response total basis" value={summary.usage.totalResponsesBasis === "agents_report" ? "Agents report only" : "Unknown"} />
              <SmallStat label="Active-user basis" value={summary.usage.totalActiveUsersBasis === "users_and_users_agents_distinct_identity" ? "Distinct Users + Users & agents identities" : "Unknown"} />
              <SmallStat
                label="Response reconciliation"
                value={formatComparison(summary.usage.responseReconciliation)}
              />
              <SmallStat
                label="Active-user reconciliation"
                value={formatComparison(summary.usage.activeUserReconciliation)}
              />
              <SmallStat
                label="Agents without imported usage"
                value={summary.catalog.noImportedUsageAgents}
              />
              <SmallStat
                label="Last activity range"
                value={formatDateRange(summary.usage.lastActivityRange)}
              />
            </div>
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
            </div>
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
            {userData.users.count ? "Imported" : "No user import"}
          </span>
        </div>

        {userData.users.count ? (
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
            <TopUsersTable users={userData.topUsersByResponses} />
          </>
        ) : (
          <EmptyReportState message="Import and activate Agents, Users & agents, and Users for one compatible period to add user totals and comparisons." />
        )}
      </section> : null}

      {!hasCatalog ? (
        <div className="empty-state compact-empty-state">
          <h2>No catalog data loaded</h2>
          <p>Refresh the agent catalog to populate reporting charts.</p>
        </div>
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

function TopUsersTable({ users }: { users: OfficialUsageTopUser[] }) {
  return (
    <section className="report-table-card">
      <h3>Top users by responses</h3>
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
