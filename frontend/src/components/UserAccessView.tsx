import { useDeferredValue, useEffect, useEffectEvent, useState } from "react";
import type { OfficialUsageUserSummary, OfficialUsageUserView } from "../api/client";

type UserAccessViewProps = {
  data?: OfficialUsageUserView;
  onPageChange: (offset: number) => void;
  onQueryChange: (query: {
    search?: string;
    creatorType?: string;
    activity?: ActivityFilter;
    responsesOnly?: boolean;
  }) => void;
};

type ActivityFilter = "all" | "recent" | "inactive" | "no-activity";
type AccessRowFilter = "all" | "responses";
const emptyUserSummaries: OfficialUsageUserSummary[] = [];

export function UserAccessView({
  data,
  onPageChange,
  onQueryChange,
}: UserAccessViewProps) {
  const [query, setQuery] = useState("");
  const [creatorTypeFilter, setCreatorTypeFilter] = useState("all");
  const [activityFilter, setActivityFilter] = useState<ActivityFilter>("all");
  const [accessRowFilter, setAccessRowFilter] =
    useState<AccessRowFilter>("all");
  const [selectedUsername, setSelectedUsername] = useState<string>();
  const deferredQuery = useDeferredValue(query);
  const notifyQueryChange = useEffectEvent(onQueryChange);

  const summaries = data?.users.value ?? emptyUserSummaries;
  const creatorTypeOptions = data?.filters.creatorTypes ?? [];
  const filteredUsers = summaries;

  useEffect(() => {
    notifyQueryChange({
      ...(deferredQuery.trim() ? { search: deferredQuery.trim() } : {}),
      ...(creatorTypeFilter !== "all" ? { creatorType: creatorTypeFilter } : {}),
      ...(activityFilter !== "all" ? { activity: activityFilter } : {}),
      ...(accessRowFilter === "responses" ? { responsesOnly: true } : {}),
    });
  }, [accessRowFilter, activityFilter, creatorTypeFilter, deferredQuery]);

  const selectedUser =
    filteredUsers.find((summary) => summary.username === selectedUsername) ??
    filteredUsers[0];
  const selectedRows = selectedUser
    ? getFilteredAccessRows(selectedUser, accessRowFilter)
    : [];
  const importedUserCount = data?.counts.userRows ?? 0;
  const bridgeRowCount = data?.counts.accessRows ?? 0;
  const reportOnlyRowCount = data?.counts.reportOnlyRows ?? 0;
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

  if (!data) return <div className="screen-state">Loading official user usage...</div>;

  if (!data.users.count) {
    return (
      <section className="user-access-view" aria-label="User agent access">
        <UserUsageLineage data={data} />
        <div className="empty-state user-report-empty-state">
          <h2>No published user usage rows</h2>
          <p>
            Official usage is {formatAvailability(data.availability)}. Import
            and activate a compatible three-file set to use User view.
          </p>
          <div
            className="admin-download-guide"
            aria-label="Required user usage reports"
          >
            <strong>Import Microsoft Copilot Agents usage CSVs</strong>
            <ol>
              <li>
                Obtain the reports through your organization&apos;s approved
                reporting and export workflow.
              </li>
              <li>
                Provide the <strong className="report-name">Agents</strong>,{" "}
                <strong className="report-name">Users</strong>, and{" "}
                <strong className="report-name">Users & agents</strong> reports as
                CSV, then import all three files here.
              </li>
            </ol>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="user-access-view" aria-label="User agent access">
      <UserUsageLineage data={data} />
      <div className="summary-grid user-summary-grid" aria-label="User summary">
        <Metric label="Users" value={data.users.count} />
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
      {data.users.count > data.users.limit ? (
        <div className="pagination-controls" aria-label="User usage pages">
          <button type="button" className="secondary" disabled={data.users.offset === 0} onClick={() => onPageChange(Math.max(0, data.users.offset - data.users.limit))}>Previous</button>
          <span>{data.users.offset + 1}-{Math.min(data.users.offset + data.users.value.length, data.users.count)} of {data.users.count}</span>
          <button type="button" className="secondary" disabled={data.users.offset + data.users.limit >= data.users.count} onClick={() => onPageChange(data.users.offset + data.users.limit)}>Next</button>
        </div>
      ) : null}
    </section>
  );
}

function UserSummaryTable({
  users,
  selectedUsername,
  onSelectUser,
}: {
  users: OfficialUsageUserSummary[];
  selectedUsername?: string;
  onSelectUser: (username: string) => void;
}) {
  return (
    <div
      className="table-shell user-table-shell"
      role="region"
      aria-label="Users"
      tabIndex={0}
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
            <th scope="col">User last activity (Users report)</th>
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
                      reported {user.missingUserReport ? "Unknown" : user.reportedAgentsUsed.toLocaleString()}
                    </small>
                  </div>
                </td>
                <td>
                  <div className="user-count-stack">
                    <strong>
                      {user.bridgeResponsesSentToUsers.toLocaleString()}
                    </strong>
                    <small>
                      reported {user.missingUserReport ? "Unknown" : user.reportedResponsesReceived.toLocaleString()}
                    </small>
                  </div>
                </td>
                <td>{formatReportDate(user.userLastActivityDateUtc)}</td>
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
  user: OfficialUsageUserSummary;
}) {
  const emptyTitle =
    accessRowFilter === "responses"
      ? "No response-producing agents"
      : "No agent access rows";
  const emptyMessage =
    accessRowFilter === "responses"
      ? "Switch Access rows back to all accessed agents to see 0-response history."
      : "Import and activate Agents, Users & agents, and Users for one compatible period to show this user's agent access history.";

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
          <p>Dataset {user.datasetScope.reportSetId ?? "unavailable"}; Users version {user.datasetScope.usersVersionId ?? "absent"}; Users &amp; agents version {user.datasetScope.userAgentsVersionId ?? "absent"}</p>
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
            label="User last activity"
            value={formatReportDate(user.userLastActivityDateUtc)}
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
          tabIndex={0}
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
                <th scope="col">Identity</th>
                <th scope="col">Usage authority</th>
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
                  <td>{row.creatorType || "Unknown"}<small>Users &amp; agents report</small></td>
                  <td>
                    <dl className="usage-cell">
                      <div>
                        <dt>Agent last used by anyone</dt>
                        <dd>{formatReportDate(row.lastActivityDateUtc)}</dd>
                      </div>
                      <div>
                        <dt>Resp</dt>
                        <dd>{row.responsesSentToUsers.toLocaleString()}</dd>
                      </div>
                    </dl>
                  </td>
                  <td>
                    <span className="status unknown">Report only / unresolved ID</span>
                  </td>
                  <td>Official Microsoft 365 export</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function UserUsageLineage({ data }: { data: OfficialUsageUserView }) {
  return (
    <section className="official-usage-lineage" aria-label="Official user usage lineage">
      <div><span>Authority</span><strong>{data.authority}</strong></div>
      <div><span>State</span><strong>{formatAvailability(data.availability)}</strong></div>
      <div><span>Source period</span><strong>{data.activeSet ? `${data.activeSet.reportingPeriod.startDate} to ${data.activeSet.reportingPeriod.endDate}` : "Unavailable"}</strong></div>
      <div><span>Age / staleness</span><strong>{data.periodAgeDays === null ? "Unknown" : `Period ${data.periodAgeDays} day(s); import ${data.acceptedAgeDays} day(s); threshold ${data.staleAfterDays}`}</strong></div>
      <div><span>Versions</span><strong>{data.lineages.map(lineage => `${kindLabel(lineage.kind)} ${lineage.fileHash.slice(0, 10)} / ${lineage.schemaVersion} / ${lineage.sourceFreshness} / ${lineage.reportingPeriod.provenance}${lineage.warnings.length ? ` / ${lineage.warnings.length} warning(s)` : ""}`).join("; ") || "None"}</strong></div>
      <div><span>Identity</span><strong>Dataset-scoped; exact IDs unresolved</strong></div>
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
  user: OfficialUsageUserSummary,
  accessRowFilter: AccessRowFilter,
) {
  if (accessRowFilter === "responses") {
    return user.rows.filter((row) => row.hasResponses);
  }

  return user.rows;
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

function formatAvailability(value: OfficialUsageUserView["availability"]) {
  return value.split("_").map(part => part[0].toUpperCase() + part.slice(1)).join(" ");
}

function kindLabel(value: OfficialUsageUserView["lineages"][number]["kind"]) {
  return value === "agents" ? "Agents" : value === "userAgents" ? "Users & agents" : "Users";
}
