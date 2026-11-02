# Provider contracts

Supported Microsoft endpoints, token modes, evidence and limits.
See the [capability registry](../backend/src/services/capabilityRegistry.ts) for IDs
and Microsoft sources; [permissions](user-roles-and-permissions.md#app-registration-permissions)
for grants and roles.

## Identity and saved scope

| Operation | Provider identity |
| --- | --- |
| Graph package inventory, users, licenses, Office-app activity and user lookup | Application |
| Management group lookup; package changes and control readback | Delegated |
| Power Platform inventory and quarantine | Delegated |
| Purview/Defender investigations | Delegated, or explicitly configured application/shared scope |

- Initial read-only sync starts automatically after sign-in while visible and
  online; no diagnostic approval or mutation canary is required.
- Saved inventory, directory/license/activity data and imports are tenant-shared.
  Viewer-capable roles need no provider permission to read them.
  Investigation results and job/control receipts retain their own scopes.
- Provider changes need Admin, delegated provider authorization, exact confirmed targets,
  current source authority, prestate and readback—not old observations or diagnostics.
- Failed/limited-visibility refreshes preserve saved data. Catalog absence is not
  deletion; verified exact absence may remove a supported target.

API/MCP caller authentication is independent of provider mode. Delegated callers
can request authorized application Graph collection; failed delegated access never
triggers application fallback. App roles do not grant Microsoft permissions.

## Graph package reads and controls

Origin: `https://graph.microsoft.com`.

| Request | Contract |
| --- | --- |
| `GET /v1.0/copilot/admin/catalog/packages` | Exactly `$filter=supportedHosts/any(h:h eq 'Copilot')` |
| `GET /v1.0/copilot/admin/catalog/packages/{id}` | Inventory/detail or control readback, using the modes above |
| `POST /beta/copilot/admin/catalog/packages/{id}/block` or `/unblock` | Block/unblock |
| `PATCH /beta/copilot/admin/catalog/packages/{id}` | Availability/installation assignments |

- Opaque package IDs preserve case/whitespace; encode one exact path segment.
- Continuation keeps the endpoint/filter and adds one nonempty `$skiptoken`;
  no `$top`, arbitrary query, foreign origin or redirect. Duplicate identities,
  continuation loops and malformed security fields fail collection.
- `sharedWithUsersAndGroups` is read-only sharing, not availability/installation.
  Missing is not empty; exact IDs, types and order are retained, up to 5,000
  principals. Neither it nor `availableTo` proves maker-controlled whole-tenant sharing.
- Access writes support specific users/groups or none; “All users” has no documented
  supported payload. Untouched access must be preservable. Reassignment is not
  implemented: package detail has no owner readback.
- Writes are not provider-atomic. External changes can race prestate/readback;
  never replay an uncertain sent write. Reconciliation reads only.

[Client limits](../backend/src/services/graphPackages.ts) bound records, requests
and execution, not total tenant records/pages.

## Power Platform fields and identity

Origin: `https://api.powerplatform.com`. Inventory is delegated-only; no
application/service-principal or managed-identity flow.

| Request | Purpose |
| --- | --- |
| `POST /resourcequery/resources/query?api-version=2024-10-01` | Supported agents and supporting environments, not broad flow/connector catalogs |
| `GET /copilotstudio/environments/{environmentId}/bots/{botId}/api/botQuarantine?api-version=1` | Exact quarantine status |
| `POST /copilotstudio/environments/{environmentId}/bots/{botId}/api/botQuarantine/{action}?api-version=1` | `SetAsQuarantined` or `SetAsUnquarantined` |

| Evidence | Meaning |
| --- | --- |
| `properties.sharedWithViewers` / `properties.sharedWithEditors` | Preview maker sharing, saved as `details.makerSharing.viewers/editors` |
| `viewers.entireTenant` | Maker-controlled whole-tenant sharing, not administrative approval |
| Harness/title/instruction-length metadata; component/knowledge/flow counts | Observed metadata, not reported usage |
| `properties.entraAgentId` | Candidate until verified by the typed Graph `agentIdentity` lookup |

No instruction text, raw-resource archive or unverified flow/trigger schema is
stored. Invalid typed observations or duplicate contract members fail collection.
[Field mappings](data-architecture.md#maker-sharing-and-configuration).

Verified `agentIdentity` object/app IDs are equal; do not infer equality for other
identities or match by names/prefixes. Quarantine requires exact environment/Bot
IDs; classic bots are unsupported. Status and writes require the same
[provider administrator role](user-roles-and-permissions.md#power-platform--delegated);
role hints are not authorization.

## Retained backend investigations

Hidden from the UI; separate from local Admin-only Audit logs and ordinary setup.

| Source | Microsoft permission | Request / provider requirement |
| --- | --- | --- |
| Agent identity | Delegated `AgentIdentity.Read.All` | `GET /v1.0/servicePrincipals/{id}/microsoft.graph.agentIdentity?$select=id,servicePrincipalType`; Agent ID Administrator for nonowned identities |
| Purview Audit Search | Delegated/application `AuditLogsQuery.Read.All` | `/v1.0/security/auditLog/queries`: create, poll and records; Audit enabled and applicable role/entitlement |
| Defender hunting | Delegated/application `ThreatHunting.Read.All` | `POST /v1.0/security/runHuntingQuery`; Defender RBAC, source visibility, connectivity and licensing |

- **Purview app limits:** 168 hours, 20 record pages, 5,000 stored records.
  Singular `serviceFilter`; see [Purview contract](purview-audit-search.md).
- **Defender app limits:** seven days, 200 stored rows, 2 MB responses.
  Fixed KQL and matching `Timespan`; no arbitrary KQL/workspace override.
  See [Defender contracts](defender-agent365-hunting.md).
- Delegated results are principal-private; application results need the current
  configured shared scope. Saved reads enforce ownership, configuration and expiry,
  not offline detection of external RBAC revocation. Empty is not complete coverage.

## Reports and source authority

| Capability | Current request | Schema contract |
| --- | --- | --- |
| `reports.copilotUsage.read` | `GET /v1.0/copilot/reports/getMicrosoft365CopilotUsageUserDetail(period='D28',version='v2')` | Required v2 CSV headers are exact; additive columns are ignored |

One signed-download redirect to `https://reports.office.com` or
`https://reportsweu.office.com` is allowed, without the Graph token.
Hidden/unmatched/duplicate identities are not guessed; period/version is preserved.

Only the manually exported **Agents**, **Users & agents** and **Users** CSVs
establish reported agent usage—not Graph app activity, inventory counters, Purview
or Defender. Import requires no provider probe.
See [CSV import](official-usage-import.md) and [Office adoption](copilot-license-usage.md).

## Transport and privacy

- Validate fixed HTTPS origins/routes/continuation before attaching credentials;
  only Office downloads allow a token-free redirect. Retry safe reads within deadlines.
- Reject invalid UTF-8 and duplicate JSON contract members. Recheck authorization
  at dispatch/publication; cancelled or superseded work cannot publish.
- Diagnostics may retain safe HTTP/correlation/Retry-After data, never tokens,
  raw bodies or private records.

Local fixtures do not establish live consent, licensing, provider rollout,
coverage or response compatibility.
