import type { IdentityResolution } from "../services/inventoryIdentity.js";

export const powerPlatformResourceTypes = [
  "microsoft.powerapps/canvasapps",
  "microsoft.powerapps/modeldrivenapps",
  "microsoft.powerapps/codeapps",
  "microsoft.powerapps/apps",
  "microsoft.powerautomate/cloudflows",
  "microsoft.powerautomate/agentflows",
  "microsoft.powerautomate/m365agentflows",
  "microsoft.copilotstudio/agents",
  "microsoft.powerplatformconnector/connectors",
  "microsoft.powerplatform/environments",
  "microsoft.powerplatform/environmentgroups",
] as const;

export type PowerPlatformResourceType = typeof powerPlatformResourceTypes[number];
export type InventoryRoleScope = "full" | "ai" | "unknown";
export type InventoryCoverageStatus = "covered" | "not_authorized_scope" | "unknown";
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
  displayName?: string;
  description?: string;
  method?: string;
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
  appModuleId?: string;
  logicalName?: string;
  subType?: string;
  workflowEntityId?: string;
  trigger?: string;
  triggerOperation?: string;
  environmentType?: string;
  environmentGroup?: string;
  environmentGroupId?: string;
  description?: string;
  connectorId?: string;
  publisher?: string;
  tier?: string;
  releaseTag?: string;
  isDeprecated?: boolean;
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
  association?: IdentityResolution;
  provenance: Record<string, InventoryFieldProvenance>;
  details: PowerPlatformResourceDetails;
  unknownFieldCount: number;
};

export type ResourceQueryResult = {
  resources: PowerPlatformResource[];
  totalRecords: number;
  pages: number;
  unknownFieldCount: number;
};

export type InventoryTypeCoverage = {
  type: PowerPlatformResourceType;
  status: InventoryCoverageStatus;
  count: number | null;
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
};

export type InventoryResourcePage = {
  value: PowerPlatformResource[];
  count: number;
  typeCounts: InventoryTypeCoverage[];
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

export type InventorySnapshotList = {
  value: InventorySnapshot[];
};