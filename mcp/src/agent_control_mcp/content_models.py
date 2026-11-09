"""Tenant-owned adoption content. Facts are calculated and authorized by the API."""

from typing import Annotated, Literal

from pydantic import Field, model_validator

from .discovery_models import Card, Provenance
from .inputs import Guid, Input
from .models import SafeInteger, WireModel
from .office_models import (
    AgentEvidence,
    Definitions,
    Denominators,
    EvidenceCoverage,
    Metrics,
    Observation,
)
from .report_models import ReportMetadata

Kind = Literal["brief", "card", "action"]
Status = Literal["open", "in_progress", "completed", "cancelled"]
EvidenceKind = Literal[
    "generated_draft", "description_suggestion", "contributor_provided", "contributor_confirmed"
]
Text = Annotated[str, Field(max_length=2048)]
Revision = Annotated[int, Field(strict=True, ge=1, le=2147483646)]


class Scope(Input):
    company: Annotated[str, Field(max_length=256)] | None
    department: Annotated[str, Field(max_length=256)] | None


class Narrative(Input):
    task: Text
    inputs: Text
    prompt: Text
    expectedOutput: Text
    reviewSteps: Text
    limitations: Text
    example: Text
    opportunity: Text
    exercises: Text
    successMeasure: Text
    unknowns: Text


class Learning(Input):
    task: Literal["summarize", "draft", "compare", "plan"]
    inputs: Literal["public_information", "approved_business_material", "synthetic_example"]
    output: Literal["summary", "draft_document", "comparison", "checklist"]
    prompt: Literal[
        "summarize_with_sources", "draft_for_review", "compare_with_caveats", "plan_with_checks"
    ]
    reviews: Annotated[
        list[Literal["verify_sources", "check_accuracy", "remove_sensitive_data", "human_review"]],
        Field(max_length=4),
    ]
    failures: Annotated[
        list[
            Literal["missing_context", "incorrect_facts", "unsupported_access", "incomplete_output"]
        ],
        Field(max_length=4),
    ]


class EvidenceQuery(Scope):
    officeSnapshot: Guid | None = None
    officeBaseline: Guid | None = None
    setId: Guid | None = None
    officeSelectionId: Guid
    reportSelectionId: Guid
    inventorySelectionId: Guid | None = None


class BaselineInput(Input):
    groupId: Annotated[str, Field(min_length=1, max_length=128)]
    query: EvidenceQuery


class Draft(Input):
    @model_validator(mode="before")
    @classmethod
    def explicit_nulls(cls, value: object) -> object:
        if isinstance(value, dict) and any(
            item is None and key not in {"learning", "assigneeId", "dueDate"}
            for key, item in value.items()
        ):
            raise ValueError("Only learning/assigneeId/dueDate accept null; omit baseline.")
        return value

    kind: Kind
    title: Annotated[str, Field(min_length=1, max_length=256)]
    scope: Scope
    narrative: Narrative
    learning: Learning | None
    evidenceKind: EvidenceKind
    visibility: Literal["staff_only", "employees"]
    assigneeId: Annotated[str, Field(max_length=256)] | None
    dueDate: Annotated[str, Field(pattern=r"^\d{4}-\d{2}-\d{2}$")] | None
    status: Status
    progress: Text
    agentIds: Annotated[list[Guid], Field(max_length=8)]
    linkedIds: Annotated[list[Guid], Field(max_length=8)]
    baseline: BaselineInput | None = None


class Aggregate(WireModel):
    id: str
    rank: SafeInteger
    company: str | None
    department: str | None
    office: Metrics
    denominators: Denominators
    agentEvidence: AgentEvidence
    coverage: EvidenceCoverage


class Baseline(WireModel):
    group: Aggregate
    definitions: Definitions
    office: Observation
    report: ReportMetadata
    capturedAt: str


class DurableQuery(WireModel):
    officeSnapshot: str
    company: str | None
    department: str | None
    setId: str | None = None


class Evidence(WireModel):
    state: Literal["unmeasured", "available", "superseded", "unavailable"]
    reason: str | None
    freshQuery: DurableQuery | None


class Reference(WireModel):
    id: str
    state: Literal["available", "removed"]


class SharedAgentReference(WireModel):
    id: str
    state: Literal["available", "unavailable"]
    agent: Card | None


class AgentReference(SharedAgentReference):
    sources: list[Provenance]


class Permissions(WireModel):
    core: bool
    progress: bool


class ContentRecord(WireModel):
    kind: Kind
    title: str
    scope: Scope
    narrative: Narrative
    learning: Learning | None
    evidenceKind: EvidenceKind
    visibility: Literal["staff_only", "employees"]
    assigneeId: str | None
    dueDate: str | None
    status: Status
    progress: str
    id: str
    creatorId: str
    revision: Revision
    createdAt: str
    updatedAt: str
    agents: list[AgentReference]
    links: list[Reference]
    baseline: Baseline | None
    evidence: Evidence
    permissions: Permissions


class ContentPage(WireModel):
    value: list[ContentRecord]
    nextCursor: str | None


class ContentSave(WireModel):
    record: ContentRecord | None
    id: str
    replayed: bool
    state: Literal["saved", "deleted"]


class Deleted(WireModel):
    id: str
    state: Literal["deleted"]


class FollowUp(WireModel):
    baseline: Baseline
    current: Baseline
    caveats: list[str]
    sameOriginalPeople: Literal[False]


class WithheldNarrative(WireModel):
    state: Literal["privacy_withheld"]
    reason: Literal["arbitrary_prose_identity_evidence_unavailable"]


class WithheldAttribution(WireModel):
    state: Literal["privacy_withheld"]


class SharedScope(WireModel):
    company: str | None
    department: str | None
    state: Literal["available", "privacy_withheld"]


class SharedCard(WireModel):
    id: str
    revision: Revision
    title: str
    learning: Learning
    evidenceKind: EvidenceKind
    visibility: Literal["employees"]
    scope: SharedScope
    agents: list[SharedAgentReference]
    narrative: WithheldNarrative
    attribution: WithheldAttribution


class SharedPage(WireModel):
    value: list[SharedCard]
    nextCursor: str | None


class ListInput(Input):
    kind: Kind | None = None
    limit: Annotated[int, Field(strict=True, ge=1, le=20)] = 10
    cursor: Annotated[str, Field(max_length=4096)] | None = None


class DetailInput(Input):
    id: Guid


class CreateInput(Input):
    requestId: Annotated[
        str, Field(pattern=r"^\d{13}\.[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$")
    ]
    draft: Draft


class UpdateInput(DetailInput):
    expectedRevision: Revision
    draft: Draft


class ProgressInput(DetailInput):
    expectedRevision: Revision
    status: Status
    progress: Text


class DeleteInput(DetailInput):
    expectedRevision: Revision
    confirmation: Annotated[str, Field(max_length=43)]


class FollowUpInput(DetailInput, BaselineInput):
    pass


class SharedInput(Input):
    id: Guid | None = None
    company: Annotated[str, Field(max_length=256)] | None = None
    department: Annotated[str, Field(max_length=256)] | None = None
    limit: Annotated[int, Field(strict=True, ge=1, le=20)] = 10
    cursor: Annotated[str, Field(max_length=4096)] | None = None


class PreviewSharedInput(SharedInput):
    subject: Annotated[str, Field(min_length=1, max_length=512)]
