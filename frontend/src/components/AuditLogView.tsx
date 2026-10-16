import {
  useDeferredValue,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
} from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ChevronLeft,
  ChevronRight,
  Download,
  ExternalLink,
  RefreshCw,
} from "lucide-react";
import {
  ApiError,
  getAuditEvents,
  downloadAdministrativeAuditCsv,
  type AuditEvent,
  type AuditStatus,
  type CopilotPackage,
  type LocalAuditAction,
} from "../api/client";
import { downloadFile } from "../downloadFile";
import { lockBodyScroll } from "../bodyScrollLock";
import { useSavedQueryClient } from "../savedQueries";
import { WorkbenchActionGate } from "../workbenchActionContext";
import { WorkspaceSkeleton } from "./WorkspaceSkeleton";
import { auditRouteSearch, maximumAuditPageIndex, parseAuditRoute, parseWorkbenchView, workbenchUrl, type AuditRouteState } from "../workbenchRouting";
import { auditDefaultPageSize, auditMaximumSearchLength, auditMetadata } from "../../../backend/src/types/audit";
import { unknownOrigin, type AuditOriginV1, type AttributionField } from "../../../backend/src/types/actionOrigin";

type AuditFilter = "all" | LocalAuditAction;
type StatusFilter = "all" | AuditStatus;

type AuditLogViewProps = {
  agents: Pick<CopilotPackage, "id" | "displayName">[];
};

const auditPageSize = auditDefaultPageSize;
const auditActionLabels: Record<LocalAuditAction, string> = {
  block: "Block",
  unblock: "Unblock",
  "update-availability": "Update availability",
  "update-installation": "Update installation",
  reassign: "Reassign owner",
  "view-audit-search": "View provider audit",
  "export-audit-search": "Export provider audit",
  "view-hunting": "View Defender hunting",
  "export-hunting": "Export Defender hunting",
  "submit-hunting": "Submit Defender hunt",
  "query-hunting": "Query Defender hunting",
  "cancel-hunting": "Cancel Defender hunt",
  "delete-hunting": "Delete Defender hunt",
  "export-agent-inventory": "Export agent inventory",
  "export-package-inventory": "Export package inventory",
  "export-power-platform-inventory": "Export Power Platform inventory",
  "export-official-usage-aggregate": "Export agent usage report",
  "export-official-usage-users": "Export user usage report",
  "export-administrative-audit": "Export administrative audit",
  "associate-agent-usage": "Associate agent usage",
  "remove-agent-usage-association": "Remove usage association",
  "resume-control": "Resume control",
  "cancel-control": "Cancel control",
  "reconcile-control": "Reconcile control",
};

export function AuditLogView({ agents }: AuditLogViewProps) {
  const [route, setRoute] = useState(() => parseAuditRoute(window.location.search));

  function commitRoute(next: AuditRouteState, push = false) {
    setRoute(next);
    const url = workbenchUrl("audit", auditRouteSearch(next));
    if (`${window.location.pathname}${window.location.search}` !== url) {
      window.history[push ? "pushState" : "replaceState"]({ view: "audit" }, "", url);
    }
  }

  useEffect(() => {
    const restore = () => {
      if (parseWorkbenchView(window.location.pathname) !== "audit") return;
      const next = parseAuditRoute(window.location.search);
      setRoute(next);
      const url = workbenchUrl("audit", auditRouteSearch(next));
      if (`${window.location.pathname}${window.location.search}` !== url) {
        window.history.replaceState({ view: "audit" }, "", url);
      }
    };
    restore();
    window.addEventListener("popstate", restore);
    return () => window.removeEventListener("popstate", restore);
  }, []);

  return (
    <section className="audit-source-view" aria-label="Audit evidence">
      <header>
        <h2>Local control audit</h2>
        <p>Actions accepted by the API, including web and integration controls. Origin describes the caller, not the managed target or provider. For provider records, open an individual agent or user in Agents or Users.</p>
      </header>
      <LocalAuditLogView agents={agents} route={route} onRouteChange={commitRoute} />
    </section>
  );
}

function LocalAuditLogView({
  agents,
  onRouteChange,
  route,
}: AuditLogViewProps & {
  onRouteChange: (route: AuditRouteState, push?: boolean) => void;
  route: AuditRouteState;
}) {
  const [refreshToken, setRefreshToken] = useState<string>();
  const [exportError, setExportError] = useState<{ key: string; message: string; invalidated: boolean }>();
  const [detailSelection, setDetailSelection] = useState<{ key: string; id: string }>();
  const [exportKey, setExportKey] = useState<string>();
  const exportRequest = useRef<AbortController | undefined>(undefined);
  const query = route.search;
  const actionFilter = route.action as AuditFilter;
  const statusFilter = route.status as StatusFilter;
  const pageIndex = route.page;
  const deferredQuery = useDeferredValue(query);
  const deferredMatches = query.trim() === deferredQuery.trim();
  const auditQuery = useMemo(() => ({
    limit: auditPageSize,
    offset: pageIndex * auditPageSize,
    action: actionFilter === "all" ? undefined : actionFilter,
    status: statusFilter === "all" ? undefined : statusFilter,
    search: deferredQuery.trim() || undefined,
    originChannel: !route.originChannel || route.originChannel === "all" ? undefined : route.originChannel,
    originIntegrationClientId: route.originIntegrationClientId,
    originClientId: route.originClientId,
    originCallingAgentId: route.originCallingAgentId,
  }), [actionFilter, deferredQuery, pageIndex, statusFilter, route.originChannel, route.originIntegrationClientId, route.originClientId, route.originCallingAgentId]);
  const queryClient = useSavedQueryClient();
  const queryKey = ["audit-events", auditQuery, refreshToken];
  const auditRead = useQuery({
    queryKey,
    queryFn: ({ signal }) => getAuditEvents(auditQuery, { signal }),
    enabled: deferredMatches,
  }, queryClient);
  const queryState = queryClient.getQueryState(queryKey);
  // Evidence actions belong to one displayed page, not just its reusable filters.
  // Counters also retire batched refreshes that settle within the same millisecond.
  const key = JSON.stringify([auditQuery, refreshToken, query.trim(), queryState?.dataUpdateCount, queryState?.errorUpdateCount, queryState?.isInvalidated, auditRead.isFetching]);
  const exporting = exportKey === key;
  useEffect(() => () => {
    exportRequest.current?.abort();
    exportRequest.current = undefined;
    setExportKey(undefined);
    setExportError(undefined);
    setDetailSelection(undefined);
  }, [key]);
  const lastPageIndex = auditRead.data
    ? Math.min(Math.max(Math.ceil(auditRead.data.count / auditPageSize) - 1, 0), maximumAuditPageIndex)
    : 0;
  const exportReadError = exportError?.key === key && exportError.invalidated ? exportError.message : undefined;
  const incompleteRead = deferredMatches && !auditRead.isFetching && !auditRead.isError
    && (auditRead.isPending || queryState?.isInvalidated);
  const readError = exportReadError ?? (deferredMatches && !auditRead.isFetching && auditRead.error ? errorMessage(auditRead.error)
    : incompleteRead ? auditRead.isPending ? "The saved audit read was cancelled. Retry audit log."
      : "Saved audit evidence needs reloading. Retry audit log." : undefined);
  const page = !readError && !auditRead.isFetching && !auditRead.isError && auditRead.data && pageIndex <= lastPageIndex && deferredMatches
    ? auditRead.data
    : undefined;
  const events = page?.value ?? [];
  const detailEvent = detailSelection?.key === key ? events.find(event => event.id === detailSelection.id) : undefined;
  const totalCount = page?.count ?? 0;
  const loading = !page && !readError;
  const error = readError ?? (exportError?.key === key ? exportError.message : undefined);
  const [initialReadComplete, setInitialReadComplete] = useState(false);
  if (!initialReadComplete && (page || readError)) setInitialReadComplete(true);
  const syncClampedPage = useEffectEvent((page: number) => {
    onRouteChange({ ...route, page });
  });

  function updateRoute(next: Partial<AuditRouteState>) {
    onRouteChange({ ...route, ...next });
  }

  const agentNamesById = useMemo(
    () => new Map(agents.map((agent) => [agent.id, agent.displayName])),
    [agents],
  );

  useEffect(() => {
    if (deferredMatches && !incompleteRead && !auditRead.isFetching && !auditRead.isError && auditRead.data && pageIndex > lastPageIndex) {
      syncClampedPage(lastPageIndex);
    }
  }, [auditRead.data, auditRead.isError, auditRead.isFetching, deferredMatches, incompleteRead, lastPageIndex, pageIndex]);

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
    query.trim().length > 0 || actionFilter !== "all" || statusFilter !== "all"
    || Boolean(route.originChannel && route.originChannel !== "all" || route.originClientId || route.originCallingAgentId || route.originIntegrationClientId);
  const totalPages = Math.min(Math.max(Math.ceil(totalCount / auditPageSize), 1), maximumAuditPageIndex + 1);
  const pageStart = totalCount === 0 ? 0 : pageIndex * auditPageSize + 1;
  const pageEnd = Math.min((pageIndex + 1) * auditPageSize, totalCount);

  function handleClearAuditFilters() {
    onRouteChange({ ...route, search: "", action: "all", status: "all", page: 0, originChannel: "all",
      originClientId: undefined, originCallingAgentId: undefined, originIntegrationClientId: undefined });
  }

  function handleRefreshAuditLog() {
    setRefreshToken(crypto.randomUUID());
  }

  async function handleExportAuditCsv() {
    // Query notifications may be batched until after an export's promise settles.
    const ownsRead = () => queryClient.getQueryState(queryKey) === queryState;
    if (loading || !events.length || exportRequest.current || !ownsRead()) return;
    const controller = new AbortController();
    exportRequest.current = controller;
    setExportKey(key);
    setExportError(undefined);
    try {
      const blob = await downloadAdministrativeAuditCsv(events.map(event => event.id), controller.signal);
      if (!controller.signal.aborted && ownsRead()) downloadFile("administrative-audit.csv", blob);
    } catch (requestError) {
      if (!controller.signal.aborted && ownsRead()) setExportError({
        key,
        message: errorMessage(requestError),
        invalidated: requestError instanceof ApiError && (
          requestError.status === 401 || requestError.status === 403
          || requestError.status === 404 && requestError.code === "not_found"
          || requestError.status === 409 && requestError.code === "dataset_invalidated"
        ),
      });
    } finally {
      if (exportRequest.current === controller) exportRequest.current = undefined;
      if (!controller.signal.aborted) setExportKey(undefined);
    }
  }

  if (!initialReadComplete && loading) return <WorkspaceSkeleton view="audit" contentOnly />;

  return (
    <section className="audit-view" aria-label="Audit log">
      <section
        className="summary-grid audit-summary-grid"
        aria-label="Audit summary"
      >
        <AuditMetric label="Events" value={page ? totalCount : null} />
        <AuditMetric label="Page succeeded" value={page ? succeededCount : null} />
        <AuditMetric label="Page failed" value={page ? failedCount : null} />
        <AuditMetric label="Page skipped" value={page ? skippedCount : null} />
      </section>

      {error ? <div className="error-banner" role="alert">{error}
        {readError ? <button type="button" className="secondary" onClick={handleRefreshAuditLog}>Retry audit log</button> : null}
      </div> : null}

      <section className="controls audit-controls" aria-label="Audit filters">
        <label className="filter-search">
          <span>Search</span>
          <input
            type="search"
            value={query}
            maxLength={auditMaximumSearchLength}
            onChange={(event) => {
              const search = event.target.value;
              updateRoute({ search, page: search.trim() === query.trim() ? pageIndex : 0 });
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
              updateRoute({ action: event.target.value, page: 0 });
            }}
          >
            <option value="all">All actions</option>
            {Object.entries(auditActionLabels).map(([action, label]) => <option key={action} value={action}>{label}</option>)}
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
              updateRoute({ status: event.target.value, page: 0 });
            }}
          >
            <option value="all">All results</option>
            <option value="requested">Requested</option>
            <option value="started">Started</option>
            <option value="succeeded">Succeeded</option>
            <option value="failed">Failed</option>
            <option value="skipped">Skipped</option>
            <option value="inconclusive">Inconclusive</option>
            <option value="cancelled">Cancelled</option>
          </select>
        </label>
        <label>
          <span>Origin</span>
          <select value={route.originChannel ?? "all"} onChange={event => updateRoute({ originChannel: event.target.value as AuditRouteState["originChannel"], page: 0 })}>
            <option value="all">All origins</option>
            <option value="webapp">Web app</option>
            <option value="mcp">MCP integration</option>
            <option value="unknown">Unknown / historical</option>
          </select>
        </label>
        {(["originIntegrationClientId", "originClientId", "originCallingAgentId"] as const).map((field, index) => <label key={field}>
          <span>{["Integration client ID", "Calling client ID", "Calling agent ID"][index]}</span>
          <input value={route[field] ?? ""} maxLength={256} onChange={event => updateRoute({ [field]: event.target.value || undefined, page: 0 })} />
        </label>)}
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
            <RefreshCw aria-hidden="true" />
          </button>
          <WorkbenchActionGate actionId="audit.export" compact><button
            type="button"
            className="secondary icon-button control-icon-button"
            aria-label="Export current audit page CSV"
            title="Export current audit page CSV"
            disabled={loading || exporting || events.length === 0}
            onClick={() => void handleExportAuditCsv()}
          >
            <Download aria-hidden="true" />
          </button></WorkbenchActionGate>
        </div>
      </section>

      {loading ? (
        <div className="screen-state" role="status">Loading audit events...</div>
      ) : readError ? (
        <div className="empty-state">
          <h2>Audit events unavailable</h2>
          <p>The saved audit evidence could not be read. This does not establish that no events occurred.</p>
        </div>
      ) : events.length === 0 ? (
        <div className="empty-state">
          <h2>No audit events</h2>
          <p>Run an agent control or access change, then refresh this view.</p>
        </div>
      ) : (
        <>
          {totalCount > (maximumAuditPageIndex + 1) * auditPageSize ? (
            <p>Audit pagination is bounded. Refine the filters to view older matching events.</p>
          ) : null}
          <AuditPagination
            pageIndex={pageIndex}
            totalPages={totalPages}
            pageStart={pageStart}
            pageEnd={pageEnd}
            totalCount={totalCount}
            loading={loading}
            onPageChange={next => updateRoute({ page: next })}
            onPrevious={() => {
              const next = Math.max(pageIndex - 1, 0);
              updateRoute({ page: next });
            }}
            onNext={() => {
              const next = Math.min(pageIndex + 1, totalPages - 1);
              updateRoute({ page: next });
            }}
          />
          <AuditTable
            events={events}
            agentNamesById={agentNamesById}
            onViewDetails={event => setDetailSelection({ key, id: event.id })}
          />
        </>
      )}
      {detailEvent ? (
        <AuditDetailsModal
          event={detailEvent}
          onClose={() => setDetailSelection(undefined)}
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
      tabIndex={0}
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
            <th scope="col">Origin</th>
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
                <td>{formatAuditAction(event.action)}</td>
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
                <td className="audit-origin-cell">
                  <strong>{originChannelLabel(event.origin ?? unknownOrigin)}</strong>
                  <div className="agent-description">Client: {event.origin?.client.name.value ?? "Unknown"}</div>
                  <div className="agent-description">Calling agent: {event.origin?.callingAgent.name.value ?? "Unknown"}</div>
                  <button type="button" className="text-button" onClick={() => onViewDetails(event)} aria-label={`View origin details for ${event.id}`}>Origin details</button>
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
      aria-label={`View event details: ${summary}`}
      title={`View event details: ${summary}`}
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
  const dialogRef = useRef<HTMLElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const detailsLog = useRef<HTMLPreElement>(null);
  const closeOnEscape = useEffectEvent(onClose);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const unlockBodyScroll = lockBodyScroll(document.body);
    closeButton.current?.focus();

    function handleKeyDown(keyboardEvent: KeyboardEvent) {
      if (keyboardEvent.defaultPrevented || !(keyboardEvent.target instanceof Node)
        || !dialogRef.current?.contains(keyboardEvent.target)) return;
      if (keyboardEvent.key === "Escape") {
        keyboardEvent.preventDefault();
        closeOnEscape();
      } else if (keyboardEvent.key === "Tab") {
        const first = closeButton.current;
        const last = detailsLog.current ?? first;
        const active = document.activeElement;
        if (keyboardEvent.shiftKey && (active === first || active === dialogRef.current)) {
          keyboardEvent.preventDefault();
          last?.focus();
        } else if (!keyboardEvent.shiftKey && active === last) {
          keyboardEvent.preventDefault();
          first?.focus();
        }
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      unlockBodyScroll();
      previousFocus?.focus();
    };
  }, []);

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <section
        ref={dialogRef}
        className="confirm-modal audit-details-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="audit-details-title"
        tabIndex={-1}
        onClick={(clickEvent) => clickEvent.stopPropagation()}
      >
        <div className="audit-details-modal-header">
          <div>
            <p className="eyebrow">Audit details</p>
            <h2 id="audit-details-title">Event details</h2>
          </div>
          <button ref={closeButton} type="button" className="secondary" onClick={onClose}>
            Close
          </button>
        </div>

        <section aria-label="Action origin" className="audit-origin-details">
          <h3>Origin: {originChannelLabel(event.origin ?? unknownOrigin)}</h3>
          <p>The verified administrator remains the actor. Calling-agent labels describe the caller, not the target Agent. Reported labels are not verified identities.</p>
          <dl>
            <dt>Integration application (authenticated when known)</dt><dd>{event.origin?.integrationClientId ?? "Unknown"}</dd>
            <OriginField label="Calling client ID" field={(event.origin ?? unknownOrigin).client.id} />
            <OriginField label="Calling client name" field={(event.origin ?? unknownOrigin).client.name} />
            <OriginField label="Calling client version" field={(event.origin ?? unknownOrigin).client.version} />
            <OriginField label="Calling agent ID" field={(event.origin ?? unknownOrigin).callingAgent.id} />
            <OriginField label="Calling agent name" field={(event.origin ?? unknownOrigin).callingAgent.name} />
            <dt>API request reference</dt><dd>{event.origin?.requestId ?? "Unknown"}</dd>
            <dt>MCP call reference</dt><dd>{event.origin?.mcpCallId ?? "Unknown"}</dd>
          </dl>
        </section>
        <section className="audit-details-log">
          {hasAuditDetails(event) ? (
            <pre ref={detailsLog} tabIndex={0} aria-label="Recorded audit details">{formatAuditDetailsMessage(event)}</pre>
          ) : (
            <p>No additional details were recorded for this event.</p>
          )}
        </section>
      </section>
    </div>
  );
}

function OriginField({ label, field }: { label: string; field: AttributionField }) {
  return <><dt>{label}</dt><dd>{field.value ?? "Unknown"} <span>({field.evidence})</span></dd></>;
}
function originChannelLabel(origin: AuditOriginV1) {
  return origin.channel === "webapp" ? "Web app" : origin.channel === "mcp" ? "MCP integration" : "Unknown / historical";
}

function AuditMetric({ label, value }: { label: string; value: number | null }) {
  return (
    <article className="metric">
      <span>{label}</span>
      <strong>{value === null ? "Unknown" : value.toLocaleString()}</strong>
    </article>
  );
}

function getAuditAgentDisplayName(
  event: AuditEvent,
  agentNamesById: Map<string, string>,
) {
  return event.agentDisplayName || (isUsageAssociation(event.action) ? undefined : agentNamesById.get(event.agentId));
}

function formatActionGroup(event: AuditEvent) {
  return event.scope === "bulk" ? "Bulk run" : "Single action";
}

function formatAuditAction(action: LocalAuditAction) {
  return auditActionLabels[action];
}

function shortOperationId(operationId: string) {
  return operationId.split("-")[0] || operationId.slice(0, 8);
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
  return (
    summarizeAuditMessage(event.message) ??
    accessMetadataSummary(event) ??
    event.errorCode ??
    (recordedAuditMetadata(event) ? isUsageAssociation(event.action) ? "Usage association evidence" : "Recorded audit evidence" : undefined) ??
    "Details"
  );
}

function fullAuditDetailsMessage(event: AuditEvent) {
  return event.message
    ? extractAuditErrorMessage(event.message)
    : auditDetailsSummary(event);
}

function hasAuditDetails(event: AuditEvent) {
  return Boolean(event.message || event.errorCode || accessMetadata(event) || recordedAuditMetadata(event));
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
  const metadata = accessMetadata(event) ?? recordedAuditMetadata(event);

  if (metadata) {
    return JSON.stringify({
      ...metadata,
      status: event.status,
      ...(event.message ? { message: event.message } : {}),
      ...(event.errorCode ? { errorCode: event.errorCode } : {}),
    }, null, 2);
  }

  return event.message
    ? formatJsonIfParseable(event.message)
    : (event.errorCode ?? "Details");
}

function isUsageAssociation(action: LocalAuditAction) {
  return action === "associate-agent-usage" || action === "remove-agent-usage-association";
}

function recordedAuditMetadata(event: AuditEvent) {
  const metadata = auditMetadata(event.metadata);
  return metadata && Object.keys(metadata).length ? metadata : undefined;
}

function accessMetadata(event: AuditEvent): Record<string, string | number | boolean> | undefined {
  if (
    event.action !== "update-availability" &&
    event.action !== "update-installation"
  ) {
    return undefined;
  }

  return {
    setting:
      event.action === "update-availability" ? "Available to" : "Installed for",
    ...recordedAuditMetadata(event),
  };
}

function accessMetadataSummary(event: AuditEvent) {
  const metadata = accessMetadata(event);

  if (!metadata) {
    return undefined;
  }

  const mode = typeof metadata.mode === "string" ? metadata.mode : "update";
  const scope = typeof metadata.scope === "string" ? metadata.scope : "access";
  return `${mode} ${scope}`;
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
  if (error instanceof Error && error.message) {
    return error.message;
  }

  return "Unable to load audit events.";
}
