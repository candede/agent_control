import { useDeferredValue, useEffect, useMemo, useState } from "react";
import {
  ApiError,
  blockAgent,
  getAgents,
  getCurrentUser,
  signOut,
  unblockAgent,
  type BulkPackageResult,
  type BulkActionResult,
  type CopilotPackage,
  type SessionUser,
} from "./api/client";
import "./App.css";
import { AgentTable } from "./components/AgentTable";
import { BulkActions } from "./components/BulkActions";

function App() {
  const [user, setUser] = useState<SessionUser>();
  const [agents, setAgents] = useState<CopilotPackage[]>([]);
  const [loadingSession, setLoadingSession] = useState(true);
  const [loadingAgents, setLoadingAgents] = useState(false);
  const [error, setError] = useState<string>();
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<
    "all" | "allowed" | "blocked"
  >("all");
  const [publisherFilter, setPublisherFilter] = useState("all");
  const [selectedAgentIds, setSelectedAgentIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [busyAgentId, setBusyAgentId] = useState<string>();
  const [busyBulkAction, setBusyBulkAction] = useState<"block" | "unblock">();
  const [bulkProgress, setBulkProgress] = useState<BulkProgress>();
  const [bulkResult, setBulkResult] = useState<BulkActionResult>();
  const [bulkConfirmation, setBulkConfirmation] = useState<BulkConfirmation>();
  const deferredQuery = useDeferredValue(query);

  useEffect(() => {
    void loadSession();
  }, []);

  useEffect(() => {
    if (user) {
      void loadAgents();
    }
  }, [user]);

  const publisherOptions = useMemo(() => {
    const publishers = new Map<string, string>();

    for (const agent of agents) {
      const label = agent.publisher || "Unknown";
      const value = agent.publisher || unknownPublisherValue;
      publishers.set(value, label);
    }

    return [...publishers]
      .map(([value, label]) => ({ value, label }))
      .sort((first, second) => first.label.localeCompare(second.label));
  }, [agents]);

  const filteredAgents = useMemo(() => {
    const normalizedQuery = deferredQuery.trim().toLowerCase();

    return agents.filter((agent) => {
      const matchesStatus =
        statusFilter === "all" ||
        (statusFilter === "blocked" && agent.isBlocked) ||
        (statusFilter === "allowed" && !agent.isBlocked);
      const matchesPublisher =
        publisherFilter === "all" ||
        agent.publisher === publisherFilter ||
        (!agent.publisher && publisherFilter === unknownPublisherValue);

      const searchableText = [
        agent.displayName,
        agent.shortDescription,
        agent.publisher,
        agent.id,
        agent.supportedHosts?.join(" "),
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();

      return (
        matchesStatus &&
        matchesPublisher &&
        (!normalizedQuery || searchableText.includes(normalizedQuery))
      );
    });
  }, [agents, deferredQuery, publisherFilter, statusFilter]);

  const selectedAgents = useMemo(
    () => agents.filter((agent) => selectedAgentIds.has(agent.id)),
    [agents, selectedAgentIds],
  );

  const visibleSelectedCount = filteredAgents.filter((agent) =>
    selectedAgentIds.has(agent.id),
  ).length;
  const allVisibleSelected =
    filteredAgents.length > 0 && visibleSelectedCount === filteredAgents.length;

  async function loadSession() {
    setLoadingSession(true);
    setError(undefined);

    try {
      const session = await getCurrentUser();
      setUser(session.user);
    } catch (requestError) {
      if (!(requestError instanceof ApiError && requestError.status === 401)) {
        setError(errorMessage(requestError));
      }
    } finally {
      setLoadingSession(false);
    }
  }

  async function loadAgents() {
    setLoadingAgents(true);
    setError(undefined);

    try {
      const response = await getAgents();
      setAgents(response.value);
      setSelectedAgentIds((current) => {
        const availableIds = new Set(response.value.map((agent) => agent.id));
        const next = new Set(
          [...current].filter((agentId) => availableIds.has(agentId)),
        );

        return next.size === current.size ? current : next;
      });
    } catch (requestError) {
      setError(errorMessage(requestError));
    } finally {
      setLoadingAgents(false);
    }
  }

  async function handleSignOut() {
    await signOut();
    setUser(undefined);
    setAgents([]);
    setSelectedAgentIds(new Set());
    setBulkConfirmation(undefined);
    setBulkResult(undefined);
  }

  async function handleAgentAction(
    agent: CopilotPackage,
    targetBlockedState: boolean,
  ) {
    setBusyAgentId(agent.id);
    setError(undefined);
    setBulkResult(undefined);

    try {
      if (targetBlockedState) {
        await blockAgent(agent.id);
      } else {
        await unblockAgent(agent.id);
      }

      await loadAgents();
    } catch (requestError) {
      setError(errorMessage(requestError));
    } finally {
      setBusyAgentId(undefined);
    }
  }

  function requestBulkAction(targetBlockedState: boolean) {
    const label = targetBlockedState ? "block" : "unblock";
    const scope = selectedAgents;

    if (scope.length === 0) {
      setError("Select one or more agents before running a bulk action.");
      return;
    }

    const candidates = scope.filter(
      (agent) => agent.isBlocked !== targetBlockedState,
    );
    const skipped = scope.filter(
      (agent) => agent.isBlocked === targetBlockedState,
    );

    setError(undefined);
    setBulkConfirmation({
      action: label,
      targetBlockedState,
      scope,
      actionableCount: candidates.length,
      skippedCount: skipped.length,
    });
  }

  async function runConfirmedBulkAction(confirmation: BulkConfirmation) {
    const { action: label, scope, targetBlockedState } = confirmation;
    const candidates = scope.filter(
      (agent) => agent.isBlocked !== targetBlockedState,
    );
    const skipped = scope.filter(
      (agent) => agent.isBlocked === targetBlockedState,
    );

    setBulkConfirmation(undefined);

    setBusyBulkAction(label);
    setBulkProgress({
      action: label,
      targetBlockedState,
      total: scope.length,
      completed: skipped.length,
      succeeded: 0,
      failed: 0,
      skipped: skipped.length,
    });
    setError(undefined);
    setBulkResult(undefined);

    const results: BulkPackageResult[] = skipped.map((agent) => ({
      id: agent.id,
      displayName: agent.displayName,
      status: "skipped",
      message: targetBlockedState ? "Already blocked" : "Already unblocked",
    }));
    let succeeded = 0;
    let failed = 0;

    try {
      for (const [index, agent] of candidates.entries()) {
        setBulkProgress((current) =>
          current
            ? {
                ...current,
                currentAgentName: agent.displayName,
              }
            : current,
        );

        try {
          if (targetBlockedState) {
            await blockAgent(agent.id);
          } else {
            await unblockAgent(agent.id);
          }

          succeeded += 1;
          results.push({
            id: agent.id,
            displayName: agent.displayName,
            status: "succeeded",
          });
          setAgents((currentAgents) =>
            currentAgents.map((currentAgent) =>
              currentAgent.id === agent.id
                ? { ...currentAgent, isBlocked: targetBlockedState }
                : currentAgent,
            ),
          );
        } catch (requestError) {
          failed += 1;
          results.push({
            id: agent.id,
            displayName: agent.displayName,
            status: "failed",
            message: errorMessage(requestError),
          });
        }

        setBulkProgress((current) =>
          current
            ? {
                ...current,
                completed: skipped.length + index + 1,
                succeeded,
                failed,
              }
            : current,
        );

        if (index < candidates.length - 1) {
          await wait(750);
        }
      }

      setBulkResult({
        targetBlockedState,
        total: scope.length,
        succeeded,
        failed,
        skipped: skipped.length,
        results,
      });
      await loadAgents();
      setSelectedAgentIds(
        new Set(
          results
            .filter((result) => result.status === "failed")
            .map((result) => result.id),
        ),
      );
    } catch (requestError) {
      setError(errorMessage(requestError));
    } finally {
      setBusyBulkAction(undefined);
      setBulkProgress(undefined);
    }
  }

  function toggleAgentSelection(agentId: string) {
    setSelectedAgentIds((current) => {
      const next = new Set(current);

      if (next.has(agentId)) {
        next.delete(agentId);
      } else {
        next.add(agentId);
      }

      return next;
    });
  }

  function toggleVisibleSelection(visibleAgents: CopilotPackage[]) {
    setSelectedAgentIds((current) => {
      const next = new Set(current);
      const visibleIds = visibleAgents.map((agent) => agent.id);
      const allSelected = visibleIds.every((agentId) => next.has(agentId));

      for (const agentId of visibleIds) {
        if (allSelected) {
          next.delete(agentId);
        } else {
          next.add(agentId);
        }
      }

      return next;
    });
  }

  if (loadingSession) {
    return <main className="screen-state">Checking sign-in...</main>;
  }

  if (!user) {
    return (
      <main className="signed-out">
        <section className="signin-panel">
          <p className="eyebrow">Microsoft 365 Copilot administration</p>
          <h1>Agent Control</h1>
          <p>
            Sign in with a work or school account that has delegated access to
            manage Copilot packages.
          </p>
          {error ? <div className="error-banner">{error}</div> : null}
          <a className="primary-link" href="/auth/login">
            Sign in with Entra ID
          </a>
        </section>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <header className="top-bar">
        <div>
          <p className="eyebrow">Tenant package controls</p>
          <h1>Copilot agents</h1>
        </div>
        <div className="user-menu">
          <span>{user.displayName || user.username}</span>
          <button type="button" onClick={() => void handleSignOut()}>
            Sign out
          </button>
        </div>
      </header>

      {error ? <div className="error-banner">{error}</div> : null}

      <section className="summary-grid" aria-label="Agent summary">
        <Metric label="Total" value={agents.length} />
        <Metric
          label="Allowed"
          value={agents.filter((agent) => !agent.isBlocked).length}
        />
        <Metric
          label="Blocked"
          value={agents.filter((agent) => agent.isBlocked).length}
        />
        <Metric label="Visible" value={filteredAgents.length} />
      </section>

      <BulkActions
        disabled={
          loadingAgents || Boolean(busyAgentId) || Boolean(busyBulkAction)
        }
        busyAction={busyBulkAction}
        progress={bulkProgress}
        result={bulkResult}
        selectedCount={selectedAgentIds.size}
        onBlockAll={() => requestBulkAction(true)}
        onUnblockAll={() => requestBulkAction(false)}
      />

      <section className="controls" aria-label="Filters">
        <label>
          <span>Search</span>
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Name, publisher, ID"
          />
        </label>
        <label>
          <span>Status</span>
          <select
            value={statusFilter}
            onChange={(event) =>
              setStatusFilter(
                event.target.value as "all" | "allowed" | "blocked",
              )
            }
          >
            <option value="all">All</option>
            <option value="allowed">Allowed</option>
            <option value="blocked">Blocked</option>
          </select>
        </label>
        <label>
          <span>Publisher</span>
          <select
            value={publisherFilter}
            onChange={(event) => setPublisherFilter(event.target.value)}
          >
            <option value="all">All publishers</option>
            {publisherOptions.map((publisher) => (
              <option key={publisher.value} value={publisher.value}>
                {publisher.label}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          disabled={loadingAgents}
          onClick={() => void loadAgents()}
        >
          {loadingAgents ? "Refreshing" : "Refresh"}
        </button>
      </section>

      {loadingAgents ? (
        <div className="screen-state">Loading Copilot agents...</div>
      ) : (
        <AgentTable
          agents={filteredAgents}
          busyAgentId={busyAgentId}
          selectedIds={selectedAgentIds}
          selectionDisabled={Boolean(busyBulkAction)}
          allVisibleSelected={allVisibleSelected}
          selectedCount={selectedAgentIds.size}
          onToggleAgentSelection={toggleAgentSelection}
          onToggleVisibleSelection={() =>
            toggleVisibleSelection(filteredAgents)
          }
          onBlock={(agent) => void handleAgentAction(agent, true)}
          onUnblock={(agent) => void handleAgentAction(agent, false)}
        />
      )}

      {bulkConfirmation ? (
        <BulkConfirmModal
          confirmation={bulkConfirmation}
          onCancel={() => setBulkConfirmation(undefined)}
          onConfirm={() => void runConfirmedBulkAction(bulkConfirmation)}
        />
      ) : null}
    </main>
  );
}

const unknownPublisherValue = "__unknown__";

type BulkProgress = {
  action: "block" | "unblock";
  targetBlockedState: boolean;
  total: number;
  completed: number;
  succeeded: number;
  failed: number;
  skipped: number;
  currentAgentName?: string;
};

type BulkConfirmation = {
  action: "block" | "unblock";
  targetBlockedState: boolean;
  scope: CopilotPackage[];
  actionableCount: number;
  skippedCount: number;
};

function wait(milliseconds: number) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function BulkConfirmModal({
  confirmation,
  onCancel,
  onConfirm,
}: {
  confirmation: BulkConfirmation;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const actionLabel = confirmation.targetBlockedState ? "Block" : "Unblock";
  const sampleAgents = confirmation.scope.slice(0, 4);
  const hiddenCount = Math.max(
    0,
    confirmation.scope.length - sampleAgents.length,
  );

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onCancel();
      }
    }

    window.addEventListener("keydown", handleKeyDown);

    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onCancel]);

  return (
    <div className="modal-backdrop" role="presentation" onClick={onCancel}>
      <section
        className="confirm-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="bulk-confirm-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div>
          <p className="eyebrow">Confirm bulk change</p>
          <h2 id="bulk-confirm-title">{actionLabel} selected agents?</h2>
        </div>
        <p>
          This will {confirmation.action} {confirmation.actionableCount}{" "}
          selected Copilot agents. {confirmation.skippedCount} selected agents
          already match the target state and will be skipped.
        </p>
        <div className="confirm-summary" aria-label="Bulk action summary">
          <span>
            <strong>{confirmation.scope.length}</strong> selected
          </span>
          <span>
            <strong>{confirmation.actionableCount}</strong> to change
          </span>
          <span>
            <strong>{confirmation.skippedCount}</strong> skipped
          </span>
        </div>
        <ul className="confirm-agent-list" aria-label="Selected agents preview">
          {sampleAgents.map((agent) => (
            <li key={agent.id}>
              <span>{agent.displayName}</span>
              <small>{agent.publisher || "Unknown publisher"}</small>
            </li>
          ))}
        </ul>
        {hiddenCount > 0 ? (
          <p className="confirm-muted">
            {hiddenCount} more selected agents are included.
          </p>
        ) : null}
        <div className="confirm-actions">
          <button type="button" className="secondary" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className={confirmation.targetBlockedState ? "danger" : undefined}
            onClick={onConfirm}
          >
            {actionLabel} selected
          </button>
        </div>
      </section>
    </div>
  );
}

function errorMessage(error: unknown) {
  if (error instanceof ApiError) {
    if (error.status === 403) {
      return `${error.message} Confirm admin consent for delegated CopilotPackages.ReadWrite.All and the signed-in user's admin role.`;
    }

    if (error.status === 503) {
      return `${error.message} Copy .env.example to .env and fill in the Entra app registration values.`;
    }

    return error.message;
  }

  if (error instanceof Error) {
    return error.message;
  }

  return "An unexpected error occurred.";
}

export default App;
