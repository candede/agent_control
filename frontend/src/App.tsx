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
  Globe2,
  Play,
  Square,
} from "lucide-react";
import {
  ApiError,
  blockAgent,
  blockAgents,
  downloadPackageInventoryCsv,
  getAgentDetails,
  getAgents,
  getPackageRefreshJob,
  getPackageRefreshJobs,
  getBulkActionJob,
  getCurrentUser,
  getWorkbenchMetadata,
  getOfficialUsageAggregate,
  getOfficialUsageUsers,
  cancelBulkActionJob,
  previewPackageMutation,
  reconcileBulkActionJob,
  resumeBulkActionJob,
  signOut,
  startExactPackageRefresh,
  startPackageRefresh,
  subscribeSessionRevalidationRequired,
  unblockAgent,
  unblockAgents,
  updateAgentAccess,
  updateAgentsAccess,
  type BulkActionJob,
  type BulkActionResult,
  type AuditAction,
  type CopilotPackage,
  type CopilotPackageDetail,
  type PackageMutationPreview,
  type PackageAccessUpdate,
  type PackageAccessTarget,
  type PackagePage,
  type PackageListQuery,
  type PackageRefreshJob,
  type OfficialUsageAggregateView,
  type OfficialUsageUserView,
  type SessionUser,
} from "./api/client";
import { downloadBlob } from "./agentExport";
import "./App.css";
import { isJobPolling, jobStatusMessage } from "./jobStatus";
import { parseBulkRefSearch } from "./bulkRefSearch";
import { projectVerifiedAccessScope } from "./packageMutationState";
import { clearPackageSelection, restorePackageSelection, storePackageSelection } from "./packageSelectionSession";
import { allowedViews, hasRole } from "./authorization";
import { useCapabilities } from "./useCapabilities";
import { providerActionAllowed } from "./capabilityState";
import { CapabilityGate } from "./components/CapabilityGate";
import { CapabilityContext } from "./capabilityContext";
import { CapabilityHealth, PermissionCenter } from "./components/PermissionCenter";
import { AgentDetailModal } from "./components/AgentDetailModal";
import { AccessAssignmentModal } from "./components/AccessAssignmentModal";
import { AgentTable } from "./components/AgentTable";
import { AuditLogView } from "./components/AuditLogView";
import { BulkActions, type BulkProgress } from "./components/BulkActions";
import { ReportingView } from "./components/ReportingView";
import { UserAccessView } from "./components/UserAccessView";
import { InventoryExplorer } from "./components/InventoryExplorer";
import { CopilotStudioQuarantineTargetPicker } from "./components/CopilotStudioQuarantineTargetPicker";
import { OfficialUsageImportPanel } from "./components/OfficialUsageImportPanel";
import { DefenderHuntingView } from "./components/DefenderHuntingView";
import { JobsView } from "./components/JobsView";
import { hasLegacyUsageStorage } from "./legacyUsageStorage";
import {
  agentRouteSearch,
  officialUsageRouteSearch,
  parseAgentRoute,
  parseOfficialUsageRoute,
  parsePowerPlatformRoute,
  parseWorkbenchView,
  workbenchUrl,
  type WorkbenchViewId,
} from "./workbenchRouting";
import { WorkbenchActionGate, WorkbenchActionProvider } from "./workbenchActionContext";

const activeBulkJobStorageKey = "agent-control:active-bulk-job:v1";
const bulkJobPollIntervalMs = 1_000;
const packageRefreshPollIntervalMs = 750;
const foregroundJobPollBudgetMs = 5 * 60_000;
const agentDisplayPageSize = 50;

function withPackageSummaryFallback(
  detail: CopilotPackageDetail,
  summary: CopilotPackage,
): CopilotPackageDetail {
  return {
    ...detail,
    availableTo: detail.availableTo ?? summary.availableTo,
    deployedTo: detail.deployedTo ?? summary.deployedTo,
  };
}

function LinkedAgentJobStatus({
  controlJob,
  error,
  refreshJob,
}: {
  controlJob?: BulkActionJob;
  error?: string;
  refreshJob?: PackageRefreshJob;
}) {
  return (
    <>
      {error ? <div className="error-banner" role="alert">{error}</div> : null}
      {refreshJob ? (
        <section className="controls" aria-label="Selected package refresh job">
          <strong>Package refresh · {refreshJob.status.replaceAll("_", " ")}</strong>
          <span>{refreshJob.observedCount}{refreshJob.totalRecords === null ? "" : ` of ${refreshJob.totalRecords}`} packages observed</span>
          <code>{refreshJob.id}</code>
          {refreshJob.message ? <span>{refreshJob.message}</span> : null}
        </section>
      ) : null}
      {controlJob ? (
        <section className="controls" aria-label="Selected package control job">
          <strong>Package {controlJob.action} · {controlJob.status.replaceAll("_", " ")}</strong>
          <span>{controlJob.completed} of {controlJob.total} exact targets complete</span>
          <code>{controlJob.id}</code>
        </section>
      ) : null}
    </>
  );
}

function App() {
  const initialAgentRoute = useRef(parseAgentRoute(window.location.search)).current;
  const initialOfficialUsageRoute = useRef(parseOfficialUsageRoute(window.location.search)).current;
  const [user, setUser] = useState<SessionUser>();
  const [sessionEpoch, setSessionEpoch] = useState(0);
  const [loadedWorkbenchMetadata, setLoadedWorkbenchMetadata] = useState<{
    principalKey: string;
    value: Awaited<ReturnType<typeof getWorkbenchMetadata>>;
  }>();
  const [legacyUsagePresent, setLegacyUsagePresent] = useState(hasLegacyUsageStorage);
  const capabilityState = useCapabilities(user);
  const [trackedJob, setTrackedJob] = useState<BulkActionJob>();
  const [linkedPackageRefreshJob, setLinkedPackageRefreshJob] = useState<PackageRefreshJob>();
  const [linkedJobError, setLinkedJobError] = useState<string>();
  const [authSetup, setAuthSetup] = useState<{ authConfigured: boolean; callback: string; setup?: string }>();
  const [agents, setAgents] = useState<CopilotPackage[]>([]);
  const [agentPage, setAgentPage] = useState<PackagePage>();
  const [savedAgentPageOwner, setSavedAgentPageOwner] = useState<{ principalKey: string; requestId: number }>();
  const [agentSnapshotId, setAgentSnapshotId] = useState<string>();
  const [loadingSession, setLoadingSession] = useState(true);
  const [loadingAgents, setLoadingAgents] = useState(false);
  const [error, setError] = useState<string>();
  const [query, setQuery] = useState(initialAgentRoute.search);
  const [statusFilter, setStatusFilter] = useState<
    "all" | "allowed" | "blocked"
  >(initialAgentRoute.status);
  const [publisherFilter, setPublisherFilter] = useState(initialAgentRoute.publisher);
  const [availableToFilter, setAvailableToFilter] = useState(initialAgentRoute.availability);
  const [hostFilter, setHostFilter] = useState(initialAgentRoute.host);
  const [platformFilter, setPlatformFilter] = useState(initialAgentRoute.platform);
  const [createdWithinDays, setCreatedWithinDays] = useState(initialAgentRoute.createdWithinDays);
  const [agentSortBy, setAgentSortBy] = useState<NonNullable<PackageListQuery["sortBy"]>>(initialAgentRoute.sortBy);
  const [agentSortDirection, setAgentSortDirection] = useState<NonNullable<PackageListQuery["sortDirection"]>>(initialAgentRoute.sortDirection);
  const [agentPageIndex, setAgentPageIndex] = useState(initialAgentRoute.page);
  const [selectedAgentIds, setSelectedAgentIds] = useState<Set<string>>(
    () => new Set(initialAgentRoute.selectedIds),
  );
  const [pendingStoredAgentSelectionCount, setPendingStoredAgentSelectionCount] = useState(
    initialAgentRoute.selectionStorage === "session" ? initialAgentRoute.selectionCount : undefined,
  );
  const [selectionRouteNotice, setSelectionRouteNotice] = useState<{ tone: "success" | "error"; text: string }>();
  const [busyAgentId, setBusyAgentId] = useState<string>();
  const [busyBulkAction, setBusyBulkAction] = useState<AuditAction>();
  const [bulkProgress, setBulkProgress] = useState<BulkProgress>();
  const [bulkResult, setBulkResult] = useState<BulkActionResult>();
  const [bulkConfirmation, setBulkConfirmation] = useState<BulkConfirmation>();
  const [bulkAccessAgentIds, setBulkAccessAgentIds] = useState<string[]>();
  const [agentDetail, setAgentDetail] = useState<CopilotPackageDetail>();
  const [agentDetailTab, setAgentDetailTab] = useState(initialAgentRoute.detailTab ?? "identities");
  const [requestedAgentDetailId, setRequestedAgentDetailId] = useState(initialAgentRoute.detailId);
  const [requestedPackageRefreshJobId, setRequestedPackageRefreshJobId] = useState(initialAgentRoute.refreshJobId);
  const [requestedPackageRefreshMode, setRequestedPackageRefreshMode] = useState(initialAgentRoute.refreshMode);
  const [requestedPackageControlJobId, setRequestedPackageControlJobId] = useState(initialAgentRoute.controlJobId);
  const [singleAccessAgentDetail, setSingleAccessAgentDetail] =
    useState<CopilotPackageDetail>();
  const [singleAccessTarget, setSingleAccessTarget] = useState<PackageAccessTarget>("availability");
  const [loadingAgentDetailId, setLoadingAgentDetailId] = useState<string>();
  const [agentDetailError, setAgentDetailError] = useState<string>();
  const [exportChoiceOpen, setExportChoiceOpen] = useState(false);
  const [exportingCsv, setExportingCsv] = useState(false);
  const [exportProgress, setExportProgress] = useState(0);
  const [exportProgressTotal, setExportProgressTotal] = useState(0);
  const [exportProgressMode, setExportProgressMode] =
    useState<ExportMode>("full");
  const [officialUsageAggregate, setOfficialUsageAggregate] =
    useState<OfficialUsageAggregateView>();
  const [officialUsageUsers, setOfficialUsageUsers] =
    useState<OfficialUsageUserView>();
  const [officialUsageUserOffset, setOfficialUsageUserOffset] = useState(0);
  const [officialUsageUserQuery, setOfficialUsageUserQuery] = useState<{
    search?: string;
    creatorType?: string;
    activity?: "all" | "recent" | "inactive" | "no-activity";
    responsesOnly?: boolean;
  }>({});
  const inactiveDays = 30;
  const [reportActivityWindowDays, setReportActivityWindowDays] = useState(initialOfficialUsageRoute.activityWindowDays);
  const [requestedOfficialUsageStagingId, setRequestedOfficialUsageStagingId] = useState(initialOfficialUsageRoute.stagingId);
  const [activeView, setActiveView] = useState<WorkbenchViewId>(() => parseWorkbenchView(window.location.pathname));
  const [lastAgentListRefreshAt, setLastAgentListRefreshAt] = useState<Date>();
  const [packageSnapshotExpiresAt, setPackageSnapshotExpiresAt] = useState<Date>();
  const [refreshingAgents, setRefreshingAgents] = useState(false);
  const [recentlyChangedAgentIds, setRecentlyChangedAgentIds] = useState<
    Set<string>
  >(() => new Set());
  const deferredQuery = useDeferredValue(query);
  const agentDetailRequestId = useRef(0);
  const agentListRequestId = useRef(0);
  const agentListAbortController = useRef<AbortController | undefined>(undefined);
  const bulkJobPollRequestId = useRef(0);
  const packageRefreshRequestId = useRef(0);
  const initialAgentRefreshAttempts = useRef(new Set<string>());
  const initialAgentRefreshChecks = useRef(new Set<string>());
  const initialAgentRefreshMounted = useRef(true);
  const linkedPackageRefreshRequestId = useRef(0);
  const officialUsageRequestId = useRef(0);
  const officialUsageAbortController = useRef<AbortController | undefined>(undefined);
  const sessionRevalidationInFlight = useRef(false);
  const resumedBulkJobIds = useRef(new Set<string>());
  const agentDetailsCache = useRef(new Map<string, CopilotPackageDetail>());
  const stateChangeVersions = useRef(new Map<string, number>());
  const stateChangeTimerIds = useRef(new Set<number>());
  const savedViewSearches = useRef(new Map<WorkbenchViewId, string>([
    [parseWorkbenchView(window.location.pathname), window.location.search],
  ]));
  const principalKey = user
    ? `${user.tenantId ?? ""}:${user.homeAccountId}:${[...user.roles].sort().join(",")}:${sessionEpoch}`
    : `signed-out:${sessionEpoch}`;
  const workbenchMetadata = loadedWorkbenchMetadata?.principalKey === principalKey
    ? loadedWorkbenchMetadata.value
    : undefined;
  const resumeBulkJob = useEffectEvent((jobId: string) => {
    void followBulkJob(jobId);
  });
  const loadLinkedControlJob = useEffectEvent((jobId: string) =>
    followBulkJob(jobId, undefined, false));
  const loadSavedAgents = useEffectEvent(() => {
    void loadAgents();
  });
  const loadSavedOfficialUsage = useEffectEvent(() => {
    void loadOfficialUsage();
  });
  const revalidateCurrentSession = useEffectEvent(() => {
    if (sessionRevalidationInFlight.current || (!user && loadingSession)) return;
    sessionRevalidationInFlight.current = true;
    clearPrivateState();
    setUser(undefined);
    void loadSession().finally(() => {
      sessionRevalidationInFlight.current = false;
    });
  });

  useEffect(() => {
    return subscribeSessionRevalidationRequired(() => revalidateCurrentSession());
  }, []);

  useEffect(() => {
    void loadSession();
  }, []);

  useEffect(() => {
    agentDetailRequestId.current += 1;
    agentListRequestId.current += 1;
    agentListAbortController.current?.abort();
    bulkJobPollRequestId.current += 1;
    packageRefreshRequestId.current += 1;
    linkedPackageRefreshRequestId.current += 1;
    officialUsageRequestId.current += 1;
    officialUsageAbortController.current?.abort();
    resumedBulkJobIds.current.clear();
    agentDetailsCache.current.clear();
    void Promise.resolve().then(() => {
      setAgents([]);
      setAgentPage(undefined);
      setAgentDetail(undefined);
      setTrackedJob(undefined);
      setLinkedPackageRefreshJob(undefined);
      setLinkedJobError(undefined);
      setBulkProgress(undefined);
      setBulkResult(undefined);
      setOfficialUsageAggregate(undefined);
      setOfficialUsageUsers(undefined);
      setLoadingAgentDetailId(undefined);
    });
  }, [principalKey]);

  useEffect(() => {
    if (!user) return;
    const controller = new AbortController();
    getWorkbenchMetadata({ signal: controller.signal })
      .then(value => setLoadedWorkbenchMetadata({ principalKey, value }))
      .catch((requestError) => {
        if (!(requestError instanceof ApiError && requestError.code === "request_aborted")) {
          setError(errorMessage(requestError));
        }
      });
    return () => controller.abort();
  }, [principalKey, user]);

  useEffect(() => {
    function restoreRoute() {
      agentDetailRequestId.current += 1;
      setLoadingAgentDetailId(undefined);
      setSingleAccessAgentDetail(undefined);
      setBulkAccessAgentIds(undefined);
      setBulkConfirmation(undefined);
      const view = parseWorkbenchView(window.location.pathname);
      if (view !== "agents") setAgentDetail(undefined);
      savedViewSearches.current.set(view, window.location.search);
      setActiveView(view);
      if (view === "agents") {
        const route = parseAgentRoute(window.location.search);
        setQuery(route.search);
        setStatusFilter(route.status);
        setPublisherFilter(route.publisher);
        setAvailableToFilter(route.availability);
        setHostFilter(route.host);
        setPlatformFilter(route.platform);
        setCreatedWithinDays(route.createdWithinDays);
        setAgentSortBy(route.sortBy);
        setAgentSortDirection(route.sortDirection);
        setAgentPageIndex(route.page);
        setSelectedAgentIds(new Set(route.selectionStorage === "session" ? [] : route.selectedIds));
        setPendingStoredAgentSelectionCount(route.selectionStorage === "session" ? route.selectionCount : undefined);
        if (route.selectionStorage !== "session") setSelectionRouteNotice(undefined);
        setAgentDetailTab(route.detailTab ?? "identities");
        setRequestedAgentDetailId(route.detailId);
        setRequestedPackageRefreshJobId(route.refreshJobId);
        setRequestedPackageRefreshMode(route.refreshMode);
        setRequestedPackageControlJobId(route.controlJobId);
        setAgentDetail(current => current?.id === route.detailId ? current : undefined);
      } else if (view === "official-usage") {
        const route = parseOfficialUsageRoute(window.location.search);
        setRequestedOfficialUsageStagingId(route.stagingId);
        setReportActivityWindowDays(route.activityWindowDays);
      }
    }
    window.addEventListener("popstate", restoreRoute);
    return () => window.removeEventListener("popstate", restoreRoute);
  }, []);

  useEffect(() => {
    if (!user || !hasRole(user, "AgentControl.Viewer") || pendingStoredAgentSelectionCount === undefined) return;
    let active = true;
    void Promise.resolve().then(() => {
      if (!active) return;
      const restored = restorePackageSelection(user, pendingStoredAgentSelectionCount);
      if (restored.status === "restored") {
        setSelectedAgentIds(new Set(restored.ids));
        setSelectionRouteNotice({
          tone: "success",
          text: `${restored.ids.length.toLocaleString()} selected packages were restored from this signed-in browser session.`,
        });
      } else {
        setSelectedAgentIds(new Set());
        setSelectionRouteNotice({
          tone: "error",
          text: `The prior ${pendingStoredAgentSelectionCount.toLocaleString()}-package selection could not be restored. No partial selection was applied.`,
        });
      }
      setPendingStoredAgentSelectionCount(undefined);
    });
    return () => {
      active = false;
    };
  }, [pendingStoredAgentSelectionCount, user]);

  useEffect(() => {
    if (activeView !== "agents" || pendingStoredAgentSelectionCount !== undefined) return;
    const search = agentRouteSearch({
      search: query,
      status: statusFilter,
      publisher: publisherFilter,
      availability: availableToFilter,
      host: hostFilter,
      platform: platformFilter,
      createdWithinDays,
      sortBy: agentSortBy,
      sortDirection: agentSortDirection,
      page: agentPageIndex,
      detailId: agentDetail?.id ?? requestedAgentDetailId,
      detailTab: agentDetailTab,
      selectedIds: [...selectedAgentIds],
      refreshJobId: requestedPackageRefreshJobId,
      refreshMode: requestedPackageRefreshMode,
      controlJobId: requestedPackageControlJobId,
    });
    const selectionStored = search.get("selectionState") === "session";
    const selectionSaved = selectionStored && user
      ? storePackageSelection(user, [...selectedAgentIds])
      : false;
    const next = workbenchUrl("agents", search);
    if (`${window.location.pathname}${window.location.search}` !== next) {
      window.history.replaceState({ view: "agents" }, "", next);
    }
    if (selectionStored) {
      void Promise.resolve().then(() => setSelectionRouteNotice({
        tone: selectionSaved ? "success" : "error",
        text: selectionSaved
          ? `${selectedAgentIds.size.toLocaleString()} selected packages are preserved only for this signed-in browser session and omitted from the URL.`
          : `The ${selectedAgentIds.size.toLocaleString()}-package selection remains active, but browser session storage is unavailable. It will not survive reload; no IDs were silently truncated.`,
      }));
    }
  }, [activeView, agentDetail?.id, agentDetailTab, agentPageIndex, agentSortBy, agentSortDirection, availableToFilter, createdWithinDays, hostFilter, pendingStoredAgentSelectionCount, platformFilter, publisherFilter, query, requestedAgentDetailId, requestedPackageControlJobId, requestedPackageRefreshJobId, requestedPackageRefreshMode, selectedAgentIds, statusFilter, user]);

  useEffect(() => {
    if (activeView !== "official-usage") return;
    const next = workbenchUrl("official-usage", officialUsageRouteSearch({
      stagingId: requestedOfficialUsageStagingId,
      activityWindowDays: reportActivityWindowDays,
    }));
    savedViewSearches.current.set("official-usage", next.includes("?") ? next.slice(next.indexOf("?")) : "");
    if (`${window.location.pathname}${window.location.search}` !== next) {
      window.history.replaceState({ view: "official-usage" }, "", next);
    }
  }, [activeView, reportActivityWindowDays, requestedOfficialUsageStagingId]);

  useEffect(() => {
    if (!user || !hasRole(user, "AgentControl.Viewer") || activeView !== "agents" || !requestedAgentDetailId || agentDetail?.id === requestedAgentDetailId || loadingAgentDetailId === requestedAgentDetailId) return;
    const summary = agents.find(agent => agent.id === requestedAgentDetailId);
    if (summary) {
      void handleViewAgentDetails(summary);
      return;
    }
    const requestId = ++agentDetailRequestId.current;
    void Promise.resolve().then(() => {
      if (requestId !== agentDetailRequestId.current) return;
      setLoadingAgentDetailId(requestedAgentDetailId);
      setAgentDetailError(undefined);
      return getAgentDetails(requestedAgentDetailId);
    }).then(detail => {
      if (detail && requestId === agentDetailRequestId.current) setAgentDetail(detail);
    }).catch(requestError => {
      if (requestId === agentDetailRequestId.current) {
        setRequestedAgentDetailId(undefined);
        setAgentDetailError(errorMessage(requestError));
      }
    }).finally(() => {
      if (requestId === agentDetailRequestId.current) setLoadingAgentDetailId(undefined);
    });
  }, [activeView, agentDetail?.id, agents, loadingAgentDetailId, requestedAgentDetailId, user]);

  useEffect(() => {
    if (!user || !hasRole(user, "AgentControl.Viewer") || activeView !== "agents" || !requestedPackageRefreshJobId) {
      void Promise.resolve().then(() => setLinkedPackageRefreshJob(undefined));
      return;
    }
    const owner = ++linkedPackageRefreshRequestId.current;
    const controller = new AbortController();
    let timer: number | undefined;
    const deadline = Date.now() + foregroundJobPollBudgetMs;
    const load = async () => {
      try {
        const job = await getPackageRefreshJob(requestedPackageRefreshJobId, requestedPackageRefreshMode, { signal: controller.signal });
        if (controller.signal.aborted || owner !== linkedPackageRefreshRequestId.current) return;
        setLinkedPackageRefreshJob(job);
        if (job.status === "running" && Date.now() < deadline) {
          timer = window.setTimeout(() => void load(), packageRefreshPollIntervalMs);
        }
      } catch (requestError) {
        if (!controller.signal.aborted && owner === linkedPackageRefreshRequestId.current) {
          setLinkedJobError(`The exact package refresh job is expired, deleted, or unavailable to this account. ${errorMessage(requestError)}`);
        }
      }
    };
    void Promise.resolve().then(() => {
      if (controller.signal.aborted) return;
      setLinkedPackageRefreshJob(undefined);
      setLinkedJobError(undefined);
      return load();
    });
    return () => {
      controller.abort();
      if (timer !== undefined) window.clearTimeout(timer);
      if (owner === linkedPackageRefreshRequestId.current) linkedPackageRefreshRequestId.current += 1;
    };
  }, [activeView, principalKey, requestedPackageRefreshJobId, requestedPackageRefreshMode, user]);

  useEffect(() => {
    if (!user || !hasRole(user, "AgentControl.Admin") || activeView !== "agents" || !requestedPackageControlJobId) return;
    let active = true;
    void Promise.resolve().then(() => {
      if (!active) return;
      setTrackedJob(undefined);
      setBulkResult(undefined);
      setLinkedJobError(undefined);
      return loadLinkedControlJob(requestedPackageControlJobId);
    });
    return () => {
      active = false;
      bulkJobPollRequestId.current += 1;
    };
  }, [activeView, principalKey, requestedPackageControlJobId, user]);

  useEffect(() => {
    if (!user || !hasRole(user, "AgentControl.Admin")) {
      return;
    }
    if (requestedPackageControlJobId || requestedPackageRefreshJobId) return;

    const jobId = loadStoredActiveBulkJobId();

    if (!jobId || resumedBulkJobIds.current.has(jobId)) {
      return;
    }

    resumedBulkJobIds.current.add(jobId);
    resumeBulkJob(jobId);
  }, [principalKey, requestedPackageControlJobId, requestedPackageRefreshJobId, user]);

  useEffect(() => {
    if (!user) {
      agentListAbortController.current?.abort();
      void Promise.resolve().then(() => {
        setAgents([]);
        setAgentPage(undefined);
        setAgentDetail(undefined);
      });
      return;
    }
    if (!hasRole(user, "AgentControl.Viewer")) {
      agentListAbortController.current?.abort();
      void Promise.resolve().then(() => {
        clearPackageSelection(user);
        setAgents([]);
        setAgentPage(undefined);
        setAgentSnapshotId(undefined);
        setSelectedAgentIds(new Set());
        setPendingStoredAgentSelectionCount(undefined);
        setSelectionRouteNotice(undefined);
        setBulkConfirmation(undefined);
        setBulkAccessAgentIds(undefined);
        setAgentDetail(undefined);
        setRequestedAgentDetailId(undefined);
        setRequestedPackageRefreshJobId(undefined);
        setRequestedPackageControlJobId(undefined);
        setTrackedJob(undefined);
        setLinkedPackageRefreshJob(undefined);
        setLinkedJobError(undefined);
      });
      return;
    }
    loadSavedAgents();
    return () => agentListAbortController.current?.abort();
  }, [agentPageIndex, agentSortBy, agentSortDirection, availableToFilter, createdWithinDays, deferredQuery, hostFilter, platformFilter, publisherFilter, statusFilter, user]);

  useEffect(() => {
    if (user) {
      loadSavedOfficialUsage();
    }
  }, [inactiveDays, officialUsageUserQuery, reportActivityWindowDays, officialUsageUserOffset, user]);

  useEffect(
    () => {
      initialAgentRefreshMounted.current = true;
      const timerIds = stateChangeTimerIds.current;
      return () => {
        initialAgentRefreshMounted.current = false;
        agentDetailRequestId.current += 1;
        packageRefreshRequestId.current += 1;
        for (const timerId of timerIds) {
          window.clearTimeout(timerId);
        }
      };
    },
    [],
  );

  const usageByAgentId = useMemo(() => new Map(), []);

  const allowedAgentCount = agentPage?.summary.allowed ?? 0;
  const blockedAgentCount = agentPage?.summary.blocked ?? 0;
  const publisherOptions = agentPage?.facets.publishers ?? [];
  const hostOptions = agentPage?.facets.hosts ?? [];
  const availableToOptions = agentPage?.facets.availability ?? [];
  const platformOptions = agentPage?.facets.platforms ?? [];

  const effectivePlatformFilter = platformFilter;

  const canReadSensitiveUsage = hasRole(user, "AgentControl.Viewer");
  const normalizedBulkRefQuery = parseBulkRefSearch(deferredQuery);
  const loadingBulkRefSearch = false;
  const authorizedViews = allowedViews(user);
  const visibleViews: WorkbenchViewId[] = workbenchMetadata
    ? workbenchMetadata.views.flatMap(view => {
        const id = authorizedViews.find(candidate => candidate === view.id);
        return id && (view.roles.length === 0 || view.roles.some(role => hasRole(user, role))) ? [id] : [];
      })
    : authorizedViews;
  const visibleActiveView = visibleViews.includes(activeView) ? activeView : visibleViews[0] ?? "permissions";
  const canOperate = hasRole(user, "AgentControl.Admin");
  const canImportReports = hasRole(user, "AgentControl.Admin");
  const initialAgentRefreshAllowed = useEffectEvent((owner: string) => {
    const refreshAction = workbenchMetadata?.actions.find(action => action.id === "packages.refresh");
    const readCapability = capabilityState.views.find(view => view.definition.id === "graph.package.read.delegated");
    return initialAgentRefreshMounted.current && principalKey === owner && user && hasRole(user, "AgentControl.Viewer")
      && !loadingSession && !sessionRevalidationInFlight.current && visibleActiveView === "agents"
      && !loadingAgents && savedAgentPageOwner?.principalKey === owner && savedAgentPageOwner.requestId === agentListRequestId.current
      && agentPage?.snapshot === null && !agentSnapshotId && !refreshingAgents
      && !linkedPackageRefreshJob && !requestedPackageRefreshJobId && !requestedPackageControlJobId
      && refreshAction?.roles.some(role => hasRole(user, role))
      && providerActionAllowed(readCapability, false, capabilityState.now);
  });
  const loadInitialAgents = useEffectEvent(async () => {
    const owner = principalKey;
    if (!initialAgentRefreshAllowed(owner) || !user) return;
    const account = `${user.tenantId ?? ""}\0${user.homeAccountId}`;
    if (initialAgentRefreshAttempts.current.has(account) || initialAgentRefreshChecks.current.has(account)) return;
    initialAgentRefreshChecks.current.add(account);
    const refreshRequest = packageRefreshRequestId.current;
    try {
      const jobs = await getPackageRefreshJobs("delegated");
      if (!initialAgentRefreshAllowed(owner) || refreshRequest !== packageRefreshRequestId.current) return;
      initialAgentRefreshAttempts.current.add(account);
      if (jobs.value.length || jobs.lastAttemptAt || jobs.lastSuccessAt) return;
      await handleRefreshAgents();
    } catch (requestError) {
      initialAgentRefreshAttempts.current.add(account);
      if (initialAgentRefreshAllowed(owner)) setError(errorMessage(requestError));
    } finally {
      initialAgentRefreshChecks.current.delete(account);
    }
  });

  useEffect(() => {
    let active = true;
    void Promise.resolve().then(() => { if (active) return loadInitialAgents(); });
    return () => { active = false; };
  }, [agentPage, agentSnapshotId, capabilityState.now, capabilityState.views, linkedPackageRefreshJob, loadingAgents, loadingSession, principalKey, refreshingAgents, requestedPackageControlJobId, requestedPackageRefreshJobId, savedAgentPageOwner, user, visibleActiveView, workbenchMetadata]);

  useEffect(() => {
    if (!user || visibleActiveView === activeView) return;
    window.history.replaceState({ view: visibleActiveView }, "", workbenchUrl(visibleActiveView));
  }, [activeView, user, visibleActiveView]);

  function navigateToView(view: WorkbenchViewId) {
    agentDetailRequestId.current += 1;
    setLoadingAgentDetailId(undefined);
    savedViewSearches.current.set(activeView, window.location.search);
    setAgentDetail(undefined);
    setRequestedAgentDetailId(undefined);
    setSingleAccessAgentDetail(undefined);
    setBulkAccessAgentIds(undefined);
    setBulkConfirmation(undefined);
    setExportChoiceOpen(false);
    setActiveView(view);
    const savedSearch = savedViewSearches.current.get(view) ?? "";
    const search = new URLSearchParams(savedSearch.startsWith("?") ? savedSearch.slice(1) : savedSearch);
    const next = workbenchUrl(view, search);
    if (`${window.location.pathname}${window.location.search}` !== next) {
      window.history.pushState({ view }, "", next);
    }
  }

  function handleReportActivityWindowChange(activityWindowDays: number) {
    const next = workbenchUrl("official-usage", officialUsageRouteSearch({
      stagingId: requestedOfficialUsageStagingId,
      activityWindowDays,
    }));
    savedViewSearches.current.set("official-usage", next.includes("?") ? next.slice(next.indexOf("?")) : "");
    if (`${window.location.pathname}${window.location.search}` !== next) {
      window.history.pushState({ view: "official-usage" }, "", next);
    }
    setReportActivityWindowDays(activityWindowDays);
  }

  const displayedAgents = agents;
  const filteredAllowedAgentCount = agentPage?.filteredSummary.allowed ?? 0;
  const filteredBlockedAgentCount = agentPage?.filteredSummary.blocked ?? 0;

  const hasActiveAgentFilters =
    deferredQuery.trim().length > 0 ||
    statusFilter !== "all" ||
    publisherFilter !== "all" ||
    availableToFilter !== "all" ||
    hostFilter !== "all" ||
    effectivePlatformFilter !== "all" ||
    parseOptionalPositiveInteger(createdWithinDays) !== undefined;

  const matchingSelectedCount = agents.filter((agent) =>
    selectedAgentIds.has(agent.id),
  ).length;
  const allMatchingSelected =
    agents.length > 0 &&
    matchingSelectedCount === agents.length;
  const exportableAgentCount = agentPage?.count ?? 0;

  function clearPrivateState() {
    clearPackageSelection(user);
    setSessionEpoch(current => current + 1);
    agentDetailRequestId.current += 1;
    agentListRequestId.current += 1;
    agentListAbortController.current?.abort();
    bulkJobPollRequestId.current += 1;
    packageRefreshRequestId.current += 1;
    linkedPackageRefreshRequestId.current += 1;
    officialUsageRequestId.current += 1;
    officialUsageAbortController.current?.abort();
    resumedBulkJobIds.current.clear();
    agentDetailsCache.current.clear();
    stateChangeVersions.current.clear();
    for (const timerId of stateChangeTimerIds.current) window.clearTimeout(timerId);
    stateChangeTimerIds.current.clear();
    clearStoredActiveBulkJobId();
    setLoadedWorkbenchMetadata(undefined);
    setAgents([]);
    setAgentPage(undefined);
    setSavedAgentPageOwner(undefined);
    setAgentSnapshotId(undefined);
    setSelectedAgentIds(new Set());
    setPendingStoredAgentSelectionCount(undefined);
    setSelectionRouteNotice(undefined);
    setBulkConfirmation(undefined);
    setBulkAccessAgentIds(undefined);
    setAgentDetail(undefined);
    setSingleAccessAgentDetail(undefined);
    setLoadingAgentDetailId(undefined);
    setAgentDetailError(undefined);
    setBusyAgentId(undefined);
    setBusyBulkAction(undefined);
    setExportChoiceOpen(false);
    setLastAgentListRefreshAt(undefined);
    setPackageSnapshotExpiresAt(undefined);
    setLoadingAgents(false);
    setRefreshingAgents(false);
    setRecentlyChangedAgentIds(new Set());
    setExportingCsv(false);
    setExportProgress(0);
    setExportProgressTotal(0);
    setBulkProgress(undefined);
    setBulkResult(undefined);
    setTrackedJob(undefined);
    setLinkedPackageRefreshJob(undefined);
    setLinkedJobError(undefined);
    setOfficialUsageAggregate(undefined);
    setOfficialUsageUsers(undefined);
    setOfficialUsageUserOffset(0);
  }

  async function loadSession() {
    setLoadingSession(true);
    setError(undefined);

    try {
      const setup = await fetch("/api/auth/status", { credentials: "include" });
      if (setup.ok) setAuthSetup(await setup.json());
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

  async function loadAgents(forceCurrentSnapshot = false) {
    const requestId = ++agentListRequestId.current;
    agentListAbortController.current?.abort();
    const controller = new AbortController();
    agentListAbortController.current = controller;
    setLoadingAgents(true);
    setError(undefined);

    try {
      const response = await getAgents({
        ...(!forceCurrentSnapshot && agentSnapshotId && savedAgentPageOwner?.principalKey === principalKey ? { snapshotId: agentSnapshotId } : {}),
        ...(normalizedBulkRefQuery ? { operationIdPrefix: normalizedBulkRefQuery } : deferredQuery.trim() ? { search: deferredQuery.trim() } : {}),
        ...(statusFilter === "all" ? {} : { blocked: statusFilter === "blocked" }),
        ...(publisherFilter === "all" ? {} : { publisher: publisherFilter }),
        ...(availableToFilter === "all" ? {} : { availableTo: availableToFilter }),
        ...(hostFilter === "all" ? {} : { host: hostFilter }),
        ...(effectivePlatformFilter === "all" ? {} : { platform: effectivePlatformFilter }),
        ...(parseOptionalPositiveInteger(createdWithinDays) ? { createdWithinDays: parseOptionalPositiveInteger(createdWithinDays) } : {}),
        sortBy: agentSortBy,
        sortDirection: agentSortDirection,
        limit: agentDisplayPageSize,
        offset: agentPageIndex * agentDisplayPageSize,
      }, { signal: controller.signal });
      if (requestId !== agentListRequestId.current || controller.signal.aborted) return;
      const lastPage = Math.max(Math.ceil(response.count / agentDisplayPageSize) - 1, 0);
      if (agentPageIndex > lastPage) {
        setAgentPageIndex(lastPage);
        return;
      }
      setAgents(response.value);
      setAgentPage(response);
      setSavedAgentPageOwner({ principalKey, requestId });
      setAgentSnapshotId(response.snapshot?.id);
      setLastAgentListRefreshAt(response.snapshot ? new Date(response.snapshot.observedAt) : undefined);
      setPackageSnapshotExpiresAt(response.snapshot ? new Date(response.snapshot.expiresAt) : undefined);
      agentDetailsCache.current.clear();
    } catch (requestError) {
      if (requestId === agentListRequestId.current && !(requestError instanceof ApiError && requestError.code === "request_aborted")) {
        setError(errorMessage(requestError));
      }
    } finally {
      if (requestId === agentListRequestId.current) setLoadingAgents(false);
    }
  }

  async function loadOfficialUsage() {
    const requestId = ++officialUsageRequestId.current;
    officialUsageAbortController.current?.abort();
    const controller = new AbortController();
    officialUsageAbortController.current = controller;
    if (!user) {
      setOfficialUsageAggregate(undefined);
      setOfficialUsageUsers(undefined);
      return;
    }

    const [aggregateResult, usersResult] = await Promise.allSettled([
      hasRole(user, "AgentControl.Viewer")
        ? getOfficialUsageAggregate({
            activityWindowDays: reportActivityWindowDays,
            inactiveDays,
        }, { signal: controller.signal })
        : Promise.resolve(undefined),
      hasRole(user, "AgentControl.Viewer")
        ? getOfficialUsageUsers(
          { ...officialUsageUserQuery, inactiveDays, limit: 100, offset: officialUsageUserOffset },
          { signal: controller.signal },
        )
        : Promise.resolve(undefined),
    ]);

    if (controller.signal.aborted || requestId !== officialUsageRequestId.current) return;
    if (aggregateResult.status === "fulfilled") {
      setOfficialUsageAggregate(aggregateResult.value);
    } else if (!(aggregateResult.reason instanceof ApiError && aggregateResult.reason.kind === "aborted")) {
      setError(errorMessage(aggregateResult.reason));
    }

    if (usersResult.status === "fulfilled") {
      setOfficialUsageUsers(usersResult.value);
    } else if (!(usersResult.reason instanceof ApiError && usersResult.reason.kind === "aborted")) {
      setError(errorMessage(usersResult.reason));
    }
    if (officialUsageAbortController.current === controller) officialUsageAbortController.current = undefined;
  }

  async function handleRefreshAgents() {
    if (!user || sessionRevalidationInFlight.current) return;
    initialAgentRefreshAttempts.current.add(`${user.tenantId ?? ""}\0${user.homeAccountId}`);
    const requestId = ++packageRefreshRequestId.current;
    const deadline = Date.now() + foregroundJobPollBudgetMs;
    setRefreshingAgents(true);
    setError(undefined);

    try {
      let job = await startPackageRefresh("delegated");
      if (packageRefreshRequestId.current !== requestId) return;
      while (job.status === "running" && Date.now() < deadline) {
        await wait(packageRefreshPollIntervalMs);
        if (packageRefreshRequestId.current !== requestId) return;
        job = await getPackageRefreshJob(job.id, job.tokenMode);
        if (packageRefreshRequestId.current !== requestId) return;
      }

      if (job.status === "running") throw new Error("Package refresh status polling reached its five-minute bound. The durable job remains available in Jobs.");
      if (job.status !== "succeeded") {
        throw new Error(job.message ?? (job.status === "waiting_authorization"
          ? "Package refresh requires current delegated read authorization. Open Permissions to request consent or retry the probe."
          : "Package refresh failed without replacing the last complete saved observation."));
      }
      await loadAgents(true);
    } catch (requestError) {
      if (packageRefreshRequestId.current === requestId) setError(errorMessage(requestError));
    } finally {
      if (packageRefreshRequestId.current === requestId) setRefreshingAgents(false);
    }
  }

  async function handleRefreshExactPackage(id: string) {
    const requestId = ++packageRefreshRequestId.current;
    const deadline = Date.now() + foregroundJobPollBudgetMs;
    setRefreshingAgents(true);
    setError(undefined);
    setAgentDetailError(undefined);
    try {
      let job = await startExactPackageRefresh(id, "delegated");
      while (job.status === "running" && Date.now() < deadline) {
        await wait(packageRefreshPollIntervalMs);
        if (packageRefreshRequestId.current !== requestId) return;
        job = await getPackageRefreshJob(job.id, job.tokenMode);
      }
      if (job.status === "running") throw new Error("Exact package refresh polling reached its five-minute bound. The durable job remains available in Jobs.");
      if (job.status !== "succeeded") throw new Error(job.message ?? "Exact package refresh requires current delegated package-read authorization.");
      setRequestedAgentDetailId(id);
    } catch (requestError) {
      setAgentDetailError(errorMessage(requestError));
    } finally {
      if (packageRefreshRequestId.current === requestId) setRefreshingAgents(false);
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

    clearPrivateState();
    setUser(undefined);
  }

  function handleSearchQueryChange(nextQuery: string) {
    setQuery(nextQuery);
  }

  async function handleViewAgentDetails(agent: CopilotPackage) {
    const requestId = agentDetailRequestId.current + 1;
    agentDetailRequestId.current = requestId;

    setAgentDetailError(undefined);
    setAgentDetail(undefined);
    setRequestedAgentDetailId(agent.id);
    setLoadingAgentDetailId(agent.id);

    try {
      const detail = withPackageSummaryFallback(
        await getAgentDetails(agent.id),
        agent,
      );

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

  async function refreshAccessDetails(id: string, requestId: number, deadline = Date.now() + foregroundJobPollBudgetMs) {
    const access = capabilityState.views.find(view => view.definition.id === "graph.package.access.manage");
    if (!hasRole(user, "AgentControl.Admin") || !providerActionAllowed(access, true, Date.now())) {
      throw new Error("Current Admin access and package access-management authorization are required.");
    }
    let job = await startExactPackageRefresh(id, "delegated");
    if (agentDetailRequestId.current !== requestId) return;
    while (job.status === "running" && Date.now() < deadline) {
      await wait(packageRefreshPollIntervalMs);
      if (agentDetailRequestId.current !== requestId) return;
      job = await getPackageRefreshJob(job.id, job.tokenMode);
      if (agentDetailRequestId.current !== requestId) return;
    }
    if (job.status === "running") throw new Error("Reading current package access reached its five-minute bound. The read-only job remains available in Jobs.");
    if (job.status !== "succeeded") throw new Error(job.message ?? "Microsoft Graph could not load current package access. Check delegated permissions and retry.");
    const detail = await getAgentDetails(id);
    if (agentDetailRequestId.current !== requestId) return;
    agentDetailsCache.current.set(id, detail);
    return detail;
  }

  async function handleManageAgentAccess(agent: CopilotPackage, target: PackageAccessTarget = "availability") {
    const requestId = agentDetailRequestId.current + 1;
    agentDetailRequestId.current = requestId;

    setAgentDetailError(undefined);
    setSingleAccessAgentDetail(undefined);
    setLoadingAgentDetailId(agent.id);

    try {
      const detail = await refreshAccessDetails(agent.id, requestId);
      if (!detail) return;

      if (agentDetailRequestId.current === requestId) {
        setSingleAccessTarget(target);
        setSingleAccessAgentDetail(detail);
        if (agentDetail?.id === agent.id) setAgentDetail(detail);
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
      const action = targetBlockedState ? "block" : "unblock";
      const preview = await previewPackageMutation({ action, ids: [agent.id], mutationScope: "single" });
      setBulkConfirmation({ action, ids: [agent.id], mutationScope: "single", preview });
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

    await requestAccessConfirmation([agentDetail.id], update, "single");
  }

  async function requestAccessConfirmation(
    ids: string[],
    update: PackageAccessUpdate,
    mutationScope: "single" | "bulk",
  ) {
    if (mutationScope === "single" && update.mode !== "replace") {
      throw new Error("Single-agent access updates must replace assignments.");
    }

    setError(undefined);
    const action = update.target === "availability" ? "update-availability" : "update-installation";
    const requestId = agentDetailRequestId.current;
    const preview = await previewPackageMutation({ action, ids, mutationScope, accessUpdate: update });
    if (agentDetailRequestId.current !== requestId) return;
    setBulkConfirmation({ action, ids, mutationScope, preview, accessUpdate: update });
  }

  function requestExportCsv() {
    if (exportableAgentCount === 0 || exportingCsv) {
      return;
    }

    setExportChoiceOpen(true);
  }

  async function handleExportCsv() {
    if (exportableAgentCount === 0 || exportingCsv || !agentSnapshotId) {
      return;
    }

    setExportChoiceOpen(false);
    setError(undefined);
    setExportingCsv(true);
    setExportProgressMode("fast");
    setExportProgress(0);
    setExportProgressTotal(exportableAgentCount);

    try {
      const blob = await downloadPackageInventoryCsv({
        snapshotId: agentSnapshotId,
        filters: {
          ...(normalizedBulkRefQuery ? { operationIdPrefix: normalizedBulkRefQuery } : deferredQuery.trim() ? { search: deferredQuery.trim() } : {}),
          ...(statusFilter === "all" ? {} : { blocked: statusFilter === "blocked" }),
          ...(publisherFilter === "all" ? {} : { publisher: publisherFilter }),
          ...(availableToFilter === "all" ? {} : { availableTo: availableToFilter }),
          ...(hostFilter === "all" ? {} : { host: hostFilter }),
          ...(effectivePlatformFilter === "all" ? {} : { platform: effectivePlatformFilter }),
          ...(parseOptionalPositiveInteger(createdWithinDays) ? { createdWithinDays: parseOptionalPositiveInteger(createdWithinDays) } : {}),
          sortBy: agentSortBy,
          sortDirection: agentSortDirection,
        },
      });
      setExportProgress(exportableAgentCount);
      downloadBlob("package-inventory.csv", blob);
    } catch (requestError) {
      setError(errorMessage(requestError));
    } finally {
      setExportingCsv(false);
      setExportProgress(0);
      setExportProgressTotal(0);
    }
  }

  async function requestBulkAction(targetBlockedState: boolean) {
    const label = targetBlockedState ? "block" : "unblock";
    const scope = [...selectedAgentIds];

    if (scope.length === 0) {
      setError("Select one or more agents before running a bulk action.");
      return;
    }

    setError(undefined);
    try {
      const preview = await previewPackageMutation({ action: label, ids: scope, mutationScope: "bulk" });
      setBulkConfirmation({ action: label, ids: scope, mutationScope: "bulk", preview });
    } catch (requestError) {
      setError(errorMessage(requestError));
    }
  }

  async function runConfirmedBulkAction(confirmation: BulkConfirmation) {
    const { action: label, ids, mutationScope, preview, accessUpdate } = confirmation;

    setBulkConfirmation(undefined);

    setBusyBulkAction(label);
    setBulkProgress(accessUpdate ? {
      action: label as "update-availability" | "update-installation",
      accessUpdate,
      total: ids.length,
      completed: 0,
      succeeded: 0,
      failed: 0,
      skipped: 0,
      currentAgentName: "starting server-side bulk job",
    } : {
      action: label as "block" | "unblock",
      targetBlockedState: label === "block",
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
      let job: BulkActionJob;
      if (accessUpdate) {
        if (mutationScope === "single") {
          if (accessUpdate.mode !== "replace") throw new Error("Single-agent access updates must replace assignments.");
          job = await updateAgentAccess(ids[0], accessUpdate, preview.confirmationHash);
        } else {
          job = await updateAgentsAccess(ids, accessUpdate, preview.confirmationHash);
        }
      } else if (mutationScope === "single") {
        job = label === "block"
          ? await blockAgent(ids[0], preview.confirmationHash)
          : await unblockAgent(ids[0], preview.confirmationHash);
      } else {
        job = label === "block"
          ? await blockAgents(ids, preview.confirmationHash)
          : await unblockAgents(ids, preview.confirmationHash);
      }

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
    if (selectedAgentIds.size === 0) {
      setError("Select one or more agents before managing access.");
      return;
    }

    setError(undefined);
    setBulkAccessAgentIds([...selectedAgentIds]);
  }

  async function runBulkAccessUpdate(update: PackageAccessUpdate) {
    const ids = bulkAccessAgentIds ?? [];

    if (ids.length === 0) {
      throw new Error("The selected agents are no longer available.");
    }

    setError(undefined);
    setBulkResult(undefined);
    const requestId = ++agentDetailRequestId.current;
    const deadline = Date.now() + foregroundJobPollBudgetMs;

    try {
      for (const id of ids) {
        if (Date.now() >= deadline) throw new Error("Reading current access for the selected packages reached its five-minute bound. Select fewer packages and retry.");
        if (!await refreshAccessDetails(id, requestId, deadline)) return;
      }
      await requestAccessConfirmation(ids, update, "bulk");
      if (agentDetailRequestId.current !== requestId) return;
      setBulkAccessAgentIds(undefined);
    } catch (requestError) {
      if (agentDetailRequestId.current !== requestId) return;
      setError(errorMessage(requestError));
      throw requestError;
    }
  }

  async function followBulkJob(jobId: string, initialJob?: BulkActionJob, persist = true) {
    const requestId = bulkJobPollRequestId.current + 1;
    bulkJobPollRequestId.current = requestId;
    let keepStored = true;
    const deadline = Date.now() + foregroundJobPollBudgetMs;

    try {
      let job = initialJob ?? (await getBulkActionJob(jobId));
      if (bulkJobPollRequestId.current !== requestId) return;
      setTrackedJob(job);

      setBusyBulkAction(job.action);
      setBulkProgress(toBulkProgress(job));
      if (persist) saveStoredActiveBulkJobId(job.id);

      while (isJobPolling(job.status) && Date.now() < deadline) {
        await wait(bulkJobPollIntervalMs);

        if (bulkJobPollRequestId.current !== requestId) {
          return;
        }
        job = await getBulkActionJob(jobId);

        if (bulkJobPollRequestId.current !== requestId) {
          return;
        }

        setBulkProgress(toBulkProgress(job));
        setTrackedJob(job);
      }

      if (isJobPolling(job.status)) {
        keepStored = persist;
        setError("Package job polling reached its five-minute bound. The durable job remains available for explicit refresh in Jobs.");
        return;
      }

      keepStored = job.canResume || job.status === "waiting_authorization";
      if (job.result) {
        if (persist) applyBulkActionResult(job.result);
        else setBulkResult(job.result);
      }
      setError(jobStatusMessage(job.status));
    } catch (requestError) {
      if (bulkJobPollRequestId.current === requestId) {
        if (persist) setError(errorMessage(requestError));
        else setLinkedJobError(`The exact package control job is expired, deleted, or unavailable to this account. ${errorMessage(requestError)}`);
      }
    } finally {
      if (bulkJobPollRequestId.current === requestId) {
        setBusyBulkAction(undefined);
        setBulkProgress(undefined);
        if (persist && !keepStored) clearStoredActiveBulkJobId();
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

      setAgents((currentAgents) => currentAgents.map(agent => changedIds.includes(agent.id)
        ? projectVerifiedAccessScope(agent, result.accessUpdate!)
        : agent));

      if (agentDetail && changedIds.includes(agentDetail.id)) {
        setAgentDetail(undefined);
      }

      if (
        singleAccessAgentDetail &&
        changedIds.includes(singleAccessAgentDetail.id)
      ) {
        setSingleAccessAgentDetail(undefined);
      }

      markAgentStatesChanged(changedIds);
    }

    setBulkResult(result);
    setSelectionRouteNotice(undefined);
    setSelectedAgentIds(
      new Set(
        result.results
          .filter((result) => result.status === "failed")
          .map((result) => result.id),
      ),
    );
  }

  async function handleResumeJob() {
    if (!trackedJob || !window.confirm("Resume only unsent items with your current authorization? Inconclusive writes will not be replayed.")) return;
    try { const job = await resumeBulkActionJob(trackedJob.id); await followBulkJob(job.id, job); }
    catch (requestError) { setError(errorMessage(requestError)); }
  }

  async function handleCancelJob() {
    if (!trackedJob) return;
    try { setTrackedJob(await cancelBulkActionJob(trackedJob.id)); }
    catch (requestError) { setError(errorMessage(requestError)); }
  }

  async function handleReconcileJob() {
    if (!trackedJob) return;
    setError(undefined);
    try {
      const reconciled = await reconcileBulkActionJob(trackedJob.id);
      setTrackedJob(reconciled);
      if (reconciled.result) setBulkResult(reconciled.result);
      if (reconciled.reconciliation.failed) {
        setError(`${reconciled.reconciliation.failed} provider read${reconciled.reconciliation.failed === 1 ? "" : "s"} could not be reconciled.`);
      }
    } catch (requestError) {
      setError(errorMessage(requestError));
    }
  }

  function handleClearAgentFilters() {
    handleSearchQueryChange("");
    setStatusFilter("all");
    setPublisherFilter("all");
    setAvailableToFilter("all");
    setHostFilter("all");
    setPlatformFilter("all");
    setCreatedWithinDays("");
    setAgentPageIndex(0);
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
    setSingleAccessAgentDetail((currentDetail) =>
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
    setSelectionRouteNotice(undefined);
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
    setSelectionRouteNotice(undefined);
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
    const authorizationOutcome = new URLSearchParams(window.location.search).get("authorization");
    const authorizationNotice = authorizationOutcome === "cancelled"
      ? "Microsoft permission setup was cancelled or denied. You can retry, or sign in without provider setup and complete it later in Permissions."
      : authorizationOutcome === "interaction_required"
        ? "Microsoft requires additional sign-in, consent, or Conditional Access steps. Complete those steps or contact your tenant administrator."
        : authorizationOutcome === "failed"
          ? "Microsoft did not complete sign-in or permission setup. Retry or contact your tenant administrator." : undefined;
    return (
      <main className="signed-out">
        <section className="signin-panel" aria-labelledby="signin-title">
          <p className="eyebrow">Microsoft 365 Copilot administration</p>
          <h1 id="signin-title">Agent Control</h1>
          <p className="signin-lede">
            Sign in with an assigned Viewer or Admin work account. Microsoft will
            request any outstanding delegated permissions for all implemented
            features, including inventory, directory lookup, investigations,
            package changes, and Copilot Studio quarantine during sign-in.
          </p>
          <p>Already approved permissions normally need no further consent. Consent does not run investigations or change provider data; Microsoft roles and licenses still apply.</p>
          {authorizationNotice ? <p role="status">{authorizationNotice}</p> : null}
          {error ? <div className="error-banner">{error}</div> : null}
          {authSetup?.authConfigured === false ? <div className="error-banner"><strong>Sign-in is not configured.</strong><p>{authSetup.setup}</p><code>{authSetup.callback}</code></div> : null}
          <div className="signin-actions">
            <a className="primary-link signin-button" aria-disabled={authSetup?.authConfigured === false} href={authSetup?.authConfigured === false ? undefined : "/api/auth/login"}>
              Sign in with Entra ID
            </a>
            <a aria-disabled={authSetup?.authConfigured === false} href={authSetup?.authConfigured === false ? undefined : "/api/auth/login?setup=defer&returnTo=%2Fpermissions"}>
              Sign in without provider setup
            </a>
            <span>Use deferred setup when an administrator must approve permissions or you only need locally saved data.</span>
          </div>
        </section>
        <AppFooter />
      </main>
    );
  }

  return (
    <CapabilityContext value={{ ...capabilityState, openPermissions: () => navigateToView("permissions") }}>
    <WorkbenchActionProvider value={workbenchMetadata?.actions}>
    <main className="app-shell">
      <header className="top-bar">
        <div className="title-block">
          <p className="eyebrow">Tenant package controls</p>
          <h1>Agent Control</h1>
        </div>
        <div className="user-menu">
          <CapabilityHealth />
          <span>{user.displayName || user.username}</span>
          <button type="button" onClick={() => void handleSignOut()}>
            Sign out
          </button>
        </div>
        <nav className="view-switcher" aria-label="Primary views">
              {visibleViews.includes("agents") ? (
              <CapabilityGate roles={["AgentControl.Viewer"]}>
              <button
                type="button"
                className={
                  visibleActiveView === "agents" ? "view-button active" : "view-button"
                }
                aria-current={visibleActiveView === "agents" ? "page" : undefined}
                onClick={() => navigateToView("agents")}
              >
                Agents
              </button>
              </CapabilityGate>
              ) : null}
              {visibleViews.includes("power-platform") ? (
              <CapabilityGate roles={["AgentControl.Viewer"]}>
              <button type="button" className={visibleActiveView === "power-platform" ? "view-button active" : "view-button"} aria-current={visibleActiveView === "power-platform" ? "page" : undefined} onClick={() => navigateToView("power-platform")}>Power Platform</button>
              </CapabilityGate>
              ) : null}
              {visibleViews.includes("users") ? (
              <CapabilityGate roles={["AgentControl.Viewer"]}>
              <button
                type="button"
                className={
                  visibleActiveView === "users" ? "view-button active" : "view-button"
                }
                aria-current={visibleActiveView === "users" ? "page" : undefined}
                onClick={() => navigateToView("users")}
              >
                Users
              </button>
              </CapabilityGate>
              ) : null}
              {visibleViews.includes("official-usage") ? (
              <CapabilityGate roles={["AgentControl.Viewer"]}>
              <button
                type="button"
                className={
                  visibleActiveView === "official-usage"
                    ? "view-button active"
                    : "view-button"
                }
                aria-current={visibleActiveView === "official-usage" ? "page" : undefined}
                onClick={() => navigateToView("official-usage")}
              >
                Official usage
              </button>
              </CapabilityGate>
              ) : null}
              {visibleViews.includes("audit") ? (
              <CapabilityGate roles={["AgentControl.Viewer"]}>
              <button
                type="button"
                className={
                  visibleActiveView === "audit" ? "view-button active" : "view-button"
                }
                aria-current={visibleActiveView === "audit" ? "page" : undefined}
                onClick={() => navigateToView("audit")}
              >
                Audit
              </button>
              </CapabilityGate>
              ) : null}
              {visibleViews.includes("security") ? <CapabilityGate roles={["AgentControl.Viewer"]}><button type="button" className={visibleActiveView === "security" ? "view-button active" : "view-button"} aria-current={visibleActiveView === "security" ? "page" : undefined} onClick={() => navigateToView("security")}>Security</button></CapabilityGate> : null}
              <button type="button" className={visibleActiveView === "permissions" ? "view-button active" : "view-button"} aria-current={visibleActiveView === "permissions" ? "page" : undefined} onClick={() => navigateToView("permissions")}>Permissions</button>
              {visibleViews.includes("jobs") ? <button type="button" className={visibleActiveView === "jobs" ? "view-button active" : "view-button"} aria-current={visibleActiveView === "jobs" ? "page" : undefined} onClick={() => navigateToView("jobs")}>Jobs</button> : null}
        </nav>
      </header>

      {error ? <div className="error-banner">{error}</div> : null}
      {legacyUsagePresent && visibleActiveView !== "official-usage" ? (
        <div className="report-status error" role="status">
          <strong>Legacy browser report data is present in this browser.</strong>
          <p>It was not read or migrated. Re-import the original Microsoft exports, or ask an AgentControl.Admin to explicitly discard the legacy copy.</p>
          {canImportReports ? <button type="button" className="secondary" onClick={() => navigateToView("official-usage")}>Open Official usage</button> : null}
        </div>
      ) : null}

      {visibleActiveView === "permissions" ? <PermissionCenter /> : visibleActiveView === "agents" ? (
        !hasRole(user, "AgentControl.Viewer") ? (
          <>
            <LinkedAgentJobStatus refreshJob={linkedPackageRefreshJob} controlJob={requestedPackageControlJobId ? trackedJob : undefined} error={linkedJobError} />
            <ExactPackageLookup
              loading={Boolean(loadingAgentDetailId)}
              error={agentDetailError}
              onLookup={(id) => {
                setAgentDetailError(undefined);
                setRequestedAgentDetailId(id);
              }}
              onRefresh={(id) => void handleRefreshExactPackage(id)}
            />
          </>
        ) : (
        <>
          <LinkedAgentJobStatus refreshJob={linkedPackageRefreshJob} controlJob={requestedPackageControlJobId ? trackedJob : undefined} error={linkedJobError} />
          <section className="summary-grid" aria-label="Agent summary">
            <Metric
              label="Total"
              value={agentPage?.summary.total ?? 0}
              filteredValue={
                hasActiveAgentFilters ? agentPage?.filteredSummary.total : undefined
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
          </section>

          {canOperate ? <BulkActions
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
            onBlockAll={() => void requestBulkAction(true)}
            onManageAccess={requestBulkAccessUpdate}
            onUnblockAll={() => void requestBulkAction(false)}
          /> : null}

          {selectionRouteNotice ? (
            <div className={selectionRouteNotice.tone === "error" ? "error-banner" : "report-status"} role="status">
              {selectionRouteNotice.text}
            </div>
          ) : null}
          {canOperate && trackedJob && (isJobPolling(trackedJob.status) || trackedJob.canResume || trackedJob.status === "partial" || trackedJob.status === "waiting_authorization") ? (
            <section className="controls" aria-label="Job controls">
              <span role="status">{jobStatusMessage(trackedJob.status) ?? "Job running"}</span>
              {trackedJob.status === "waiting_authorization" ? <a href="/api/auth/login">Sign in again</a> : null}
              {trackedJob.canResume ? <WorkbenchActionGate actionId="packages.resume"><button type="button" onClick={() => void handleResumeJob()}><Play size={16} aria-hidden="true" /> Resume unsent items</button></WorkbenchActionGate> : null}
              {trackedJob.results.some(result => result.status === "inconclusive" && result.reconciliationStatus === "required") ? <WorkbenchActionGate actionId="packages.reconcile"><button type="button" className="secondary" onClick={() => void handleReconcileJob()}>Reconcile inconclusive</button></WorkbenchActionGate> : null}
              {isJobPolling(trackedJob.status) || trackedJob.canResume ? <WorkbenchActionGate actionId="packages.cancel"><button type="button" onClick={() => void handleCancelJob()}><Square size={16} aria-hidden="true" /> Cancel unsent items</button></WorkbenchActionGate> : null}
            </section>
          ) : null}

          <section className="controls catalog-controls" aria-label="Filters">
            <div
              className="filter-section filter-section-primary"
              aria-label="Find agents"
            >
              <span className="filter-section-title">Find agents</span>
              <label className="filter-search">
                <span>Search</span>
                <input
                  className={
                    query.trim().length > 0 ? "active-filter-input" : undefined
                  }
                  type="search"
                  value={query}
                  onChange={(event) =>
                    { handleSearchQueryChange(event.target.value); setAgentPageIndex(0); }
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
                    { setStatusFilter(event.target.value as "all" | "allowed" | "blocked"); setAgentPageIndex(0); }
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
                  onChange={(event) => { setAvailableToFilter(event.target.value); setAgentPageIndex(0); }}
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
                  onChange={(event) => { setPublisherFilter(event.target.value); setAgentPageIndex(0); }}
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
                  onChange={(event) => { setHostFilter(event.target.value); setAgentPageIndex(0); }}
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
                  onChange={(event) => { setPlatformFilter(event.target.value); setAgentPageIndex(0); }}
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
                      { setCreatedWithinDays(event.target.value); setAgentPageIndex(0); }
                    }
                    placeholder="Any"
                  />
                  <span>days</span>
                </div>
              </label>
              <label>
                <span>Sort by</span>
                <select value={agentSortBy} onChange={(event) => { setAgentSortBy(event.target.value as NonNullable<PackageListQuery["sortBy"]>); setAgentPageIndex(0); }}>
                  <option value="displayName">Name</option>
                  <option value="publisher">Publisher</option>
                  <option value="lastModifiedAt">Last modified</option>
                </select>
              </label>
              <label>
                <span>Direction</span>
                <select value={agentSortDirection} onChange={(event) => { setAgentSortDirection(event.target.value as "asc" | "desc"); setAgentPageIndex(0); }}>
                  <option value="asc">Ascending</option>
                  <option value="desc">Descending</option>
                </select>
              </label>
            </div>

            <div
              className="filter-actions catalog-filter-actions"
              aria-label="Table actions"
            >
              <div className="filter-action-buttons">
                <WorkbenchActionGate actionId="packages.refresh"><button
                  type="button"
                  className="icon-button control-icon-button"
                  aria-label={
                    refreshingAgents ? "Refreshing agents" : "Refresh agents"
                  }
                  title={refreshingAgents ? "Refreshing agents" : "Refresh agents"}
                  disabled={loadingAgents || refreshingAgents}
                  onClick={() => void handleRefreshAgents()}
                >
                  <RefreshIcon />
                </button></WorkbenchActionGate>
                <WorkbenchActionGate actionId="packages.export"><button
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
                </button></WorkbenchActionGate>
              </div>
              <span className="last-refresh" aria-live="polite">
                {lastAgentListRefreshAt
                  ? `Saved Graph observation ${formatRefreshTime(
                      lastAgentListRefreshAt,
                    )}${packageSnapshotExpiresAt && packageSnapshotExpiresAt.getTime() <= Date.now() ? " / expired" : " / v1.0 read, preview controls"}`
                  : refreshingAgents ? "Loading your agents from Microsoft Graph; no provider settings are changed."
                    : "No saved package observation. An initial read-only load starts here when authorized; Refresh agents retries it."}
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
          {loadingAgents ? (
            <div className="screen-state">Loading Copilot agents...</div>
          ) : (
            <div className="agent-table-stack">
              <AgentTable
                agents={displayedAgents}
                busyAgentId={busyAgentId}
                selectedIds={selectedAgentIds}
                recentlyChangedIds={recentlyChangedAgentIds}
                operationsAllowed={canOperate}
                selectionDisabled={Boolean(busyBulkAction)}
                usageByAgentId={usageByAgentId}
                allMatchingSelected={allMatchingSelected}
                selectedCount={selectedAgentIds.size}
                onToggleAgentSelection={toggleAgentSelection}
                onToggleMatchingSelection={() =>
                  toggleMatchingSelection(agents)
                }
                onViewDetails={(agent) => void handleViewAgentDetails(agent)}
                onManageAccess={(agent) => void handleManageAgentAccess(agent)}
                onBlock={(agent) => void handleAgentAction(agent, true)}
                onUnblock={(agent) => void handleAgentAction(agent, false)}
              />
              <AgentPageControls
                pageIndex={agentPageIndex}
                pageSize={agentDisplayPageSize}
                totalCount={agentPage?.count ?? 0}
                loading={loadingAgents}
                onPageChange={setAgentPageIndex}
              />
            </div>
          )}
        </>
        )
      ) : visibleActiveView === "power-platform" ? (
        hasRole(user, "AgentControl.Viewer")
          ? <InventoryExplorer key={principalKey} canManageQuarantine={Boolean(user && hasRole(user, "AgentControl.Admin"))} />
          : <CopilotStudioQuarantineTargetPicker key={principalKey} initialJobId={parsePowerPlatformRoute(window.location.search).quarantineJobId} />
      ) : visibleActiveView === "users" ? (
        <UserAccessView
          data={officialUsageUsers}
          onPageChange={setOfficialUsageUserOffset}
          onQueryChange={(query) => {
            setOfficialUsageUserOffset(0);
            setOfficialUsageUserQuery(query);
          }}
        />
      ) : visibleActiveView === "official-usage" ? (
        <section className="official-usage-workbench" aria-label="Official usage">
          {canImportReports ? <OfficialUsageImportPanel key={principalKey} initialStagingId={requestedOfficialUsageStagingId} onChanged={() => void loadOfficialUsage()} onLegacyCleared={() => setLegacyUsagePresent(false)} /> : null}
          {hasRole(user, "AgentControl.Viewer") ? <ReportingView
            activityWindowDays={reportActivityWindowDays}
            data={officialUsageAggregate}
            inactiveDays={inactiveDays}
            onActivityWindowDaysChange={handleReportActivityWindowChange}
            userData={canReadSensitiveUsage ? officialUsageUsers : undefined}
          /> : null}
        </section>
      ) : visibleActiveView === "audit" ? (
        <AuditLogView key={principalKey} agents={agents} />
      ) : visibleActiveView === "security" ? (
        <DefenderHuntingView key={principalKey} />
      ) : visibleActiveView === "jobs" ? (
        <JobsView key={principalKey} user={user} />
      ) : <div className="screen-state">No Agent Control app role is assigned.</div>}

      {loadingAgentDetailId ? (
        <div className="detail-loading" role="status" aria-live="polite">
          Loading agent details...
        </div>
      ) : null}

      {agentDetailError && !agentDetail ? (
        <div className="error-banner" role="alert">{agentDetailError}</div>
      ) : null}

      {agentDetail ? (
        <AgentDetailModal
          agent={agentDetail}
          activeTab={agentDetailTab}
          onTabChange={setAgentDetailTab}
          roles={user?.roles ?? []}
          onClose={() => { agentDetailRequestId.current += 1; setLoadingAgentDetailId(undefined); setAgentDetail(undefined); setRequestedAgentDetailId(undefined); }}
          onEditAccess={target => void handleManageAgentAccess(agentDetail, target)}
          preparingAccess={Boolean(loadingAgentDetailId)}
          accessError={agentDetailError}
          externalAccessEditorOpen={singleAccessAgentDetail?.id === agentDetail.id}
          onUpdateAccess={handleUpdateAgentAccess}
          onSetBlocked={async (blocked) => {
            await handleAgentAction(agentDetail, blocked);
            setAgentDetail(undefined);
            setRequestedAgentDetailId(undefined);
          }}
        />
      ) : null}

      {singleAccessAgentDetail ? (
        <AccessAssignmentModal
          context="single"
          agentCount={1}
          initialTarget={singleAccessTarget}
          initialStatus={singleAccessTarget === "availability" ? singleAccessAgentDetail.availableTo : singleAccessAgentDetail.deployedTo}
          initialPrincipals={singleAccessTarget === "availability" ? singleAccessAgentDetail.allowedUsersAndGroups : singleAccessAgentDetail.acquireUsersAndGroups}
          onCancel={() => setSingleAccessAgentDetail(undefined)}
          onSubmit={async (update) => {
            await requestAccessConfirmation([singleAccessAgentDetail.id], update, "single");
            setSingleAccessAgentDetail(undefined);
          }}
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
          onExport={() => void handleExportCsv()}
        />
      ) : null}

      <AppFooter />
    </main>
    </WorkbenchActionProvider>
    </CapabilityContext>
  );
}

type ExportMode = "fast" | "full";

export type BulkConfirmation = {
  action: AuditAction;
  ids: string[];
  mutationScope: "single" | "bulk";
  preview: PackageMutationPreview;
  accessUpdate?: PackageAccessUpdate;
};

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

function formatRefreshTime(date: Date) {
  return date.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
}

function ExactPackageLookup({ loading, error, onLookup, onRefresh }: {
  loading: boolean;
  error?: string;
  onLookup: (id: string) => void;
  onRefresh: (id: string) => void;
}) {
  const [nativeId, setNativeId] = useState("");
  return <section className="screen-state exact-package-lookup" aria-labelledby="exact-package-heading">
    <h2 id="exact-package-heading">Exact package targeting</h2>
    <p>Enter one known Microsoft Graph package native ID to inspect that exact target.</p>
    <form onSubmit={event => {
      event.preventDefault();
      const id = nativeId.trim();
      if (id && id.length <= 512 && !/[\r\n\0]/.test(id)) onLookup(id);
    }}>
      <label><span>Graph package native ID</span><input value={nativeId} maxLength={512} onChange={event => setNativeId(event.target.value)} /></label>
      <button type="submit" disabled={loading || !nativeId.trim()}>Inspect exact package</button>
      <WorkbenchActionGate actionId="packages.refresh.exact"><button type="button" className="secondary" disabled={loading || !nativeId.trim()} onClick={() => {
        const id = nativeId.trim();
        if (id && id.length <= 512 && !/[\r\n\0]/.test(id)) onRefresh(id);
      }}>Refresh exact package</button></WorkbenchActionGate>
    </form>
    {loading ? <p role="status">Loading exact package…</p> : null}
    {error ? <p role="alert">{error}</p> : null}
  </section>;
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

function AgentPageControls({
  pageIndex,
  pageSize,
  totalCount,
  loading,
  onPageChange,
}: {
  pageIndex: number;
  pageSize: number;
  totalCount: number;
  loading: boolean;
  onPageChange: (page: number) => void;
}) {
  const pageCount = Math.max(Math.ceil(totalCount / pageSize), 1);
  const start = totalCount ? pageIndex * pageSize + 1 : 0;
  const end = Math.min((pageIndex + 1) * pageSize, totalCount);
  return (
    <div className="agent-display-window" aria-live="polite">
      <span>{start.toLocaleString()}-{end.toLocaleString()} of {totalCount.toLocaleString()} matching agents</span>
      <div>
        <button type="button" className="secondary" disabled={loading || pageIndex === 0} onClick={() => onPageChange(Math.max(0, pageIndex - 1))}>Previous</button>
        <span>Page {pageIndex + 1} of {pageCount}</span>
        <button type="button" className="secondary" disabled={loading || pageIndex + 1 >= pageCount} onClick={() => onPageChange(pageIndex + 1)}>Next</button>
      </div>
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

function formatDetailLabel(value?: string) {
  if (!value) {
    return undefined;
  }

  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim();
}

function parseOptionalPositiveInteger(value: string) {
  const parsed = Number(value);

  if (!Number.isFinite(parsed) || parsed < 1) {
    return undefined;
  }

  return Math.floor(parsed);
}

export function BulkConfirmModal({
  confirmation,
  onCancel,
  onConfirm,
}: {
  confirmation: BulkConfirmation;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { summary } = confirmation.preview;
  const actionLabel = formatDetailLabel(summary.operation) ?? summary.operation;

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
          <p className="eyebrow">Confirm preview package mutation</p>
          <h2 id="bulk-confirm-title">{actionLabel} {summary.targetCount === 1 ? "package" : "packages"}?</h2>
        </div>
        <p>
          Review the saved prestate and requested state. The server will reread
          each exact native package target immediately before one dispatch and
          fail it if the mutation-relevant state changed.
        </p>
        {(summary.operation === "update-availability" || summary.operation === "update-installation") && <p role="note">Access updates can overwrite concurrent administrator changes.</p>}
        <div className="confirm-summary" aria-label="Bulk action summary">
          <span>
            <strong>{summary.targetCount}</strong> targets
          </span>
          <span>
            <strong>{summary.risk ? "Preview write risk" : "Review"}</strong>
            <span>{summary.affectedPrincipalCount} affected principals</span>
          </span>
          <span>
            <strong>{summary.scope}</strong> scope
          </span>
        </div>
        <dl className="permission-metadata confirm-metadata">
          <div><dt>Provider</dt><dd>{summary.provider}</dd></div>
          <div><dt>Endpoint</dt><dd><code>{summary.endpoint}</code> / {summary.apiMaturity}</dd></div>
          <div><dt>Permission</dt><dd>{summary.permission}</dd></div>
          <div><dt>Actor</dt><dd>{summary.actor.displayName} ({summary.actor.username})</dd></div>
          <div><dt>Rollback</dt><dd>{summary.rollback}</dd></div>
          <div><dt>Target selection hash</dt><dd><code>{summary.targetSelectionHash}</code></dd></div>
        </dl>
        <ul className="confirm-agent-list" aria-label="Exact package mutation preview">
          {summary.targets.map((target) => (
            <li key={target.id}>
              <span>{target.displayName}</span>
              <small><code>{target.id}</code></small>
              <small>Current: <code>{JSON.stringify(target.currentState)}</code></small>
              <small>Requested: <code>{JSON.stringify(target.requestedState)}</code></small>
            </li>
          ))}
        </ul>
        {summary.additionalTargetCount > 0 ? (
          <p className="confirm-muted">
            {summary.additionalTargetCount} more exact package targets are included in the hashed selection.
          </p>
        ) : null}
        <div className="confirm-actions">
          <button type="button" className="secondary" onClick={onCancel}>
            Cancel
          </button>
          <WorkbenchActionGate actionId={confirmation.accessUpdate ? "packages.access" : summary.operation === "block" ? "packages.block" : "packages.unblock"}>
          <button
            type="button"
            className={summary.operation === "block" || confirmation.accessUpdate?.scope === "none" ? "danger" : undefined}
            onClick={onConfirm}
          >
            Confirm {actionLabel.toLowerCase()}
          </button>
          </WorkbenchActionGate>
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
  onExport: () => void;
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
          <h2 id="export-choice-title">Export authorized CSV</h2>
        </div>
        <p>
          Export {agentCount.toLocaleString()}{" "}
          {isFiltered ? "filtered" : "loaded"} agents from the current saved
          package snapshot. The server rechecks your current role and scope.
        </p>
        <div className="export-choice-grid">
          <WorkbenchActionGate actionId="packages.export">
          <button
            type="button"
            className="secondary export-choice-card"
            onClick={onExport}
          >
            <strong>Download package inventory</strong>
            <span>Exports only the exact filtered package IDs from the selected saved snapshot.</span>
            <small>Formula-safe CSV with source, observation, and expiry fields.</small>
          </button>
          </WorkbenchActionGate>
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
    if (error.code === "invalid_origin") return error.message;
    if (error.status === 403) {
      return `${error.message} Open Permissions for the current account's exact requirements. Consent does not assign roles or licenses.`;
    }

    if (error.status === 503) {
      return `${error.message} Check Permissions and the local deployment setup.`;
    }

    return error.message;
  }

  if (error instanceof Error) {
    return error.message;
  }

  return "An unexpected error occurred.";
}

export default App;
