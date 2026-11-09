"""Frozen Office and backend-owned department evidence; no transport calculations."""

from typing import Literal

from .models import PublishedSelectedRead, SafeInteger, WireModel
from .report_models import Counts, Entitlement, Page, ReportMetadata, ServiceState, SourceMetadata

OfficeApp = Literal["word", "excel", "powerpoint", "outlook", "onenote", "loop", "teams"]
UnknownReason = Literal[
    "missing_row",
    "ambiguous_identity",
    "retained_row",
    "retained_directory",
    "wrong_window",
    "no_app_dates",
    "invalid_app_date",
    "future_app_date",
]
Cohort = Literal["positive", "no_reported", "unknown"]


class Dates(WireModel):
    word: str | None
    excel: str | None
    powerpoint: str | None
    outlook: str | None
    onenote: str | None
    loop: str | None
    teams: str | None


class AppCounts(WireModel):
    word: SafeInteger
    excel: SafeInteger
    powerpoint: SafeInteger
    outlook: SafeInteger
    onenote: SafeInteger
    loop: SafeInteger
    teams: SafeInteger


class Metrics(WireModel):
    savedLicensedPeople: SafeInteger
    reportedActiveUsers: SafeInteger
    activeUserAppPairs: SafeInteger
    appsUsed: SafeInteger
    noRecentEvidencePeople: SafeInteger
    unknownEvidencePeople: SafeInteger
    perApp: AppCounts


class ReasonCounts(WireModel):
    missing_row: SafeInteger
    ambiguous_identity: SafeInteger
    retained_row: SafeInteger
    retained_directory: SafeInteger
    wrong_window: SafeInteger
    no_app_dates: SafeInteger
    invalid_app_date: SafeInteger
    future_app_date: SafeInteger


class Coverage(WireModel):
    directoryPeople: SafeInteger
    paidInactivePeople: SafeInteger
    noPaidPeople: SafeInteger
    unknownLicensePeople: SafeInteger
    reportedRows: SafeInteger
    retainedRows: SafeInteger
    unknownReasons: ReasonCounts
    state: Literal["complete", "partial"]


class Observation(WireModel):
    id: str
    reportRefreshDate: str
    period: Literal["D28"]
    reportVersion: Literal["v2"]
    windowStart: str
    kind: Literal["current", "weekly"]
    capturedAt: str
    expiresAt: str
    contentHash: str
    directoryGenerationId: str
    appGenerationId: str
    directoryObservedAt: str
    appObservedAt: str
    coverage: Coverage


class Query(WireModel):
    officeSnapshot: str | None = None
    officeBaseline: str | None = None
    company: str | None = None
    department: str | None = None
    search: str | None = None
    app: OfficeApp | None = None


class Status(WireModel):
    state: Literal["available", "preparing", "waiting_sources", "unavailable", "failed"]
    errorCode: str | None
    message: str | None


class OfficeContext(WireModel):
    observation: Observation | None
    baseline: Observation | None
    status: Status
    selection: PublishedSelectedRead
    query: Query


class OfficeSummary(WireModel):
    organization: Metrics | None
    matching: Metrics | None
    matchingGroups: SafeInteger
    filteredPeople: SafeInteger
    suggestedChampions: SafeInteger | None
    filteredSuggestedChampions: SafeInteger | None
    baseline: Metrics | None
    context: OfficeContext


class Person(WireModel):
    identity: str
    userPrincipalName: str
    displayName: str | None
    company: str | None
    department: str | None
    groupId: str
    entitlement: Entitlement
    serviceState: ServiceState
    directoryObservedAt: str
    appObservedAt: str | None
    appReportRefreshDate: str | None
    dates: Dates
    recentApps: list[OfficeApp]
    latestRecentDate: str | None
    unknownReasons: list[UnknownReason]


class Group(WireModel):
    id: str
    company: str | None
    department: str | None
    metrics: Metrics
    participation: float | None
    filteredPeople: SafeInteger
    champions: list[Person]


class Paging(Page):
    number: SafeInteger
    pages: SafeInteger
    offset: SafeInteger
    anchor: str | None


class OfficePage[T](WireModel):
    value: list[T]
    page: Paging
    counts: Counts
    context: OfficeContext


class HistoryPoint(WireModel):
    observation: Observation
    metrics: Metrics


class Facet(WireModel):
    value: str | None
    groups: SafeInteger
    people: SafeInteger


class ReportContext(WireModel):
    selection: PublishedSelectedRead
    query: dict[str, str | int | bool | None]
    reports: ReportMetadata
    directory: SourceMetadata


class OpportunityContext(WireModel):
    office: OfficeContext
    report: ReportContext
    inventory: PublishedSelectedRead | None
    inventoryState: Literal["available", "unavailable"]


class Denominators(WireModel):
    officePaid: SafeInteger
    officeActive: SafeInteger
    currentDirectory: SafeInteger | None
    currentAgentPaid: SafeInteger | None


class AgentEvidence(WireModel):
    positive: SafeInteger | None
    noReported: SafeInteger | None
    unknown: SafeInteger | None


class EvidenceCoverage(WireModel):
    state: Literal["complete", "partial", "unavailable"]
    reasons: list[str]
    unresolvedReportIdentities: SafeInteger
    ambiguousOfficePeople: SafeInteger


class ReadLink(WireModel):
    path: str
    query: dict[str, str | int | bool | None]


class PeerLink(ReadLink):
    requiresExactGroupCapture: bool


class Drilldowns(WireModel):
    audience: ReadLink
    officePeople: ReadLink
    peers: PeerLink
    agents: ReadLink


class DepartmentOpportunity(WireModel):
    id: str
    rank: SafeInteger
    company: str | None
    department: str | None
    office: Metrics
    denominators: Denominators
    agentEvidence: AgentEvidence
    coverage: EvidenceCoverage
    drilldowns: Drilldowns


class OpportunitySummary(AgentEvidence):
    officeActive: SafeInteger | None


class OpportunityPaging(WireModel):
    limit: SafeInteger
    nextCursor: str | None


class Definitions(WireModel):
    officePaid: str
    officeActive: str
    currentDirectory: str
    currentAgentPaid: str
    positive: str
    noReported: str
    unknown: str


class OpportunityPage(WireModel):
    value: list[DepartmentOpportunity]
    counts: Counts
    summary: OpportunitySummary
    page: OpportunityPaging
    context: OpportunityContext
    definitions: Definitions


class EvidencePerson(WireModel):
    person: Person
    agentEvidence: Cohort
    reportedUsername: str | None


class OpportunityPeoplePage(WireModel):
    value: list[EvidencePerson]
    counts: dict[Literal["total", "returned"], SafeInteger]
    page: OpportunityPaging
    context: OpportunityContext
