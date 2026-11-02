# Defender and Agent 365 hunting

Agent Control retains a backend for explicit, fixed-template Microsoft Graph
advanced-hunting queries and saved results. Viewer, Usage Report Uploader and
Admin can use it within their authorized data scope.

**Defender views, investigation identity controls and their Permissions entries
are deferred in the current UI.** There is no supported Activity-tab or
Permissions-page click path for this workflow. The instructions below describe
the existing backend API for authenticated integrations, not a shipped UI.
These grants are not prerequisites for normal deployment, sign-in or automatic
inventory synchronization.

Hunting does not collect telemetry continuously, accept arbitrary KQL, reconstruct
conversations or search Purview. Agent Control's local **Audit** reads/exports
remain Admin-only.

## Required Microsoft access

For delegated hunting:

1. In the existing Entra **App registrations > Agent Control > API permissions**,
   add **Microsoft Graph > Delegated permissions > `ThreatHunting.Read.All`**,
   then **Grant admin consent**.
2. Ensure the signed-in user has Defender XDR hunting access to the relevant
   data sources and device groups. Graph consent alone does not grant that
   visibility; check the tenant's [Defender RBAC assignments](https://learn.microsoft.com/en-us/defender-xdr/advanced-hunting-rbac).
3. Confirm Microsoft Defender XDR and the applicable Agent 365 or service
   licensing, Microsoft 365 activity connectivity and queried-table rollout.
   [`AgentsInfo`](https://learn.microsoft.com/en-us/defender-xdr/advanced-hunting-agentsinfo-table)
   is preview; [Agent 365 eligibility](https://learn.microsoft.com/en-us/defender-xdr/security-for-ai/transition-agent-security-to-agent-365)
   does not guarantee every table or event is available.

For agent-scoped identity resolution, also add Graph delegated
`AgentIdentity.Read.All` and grant admin consent. Nonowners need **Agent ID
Administrator** for the target identity. This is separate from ordinary
[inventory permissions](user-roles-and-permissions.md#app-registration-permissions).

Optional application hunting uses Graph **Application** `ThreatHunting.Read.All`,
admin consent and the configured tenant application credentials. Its existing
shared-data setting requires an Agent Control Admin to send
`PUT /api/capabilities/defender.hunting.application/configuration` with
`{"enabled":true,"sharedDataScope":true}`. This allows application-scoped result
sharing; it does not grant Microsoft permissions or apply to delegated hunting
or ordinary inventory collection. There is no UI control for it.

## Resolve log identity

Use the source-qualified `recordId` from current saved agent inventory, not a
package, bot or blueprint ID.

1. Read `GET /api/agent-inventory/investigations/context?recordId=<encoded-recordId>`.
   This reads saved context without contacting Microsoft.
2. If `defender.resolution.canResolve` is true and the mapping is missing or
   expired, send `POST /api/agent-inventory/investigations/resolve` with
   `{"recordId":"<saved-recordId>"}`.
3. Read context again and check the selected entry in `defender.templates`.
   Do not submit a template whose identity is unavailable.

Resolution currently supports a current, unambiguous Copilot Studio source with
`properties.entraAgentId` and its environment. The backend verifies that candidate
with Graph `GET /v1.0/servicePrincipals/{id}/microsoft.graph.agentIdentity`.
The short-lived mapping is bound to the tenant, principal and current inventory
source; expired or changed sources require refreshed inventory and resolution.

Inventory queries use the verified object ID; runtime queries use the verified
application/client ID. For a typed **agentIdentity**, Microsoft documents that
[object ID and app ID are equal](https://learn.microsoft.com/en-us/entra/agent-id/agent-identities#authorizing-agent-identities).
That exception does not apply to ordinary service principals, blueprints,
packages or native inventory IDs.

Agent Builder may have provider telemetry, but this integration has no verified
crosswalk from its saved inventory identifiers. Extra consent or connector setup
does not supply a missing identity mapping. Verified identity also does not prove
that telemetry was ingested.

## Run a hunt

For these examples, use an existing same-origin signed-in browser session.
`GET /api/me` supplies `csrfToken`; include the session cookie and
`X-CSRF-Token` on writes, with `Content-Type: application/json`. Do not send a
Microsoft Graph token directly to these routes.

Read `GET /api/hunting/catalog` for templates and limits. Submit an agent-scoped
hunt to `POST /api/hunting/jobs` with this body, replacing the placeholders:

```json
{
  "tokenMode": "delegated",
  "agentRecordId": "<saved-recordId>",
  "filters": {
    "templateId": "agent_activity",
    "startDateTime": "<recent UTC start ending in Z>",
    "endDateTime": "<later UTC end ending in Z>",
    "operations": ["InvokeAgent", "InferenceCall"]
  }
}
```

The backend derives the agent's identifiers; do not override them. Use a valid
UTC interval no longer than seven days, starting no earlier than 30 days ago.
Use a stable `Idempotency-Key` header when retrying the same submission.
The response is `202` with a durable job; retain its `id`.

For a human-only hunt, omit `agentRecordId`, supply top-level `userObjectId`
with the exact directory user object ID, use `agent_activity` and only
`["InvokeAgent"]`, and include empty `agentIds`, `blueprintIds` and
`actorObjectIds` arrays in `filters`. Include both subject references for a
user-on-agent hunt. Human attribution uses `RawEventData.UserKey`; inference and
tool events identify agent accounts and are not attributed to a human by guess.

Carry the same `agentRecordId` and/or `userObjectId` on subsequent requests
(URL-encoded query parameters are supported):

| Action | Endpoint |
| --- | --- |
| Saved history | `GET /api/hunting/jobs?limit=20&offset=0` |
| Job status | `GET /api/hunting/jobs/:id` |
| Saved rows | `GET /api/hunting/jobs/:id/rows?limit=100&offset=0` |
| Entire bounded saved result | `GET /api/hunting/jobs/:id/export.csv` |
| Resume after restoring authorization | `POST /api/hunting/jobs/:id/resume` |
| Cancel accepted work | `POST /api/hunting/jobs/:id/cancel` |
| Delete local job/results | `DELETE /api/hunting/jobs/:id` with `{"confirmation":"<job-id>"}` |

Poll an existing job; polling is not a recurring hunt. For
`waiting_authorization`, resolve any reported sign-in/authorization problem,
then explicitly resume. Closing the browser does not cancel accepted work.
Cancel a running job before deleting it; deletion does not change Microsoft data.

Delegated results are principal-private. Application results are shared only
within the current configured application scope/revision. Only the authorizing
principal can resume, cancel or delete a job, even when another Viewer or Admin
can read/export its shared result. Saved reads do not acquire a provider token;
they enforce current local roles and scope, but cannot detect external Defender
RBAC revocation while offline.

## Fixed templates and projection v3

| Template | Source | Supported operations |
| --- | --- | --- |
| `agents_inventory` | `AgentsInfo` | Inventory observations; `operations: []` |
| `agent_activity` | `CloudAppEvents` | `InvokeAgent`, `InferenceCall` |
| `agent_tools` | `CloudAppEvents` | `ExecuteToolBySDK`, `ExecuteToolByGateway`, `ExecuteToolByMCPServer` |

Inventory results include exact identifiers, observation time, platform, model,
publication/lifecycle metadata and counts of owner/sharing/permission/
authentication structures. They do not retain those structures or identify an
owner from a count. Detail states mean:

- `not_supplied`: no provider value;
- `empty`: an empty value or structure;
- `present_unqualified_shape`: only a count is retained; nested meaning is unknown;
- `not_exposed`: the contract does not expose the detail.

Inventory risk is always `not_exposed`; no risk score is inferred.

Activity/tool results retain selected identity, operation, span, timing, tool and
error metadata—not prompts, responses, tool arguments/results or token counts.
Action-specific field states distinguish `value`, provider `null`, an `empty`
string and `unavailable` for that operation. Missing errors do not prove success;
the outcome is `error` or `unknown`. A root span does not prove complete coverage,
and child-only spans do not establish a root.

Purview audit operations such as `AIInvokeAgent` and `AIExecuteTool` are separate
from Defender `ActionType` values. Hunting does not populate Purview records.
Portal searches and enabling auditing do not populate Agent Control's saved
audit records; agent-scoped saved Purview reads require an exact Studio BotId
and environment association. For provider ingestion status, use Microsoft's
[Exchange Online audit check](https://learn.microsoft.com/en-us/purview/audit-log-enable-disable),
not an empty portal search or an absent enablement banner.

## Selected provider contract

The backend calls global Graph
`POST https://graph.microsoft.com/v1.0/security/runHuntingQuery` with
`{"Query":"<code-owned KQL>","Timespan":"<UTC start>/<UTC end>"}` and expects a
`200` response with exact `schema` and `results` arrays. Both KQL and `Timespan`
bound the interval. Projection v3 validates selected fields, tenant, operations,
identities and timestamps before saving; malformed or out-of-scope responses
are not empty successes.

No `workspaceId` is accepted or sent. Graph selects the scope; this is not
requested-workspace isolation. See the [Graph operation](https://learn.microsoft.com/en-us/graph/api/security-security-runhuntingquery?view=graph-rest-1.0).
Each query permits at most three safe transport/429/5xx attempts within 30 seconds.
Responses are capped at 2,000,000 bytes. Queries request at most 201 rows and
retain 200; local jobs/results expire after 30 days. Run the
[retention workflow](operations.md#run-retention) to remove expired data.
These are application limits, not provider quotas or retention guarantees.

## Read results and troubleshoot

| Result/problem | Meaning or next check |
| --- | --- |
| `succeeded` with `noData: true` | No matching rows were returned for that query and scope. Check interval, identity, ingestion, connectivity and table rollout; this proves neither safety nor complete coverage. |
| `partial` / `hunting_row_limit` | The 201st row proved truncation. Only 200 are saved; the requested interval remains unobserved, not a complete total. Narrow the interval. |
| `inconclusive` | Provider, schema, scope or response-size failure prevented a trustworthy result. Inspect the sanitized code and request correlation; do not read this as zero activity. |
| Later hunt fails | An earlier same-scope successful snapshot may remain available through `priorSuccessfulJobId`; check its age and requested range. |
| Identity unavailable | Check context's reason, current inventory/environment, `AgentIdentity.Read.All`, consent and target access. Unsupported crosswalks cannot be repaired by substituting IDs. |
| Provider `401`/`403` | Check Graph grant/consent, Defender RBAC/data scope and provider diagnostics. Denial alone does not identify a missing role or license. |
| Cannot find Defender in the UI | Expected: entry points are deferred. Permissions **Check status** is not a hunt or proof of ingestion. |

Keep requested, observed and unobserved ranges distinct. CSV contains the whole
bounded saved result, not a page-local filter or a tenant-wide activity total.
