# Microsoft Purview Audit Search

This guide documents the retained Microsoft Graph Audit Search backend and
components. Purview entry points and setup are **hidden from the current UI**
and are not part of the Permissions page's configuration checklist. Do not add
these permissions as prerequisites for normal deployment or synchronization.
See the [current permission reference](user-roles-and-permissions.md#app-registration-permissions).

Purview records are investigation evidence, not Microsoft 365 Copilot usage
totals or Agent Control's local administrative Audit history.

## Retained backend scope

Explicit, bounded searches support exact directory-user and agent subjects.
Report users must resolve to a verified directory identity. Saved reads do not
start a Microsoft query. The component behavior below describes the retained
implementation, not a navigation path available in the current workbench.

Viewer-capable backend authority includes Viewer, Usage Report Uploader and
Admin; private ownership and configured shared scopes still apply. In contrast,
the separate local **Audit** tab/page and its read/export endpoints require
Admin. Audit recording is unchanged.

## Required Microsoft access

- Microsoft Graph delegated `AuditLogsQuery.Read.All`
- Tenant-wide admin consent
- Purview Audit enabled for the tenant
- Purview **Audit Logs** or **View-Only Audit Logs** access

Recommended user access is **Security Reader** in Entra ID plus **Audit Reader**
in Purview. This backend-specific guidance does not add roles to the current
inventory setup.

## Retained search components

The retained component's **Check permissions** checks token readiness, not the
provider query lifecycle or complete Microsoft role/license entitlement.
Purview is filtered out of the current Permissions UI; its **Check status**
button is not a Purview setup workflow. **Run Audit Search** is the retained
component's explicit functional create/poll/records operation. Missing
`AuditLogsQuery.Read.All` consent, Microsoft Purview Audit enablement, and the
Audit Logs or View-Only Audit Logs role are failures, not empty results.

When an explicit delegated search or resume completes successfully, the panel refreshes readiness once to display the saved lifecycle evidence without replaying Audit Search. Partial and inconclusive jobs do not claim provider verification. Manual history refresh can retry the readiness read for that completed selection; merely opening saved history does not trigger this lifecycle refresh.

Application mode requires configured identity/credentials, application permission, enabled mode and configured shared scope. An authorized Viewer-capable caller submits an ordinary search directly; no prior approval query is required. Searches allow up to 168 hours, bounded to 20 pages and 5,000 stored rows. Actual provider errors and partial coverage remain visible.

`PurviewAuditView` accepts `active?: boolean` (default `true`) for visited tabs that stay mounted. While inactive it renders no content, stops saved-history polling and aborts its owned reads/actions. Form fields and selected-job state are retained in memory for the same account, roles, selected UPN and meaningful capability access/configuration state. Capability timestamp, freshness and verification-only renewals do not remount the form.

On return, the tab reloads the catalog and scoped history, revalidates the exact selected job, and reloads a previously viewed saved record page before displaying it. Saved-query keys include the account/access/user scope so another observer cannot retain a prior account's request for the new account. Denied, deleted, expired or mismatched selections fail closed. Switching tabs neither submits nor resumes provider work, and does not reset the five-minute/150-attempt UI polling budget; an explicit history refresh can restart that budget. Aborting a browser request does not undo an already accepted server query; its saved job can be recovered from history.

Editing draft filters clears the selected results and cancels that selection's pending exact-job or record read, including revalidation on tab return, manual refresh or polling. Independent catalog/history reads and already admitted saved-job commands continue; a retired selection response cannot clear their state or leave the history loading indicator stuck.

Capability responses include the application configuration revision in saved-data authority. A revision change retires prior records and in-flight commands even when enablement, shared-scope flags and readiness remain unchanged. Diagnostic-only updates preserve the current view. Manual history refresh hides selected results during revalidation, preserving a loaded page only when the authorized job ID and saved version are unchanged.

Saved record reads share pending requests only for the same authorized job, saved version and page. A reader that has observed a newer job version cannot join an older reader's pending record request. Exact-job and record responses also update the corresponding history row, so its status and actions use the newly observed evidence without another history request. If export, resume, cancellation or local deletion reports that the job is missing, its application scope changed, or its saved state no longer permits the command, the panel withdraws its saved evidence and actions. Explicit history refresh revalidates availability without replaying the failed command; transient command failures and provider-consent failures do not by themselves invalidate authorized saved records.

## Selected Graph Contract

Microsoft references were rechecked on 2026-09-09. Agent Control implements one global-cloud Microsoft Graph v1.0 contract:

| Operation | Request | Accepted response |
| --- | --- | --- |
| Create query | `POST /v1.0/security/auditLog/queries` with singular `serviceFilter` | `201` and a direct `auditLogQuery` object |
| Reconcile an uncertain create | `GET /v1.0/security/auditLog/queries`, at most five pages per attempt | `200` and a collection envelope with `value` |
| Poll one query | `GET /v1.0/security/auditLog/queries/{auditLogQueryId}` | `200` and a direct `auditLogQuery` object |
| Read records | `GET /v1.0/security/auditLog/queries/{auditLogQueryId}/records` | `200` and a collection envelope with `value` and an optional validated `@odata.nextLink` |

The query status allowlist is `notStarted`, `running`, `succeeded`, `failed`, `cancelled` and `unknownFutureValue`. Unknown fields, envelope shapes and malformed provider timestamps fail closed as provider-schema errors, not caller-input errors. Redirects and pagination links outside the exact Graph origin and path family are rejected before an authorization header is attached. Continuations may carry only an opaque nonempty `$skiptoken` or numeric `$skip`, with an optional bounded `$top`; added filters, projections, duplicate parameters and control characters fail closed. Empty, malformed or repeated continuation links also fail closed, including on the last allowed page; a local limit never makes an invalid link trustworthy.

Provider query IDs remain opaque, case-sensitive and untrimmed within the 512-character limit. Dot segments, path/query/fragment separators and C0/C1 controls are rejected before persistence or dispatch; IDs from malformed provider responses are provider-schema errors. A continuation must include its paging selector even when reading from an already-resumed start URL; it cannot restart at the unpaged collection.

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

- Viewer and Admin may submit bounded searches under current real authorization and read/export only locally authorized results. Job resume/cancel/delete retain authorizing-principal ownership. No preceding qualification or approval endpoint is part of the workflow.
- Delegated mode is private to the authorizing principal and requires that user to hold the Purview **Audit Logs** or **View-Only Audit Logs** role.
- Application mode requires current tenant/client credentials, enabled configuration, application permission and configured shared scope. An authorized Viewer may submit shared reads. It neither converts private delegated results into shared data nor provides automatic fallback authority.
- Both modes use `AuditLogsQuery.Read.All`. Personal Microsoft accounts and non-global clouds are unsupported by this implementation.
- Microsoft Purview licensing, unified audit logging, workload support, retention, service limits and tenant rollout independently control whether a query can run and what it can observe.

Microsoft's [Audit comparison](https://learn.microsoft.com/en-us/purview/audit-solutions-overview) lists the Audit Search Graph API for both Audit (Standard) and Audit (Premium); Premium adds capabilities such as longer retention and higher Management Activity API bandwidth. That bandwidth statement is not a Graph Audit Search quota guarantee. The [Copilot audit reference](https://learn.microsoft.com/en-us/purview/audit-copilot) describes Microsoft and Copilot Studio applications as included in Audit Standard, but [Get started with auditing](https://learn.microsoft.com/en-us/purview/audit-get-started) also includes Copilot Studio in its non-Microsoft 365 AI pay-as-you-go discussion. Do not infer universal entitlement or absence of billing from either statement; the tenant administrator must confirm the exact workload's current license and billing prerequisites.

The get-started guide maps the Purview Audit Reader and Audit Manager role groups to **View-Only Audit Logs** and **Audit Logs**; Graph application permissions are a separate requirement. [Audit retention policies](https://learn.microsoft.com/en-us/purview/audit-log-retention-policies) describe typical 180-day retention, with eligible Premium workloads/users and configured policies potentially retaining records longer. These source policies are not the application's seven-day query limit or 30-day local cache lifetime.

A successful explicit search lifecycle proves only the selected API contract and effective access for that exact identity, mode and configuration at that time. A token-only automatic check does not prove provider-operation or license access. In particular, a successful empty query does not prove licensing for every workload, event emission, historical retention or comprehensive source coverage. Verify those prerequisites separately and keep absent or unobserved records explicit.

Missing grant, Purview role, application-scope approval, tenant support, license or a failed explicit lifecycle leaves the capability visible with a bounded error category and correlation ID. Interactive consent, MFA and Conditional Access are reported as interaction needed, not missing permission. Unknown, unprobed and checking are not failures. Do not grant broader permissions to clear an unavailable state; repair the exact prerequisite and retry the ordinary bounded search when appropriate.

## Curated Searches And Bounds

The UI exposes two code-owned presets:

- **Copilot interactions:** service `Copilot`, record type `copilotInteraction`, operation `CopilotInteraction`.
- **Copilot Studio administration:** service `PowerPlatform`, record type `powerPlatformAdministratorActivity`, and explicit bot, bot-component, AI-plugin-operation and environment-variable create/update/delete or publish/share/auth/name/icon operations.

Users may narrow a preset with exact UTC start/end times, user principal names, IP addresses, object IDs and administrative-unit UUIDs. Each identity-filter array accepts at most 20 unique validated values; UPNs are whitespace-free exact values of at most 320 characters. Searches cover at most the most recent seven days.

| Boundary | Limit |
| --- | --- |
| Copilot interactions | Copilot interaction metadata supplied by Purview |
| Copilot Studio administration | Supported bot, component, plugin, publishing, sharing, and environment-variable administration events |

Results can include actor, operation, time, result, target, and correlation
metadata when Microsoft supplies those values. Agent Control does not collect
prompt text, response text, or conversation transcripts.

## Run a search

An exact row or byte boundary reports `audit_row_limit` or `audit_byte_limit` when a continuation remains; a fully consumed final page remains complete even at the boundary. A page that exceeds the aggregate byte budget still has its envelope and continuation validated before returning prior-page partial evidence. Loop detection normalizes numeric `$skip` and `$top` values without changing opaque `$skiptoken` values. Durable request-admission and response-recording callbacks share the attempt deadline. Unexpected local bookkeeping failures, including callback timeouts, stop with `internal_error`; they are not retried as network errors or published as partial provider results. A record-body attempt timeout is `provider_error`, not `audit_activation_timeout`; only expiry of the enclosing activation uses the latter category. Query responses recheck cancellation and attempt deadlines after JSON consumption, before accepting a returned query or page. An interrupted create remains `audit_create_inconclusive` and requires reconciliation, never an automatic second POST. Rejected and redirected response bodies are cancelled before returning or retrying, without waiting for cleanup that could stall indefinitely or replace the authoritative response status.

Fetch and retry waits are raced against finite deadlines even when their implementations ignore cancellation. Late fetch responses are disposed and late rejections observed. Only 429, 500, 502, 503 and 504 responses are eligible for read retries; create is never retried. Retry-After accepts nonnegative delta seconds or a valid HTTP date, uses valid response Date headers when available, and never shortens a large provider cooldown to fit the local budget. Received HTTP status, validated correlation IDs and Retry-After survive provider failures; provider bodies remain private, including when response consumption times out.

The initiating session and capability generations are checked synchronously immediately before each physical request and after awaited admission, transport, body and retry work, including rejections. Result persistence rechecks that same authority immediately before transaction commit. Saved JSON and CSV release are likewise fenced after awaited reads and auditing; a replacement session cannot adopt stale work.

Job submission retains initiating session/capability authority and rechecks provider admission immediately before commit. Logout, replacement sign-in, configuration changes or actual maintenance during persistence roll back stale work.

### Exact subject binding

The server creates `/v1.0/security/auditLog/queries`, polls its status, and reads
its records. User searches use `userPrincipalNameFilters` for the person
performing the operation, not an arbitrary mention of the user.

For an agent, the server resolves the selected saved inventory record. Studio
administration uses its exact `BotId`; interactions require a verified Studio
application ID matching `AppIdentity = Copilot.Studio.<applicationId>`. The
appropriate ID is passed as `keywordFilter`, then returned records are checked
against the exact identity before saving. Keyword hits alone are not evidence
of an association. A reported conflicting environment is rejected; optional
environment metadata need not be present.

User-on-agent searches intersect both filters. Bot IDs are not sent as
`objectIdFilters`, and `AgentId` suffixes are never guessed to be bot IDs.
Unsupported log types remain unavailable rather than running broader searches.
Current authorized inventory remains usable while a replacement sync is running.

Agent-specific saved reads revalidate exact source revision, bot/environment and current result visibility after their content-free audit receipt. Source replacement, even with the same bot/environment, withdraws stale in-flight evidence. Reads obtain no provider token and start no search.

Identity reads reselect the authorized snapshots after loading and verifying candidates, and check expiry again before returning them. Replacement, withdrawal, newly selected resource types or expiry during the read returns `snapshot_invalidated` rather than a stale exact association; retry against refreshed inventory.

Authorized record views and CSV exports append content-free local audit events with the job ID, source and resulting count. Result bodies are never copied into local administrative audit. CSV export applies the same principal-private or current configured application-shared result scope as retrieval, caps at 5,000 records and neutralizes spreadsheet formula prefixes. Only locally published `succeeded` or `partial` jobs are exportable; unpublished or failed jobs return `409 audit_job_state`, not an empty successful file.

Delegated searches belong to the authorizing account. Optional application mode
requires separate application permission, Agent Control Admin enablement, and an
approved shared data scope.

**Permissions > Check status** verifies token readiness. It does not run a
Purview query or prove that a query will return records.

## Jobs and retention

Search jobs support status, paging, export, cancellation, and local deletion.
Closing the browser does not cancel an accepted Microsoft query.

Cancel stops local polling/download and records that Microsoft Graph may continue the remote query. Delete removes only a non-running local job and its cached rows. A rejected cancel or delete does not interrupt the active worker. The selected Microsoft contract exposes no remote cancel or delete operation, so the product never claims either action changes the provider query or source events. Failed and inconclusive local jobs report possible remote continuation from the attempted request and last provider status, not from the local failure category.

Cancel and local delete retain the initiating account and capability-generation authority through transaction commit. A superseded account or changed saved-data scope cannot commit either command. These saved-only commands remain available while provider admissions are closed and do not acquire tokens or require live provider readiness.

Waiting-for-authorization jobs can also be cancelled directly from history without resuming a provider request or deleting the recovery record. If the 48-hour execution deadline expires during collection or bounded publication authorization, an owned, still-retained result is saved as `partial` with `audit_job_expired`; even a fully downloaded result cannot qualify the capability after that deadline. Cancellation/recovery ownership fences and the separate 30-day local-cache expiry still prohibit stale publication.

The durable deadline is rechecked after request accounting and final job writes. Accounting that crosses it rolls back before dispatch; finalization preserves retained rows as partial rather than claiming complete evidence. Crossing the separate cache expiry rolls publication back.

Jobs/results expire after 30 days through operator retention. The 48-hour deadline first makes unfinished work inconclusive while preserving whether remote work may continue. View/export audit follows the ordinary 90-day policy. Microsoft source-event retention and remote query lifetime remain separate provider policies; local expiry does not establish either.

| Problem | Check |
| --- | --- |
| Search is unavailable | Confirm app role, Graph consent, Purview role, and tenant Audit availability. |
| Search returns no records | Confirm the user, preset, date range, and Microsoft source coverage. |
| Search is partial | Review the stored page and row limits and any provider error. |
| Agent records are unavailable | Refresh inventory and confirm the exact bot and environment association. |
| A saved job disappeared | Confirm it was not deleted, expired, or removed by a scope change. |

Microsoft reference:

- [Create an audit query](https://learn.microsoft.com/en-us/graph/api/security-auditcoreroot-post-auditlogqueries?view=graph-rest-1.0)
- [Audit log query resource](https://learn.microsoft.com/en-us/graph/api/resources/security-auditlogquery?view=graph-rest-1.0)
- [Copilot audit identities](https://learn.microsoft.com/en-us/purview/audit-copilot)
- [Copilot Studio audit schema](https://learn.microsoft.com/en-us/microsoft-copilot-studio/admin-logging-copilot-studio)

The provider contracts and local scope/lifecycle behavior are fixture-tested.
End-to-end collection still needs validation in a tenant with the required
Purview licensing, roles, and audit data; token readiness alone is not that proof.
