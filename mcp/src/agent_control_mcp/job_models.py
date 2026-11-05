"""Durable job/status, administrative audit and native activity wire projections."""

from typing import Annotated, Literal

from pydantic import BeforeValidator, Field, StrictBool, StrictInt, TypeAdapter

from .inventory_models import NativeResource, ResourceType
from .models import SafeInteger, WireModel
from .report_models import Counts, Page

SyncSource = Literal["users", "graph_packages", "power_platform", "usage_reports"]
RefreshStatus = Literal["waiting_authorization", "running", "succeeded", "failed", "cancelled"]


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
    version: Annotated[Literal[1], BeforeValidator(TypeAdapter(StrictInt).validate_python)]
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


BlockAuditAction = Literal["block", "unblock"]
NonBlockAuditAction = Literal[
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
AuditAction = Literal[BlockAuditAction, NonBlockAuditAction]
AuditStatus = Literal[
    "requested", "started", "succeeded", "failed", "skipped", "inconclusive", "cancelled"
]


class AuditEventBase(WireModel):
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


class BlockAuditEvent(AuditEventBase):
    action: BlockAuditAction
    targetBlockedState: bool


class NonBlockAuditEvent(AuditEventBase):
    action: NonBlockAuditAction


AuditEvent = Annotated[BlockAuditEvent | NonBlockAuditEvent, Field(discriminator="action")]


class AuditEvents(WireModel):
    value: list[AuditEvent]
    count: SafeInteger


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
    current: Annotated[Literal[True], BeforeValidator(TypeAdapter(StrictBool).validate_python)]


class StudioTargets(WireModel):
    value: list[NativeResource]
    snapshot: NativeSnapshot
