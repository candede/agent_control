import { useEffect, useRef, useState } from "react";
import {
  Eye,
  Info,
  Lock,
  LockOpen,
  Mail,
  MailCheck,
  ShieldCheck,
} from "lucide-react";
import type { CopilotPackage } from "../api/client";
import { formatBuiltWithLabel } from "../agentDisplay";

const agentTableColumnStorageKey = "agent-control:agent-table-columns:v1";
const showManageAccessActions = false;

type AgentTableColumnId =
  | "publisher"
  | "host"
  | "builtWith"
  | "availableTo"
  | "created"
  | "creatorType"
  | "usage"
  | "status";

const agentTableColumns: readonly {
  id: AgentTableColumnId;
  label: string;
}[] = [
  { id: "publisher", label: "Publisher" },
  { id: "host", label: "Host" },
  { id: "builtWith", label: "Built with" },
  { id: "availableTo", label: "Available to" },
  { id: "created", label: "Created" },
  { id: "creatorType", label: "Creator type" },
  { id: "usage", label: "Usage" },
  { id: "status", label: "Status" },
];

const defaultVisibleAgentTableColumns = agentTableColumns.map(
  (column) => column.id,
);

const agentTableColumnIds = new Set<AgentTableColumnId>(
  defaultVisibleAgentTableColumns,
);

type AgentTableProps = {
  agents: CopilotPackage[];
  busyAgentId?: string;
  selectedIds: Set<string>;
  recentlyChangedIds: Set<string>;
  selectionDisabled: boolean;
  usageByAgentId: Map<string, AgentTableUsage>;
  allMatchingSelected: boolean;
  selectedCount: number;
  onToggleAgentSelection: (agentId: string) => void;
  onToggleMatchingSelection: () => void;
  onViewDetails: (agent: CopilotPackage) => void;
  onManageAccess: (agent: CopilotPackage) => void;
  onBlock: (agent: CopilotPackage) => void;
  onUnblock: (agent: CopilotPackage) => void;
};

type AgentTableUsage = {
  creatorType: string;
  activeUsersTotal: number;
  responsesSentToUsers: number;
  lastActivityDateUtc?: string;
  userRows: AgentUsageUserRow[];
};

type AgentUsageUserRow = {
  username: string;
};

export function AgentTable({
  agents,
  busyAgentId,
  selectedIds,
  recentlyChangedIds,
  selectionDisabled,
  usageByAgentId,
  allMatchingSelected,
  selectedCount,
  onToggleAgentSelection,
  onToggleMatchingSelection,
  onViewDetails,
  onManageAccess,
  onBlock,
  onUnblock,
}: AgentTableProps) {
  const [columnPickerOpen, setColumnPickerOpen] = useState(false);
  const [visibleColumnIds, setVisibleColumnIds] = useState<
    AgentTableColumnId[]
  >(loadStoredVisibleAgentTableColumns);
  const columnPickerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    saveStoredVisibleAgentTableColumns(visibleColumnIds);
  }, [visibleColumnIds]);

  useEffect(() => {
    if (!columnPickerOpen) {
      return;
    }

    function handlePointerDown(event: PointerEvent) {
      if (
        columnPickerRef.current &&
        !columnPickerRef.current.contains(event.target as Node)
      ) {
        setColumnPickerOpen(false);
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setColumnPickerOpen(false);
      }
    }

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [columnPickerOpen]);

  const visibleColumns = new Set(visibleColumnIds);
  const columnCountClassName = `agent-table-columns-${visibleColumnIds.length}`;

  function toggleColumnPickerOpen() {
    setColumnPickerOpen((isOpen) => !isOpen);
  }

  function isColumnVisible(columnId: AgentTableColumnId) {
    return visibleColumns.has(columnId);
  }

  function toggleColumn(columnId: AgentTableColumnId) {
    setVisibleColumnIds((currentColumnIds) =>
      currentColumnIds.includes(columnId)
        ? currentColumnIds.filter(
            (currentColumnId) => currentColumnId !== columnId,
          )
        : [
            ...agentTableColumns
              .map((column) => column.id)
              .filter(
                (currentColumnId) =>
                  currentColumnId === columnId ||
                  currentColumnIds.includes(currentColumnId),
              ),
          ],
    );
  }

  if (agents.length === 0) {
    return (
      <div className="empty-state">
        <h2>No matching agents</h2>
        <p>Try clearing the search or filters.</p>
      </div>
    );
  }

  return (
    <div className="table-shell" role="region" aria-label="Copilot agents">
      <div className="selection-summary">
        <span>{selectedCount} selected</span>
      </div>
      <table className={`agent-table ${columnCountClassName}`}>
        <thead>
          <tr>
            <th scope="col" className="select-cell">
              <input
                type="checkbox"
                aria-label="Select all matching agents"
                checked={allMatchingSelected}
                disabled={selectionDisabled || agents.length === 0}
                onChange={onToggleMatchingSelection}
              />
            </th>
            <th scope="col">Agent</th>
            {isColumnVisible("publisher") ? (
              <th scope="col">Publisher</th>
            ) : null}
            {isColumnVisible("host") ? <th scope="col">Host</th> : null}
            {isColumnVisible("builtWith") ? (
              <th scope="col">Built with</th>
            ) : null}
            {isColumnVisible("availableTo") ? (
              <th scope="col">Available to</th>
            ) : null}
            {isColumnVisible("created") ? <th scope="col">Created</th> : null}
            {isColumnVisible("creatorType") ? (
              <th scope="col">Creator type</th>
            ) : null}
            {isColumnVisible("usage") ? <th scope="col">Usage</th> : null}
            {isColumnVisible("status") ? <th scope="col">Status</th> : null}
            <th scope="col">
              <div className="action-header">
                <span>Action</span>
                <div className="column-view-menu" ref={columnPickerRef}>
                  {columnPickerOpen ? (
                    <button
                      type="button"
                      className="secondary column-view-button"
                      aria-haspopup="dialog"
                      aria-expanded="true"
                      onClick={toggleColumnPickerOpen}
                    >
                      <Eye aria-hidden="true" />
                      View
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="secondary column-view-button"
                      aria-haspopup="dialog"
                      aria-expanded="false"
                      onClick={toggleColumnPickerOpen}
                    >
                      <Eye aria-hidden="true" />
                      View
                    </button>
                  )}
                  {columnPickerOpen ? (
                    <div
                      className="column-view-popover"
                      role="dialog"
                      aria-label="Choose table columns"
                    >
                      <div className="column-view-popover-header">
                        <strong>Columns</strong>
                        <button
                          type="button"
                          className="secondary column-reset-button"
                          onClick={() =>
                            setVisibleColumnIds(defaultVisibleAgentTableColumns)
                          }
                        >
                          Reset
                        </button>
                      </div>
                      <div className="column-view-options">
                        {agentTableColumns.map((column) => (
                          <label key={column.id} className="column-view-option">
                            <input
                              type="checkbox"
                              checked={isColumnVisible(column.id)}
                              onChange={() => toggleColumn(column.id)}
                            />
                            <span>{column.label}</span>
                          </label>
                        ))}
                      </div>
                    </div>
                  ) : null}
                </div>
              </div>
            </th>
          </tr>
        </thead>
        <tbody>
          {agents.map((agent) => {
            const busy = busyAgentId === agent.id;
            const selected = selectedIds.has(agent.id);
            const recentlyChanged = recentlyChangedIds.has(agent.id);
            const usage = usageByAgentId.get(agent.id);

            return (
              <tr
                key={agent.id}
                className={recentlyChanged ? "agent-state-changed" : undefined}
              >
                <td className="select-cell">
                  <input
                    type="checkbox"
                    aria-label={`Select ${agent.displayName}`}
                    checked={selected}
                    disabled={selectionDisabled}
                    onChange={() => onToggleAgentSelection(agent.id)}
                  />
                </td>
                <td>
                  <div className="agent-name">{agent.displayName}</div>
                  <div className="agent-description">
                    {agent.shortDescription || agent.id}
                  </div>
                </td>
                {isColumnVisible("publisher") ? (
                  <td>{agent.publisher || "Unknown"}</td>
                ) : null}
                {isColumnVisible("host") ? (
                  <td>{formatList(agent.supportedHosts)}</td>
                ) : null}
                {isColumnVisible("builtWith") ? (
                  <td>{formatBuiltWithLabel(agent)}</td>
                ) : null}
                {isColumnVisible("availableTo") ? (
                  <td>{formatLabel(agent.availableTo)}</td>
                ) : null}
                {isColumnVisible("created") ? (
                  <td>{formatDate(agent.createdDateTime)}</td>
                ) : null}
                {isColumnVisible("creatorType") ? (
                  <td>{usage?.creatorType || "No import"}</td>
                ) : null}
                {isColumnVisible("usage") ? (
                  <td>
                    <UsageCell usage={usage} />
                  </td>
                ) : null}
                {isColumnVisible("status") ? (
                  <td>
                    <span
                      className={`status-carousel ${
                        agent.isBlocked ? "show-blocked" : "show-allowed"
                      }`}
                      aria-label={`Status: ${
                        agent.isBlocked ? "Blocked" : "Allowed"
                      }`}
                    >
                      <span
                        className="status-carousel-track"
                        aria-hidden="true"
                      >
                        <span className="status allowed">Allowed</span>
                        <span className="status blocked">Blocked</span>
                      </span>
                    </span>
                  </td>
                ) : null}
                <td>
                  <div className="row-actions">
                    <button
                      className="icon-button"
                      type="button"
                      aria-label={`View details for ${agent.displayName}`}
                      title="View details"
                      disabled={selectionDisabled}
                      onClick={() => onViewDetails(agent)}
                    >
                      <Info aria-hidden="true" />
                    </button>
                    {showManageAccessActions ? (
                      <button
                        className="icon-button"
                        type="button"
                        aria-label={`Manage access for ${agent.displayName}`}
                        title="Manage access"
                        disabled={selectionDisabled}
                        onClick={() => onManageAccess(agent)}
                      >
                        <ShieldCheck aria-hidden="true" />
                      </button>
                    ) : null}
                    {agent.isBlocked ? (
                      <button
                        className="icon-button"
                        type="button"
                        aria-label={`Unblock ${agent.displayName}`}
                        title={busy ? "Updating status" : "Unblock"}
                        disabled={busy || selectionDisabled}
                        onClick={() => onUnblock(agent)}
                      >
                        <LockOpen aria-hidden="true" />
                      </button>
                    ) : (
                      <button
                        className="icon-button danger"
                        type="button"
                        aria-label={`Block ${agent.displayName}`}
                        title={busy ? "Updating status" : "Block"}
                        disabled={busy || selectionDisabled}
                        onClick={() => onBlock(agent)}
                      >
                        <Lock aria-hidden="true" />
                      </button>
                    )}
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

function loadStoredVisibleAgentTableColumns(): AgentTableColumnId[] {
  if (typeof window === "undefined") {
    return defaultVisibleAgentTableColumns;
  }

  try {
    const storedColumns = window.localStorage.getItem(
      agentTableColumnStorageKey,
    );

    if (!storedColumns) {
      return defaultVisibleAgentTableColumns;
    }

    const parsedColumns: unknown = JSON.parse(storedColumns);

    if (!Array.isArray(parsedColumns)) {
      return defaultVisibleAgentTableColumns;
    }

    return agentTableColumns
      .map((column) => column.id)
      .filter((columnId) =>
        parsedColumns.some(
          (parsedColumnId) =>
            parsedColumnId === columnId &&
            agentTableColumnIds.has(parsedColumnId),
        ),
      );
  } catch {
    return defaultVisibleAgentTableColumns;
  }
}

function saveStoredVisibleAgentTableColumns(columnIds: AgentTableColumnId[]) {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.setItem(
      agentTableColumnStorageKey,
      JSON.stringify(columnIds),
    );
  } catch {
    // Table view preferences are best effort only.
  }
}

function UsageCell({ usage }: { usage?: AgentTableUsage }) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">(
    "idle",
  );
  const resetTimerId = useRef<number | undefined>(undefined);

  useEffect(
    () => () => {
      if (resetTimerId.current) {
        window.clearTimeout(resetTimerId.current);
      }
    },
    [],
  );

  if (!usage) {
    return <span className="muted-cell">No import</span>;
  }

  const userEmails = uniqueUserEmails(usage.userRows);

  async function copyUserEmails() {
    if (userEmails.length === 0) {
      return;
    }

    try {
      await navigator.clipboard.writeText(userEmails.join("; "));
      scheduleCopyStateReset("copied", 1800);
    } catch {
      scheduleCopyStateReset("failed", 2400);
    }
  }

  function scheduleCopyStateReset(
    nextState: "copied" | "failed",
    timeoutMs: number,
  ) {
    if (resetTimerId.current) {
      window.clearTimeout(resetTimerId.current);
    }

    setCopyState(nextState);
    resetTimerId.current = window.setTimeout(() => {
      resetTimerId.current = undefined;
      setCopyState("idle");
    }, timeoutMs);
  }

  return (
    <dl className="usage-cell">
      <div>
        <dt>Last</dt>
        <dd>{formatUsageDate(usage.lastActivityDateUtc)}</dd>
      </div>
      <div>
        <dt>Users</dt>
        <dd className="usage-value-with-action">
          <span>{formatNumber(usage.activeUsersTotal)}</span>
          {userEmails.length > 0 ? (
            <button
              className="icon-button usage-copy-button"
              type="button"
              aria-label={copyStateLabel(copyState, userEmails.length)}
              title={copyStateLabel(copyState, userEmails.length)}
              onClick={() => void copyUserEmails()}
            >
              {copyState === "copied" ? <MailCheck /> : <Mail />}
            </button>
          ) : null}
        </dd>
      </div>
      <div>
        <dt>Resp</dt>
        <dd>{formatNumber(usage.responsesSentToUsers)}</dd>
      </div>
    </dl>
  );
}

function uniqueUserEmails(rows: AgentUsageUserRow[]) {
  return [
    ...new Set(
      rows.map((row) => row.username.trim().toLowerCase()).filter(Boolean),
    ),
  ].sort((first, second) => first.localeCompare(second));
}

function copyStateLabel(state: "idle" | "copied" | "failed", count: number) {
  if (state === "copied") {
    return `Copied ${count} user email${count === 1 ? "" : "s"}`;
  }

  if (state === "failed") {
    return "Could not copy user emails";
  }

  return `Copy ${count} user email${count === 1 ? "" : "s"} for Outlook`;
}

function formatList(values?: string[]) {
  if (!values?.length) {
    return "Unknown";
  }

  return values.slice(0, 3).join(", ");
}

function formatLabel(value?: string) {
  if (!value) {
    return "Unknown";
  }

  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim();
}

function formatUsageDate(value?: string) {
  if (!value) {
    return "No import";
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeZone: "UTC",
  }).format(new Date(value));
}

function formatDate(value?: string) {
  if (!value) {
    return "Unknown";
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "Unknown";
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeZone: "UTC",
  }).format(date);
}

function formatNumber(value?: number) {
  return value === undefined ? "No import" : value.toLocaleString();
}
