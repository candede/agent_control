"""Exact canonical control requests; receipt and provider authority remain API-owned."""

import re
from typing import Annotated, Literal, Self

from pydantic import AfterValidator, BeforeValidator, Field, StringConstraints, model_validator

from .inputs import ExactId, Guid, IdempotencyKey, Input, JobId, Paging, PrincipalInput

Hash = Annotated[str, StringConstraints(pattern=r"^[a-f0-9]{64}$")]
CanonicalId = Annotated[
    str, StringConstraints(pattern=r"^agent:[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$")
]


def control_record(value: str) -> str:
    # Generic controls explicitly retain report-only IDs for API ineligibility evidence.
    if value.startswith("report:") and len(value) > 7:
        return value
    if re.fullmatch(r"agent:[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}", value):
        return value.lower()
    raise ValueError("Use exact canonical or report-only agent references.")


ControlRecord = Annotated[ExactId, AfterValidator(control_record)]


class PreviewAgentControl(Input):
    selectionId: Guid
    recordIds: Annotated[list[ControlRecord], Field(min_length=1, max_length=100)]
    action: Literal["block", "unblock"]

    @model_validator(mode="after")
    def distinct(self) -> Self:
        if len(set(self.recordIds)) != len(self.recordIds):
            raise ValueError("Use distinct exact canonical/report references.")
        return self


class ExecuteAgentControl(Input):
    receiptId: Guid
    confirmationHash: Hash
    idempotencyKey: Annotated[
        str, StringConstraints(min_length=1, max_length=200, pattern=r"^[\x21-\x7e]+$")
    ]


class AgentControlReceipt(Input):
    receiptId: Guid


class PackageTargets(Input):
    selectionId: Guid | None = None
    ids: Annotated[list[ExactId], Field(min_length=1, max_length=5000)] | None = None
    recordIds: Annotated[list[CanonicalId], Field(min_length=1, max_length=5000)] | None = None

    @model_validator(mode="after")
    def exact_targets(self) -> Self:
        if not (self.selectionId or self.ids or self.recordIds):
            raise ValueError("Select exact packages, canonical groups or a current selection.")
        for values in (self.ids, self.recordIds):
            if values and len(set(values)) != len(values):
                raise ValueError("Use distinct exact target references.")
        return self


class CountPackageTargets(PackageTargets):
    selectionId: Guid

    @model_validator(mode="after")
    def selected_targets(self) -> Self:
        if not (self.ids or self.recordIds):
            raise ValueError("Selection counts require explicit package or canonical targets.")
        return self


class AccessFields(Input):
    target: Literal["availability", "installation"]
    mode: Literal["add", "replace"]
    scope: Literal["specific", "none"]
    principals: Annotated[list[PrincipalInput], Field(max_length=500)]

    @model_validator(mode="after")
    def access_intent(self) -> Self:
        if self.scope == "none":
            if self.mode != "replace" or self.principals:
                raise ValueError("No users requires replace and an empty principal collection.")
        elif not self.principals:
            raise ValueError("Specific access requires exact principals.")
        keys = [(item.resourceType, item.resourceId) for item in self.principals]
        if len(set(keys)) != len(keys):
            raise ValueError("Use distinct typed directory principals.")
        return self


class PreviewPackageControl(PackageTargets):
    action: Literal["block", "unblock", "update-availability", "update-installation"]
    mutationScope: Literal["single", "bulk"]
    target: Literal["availability", "installation"] | None = None
    mode: Literal["add", "replace"] | None = None
    scope: Literal["specific", "none"] | None = None
    principals: Annotated[list[PrincipalInput], Field(max_length=500)] | None = None

    @model_validator(mode="after")
    def matching_access(self) -> Self:
        fields = {"target", "mode", "scope", "principals"}
        supplied = self.model_fields_set & fields
        if self.action.startswith("update-"):
            if supplied != fields or self.action != "update-" + str(self.target):
                raise ValueError("Use the exact matching access action and full access intent.")
            AccessFields.model_validate(self.model_dump(include=fields))
            if len(self.ids or []) > 100 or len(self.recordIds or []) > 100:
                raise ValueError("Access changes support at most 100 targets.")
        elif supplied:
            raise ValueError("Package block/unblock does not accept an access payload.")
        return self


class PackageSubmission(Input):
    confirmationHash: Hash
    idempotencyKey: IdempotencyKey


class SubmitPackages(PackageTargets, PackageSubmission):
    pass


class SubmitSelectedPackages(PackageSubmission):
    selectionId: Guid


class SubmitPackage(PackageSubmission):
    id: ExactId
    selectionId: Guid | None = None


class UpdatePackagesAccess(PackageTargets, AccessFields, PackageSubmission):
    ids: Annotated[list[ExactId], Field(min_length=1, max_length=100)] | None = None
    recordIds: Annotated[list[CanonicalId], Field(min_length=1, max_length=100)] | None = None


class UpdatePackageAccess(SubmitPackage, AccessFields):
    mode: Literal["replace"]


class PackageItems(JobId, Paging):
    revision: Annotated[str, StringConstraints(max_length=32, pattern=r"^\d+$")] | None = None

    @model_validator(mode="after")
    def pinned_revision(self) -> Self:
        if self.cursor and not self.revision:
            raise ValueError("Item continuation requires its exact result revision.")
        return self


def confirmed(value: object) -> Literal[True]:
    if value is not True:
        raise ValueError("Resume requires exactly confirmed true for eligible unsent work.")
    return True


class ResumeControl(JobId):
    confirmed: Annotated[Literal[True], BeforeValidator(confirmed)]


class StudioStatus(Input):
    snapshotId: Guid
    nativeId: ExactId
    force: bool | None = None


class StudioIntent(Input):
    action: Literal["quarantine", "unquarantine"]
    snapshotId: Guid
    resourceNativeIds: Annotated[list[ExactId], Field(min_length=1, max_length=25)]


class PreviewStudioControl(StudioIntent):
    forceStatus: bool | None = None


class ExecuteStudioControl(StudioIntent, PackageSubmission):
    pass


class StudioAudit(Input):
    limit: Annotated[int, Field(ge=1, le=500)] | None = None
    originChannel: Literal["webapp", "mcp", "unknown"] | None = None
    originIntegrationClientId: Guid | None = None
    originClientId: Annotated[str, StringConstraints(min_length=1, max_length=128)] | None = None
    originCallingAgentId: Annotated[str, StringConstraints(min_length=1, max_length=128)] | None = (
        None
    )
