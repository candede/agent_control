# Phase 01 completion — retire catalog and narrow sync

Status: **Complete — locally implemented and verified**

Date: 2026-09-23

Prompt: `01-retire-catalog-and-narrow-sync.md`

Prompt SHA-256: `33810f938a3400e3cb6127c2148868b127e66b96ca7d0f1096ddfe68b5c4fc55`

## Delivered

- The supported Power Platform universe is exactly `microsoft.copilotstudio/agents` and `microsoft.powerplatform/environments`. Central DataSync, explicit source refresh, request validation, role planning, normalization, verification and persistence agree.
- Removed standalone app, flow, connector and environment-group normalizers and catalog-only fields, including the connector tenant fallback. Agent connector operations, ownership/configuration, environment type/group/managed properties, exact identities and provenance remain.
- Deleted `InventoryExplorer`, its generic detail experience, obsolete quarantine catalog picker, their tests, catalog navigation/authorization/metadata, obsolete route state and bookmark migration, unified-detail aliases, and page-only CSS.
- Removed the generic resource-list, snapshot-list and quarantine-target-catalog APIs. Removed their helpers/types and hardcoded unmatched Package/Reports/detail-control response fields.
- Preserved agent activity, exact bulk/individual selection, private saved-source reads, agent CSV export, people enrichment, package access/block controls, quarantine/restore, audit/security associations and shared verification.
- Jobs and diagnostics now open the exact source job at `/sync?powerPlatformJob=<id>`. Sync displays saved status, scope, counts, unknown provider totals, pages, omitted fields, snapshot information and errors. Resume/cancel use that exact job; failed/cancelled recovery explicitly creates a new refresh with its original scope.
- Source inspection does not automatically start provider work or substitute the latest job. Polling observes terminal completion and reloads saved sources. Read/action responses are fenced against obsolete owners; action errors persist until explicit recovery.
- Retired catalog bookmarks show “Page not found” without API requests, redirect, or migration, including browser-history restoration.

## Schema, API and state contracts

- Updated the Power Platform portion of fresh schema version 5: job/snapshot requested types are an allowlisted array of one or two supported types; resource rows accept only those types; initial coverage has two entries. Version 33 bounds actual queried types to one or two and retains the requested-subset check.
- Added no compatibility migration, data rescue, dual reader or new migration generation. Unrelated migration architecture, including version 32, remains unchanged. Existing broad-catalog databases are **not** an in-place upgrade target.
- Private snapshots, publication verification, retention, canonical memberships, exact native identities, source deadlines, continuation/retry behavior and authorization revalidation remain intact.
- Both repository snapshot selection and quarantine canary dispatch now recognize the two-type broad snapshot. The canary regression first reproduced `quarantine_target_unavailable` with the old eleven-type preference and then passed with the corrected preference.
- Removed `GET /api/inventory/resources`, `GET /api/inventory/snapshots`, and `GET /api/quarantine/targets`.
- Retained `/api/inventory/resources/:nativeId/related` as agent-only activity: an exact authorized snapshot/environment/native ID is required, and a generic `type` parameter is rejected. Its payload contains source observation/identity plus audit/security associations.
- Retained `/api/inventory/quarantine-selection`, source-job lifecycle routes and `/api/inventory/export.csv`. Source export requires an exact saved snapshot and exports agents only; obsolete `type`, `excludeAgents`, `limit`, `offset` and catalog sort options are rejected. Publication revalidates session/snapshot and completes the existing audit event.
- Retained the independent canonical agent CSV export and Graph package contracts.
- `powerPlatformJob` is distinct from Graph `refreshJob` and DataSync `syncRun`. Power Platform remains a job/action source, not a workbench view. Quarantine job links open Agents.

## Autonomous decisions

1. Reused the existing agent activity endpoint rather than adding a parallel endpoint. Its actual consumers are agent-specific and retain exact-source authorization.
2. Put source-job inspection/recovery in a focused Sync component, using existing saved-query and action-gate infrastructure. Older jobs remain addressable without loading or choosing the latest history entry.
3. Removed the quarantine catalog picker and its endpoint because the deleted explorer was their only product consumer. Real Agents selection, preview, confirmation, dispatch and readback remain.
4. Kept embedded connector operations, environment supporting metadata and shared detail/verification styles despite historical inventory-oriented names.
5. Used a fresh-schema contract, as explicitly authorized. Did not attempt to migrate, reinterpret or rescue retired catalog data.
6. Did not add contextual environment/dependency UI or user responsibility features owned by later phases. No invoked-flow identity, exclusive ownership or other unsupported relationship was inferred.

## Cross-application impact

All paths below are in the single `agent_control` repository.

| Root / files | Impact |
| --- | --- |
| `backend/src/types/{powerPlatformInventory,workbench,copilotStudioQuarantine,agentPresentation}.ts` | Narrowed source and response contracts; removed catalog-only details and target-page types. |
| `backend/src/services/{powerPlatformResourceQuery,inventoryRoleScope,dataSync,workbenchMetadata}.ts` | Two-type collection/role planning, retained source safeguards, corrected source copy, removed catalog metadata. |
| `backend/src/db/{schema,inventoryVerificationSchema,powerPlatformInventory,copilotStudioQuarantine}.ts` | Fresh-schema allowlists/bounds, agent-only export reads, removed catalog selection/projection, corrected broad-snapshot preference. |
| `backend/src/routes/{inventory,copilotStudioQuarantine,workbench}.ts` | Removed dead APIs, narrowed active contracts, canonical exact job links. |
| Backend service/repository/route/app tests and `backend/scripts/database.test.ts` | Updated fresh-schema and affected contracts; retained identity/privacy/control tests; added retired-type and canary freshness regressions. |
| `frontend/src/{App,workbenchRouting,authorization,capabilityState,api/client}` | Removed catalog entry points and compatibility behavior; added exact Sync source-job state; quarantine permission handoffs now open Agents. |
| `frontend/src/components/{PowerPlatformSourceJob,AgentSyncTools,AgentOverview,UnifiedAgentDetailModal,syncPresentation}` and `App.css` | Added source-job experience, retained agent capabilities, removed catalog fields/aliases/styles, corrected source descriptions. Deleted explorer and target picker. |
| Frontend unit tests and `frontend/browser/{permissions,jobs,layout,layoutFixtures,unifiedAgents,agentPeople,agentCatalog}` | Updated all affected consumers and fixtures; exact jobs tested across five states on desktop/mobile; retained control/activity and report identity assertions. |
| `README.md`, `docs/{deployment-setup,security-model,provider-contract-inventory-2026-09-08}.md` | Current documentation describes the agent-centered contract, fresh initialization, removed routes and exact Sync diagnostics. Historical completed plans unchanged. |
| Root `scripts/`, manifests and deployment configuration | Inspected for affected collection/catalog consumers; no runtime consumer required changes. Used the existing isolated browser fixture directly rather than the script targeting the shared application container. No dependencies or deployment configuration changed. |

The deletion sweep found no runtime explorer, catalog route/handoff, bookmark migration, obsolete unified-detail alias, old eleven-type preference or broad app/flow collection message. Remaining retired-type literals test rejection; retired page URLs test absence. Microsoft documentation URLs, Graph package snapshot APIs, genuine Graph package tabs, Power Platform job/action source IDs and shared verification/detail styles are intentional survivors.

## Verification

All database work used the parent-authorized PostgreSQL 17.11 instance on `127.0.0.1:55533`, base database `agentcontrol_test_campaign`, user `agentcontrol_admin`, SSL disabled. `PGPASSWORD_FILE` and `APP_PGPASSWORD_FILE` were unset; both passwords used the existing synthetic `fixturePassword`. The repository fixture created and removed isolated per-suite databases; backup tests used their own isolated restore target. No existing application/database/container was stopped or reset.

The browser fixture served only `http://127.0.0.1:55534`; its readiness endpoint was checked. Provider adapters were fixture-backed and external fetches forbidden. The full fixture also verified retained report fingerprints after restarting its own server, expected quarantine write/readback outcomes, and absence of package mutation jobs.

Final cleanup checks confirmed that the fixture server closed and only `agentcontrol_test_campaign` remained among test/restore database names. The parent-owned PostgreSQL container remains untouched. Repo-local transient validation artifacts were removed after recording results.

| Command / check | Final result |
| --- | --- |
| Initial focused default Resource Query / retired-type tests | 5 passed; falsified/confirmed the shared collection boundary before widening implementation. |
| Focused source/query/role/DataSync/service and repository tests | Covered by the complete passing backend suite below. |
| `npm --prefix backend test -- src/db/powerPlatformInventory.test.ts src/db/inventoryVerification.test.ts src/db/copilotStudioQuarantine.test.ts src/db/agentControlIdentity.test.ts src/services/workbenchMetadata.test.ts src/routes/workbench.test.ts` | 80 passed in the initial focused run. |
| Focused schema, app, policy, workbench and canonical-registry runs | Passed; removed endpoints return 404 and retained routes preserve scope/gates. |
| `npm --prefix backend test -- src/db/copilotStudioQuarantineCanaries.test.ts src/db/copilotStudioQuarantine.test.ts src/db/powerPlatformInventory.test.ts` | 40 passed after reproducing and repairing the broad-snapshot preference defect. |
| `npm --prefix backend test` with campaign database environment and `/opt/homebrew/opt/libpq@17/bin` on `PATH` | **110 files, 2,467 tests passed**, including native backup/restore and the final canary regression. |
| `npm --prefix frontend test` | **64 files, 1,797 tests passed**. |
| `npm --prefix frontend test -- src/components/syncPresentation.test.ts src/components/DataSyncPanel.test.tsx` | **119 tests passed** after final source-description correction. |
| `npm --prefix backend test -- --config scripts/browser-fixture.config.ts` with campaign DB env, `NODE_ENV=test`, `AGENT_CONTROL_FIXTURE_MODE=browser`, loopback base URL and repo-local evidence directory | **302 browser tests passed; 8 intentional existing skips**; desktop/mobile, axe, source diagnostics, Jobs, retired navigation, agent controls and activity. The skipped duplicate mobile layout cases are covered by the desktop project's complete viewport matrix. Enclosing fixture passed. |
| `npm --prefix backend run build`; `npm --prefix backend run typecheck` | Passed. |
| `npm --prefix frontend run build`; `npm --prefix frontend run lint` | Passed. |
| Editor diagnostics; `git diff --check` | No errors; passed. |

Validation failures were repaired, not suppressed: stale catalog expectations and two stale browser locators were updated while preserving exact-target assertions; the missing `pg_dump` executable was resolved by using the already-installed PostgreSQL 17 client directory; a temporarily removed shared job-limit parser was restored. Existing Vite chunk-size and test-only Express session deprecation warnings remain non-fatal. No test was skipped to hide a failure.

## Limitations and next-phase preconditions

- No Azure deployment, live tenant authentication, live query, or live mutation was performed or claimed. These are fixture/local contract results.
- The working tree contains the implementation and this record; no commit, push or branch was created. Parent-owned plans and campaign manifest were preserved.
- Phase 02 can use the working two-type source, retained embedded capabilities, exact private identities and environment context. It must not restore a catalog or broaden collection.
- Preserve the now-working source-job routes, export/selection/activity contracts and exact management authorization when enriching agent views.
- Honor the parent’s flow-source decision: current synchronized sources do not establish invoked-flow relationships. Add the explicit unavailable state and safe official-console handoff in phase 02, not guessed flow identities.
- Continue on the authorized isolated fresh database. Do not run this fresh-schema revision against an existing broad-catalog database as an in-place upgrade.
- No unresolved phase-01 implementation blocker remains.
