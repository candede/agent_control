export const defenderHuntingTemplateIds = [
  "agents_inventory",
  "agent_activity",
  "agent_tools",
] as const;

export type DefenderHuntingTemplateId = (typeof defenderHuntingTemplateIds)[number];
export type DefenderHuntingTokenMode = "delegated" | "application";
export type DefenderHuntingResultScope =
  | { kind: "principal"; scopeId: string; configurationRevision: null }
  | { kind: "application"; scopeId: string; configurationRevision: number };
export type DefenderHuntingJobStatus = "waiting_authorization" | "running" | "succeeded" | "partial" | "failed" | "cancelled" | "inconclusive";
export type DefenderHuntingPartialReason = "hunting_row_limit";
export type DefenderHuntingFieldState = "value" | "null" | "empty" | "unavailable";
export type DefenderInventoryDetailState = "not_supplied" | "empty" | "present_unqualified_shape" | "not_exposed";

export type DefenderHuntingAssociation =
  | { status: "resolved"; sourceSystem: "power_platform" | "graph_packages"; nativeId: string; resourceType: string; environmentId: string | null; matchedKind: "entra_agent_id" }
  | { status: "unresolved"; reason: "no_documented_exact_identifier" | "no_documented_cross_source_relation" | "blueprint_is_parent_not_equivalence" }
  | { status: "ambiguous"; reason: "multiple_exact_candidates"; candidateCount: number };

export type DefenderHuntingFilters = {
  templateId: DefenderHuntingTemplateId;
  startDateTime: string;
  endDateTime: string;
  agentIds: string[];
  blueprintIds: string[];
  actorObjectIds: string[];
  operations: string[];
};

export const defenderHuntingTemplates: Record<DefenderHuntingTemplateId, {
  label: string;
  sourceTable: "AgentsInfo" | "CloudAppEvents";
  operations: string[];
}> = {
  agents_inventory: {
    label: "Defender agent inventory",
    sourceTable: "AgentsInfo",
    operations: [],
  },
  agent_activity: {
    label: "Agent activity",
    sourceTable: "CloudAppEvents",
    operations: ["InvokeAgent", "InferenceCall"],
  },
  agent_tools: {
    label: "Agent tool activity",
    sourceTable: "CloudAppEvents",
    operations: ["ExecuteToolBySDK", "ExecuteToolByGateway", "ExecuteToolByMCPServer"],
  },
};

export type DefenderAgentInventoryRow = {
  projectionVersion: 3;
  sourceTable: "AgentsInfo";
  observationTime: string;
  agentId: string;
  agentName: string | null;
  platform: string | null;
  agentDescription: string | null;
  version: string | null;
  sourceAgentId: string | null;
  entraAgentObjectId: string | null;
  entraBlueprintId: string | null;
  observabilityId: string | null;
  publishedStatus: string | null;
  lifecycleStatus: string | null;
  availability: string | null;
  createdDateTime: string | null;
  lastPublishedDateTime: string | null;
  lastUpdatedDateTime: string | null;
  instanceCount: number | null;
  model: string | null;
  ownerCount: number | null;
  sharedWithCount: number | null;
  permissionMetadataKeyCount: number | null;
  authenticationMetadataKeyCount: number | null;
  detailStates: {
    owners: DefenderInventoryDetailState;
    sharing: DefenderInventoryDetailState;
    permissions: DefenderInventoryDetailState;
    authentication: DefenderInventoryDetailState;
    risk: DefenderInventoryDetailState;
  };
  association?: DefenderHuntingAssociation;
};

export type DefenderAgentActivityRow = {
  projectionVersion: 3;
  sourceTable: "CloudAppEvents";
  timestamp: string;
  actionType: string;
  cloudApplication: string | null;
  cloudApplicationId: number | null;
  cloudAppInstanceId: number | null;
  actorAccountObjectId: string | null;
  actorProviderAccountId: string | null;
  objectId: string | null;
  reportId: string | null;
  oauthAppId: string | null;
  operation: string | null;
  organizationId: string | null;
  targetAgentId: string | null;
  targetAgentName: string | null;
  targetAgentBlueprintId: string | null;
  agentId: string | null;
  agentName: string | null;
  agentBlueprintId: string | null;
  alternatePlatformAgentId: string | null;
  platformAgentType: string | null;
  conversationId: string | null;
  conversationThreadId: string | null;
  sessionIdentity: string | null;
  channelName: string | null;
  humanActorUserObjectId: string | null;
  humanActorUserPrincipalName: string | null;
  agentUserObjectId: string | null;
  agentUserPrincipalName: string | null;
  targetAgentUserObjectId: string | null;
  spanId: string | null;
  parentSpanId: string | null;
  creationTime: string | null;
  completionTime: string | null;
  errorType: string | null;
  toolName: string | null;
  toolType: string | null;
  toolCallId: string | null;
  invokeSource: string | null;
  durationMilliseconds: number | null;
  outcome: "error" | "unknown";
  spanRole: "root_invoke_agent" | "child" | "unresolved";
  rootSpanObserved: boolean;
  fieldStates: Record<"conversationId" | "conversationThreadId" | "channelName" | "humanActorUserObjectId" | "agentUserObjectId"
    | "targetAgentUserObjectId" | "completionTime" | "errorType" | "platformAgentId" | "platformAgentType", DefenderHuntingFieldState>;
  contentAvailable: false;
  association?: DefenderHuntingAssociation;
};

export type DefenderHuntingRow = DefenderAgentInventoryRow | DefenderAgentActivityRow;

export type DefenderHuntingQueryResult = {
  rows: DefenderHuntingRow[];
  providerRowCount: number;
  storedRowCount: number;
  byteCount: number;
  complete: boolean;
  partialReason: DefenderHuntingPartialReason | null;
};

export type DefenderHuntingQualificationBinding = {
  capabilityId: "defender.hunting.delegated" | "defender.hunting.application";
  contractRevision: string;
  permissionRevision: string;
  configurationRevision: number;
  approvedBy: string;
};

export type DefenderHuntingAuthorityBinding = Omit<DefenderHuntingQualificationBinding, "approvedBy">;

export type DefenderHuntingQualificationEvidence = DefenderHuntingAuthorityBinding & {
  templateId: DefenderHuntingTemplateId;
  targetScopeHash: string;
  approvedScope: Omit<DefenderHuntingFilters, "startDateTime" | "endDateTime">;
  queryVersion: 3;
  approvedBy: string;
  qualifiedAt: string;
  expiresAt: string;
};

export type DefenderHuntingRetainedScope = DefenderHuntingAuthorityBinding & {
  id: string;
  resultScope: DefenderHuntingResultScope;
  tokenMode: DefenderHuntingTokenMode;
  templateId: DefenderHuntingTemplateId;
  targetScopeHash: string;
  approvedScope: Omit<DefenderHuntingFilters, "startDateTime" | "endDateTime">;
  queryVersion: 3;
  approvedBy: string;
  sourceQualificationJobId: string;
  approvedAt: string;
  qualifiedAt: string;
  expiresAt: string;
  revokedAt: string | null;
};

export type DefenderHuntingRetainedScopeBinding = {
  id: string;
  authority: DefenderHuntingAuthorityBinding;
};

export type DefenderHuntingJob = {
  id: string;
  authorizationPrincipalId: string;
  resultScope: DefenderHuntingResultScope;
  tokenMode: DefenderHuntingTokenMode;
  status: DefenderHuntingJobStatus;
  filters: DefenderHuntingFilters;
  queryVersion: 1 | 2 | 3;
  retainedScopeId: string | null;
  localRequestId: string;
  providerRequestId: string | null;
  providerRequestCount: number;
  activationCount: number;
  providerRowCount: number;
  storedRowCount: number;
  byteCount: number;
  complete: boolean;
  noData: boolean;
  partialReason: DefenderHuntingPartialReason | null;
  observedRange: { startDateTime: string; endDateTime: string } | null;
  unobservedRange: { startDateTime: string; endDateTime: string } | null;
  snapshotId: string | null;
  priorSuccessfulJobId: string | null;
  qualification: DefenderHuntingQualificationBinding | null;
  errorCode?: string;
  message?: string;
  cancelRequested: boolean;
  createdAt: string;
  attemptedAt: string | null;
  updatedAt: string;
  finishedAt: string | null;
  expiresAt: string;
  canResume: boolean;
};

export type DefenderHuntingSnapshot = {
  id: string;
  jobId: string;
  resultScope: DefenderHuntingResultScope;
  filters: DefenderHuntingFilters;
  sourceTable: "AgentsInfo" | "CloudAppEvents";
  queryVersion: 1 | 2 | 3;
  requestedRange: { startDateTime: string; endDateTime: string };
  observedRange: { startDateTime: string; endDateTime: string } | null;
  unobservedRange: { startDateTime: string; endDateTime: string } | null;
  observationTime: string;
  complete: boolean;
  noData: boolean;
  partialReason: DefenderHuntingPartialReason | null;
  providerRowCount: number;
  storedRowCount: number;
  byteCount: number;
  expiresAt: string;
};

export type DefenderHuntingHistory = {
  value: DefenderHuntingJob[];
  count: number;
  limit: number;
  offset: number;
};

export type DefenderHuntingRowPage = {
  value: DefenderHuntingRow[];
  count: number;
  limit: number;
  offset: number;
  job: DefenderHuntingJob;
  snapshot: DefenderHuntingSnapshot;
};