# Phase 11 - Security and Basic Operations Completion

## Status

```yaml
phase_file: 11-security-operations.md
phase_status: complete
outcome: completed_with_residuals
validated_at_utc: 2026-09-10T12:45:23.766Z
execution_target: retained local agent-control-phase01 and isolated Docker/PostgreSQL targets
```

## Delivered contracts

1. `docs/security-model.md` matches the one-origin browser/Express/Entra/provider/PostgreSQL/Key Vault/operator design. The independent Reader, Operator, SecurityReader and Administrator matrix remains enforced before saved-result rows, counts, previews and exports.
2. Login retains issuer/tenant/audience, state/nonce/PKCE, same-origin returns, session regeneration/expiry/logout and account eviction. MSAL tokens/cache remain process-local and are not persisted.
3. Fixed provider origins, redirect rejection, bounded bodies/responses, safe CSV and inert rendering remain tested. Production CSP/HSTS/nosniff/framing/referrer and API/static caching remain explicit.
4. Finite request, upload, export, queue and provider budgets remain unchanged. Docker `json-file` logs are now bounded for both persistent services at 10 MiB per file and three files.
5. The fixed `agentcontrol_admin`/`agentcontrol_app` split remains least privilege. Runtime can append/read ordinary audit but cannot alter it, own schema, assume admin, inspect operator receipts or perform retention. This is not cryptographic tamper protection from a privileged database administrator.
6. The safe HTTP completion logger is installed immediately after correlation ID creation, before path validation, body parsing and admission. Denied `429` and parse failures are observed using only request ID, status, duration and method; URLs, queries, headers, bodies, tokens and rows are excluded.
7. Public health/readiness and authenticated safe diagnostics retain their minimal disclosures. Schema/database/maintenance failure blocks readiness; optional providers only affect their capabilities.
8. Ordinary retention keeps one confirmed operator owner, finite 1-5,000-row batches, transaction lock/timeouts and dependency invalidation. Official set/version expiry now has terminal predicates, so already deleted rows cannot starve later rows.
9. `Retain` remains dry-run capable and browser-inaccessible. Applied local cleanup also owns seven-day backup expiry, now accepting snapshot-timed receipt version 3.
10. Restore now invalidates sessions, provider qualifications, official staging rows/previews/confirmations and replay receipts; fences all execution owners; preserves inconclusive sent writes; and repeats retention to a zero-change pass. It compares exact current owners/access signatures for package, Power Platform, Purview, Defender and quarantine caches. Official sets/versions deleted in the current database and mismatched Defender retained scopes are purged.
11. Reopen repeats current deletion/access review from one read-only current-database snapshot while holding the restored `operational_state` row in a real transaction. Current-review failure remains maintenance. Purview/Defender/generic/quarantine ownership and all relevant qualification authorities must be empty. Provider work remains disabled after reopen.
12. The cache-only Docker load profile remains bounded at 120 reads, 1,000 CSV rows, five admitted jobs and a rejected sixth. The observed local result does not prove Azure B1/Burstable B1ms capacity.
13. The scanner now scans fixtures, rejects malformed package metadata, requires every SPDX `AND`/`OR` alternative to be reviewed, and scans all 73 built backend runtime modules for SQLite/dynamic code. Scanner rejection tests remain local with no source upload.
14. The release ZIP contains only version/revision/platform/architecture/Node metadata in `release-manifest.json`. There is no per-file checksum map. The adjacent sidecar verifies archive integrity, not publisher authenticity; direct HTML/assets equality and extracted-runtime checks remain independent.
15. `docs/operations.md` and `docs/deployment-setup.md` document finite local logs, convergent restore retention, transactional current-state reopening, receipt snapshot time and archive-only release checksums. Existing non-secret target examples remain non-approvals.
16. Production fixture/bootstrap bypass, wildcard origins, SQLite runtime, raw provider/KQL options and disabled retention remain rejected. Six prepared-vault names/five runtime consumers remain unchanged; the administrator DB secret is absent from runtime config, mounts, layers and package content.

Phase 11 added migration 26 for the single operator-owned `operational_state` row and its maintenance/provider-admission/review state. Migrations 1-25 were verified against the retained database and were not edited. The subsequent repair added no migration and did not edit applied migration 26. Final verification found 26 applied migrations with zero checksum mismatches. Runtime has SELECT-only access to operational state. No Azure/provider action, grant, qualification, credential rotation, data reset or Phase 12 implementation occurred.

### Finite operating evidence

| Boundary | Default / observed value |
| --- | --- |
| Sessions / role refresh | 8 hours / 5 minutes |
| Request body / database pool | 512 KiB / 4 |
| Request admission | IP 1,200 read + 300 write/minute; principal 600 read + 200 write/minute |
| Local service logs | 10 MiB × three `json-file` logs for each of `app` and `postgres` |
| Retention | 1,000 default; 5,000 maximum per class/pass; restore repeats to zero; 5-second lock and 15-second statement timeouts |
| Load limits | 120 reads, p95 <2,000 ms, RSS growth <256 MiB, database growth <128 MiB, pool ≤4/no final waiters, five jobs/sixth rejected |
| Final load observation | p95 344.74 ms; RSS +218,447,872 bytes; database +3,686,400 bytes; pool 4; oldest queue 6 ms |
| Local recovery observation | backup 2 s; restore 2 s; current-state reopen 1 s; recoverable age 17.2 s at post-restore review; 40.7 s snapshot-to-post-reopen-verification upper bound |

The recovery measurement is one local logical drill, not an HA, Azure PITR, throughput, RPO guarantee or RTO guarantee. Receipt v3 records the recoverable snapshot at `2026-09-10T12:33:34.094Z`; dump/receipt completion was `2026-09-10T12:33:34.229Z`.

## Changed files

### Initial Phase 11 implementation

- `backend/src/config.ts`, `backend/src/config.test.ts`, `backend/src/app.test.ts`, `backend/src/middleware/admission.ts`, `backend/src/middleware/admission.test.ts` - fail-closed production settings, headers, diagnostics and bounded request admission.
- `backend/src/db/schema.ts`, `backend/src/db/sessions.ts`, `backend/src/services/operationalState.ts`, `backend/src/server.ts` - migration 26, single-owner session expiry, restored maintenance/provider admission and startup recovery.
- `backend/src/errors.ts`, `backend/src/routes/capabilities.ts`, `backend/src/routes/officialUsage.ts`, `backend/src/services/bulkJobs.ts`, `backend/src/services/copilotStudioQuarantineJobs.ts`, `backend/src/services/packageObservation.ts`, `backend/src/services/powerPlatformResourceQuery.ts` - redacted operational signals and provider admission.
- `backend/src/db/jobs.ts`, `backend/src/db/packageInventory.ts`, `backend/src/db/powerPlatformInventory.ts`, `backend/src/db/purviewAudit.ts`, `backend/src/db/defenderHunting.ts`, `backend/src/db/copilotStudioQuarantine.ts` - restored provider-work admission at existing repository owners.
- `backend/scripts/import-legacy-audit.ts`, `backend/scripts/import-legacy-audit.test.ts` - legacy-audit-only import against the complete current schema.
- `backend/scripts/cache-load.ts`, `backend/scripts/production-inspect.mjs`, `deploy-local.ps1` - bounded cache load, production tree inspection and confirmed operator cleanup/reopening commands.
- `backend/package.json`, `package-lock.json` - `csv-parse` 6.2.1 to 7.0.2 and resolved development dependency advisory repair.
- `infra/production-target.example.json`, `infra/qualification-targets.example.json` - minimal non-secret production and qualification boundaries, explicitly not approvals.

### Restore, retention and tests

- `backend/scripts/backup.ts`, `backend/scripts/backup.test.ts` - snapshot-timed receipt v3, transactional current review, conservative cache reconciliation, authority invalidation and post-backup/review-window regressions.
- `backend/scripts/database.ts`, `backend/scripts/database.test.ts`, `backend/src/db/officialUsage.test.ts` - terminal official-retention predicates, bounded repeat-to-zero helper and >5,000-row convergence/dry-run/dependency invalidation coverage.
- `scripts/local-deployment.ps1`, `scripts/local-deployment.tests.ps1` - receipt-v3 backup retention and culture-independent timestamp validation.

### Telemetry, packaging and scanning

- `compose.yaml` - bounded logging for both persistent services.
- `backend/src/app.ts`, `backend/src/services/telemetry.ts`, `backend/src/services/telemetry.test.ts` - pre-admission/pre-parser finish telemetry and discriminating `429` redaction coverage.
- `backend/scripts/security-scan.mjs`, `backend/scripts/security-scan.test.mjs` - fail-closed metadata/SPDX/fixture/application-tree scanning.
- `Dockerfile` - supplies root deployment/orchestration sources to the local security-scan stage.
- `backend/scripts/package.mjs`, `backend/scripts/package-smoke.ts`, `backend/scripts/zip-runtime-smoke.mjs` - archive-level checksum and minimal release metadata without per-file hashes.
- `docs/security-model.md`, `docs/deployment-setup.md`, `docs/operations.md` - repaired operating and recovery contracts.

`frontend/` producers/consumers were impact-checked and unchanged by this repair. `frontend/src/components/UserAccessView.tsx` and the four existing deleted report modules were preserved.

## Validation evidence

| Check / exact copyable command | Status | Observed result |
| --- | --- | --- |
| `docker build --target operator -t agent-control-phase11-operator-repair:local . && docker exec agent-control-phase01-postgres-1 createdb -U agentcontrol_admin agentcontrol_test_phase11_repair && docker run --rm --network agent-control-phase01_default --mount "type=bind,source=$PWD/.local/agent-control-phase01/secrets,target=/run/secrets,readonly" -e PGHOST=postgres -e PGUSER=agentcontrol_admin -e PGDATABASE=agentcontrol_test_phase11_repair -e PGPASSWORD_FILE=/run/secrets/postgres-admin -e APP_PGPASSWORD_FILE=/run/secrets/postgres-app --entrypoint node agent-control-phase11-operator-repair:local node_modules/vitest/vitest.mjs run backend/scripts/backup.test.ts backend/scripts/database.test.ts backend/src/db/officialUsage.test.ts; docker exec agent-control-phase01-postgres-1 dropdb -U agentcontrol_admin --force agentcontrol_test_phase11_repair` | passed after repair | 37/37 focused tests passed. A later backup-only rerun passed 1/1 with current official deletion and exact Defender scope revocation both after backup and during the restore-review window; historical job/row/export sources became unavailable. Purview qualification and execution ownership were cleared; unavailable current review stayed maintenance. |
| `docker build --target test -t agent-control-phase11-test-repair:local . && docker run --rm --entrypoint node agent-control-phase11-test-repair:local node_modules/vitest/vitest.mjs run backend/scripts/security-scan.test.mjs backend/src/services/telemetry.test.ts backend/src/middleware/admission.test.ts` | passed | 8/8 rejection/redaction/admission tests passed. |
| `/Users/candede/.dotnet/tools/pwsh -NoProfile -File ./deploy-local.ps1 -Action Test -Project agent-control-phase01 -StateRoot "$PWD/.local" -Port 3001` | passed | Backend 53 files/516 tests; frontend 24 files/175 tests; backend typecheck, frontend lint and both builds passed. |
| `/Users/candede/.dotnet/tools/pwsh -NoProfile -File ./deploy-local.ps1 -Action Deploy -Project agent-control-phase01 -StateRoot "$PWD/.local" -Port 3001` | passed | Final retained deploy completed; `app` and `postgres` healthy at `http://localhost:3001`. Existing volume, network, secrets and callback were reused. |
| `/Users/candede/.dotnet/tools/pwsh -NoProfile -File ./scripts/permission-browser.tests.ps1 -Project agent-control-phase01` | passed | 46/46 desktop/mobile Playwright scenarios plus the harness passed in 58.23 s. |
| `/Users/candede/.dotnet/tools/pwsh -NoProfile -File ./scripts/local-deployment.tests.ps1` | passed | 24/24 orchestration assertions, including v3 backup retention, passed. |
| `/Users/candede/.dotnet/tools/pwsh -NoProfile -File ./scripts/restart-runtime.tests.ps1 -Project agent-control-phase01 && /Users/candede/.dotnet/tools/pwsh -NoProfile -File ./scripts/persistence.tests.ps1 -Project agent-control-phase01 -Port 3001` | passed | Executed sequentially with no overlap; durable no-replay and persistence/restore checks passed and owned targets were removed. |
| `docker exec agent-control-phase01-postgres-1 createdb -U agentcontrol_admin agentcontrol_test_phase11_load_repair && docker run --rm --network agent-control-phase01_default --mount "type=bind,source=$PWD/.local/agent-control-phase01/secrets,target=/run/secrets,readonly" -e PGHOST=postgres -e PGUSER=agentcontrol_admin -e PGDATABASE=agentcontrol_test_phase11_load_repair -e PGPASSWORD_FILE=/run/secrets/postgres-admin -e APP_PGPASSWORD_FILE=/run/secrets/postgres-app agent-control-phase01-operator:local backend/scripts/cache-load.ts; docker exec agent-control-phase01-postgres-1 dropdb -U agentcontrol_admin --force agentcontrol_test_phase11_load_repair` | passed | 120 requests, p95 344.74 ms, zero reported errors, five admitted/sixth rejected and all finite thresholds passed. |
| `docker build --target security-scan -t agent-control-phase11-security-repair:local . && docker run --rm agent-control-phase11-security-repair:local && docker run --rm --entrypoint npm agent-control-phase11-test-repair:local audit --audit-level=high && docker build --target production-dependencies -t agent-control-phase11-dependencies-repair:local . && docker run --rm --entrypoint npm agent-control-phase11-dependencies-repair:local audit --omit=dev --audit-level=high` | passed | Final expanded scan covered 228 source/deployment/fixture files, 3,155,093 bytes, 332 dependency licenses and 73 runtime modules. Both audits found zero vulnerabilities. |
| `docker build --target runtime-inspection -t agent-control-phase11-runtime-inspection-repair:local . && docker run --rm --user "$(id -u):$(id -g)" --mount "type=bind,source=$PWD/.local/agent-control-phase01/secrets,target=/run/secrets,readonly" -e SECRET_SCAN_FILES=/run/secrets/postgres-admin:/run/secrets/postgres-app:/run/secrets/session:/run/secrets/client-secret agent-control-phase11-runtime-inspection-repair:local` | passed | 12,295 runtime files/77,561,938 bytes; all three nonempty mounted secrets, including the admin password, were absent. Runtime config/mount destinations/layer history also contained no admin-secret name. |
| `/Users/candede/.dotnet/tools/pwsh -NoProfile -File ./deploy-local.ps1 -Action Retain -Project agent-control-phase01 -StateRoot "$PWD/.local" -Port 3001 -ConfirmCleanup 'agent-control-phase01/agentcontrol' -CleanupBatchSize 5000 -DryRun` followed by the same command twice without `-DryRun` | passed after repair | Every class was zero in dry run and both applied passes. All protected backup pairs remained. |
| `/Users/candede/.dotnet/tools/pwsh -NoProfile -File ./deploy-local.ps1 -Action Backup -Project agent-control-phase01 -StateRoot "$PWD/.local" -Port 3001 -BackupFile "$PWD/.local/agent-control-phase01/backups/phase11-repair-verified-schema26-20260910T123400Z.dump"`; then the same root command with `-Action Restore ... -RestoreDatabase agentcontrol_restore_phase11_repair`; then `-Action Reopen ... -RestoreDatabase agentcontrol_restore_phase11_repair` | passed | Receipt v3 and schema 26 verified; maintenance/provider-disabled state, zero sessions/owners/qualifications and current deletion/access review were observed. Reopen left provider work disabled. The isolated target was verified and removed. |
| `docker build --platform linux/amd64 --target export --build-arg RELEASE_REVISION=0b7797dc4fe4-dirty-phase11-repair --output type=local,dest=artifacts/release .` followed by `docker run --rm --network agent-control-phase01_default --mount "type=bind,source=$PWD/artifacts/release,target=/export,readonly" agent-control-phase01-operator:local backend/scripts/package-smoke.ts http://app:3001 /export/agent-control-linux-x64.zip` and the Linux/x64 package `backend/scripts/zip-runtime-smoke.mjs` command | passed | ZIP/image HTML and asset equality, archive checksum, route/auth denial, Linux x64 Node 24.20.0 extracted startup/shutdown and secret exclusion passed. |
| `docker run --rm --network agent-control-phase01_default --mount "type=bind,source=$PWD/.local/agent-control-phase01/secrets,target=/run/secrets,readonly" -e PGHOST=postgres -e PGUSER=agentcontrol_admin -e PGDATABASE=agentcontrol -e PGPASSWORD_FILE=/run/secrets/postgres-admin agent-control-phase01-operator:local --eval 'import pg from "pg";import {databaseSettings} from "./backend/src/db/pool.ts";import {migrations,migrationChecksum} from "./backend/src/db/schema.ts";(async()=>{const db=new pg.Pool(databaseSettings());const rows=(await db.query("SELECT version,checksum FROM schema_migrations ORDER BY version")).rows;const mismatches=rows.filter((r,i)=>r.version!==migrations[i]?.version||r.checksum!==migrationChecksum(migrations[i].sql));console.log(JSON.stringify({event:"immutable_migrations",outcome:mismatches.length?"failed":"passed",applied:rows.length,expected:migrations.length,mismatches:mismatches.length}));await db.end();if(mismatches.length)process.exit(1)})()'` | passed | 26 applied/expected, zero mismatches. |

### Repair/rerun evidence

- Initial implementation aggregate failures included an early-schema grant, shared-test admission and staging retention (480 passed/24 failed); these were repaired before the final aggregate reruns. Initial browser admission limits yielded 34 passed/12 failed; the final finite single-instance budgets passed all 46 scenarios. The load deadline clock was corrected and the measured RSS threshold was explicitly set to 256 MiB; it is not an Azure capacity claim.
- Dependency scanning found `csv-parse` advisory GHSA-8cw4-87c7-c6xx and a development-only `@vitest/mocker` advisory. The parser upgrade and lockfile repair removed both; final complete and production audits reported zero vulnerabilities. License review included MPL-2.0, MIT-0, CC-BY-4.0 and legacy `licenses[]`; every license alternative must now match the reviewed allowlist.
- The first focused command pointed at `agentcontrol` and was correctly rejected by the isolated-test guard. The rerun used `agentcontrol_test_phase11_repair`.
- New restore fixtures initially exposed the required correction-preview rule, a source-fingerprint expectation made stale by intentional current deletions, and a Purview qualification foreign-key ordering defect. The fixtures and invalidation order were corrected; focused tests passed.
- The first hardened full scan rejected the rejection-test's literal credential example. The test now constructs that malicious fixture only in isolated scratch; scanner and rejection tests passed without adding a broad fixture exclusion.
- The first applied retention after creating a receipt-v3 backup failed closed because the PowerShell backup-retention allowlist accepted only versions 1/2. Version 3 and snapshot ordering were added and tested; two subsequent applied zero-change passes succeeded.
- One pre-restore inventory shell expression had invalid quoting; the restore itself succeeded and the target was independently verified before reopening/removal. A first ad hoc migration probe used unsupported top-level await in `tsx --eval`; the async-IIFE rerun passed. Neither validation-command error altered retained user data.

### Parent verification and exact runtime command

The parent independently reran `package-smoke.ts` against the retained app and final ZIP, the security-scan image (228 files, 332 licenses, 73 runtime modules), and all 24 PowerShell assertions. A runtime-only schema probe verified all 26 checksums as `agentcontrol_app`, healthy readiness, and only the `agentcontrol`/`postgres` databases. A read-only Docker backup inventory independently checked all six dump/receipt checksums and `0600` modes. Editor diagnostics and `git diff --check` passed. The exact package build/runtime command below also passed independently on Linux x64 Node 24.20.0 with secret exclusion; both production builds passed, retaining the inherited Vite >500 kB advisory.

The extracted Linux/x64 runtime check can be repeated without a third persistent service:

```bash
docker build --platform linux/amd64 --target package --build-arg RELEASE_REVISION=0b7797dc4fe4-dirty-phase11-repair -t agent-control-phase11-package-verify:local .
docker run --rm --platform linux/amd64 --network agent-control-phase01_default \
  --mount "type=bind,source=$PWD/.local/agent-control-phase01/secrets/postgres-app,target=/run/secrets/postgres-app,readonly" \
  --mount "type=bind,source=$PWD/.local/agent-control-phase01/secrets/session,target=/run/secrets/session,readonly" \
  -e PGHOST=postgres -e PGUSER=agentcontrol_app -e PGDATABASE=agentcontrol \
  -e PGPASSWORD_FILE=/run/secrets/postgres-app -e SESSION_SECRET_FILE=/run/secrets/session \
  --entrypoint node agent-control-phase11-package-verify:local backend/scripts/zip-runtime-smoke.mjs
```

Exact recovery/reopening commands used with the recorded receipt-v3 backup:

```powershell
/Users/candede/.dotnet/tools/pwsh -NoProfile -File ./deploy-local.ps1 -Action Restore -Project agent-control-phase01 -StateRoot "$PWD/.local" -Port 3001 -BackupFile "$PWD/.local/agent-control-phase01/backups/phase11-repair-verified-schema26-20260910T123400Z.dump" -RestoreDatabase agentcontrol_restore_phase11_repair
/Users/candede/.dotnet/tools/pwsh -NoProfile -File ./deploy-local.ps1 -Action Reopen -Project agent-control-phase01 -StateRoot "$PWD/.local" -Port 3001 -RestoreDatabase agentcontrol_restore_phase11_repair
```

That isolated target was removed after verification; these are rehearsal commands, not instructions to repoint the retained app or restore over user data.

Rechecked Microsoft guidance on 2026-09-10: [PostgreSQL compute](https://learn.microsoft.com/azure/postgresql/compute-storage/concepts-compute) documents B1ms as 1 vCore/2 GiB and warns that Burstable is not recommended for production, lacks 24/7 support and may become unreachable when credits deplete. [App Service Key Vault references](https://learn.microsoft.com/azure/app-service/app-service-key-vault-references) requires both identity permission and network reachability; unversioned references may cache for 24 hours. The prepared-vault/versioned-reference contract remains unchanged. These checks authorize no provisioning or grant changes.

## Release artifact

`artifacts/release/agent-control-linux-x64.zip` is 18,992,535 bytes. Its archive SHA-256 is `2a948ec99016c9fef638657cbe057659bb4e505985dd770020f271c483861ea0`. Metadata is:

```json
{"version":2,"revision":"0b7797dc4fe4-dirty-phase11-repair","platform":"linux","architecture":"x64","runtime":{"name":"node","major":24}}
```

The two inventoried stale release files and three stale release-evidence logs were removed before rebuilding. The current archive and sidecar are the only owned release artifacts. No per-file checksum inventory exists.

## Protected backup inventory

All dumps and receipts are mode `0600`, and every receipt checksum matches its dump:

| Dump | Bytes | Receipt | SHA-256 |
| --- | ---: | ---: | --- |
| `20260910T060940442Z.dump` | 230,942 | v1 | `beee8faaa55d6f382d9bc0259c15f4deef253c76ce715b1d7903511e92ee00ad` |
| `phase09-verified-20260909T220129Z.dump` | 231,073 | v1 | `bf78bcc1c9152d3386de18e26e6f412d03076edb0e500e010b347c3fa8d34e65` |
| `phase10-verified-20260910T095823Z.dump` | 231,570 | v1 | `e99e24bda5d80b5a3538b8d84c24f3474e45f2efc52c9ab420730ff7a6b3a7ff` |
| `phase10-verified-schema25-20260910T110000Z.dump` | 231,271 | v1 | `2c5326045468a8f59b9cc5a9413d462d97200ca2ddcc79c69127c97411cf1841` |
| `phase11-verified-schema26-20260910T120000Z.dump` | 233,154 | v2 | `e7502548f1bcc452f489a6b7d08288b8549f5d861406fc6c6f5f496561c09d5b` |
| `phase11-repair-verified-schema26-20260910T123400Z.dump` | 233,241 | v3 | `bbeb46c0ea029a844c770c9e19a41d12bf50620a70fc6b64b3f1f2c1df3925cf` |

This proves current local preservation only. It does not close inherited [P09-BACKUP-HISTORY](09-copilot-studio-quarantine.md#open-issues).

## Open issues

Inherited [P01 identity/bundle-size](01-domain-persistence-foundations.md#open-issues), [P04 inventory qualification](04-power-platform-inventory.md#open-issues), [P05 package safety/qualification](05-package-management.md#open-issues), [P07 Purview contract](07-graph-audit-search.md#open-issues), [P08 hunting qualification](08-defender-agent365-hunting.md#open-issues) and [P09 quarantine/history](09-copilot-studio-quarantine.md#open-issues) remain unresolved where recorded by their owners.

| ID / originating phase | Affected scope / evidence status | Containment | Signal / threshold | Responsible operator or role | Exact fix-forward trigger / next action |
| --- | --- | --- | --- | --- | --- |
| P11-AZURE-CAPACITY / 11 | Local measurements do not establish B1/B1ms regional capacity, CPU credits, managed networking, monitoring or cost; current Microsoft guidance does not recommend Burstable for production | No Azure deployment or automatic tier increase; examples are not approvals | Review CPU credits, storage, latency/error and ingestion thresholds for the exact approved target | Phase 12 deployment operator and budget approver | Obtain dated pricing, explicit POC/support-risk acceptance, capacity and maintenance approval; any larger tier requires a new cost preview and approval |

## Next session

- Phase 12 may rely on schema 26, exact two-service health, original `agent-control-phase01_data` volume/network/four secret files, bounded local logs, receipt-v3 recovery checks and the Linux x64 archive checksum above.
- Preserve all six verified backup pairs and inherited `P09-BACKUP-HISTORY`. Rebuild/requalify if the artifact changes.
- Obtain exact tenant/subscription/resource-group/region/app/origin/vault, current B1/B1ms availability, dated cost/budget and maintenance approval before any Azure action. No approval, grant or live qualification is inherited.
- Implement only `plans/admin-poc-production/12-production-deployment.md`; do not modify Phase 11 migrations or reintroduce per-file release hashes.
