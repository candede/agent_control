# Phase 07 - Microsoft Graph Purview Audit Search

## Status

```yaml
phase_file: 07-graph-audit-search.md
phase_status: complete
outcome: completed_with_disabled_capabilities
validated_at_utc: 2026-09-09T13:30:08Z
execution_target: retained local Docker project agent-control-phase01; isolated PostgreSQL/browser/restart fixtures; no Azure or live provider changes
```

Phase 07 is implemented, parent-reviewed, validated and deployed locally at http://localhost:3001. Final Docker gates passed: backend 372/372, frontend 103/103, browser 38/38, typecheck, lint, production builds, compiled restart recovery, persistence, backup/isolated restore, retention and Linux x64 packaging. The provider gate remains closed because no approved tenant identity, permission grant or bounded live query was supplied. This is the phase's permitted fixture-complete, disabled-provider outcome, not live Graph qualification.

The retained project has exactly two healthy services, `app` and `postgres`, with migration 17 applied and running-artifact schema checksums verified. `/api/health` and `/api/ready` return `200 {"ok":true}`; `/api/auth/status` returns `authConfigured:false`. Retained Purview jobs, records, qualifications and capability evidence are all zero; package qualifications are zero. After exact owned-fixture cleanup, the only non-template databases are `agentcontrol` and `postgres`.

No branch, commit, push, Azure deployment, provider grant, live Graph query, remote cancel/delete claim, transcript retrieval, continuous collection, official-usage substitution, campaign ledger, reset or Phase 08 implementation occurred. Migration 17 is the forward repair of Phase 07 migration 16; earlier applied SQL was preserved. Migrations 1-17 are now applied and immutable. Future schema work starts at 18.

## Selected Graph Contract

Microsoft sources were rechecked on 2026-09-09. Agent Control selects exactly this global Microsoft Graph v1.0 lifecycle:

| Operation | Exact contract |
| --- | --- |
| Create | `POST /v1.0/security/auditLog/queries`; singular `serviceFilter`; `201` direct `auditLogQuery` object |
| Reconcile unknown create | `GET /v1.0/security/auditLog/queries`; collection envelope with `value`; exact durable marker and filters |
| Poll | `GET /v1.0/security/auditLog/queries/{auditLogQueryId}`; `200` direct `auditLogQuery` object |
| Records | `GET /v1.0/security/auditLog/queries/{auditLogQueryId}/records`; collection envelope with `value` and optional validated `@odata.nextLink` |

The create body contains only `displayName`, `filterStartDateTime`, `filterEndDateTime`, `recordTypeFilters`, singular `serviceFilter`, `operationFilters`, `userPrincipalNameFilters`, `ipAddressFilters`, `objectIdFilters` and `administrativeUnitIdFilters`. The accepted statuses are `notStarted`, `running`, `succeeded`, `failed`, `cancelled` and `unknownFutureValue`. Create/get collection wrappers, direct list responses, plural `serviceFilters`, unknown fields, redirects and foreign pagination origins fail closed. There is no runtime fallback request.

The current [create](https://learn.microsoft.com/en-us/graph/api/security-auditcoreroot-post-auditlogqueries?view=graph-rest-1.0), [query list](https://learn.microsoft.com/en-us/graph/api/security-auditcoreroot-list-auditlogqueries?view=graph-rest-1.0) and [record list](https://learn.microsoft.com/en-us/graph/api/security-auditlogquery-list-records?view=graph-rest-1.0) pages use the `AuditLogsQuery-*` permission family, and create uses singular `serviceFilter`. The [single-query GET](https://learn.microsoft.com/en-us/graph/api/security-auditlogquery-get?view=graph-rest-1.0) still lists `ThreatIntelligence.Read.All`; the [resource page](https://learn.microsoft.com/en-us/graph/api/resources/security-auditlogquery?view=graph-rest-1.0) still describes plural `serviceFilters`. Those conflicts remain the reason for live lifecycle qualification. Agent Control requests only `AuditLogsQuery.Read.All`, does not request the unrelated permission, and does not treat fixture success as Microsoft tenant evidence.

The GET page also describes a direct query object in prose but shows an object wrapped in `value`, with `keywordFilter`, in its example. Both variants are rejected by this selected direct-object contract. Create/poll responses must match the durable marker and filters; GET must additionally return the stored query ID. A bounded query listing must be complete before one matching marker can establish unique create reconciliation.

Projection version 1 is also source-bound. Graph defines the outer `#microsoft.graph.security.auditLogRecord` and its string `userType`, while the Office common schema defines native record types `256` (`PowerPlatformAdministratorActivity`) and `261` (`CopilotInteraction`) plus numeric `UserType` values 0-10. The native user type is validated but not exposed. Graph's `defaultAuditData` resource documents no child properties, so native fields come only from the Office and Purview audit schemas. Copilot metadata must be below `CopilotEventData`; message metadata follows the newer emitted example's exact `Messages[].ID` and lowercase `Messages[].isPrompt` casing. Conflicting older `Id`/prose `IsPrompt` casing is not accepted as an alias. Only IDs and flags are retained, never message content. [Graph wrapper](https://learn.microsoft.com/en-us/graph/api/resources/security-auditlogrecord?view=graph-rest-1.0), [default audit data](https://learn.microsoft.com/en-us/graph/api/resources/security-defaultauditdata?view=graph-rest-1.0), [Office schema](https://learn.microsoft.com/en-us/office/office-365-management-api/office-365-management-activity-api-schema), [Copilot schema](https://learn.microsoft.com/en-us/office/office-365-management-api/copilot-schema), [Purview Copilot reference](https://learn.microsoft.com/en-us/purview/audit-copilot).

The current [Copilot Studio audit reference](https://learn.microsoft.com/en-us/microsoft-copilot-studio/admin-logging-copilot-studio) confirms the selected administrative operation labels, native logical `ID` GUID casing, `BotId`, `BotComponentId` and `AIPluginOperationId`. The generic common schema's `Id` is not a native-ID alias, and a missing native ID is not replaced by the Graph wrapper ID. The same source explicitly separates audit metadata from chat transcripts.

## Delivered Contracts

- **Capability gate:** `purview.audit.search.delegated` and `.application` use `live_qualification`. Routine Permission Center refresh records no synthetic success and creates zero provider queries. Qualification is a separately approved one-hour maximum create/poll/records lifecycle bound to capability, mode, principal, contract, permission and configuration revisions.
- **Authorization:** SecurityReader is required for jobs, records and exports. Qualification approval additionally requires Administrator. Delegated users require the Purview **Audit Logs** or **View-Only Audit Logs** role. Application mode additionally requires Administrator enablement and approved shared data scope. Both modes use `AuditLogsQuery.Read.All`; Purview licensing, unified audit logging, workload support, retention and tenant rollout remain provider prerequisites.
- **Licensing evidence:** Graph Audit Search is listed for Standard and Premium; Premium's Management Activity API bandwidth statement does not establish a Graph quota. Microsoft's Copilot and get-started pages differ on Copilot Studio Standard inclusion versus non-Microsoft 365 AI pay-as-you-go guidance. The tenant administrator must verify exact workload licensing/billing, audit enablement and provider roles separately. Typical source retention is 180 days, with eligible Premium workloads/users and policies differing. Even an empty successful lifecycle proves only exact API access at that time, not event emission or comprehensive coverage. See the linked [runbook eligibility sources](../../../docs/purview-audit-search.md#authorization-and-eligibility).
- **Curated filters:** `copilot_interactions` selects service `Copilot`, record type `copilotInteraction` and operation `CopilotInteraction`. `copilot_studio_admin` selects `PowerPlatform`, `powerPlatformAdministratorActivity` and a code-owned allowlist of bot, bot-component, AI-plugin-operation and environment-variable administration operations. Users select a nonempty operation subset and may supply only validated UTC range, UPN, IP, object ID and administrative-unit filters.
- **Admission and caps:** Ordinary range is at most the most recent seven days; qualification is at most one hour; each filter list has at most 20 unique values. Four activations may run in-process, with five unfinished jobs per principal and ten per tenant. Every physical attempt atomically reserves one of 64 durable request slots immediately before `fetch`; each logical request has at most three attempts, a 30-second budget, ten seconds per attempt and 2 MB per response. Each job has at most 12 activations; each activation has a 60-second bound and six jittered polls. Records cap at 20 pages, 5,000 stored rows and 8 MB. Durable execution expires after 48 hours.
- **Durable create identity:** The code-owned `agent-control-audit:{jobId}` marker, immutable filters, authority, idempotency key and correlation ID persist before POST. Create dispatch has no retry. An unknown create outcome reconciles through at most three bounded query-list attempts and never submits a second create. Provider query ID persists before polling.
- **Recovery and fencing:** Shutdown drains active work. Startup only converts interrupted work to `waiting_authorization` and performs zero Graph operations. Explicit resume revalidates current account, role, capability, shared scope when applicable and exact token before reconciliation, polling or publication. Account change/logout aborts and fences publication without waiting under the account lock. Completed and inconclusive work does not replay.
- **Coverage truth:** Page, row, byte, request or time bounds preserve observed minimized rows as `partial` when current publication authorization succeeds and expose the requested range as unobserved. A separate 10-second final authorization allowance permits publication after activation timeout (`audit_activation_timeout`), remains linked to cancellation/logout and does not permit further Audit Search requests. Provider/schema/permission failures cannot become empty success. History and detail report selected operations, structured filters, authorizing actor, result scope, provider/local request IDs, requested/observed range, counts, budgets, page completeness, expiry and remote-work caveats.
- **Minimized records:** Provider responses are discarded after strict validation. Stored fields are native/wrapper event IDs, event time, record type, operation, service, result, actor/object/IP/administrative-unit identifiers, correlation, agent/app/host/Bot/environment/component/plugin IDs, bounded message IDs and unknown-field counts. Raw `auditData`, provider response archives, prompt text, response text and transcripts are prohibited.
- **Content statement:** Every result and export states `Content not present in Purview audit`. Message IDs and `isPrompt` are metadata only. Purview is compliance/security evidence and is never presented as official Microsoft 365 Copilot Agents usage.
- **Identity:** Native event identity deduplicates only within one query result while query provenance remains. Tenant organization mismatches fail. Cross-source association requires exact Bot ID plus environment against the initiating principal's current private Power Platform snapshot. Agent/package/app IDs, names, owners and timestamps are not interchangeable; missing and ambiguous matches remain separate.
- **Privacy and audit:** Delegated results remain tenant/principal-private. Application results are visible only through the current configured tenant/application scope revision before retrieval, counts, paging and CSV. Authorized record views and exports append body-free local audit events with source/job/count only. Formula-safe export caps at 5,000 records. Local administrative audit remains a separate source tab and contract.
- **Local-only controls:** Cancel stops local polling/download and states that Microsoft may continue. Delete removes only terminal local job/cache rows. No remote cancel, delete or provider-event removal is claimed or invented.
- **Retention:** Jobs and dependent minimized rows expire after 30 days. The 48-hour deadline first marks active work inconclusive and preserves whether any attempted create may continue remotely. Qualification approval expires after one day; detached expired qualification history has a finite additional cleanup window. Body-free view/export audit follows the existing 90-day policy. Microsoft source retention and remote query lifetime remain independent.
- **Provider read contract:** Phase 10 can consume the typed scope-aware job/record repository without a continuous-feed or cross-channel merge framework. Phase 08 can use the same capability, auth, bounded-job and source-separation patterns without reusing Purview records as Defender results.

## Migrations 16 And 17

Migration 16 adds `purview_audit_qualifications`, `purview_audit_jobs` and `purview_audit_records`, plus the two local audit actions `view-audit-search` and `export-audit-search`. Migration 17 adds principal-private and configured application-shared result scopes, scope-aware uniqueness and relationships, execution owner/version fencing, provider/local request separation, 64-request and 12-activation counters, projection versions and operation-filter population. It rebinds existing qualification/job request hashes to the populated filter contract, preventing false idempotency and qualification mismatches after upgrade. Runtime grants allow only repository operations; operator retention owns expiry cleanup.

Fresh schema creation, checksum verification, partial-schema grant tests, populated 16-to-17 upgrade, exact request-hash parity, ordinary retention and native isolated backup/restore pass. Qualification evidence remains independently retained after its shorter-lived job expires. A same-phase retention regression keeps ambiguous attempted creates marked `remote_work_may_continue=true` even before a provider query ID is known. Migrations 1-16 were not edited. Future schema work starts at migration 18.

## User Experience

The Audit log screen defaults to local control audit and opens Purview Audit Search only through an explicit source tab. The provider screen contains mode/preset/range/visible operation selection/structured filters, two-step qualification, explicit run, server-paged history, authorizing actor and result-scope provenance, status polling/resume, local cancel/delete, partial-range warnings, minimized record paging and export. Local/Purview source language, content absence, remote continuation, retention and official-usage separation remain visible.

The final Chromium/axe run recorded 38 expected successes, zero unexpected results, zero skips, zero flaky tests and no report errors. The [browser report](../../../artifacts/phase03/permission-browser-results.json) began at `2026-09-09T13:17:04.476Z`; the parent opened and reviewed both [desktop](../../../artifacts/phase03/purview-audit-desktop.png) and [mobile](../../../artifacts/phase03/purview-audit-mobile.png) screenshots. The 20-test component suite covers ownership changes, stale history/record/poll/mutation/export callbacks, exact-filter binding, capability and qualification expiry, selection replacement and saved-result readability. A keyed inner component resets ownership state synchronously on account/capability changes; expiry uses a timer, without suppressing lint rules.

## Changed Files

- Backend contract and lifecycle: [capability types](../../../backend/src/types/capability.ts), [Purview types](../../../backend/src/types/purviewAudit.ts), [capability registry](../../../backend/src/services/capabilityRegistry.ts), [capability service](../../../backend/src/services/capabilities.ts), [Graph adapter](../../../backend/src/services/graphAuditSearch.ts), [Purview worker](../../../backend/src/services/purviewAudit.ts), [repository](../../../backend/src/db/purviewAudit.ts), [schema](../../../backend/src/db/schema.ts), [routes](../../../backend/src/routes/purviewAudit.ts), [app](../../../backend/src/app.ts), [server](../../../backend/src/server.ts), and related protocol, repository, service, route, authorization and capability tests.
- Frontend: [API client](../../../frontend/src/api/client.ts), [local audit owner](../../../frontend/src/components/AuditLogView.tsx), [Purview audit view](../../../frontend/src/components/PurviewAuditView.tsx), [view tests](../../../frontend/src/components/PurviewAuditView.test.tsx), [application styles](../../../frontend/src/App.css), and [browser qualification](../../../frontend/browser/permissions.spec.ts).
- Operations and recovery: [database operator](../../../backend/scripts/database.ts), [database tests](../../../backend/scripts/database.test.ts), [restart seed](../../../backend/scripts/restart-fixture.ts), [compiled restart proof](../../../backend/scripts/restart-runtime.mjs), package/runtime checks and generated browser/ZIP artifacts.
- Documentation: [README](../../../README.md), [Audit Search runbook](../../../docs/purview-audit-search.md), [security model](../../../docs/security-model.md), [provider inventory](../../../docs/provider-contract-inventory-2026-09-08.md), and this completion record.

The existing shared [bounded response reader](../../../backend/src/services/providerJson.ts) now supports aborting response-body consumption; its tests and other adapter regressions passed. Backend, frontend and deployment/test consumers were checked together. Existing Compose, Docker packaging, local deployment and approved npm-feed contracts remain sufficient; no new long-running service or Azure infrastructure change was required. Preexisting Phase 01-06 and user changes, including [UserAccessView](../../../frontend/src/components/UserAccessView.tsx) and the four already-deleted browser reporting modules, were preserved.

## Validation Evidence

All application, Node, npm, test, build, browser and database work ran in Docker; only orchestration/Git/file tools ran on the host. These final results supersede historical 339/89 and earlier worker-only counts. Commands below were run from the repository root against the current worktree, using the retained project's guarded isolated test databases and approved Microsoft npm registry.

| Check | Status | Final observed result |
| --- | --- | --- |
| Graph transport, protocol and projection | passed | 28/28 tests. |
| Durable Purview worker | passed | 30/30 tests; combined adapter/worker rerun 58/58. |
| Purview repository with guarded PostgreSQL | passed | 16/16 tests. |
| Database/migration suite | passed | 17/17, including populated 16-to-17 request-hash parity. |
| Application HTTP suite | passed | 27/27, including scoped CSV provenance and authorization. |
| Purview frontend component | passed | 20/20 tests. |
| Aggregate backend/frontend | passed | 372/372 across 39 backend files; 103/103 across 15 frontend files. |
| Typecheck, frontend lint and production builds | passed | Successful final local deployment; no lint rules suppressed. |
| Browser | passed | 38/38, no failures/skips/flaky results; desktop/mobile screenshots inspected. |
| Compiled restart | passed | Zero startup Purview calls or repeated creates; explicit reconciliation/poll/download only. |
| Persistence and native backup/isolated restore | passed | Redeployment/database restart preserve data fingerprints, credentials and origin. |
| PowerShell orchestration | passed | 19/19 assertions. |
| Operator retention | passed | Existing finite cleanup completed without provider calls. |
| Linux/amd64 package and export | passed | ZIP 18,849,254 bytes; extracted Node 24.20.0 linux/x64 runtime and secret scan passed; package smoke `zipInspected:true`. |
| Retained runtime and cleanup | passed | Healthy two-service project; schema 17/17 and checksums verified; sign-in unconfigured; zero provider fixtures/evidence; only `agentcontrol`/`postgres` databases remain. |
| Editor and diff hygiene | passed | Targeted changed-file diagnostics clear; `git diff --check` passed. |
| Live qualification | unavailable | No approved provider identity/lifecycle; both Audit Search capabilities remain disabled. |

Exact focused invocations:

```bash
docker run --rm --mount "type=bind,source=$PWD/backend/src,target=/app/backend/src,readonly" --entrypoint npm agent-control-phase01-operator:local run test --workspace backend -- src/services/purviewAudit.test.ts src/services/graphAuditSearch.test.ts
docker run --rm --mount "type=bind,source=$PWD/frontend/src,target=/app/frontend/src,readonly" --entrypoint npm agent-control-phase01-operator:local run lint --workspace frontend
docker run --rm --mount "type=bind,source=$PWD/frontend/src,target=/app/frontend/src,readonly" --entrypoint npm agent-control-phase01-operator:local run test --workspace frontend -- src/components/PurviewAuditView.test.tsx
```

Exact final aggregate, integration and packaging invocations (each succeeded after the repairs recorded below):

```powershell
pwsh -NoProfile -File ./deploy-local.ps1 -Project agent-control-phase01
pwsh -NoProfile -File ./scripts/permission-browser.tests.ps1 -Project agent-control-phase01
docker build --target operator -t agent-control-phase01-operator:local .
pwsh -NoProfile -File ./scripts/restart-runtime.tests.ps1 -Project agent-control-phase01
pwsh -NoProfile -File ./scripts/persistence.tests.ps1 -Project agent-control-phase01 -Port 3001
pwsh -NoProfile -File ./scripts/local-deployment.tests.ps1
pwsh -NoProfile -File ./deploy-local.ps1 -Action Retain -Project agent-control-phase01
docker build --platform linux/amd64 --target package -t agent-control-phase01-package .
docker build --platform linux/amd64 --target export --output type=local,dest=artifacts .
```

Exact extracted-ZIP and deployed-package checks (secret file references only, never secret values):

```bash
docker run --rm --platform linux/amd64 --network agent-control-phase01_default \
	--mount "type=bind,source=$PWD/.local/agent-control-phase01/secrets/postgres-app,target=/run/secrets/postgres-app,readonly" \
	--mount "type=bind,source=$PWD/.local/agent-control-phase01/secrets/session,target=/run/secrets/session,readonly" \
	-e PGHOST=postgres -e PGUSER=agentcontrol_app -e PGDATABASE=agentcontrol \
	-e PGPASSWORD_FILE=/run/secrets/postgres-app -e SESSION_SECRET_FILE=/run/secrets/session \
	--entrypoint node agent-control-phase01-package backend/scripts/zip-runtime-smoke.mjs
docker run --rm --network agent-control-phase01_default \
	--mount "type=bind,source=$PWD/artifacts,target=/evidence,readonly" \
	agent-control-phase01-operator:local backend/scripts/package-smoke.ts \
	http://app:3001 /evidence/agent-control-linux-x64.zip
git diff --check
```

The compiled restart proof reported `purviewProviderCallsAtStartup:0`, `purviewCreatesAfterResume:0`, `purviewReconciliationsAfterResume:1`, `purviewPollsAfterResume:1`, `purviewDownloadsAfterResume:2` and `purviewCompletedReplays:0`. Existing package completed/uncertain/canary replays also remained zero. Official usage crash recovery retained lineage 3, responses 7 and distinct users 2, with `originalBytesRetained:false`.

### Failures And Repairs

- Parent incomplete-list reconciliation regression was RED (7 passed, 1 failed), then GREEN after requiring a complete listing before accepting a unique marker match. No second POST was added.
- Populated migration 16-to-17 request-hash parity was RED, then repaired in the new forward migration before it was deployed. The final database suite passed.
- First final deployment failed TypeScript because `audit_time_limit` was not a valid partial-reason value. Code and regression now use `audit_activation_timeout`; focused 58/58 and final production compilation passed.
- Next deployment passed 372/103 tests but failed two frontend effect-state lint checks. Keyed ownership reset and timer-based qualification expiry repaired the component; lint, 20/20 component tests and the full deployment passed.
- Initial final restart proof failed `invalid_audit_publication`: its successful mock/seed omitted `partialReason:null`. Both fixtures were aligned with the final contract, terminal-start assertions were updated for idempotent existing-job return, and failed-seed cleanup was added. The rebuilt compiled-runtime proof passed with the exact no-replay counters above.
- Documentation lookup attempts at obsolete guessed Copilot Studio URLs returned 404. The current official table of contents resolved `admin-logging-copilot-studio`; that page, not the failed guesses, is the operation/native-ID authority cited above.

### Retained Environment And Cleanup

The Phase 01 local topology, retained volume `agent-control-phase01_data`, project network `agent-control-phase01_default`, restricted existing secrets and canonical origin/callback were preserved. PostgreSQL has no published host port; the app remains on loopback port 3001. Running-artifact `verifySchema(pool)` passed, and read-only SQL confirmed migrations 17/17, Purview jobs/records/qualifications/evidence `0/0/0/0`, and package qualifications `0`.

Final inspection found six empty guarded test databases and one abandoned failed restart fixture. Before exact-name deletion, the latter was verified by its synthetic fixture identity, `/fixture/restart` jobs, matching `13:17:49Z` creation time and three `purview-restart-*` intents; it had no sessions or official usage sets. The following seven owned databases were dropped individually with `psql -v ON_ERROR_STOP=1`, not by a wildcard or broad cleanup:

```text
agentcontrol_test_20260909124954_74102
agentcontrol_test_29c0c048af1f4e3f8bb9afad9374b1b1
agentcontrol_test_phase07partial1788956930
agentcontrol_test_phase07partial1788956980
agentcontrol_test_phase07repo1788957331
agentcontrol_test_phase07repo1788957419
agentcontrol_test_phase07repo1788957435
```

All seven drops succeeded; the final non-template inventory contains only `agentcontrol` and `postgres`. Successful browser/restart/restore harness resources were also cleaned. No retained user data, unrelated Docker resources or credentials were removed. Final documentation-only corrections do not change the validated runtime artifact.

## Live Qualification Residual

| ID | Affected scope / evidence | Containment | Signal / threshold | Owner | Exact fix-forward trigger |
| --- | --- | --- | --- | --- | --- |
| P07-LIVE-AUDIT | Delegated and application Graph Audit Search have fixture-complete contracts but no approved tenant lifecycle; retained auth is unconfigured and Purview evidence count is zero | Both capabilities require `live_qualification`; routine refresh creates zero queries; no fallback property, unrelated permission, synthetic result or provider availability claim; local administrative audit and saved local data remain independent | Any request to enable Audit Search, Microsoft contract change, `serviceFilter`/GET permission resolution, or approved tenant grant/role/license becoming available | Tenant Purview/Entra administrator and Phase 13 live-qualification owner | Configure the approved existing identity through restricted inputs; verify unified audit logging, licensing, delegated Purview role or application shared scope; recheck all four cited Graph pages; approve one recent one-hour query using exactly `AuditLogsQuery.Read.All` and singular `serviceFilter`; prove `201` direct create, direct GET poll and collection record list; retain only provider ID/status/correlation and minimized local result, then let ordinary local retention remove it. A denial, conflicting shape or inconclusive create leaves the capability disabled and records only safe evidence. |

All required local implementation and validation work is complete. Fixture success does not prove tenant permission, Purview role, license, unified audit logging, workload records, provider retention or live contract behavior. The exact live recheck remains owned above; it is not permission to grant broader access or perform Azure deployment in this phase.

Inherited live-identity and frontend bundle-size residuals remain linked to the [Phase 01 origin record](01-domain-persistence-foundations.md). The final Vite main chunk is 795.87 kB minified / 228.97 kB gzip; the build succeeds and the existing Phase 10 performance owner is unchanged. The preexisting `express-session` unused-secret deprecation appears in policy tests; no warning or test was suppressed.

## Phase 08 Preconditions

Migration 17 is deployed. In a separately requested session, Phase 08 may consume migrations 1-17, independent app roles, multi-resource Graph auth, capability `live_qualification`, durable bounded jobs, account/session fencing, scope-aware source records, exact Power Platform identity rules, local administrative audit and the source-separated UI patterns. Existing Phase 06 official-usage authority and privacy contracts remain intact.

Phase 08 must keep Defender hunting independent from Purview and official usage; use only `ThreatHunting.Read.All` under its own delegated/application capability and approved shared scope; accept only curated code-owned KQL templates with structured parameters; preserve tenant/principal/data-source coverage; and avoid continuous collection, transcript retrieval, arbitrary KQL, cross-source identity guessing or production/Azure activity without separate authorization. Migration 18 is the next schema version.

## Next Session

Phase 07 is complete with disabled live Audit Search capabilities. Phase 08 was not started. The next session must verify this record and the named earlier owners against the current dirty worktree, preserve the retained environment, and leave migrations 1-17 unchanged. Copyable instruction for a separately authorized next session:

```text
Implement only plans/admin-poc-production/08-defender-agent365-hunting.md.
Read the roadmap README, Phase 07 completion record and named prerequisite owners.
Verify delivered artifacts in the current worktree; preserve unrelated changes.
Implement, validate and document every Phase 08 requirement. Use Docker tooling
and the retained agent-control-phase01 local deployment without reset or secret
rotation. New schema work starts at migration 18. Follow current delegated
on-demand authorization; optional qualification never gates ordinary delegated
searches. Preserve separate application/shared-scope approval. Do not commit, push,
deploy to Azure or change provider grants. Stop before Phase 09.
```