# Provider contracts and requirements

Provider availability and authorization are checked when an operation runs.
The [capability registry](../backend/src/services/capabilityRegistry.ts) is the
current capability-ID and Microsoft source-reference inventory. Local fixtures
establish implementation behavior, not live consent, licensing or data visibility.

## App registration permissions

This is the current Permissions page's **11-entry, four-group** reference.
App-defined roles are documented separately in the
[role guide](user-roles-and-permissions.md#app-defined-roles); these tables describe
Microsoft access only.

### Microsoft Graph / Application

Configured application credentials and tenant admin consent support automatic
reads without signed-in Microsoft directory/reporting roles.

| Permission | Feature and required Microsoft access |
| --- | --- |
| `CopilotPackages.Read.All` | Published agent/package inventory, metadata and sharing details; applicable Microsoft Agent 365 licensing, application credentials and tenant admin consent. |
| `User.Read.All` | Directory users, Copilot license assignments, exact creators/owners, management user search and user-ID validation. |
| `LicenseAssignment.Read.All` | Tenant product SKUs and service-plan catalog. |
| `Reports.Read.All` | 28-day per-user Copilot Office-app activity; not the three imported agent-usage CSV reports. |

### Microsoft Graph / Delegated

| Permission | Feature and required Microsoft access |
| --- | --- |
| `CopilotPackages.ReadWrite.All` | Package block/unblock, availability/installation assignments and control readback. Requires delegated tenant admin consent and a Microsoft Agent 365 license. Recommended signed-in administrator role: **AI Administrator**; **Global Administrator** is a broader alternative. Package writes support delegated work or school accounts only. |
| `Group.Read.All` | Management group search/resolution using the signed-in user's delegated directory visibility. |

Microsoft defines both application and delegated forms of the package permission,
but the application form does not authorize these writes. Configure **Microsoft
Graph > Delegated permissions** for package controls. The role recommendation
follows Microsoft's agent-management guidance for the Microsoft 365 admin center.
The package API does not publish an explicit role minimum; this is not a
confirmed exclusive API role requirement. See the
[recommended administrator role and API support](user-roles-and-permissions.md#package-management-administrator-roles).

### Power Platform / Delegated

Power Platform is separate from Graph and uses the signed-in user's Microsoft
privileges.

| Permission | Feature and required Microsoft access |
| --- | --- |
| `ResourceQuery.Resources.Read` | Studio agents and environment inventory. Recommend **AI Reader**, the least-privileged supported Entra inventory role for this sync; **no application permission equivalent**. Saved tenant data remains readable without sync access. |
| `CopilotStudio.AdminActions.Invoke` | Studio quarantine status and quarantine/restore. Both status and changes require **AI Administrator**, **Power Platform Administrator** or **Global Administrator**. |

A **Privileged Role Administrator** assigns AI Reader through **Microsoft Entra
admin center > Identity > Roles & admins > AI Reader > Add assignments**. The
viewer signs out/in and first activates a PIM-eligible role. Inventory API consent
is separate from role assignment and grants no quarantine status or changes.
Global Reader, AI Administrator, Power Platform Administrator, Dynamics 365
Administrator and Global Administrator also work if already assigned; do not
grant broader roles solely for sync. AI roles cover AI-scoped resources.
These are inventory-feature roles, not a separately published REST API minimum.
See the [full assignment instructions](user-roles-and-permissions.md#assign-ai-reader-to-a-viewer).

### Sign-in / OpenID Connect

Sign-in scopes do not authorize inventory reads or administrative changes.
`User.Read` is not used.

| Scope | Purpose |
| --- | --- |
| `openid` | Authenticate the account with an ID token; no provider-data access. |
| `profile` | Display the account's name and username. |
| `offline_access` | Renew delegated tokens when Microsoft policy allows; no additional API permissions. |

## Authorization and saved scope

App roles do not grant provider access. Every provider change requires the
current Admin app role, delegated permission and applicable Microsoft role/license.
Application read grants do not authorize changes. Standard collection starts
automatically after permitted sign-in while visible and online; no app-owned
enable, prior approval or qualification is required.
Viewer, UsageReportUploader and Admin can read shared saved tenant data without
source-read permission. Local Audit read/export is Admin-only; recording is
unchanged. CSV import uses no Microsoft token; downloading original user-level
reports requires Reports Reader or AI Administrator, not Usage Summary Reports
Reader.

Inventory observations are tenant-owned regardless of the collector's token mode;
private hunt and Audit Search results retain their existing actor/sharing scope.
Directory/activity and inventory refreshes preserve unseen saved records and
their original observation dates. Power Platform query type/environment filters
do not create separate datasets. Catalog absence is not authoritative deletion;
verified exact absence still removes the corresponding supported target.
Saved inventory reads require Viewer-capable authority, not source-read permissions.
No earlier per-query approval,
qualification job or retained qualified scope is required.

**Permissions > Check status** performs bounded readiness checks. Some
capabilities verify token acquisition only; that is not proof of a provider query,
license or full data scope. Explicit operations obtain current authorization.
Configuration/role/tenant changes fence in-flight work; stale diagnostics do not
authorize it. Provider denials, throttling and schema errors remain explicit,
not empty success or an automatic fallback to another credential mode.

## Graph package reads and controls

The selected read contract is:

- `GET https://graph.microsoft.com/v1.0/copilot/admin/catalog/packages`
  with exactly `$filter=supportedHosts/any(h:h eq 'Copilot')`;
- detail GET at that path plus one encoded exact opaque package ID;
- no caller origin, headers, selection, expansion or arbitrary query;
- no `$top`; continuation may add only one nonempty `$skiptoken`, preserving
  endpoint/filter. Redirects and equivalent-link loops fail closed.

Duplicate exact identities, unsupported declared resource types and malformed
security fields reject collection. Access principals require user/group type
(case-insensitive validation) and a bounded nonblank control-free identity;
provider ID spelling is retained without imposing directory GUID rules.
Delegated control readback uses the administrator's read/write grant.
Beta mutations remain exact one-shot operations with current prestate/readback;
read support does not imply general write support.

Catalog refresh does not fan out detail requests. Automatic detail work retains
its initiating session and capability generation through claim, dispatch and
publication. Page/row/byte/execution limits remain bounded.

The documented
[`sharedWithUsersAndGroups`](https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/api/admin-settings/package/resources/copilotpackagedetail)
collection is read-only sharing evidence, independent of availability and
installation. Missing is not an empty recipient list. Collections have the
existing 5,000-principal bound and retain exact IDs/types/order. Diagnostics keep
only coverage/counts. Neither recipients nor `availableTo` establish Agent
Builder's maker-controlled organization-wide chat sharing.

## Power Platform fields and identity

Normal inventory collects supported agents and their supporting environments,
not broad flow/connector catalogs. Documented Preview
`properties.sharedWithViewers` and `properties.sharedWithEditors` are saved as
`details.makerSharing.viewers/editors`, separately from Graph admin settings.
`viewers.entireTenant` reports maker-controlled whole-tenant sharing, including
without administrative approval.

Observed harness/title/instruction-length metadata, component/knowledge counts,
distinct-flow counts and flow/trigger array lengths remain tagged `observed`.
The provider's exact lowercase `isWebSearchEnabledForKnowledge` is retained.
No instruction text, unverified flow/trigger item schema or generic raw resource
archive is added. Malformed typed values and duplicate members reject collection.

Graph owner/agent identity metadata and usage counters are separate observed
evidence. Counters have no established report window/exception-rate unit and
never replace imported report metrics.
See [storage/display field mappings](data-architecture.md#maker-controlled-sharing-and-captured-agent-configuration).

Native `properties.entraAgentId` is a candidate until explicit directory
verification. A verified Microsoft `agentIdentity` has equal object/app ID under
its documented contract; this equality must not be generalized to ordinary
service principals, blueprint IDs or package/native IDs.
Only current typed verified mappings supply runtime/object IDs.
Identifiers are never guessed from names or prefixed IDs.
See [Defender identity resolution](defender-agent365-hunting.md#data-sources).

Quarantine uses the documented exact current environment/bot target. Optional
Entra role hints are not a provider grant and their absence is not a standalone
denial. Availability checking does not select a bot or execute/resume/reconcile
a mutation. Existing exact status/write responses are authoritative; optional
[mutation diagnostics](mutation-canaries.md) do not gate normal controls.

Compatible saved package identity details can retain inventory links after
expiry, but cannot renew live control proof. Both fresh and stale detail
annotations require valid timestamps, an observation no later than evaluation,
and an expiry strictly after observation before their identity evidence is used.
Adding a package-derived CDS bot ID
requires fresh catalog and identity-detail observations. When a separate
identity-detail observation is explicitly missing, catalog freshness alone
cannot substitute for it.

## Retained backend investigations

Purview, Defender and investigation-only identity setup are hidden from the
current UI. The permissions below belong only to retained backend contracts;
they are **not** additions to the Permissions page or ordinary deployment setup.
Saved evidence and provider authorization have not been removed or broadened.
These contracts are separate from Agent Control's Admin-only local Audit logs.

| Retained capability | Microsoft permission | Provider requirement |
| --- | --- | --- |
| Agent log identity resolution | Delegated `AgentIdentity.Read.All` | Agent ID Administrator for identities the user does not own. |
| Purview Audit Search | Delegated/application `AuditLogsQuery.Read.All` | Purview Audit enabled and applicable role/entitlement. |
| Defender hunting | Delegated/application `ThreatHunting.Read.All` | Defender RBAC, data-source visibility, connectivity and applicable licensing. |

Purview uses the selected Graph v1.0 query lifecycle, singular `serviceFilter`,
strict direct/collection response shapes and validated continuation URLs.
Ordinary searches are bounded to 168 hours, 20 pages and 5,000 stored records.
Microsoft documentation has conflicting permission/schema examples; the
implemented selected contract is described in the
[Purview runbook](purview-audit-search.md). Provider failure is not worked around
by inventing a second request dialect.

Defender uses
`POST https://graph.microsoft.com/v1.0/security/runHuntingQuery` with code-owned
KQL and matching explicit `Timespan`. No arbitrary KQL or workspace override.
Ordinary hunts cover at most seven days, retain at most 200 rows and cap response
bytes at 2 MB. Exact subject/tenant/time/action validation precedes publication.
User invocations, agent-account tool/inference events and inventory evidence are
different identity semantics. See [Defender](defender-agent365-hunting.md).

Empty results do not prove complete ingestion or safety. Saved reads/exports
are provider-free but still enforce current local owner/configuration/sharing
and expiry. The application cannot learn an external RBAC revocation while
offline; later explicit provider work reports current visibility.

## Reports and source authority

| Capability | Current request | Schema contract |
| --- | --- | --- |
| `reports.copilotUsage.read` | `GET /v1.0/copilot/reports/getMicrosoft365CopilotUsageUserDetail(period='D28',version='v2')` | Required v2 CSV headers are exact; additive columns are ignored |

App activity uses an explicit bounded CSV read of
`/v1.0/copilot/reports/getMicrosoft365CopilotUsageUserDetail(period='D28',version='v2')`.
One signed-download redirect is limited to the allowed HTTPS report origins,
without forwarding the Graph token. Required v2 headers are exact; additive CSV
columns are ignored. Hidden/unmatched/duplicate identities are not guessed.
Any retained observations with a different period/version retain that metadata
and are not relabeled as current-window results.

Only the manually exported Agents, Users & agents and Users CSVs establish
reported agent usage. App activity, Graph telemetry, Audit Search and Defender
do not replace them. Local import validates/atomically retains content and
requires no provider probe. See [usage import](official-usage-import.md) and
[licenses/users](copilot-license-usage.md).

## Transport and privacy

- Retry only safe reads within their existing request/page/row/deadline limits.
  Never automatically replay an uncertain provider mutation.
- Pacing covers actual dispatch, token renewal and durable admission. Graph 429
  establishes shared cooldown independently of body timing; token-service
  throttling does not change Graph-wide pacing.
- Read bodies are byte-bounded and strictly UTF-8 validated. Duplicate JSON
  contract members, including escaped spellings, are rejected. Cancellation
  remains authoritative through parse/publication.
- Received safe HTTP/correlation/Retry-After diagnostics survive timeout where
  observed. Raw provider bodies, tokens and private record contents are not logs.
- Exact authorization and source fences are checked at dispatch and transaction
  publication; replacement authority cannot lend permission to older work.

These are current code contracts. Real tenant consent, provider rollout,
licensing, data-source coverage and live response behavior must be observed
under the actual authorized deployment; this guide records no live result.
