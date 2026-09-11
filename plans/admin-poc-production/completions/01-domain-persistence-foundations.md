# Phase 01 - Domain, Persistence, and Provider Foundations

## Status

```yaml
phase_file: 01-domain-persistence-foundations.md
phase_status: complete
outcome: completed_with_residuals
validated_at_utc: 2026-09-08T14:37:32Z
execution_target: local Docker project agent-control-phase01 on managed macOS; no cloud/provider changes
```

This replaces the interrupted package-feed checkpoint. Phase 01 implementation and local qualification are complete. No commit, push, Azure deployment, provider grant change or Phase 02 implementation occurred. The running production revision remains untouched.

## Delivered contracts

- **One runtime authority:** PostgreSQL 17, Node 24, maintained `pg` and `connect-pg-simple`. Structural connection settings, UTC, max four connections, 5-second connect/15-second statement timeouts. [Pool](../../../backend/src/db/pool.ts), [schema](../../../backend/src/db/schema.ts), [operator commands](../../../backend/scripts/database.ts).
- **Schema/roles:** versions 1 and 2 contain only sessions, source identifiers, jobs/items/attempts with leases, append-only audit and legacy import receipts. Operator `agentcontrol_admin` owns migration/DDL/retention; `agentcontrol_app` has restricted DML, audit SELECT/INSERT only, no object ownership/escalation or receipt access. Explicit migration advisory lock, checksum/unknown-version rejection, transactional forward upgrades, no runtime auto-DDL. No applied SQL was edited after local installation. Phase 02 owns the next additive migration.
- **Durable mutation cutover:** [repository](../../../backend/src/db/jobs.ts), [worker](../../../backend/src/services/bulkJobs.ts), [routes](../../../backend/src/routes/agents.ts), [client](../../../frontend/src/api/client.ts), [status helpers](../../../frontend/src/jobStatus.ts). All single/bulk/block-all/access writes return 202 jobs; scoped immutable intent/idempotency, no old `completed` state alias or in-memory job authority. Exact tenant/principal/source/native target distinctions; source uniqueness is tenant/source/environment/kind/value scoped.
- **Bounded execution:** two workers, five unfinished jobs per principal, 5,000 targets, 120-second database-time owner/version leases, ten claims, 30-minute dispatch deadline, seven-day job retention. Intent precedes dispatch; no mutation retries; successful results require readback. Lost leases cannot dispatch/commit. Sent unknown outcomes stay inconclusive/partial and never replay. Unsent restart work requires current credentials and explicit authorization; exhausted jobs no longer advertise Resume. Cancellation stops unsent work only; failed result commits remain lease-recoverable.
- **Sessions/audit:** [session store](../../../backend/src/db/sessions.ts), [auth](../../../backend/src/routes/auth.ts), [audit](../../../backend/src/services/auditLog.ts). Eight-hour expiry/pruning, login ID regeneration, allowlisted account/user serialization, no tokens/cache blobs in PostgreSQL. Audit start/outcome rows are appended and read through a scoped projection. Original mutable SQLite runtime code and memory session/job authorities were removed.
- **Provider boundaries:** [package observations](../../../backend/src/services/packageObservation.ts), [bounded JSON](../../../backend/src/services/providerJson.ts), existing Graph/directory adapters. 512 KiB request JSON; 2 MB provider responses; ten-second network timeout; package 100-page/5,000-row bound; read-only retries max three with 30-second delay ceiling; bounded directory search/resolve. Unknown package fields produce value-free omission diagnostics. No new integrations, persisted snapshots, raw payload tables or recurring refresh.
- **Serving/maintenance:** [app](../../../backend/src/app.ts), [server](../../../backend/src/server.ts), [maintenance](../../../backend/src/services/maintenance.ts). One Express-served React origin; liveness, schema readiness and authenticated diagnostics separated. API/auth precedence, safe static paths, missing assets/API errors, immutable hashed assets/no-store SPA fallback. Maintenance closes admissions and unsent dispatch, with graceful worker drain.
- **Recovery:** [native backup/restore](../../../backend/scripts/backup.ts), [legacy importer](../../../backend/scripts/import-legacy-audit.ts). Snapshot-consistent PostgreSQL dumps, private files, SHA-256 plus schema/count/content receipts, new isolated restore targets only. Standalone bounded SQLite-safe operator reader, deterministic source IDs, transactional receipt, exact content/count verification, idempotent retry, no startup import. Known bounded legacy Graph error metadata is preserved; unknown fields fail transactionally rather than being silently lost. Unknown tenant attribution stays restricted. Legacy in-memory jobs/sessions are not recoverable and must not replay.
- **Local deployment:** [Dockerfile](../../../Dockerfile), [Compose](../../../compose.yaml), [entry point](../../../deploy-local.ps1), [helper](../../../scripts/local-deployment.ps1), [runbook](../../../README.md). Exactly `app` + `postgres`, retained project volume/bridge, only loopback app port published, outbound HTTPS/DNS intact. Runtime has no admin secret, operator/test code or Docker socket. Restricted ignored file secrets generated once; missing/corrupt existing secrets stop for recovery; exact reset confirmation; repeat deployment preserves origin/data/credentials. Daily operator retention: expired sessions, seven-day jobs/dependents, 90-day audit/receipts, orphan identifiers and seven-day local dump pairs.
- **Packaging/feed:** Docker builds/tests only, automatic approved Microsoft npm feed, optional secret-mounted npmrc, no security-control bypass. Runtime/export exclude app/dependency tests, local credentials and SQLite imports/data. Linux/amd64 ZIP uses the same release tree and executes on Linux x64 Node 24.20.0; no Azure deployment was attempted.
- **Frontend/report continuity:** [App](../../../frontend/src/App.tsx) follows durable states, preserves paused-job references, exposes explicit reauthentication/resume/cancel, and clearly disables unconfigured sign-in. Narrow mobile overflow repaired within existing styling. Browser report authority remains `agent-control:usage-reports:v1`; old `http://localhost:5173` storage is retained, never read/deleted cross-origin. The runbook documents explicit re-import and later optional old-origin cleanup. Phase 06 owns report migration.

## Changed files

- Root: [README.md](../../../README.md), [.gitignore](../../../.gitignore), [.dockerignore](../../../.dockerignore), [Dockerfile](../../../Dockerfile), [compose.yaml](../../../compose.yaml), [deploy-local.ps1](../../../deploy-local.ps1), [package-lock.json](../../../package-lock.json).
- Backend configuration/contracts: [package.json](../../../backend/package.json), [tsconfig.json](../../../backend/tsconfig.json), [vitest.config.ts](../../../backend/vitest.config.ts); `src/config.ts`, `errors.ts`, `app.ts`, `app.test.ts`, `server.ts`, `middleware/auth.ts`, `routes/agents.ts`, `routes/audit.ts`, `routes/auth.ts`, `types/audit.ts`, `types/session.ts`.
- Backend persistence/services: `src/db/{pool,schema,jobs,sessions}.ts`, jobs/session tests; audit and bulk services/tests; Graph/directory adapters; maintenance, package observation and bounded provider JSON modules/tests. All paths are under [backend/src](../../../backend/src).
- Operator/test tools under [backend/scripts](../../../backend/scripts): database migration/retention and tests, `testDatabase.ts`, `test-all.ts`, legacy importer/tests, backup/tests, `package.mjs`, `package-smoke.ts`, `zip-runtime-smoke.mjs`, `restart-fixture.ts`, `restart-runtime.mjs`.
- Frontend under [frontend/src](../../../frontend/src): `App.tsx`, `App.css`, `api/client.ts`, `components/BulkActions.tsx`, `jobStatus.ts` and its tests. Report parser/models and browser report storage authority unchanged.
- Local scripts under [scripts](../../../scripts): `local-deployment.ps1`, `local-deployment.tests.ps1`, `restart-runtime.tests.ps1`, `persistence.tests.ps1`, `browser-smoke.mjs`. This completion record.
- Checked but unchanged: [deploy-production.ps1](../../../deploy-production.ps1), [infra/main.bicep](../../../infra/main.bicep), [infra/main.bicepparam](../../../infra/main.bicepparam). These remain legacy context and must not deploy this PostgreSQL revision; Phase 12 owns replacement.

## Validation evidence

Host: Docker 29.7.2, Compose v5.4.0, PowerShell 7.6.4. All application/database/build/browser tools ran inside Docker. Final worktree, not a committed revision. Baseline ran on isolated generated `agentcontrol_test_*` databases; no rollback-only isolation against app data and no live provider requests.

| Check / exact command | Environment / revision | Status | Observed result |
| --- | --- | --- | --- |
| `pwsh -NoProfile -File ./deploy-local.ps1 -Project agent-control-phase01` | Fresh local volume at 13:08 UTC, subsequent current-code reruns; final baseline 14:35 UTC | passed | Fresh bootstrap, explicit migrations, bounded readiness and full baseline. Final 81 backend tests in 14 files; 33 frontend tests in five files; backend typecheck, frontend lint and both builds passed. Healthy canonical `http://localhost:3001`, sign-in unconfigured. |
| `docker build --target operator -t agent-control-phase01-operator:local .` plus `-Action Test`/Deploy operator baseline | Node 24/PostgreSQL 17, generated guarded databases | passed | Migrations fresh/upgrade/failure rollback/retry/concurrent serialization/newer-modified rejection, runtime DDL/audit/escalation denials; session expiry/regeneration/scope; source identity, leases/deadlines/claim budgets, append-only audit, maintenance, idempotency/authorization/cancellation/no replay. |
| `pwsh -NoProfile -File ./scripts/local-deployment.tests.ps1` and PowerShell AST parse of entry point/helper/three test scripts | Host PowerShell; Docker commands mocked for failure cases | passed | 19 assertions: unavailable engine/Compose, occupied port, spaces, build/migration/startup failures, stable secrets/no secret arguments, missing/corrupt secrets, exact-reset denial and finite backup retention; all five scripts parsed. |
| `pwsh -NoProfile -File ./scripts/restart-runtime.tests.ps1` | Actual compiled app image, same Compose bridge/volume, isolated test DB, test-only injected provider | passed | Runtime intentionally exited 17 immediately after second dispatch; recreated app saw partial/authorization wait. Zero automatic writes, completed replays or uncertain replays. Exactly two unsent fixture writes ran after explicit current authorization; one job succeeded, uncertain aggregate remained partial. Containers/control and fixture DBs removed. |
| `pwsh -NoProfile -File ./scripts/persistence.tests.ps1` | Retained project plus guarded nonempty fixture DB, native operator backup/restore | passed | Stop/start restarted PostgreSQL and app; repeated full Deploy preserved exact fixture/application table fingerprints, secret bytes and parsed tenant/client/port settings. Supported Backup/Restore verified a new isolated target. Both generated dumps/receipts and all isolated databases removed. |
| `docker run --rm --network agent-control-phase01-test -e PGHOST=agent-control-phase01-postgres -e PGUSER=agentcontrol_admin -e PGPASSWORD=isolated-fixture-admin-password-01 -e PGDATABASE=agentcontrol_test_migrations --entrypoint npm agent-control-phase01-operator:local run test --workspace backend -- scripts/import-legacy-audit.test.ts` | Synthetic-only disposable PostgreSQL; temporary SQLite-safe backups | passed | Four importer tests: current/older variants, unknown tenant, retry/changed checksum/source, malformed/interrupted rollback, known failure metadata, ordinal multi-row count/hash and raw-field denial. This fixture-only password is not an installation credential. |
| `docker build --target browser-test -t agent-control-phase01-browser .`; `docker run --rm --network agent-control-phase01_default --mount "type=bind,source=$PWD/artifacts,target=/evidence" agent-control-phase01-browser` | Pinned Microsoft Playwright image, `http://app:3001`, 1440x1000 and 360x780 | passed | Built UI loaded with no page errors or horizontal overflow; disabled sign-in and exact callback guidance verified. Screenshots [desktop](../../../artifacts/signin-1440.png) and [mobile](../../../artifacts/signin-360.png) inspected. They contain no tenant data or credentials. |
| `docker build --platform linux/amd64 --target export --output type=local,dest=artifacts .` | Linux x64 Node 24 build, same release tree | passed | [agent-control-linux-x64.zip](../../../artifacts/agent-control-linux-x64.zip), approximately 17.65 MB, current code. Architecture guard executed. No native `.node` modules needing separate ABI proof. |
| `docker run --rm --network agent-control-phase01_default --mount "type=bind,source=$PWD/artifacts,target=/evidence,readonly" agent-control-phase01-operator:local backend/scripts/package-smoke.ts http://app:3001 /evidence/agent-control-linux-x64.zip` | Final runtime + ZIP | passed | Health/readiness, deep links, asset/cache behavior, API404/missing assets/auth callback/traversal/diagnostic protection and ZIP exclusion checks. |
| Linux x64 extracted-ZIP command below | Final package image; restricted runtime DB/session mounts only | passed | ZIP extracted independently, Node 24.20.0 Linux/x64 started one server, accessed schema/assets/routes, and shut down cleanly. Runtime secret-byte scan passed. Separate final `/app` runtime scan found no tests, SQLite imports or operator scripts; npmrc/registry settings absent. |
| `docker run --rm --entrypoint npm agent-control-phase01-operator:local audit --audit-level=low` | Approved Microsoft feed, final lockfile | passed | Zero vulnerabilities after compatible `npm audit fix --package-lock-only --ignore-scripts` inside stock Node container with explicit approved registry. |
| `pwsh ./deploy-local.ps1 -Project agent-control-phase01 -Action Retain`; Compose `ps`, mount inspection, database inventory; `git diff --check` | Final retained local project | passed | Exactly two healthy project services; runtime mounts only control/client-secret/session/app-password, no admin credential or DB host port. Only `agentcontrol` and `postgres` non-template DBs remain. Owned standalone test container/network/volume removed; unrelated containers untouched. Whitespace and touched-source diagnostics clear. |
| Real Entra sign-in/provider calls and Azure runtime/control plane | No approved live fixture credentials supplied; prohibited cloud changes | unavailable | No fabricated sign-in/provider evidence; local configured-tenant policy tested with HTTP fixtures only. Azure deployment/import is intentionally not phase 01 work. |

Exact current-code migration/bootstrap invocation (normal Deploy supplies this automatically):

```bash
docker run --rm --network agent-control-phase01_default \
  --mount "type=bind,source=$PWD/.local/agent-control-phase01/secrets,target=/run/secrets,readonly" \
  -e PGHOST=postgres -e PGUSER=agentcontrol_admin -e PGDATABASE=agentcontrol \
  -e PGPASSWORD_FILE=/run/secrets/postgres-admin -e APP_PGPASSWORD_FILE=/run/secrets/postgres-app \
  agent-control-phase01-operator:local backend/scripts/database.ts migrate
```

Replace the final command with `backend/scripts/test-all.ts` for the exact Docker baseline: backend/frontend tests, backend typecheck, frontend lint and root build. It creates/deletes separately named fixture databases. Replace it with `backend/scripts/database.ts retain` for database retention. The root Retain action also removes expired local backup pairs. Do not use runtime credentials for operator commands.

Exact extracted-ZIP execution:

```bash
docker build --platform linux/amd64 --target package -t agent-control-phase01-package .
docker run --rm --platform linux/amd64 --network agent-control-phase01_default \
  --mount "type=bind,source=$PWD/.local/agent-control-phase01/secrets/postgres-app,target=/run/secrets/postgres-app,readonly" \
  --mount "type=bind,source=$PWD/.local/agent-control-phase01/secrets/session,target=/run/secrets/session,readonly" \
  -e PGHOST=postgres -e PGUSER=agentcontrol_app -e PGDATABASE=agentcontrol \
  -e PGPASSWORD_FILE=/run/secrets/postgres-app -e SESSION_SECRET_FILE=/run/secrets/session \
  --entrypoint node agent-control-phase01-package backend/scripts/zip-runtime-smoke.mjs
```

Local setup/state: `.local/agent-control-phase01`, named volume `agent-control-phase01_data`, bridge `agent-control-phase01_default`, browser origin `http://localhost:3001`, browser-test bridge origin `http://app:3001`. Secret files and artifacts are ignored. The [root runbook](../../../README.md) defines exact setup, Stop/Start/Test/Backup/Restore/Retain/reset commands and Phase 03 browser-harness reuse. Temporary containers use `--rm`; cleanup removed `agent-control-phase01-postgres` plus `agent-control-phase01-test` and its anonymous fixture volume, not retained Compose storage. Successful restore targets and synthetic receipts/dumps were removed. No cleanup incident remains.

### Repair And Rerun Evidence

- Public npm connection resets: resolved by the managed host's already-approved Microsoft feed; Docker now selects it automatically. No TLS/Defender bypass or unapproved mirror. Earlier eight advisories resolved through compatible lockfile updates; final audit zero. `P01-DEPENDENCY-AUDIT` is closed.
- During cutover, frontend compilation exposed an obsolete optimistic helper and the legacy fixture exposed an 18/19-column mismatch. Both repaired; current aggregate passes. Router-wide authentication was narrowed so unknown API routes correctly return JSON404; HTTP tests pass.
- Restart harness initially lacked its disposable control DB and encountered a stale receipt from a different isolated cluster. Harness now owns a uniquely named control DB and separate receipt; actual crash/recreate reruns pass and cleanup is verified.
- Browser smoke initially failed with 4px mobile overflow. Sign-in max-width/URL wrapping repaired; both viewport assertions and screenshots pass.
- ZIP exclusion initially found four `pg-protocol` test files outside test directories. Production dependency pruning now removes test/spec files; final image/ZIP checks and executed ZIP pass.
- Persistence proof initially compared serialized JSON property order. Structural value comparison repaired the check; actual data/secret/origin/redeploy/restore proof passed. No data loss was observed.
- Additional safety checks repaired dispatch deadline/claim-budget enforcement and result-commit recovery; all repository and real-image restart tests pass. `P01-INCOMPLETE` is closed.

## Open issues

| ID / originating phase | Affected scope / evidence status | Containment | Signal / threshold | Responsible operator or role | Exact fix-forward trigger / next action |
| --- | --- | --- | --- | --- | --- |
| P01-LIVE-IDENTITY | Real Entra/provider behavior unavailable in this local fixture deployment | Sign-in visibly unconfigured, no fake credentials or remote writes; access UI retains its preexisting hidden state | Any attempt to claim provider readiness or perform a live mutation before approved setup/qualification | Tenant administrator; Phase 02 auth owner; Phase 05 control owner | Supply existing approved tenant/client configuration through restricted files, register the exact callback, then perform the owning phase's approved sign-in/read/write checks. No automatic grant expansion. |
| P01-BUNDLE-SIZE | Build warning: main JS 733.79 kB minified, 213.65 kB gzip | Functional desktop/mobile smoke passed; no claim of slow-network performance qualification | Main chunk remains above Vite's 500 kB warning or measured interactive loading misses the later UI performance target | Phase 10 workbench/UI owner | Measure packaged loading during integrated UI qualification and split heavy reporting/export dependencies if needed; do not suppress the warning without evidence. |

Host editor may report missing `vite/client` because host dependencies are intentionally absent. Docker TypeScript/build checks passed; attach tooling to a container rather than installing a host app toolchain. Production grants/Key Vault, managed database behavior, release checksums and cloud import remain explicitly owned by their later phases, not missing Phase 01 implementation.

## Next session

- Implement only [02-auth-capability-registry.md](../02-auth-capability-registry.md) in a **fresh session**. No Phase 02 code was started here.
- Read the binding plan README and this record; verify delivered migrations 1/2, role/bootstrap commands, `DataScope`, durable job/lease contract, PostgreSQL session store, native MSAL in-memory cache, one origin and local secret-file contract. Add capability/configuration schema through a new additive migration, never edit applied SQL or persist tokens.
- Reuse the existing Docker stages, local entry point and disposable databases. Extend rather than replace current single-origin packaging. Keep browser-local reports untouched until Phase 06 and uncertain writes unreplayed until Phase 05 reconciliation. Do not invoke legacy Azure deployment assets with this revision.

```text
Implement only plans/admin-poc-production/02-auth-capability-registry.md.
Read plans/admin-poc-production/README.md and the Phase 01 completion record.
Verify the relevant delivered artifacts in the current worktree. Implement,
validate in Docker, and write only Phase 02's completion record. Preserve
unrelated changes and retained PostgreSQL data/secrets. Do not commit, push,
deploy to Azure, change provider grants without explicit approval, execute
future ideas, or proceed to Phase 03. Stop at Phase 02.
```