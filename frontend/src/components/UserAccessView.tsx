import { useDeferredValue, useMemo, useState } from "react";
import type { CopilotPackage } from "../api/client";
import {
  buildUserAccessSummaries,
  type UserAccessReports,
  type UserAccessSummary,
} from "../usageModels";

type UserAccessViewProps = {
  agents: CopilotPackage[];
  inactiveDays: number;
  reports: UserAccessReports;
};

type ActivityFilter = "all" | "recent" | "inactive" | "no-activity";
type AccessRowFilter = "all" | "responses";

export function UserAccessView({
  agents,
  inactiveDays,
  reports,
}: UserAccessViewProps) {
  const [query, setQuery] = useState("");
  const [creatorTypeFilter, setCreatorTypeFilter] = useState("all");
  const [activityFilter, setActivityFilter] = useState<ActivityFilter>("all");
  const [accessRowFilter, setAccessRowFilter] =
    useState<AccessRowFilter>("all");
  const [selectedUsername, setSelectedUsername] = useState<string>();
  const deferredQuery = useDeferredValue(query);

  const summaries = useMemo(
    () => buildUserAccessSummaries(reports, agents),
    [agents, reports],
  );

  const creatorTypeOptions = useMemo(() => {
    const creatorTypes = new Set<string>();

    for (const summary of summaries) {
      for (const creatorType of summary.creatorTypes) {
        creatorTypes.add(creatorType);
      }
    }

    return [...creatorTypes].sort((first, second) =>
      first.localeCompare(second),
    );
  }, [summaries]);

  const filteredUsers = useMemo(() => {
    const normalizedQuery = deferredQuery.trim().toLowerCase();

    return summaries.filter((summary) => {
      const filteredRows = getFilteredAccessRows(summary, accessRowFilter);
      const matchesQuery =
        !normalizedQuery || summary.searchableText.includes(normalizedQuery);
      const matchesCreatorType =
        creatorTypeFilter === "all" ||
        summary.rows.some((row) => row.creatorType === creatorTypeFilter);
      const matchesAccessRows =
        accessRowFilter === "all" || filteredRows.length > 0;
      const matchesActivity = matchesActivityFilter(
        summary,
        activityFilter,
        inactiveDays,
      );

      return (
        matchesQuery &&
        matchesCreatorType &&
        matchesAccessRows &&
        matchesActivity
      );
    });
  }, [
    accessRowFilter,
    activityFilter,
    creatorTypeFilter,
    deferredQuery,
    inactiveDays,
    summaries,
  ]);

  const selectedUser =
    filteredUsers.find((summary) => summary.username === selectedUsername) ??
    filteredUsers[0];
  const selectedRows = selectedUser
    ? getFilteredAccessRows(selectedUser, accessRowFilter)
    : [];
  const importedUserCount = reports.users?.rows.length ?? 0;
  const bridgeRowCount = reports.userAgents?.rows.length ?? 0;
  const reportOnlyRowCount = summaries.reduce(
    (total, summary) =>
      total +
      summary.rows.filter((row) => row.packageStatus === "report-only").length,
    0,
  );
  const hasActiveUserFilters =
    query.trim().length > 0 ||
    creatorTypeFilter !== "all" ||
    activityFilter !== "all" ||
    accessRowFilter !== "all";

  function handleClearUserFilters() {
    setQuery("");
    setCreatorTypeFilter("all");
    setActivityFilter("all");
    setAccessRowFilter("all");
  }

  if (!reports.users && !reports.userAgents) {
    return (
      <div className="empty-state user-report-empty-state">
        <h2>No user usage reports imported</h2>
        <p>
          Import the <strong className="report-name">Agents</strong>,{" "}
          <strong className="report-name">Users</strong>, and{" "}
          <strong className="report-name">Users & agents</strong> CSV reports to
          use User view.
        </p>
        <div
          className="admin-download-guide"
          aria-label="Where to download user usage reports"
        >
          <strong>Download the CSVs from Microsoft 365 admin center</strong>
          <ol>
            <li>
              Open{" "}
              <a
                href="https://admin.microsoft.com/"
                target="_blank"
                rel="noopener noreferrer"
              >
                Microsoft 365 admin center
              </a>{" "}
              with an account that can view usage reports.
            </li>
            <li>
              Go to Reports &gt; Usage &gt; Microsoft 365 Copilot &gt; Agent
              usage.
            </li>
            <li>
              Export the <strong className="report-name">Agents</strong>,{" "}
              <strong className="report-name">Users</strong>, and{" "}
              <strong className="report-name">Users & agents</strong> reports as
              CSV, then import all three files here.
            </li>
          </ol>
        </div>
      </div>
    );
  }

  return (
    <section className="user-access-view" aria-label="User agent access">
      <div className="summary-grid user-summary-grid" aria-label="User summary">
        <Metric label="Users" value={summaries.length} />
        <Metric label="User rows" value={importedUserCount} />
        <Metric label="Access rows" value={bridgeRowCount} />
        <Metric label="Report-only rows" value={reportOnlyRowCount} />
      </div>

      <section className="controls user-controls" aria-label="User filters">
        <label className="filter-search">
          <span>Search</span>
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="User, agent, ID"
          />
        </label>
        <label>
          <span>Creator type</span>
          <select
            className={
              creatorTypeFilter === "all" ? undefined : "active-filter-select"
            }
            value={creatorTypeFilter}
            onChange={(event) => setCreatorTypeFilter(event.target.value)}
          >
            <option value="all">All creator types</option>
            {creatorTypeOptions.map((creatorType) => (
              <option key={creatorType} value={creatorType}>
                {creatorType}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Activity</span>
          <select
            className={
              activityFilter === "all" ? undefined : "active-filter-select"
            }
            value={activityFilter}
            onChange={(event) =>
              setActivityFilter(event.target.value as ActivityFilter)
            }
          >
            <option value="all">All activity</option>
            <option value="recent">Active within threshold</option>
            <option value="inactive">Inactive beyond threshold</option>
            <option value="no-activity">No activity date</option>
          </select>
        </label>
        <label>
          <span>Access rows</span>
          <select
            className={
              accessRowFilter === "all" ? undefined : "active-filter-select"
            }
            value={accessRowFilter}
            onChange={(event) =>
              setAccessRowFilter(event.target.value as AccessRowFilter)
            }
          >
            <option value="all">All accessed agents</option>
            <option value="responses">Responses only</option>
          </select>
        </label>
        <div className="filter-actions" aria-label="User filter actions">
          <button
            type="button"
            className="secondary clear-filters-button"
            disabled={!hasActiveUserFilters}
            onClick={handleClearUserFilters}
          >
            Clear filters
          </button>
        </div>
      </section>

      {filteredUsers.length === 0 ? (
        <div className="empty-state">
          <h2>No matching users</h2>
          <p>Try clearing the search or filters.</p>
        </div>
      ) : (
        <div className="user-access-layout">
          <UserSummaryTable
            users={filteredUsers}
            selectedUsername={selectedUser?.username}
            onSelectUser={setSelectedUsername}
          />
          {selectedUser ? (
            <UserAgentDetail
              rows={selectedRows}
              user={selectedUser}
              accessRowFilter={accessRowFilter}
            />
          ) : null}
        </div>
      )}
    </section>
  );
}

function UserSummaryTable({
  users,
  selectedUsername,
  onSelectUser,
}: {
  users: UserAccessSummary[];
  selectedUsername?: string;
  onSelectUser: (username: string) => void;
}) {
  return (
    <div
      className="table-shell user-table-shell"
      role="region"
      aria-label="Users"
    >
      <div className="selection-summary">
        <span>{users.length.toLocaleString()} users</span>
      </div>
      <table className="user-summary-table">
        <thead>
          <tr>
            <th scope="col">User</th>
            <th scope="col">Agents accessed</th>
            <th scope="col">Agents with responses</th>
            <th scope="col">Responses</th>
            <th scope="col">Last activity</th>
            <th scope="col">Action</th>
          </tr>
        </thead>
        <tbody>
          {users.map((user) => {
            const selected = user.username === selectedUsername;

            return (
              <tr
                key={user.username}
                className={selected ? "selected-row" : undefined}
              >
                <td>
                  <div className="agent-name">{user.displayName}</div>
                  <div className="agent-description">{user.username}</div>
                </td>
                <td>{user.agentsAccessedTotal.toLocaleString()}</td>
                <td>
                  <div className="user-count-stack">
                    <strong>
                      {user.responseProducingAgentCount.toLocaleString()}
                    </strong>
                    <small>
                      reported {user.reportedAgentsUsed.toLocaleString()}
                    </small>
                  </div>
                </td>
                <td>
                  <div className="user-count-stack">
                    <strong>
                      {user.bridgeResponsesSentToUsers.toLocaleString()}
                    </strong>
                    <small>
                      reported {user.reportedResponsesReceived.toLocaleString()}
                    </small>
                  </div>
                </td>
                <td>{formatReportDate(user.latestActivityDateUtc)}</td>
                <td>
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => onSelectUser(user.username)}
                  >
                    View agents
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function UserAgentDetail({
  accessRowFilter,
  rows,
  user,
}: {
  accessRowFilter: AccessRowFilter;
  rows: ReturnType<typeof getFilteredAccessRows>;
  user: UserAccessSummary;
}) {
  const emptyTitle =
    accessRowFilter === "responses"
      ? "No response-producing agents"
      : "No agent access rows";
  const emptyMessage =
    accessRowFilter === "responses"
      ? "Switch Access rows back to all accessed agents to see 0-response history."
      : "Import the Users & agents CSV report to show this user's agent access history.";

  return (
    <section
      className="user-detail-panel"
      aria-label={`${user.displayName} agents`}
    >
      <div className="user-detail-header">
        <div>
          <p className="eyebrow">Selected user</p>
          <h2>{user.displayName}</h2>
          <p>{user.username}</p>
        </div>
        <div className="user-detail-stats" aria-label="Selected user summary">
          <SummaryStat label="Access rows" value={rows.length} />
          <SummaryStat
            label="Responses"
            value={rows.reduce(
              (total, row) => total + row.responsesSentToUsers,
              0,
            )}
          />
          <SummaryStat
            label="Last activity"
            value={formatReportDate(user.latestActivityDateUtc)}
          />
        </div>
      </div>

      {rows.length === 0 ? (
        <div className="empty-state compact-empty-state">
          <h2>{emptyTitle}</h2>
          <p>{emptyMessage}</p>
        </div>
      ) : (
        <div
          className="table-shell nested-table-shell"
          role="region"
          aria-label="User accessed agents"
        >
          <div className="selection-summary">
            <span>
              {rows.length.toLocaleString()}{" "}
              {accessRowFilter === "responses" ? "response" : "access"} rows
            </span>
          </div>
          <table className="user-agent-table">
            <thead>
              <tr>
                <th scope="col">Agent</th>
                <th scope="col">Creator type</th>
                <th scope="col">Usage</th>
                <th scope="col">Publisher</th>
                <th scope="col">Built with</th>
                <th scope="col">Available to</th>
                <th scope="col">Package status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={`${row.username}-${row.agentId}`}>
                  <td>
                    <div className="agent-name">{row.displayAgentName}</div>
                    <div
                      className="agent-description agent-id"
                      title={row.agentId}
                    >
                      {row.agentId}
                    </div>
                  </td>
                  <td>{row.creatorType || "Unknown"}</td>
                  <td>
                    <dl className="usage-cell">
                      <div>
                        <dt>Last</dt>
                        <dd>{formatReportDate(row.lastActivityDateUtc)}</dd>
                      </div>
                      <div>
                        <dt>Resp</dt>
                        <dd>{row.responsesSentToUsers.toLocaleString()}</dd>
                      </div>
                    </dl>
                  </td>
                  <td>{row.publisher || "Report only"}</td>
                  <td>{row.builtWith || "Unknown"}</td>
                  <td>{formatDetailLabel(row.availableTo)}</td>
                  <td>
                    <span
                      className={`status ${statusClassName(row.packageStatus)}`}
                    >
                      {formatPackageStatus(row.packageStatus)}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value.toLocaleString()}</strong>
    </div>
  );
}

function SummaryStat({
  label,
  value,
}: {
  label: string;
  value: number | string;
}) {
  return (
    <div className="summary-stat usage">
      <span>{label}</span>
      <strong>
        {typeof value === "number" ? value.toLocaleString() : value}
      </strong>
    </div>
  );
}

function getFilteredAccessRows(
  user: UserAccessSummary,
  accessRowFilter: AccessRowFilter,
) {
  if (accessRowFilter === "responses") {
    return user.rows.filter((row) => row.hasResponses);
  }

  return user.rows;
}

function matchesActivityFilter(
  user: UserAccessSummary,
  filter: ActivityFilter,
  inactiveDays: number,
) {
  if (filter === "all") {
    return true;
  }

  if (!user.latestActivityDateUtc) {
    return filter === "no-activity";
  }

  const inactive = isInactiveDate(user.latestActivityDateUtc, inactiveDays);

  return filter === "inactive" ? inactive : !inactive;
}

function isInactiveDate(value: string, inactiveDays: number) {
  const today = startOfUtcDay(new Date());
  const activityDate = startOfUtcDay(new Date(value));
  const elapsedDays = Math.floor(
    (today.getTime() - activityDate.getTime()) / 86_400_000,
  );

  return elapsedDays > inactiveDays;
}

function startOfUtcDay(date: Date) {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
}

function formatReportDate(value?: string) {
  if (!value) {
    return "Unknown";
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeZone: "UTC",
  }).format(new Date(value));
}

function formatDetailLabel(value?: string) {
  if (!value) {
    return "Unknown";
  }

  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim();
}

function statusClassName(status: UserAgentAccessRowStatus) {
  if (status === "blocked") {
    return "blocked";
  }

  if (status === "report-only") {
    return "report-only";
  }

  return "allowed";
}

function formatPackageStatus(status: UserAgentAccessRowStatus) {
  if (status === "blocked") {
    return "Blocked";
  }

  if (status === "report-only") {
    return "Report only";
  }

  return "Allowed";
}

type UserAgentAccessRowStatus = "allowed" | "blocked" | "report-only";
