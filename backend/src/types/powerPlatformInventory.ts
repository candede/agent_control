export const powerPlatformResourceTypes = [
  "microsoft.copilotstudio/agents",
  "microsoft.powerplatform/environments",
] as const;

export type PowerPlatformResourceType = typeof powerPlatformResourceTypes[number];
export type InventoryRoleScope = "full" | "ai" | "unknown";
export type InventoryCoverageStatus = "covered" | "not_requested" | "not_authorized_scope" | "unknown";
export type InventoryJobStatus = "waiting_authorization" | "running" | "succeeded" | "failed" | "cancelled";
export type InventoryFieldMaturity = "ga" | "preview";
export type InventoryIdentifierKind =
  | "power_platform_resource_id"
  | "cds_bot_id"
  | "entra_app_id"
  | "entra_agent_id"
  | "entra_blueprint_id"
  | "environment_id"
  | "package_id"
  | "package_app_id"
  | "manifest_id"
  | "asset_id";

export type InventoryIdentifier = {
  kind: InventoryIdentifierKind;
  value: string;
};

export type InventoryFieldProvenance = {
  sourceSystem: "power_platform" | "graph_packages";
  path: string;
  maturity: InventoryFieldMaturity;
};

export type InventoryConnectorOperation = {
  operationId: string;
  /** User who configured this operation, not the agent owner or creator. */
  createdBy?: string;
  usedAs?: string;
  isEnabled?: boolean;
  requiresEndUserConsent?: boolean;
  whenCanBeUsed?: string;
  connectionProvider?: string;
};

export type InventoryConnector = {
  connectorId: string;
  operations?: InventoryConnectorOperation[];
};

export type PowerPlatformResourceDetails = {
  ownerId?: string;
  lastModifiedAt?: string;
  lastModifiedBy?: string;
  isQuarantined?: boolean;
  quarantinedAt?: string;
  isManaged?: boolean;
  schemaName?: string;
  createdIn?: string;
  environmentType?: string;
  environmentGroup?: string;
  environmentGroupId?: string;
  orchestration?: string;
  model?: string;
  authentication?: string;
  channels?: string[];
  connectors?: InventoryConnector[];
  distinctPowerPlatformConnectors?: number;
  distinctPowerPlatformConnectorsOperations?: number;
  isWebSearchEnabledForKnowledge?: boolean;
  capabilityDetailsTruncated?: boolean;
  connectorDetailsStatus?: "not_supplied" | "complete" | "partial";
};

export type PowerPlatformResource = {
  tenantId: string;
  nativeId: string;
  type: PowerPlatformResourceType;
  location: string | null;
  displayName: string | null;
  environmentId: string | null;
  createdAt: string | null;
  createdBy: string | null;
  lastPublishedAt: string | null;
  sourceSystem: "power_platform";
  authoringTool: string | null;
  creatorType: "unknown";
  agentKind: string;
  lifecycle: "draft" | "published" | "unknown" | "not_applicable";
  identityConfidence: "exact_native" | "partial";
  identifiers: InventoryIdentifier[];
  provenance: Record<string, InventoryFieldProvenance>;
  details: PowerPlatformResourceDetails;
  unknownFieldCount: number;
};

export function derivePowerPlatformAuthoringTool(type: PowerPlatformResourceType, createdIn?: string | null): string | null {
  if (type === "microsoft.copilotstudio/agents") {
    const normalized = createdIn?.toLowerCase().replace(/[^a-z0-9]/g, "");
    return normalized === "copilotstudio" ? "Copilot Studio"
      : normalized === "copilotstudiolite" || normalized === "microsoft365copilotagentbuilder"
        ? "Microsoft 365 Copilot Agent Builder" : null;
  }
  return null;
}

export function powerPlatformAuthoringTool(resource: Pick<PowerPlatformResource, "type" | "authoringTool" | "details">): string | null {
  return resource.authoringTool?.trim() || derivePowerPlatformAuthoringTool(resource.type, resource.details.createdIn);
}

export type ResourceQueryResult = {
  resources: PowerPlatformResource[];
  queriedTypes: PowerPlatformResourceType[];
  environmentScope: string | null;
  totalRecords: number;
  pages: number;
  unknownFieldCount: number;
};

export type InventoryTypeCoverage = {
  type: PowerPlatformResourceType;
  status: InventoryCoverageStatus;
  count: number | null;
};

export type InventorySnapshotVerification = {
  status: "verified";
  scope: "authorized_query";
  basis: "provider_total_and_saved_rows";
  checkedAt: string;
  storedCount: number;
  uniqueIdentityCount: number;
  queriedTypes: PowerPlatformResourceType[];
};

export type InventorySnapshot = {
  id: string;
  roleScope: InventoryRoleScope;
  environmentScope: string | null;
  requestedTypes: PowerPlatformResourceType[];
  coverage: InventoryTypeCoverage[];
  observedCount: number;
  totalRecords: number;
  pageCount: number;
  unknownFieldCount: number;
  observedAt: string;
  expiresAt: string;
  verification: InventorySnapshotVerification;
};

export type InventoryResourcePage = {
  value: PowerPlatformResource[];
  count: number;
  snapshot: InventorySnapshot | null;
};

export type InventoryRefreshJob = {
  id: string;
  status: InventoryJobStatus;
  roleScope: InventoryRoleScope;
  environmentScope: string | null;
  requestedTypes: PowerPlatformResourceType[];
  pageCount: number;
  observedCount: number;
  totalRecords: number | null;
  unknownFieldCount: number;
  snapshotId: string | null;
  errorCode?: string;
  message?: string;
  createdAt: string;
  attemptedAt: string | null;
  updatedAt: string;
  finishedAt: string | null;
};

export type InventoryRefreshJobList = {
  value: InventoryRefreshJob[];
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
};
