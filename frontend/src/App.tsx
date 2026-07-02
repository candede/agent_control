import { useDeferredValue, useEffect, useMemo, useState } from "react";
import {
  ApiError,
  blockAgent,
  getAgentDetails,
  getAgents,
  getCurrentUser,
  signOut,
  unblockAgent,
  type BulkPackageResult,
  type BulkActionResult,
  type CopilotPackage,
  type CopilotPackageDetail,
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
  const [hostFilter, setHostFilter] = useState("all");
  const [platformFilter, setPlatformFilter] = useState("all");
  const [selectedAgentIds, setSelectedAgentIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [busyAgentId, setBusyAgentId] = useState<string>();
  const [busyBulkAction, setBusyBulkAction] = useState<"block" | "unblock">();
  const [bulkProgress, setBulkProgress] = useState<BulkProgress>();
  const [bulkResult, setBulkResult] = useState<BulkActionResult>();
  const [bulkConfirmation, setBulkConfirmation] = useState<BulkConfirmation>();
  const [agentDetail, setAgentDetail] = useState<CopilotPackageDetail>();
  const [loadingAgentDetailId, setLoadingAgentDetailId] = useState<string>();
  const [agentDetailError, setAgentDetailError] = useState<string>();
  const [exportingCsv, setExportingCsv] = useState(false);
  const [exportProgress, setExportProgress] = useState(0);
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

  const hostOptions = useMemo(() => {
    const hosts = new Map<string, string>();

    for (const agent of agents) {
      for (const host of agent.supportedHosts ?? []) {
        hosts.set(host, formatHostLabel(host));
      }
    }

    return [...hosts]
      .map(([value, label]) => ({ value, label }))
      .sort((first, second) => first.label.localeCompare(second.label));
  }, [agents]);

  const platformOptions = useMemo(() => {
    const platforms = new Map<string, string>();

    for (const agent of agents) {
      if (agent.platform) {
        platforms.set(agent.platform, formatPlatformLabel(agent.platform));
      }
    }

    return [...platforms]
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
      const matchesHost =
        hostFilter === "all" || agent.supportedHosts?.includes(hostFilter);
      const matchesPlatform =
        platformFilter === "all" || agent.platform === platformFilter;

      const searchableText = [
        agent.displayName,
        agent.shortDescription,
        agent.publisher,
        agent.platform,
        agent.id,
        agent.supportedHosts?.join(" "),
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();

      return (
        matchesStatus &&
        matchesPublisher &&
        matchesHost &&
        matchesPlatform &&
        (!normalizedQuery || searchableText.includes(normalizedQuery))
      );
    });
  }, [
    agents,
    deferredQuery,
    hostFilter,
    platformFilter,
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
    setBulkConfirmation(undefined);
    setAgentDetail(undefined);
    setExportingCsv(false);
    setExportProgress(0);
    setBulkResult(undefined);
  }

  async function handleViewAgentDetails(agent: CopilotPackage) {
    setAgentDetailError(undefined);
    setLoadingAgentDetailId(agent.id);

    try {
      const detail = await getAgentDetails(agent.id);
      setAgentDetail(detail);
    } catch (requestError) {
      setAgentDetailError(errorMessage(requestError));
    } finally {
      setLoadingAgentDetailId(undefined);
    }
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

  async function handleExportCsv() {
    if (agents.length === 0 || exportingCsv) {
      return;
    }

    setError(undefined);
    setExportingCsv(true);
    setExportProgress(0);

    const rows: AgentExportRow[] = [];

    try {
      for (const [index, agent] of agents.entries()) {
        try {
          const detail = await getAgentDetails(agent.id);
          rows.push(toAgentExportRow(detail));
        } catch (requestError) {
          rows.push(toAgentExportRow(agent, errorMessage(requestError)));
        }

        setExportProgress(index + 1);
      }

      downloadCsv(
        `copilot-agents-${new Date().toISOString().slice(0, 10)}.csv`,
        toCsv(rows),
      );
    } catch (requestError) {
      setError(errorMessage(requestError));
    } finally {
      setExportingCsv(false);
      setExportProgress(0);
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
        <label>
          <span>Host</span>
          <select
            value={hostFilter}
            onChange={(event) => setHostFilter(event.target.value)}
          >
            <option value="all">All hosts</option>
            {hostOptions.map((host) => (
              <option key={host.value} value={host.value}>
                {host.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Built with</span>
          <select
            value={platformFilter}
            onChange={(event) => setPlatformFilter(event.target.value)}
          >
            <option value="all">All platforms</option>
            {platformOptions.map((platform) => (
              <option key={platform.value} value={platform.value}>
                {platform.label}
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
        <button
          type="button"
          className="secondary export-button"
          disabled={loadingAgents || exportingCsv || agents.length === 0}
          onClick={() => void handleExportCsv()}
        >
          {exportingCsv
            ? `Exporting ${exportProgress}/${agents.length}`
            : "Export CSV"}
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
          onViewDetails={(agent) => void handleViewAgentDetails(agent)}
          onBlock={(agent) => void handleAgentAction(agent, true)}
          onUnblock={(agent) => void handleAgentAction(agent, false)}
        />
      )}

      {loadingAgentDetailId ? (
        <div className="detail-loading" role="status" aria-live="polite">
          Loading agent details...
        </div>
      ) : null}

      {agentDetailError ? (
        <div className="error-banner">{agentDetailError}</div>
      ) : null}

      {agentDetail ? (
        <AgentDetailModal
          agent={agentDetail}
          onClose={() => setAgentDetail(undefined)}
        />
      ) : null}

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

type AgentExportRow = {
  packageId: string;
  displayName: string;
  status: string;
  publisher: string;
  type: string;
  shortDescription: string;
  version: string;
  manifestVersion: string;
  platform: string;
  supportedHosts: string;
  availableTo: string;
  deployedTo: string;
  sensitivity: string;
  categories: string;
  elementTypes: string;
  lastModified: string;
  appId: string;
  manifestId: string;
  assetId: string;
  allowedUsersAndGroups: string;
  acquireUsersAndGroups: string;
  elementDetails: string;
  detailError: string;
};

const csvHeaders: Array<{ key: keyof AgentExportRow; label: string }> = [
  { key: "packageId", label: "Package ID" },
  { key: "displayName", label: "Display name" },
  { key: "status", label: "Status" },
  { key: "publisher", label: "Publisher" },
  { key: "type", label: "Type" },
  { key: "shortDescription", label: "Short description" },
  { key: "version", label: "Version" },
  { key: "manifestVersion", label: "Manifest version" },
  { key: "platform", label: "Built with" },
  { key: "supportedHosts", label: "Supported hosts" },
  { key: "availableTo", label: "Available to" },
  { key: "deployedTo", label: "Acquired for" },
  { key: "sensitivity", label: "Sensitivity" },
  { key: "categories", label: "Categories" },
  { key: "elementTypes", label: "Element types" },
  { key: "lastModified", label: "Last modified" },
  { key: "appId", label: "App ID" },
  { key: "manifestId", label: "Manifest ID" },
  { key: "assetId", label: "Asset ID" },
  { key: "allowedUsersAndGroups", label: "Allowed users and groups" },
  { key: "acquireUsersAndGroups", label: "Acquire users and groups" },
  { key: "elementDetails", label: "Element details" },
  { key: "detailError", label: "Detail error" },
];

function wait(milliseconds: number) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

function formatHostLabel(host: string) {
  return host
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim();
}

function formatPlatformLabel(platform: string) {
  const normalizedPlatform = platform.toLowerCase().replace(/[^a-z0-9]/g, "");

  if (normalizedPlatform.includes("copilotstudio")) {
    return "Copilot Studio";
  }

  return formatHostLabel(platform);
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function AgentDetailModal({
  agent,
  onClose,
}: {
  agent: CopilotPackageDetail;
  onClose: () => void;
}) {
  const allowedSummary = summarizeAccess(agent.allowedUsersAndGroups);
  const acquireSummary = summarizeAccess(agent.acquireUsersAndGroups);
  const connectedServices = extractConnectedServices(agent.elementDetails);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
      }
    }

    window.addEventListener("keydown", handleKeyDown);

    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <section
        className="detail-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="agent-detail-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="detail-header">
          <div>
            <p className="eyebrow">Agent details</p>
            <h2 id="agent-detail-title">{agent.displayName}</h2>
          </div>
          <button type="button" className="secondary" onClick={onClose}>
            Close
          </button>
        </header>

        <p>
          {agent.longDescription ||
            agent.shortDescription ||
            "No description provided."}
        </p>

        <div className="detail-grid">
          <DetailItem label="Publisher" value={agent.publisher} />
          <DetailItem label="Type" value={agent.type} />
          <DetailItem
            label="Status"
            value={agent.isBlocked ? "Blocked" : "Allowed"}
          />
          <DetailItem label="Version" value={agent.version} />
          <DetailItem label="Manifest version" value={agent.manifestVersion} />
          <DetailItem
            label="Built with"
            value={formatPlatformLabel(agent.platform ?? "")}
          />
          <DetailItem
            label="Available to"
            value={formatDetailLabel(agent.availableTo)}
          />
          <DetailItem
            label="Sensitivity"
            value={formatDetailLabel(agent.sensitivity)}
          />
          <DetailItem
            label="Last modified"
            value={formatDate(agent.lastModifiedDateTime)}
          />
          <DetailItem
            label="Supported hosts"
            value={formatList(agent.supportedHosts)}
          />
          <DetailItem label="Categories" value={formatList(agent.categories)} />
          <DetailItem
            label="Element types"
            value={formatList(agent.elementTypes)}
          />
        </div>

        <section className="detail-section">
          <h3>Sharing and connected services</h3>
          <div className="detail-grid">
            <DetailItem
              label="Allowed assignments"
              value={formatAccessSummary(allowedSummary)}
            />
            <DetailItem
              label="Acquire assignments"
              value={formatAccessSummary(acquireSummary)}
            />
            <DetailItem
              label="Detected services"
              value={
                connectedServices.length
                  ? `${connectedServices.length} detected`
                  : "None returned"
              }
            />
          </div>
        </section>

        <section className="detail-section">
          <h3>Access assignments</h3>
          <AccessList
            label="Allowed users and groups"
            values={agent.allowedUsersAndGroups}
          />
          <AccessList
            label="Acquire users and groups"
            values={agent.acquireUsersAndGroups}
          />
        </section>

        <section className="detail-section">
          <h3>Identifiers</h3>
          <div className="detail-grid identifiers">
            <DetailItem label="Package ID" value={agent.id} />
            <DetailItem label="App ID" value={agent.appId} />
            <DetailItem label="Manifest ID" value={agent.manifestId} />
            <DetailItem label="Asset ID" value={agent.assetId} />
          </div>
        </section>

        {agent.elementDetails?.length ? (
          <section className="detail-section">
            <h3>Elements</h3>
            <ul className="detail-list">
              {agent.elementDetails.map((detail) => (
                <li key={detail.elementType}>
                  <span>{formatDetailLabel(detail.elementType)}</span>
                  <small>{detail.elements.length} elements</small>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <section className="detail-section">
          <h3>Connected services</h3>
          {connectedServices.length ? (
            <ul className="detail-list service-list">
              {connectedServices.map((service) => (
                <li key={`${service.source}-${service.value}`}>
                  <span>{service.value}</span>
                  <small>{service.source}</small>
                </li>
              ))}
            </ul>
          ) : (
            <p>No connected service metadata was returned for this package.</p>
          )}
        </section>
      </section>
    </div>
  );
}

type AccessSummary = {
  total: number;
  users: number;
  groups: number;
  other: number;
};

type ConnectedService = {
  value: string;
  source: string;
};

function DetailItem({ label, value }: { label: string; value?: string }) {
  return (
    <div className="detail-item">
      <span>{label}</span>
      <strong>{value || "Unknown"}</strong>
    </div>
  );
}

function summarizeAccess(
  values?: CopilotPackageDetail["allowedUsersAndGroups"],
): AccessSummary {
  const summary = { total: 0, users: 0, groups: 0, other: 0 };

  for (const entry of values ?? []) {
    summary.total += 1;

    if (entry.resourceType === "user") {
      summary.users += 1;
    } else if (entry.resourceType === "group") {
      summary.groups += 1;
    } else {
      summary.other += 1;
    }
  }

  return summary;
}

function formatAccessSummary(summary: AccessSummary) {
  if (summary.total === 0) {
    return "No explicit assignments";
  }

  return `${summary.total} total (${summary.users} users, ${summary.groups} groups, ${summary.other} other)`;
}

function extractConnectedServices(
  elementDetails?: CopilotPackageDetail["elementDetails"],
): ConnectedService[] {
  const services = new Map<string, ConnectedService>();

  for (const detail of elementDetails ?? []) {
    for (const element of detail.elements) {
      const source = `${formatDetailLabel(detail.elementType) ?? detail.elementType} ${element.id}`;

      for (const service of extractServiceCandidates(element.definition)) {
        const key = `${source}:${service}`;
        services.set(key, { value: service, source });
      }
    }
  }

  return [...services.values()].slice(0, 20);
}

function extractServiceCandidates(definition: string) {
  const candidates = new Set<string>();
  const urlMatches = definition.matchAll(
    /https?:\/\/([^\s"'<>/]+)[^\s"'<>]*/gi,
  );

  for (const match of urlMatches) {
    candidates.add(match[1]);
  }

  const parsed = parseJson(definition);

  if (parsed !== undefined) {
    collectServiceCandidates(parsed, candidates);
  }

  return [...candidates];
}

function collectServiceCandidates(value: unknown, candidates: Set<string>) {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectServiceCandidates(item, candidates);
    }
    return;
  }

  if (!value || typeof value !== "object") {
    return;
  }

  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string" && isServiceLikeKey(key)) {
      const candidate = item.trim();

      if (candidate && candidate.length <= 120) {
        candidates.add(candidate);
      }
    } else {
      collectServiceCandidates(item, candidates);
    }
  }
}

function isServiceLikeKey(key: string) {
  return /(api|connector|connection|endpoint|host|name|resource|service|url)/i.test(
    key,
  );
}

function parseJson(value: string) {
  const trimmed = value.trim();

  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    return undefined;
  }

  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
}

function AccessList({
  label,
  values,
}: {
  label: string;
  values?: CopilotPackageDetail["allowedUsersAndGroups"];
}) {
  return (
    <div className="access-list">
      <span>{label}</span>
      {values?.length ? (
        <ul>
          {values.slice(0, 8).map((entry) => (
            <li key={`${entry.resourceType}-${entry.resourceId}`}>
              <strong>{formatDetailLabel(entry.resourceType)}</strong>
              <small>{entry.resourceId}</small>
            </li>
          ))}
        </ul>
      ) : (
        <p>No explicit users or groups returned.</p>
      )}
      {values && values.length > 8 ? (
        <p>{values.length - 8} more entries hidden.</p>
      ) : null}
    </div>
  );
}

function formatList(values?: string[]) {
  return values?.length ? values.map(formatDetailLabel).join(", ") : undefined;
}

function formatDetailLabel(value?: string) {
  if (!value) {
    return undefined;
  }

  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim();
}

function formatDate(value?: string) {
  if (!value) {
    return undefined;
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function toAgentExportRow(
  agent: CopilotPackage | CopilotPackageDetail,
  detailError = "",
): AgentExportRow {
  const detail = agent as CopilotPackageDetail;

  return {
    packageId: agent.id,
    displayName: agent.displayName,
    status: agent.isBlocked ? "Blocked" : "Allowed",
    publisher: agent.publisher ?? "",
    type: formatDetailLabel(agent.type) ?? "",
    shortDescription: agent.shortDescription ?? "",
    version: agent.version ?? "",
    manifestVersion: agent.manifestVersion ?? "",
    platform: agent.platform ? formatPlatformLabel(agent.platform) : "",
    supportedHosts: formatList(agent.supportedHosts) ?? "",
    availableTo: formatDetailLabel(agent.availableTo) ?? "",
    deployedTo: formatDetailLabel(agent.deployedTo) ?? "",
    sensitivity: formatDetailLabel(detail.sensitivity) ?? "",
    categories: formatList(detail.categories) ?? "",
    elementTypes: formatList(agent.elementTypes) ?? "",
    lastModified: formatDate(agent.lastModifiedDateTime) ?? "",
    appId: agent.appId ?? "",
    manifestId: agent.manifestId ?? "",
    assetId: agent.assetId ?? "",
    allowedUsersAndGroups: formatAccessEntries(detail.allowedUsersAndGroups),
    acquireUsersAndGroups: formatAccessEntries(detail.acquireUsersAndGroups),
    elementDetails: formatElementDetails(detail.elementDetails),
    detailError,
  };
}

function formatAccessEntries(
  values?: CopilotPackageDetail["allowedUsersAndGroups"],
) {
  return (
    values
      ?.map(
        (entry) =>
          `${formatDetailLabel(entry.resourceType) ?? entry.resourceType}:${entry.resourceId}`,
      )
      .join("; ") ?? ""
  );
}

function formatElementDetails(values?: CopilotPackageDetail["elementDetails"]) {
  return (
    values
      ?.map(
        (detail) =>
          `${formatDetailLabel(detail.elementType) ?? detail.elementType}:${detail.elements.length}`,
      )
      .join("; ") ?? ""
  );
}

function toCsv(rows: AgentExportRow[]) {
  const header = csvHeaders.map((header) => csvCell(header.label)).join(",");
  const body = rows.map((row) =>
    csvHeaders.map((header) => csvCell(row[header.key])).join(","),
  );

  return [header, ...body].join("\r\n");
}

function csvCell(value: string) {
  return `"${value.replace(/"/g, '""')}"`;
}

function downloadCsv(filename: string, csv: string) {
  const blob = new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");

  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
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
