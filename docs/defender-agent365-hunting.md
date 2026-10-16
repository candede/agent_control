# Defender and Agent 365 hunting

Agent Control runs explicit, curated Microsoft Graph advanced-hunting queries for
the selected agent, user, or user on an agent. It does not expose arbitrary KQL
or collect telemetry.

## Where to use it

Open **Agents > agent details > Activity**, **Users > user details > Logs**, or
select a user name in an agent's **Users** tab. Select Defender from the source
selector. Purview searches remain separate from Defender runtime, tool, and
inventory evidence.

Opening Activity does not run a hunt.

## Requirements

- Microsoft Graph delegated `ThreatHunting.Read.All`
- Tenant-wide admin consent
- Defender access to the queried data and device groups
- Entra **Security Reader**, or equivalent Defender Unified RBAC access
- `AgentControl.Viewer` or `AgentControl.Admin`

Resolving a Copilot Studio agent's Entra identity also requires delegated
`AgentIdentity.Read.All`. A user who does not own that identity needs
**Agent ID Administrator**.

See [Microsoft roles](user-roles-and-permissions.md).

## Data sources

Purview's [Agent 365 audit operations](https://learn.microsoft.com/en-us/purview/audit-log-activities#agent-365-activities) use names such as `AIInvokeAgent`, `AIExecuteTool`, and `AIInferenceCall`, distinct from Defender actions. The current saved Copilot audit projection is not relabeled as a complete Agent 365 audit collector. Optional Copilot Studio `BotId` fields are matched exactly with the environment; prefixed Copilot interaction IDs are not parsed into guessed bot identities.

Saved ResourceQuery `properties.entraAgentId` is a **candidate**, not an automatically trusted crosswalk. **Resolve log identity** explicitly verifies that candidate through `GET /v1.0/servicePrincipals/{id}/microsoft.graph.agentIdentity`, using delegated `AgentIdentity.Read.All`. An administrator must add this permission and grant tenant consent in the existing app registration before use; it is not an in-app enable/consent action. Opening the modal does not make that provider request. The lookup validates the returned object ID and agent-identity type, then saves short-lived, tenant/principal/source-bound evidence. Current source visibility and identity are rechecked before publication and on subsequent use. Persistence requires the exact current development schema; no old-schema conversion runs during identity resolution.

Identity resolution pins its initiating session and capability generation before any saved-source read or token acquisition. Session, capability and provider admission are rechecked after awaited source and authorization reads, synchronously before each physical Graph attempt and database COMMIT, and through the final saved-context read and operation-evidence recording. Replacement capability authority cannot resume an earlier lookup, and authority changes take precedence over provider failures rather than being saved as lookup outcomes. The final saved-context read runs after operation-evidence recording, so source changes or mapping expiry during that wait cannot return obsolete verified IDs. The 25-second resolution budget and client cancellation bound dependency waits as well as Graph requests; late reads cannot publish an identity mapping, and in-flight database writes retain account serialization until their publication fences and transaction cleanup finish. While identity refresh is pending, the modal hides the previous Defender scope. It reloads saved context after both successful and failed lookups, so a persisted denial or missing identity replaces the old verified state before hunts are available again. Resolution controls reject invalidated or replaced saved context even before its observer rerenders.

Each typed Graph attempt has an 8-second deadline covering headers and body consumption, including transports that ignore abort. Attempt admission and retry waits are also raced against caller cancellation and the overall resolution deadline; late hook settlements are observed without dispatching another request, and current authority is checked on both successful and rejected waits. Late response bodies are cancelled and late transport rejections are observed; headers received under changed authority are cancelled before body consumption. A stalled error body preserves the observed HTTP status and `Retry-After`: denials and not-found results retain their saved outcome and safe request diagnostics, while transient HTTP failures permit at most one freshly admitted retry with a wait of no more than 2 seconds. Successful-body timeouts and transport failures report sanitized provider errors, not a whole-resolution timeout or an internal error. Caller cancellation remains authoritative through the final body read. Failed lookups cannot overwrite a fresh exact-source success published after refresh invalidation, and errors after successful verification or ambiguous publication cleanup are not persisted as provider lookup failures.

Saved investigation context rechecks the unified inventory revision after reading identity candidates and cached directory evidence. The revision includes the current canonical inventory root, not only the selected agent's row, so a delta introducing a competing identity in another environment also invalidates the read. A source that changes or expires during these reads fails with `agent_identity_source_changed`, including saved Purview associations. Expired or unresolved mappings return no verified IDs.

Identity-resolution source bindings require a nonzero internal inventory snapshot UUID. An all-zero snapshot yields `stale_source` in saved investigation context and `invalid_agent_identity_source` before identity-cache reads, invalidation or publication. This local invariant does not restrict Microsoft Graph directory GUID version or variant bits.

There is an important documented exception to the ordinary service-principal namespace rule: for a verified **agentIdentity**, Microsoft explicitly states that its [object ID and app ID always have the same value](https://learn.microsoft.com/en-us/entra/agent-id/agent-identities#authorizing-agent-identities). The [Agent 365 authentication recipes](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/direct-open-telemetry-integration#s2s-blueprint-derived-agent-identity) identify the final resource token's `appid`/`azp` as that child agent's app ID, and the [observability identity binding](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/observability-concepts#agent-identity-is-bound-to-the-url) binds it to `gen_ai.agent.id`. Consequently, a verified agentIdentity enables both the object-ID-based inventory template and the client-ID-based runtime templates without a separately returned `appId`. This equality must **not** be generalized to ordinary service principals, blueprint IDs, native inventory IDs, or package IDs.

Only the current typed verified mapping supplies runtime and object identifiers.
Directory verification establishes a supported query identity, not proof of
ingestion or activity. The modal honors each template's availability independently.

Agent Builder can emit telemetry without Entra application IDs. `AgentsInfo` has provider-native `AgentId`, `Platform`, and `SourceAgentId`; runtime telemetry has operation-specific platform-ID/type fields. However, the reviewed public contracts do not establish a universal conversion from ResourceQuery/package IDs to those fields. This integration therefore labels unsupported crosswalks explicitly rather than claiming Agent Builder has no logs or that connector setup will repair an absent mapping. Purview similarly remains **saved-only** and requires a verified Studio BotId plus environment; turning on auditing does not collect records into this app or establish that association.

### Purview status and enablement

**Open Audit Search** points to `https://purview.microsoft.com/audit/auditsearch`. This is the search experience, not a permanent auditing-settings switch. A conditional **Start recording user and admin activity** banner can enable auditing. An absent banner or an empty search history is not a definitive ingestion-status check.

The expanded Permissions setup uses the [documented Exchange Online check](https://learn.microsoft.com/en-us/purview/audit-log-enable-disable):

```powershell
Connect-ExchangeOnline
Get-AdminAuditLogConfig | Format-List UnifiedAuditLogIngestionEnabled
```

Use the [Exchange Online PowerShell module/session](https://learn.microsoft.com/en-us/powershell/exchange/connect-to-exchange-online-powershell), **not Security & Compliance PowerShell**, which can report False even when auditing is enabled. True means enabled; False means disabled; a failed command leaves status unknown. Only when disabled, an authorized Exchange Online Audit Logs administrator can enable it:

```powershell
Set-AdminAuditLogConfig -UnifiedAuditLogIngestionEnabled $true
```

Allow up to 60 minutes and recheck; searchable events can take several additional hours. Portal searches do not populate the app's saved audit records.

Agent-scoped submissions send only template, operations and time range plus the saved agent reference. The backend derives provider identities itself; identity overrides are rejected. All reads, lifecycle operations and exports carry the saved agent reference, with current principal/role/configuration checks retained.

### Access, limits and acceptance

Agent 365 commercial availability does not make every agent-security table or feature generally available. Check [Agent 365 eligibility](https://learn.microsoft.com/en-us/defender-xdr/security-for-ai/transition-agent-security-to-agent-365), Defender roles/data-source scope, Microsoft 365 connectivity and tenant rollout. Graph hunting requires `ThreatHunting.Read.All`; audit search permissions and licensing are separate. A successful empty result proves neither ingestion completeness nor agent safety.

The app's local limits remain seven days per ordinary hunt, 200 retained rows, 2 MB per response and 30-day local retention. These are application limits, not Graph service quotas or a promise of provider retention. Native Defender data normally covers 30 days; Purview retention depends on workload, actor type, licensing and policy. Page-local metadata filtering is labelled as such; exported CSV contains the entire bounded saved result, not just the displayed page/filter.

Production acceptance should use one known agent with source-verified identities, one known invocation/tool event and one known saved audit record. Verify exact identity scope, delegated/private and approved shared access, missing-identity and denied-source states, bounded/no-data/partial results, record paging, CSV, role changes, and navigation between agents. Local fixtures and anonymous backend health checks do not prove tenant licensing, ingestion, Microsoft response schemas or production browser behavior.

## Selected provider contract

The selected global contract is exactly:

- `POST https://graph.microsoft.com/v1.0/security/runHuntingQuery`
- delegated or application `ThreatHunting.Read.All`
- request body `{ "Query": "<code-owned KQL>", "Timespan": "<UTC start>/<UTC end>" }`
- `200` response with exact `schema` and `results` arrays

The [Graph operation](https://learn.microsoft.com/en-us/graph/api/security-security-runhuntingquery?view=graph-rest-1.0) documents optional `workspaceId` behavior, including fallback to a primary workspace. Agent Control does not accept or send `workspaceId`. It labels only the Graph-selected Defender result scope and never promises requested-workspace isolation.

Every query has both an explicit KQL `Timestamp between (...)` predicate and the same bounded Graph `Timespan`. UTC values have a trailing `Z`. Request bounds must be real calendar instants with hours `00`–`23`; impossible dates and next-day `24:00:00` normalization are rejected. Whole seconds and one to three fractional digits are accepted and normalized to milliseconds. The adapter binds returned rows to the requested source table, tenant, operation, exact identity filters, and time range before publication. Exact identifiers are never truncated; only bounded descriptive strings may be shortened.

The adapter permits at most three safe transport/429/5xx attempts within one
30-second request budget. Admission/response hooks, body reads, retries and
non-cooperative transports remain bounded by cancellation and that deadline.
Initiating authority is checked after successful/rejected waits, before physical
dispatch and before publication. Changed authority takes precedence over provider
failure; local bookkeeping failures are not retried as transport errors.
Late responses are disposed without delaying completion, and already observed
safe HTTP diagnostics survive later timeout. Redirects fail closed. Durable
admission and account-serialized COMMIT fences protect each attempt.
Responses are capped at 2 MB; queries request at most 201 rows, retain 200 and
use the extra row only to prove incomplete coverage. Ordinary delegated and
configured application requests cover at most the most recent seven days.

Error bodies are never consumed. Received HTTP status, bounded request correlation and valid `Retry-After` remain available when retry waits or later transports exhaust the budget. Delta seconds and canonical HTTP dates are supported; a missing or invalid server `Date` uses the local clock, and invalid or negative delay values use bounded backoff. Delays beyond the remaining budget do not dispatch another request, but their diagnostic value is not truncated to that budget. Provider `401`/`403` hunting denials are inconclusive provider outcomes, not proof that local authorization expired, a particular role is absent, or licensing is missing. Successful-response stream failures expose only sanitized diagnostics, not provider-body or internal exception text.

Blueprint and actor object UUID filters compare case-insensitively in KQL, returned-row validation, and snapshot publication. Entra, blueprint and actor identifiers use Graph's hexadecimal `8-4-4-4-12` GUID syntax without RFC version/variant restrictions, matching the verified directory identity producer; native blueprint names cannot substitute for these typed filters. Actor filters match only `AccountObjectId`; the separately projected human-user identity is not a substitute. Native agent IDs and operation names retain their exact case-sensitive semantics. Filter spelling is preserved for existing saved-scope bindings. Optional provider request IDs are retained only when they fit the repository's 256-character bound and contain no Unicode control/format characters or line/paragraph separators; invalid correlation metadata is omitted rather than failing otherwise valid results.

Delegated consent does not establish data visibility. Defender [advanced-hunting RBAC](https://learn.microsoft.com/en-us/defender-xdr/advanced-hunting-rbac) and [unified RBAC assignments](https://learn.microsoft.com/en-us/defender-xdr/manage-rbac) can constrain the sources and data visible to the signed-in principal. Application mode additionally requires administrator-enabled application access and the exact current approved shared-data-scope and configuration revision.

## Fixed templates and projection v3

Every new job and row uses query/projection version 3. Provider schema order, names, types, envelope fields, and row fields must match the selected projection exactly. The KQL computes a value-free `ProjectionValid` signal, requires object-shaped `RawEventData`/`CopilotEventData` wrappers where selected, and permits only scalar selected fields. Exact filters run after validity is computed but before invalid values are nulled, so a malformed selected row cannot disappear as `no_data`; if it matches the requested native filter, its false signal reaches the adapter and fails closed. Unknown source keys are never projected. The repository independently permits only typed primitives plus the two exact state objects, so a caller cannot persist a dynamic object in a known scalar field.

The three generated templates are regression-compiled with Microsoft's semantic Kusto language service against independent `AgentsInfo` and `CloudAppEvents` table declarations. The check requires zero syntax or semantic diagnostics and exact string output names, types, and order. It also compiles every `format_datetime` call and the documented [`iff()`](https://learn.microsoft.com/en-us/kusto/query/iff-function) and [verbatim string](https://learn.microsoft.com/en-us/kusto/query/scalar-data-types/string#verbatim-string-literals) forms used by guards and escaped exact filters. This compiler test is local and makes no provider request.

### `agents_inventory`

`agents_inventory` reads the preview [`AgentsInfo` table](https://learn.microsoft.com/en-us/defender-xdr/advanced-hunting-agentsinfo-table), never retired `AIAgentsInfo`. It retains:

- observation time and exact agent, source-agent, Entra agent, blueprint, and observability identifiers;
- bounded name, platform, description, version, model, publication, lifecycle, and availability strings;
- nullable creation, publication, and update times and instance count;
- counts only for owner, sharing, permission-metadata, and authentication-metadata structures.

The exact queried source fields are `Timestamp`, `AgentId`, `AgentName`, `Platform`, `AgentDescription`, `Version`, `SourceAgentId`, `EntraAgentId`, `EntraBlueprintId`, `ObservabilityId`, `PublishedStatus`, `LifecycleStatus`, `Availability`, `CreatedDateTime`, `LastPublishedDateTime`, `LastUpdatedDateTime`, `InstanceCount`, `Model`, `Owners`, `SharedWith`, `Permissions`, and `ToolsAuthenticationType`. The returned projection contains only `ObservationTime`; those exact scalar identifiers/descriptions/statuses/dates/counts; the five detail states; and the value-free validity signal, which is consumed and not persisted.

Original owner, sharing, permission, authentication, and risk structures are not retained. As reviewed on 2026-09-09, the published `AgentsInfo` contract documents `Owners`, `Permissions`, and `ToolsAuthenticationType` only as `dynamic`; it does not publish a nested owner-identity, permission-risk, or authentication layout. Top-level fixture counts do not identify an owner and do not qualify permission/authentication risk. Those detail capabilities therefore remain disabled as `present_unqualified_shape` when nonempty; risk remains `not_exposed`. Each detail has an explicit state:

- `not_supplied`: the provider value was null or absent from the documented projection source;
- `empty`: the provider supplied an empty string, array, or object;
- `present_unqualified_shape`: a structure existed, but only its bounded count was retained and its nested meaning was not qualified;
- `not_exposed`: the selected hunting contract does not expose this detail.

Risk is always `not_exposed`; Agent Control does not infer risk from lifecycle, permissions, authentication, or activity.

### `agent_activity` and `agent_tools`

Both templates read [`CloudAppEvents`](https://learn.microsoft.com/en-us/defender-xdr/advanced-hunting-cloudappevents-table). The code-owned operation sets are:

| Template | Allowed `ActionType` values |
| --- | --- |
| `AgentsInfo` | Agent inventory metadata, platform, model, publication state, and source identifiers |
| `CloudAppEvents` | Agent invocation, inference, tool-call, actor, error, and completion metadata when available |
| Purview Audit Search | Separate searches for exact agent and/or user audit evidence |

Agent Control does not treat missing errors as proof of success and does not
reconstruct prompts, responses, or conversations.

## Resolve log identity

Defender sources use specific Entra object and application identifiers. Agent
Control verifies the identity before enabling a hunt.

1. Open the agent's **Activity** tab.
2. Review the saved inventory identity.
3. Select **Resolve log identity** when required.
4. Confirm the verified mapping before running a hunt.

The ten action-dependent fields carry a separate `value`, `null`, `empty`, or `unavailable` state. `null` means the applicable provider field was null, `empty` means it was an applicable empty string, and `unavailable` means that field is not part of that action's selected mapping. The projected value, state and action-specific availability are validated together by the adapter and again before saved-row publication. Human and agent user-name aliases obey the same action-specific availability as their respective object IDs. Inventory risk must remain `not_exposed`; that state is not valid for the separately observed owner/sharing/permission/authentication metadata. Empty optional activity creation/completion dates are accepted as missing dates, with completion's `empty` state retained and no duration inferred. Nonempty invalid dates and non-scalar values still fail the projection guard.

## Run a hunt

1. Select a supported log type.
2. Choose the bounded date range.
3. Run the hunt.
4. Monitor the saved job and review paged results.

Queries use fixed templates and bounded result storage. Provider throttling,
partial pages, and source coverage are shown with the job.

### Exact subject binding

The server calls `/v1.0/security/runHuntingQuery` with a code-owned KQL template
and explicit `Timespan`. Runtime `TargetAgentId`/`AgentId` predicates use verified
application IDs; `AgentsInfo.EntraAgentId` uses verified enterprise object IDs.
These namespaces are not interchangeable.

User searches expose **Agent invocations** (`InvokeAgent`) only: documented
`RawEventData.UserKey` identifies the human caller. Inference and tool events
identify the agent account instead, so they are not attributed to a human using
`AccountObjectId` or conversation ID guesses. User-on-agent searches intersect
the human caller with the resolved runtime agent. Returned rows are checked
again before publication. History, exports, cancellation and deletion carry
the same scope.

No workspace override or automatic provider preflight is used. Explicit search
reports real provider permission, licensing, connection and telemetry failures.

Shared saved-data visibility does not grant per-job lifecycle authority to another account. Application hunts run directly under current tenant/client/configuration identity and configured shared scope. Resume, cancellation and local deletion belong to the authorizing principal; Admin does not override ownership. Foreign mutations return `not_found` without disclosing lifecycle state. Shared results remain viewable/exportable under their current scope while foreign mutation controls stay hidden.

One initiating session and capability generation fences submission, activation, physical request admission and snapshot publication. Configuration/authority changes during awaited admission or transaction writes cannot be adopted by older work. Saved reads recheck session/capability, selected agent identity, snapshot visibility and expiry after repository/association reads. They acquire no provider token and do not depend on live provider availability.

CSV publication preserves the shared session fence and additionally checks the initiating Defender capability generations synchronously before each released chunk. A capability change while asynchronous source/session reads settle cannot release an older CSV under the replacement authority.

An ordinary provider outage does not make locally authorized private saved data unreadable. Current app roles, principal scope and application configuration are enforced locally, but external Defender RBAC/data-source revocation cannot be discovered offline. A later explicit hunt obtains current provider authority; saved data alone does not prove current visibility.

Delegated hunts belong to the authorizing account. Optional application mode
requires separate application permission, Agent Control Admin enablement, and an
approved shared data scope.

**Permissions > Check status** verifies token readiness. It does not run a hunt
or prove that Defender has data for the selected agent.

Submission promptly creates a durable job. Startup recovery exhausts interrupted work in bounded transaction batches before accepting requests; startup, navigation and automatic permission checking make zero hunting requests. Polling observes an existing request and is not a recurring collector. Interrupted work may return to `waiting_authorization`, but explicit resume revalidates the exact current account, role, token mode, request evidence and application scope.

Hunt jobs support status, paging, minimized CSV export, cancellation, local
deletion, and recovery of accepted work. Closing the browser does not cancel an
accepted provider request.

Run the supported [retention workflow](operations.md#run-retention) to remove
expired saved jobs and results.

## Troubleshooting

| Problem | Check |
| --- | --- |
| Hunting is unavailable | Confirm app role, Graph consent, Security Reader or Defender RBAC, and data scope. |
| Identity cannot be verified | Confirm current inventory, `AgentIdentity.Read.All`, consent, and Agent ID access. |
| No records are returned | Confirm the date range, selected template, telemetry ingestion, and exact agent mapping. |
| Results are partial | Review provider throttling, paging limits, and the saved job status. |

Microsoft references:

Snapshot publication returns the transaction's committed result without a post-commit database reread. A subsequent audit-completion failure is surfaced as a worker failure, not rewritten as an inconclusive/cancelled hunt or replayed. Waiting-authorization jobs can be cancelled without resuming them; terminal failures display their sanitized outcome in the investigation detail.

Failure and authorization-wait settlement likewise return their durable updated job directly, retaining any prior-success reference. Settlement does not introduce a fallible post-update read before query-audit completion.

Submission, provider admission, snapshot publication, cancellation and local deletion check initiating authority at the transaction helper's synchronous COMMIT boundary. Local mutations retain account serialization through transaction settlement. Cancellation aborts the worker only after durable cancellation succeeds; a rejected command must not stop valid work. Running jobs must be cancelled before deletion. Cancellation returns its committed outcome and prior-success reference without a fallible reread.

Catalog collections share one saved scope and final agent-identity check. JSON replies synchronously fence the initiating session and capability generations after all route waits, including audit completion. Row reads also recheck current saved-job visibility after auditing, so expired, deleted or revoked scopes cannot release old rows. Failure auditing logs its own error without replacing the original authorization or lifecycle failure.

Requested, observed, and unobserved ranges remain distinct. A 201-row response publishes 200 minimized rows as `partial` and marks the requested interval unobserved rather than claiming a complete total. Provider, schema, scope, or access failures cannot become empty success. Returned-scope mismatches and response-byte limits settle as `inconclusive` provider outcomes with sanitized readiness evidence, not local failures or authorization waits. A later failed attempt does not replace an earlier same-scope successful snapshot and exposes a direct link to that retained result.

Local tests validate query construction, documented fixture schemas, scope
isolation and job behavior. Live collection requires a licensed, connected
tenant containing relevant telemetry; token readiness does not prove ingestion.
