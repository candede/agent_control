import type { CopilotPackage } from "./copilotPackage.js";
import type { PackageAgentIdentityWarning, PackageAgentLinkEvidence } from "../services/packageAgentIdentity.js";
import type {
  InventoryCoverageStatus,
  InventorySnapshotVerification,
  PowerPlatformResource,
} from "./powerPlatformInventory.js";

export type UnifiedAgentSource = "graph_packages" | "power_platform";
export type UnifiedAgentSourceFilter = "all" | UnifiedAgentSource | "both";
export type UnifiedAgentPresence = "graph_packages" | "power_platform" | "both";
export type UnifiedAgentLinkState = "matched" | "unmatched" | "ambiguous" | "conflicting";
export type UnifiedAgentSort = "displayName" | "environment" | "source" | "lastModifiedAt";
export type UnifiedAgentSortDirection = "asc" | "desc";

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

export type UnifiedAgentRecord = {
  id: string;
  displayName: string;
  presence: UnifiedAgentPresence;
  environmentId: string | null;
  packages: CopilotPackage[];
  powerPlatformResource: PowerPlatformResource | null;
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
  status: "verified" | "needs_attention";
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
  value: UnifiedAgentRecord[];
  count: number;
  offset: number;
  limit: number;
  summary: UnifiedAgentInventorySummary;
  filteredSummary: UnifiedAgentInventorySummary;
  verification: UnifiedAgentInventoryVerification;
  identityCollection?: { checkedPackages: number; pendingPackages: number; invalidPackages?: number };
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
