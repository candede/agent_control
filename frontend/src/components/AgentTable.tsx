import type { CopilotPackage } from "../api/client";
import { formatBuiltWithLabel } from "../agentDisplay";

type AgentTableProps = {
  agents: CopilotPackage[];
  busyAgentId?: string;
  selectedIds: Set<string>;
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
};

export function AgentTable({
  agents,
  busyAgentId,
  selectedIds,
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
            const usage = usageByAgentId.get(agent.id);

            return (
              <tr key={agent.id}>
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
                    className={
                      agent.isBlocked ? "status blocked" : "status allowed"
                    }
                  >
                    {agent.isBlocked ? "Blocked" : "Allowed"}
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
                      <InfoIcon />
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
  if (!usage) {
    return <span className="muted-cell">No import</span>;
  }

  return (
    <dl className="usage-cell">
      <div>
        <dt>Last</dt>
        <dd>{formatUsageDate(usage.lastActivityDateUtc)}</dd>
      </div>
      <div>
        <dt>Users</dt>
        <dd>{formatNumber(usage.activeUsersTotal)}</dd>
      </div>
      <div>
        <dt>Resp</dt>
        <dd>{formatNumber(usage.responsesSentToUsers)}</dd>
      </div>
    </dl>
  );
}

function InfoIcon() {
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
      <circle cx="12" cy="12" r="10" />
      <path d="M12 16v-4" />
      <path d="M12 8h.01" />
    </svg>
  );
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
