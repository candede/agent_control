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

The adapter permits at most three safe attempts for transport, `429`, or `5xx` failures. Each logical query has a 30-second request budget, including an abort race for transports that ignore `AbortSignal`. Redirects fail closed. Every physical request is durably admitted before dispatch. A response is capped at 2 MB. Queries request at most 201 rows, retain at most 200, and use the 201st row only to prove incomplete coverage. Ordinary delegated requests cover at most the most recent seven days; separately approved application/shared qualification covers at most one hour.

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

## Evidence and visibility

Viewer and Admin with current or safely read-through-refreshed capability authorization may directly submit their own bounded delegated hunt and access, export, cancel, or locally delete only results authorized for their principal. There is no separate delegated qualification approval/start ritual. The explicit hunt requires at least one exact agent, blueprint, or actor object ID; its successful provider request establishes provider evidence for that principal and exact identity/mode/template/target/query/permission/contract/configuration tuple.

Automatic Permission Center checks acquire only the scoped delegated token and report token verification. They never run KQL, create a hunting job or prove Defender licensing, RBAC/data-source visibility, table rollout or exact operation access. Opening the view also creates no hunt. Global capability status or evidence for a sibling template, target, old query version or old contract cannot authorize or widen a hunt.

Ordinary delegated jobs have no retained-scope binding. They remain exactly tenant/principal-scoped and visible only to that current principal under the saved-data policy. The worker revalidates Viewer access, session identity and delegated token before provider execution. Explicit delegated qualification APIs may remain available for optional retained-scope workflows, but they are never a prerequisite for an ordinary hunt. Revoking optional delegated principal-owned scope remains available to its owner. Revoking application/shared retained scope requires Admin, and application-mode qualification remains Admin-only because it binds approved shared scope.

Delegated results are tenant/principal-private. Admin does not gain access to another user's private cached jobs or results. Application results are visible to another current Viewer or Admin only through the exact current application identity, explicitly enabled shared scope, configuration revision, qualification, and nonrevoked retained approval. Those application bindings are revalidated before provider work and again before publication; current local revocation or configuration change invalidates sends and saved reads immediately. Qualification publication locks the current configuration row, so an older application qualification cannot race and authorize a newer configuration. There is no delegated-to-application fallback or newer-approval fallback for an older application job; delegated-only deployments keep application mode disabled.

This is an explicit local trust boundary. An ordinary provider outage does not make locally authorized principal-private saved data unreadable. Agent Control can immediately enforce its current app roles, principal scope, optional retained-scope revocation, and application configuration, but it cannot discover an external Defender RBAC/data-source assignment revocation while offline. A later explicit bounded hunt revalidates external authority when connectivity returns; saved data or optional retained scope does not prove current provider visibility.

Exact cross-source association is permitted only for documented typed identifiers. An `entra_agent_id` can resolve to one current Power Platform resource within the initiating principal's existing visibility scope. Blueprint identifiers remain parent relationships, not child equivalence. Missing, ambiguous, differently scoped, and unmatched records remain separately visible.

## Jobs, coverage, and retention

Submission promptly creates a durable job. Startup, navigation and automatic permission checking make zero hunting requests. Polling observes an existing request and is not a recurring collector. Interrupted work may return to `waiting_authorization`, but explicit resume revalidates the exact current account, role, token mode, request evidence and application scope.

Each job has:

- a 15-minute durable deadline;
- at most four activations and 12 physical provider requests;
- at most five unfinished jobs per principal and ten per tenant;
- exact local and provider correlation identifiers and durable execution fencing.

Deadline or budget exhaustion becomes terminal `inconclusive`; it cannot remain waiting indefinitely. Logout, account change, cancellation, recovery, and publication all fence late results. Completed work never replays after restart.

Requested, observed, and unobserved ranges remain distinct. A 201-row response publishes 200 minimized rows as `partial` and marks the requested interval unobserved rather than claiming a complete total. Provider, schema, scope, or access failures cannot become empty success. A later failed attempt does not replace an earlier same-scope successful snapshot and exposes a direct link to that retained result.

Jobs, snapshots, and rows expire after 30 days with dependent export data. Capability evidence established by an explicit delegated provider request follows the finite five-minute readiness TTL. Optional qualification/retained-scope records retain their separate finite lifecycle; those records do not bind ordinary delegated jobs. Source retention remains a Microsoft policy. CSV is formula-hardened, source-safe, and bounded to the retained rows.

## Audit and fixture boundary

Application/shared approval and qualification, optional delegated qualification and retained-scope revocation, delegated request evidence, submission, provider query, cancellation, view, deletion, and export produce immutable local lifecycle records. Audit metadata is allowlisted to safe source, mode, template, count, status, and correlation fields. It never stores KQL, typed filters, requested target IDs, time ranges, provider bodies, or result rows.

Protocol, persistence, HTTP, component, browser, restart, and export fixtures are synthetic. They contain no provider tokens, tenant records, prompt/response text, instructions, memory, tool arguments/results, raw body archives, or live endpoint responses.

Live capability evidence is not part of fixture validation. With retained authentication unconfigured, no live Graph call is allowed. Live verification must first confirm tenant licensing, rollout, connector, table population and delegated RBAC, then submit ordinary explicitly authorized bounded delegated hunts for exact `AgentsInfo` and `CloudAppEvents` targets; there is no separate delegated approve/start ritual. Application/shared verification remains separately Admin-approved and qualified. Do not broaden grants, enable application scope, emit telemetry, or infer tenant readiness from fixture success.