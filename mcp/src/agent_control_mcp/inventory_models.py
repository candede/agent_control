"""Exact saved inventory projections, including source-specific configuration."""

import re
from datetime import datetime
from typing import Literal

from pydantic import Field, field_validator

from .models import PublishedSelectedRead, SafeInteger, WireModel
from .report_models import Counts, Page, ReportMetadata

ResourceType = Literal["microsoft.copilotstudio/agents", "microsoft.powerplatform/environments"]
Presence = Literal["graph_packages", "power_platform", "both"]
Role = Literal["owner", "createdBy", "lastModifiedBy"]


class SavedSource(WireModel):
    scopeId: str
    identity: str


class FieldProvenance(WireModel):
    sourceSystem: Literal["graph_packages", "power_platform"]
    path: str
    maturity: Literal["ga", "preview", "observed"]


class Observation(WireModel):
    id: str
    snapshotId: str
    observedAt: str
    expiresAt: str
    current: bool


class PackageObservation(Observation):
    scopeKind: Literal["broad", "exact"]
    observedCount: SafeInteger
    totalRecords: SafeInteger


class IdentityObservation(Observation):
    scopeKind: Literal["broad", "exact"]
    identityDetails: Observation | None


class SnapshotVerification(WireModel):
    status: Literal["verified"]
    scope: Literal["authorized_query"]
    basis: Literal["provider_total_and_saved_rows"]
    checkedAt: str
    storedCount: SafeInteger
    uniqueIdentityCount: SafeInteger
    queriedTypes: list[ResourceType]


class NativeObservation(Observation):
    roleScope: Literal["full", "ai", "unknown"]
    environmentScope: str | None
    coverage: Literal["covered", "not_requested", "not_authorized_scope", "unknown"]
    coveredCount: SafeInteger | None
    observedCount: SafeInteger
    totalRecords: SafeInteger
    pageCount: SafeInteger
    verification: SnapshotVerification | None


class SourceError(WireModel):
    source: Literal["graph_packages", "power_platform"]
    code: Literal[
        "snapshot_unavailable",
        "snapshot_stale",
        "source_result_limit",
        "coverage_unknown",
        "environment_scope_limited",
        "not_authorized_scope",
    ]
    message: str


class SourceStatus(WireModel):
    state: Literal["available", "partial", "unavailable"]
    observation: PackageObservation | NativeObservation | None
    error: SourceError | None


class SourceStatuses(WireModel):
    graphPackages: SourceStatus
    powerPlatform: SourceStatus


class Person(WireModel):
    objectId: str
    displayName: str | None
    userPrincipalName: str | None
    observedAt: str
    status: Literal["resolved", "not_found", "lookup_failed"] | None = None
    checkedAt: str | None = None
    expiresAt: str | None = None
    errorCode: str | None = None


class People(WireModel):
    owner: Person | None = None
    createdBy: Person | None = None
    lastModifiedBy: Person | None = None


class ResolvedPeople(WireModel):
    people: People
    changed: bool


class SavedEnvironment(WireModel):
    id: str
    displayName: str | None
    region: str | None
    environmentType: str | None
    isManaged: bool | None
    groupName: str | None
    groupId: str | None
    observation: Observation
    provenance: dict[str, FieldProvenance]


class ProviderUsage(WireModel):
    activeUsers: SafeInteger | None = None
    totalSessions: SafeInteger | None = None
    totalRunTimeInHours: float | None = Field(
        default=None, ge=0, le=9007199254740991, allow_inf_nan=False
    )
    exceptionRate: float | None = Field(
        default=None, ge=0, le=9007199254740991, allow_inf_nan=False
    )
    lastUsedDateTime: str | None = None

    @field_validator("lastUsedDateTime")
    @classmethod
    def valid_usage_timestamp(cls, value: str | None) -> str | None:
        if value is None:
            return value
        if not re.fullmatch(
            r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}"
            r"(?:\.[0-9]{1,9})?(?:Z|[+-](?:0[0-9]|1[0-3]):[0-5][0-9]|[+-]14:00)",
            value,
        ):
            raise ValueError("Use a valid timezone-qualified inventory timestamp.")
        datetime.fromisoformat(value)
        return value


class Principal(WireModel):
    resourceId: str
    resourceType: str


class Element(WireModel):
    id: str
    definition: str


class ElementGroup(WireModel):
    elementType: str
    elements: list[Element]


class ControlObservation(WireModel):
    snapshotId: str
    observedAt: str
    expiresAt: str


class ControlObservations(WireModel):
    block: ControlObservation | None = None
    access: ControlObservation | None = None


class DetailFreshness(WireModel):
    state: Literal["fresh", "stale", "missing", "invalidated"]
    observedAt: str | None
    expiresAt: str | None


class PrincipalCounts(WireModel):
    allowedUsersAndGroups: SafeInteger | None = None
    acquireUsersAndGroups: SafeInteger | None = None
    sharedWithUsersAndGroups: SafeInteger | None = None


class LinkEvidence(WireModel):
    kind: Literal[
        "entra_agent_id",
        "environment_entra_app_id",
        "environment_cds_bot_id",
        "environment_schema_native_id",
        "manifest_schema_native_id",
        "shared_custom_engine_bot_id",
    ]
    basis: Literal["source_declared_metadata"]
    elementIds: list[str]
    packagePath: str
    resourcePath: str
    relatedPackageIds: list[str] | None = None


class SelectedSource(WireModel):
    selectionId: str
    recordId: str
    sourceScopeId: str
    sourceIdentity: str
    generationId: str


class DetailObservation(WireModel):
    id: str
    observedAt: str
    expiresAt: str
    current: bool
    scopeKind: Literal["exact"]
    source: Literal["Microsoft Graph package catalog"]
    apiMaturity: Literal["v1.0 read; preview controls"]


class Package(WireModel):
    savedSource: SavedSource | None = None
    identityRevalidationRequired: Literal[True] | None = None
    id: str
    displayName: str
    type: str | None = None
    shortDescription: str | None = None
    isBlocked: bool
    supportedHosts: list[str] | None = None
    createdDateTime: str | None = None
    lastModifiedDateTime: str | None = None
    publisher: str | None = None
    availableTo: str | None = None
    deployedTo: str | None = None
    elementTypes: list[str] | None = None
    platform: str | None = None
    version: str | None = None
    manifestVersion: str | None = None
    manifestId: str | None = None
    appId: str | None = None
    assetId: str | None = None
    ownerId: str | None = None
    agentIdentityId: str | None = None
    providerUsage: ProviderUsage | None = None
    sourceSystem: Literal["graph_packages"]
    authoringTool: str | None
    creatorType: Literal["unknown"]
    agentKind: Literal["copilot_package"]
    lifecycle: Literal["unknown"]
    identityConfidence: Literal["exact_native"]
    provenance: dict[str, FieldProvenance]
    controlObservations: ControlObservations | None = None
    detailFreshness: DetailFreshness | None = None
    principalCounts: PrincipalCounts | None = None
    identityDetailsCollected: Literal[True] | None = None
    longDescription: str | None = None
    categories: list[str] | None = None
    sensitivity: str | None = None
    allowedUsersAndGroups: list[Principal] | None = None
    acquireUsersAndGroups: list[Principal] | None = None
    sharedWithUsersAndGroups: list[Principal] | None = None
    elementDetails: list[ElementGroup] | None = None


class PackageDetail(Package):
    matchingEvidence: list[LinkEvidence]
    accessReadError: str | None = None
    observation: DetailObservation
    selectedSource: SelectedSource


class ConnectorOperation(WireModel):
    operationId: str
    createdBy: str | None = None
    usedAs: str | None = None
    isEnabled: bool | None = None
    requiresEndUserConsent: bool | None = None
    whenCanBeUsed: str | None = None
    connectionProvider: str | None = None


class Connector(WireModel):
    connectorId: str
    operations: list[ConnectorOperation] | None = None


class Recipients(WireModel):
    userCount: SafeInteger | None = None
    groupCount: SafeInteger | None = None


class Viewers(Recipients):
    entireTenant: bool | None = None


class MakerSharing(WireModel):
    viewers: Viewers | None = None
    editors: Recipients | None = None


class ComponentCounts(WireModel):
    connectedAgents: SafeInteger | None = None
    knowledge: SafeInteger | None = None
    topics: SafeInteger | None = None
    tools: SafeInteger | None = None
    knowledgeByType: dict[str, SafeInteger | None] | None = None


class NativeDetails(WireModel):
    description: str | None = None
    ownerId: str | None = None
    lastModifiedAt: str | None = None
    lastModifiedBy: str | None = None
    isQuarantined: bool | None = None
    quarantinedAt: str | None = None
    isManaged: bool | None = None
    schemaName: str | None = None
    createdIn: str | None = None
    environmentType: str | None = None
    environmentGroup: str | None = None
    environmentGroupId: str | None = None
    orchestration: str | None = None
    model: str | None = None
    authentication: str | None = None
    channels: list[str] | None = None
    connectors: list[Connector] | None = None
    distinctPowerPlatformConnectors: SafeInteger | None = None
    distinctPowerPlatformConnectorsOperations: SafeInteger | None = None
    isWebSearchEnabledForKnowledge: bool | None = None
    makerSharing: MakerSharing | None = None
    harness: str | None = None
    titleId: str | None = None
    instructionsCharactersCount: SafeInteger | None = None
    componentsCounts: ComponentCounts | None = None
    distinctFlows: SafeInteger | None = None
    flowReferenceCount: SafeInteger | None = None
    triggerCount: SafeInteger | None = None
    capabilityDetailsTruncated: bool | None = None
    connectorDetailsStatus: Literal["not_supplied", "complete", "partial"] | None = None


class Identifier(WireModel):
    kind: Literal[
        "power_platform_resource_id",
        "cds_bot_id",
        "entra_app_id",
        "entra_agent_id",
        "entra_blueprint_id",
        "environment_id",
        "package_id",
        "package_app_id",
        "manifest_id",
        "asset_id",
    ]
    value: str


class ConnectorCounts(WireModel):
    connectors: SafeInteger
    operations: SafeInteger


class QuarantineIdentity(WireModel):
    environmentId: str
    botId: str
    provenance: FieldProvenance | None = None


class NativeResource(WireModel):
    tenantId: str
    nativeId: str
    providerResourceId: str | None = None
    type: ResourceType
    location: str | None
    displayName: str | None
    environmentId: str | None
    createdAt: str | None
    createdBy: str | None
    lastPublishedAt: str | None
    sourceSystem: Literal["power_platform"]
    authoringTool: str | None
    creatorType: Literal["unknown"]
    agentKind: str
    lifecycle: Literal["draft", "published", "unknown", "not_applicable"]
    identityConfidence: Literal["exact_native", "partial"]
    identifiers: list[Identifier]
    identifierCount: SafeInteger | None = None
    identifiersComplete: bool | None = None
    connectorCounts: ConnectorCounts | None = None
    savedSource: SavedSource | None = None
    quarantineIdentity: QuarantineIdentity | None = None
    provenance: dict[str, FieldProvenance]
    details: NativeDetails
    unknownFieldCount: SafeInteger


class PackageEvidence(WireModel):
    packageId: str
    evidence: list[LinkEvidence]


class IdentityWarning(WireModel):
    code: Literal["source_specific_agent_identity"]
    message: str


class Identity(WireModel):
    state: Literal["matched", "unmatched", "ambiguous", "conflicting"]
    evidence: list[LinkEvidence]
    packageEvidence: list[PackageEvidence]
    reason: str | None
    warnings: list[IdentityWarning] | None = None
    invalidMetadata: Literal[True] | None = None


class RecordObservations(WireModel):
    graphPackages: PackageObservation | None
    packageSnapshots: dict[str, IdentityObservation]
    powerPlatform: NativeObservation | None


class InventoryUsage(WireModel):
    recordId: str
    status: Literal["unavailable", "unlinked", "linked"]
    responses: SafeInteger | None
    activeUsers: SafeInteger | None
    lastActivityDateUtc: str | None
    associationCount: SafeInteger
    reportSetId: str | None


class Agent(WireModel):
    columns: dict[str, str | int | float | None] | None = None
    memberCount: SafeInteger | None = None
    packageCount: SafeInteger | None = None
    packagesComplete: bool | None = None
    id: str
    displayName: str
    presence: Presence
    environmentId: str | None
    environment: SavedEnvironment | None = None
    packages: list[Package]
    powerPlatformResource: NativeResource | None
    people: People | None = None
    usage: InventoryUsage | None = None
    identity: Identity
    observations: RecordObservations


class Summary(WireModel):
    total: SafeInteger
    linked: SafeInteger
    graphOnly: SafeInteger
    powerPlatformOnly: SafeInteger
    ambiguous: SafeInteger
    conflicting: SafeInteger


class VerificationChecks(WireModel):
    sourceScopes: bool
    packageMetadata: bool
    identityLinks: bool
    sourceMemberships: bool


class Verification(WireModel):
    status: Literal["verified", "details_pending", "updating", "needs_attention"]
    scope: Literal["authorized_saved_sources"]
    checkedAt: str
    graphPackageCount: SafeInteger
    powerPlatformAgentCount: SafeInteger
    representedSourceCount: SafeInteger
    uniqueSourceCount: SafeInteger
    logicalAgentCount: SafeInteger
    checks: VerificationChecks


class FreshnessSource(WireModel):
    scope_id: str
    source: Literal["inventory_packages", "inventory_power_platform"]
    selector: str
    row_count: int | str
    collected_count: int | str
    generation_id: str
    observed_at: str
    expires_at: str
    channel: str
    environment_id: str | None
    resource_types: list[str]
    baseline_id: str
    role_scope: str | None
    agent_count: SafeInteger
    expected_count: int | str | None
    page_count: int | str
    unknown_field_count: int | str
    wire_count: int | str
    complete: bool
    catalog_scope_complete: bool
    catalog_complete: bool
    catalog_observed_at: str | None
    catalog_expires_at: str | None
    captured_revision: str
    current: bool


class Freshness(WireModel):
    state: str
    capturedRevision: str
    sources: list[FreshnessSource]


class PendingDetails(WireModel):
    missing: SafeInteger
    stale: SafeInteger
    invalidated: SafeInteger


class IdentityCollection(WireModel):
    checkedPackages: SafeInteger
    pendingPackages: SafeInteger
    pendingDetails: PendingDetails | None = None
    invalidPackages: SafeInteger | None = None


class Health(WireModel):
    freshness: Freshness
    summary: Summary
    verification: Verification
    identityCollection: IdentityCollection | None = None
    sources: SourceStatuses
    partial: bool
    errors: list[SourceError]


class Unavailable(WireModel):
    state: Literal["not_collected", "preparing", "unavailable"]
    message: str


class InventoryCounts(WireModel):
    total: SafeInteger
    scoped: SafeInteger
    filtered: SafeInteger
    packageTargets: SafeInteger


class Overview(WireModel):
    availableToUsers: SafeInteger
    organizationCreated: SafeInteger
    teamsAvailable: SafeInteger
    createdOrAvailable: SafeInteger


class InventoryReportContext(WireModel):
    reports: ReportMetadata
    revision: str
    expiresAt: str | None


class InventoryPage(Health):
    selection: PublishedSelectedRead
    page: Page
    counts: InventoryCounts
    usageContext: InventoryReportContext
    inventoryOverview: Overview
    value: list[Agent]
    inventoryScope: Literal["catalog", "power_platform_only", "all"]
    scopeSummary: Summary
    filteredSummary: Summary


class VerificationCounts(WireModel):
    packages: SafeInteger
    native_agents: SafeInteger
    represented: SafeInteger
    unique_sources: SafeInteger
    checked_packages: SafeInteger
    stale_packages: SafeInteger
    invalidated_packages: SafeInteger
    invalid_packages: SafeInteger


class SelectedSummary(WireModel):
    counts: InventoryCounts
    summary: Summary
    scopeSummary: Summary
    filteredSummary: Summary
    inventoryOverview: Overview
    verificationCounts: VerificationCounts
    freshness: Freshness
    partial: bool
    reports: ReportMetadata


class InventoryFacet(WireModel):
    value: str | None
    label: str


class InventoryFacets(WireModel):
    value: list[InventoryFacet]
    total: SafeInteger
    nextCursor: str | None


class Member(WireModel):
    source_scope_id: str
    source_identity: str
    source_generation_id: str
    domain: Literal["packages", "power_platform"]
    native_id: str
    environment_id: str | None
    display_name: str | None
    observed_at: str
    read_started_at: str
    expires_at: str
    catalog_generation: str | None
    detail_generation: str | None
    control_generation: str | None


class Members(WireModel):
    value: list[Member]
    total: SafeInteger
    nextCursor: str | None


class Section(WireModel):
    kind: str
    total: SafeInteger


class Sections(WireModel):
    value: list[Section]
    nextCursor: str | None


class EmptyFact(WireModel):
    pass


class ValueFact(WireModel):
    value: str | int | float | bool | None


class ElementFact(Element):
    elementType: str


class Child(WireModel):
    ordinal: SafeInteger
    kind: str
    value: str
    payload: (
        Principal
        | Identifier
        | Connector
        | ConnectorOperation
        | ElementFact
        | LinkEvidence
        | EmptyFact
        | ValueFact
        | str
        | int
        | float
        | bool
        | None
    )


class Children(WireModel):
    value: list[Child]
    total: SafeInteger
    nextCursor: str | None


class ResponsibilityPerson(WireModel):
    objectId: str
    evidence: Person | None
    agentCount: SafeInteger
    roles: list[Role]


class ResponsibilityAgent(WireModel):
    id: str
    displayName: str
    presence: Presence
    environmentId: str | None
    roles: list[Role]
    observedAt: str


class SelectedPerson(WireModel):
    person: ResponsibilityPerson
    state: Literal["reported", "no_reported_relationships", "unavailable"]
    agents: list[ResponsibilityAgent]
    count: SafeInteger


class Responsibility(WireModel):
    selection: PublishedSelectedRead
    counts: Counts
    page: Page
    sources: SourceStatuses
    invalidReferenceCount: SafeInteger
    people: list[ResponsibilityPerson]
    selected: SelectedPerson | None


class PackageRow(Package):
    columns: dict[str, str | int | float | None]
    sourceIdentity: str


class PackagePage(WireModel):
    value: list[PackageRow]
    selection: PublishedSelectedRead
    page: Page
    counts: InventoryCounts
    freshness: Freshness
