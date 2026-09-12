# Phase 04 - Power Platform Inventory And Exact Identities

## Status

```yaml
phase_file: 04-power-platform-inventory.md
phase_status: complete
outcome: completed_with_disabled_capabilities
validated_at_utc: 2026-09-08T19:26:17Z
execution_target: retained local Docker project agent-control-phase01; isolated PostgreSQL/browser fixtures; no Azure or provider changes
```

Phase 04 is implemented in the current worktree. The retained installation uses schema version 6 and remains a two-service Express/React/PostgreSQL deployment at `http://localhost:3001`. No campaign ledger, prompt hash, branch, commit, push, Azure deployment, provider grant, Phase 05+ implementation or future-ideas work was created.

## Prerequisite Verification

Read the binding README, Phase04, Phase01-03 records, completion template, security/setup guides and current linked Microsoft documentation. Verified current MSAL, ephemeral OAuth flows, sanitized PostgreSQL sessions, account-generation concurrency, safe callbacks, capability definitions/service/evidence, route policy, identity/job repositories, shared types, Permission Center/gates and Docker browser fixture. Current-source auth, session concurrency, callback, role, capability and route tests passed; completion records were not the sole evidence. Migrations1-4 were preserved. Migration5 was applied during implementation, then schema repair used forward migration6 rather than changing applied SQL. Existing worktree changes, data, volume and restricted secrets were preserved.

## Delivered Contracts

- **Bounded Resource Query adapter:** Delegated POST to the global Power Platform Resource Query endpoint with code-owned structured type/environment clauses, `Top=100`, continuation tokens, 50-page/5,000-row limits, 10-second request timeout, three read attempts, 10-second retry ceiling and 2 MB bounded JSON. Redirects, malformed/incomplete pages, duplicate identities, repeated tokens, changing totals and oversized results fail without publication. An external abort signal and validated-page progress callback support durable jobs and shutdown.
- **Normalized projection:** Eleven supported resource types share one allowlisted resource model. Copilot Studio/Agent Builder rows retain documented identity, authoring, lifecycle, owner, authentication, connector and bounded capability details. Absent, null and malformed values remain unknown/not supplied rather than becoming false classifications. Per-field GA/preview provenance, provider capability-detail truncation and total counts are preserved. Unknown fields produce value-free omission counts. Raw responses, tokens, sharing data and connection secrets are discarded.
- **Role coverage:** Only the six documented Entra role-template IDs are retained from validated claims. Global Administrator, Power Platform Administrator, Dynamics 365 Administrator and Global Reader produce full coverage. AI Administrator/Reader produce AI-scoped coverage and `not_authorized_scope` for ordinary apps/flows. Empty, malformed, unrelated or excessive role evidence remains unknown and cannot establish zero.
- **Private durable snapshots:** Migration 6 adds the bounded refresh deadline, nullable snapshot-to-job reference and complete scoped source-identity uniqueness without changing applied migrations 1-5. Principal-private jobs, snapshots and resources publish atomically. Complete same-query publication replaces only that current scope; broad/narrow scopes coexist. Failed, partial, narrower and unknown-coverage attempts preserve prior rows. Server-side filters precede counts, sorting and paging. Jobs expire after seven days and snapshots after 30 days through operator-only retention; runtime cannot delete published snapshots.
- **Explicit refresh lifecycle:** `POST /api/inventory/refresh-jobs` is the explicit current-user command; saved scope selection, recent jobs and explicit resume survive navigation/reload. At most four refreshes are active globally and five unfinished requests per principal. Overall query deadline30s, execution45s, dispatch window30min. Reader/current principal/provider-role scope/capability are checked before dispatch and publication; tokens remain in memory. Auth loss leaves discoverable `waiting_authorization`. Startup recovers before listening and never scans. Logout signals cancellation without awaiting work under the account lock; shutdown separately drains. Completed jobs and uncertain writes never replay.
- **Saved explorer API/UI:** Reader-only saved list/count/detail/CSV routes remain available independently of provider readiness. Inventory Explorer provides server-side search, type/environment filters, sort/direction, 50-row paging, per-type role coverage, snapshot freshness, detail, preview/null/truncation states, CSV and explicit refresh/resume. Provider capability gates protect only remote commands. Built application browser tests prove opening Inventory sends no refresh request.
- **Exact identity:** Typed package/app/manifest/asset, Power Platform resource/bot/environment and Entra app/agent/blueprint identifiers are retained when documented. Resolution compares exact same-kind values in tenant and required environment scope, returning `resolved`, `unresolved` or `ambiguous`. Names never match; the same GUID in different kinds/tenants/environments does not match; blueprint parentage is not equivalence; multiple children stay separate. Repeated computation over cloned allowed fields is byte-identical and ordinally sorted.
- **Association publication:** The repository computes exact outcomes against the complete selected private snapshot before page filtering. Other principals cannot supply candidates; missing required environments and different resource types cannot establish resource-ID equality. Ambiguous details cap at20 with total count. No documented package-to-Power-Platform identity relationship currently exists, so package associations remain explicitly unresolved. Relationships never merge records or redirect native targets. CSV uses source-read authorization and neutralizes formula prefixes. Seven-day job cleanup does not erase source success while its thirty-day snapshot remains.
- **Classification authority:** Graph package projections now expose normalized `sourceSystem`, `authoringTool`, `creatorType`, `agentKind`, `lifecycle`, `identityConfidence` and provenance. Authoritative authoring metadata outranks descriptions. Description parsing is used only when authority is absent and is visibly labeled `Package hint: ...`.
- **Capability and deployment boundary:** `powerPlatform.inventory.read` is registered only after a real bounded environment-query probe was wired. Permission Center exposes delegated `ResourceQuery.Resources.Read`; future quarantine/Purview/Defender adapters remain absent. Global cloud is the only implemented endpoint contract. No app-only collector, mutation, provider grant or Azure deployment exists.

## Coverage And Limitations

Supported types: canvas, model-driven, code and generic Power Apps; cloud, agent and M365 agent flows; Copilot Studio/Agent Builder agents; connectors; environments; environment groups. AI role scope can cover agents, agentic/code apps, agent flows, environments and groups but not ordinary canvas/model-driven apps or cloud flows. Connector inventory and capability detail fields remain preview and can be provider-truncated. Classic/V1 bots are excluded by the provider contract. Unpublished configuration, hidden workflow environments and conditional-access failures involving Azure Resource Manager can cause absent or failed observations without converting them to zero.

No approved live tenant credentials, consent, qualifying provider role or tenant data were available. No live probe/query was attempted and no tenant data entered fixtures or this record. Runtime status therefore remains unknown/unavailable until an authorized operator completes dynamic consent, role assignment, the explicit Permission Center probe and an explicit inventory refresh. This is not a blocker to the local production-continuation contract: saved/package behavior remains intact and provider actions fail closed.

Government-cloud availability varies by resource/harness; connectors and several Microsoft365 authoring types are absent, with additional DoD restrictions on agents/agent flows. China/air-gapped inventory is unavailable. This POC implements global only. Published configuration can lag drafts; flow ownership can reflect creator rather than later owner changes. Provider changes typically appear within15-20min, not immediate deletion evidence. ARM Conditional Access can prevent inventory reads; ambiguous401/403 never invents missing role/license or changes policy/grants.

## Changed Files

- Backend adapter/identity/roles/jobs: [powerPlatformResourceQuery.ts](../../../backend/src/services/powerPlatformResourceQuery.ts), [inventoryIdentity.ts](../../../backend/src/services/inventoryIdentity.ts), [inventoryRoleScope.ts](../../../backend/src/services/inventoryRoleScope.ts), [refresh service](../../../backend/src/services/powerPlatformInventory.ts), their focused tests, [shared types](../../../backend/src/types/powerPlatformInventory.ts), [repository](../../../backend/src/db/powerPlatformInventory.ts)/tests, [routes](../../../backend/src/routes/inventory.ts) and [app tests](../../../backend/src/app.test.ts).
- Backend integration: [schema](../../../backend/src/db/schema.ts), [database operator](../../../backend/scripts/database.ts)/tests, [source/job repository](../../../backend/src/db/jobs.ts), [MSAL](../../../backend/src/auth/msal.ts), [session sanitizer](../../../backend/src/db/sessions.ts)/tests, [auth routes](../../../backend/src/routes/auth.ts), [server](../../../backend/src/server.ts), [route policy](../../../backend/src/routes/policy.ts), [capability registry](../../../backend/src/services/capabilityRegistry.ts), [capability service](../../../backend/src/services/capabilities.ts)/tests, [package observation](../../../backend/src/services/packageObservation.ts), package/session types.
- Frontend: [App.tsx](../../../frontend/src/App.tsx), [App.css](../../../frontend/src/App.css), [API client](../../../frontend/src/api/client.ts), [agent display](../../../frontend/src/agentDisplay.ts)/tests, [Inventory Explorer](../../../frontend/src/components/InventoryExplorer.tsx)/tests, [browser scenarios](../../../frontend/browser/permissions.spec.ts).
- Fixtures/docs: [browser fixture](../../../backend/scripts/browser-fixture.browser.ts), [restart fixture](../../../backend/scripts/restart-fixture.ts), [compiled restart proof](../../../backend/scripts/restart-runtime.mjs), [runbook](../../../README.md), [security model](../../../docs/security-model.md), [setup guide](../../../docs/deployment-setup.md), [provider inventory](../../../docs/provider-contract-inventory-2026-09-08.md), this record. Existing Docker/Compose/deploy-local and PowerShell/browser entry points reused.
- Checked unchanged authorities: ephemeral OAuth flow storage, browser-local report storage/parser, legacy Azure deployment assets and future phase plans. No application inventory, recurring collection, manual linking or excluded provider workflows.

## Source Contract Review

Microsoft documentation was rechecked on 2026-09-08. The implemented global-cloud contract remains `POST https://api.powerplatform.com/resourcequery/resources/query?api-version=2024-10-01` with delegated `ResourceQuery.Resources.Read`. The current schema documents the eleven ingested resource types and marks connector/capability details as preview. The agent schema documents nullable fields, published-version visibility, Classic/V1 exclusion, identity variation and the 200-resources-per-type detail limit. Role names and template IDs remain source-reviewed rather than inferred from display names.

- [Power Platform inventory API](https://learn.microsoft.com/en-us/power-platform/admin/inventory-api)
- [Power Platform inventory coverage and limitations](https://learn.microsoft.com/en-us/power-platform/admin/power-platform-inventory)
- [Power Platform inventory schema](https://learn.microsoft.com/en-us/power-platform/admin/inventory-schema)
- [Microsoft Copilot Studio Agent inventory schema](https://learn.microsoft.com/en-us/microsoft-copilot-studio/admin-agent-inventory)
- [Microsoft Entra built-in role reference](https://learn.microsoft.com/en-us/entra/identity/role-based-access-control/permissions-reference)

## Validation Evidence

All app/build/test/database/browser execution was in Docker; host PowerShell/Git/Docker only. Random guarded `agentcontrol_test_*` databases were created and cleaned, never rollback-only fixtures against application data. Final uncommitted worktree.

| Exact command / check | Status | Observed result |
| --- | --- | --- |
| `pwsh -NoProfile -File ./deploy-local.ps1 -Project agent-control-phase01` | passed | Final19:24 UTC aggregate:187 backend tests/27 files,74 frontend tests/11 files, backend typecheck, frontend lint, both builds, checksum migrations and healthy retained deployment. Runs all five binding npm baseline commands in isolated Docker databases. |
| `docker run --rm --entrypoint npm agent-control-phase01-operator:local run test --workspace backend -- src/services/powerPlatformResourceQuery.test.ts src/services/inventoryIdentity.test.ts src/services/inventoryRoleScope.test.ts src/services/powerPlatformInventory.test.ts src/auth/msal.test.ts src/auth/flows.test.ts src/db/sessionsConcurrency.test.ts src/services/capabilities.test.ts src/routes/policy.test.ts` | passed | Parent independent55-test rerun before final additions; final aggregate includes adapter14, identity5, role2, refresh6, MSAL13, flow4, session-concurrency2, capability9 and policy2 cases. |
| Current-source Docker focused inventory repository/identity tests, guarded control DB as below | passed | Final repository11/identity5: hold-before-commit/rollback visibility, private joins before page filtering, deterministic outcomes, exact scope replacement, broad/narrow/partial preservation, independent retention, grants and unknown coverage. Packaged app17 and durable jobs8 passed in final aggregate. |
| `docker run --rm --entrypoint npm agent-control-phase01-operator:local run test --workspace frontend -- src/components/InventoryExplorer.test.tsx src/components/PermissionCenter.test.tsx src/useCapabilities.test.tsx` | passed | Final current-source equivalent:26 tests, inventory7/Permissions+DOM axe17/evidence2. Strict Mode, delayed-account cleanup, null/preview/truncation, durable resume, focus return and saved export. All included in aggregate. |
| `pwsh -NoProfile -File ./scripts/permission-browser.tests.ps1 -Project agent-control-phase01` | passed | Final19:25 UTC:32/32 Chromium scenarios at1440x1000 and360x780; real Express policy/session stack with deterministic test-only providers/auth. Rendered axe/keyboard/filters/details/outage/explicit scans; zero navigation scans. [JSON](../../../artifacts/phase03/permission-browser-results.json), inspected [desktop](../../../artifacts/phase03/inventory-desktop.png)/[mobile](../../../artifacts/phase03/inventory-mobile.png). No page-wide overflow/overlap; tables and coverage scroll locally. |
| `pwsh -NoProfile -File ./scripts/restart-runtime.tests.ps1 -Project agent-control-phase01` | passed | Compiled runtime exits17/recreates: zero inventory scans before explicit authorization, exactly one afterward, completed jobs unchanged; two explicitly authorized unsent fixture writes and zero completed/uncertain replays. Control/fixture DBs, receipt and container removed. |
| `docker run --rm --network agent-control-phase01_default agent-control-phase01-operator:local backend/scripts/package-smoke.ts http://app:3001` | passed | Deployed health/readiness/static/API/callback/traversal checks. No ZIP or Azure qualification claim. |
| `docker compose --project-name agent-control-phase01 ps`; PostgreSQL schema/database inventory; `git diff --check`; editor diagnostics | passed | Exactly app/postgres healthy, migrations1-6, only agentcontrol/postgres non-template DBs; touched-source diagnostics clear. Runtime `authConfigured:false`. |
| Live non-mutating Power Platform probe and bounded query | unavailable | No authorized live tenant/session, so no probe/query attempted. No consent/grant/role changes, tenant-data fixtures or fabricated readiness. |

Focused database tests used a newly created random control `PGDATABASE=agentcontrol_test_*`, `docker run --rm --network agent-control-phase01_default`, read-only mounts of `.local/agent-control-phase01/secrets` and current backend source, `PGHOST=postgres`, `PGUSER=agentcontrol_admin`, `PGPASSWORD_FILE=/run/secrets/postgres-admin`, `APP_PGPASSWORD_FILE=/run/secrets/postgres-app`, and `--entrypoint npm agent-control-phase01-operator:local run test --workspace backend -- src/db/powerPlatformInventory.test.ts`. The invoking PowerShell `finally` dropped that control DB; `testDatabase` owned child fixture cleanup. The final browser fixture `agentcontrol_test_10312ddfeee64e9ea49df00f2e408db4` was removed. Browser origin was localhost3001 inside an unpublished disposable container; retained host origin/report storage was untouched.

### Repair And Rerun Evidence

- Parent review corrected the unquoted environment clause and per-type nested allowlists, truthful missing/draft/authoring semantics, preview maturity, bounded retry/stream errors and sovereign rejection. Final adapter14 and aggregate passed.
- Exact identity now scopes deduplication by source/type/environment/native ID, rejects missing required environment and uses ordinal ties. The server computes outcomes against complete private snapshots; private collisions and resolved/ambiguous twice-computed projections pass. No guessed package relation was added.
- Forward migration6 repairs independent retention and source identity scope. Atomic hold/rollback, stale/expired publication, narrower/partial preservation and job-expiry-with-source-freshness tests pass.
- A potential logout/publication lock deadlock was repaired by signalling abort without awaiting work under the account lock, with final abort fences. The capacity test initially assumed synchronous cancellation; it now drains outside that lock. The same12 cancellation/session/flow checks passed.
- Strict Mode cleanup initially left explicit actions inactive; its regression passes. The first parent aggregate passed187/74 tests but failed React render-purity lint on a stale-label clock read. Moved time to display-only effect state, reran lint, then full Deploy, browser32 and compiled restart successfully. No rule or warning threshold was suppressed.

Browser JSON/screenshots remain under `artifacts/phase03/` because the existing Phase 03 harness owns that evidence path; Phase 04 adds inventory scenarios to the same matrix. No token, raw claim, OAuth transaction, provider payload, tenant identity or secret is retained there.

## Open Issues

| ID / origin | Scope / evidence | Containment | Signal / threshold | Owner | Exact fix-forward trigger |
| --- | --- | --- | --- | --- | --- |
| P04-LIVE-INVENTORY | Global delegated consent/role coverage, response contract and ARM Conditional Access unavailable without authorized identity | Capability unknown/unavailable; saved/private and package authority preserved; no automatic probe or grant | Any claim of readiness before fresh current-principal probe and complete bounded query | Tenant administrator and Phase04 integration owner; Phase13 qualification consumer | Supply approved existing tenant/client setup through restricted files/secure input, sign in with Reader plus supported Entra role, consent only ResourceQuery.Resources.Read, explicitly probe and run one bounded non-mutating refresh; record safe scope/count/freshness or contain the exact failure, never tenant content. |

Inherited [P01-LIVE-IDENTITY and P01-BUNDLE-SIZE](01-domain-persistence-foundations.md#open-issues) remain open. Final main JS773.57kB minified/224.15kB gzip; Phase10 owns loading measurement/splitting. No threshold was suppressed. No unresolved implementation defect, failed core check or cleanup incident remains. Preview package-write qualification is Phase05 work, not an enabled Phase04 capability.

## Next Session

Phase05 may consume source-provenanced package fields, current private snapshots, scoped exact-ID helpers and capability/role gates. Native Graph package IDs remain mutation targets; associations never redirect controls. MSAL/OAuth remains ephemeral and reports remain browser-local until06. Under the current binding README, implemented package writes run on demand for an authorized, confirming Admin; exact-target canary qualification is optional and never gates ordinary writes. This updates the continuation instruction, not the phase's historical live-evidence results. Do not modify applied migrations1-6. Reuse retained Docker deployment and isolated fixture harnesses.

```text
Implement only plans/admin-poc-production/05-package-management.md.
Read the binding README and Phase01-04 records; verify current auth/session,
capability, identity/job/snapshot and UI contracts against the worktree.
Preserve data, secrets, independent roles, source scope and migrations1-6.
Use Docker and agent-control-phase01 at http://localhost:3001 with isolated
fixtures. Keep canaries optional and non-gating; never replay completed/uncertain
writes. Preserve current Admin/provider authority, confirmation, audit and readback.
Do not commit, push, deploy Azure, change provider grants, create
campaign bookkeeping, run future ideas or continue beyond Phase05.
```

This session stopped after Phase04; the next prompt was not executed.