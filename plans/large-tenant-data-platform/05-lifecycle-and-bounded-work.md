# 05 — Lifecycle and bounded-work closure

## Mission and prerequisites

Complete cross-domain invalidation, recovery, retention, export/polling lifecycle and bounded backup/restore. Independently exercise the full user workflows after the **02B/04** atomic cutovers. Read [README](README.md), completions for 01, 02, 02A, 02B, 03 and 04, parent state and dirty status. GPT-6 Astra, `xhigh`.

Hypothesis: repeated replacements, corrections, disconnects, revocations and restarts cannot leak pins/staging/chunks or resurrect deleted/unauthorized data, and cleanup/checkpoint work cannot require a full table in PG/Node memory. First check a pinned-reader/export/GC/deletion race.

## Tooling contract

- Company-protected machine: **NEVER contact default/public npm or PyPI registries**, including probes, fallbacks, subprocesses or containers. npm registry access must use `https://packagefeedproxy.microsoft.io/npm/` via approved config or explicit `NPM_CONFIG_REGISTRY`; preserve the already-approved Dockerfile environment and parent-maintained project config.
- Python installs only with `python -m pip install --index-url https://packagefeedproxy.microsoft.io/pypi/simple <package>`; no public extra index, including inherited settings.
- Use existing dependencies. Install only after a manifest change or genuine missing-tool/package failure; no implicit `npx` downloads. Verify effective config locally and retain/reinject the approved registry after environment scrubbing. If the feed is unavailable, report it without public fallback. Follow README's binding tooling contract.

## Read first

- `backend/scripts/{database,backup,testDatabase,restart-fixture,cache-load}.ts`
- `backend/src/db/{dataSyncCleanupSchema,dataSync,sessions,jobs,officialUsage,agentUsage,agentIdentity,agentPeople}.ts` and generation/export/selection implementations
- `backend/src/services/{maintenance,operationalState,refreshExecution,bulkJobs,dataSync,agentInvestigations,agentContextExport,purviewAudit,defenderHunting}.ts`
- `backend/src/server.ts`, `backend/src/app.ts` if present, startup/drain/retention call sites
- `frontend/src/{App,useAutomaticRefresh,savedQueries,useAgentPeople}.tsx` or `.ts`, `frontend/src/components/{SavedQueryProvider,AgentSyncTools,DataSyncPanel,SyncHistoryView,OfficialUsageManageReports}.tsx`
- `Dockerfile`, `backend/scripts/{browser-fixture.browser.ts,browser-fixture.config.ts,fixtureSupport.ts,restart-runtime.mjs}`, `frontend/playwright.config.ts`, `frontend/browser/`, `scripts/{permission-browser,persistence,restart-runtime}.tests.ps1`
- `docs/{operations,security-model,deployment-setup}.md`

## Required implementation

1. **Lifecycle matrix with executable proofs.** Implement effects for safe replacement/detail updates, failed attempts, clear, official correction/select/delete, source expiry, revocation, tenant removal, privacy deletion, cancellation and restart. Safe new input preserves valid pinned temporal/history snapshots and allows active reconciliation to finish catching up; do not indiscriminately invalidate it. Clear/revoke/unsafe control and report correction/delete/expiry invalidate affected selections/exports/work before new reads. Include non-active report-set changes advancing tenant-history invalidation even when active-set revision is unchanged. Retained history is not a competing current head; no global purge for one principal's clear.
2. **Bounded temporal/history GC.** Replace full-snapshot cascades with immediate invalidation where required and bounded child-first cleanup. Protect current roots, active staging/worker input pins, valid selection/export pins and existing legally retained history. Resolve baseline/delta intervals and history-readable memberships relationally; no array of every reachable record/set and no N-row generation clone/delete per detail update. Once-closed validity metadata cannot reopen. Mark deleting under lock, rejecting new pins against deleting state. Delete at most 1,000 rows/1 MiB and 5 seconds per slice, yield and resume persisted keys; no hidden cascade or broad `RETURNING payload`. No invented legal-hold product.
3. **Pin/quota/recovery accounting.** Expire abandoned staging leases, selections, cancelled/failed chunks and ended jobs; release reservations once. Reacquire only through fenced lease takeover, never resurrect an expired owner. Resume valid captured work with unchanged invalidating epochs; safe newer input belongs in one coalesced pending request, not automatic cancellation. Independent heartbeats continue during waits/validation, stop on cancel/failure, and process death permits takeover. Restart sweeps are bounded/admission-aware; preserve session/job restore invalidation and provider-disabled maintenance.
4. **Export and polling closure.** Test every producer through the shared artifact path with slow readers, backpressure, cancellation, role loss, source invalidation and artifact expiry. Polls return metadata only and stop on terminal/unmount/logout; incomplete downloads fail audibly with audit status/counts/checksum, never look successful. Add bounded retries/idempotency for create/cancel/download setup; do not restart a failed job invisibly. Preserve dataset deletion immediately denying new reads/downloads even while physical chunk deletion is pending.
5. **Backup/restore is part of scaling.** `backup.ts` currently uses table-wide `string_agg(row_to_json(...))`, `readFileSync` for dump checksums and synchronous process buffering. Replace these with deterministic streaming/table-keyset fingerprint accumulation, streaming SHA-256/file IO and bounded subprocess output. Use one consistent PostgreSQL snapshot for dump and fingerprints; define stable table-key ordering without whole-table JSON sort. New tables can increase table count above the current arbitrary 100-table check: replace that with an explicit schema inventory validation, not unbounded discovery or a guessed small ceiling. Include schema version and fingerprint algorithm in a new receipt, without an old-data converter or compatibility branch for this campaign's receipt changes. Preserve exact target/ownership/checksum/restore-maintenance safeguards.
6. **Forward-only restore proof.** Back up an owned `agentcontrol_test_*` source and restore the **new schema** into a distinct owned **`agentcontrol_restore_*`** target under existing restore-name/ownership guards. Do not send restore targets through `testDatabase.ts` or weaken its integration-only prefix. Verify row/fact/pointer fingerprints, grants/readiness with provider admission disabled; reconcile deletion/access evidence before reopening. 07's full fresh synthetic application instead owns `agentcontrol` in its unique instance. A pre-reset production checkpoint is forensic only, never restored into the new production schema. No old-format reader/converter.
7. **Cross-root bounded-work audit.** Trace all remaining collection reads through provider collectors, routes, jobs/status payloads, CSV/context exports, saved-person/identity lookups, investigations, official history/overview and UI. Already bounded Purview/Defender provider result APIs retain their product semantics; adapt only direct new-storage dependencies or newly introduced unbounded paths. Document remaining intentionally bounded arrays and their exact cap. Remove obsolete data getters and stale contract imports; do not defer known leaks to 06.
8. **End-to-end isolated fixtures.** Implement the exact browser/restart matrix below. Browser enters the existing synthetic-auth **Vitest bootstrap**, never standalone Playwright. Add `frontend/browser/largeTenantData.spec.ts` (matching the existing basename-selector guard) for desktop/mobile, keyboard/focus, labels, overflow and pending/partial/catching-up/stale/unknown/error states. Measure requests/pages/cache/polling, not only screenshots. Exercise Users, imports/history, agents/details/responsibility, safe previews and every export kind. Restart uses source/tsx only in operator seed/expire, compiled code plus a read-only mounted harness in runtime crash/recover; no retained-project secret mounts or old PowerShell harness invocation.
9. **Operations.** Add structured low-cardinality metrics for generation rows/bytes, queue depths, publication/fence failures, selection/pin counts, GC backlog/oldest age, export chunks/progress and per-request returned rows/bytes. No user IDs/payloads/tokens in unbounded labels or logs. Add exact runbook commands for dry-run retention, restart recovery, isolated backup/restore and diagnostics-first cleanup; maintain existing local deployment gates unchanged.

## Scope guard

This phase closes lifecycle and operations for the already-cut-over domains; it is not a delayed frontend/API cutover or generic rewrite of unrelated audit/hunting providers. Repair a missed directly implicated consumer if discovered, and record the earlier boundary defect. No production resets, restores, external mutation, or application-secret fixture use.

## Validation

Add `backend/src/db/dataLifecycle.test.ts`, `backend/src/services/dataExportLifecycle.test.ts`, `backend/scripts/largeTenantRestore.test.ts`; implement wrapper suites `lifecycle`, `restore`, `restart`, `browser`.

```sh
npm run test --workspace backend -- src/db/dataLifecycle.test.ts src/services/dataExportLifecycle.test.ts src/db/dataSyncCleanup.test.ts src/db/multiTenantIsolation.test.ts src/db/sessionsIsolation.test.ts src/services/automaticRefreshIntegration.test.ts src/services/maintenance.test.ts src/services/operationalState.test.ts scripts/backup.test.ts scripts/largeTenantRestore.test.ts scripts/dataSyncPersistence.test.ts
npm run test --workspace frontend -- src/components/AutomaticRefreshStatus.test.tsx src/components/DataSyncPanel.test.tsx src/components/SyncHistoryView.test.tsx src/components/OfficialUsageManageReports.test.tsx src/App.session.test.tsx src/savedQueries.test.tsx
```

### Exact browser and restart execution matrix

Build run-owned candidate images from the same worktree: Dockerfile targets `operator`, `runtime` and `permission-browser-test`, recording immutable image IDs and distinct tags. Never reuse the baseline operator as changed-code proof or mutate retained tags. Use an owned internal fixture network with PostgreSQL service alias `test-postgres`, **no host port or external-provider route**, and synthetic credentials only. Wait for PostgreSQL health before bootstrap. Integration control DB is a generated valid `agentcontrol_test_<run>_control`; child DB names/receipt checks retain the existing guards. This transport does not change the existing software gate's isolated network/host checks.

| Step | Image / workdir / effective command | DB role, mounts and required result |
| --- | --- | --- |
| Browser | `permission-browser-test`, `/app/backend`; `node /app/node_modules/vitest/vitest.mjs run --config scripts/browser-fixture.config.ts` (the existing image entrypoint) | `NODE_ENV=test`, `AGENT_CONTROL_FIXTURE_MODE=browser`, `PGHOST=test-postgres`, guarded integration control DB and synthetic admin/app fixture passwords. Bootstrap uses admin to create its child DB, then app connections use `agentcontrol_app`. Source/config/specs and built frontend come from this image; only owned evidence output is mounted. |
| Restart seed | `operator`, `/app`; existing entrypoint `node node_modules/tsx/dist/cli.mjs` with arguments `backend/scripts/restart-fixture.ts seed /evidence/restart-fixture.json` | `PGHOST=test-postgres`, control DB, `PGUSER=agentcontrol_admin`, synthetic admin/app passwords. Owned `/evidence` bind is writable. Exit 0; receipt names the guarded child DB and seeded jobs/fingerprints. Keep that child DB for crash/recovery. |
| Restart crash | `runtime`, `/app`; override entrypoint to `node`, arguments `/fixture.mjs crash` | Read-only bind of this worktree's `backend/scripts/restart-runtime.mjs` at `/fixture.mjs` and seed receipt at `/evidence/restart-fixture.json`. `PGUSER=agentcontrol_app`, synthetic runtime password/session secret only, **no admin password**. Script validates receipt prefix and selects its child DB before importing `/app/backend/dist/...`. Expected exit **17** only at the verified dispatch boundary. |
| Restart expire | Same `operator`, `/app`, existing tsx entrypoint; arguments `backend/scripts/restart-fixture.ts expire /evidence/restart-fixture.json` | Admin fixture env/control DB and same receipt; script validates and opens only receipt-selected `agentcontrol_test_*` child DB. Expire only fixture job/canary leases. Exit 0. |
| Restart recover | Fresh container from the same `runtime` image, `/app`; entrypoint `node`, arguments `/fixture.mjs recover` | Same read-only script/receipt mounts and runtime-only role/env. Exit 0 after compiled-runtime recovery/readback assertions. No source `tsx`, Vitest or absent backend scripts assumed inside runtime image. |

Browser bootstrap must retain hoisted synthetic MSAL/provider mocks, fixture setup, Express startup with built frontend, listening wait and **`/api/ready` = 200 before launching Playwright**. It then launches the existing `../node_modules/@playwright/test/cli.js test --config ../frontend/playwright.config.ts` subprocess itself. Set `PLAYWRIGHT_BASE_URL=http://127.0.0.1:3001` inside this isolated browser container, never publish it as a retained-host listener. For focused execution, allow validated `AGENT_CONTROL_BROWSER_TEST_FILES=largeTenantData.spec.ts`; retain the existing 1-32 distinct basename guard, no regex weakening. Also run unfiltered (variable unset) to cover all existing/new desktop/mobile specs and bootstrap postconditions, not only sign-in smoke. Cleanup must execute bootstrap `afterAll` plus diagnostics-first wrapper teardown.

Both crash and recover paths must start the compiled app, await listening and assert readiness 200 before the respective dispatch/recovery checks. For crash, assert **the expected marker, exit 17 and receipt-selected persisted dispatch state together**; arbitrary nonzero exit is failure. Only then expire and recover. Confirm waiting-authorization/inconclusive/reconciliation-required states and no automatic real provider dispatch, plus fixture-only resume/readback/fingerprint assertions. Preserve this flow while extending it for new generation heartbeat/process-death takeover fences.

Make private evidence permissions readable by the exact runtime fixture UID/GID (use matched owned fixture identities), not world-readable secret files. Capture each container's exit/logs/inspect/OOM state and bounded DB assertions before removing it; retain the crash receipt/DB through recover. Cleanup drops only tracked owned child/control/restore DBs after connections close, then exact project resources. No retained configuration/credential mounts.

Restore inner command in the owned operator/test environment: `npm run test --workspace backend -- scripts/largeTenantRestore.test.ts scripts/backup.test.ts`. It creates `agentcontrol_restore_*` via the existing restore operator, not integration database bootstrap.

Root entry commands:

```powershell
pwsh -NoProfile -File ./scripts/large-tenant-tests.ps1 -Suite lifecycle
pwsh -NoProfile -File ./scripts/large-tenant-tests.ps1 -Suite browser
pwsh -NoProfile -File ./scripts/large-tenant-tests.ps1 -Suite restore
pwsh -NoProfile -File ./scripts/large-tenant-tests.ps1 -Suite restart
```

Attempt README aggregate software commands. Test GC vs temporal/history/worker pins and publication; 32 history sets with concurrent acceptance/non-active correction/delete; deletion during artifact build/download; safe detail churn allowing canonical progress; logout during append/Retry-After/validation; independent renewal failure and process-death takeover; session epoch after restart; two tenants/two principals; crashes before/after pointer commit; cold-start/drain; expired cursors; orphan staging/chunks; quota recovery; repeated fingerprints and restore with no write exposure. Capture diagnostics before owned cleanup.

## Production continuation

Apply README's Always-Deploy contract. Every non-passing result has repair attempt, truthful status, bounded containment, numeric signal/threshold, 07 owner and fix-forward trigger. Cleanup failure remains an active incident, not concealed as a successful test. Do not bypass the checked-in deployment gate if it refuses.

## Completion record and done conditions

Write exactly `completions/05-lifecycle-and-bounded-work.md`, including lifecycle matrix, bounded-array inventory, temporal/history GC and heartbeat/takeover proof, exact browser Vitest and restart image/workdir/role/mount/exit receipts, network/cache bounds, guarded backup/restore evidence, cross-root changes, commands and residuals.

06 receives a complete functioning platform with no known unbounded app-data path, exact operational counters, reproducible isolated browser/restore suites and diagnostics collection. Resource qualification is the next owner, not a replacement for this phase's correctness.
