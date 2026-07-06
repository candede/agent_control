import { useDeferredValue, useEffect, useMemo, useState } from "react";
import {
  getAuditEvents,
  type AuditAction,
  type AuditEvent,
  type AuditStatus,
  type CopilotPackage,
} from "../api/client";
import { downloadCsv } from "../agentExport";

type AuditFilter = "all" | AuditAction;
type StatusFilter = "all" | AuditStatus;

type AuditLogViewProps = {
  agents: Pick<CopilotPackage, "id" | "displayName">[];
};

export function AuditLogView({ agents }: AuditLogViewProps) {
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [query, setQuery] = useState("");
  const [actionFilter, setActionFilter] = useState<AuditFilter>("all");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const deferredQuery = useDeferredValue(query);

  const agentNamesById = useMemo(
    () => new Map(agents.map((agent) => [agent.id, agent.displayName])),
    [agents],
  );

  useEffect(() => {
    void loadEvents();
  }, []);

  const filteredEvents = useMemo(() => {
    const normalizedQuery = deferredQuery.trim().toLowerCase();

    return events.filter((event) => {
      const matchesAction =
        actionFilter === "all" || event.action === actionFilter;
      const matchesStatus =
        statusFilter === "all" || event.status === statusFilter;
      const matchesQuery =
        !normalizedQuery ||
        searchableAuditText(event, agentNamesById).includes(normalizedQuery);

      return matchesAction && matchesStatus && matchesQuery;
    });
  }, [actionFilter, agentNamesById, deferredQuery, events, statusFilter]);

  const succeededCount = events.filter(
    (event) => event.status === "succeeded",
  ).length;
  const failedCount = events.filter(
    (event) => event.status === "failed",
  ).length;
  const skippedCount = events.filter(
    (event) => event.status === "skipped",
  ).length;

  async function loadEvents() {
    setLoading(true);
    setError(undefined);

    try {
      const response = await getAuditEvents({ limit: 250 });
      setEvents(response.value);
    } catch (requestError) {
      setError(errorMessage(requestError));
    } finally {
      setLoading(false);
    }
  }

  function handleExportAuditCsv() {
    if (filteredEvents.length === 0) {
      return;
    }

    downloadCsv(
      getAuditExportFilename(),
      toAuditCsv(filteredEvents, agentNamesById),
    );
  }

  return (
    <section className="audit-view" aria-label="Audit log">
      <section
        className="summary-grid audit-summary-grid"
        aria-label="Audit summary"
      >
        <AuditMetric label="Events" value={events.length} />
        <AuditMetric label="Succeeded" value={succeededCount} />
        <AuditMetric label="Failed" value={failedCount} />
        <AuditMetric label="Skipped" value={skippedCount} />
      </section>

      {error ? <div className="error-banner">{error}</div> : null}

      <section className="controls audit-controls" aria-label="Audit filters">
        <label className="filter-search">
          <span>Search</span>
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Agent, user, group"
          />
        </label>
        <label>
          <span>Action</span>
          <select
            className={
              actionFilter === "all" ? undefined : "active-filter-select"
            }
            value={actionFilter}
            onChange={(event) =>
              setActionFilter(event.target.value as AuditFilter)
            }
          >
            <option value="all">All actions</option>
            <option value="block">Block</option>
            <option value="unblock">Unblock</option>
          </select>
        </label>
        <label>
          <span>Result</span>
          <select
            className={
              statusFilter === "all" ? undefined : "active-filter-select"
            }
            value={statusFilter}
            onChange={(event) =>
              setStatusFilter(event.target.value as StatusFilter)
            }
          >
            <option value="all">All results</option>
            <option value="succeeded">Succeeded</option>
            <option value="failed">Failed</option>
            <option value="skipped">Skipped</option>
            <option value="started">Started</option>
          </select>
        </label>
        <div className="filter-actions" aria-label="Audit actions">
          <button
            type="button"
            className="icon-button control-icon-button"
            aria-label={loading ? "Refreshing audit log" : "Refresh audit log"}
            title={loading ? "Refreshing audit log" : "Refresh audit log"}
            disabled={loading}
            onClick={() => void loadEvents()}
          >
            <RefreshIcon />
          </button>
          <button
            type="button"
            className="secondary icon-button control-icon-button"
            aria-label="Export filtered audit log CSV"
            title="Export filtered audit log CSV"
            disabled={loading || filteredEvents.length === 0}
            onClick={handleExportAuditCsv}
          >
            <ExportIcon />
          </button>
        </div>
      </section>

      {loading && events.length === 0 ? (
        <div className="screen-state">Loading audit events...</div>
      ) : filteredEvents.length === 0 ? (
        <div className="empty-state">
          <h2>No audit events</h2>
          <p>Block or unblock an agent, then refresh this view.</p>
        </div>
      ) : (
        <AuditTable events={filteredEvents} agentNamesById={agentNamesById} />
      )}
    </section>
  );
}

function AuditTable({
  events,
  agentNamesById,
}: {
  events: AuditEvent[];
  agentNamesById: Map<string, string>;
}) {
  return (
    <div
      className="table-shell audit-table-shell"
      role="region"
      aria-label="Audit events"
    >
      <div className="selection-summary">
        <span>{events.length.toLocaleString()} events</span>
      </div>
      <table>
        <thead>
          <tr>
            <th scope="col">Time</th>
            <th scope="col">Agent</th>
            <th scope="col">Action</th>
            <th scope="col">Result</th>
            <th scope="col">By</th>
            <th scope="col">Action group</th>
          </tr>
        </thead>
        <tbody>
          {events.map((event) => {
            const agentDisplayName = getAuditAgentDisplayName(
              event,
              agentNamesById,
            );

            return (
              <tr key={event.id}>
                <td>{formatDateTime(event.completedAt ?? event.startedAt)}</td>
                <td>
                  <div className="agent-name">
                    {agentDisplayName || event.agentId}
                  </div>
                  {agentDisplayName ? (
                    <div className="agent-description agent-id">
                      {event.agentId}
                    </div>
                  ) : null}
                </td>
                <td>{event.action === "block" ? "Block" : "Unblock"}</td>
                <td>
                  <span className={`status ${statusClass(event.status)}`}>
                    {formatStatus(event.status)}
                  </span>
                </td>
                <td>
                  <div className="agent-name">
                    {event.actor.displayName || event.actor.username}
                  </div>
                  <div className="agent-description">
                    {event.actor.username}
                  </div>
                </td>
                <td>
                  <div className="audit-group-label">
                    {formatActionGroup(event)}
                  </div>
                  <div
                    className="audit-group-reference"
                    title={`Operation ID: ${event.operationId}`}
                  >
                    Ref {shortOperationId(event.operationId)}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function AuditMetric({ label, value }: { label: string; value: number }) {
  return (
    <article className="metric">
      <span>{label}</span>
      <strong>{value.toLocaleString()}</strong>
    </article>
  );
}

function RefreshIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M21 12a9 9 0 0 1-15.3 6.4" />
      <path d="M3 12A9 9 0 0 1 18.3 5.6" />
      <path d="M18 2v4h-4" />
      <path d="M6 22v-4h4" />
    </svg>
  );
}

function ExportIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <path d="M7 10l5 5 5-5" />
      <path d="M12 15V3" />
    </svg>
  );
}

function getAuditAgentDisplayName(
  event: AuditEvent,
  agentNamesById: Map<string, string>,
) {
  return event.agentDisplayName || agentNamesById.get(event.agentId);
}

function searchableAuditText(
  event: AuditEvent,
  agentNamesById: Map<string, string>,
) {
  return [
    event.agentId,
    getAuditAgentDisplayName(event, agentNamesById),
    event.action,
    event.status,
    event.scope,
    formatActionGroup(event),
    shortOperationId(event.operationId),
    event.actor.username,
    event.actor.displayName,
    event.operationId,
    event.errorCode,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function toAuditCsv(events: AuditEvent[], agentNamesById: Map<string, string>) {
  const headers = [
    "Time",
    "Agent name",
    "Agent ID",
    "Action",
    "Result",
    "Actor name",
    "Actor username",
    "Action group",
    "Group ref",
    "Operation ID",
  ];
  const rows = events.map((event) => [
    formatDateTime(event.completedAt ?? event.startedAt),
    getAuditAgentDisplayName(event, agentNamesById) ?? "",
    event.agentId,
    event.action === "block" ? "Block" : "Unblock",
    formatStatus(event.status),
    event.actor.displayName,
    event.actor.username,
    formatActionGroup(event),
    shortOperationId(event.operationId),
    event.operationId,
  ]);

  return [headers, ...rows]
    .map((row) => row.map((value) => csvCell(value)).join(","))
    .join("\r\n");
}

function csvCell(value: string) {
  return `"${value.replaceAll('"', '""')}"`;
}

function formatActionGroup(event: AuditEvent) {
  return event.scope === "bulk" ? "Bulk run" : "Single action";
}

function shortOperationId(operationId: string) {
  return operationId.split("-")[0] || operationId.slice(0, 8);
}

function getAuditExportFilename() {
  return `copilot-audit-log-${new Date()
    .toISOString()
    .replaceAll(/[:.]/g, "-")}.csv`;
}

function formatDateTime(value: string) {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function formatStatus(status: AuditStatus) {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function statusClass(status: AuditStatus) {
  if (status === "succeeded") {
    return "allowed";
  }

  if (status === "failed") {
    return "blocked";
  }

  if (status === "skipped") {
    return "warning";
  }

  return "report-only";
}

function errorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  return "Unable to load audit events.";
}
