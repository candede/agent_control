# 06 — Fixed-budget capacity qualification

## Mission and prerequisites

Measure and enforce the entire platform's resource behavior, including **PostgreSQL cgroup memory and Node live RSS/heap**, at the README envelope. Fix root bottlenecks and rerun without reducing correctness or increasing budgets to obtain green results. Read [README](README.md), completions for 01, 02, 02A, 02B, 03, 04 and 05, parent state and dirty status. GPT-6 Astra, `xhigh`. Use synthetic isolated fixtures only.

Hypothesis: increasing dataset cardinality by 10× does not increase request/worker resident working sets proportionally; concurrent replacement, reconciliation, exports and GC stay below fixed cgroup limits and preserve exact results. Start with a 10k-vs-100k cursor/query comparison with continuous sampling.

## Tooling contract

- Company-protected machine: **NEVER contact default/public npm or PyPI registries**, including probes, fallbacks, subprocesses or containers. npm registry access must use `https://packagefeedproxy.microsoft.io/npm/` via approved config or explicit `NPM_CONFIG_REGISTRY`; preserve the already-approved Dockerfile environment and parent-maintained project config.
- Python installs only with `python -m pip install --index-url https://packagefeedproxy.microsoft.io/pypi/simple <package>`; no public extra index, including inherited settings.
- Use existing dependencies. Install only after a manifest change or genuine missing-tool/package failure; no implicit `npx` downloads. Verify effective config locally and retain/reinject the approved registry after environment scrubbing. If the feed is unavailable, report it without public fallback. Follow README's binding tooling contract.

## Read first

- `backend/scripts/cache-load.ts` (existing proof is 1,000 packages, final RSS delta only)
- `compose.yaml`, `compose.large-tenant-test.yaml`, `scripts/large-tenant-tests.ps1`
- `backend/src/db/pool.ts`, typed query repositories and golden EXPLAIN evidence from 02/02A, activation contracts from 02B/04
- Generation/selection/export/GC/backup code and metrics introduced in 01, 02, 02A, 02B, 03, 04 and 05
- `scripts/local-deployment.ps1` internal software-gate capture boundaries and failure tests added by 01; extend, do not replace them with post-cleanup wrapper inspection
- `backend/src/services/{providerJson,graphPackages,powerPlatformResourceQuery,copilotUsageGraph,telemetry}.ts`
- `frontend/src/api/client.ts`, query cache helpers, browser fixtures and new large-tenant browser specs
- `docs/operations.md`, `docs/deployment-setup.md`

## Fixed environment and dataset

Implement `backend/scripts/large-tenant-capacity.ts`, `backend/scripts/largeTenantCapacity.test.ts` and the wrapper's `capacity` suite. Use a synthetic provider fixture server on the exact owned internal network, never real Graph/PP/report credentials. Generate rows incrementally from a fixed seed; the fixture generator must not itself allocate the dataset in one array.

| Resource | Fixed qualification budget |
| --- | --- |
| Node app/worker container | 1,536 MiB cgroup hard limit, 1.5 CPUs, `--max-old-space-size=768`; four-connection application pool |
| PostgreSQL 17 container | 1,024 MiB cgroup hard limit, 0.5 CPU, `shared_buffers=32MB`, `work_mem=4MB`, `maintenance_work_mem=64MB`, `max_parallel_workers_per_gather=0`, statement timeout 15 seconds |
| Provider/load/browser controller | Separately labeled 1,024-MiB, 1-CPU fixture container; separately measured, never counted as app headroom |
| Disk | Dedicated owned named volume; at least 64 GiB free on its backing filesystem before full-scale run; record actual volume/WAL/temp footprint and enforce run stop at 48 GiB used |
| Isolation | No production network/secret mounts, external providers, shared application DB, or default/shared project names |

Node/PG limits and CPU budgets are derived from existing `test-db`/`test-postgres` Compose defaults, not from an assumption that the laptop has unlimited memory. **This phase owns storage verification and correction even if 01 already supplied an override.** Inspect the effective Compose model, container mounts and PostgreSQL data/WAL/temp locations before loading realistic data. Existing PGDATA is a 256-MiB tmpfs inside a 1-GiB PG cgroup; loading DB plus WAL there conflates storage capacity with process memory. If that inherited tmpfs remains or measurements reveal storage-capacity exhaustion, fix only the campaign-owned fixture to use run-owned **disk-backed** storage for PGDATA/WAL/temp files, remove conflicting inherited mounts, and rerun the unchanged dataset. Do not increase tmpfs or PostgreSQL RAM to make it fit. Preserve the ordinary small-fixture defaults.

Record the exact backing volume/filesystem, free/used bytes, WAL/temp/table/index/backup bytes, effective cgroup budgets and ownership/cleanup receipt. Disk page cache can still be cgroup-charged: measure it and keep the stated headroom gate, not a cache-subtracted success claim. Capture diagnostics before removing the owned volume. Record Docker engine/VM/host memory/swap/CPU/disk and image/schema/worktree hashes; a host unable to supply the fixed envelope yields unavailable/inconclusive evidence, never smaller-data "pass." Do not change production runtime resource settings without 07's measured deployment decision.

The parent-built baseline operator is `agent-control-scale-5096-operator:local`; record its immutable image ID for comparison, not as proof the changed candidate passed. Build candidate images under distinct run-owned tags and leave both retained installations' app/operator tags unchanged. Successful image construction does not substitute for the local deployment path's operator build and 5/5 software gate.

Mandatory dataset profiles (deterministic, no real personal data):

1. **Cardinality baseline:** 100,000 directory users, 100,000 app-activity identities, 100,000 Graph packages, 100,000 PP resources; 100,000 official users, 200,000 official agent rows and 1,000,000 observed user-agent facts. Include linked, unlinked, ambiguous and conflicting inventories with an explicit expected canonical count **of at least 100,000 logical agents**, not a guessed 200k. Generate actual sparse observed relationships (for example ten observed agent links per user), never all users × agents pairs. Exercise the shipped runtime defaults: 256-KiB residual record cap, 250-record/1-MiB batch cap, page maximum 100, and README's aggregate quotas.
2. **Record/child stress:** 10,000 directory users with 500 plan facts each; 200 residual payloads exactly 256 KiB and one over-limit record; 100 agents with 10,000 child facts each; a user with 10,000 observed relationships; 100,000 distinct company/publisher/environment-like facet keys within valid field limits. Run profiles separately where their combined size would exceed the documented conjunctive quotas.
3. **Scope adversary:** two tenants/two principals with overlapping identifiers and opposing license/control facts; use baseline in one scope and at least 10,000 records in the other. Prove cross-scope leakage is zero.
4. **Boundary failure:** every record/batch/file/row/child/page/queue/byte quota at exact bound and +1, generated incrementally. A deliberate quota failure is a passed *negative test* only when no partial publication occurs and failure metadata is exact; do not count the failed business job as success.

## Required measurement workload

1. Cold ingest through fixture provider collectors and real staged writers, not direct table seeding alone; streamed imports, full validation, publication and canonical reconciliation. Separately time post-ingest SQL pages after ANALYZE and before fresh stats to expose plan instability.
2. Concurrent **12 readers** (Users, reports, agent list, details, facets), **2 ingestion replacements** in different allowed scopes/selectors, **2 exports**, and one GC worker. Apply the fixed queue/admission/pool bounds; record rejected/queued/timeout requests rather than hiding them in throughput.
3. Run **five complete replacements** with pinned old-page readers and in-flight exports, a failed/cancelled middle replacement, one worker restart and one correction/delete. Wait for obsolete pins to expire or explicitly release them, then bounded GC; repeat the workload three times from clean owned fixtures to detect variance/leak.
4. At least 1,000 page/detail/facet/summary requests per full run, including first/middle/last/reverse pages and high-selectivity/empty/common filters. Validate exact counts/set of row IDs against a streaming fixture truth digest; never use the same SQL under test as the sole expected-value generator. Verify every exported checksum/row count and no gap/duplicate.
5. Slow export consumer, abandoned polls and client disconnect, max record/child fanout, high-cardinality facets and response-byte failure. Include one real-time **600-second accepted Retry-After with no appends**, continuous 20-second owner/version/epoch heartbeats and validation-idle renewal under reader/pool contention. Record at least 30 renewals, bounded acquisition, no false lease expiry, then cancel another waiter and prove no post-cancel renewal/publication. Kill an exact-owned fixture worker and prove expiry/takeover plus old-owner fence rejection. No unsafe external mutation is necessary.
6. New-schema backup/fingerprint/restore and canonical/usage query under churn; restore into `agentcontrol_restore_*`, never current application DB or `agentcontrol_test_*` via a weakened guard. Include audit, session and provider-disabled restore semantics. Exercise 32 retained sets, concurrent acceptance and non-active correction/delete against history/overview/export pins.
7. **100k detail churn and progress:** after a 100,000-record broad baseline, apply one complete enrichment sweep as **5,000 batches of 20 keys**, then repeat a second changed-value sweep. Use sparse fixed-size identity components with a separate merge/split adversary; no broad-source replacement/compaction during this measurement. Keep pinned old readers, current readers, export and GC active; produce safe updates fast enough to keep reconciliation pending while the active job is running. Count rows read/written/closed/deleted, WAL bytes and job starts/cancels/publications by operation, not just elapsed time. Compare the same 20-key updates and component sizes in 10k and 100k baselines. Do not pass merely because memory is bounded while SQL copies N keys.

## Formal measurements and thresholds

Sample every **250 ms** throughout ingestion/publication/reconciliation/queries/export/GC/drain, not only process start/end. Capture per-process Node `rss`, `heapUsed`, `heapTotal`, `external`, `arrayBuffers`, event-loop delay, active work, queue depth and pool waiting/total. Record actual `process.execArgv` and V8 heap-limit statistics to prove the workload process received the heap limit, not just a launcher. **These timer readings are sampled maxima, not proof of maximum heap:** synchronous JSON allocation/GC can complete while the event loop blocks the sampler.

Add **peak-sensitive evidence** using existing Node/V8 facilities, no new profiling dependency. Run the measured process with `--trace-gc-nvp`; stream its pre/post-GC heap sizes and allocation counters to owned artifacts, retaining raw records and testing parsing against the actual Node/V8 version. Add synchronous `process.memoryUsage()`/`node:v8` checkpoints before/after bounded JSON parse/stringify, SQL-result materialization, import transformation, response serialization and export encoding, while relevant inputs/results are still retained and before yielding/releasing them. Use targeted stage hooks, not a global JSON monkeypatch. GC callback timing from `perf_hooks` may correlate events but a delayed callback's heap read is not the pre-GC heap. Allocation totals/samples are not resident heap maxima. Bound telemetry buffering and account for instrumentation overhead within unchanged budgets.

Implement an isolated **transient-heap detection probe** in `largeTenantCapacity.test.ts` and the capacity script (`--probe transient-heap`). After warmup, deliberately allocate/serialize/parse a synchronous burst producing at least **32 MiB additional retained heap**, checkpoint while live, release it and use probe-only forced GC before the next 250-ms timer reading. The entire measured burst/release/GC interval must be **<250 ms**. Assert the peak-sensitive detector crosses a declared probe tripwire (settled baseline +16 MiB) while timer-only observations miss it; this tests detection, not the production 615-MiB limit. Calibrate within the fixed budget without lowering the minimum burst or relaxing duration; if the host cannot demonstrate it, record the probe and heap-coverage proof as inconclusive. The full workload runs without forced-GC normalization. Do not claim a fake-clock timer test proves this property.

Persist separately named `sampledHeapUsedMax`, `gcPreHeapUsedMax`, `stageCheckpointHeapUsedMax`, `peakSensitiveHeapObservedMax`, `kernelChargedMemoryPeak` and heap-coverage status by PID/isolate/stage, without conflating loader/worker isolates. These are observed evidence with documented coverage, not an invented continuous absolute heap high-water counter. Missing GC fields/stage coverage, dropped telemetry or failed burst detection prevents a heap-bound pass; keep sampled lower-bound evidence truthful. In particular **cgroup `memory.peak` proves charged-memory high water, not heapUsed**, and cannot substitute for the heap evidence.

For **both** app and PG, capture cgroup v2 `memory.current`, `memory.peak`, `memory.max`, `memory.events` (`oom`, `oom_kill`, `max`), `memory.stat`, swap and CPU throttling; support equivalent cgroup v1 files with explicit mapping. Capture Docker `State.OOMKilled`, exit codes/signals, restarts and peak RSS for PostgreSQL backend processes. `docker stats` alone is insufficient because cache subtraction and missed peaks can hide pressure. Missing counters are `inconclusive`, not zero.

| Metric | Required bound |
| --- | --- |
| OOM/kill/restart | Zero new OOM/oom_kill/max-limit events, zero OOMKilled/signal-9/unplanned restarts |
| Cgroup headroom | Peak app and PG charged memory each ≤80% of fixed hard limit; report file cache and anonymous breakdown, do not subtract cache to call it passed |
| Node heap/RSS | Peak-sensitive observed heapUsed ≤615 MiB (80% of 768), with successful burst detection and complete declared GC/stage coverage; sampled maxima alone cannot pass. Report unmeasured peak uncertainty as inconclusive. App cgroup bound above; post-quiescence RSS/heap after cycle 5 ≤cycle-1 settled baseline +64 MiB and no monotonic >16-MiB-per-cycle growth |
| Request working set | 100k-vs-10k dataset growth changes steady per-request Node peak by ≤64 MiB; max returned rows and bound SQL parameters stay fixed |
| Latency | Warm list/detail page p95 ≤2 seconds (existing cache-load target), p99 ≤5 seconds; exact summary/facets p95 ≤5 seconds; no uncaught timeout or statement beyond 15 seconds |
| Publication/ingestion | Final head-swap transaction p95 ≤1 second; lock wait ≤2 seconds; full fixture ingestion/reconciliation completes within source deadlines (30 minutes users/PP, 4 hours Graph), export ≤15 minutes |
| UI | At most current/previous/next pages retained per view, list payload ≤1 MiB, detail ≤512 KiB, no auto-drained pages; idle/terminal export polls stop |
| Retention | Expired retired staging/chunks reclaimed within 10 minutes after pin release under admitted workload; no current/pinned rows removed; reserved quota converges exactly |
| Storage | No run exceeds 48-GiB fixture disk stop threshold; report table/index/WAL/temp/backup sizes and reusable dead tuples; no unbounded per-cycle growth after vacuum/GC |
| Detail publication work | For the fixed 20-key/same-component probe, 100k versus 10k touched/write/delete row counts differ by at most 10%; no N-row scan/clone or unchanged-key rewrite. Across each 5,000-batch sweep, membership/content/GC work is O(changed keys + affected component facts), with measured counters and no per-batch N multiplier. WAL per identical changed-key probe grows at most 2x (index-depth/measurement allowance), not 10x. |
| Reconciliation progress | At most one active plus one coalesced pending request per scope; zero cancellations caused solely by safe newer detail input. In the bounded sparse-component profile, while producer churn continues, at least one completed canonical publication every 60 seconds; after input stops, newest pending vector publishes within 5 minutes. Invalidating clear/revoke/unsafe-control still aborts promptly and forbids stale mutations. |
| Temporal GC | Current/pinned reference versions survive; after pin release, obsolete detail intervals/versions reclaim within the 10-minute retention bound without full-manifest deletion. Report per-key write/GC amplification and settled storage after both sweeps. |

A failed threshold remains failed even if the container did not crash. Diagnose rather than increase memory/CPU, clamp results, omit joins, lower fixture cardinality or round counts. Tune indexes/query plans/batch sizing **downward**, eliminate copies, fix queue ownership and slice reconciliation/GC while preserving the frozen supported envelope. Raising any frozen budget requires a parent-approved evidence-backed contract change and rerun; it is not a worker's shortcut.

## Diagnostics, validation and artifacts

Record the exact command, fixture seed/digest, image/schema/source hashes, full resource configuration, timestamps, per-stage durations/percentiles, rows/bytes/throughput, sampled and peak-sensitive memory evidence, burst-probe receipt, coverage and thresholds beneath `artifacts/large-tenant-data-platform/<run-id>/`. Extend 01's internal `Invoke-LocalSoftwareChecks` pre-removal capture when the real gate runs; link its persistent `artifacts/software-checks/<check-id>/` receipt rather than attempting to recover removed-container counters outside it. Preserve every gate/capture/cleanup failure. Collect `EXPLAIN (ANALYZE, BUFFERS, WAL, SETTINGS)` for scoped list/count/facet/relationship/reconciliation/GC queries; redact row values. Capture SQL activity/locks/size/spills, pool waiters, container logs/inspect and OS diagnostics **before** stopping/removing fixtures. Heap snapshots are synthetic-only optional diagnostics, not a replacement for live peak evidence.

Focused inner validation:

```sh
npm run test --workspace backend -- scripts/largeTenantCapacity.test.ts scripts/largeTenantFixture.test.ts
node --max-old-space-size=768 --expose-gc --trace-gc-nvp --import tsx backend/scripts/large-tenant-capacity.ts --probe transient-heap
node --max-old-space-size=768 --trace-gc-nvp --import tsx backend/scripts/large-tenant-capacity.ts
```

Both probe and full workload run sequentially inside the owned fixed-budget app/worker container and cannot create unbounded child workers. Preserve/stream their GC output instead of buffering it in the parent runner. `--expose-gc` is probe-only; record PID/flags for both commands. Exact root commands:

```powershell
pwsh -NoProfile -File ./scripts/large-tenant-tests.ps1 -Suite capacity
pwsh -NoProfile -File ./scripts/large-tenant-tests.ps1 -Suite browser
pwsh -NoProfile -File ./scripts/large-tenant-tests.ps1 -Suite restore
pwsh -NoProfile -File ./scripts/large-tenant-tests.ps1 -Suite all
```

`all` reruns every independent aggregate software check from README and the available qualification suites. Report every actual status and cleanup result separately. Clean exact-owned containers/volumes only after evidence collection; keep sanitized evidence. Do not run this dataset against production.

## Production continuation

Mandatory attempts and repair loops follow README's Always-Deploy contract. Capacity unavailable/failed is never called supported or passed and never silently ends the campaign. Carry a residual with measured failing dimension, narrower safe initial admission (not data truncation), live metrics and exact alert threshold, 07 owner and trigger. Existing deploy gates remain binding. Safe schema/read-only paths can deploy while affected heavy ingestion/export stays closed.

## Completion record and done conditions

Write exactly `completions/06-capacity-qualification.md`: workload/capacity support table; artifact paths/hashes; three-run sampled versus peak-sensitive evidence, burst detection/coverage and charged-memory headroom; both 100k detail-churn sweeps with row/WAL/GC amplification and canonical progress; heartbeat/pool-wait/takeover evidence; internal software-gate diagnostic receipts; effective disk-backed mounts, corrections and owned-volume cleanup; root fixes/retests; shipped defaults/SQL plans; UI/network evidence; image identities without retained-tag changes; cleanup incidents; production exposure/alert recommendations.

07 receives reproducible, truthful capacity evidence and explicit containment for any residual, not "looks scalable" or only final RSS. No actionable reproducible root defect is intentionally left unattempted.
