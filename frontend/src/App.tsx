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
  const [ownershipFilter, setOwnershipFilter] =
    useState<OwnershipFilter>("all");
  const [companyPublisher, setCompanyPublisher] = useState("");
  const [selectedAgentIds, setSelectedAgentIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [busyAgentId, setBusyAgentId] = useState<string>();
  const [busyBulkAction, setBusyBulkAction] = useState<"block" | "unblock">();
  const [bulkProgress, setBulkProgress] = useState<BulkProgress>();
  const [bulkResult, setBulkResult] = useState<BulkActionResult>();
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

  const companyPublisherKeyword = useMemo(
    () =>
      normalizeCompanyValue(companyPublisher) ||
      inferCompanyKeyword(user?.username),
    [companyPublisher, user?.username],
  );

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
      const companyDeveloped = isCompanyDevelopedAgent(
        agent,
        companyPublisherKeyword,
      );
      const matchesOwnership =
        ownershipFilter === "all" ||
        (ownershipFilter === "company" && companyDeveloped) ||
        (ownershipFilter === "thirdParty" && !companyDeveloped);

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
        matchesOwnership &&
        (!normalizedQuery || searchableText.includes(normalizedQuery))
      );
    });
  }, [
    agents,
    companyPublisherKeyword,
    deferredQuery,
    ownershipFilter,
    publisherFilter,
    statusFilter,
  ]);

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

  async function handleBulkAction(targetBlockedState: boolean) {
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
    const confirmed = window.confirm(
      `This will ${label} ${candidates.length} selected Copilot agents. ${skipped.length} selected agents already match the target state and will be skipped. Continue?`,
    );

    if (!confirmed) {
      return;
    }

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
        onBlockAll={() => void handleBulkAction(true)}
        onUnblockAll={() => void handleBulkAction(false)}
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
        <label>
          <span>Developed by</span>
          <select
            value={ownershipFilter}
            onChange={(event) =>
              setOwnershipFilter(event.target.value as OwnershipFilter)
            }
          >
            <option value="all">All developers</option>
            <option value="company">Your company</option>
            <option value="thirdParty">Third party</option>
          </select>
        </label>
        <label>
          <span>Company publisher</span>
          <input
            type="search"
            value={companyPublisher}
            onChange={(event) => setCompanyPublisher(event.target.value)}
            placeholder={companyPublisherKeyword || "Contoso"}
          />
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
    </main>
  );
}

const unknownPublisherValue = "__unknown__";

type OwnershipFilter = "all" | "company" | "thirdParty";

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

function wait(milliseconds: number) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

function isCompanyDevelopedAgent(
  agent: CopilotPackage,
  companyPublisherKeyword: string,
) {
  if (!companyPublisherKeyword) {
    return false;
  }

  return normalizeCompanyValue(agent.publisher).includes(
    companyPublisherKeyword,
  );
}

function inferCompanyKeyword(username?: string) {
  const domain = username?.split("@")[1];

  if (!domain) {
    return "";
  }

  const labels = domain.toLowerCase().split(".").filter(Boolean);

  if (labels.length === 0) {
    return "";
  }

  if (domain.toLowerCase().endsWith(".onmicrosoft.com")) {
    return normalizeCompanyValue(labels[0]);
  }

  return normalizeCompanyValue(labels.at(-2) ?? labels[0]);
}

function normalizeCompanyValue(value?: string) {
  return value?.trim().toLowerCase() ?? "";
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
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
