"""Saved report wire contracts. Calculations and identity joins stay in the API."""

from typing import Literal

from pydantic import Field

from .models import PublishedSelectedRead, SafeInteger, WireModel

ServiceState = Literal[
    "enabled", "warning", "partially_enabled", "disabled", "suspended", "locked_out", "unknown"
]
Entitlement = Literal["paid_active", "paid_inactive", "no_paid", "unknown"]
ReportKind = Literal["agents", "userAgents", "users"]


class Page(WireModel):
    limit: SafeInteger
    nextCursor: str | None
    previousCursor: str | None
    anchor: str | None = None
    number: SafeInteger | None = None
    offset: SafeInteger | None = None


class Counts(WireModel):
    total: SafeInteger
    filtered: SafeInteger


class SourceMetadata(WireModel):
    source: Literal["directory", "app_activity"]
    generationId: str | None
    scopeId: str | None
    revision: str | None
    expiresAt: str | None
    observedAt: str | None
    attemptedAt: str | None
    attemptStatus: (
        Literal[
            "running",
            "available",
            "failed",
            "cancelled",
            "waiting_authorization",
            "permission_required",
        ]
        | None
    )
    attemptObservedCount: SafeInteger | None
    errorCode: str | None
    message: str | None
    rowCount: SafeInteger | None
    state: Literal["available", "partial", "stale", "unavailable"]
    reportRefreshDate: str | None
    period: Literal["D28", "D30"] | None
    reportVersion: Literal["v1", "v2"] | None


class ReportingPeriod(WireModel):
    startDate: str | None
    endDate: str | None
    days: SafeInteger | None
    provenance: str


class Lineage(WireModel):
    kind: ReportKind
    versionId: str
    contentHash: str
    rowCount: SafeInteger
    sourceAsOf: str | None
    sourceAsOfProvenance: str
    sourceFreshness: Literal["known", "unknown"]
    periodProvenance: str


class ReportMetadata(WireModel):
    setId: str | None
    activeSetId: str | None
    activeRevision: str
    historyRevision: str
    historyEpoch: str
    availability: Literal[
        "never_imported", "incomplete", "not_selected", "deleted", "active", "stale"
    ]
    staleAfterDays: SafeInteger
    periodAgeDays: SafeInteger | None
    acceptedAgeDays: SafeInteger | None
    reportingPeriod: ReportingPeriod | None
    acceptedAt: str | None
    expiresAt: str | None
    lineages: list[Lineage]


class DirectoryIdentity(WireModel):
    objectId: str
    userPrincipalName: str
    displayName: str | None
    accountEnabled: bool | None
    userType: str | None
    employeeType: str | None
    companyName: str | None
    department: str | None


class ServicePlan(WireModel):
    servicePlanId: str
    service: str
    displayName: str
    state: Literal["enabled", "warning", "disabled", "suspended", "locked_out", "unknown"]
    assignedDateTime: str | None
    capabilityStatus: Literal["Enabled", "Warning", "Suspended", "Deleted", "LockedOut"] | None


class AppActivity(WireModel):
    reportRefreshDate: str
    lastActivityDate: str | None
    copilotChatLastActivityDate: str | None
    microsoftTeamsCopilotLastActivityDate: str | None
    wordCopilotLastActivityDate: str | None
    excelCopilotLastActivityDate: str | None
    powerpointCopilotLastActivityDate: str | None
    outlookCopilotLastActivityDate: str | None
    onenoteCopilotLastActivityDate: str | None
    loopCopilotLastActivityDate: str | None


class UserFacts(WireModel):
    directory: DirectoryIdentity
    copilotServiceState: ServiceState
    servicePlanCount: SafeInteger
    entitlement: Entitlement
    appActivity: AppActivity | None
    activityState: Literal["active", "inactive", "unknown"]


class CombinedUser(UserFacts):
    reportedUsername: str | None
    reportedResponses: SafeInteger | None
    reportedAgentsUsed: SafeInteger | None
    userLastActivityDateUtc: str | None
    bridgeResponses: SafeInteger | None
    relationshipCount: SafeInteger
    agentActivityState: Literal["active", "none", "unknown"]
    reportMatch: Literal["matched", "missing"]
    attention: list[str]


class ReportUser(WireModel):
    username: str
    displayName: str
    objectId: str | None
    company: str | None
    department: str | None
    entitlement: Entitlement | None
    reportedResponses: SafeInteger | None
    reportedAgentsUsed: SafeInteger | None
    bridgeResponses: SafeInteger | None
    relationshipCount: SafeInteger
    responseProducingAgentCount: SafeInteger
    userLastActivityDateUtc: str | None
    lastActivityDateUtc: str | None
    missingUserReport: bool
    hasReportMismatch: bool
    reviewCohort: Literal["unknown", "zero", "low", "outside"]
    hasActivity: bool


class ReportAgent(WireModel):
    agentId: str
    agentName: str
    creatorType: str
    responses: SafeInteger
    responseSource: Literal["agents", "userAgents"]
    activeUsers: SafeInteger | None
    activeUsersBasis: Literal["userAgents_distinct_identity", "unknown"]
    licensedUserOccurrences: SafeInteger | None
    unlicensedUserOccurrences: SafeInteger | None
    lastActivityDateUtc: str | None
    reportResponses: SafeInteger | None
    bridgeResponses: SafeInteger | None
    relationshipCount: SafeInteger
    responseComparison: Literal["matching", "mismatch", "not_comparable"]
    identityStatus: Literal["unresolved"]


class ReportRelationship(WireModel):
    id: str
    agentId: str
    agentName: str
    creatorType: str
    username: str
    responses: SafeInteger
    lastActivityDateUtc: str | None
    identityStatus: Literal["unresolved"]


class HistorySet(WireModel):
    id: str
    bundleId: str
    contentHash: str
    reportingStart: str | None
    reportingEnd: str | None
    periodProvenance: str
    supersedesSetId: str | None
    acceptedAt: str
    visibility: Literal["retained", "superseded"]
    active: bool


class OverviewAgent(WireModel):
    agentId: str
    agentName: str
    observationCount: SafeInteger
    hasResponses: bool
    earliestActivityDateUtc: str | None
    lastActivityDateUtc: str | None
    active30Days: bool
    creatorTypeCount: SafeInteger
    latestSetId: str
    latestAcceptedAt: str


class Observation(WireModel):
    versionId: str
    kind: ReportKind
    contentHash: str
    rowCount: SafeInteger
    acceptedAt: str
    sourceAsOf: str | None
    sourceAsOfProvenance: str
    sourceFreshness: str
    supersedesVersionId: str | None


class UnresolvedUser(WireModel):
    username: str
    reason: Literal["not_found", "ambiguous"]
    responses: SafeInteger | None
    hasActivity: bool


class ReportSources(WireModel):
    directory: SourceMetadata
    app_activity: SourceMetadata


class ReportSummary(WireModel):
    checkedUsers: SafeInteger | None
    licensedUsers: SafeInteger | None
    measuredActivityUsers: SafeInteger | None
    needsAttentionUsers: SafeInteger | None
    usingAgentsUsers: SafeInteger | None
    noAgentActivityUsers: SafeInteger | None
    unknownMetricsUsers: SafeInteger | None
    unresolvedIdentities: SafeInteger
    activeWithoutPaidUsers: SafeInteger | None
    paidActiveReportUsers: SafeInteger | None
    unknownLicenseActiveReportUsers: SafeInteger
    reportedResponses: SafeInteger | None
    bridgeResponses: SafeInteger | None
    userReportedResponses: SafeInteger | None
    distinctActiveReportUsers: SafeInteger | None
    licensedOccurrences: SafeInteger | None
    unlicensedOccurrences: SafeInteger | None
    responseReconciliation: Literal["matching", "mismatch", "not_comparable"]
    activeUsersAreNonAdditive: Literal[True]


class Review(WireModel):
    zero: SafeInteger
    low: SafeInteger
    unknown: SafeInteger


class RankedAgent(WireModel):
    agentId: str
    name: str
    responses: SafeInteger


class AgentAnalytics(WireModel):
    inactive: SafeInteger
    neverUsed: SafeInteger
    anchorDateUtc: str | None
    windowDays: SafeInteger
    windowAgents: SafeInteger
    windowResponses: SafeInteger | None
    windowDistinctActiveUsers: SafeInteger
    mostResponses: list[RankedAgent]
    leastResponses: list[RankedAgent]


class HistoryAnalytics(WireModel):
    imports: SafeInteger
    uniqueObservations: SafeInteger
    observationRows: SafeInteger
    uniquePayloads: SafeInteger
    repeatedRowsReused: SafeInteger
    earliestAcceptedAt: str | None
    latestAcceptedAt: str | None
    earliestActivityDateUtc: str | None
    latestActivityDateUtc: str | None
    earliestReportingStart: str | None
    latestReportingEnd: str | None
    knownWindows: SafeInteger
    unknownWindows: SafeInteger
    overlappingKnownWindows: SafeInteger
    additive: Literal[False]
    activityRangeProvesCoverage: Literal[False]


class OverviewAnalytics(WireModel):
    retainedSets: SafeInteger
    reportedAgents: SafeInteger
    usedAgents: SafeInteger
    active30Days: SafeInteger
    undatedAgents: SafeInteger
    earliestActivityDateUtc: str | None
    latestActivityDateUtc: str | None
    asOf: str
    activeSinceDateUtc: str


class Analytics(WireModel):
    basis: Literal["filtered_rows"]
    rowCount: SafeInteger
    responses: SafeInteger | None
    zeroResponses: SafeInteger | None
    unknownResponses: SafeInteger | None
    review: Review | None
    agents: AgentAnalytics | None
    history: HistoryAnalytics | None
    overview: OverviewAnalytics | None


class ReportList[T](WireModel):
    value: list[T]
    page: Page
    counts: Counts
    selection: PublishedSelectedRead
    reports: ReportMetadata


class ReportFilters(WireModel):
    setId: str | None = None
    scope: Literal["history", "selected"] | None = None
    search: str | None = None
    company: str | None = None
    department: str | None = None
    entitlement: Entitlement | None = None
    serviceState: ServiceState | None = None
    appActivity: Literal["active", "inactive", "unknown"] | None = None
    reportActivity: Literal["all", "recent", "inactive", "no-activity"] | None = None
    cohort: (
        Literal[
            "all",
            "zero",
            "low",
            "review",
            "licensed",
            "using_agents",
            "no_agent_activity",
            "needs_attention",
            "unknown_metrics",
        ]
        | None
    ) = None
    licenseCohort: Literal["active_without_paid"] | None = None
    creatorType: str | None = None
    agentId: str | None = None
    username: str | None = None
    responsesOnly: bool | None = None
    startDate: str | None = None
    endDate: str | None = None
    lowResponseThreshold: SafeInteger | None = None
    inactiveDays: SafeInteger | None = None
    activityWindowDays: SafeInteger | None = None
    adoptionChamps: Literal["with", "without"] | None = None
    adoptionAgents: Literal["with", "without"] | None = None
    sort: (
        Literal[
            "name",
            "upn",
            "company",
            "department",
            "service",
            "appActivity",
            "responses",
            "agentsUsed",
            "lastActivity",
            "activeUsers",
            "licensedUsers",
            "unlicensedUsers",
            "creatorType",
            "reportingPeriod",
            "acceptedAt",
        ]
        | None
    ) = None
    order: Literal["asc", "desc"] | None = None


class ReportPage[T](ReportList[T]):
    sources: ReportSources
    summary: ReportSummary
    analytics: Analytics
    filters: ReportFilters


class ReportDetail[T](WireModel):
    value: T
    selection: PublishedSelectedRead
    reports: ReportMetadata
    sources: ReportSources


class Facet(WireModel):
    value: str | None
    count: SafeInteger


class ReportFacets(WireModel):
    value: list[Facet]
    selection: PublishedSelectedRead
    counts: Counts
    page: Page


class UserResolution(WireModel):
    username: str
    state: Literal[
        "resolved", "ambiguous", "concealed_or_unresolved", "unresolved", "directory_missing"
    ]
    objectId: str | None
    directoryMatches: SafeInteger
    reportedUsername: str | None
    reportIdentityState: Literal["matched", "ambiguous", "unresolved", "missing"]
    concealment: Literal["unknown"]
    selection: PublishedSelectedRead
    directory: SourceMetadata
    reports: ReportMetadata


class RelationshipReference(WireModel):
    selectionId: str
    path: str


class SavedRelationship(WireModel):
    id: str
    canonicalId: str | None
    reportAgentId: str | None
    name: str
    relationship: Literal["used", "created", "owned", "modified"]
    personId: str
    reportedUsername: str | None
    responses: SafeInteger | None
    lastActivityDateUtc: str | None
    source: Literal["inventory", "userAgents"]
    identityState: Literal["canonical", "report_only", "ambiguous"]
    sourceReferences: RelationshipReference | None


class RelationshipCounts(WireModel):
    total: SafeInteger | None
    distinctAgents: SafeInteger | None
    returned: SafeInteger


class RelationshipPaging(WireModel):
    limit: SafeInteger
    nextCursor: str | None


class SavedRelationships(WireModel):
    value: list[SavedRelationship]
    counts: RelationshipCounts
    page: RelationshipPaging
    selection: PublishedSelectedRead
    inventorySelection: PublishedSelectedRead
    directory: SourceMetadata
    reports: ReportMetadata
    relationshipState: Literal["available", "unavailable"]
    missingReasons: list[str]


class Champion(WireModel):
    objectId: str
    name: str | None
    rank: SafeInteger
    created: SafeInteger
    responses: SafeInteger | None
    agents: SafeInteger | None


class ChampionAgents(SavedRelationships):
    company: str | None
    department: str | None
    champions: list[Champion]


class AdoptionPerson(WireModel):
    id: str
    name: str
    agents: SafeInteger | None
    responses: SafeInteger | None
    champion: bool


class AdoptionAgent(WireModel):
    id: str
    name: str
    description: str | None
    creatorType: str | None
    inventoryId: str | None


class AdoptionGroup(WireModel):
    id: str
    company: str
    department: str
    people: list[AdoptionPerson]
    agents: list[AdoptionAgent]


class AdoptionSummary(WireModel):
    people: SafeInteger
    champs: SafeInteger
    agents: SafeInteger | None


class AdoptionPaging(Page):
    number: SafeInteger
    offset: SafeInteger


class AdoptionPage(ReportList[AdoptionGroup]):
    page: AdoptionPaging
    directory: SourceMetadata
    summary: AdoptionSummary


class UsageContext(WireModel):
    selectionId: str
    reportSetId: str | None
    usageRevision: str
    inventoryRevision: str
    reports: ReportMetadata


class UsageSummary(WireModel):
    recordId: str
    status: Literal["unavailable", "unlinked", "linked"]
    responses: SafeInteger | None
    activeUsers: SafeInteger | None
    lastActivityDateUtc: str | None
    associationCount: SafeInteger
    context: UsageContext


class UsagePoint(WireModel):
    setId: str
    reportingStart: str | None
    reportingEnd: str | None
    periodProvenance: str
    acceptedAt: str
    status: Literal["linked", "unlinked"]
    responses: SafeInteger | None
    lastActivityDateUtc: str | None
    associationCount: SafeInteger


class ComparisonWindow(WireModel):
    start: str | None
    end: str | None
    provenance: str


class Coverage(WireModel):
    expectedAssociations: SafeInteger
    matchedAssociations: SafeInteger
    ambiguousReportRows: bool


class ComparisonMetrics(WireModel):
    responses: SafeInteger | None
    associationCount: SafeInteger
    source: Literal["agents"]
    cohortHash: str | None
    cohortKind: Literal["report_agent_associations"]
    coverage: Coverage


class ComparisonSide(WireModel):
    setId: str
    window: ComparisonWindow
    metrics: ComparisonMetrics


class Comparison(WireModel):
    state: Literal["comparable", "incomparable", "unknown"]
    reasons: list[str]
    from_: ComparisonSide = Field(alias="from")
    to: ComparisonSide
    responsesDelta: int | None
    responseGrowthPercent: float | None


class UsageHistory(WireModel):
    recordId: str
    context: UsageContext
    value: list[UsagePoint]
    latestReportSetId: str | None
    latestReported: UsagePoint | None
    counts: Counts
    page: Page
    comparison: Comparison | None = None


class UsageUser(WireModel):
    username: str
    displayName: str
    responses: SafeInteger


class UsageUsers(ReportList[UsageUser]):
    context: UsageContext


class GraphUsageTarget(WireModel):
    source: Literal["graph_packages"]
    packageId: str
    snapshotId: str


class PowerPlatformUsageTarget(WireModel):
    source: Literal["power_platform"]
    nativeId: str
    environmentId: str | None
    snapshotId: str


class UsageAssociation(WireModel):
    reportAgentId: str
    agentName: str
    responses: SafeInteger
    basis: Literal["reviewed", "exact_package_id"]
    target: GraphUsageTarget | PowerPlatformUsageTarget = Field(discriminator="source")


class UsageAssociations(WireModel):
    value: list[UsageAssociation]
    context: UsageContext
    page: Page
    counts: Counts


class UsageCandidate(ReportAgent):
    associated: bool


class UsageCandidates(WireModel):
    value: list[UsageCandidate]
    context: UsageContext
    selection: PublishedSelectedRead
    page: Page
    counts: Counts
