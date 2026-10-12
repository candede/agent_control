# Microsoft Purview Audit Search

Agent Control uses Microsoft Graph Audit Search for explicit, bounded Purview
queries. Purview records are investigation evidence, not Microsoft 365 Copilot
usage totals.

## Where to use it

- **Users > user details > Logs > Purview audit** runs a search for the selected
  directory user.
- **Agents > agent details > Activity > Purview audit** searches records for the
  selected agent.
- **Agents > agent details > Users > user name** opens Logs for that user on
  that agent. The report user must resolve to a verified directory identity.
- **Audit** contains only administrative actions performed through Agent
  Control.

Opening a tab does not start a Microsoft query. Select the filters and run the
search explicitly.

## Requirements

- Microsoft Graph delegated `AuditLogsQuery.Read.All`
- Tenant-wide admin consent
- Purview Audit enabled for the tenant
- Purview **Audit Logs** or **View-Only Audit Logs** access
- `AgentControl.Viewer` or `AgentControl.Admin`

Recommended user access is **Security Reader** in Entra ID plus **Audit Reader**
in Purview. See [Microsoft roles](user-roles-and-permissions.md).

## Available searches

**Check permissions** runs the same readiness refresh used by Permissions. For Purview delegated access, this checks token readiness, not the provider query lifecycle or complete Microsoft role/license entitlement. The tab distinguishes token verification from provider verification; **Run Audit Search** is the explicit functional create/poll/records check. Missing `AuditLogsQuery.Read.All` consent, Microsoft Purview Audit enablement, and the Audit Logs or View-Only Audit Logs role are surfaced as setup requirements, not empty results. **Open Permissions** remains available for configuration when access is not ready.

When an explicit delegated search or resume completes successfully, the panel refreshes readiness once to display the saved lifecycle evidence without replaying Audit Search. Partial and inconclusive jobs do not claim provider verification. Manual history refresh can retry the readiness read for that completed selection; merely opening saved history does not trigger this lifecycle refresh.

Application mode requires configured application identity/credentials, the application permission, Admin-enabled mode and an approved shared data scope. **Check permissions** does not run application qualification. An Admin selects a window of at most one hour, approves it, then explicitly starts the qualification. Ordinary searches allow up to 168 hours; collection remains bounded to 20 pages and 5,000 stored rows. Actual provider errors and partial coverage remain visible.

`PurviewAuditView` accepts `active?: boolean` (default `true`) for visited tabs that stay mounted. While inactive it renders no content, stops saved-history polling and aborts its owned reads/actions. Form fields and selected-job state are retained in memory for the same account, roles, selected UPN and meaningful capability access/configuration state. Capability timestamp, freshness and verification-only renewals do not remount the form.

On return, the tab reloads the catalog and scoped history, revalidates the exact selected job, and reloads a previously viewed saved record page before displaying it. Saved-query keys include the account/access/user scope so another observer cannot retain a prior account's request for the new account. Denied, deleted, expired or mismatched selections fail closed. Switching tabs neither submits nor resumes provider work, and does not reset the five-minute/150-attempt UI polling budget; an explicit history refresh can restart that budget. Aborting a browser request does not undo an already accepted server query; its saved job can be recovered from history.

Editing draft filters clears the selected results and cancels that selection's pending exact-job or record read, including revalidation on tab return, manual refresh or polling. Independent catalog/history reads and already admitted saved-job commands continue; a retired selection response cannot clear their state or leave the history loading indicator stuck.

Capability responses include the application configuration revision as part of the saved-data authority. A revision change retires prior records, approvals and in-flight commands even when enablement, shared-scope flags and readiness remain unchanged. Diagnostic-only updates still preserve the current view. Manual history refresh hides selected results during revalidation, then preserves the loaded page when the authorized job ID and saved version are unchanged; a different version requires loading current minimized results.

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

- Viewer and Admin with current or safely read-through-refreshed capability readiness may directly submit their own bounded delegated search and access, export, cancel, or locally delete only results authorized for their principal. The actual successful search establishes delegated principal provider evidence; there is no preceding qualification approval/start ritual. Explicit delegated qualification APIs may remain optional but are not prerequisites. Application-mode qualification and shared-scope controls require `AgentControl.Admin`; Admin inherits the delegated Viewer workflow.
- Delegated mode is private to the authorizing principal and requires that user to hold the Purview **Audit Logs** or **View-Only Audit Logs** role.
- Application mode is separately disabled by default. It requires explicit Admin enablement, approved shared data scope and application permission qualification; it does not convert delegated results into tenant-shared data and is never an automatic fallback. Delegated-only deployments keep it disabled.
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

Users may narrow a preset with exact UTC start/end times, user principal names, IP addresses, object IDs and administrative-unit UUIDs. Each identity-filter array accepts at most 20 unique validated values; UPNs are whitespace-free exact values of at most 320 characters, matching user-scoped saved history. Delegated searches cover at most the most recent seven days. A separately configured application/shared qualification remains bounded to at most one hour.

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

Job submission and qualification approval also retain the initiating session/capability authority and recheck it with provider admissions immediately before committing. Logout, replacement sign-in, configuration changes or closed admissions during persistence roll back the write rather than leaving a stale job or approval.

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

Agent-specific saved reads revalidate the exact source revision as well as bot/environment after their content-free audit receipt and current retained-scope checks. Replacing the source, even with the same bot/environment, withdraws the in-flight result instead of releasing stale agent evidence. These reads do not acquire provider tokens or start a search.

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

Qualification approval must remain unexpired at physical dispatch, after asynchronous authorization checks, and through result and capability-evidence persistence. Expiry withdraws the activation without publishing or qualifying stale evidence, marks unfinished work `inconclusive` with `qualification_expired`, and requires new approval rather than repeatedly offering resume. If persisting that terminal expiry state fails, the worker propagates the persistence error rather than treating the qualification deadline's abort as lost authorization; actual authorization revocation and caller cancellation retain their existing handling. Previously published results remain subject to their separate saved-data scope and retention.

Cancel stops local polling/download and records that Microsoft Graph may continue the remote query. Delete removes only a non-running local job and its cached rows. A rejected cancel or delete does not interrupt the active worker. The selected Microsoft contract exposes no remote cancel or delete operation, so the product never claims either action changes the provider query or source events. Failed and inconclusive local jobs report possible remote continuation from the attempted request and last provider status, not from the local failure category.

Cancel and local delete retain the initiating account and capability-generation authority through transaction commit. A superseded account or changed saved-data scope cannot commit either command. These saved-only commands remain available while provider admissions are closed and do not acquire tokens or require live provider readiness.

Waiting-for-authorization jobs can also be cancelled directly from history without resuming a provider request or deleting the recovery record. If the 48-hour execution deadline expires during collection or bounded publication authorization, an owned, still-retained result is saved as `partial` with `audit_job_expired`; even a fully downloaded result cannot qualify the capability after that deadline. Cancellation/recovery ownership fences and the separate 30-day local-cache expiry still prohibit stale publication.

The durable deadline is rechecked after request accounting and after final job/qualification writes. Accounting that crosses it rolls back before dispatch; finalization that crosses it preserves retained rows as partial and downgrades qualification rather than committing complete evidence. Crossing the separate cache expiry rolls publication back.

Jobs and dependent records expire after 30 days through operator retention. The 48-hour deadline first makes unfinished work inconclusive, preserving whether an attempted remote create may continue. Separately configured application/shared qualification approval expires after one day; detached expired qualification history is removed after the additional finite cleanup window. Delegated searches have no preceding qualification approval record. View/export audit expires under the ordinary 90-day local audit policy. Microsoft source-event retention and any remote query lifetime are separate provider policies and are never inferred from local expiry.

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
