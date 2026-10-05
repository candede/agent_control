# 01 — Record foundation and isolated qualification

## Mission and prerequisites

Build the **dormant** PostgreSQL record-generation, fencing, selection and export substrate that 02/02A extend and 02B activates. This phase must not switch a production reader/writer, fetch a real provider, reset production, or invent compatibility adapters. Read the binding [README](README.md), step-worker contract, parent state and dirty status. Worker: GPT-6 Astra, `xhigh`. Repository scope includes backend, frontend shared types, scripts, docs and root Compose/build files.

Falsifiable hypothesis: fixed-size appends and a final scoped SQL fence can publish a complete immutable source while stale/cancelled writers cannot change the head. Start with a two-batch race test, not a framework.

## Tooling contract

- Company-protected machine: **NEVER contact default/public npm or PyPI registries**, including probes, fallbacks, subprocesses or containers. npm registry access must use `https://packagefeedproxy.microsoft.io/npm/` via approved config or explicit `NPM_CONFIG_REGISTRY`; preserve the already-approved Dockerfile environment and parent-maintained project config.
- Python installs only with `python -m pip install --index-url https://packagefeedproxy.microsoft.io/pypi/simple <package>`; no public extra index, including inherited settings.
- Use existing dependencies. Install only after a manifest change or genuine missing-tool/package failure; no implicit `npx` downloads. Verify effective config locally and retain/reinject the approved registry after environment scrubbing. If the feed is unavailable, report it without public fallback. Follow README's binding tooling contract.

## Read first

- `backend/src/db/{pool,schema,dataSync,dataSyncSchema,sessions,jobs}.ts`
- `backend/src/db/{officialUsage,officialUsageHistorySchema,agentUsage}.ts`
- `backend/src/services/{refreshExecution,operationalState,maintenance,telemetry}.ts`
- `backend/scripts/{database,databaseReset,testDatabase,fixtureSupport,softwareChecks,backup}.ts`
- `backend/src/types/{dataSync,copilotUsage,officialUsage}.ts`
- `compose.yaml`, `Dockerfile`, `scripts/local-deployment.ps1`, `scripts/local-deployment.tests.ps1`
- `backend/vitest.config.ts`, `frontend/vitest.config.ts`, `package.json` and workspace manifests

## Required implementation

1. **Freeze semantic evidence before deletion.** Add tiny deterministic fixture builders and golden assertions covering the README's directory/service-plan states, official complete sets/periods/unknowns, scope and count distinctions. Store synthetic inputs in test code, not tenant dumps. This seeds 02's source proofs and 02A's combined report proofs, not an old-format runtime reader.
2. **Append schema, grants and verification.** Implement shared metadata and directory/activity/plan record primitives from README; 02A owns typed official fact/history schema and domain logic, 03 owns inventory temporal membership. Add schema-version/content-hash and byte/cardinality constraints, scoped composite foreign keys, immutable content protections, head CAS and covering indexes. Use PostgreSQL 17 capabilities already in Compose, leaving existing runtime sole authority. Add empty-database initialization, repeat migration, tamper/checksum and least-privilege tests. Export tables are `data_exports`, `data_export_items` and `data_export_chunks`; chunk order/checksum/bytes are persisted.
3. **Small generation repository and independent heartbeat.** Implement begin/append/validate/publish/abort with exact limits, reservations, batch-digest idempotency and two-batch backpressure. Persist scope/session epochs and existing job/run/lease identity. Implement a separately scheduled 20-second heartbeat for the 60-second lease, fenced by owner/version/epoch/deadline/cancellation in short transactions, including append-idle, provider Retry-After and validation periods. Reserve renewal capacity within the four-connection budget. Renewal failure/zero rows or cancellation aborts work immediately; expired/stolen leases cannot renew or publish. Revocation, clear, takeover and cancellation share SQL publication fences and lock order; AbortSignal is additional, not authoritative. CAS checks the output head; a derived worker may finish a still-valid pinned input vector despite newer safe input, as 03 requires.
4. **SQL-first read primitives.** Implement selection capture and cursor codec with filter canonicalization, stable null/collation/tie-break ordering, authorization binding, 10-minute pins, earlier expiry and explicit invalidation. Prepare bounded typed dependency roots for 02A's tenant-history revision/epoch and 03's baseline/delta references; never enumerate every history set or source observation into the 16-root token. Domain repositories own relational reachability/invalidation. SQL reads target metadata, one page, or exact IDs. No `getAll` or implicit cursor draining; summaries are scalar results, sort/filter registries are allowlisted.
5. **Dormant export engine.** Build persisted jobs, bounded source async-iterator contract, chunk backpressure, integrity verification, fenced final publication, status-only polling, download iterator, expiry and disconnect/cancellation. Preserve audit start/complete/failure semantics and CSV formula defenses from `services/csvExport.ts`. No public routes/domain registrations until 02B; 02A implements dormant domain producers. Test that building never needs a full array/string or writable application filesystem.
6. **Owned test runner.** Create `scripts/large-tenant-tests.ps1` and `compose.large-tenant-test.yaml` with README's unique project, fixture credential, environment-scrubbing, no-secret/no-port safeguards. Use an owned disk-backed named volume for this campaign fixture; remove inherited PGDATA tmpfs in the override and verify effective mounts instead of creating overlapping mounts. Do not enlarge or remove the ordinary 256-MiB tmpfs fixture globally. Node/PG budgets match README/06; mount only owned artifact directories and source as required. The parent's baseline `agent-control-scale-5096-operator:local` is available: record its ID for baseline use, build changed candidates under new owned tags, and never overwrite retained `seha`/`agent-control-phase01` tags for tests. 06 owns the final measured storage correction and disk/WAL/temp telemetry. Detect missing container tooling and record unavailable after attempting supported recovery, not auto-installing arbitrary infrastructure.
7. **Capture inside the existing software gate, not just outside it.** Modify `Invoke-LocalSoftwareChecks` in `scripts/local-deployment.ps1`: its current `compose run --rm` removes the test container before the outer wrapper can inspect it, and `finally` tears down PostgreSQL. Give the test container an exact owned identity, disable its automatic removal, start bounded live cgroup/log capture before the test workload and collect final available test/PG state before explicit test removal and PG `down`. Persist sanitized logs, exit/signal, inspect/OOM flags and cgroup current/peak/events/stat counters outside disposable scratch at `artifacts/software-checks/<check-id>/`. Capture during execution because stopped-container cgroups may already be gone; mark unavailable counters honestly. Handle partial startup and every failure path, not only success. Retain all original test/command/cleanup failures in the existing aggregate; capture errors add explicit failures without masking originals or preventing remaining safe capture/cleanup attempts. Preserve the real 5/5 gate, synthetic isolation, project ownership and pre-maintenance/pre-reset ordering. The new campaign wrapper also captures before its teardown but cannot substitute for this internal hook. 06 extends these boundaries with full metrics. Add existing-helper plus wrapper ownership/order/failure tests; future suites fail explicitly until implemented.
8. Update directly related `docs/operations.md` and schema/operator docs with dormant boundary, fresh-reset policy and test commands. Trace frontend shared imports; if none change, record that evidence. No runtime flag to select old/new storage.

## Scope guard and atomicity

Leave production directory, official-report and inventory readers/writers unchanged in this dormant foundation. No new stored data is populated from old application data. Existing migration SQL remains immutable. 02 builds user-source/people primitives; 02A builds report/combined-query/export foundations; 02B activates all users/report producers and consumers together and deletes replaced runtime/empty stores. Export primitives are domain-neutral only where needed; do not build a generic scheduler or copy all jobs. The existing gate's diagnostics change must not alter any pass/fail or target-safety guarantee.

## Validation

Implement new suites at `backend/src/db/dataGenerations.test.ts`, `backend/src/services/dataSelections.test.ts`, `backend/src/services/dataExports.test.ts`, `backend/scripts/largeTenantFixture.test.ts`. The wrapper's foundation suite runs these exact inner commands in the owned fixture:

```sh
npm run test --workspace backend -- src/db/dataGenerations.test.ts src/services/dataSelections.test.ts src/services/dataExports.test.ts src/db/schema.test.ts src/db/sessionsConcurrency.test.ts scripts/largeTenantFixture.test.ts scripts/databasePreflight.test.ts scripts/databaseReset.test.ts
npm run typecheck --workspace backend
```

Root commands:

```powershell
pwsh -NoProfile -File ./scripts/large-tenant-tests.ps1 -Suite foundation
pwsh -NoProfile -File ./scripts/local-deployment.tests.ps1
```

Also attempt README's aggregate software commands. Tests must cover: 0/1/250/251 rows, 1-MiB and 256-KiB exact boundaries and +1, JSON UTF-8 byte growth, same/different batch replay, poisoned duplicate identity, cross-scope FK, commit failure, cancellation/revocation racing commit, expired/stolen lease, stale output head, previous successful head retention, no partial visibility, cursor tampering/filter/scope reuse/null/tied sorts, export disconnect and artifact checksum. With controlled time prove at least 30 independent renewals through a 600-second Retry-After without any append, renewal during validation/pool contention, renewal failure abort, cancellation stopping the timer/network work, process-death expiry/takeover and rejection of late old-owner renew/append/publish. 05/06 add real-process/real-time evidence. Exercise SQL with the runtime role, not admin-only mocks. Record actual commands and missing-tool status.

Extend `scripts/local-deployment.tests.ps1` to assert internal capture precedes test-container removal and PostgreSQL teardown on success, startup failure, test nonzero exit, OOM/missing counters, capture error and cleanup error. Inject combined test/capture/cleanup failures and assert every original exception survives, gate result stays failed, retained app/maintenance/DB remain untouched, and evidence survives scratch deletion. Add an owned disposable failing-workload smoke test for the same helper boundary, not only outer-wrapper mocks; no retained project or application credentials. Missing telemetry never becomes zero/pass.

## Production continuation

Follow README's Always-Deploy Production Contract. This phase performs no production action. Non-passing checks require root repair, truthful status and a residual with containment/signal/threshold/07 owner/fix-forward trigger; they do not create a test-only campaign ending or permission to weaken a deploy gate.

## Completion record and done conditions

Write exactly `completions/01-record-foundation.md` with tables/constraints/indexes/fence protocol, dormant proof, changed files by root, focused/aggregate outcomes, internal software-gate capture/order/failure receipts and persistent evidence paths, fixture ownership/cleanup, residuals and decisions. Include measured maximum SQL parameter bytes and batch residency, not assumptions.

02 may rely on tested staged-record, selection and export APIs, a reproducible isolated runner, immutable migration/grant parity and small semantic fixtures. Done means working dormant implementation plus attempted verification, not merely new types/DDL stubs. No app consumer is silently half-cut-over.
