import { useEffect, useRef, useState } from "react";
import { Info, Mail, MailCheck } from "lucide-react";
import type { CopilotPackage } from "../api/client";
import { formatBuiltWithLabel } from "../agentDisplay";

type AgentTableProps = {
  agents: CopilotPackage[];
  busyAgentId?: string;
  selectedIds: Set<string>;
  recentlyChangedIds: Set<string>;
  selectionDisabled: boolean;
  usageByAgentId: Map<string, AgentTableUsage>;
  allVisibleSelected: boolean;
  selectedCount: number;
  onToggleAgentSelection: (agentId: string) => void;
  onToggleVisibleSelection: () => void;
  onViewDetails: (agent: CopilotPackage) => void;
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
  allVisibleSelected,
  selectedCount,
  onToggleAgentSelection,
  onToggleVisibleSelection,
  onViewDetails,
  onBlock,
  onUnblock,
}: AgentTableProps) {
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
      <table>
        <thead>
          <tr>
            <th scope="col" className="select-cell">
              <input
                type="checkbox"
                aria-label="Select all visible agents"
                checked={allVisibleSelected}
                disabled={selectionDisabled || agents.length === 0}
                onChange={onToggleVisibleSelection}
              />
            </th>
            <th scope="col">Agent</th>
            <th scope="col">Publisher</th>
            <th scope="col">Host</th>
            <th scope="col">Built with</th>
            <th scope="col">Available to</th>
            <th scope="col">Creator type</th>
            <th scope="col">Usage</th>
            <th scope="col">Status</th>
            <th scope="col">Action</th>
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
                <td>{agent.publisher || "Unknown"}</td>
                <td>{formatList(agent.supportedHosts)}</td>
                <td>{formatBuiltWithLabel(agent)}</td>
                <td>{formatLabel(agent.availableTo)}</td>
                <td>{usage?.creatorType || "No import"}</td>
                <td>
                  <UsageCell usage={usage} />
                </td>
                <td>
                  <span
                    className={`status-carousel ${
                      agent.isBlocked ? "show-blocked" : "show-allowed"
                    }`}
                    aria-label={`Status: ${
                      agent.isBlocked ? "Blocked" : "Allowed"
                    }`}
                  >
                    <span className="status-carousel-track" aria-hidden="true">
                      <span className="status allowed">Allowed</span>
                      <span className="status blocked">Blocked</span>
                    </span>
                  </span>
                </td>
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
                    {agent.isBlocked ? (
                      <button
                        type="button"
                        disabled={busy || selectionDisabled}
                        onClick={() => onUnblock(agent)}
                      >
                        {busy ? "Working" : "Unblock"}
                      </button>
                    ) : (
                      <button
                        className="danger"
                        type="button"
                        disabled={busy || selectionDisabled}
                        onClick={() => onBlock(agent)}
                      >
                        {busy ? "Working" : "Block"}
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

function formatNumber(value?: number) {
  return value === undefined ? "No import" : value.toLocaleString();
}
