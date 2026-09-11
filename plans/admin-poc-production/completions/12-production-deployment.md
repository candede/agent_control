---
phase: 12
phase_name: Production deployment
phase_status: in_progress
outcome: deployment_pending
recorded_at: 2026-09-10T17:52:21Z
last_verified_at: 2026-09-10T17:52:21Z
execution_scope: local_only
schema_version: 26
release_revision: 0b7797dc4fe4-dirty-phase12-observability
release_sha256: 0c6416bd7fc6ac8b3050a6acbee0cdedb5f14ba70bbd1dfe222d0339ed8499a3
---

# Phase 12 completion record

## Status and execution boundary

The locally executable Phase 12 implementation and repair are complete. Phase
12 remains `in_progress`/`deployment_pending`: this session performed no Azure
authentication, account/subscription discovery, resource or pricing query,
credential inspection, remote what-if, provider request, deployment, telemetry
read, live smoke, native PITR, recovery, retirement, or alert delivery. Every
remote command was intercepted by an exact local command fixture. Phase 13 was
not started.

The original `agent-control-phase01` Compose project, volume, network, and
secret files were retained. Its only persistent services are healthy `app` and
`postgres`; only the app is published, at `127.0.0.1:3001`. The database remains
`agentcontrol` with exactly migrations 1-26 applied. No deployment schema or
migration 27 was added.

## Exact requirement disposition

`local_implemented` means the controlling code and local tests exist.
`command_mocked` means `Invoke-RealAzureOperation` ran while every external
command was matched at the command boundary; it is not cloud proof.

| # | Original Phase 12 requirement | Local/mock status | Live status |
|---:|---|---|---|
| 1 | Interactive wizard and equivalent named parameters, exact target/tool/operator preview and approvals | `local_implemented`, `command_mocked`: the root entry point accepts a target file or a complete named parameter set. A child-process test supplies `ApprovedMonthlyBudget` and every other named input and reaches Plan without `Read-Host`. Exact target digest and approvals bind every later action. | `cloud_not_run`: operator identity and approval must be proved in the approved tenant/subscription. |
| 2 | Managed B1 App Service and Burstable B1ms PostgreSQL 17 topology, current itemized estimate, budget and regional support | `local_implemented`, `command_mocked`: Bicep builds for one Linux B1 plan/app and one PostgreSQL 17 `Standard_B1ms`, 32 GiB, seven-day/no-HA/no-replica server. The pinned CLI capability parser requires `supportedServerEditions[].supportedServerSkus[]`, exact Burstable tier/SKU/version, Linux B1, Node 24, quota, dated estimate and budget. Top-level-SKU, tier, SKU and version omissions fail closed. | `cloud_not_run`: current price, quota and regional capability evidence remain required. |
| 3 | TLS, bounded pool and exact App Service/runner firewall/network handling | `local_implemented`, `command_mocked`: TLS 1.2/`verify-full`, pool maximum four, exact approved egress, a run-named exact-IP runner rule and exact receipt-bound deletion are enforced. Changed egress and broad access fail. | `cloud_not_run`: actual DNS/TLS/network reachability and egress remain required. |
| 4 | Existing six-secret vault, separate ARM/operator/runtime access, native references, restricted bootstrap and no automatic rotation | `local_implemented`, `command_mocked`: all six selected values/versions are validated and five runtime references exclude admin. Parameter-file creation no longer marks bootstrap secrets materialized; the two mode-0600 files are created and verified immediately before the DB container and deleted in `finally`. Any selected/current version difference is rejected with the Phase 11 separately approved coordinated-rotation prerequisite. The wizard has no rotation parameter or operation. Phase 11's standalone rotation code is unchanged. | `cloud_not_run`: real vault values, network, deploy permission and grants remain required. |
| 5 | Four Entra app roles, retained provider grants, exact callback and Administrator assignment without directory writes | `local_implemented`, `command_mocked`: the manifest, callback, service principal and Administrator assignment are read/verified; the wizard reports a preview only and performs zero directory writes. | `cloud_not_run`: tenant administrator verification/consent remains required. |
| 6 | Direct single-origin App Service cutover and removal of active Static Web Apps transport | `local_implemented`, `command_mocked`: the new topology is one origin and one Express/MSAL authority; the obsolete runtime config/entry point remain removed. Optional legacy retirement requires exact approved ID, type, ownership and successful replacement opening. | `cloud_not_run`: no existing cloud resource was inspected or retired. |
| 7 | `deploy-azure.ps1` cutover and exact prebuilt Linux/x64 Node 24 artifact release | `local_implemented`, `command_mocked`: there are exactly two root deployment entry points, `deploy-local.ps1` and `deploy-azure.ps1`; no old-name wrapper exists. Bicep build/what-if, ZIP inspection and deployment use the tested package with remote build disabled. | `cloud_not_run`: no remote what-if or ZIP deployment ran. |
| 8 | Bind fresh/upgrade/import to exact retained resource/database identity with no empty fallback | `local_implemented`, `command_mocked`, `real_local_postgresql`: a normal fresh run rejects existing resources. A resume imports only an exact receipt, reuses its run ID, verifies all three exact wizard tags/types/IDs and proves the DB is either still empty or exactly schema 26. Child-process failures before bootstrap and after bootstrap resume missing steps while completed resource deployment/migration/package writes are not replayed. Ambiguous external-write failures require reconciliation. | `cloud_not_run`: actual existing-resource and managed DB state remain required. |
| 9 | Maintenance, finite drain, old-app stop and no uncertain-write replay | `local_implemented`, `command_mocked`, `real_local_postgresql`: existing Deploy and Recover close admission, stop/drain and back up before changes. Resume skips completed external writes. Restart proof observed zero completed/uncertain/canary replays. | `cloud_not_run`: the approved production maintenance window remains required. |
| 10 | SQLite-safe WAL-inclusive legacy-audit-only import with transactional retry/count proof | `local_implemented`, `real_local_postgresql`: the existing isolated importer tests remained in the passing backend aggregate; sessions/jobs are not imported and SQLite is not a runtime fallback. | `cloud_not_run`: an approved production legacy backup was not supplied or imported. |
| 11 | Existing-target backup, locked migration, exact release, vault/runtime separation and smoke before opening | `local_implemented`, `command_mocked`, `real_local_postgresql`: an existing target is contained before resource deployment. Bicep sets `MAINTENANCE_MODE=true`; every resource deployment immediately reapplies it and stops the site. Fresh initialization creates and verifies its first run-named backup after migration. Release order is contained start, health/static/deep-link/unauthenticated/auth-configuration checks, exact-run authentication receipt, DB reopen with provider work disabled, then public readiness/auth checks. Liveness is not login proof. Invalid resource-deploy/post-open checks reapply maintenance, stop the app and record containment. | `cloud_not_run`: no real backup, MSAL login/callback/session or hosted smoke is claimed. |
| 12 | Schema-compatible artifact recovery and forward/approved-restore runbook | `local_implemented`, `real_local_postgresql`: `infra/disaster-recovery.md` now keeps restored data in maintenance through switch/contained smoke/auth receipt and reopens only before the bounded public check. No old writer or restored-job replay is allowed. | `cloud_not_run`: no production recovery or RPO decision occurred. |
| 13 | Native PITR to one isolated server, current-scope review and safe serving recovery | `local_implemented`, `command_mocked`, `real_local_postgresql`: isolation is exact `(server, database)`, so PITR may retain database name `agentcontrol` on a distinct server; the exact same server/database is denied. The real PostgreSQL test still restores to a distinct local DB, checks content/schema/current deletion-access reconciliation and leaves provider work disabled. Recover retains the source server and contains a failed restored target. | `cloud_not_run`: native Azure PITR was not attempted. |
| 14 | Managed monitoring, bounded retention/ingestion, alerts and budget delivery | `local_implemented`, `command_mocked`, `runtime_event_tested`: only redacted `AppServiceConsoleLogs` use the Dedicated table; PostgreSQL exports metrics and no raw logs. Exact `parse_json(ResultDescription).event` queries match real producers for restart/provider/deadline/uncertain-write/pool/session/cleanup events. Metrics cover readiness health, 5xx, two-second latency, storage and CPU credits. `backup_storage_used` is labeled cost-only; exact run/server/completion backup health is a bounded control-plane probe. Diagnostic and alert definitions/thresholds fail closed. Retention remains 30 days/0.1 GiB per day. | `cloud_not_run`: telemetry, probes, managed capacity, budget behavior and alert delivery remain unverified. |
| 15 | Actual deployment and immediate observation of exact revision/schema/health | Local orchestration, receipts, containment and fix-forward are implemented and command-mocked. No local fixture is labeled a production observation. | `cloud_not_run`: this requirement is the principal reason Phase 12 remains open. |
| 16 | Phase 13 boundary check, post-smoke legacy retirement and exact cleanup | `local_implemented`, `command_mocked`: optional qualification identity/expiry/persona/native-target validation remains read-only. Cleanup now requires a failed/contained exact receipt, validates target/approval/allowlisted ownership, rehydrates the original run across processes, removes records only after successful deletion, and cannot report success with unresolved ownership. | `cloud_not_run`: Phase 13 targets, SWA retirement and temporary cloud cleanup were not run. |

## Delivered repair contracts

- `scripts/azure-deployment.ps1` now has a version-2 command fixture boundary.
  Mock mode always executes `Invoke-RealAzureOperation`; exact executable and
  ordered arguments must match, all expected non-optional commands must be
  consumed, and extra/unregistered commands fail without external fallthrough.
- The PostgreSQL SKU preflight consumes the pinned Azure CLI capability shape
  and fails closed unless one exact edition/SKU/version tuple exists.
- `BootstrapDirectory`, `BootstrapSecretsMaterialized`, and
  `ParameterDirectory` are independent states. Parameter generation cannot
  suppress secret-file creation.
- Receipt version 2 binds action, run ID, approval digest, exact target,
  completed/attempted steps and remaining ownership. `-ResumeReceiptPath` is
  mandatory for Cleanup. Atomic receipt replacement preserves the previous
  receipt unless validation and serialization succeed.
- Fresh resumes use the original run ID and Bicep `wizardRunId` tag. The
  database resume check discriminates empty pre-bootstrap from schema-26
  post-bootstrap state. Completed remote writes are skipped; uncertain remote
  failures are not replayed.
- App Service native configuration-reference status is queried with at most
  five attempts. All and only `TENANT_ID`, `CLIENT_ID`, `CLIENT_SECRET`,
  `SESSION_SECRET`, and `PGPASSWORD` must be `Resolved` with the exact approved
  vault/name/version. Denied, network-failed, delayed, mismatched-client-secret
  and inherited-admin-access fixtures cover this boundary.
- Deploy and Recover no longer reopen the database before the contained smoke.
  Real login proof is a separate human approval artifact bound to the exact
  run/target/origin/callback/release, not a health response.
- Bicep enables only the redacted App Service console diagnostic category in
  the Dedicated table and aggregate metrics. PostgreSQL diagnostic logs are
  empty. Structured queries parse the JSON event field; a platform health-check
  metric detects silent readiness failure.
- Run-named release backups have a separate bounded, exact-source
  control-plane verification step. Delayed, missing, wrong-source or
  non-completed restore points fail closed. Backup storage remains a cost
  signal only.
- Runtime uncertain-write and finite-deadline events are emitted at the durable
  transition, and a 30-second pool observer reports any waiter. Tests bind
  every configured structured-alert event to a production producer.
- Resource deployment carries `MAINTENANCE_MODE=true`, reapplies it, and stops
  the site before any bootstrap/opening work. Failure after the resource write
  invokes explicit application/database containment. Resume verifies the
  maintenance setting and stopped state before continuing; failed resume
  replays idempotent containment rather than trusting an old receipt result.
- Restore cache reconciliation now compares exact host and database identities.
  Same database names are valid on different servers; the same target is not.

## Changed files

- `deploy-azure.ps1` — complete named-parameter detection; receipt/auth-smoke
  parameters; removed credential-rotation input.
- `scripts/azure-deployment.ps1` — command fixture boundary, actual SKU/native
  reference logic, bootstrap state, receipt-bound resume/cleanup, safe fresh
  continuation, resource-write containment, exact backup-health probe,
  diagnostic/alert verification, contained opening/recovery and truthful
  containment.
- `scripts/azure-deployment.tests.ps1` — command-level fixtures and regression
  matrix, including three child-process resume/cleanup boundaries, diagnostic
  rejection, backup probe retries and resource-deploy containment.
- `backend/scripts/backup.ts`, `backend/scripts/azure-pitr.ts`,
  `backend/scripts/backup.test.ts` — exact server/database restore isolation and
  real isolated PostgreSQL coverage.
- `infra/main.bicep` — maintenance-by-default App Service, least-data
  diagnostics, Dedicated console table, readiness alert and exact JSON-event
  queries.
- `backend/src/services/telemetry.ts`, `backend/src/server.ts`,
  `backend/src/errors.ts`, `backend/src/services/bulkJobs.ts`,
  `backend/src/services/copilotStudioQuarantineJobs.ts` and their tests —
  pool, throttling, finite-deadline and uncertain-write observations aligned to
  the Bicep filters.
- `infra/production-target.example.json` — removed wizard rotation approval.
- `docs/azure-production-deployment.md`, `docs/operations.md`,
  `docs/security-model.md`, `infra/disaster-recovery.md`, `README.md` —
  no-rotation prerequisite, least-data monitoring, exact backup probe, exact
  resume, contained auth proof and recovery order.
- This completion record — exact original requirement mapping and repaired
  evidence. No frontend API or database schema changed.

`docs/deployment-setup.md` was checked and already states the six-name contract,
no wizard secret writes/rotation, and the Phase 11 coordinated-rotation
boundary, so this repair did not change it.

## Validation evidence

All Node/npm/application/database/scanner/browser/load/release metadata work ran
inside Docker using the Microsoft npm feed configured by the images. Host
PowerShell only orchestrated checked-in scripts. Lifecycle checks ran
sequentially.

| Exact command | Status | Observed result |
|---|---|---|
| `pwsh -NoProfile -File ./scripts/azure-deployment.tests.ps1` before repair | superseded non-evidence | The old suite reported 104 assertions while bypassing every real operation body; this was the masking defect, not acceptance evidence. |
| `pwsh -NoProfile -File ./scripts/azure-deployment.tests.ps1` | passed | 88 command-level assertions; real operation bodies ran. In addition to the prior matrix, exact diagnostics, finite metric/log alert thresholds, delayed/missing/wrong-source/failed backup probes, fresh post-migration backup, post-resource-write containment and uncontained cross-process resume rejection/recontainment passed. |
| Disposable `mcr.microsoft.com/azure-cli:2.77.0 az bicep build --file infra/main.bicep --stdout` without a writable compiler cache | failed, repaired | The local compiler download ended with `IncompleteRead`; no ARM/provider request ran. The isolated project-cache command below completed, and the cache was removed. |
| `mkdir -p artifacts/bicep-cli && docker run --rm --platform linux/amd64 -v "$PWD:/workspace:ro" -v "$PWD/artifacts/bicep-cli:/root/.azure" -w /workspace mcr.microsoft.com/azure-cli:2.77.0 az bicep build --file infra/main.bicep --stdout >/dev/null; status=$?; rm -rf artifacts/bicep-cli; exit $status` | passed | Exit 0 with no Bicep diagnostic; this compiled locally and performed no Azure what-if. |
| Focused Docker Vitest over `telemetry.test.ts`, `bulkJobs.test.ts` and `copilotStudioQuarantineJobs.test.ts` on guarded `agentcontrol_test_phase12observability` | failed, repaired, passed | Initial test placement and aggregate working-directory assumptions were repaired. Final run passed 3 files/34 tests against isolated real PostgreSQL; the guarded database was dropped. |
| `pwsh -NoProfile -File ./deploy-local.ps1 -Action Test -Project agent-control-phase01 -StateRoot ./.local -Port 3001` | failed, repaired, passed | The first post-change aggregate exposed the telemetry test's `/app/backend` working directory assumption. Final run passed backend 54 files/528 tests and frontend 24 files/175 tests; backend typecheck, frontend lint and combined build passed. |
| `pwsh -NoProfile -File ./deploy-local.ps1 -Project agent-control-phase01 -StateRoot ./.local -Port 3001` | passed | Reran the retained deployment without reset/rotation; exactly two services became healthy at `http://localhost:3001`. |
| `pwsh -NoProfile -File ./scripts/restart-runtime.tests.ps1 -Project agent-control-phase01` | passed | Crash/recovery proof completed with zero completed, uncertain, package-canary or quarantine-sent replay. |
| `pwsh -NoProfile -File ./scripts/persistence.tests.ps1 -Project agent-control-phase01 -Port 3001` | passed | Data, credential/origin preservation, redeploy, two-service health and isolated native restore passed; aggregate tests also reran inside this lifecycle. |
| `pwsh -NoProfile -File ./scripts/permission-browser.tests.ps1 -Project agent-control-phase01` | passed | 46 built Chromium cases passed, including axe, keyboard, reflow and privacy/export boundaries. |
| `docker run ... agent-control-phase01-operator:local backend/scripts/cache-load.ts` with guarded `agentcontrol_test_phase12observability_load`, the retained network and read-only secret mount | passed | 120 requests; p95 267.15 ms; 1,000 CSV rows; pool 4; five queued and sixth rejected; exact test DB dropped. |
| `docker build --platform linux/amd64 --target security-scan -t agent-control-security-scan:phase12-observability . && docker run --rm --platform linux/amd64 agent-control-security-scan:phase12-observability` | passed | 234 files, 3,363,044 bytes, 332 dependency licenses and 73 runtime files. |
| `docker run --rm --platform linux/amd64 -e NPM_CONFIG_REGISTRY=https://packagefeedproxy.microsoft.io/npm/ --entrypoint npm agent-control-phase01-operator:local audit --omit=dev --audit-level=high` | failed, repaired | The retained native operator image could not satisfy a forced `linux/amd64` run and Docker attempted a registry pull. No audit ran. The corrected native-container command below ran successfully. |
| `docker run --rm -e NPM_CONFIG_REGISTRY=https://packagefeedproxy.microsoft.io/npm/ --entrypoint npm agent-control-phase01-operator:local audit --omit=dev --audit-level=high` | passed | Zero vulnerabilities. |
| `docker build --platform linux/amd64 --target export --build-arg RELEASE_REVISION=0b7797dc4fe4-dirty-phase12-observability --output type=local,dest=artifacts/release .` followed by package and extracted-runtime smoke | passed | Rebuilt after runtime telemetry changes; running image/ZIP parity and extracted Linux/x64 Node 24.20.0 startup/secret exclusion passed. |
| `docker run --rm --network agent-control-phase01_default --mount "type=bind,source=$PWD/artifacts/release,target=/evidence,readonly" agent-control-phase01-operator:local backend/scripts/package-smoke.ts http://app:3001 /evidence/agent-control-linux-x64.zip` | passed | Packaged app and ZIP smoke passed. |
| `docker run --rm --mount "type=bind,source=$PWD/artifacts/release,target=/evidence,readonly" agent-control-phase01-operator:local backend/scripts/release-inspect.mjs /evidence/agent-control-linux-x64.zip` | passed | Revision `0b7797dc4fe4-dirty-phase12-observability`, 18,992,486 bytes, Linux/x64, Node 24, 12,296 archive files, checksum below. |
| `docker build --platform linux/amd64 --target runtime-inspection -t agent-control-runtime-inspection:phase12-observability . && docker run --rm --platform linux/amd64 agent-control-runtime-inspection:phase12-observability` | passed | 12,294 runtime files, 77,563,034 bytes, no nonempty mounted secrets. |
| Read-only Node 24 container over `.local/agent-control-phase01/backups` validating exact inventory, six required names, dump/receipt checksums and modes | passed | Exactly six protected dump/receipt pairs remain, receipt checksums match, both files remain mode 0600, and no extra backup file remains. |
| `docker exec agent-control-phase01-postgres-1 psql ... "SELECT ... FROM schema_migrations; SELECT ... FROM pg_database ..."` | passed | 26 applied migrations; zero `agentcontrol_test_*`/`agentcontrol_restore_*` databases remained. |
| Exact `docker ps`/`docker port` commands in the block below | passed | Exactly healthy `app` and `postgres`; only `3001/tcp -> 127.0.0.1:3001`; PostgreSQL has no published port. |
| Exact read-only Node directory check in the block below | failed, repaired, passed | The first check found 17 test-owned bootstrap directories from direct-operation negative cases. The test harness now registers every context for `finally` cleanup; the exact owned directories were removed and a full suite rerun left zero bootstrap/parameter/test-scratch entries. |
| `git diff --check` plus `git diff --no-index --check /dev/null <each scoped untracked file>` | passed | No whitespace errors in the scoped repair. |

The table's abbreviated cache/backup/final-state rows refer to these exact
commands (the fixed cache database was guarded, created and dropped inside
PostgreSQL containers):

```bash
db=agentcontrol_test_phase12observability_load
docker exec agent-control-phase01-postgres-1 psql -U agentcontrol_admin -d agentcontrol -v ON_ERROR_STOP=1 \
  -c "DROP DATABASE IF EXISTS \"$db\" WITH (FORCE)"
docker exec agent-control-phase01-postgres-1 psql -U agentcontrol_admin -d agentcontrol -v ON_ERROR_STOP=1 \
  -c "CREATE DATABASE \"$db\""
docker run --rm --network agent-control-phase01_default \
  --mount "type=bind,source=$PWD/.local/agent-control-phase01/secrets,target=/run/secrets,readonly" \
  -e PGHOST=postgres -e PGUSER=agentcontrol_admin -e PGDATABASE="$db" \
  -e PGPASSWORD_FILE=/run/secrets/postgres-admin -e APP_PGPASSWORD_FILE=/run/secrets/postgres-app \
  agent-control-phase01-operator:local backend/scripts/cache-load.ts
docker exec agent-control-phase01-postgres-1 psql -U agentcontrol_admin -d agentcontrol -v ON_ERROR_STOP=1 \
  -c "DROP DATABASE IF EXISTS \"$db\" WITH (FORCE)"

docker run --rm \
  --mount "type=bind,source=$PWD/.local/agent-control-phase01/backups,target=/backups,readonly" \
  --entrypoint node node:24-bookworm-slim -e \
  'const fs=require("fs"),c=require("crypto"); const names=["phase09-verified-20260909T220129Z.dump","20260910T060940442Z.dump","phase10-verified-20260910T095823Z.dump","phase10-verified-schema25-20260910T110000Z.dump","phase11-verified-schema26-20260910T120000Z.dump","phase11-repair-verified-schema26-20260910T123400Z.dump"]; for(const n of names){const p="/backups/"+n,r=JSON.parse(fs.readFileSync(p+".json")); const h=c.createHash("sha256").update(fs.readFileSync(p)).digest("hex"); if(h!==r.sha256||((fs.statSync(p).mode&511)!==384)||((fs.statSync(p+".json").mode&511)!==384)) throw Error(n); } const retained=fs.readdirSync("/backups").filter(n=>!n.startsWith(".")).sort(); const expected=names.flatMap(n=>[n,n+".json"]).sort(); if(JSON.stringify(retained)!==JSON.stringify(expected)) throw Error("unexpected backup inventory"); console.log(JSON.stringify({event:"protected_backup_pairs",outcome:"passed",pairs:names.length,modes:"0600",receiptsMatched:true,extraFiles:0}));'

docker exec agent-control-phase01-postgres-1 psql -U agentcontrol_admin -d agentcontrol -At -v ON_ERROR_STOP=1 \
  -c "SELECT 'schema_versions='||count(*) FROM schema_migrations; SELECT 'synthetic_databases='||count(*) FROM pg_database WHERE datname ~ '^agentcontrol_(test|restore)_';"
docker ps --filter label=com.docker.compose.project=agent-control-phase01 --format '{{.Names}}|{{.Status}}'
docker port agent-control-phase01-app-1
docker port agent-control-phase01-postgres-1
docker run --rm --mount "type=bind,source=$PWD/artifacts,target=/artifacts,readonly" \
  --entrypoint node node:24-bookworm-slim -e \
  'const fs=require("fs"); const names=["azure-bootstrap","azure-parameters","test-scratch","bicep-cli"]; const remaining=names.filter(n=>fs.existsSync("/artifacts/"+n)&&fs.readdirSync("/artifacts/"+n).length); if(remaining.length) throw Error(remaining.join(",")); console.log(JSON.stringify({event:"phase12_scratch_cleanup",outcome:"passed",remaining:0}));'
git diff --check
for file in deploy-azure.ps1 scripts/azure-deployment.ps1 scripts/azure-deployment.tests.ps1 \
  backend/scripts/backup.ts backend/scripts/backup.test.ts backend/scripts/azure-pitr.ts \
  backend/src/services/telemetry.ts backend/src/services/telemetry.test.ts \
  backend/src/services/bulkJobs.ts backend/src/services/bulkJobs.test.ts \
  backend/src/services/copilotStudioQuarantineJobs.ts backend/src/services/copilotStudioQuarantineJobs.test.ts \
  backend/src/errors.ts backend/src/server.ts infra/main.bicep \
  infra/production-target.example.json docs/azure-production-deployment.md docs/operations.md docs/security-model.md \
  infra/disaster-recovery.md README.md plans/admin-poc-production/completions/12-production-deployment.md; do
  output="$(git diff --no-index --check /dev/null "$file")"
  test -z "$output" || { printf '%s\n' "$output"; exit 1; }
done
```

The earlier archive was superseded because runtime telemetry producers and the
pool observer changed. The rebuilt and reverified release is:

- `artifacts/release/agent-control-linux-x64.zip`
- revision `0b7797dc4fe4-dirty-phase12-observability`
- 18,992,486 bytes; Linux/x64; Node 24
- SHA-256 `0c6416bd7fc6ac8b3050a6acbee0cdedb5f14ba70bbd1dfe222d0339ed8499a3`

The six protected pairs remain:

- `phase09-verified-20260909T220129Z.dump` and receipt
- `20260910T060940442Z.dump` and receipt
- `phase10-verified-20260910T095823Z.dump` and receipt
- `phase10-verified-schema25-20260910T110000Z.dump` and receipt
- `phase11-verified-schema26-20260910T120000Z.dump` and receipt
- `phase11-repair-verified-schema26-20260910T123400Z.dump` and receipt

No Phase 12 bootstrap/parameter directory, test database, restore target,
receipt fixture, temporary runner rule, detached process or test container
remains. The inherited `P09-BACKUP-HISTORY` finding remains unresolved; current
pair presence does not prove older missing history.

## Remaining production prerequisites (`cloud_not_run`)

1. Obtain the exact approved target, current Microsoft estimate, budget,
   maintenance and Burstable-risk approvals.
2. Prepare and authorize the existing vault's six unchanged current versions.
   If any version must change, first complete Phase 11's separately approved
   coordinated rotation and update the current receipt; the deployment wizard
   will not rotate it.
3. Prove authenticated target, regional capability/quota, networking, exact
   resources, Entra roles/callback/Administrator assignment and vault paths.
4. Run Plan and review its actual Azure what-if. Separately authorize Deploy.
5. Let Deploy/Recover pause contained, perform the real human
   login/callback/session check, provide its exact-run receipt, then resume.
6. Verify live references, least privilege, schema, backup, monitoring, smoke,
   alert delivery, observation and cleanup. Separately approve PITR/recovery,
   SWA retirement and Phase 13 qualification targets.

Resume only Phase 12 after explicit Azure authorization:

```powershell
pwsh ./deploy-azure.ps1 -Action Plan -TargetFile ./approved-target.json
pwsh ./deploy-azure.ps1 -Action Deploy -TargetFile ./approved-target.json
```

If a receipt exists, use its exact `-ReceiptPath` and `-ResumeReceiptPath` as
documented in `docs/azure-production-deployment.md`. Do not begin Phase 13 until
the live Phase 12 requirements pass. No cloud environment was accessed or
changed in this local repair.
