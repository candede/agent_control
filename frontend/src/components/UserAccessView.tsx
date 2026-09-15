import { useDeferredValue, useEffect, useEffectEvent, useState } from "react";
import type { OfficialUsageUserSummary, OfficialUsageUserView } from "../api/client";

type UserAccessViewProps = {
  data?: OfficialUsageUserView;
  compact?: boolean;
  onPageChange: (offset: number) => void;
  onQueryChange: (query: {
    search?: string;
    creatorType?: string;
    activity?: ActivityFilter;
    responsesOnly?: boolean;
    startDate?: string;
    endDate?: string;
    lowResponseThreshold?: number;
    cohort?: "all" | "zero" | "low" | "review";
    sortBy?: "displayName" | "responses" | "agentsUsed" | "lastActivity";
    sortDirection?: "asc" | "desc";
  }) => void;
};

type ActivityFilter = "all" | "recent" | "inactive" | "no-activity";
type AccessRowFilter = "all" | "responses";
const emptyUserSummaries: OfficialUsageUserSummary[] = [];

export function UserAccessView({
  data,
  compact = false,
  onPageChange,
  onQueryChange,
}: UserAccessViewProps) {
  const [query, setQuery] = useState("");
  const [creatorTypeFilter, setCreatorTypeFilter] = useState("all");
  const [activityFilter, setActivityFilter] = useState<ActivityFilter>("all");
  const [accessRowFilter, setAccessRowFilter] =
    useState<AccessRowFilter>("all");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [lowResponseThreshold, setLowResponseThreshold] = useState(5);
  const [cohort, setCohort] = useState<"all" | "zero" | "low" | "review">("all");
  const [sortBy, setSortBy] = useState<"displayName" | "responses" | "agentsUsed" | "lastActivity">("responses");
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("desc");
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
      ...(startDate ? { startDate } : {}),
      ...(endDate ? { endDate } : {}),
      lowResponseThreshold,
      ...(cohort !== "all" ? { cohort } : {}),
      sortBy,
      sortDirection,
    });
  }, [accessRowFilter, activityFilter, cohort, creatorTypeFilter, deferredQuery, endDate, lowResponseThreshold, sortBy, sortDirection, startDate]);

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
    accessRowFilter !== "all" ||
    startDate !== "" ||
    endDate !== "" ||
    lowResponseThreshold !== 5 ||
    cohort !== "all" ||
    sortBy !== "responses" ||
    sortDirection !== "desc";

  function handleClearUserFilters() {
    setQuery("");
    setCreatorTypeFilter("all");
    setActivityFilter("all");
    setAccessRowFilter("all");
    setStartDate("");
    setEndDate("");
    setLowResponseThreshold(5);
    setCohort("all");
    setSortBy("responses");
    setSortDirection("desc");
  }

  if (!data) return <div className="screen-state">Loading official user usage...</div>;

  if (!data.counts.users) {
    return (
      <section className="user-access-view" aria-label="User agent access">
        {!compact ? <UserUsageLineage data={data} /> : null}
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
    <section className={compact ? "user-access-view embedded-user-access" : "user-access-view"} aria-label="User agent access">
      {!compact ? <UserUsageLineage data={data} /> : null}
      <div className="summary-grid user-summary-grid" aria-label="User summary">
        <Metric label="All imported identities" value={data.counts.users} />
        <Metric label="Matching identities" value={data.users.count} />
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
        <label><span>User activity start (UTC)</span><input type="date" value={startDate} max={endDate || undefined} onChange={event => setStartDate(event.target.value)} /></label>
        <label><span>User activity end (UTC)</span><input type="date" value={endDate} min={startDate || undefined} onChange={event => setEndDate(event.target.value)} /></label>
        <label><span>Review cohort</span><select value={cohort} onChange={event => setCohort(event.target.value as typeof cohort)}><option value="all">All users</option><option value="review">All review candidates</option><option value="zero">0 responses</option><option value="low">Low responses (1–threshold)</option></select></label>
        <label><span>Low-response threshold</span><input type="number" min="1" max="100000000" value={lowResponseThreshold} onChange={event => setLowResponseThreshold(clampInteger(event.target.value, 1, 100_000_000, 5))} /></label>
        <label><span>Sort</span><select value={sortBy} onChange={event => setSortBy(event.target.value as typeof sortBy)}><option value="responses">Responses</option><option value="agentsUsed">Agents used</option><option value="lastActivity">User last activity</option><option value="displayName">Display name</option></select></label>
        <label><span>Direction</span><select value={sortDirection} onChange={event => setSortDirection(event.target.value as typeof sortDirection)}><option value="desc">Highest / newest first</option><option value="asc">Lowest / oldest first</option></select></label>
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
          <h2>No users match</h2>
          <p>Try clearing the search or filters.</p>
          <button type="button" className="secondary" onClick={handleClearUserFilters}>Reset user filters</button>
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
            <th scope="col">Review cohort</th>
            <th scope="col">License assignment</th>
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
                      {(user.missingUserReport ? user.bridgeResponsesSentToUsers : user.reportedResponsesReceived).toLocaleString()}
                    </strong>
                    <small>
                      {user.missingUserReport ? "Users report unavailable; Users & agents total shown" : `Users & agents: ${user.bridgeResponsesSentToUsers.toLocaleString()}`}
                    </small>
                  </div>
                </td>
                <td>{formatReportDate(user.userLastActivityDateUtc)}</td>
                <td>
                  <span className={user.reviewCandidate ? "status warning" : "status neutral"}>{cohortLabel(user.reviewCohort)}</span>
                  {user.reviewCandidate ? <small>Confirm assignment and full Copilot usage</small> : null}
                </td>
                <td>Unavailable in exports</td>
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
      : "The imported Users & agents report contains no agent rows for this user. This does not establish that their Copilot license is unused.";

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
          <SummaryStat label="Agents used (Users report)" value={user.missingUserReport ? "Unknown" : user.reportedAgentsUsed} />
          <SummaryStat
            label="Responses (Users report)"
            value={user.missingUserReport ? "Unknown" : user.reportedResponsesReceived}
          />
          <SummaryStat
            label="Responses (displayed agent rows)"
            value={rows.reduce(
              (total, row) => total + row.responsesSentToUsers,
              0,
            )}
          />
          <SummaryStat
            label="User last activity"
            value={formatReportDate(user.userLastActivityDateUtc)}
          />
          <SummaryStat label="License assignment" value="Unavailable" />
          <SummaryStat label="Reconciliation" value={user.hasReportMismatch ? "Mismatch" : user.missingUserReport ? "Users row absent" : "Matching"} />
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
      <div><span>{data.activeSet?.reportingPeriod.provenance === "activity_range" ? "Observed activity range" : "Source period"}</span><strong>{formatCoverage(data.activeSet?.reportingPeriod)}</strong></div>
      <div><span>Age / staleness</span><strong>{`Coverage ${data.periodAgeDays === null ? "unknown" : `${data.periodAgeDays} day(s)`}; import ${data.acceptedAgeDays === null ? "unknown" : `${data.acceptedAgeDays} day(s)`}; threshold ${data.staleAfterDays}`}</strong></div>
      <div><span>Versions</span><strong>{data.lineages.map(lineage => `${kindLabel(lineage.kind)} ${lineage.fileHash.slice(0, 10)} / ${lineage.schemaVersion} / ${lineage.sourceFreshness} / ${lineage.reportingPeriod.provenance}${lineage.warnings.length ? ` / ${lineage.warnings.length} warning(s)` : ""}`).join("; ") || "None"}</strong></div>
      <div><span>Identity</span><strong>Dataset-scoped; exact IDs unresolved</strong></div>
      <div><span>User recency anchor</span><strong>{formatReportDate(data.recencyAnchorDateUtc)} (latest observed Users date)</strong></div>
      <div><span>Decision rule</span><strong>{data.decisionNotice}</strong></div>
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

function cohortLabel(value: OfficialUsageUserSummary["reviewCohort"]) {
  return value === "zero_responses"
    ? "0 responses — review candidate"
    : value === "low_responses"
      ? "Low responses — review candidate"
      : value === "unknown"
        ? "Unknown (Users row absent)"
        : "Outside threshold";
}

function clampInteger(value: string, minimum: number, maximum: number, fallback: number) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback;
}

function formatAvailability(value: OfficialUsageUserView["availability"]) {
  return value.split("_").map(part => part[0].toUpperCase() + part.slice(1)).join(" ");
}

function kindLabel(value: OfficialUsageUserView["lineages"][number]["kind"]) {
  return value === "agents" ? "Agents" : value === "userAgents" ? "Users & agents" : "Users";
}

function formatCoverage(period?: { startDate: string | null; endDate: string | null }) {
  if (!period?.startDate && !period?.endDate) return "Unknown; the source export period is not provided";
  if (period.startDate && period.endDate) return `${period.startDate} to ${period.endDate}`;
  return period.startDate ? `From ${period.startDate}` : `Through ${period.endDate}`;
}
