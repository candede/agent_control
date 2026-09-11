import type { AppRole, CapabilityId, CapabilityView } from "../../../backend/src/types/capability";
import type { InventoryRefreshJob, InventoryRefreshJobList, InventoryResourcePage, InventorySnapshot, InventorySnapshotList, PowerPlatformResource, PowerPlatformResourceType } from "../../../backend/src/types/powerPlatformInventory";
import type { OfficialUsageAggregateView, OfficialUsageReportKind, OfficialUsageSetSummary, OfficialUsageUserView } from "../../../backend/src/types/officialUsage";
import type { PurviewAuditFilters, PurviewAuditHistory, PurviewAuditJob, PurviewAuditQualification, PurviewAuditRecordPage, PurviewAuditTokenMode } from "../../../backend/src/types/purviewAudit";
import type { DefenderHuntingFilters, DefenderHuntingHistory, DefenderHuntingJob, DefenderHuntingQualificationEvidence, DefenderHuntingRetainedScope, DefenderHuntingRowPage, DefenderHuntingTokenMode } from "../../../backend/src/types/defenderHunting";
import type { QuarantineAction, QuarantineConfirmationSummary, QuarantineJob, QuarantineTargetPage } from "../../../backend/src/types/copilotStudioQuarantine";
import type { InventorySourceAwareDetail, WorkbenchJobsResponse, WorkbenchMetadata } from "../../../backend/src/types/workbench";
export type { InventorySourceAwareDetail, WorkbenchJobSummary, WorkbenchJobsResponse } from "../../../backend/src/types/workbench";
export type { AppRole, CapabilityId, CapabilityStatus, CapabilityView } from "../../../backend/src/types/capability";
export type { InventoryRefreshJob, InventoryResourcePage, InventorySnapshot, InventoryTypeCoverage, PowerPlatformResource, PowerPlatformResourceType } from "../../../backend/src/types/powerPlatformInventory";
export type { InventoryRefreshJobList, InventorySnapshotList } from "../../../backend/src/types/powerPlatformInventory";
export type { OfficialUsageAggregateView, OfficialUsageReportKind, OfficialUsageSetSummary, OfficialUsageUserSummary, OfficialUsageUserView } from "../../../backend/src/types/officialUsage";
export type { PurviewAuditFilters, PurviewAuditHistory, PurviewAuditJob, PurviewAuditQualification, PurviewAuditRecord, PurviewAuditRecordPage, PurviewAuditTokenMode } from "../../../backend/src/types/purviewAudit";
export type { DefenderAgentActivityRow, DefenderAgentInventoryRow, DefenderHuntingFilters, DefenderHuntingHistory, DefenderHuntingJob, DefenderHuntingRow, DefenderHuntingRowPage, DefenderHuntingTokenMode, DefenderInventoryDetailState } from "../../../backend/src/types/defenderHunting";
export type { QuarantineAction, QuarantineConfirmationSummary, QuarantineJob, QuarantineJobStatus, QuarantineTargetCandidate, QuarantineTargetPage } from "../../../backend/src/types/copilotStudioQuarantine";

export type QuarantineStatusView = {
  target: { resourceNativeId: string; displayName: string; environmentId: string; botId: string };
  direct: { isBotQuarantined: boolean; providerUpdatedAt: string; observedAt: string; correlationId: string; source: "cache" | "provider" | "direct" };
  inventory: { isQuarantined: boolean | null; quarantinedAt: string | null; observedAt: string; snapshotId: string };
  disagreesWithInventory: boolean;
};

export type QuarantinePreview = {
  confirmationHash: string;
  summary: QuarantineConfirmationSummary;
  qualification: { qualified: boolean; requiredForSubmit: true };
  statuses: QuarantineStatusView[];
};

export type OfficialUsageStagingPreview = {
  id: string;
  revision: number;
  status: "active" | "accepted" | "replaced" | "expired" | "cancelled";
  kind: OfficialUsageReportKind;
  fileHash: string;
  parserVersion: string;
  schemaVersion: string;
  bundleId: string;
  correctionOfSetId: string | null;
  reportingPeriod: { startDate: string; endDate: string; provenance: "source_metadata" | "operator_asserted" };
  sourceAsOf: string | null;
  sourceAsOfProvenance: "source_metadata" | "operator_asserted" | "absent";
  sourceFreshness: "known" | "unknown";
  downloadedAt: string | null;
  rowCount: number;
  warnings: string[];
  reconciliation: Record<string, unknown>;
  activeRevision: number;
  acceptedVersionId: string | null;
  acceptedSetId: string | null;
  createdAt: string;
  expiresAt: string;
  acceptedAt: string | null;
};

export type OfficialUsageAdminState = {
  activeSetId: string | null;
  activeRevision: number;
  staging: OfficialUsageStagingPreview[];
  sets: OfficialUsageSetSummary[];
};

export type OfficialUsageConfirmation = {
  id: string;
  operation: "select" | "delete";
  setId: string;
  expectedRevision: number;
  confirmationHash: string;
  activeSetId: string | null;
  expiresAt: string;
};

export type OfficialUsageBundlePreview = {
  bundleId: string;
  bundleHash: string;
  expectedActiveRevision: number;
  staging: OfficialUsageStagingPreview[];
  acceptedVersions: Array<{
    kind: OfficialUsageReportKind;
    versionId: string;
    fileHash: string;
    reportingPeriod: { startDate: string; endDate: string; provenance: "source_metadata" | "operator_asserted" };
    sourceAsOf: string | null;
    sourceAsOfProvenance: "source_metadata" | "operator_asserted" | "absent";
  }>;
  missingKinds: OfficialUsageReportKind[];
  reconciliation: Record<string, unknown>;
};

export type SessionUser = {
  displayName: string;
  username: string;
  homeAccountId: string;
  tenantId?: string;
  roles: AppRole[];
};

export type PackageStatus =
  | "all"
  | "some"
  | "none"
  | "allowedForAll"
  | "allowedForSome"
  | "allowedForNoOne"
  | "unknownFutureValue";

export type CopilotPackage = {
  id: string;
  displayName: string;
  type?: string;
  shortDescription?: string;
  isBlocked: boolean;
  supportedHosts?: string[];
  createdDateTime?: string;
  lastModifiedDateTime?: string;
  publisher?: string;
  availableTo?: PackageStatus;
  deployedTo?: PackageStatus;
  elementTypes?: string[];
  platform?: string;
  version?: string;
  manifestVersion?: string;
  manifestId?: string;
  appId?: string;
  assetId?: string;
  sourceSystem: "graph_packages";
  authoringTool: string | null;
  creatorType: "unknown";
  agentKind: "copilot_package";
  lifecycle: "unknown";
  identityConfidence: "exact_native";
  provenance: Record<string, { sourceSystem: "graph_packages"; path: string; maturity: "ga" | "preview" }>;
};

export type PackageAccessEntity = {
  resourceId: string;
  resourceType: "user" | "group" | string;
};

export type PackageAccessTarget = "availability" | "installation";
export type PackageAccessMutationMode = "add" | "replace";
export type PackageAccessScope = "specific" | "none";

export type PackageAccessUpdate =
  | {
      target: PackageAccessTarget;
      mode: "add";
      scope: "specific";
      principals: PackageAccessEntity[];
    }
  | {
      target: PackageAccessTarget;
      mode: "replace";
      scope: "specific";
      principals: PackageAccessEntity[];
    }
  | {
      target: PackageAccessTarget;
      mode: "replace";
      scope: "none";
      principals: never[];
    };

export type PackageAccessReplacement = Extract<
  PackageAccessUpdate,
  { mode: "replace" }
>;

export type PackageAccessUpdateResult = {
  changed: boolean;
  previousCount: number;
  resultingCount: number;
  principals: PackageAccessEntity[];
};

export type DirectoryPrincipal = PackageAccessEntity & {
  displayName: string;
  secondaryText?: string;
  principalKind: "user" | "securityGroup" | "microsoft365Group" | "unknown";
};

export type PackageElementDetail = {
  elementType: string;
  elements: Array<{
    id: string;
    definition: string;
  }>;
};

export type CopilotPackageDetail = CopilotPackage & {
  longDescription?: string;
  categories?: string[];
  sensitivity?: string;
  allowedUsersAndGroups?: PackageAccessEntity[];
  acquireUsersAndGroups?: PackageAccessEntity[];
  elementDetails?: PackageElementDetail[];
  observation?: PackageObservation;
};

export type PackageObservation = {
  observedAt: string;
  expiresAt: string;
  scopeKind: "broad" | "exact";
  source?: "Microsoft Graph package catalog";
  apiMaturity?: "v1.0 read; preview controls";
};

export type PackageSnapshot = PackageObservation & {
  id: string;
  tokenMode: "delegated" | "application";
  requestedIds: string[];
  observedCount: number;
  totalRecords: number;
  pageCount: number;
};

export type PackagePage = {
  value: CopilotPackage[];
  count: number;
  snapshot: PackageSnapshot | null;
  summary: PackageCountSummary;
  filteredSummary: PackageCountSummary;
  facets: {
    publishers: PackageFacetOption[];
    availability: PackageFacetOption[];
    hosts: PackageFacetOption[];
    platforms: PackageFacetOption[];
  };
};

export type PackageCountSummary = { total: number; allowed: number; blocked: number };
export type PackageFacetOption = { value: string; label: string };
export type PackageListQuery = {
  snapshotId?: string;
  search?: string;
  operationIdPrefix?: string;
  blocked?: boolean;
  publisher?: string;
  availableTo?: string;
  host?: string;
  platform?: string;
  createdWithinDays?: number;
  sortBy?: "displayName" | "publisher" | "lastModifiedAt";
  sortDirection?: "asc" | "desc";
  limit?: number;
  offset?: number;
};

export type PackageRefreshJob = {
  id: string;
  authorizationPrincipalId: string;
  tokenMode: "delegated" | "application";
  scopeKind: "broad" | "exact";
  requestedIds: string[];
  status: "waiting_authorization" | "running" | "succeeded" | "failed";
  pageCount: number;
  observedCount: number;
  totalRecords: number | null;
  snapshotId: string | null;
  errorCode?: string;
  message?: string;
  createdAt: string;
  attemptedAt: string | null;
  updatedAt: string;
  finishedAt: string | null;
};

export type BulkPackageResult = {
  id: string;
  displayName: string;
  status: "succeeded" | "failed" | "skipped" | "inconclusive" | "cancelled";
  message?: string;
  errorCode?: string;
  errorDetails?: unknown;
  accessResult?: PackageAccessUpdateResult;
  correlationId?: string;
  prestateHash?: string;
  poststateHash?: string;
  reconciliationStatus?: "not_required" | "required" | "verified_applied" | "verified_not_applied" | "conflict";
  retryEligible?: boolean;
};

export type BulkSideEffectError = {
  phase: "start" | "result";
  agentId: string;
  message: string;
};

type BulkActionResultBase = {
  total: number;
  succeeded: number;
  failed: number;
  skipped: number;
  results: BulkPackageResult[];
  sideEffectErrors?: BulkSideEffectError[];
};

export type BulkActionResult = BulkActionResultBase &
  (
    | { targetBlockedState: boolean; accessUpdate?: never }
    | { targetBlockedState?: never; accessUpdate: PackageAccessUpdate }
  );

export type BulkJobStatus = "queued" | "running" | "waiting_authorization" | "succeeded" | "failed" | "cancelled" | "partial";

type BulkActionJobBase = {
  id: string;
  status: BulkJobStatus;
  canResume: boolean;
  total: number;
  completed: number;
  succeeded: number;
  failed: number;
  skipped: number;
  results: BulkPackageResult[];
  result?: BulkActionResult;
  currentAgentName?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
};

export type BulkActionJob = BulkActionJobBase &
  (
    | {
        action: BlockAuditAction;
        targetBlockedState: boolean;
        accessUpdate?: never;
      }
    | {
        action: AccessAuditAction;
        targetBlockedState?: never;
        accessUpdate: PackageAccessUpdate;
      }
  );

export type BulkPackageDetailResult =
  | {
      id: string;
      status: "succeeded";
      package: CopilotPackageDetail;
    }
  | {
      id: string;
      status: "failed";
      message: string;
    };

export type BulkPackageDetailsResult = {
  total: number;
  succeeded: number;
  failed: number;
  results: BulkPackageDetailResult[];
};

export type BlockAuditAction = "block" | "unblock";
export type AccessAuditAction = "update-availability" | "update-installation";
export type ReassignAuditAction = "reassign";
export type AuditAction = BlockAuditAction | AccessAuditAction | ReassignAuditAction;
export type ProviderAuditReadAction = "view-audit-search" | "export-audit-search";
export type HuntingReadAction = "view-hunting" | "export-hunting";
export type HuntingLifecycleAction = "approve-hunting" | "qualify-hunting" | "submit-hunting" | "query-hunting" | "cancel-hunting" | "delete-hunting";
export type InventoryExportAction = "export-package-inventory" | "export-power-platform-inventory";
export type ReportExportAction = "export-official-usage-aggregate" | "export-official-usage-users";
export type LocalAuditAction = AuditAction | ProviderAuditReadAction | HuntingReadAction | HuntingLifecycleAction | InventoryExportAction | ReportExportAction | "export-administrative-audit";

export type PackageMutationState = Record<string, unknown>;

export type PackageMutationConfirmationSummary = {
  risk: true;
  operation: AuditAction;
  provider: "Microsoft Graph";
  endpoint: string;
  apiMaturity: "preview";
  permission: "Delegated CopilotPackages.ReadWrite.All";
  actor: { id: string; displayName: string; username: string };
  scope: AuditScope;
  targetCount: number;
  affectedPrincipalCount: number;
  rollback: string;
  targetSelectionHash: string;
  targets: Array<{
    id: string;
    displayName: string;
    currentState: PackageMutationState;
    requestedState: PackageMutationState;
  }>;
  additionalTargetCount: number;
};

export type PackageMutationPreview = {
  confirmationHash: string;
  summary: PackageMutationConfirmationSummary;
};

export type AuditScope = "single" | "bulk";

export type AuditStatus = "requested" | "started" | "succeeded" | "failed" | "skipped" | "inconclusive" | "cancelled";

type AuditEventBase = {
  id: string;
  operationId: string;
  scope: AuditScope;
  agentId: string;
  agentDisplayName?: string;
  actor: SessionUser;
  startedAt: string;
  completedAt?: string;
  status: AuditStatus;
  message?: string;
  errorCode?: string;
  requestPath: string;
  metadata?: Record<string, unknown>;
};

export type AuditEvent = AuditEventBase &
  (
    | { action: BlockAuditAction; targetBlockedState: boolean }
    | { action: AccessAuditAction | ReassignAuditAction | ProviderAuditReadAction | HuntingReadAction | HuntingLifecycleAction | InventoryExportAction | ReportExportAction; targetBlockedState?: never }
  );

export type AuditEventsQuery = {
  limit?: number;
  offset?: number;
  agentId?: string;
  actorUsername?: string;
  scope?: AuditScope;
  action?: LocalAuditAction;
  status?: AuditStatus;
  operationIdPrefix?: string;
  search?: string;
};

export type AuditEventsResponse = {
  value: AuditEvent[];
  count: number;
};

export type InventoryListQuery = {
  snapshotId?: string;
  type?: PowerPlatformResourceType;
  environmentId?: string;
  search?: string;
  sortBy?: "displayName" | "type" | "environmentId" | "createdAt" | "lastPublishedAt";
  sortDirection?: "asc" | "desc";
  limit?: number;
  offset?: number;
};

export type AuditRequestContext = {
  actionGroupId?: string;
};

export class ApiError extends Error {
  status: number;
  code: string;
  requestId?: string;
  type?: string;
  kind: "problem" | "aborted" | "network";

  constructor(
    status: number,
    code: string,
    message: string,
    options: { requestId?: string; type?: string; kind?: "problem" | "aborted" | "network" } = {},
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.requestId = options.requestId;
    this.type = options.type;
    this.kind = options.kind ?? "problem";
  }

  get authenticationExpired() {
    return this.status === 401 || ["interaction_required", "authorization_expired", "unauthorized"].includes(this.code);
  }
}

let csrfToken: string | undefined;
const sessionRevalidationListeners = new Set<(error: ApiError) => void>();

export function subscribeSessionRevalidationRequired(listener: (error: ApiError) => void) {
  sessionRevalidationListeners.add(listener);
  return () => {
    sessionRevalidationListeners.delete(listener);
  };
}

export async function getCurrentUser() {
  const result = await request<{ user: SessionUser; csrfToken: string; roleAssignmentRequired: boolean }>("/api/me");
  csrfToken = result.csrfToken;
  return result;
}

export function getCapabilities() {
  return request<{ value: CapabilityView[] }>("/api/capabilities");
}

export function getWorkbenchMetadata(options: { signal?: AbortSignal } = {}) {
  return request<WorkbenchMetadata>("/api/workbench/metadata", { signal: options.signal });
}

export function getWorkbenchJobs(options: { signal?: AbortSignal } = {}) {
  return request<WorkbenchJobsResponse>("/api/workbench/jobs", { signal: options.signal });
}

export function beginCapabilityConsent(capabilityId: CapabilityId, returnTo = "/") {
  return request<{ authorizationUrl: string }>("/api/auth/consent", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ capabilityId, returnTo }) });
}

export function refreshCapability(capabilityId: CapabilityId) {
  return request<CapabilityView["decision"]>(`/api/capabilities/${encodeURIComponent(capabilityId)}/probe`, { method: "POST" });
}

export function configureApplicationCapability(capabilityId: CapabilityId, enabled: boolean, sharedDataScope: boolean) {
  return request(`/api/capabilities/${encodeURIComponent(capabilityId)}/configuration`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled, sharedDataScope }) });
}

export async function getAgents(query: PackageListQuery = {}, options: { signal?: AbortSignal } = {}) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== "") params.set(key, String(value));
  }
  return request<PackagePage>(`/api/agents${params.size ? `?${params}` : ""}`, { signal: options.signal });
}

export async function downloadPackageInventoryCsv(input: { ids?: string[]; snapshotId: string; filters?: Omit<PackageListQuery, "snapshotId" | "limit" | "offset"> }) {
  const response = await fetch("/api/agents/export.csv", {
    method: "POST",
    credentials: "include",
    headers: {
      Accept: "text/csv",
      "Content-Type": "application/json",
      ...(csrfToken ? { "X-CSRF-Token": csrfToken } : {}),
    },
    body: JSON.stringify(input),
  });
  if (!response.ok) throw await toApiError(response);
  return response.blob();
}

export function startPackageRefresh(mode: "delegated" | "application" = "delegated") {
  return request<PackageRefreshJob>("/api/agents/refresh-jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode }),
  });
}

export function startExactPackageRefresh(id: string, mode: "delegated" | "application" = "delegated") {
  return request<PackageRefreshJob>(`/api/agents/${encodeURIComponent(id)}/refresh-jobs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode }),
  });
}

export function getPackageRefreshJob(
  id: string,
  mode: "delegated" | "application" = "delegated",
  options: { signal?: AbortSignal } = {},
) {
  return request<PackageRefreshJob>(`/api/agents/refresh-jobs/${encodeURIComponent(id)}?mode=${mode}`, { signal: options.signal });
}

export function getPackageRefreshJobs(mode: "delegated" | "application" = "delegated", limit = 20) {
  return request<{ value: PackageRefreshJob[]; lastAttemptAt: string | null; lastSuccessAt: string | null }>(
    `/api/agents/refresh-jobs?mode=${mode}&limit=${limit}`,
  );
}

export function resumePackageRefreshJob(id: string, mode: "delegated" | "application" = "delegated") {
  return request<PackageRefreshJob>(`/api/agents/refresh-jobs/${encodeURIComponent(id)}/resume`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode }),
  });
}

export function getInventoryResources(query: InventoryListQuery = {}, options: { signal?: AbortSignal } = {}) {
  const params = inventorySearchParams(query);
  return request<InventoryResourcePage>(`/api/inventory/resources${params.size ? `?${params}` : ""}`, { signal: options.signal });
}

export function getInventorySourceAwareDetail(input: {
  snapshotId: string;
  nativeId: string;
  type: PowerPlatformResourceType;
  environmentId: string | null;
}, options: { signal?: AbortSignal } = {}) {
  const params = new URLSearchParams({
    snapshotId: input.snapshotId,
    type: input.type,
    environmentId: input.environmentId ?? "",
  });
  return request<InventorySourceAwareDetail>(`/api/inventory/resources/${encodeURIComponent(input.nativeId)}/related?${params}`, { signal: options.signal });
}

export function getInventoryQuarantineSelection(snapshotId: string, nativeIds: string[], options: { signal?: AbortSignal } = {}) {
  const params = new URLSearchParams({ snapshotId });
  for (const id of nativeIds) params.append("selected", id);
  return request<{ value: PowerPlatformResource[]; snapshot: InventorySnapshot }>(`/api/inventory/quarantine-selection?${params}`, { signal: options.signal });
}

export function refreshInventory(scope: { types?: PowerPlatformResourceType[]; environmentId?: string } = {}) {
  return request<InventoryRefreshJob>("/api/inventory/refresh-jobs", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(scope),
  });
}

export function getInventoryRefreshJobs(options: { signal?: AbortSignal } = {}) {
  return request<InventoryRefreshJobList>("/api/inventory/refresh-jobs", { signal: options.signal });
}

export function getInventorySnapshots(options: { signal?: AbortSignal } = {}) {
  return request<InventorySnapshotList>("/api/inventory/snapshots", { signal: options.signal });
}

export function getInventoryRefreshJob(id: string, options: { signal?: AbortSignal } = {}) {
  return request<InventoryRefreshJob>(`/api/inventory/refresh-jobs/${encodeURIComponent(id)}`, { signal: options.signal });
}

export function resumeInventoryRefresh(id: string) {
  return request<InventoryRefreshJob>(`/api/inventory/refresh-jobs/${encodeURIComponent(id)}/resume`, { method: "POST" });
}

export function getQuarantineTargets(query: { search?: string; limit?: number; offset?: number } = {}) {
  const params = new URLSearchParams();
  if (query.search) params.set("search", query.search);
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  if (query.offset !== undefined) params.set("offset", String(query.offset));
  return request<QuarantineTargetPage>(`/api/quarantine/targets${params.size ? `?${params}` : ""}`);
}

export function getQuarantineStatus(snapshotId: string, nativeId: string, force = false) {
  const params = new URLSearchParams({ snapshotId, nativeId });
  if (force) params.set("force", "true");
  return request<QuarantineStatusView>(`/api/quarantine/status?${params}`);
}

export function previewQuarantine(input: { action: QuarantineAction; snapshotId: string; resourceNativeIds: string[]; forceStatus?: boolean }) {
  return request<QuarantinePreview>("/api/quarantine/preview", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input),
  });
}

export function submitQuarantine(input: { action: QuarantineAction; snapshotId: string; resourceNativeIds: string[]; confirmationHash: string }, idempotencyKey: string) {
  return request<QuarantineJob>("/api/quarantine/jobs", {
    method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey }, body: JSON.stringify(input),
  });
}

export function getQuarantineJobs(limit = 20) {
  return request<{ value: QuarantineJob[] }>(`/api/quarantine/jobs?limit=${limit}`);
}

export function getQuarantineJob(id: string, options: { signal?: AbortSignal } = {}) {
  return request<QuarantineJob>(`/api/quarantine/jobs/${encodeURIComponent(id)}`, { signal: options.signal });
}

export function cancelQuarantineJob(id: string) {
  return request<QuarantineJob>(`/api/quarantine/jobs/${encodeURIComponent(id)}/cancel`, { method: "POST" });
}

export function resumeQuarantineJob(id: string) {
  return request<QuarantineJob>(`/api/quarantine/jobs/${encodeURIComponent(id)}/resume`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirmed: true }),
  });
}

export function reconcileQuarantineJob(id: string) {
  return request<QuarantineJob>(`/api/quarantine/jobs/${encodeURIComponent(id)}/reconcile`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}),
  });
}

export async function downloadInventoryCsv(query: InventoryListQuery = {}) {
  const params = inventorySearchParams(query);
  const response = await fetch(`/api/inventory/export.csv${params.size ? `?${params}` : ""}`, { credentials: "include", headers: { Accept: "text/csv" } });
  if (!response.ok) throw await toApiError(response);
  return response.blob();
}

export function getOfficialUsageAdminState(options: { signal?: AbortSignal } = {}) {
  return request<OfficialUsageAdminState>("/api/official-usage/admin", { signal: options.signal });
}

export function stageOfficialUsageReport(file: File, input: {
  bundleId: string;
  correctionOfSetId?: string;
  reportingStart: string;
  reportingEnd: string;
  periodProvenance: "source_metadata" | "operator_asserted";
  sourceAsOf?: string;
  sourceAsOfProvenance?: "source_metadata" | "operator_asserted";
}) {
  const form = new FormData();
  form.append("file", file);
  for (const [key, value] of Object.entries({ ...input, downloadedAt: new Date().toISOString() })) {
    if (value !== undefined) form.append(key, value);
  }
  return request<OfficialUsageStagingPreview>("/api/official-usage/staging", { method: "POST", body: form });
}

export function discardOfficialUsageStaging(id: string) {
  return request<void>(`/api/official-usage/staging/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export function previewOfficialUsageBundle(bundleId: string, options: { signal?: AbortSignal } = {}) {
  return request<OfficialUsageBundlePreview>(`/api/official-usage/bundles/${encodeURIComponent(bundleId)}/preview`, { method: "POST", signal: options.signal });
}

export function acceptOfficialUsageBundle(preview: OfficialUsageBundlePreview) {
  return request<{ setId: string; versionId: string; activeRevision: number; complete: boolean }>(`/api/official-usage/bundles/${encodeURIComponent(preview.bundleId)}/accept`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ bundleHash: preview.bundleHash, expectedActiveRevision: preview.expectedActiveRevision }),
  });
}

export function previewOfficialUsageSetOperation(setId: string, operation: "select" | "delete") {
  return request<OfficialUsageConfirmation>(`/api/official-usage/sets/${encodeURIComponent(setId)}/preview`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ operation }),
  });
}

export function confirmOfficialUsageSetOperation(confirmation: OfficialUsageConfirmation) {
  return request<{ activeSetId: string | null; activeRevision: number }>(`/api/official-usage/confirmations/${encodeURIComponent(confirmation.id)}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(confirmation),
  });
}

export function acknowledgeLegacyUsageCleanup(disposition: "reimported" | "discarded") {
  return request<void>("/api/official-usage/legacy-cleanup-acknowledgements", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ disposition }),
  });
}

export function getOfficialUsageAggregate(
  query: { inactiveDays?: number; activityWindowDays?: number; limit?: number; offset?: number } = {},
  options: { signal?: AbortSignal } = {},
) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) if (value !== undefined) params.set(key, String(value));
  return request<OfficialUsageAggregateView>(`/api/official-usage/aggregate${params.size ? `?${params}` : ""}`, { signal: options.signal });
}

export type OfficialUsageUserQuery = {
  search?: string;
  creatorType?: string;
  activity?: "all" | "recent" | "inactive" | "no-activity";
  responsesOnly?: boolean;
  inactiveDays?: number;
  limit?: number;
  offset?: number;
};

export function getOfficialUsageUsers(query: OfficialUsageUserQuery = {}, options: { signal?: AbortSignal } = {}) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) if (value !== undefined) params.set(key, String(value));
  return request<OfficialUsageUserView>(`/api/official-usage/users${params.size ? `?${params}` : ""}`, { signal: options.signal });
}

export type PurviewAuditCatalog = {
  presets: Array<{ id: PurviewAuditFilters["presetId"]; label: string; service: string; recordTypes: string[]; operations: string[] }>;
  limits: { maximumWindowHours: number; qualificationWindowHours: number; maximumPages: number; maximumRows: number; maximumBytes: number; pollsPerActivation: number;
    providerRequests: number; activations: number };
  evidenceNotice: string;
  contentNotice: string;
  retentionNotice: string;
};

export function getPurviewAuditCatalog() {
  return request<PurviewAuditCatalog>("/api/audit-search/catalog");
}

export function getPurviewAuditJobs(limit = 20, offset = 0) {
  const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  return request<PurviewAuditHistory>(`/api/audit-search/jobs?${params}`);
}

export function getPurviewAuditJob(id: string, options: { signal?: AbortSignal } = {}) {
  return request<PurviewAuditJob>(`/api/audit-search/jobs/${encodeURIComponent(id)}`, { signal: options.signal });
}

export function submitPurviewAuditSearch(tokenMode: PurviewAuditTokenMode, filters: PurviewAuditFilters) {
  return request<PurviewAuditJob>("/api/audit-search/jobs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tokenMode, filters }) });
}

export function getPurviewAuditRecords(id: string, limit = 100, offset = 0) {
  const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  return request<PurviewAuditRecordPage>(`/api/audit-search/jobs/${encodeURIComponent(id)}/records?${params}`);
}

export function resumePurviewAuditSearch(id: string) {
  return request<PurviewAuditJob>(`/api/audit-search/jobs/${encodeURIComponent(id)}/resume`, { method: "POST" });
}

export function cancelPurviewAuditSearch(id: string) {
  return request<PurviewAuditJob>(`/api/audit-search/jobs/${encodeURIComponent(id)}/cancel`, { method: "POST" });
}

export function deletePurviewAuditSearch(id: string) {
  return request<void>(`/api/audit-search/jobs/${encodeURIComponent(id)}`, {
    method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirmation: id }),
  });
}

export function approvePurviewAuditQualification(tokenMode: PurviewAuditTokenMode, filters: PurviewAuditFilters) {
  return request<PurviewAuditQualification>("/api/audit-search/qualifications", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tokenMode, filters }) });
}

export function startPurviewAuditQualification(id: string) {
  return request<PurviewAuditJob>(`/api/audit-search/qualifications/${encodeURIComponent(id)}/start`, { method: "POST" });
}

export async function downloadPurviewAuditCsv(id: string) {
  const response = await fetch(`/api/audit-search/jobs/${encodeURIComponent(id)}/export.csv`, { credentials: "include", headers: { Accept: "text/csv" } });
  if (!response.ok) throw await toApiError(response);
  return response.blob();
}

export type DefenderHuntingCatalog = {
  templates: Array<{ id: DefenderHuntingFilters["templateId"]; label: string; sourceTable: "AgentsInfo" | "CloudAppEvents"; operations: string[] }>;
  qualifications: DefenderHuntingQualificationEvidence[];
  retainedScopes: DefenderHuntingRetainedScope[];
  limits: { maximumWindowHours: number; qualificationWindowHours: number; maximumRows: number; maximumBytes: number; providerRequests: number; activations: number };
  scopeNotice: string;
  contentNotice: string;
  readinessNotice: string;
  retentionNotice: string;
  defenderPortalUrl: string;
};

export function getDefenderHuntingCatalog() {
  return request<DefenderHuntingCatalog>("/api/hunting/catalog");
}

export function getDefenderHuntingJobs(limit = 20, offset = 0) {
  const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  return request<DefenderHuntingHistory>(`/api/hunting/jobs?${params}`);
}

export function getDefenderHuntingJob(id: string, options: { signal?: AbortSignal } = {}) {
  return request<DefenderHuntingJob>(`/api/hunting/jobs/${encodeURIComponent(id)}`, { signal: options.signal });
}

export function submitDefenderHunt(tokenMode: DefenderHuntingTokenMode, filters: DefenderHuntingFilters) {
  return request<DefenderHuntingJob>("/api/hunting/jobs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tokenMode, filters }) });
}

export function getDefenderHuntingRows(id: string, limit = 100, offset = 0) {
  const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  return request<DefenderHuntingRowPage>(`/api/hunting/jobs/${encodeURIComponent(id)}/rows?${params}`);
}

export function resumeDefenderHunt(id: string) {
  return request<DefenderHuntingJob>(`/api/hunting/jobs/${encodeURIComponent(id)}/resume`, { method: "POST" });
}

export function cancelDefenderHunt(id: string) {
  return request<DefenderHuntingJob>(`/api/hunting/jobs/${encodeURIComponent(id)}/cancel`, { method: "POST" });
}

export function deleteDefenderHunt(id: string) {
  return request<void>(`/api/hunting/jobs/${encodeURIComponent(id)}`, { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirmation: id }) });
}

export function approveDefenderHuntingQualification(tokenMode: DefenderHuntingTokenMode, filters: DefenderHuntingFilters) {
  return request<DefenderHuntingJob>("/api/hunting/qualifications", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tokenMode, filters }) });
}

export function startDefenderHuntingQualification(id: string) {
  return request<DefenderHuntingJob>(`/api/hunting/qualifications/${encodeURIComponent(id)}/start`, { method: "POST" });
}

export function revokeDefenderHuntingRetainedScope(id: string) {
  return request<DefenderHuntingRetainedScope>(`/api/hunting/retained-scopes/${encodeURIComponent(id)}/revoke`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirmation: id }),
  });
}

export async function downloadDefenderHuntingCsv(id: string) {
  const response = await fetch(`/api/hunting/jobs/${encodeURIComponent(id)}/export.csv`, { credentials: "include", headers: { Accept: "text/csv" } });
  if (!response.ok) throw await toApiError(response);
  return response.blob();
}

export async function downloadOfficialUsageCsv(kind: "aggregate" | "users") {
  const response = await fetch(`/api/official-usage/${kind}.csv`, { credentials: "include", headers: { Accept: "text/csv" } });
  if (!response.ok) throw await toApiError(response);
  return response.blob();
}

function inventorySearchParams(query: InventoryListQuery) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) if (value !== undefined && value !== "") params.set(key, String(value));
  return params;
}

export async function getAgentDetails(id: string) {
  return request<CopilotPackageDetail>(`/api/agents/${encodeURIComponent(id)}`);
}

export async function getAgentDetailsBatch(ids: string[]) {
  return request<BulkPackageDetailsResult>("/api/agents/details", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids }),
  });
}

export async function searchDirectoryPrincipals(search: string, limit = 25) {
  const params = new URLSearchParams({ search, limit: String(limit) });
  return request<{ value: DirectoryPrincipal[] }>(
    `/api/directory/principals?${params.toString()}`,
  );
}

export async function resolveDirectoryPrincipals(
  principals: PackageAccessEntity[],
) {
  return request<{ value: DirectoryPrincipal[] }>(
    "/api/directory/principals/resolve",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ principals }),
    },
  );
}

export async function updateAgentAccess(
  id: string,
  update: PackageAccessReplacement,
  confirmationHash: string,
) {
  return request<BulkActionJob>(`/api/agents/${encodeURIComponent(id)}/access`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...update, confirmationHash }),
  });
}

export async function updateAgentsAccess(
  ids: string[],
  update: PackageAccessUpdate,
  confirmationHash: string,
) {
  return request<BulkActionJob>("/api/agents/access", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids, ...update, confirmationHash }),
  });
}

export function previewPackageMutation(input: {
  action: AuditAction;
  ids: string[];
  mutationScope: AuditScope;
  accessUpdate?: PackageAccessUpdate;
}) {
  return request<PackageMutationPreview>("/api/agents/mutation-preview", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: input.action,
      ids: input.ids,
      mutationScope: input.mutationScope,
      ...input.accessUpdate,
    }),
  });
}

export async function blockAgent(id: string, confirmationHash: string, context?: AuditRequestContext) {
  return request<BulkActionJob>(`/api/agents/${encodeURIComponent(id)}/block`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...auditContextHeaders(context) },
    body: JSON.stringify({ confirmationHash }),
  });
}

export async function unblockAgent(id: string, confirmationHash: string, context?: AuditRequestContext) {
  return request<BulkActionJob>(`/api/agents/${encodeURIComponent(id)}/unblock`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...auditContextHeaders(context) },
    body: JSON.stringify({ confirmationHash }),
  });
}

export async function blockAgents(ids: string[], confirmationHash: string) {
  return request<BulkActionJob>("/api/agents/block", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids, confirmationHash }),
  });
}

export async function unblockAgents(ids: string[], confirmationHash: string) {
  return request<BulkActionJob>("/api/agents/unblock", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids, confirmationHash }),
  });
}

export async function getBulkActionJob(id: string, options: { signal?: AbortSignal } = {}) {
  return request<BulkActionJob>(
    `/api/agents/bulk-jobs/${encodeURIComponent(id)}`,
    { signal: options.signal },
  );
}

export function getBulkActionJobs(limit = 20) {
  return request<{ value: BulkActionJob[] }>(`/api/agents/bulk-jobs?limit=${limit}`);
}

export function reconcileBulkActionJob(id: string) {
  return request<BulkActionJob & { reconciliation: { attempted: number; failed: number; errors: Array<{ id: string; message: string }> } }>(
    `/api/agents/bulk-jobs/${encodeURIComponent(id)}/reconcile`,
    { method: "POST" },
  );
}

export async function blockAllAgents(confirmationHash: string) {
  return request<BulkActionJob>("/api/agents/block-all", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirmationHash }),
  });
}

export async function unblockAllAgents(confirmationHash: string) {
  return request<BulkActionJob>("/api/agents/unblock-all", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirmationHash }),
  });
}

export async function downloadAdministrativeAuditCsv(ids: string[], signal?: AbortSignal) {
  const response = await fetch("/api/audit/events/export.csv", {
    method: "POST", credentials: "include", signal,
    headers: { Accept: "text/csv", "Content-Type": "application/json", ...(csrfToken ? { "X-CSRF-Token": csrfToken } : {}) },
    body: JSON.stringify({ ids }),
  });
  if (!response.ok) throw await toApiError(response);
  return response.blob();
}

export async function getAuditEvents(query: AuditEventsQuery = {}) {
  const searchParams = new URLSearchParams();

  if (query.limit) {
    searchParams.set("limit", query.limit.toString());
  }

  if (query.offset !== undefined) {
    searchParams.set("offset", query.offset.toString());
  }

  if (query.agentId) {
    searchParams.set("agentId", query.agentId);
  }

  if (query.actorUsername) {
    searchParams.set("actorUsername", query.actorUsername);
  }

  if (query.scope) {
    searchParams.set("scope", query.scope);
  }

  if (query.action) {
    searchParams.set("action", query.action);
  }

  if (query.status) {
    searchParams.set("status", query.status);
  }

  if (query.operationIdPrefix) {
    searchParams.set("operationIdPrefix", query.operationIdPrefix);
  }

  if (query.search) {
    searchParams.set("search", query.search);
  }

  const queryString = searchParams.toString();
  return request<AuditEventsResponse>(
    `/api/audit/events${queryString ? `?${queryString}` : ""}`,
  );
}

export async function signOut() {
  await request<void>("/api/auth/logout", { method: "POST" });
  csrfToken = undefined;
}

function auditContextHeaders(context: AuditRequestContext | undefined) {
  return context?.actionGroupId
    ? { "x-agent-control-action-group-id": context.actionGroupId }
    : undefined;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      credentials: "include",
      headers: {
        Accept: "application/json",
        ...(init.method && init.method !== "GET" ? { "Idempotency-Key": crypto.randomUUID() } : {}),
        ...(init.method && !["GET", "HEAD", "OPTIONS"].includes(init.method) && csrfToken ? { "X-CSRF-Token": csrfToken } : {}),
        ...init.headers,
      },
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new ApiError(0, "request_aborted", "The request was cancelled.", { kind: "aborted" });
    }
    throw new ApiError(0, "network_error", "The server could not be reached.", { kind: "network" });
  }

  if (!response.ok) {
    throw await toApiError(response);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}

export function cancelBulkActionJob(id: string) {
  return request<BulkActionJob>(`/api/agents/bulk-jobs/${encodeURIComponent(id)}/cancel`, { method: "POST" });
}

export function resumeBulkActionJob(id: string) {
  return request<BulkActionJob>(`/api/agents/bulk-jobs/${encodeURIComponent(id)}/resume`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirmed: true }),
  });
}

async function toApiError(response: Response) {
  let error: ApiError;
  try {
    const body = (await response.json()) as {
      type?: string;
      status?: number;
      detail?: string;
      code?: string;
      requestId?: string;
    };

    error = new ApiError(
      body.status === response.status ? body.status : response.status,
      body.code ?? "request_failed",
      body.detail ?? `Request failed with status ${response.status}.`,
      {
        requestId: body.requestId ?? response.headers.get("X-Request-ID") ?? undefined,
        type: body.type,
      },
    );
  } catch {
    error = new ApiError(
      response.status,
      "request_failed",
      `Request failed with status ${response.status}.`,
    );
  }
  const sessionRevalidationRequired = error.status === 401
    || (error.status === 403 && error.code === "missing_internal_role");
  if (sessionRevalidationRequired) {
    if (error.status === 401) csrfToken = undefined;
    for (const listener of sessionRevalidationListeners) {
      try {
        listener(error);
      } catch {
        // A consumer must not hide the original typed API failure.
      }
    }
  }
  return error;
}
