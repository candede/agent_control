# Provider contracts

Developer reference for supported Microsoft requests, data meaning and failure
handling. The [capability registry](../backend/src/services/capabilityRegistry.ts)
defines current capability IDs, modes, requirements and Microsoft source links.

## App registration permissions

Use the [permission and role reference](user-roles-and-permissions.md#app-registration-permissions)
for the grant matrix, consent and role assignments.

| Operation | Provider identity |
| --- | --- |
| Graph package inventory, users, licenses, Office-app activity and user lookup | Application |
| Management group lookup and package changes/readback | Signed-in user's delegated identity |
| Power Platform inventory and quarantine | Signed-in user's delegated identity |
| Retained Purview/Defender investigations | Delegated, or explicitly configured application/shared scope |

MCP/API caller authentication is separate from provider-token mode. A delegated
API caller can request authorized application Graph collection; this is not a
fallback from failed delegated access.

## Authorization and saved scope

- Inventory, directory/license/activity sources and imported reports are
  tenant-owned. Viewer-capable roles can read saved tenant data without provider
  source-read permission.
- Collection starts automatically after sign-in while the app is visible and
  online. Permission checks are diagnostics, not an enablement step.
- Provider changes require current Admin access, delegated provider authorization,
  an exact target, confirmation, prestate and readback.
- Private investigation results and job/control receipts retain their owner and
  configuration scope. App roles do not grant Microsoft access.
- Failed or limited-visibility refreshes preserve saved data. Catalog absence is
  not deletion evidence; verified exact absence may remove a supported target.
- Saved observation age does not grant live identity authority. Writes require
  current, unexpired source authority.
- Tenant, session, capability and configuration changes fence in-flight work.
  Stale diagnostics or a replacement sign-in cannot authorize older operations.

## Graph package reads and controls

| Request | Contract |
| --- | --- |
| `GET /v1.0/copilot/admin/catalog/packages` | Exactly `$filter=supportedHosts/any(h:h eq 'Copilot')` |
| `GET /v1.0/copilot/admin/catalog/packages/{id}` | One encoded exact opaque package ID |
| Beta package block/unblock and access update | Exact delegated operation, current prestate, one-shot dispatch and semantic readback |

Read continuation may add one nonempty `$skiptoken`, preserving the endpoint and
filter. No `$top`, arbitrary query, caller origin or redirected request is accepted.
Package IDs retain case and whitespace significance; directory GUID rules do not
apply to them. Duplicate exact identities, continuation loops and malformed
security fields reject the scan.

Catalog collection streams into durable staging without detail-request fan-out.
Record parsing, batches, storage and execution time are bounded; total tenant
record/page counts are not capped. Exact details use their own response limits.
See [the client](../backend/src/services/graphPackages.ts) and
[collection bounds](../backend/src/db/dataBounds.ts).

`sharedWithUsersAndGroups` is read-only sharing evidence, separate from
availability and installation assignments. Missing does not mean an empty list.
The collection has a 5,000-principal bound; exact IDs, types and order are retained.
Neither it nor `availableTo` proves maker-controlled organization-wide chat sharing.

Mutations are not provider-atomic. The app serializes its own exact-target work
and rechecks provider prestate, but cannot exclude concurrent external changes.
An uncertain sent write is not replayed; explicit reconciliation performs reads
only. Optional mutation diagnostics do not gate ordinary controls.

## Power Platform fields and identity

Inventory uses the delegated Resource Query API and collects supported agents
and supporting environments, not broad flow/connector catalogs. Application and
managed-identity authentication are unsupported by this provider.

| Evidence | Meaning |
| --- | --- |
| `properties.sharedWithViewers` / `properties.sharedWithEditors` | Preview maker-sharing fields, saved separately as `details.makerSharing.viewers/editors` |
| `viewers.entireTenant` | Maker-controlled whole-tenant sharing, not administrative approval |
| Harness/title/instruction-length metadata and component/knowledge/flow counts | Observed provider metadata, not imported usage metrics |
| `properties.entraAgentId` | Identity candidate until explicitly verified against the directory |

No instruction text, generic raw-resource archive or unverified flow/trigger
schema is stored. Malformed typed values and duplicate members reject collection.
See [field mappings](data-architecture.md#maker-controlled-sharing-and-captured-agent-configuration).

A verified Microsoft `agentIdentity` has equal object/app IDs under that specific
contract. Do not generalize this to ordinary service principals, blueprints,
packages or native resource IDs. Names and prefixed IDs are not identity proof.

Quarantine requires the exact environment and Bot ID and uses the current
`copilotstudio` namespace. Role hints are diagnostic, not authorization. Status
and changes have the same provider administrator-role requirement; classic bot
write restrictions remain explicit. See [quarantine requirements](user-roles-and-permissions.md#power-platform--delegated).

Power Platform access checks have a ten-second logical deadline; exact agent
diagnostics have sixty seconds, shortened by an earlier caller deadline.
Cancellation, token renewal, retry waits and final projection stay inside those
budgets.

## Retained backend investigations

These capabilities are hidden from the current UI and are not additions to
ordinary registration/setup. They are separate from local Admin-only Audit logs.

| Capability | Microsoft permission | Provider requirement |
| --- | --- | --- |
| Agent log identity resolution | Delegated `AgentIdentity.Read.All` | Agent ID Administrator for identities the user does not own |
| Purview Audit Search | Delegated/application `AuditLogsQuery.Read.All` | Purview Audit enabled and applicable role/entitlement |
| Defender hunting | Delegated/application `ThreatHunting.Read.All` | Defender RBAC, source visibility, connectivity and applicable licensing |

- **Purview:** selected Graph v1.0 query lifecycle and singular `serviceFilter`;
  ordinary searches are bounded to 168 hours, 20 pages and 5,000 stored records.
  Use the [selected contract](purview-audit-search.md), not an invented request
  dialect when Microsoft examples disagree.
- **Defender:** `POST /v1.0/security/runHuntingQuery` with code-owned KQL and matching
  explicit `Timespan`. Ordinary hunts cover at most seven days, 200 rows and 2 MB.
  No arbitrary KQL or workspace override. See [Defender contracts](defender-agent365-hunting.md).
- **Saved evidence:** provider-free reads still enforce current local ownership,
  sharing, configuration and expiry. Empty results do not prove complete ingestion
  or safety. External RBAC revocation cannot be learned while offline.

## Reports and source authority

| Capability | Current request | Schema contract |
| --- | --- | --- |
| `reports.copilotUsage.read` | `GET /v1.0/copilot/reports/getMicrosoft365CopilotUsageUserDetail(period='D28',version='v2')` | Required v2 CSV headers are exact; additive columns are ignored |

The Office activity source accepts one signed-download redirect to the allowed
HTTPS report origins without forwarding the Graph token. Hidden, unmatched or
duplicate user identities are not guessed. Period/version metadata is preserved;
older or different windows are not relabeled.

Only the manually exported **Agents**, **Users & agents** and **Users** CSVs
establish reported agent usage. Graph app activity, observed inventory counters,
Purview and Defender do not replace them. Import requires no provider probe.
See [CSV import](official-usage-import.md) and [Office adoption](copilot-license-usage.md).

## Transport and privacy

- Retry only safe reads within request/deadline limits. Never replay an uncertain
  provider mutation.
- Validate fixed HTTPS origins, route families and continuation structure before
  attaching credentials. The Office download redirect is an explicit exception.
- Graph throttling establishes shared cooldown; token-service throttling does
  not change Graph-wide pacing.
- Streamed package headers have a thirty-second deadline, separate from body
  idle waits and the overall execution budget. Late responses are disposed.
- Validate UTF-8 and reject duplicate JSON contract members. Bound individual
  records, parsing work, exact-detail bodies and retained storage.
- Preserve safe HTTP/correlation/Retry-After diagnostics. Do not log tokens,
  raw provider bodies or private record contents.
- Recheck captured authorization and source fences at dispatch and publication.
  Cancellation cannot become a successful late result.

Local fixtures verify implementation behavior, not live tenant consent,
licensing, provider rollout, coverage or response compatibility.
