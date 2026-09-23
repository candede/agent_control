# Implementation campaign

## Scope

- Plan folder: `plans/agent-centered-power-platform`
- Repository: `agent_control` (the repository containing this file), including backend, frontend, scripts and current docs.
- User authority: 2026-09-23 forward-only implementation; obsolete data may be discarded, no backward compatibility, no production.
- Target: local code and isolated fresh PostgreSQL/browser validation only.
- Disposable resource boundary: `agent-control-agent-context-744531fc` container, campaign label, ephemeral loopback port, no shared volume; generated `agentcontrol_test_*` databases only.
- Baseline: branch `main`, clean worktree.
- Workers: fresh sequential GPT-6 Astra contexts with `xhigh` effort, per the user's latest explicit instruction. This overrides the skill's default worker model. No commits/pushes.

## Stable manifest

| Order | Prompt | SHA-256 | Completion | Status |
| --- | --- | --- | --- | --- |
| 01 | `01-retire-catalog-and-narrow-sync.md` | `33810f938a3400e3cb6127c2148868b127e66b96ca7d0f1096ddfe68b5c4fc55` | `completions/01-retire-catalog-and-narrow-sync.md` | complete |
| 02 | `02-agent-resource-context.md` | `d6939fd83309713b0bb7f9b6033a3b466abb3c5304fe8275252194d60118750c` | `completions/02-agent-resource-context.md` | complete |
| 03 | `03-user-agent-responsibility.md` | `02e520b534c99a139dd86e1aa21bfab5ba4767b94f58d053bfc1082ff1fe2825` | `completions/03-user-agent-responsibility.md` | complete |
| 04 | `04-validation-and-documentation.md` | `cc06ae5e73486e15719a2f21b60512c2ab303ded024249eef0b5244b07364b50` | `completions/04-validation-and-documentation.md` | complete |

## Parent decisions

- A new plan folder is being created because the user requested a new plan and implementation, not execution of the historical production roadmap.
- Existing runtime services are shared and will not be reset. Fresh schema validation uses an isolated campaign-owned test container.
- Preserve source collection/auth/verification/controls, not the standalone inventory page. Reduce the supported source universe, not merely a default UI filter.
- Remove PP-specific compatibility routes and detail aliases; do not expand into unrelated historical compatibility cleanup.
- Microsoft inventory documentation reviewed on 2026-09-23 confirms agent-embedded connector operations and environment fields, but no invoked-flow relationship in Resource Query. Separate bounded source research is checking an explicit supported contract; no guessed relationship is authorized.
- Latest user instruction: all newly launched subagents must use GPT-6 Astra with xhigh effort. A public-source research agent was already running before this instruction; no additional work will be delegated to its default-model context.
- Flow-source decision (research completed): the current Graph package and Resource Query contracts do not establish agent-to-invoked-flow identities. Graph package definitions and declarative action/plugin manifests prove plugin relationships, not native Power Automate flow identities. Phase 02 must implement an explicit "invoked-flow relationships not established by synced sources" state with a safe official-console handoff, not fake flow rows, inferred IDs, an empty confirmed list, or an unused relationship schema.
- Dataverse has a documented `bot -> botcomponent -> botcomponent_workflow -> workflow` association, but its contract does not prove invocation, published-version scope or exhaustive/transitive coverage. It additionally needs an authoritative Dataverse organization URL and separate environment-specific authorization. Do not add this new integration or label association as invocation in this campaign. This is a source-semantic limitation, not a skipped UI implementation.
- Source evidence for the flow decision: [package element](https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/api/admin-settings/package/resources/packageelement), [declarative actions](https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/declarative-agent-manifest-1.8#actions-object), [plugin runtimes](https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/plugin-manifest-2.4#runtime-object), [component/workflow relationship](https://learn.microsoft.com/en-us/power-apps/developer/data-platform/reference/entities/botcomponent#botcomponent_workflow), and [Dataverse OAuth](https://learn.microsoft.com/en-us/power-apps/developer/data-platform/authenticate-oauth).
- Phase 03 precondition discovered by parent: Users currently exposes a paid-license cohort and active-unpaid-report cohort, not all agent-responsible identities. `CopilotUsageService.loadDirectory` collects licensed candidates plus active report identities, while `AgentPeopleService.refreshReferences` already separately resolves exact owner/creator/modifier IDs into the private people cache. Therefore responsibility navigation must not require membership in the paid-license roster. Provide a saved agent-responsibility Users cohort/context (or an equally complete direct design) using native agent person IDs plus existing saved people evidence, including responsible users absent from license/report cohorts. Do not broaden collection to a tenant-wide directory merely to support navigation. Keep licensing/usage evidence unknown when absent, and preserve unresolved/not-found identity states. This is necessary for the user-or-agent starting-point requirement.
- Final documentation sweep item found during parent preparation: `docs/operations.md` still says the Power Platform explorer retains a technical resource export (around line 88). Phase 04 must remove this stale active-product wording and check adjacent operational documentation for the current agent-only export/source-job design.

## Validation

- Before campaign: three focused frontend behavior tests passed during read-only analysis; baseline repository was clean.
- Public source contracts inspected: Microsoft Learn Power Platform inventory schema and Copilot Studio agent inventory schema.
- Local Docker available; existing PostgreSQL 17 image present. Existing application containers remain untouched.
- Created the authorized isolated PostgreSQL container using the existing image. Verified its campaign label and running state; `pg_isready` reports accepting connections.
- Local test connection: `PGHOST=127.0.0.1 PGPORT=55533 PGUSER=agentcontrol_admin PGDATABASE=agentcontrol_test_campaign PGSSLMODE=disable`. Use the repository's synthetic `fixturePassword` for both test administrator and runtime roles; this is not a real credential. Clear inherited `PGPASSWORD_FILE`/`APP_PGPASSWORD_FILE` when running fixture tests.
- Verified host access with the PostgreSQL client library: current database is `agentcontrol_test_campaign`, current user is `agentcontrol_admin`, PostgreSQL is 17.11.
- Verified local Playwright Chromium can launch headlessly and navigate to `about:blank`; no browser dependency installation is needed.
- Phase 01 worker launched with GPT-6 Astra and xhigh effort. Its completion record and scoped diff remain subject to parent review.
- Phase 01 completed and parent-reviewed: fresh-schema allowlists, retained agent-only activity/export contracts, catalog/route deletion, source-job inspection, shared-control preservation and cross-root updates inspected. No blocking gap found.
- Phase 01 worker evidence: 2,467 backend tests, 1,797 frontend tests and 302 desktop/mobile browser tests passed; eight existing duplicate-layout skips. Builds/typecheck/lint and diff hygiene passed. Full commands and fixture boundaries are recorded in the phase completion.
- Parent independently reran 52 source-job/routing frontend tests and 82 Resource Query/role-scope backend tests: all passed. Editor diagnostics and `git diff --check` report no errors.
- PostgreSQL 17 native client tools are already installed under `/opt/homebrew/opt/libpq@17/bin`; include this path for aggregate database backup/restore tests.
- Phase 02 completed and parent-reviewed: scoped current environment projection, rich documented connector operations, removed heuristic references, explicit people lookup, safe exports and official landing links. No blocking gap found.
- Phase 02 worker evidence: 457 focused backend, 435 focused frontend and 28 desktop/mobile browser tests passed; six final context browser checks rerun after CSS cleanup. Builds/typecheck/lint/diagnostics and diff hygiene passed.
- Parent independently reran 16 Overview/people frontend tests and 100 parser/export backend tests: all passed. Reviewed desktop/mobile configured-operation screenshots in ignored `.local/agent-context-phase02/context-proof/`; no horizontal overflow or obscured action structure found.
- Phase 02's bounded browser fixture selector (`AGENT_CONTROL_BROWSER_TEST_FILES`, exact spec basenames) is available for focused checks. Omit it for final full validation so restart/quarantine postconditions run.
- Phase 03 worker returned an implementation and completion record. Parent reviewed scoped projection, exact APIs/IDs, canonical navigation, lookup states and desktop/mobile responsibility screenshots. Independently reran 114 backend service/route/real-PostgreSQL integration tests and 54 frontend responsibility/routing tests; all passed, with clean relevant diagnostics.
- Phase 03 acceptance repair: background Power Platform/Graph source changes invalidate Agents but did not invalidate mounted Users responsibility, which only received the existing Users-source revision. The retained DataSync panel can observe completed sources while Users is active. Parent requested a bounded fix and falsifying App regression from the same phase worker before acceptance; licensing/usage semantics and saved-only reads must remain unchanged.
- Phase 03 repair accepted: the existing inventory reload revision now independently invalidates responsibility across all three Users cohorts, without re-reading/redefining license/report evidence or closing selected users. Eight App completion/reset regressions and component cancellation/late-response tests were added. Worker reran 428 focused frontend tests, build/lint/diagnostics and diff hygiene successfully. Parent inspected revision propagation and independently reran 20 matching App background-refresh/revision checks successfully (other tests excluded by the deliberate name selector).
- Phase 03 overall evidence: 297 backend, 717 initial focused frontend, and 48 desktop/mobile browser tests passed; then the focused repair checks above. Required completion exists, all prompt hashes remain unchanged, and no blocking implementation gap remains.
- Parent additionally reran all 15 responsibility component tests after the repair; all passed, with clean diagnostics for the five changed implementation components.
- Phase 04 completed and parent-reviewed. Current operations/setup/README guidance and Users source metadata now match the agent-centered design. Actual PostgreSQL tests reject all nine retired types at job, snapshot, queried-coverage and resource constraints. The final deletion sweep found no obsolete runtime consumers or compatibility paths for the retired catalog.
- Final aggregate evidence: **2,507 backend tests across 110 files**, **1,833 frontend tests across 66 files**, backend build/typecheck, frontend build/lint and diagnostics/diff hygiene all passed. The full browser fixture passed **316 tests** twice, including restart and quarantine postconditions. Its eight existing mobile skips only avoid duplicating the desktop project's complete viewport matrix; no unexpected failures or flaky outcomes.
- Parent inspected final aggregate logs/browser summary and actual desktop/mobile configured-operation screenshots, independently reran **39 backend fresh-schema/source-metadata tests**, and verified all four prompt hashes. All checks passed. No live tenant, provider consent/authentication, or deployment success is claimed.

## Environment closure

- After final parent tests, only the empty control database `agentcontrol_test_campaign` remained among campaign fixture/restore databases.
- Reconfirmed the exact `agent-control-agent-context-744531fc` container name, campaign label, auto-remove setting and owned anonymous volume `8c573749cfefe5b5b8f0034567b32283d45371076648e3b9bbcc1e4e47dbda43` before teardown.
- Stopped only this named container. Auto-removal deleted the container and its anonymous volume; exact filtered Docker queries returned neither resource. The attached parent process exited with code 0.
- Verified both campaign PostgreSQL port **55533** and browser fixture port **55534** are closed. No shared application service, database or volume was reset or stopped.
- Useful ignored logs/screenshots remain in `.local/agent-context-phase01` through `.local/agent-context-phase04` where created. Completion records retain the validation and source limitations.

## Current action

**Complete: 4 of 4 phases accepted.** All required completion records exist, actionable findings are resolved, and owned runtime cleanup is verified. Changes remain uncommitted on `main`; no branch, commit, push or deployment was performed. This forward-only revision expects a fresh development database rather than an upgrade of broad-catalog data. Existing shared applications remain untouched.
