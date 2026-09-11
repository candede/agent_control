export const purviewAuditPresetIds = [
  "copilot_interactions",
  "copilot_studio_admin",
] as const;

export type PurviewAuditPresetId = (typeof purviewAuditPresetIds)[number];
export type PurviewAuditTokenMode = "delegated" | "application";
export type PurviewProviderQueryStatus = "notStarted" | "running" | "succeeded" | "failed" | "cancelled" | "unknownFutureValue";
export type PurviewAuditJobStatus = "waiting_authorization" | "reconciling_create" | "running" | "succeeded" | "failed" | "cancelled" | "partial" | "inconclusive";
export type PurviewAuditPartialReason = "provider_error" | "provider_throttled" | "provider_result_limit" | "audit_provider_request_limit" | "audit_job_expired" | "audit_activation_timeout" | "audit_page_limit" | "audit_row_limit" | "audit_byte_limit";
export type PurviewAuditResultScope =
  | { kind: "principal"; scopeId: string; configurationRevision: null }
  | { kind: "application"; scopeId: string; configurationRevision: number };

export type PurviewAuditFilters = {
  presetId: PurviewAuditPresetId;
  operations: string[];
  startDateTime: string;
  endDateTime: string;
  userPrincipalNames: string[];
  ipAddresses: string[];
  objectIds: string[];
  administrativeUnitIds: string[];
};

export type PurviewProviderQuery = {
  id: string;
  displayName: string;
  filterStartDateTime: string;
  filterEndDateTime: string;
  serviceFilter: string;
  recordTypeFilters: string[];
  operationFilters: string[];
  userPrincipalNameFilters: string[];
  ipAddressFilters: string[];
  objectIdFilters: string[];
  administrativeUnitIdFilters: string[];
  status: PurviewProviderQueryStatus;
};

export type PurviewMessageReference = {
  id: string;
  isPrompt: boolean;
};

export type PurviewRecordAssociation =
  | { status: "resolved"; sourceSystem: "power_platform"; nativeId: string; resourceType: string; environmentId: string; matchedKind: "cds_bot_id" }
  | { status: "unresolved"; reason: "missing_environment" | "no_documented_exact_identifier" | "no_documented_cross_source_relation" }
  | { status: "ambiguous"; reason: "multiple_exact_candidates"; candidateCount: number };

export type PurviewAuditRecord = {
  projectionVersion: 1;
  wrapperId: string;
  nativeEventId: string | null;
  eventDateTime: string;
  auditLogRecordType: string;
  operation: string;
  service: string;
  resultStatus: string | null;
  actorUserId: string | null;
  actorUserPrincipalName: string | null;
  actorUserType: string | null;
  objectId: string | null;
  clientIp: string | null;
  administrativeUnits: string[];
  correlationId: string | null;
  agentId: string | null;
  appIdentity: string | null;
  appHost: string | null;
  botId: string | null;
  environmentId: string | null;
  botComponentId: string | null;
  aiPluginOperationId: string | null;
  messages: PurviewMessageReference[];
  contentAvailable: false;
  unknownFieldCount: number;
  association?: PurviewRecordAssociation;
};

export type PurviewAuditResult = {
  records: PurviewAuditRecord[];
  pageCount: number;
  providerRowCount: number;
  storedRowCount: number;
  byteCount: number;
  unknownFieldCount: number;
  complete: boolean;
  nextLink: string | null;
  partialReason: PurviewAuditPartialReason | null;
};

export type PurviewAuditJob = {
  id: string;
  authorizationPrincipalId: string;
  resultScope: PurviewAuditResultScope;
  tokenMode: PurviewAuditTokenMode;
  status: PurviewAuditJobStatus;
  filters: PurviewAuditFilters;
  displayName: string;
  providerQueryId: string | null;
  providerStatus: PurviewProviderQueryStatus | null;
  localRequestId: string;
  providerRequestId: string | null;
  projectionVersion: 1;
  providerRequestCount: number;
  activationCount: number;
  pageCount: number;
  providerRowCount: number;
  storedRowCount: number;
  byteCount: number;
  unknownFieldCount: number;
  pageComplete: boolean;
  observedRange: { startDateTime: string; endDateTime: string } | null;
  unobservedRange: { startDateTime: string; endDateTime: string } | null;
  errorCode?: string;
  message?: string;
  qualificationId: string | null;
  cancelRequested: boolean;
  createdAt: string;
  attemptedAt: string | null;
  updatedAt: string;
  finishedAt: string | null;
  expiresAt: string;
  canResume: boolean;
  remoteWorkMayContinue: boolean;
};

export type PurviewAuditHistory = {
  value: PurviewAuditJob[];
  count: number;
  limit: number;
  offset: number;
};

export type PurviewAuditRecordPage = {
  value: PurviewAuditRecord[];
  count: number;
  limit: number;
  offset: number;
  job: PurviewAuditJob;
};

export type PurviewAuditQualification = {
  id: string;
  capabilityId: "purview.audit.search.delegated" | "purview.audit.search.application";
  tokenMode: PurviewAuditTokenMode;
  authorizationPrincipalId: string;
  resultScope: PurviewAuditResultScope;
  filters: PurviewAuditFilters;
  status: "approved" | "running" | "qualified" | "failed" | "inconclusive" | "expired";
  contractRevision: string;
  permissionRevision: string;
  configurationRevision: number;
  approvedBy: string;
  approvedAt: string;
  expiresAt: string;
  jobId: string | null;
  errorCode?: string;
};

export const purviewAuditPresets: Record<PurviewAuditPresetId, {
  label: string;
  serviceFilter: string;
  recordTypeFilters: string[];
  operationFilters: string[];
}> = {
  copilot_interactions: {
    label: "Copilot interactions",
    serviceFilter: "Copilot",
    recordTypeFilters: ["copilotInteraction"],
    operationFilters: ["CopilotInteraction"],
  },
  copilot_studio_admin: {
    label: "Copilot Studio administration",
    serviceFilter: "PowerPlatform",
    recordTypeFilters: ["powerPlatformAdministratorActivity"],
    operationFilters: [
      "BotCreate",
      "BotDelete",
      "BotDeleteCleanup",
      "BotUpdateOperation-BotNameUpdate",
      "BotUpdateOperation-BotAuthUpdate",
      "BotUpdateOperation-BotIconUpdate",
      "BotUpdateOperation-BotPublish",
      "BotUpdateOperation-BotShare",
      "BotAppInsightsUpdate",
      "BotComponentCreate",
      "BotComponentUpdate",
      "BotComponentDelete",
      "BotComponentCollectionCreate",
      "BotComponentCollectionUpdate",
      "BotComponentCollectionDelete",
      "AIPluginOperationCreate",
      "AIPluginOperationUpdate",
      "AIPluginOperationDelete",
      "EnvironmentVariableCreate",
      "EnvironmentVariableUpdate",
      "EnvironmentVariableDelete",
    ],
  },
};