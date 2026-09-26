import type { CopilotPackage } from "./copilotPackage.js";
import type { AgentUsageContext, AgentUsageSummary } from "./agentUsage.js";
import type { PackageAgentIdentityWarning, PackageAgentLinkEvidence } from "../services/packageAgentIdentity.js";
import type {
  InventoryCoverageStatus,
  InventorySnapshotVerification,
  InventoryFieldProvenance,
  PowerPlatformResource,
} from "./powerPlatformInventory.js";

export type UnifiedAgentSource = "graph_packages" | "power_platform";
export type UnifiedAgentSourceFilter = "all" | UnifiedAgentSource | "both";
export const unifiedAgentInventoryScopes = ["catalog", "power_platform_only", "all"] as const;
export type UnifiedAgentInventoryScope = typeof unifiedAgentInventoryScopes[number];
export type UnifiedAgentPresence = "graph_packages" | "power_platform" | "both";
export type UnifiedAgentLinkState = "matched" | "unmatched" | "ambiguous" | "conflicting";
export const unifiedAgentSortKeys = [
  "displayName", "environment", "builtWith", "availability", "status", "hosts", "publisher",
  "origin", "deployment", "owner", "createdBy", "createdAt", "lastModifiedAt", "lastPublishedAt",
  "agentType", "versions", "publication", "quarantine", "location", "model", "authentication",
  "channels", "orchestration", "webSearch", "managed", "source", "observedAt", "linkState",
  "responses", "activeUsers", "lastActivity",
] as const;
export type UnifiedAgentSort = typeof unifiedAgentSortKeys[number];
export type UnifiedAgentSortDirection = "asc" | "desc";
export const unifiedAgentQuickViews = ["all", "first_party", "third_party", "user_managed", "copilot_studio", "organization_managed"] as const;
export type UnifiedAgentQuickView = typeof unifiedAgentQuickViews[number];
export const unifiedAgentViews = [...unifiedAgentQuickViews, "available", "unavailable", "availability_unknown", "organization", "used", "unknown"] as const;
export type UnifiedAgentView = typeof unifiedAgentViews[number];
export const unifiedAgentAccessFilters = ["all", "available", "unavailable", "unknown"] as const;
export type UnifiedAgentAccessFilter = typeof unifiedAgentAccessFilters[number];
export const unifiedAgentUsageFilters = ["all", "used"] as const;
export type UnifiedAgentUsageFilter = typeof unifiedAgentUsageFilters[number];
export const unifiedAgentManagementFilters = ["all", "user_managed", "organization_managed", "unknown"] as const;
export type UnifiedAgentManagementFilter = typeof unifiedAgentManagementFilters[number];
export const unifiedAgentRelevanceFilters = ["all", "organization", "unknown"] as const;
export type UnifiedAgentRelevanceFilter = typeof unifiedAgentRelevanceFilters[number];

export type UnifiedAgentTarget =
  | { source: "canonical"; agentId: string }
  | { source: "graph_packages"; packageId: string }
  | { source: "power_platform"; nativeId: string; environmentId: string | null };

export function unifiedAgentRecordId(target: UnifiedAgentTarget) {
  return target.source === "canonical" ? `agent:${target.agentId.toLowerCase()}`
    : target.source === "graph_packages"
    ? `graph_packages:${encodeURIComponent(target.packageId)}`
    : `power_platform:${encodeURIComponent(target.environmentId ?? "")}:${encodeURIComponent(target.nativeId)}`;
}

export function parseUnifiedAgentRecordId(value: string): UnifiedAgentTarget | undefined {
  if (value.startsWith("agent:")) {
    const agentId = value.slice("agent:".length);
    if (agentId.length !== 36 || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(agentId)) {
      throw new RangeError("The unified agent link contains an invalid canonical identity.");
    }
    return { source: "canonical", agentId: agentId.toLowerCase() };
  }
  const decode = (part: string, allowEmpty = false) => {
    const decoded = decodeURIComponent(part);
    if ((!decoded && !allowEmpty) || decoded.length > 512 || /[\r\n\0]/.test(decoded)) {
      throw new RangeError("The unified agent link contains an invalid native identity.");
    }
    return decoded;
  };
  if (value.startsWith("graph_packages:")) {
    return { source: "graph_packages", packageId: decode(value.slice("graph_packages:".length)) };
  }
  if (value.startsWith("power_platform:")) {
    const parts = value.slice("power_platform:".length).split(":");
    if (parts.length !== 2) throw new RangeError("The unified agent link must contain its exact environment and native identity.");
    return { source: "power_platform", environmentId: decode(parts[0], true) || null, nativeId: decode(parts[1]) };
  }
  return undefined;
}

export type UnifiedAgentLinkEvidence = PackageAgentLinkEvidence;

export type UnifiedAgentSourceObservation = {
  id: string;
  snapshotId: string;
  observedAt: string;
  expiresAt: string;
  current: true;
};

export type UnifiedAgentPackageObservation = UnifiedAgentSourceObservation & {
  tokenMode: "delegated";
  scopeKind: "broad";
  observedCount: number;
  totalRecords: number;
};

export type UnifiedAgentPackageRecordObservation = UnifiedAgentSourceObservation & {
  scopeKind: "broad" | "exact";
  identityDetails: UnifiedAgentSourceObservation | null;
};

export type UnifiedAgentPowerPlatformObservation = UnifiedAgentSourceObservation & {
  roleScope: "full" | "ai" | "unknown";
  environmentScope: string | null;
  coverage: InventoryCoverageStatus;
  coveredCount: number | null;
  observedCount: number;
  totalRecords: number;
  pageCount: number;
  verification: InventorySnapshotVerification;
};

export type UnifiedAgentSourceError = {
  source: UnifiedAgentSource;
  code:
    | "snapshot_unavailable"
    | "source_result_limit"
    | "coverage_unknown"
    | "environment_scope_limited"
    | "not_authorized_scope";
  message: string;
};

export type UnifiedAgentSourceStatus =
  | {
      state: "available";
      observation: UnifiedAgentPackageObservation | UnifiedAgentPowerPlatformObservation;
      error: null;
    }
  | {
      state: "partial";
      observation: UnifiedAgentPowerPlatformObservation;
      error: UnifiedAgentSourceError;
    }
  | {
      state: "unavailable";
      observation: UnifiedAgentPackageObservation | UnifiedAgentPowerPlatformObservation | null;
      error: UnifiedAgentSourceError;
    };

export type SavedAgentPerson = {
  objectId: string;
  displayName: string | null;
  /** Directory sign-in name, not a verified email address. */
  userPrincipalName: string | null;
  observedAt: string;
  status?: "resolved" | "not_found" | "lookup_failed";
  checkedAt?: string;
  expiresAt?: string;
  errorCode?: string;
};

export type SavedAgentEnvironment = {
  id: string;
  displayName: string | null;
  region: string | null;
  environmentType: string | null;
  isManaged: boolean | null;
  groupName: string | null;
  groupId: string | null;
  observation: UnifiedAgentSourceObservation;
  provenance: Record<string, InventoryFieldProvenance>;
};

export type UnifiedAgentRecord = {
  id: string;
  displayName: string;
  presence: UnifiedAgentPresence;
  environmentId: string | null;
  environment?: SavedAgentEnvironment | null;
  packages: CopilotPackage[];
  powerPlatformResource: PowerPlatformResource | null;
  people?: {
    owner?: SavedAgentPerson;
    createdBy?: SavedAgentPerson;
    lastModifiedBy?: SavedAgentPerson;
  };
  usage?: AgentUsageSummary;
  identity: {
    state: UnifiedAgentLinkState;
    evidence: UnifiedAgentLinkEvidence[];
    packageEvidence: Array<{
      packageId: string;
      evidence: UnifiedAgentLinkEvidence[];
    }>;
    reason: string | null;
    warnings?: PackageAgentIdentityWarning[];
    invalidMetadata?: true;
  };
  observations: {
    graphPackages: UnifiedAgentPackageObservation | null;
    packageSnapshots: Record<string, UnifiedAgentPackageRecordObservation>;
    powerPlatform: UnifiedAgentPowerPlatformObservation | null;
  };
};

export type UnifiedAgentInventorySummary = {
  total: number;
  linked: number;
  graphOnly: number;
  powerPlatformOnly: number;
  ambiguous: number;
  conflicting: number;
};

export type UnifiedAgentInventoryVerification = {
  status: "verified" | "details_pending" | "needs_attention";
  scope: "authorized_saved_sources";
  checkedAt: string;
  graphPackageCount: number;
  powerPlatformAgentCount: number;
  representedSourceCount: number;
  uniqueSourceCount: number;
  logicalAgentCount: number;
  checks: {
    sourceScopes: boolean;
    packageMetadata: boolean;
    identityLinks: boolean;
    sourceMemberships: true;
  };
};

export type UnifiedAgentInventoryPage = {
  revision?: string;
  /** Earliest known current evidence expiry across the complete inventory, before filtering or paging. */
  expiresAt?: string | null;
  usageContext?: AgentUsageContext;
  inventoryOverview?: {
    availableToUsers: number;
    organizationCreated: number;
    teamsAvailable: number;
    createdOrAvailable: number;
  };
  value: UnifiedAgentRecord[];
  count: number;
  offset: number;
  limit: number;
  /** Complete authorized inventory before inventory scope, ordinary filters, or paging. */
  summary: UnifiedAgentInventorySummary;
  /** Resolved scope for scopeSummary, inventoryOverview, and facets. */
  inventoryScope: UnifiedAgentInventoryScope;
  /** Selected inventory scope before ordinary filters or paging. */
  scopeSummary: UnifiedAgentInventorySummary;
  filteredSummary: UnifiedAgentInventorySummary;
  verification: UnifiedAgentInventoryVerification;
  identityCollection?: {
    checkedPackages: number;
    pendingPackages: number;
    pendingDetails?: { missing: number; stale: number; invalidated: number };
    invalidPackages?: number;
  };
  facets: {
    environments: Array<{ value: string; label: string }>;
    platforms: Array<{ value: string; label: string }>;
  };
  sources: {
    graphPackages: UnifiedAgentSourceStatus;
    powerPlatform: UnifiedAgentSourceStatus;
  };
  partial: boolean;
  errors: UnifiedAgentSourceError[];
};

export type UnifiedAgentInventoryQuery = {
  /** Defaults to all for exact reads and other non-UI consumers. */
  inventoryScope?: UnifiedAgentInventoryScope;
  view?: UnifiedAgentView;
  endUserAccess?: UnifiedAgentAccessFilter;
  reportedUsage?: UnifiedAgentUsageFilter;
  management?: UnifiedAgentManagementFilter;
  relevance?: UnifiedAgentRelevanceFilter;
  recordId?: string;
  operationIdPrefix?: string;
  search?: string;
  source?: UnifiedAgentSourceFilter;
  linkState?: UnifiedAgentLinkState;
  environmentId?: string;
  blocked?: boolean;
  publisher?: string;
  availableTo?: string;
  host?: string;
  platform?: string;
  createdWithinDays?: number;
  sortBy?: UnifiedAgentSort;
  sortDirection?: UnifiedAgentSortDirection;
  limit?: number;
  offset?: number;
};
