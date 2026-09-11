# Phase 09 - Copilot Studio Quarantine

## Status

```yaml
phase_file: 09-copilot-studio-quarantine.md
phase_status: complete
outcome: completed_with_disabled_capabilities
validated_at_utc: 2026-09-09T22:01:31Z
execution_target: retained local Docker project agent-control-phase01; isolated PostgreSQL/provider/browser/restart fixtures; no Azure or live provider changes
```

Phase 09 is implemented, reviewed, tested and deployed at **http://localhost:3001**, with callback **http://localhost:3001/api/auth/callback**. The final runtime retains the original project volume, network and secrets and exactly two persistent services, `app` and `postgres`. Local calendar date was September 10; the recorded UTC command times are September 9.

Live status and mutation qualification are **unavailable**, not fixture-qualified provider behavior. The retained application reports `authConfigured:false`. No explicitly authorized exact live target, canary approval or eligible delegated identity was supplied. Consequently no live status probe, quarantine, unquarantine or restoration was attempted. No grants, roles, credentials, Azure resources, telemetry, transcripts, recurring refresh, commit, push, branch, campaign ledger or per-file hash manifest was created. Phase 10 was read only to identify handoff prerequisites and was not started.

## Prerequisite Verification

Read the plan README and completion template, Phase 08 completion, and Phase 05 mutation/canary, Phase 04 native-ID, Phase 02 authentication and Phase 01/03 Docker/browser records. Inspected the actual controlling MSAL/provider-role, capability, native inventory resolver, durable job, qualification, route policy, recovery and deployment implementations. Completion records were navigation, not implementation proof.

The final aggregate reran current-source MSAL 13, OAuth flows 4, capability 13, inventory identity 5, inventory role 3, Power Platform adapter 14, package adapter 30, package mutation safety 2, package restoration 8, package qualification repository 8, Defender adapter/semantic compiler 21, Defender worker 10, Defender repository 12, and route-policy 2 tests. Existing package access/reassignment safety restrictions remain unchanged. Phase 08 provider-proof versus retained-scope authorization, revocation, projection-v3, source visibility and offline-RBAC tests passed; quarantine cannot consume their identifiers or evidence.

The retained database was observed at migrations 1-22 on continuation: migration 22 had already been applied by the initial Phase 09 implementation. No applied migration was changed. Final verification independently compared every stored checksum with the compiled migrations using the restricted app role. Future additive schema work begins at **23**, not 22.

## Delivered Contracts

### Provider And Authentication

- Only delegated Power Platform `CopilotStudio.AdminActions.Invoke`, audience `8578e004-a5c6-46e7-913e-12f58912df43`, commercial/global cloud, internal `AgentControl.Operator`, and current validated Global Administrator, AI Administrator or Power Platform Administrator role evidence authorize provider work. Reader, Environment Maker, Power Platform built-in RBAC and application tokens are not substitutes.
- [Typed adapter](../../../backend/src/services/copilotStudioQuarantine.ts) uses exact native environment/bot path components, `copilotstudio`, `api-version=1`, no POST body, redirect rejection, correlation IDs, HTTP 200 status-schema validation, 64 KiB response cap and ten-second requests. Safe GET retries have three attempts and a 30-second total budget including bounded retry waits. POST dispatch has no retry or alternate endpoint/version/token-mode fallback.
- Status requires boolean `isBotQuarantined` and UTC `lastUpdateTimeUtc`, preserving up to seven fractional digits rather than comparing lossy timestamps. Missing/malformed/unavailable is never false. Fixed safe error classes distinguish classic 405, exact-target 404, explicit scope/role/Conditional Access/rollout errors, throttling and generic authorization/provider errors; ambiguous responses do not invent a role or license cause, and provider messages/bodies are discarded.
- Capability refresh validates delegated authority without choosing a bot or issuing a quarantine status request. Direct status is an explicit exact-target operation. A successful read or consent does not qualify a write. MSAL remains ephemeral; logout/account generation/role changes fence unsent dispatch and publication, with explicit reauthentication after cache loss.

### Exact Target And Direct State

- [Inventory resolver](../../../backend/src/db/powerPlatformInventory.ts) accepts only one current, unexpired principal-private `microsoft.copilotstudio/agents` snapshot, observed within 24 hours, and one exact native resource row containing one matching `environment_id` and one native `cds_bot_id`. Current selection and exact IDs are checked again at dispatch. Duplicate, missing, stale, superseded and environment-ambiguous selections fail closed.
- Package IDs, display names, Defender IDs, blueprints, associations and manual links never supply a target. Search text only filters already authorized native inventory candidates. Operator receives a minimized control-target list, not the broad Reader inventory contract. Existing unmatched records remain usable without identity-review tooling.
- [Control service](../../../backend/src/services/copilotStudioQuarantineControl.ts) exposes explicit status, preview and submit. Direct observations retain source, observation time, provider update time and correlation independently of inventory. The cache is 60 seconds; force recheck is explicit. Direct reads, pre-reads and readbacks never initiate Resource Query refresh or rewrite an inventory snapshot.

### Durable Mutation And Recovery

- Normal operations freeze 1-25 exact targets from one snapshot, actor, requested state, current direct boolean/timestamp and contract/permission/configuration revisions. All 25 targets are exposed in confirmation. Preview shows maker/channel semantics and independent package control. Submit requires the exact confirmation hash and `Idempotency-Key`; canonical same-intent retries return the original durable receipt before inventory/provider access, while changed intent conflicts.
- [Repository](../../../backend/src/db/copilotStudioQuarantine.ts) and [worker](../../../backend/src/services/copilotStudioQuarantineJobs.ts) allow two active workers, five unfinished jobs per principal, a 30-minute dispatch window, ten claims and 120-second owner/version-fenced leases. Work is on demand only. Each target execution has a 30-second bound; readback attempts default to five. Reconciliation uses a 15-second per-target bound. No token is persisted.
- Per-tenant/environment/bot advisory locks serialize local writes and reconciliation. Under the lock, the worker checks current inventory, exact qualification, unresolved sent work, cancellation and current authority; it performs two pre-reads and compares the frozen boolean/timestamp. Already-correct targets are skipped. Timestamp evidence is not provider atomicity; no undocumented `If-Match` is fabricated.
- Sent intent and audit commit before the one allowed POST. Acceptance alone never yields success. Bounded GET convergence is mandatory. Sent timeout, ambiguous response, nonconvergence, revocation or restart remains durable `inconclusive`; completed/sent writes cannot be replayed. Mixed bulk results are retained independently and are never automatically inverted.
- Recovery offers job discovery/status, cancel-unsent, explicit resume of unsent work, and GET-only reconciliation. Cancellation checks owner scope before signalling the active worker. Reconciliation does not require live write qualification; it requires current delegated Operator/provider authority and exact current inventory. It classifies applied, exact-prestate not-applied/retry-eligible, or intervening conflict. New work requires a fresh preview/approval, never an automatic retry.
- [Canary service](../../../backend/src/services/copilotStudioQuarantineCanaries.ts) and [canary repository](../../../backend/src/db/copilotStudioQuarantineCanaries.ts) reuse Phase 05's separate approval, durable original/restoration jobs, one-time claim and job-backed qualification principles without broadening package behavior. Two inverse Administrator approval records may have the same approver; the executor must differ from every approver. Each approver and executor needs their own current private inventory resolving the exact same native target. Restoration binds to the original verified provider timestamp, not a caller-predicted timestamp. Changed prestate, stale approval, uncertain dispatch or incomplete restoration never publishes qualification.
- Qualification is exact tenant/environment/bot/delegated-mode/contract/permission/configuration evidence, valid for at most 30 days. One canary never qualifies another bot or an entire environment. Normal dispatch rechecks qualification immediately before marking sent. Both directions and final original-state restoration must be proven by durable jobs/items, including changed provider timestamps.

### Schema, Audit And UI

Migration **22** owns `copilot_quarantine_status_observations`, `copilot_quarantine_jobs`, `copilot_quarantine_job_items`, `copilot_quarantine_attempts`, `copilot_quarantine_audit`, `copilot_quarantine_canary_approvals` and `copilot_quarantine_qualifications`. Jobs/items/attempts expire after seven days; direct observations and qualification/canary evidence after 30 days; approvals authorize dispatch for 30 minutes; audit expires after 90 days. Qualification retains non-resumable job references after job expiry. Operator-only retention performs no provider requests. Runtime cannot delete qualifications or modify/delete audit.

Ordinary append-only quarantine audit records exact native target, actor, job/item/correlation, requested/observed state, safe error and outcome. It contains no tokens, provider bodies, custom cryptographic ledger or encrypted-content store. The SecurityReader audit API is principal/tenant scoped independently from Operator submission authority.

[API routes](../../../backend/src/routes/copilotStudioQuarantine.ts) expose `/api/quarantine/targets`, `/status`, `/preview`, `/jobs`, `/jobs/:id`, `/jobs/:id/cancel`, `/jobs/:id/resume`, `/jobs/:id/reconcile`, `/audit` and `/canary-approvals` plus its exact execution route. Server role/data-class/capability/CSRF enforcement is exercised by HTTP and exhaustive policy tests.

[Shared controls](../../../frontend/src/components/CopilotStudioQuarantineControls.tsx), [Operator target picker](../../../frontend/src/components/CopilotStudioQuarantineTargetPicker.tsx) and [Inventory Explorer](../../../frontend/src/components/InventoryExplorer.tsx) provide independent package/quarantine states, direct versus inventory timestamps/disagreement, confirmed single/bulk controls, exact disabled reasons and recovery. Selection revisions discard late preview/status results even after an A-B-A selection transition. Role/account changes clear private UI state. Lost submit responses retain the same frozen intent/idempotency key. Native dialog keyboard focus is contained; polling is bounded and ends with explicit refresh/recovery. Navigation and saved target-list refresh issue no provider inventory query. Broad inventory refresh remains a separate explicit Reader action.

## Microsoft Contract Review

Official pages were rechecked on local September 10, 2026:

| Operation | Implemented Exact Endpoint |
| --- | --- |
| Status | `GET https://api.powerplatform.com/copilotstudio/environments/{EnvironmentId}/bots/{BotId}/api/botQuarantine?api-version=1` |
| Quarantine | `POST https://api.powerplatform.com/copilotstudio/environments/{EnvironmentId}/bots/{BotId}/api/botQuarantine/SetAsQuarantined?api-version=1` |
| Unquarantine | `POST https://api.powerplatform.com/copilotstudio/environments/{EnvironmentId}/bots/{BotId}/api/botQuarantine/SetAsUnquarantined?api-version=1` |

The [Copilot Studio guide](https://learn.microsoft.com/en-us/microsoft-copilot-studio/admin-api-quarantine) specifies version `1`, delegated admin scope/roles, maker testing versus channel blocking, deprecated namespace avoidance and classic-write 405. The generated [status](https://learn.microsoft.com/en-us/rest/api/power-platform/copilotstudio/bots/get-bot-quarantine-status), [quarantine](https://learn.microsoft.com/en-us/rest/api/power-platform/copilotstudio/bots/set-bot-as-quarantined) and [unquarantine](https://learn.microsoft.com/en-us/rest/api/power-platform/copilotstudio/bots/set-bot-as-unquarantined) pages instead put `2024-10-01` in the actual request examples, not just a display label. They specify HTTP 200 with the same two status fields and no conditional-write header. The [authentication guide](https://learn.microsoft.com/en-us/power-platform/admin/programmability-authentication-v2) includes general service-principal examples, but those do not override this feature's delegated-only contract. No grant/configuration change was made.

Autonomous decision: follow the explicit Phase 09/Studio-guide version `1`, preserve the discrepancy as a live qualification prerequisite, and never guess a fallback version. Fixture request captures prove the application sends that contract, not that Microsoft accepts it in this tenant.

## Changed Files

- Backend feature: new quarantine adapter/control/job/canary services and tests, both feature repositories and tests, shared quarantine types and API routes; native inventory exact-target resolver, capability registry/service and provider-role helper; app/server/auth lifecycle and route-policy integration.
- Database/operator: additive migration 22 in [schema](../../../backend/src/db/schema.ts), grants/finite retention and populated schema-21 upgrade in [database operator](../../../backend/scripts/database.ts) and [tests](../../../backend/scripts/database.test.ts); existing compiled restart fixture/runtime extended for quarantine no-replay.
- Frontend: shared quarantine controls, minimized target picker and tests, [selection eligibility](../../../frontend/src/quarantineTarget.ts), Inventory Explorer and tests, App role assembly/styles, typed API client and existing shared browser scenarios.
- Browser/deployment: existing [browser fixture](../../../backend/scripts/browser-fixture.browser.ts) and [browser scenarios](../../../frontend/browser/permissions.spec.ts); narrow prerequisite repair in [local deployment helper](../../../scripts/local-deployment.ps1) and [orchestration tests](../../../scripts/local-deployment.tests.ps1) for culture-safe backup receipt dates.
- Documentation: [root README](../../../README.md), [mutation-canary runbook](../../../docs/mutation-canaries.md), and this completion record. Existing Docker/Compose/ZIP contracts were reused, not replaced.

All existing dirty work was preserved, particularly `frontend/src/components/UserAccessView.tsx` and the existing deletions of `reportImports.test.ts`, `reportImports.ts`, `reportingModels.ts` and `usageModels.ts`. No unrelated package/Defender behavior or Azure deployment asset was redesigned.

## Validation Evidence

All Node/npm/application/database/test/build/browser and metadata execution was inside Docker using the approved `https://packagefeedproxy.microsoft.io/npm/` registry. Host PowerShell only orchestrated the checked-in Docker scripts and tested their mocked host orchestration; Git/file tools performed review. The actual PowerShell executable was `/Users/candede/.dotnet/tools/pwsh`.

| Check / Exact Command | Environment / Time UTC | Status | Observed Result |
| --- | --- | --- | --- |
| Focused `npm run test --workspace backend -- src/services/copilotStudioQuarantineJobs.test.ts` with current source mounted read-only in `agent-control-phase01-operator:local`, restricted secret mounts, retained network and a fresh `agentcontrol_test_*` control DB | Docker PostgreSQL, 21:34:24 | passed | 14/14, including all 25 visible frozen targets, rejecting 26, delayed convergence, accepted-but-unapplied, skip/conflict/partial results and no replay/inversion. Exact control/child fixtures dropped. |
| All Phase 09 focused suites in final baseline | Docker isolated PostgreSQL, 21:37 | passed | Adapter 24, worker 14, control 4, canary service 3, repository 7 and canary repository 4: 56 feature tests. Includes role/scope/errors, current exact IDs, immutable retry, cancellation ownership, stale lease, revocation/publication fences, restoration conflict and timestamp evidence. |
| `pwsh -NoProfile -File ./deploy-local.ps1 -Project agent-control-phase01` | Final source, 21:37:16-21:37:49 | passed | Backend 48 files/477 tests; frontend 17 files/137 tests; backend typecheck; frontend lint; backend/frontend production builds; checksum migration and healthy retained app/postgres. |
| `npm run test --workspace frontend -- src/components/CopilotStudioQuarantineTargetPicker.test.tsx src/components/InventoryExplorer.test.tsx src/api/client.test.ts` | Docker focused source; final baseline repeats | passed | 36/36: picker 14, explorer 14, client 8. Frozen single/bulk confirmations, delayed results, same-key retry, exact IDs and role/account/selection isolation. |
| `pwsh -NoProfile -File ./scripts/permission-browser.tests.ps1 -Project agent-control-phase01` | Final built fixture, 21:38:01-21:38:56 | passed | 42/42 Chromium cases at 1440x1000 and 360x780; outer Vitest 1/1; axe A/AA, keyboard focus, no page overflow, outage/recovery and direct/inventory disagreement. Exactly one synthetic qualified write; no live egress. Guarded databases dropped. |
| `pwsh -NoProfile -File ./scripts/restart-runtime.tests.ps1 -Project agent-control-phase01` | Final compiled runtime, 21:39:07-21:39:40 | passed | Startup provider requests 0; quarantine explicit unsent write 1; quarantine completed/sent replays 0/0; reconciliation writes 0; canary qualification 0. Package/Purview/Defender/official-usage preservation and no-replay passed; guarded databases removed. |
| `pwsh -NoProfile -File ./scripts/persistence.tests.ps1 -Project agent-control-phase01 -Port 3001` | Parent-observed direct rerun, 21:32 | passed | Stop/start, redeploy, 475/137 baseline before the final two added bulk tests, stable data fingerprints/secret bytes/origin, two verified native backups, isolated restore and exactly two-service health. Three owned databases and proof receipts/dumps removed. Later final-source Deploy/package/browser/restart gates passed above. |
| `pwsh -NoProfile -File ./scripts/local-deployment.tests.ps1` | Host PowerShell mocked orchestration, after date repair | passed | 22/22, including current/expired backup handling under both en-US and en-GB. No actual runtime/data change. |
| `pwsh -NoProfile -File ./deploy-local.ps1 -Action Retain -Project agent-control-phase01` | Final Docker operator, 21:40:47-21:40:48 | passed | Finite retention succeeded, no provider calls. Migration tests also proved qualification survives seven-day job expiry and expires independently; runtime deletion denial passed. |
| `docker build --platform linux/amd64 --target package -t agent-control-phase01-package .` | Final source, 21:39:48-21:40:06 | passed | Linux/x64 guard, production dependency closure and package assembly. |
| `docker build --platform linux/amd64 --target export --output type=local,dest=artifacts .` | Same final package, 21:40:16 | passed | `artifacts/agent-control-linux-x64.zip`, 18,925,974 bytes measured inside Docker. |
| Extracted ZIP command below | Final Linux/x64 artifact, 21:40:25-21:40:31 | passed | Node 24.20.0, secret scan, startup/readiness/static/deep-link contracts and clean shutdown. |
| `docker run --rm --network agent-control-phase01_default --mount "type=bind,source=$PWD/artifacts,target=/evidence,readonly" agent-control-phase01-operator:local backend/scripts/package-smoke.ts http://app:3001 /evidence/agent-control-linux-x64.zip` | Final deployed app/ZIP, 21:40:38 | passed | `packaged_app_smoke: passed`, `zipInspected:true`; combined-origin API/auth/static/cache/traversal and required/excluded artifact contracts. |
| Docker readiness/auth/SQL/compiled `verifySchema` and exact cleanup inspection | 21:41-21:42 | passed | Ready 200; authConfigured false; exact callback; versions/checksums 1-22; only agentcontrol/postgres databases; quarantine jobs/items/attempts/status/qualifications/approvals/audit all zero; Defender jobs/snapshots/rows/proof/retained scopes all zero; no fixture receipt/container. |
| Native `Backup` followed by repaired `Retain` using the checked-in helper | 22:01:29-22:01:31 | passed | Fresh protected `phase09-verified-20260909T220129Z.dump` and receipt verified and retained. This intentional seven-day recovery backup is not a temporary fixture. |
| Docker Markdown/link/assertion validation plus `capabilityArtifacts.test.ts` | Current docs, 21:24 and final handoff | passed | Balanced fences/local links, corrected version/approval claims; capability artifacts 3/3. Editor checks on touched feature/helper files were clear; whitespace checks passed. |
| Authorized exact-target live status probe and reversible canary | No target/identity/approval | unavailable | No live call attempted. No restoration required or claimed; fixture success does not qualify provider behavior. |

Exact extracted-ZIP invocation:

```bash
docker run --rm --platform linux/amd64 --network agent-control-phase01_default \
  --mount "type=bind,source=$PWD/.local/agent-control-phase01/secrets/postgres-app,target=/run/secrets/postgres-app,readonly" \
  --mount "type=bind,source=$PWD/.local/agent-control-phase01/secrets/session,target=/run/secrets/session,readonly" \
  -e PGHOST=postgres -e PGUSER=agentcontrol_app -e PGDATABASE=agentcontrol \
  -e PGPASSWORD_FILE=/run/secrets/postgres-app -e SESSION_SECRET_FILE=/run/secrets/session \
  --entrypoint node agent-control-phase01-package backend/scripts/zip-runtime-smoke.mjs
```

Browser evidence remains in the shared [JSON report](../../../artifacts/phase03/permission-browser-results.json), [desktop confirmation](../../../artifacts/phase03/quarantine-confirmation-desktop.png), [mobile confirmation](../../../artifacts/phase03/quarantine-confirmation-mobile.png), [desktop controls](../../../artifacts/phase03/quarantine-controls-desktop.png) and [mobile controls](../../../artifacts/phase03/quarantine-controls-mobile.png). Parent inspected rendered desktop/mobile captures. All identities/content are synthetic. Existing Vite main-chunk warning remains 848.72 kB minified/239.26 kB gzip; no threshold was suppressed.

### Repairs And Cleanup

- Initial partial work did not count as validation. Subsequent repairs covered owner-before-cancel, durable same-intent receipt retrieval, dispatch-time qualification/current inventory/unresolved-write gates, bounded provider error-body reads and account fences. Final feature and aggregate tests passed.
- UI checks exposed stale confirmation on selection changes and keyboard focus escape; corrected with selection revisions and dialog focus containment, then reran components, lint/build and all 42 browser scenarios. A transient inherited official-usage mobile timeout passed on rerun without changing Phase 06 behavior.
- Parent review found the 20-row confirmation projection hid five valid bulk targets; now all 25 are shown. Focused 14-test execution passed, then final 477/137 deployment, browser42, restart and package gates were rebuilt/rerun.
- Docker Desktop was initially stopped; started the existing installation without replacing storage or Compose. An orphaned Phase 09 persistence receipt referenced the confirmed-absent `agentcontrol_test_9f40891e05a345d288b3b965d62d2059`; only that exact receipt was deleted after review. Browser/restart/persistence harnesses removed only their guarded owned databases/containers/proof files. Unrelated user data and Docker resources were not targeted.
- First orchestration gate failed because the backup helper reparsed a `DateTime` from JSON through culture-sensitive text. The narrow fix preserves typed UTC dates and parses strings invariantly. Tests now prove both en-US/en-GB, and full persistence/native restore plus fresh Backup/Retain passed. Possible impact on older backup files cannot be reconstructed from the available pre-run evidence; see the residual below.
- Validation-only command mistakes were corrected: a schema query requested nonexistent `name` instead of `version`; an initial documentation container lacked linked-file mounts; a runner used unsupported Vitest `--runInBand`; a checksum probe used unsupported top-level `await` in `tsx -e`. Corrected reruns passed; none changed retained schema/data. An incomplete runner report was not accepted as passing evidence; parent reran persistence and package checks directly.

## Open Issues

Inherited [P05 package safety/live limitations](05-package-management.md#open-issues), [P04 live inventory](04-power-platform-inventory.md#open-issues), [P08 provider/retained-scope and offline-RBAC limitations](08-defender-agent365-hunting.md#open-issues), and [P01 identity/bundle-size residuals](01-domain-persistence-foundations.md#open-issues) remain unchanged. Fixtures do not close them.

| ID / Origin | Scope / Evidence | Containment | Signal / Threshold | Owner | Exact Fix-Forward Trigger |
| --- | --- | --- | --- | --- | --- |
| P09-LIVE-QUARANTINE | Live version-1 status/rollout, delegated eligibility and both write transitions unavailable; official version examples conflict | No arbitrary target probe, no app credentials, no fallback; exact target/full-cycle qualification mandatory, zero live qualification rows | Any version/schema/role/readback failure or absent explicit approval keeps affected writes disabled | Tenant Power Platform administrator plus Phase 13 qualification owner | Supply approved exact native target/current private inventory and eligible delegated Operator; verify version-1 bounded GET first. Separately approve isolated reversible original/restoration canary, execute tested recovery workflow, verify final prestate and retain only minimal safe evidence. A contract/version change requires reviewed fixtures/revision invalidation before another approval. |
| P09-BACKUP-HISTORY | Older local backup-file preservation is inconclusive: Retain ran before the culture-dependent date defect was found, and no complete pre-run backup inventory is available | Defect fixed; 22 orchestration assertions and native restore passed; current retained DB was not reset; fresh verified seven-day backup exists and survives Retain | Any required historical restore point missing from protected backups | Local installation recovery owner; Phase 11 operations review | Review independently protected backup copies before promising historical recovery. Recover a needed old dump only from an authorized protected copy; do not fabricate it or overwrite current data. Current-state recovery is verified by the fresh backup/restore evidence. |

No reproducible Phase 09 core defect, failed required local gate or owned temporary cleanup remains open. Live canary/restoration was not authorized and therefore was not attempted. Historical backup uncertainty is explicitly separate from the repaired retention implementation and verified current database preservation.

## Next Session

- Implement only Phase 10. Read this record plus the controlling artifacts and inherited issues; do not treat the record as API or authority proof.
- Preserve migrations 1-22 and add any schema at 23+. Reuse the retained project, original volume/network/secrets, port 3001 and exact callback. Preserve the protected dirty User Access file and existing report-module deletions.
- Reuse the quarantine API/types/target picker/shared controls and source-independent observations, full 25-target confirmation, idempotent receipts and read-only reconciliation. No package/Defender identity, qualification or retained approval can authorize quarantine. Status capability is not write qualification.
- Keep Phase 08 source visibility, projection-v3, provider proof versus retained scopes, revocation and offline-RBAC boundaries; do not turn package/audit/Defender events into official usage. Do not add transcripts, manual identity linking, recurring provider refresh or maintenance UI.
- Phase 10 may integrate views, routing, exports, user-facing jobs and single-artifact browser/package proof. It does not authorize live writes, grants, Azure deployment or resolution of the provider version discrepancy by guessing.

```text
Implement only plans/admin-poc-production/10-unified-admin-workbench.md.
Read the binding README and completions/09-copilot-studio-quarantine.md,
then verify the named current source contracts and linked residuals.
Preserve migrations1-22, retained agent-control-phase01 data/secrets/network,
localhost3001 and its callback, protected dirty changes and report deletions.
Keep exact native quarantine targets, delegated authority, all25 frozen
confirmations, target-specific canary qualification and GET-only reconciliation.
Preserve Phase08 provider/retained authorization, revocation and projection-v3.
Run application, database, browser, build and metadata tools inside Docker
with the approved Microsoft npm feed. No live write approval is inherited.
Do not reset, rotate, change grants, deploy Azure, create campaign ledgers,
commits/branches/hashes or implement Phase11+. Stop after Phase10.
```

This session stops at Phase 09.