# Microsoft Purview Audit Search

Microsoft Purview Audit Search is compliance and security evidence. It is **not** official Microsoft 365 Copilot Agents usage. Agent Control keeps Purview records, local administrative audit, official usage reports, package inventory and Power Platform inventory as separate source authorities.

The adapter and product workflow are fixture-qualified. No approved tenant lifecycle was run in Phase 07, so neither delegated nor application Audit Search is live-qualified. A routine Permission Center refresh never creates a saved Microsoft query. Availability requires a separately approved bounded create, poll and records lifecycle for the exact mode, permission, contract and configuration revision.

## Selected Graph Contract

Microsoft references were rechecked on 2026-09-09. Agent Control implements one global-cloud Microsoft Graph v1.0 contract:

| Operation | Request | Accepted response |
| --- | --- | --- |
| Create query | `POST /v1.0/security/auditLog/queries` with singular `serviceFilter` | `201` and a direct `auditLogQuery` object |
| Reconcile an uncertain create | `GET /v1.0/security/auditLog/queries`, at most five pages per attempt | `200` and a collection envelope with `value` |
| Poll one query | `GET /v1.0/security/auditLog/queries/{auditLogQueryId}` | `200` and a direct `auditLogQuery` object |
| Read records | `GET /v1.0/security/auditLog/queries/{auditLogQueryId}/records` | `200` and a collection envelope with `value` and an optional validated `@odata.nextLink` |

The query status allowlist is `notStarted`, `running`, `succeeded`, `failed`, `cancelled` and `unknownFutureValue`. Unknown fields or envelope shapes fail closed. Redirects and pagination links outside the exact Graph origin and path family are rejected before an authorization header is attached.

The selected request properties are `displayName`, `filterStartDateTime`, `filterEndDateTime`, `recordTypeFilters`, singular `serviceFilter`, `operationFilters`, `userPrincipalNameFilters`, `ipAddressFilters`, `objectIdFilters` and `administrativeUnitIdFilters`. Agent Control requires a nonempty caller-selected subset of the selected preset's code-owned operation allowlist. It does not send arbitrary provider JSON, `keywordFilter`, operations outside that allowlist or plural `serviceFilters`.

The Microsoft references remain inconsistent:

- [Create auditLogQuery](https://learn.microsoft.com/en-us/graph/api/security-auditcoreroot-post-auditlogqueries?view=graph-rest-1.0), [list auditLogQueries](https://learn.microsoft.com/en-us/graph/api/security-auditcoreroot-list-auditlogqueries?view=graph-rest-1.0) and [list auditLogRecords](https://learn.microsoft.com/en-us/graph/api/security-auditlogquery-list-records?view=graph-rest-1.0) describe the `AuditLogsQuery-*` permission family. Create examples use singular `serviceFilter`.
- [Get auditLogQuery](https://learn.microsoft.com/en-us/graph/api/security-auditlogquery-get?view=graph-rest-1.0) still lists `ThreatIntelligence.Read.All`, despite addressing the same query lifecycle.
- That GET page describes a direct query object in its response prose, but its example wraps one object in `value` and includes `keywordFilter`. This implementation accepts only the direct selected query shape; the example envelope and unsupported query property are rejected.
- The [auditLogQuery resource](https://learn.microsoft.com/en-us/graph/api/resources/security-auditlogquery?view=graph-rest-1.0) describes plural `serviceFilters` while the create operation describes singular `serviceFilter`.

Agent Control therefore requests only `AuditLogsQuery.Read.All` for its cross-workload curated searches and requires live proof of the complete selected lifecycle. It does not add `ThreatIntelligence.Read.All`, try alternate property shapes at runtime or treat a documentation page as tenant evidence.

## Projection Contract And Sources

Projection version 1 combines two documented layers without conflating them:

- The Graph [auditLogRecord resource](https://learn.microsoft.com/en-us/graph/api/resources/security-auditlogrecord?view=graph-rest-1.0) is the outer `#microsoft.graph.security.auditLogRecord` wrapper. Its `userType` is a string enum and its `auditData` property is an abstract audit-data object.
- The Graph [defaultAuditData resource](https://learn.microsoft.com/en-us/graph/api/resources/security-defaultauditdata?view=graph-rest-1.0) documents only the `#microsoft.graph.security.defaultAuditData` type shell. It explicitly lists no properties, so it is not a specification for the native child fields observed inside `auditData`.
- The Office [Management Activity common schema](https://learn.microsoft.com/en-us/office/office-365-management-api/office-365-management-activity-api-schema) is the source for native audit fields. It assigns record type `256` to `PowerPlatformAdministratorActivity`, record type `261` to `CopilotInteraction`, and defines native `UserType` as `Edm.Int32` values 0 through 10. Agent Control validates that integer when present but does not expose it in the public projection or substitute it for Graph's wrapper `userType`.
- The Office [CopilotInteraction schema](https://learn.microsoft.com/en-us/office/office-365-management-api/copilot-schema) places Copilot metadata under `CopilotEventData`. The current Purview [Copilot audit reference](https://learn.microsoft.com/en-us/purview/audit-copilot) documents `AgentId`, `AppIdentity`, `AppHost` and `Messages`; its emitted JSON example uses `Messages[].ID` and lowercase `Messages[].isPrompt`. Projection version 1 accepts that emitted casing exactly and does not add `Id` or `IsPrompt` aliases.
- The current [Copilot Studio audit reference](https://learn.microsoft.com/en-us/microsoft-copilot-studio/admin-logging-copilot-studio) documents the administrative operation labels, native logical `ID` as a GUID, and `BotId`, `BotComponentId` and `AIPluginOperationId`. Projection version 1 selects uppercase native `ID`; the generic Office common schema's `Id` spelling is not an alias. Missing native identity remains absent rather than being replaced by the Graph wrapper ID. The Studio reference also confirms that audit records contain metadata, not chat text.

The Copilot references have a casing gap: older schema XML names the message identifier `Id`, while the newer reference prose calls the boolean `IsPrompt`; the newer emitted JSON example uses `ID` and `isPrompt`. Agent Control selects the emitted JSON contract and fails closed on alternate casing. Only message IDs and prompt/response flags are retained. Prompt text, response text, transcript content and other unrestricted message content are never projected, stored or exported.

## Authorization And Eligibility

- Every route requires `AgentControl.SecurityReader`. Qualification approval additionally requires the independent `AgentControl.Administrator` role.
- Delegated mode is private to the authorizing principal and requires that user to hold the Purview **Audit Logs** or **View-Only Audit Logs** role.
- Application mode is separately disabled by default. It requires Administrator enablement, approved shared data scope and application permission qualification; it does not convert delegated results into tenant-shared data.
- Both modes use `AuditLogsQuery.Read.All`. Personal Microsoft accounts and non-global clouds are unsupported by this implementation.
- Microsoft Purview licensing, unified audit logging, workload support, retention, service limits and tenant rollout independently control whether a query can run and what it can observe.

Microsoft's [Audit comparison](https://learn.microsoft.com/en-us/purview/audit-solutions-overview) lists the Audit Search Graph API for both Audit (Standard) and Audit (Premium); Premium adds capabilities such as longer retention and higher Management Activity API bandwidth. That bandwidth statement is not a Graph Audit Search quota guarantee. The [Copilot audit reference](https://learn.microsoft.com/en-us/purview/audit-copilot) describes Microsoft and Copilot Studio applications as included in Audit Standard, but [Get started with auditing](https://learn.microsoft.com/en-us/purview/audit-get-started) also includes Copilot Studio in its non-Microsoft 365 AI pay-as-you-go discussion. Do not infer universal entitlement or absence of billing from either statement; the tenant administrator must confirm the exact workload's current license and billing prerequisites.

The get-started guide maps the Purview Audit Reader and Audit Manager role groups to **View-Only Audit Logs** and **Audit Logs**; Graph application permissions are a separate requirement. [Audit retention policies](https://learn.microsoft.com/en-us/purview/audit-log-retention-policies) describe typical 180-day retention, with eligible Premium workloads/users and configured policies potentially retaining records longer. These source policies are not the application's seven-day query limit or 30-day local cache lifetime.

A successful approved lifecycle proves only the selected API contract and effective access for that exact identity, mode and configuration at that time. In particular, a successful empty query does not prove licensing for every workload, event emission, historical retention or comprehensive source coverage. Verify those prerequisites separately and keep absent or unobserved records explicit.

Missing grant, Purview role, application-scope approval, tenant support, license or conclusive lifecycle evidence leaves the capability visible but disabled with a bounded error category and correlation ID. Do not grant broader permissions to clear that state. Recheck the cited references and rerun one approved qualification after the exact prerequisite is repaired.

## Curated Searches And Bounds

The UI exposes two code-owned presets:

- **Copilot interactions:** service `Copilot`, record type `copilotInteraction`, operation `CopilotInteraction`.
- **Copilot Studio administration:** service `PowerPlatform`, record type `powerPlatformAdministratorActivity`, and explicit bot, bot-component, AI-plugin-operation and environment-variable create/update/delete or publish/share/auth/name/icon operations.

Users may narrow a preset with exact UTC start/end times, user principal names, IP addresses, object IDs and administrative-unit UUIDs. Each filter array accepts at most 20 unique validated values. Ordinary searches cover at most the most recent seven days; qualification covers at most one hour.

| Boundary | Limit |
| --- | --- |
| Active in-process search activations | 4 |
| Unfinished jobs | 5 per principal; 10 per tenant |
| Durable activations per job | 12 |
| Physical provider attempts per job | 64; reserved immediately before every `fetch` attempt |
| Create dispatch | Once; never blindly retried |
| Ambiguous-create reconciliation | 3 attempts; at most 5 query-list pages per attempt |
| One physical provider attempt | 10 seconds; 2,000,000 response bytes |
| One logical provider request | At most 3 attempts and 30 seconds total for throttling/server/network failures |
| One activation | 60 seconds; 6 polls with 1-3 second jitter |
| Final publication authorization | Separate 10-second bound; still aborted by cancellation/logout; no further Audit Search requests |
| Record retrieval | 20 pages; 5,000 stored rows; 8,000,000 aggregate bytes |
| Durable execution deadline | 48 hours |
| Local result lifetime | 30 days |

Reaching a page, row, byte or time boundary publishes only minimized rows already observed and marks the job `partial`, provided current publication authorization succeeds. Activation timeout uses `audit_activation_timeout`; the separate final authorization allowance does not extend provider execution. The UI reports the requested range as unobserved rather than claiming complete coverage. A provider failure, unsupported schema or deadline never fabricates an empty successful result.

## Stored Data And Identity

Agent Control discards provider response bodies after validation. It stores only the provider query ID/status/correlation ID, coverage counts, and an allowlist of typed record metadata: native and wrapper IDs, event time, operation, service/workload, record type, result, actor identifiers, object ID, client IP, administrative units, correlation ID, agent/app/host IDs, Bot ID, environment ID, bot-component ID, AI-plugin-operation ID, and bounded Copilot `Messages[].ID` identifiers with their lowercase `isPrompt` flag.

**Content not present in Purview audit:** message identifiers are evidence metadata. Prompt text, response text, transcript content and unrestricted `auditData` are never stored or exported. Unknown fields are counted and discarded. Native event identity deduplicates only within one result while query provenance remains attached; tenant/principal scope is applied before records, counts, paging and export.

Cross-source association uses only exact `BotId` plus environment against the initiating principal's current private Power Platform snapshot. An Agent ID alone, a package ID, app ID, name, owner or timestamp cannot establish that relation. Missing, unmatched and multiply matched records remain unresolved or ambiguous and stay separately usable.

Authorized record views and CSV exports append content-free local audit events with the job ID, source and resulting count. Result bodies are never copied into local administrative audit. CSV export applies the same principal-private or current configured application-shared result scope as retrieval, caps at 5,000 records and neutralizes spreadsheet formula prefixes.

## Recovery, Cancellation And Retention

Submission returns promptly after persisting the code-owned `agent-control-audit:{jobId}` marker. A timeout or connection loss during create records an unknown outcome and reconciles by exact marker and filters; it never issues a second POST. Only a complete bounded listing can establish a unique reconciliation match. Create and poll responses must match the durable marker and filters, and polling must also return the stored provider ID. Provider query ID is stored before polling, and the latest allowlisted provider request ID is retained separately from the local request ID. Execution owner/version fences reject stale writes after recovery, cancellation or replacement.

Shutdown and startup perform no Graph work. Interrupted `running` or `reconciling_create` jobs return to `waiting_authorization`; explicit resume revalidates current identity, role, capability and token before exactly one bounded continuation. Jobs with a provider ID poll that ID. Jobs with only an attempted marker reconcile. Completed and inconclusive work does not replay.

Cancel stops local polling/download and records that Microsoft Graph may continue the remote query. Delete removes only a non-running local job and its cached rows. The selected Microsoft contract exposes no remote cancel or delete operation, so the product never claims either action changes the provider query or source events.

Jobs and dependent records expire after 30 days through operator retention. The 48-hour deadline first makes unfinished work inconclusive, preserving whether an attempted remote create may continue. Qualification approval expires after one day; detached expired qualification history is removed after the additional finite cleanup window. View/export audit expires under the ordinary 90-day local audit policy. Microsoft source-event retention and any remote query lifetime are separate provider policies and are never inferred from local expiry.

Run [operator retention](operations.md#retention) at least daily for an active installation, using the existing internal helper and its exact project/database confirmation, preview and bounded-batch safeguards. Retention is not a `deploy-local.ps1` argument and makes no provider calls.