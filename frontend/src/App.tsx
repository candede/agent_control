import {
  type ReactNode,
  useDeferredValue,
  useEffect,
  useMemo,
  useState,
} from "react";
import DOMPurify from "dompurify";
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
import { getBuiltWithFilterValue, getBuiltWithLabel } from "./agentDisplay";
import "./App.css";
import { AgentTable } from "./components/AgentTable";
import { BulkActions } from "./components/BulkActions";
import {
  parseUsageReport,
  type AgentUsageReport,
  type AgentUsageRow,
  type ParsedUsageReport,
  type UserAgentUsageReport,
  type UserAgentUsageRow,
  type UserUsageReport,
  type UsageReportKind,
} from "./reportImports";

type UsageReportsState = {
  agents?: AgentUsageReport;
  userAgents?: UserAgentUsageReport;
  users?: UserUsageReport;
};

type PendingUsageImport = {
  reports: ParsedUsageReport[];
  failures: UsageImportFailure[];
  warnings: string[];
  totalFiles: number;
};

type UsageImportFailure = {
  fileName: string;
  message: string;
};

type UsageImportStatus = {
  kind: "success" | "error";
  message: string;
};

type AgentUsageSummary = AgentUsageRow & {
  fileName: string;
  importedAt: string;
  periodDays?: number;
  sourceReport: "agents" | "userAgents";
  userRows: UserAgentUsageRow[];
};

const emptyUsageReports = (): UsageReportsState => ({});

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
  const [availableToFilter, setAvailableToFilter] = useState("all");
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
  const [usageReports, setUsageReports] =
    useState<UsageReportsState>(emptyUsageReports);
  const [pendingUsageImport, setPendingUsageImport] =
    useState<PendingUsageImport>();
  const [usageImportStatus, setUsageImportStatus] =
    useState<UsageImportStatus>();
  const [usageFilter, setUsageFilter] = useState<UsageFilter>("all");
  const [inactiveDays, setInactiveDays] = useState(30);
  const deferredQuery = useDeferredValue(query);

  useEffect(() => {
    void loadSession();
  }, []);

  useEffect(() => {
    if (user) {
      void loadAgents();
    }
  }, [user]);

  const userAgentRowsByAgentId = useMemo(() => {
    const rowsByAgentId = new Map<string, UserAgentUsageRow[]>();

    for (const row of usageReports.userAgents?.rows ?? []) {
      const rows = rowsByAgentId.get(row.agentId) ?? [];
      rows.push(row);
      rowsByAgentId.set(row.agentId, rows);
    }

    return rowsByAgentId;
  }, [usageReports.userAgents]);

  const usageByAgentId = useMemo(
    () => buildUsageByAgentId(usageReports, userAgentRowsByAgentId),
    [usageReports, userAgentRowsByAgentId],
  );

  const unmatchedReportAgentCount = useMemo(() => {
    const packageIds = new Set(agents.map((agent) => agent.id));
    const reportIds = new Set(
      [
        ...(usageReports.agents?.rows ?? []),
        ...(usageReports.userAgents?.rows ?? []),
      ]
        .map((row) => row.agentId)
        .filter(Boolean),
    );

    return [...reportIds].filter((agentId) => !packageIds.has(agentId)).length;
  }, [agents, usageReports.agents, usageReports.userAgents]);

  const inactiveAgentCount = useMemo(
    () =>
      agents.filter((agent) =>
        isInactiveUsage(usageByAgentId.get(agent.id), inactiveDays),
      ).length,
    [agents, inactiveDays, usageByAgentId],
  );

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

  const availableToOptions = useMemo(() => {
    const availability = new Map<string, string>();

    for (const agent of agents) {
      const value = agent.availableTo || unknownAvailableToValue;
      const label = formatDetailLabel(agent.availableTo) ?? "Unknown";
      availability.set(value, label);
    }

    return [...availability]
      .map(([value, label]) => ({ value, label }))
      .sort((first, second) => first.label.localeCompare(second.label));
  }, [agents]);

  const platformOptions = useMemo(() => {
    const platforms = new Map<string, string>();

    for (const agent of agents) {
      const value = getBuiltWithFilterValue(agent);
      const label = getBuiltWithLabel(agent);

      if (value && label) {
        platforms.set(value, label);
      }
    }

    return [...platforms]
      .map(([value, label]) => ({ value, label }))
      .sort((first, second) => first.label.localeCompare(second.label));
  }, [agents]);

  const effectivePlatformFilter =
    platformFilter === "all" ||
    platformOptions.some((platform) => platform.value === platformFilter)
      ? platformFilter
      : "all";

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
      const matchesAvailability =
        availableToFilter === "all" ||
        agent.availableTo === availableToFilter ||
        (!agent.availableTo && availableToFilter === unknownAvailableToValue);
      const matchesHost =
        hostFilter === "all" || agent.supportedHosts?.includes(hostFilter);
      const matchesPlatform =
        effectivePlatformFilter === "all" ||
        getBuiltWithFilterValue(agent) === effectivePlatformFilter;
      const usage = usageByAgentId.get(agent.id);
      const matchesUsage = matchesUsageFilter(usage, usageFilter, inactiveDays);

      const searchableText = [
        agent.displayName,
        agent.shortDescription,
        agent.publisher,
        formatDetailLabel(agent.availableTo),
        agent.platform,
        getBuiltWithLabel(agent),
        usage?.agentName,
        usage?.creatorType,
        usage?.agentId,
        agent.id,
        agent.supportedHosts?.join(" "),
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();

      return (
        matchesStatus &&
        matchesPublisher &&
        matchesAvailability &&
        matchesHost &&
        matchesPlatform &&
        matchesUsage &&
        (!normalizedQuery || searchableText.includes(normalizedQuery))
      );
    });
  }, [
    agents,
    availableToFilter,
    deferredQuery,
    effectivePlatformFilter,
    hostFilter,
    inactiveDays,
    publisherFilter,
    statusFilter,
    usageByAgentId,
    usageFilter,
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
    setUsageReports(emptyUsageReports());
    setPendingUsageImport(undefined);
    setUsageImportStatus(undefined);
  }

  async function handleSelectUsageReports(files: FileList | null) {
    if (!files?.length) {
      return;
    }

    const parsedReports: ParsedUsageReport[] = [];
    const failures: UsageImportFailure[] = [];
    const warnings: string[] = [];

    for (const file of [...files]) {
      try {
        const report = parseUsageReport(file.name, await file.text());
        parsedReports.push(report);

        for (const warning of report.warnings) {
          warnings.push(`${file.name}: ${warning}`);
        }
      } catch (importError) {
        failures.push({
          fileName: file.name,
          message:
            importError instanceof Error
              ? importError.message
              : "Import failed.",
        });
      }
    }

    setUsageImportStatus(undefined);
    setPendingUsageImport({
      reports: parsedReports,
      failures,
      warnings,
      totalFiles: files.length,
    });
  }

  function handleConfirmUsageImport() {
    if (!pendingUsageImport) {
      return;
    }

    if (pendingUsageImport.reports.length === 0) {
      setUsageImportStatus({
        kind: "error",
        message: "No recognized usage report CSV files were selected.",
      });
      setPendingUsageImport(undefined);
      return;
    }

    setUsageReports((current) =>
      mergeUsageReports(current, pendingUsageImport.reports),
    );

    const counts = summarizeParsedUsageReports(pendingUsageImport.reports);
    const issueCount =
      pendingUsageImport.failures.length + pendingUsageImport.warnings.length;

    setUsageImportStatus({
      kind: "success",
      message: `Import successful: ${formatImportRowSummary(counts)}${
        issueCount
          ? `, with ${issueCount} issue${issueCount === 1 ? "" : "s"}`
          : ""
      }.`,
    });
    setPendingUsageImport(undefined);
  }

  function handleClearUsageReports() {
    setUsageReports(emptyUsageReports());
    setPendingUsageImport(undefined);
    setUsageImportStatus(undefined);
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
          rows.push(toAgentExportRow(detail, "", usageByAgentId.get(agent.id)));
        } catch (requestError) {
          rows.push(
            toAgentExportRow(
              agent,
              errorMessage(requestError),
              usageByAgentId.get(agent.id),
            ),
          );
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
        <AppFooter />
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
        <Metric
          label={`Inactive >${inactiveDays}d`}
          value={inactiveAgentCount}
        />
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

      <ReportImportPanel
        reports={usageReports}
        status={usageImportStatus}
        unmatchedReportAgentCount={unmatchedReportAgentCount}
        onImport={(files) => void handleSelectUsageReports(files)}
        onClear={handleClearUsageReports}
      />

      <section className="controls" aria-label="Filters">
        <label className="filter-search">
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
          <span>Available to</span>
          <select
            value={availableToFilter}
            onChange={(event) => setAvailableToFilter(event.target.value)}
          >
            <option value="all">All availability</option>
            {availableToOptions.map((availability) => (
              <option key={availability.value} value={availability.value}>
                {availability.label}
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
            value={effectivePlatformFilter}
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
        <label>
          <span>Usage</span>
          <select
            value={usageFilter}
            onChange={(event) =>
              setUsageFilter(event.target.value as UsageFilter)
            }
          >
            <option value="all">All usage states</option>
            <option value="with-usage">Has imported usage</option>
            <option value="without-usage">No imported usage</option>
            <option value="recent">Active within threshold</option>
            <option value="inactive">Inactive beyond threshold</option>
          </select>
        </label>
        <label>
          <span>Number of days</span>
          <input
            type="number"
            min="1"
            max="365"
            value={inactiveDays}
            onChange={(event) =>
              setInactiveDays(clampNumber(event.target.value, 1, 365, 30))
            }
          />
        </label>
        <div className="filter-actions" aria-label="Table actions">
          <button
            type="button"
            className="icon-button control-icon-button"
            aria-label={loadingAgents ? "Refreshing agents" : "Refresh agents"}
            title={loadingAgents ? "Refreshing agents" : "Refresh agents"}
            disabled={loadingAgents}
            onClick={() => void loadAgents()}
          >
            <RefreshIcon />
          </button>
          <button
            type="button"
            className="secondary icon-button control-icon-button"
            aria-label={
              exportingCsv
                ? `Exporting ${exportProgress} of ${agents.length} agents`
                : "Export agents CSV"
            }
            title={
              exportingCsv
                ? `Exporting ${exportProgress}/${agents.length}`
                : "Export CSV"
            }
            disabled={loadingAgents || exportingCsv || agents.length === 0}
            onClick={() => void handleExportCsv()}
          >
            <ExportIcon />
          </button>
        </div>
      </section>

      {loadingAgents ? (
        <div className="screen-state">Loading Copilot agents...</div>
      ) : (
        <AgentTable
          agents={filteredAgents}
          busyAgentId={busyAgentId}
          selectedIds={selectedAgentIds}
          selectionDisabled={Boolean(busyBulkAction)}
          usageByAgentId={usageByAgentId}
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
          usage={usageByAgentId.get(agentDetail.id)}
          userRows={userAgentRowsByAgentId.get(agentDetail.id) ?? []}
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

      {pendingUsageImport ? (
        <UsageImportReviewModal
          pendingImport={pendingUsageImport}
          onCancel={() => setPendingUsageImport(undefined)}
          onConfirm={handleConfirmUsageImport}
        />
      ) : null}

      <AppFooter />
    </main>
  );
}

const unknownPublisherValue = "__unknown__";
const unknownAvailableToValue = "__unknown__";

type UsageFilter =
  | "all"
  | "with-usage"
  | "without-usage"
  | "recent"
  | "inactive";

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
  reportAgentId: string;
  reportAgentName: string;
  creatorType: string;
  activeUsersLicensed: string;
  activeUsersUnlicensed: string;
  activeUsersTotal: string;
  responsesSentToUsers: string;
  lastActivity: string;
  usageSource: string;
  usageReportPeriodDays: string;
  usageReportFile: string;
  usageImportedAt: string;
  userAgentRows: string;
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
  { key: "reportAgentId", label: "Report Agent ID" },
  { key: "reportAgentName", label: "Report agent name" },
  { key: "creatorType", label: "Creator type" },
  { key: "activeUsersLicensed", label: "Active users licensed" },
  { key: "activeUsersUnlicensed", label: "Active users unlicensed" },
  { key: "activeUsersTotal", label: "Active users total" },
  { key: "responsesSentToUsers", label: "Responses sent to users" },
  { key: "lastActivity", label: "Last activity date UTC" },
  { key: "usageSource", label: "Usage source" },
  { key: "usageReportPeriodDays", label: "Usage report period days" },
  { key: "usageReportFile", label: "Usage report file" },
  { key: "usageImportedAt", label: "Usage imported at" },
  { key: "userAgentRows", label: "User-agent rows" },
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

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
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

function AppFooter() {
  return (
    <footer className="app-footer">
      <span>
        Provided as-is, without warranty of any kind. Use at your own
        discretion.
      </span>
      <a href="https://candede.com" target="_blank" rel="noreferrer noopener">
        candede.com
      </a>
    </footer>
  );
}

function getAgentDescription(agent: CopilotPackageDetail) {
  return (
    agent.longDescription ||
    agent.shortDescription ||
    "No description provided."
  );
}

function getSanitizedDescriptionHtml(description: string) {
  if (!hasHtmlMarkup(description)) {
    return undefined;
  }

  const sanitized = DOMPurify.sanitize(description, {
    USE_PROFILES: { html: true },
  }).trim();

  return sanitized || undefined;
}

function hasHtmlMarkup(value: string) {
  return /<\/?[a-z][\s\S]*>/i.test(value);
}

function AgentDetailModal({
  agent,
  usage,
  userRows,
  onClose,
}: {
  agent: CopilotPackageDetail;
  usage?: AgentUsageSummary;
  userRows: UserAgentUsageRow[];
  onClose: () => void;
}) {
  const allowedSummary = summarizeAccess(agent.allowedUsersAndGroups);
  const acquireSummary = summarizeAccess(agent.acquireUsersAndGroups);
  const connectedServices = extractConnectedServices(agent.elementDetails);
  const assignmentCount = allowedSummary.total + acquireSummary.total;
  const statusLabel = agent.isBlocked ? "Blocked" : "Allowed";
  const visibleUserRows = userRows.slice(0, 6);
  const hiddenUserRows = userRows.length - visibleUserRows.length;
  const description = getAgentDescription(agent);
  const sanitizedDescriptionHtml = getSanitizedDescriptionHtml(description);

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
          <div className="detail-title-block">
            <p className="eyebrow">Agent details</p>
            <h2 id="agent-detail-title">{agent.displayName}</h2>
          </div>
          <div className="detail-header-actions">
            <span
              className={
                agent.isBlocked
                  ? "detail-status is-blocked"
                  : "detail-status is-allowed"
              }
            >
              {statusLabel}
            </span>
            <button type="button" className="secondary" onClick={onClose}>
              Close
            </button>
          </div>
        </header>

        {sanitizedDescriptionHtml ? (
          <div
            className="detail-description rich-description"
            dangerouslySetInnerHTML={{ __html: sanitizedDescriptionHtml }}
          />
        ) : (
          <p className="detail-description">{description}</p>
        )}

        <div className="detail-stat-grid">
          <SummaryStat
            label="Status"
            value={statusLabel}
            tone={agent.isBlocked ? "danger" : "success"}
          />
          <SummaryStat
            label="Active users"
            value={
              usage ? usage.activeUsersTotal.toLocaleString() : "No import"
            }
            tone="usage"
          />
          <SummaryStat
            label="Responses sent"
            value={
              usage ? usage.responsesSentToUsers.toLocaleString() : "No import"
            }
            tone="usage"
          />
          <SummaryStat
            label="Connected services"
            value={
              connectedServices.length
                ? connectedServices.length.toLocaleString()
                : "None"
            }
          />
        </div>

        <div className="detail-layout">
          <div className="detail-column">
            <DetailSection
              title="Package details"
              countLabel={`${assignmentCount.toLocaleString()} access assignments`}
              tone="metadata"
            >
              <DetailList
                items={[
                  { label: "Publisher", value: agent.publisher },
                  { label: "Type", value: agent.type },
                  { label: "Built with", value: getBuiltWithLabel(agent) },
                  { label: "Version", value: agent.version },
                  { label: "Manifest", value: agent.manifestVersion },
                  {
                    label: "Last modified",
                    value: formatDate(agent.lastModifiedDateTime),
                  },
                  {
                    label: "Available to",
                    value: formatDetailLabel(agent.availableTo),
                  },
                  {
                    label: "Sensitivity",
                    value: formatDetailLabel(agent.sensitivity),
                  },
                  {
                    label: "Hosts",
                    value: formatList(agent.supportedHosts),
                  },
                  { label: "Categories", value: formatList(agent.categories) },
                  {
                    label: "Element types",
                    value: formatList(agent.elementTypes),
                  },
                  {
                    label: "Allowed assignments",
                    value: formatAccessSummary(allowedSummary),
                  },
                  {
                    label: "Acquire assignments",
                    value: formatAccessSummary(acquireSummary),
                  },
                  {
                    label: "Detected services",
                    value: connectedServices.length
                      ? `${connectedServices.length} detected`
                      : "None returned",
                  },
                  { label: "Package ID", value: agent.id, variant: "code" },
                  { label: "App ID", value: agent.appId, variant: "code" },
                  {
                    label: "Manifest ID",
                    value: agent.manifestId,
                    variant: "code",
                  },
                  { label: "Asset ID", value: agent.assetId, variant: "code" },
                ]}
              />
              <div className="access-grid">
                <AccessList
                  label="Allowed users and groups"
                  values={agent.allowedUsersAndGroups}
                />
                <AccessList
                  label="Acquire users and groups"
                  values={agent.acquireUsersAndGroups}
                />
              </div>
            </DetailSection>
          </div>

          <div className="detail-column">
            <DetailSection
              title="Usage import"
              countLabel={
                usage ? formatReportKind(usage.sourceReport) : "No import"
              }
              tone="usage"
            >
              <div className="detail-grid">
                <DetailItem
                  label="Report Agent ID"
                  value={usage?.agentId}
                  variant="code"
                />
                <DetailItem
                  label="Report agent name"
                  value={usage?.agentName}
                />
                <DetailItem label="Creator type" value={usage?.creatorType} />
                <DetailItem
                  label="Last activity"
                  value={formatReportDate(usage?.lastActivityDateUtc)}
                />
                <DetailItem
                  label="Licensed users"
                  value={usage?.activeUsersLicensed.toLocaleString()}
                />
                <DetailItem
                  label="Unlicensed users"
                  value={usage?.activeUsersUnlicensed.toLocaleString()}
                />
              </div>
            </DetailSection>

            <DetailSection
              title="User activity"
              countLabel={`${userRows.length.toLocaleString()} rows`}
              tone="activity"
            >
              {visibleUserRows.length ? (
                <ul className="detail-list user-activity-list">
                  {visibleUserRows.map((row) => (
                    <li key={`${row.agentId}-${row.username}`}>
                      <span>{row.username}</span>
                      <small>
                        {row.responsesSentToUsers.toLocaleString()} responses,
                        last activity{" "}
                        {formatReportDate(row.lastActivityDateUtc) ?? "Unknown"}
                      </small>
                    </li>
                  ))}
                </ul>
              ) : (
                <p>No user-agent report rows imported for this package.</p>
              )}
              {hiddenUserRows > 0 ? (
                <p className="detail-overflow-note">
                  {hiddenUserRows.toLocaleString()} more user rows hidden.
                </p>
              ) : null}
            </DetailSection>

            <DetailSection
              title="Elements"
              countLabel={`${agent.elementDetails?.length ?? 0} groups`}
            >
              {agent.elementDetails?.length ? (
                <ul className="detail-list compact-list">
                  {agent.elementDetails.map((detail) => (
                    <li key={detail.elementType}>
                      <span>{formatDetailLabel(detail.elementType)}</span>
                      <small>{detail.elements.length} elements</small>
                    </li>
                  ))}
                </ul>
              ) : (
                <p>No element metadata was returned for this package.</p>
              )}
            </DetailSection>

            <DetailSection
              title="Connected services"
              countLabel={`${connectedServices.length} detected`}
              tone="services"
            >
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
                <p>
                  No connected service metadata was returned for this package.
                </p>
              )}
            </DetailSection>
          </div>
        </div>
      </section>
    </div>
  );
}

function ReportImportPanel({
  reports,
  status,
  unmatchedReportAgentCount,
  onImport,
  onClear,
}: {
  reports: UsageReportsState;
  status?: UsageImportStatus;
  unmatchedReportAgentCount: number;
  onImport: (files: FileList | null) => void;
  onClear: () => void;
}) {
  const importedReports = [reports.agents, reports.userAgents, reports.users]
    .filter((report): report is ParsedUsageReport => Boolean(report))
    .map((report) => ({
      key: report.kind,
      label: formatReportKind(report.kind),
      rows: report.rows.length,
      fileName: report.fileName,
      periodDays: report.periodDays,
    }));

  return (
    <section className="report-panel" aria-label="Usage report import">
      <div className="report-panel-header">
        <div>
          <strong>Usage reports</strong>
          <span>
            Import the Agents, Users & agents, and Users CSV exports to enrich
            this view.
          </span>
        </div>
        <div className="report-actions">
          <label className="file-button">
            <input
              type="file"
              accept=".csv,text/csv"
              multiple
              onChange={(event) => {
                onImport(event.currentTarget.files);
                event.currentTarget.value = "";
              }}
            />
            Import CSVs
          </label>
          <button
            type="button"
            className="secondary"
            disabled={importedReports.length === 0 && !status}
            onClick={onClear}
          >
            Clear reports
          </button>
        </div>
      </div>

      {importedReports.length ? (
        <div className="report-summary-grid">
          {importedReports.map((report) => (
            <div key={report.key} className="report-summary-card">
              <span>{report.label}</span>
              <strong>{report.rows.toLocaleString()} rows</strong>
              <small>
                {report.periodDays
                  ? `${report.periodDays}-day export`
                  : "CSV import"}
              </small>
            </div>
          ))}
          <div className="report-summary-card">
            <span>Unmatched report agents</span>
            <strong>{unmatchedReportAgentCount.toLocaleString()}</strong>
            <small>Report rows without a listed package ID</small>
          </div>
        </div>
      ) : null}

      {status ? (
        <div className={`report-status ${status.kind}`} aria-live="polite">
          {status.message}
        </div>
      ) : null}
    </section>
  );
}

function UsageImportReviewModal({
  pendingImport,
  onCancel,
  onConfirm,
}: {
  pendingImport: PendingUsageImport;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const counts = summarizeParsedUsageReports(pendingImport.reports);
  const importDisabled = pendingImport.reports.length === 0;

  return (
    <div className="modal-backdrop" role="presentation" onClick={onCancel}>
      <section
        className="confirm-modal usage-import-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="usage-import-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div>
          <p className="eyebrow">CSV import</p>
          <h2 id="usage-import-title">Review usage reports</h2>
        </div>

        <p>
          Parsed {pendingImport.totalFiles.toLocaleString()} selected file
          {pendingImport.totalFiles === 1 ? "" : "s"}. Confirm to apply these
          usage metrics to the agent table.
        </p>

        <div className="confirm-summary usage-import-summary">
          <span>
            Agents
            <strong>{counts.agents.toLocaleString()}</strong>
          </span>
          <span>
            Users & agents
            <strong>{counts.userAgents.toLocaleString()}</strong>
          </span>
          <span>
            Users
            <strong>{counts.users.toLocaleString()}</strong>
          </span>
        </div>

        {pendingImport.reports.length ? (
          <section className="detail-section">
            <h3>Recognized reports</h3>
            <ul className="detail-list">
              {pendingImport.reports.map((report) => (
                <li key={`${report.kind}-${report.fileName}`}>
                  <span>{formatReportKind(report.kind)}</span>
                  <small>
                    {report.rows.length.toLocaleString()} rows
                    {report.periodDays
                      ? `, ${report.periodDays}-day export`
                      : ""}
                  </small>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {pendingImport.failures.length ? (
          <section className="detail-section">
            <h3>Files that need attention</h3>
            <ul className="detail-list">
              {pendingImport.failures.map((failure) => (
                <li key={failure.fileName}>
                  <span>{failure.fileName}</span>
                  <small>{failure.message}</small>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {pendingImport.warnings.length ? (
          <section className="detail-section">
            <h3>Warnings</h3>
            <ul className="detail-list">
              {pendingImport.warnings.slice(0, 6).map((warning) => (
                <li key={warning}>
                  <small>{warning}</small>
                </li>
              ))}
            </ul>
            {pendingImport.warnings.length > 6 ? (
              <p>{pendingImport.warnings.length - 6} more warnings hidden.</p>
            ) : null}
          </section>
        ) : null}

        <div className="confirm-actions">
          <button type="button" className="secondary" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" disabled={importDisabled} onClick={onConfirm}>
            Import reports
          </button>
        </div>
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

function DetailSection({
  title,
  countLabel,
  tone,
  children,
}: {
  title: string;
  countLabel?: string;
  tone?:
    | "activity"
    | "governance"
    | "metadata"
    | "services"
    | "technical"
    | "usage";
  children: ReactNode;
}) {
  return (
    <section className={tone ? `detail-section ${tone}` : "detail-section"}>
      <div className="detail-section-header">
        <h3>{title}</h3>
        {countLabel ? <span>{countLabel}</span> : null}
      </div>
      {children}
    </section>
  );
}

function SummaryStat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "danger" | "success" | "usage";
}) {
  return (
    <div className={tone ? `summary-stat ${tone}` : "summary-stat"}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

type DetailListItem = {
  label: string;
  value?: string;
  variant?: "code";
};

function DetailList({ items }: { items: DetailListItem[] }) {
  return (
    <dl className="compact-detail-list">
      {items.map((item) => (
        <div key={item.label}>
          <dt>{item.label}</dt>
          <dd className={item.variant === "code" ? "detail-code" : undefined}>
            {item.value || "Unknown"}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function DetailItem({
  label,
  value,
  variant,
}: {
  label: string;
  value?: string;
  variant?: "code";
}) {
  return (
    <div className="detail-item">
      <span>{label}</span>
      <strong className={variant === "code" ? "detail-code" : undefined}>
        {value || "Unknown"}
      </strong>
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

function formatReportDate(value?: string) {
  if (!value) {
    return undefined;
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeZone: "UTC",
  }).format(new Date(value));
}

function mergeUsageReports(
  current: UsageReportsState,
  reports: ParsedUsageReport[],
): UsageReportsState {
  const next: UsageReportsState = {
    ...current,
  };

  for (const report of reports) {
    if (report.kind === "agents") {
      next.agents = report;
    } else if (report.kind === "userAgents") {
      next.userAgents = report;
    } else {
      next.users = report;
    }
  }

  return next;
}

function buildUsageByAgentId(
  reports: UsageReportsState,
  userAgentRowsByAgentId: Map<string, UserAgentUsageRow[]>,
) {
  const usageByAgentId = new Map<string, AgentUsageSummary>();
  const agentReport = reports.agents;

  if (agentReport) {
    for (const row of agentReport.rows) {
      usageByAgentId.set(row.agentId, {
        ...row,
        fileName: agentReport.fileName,
        importedAt: agentReport.importedAt,
        periodDays: agentReport.periodDays,
        sourceReport: "agents",
        userRows: userAgentRowsByAgentId.get(row.agentId) ?? [],
      });
    }

    return usageByAgentId;
  }

  for (const [agentId, rows] of userAgentRowsByAgentId) {
    const usernames = new Set(rows.map((row) => row.username).filter(Boolean));
    const latestActivity = latestDate(
      rows.map((row) => row.lastActivityDateUtc),
    );
    const responsesSentToUsers = rows.reduce(
      (total, row) => total + row.responsesSentToUsers,
      0,
    );
    const firstRow = rows[0];

    usageByAgentId.set(agentId, {
      agentId,
      agentName: firstRow?.agentName ?? "",
      creatorType: firstRow?.creatorType ?? "",
      activeUsersLicensed: 0,
      activeUsersUnlicensed: 0,
      activeUsersTotal: usernames.size,
      responsesSentToUsers,
      lastActivityDateUtc: latestActivity,
      fileName: reports.userAgents?.fileName ?? "",
      importedAt: reports.userAgents?.importedAt ?? "",
      periodDays: reports.userAgents?.periodDays,
      sourceReport: "userAgents",
      userRows: rows,
    });
  }

  return usageByAgentId;
}

function latestDate(values: Array<string | undefined>) {
  return values
    .filter((value): value is string => Boolean(value))
    .sort((first, second) => Date.parse(second) - Date.parse(first))[0];
}

function matchesUsageFilter(
  usage: AgentUsageSummary | undefined,
  filter: UsageFilter,
  inactiveDays: number,
) {
  if (filter === "all") {
    return true;
  }

  if (filter === "with-usage") {
    return Boolean(usage);
  }

  if (filter === "without-usage") {
    return !usage;
  }

  if (!usage?.lastActivityDateUtc) {
    return false;
  }

  const inactive = isInactiveUsage(usage, inactiveDays);
  return filter === "inactive" ? inactive : !inactive;
}

function isInactiveUsage(
  usage: AgentUsageSummary | undefined,
  inactiveDays: number,
) {
  if (!usage?.lastActivityDateUtc) {
    return false;
  }

  const today = startOfUtcDay(new Date());
  const activityDate = startOfUtcDay(new Date(usage.lastActivityDateUtc));
  const elapsedDays = Math.floor(
    (today.getTime() - activityDate.getTime()) / 86_400_000,
  );

  return elapsedDays > inactiveDays;
}

function startOfUtcDay(date: Date) {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
}

function clampNumber(
  value: string,
  minimum: number,
  maximum: number,
  fallback: number,
) {
  const parsed = Number(value);

  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(maximum, Math.max(minimum, Math.floor(parsed)));
}

function formatReportKind(kind: UsageReportKind) {
  if (kind === "agents") {
    return "Agents";
  }

  if (kind === "userAgents") {
    return "Users & agents";
  }

  return "Users";
}

function summarizeParsedUsageReports(reports: ParsedUsageReport[]) {
  return reports.reduce(
    (counts, report) => {
      counts[report.kind] += report.rows.length;
      return counts;
    },
    { agents: 0, userAgents: 0, users: 0 } satisfies Record<
      UsageReportKind,
      number
    >,
  );
}

function formatImportRowSummary(counts: Record<UsageReportKind, number>) {
  const parts = [
    counts.agents ? `${counts.agents.toLocaleString()} agent rows` : undefined,
    counts.userAgents
      ? `${counts.userAgents.toLocaleString()} user-agent rows`
      : undefined,
    counts.users ? `${counts.users.toLocaleString()} user rows` : undefined,
  ].filter((part): part is string => Boolean(part));

  if (parts.length === 0) {
    return "0 rows";
  }

  if (parts.length === 1) {
    return parts[0];
  }

  return `${parts.slice(0, -1).join(", ")}, and ${parts.at(-1)}`;
}

function toAgentExportRow(
  agent: CopilotPackage | CopilotPackageDetail,
  detailError = "",
  usage?: AgentUsageSummary,
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
    platform: getBuiltWithLabel(agent) ?? "",
    supportedHosts: formatList(agent.supportedHosts) ?? "",
    availableTo: formatDetailLabel(agent.availableTo) ?? "",
    deployedTo: formatDetailLabel(agent.deployedTo) ?? "",
    sensitivity: formatDetailLabel(detail.sensitivity) ?? "",
    categories: formatList(detail.categories) ?? "",
    elementTypes: formatList(agent.elementTypes) ?? "",
    lastModified: formatDate(agent.lastModifiedDateTime) ?? "",
    reportAgentId: usage?.agentId ?? "",
    reportAgentName: usage?.agentName ?? "",
    creatorType: usage?.creatorType ?? "",
    activeUsersLicensed: usage?.activeUsersLicensed.toString() ?? "",
    activeUsersUnlicensed: usage?.activeUsersUnlicensed.toString() ?? "",
    activeUsersTotal: usage?.activeUsersTotal.toString() ?? "",
    responsesSentToUsers: usage?.responsesSentToUsers.toString() ?? "",
    lastActivity: formatReportDate(usage?.lastActivityDateUtc) ?? "",
    usageSource: usage ? formatReportKind(usage.sourceReport) : "",
    usageReportPeriodDays: usage?.periodDays?.toString() ?? "",
    usageReportFile: usage?.fileName ?? "",
    usageImportedAt: formatDate(usage?.importedAt) ?? "",
    userAgentRows: usage?.userRows.length.toString() ?? "",
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
