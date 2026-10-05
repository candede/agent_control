import {
  useCallback,
  useDeferredValue,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
} from "react";
import { InventoryRefreshTargets } from "./components/InventoryRefreshTargets";
import {
  ArrowRight,
  Ban,
  Bot,
  CircleCheck,
  ExternalLink,
  Globe2,
  LogOut,
  RefreshCw,
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
  startSignIn,
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
  type SessionUser,
  type UnifiedAgentInventoryPage,
  type UnifiedAgentRecord,
  type UnifiedAgentInventoryQuery,
} from "./api/client";
import { selectedAgentExportReferences, type UnifiedAgentExportScope } from "./agentExport";
import { ReportExportButton } from "./components/ReportExportButton";
import "./App.css";
import { isJobPolling, jobStatusMessage } from "./jobStatus";
import { parseBulkRefSearch } from "./bulkRefSearch";
import { projectVerifiedAccessScope } from "./packageMutationState";
import { clearPackageSelection, restorePackageSelection, storePackageSelection } from "./packageSelectionSession";
import { allowedViews, hasRole } from "./authorization";
import { useCapabilities } from "./useCapabilities";
import { useAutomaticRefresh } from "./useAutomaticRefresh";
import { AutomaticRefreshStatus } from "./components/AutomaticRefreshStatus";
import { BackgroundRefreshIndicator } from "./components/BackgroundRefreshIndicator";
import { parseUnifiedAgentRecordId, unifiedAgentRecordId, type UnifiedAgentInventoryScope, type UnifiedAgentInventoryUnavailable, type UnifiedAgentSort } from "../../backend/src/types/unifiedAgents";
import { inventoryScopeAgentCount } from "./agentColumns";
import { AgentInventoryQueries } from "./agentInventoryQueries";
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
import { AuditLogView } from "./components/AuditLogView";
import { BulkActions, type BulkProgress, type BulkJobCommand } from "./components/BulkActions";
import { AgentInventoryOverview, AgentInventoryScopes } from "./components/AgentInventoryOverview";
import { AgentInventoryFilters, type AgentFilterValues } from "./components/AgentInventoryFilters";
import { CopilotUsersView } from "./components/CopilotUsersView";
import { CopilotStudioQuarantineControls } from "./components/CopilotStudioQuarantineControls";
import { OfficialUsageImportModal } from "./components/OfficialUsageImportModal";
import { OfficialUsageReportSelector } from "./components/OfficialUsageReportSelector";
import { CsvUsageReportsSection } from "./components/CsvUsageReportsSection";
import { DataSyncPanel, type DataSyncPanelHandle } from "./components/DataSyncPanel";
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
import { WorkbenchActionGate, WorkbenchActionProvider } from "./workbenchActionContext";
import { SavedQueryProvider } from "./components/SavedQueryProvider";
import { createSavedQueryClient, readSavedQuery } from "./savedQueries";
import { trapDialogFocus } from "./dialogFocus";
import "./components/agentWorkspace.css";

const activeBulkJobStoragePrefix = "agent-control:active-bulk-job:v2:";
const bulkJobPollIntervalMs = 1_000;
const packageRefreshPollIntervalMs = 750;
const inventoryRefreshPollIntervalMs = 1_000;
const foregroundJobPollBudgetMs = 5 * 60_000;
const agentDisplayPageSize = 50;

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
}: {
  controlJob?: BulkActionJob;
  error?: string;
  refreshJob?: PackageRefreshJob;
  owner?: string;
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
  if (jobsRedirect) window.history.replaceState({ view: "sync" }, "", jobsRedirect);
  const securityRedirect = migrateSecurityRoute(window.location.pathname);
  if (securityRedirect) window.history.replaceState({ view: "agents" }, "", securityRedirect);
  const reports = migrateOfficialUsageRoute(window.location.pathname, window.location.search);
  if (reports) window.history.replaceState({ view: "sync" }, "", workbenchUrl("sync", reports));
  const syncRoute = parseDataSyncRoute(window.location.search);
  if (parseWorkbenchView(window.location.pathname) === "agents" && (syncRoute.syncRunId || (syncRoute.refreshJobId && !parseAgentRoute(window.location.search).controlJobId))) {
    window.history.replaceState({ view: "sync" }, "", workbenchUrl("sync", dataSyncRouteSearch(syncRoute)));
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

function SignInForm({ disabled }: { disabled: boolean }) {
  const [username, setUsername] = useState("");
  const [validationError, setValidationError] = useState<string>();
  const [signInError, setSignInError] = useState<string>();
  const [pending, setPending] = useState(false);
  const usernameInput = useRef<HTMLInputElement>(null);
  const request = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => request.current?.abort(), []);

  async function handleSubmit() {
    if (disabled || request.current) return;
    const value = username.trim();
    setSignInError(undefined);
    if (!value || value.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
      setValidationError("Enter your work or school username, such as name@organization.com.");
      usernameInput.current?.focus();
      return;
    }
    setValidationError(undefined);
    const controller = new AbortController();
    request.current = controller;
    setPending(true);
    const search = new URLSearchParams(window.location.search);
    search.delete("authorization");
    search.delete("returnTo");
    const returnTo = isWorkbenchPath(window.location.pathname) && !window.location.pathname.startsWith("//")
      ? `${window.location.pathname}${search.size ? `?${search}` : ""}` : "/agents";
    try {
      const { authorizationUrl } = await startSignIn({ username: value, returnTo }, { signal: controller.signal });
      if (!controller.signal.aborted) window.location.assign(authorizationUrl);
    } catch (requestError) {
      if (controller.signal.aborted) return;
      setSignInError(requestError instanceof Error ? requestError.message : "Unable to start sign-in. Please try again.");
      setPending(false);
      request.current = undefined;
    }
  }

  return (
    <form className="signin-form" aria-label="Sign in" aria-busy={pending} noValidate onSubmit={event => {
      event.preventDefault();
      void handleSubmit();
    }}>
      <label htmlFor="signin-username">Work or school username</label>
      <input
        ref={usernameInput}
        id="signin-username"
        name="username"
        type="email"
        inputMode="email"
        autoComplete="username"
        autoCapitalize="none"
        spellCheck={false}
        maxLength={320}
        required
        disabled={disabled || pending}
        aria-invalid={Boolean(validationError)}
        aria-describedby={`signin-hint${validationError || signInError ? " signin-error" : ""}`}
        value={username}
        onChange={event => {
          setUsername(event.target.value);
          setValidationError(undefined);
          setSignInError(undefined);
        }}
      />
      <p id="signin-hint" className="signin-hint">
        Use your organization&apos;s email address. You&apos;ll continue to Microsoft to sign in.
      </p>
      {validationError || signInError ? <div id="signin-error" className="error-banner" role="alert">{validationError ?? signInError}</div> : null}
      <button className="signin-button" type="submit" disabled={disabled || pending}>
        {pending ? "Preparing sign-in..." : "Sign in with Entra ID"}
      </button>
      {pending ? <p role="status">Preparing Microsoft sign-in...</p> : null}
    </form>
  );
}

function Workbench({ savedQueries }: { savedQueries: ReturnType<typeof createSavedQueryClient> }) {
  const [agentInventoryQueries] = useState(() => new AgentInventoryQueries());
  const [initialAgentRoute] = useState(readInitialAgentRoute);
  const [syncReportRoute, setSyncReportRoute] = useState(() => parseDataSyncRoute(readViewSearch("sync")).reports);
  const [requestedPowerPlatformJobId, setRequestedPowerPlatformJobId] = useState(() => parseDataSyncRoute(readViewSearch("sync")).powerPlatformJobId);
  const [usersRoute, setUsersRoute] = useState(() => parseUsersRoute(readViewSearch("users")));
  const [user, setUser] = useState<SessionUser>();
  const [sessionEpoch, setSessionEpoch] = useState(0);
  const [agentScopeEpoch, setAgentScopeEpoch] = useState(0);
  const agentScopeEpochRef = useRef(0);
  const [loadedWorkbenchMetadata, setLoadedWorkbenchMetadata] = useState<{
    principalKey: string;
    value: Awaited<ReturnType<typeof getWorkbenchMetadata>>;
  }>();
  const capabilityState = useCapabilities(user, sessionEpoch);
  const [trackedJob, setTrackedJob] = useState<BulkActionJob>();
  const [bulkJobCommand, setBulkJobCommand] = useState<BulkJobCommand>();
  const [bulkJobError, setBulkJobError] = useState<string>();
  const [bulkJobStorageError, setBulkJobStorageError] = useState<string>();
  const [linkedPackageRefreshJob, setLinkedPackageRefreshJob] = useState<PackageRefreshJob>();
  const [linkedJobError, setLinkedJobError] = useState<string>();
  const [authSetup, setAuthSetup] = useState<{ authConfigured: boolean; callback: string; setup?: string }>();
  const [agents, setAgents] = useState<CopilotPackage[]>([]);
  const [unifiedAgentPage, setUnifiedAgentPage] = useState<UnifiedAgentInventoryPage>();
  const [inventoryUnavailable, setInventoryUnavailable] = useState<UnifiedAgentInventoryUnavailable>();
  const inventoryNavigation = useRef<{ key: string; selectionId?: string; cursor?: string }>({ key: "" });
  const [unifiedAgentReadError, setUnifiedAgentReadError] = useState<string>();
  const [selectedUnifiedAgent, setSelectedUnifiedAgent] = useState<UnifiedAgentRecord>();
  const [agentPackageSelection, setAgentPackageSelection] = useState<{ owner: string; recordId: string; packageId: string }>();
  const [packageAccessRevisions, setPackageAccessRevisions] = useState(new Map<string, number>());
  const [packageControlError, setPackageControlError] = useState<{ packageId: string; message: string }>();
  const [selectedPowerPlatformTargets, setSelectedPowerPlatformTargets] = useState<Map<string, PowerPlatformResource>>(new Map());
  const [selectedPowerPlatformSnapshot, setSelectedPowerPlatformSnapshot] = useState<QuarantineSelectionSnapshot | null>(null);
  const [pendingPowerPlatformIds, setPendingPowerPlatformIds] = useState<Set<string>>(() => new Set(initialAgentRoute.selectedPowerPlatformIds));
  const [agentEnvironmentFilter, setAgentEnvironmentFilter] = useState(initialAgentRoute.environmentId);
  const [requestedQuarantineJobId, setRequestedQuarantineJobId] = useState(initialAgentRoute.quarantineJobId);
  const lastQuarantineResult = useRef<string | undefined>(undefined);
  const [requestedInventorySnapshotId, setRequestedInventorySnapshotId] = useState(initialAgentRoute.inventorySnapshotId);
  const [loadingSession, setLoadingSession] = useState(true);
  const [signingOut, setSigningOut] = useState(false);
  const [loadingAgents, setLoadingAgents] = useState(false);
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
  const [bulkAccessSelection, setBulkAccessSelection] = useState<{ id: string; owner: string; count: number; ids?: string[]; recordIds?: string[] }>();
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
  const [savedAgentDetail, setAgentDetail] = useState<{
    owner: string;
    recordId?: string;
    selectionId?: string;
    detail: CopilotPackageDetail;
  }>();
  const [agentDetailTab, setAgentDetailTab] = useState(initialAgentRoute.detailTab ?? "identities");
  const [requestedAgentDetailId, setRequestedAgentDetailId] = useState(initialAgentRoute.detailId);
  const [requestedPackageRefreshJobId, setRequestedPackageRefreshJobId] = useState(initialAgentRoute.refreshJobId);
  const [requestedPackageRefreshMode, setRequestedPackageRefreshMode] = useState(initialAgentRoute.refreshMode);
  const [requestedPackageControlJobId, setRequestedPackageControlJobId] = useState(initialAgentRoute.controlJobId);
  const [requestedDataSyncRunId, setRequestedDataSyncRunId] = useState(initialAgentRoute.syncRunId);
  const [syncSetup, setSyncSetup] = useState<{ owner: string; required: boolean }>();
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
  const exportSequence = useRef(0);
  const [inventoryExport, setInventoryExport] = useState<{
    sequence: number; owner: string; selectionId: string; kind: "unified_agents" | "power_platform_agents"; ids?: string[];
  }>();
  const [refreshingPowerPlatformAgents, setRefreshingPowerPlatformAgents] = useState(false);
  const [powerPlatformAgentRefreshJob, setPowerPlatformAgentRefreshJob] = useState<InventoryRefreshJob>();
  const [agentReloadRevision, setAgentReloadRevision] = useState(0);
  const [officialUsageDashboardRevision, setOfficialUsageDashboardRevision] = useState(0);
  const [copilotUsersDataRevision, setCopilotUsersDataRevision] = useState(0);
  const [activeView, setActiveView] = useState<WorkbenchViewId>(() => parseWorkbenchView(window.location.pathname));
  const [lastAgentListRefreshAt, setLastAgentListRefreshAt] = useState<Date>();
  const [packageSnapshotExpiresAt, setPackageSnapshotExpiresAt] = useState<Date>();
  const [refreshingAgents, setRefreshingAgents] = useState(false);
  const deferredQuery = useDeferredValue(query);
  const agentDetailRequestId = useRef(0);
  const agentDetailAbortController = useRef<AbortController | undefined>(undefined);
  const [unifiedAgentDetailPage, setUnifiedAgentDetailPage] = useState<{
    listPage?: UnifiedAgentInventoryPage;
    sourcePage?: UnifiedAgentInventoryPage;
  }>();
  const currentDetailSelection = useRef<string | undefined>(undefined);
  useEffect(() => { currentDetailSelection.current = unifiedAgentDetailPage?.sourcePage?.selection?.id; },
    [unifiedAgentDetailPage?.sourcePage?.selection?.id]);
  const agentListRequestId = useRef(0);
  const agentListAbortController = useRef<AbortController | undefined>(undefined);
  const forceCurrentAgentReload = useRef(false);
  const verificationOnlyAgentReload = useRef(false);
  const bulkJobPollRequestId = useRef(0);
  const bulkJobRequestAbort = useRef<AbortController | undefined>(undefined);
  const bulkJobCommandRequestId = useRef<number | undefined>(undefined);
  const packageRefreshRequestId = useRef(0);
  const inventoryRefreshRequestId = useRef(0);
  const linkedPackageRefreshRequestId = useRef(0);
  const dataSyncPanelRef = useRef<DataSyncPanelHandle>(null);
  const sessionRequestId = useRef(0);
  const sessionAbortController = useRef<AbortController | undefined>(undefined);
  const signOutAbortController = useRef<AbortController | undefined>(undefined);
  const sessionRevalidationInFlight = useRef(false);
  const resumedBulkJobIds = useRef(new Set<string>());
  const agentDetailsCache = useRef(new Map<string, CopilotPackageDetail>());
  const savedViewSearches = useRef(new Map<WorkbenchViewId, string>([
    [parseWorkbenchView(window.location.pathname), window.location.search],
  ]));
  const principalKey = user
    ? `${user.tenantId ?? ""}:${user.homeAccountId}:${[...user.roles].sort().join(",")}:${sessionEpoch}`
    : `signed-out:${sessionEpoch}`;
  const syncSetupRequired = syncSetup?.owner === principalKey ? syncSetup.required : true;
  const waitingForInitialInventory = syncSetupRequired && activeView !== "sync";
  const handleSyncSetupRequiredChange = useCallback((required: boolean) => {
    setSyncSetup({ owner: principalKey, required });
  }, [principalKey]);
  const agentDetail = savedAgentDetail?.owner === principalKey ? savedAgentDetail.detail : undefined;
  useEffect(() => () => savedQueries.clear(), [principalKey, savedQueries]);
  useEffect(() => () => { bulkJobRequestAbort.current?.abort(); }, [principalKey]);
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
  const reloadPublishedPackages = useEffectEvent(() => {
    handleDataSyncSourcesChanged(["graph_packages"]);
  });
  const revalidateCurrentSession = useEffectEvent(() => {
    if (sessionRevalidationInFlight.current || (!user && loadingSession)) return;
    sessionRevalidationInFlight.current = true;
    clearPrivateState();
    setUser(undefined);
    if (signOutAbortController.current) {
      setLoadingSession(false);
      sessionRevalidationInFlight.current = false;
      return;
    }
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
    verificationOnlyAgentReload.current = false;
    bulkJobPollRequestId.current += 1;
    packageRefreshRequestId.current += 1;
    inventoryRefreshRequestId.current += 1;
    linkedPackageRefreshRequestId.current += 1;
    resumedBulkJobIds.current.clear();
    agentDetailsCache.current.clear();
    void Promise.resolve().then(() => {
      setAgents([]);
      setUnifiedAgentPage(undefined);
      setSelectedUnifiedAgent(undefined);
      setUnifiedAgentDetailPage(undefined);
      setAgentPackageSelection(undefined);
      setPackageAccessRevisions(new Map());
      setPackageControlError(undefined);
      setSelectedPowerPlatformTargets(new Map());
      setSelectedPowerPlatformSnapshot(null);
      setAgentDetail(undefined);
      clearTrackedJob();
      setLinkedPackageRefreshJob(undefined);
      setLinkedJobError(undefined);
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

  useEffect(() => {
    function restoreRoute() {
      if (!isWorkbenchPath(window.location.pathname)) return;
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
        setAgentDetail(current => current?.detail.id === route.detailId ? current : undefined);
      } else if (view === "users") {
        setUsersRoute(parseUsersRoute(window.location.search));
      } else if (view === "sync") {
        const route = parseDataSyncRoute(window.location.search);
        setRequestedPowerPlatformJobId(route.powerPlatformJobId);
        setRequestedDataSyncRunId(route.syncRunId);
        setRequestedPackageRefreshJobId(route.refreshJobId);
        setRequestedPackageRefreshMode(route.refreshMode);
        setSyncReportRoute(route.reports);
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
  }, [pendingStoredAgentSelectionCount, principalKey, user]);

  useEffect(() => {
    if (!user || activeView !== "agents" || pendingStoredAgentSelectionCount !== undefined) return;
    if (sessionOwnerRef.current !== principalKey) return;
    const selectedPin = unifiedAgentPage?.inventoryScope === agentInventoryScope ? unifiedAgentPage.selection.id : undefined;
    const matching = serverPackageSelection?.owner === principalKey && serverPackageSelection.id === selectedPin;
    const groups = groupPackageSelection?.owner === principalKey && groupPackageSelection.id === selectedPin
      ? [...groupPackageSelection.groups] : [];
    const groupKey = groups.length ? JSON.stringify([principalKey, selectedPin,
      selectedAgentIds.size ? [...selectedAgentIds] : undefined, groups]) : undefined;
    const targetCount = matching ? unifiedAgentPage!.counts.packageTargets
      : groupKey && groupTargetCount?.key === groupKey ? groupTargetCount.count : undefined;
    const inventory = selectedPin && targetCount !== undefined && targetCount > 0 && (matching || groups.length)
      ? { id: selectedPin, query: JSON.stringify(currentUnifiedAgentQuery()),
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
    const next = workbenchUrl("agents", search);
    if (`${window.location.pathname}${window.location.search}` !== next) {
      window.history.replaceState({ view: "agents" }, "", next);
    }
    if (selectionStored) {
      void Promise.resolve().then(() => setSelectionRouteNotice({
        tone: selectionSaved ? "success" : "error",
        text: selectionSaved
          ? `${(inventory?.count ?? selectedAgentIds.size).toLocaleString()} selected packages are preserved only for this signed-in browser session and omitted from the URL.`
          : `The selection remains active, but could not be preserved in browser session storage. It will not survive reload; no IDs were silently truncated.`,
      }));
    }
  }, [activeView, agentDetail?.id, agentDetailTab, agentEnvironmentFilter, agentInventoryScope, agentManagement, agentPageIndex, agentRelevance, agentSortBy, agentSortDirection, packageType, availableToFilter, createdWithinDays, endUserAccess, hostFilter, pendingPowerPlatformIds, pendingStoredAgentSelectionCount, platformFilter, publisherFilter, query, reportedUsage, requestedAgentDetailId, requestedInventorySnapshotId, requestedPackageControlJobId, requestedPackageRefreshJobId, requestedPackageRefreshMode, requestedQuarantineJobId, selectedAgentIds, selectedPowerPlatformTargets, selectedUnifiedAgent?.id, statusFilter, user, groupPackageSelection, groupTargetCount, principalKey, serverPackageSelection, unifiedAgentPage]);

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
    if (`${window.location.pathname}${window.location.search}` !== next) {
      window.history.replaceState({ view: "sync" }, "", next);
    }
  }, [activeView, requestedPowerPlatformJobId, requestedDataSyncRunId, requestedPackageRefreshJobId, requestedPackageRefreshMode, syncReportRoute, user]);

  useEffect(() => {
    if (!user || !hasRole(user, "AgentControl.Viewer") || activeView !== "agents" || !requestedAgentDetailId
      || !unifiedAgentPage?.selection?.id
      || busyAgentId || busyBulkAction
      || (selectedUnifiedAgent?.id === requestedAgentDetailId && unifiedAgentDetailPage?.listPage === unifiedAgentPage)
      || (agentDetail?.id === requestedAgentDetailId && unifiedAgentDetailPage?.listPage === unifiedAgentPage)
      || loadingAgentDetailId === requestedAgentDetailId) return;
    const unified = findUnifiedAgentRecord(unifiedAgentPage?.value ?? [], requestedAgentDetailId, agentEnvironmentFilter ?? undefined);
    const selectReferencedPackage = (record: UnifiedAgentRecord) => {
      const exact = record.packages.find(item => item.id === requestedAgentDetailId
        || unifiedAgentRecordId({ source: "graph_packages", packageId: item.id }) === requestedAgentDetailId);
      if (exact) setAgentPackageSelection({ owner: principalKey, recordId: record.id, packageId: exact.id });
    };
    if (unified) {
      const requestId = ++agentDetailRequestId.current;
      agentDetailAbortController.current?.abort();
      let active = true;
      void Promise.resolve().then(() => {
        if (!active || requestId !== agentDetailRequestId.current) return;
        setLoadingAgentDetailId(undefined);
        setUnifiedAgentDetailPage({ listPage: unifiedAgentPage, sourcePage: unifiedAgentPage });
        setSelectedUnifiedAgent(unified);
        selectReferencedPackage(unified);
        setRequestedAgentDetailId(unified.id);
        setAgentDetail(current => current?.owner === principalKey && current.recordId === unified.id
          && unified.packages.some(item => item.id === current.detail.id) ? current : undefined);
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
      const recordId = unifiedAgentRecordId(target);
      const selectionId = unifiedAgentPage?.selection?.id;
      if (!selectionId) throw new Error("Refresh saved agent inventory before opening this exact agent.");
      let record = await getUnifiedAgentDetail(selectionId, recordId, { signal: controller.signal });
      if (controller.signal.aborted || requestId !== agentDetailRequestId.current) return;
      const nativeDetail = target.source === "graph_packages"
        ? await getAgentDetails(selectionId, target.packageId, { signal: controller.signal }) : undefined;
      if (controller.signal.aborted || requestId !== agentDetailRequestId.current) return;
      if (nativeDetail && target.source === "graph_packages" && nativeDetail.id !== target.packageId) {
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
        setAgentDetail(undefined);
        setSelectedUnifiedAgent(undefined);
        setRequestedAgentDetailId(undefined);
        setAgentDetailError(errorMessage(requestError));
      }
    });
    return () => controller.abort();
  }, [activeView, agentDetail?.id, agentEnvironmentFilter, agentReloadRevision, busyAgentId, busyBulkAction, loadingAgentDetailId, principalKey, requestedAgentDetailId, savedQueries, selectedUnifiedAgent?.id, unifiedAgentDetailPage, unifiedAgentPage, user]);

  useEffect(() => {
    if (!user || !hasRole(user, "AgentControl.Viewer") || (activeView !== "agents" && activeView !== "sync") || !requestedPackageRefreshJobId) {
      void Promise.resolve().then(() => setLinkedPackageRefreshJob(undefined));
      return;
    }
    const owner = ++linkedPackageRefreshRequestId.current;
    const controller = new AbortController();
    let timer: number | undefined;
    const load = async () => {
      try {
        const job = await getPackageRefreshJob(requestedPackageRefreshJobId, requestedPackageRefreshMode, { signal: controller.signal });
        if (controller.signal.aborted || owner !== linkedPackageRefreshRequestId.current) return;
        setLinkedPackageRefreshJob(job);
        if (job.status === "running") {
          timer = window.setTimeout(() => void load(), packageRefreshPollIntervalMs);
        } else if (job.status === "succeeded") {
          reloadPublishedPackages();
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
      clearTrackedJob();
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
    if (!user || !hasRole(user, "AgentControl.Admin") || activeView !== "agents") {
      return;
    }
    if (requestedPackageControlJobId || requestedPackageRefreshJobId) return;

    const stored = loadStoredActiveBulkJobId(user);
    if (stored.error) {
      void Promise.resolve().then(() => setBulkJobStorageError(stored.error));
    }
    const jobId = stored.jobId;

    if (jobId) {
      if (!resumedBulkJobIds.current.has(jobId)) {
        resumedBulkJobIds.current.add(jobId);
        resumeBulkJob(jobId);
      }
      return;
    }

    // Sign-in and session revalidation can clear the browser's active-job pointer.
    const controller = new AbortController();
    const owner = bulkJobPollRequestId.current;
    getBulkActionJobs(50, { signal: controller.signal }).then(({ value }) => {
      if (controller.signal.aborted || bulkJobPollRequestId.current !== owner) return;
      const retained = value.find(job => isJobPolling(job.status) || job.canResume || job.status === "waiting_authorization"
        || job.reconciliationRequired > 0);
      if (!retained || resumedBulkJobIds.current.has(retained.id)) return;
      resumedBulkJobIds.current.add(retained.id);
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
  }, [activeView, powerPlatformAgentRefreshJob?.id, powerPlatformAgentRefreshJob?.status, principalKey, refreshingPowerPlatformAgents]);

  useEffect(() => {
    if (!user) {
      agentListAbortController.current?.abort();
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
    if (activeView !== "agents" && activeView !== "sync" && activeView !== "audit") return;
    if (waitingForInitialInventory) return;
    if (pendingStoredAgentSelectionCount !== undefined) return;
    const forceCurrentSnapshot = forceCurrentAgentReload.current;
    forceCurrentAgentReload.current = false;
    loadSavedAgents(forceCurrentSnapshot);
    return () => agentListAbortController.current?.abort();
  }, [activeView, agentEnvironmentFilter, agentInventoryScope, agentManagement, agentPageIndex, agentRelevance, agentReloadRevision, agentSortBy, agentSortDirection, packageType, availableToFilter, createdWithinDays, deferredQuery, endUserAccess, hostFilter, pendingStoredAgentSelectionCount, platformFilter, publisherFilter, reportedUsage, statusFilter, user, waitingForInitialInventory]);

  useEffect(() => {
    if (!inventoryUnavailable || loadingAgents || !hasRole(user, "AgentControl.Viewer")
      || !["agents", "sync", "audit"].includes(activeView) || waitingForInitialInventory) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible" && navigator.onLine) loadSavedAgents(true);
    }, 5_000);
    return () => window.clearInterval(timer);
  }, [activeView, inventoryUnavailable, loadingAgents, user, waitingForInitialInventory]);


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
        bulkJobPollRequestId.current += 1;
        bulkJobCommandRequestId.current = undefined;
        packageRefreshRequestId.current += 1;
        inventoryRefreshRequestId.current += 1;
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
  const blockingFirstSync = hasRole(user, "AgentControl.Viewer") && syncSetupRequired
    && visibleActiveView !== "sync" && visibleActiveView !== "permissions";
  const canOperate = hasRole(user, "AgentControl.Admin");
  const canImportReports = hasRole(user, "AgentControl.Admin");
  const automaticAction = workbenchMetadata?.actions.find(action => action.id === "data-sync.auto-refresh");
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
      if (ownsAgentScope(principalKey)) handleDataSyncSourcesChanged(sources);
    },
    onRunsChanged: () => {
      if (!ownsAgentScope(principalKey)) return;
      handleSyncRunsChanged();
      void dataSyncPanelRef.current?.refresh();
    },
  });

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
      setRequestedPowerPlatformJobId(route.powerPlatformJobId);
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
      window.history.pushState({ view }, "", next);
    }
  }

  function handleUsersRouteChange(route: UsersRouteState, replace = false) {
    const search = usersRouteSearch(route);
    const next = workbenchUrl("users", search);
    savedViewSearches.current.set("users", search.toString());
    if (`${window.location.pathname}${window.location.search}` !== next) {
      if (replace) window.history.replaceState({ view: "users" }, "", next);
      else window.history.pushState({ view: "users" }, "", next);
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
      window.history.pushState({ view: "sync" }, "", next);
    }
    setSyncReportRoute(reports);
  }

  function handleOfficialUsageChanged() {
    requestCurrentAgentReload();
    setOfficialUsageDashboardRevision(revision => revision + 1);
    setCopilotUsersDataRevision(revision => revision + 1);
    void dataSyncPanelRef.current?.refresh();
  }

  function handleReportSetSelected(selectionChanged: boolean) {
    if (selectionChanged) {
      const next = { ...usersRoute, reportSetId: undefined, agentId: undefined, search: "", page: 0 };
      if (activeView === "users") handleUsersRouteChange(next, true);
      else {
        savedViewSearches.current.set("users", usersRouteSearch(next).toString());
        setUsersRoute(next);
      }
    }
    handleOfficialUsageChanged();
  }

  function openUsageImport(view: "import" | "manage" = "import") {
    if (activeView !== "sync") navigateToView("sync");
    handleSyncReportRouteChange({ view, activityWindowDays: 30 });
  }

  function finishUsageImport() {
    handleReportSetSelected(true);
    navigateToView("agents");
    requestAnimationFrame(() => document.getElementById("agents-heading")?.focus({ preventScroll: true }));
  }

  function handleDataSyncSourcesChanged(sources: DataSyncSourceId[]) {
    setSyncHistoryRevision(revision => revision + 1);
    const changed = new Set(sources);
    if (changed.has("graph_packages") || changed.has("power_platform")) {
      if (inventoryNavigation.current.selectionId && (agentPageIndex > 0 || selectedAgentIds.size > 0
        || groupPackageSelection?.owner === principalKey || serverPackageSelection?.owner === principalKey
        || selectedUnifiedAgent || requestedAgentDetailId)) {
        agentInventoryQueries.clear();
        setAgentReloadRevision(revision => revision + 1);
      } else requestCurrentAgentReload();
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
      powerPlatformJobId: requestedPowerPlatformJobId,
      syncRunId: runId,
      refreshJobId: requestedPackageRefreshJobId,
      refreshMode: requestedPackageRefreshMode,
      reports: syncReportRoute,
    }));
    if (`${window.location.pathname}${window.location.search}` !== next) {
      window.history.pushState({ view: "sync" }, "", next);
    }
  }

  const visibleUnifiedAgentPage = unifiedAgentPage?.inventoryScope === agentInventoryScope
    ? unifiedAgentPage : undefined;
  const matchingPackageSelection = serverPackageSelection?.owner === principalKey
    && serverPackageSelection.id === visibleUnifiedAgentPage?.selection?.id ? serverPackageSelection : undefined;
  const matchingPackageCount = matchingPackageSelection ? visibleUnifiedAgentPage?.counts?.packageTargets ?? 0 : 0;
  const selectedGroups = groupPackageSelection?.owner === principalKey
    && groupPackageSelection.id === visibleUnifiedAgentPage?.selection?.id ? groupPackageSelection.groups : new Set<string>();
  const groupTargetKey = canOperate && selectedGroups.size ? JSON.stringify([principalKey, groupPackageSelection!.id,
    selectedAgentIds.size ? [...selectedAgentIds] : undefined, [...selectedGroups.keys()]]) : undefined;
  const groupCount = groupTargetCount?.key === groupTargetKey ? groupTargetCount : undefined;
  const groupCountPending = Boolean(groupTargetKey && groupCount?.count === undefined);
  const selectedPackageCount = groupTargetKey ? groupCount?.count ?? 0 : selectedAgentIds.size;
  useEffect(() => {
    if (!groupTargetKey) return;
    const [owner, selectionId, ids, recordIds] = JSON.parse(groupTargetKey) as [string, string, string[] | null, string[]];
    const abort = new AbortController();
    const timer = setTimeout(() => {
      void countPackageMutationSelection({ selectionId, ids: ids ?? undefined, recordIds }, { signal: abort.signal })
        .then(result => { if (!abort.signal.aborted && sessionOwnerRef.current === owner) setGroupTargetCount({ key: groupTargetKey, count: result.count }); })
        .catch(error => { if (!abort.signal.aborted && sessionOwnerRef.current === owner) setGroupTargetCount({ key: groupTargetKey, error: errorMessage(error) }); });
    }, 100);
    return () => { clearTimeout(timer); abort.abort(); };
  }, [groupTargetKey]);
  const displayedUnifiedAgents = visibleUnifiedAgentPage?.value ?? [];
  const inventoryScopeCount = visibleUnifiedAgentPage
    ? inventoryScopeAgentCount(visibleUnifiedAgentPage.summary, agentInventoryScope) : undefined;
  const nativeObservation = visibleUnifiedAgentPage?.sources.powerPlatform.observation;
  const inventoryCollectionText = [
    ...(agentInventoryScope !== "power_platform_only" ? [lastAgentListRefreshAt
      ? `Catalog collected ${formatRefreshTime(lastAgentListRefreshAt)}${packageSnapshotExpiresAt && packageSnapshotExpiresAt.getTime() <= Date.now() ? " / expired" : ""}`
      : "No saved package catalog observation. Open Sync to collect it."] : []),
    ...(agentInventoryScope !== "catalog" ? [nativeObservation
      ? `Power Platform collected ${formatRefreshTime(new Date(nativeObservation.observedAt))}`
      : "No saved Power Platform observation. Open Sync to collect it."] : []),
  ].join(" · ");
  const agentInventoryIssueSummary = inventoryUnavailable ? "" : inventoryAttentionReasons(unifiedAgentPage, unifiedAgentReadError).join(" ");
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
  const agentExportRevision = visibleUnifiedAgentPage?.selection?.id;
  const agentExportNeedsReload = Boolean(unifiedAgentReadError || agentExportError?.reloadRequired || (unifiedAgentPage && !agentExportRevision));
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
    clearAgentState();
    savedQueries.clear();
    setLoadedWorkbenchMetadata(undefined);
    setRequestedDataSyncRunId(undefined);
    setSyncReportRoute(undefined);
    setRequestedPowerPlatformJobId(undefined);
  }

  function clearAgentState() {
    setInventoryUnavailable(undefined);
    setInventoryExport(undefined);
    setServerPackageSelection(undefined);
    setBulkAccessSelection(undefined);
    inventoryNavigation.current = { key: "" };
    setGroupPackageSelection(undefined);
    setGroupTargetCount(undefined);
    agentScopeEpochRef.current += 1;
    setAgentScopeEpoch(agentScopeEpochRef.current);
    agentDetailRequestId.current += 1;
    agentDetailAbortController.current?.abort();
    agentListRequestId.current += 1;
    agentListAbortController.current?.abort();
    verificationOnlyAgentReload.current = false;
    bulkJobPollRequestId.current += 1;
    packageRefreshRequestId.current += 1;
    inventoryRefreshRequestId.current += 1;
    linkedPackageRefreshRequestId.current += 1;
    agentInventoryQueries.clear();
    savedQueries.removeQueries({
      predicate: ({ queryKey }) => queryKey[0] === "saved"
        && queryKey[2] === principalKey
        && typeof queryKey[1] === "string"
        && ["package-summaries", "inventory-refresh-jobs", "unified-agent-detail", "package-detail"].includes(queryKey[1]),
    });
    resumedBulkJobIds.current.clear();
    agentDetailsCache.current.clear();
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
    setExportingCsv(false);
    setAgentExportError(undefined);
    setUnifiedAgentReadError(undefined);
    setBulkProgress(undefined);
    setBulkResult(undefined);
    clearTrackedJob();
    setLinkedPackageRefreshJob(undefined);
    setLinkedJobError(undefined);
  }

  function invalidateAgentSelection() {
    setInventoryUnavailable(undefined);
    agentListRequestId.current += 1;
    agentListAbortController.current?.abort();
    agentDetailRequestId.current += 1;
    agentDetailAbortController.current?.abort();
    agentInventoryQueries.clear();
    agentDetailsCache.current.clear();
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
    setSingleAccessAgentDetail(undefined);
    setSelectedAgentIds(new Set());
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

    try {
      const setup = await fetch("/api/auth/status", { credentials: "include", signal: controller.signal });
      if (!isCurrent()) return;
      if (setup.ok) {
        const value = await setup.json();
        if (!isCurrent()) return;
        setAuthSetup(value);
      }
      const session = await getCurrentUser({ signal: controller.signal });
      if (isCurrent()) setUser(session.user);
    } catch (requestError) {
      if (isCurrent() && !(requestError instanceof ApiError && (requestError.status === 401 || requestError.kind === "aborted"))) {
        setError(errorMessage(requestError));
      }
    } finally {
      if (isCurrent()) setLoadingSession(false);
      if (sessionAbortController.current === controller) sessionAbortController.current = undefined;
    }
  }

  function currentUnifiedAgentQuery(): UnifiedAgentInventoryQuery {
    return {
      ...(packageType !== undefined ? { type: packageType } : {}),
      ...(endUserAccess !== "all" ? { endUserAccess } : {}),
      ...(reportedUsage !== "all" ? { reportedUsage } : {}),
      ...(agentManagement !== "all" ? { management: agentManagement } : {}),
      ...(agentRelevance !== "all" ? { relevance: agentRelevance } : {}),
      ...(normalizedBulkRefQuery ? { operationIdPrefix: normalizedBulkRefQuery } : deferredQuery.trim() ? { search: deferredQuery.trim() } : {}),
      ...(agentEnvironmentFilter !== undefined ? { environmentId: agentEnvironmentFilter } : {}),
      ...(statusFilter === "all" ? {} : { blocked: statusFilter === "blocked" }),
      ...(publisherFilter === undefined ? {} : { publisher: publisherFilter }),
      ...(availableToFilter === undefined ? {} : { availableTo: availableToFilter }),
      ...(hostFilter === undefined ? {} : { host: hostFilter }),
      ...(effectivePlatformFilter === undefined ? {} : { platform: effectivePlatformFilter }),
      ...(parseOptionalPositiveInteger(createdWithinDays) ? { createdWithinDays: parseOptionalPositiveInteger(createdWithinDays) } : {}),
      inventoryScope: agentInventoryScope,
      sortBy: agentSortBy,
      sortDirection: agentSortDirection,
    };
  }

  async function loadAgents(forceCurrentSnapshot = false) {
    if (forceCurrentSnapshot) agentInventoryQueries.clear();
    verificationOnlyAgentReload.current = false;
    const requestId = ++agentListRequestId.current;
    agentListAbortController.current?.abort();
    const controller = new AbortController();
    agentListAbortController.current = controller;
    setLoadingAgents(true);
    setError(undefined);

    try {
      const inventoryKey = JSON.stringify([principalKey, currentUnifiedAgentQuery()]);
      if (forceCurrentSnapshot || inventoryNavigation.current.key !== inventoryKey) {
        inventoryNavigation.current = { key: inventoryKey };
        if (agentPageIndex !== 0) setAgentPageIndex(0);
      }
      const [unifiedResponse, inventoryRefreshJobs] = await Promise.all([
        agentInventoryQueries.read(principalKey, {
          ...currentUnifiedAgentQuery(),
          limit: agentDisplayPageSize,
          selectionId: inventoryNavigation.current.selectionId,
          cursor: inventoryNavigation.current.cursor,
        }, controller.signal),
        readSavedQuery(savedQueries, ["inventory-refresh-jobs", principalKey, agentReloadRevision],
          signal => getInventoryRefreshJobs({ signal }), controller.signal).catch(requestError => {
          if (isAccessDenied(requestError)) throw requestError;
          if (requestId === agentListRequestId.current && !controller.signal.aborted) {
            setError(`Unable to load Power Platform agent refresh history: ${errorMessage(requestError)}`);
          }
          return undefined;
        }),
      ]);
      if (requestId !== agentListRequestId.current || controller.signal.aborted) return;
      if ("state" in unifiedResponse) {
        invalidateAgentSelection();
        setInventoryUnavailable(unifiedResponse);
        setUnifiedAgentReadError(undefined);
        setAgentExportError(undefined);
        setLastAgentListRefreshAt(undefined);
        setPackageSnapshotExpiresAt(undefined);
        return;
      }
      setInventoryUnavailable(undefined);
      inventoryNavigation.current.selectionId = unifiedResponse.selection.id;
      setAgents(unifiedResponse.value.flatMap(record => record.packages));
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
      const graph = unifiedResponse.sources.graphPackages.observation;
      setLastAgentListRefreshAt(graph ? new Date(graph.observedAt) : undefined);
      setPackageSnapshotExpiresAt(graph ? new Date(graph.expiresAt) : undefined);
      agentDetailsCache.current.clear();
    } catch (requestError) {
      if (requestId === agentListRequestId.current && !(requestError instanceof ApiError && requestError.code === "request_aborted")) {
        setInventoryUnavailable(undefined);
        if (isAccessDenied(requestError)) clearAgentState();
        else if (requestError instanceof ApiError && ["selection_invalidated", "inventory_changed"].includes(requestError.code)) {
          invalidateAgentSelection();
        }
        setError(errorMessage(requestError));
        setUnifiedAgentReadError(errorMessage(requestError));
      }
    } finally {
      if (requestId === agentListRequestId.current) setLoadingAgents(false);
    }
  }

  async function handleRefreshAgents(idempotencyKey?: string) {
    if (!isCurrentAgentScope() || !user || sessionRevalidationInFlight.current) return;
    const requestId = ++packageRefreshRequestId.current;
    const owner = principalKey;
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
      while (job.status === "running") {
        await wait(packageRefreshPollIntervalMs);
        if (!ownsPackageRefreshRequest(requestId, owner)) return;
        job = await getPackageRefreshJob(job.id, job.tokenMode);
        if (!ownsPackageRefreshRequest(requestId, owner)) return;
        setLinkedPackageRefreshJob(job);
      }

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
    if (!isCurrentAgentScope()) return;
    const count = matchingPackageSelection ? matchingPackageCount : selectedPackageCount;
    const selectionId = visibleUnifiedAgentPage?.selection?.id;
    if (!selectionId || groupCountPending || count < 1 || count > 5000 || !user || sessionRevalidationInFlight.current) return;
    const requestId = ++packageRefreshRequestId.current;
    const owner = principalKey;
    setRefreshingAgents(true);
    setError(undefined);
    try {
      let job = await refreshPackageIdentityDetails({ selectionId,
        ...matchingPackageSelection ? {} : {
          ids: selectedAgentIds.size ? [...selectedAgentIds] : undefined,
          recordIds: selectedGroups.size ? [...selectedGroups] : undefined,
        } });
      if (!ownsPackageRefreshRequest(requestId, owner)) return;
      handleSyncRunsChanged();
      setLinkedPackageRefreshJob(job);
      while (job.status === "running") {
        await wait(packageRefreshPollIntervalMs);
        if (!ownsPackageRefreshRequest(requestId, owner)) return;
        job = await getPackageRefreshJob(job.id, job.tokenMode);
        if (!ownsPackageRefreshRequest(requestId, owner)) return;
        setLinkedPackageRefreshJob(job);
      }
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
    if (!isCurrentAgentScope()) return;
    const requestId = ++packageRefreshRequestId.current;
    const owner = principalKey;
    setRefreshingAgents(true);
    setError(undefined);
    setAgentDetailError(undefined);
    try {
      let job = await startExactPackageRefresh(id, "delegated");
      if (!ownsPackageRefreshRequest(requestId, owner)) return;
      while (job.status === "running") {
        await wait(packageRefreshPollIntervalMs);
        if (!ownsPackageRefreshRequest(requestId, owner)) return;
        job = await getPackageRefreshJob(job.id, job.tokenMode);
        if (!ownsPackageRefreshRequest(requestId, owner)) return;
      }
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
    if (signOutAbortController.current) return;
    const controller = new AbortController();
    signOutAbortController.current = controller;
    setSigningOut(true);
    sessionRequestId.current += 1;
    sessionAbortController.current?.abort();

    try {
      await signOut({ signal: controller.signal });
      if (controller.signal.aborted) return;
      clearPrivateState();
      setUser(undefined);
      setLoadingSession(false);
    } catch (requestError) {
      if (!controller.signal.aborted) setError(errorMessage(requestError));
    } finally {
      if (signOutAbortController.current === controller) signOutAbortController.current = undefined;
      if (!controller.signal.aborted) setSigningOut(false);
    }
  }

  function handleSearchQueryChange(nextQuery: string) {
    setQuery(nextQuery);
  }

  async function handleViewAgentDetails(agent: Pick<CopilotPackage, "id">) {
    if (!isCurrentAgentScope()) return;
    const requestId = ++agentDetailRequestId.current;
    agentDetailAbortController.current?.abort();
    const controller = new AbortController();
    agentDetailAbortController.current = controller;
    const owner = principalKey;
    const recordId = selectedUnifiedAgent?.id;
    const selectionId = unifiedAgentDetailPage?.sourcePage?.selection?.id;

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
        agentDetailsCache.current.clear();
        agentDetailsCache.current.set(agent.id, detail);
        setAgentDetail({ owner, recordId, selectionId, detail });
      }

    } catch (requestError) {
      if (ownsAgentDetailRequest(requestId, owner, controller.signal)) {
        setAgentDetail(undefined);
        setAgentDetailError(errorMessage(requestError));
      }
    } finally {
      if (ownsAgentDetailRequest(requestId, owner, controller.signal)) {
        setLoadingAgentDetailId(undefined);
      }
    }
  }

  function handleViewUnifiedAgentDetails(record: UnifiedAgentRecord) {
    if (!isCurrentAgentScope()) return;
    const requestId = ++agentDetailRequestId.current;
    agentDetailAbortController.current?.abort();
    if (!ownsAgentFlowRequest(requestId, principalKey)) return;
    setUnifiedAgentDetailPage({ listPage: unifiedAgentPage, sourcePage: unifiedAgentPage });
    setLoadingAgentDetailId(undefined);
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
    let job = await startExactPackageRefresh(id, "delegated");
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
    agentDetailsCache.current.clear();
    agentDetailsCache.current.set(id, detail);
    return detail;
  }

  async function handleManageAgentAccess(agent: CopilotPackage, target: PackageAccessTarget = "availability") {
    if (!isCurrentAgentScope()) return;
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
      if (agentDetailRequestId.current === requestId) {
        setLoadingAgentDetailId(undefined);
      }
    }
  }

  async function handleAgentAction(
    agent: CopilotPackage,
    targetBlockedState: boolean,
  ) {
    if (!isCurrentAgentScope()) return;
    const returnFocusTo = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    const requestId = ++agentDetailRequestId.current;
    agentDetailAbortController.current?.abort();
    const owner = principalKey;
    if (loadingAgentDetailId) setRequestedAgentDetailId(undefined);
    setLoadingAgentDetailId(undefined);
    setBusyAgentId(agent.id);
    setError(undefined);
    setPackageControlError(undefined);
    setBulkResult(undefined);

    try {
      const action = targetBlockedState ? "block" : "unblock";
      const preview = await previewPackageMutation({ action, ids: [agent.id], mutationScope: "single" });
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
      if (ownsAgentFlowRequest(requestId, owner)) setBusyAgentId(undefined);
    }
  }

  async function handleInlineAccessUpdate(agent: CopilotPackage, update: PackageAccessUpdate) {
    if (!isCurrentAgentScope()) return;
    if (!selectedUnifiedAgent?.packages.some(item => item.id === agent.id)) {
      throw new Error("This published version is no longer selected. Reopen the agent before changing access.");
    }
    const requestId = ++agentDetailRequestId.current;
    const owner = principalKey;
    if (!ownsAgentFlowRequest(requestId, owner)) return;
    agentDetailAbortController.current?.abort();
    setLoadingAgentDetailId(undefined);
    setBusyAgentId(agent.id);
    setAgentDetailError(undefined);
    setPackageControlError(undefined);
    setBulkResult(undefined);
    try {
      const detail = await refreshAccessDetails(agent.id, requestId);
      if (!detail || !ownsAgentFlowRequest(requestId, owner)) return;
      await requestAccessConfirmation([agent.id], update, "single");
    } finally {
      if (ownsAgentFlowRequest(requestId, owner)) setBusyAgentId(undefined);
    }
  }

  async function requestAccessConfirmation(
    ids: string[],
    update: PackageAccessUpdate,
    mutationScope: "single" | "bulk",
  ) {
    if (!isCurrentAgentScope()) return false;
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
    if (!isCurrentAgentScope() || exportingCsv || loadingAgents) return;
    if (!agentExportRevision || agentExportNeedsReload) {
      setAgentExportError({ message: "Reload the saved agent inventory before exporting; a valid saved revision is required.", reloadRequired: true });
      return;
    }
    setExportChoiceOpen(true);
  }

  function handleExportCsv(scope: UnifiedAgentExportScope) {
    if (exportingCsv) return;
    const owner = principalKey;
    if (!ownsAgentScope(owner) || !hasRole(user, "AgentControl.Viewer")) return;
    if (!agentExportRevision || agentExportNeedsReload) {
      setAgentExportError({ message: "Reload the saved agent inventory before exporting; a valid saved revision is required.", reloadRequired: true });
      return;
    }
    if (loadingAgents || deferredQuery !== query) {
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
    if (!isCurrentAgentScope()) return;
    if (!agentExportRevision || agentExportNeedsReload || exportingPowerPlatformCsv) {
      return;
    }

    setExportChoiceOpen(false);
    setError(undefined);
    setInventoryExport({ sequence: ++exportSequence.current, owner: principalKey, selectionId: agentExportRevision, kind: "power_platform_agents" });
  }

  async function handleRefreshPowerPlatformAgents() {
    if (!isCurrentAgentScope()) return;
    if (refreshingPowerPlatformAgents || powerPlatformAgentRefreshJob?.status === "running") {
      return;
    }

    setError(undefined);
    setRefreshingPowerPlatformAgents(true);
    const requestId = ++inventoryRefreshRequestId.current;
    const owner = principalKey;
    try {
      const job = await refreshInventory({
        types: ["microsoft.copilotstudio/agents", "microsoft.powerplatform/environments"],
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
    if (!isCurrentAgentScope()) return;
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
    if (!isCurrentAgentScope() || groupCountPending || matchingPackageSelection && (loadingAgents || deferredQuery !== query)) return;
    const label = targetBlockedState ? "block" : "unblock";
    const scope = [...selectedAgentIds];

    if (scope.length === 0 && !selectedGroups.size && !matchingPackageSelection) {
      setError("Select one or more agents before running a bulk action.");
      return;
    }

    const requestId = ++agentDetailRequestId.current;
    agentDetailAbortController.current?.abort();
    const controller = new AbortController();
    agentDetailAbortController.current = controller;
    const owner = principalKey;
    if (loadingAgentDetailId) setRequestedAgentDetailId(undefined);
    setLoadingAgentDetailId(undefined);
    setError(undefined);
    try {
      const targets = matchingPackageSelection ? { selectionId: matchingPackageSelection.id }
        : selectedGroups.size ? { selectionId: groupPackageSelection!.id,
          ids: scope.length ? scope : undefined, recordIds: [...selectedGroups.keys()] } : { ids: scope };
      const preview = await previewPackageMutation({ action: label, ...targets, mutationScope: "bulk" }, { signal: controller.signal });
      if (!ownsAgentFlowRequest(requestId, owner)) return;
      if (selectedGroups.size && !preview.selectionId) throw new Error("The server did not return the reviewed group selection.");
      setBulkConfirmation({ action: label, ...targets, ids: scope, selectionId: selectedGroups.size ? preview.selectionId : targets.selectionId, mutationScope: "bulk", preview });
    } catch (requestError) {
      if (ownsAgentFlowRequest(requestId, owner)) setError(errorMessage(requestError));
    }
  }

  async function runConfirmedBulkAction(confirmation: BulkConfirmation) {
    if (!isCurrentAgentScope()) return;
    const { action: label, ids, recordIds, selectionId, mutationScope, preview, accessUpdate } = confirmation;
    const requestId = ++bulkJobPollRequestId.current;
    const owner = principalKey;

    setBulkConfirmation(undefined);
    setServerPackageSelection(undefined);
    setGroupPackageSelection(undefined);

    clearTrackedJob();
    setBusyBulkAction(label);
    setBulkProgress(accessUpdate ? {
      action: label as "update-availability" | "update-installation",
      accessUpdate,
      total: preview.summary.targetCount,
      completed: 0,
      succeeded: 0,
      failed: 0,
      skipped: 0,
    } : {
      action: label as "block" | "unblock",
      targetBlockedState: label === "block",
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
          ids: recordIds && ids.length ? ids : undefined, recordIds, confirmationHash: preview.confirmationHash });
      } else if (accessUpdate) {
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
      await followBulkJob(job.id, job, true, mutationScope === "single" ? ids[0] : undefined);
    } catch (requestError) {
      if (ownsBulkJobRequest(requestId, owner)) {
        const message = errorMessage(requestError);
        setBulkJobError(message);
        if (mutationScope === "single" && ids.length === 1) setPackageControlError({ packageId: ids[0], message });
        setBusyBulkAction(undefined);
        setBulkProgress(undefined);
        clearActiveBulkJobId();
      }
    }
  }

  function requestBulkAccessUpdate() {
    if (!isCurrentAgentScope() || groupCountPending || matchingPackageSelection && (loadingAgents || deferredQuery !== query)) return;
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
    if (!isCurrentAgentScope()) return;
    const ids = bulkAccessAgentIds ?? [];

    if (ids.length === 0 && (!bulkAccessSelection || bulkAccessSelection.owner !== principalKey
      || bulkAccessSelection.id !== (bulkAccessSelection.recordIds ? visibleUnifiedAgentPage?.selection?.id : matchingPackageSelection?.id))) {
      throw new Error("The selected agents are no longer available.");
    }

    setError(undefined);
    setBulkResult(undefined);
    const requestId = ++agentDetailRequestId.current;

    try {
      if (bulkAccessSelection) {
        const action = update.target === "availability" ? "update-availability" : "update-installation";
        const { recordIds, ids: exactIds } = bulkAccessSelection;
        const preview = await previewPackageMutation({ action, selectionId: bulkAccessSelection.id, recordIds, ids: exactIds, mutationScope: "bulk", accessUpdate: update });
        if (agentDetailRequestId.current !== requestId) return;
        setBulkConfirmation({ action, ids: exactIds ?? [], recordIds, selectionId: bulkAccessSelection.id, mutationScope: "bulk", accessUpdate: update, preview });
      } else await requestAccessConfirmation(ids, update, "bulk");
      if (agentDetailRequestId.current !== requestId) return;
      setBulkAccessAgentIds(undefined);
      setBulkAccessSelection(undefined);
    } catch (requestError) {
      if (agentDetailRequestId.current !== requestId) return;
      setError(errorMessage(requestError));
      throw requestError;
    }
  }

  async function followBulkJob(jobId: string, initialJob?: BulkActionJob, persist = true, packageId?: string) {
    if (!isCurrentAgentScope()) return;
    const requestId = bulkJobPollRequestId.current + 1;
    bulkJobPollRequestId.current = requestId;
    const owner = principalKey;
    bulkJobRequestAbort.current?.abort();
    const controller = new AbortController();
    bulkJobRequestAbort.current = controller;
    let keepStored = true;
    const deadline = Date.now() + foregroundJobPollBudgetMs;

    try {
      let job = initialJob ?? (await getBulkActionJob(jobId, { signal: controller.signal }));
      if (!ownsBulkJobRequest(requestId, owner)) return;
      setTrackedJob(job);

      setBusyBulkAction(job.action);
      setBulkProgress(toBulkProgress(job));
      if (persist) {
        const storageError = user ? saveStoredActiveBulkJobId(user, job.id) : undefined;
        if (storageError) setBulkJobStorageError(storageError);
      }

      while (isJobPolling(job.status) && Date.now() < deadline) {
        await wait(bulkJobPollIntervalMs);

        if (!ownsBulkJobRequest(requestId, owner)) {
          return;
        }
        job = await getBulkActionJob(jobId, { signal: controller.signal });

        if (!ownsBulkJobRequest(requestId, owner)) {
          return;
        }

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
        const page = await getBulkActionJobItems(job.id, { revision: job.resultRevision }, { signal: controller.signal });
        if (!ownsBulkJobRequest(requestId, owner)) return;
        const result: BulkActionResult = { ...job, results: page.value.filter((item): item is BulkPackageResult =>
          item.status !== "queued" && item.status !== "running") };
        if (persist) applyBulkActionResult(result);
        else setBulkResult(result);
      }
      const message = jobStatusMessage(job.status);
      if (packageId && message) setPackageControlError({ packageId, message });
    } catch (requestError) {
      if (ownsBulkJobRequest(requestId, owner)) {
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
      if (changedIds.length) agentInventoryQueries.clear();
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
    }

    setBulkResult(result);
    setSelectionRouteNotice(undefined);
    setSelectedAgentIds(
      new Set(
        (result.total > result.results.length ? [] : result.results)
          .filter((result) => result.status === "failed")
          .map((result) => result.id),
      ),
    );
    if (result.total > result.results.length) {
      setSelectionRouteNotice({ tone: "success", text: "Task results are paged. Review the result pages before selecting new work." });
      agentDetailsCache.current.clear();
      agentInventoryQueries.clear();
      requestCurrentAgentReload();
    }
    if (result.results.some(item => item.status === "succeeded" || item.status === "skipped")) requestCurrentAgentReload();
  }

  async function handleBulkJobCommand(operation: BulkJobCommand) {
    if (!isCurrentAgentScope()) return;
    if (!trackedJob || bulkJobCommandRequestId.current !== undefined) return;
    if (operation === "resume" && !window.confirm("Resume only unprocessed tasks with your current authorization? Changes with uncertain outcomes will not be repeated.")) return;
    const requestId = ++bulkJobPollRequestId.current;
    const owner = principalKey;
    bulkJobCommandRequestId.current = requestId;
    setBulkJobCommand(operation);
    setBulkJobError(undefined);
    try {
      if (operation === "refresh") {
        const job = await getBulkActionJob(trackedJob.id);
        if (!ownsBulkJobRequest(requestId, owner)) return;
        finishBulkJobCommand(requestId);
        await followBulkJob(job.id, job, !requestedPackageControlJobId);
      } else if (operation === "reconcile") {
        const reconciled = await reconcileBulkActionJob(trackedJob.id);
        if (!ownsBulkJobRequest(requestId, owner)) return;
        setTrackedJob(reconciled);
        setBulkResult(undefined);
        if (reconciled.reconciliation.attempted > reconciled.reconciliation.failed) requestCurrentAgentReload();
        if (reconciled.reconciliation.failed) {
          setBulkJobError(`${reconciled.reconciliation.failed} provider read${reconciled.reconciliation.failed === 1 ? "" : "s"} could not be reconciled.`);
        }
      } else {
        const job = operation === "resume"
          ? await resumeBulkActionJob(trackedJob.id) : await cancelBulkActionJob(trackedJob.id);
        if (!ownsBulkJobRequest(requestId, owner)) return;
        if (operation === "resume") finishBulkJobCommand(requestId);
        await followBulkJob(job.id, job, !requestedPackageControlJobId);
      }
    } catch (requestError) {
      if (ownsBulkJobRequest(requestId, owner)) {
        setBulkJobError(errorMessage(requestError));
        setBusyBulkAction(undefined);
        setBulkProgress(undefined);
        if (operation === "cancel" && isJobPolling(trackedJob.status)) {
          finishBulkJobCommand(requestId);
          await followBulkJob(trackedJob.id, trackedJob, !requestedPackageControlJobId);
        }
      }
    } finally {
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
    setTrackedJob(undefined);
    setBulkJobError(undefined);
    setBulkJobCommand(undefined);
    bulkJobCommandRequestId.current = undefined;
  }

  function clearActiveBulkJobId() {
    const storageError = user ? clearStoredActiveBulkJobId(user) : undefined;
    if (storageError) setBulkJobStorageError(storageError);
  }

  function handleAgentFilterChange(values: Partial<AgentFilterValues>) {
    agentDetailAbortController.current?.abort();
    agentDetailRequestId.current += 1;
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
    agentDetailAbortController.current?.abort();
    agentDetailRequestId.current += 1;
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
    agentDetailRequestId.current += 1;
    agentDetailAbortController.current?.abort();
    handleClearAgentFilters();
    setAgentInventoryScope(scope);
    setSelectedAgentIds(new Set());
    setPendingStoredAgentSelectionCount(undefined);
    setSelectionRouteNotice(undefined);
    setExportChoiceOpen(false);
    setUnifiedAgentPage(undefined);
    setAgentDetail(undefined);
    setAgentDetailError(undefined);
    setLoadingAgentDetailId(undefined);
    setBusyAgentId(undefined);
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
    agentInventoryQueries.clear();

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
      && activeViewRef.current === "agents";
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

  function requestCurrentAgentReload() {
    if (!isCurrentAgentScope()) return;
    setServerPackageSelection(undefined);
    setGroupPackageSelection(undefined);
    setGroupTargetCount(undefined);
    agentInventoryQueries.clear();
    forceCurrentAgentReload.current = true;
    setAgentReloadRevision(revision => revision + 1);
  }

  function handleInventoryExportInvalidation() {
    if (!inventoryExport || !ownsAgentScope(inventoryExport.owner)) return;
    clearAgentState();
    setAgentExportError({ message: "The saved inventory selection changed or expired. Reload inventory before exporting again.", reloadRequired: true });
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
            Copilot usage and service insights, and investigate activity. Make
            informed decisions about adoption and access, with the controls to
            take action.
          </p>
          {authorizationNotice ? <p role="status">{authorizationNotice}</p> : null}
          {error ? <div className="error-banner" role="alert">{error}</div> : null}
          {bulkJobStorageError ? <div className="error-banner" role="status">{bulkJobStorageError}</div> : null}
          {authSetup?.authConfigured === false ? <div className="error-banner"><strong>Sign-in is not configured.</strong><p>{authSetup.setup}</p><code>{authSetup.callback}</code></div> : null}
          <SignInForm disabled={authSetup?.authConfigured === false} />
        </section>
        <AppFooter />
      </main>
    );
  }

  return (
    <CapabilityContext key={principalKey} value={{ ...capabilityState, openPermissions: () => navigateToView("permissions") }}>
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
      {bulkJobStorageError ? <div className="error-banner" role="status">{bulkJobStorageError}</div> : null}
      {hasRole(user, "AgentControl.Viewer") && visibleActiveView === "sync" ? (
        <AgentSyncTools
          inventory={unifiedAgentPage}
          verifyingInventory={loadingAgents || deferredQuery !== query}
          inventoryError={unifiedAgentReadError}
          onVerifyInventory={verifySavedAgentInventory}
          selectedPackageCount={groupCountPending ? 0 : matchingPackageSelection ? matchingPackageCount : selectedPackageCount}
          refreshingPackages={refreshingAgents}
          refreshingPowerPlatform={refreshingPowerPlatformAgents}
          exportingPowerPlatform={exportingPowerPlatformCsv}
          powerPlatformJob={powerPlatformAgentRefreshJob}
          onInspectPowerPlatformJob={setRequestedPowerPlatformJobId}
          onRefreshPackages={() => void handleRefreshAgents()}
          onRefreshMatchingDetails={() => void handleRefreshMatchingDetails()}
          onRefreshPowerPlatform={() => void handleRefreshPowerPlatformAgents()}
          onResumePowerPlatform={() => void handleResumePowerPlatformAgentRefresh()}
          onExportPowerPlatform={() => void handleExportPowerPlatformAgentCsv()}
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
          onSetupRequiredChange={handleSyncSetupRequiredChange}
          onRunsChanged={handleSyncRunsChanged}
          requestedRunId={requestedDataSyncRunId}
          onOpenUsageImport={() => openUsageImport()}
          onRequestedRunChange={handleRequestedSyncRunChange}
          onSourcesChanged={handleDataSyncSourcesChanged}
          onCancelRequested={() => automaticRefresh.setPaused(true)}
        />
      ) : null}
      {visibleActiveView === "sync" ? (
        <>
          {requestedPowerPlatformJobId ? <PowerPlatformSourceJob key={`${principalKey}:${requestedPowerPlatformJobId}`}
            jobId={requestedPowerPlatformJobId} onSelect={setRequestedPowerPlatformJobId}
            onCancelRequested={() => automaticRefresh.setPaused(true)}
            onChanged={() => handleDataSyncSourcesChanged(["power_platform"])} /> : null}
          <LinkedAgentJobStatus refreshJob={linkedPackageRefreshJob} owner={principalKey} error={linkedJobError} />
          <SyncHistoryView key={principalKey} user={user} onOpenSyncRun={handleRequestedSyncRunChange} revision={syncHistoryRevision} />
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
          onImported={finishUsageImport}
        />
      ) : null}

      {inventoryExport?.owner === principalKey ? <div hidden={visibleActiveView !== "agents"
        && !(inventoryExport.kind === "power_platform_agents" && visibleActiveView === "sync")}>
        <ReportExportButton key={inventoryExport.sequence}
          selectionId={inventoryExport.selectionId} kind={inventoryExport.kind} ids={inventoryExport.ids}
          label="Prepare inventory CSV" autoStart onSelectionInvalidated={handleInventoryExportInvalidation}
          onPendingChange={inventoryExport.kind === "power_platform_agents" ? setExportingPowerPlatformCsv : setExportingCsv} />
      </div> : null}
      {blockingFirstSync ? null : visibleActiveView === "permissions" ? <PermissionCenter /> : visibleActiveView === "agents" ? (
        !hasRole(user, "AgentControl.Viewer") ? (
          <>
            <LinkedAgentJobStatus refreshJob={linkedPackageRefreshJob} owner={principalKey} controlJob={requestedPackageControlJobId ? trackedJob : undefined} error={linkedJobError} />
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
          {!canOperate ? <LinkedAgentJobStatus controlJob={requestedPackageControlJobId ? trackedJob : undefined} error={requestedPackageControlJobId ? linkedJobError : undefined} /> : null}
          <div className="agent-catalog-heading">
            <div className="agent-catalog-title">
              <h2 id="agents-heading" tabIndex={-1}>Agents <span>{visibleUnifiedAgentPage?.counts.filtered.toLocaleString() ?? "—"}{hasActiveAgentFilters && inventoryScopeCount !== undefined ? ` of ${inventoryScopeCount.toLocaleString()}` : ""}</span></h2>
            </div>
            {canReadSensitiveUsage ? <AgentInventoryScopes
              inventory={unifiedAgentReadError ? undefined : unifiedAgentPage}
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
                  {loadingAgents ? <span role="status" aria-label="Updating agent results"
                    title="Updating agent results. Previous results remain visible until the current filters and sorting finish loading.">
                    <RefreshCw className="agent-refresh-spinner" size={18} aria-hidden="true" />
                    <span className="sr-only">Updating agent results...</span>
                  </span> : null}
                </span>
                <button
                  type="button"
                  className="secondary agent-export-button"
                  aria-label={exportingCsv ? "Exporting agent inventory CSV" : "Export agent inventory CSV"}
                  title={inventoryUnavailable ? "Collect agent inventory before exporting" : !agentExportRevision ? "Reload saved agent inventory to obtain a valid export revision" : "Export unified agents from the current saved inventory"}
                  disabled={!canReadSensitiveUsage || loadingAgents || deferredQuery !== query || exportingCsv || !agentExportRevision || agentExportNeedsReload || (exportableAgentCount === 0 && selectedExportTargetCount === 0)}
                  onClick={requestExportCsv}
                >
                  <ExportIcon /> <span>Export</span>
                </button>
              </div>
            </div>
          </div>

          {canReadSensitiveUsage ? <AgentInventoryOverview key={principalKey}
            inventory={unifiedAgentReadError ? undefined : visibleUnifiedAgentPage} revision={officialUsageDashboardRevision}
            inventoryScope={agentInventoryScope}
            reportSelector={canImportReports ? <OfficialUsageReportSelector key={`agent-reports:${principalKey}`}
              principalKey={principalKey} revision={officialUsageDashboardRevision} onChanged={handleReportSetSelected} /> : undefined}
            allSelected={!hasActiveAgentFilters} onClearFilters={handleClearAgentFilters}
            endUserAccess={endUserAccess} reportedUsage={reportedUsage}
            onAccessChange={endUserAccess => handleAgentFilterChange({ endUserAccess })}
            onUsageChange={reportedUsage => handleAgentFilterChange({ reportedUsage })} /> : null}

          {agentExportError || agentExportNeedsReload ? <div className="error-banner" role="alert">
            <span>{agentExportError?.message ?? (unifiedAgentReadError
              ? "The current saved agent inventory could not be loaded. Reload the saved inventory before exporting."
              : "A saved agent inventory revision is unavailable. Reload the saved inventory before exporting.")}</span>
            {agentExportNeedsReload ? <button type="button" className="secondary" disabled={loadingAgents} onClick={requestCurrentAgentReload}>Reload saved agent inventory</button> : null}
          </div> : null}
          {matchingPackageSelection ? <p className="selection-summary">Server selection · no target list downloaded · maximum 5,000 targets per job</p> : null}
          {groupTargetKey && groupCount?.error ? <p role="alert">{groupCount.error} Refresh inventory to reselect current groups.</p>
            : groupCountPending ? <p role="status">Counting selected package targets...</p> : null}
          {canOperate && !groupCountPending && (matchingPackageCount > 0 || selectedPackageCount > 0 || busyBulkAction || bulkProgress || bulkResult || trackedJob || bulkJobError || (requestedPackageControlJobId && linkedJobError)) ? <BulkActions
              owner={principalKey}
            disabled={
              Boolean(matchingPackageSelection && (loadingAgents || deferredQuery !== query)) || Boolean(busyAgentId) || Boolean(busyBulkAction) || Boolean(bulkJobCommand)
            }
            busyAction={busyBulkAction}
            progress={bulkProgress}
            result={bulkResult}
            job={trackedJob}
            jobCommand={bulkJobCommand}
            jobError={bulkJobError ?? (requestedPackageControlJobId ? linkedJobError : undefined)}
            selectedCount={matchingPackageSelection ? matchingPackageCount : selectedPackageCount}
            onBlockAll={() => void requestBulkAction(true)}
            onManageAccess={requestBulkAccessUpdate}
            onUnblockAll={() => void requestBulkAction(false)}
            onJobCommand={operation => void handleBulkJobCommand(operation)}
          /> : null}
          {selectionRouteNotice ? (
            <div className={selectionRouteNotice.tone === "error" ? "error-banner" : "report-status"} role="status">
              {selectionRouteNotice.text}
            </div>
          ) : null}

          {canOperate && (selectedPowerPlatformTargets.size > 0 || pendingPowerPlatformIds.size > 0 || requestedQuarantineJobId) ? <CopilotStudioQuarantineControls
            snapshot={selectedQuarantineObservation}
            targets={[...selectedPowerPlatformTargets.values()]}
            variant="bulk"
            canManage={canOperate}
            pendingTargetCount={pendingPowerPlatformIds.size}
            onClear={() => { if (ownsAgentScope(principalKey)) resetPowerPlatformSelection(); }}
            initialJobId={requestedQuarantineJobId}
            onJobChange={job => {
              if (!ownsAgentScope(principalKey)) return;
              setRequestedQuarantineJobId(job.id);
              if (["queued", "running", "waiting_authorization"].includes(job.status)) return;
              const result = JSON.stringify([principalKey, job.id, job.updatedAt, job.status]);
              if (lastQuarantineResult.current === result) return;
              lastQuarantineResult.current = result;
              resetPowerPlatformSelection();
              requestCurrentAgentReload();
            }}
          /> : null}

          {loadingBulkRefSearch ? (
            <div className="screen-state">
              Resolving bulk ref {normalizedBulkRefQuery}...
            </div>
          ) : null}
            <div className="agent-table-stack" aria-busy={loadingAgents}>
              <UnifiedAgentTable
                records={displayedUnifiedAgents}
                loading={loadingAgents && !unifiedAgentPage}
                emptyState={inventoryUnavailable ? <div role="status">
                  <h2>{inventoryUnavailable.state === "preparing" ? "Preparing agent inventory" : "No saved agent inventory yet"}</h2>
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
                  onInvalidated={invalidateAgentSelection}
                  values={{ search: query, packageType, endUserAccess, reportedUsage, management: agentManagement, relevance: agentRelevance,
                    platform: effectivePlatformFilter, availability: availableToFilter,
                    host: hostFilter, status: statusFilter, createdWithinDays, publisher: publisherFilter,
                    environmentId: agentEnvironmentFilter, sortBy: agentSortBy, sortDirection: agentSortDirection }}
                  options={{ platforms: platformOptions, availability: availableToOptions, hosts: hostOptions,
                    publishers: publisherOptions, environments: [],
                    types: [] }}
                  matchingCount={unifiedAgentReadError ? undefined : visibleUnifiedAgentPage?.counts.filtered}
                  loading={loadingAgents || deferredQuery !== query}
                  onChange={handleAgentFilterChange} onClear={handleClearAgentFilters} onError={setError} />}
                selectionAction={canOperate && (visibleUnifiedAgentPage?.counts.packageTargets ?? 0) > 0 ? <button type="button"
                  className="secondary agent-match-select" aria-pressed={Boolean(matchingPackageSelection)}
                  aria-label={matchingPackageSelection ? "Clear all-matching package selection"
                    : `Select all ${visibleUnifiedAgentPage?.counts.packageTargets} matching published versions`}
                  title="Server selection; maximum 5,000 targets per mutation job."
                  disabled={loadingAgents || deferredQuery !== query || Boolean(busyBulkAction)}
                  onClick={() => {
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
                onSortChange={(sortBy, direction) => {
                  setServerPackageSelection(undefined);
                  setAgentSortBy(sortBy);
                  setAgentSortDirection(direction);
                  setAgentPageIndex(0);
                }}
                usageContext={unifiedAgentPage?.usageContext}
                busyPackageId={busyAgentId}
                selectedPackageIds={selectedAgentIds}
                selectedPackageCount={groupCountPending ? 0 : matchingPackageSelection ? matchingPackageCount : selectedPackageCount}
                allPackagesSelected={Boolean(matchingPackageSelection)}
                selectedRecordIds={new Set(selectedGroups.keys())}
                selectedPowerPlatformKeys={new Set(selectedPowerPlatformTargets.keys())}
                packageSelectionAllowed
                packageOperationsAllowed={canOperate}
                quarantineSelectionAllowed={canOperate}
                quarantineSelectionRestoring={pendingPowerPlatformIds.size > 0}
                selectionDisabled={loadingAgents || Boolean(busyBulkAction) || refreshingAgents}
                packageActionsDisabled={Boolean(busyBulkAction) || refreshingAgents}
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
              {visibleUnifiedAgentPage && !unifiedAgentReadError ? <nav aria-label="Agent inventory pages" className="agent-inventory-pagination" aria-busy={loadingAgents}>
                <span role="status">{visibleUnifiedAgentPage.value.length.toLocaleString()} shown · {visibleUnifiedAgentPage.counts.filtered.toLocaleString()} matching agents</span>
                <div className="agent-inventory-page-actions">
                  <button type="button" className="secondary" disabled={loadingAgents || !visibleUnifiedAgentPage.page.previousCursor}
                    onClick={() => { inventoryNavigation.current.cursor = visibleUnifiedAgentPage.page.previousCursor ?? undefined;
                      setAgentPageIndex(index => Math.max(0, index - 1)); }}>Previous</button>
                  <button type="button" className="secondary" disabled={loadingAgents || !visibleUnifiedAgentPage.page.nextCursor}
                    onClick={() => { inventoryNavigation.current.cursor = visibleUnifiedAgentPage.page.nextCursor ?? undefined;
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
          agentInventoryRevision={agentReloadRevision}
          route={usersRoute}
          onRouteChange={handleUsersRouteChange}
          reportSelector={canImportReports ? <OfficialUsageReportSelector key={`user-reports:${principalKey}`}
            principalKey={principalKey} revision={officialUsageDashboardRevision} onChanged={handleReportSetSelected} /> : undefined}
          onOpenAgent={id => {
            if (!ownsAgentScope(principalKey)) return;
            navigateToView("agents");
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

      {loadingAgentDetailId ? (
        <div className="detail-loading" role="status" aria-live="polite">
          Loading agent details...
        </div>
      ) : null}

      {agentDetailError && !agentDetail && !selectedUnifiedAgent ? (
        <div className="error-banner" role="alert">{agentDetailError}</div>
      ) : null}

      {!blockingFirstSync && selectedUnifiedAgent && !singleAccessAgentDetail && !bulkAccessAgentIds && (!bulkConfirmation || inlinePackageConfirmation) ? (
        <UnifiedAgentDetailModal
          selectionId={unifiedAgentDetailPage?.sourcePage?.selection?.id}
          key={principalKey}
          record={selectedUnifiedAgent}
          onOpenPerson={personId => {
            if (!ownsAgentScope(principalKey)) return;
            navigateToView("users");
            handleUsersRouteChange({ view: "responsibility", personId, search: "", page: 0 });
          }}
          usageContext={unifiedAgentDetailPage?.sourcePage?.usageContext}
          inventoryRevision={unifiedAgentDetailPage?.sourcePage?.selection.revision}
          inventoryError={unifiedAgentReadError}
          onRetryInventory={requestCurrentAgentReload}
          onUsageChanged={() => {
            if (ownsAgentScope(principalKey)) requestCurrentAgentReload();
          }}
          onPeopleChanged={() => {
            if (ownsAgentScope(principalKey)) requestCurrentAgentReload();
          }}
          dataRevision={officialUsageDashboardRevision}
          activeTab={agentDetailTab}
          onTabChange={tab => {
            if (busyAgentId) {
              agentDetailRequestId.current += 1;
              agentDetailAbortController.current?.abort();
              setBusyAgentId(undefined);
            }
            setAgentDetailTab(tab);
          }}
          roles={user?.roles ?? []}
          onClose={() => {
            agentDetailRequestId.current += 1;
            agentDetailAbortController.current?.abort();
            setLoadingAgentDetailId(undefined);
            setAgentDetail(undefined);
            setSelectedUnifiedAgent(undefined);
            setAgentPackageSelection(undefined);
            setRequestedAgentDetailId(undefined);
            setBusyAgentId(undefined);
            if (inlinePackageConfirmation) setBulkConfirmation(undefined);
          }}
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
          onUpdatePackageAccess={handleInlineAccessUpdate}
          packageAccessRevisions={packageAccessRevisions}
          packageControlError={packageControlError}
          packageResults={bulkResult?.results}
          onCancelPackageConfirmation={() => setBulkConfirmation(undefined)}
          packageConfirmation={inlinePackageConfirmation && bulkConfirmation ? <BulkConfirmModal
            confirmation={bulkConfirmation} inline
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
          agentCount={bulkAccessSelection?.count ?? bulkAccessAgentIds.length}
          onCancel={() => {
            agentDetailRequestId.current += 1;
            setBulkAccessAgentIds(undefined);
            setBulkAccessSelection(undefined);
          }}
          onSubmit={runBulkAccessUpdate}
        />
      ) : null}

      {bulkConfirmation && !inlinePackageConfirmation ? (
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
}: {
  confirmation: BulkConfirmation;
  onCancel: () => void;
  onConfirm: () => void;
  inline?: boolean;
}) {
  const { summary } = confirmation.preview;
  const isBlockAction = summary.operation === "block" || summary.operation === "unblock";
  const isBlocking = summary.operation === "block";
  const actionLabel = isBlockAction
    ? isBlocking ? "Block" : "Unblock"
    : formatDetailLabel(summary.operation) ?? summary.operation;
  const targetLabel = summary.targetCount === 1 ? "package" : `${summary.targetCount.toLocaleString()} packages`;
  const panel = useRef<HTMLElement>(null);

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
        onCancel();
      } else if (!inline) {
        trapDialogFocus(event, panel.current);
      }
    }

    window.addEventListener("keydown", handleKeyDown);

    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [inline, onCancel]);

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
            {" "}All {summary.targetCount.toLocaleString()} will be {isBlocking ? "blocked" : "unblocked"}.
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
            {isBlockAction ? `${actionLabel} ${targetLabel}` : `Confirm ${actionLabel.toLowerCase()}`}
          </button>
          </WorkbenchActionGate>
        </div>
      </section>
  );
  return inline ? content : <div className="modal-backdrop" role="presentation" onClick={onCancel}>{content}</div>;
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
