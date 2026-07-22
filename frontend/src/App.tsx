import {
  useDeferredValue,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Bot,
  ExternalLink,
  FileCheck2,
  FileWarning,
  Globe2,
  TriangleAlert,
  UserRound,
  UsersRound,
  type LucideIcon,
} from "lucide-react";
import {
  ApiError,
  blockAgent,
  blockAgents,
  getAgentDetails,
  getAgentDetailsBatch,
  getAgents,
  getAuditEvents,
  getBulkActionJob,
  getCurrentUser,
  signOut,
  unblockAgent,
  unblockAgents,
  updateAgentAccess,
  updateAgentsAccess,
  type BulkActionJob,
  type BulkActionResult,
  type AuditAction,
  type CopilotPackage,
  type CopilotPackageDetail,
  type PackageAccessUpdate,
  type SessionUser,
} from "./api/client";
import {
  downloadCsv,
  getExportFilename,
  toAgentExportRow,
  toCsv,
} from "./agentExport";
import { getBuiltWithFilterValue, getBuiltWithLabel } from "./agentDisplay";
import "./App.css";
import { parseBulkRefSearch } from "./bulkRefSearch";
import { AgentDetailModal } from "./components/AgentDetailModal";
import { AccessAssignmentModal } from "./components/AccessAssignmentModal";
import { AgentTable } from "./components/AgentTable";
import { AuditLogView } from "./components/AuditLogView";
import { BulkActions, type BulkProgress } from "./components/BulkActions";
import { ReportingView } from "./components/ReportingView";
import { UserAccessView } from "./components/UserAccessView";
import {
  parseUsageReport,
  parseUsageReportFileTimestamp,
  type AgentUsageSummary,
  type AgentUsageReport,
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

type ActiveView = "agents" | "users" | "reports" | "audit";

type BulkRefSearchState = {
  ref: string;
  agentIds: Set<string>;
  error?: string;
};

const usageReportsStorageKey = "agent-control:usage-reports:v1";
const activeBulkJobStorageKey = "agent-control:active-bulk-job:v1";
const bulkJobPollIntervalMs = 1_000;
const agentDisplayPageSize = 1_000;
const maxTransientChangedRows = 50;

const emptyUsageReports = (): UsageReportsState => ({});

function loadStoredUsageReports(): UsageReportsState {
  if (typeof window === "undefined") {
    return emptyUsageReports();
  }

  try {
    const storedReports = window.localStorage.getItem(usageReportsStorageKey);

    if (!storedReports) {
      return emptyUsageReports();
    }

    const parsedReports: unknown = JSON.parse(storedReports);
    return isStoredUsageReports(parsedReports)
      ? parsedReports
      : emptyUsageReports();
  } catch {
    return emptyUsageReports();
  }
}

function loadInitialUsageReportsState(): {
  reports: UsageReportsState;
  status?: UsageImportStatus;
} {
  const reports = loadStoredUsageReports();

  if (!hasUsageReports(reports)) {
    return { reports };
  }

  return {
    reports,
    status: {
      kind: "success",
      message: `Restored saved usage reports: ${formatImportRowSummary(
        summarizeUsageReportsState(reports),
      )}.`,
    },
  };
}

function saveStoredUsageReports(reports: UsageReportsState) {
  if (typeof window === "undefined") {
    return true;
  }

  try {
    if (hasUsageReports(reports)) {
      window.localStorage.setItem(
        usageReportsStorageKey,
        JSON.stringify(reports),
      );
    } else {
      window.localStorage.removeItem(usageReportsStorageKey);
    }

    return true;
  } catch {
    return false;
  }
}

function clearStoredUsageReports() {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.removeItem(usageReportsStorageKey);
  } catch {
    // Clearing reports should never fail the visible user action.
  }
}

function hasUsageReports(reports: UsageReportsState) {
  return Boolean(reports.agents || reports.userAgents || reports.users);
}

function isStoredUsageReports(value: unknown): value is UsageReportsState {
  if (!isRecord(value)) {
    return false;
  }

  return (
    isStoredReport(value.agents, "agents") &&
    isStoredReport(value.userAgents, "userAgents") &&
    isStoredReport(value.users, "users")
  );
}

function isStoredReport(value: unknown, kind: UsageReportKind) {
  if (value === undefined) {
    return true;
  }

  return (
    isRecord(value) &&
    value.kind === kind &&
    typeof value.fileName === "string" &&
    typeof value.importedAt === "string" &&
    Array.isArray(value.warnings) &&
    Array.isArray(value.rows)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

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
  const [createdWithinDays, setCreatedWithinDays] = useState("");
  const [selectedAgentIds, setSelectedAgentIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [busyAgentId, setBusyAgentId] = useState<string>();
  const [busyBulkAction, setBusyBulkAction] = useState<AuditAction>();
  const [bulkProgress, setBulkProgress] = useState<BulkProgress>();
  const [bulkResult, setBulkResult] = useState<BulkActionResult>();
  const [bulkConfirmation, setBulkConfirmation] = useState<BulkConfirmation>();
  const [bulkAccessAgentIds, setBulkAccessAgentIds] = useState<string[]>();
  const [agentDetail, setAgentDetail] = useState<CopilotPackageDetail>();
  const [loadingAgentDetailId, setLoadingAgentDetailId] = useState<string>();
  const [agentDetailError, setAgentDetailError] = useState<string>();
  const [exportChoiceOpen, setExportChoiceOpen] = useState(false);
  const [exportingCsv, setExportingCsv] = useState(false);
  const [exportProgress, setExportProgress] = useState(0);
  const [exportProgressTotal, setExportProgressTotal] = useState(0);
  const [exportProgressMode, setExportProgressMode] =
    useState<ExportMode>("full");
  const [initialUsageReportsState] = useState(loadInitialUsageReportsState);
  const [usageReports, setUsageReports] = useState<UsageReportsState>(
    () => initialUsageReportsState.reports,
  );
  const [pendingUsageImport, setPendingUsageImport] =
    useState<PendingUsageImport>();
  const [usageImportStatus, setUsageImportStatus] = useState<
    UsageImportStatus | undefined
  >(() => initialUsageReportsState.status);
  const [usageFilter, setUsageFilter] = useState<UsageFilter>("all");
  const [inactiveDays, setInactiveDays] = useState(30);
  const [reportActivityWindowDays, setReportActivityWindowDays] = useState(30);
  const [activeView, setActiveView] = useState<ActiveView>("agents");
  const [lastAgentListRefreshAt, setLastAgentListRefreshAt] = useState<Date>();
  const [agentDisplayWindow, setAgentDisplayWindow] = useState({
    key: "",
    limit: agentDisplayPageSize,
  });
  const [recentlyChangedAgentIds, setRecentlyChangedAgentIds] = useState<
    Set<string>
  >(() => new Set());
  const deferredQuery = useDeferredValue(query);
  const agentDetailRequestId = useRef(0);
  const bulkJobPollRequestId = useRef(0);
  const bulkRefSearchRequestId = useRef(0);
  const resumedBulkJobIds = useRef(new Set<string>());
  const agentDetailsCache = useRef(new Map<string, CopilotPackageDetail>());
  const stateChangeVersions = useRef(new Map<string, number>());
  const stateChangeTimerIds = useRef(new Set<number>());
  const resumeBulkJob = useEffectEvent((jobId: string) => {
    void followBulkJob(jobId);
  });
  const [bulkRefSearch, setBulkRefSearch] = useState<BulkRefSearchState>();

  useEffect(() => {
    void loadSession();
  }, []);

  useEffect(() => {
    if (user) {
      void loadAgents();
    }
  }, [user]);

  useEffect(() => {
    if (!user) {
      return;
    }

    const jobId = loadStoredActiveBulkJobId();

    if (!jobId || resumedBulkJobIds.current.has(jobId)) {
      return;
    }

    resumedBulkJobIds.current.add(jobId);
    resumeBulkJob(jobId);
  }, [user]);

  useEffect(
    () => () => {
      for (const timerId of stateChangeTimerIds.current) {
        window.clearTimeout(timerId);
      }
    },
    [],
  );

  const userAgentRowsByAgentId = useMemo(() => {
    const rowsByAgentId = new Map<string, UserAgentUsageRow[]>();

    for (const row of usageReports.userAgents?.rows ?? []) {
      if (!row.agentId) {
        continue;
      }

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

  const inactiveAgentCount = useMemo(
    () =>
      agents.filter((agent) =>
        isInactiveUsage(usageByAgentId.get(agent.id), inactiveDays),
      ).length,
    [agents, inactiveDays, usageByAgentId],
  );

  const allowedAgentCount = useMemo(
    () => agents.filter((agent) => !agent.isBlocked).length,
    [agents],
  );

  const blockedAgentCount = useMemo(
    () => agents.filter((agent) => agent.isBlocked).length,
    [agents],
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
      if (hasUnknownHostValue(agent)) {
        hosts.set(unknownHostValue, "Unknown");
      }

      for (const host of getKnownHostValues(agent)) {
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

    if ([...availability.keys()].some(isAvailableToSomeOrAllValue)) {
      availability.set(someOrAllAvailableToValue, "allowed For Some or All");
    }

    return [...availability]
      .map(([value, label]) => ({
        value:
          value === someOrAllAvailableToValue
            ? value
            : encodeAvailableToFilterValue(value),
        label,
      }))
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

  const normalizedBulkRefQuery = parseBulkRefSearch(deferredQuery);

  useEffect(() => {
    const requestId = ++bulkRefSearchRequestId.current;

    if (!normalizedBulkRefQuery) {
      return;
    }

    getAuditEvents({
      limit: 5_000,
      scope: "bulk",
      operationIdPrefix: normalizedBulkRefQuery,
    })
      .then((response) => {
        if (requestId !== bulkRefSearchRequestId.current) {
          return;
        }

        setBulkRefSearch({
          ref: normalizedBulkRefQuery,
          agentIds: new Set(response.value.map((event) => event.agentId)),
        });
      })
      .catch((requestError: unknown) => {
        if (requestId !== bulkRefSearchRequestId.current) {
          return;
        }

        setBulkRefSearch({
          ref: normalizedBulkRefQuery,
          agentIds: new Set(),
          error: errorMessage(requestError),
        });
      });
  }, [normalizedBulkRefQuery]);

  const loadingBulkRefSearch = Boolean(
    normalizedBulkRefQuery && bulkRefSearch?.ref !== normalizedBulkRefQuery,
  );

  const agentDisplayWindowKey = [
    availableToFilter,
    createdWithinDays,
    deferredQuery,
    effectivePlatformFilter,
    hostFilter,
    inactiveDays,
    publisherFilter,
    statusFilter,
    usageFilter,
  ].join("\u001f");
  const visibleAgentLimit =
    agentDisplayWindow.key === agentDisplayWindowKey
      ? agentDisplayWindow.limit
      : agentDisplayPageSize;
  const agentFilterCriteria = useMemo<AgentFilterCriteria>(
    () => ({
      availableToFilter,
      bulkRefSearch,
      creationWindowDays: parseOptionalPositiveInteger(createdWithinDays),
      effectivePlatformFilter,
      hostFilter,
      inactiveDays,
      normalizedBulkRefQuery,
      normalizedQuery: deferredQuery.trim().toLowerCase(),
      publisherFilter,
      statusFilter,
      usageByAgentId,
      usageFilter,
    }),
    [
      availableToFilter,
      bulkRefSearch,
      createdWithinDays,
      deferredQuery,
      effectivePlatformFilter,
      hostFilter,
      inactiveDays,
      normalizedBulkRefQuery,
      publisherFilter,
      statusFilter,
      usageByAgentId,
      usageFilter,
    ],
  );

  const filteredAgents = useMemo(() => {
    return agents.filter((agent) =>
      agentMatchesFilters(agent, agentFilterCriteria, true),
    );
  }, [agents, agentFilterCriteria]);

  const selectedAgents = useMemo(
    () => agents.filter((agent) => selectedAgentIds.has(agent.id)),
    [agents, selectedAgentIds],
  );

  const displayedFilteredAgents = useMemo(
    () => filteredAgents.slice(0, visibleAgentLimit),
    [filteredAgents, visibleAgentLimit],
  );
  const recentlyChangedFilteredOutAgents = useMemo(() => {
    if (statusFilter === "all" || recentlyChangedAgentIds.size === 0) {
      return [];
    }

    const filteredAgentIds = new Set(filteredAgents.map((agent) => agent.id));

    const transientAgents: CopilotPackage[] = [];

    for (const agent of agents) {
      if (
        recentlyChangedAgentIds.has(agent.id) &&
        !filteredAgentIds.has(agent.id) &&
        agentMatchesFilters(agent, agentFilterCriteria, false)
      ) {
        transientAgents.push(agent);

        if (transientAgents.length >= maxTransientChangedRows) {
          break;
        }
      }
    }

    return transientAgents;
  }, [
    agents,
    agentFilterCriteria,
    filteredAgents,
    recentlyChangedAgentIds,
    statusFilter,
  ]);
  const displayedAgents = useMemo(
    () =>
      mergeAgentRowsInCatalogOrder(
        agents,
        displayedFilteredAgents,
        recentlyChangedFilteredOutAgents,
      ),
    [agents, displayedFilteredAgents, recentlyChangedFilteredOutAgents],
  );

  const filteredAllowedAgentCount = filteredAgents.filter(
    (agent) => !agent.isBlocked,
  ).length;
  const filteredBlockedAgentCount = filteredAgents.filter(
    (agent) => agent.isBlocked,
  ).length;
  const filteredInactiveAgentCount = filteredAgents.filter((agent) =>
    isInactiveUsage(usageByAgentId.get(agent.id), inactiveDays),
  ).length;

  const hasActiveAgentFilters =
    deferredQuery.trim().length > 0 ||
    statusFilter !== "all" ||
    publisherFilter !== "all" ||
    availableToFilter !== "all" ||
    hostFilter !== "all" ||
    effectivePlatformFilter !== "all" ||
    parseOptionalPositiveInteger(createdWithinDays) !== undefined ||
    usageFilter !== "all";

  const matchingSelectedCount = filteredAgents.filter((agent) =>
    selectedAgentIds.has(agent.id),
  ).length;
  const allMatchingSelected =
    filteredAgents.length > 0 &&
    matchingSelectedCount === filteredAgents.length;
  const exportableAgentCount = filteredAgents.length;
  const hasMoreDisplayedAgents =
    displayedFilteredAgents.length < filteredAgents.length;

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
      setLastAgentListRefreshAt(new Date());
      agentDetailsCache.current.clear();
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
    agentDetailRequestId.current += 1;

    try {
      await signOut();
    } catch (requestError) {
      setError(errorMessage(requestError));
      return;
    }

    setUser(undefined);
    setAgents([]);
    setSelectedAgentIds(new Set());
    setBulkConfirmation(undefined);
    setBulkAccessAgentIds(undefined);
    setAgentDetail(undefined);
    setLoadingAgentDetailId(undefined);
    setAgentDetailError(undefined);
    setExportChoiceOpen(false);
    setLastAgentListRefreshAt(undefined);
    setRecentlyChangedAgentIds(new Set());
    setExportingCsv(false);
    setExportProgress(0);
    setExportProgressTotal(0);
    agentDetailsCache.current.clear();
    setBulkResult(undefined);
    clearStoredActiveBulkJobId();
    bulkJobPollRequestId.current += 1;
    clearStoredUsageReports();
    setUsageReports(emptyUsageReports());
    setPendingUsageImport(undefined);
    setUsageImportStatus(undefined);
  }

  function handleSearchQueryChange(nextQuery: string) {
    const nextRef = parseBulkRefSearch(nextQuery);

    setQuery(nextQuery);

    if (bulkRefSearch && bulkRefSearch.ref !== nextRef) {
      setBulkRefSearch(undefined);
    }
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

    const reports = coalesceUsageReportsByKind(parsedReports, warnings);

    setUsageImportStatus(undefined);
    setPendingUsageImport({
      reports,
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

    const nextUsageReports = mergeUsageReports(
      usageReports,
      pendingUsageImport.reports,
    );
    const persisted = saveStoredUsageReports(nextUsageReports);

    setUsageReports(nextUsageReports);

    const counts = summarizeParsedUsageReports(pendingUsageImport.reports);
    const issueCount =
      pendingUsageImport.failures.length +
      pendingUsageImport.warnings.length +
      (persisted ? 0 : 1);

    setUsageImportStatus({
      kind: persisted ? "success" : "error",
      message: `Import successful: ${formatImportRowSummary(counts)}${
        issueCount
          ? `, with ${issueCount} issue${issueCount === 1 ? "" : "s"}`
          : ""
      }.${
        persisted
          ? ""
          : " Reports will stay available for this session, but could not be saved for reload."
      }`,
    });
    setPendingUsageImport(undefined);
  }

  function handleClearUsageReports() {
    clearStoredUsageReports();
    setUsageReports(emptyUsageReports());
    setPendingUsageImport(undefined);
    setUsageImportStatus(undefined);
  }

  async function handleViewAgentDetails(agent: CopilotPackage) {
    const requestId = agentDetailRequestId.current + 1;
    agentDetailRequestId.current = requestId;

    setAgentDetailError(undefined);
    setAgentDetail(undefined);
    setLoadingAgentDetailId(agent.id);

    try {
      const detail = await getAgentDetails(agent.id);

      if (agentDetailRequestId.current === requestId) {
        agentDetailsCache.current.set(agent.id, detail);
        setAgentDetail(detail);
      }
    } catch (requestError) {
      if (agentDetailRequestId.current === requestId) {
        setAgentDetailError(errorMessage(requestError));
      }
    } finally {
      if (agentDetailRequestId.current === requestId) {
        setLoadingAgentDetailId(undefined);
      }
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

      updateCachedAgentBlockedState(agent.id, targetBlockedState);
    } catch (requestError) {
      setError(errorMessage(requestError));
    } finally {
      setBusyAgentId(undefined);
    }
  }

  async function handleUpdateAgentAccess(update: PackageAccessUpdate) {
    if (!agentDetail) {
      throw new Error("Agent details are no longer open.");
    }

    if (update.mode !== "replace") {
      throw new Error("Single-agent access updates must replace assignments.");
    }

    setError(undefined);
    const response = await updateAgentAccess(agentDetail.id, update);
    agentDetailsCache.current.set(response.agent.id, response.agent);
    setAgentDetail(response.agent);
    setAgents((current) =>
      current.map((agent) =>
        agent.id === response.agent.id
          ? {
              ...agent,
              availableTo: response.agent.availableTo,
              deployedTo: response.agent.deployedTo,
              lastModifiedDateTime: response.agent.lastModifiedDateTime,
            }
          : agent,
      ),
    );
    markAgentStatesChanged([response.agent.id]);
  }

  function requestExportCsv() {
    if (exportableAgentCount === 0 || exportingCsv) {
      return;
    }

    setExportChoiceOpen(true);
  }

  async function handleExportCsv(mode: ExportMode) {
    const agentsToExport = filteredAgents;

    if (agentsToExport.length === 0 || exportingCsv) {
      return;
    }

    setExportChoiceOpen(false);
    setError(undefined);
    setExportingCsv(true);
    setExportProgressMode(mode);
    setExportProgress(0);
    setExportProgressTotal(agentsToExport.length);

    try {
      const rows =
        mode === "fast"
          ? agentsToExport.map((agent) =>
              toAgentExportRow(agent, "", usageByAgentId.get(agent.id)),
            )
          : await buildFullExportRows(agentsToExport);

      if (mode === "fast") {
        setExportProgress(agentsToExport.length);
      }

      downloadCsv(getExportFilename(hasActiveAgentFilters, mode), toCsv(rows));
    } catch (requestError) {
      setError(errorMessage(requestError));
    } finally {
      setExportingCsv(false);
      setExportProgress(0);
      setExportProgressTotal(0);
    }
  }

  async function buildFullExportRows(agentsToExport: CopilotPackage[]) {
    const detailsById = new Map<string, CopilotPackageDetail>();
    const detailErrorsById = new Map<string, string>();
    const missingIds: string[] = [];

    for (const agent of agentsToExport) {
      const cachedDetail = agentDetailsCache.current.get(agent.id);

      if (cachedDetail) {
        detailsById.set(agent.id, cachedDetail);
      } else {
        missingIds.push(agent.id);
      }
    }

    setExportProgress(detailsById.size);

    for (const batchIds of chunks(missingIds, detailBatchSize)) {
      const response = await getAgentDetailsBatch(batchIds);

      for (const result of response.results) {
        if (result.status === "succeeded") {
          agentDetailsCache.current.set(result.id, result.package);
          detailsById.set(result.id, result.package);
        } else {
          detailErrorsById.set(result.id, result.message);
        }
      }

      setExportProgress((current) => current + response.results.length);
    }

    return agentsToExport.map((agent) =>
      toAgentExportRow(
        detailsById.get(agent.id) ?? agent,
        detailErrorsById.get(agent.id) ?? "",
        usageByAgentId.get(agent.id),
      ),
    );
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

    setBulkConfirmation(undefined);

    setBusyBulkAction(label);
    setBulkProgress({
      action: label,
      targetBlockedState,
      total: scope.length,
      completed: 0,
      succeeded: 0,
      failed: 0,
      skipped: 0,
      currentAgentName: "starting server-side bulk job",
    });
    setError(undefined);
    setBulkResult(undefined);

    try {
      const job = targetBlockedState
        ? await blockAgents(scope.map((agent) => agent.id))
        : await unblockAgents(scope.map((agent) => agent.id));

      saveStoredActiveBulkJobId(job.id);
      await followBulkJob(job.id, job);
    } catch (requestError) {
      setError(errorMessage(requestError));
      setBusyBulkAction(undefined);
      setBulkProgress(undefined);
      clearStoredActiveBulkJobId();
    }
  }

  function requestBulkAccessUpdate() {
    if (selectedAgents.length === 0) {
      setError("Select one or more agents before managing access.");
      return;
    }

    setError(undefined);
    setBulkAccessAgentIds(selectedAgents.map((agent) => agent.id));
  }

  async function runBulkAccessUpdate(update: PackageAccessUpdate) {
    const ids = bulkAccessAgentIds ?? [];

    if (ids.length === 0) {
      throw new Error("The selected agents are no longer available.");
    }

    const action: AuditAction =
      update.target === "availability"
        ? "update-availability"
        : "update-installation";
    setBusyBulkAction(action);
    setBulkProgress({
      action,
      accessUpdate: update,
      total: ids.length,
      completed: 0,
      succeeded: 0,
      failed: 0,
      skipped: 0,
      currentAgentName: "starting server-side bulk job",
    });
    setError(undefined);
    setBulkResult(undefined);

    try {
      const job = await updateAgentsAccess(ids, update);
      setBulkAccessAgentIds(undefined);
      saveStoredActiveBulkJobId(job.id);
      await followBulkJob(job.id, job);
    } catch (requestError) {
      setError(errorMessage(requestError));
      setBusyBulkAction(undefined);
      setBulkProgress(undefined);
      clearStoredActiveBulkJobId();
      throw requestError;
    }
  }

  async function followBulkJob(jobId: string, initialJob?: BulkActionJob) {
    const requestId = bulkJobPollRequestId.current + 1;
    bulkJobPollRequestId.current = requestId;

    try {
      let job = initialJob ?? (await getBulkActionJob(jobId));

      setBusyBulkAction(job.action);
      setBulkProgress(toBulkProgress(job));
      saveStoredActiveBulkJobId(job.id);

      while (job.status === "queued" || job.status === "running") {
        await wait(bulkJobPollIntervalMs);

        if (bulkJobPollRequestId.current !== requestId) {
          return;
        }

        job = await getBulkActionJob(jobId);

        if (bulkJobPollRequestId.current !== requestId) {
          return;
        }

        setBulkProgress(toBulkProgress(job));
      }

      if (job.status === "completed" && job.result) {
        applyBulkActionResult(job.result);
      } else {
        setError(job.error ?? "Bulk action failed before it completed.");
      }
    } catch (requestError) {
      setError(errorMessage(requestError));
    } finally {
      if (bulkJobPollRequestId.current === requestId) {
        setBusyBulkAction(undefined);
        setBulkProgress(undefined);
        clearStoredActiveBulkJobId();
      }
    }
  }

  function applyBulkActionResult(result: BulkActionResult) {
    if (result.targetBlockedState !== undefined) {
      updateCachedAgentBlockedStates(
        result.results
          .filter((item) => item.status === "succeeded")
          .map((item) => item.id),
        result.targetBlockedState,
      );
    }

    if (result.accessUpdate) {
      const changedIds = result.results
        .filter((item) => item.status === "succeeded")
        .map((item) => item.id);

      for (const id of changedIds) {
        agentDetailsCache.current.delete(id);
      }

      if (agentDetail && changedIds.includes(agentDetail.id)) {
        setAgentDetail(undefined);
      }

      markAgentStatesChanged(changedIds);
      void loadAgents();
    }

    setBulkResult(result);
    setSelectedAgentIds(
      new Set(
        result.results
          .filter((result) => result.status === "failed")
          .map((result) => result.id),
      ),
    );
  }

  function handleClearAgentFilters() {
    handleSearchQueryChange("");
    setStatusFilter("all");
    setPublisherFilter("all");
    setAvailableToFilter("all");
    setHostFilter("all");
    setPlatformFilter("all");
    setCreatedWithinDays("");
    setUsageFilter("all");
  }

  function updateCachedAgentBlockedState(
    agentId: string,
    targetBlockedState: boolean,
  ) {
    updateCachedAgentBlockedStates([agentId], targetBlockedState);
  }

  function updateCachedAgentBlockedStates(
    agentIds: string[],
    targetBlockedState: boolean,
  ) {
    const changedAgentIds = new Set(agentIds);

    if (changedAgentIds.size === 0) {
      return;
    }

    for (const agentId of changedAgentIds) {
      const cachedDetail = agentDetailsCache.current.get(agentId);

      if (cachedDetail && cachedDetail.isBlocked !== targetBlockedState) {
        agentDetailsCache.current.set(agentId, {
          ...cachedDetail,
          isBlocked: targetBlockedState,
        });
      }
    }

    setAgents((currentAgents) => {
      let updatedAnyAgent = false;
      const nextAgents = currentAgents.map((currentAgent) => {
        if (
          !changedAgentIds.has(currentAgent.id) ||
          currentAgent.isBlocked === targetBlockedState
        ) {
          return currentAgent;
        }

        updatedAnyAgent = true;
        return { ...currentAgent, isBlocked: targetBlockedState };
      });

      return updatedAnyAgent ? nextAgents : currentAgents;
    });
    setAgentDetail((currentDetail) =>
      currentDetail &&
      changedAgentIds.has(currentDetail.id) &&
      currentDetail.isBlocked !== targetBlockedState
        ? { ...currentDetail, isBlocked: targetBlockedState }
        : currentDetail,
    );
    markAgentStatesChanged([...changedAgentIds]);
  }

  function markAgentStatesChanged(agentIds: string[]) {
    const changedAgentIds = [...new Set(agentIds)];

    setRecentlyChangedAgentIds((current) => {
      const next = new Set(current);
      let addedAnyAgent = false;

      for (const agentId of changedAgentIds) {
        if (!next.has(agentId)) {
          next.add(agentId);
          addedAnyAgent = true;
        }
      }

      return addedAnyAgent ? next : current;
    });

    const versions = new Map(
      changedAgentIds.map((agentId) => {
        const version = (stateChangeVersions.current.get(agentId) ?? 0) + 1;
        stateChangeVersions.current.set(agentId, version);
        return [agentId, version] as const;
      }),
    );

    const timerId = window.setTimeout(() => {
      stateChangeTimerIds.current.delete(timerId);

      setRecentlyChangedAgentIds((current) => {
        const next = new Set(current);
        let removedAnyAgent = false;

        for (const [agentId, version] of versions) {
          if (stateChangeVersions.current.get(agentId) === version) {
            stateChangeVersions.current.delete(agentId);
            next.delete(agentId);
            removedAnyAgent = true;
          }
        }

        return removedAnyAgent ? next : current;
      });
    }, 1600);

    stateChangeTimerIds.current.add(timerId);
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

  function toggleMatchingSelection(matchingAgents: CopilotPackage[]) {
    setSelectedAgentIds((current) => {
      const next = new Set(current);
      const matchingIds = matchingAgents.map((agent) => agent.id);
      const allSelected = matchingIds.every((agentId) => next.has(agentId));

      for (const agentId of matchingIds) {
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
        <section className="signin-panel" aria-labelledby="signin-title">
          <p className="eyebrow">Microsoft 365 Copilot administration</p>
          <h1 id="signin-title">Agent Control</h1>
          <p className="signin-lede">
            Sign in with a work or school account that has delegated access to
            manage Copilot packages, tenant availability, and agent status.
          </p>
          {error ? <div className="error-banner">{error}</div> : null}
          <div className="signin-actions">
            <a className="primary-link signin-button" href="/api/auth/login">
              Sign in with Entra ID
            </a>
            <span>Delegated admin access required</span>
          </div>
        </section>
        <AppFooter />
      </main>
    );
  }

  return (
    <main className="app-shell">
      <header className="top-bar">
        <div className="title-block">
          <p className="eyebrow">Tenant package controls</p>
          <div className="title-row">
            <h1>Agent Control</h1>
            <nav className="view-switcher" aria-label="Primary views">
              <button
                type="button"
                className={
                  activeView === "agents" ? "view-button active" : "view-button"
                }
                onClick={() => setActiveView("agents")}
              >
                Agent view
              </button>
              <button
                type="button"
                className={
                  activeView === "users" ? "view-button active" : "view-button"
                }
                onClick={() => setActiveView("users")}
              >
                User view
              </button>
              <button
                type="button"
                className={
                  activeView === "reports"
                    ? "view-button active"
                    : "view-button"
                }
                onClick={() => setActiveView("reports")}
              >
                Insights
              </button>
              <button
                type="button"
                className={
                  activeView === "audit" ? "view-button active" : "view-button"
                }
                onClick={() => setActiveView("audit")}
              >
                Audit log
              </button>
            </nav>
          </div>
        </div>
        <div className="user-menu">
          <span>{user.displayName || user.username}</span>
          <button type="button" onClick={() => void handleSignOut()}>
            Sign out
          </button>
        </div>
      </header>

      {error ? <div className="error-banner">{error}</div> : null}

      <ReportImportPanel
        reports={usageReports}
        status={usageImportStatus}
        onImport={(files) => void handleSelectUsageReports(files)}
        onClear={handleClearUsageReports}
      />

      {activeView === "agents" ? (
        <>
          <section className="summary-grid" aria-label="Agent summary">
            <Metric
              label="Total"
              value={agents.length}
              filteredValue={
                hasActiveAgentFilters ? filteredAgents.length : undefined
              }
            />
            <Metric
              label="Allowed"
              value={allowedAgentCount}
              filteredValue={
                hasActiveAgentFilters ? filteredAllowedAgentCount : undefined
              }
            />
            <Metric
              label="Blocked"
              value={blockedAgentCount}
              filteredValue={
                hasActiveAgentFilters ? filteredBlockedAgentCount : undefined
              }
            />
            <Metric
              label={`Inactive >${inactiveDays}d`}
              value={inactiveAgentCount}
              filteredValue={
                hasActiveAgentFilters ? filteredInactiveAgentCount : undefined
              }
            />
          </section>

          <BulkActions
            disabled={
              loadingAgents || Boolean(busyAgentId) || Boolean(busyBulkAction)
            }
            activityProgress={
              exportingCsv ? (
                <ExportProgressMeter
                  completed={exportProgress}
                  mode={exportProgressMode}
                  total={exportProgressTotal || exportableAgentCount}
                />
              ) : undefined
            }
            busyAction={busyBulkAction}
            progress={bulkProgress}
            result={bulkResult}
            selectedCount={selectedAgentIds.size}
            onBlockAll={() => requestBulkAction(true)}
            onManageAccess={requestBulkAccessUpdate}
            onUnblockAll={() => requestBulkAction(false)}
          />

          <section className="controls catalog-controls" aria-label="Filters">
            <div
              className="filter-section filter-section-primary"
              aria-label="Find agents"
            >
              <span className="filter-section-title">Find agents</span>
              <label className="filter-search">
                <span>Search</span>
                <input
                  type="search"
                  value={query}
                  onChange={(event) =>
                    handleSearchQueryChange(event.target.value)
                  }
                  placeholder="Name, publisher, ID, ref"
                />
              </label>
              <label>
                <span>Status</span>
                <select
                  className={
                    statusFilter === "all" ? undefined : "active-filter-select"
                  }
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
                <span>Available to</span>
                <select
                  className={
                    availableToFilter === "all"
                      ? undefined
                      : "active-filter-select"
                  }
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
            </div>

            <div
              className="filter-section filter-section-metadata"
              aria-label="Catalog details"
            >
              <span className="filter-section-title">Catalog details</span>
              <label>
                <span>Publisher</span>
                <select
                  className={
                    publisherFilter === "all"
                      ? undefined
                      : "active-filter-select"
                  }
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
                  className={
                    hostFilter === "all" ? undefined : "active-filter-select"
                  }
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
                  className={
                    effectivePlatformFilter === "all"
                      ? undefined
                      : "active-filter-select"
                  }
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
              <label className="threshold-filter">
                <span>Created in last</span>
                <div className="number-with-unit">
                  <input
                    className={
                      parseOptionalPositiveInteger(createdWithinDays)
                        ? "active-filter-input"
                        : undefined
                    }
                    type="number"
                    min="1"
                    max="3650"
                    value={createdWithinDays}
                    onChange={(event) =>
                      setCreatedWithinDays(event.target.value)
                    }
                    placeholder="Any"
                  />
                  <span>days</span>
                </div>
              </label>
            </div>

            <div
              className="filter-section filter-section-usage"
              aria-label="Usage window"
            >
              <span className="filter-section-title">Usage window</span>
              <label>
                <span>Usage state</span>
                <select
                  className={
                    usageFilter === "all" ? undefined : "active-filter-select"
                  }
                  value={usageFilter}
                  onChange={(event) =>
                    setUsageFilter(event.target.value as UsageFilter)
                  }
                >
                  <option value="all">All usage states</option>
                  <option value="with-usage">Has imported usage</option>
                  <option value="without-usage">No imported usage</option>
                  <option value="recent">
                    Active in last {inactiveDays} days
                  </option>
                  <option value="inactive">
                    Inactive over {inactiveDays} days
                  </option>
                </select>
              </label>
              <label className="threshold-filter">
                <span>Inactive threshold</span>
                <div className="number-with-unit">
                  <input
                    type="number"
                    min="1"
                    max="365"
                    value={inactiveDays}
                    onChange={(event) =>
                      setInactiveDays(
                        clampNumber(event.target.value, 1, 365, 30),
                      )
                    }
                  />
                  <span>days</span>
                </div>
              </label>
            </div>

            <div
              className="filter-actions catalog-filter-actions"
              aria-label="Table actions"
            >
              <div className="filter-action-buttons">
                <button
                  type="button"
                  className="icon-button control-icon-button"
                  aria-label={
                    loadingAgents ? "Refreshing agents" : "Refresh agents"
                  }
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
                      ? `Exporting ${exportProgress} of ${exportableAgentCount} filtered agents`
                      : "Export filtered agents CSV"
                  }
                  title={
                    exportingCsv
                      ? `Exporting ${exportProgress}/${exportableAgentCount}`
                      : "Export filtered CSV"
                  }
                  disabled={
                    loadingAgents || exportingCsv || exportableAgentCount === 0
                  }
                  onClick={requestExportCsv}
                >
                  <ExportIcon />
                </button>
              </div>
              <span className="last-refresh" aria-live="polite">
                {lastAgentListRefreshAt
                  ? `Last full refresh ${formatRefreshTime(
                      lastAgentListRefreshAt,
                    )}`
                  : ""}
              </span>
            </div>
            <button
              type="button"
              className="secondary clear-filters-button catalog-clear-filters-button"
              disabled={!hasActiveAgentFilters}
              onClick={handleClearAgentFilters}
            >
              Clear filters
            </button>
          </section>

          {loadingBulkRefSearch ? (
            <div className="screen-state">
              Resolving bulk ref {normalizedBulkRefQuery}...
            </div>
          ) : null}
          {normalizedBulkRefQuery && bulkRefSearch?.error ? (
            <div className="error-banner">{bulkRefSearch.error}</div>
          ) : null}

          {loadingAgents ? (
            <div className="screen-state">Loading Copilot agents...</div>
          ) : (
            <div className="agent-table-stack">
              <AgentTable
                agents={displayedAgents}
                busyAgentId={busyAgentId}
                selectedIds={selectedAgentIds}
                recentlyChangedIds={recentlyChangedAgentIds}
                selectionDisabled={Boolean(busyBulkAction)}
                usageByAgentId={usageByAgentId}
                allMatchingSelected={allMatchingSelected}
                selectedCount={selectedAgentIds.size}
                onToggleAgentSelection={toggleAgentSelection}
                onToggleMatchingSelection={() =>
                  toggleMatchingSelection(filteredAgents)
                }
                onViewDetails={(agent) => void handleViewAgentDetails(agent)}
                onBlock={(agent) => void handleAgentAction(agent, true)}
                onUnblock={(agent) => void handleAgentAction(agent, false)}
              />
              <AgentDisplayWindowControls
                displayedCount={displayedFilteredAgents.length}
                totalCount={filteredAgents.length}
                hasMore={hasMoreDisplayedAgents}
                onLoadMore={() =>
                  setAgentDisplayWindow((currentWindow) => {
                    const currentLimit =
                      currentWindow.key === agentDisplayWindowKey
                        ? currentWindow.limit
                        : agentDisplayPageSize;

                    return {
                      key: agentDisplayWindowKey,
                      limit: currentLimit + agentDisplayPageSize,
                    };
                  })
                }
              />
            </div>
          )}
        </>
      ) : activeView === "users" ? (
        <UserAccessView
          agents={agents}
          inactiveDays={inactiveDays}
          reports={usageReports}
        />
      ) : activeView === "reports" ? (
        <ReportingView
          activityWindowDays={reportActivityWindowDays}
          agents={agents}
          inactiveDays={inactiveDays}
          onActivityWindowDaysChange={setReportActivityWindowDays}
          reports={usageReports}
        />
      ) : (
        <AuditLogView agents={agents} />
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
          onUpdateAccess={handleUpdateAgentAccess}
        />
      ) : null}

      {bulkAccessAgentIds ? (
        <AccessAssignmentModal
          context="bulk"
          agentCount={bulkAccessAgentIds.length}
          onCancel={() => setBulkAccessAgentIds(undefined)}
          onSubmit={runBulkAccessUpdate}
        />
      ) : null}

      {bulkConfirmation ? (
        <BulkConfirmModal
          confirmation={bulkConfirmation}
          onCancel={() => setBulkConfirmation(undefined)}
          onConfirm={() => void runConfirmedBulkAction(bulkConfirmation)}
        />
      ) : null}

      {exportChoiceOpen ? (
        <ExportChoiceModal
          agentCount={exportableAgentCount}
          isFiltered={hasActiveAgentFilters}
          onCancel={() => setExportChoiceOpen(false)}
          onExport={(mode) => void handleExportCsv(mode)}
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
const unknownHostValue = "__unknown_host__";
const unknownAvailableToValue = "__unknown__";
const someOrAllAvailableToValue = "__some_or_all__";
const availableToFilterValuePrefix = "available:";
const detailBatchSize = 100;
const someOrAllAvailableToNormalizedValues = new Set([
  "allowedforall",
  "allowedforsome",
]);

type ExportMode = "fast" | "full";

type UsageFilter =
  | "all"
  | "with-usage"
  | "without-usage"
  | "recent"
  | "inactive";

type BulkConfirmation = {
  action: "block" | "unblock";
  targetBlockedState: boolean;
  scope: CopilotPackage[];
  actionableCount: number;
  skippedCount: number;
};

type AgentFilterCriteria = {
  availableToFilter: string;
  bulkRefSearch?: BulkRefSearchState;
  creationWindowDays?: number;
  effectivePlatformFilter: string;
  hostFilter: string;
  inactiveDays: number;
  normalizedBulkRefQuery?: string;
  normalizedQuery: string;
  publisherFilter: string;
  statusFilter: "all" | "allowed" | "blocked";
  usageByAgentId: Map<string, AgentUsageSummary>;
  usageFilter: UsageFilter;
};

function agentMatchesFilters(
  agent: CopilotPackage,
  criteria: AgentFilterCriteria,
  includeStatus: boolean,
) {
  const usage = criteria.usageByAgentId.get(agent.id);
  const matchesStatus =
    !includeStatus ||
    criteria.statusFilter === "all" ||
    (criteria.statusFilter === "blocked" && agent.isBlocked) ||
    (criteria.statusFilter === "allowed" && !agent.isBlocked);
  const matchesPublisher =
    criteria.publisherFilter === "all" ||
    agent.publisher === criteria.publisherFilter ||
    (!agent.publisher && criteria.publisherFilter === unknownPublisherValue);
  const matchesAvailability = matchesAvailableToFilter(
    agent.availableTo,
    criteria.availableToFilter,
  );
  const matchesHost =
    criteria.hostFilter === "all" ||
    (criteria.hostFilter === unknownHostValue
      ? hasUnknownHostValue(agent)
      : getKnownHostValues(agent).includes(criteria.hostFilter));
  const matchesPlatform =
    criteria.effectivePlatformFilter === "all" ||
    getBuiltWithFilterValue(agent) === criteria.effectivePlatformFilter;
  const matchesCreationAge = criteria.creationWindowDays
    ? isCreatedWithinDays(agent.createdDateTime, criteria.creationWindowDays)
    : true;
  const matchesUsage = matchesUsageFilter(
    usage,
    criteria.usageFilter,
    criteria.inactiveDays,
  );
  const matchesBulkRef = criteria.normalizedBulkRefQuery
    ? criteria.bulkRefSearch?.ref === criteria.normalizedBulkRefQuery &&
      criteria.bulkRefSearch.agentIds.has(agent.id)
    : true;

  return (
    matchesStatus &&
    matchesPublisher &&
    matchesAvailability &&
    matchesHost &&
    matchesPlatform &&
    matchesCreationAge &&
    matchesUsage &&
    matchesBulkRef &&
    (criteria.normalizedBulkRefQuery ||
      !criteria.normalizedQuery ||
      getAgentSearchableText(agent, usage).includes(criteria.normalizedQuery))
  );
}

function getAgentSearchableText(
  agent: CopilotPackage,
  usage: AgentUsageSummary | undefined,
) {
  return [
    agent.displayName,
    agent.shortDescription,
    agent.publisher,
    formatDetailLabel(agent.availableTo),
    agent.platform,
    getBuiltWithLabel(agent),
    usage?.agentName,
    usage?.creatorType,
    usage?.agentId,
    agent.createdDateTime,
    agent.id,
    getKnownHostValues(agent).join(" "),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function mergeAgentRowsInCatalogOrder(
  catalogAgents: CopilotPackage[],
  primaryAgents: CopilotPackage[],
  additionalAgents: CopilotPackage[],
) {
  if (additionalAgents.length === 0) {
    return primaryAgents;
  }

  const displayedAgentIds = new Set(
    [...primaryAgents, ...additionalAgents].map((agent) => agent.id),
  );

  return catalogAgents.filter((agent) => displayedAgentIds.has(agent.id));
}

function toBulkProgress(job: BulkActionJob): BulkProgress {
  const progress = {
    total: job.total,
    completed: job.completed,
    succeeded: job.succeeded,
    failed: job.failed,
    skipped: job.skipped,
    currentAgentName: job.currentAgentName,
  };

  return job.accessUpdate
    ? { ...progress, action: job.action, accessUpdate: job.accessUpdate }
    : {
        ...progress,
        action: job.action,
        targetBlockedState: job.targetBlockedState,
      };
}

function wait(milliseconds: number) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

function loadStoredActiveBulkJobId() {
  if (typeof window === "undefined") {
    return undefined;
  }

  try {
    return window.localStorage.getItem(activeBulkJobStorageKey) ?? undefined;
  } catch {
    return undefined;
  }
}

function saveStoredActiveBulkJobId(jobId: string) {
  if (typeof window !== "undefined") {
    window.localStorage.setItem(activeBulkJobStorageKey, jobId);
  }
}

function clearStoredActiveBulkJobId() {
  if (typeof window !== "undefined") {
    window.localStorage.removeItem(activeBulkJobStorageKey);
  }
}

function formatHostLabel(host: string) {
  return host
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim();
}

function getKnownHostValues(agent: Pick<CopilotPackage, "supportedHosts">) {
  return [...new Set((agent.supportedHosts ?? []).map(normalizeHostValue))]
    .filter(Boolean)
    .sort((first, second) => first.localeCompare(second));
}

function hasUnknownHostValue(agent: Pick<CopilotPackage, "supportedHosts">) {
  return (
    !agent.supportedHosts?.length ||
    agent.supportedHosts.some((host) => !normalizeHostValue(host))
  );
}

function normalizeHostValue(host: string | null | undefined) {
  return typeof host === "string" ? host.trim() : "";
}

function matchesAvailableToFilter(value: string | undefined, filter: string) {
  if (filter === "all") {
    return true;
  }

  if (filter === someOrAllAvailableToValue) {
    return isAvailableToSomeOrAllValue(value);
  }

  const expectedValue = decodeAvailableToFilterValue(filter);
  return (
    value === expectedValue ||
    (!value && expectedValue === unknownAvailableToValue)
  );
}

function encodeAvailableToFilterValue(value: string) {
  return `${availableToFilterValuePrefix}${value}`;
}

function decodeAvailableToFilterValue(value: string) {
  return value.startsWith(availableToFilterValuePrefix)
    ? value.slice(availableToFilterValuePrefix.length)
    : value;
}

function isAvailableToSomeOrAllValue(value: string | undefined) {
  if (!value) {
    return false;
  }

  return someOrAllAvailableToNormalizedValues.has(normalizeFilterValue(value));
}

function normalizeFilterValue(value: string) {
  return value.replace(/[^a-z0-9]/gi, "").toLowerCase();
}

function formatRefreshTime(date: Date) {
  return date.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
}

function Metric({
  label,
  value,
  filteredValue,
}: {
  label: string;
  value: number;
  filteredValue?: number;
}) {
  const isFiltered = filteredValue !== undefined;

  return (
    <div className="metric">
      <span>{isFiltered ? `${label} / Filtered` : label}</span>
      <strong>
        {value.toLocaleString()}
        {isFiltered ? (
          <>
            {" / "}
            {filteredValue.toLocaleString()}
          </>
        ) : null}
      </strong>
    </div>
  );
}

function ExportProgressMeter({
  completed,
  mode,
  total,
}: {
  completed: number;
  mode: ExportMode;
  total: number;
}) {
  const completedPercent =
    total === 0 ? 100 : Math.round((completed / total) * 100);
  const modeLabel = mode === "fast" ? "fast export" : "full export";

  return (
    <div
      className="bulk-progress export-progress"
      role="status"
      aria-live="polite"
    >
      <div className="bulk-progress-header">
        <strong>
          Preparing {modeLabel}: {completed} of {total} agents
        </strong>
        <span>{completedPercent}%</span>
      </div>
      <progress value={completed} max={total || 1} />
      <div className="bulk-progress-meta">
        <span>{completed} finished</span>
        <span>{Math.max(total - completed, 0)} remaining</span>
      </div>
    </div>
  );
}

function AgentDisplayWindowControls({
  displayedCount,
  totalCount,
  hasMore,
  onLoadMore,
}: {
  displayedCount: number;
  totalCount: number;
  hasMore: boolean;
  onLoadMore: () => void;
}) {
  if (totalCount === 0) {
    return null;
  }

  const remainingCount = Math.max(0, totalCount - displayedCount);
  const nextCount = Math.min(agentDisplayPageSize, remainingCount);

  return (
    <div className="agent-display-window" aria-live="polite">
      <span>
        Showing {displayedCount.toLocaleString()} of{" "}
        {totalCount.toLocaleString()} matching agents
      </span>
      {hasMore ? (
        <button type="button" className="secondary" onClick={onLoadMore}>
          Load {nextCount.toLocaleString()} more
        </button>
      ) : null}
    </div>
  );
}

function chunks<T>(items: T[], size: number) {
  const result: T[][] = [];

  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }

  return result;
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
      <div className="app-footer-meta">
        <span className="app-footer-credit">
          <Bot size={15} strokeWidth={2.2} aria-hidden="true" />
          Developed by{" "}
          <strong className="app-footer-email">
            <em>candede@microsoft.com</em>
          </strong>{" "}
          on GitHub Copilot
        </span>
        <nav className="app-footer-links" aria-label="Creator links">
          <a
            className="app-footer-link"
            href="https://candede.com"
            target="_blank"
            rel="noreferrer noopener"
            aria-label="Open candede.com"
          >
            <Globe2 size={15} strokeWidth={2.2} aria-hidden="true" />
            candede.com
          </a>
          <a
            className="app-footer-link"
            href="https://www.linkedin.com/in/candede/"
            target="_blank"
            rel="noreferrer noopener"
            aria-label="Open LinkedIn profile"
          >
            <ExternalLink size={15} strokeWidth={2.2} aria-hidden="true" />
            LinkedIn
          </a>
        </nav>
      </div>
    </footer>
  );
}

function ReportImportPanel({
  reports,
  status,
  onImport,
  onClear,
}: {
  reports: UsageReportsState;
  status?: UsageImportStatus;
  onImport: (files: FileList | null) => void;
  onClear: () => void;
}) {
  const hasImportedReports = Boolean(
    reports.agents || reports.userAgents || reports.users,
  );
  const reportTiming = summarizeUsageReportTiming(reports);
  const now = new Date();
  const reportSourceAge = getReportSourceAgeDetails(reportTiming, now);

  return (
    <section className="report-panel" aria-label="Usage report import">
      <div className="report-panel-header">
        <div>
          <strong>Usage reports</strong>
          <span>
            {hasImportedReports
              ? `Saved: ${formatImportRowSummary(
                  summarizeUsageReportsState(reports),
                )}`
              : "Import the Agents, Users & agents, and Users CSV exports to enrich this view."}
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
            disabled={!hasImportedReports && !status}
            onClick={onClear}
          >
            Clear reports
          </button>
        </div>
      </div>

      {status || hasImportedReports ? (
        <div
          className={`report-status ${status?.kind ?? "success"}`}
          aria-live="polite"
        >
          <div className="report-status-row">
            <div className="report-status-copy">
              {status ? (
                <span className="report-status-message">{status.message}</span>
              ) : null}
              {hasImportedReports && reportSourceAge.sourceStamp ? (
                <span className="report-source-stamp">
                  Latest source stamp: {reportSourceAge.sourceStamp}
                </span>
              ) : null}
            </div>
            {hasImportedReports ? (
              <div
                className={`report-age${reportSourceAge.isStale ? " stale" : ""}`}
                aria-label="Usage report age"
              >
                <span>Report age</span>
                <strong>{reportSourceAge.value}</strong>
              </div>
            ) : null}
          </div>
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
  const summaryItems: Array<{
    label: string;
    value: number;
    icon: LucideIcon;
    tone: UsageReportKind;
  }> = [
    { label: "Agents", value: counts.agents, icon: Bot, tone: "agents" },
    {
      label: "Users & agents",
      value: counts.userAgents,
      icon: UsersRound,
      tone: "userAgents",
    },
    { label: "Users", value: counts.users, icon: UserRound, tone: "users" },
  ];

  return (
    <div className="modal-backdrop" role="presentation" onClick={onCancel}>
      <section
        className="confirm-modal usage-import-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="usage-import-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="usage-import-header">
          <span className="usage-import-header-icon" aria-hidden="true">
            <FileCheck2 size={22} strokeWidth={2.2} />
          </span>
          <div>
            <p className="eyebrow">CSV import</p>
            <h2 id="usage-import-title">Review usage reports</h2>
          </div>
        </div>

        <p className="usage-import-copy">
          Parsed {pendingImport.totalFiles.toLocaleString()} selected file
          {pendingImport.totalFiles === 1 ? "" : "s"}. Confirm to apply these
          usage metrics to the agent table.
        </p>

        <div
          className="confirm-summary usage-import-summary"
          aria-label="Parsed report rows"
        >
          {summaryItems.map((item) => {
            const Icon = item.icon;

            return (
              <span
                key={item.tone}
                className={`usage-import-stat ${item.tone}`}
              >
                <span className="usage-import-stat-label">
                  <Icon size={18} strokeWidth={2.15} aria-hidden="true" />
                  {item.label}
                </span>
                <strong>{item.value.toLocaleString()}</strong>
              </span>
            );
          })}
        </div>

        {pendingImport.reports.length ? (
          <section className="detail-section usage-import-section">
            <h3>Recognized reports</h3>
            <ul className="detail-list usage-report-list">
              {pendingImport.reports.map((report) => {
                const Icon = getUsageReportIcon(report.kind);

                return (
                  <li
                    key={`${report.kind}-${report.fileName}`}
                    className={`usage-report-card ${report.kind}`}
                  >
                    <span className="usage-report-icon" aria-hidden="true">
                      <Icon size={18} strokeWidth={2.15} />
                    </span>
                    <span className="usage-report-copy">
                      <strong>{formatReportKind(report.kind)}</strong>
                      <small>
                        {report.rows.length.toLocaleString()} rows
                        {report.periodDays
                          ? `, ${report.periodDays}-day export`
                          : ""}
                      </small>
                    </span>
                    <span className="usage-report-pill">Ready</span>
                  </li>
                );
              })}
            </ul>
          </section>
        ) : null}

        {pendingImport.failures.length ? (
          <section className="detail-section usage-import-section attention">
            <h3>Files that need attention</h3>
            <ul className="detail-list usage-attention-list">
              {pendingImport.failures.map((failure) => (
                <li
                  key={failure.fileName}
                  className="usage-report-card attention"
                >
                  <span className="usage-report-icon" aria-hidden="true">
                    <FileWarning size={18} strokeWidth={2.15} />
                  </span>
                  <span className="usage-report-copy">
                    <strong>{failure.fileName}</strong>
                    <small>{failure.message}</small>
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {pendingImport.warnings.length ? (
          <section className="detail-section usage-import-section warning">
            <h3>Warnings</h3>
            <ul className="detail-list usage-attention-list">
              {pendingImport.warnings.slice(0, 6).map((warning) => (
                <li key={warning} className="usage-report-card warning">
                  <span className="usage-report-icon" aria-hidden="true">
                    <TriangleAlert size={18} strokeWidth={2.15} />
                  </span>
                  <span className="usage-report-copy">
                    <small>{warning}</small>
                  </span>
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

function formatDetailLabel(value?: string) {
  if (!value) {
    return undefined;
  }

  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim();
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

function coalesceUsageReportsByKind(
  reports: ParsedUsageReport[],
  warnings: string[],
) {
  const reportsByKind = new Map<UsageReportKind, ParsedUsageReport>();

  for (const report of reports) {
    if (reportsByKind.has(report.kind)) {
      warnings.push(
        `Multiple ${formatReportKind(report.kind)} reports were selected; using ${report.fileName}.`,
      );
    }

    reportsByKind.set(report.kind, report);
  }

  return [...reportsByKind.values()];
}

function buildUsageByAgentId(
  reports: UsageReportsState,
  userAgentRowsByAgentId: Map<string, UserAgentUsageRow[]>,
) {
  const usageByAgentId = new Map<string, AgentUsageSummary>();
  const agentReport = reports.agents;

  if (agentReport) {
    for (const row of agentReport.rows) {
      if (!row.agentId) {
        continue;
      }

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

function isCreatedWithinDays(value: string | undefined, days: number) {
  if (!value) {
    return false;
  }

  const createdAt = new Date(value).getTime();

  if (Number.isNaN(createdAt)) {
    return false;
  }

  const elapsedMs = Date.now() - createdAt;
  return elapsedMs >= 0 && elapsedMs <= days * 86_400_000;
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

function parseOptionalPositiveInteger(value: string) {
  const parsed = Number(value);

  if (!Number.isFinite(parsed) || parsed < 1) {
    return undefined;
  }

  return Math.floor(parsed);
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

function getUsageReportIcon(kind: UsageReportKind): LucideIcon {
  if (kind === "agents") {
    return Bot;
  }

  if (kind === "userAgents") {
    return UsersRound;
  }

  return UserRound;
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

function summarizeUsageReportsState(reports: UsageReportsState) {
  return {
    agents: reports.agents?.rows.length ?? 0,
    userAgents: reports.userAgents?.rows.length ?? 0,
    users: reports.users?.rows.length ?? 0,
  } satisfies Record<UsageReportKind, number>;
}

function summarizeUsageReportTiming(reports: UsageReportsState) {
  const reportList = [reports.agents, reports.userAgents, reports.users].filter(
    (report): report is ParsedUsageReport => Boolean(report),
  );
  const sourceGeneratedAtValues = reportList
    .map(
      (report) =>
        report.sourceGeneratedAt ??
        parseUsageReportFileTimestamp(report.fileName),
    )
    .filter(isValidDateString);

  return {
    newestSourceGeneratedAt: latestTimestamp(sourceGeneratedAtValues),
    oldestSourceGeneratedAt: earliestTimestamp(sourceGeneratedAtValues),
    sourceGeneratedAtCount: sourceGeneratedAtValues.length,
    reportCount: reportList.length,
  };
}

function latestTimestamp(values: string[]) {
  return values.sort(
    (first, second) => Date.parse(second) - Date.parse(first),
  )[0];
}

function earliestTimestamp(values: string[]) {
  return values.sort(
    (first, second) => Date.parse(first) - Date.parse(second),
  )[0];
}

function isValidDateString(value: string | undefined): value is string {
  return Boolean(value && Number.isFinite(Date.parse(value)));
}

function getReportSourceAgeDetails(
  timing: ReturnType<typeof summarizeUsageReportTiming>,
  now: Date,
) {
  if (!timing.newestSourceGeneratedAt) {
    return {
      value: "Unavailable",
      sourceStamp: "No filename timestamp detected.",
      isStale: false,
    };
  }

  const newestAge = formatAgeInHours(timing.newestSourceGeneratedAt, now);
  const oldestAge = timing.oldestSourceGeneratedAt
    ? formatAgeInHours(timing.oldestSourceGeneratedAt, now)
    : newestAge;
  const ageLabel =
    timing.oldestSourceGeneratedAt &&
    timing.oldestSourceGeneratedAt !== timing.newestSourceGeneratedAt &&
    oldestAge !== newestAge
      ? `${newestAge} to ${oldestAge}`
      : newestAge;
  const missingStampCount = timing.reportCount - timing.sourceGeneratedAtCount;
  const oldestSourceAgeMs = timing.oldestSourceGeneratedAt
    ? now.getTime() - Date.parse(timing.oldestSourceGeneratedAt)
    : 0;

  return {
    value: `${ageLabel} old`,
    sourceStamp: `${formatUtcDateTime(timing.newestSourceGeneratedAt)}${
      missingStampCount > 0
        ? `; ${missingStampCount} report${missingStampCount === 1 ? "" : "s"} without a filename timestamp`
        : ""
    }`,
    isStale: oldestSourceAgeMs > 86_400_000,
  };
}

function formatAgeInHours(value: string, now: Date) {
  const elapsedMs = Math.max(0, now.getTime() - Date.parse(value));
  const elapsedHours = Math.floor(elapsedMs / 3_600_000);

  if (elapsedHours < 1) {
    return "less than 1 hour";
  }

  return `${elapsedHours.toLocaleString()} hour${elapsedHours === 1 ? "" : "s"}`;
}

function formatUtcDateTime(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
    timeZoneName: "short",
  }).format(new Date(value));
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

function ExportChoiceModal({
  agentCount,
  isFiltered,
  onCancel,
  onExport,
}: {
  agentCount: number;
  isFiltered: boolean;
  onCancel: () => void;
  onExport: (mode: ExportMode) => void;
}) {
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
        className="confirm-modal export-choice-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="export-choice-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div>
          <p className="eyebrow">Export agents</p>
          <h2 id="export-choice-title">Choose CSV export type</h2>
        </div>
        <p>
          Export {agentCount.toLocaleString()}{" "}
          {isFiltered ? "filtered" : "loaded"} agents. Full export includes
          detail-only fields and may take longer.
        </p>
        <div className="export-choice-grid">
          <button
            type="button"
            className="secondary export-choice-card"
            onClick={() => onExport("fast")}
          >
            <strong>Fast export</strong>
            <span>Use the current table data and imported usage reports.</span>
            <small>No per-agent detail lookups.</small>
          </button>
          <button
            type="button"
            className="export-choice-card"
            onClick={() => onExport("full")}
          >
            <strong>Full details</strong>
            <span>
              Include categories, sensitivity, access, and element details.
            </span>
            <small>Uses cached details and batched API calls.</small>
          </button>
        </div>
        <div className="confirm-actions">
          <button type="button" className="secondary" onClick={onCancel}>
            Cancel
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
