# 05 — Lifecycle and bounded-work closure

## Worker result and boundaries

- **Worker assessment: `complete_with_risk`; parent acceptance pending.** Phase05 implementation and disposable lifecycle/restore/restart/browser proofs are complete. The campaign remains open for 06 capacity qualification and 07's unchanged software gate and authorized production convergence.
- Prompt SHA-256: `896f90538206ad985f118a82f78d805b35d0eee6bc6d2c1b1c5c45c3b653800d`.
- Baseline HEAD remains `7e2be0b6b844bd538dbdd15f3e8261ea0fc6aeb6`. All accepted dirty work was preserved. No delegation, agent messages, commits, branches, pushes, production operations, production secret/configuration mounts, successful package installations or external provider traffic.
- Parent ledger was **not edited**. All nine prompts, plan README, predecessor completion records and inherited deletions remain unchanged.
- Evidence is under `artifacts/phase05/` and the exact owned run directories referenced below. `qualification-attempt-index-final.json` indexes retained successful, failed and interrupted logs. Counts from overlapping suites are not added together.

## 1. Lifecycle matrix and executable evidence

| Event | Read/export effect | Worker/storage effect and proof |
| --- | --- | --- |
| Safe replacement, accepted new report, exact detail update | Existing valid selections keep their immutable captured view. | Current publication advances independently; captured canonical work finishes with one latest pending input. Pinned-reader/export/GC race, generation admission and reconciliation tests preserve this behavior. Ten repeated inventory reads create no new generation clones. |
| Failed attempt or cancelled owner | Last successful publication remains readable. | Owner fencing prevents publication; reservations contract to actual stored bytes. Abandoned lease takeover releases the previous 16-MiB reservation rather than retaining it. |
| Principal clear, logout/revocation, privacy deletion, tenant removal | Affected epochs immediately deny subsequent selected reads/downloads. No unrelated principal or tenant purge. | Existing authority transitions remain atomic. Revocation reads scope UUIDs in pages of 250: the 501-scope falsifier observes `[250,250,1,0]` and all 501 epochs advance. |
| Official correction, confirmed deletion or expiry, including non-active sets | Tenant-history invalidation advances even when active-head revision does not; old exports are denied. | Shared facts survive while referenced by retained memberships. Tests cover 32 retained sets, acceptance continuity and non-active correction/delete/expiry. No new legal-hold product or competing current head. |
| Source expiry or unsafe invalidation | New pins/reads fail; active native streams fail rather than finishing a partial artifact successfully. | Invalidated selection quotas and ready-export pins release without waiting for the ordinary selection/artifact TTL. Peer ownership remains usable. |
| Cancellation, role loss, disconnect, artifact expiry | Polling stops on terminal/unmount/logout; partial streaming is audited as failed. | Six new-platform producer kinds use the shared engine; retries reuse immutable intent, never invisibly recreate a failed admitted job. |
| Process death and restore | Expired owners cannot revive; restored sessions and provider qualifications are invalidated. | Bounded startup recovery leaves uncertain sent work inconclusive and unsent work awaiting authorization. Compiled crash/recover and real guarded restore verify the fences and provider-disabled state. |

`backend/src/db/dataLifecycle.test.ts` starts with real database falsifiers, not mocked deletion counts. The original pinned-export race removed **1,560,057 bytes in one slice**; the repaired collector enforces the shared byte budget. The final file passes **5 tests**, including scalar backlog drain-to-zero, scope pagination, replacement/invalidation, quota isolation and fairness beyond initial scan limits.

The fairness case creates **24 historical inventory roots and 18 expired selectors**, holds an early valid pin, repeats reads without cloning, recreates the collector mid-run, proves later roots are collected, releases the early selection, and proves it is eventually collected too. More than 400 persisted inventory slices are exercised. Existing control settlement remains a prerequisite for inventory GC.

## 2. Bounded GC, quotas and recovery

Forward migration **75** adds persistent lifecycle progress for `records`, `inventory`, `inventory_metadata`, `operator`, `report_payloads` and `report_staging`. `LifecycleSlice` shares mutation accounting across relations, reserves progress/metadata writes, uses encoded-row cumulative prefixes, returns scalar counts instead of payloads, and advances relation positions so earlier busy tables cannot starve later work.

- Each committed collection slice is capped at **1,000 changed rows, 1,048,576 encoded bytes and five seconds**; each SQL change batch is at most 250. PostgreSQL transaction/statement deadlines bound waits as well as application loops.
- Current/staging roots, worker-input pins, valid selection/export pins and retained history protect dependencies relationally. Roots are marked deleting under lock, rejecting new pins. Child-first deletion avoids hidden full-snapshot cascades; closed validity intervals cannot reopen.
- Inventory content/metadata stages reuse the same checked-out connection, fixing a nested-checkout stall. Outer and metadata cursors both reserve their progress updates.
- Official staging cleanup performs one resumable slice, not a drain loop. A 76-row abandoned ingestion test proves continuation and reservation release only after both stored representations are gone.
- Operator retention and restore review use bounded child-first mutations. Review removes dependent package, Purview and Defender rows before parent snapshots/jobs; no broad parent cascade is substituted.
- Package recovery processes one job and at most **64 items**, quarantine one job and at most **25 items**. A cumulative **768-KiB item/attempt/audit prefix** leaves room for bounded job metadata inside the one-MiB/five-second slice. A 140-item, 60-KiB/item fixture proves bounded intermediate slices, eventual recovery and zero repeated progress.
- Startup drains only positive-progress slices, yields between them and respects maintenance. Explicit resume targets the requested job. GET quarantine/job projections remain read-only.
- Independent heartbeat continues through waits; stale takeover and exactly-once reservation release are verified in the compiled runtime, not only mocked timers.

Current-only mutation authority, per-item source generation/identity/deadline, publication-mutex lock ordering, current-source SQL, separate direct-canary qualification, current package control storage and optional stale detail READ semantics from 04 were preserved.

## 3. Export and polling closure

The shared lifecycle tests exercise `copilot_users`, `official_agents`, `official_users`, `graph_packages`, `power_platform_agents` and `unified_agents`. Slow-reader tests pause after a 256-KiB chunk, prove the database connection has been released, then invalidate the source and verify rejection plus a failed audit. Disconnect, role loss and expiry also produce failed partial-stream receipts.

Setup accepts a validated UUID idempotency key. Concurrent identical requests produce one durable job; changed intent conflicts, invalid keys fail, and repeated cancellation releases/audits once. Frontend setup/status preflight/cancel retry only network/429/503 failures, at most three attempts with bounded 2–10-second waits and numeric Retry-After handling. Already-aborted calls and retry-wait cancellation consistently return `ApiError` with `request_aborted`; context owners abort outstanding work.

Native HTTP delivery holds the last chunk until checksum, final authority and audit completion succeed. A completion-failure HTTP falsifier returns an error rather than satisfying Content-Length with a falsely successful CSV. At most a held final chunk and current chunk are retained, **512 KiB total**. No artifact-sized Blob or all-matching browser ID enumeration was added.

Audit allowlisting preserves SHA-256, row and byte counts, including partial-prefix checksums on failed streams. Server completion is not claimed to prove a client's disk write.

## 4. Streaming backup and actual forward restore

`backend/scripts/backupInventory.ts` is an explicit, validated **104-table primary-key inventory**, not a replacement guessed ceiling. Unknown/missing tables are rejected. Version-4 receipts identify the schema and `sha256-pg-row-json-pkey-utf8-v1`; no old-receipt converter was added.

Fingerprints use stable primary-key ordering, UTF-8 row JSON split into 32-KiB pieces and FETCH batches of four pieces. Fingerprints and `pg_dump` share the **same exported repeatable-read PostgreSQL snapshot**. Dump checksum/file IO and subprocess output are streamed; no table-wide JSON aggregation/sort or dump-sized synchronous buffer remains. Existing target, ownership, checksum and 120-second subprocess guards remain.

Final exact command:

```powershell
pwsh -NoProfile -File ./scripts/large-tenant-tests.ps1 -Suite restore
```

Receipt: `restore-verified-final.log`, run `77d7e1843382499485b4111a4e297e0a`: **5 tests in two files and backend types passed**.

- Source: `agentcontrol_test_00469c4c8fa044a0b20b095f51939601`.
- Distinct target: `agentcontrol_restore_213f666acc5b457083b1eee8ce6ccf60`.
- New-schema fingerprints/pointers and three package facts verified; repeated fingerprints agree and a concurrent post-snapshot commit is excluded.
- Runtime grants verified; maintenance readiness **503**, reviewed reopen readiness **200**, **providerWorkEnabled=false** throughout reopen.
- Target creation uses the existing restore operator, never the integration-only `testDatabase` prefix path. No production checkpoint or old production data was restored.
- Earlier successful restore runs are retained too. Final wrappers close connections, drop tracked child/restore/control databases and remove only owned resources.

## 5. Cross-root bounded collection inventory

| Consumer | Actual retained contract |
| --- | --- |
| Provider/SQL transfer | At most 250 records and one MiB encoded; residual JSON 256 KiB. |
| Selected lists, detail, cursor, identity lookup | 100 rows/one MiB; 512-KiB detail; four-KiB cursor; 100 exact IDs. Repeatable-read selected operations keep one client/captured time; SQLSTATE 40001 remains explicit 503/Retry-After 5 without transaction replay. |
| Generations/admission | Eight GiB/generation, 64 GiB/tenant; four streams global, two/tenant, one/selector; queue 32. Four DB connections: three foreground and one heartbeat; five-second acquisition, 15-second ordinary statement budget, 20-second heartbeat/60-second lease. |
| Official facts/imports/history | Fact/staged JSON 16 KiB; acceptance copies 50 rows/statement; cleanup 25 rows/child relation within the shared budget. Staging two GiB/tenant and one GiB/actor/bundle. History membership is relational, not a full reachable-set array. |
| Jobs/status and exports | Scalar status/counts with independent bounded item pages; server-staged ordinary mutation ceiling 5,000. Existing explicitly chosen export IDs remain capped at 5,000; all-matching never enumerates them in the browser. Artifacts one GiB/two million rows, 256-KiB chunks, 15-minute build/30-minute expiry. |
| People/investigations | Exact-ID batches 100, eight concurrent people lookups, 100,000-reference traversal ceiling; names 512 and UPNs 320 characters. At most two inventory identity candidates establish uniqueness. Independent child/detail pages, not full canonical membership arrays. |
| UI/cache/polls | One visible selected page; inactive saved queries have `gcTime=0`, no implicit focus/reconnect retry; logout/context owner clears cache. Export intervals 2–10 seconds, automatic due check 60 seconds, five-minute backoff/follow ceilings. Context CSV uses bounded selected detail projections. |
| Intentionally bounded Purview/Defender | Purview at most 20 pages/5,000 records/eight million total bytes and two-million-byte responses. Defender at most 200 stored rows, a 201st partial-result sentinel and two-million-byte responses. Existing 30-second requests, three retry attempts, seven-day query and one-hour qualification windows remain; no unrelated provider rewrite. |
| Backup/current review | Explicit schema/key inventory; four 32-KiB pieces per fetch; review changes at most 250/one MiB; exact-current review capped at 100,000 IDs and report selection review at 10,000 tenants. |

The audit traced provider collectors, routes, status, CSV/context export, saved people/identity, investigations, official history/overview and UI dependencies. Accepted cutover deletions remain deleted. No new competing control/current store or compatibility reader was introduced.

## 6. Exact browser and compiled restart receipts

### Compiled restart — final application source

`restart-verified-final.log`, project `agent-control-ltdp-36d9935cff604d9db011182bcc25c7e9`, completed successfully:

| Stage | Image/workdir/command | Role/mounts/outcome |
| --- | --- | --- |
| Seed | Checked-in `operator`, `/app`, tsx `backend/scripts/restart-fixture.ts seed /evidence/restart-fixture.json` | Synthetic admin/app fixture credentials; writable owned evidence; exit 0. |
| Crash | Checked-in `runtime`, `/app`, `node /fixture.mjs crash` | `agentcontrol_app`, runtime-only synthetic credentials; read-only root and exact read-only harness/receipt; readiness 200; expected dispatch marker **and exit 17 and receipt-selected persisted dispatch evidence**. |
| Expire | Same operator/tsx, `restart-fixture.ts expire` | Validates the guarded receipt-selected child, expires only fixture leases; exit 0. |
| Recover | Fresh container from the same runtime, `node /fixture.mjs recover` | Same runtime-only role/read-only mounts; readiness 200, unchanged captured report/readback checks, fenced takeover and recovery; exit 0. |

Child DB: `agentcontrol_test_39f26c0e55f647c699cb5884414e7ab7`; control DB: `agentcontrol_test_36d9935cff604d9db011182bcc25c7e9_control`. Cleanup records both dropped, **zero connections and zero remaining**.

Quiet wait **21,000 ms**, successful renewal advance **22,644 ms**; process-death takeover fences the stale owner and leaves **zero reservation bytes**. Compiled report export recreation verifies two rows/1,515 bytes. Uncertain mutations are not automatically replayed; explicit fixture authorization/resumption is separate.

### Browser — exact results, not a single invented green run

The new `browser` wrapper builds unique checked-in Dockerfile `operator`, `runtime` and `permission-browser-test` targets. It enters the existing synthetic-auth **Vitest bootstrap** at `/app/backend`, waits for app readiness 200, then that bootstrap launches the existing Playwright CLI. Internal network, alias `test-postgres`, no host ports/provider route, synthetic credentials only; the 1–32 distinct-basename guard remains.

| Evidence/run | Observed result |
| --- | --- |
| `browser-qualified.log`, `838830fb43bb4388bbc71124e5d3319e` | Earlier successful unfiltered **509 passed / nine existing skips**, no unexpected/flaky cases; earlier source snapshot is retained, not claimed equal to final source. |
| `browser-verified-final.log`, `1ef61e12d95243429670786341edac40` | **Final application sources: unfiltered 509 passed / nine existing skips / zero unexpected / zero flaky**, 577,564 ms. Focused stage separately had three pass/one startup-selection keyboard timing failure, so the wrapper honestly exited 1. |
| `browser-closed.log`, `59d879433b014737bb1a9ec23c166dad` | Focused lifecycle **four passed**. Unfiltered repeat **508 passed / one existing scroll-geometry timing failure / nine skips**. The wrapper exited 1, not success. |
| `browser-focus-closed.log`, `f5948fd583e24ae38ab394a3463791b6` | Final two implicated specs together **22 passed**, no skips/unexpected/flaky cases, through the existing `cutover-browser-contract` Vitest bootstrap; current fixture source verified in its owned image. |

The last two repairs change **browser tests only**: await actual startup network quiescence rather than assuming one/two initial captures, and await the original viewport/side/position invariants rather than assuming two animation frames suffice after scrolling. All original geometry, focus, keyboard, count and timing assertions remain; no skips or deadline increases. No application-code change followed the successful final-app 509-case run. A complete exact-wrapper rerun with both final fixture-only changes is not claimed; the residual is explicit below.

Full coverage includes Users, imports/history, agents/details/responsibility, safe previews, every export producer, desktop/mobile, keyboard/focus, labels, overflow and pending/partial/catching-up/stale/unknown/error states. Existing saved-query tests verify cache disposal and context fences. Measured final focused lifecycle cases on both viewports: **24 API requests, one page, 4,517 maximum page bytes, two identical setup attempts, one status poll, zero polls after unmount**; terminal failure has one poll and **zero downloads**. Production-built full-matrix variants measured 31 requests/two pages within the same three-page ceiling. No member/child/mutation-preview request is made just to select/export the visible group.

`browser-matrix-final.json` retains all these stats/attachments, including failed stages, rather than replacing them with screenshots.

## 7. Validation and retained failures

All commands use fixed fixture limits and existing dependencies. No original gate deadline, memory, backend parallelism, cardinality assertion, 5,000-target/120-second, inventory-export/15-second or 30,001-user/60-second assertion was weakened.

| Command/receipt | Result |
| --- | --- |
| `-Suite lifecycle`, `lifecycle-final.log` | **377 backend tests/18 files; 410 frontend tests/eight files; backend types and frontend lint passed.** Covers every required prompt selector, plus history, recovery, inventory GC, schema and HTTP completion-failure tests. |
| `-Suite lifecycle-race`, `lifecycle-observability-verified.log` | Final **five database falsifiers and types passed**. |
| `-Suite lifecycle-repair`, `lifecycle-qualified-final.log` | Final **196 backend tests/nine files; all 2,393 frontend tests/82 files; types, lint and frontend build passed**. Backend 24,959 ms; frontend 117,991 ms. This is a focused backend selector, **not** the unchanged full software gate. |
| `-Suite report-source-scale`, `report-source-closed.log` | Final **34 tests and types passed**; suite 62,972 ms. Includes unchanged 30,001-user case and measured 1,000/10,000 users/facts with real SQL plans and row/byte assertions. Suite elapsed time is not the individual 60-second assertion's duration. |
| `-Suite inventory-refresh-services` | 210 tests/seven files passed; that earlier invocation's types failed TS7022. The annotation repair subsequently passed combined/current type checks and compiled builds. |
| `-Suite inventory-exports` | 26 tests/four files passed; same earlier type failure subsequently repaired. |
| Final `-Suite restore` / `-Suite restart` | Passed as detailed above. |
| Existing mocked PowerShell local-deployment tooling | **1,319 assertions passed**; no retained-project harness or secrets used. |
| Independent `-Suite all`, `all-final.log` | Literal result **three of five commands passed**: backend timeout at **600,031 ms**, SIGTERM/ETIMEDOUT, 30 completed files and **no full backend result**; frontend 2,379 passed/14 failed; types/lint/root build passed. The 14 frontend failures were repaired and the subsequent entire 2,393-test frontend suite passed. This failed aggregate is retained, not rewritten as four/five or a full backend pass. |
| Final source/build/migration/cleanup checks | 743 image input entries compared, 204 compiled backend files and four compiled frontend files verified, frozen migrations checked, `git diff --check` clean, editor diagnostics clean. |

Meaningful failed/intermediate attempts remain in the indexed logs:

- Initial GC byte overrun; replaced independent drains with shared budgets.
- Backup pg callback-overload spy hang; preserved pg overloads. Restore review initially referenced the wrong Defender child relation; corrected to `defender_hunting_qualification_evidence`.
- Installed-dependency reuse/build preparation initially attempted the approved feed under network-none and failed DNS; no public fallback or successful install. Nested frontend dependency removal was corrected.
- Early combined restart hung after synthetic lost responses occupied foreground connections. Those fixture-only quarantine/canary responses now settle inconclusively before the genuine bulk process-death boundary.
- Browser fixture failures covered immutable request keys, async facet readiness, actual Users heading, CSV tenant isolation, Node-version parity and online/scheduler assumptions. Earlier full outcomes (including 491/18 and 508/1) remain, along with subsequent successful runs.
- Late scope pagination required an explicit loop-page type (TS7022). The scale-test spy required pg multi-statement result normalization without weakening row/byte assertions.
- One known-incoherent aggregate was deliberately stopped by exact owned container ID after those failures were known. `all-superseded.json` and live output document the interruption; it is not a timeout/full result. A coherent final aggregate was then attempted once.
- Final aggregate exposed stale idempotency/cancel-signal fixtures, real already-aborted error normalization, and retry tests assuming immediate failure. The complete frontend suite now passes with bounded retries driven by fake time rather than increased deadlines.
- Initial scalar-age fixtures attempted immutable creation-time and illegal staging-to-deleting changes; database guards correctly rejected them. The final proof uses real abort fencing, the legal transition and actual elapsed age.
- Final browser timing failures and the unsuccessful intermediate fixed-two-read assumption are documented separately above; current implicated fixtures pass together.

## 8. Source, migration, image and cleanup identity

`baseline.json` captured 770 entries before edits, including 38 inherited tombstones. The expanded manifest has **829 entries/791 present**: **59 changed existing paths and 12 actual new phase05 source/test/tool files**; 47 other pre-existing infrastructure/plan files were merely added to the inventory, not created by this phase. This completion is the intentional final Markdown addition.

Principal new files: `dataLifecycleSchema.ts`, `lifecycleSlice.ts`, `dataLifecycle.test.ts`, `dataExportLifecycle.test.ts`, `dataMetrics.ts`/test, `backupInventory.ts`, `largeTenantRestore.test.ts`, frontend `api/reportData.test.ts`, `ReportExportButton.test.tsx`, browser `largeTenantData.spec.ts`, and `scripts/large-tenant-lifecycle.ps1`.

Changed roots:

- **Backend DB/services/routes/server/types:** lifecycle/progress, inventory/report GC, staging, leases/quotas, recovery, selected ownership/export lifecycle/audit and low-cardinality observations.
- **Backend scripts:** streaming backup/review, restore proof, fixture selectors, synthetic auth and compiled restart harness.
- **Frontend API/components/tests/browser:** idempotent retries/cancellation ownership, export UI and exact request fixtures; browser tenant/readiness/keyboard/geometry synchronization.
- **Root/scripts:** guarded installed-dependency reuse, exact isolated matrix and diagnostics-first teardown. Existing deploy gate logic/limits remain unchanged.
- **Docs:** operations, security model, deployment setup and record-data foundation. **No new deletions**; all 38 inherited deletions, including the ten accepted inventory removals, remain absent.

Receipt chain is append-only: `qualified-source.json` → `source-final-overlay.json` → `source-repair-overlay.json` → `source-observability-overlay.json` → `source-verified-final.json` → `source-browser-focus-overlay.json` → `source-filter-fixture-overlay.json` → **`source-fixture-qualified-overlay.json`** (SHA `fd5dc807a4ef0f927e3c4d719b99979605c3381c84722efec20b98eaf82a6ffa`). Earlier receipts were not silently updated.

`completion-source-overlay.json` records only this final Markdown addition after source verification; it adds no application or test-code delta.

`verified-final-image-source.json` independently verifies:

- Checked-in-target operator `sha256:3c895ccf8f38739318f0079e1f3958b25a1923fd9bcfbdda138620fce7216050`.
- Passed compiled runtime `sha256:6aad41bd4926b9cd4a36f0e70c29b0b5a07c390fb7f23c170bab4cddb292e009`.
- Checked-in-target browser `sha256:fc4f0a7a65aed2bf13f69eca117e970d8cf4f894b73fcbffb789ff8710583f4d`.
- Passed final-app unfiltered browser `sha256:f294f99f4edbb6484273fc5aae20ee09810e2f692904001f63055283769907ff`.
- Final focused source image `sha256:69fe35ae685bde1216423c6612edb1100149a51e798affac03e7d8224fb76b9a`.

For the checked-in-target operator/browser, the only final source differences are the **two explicitly hashed browser-spec repairs** (`agentFilters.spec.ts`, `largeTenantData.spec.ts`). The focused source image matches all 743 compared entries. Rebuilding backend from the checked operator matches all **204 runtime compiled files**; all **four frontend compiled files** match both checked browser images and the passed runtime. Thus application bytes agree; whole-image equality with host orchestration/plans or the last test overlays is **not** claimed.

All **74 frozen executable migration hashes** match `phase04-acceptance-repair-migrations-final.json`, including composed strings. Migration 74 remains `ab8d8d101426a17d1589f5a399a7ff5d57c7baea5b03c6918885024f4dc1d9ce`; only forward migration 75 was added, hash **`26fda951b402de9645f307cf49b7552030718e8a4efd2c19dcf81721e62ede73`**. See `frozen-migrations-verified-final.json`.

`cleanup-boundary-verified-final.json` independently audits **46 owned projects**: **zero remaining owned containers/networks/volumes**, no observed OOM, 23 protected documents/manifests unchanged and 38 tombstones preserved. Three protected image IDs remain exactly unchanged. Candidate images and requested evidence remain intentionally available for parent acceptance; no global prune or retained-resource cleanup occurred.

Limits remained Node **1,536 MiB**, V8 old-space **768 MiB**, PostgreSQL **1,024 MiB**, disk-backed owned PGDATA/WAL/temp, no host ports. Maximum sampled project memory peaks were 323,690,496 bytes for final restart, 1,289,121,792 bytes for the final-app browser run and 1,114,869,760 bytes for the final focused run. These are sampled evidence, not a claim of exhaustive short-process peak capture or 06 capacity qualification. Exits, live/final states, OOM, cgroup samples, mounts, image IDs and DB cleanup precede resource removal.

## 9. Operations and explicit continuation

Operations documentation provides exact `Retain`/dry-run, recovery, isolated restore, root fixture and diagnostics-first cleanup commands. Persistent SQL counters support investigation; `data_lifecycle_metrics` has only six fixed stage labels and bounded numeric maxima. `record_gc.backlogRoots` is an exact scalar count of deleting/uncollected generation roots; `oldestAgeMs` is their oldest creation age, not time since eligibility. Protected/current roots and every physical child/history set are not falsely included in that number. No identity/payload/token labels are emitted.

| Residual / owner | Repair, containment, numeric signal and exact trigger |
| --- | --- |
| **Full software-gate cost — 07** | Independent backend remains incomplete at 600,031 ms; historical actual unchanged gate was 0/5 at 180 seconds, with four commands not run and no OOM. Diagnose per-file fixture/SQL/teardown costs, repair the actual cause and retry the checked-in `Invoke-LocalSoftwareChecks` path. Do not raise deadlines/RAM, add backend parallelism/skips, shrink cardinalities or substitute this focused/independent evidence. Required signal: actual unchanged **5/5** plus clean teardown before reset/deploy. A refusal leaves campaign `blocked_safety_check`, not permission to bypass. |
| **Final exact browser-wrapper uniform receipt — 07; reuse during 06** | Final application bytes have a 509/9 unfiltered pass; later full repeat failed one fixture timing assertion, now repaired and covered by the 22-case focused pass. Run `pwsh -NoProfile -File ./scripts/large-tenant-tests.ps1 -Suite browser` with the final two fixture overlays before deployment qualification. Target: four focused and 509 unfiltered passes, zero unexpected/flaky cases, only nine pre-existing skips, clean teardown. Diagnose any failure; do not add sleeps/deadline increases/skips or report the mixed receipts as one green wrapper. |
| **Capacity — 06, final acceptance 07** | Correctness/bounds are implemented; 100k users/source agents and one million relationships are **not qualified here**. Execute planned owned synthetic capacity fixtures with unchanged budgets and 120-second/5,000-target, 15-second inventory-export and 60-second/30,001-user assertions. Preserve admission/storage ceilings; halt affected admissions if any bound fails. |
| **Lifecycle live signal — 07 fix-forward** | Retain maintenance/provider/capability/job containment until verified. Trigger on any committed slice above 1,000 rows/1,048,576 bytes/5,000 ms, queue above 32, ownership beyond 60 seconds without renewal, or eligible unpinned work with no progress over two cursor traversals. Capture redacted counters/leases/images/OOM first; repair, run focused proof, redeploy officially and canary. Never replay uncertain mutations or globally purge another principal. |
| **Production convergence — 07** | No 05 production action occurred. Reverify the physical `seha` identity/configuration and preserve secrets/settings/backups before the already-authorized initial `pwsh ./deploy-local.ps1 start -Project seha -DbReset`, only after the real software guard passes. Observe localhost:3002 and fix forward via official redeploy, not a second reset. This phase is not test-only campaign completion, production readiness or a NO-GO termination. |

Existing lint hook warnings and the Vite chunk-size advisory remain nonzero-warning/zero-error successful checks; they were not hidden by changed rules. 06 receives functioning lifecycle/retention/export/restore tooling and reproducible diagnostics, not a claim that full capacity, the real deployment gate or production convergence already passed.

## 10. Parent acceptance review: not accepted; bounded repair required

The preceding worker proposal is not parent acceptance. Phase05 remains
`in_progress`, with six of nine campaign phases accepted and 06-07 pending.
Parent independently passed the exact lifecycle selector: **379 backend /
410 frontend**, backend typecheck and frontend lint, including the real
104-table consistent-snapshot backup/guarded restore and readiness
**503 -> 200** while provider work remains disabled.

Parent also completed the previously missing uniform browser wrapper:
**four focused and 509 unfiltered passed, nine pre-existing skips, exit0**.
See `artifacts/phase05/parent-uniform-browser-verification.log` and owned
project `agent-control-ltdp-f935575c8c564f27a2ecdcaa50ba1c2b`. Its receipts
record no failures, zero remaining DB connections/databases; independent
exact-label inspection found zero remaining containers/networks/volumes.
This closes the browser-wrapper residual above for the pre-repair source,
not the original software-gate debt or the defects below.

Parent verified the final 830-entry manifest (792 present, 38 tombstones),
23 protected inputs, all 46 worker-project cleanup boundaries and three
protected image identities. All 75 compiled executable migration checksums
agree; migrations1-74 remain frozen and migration75 has the recorded hash.
Preserve all 1-75 during acceptance repair; append a migration if necessary.
Parent ledger/completion additions are intentional documentation deltas after
the immutable worker receipts, not requalified application bytes.

Completed reviewer `a8ca3f32-353e-49a5-a7b7-100090820417` reported four concrete
defects. Parent inspected the implicated predicates and call sites. Each
requires a real failing-then-passing regression through legal API/DB states:

| Finding | Repair and discriminating proof required |
| --- | --- |
| Accepted report staging escapes shared cleanup budgets | `backend/scripts/database.ts` omits accepted staged children from draining and permits parent removal before all children are empty. Drain both representations child-first, retain cleanup/reservation ownership until safe, and measure all affected relations/cascades for an aged accepted staging with 5,000 children. Every committed slice must remain at most 1,000 rows/1 MiB/5 seconds; published and peer-tenant reports must survive. |
| Package recovery omits revision-trigger writes | `backend/src/db/jobs.ts` updates recovered items separately while each item update rewrites the parent job through `job_results_update`. A valid 64-target access confirmation can carry a 31,007-byte summary, making repeated parent writes alone exceed 1 MiB. Account for the actual trigger effects or change the bounded update shape; measure items, jobs, attempts and audits, preserving result revisions/cursors and outcomes. |
| Removed ingestion provenance strands abandoned versions | `backend/src/db/officialReportMaintenance.ts` requires ingestion metadata to retire/delete unreferenced versions, but operator retention can remove it first. Reproduce interrupted acceptance after a committed copy batch, expire/remove its ingestion metadata, then prove payload/quota convergence without deleting active acceptance, set/history/selection/export references or shared facts. |
| Explicit quarantine resume recovers the wrong job | The resume route calls tenant-wide recovery before checking the requested job/principal. Scope explicit recovery to the authorized requested job, separate from background sweeping, and preserve bounded multi-slice progress. With older A and newer B, resuming B must not modify A or another principal; foreign/nonexistent IDs must cause no recovery side effects and GETs remain read-only. |

These are implementation acceptance gaps, not `complete_with_risk`
qualification residuals. Launch one fresh GPT-6 Astra/xhigh repair worker for
these four findings and directly coupled contracts only, then perform parent
acceptance. No production action or phase06 launch is authorized by these
passing focused/browser results.

## 11. Bounded acceptance repair — four findings repaired, parent acceptance pending

This section supplements, and does not replace, sections 1–10 or their
historical qualification failures. No campaign ledger, migration, dependency
manifest, deployment configuration, protected image, production resource,
branch or commit was changed. No worker was delegated. HEAD remains
`7e2be0b6b844bd538dbdd15f3e8261ea0fc6aeb6`.

### Hypothesis, baseline and legal reproductions

**Falsifiable hypothesis:** counting the actual committed row changes, rather
than selected parent/item counts, will expose an accepted-preview cascade and
repeated job-revision writes above 1 MiB; removing ingestion provenance will
leave unreferenced report quota; an unauthorized explicit resume will change
an older job. The cheapest discriminating check was the two-file
`lifecycle-acceptance` selector in the checked-in owned fixture runner.

`artifacts/phase05/acceptance-repair-baseline.json`
(`8c06f7a4171b15bd9a372f3856c9369dea750bc16ccf4ff5f474d7b2058364a2`)
verified the immutable source chain and included the parent's intentional
ledger/section10 additions. Its 830 entries retained all 38 tombstones.
A pre-existing `.azure/deployment-plan.md`, outside that inherited manifest,
was neither changed nor silently added to the campaign source inventory.

The decisive pre-repair receipt is
`artifacts/phase05/acceptance-repair-guarded-before.log`: **four failures,
three passes**. It demonstrated:

* Actual import/accept of 5,025 CSV users leaves 5,000 preview rows after
  normal 25-row cleanup. A later operator transaction changed **5,254 rows /
  1,902,660 encoded bytes**, including cascades.
* Actual acceptance was interrupted after a committed 50-row copy. After
  ingestion metadata disappeared, quota remained **151 rather than 1**,
  version rows **51 rather than 1**, and facts **50 rather than 1**.
* A legal 64-target access confirmation generated by the actual confirmation
  and submission functions caused **130 row changes / 2,371,260 bytes**
  during recovery. The observer included every repeated parent `jobs` write.
* A real same-origin, CSRF-authenticated resume request for a nonexistent or
  foreign ID changed another principal's older expired job/attempt.

No immutable upload guard or legal quarantine target limit was weakened.
Collector-only SQL clock advancement models expiry without editing immutable
ingestion timestamps. The accepting transaction is paused at the second copy
batch to prove a live lease protects its first committed batch. Tests use
real PostgreSQL repositories, importer guards, sessions and HTTP middleware;
only provider/capability availability and the final mutation-launch boundary
are synthetic. The test-only observer records transaction/relation/encoded
row length, not stored payload copies, in a separate disposable schema.

### Root repairs and coupled contracts

1. **Child-first report cleanup.** Shared predicates in
   `backend/src/db/officialReportRetention.ts` are consumed by operator
   `backend/scripts/database.ts`, runtime `officialReportImports.ts` and
   operator `officialReportMaintenance.ts`. Accepted preview children now
   drain through the same `LifecycleSlice` as ingestion children. Stored-byte
   reservations remain until **both** representations are empty; ingestion
   and staging parents independently require child emptiness. Version parents
   also require no remaining version rows. No second cleanup owner, giant
   materialization or uncharged child cascade was introduced.

2. **Trigger-inclusive package recovery.** `backend/src/db/jobs.ts` charges
   each recovered item for its full parent job rewrite, actual unfinished
   attempt/audit row sizes and bounded scalar growth, and reserves the two
   parent settlement writes. Its cumulative prefix uses the shared row/byte
   ceilings and the existing 768 KiB recovery limit. The old result-revision
   trigger is unchanged. Tests recreate repositories between slices, retain
   immutable target/prestate/authority fields, invalidate an earlier result
   cursor and preserve revision progress. Both 64 expired queued targets and
   64 actually started attempts converge: four sent targets become
   inconclusive; sixty unsent targets require reauthorization. All 64 attempts
   and audit outcomes settle without replaying mutation.

3. **Provenance-independent orphan retirement.** A version without set
   membership is collectible independently of retained ingestion metadata;
   unexpired active/ready ingestion still protects it. Operator retention
   retires an orphan before removing its ingestion provenance. Fresh payload
   collectors can then retire/drain it even after provenance is gone.
   Published/history/read/export references remain protected by the existing
   membership/pin contracts. The interrupted acceptance regression verifies
   live accepting and ready protection, metadata removal, stale acceptance
   denial, zero abandoned payload/reservation/quota, and survival of a shared
   fact used by a published version. Accepted/history and peer-tenant report
   contents are compared before/after cleanup.

   Wider retention qualification exposed a directly coupled convergence
   defect: `retainUntilConverged` could report completion at the end of a
   resumed partial tenant traversal without visiting a newly deleted tenant
   behind its starting cursor. A deterministic failing regression retained
   **one set / three versions / three artifacts**. The helper now requires a
   complete quiet traversal after reaching a cursor boundary. Each call
   remains its own bounded transaction; the existing 1,000-pass ceiling is
   unchanged.

4. **Authorized, exact quarantine resume.**
   `backend/src/routes/copilotStudioQuarantine.ts` looks up the requested
   tenant/principal job **before** recovery. Repository `recoverJob(scope,id)`
   recovers that exact job; `recoverInterrupted(tenantId,processStart)` remains
   the separate bounded background/startup sweep. A request performs only one
   slice, re-reads the job and launches only the authorized requested ID.
   The legal maximum is 25 targets (the test rejects 26); the real 25-target
   job converges without a fabricated oversized job or an unbounded request
   loop. Older A belongs to another principal, newer B is requested, and a
   foreign-tenant job also exists. Missing/foreign/other-principal IDs return
   404 without recovery writes; B returns 202/resumable, A and foreign data
   remain byte-equal. GETs remain read-only, and active leases/background and
   startup recovery retain their separate tests.

Two older retention-test assumptions were corrected, not production guards:
`officialUsage.test.ts` now explicitly verifies that the selection is denied
after its history epoch changes, tests physical pin protection with
`retainDeletedReportRows`, and tests full-retention dry-run rollback.
The original 251/0/250/1/0/251/0 cardinalities remain. `agentUsage.test.ts`
positions the persistent operator cursor at the tested tenant's actual turn
instead of assuming the next global slice visits an arbitrary tenant.
Neither dataset size, deadline nor final zero-payload assertion was relaxed.

### Final committed-write evidence

`artifacts/phase05/acceptance-repair-serial-related.log` records every affected
public relation, including cascades, repeated revision-trigger parent writes,
attempts, audits and progress metadata. Encoded bytes are the larger OLD/NEW
row JSON representation for each individual change, accumulated per
transaction—not current table size or item count.

| Real scenario | Committed transactions | Maximum rows | Maximum bytes | Maximum observed write span |
| --- | ---: | ---: | ---: | ---: |
| Accepted staging drain | 20 | 508 | 221,310 | 71.267 ms |
| Interrupted acceptance/orphan cleanup | 41 | 310 | 136,167 | 23.524 ms |
| 64 expired queued package targets | 4 | 39 | 718,019 | 31.809 ms |
| 64 started package attempts | 4 | 73 | 709,513 | 45.024 ms |
| Exact 25-target quarantine resume, including session transaction | 2 | 52 | 50,859 | 5.254 ms |

Every observed committed transaction satisfies 1,000 rows / 1,048,576 bytes.
The observer's time is first-to-last physical write, not a claimed measurement
of pre-write transaction time; existing PostgreSQL transaction/statement
timeouts and bounded recovery deadlines enforce the 5,000 ms transaction
ceiling. Ordinary record batches, residual JSON bounds, selected
REPEATABLE READ, durable leases/epochs and inventory final-dispatch fencing
were not changed.

### Qualification, including failures rather than success-shaped substitutions

All suite commands use
`pwsh -NoProfile -File ./scripts/large-tenant-tests.ps1 -Suite <selector>`.
The following files are under `artifacts/phase05/`; command receipts contain
the exact underlying npm selectors, elapsed times, exits and signals.

| Selector / receipt | Actual result |
| --- | --- |
| `lifecycle-acceptance`, `acceptance-repair-final-focused.log` | **8 passed**, backend typecheck passed |
| `lifecycle-acceptance-related`, `acceptance-repair-serial-related.log` | **391 passed in 17 files**, backend typecheck passed; 67,442 ms test command |
| `lifecycle`, `acceptance-repair-serial-lifecycle.log` | **379 backend /410 frontend passed**, backend typecheck and frontend lint passed; backend81,119 ms /frontend101,502 ms |
| `restart`, `acceptance-repair-final-restart.log` | Fresh compiled candidate passed actual seed/crash17/expire/recover flow, readiness200, stale-owner fencing and no mutation replay |
| `browser`, `acceptance-repair-browser.log` | Worker-owned exact wrapper finished exit0: **4 focused +509 unfiltered passed /9 existing skips**; both fixture checks passed |
| `all`, `acceptance-repair-aggregate.log` | Literal **4/5**: backend **600,126 ms timeout**, SIGTERM/ETIMEDOUT; frontend **2,393 passed**; types/lint/build passed; no OOM |
| `python3 artifacts/phase05/acceptance-repair-final-verify.py` | Fresh final operator build, compiled/source/migration/browser-byte comparison and protected-image checks passed |
| `python3 artifacts/phase05/acceptance-repair-final-audit.py` | 22 owned projects clean; source chain, unchanged HEAD, whitespace and qualification audit passed |

The actual 104-table backup/snapshot/guarded restore is in the final lifecycle
receipt: snapshot consistent, runtime grants true, providers disabled,
readiness **503→200**, source and separate restore target guarded, restored
content fingerprint
`b0ef70e5279a02dbeeacb4c596993696688718ba06cf655d1fdfbe7f65d205fe`.
Editor diagnostics for every changed TypeScript file and `git diff --check`
are clean.

Failure history is retained:

* `acceptance-repair-before.log`: 4 failed/2 passed; the initial route fixture
  lacked the required Origin, and the background test reused another test's
  tenant. Legal same-origin headers and distinct fixture ownership repaired
  those fixtures, not middleware. `four-before` and `guarded-before`:
  4 failed/3 passed. Initial repaired `after`:7 passed; `expanded`:8 passed.
* Initial `related`:348 passed, initial `lifecycle`:379/410 passed and initial
  compiled restart passed. These do not replace the later wider results.
* The aggregate also surfaced three report-retention assertions before its
  backend timeout. Wider `report-regressions`:2 failed/389 passed;
  `retention-diagnosis`:1 failed/384 passed. Exact epoch/cursor counterevidence
  and the real resumed-traversal defect led to the fixes above.
* `cursor-before`:1 failed/390 passed, with the deterministic retained
  set/version/artifact counts above. After the convergence fix,
  `converged-related`:1 timeout/390 passed at the unchanged 5-second test
  deadline. Concurrent `converged-lifecycle`:1 failed/378 backend passed,
  410 frontend passed, plus an automatic-refresh afterAll timeout.
  These ran while the full browser fixture was active.
* After that browser completed successfully, the unchanged final candidate
  was qualified **serially**:391 related and379/410 lifecycle passed, including
  the previously failing automatic-refresh completion and hooks. No refresh
  runtime, deadline, resource allocation or parallelism setting was changed.
  The overlap is observed; contention is not presented as a proven root cause.
  The failed runs remain evidence, not deferred broken targeted regressions.
* The first Node-only image proof exposed its PostgreSQL base image's
  automatically declared anonymous volume. Exact ownership/attachment and
  stopped-container diagnostics were recorded before removing only that
  container and its sole anonymous volume. Subsequent proofs explicitly use
  a run-owned disk bind; the failed proof and cleanup receipt are preserved.

The new aggregate is **not** a green software gate. The original actual
`Invoke-LocalSoftwareChecks` remains historical **0/5** at its unchanged
180-second backend deadline; the other four commands were not reached.
The earlier worker's3/5 aggregate also remains historical. Narrow passes
cannot retroactively rewrite any of those receipts. No repeated600-second
aggregate, raised deadline/memory, reduced fixtures, altered gate, backend
parallelism change or implicit package installation was used.

### Source/image/migration integrity and cross-root ownership

Append-only source chain additions:

* Initial repaired runtime: `acceptance-repair-source.json`,
  `981933e120b7bcc5d5a6823d52b7caa36383478c97f0c5574c7b4e228ac8ab8d`.
* Final convergence/test/docs overlay:
  `acceptance-repair-convergence-overlay.json`,
  `beab231c575c06090c1297f0a0f24f6f90c469cd08c260792b5cccfb0b2d72ee`.
* Qualification/cleanup: `acceptance-repair-qualification-overlay.json`,
  `c27a8a73355b1435031d12f766710dd7ffae3d41847250fb8cef4d7c1d3a9d49`.
* Actual final image comparison: `acceptance-repair-final-compiled-proof.json`,
  `77a319b090dfc9147ea7e3f6b531002832d97c6d8cb03ecdc1d7a67e0ad3b0c4`.
* A subsequent `acceptance-repair-completion-overlay.json` records this
  appended completion and final closed-log hashes without rewriting any
  source or qualification receipt.

The final runtime manifest contains **833 entries /795 present /38 inherited
tombstones**, with16 changed paths from the repair baseline (three new source
files). The completion appendix adds one documentation delta only.
Final source comparison verified746 image-source entries,205 compiled backend
files and4 frontend assets. All75 **actual compiled executable migration**
checksums—including composed SQL—match the frozen receipt. Migration75 is
`26fda951b402de9645f307cf49b7552030718e8a4efd2c19dcf81721e62ede73`;
no76 or persistent table/grant/backup-inventory addition was needed.

Fresh final restart project:
`agent-control-ltdp-e25960a2a28c4000b6e2914fdc09d545`.
Its image identities are:

* operator `sha256:aa22bcac31d7c7d6d4c024b18bdd29e22087b42de3a7e3934ee32381043cc03d`
* runtime `sha256:1d5c6f38dc7340e98d8c5e82dd47dd7c0635b5e71a314b8faea1b855209b3730`
* browser runner `sha256:ed62f67df7473bc64ad2aaf25bb906a37b1cd3586e4feec1547268f52fde0888`

The successful browser run belongs to
`agent-control-ltdp-49413b9b27fd4249877042eed1adb63b`, not the parent's
pre-repair browser receipt. Its runtime image
`sha256:0cf5aed4b78a395ef430592a91d80bed70327da8fc17883fe8c1a50270963972`
has exactly the same205 compiled backend files and4 frontend assets as the
final candidate; frontend/browser fixture source equality was also checked.
The later operator convergence, test and documentation overlay is separately
qualified; whole-image equality is **not** claimed.

Cross-root producer/consumer accounting:

* **backend/**: importer/reservation cleanup → shared staging/orphan
  predicates → operator retention/payload collector; job item recovery →
  unchanged revision trigger/attempt/audit outcomes → result cursor;
  authenticated resume route → exact scoped repository → existing launcher.
  Tests cover these flows plus history cursor/pin consumers. Fixture selector
  and physical-write observer are test infrastructure, not runtime schema.
* **scripts/**: only the two owned acceptance-selector names were added to
  `large-tenant-tests.ps1`; the existing fixture implements their explicit
  files. Runtime/browser/restore wrappers and safety gates remain unchanged.
* **docs/**: `official-reports-foundation.md` documents shared child/reservation
  and orphan ownership; `operations.md` documents bounded exact resume,
  trigger charging, quiet-cycle convergence and qualification commands.
* **frontend/**: no edit needed. Response/status/cursor contracts are unchanged;
  the existing resume UI consumes the correctly authorized202/409 response.
  Full2,393 frontend tests,410 lifecycle tests, lint/build and actual browser
  application-byte comparison cover its consumers.
* **Root build/deployment config**: no edit needed. No dependency, schema,
  deployment contract or resource-limit change is required. Approved `.npmrc`
  and manifests were hash-preserved; images reused already installed approved
  dependencies with network-none builds. All three protected image identities
  remain exact. The parent ledger remains untouched.

### Ownership cleanup and remaining phase07 gate-cost debt

Final independent exact-label inspection found **zero remaining containers,
networks or volumes across all22 worker-owned projects**. Forty-five fixture
container state files have captured log/cgroup/mount evidence; none recorded
OOMKilled. Runtime/browser fixtures additionally recorded SQL
**zero remaining owned databases /zero connections** before resource teardown.
Ordinary test fixtures closed guarded child databases; disappearance of their
exact PostgreSQL containers and sole owned data volumes proves the physical
database/connection boundary is gone. No retrospective SQL count is invented
for wrappers that do not emit it. The first proof's exact anonymous volume
`9e02ad815f78b9a2388364e7c428af61796fc4644986d94b844f856a36cc189b`
is independently absent. Node-only image proof containers never started
PostgreSQL; their configured limits/exit/OOM/mount inspections are retained.

Fixtures used internal networking/no host ports, synthetic credentials,
disk-backed PostgreSQL data/WAL/temp and unchanged Node1536 MiB /
V8oldspace768 MiB /PostgreSQL1024 MiB limits. There were no retained
configuration/secret mounts, external provider mutations, global prune,
name-based termination or production actions.

**Residual scope:** original full-software-gate runtime/cost qualification,
not an unrepaired targeted lifecycle regression. **Containment:** the official
gate still refuses promotion; no reset/deployment bypass or unsafe admission
change occurred. **Signals and numeric alerts:** any180-second original
backend timeout,600-second phase aggregate timeout, nonzero test exit/OOM,
or slice above1,000 rows/1,048,576 bytes/5,000 ms is a blocking signal.
**Owner/action:** phase07 must repair actual suite cost/root behavior, then
obtain unchanged5/5 and clean owned teardown before its authorized production
continuation. Reproducible functional failures require fix-forward and exact
reruns, not timeout increases or narrow-result substitutions.
**Evidence:** aggregate and original receipts remain literal, with the final
targeted/source/cleanup overlays attached above. This worker neither accepts
phase05 nor launches06/07; the parent performs independent acceptance.

## 12. Final parent acceptance

**Accepted `complete_with_risk` after independent verification.** All four
review findings and the directly coupled retained-cursor convergence defect
are repaired; no targeted lifecycle defect is carried as qualification risk.
Seven of nine campaign phases are accepted.

Parent inspected the actual cleanup/orphan/reservation predicates, the
trigger-inclusive recovery budget, exact scoped resume, cursor convergence
and physical-write regressions. Parent reran the combined
`lifecycle-acceptance-related` selector: **391 tests in17 files and backend
typecheck passed**, exit0,69,058ms test command. See
`artifacts/phase05/parent-acceptance-repair-verification.log`.

Independent maximum committed rows/encoded bytes were:

| Scenario | Rows | Bytes |
| --- | ---: | ---: |
| Accepted staged children | 508 | 221,309 |
| Interrupted acceptance/orphan | 310 | 136,169 |
| Expired queued package targets | 39 | 718,022 |
| Started package attempts | 73 | 709,494 |
| Exact scoped quarantine resume | 52 | 50,889 |

These include all public-relation changes, cascades, revision triggers,
attempts, audits and progress metadata. The observer's first-to-last write
span is not misrepresented as full transaction time.

Parent verified **833 source-manifest entries/795 present/38 tombstones**,
the14-record base chain and final completion overlay
`1f7be3dc76020ac20bbe3fdabcb6a853689f2acdc1046550c98a0b9ee3b7698f`.
Parent executed the final compiled runtime independently and reproduced all
**75 frozen migration checksums**; receipt
`artifacts/phase05/parent-acceptance-repair-migrations.json`. No new migration
was needed. All22 repair projects and the independent parent test/proof
resources are clean; three protected image identities, all nine prompt
hashes and diff whitespace checks passed. This parent appendix and ledger
update are intentional documentation additions after the worker overlay.

The final serial lifecycle/restore/restart/browser/frontend/build evidence
and its source distinctions in section11 are accepted as recorded, not
retroactively combined into a different full-suite receipt. The latest
aggregate remains **4/5 with backend600,126ms timeout**; the original actual
gate remains historical0/5 at180seconds. Phase07 must repair its real cost and
pass unchanged5/5 plus cleanup before promotion. Phase06 now owns measured
capacity qualification. No production reset/deployment or commit occurred.
