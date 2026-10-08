import type { AppRole, CapabilityCheckProgress, CapabilityView } from "../../../backend/src/types/capability";
import { capabilityIds, supportsAutomaticCapabilityCheck } from "../../../backend/src/types/capability";
import type {
  CopilotPackage, CopilotPackageDetail as StoredPackageDetail, PackageAccessEntity,
  PackageAccessUpdate, PackageAccessUpdateResult,
} from "../../../backend/src/types/copilotPackage";
export type {
  CopilotPackage, PackageStatus, PackageAccessEntity, PackageAccessTarget,
  PackageAccessMutationMode, PackageAccessUpdate,
} from "../../../backend/src/types/copilotPackage";
import type { InventoryRefreshJob, InventoryRefreshJobList, PowerPlatformResourceType } from "../../../backend/src/types/powerPlatformInventory";
export { powerPlatformResourceTypes } from "../../../backend/src/types/powerPlatformInventory";
import type { PurviewAuditFilters, PurviewAuditHistory, PurviewAuditJob, PurviewAuditQualification, PurviewAuditRecordPage, PurviewAuditTokenMode } from "../../../backend/src/types/purviewAudit";
import type { DefenderHuntingFilters, DefenderHuntingHistory, DefenderHuntingJob, DefenderHuntingQualificationEvidence, DefenderHuntingRetainedScope, DefenderHuntingRowPage, DefenderHuntingTokenMode } from "../../../backend/src/types/defenderHunting";
import type { AutomaticRefreshResult, DataSyncRun, DataSyncState, StartDataSyncInput } from "../../../backend/src/types/dataSync";
import type { QuarantineAction, QuarantineConfirmationSummary, QuarantineJob } from "../../../backend/src/types/copilotStudioQuarantine";
import type { WorkbenchJobsResponse, WorkbenchMetadata } from "../../../backend/src/types/workbench";
import type { UnifiedAgentInventoryPage, UnifiedAgentInventoryQuery, UnifiedAgentInventoryUnavailable, UnifiedAgentRecord } from "../../../backend/src/types/unifiedAgents";
import { encodeInventoryFacet, inventoryFacetFields, type InventoryFacetValue } from "../../../backend/src/types/inventoryFacets";
import type { AgentInvestigationContext, AgentPurviewRecordPage } from "../../../backend/src/types/agentInvestigations";
export type { AgentInvestigationContext } from "../../../backend/src/types/agentInvestigations";
import type { AgentResponsibilityPage, AgentResponsibilityQuery } from "../../../backend/src/types/agentResponsibility";
export type { AgentResponsibilityPage } from "../../../backend/src/types/agentResponsibility";
import type { AgentUsageAuditAction, InventoryExportAction } from "../../../backend/src/types/audit";
export type { InventorySourceAwareDetail, WorkbenchJobSummary, WorkbenchJobsResponse } from "../../../backend/src/types/workbench";
export type { AppRole, CapabilityCheckProgress, CapabilityId, CapabilityStatus, CapabilityView } from "../../../backend/src/types/capability";
export type { InventoryCoverageStatus, InventoryRefreshJob, InventorySnapshot, InventorySnapshotVerification, PowerPlatformResource, PowerPlatformResourceType } from "../../../backend/src/types/powerPlatformInventory";
export type {
  UnifiedAgentInventoryPage,
  UnifiedAgentInventoryQuery,
  UnifiedAgentInventoryUnavailable,
  UnifiedAgentInventoryVerification,
  UnifiedAgentRecord,
  UnifiedAgentPowerPlatformObservation,
} from "../../../backend/src/types/unifiedAgents";
export type { CopilotServicePlan, CopilotServiceSummaryState } from "../../../backend/src/types/copilotUsage";
export { isCopilotServiceActive } from "../../../backend/src/types/copilotUsage";
export type { PurviewAuditFilters, PurviewAuditJob, PurviewAuditQualification, PurviewAuditRecord, PurviewAuditRecordPage, PurviewAuditTokenMode } from "../../../backend/src/types/purviewAudit";
export type { DefenderHuntingFilters, DefenderHuntingJob, DefenderHuntingRow, DefenderHuntingRowPage, DefenderHuntingTokenMode, DefenderInventoryDetailState } from "../../../backend/src/types/defenderHunting";
export type { AutomaticRefreshResult, DataSyncMode, DataSyncRun, DataSyncSourceId, DataSyncSourceState, DataSyncSourceStatus, DataSyncState, StartDataSyncInput } from "../../../backend/src/types/dataSync";
export { automaticDataSyncSourceIds, dataSyncFailureStatus } from "../../../backend/src/types/dataSync";
export type { QuarantineAction, QuarantineJob } from "../../../backend/src/types/copilotStudioQuarantine";

export type QuarantineStatusView = {
  target: { resourceNativeId: string; displayName: string; environmentId: string; botId: string };
  direct: { isBotQuarantined: boolean; providerUpdatedAt: string; observedAt: string; correlationId: string; source: "cache" | "provider" | "direct" };
  inventory: { isQuarantined: boolean | null; quarantinedAt: string | null; observedAt: string; snapshotId: string };
  disagreesWithInventory: boolean;
};

export type QuarantinePreview = {
  confirmationHash: string;
  summary: QuarantineConfirmationSummary;
  statuses: QuarantineStatusView[];
};

export type SessionUser = {
  displayName: string;
  username: string;
  homeAccountId: string;
  tenantId?: string;
  roles: AppRole[];
};

export type PackageAccessScope = PackageAccessUpdate["scope"];
export type PackageAccessReplacement = PackageAccessUpdate & { mode: "replace" };

export type DirectoryPrincipal = PackageAccessEntity & {
  displayName: string;
  secondaryText?: string;
  principalKind: "user" | "securityGroup" | "microsoft365Group" | "unknown";
};

export type CopilotPackageDetail = StoredPackageDetail & {
  observation?: PackageObservation;
  accessReadError?: string;
  matchingEvidence?: UnifiedAgentRecord["identity"]["evidence"];
  selectedSource?: { selectionId: string; recordId: string; sourceScopeId: string; sourceIdentity: string; generationId: string };
};

type PackageObservation = {
  id?: string;
  observedAt: string;
  expiresAt: string;
  scopeKind: "broad" | "exact";
  current?: boolean;
  source?: "Microsoft Graph package catalog";
  apiMaturity?: "v1.0 read; preview controls";
};

export type PackagePage = {
  value: CopilotPackage[];
  selection: { id: string; revision: string; expiresAt: string; evaluatedAt: string };
  counts: { total: number; scoped: number; filtered: number };
  page: { limit: number; nextCursor: string | null; previousCursor: string | null };
  freshness: { state: string; capturedRevision: string; sources: unknown[] };
  mode: "delegated" | "application";
};

type PackageListQuery = {
  selectionId?: string;
  cursor?: string;
  recordId?: string;
  mode?: "delegated" | "application";
  search?: string;
  operationIdPrefix?: string;
  blocked?: boolean;
  publisher?: string | null;
  availableTo?: InventoryFacetValue;
  host?: string | null;
  platform?: string | null;
  createdWithinDays?: number;
  sortBy?: "displayName" | "publisher" | "lastModifiedAt";
  sortDirection?: "asc" | "desc";
  limit?: number;
};

export type PackageRefreshJob = {
  id: string;
  authorizationPrincipalId: string;
  tokenMode: "delegated" | "application";
  scopeKind: "broad" | "exact";
  targetCount: number;
  resultRevision: string;
  status: "waiting_authorization" | "running" | "succeeded" | "failed" | "cancelled";
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

type BulkSideEffectError = {
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
  cancelRequested?: true;
  canResume: boolean;
  total: number;
  completed: number;
  succeeded: number;
  failed: number;
  skipped: number;
  inconclusive: number;
  cancelled: number;
  queued: number;
  reconciliationRequired: number;
  retryEligible: number;
  resultRevision: string;
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

export type BulkJobItemPage = {
  value: Array<Omit<BulkPackageResult, "status"> & { status: BulkPackageResult["status"] | "queued" | "running" }>;
  revision: string;
  counts: { total: number; filtered: number };
  page: { limit: number; nextCursor: string | null; previousCursor: string | null };
};

export type BlockAuditAction = "block" | "unblock";
export type AccessAuditAction = "update-availability" | "update-installation";
type ReassignAuditAction = "reassign";
export type AuditAction = BlockAuditAction | AccessAuditAction | ReassignAuditAction;
type ProviderAuditReadAction = "view-audit-search" | "export-audit-search";
type HuntingReadAction = "view-hunting" | "export-hunting";
type HuntingLifecycleAction = "approve-hunting" | "qualify-hunting" | "submit-hunting" | "query-hunting" | "cancel-hunting" | "delete-hunting" | "revoke-hunting-scope";
type ReportExportAction = "export-official-usage-aggregate" | "export-official-usage-users";
export type LocalAuditAction = AuditAction | ProviderAuditReadAction | HuntingReadAction | HuntingLifecycleAction | InventoryExportAction | ReportExportAction | AgentUsageAuditAction | "export-administrative-audit";

type PackageMutationState = Record<string, unknown>;

type PackageMutationConfirmationSummary = {
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
  selectionId?: string;
  confirmationHash: string;
  summary: PackageMutationConfirmationSummary;
};

type AuditScope = "single" | "bulk";

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
    | { action: Exclude<LocalAuditAction, BlockAuditAction>; targetBlockedState?: never }
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

type AuditEventsResponse = {
  value: AuditEvent[];
  count: number;
};

type AuditRequestContext = {
  actionGroupId?: string;
  signal?: AbortSignal;
};

export class ApiError extends Error {
  retryAfterSeconds?: number;
  status: number;
  code: string;
  requestId?: string;
  type?: string;
  kind: "problem" | "aborted" | "network";

  constructor(
    status: number,
    code: string,
    message: string,
    options: { requestId?: string; type?: string; kind?: "problem" | "aborted" | "network"; retryAfterSeconds?: number } = {},
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.requestId = options.requestId;
    this.type = options.type;
    this.kind = options.kind ?? "problem";
    this.retryAfterSeconds = options.retryAfterSeconds;
  }

  get authenticationExpired() {
    return this.status === 401 && ["unauthorized", "session_invalidated"].includes(this.code);
  }
}

let csrfToken: string | undefined;
let sessionGeneration = 0;
const sessionRevalidationListeners = new Set<(error: ApiError) => void>();

export function captureRequestSession() {
  const generation = sessionGeneration;
  return () => assertCurrentRequest(generation);
}

export function subscribeSessionRevalidationRequired(listener: (error: ApiError) => void) {
  sessionRevalidationListeners.add(listener);
  return () => {
    sessionRevalidationListeners.delete(listener);
  };
}

export async function startSignIn(
  input: { username: string; returnTo?: string },
  options: { signal?: AbortSignal } = {},
) {
  const result = await request<{ authorizationUrl: string }>("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
    signal: options.signal,
  }, { revalidateSession: false });
  let target: URL;
  try {
    if (!result || typeof result.authorizationUrl !== "string") throw new Error();
    target = new URL(result.authorizationUrl);
    if (target.protocol !== "https:" || target.username || target.password) throw new Error();
  } catch {
    throw new ApiError(200, "invalid_response", "The server returned an invalid sign-in URL. Please try again.");
  }
  return { authorizationUrl: target.href };
}

export async function getCurrentUser(options: { signal?: AbortSignal } = {}) {
  assertCurrentRequest(sessionGeneration, options.signal);
  const generation = ++sessionGeneration;
  csrfToken = undefined;
  const result = await request<{ user: SessionUser; csrfToken: string; roleAssignmentRequired: boolean }>("/api/me", { signal: options.signal });
  assertCurrentRequest(generation, options.signal);
  csrfToken = result.csrfToken;
  return result;
}

export function getCapabilities(options: { signal?: AbortSignal } = {}) {
  return request<{ value: CapabilityView[] }>("/api/capabilities", { signal: options.signal });
}

export function checkCapabilities(options: { signal?: AbortSignal; retryFailed?: boolean } = {}) {
  return request<{ value: CapabilityView[] }>(`/api/capabilities/check${options.retryFailed ? "?retry=failed" : ""}`, {
    method: "POST",
    signal: options.signal,
  });
}

export async function getCapabilityCheckProgress(options: { signal?: AbortSignal; retryFailed?: boolean } = {}) {
  const result = await request<{ progress: unknown }>(`/api/capabilities/check-progress${options.retryFailed ? "?retry=failed" : ""}`, {
    signal: options.signal,
  });
  if (!result || result.progress !== null && !validCheckProgress(result.progress)) {
    throw new ApiError(200, "invalid_response", "The server returned invalid permission-check progress.");
  }
  return { progress: result.progress };
}

function validCheckProgress(value: unknown): value is CapabilityCheckProgress {
  if (!value || typeof value !== "object" || !("checks" in value) || !Array.isArray(value.checks)
    || value.checks.length > capabilityIds.length) return false;
  const ids = new Set<string>();
  return value.checks.every((check: unknown) => {
    if (!check || typeof check !== "object" || !("capabilityId" in check) || typeof check.capabilityId !== "string"
      || !("state" in check) || typeof check.state !== "string" || !["reviewing", "checking", "complete"].includes(check.state)
      || !capabilityIds.some(id => id === check.capabilityId && supportsAutomaticCapabilityCheck(id)) || ids.has(check.capabilityId)) return false;
    ids.add(check.capabilityId);
    return true;
  });
}

export function getWorkbenchMetadata(options: { signal?: AbortSignal } = {}) {
  return request<WorkbenchMetadata>("/api/workbench/metadata", { signal: options.signal });
}

export function getWorkbenchJobs(options: { signal?: AbortSignal } = {}) {
  return request<WorkbenchJobsResponse>("/api/workbench/jobs", { signal: options.signal });
}

function inventoryQueryParams(query: Record<string, unknown>) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    if ((inventoryFacetFields as readonly string[]).includes(key)) params.set(key, encodeInventoryFacet(value as InventoryFacetValue));
    else if (value !== "") params.set(key, String(value));
  }
  return params;
}

export async function getAgents(query: PackageListQuery = {}, options: { signal?: AbortSignal } = {}) {
  const generation = sessionGeneration;
  let selectionId = query.selectionId;
  if (!selectionId) {
    const criteria = { ...query };
    delete criteria.limit;
    delete criteria.mode;
    const selected = await request<{ id: string }>("/api/agents/selections", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: Object.fromEntries(inventoryQueryParams(criteria)), mode: query.mode ?? "delegated" }), signal: options.signal,
    });
    selectionId = selected.id;
  }
  assertCurrentRequest(generation, options.signal);
  const params = new URLSearchParams({ selectionId, limit: String(query.limit ?? 50) });
  if (query.mode) params.set("mode", query.mode);
  if (query.cursor) params.set("cursor", query.cursor);
  return request<PackagePage>(`/api/agents?${params}`, { signal: options.signal });
}

export async function getUnifiedAgents(
  query: UnifiedAgentInventoryQuery = {},
  options: { signal?: AbortSignal } = {},
) {
  const generation = sessionGeneration;
  let selectionId = query.selectionId;
  if (!selectionId) {
    const criteria = { ...query };
    delete criteria.limit;
    const selected = await request<{ id: string } | UnifiedAgentInventoryUnavailable>("/api/agent-inventory/selections", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: Object.fromEntries(inventoryQueryParams(criteria)) }), signal: options.signal,
    });
    assertCurrentRequest(generation, options.signal);
    if ("state" in selected) {
      if (!["not_collected", "preparing"].includes(selected.state) || typeof selected.message !== "string" || !selected.message) {
        throw new ApiError(500, "invalid_inventory_availability", "The server returned invalid inventory availability.");
      }
      return selected;
    }
    selectionId = selected.id;
  }
  assertCurrentRequest(generation, options.signal);
  const params = new URLSearchParams({ selectionId, limit: String(query.limit ?? 50) });
  if (query.cursor) params.set("cursor", query.cursor);
  return request<UnifiedAgentInventoryPage>(
    `/api/agent-inventory?${params}`,
    { signal: options.signal },
  );
}

export type InventoryFacetField = "type" | "publisher" | "host" | "platform" | "environmentId" | "source" | "linkState" | "blocked" | "availableTo";
export function getUnifiedAgentDetail(selectionId: string, recordId: string, options: { signal?: AbortSignal } = {}) {
  return request<UnifiedAgentRecord>(`/api/agent-inventory/${encodeURIComponent(recordId)}/detail?${new URLSearchParams({ selectionId })}`,
    { signal: options.signal });
}

export function getInventoryFacets(selectionId: string, field: InventoryFacetField,
    query: { search?: string; cursor?: string; selected?: boolean } = {}, options: { signal?: AbortSignal } = {}) {
    const params = new URLSearchParams({ selectionId, field, limit: "50" });
    for (const [key, value] of Object.entries(query)) if (value !== undefined) params.set(key, String(value));
    return request<{ value: { value: InventoryFacetValue; label: string }[]; total: number; nextCursor: string | null }>(
      `/api/agent-inventory/facets?${params}`, { signal: options.signal });
  }
  export type InventoryMember = {
    source_scope_id: string; source_identity: string; source_generation_id: string;
    domain: "packages" | "power_platform"; native_id: string; environment_id: string | null;
    display_name: string; observed_at: string; expires_at: string;
  };
  export function getInventoryMembers(selectionId: string, recordId: string, cursor?: string, options: { signal?: AbortSignal } = {}) {
    const params = new URLSearchParams({ selectionId, limit: "50", ...cursor ? { cursor } : {} });
    return request<{ value: InventoryMember[]; total: number; nextCursor: string | null }>(
      `/api/agent-inventory/${encodeURIComponent(recordId)}/members?${params}`, { signal: options.signal });
  }
  export function getInventoryChildren(selectionId: string, recordId: string, member: Pick<InventoryMember, "source_scope_id" | "source_identity">, kind: string,
    cursor?: string, options: { signal?: AbortSignal; value?: string; limit?: number } = {}) {
    const params = new URLSearchParams({ selectionId, kind, sourceScopeId: member.source_scope_id,
      sourceIdentity: member.source_identity, limit: String(options.limit ?? 50), ...cursor ? { cursor } : {},
      ...options.value !== undefined ? { value: options.value } : {} });
    return request<{ value: { ordinal: number; kind: string; value: string; payload: Record<string, unknown> }[]; total: number; nextCursor: string | null }>(
      `/api/agent-inventory/${encodeURIComponent(recordId)}/children?${params}`, { signal: options.signal });
  }

export function getInventorySections(selectionId: string, recordId: string, member: InventoryMember,
  options: { cursor?: string; signal?: AbortSignal } = {}) {
  const params = new URLSearchParams({ selectionId, sourceScopeId: member.source_scope_id, sourceIdentity: member.source_identity, limit: "50" });
  if (options.cursor) params.set("cursor", options.cursor);
  return request<{ value: Array<{ kind: string; total: number }>; nextCursor: string | null }>(
    `/api/agent-inventory/${encodeURIComponent(recordId)}/sections?${params}`, { signal: options.signal });
}

export function getAgentResponsibility(query: AgentResponsibilityQuery = {}, options: { signal?: AbortSignal } = {}) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) if (value !== undefined && value !== "") params.set(key, String(value));
  return request<AgentResponsibilityPage>(`/api/agent-responsibility${params.size ? `?${params}` : ""}`, { signal: options.signal });
}

export function startPackageRefresh(mode: "delegated" | "application" = "delegated", options: { idempotencyKey?: string; signal?: AbortSignal } = {}) {
  return request<PackageRefreshJob>("/api/agents/refresh-jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(options.idempotencyKey ? { "Idempotency-Key": options.idempotencyKey } : {}) },
    body: JSON.stringify({ mode }),
    signal: options.signal,
  });
}

export async function refreshPackageIdentityDetails(
  input: { selectionId: string; ids?: string[]; recordIds?: string[] },
  options: { signal?: AbortSignal } = {},
) {
  const generation = sessionGeneration;
  const job = await request<PackageRefreshJob>("/api/agents/refresh-selection", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
    signal: options.signal,
  });
  assertCurrentRequest(generation, options.signal);
  if (job.status !== "waiting_authorization") return job;
  return request<PackageRefreshJob>(`/api/agents/refresh-jobs/${encodeURIComponent(job.id)}/resume`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode: job.tokenMode }),
    signal: options.signal,
  });
}

export function startExactPackageRefresh(
  id: string,
  mode: "delegated" | "application" = "delegated",
  options: { signal?: AbortSignal } = {},
) {
  return request<PackageRefreshJob>(`/api/agents/${encodeURIComponent(id)}/refresh-jobs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode }),
    signal: options.signal,
  });
}

export function getPackageRefreshJob(
  id: string,
  mode: "delegated" | "application" = "delegated",
  options: { signal?: AbortSignal } = {},
) {
  return request<PackageRefreshJob>(`/api/agents/refresh-jobs/${encodeURIComponent(id)}?mode=${mode}`, { signal: options.signal });
}

export function getPackageRefreshJobs(mode: "delegated" | "application" = "delegated", limit = 20, options: { signal?: AbortSignal } = {}) {
  return request<{ value: PackageRefreshJob[]; lastAttemptAt: string | null; lastSuccessAt: string | null }>(
    `/api/agents/refresh-jobs?mode=${mode}&limit=${limit}`,
    { signal: options.signal },
  );
}

export type PackageRefreshTargetPage = {
  value: Array<{ id: string; ordinal: number; status: string }>;
  revision: string;
  counts: { total: number; filtered: number };
  page: { limit: number; nextCursor: string | null; previousCursor: string | null };
};

export function getPackageRefreshTargets(job: Pick<PackageRefreshJob, "id" | "tokenMode" | "resultRevision">,
  options: { cursor?: string; signal?: AbortSignal } = {}) {
  const query = new URLSearchParams({ mode: job.tokenMode, revision: job.resultRevision, limit: "50" });
  if (options.cursor) query.set("cursor", options.cursor);
  return request<PackageRefreshTargetPage>(`/api/agents/refresh-jobs/${encodeURIComponent(job.id)}/targets?${query}`, { signal: options.signal });
}

export function refreshInventory(scope: { types?: PowerPlatformResourceType[]; environmentId?: string } = {}, options: { signal?: AbortSignal } = {}) {
  return request<InventoryRefreshJob>("/api/inventory/refresh-jobs", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(scope),
    signal: options.signal,
  });
}

export function getInventoryRefreshJobs(options: { signal?: AbortSignal } = {}) {
  return request<InventoryRefreshJobList>("/api/inventory/refresh-jobs", { signal: options.signal });
}

export function getInventoryRefreshJob(id: string, options: { signal?: AbortSignal } = {}) {
  return request<InventoryRefreshJob>(`/api/inventory/refresh-jobs/${encodeURIComponent(id)}`, { signal: options.signal });
}

export function resumeInventoryRefresh(id: string, options: { signal?: AbortSignal } = {}) {
  return request<InventoryRefreshJob>(`/api/inventory/refresh-jobs/${encodeURIComponent(id)}/resume`, { method: "POST", signal: options.signal });
}

export function cancelInventoryRefresh(id: string, options: { signal?: AbortSignal } = {}) {
  return request<InventoryRefreshJob>(`/api/inventory/refresh-jobs/${encodeURIComponent(id)}/cancel`, { method: "POST", signal: options.signal });
}

export function getQuarantineStatus(snapshotId: string, nativeId: string, force = false, options: { signal?: AbortSignal } = {}) {
  const params = new URLSearchParams({ snapshotId, nativeId });
  if (force) params.set("force", "true");
  return request<QuarantineStatusView>(`/api/quarantine/status?${params}`, { signal: options.signal });
}

export function previewQuarantine(input: { action: QuarantineAction; snapshotId: string; resourceNativeIds: string[]; forceStatus?: boolean }, options: { signal?: AbortSignal } = {}) {
  return request<QuarantinePreview>("/api/quarantine/preview", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input), signal: options.signal,
  });
}

export function submitQuarantine(input: { action: QuarantineAction; snapshotId: string; resourceNativeIds: string[]; confirmationHash: string }, idempotencyKey: string, options: { signal?: AbortSignal } = {}) {
  return request<QuarantineJob>("/api/quarantine/jobs", {
    method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey }, body: JSON.stringify(input),
    signal: options.signal,
  });
}

export function getQuarantineJobs(limit = 20, options: { signal?: AbortSignal } = {}) {
  return request<{ value: QuarantineJob[] }>(`/api/quarantine/jobs?limit=${limit}`, { signal: options.signal });
}

export function getQuarantineJob(id: string, options: { signal?: AbortSignal } = {}) {
  return request<QuarantineJob>(`/api/quarantine/jobs/${encodeURIComponent(id)}`, { signal: options.signal });
}

export function cancelQuarantineJob(id: string, options: { signal?: AbortSignal } = {}) {
  return request<QuarantineJob>(`/api/quarantine/jobs/${encodeURIComponent(id)}/cancel`, { method: "POST", signal: options.signal });
}

export function resumeQuarantineJob(id: string, options: { signal?: AbortSignal } = {}) {
  return request<QuarantineJob>(`/api/quarantine/jobs/${encodeURIComponent(id)}/resume`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirmed: true }),
    signal: options.signal,
  });
}

export function reconcileQuarantineJob(id: string, options: { signal?: AbortSignal } = {}) {
  return request<QuarantineJob>(`/api/quarantine/jobs/${encodeURIComponent(id)}/reconcile`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}),
    signal: options.signal,
  });
}

export function getDataSyncState(options: { signal?: AbortSignal } = {}) {
  return request<DataSyncState>("/api/data-sync/state", { signal: options.signal });
}

export function checkAutomaticRefresh(options: { signal?: AbortSignal } = {}) {
  return request<AutomaticRefreshResult>("/api/data-sync/auto-refresh", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
    signal: options.signal,
  });
}

export function getDataSyncRun(id: string, options: { signal?: AbortSignal } = {}) {
  return request<DataSyncRun>(`/api/data-sync/runs/${encodeURIComponent(id)}`, { signal: options.signal });
}

export function startDataSync(input: StartDataSyncInput, options: { signal?: AbortSignal } = {}) {
  return request<DataSyncRun>("/api/data-sync/runs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
    signal: options.signal,
  });
}

export function cancelDataSyncRun(id: string, options: { signal?: AbortSignal } = {}) {
  return request<DataSyncRun>(`/api/data-sync/runs/${encodeURIComponent(id)}/cancel`, {
    method: "POST",
    signal: options.signal,
  });
}

export type PurviewAuditCatalog = {
  presets: Array<{ id: PurviewAuditFilters["presetId"]; label: string; service: string; recordTypes: string[]; operations: string[] }>;
  limits: { maximumWindowHours: number; qualificationWindowHours: number; maximumPages: number; maximumRows: number; maximumBytes: number; pollsPerActivation: number;
    providerRequests: number; activations: number };
  evidenceNotice: string;
  contentNotice: string;
  retentionNotice: string;
};

export function getPurviewAuditCatalog(options: { signal?: AbortSignal } = {}) {
  return request<PurviewAuditCatalog>("/api/audit-search/catalog", { signal: options.signal });
}

export function getPurviewAuditJobs(limit = 20, offset = 0, options: { signal?: AbortSignal; userPrincipalName?: string } = {}) {
  const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  if (options.userPrincipalName) params.set("userPrincipalName", options.userPrincipalName);
  return request<PurviewAuditHistory>(`/api/audit-search/jobs?${params}`, { signal: options.signal });
}

export function getPurviewAuditJob(id: string, options: { signal?: AbortSignal } = {}) {
  return request<PurviewAuditJob>(`/api/audit-search/jobs/${encodeURIComponent(id)}`, { signal: options.signal });
}

export function submitPurviewAuditSearch(tokenMode: PurviewAuditTokenMode, filters: PurviewAuditFilters, options: { signal?: AbortSignal } = {}) {
  return request<PurviewAuditJob>("/api/audit-search/jobs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tokenMode, filters }), signal: options.signal });
}

export function getPurviewAuditRecords(id: string, limit = 100, offset = 0, options: { signal?: AbortSignal } = {}) {
  const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  return request<PurviewAuditRecordPage>(`/api/audit-search/jobs/${encodeURIComponent(id)}/records?${params}`, { signal: options.signal });
}

export function resumePurviewAuditSearch(id: string, options: { signal?: AbortSignal } = {}) {
  return request<PurviewAuditJob>(`/api/audit-search/jobs/${encodeURIComponent(id)}/resume`, { method: "POST", signal: options.signal });
}

export function cancelPurviewAuditSearch(id: string, options: { signal?: AbortSignal } = {}) {
  return request<PurviewAuditJob>(`/api/audit-search/jobs/${encodeURIComponent(id)}/cancel`, { method: "POST", signal: options.signal });
}

export function deletePurviewAuditSearch(id: string, options: { signal?: AbortSignal } = {}) {
  return request<void>(`/api/audit-search/jobs/${encodeURIComponent(id)}`, {
    method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirmation: id }), signal: options.signal,
  });
}

export function approvePurviewAuditQualification(tokenMode: PurviewAuditTokenMode, filters: PurviewAuditFilters, options: { signal?: AbortSignal } = {}) {
  return request<PurviewAuditQualification>("/api/audit-search/qualifications", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tokenMode, filters }), signal: options.signal });
}

export function startPurviewAuditQualification(id: string, options: { signal?: AbortSignal } = {}) {
  return request<PurviewAuditJob>(`/api/audit-search/qualifications/${encodeURIComponent(id)}/start`, { method: "POST", signal: options.signal });
}

export async function downloadPurviewAuditCsv(id: string, options: { signal?: AbortSignal } = {}) {
  return requestBlob(`/api/audit-search/jobs/${encodeURIComponent(id)}/export.csv`, { headers: { Accept: "text/csv" }, signal: options.signal });
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

type AgentHuntingOptions = { signal?: AbortSignal; agentRecordId?: string };

export function getAgentInvestigationContext(recordId: string, options: { signal?: AbortSignal } = {}) {
  return request<AgentInvestigationContext>(`/api/agent-inventory/investigations/context?${new URLSearchParams({ recordId })}`, { signal: options.signal });
}

export function resolveAgentInvestigationIdentity(recordId: string, options: { signal?: AbortSignal } = {}) {
  return request<AgentInvestigationContext>("/api/agent-inventory/investigations/resolve", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ recordId }), signal: options.signal,
  });
}

export function getAgentPurviewRecords(recordId: string, query: { limit: number; offset: number; search?: string; operation?: string }, options: { signal?: AbortSignal } = {}) {
  const params = new URLSearchParams({ recordId, limit: String(query.limit), offset: String(query.offset) });
  if (query.search) params.set("search", query.search);
  if (query.operation) params.set("operation", query.operation);
  return request<AgentPurviewRecordPage>(`/api/agent-inventory/investigations/purview?${params}`, { signal: options.signal });
}

function agentHuntingUrl(path: string, options: AgentHuntingOptions) {
  if (!options.agentRecordId) return path;
  return `${path}${path.includes("?") ? "&" : "?"}${new URLSearchParams({ agentRecordId: options.agentRecordId })}`;
}

function huntingSubmissionFilters(filters: DefenderHuntingFilters, options: AgentHuntingOptions) {
  if (!options.agentRecordId) return filters;
  return { templateId: filters.templateId, startDateTime: filters.startDateTime, endDateTime: filters.endDateTime, operations: filters.operations };
}

export function getDefenderHuntingCatalog(options: AgentHuntingOptions = {}) {
  return request<DefenderHuntingCatalog>(agentHuntingUrl("/api/hunting/catalog", options), { signal: options.signal });
}

export function getDefenderHuntingJobs(limit = 20, offset = 0, options: AgentHuntingOptions = {}) {
  const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  return request<DefenderHuntingHistory>(agentHuntingUrl(`/api/hunting/jobs?${params}`, options), { signal: options.signal });
}

export function getDefenderHuntingJob(id: string, options: AgentHuntingOptions = {}) {
  return request<DefenderHuntingJob>(agentHuntingUrl(`/api/hunting/jobs/${encodeURIComponent(id)}`, options), { signal: options.signal });
}

export function submitDefenderHunt(tokenMode: DefenderHuntingTokenMode, filters: DefenderHuntingFilters, options: AgentHuntingOptions = {}) {
  return request<DefenderHuntingJob>(agentHuntingUrl("/api/hunting/jobs", options), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tokenMode, filters: huntingSubmissionFilters(filters, options) }), signal: options.signal });
}

export function getDefenderHuntingRows(id: string, limit = 100, offset = 0, options: AgentHuntingOptions = {}) {
  const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  return request<DefenderHuntingRowPage>(agentHuntingUrl(`/api/hunting/jobs/${encodeURIComponent(id)}/rows?${params}`, options), { signal: options.signal });
}

export function resumeDefenderHunt(id: string, options: AgentHuntingOptions = {}) {
  return request<DefenderHuntingJob>(agentHuntingUrl(`/api/hunting/jobs/${encodeURIComponent(id)}/resume`, options), { method: "POST", signal: options.signal });
}

export function cancelDefenderHunt(id: string, options: AgentHuntingOptions = {}) {
  return request<DefenderHuntingJob>(agentHuntingUrl(`/api/hunting/jobs/${encodeURIComponent(id)}/cancel`, options), { method: "POST", signal: options.signal });
}

export function deleteDefenderHunt(id: string, options: AgentHuntingOptions = {}) {
  return request<void>(agentHuntingUrl(`/api/hunting/jobs/${encodeURIComponent(id)}`, options), { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirmation: id }), signal: options.signal });
}

export function approveDefenderHuntingQualification(tokenMode: DefenderHuntingTokenMode, filters: DefenderHuntingFilters, options: AgentHuntingOptions = {}) {
  return request<DefenderHuntingJob>(agentHuntingUrl("/api/hunting/qualifications", options), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tokenMode, filters: huntingSubmissionFilters(filters, options) }), signal: options.signal });
}

export function startDefenderHuntingQualification(id: string, options: AgentHuntingOptions = {}) {
  return request<DefenderHuntingJob>(agentHuntingUrl(`/api/hunting/qualifications/${encodeURIComponent(id)}/start`, options), { method: "POST", signal: options.signal });
}

export function revokeDefenderHuntingRetainedScope(id: string, options: AgentHuntingOptions = {}) {
  return request<DefenderHuntingRetainedScope>(agentHuntingUrl(`/api/hunting/retained-scopes/${encodeURIComponent(id)}/revoke`, options), {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirmation: id }), signal: options.signal,
  });
}

export async function downloadDefenderHuntingCsv(id: string, options: AgentHuntingOptions = {}) {
  return requestBlob(agentHuntingUrl(`/api/hunting/jobs/${encodeURIComponent(id)}/export.csv`, options), { headers: { Accept: "text/csv" }, signal: options.signal });
}

export async function getAgentDetails(selectionId: string, id: string, options: { signal?: AbortSignal; mode?: "delegated" | "application" } = {}) {
  const params = new URLSearchParams({ selectionId, ...options.mode ? { mode: options.mode } : {} });
  return request<CopilotPackageDetail>(`/api/agents/${encodeURIComponent(id)}/detail?${params}`, { signal: options.signal });
}

export async function searchDirectoryPrincipals(search: string, limit = 25, options: { signal?: AbortSignal } = {}) {
  const params = new URLSearchParams({ search, limit: String(limit) });
  return request<{ value: DirectoryPrincipal[] }>(
    `/api/directory/principals?${params.toString()}`,
    { signal: options.signal },
  );
}

export async function resolveDirectoryPrincipals(
  principals: PackageAccessEntity[],
  options: { signal?: AbortSignal } = {},
) {
  return request<{ value: DirectoryPrincipal[] }>(
    "/api/directory/principals/resolve",
    {
      signal: options.signal,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ principals }),
    },
  );
}

export async function resolveAgentPeople(
  recordId: string,
  options: { force?: boolean; signal?: AbortSignal } = {},
) {
  return request<{ people: UnifiedAgentRecord["people"]; changed: boolean }>("/api/agent-inventory/people/resolve", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ recordId, ...(options.force ? { force: true } : {}) }),
    signal: options.signal,
  });
}

export async function updateAgentAccess(
  id: string,
  update: PackageAccessReplacement,
  confirmationHash: string,
  options: { signal?: AbortSignal } = {},
) {
  return request<BulkActionJob>(`/api/agents/${encodeURIComponent(id)}/access`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...update, confirmationHash }),
    signal: options.signal,
  });
}

export async function updateAgentsAccess(
  ids: string[],
  update: PackageAccessUpdate,
  confirmationHash: string,
  options: { signal?: AbortSignal } = {},
) {
  return request<BulkActionJob>("/api/agents/access", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids, ...update, confirmationHash }),
    signal: options.signal,
  });
}

export function countPackageMutationSelection(input: { selectionId: string; ids?: string[]; recordIds?: string[] }, options: { signal?: AbortSignal } = {}) {
  return request<{ count: number }>("/api/agents/mutation-selection", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input), signal: options.signal,
  });
}

export function previewPackageMutation(input: {
  action: AuditAction;
  ids?: string[];
  recordIds?: string[];
  selectionId?: string;
  mutationScope: AuditScope;
  accessUpdate?: PackageAccessUpdate;
}, options: { signal?: AbortSignal } = {}) {
  return request<PackageMutationPreview>("/api/agents/mutation-preview", {
    method: "POST",
    signal: options.signal,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: input.action,
      ids: input.ids,
      recordIds: input.recordIds,
      selectionId: input.selectionId,
      mutationScope: input.mutationScope,
      ...input.accessUpdate,
    }),
  });
}

export function submitSelectedPackageMutation(input: {
  action: AuditAction; selectionId: string; confirmationHash: string; accessUpdate?: PackageAccessUpdate; ids?: string[]; recordIds?: string[];
}, options: { signal?: AbortSignal } = {}) {
  const path = input.accessUpdate ? "access" : input.action;
  return request<BulkActionJob>(`/api/agents/${path}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ selectionId: input.selectionId, ids: input.ids, recordIds: input.recordIds, confirmationHash: input.confirmationHash, ...input.accessUpdate }),
    signal: options.signal,
  });
}

export async function blockAgent(id: string, confirmationHash: string, context?: AuditRequestContext) {
  return request<BulkActionJob>(`/api/agents/${encodeURIComponent(id)}/block`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...auditContextHeaders(context) },
    body: JSON.stringify({ confirmationHash }),
    signal: context?.signal,
  });
}

export async function unblockAgent(id: string, confirmationHash: string, context?: AuditRequestContext) {
  return request<BulkActionJob>(`/api/agents/${encodeURIComponent(id)}/unblock`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...auditContextHeaders(context) },
    body: JSON.stringify({ confirmationHash }),
    signal: context?.signal,
  });
}

export async function blockAgents(ids: string[], confirmationHash: string, options: { signal?: AbortSignal } = {}) {
  return request<BulkActionJob>("/api/agents/block", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids, confirmationHash }),
    signal: options.signal,
  });
}

export async function unblockAgents(ids: string[], confirmationHash: string, options: { signal?: AbortSignal } = {}) {
  return request<BulkActionJob>("/api/agents/unblock", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids, confirmationHash }),
    signal: options.signal,
  });
}

export async function getBulkActionJob(id: string, options: { signal?: AbortSignal } = {}) {
  return request<BulkActionJob>(
    `/api/agents/bulk-jobs/${encodeURIComponent(id)}`,
    { signal: options.signal },
  );
}

export function getBulkActionJobs(limit = 20, options: { signal?: AbortSignal } = {}) {
  return request<{ value: BulkActionJob[] }>(`/api/agents/bulk-jobs?limit=${limit}`, { signal: options.signal });
}

export function getBulkActionJobItems(id: string, query: { revision: string; cursor?: string; limit?: number },
  options: { signal?: AbortSignal } = {}) {
  const search = new URLSearchParams({ revision: query.revision, limit: String(query.limit ?? 50) });
  if (query.cursor) search.set("cursor", query.cursor);
  return request<BulkJobItemPage>(`/api/agents/bulk-jobs/${encodeURIComponent(id)}/items?${search}`, { signal: options.signal });
}

export function reconcileBulkActionJob(id: string, options: { signal?: AbortSignal } = {}) {
  return request<BulkActionJob & { reconciliation: { attempted: number; failed: number; errors: Array<{ id: string; message: string }> } }>(
    `/api/agents/bulk-jobs/${encodeURIComponent(id)}/reconcile`,
    { method: "POST", signal: options.signal },
  );
}

export async function downloadAdministrativeAuditCsv(ids: string[], signal?: AbortSignal) {
  return requestBlob("/api/audit/events/export.csv", {
    method: "POST", signal,
    headers: { Accept: "text/csv", "Content-Type": "application/json", ...(csrfToken ? { "X-CSRF-Token": csrfToken } : {}) },
    body: JSON.stringify({ ids }),
  });
}

export async function getAuditEvents(
  query: AuditEventsQuery = {},
  options: { signal?: AbortSignal } = {},
) {
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
    { signal: options.signal },
  );
}

export async function signOut(options: { signal?: AbortSignal } = {}) {
  assertCurrentRequest(sessionGeneration, options.signal);
  const generation = sessionGeneration;
  await request<void>("/api/auth/logout", { method: "POST", signal: options.signal });
  assertCurrentRequest(generation, options.signal);
  sessionGeneration += 1;
  csrfToken = undefined;
}

function auditContextHeaders(context: AuditRequestContext | undefined) {
  return context?.actionGroupId
    ? { "x-agent-control-action-group-id": context.actionGroupId }
    : undefined;
}

export async function request<T>(path: string, init: RequestInit = {}, options: { revalidateSession?: boolean } = {}): Promise<T> {
  const method = init.method?.toUpperCase() ?? "GET";
  const headers = new Headers(init.headers);
  if (!headers.has("Accept")) headers.set("Accept", "application/json");
  if (method !== "GET" && !headers.has("Idempotency-Key")) headers.set("Idempotency-Key", crypto.randomUUID());
  if (!["GET", "HEAD", "OPTIONS"].includes(method) && csrfToken && !headers.has("X-CSRF-Token")) {
    headers.set("X-CSRF-Token", csrfToken);
  }
  return requestBody(path, {
    ...init,
    headers,
  }, async response => {
    if (response.status === 204) return undefined as T;
    try {
      return (await response.json()) as T;
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new ApiError(response.status, "invalid_response", "The server returned an invalid JSON response.", {
          requestId: response.headers.get("X-Request-ID") ?? undefined,
        });
      }
      throw error;
    }
  }, options);
}

function requestBlob(path: string, init: RequestInit) {
  return requestBody(path, init, response => response.blob());
}

async function requestBody<T>(
  path: string,
  init: RequestInit,
  readBody: (response: Response) => Promise<T>,
  options: { revalidateSession?: boolean } = {},
): Promise<T> {
  const generation = sessionGeneration;
  let response: Response | undefined;
  try {
    assertCurrentRequest(generation, init.signal);
    response = await fetch(path, { ...init, credentials: "include" });
    assertCurrentRequest(generation, init.signal);
    if (!response.ok) throw await toApiError(response, init.signal);
    const result = await readBody(response);
    assertCurrentRequest(generation, init.signal);
    return result;
  } catch (error) {
    if (generation !== sessionGeneration || init.signal?.aborted || (error instanceof Error || error instanceof DOMException) && error.name === "AbortError") {
      throw new ApiError(0, "request_aborted", "The request was cancelled.", { kind: "aborted" });
    }
    if (error instanceof ApiError) {
      if (options.revalidateSession !== false) notifySessionRevalidation(error);
      throw error;
    }
    if (!response || error instanceof TypeError) {
      throw new ApiError(0, "network_error", "The server could not be reached.", {
        kind: "network", requestId: response?.headers.get("X-Request-ID") ?? undefined,
      });
    }
    throw error;
  }
}

function assertCurrentRequest(generation: number, signal?: AbortSignal | null) {
  if (generation !== sessionGeneration || signal?.aborted) {
    throw new ApiError(0, "request_aborted", "The request was cancelled.", { kind: "aborted" });
  }
}

export function cancelBulkActionJob(id: string, options: { signal?: AbortSignal } = {}) {
  return request<BulkActionJob>(`/api/agents/bulk-jobs/${encodeURIComponent(id)}/cancel`, { method: "POST", signal: options.signal });
}

export function resumeBulkActionJob(id: string, options: { signal?: AbortSignal } = {}) {
  return request<BulkActionJob>(`/api/agents/bulk-jobs/${encodeURIComponent(id)}/resume`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirmed: true }),
    signal: options.signal,
  });
}

async function toApiError(response: Response, signal?: AbortSignal | null) {
  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    if (signal?.aborted || !(error instanceof SyntaxError || error instanceof TypeError)) throw error;
  }
  const problem = typeof body === "object" && body !== null ? body : {};
  return new ApiError(
    response.status,
    "code" in problem && typeof problem.code === "string" ? problem.code : "request_failed",
    "detail" in problem && typeof problem.detail === "string" ? problem.detail : `Request failed with status ${response.status}.`,
    {
      requestId: "requestId" in problem && typeof problem.requestId === "string" ? problem.requestId : response.headers.get("X-Request-ID") ?? undefined,
      type: "type" in problem && typeof problem.type === "string" ? problem.type : undefined,
      retryAfterSeconds: /^\d+$/.test(response.headers.get("Retry-After") ?? "")
        ? Number(response.headers.get("Retry-After")) : undefined,
    },
  );
}

function notifySessionRevalidation(error: ApiError) {
  const unclassifiedDenial = (error.status === 401 || error.status === 403) && error.code === "request_failed";
  // Signing in in another tab replaces the session cookie and its CSRF token.
  const rejectedCsrf = error.status === 403 && error.code === "invalid_csrf";
  const sessionRevalidationRequired = error.authenticationExpired
    || (error.status === 403 && error.code === "missing_internal_role")
    || unclassifiedDenial || rejectedCsrf;
  if (sessionRevalidationRequired) {
    sessionGeneration += 1;
    if (error.authenticationExpired || rejectedCsrf || unclassifiedDenial && error.status === 401) csrfToken = undefined;
    for (const listener of sessionRevalidationListeners) {
      try {
        listener(error);
      } catch {
        // A consumer must not hide the original typed API failure.
      }
    }
  }
}
