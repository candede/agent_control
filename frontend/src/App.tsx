import {
  useDeferredValue,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
} from "react";
import {
  Bot,
  ExternalLink,
  Globe2,
  Play,
  Square,
  Upload,
} from "lucide-react";
import {
  ApiError,
  blockAgent,
  blockAgents,
  downloadInventoryCsv,
  downloadUnifiedAgentInventoryCsv,
  getAgentDetails,
  getAgents,
  getUnifiedAgents,
  getPackageRefreshJob,
  getPackageRefreshJobs,
  getInventoryRefreshJob,
  getInventoryRefreshJobs,
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
  refreshPackageIdentityDetails,
  refreshInventory,
  resumeInventoryRefresh,
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
  type DataSyncSourceId,
  type PackageMutationPreview,
  type PackageAccessUpdate,
  type PackageAccessTarget,
  type PackagePage,
  type PackageListQuery,
  type PackageRefreshJob,
  type InventoryRefreshJob,
  type PowerPlatformResource,
  type OfficialUsageAggregateView,
  type OfficialUsageUserQuery,
  type OfficialUsageUserView,
  type SessionUser,
  type UnifiedAgentInventoryPage,
  type UnifiedAgentRecord,
  type UnifiedAgentExportQuery,
} from "./api/client";
import { downloadBlob, isSavedAgentRevision, maximumUnifiedAgentExportRows, selectedAgentExportReferences, type UnifiedAgentExportScope } from "./agentExport";
import "./App.css";
import { isJobPolling, jobStatusMessage } from "./jobStatus";
import { parseBulkRefSearch } from "./bulkRefSearch";
import { projectVerifiedAccessScope } from "./packageMutationState";
import { clearPackageSelection, restorePackageSelection, storePackageSelection } from "./packageSelectionSession";
import { allowedViews, hasRole } from "./authorization";
import { useCapabilities } from "./useCapabilities";
import { parseUnifiedAgentRecordId, unifiedAgentRecordId } from "../../backend/src/types/unifiedAgents";
import { providerActionAllowed } from "./capabilityState";
import { quarantineTargetKey, quarantineTargetReason, type QuarantineSelectionSnapshot } from "./quarantineTarget";
import { findUnifiedAgentRecord } from "./unifiedAgentIdentity";
import { CapabilityGate } from "./components/CapabilityGate";
import { CapabilityContext } from "./capabilityContext";
import { CapabilityHealth, PermissionCenter } from "./components/PermissionCenter";
import { AccessAssignmentModal } from "./components/AccessAssignmentModal";
import { UnifiedAgentTable } from "./components/UnifiedAgentTable";
import { UnifiedAgentDetailModal } from "./components/UnifiedAgentDetailModal";
import { AuditLogView } from "./components/AuditLogView";
import { BulkActions, type BulkProgress } from "./components/BulkActions";
import { ReportingView } from "./components/ReportingView";
import { CopilotUsersView } from "./components/CopilotUsersView";
import { InventoryExplorer } from "./components/InventoryExplorer";
import { CopilotStudioQuarantineControls } from "./components/CopilotStudioQuarantineControls";
import { CopilotStudioQuarantineTargetPicker } from "./components/CopilotStudioQuarantineTargetPicker";
import { OfficialUsageImportModal } from "./components/OfficialUsageImportModal";
import { OfficialUsageHistoryPanel } from "./components/OfficialUsageHistoryPanel";
import { DataSyncPanel, type DataSyncPanelHandle } from "./components/DataSyncPanel";
import { AgentSyncTools } from "./components/AgentSyncTools";
import { EnvironmentFilter } from "./components/EnvironmentFilter";
import { DefenderHuntingView } from "./components/DefenderHuntingView";
import { JobsView } from "./components/JobsView";
import { hasLegacyUsageStorage } from "./legacyUsageStorage";
import {
  agentRouteSearch,
  dataSyncRouteSearch,
  parseDataSyncRoute,
  officialUsageRouteSearch,
  migratePowerPlatformAgentRoute,
  parseAgentRoute,
  parseOfficialUsageRoute,
  parsePowerPlatformRoute,
  parseWorkbenchView,
  workbenchUrl,
  type AgentRouteState,
  type WorkbenchViewId,
} from "./workbenchRouting";
import { WorkbenchActionGate, WorkbenchActionProvider } from "./workbenchActionContext";

const activeBulkJobStorageKey = "agent-control:active-bulk-job:v1";
const bulkJobPollIntervalMs = 1_000;
const packageRefreshPollIntervalMs = 750;
const inventoryRefreshPollIntervalMs = 1_000;
const foregroundJobPollBudgetMs = 5 * 60_000;
const identityCollectionPollBudgetMs = 16 * 60_000;
const agentDisplayPageSize = 50;
const agentSortOptions = [
  { value: "displayName:asc", label: "Name (A-Z)", sortBy: "displayName", direction: "asc" },
  { value: "displayName:desc", label: "Name (Z-A)", sortBy: "displayName", direction: "desc" },
  { value: "lastModifiedAt:desc", label: "Modified (newest)", sortBy: "lastModifiedAt", direction: "desc" },
  { value: "lastModifiedAt:asc", label: "Modified (oldest)", sortBy: "lastModifiedAt", direction: "asc" },
] as const;

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
        <section className="job-status-panel" aria-label="Selected package refresh job">
          <strong>Package refresh · {refreshJob.status.replaceAll("_", " ")}</strong>
          <span>{refreshJob.observedCount}{refreshJob.totalRecords === null ? "" : ` of ${refreshJob.totalRecords}`} packages observed</span>
          <code>{refreshJob.id}</code>
          {refreshJob.message ? <span>{refreshJob.message}</span> : null}
        </section>
      ) : null}
      {controlJob ? (
        <section className="job-status-panel" aria-label="Selected package control job">
          <strong>Package {controlJob.action} · {controlJob.status.replaceAll("_", " ")}</strong>
          <span>{controlJob.completed} of {controlJob.total} exact targets complete</span>
          <code>{controlJob.id}</code>
        </section>
      ) : null}
    </>
  );
}

function readInitialAgentRoute() {
  const syncRoute = parseDataSyncRoute(window.location.search);
  if (parseWorkbenchView(window.location.pathname) === "agents" && (syncRoute.syncRunId || (syncRoute.refreshJobId && !parseAgentRoute(window.location.search).controlJobId))) {
    window.history.replaceState({ view: "sync" }, "", workbenchUrl("sync", dataSyncRouteSearch(syncRoute)));
  }
  if (parseWorkbenchView(window.location.pathname) === "power-platform") {
    const migrated = migratePowerPlatformAgentRoute(window.location.search);
    if (migrated) {
      window.history.replaceState({ view: "agents" }, "", workbenchUrl("agents", migrated));
    }
  }
  return parseAgentRoute(window.location.search);
}

function App() {
  const [initialAgentRoute] = useState(readInitialAgentRoute);
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
  const [bulkJobStorageError, setBulkJobStorageError] = useState<string>();
  const [linkedPackageRefreshJob, setLinkedPackageRefreshJob] = useState<PackageRefreshJob>();
  const [linkedJobError, setLinkedJobError] = useState<string>();
  const [authSetup, setAuthSetup] = useState<{ authConfigured: boolean; callback: string; setup?: string }>();
  const [agents, setAgents] = useState<CopilotPackage[]>([]);
  const [agentPage, setAgentPage] = useState<PackagePage>();
  const [unifiedAgentPage, setUnifiedAgentPage] = useState<UnifiedAgentInventoryPage>();
  const [unifiedAgentReadError, setUnifiedAgentReadError] = useState<string>();
  const [selectedUnifiedAgent, setSelectedUnifiedAgent] = useState<UnifiedAgentRecord>();
  const [selectedPowerPlatformTargets, setSelectedPowerPlatformTargets] = useState<Map<string, PowerPlatformResource>>(new Map());
  const [selectedPowerPlatformSnapshot, setSelectedPowerPlatformSnapshot] = useState<QuarantineSelectionSnapshot | null>(null);
  const [pendingPowerPlatformIds, setPendingPowerPlatformIds] = useState<Set<string>>(() => new Set(initialAgentRoute.selectedPowerPlatformIds));
  const [agentEnvironmentFilter, setAgentEnvironmentFilter] = useState(initialAgentRoute.environmentId);
  const [requestedQuarantineJobId, setRequestedQuarantineJobId] = useState(initialAgentRoute.quarantineJobId);
  const [requestedInventorySnapshotId, setRequestedInventorySnapshotId] = useState(initialAgentRoute.inventorySnapshotId);
  const [savedAgentPageOwner, setSavedAgentPageOwner] = useState<{ principalKey: string; requestId: number; verificationOnly: boolean }>();
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
  const [showAdvancedFilters, setShowAdvancedFilters] = useState(() => countAdvancedAgentFilters(initialAgentRoute) > 0);
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
  const [requestedDataSyncRunId, setRequestedDataSyncRunId] = useState(initialAgentRoute.syncRunId);
  const [syncSetupRequired, setSyncSetupRequired] = useState(false);
  const [syncHistoryRevision, setSyncHistoryRevision] = useState(0);
  const [singleAccessAgentDetail, setSingleAccessAgentDetail] =
    useState<CopilotPackageDetail>();
  const [singleAccessTarget, setSingleAccessTarget] = useState<PackageAccessTarget>("availability");
  const [loadingAgentDetailId, setLoadingAgentDetailId] = useState<string>();
  const [agentDetailError, setAgentDetailError] = useState<string>();
  const [exportChoiceOpen, setExportChoiceOpen] = useState(false);
  const [exportingCsv, setExportingCsv] = useState(false);
  const [agentExportError, setAgentExportError] = useState<{ message: string; reloadRequired: boolean }>();
  const [exportingPowerPlatformCsv, setExportingPowerPlatformCsv] = useState(false);
  const [refreshingPowerPlatformAgents, setRefreshingPowerPlatformAgents] = useState(false);
  const [powerPlatformAgentRefreshJob, setPowerPlatformAgentRefreshJob] = useState<InventoryRefreshJob>();
  const [agentReloadRevision, setAgentReloadRevision] = useState(0);
  const [officialUsageAggregate, setOfficialUsageAggregate] =
    useState<OfficialUsageAggregateView>();
  const [officialUsageAggregateSetId, setOfficialUsageAggregateSetId] =
    useState<string | null>();
  const [officialUsageUsers, setOfficialUsageUsers] =
    useState<OfficialUsageUserView>();
  const [officialUsageUsersSetId, setOfficialUsageUsersSetId] =
    useState<string | null>();
  const [loadingOfficialUsage, setLoadingOfficialUsage] = useState(false);
  const [officialUsageLoadError, setOfficialUsageLoadError] = useState<string>();
  const [officialUsageAgentOffset, setOfficialUsageAgentOffset] = useState(0);
  const [officialUsageAgentQuery, setOfficialUsageAgentQuery] = useState<{
    search?: string;
    creatorType?: string;
    startDate?: string;
    endDate?: string;
    sortBy?: "agentName" | "responses" | "licensedUsers" | "unlicensedUsers" | "lastActivity";
    sortDirection?: "asc" | "desc";
  }>({});
  const [officialUsageUserOffset, setOfficialUsageUserOffset] = useState(0);
  const [officialUsageUserQuery, setOfficialUsageUserQuery] = useState<OfficialUsageUserQuery>({});
  const [officialUsageDashboardRevision, setOfficialUsageDashboardRevision] = useState(0);
  const [copilotUsersDataRevision, setCopilotUsersDataRevision] = useState(0);
  const [powerPlatformDataRevision, setPowerPlatformDataRevision] = useState(0);
  const [usageImportOpenRequest, setUsageImportOpenRequest] = useState(0);
  const inactiveDays = 30;
  const [reportActivityWindowDays, setReportActivityWindowDays] = useState(initialOfficialUsageRoute.activityWindowDays);
  const [requestedOfficialUsageStagingId, setRequestedOfficialUsageStagingId] = useState(initialOfficialUsageRoute.stagingId);
  const [officialUsageReportSetId, setOfficialUsageReportSetId] = useState(initialOfficialUsageRoute.reportSetId);
  const [activeView, setActiveView] = useState<WorkbenchViewId>(() => parseWorkbenchView(window.location.pathname));
  const [lastAgentListRefreshAt, setLastAgentListRefreshAt] = useState<Date>();
  const [packageSnapshotExpiresAt, setPackageSnapshotExpiresAt] = useState<Date>();
  const [refreshingAgents, setRefreshingAgents] = useState(false);
  const [, setRecentlyChangedAgentIds] = useState<
    Set<string>
  >(() => new Set());
  const deferredQuery = useDeferredValue(query);
  const agentDetailRequestId = useRef(0);
  const agentDetailAbortController = useRef<AbortController | undefined>(undefined);
  const unifiedAgentDetailPage = useRef<UnifiedAgentInventoryPage | undefined>(undefined);
  const agentListRequestId = useRef(0);
  const agentListAbortController = useRef<AbortController | undefined>(undefined);
  const forceCurrentAgentReload = useRef(false);
  const verificationOnlyAgentReload = useRef(false);
  const bulkJobPollRequestId = useRef(0);
  const packageRefreshRequestId = useRef(0);
  const identityBackfills = useRef(new Set<string>());
  const inventoryRefreshRequestId = useRef(0);
  const linkedPackageRefreshRequestId = useRef(0);
  const officialUsageRequestId = useRef(0);
  const officialUsageAbortController = useRef<AbortController | undefined>(undefined);
  const dataSyncPanelRef = useRef<DataSyncPanelHandle>(null);
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
  const sessionOwnerRef = useRef<string | undefined>(principalKey);
  const activeViewRef = useRef(activeView);
  const workbenchMetadata = loadedWorkbenchMetadata?.principalKey === principalKey
    ? loadedWorkbenchMetadata.value
    : undefined;
  const resumeBulkJob = useEffectEvent((jobId: string) => {
    void followBulkJob(jobId);
  });
  const loadLinkedControlJob = useEffectEvent((jobId: string) =>
    followBulkJob(jobId, undefined, false));
  const loadSavedAgents = useEffectEvent((forceCurrentSnapshot = false) => {
    void loadAgents(forceCurrentSnapshot);
  });
  const collectMissingAgentIdentities = useEffectEvent((snapshotId: string) => {
    void handleRefreshAgents(`agent-identities-${snapshotId}`);
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
    sessionOwnerRef.current = principalKey;
    activeViewRef.current = activeView;
  }, [activeView, principalKey]);

  useEffect(() => {
    return subscribeSessionRevalidationRequired(() => revalidateCurrentSession());
  }, []);

  useEffect(() => {
    void loadSession();
  }, []);

  useEffect(() => {
    agentDetailRequestId.current += 1;
    agentDetailAbortController.current?.abort();
    agentListRequestId.current += 1;
    agentListAbortController.current?.abort();
    verificationOnlyAgentReload.current = false;
    bulkJobPollRequestId.current += 1;
    packageRefreshRequestId.current += 1;
    inventoryRefreshRequestId.current += 1;
    linkedPackageRefreshRequestId.current += 1;
    officialUsageRequestId.current += 1;
    officialUsageAbortController.current?.abort();
    resumedBulkJobIds.current.clear();
    agentDetailsCache.current.clear();
    void Promise.resolve().then(() => {
      setAgents([]);
      setAgentPage(undefined);
      setUnifiedAgentPage(undefined);
      setUnifiedAgentReadError(undefined);
      setSelectedUnifiedAgent(undefined);
      setSelectedPowerPlatformTargets(new Map());
      setSelectedPowerPlatformSnapshot(null);
      setAgentDetail(undefined);
      setTrackedJob(undefined);
      setLinkedPackageRefreshJob(undefined);
      setLinkedJobError(undefined);
      setBulkProgress(undefined);
      setBulkResult(undefined);
      setOfficialUsageAggregate(undefined);
      setOfficialUsageAggregateSetId(undefined);
      setOfficialUsageUsers(undefined);
      setOfficialUsageUsersSetId(undefined);
      setOfficialUsageLoadError(undefined);
      setLoadingOfficialUsage(false);
      setLoadingAgentDetailId(undefined);
    });
  }, [principalKey]);

  useEffect(() => {
    if (!user) return;
    const controller = new AbortController();
    getWorkbenchMetadata({ signal: controller.signal })
      .then(value => setLoadedWorkbenchMetadata({ principalKey, value }))
      .catch((requestError) => {
        if (!controller.signal.aborted && !(requestError instanceof ApiError && requestError.code === "request_aborted")) {
          setError(errorMessage(requestError));
        }
      });
    return () => controller.abort();
  }, [principalKey, user]);

  useEffect(() => {
    function restoreRoute() {
      readInitialAgentRoute();
      agentDetailRequestId.current += 1;
      agentDetailAbortController.current?.abort();
      packageRefreshRequestId.current += 1;
      setLoadingAgentDetailId(undefined);
      setBusyAgentId(undefined);
      setSingleAccessAgentDetail(undefined);
      setBulkAccessAgentIds(undefined);
      setBulkConfirmation(undefined);
      setRefreshingAgents(false);
      const view = parseWorkbenchView(window.location.pathname);
      if (view !== "agents") {
        setAgentDetail(undefined);
        setSelectedUnifiedAgent(undefined);
      }
      savedViewSearches.current.set(view, window.location.search);
      setActiveView(view);
      if (view === "agents") {
        const route = parseAgentRoute(window.location.search);
        if (countAdvancedAgentFilters(route) > 0) setShowAdvancedFilters(true);
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
        setAgentEnvironmentFilter(route.environmentId);
        setSelectedPowerPlatformTargets(new Map());
        setSelectedPowerPlatformSnapshot(null);
        setPendingPowerPlatformIds(new Set(route.selectedPowerPlatformIds));
        setRequestedQuarantineJobId(route.quarantineJobId);
        setRequestedInventorySnapshotId(route.inventorySnapshotId);
        setAgentDetail(current => current?.id === route.detailId ? current : undefined);
      } else if (view === "sync") {
        const route = parseDataSyncRoute(window.location.search);
        setRequestedDataSyncRunId(route.syncRunId);
        setRequestedPackageRefreshJobId(route.refreshJobId);
        setRequestedPackageRefreshMode(route.refreshMode);
      } else if (view === "official-usage") {
        const route = parseOfficialUsageRoute(window.location.search);
        setRequestedOfficialUsageStagingId(route.stagingId);
        setOfficialUsageReportSetId(route.reportSetId);
        setReportActivityWindowDays(route.activityWindowDays);
        setOfficialUsageAgentOffset(0);
        setOfficialUsageAgentQuery({});
        setOfficialUsageUserOffset(0);
        setOfficialUsageUserQuery({});
        setOfficialUsageLoadError(undefined);
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
      detailId: selectedUnifiedAgent?.id ?? agentDetail?.id ?? requestedAgentDetailId,
      detailTab: agentDetailTab,
      selectedIds: [...selectedAgentIds],
      refreshMode: requestedPackageRefreshMode,
      controlJobId: requestedPackageControlJobId,
      source: "all",
      linkState: "all",
      environmentId: agentEnvironmentFilter,
      inventorySnapshotId: requestedInventorySnapshotId,
      selectedPowerPlatformIds: [...new Set([...pendingPowerPlatformIds, ...selectedPowerPlatformTargets.keys()])],
      quarantineJobId: requestedQuarantineJobId,
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
  }, [activeView, agentDetail?.id, agentDetailTab, agentEnvironmentFilter, agentPageIndex, agentSortBy, agentSortDirection, availableToFilter, createdWithinDays, hostFilter, pendingPowerPlatformIds, pendingStoredAgentSelectionCount, platformFilter, publisherFilter, query, requestedAgentDetailId, requestedInventorySnapshotId, requestedPackageControlJobId, requestedPackageRefreshJobId, requestedPackageRefreshMode, requestedQuarantineJobId, selectedAgentIds, selectedPowerPlatformTargets, selectedUnifiedAgent?.id, statusFilter, user]);

  useEffect(() => {
    if (activeView !== "sync") return;
    const search = dataSyncRouteSearch({
      syncRunId: requestedDataSyncRunId,
      refreshJobId: requestedPackageRefreshJobId,
      refreshMode: requestedPackageRefreshMode,
    });
    const next = workbenchUrl("sync", search);
    savedViewSearches.current.set("sync", search.toString());
    if (`${window.location.pathname}${window.location.search}` !== next) {
      window.history.replaceState({ view: "sync" }, "", next);
    }
  }, [activeView, requestedDataSyncRunId, requestedPackageRefreshJobId, requestedPackageRefreshMode]);

  useEffect(() => {
    if (activeView !== "official-usage") return;
    const next = workbenchUrl("official-usage", officialUsageRouteSearch({
      stagingId: requestedOfficialUsageStagingId,
      reportSetId: officialUsageReportSetId,
      activityWindowDays: reportActivityWindowDays,
    }));
    savedViewSearches.current.set("official-usage", next.includes("?") ? next.slice(next.indexOf("?")) : "");
    if (`${window.location.pathname}${window.location.search}` !== next) {
      window.history.replaceState({ view: "official-usage" }, "", next);
    }
  }, [activeView, officialUsageReportSetId, reportActivityWindowDays, requestedOfficialUsageStagingId]);

  useEffect(() => {
    if (!user || !hasRole(user, "AgentControl.Viewer") || activeView !== "agents" || !requestedAgentDetailId
      || (selectedUnifiedAgent?.id === requestedAgentDetailId && unifiedAgentDetailPage.current === unifiedAgentPage)
      || agentDetail?.id === requestedAgentDetailId || loadingAgentDetailId === requestedAgentDetailId) return;
    const unified = findUnifiedAgentRecord(unifiedAgentPage?.value ?? [], requestedAgentDetailId, agentEnvironmentFilter);
    if (unified) {
      const requestId = ++agentDetailRequestId.current;
      let active = true;
      void Promise.resolve().then(() => {
        if (!active || requestId !== agentDetailRequestId.current) return;
        unifiedAgentDetailPage.current = unifiedAgentPage;
        setSelectedUnifiedAgent(unified);
        setRequestedAgentDetailId(unified.id);
        setAgentDetail(undefined);
      });
      return () => { active = false; };
    }
    const requestId = ++agentDetailRequestId.current;
    const controller = new AbortController();
    void Promise.resolve().then(async () => {
      if (controller.signal.aborted || requestId !== agentDetailRequestId.current) return;
      setAgentDetailError(undefined);
      const target = parseUnifiedAgentRecordId(requestedAgentDetailId)
        ?? { source: "graph_packages" as const, packageId: requestedAgentDetailId };
      const resolved = await getUnifiedAgents({ recordId: unifiedAgentRecordId(target) }, { signal: controller.signal });
      if (controller.signal.aborted || requestId !== agentDetailRequestId.current) return;
      if (resolved.count > 1 || resolved.value.length > 1) throw new Error("The agent link is ambiguous; select an exact source-qualified agent.");
      if (resolved.value.length === 1) {
        unifiedAgentDetailPage.current = unifiedAgentPage;
        setSelectedUnifiedAgent(resolved.value[0]);
        setRequestedAgentDetailId(resolved.value[0].id);
        setAgentDetail(undefined);
        return;
      }
      if (target.source !== "graph_packages") throw new Error("The exact agent is not available in the current saved inventory. Refresh saved agent inventory and retry.");
      const detail = await getAgentDetails(target.packageId, { signal: controller.signal });
      if (!controller.signal.aborted && requestId === agentDetailRequestId.current) {
        const fallbackRecord: UnifiedAgentRecord = {
          id: unifiedAgentRecordId({ source: "graph_packages", packageId: detail.id }),
          displayName: detail.displayName,
          presence: "graph_packages",
          environmentId: null,
          packages: [detail],
          powerPlatformResource: null,
          identity: {
            state: "unmatched",
            evidence: [],
            packageEvidence: [{ packageId: detail.id, evidence: [] }],
            reason: "No Power Platform counterpart is available in the current saved unified inventory.",
          },
          observations: {
            graphPackages: null,
            packageSnapshots: {},
            powerPlatform: null,
          },
        };
        unifiedAgentDetailPage.current = unifiedAgentPage;
        setSelectedUnifiedAgent(fallbackRecord);
        setAgentDetail(detail);
        setRequestedAgentDetailId(fallbackRecord.id);
      }
    }).catch(requestError => {
      if (!controller.signal.aborted && requestId === agentDetailRequestId.current) {
        setSelectedUnifiedAgent(undefined);
        setRequestedAgentDetailId(undefined);
        setAgentDetailError(errorMessage(requestError));
      }
    });
    return () => controller.abort();
  }, [activeView, agentDetail?.id, agentEnvironmentFilter, loadingAgentDetailId, requestedAgentDetailId, selectedUnifiedAgent?.id, unifiedAgentPage, user]);

  useEffect(() => {
    if (!user || !hasRole(user, "AgentControl.Viewer") || (activeView !== "agents" && activeView !== "sync") || !requestedPackageRefreshJobId) {
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

    const stored = loadStoredActiveBulkJobId();
    if (stored.error) {
      void Promise.resolve().then(() => setBulkJobStorageError(stored.error));
    }
    const jobId = stored.jobId;

    if (!jobId || resumedBulkJobIds.current.has(jobId)) {
      return;
    }

    resumedBulkJobIds.current.add(jobId);
    resumeBulkJob(jobId);
  }, [principalKey, requestedPackageControlJobId, requestedPackageRefreshJobId, user]);

  useEffect(() => {
    if (
      activeView !== "sync"
      || refreshingPowerPlatformAgents
      || powerPlatformAgentRefreshJob?.status !== "running"
    ) {
      return;
    }
    const controller = new AbortController();
    const requestId = inventoryRefreshRequestId.current;
    const owner = principalKey;
    const jobId = powerPlatformAgentRefreshJob.id;
    const deadline = Date.now() + foregroundJobPollBudgetMs;
    let timer: number | undefined;

    const poll = async () => {
      try {
        const job = await getInventoryRefreshJob(jobId, { signal: controller.signal });
        if (
          controller.signal.aborted
          || requestId !== inventoryRefreshRequestId.current
          || sessionOwnerRef.current !== owner
          || activeViewRef.current !== "sync"
        ) return;
        setPowerPlatformAgentRefreshJob(job);
        if (job.status === "succeeded") {
          resetPowerPlatformSelection();
          forceCurrentAgentReload.current = true;
          setAgentReloadRevision(revision => revision + 1);
        } else if (job.status === "running" && Date.now() < deadline) {
          timer = window.setTimeout(() => void poll(), inventoryRefreshPollIntervalMs);
        } else if (job.status === "running") {
          setError("Power Platform agent refresh polling reached its five-minute bound. The durable job remains available in Jobs.");
        } else if (job.status !== "waiting_authorization") {
          setError(job.message ?? "Power Platform agent refresh did not complete.");
        }
      } catch (requestError) {
        if (
          !controller.signal.aborted
          && requestId === inventoryRefreshRequestId.current
          && sessionOwnerRef.current === owner
          && activeViewRef.current === "sync"
        ) {
          setError(errorMessage(requestError));
        }
      }
    };

    timer = window.setTimeout(() => void poll(), inventoryRefreshPollIntervalMs);
    return () => {
      controller.abort();
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [activeView, powerPlatformAgentRefreshJob?.id, powerPlatformAgentRefreshJob?.status, principalKey, refreshingPowerPlatformAgents]);

  useEffect(() => {
    if (!user) {
      agentListAbortController.current?.abort();
      void Promise.resolve().then(() => {
        setAgents([]);
        setAgentPage(undefined);
        setUnifiedAgentPage(undefined);
        setSelectedUnifiedAgent(undefined);
        setSelectedPowerPlatformTargets(new Map());
        setSelectedPowerPlatformSnapshot(null);
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
        setUnifiedAgentPage(undefined);
        setSelectedUnifiedAgent(undefined);
        setSelectedPowerPlatformTargets(new Map());
        setSelectedPowerPlatformSnapshot(null);
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
        setRequestedDataSyncRunId(undefined);
        setTrackedJob(undefined);
        setLinkedPackageRefreshJob(undefined);
        setLinkedJobError(undefined);
      });
      return;
    }
    const forceCurrentSnapshot = forceCurrentAgentReload.current;
    forceCurrentAgentReload.current = false;
    loadSavedAgents(forceCurrentSnapshot);
    return () => agentListAbortController.current?.abort();
  }, [agentEnvironmentFilter, agentPageIndex, agentReloadRevision, agentSortBy, agentSortDirection, availableToFilter, createdWithinDays, deferredQuery, hostFilter, platformFilter, publisherFilter, statusFilter, user]);

  useEffect(() => {
    if (user) {
      loadSavedOfficialUsage();
    }
  }, [inactiveDays, officialUsageAgentOffset, officialUsageAgentQuery, officialUsageDashboardRevision, officialUsageReportSetId, officialUsageUserQuery, reportActivityWindowDays, officialUsageUserOffset, user]);

  useEffect(() => {
    if (!unifiedAgentPage || pendingPowerPlatformIds.size === 0 || !hasRole(user, "AgentControl.Admin") || activeView !== "agents") return;
    const controller = new AbortController();
    void Promise.all([...pendingPowerPlatformIds].map(async key => {
      try {
        const known = findUnifiedAgentRecord(unifiedAgentPage.value, key, agentEnvironmentFilter);
        if (known) return { record: known };
        const target = parseUnifiedAgentRecordId(key) ?? (agentEnvironmentFilter
          ? { source: "power_platform" as const, nativeId: key, environmentId: agentEnvironmentFilter }
          : undefined);
        if (!target) throw new Error("An exact environment and native resource identity is required.");
        const page = await getUnifiedAgents({ recordId: unifiedAgentRecordId(target) }, { signal: controller.signal });
        if (page.count > 1 || page.value.length > 1) throw new Error("The bookmarked agent identity is ambiguous.");
        if (page.value.length !== 1) throw new Error("The exact agent is unavailable in the current saved inventory.");
        return { record: page.value[0] };
      } catch (requestError) {
        return { error: errorMessage(requestError) };
      }
    })).then(results => {
      if (controller.signal.aborted) return;
      const resolved = new Map(selectedPowerPlatformTargets);
      let snapshot = selectedPowerPlatformSnapshot;
      const failures: string[] = [];
      for (const result of results) {
        if (result.error !== undefined) {
          failures.push(result.error);
          continue;
        }
        const resource = result.record?.powerPlatformResource;
        const observation = result.record?.observations.powerPlatform;
        const reason = quarantineTargetReason(resource ?? undefined, observation ?? null);
        if (!resource || !observation || reason) {
          failures.push(reason ?? "An exact saved quarantine target is required.");
          continue;
        }
        if ((requestedInventorySnapshotId && requestedInventorySnapshotId !== observation.snapshotId)
          || (snapshot && snapshot.id !== observation.snapshotId)) {
          failures.push("The saved inventory changed. Select the exact targets again from one current snapshot.");
          continue;
        }
        const key = quarantineTargetKey(resource);
        if (!resolved.has(key) && resolved.size >= 25) {
          failures.push("Quarantine supports up to 25 exact targets in one selection.");
          continue;
        }
        resolved.set(key, resource);
        snapshot = observation;
      }
      setPendingPowerPlatformIds(new Set());
      if (resolved.size && snapshot) {
        setRequestedInventorySnapshotId(snapshot.id);
        setSelectedPowerPlatformSnapshot(snapshot);
        setSelectedPowerPlatformTargets(resolved);
      }
      if (failures.length) {
        setSelectionRouteNotice({
          tone: "error",
          text: `Could not restore ${failures.length} bookmarked quarantine target${failures.length === 1 ? "" : "s"}: ${[...new Set(failures)].join(" ")}`,
        });
      }
    });
    return () => controller.abort();
  }, [activeView, agentEnvironmentFilter, pendingPowerPlatformIds, requestedInventorySnapshotId, selectedPowerPlatformSnapshot, selectedPowerPlatformTargets, unifiedAgentPage, user]);

  useEffect(
    () => {
      const timerIds = stateChangeTimerIds.current;
      return () => {
        sessionOwnerRef.current = undefined;
        agentDetailRequestId.current += 1;
        agentDetailAbortController.current?.abort();
        agentListRequestId.current += 1;
        agentListAbortController.current?.abort();
        bulkJobPollRequestId.current += 1;
        packageRefreshRequestId.current += 1;
        inventoryRefreshRequestId.current += 1;
        officialUsageRequestId.current += 1;
        officialUsageAbortController.current?.abort();
        for (const timerId of timerIds) {
          window.clearTimeout(timerId);
        }
      };
    },
    [],
  );

  const effectivePlatformFilter = platformFilter;
  const publisherOptions = agentPage?.facets.publishers ?? [];
  const hostOptions = agentPage?.facets.hosts ?? [];
  const availableToOptions = agentPage?.facets.availability ?? [];
  const platformOptions = unifiedAgentPage?.facets?.platforms ?? agentPage?.facets.platforms ?? [];
  const agentEnvironmentNames = Object.fromEntries((unifiedAgentPage?.facets?.environments ?? [])
    .map(option => [option.value.toLowerCase(), option.label]));

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
  const canCollectIdentities = canReadSensitiveUsage
    && providerActionAllowed(capabilityState.views.find(view => view.definition.id === "graph.package.read.delegated"));
  const identitySnapshotId = savedAgentPageOwner?.principalKey === principalKey
    && !savedAgentPageOwner.verificationOnly
    && !loadingAgents
    && !unifiedAgentReadError
    && unifiedAgentPage?.identityCollection?.pendingPackages
    && unifiedAgentPage.sources.powerPlatform.state !== "unavailable"
    ? unifiedAgentPage.sources.graphPackages.observation?.snapshotId : undefined;

  useEffect(() => {
    if (!identitySnapshotId || !canCollectIdentities || visibleActiveView !== "agents" || refreshingAgents) return;
    const key = `${principalKey}:${identitySnapshotId}`;
    if (identityBackfills.current.has(key)) return;
    identityBackfills.current.add(key);
    collectMissingAgentIdentities(identitySnapshotId);
  }, [canCollectIdentities, identitySnapshotId, principalKey, refreshingAgents, visibleActiveView]);

  useEffect(() => {
    if (!user || visibleActiveView === activeView) return;
    window.history.replaceState({ view: visibleActiveView }, "", workbenchUrl(visibleActiveView));
  }, [activeView, user, visibleActiveView]);

  function navigateToView(view: WorkbenchViewId) {
    agentDetailRequestId.current += 1;
    agentDetailAbortController.current?.abort();
    setLoadingAgentDetailId(undefined);
    setBusyAgentId(undefined);
    savedViewSearches.current.set(activeView, window.location.search);
    setAgentDetail(undefined);
    setSelectedUnifiedAgent(undefined);
    setRequestedAgentDetailId(undefined);
    setSingleAccessAgentDetail(undefined);
    setBulkAccessAgentIds(undefined);
    setBulkConfirmation(undefined);
    setExportChoiceOpen(false);
    setActiveView(view);
    const savedSearch = savedViewSearches.current.get(view) ?? "";
    const search = new URLSearchParams(savedSearch.startsWith("?") ? savedSearch.slice(1) : savedSearch);
    if (view === "sync") {
      const route = parseDataSyncRoute(search.toString());
      setRequestedDataSyncRunId(route.syncRunId);
      setRequestedPackageRefreshJobId(route.refreshJobId);
      setRequestedPackageRefreshMode(route.refreshMode);
    }
    const next = workbenchUrl(view, search);
    if (`${window.location.pathname}${window.location.search}` !== next) {
      window.history.pushState({ view }, "", next);
    }
  }

  function handleReportActivityWindowChange(activityWindowDays: number) {
    const next = workbenchUrl("official-usage", officialUsageRouteSearch({
      stagingId: requestedOfficialUsageStagingId,
      reportSetId: officialUsageReportSetId,
      activityWindowDays,
    }));
    savedViewSearches.current.set("official-usage", next.includes("?") ? next.slice(next.indexOf("?")) : "");
    if (`${window.location.pathname}${window.location.search}` !== next) {
      window.history.pushState({ view: "official-usage" }, "", next);
    }
    setReportActivityWindowDays(activityWindowDays);
  }

  function handleOfficialUsageSnapshotChange(reportSetId: string | undefined) {
    const activityWindowDays = reportSetId ? 365 : 30;
    const next = workbenchUrl("official-usage", officialUsageRouteSearch({
      stagingId: requestedOfficialUsageStagingId,
      reportSetId,
      activityWindowDays,
    }));
    savedViewSearches.current.set("official-usage", next.includes("?") ? next.slice(next.indexOf("?")) : "");
    if (`${window.location.pathname}${window.location.search}` !== next) {
      window.history.pushState({ view: "official-usage" }, "", next);
    }
    setOfficialUsageLoadError(undefined);
    setOfficialUsageReportSetId(reportSetId);
    setReportActivityWindowDays(activityWindowDays);
    setOfficialUsageAgentOffset(0);
    setOfficialUsageAgentQuery({});
    setOfficialUsageUserOffset(0);
    setOfficialUsageUserQuery({});
    setOfficialUsageDashboardRevision(revision => revision + 1);
  }

  function handleOfficialUsageChanged() {
    setOfficialUsageAgentOffset(0);
    setOfficialUsageAgentQuery({});
    setOfficialUsageUserOffset(0);
    setOfficialUsageUserQuery({});
    setOfficialUsageDashboardRevision(revision => revision + 1);
    setCopilotUsersDataRevision(revision => revision + 1);
    void dataSyncPanelRef.current?.refresh();
  }

  function handleDataSyncSourcesChanged(sources: DataSyncSourceId[]) {
    setSyncHistoryRevision(revision => revision + 1);
    const changed = new Set(sources);
    if (changed.has("graph_packages") || changed.has("power_platform")) {
      requestCurrentAgentReload();
    }
    if (changed.has("power_platform")) {
      setPowerPlatformDataRevision(revision => revision + 1);
    }
    if (changed.has("users")) {
      setCopilotUsersDataRevision(revision => revision + 1);
    }
    if (changed.has("usage_reports")) {
      handleOfficialUsageChanged();
    }
  }

  function handleSyncRunsChanged() {
    setSyncHistoryRevision(revision => revision + 1);
  }

  function handleRequestedSyncRunChange(runId: string | undefined) {
    setRequestedDataSyncRunId(runId);
    const next = workbenchUrl("sync", dataSyncRouteSearch({
      syncRunId: runId,
      refreshJobId: requestedPackageRefreshJobId,
      refreshMode: requestedPackageRefreshMode,
    }));
    if (`${window.location.pathname}${window.location.search}` !== next) {
      window.history.pushState({ view: "sync" }, "", next);
    }
  }

  const displayedUnifiedAgents = unifiedAgentPage?.value ?? [];
  const invalidMatchingPackageCount = unifiedAgentPage?.identityCollection?.invalidPackages ?? 0;
  const pendingMatchingPackageCount = unifiedAgentPage?.identityCollection?.pendingPackages ?? 0;
  const agentInventoryIssueSummary = [
    unifiedAgentPage?.verification?.status === "needs_attention" ? "Saved inventory needs attention" : "",
    unifiedAgentPage?.partial ? "Saved source limitations" : "",
    pendingMatchingPackageCount > 0 ? `${pendingMatchingPackageCount.toLocaleString()} packages awaiting identity metadata` : "",
    invalidMatchingPackageCount > 0
      ? `${invalidMatchingPackageCount.toLocaleString()} package${invalidMatchingPackageCount === 1 ? "" : "s"} with invalid matching metadata`
      : "",
  ].filter(Boolean).join(" · ");
  const advancedFilterCount = countAdvancedAgentFilters({
    environmentId: agentEnvironmentFilter,
    publisher: publisherFilter,
  });
  const hasActiveAgentFilters =
    deferredQuery.trim().length > 0 ||
    agentEnvironmentFilter.trim().length > 0 ||
    statusFilter !== "all" ||
    publisherFilter !== "all" ||
    availableToFilter !== "all" ||
    hostFilter !== "all" ||
    effectivePlatformFilter !== "all" ||
    parseOptionalPositiveInteger(createdWithinDays) !== undefined;
  const exportableAgentCount = unifiedAgentPage?.count ?? 0;
  const selectedExportTargetCount = selectedAgentIds.size + selectedPowerPlatformTargets.size;
  const exportSelectionRestoring = pendingPowerPlatformIds.size > 0 || pendingStoredAgentSelectionCount !== undefined;
  const agentExportRevision = isSavedAgentRevision(unifiedAgentPage?.revision) ? unifiedAgentPage.revision : undefined;
  const agentExportNeedsReload = Boolean(unifiedAgentReadError || agentExportError?.reloadRequired || (unifiedAgentPage && !agentExportRevision));
  const selectedQuarantineObservation = selectedPowerPlatformSnapshot ?? unifiedAgentPage?.value.find(
    record => record.observations.powerPlatform,
  )?.observations.powerPlatform ?? null;

  function clearPrivateState() {
    sessionOwnerRef.current = undefined;
    setShowAdvancedFilters(false);
    clearPackageSelection(user);
    setSessionEpoch(current => current + 1);
    agentDetailRequestId.current += 1;
    agentDetailAbortController.current?.abort();
    agentListRequestId.current += 1;
    agentListAbortController.current?.abort();
    verificationOnlyAgentReload.current = false;
    bulkJobPollRequestId.current += 1;
    packageRefreshRequestId.current += 1;
    inventoryRefreshRequestId.current += 1;
    linkedPackageRefreshRequestId.current += 1;
    officialUsageRequestId.current += 1;
    officialUsageAbortController.current?.abort();
    resumedBulkJobIds.current.clear();
    agentDetailsCache.current.clear();
    stateChangeVersions.current.clear();
    for (const timerId of stateChangeTimerIds.current) window.clearTimeout(timerId);
    stateChangeTimerIds.current.clear();
    clearActiveBulkJobId();
    setLoadedWorkbenchMetadata(undefined);
    setAgents([]);
    setAgentPage(undefined);
    setUnifiedAgentPage(undefined);
    setSelectedUnifiedAgent(undefined);
    setSelectedPowerPlatformTargets(new Map());
    setSelectedPowerPlatformSnapshot(null);
    setSavedAgentPageOwner(undefined);
    setAgentSnapshotId(undefined);
    setSelectedAgentIds(new Set());
    setPendingStoredAgentSelectionCount(undefined);
    setSelectionRouteNotice(undefined);
    setRequestedDataSyncRunId(undefined);
    setBulkConfirmation(undefined);
    setBulkAccessAgentIds(undefined);
    setAgentDetail(undefined);
    setSingleAccessAgentDetail(undefined);
    setLoadingAgentDetailId(undefined);
    setAgentDetailError(undefined);
    setBusyAgentId(undefined);
    setBusyBulkAction(undefined);
    setExportChoiceOpen(false);
    setExportingPowerPlatformCsv(false);
    setRefreshingPowerPlatformAgents(false);
    setPowerPlatformAgentRefreshJob(undefined);
    setLastAgentListRefreshAt(undefined);
    setPackageSnapshotExpiresAt(undefined);
    setLoadingAgents(false);
    setRefreshingAgents(false);
    setRecentlyChangedAgentIds(new Set());
    setExportingCsv(false);
    setAgentExportError(undefined);
    setUnifiedAgentReadError(undefined);
    setBulkProgress(undefined);
    setBulkResult(undefined);
    setTrackedJob(undefined);
    setLinkedPackageRefreshJob(undefined);
    setLinkedJobError(undefined);
    setOfficialUsageAggregate(undefined);
    setOfficialUsageAggregateSetId(undefined);
    setOfficialUsageUsers(undefined);
    setOfficialUsageUsersSetId(undefined);
    setOfficialUsageLoadError(undefined);
    setLoadingOfficialUsage(false);
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

  function currentUnifiedAgentQuery(): UnifiedAgentExportQuery {
    return {
      ...(normalizedBulkRefQuery ? { operationIdPrefix: normalizedBulkRefQuery } : deferredQuery.trim() ? { search: deferredQuery.trim() } : {}),
      ...(agentEnvironmentFilter.trim() ? { environmentId: agentEnvironmentFilter.trim() } : {}),
      ...(statusFilter === "all" ? {} : { blocked: statusFilter === "blocked" }),
      ...(publisherFilter === "all" ? {} : { publisher: publisherFilter }),
      ...(availableToFilter === "all" ? {} : { availableTo: availableToFilter }),
      ...(hostFilter === "all" ? {} : { host: hostFilter }),
      ...(effectivePlatformFilter === "all" ? {} : { platform: effectivePlatformFilter }),
      ...(parseOptionalPositiveInteger(createdWithinDays) ? { createdWithinDays: parseOptionalPositiveInteger(createdWithinDays) } : {}),
      sortBy: agentSortBy === "lastModifiedAt" ? "lastModifiedAt" : "displayName",
      sortDirection: agentSortDirection,
    };
  }

  async function loadAgents(forceCurrentSnapshot = false) {
    const verificationOnly = verificationOnlyAgentReload.current;
    verificationOnlyAgentReload.current = false;
    const requestId = ++agentListRequestId.current;
    agentListAbortController.current?.abort();
    const controller = new AbortController();
    agentListAbortController.current = controller;
    setLoadingAgents(true);
    setError(undefined);

    try {
      const [response, unifiedResponse, inventoryRefreshJobs] = await Promise.all([
        getAgents({
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
          offset: 0,
        }, { signal: controller.signal }).catch(requestError => {
          if (requestId === agentListRequestId.current && !controller.signal.aborted) {
            setError(`Saved package summaries are unavailable: ${errorMessage(requestError)}`);
          }
          return undefined;
        }),
        getUnifiedAgents({
          ...currentUnifiedAgentQuery(),
          limit: agentDisplayPageSize,
          offset: agentPageIndex * agentDisplayPageSize,
        }, { signal: controller.signal }),
        getInventoryRefreshJobs({ signal: controller.signal }).catch(requestError => {
          if (requestId === agentListRequestId.current && !controller.signal.aborted) {
            setError(`Unable to load Power Platform agent refresh history: ${errorMessage(requestError)}`);
          }
          return undefined;
        }),
      ]);
      if (requestId !== agentListRequestId.current || controller.signal.aborted) return;
      const lastPage = Math.max(Math.ceil(unifiedResponse.count / agentDisplayPageSize) - 1, 0);
      if (agentPageIndex > lastPage) {
        if (verificationOnly) verificationOnlyAgentReload.current = true;
        setAgentPageIndex(lastPage);
        return;
      }
      setAgents(response?.value ?? []);
      setAgentPage(response);
      setUnifiedAgentPage(unifiedResponse);
      setUnifiedAgentReadError(undefined);
      setAgentExportError(current => current === agentExportError ? undefined : current);
      const latestPowerPlatformAgentJob = inventoryRefreshJobs?.value.find((job) =>
        job.requestedTypes.includes("microsoft.copilotstudio/agents"),
      );
      if (latestPowerPlatformAgentJob) {
        // History must not replace a refresh, resume or poll result received while the read was in flight.
        setPowerPlatformAgentRefreshJob(current =>
          current === powerPlatformAgentRefreshJob ? latestPowerPlatformAgentJob : current);
      }
      setSavedAgentPageOwner({ principalKey, requestId, verificationOnly });
      setAgentSnapshotId(response?.snapshot?.id);
      setLastAgentListRefreshAt(response?.snapshot ? new Date(response.snapshot.observedAt) : undefined);
      setPackageSnapshotExpiresAt(response?.snapshot ? new Date(response.snapshot.expiresAt) : undefined);
      agentDetailsCache.current.clear();
    } catch (requestError) {
      if (requestId === agentListRequestId.current && !(requestError instanceof ApiError && requestError.code === "request_aborted")) {
        setError(errorMessage(requestError));
        setUnifiedAgentReadError(errorMessage(requestError));
      }
    } finally {
      if (requestId === agentListRequestId.current) setLoadingAgents(false);
    }
  }

  async function loadOfficialUsage() {
    const requestId = ++officialUsageRequestId.current;
    const requestedSetId = officialUsageReportSetId ?? null;
    officialUsageAbortController.current?.abort();
    const controller = new AbortController();
    officialUsageAbortController.current = controller;
    if (!user) {
      setOfficialUsageAggregate(undefined);
      setOfficialUsageAggregateSetId(undefined);
      setOfficialUsageUsers(undefined);
      setOfficialUsageUsersSetId(undefined);
      setOfficialUsageLoadError(undefined);
      setLoadingOfficialUsage(false);
      return;
    }
    setLoadingOfficialUsage(true);
    setOfficialUsageLoadError(undefined);

    const [aggregateResult, usersResult] = await Promise.allSettled([
      hasRole(user, "AgentControl.Viewer")
        ? getOfficialUsageAggregate({
            ...officialUsageAgentQuery,
            ...(officialUsageReportSetId ? { setId: officialUsageReportSetId } : {}),
            activityWindowDays: reportActivityWindowDays,
            inactiveDays,
            limit: 100,
            offset: officialUsageAgentOffset,
        }, { signal: controller.signal })
        : Promise.resolve(undefined),
      hasRole(user, "AgentControl.Viewer")
        ? getOfficialUsageUsers(
          {
            ...officialUsageUserQuery,
            ...(officialUsageReportSetId ? { setId: officialUsageReportSetId } : {}),
            inactiveDays,
            limit: 100,
            offset: officialUsageUserOffset,
          },
          { signal: controller.signal },
        )
        : Promise.resolve(undefined),
    ]);

    if (controller.signal.aborted || requestId !== officialUsageRequestId.current) return;
    let loadError: string | undefined;
    if (aggregateResult.status === "fulfilled") {
      setOfficialUsageAggregate(aggregateResult.value);
      setOfficialUsageAggregateSetId(requestedSetId);
    } else if (!(aggregateResult.reason instanceof ApiError && aggregateResult.reason.kind === "aborted")) {
      loadError = errorMessage(aggregateResult.reason);
    }

    if (usersResult.status === "fulfilled") {
      setOfficialUsageUsers(usersResult.value);
      setOfficialUsageUsersSetId(requestedSetId);
    } else if (!(usersResult.reason instanceof ApiError && usersResult.reason.kind === "aborted")) {
      loadError ??= errorMessage(usersResult.reason);
    }
    setOfficialUsageLoadError(loadError);
    if (officialUsageAbortController.current === controller) officialUsageAbortController.current = undefined;
    if (requestId === officialUsageRequestId.current) setLoadingOfficialUsage(false);
  }

  async function handleRefreshAgents(idempotencyKey?: string) {
    if (!user || sessionRevalidationInFlight.current) return;
    const requestId = ++packageRefreshRequestId.current;
    const owner = principalKey;
    const deadline = Date.now() + identityCollectionPollBudgetMs;
    setRefreshingAgents(true);
    setError(undefined);

    try {
      const existingJobs = idempotencyKey ? await getPackageRefreshJobs("delegated") : undefined;
      if (!ownsPackageRefreshRequest(requestId, owner)) return;
      let job = existingJobs?.value.find(candidate => candidate.scopeKind === "broad" && candidate.status === "running")
        ?? await (idempotencyKey ? startPackageRefresh("delegated", { idempotencyKey }) : startPackageRefresh("delegated"));
      if (!ownsPackageRefreshRequest(requestId, owner)) return;
      setLinkedPackageRefreshJob(job);
      handleSyncRunsChanged();
      while (job.status === "running" && Date.now() < deadline) {
        await wait(packageRefreshPollIntervalMs);
        if (!ownsPackageRefreshRequest(requestId, owner)) return;
        job = await getPackageRefreshJob(job.id, job.tokenMode);
        if (!ownsPackageRefreshRequest(requestId, owner)) return;
        setLinkedPackageRefreshJob(job);
      }

      if (job.status === "running") throw new Error("Agent identity collection status polling reached its sixteen-minute bound. The durable job remains available in Sync and Jobs.");
      if (job.status !== "succeeded") {
        throw new Error(job.message ?? (job.status === "waiting_authorization"
          ? "Package refresh requires current delegated read authorization. Open Permissions to request consent or retry the probe."
          : "Package refresh failed without replacing the last complete saved observation."));
      }
      requestCurrentAgentReload();
    } catch (requestError) {
      if (ownsPackageRefreshRequest(requestId, owner)) setError(errorMessage(requestError));
    } finally {
      if (ownsPackageRefreshRequest(requestId, owner)) setRefreshingAgents(false);
    }
  }

  async function handleRefreshMatchingDetails() {
    const ids = [...selectedAgentIds];
    if (ids.length < 1 || ids.length > 100 || !user || sessionRevalidationInFlight.current) return;
    const requestId = ++packageRefreshRequestId.current;
    const owner = principalKey;
    const deadline = Date.now() + foregroundJobPollBudgetMs;
    setRefreshingAgents(true);
    setError(undefined);
    try {
      let job = await refreshPackageIdentityDetails(ids);
      if (!ownsPackageRefreshRequest(requestId, owner)) return;
      handleSyncRunsChanged();
      setLinkedPackageRefreshJob(job);
      while (job.status === "running" && Date.now() < deadline) {
        await wait(packageRefreshPollIntervalMs);
        if (!ownsPackageRefreshRequest(requestId, owner)) return;
        job = await getPackageRefreshJob(job.id, job.tokenMode);
        if (!ownsPackageRefreshRequest(requestId, owner)) return;
        setLinkedPackageRefreshJob(job);
      }
      if (job.status === "running") throw new Error("Matching-detail refresh polling reached its five-minute bound. The durable job remains available in Jobs.");
      if (job.status !== "succeeded") {
        throw new Error(job.message ?? (job.status === "waiting_authorization"
          ? "Matching-detail refresh requires current delegated package-read authorization."
          : "Matching-detail refresh failed without replacing the last complete saved observations."));
      }
      requestCurrentAgentReload();
    } catch (requestError) {
      if (ownsPackageRefreshRequest(requestId, owner)) setError(errorMessage(requestError));
    } finally {
      if (ownsPackageRefreshRequest(requestId, owner)) setRefreshingAgents(false);
    }
  }

  async function handleRefreshExactPackage(id: string) {
    const requestId = ++packageRefreshRequestId.current;
    const owner = principalKey;
    const deadline = Date.now() + foregroundJobPollBudgetMs;
    setRefreshingAgents(true);
    setError(undefined);
    setAgentDetailError(undefined);
    try {
      let job = await startExactPackageRefresh(id, "delegated");
      if (!ownsPackageRefreshRequest(requestId, owner)) return;
      while (job.status === "running" && Date.now() < deadline) {
        await wait(packageRefreshPollIntervalMs);
        if (!ownsPackageRefreshRequest(requestId, owner)) return;
        job = await getPackageRefreshJob(job.id, job.tokenMode);
        if (!ownsPackageRefreshRequest(requestId, owner)) return;
      }
      if (job.status === "running") throw new Error("Exact package refresh polling reached its five-minute bound. The durable job remains available in Jobs.");
      if (job.status !== "succeeded") throw new Error(job.message ?? "Exact package refresh requires current delegated package-read authorization.");
      setRequestedAgentDetailId(id);
      requestCurrentAgentReload();
    } catch (requestError) {
      if (ownsPackageRefreshRequest(requestId, owner)) setAgentDetailError(errorMessage(requestError));
    } finally {
      if (ownsPackageRefreshRequest(requestId, owner)) setRefreshingAgents(false);
    }
  }

  async function handleSignOut() {
    agentDetailRequestId.current += 1;
    agentDetailAbortController.current?.abort();

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
    const requestId = ++agentDetailRequestId.current;
    agentDetailAbortController.current?.abort();
    const controller = new AbortController();
    agentDetailAbortController.current = controller;
    const owner = principalKey;

    setAgentDetailError(undefined);
    setAgentDetail(undefined);
    setLoadingAgentDetailId(agent.id);

    try {
      const detail = withPackageSummaryFallback(
        await getAgentDetails(agent.id, { signal: controller.signal }),
        agent,
      );

      if (ownsAgentDetailRequest(requestId, owner, controller.signal)) {
        agentDetailsCache.current.set(agent.id, detail);
        setAgentDetail(detail);
      }

    } catch (requestError) {
      if (ownsAgentDetailRequest(requestId, owner, controller.signal)) {
        setAgentDetailError(errorMessage(requestError));
      }
    } finally {
      if (ownsAgentDetailRequest(requestId, owner, controller.signal)) {
        setLoadingAgentDetailId(undefined);
      }
    }
  }

  function handleViewUnifiedAgentDetails(record: UnifiedAgentRecord) {
    const requestId = ++agentDetailRequestId.current;
    agentDetailAbortController.current?.abort();
    if (!ownsAgentFlowRequest(requestId, principalKey)) return;
    unifiedAgentDetailPage.current = unifiedAgentPage;
    setLoadingAgentDetailId(undefined);
    setAgentDetailError(undefined);
    setAgentDetail(undefined);
    setRequestedAgentDetailId(record.id);
    setSelectedUnifiedAgent(record);
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
    agentDetailAbortController.current?.abort();

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
    const requestId = ++agentDetailRequestId.current;
    agentDetailAbortController.current?.abort();
    const owner = principalKey;
    if (loadingAgentDetailId) setRequestedAgentDetailId(undefined);
    setLoadingAgentDetailId(undefined);
    setBusyAgentId(agent.id);
    setError(undefined);
    setBulkResult(undefined);

    try {
      const action = targetBlockedState ? "block" : "unblock";
      const preview = await previewPackageMutation({ action, ids: [agent.id], mutationScope: "single" });
      if (!ownsAgentFlowRequest(requestId, owner)) return;
      setBulkConfirmation({ action, ids: [agent.id], mutationScope: "single", preview });
      return true;
    } catch (requestError) {
      if (ownsAgentFlowRequest(requestId, owner)) setError(errorMessage(requestError));
    } finally {
      if (ownsAgentFlowRequest(requestId, owner)) setBusyAgentId(undefined);
    }
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
    const owner = principalKey;
    const preview = await previewPackageMutation({ action, ids, mutationScope, accessUpdate: update });
    if (!ownsAgentFlowRequest(requestId, owner)) return false;
    setBulkConfirmation({ action, ids, mutationScope, preview, accessUpdate: update });
    return true;
  }

  function requestExportCsv() {
    if (exportingCsv || loadingAgents) return;
    if (!agentExportRevision || agentExportNeedsReload) {
      setAgentExportError({ message: "Reload the saved agent inventory before exporting; a valid saved revision is required.", reloadRequired: true });
      return;
    }
    setExportChoiceOpen(true);
  }

  async function handleExportCsv(scope: UnifiedAgentExportScope) {
    if (exportingCsv) return;
    const owner = principalKey;
    if (!ownsSession(owner) || !hasRole(user, "AgentControl.Viewer")) return;
    if (!agentExportRevision || agentExportNeedsReload) {
      setAgentExportError({ message: "Reload the saved agent inventory before exporting; a valid saved revision is required.", reloadRequired: true });
      return;
    }
    if (loadingAgents || deferredQuery !== query) {
      setAgentExportError({ message: "Wait for the current saved agent filters to finish loading, then try again.", reloadRequired: false });
      return;
    }
    if (scope === "matching" && (exportableAgentCount === 0 || exportableAgentCount > maximumUnifiedAgentExportRows)) {
      setAgentExportError({ message: `Choose filters matching 1-${maximumUnifiedAgentExportRows.toLocaleString()} agents before exporting.`, reloadRequired: false });
      return;
    }
    if (scope === "selected" && (selectedExportTargetCount === 0 || exportSelectionRestoring)) {
      setAgentExportError({ message: "Select agents and wait for saved selections to finish restoring before exporting the selection.", reloadRequired: false });
      return;
    }

    setExportChoiceOpen(false);
    setAgentExportError(undefined);
    setExportingCsv(true);
    try {
      const query = currentUnifiedAgentQuery();
      const blob = await downloadUnifiedAgentInventoryCsv(scope === "selected" ? {
        revision: agentExportRevision,
        recordIds: selectedAgentExportReferences(unifiedAgentPage?.value ?? [], selectedAgentIds, selectedPowerPlatformTargets.keys()),
        query: { sortBy: query.sortBy, sortDirection: query.sortDirection },
      } : { revision: agentExportRevision, query });
      if (!ownsSession(owner)) return;
      downloadBlob("agents.csv", blob);
    } catch (requestError) {
      if (ownsSession(owner)) {
        const invalidated = requestError instanceof ApiError && requestError.status === 409;
        setAgentExportError({
          message: invalidated
            ? `The saved agent inventory changed or a selected reference is no longer available. Reload the saved inventory, review your selection, and try again. ${errorMessage(requestError)}`
            : errorMessage(requestError),
          reloadRequired: invalidated,
        });
      }
    } finally {
      if (ownsSession(owner)) setExportingCsv(false);
    }
  }

  async function handleExportPowerPlatformAgentCsv() {
    const snapshotId = unifiedAgentPage?.sources.powerPlatform.observation?.snapshotId;
    if (!snapshotId || exportingPowerPlatformCsv) {
      return;
    }

    setExportChoiceOpen(false);
    setError(undefined);
    setExportingPowerPlatformCsv(true);
    const owner = principalKey;
    try {
      const blob = await downloadInventoryCsv({
        snapshotId,
        type: "microsoft.copilotstudio/agents",
        search: deferredQuery.trim() || undefined,
        environmentId: agentEnvironmentFilter.trim() || undefined,
      });
      if (!ownsSession(owner)) return;
      downloadBlob(`power-platform-agent-inventory-${snapshotId}.csv`, blob);
    } catch (caught) {
      if (ownsSession(owner)) {
        setError(caught instanceof Error ? caught.message : "Unable to export Power Platform agent inventory.");
      }
    } finally {
      if (ownsSession(owner)) setExportingPowerPlatformCsv(false);
    }
  }

  async function handleRefreshPowerPlatformAgents() {
    if (refreshingPowerPlatformAgents || powerPlatformAgentRefreshJob?.status === "running") {
      return;
    }

    setError(undefined);
    setRefreshingPowerPlatformAgents(true);
    const requestId = ++inventoryRefreshRequestId.current;
    const owner = principalKey;
    try {
      const job = await refreshInventory({
        types: ["microsoft.copilotstudio/agents"],
      });
      if (!ownsInventoryRefreshRequest(requestId, owner)) return;
      setPowerPlatformAgentRefreshJob(job);
      handleSyncRunsChanged();
      if (job.status === "succeeded") {
        resetPowerPlatformSelection();
        requestCurrentAgentReload();
      } else if (job.status !== "waiting_authorization" && job.status !== "running") {
        setError(job.message ?? "Power Platform agent refresh did not complete.");
      }
    } catch (caught) {
      if (ownsInventoryRefreshRequest(requestId, owner)) {
        setError(caught instanceof Error ? caught.message : "Unable to refresh Power Platform agents.");
      }
    } finally {
      if (ownsInventoryRefreshRequest(requestId, owner)) setRefreshingPowerPlatformAgents(false);
    }
  }

  async function handleResumePowerPlatformAgentRefresh() {
    if (!powerPlatformAgentRefreshJob || refreshingPowerPlatformAgents) {
      return;
    }
    setError(undefined);
    setRefreshingPowerPlatformAgents(true);
    const requestId = ++inventoryRefreshRequestId.current;
    const owner = principalKey;
    try {
      const job = await resumeInventoryRefresh(powerPlatformAgentRefreshJob.id);
      if (!ownsInventoryRefreshRequest(requestId, owner)) return;
      setPowerPlatformAgentRefreshJob(job);
      handleSyncRunsChanged();
      if (job.status === "succeeded") {
        resetPowerPlatformSelection();
        requestCurrentAgentReload();
      }
      else if (job.status !== "running" && job.status !== "waiting_authorization") {
        setError(job.message ?? "Power Platform agent refresh did not complete.");
      }
    } catch (caught) {
      if (ownsInventoryRefreshRequest(requestId, owner)) {
        setError(caught instanceof Error ? caught.message : "Unable to resume the Power Platform agent refresh.");
      }
    } finally {
      if (ownsInventoryRefreshRequest(requestId, owner)) setRefreshingPowerPlatformAgents(false);
    }
  }

  async function requestBulkAction(targetBlockedState: boolean) {
    const label = targetBlockedState ? "block" : "unblock";
    const scope = [...selectedAgentIds];

    if (scope.length === 0) {
      setError("Select one or more agents before running a bulk action.");
      return;
    }

    const requestId = ++agentDetailRequestId.current;
    agentDetailAbortController.current?.abort();
    const owner = principalKey;
    if (loadingAgentDetailId) setRequestedAgentDetailId(undefined);
    setLoadingAgentDetailId(undefined);
    setError(undefined);
    try {
      const preview = await previewPackageMutation({ action: label, ids: scope, mutationScope: "bulk" });
      if (!ownsAgentFlowRequest(requestId, owner)) return;
      setBulkConfirmation({ action: label, ids: scope, mutationScope: "bulk", preview });
    } catch (requestError) {
      if (ownsAgentFlowRequest(requestId, owner)) setError(errorMessage(requestError));
    }
  }

  async function runConfirmedBulkAction(confirmation: BulkConfirmation) {
    const { action: label, ids, mutationScope, preview, accessUpdate } = confirmation;
    const requestId = ++bulkJobPollRequestId.current;
    const owner = principalKey;

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

      if (!ownsBulkJobRequest(requestId, owner)) return;
      await followBulkJob(job.id, job);
    } catch (requestError) {
      if (ownsBulkJobRequest(requestId, owner)) {
        setError(errorMessage(requestError));
        setBusyBulkAction(undefined);
        setBulkProgress(undefined);
        clearActiveBulkJobId();
      }
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
    const owner = principalKey;
    let keepStored = true;
    const deadline = Date.now() + foregroundJobPollBudgetMs;

    try {
      let job = initialJob ?? (await getBulkActionJob(jobId));
      if (!ownsBulkJobRequest(requestId, owner)) return;
      setTrackedJob(job);

      setBusyBulkAction(job.action);
      setBulkProgress(toBulkProgress(job));
      if (persist) {
        const storageError = saveStoredActiveBulkJobId(job.id);
        if (storageError) setBulkJobStorageError(storageError);
      }

      while (isJobPolling(job.status) && Date.now() < deadline) {
        await wait(bulkJobPollIntervalMs);

        if (!ownsBulkJobRequest(requestId, owner)) {
          return;
        }
        job = await getBulkActionJob(jobId);

        if (!ownsBulkJobRequest(requestId, owner)) {
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
      if (ownsBulkJobRequest(requestId, owner)) {
        if (persist) setError(errorMessage(requestError));
        else setLinkedJobError(`The exact package control job is expired, deleted, or unavailable to this account. ${errorMessage(requestError)}`);
      }
    } finally {
      if (ownsBulkJobRequest(requestId, owner)) {
        setBusyBulkAction(undefined);
        setBulkProgress(undefined);
        if (persist && !keepStored) clearActiveBulkJobId();
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

      const changedAgentIds = new Set(changedIds);
      const projectAccess = (item: CopilotPackage) => changedAgentIds.has(item.id)
        ? projectVerifiedAccessScope(item, result.accessUpdate!)
        : item;

      setAgents((currentAgents) => currentAgents.map(projectAccess));
      setUnifiedAgentPage(current => current ? {
        ...current,
        value: current.value.map(record => ({
          ...record,
          packages: record.packages.map(projectAccess),
        })),
      } : current);
      setSelectedUnifiedAgent(current => current ? {
        ...current,
        packages: current.packages.map(projectAccess),
      } : current);

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
    const requestId = ++bulkJobPollRequestId.current;
    const owner = principalKey;
    try {
      const job = await resumeBulkActionJob(trackedJob.id);
      if (ownsBulkJobRequest(requestId, owner)) await followBulkJob(job.id, job);
    } catch (requestError) {
      if (ownsBulkJobRequest(requestId, owner)) {
        setError(errorMessage(requestError));
        setBusyBulkAction(undefined);
        setBulkProgress(undefined);
      }
    }
  }

  async function handleCancelJob() {
    if (!trackedJob) return;
    const requestId = ++bulkJobPollRequestId.current;
    const owner = principalKey;
    try {
      const job = await cancelBulkActionJob(trackedJob.id);
      if (ownsBulkJobRequest(requestId, owner)) {
        await followBulkJob(job.id, job, !requestedPackageControlJobId);
      }
    } catch (requestError) {
      if (ownsBulkJobRequest(requestId, owner)) {
        setError(errorMessage(requestError));
        setBusyBulkAction(undefined);
        setBulkProgress(undefined);
      }
    }
  }

  async function handleReconcileJob() {
    if (!trackedJob) return;
    const requestId = ++bulkJobPollRequestId.current;
    const owner = principalKey;
    setError(undefined);
    try {
      const reconciled = await reconcileBulkActionJob(trackedJob.id);
      if (!ownsBulkJobRequest(requestId, owner)) return;
      setTrackedJob(reconciled);
      if (reconciled.result) setBulkResult(reconciled.result);
      if (reconciled.reconciliation.failed) {
        setError(`${reconciled.reconciliation.failed} provider read${reconciled.reconciliation.failed === 1 ? "" : "s"} could not be reconciled.`);
      }
    } catch (requestError) {
      if (ownsBulkJobRequest(requestId, owner)) setError(errorMessage(requestError));
    } finally {
      if (ownsBulkJobRequest(requestId, owner)) {
        setBusyBulkAction(undefined);
        setBulkProgress(undefined);
      }
    }
  }

  function clearActiveBulkJobId() {
    const storageError = clearStoredActiveBulkJobId();
    if (storageError) setBulkJobStorageError(storageError);
  }

  function handleClearAgentFilters() {
    handleSearchQueryChange("");
    resetPowerPlatformSelection();
    setAgentEnvironmentFilter("");
    setStatusFilter("all");
    setPublisherFilter("all");
    setAvailableToFilter("all");
    setHostFilter("all");
    setPlatformFilter("all");
    setCreatedWithinDays("");
    setAgentPageIndex(0);
  }

  function resetPowerPlatformSelection() {
    setSelectedPowerPlatformTargets(new Map());
    setSelectedPowerPlatformSnapshot(null);
    setPendingPowerPlatformIds(new Set());
    setRequestedInventorySnapshotId(undefined);
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
    setUnifiedAgentPage(current => current ? {
      ...current,
      value: current.value.map(record => ({
        ...record,
        packages: record.packages.map(item => changedAgentIds.has(item.id)
          ? { ...item, isBlocked: targetBlockedState }
          : item),
      })),
    } : current);
    setSelectedUnifiedAgent(current => current ? {
      ...current,
      packages: current.packages.map(item => changedAgentIds.has(item.id)
        ? { ...item, isBlocked: targetBlockedState }
        : item),
    } : current);
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

  function toggleUnifiedAgentSelection(record: UnifiedAgentRecord) {
    setSelectionRouteNotice(undefined);
    const resource = record.powerPlatformResource;
    const observation = record.observations.powerPlatform;
    const nativeKey = resource ? quarantineTargetKey(resource) : undefined;
    const canSelectQuarantine = Boolean(canOperate && resource && !quarantineTargetReason(resource, observation));
    const quarantineSelected = nativeKey !== undefined && selectedPowerPlatformTargets.has(nativeKey);
    const ids = record.packages.map(item => item.id);
    const allSelected = ids.every(id => selectedAgentIds.has(id))
      && (!canSelectQuarantine || quarantineSelected);
    if (!allSelected && canSelectQuarantine && nativeKey && !quarantineSelected) {
      if (selectedPowerPlatformTargets.size >= 25) {
        setSelectionRouteNotice({ tone: "error", text: "Quarantine supports up to 25 selected agents. Clear an agent from the selection before adding another." });
        return;
      }
      if (selectedPowerPlatformTargets.size && selectedPowerPlatformSnapshot?.id !== observation?.snapshotId) {
        setSelectionRouteNotice({ tone: "error", text: "The saved inventory changed. Clear the previous quarantine selection before selecting more agents." });
        return;
      }
    }
    setSelectedAgentIds(current => {
      const next = new Set(current);
      for (const id of ids) {
        if (allSelected) next.delete(id);
        else next.add(id);
      }
      return next;
    });
    if (canSelectQuarantine && resource && observation && nativeKey) {
      if (allSelected) {
        setSelectedPowerPlatformTargets(current => {
          const next = new Map(current);
          next.delete(nativeKey);
          return next;
        });
        if (selectedPowerPlatformTargets.size === 1) {
          setSelectedPowerPlatformSnapshot(null);
          setRequestedInventorySnapshotId(undefined);
        }
      } else if (!quarantineSelected) {
        setRequestedInventorySnapshotId(observation.snapshotId);
        setSelectedPowerPlatformSnapshot(observation);
        setSelectedPowerPlatformTargets(current => new Map(current).set(nativeKey, resource));
      }
    }
  }

  function ownsAgentDetailRequest(requestId: number, owner: string, signal: AbortSignal) {
    return !signal.aborted
      && ownsAgentFlowRequest(requestId, owner);
  }

  function ownsAgentFlowRequest(requestId: number, owner: string) {
    return agentDetailRequestId.current === requestId
      && ownsSession(owner)
      && activeViewRef.current === "agents";
  }

  function ownsSession(owner: string) {
    return sessionOwnerRef.current === owner && !sessionRevalidationInFlight.current;
  }

  function ownsBulkJobRequest(requestId: number, owner: string) {
    return bulkJobPollRequestId.current === requestId && ownsSession(owner);
  }

  function ownsPackageRefreshRequest(requestId: number, owner: string) {
    return packageRefreshRequestId.current === requestId
      && ownsSession(owner);
  }

  function ownsInventoryRefreshRequest(requestId: number, owner: string) {
    return inventoryRefreshRequestId.current === requestId
      && ownsSession(owner);
  }

  function requestCurrentAgentReload() {
    forceCurrentAgentReload.current = true;
    setAgentReloadRevision(revision => revision + 1);
  }

  function verifySavedAgentInventory() {
    verificationOnlyAgentReload.current = true;
    setLoadingAgents(true);
    requestCurrentAgentReload();
  }

  if (loadingSession) {
    return <main className="screen-state">Checking sign-in...</main>;
  }

  if (!user) {
    const authorizationOutcome = new URLSearchParams(window.location.search).get("authorization");
    const authorizationNotice = authorizationOutcome === "cancelled"
      ? "Microsoft permission setup was cancelled or denied. Retry or contact your tenant administrator."
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
            Understand and manage your organization's AI agents in one place.
          </p>
          <p>
            Discover agents across Microsoft 365 and Copilot Studio, explore
            Copilot usage and license insights, and investigate activity. Make
            informed decisions about adoption and access, with the controls to
            take action.
          </p>
          {authorizationNotice ? <p role="status">{authorizationNotice}</p> : null}
          {error ? <div className="error-banner">{error}</div> : null}
          {bulkJobStorageError ? <div className="error-banner" role="status">{bulkJobStorageError}</div> : null}
          {authSetup?.authConfigured === false ? <div className="error-banner"><strong>Sign-in is not configured.</strong><p>{authSetup.setup}</p><code>{authSetup.callback}</code></div> : null}
          <a className="primary-link signin-button" aria-disabled={authSetup?.authConfigured === false} href={authSetup?.authConfigured === false ? undefined : "/api/auth/login"}>
            Sign in with Entra ID
          </a>
        </section>
        <AppFooter />
      </main>
    );
  }

  const selectedOfficialUsageSetId = officialUsageReportSetId ?? null;
  const displayedOfficialUsageAggregate = officialUsageAggregateSetId === selectedOfficialUsageSetId
    ? officialUsageAggregate
    : undefined;
  const displayedOfficialUsageUsers = officialUsageUsersSetId === selectedOfficialUsageSetId
    ? officialUsageUsers
    : undefined;
  const historicalUsageLoaded = Boolean(
    officialUsageReportSetId
    && officialUsageAggregateSetId === officialUsageReportSetId
    && officialUsageUsersSetId === officialUsageReportSetId,
  );

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
              {visibleViews.includes("sync") ? <button type="button" className={visibleActiveView === "sync" ? "view-button active" : "view-button"} aria-current={visibleActiveView === "sync" ? "page" : undefined} onClick={() => navigateToView("sync")}>Sync{syncSetupRequired ? <small className="sync-setup-hint">Setup needed</small> : null}</button> : null}
              <button type="button" className={visibleActiveView === "permissions" ? "view-button active" : "view-button"} aria-current={visibleActiveView === "permissions" ? "page" : undefined} onClick={() => navigateToView("permissions")}>Permissions</button>
              {visibleViews.includes("jobs") ? <button type="button" className={visibleActiveView === "jobs" ? "view-button active" : "view-button"} aria-current={visibleActiveView === "jobs" ? "page" : undefined} onClick={() => navigateToView("jobs")}>Jobs</button> : null}
        </nav>
      </header>

      {error ? <div className="error-banner">{error}</div> : null}
      {bulkJobStorageError ? <div className="error-banner" role="status">{bulkJobStorageError}</div> : null}
      {hasRole(user, "AgentControl.Viewer") ? (
        <DataSyncPanel
          ref={dataSyncPanelRef}
          principalKey={principalKey}
          canUploadUsage={canImportReports}
          active={visibleActiveView === "sync"}
          onSetupRequiredChange={setSyncSetupRequired}
          onRunsChanged={handleSyncRunsChanged}
          requestedRunId={requestedDataSyncRunId}
          onOpenUsageImport={() => setUsageImportOpenRequest(request => request + 1)}
          onRequestedRunChange={handleRequestedSyncRunChange}
          onSourcesChanged={handleDataSyncSourcesChanged}
        />
      ) : null}
      {visibleActiveView === "sync" ? (
        <>
          <LinkedAgentJobStatus refreshJob={linkedPackageRefreshJob} error={linkedJobError} />
          <AgentSyncTools
            inventory={unifiedAgentPage}
            verifyingInventory={loadingAgents || deferredQuery !== query}
            inventoryError={unifiedAgentReadError}
            onVerifyInventory={hasRole(user, "AgentControl.Viewer") ? verifySavedAgentInventory : undefined}
            selectedPackageCount={selectedAgentIds.size}
            refreshingPackages={refreshingAgents}
            refreshingPowerPlatform={refreshingPowerPlatformAgents}
            exportingPowerPlatform={exportingPowerPlatformCsv}
            powerPlatformJob={powerPlatformAgentRefreshJob}
            onRefreshPackages={() => void handleRefreshAgents()}
            onRefreshMatchingDetails={() => void handleRefreshMatchingDetails()}
            onRefreshPowerPlatform={() => void handleRefreshPowerPlatformAgents()}
            onResumePowerPlatform={() => void handleResumePowerPlatformAgentRefresh()}
            onExportPowerPlatform={() => void handleExportPowerPlatformAgentCsv()}
            onOpenAgents={() => navigateToView("agents")}
          />
          <JobsView key={principalKey} user={user} scope="sync" onOpenSyncRun={handleRequestedSyncRunChange} onChanged={() => void dataSyncPanelRef.current?.refresh()} revision={syncHistoryRevision} />
        </>
      ) : null}
      {canImportReports ? (
        <OfficialUsageImportModal
          key={`${principalKey}:${requestedOfficialUsageStagingId ?? ""}`}
          initialStagingId={requestedOfficialUsageStagingId}
          openRequest={usageImportOpenRequest}
          showTrigger={false}
          onChanged={handleOfficialUsageChanged}
          onLegacyCleared={() => setLegacyUsagePresent(false)}
        />
      ) : null}
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
          <LinkedAgentJobStatus controlJob={requestedPackageControlJobId ? trackedJob : undefined} error={requestedPackageControlJobId ? linkedJobError : undefined} />
          <div className="agent-catalog-heading">
            <div className="agent-catalog-title">
              <h2>Agents <span>{(unifiedAgentPage?.count ?? 0).toLocaleString()}{hasActiveAgentFilters ? ` of ${(unifiedAgentPage?.summary.total ?? 0).toLocaleString()}` : ""}</span></h2>
              <span className="last-refresh" aria-live="polite">
                {refreshingAgents ? linkedPackageRefreshJob?.message ?? "Collecting agent identities and matching records; no agent settings are changed."
                  : lastAgentListRefreshAt
                  ? `Graph collected ${formatRefreshTime(lastAgentListRefreshAt)}${packageSnapshotExpiresAt && packageSnapshotExpiresAt.getTime() <= Date.now() ? " / expired" : ""}`
                    : "No saved package observation. Open Data sync on the Sync tab to collect workspace data."}
              </span>
            </div>
            <div className="agent-catalog-actions">
              {!loadingAgents && (unifiedAgentReadError || agentInventoryIssueSummary) ? <button type="button" className="secondary" onClick={() => navigateToView("sync")} title={unifiedAgentReadError || unifiedAgentPage?.errors.map(item => item.message).join(" ") || agentInventoryIssueSummary}>Inventory needs attention · Open Sync</button> : null}
              <button
                type="button"
                className="secondary icon-button control-icon-button"
                aria-label={exportingCsv ? "Exporting agent inventory CSV" : "Export agent inventory CSV"}
                title={!agentExportRevision ? "Reload saved agent inventory to obtain a valid export revision" : "Export unified agents from the current saved inventory"}
                disabled={!canReadSensitiveUsage || loadingAgents || deferredQuery !== query || exportingCsv || !agentExportRevision || agentExportNeedsReload || (exportableAgentCount === 0 && selectedExportTargetCount === 0)}
                onClick={requestExportCsv}
              >
                <ExportIcon />
              </button>
            </div>
          </div>

          {agentExportError || agentExportNeedsReload ? <div className="error-banner" role="alert">
            <span>{agentExportError?.message ?? (unifiedAgentReadError
              ? "The current saved agent inventory could not be loaded. Reload the saved inventory before exporting."
              : "A saved agent inventory revision is unavailable. Reload the saved inventory before exporting.")}</span>
            {agentExportNeedsReload ? <button type="button" className="secondary" disabled={loadingAgents} onClick={requestCurrentAgentReload}>Reload saved agent inventory</button> : null}
          </div> : null}
          {exportingCsv ? <div className="report-status" role="status">Preparing agent inventory CSV. The server exports each resolved agent once.</div> : null}
          {canOperate && (selectedAgentIds.size > 0 || busyBulkAction || bulkProgress || bulkResult) ? <BulkActions
            disabled={
              loadingAgents || Boolean(busyAgentId) || Boolean(busyBulkAction)
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
            <section className="job-status-panel" aria-label="Job controls">
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
                <span>Built with</span>
                <select value={effectivePlatformFilter} className={effectivePlatformFilter === "all" ? undefined : "active-filter-select"} onChange={event => { setPlatformFilter(event.target.value); setAgentPageIndex(0); }}>
                  <option value="all">All platforms</option>
                  {platformOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
              </label>
              <label>
                <span>Available to</span>
                <select value={availableToFilter} className={availableToFilter === "all" ? undefined : "active-filter-select"} onChange={event => { setAvailableToFilter(event.target.value); setAgentPageIndex(0); }}>
                  <option value="all">All availability</option>
                  {availableToOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
              </label>
              <label>
                <span>Host</span>
                <select value={hostFilter} className={hostFilter === "all" ? undefined : "active-filter-select"} onChange={event => { setHostFilter(event.target.value); setAgentPageIndex(0); }}>
                  <option value="all">All hosts</option>
                  {hostOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
              </label>
            </div>

            <div className="filter-section agent-filter-toolbar">
              <label className="threshold-filter">
                <span>Created within</span>
                <div className="number-with-unit">
                  <input type="number" min="1" max="3650" value={createdWithinDays} className={parseOptionalPositiveInteger(createdWithinDays) ? "active-filter-input" : undefined} placeholder="Any" onChange={event => { setCreatedWithinDays(event.target.value); setAgentPageIndex(0); }} />
                  <span>days</span>
                </div>
              </label>
              <label>
                <span>Package status</span>
                <select
                  className={statusFilter === "all" ? undefined : "active-filter-select"}
                  value={statusFilter}
                  onChange={(event) => {
                    setStatusFilter(event.target.value as "all" | "allowed" | "blocked");
                    setAgentPageIndex(0);
                  }}
                >
                  <option value="all">All states</option>
                  <option value="allowed">Allowed</option>
                  <option value="blocked">Blocked</option>
                </select>
              </label>
              <label className="agent-sort-control">
                <span>Sort</span>
                <select
                  value={`${agentSortBy === "lastModifiedAt" ? "lastModifiedAt" : "displayName"}:${agentSortDirection}`}
                  onChange={event => {
                    const option = agentSortOptions.find(item => item.value === event.target.value);
                    if (!option) {
                      setError("Choose a supported agent sort order.");
                      return;
                    }
                    setAgentSortBy(option.sortBy);
                    setAgentSortDirection(option.direction);
                    setAgentPageIndex(0);
                  }}
                >
                  {agentSortOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
              </label>
              <div className="agent-filter-toolbar-actions">
                <label className="advanced-filter-toggle">
                  <input
                    type="checkbox"
                    checked={showAdvancedFilters}
                    onChange={event => setShowAdvancedFilters(event.target.checked)}
                    aria-controls="agent-advanced-filters"
                    aria-expanded={showAdvancedFilters}
                  />
                  <span>Advanced filters</span>
                  {advancedFilterCount > 0 ? <> <span className="advanced-filter-count">{advancedFilterCount} active</span></> : null}
                </label>
                <button type="button" className="secondary clear-filters-button" disabled={!hasActiveAgentFilters} onClick={handleClearAgentFilters}>
                  Clear filters
                </button>
              </div>
            </div>

            <div id="agent-advanced-filters" className="agent-advanced-filters" role="region" aria-label="Advanced agent filters" hidden={!showAdvancedFilters}>
              <div className="filter-section filter-section-advanced">
                <label>
                  <span>Publisher</span>
                  <select value={publisherFilter} className={publisherFilter === "all" ? undefined : "active-filter-select"} onChange={event => { setPublisherFilter(event.target.value); setAgentPageIndex(0); }}>
                    <option value="all">All publishers</option>
                    {publisherOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                  </select>
                </label>
                <EnvironmentFilter
                  key={agentEnvironmentFilter}
                  options={unifiedAgentPage?.facets?.environments ?? []}
                  value={agentEnvironmentFilter}
                  loading={loadingAgents}
                  onChange={value => { setAgentEnvironmentFilter(value); setAgentPageIndex(0); resetPowerPlatformSelection(); }}
                />
              </div>
            </div>
          </section>

          {canOperate && (selectedPowerPlatformTargets.size > 0 || pendingPowerPlatformIds.size > 0 || requestedQuarantineJobId) ? <CopilotStudioQuarantineControls
            snapshot={selectedQuarantineObservation}
            targets={[...selectedPowerPlatformTargets.values()]}
            variant="bulk"
            canManage={canOperate}
            pendingTargetCount={pendingPowerPlatformIds.size}
            onClear={resetPowerPlatformSelection}
            initialJobId={requestedQuarantineJobId}
            onJobChange={job => setRequestedQuarantineJobId(job.id)}
          /> : null}

          {loadingBulkRefSearch ? (
            <div className="screen-state">
              Resolving bulk ref {normalizedBulkRefQuery}...
            </div>
          ) : null}
          {loadingAgents ? (
            <div className="screen-state">Loading Copilot agents...</div>
          ) : (
            <div className="agent-table-stack">
              <UnifiedAgentTable
                records={displayedUnifiedAgents}
                busyPackageId={busyAgentId}
                selectedPackageIds={selectedAgentIds}
                selectedPowerPlatformKeys={new Set(selectedPowerPlatformTargets.keys())}
                packageSelectionAllowed
                packageOperationsAllowed={canOperate}
                quarantineSelectionAllowed={canOperate}
                quarantineSelectionRestoring={pendingPowerPlatformIds.size > 0}
                selectionDisabled={Boolean(busyBulkAction) || refreshingAgents}
                environmentNames={agentEnvironmentNames}
                onToggleSelection={toggleUnifiedAgentSelection}
                onViewDetails={record => {
                  setAgentDetailTab("identities");
                  void handleViewUnifiedAgentDetails(record);
                }}
                onManageAccess={record => {
                  const item = record.packages[0];
                  if (item) void handleManageAgentAccess(item);
                }}
                onSetBlocked={(record, blocked) => {
                  const item = record.packages[0];
                  if (item) void handleAgentAction(item, blocked);
                }}
              />
              <AgentPageControls
                pageIndex={agentPageIndex}
                pageSize={agentDisplayPageSize}
                totalCount={unifiedAgentPage?.count ?? 0}
                loading={loadingAgents}
                onPageChange={setAgentPageIndex}
              />
            </div>
          )}
        </>
        )
      ) : visibleActiveView === "power-platform" ? (
        hasRole(user, "AgentControl.Viewer")
          ? <InventoryExplorer key={`${principalKey}:${powerPlatformDataRevision}`} canManageQuarantine={Boolean(user && hasRole(user, "AgentControl.Admin"))} />
          : <CopilotStudioQuarantineTargetPicker key={principalKey} initialJobId={parsePowerPlatformRoute(window.location.search).quarantineJobId} />
      ) : visibleActiveView === "users" ? (
        <CopilotUsersView
          key={principalKey}
          dataRevision={copilotUsersDataRevision}
          onSyncUsers={() => {
            navigateToView("sync");
            setSyncHistoryRevision(revision => revision + 1);
            return dataSyncPanelRef.current?.start("incremental", ["users"]) ?? Promise.resolve();
          }}
        />
      ) : visibleActiveView === "official-usage" ? (
        <section className="official-usage-workbench" aria-label="Official usage">
          <header className="usage-page-header">
            <div>
              <h2>Official usage</h2>
              <p>Microsoft 365 Copilot Agents activity</p>
            </div>
            {canImportReports ? <button type="button" className="secondary" onClick={() => setUsageImportOpenRequest(request => request + 1)}><Upload size={16} />Import reports</button> : null}
          </header>
          {officialUsageReportSetId ? (
            <div className="usage-history-selection" role="status">
              <div>
                <strong>Historical snapshot view</strong>
                <span>
                  {loadingOfficialUsage
                    ? `Loading retained set ${officialUsageReportSetId.slice(0, 8)}. Data from a different snapshot is not shown here.`
                    : officialUsageLoadError
                      ? historicalUsageLoaded
                        ? `Showing the last loaded data for retained set ${officialUsageReportSetId.slice(0, 8)}; refresh failed.`
                        : `Retained set ${officialUsageReportSetId.slice(0, 8)} is unavailable.`
                      : historicalUsageLoaded
                        ? `Showing retained set ${officialUsageReportSetId.slice(0, 8)}.`
                        : `Retained set ${officialUsageReportSetId.slice(0, 8)} has not loaded.`}
                  {" "}The tenant’s current snapshot selection is unchanged.
                </span>
              </div>
              <button type="button" className="secondary" onClick={() => handleOfficialUsageSnapshotChange(undefined)}>Return to current snapshot</button>
            </div>
          ) : null}
          {officialUsageLoadError ? <div className="error-banner" role="alert">{officialUsageLoadError}</div> : null}
          {hasRole(user, "AgentControl.Viewer") ? <ReportingView
            key={`${principalKey}:${officialUsageDashboardRevision}`}
            activityWindowDays={reportActivityWindowDays}
            data={displayedOfficialUsageAggregate}
            inactiveDays={inactiveDays}
            reportSetId={officialUsageReportSetId}
            onActivityWindowDaysChange={handleReportActivityWindowChange}
            onAgentPageChange={setOfficialUsageAgentOffset}
            onAgentQueryChange={(query) => {
              setOfficialUsageAgentOffset(0);
              setOfficialUsageAgentQuery(query);
            }}
            onUserPageChange={setOfficialUsageUserOffset}
            onUserQueryChange={(query) => {
              setOfficialUsageUserOffset(0);
              setOfficialUsageUserQuery(query);
            }}
            userData={canReadSensitiveUsage ? displayedOfficialUsageUsers : undefined}
          /> : null}
          <OfficialUsageHistoryPanel
            revision={officialUsageDashboardRevision}
            selectedSetId={officialUsageReportSetId}
            onSelect={handleOfficialUsageSnapshotChange}
          />
        </section>
      ) : visibleActiveView === "audit" ? (
        <AuditLogView key={principalKey} agents={agents} />
      ) : visibleActiveView === "security" ? (
        <DefenderHuntingView key={principalKey} />
      ) : visibleActiveView === "jobs" ? (
        <JobsView key={principalKey} user={user} />
      ) : visibleActiveView === "sync" ? null : <div className="screen-state">No Agent Control app role is assigned.</div>}

      {loadingAgentDetailId ? (
        <div className="detail-loading" role="status" aria-live="polite">
          Loading agent details...
        </div>
      ) : null}

      {agentDetailError && !agentDetail && !selectedUnifiedAgent ? (
        <div className="error-banner" role="alert">{agentDetailError}</div>
      ) : null}

      {selectedUnifiedAgent && !singleAccessAgentDetail && !bulkAccessAgentIds && !bulkConfirmation ? (
        <UnifiedAgentDetailModal
          record={selectedUnifiedAgent}
          environmentNames={agentEnvironmentNames}
          activeTab={agentDetailTab}
          onTabChange={setAgentDetailTab}
          roles={user?.roles ?? []}
          externalAccessEditorOpen={Boolean(singleAccessAgentDetail)}
          onClose={() => {
            agentDetailRequestId.current += 1;
            setLoadingAgentDetailId(undefined);
            setAgentDetail(undefined);
            setSelectedUnifiedAgent(undefined);
            setRequestedAgentDetailId(undefined);
          }}
          onInspectPackage={item => {
            void handleViewAgentDetails(item);
          }}
          packageDetail={selectedUnifiedAgent.packages.some(item => item.id === agentDetail?.id) ? agentDetail : undefined}
          packageDetailLoading={Boolean(loadingAgentDetailId)}
          packageDetailError={agentDetailError}
          onManagePackageAccess={(item, target) => void handleManageAgentAccess(item, target)}
          onSetPackageBlocked={(item, blocked) => {
            void handleAgentAction(item, blocked);
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
          onCancel={() => {
            agentDetailRequestId.current += 1;
            setSingleAccessAgentDetail(undefined);
          }}
          onSubmit={async (update) => {
            if (await requestAccessConfirmation([singleAccessAgentDetail.id], update, "single")) {
              setSingleAccessAgentDetail(undefined);
            }
          }}
        />
      ) : null}

      {bulkAccessAgentIds ? (
        <AccessAssignmentModal
          context="bulk"
          agentCount={bulkAccessAgentIds.length}
          onCancel={() => {
            agentDetailRequestId.current += 1;
            setBulkAccessAgentIds(undefined);
          }}
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
          selectedTargetCount={selectedExportTargetCount}
          selectionRestoring={exportSelectionRestoring}
          disabled={loadingAgents || deferredQuery !== query || !agentExportRevision || agentExportNeedsReload}
          onCancel={() => setExportChoiceOpen(false)}
          onClearSelection={() => {
            setSelectedAgentIds(new Set());
            setPendingStoredAgentSelectionCount(undefined);
            resetPowerPlatformSelection();
            setSelectionRouteNotice(undefined);
          }}
          onExport={scope => void handleExportCsv(scope)}
        />
      ) : null}

      <AppFooter />
    </main>
    </WorkbenchActionProvider>
    </CapabilityContext>
  );
}

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

function loadStoredActiveBulkJobId(): { jobId?: string; error?: string } {
  if (typeof window === "undefined") {
    return {};
  }

  try {
    return { jobId: window.localStorage.getItem(activeBulkJobStorageKey) ?? undefined };
  } catch {
    return { error: "Unable to read the saved package job from browser storage. Open Jobs to recover retained work." };
  }
}

function saveStoredActiveBulkJobId(jobId: string) {
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(activeBulkJobStorageKey, jobId);
    } catch {
      return "Unable to save the active package job in browser storage. Tracking continues in this tab; use Jobs after reload.";
    }
  }
}

function clearStoredActiveBulkJobId() {
  if (typeof window !== "undefined") {
    try {
      window.localStorage.removeItem(activeBulkJobStorageKey);
    } catch {
      return "Unable to clear the saved package job from browser storage. A later reload may retry the saved job ID with current authorization.";
    }
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

function countAdvancedAgentFilters(filters: Pick<AgentRouteState, "environmentId" | "publisher">) {
  return [
    filters.environmentId.trim().length > 0,
    filters.publisher !== "all",
  ].filter(Boolean).length;
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
  selectedTargetCount,
  selectionRestoring,
  disabled,
  onCancel,
  onClearSelection,
  onExport,
}: {
  agentCount: number;
  isFiltered: boolean;
  selectedTargetCount: number;
  selectionRestoring: boolean;
  disabled: boolean;
  onCancel: () => void;
  onClearSelection: () => void;
  onExport: (scope: UnifiedAgentExportScope) => void;
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
          <h2 id="export-choice-title">Export agent inventory</h2>
        </div>
        <p>
          Download one CSV row per resolved agent, retaining all package IDs and states,
          Power Platform configuration, and partial-inventory status. The server checks
          your current authorization and saved inventory revision.
          CSV generation is also bounded to 8 MB and 15 seconds; narrow filters or
          reduce the selection if a limit is reached.
        </p>
        <div className="export-choice-grid">
          <button
            type="button"
            className="secondary export-choice-card"
            disabled={disabled || agentCount === 0 || agentCount > maximumUnifiedAgentExportRows}
            onClick={() => onExport("matching")}
          >
            <strong>Download matching agents</strong>
            <span>Export all {agentCount.toLocaleString()} {isFiltered ? "filtered" : "saved"} agents across all pages, using the current filters and sorting.</span>
            <small>{agentCount > maximumUnifiedAgentExportRows ? "More than 5,000 agents match. Narrow the filters before exporting." : "Up to 5,000 agent rows; not limited to the displayed page."}</small>
          </button>
          <button
            type="button"
            className="secondary export-choice-card"
            disabled={disabled || selectionRestoring || selectedTargetCount === 0}
            onClick={() => onExport("selected")}
          >
            <strong>Download selected agents</strong>
            <span>{selectedTargetCount.toLocaleString()} selected package/native references. The server resolves aliases and exports each agent once, with all its packages.</span>
            <small>{selectionRestoring ? "Wait for saved selections to finish restoring." : "Current filters do not narrow this selection; current sorting is preserved. Up to 5,000 resolved agent rows."}</small>
          </button>
        </div>
        <div className="confirm-actions">
          {selectedTargetCount > 0 || selectionRestoring ? <button type="button" className="secondary" onClick={onClearSelection}>Clear selection</button> : null}
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
