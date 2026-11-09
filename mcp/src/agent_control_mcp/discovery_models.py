"""Positive safe discovery wire contracts, owned by the canonical API."""

import unicodedata
from typing import Annotated, Literal, Self

from pydantic import AfterValidator, Field, StringConstraints, field_validator, model_validator

from .inputs import Guid, Input
from .models import WireModel

# ECMAScript trim characters, matching the canonical API's search normalization.
_TRIM = (
    "\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005"
    "\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"
)


def _bounded_text(value: str, maximum: int, *, empty: bool = False) -> str:
    if (
        any(unicodedata.category(char) in {"Cc", "Cs"} for char in value)
        or len(value.encode("utf-16-le")) > maximum * 2
        or (not empty and not value.strip(_TRIM))
    ):
        raise ValueError("Use bounded discovery text without controls or surrogates.")
    return value


def _search_key(value: str) -> str:
    return unicodedata.normalize("NFKC", unicodedata.normalize("NFKC", value).lower()).strip(_TRIM)


def _search_text(value: str, maximum: int, *, empty: bool = False) -> str:
    _bounded_text(value, maximum, empty=empty)
    _bounded_text(_search_key(value), maximum, empty=True)
    return value


def _cursor(value: str) -> str:
    if len(value.encode("utf-8")) > 4096:
        raise ValueError("Use a discovery cursor of at most 4096 UTF-8 bytes.")
    return value


Cursor = Annotated[str, StringConstraints(min_length=1, max_length=4096), AfterValidator(_cursor)]
Goal = Annotated[
    str,
    StringConstraints(max_length=512),
    AfterValidator(lambda value: _search_text(value, 512, empty=True)),
]
Term = Annotated[
    str,
    StringConstraints(min_length=1, max_length=128),
    AfterValidator(lambda value: _search_text(value, 128)),
]
Subject = Annotated[
    str,
    StringConstraints(min_length=1, max_length=512),
    AfterValidator(lambda value: _bounded_text(value, 512)),
]
CardLimit = Annotated[int, Field(ge=1, le=20)]
TextState = Literal["available", "absent", "privacy_withheld", "unsafe_withheld", "limit_withheld"]
Source = Literal["graph_packages", "power_platform"]


class Privacy(WireModel):
    hide_employee_details: bool
    hide_champion_employee: bool


class DiscoveryInput(Input):
    selectionId: Guid | None = None


class _ContinuationInput(DiscoveryInput):
    cursor: Cursor | None = None

    @model_validator(mode="after")
    def bound_cursor(self) -> Self:
        if self.cursor is not None and self.selectionId is None:
            raise ValueError("Continue with the original selectionId.")
        return self


class SearchInput(_ContinuationInput):
    goal: Goal | None = None
    terms: Annotated[list[Term], Field(max_length=8)] | None = None
    limit: CardLimit | None = None

    @field_validator("terms")
    @classmethod
    def distinct_terms(cls, value: list[str] | None) -> list[str] | None:
        if value is not None and len({_search_key(term) for term in value}) != len(value):
            raise ValueError("Use distinct normalized discovery terms.")
        return value


class DetailInput(_ContinuationInput):
    agentId: Guid


class WorkplaceInput(DiscoveryInput):
    scope: Literal["department", "company", "both"] | None = None
    limit: CardLimit | None = None


class PreviewProfile(DiscoveryInput):
    subject: Subject


class PreviewSearch(SearchInput):
    subject: Subject


class PreviewDetail(DetailInput):
    subject: Subject


class PreviewWorkplace(WorkplaceInput):
    subject: Subject


class DiscoveryText(WireModel):
    state: TextState
    text: str | None


class Description(DiscoveryText):
    clipped: bool


class Contact(WireModel):
    name: str | None
    contact: str | None
    company: str | None
    department: str | None


class People(WireModel):
    state: Literal["available", "absent", "privacy_withheld", "unavailable"]
    value: list[Contact]


class Affiliation(WireModel):
    company: str | None
    department: str | None


class SourceMembership(WireModel):
    source: Source
    generationId: str
    sourceIdentity: str
    revision: str


class Evidence(SourceMembership):
    field: Literal["description", "title"]
    excerpt: str


class OriginEvidence(SourceMembership):
    field: Literal["type", "publisher", "resourceType", "creatorType"]
    setId: str | None
    versionId: str | None


class Origin(WireModel):
    kind: Literal["organization_created", "microsoft"]
    evidence: list[OriginEvidence]


class Provenance(SourceMembership):
    observedAt: str
    descriptionField: Literal["longDescription", "shortDescription", "details.description"]
    descriptionState: TextState


class Card(WireModel):
    id: str
    origin: Origin
    title: DiscoveryText
    description: Description
    lifecycle: Literal["draft", "published", "unknown"]
    people: People
    affiliations: list[Affiliation]
    useLink: DiscoveryText
    evidence: list[Evidence]
    sources: list[Provenance]


class DiscoveryContext(WireModel):
    mode: Literal["self", "preview"]
    subject: Literal["current_account", "selected_member"]
    company: str | None
    department: str | None
    profileState: Literal["available", "unavailable"]


class Selection(WireModel):
    id: str
    revision: str
    expiresAt: str


class Period(WireModel):
    startDate: str | None
    endDate: str | None


class OwnChampion(WireModel):
    state: Literal["suggested", "not_suggested", "unavailable"]
    reason: str | None


class DiscoveryResult(WireModel):
    context: DiscoveryContext
    selection: Selection
    privacy: Privacy


class Page(DiscoveryResult):
    state: Literal["candidate", "no_matching_saved_evidence", "coverage_incomplete"]
    value: list[Card]
    nextCursor: str | None


class Profile(DiscoveryResult):
    period: Period | None
    reportState: Literal["available", "stale", "unavailable"]
    ownChampion: OwnChampion


class Detail(DiscoveryResult):
    agent: Card
    description: Description
    nextCursor: str | None


class Champions(WireModel):
    state: Literal["available", "privacy_withheld", "unavailable"]
    value: list[Contact]


class ScopedCards(WireModel):
    state: Literal["available", "unavailable"]
    value: list[Card]


class UseCase(WireModel):
    agent: Card
    relationships: list[Literal["created_here", "used_here"]]


class UseCases(WireModel):
    state: Literal["available", "unavailable"]
    value: list[UseCase]


class Workplace(Profile):
    champions: Champions
    department: ScopedCards
    company: ScopedCards
    useCases: UseCases
