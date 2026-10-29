# Provider contracts and requirements

Provider availability and authorization are checked when an operation runs.
The [capability registry](../backend/src/services/capabilityRegistry.ts) is the
current capability-ID and Microsoft source-reference inventory. Local fixtures
establish implementation behavior, not live consent, licensing or data visibility.

## Permissions and scope

| Feature | API/mode | Permission | Additional requirement |
| --- | --- | --- | --- |
| Package inventory | Graph delegated/application | `CopilotPackages.Read.All` | Agent 365 licensing; configured shared scope for application mode |
| Package access/block/unblock | Graph delegated | `CopilotPackages.ReadWrite.All` | Agent Control Admin and Agent 365 licensing |
| User/group lookup | Graph delegated | `User.ReadBasic.All`, `Group.Read.All` | Authorized directory visibility |
| User/license sync | Graph delegated | `User.Read.All`, `LicenseAssignment.Read.All` | Directory Readers or Global Reader |
| Copilot app activity | Graph delegated | `Reports.Read.All` | Supported reporting role and report privacy settings |
| Agent identity resolution | Graph delegated | `AgentIdentity.Read.All` | Agent ID Administrator for nonowners |
| Power Platform inventory | Power Platform delegated | `ResourceQuery.Resources.Read` | Supported Power Platform/AI administrator or reader role |
| Studio quarantine | Power Platform delegated | `CopilotStudio.AdminActions.Invoke` | Agent Control Admin for changes; supported current target |
| Purview Audit Search | Graph delegated/application | `AuditLogsQuery.Read.All` | Purview Audit enabled and applicable role/entitlement |
| Defender hunting | Graph delegated/application | `ThreatHunting.Read.All` | Defender RBAC/data-source visibility, connectivity and applicable licensing |
| Official report import | Local | No Microsoft token | Admin import of supported CSVs |

App roles do not grant provider access. Application mode requires configured
tenant/client credentials, enabled application access and configured shared
scope. Viewer/Admin may submit ordinary authorized shared reads directly.
Delegated observations stay principal-private. No earlier per-query approval,
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
Delegated read accepts the documented read grant or accepted read/write grant.
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

## Purview and Defender

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
