# Phase 03 completion — User-to-agent responsibility

## Result and boundaries

**Complete and locally verified.** Phase 03 of 4 is implemented end to end.

Prompt SHA-256: `02e520b534c99a139dd86e1aa21bfab5ba4767b94f58d053bfc1082ff1fe2825`.

The assigned worker used the requested extra-high reasoning posture without nested delegation. Earlier phases and parent-owned plans were preserved. This worker did not edit the campaign manifest, commit, push, create branches, deploy, contact a live tenant, add Dataverse, or infer invoked flows.

## Delivered behavior

- Added a separate **Agent responsibility** Users cohort. It includes exact native responsibility references and saved people evidence outside both paid-license and active-report cohorts. It does not require a license-roster match or a tenant-wide directory sync.
- Kept **Owner**, **Created by**, and **Last modified by** distinct. One person can have several roles on an agent, and one agent can have several responsible people. Operation configuration creators, display names, sign-in names, GUID fragments, shared environments/connectors, access assignments, and observed usage create no responsibility edges.
- Preserved Power Platform-only and canonically linked agents. The projection reuses current canonical reconciliation, private source readers, saved people evidence, and transactional revision guards.
- Read both complete independently bounded sources before projecting or paging. The normal 250-row Agents list clamp is not used. Tests cover 301 related agents and 301 distinct responsible people, including identities first appearing beyond row 250.
- Added exact user deep links at `/users?view=responsibility&person=<object-id>`. Resolved agent responsibility people open this context even when absent from the paid/report rosters. Invalid, unverified, not-found, failed, and expired agent identities retain their readable evidence and an explicit navigation-unavailable explanation instead of opening guessed profiles.
- Users responsibility opens the current canonical agent's **Overview**. The handoff clears obsolete list/detail evidence and requests current saved inventory; removed canonical identities fail visibly rather than falling back to a same-name or arbitrary source record.
- Paid-user and report-user details show responsibility alongside, not merged into, usage and licensing. Report details use only the already-established exact saved directory/report link; unmatched, concealed, ambiguous, case-distinct, stale, wrong-set, and wrong-version identities receive an unavailable state without a responsibility request.
- Preserved source availability, partial/missing fields, invalid reference counts, source observation/expiry, no-reported-relationships, negative lookup evidence, normalized lookup errors, and explicit retry. Unavailable source data is not displayed as a confirmed zero.
- New reads are saved-only. They do not resolve directory people, refresh providers, or create usage/management authority. Requests and returned evidence are fenced by selected identity, revision, account/tenant, role, and cancellation.
- Mounted responsibility contexts follow background Power Platform and Graph source completion/reset without changing the selected cohort/person or reloading license/report evidence. Existing Users-source evidence invalidation remains independent.
- Fixed a directly exposed report-detail accessibility defect: adding responsibility changed the mobile dialog's geometry and revealed an inherited dark hover background on a dark-text report-agent button. The button now retains accessible hover contrast; the scale browser test explicitly hovers it before the unchanged axe assertion.

## API, type, persistence, and route contracts

### Saved API

`GET /api/agent-responsibility`

- Authenticated **Viewer** access (including inherited Admin), `private_inventory` data class; no provider capability requirement.
- Optional `objectId`: validated immutable Entra object ID, normalized to lowercase. It is never an email/name selector.
- Optional `search` up to 256 characters, for filtering the already-projected people list only.
- `offset`: 0–30,000; `limit`: 1–100, default 50.
- Unsupported fields, scope overrides, malformed identities, and invalid bounds return 400.
- An exact selected identity must have authorized saved responsibility or directory/cache evidence. Unknown or foreign identities return `404 responsibility_person_unavailable`.
- Returns `revision`, exact source statuses/observations, `coverage` (`available`, `partial`, `unavailable`), `unknownAgentCount`, `invalidReferenceCount`, paged people, and optional selected-person context with separately labelled roles and paged canonical agent references.
- Selected context distinguishes `reported`, `no_reported_relationships`, and `unavailable`. The first two refer only to the authorized saved source, not exhaustive tenant responsibility.
- Each person retains its existing saved identity observation or null. Resolved, not-found, failed, unverified, and expired evidence is not silently promoted or replaced with a name-based guess.

### Canonical and saved-data boundary

`UnifiedAgentsService.responsibility` executes inside the existing registry snapshot transaction. It calls the same canonical inventory projection with a 10,000-row bound (two independent 5,000-record source limits), verifies completeness, and performs final revision validation after selected-person evidence is read. It does not call the public `list` method with an oversized limit and silently receive 250 rows.

`SavedAgentPeopleService.read` factors out the existing directory/cache evidence precedence and negative-result rules for both inventory enrichment and selected-person context. Only requested validated IDs are returned. No new table, migration, source collector, backfill, dual reader, raw archive, or compatibility schema was needed.

The browser route retains responsibility selection/search/page separately from the paid and report cohorts. Invalid person links remain explicit invalid contexts, not a name search or fallback profile. App scope guards and existing saved-query cancellation handle session transitions. No ownership or last-modifier control was added.

## Autonomous decisions

1. Used a third Users cohort rather than expanding the license-reporting roster. This implements the parent's responsible-people-outside-rosters decision while preserving license metrics and collection.
2. Added one private saved projection endpoint with list and exact-context queries. It reuses canonical transactions and people evidence instead of duplicating reconciliation or reading unscoped identity tables.
3. Kept unverified native references inspectable as source responsibility context, explicitly not a verified user profile. Reverse navigation from an agent is offered only for a resolved, valid, unexpired identity.
4. Reused existing canonical detail navigation with an explicit current-saved reload. No alias, redirect, legacy route reader, or placeholder tab was introduced.
5. Kept license/report exports unchanged. Responsibility is a separate context, not another reported-use measure or an export reinterpretation.

No unresolved parent architecture decision remains.

## Cross-application impact

All paths are in the single `agent_control` repository.

| Root / files | Phase-03 impact |
| --- | --- |
| Backend types and services | New `src/types/agentResponsibility.ts`, `src/services/agentResponsibility.ts`; updated `unifiedAgents.ts`, `savedAgentPeople.ts`: bounded exact relationship projection, current canonical reuse, existing private people evidence. |
| Backend routes | `src/routes/unifiedAgents.ts`: new authorized saved endpoint and strict query parser. |
| Backend verification | `services/unifiedAgents.test.ts`, `routes/unifiedAgents.test.ts`, `routes/policy.test.ts`, `db/unifiedAgentsIntegration.test.ts`, `app.test.ts`: full-source paging, role distinctions, exact IDs, saved cache outside paid cohorts, real canonical persistence/refresh/removal, tenant/principal isolation, route/role failures, unchanged provider-call counters. |
| Frontend API and routes | `src/api/client.ts`, `src/workbenchRouting.ts` and routing tests: shared backend types, saved API client, exact Users responsibility route. |
| Frontend Users | New `components/UserAgentResponsibility.tsx` and test; updated `CopilotUsersView`, `ReportedUserActivity`, `ReportedUserDetail`, associated tests, `copilotUsers.css`, `reportedUsers.css`: new cohort/context, exact directory gating, paging/search/errors, readable evidence, cancellation and hover contrast. |
| Frontend agent navigation | `App.tsx`, `AgentOverview.tsx` and its test, `UnifiedAgentDetailModal.tsx`: bidirectional exact handoffs, resolved-only reverse links, current canonical re-read. |
| Fixture/browser consumers | New `browser/agentResponsibility.spec.ts`, `src/test/agentResponsibilityFixture.ts`; updated `browser/layoutFixtures.ts`, `browser/copilotUsers.spec.ts`: shared truthful saved projection, desktop/mobile negative and positive cases, strict no-provider-request checks, existing license/report regression proof. |
| Current docs | `README.md`, `docs/security-model.md`, `docs/copilot-license-usage.md`: cohort, identity, API/source scope, unknown-state, and authority contracts. |
| Database schema, backend/root scripts, deployments, dependencies | Inspected controlling persistence and existing fixture support. Existing scoped JSONB/cache/canonical schema and fixture runner satisfy this phase; no schema, collection, installation, deployment configuration, dependency, or root-script changes required. |
| Plans | This required completion record only. The parent retains ownership of `IMPLEMENTATION_CAMPAIGN.md`. |

No pre-existing catalog retirement, narrowed collection, connector/flow context, source-job, management, or export changes were reverted.

## Validation and evidence

Initial falsification: the new 301-agent responsibility test failed because the complete saved responsibility API did not exist. Implementing the shared bounded projection made it pass. Subsequent tests added a distinct 301-person paging case, exact-ID negatives, linked/native persistence, and revision-change failures.

| Command / scope | Observed result (initial implementation) |
| --- | --- |
| `npm --prefix backend test -- src/services/unifiedAgents.test.ts src/services/unifiedAgentsSnapshot.test.ts src/services/agentPeople.test.ts src/services/copilotUsage.test.ts src/services/unifiedAgentExport.test.ts src/db/unifiedAgentsIntegration.test.ts src/db/agentPeople.test.ts src/db/unifiedAgentRegistry.test.ts src/routes/unifiedAgents.test.ts src/routes/policy.test.ts src/app.test.ts --reporter=dot` | **11 files, 297 tests passed**. Actual PostgreSQL persistence and HTTP route tests included. |
| `npm --prefix frontend test -- src/components/UserAgentResponsibility.test.tsx src/components/CopilotUsersView.test.tsx src/components/ReportedUserActivity.test.tsx src/components/AgentOverview.test.tsx src/components/UnifiedAgentDetailModal.test.tsx src/useAgentPeople.test.tsx src/workbenchRouting.test.ts src/api/client.test.ts src/App.session.test.tsx --reporter=dot` | **9 files, 717 tests passed**. |
| `npm --prefix backend run build`; `npm --prefix backend run typecheck` | Passed. |
| `npm --prefix frontend run build`; `npm --prefix frontend run lint` | Passed. Existing nonfatal Vite chunk-size warning retained. |
| `npm --prefix backend test -- --config scripts/browser-fixture.config.ts` with exact selector `agentResponsibility.spec.ts,copilotUsers.spec.ts,agentExperience.spec.ts,agentPeople.spec.ts` | **48 desktop/mobile Chromium tests passed**, plus enclosing fixture. No skips or weakened assertions. |
| Editor diagnostics; `git diff --check`; prompt hash | No errors; clean diff hygiene; assigned prompt unchanged. |
| Post-run database/listener check | PostgreSQL **17.11**; only base `agentcontrol_test_campaign` remained among `agentcontrol_test_%` databases; fixture port **55534 closed**. |

Evidence is retained in ignored `.local/agent-context-phase03/`: `backend-run.log`, `frontend-run.log`, build/typecheck/lint logs, `browser-run.log`, and browser JSON/screenshots in `browser/`. Final desktop/mobile exact-user and creator screenshots were inspected. The new context has no horizontal page overflow, and axe passes. The browser runs prove both navigation directions, exact same-name separation, cached responsible users absent from paid/report cohorts, negative lookup states, invalid links, denied reads/retry, unavailable sources, removed canonical identities, unchanged licensing/usage, and no additional provider writes beyond the existing bootstrap capability check. Actual backend HTTP tests separately assert unchanged token, Graph-detail, and Power Platform query counters for saved responsibility/navigation reads.

Failures during development were repaired rather than suppressed: strict new cohort expectations were updated, a directory-read effect was narrowed to avoid changing old paid/activity behavior, synthetic error fixtures were corrected to the actual `detail` contract, exact native matching fixtures retained their required schema-name evidence, and the mobile hover contrast defect was fixed. Builds and the final focused aggregations passed after these repairs. No tests or assertions were disabled.

### Parent-review repair: background source invalidation

Parent review found that mounted Users responsibility used only the Users-source revision. The always-mounted Sync panel can observe a background Power Platform or Graph completion/reset while Users remains open, leaving responsibility and current canonical IDs stale.

The repair threads the existing `agentReloadRevision` from `App` as an independent `agentInventoryRevision` through `CopilotUsersView`, paid-user details, `ReportedUserActivity`, and `ReportedUserDetail` to `UserAgentResponsibility`. It participates in both saved-query cache identity and response ownership/cancellation. Existing source-change handling already increments that inventory revision for both Power Platform and Graph, including reset; no provider call or new source collector was introduced. Existing `dataRevision` continues invalidating Users evidence. Inventory changes deliberately do not enter license/report read keys or selected-user keys, so the mounted user stays open and metrics are not re-read or redefined.

The new App regressions initially failed for both source completions with the old responsibility still visible. After the repair, eight real-App polling scenarios pass: Power Platform and Graph completion in each of the responsibility, paid-license, and active-report cohorts, plus both source-reset scenarios in the responsibility cohort. They assert the unchanged cohort, exact route/user and mounted paid/report dialog, unchanged directory/report read counts and reported responses, refreshed role labels, and navigation using the new canonical ID. The only unsafe request is the existing one-time bootstrap capability check; source events cause no new one. Two additional component regressions prove old evidence clears and pending reads abort/late results cannot replace newer relationships for either Users evidence or inventory revisions.

These tests also exposed a duplicate sibling React key shared by the Users root and the always-mounted report-import modal. The Users root now has a `users:`-prefixed principal key; it retains the same session-reset semantics and no longer emits duplicate-key warnings during the tested updates.

| Repair check | Observed result |
| --- | --- |
| Initial narrow App regressions, before revision propagation | **2 expected failures**, proving stale responsibility after PP/Graph completion; retained in `invalidation-red.log`. |
| Narrow App regression matrix | **8 passed**; completion across all three cohorts and reset for both sources. |
| `npm --prefix frontend test -- src/components/UserAgentResponsibility.test.tsx --reporter=dot` | **15 passed**, including both revision-fencing regressions. |
| `npm --prefix frontend test -- src/App.session.test.tsx src/components/UserAgentResponsibility.test.tsx src/components/CopilotUsersView.test.tsx src/components/ReportedUserActivity.test.tsx src/components/DataSyncPanel.test.tsx --reporter=dot` | **5 files, 428 passed**; `invalidation-ui.log`. |
| `npm --prefix frontend run build`; `npm --prefix frontend run lint` | **Passed**; `invalidation-build.log`, `invalidation-lint.log`. Existing Vite chunk-size warning only. |
| Editor diagnostics for all seven revised TS/TSX files; `git diff --check` | **No errors; clean diff hygiene.** |

Repair evidence is under the same ignored `.local/agent-context-phase03/` directory. The repair affects only frontend revision wiring/tests and this completion record: no backend, persistence, provider, root-script, dependency, deployment, or current user-documentation contract changed. The initial desktop/mobile and PostgreSQL results above remain the relevant validation for those unchanged boundaries; they were not rerun for this UI-only repair. The parent-owned campaign manifest and isolated PostgreSQL resource remain untouched.

### Authorized environment

Used the parent-owned isolated PostgreSQL instance at `127.0.0.1:55533`, base database `agentcontrol_test_campaign`, user `agentcontrol_admin`, SSL disabled, with the supplied synthetic test credentials and file-backed password overrides unset. Existing `testDatabase` created/dropped its own random test databases. The fixture served only `http://127.0.0.1:55534`; provider adapters were fixtures and external provider requests forbidden.

No container, unrelated database, shared service, or parent resource was stopped or deleted. No container CLI or additional dependency installation was necessary. The parent PostgreSQL container remains running; campaign evidence is local and ignored.

## Limitations and next-phase preconditions

- No live tenant, provider-authentication, production-deployment, or mutation success is claimed. There is no external implementation blocker.
- The existing invoked-flow source limitation remains unchanged and explicit. No Dataverse or inferred relationship integration was added.
- Phase 04 can rely on the new saved responsibility endpoint, complete-source paging, private cached-person context, exact navigation, unchanged license/report contracts, and passing focused evidence.
- Phase 04 still owns full-suite/fresh-schema/final browser convergence and the parent's current-doc sweep, including the previously identified stale Power Platform wording in `docs/operations.md`. These are not deferred phase-03 implementation tasks.
- Run the default full browser fixture without `AGENT_CONTROL_BROWSER_TEST_FILES` for phase-04 restart/quarantine postconditions. This phase intentionally used the bounded selected-spec mode.
