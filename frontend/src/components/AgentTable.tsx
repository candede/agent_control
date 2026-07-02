import type { CopilotPackage } from "../api/client";

type AgentTableProps = {
  agents: CopilotPackage[];
  busyAgentId?: string;
  selectedIds: Set<string>;
  selectionDisabled: boolean;
  allVisibleSelected: boolean;
  selectedCount: number;
  onToggleAgentSelection: (agentId: string) => void;
  onToggleVisibleSelection: () => void;
  onBlock: (agent: CopilotPackage) => void;
  onUnblock: (agent: CopilotPackage) => void;
};

export function AgentTable({
  agents,
  busyAgentId,
  selectedIds,
  selectionDisabled,
  allVisibleSelected,
  selectedCount,
  onToggleAgentSelection,
  onToggleVisibleSelection,
  onBlock,
  onUnblock,
}: AgentTableProps) {
  if (agents.length === 0) {
    return (
      <div className="empty-state">
        <h2>No matching agents</h2>
        <p>Try clearing the search or status filter.</p>
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
            <th scope="col">Deployment</th>
            <th scope="col">Status</th>
            <th scope="col">Action</th>
          </tr>
        </thead>
        <tbody>
          {agents.map((agent) => {
            const busy = busyAgentId === agent.id;
            const selected = selectedIds.has(agent.id);

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
                <td>{agent.deployedTo || "Unknown"}</td>
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
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function formatList(values?: string[]) {
  if (!values?.length) {
    return "Unknown";
  }

  return values.slice(0, 3).join(", ");
}
