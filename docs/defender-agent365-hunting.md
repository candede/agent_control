# Defender and Agent 365 hunting

Agent Control runs only explicit, curated Microsoft Graph advanced-hunting requests. It does not expose arbitrary KQL, run a collector, schedule snapshots, select a workspace, reconstruct conversations, emit telemetry, or treat hunting metadata as official usage.

## Selected provider contract

The selected global contract is exactly:

- `POST https://graph.microsoft.com/v1.0/security/runHuntingQuery`
- delegated or application `ThreatHunting.Read.All`
- request body `{ "Query": "<code-owned KQL>", "Timespan": "<UTC start>/<UTC end>" }`
- `200` response with exact `schema` and `results` arrays

The [Graph operation](https://learn.microsoft.com/en-us/graph/api/security-security-runhuntingquery?view=graph-rest-1.0) documents optional `workspaceId` behavior, including fallback to a primary workspace. Agent Control does not accept or send `workspaceId`. It labels only the Graph-selected Defender result scope and never promises requested-workspace isolation.

Every query has both an explicit KQL `Timestamp between (...)` predicate and the same bounded Graph `Timespan`. UTC values have a trailing `Z`. The adapter binds returned rows to the requested source table, tenant, operation, exact identity filters, and time range before publication. Exact identifiers are never truncated; only bounded descriptive strings may be shortened.

The adapter permits at most three safe attempts for transport, `429`, or `5xx` failures. Each logical query has a 30-second request budget, including an abort race for transports that ignore `AbortSignal`. Redirects fail closed. Every physical request is durably admitted before dispatch. A response is capped at 2 MB. Queries request at most 201 rows, retain at most 200, and use the 201st row only to prove incomplete coverage. Ordinary requests cover at most the most recent seven days; qualification covers at most one hour.

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
| `agent_activity` | `InvokeAgent`, `InferenceCall` |
| `agent_tools` | `ExecuteToolBySDK`, `ExecuteToolByGateway`, `ExecuteToolByMCPServer` |

Projection v3 follows the documented Agent 365 IA/ET/CH source distinctions:

| Meaning | `InvokeAgent` (IA) | `InferenceCall` (CH) | Tool actions (ET) |
| --- | --- | --- | --- |
| Platform agent ID | `Event.PlatformTargetAgentId` | `Event.PlatformAgentId` | `Event.PlatformAgentId` |
| Platform agent type | `Event.PlatformTargetAgentType` | `Event.CopilotEventData.PlatformAgentType` | `Event.PlatformAgentType` |
| Conversation | `Event.ConversationId` | `Event.CopilotEventData.ConversationId` | `Event.ConversationId` |
| Thread | unavailable | `Event.CopilotEventData.ThreadId` | unavailable |
| Channel | `Event.ChannelName` | unavailable | `Event.ChannelName` |
| Human identity | `Event.UserKey` / `Event.UserId` | unavailable | unavailable |
| Agent identity | unavailable | `Event.UserKey` / `Event.UserId` | `Event.UserKey` / `Event.UserId` |
| Target-agent identity | `Event.TargetAgentUserKey` | unavailable | unavailable |
| Completion/error | `Event.CompletionTime` / `Event.ErrorType` | `CopilotEventData.CompletionTime` / `CopilotEventData.ErrorType` | completion from `Event`; error unavailable |

The exact direct `CloudAppEvents` source fields are `Timestamp`, `ActionType`, `Application`, `ApplicationId`, `AppInstanceId`, `AccountObjectId`, `AccountId`, `ObjectId`, `ReportId`, and `OAuthAppId`. The exact selected `RawEventData` fields are `Operation`, `OrganizationId`, `TargetAgentId`, `TargetAgentName`, `TargetAgentBlueprintID`, `AgentId`, `AgentName`, `AgentBlueprintId`, `PlatformTargetAgentId`, `PlatformAgentId`, `PlatformTargetAgentType`, `PlatformAgentType`, `ConversationId`, `SessionIdentity`, `ChannelName`, `UserKey`, `UserId`, `TargetAgentUserKey`, `OpId`, `ParentId`, `CreationTime`, `CompletionTime`, `ErrorType`, `ToolName`, `ToolType`, `ToolId`, `InvokeSource`, and the `CopilotEventData` wrapper. Only `PlatformAgentType`, `ConversationId`, `ThreadId`, `CompletionTime`, and `ErrorType` are selected from that nested wrapper. Optional projected dates are formatted as exact millisecond UTC values ending in `Z`.

`OpId` and `ParentId` are validated as 16-character hexadecimal span IDs. `rootSpanObserved` is true only for `ActionType=InvokeAgent`, `Operation=invoke_agent`, a valid nonempty `OpId`, and no parent. It is always false for child-only or unresolved rows. This metadata does not prove downstream admin-center ingestion, complete root-tree collection, or conversation availability. Child spans are not combined into sessions or conversations. Outcome is only `error` when an exposed error type exists, otherwise `unknown`; success is never inferred from a missing error.

The ten action-dependent fields carry a separate `value`, `null`, `empty`, or `unavailable` state. `null` means the applicable provider field was null, `empty` means it was an applicable empty string, and `unavailable` means that field is not part of that action's selected mapping. The projected value and state are validated together.

The Agent 365 [observability concepts](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/observability-concepts), [attribute reference](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/observability-attribute-reference), [direct OpenTelemetry integration](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/direct-open-telemetry-integration), and [troubleshooting guidance](https://learn.microsoft.com/en-us/microsoft-agent-365/developer/direct-open-telemetry-troubleshooting) define the source boundary. The current attribute reference does not expose usable CloudAppEvents mappings for model/provider names or input/output/total token counts, so those activity fields are intentionally absent rather than blank or inferred. Inputs, outputs, messages, instructions, memory, tool arguments/results, model content, unknown fields, original `RawEventData`, and complete provider bodies are discarded. `contentAvailable` is always false.

Defender for AI [setup](https://learn.microsoft.com/en-us/defender-xdr/security-for-ai/get-started-defender-security-for-ai), applicable licensing, Microsoft 365 activities connectivity, rollout, RBAC, and table population are independent prerequisites. A valid empty response is `no_data`. It proves only that the exact request completed at that time, not tenant-wide coverage and not which prerequisite is missing.

## Qualification and visibility

`AgentControl.SecurityReader` is required for submission, history, rows, export, cancellation, and local deletion. Qualification approval additionally requires `AgentControl.Administrator`.

Qualification requires at least one exact agent, blueprint, or actor object ID. Successful provider-availability evidence is feature-owned and keyed by tenant, authorizing principal, delegated/application result scope, mode, fixed template, the exact non-time filter scope hash, query version 3, permission revision, contract revision, and configuration revision. It expires after 24 hours and is required for every new provider send. Global capability status or evidence for a sibling template, target, old query version, or old contract cannot authorize a query.

The same explicit Administrator plus SecurityReader qualification approval creates a separate exact retained-scope approval. It is bound to the successful qualification job and the same identity/mode/template/target/query/permission/contract/configuration tuple, expires 30 days after approval, and is attached by ID to every ordinary job. Saved history, counts, rows, and CSV require the caller's current SecurityReader role plus that exact unexpired, nonrevoked retained scope; they do not require fresh provider-availability evidence. `POST /api/hunting/retained-scopes/:id/revoke` and the matching UI control require both Administrator and SecurityReader and immediately hide every bound saved result.

Delegated results are tenant/principal-private. Application results are visible to another current SecurityReader only through the exact current application identity, enabled shared scope, configuration revision, and nonrevoked retained approval. Those bindings are revalidated before provider work and again before publication; current local revocation or configuration change invalidates sends and saved reads immediately. Qualification publication locks the current configuration row, so an older qualification cannot race and authorize a newer configuration. There is no delegated-to-application fallback or newer-approval fallback for an older job.

This is an explicit local trust boundary. While the approved retained tuple remains current, an ordinary provider outage or expired 24-hour probe does not make locally authorized saved data unreadable. Agent Control can immediately enforce its current app roles, retained-scope revocation, and application configuration, but it cannot discover an external Defender RBAC/data-source assignment revocation while offline. Revalidate that external authority with a new bounded qualification when connectivity returns; do not claim the retained approval proves current provider visibility.

Exact cross-source association is permitted only for documented typed identifiers. An `entra_agent_id` can resolve to one current Power Platform resource within the initiating Reader's existing visibility scope. Blueprint identifiers remain parent relationships, not child equivalence. Missing, ambiguous, differently scoped, and unmatched records remain separately visible.

## Jobs, coverage, and retention

Submission promptly creates a durable job. Startup and navigation make zero hunting requests. Polling observes an existing request and is not a recurring collector. Interrupted work may return to `waiting_authorization`, but explicit resume revalidates the exact current account, role, qualification, token mode, and application scope.

Each job has:

- a 15-minute durable deadline;
- at most four activations and 12 physical provider requests;
- at most five unfinished jobs per principal and ten per tenant;
- exact local and provider correlation identifiers and durable execution fencing.

Deadline or budget exhaustion becomes terminal `inconclusive`; it cannot remain waiting indefinitely. Logout, account change, cancellation, recovery, and publication all fence late results. Completed work never replays after restart.

Requested, observed, and unobserved ranges remain distinct. A 201-row response publishes 200 minimized rows as `partial` and marks the requested interval unobserved rather than claiming a complete total. Provider, schema, scope, or access failures cannot become empty success. A later failed attempt does not replace an earlier same-scope successful snapshot and exposes a direct link to that retained result.

Jobs, snapshots, and rows expire after 30 days with dependent export data. Provider qualification evidence has its own finite 24-hour lifetime. A retained-scope record is deleted only after its finite 30-day expiry and after bound jobs are gone; expiry/revocation hides those jobs before physical cleanup. Source retention remains a Microsoft policy. CSV is formula-hardened, source-safe, and bounded to the retained rows.

## Audit and fixture boundary

Approval, qualification, retained-scope revocation, submission, provider query, cancellation, view, deletion, and export produce immutable local lifecycle records. Audit metadata is allowlisted to safe source, mode, template, count, status, and correlation fields. It never stores KQL, typed filters, requested target IDs, time ranges, provider bodies, or result rows.

Protocol, persistence, HTTP, component, browser, restart, and export fixtures are synthetic. They contain no provider tokens, tenant records, prompt/response text, instructions, memory, tool arguments/results, raw body archives, or live endpoint responses.

Live capability evidence is not part of fixture validation. With retained authentication unconfigured, both capabilities remain disabled and no Graph call is allowed. Phase 13 owns separately approved live qualification: verify tenant licensing, rollout, connector, table population, delegated RBAC or exact application shared scope, then approve one recent one-hour exact-target `AgentsInfo` query and one narrow exact-target `CloudAppEvents` query. Do not broaden grants, enable application scope, emit telemetry, or infer tenant readiness from fixture success.