# Phase 04 completion — Fresh-schema and end-to-end convergence

## Result and authority

**Complete and locally verified.** Parent acceptance and exact owned-runtime cleanup are also complete; see the final closure below.

Date: 2026-09-23. Prompt SHA-256: `cc06ae5e73486e15719a2f21b60512c2ab303ded024249eef0b5244b07364b50`.

The assigned GPT-6 Astra worker used the requested extra-high reasoning posture without nested delegation. The application boundary was the single `agent_control` repository, including backend, frontend, database/browser scripts, root orchestration and current documentation. All four prompts, the roadmap, three prior completion records, campaign state and step-worker contract were reviewed. No applicable repository `AGENTS.md` was found.

Accepted phases 01–03, including the parent's independent inventory-revision propagation through all three Users cohorts, remain intact. The parent-owned campaign manifest was not edited. There was no commit, push, branch, dependency installation, production deployment, live tenant access or provider integration.

## Final convergence and repairs

The aggregate implementation was checked against the prompts and actual controlling source, schema, API, UI and fixture paths, not only the earlier phase reports.

- Replaced the stale operations claim that a Power Platform explorer still owns a technical resource export. Current guidance now names the authorized, audited **agent-only** saved-snapshot export and exact `/sync?powerPlatformJob=<id>` inspection/recovery contract.
- Removed stale README/operations references to the deleted **Connected services** heuristic view. Package configuration and typed canonical identity evidence remain distinct from native dependency relationships.
- Reconciled README, operations and setup instructions with the **fresh development database** requirement. Broad-catalog databases are not an in-place upgrade target; clean resync does not convert a schema. No compatibility migration, backfill, dual reader, alias or retired-route redirect was added.
- Clarified the earlier Azure production runbook's boundary: it is historical deployment guidance, not qualification or authorization for this local agent-centered development revision. No deployment script/configuration was changed or executed.
- Documented the independent Agent responsibility cohort, including people absent from paid/report cohorts, without redefining licensing or observed usage. Setup diagnostics now explicitly count agents plus supporting environments and distinguish current three-automatic-source runs from retained four-source report runs.
- Updated the backend Users workbench source description to include **exact saved Power Platform agent responsibility**, retaining the same Viewer access. Added a regression assertion for this metadata.
- Expanded actual PostgreSQL rejection coverage from four representative retired types to **all nine** retired types. Every case now verifies job requested types, snapshot requested types, snapshot queried coverage and resource-row constraints; failed writes leave the valid saved agent readable.

The nine rejected types are canvas apps, model-driven apps, code apps, generic Power Apps, cloud flows, agent flows, M365 agent flows, standalone connectors and environment groups. Only `microsoft.copilotstudio/agents` and `microsoft.powerplatform/environments` remain accepted.

## Verified retained contracts and deletion boundary

- DataSync, explicit refresh, role planning, normalization, fresh schema and verification agree on the same two-type source. Environment rows are supporting context, not an independently browsable/exportable catalog.
- Provider projection → scoped persistence → canonical agent response → CSV preserves embedded operation configuration, operation creator, false booleans, separate reported/saved counts and independently observed environment metadata. Malformed, capped, missing, denied and stale evidence stays unknown/partial rather than becoming a confirmed zero.
- Connector configuration is not execution or access. Owner, creator, last modifier and operation configuration creator remain distinct. Arbitrary keys, GUID fragments, names, URLs, shared connectors/environments, usage and access assignments do not create responsibility/dependency edges.
- Current Resource Query and Graph package sources **do not establish invoked-flow relationships**. Overview and exports explicitly say so; fixed Microsoft console landing links are handoffs, not exact-target guarantees, relationship proof or mutation authority. No Dataverse integration or flow parser was added.
- Saved responsibility uses complete independently bounded canonical sources, tenant/principal-private people evidence, exact Entra object IDs and snapshot/revision guards. Real PostgreSQL tests cover responsible people outside paid/report cohorts, linked and native-only agents, canonical persistence across refresh, removed identities, and foreign tenant/principal denial.
- All three Users cohorts retain the parent's independent `agentInventoryRevision` invalidation. Selected people and licensing/report evidence are preserved while background Power Platform/Graph completion or reset refreshes saved responsibility. Cancellation and stale-response tests remain in the full frontend suite.
- Removed catalog navigation, generic detail/explorer/picker, catalog list/snapshot/target APIs, broad types and heuristic service extraction stay deleted. Old catalog bookmarks render the explicit unknown-page experience; they make no application request and are not redirected.
- Retained agent activity and export endpoints remain exact-snapshot scoped. Canonical and source exports preserve authorization, snapshot/revision revalidation, audit and size/deadline limits. Scope reduction did not reduce OAuth requirements.
- Package access/block actions, quarantine/restore, source-job resume/cancel/retry, exact activity associations, private diagnostics, role gates, CSRF, confirmation and fail-closed freshness controls remain exercised.

The recorded runtime/documentation sweep found no retired runtime consumers or obsolete explorer/dependency labels. Retired type/route strings in negative tests are intentional; historical plans and unrelated existing migration machinery were not rewritten or removed.

## Changed files and cross-application impact

Phase-04 edits, relative to the accepted phase-03 worktree:

| Root | Files changed in this phase / impact |
| --- | --- |
| Backend | `src/db/powerPlatformInventory.test.ts`: exhaustive fresh PostgreSQL rejection checks. `src/services/workbenchMetadata.ts` and its test: accurate Users source metadata with unchanged authority. |
| Frontend | No additional implementation edit required. Reviewed App navigation/invalidation, routes, source-job actions, Overview, explicit people lookup, three Users cohorts, API types, exports, shared/deleted CSS and relevant negative fixtures. Full unit/build/lint and desktop/mobile browser checks validate the existing phase-01–03 changes, including the parent repair. |
| Backend scripts | No additional edit required. Reviewed `testDatabase`, bootstrap/migration/grants and native restore tests; existing fresh isolated database lifecycle proves the contract. Reviewed the browser fixture's safe exact-spec selector and full-run restart/quarantine postconditions; final runs omit the selector. |
| Root scripts / infra / manifests | No edit required. Checked orchestration and permission/deployment consumers; no removed catalog API/type consumer remains. Existing `ResourceQuery.Resources.Read` permission and application-wide operational controls are still required. No dependency or deployment change is warranted. |
| Current documentation | `README.md`, `docs/operations.md`, `docs/deployment-setup.md`, `docs/azure-production-deployment.md`: current two-type/source/export/relationship semantics and explicit fresh-development versus historical production boundary. Prior changes in security/provider/license documents remain intact and were reviewed. |
| Plan evidence | This completion record only. Parent retains `IMPLEMENTATION_CAMPAIGN.md` and final campaign closure. |

Exact aggregate file/status evidence is retained in ignored `.local/agent-context-phase04/status-final.txt`, with `changed-final.txt` and `diff-numstat.txt` for tracked changes. At worker handoff there are **125 changed/untracked paths: 99 modified, 4 deleted, 22 untracked** (backend 54, frontend 54, docs 6, root README 1, plans/completions 10). This includes earlier campaign work, not just this phase. The four deleted paths remain the explorer and quarantine target picker plus their tests. Prompt hashes still match the manifest.

## Executed validation

All tests used existing installed tooling. The database environment was restricted to the parent-owned PostgreSQL **17.11** instance at `127.0.0.1:55533`, control database `agentcontrol_test_campaign`, user `agentcontrol_admin`, SSL disabled. File-backed password overrides were unset and the repository's synthetic fixture password was used for operator/runtime tests. Native PostgreSQL 17 clients came from `/opt/homebrew/opt/libpq@17/bin`; no backup/restore test was skipped for missing tooling.

| Command / check | Observed result |
| --- | --- |
| Initial operations documentation hypothesis: obsolete-label sweep plus `git diff --check` immediately after the first edit | Confirmed stale explorer/Connected services text, then verified removal and clean diff. |
| `npm --prefix backend test -- src/db/powerPlatformInventory.test.ts -t 'rejects retired type'` | **9 passed**, all real PostgreSQL rejection boundaries. The name filter excluded 22 unrelated cases in this focused run only; the later full suite runs all of them. |
| `npm --prefix backend test -- src/services/workbenchMetadata.test.ts` | **8 passed**. |
| Initial `npm --prefix backend test` | **110 files, 2,502 passed**, before expanding five more retired-type cases. |
| Final `npm --prefix backend test` | **110 files, 2,507 passed**, including fresh bootstrap, all migrations/grants, real persistence, runtime privilege denial, native dump/restore, canonical/control/privacy and export suites. `backend-full-final.log`. |
| `npm --prefix frontend test` | **66 files, 1,833 passed**, including the parent's eight App source-completion/reset scenarios and stale-response regressions. `frontend-full.log`. No frontend code changed afterward. |
| `npm --prefix backend run build`; `npm --prefix backend run typecheck` | Passed initially and again after the final backend metadata/test edits. `backend-build-final.log`, `backend-typecheck-final.log`. |
| `npm --prefix frontend run build`; `npm --prefix frontend run lint` | Passed. `frontend-build.log`, `frontend-lint.log`. |
| Full browser fixture command below | **316 passed, 8 intentional duplicate-layout skips**; enclosing Vitest fixture **1 passed**, including report restart and quarantine postconditions. `browser-full.log`, `browser/permission-browser-results.json`. |
| Repeated full browser fixture after the final backend metadata edit | **316 passed, the same 8 intentional skips; 0 failures/flaky outcomes**. Enclosing fixture **1 passed**, including all restart/quarantine postconditions. `browser-full-final.log`, `browser-final/permission-browser-results.json`, `browser-final-summary.json`. |
| Editor diagnostics; `git diff --check`; final deletion sweep | No diagnostics errors; clean diff; no obsolete runtime/catalog consumers. `deletion-sweep.txt`. |

Full browser command, with the same isolated DB/client environment:

```sh
env -u PGPASSWORD_FILE -u APP_PGPASSWORD_FILE -u AGENT_CONTROL_BROWSER_TEST_FILES \
  NODE_ENV=test AGENT_CONTROL_FIXTURE_MODE=browser \
  PLAYWRIGHT_BASE_URL=http://127.0.0.1:55534 \
  PLAYWRIGHT_EVIDENCE_DIR="$PWD/.local/agent-context-phase04/browser-final" \
  npm --prefix backend test -- --config scripts/browser-fixture.config.ts
```

The fixture permits only local mocked-provider execution and rejects external fetches. Its `/api/ready` endpoint was independently observed returning `{"ok":true}` during both runs. No live-provider success is claimed.

### Browser scope, intentional skips and visual proof

The complete run contains **324 scheduled cases**: **162 desktop passes**, **154 mobile passes**, and **8 mobile skips**, with no unexpected failures or flaky retries. The only skip site is `frontend/browser/layout.spec.ts:32`: its desktop project explicitly runs the full **360, 768, 1280 and 1920 px** viewport matrix, so the mobile project does not duplicate it. Exact skipped scenarios are **agents**, **users**, **report-snapshot**, **audit-local**, **audit-purview**, **security**, **permissions**, and **jobs**. No new skip, relaxed assertion or retry was introduced.

Actual rendered screenshots were inspected for desktop/mobile environment context, configured operations, exact-user responsibility and Sync's exact source job. Final-repeat operation/responsibility screenshots were also inspected. Responsive fields and long operation creator IDs wrap within their containers; header/tab/close controls remain visible, and the Users handoff and source-job recovery remain readable without horizontal page overflow. Existing geometry and axe assertions passed, including the report-detail hover-contrast regression. These are browser rendering results, not inferred from builds.

Useful screenshot names under `browser/playwright/` and the final repeat's `browser-final/playwright/`:

- `agentContext-*/agent-context-environment.png`
- `agentContext-*/agent-context-configured-operations.png`
- `agentResponsibility-*/exact-user-responsibility.png`
- `agentResponsibility-*/creator-responsibility.png`
- `permissions-*/source-job.png`

The full fixture additionally verifies retained official-report fingerprints across restarting its own server, expected two confirmed quarantine writes/readbacks and two successful quarantine jobs, and **zero package mutation jobs**. Coverage includes sparse Graph/native agents, missing/empty/partial configuration, unknown flows, both responsibility navigation directions, negative people evidence, denied reads/retry, exact failed/waiting/running/succeeded/cancelled source jobs, retained action gates, exports, activity, report/licensing semantics and retired route absence.

## Environment ownership, cleanup and parent handoff

Only existing test machinery created/dropped random fixture databases and its own native restore database. No shared service, application database or volume was reset. Container configuration was obtained before the only container CLI action, a read-only inspect of `agent-control-agent-context-744531fc`.

Observed identity: running `postgres:17-bookworm`, label `agent-control.campaign=744531fc-agent-centered-power-platform`, loopback binding `127.0.0.1:55533`, and one isolated anonymous PostgreSQL data volume. The exact owned volume and read-only inspect are recorded in `container-ownership.txt`; it is not a shared application volume.

After the final repeated browser run exited successfully, a read-only PostgreSQL check found **only `agentcontrol_test_campaign`** among `agentcontrol_test_%` and `agentcontrol_restore_%` databases. The fixture listener at **127.0.0.1:55534 is closed** (`ECONNREFUSED`); its process exited normally. Evidence: `database-cleanup.txt`, `listener-cleanup.txt`. Useful ignored phase evidence is retained; no broad cleanup was performed.

**Worker handoff:** step 7 was intentionally left with the parent so PostgreSQL remained available for independent final checks. The parent subsequently removed only the exact campaign container and its owned anonymous volume, as recorded below. The worker did not close the campaign manifest or touch `agent-control-phase01`, `seha`, other databases/containers or shared listeners.

## Residual limitations

- No live Microsoft tenant, provider authentication, consent, role or mutation proof; all provider behavior was fixture-backed.
- Invoked-flow identity/invocation/version coverage genuinely remains unavailable from the authorized sources. The shipped UI/export limitation and safe official handoff are the complete supported behavior, not an unfinished integration.
- Existing nonfatal Vite chunk-size and test-only Express-session deprecation warnings remain unchanged.
- No unresolved product, schema, cross-root or compatibility decision remains. Parent final checks and cleanup are recorded below.

## Parent acceptance and closure

- Reviewed the final source/schema/documentation changes, aggregate test logs, browser summary and actual desktop/mobile configured-operation screenshots.
- Independently reran all **39 tests** in `src/db/powerPlatformInventory.test.ts` and `src/services/workbenchMetadata.test.ts` against the isolated PostgreSQL instance: all passed. Final editor diagnostics and diff hygiene were clean; prompt hashes matched the manifest.
- Verified all generated fixture/restore databases were removed, leaving only the control database. Rechecked the named container's campaign label, auto-remove flag and exact owned anonymous volume before stopping it.
- Stopped only `agent-control-agent-context-744531fc`. Verified the container and its anonymous volume were removed, the attached process exited 0, and both loopback ports **55533** and **55534** were closed.
- Shared applications/databases were untouched. Useful ignored evidence remains available. All four phases are accepted; changes remain uncommitted, with no production deployment or live-provider proof.
