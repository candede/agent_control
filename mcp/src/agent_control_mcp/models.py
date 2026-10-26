from __future__ import annotations

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints

CapabilityId = Literal[
    "graph.package.read.delegated",
    "graph.package.read.application",
    "graph.package.access.manage",
    "graph.package.block.manage",
    "graph.package.reassign.manage",
    "graph.directory.read",
    "graph.agentIdentity.read",
    "graph.licenses.read",
    "powerPlatform.inventory.read",
    "powerPlatform.quarantine.read",
    "powerPlatform.quarantine.manage",
    "purview.audit.search.delegated",
    "purview.audit.search.application",
    "defender.hunting.delegated",
    "defender.hunting.application",
    "reports.copilotUsage.read",
    "reports.official.import",
]
Status = Literal[
    "available",
    "missing_permission",
    "missing_internal_role",
    "missing_role",
    "missing_license",
    "not_configured",
    "unsupported",
    "preview_disabled",
    "provider_error",
    "unknown",
]


class WireModel(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, frozen=True)


class Probe(WireModel):
    kind: Literal["provider_read", "local_policy", "on_demand", "not_registered"]
    adapterRegistered: bool
    description: str


class Definition(WireModel):
    id: CapabilityId
    displayName: str
    purpose: str
    provider: Literal["Microsoft Graph", "Power Platform", "Local"]
    maturity: Literal["v1.0", "preview", "local"]
    cloud: Literal["global", "local"]
    audience: str
    mode: Literal["delegated", "application", "local"]
    permissions: list[str]
    acceptedPermissions: list[str] | None = None
    providerRoles: list[str]
    licenses: list[str]
    configuration: list[str]
    sources: list[str]
    dataClass: Literal[
        "inventory",
        "package_control",
        "directory",
        "provider_audit",
        "hunting",
        "aggregate_usage",
        "licensed_usage",
        "report_import",
    ]
    internalRoles: list[Literal["AgentControl.Viewer", "AgentControl.Admin"]]
    consentGroup: str | None = None
    probe: Probe


class Evidence(WireModel):
    category: str | None = None
    correlationId: str | None = None
    httpStatus: int | None = Field(default=None, ge=100, le=599)
    providerErrorCode: str | None = None
    phase: Literal["token_acquisition", "provider_read"] | None = None
    timeoutMs: int | None = Field(default=None, ge=0, le=9007199254740991)


class Decision(WireModel):
    capabilityId: CapabilityId
    status: Status
    authorized: bool
    fresh: bool
    verification: Literal["local", "token", "provider", "on_demand"] | None = None
    checkedAt: str | None = None
    expiresAt: str | None = None
    lastSuccessAt: str | None = None
    previewQualification: Literal["not_required", "unqualified", "qualified"]
    evidence: Evidence | None = None
    remediation: list[str]


class Configuration(WireModel):
    enabled: bool
    sharedDataScope: bool
    revision: int = Field(ge=0, le=9007199254740991)


class OperationFailure(WireModel):
    status: Literal[
        "missing_permission", "missing_role", "missing_license", "provider_error", "unknown"
    ]
    checkedAt: str
    expiresAt: str
    evidence: Evidence | None = None
    remediation: list[str]


class CapabilityView(WireModel):
    definition: Definition
    decision: Decision
    operationFailure: OperationFailure | None = None
    enabled: bool
    configuration: Configuration | None = None


class Capabilities(WireModel):
    value: list[CapabilityView] = Field(max_length=100)


class Check(WireModel):
    capabilityId: CapabilityId
    state: Literal["reviewing", "checking", "complete"]


class Progress(WireModel):
    checks: list[Check] = Field(max_length=100)


class CheckProgress(WireModel):
    progress: Progress | None


Opaque = Annotated[str, StringConstraints(min_length=1, max_length=8192)]
SafeInteger = Annotated[int, Field(ge=0, le=9007199254740991)]


class PublicationRevisions(WireModel):
    graph_packages: str
    power_platform: str
    users: str


class PublishedSelectedRead(WireModel):
    id: str
    revision: str
    expiresAt: str
    evaluatedAt: str
    validatedAt: str
    publicationRevisions: PublicationRevisions


class Provenance(WireModel):
    path: str | None
    maturity: Literal["ga", "preview", "observed", "unknown"]


class AgentAboutPage(WireModel):
    recordId: str
    sourceScopeId: str
    sourceIdentity: str
    generationId: str
    field: Literal["long", "native", "short"]
    state: Literal["available", "missing"]
    source: Literal["graph_packages", "power_platform"]
    provenance: Provenance
    observedAt: str
    text: str | None
    totalBytes: SafeInteger
    returnedBytes: SafeInteger
    nextCursor: str | None
    selection: PublishedSelectedRead
