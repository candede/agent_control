# Microsoft Purview Audit Search

Agent Control retains a backend for explicit, bounded Purview searches and saved
results. Viewer, Usage Report Uploader and Admin can use it within their authorized
data scope.

**Purview views, investigation controls and their Permissions entries are
deferred in the current UI.** There is no supported Activity-tab or
Permissions-page click path. This guide is for administrators preparing Microsoft
access and developers using the existing authenticated backend API.
These grants are not prerequisites for normal deployment, sign-in or automatic
inventory synchronization; no Purview search starts just by opening saved data.

Purview events are investigation evidence, not official Copilot usage totals.
Agent Control's separate local **Audit** history and its read/export endpoints
remain Admin-only.

## Required Microsoft access

For delegated searches:

1. In the existing Entra **App registrations > Agent Control > API permissions**,
   add **Microsoft Graph > Delegated permissions > `AuditLogsQuery.Read.All`**,
   then **Grant admin consent**.
2. Give the signed-in user Purview **View-Only Audit Logs** or **Audit Logs**
   access. The Purview **Audit Reader** and **Audit Manager** role groups provide
   these respectively. Graph consent alone does not grant this access; Entra
   Security Reader is not an additional requirement of this backend.
3. Confirm tenant auditing is enabled and the chosen workload has the required
   license, billing setup and audit coverage. The Graph Audit Search API is
   documented for Audit Standard and Premium; Premium is not a blanket
   prerequisite. Check the tenant's exact Copilot/Copilot Studio entitlement,
   source retention and event availability using the Microsoft references below.

Optional application searches require Graph **Application**
`AuditLogsQuery.Read.All`, admin consent and the configured tenant application
credentials. An Agent Control Admin configures shared application results with
`PUT /api/capabilities/purview.audit.search.application/configuration` and
`{"enabled":true,"sharedDataScope":true}`. This existing data-sharing setting
does not grant Microsoft permissions, apply to delegated searches or gate normal
inventory collection. There is no UI control for it and no prior approval query.

This adapter uses global-cloud Graph v1.0 and work/school tenant accounts, not
personal Microsoft accounts or national-cloud endpoints. Normal inventory
permissions are listed [separately](user-roles-and-permissions.md#app-registration-permissions).

## Select a subject

Read `GET /api/audit-search/catalog` for current presets, operations and limits:

| Preset | Service / record type | Operations |
| --- | --- | --- |
| `copilot_interactions` | `Copilot` / `copilotInteraction` | `CopilotInteraction` |
| `copilot_studio_admin` | `PowerPlatform` / `powerPlatformAdministratorActivity` | Catalog allowlist for bot, component, plugin and environment-variable administration |

For a human search, supply the actor's exact directory UPN in
`filters.userPrincipalNames`, not a display name or an arbitrary mention of the
person. The API validates UPN syntax; it does not resolve report labels or prove
that a supplied UPN exists.

For an agent search:

1. Obtain the source-qualified `recordId` from current saved agent inventory and
   read `GET /api/agent-inventory/investigations/context?recordId=<encoded-recordId>`.
   This is a saved-data read, not a Microsoft query.
2. Check `purview.status` and `purview.presets`. Studio administration needs an
   unambiguous current saved Copilot Studio bot and environment. Interactions
   additionally need a verified application ID. If resolution is available,
   follow [log identity resolution](defender-agent365-hunting.md#resolve-log-identity):
   grant delegated `AgentIdentity.Read.All` with admin consent, then explicitly
   `POST /api/agent-inventory/investigations/resolve` with
   `{"recordId":"<saved-recordId>"}`. Nonowners need Agent ID Administrator.
   Read context again; do not submit an unavailable preset.
3. Add top-level `agentRecordId` to the search request. The server derives the
   identities; do not supply `filters.agent`, bot IDs or application IDs yourself.
   Include the UPN filter as well for a user-on-agent search.

The server uses the bot ID as a provider keyword for Studio administration, or
the verified application ID for interactions. It then retains only exact `BotId`
matches (rejecting a conflicting reported environment) or
`AppIdentity = Copilot.Studio.<applicationId>` matches, respectively. A keyword
hit alone is not an association. Bot IDs are not `objectIdFilters`; `AgentId`
suffixes, package IDs and blueprints are not substitute identities. Agent Builder
may emit logs, but this integration has no verified saved-inventory crosswalk.

## Run a search

Use an existing same-origin signed-in browser session. `GET /api/me` supplies
`csrfToken`; include the session cookie and `X-CSRF-Token` on writes, with
`Content-Type: application/json`. Do not send a Microsoft Graph token directly
to these routes.

Send `POST /api/audit-search/jobs` with this body, replacing the placeholders:

```json
{
  "tokenMode": "delegated",
  "filters": {
    "presetId": "copilot_interactions",
    "operations": ["CopilotInteraction"],
    "startDateTime": "<recent UTC start ending in Z>",
    "endDateTime": "<later UTC end ending in Z>",
    "userPrincipalNames": ["person@example.invalid"],
    "ipAddresses": [],
    "objectIds": [],
    "administrativeUnitIds": []
  }
}
```

Choose a nonempty subset of the preset's operations and an exact UTC interval
within the last seven days, ending no later than now. Optional identity-filter
arrays accept at most 20 unique values each: UPNs, valid IP addresses, object IDs
or administrative-unit UUIDs. Empty arrays leave those filters unset.
Use a stable `Idempotency-Key` header when retrying the same submission
(1–128 letters, digits, underscores or hyphens). The response is `202` with a
durable job; retain its `id`. A different explicit search needs a new key.

The server creates Graph `/v1.0/security/auditLog/queries`, polls that query and
reads `/records`. Create sends singular `serviceFilter` and receives a `201`
direct query object; status reads expect a `200` direct object, records a `200`
collection. `keywordFilter` is server-derived only for agent searches, not
caller-supplied JSON. A token-readiness check is not proof of this lifecycle and
is not a prerequisite to submitting it.

| Action | Endpoint |
| --- | --- |
| Saved history | `GET /api/audit-search/jobs?limit=20&offset=0` |
| Job status | `GET /api/audit-search/jobs/:id` |
| Saved records | `GET /api/audit-search/jobs/:id/records?limit=100&offset=0` |
| Bounded saved CSV | `GET /api/audit-search/jobs/:id/export.csv` |
| Explicit resume | `POST /api/audit-search/jobs/:id/resume` |
| Cancel local work | `POST /api/audit-search/jobs/:id/cancel` |
| Delete local job/results | `DELETE /api/audit-search/jobs/:id` with `{"confirmation":"<job-id>"}` |

Poll the saved job, not a fresh submission. `running`/`reconciling_create` means
work is pending. For `waiting_authorization`, read its diagnostic and, when
`canResume` is true, explicitly resume after restoring any required sign-in.
This state can also mean the bounded activation paused, not missing consent.
An uncertain create is reconciled, never blindly repeated as another POST.

Closing the browser does not cancel accepted work. Cancel stops local
polling/download; inspect `remoteWorkMayContinue` because the selected Graph
contract has no remote cancel/delete operation. Cancel an active job before local
deletion. Neither action removes Microsoft events.

Delegated results are principal-private; application results are shared only
within the current configured application scope/revision. Only the authorizing
principal can resume, cancel or delete, even when another Viewer or Admin can
read/export shared results. Saved reads acquire no provider token: local roles
and scope are checked, but offline reads cannot detect external Purview role
revocation.

## Read results correctly

- `succeeded` means this bounded lifecycle completed; `partial` means saved
  evidence is incomplete. Inspect `pageComplete`, `errorCode` and the provider
  status rather than treating downloaded rows as full coverage. `failed`,
  `inconclusive` and `cancelled` do not establish an empty successful result.
- `providerRowCount` counts processed provider rows before deduplication and exact
  agent filtering; `storedRowCount` counts retained rows. Native event IDs and
  Graph wrapper IDs are distinct. Deduplication is within one result, not across
  searches; summing overlapping searches can double-count events.
- `observedRange` is the minimum/maximum retained event time, not proof of
  continuous coverage. For partial results, `unobservedRange` conservatively
  marks the requested range, not a precisely identified missing interval.
- Retained projection v1 includes selected actor, operation, time, target,
  correlation and message-reference metadata when supplied. Missing identifiers
  stay missing; unknown fields are counted, not exposed as arbitrary content.
  Prompt text, response text and transcripts are not stored or exported.
- CSV is available only for locally published `succeeded` or `partial` jobs;
  other states return `409 audit_job_state`. It includes provenance/coverage and
  neutralizes spreadsheet formulas. Reads/exports append content-free local
  Audit receipts, not copies of provider records.

## Limits and retention

These are **Agent Control limits**, not Microsoft quotas:

| Boundary | Limit |
| --- | --- |
| Search age and window | Most recent 7 days; at most 168 hours |
| Collection | 20 pages, 5,000 provider rows before dedup/filtering, 8,000,000 aggregate response bytes |
| Execution | 6 status polls per activation; 12 activations and 64 provider requests per job; 48-hour deadline |
| Saved record paging | Default 100; maximum 500 per request |
| Local cache | 30 days; expired data is unavailable and subject to operator retention cleanup |

Row/page/byte limits and provider count-limit flags can produce partial results;
split a crowded interval into smaller explicit searches. Microsoft source
retention, query lifetime, ingestion delay, licensing, throttling and workload
coverage remain separate. A successful empty query does not prove event emission,
all-workload entitlement or absence of activity.

## Verify and troubleshoot

Verify a recent known audited operation using the correct subject and preset.
Observe the saved job through completion, then inspect its records, counts,
coverage and CSV. Compare the event identity/time/operation with the expected
activity; token readiness or an empty success is insufficient proof of coverage.

| Symptom | Next check |
| --- | --- |
| No Purview UI | Expected: use the backend workflow above, not Activity or Permissions clicks. |
| Interaction/MFA required | Complete normal sign-in/Conditional Access, then resume if allowed. |
| `provider_denied` (401/403) | Check the exact Graph grant/consent, delegated Purview role and tenant auditing/entitlement. This response does not identify which prerequisite failed; do not add unrelated `ThreatIntelligence.Read.All`. |
| No records | Check actual actor UPN, UTC interval, preset, source retention, ingestion and event emission. |
| Partial/throttled | Read `errorCode`, counts and Retry-After; wait or narrow the interval without broadening permissions. |
| Agent unavailable/changed | Refresh saved inventory/context and resolve a supported identity; never substitute a guessed ID. |
| Saved job missing | Check authorizing account, current shared-scope revision, deletion and 30-day expiry. |

## References

- Implementation: [routes/catalog](../backend/src/routes/purviewAudit.ts),
  [filters/provider adapter](../backend/src/services/graphAuditSearch.ts),
  [job lifecycle](../backend/src/services/purviewAudit.ts),
  [identity eligibility](../backend/src/services/agentInvestigations.ts).
- Microsoft Graph: [create query](https://learn.microsoft.com/en-us/graph/api/security-auditcoreroot-post-auditlogqueries?view=graph-rest-1.0),
  [get query](https://learn.microsoft.com/en-us/graph/api/security-auditlogquery-get?view=graph-rest-1.0),
  [list records](https://learn.microsoft.com/en-us/graph/api/security-auditlogquery-list-records?view=graph-rest-1.0).
- Microsoft Purview: [start auditing and assign roles](https://learn.microsoft.com/en-us/purview/audit-get-started),
  [Standard/Premium comparison](https://learn.microsoft.com/en-us/purview/audit-solutions-overview),
  [retention policies](https://learn.microsoft.com/en-us/purview/audit-log-retention-policies),
  [Copilot audit fields](https://learn.microsoft.com/en-us/purview/audit-copilot),
  [Studio administrative events](https://learn.microsoft.com/en-us/microsoft-copilot-studio/admin-logging-copilot-studio).
