import {
  useCallback,
  useDeferredValue,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { InventoryRefreshTargets } from "./components/InventoryRefreshTargets";
import {
  ArrowRight,
  Ban,
  BarChart3,
  Bot,
  CircleCheck,
  ExternalLink,
  Globe2,
  LogOut,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import {
  ApiError,
  blockAgent,
  blockAgents,
  getAgentDetails,
  getAgents,
  getUnifiedAgentDetail,
  getPackageRefreshJob,
  getPackageRefreshJobs,
  getInventoryRefreshJob,
  getInventoryRefreshJobs,
  getBulkActionJob,
  getBulkActionJobItems,
  getBulkActionJobs,
  getCurrentUser,
  getWorkbenchMetadata,
  cancelBulkActionJob,
  previewPackageMutation,
  submitSelectedPackageMutation,
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
  type BulkPackageResult,
  type AuditAction,
  type CopilotPackage,
  type CopilotPackageDetail,
  type DataSyncSourceId,
  type PackageMutationPreview,
  countPackageMutationSelection,
  type PackageAccessUpdate,
  type PackageAccessTarget,
  type PackageRefreshJob,
  type InventoryRefreshJob,
  type PowerPlatformResource,
  type QuarantineJob,
  type SessionUser,
  type UnifiedAgentInventoryPage,
  type UnifiedAgentRecord,
  type UnifiedAgentInventoryQuery,
} from "./api/client";
import { selectedAgentExportReferences, type UnifiedAgentExportScope } from "./agentExport";
import { ReportExportButton } from "./components/ReportExportButton";
import "./App.css";
import { isJobPolling, isKnownJobStatus, jobStatusMessage } from "./jobStatus";
import { parseBulkRefSearch } from "./bulkRefSearch";
import { projectVerifiedAccessScope, projectVerifiedAgentMutation } from "./packageMutationState";
import { clearPackageSelection, restorePackageSelection, storePackageSelection } from "./packageSelectionSession";
import { allowedViews, hasRole } from "./authorization";
import { useCapabilities } from "./useCapabilities";
import { useAutomaticRefresh } from "./useAutomaticRefresh";
import { PublicationContext } from "./publicationContext";
import { useBrowserAvailability } from "./useBrowserAvailability";
import { AutomaticRefreshStatus } from "./components/AutomaticRefreshStatus";
import { BackgroundRefreshIndicator } from "./components/BackgroundRefreshIndicator";
import { parseUnifiedAgentRecordId, unifiedAgentRecordId, type UnifiedAgentInventoryScope, type UnifiedAgentInventoryUnavailable, type UnifiedAgentSort } from "../../backend/src/types/unifiedAgents";
import { inventoryScopeAgentCount } from "./agentColumns";
import { AgentInventoryQueries } from "./agentInventoryQueries";
import { isExpiredSelection, selectedReadRemaining, useSelectedReadLease } from "./selectedRead";
import { inventoryAttentionReasons } from "./inventoryVerification";
import { providerActionAllowed } from "./capabilityState";
import { quarantineTargetKey, quarantineTargetReason, type QuarantineSelectionSnapshot } from "./quarantineTarget";
import { findUnifiedAgentRecord } from "./unifiedAgentIdentity";
import { CapabilityGate } from "./components/CapabilityGate";
import { CapabilityContext } from "./capabilityContext";
import { CapabilityHealth, PermissionCenter } from "./components/PermissionCenter";
import { AccessAssignmentModal } from "./components/AccessAssignmentModal";
import { UnifiedAgentTable } from "./components/UnifiedAgentTable";
import { UnifiedAgentDetailModal } from "./components/UnifiedAgentDetailModal";
import { WorkbenchDialog } from "./components/WorkbenchDialog";
import { AuditLogView } from "./components/AuditLogView";
import { BulkActions, type BulkProgress, type BulkJobCommand } from "./components/BulkActions";
import { AgentInventoryOverview, AgentInventoryScopes } from "./components/AgentInventoryOverview";
import { AgentInventoryFilters, type AgentFilterValues } from "./components/AgentInventoryFilters";
import { CopilotUsersView } from "./components/CopilotUsersView";
import { CopilotStudioQuarantineControls } from "./components/CopilotStudioQuarantineControls";
import { OfficialUsageImportModal } from "./components/OfficialUsageImportModal";
import { OfficialUsageReportSelector } from "./components/OfficialUsageReportSelector";
import { CsvUsageReportsSection } from "./components/CsvUsageReportsSection";
import { DataSyncPanel, type DataSyncPanelHandle, type WorkspaceSetupStatus } from "./components/DataSyncPanel";
import { WorkspaceSkeleton } from "./components/WorkspaceSkeleton";
import { AgentSyncTools } from "./components/AgentSyncTools";
import { PowerPlatformSourceJob } from "./components/PowerPlatformSourceJob";
import { SyncHistoryView } from "./components/SyncHistoryView";
import {
  agentRouteSearch,
  dataSyncRouteSearch,
  parseDataSyncRoute,
  migrateOfficialUsageRoute,
  migrateSecurityRoute,
  migrateJobsRoute,
  parseAgentRoute,
  parseUsersRoute,
  usersRouteSearch,
  parseWorkbenchView,
  isWorkbenchPath,
  workbenchUrl,
  type UsersRouteState,
  type SyncReportRouteState,
  type WorkbenchViewId,
} from "./workbenchRouting";
import { findWorkbenchAction, WorkbenchActionGate, WorkbenchActionProvider } from "./workbenchActionContext";
import { SavedQueryProvider } from "./components/SavedQueryProvider";
import { createSavedQueryClient, readSavedQuery } from "./savedQueries";
import { trapDialogFocus } from "./dialogFocus";
import { SignInForm } from "./components/SignInForm";
import "./components/agentWorkspace.css";

const activeBulkJobStoragePrefix = "agent-control:active-bulk-job:v2:";
const bulkJobPollIntervalMs = 1_000;
const packageRefreshPollIntervalMs = 750;
const inventoryRefreshPollIntervalMs = 1_000;
const foregroundJobPollBudgetMs = 5 * 60_000;
const agentDisplayPageSize = 50;

type RouteOwner = { principal: string; session: string };

function routePrincipal(user: SessionUser) {
  return JSON.stringify([user.tenantId ?? "", user.homeAccountId, [...user.roles].sort()]);
}

function readRouteOwner(): RouteOwner | undefined {
  const owner = window.history.state?.workbenchOwner;
  return owner && typeof owner.principal === "string" && typeof owner.session === "string" ? owner : undefined;
}

function publicRouteSearch() {
  const search = new URLSearchParams(window.location.search);
  for (const key of [
    "detail", "detailTab", "tab", "person", "agent", "page", "selected", "selectionState", "selectionCount",
    "selectedResource", "inventorySnapshot", "quarantineJob", "controlJob", "refreshJob", "mode",
    "syncRun", "powerPlatformJob", "reports", "staging", "snapshot", "correction", "window",
  ]) search.delete(key);
  return search;
}

function selectedPackagePreview(record: UnifiedAgentRecord, detail: CopilotPackageDetail, selectionId: string): UnifiedAgentRecord {
  if (record.packages.some(item => item.id === detail.id)) return record;
  const source = detail.selectedSource, observed = detail.observation;
  if (!source || !observed || source.selectionId !== selectionId || source.recordId !== record.id.replace(/^agent:/, "")
    || source.sourceIdentity !== detail.id || !source.generationId) {
    throw new Error("The selected published version does not belong to the displayed inventory group.");
  }
  const primary = record.packages[0];
  return { ...record, packages: [...(primary ? [primary] : []), detail], packagesComplete: false,
    identity: { ...record.identity, packageEvidence: [
      ...record.identity.packageEvidence.filter(value => value.packageId === primary?.id),
      { packageId: detail.id, evidence: detail.matchingEvidence ?? [] },
    ] },
    observations: { ...record.observations, packageSnapshots: {
      ...(primary && record.observations.packageSnapshots[primary.id]
        ? { [primary.id]: record.observations.packageSnapshots[primary.id] } : {}),
      [detail.id]: { id: source.generationId, snapshotId: source.generationId, scopeKind: "exact",
        observedAt: observed.observedAt, expiresAt: observed.expiresAt, current: observed.current === true, identityDetails: null },
    } },
  };
}

function LinkedAgentJobStatus({
  controlJob,
  error,
  refreshJob,
  owner,
  loadingRefreshStatus,
  waitingForRefreshStatus,
  onRefreshStatus,
}: {
  controlJob?: BulkActionJob;
  error?: string;
  refreshJob?: PackageRefreshJob;
  owner?: string;
  loadingRefreshStatus?: boolean;
  waitingForRefreshStatus?: boolean;
  onRefreshStatus?: () => void;
}) {
  return (
    <>
      {error ? <div className="error-banner" role="alert">{error}</div> : null}
      {waitingForRefreshStatus ? <p role="status">Waiting for the current package refresh before checking the selected job…</p>
        : loadingRefreshStatus ? <p role="status">Loading package refresh status…</p> : null}
      {(refreshJob || error) && onRefreshStatus ? <button type="button" disabled={loadingRefreshStatus || waitingForRefreshStatus}
        onClick={onRefreshStatus}>Refresh status</button> : null}
      {refreshJob ? (
        <section className="job-status-panel" aria-label="Selected package refresh job">
          <strong>Package refresh · {refreshJob.status.replaceAll("_", " ")}</strong>
          <span>{refreshJob.observedCount}{refreshJob.totalRecords === null ? "" : ` of ${refreshJob.totalRecords}`} packages observed</span>
          <code>{refreshJob.id}</code>
          {refreshJob.message ? <span>{refreshJob.message}</span> : null}
          {refreshJob.scopeKind === "exact" ? <InventoryRefreshTargets job={refreshJob} owner={owner} /> : null}
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

function readViewSearch(...views: WorkbenchViewId[]) {
  return views.includes(parseWorkbenchView(window.location.pathname)) ? window.location.search : "";
}

function readInitialAgentRoute() {
  const jobsRedirect = migrateJobsRoute(window.location.pathname);
  if (jobsRedirect) window.history.replaceState({ ...window.history.state, view: "sync" }, "", jobsRedirect);
  const securityRedirect = migrateSecurityRoute(window.location.pathname);
  if (securityRedirect) window.history.replaceState({ ...window.history.state, view: "agents" }, "", securityRedirect);
  const reports = migrateOfficialUsageRoute(window.location.pathname, window.location.search);
  if (reports) window.history.replaceState({ ...window.history.state, view: "sync" }, "", workbenchUrl("sync", reports));
  const syncRoute = parseDataSyncRoute(window.location.search);
  if (parseWorkbenchView(window.location.pathname) === "agents" && (syncRoute.syncRunId || (syncRoute.refreshJobId && !parseAgentRoute(window.location.search).controlJobId))) {
    window.history.replaceState({ ...window.history.state, view: "sync" }, "", workbenchUrl("sync", dataSyncRouteSearch(syncRoute)));
  }
  // Sync retains inventory filters and exact job links for saved-data verification.
  return parseAgentRoute(readViewSearch("agents", "sync"));
}

function App() {
  const [savedQueries] = useState(createSavedQueryClient);
  const [routeAvailable, setRouteAvailable] = useState(() => isWorkbenchPath(window.location.pathname));
  useEffect(() => {
    const restoreRoute = () => setRouteAvailable(isWorkbenchPath(window.location.pathname));
    window.addEventListener("popstate", restoreRoute);
    return () => window.removeEventListener("popstate", restoreRoute);
  }, []);
  if (!routeAvailable) return <main className="screen-state"><h1>Page not found</h1><p>This page is not available. <a href="/agents">Open Agents</a></p></main>;
  return <SavedQueryProvider client={savedQueries}><Workbench savedQueries={savedQueries} /></SavedQueryProvider>;
}

function Workbench({ savedQueries }: { savedQueries: ReturnType<typeof createSavedQueryClient> }) {
  const statusObservationAvailable = useBrowserAvailability();
  const [agentInventoryQueries] = useState(() => new AgentInventoryQueries());
  const [initialAgentRoute] = useState(readInitialAgentRoute);
  const [syncReportRoute, setSyncReportRoute] = useState(() => parseDataSyncRoute(readViewSearch("sync")).reports);
  const [powerPlatformJobSelection, setPowerPlatformJobSelection] = useState<{ id?: string; initialJob?: InventoryRefreshJob }>(
    () => ({ id: parseDataSyncRoute(readViewSearch("sync")).powerPlatformJobId }),
  );
  const requestedPowerPlatformJobId = powerPlatformJobSelection.id;
  const selectPowerPlatformJob = useCallback((id: string | undefined, initialJob?: InventoryRefreshJob) => {
    setPowerPlatformJobSelection({ id, initialJob });
  }, []);
  const [usersRoute, setUsersRoute] = useState(() => parseUsersRoute(readViewSearch("users")));
  const [user, setUser] = useState<SessionUser>();
  const [sessionEpoch, setSessionEpoch] = useState(0);
  const [initialRouteSession] = useState(() => crypto.randomUUID());
  const routeSession = useRef(initialRouteSession);
  const [agentScopeEpoch, setAgentScopeEpoch] = useState(0);
  const agentScopeEpochRef = useRef(0);
  const [loadedWorkbenchMetadata, setLoadedWorkbenchMetadata] = useState<{
    principalKey: string;
    value: Awaited<ReturnType<typeof getWorkbenchMetadata>>;
  }>();
  const capabilityState = useCapabilities(user, sessionEpoch);
  const [trackedJob, setTrackedJob] = useState<BulkActionJob>();
  const [trackedJobId, setTrackedJobId] = useState<string>();
  const [bulkJobCommand, setBulkJobCommand] = useState<BulkJobCommand>();
  const [bulkJobError, setBulkJobError] = useState<string>();
  const [bulkJobStatusUnrecognized, setBulkJobStatusUnrecognized] = useState(false);
  const [bulkJobStorageError, setBulkJobStorageError] = useState<string>();
  const [linkedPackageRefreshJob, setLinkedPackageRefreshJob] = useState<PackageRefreshJob>();
  const [linkedPackageRefreshError, setLinkedPackageRefreshError] = useState<string>();
  const [linkedPackageRefreshLoading, setLinkedPackageRefreshLoading] = useState(false);
  const [linkedPackageRefreshRevision, setLinkedPackageRefreshRevision] = useState(0);
  const [linkedJobError, setLinkedJobError] = useState<string>();
  const [authSetup, setAuthSetup] = useState<{ authConfigured: boolean; callback: string; setup?: string }>();
  const [authSetupError, setAuthSetupError] = useState<string>();
  const [agents, setAgents] = useState<CopilotPackage[]>([]);
  const [unifiedAgentPage, setUnifiedAgentPage] = useState<UnifiedAgentInventoryPage>();
  const [inventoryUnavailable, setInventoryUnavailable] = useState<UnifiedAgentInventoryUnavailable>();
  const inventoryNavigation = useRef<{ key: string; selectionId?: string; cursor?: string }>({ key: "" });
  const [unifiedAgentReadError, setUnifiedAgentReadError] = useState<string>();
  const [expiredAgentSelection, setExpiredAgentSelection] = useState<string>();
  const [selectedUnifiedAgent, setSelectedUnifiedAgent] = useState<UnifiedAgentRecord>();
  const [agentPackageSelection, setAgentPackageSelection] = useState<{ owner: string; recordId: string; packageId: string }>();
  const [packageAccessRevisions, setPackageAccessRevisions] = useState(new Map<string, number>());
  const [packageControlError, setPackageControlError] = useState<{ packageId: string; message: string }>();
  const [selectedPowerPlatformTargets, setSelectedPowerPlatformTargets] = useState<Map<string, PowerPlatformResource>>(new Map());
  const [selectedPowerPlatformSnapshot, setSelectedPowerPlatformSnapshot] = useState<QuarantineSelectionSnapshot | null>(null);
  const [pendingPowerPlatformIds, setPendingPowerPlatformIds] = useState<Set<string>>(() => new Set(initialAgentRoute.selectedPowerPlatformIds));
  const [agentEnvironmentFilter, setAgentEnvironmentFilter] = useState(initialAgentRoute.environmentId);
  const [requestedQuarantineJobId, setRequestedQuarantineJobId] = useState(initialAgentRoute.quarantineJobId);
  const [quarantineReceiptPending, setQuarantineReceiptPending] = useState(false);
  const observedQuarantineResults = useRef(new Set<string>());
  const [requestedInventorySnapshotId, setRequestedInventorySnapshotId] = useState(initialAgentRoute.inventorySnapshotId);
  const [loadingSession, setLoadingSession] = useState(true);
  const [signingOut, setSigningOut] = useState(false);
  const [loadingAgents, setLoadingAgents] = useState(false);
  const [initialAgentReadOwner, setInitialAgentReadOwner] = useState<string>();
  const [error, setError] = useState<string>();
  const [query, setQuery] = useState(initialAgentRoute.search);
  const [agentInventoryScope, setAgentInventoryScope] = useState(initialAgentRoute.inventoryScope);
  const [packageType, setPackageType] = useState(initialAgentRoute.packageType);
  const [endUserAccess, setEndUserAccess] = useState(initialAgentRoute.endUserAccess);
  const [reportedUsage, setReportedUsage] = useState(initialAgentRoute.reportedUsage);
  const [agentManagement, setAgentManagement] = useState(initialAgentRoute.management);
  const [agentRelevance, setAgentRelevance] = useState(initialAgentRoute.relevance);
  const [statusFilter, setStatusFilter] = useState<
    "all" | "allowed" | "blocked"
  >(initialAgentRoute.status);
  const [publisherFilter, setPublisherFilter] = useState(initialAgentRoute.publisher);
  const [availableToFilter, setAvailableToFilter] = useState(initialAgentRoute.availability);
  const [hostFilter, setHostFilter] = useState(initialAgentRoute.host);
  const [platformFilter, setPlatformFilter] = useState(initialAgentRoute.platform);
  const [createdWithinDays, setCreatedWithinDays] = useState(initialAgentRoute.createdWithinDays);
  const [agentSortBy, setAgentSortBy] = useState<UnifiedAgentSort>(initialAgentRoute.sortBy);
  const [agentSortDirection, setAgentSortDirection] = useState(initialAgentRoute.sortDirection);
  const [agentPageIndex, setAgentPageIndex] = useState(initialAgentRoute.page);
  const [selectedAgentIds, setSelectedAgentIds] = useState<Set<string>>(
    () => new Set(initialAgentRoute.selectedIds),
  );
  const [serverPackageSelection, setServerPackageSelection] = useState<{ id: string; owner: string }>();
  const [groupPackageSelection, setGroupPackageSelection] = useState<{ id: string; owner: string; groups: Set<string> }>();
  const [groupTargetCount, setGroupTargetCount] = useState<{ key: string; count?: number; error?: string }>();
  const [groupCountRetryRevision, setGroupCountRetryRevision] = useState(0);
  const groupCountRetryPending = useRef(false);
  const [bulkAccessSelection, setBulkAccessSelection] = useState<{ id: string; owner: string; count: number; ids?: string[]; recordIds?: string[] }>();
  const [pendingStoredAgentSelectionCount, setPendingStoredAgentSelectionCount] = useState(
    initialAgentRoute.selectionStorage === "session" ? initialAgentRoute.selectionCount : undefined,
  );
  const [selectionRouteNotice, setSelectionRouteNotice] = useState<{ tone: "success" | "error"; text: string }>();
  const [busyAgentId, setBusyAgentId] = useState<string>();
  const [busyBulkAction, setBusyBulkAction] = useState<AuditAction>();
  const [preparingBulkAction, setPreparingBulkAction] = useState<"block" | "unblock">();
  const [bulkProgress, setBulkProgress] = useState<BulkProgress>();
  const [bulkResult, setBulkResult] = useState<BulkActionResult>();
  const [bulkConfirmation, setBulkConfirmation] = useState<BulkConfirmation>();
  const [bulkAccessAgentIds, setBulkAccessAgentIds] = useState<string[]>();
  const [savedAgentDetail, setAgentDetail] = useState<{
    owner: string;
    recordId?: string;
    selectionId?: string;
    detail: CopilotPackageDetail;
  }>();
  const [agentDetailTab, setAgentDetailTab] = useState(initialAgentRoute.detailTab ?? "identities");
  const [requestedAgentDetailId, setRequestedAgentDetailId] = useState(initialAgentRoute.detailId);
  const [agentOpenedFromUser, setAgentOpenedFromUser] = useState<string>();
  const agentDetailReturnFocus = useRef<HTMLElement | null>(null);
  const userAgentOverlayRef = useRef(false);
  const [requestedPackageRefreshJobId, setRequestedPackageRefreshJobId] = useState(initialAgentRoute.refreshJobId);
  const [requestedPackageRefreshMode, setRequestedPackageRefreshMode] = useState(initialAgentRoute.refreshMode);
  const [requestedPackageControlJobId, setRequestedPackageControlJobId] = useState(initialAgentRoute.controlJobId);
  const [requestedDataSyncRunId, setRequestedDataSyncRunId] = useState(initialAgentRoute.syncRunId);
  const [syncSetup, setSyncSetup] = useState<{ owner: string; status: WorkspaceSetupStatus }>();
  const [pendingDataSyncPublication, setPendingDataSyncPublication] = useState<{
    owner: string;
    sources: DataSyncSourceId[];
  }>();
  const [syncHistoryRevision, setSyncHistoryRevision] = useState(0);
  const [singleAccessAgentDetail, setSingleAccessAgentDetail] =
    useState<CopilotPackageDetail>();
  const [singleAccessTarget, setSingleAccessTarget] = useState<PackageAccessTarget>("availability");
  const [loadingAgentDetailId, setLoadingAgentDetailId] = useState<string>();
  const [loadingUnifiedAgentDetail, setLoadingUnifiedAgentDetail] = useState(false);
  const [agentDetailError, setAgentDetailError] = useState<string>();
  const [exportChoiceOpen, setExportChoiceOpen] = useState(false);
  const [exportingCsv, setExportingCsv] = useState(false);
  const [agentExportError, setAgentExportError] = useState<{ message: string; reloadRequired: boolean }>();
  const [exportingPowerPlatformCsv, setExportingPowerPlatformCsv] = useState(false);
  const exportSequence = useRef(0);
  const [inventoryExport, setInventoryExport] = useState<{
    sequence: number; owner: string; selectionId: string; kind: "unified_agents" | "power_platform_agents"; ids?: string[];
  }>();
  const [refreshingPowerPlatformAgents, setRefreshingPowerPlatformAgents] = useState(false);
  const [powerPlatformAgentRefreshJob, publishPowerPlatformAgentRefreshJob] = useState<InventoryRefreshJob>();
  // Fence history against commands and observations even before React commits their state.
  const powerPlatformAgentRefreshJobRef = useRef<InventoryRefreshJob | undefined>(undefined);
  const setPowerPlatformAgentRefreshJob = useCallback((job: InventoryRefreshJob | undefined) => {
    powerPlatformAgentRefreshJobRef.current = job;
    publishPowerPlatformAgentRefreshJob(job);
  }, []);
  const [inventoryHistoryError, setInventoryHistoryError] = useState<string>();
  const [agentReloadRevision, setAgentReloadRevision] = useState(0);
  const [officialUsageDashboardRevision, setOfficialUsageDashboardRevision] = useState(0);
  const [inventoryReportRevision, setInventoryReportRevision] = useState(0);
  const [copilotUsersDataRevision, setCopilotUsersDataRevision] = useState(0);
  const [activeView, setActiveView] = useState<WorkbenchViewId>(() => parseWorkbenchView(window.location.pathname));
  const userAgentOverlay = activeView === "users" && agentOpenedFromUser !== undefined;
  const [lastAgentListRefreshAt, setLastAgentListRefreshAt] = useState<Date>();
  const [packageSnapshotExpiresAt, setPackageSnapshotExpiresAt] = useState<Date>();
  const [refreshingAgents, setRefreshingAgents] = useState(false);
  const normalizedQuery = parseBulkRefSearch(query) ?? query.trim();
  const deferredQuery = useDeferredValue(normalizedQuery);
  const currentUnifiedAgentQuery = useCallback((): UnifiedAgentInventoryQuery => {
    const operationIdPrefix = parseBulkRefSearch(deferredQuery);
    return {
      ...(packageType !== undefined ? { type: packageType } : {}),
      ...(endUserAccess !== "all" ? { endUserAccess } : {}),
      ...(reportedUsage !== "all" ? { reportedUsage } : {}),
      ...(agentManagement !== "all" ? { management: agentManagement } : {}),
      ...(agentRelevance !== "all" ? { relevance: agentRelevance } : {}),
      ...(operationIdPrefix ? { operationIdPrefix } : deferredQuery.trim() ? { search: deferredQuery.trim() } : {}),
      ...(agentEnvironmentFilter !== undefined ? { environmentId: agentEnvironmentFilter } : {}),
      ...(statusFilter === "all" ? {} : { blocked: statusFilter === "blocked" }),
      ...(publisherFilter === undefined ? {} : { publisher: publisherFilter }),
      ...(availableToFilter === undefined ? {} : { availableTo: availableToFilter }),
      ...(hostFilter === undefined ? {} : { host: hostFilter }),
      ...(platformFilter === undefined ? {} : { platform: platformFilter }),
      ...(parseOptionalPositiveInteger(createdWithinDays) ? { createdWithinDays: parseOptionalPositiveInteger(createdWithinDays) } : {}),
      inventoryScope: agentInventoryScope, sortBy: agentSortBy, sortDirection: agentSortDirection,
    };
  }, [agentEnvironmentFilter, agentInventoryScope, agentManagement, agentRelevance, agentSortBy, agentSortDirection,
    availableToFilter, createdWithinDays, deferredQuery, endUserAccess, hostFilter, packageType, platformFilter, publisherFilter, reportedUsage, statusFilter]);
  const agentSearchPending = deferredQuery !== normalizedQuery;
  const agentDetailRequestId = useRef(0);
  const agentDetailAbortController = useRef<AbortController | undefined>(undefined);
  const pendingSavedDetail = useRef<{ key: string; requestId: number } | undefined>(undefined);
  const pendingAccessPreparation = useRef<{ key: string; requestId: number } | undefined>(undefined);
  const pendingSinglePreview = useRef<number | undefined>(undefined);
  const pendingBulkPreview = useRef<{ key: string; requestId: number } | undefined>(undefined);
  const pendingBulkSubmission = useRef<BulkConfirmation | undefined>(undefined);
  const [unifiedAgentDetailPage, setUnifiedAgentDetailPage] = useState<{
    listPage?: UnifiedAgentInventoryPage;
    sourcePage?: UnifiedAgentInventoryPage;
  }>();
  const currentDetailSelection = useRef<string | undefined>(undefined);
  useEffect(() => { currentDetailSelection.current = unifiedAgentDetailPage?.sourcePage?.selection?.id; },
    [unifiedAgentDetailPage?.sourcePage?.selection?.id]);
  const agentListRequestId = useRef(0);
  const agentListAbortController = useRef<AbortController | undefined>(undefined);
  const pendingAgentListKey = useRef<string | undefined>(undefined);
  const forceCurrentAgentReload = useRef(false);
  const bulkJobPollRequestId = useRef(0);
  const bulkJobRequestAbort = useRef<AbortController | undefined>(undefined);
  const bulkJobCommandRequestId = useRef<number | undefined>(undefined);
  const bulkResumeAcknowledgement = useRef<BulkActionJob | undefined>(undefined);
  const packageRefreshRequestId = useRef(0);
  const packageRefreshAbortController = useRef<AbortController | undefined>(undefined);
  const inventoryRefreshRequestId = useRef(0);
  const inventoryRefreshAbortController = useRef<AbortController | undefined>(undefined);
  const inventoryHistoryAbortController = useRef<AbortController | undefined>(undefined);
  const linkedPackageRefreshRequestId = useRef(0);
  const linkedPackageRefreshPending = useRef(false);
  const observedPackageRefreshJobs = useRef(new Set<string>());
  const observedPowerPlatformRefreshJobs = useRef(new Set<string>());
  const inspectedPowerPlatformJob = useRef<InventoryRefreshJob | undefined>(undefined);
  const dataSyncPanelRef = useRef<DataSyncPanelHandle>(null);
  const sessionRequestId = useRef(0);
  const sessionAbortController = useRef<AbortController | undefined>(undefined);
  const signOutAbortController = useRef<AbortController | undefined>(undefined);
  const sessionRevalidationInFlight = useRef(false);
  const resumedBulkJobIds = useRef(new Set<string>());
  const invalidatedBulkJobResults = useRef(new Set<string>());
  const appliedBulkJobResults = useRef(new Set<string>());
  const bulkJobSelections = useRef(new Map<string, Set<string>>());
  const savedViewSearches = useRef(new Map<WorkbenchViewId, string>([
    [parseWorkbenchView(window.location.pathname), window.location.search],
  ]));
  const principalKey = user
    ? `${user.tenantId ?? ""}:${user.homeAccountId}:${[...user.roles].sort().join(",")}:${sessionEpoch}`
    : `signed-out:${sessionEpoch}`;
  const routeHistoryState = useCallback((view: WorkbenchViewId) => ({
    view, ...(user ? { workbenchOwner: { principal: routePrincipal(user), session: routeSession.current } } : {}),
  }), [user]);
  const replaceRoute = useCallback((view: WorkbenchViewId, next: string) => {
    const state = routeHistoryState(view);
    const owner = readRouteOwner();
    if (`${window.location.pathname}${window.location.search}` !== next
      || state.workbenchOwner && (owner?.principal !== state.workbenchOwner.principal || owner.session !== state.workbenchOwner.session)) {
      window.history.replaceState(state, "", next);
    }
  }, [routeHistoryState]);
  const syncSetupStatus = syncSetup?.owner === principalKey ? syncSetup.status : "checking";
  const syncSetupRequired = syncSetupStatus === "required";
  const waitingForInitialInventory = syncSetupStatus !== "ready" && activeView !== "sync";
  const handleSyncSetupStatusChange = useCallback((status: WorkspaceSetupStatus) => {
    setSyncSetup({ owner: principalKey, status });
  }, [principalKey]);
  const latestDetailPackage = selectedUnifiedAgent?.packages.find(item => item.id === savedAgentDetail?.detail.id);
  const agentDetail = savedAgentDetail?.owner === principalKey
    ? { ...savedAgentDetail.detail, ...latestDetailPackage } : undefined;
  useEffect(() => () => savedQueries.clear(), [principalKey, savedQueries]);
  useEffect(() => () => { bulkJobRequestAbort.current?.abort(); }, [principalKey]);
  const sessionOwnerRef = useRef<string | undefined>(principalKey);
  const activeViewRef = useRef(activeView);
  const workbenchMetadata = loadedWorkbenchMetadata?.principalKey === principalKey
    ? loadedWorkbenchMetadata.value
    : undefined;
  const resumeBulkJob = useEffectEvent((jobId: string) => {
    if (resumedBulkJobIds.current.has(jobId) && (trackedJob?.id ?? trackedJobId) === jobId) return;
    resumedBulkJobIds.current.add(jobId);
    clearTrackedJob();
    void followBulkJob(jobId);
  });
  const loadLinkedControlJob = useEffectEvent((jobId: string) => {
    const persist = resumedBulkJobIds.current.has(jobId);
    if (persist && (trackedJob?.id ?? trackedJobId) === jobId) return;
    clearTrackedJob();
    setBulkResult(undefined);
    setLinkedJobError(undefined);
    const pending = followBulkJob(jobId, undefined, persist);
    return { pending, requestId: persist ? undefined : bulkJobPollRequestId.current };
  });
  const loadSavedAgents = useEffectEvent((forceCurrentSnapshot = false) => {
    void loadAgents(forceCurrentSnapshot);
  });
  const loadInventoryRefreshHistory = useEffectEvent((controller: AbortController) => {
    const previous = powerPlatformAgentRefreshJobRef.current;
    void readSavedQuery(savedQueries, ["inventory-refresh-jobs", principalKey, agentReloadRevision],
      signal => getInventoryRefreshJobs({ signal }), controller.signal).then(history => {
      if (controller.signal.aborted) return;
      setInventoryHistoryError(undefined);
      const latest = history.value.find(job => job.requestedTypes.includes("microsoft.copilotstudio/agents"));
      if (!latest || powerPlatformAgentRefreshJobRef.current !== previous) return;
      const inspected = inspectedPowerPlatformJob.current;
      const next = requestedPowerPlatformJobId === latest.id && inspected?.id === latest.id ? inspected : latest;
      setPowerPlatformAgentRefreshJob(next);
      const prior = previous ?? latest;
      if (next.id !== prior.id || next.status !== prior.status) {
        if (next.status === "succeeded" && claimPowerPlatformPublication(next)) automaticRefresh.checkNow();
        else handleSyncRunsChanged();
      }
    }).catch(requestError => {
      if (controller.signal.aborted) return;
      if (isAccessDenied(requestError)) {
        clearAgentState();
        setInitialAgentReadOwner(principalKey);
        setUnifiedAgentReadError(errorMessage(requestError));
      }
      setInventoryHistoryError(`Unable to load Power Platform agent refresh history: ${errorMessage(requestError)}`);
    });
  });
  const reloadPublishedPackages = useEffectEvent(() => {
    automaticRefresh.checkNow();
  });
  const claimPackageRefreshPublication = useCallback((job: PackageRefreshJob) => {
    const publication = JSON.stringify([principalKey, job.tokenMode, job.id]);
    if (job.status !== "succeeded" || observedPackageRefreshJobs.current.has(publication)) return false;
    observedPackageRefreshJobs.current.add(publication);
    return true;
  }, [principalKey]);
  const reloadPublishedPowerPlatformAgents = useEffectEvent((job: InventoryRefreshJob) => {
    if (!claimPowerPlatformPublication(job)) return;
    automaticRefresh.checkNow();
  });
  const revalidateCurrentSession = useEffectEvent((restoringPage = false) => {
    if (sessionRevalidationInFlight.current || (!restoringPage && !user && loadingSession)) return;
    sessionRevalidationInFlight.current = true;
    clearPrivateState();
    setUser(undefined);
    if (signOutAbortController.current) {
      setLoadingSession(false);
      sessionRevalidationInFlight.current = false;
      return;
    }
    const pending = loadSession();
    const requestId = sessionRequestId.current;
    void pending.finally(() => {
      if (sessionRequestId.current === requestId) sessionRevalidationInFlight.current = false;
    });
  });

  useEffect(() => {
    sessionOwnerRef.current = principalKey;
    activeViewRef.current = activeView;
    userAgentOverlayRef.current = userAgentOverlay;
  }, [activeView, principalKey, userAgentOverlay]);

  useEffect(() => {
    const unsubscribe = subscribeSessionRevalidationRequired(() => revalidateCurrentSession());
    function suspendPage() {
      sessionRequestId.current += 1;
      sessionAbortController.current?.abort();
      // Restoration must check the session instead of waiting for an abandoned logout.
      signOutAbortController.current?.abort();
      signOutAbortController.current = undefined;
      setSigningOut(false);
      sessionRevalidationInFlight.current = false;
    }
    function restorePage(event: PageTransitionEvent) {
      if (event.persisted) revalidateCurrentSession(true);
    }
    window.addEventListener("pagehide", suspendPage);
    window.addEventListener("pageshow", restorePage);
    return () => {
      unsubscribe();
      window.removeEventListener("pagehide", suspendPage);
      window.removeEventListener("pageshow", restorePage);
    };
  }, []);

  const loadInitialSession = useEffectEvent(() => { void loadSession(); });
  useEffect(() => {
    loadInitialSession();
    return () => {
      sessionRequestId.current += 1;
      sessionAbortController.current?.abort();
      signOutAbortController.current?.abort();
    };
  }, []);

  useEffect(() => {
    agentDetailRequestId.current += 1;
    agentDetailAbortController.current?.abort();
    agentListRequestId.current += 1;
    agentListAbortController.current?.abort();
    inventoryHistoryAbortController.current?.abort();
    bulkJobPollRequestId.current += 1;
    packageRefreshRequestId.current += 1;
    packageRefreshAbortController.current?.abort();
    inventoryRefreshRequestId.current += 1;
    inventoryRefreshAbortController.current?.abort();
    linkedPackageRefreshRequestId.current += 1;
    resumedBulkJobIds.current.clear();
    observedPackageRefreshJobs.current.clear();
    observedPowerPlatformRefreshJobs.current.clear();
    observedQuarantineResults.current.clear();
    inspectedPowerPlatformJob.current = undefined;
    void Promise.resolve().then(() => {
      setAgents([]);
      setUnifiedAgentPage(undefined);
      setSelectedUnifiedAgent(undefined);
      setAgentOpenedFromUser(undefined);
      setUnifiedAgentDetailPage(undefined);
      setAgentPackageSelection(undefined);
      setPackageAccessRevisions(new Map());
      setPackageControlError(undefined);
      setSelectedPowerPlatformTargets(new Map());
      setSelectedPowerPlatformSnapshot(null);
      setQuarantineReceiptPending(false);
      setAgentDetail(undefined);
      clearTrackedJob();
      setLinkedPackageRefreshJob(undefined);
      setLinkedPackageRefreshError(undefined);
      setLinkedJobError(undefined);
      setInventoryHistoryError(undefined);
      setBulkProgress(undefined);
      setBulkResult(undefined);
      setLoadingAgentDetailId(undefined);
    });
  }, [principalKey]);

  useEffect(() => {
    if (!user) return;
    const controller = new AbortController();
    readSavedQuery(savedQueries, ["workbench-metadata", principalKey], signal => getWorkbenchMetadata({ signal }), controller.signal)
      .then(value => { if (!controller.signal.aborted) setLoadedWorkbenchMetadata({ principalKey, value }); })
      .catch((requestError) => {
        if (!controller.signal.aborted && !(requestError instanceof ApiError && requestError.code === "request_aborted")) {
          setError(errorMessage(requestError));
        }
      });
    return () => controller.abort();
  }, [principalKey, savedQueries, user]);

  const restoreRoute = useEffectEvent(() => {
      if (!isWorkbenchPath(window.location.pathname)) return;
      const owner = readRouteOwner();
      if (owner && (owner.session !== routeSession.current || !user || owner.principal !== routePrincipal(user))) {
        replaceRoute(parseWorkbenchView(window.location.pathname),
          workbenchUrl(parseWorkbenchView(window.location.pathname), publicRouteSearch()));
      }
      readInitialAgentRoute();
      const view = parseWorkbenchView(window.location.pathname);
      const agentRoute = view === "agents" ? parseAgentRoute(window.location.search) : undefined;
      const retainDetail = agentRoute?.detailId !== undefined && agentRoute.detailId === requestedAgentDetailId
        && !busyAgentId && !preparingBulkAction && !bulkConfirmation && !singleAccessAgentDetail && !bulkAccessAgentIds;
      if (!retainDetail) {
        cancelAgentDetailRequest();
        setAgentOpenedFromUser(undefined);
        setAgentDetail(undefined);
        setSelectedUnifiedAgent(undefined);
        setUnifiedAgentDetailPage(undefined);
        setAgentPackageSelection(undefined);
        setAgentDetailError(undefined);
      }
      packageRefreshRequestId.current += 1;
      packageRefreshAbortController.current?.abort();
      setSingleAccessAgentDetail(undefined);
      setBulkAccessAgentIds(undefined);
      setBulkConfirmation(undefined);
      setRefreshingAgents(false);
      savedViewSearches.current.set(view, window.location.search);
      setActiveView(view);
      if (agentRoute) {
        const route = agentRoute;
        setQuery(route.search);
        setAgentInventoryScope(route.inventoryScope);
        setPackageType(route.packageType);
        setEndUserAccess(route.endUserAccess);
        setReportedUsage(route.reportedUsage);
        setAgentManagement(route.management);
        setAgentRelevance(route.relevance);
        setStatusFilter(route.status);
        setPublisherFilter(route.publisher);
        setAvailableToFilter(route.availability);
        setHostFilter(route.host);
        setPlatformFilter(route.platform);
        setCreatedWithinDays(route.createdWithinDays);
        setAgentSortBy(route.sortBy);
        setAgentSortDirection(route.sortDirection);
        // A numeric bookmark cannot select a cursor from a different displayed page.
        if (route.page !== agentPageIndex) {
          inventoryNavigation.current.cursor = undefined;
          setAgentPageIndex(0);
        }
        setSelectedAgentIds(new Set(route.selectionStorage === "session" ? [] : route.selectedIds));
        setServerPackageSelection(undefined);
        setGroupPackageSelection(undefined);
        setGroupTargetCount(undefined);
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
      } else if (view === "users") {
        setUsersRoute(parseUsersRoute(window.location.search));
      } else if (view === "sync") {
        const route = parseDataSyncRoute(window.location.search);
        const next = workbenchUrl("sync", dataSyncRouteSearch(route));
        replaceRoute("sync", next);
        selectPowerPlatformJob(route.powerPlatformJobId);
        setRequestedDataSyncRunId(route.syncRunId);
        setRequestedPackageRefreshJobId(route.refreshJobId);
        setRequestedPackageRefreshMode(route.refreshMode);
        setSyncReportRoute(route.reports);
      }
  });
  useEffect(() => {
    const onPopState = () => restoreRoute();
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    if (!user || !hasRole(user, "AgentControl.Viewer") || pendingStoredAgentSelectionCount === undefined || agentSearchPending) return;
    let active = true;
    void Promise.resolve().then(() => {
      if (!active) return;
      const restored = restorePackageSelection(user, pendingStoredAgentSelectionCount);
      if (restored.status === "restored"
        && (!restored.inventory || restored.inventory.query === JSON.stringify(currentUnifiedAgentQuery()))) {
        setSelectedAgentIds(new Set(restored.ids));
        setServerPackageSelection(restored.inventory?.allMatching ? { id: restored.inventory.id, owner: principalKey } : undefined);
        setGroupPackageSelection(restored.inventory?.groups
          ? { id: restored.inventory.id, owner: principalKey, groups: new Set(restored.inventory.groups) } : undefined);
        setGroupTargetCount(undefined);
        if (restored.inventory) {
          inventoryNavigation.current = { key: JSON.stringify([principalKey, currentUnifiedAgentQuery()]),
            selectionId: restored.inventory.id, cursor: restored.inventory.cursor };
          setAgentPageIndex(restored.inventory.page);
          forceCurrentAgentReload.current = false;
        }
        setSelectionRouteNotice({
          tone: "success",
          text: `${pendingStoredAgentSelectionCount.toLocaleString()} selected packages were restored from this signed-in browser session. Current membership and control authority are checked before any action.`,
        });
      } else {
        setSelectedAgentIds(new Set());
        setServerPackageSelection(undefined);
        setGroupPackageSelection(undefined);
        clearPackageSelection(user);
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
  }, [agentSearchPending, currentUnifiedAgentQuery, pendingStoredAgentSelectionCount, principalKey, user]);

  useEffect(() => {
    if (!user || activeView !== "agents" || pendingStoredAgentSelectionCount !== undefined) return;
    if (sessionOwnerRef.current !== principalKey) return;
    const inventoryQuery = currentUnifiedAgentQuery();
    const selectedPin = !agentSearchPending && unifiedAgentPage?.inventoryScope === agentInventoryScope
      && inventoryNavigation.current.key === JSON.stringify([principalKey, inventoryQuery])
      && inventoryNavigation.current.selectionId === unifiedAgentPage.selection.id ? unifiedAgentPage.selection.id : undefined;
    const matching = serverPackageSelection?.owner === principalKey && serverPackageSelection.id === selectedPin;
    const groups = groupPackageSelection?.owner === principalKey && groupPackageSelection.id === selectedPin
      ? [...groupPackageSelection.groups] : [];
    const groupKey = groups.length ? JSON.stringify([principalKey, selectedPin,
      selectedAgentIds.size ? [...selectedAgentIds] : undefined, groups]) : undefined;
    const targetCount = matching ? unifiedAgentPage!.counts.packageTargets
      : groupKey && groupTargetCount?.key === groupKey ? groupTargetCount.count : undefined;
    const inventory = selectedPin && targetCount !== undefined && targetCount > 0 && (matching || groups.length)
      ? { id: selectedPin, query: JSON.stringify(inventoryQuery),
        cursor: inventoryNavigation.current.cursor, page: agentPageIndex, count: targetCount,
        ...(matching ? { allMatching: true } : { groups }) } : undefined;
    const search = agentRouteSearch({
      inventoryScope: agentInventoryScope,
      packageType,
      endUserAccess,
      reportedUsage,
      management: agentManagement,
      relevance: agentRelevance,
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
      ...(inventory ? { selectionStorage: "session" as const, selectionCount: inventory.count } : {}),
      refreshJobId: requestedPackageRefreshJobId,
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
      ? storePackageSelection(user, matching ? [] : [...selectedAgentIds], inventory)
      : false;
    if (selectionStored && !selectionSaved) {
      search.delete("selectionState");
      search.delete("selectionCount");
    }
    const next = workbenchUrl("agents", search);
    replaceRoute("agents", next);
    if (selectionStored) {
      void Promise.resolve().then(() => setSelectionRouteNotice({
        tone: selectionSaved ? "success" : "error",
        text: selectionSaved
          ? `${(inventory?.count ?? selectedAgentIds.size).toLocaleString()} selected packages are preserved only for this signed-in browser session and omitted from the URL.`
          : `The selection remains active, but could not be preserved in browser session storage. It will not survive reload; no IDs were silently truncated.`,
      }));
    }
  }, [activeView, agentDetail?.id, agentDetailTab, agentEnvironmentFilter, agentInventoryScope, agentManagement, agentPageIndex, agentRelevance, agentSearchPending, agentSortBy, agentSortDirection, packageType, availableToFilter, createdWithinDays, currentUnifiedAgentQuery, endUserAccess, hostFilter, pendingPowerPlatformIds, pendingStoredAgentSelectionCount, platformFilter, publisherFilter, query, replaceRoute, reportedUsage, requestedAgentDetailId, requestedInventorySnapshotId, requestedPackageControlJobId, requestedPackageRefreshJobId, requestedPackageRefreshMode, requestedQuarantineJobId, selectedAgentIds, selectedPowerPlatformTargets, selectedUnifiedAgent?.id, statusFilter, user, groupPackageSelection, groupTargetCount, principalKey, serverPackageSelection, unifiedAgentPage]);

  useEffect(() => {
    if (!user || activeView !== "sync") return;
    const search = dataSyncRouteSearch({
      powerPlatformJobId: requestedPowerPlatformJobId,
      syncRunId: requestedDataSyncRunId,
      refreshJobId: requestedPackageRefreshJobId,
      refreshMode: requestedPackageRefreshMode,
      reports: syncReportRoute,
    });
    const next = workbenchUrl("sync", search);
    savedViewSearches.current.set("sync", search.toString());
    replaceRoute("sync", next);
  }, [activeView, replaceRoute, requestedPowerPlatformJobId, requestedDataSyncRunId, requestedPackageRefreshJobId, requestedPackageRefreshMode, syncReportRoute, user]);

  useEffect(() => {
    if (!user || activeView !== "users") return;
    const next = workbenchUrl("users", usersRouteSearch(usersRoute));
    replaceRoute("users", next);
  }, [activeView, replaceRoute, user, usersRoute]);

  const invalidateBookmarkedInventory = useEffectEvent((selectionId: string) => {
    if (selectionId !== inventoryNavigation.current.selectionId) return;
    setRequestedAgentDetailId(undefined);
    invalidateAgentSelection();
  });

  useEffect(() => {
    if (!user || !hasRole(user, "AgentControl.Viewer") || (activeView !== "agents" && !userAgentOverlay) || !requestedAgentDetailId
      || !unifiedAgentPage?.selection?.id
      || busyAgentId || busyBulkAction
      || (selectedUnifiedAgent?.id === requestedAgentDetailId && unifiedAgentDetailPage?.listPage === unifiedAgentPage)
      || (agentDetail?.id === requestedAgentDetailId && unifiedAgentDetailPage?.listPage === unifiedAgentPage)
      || loadingAgentDetailId === requestedAgentDetailId) return;
    let unified = findUnifiedAgentRecord(unifiedAgentPage?.value ?? [], requestedAgentDetailId, agentEnvironmentFilter ?? undefined);
    const selectReferencedPackage = (record: UnifiedAgentRecord) => {
      const exact = record.packages.find(item => item.id === requestedAgentDetailId
        || unifiedAgentRecordId({ source: "graph_packages", packageId: item.id }) === requestedAgentDetailId);
      if (exact) setAgentPackageSelection({ owner: principalKey, recordId: record.id, packageId: exact.id });
    };
    const selectedVersion = agentPackageSelection?.owner === principalKey && agentPackageSelection.recordId === requestedAgentDetailId
      ? agentPackageSelection.packageId : undefined;
    const retainedPackage = unified?.packagesComplete === false && selectedUnifiedAgent?.id === unified.id
      && unifiedAgentDetailPage?.sourcePage?.selection.id === unifiedAgentPage.selection.id
      && selectedVersion && !unified.packages.some(item => item.id === selectedVersion)
      ? selectedUnifiedAgent.packages.find(item => item.id === selectedVersion) : undefined;
    if (unified && retainedPackage && selectedUnifiedAgent) {
      // Keep only the selected extra member; the list still owns the current group projection.
      const observation = selectedUnifiedAgent.observations.packageSnapshots[retainedPackage.id];
      unified = { ...unified, packages: [...unified.packages, retainedPackage],
        identity: { ...unified.identity, packageEvidence: [
          ...unified.identity.packageEvidence.filter(item => item.packageId !== retainedPackage.id),
          ...selectedUnifiedAgent.identity.packageEvidence.filter(item => item.packageId === retainedPackage.id)] },
        observations: { ...unified.observations, packageSnapshots: { ...unified.observations.packageSnapshots,
          ...(observation ? { [retainedPackage.id]: observation } : {}) } },
      };
    }
    const reloadSelectedVersion = selectedVersion
      && (!unified || unified.packagesComplete === false && !unified.packages.some(item => item.id === selectedVersion));
    if (unified && !reloadSelectedVersion) {
      const record = unified;
      const requestId = ++agentDetailRequestId.current;
      agentDetailAbortController.current?.abort();
      let active = true;
      void Promise.resolve().then(() => {
        if (!active || requestId !== agentDetailRequestId.current) return;
        setLoadingAgentDetailId(undefined);
        setUnifiedAgentDetailPage({ listPage: unifiedAgentPage, sourcePage: unifiedAgentPage });
        setSelectedUnifiedAgent(record);
        selectReferencedPackage(record);
        setRequestedAgentDetailId(record.id);
        setAgentDetail(current => current?.owner === principalKey && current.recordId === record.id
          && record.packages.some(item => item.id === current.detail.id) ? current : undefined);
      });
      return () => { active = false; };
    }
    const requestId = ++agentDetailRequestId.current;
    agentDetailAbortController.current?.abort();
    const controller = new AbortController();
    agentDetailAbortController.current = controller;
    const selectionId = unifiedAgentPage.selection.id;
    let reloadedRecord: UnifiedAgentRecord | undefined;
    void Promise.resolve().then(async () => {
      if (controller.signal.aborted || requestId !== agentDetailRequestId.current) return;
      setLoadingUnifiedAgentDetail(true);
      setAgentDetailError(undefined);
      const target = parseUnifiedAgentRecordId(requestedAgentDetailId)
        ?? { source: "graph_packages" as const, packageId: requestedAgentDetailId };
      const recordId = unifiedAgentRecordId(target);
      let record = unified ?? await readSavedQuery(savedQueries,
        ["unified-agent-detail", principalKey, selectionId, recordId, agentReloadRevision],
        signal => getUnifiedAgentDetail(selectionId, recordId, { signal }), controller.signal);
      if (controller.signal.aborted || requestId !== agentDetailRequestId.current) return;
      reloadedRecord = record;
      const packageId = reloadSelectedVersion ? selectedVersion : target.source === "graph_packages" ? target.packageId : undefined;
      const nativeDetail = packageId ? await getAgentDetails(selectionId, packageId, { signal: controller.signal }) : undefined;
      if (controller.signal.aborted || requestId !== agentDetailRequestId.current) return;
      if (nativeDetail && nativeDetail.id !== packageId) {
        throw new Error("Saved agent details did not match the requested published version.");
      }
      if (nativeDetail) record = selectedPackagePreview(record, nativeDetail, selectionId);
      setUnifiedAgentDetailPage({ listPage: unifiedAgentPage, sourcePage: unifiedAgentPage });
      setSelectedUnifiedAgent(record);
      selectReferencedPackage(record);
      setRequestedAgentDetailId(record.id);
      if (nativeDetail) setAgentDetail({ owner: principalKey, recordId: record.id,
        selectionId: unifiedAgentPage?.selection.id, detail: nativeDetail });
      else setAgentDetail(current => current?.owner === principalKey && current.recordId === record.id
        && record.packages.some(item => item.id === current.detail.id) ? current : undefined);
    }).catch(requestError => {
      if (!controller.signal.aborted && requestId === agentDetailRequestId.current) {
        if (isExpiredSelection(requestError)) {
          setExpiredAgentSelection(selectionId);
          setAgentDetailError(errorMessage(requestError));
          return;
        }
        if (requestError instanceof ApiError && requestError.code === "selection_invalidated") {
          invalidateBookmarkedInventory(selectionId);
          return;
        }
        setAgentDetail(undefined);
        if (reloadSelectedVersion && reloadedRecord?.packagesComplete === false
          && !reloadedRecord.packages.some(item => item.id === selectedVersion)) {
          setUnifiedAgentDetailPage({ listPage: unifiedAgentPage, sourcePage: unifiedAgentPage });
          setSelectedUnifiedAgent(reloadedRecord);
          setRequestedAgentDetailId(reloadedRecord.id);
          setAgentPackageSelection({ owner: principalKey, recordId: reloadedRecord.id, packageId: selectedVersion });
        } else {
          setSelectedUnifiedAgent(undefined);
          setRequestedAgentDetailId(undefined);
        }
        setAgentDetailError(errorMessage(requestError));
      }
    }).finally(() => {
      if (!controller.signal.aborted && requestId === agentDetailRequestId.current) setLoadingUnifiedAgentDetail(false);
    });
    return () => {
      controller.abort();
      setLoadingUnifiedAgentDetail(false);
    };
  }, [activeView, agentDetail?.id, agentEnvironmentFilter, agentPackageSelection, agentReloadRevision, busyAgentId, busyBulkAction, loadingAgentDetailId, principalKey, requestedAgentDetailId, savedQueries, selectedUnifiedAgent, unifiedAgentDetailPage, unifiedAgentPage, user, userAgentOverlay]);

  const waitingForLinkedPackageStatus = Boolean(requestedPackageRefreshJobId && refreshingAgents);
  const visibleLinkedPackageRefreshJob = !requestedPackageRefreshJobId
    || linkedPackageRefreshJob?.id === requestedPackageRefreshJobId && linkedPackageRefreshJob.tokenMode === requestedPackageRefreshMode
    ? linkedPackageRefreshJob : undefined;

  useEffect(() => {
    if (!statusObservationAvailable || !user || !hasRole(user, "AgentControl.Viewer") || (activeView !== "agents" && activeView !== "sync") || !requestedPackageRefreshJobId) {
      linkedPackageRefreshPending.current = false;
      void Promise.resolve().then(() => {
        setLinkedPackageRefreshJob(undefined);
        setLinkedPackageRefreshError(undefined);
        setLinkedPackageRefreshLoading(false);
      });
      return;
    }
    const owner = ++linkedPackageRefreshRequestId.current;
    const controller = new AbortController();
    linkedPackageRefreshPending.current = true;
    let timer: number | undefined;
    const load = async () => {
      linkedPackageRefreshPending.current = true;
      setLinkedPackageRefreshLoading(true);
      try {
        const job = await readSavedQuery(savedQueries, ["package-refresh-job", requestedPackageRefreshJobId, requestedPackageRefreshMode],
          signal => getPackageRefreshJob(requestedPackageRefreshJobId, requestedPackageRefreshMode, { signal }), controller.signal);
        if (controller.signal.aborted || owner !== linkedPackageRefreshRequestId.current) return;
        setLinkedPackageRefreshJob(job);
        if (job.status === "running") {
          timer = window.setTimeout(() => void load(), packageRefreshPollIntervalMs);
        } else if (claimPackageRefreshPublication(job)) reloadPublishedPackages();
      } catch (requestError) {
        if (!controller.signal.aborted && owner === linkedPackageRefreshRequestId.current) {
          setLinkedPackageRefreshError(`Unable to read package refresh status. Any displayed progress is last observed. ${errorMessage(requestError)}`);
        }
      } finally {
        if (!controller.signal.aborted && owner === linkedPackageRefreshRequestId.current) {
          linkedPackageRefreshPending.current = false;
          setLinkedPackageRefreshLoading(false);
        }
      }
    };
    void Promise.resolve().then(() => {
      if (controller.signal.aborted) return;
      setLinkedPackageRefreshError(undefined);
      if (waitingForLinkedPackageStatus) {
        setLinkedPackageRefreshLoading(false);
        return;
      }
      setLinkedPackageRefreshJob(undefined);
      return load();
    });
    return () => {
      controller.abort();
      if (timer !== undefined) window.clearTimeout(timer);
      if (owner === linkedPackageRefreshRequestId.current) {
        linkedPackageRefreshRequestId.current += 1;
        linkedPackageRefreshPending.current = false;
      }
    };
  }, [activeView, claimPackageRefreshPublication, linkedPackageRefreshRevision, principalKey, requestedPackageRefreshJobId, requestedPackageRefreshMode, savedQueries, statusObservationAvailable, user, waitingForLinkedPackageStatus]);

  useEffect(() => {
    if (!user || !hasRole(user, "AgentControl.Admin") || activeView !== "agents" || !requestedPackageControlJobId) return;
    let active = true;
    let requestId: number | undefined;
    void Promise.resolve().then(() => {
      if (!active) return;
      const read = loadLinkedControlJob(requestedPackageControlJobId);
      requestId = read?.requestId;
      return read?.pending;
    });
    return () => {
      active = false;
      if (requestId === bulkJobPollRequestId.current) {
        bulkJobPollRequestId.current += 1;
        bulkJobRequestAbort.current?.abort();
      }
    };
  }, [activeView, principalKey, requestedPackageControlJobId, user]);

  useEffect(() => {
    if (!user || !hasRole(user, "AgentControl.Admin") || activeView !== "agents") {
      return;
    }
    if (requestedPackageControlJobId || requestedPackageRefreshJobId
      || pendingBulkSubmission.current || bulkJobCommandRequestId.current !== undefined) return;

    const stored = loadStoredActiveBulkJobId(user);
    if (stored.error) {
      void Promise.resolve().then(() => setBulkJobStorageError(stored.error));
    }
    const jobId = stored.jobId;

    if (jobId) {
      let active = true;
      const owner = bulkJobPollRequestId.current;
      void Promise.resolve().then(() => {
        if (active && bulkJobPollRequestId.current === owner) resumeBulkJob(jobId);
      });
      return () => { active = false; };
    }

    // Sign-in and session revalidation can clear the browser's active-job pointer.
    const controller = new AbortController();
    const owner = bulkJobPollRequestId.current;
    getBulkActionJobs(50, { signal: controller.signal }).then(({ value }) => {
      if (controller.signal.aborted || bulkJobPollRequestId.current !== owner) return;
      const retained = value.find(job => !isKnownJobStatus(job.status) || isJobPolling(job.status) || !job.cancelRequested
        && (job.canResume || job.status === "waiting_authorization" || job.reconciliationRequired > 0));
      if (!retained) return;
      resumeBulkJob(retained.id);
    }).catch(requestError => {
      if (controller.signal.aborted || bulkJobPollRequestId.current !== owner) return;
      setBulkJobStorageError(`Unable to check for unfinished package tasks. Reload Agents to try again. ${errorMessage(requestError)}`);
    });
    return () => controller.abort();
  }, [activeView, principalKey, requestedPackageControlJobId, requestedPackageRefreshJobId, user]);

  useEffect(() => {
    if (
      activeView !== "sync"
      || !statusObservationAvailable
      || refreshingPowerPlatformAgents
      || powerPlatformAgentRefreshJob?.status !== "running"
      || requestedPowerPlatformJobId === powerPlatformAgentRefreshJob.id
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
        const job = await readSavedQuery(savedQueries, ["inventory-refresh-job", jobId],
          signal => getInventoryRefreshJob(jobId, { signal }), controller.signal);
        if (
          controller.signal.aborted
          || requestId !== inventoryRefreshRequestId.current
          || sessionOwnerRef.current !== owner
          || activeViewRef.current !== "sync"
        ) return;
        setPowerPlatformAgentRefreshJob(job);
        if (job.status !== "running") handleSyncRunsChanged();
        if (job.status === "succeeded") {
          reloadPublishedPowerPlatformAgents(job);
        } else if (job.status === "running" && Date.now() < deadline) {
          timer = window.setTimeout(() => void poll(), inventoryRefreshPollIntervalMs);
        } else if (job.status === "running") {
          setError("Power Platform agent refresh polling reached its five-minute bound. Open Inspect source job in Sync to check its status.");
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
  }, [activeView, powerPlatformAgentRefreshJob?.id, powerPlatformAgentRefreshJob?.status, principalKey, refreshingPowerPlatformAgents, requestedPowerPlatformJobId, savedQueries, setPowerPlatformAgentRefreshJob, statusObservationAvailable]);

  useEffect(() => {
    if (!user || !hasRole(user, "AgentControl.Viewer")
      || !["agents", "sync", "audit"].includes(activeView) || waitingForInitialInventory) return;
    const controller = new AbortController();
    inventoryHistoryAbortController.current = controller;
    loadInventoryRefreshHistory(controller);
    return () => controller.abort();
  }, [activeView, agentReloadRevision, principalKey, user, waitingForInitialInventory]);

  useEffect(() => {
    if (!user) {
      agentListAbortController.current?.abort();
      inventoryHistoryAbortController.current?.abort();
      void Promise.resolve().then(() => {
        setAgents([]);
        setUnifiedAgentPage(undefined);
        setSelectedUnifiedAgent(undefined);
        setAgentPackageSelection(undefined);
        setUnifiedAgentDetailPage(undefined);
        setPackageAccessRevisions(new Map());
        setPackageControlError(undefined);
        setSelectedPowerPlatformTargets(new Map());
        setSelectedPowerPlatformSnapshot(null);
        setAgentDetail(undefined);
      });
      return;
    }
    if (!hasRole(user, "AgentControl.Viewer")) {
      agentListAbortController.current?.abort();
      inventoryHistoryAbortController.current?.abort();
      void Promise.resolve().then(() => {
        clearPackageSelection(user);
        setAgents([]);
        setUnifiedAgentPage(undefined);
        setSelectedUnifiedAgent(undefined);
        setUnifiedAgentDetailPage(undefined);
        setAgentPackageSelection(undefined);
        setPackageAccessRevisions(new Map());
        setPackageControlError(undefined);
        setSelectedPowerPlatformTargets(new Map());
        setSelectedPowerPlatformSnapshot(null);
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
        clearTrackedJob();
        setLinkedPackageRefreshJob(undefined);
        setLinkedJobError(undefined);
      });
      return;
    }
    if (activeView !== "agents" && activeView !== "sync" && activeView !== "audit" && !userAgentOverlay
      || waitingForInitialInventory || pendingStoredAgentSelectionCount !== undefined || agentSearchPending) {
      agentListAbortController.current?.abort();
      return;
    }
    const forceCurrentSnapshot = forceCurrentAgentReload.current;
    forceCurrentAgentReload.current = false;
    loadSavedAgents(forceCurrentSnapshot);
  }, [activeView, agentEnvironmentFilter, agentInventoryScope, agentManagement, agentPageIndex, agentRelevance, agentReloadRevision, agentSearchPending, agentSortBy, agentSortDirection, packageType, availableToFilter, createdWithinDays, deferredQuery, endUserAccess, hostFilter, pendingStoredAgentSelectionCount, platformFilter, publisherFilter, reportedUsage, statusFilter, user, userAgentOverlay, waitingForInitialInventory]);

  useEffect(() => {
    if (!inventoryUnavailable || loadingAgents || !hasRole(user, "AgentControl.Viewer")
      || !["agents", "sync", "audit"].includes(activeView) && !userAgentOverlay || waitingForInitialInventory) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible" && navigator.onLine) loadSavedAgents(true);
    }, 5_000);
    return () => window.clearInterval(timer);
  }, [activeView, inventoryUnavailable, loadingAgents, user, userAgentOverlay, waitingForInitialInventory]);


  useEffect(() => {
    if (!unifiedAgentPage || pendingPowerPlatformIds.size === 0 || !hasRole(user, "AgentControl.Admin") || activeView !== "agents") return;
    const controller = new AbortController();
    const scopeEpoch = agentScopeEpochRef.current;
    void Promise.all([...pendingPowerPlatformIds].map(async key => {
      try {
        const known = findUnifiedAgentRecord(unifiedAgentPage.value, key, agentEnvironmentFilter ?? undefined);
        if (known) return { record: known };
        const target = parseUnifiedAgentRecordId(key) ?? (agentEnvironmentFilter
          ? { source: "power_platform" as const, nativeId: key, environmentId: agentEnvironmentFilter }
          : undefined);
        if (!target) throw new Error("An exact environment and native resource identity is required.");
        const recordId = unifiedAgentRecordId(target);
        const selectionId = unifiedAgentPage.selection?.id;
        if (!selectionId) throw new Error("Refresh saved agent inventory before restoring exact targets.");
        const record = await readSavedQuery(savedQueries, ["unified-agent-detail", principalKey, selectionId, recordId, agentReloadRevision],
          signal => getUnifiedAgentDetail(selectionId, recordId, { signal }), controller.signal);
        return { record };
      } catch (requestError) {
        return { error: errorMessage(requestError) };
      }
    })).then(results => {
      if (controller.signal.aborted || scopeEpoch !== agentScopeEpochRef.current) return;
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
  }, [activeView, agentEnvironmentFilter, agentReloadRevision, pendingPowerPlatformIds, principalKey, requestedInventorySnapshotId, savedQueries, selectedPowerPlatformSnapshot, selectedPowerPlatformTargets, unifiedAgentPage, user]);

  useEffect(
    () => {
      return () => {
        agentInventoryQueries.clear();
        savedQueries.clear();
        sessionOwnerRef.current = undefined;
        agentDetailRequestId.current += 1;
        agentDetailAbortController.current?.abort();
        agentListRequestId.current += 1;
        agentListAbortController.current?.abort();
        inventoryHistoryAbortController.current?.abort();
        bulkJobPollRequestId.current += 1;
        bulkJobCommandRequestId.current = undefined;
        packageRefreshRequestId.current += 1;
        packageRefreshAbortController.current?.abort();
        inventoryRefreshRequestId.current += 1;
        inventoryRefreshAbortController.current?.abort();
      };
    },
    [agentInventoryQueries, savedQueries],
  );

  const effectivePlatformFilter = platformFilter;
  const publisherOptions: Array<{ value: string; label: string }> = [];
  const hostOptions: Array<{ value: string; label: string }> = [];
  const availableToOptions: Array<{ value: string; label: string }> = [];
  const platformOptions: Array<{ value: string; label: string }> = [];
  const agentEnvironmentNames = Object.fromEntries((unifiedAgentPage?.value ?? [])
    .flatMap(record => record.environmentId && record.environment?.displayName
      ? [[record.environmentId.toLowerCase(), record.environment.displayName]] : []));

  const canReadSensitiveUsage = hasRole(user, "AgentControl.Viewer");
  const authorizedViews = allowedViews(user);
  const visibleViews: WorkbenchViewId[] = workbenchMetadata
    ? workbenchMetadata.views.flatMap(view => {
        const id = authorizedViews.find(candidate => candidate === view.id);
        return id && (view.roles.length === 0 || view.roles.some(role => hasRole(user, role))) ? [id] : [];
      })
    : authorizedViews;
  const visibleActiveView = visibleViews.includes(activeView) ? activeView : visibleViews[0] ?? "permissions";
  const blockingWorkspace = hasRole(user, "AgentControl.Viewer") && syncSetupStatus !== "ready"
    && visibleActiveView !== "sync" && visibleActiveView !== "permissions";
  const canOperate = hasRole(user, "AgentControl.Admin");
  const canImportReports = hasRole(user, "AgentControl.Admin");
  const automaticAction = findWorkbenchAction(workbenchMetadata?.actions, "data-sync.auto-refresh");
  const automaticCapabilities = capabilityState.views.filter(view =>
    ["graph.package.read.delegated", "powerPlatform.inventory.read", "graph.directory.read", "reports.copilotUsage.read"].includes(view.definition.id));
  const automaticRefresh = useAutomaticRefresh({
    principalKey,
    authorizationKey: JSON.stringify(automaticCapabilities.map(view => [
      view.definition.id, view.decision.authorized, view.decision.status, view.decision.evidence?.category,
    ]).sort()),
    enabled: Boolean(user && hasRole(user, "AgentControl.Viewer") && !loadingSession && !signingOut
      && automaticAction && (automaticAction.roles.length === 0 || automaticAction.roles.some(role => hasRole(user, role)))
      && (!automaticAction.capabilityId || providerActionAllowed(capabilityState.views.find(view => view.definition.id === automaticAction.capabilityId)))),
    onSourcesChanged: sources => {
      if (ownsAgentScope(principalKey)) handleDataSyncSourcesChanged(sources, true);
    },
    onRunsChanged: () => {
      if (!ownsAgentScope(principalKey)) return;
      handleSyncRunsChanged();
      void dataSyncPanelRef.current?.refresh(false);
    },
  });

  useEffect(() => {
    if (!user || visibleActiveView === activeView) return;
    replaceRoute(visibleActiveView, workbenchUrl(visibleActiveView));
  }, [activeView, replaceRoute, user, visibleActiveView]);

  function navigateToView(view: WorkbenchViewId) {
    if (view === "agents" && agentPageIndex === 0 && !selectedAgentIds.size && !selectedPowerPlatformTargets.size
      && !serverPackageSelection && !groupPackageSelection && !inventoryExport && !requestedAgentDetailId
      && unifiedAgentPage && !selectedReadRemaining(unifiedAgentPage.selection)) inventoryNavigation.current = { key: "" };
    cancelAgentDetailRequest();
    setAgentOpenedFromUser(undefined);
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
      selectPowerPlatformJob(route.powerPlatformJobId);
      setRequestedDataSyncRunId(route.syncRunId);
      setRequestedPackageRefreshJobId(route.refreshJobId);
      setRequestedPackageRefreshMode(route.refreshMode);
      setSyncReportRoute(route.reports);
    } else if (view === "agents") {
      const route = parseAgentRoute(search.toString());
      setRequestedPackageRefreshJobId(route.refreshJobId);
      setRequestedPackageRefreshMode(route.refreshMode);
    } else if (view === "users") {
      setUsersRoute(parseUsersRoute(search.toString()));
    }
    const next = workbenchUrl(view, search);
    if (`${window.location.pathname}${window.location.search}` !== next) {
      window.history.pushState(routeHistoryState(view), "", next);
    }
  }

  function handleUsersRouteChange(route: UsersRouteState, replace = false) {
    const search = usersRouteSearch(route);
    const next = workbenchUrl("users", search);
    savedViewSearches.current.set("users", search.toString());
    if (`${window.location.pathname}${window.location.search}` !== next) {
      if (replace) window.history.replaceState(routeHistoryState("users"), "", next);
      else window.history.pushState(routeHistoryState("users"), "", next);
    }
    setUsersRoute(route);
  }

  function handleSyncReportRouteChange(reports: SyncReportRouteState | undefined) {
    const search = dataSyncRouteSearch({
      powerPlatformJobId: requestedPowerPlatformJobId,
      syncRunId: requestedDataSyncRunId,
      refreshJobId: requestedPackageRefreshJobId,
      refreshMode: requestedPackageRefreshMode,
      reports,
    });
    savedViewSearches.current.set("sync", search.toString());
    const next = workbenchUrl("sync", search);
    if (`${window.location.pathname}${window.location.search}` !== next) {
      window.history.pushState(routeHistoryState("sync"), "", next);
    }
    setSyncReportRoute(reports);
  }

  function handleOfficialUsageChanged() {
    automaticRefresh.checkNow();
    requestCurrentAgentReload();
    setOfficialUsageDashboardRevision(revision => revision + 1);
    setCopilotUsersDataRevision(revision => revision + 1);
    void dataSyncPanelRef.current?.refresh();
  }

  function resetUserReportFilters() {
    const next = { ...usersRoute, reportSetId: undefined, agentId: undefined, search: "", page: 0 };
    if (activeView === "users") handleUsersRouteChange(next, true);
    else {
      savedViewSearches.current.set("users", usersRouteSearch(next).toString());
      setUsersRoute(next);
    }
  }

  function handleReportSetSelected(selectionChanged: boolean) {
    if (selectionChanged) resetUserReportFilters();
    handleOfficialUsageChanged();
  }

  function openUsageImport(view: "import" | "manage" = "import") {
    if (activeView !== "sync") navigateToView("sync");
    handleSyncReportRouteChange({ view, activityWindowDays: 30 });
  }

  function handleDataSyncSourcesChanged(sources: DataSyncSourceId[], publicationOnly = false) {
    setSyncHistoryRevision(revision => revision + 1);
    const changed = new Set(sources);
    setPendingDataSyncPublication(current => {
      if (!current || current.owner !== principalKey) return current;
      const remaining = current.sources.filter(source => !changed.has(source));
      return remaining.length ? { ...current, sources: remaining } : undefined;
    });
    if (!publicationOnly && changed.has("users")) setCopilotUsersDataRevision(revision => revision + 1);
    if (changed.has("graph_packages") || changed.has("power_platform")) {
      requestCurrentAgentReload();
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
      powerPlatformJobId: requestedPowerPlatformJobId,
      syncRunId: runId,
      refreshJobId: requestedPackageRefreshJobId,
      refreshMode: requestedPackageRefreshMode,
      reports: syncReportRoute,
    }));
    if (`${window.location.pathname}${window.location.search}` !== next) {
      window.history.pushState(routeHistoryState("sync"), "", next);
    }
  }

  function handleOpenSyncSourceJob(href: string) {
    if (!ownsAgentScope(principalKey)) return;
    const route = parseDataSyncRoute(new URL(href, window.location.href).search);
    selectPowerPlatformJob(route.powerPlatformJobId);
    setRequestedDataSyncRunId(route.syncRunId);
    setRequestedPackageRefreshJobId(route.refreshJobId);
    setRequestedPackageRefreshMode(route.refreshMode);
    setSyncReportRoute(route.reports);
    const search = dataSyncRouteSearch(route);
    savedViewSearches.current.set("sync", search.toString());
    const next = workbenchUrl("sync", search);
    if (`${window.location.pathname}${window.location.search}` !== next) {
      window.history.pushState(routeHistoryState("sync"), "", next);
    }
  }

  const visibleUnifiedAgentPage = unifiedAgentPage?.inventoryScope === agentInventoryScope
    ? unifiedAgentPage : undefined;
  const agentReadLeaseActive = useSelectedReadLease(visibleUnifiedAgentPage?.selection);
  const agentLeaseEnded = Boolean(visibleUnifiedAgentPage && (!agentReadLeaseActive
    || expiredAgentSelection === visibleUnifiedAgentPage.selection.id));
  const renewedInventorySelection = useRef<string | undefined>(undefined);
  const liveInventorySelection = useRef<string | undefined>(undefined);
  const renewInventory = useEffectEvent(() => {
    if (agentReadLeaseActive && !agentLeaseEnded && visibleUnifiedAgentPage) liveInventorySelection.current = visibleUnifiedAgentPage.selection.id;
    if (!agentLeaseEnded || loadingAgents || unifiedAgentReadError || !visibleUnifiedAgentPage
      || activeView !== "agents" && !userAgentOverlay || !isCurrentAgentScope() || document.visibilityState !== "visible" || !navigator.onLine
      || liveInventorySelection.current !== visibleUnifiedAgentPage.selection.id
      || renewedInventorySelection.current === visibleUnifiedAgentPage.selection.id) return;
    renewedInventorySelection.current = visibleUnifiedAgentPage.selection.id;
    requestCurrentAgentReload();
  });
  useEffect(() => { renewInventory(); });
  const matchingPackageSelection = serverPackageSelection?.owner === principalKey
    && serverPackageSelection.id === visibleUnifiedAgentPage?.selection?.id ? serverPackageSelection : undefined;
  const matchingPackageCount = matchingPackageSelection ? visibleUnifiedAgentPage?.counts?.packageTargets ?? 0 : 0;
  const selectedGroups = groupPackageSelection?.owner === principalKey
    && groupPackageSelection.id === visibleUnifiedAgentPage?.selection?.id ? groupPackageSelection.groups : new Set<string>();
  const bulkSelectionKey = JSON.stringify([principalKey, matchingPackageSelection?.id,
    selectedGroups.size ? groupPackageSelection?.id : undefined,
    [...selectedAgentIds].sort(), [...selectedGroups].sort()]);
  const retireBulkSelectionFlow = useEffectEvent(() => {
    if (pendingBulkPreview.current?.requestId !== agentDetailRequestId.current
      && !bulkAccessAgentIds && bulkConfirmation?.mutationScope !== "bulk") return;
    cancelAgentDetailRequest();
    if (bulkConfirmation?.mutationScope === "bulk") setBulkConfirmation(undefined);
    setBulkAccessAgentIds(undefined);
    setBulkAccessSelection(undefined);
  });
  useEffect(() => {
    let active = true;
    void Promise.resolve().then(() => { if (active) retireBulkSelectionFlow(); });
    return () => { active = false; };
  }, [bulkSelectionKey]);
  const groupTargetKey = canOperate && selectedGroups.size ? JSON.stringify([principalKey, groupPackageSelection!.id,
    selectedAgentIds.size ? [...selectedAgentIds] : undefined, [...selectedGroups.keys()]]) : undefined;
  const groupCount = groupTargetCount?.key === groupTargetKey ? groupTargetCount : undefined;
  const groupCountPending = Boolean(groupTargetKey && groupCount?.count === undefined);
  const selectedPackageCount = groupTargetKey ? groupCount?.count ?? 0 : selectedAgentIds.size;
  useEffect(() => {
    if (!groupTargetKey) return;
    groupCountRetryPending.current = true;
    const [owner, selectionId, ids, recordIds] = JSON.parse(groupTargetKey) as [string, string, string[] | null, string[]];
    const abort = new AbortController();
    const timer = setTimeout(() => {
      void countPackageMutationSelection({ selectionId, ids: ids ?? undefined, recordIds }, { signal: abort.signal })
        .then(result => { if (!abort.signal.aborted && sessionOwnerRef.current === owner) setGroupTargetCount({ key: groupTargetKey, count: result.count }); })
        .catch(error => {
          if (abort.signal.aborted || sessionOwnerRef.current !== owner) return;
          if (error instanceof ApiError && ["selection_invalidated", "inventory_changed"].includes(error.code)) {
            invalidateBookmarkedInventory(selectionId);
            return;
          }
          setGroupTargetCount({ key: groupTargetKey, error: errorMessage(error) });
        })
        .finally(() => { if (!abort.signal.aborted) groupCountRetryPending.current = false; });
    }, 100);
    return () => {
      clearTimeout(timer);
      abort.abort();
      groupCountRetryPending.current = false;
      setGroupTargetCount(undefined);
    };
  }, [groupCountRetryRevision, groupTargetKey]);
  const displayedUnifiedAgents = visibleUnifiedAgentPage?.value ?? [];
  const publishingAgentInventory = pendingDataSyncPublication?.owner === principalKey
    && pendingDataSyncPublication.sources.some(source => source === "graph_packages" || source === "power_platform");
  const agentInventoryPending = loadingAgents || agentSearchPending || publishingAgentInventory;
  const inventoryScopeCount = visibleUnifiedAgentPage
    ? inventoryScopeAgentCount(visibleUnifiedAgentPage.summary, agentInventoryScope) : undefined;
  const nativeObservation = visibleUnifiedAgentPage?.sources.powerPlatform.observation;
  const inventoryCollectionText = publishingAgentInventory
    ? "Publishing newly synced agents to the inventory. Results will appear automatically."
    : !visibleUnifiedAgentPage && agentInventoryPending ? "Loading saved agent inventory..."
    : !visibleUnifiedAgentPage && unifiedAgentReadError ? "Saved agent inventory unavailable." : [
    ...(agentInventoryScope !== "power_platform_only" ? [lastAgentListRefreshAt
      ? `Catalog collected ${formatRefreshTime(lastAgentListRefreshAt)}${packageSnapshotExpiresAt && visibleUnifiedAgentPage
        && packageSnapshotExpiresAt.getTime() <= Date.parse(visibleUnifiedAgentPage.selection.validatedAt) ? " / stale saved data" : ""}`
      : "No saved package catalog observation. Open Sync to collect it."] : []),
    ...(agentInventoryScope !== "catalog" ? [nativeObservation
      ? `Power Platform collected ${formatRefreshTime(new Date(nativeObservation.observedAt))}`
      : "No saved Power Platform observation. Open Sync to collect it."] : []),
  ].join(" · ");
  const agentInventoryIssueSummary = inventoryUnavailable || agentInventoryPending
    ? "" : inventoryAttentionReasons(unifiedAgentPage, unifiedAgentReadError).join(" ");
  const hasActiveAgentFilters =
    packageType !== undefined ||
    endUserAccess !== "all" ||
    reportedUsage !== "all" ||
    agentManagement !== "all" ||
    agentRelevance !== "all" ||
    deferredQuery.trim().length > 0 ||
    agentEnvironmentFilter !== undefined ||
    statusFilter !== "all" ||
    publisherFilter !== undefined ||
    availableToFilter !== undefined ||
    hostFilter !== undefined ||
    effectivePlatformFilter !== undefined ||
    parseOptionalPositiveInteger(createdWithinDays) !== undefined;
  const exportableAgentCount = visibleUnifiedAgentPage?.counts.filtered ?? 0;
  const selectedExportTargetCount = selectedAgentIds.size + selectedPowerPlatformTargets.size + selectedGroups.size;
  const exportSelectionRestoring = pendingPowerPlatformIds.size > 0 || pendingStoredAgentSelectionCount !== undefined;
  const agentExportRevision = agentLeaseEnded ? undefined : visibleUnifiedAgentPage?.selection?.id;
  const agentExportNeedsReload = Boolean(unifiedAgentReadError || agentExportError?.reloadRequired || (visibleUnifiedAgentPage && !agentExportRevision));
  const showAgentExportError = !agentLeaseEnded && Boolean(agentExportError && !agentExportError.reloadRequired || !agentInventoryPending && agentExportNeedsReload);
  const selectedQuarantineObservation = selectedPowerPlatformSnapshot ?? unifiedAgentPage?.value.find(
    record => record.observations.powerPlatform,
  )?.observations.powerPlatform ?? null;
  const inlinePackageConfirmation = Boolean(
    selectedUnifiedAgent && !singleAccessAgentDetail && !bulkAccessAgentIds
    && bulkConfirmation?.mutationScope === "single" && bulkConfirmation.ids.length === 1
    && selectedUnifiedAgent.packages.some(item => item.id === bulkConfirmation.ids[0]),
  );

  function clearPrivateState() {
    sessionRequestId.current += 1;
    sessionAbortController.current?.abort();
    sessionOwnerRef.current = undefined;
    setSessionEpoch(current => current + 1);
    setError(undefined);
    clearAgentState();
    savedQueries.clear();
    setLoadedWorkbenchMetadata(undefined);
    routeSession.current = crypto.randomUUID();
    clearPrivateRoute();
  }

  function clearPrivateRoute() {
    setRequestedDataSyncRunId(undefined);
    setSyncReportRoute(undefined);
    selectPowerPlatformJob(undefined);
    setRequestedPackageRefreshMode("delegated");
    setAgentPageIndex(0);
    setUsersRoute(current => ({
      ...current, detailId: undefined, detailTab: undefined, agentId: undefined, reportSetId: undefined, page: 0,
    }));
    savedViewSearches.current.clear();
    const view = parseWorkbenchView(window.location.pathname);
    window.history.replaceState(routeHistoryState(view), "", workbenchUrl(view, publicRouteSearch()));
  }

  function clearAgentState() {
    setAgentOpenedFromUser(undefined);
    setInventoryUnavailable(undefined);
    setInventoryExport(undefined);
    setServerPackageSelection(undefined);
    setBulkAccessSelection(undefined);
    inventoryNavigation.current = { key: "" };
    setGroupPackageSelection(undefined);
    setGroupTargetCount(undefined);
    agentScopeEpochRef.current += 1;
    setAgentScopeEpoch(agentScopeEpochRef.current);
    cancelAgentDetailRequest();
    agentListRequestId.current += 1;
    agentListAbortController.current?.abort();
    inventoryHistoryAbortController.current?.abort();
    bulkJobPollRequestId.current += 1;
    bulkJobRequestAbort.current?.abort();
    packageRefreshRequestId.current += 1;
    packageRefreshAbortController.current?.abort();
    inventoryRefreshRequestId.current += 1;
    inventoryRefreshAbortController.current?.abort();
    linkedPackageRefreshRequestId.current += 1;
    agentInventoryQueries.clear();
    savedQueries.removeQueries({
      predicate: ({ queryKey }) => queryKey[0] === "saved"
        && queryKey[2] === principalKey
        && typeof queryKey[1] === "string"
        && ["package-summaries", "inventory-refresh-jobs", "unified-agent-detail", "package-detail", "bulk-job-items", "inventory-refresh-targets"].includes(queryKey[1]),
    });
    resumedBulkJobIds.current.clear();
    invalidatedBulkJobResults.current.clear();
    appliedBulkJobResults.current.clear();
    bulkJobSelections.current.clear();
    pendingBulkSubmission.current = undefined;
    observedPackageRefreshJobs.current.clear();
    observedPowerPlatformRefreshJobs.current.clear();
    inspectedPowerPlatformJob.current = undefined;
    clearActiveBulkJobId();
    clearPackageSelection(user);
    setAgents([]);
    setUnifiedAgentPage(undefined);
    setSelectedUnifiedAgent(undefined);
    setUnifiedAgentDetailPage(undefined);
    setAgentPackageSelection(undefined);
    setPackageAccessRevisions(new Map());
    setPackageControlError(undefined);
    setSelectedPowerPlatformTargets(new Map());
    setSelectedPowerPlatformSnapshot(null);
    setPendingPowerPlatformIds(new Set());
    setRequestedInventorySnapshotId(undefined);
    setRequestedQuarantineJobId(undefined);
    setQuarantineReceiptPending(false);
    setSelectedAgentIds(new Set());
    setPendingStoredAgentSelectionCount(undefined);
    setSelectionRouteNotice(undefined);
    setRequestedAgentDetailId(undefined);
    setRequestedPackageRefreshJobId(undefined);
    setRequestedPackageControlJobId(undefined);
    setBulkConfirmation(undefined);
    setBulkAccessAgentIds(undefined);
    setAgentDetail(undefined);
    setSingleAccessAgentDetail(undefined);
    setAgentDetailError(undefined);
    setBusyBulkAction(undefined);
    setExportChoiceOpen(false);
    setExportingPowerPlatformCsv(false);
    setRefreshingPowerPlatformAgents(false);
    setPowerPlatformAgentRefreshJob(undefined);
    setInventoryHistoryError(undefined);
    setLastAgentListRefreshAt(undefined);
    setPackageSnapshotExpiresAt(undefined);
    setLoadingAgents(false);
    setRefreshingAgents(false);
    setExportingCsv(false);
    setAgentExportError(undefined);
    setUnifiedAgentReadError(undefined);
    setBulkProgress(undefined);
    setBulkResult(undefined);
    clearTrackedJob();
    setLinkedPackageRefreshJob(undefined);
    setLinkedPackageRefreshError(undefined);
    setLinkedJobError(undefined);
  }

  function invalidateAgentSelection() {
    setInventoryUnavailable(undefined);
    agentListRequestId.current += 1;
    agentListAbortController.current?.abort();
    cancelAgentDetailRequest();
    agentInventoryQueries.clear();
    inventoryNavigation.current = { key: "" };
    setInventoryExport(undefined);
    setServerPackageSelection(undefined);
    setGroupPackageSelection(undefined);
    setGroupTargetCount(undefined);
    setUnifiedAgentPage(undefined);
    setAgents([]);
    setSelectedUnifiedAgent(undefined);
    setUnifiedAgentDetailPage(undefined);
    setAgentPackageSelection(undefined);
    setAgentDetail(undefined);
    setAgentDetailError(undefined);
    setSingleAccessAgentDetail(undefined);
    setSelectedAgentIds(new Set());
    setSelectionRouteNotice(undefined);
    setSelectedPowerPlatformTargets(new Map());
    setSelectedPowerPlatformSnapshot(null);
    setBulkConfirmation(undefined);
    setBulkAccessSelection(undefined);
    setBulkAccessAgentIds(undefined);
    setLoadingAgents(false);
    clearPackageSelection(user);
    setUnifiedAgentReadError("The saved inventory selection is no longer available. Reload saved inventory.");
  }

  async function loadSession() {
    const requestId = ++sessionRequestId.current;
    sessionAbortController.current?.abort();
    const controller = new AbortController();
    sessionAbortController.current = controller;
    const isCurrent = () => requestId === sessionRequestId.current && !controller.signal.aborted;
    setLoadingSession(true);
    setError(undefined);
    setAuthSetup(undefined);
    setAuthSetupError(undefined);

    try {
      try {
        const setup = await fetch("/api/auth/status", { credentials: "include", signal: controller.signal });
        if (!isCurrent()) return;
        if (!setup.ok) throw new Error("Sign-in configuration unavailable");
        const value = await setup.json();
        if (!isCurrent()) return;
        if (!value || typeof value.authConfigured !== "boolean" || typeof value.callback !== "string"
          || value.setup !== undefined && typeof value.setup !== "string") {
          throw new Error("Invalid sign-in configuration");
        }
        setAuthSetup(value);
      } catch {
        if (!isCurrent()) return;
        setAuthSetupError("Sign-in configuration could not be checked. You can still try signing in.");
      }
      const session = await getCurrentUser({ signal: controller.signal });
      if (isCurrent()) {
        const owner = readRouteOwner();
        if (session.user && owner && owner.principal !== routePrincipal(session.user)) {
          clearAgentState();
          clearPrivateRoute();
        }
        setUser(session.user);
      }
    } catch (requestError) {
      if (isCurrent() && !(requestError instanceof ApiError && (requestError.status === 401 || requestError.kind === "aborted"))) {
        setError(errorMessage(requestError));
      }
    } finally {
      if (isCurrent()) setLoadingSession(false);
      if (sessionAbortController.current === controller) sessionAbortController.current = undefined;
    }
  }

  async function loadAgents(forceCurrentSnapshot = false) {
    if (forceCurrentSnapshot) agentInventoryQueries.clear();
    const query = currentUnifiedAgentQuery();
    const inventoryKey = JSON.stringify([principalKey, query]);
    if (forceCurrentSnapshot || inventoryNavigation.current.key !== inventoryKey) {
      inventoryNavigation.current = { key: inventoryKey };
      if (agentPageIndex !== 0) {
        agentListAbortController.current?.abort();
        setAgentPageIndex(0);
        return;
      }
    }
    const readKey = JSON.stringify([inventoryKey, agentReloadRevision,
      inventoryNavigation.current.selectionId, inventoryNavigation.current.cursor]);
    // Inventory consumers share the same pending read; navigation alone does not retire its evidence.
    if (!forceCurrentSnapshot && pendingAgentListKey.current === readKey
      && !agentListAbortController.current?.signal.aborted) return;
    const requestId = ++agentListRequestId.current;
    agentListAbortController.current?.abort();
    const controller = new AbortController();
    agentListAbortController.current = controller;
    pendingAgentListKey.current = readKey;
    setLoadingAgents(true);
    setError(undefined);

    try {
      const unifiedResponse = await agentInventoryQueries.read(principalKey, {
        ...query,
        limit: agentDisplayPageSize,
        selectionId: inventoryNavigation.current.selectionId,
        cursor: inventoryNavigation.current.cursor,
      }, controller.signal);
      if (requestId !== agentListRequestId.current || controller.signal.aborted) return;
      if ("state" in unifiedResponse) {
        setInitialAgentReadOwner(principalKey);
        invalidateAgentSelection();
        setInventoryUnavailable(unifiedResponse);
        setUnifiedAgentReadError(undefined);
        setAgentExportError(undefined);
        setLastAgentListRefreshAt(undefined);
        setPackageSnapshotExpiresAt(undefined);
        return;
      }
      automaticRefresh.admitPublication(unifiedResponse.selection.publicationRevisions);
      if (requestId !== agentListRequestId.current || controller.signal.aborted) return;
      setInitialAgentReadOwner(principalKey);
      setInventoryUnavailable(undefined);
      inventoryNavigation.current.selectionId = unifiedResponse.selection.id;
      setAgents(unifiedResponse.value.flatMap(record => record.packages));
      setUnifiedAgentPage(unifiedResponse);
      setExpiredAgentSelection(undefined);
      setInventoryReportRevision(officialUsageDashboardRevision);
      setUnifiedAgentReadError(undefined);
      setAgentExportError(current => current === agentExportError ? undefined : current);
      const graph = unifiedResponse.sources.graphPackages.observation;
      setLastAgentListRefreshAt(graph ? new Date(graph.observedAt) : undefined);
      setPackageSnapshotExpiresAt(graph ? new Date(graph.expiresAt) : undefined);
    } catch (requestError) {
      if (requestId === agentListRequestId.current && !controller.signal.aborted) {
        setInitialAgentReadOwner(principalKey);
        setInventoryUnavailable(undefined);
        if (isAccessDenied(requestError)) clearAgentState();
        else if (isExpiredSelection(requestError) && unifiedAgentPage) {
          setExpiredAgentSelection(unifiedAgentPage.selection.id);
          setUnifiedAgentReadError(undefined);
          return;
        } else if (requestError instanceof ApiError && ["selection_invalidated", "inventory_changed"].includes(requestError.code)) {
          invalidateAgentSelection();
        }
        setError(errorMessage(requestError));
        setUnifiedAgentReadError(errorMessage(requestError));
      }
    } finally {
      if (requestId === agentListRequestId.current) {
        pendingAgentListKey.current = undefined;
        setLoadingAgents(false);
      }
    }
  }

  function handleRefreshLinkedPackageStatus() {
    if (linkedPackageRefreshPending.current || sessionRevalidationInFlight.current
      || packageRefreshAbortController.current && !packageRefreshAbortController.current.signal.aborted
      || sessionOwnerRef.current !== principalKey || !requestedPackageRefreshJobId) return;
    linkedPackageRefreshPending.current = true;
    setLinkedPackageRefreshRevision(value => value + 1);
  }

  async function handleRefreshAgents(idempotencyKey?: string) {
    if (!isCurrentAgentScope() || !user || sessionRevalidationInFlight.current
      || packageRefreshAbortController.current && !packageRefreshAbortController.current.signal.aborted) return;
    const requestId = ++packageRefreshRequestId.current;
    packageRefreshAbortController.current?.abort();
    const controller = new AbortController();
    packageRefreshAbortController.current = controller;
    const owner = principalKey;
    setRefreshingAgents(true);
    setError(undefined);

    try {
      const existingJobs = idempotencyKey ? await getPackageRefreshJobs("delegated", 20, { signal: controller.signal }) : undefined;
      if (!ownsPackageRefreshRequest(requestId, owner)) return;
      let job = existingJobs?.value.find(candidate => candidate.scopeKind === "broad" && candidate.status === "running")
        ?? await startPackageRefresh("delegated", { idempotencyKey, signal: controller.signal });
      if (!ownsPackageRefreshRequest(requestId, owner)) return;
      setLinkedPackageRefreshJob(job);
      handleSyncRunsChanged();
      while (job.status === "running") {
        await wait(packageRefreshPollIntervalMs);
        if (!ownsPackageRefreshRequest(requestId, owner)) return;
        job = await getPackageRefreshJob(job.id, job.tokenMode, { signal: controller.signal });
        if (!ownsPackageRefreshRequest(requestId, owner)) return;
        setLinkedPackageRefreshJob(job);
      }

      if (job.status !== "succeeded") {
        throw new Error(job.message ?? (job.status === "waiting_authorization"
          ? "Package refresh requires current delegated read authorization. Open Permissions to request consent or retry the probe."
          : "Package refresh failed without replacing the last complete saved observation."));
      }
      if (claimPackageRefreshPublication(job)) automaticRefresh.checkNow();
    } catch (requestError) {
      if (ownsPackageRefreshRequest(requestId, owner)) setError(errorMessage(requestError));
    } finally {
      if (packageRefreshAbortController.current === controller) packageRefreshAbortController.current = undefined;
      if (ownsPackageRefreshRequest(requestId, owner)) setRefreshingAgents(false);
    }
  }

  async function handleRefreshMatchingDetails() {
    if (!isCurrentAgentScope() || packageRefreshAbortController.current && !packageRefreshAbortController.current.signal.aborted) return;
    const count = matchingPackageSelection ? matchingPackageCount : selectedPackageCount;
    const selectionId = visibleUnifiedAgentPage?.selection?.id;
    if (!selectionId || loadingAgents || forceCurrentAgentReload.current || unifiedAgentReadError || groupCountPending
      || count < 1 || count > 5000 || !user || sessionRevalidationInFlight.current) return;
    const requestId = ++packageRefreshRequestId.current;
    packageRefreshAbortController.current?.abort();
    const controller = new AbortController();
    packageRefreshAbortController.current = controller;
    const owner = principalKey;
    setRefreshingAgents(true);
    setError(undefined);
    try {
      let job = await refreshPackageIdentityDetails({ selectionId,
        ...matchingPackageSelection ? {} : {
          ids: selectedAgentIds.size ? [...selectedAgentIds] : undefined,
          recordIds: selectedGroups.size ? [...selectedGroups] : undefined,
        } }, { signal: controller.signal });
      if (!ownsPackageRefreshRequest(requestId, owner)) return;
      handleSyncRunsChanged();
      setLinkedPackageRefreshJob(job);
      while (job.status === "running") {
        await wait(packageRefreshPollIntervalMs);
        if (!ownsPackageRefreshRequest(requestId, owner)) return;
        job = await getPackageRefreshJob(job.id, job.tokenMode, { signal: controller.signal });
        if (!ownsPackageRefreshRequest(requestId, owner)) return;
        setLinkedPackageRefreshJob(job);
      }
      if (job.status !== "succeeded") {
        throw new Error(job.message ?? (job.status === "waiting_authorization"
          ? "Matching-detail refresh requires current delegated package-read authorization."
          : "Matching-detail refresh failed without replacing the last complete saved observations."));
      }
      if (claimPackageRefreshPublication(job)) automaticRefresh.checkNow();
    } catch (requestError) {
      if (ownsPackageRefreshRequest(requestId, owner)) {
        if (requestError instanceof ApiError && ["selection_invalidated", "inventory_changed"].includes(requestError.code)) {
          invalidateAgentSelection();
        }
        setError(errorMessage(requestError));
      }
    } finally {
      if (packageRefreshAbortController.current === controller) packageRefreshAbortController.current = undefined;
      if (ownsPackageRefreshRequest(requestId, owner)) setRefreshingAgents(false);
    }
  }

  async function handleRefreshExactPackage(id: string) {
    if (!isCurrentAgentScope() || packageRefreshAbortController.current && !packageRefreshAbortController.current.signal.aborted) return;
    const requestId = ++packageRefreshRequestId.current;
    packageRefreshAbortController.current?.abort();
    const controller = new AbortController();
    packageRefreshAbortController.current = controller;
    const owner = principalKey;
    setRefreshingAgents(true);
    setError(undefined);
    setAgentDetailError(undefined);
    try {
      let job = await startExactPackageRefresh(id, "delegated", { signal: controller.signal });
      if (!ownsPackageRefreshRequest(requestId, owner)) return;
      while (job.status === "running") {
        await wait(packageRefreshPollIntervalMs);
        if (!ownsPackageRefreshRequest(requestId, owner)) return;
        job = await getPackageRefreshJob(job.id, job.tokenMode, { signal: controller.signal });
        if (!ownsPackageRefreshRequest(requestId, owner)) return;
      }
      if (job.status !== "succeeded") throw new Error(job.message ?? "Exact package refresh requires current delegated package-read authorization.");
      setRequestedAgentDetailId(id);
      if (claimPackageRefreshPublication(job)) automaticRefresh.checkNow();
    } catch (requestError) {
      if (ownsPackageRefreshRequest(requestId, owner)) setAgentDetailError(errorMessage(requestError));
    } finally {
      if (packageRefreshAbortController.current === controller) packageRefreshAbortController.current = undefined;
      if (ownsPackageRefreshRequest(requestId, owner)) setRefreshingAgents(false);
    }
  }

  async function handleSignOut() {
    if (signOutAbortController.current) return;
    const controller = new AbortController();
    signOutAbortController.current = controller;
    setSigningOut(true);
    setError(undefined);
    const requestId = ++sessionRequestId.current;
    sessionAbortController.current?.abort();
    const isCurrent = () => requestId === sessionRequestId.current && !controller.signal.aborted;

    try {
      await signOut({ signal: controller.signal });
      if (!isCurrent()) return;
      clearPrivateState();
      setUser(undefined);
      setLoadingSession(false);
    } catch (requestError) {
      if (isCurrent()) setError(errorMessage(requestError));
    } finally {
      if (signOutAbortController.current === controller) signOutAbortController.current = undefined;
      if (!controller.signal.aborted) setSigningOut(false);
    }
  }

  function handleSearchQueryChange(nextQuery: string) {
    setQuery(nextQuery);
  }

  function cancelAgentDetailRequest() {
    const requestId = ++agentDetailRequestId.current;
    agentDetailAbortController.current?.abort();
    setLoadingAgentDetailId(undefined);
    setLoadingUnifiedAgentDetail(false);
    setBusyAgentId(undefined);
    setPreparingBulkAction(undefined);
    return requestId;
  }

  async function handleViewAgentDetails(agent: Pick<CopilotPackage, "id">) {
    if (!isCurrentAgentScope()) return;
    const owner = principalKey;
    const recordId = selectedUnifiedAgent?.id;
    const selectionId = unifiedAgentDetailPage?.sourcePage?.selection?.id;
    const key = JSON.stringify([owner, recordId, selectionId, agent.id]);
    if (pendingSavedDetail.current?.key === key && pendingSavedDetail.current.requestId === agentDetailRequestId.current
      && !agentDetailAbortController.current?.signal.aborted) return;
    const requestId = cancelAgentDetailRequest();
    const controller = new AbortController();
    agentDetailAbortController.current = controller;
    pendingSavedDetail.current = { key, requestId };

    setAgentDetailError(undefined);
    setAgentDetail(current => current?.owner === owner && current.recordId === recordId
      && current.detail.id === agent.id ? current : undefined);
    setLoadingAgentDetailId(agent.id);

    try {
      if (!selectionId) throw new Error("Reload inventory before opening saved package details.");
      const savedDetail = await getAgentDetails(selectionId, agent.id, { signal: controller.signal });
      if (savedDetail.id !== agent.id) throw new Error("Saved agent details did not match the requested published version.");
      const detail = savedDetail;

      if (ownsAgentDetailRequest(requestId, owner, controller.signal) && currentDetailSelection.current === selectionId) {
        if (selectedUnifiedAgent && !selectedUnifiedAgent.packages.some(item => item.id === agent.id)) {
          const projected = selectedPackagePreview(selectedUnifiedAgent, detail, selectionId);
          setSelectedUnifiedAgent(current => current && current.id === recordId ? { ...current,
            packages: projected.packages, packagesComplete: false, identity: projected.identity,
            observations: projected.observations } : current);
        }
        if (recordId) setAgentPackageSelection({ owner, recordId, packageId: agent.id });
        setAgentDetail({ owner, recordId, selectionId, detail });
      }

    } catch (requestError) {
      if (ownsAgentDetailRequest(requestId, owner, controller.signal) && currentDetailSelection.current === selectionId) {
        if (!isExpiredSelection(requestError)) setAgentDetail(undefined);
        setAgentDetailError(errorMessage(requestError));
        if (isExpiredSelection(requestError)) setExpiredAgentSelection(selectionId);
        else if (requestError instanceof ApiError && requestError.code === "selection_invalidated"
          && selectionId === inventoryNavigation.current.selectionId) invalidateAgentSelection();
      }
    } finally {
      if (pendingSavedDetail.current?.requestId === requestId) pendingSavedDetail.current = undefined;
      if (ownsAgentDetailRequest(requestId, owner, controller.signal)) {
        setLoadingAgentDetailId(undefined);
      }
    }
  }

  function handleViewUnifiedAgentDetails(record: UnifiedAgentRecord) {
    if (!isCurrentAgentScope()) return;
    const requestId = cancelAgentDetailRequest();
    if (!ownsAgentFlowRequest(requestId, principalKey)) return;
    setUnifiedAgentDetailPage({ listPage: unifiedAgentPage, sourcePage: unifiedAgentPage });
    setAgentDetailError(undefined);
    setAgentDetail(undefined);
    setAgentPackageSelection(undefined);
    setRequestedAgentDetailId(record.id);
    setSelectedUnifiedAgent(record);
  }

  async function refreshAccessDetails(id: string, requestId: number) {
    if (!isCurrentAgentScope()) return;
    const access = capabilityState.views.find(view => view.definition.id === "graph.package.access.manage");
    if (!hasRole(user, "AgentControl.Admin") || !providerActionAllowed(access, true, Date.now())) {
      throw new Error("Current Admin access and package access-management authorization are required.");
    }
    const controller = new AbortController();
    agentDetailAbortController.current = controller;
    let job = await startExactPackageRefresh(id, "delegated", { signal: controller.signal });
    if (agentDetailRequestId.current !== requestId) return;
    while (job.status === "running") {
      await wait(packageRefreshPollIntervalMs);
      if (agentDetailRequestId.current !== requestId) return;
      job = await getPackageRefreshJob(job.id, job.tokenMode, { signal: controller.signal });
      if (agentDetailRequestId.current !== requestId) return;
    }
    if (job.status !== "succeeded") throw new Error(job.message ?? "Microsoft Graph could not load current package access. Check delegated permissions and retry.");
    const page = await getAgents({ recordId: `graph_packages:${encodeURIComponent(id)}`, limit: 1 }, { signal: controller.signal });
    if (agentDetailRequestId.current !== requestId) return;
    const detail = await getAgentDetails(page.selection.id, id, { signal: controller.signal });
    if (agentDetailRequestId.current !== requestId) return;
    if (detail.id !== id) throw new Error("Current access details did not match the requested published version.");
    if (detail.accessReadError) throw new Error(detail.accessReadError);
    return detail;
  }

  async function handleManageAgentAccess(agent: CopilotPackage, target: PackageAccessTarget = "availability") {
    if (!selectedReadRemaining(visibleUnifiedAgentPage?.selection)) return;
    if (!isCurrentAgentScope() || bulkJobStatusUnrecognized) return;
    const key = JSON.stringify([principalKey, agent.id, target]);
    if (pendingAccessPreparation.current?.key === key
      && pendingAccessPreparation.current.requestId === agentDetailRequestId.current
      && !agentDetailAbortController.current?.signal.aborted) return;
    const requestId = cancelAgentDetailRequest();
    pendingAccessPreparation.current = { key, requestId };

    setAgentDetailError(undefined);
    setSingleAccessAgentDetail(undefined);
    setLoadingAgentDetailId(agent.id);

    try {
      const detail = await refreshAccessDetails(agent.id, requestId);
      if (!detail) return;

      if (agentDetailRequestId.current === requestId) {
        setSingleAccessTarget(target);
        setSingleAccessAgentDetail(detail);
        if (agentDetail?.id === agent.id) setAgentDetail({
          owner: principalKey, recordId: selectedUnifiedAgent?.id,
          selectionId: unifiedAgentDetailPage?.sourcePage?.selection.id, detail,
        });
      }
    } catch (requestError) {
      if (agentDetailRequestId.current === requestId) {
        setAgentDetailError(errorMessage(requestError));
      }
    } finally {
      if (pendingAccessPreparation.current?.requestId === requestId) pendingAccessPreparation.current = undefined;
      if (agentDetailRequestId.current === requestId) {
        setLoadingAgentDetailId(undefined);
      }
    }
  }

  async function handleAgentAction(
    agent: CopilotPackage,
    targetBlockedState: boolean,
  ) {
    if (!isCurrentAgentScope() || !selectedReadRemaining(visibleUnifiedAgentPage?.selection)
      || bulkJobStatusUnrecognized || pendingSinglePreview.current === agentDetailRequestId.current) return;
    const returnFocusTo = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    const requestId = cancelAgentDetailRequest();
    pendingSinglePreview.current = requestId;
    const controller = new AbortController();
    agentDetailAbortController.current = controller;
    const owner = principalKey;
    if (loadingAgentDetailId) setRequestedAgentDetailId(undefined);
    setBusyAgentId(agent.id);
    setError(undefined);
    setPackageControlError(undefined);
    setBulkResult(undefined);

    try {
      const action = targetBlockedState ? "block" : "unblock";
      const preview = await previewPackageMutation({ action, ids: [agent.id], mutationScope: "single" }, { signal: controller.signal });
      if (!ownsAgentFlowRequest(requestId, owner)) return;
      setBulkConfirmation({ action, ids: [agent.id], mutationScope: "single", preview, returnFocusTo });
      return true;
    } catch (requestError) {
      if (ownsAgentFlowRequest(requestId, owner)) {
        const message = errorMessage(requestError);
        setError(message);
        setPackageControlError({ packageId: agent.id, message });
      }
    } finally {
      if (pendingSinglePreview.current === requestId) pendingSinglePreview.current = undefined;
      if (ownsAgentFlowRequest(requestId, owner)) setBusyAgentId(undefined);
    }
  }

  async function handleInlineAccessUpdate(agent: CopilotPackage, update: PackageAccessUpdate) {
    if (!isCurrentAgentScope() || !selectedReadRemaining(visibleUnifiedAgentPage?.selection)) return;
    if (bulkJobStatusUnrecognized) throw new Error(jobStatusMessage(undefined));
    if (!selectedUnifiedAgent?.packages.some(item => item.id === agent.id)) {
      throw new Error("This published version is no longer selected. Reopen the agent before changing access.");
    }
    const requestId = cancelAgentDetailRequest();
    const owner = principalKey;
    if (!ownsAgentFlowRequest(requestId, owner)) return;
    setBusyAgentId(agent.id);
    setPackageControlError(undefined);
    setBulkResult(undefined);
    try {
      const detail = await refreshAccessDetails(agent.id, requestId);
      if (!detail || !ownsAgentFlowRequest(requestId, owner)) return;
      await requestAccessConfirmation([agent.id], update, "single");
    } catch (requestError) {
      if (ownsAgentFlowRequest(requestId, owner)) throw requestError;
    } finally {
      if (ownsAgentFlowRequest(requestId, owner)) setBusyAgentId(undefined);
    }
  }

  async function requestAccessConfirmation(
    ids: string[],
    update: PackageAccessUpdate,
    mutationScope: "single" | "bulk",
  ) {
    if (!isCurrentAgentScope() || !selectedReadRemaining(visibleUnifiedAgentPage?.selection)) return false;
    if (bulkJobStatusUnrecognized) throw new Error(jobStatusMessage(undefined));
    if (mutationScope === "single" && update.mode !== "replace") {
      throw new Error("Single-agent access updates must replace assignments.");
    }

    setError(undefined);
    const action = update.target === "availability" ? "update-availability" : "update-installation";
    const requestId = agentDetailRequestId.current;
    const owner = principalKey;
    agentDetailAbortController.current?.abort();
    const controller = new AbortController();
    agentDetailAbortController.current = controller;
    if (mutationScope === "single") pendingSinglePreview.current = requestId;
    try {
      const preview = await previewPackageMutation({ action, ids, mutationScope, accessUpdate: update }, { signal: controller.signal });
      if (!ownsAgentFlowRequest(requestId, owner) || forceCurrentAgentReload.current
        || !selectedReadRemaining(visibleUnifiedAgentPage?.selection)) return false;
      setBulkConfirmation({ action, ids, mutationScope, preview, accessUpdate: update });
      return true;
    } finally {
      if (pendingSinglePreview.current === requestId) pendingSinglePreview.current = undefined;
    }
  }

  function requestExportCsv() {
    if (!isCurrentAgentScope() || exportingCsv || loadingAgents || forceCurrentAgentReload.current
      || !selectedReadRemaining(visibleUnifiedAgentPage?.selection)) return;
    if (!agentExportRevision || agentExportNeedsReload) {
      setAgentExportError({ message: "Reload the saved agent inventory before exporting; a valid saved revision is required.", reloadRequired: true });
      return;
    }
    setExportChoiceOpen(true);
  }

  function handleExportCsv(scope: UnifiedAgentExportScope) {
    if (exportingCsv || !selectedReadRemaining(visibleUnifiedAgentPage?.selection)) return;
    const owner = principalKey;
    if (!ownsAgentScope(owner) || !hasRole(user, "AgentControl.Viewer")) return;
    if (!agentExportRevision || agentExportNeedsReload) {
      setAgentExportError({ message: "Reload the saved agent inventory before exporting; a valid saved revision is required.", reloadRequired: true });
      return;
    }
    if (loadingAgents || agentSearchPending || forceCurrentAgentReload.current) {
      setAgentExportError({ message: "Wait for the current saved agent filters to finish loading, then try again.", reloadRequired: false });
      return;
    }
    if (scope === "matching" && exportableAgentCount === 0) {
      setAgentExportError({ message: "No agents match the current saved filters.", reloadRequired: false });
      return;
    }
    if (scope === "selected" && (selectedExportTargetCount === 0 || selectedExportTargetCount > 5000 || exportSelectionRestoring)) {
      setAgentExportError({ message: "Select 1–5,000 exact references and wait for saved selections to finish restoring.", reloadRequired: false });
      return;
    }

    setExportChoiceOpen(false);
    setAgentExportError(undefined);
    setInventoryExport({ sequence: ++exportSequence.current, owner, selectionId: agentExportRevision, kind: "unified_agents",
      ids: scope === "selected" ? [...new Set([...selectedAgentExportReferences(unifiedAgentPage?.value ?? [], selectedAgentIds, selectedPowerPlatformTargets.keys()),
        ...selectedGroups.keys()])] : undefined });
  }

  function handleExportPowerPlatformAgentCsv() {
    if (!ownsAgentScope(principalKey)) return false;
    if (!agentExportRevision || agentExportNeedsReload || exportingPowerPlatformCsv
      || loadingAgents || agentSearchPending || forceCurrentAgentReload.current) {
      return false;
    }

    setExportChoiceOpen(false);
    setError(undefined);
    setInventoryExport({ sequence: ++exportSequence.current, owner: principalKey, selectionId: agentExportRevision, kind: "power_platform_agents" });
    return true;
  }

  async function handleRefreshPowerPlatformAgents() {
    if (!isCurrentAgentScope()) return;
    if (requestedPowerPlatformJobId || refreshingPowerPlatformAgents || powerPlatformAgentRefreshJob?.status === "running"
      || inventoryRefreshAbortController.current && !inventoryRefreshAbortController.current.signal.aborted) {
      return;
    }

    setError(undefined);
    setRefreshingPowerPlatformAgents(true);
    const requestId = ++inventoryRefreshRequestId.current;
    inventoryRefreshAbortController.current?.abort();
    const controller = new AbortController();
    inventoryRefreshAbortController.current = controller;
    const owner = principalKey;
    try {
      const job = await refreshInventory({
        types: ["microsoft.copilotstudio/agents", "microsoft.powerplatform/environments"],
      }, { signal: controller.signal });
      if (!ownsInventoryRefreshRequest(requestId, owner)) return;
      setPowerPlatformAgentRefreshJob(job);
      handleSyncRunsChanged();
      if (job.status === "succeeded") {
        if (claimPowerPlatformPublication(job)) {
          automaticRefresh.checkNow();
        }
      } else if (job.status !== "waiting_authorization" && job.status !== "running") {
        setError(job.message ?? "Power Platform agent refresh did not complete.");
      }
    } catch (caught) {
      if (ownsInventoryRefreshRequest(requestId, owner)) {
        setError(caught instanceof Error ? caught.message : "Unable to refresh Power Platform agents.");
      }
    } finally {
      if (inventoryRefreshAbortController.current === controller) inventoryRefreshAbortController.current = undefined;
      if (ownsInventoryRefreshRequest(requestId, owner)) setRefreshingPowerPlatformAgents(false);
    }
  }

  async function handleResumePowerPlatformAgentRefresh() {
    if (!isCurrentAgentScope()) return;
    if (requestedPowerPlatformJobId || powerPlatformAgentRefreshJob?.status !== "waiting_authorization" || refreshingPowerPlatformAgents
      || inventoryRefreshAbortController.current && !inventoryRefreshAbortController.current.signal.aborted) {
      return;
    }
    setError(undefined);
    setRefreshingPowerPlatformAgents(true);
    const requestId = ++inventoryRefreshRequestId.current;
    inventoryRefreshAbortController.current?.abort();
    const controller = new AbortController();
    inventoryRefreshAbortController.current = controller;
    const owner = principalKey;
    try {
      const job = await resumeInventoryRefresh(powerPlatformAgentRefreshJob.id, { signal: controller.signal });
      if (!ownsInventoryRefreshRequest(requestId, owner)) return;
      setPowerPlatformAgentRefreshJob(job);
      handleSyncRunsChanged();
      if (job.status === "succeeded") {
        if (claimPowerPlatformPublication(job)) {
          automaticRefresh.checkNow();
        }
      }
      else if (job.status !== "running" && job.status !== "waiting_authorization") {
        setError(job.message ?? "Power Platform agent refresh did not complete.");
      }
    } catch (caught) {
      if (ownsInventoryRefreshRequest(requestId, owner)) {
        setError(caught instanceof Error ? caught.message : "Unable to resume the Power Platform agent refresh.");
      }
    } finally {
      if (inventoryRefreshAbortController.current === controller) inventoryRefreshAbortController.current = undefined;
      if (ownsInventoryRefreshRequest(requestId, owner)) setRefreshingPowerPlatformAgents(false);
    }
  }

  function claimPowerPlatformPublication(job: InventoryRefreshJob) {
    if (observedPowerPlatformRefreshJobs.current.has(job.id)) return false;
    observedPowerPlatformRefreshJobs.current.add(job.id);
    return true;
  }

  function handlePowerPlatformSourceJobObserved(job: InventoryRefreshJob, previous?: InventoryRefreshJob) {
    if (!ownsAgentScope(principalKey)) return;
    inspectedPowerPlatformJob.current = job;
    const latest = powerPlatformAgentRefreshJob;
    const prior = previous ?? (latest?.id === job.id ? latest : undefined);
    if (latest?.id === job.id || previous && previous.id !== job.id
      && job.requestedTypes.includes("microsoft.copilotstudio/agents")) setPowerPlatformAgentRefreshJob(job);
    if (job.status === "succeeded" && claimPowerPlatformPublication(job)) {
      automaticRefresh.checkNow();
    } else if (prior && (prior.id !== job.id || prior.status !== job.status)) handleSyncRunsChanged();
  }

  async function requestBulkAction(targetBlockedState: boolean) {
    if (!isCurrentAgentScope() || !selectedReadRemaining(visibleUnifiedAgentPage?.selection)
      || bulkJobStatusUnrecognized || groupCountPending || matchingPackageSelection && (loadingAgents || agentSearchPending || unifiedAgentReadError)) return;
    const label = targetBlockedState ? "block" : "unblock";
    const scope = [...selectedAgentIds];

    if (scope.length === 0 && !selectedGroups.size && !matchingPackageSelection) {
      setError("Select one or more agents before running a bulk action.");
      return;
    }

    const targets = matchingPackageSelection ? { selectionId: matchingPackageSelection.id }
      : selectedGroups.size ? { selectionId: groupPackageSelection!.id,
        ids: scope.length ? scope : undefined, recordIds: [...selectedGroups.keys()] } : { ids: scope };
    const key = JSON.stringify([principalKey, label, targets]);
    if (pendingBulkPreview.current?.key === key && pendingBulkPreview.current.requestId === agentDetailRequestId.current) return;
    const requestId = cancelAgentDetailRequest();
    pendingBulkPreview.current = { key, requestId };
    setPreparingBulkAction(label);
    const controller = new AbortController();
    agentDetailAbortController.current = controller;
    const owner = principalKey;
    if (loadingAgentDetailId) setRequestedAgentDetailId(undefined);
    setError(undefined);
    try {
      const preview = await previewPackageMutation({ action: label, ...targets, mutationScope: "bulk" }, { signal: controller.signal });
      if (!ownsAgentFlowRequest(requestId, owner) || forceCurrentAgentReload.current
        || !selectedReadRemaining(visibleUnifiedAgentPage?.selection)) return;
      if (selectedGroups.size && !preview.selectionId) throw new Error("The server did not return the reviewed group selection.");
      setBulkConfirmation({ action: label, ...targets, ids: scope, selectionId: selectedGroups.size ? preview.selectionId : targets.selectionId, mutationScope: "bulk", preview });
    } catch (requestError) {
      if (ownsAgentFlowRequest(requestId, owner)) setError(errorMessage(requestError));
    } finally {
      if (pendingBulkPreview.current?.requestId === requestId) pendingBulkPreview.current = undefined;
      if (ownsAgentFlowRequest(requestId, owner)) setPreparingBulkAction(undefined);
    }
  }

  async function runConfirmedBulkAction(confirmation: BulkConfirmation) {
    if (!isCurrentAgentScope() || !selectedReadRemaining(visibleUnifiedAgentPage?.selection)
      || bulkJobStatusUnrecognized || pendingBulkSubmission.current) return;
    pendingBulkSubmission.current = confirmation;
    const { action: label, ids, recordIds, selectionId, mutationScope, preview, accessUpdate } = confirmation;
    const requestId = ++bulkJobPollRequestId.current;
    bulkJobRequestAbort.current?.abort();
    const controller = new AbortController();
    bulkJobRequestAbort.current = controller;
    const owner = principalKey;

    setBulkConfirmation(undefined);
    setRequestedPackageControlJobId(undefined);
    setServerPackageSelection(undefined);
    setGroupPackageSelection(undefined);

    clearTrackedJob();
    setBusyBulkAction(label);
    const currentAgentName = preview.summary.targetCount === 1 ? preview.summary.targets[0]?.displayName : undefined;
    setBulkProgress(accessUpdate ? {
      action: label as "update-availability" | "update-installation",
      accessUpdate,
      currentAgentName,
      total: preview.summary.targetCount,
      completed: 0,
      succeeded: 0,
      failed: 0,
      skipped: 0,
    } : {
      action: label as "block" | "unblock",
      targetBlockedState: label === "block",
      currentAgentName,
      total: preview.summary.targetCount,
      completed: 0,
      succeeded: 0,
      failed: 0,
      skipped: 0,
    });
    setError(undefined);
    setBulkResult(undefined);

    try {
      let job: BulkActionJob;
      if (selectionId) {
        job = await submitSelectedPackageMutation({ action: label, selectionId, accessUpdate,
          ids: recordIds && ids.length ? ids : undefined, recordIds, confirmationHash: preview.confirmationHash }, { signal: controller.signal });
      } else if (accessUpdate) {
        if (mutationScope === "single") {
          if (accessUpdate.mode !== "replace") throw new Error("Single-agent access updates must replace assignments.");
          job = await updateAgentAccess(ids[0], accessUpdate, preview.confirmationHash, { signal: controller.signal });
        } else {
          job = await updateAgentsAccess(ids, accessUpdate, preview.confirmationHash, { signal: controller.signal });
        }
      } else if (mutationScope === "single") {
        job = label === "block"
          ? await blockAgent(ids[0], preview.confirmationHash, { signal: controller.signal })
          : await unblockAgent(ids[0], preview.confirmationHash, { signal: controller.signal });
      } else {
        job = label === "block"
          ? await blockAgents(ids, preview.confirmationHash, { signal: controller.signal })
          : await unblockAgents(ids, preview.confirmationHash, { signal: controller.signal });
      }

      if (!ownsBulkJobRequest(requestId, owner)) return;
      if (mutationScope === "bulk") bulkJobSelections.current.set(job.id, selectedAgentIds);
      await followBulkJob(job.id, job, true, mutationScope === "single" ? ids[0] : undefined);
    } catch (requestError) {
      if (ownsBulkJobRequest(requestId, owner)) {
        const staleConfirmation = requestError instanceof ApiError
          && ["selection_invalidated", "inventory_changed", "confirmation_mismatch"].includes(requestError.code);
        const message = staleConfirmation
          ? "The saved inventory changed before the action could start. Reloading saved inventory. Review and confirm the action again."
          : errorMessage(requestError);
        if (staleConfirmation) {
          invalidateAgentSelection();
          requestCurrentAgentReload();
        }
        setBulkJobError(message);
        if (mutationScope === "single" && ids.length === 1) setPackageControlError({ packageId: ids[0], message });
        setBusyBulkAction(undefined);
        setBulkProgress(undefined);
        clearActiveBulkJobId();
      }
    } finally {
      if (pendingBulkSubmission.current === confirmation) pendingBulkSubmission.current = undefined;
      if (bulkJobRequestAbort.current === controller) bulkJobRequestAbort.current = undefined;
    }
  }

  function requestBulkAccessUpdate() {
    if (!isCurrentAgentScope() || !selectedReadRemaining(visibleUnifiedAgentPage?.selection)
      || bulkJobStatusUnrecognized || groupCountPending || matchingPackageSelection && (loadingAgents || agentSearchPending || unifiedAgentReadError)) return;
    cancelAgentDetailRequest();
    setBulkConfirmation(undefined);
    if (matchingPackageSelection || selectedGroups.size) {
      const count = matchingPackageSelection ? matchingPackageCount : selectedPackageCount;
      if (count > 100) { setError("Access changes support at most 100 package targets. Narrow the server filters."); return; }
      setBulkAccessSelection(matchingPackageSelection ? { ...matchingPackageSelection, count } : {
        id: visibleUnifiedAgentPage!.selection!.id, owner: principalKey, count,
        ids: selectedAgentIds.size ? [...selectedAgentIds] : undefined, recordIds: [...selectedGroups.keys()],
      });
      setBulkAccessAgentIds([]);
      return;
    }
    if (selectedAgentIds.size === 0) {
      setError("Select one or more agents before managing access.");
      return;
    }

    setError(undefined);
    setBulkAccessSelection(undefined);
    setBulkAccessAgentIds([...selectedAgentIds]);
  }

  async function runBulkAccessUpdate(update: PackageAccessUpdate) {
    if (!isCurrentAgentScope() || !selectedReadRemaining(visibleUnifiedAgentPage?.selection)) return;
    if (bulkJobStatusUnrecognized) throw new Error(jobStatusMessage(undefined));
    const ids = bulkAccessAgentIds ?? [];

    if (ids.length === 0 && (!bulkAccessSelection || bulkAccessSelection.owner !== principalKey
      || bulkAccessSelection.id !== (bulkAccessSelection.recordIds ? visibleUnifiedAgentPage?.selection?.id : matchingPackageSelection?.id))) {
      throw new Error("The selected agents are no longer available.");
    }

    setError(undefined);
    setBulkResult(undefined);
    const requestId = cancelAgentDetailRequest();

    try {
      if (bulkAccessSelection) {
        const controller = new AbortController();
        agentDetailAbortController.current = controller;
        const action = update.target === "availability" ? "update-availability" : "update-installation";
        const { recordIds, ids: exactIds } = bulkAccessSelection;
        const preview = await previewPackageMutation({ action, selectionId: bulkAccessSelection.id, recordIds, ids: exactIds, mutationScope: "bulk", accessUpdate: update }, { signal: controller.signal });
        if (agentDetailRequestId.current !== requestId || forceCurrentAgentReload.current
          || !selectedReadRemaining(visibleUnifiedAgentPage?.selection)) return;
        setBulkConfirmation({ action, ids: exactIds ?? [], recordIds, selectionId: bulkAccessSelection.id, mutationScope: "bulk", accessUpdate: update, preview });
      } else await requestAccessConfirmation(ids, update, "bulk");
      if (agentDetailRequestId.current !== requestId) return;
      setBulkAccessAgentIds(undefined);
      setBulkAccessSelection(undefined);
    } catch (requestError) {
      if (agentDetailRequestId.current !== requestId) return;
      throw requestError;
    }
  }

  async function followBulkJob(jobId: string, initialJob?: BulkActionJob, persist = true, packageId?: string) {
    if (!isCurrentAgentScope()) return;
    if (persist) resumedBulkJobIds.current.add(jobId);
    const requestId = bulkJobPollRequestId.current + 1;
    bulkJobPollRequestId.current = requestId;
    const owner = principalKey;
    setTrackedJobId(jobId);
    bulkJobRequestAbort.current?.abort();
    const controller = new AbortController();
    bulkJobRequestAbort.current = controller;
    let keepStored = true;
    let observedJob: BulkActionJob | undefined;
    const deadline = Date.now() + foregroundJobPollBudgetMs;
    if (persist) {
      const storageError = user ? saveStoredActiveBulkJobId(user, jobId) : undefined;
      if (storageError) setBulkJobStorageError(storageError);
    }

    try {
      let job = initialJob ?? (await getBulkActionJob(jobId, { signal: controller.signal }));
      if (!ownsBulkJobRequest(requestId, owner)) return;
      job = currentBulkJobObservation(job);
      observedJob = job;
      setTrackedJob(job);

      setBusyBulkAction(job.action);
      setBulkProgress(toBulkProgress(job));

      while (isJobPolling(job.status) && Date.now() < deadline) {
        await wait(bulkJobPollIntervalMs);

        if (!ownsBulkJobRequest(requestId, owner)) {
          return;
        }
        job = await getBulkActionJob(jobId, { signal: controller.signal });

        if (!ownsBulkJobRequest(requestId, owner)) {
          return;
        }

        job = currentBulkJobObservation(job);
        observedJob = job;
        setBulkProgress(toBulkProgress(job));
        setTrackedJob(job);
      }

      if (isJobPolling(job.status)) {
        keepStored = persist;
        const message = "Automatic status updates paused after five minutes. Use Refresh status in this panel to continue checking; the task may still be running.";
        setBulkJobError(message);
        if (packageId) setPackageControlError({ packageId, message });
        return;
      }

      keepStored = job.canResume || job.status === "waiting_authorization";
      if (["succeeded", "failed", "cancelled", "partial"].includes(job.status)) {
        const resultKey = JSON.stringify([job.id, job.resultRevision]);
        const page = await readSavedQuery(savedQueries, ["bulk-job-items", owner, job.id, job.resultRevision, undefined],
          signal => getBulkActionJobItems(job.id, { revision: job.resultRevision }, { signal }),
          controller.signal, { staleTime: Infinity, gcTime: 60_000 });
        if (!ownsBulkJobRequest(requestId, owner)) return;
        const result: BulkActionResult = { ...job, results: page.value.filter((item): item is BulkPackageResult =>
          item.status !== "queued" && item.status !== "running") };
        if (persist && !appliedBulkJobResults.current.has(resultKey)) {
          appliedBulkJobResults.current.add(resultKey);
          applyBulkActionResult(result, !invalidatedBulkJobResults.current.has(resultKey), bulkJobSelections.current.get(jobId));
        } else setBulkResult(result);
      }
      const message = jobStatusMessage(job.status);
      if (packageId && message) setPackageControlError({ packageId, message });
    } catch (requestError) {
      if (ownsBulkJobRequest(requestId, owner)) {
        setTrackedJobId(jobId);
        if (persist) {
          const message = errorMessage(requestError);
          setBulkJobError(message);
          if (packageId) setPackageControlError({ packageId, message });
        }
        else setLinkedJobError(`The exact package control job is expired, deleted, or unavailable to this account. ${errorMessage(requestError)}`);
      }
    } finally {
      if (bulkJobRequestAbort.current === controller) bulkJobRequestAbort.current = undefined;
      if (ownsBulkJobRequest(requestId, owner)) {
        if (persist && observedJob) {
          const resultKey = JSON.stringify([observedJob.id, observedJob.resultRevision]);
          if (!invalidatedBulkJobResults.current.has(resultKey)) {
            invalidatedBulkJobResults.current.add(resultKey);
            if (observedJob.succeeded > 0 || observedJob.skipped > 0) requestCurrentAgentReload();
          }
        }
        setBusyBulkAction(undefined);
        setBulkProgress(undefined);
        if (persist && !keepStored) clearActiveBulkJobId();
      }
    }
  }

  function validateBulkJobStatus(job: BulkActionJob) {
    const known = isKnownJobStatus(job.status);
    setBulkJobStatusUnrecognized(!known);
    if (!known) throw new Error(jobStatusMessage(job.status));
  }

  function currentBulkJobObservation(job: BulkActionJob) {
    validateBulkJobStatus(job);
    const acknowledgement = bulkResumeAcknowledgement.current;
    if (acknowledgement?.id === job.id) {
      const unchanged = job.updatedAt === acknowledgement.updatedAt && job.resultRevision === acknowledgement.resultRevision;
      // Resume acknowledges queued work before the worker finishes authorization and claims it.
      if (unchanged && (job.status === "waiting_authorization" || job.status === "partial")) return acknowledgement;
      if (!unchanged || job.status !== "queued") bulkResumeAcknowledgement.current = undefined;
    }
    return job;
  }

  function applyBulkActionResult(result: BulkActionResult, projectInventory: boolean, selection: Set<string> | undefined) {
    if (projectInventory && result.targetBlockedState !== undefined) {
      updateCachedAgentBlockedStates(
        result.results
          .filter((item) => item.status === "succeeded")
          .map((item) => item.id),
        result.targetBlockedState,
      );
    }

    if (projectInventory && result.accessUpdate) {
      const changedIds = result.results
        .filter((item) => item.status === "succeeded")
        .map((item) => item.id);

      const changedAgentIds = new Set(changedIds);
      if (changedIds.length) setPackageAccessRevisions(current => {
        const next = new Map(current);
        for (const id of changedIds) next.set(id, (next.get(id) ?? 0) + 1);
        return next;
      });
      const projectAccess = (item: CopilotPackage) => changedAgentIds.has(item.id)
        ? projectVerifiedAccessScope(item, result.accessUpdate!)
        : item;

      setAgents((currentAgents) => currentAgents.map(projectAccess));
      setUnifiedAgentPage(current => current ? {
        ...current,
        value: current.value.map(record => projectVerifiedAgentMutation(record, changedAgentIds, { accessUpdate: result.accessUpdate! })),
      } : current);
      setSelectedUnifiedAgent(current => current
        ? projectVerifiedAgentMutation(current, changedAgentIds, { accessUpdate: result.accessUpdate! }) : current);

      if (agentDetail && changedIds.includes(agentDetail.id)) {
        setAgentDetail(undefined);
      }

      if (
        singleAccessAgentDetail &&
        changedIds.includes(singleAccessAgentDetail.id)
      ) {
        setSingleAccessAgentDetail(undefined);
      }
    }

    setBulkResult(result);
    setSelectionRouteNotice(undefined);
    setSelectedAgentIds(current => current === selection
      ? new Set(
        (result.total > result.results.length ? [] : result.results)
          .filter((result) => result.status === "failed")
          .map((result) => result.id),
      ) : current,
    );
  }

  async function handleBulkJobCommand(operation: BulkJobCommand) {
    if (!isCurrentAgentScope()) return;
    if (bulkJobStatusUnrecognized && operation !== "refresh" && operation !== "cancel") return;
    const jobId = trackedJob?.id ?? trackedJobId;
    if (!jobId || !trackedJob && operation !== "refresh" || bulkJobCommandRequestId.current !== undefined) return;
    if (operation === "resume" && !window.confirm("Resume only unprocessed tasks with your current authorization? Changes with uncertain outcomes will not be repeated.")) return;
    // A bookmarked read is passive until an explicit command adopts its lifecycle.
    const persist = !requestedPackageControlJobId || resumedBulkJobIds.current.has(jobId) || operation !== "refresh";
    if (persist) resumedBulkJobIds.current.add(jobId);
    const requestId = ++bulkJobPollRequestId.current;
    bulkJobRequestAbort.current?.abort();
    const controller = new AbortController();
    bulkJobRequestAbort.current = controller;
    const owner = principalKey;
    bulkJobCommandRequestId.current = requestId;
    setBulkJobCommand(operation);
    setBulkJobError(undefined);
    setLinkedJobError(undefined);
    try {
      if (operation === "refresh") {
        const job = await getBulkActionJob(jobId, { signal: controller.signal });
        if (!ownsBulkJobRequest(requestId, owner)) return;
        finishBulkJobCommand(requestId);
        await followBulkJob(job.id, job, persist);
      } else if (operation === "reconcile") {
        const reconciled = await reconcileBulkActionJob(jobId, { signal: controller.signal });
        if (!ownsBulkJobRequest(requestId, owner)) return;
        validateBulkJobStatus(reconciled);
        setTrackedJob(reconciled);
        setBulkResult(undefined);
        if (reconciled.reconciliation.attempted > reconciled.reconciliation.failed) {
          const resultKey = JSON.stringify([reconciled.id, reconciled.resultRevision]);
          if (!invalidatedBulkJobResults.current.has(resultKey)) {
            invalidatedBulkJobResults.current.add(resultKey);
            requestCurrentAgentReload();
          }
        }
        if (reconciled.reconciliation.failed) {
          setBulkJobError(`${reconciled.reconciliation.failed} provider read${reconciled.reconciliation.failed === 1 ? "" : "s"} could not be reconciled.`);
        }
      } else {
        const job = operation === "resume"
          ? await resumeBulkActionJob(jobId, { signal: controller.signal }) : await cancelBulkActionJob(jobId, { signal: controller.signal });
        if (!ownsBulkJobRequest(requestId, owner)) return;
        if (operation === "resume") {
          bulkResumeAcknowledgement.current = job.status === "queued" ? job : undefined;
          finishBulkJobCommand(requestId);
        }
        await followBulkJob(job.id, job, persist);
      }
    } catch (requestError) {
      if (ownsBulkJobRequest(requestId, owner)) {
        setBulkJobError(errorMessage(requestError));
        setBusyBulkAction(undefined);
        setBulkProgress(undefined);
        if (operation === "cancel" && !bulkJobStatusUnrecognized && trackedJob && isJobPolling(trackedJob.status)) {
          finishBulkJobCommand(requestId);
          await followBulkJob(trackedJob.id, trackedJob, persist);
        }
      }
    } finally {
      if (bulkJobRequestAbort.current === controller) bulkJobRequestAbort.current = undefined;
      finishBulkJobCommand(requestId);
      if (ownsBulkJobRequest(requestId, owner)) {
        setBusyBulkAction(undefined);
        setBulkProgress(undefined);
      }
    }
  }

  function finishBulkJobCommand(requestId: number) {
    if (bulkJobCommandRequestId.current !== requestId) return;
    bulkJobCommandRequestId.current = undefined;
    setBulkJobCommand(undefined);
  }

  function clearTrackedJob() {
    bulkResumeAcknowledgement.current = undefined;
    setBulkJobStatusUnrecognized(false);
    setTrackedJob(undefined);
    setTrackedJobId(undefined);
    setBulkJobError(undefined);
    setBulkJobCommand(undefined);
    bulkJobCommandRequestId.current = undefined;
  }

  function clearActiveBulkJobId() {
    const storageError = user ? clearStoredActiveBulkJobId(user) : undefined;
    if (storageError) setBulkJobStorageError(storageError);
  }

  function dismissBulkJobSummary() {
    if (!isCurrentAgentScope() || busyBulkAction || bulkJobCommand || bulkJobStatusUnrecognized
      || trackedJob && (isJobPolling(trackedJob.status) || trackedJob.canResume
        || trackedJob.status === "waiting_authorization" || trackedJob.reconciliationRequired > 0 && !trackedJob.cancelRequested)) return;
    clearTrackedJob();
    clearActiveBulkJobId();
    setBulkProgress(undefined);
    setBulkResult(undefined);
    setRequestedPackageControlJobId(undefined);
    setLinkedJobError(undefined);
  }

  function handleAgentFilterChange(values: Partial<AgentFilterValues>) {
    if (values.search !== undefined && Object.keys(values).length === 1
      && (parseBulkRefSearch(values.search) ?? values.search.trim()) === normalizedQuery) {
      handleSearchQueryChange(values.search);
      return;
    }
    cancelAgentDetailRequest();
    setBulkConfirmation(undefined);
    setServerPackageSelection(undefined);
    if (values.search !== undefined) handleSearchQueryChange(values.search);
    if ("packageType" in values) setPackageType(values.packageType);
    if (values.endUserAccess !== undefined) setEndUserAccess(values.endUserAccess);
    if (values.reportedUsage !== undefined) setReportedUsage(values.reportedUsage);
    if (values.management !== undefined) setAgentManagement(values.management);
    if (values.relevance !== undefined) setAgentRelevance(values.relevance);
    if ("platform" in values) setPlatformFilter(values.platform);
    if ("availability" in values) setAvailableToFilter(values.availability);
    if ("host" in values) setHostFilter(values.host);
    if (values.status !== undefined) setStatusFilter(values.status);
    if (values.createdWithinDays !== undefined) setCreatedWithinDays(values.createdWithinDays);
    if ("publisher" in values) setPublisherFilter(values.publisher);
    if ("environmentId" in values) {
      setAgentEnvironmentFilter(values.environmentId);
      resetPowerPlatformSelection();
    }
    if (values.sortBy !== undefined) setAgentSortBy(values.sortBy);
    if (values.sortDirection !== undefined) setAgentSortDirection(values.sortDirection);
    setAgentPageIndex(0);
  }

  function handleClearAgentFilters() {
    cancelAgentDetailRequest();
    setBulkConfirmation(undefined);
    setServerPackageSelection(undefined);
    setPackageType(undefined);
    setEndUserAccess("all");
    setReportedUsage("all");
    setAgentManagement("all");
    setAgentRelevance("all");
    handleSearchQueryChange("");
    resetPowerPlatformSelection();
    setAgentEnvironmentFilter(undefined);
    setStatusFilter("all");
    setPublisherFilter(undefined);
    setAvailableToFilter(undefined);
    setHostFilter(undefined);
    setPlatformFilter(undefined);
    setCreatedWithinDays("");
    setAgentPageIndex(0);
  }

  function handleInventoryScopeChange(scope: UnifiedAgentInventoryScope) {
    if (scope === agentInventoryScope) return;
    handleClearAgentFilters();
    setAgentInventoryScope(scope);
    setSelectedAgentIds(new Set());
    setPendingStoredAgentSelectionCount(undefined);
    setSelectionRouteNotice(undefined);
    setExportChoiceOpen(false);
    const cached = agentInventoryQueries.getCached(principalKey, {
      inventoryScope: scope, sortBy: agentSortBy, sortDirection: agentSortDirection, limit: agentDisplayPageSize,
    });
    setUnifiedAgentPage(cached);
    setLoadingAgents(!cached);
    setAgentDetail(undefined);
    setAgentDetailError(undefined);
    setSelectedUnifiedAgent(undefined);
    setUnifiedAgentDetailPage(undefined);
    setAgentPackageSelection(undefined);
    setRequestedAgentDetailId(undefined);
    setSingleAccessAgentDetail(undefined);
    setBulkAccessAgentIds(undefined);
    setBulkConfirmation(undefined);
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
      value: current.value.map(record => projectVerifiedAgentMutation(record, changedAgentIds, { isBlocked: targetBlockedState })),
    } : current);
    setSelectedUnifiedAgent(current => current
      ? projectVerifiedAgentMutation(current, changedAgentIds, { isBlocked: targetBlockedState }) : current);
    setAgentDetail((current) =>
      current &&
      changedAgentIds.has(current.detail.id) &&
      current.detail.isBlocked !== targetBlockedState
        ? { ...current, detail: { ...current.detail, isBlocked: targetBlockedState } }
        : current,
    );
    setSingleAccessAgentDetail((currentDetail) =>
      currentDetail &&
      changedAgentIds.has(currentDetail.id) &&
      currentDetail.isBlocked !== targetBlockedState
        ? { ...currentDetail, isBlocked: targetBlockedState }
        : currentDetail,
    );
  }

  function toggleUnifiedAgentSelection(record: UnifiedAgentRecord) {
    setServerPackageSelection(undefined);
    setSelectionRouteNotice(undefined);
    const resource = record.powerPlatformResource;
    const observation = record.observations.powerPlatform;
    const nativeKey = resource ? quarantineTargetKey(resource) : undefined;
    const canSelectQuarantine = Boolean(canOperate && resource && !quarantineTargetReason(resource, observation));
    const quarantineSelected = nativeKey !== undefined && selectedPowerPlatformTargets.has(nativeKey);
    const grouped = record.packagesComplete === false;
    const ids = grouped ? [] : record.packages.map(item => item.id);
    const allSelected = (grouped ? selectedGroups.has(record.id) : ids.every(id => selectedAgentIds.has(id)))
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
    if (grouped && visibleUnifiedAgentPage?.selection) {
      if (!allSelected && selectedGroups.size >= 5000) {
        setSelectionRouteNotice({ tone: "error", text: "Select at most 5,000 agent groups. Mutation previews also enforce the 5,000-package target ceiling." });
        return;
      }
      const groups = new Set(selectedGroups);
      if (allSelected) groups.delete(record.id);
      else groups.add(record.id);
      setGroupPackageSelection({ id: visibleUnifiedAgentPage.selection.id, owner: principalKey, groups });
    }
    clearPackageSelection(user);
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
      && ownsAgentScope(owner)
      && (activeViewRef.current === "agents" || activeViewRef.current === "users" && userAgentOverlayRef.current);
  }

  function closeUnifiedAgentDetails() {
    cancelAgentDetailRequest();
    setAgentDetail(undefined);
    setSelectedUnifiedAgent(undefined);
    setAgentPackageSelection(undefined);
    setRequestedAgentDetailId(undefined);
    setAgentDetailError(undefined);
    setAgentOpenedFromUser(undefined);
    if (inlinePackageConfirmation) setBulkConfirmation(undefined);
  }

  function isCurrentAgentScope() {
    return agentScopeEpochRef.current === agentScopeEpoch;
  }

  function ownsAgentScope(owner: string) {
    return isCurrentAgentScope()
      && sessionOwnerRef.current === owner && !sessionRevalidationInFlight.current;
  }

  function ownsBulkJobRequest(requestId: number, owner: string) {
    return bulkJobPollRequestId.current === requestId && ownsAgentScope(owner);
  }

  function ownsPackageRefreshRequest(requestId: number, owner: string) {
    return packageRefreshRequestId.current === requestId
      && ownsAgentScope(owner);
  }

  function ownsInventoryRefreshRequest(requestId: number, owner: string) {
    return inventoryRefreshRequestId.current === requestId
      && ownsAgentScope(owner);
  }

  function scheduleAgentReload() {
    // Retire the consumer before clearing the cache can reject its pending read.
    agentListRequestId.current += 1;
    agentListAbortController.current?.abort();
    agentInventoryQueries.clear();
    setAgentReloadRevision(revision => revision + 1);
  }

  function requestCurrentAgentReload() {
    if (!isCurrentAgentScope()) return;
    setServerPackageSelection(undefined);
    setGroupPackageSelection(undefined);
    setGroupTargetCount(undefined);
    if (!busyBulkAction && (pendingSinglePreview.current || pendingBulkPreview.current
      || bulkConfirmation || bulkAccessAgentIds || singleAccessAgentDetail)) {
      cancelAgentDetailRequest();
      setPreparingBulkAction(undefined);
      setBulkConfirmation(undefined);
      setBulkAccessAgentIds(undefined);
      setBulkAccessSelection(undefined);
      setSingleAccessAgentDetail(undefined);
    }
    forceCurrentAgentReload.current = true;
    scheduleAgentReload();
  }

  function replaceCurrentAgentSelection() {
    if (!isCurrentAgentScope()) return;
    // Replacement may change membership. Retire targets and unsent previews first,
    // but keep the route, query and detail identity for the replacement read.
    setSelectedAgentIds(new Set());
    setSelectedPowerPlatformTargets(new Map());
    setSelectedPowerPlatformSnapshot(null);
    setBulkConfirmation(undefined);
    setBulkAccessSelection(undefined);
    setBulkAccessAgentIds(undefined);
    setSingleAccessAgentDetail(undefined);
    setInventoryExport(undefined);
    setExportChoiceOpen(false);
    clearPackageSelection(user);
    setServerPackageSelection(undefined);
    setGroupPackageSelection(undefined);
    setGroupTargetCount(undefined);
    requestCurrentAgentReload();
  }

  function handleQuarantineJobChange(job: QuarantineJob) {
    if (!ownsAgentScope(principalKey) || ["queued", "running"].includes(job.status)) return;
    const result = JSON.stringify([job.id, job.updatedAt, job.status]);
    if (observedQuarantineResults.current.has(result)) return;
    observedQuarantineResults.current.add(result);
    if (job.succeeded || job.skipped || job.inconclusive) requestCurrentAgentReload();
  }

  function handleInventoryExportInvalidation(error?: ApiError) {
    if (!inventoryExport || !ownsAgentScope(inventoryExport.owner)) return;
    agentInventoryQueries.invalidateSelection(inventoryExport.selectionId);
    if (inventoryExport.selectionId !== inventoryNavigation.current.selectionId) {
      setInventoryExport(undefined);
      setAgentExportError({ message: "The previous export selection changed or expired. Start a new export from the current inventory.", reloadRequired: false });
      return;
    }
    if (isExpiredSelection(error)) {
      setInventoryExport(undefined);
      setExpiredAgentSelection(inventoryExport.selectionId);
    } else clearAgentState();
    setAgentExportError({ message: "The saved inventory selection changed or expired. Reload inventory before exporting again.", reloadRequired: true });
  }

  function verifySavedAgentInventory() {
    setLoadingAgents(true);
    replaceCurrentAgentSelection();
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
        <header className="signin-header">
          <div className="signin-brand">
            <span className="brand-mark"><Bot size={21} aria-hidden="true" /></span>
            <h1>Agent Control</h1>
          </div>
          <span className="signin-platforms">Microsoft 365 &amp; Copilot Studio</span>
        </header>
        <div className="signin-content">
          <section className="signin-overview" aria-labelledby="signin-overview-title">
            <p className="eyebrow">Your agent administration workspace</p>
            <h2 id="signin-overview-title">Agent administration.<br /> A single workspace.</h2>
            <p className="signin-lede">
              Understand and manage your organization&apos;s AI agents,
              from adoption to access.
            </p>
            <ul className="signin-capabilities">
              <li>
                <span className="signin-capability-icon"><Bot size={20} aria-hidden="true" /></span>
                <div><h3>Know your agent inventory</h3><p>Discover agents, owners, and environments across Microsoft 365 and Copilot Studio.</p></div>
              </li>
              <li>
                <span className="signin-capability-icon"><BarChart3 size={20} aria-hidden="true" /></span>
                <div><h3>Understand adoption</h3><p>Review Copilot licenses, usage, and agent activity.</p></div>
              </li>
              <li>
                <span className="signin-capability-icon"><ShieldCheck size={20} aria-hidden="true" /></span>
                <div><h3>Manage access and investigate</h3><p>Control agent access and investigate activity with Purview and Defender.</p></div>
              </li>
            </ul>
          </section>
          <section className="signin-panel" aria-labelledby="signin-title">
            <div className="signin-panel-heading">
              <h2 id="signin-title">Sign in</h2>
              <p>Use your work or school account to continue.</p>
            </div>
            {authorizationNotice ? <p className="signin-notice" role="status">{authorizationNotice}</p> : null}
            {error ? <div className="error-banner" role="alert">{error}</div> : null}
            {bulkJobStorageError ? <div className="error-banner" role="status">{bulkJobStorageError}</div> : null}
            {authSetupError ? <p className="signin-notice" role="status">{authSetupError}</p> : null}
            {authSetup?.authConfigured === false ? <div className="error-banner"><strong>Sign-in is not configured.</strong><p>{authSetup.setup}</p><code>{authSetup.callback}</code></div> : null}
            <SignInForm disabled={authSetup?.authConfigured === false} />
            <div className="signin-trust">
              <ShieldCheck size={18} aria-hidden="true" />
              <p>Authentication is handled by Microsoft Entra ID. Your organization&apos;s access policies apply.</p>
            </div>
          </section>
        </div>
        <AppFooter />
      </main>
    );
  }

  return (
    <CapabilityContext key={principalKey} value={{ ...capabilityState, openPermissions: () => navigateToView("permissions") }}>
    <PublicationContext value={{ admit: automaticRefresh.admitPublication, revisions: automaticRefresh.publicationRevisions,
      usersRefresh: {
        checking: automaticRefresh.enabled && !automaticRefresh.paused && automaticRefresh.online && automaticRefresh.visible
          && automaticRefresh.sourceStates === undefined && automaticRefresh.phase === "checking",
        status: automaticRefresh.sourceStates?.users,
      } }}>
    <WorkbenchActionProvider value={workbenchMetadata?.actions}>
    <main className="app-shell">
      <BackgroundRefreshIndicator active={automaticRefresh.checking || loadingAgents} />
      <header className="top-bar">
        <div className="title-block">
          <span className="brand-mark"><Bot size={21} aria-hidden="true" /></span>
          <h1>Agent Control</h1>
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
              {visibleViews.includes("sync") ? <button type="button" className={visibleActiveView === "sync" ? "view-button active" : "view-button"} aria-current={visibleActiveView === "sync" ? "page" : undefined} onClick={() => navigateToView("sync")}>Sync{syncSetupRequired ? <small className="sync-setup-hint">Setup needed</small> : null}</button> : null}
              <CapabilityHealth current={visibleActiveView === "permissions"} />
        </nav>
        <div className="user-menu">
          <span className="account-name" title={user.username}>{user.displayName || user.username}</span>
          <button type="button" className="secondary account-signout" aria-label="Sign out" title="Sign out"
            disabled={signingOut} onClick={() => void handleSignOut()}>
            <LogOut size={17} aria-hidden="true" />
          </button>
        </div>
      </header>

      {hasRole(user, "AgentControl.Viewer") && visibleActiveView === "sync" ? <AutomaticRefreshStatus
        status={automaticRefresh}
        onOpenSync={() => navigateToView("sync")}
        onOpenPermissions={() => navigateToView("permissions")}
      /> : null}
      {error && !(visibleActiveView === "sync" && error === unifiedAgentReadError) ? <div className="error-banner">{error}</div> : null}
      {inventoryHistoryError ? <div className="error-banner" role="alert">{inventoryHistoryError}</div> : null}
      {bulkJobStorageError ? <div className="error-banner" role="status">{bulkJobStorageError}</div> : null}
      {hasRole(user, "AgentControl.Viewer") && visibleActiveView === "sync" ? (
        <AgentSyncTools
          inventory={unifiedAgentPage}
          inventoryUnavailable={inventoryUnavailable}
          verifyingInventory={loadingAgents || agentSearchPending}
          inventoryError={unifiedAgentReadError}
          operationError={error === unifiedAgentReadError ? undefined : error}
          powerPlatformHistoryError={inventoryHistoryError}
          onVerifyInventory={verifySavedAgentInventory}
          selectedPackageCount={groupCountPending ? 0 : matchingPackageSelection ? matchingPackageCount : selectedPackageCount}
          refreshingPackages={refreshingAgents}
          refreshingPowerPlatform={refreshingPowerPlatformAgents}
          inspectingPowerPlatformJob={Boolean(requestedPowerPlatformJobId)}
          exportingPowerPlatform={exportingPowerPlatformCsv}
          powerPlatformJob={powerPlatformAgentRefreshJob}
          onInspectPowerPlatformJob={selectPowerPlatformJob}
          onRefreshPackages={() => void handleRefreshAgents()}
          onRefreshMatchingDetails={() => void handleRefreshMatchingDetails()}
          onRefreshPowerPlatform={() => void handleRefreshPowerPlatformAgents()}
          onResumePowerPlatform={() => void handleResumePowerPlatformAgentRefresh()}
          onExportPowerPlatform={handleExportPowerPlatformAgentCsv}
          onOpenAgents={() => navigateToView("agents")}
        />
      ) : null}
      {hasRole(user, "AgentControl.Viewer") && visibleActiveView === "sync" ? (
        <CsvUsageReportsSection
          key={`csv-summary:${principalKey}`}
          principalKey={principalKey}
          revision={officialUsageDashboardRevision}
          canUploadUsage={canImportReports}
          onOpenUsageImport={() => openUsageImport()}
          onManageUsageReports={() => openUsageImport("manage")}
        />
      ) : null}
      {hasRole(user, "AgentControl.Viewer") ? (
        <DataSyncPanel
          ref={dataSyncPanelRef}
          principalKey={principalKey}
          canUploadUsage={canImportReports}
          active={visibleActiveView === "sync"}
          onOpenSync={visibleActiveView !== "sync" && visibleActiveView !== "permissions" ? () => navigateToView("sync") : undefined}
          automaticRefresh={automaticRefresh}
          onSetupStatusChange={handleSyncSetupStatusChange}
          onRunsChanged={handleSyncRunsChanged}
          requestedRunId={requestedDataSyncRunId}
          onOpenUsageImport={() => openUsageImport()}
          onRequestedRunChange={handleRequestedSyncRunChange}
          onSourcesChanged={handleDataSyncSourcesChanged}
          onCheckPublication={sources => {
            const inventorySources = sources.filter(source => source === "graph_packages" || source === "power_platform");
            if (inventorySources.length) {
              setPendingDataSyncPublication(current => ({
                owner: principalKey,
                sources: [...new Set([
                  ...(current?.owner === principalKey ? current.sources : []),
                  ...inventorySources,
                ])],
              }));
            }
            automaticRefresh.checkNow();
          }}
          onCancelRequested={() => automaticRefresh.setPaused(true)}
        />
      ) : null}
      {visibleActiveView === "sync" ? (
        <>
          {requestedPowerPlatformJobId ? <PowerPlatformSourceJob key={`${principalKey}:${requestedPowerPlatformJobId}`}
            jobId={requestedPowerPlatformJobId} initialJob={powerPlatformJobSelection.initialJob} onSelect={selectPowerPlatformJob}
            paused={refreshingPowerPlatformAgents}
            onCancelRequested={() => automaticRefresh.setPaused(true)}
            onObserved={handlePowerPlatformSourceJobObserved} /> : null}
          <LinkedAgentJobStatus refreshJob={visibleLinkedPackageRefreshJob} owner={principalKey} error={linkedPackageRefreshError}
            loadingRefreshStatus={linkedPackageRefreshLoading}
            waitingForRefreshStatus={waitingForLinkedPackageStatus}
            onRefreshStatus={requestedPackageRefreshJobId ? handleRefreshLinkedPackageStatus : undefined} />
          <SyncHistoryView key={principalKey} user={user} onOpenSyncRun={handleRequestedSyncRunChange}
            onOpenSourceJob={handleOpenSyncSourceJob} revision={syncHistoryRevision} />
        </>
      ) : null}
      {hasRole(user, "AgentControl.Viewer") ? (
        <OfficialUsageImportModal
          key={`usage-reports:${principalKey}`}
          route={visibleActiveView === "sync" ? syncReportRoute : undefined}
          onRouteChange={handleSyncReportRouteChange}
          canManage={canImportReports}
          revision={officialUsageDashboardRevision}
          onChanged={handleOfficialUsageChanged}
        />
      ) : null}

      {inventoryExport?.owner === principalKey ? <div hidden={visibleActiveView !== "agents"
        && !(inventoryExport.kind === "power_platform_agents" && visibleActiveView === "sync")}>
        <ReportExportButton key={inventoryExport.sequence}
          selectionId={inventoryExport.selectionId} kind={inventoryExport.kind} ids={inventoryExport.ids}
          label="Prepare inventory CSV" autoStart onSelectionInvalidated={handleInventoryExportInvalidation}
          onPendingChange={inventoryExport.kind === "power_platform_agents" ? setExportingPowerPlatformCsv : setExportingCsv} />
      </div> : null}
      {blockingWorkspace ? syncSetupStatus === "checking"
        && (visibleActiveView === "agents" || visibleActiveView === "users" || visibleActiveView === "audit")
        ? <WorkspaceSkeleton view={visibleActiveView} showSummary={visibleActiveView === "users" ? usersRoute.section !== "adoption" && usersRoute.view !== "activity"
          : visibleActiveView === "audit" || canReadSensitiveUsage} /> : null
        : visibleActiveView === "agents" && hasRole(user, "AgentControl.Viewer")
          && initialAgentReadOwner !== principalKey
          ? <WorkspaceSkeleton view="agents" showSummary={canReadSensitiveUsage} />
        : visibleActiveView === "permissions" ? <PermissionCenter /> : visibleActiveView === "agents" ? (
        !hasRole(user, "AgentControl.Viewer") ? (
          <>
            <LinkedAgentJobStatus refreshJob={visibleLinkedPackageRefreshJob} owner={principalKey} controlJob={requestedPackageControlJobId ? trackedJob : undefined} error={linkedPackageRefreshError ?? linkedJobError}
              loadingRefreshStatus={linkedPackageRefreshLoading}
              waitingForRefreshStatus={waitingForLinkedPackageStatus}
              onRefreshStatus={requestedPackageRefreshJobId ? handleRefreshLinkedPackageStatus : undefined} />
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
        <section className="agent-workspace" aria-label="Agent inventory">
          {linkedPackageRefreshError ? <div className="error-banner" role="alert">{linkedPackageRefreshError}</div> : null}
          {!canOperate ? <LinkedAgentJobStatus controlJob={requestedPackageControlJobId ? trackedJob : undefined} error={requestedPackageControlJobId ? linkedJobError : undefined} /> : null}
          <div className="agent-catalog-heading">
            <div className="agent-catalog-title">
              <h2 id="agents-heading" tabIndex={-1}>Agents <span>{visibleUnifiedAgentPage?.counts.filtered.toLocaleString() ?? "—"}{hasActiveAgentFilters && inventoryScopeCount !== undefined ? ` of ${inventoryScopeCount.toLocaleString()}` : ""}</span></h2>
            </div>
            {canReadSensitiveUsage ? <AgentInventoryScopes
              inventory={unifiedAgentReadError ? undefined : unifiedAgentPage}
              loading={agentInventoryPending}
              value={agentInventoryScope} onChange={handleInventoryScopeChange} /> : null}
            <div className="agent-catalog-actions">
              <span className="last-refresh" aria-live="polite">
                {refreshingAgents ? linkedPackageRefreshJob?.message ?? "Collecting agent identities and matching records; no agent settings are changed."
                  : inventoryUnavailable?.message ?? inventoryCollectionText}
              </span>
              {agentInventoryIssueSummary ? <button type="button" className="secondary inventory-attention"
                aria-label="Inventory needs attention · Open Sync" onClick={() => navigateToView("sync")} title={agentInventoryIssueSummary}>
                Inventory needs attention <ArrowRight size={12} aria-hidden="true" />
              </button> : null}
              <div className="agent-catalog-export">
                <span className="agent-refresh-indicator">
                  {agentInventoryPending ? <span role="status" aria-label="Updating agent results"
                    title="Updating agent results. Previous results remain visible until the current filters and sorting finish loading.">
                    <RefreshCw className="agent-refresh-spinner" size={18} aria-hidden="true" />
                    <span className="sr-only">Updating agent results...</span>
                  </span> : null}
                </span>
                <button
                  type="button"
                  className="secondary agent-export-button"
                  aria-label={exportingCsv ? "Exporting agent inventory CSV" : "Export agent inventory CSV"}
                  title={agentInventoryPending ? "Wait for saved agent inventory to finish loading" : inventoryUnavailable ? "Collect agent inventory before exporting" : !agentExportRevision ? "Reload saved agent inventory to obtain a valid export revision" : "Export unified agents from the current saved inventory"}
                  disabled={!canReadSensitiveUsage || loadingAgents || agentSearchPending || exportingCsv || !agentExportRevision || agentExportNeedsReload || (exportableAgentCount === 0 && selectedExportTargetCount === 0)}
                  onClick={requestExportCsv}
                >
                  <ExportIcon /> <span>Export</span>
                </button>
              </div>
            </div>
          </div>

          {canReadSensitiveUsage ? <AgentInventoryOverview key={principalKey}
            inventory={unifiedAgentReadError ? undefined : visibleUnifiedAgentPage} revision={inventoryReportRevision}
            reportPending={inventoryReportRevision !== officialUsageDashboardRevision}
            loadingInventory={agentInventoryPending}
            inventoryScope={agentInventoryScope}
            reportSelector={canImportReports ? <OfficialUsageReportSelector key={`agent-reports:${principalKey}`}
              principalKey={principalKey} revision={officialUsageDashboardRevision} onChanged={handleReportSetSelected} /> : undefined}
            allSelected={!hasActiveAgentFilters} onClearFilters={handleClearAgentFilters}
            endUserAccess={endUserAccess} reportedUsage={reportedUsage}
            onAccessChange={endUserAccess => handleAgentFilterChange({ endUserAccess })}
            onUsageChange={reportedUsage => handleAgentFilterChange({ reportedUsage })} /> : null}

          {showAgentExportError ? <div className="error-banner" role="alert">
            <span>{agentExportError?.message ?? (unifiedAgentReadError
              ? "The current saved agent inventory could not be loaded. Reload the saved inventory before exporting."
              : "A saved agent inventory revision is unavailable. Reload the saved inventory before exporting.")}</span>
            {agentExportNeedsReload ? <button type="button" className="secondary" disabled={loadingAgents} onClick={replaceCurrentAgentSelection}>Reload saved agent inventory</button> : null}
          </div> : null}
          {agentLeaseEnded && !unifiedAgentReadError ? <p className="sr-only" role="status">Refreshing saved inventory...</p> : null}
          {matchingPackageSelection ? <p className="selection-summary">Server selection · no target list downloaded · maximum 5,000 targets per job</p> : null}
          {groupTargetKey && groupCount?.error ? <div role="alert">
            <p>{groupCount.error}</p>
            <button type="button" className="secondary" onClick={() => {
              if (!ownsAgentScope(principalKey) || groupCountRetryPending.current) return;
              groupCountRetryPending.current = true;
              setGroupTargetCount(undefined);
              setGroupCountRetryRevision(value => value + 1);
            }}>Retry selected package count</button>
          </div>
            : groupCountPending ? <p role="status">Counting selected package targets...</p> : null}
          {canOperate && ((!groupCountPending && (matchingPackageCount > 0 || selectedPackageCount > 0)) || busyBulkAction || bulkProgress || bulkResult || trackedJob || bulkJobCommand || bulkJobError || (requestedPackageControlJobId && linkedJobError)) ? <BulkActions
            disabled={
              groupCountPending || agentLeaseEnded || Boolean(matchingPackageSelection && (loadingAgents || agentSearchPending || unifiedAgentReadError)) || Boolean(busyAgentId) || Boolean(busyBulkAction) || Boolean(bulkJobCommand)
            }
            busyAction={busyBulkAction}
            preparingAction={preparingBulkAction}
            progress={bulkProgress}
            result={bulkResult}
            job={trackedJob}
            jobId={trackedJobId}
            jobCommand={bulkJobCommand}
            jobError={bulkJobError ?? (requestedPackageControlJobId ? linkedJobError : undefined)}
            statusUnrecognized={bulkJobStatusUnrecognized}
            selectedCount={groupCountPending ? 0 : matchingPackageSelection ? matchingPackageCount : selectedPackageCount}
            onBlockAll={() => void requestBulkAction(true)}
            onManageAccess={requestBulkAccessUpdate}
            onUnblockAll={() => void requestBulkAction(false)}
            onJobCommand={operation => void handleBulkJobCommand(operation)}
            onDismiss={dismissBulkJobSummary}
          /> : null}
          {selectionRouteNotice ? (
            <div className={selectionRouteNotice.tone === "error" ? "error-banner" : "report-status"} role="status">
              {selectionRouteNotice.text}
            </div>
          ) : null}

          {canOperate && (selectedPowerPlatformTargets.size > 0 || pendingPowerPlatformIds.size > 0 || requestedQuarantineJobId || quarantineReceiptPending) ? <CopilotStudioQuarantineControls
            snapshot={selectedQuarantineObservation}
            targets={[...selectedPowerPlatformTargets.values()]}
            variant="bulk"
            canManage={canOperate}
            pendingTargetCount={pendingPowerPlatformIds.size}
            onClear={() => { if (ownsAgentScope(principalKey)) resetPowerPlatformSelection(); }}
            initialJobId={requestedQuarantineJobId}
            onReceiptPendingChange={pending => {
              if (ownsAgentScope(principalKey)) setQuarantineReceiptPending(pending);
            }}
            onJobChange={job => {
              if (!ownsAgentScope(principalKey)) return;
              setRequestedQuarantineJobId(job.id);
              handleQuarantineJobChange(job);
            }}
          /> : null}

            <div className="agent-table-stack" aria-busy={agentInventoryPending}>
              <UnifiedAgentTable
                records={displayedUnifiedAgents}
                loading={agentInventoryPending && displayedUnifiedAgents.length === 0}
                loadingMessage={publishingAgentInventory
                  ? "Publishing synced agents to the inventory..."
                  : "Loading Copilot agents..."}
                emptyState={inventoryUnavailable ? <div role="status">
                  <h2>{inventoryUnavailable.state === "preparing" ? "Preparing agent inventory"
                    : inventoryUnavailable.state === "unavailable" ? "Saved agent inventory unavailable" : "No saved agent inventory yet"}</h2>
                  <p>{inventoryUnavailable.message}</p>
                  <button type="button" className="secondary" onClick={() => navigateToView("sync")}>Open Sync</button>
                </div> : unifiedAgentReadError ? <>
                  <h2>Agent inventory unavailable</h2><p>Reload saved inventory or open Sync to review source status.</p>
                </> : !hasActiveAgentFilters ? <>
                  <h2>No agents in this inventory</h2><p>The saved inventory contains no agents in this scope.</p>
                </> : undefined}
                controls={<AgentInventoryFilters key={principalKey}
                  selectionId={unifiedAgentPage?.selection?.id}
                  readOwnerKey={principalKey}
                  onInvalidated={() => {
                    if (unifiedAgentPage?.selection.id === inventoryNavigation.current.selectionId) invalidateAgentSelection();
                  }}
                  values={{ search: query, packageType, endUserAccess, reportedUsage, management: agentManagement, relevance: agentRelevance,
                    platform: effectivePlatformFilter, availability: availableToFilter,
                    host: hostFilter, status: statusFilter, createdWithinDays, publisher: publisherFilter,
                    environmentId: agentEnvironmentFilter, sortBy: agentSortBy, sortDirection: agentSortDirection }}
                  options={{ platforms: platformOptions, availability: availableToOptions, hosts: hostOptions,
                    publishers: publisherOptions, environments: [],
                    types: [] }}
                  matchingCount={unifiedAgentReadError ? undefined : visibleUnifiedAgentPage?.counts.filtered}
                  loading={agentInventoryPending}
                  onChange={handleAgentFilterChange} onClear={handleClearAgentFilters} onError={(message, readSelectionId) => {
                    if (readSelectionId === undefined || readSelectionId === inventoryNavigation.current.selectionId) setError(message);
                  }} />}
                selectionAction={canOperate && (visibleUnifiedAgentPage?.counts.packageTargets ?? 0) > 0 ? <button type="button"
                  className="secondary agent-match-select" aria-pressed={Boolean(matchingPackageSelection)}
                  aria-label={matchingPackageSelection ? "Clear all-matching package selection"
                    : `Select all ${visibleUnifiedAgentPage?.counts.packageTargets} matching published versions`}
                  title="Server selection; maximum 5,000 targets per mutation job."
                  disabled={loadingAgents || agentSearchPending || Boolean(unifiedAgentReadError) || Boolean(busyBulkAction)}
                  onClick={() => {
                    clearPackageSelection(user);
                    setSelectionRouteNotice(undefined);
                    if (matchingPackageSelection) setServerPackageSelection(undefined);
                    else if (visibleUnifiedAgentPage?.selection) {
                      setSelectedAgentIds(new Set());
                      setGroupPackageSelection(undefined);
                      setServerPackageSelection({ id: visibleUnifiedAgentPage.selection.id, owner: principalKey });
                    }
                  }}>{matchingPackageSelection ? "Clear matching" : `Select all ${visibleUnifiedAgentPage?.counts.packageTargets.toLocaleString()}`}</button> : null}
                columnPreferenceOwner={user ? JSON.stringify([user.tenantId ?? "", user.homeAccountId]) : undefined}
                sortBy={agentSortBy}
                sortDirection={agentSortDirection}
                onSortChange={(sortBy, sortDirection) => handleAgentFilterChange({ sortBy, sortDirection })}
                usageContext={unifiedAgentPage?.usageContext}
                busyPackageId={busyAgentId}
                selectedPackageIds={selectedAgentIds}
                selectedPackageCount={groupCountPending ? 0 : matchingPackageSelection ? matchingPackageCount : selectedPackageCount}
                allPackagesSelected={Boolean(matchingPackageSelection)}
                selectedRecordIds={new Set(selectedGroups.keys())}
                selectedPowerPlatformKeys={new Set(selectedPowerPlatformTargets.keys())}
                packageSelectionAllowed
                packageOperationsAllowed={canOperate && !agentLeaseEnded}
                quarantineSelectionAllowed={canOperate && !agentLeaseEnded}
                quarantineSelectionRestoring={pendingPowerPlatformIds.size > 0}
                selectionDisabled={agentLeaseEnded || loadingAgents || agentSearchPending || Boolean(busyBulkAction) || refreshingAgents}
                packageActionsDisabled={agentLeaseEnded || Boolean(busyBulkAction) || refreshingAgents || bulkJobStatusUnrecognized}
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
              {visibleUnifiedAgentPage && !unifiedAgentReadError ? <nav aria-label="Agent inventory pages" className="agent-inventory-pagination" aria-busy={loadingAgents || agentSearchPending}>
                <span role="status">{visibleUnifiedAgentPage.value.length.toLocaleString()} shown · {visibleUnifiedAgentPage.counts.filtered.toLocaleString()} matching agents</span>
                <div className="agent-inventory-page-actions">
                  <button type="button" className="secondary" disabled={agentLeaseEnded || loadingAgents || agentSearchPending || !visibleUnifiedAgentPage.page.previousCursor}
                    onClick={() => { if (!selectedReadRemaining(visibleUnifiedAgentPage.selection)) return;
                      inventoryNavigation.current.cursor = visibleUnifiedAgentPage.page.previousCursor ?? undefined;
                      setAgentPageIndex(index => Math.max(0, index - 1)); }}>Previous</button>
                  <button type="button" className="secondary" disabled={agentLeaseEnded || loadingAgents || agentSearchPending || !visibleUnifiedAgentPage.page.nextCursor}
                    onClick={() => { if (!selectedReadRemaining(visibleUnifiedAgentPage.selection)) return;
                      inventoryNavigation.current.cursor = visibleUnifiedAgentPage.page.nextCursor ?? undefined;
                      setAgentPageIndex(index => index + 1); }}>Next</button>
                </div>
              </nav> : null}
            </div>
        </section>
        )
      ) : visibleActiveView === "users" ? (
        <CopilotUsersView
          key={`users:${principalKey}`}
          dataRevision={copilotUsersDataRevision}
          route={usersRoute}
          onRouteChange={handleUsersRouteChange}
          reportSelector={canImportReports ? <OfficialUsageReportSelector key={`user-reports:${principalKey}`}
            principalKey={principalKey} revision={officialUsageDashboardRevision} onChanged={handleReportSetSelected} /> : undefined}
          onOpenAgent={id => {
            if (!ownsAgentScope(principalKey)) return;
            agentDetailReturnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
            cancelAgentDetailRequest();
            setAgentOpenedFromUser(id);
            setAgentDetail(undefined);
            setAgentDetailError(undefined);
            setSelectedUnifiedAgent(undefined);
            setAgentPackageSelection(undefined);
            setUnifiedAgentPage(undefined);
            setUnifiedAgentDetailPage(undefined);
            requestCurrentAgentReload();
            setAgentDetailTab("identities");
            setRequestedAgentDetailId(id);
          }}
        />
      ) : visibleActiveView === "audit" ? (
        <AuditLogView key={principalKey} agents={agents} />
      ) : visibleActiveView === "sync" ? null : <div className="screen-state">No Agent Control app role is assigned.</div>}

      {userAgentOverlay && !selectedUnifiedAgent ? <WorkbenchDialog open title="Agent details"
        fallbackFocusRef={agentDetailReturnFocus} onClose={closeUnifiedAgentDetails}>
        {agentDetailError || unifiedAgentReadError ? <div role="alert">
          <p>{agentDetailError ?? unifiedAgentReadError}</p>
          <button type="button" onClick={() => {
            setAgentDetailError(undefined);
            setRequestedAgentDetailId(agentOpenedFromUser);
            replaceCurrentAgentSelection();
          }}>Retry agent details</button>
        </div> : inventoryUnavailable ? <p role="status">{inventoryUnavailable.message}</p>
          : <p role="status">Loading agent details...</p>}
      </WorkbenchDialog> : null}

      {!userAgentOverlay && (loadingAgentDetailId || loadingUnifiedAgentDetail) ? (
        <div className="detail-loading" role="status" aria-live="polite">
          Loading agent details...
        </div>
      ) : null}

      {!userAgentOverlay && agentDetailError && !agentDetail && !selectedUnifiedAgent ? (
        <div className="error-banner" role="alert">{agentDetailError}</div>
      ) : null}

      {!blockingWorkspace && selectedUnifiedAgent && !singleAccessAgentDetail && !bulkAccessAgentIds && (!bulkConfirmation || inlinePackageConfirmation) ? (
        <UnifiedAgentDetailModal
          selectionId={unifiedAgentDetailPage?.sourcePage?.selection?.id}
          key={principalKey}
          returnFocusTo={userAgentOverlay ? agentDetailReturnFocus : undefined}
          record={selectedUnifiedAgent}
          onOpenPerson={personId => {
            if (!ownsAgentScope(principalKey)) return;
            navigateToView("users");
            handleUsersRouteChange({ view: "licenses", detailId: personId, detailTab: "responsibility", search: "", page: 0 }, true);
          }}
          usageContext={unifiedAgentDetailPage?.sourcePage?.usageContext}
          inventoryRevision={unifiedAgentDetailPage?.sourcePage?.selection.revision}
          inventoryError={unifiedAgentReadError}
          onInventoryInvalidated={selectionId => {
            if (ownsAgentScope(principalKey) && selectionId === inventoryNavigation.current.selectionId) invalidateAgentSelection();
          }}
          onRetryInventory={replaceCurrentAgentSelection}
          onUsageChanged={() => {
            if (ownsAgentScope(principalKey)) requestCurrentAgentReload();
          }}
          onPeopleChanged={() => {
            if (ownsAgentScope(principalKey)) requestCurrentAgentReload();
          }}
          onQuarantineJobChange={handleQuarantineJobChange}
          dataRevision={officialUsageDashboardRevision}
          activeTab={agentDetailTab}
          onTabChange={tab => {
            if (busyAgentId) cancelAgentDetailRequest();
            setAgentDetailTab(tab);
          }}
          roles={user?.roles ?? []}
          onClose={closeUnifiedAgentDetails}
          onInspectPackage={item => {
            if (!isCurrentAgentScope()) return;
            setAgentPackageSelection({ owner: principalKey, recordId: selectedUnifiedAgent.id, packageId: item.id });
            void handleViewAgentDetails(item);
          }}
          selectedPackageId={agentPackageSelection?.owner === principalKey && agentPackageSelection.recordId === selectedUnifiedAgent.id
            ? agentPackageSelection.packageId : undefined}
          packageDetail={selectedUnifiedAgent.packages.some(item => item.id === agentDetail?.id) ? agentDetail : undefined}
          packageDetailStale={Boolean(savedAgentDetail) && savedAgentDetail?.selectionId !== unifiedAgentDetailPage?.sourcePage?.selection.id}
          packageInventoryPending={loadingAgents || unifiedAgentDetailPage?.listPage !== unifiedAgentPage}
          packageDetailLoading={Boolean(loadingAgentDetailId)}
          packageDetailError={agentDetailError}
          packageActionsBusy={Boolean(busyAgentId || busyBulkAction || refreshingAgents)}
          packageActionsBlockedReason={agentLeaseEnded ? "Refreshing saved inventory..." : bulkJobStatusUnrecognized ? jobStatusMessage(undefined) : undefined}
          onUpdatePackageAccess={handleInlineAccessUpdate}
          packageAccessRevisions={packageAccessRevisions}
          packageControlError={packageControlError}
          packageResults={bulkResult?.results}
          onCancelPackageConfirmation={() => setBulkConfirmation(undefined)}
          packageConfirmation={inlinePackageConfirmation && bulkConfirmation ? <BulkConfirmModal
            confirmation={bulkConfirmation} inline
            disabled={agentLeaseEnded}
            onCancel={() => setBulkConfirmation(undefined)}
            onConfirm={() => void runConfirmedBulkAction(bulkConfirmation)}
          /> : undefined}
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
            cancelAgentDetailRequest();
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
          agentCount={bulkAccessSelection?.count ?? bulkAccessAgentIds.length}
          onCancel={() => {
            cancelAgentDetailRequest();
            setBulkAccessAgentIds(undefined);
            setBulkAccessSelection(undefined);
          }}
          onSubmit={runBulkAccessUpdate}
        />
      ) : null}

      {bulkConfirmation && !inlinePackageConfirmation ? (
        <BulkConfirmModal
          confirmation={bulkConfirmation}
          disabled={agentLeaseEnded}
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
          disabled={loadingAgents || agentSearchPending || !agentExportRevision || agentExportNeedsReload}
          onCancel={() => setExportChoiceOpen(false)}
          onClearSelection={() => {
            setSelectedAgentIds(new Set());
            setServerPackageSelection(undefined);
            setGroupPackageSelection(undefined);
            setGroupTargetCount(undefined);
            setPendingStoredAgentSelectionCount(undefined);
            resetPowerPlatformSelection();
            setSelectionRouteNotice(undefined);
            clearPackageSelection(user);
          }}
          onExport={scope => void handleExportCsv(scope)}
        />
      ) : null}

      <AppFooter />
    </main>
    </WorkbenchActionProvider>
    </PublicationContext>
    </CapabilityContext>
  );
}

export type BulkConfirmation = {
  action: AuditAction;
  ids: string[];
  recordIds?: string[];
  selectionId?: string;
  mutationScope: "single" | "bulk";
  preview: PackageMutationPreview;
  accessUpdate?: PackageAccessUpdate;
  returnFocusTo?: HTMLElement;
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

function activeBulkJobStorageKey(user: SessionUser) {
  return `${activeBulkJobStoragePrefix}${encodeURIComponent(user.tenantId ?? "")}:${encodeURIComponent(user.homeAccountId)}`;
}

function loadStoredActiveBulkJobId(user: SessionUser): { jobId?: string; error?: string } {
  if (typeof window === "undefined") {
    return {};
  }

  try {
    return { jobId: window.localStorage.getItem(activeBulkJobStorageKey(user)) ?? undefined };
  } catch {
    return { error: "Unable to read the saved package job from browser storage. Open its saved /agents?controlJob=<job-id> link to recover it." };
  }
}

function saveStoredActiveBulkJobId(user: SessionUser, jobId: string) {
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(activeBulkJobStorageKey(user), jobId);
    } catch {
      return `Unable to save the active package job in browser storage. Tracking continues in this tab; bookmark /agents?controlJob=${encodeURIComponent(jobId)} to reopen it.`;
    }
  }
}

function clearStoredActiveBulkJobId(user: SessionUser) {
  if (typeof window !== "undefined") {
    try {
      window.localStorage.removeItem(activeBulkJobStorageKey(user));
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
  inline = false,
  disabled = false,
}: {
  confirmation: BulkConfirmation;
  onCancel: () => void;
  onConfirm: () => void;
  inline?: boolean;
  disabled?: boolean;
}) {
  const { summary } = confirmation.preview;
  const isBlockAction = summary.operation === "block" || summary.operation === "unblock";
  const isBlocking = summary.operation === "block";
  const actionLabel = isBlockAction
    ? isBlocking ? "Block" : "Unblock"
    : formatDetailLabel(summary.operation) ?? summary.operation;
  const targetLabel = summary.targetCount === 1 ? "package" : `${summary.targetCount.toLocaleString()} packages`;
  const panel = useRef<HTMLElement>(null);
  const activeConfirmation = useRef<BulkConfirmation | undefined>(confirmation);
  useLayoutEffect(() => {
    activeConfirmation.current = confirmation;
    return () => { activeConfirmation.current = undefined; };
  }, [confirmation]);

  function cancel() {
    if (activeConfirmation.current !== confirmation) return;
    activeConfirmation.current = undefined;
    onCancel();
  }

  function confirm() {
    if (disabled || activeConfirmation.current !== confirmation) return;
    activeConfirmation.current = undefined;
    onConfirm();
  }

  useEffect(() => {
    const previouslyFocused = confirmation.returnFocusTo ?? document.activeElement;
    panel.current?.focus();
    return () => {
      if (previouslyFocused instanceof HTMLElement && previouslyFocused.isConnected) previouslyFocused.focus();
    };
  }, [inline, confirmation.returnFocusTo]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        if (inline) {
          event.preventDefault();
          event.stopPropagation();
        }
        if (activeConfirmation.current !== confirmation) return;
        activeConfirmation.current = undefined;
        onCancel();
      } else if (!inline) {
        trapDialogFocus(event, panel.current);
      }
    }

    window.addEventListener("keydown", handleKeyDown);

    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [confirmation, inline, onCancel]);

  const technicalDetails = <>
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
  </>;

  const content = (
      <section
        ref={panel}
        className={`confirm-modal${inline ? " inline-package-confirmation" : ""}${isBlockAction ? " block-confirmation" : ""}`}
        role={inline ? "region" : "dialog"}
        aria-modal={inline ? undefined : true}
        aria-labelledby="bulk-confirm-title"
        aria-describedby={isBlockAction ? "block-confirm-impact" : undefined}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        {isBlockAction ? <>
          <div className="block-confirm-heading">
            <span className={`block-confirm-icon${isBlocking ? " is-blocking" : ""}`}>
              {isBlocking ? <Ban size={22} aria-hidden="true" /> : <CircleCheck size={22} aria-hidden="true" />}
            </span>
            <h2 id="bulk-confirm-title">{actionLabel} {targetLabel}?</h2>
          </div>
          <p id="block-confirm-impact" className="block-confirm-impact">
            {isBlocking
              ? `Users won't be able to use ${summary.targetCount === 1 ? "this package" : "these packages"}.`
              : `Users with access will be able to use ${summary.targetCount === 1 ? "this package" : "these packages"} again.`}
          </p>
          <ul className={`block-confirm-targets${summary.targets.length > 1 ? " is-multiple" : ""}`} aria-label="Package changes" tabIndex={summary.targets.length > 1 ? 0 : undefined}>
            {summary.targets.map(target => (
              <li key={target.id}>
                <div className="block-confirm-name">
                  <strong>{target.displayName}</strong>
                  {summary.targets.some(other => other.id !== target.id && other.displayName === target.displayName)
                    ? <small>{target.id}</small> : null}
                </div>
                <div className="block-confirm-state">
                  <span><span className="sr-only">Current: </span>{formatPackageBlockState(target.currentState.isBlocked)}</span>
                  <ArrowRight size={14} aria-hidden="true" />
                  <strong className={target.requestedState.isBlocked === true ? "is-blocked" : target.requestedState.isBlocked === false ? "is-unblocked" : undefined}>
                    <span className="sr-only">Requested: </span>{formatPackageBlockState(target.requestedState.isBlocked)}
                  </strong>
                </div>
              </li>
            ))}
          </ul>
          {summary.additionalTargetCount > 0 ? <p className="block-confirm-hint">
            Showing {summary.targets.length.toLocaleString()} of {summary.targetCount.toLocaleString()} packages.
            {" "}All {summary.targetCount.toLocaleString()} are included in the request. Individual changes may fail or be skipped.
          </p> : null}
          <p className="block-confirm-hint">
            Availability and installation settings won't change. You can {isBlocking ? "unblock" : "block"} {summary.targetCount === 1 ? "it" : "them"} later.
          </p>
          <p className="block-confirm-preview">Uses a Microsoft Graph preview API.</p>
          <details className="block-confirm-details">
            <summary>Technical details</summary>
            <div>
              <p>Each package is checked again before applying the change. If its block state has changed, that package won't be updated.</p>
              {technicalDetails}
            </div>
          </details>
        </> : <>
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
        {technicalDetails}
        {summary.additionalTargetCount > 0 ? (
          <p className="confirm-muted">
            {summary.additionalTargetCount} more exact package targets are included in the hashed selection.
          </p>
        ) : null}
        </>}
        {disabled ? <p role="status">This saved selection lease ended. Reload saved inventory before confirming an action.</p> : null}
        <div className="confirm-actions">
          <button type="button" className="secondary" onClick={cancel}>
            Cancel
          </button>
          <WorkbenchActionGate actionId={confirmation.accessUpdate ? "packages.access" : summary.operation === "block" ? "packages.block" : "packages.unblock"}>
          <button
            type="button"
            className={summary.operation === "block" || confirmation.accessUpdate?.scope === "none" ? "danger" : undefined}
            onClick={confirm}
            disabled={disabled}
          >
            {isBlockAction ? `${actionLabel} ${targetLabel}` : `Confirm ${actionLabel.toLowerCase()}`}
          </button>
          </WorkbenchActionGate>
        </div>
      </section>
  );
  return inline ? content : <div className="modal-backdrop" role="presentation" onClick={cancel}>{content}</div>;
}

function formatPackageBlockState(isBlocked: unknown) {
  return isBlocked === true ? "Blocked" : isBlocked === false ? "Not blocked" : "Unknown";
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
  const panel = useRef<HTMLElement>(null);

  useEffect(() => {
    const previouslyFocused = document.activeElement;
    panel.current?.focus();
    return () => {
      if (previouslyFocused instanceof HTMLElement && previouslyFocused.isConnected) previouslyFocused.focus();
    };
  }, []);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onCancel();
      } else {
        trapDialogFocus(event, panel.current);
      }
    }

    window.addEventListener("keydown", handleKeyDown);

    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onCancel]);

  return (
    <div className="modal-backdrop" role="presentation" onClick={onCancel}>
      <section
        ref={panel}
        className="confirm-modal export-choice-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="export-choice-title"
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        <div>
          <p className="eyebrow">Export agents</p>
          <h2 id="export-choice-title">Export agent inventory</h2>
        </div>
        <p>
          Prepare a saved-selection CSV with one agent row and separate source and child rows.
          All package IDs, configuration, and partial-inventory status are retained without
          expanding high-fanout collections in the browser. The server checks your current
          authorization throughout preparation and download. Completed files expire automatically.
        </p>
        <div className="export-choice-grid">
          <button
            type="button"
            className="secondary export-choice-card"
            disabled={disabled || agentCount === 0}
            onClick={() => onExport("matching")}
          >
            <strong>Download matching agents</strong>
            <span>Export all {agentCount.toLocaleString()} {isFiltered ? "filtered" : "saved"} agents across all pages, using the current filters and sorting.</span>
            <small>Not limited to the displayed page or the 5,000-target mutation limit.</small>
          </button>
          <button
            type="button"
            className="secondary export-choice-card"
            disabled={disabled || selectionRestoring || selectedTargetCount === 0 || selectedTargetCount > 5000}
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
    if (error.code === "selection_invalidated" && error.message === error.code) {
      return "The saved inventory selection is no longer available. Reload saved inventory.";
    }
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

function isAccessDenied(error: unknown) {
  return error instanceof ApiError && (error.status === 401 || error.status === 403);
}

export default App;
