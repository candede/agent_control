import { useMemo } from "react";
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
import type { CopilotPackage } from "../api/client";
import {
  buildReportingSummary,
  type ReportingTopAgent,
  type ReportingTopUser,
  type ReportingUsageReports,
  type ReportingValue,
} from "../reportingModels";

type ReportingViewProps = {
  activityWindowDays: number;
  agents: CopilotPackage[];
  inactiveDays: number;
  onActivityWindowDaysChange: (activityWindowDays: number) => void;
  reports: ReportingUsageReports;
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
  agents,
  inactiveDays,
  onActivityWindowDaysChange,
  reports,
}: ReportingViewProps) {
  const summary = useMemo(
    () =>
      buildReportingSummary({
        activityWindowDays,
        agents,
        inactiveDays,
        reports,
      }),
    [activityWindowDays, agents, inactiveDays, reports],
  );
  const hasCatalog = summary.catalog.totalAgents > 0;

  return (
    <section className="reporting-view" aria-label="Reporting dashboard">
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
          label="Responses"
          value={summary.usage.totalResponses}
          muted={!summary.usage.hasAgentUsage}
        />
        <Metric
          label="Active users"
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
              <SmallStat
                label="Licensed active users"
                value={summary.usage.licensedActiveUsers}
              />
              <SmallStat
                label="Unlicensed active users"
                value={summary.usage.unlicensedActiveUsers}
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
                title="Top agents by active users"
                agents={summary.usage.topAgentsByActiveUsers}
              />
            </div>
          </>
        ) : (
          <EmptyReportState message="Import the Agents or Users & agents CSV report to add response totals, active users, inactivity, creator types, and top-agent usage." />
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
          <EmptyReportState message="Import the Agents or Users & agents CSV report to analyze active agents within a selected activity window." />
        )}
      </section>

      <section
        className="report-section"
        aria-labelledby="user-reporting-title"
      >
        <div className="report-section-header">
          <div>
            <p className="eyebrow">User reports</p>
            <h2 id="user-reporting-title">User engagement</h2>
          </div>
          <span>
            {summary.usage.hasUserUsage ? "Imported" : "No user import"}
          </span>
        </div>

        {summary.usage.hasUserUsage ? (
          <>
            <div className="report-kpi-strip">
              <SmallStat
                label="Imported users"
                value={summary.users.importedUsers}
              />
              <SmallStat
                label="Users with access rows"
                value={summary.users.usersWithAccessRows}
              />
              <SmallStat
                label="Responses received"
                value={summary.users.totalResponsesReceived}
              />
              <SmallStat
                label="Report-only rows"
                value={summary.users.reportOnlyRows}
              />
              <SmallStat
                label="Report mismatches"
                value={summary.users.mismatchCount}
              />
            </div>
            <TopUsersTable users={summary.users.topUsersByResponses} />
          </>
        ) : (
          <EmptyReportState message="Import the Users and Users & agents CSV reports to add user totals, top users, report-only rows, and mismatch counts." />
        )}
      </section>

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
  value: number;
  muted?: boolean;
}) {
  return (
    <div className={muted ? "metric report-muted-metric" : "metric"}>
      <span>{label}</span>
      <strong>{value.toLocaleString()}</strong>
    </div>
  );
}

function SmallStat({
  label,
  value,
}: {
  label: string;
  value: number | string;
}) {
  return (
    <div className="report-small-stat">
      <span>{label}</span>
      <strong>
        {typeof value === "number" ? value.toLocaleString() : value}
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

function DonutChart({ data }: { data: ReportingValue[] }) {
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

function VerticalBarChart({ data }: { data: ReportingValue[] }) {
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
  agents: ReportingTopAgent[];
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
                <th>Active users</th>
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
                  <td>{agent.activeUsers.toLocaleString()}</td>
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

function TopUsersTable({ users }: { users: ReportingTopUser[] }) {
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
                <th>Last activity</th>
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
                  <td>{user.agentsUsed.toLocaleString()}</td>
                  <td>
                    {formatReportDate(user.latestActivityDateUtc) ?? "Unknown"}
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

function formatCountRatio(value: number, total: number) {
  return `${value.toLocaleString()} / ${total.toLocaleString()}`;
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
