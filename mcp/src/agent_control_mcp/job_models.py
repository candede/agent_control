"""Durable job/status and minimized investigation wire projections."""

from typing import Literal

from .inventory_models import NativeResource, ResourceType
from .models import SafeInteger, WireModel
from .report_models import Counts, Page

SyncSource = Literal["users", "graph_packages", "power_platform", "usage_reports"]
RefreshStatus = Literal["waiting_authorization", "running", "succeeded", "failed", "cancelled"]
TemplateId = Literal["agents_inventory", "agent_activity", "agent_tools"]
PresetId = Literal["copilot_interactions", "copilot_studio_admin"]


class WorkspaceJob(WireModel):
    id: str
    source: Literal["data-sync", "package-refresh", "power-platform"]
    label: str
    target: str
    status: str
    total: SafeInteger | None
    completed: SafeInteger | None
    partial: bool
    tokenMode: Literal["delegated", "application"] | None = None
    createdAt: str | None = None
    startedAt: str | None = None
    completedAt: str | None = None
    syncSources: list[SyncSource] | None = None
    updatedAt: str
    href: str


class UnavailableSource(WireModel):
    source: Literal["data-sync", "package-refresh", "power-platform"]
    code: str


class WorkspaceJobs(WireModel):
    value: list[WorkspaceJob]
    unavailableSources: list[UnavailableSource]
    polledAt: str
    requestId: str


class SyncSourceStatus(WireModel):
    source: SyncSource
    status: Literal[
        "not_started",
        "queued",
        "running",
        "waiting_authorization",
        "permission_required",
        "awaiting_upload",
        "succeeded",
        "partial",
        "failed",
        "cancelled",
    ]
    jobId: str | None
    count: SafeInteger | None
    lastSuccessAt: str | None
    updatedAt: str | None
    message: str
    canRetry: bool


class SyncRun(WireModel):
    id: str
    mode: Literal["initial", "incremental", "full"]
    automatic: bool | None = None
    status: Literal["running", "waiting", "completed", "partial", "cancelled"]
    startedAt: str
    updatedAt: str
    completedAt: str | None
    sources: list[SyncSourceStatus]


class SyncState(WireModel):
    onboardingRequired: bool
    usageImportRequired: bool
    run: SyncRun | None
    sources: list[SyncSourceStatus]


class DetailSyncJob(WireModel):
    id: str
    status: RefreshStatus
    observedCount: SafeInteger
    targetCount: SafeInteger
    updatedAt: str
    errorCode: str | None = None
    message: str | None = None


class DetailSyncState(WireModel):
    status: Literal[
        "not_collected",
        "ready",
        "running",
        "complete",
        "waiting_authorization",
        "permission_required",
        "failed",
        "paused",
    ]
    total: SafeInteger
    fresh: SafeInteger
    pending: SafeInteger
    eligible: SafeInteger
    message: str
    job: DetailSyncJob | None


class RefreshJob(WireModel):
    id: str
    status: RefreshStatus
    pageCount: SafeInteger
    observedCount: SafeInteger
    totalRecords: SafeInteger | None
    snapshotId: str | None
    errorCode: str | None = None
    message: str | None = None
    createdAt: str
    attemptedAt: str | None
    updatedAt: str
    finishedAt: str | None


class PackageRefreshJob(RefreshJob):
    authorizationPrincipalId: str
    tokenMode: Literal["application"]
    scopeKind: Literal["broad", "exact"]
    targetCount: SafeInteger
    resultRevision: str
    autoDetails: bool


class StudioRefreshJob(RefreshJob):
    roleScope: Literal["full", "ai", "unknown"]
    environmentScope: str | None
    requestedTypes: list[ResourceType]
    unknownFieldCount: SafeInteger


class RefreshJobs[T](WireModel):
    value: list[T]
    lastAttemptAt: str | None
    lastSuccessAt: str | None


class RefreshTarget(WireModel):
    ordinal: SafeInteger
    id: str
    status: str


class RefreshTargets(WireModel):
    value: list[RefreshTarget]
    revision: str
    counts: Counts
    page: Page


class DirectoryPrincipal(WireModel):
    resourceId: str
    resourceType: str
    displayName: str
    secondaryText: str | None = None
    principalKind: Literal["user", "securityGroup", "microsoft365Group", "unknown"]
    userPrincipalName: str | None = None


class DirectoryPrincipals(WireModel):
    value: list[DirectoryPrincipal]


class Attribution(WireModel):
    value: str | None
    evidence: Literal["authenticated", "reported", "unknown"]


class OriginClient(WireModel):
    id: Attribution
    name: Attribution
    version: Attribution


class OriginAgent(WireModel):
    id: Attribution
    name: Attribution


class Origin(WireModel):
    version: Literal[1]
    channel: Literal["webapp", "mcp", "unknown"]
    integrationClientId: str | None
    client: OriginClient
    callingAgent: OriginAgent
    requestId: str | None
    mcpCallId: str | None


class Actor(WireModel):
    username: str
    displayName: str
    homeAccountId: str
    tenantId: str | None = None


AuditAction = Literal[
    "block",
    "unblock",
    "update-availability",
    "update-installation",
    "reassign",
    "view-audit-search",
    "export-audit-search",
    "view-hunting",
    "export-hunting",
    "submit-hunting",
    "query-hunting",
    "cancel-hunting",
    "delete-hunting",
    "export-package-inventory",
    "export-power-platform-inventory",
    "export-agent-inventory",
    "export-official-usage-aggregate",
    "export-official-usage-users",
    "export-administrative-audit",
    "associate-agent-usage",
    "remove-agent-usage-association",
    "resume-control",
    "cancel-control",
    "reconcile-control",
]
AuditStatus = Literal[
    "requested", "started", "succeeded", "failed", "skipped", "inconclusive", "cancelled"
]


class AuditEvent(WireModel):
    id: str
    operationId: str
    scope: Literal["single", "bulk"]
    agentId: str
    agentDisplayName: str | None = None
    actor: Actor
    startedAt: str
    completedAt: str | None = None
    status: AuditStatus
    message: str | None = None
    errorCode: str | None = None
    requestPath: str
    metadata: dict[str, str | int | float | bool] | None = None
    origin: Origin
    action: AuditAction
    targetBlockedState: bool | None = None


class AuditEvents(WireModel):
    value: list[AuditEvent]
    count: SafeInteger


ReasonCode = Literal[
    "unsupported_identity_crosswalk",
    "ambiguous_identity",
    "stale_source",
    "missing_identity_candidate",
    "invalid_identity_candidate",
    "identity_resolution_required",
    "purview_identity_unavailable",
    "identity_resolution_expired",
    "identity_authorization_required",
    "identity_not_found",
    "identity_provider_error",
    "identity_setup_required",
]


class InvestigationAvailability(WireModel):
    status: Literal["available", "unavailable"]
    reason: str | None = None
    reasonCode: ReasonCode | None = None


class IdentityResolution(WireModel):
    canResolve: bool
    capabilityId: Literal["graph.agentIdentity.read"]
    reason: str | None = None
    reasonCode: ReasonCode | None = None
    resolvedAt: str | None = None
    expiresAt: str | None = None
    cacheStatus: (
        Literal[
            "resolved",
            "authorization_required",
            "not_found",
            "provider_error",
            "setup_required",
            "missing",
            "expired",
            "source_unavailable",
        ]
        | None
    ) = None
    lastCheckedAt: str | None = None
    lastErrorCode: str | None = None
    runtimeStatus: Literal["available"] | None = None
    runtimeProvenance: Literal["verified-entra-agent-identity-client-id"] | None = None


class DefenderContext(InvestigationAvailability):
    entraAgentIds: list[str]
    entraAgentApplicationIds: list[str] | None = None
    templates: dict[TemplateId, InvestigationAvailability] | None = None
    resolution: IdentityResolution | None = None


class PurviewContext(InvestigationAvailability):
    mode: Literal["search"]
    presets: list[PresetId]


class InvestigationContext(WireModel):
    recordId: str
    displayName: str
    defender: DefenderContext
    purview: PurviewContext


class TimeRange(WireModel):
    startDateTime: str
    endDateTime: str


class ResultScope(WireModel):
    kind: Literal["principal", "application"]
    scopeId: str
    configurationRevision: SafeInteger | None


class PurviewAgent(WireModel):
    recordId: str
    botId: str
    environmentId: str
    applicationId: str | None = None


class PurviewFilters(WireModel):
    presetId: PresetId
    operations: list[str]
    startDateTime: str
    endDateTime: str
    userPrincipalNames: list[str]
    ipAddresses: list[str]
    objectIds: list[str]
    administrativeUnitIds: list[str]
    agent: PurviewAgent | None = None


class HuntingFilters(WireModel):
    templateId: TemplateId
    startDateTime: str
    endDateTime: str
    agentIds: list[str]
    entraAgentIds: list[str] | None = None
    entraAgentApplicationIds: list[str] | None = None
    blueprintIds: list[str]
    actorObjectIds: list[str]
    userObjectId: str | None = None
    operations: list[str]


class InvestigationJob(WireModel):
    id: str
    authorizationPrincipalId: str
    resultScope: ResultScope
    tokenMode: Literal["delegated", "application"]
    status: Literal[
        "waiting_authorization",
        "reconciling_create",
        "running",
        "succeeded",
        "failed",
        "cancelled",
        "partial",
        "inconclusive",
    ]
    localRequestId: str
    providerRequestId: str | None
    providerRequestCount: SafeInteger
    activationCount: SafeInteger
    providerRowCount: SafeInteger
    storedRowCount: SafeInteger
    byteCount: SafeInteger
    observedRange: TimeRange | None
    unobservedRange: TimeRange | None
    errorCode: str | None = None
    message: str | None = None
    cancelRequested: bool
    createdAt: str
    attemptedAt: str | None
    updatedAt: str
    finishedAt: str | None
    expiresAt: str
    canResume: bool


class PurviewJob(InvestigationJob):
    filters: PurviewFilters
    displayName: str
    providerQueryId: str | None
    providerStatus: (
        Literal["notStarted", "running", "succeeded", "failed", "cancelled", "unknownFutureValue"]
        | None
    )
    projectionVersion: Literal[1]
    pageCount: SafeInteger
    unknownFieldCount: SafeInteger
    pageComplete: bool
    remoteWorkMayContinue: bool


class HuntingJob(InvestigationJob):
    origin: Origin | None = None
    initiatingActor: Actor | None = None
    filters: HuntingFilters
    queryVersion: Literal[3]
    complete: bool
    noData: bool
    partialReason: Literal["hunting_row_limit"] | None
    snapshotId: str | None
    priorSuccessfulJobId: str | None


class JobHistory[T](WireModel):
    value: list[T]
    count: SafeInteger
    limit: SafeInteger
    offset: SafeInteger


class RecordAssociation(WireModel):
    status: Literal["resolved", "unresolved", "ambiguous"]
    sourceSystem: Literal["power_platform", "graph_packages"] | None = None
    nativeId: str | None = None
    resourceType: str | None = None
    environmentId: str | None = None
    matchedKind: Literal["cds_bot_id", "entra_agent_id"] | None = None
    reason: (
        Literal[
            "missing_environment",
            "no_documented_exact_identifier",
            "no_documented_cross_source_relation",
            "multiple_exact_candidates",
            "blueprint_is_parent_not_equivalence",
        ]
        | None
    ) = None
    candidateCount: SafeInteger | None = None


class MessageReference(WireModel):
    id: str
    isPrompt: bool


class PurviewRecord(WireModel):
    projectionVersion: Literal[1]
    wrapperId: str
    nativeEventId: str | None
    eventDateTime: str
    auditLogRecordType: str
    operation: str
    service: str
    resultStatus: str | None
    actorUserId: str | None
    actorUserPrincipalName: str | None
    actorUserType: str | None
    objectId: str | None
    clientIp: str | None
    administrativeUnits: list[str]
    correlationId: str | None
    agentId: str | None
    appIdentity: str | None
    appHost: str | None
    botId: str | None
    environmentId: str | None
    botComponentId: str | None
    aiPluginOperationId: str | None
    messages: list[MessageReference]
    contentAvailable: Literal[False]
    unknownFieldCount: SafeInteger
    association: RecordAssociation | None = None
    jobId: str | None = None


class PurviewRecords(JobHistory[PurviewRecord]):
    job: PurviewJob


class AgentPurviewRecords(JobHistory[PurviewRecord]):
    recordId: str
    mode: Literal["saved_only"]


DetailState = Literal["not_supplied", "empty", "present_unqualified_shape", "not_exposed"]


class DetailStates(WireModel):
    owners: DetailState
    sharing: DetailState
    permissions: DetailState
    authentication: DetailState
    risk: DetailState


class HuntingInventoryRow(WireModel):
    projectionVersion: Literal[3]
    sourceTable: Literal["AgentsInfo"]
    observationTime: str
    agentId: str
    agentName: str | None
    platform: str | None
    agentDescription: str | None
    version: str | None
    sourceAgentId: str | None
    entraAgentObjectId: str | None
    entraBlueprintId: str | None
    observabilityId: str | None
    publishedStatus: str | None
    lifecycleStatus: str | None
    availability: str | None
    createdDateTime: str | None
    lastPublishedDateTime: str | None
    lastUpdatedDateTime: str | None
    instanceCount: SafeInteger | None
    model: str | None
    ownerCount: SafeInteger | None
    sharedWithCount: SafeInteger | None
    permissionMetadataKeyCount: SafeInteger | None
    authenticationMetadataKeyCount: SafeInteger | None
    detailStates: DetailStates
    association: RecordAssociation | None = None


FieldState = Literal["value", "null", "empty", "unavailable"]


class FieldStates(WireModel):
    conversationId: FieldState
    conversationThreadId: FieldState
    channelName: FieldState
    humanActorUserObjectId: FieldState
    agentUserObjectId: FieldState
    targetAgentUserObjectId: FieldState
    completionTime: FieldState
    errorType: FieldState
    platformAgentId: FieldState
    platformAgentType: FieldState


class HuntingActivityRow(WireModel):
    projectionVersion: Literal[3]
    sourceTable: Literal["CloudAppEvents"]
    timestamp: str
    actionType: str
    cloudApplication: str | None
    cloudApplicationId: float | None
    cloudAppInstanceId: float | None
    actorAccountObjectId: str | None
    actorProviderAccountId: str | None
    objectId: str | None
    reportId: str | None
    oauthAppId: str | None
    operation: str | None
    organizationId: str | None
    targetAgentId: str | None
    targetAgentName: str | None
    targetAgentBlueprintId: str | None
    agentId: str | None
    agentName: str | None
    agentBlueprintId: str | None
    alternatePlatformAgentId: str | None
    platformAgentType: str | None
    conversationId: str | None
    conversationThreadId: str | None
    sessionIdentity: str | None
    channelName: str | None
    humanActorUserObjectId: str | None
    humanActorUserPrincipalName: str | None
    agentUserObjectId: str | None
    agentUserPrincipalName: str | None
    targetAgentUserObjectId: str | None
    spanId: str | None
    parentSpanId: str | None
    creationTime: str | None
    completionTime: str | None
    errorType: str | None
    toolName: str | None
    toolType: str | None
    toolCallId: str | None
    invokeSource: str | None
    durationMilliseconds: float | None
    outcome: Literal["error", "unknown"]
    spanRole: Literal["root_invoke_agent", "child", "unresolved"]
    rootSpanObserved: bool
    fieldStates: FieldStates
    contentAvailable: Literal[False]
    association: RecordAssociation | None = None


class HuntingSnapshot(WireModel):
    id: str
    jobId: str
    resultScope: ResultScope
    filters: HuntingFilters
    sourceTable: Literal["AgentsInfo", "CloudAppEvents"]
    queryVersion: Literal[3]
    requestedRange: TimeRange
    observedRange: TimeRange | None
    unobservedRange: TimeRange | None
    observationTime: str
    complete: bool
    noData: bool
    partialReason: Literal["hunting_row_limit"] | None
    providerRowCount: SafeInteger
    storedRowCount: SafeInteger
    byteCount: SafeInteger
    expiresAt: str


class HuntingRows(JobHistory[HuntingInventoryRow | HuntingActivityRow]):
    job: HuntingJob
    snapshot: HuntingSnapshot


class PurviewPreset(WireModel):
    id: PresetId
    label: str
    service: str
    recordTypes: list[str]
    operations: list[str]


class PurviewLimits(WireModel):
    maximumWindowHours: SafeInteger
    maximumPages: SafeInteger
    maximumRows: SafeInteger
    maximumBytes: SafeInteger
    pollsPerActivation: SafeInteger
    providerRequests: SafeInteger
    activations: SafeInteger


class PurviewCatalog(WireModel):
    presets: list[PurviewPreset]
    limits: PurviewLimits
    evidenceNotice: str
    contentNotice: str
    retentionNotice: str


class HuntingTemplate(WireModel):
    id: TemplateId
    label: str
    sourceTable: Literal["AgentsInfo", "CloudAppEvents"]
    operations: list[str]


class HuntingLimits(WireModel):
    maximumWindowHours: SafeInteger
    maximumRows: SafeInteger
    maximumBytes: SafeInteger
    providerRequests: SafeInteger
    activations: SafeInteger


class HuntingCatalog(WireModel):
    templates: list[HuntingTemplate]
    limits: HuntingLimits
    scopeNotice: str
    contentNotice: str
    readinessNotice: str
    retentionNotice: str
    defenderPortalUrl: str


class RelatedAuditRecord(WireModel):
    jobId: str
    nativeEventId: str | None
    wrapperId: str
    observedAt: str
    operation: str
    resultStatus: str | None
    correlationId: str | None
    matchedKind: Literal["cds_bot_id"]


class RelatedSecurityRecord(WireModel):
    jobId: str
    snapshotId: str
    nativeRecordId: str
    observedAt: str
    platform: str | None
    lifecycleStatus: str | None
    publishedStatus: str | None
    matchedKind: Literal["entra_agent_id"]


class RelatedAvailable[T](WireModel):
    status: Literal["available"]
    count: SafeInteger
    value: list[T]


class RelatedUnavailable(WireModel):
    status: Literal["unauthorized", "unmatched", "unavailable"]
    reason: str


class RelatedIdentifier(WireModel):
    kind: str
    value: str


class NativeActivity(WireModel):
    source: Literal["power_platform"]
    nativeId: str
    resourceType: str
    environmentId: str | None
    snapshotId: str
    observedAt: str
    expiresAt: str
    identifiers: list[RelatedIdentifier]
    audit: RelatedAvailable[RelatedAuditRecord] | RelatedUnavailable
    security: RelatedAvailable[RelatedSecurityRecord] | RelatedUnavailable


class NativeSnapshot(WireModel):
    id: str
    observedAt: str
    expiresAt: str
    current: Literal[True]


class StudioTargets(WireModel):
    value: list[NativeResource]
    snapshot: NativeSnapshot


class Deleted(WireModel):
    deleted: Literal[True]
    id: str
