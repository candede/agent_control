"""Nested wire DTOs for existing receipts, package jobs and Studio controls."""

from typing import Annotated, Literal

from pydantic import BeforeValidator

from .inventory_models import Principal
from .job_models import AuditAction, Origin
from .models import CapabilityId, SafeInteger, WireModel
from .report_models import Counts, Page

ControlAction = Literal["block", "unblock"]
StudioAction = Literal["quarantine", "unquarantine"]
JobStatus = Literal[
    "queued", "running", "waiting_authorization", "succeeded", "failed", "cancelled", "partial"
]
StudioJobStatus = Literal[
    "queued",
    "running",
    "waiting_authorization",
    "succeeded",
    "failed",
    "cancelled",
    "partial",
    "inconclusive",
]
ItemStatus = Literal[
    "queued", "running", "succeeded", "failed", "cancelled", "inconclusive", "skipped"
]
Reconciliation = Literal[
    "not_required", "required", "verified_applied", "verified_not_applied", "conflict"
]


def boolean_literal(value: object) -> object:
    if type(value) is not bool:
        raise ValueError("Expected an exact API boolean, not a numeric literal.")
    return value


TrueValue = Annotated[Literal[True], BeforeValidator(boolean_literal)]
FalseValue = Annotated[Literal[False], BeforeValidator(boolean_literal)]


class PackageEffect(WireModel):
    provider: Literal["graph_packages"]
    action: ControlAction
    id: str
    displayName: str
    alreadyInState: bool


class StudioEffect(WireModel):
    provider: Literal["power_platform"]
    action: StudioAction
    id: str
    displayName: str
    environmentId: str
    botId: str
    alreadyInState: bool


class Eligibility(WireModel):
    recordId: str
    displayName: str | None
    eligible: bool
    reason: str | None
    effects: list[PackageEffect | StudioEffect]


class AgentControlPreview(WireModel):
    receiptId: str
    confirmationHash: str
    selectionId: str
    action: ControlAction
    expiresAt: str
    targetCount: SafeInteger
    eligibleCount: SafeInteger
    ineligibleCount: SafeInteger
    alreadyInStateCount: SafeInteger
    targets: list[Eligibility]
    providerAtomicity: FalseValue


class ControlChild(WireModel):
    provider: Literal["graph_packages", "power_platform"]
    recordIds: list[str]
    accepted: bool
    jobId: str | None
    status: StudioJobStatus | None
    final: bool
    verified: bool
    verification: Literal["pending", "verified", "unverified", "readback_unknown"]
    errorCode: str | None
    statusUrl: str | None
    itemsUrl: str | None
    cancelUrl: str | None
    resumeUrl: str | None
    reconcileUrl: str | None


class AgentControlExecution(WireModel):
    receiptId: str
    confirmationHash: str
    accepted: TrueValue
    acceptedAt: str
    origin: Origin
    outcome: Literal["accepted", "partial", "ineligible", "failed"]
    final: bool
    verified: bool
    providerAtomicity: FalseValue
    ineligibleCount: SafeInteger
    children: list[ControlChild]


class TargetCount(WireModel):
    count: SafeInteger


class BlockState(WireModel):
    kind: Literal["block"]
    isBlocked: bool


class AccessState(WireModel):
    kind: Literal["access"]
    availableTo: Literal["all", "some", "none"]
    deployedTo: Literal["all", "some", "none"]
    allowedUsersAndGroups: list[Principal]
    acquireUsersAndGroups: list[Principal]


class AccessUpdate(WireModel):
    target: Literal["availability", "installation"]
    mode: Literal["add", "replace"]
    scope: Literal["specific", "none"]
    principals: list[Principal]


class ConfirmationActor(WireModel):
    id: str
    displayName: str
    username: str


class PackageConfirmationMetadata(WireModel):
    risk: TrueValue
    operation: AuditAction
    provider: Literal["Microsoft Graph"]
    endpoint: str
    apiMaturity: Literal["preview"]
    permission: Literal["Delegated CopilotPackages.ReadWrite.All"]
    actor: ConfirmationActor
    scope: Literal["single", "bulk"]
    targetCount: SafeInteger
    affectedPrincipalCount: SafeInteger
    rollback: str
    targetSelectionHash: str
    additionalTargetCount: SafeInteger


class PackageConfirmationTarget(WireModel):
    id: str
    displayName: str
    currentState: BlockState | AccessState
    requestedState: BlockState | AccessState


class PackageConfirmation(PackageConfirmationMetadata):
    targets: list[PackageConfirmationTarget]


class PackagePreview(WireModel):
    stageId: str
    selectionId: str
    confirmationHash: str
    summary: PackageConfirmation


class PackageJob(WireModel):
    id: str
    origin: Origin
    capabilityId: CapabilityId
    tokenMode: Literal["delegated", "application"]
    status: JobStatus
    isCanary: TrueValue | None = None
    cancelRequested: TrueValue | None = None
    confirmationHash: str | None
    confirmation: PackageConfirmationMetadata | None
    confirmedAt: str | None
    action: AuditAction
    targetBlockedState: bool | None = None
    accessUpdate: AccessUpdate | None = None
    reassignUserId: str | None = None
    total: SafeInteger
    completed: SafeInteger
    succeeded: SafeInteger
    failed: SafeInteger
    skipped: SafeInteger
    inconclusive: SafeInteger
    cancelled: SafeInteger
    queued: SafeInteger
    reconciliationRequired: SafeInteger
    retryEligible: SafeInteger
    resultRevision: str
    currentAgentName: str | None = None
    createdAt: str
    updatedAt: str
    canResume: bool


class PackageJobs(WireModel):
    value: list[PackageJob]


class PackageItem(WireModel):
    id: str
    displayName: str
    status: ItemStatus
    message: str | None = None
    errorCode: str | None = None
    correlationId: str | None = None
    prestateHash: str
    poststateHash: str | None = None
    reconciliationStatus: Reconciliation
    retryEligible: bool


class PackageItems(WireModel):
    value: list[PackageItem]
    revision: str
    counts: Counts
    page: Page


class PackageReconciliationError(WireModel):
    id: str
    message: str


class PackageReconciliation(WireModel):
    attempted: SafeInteger
    failed: SafeInteger
    errors: list[PackageReconciliationError]


class ReconciledPackageJob(PackageJob):
    reconciliation: PackageReconciliation


class StudioTarget(WireModel):
    resourceNativeId: str
    displayName: str
    environmentId: str
    botId: str


class DirectStatus(WireModel):
    isBotQuarantined: bool
    providerUpdatedAt: str
    observedAt: str
    correlationId: str
    source: Literal["cache", "provider", "direct"]


class InventoryStatus(WireModel):
    isQuarantined: bool | None
    quarantinedAt: str | None
    observedAt: str
    snapshotId: str


class StudioStatus(WireModel):
    target: StudioTarget
    direct: DirectStatus
    inventory: InventoryStatus
    disagreesWithInventory: bool


class StudioConfirmationTarget(StudioTarget):
    currentState: bool
    currentProviderUpdatedAt: str
    requestedState: bool
    inventoryState: bool | None
    inventoryObservedAt: str


class StudioConfirmation(WireModel):
    risk: TrueValue
    operation: StudioAction
    provider: Literal["Power Platform Copilot Studio"]
    endpoint: Literal["api-version=1 botQuarantine"]
    permission: Literal["Delegated CopilotStudio.AdminActions.Invoke"]
    targetCount: SafeInteger
    targetSelectionHash: str
    actor: ConfirmationActor
    packageControlIndependent: TrueValue
    makerBehavior: str
    providerAtomicity: FalseValue
    targets: list[StudioConfirmationTarget]
    additionalTargetCount: SafeInteger


class StudioPreview(WireModel):
    confirmationHash: str
    summary: StudioConfirmation
    statuses: list[StudioStatus]


class StudioItem(StudioTarget):
    status: ItemStatus
    requestedState: bool
    observedState: bool | None
    observedProviderUpdatedAt: str | None
    observedAt: str | None
    correlationId: str | None
    reconciliationStatus: Reconciliation
    retryEligible: bool
    errorCode: str | None = None
    message: str | None = None


class StudioJob(WireModel):
    origin: Origin | None = None
    id: str
    action: StudioAction
    status: StudioJobStatus
    confirmationHash: str
    confirmation: StudioConfirmation
    isCanary: bool
    total: SafeInteger
    completed: SafeInteger
    succeeded: SafeInteger
    failed: SafeInteger
    skipped: SafeInteger
    inconclusive: SafeInteger
    cancelled: SafeInteger
    canResume: bool
    canReconcile: bool
    createdAt: str
    updatedAt: str
    results: list[StudioItem]


class StudioJobs(WireModel):
    value: list[StudioJob]


class StudioReconciliationError(WireModel):
    resourceNativeId: str
    message: str


class StudioReconciliation(WireModel):
    attempted: SafeInteger
    failed: SafeInteger
    errors: list[StudioReconciliationError]


class ReconciledStudioJob(StudioJob):
    reconciliation: StudioReconciliation


class StudioAuditActor(WireModel):
    username: str
    displayName: str


class StudioAuditTarget(WireModel):
    resourceNativeId: str
    environmentId: str
    botId: str


class StudioAuditEvent(WireModel):
    id: str
    origin: Origin
    principalId: str
    actor: StudioAuditActor
    jobId: str
    itemId: str | None
    correlationId: str | None
    action: str
    phase: str
    target: StudioAuditTarget
    requestedState: bool
    observedState: bool | None
    observedProviderUpdatedAt: str | None
    errorCode: str | None
    message: str | None
    observedAt: str


class StudioAudit(WireModel):
    count: SafeInteger
    value: list[StudioAuditEvent]
