import { useDeferredValue, useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, ExternalLink } from "lucide-react";
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

const auditPageSize = 100;

export function AuditLogView({ agents }: AuditLogViewProps) {
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [pageIndex, setPageIndex] = useState(0);
  const [refreshToken, setRefreshToken] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [query, setQuery] = useState("");
  const [actionFilter, setActionFilter] = useState<AuditFilter>("all");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [detailEvent, setDetailEvent] = useState<AuditEvent>();
  const deferredQuery = useDeferredValue(query);

  const agentNamesById = useMemo(
    () => new Map(agents.map((agent) => [agent.id, agent.displayName])),
    [agents],
  );

  useEffect(() => {
    let cancelled = false;

    async function loadPage() {
      setLoading(true);
      setError(undefined);

      try {
        const response = await getAuditEvents({
          limit: auditPageSize,
          offset: pageIndex * auditPageSize,
          action: actionFilter === "all" ? undefined : actionFilter,
          status: statusFilter === "all" ? undefined : statusFilter,
          search: deferredQuery.trim() || undefined,
        });
        const lastPageIndex = Math.max(
          Math.ceil(response.count / auditPageSize) - 1,
          0,
        );

        if (cancelled) {
          return;
        }

        if (pageIndex > lastPageIndex) {
          setEvents([]);
          setTotalCount(response.count);
          setPageIndex(lastPageIndex);
          return;
        }

        setEvents(response.value);
        setTotalCount(response.count);
      } catch (requestError) {
        if (!cancelled) {
          setError(errorMessage(requestError));
          setEvents([]);
          setTotalCount(0);
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    void loadPage();

    return () => {
      cancelled = true;
    };
  }, [actionFilter, deferredQuery, pageIndex, refreshToken, statusFilter]);

  const succeededCount = events.filter(
    (event) => event.status === "succeeded",
  ).length;
  const failedCount = events.filter(
    (event) => event.status === "failed",
  ).length;
  const skippedCount = events.filter(
    (event) => event.status === "skipped",
  ).length;
  const hasActiveAuditFilters =
    query.trim().length > 0 || actionFilter !== "all" || statusFilter !== "all";
  const totalPages = Math.max(Math.ceil(totalCount / auditPageSize), 1);
  const pageStart = totalCount === 0 ? 0 : pageIndex * auditPageSize + 1;
  const pageEnd = Math.min((pageIndex + 1) * auditPageSize, totalCount);

  function handleClearAuditFilters() {
    setQuery("");
    setActionFilter("all");
    setStatusFilter("all");
    setPageIndex(0);
  }

  function handleRefreshAuditLog() {
    setRefreshToken((current) => current + 1);
  }

  function handleExportAuditCsv() {
    if (events.length === 0) {
      return;
    }

    downloadCsv(getAuditExportFilename(), toAuditCsv(events, agentNamesById));
  }

  return (
    <section className="audit-view" aria-label="Audit log">
      <section
        className="summary-grid audit-summary-grid"
        aria-label="Audit summary"
      >
        <AuditMetric label="Events" value={totalCount} />
        <AuditMetric label="Page succeeded" value={succeededCount} />
        <AuditMetric label="Page failed" value={failedCount} />
        <AuditMetric label="Page skipped" value={skippedCount} />
      </section>

      {error ? <div className="error-banner">{error}</div> : null}

      <section className="controls audit-controls" aria-label="Audit filters">
        <label className="filter-search">
          <span>Search</span>
          <input
            type="search"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setPageIndex(0);
            }}
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
            onChange={(event) => {
              setActionFilter(event.target.value as AuditFilter);
              setPageIndex(0);
            }}
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
            onChange={(event) => {
              setStatusFilter(event.target.value as StatusFilter);
              setPageIndex(0);
            }}
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
            className="secondary clear-filters-button"
            disabled={!hasActiveAuditFilters}
            onClick={handleClearAuditFilters}
          >
            Clear filters
          </button>
          <button
            type="button"
            className="icon-button control-icon-button"
            aria-label={loading ? "Refreshing audit log" : "Refresh audit log"}
            title={loading ? "Refreshing audit log" : "Refresh audit log"}
            disabled={loading}
            onClick={handleRefreshAuditLog}
          >
            <RefreshIcon />
          </button>
          <button
            type="button"
            className="secondary icon-button control-icon-button"
            aria-label="Export current audit page CSV"
            title="Export current audit page CSV"
            disabled={loading || events.length === 0}
            onClick={handleExportAuditCsv}
          >
            <ExportIcon />
          </button>
        </div>
      </section>

      {loading && events.length === 0 ? (
        <div className="screen-state">Loading audit events...</div>
      ) : events.length === 0 ? (
        <div className="empty-state">
          <h2>No audit events</h2>
          <p>Block or unblock an agent, then refresh this view.</p>
        </div>
      ) : (
        <>
          <AuditPagination
            pageIndex={pageIndex}
            totalPages={totalPages}
            pageStart={pageStart}
            pageEnd={pageEnd}
            totalCount={totalCount}
            loading={loading}
            onPageChange={setPageIndex}
            onPrevious={() =>
              setPageIndex((current) => Math.max(current - 1, 0))
            }
            onNext={() =>
              setPageIndex((current) => Math.min(current + 1, totalPages - 1))
            }
          />
          <AuditTable
            events={events}
            agentNamesById={agentNamesById}
            onViewDetails={setDetailEvent}
          />
        </>
      )}
      {detailEvent ? (
        <AuditDetailsModal
          event={detailEvent}
          onClose={() => setDetailEvent(undefined)}
        />
      ) : null}
    </section>
  );
}

function AuditTable({
  events,
  agentNamesById,
  onViewDetails,
}: {
  events: AuditEvent[];
  agentNamesById: Map<string, string>;
  onViewDetails: (event: AuditEvent) => void;
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
            <th scope="col">Details</th>
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
                  <AuditResultCell
                    event={event}
                    onViewDetails={onViewDetails}
                  />
                </td>
                <td>
                  <AuditDetailsPreview event={event} />
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

function AuditPagination({
  pageIndex,
  totalPages,
  pageStart,
  pageEnd,
  totalCount,
  loading,
  onPageChange,
  onPrevious,
  onNext,
}: {
  pageIndex: number;
  totalPages: number;
  pageStart: number;
  pageEnd: number;
  totalCount: number;
  loading: boolean;
  onPageChange: (pageIndex: number) => void;
  onPrevious: () => void;
  onNext: () => void;
}) {
  return (
    <div className="audit-pagination" aria-label="Audit pagination">
      <span>
        Showing {pageStart.toLocaleString()}-{pageEnd.toLocaleString()} of{" "}
        {totalCount.toLocaleString()}
      </span>
      <div className="audit-pagination-actions">
        <button
          type="button"
          className="secondary icon-button control-icon-button"
          aria-label="Previous audit page"
          title="Previous audit page"
          disabled={loading || pageIndex === 0}
          onClick={onPrevious}
        >
          <ChevronLeft aria-hidden="true" />
        </button>
        <label className="audit-page-select-label">
          <span>Page</span>
          <select
            value={pageIndex}
            disabled={loading}
            aria-label="Audit page"
            onChange={(event) =>
              onPageChange(Number.parseInt(event.target.value, 10))
            }
          >
            {Array.from({ length: totalPages }, (_, index) => (
              <option key={index} value={index}>
                {(index + 1).toLocaleString()}
              </option>
            ))}
          </select>
          <span>of {totalPages.toLocaleString()}</span>
        </label>
        <button
          type="button"
          className="secondary icon-button control-icon-button"
          aria-label="Next audit page"
          title="Next audit page"
          disabled={loading || pageIndex >= totalPages - 1}
          onClick={onNext}
        >
          <ChevronRight aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

function AuditDetailsPreview({ event }: { event: AuditEvent }) {
  if (!hasAuditDetails(event)) {
    return <span className="muted-cell">None</span>;
  }

  return (
    <span
      className="audit-event-details"
      title={fullAuditDetailsMessage(event)}
    >
      {auditDetailsSummary(event)}
    </span>
  );
}

function AuditResultCell({
  event,
  onViewDetails,
}: {
  event: AuditEvent;
  onViewDetails: (event: AuditEvent) => void;
}) {
  const statusLabel = formatStatus(event.status);
  const className = `status ${statusClass(event.status)}`;

  if (!hasAuditDetails(event)) {
    return <span className={className}>{statusLabel}</span>;
  }

  const summary = auditDetailsSummary(event);

  return (
    <button
      type="button"
      className={`${className} audit-result-button`}
      aria-label={`View error message: ${summary}`}
      title={`View error message: ${summary}`}
      onClick={() => onViewDetails(event)}
    >
      <span>{statusLabel}</span>
      <ExternalLink aria-hidden="true" />
    </button>
  );
}

function AuditDetailsModal({
  event,
  onClose,
}: {
  event: AuditEvent;
  onClose: () => void;
}) {
  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <section
        className="confirm-modal audit-details-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="audit-details-title"
        onClick={(clickEvent) => clickEvent.stopPropagation()}
      >
        <div className="audit-details-modal-header">
          <div>
            <p className="eyebrow">Audit details</p>
            <h2 id="audit-details-title">Error message</h2>
          </div>
          <button type="button" className="secondary" onClick={onClose}>
            Close
          </button>
        </div>

        <section className="audit-details-log">
          {hasAuditDetails(event) ? (
            <pre>{formatAuditDetailsMessage(event)}</pre>
          ) : (
            <p>No error message was recorded for this event.</p>
          )}
        </section>
      </section>
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

function toAuditCsv(events: AuditEvent[], agentNamesById: Map<string, string>) {
  const headers = [
    "Time",
    "Agent name",
    "Agent ID",
    "Action",
    "Result",
    "Message",
    "Error code",
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
    event.message ?? "",
    event.errorCode ?? "",
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

function auditDetailsSummary(event: AuditEvent) {
  return summarizeAuditMessage(event.message) ?? event.errorCode ?? "Details";
}

function fullAuditDetailsMessage(event: AuditEvent) {
  return event.message
    ? extractAuditErrorMessage(event.message)
    : (event.errorCode ?? "Details");
}

function hasAuditDetails(event: AuditEvent) {
  return Boolean(event.message || event.errorCode);
}

function summarizeAuditMessage(value: string | undefined) {
  if (!value) {
    return undefined;
  }

  const normalized = extractAuditErrorMessage(value)
    .replaceAll(/\s+/g, " ")
    .trim();
  const maxLength = 15;

  return normalized.length > maxLength
    ? `${normalized.slice(0, maxLength)}...`
    : normalized;
}

function formatAuditDetailsMessage(event: AuditEvent) {
  const errorDetails = event.metadata?.errorDetails;

  if (errorDetails !== undefined) {
    return JSON.stringify(errorDetails, null, 2);
  }

  return event.message
    ? formatJsonIfParseable(event.message)
    : (event.errorCode ?? "Details");
}

function extractAuditErrorMessage(value: string) {
  const normalized = value.trim();

  if (!normalized) {
    return value;
  }

  try {
    const parsed: unknown = JSON.parse(normalized);
    return findErrorMessage(parsed) ?? value;
  } catch {
    return value;
  }
}

function formatJsonIfParseable(value: string) {
  const normalized = value.trim();

  if (!normalized) {
    return value;
  }

  try {
    const parsed: unknown = JSON.parse(normalized);
    return typeof parsed === "object" && parsed !== null
      ? JSON.stringify(parsed, null, 2)
      : value;
  } catch {
    return value;
  }
}

function findErrorMessage(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  if (typeof value.message === "string") {
    return value.message;
  }

  if (typeof value.Message === "string") {
    return value.Message;
  }

  return findErrorMessage(value.error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function errorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  return "Unable to load audit events.";
}
