"""Finite tool inputs. API defaults are preserved by omitting unsupplied fields."""

import re
from datetime import UTC, date, datetime
from typing import Annotated, Literal, Self
from urllib.parse import unquote
from uuid import UUID

from pydantic import AfterValidator, Field, StringConstraints, model_validator

from .inventory_models import ResourceType
from .job_models import AuditAction, AuditStatus, PresetId, TemplateId
from .models import CapabilityId, Opaque, WireModel
from .report_models import Entitlement, ServiceState


def exact_id(value: str) -> str:
    if (
        value in {".", ".."}
        or not value.strip()
        or any(
            ord(char) < 32 or 127 <= ord(char) <= 159 or 0xD800 <= ord(char) <= 0xDFFF
            for char in value
        )
    ):
        raise ValueError("Use an exact bounded identity without controls or dot segments.")
    return value


ExactId = Annotated[str, StringConstraints(min_length=1, max_length=512), AfterValidator(exact_id)]
Guid = Annotated[
    str,
    StringConstraints(pattern=r"^[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}$"),
    AfterValidator(str.lower),
]


def record_id(value: str) -> str:
    exact_id(value)
    if value.startswith("agent:"):
        identity = value[6:]
        canonical = str(UUID(identity))
        if identity.lower() != canonical:
            raise ValueError("Use the exact canonical agent UUID.")
        return "agent:" + canonical
    parts = (
        [value.removeprefix("graph_packages:")]
        if value.startswith("graph_packages:")
        else value.removeprefix("power_platform:").split(":")
    )
    if len(parts) != (1 if value.startswith("graph_packages:") else 2):
        raise ValueError("Use the exact source-qualified environment/native identity.")
    for index, part in enumerate(parts):
        if not part and index == 0 and len(parts) == 2:
            continue
        if re.search(r"%(?![a-fA-F0-9]{2})", part):
            raise ValueError("Source identity contains malformed percent encoding.")
        decoded = unquote(part, errors="strict")
        if len(decoded) > 512:
            raise ValueError("Source identity exceeds its canonical bound.")
        exact_id(decoded)
    return value


RecordId = Annotated[
    str,
    StringConstraints(
        min_length=1, max_length=512, pattern=r"^(agent:|graph_packages:|power_platform:)"
    ),
    AfterValidator(record_id),
]
Search = Annotated[str, StringConstraints(max_length=256, pattern=r"^[^\x00\r\n]*$")]
FacetText = Annotated[str, StringConstraints(max_length=4096, pattern=r"^[^\x00\r\n]*$")]
Limit = Annotated[int, Field(ge=1, le=100)]
Offset = Annotated[int, Field(ge=0, le=100000)]
IdempotencyKey = Annotated[
    str, StringConstraints(min_length=1, max_length=128, pattern=r"^[A-Za-z0-9_-]+$")
]


def calendar_date(value: str) -> str:
    if date.fromisoformat(value).isoformat() != value:
        raise ValueError("Use an exact real YYYY-MM-DD UTC calendar date.")
    return value


def utc_instant(value: str) -> str:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if "T" not in value or parsed.tzinfo is None or parsed.utcoffset() != UTC.utcoffset(parsed):
        raise ValueError("Use a timezone-qualified UTC instant.")
    return value


CalendarDate = Annotated[
    str, StringConstraints(pattern=r"^\d{4}-\d{2}-\d{2}$"), AfterValidator(calendar_date)
]
UtcInstant = Annotated[
    str,
    StringConstraints(
        max_length=64, pattern=r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$"
    ),
    AfterValidator(utc_instant),
]


class Input(WireModel):
    @model_validator(mode="before")
    @classmethod
    def explicit_nulls(cls, value: object) -> object:
        if isinstance(value, dict) and any(
            item is None
            and key
            not in {"type", "publisher", "availableTo", "host", "platform", "company", "department"}
            for key, item in value.items()
        ):
            raise ValueError("Omit optional values; only null-valued facet filters accept null.")
        return value


class Empty(Input):
    pass


class CheckInput(Input):
    retry: Literal["failed"] | None = None


class ProbeInput(Input):
    id: CapabilityId


class Paging(Input):
    cursor: Opaque | None = None
    limit: Limit | None = None


class Selected(Paging):
    selectionId: Guid


class InventoryQuery(Input):
    inventoryScope: Literal["catalog", "power_platform_only", "all"] | None = None
    type: FacetText | None = None
    view: (
        Literal[
            "all",
            "first_party",
            "third_party",
            "user_managed",
            "copilot_studio",
            "organization_managed",
            "available",
            "unavailable",
            "availability_unknown",
            "organization",
            "used",
            "unknown",
        ]
        | None
    ) = None
    endUserAccess: Literal["all", "available", "unavailable", "unknown"] | None = None
    reportedUsage: Literal["all", "used"] | None = None
    management: Literal["all", "user_managed", "organization_managed", "unknown"] | None = None
    relevance: Literal["all", "organization", "unknown"] | None = None
    recordId: RecordId | None = None
    operationIdPrefix: (
        Annotated[str, StringConstraints(pattern=r"^[A-Za-z0-9_-]{1,64}$")] | None
    ) = None
    search: Search | None = None
    source: Literal["all", "graph_packages", "power_platform", "both"] | None = None
    linkState: Literal["matched", "unmatched", "ambiguous", "conflicting"] | None = None
    environmentId: ExactId | None = None
    blocked: bool | None = None
    publisher: FacetText | None = None
    availableTo: FacetText | None = None
    host: FacetText | None = None
    platform: FacetText | None = None
    createdWithinDays: Annotated[int, Field(ge=1, le=3650)] | None = None
    sortBy: (
        Literal[
            "displayName",
            "environment",
            "builtWith",
            "availability",
            "status",
            "hosts",
            "publisher",
            "origin",
            "deployment",
            "owner",
            "createdBy",
            "createdAt",
            "lastModifiedAt",
            "lastPublishedAt",
            "agentType",
            "versions",
            "publication",
            "quarantine",
            "location",
            "model",
            "authentication",
            "channels",
            "orchestration",
            "webSearch",
            "managed",
            "source",
            "observedAt",
            "linkState",
            "responses",
            "activeUsers",
            "lastActivity",
        ]
        | None
    ) = None
    sortDirection: Literal["asc", "desc"] | None = None


class InventoryCapture(Input):
    query: InventoryQuery


class InventoryList(InventoryQuery, Paging):
    selectionId: Guid | None = None

    @model_validator(mode="after")
    def pinned_cursor(self) -> Self:
        if self.cursor is not None and self.selectionId is None:
            raise ValueError("A cursor requires its exact saved selection; restart explicitly.")
        return self


class PackageCapture(InventoryCapture):
    mode: Literal["delegated"] | None = None


class PackageList(InventoryList):
    mode: Literal["delegated"] | None = None


class InventoryFacet(Selected):
    field: Literal["type", "publisher", "availableTo", "host", "platform"]
    search: Search | None = None
    selected: bool | None = None


class AgentSelected(Selected):
    recordId: RecordId


class AgentSections(AgentSelected):
    sourceScopeId: Guid
    sourceIdentity: ExactId


class AboutInput(Input):
    recordId: RecordId
    selectionId: Guid
    sourceScopeId: Guid
    sourceIdentity: ExactId
    field: Literal["long", "native", "short"]
    cursor: Opaque | None = None


class AgentChildren(AgentSelected):
    kind: Literal[
        "member",
        "identifier",
        "connectorOperation",
        "supportedHosts",
        "elementTypes",
        "categories",
        "allowedUsersAndGroups",
        "acquireUsersAndGroups",
        "sharedWithUsersAndGroups",
        "element",
        "elementGroup",
        "detail:channels",
        "detail:connectors",
        "collection",
    ]
    sourceScopeId: Guid | None = None
    sourceIdentity: ExactId | None = None
    value: ExactId | None = None

    @model_validator(mode="after")
    def exact_source(self) -> Self:
        if (self.sourceScopeId is None) != (self.sourceIdentity is None):
            raise ValueError("Source scope and identity must be supplied together.")
        return self


class ResponsibilityInput(Paging):
    objectId: Guid | None = None
    search: Search | None = None
    selectionId: Guid | None = None

    @model_validator(mode="after")
    def pinned_cursor(self) -> Self:
        if self.cursor and not self.selectionId:
            raise ValueError("A cursor requires its exact saved selection.")
        return self


class ResolvePeople(Input):
    recordId: RecordId
    force: bool | None = None


class PackageDetailInput(Input):
    id: ExactId
    selectionId: Guid
    mode: Literal["delegated"] | None = None


class NativeActivityInput(Input):
    nativeId: ExactId
    snapshotId: Guid
    environmentId: ExactId | None = None


class StudioTargetsInput(Input):
    snapshotId: Guid
    selected: Annotated[list[ExactId], Field(max_length=25)] | None = None


class ReportBase(Paging):
    selectionId: Guid | None = None
    setId: Guid | None = None
    search: Search | None = None
    order: Literal["asc", "desc"] | None = None

    @model_validator(mode="after")
    def frozen(self) -> Self:
        if self.cursor and not self.selectionId:
            raise ValueError("A cursor requires its exact report selection.")
        start = getattr(self, "startDate", None)
        end = getattr(self, "endDate", None)
        if start and end and start > end:
            raise ValueError("The start date must not follow the end date.")
        return self


class UserFilters(ReportBase):
    company: FacetText | None = None
    department: FacetText | None = None
    entitlement: Entitlement | None = None
    serviceState: ServiceState | None = None
    reportActivity: Literal["all", "recent", "inactive", "no-activity"] | None = None
    creatorType: Annotated[str, StringConstraints(max_length=256)] | None = None
    agentId: ExactId | None = None
    username: ExactId | None = None
    licenseCohort: Literal["active_without_paid"] | None = None
    lowResponseThreshold: Annotated[int, Field(ge=1, le=100000000)] | None = None
    inactiveDays: Annotated[int, Field(ge=1, le=365)] | None = None
    activityWindowDays: Annotated[int, Field(ge=1, le=365)] | None = None
    responsesOnly: bool | None = None
    startDate: CalendarDate | None = None
    endDate: CalendarDate | None = None


class UsersInput(UserFilters):
    appActivity: Literal["active", "inactive", "unknown"] | None = None
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
        ]
        | None
    ) = None


class ReportUsersInput(UserFilters):
    cohort: Literal["all", "zero", "low", "review"] | None = None
    sort: Literal["name", "responses", "agentsUsed", "lastActivity"] | None = None


class ReportAgentsInput(ReportBase):
    creatorType: Annotated[str, StringConstraints(max_length=256)] | None = None
    agentId: ExactId | None = None
    responsesOnly: bool | None = None
    startDate: CalendarDate | None = None
    endDate: CalendarDate | None = None
    inactiveDays: Annotated[int, Field(ge=1, le=365)] | None = None
    activityWindowDays: Annotated[int, Field(ge=1, le=365)] | None = None
    sort: (
        Literal[
            "name", "responses", "activeUsers", "licensedUsers", "unlicensedUsers", "lastActivity"
        ]
        | None
    ) = None


class RelationshipInput(ReportBase):
    creatorType: Annotated[str, StringConstraints(max_length=256)] | None = None
    agentId: ExactId | None = None
    username: ExactId | None = None
    responsesOnly: bool | None = None
    startDate: CalendarDate | None = None
    endDate: CalendarDate | None = None
    sort: Literal["name", "responses", "lastActivity", "creatorType"] | None = None


class UserDetailInput(UsersInput):
    objectId: Guid


class UserUsedAgentsInput(RelationshipInput):
    objectId: Guid


class ResolveUser(Input):
    username: ExactId
    selectionId: Guid | None = None
    setId: Guid | None = None

    @model_validator(mode="after")
    def one_selection(self) -> Self:
        if self.selectionId and self.setId:
            raise ValueError("A pinned selection already fixes its report set.")
        return self


class SavedRelationshipsInput(Selected):
    objectId: Guid
    inventorySelectionId: Guid
    relationship: Literal["used", "created", "owned", "modified"]


class AdoptionInput(ReportBase):
    company: FacetText | None = None
    department: FacetText | None = None
    adoptionChamps: Literal["with", "without"] | None = None
    adoptionAgents: Literal["with", "without"] | None = None
    sort: Literal["name"] | None = None
    limit: Annotated[int, Field(ge=1, le=10)] | None = None


class ChampionsInput(Selected):
    inventorySelectionId: Guid


class ReportFacetInput(Selected):
    field: Literal["company", "department", "creatorType"]
    search: Search | None = None


class ReportAgentDetail(ReportAgentsInput):
    agentId: ExactId


class ReportAgentUsers(RelationshipInput):
    agentId: ExactId


class ReportUserDetail(ReportUsersInput):
    username: ExactId


class ReportUserAgents(RelationshipInput):
    username: ExactId


class HistoryInput(ReportBase):
    sort: Literal["reportingPeriod", "acceptedAt"] | None = None


class ObservationsInput(HistoryInput):
    setId: Guid


class OverviewInput(ReportBase):
    scope: Literal["history", "selected"] | None = None
    sort: Literal["name", "lastActivity"] | None = None
    startDate: CalendarDate | None = None
    endDate: CalendarDate | None = None


class UsageInput(Paging):
    recordId: RecordId
    selectionId: Guid | None = None
    inventorySelectionId: Guid | None = None
    setId: Guid | None = None

    @model_validator(mode="after")
    def exact_selection(self) -> Self:
        if self.inventorySelectionId and self.selectionId != self.inventorySelectionId:
            raise ValueError("Inventory usage requires matching inventory/selection IDs.")
        if self.cursor and not self.selectionId:
            raise ValueError("A cursor requires its exact saved selection.")
        return self


class UsageUsersInput(UsageInput):
    search: Search | None = None


class UsageHistoryInput(Paging):
    recordId: RecordId
    selectionId: Guid
    inventorySelectionId: Guid | None = None
    compareFromSetId: Guid | None = None
    compareToSetId: Guid | None = None

    @model_validator(mode="after")
    def paired_comparison(self) -> Self:
        if bool(self.compareFromSetId) != bool(self.compareToSetId):
            raise ValueError("Supply both exact comparison report sets.")
        if self.inventorySelectionId and self.selectionId != self.inventorySelectionId:
            raise ValueError("Inventory usage requires matching inventory/selection IDs.")
        return self


class UsageCandidatesInput(ReportAgentsInput):
    recordId: RecordId
    inventoryRevision: Annotated[str, StringConstraints(pattern=r"^[a-f0-9]{64}$")] | None = None


class JobId(Input):
    id: Guid


class JobList(Input):
    limit: Annotated[int, Field(ge=1, le=50)] | None = None


class StartSync(Input):
    mode: Literal["initial", "incremental", "full"]
    sources: (
        Annotated[
            list[Literal["users", "graph_packages", "power_platform"]],
            Field(min_length=1, max_length=3),
        ]
        | None
    ) = None

    @model_validator(mode="after")
    def distinct(self) -> Self:
        if self.sources and len(set(self.sources)) != len(self.sources):
            raise ValueError("Sources must be unique.")
        return self


class RetrySync(JobId):
    sources: (
        Annotated[
            list[Literal["users", "graph_packages", "power_platform"]],
            Field(min_length=1, max_length=3),
        ]
        | None
    ) = None


class Submission(Input):
    idempotencyKey: IdempotencyKey | None = None


class RefreshPackages(Submission):
    mode: Literal["delegated"] | None = None
    ids: Annotated[list[ExactId], Field(min_length=1, max_length=5000)] | None = None


class RefreshPackage(Submission):
    id: ExactId
    mode: Literal["delegated"] | None = None


class RefreshSelected(Submission):
    selectionId: Guid
    ids: Annotated[list[ExactId], Field(min_length=1, max_length=5000)] | None = None
    recordIds: Annotated[list[RecordId], Field(min_length=1, max_length=5000)] | None = None

    @model_validator(mode="after")
    def bounded_targets(self) -> Self:
        if len(self.ids or []) + len(self.recordIds or []) > 5000:
            raise ValueError("Use at most 5000 explicit references.")
        return self


class PackageJobId(JobId):
    mode: Literal["delegated"] | None = None


class PackageJobs(JobList):
    mode: Literal["delegated"] | None = None


class PackageTargets(PackageJobId, Paging):
    revision: Opaque | None = None

    @model_validator(mode="after")
    def pinned_revision(self) -> Self:
        if self.cursor and not self.revision:
            raise ValueError("A target cursor requires its exact result revision.")
        return self


class RefreshStudio(Submission):
    environmentId: ExactId | None = None
    types: Annotated[list[ResourceType], Field(min_length=1, max_length=2)] | None = None


class SearchPrincipals(Input):
    search: Annotated[str, StringConstraints(min_length=2, max_length=120)]
    limit: Annotated[int, Field(ge=1, le=50)] | None = None


class PrincipalInput(Input):
    resourceType: Literal["user", "group"]
    resourceId: Guid


class ResolvePrincipals(Input):
    principals: Annotated[list[PrincipalInput], Field(min_length=1, max_length=500)]


class InvestigationInput(Input):
    recordId: RecordId


PurviewOperation = Literal[
    "CopilotInteraction",
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
]


class AgentPurviewInput(InvestigationInput):
    limit: Limit | None = None
    offset: Offset | None = None
    search: Search | None = None
    operation: PurviewOperation | None = None


class PurviewSearchFilters(Input):
    presetId: PresetId
    operations: Annotated[list[PurviewOperation], Field(min_length=1, max_length=100)]
    startDateTime: UtcInstant
    endDateTime: UtcInstant
    userPrincipalNames: Annotated[list[ExactId], Field(max_length=20)] = Field(default_factory=list)
    ipAddresses: Annotated[list[ExactId], Field(max_length=20)] = Field(default_factory=list)
    objectIds: Annotated[list[ExactId], Field(max_length=20)] = Field(default_factory=list)
    administrativeUnitIds: Annotated[list[Guid], Field(max_length=20)] = Field(default_factory=list)

    @model_validator(mode="after")
    def curated_window(self) -> Self:
        start = datetime.fromisoformat(self.startDateTime.replace("Z", "+00:00"))
        end = datetime.fromisoformat(self.endDateTime.replace("Z", "+00:00"))
        if not 0 < (end - start).total_seconds() <= 168 * 3600:
            raise ValueError("Select a positive window no longer than 168 hours.")
        if len(set(self.operations)) != len(self.operations) or any(
            (operation == "CopilotInteraction") != (self.presetId == "copilot_interactions")
            for operation in self.operations
        ):
            raise ValueError("Select unique operations from the preset's curated allowlist.")
        return self


class StartPurview(Submission):
    tokenMode: Literal["delegated"]
    filters: PurviewSearchFilters
    agentRecordId: RecordId | None = None


class PurviewHistory(JobList):
    offset: Offset | None = None
    userPrincipalName: ExactId | None = None
    agentRecordId: RecordId | None = None


class PurviewRecordsInput(JobId):
    limit: Annotated[int, Field(ge=1, le=500)] | None = None
    offset: Offset | None = None


class HuntingTarget(Input):
    agentRecordId: RecordId | None = None
    userObjectId: Guid | None = None


HuntingOperation = Literal[
    "InvokeAgent",
    "InferenceCall",
    "ExecuteToolBySDK",
    "ExecuteToolByGateway",
    "ExecuteToolByMCPServer",
]


class HuntFilters(Input):
    templateId: TemplateId
    startDateTime: UtcInstant
    endDateTime: UtcInstant
    agentIds: Annotated[list[ExactId], Field(max_length=20)] = Field(default_factory=list)
    entraAgentIds: Annotated[list[Guid], Field(max_length=20)] | None = None
    entraAgentApplicationIds: Annotated[list[Guid], Field(max_length=20)] | None = None
    blueprintIds: Annotated[list[Guid], Field(max_length=20)] = Field(default_factory=list)
    actorObjectIds: Annotated[list[Guid], Field(max_length=20)] = Field(default_factory=list)
    userObjectId: Guid | None = None
    operations: Annotated[list[HuntingOperation], Field(max_length=5)] = Field(default_factory=list)

    @model_validator(mode="after")
    def curated_window(self) -> Self:
        start = datetime.fromisoformat(self.startDateTime.replace("Z", "+00:00"))
        end = datetime.fromisoformat(self.endDateTime.replace("Z", "+00:00"))
        if not 0 < (end - start).total_seconds() <= 168 * 3600:
            raise ValueError("Select a positive window no longer than 168 hours.")
        allowed = {
            "agents_inventory": set(),
            "agent_activity": {"InvokeAgent", "InferenceCall"},
            "agent_tools": {"ExecuteToolBySDK", "ExecuteToolByGateway", "ExecuteToolByMCPServer"},
        }[self.templateId]
        if not set(self.operations) <= allowed or len(set(self.operations)) != len(self.operations):
            raise ValueError("Select unique operations from the curated template.")
        if (self.templateId == "agents_inventory") != (not self.operations):
            raise ValueError("Inventory has no operations; activity/tool templates require one.")
        if self.templateId == "agents_inventory" and self.actorObjectIds:
            raise ValueError("Inventory has no actor filter.")
        if self.userObjectId and (
            self.templateId != "agent_activity" or self.operations != ["InvokeAgent"]
        ):
            raise ValueError(
                "An exact user target requires the human-attributed InvokeAgent operation."
            )
        return self


class StartHunt(Submission, HuntingTarget):
    tokenMode: Literal["delegated"]
    filters: HuntFilters


class HuntingHistory(JobList, HuntingTarget):
    offset: Offset | None = None


class HuntingJobInput(JobId, HuntingTarget):
    pass


class HuntingRowsInput(HuntingJobInput):
    limit: Annotated[int, Field(ge=1, le=200)] | None = None
    offset: Offset | None = None


class DeleteCache(JobId):
    confirmation: Guid

    @model_validator(mode="after")
    def exact_confirmation(self) -> Self:
        if self.confirmation != self.id:
            raise ValueError("Confirm the exact local job ID.")
        return self


class DeleteHuntingCache(DeleteCache, HuntingTarget):
    pass


class AuditInput(Input):
    limit: Annotated[int, Field(ge=1, le=5000)] | None = None
    offset: Offset | None = None
    agentId: ExactId | None = None
    actorUsername: ExactId | None = None
    scope: Literal["single", "bulk"] | None = None
    action: AuditAction | None = None
    status: AuditStatus | None = None
    operationIdPrefix: (
        Annotated[str, StringConstraints(pattern=r"^[A-Za-z0-9_-]{1,64}$")] | None
    ) = None
    search: Annotated[str, StringConstraints(max_length=200)] | None = None
    originChannel: Literal["webapp", "mcp", "unknown"] | None = None
    originIntegrationClientId: ExactId | None = None
    originClientId: ExactId | None = None
    originCallingAgentId: ExactId | None = None
