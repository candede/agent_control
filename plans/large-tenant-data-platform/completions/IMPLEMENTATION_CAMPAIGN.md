# Large-tenant data platform implementation campaign

## Campaign identity and current state

- Repository: `/Users/candede/repos/agent365/agent_control`.
- Application roots: `backend/`, `frontend/`, `scripts/`, `docs/`, root build/deployment configuration.
- Plan folder: `plans/large-tenant-data-platform`.
- Starting commit: `7e2be0b6b844bd538dbdd15f3e8261ea0fc6aeb6`.
- Starting application worktree was clean. Parent subsequently added approved-feed `.npmrc` and `AGENTS.md`; preserve them.
- Status: `complete_with_risk`; actual`seha`deployment,one authorized application-DB reset and thirty-minute live observation are complete and independently accepted. All nine manifest dispositions are resolved:eight accepted phases and user-curtailed06(not capacity-qualified). Protected real-data validation remains auth/data limited. No implementation worker remains active.
- Original phase 01 worker: `03390c13-8939-4b55-b41a-b7dfade11532` (`scale-phase-01`), GPT-6 Astra/xhigh, returned its implementation and completion record. Parent review identified a bounded read-isolation repair before acceptance.
- Phase 01 repair worker: `6e96693d-2f13-4c38-8465-c010e811874d` (`scale-phase-01-isolation`), GPT-6 Astra/xhigh, completed and accepted with the aggregate residual below.
- Phase 02 worker: `397eacb7-78ae-43ee-9f98-0720d1957a33` (`scale-phase-02`), GPT-6 Astra/xhigh, completed and accepted.
- Phase 02A worker: `5b4fce78-c7e3-4910-886d-ea1958550049` (`scale-phase-02a`), GPT-6 Astra/xhigh, completed and accepted with the original-gate deadline residual below.
- Phase 02B worker: `1bb8f434-7b00-4473-b5c0-00f0d1c32ae7` (`scale-phase-02b`), GPT-6 Astra/xhigh, completed and accepted after the bounded repairs below.
- Bounded read-only frontend acceptance reviewer: `51a61fcb-28ee-4d4c-ba76-a73fb2d39038` (`scale-02b-ui-review`), GPT-6 Astra/xhigh, completed with three reproduced UI defects, all now repaired and independently verified.
- Bounded 02B repair worker: `3ebf2a06-79f9-4391-a681-10531b989e0d` (`scale-02b-ui-repair`), GPT-6 Astra/xhigh, completed; no active repair worker.
- Phase 03 worker: `a273a678-6cd9-4bd2-ae06-d2cce6232a9c` (`scale-phase-03`), GPT-6 Astra/xhigh, completed and accepted after the bounded repair below.
- Read-only phase 03 temporal/canonical/query reviewer: `f87747c2-beec-4f8c-87c5-ae4eaa5d9c42` (`scale-03-temporal-review`), GPT-6 Astra/xhigh, completed; findings are resolved with reproduced/disproven distinctions retained.
- Bounded phase 03 repair worker: `9faff7d2-cdb7-46c2-8018-e00d1b99f37c` (`scale-03-bounded-repair`), GPT-6 Astra/xhigh, completed and accepted. No repair worker is active.
- Initial phase 04 worker: `ad8a29ba-b9fa-4600-bace-9d6bb9811883` (`scale-phase-04`), GPT-6 Astra/xhigh, returned an explicitly incomplete job-metadata/result-page slice. That historical handoff was not accepted; the subsequent continuation and repair below completed phase04.
- Phase 04 continuation worker: `1f8f1df3-03b9-43c4-ac3f-53d75f48c36b` (`scale-04-cutover-continuation`), GPT-6 Astra/xhigh, returned the full cutover with explicit validation-cost residuals; parent review found five bounded correctness defects before acceptance.
- Read-only phase 04 acceptance reviewers: `340dbe52-dca7-4125-baa1-6f4f6c77bd81` (current-control/staged-target correctness) and `1c0957c1-9c3b-43cb-a24c-852f053d9062` (inventory UI/API ownership), both GPT-6 Astra/xhigh, completed. Parent owns independent validation, integrity and acceptance.
- Bounded phase 04 acceptance-repair worker: `4c1a2900-92e9-49ab-8de0-81c14cb39d55` (`scale-04-acceptance-repair`), GPT-6 Astra/xhigh, completed and accepted after parent verification. All five findings are repaired.
- Phase 05 worker: `da8361c0-62ed-421b-bfe3-cb879e3a22ed` (`scale-phase-05`), GPT-6 Astra/xhigh, returned lifecycle/restore/restart/browser implementation; its concrete acceptance gaps were closed by the repair and parent verification below. Phase05 is accepted `complete_with_risk`, carrying only explicit qualification debt.
- Read-only phase05 lifecycle reviewer: `a8ca3f32-353e-49a5-a7b7-100090820417` (`scale-05-lifecycle-review`), GPT-6 Astra/xhigh, completed with four concrete lifecycle/recovery findings. The subsequent repair and parent acceptance below resolved these original findings.
- Bounded phase05 acceptance-repair worker: `92560d5d-2d6d-471a-bbfc-bf5f66fb5476` (`scale-05-acceptance-repair`), GPT-6 Astra/xhigh, completed all four findings and directly coupled retention convergence; independently verified and accepted by parent.
- Phase06 worker: `9c710182-d51b-413d-b8d7-b29fbfb543ad` (`scale-phase-06`), GPT-6 Astra/xhigh, now confirmed idle/concluded; all queued stop messages were processed and its frozen handoff verified. No further synthetic capacity campaign is authorized.
- Phase07 worker: `7d4e5d66-8d25-4029-affc-46e044aaf19f` (`scale-phase-07`), GPT-6 Astra/xhigh, idle/concluded after a bounded safety-repair attempt. Migration89/count/grant/restore proof returned; actual deployment gate, fresh-installation runner/proof and rollout remain incomplete.
- Phase07 remaining-rollout worker: `c837f34d-3935-4979-8467-835379e6cfd7` (`scale-fresh-rollout`), GPT-6 Astra/xhigh, completed and independently accepted. Actual fresh Deploy/restore/restart,production five-step gate,single DB-only reset,rollout and live observation are complete. No capacity campaign was resumed.
- Model for every worker/reviewer: **GPT-6 Astra, xhigh**, explicitly requested by the user, overriding the skill default.
- Implementation workers run sequentially with a fresh context per phase. No nested implementation delegation, commits, pushes or branches.
- Parent is integration/decision owner. Read this ledger and the exact phase completion record before resuming; changed prompt hashes require revalidation.

## Ordered manifest

The denominator is **nine phases**. The displayed order, not filename sorting, is authoritative.

| Step | Prompt | SHA-256 | Depends on | Completion record | Status |
| --- | --- | --- | --- | --- | --- |
| 01 | [Record foundation](../01-record-foundation.md) | `c7901d936deb5153572361c2c13cae7c10b7477e0f04669bce0a9cc213828531` | Plan validation | `01-record-foundation.md` | complete_with_risk |
| 02 | [User-source foundation](../02-users-and-reports-cutover.md) | `9465883027e128ab7f772cae6deb77c222e7f5f08b81496b888464afb629aec6` | 01 | `02-user-sources-foundation.md` | complete |
| 02A | [Official reports foundation](../02A-official-reports-foundation.md) | `65ec3a90a9f79bc604caf9102f4f284ade047843a9c8020161a29267cd02cb01` | 01, 02 | `02A-official-reports-foundation.md` | complete_with_risk |
| 02B | [Users/reports atomic cutover](../02B-users-and-reports-cutover.md) | `c159a1b72d2212d6704ebb74db63db627b9ba7459e8d764ef7ab8fc7480156c8` | 01, 02, 02A | `02B-users-and-reports-cutover.md` | complete_with_risk |
| 03 | [Inventory foundation](../03-inventory-foundation.md) | `3aa24dc28fa71d1074dee72eb9e5b06d35ef7a6c105a638388e4328832ef9ac6` | 01, 02, 02A, 02B | `03-inventory-foundation.md` | complete_with_risk |
| 04 | [Inventory atomic cutover](../04-inventory-cutover.md) | `5e039ddabfd586e5206e0b6999dd8b7bfaa5271f57d04809ee96119e9f0efbb9` | 03 | `04-inventory-cutover.md` | complete_with_risk |
| 05 | [Lifecycle closure](../05-lifecycle-and-bounded-work.md) | `896f90538206ad985f118a82f78d805b35d0eee6bc6d2c1b1c5c45c3b653800d` | 04 | `05-lifecycle-and-bounded-work.md` | complete_with_risk |
| 06 | [Capacity qualification](../06-capacity-qualification.md) | `6b03347872612958fe5b07154dfdd4230c005431cb3e1b3e16dcee6b82aeff68` | 05 | `06-capacity-qualification.md` | curtailed_by_user |
| 07 | [Production convergence](../07-production-convergence.md) | `702f4a9425603b3c7829c44d67506e1202d294e343c6178d51827901dda820bf` | 06 user-directed handoff | `07-production-convergence.md` | complete_with_risk |

Completion filenames above are relative to this directory. A missing record is not completed work.

## Binding parent decisions

1. Keep PostgreSQL and replace collection-sized runtime payloads with bounded typed records and atomic generation publication. Preserve business semantics, exact counts, unknown/stale distinctions and principal/tenant isolation.
2. Fresh application data is authorized. Do not add old-data converters, aliases, dual reads/writes, fallback readers or a compatibility window. Keep unrelated checksum-verified historical migration infrastructure; do not rewrite applied checksums.
3. Dormant foundations introduce no active routes/writers. Users and reports activate together in 02B; inventory activates in 04; the complete revision deploys in 07.
4. Accepted planning-review corrections: separate user/report foundations; independent fenced heartbeats during provider waits; tenant-history revision separate from active-set revision; incremental changed-key inventory references and coalesced non-starving reconciliation; distinguish integration, restore and fresh-installation DB naming; correct browser/restart bootstrap; collect diagnostics inside the original deploy gate before teardown; distinguish sampled heap values from peak-sensitive evidence.
5. Never weaken tests, business invariants, authorization or the existing five-step deployment gate to force deployment. Preserve true statuses and repair reproducible failures. A safety refusal is an open blocker with an exact continuation, not a fabricated success.
6. Approved package feeds only: npm `https://packagefeedproxy.microsoft.io/npm/`; Python `https://packagefeedproxy.microsoft.io/pypi/simple`. No public fallback/probe or unnecessary dependency install. Preserve `.npmrc` and `AGENTS.md`, including child/container environment configuration.
7. If asking the user is necessary, stop and await the actual answer. The target below is already answered and must be physically reverified, not repeatedly questioned.

## Authorized environments and lifecycle

### Production

The user explicitly selected the app exposing **localhost:3002**, verified as:

- Compose project `seha`; working directory is this repository.
- App `seha-app-1`, host `127.0.0.1:3002` to container `3001/tcp`.
- PostgreSQL `seha-postgres-1`, volume `seha_data`.
- Saved state `.local/seha`.

Only 07 may run the authorized initial DB-only reset:

```powershell
pwsh ./deploy-local.ps1 start -Project seha -DbReset
```

Immediately reverify project/service labels, working directory, port, database and volume mounts. Preserve tenant/client/domain profiles, credentials, session/database secrets, settings, saved public URL/callback/port/proxy bindings and backups. No external-provider mutations, app-registration changes, volume deletion, onboarding or secret regeneration. Later fix-forward deployment is normally without another reset.

Private configuration integrity metadata was captured at
`/Users/candede/.copilot/session-state/5096a470-ae0a-44f8-924b-cc4bb67eb03e/files/scale-production-config-before.json`.
This contains hashes/stat metadata, not plaintext credentials. Recheck current configuration before/after actual deployment and preserve any legitimate intervening user edits.

### Completed duplicate cleanup

On 2026-09-28 the user identified localhost:3001 as the duplicate. Parent verified exact project/service labels, working directory, port and volume, then ran the checked-in Compose helper for `agent-control-phase01` with `down --timeout 130`, **without `--volumes` or `--remove-orphans`**.

Removed only `agent-control-phase01-app-1`, `agent-control-phase01-postgres-1` and `agent-control-phase01_default`. Retained `agent-control-phase01_data` and all `.local/agent-control-phase01` configuration, secrets and backups for recovery. `seha` readiness remained healthy. Do not repeat/broaden cleanup, recreate the duplicate, delete its retained recovery resources or mutate unrelated services.

### Disposable qualification

Use unique campaign-owned projects and synthetic fixture settings only. No retained application DB, external provider credentials or production secret mounts.

- Parent-built baseline image: `agent-control-scale-5096-operator:local`.
- Baseline image ID: `sha256:78f3cb9fa91e7a64960699899d8fe2eb56bdd77c8ee56490f1f5255855b3c235`.
- Build changed candidates under new owned tags; preserve this baseline and production tags until 07.
- Engine preflight: 8,317,267,968 bytes Docker VM memory, 18 CPUs; approximately 773 GiB backing filesystem available. These are observations, not reserved resources or permission to alter other workloads.
- Root Compose test fixture currently has 1-GiB PostgreSQL memory and 256-MiB PGDATA tmpfs. The campaign wrapper must remove the inherited tmpfs and use owned disk-backed data/WAL/temp storage, with fixed process budgets and diagnostics before cleanup.

## Validation and review evidence

- Previous failure investigation reproduced PostgreSQL `oom_kill=1` at 512 MiB during exact JSONB-boundary publication. Capacity mitigation to 1 GiB was committed in the user baseline; this campaign addresses whole-collection processing and measurable resource contracts.
- Parent baseline operator Docker build: passed.
- Parent baseline `pwsh -NoProfile -NonInteractive -File ./scripts/local-deployment.tests.ps1`: exit 0. These are mocked safeguards, not deployment proof.
- Initial production and duplicate `/api/health` and `/api/ready`: HTTP success. Duplicate subsequently removed; production readiness rechecked successfully.
- Approved npm effective registry: verified. `.npmrc` and `AGENTS.md` added at explicit user request.
- After phase 01 launch, parent reverified npm's `replace-registry-host=npmjs`, private receipt permissions `0600`, retained baseline image identity and exact production labels/port/volume. Both `http://127.0.0.1:3002/api/health` and `/api/ready` returned HTTP 200. No production mutation occurred.
- Plan author checked manifest parity, links, completion paths, diagnostics and whitespace. Three independent plan reviews completed; accepted repairs applied. Final fresh GPT-6 Astra/xhigh adversarial review passed with no concrete blockers.
- Parent mechanical check passed: all nine ordered prompts, file-set parity, required sections, local links, prompt hashes, and tracked/untracked whitespace. Editor reported no errors for the added root policy/config.
- Production DB reset and campaign production deployment have not occurred. Application implementation begins with the phase 01 worker.

### Phase 01 parent review

- Read the implementation/completion record and inspected shared schema, generation/fence/heartbeat, pool, selection, export, fixture and original-gate changes. The foundation remains dormant; only shared admission and operator/schema infrastructure is active.
- Independently verified all 27 executable/config hashes still match the worker's qualified candidate receipt (`artifacts/phase01-final-evidence.json`).
- Independently reran `-Suite foundation`: **84 tests passed**, backend typecheck passed, exact batch/byte/residency receipt preserved. Parent run `c848198d2f904e3081367963719a7c57`; log `artifacts/phase01-parent-foundation.log`.
- Independently reran local deployment safeguards: **1,291 assertions passed**, log `artifacts/phase01-parent-deployment.log`. Editor reports no errors in reviewed core files. Editor test discovery returned no tests, so the actual isolated runner supplied behavioral proof.
- Worker aggregate evidence: **4,295 backend and 2,345 frontend tests**, typecheck/lint/build and exact-candidate original gate **5/5**. Read-only export and intentional failure/diagnostic smoke also passed. These are foundation results, not scale support proof.
- Parent-required repair: the frozen README specifies short **repeatable-read** transactions for selected reads, but `DataConnections.run` currently issues plain `BEGIN`, and `DataSelections` does not select an isolation level. Current scope locks protect the existing immutable projection, but future domain/mutable-dependency composition must not silently inherit READ COMMITTED. Add an explicit selected-read transaction boundary and actual PostgreSQL isolation/concurrent-read regression; do not globally change writer isolation or weaken durable scope locks. This is a narrow phase-01 prerequisite, not a new phase or compatibility layer.
- Parent fixture cleanup was checked by exact project label: no remaining containers, networks or volumes for `agent-control-ltdp-c848198d2f904e3081367963719a7c57`. Production `/api/ready` returned HTTP 200 after review; no production mutation occurred.

### Phase 01 repair acceptance and carried risk

- Parent inspected the explicit `DataConnections.selectedRead` / `DataSelections.read` boundary, export composition and actual PostgreSQL snapshot/conflict tests. Selected reads now use REPEATABLE READ; writer/renewal isolation is unchanged. Captures obtain quota admission before taking the snapshot. Serialization conflicts roll back and surface `503 data_read_conflict`, `Retry-After: 5`, without silent replay.
- Parent verified all **29 executable/config/documentation hashes** against `artifacts/phase01-repair-evidence.json` and independently reran `-Suite selected-reads`: **20 tests passed**, run `245fc6d27e654ac2bc687b765e692320`, log `artifacts/phase01-parent-selected-reads.log`. Editor diagnostics and diff hygiene passed.
- Repair worker passed the **92-test foundation**, backend typecheck, **4,303-test backend aggregate**, frontend lint/build and **1,291 orchestration assertions**. A timing-only generation race test was strengthened to wait for actual PostgreSQL blocking rather than 30 ms.
- The repaired candidate did **not** achieve a combined all-green aggregate: three attempts are preserved. The unchanged frontend `App.session.test.tsx` test named `does not reattach a post-action package-summaries read` observed three calls instead of two in two runs; it passed focused and in the middle full frontend run. This is an unresolved intermittent failure, not passing evidence. The old original-gate 5/5 result applies only to the pre-repair candidate.
- Parent accepts 01 as **complete_with_risk** under the binding continuation contract, since all foundation implementation and focused proof are complete and the residual affects unchanged live frontend behavior. No dormant feature is exposed. Track a bounded observer-freshness follow-up for 02B/05; **07 owns final resolution and exact-candidate gate convergence**. Threshold/trigger: any recurrence (already observed), stale observer data or any official gate refusal. Preserve the 5/5 guard; do not suppress the assertion or bypass deployment checks.
- All scale, live-process, browser, restore, restart and production evidence remains owned by its declared later phases. Foundation success is not a 100k-tenant support claim.

### Parent closure of the observer regression

- The earlier intermittent frontend failure is now **root-caused and repaired**. The test waited only for the initial saved query to stop fetching, but the first automatic-refresh response separately publishes source revisions and legitimately requests another catalog/history reload. Its timing could fall after the test's baseline counter and be incorrectly counted as a duplicate manual-action read.
- Parent controlled the startup response to reproduce the original **expected 2 / observed 3** failure deterministically for both package summaries and refresh-job history, using the unchanged runtime. Evidence: `artifacts/observer-race-reproduced.log`, owned fixture `9da493747f4449dc8228021fe35a37ea`.
- The only product-repository edit is test setup in `frontend/src/App.session.test.tsx`: explicitly finish the controlled startup publication before attaching the peer/taking the action baseline; retain the latest admitted query key. The original exact one-new-read, independent peer cancellation and returned-result assertions are unchanged. No runtime request suppression, arbitrary sleep, count relaxation or frontend wire change.
- Focused **4/4 cases passed** (`artifacts/observer-race-fixed.log`, fixture `9a073b34c4694963a22ab669ebacacc9`), then full frontend **2,345/2,345 tests in 77 files passed** (`artifacts/observer-frontend-qualified.log`, fixture `5baf1c621de24dc79da664fd55115f2d`). Editor diagnostics/diff hygiene passed. Verified test SHA-256: `0428f6716a14dd5207afdc48f3e203b0df5ecbcef361ee0a9be31fe6bd3cc1c9`.
- Tests used the known phase-01 repair image with only current frontend source mounted read-only, through existing owned-fixture capture/cleanup helpers. No concurrent phase-02 backend edits entered this proof. The temporary session helper is removed after use; diagnostic receipts remain.
- Exact-label post-cleanup checks found no containers, networks or volumes for all three observer fixtures. The parent selected-read fixture was also verified absent. Production readiness remained HTTP 200; no retained environment was changed.
- This closes the specific observer follow-up, not retroactively the three failed aggregates or an unrun current-candidate original gate. Phase 02's next aggregate and 07's exact integrated 5/5 gate remain required. The original 01 `complete_with_risk` status preserves that historical qualification distinction.

### Phase 02 parent acceptance

- Reviewed the completion record, migration 48, bounded provider/stage/query/people implementation, typed contracts, source-context capture and exact 02A/02B handoff. Existing Graph helper bodies are unchanged; only pure helper exports were added. Live routes/server/frontend import no new dormant user-source authority. Historical migrations 1-47 remain unchanged.
- Verified all **18 source/documentation/parent-test hashes** against the qualified candidate manifest and independently ran `-Suite user-sources-foundation`: **427 tests passed** and backend typecheck passed. Evidence: `artifacts/phase02-parent-focused.log`, run `c75a48c8daa248919e26b609075db1d0`. Editor diagnostics and diff hygiene passed.
- Worker foundation **96 tests**, **1,291 orchestration assertions**, and same-candidate software aggregate **5/5 passed**: **4,343 backend / 2,345 frontend tests**, typecheck/lint/build. This aggregate includes the parent's exact observer-test fix and closes the previously non-green combined software evidence. Historical failures remain recorded; actual 07 deployment gate has not run on this revision.
- Current accepted candidate: `agent-control-ltdp-25c33e01d51d4ce08bfbd724acdcb51c-operator:local`, image `sha256:9ed90a7270874917c5e65d86d22f6cd73f651593e2cbab5db6cb5ae8ff242711`. Preserve baseline and retained environment tags.
- Runtime-role 1k/10k exact-ID query evidence returns one indexed directory row with bounded parameters; this is not 100k capacity proof. Existing frontend bundle warning and later live-process/browser/restore/scale/production obligations retain their owners.
- Parent accepted 02 as **complete** and advances to 02A. Production readiness remains HTTP 200; no production action occurred.
- Exact-label cleanup check for the parent's phase-02 fixture found zero remaining containers, networks and volumes.

### Phase 02A parent acceptance

- Read the full completion and frozen contract; inspected typed schema/history fences, streamed ingestion and bounded acceptance, combined SQL/selection/keysets, handler registration/middleware, targeted agent references, export producers and regression proofs. Existing parser edits only export pure helpers. Existing report artifact/version/set/fact authority remains; migration 49 is additive and migrations 1-48 remain frozen.
- Verified **33 source/documentation hashes** and **all nine prompt hashes**. Independently ran `-Suite official-reports-foundation`: **371 tests in nine files passed**, backend typecheck passed, duration **76.13s**. Evidence: `artifacts/phase02a-parent-focused.log`, owned run `593594149a254b7eab2430ea3cbd8b7d`. Exact-label post-cleanup checks found zero containers/networks/volumes. Editor diagnostics and diff hygiene passed.
- Independently reran the changed gate orchestration tests successfully: `artifacts/phase02a-parent-orchestration.log`. Worker evidence includes **427 user-source**, **97 foundation**, **20 selected-read** tests, read-only persisted exports, intentional original-gate refusal and **1,299 orchestration assertions**.
- Same-candidate independent aggregate **5/5 passed**: **4,373 backend / 2,345 frontend tests**, typecheck/lint/build. Candidate `agent-control-ltdp-993bcb70f65d4b1bb45d9ae137cdae2e-operator:local`, image `sha256:4cb8b526f818f5d6c154d386206514a05df734c5bcb91abe6defe3afb83d2ede`. Preserve baseline/retained tags and prior failing evidence.
- Original software gate was actually attempted and **failed at 0/5**: backend command exceeded its unchanged **180s** deadline (`spawnSync npm ETIMEDOUT`); independent backend duration was **228.85s**. OOMKilled=false. Remaining four original-gate commands were not run. The independent aggregate is not a substitute gate pass.
- Parent accepts 02A **complete_with_risk**, not production-ready: implemented dormant contracts and semantic proofs permit 02B, while 07 owns exact original-gate convergence. 02B's mandatory predecessor deletion and 05/06 qualification work may reduce test/runtime cost; do not increase deadlines or memory, skip assertions or bypass the guard. Any command over 180s/nonzero/fewer than five successful steps triggers repair and rerun. Containment is the original pre-maintenance refusal: no app shutdown/reset/deployment until it passes.
- 32-set history, acceptance continuity, non-active correction/delete/expiry invalidation, wide-row export continuation and 1k/10k SQL evidence are present; they do not establish 100k/1m capacity or full lifecycle/browser/restore proof. Those remain assigned later phases.
- Production readiness on port 3002 remained HTTP 200. No production mutation, external provider call, commit or dependency installation occurred.

### Phase 02B parent acceptance

- Reviewed backend/schema/operations and frontend contracts, runtime registration, generation/source lock ordering, history invalidation, identity/people fencing, durable dispatcher, lifecycle and deletion boundaries. Migration 50 is forward and fresh-data guarded; migrations 1-50 are now handed off unchanged.
- Independently verified the original **290-entry** source/deletion manifest, **28 absent deleted paths**, the **12-file UI repair overlay**, and all **nine prompt hashes**. Parent cutover validation passed **337 backend / 527 frontend** tests plus typecheck; orchestration passed. Historical logs and manifests remain unmodified.
- Closed all three reproduced frontend findings after reading implementation and real-modal/multipart/serialization regressions. Parent `cutover-ui-contract` passed **984 tests plus frontend lint** (`artifacts/phase02b-parent-ui-repair.log`, run `686c6674a3ce48539a26e2a7b8acdecb`). Editor diagnostics and diff hygiene passed.
- Latest worker aggregate passed **5/5: 4,268 backend / 2,351 frontend**, types/lint/build; affected browser checks **112 passed**. Those results precede the parent quota correction below and are not relabeled as an aggregate of the subsequent source.
- Final README-contract comparison found the implemented official-import tenant reservation at **4 GiB**, contrary to the binding **2 GiB** ceiling. Parent added an actual DB reservation/upload regression, observed the expected failure (**1 failed / 314 passed**, upload incorrectly succeeded), restored the 2 GiB constant and documentation, then independently passed **315 native-authority tests plus backend typecheck**. The regression preserves the published report and reservations after rejection, releases failed active work and proves another tenant remains usable. No large payload allocation or quota increase was used. Evidence: `artifacts/phase02b-parent-tenant-quota-{before,after}.log`.
- `artifacts/phase02b-parent-acceptance-receipt.json` supplies the final three-file overlay over the historical source/UI receipts. Parent verified exact-label cleanup for all six UI repair runs and all three new parent runs: no owned containers/networks/volumes remain. Production readiness remained HTTP 200; no reset, deployment, provider mutation, package installation or commit occurred.
- Accepted **complete_with_risk** for the unchanged **original-gate 0/5** deadline debt only. Backend aggregate is **289.927s**, exceeding the original **180s** gate; no OOM. Remaining gate steps are not run after its refusal. Owner **07** must reduce actual cost and rerun the unchanged gate, including all five steps and cleanup. Any nonzero result, deadline breach or fewer than five successful steps triggers repair. Containment remains pre-maintenance refusal; never bypass the official path. Safe implementation of 03-06 continues.

### Independent original-gate cost triage during 03

Parent parsed the existing UI-repaired aggregate log without rerunning tests or
editing the worker's inventory/harness surfaces. Backend duration was **289.63s**,
of which **271.74s** was actual test execution, **2.42s** transformation and
**9.94s** import. This is not chiefly launcher overhead and is not evidence of
another memory-limit failure.

Largest test-file costs were `largeTenantUsersReports.test.ts` **64.915s**,
`officialUsageViews.test.ts` **28.091s**, `unifiedAgentRegistry.test.ts`
**26.135s** and `unifiedAgentsIntegration.test.ts` **17.782s**. Measured individual
cases include 30,001 checked/paid users **26.436s**, 5,000 registry memberships
**22.310s**, 1k/10k SQL plans **15.207s**, 5k logical/10k source targets
**14.955s**, and the actual 256-MiB wire boundary **12.966s**. Preserve their
requirements and cardinalities; optimize the implementations/fixture setup,
not assertions or limits. Phase 04's mandatory predecessor replacement may
remove old registry costs, but this is not yet proven and is not a gate pass.
Phase 07 retains the exact unchanged-gate obligation.

## Exact next action

Campaign implementation/deployment is complete under the updated scope.
No further autonomous reset,test campaign or deployment is queued. The next
operational action requires an assigned signed-in session:collect directory/
D30 activity,import supplied real reports,collect Graph/PP inventory,reconcile,
then verify bounded pages/details/export. Those live data workflows were
auth/data limited,not falsely passed. Existing role/capability/qualification
gates remain in force. Installation operator/product owner now owns the
residual signals and fix-forward triggers in07. Any later actual regression
uses the normal`start -Project seha`path **without `-DbReset`**. Never resume
synthetic capacity qualification without a new instruction.

### Phase 03 parent verification before acceptance

- Read the full completion, final source receipt, provider additions and
  streamed writer, migration-51 guards/indexes/grants, shared selection and
  generation fences, retention exclusion and native-backup/grant changes.
  Existing active provider methods remain intact; no new inventory factory
  registration exists in application/server/routes/frontend.
- Verified **32 current source hashes**, **all nine prompt hashes**, protected
  feed/configuration/deployment files and the three accepted parent quota
  fixes. Independently reconstructed frozen `schema.ts` by removing exactly
  three phase-03 lines and matched its 02B hash; migration 47-50 source hashes
  also match. No applied migration 1-50 was edited.
- Parent `inventory-foundation` passed **430 tests plus backend typecheck**:
  `artifacts/phase03-parent-focused.log`, run
  `e45ae48721624a6d8b8263b7a27f250a`.
- Parent `cutover-retention-contract` passed **154 tests plus backend
  typecheck**, including native backup/restore and historical upgrade/grants:
  `artifacts/phase03-parent-retention.log`, run
  `2042b17a3b2445a08937c733fb54e934`. Editor test discovery found no tests;
  these successful checks used the real checked-in owned fixture instead.
- Editor diagnostics and diff hygiene pass. Parent independently inspected
  exact-label cleanup for **33 worker projects and both parent fixtures**:
  no owned containers/networks/volumes remain. Production readiness stayed
  HTTP 200; no production mutation occurred.
- Worker aggregate was **5/5**, **4,302 backend / 2,351 frontend**, before the
  disclosed final four-file overlay; final focused tests cover that overlay.
  Shared foundation **109**, retention **154**, browser **58** passed.
  Original gate remains truly **0/5**, backend **180s** timeout, no OOM;
  independent backend duration **335.99s**. This is not a gate pass, and
  phase 07 retains cost-repair/unchanged-gate convergence ownership.
- The delegated-source metadata question in `currentInventoryData` is closed
  as correct: directory/people evidence intentionally uses the principal's
  delegated source, independently of inventory token mode, matching existing
  saved-people tests and active source writers. Do not change that contract.

### Phase 03 bounded acceptance findings

The parent inspected the cited implementation after the read-only review.
The five concrete mismatches below require executable regressions and repair;
the sixth child-page claim needs correction/proof against actual DB bounds:

1. **Repeated broad replacement loses exact precedence.** Publish K at t0,
   exact-delete at t30, then accept broad scans started at t10 and t20.
   The first excludes K, but the second can resurrect it because `newer`
   searches only the immediately prior baseline's staged observation history.
   Preserve effective per-key presence/tombstone precedence across baseline
   replacement, compaction and GC, without N-row copies on twenty-key deltas.
2. **Opaque Graph IDs are incorrectly normalized.** GUID-shaped Graph package
   IDs differing only by case can collide in new/previous survivor mappings.
   Preserve Graph IDs verbatim and retain domain-appropriate normalization
   only for native PP identifiers; prove stable canonical survivors on update.
3. **Valid wide sort keys break the 4-KiB cursor ceiling.** Publisher/platform/
   version keys are embedded whole in list cursors. Use bounded authenticated
   selected-row references with SQL recovery of full boundary values and
   unchanged exact/null/tie-break ordering; do not increase the cursor limit.
4. **`relevance: "all"` reverses organization view.** SQL coalesces relevance
   and view, turning organization/all into a negative predicate. Treat all as
   unrestricted and independently conjunct meaningful view/relevance filters.
5. **Platform facts omit native-only agents and normalization.** Emit the
   established normalized authoring-platform facts for native and Graph
   records and normalize corresponding inputs/facets consistently.
6. **Child page bound evidence needs an actual DB proof.** Review claimed a
   600,051-byte element payload could be staged then silently hidden by the
   512-KiB child-page filter. Parent notes migration 51 already rejects
   `inventory_facts.payload::text` above 262,144 bytes, so that pure-projection
   probe does not establish a publishable row. Test actual append/publication,
   legal wide/multibyte child rows and byte-short continuation. Repair any real
   omission/byte-accounting or non-explicit admission error; do not fabricate
   a reproduction by disabling guards or increasing bounds. Record any
   disproven part of the review explicitly.

No findings concern dormant activation, full 06 capacity qualification, or
the already-known original-gate debt. At review time parent kept 03
`in_progress`; the final resolution follows.

### Phase 03 final parent acceptance

- Closed all five concrete review mismatches after inspecting the exact-head
  publication/guards/GC and real repeated-swap regression, opaque-ID survivor
  mapping, selected-row digest cursors, independent relevance predicates and
  normalized platform facts. The sixth oversized-publication inference is
  explicitly **disproven** by the actual unchanged 256-KiB DB CHECK; the
  separate **real multibyte child-page/GC undercount** was reproduced and
  repaired. Initial **9 failed / 34 passed** proof remains preserved.
- Verified the **11-file repair overlay plus 21 unchanged prior sources**,
  historical receipt, all nine prompts, protected feed/deployment files and
  frozen migration 1-50 sources. Migration **51** is now accepted/frozen at
  checksum `32d1333b0e15ac2f4b70cddd1c0ccb4262d9d153f3cb3da64e9610f4f04ed322`.
- Independently reran final `inventory-foundation`: **444 tests and backend
  typecheck passed**, `artifacts/phase03-parent-repair-focused.log`, owned run
  `57c038cbaaf749738acae626ee435b6e`. Editor diagnostics and diff hygiene pass.
- Same final repaired source passed worker foundation **109**, native
  retention/backup/restore **154**, and independent aggregate **5/5:
  4,318 backend / 2,351 frontend**, typecheck/lint/build. Aggregate image
  `sha256:80e8f956fc4a4b8b48d84876f1778af28088fb5fb29bb933611fbda951e5263f`
  has no subsequent source overlay. Parent did not claim another complete
  aggregate or browser run.
- Parent verified zero exact-owned containers/networks/volumes for all **13
  repair projects plus its final fixture**. Production readiness remained
  HTTP 200; no reset/deployment/provider mutation or dependency install.
- Accepted **complete_with_risk** for original-gate qualification debt, not
  production readiness. The original gate remains historical **0/5 / 180s /
  no OOM**, not rerun during this repair; latest independent backend command
  took **364.989s**. Owner **07**, pre-maintenance refusal containment, and
  repair trigger (any failed/over-deadline step or fewer than five successes,
  including cleanup) remain unchanged. Do not substitute independent 5/5
  for that actual guard.
- 04 receives tested bounded producers, temporal/exact precedence, coalesced
  reconciliation and selected SQL contracts. 06 still owns real 100k/1m,
  deep/wide pagination and sustained-detail-churn capacity proof; small
  passing fixtures do not establish that workload envelope.

### Phase 04 incomplete job-slice handoff

- The worker explicitly did **not** activate the dormant inventory factories,
  change inventory list/detail/filter/facet/export consumers, implement
  server-filtered bulk target/prestate staging, delete predecessor storage or
  finish the required inventory browser/HTTP proof. The new real route guard
  still fails with **500: GET-side reconciliation forbidden**.
- Delivered metadata-only/scalar-count job get/list; revision-bound max-100
  outcome pages; bounded submit/reconciliation DB batches; periodic
  non-overlapping maintenance-aware recovery off status/history GET; all
  job API/App/BulkActions/result-page consumers and 5,000-outcome tests.
  Forward migration 52 checksum:
  `ea90f5e2239ed0d23e6c3e634e2ba9745a7e22c431ea6ad2a36470cb21cf591e`.
- Parent read the complete incomplete receipt and real route guard and verified
  **27 source hashes**, protected-source hashes, **nine immutable prompts**
  and exact-label cleanup of **20 worker projects**. No owned container,
  network or volume remains. Diff hygiene passes. This is integrity review,
  not acceptance of the unfinished phase.
- Job slice: **264 backend / 291 frontend**, types/build; browser **20**.
  Later recovery/lifecycle overlay: **156** plus typecheck; final HTTP:
  **207** plus typecheck. Foundation **109** passed. Exact inventory attempt:
  **556 backend passed / 1 failed**, **342 frontend passed**.
- Independent aggregate remains historical **4/5**: **4,316 backend passed /
  4 failed**, **2,354 frontend passed**, types/lint/build passed. Three backend
  failures were repaired in the focused final overlays; inventory GET remains
  failing. No combined-overlay full aggregate pass is claimed.
- Original software gate was actually attempted and failed **0/5 / 180s /
  no OOM**; backend independent command **380.954s**. Phase 07 owns unchanged
  gate/cost convergence, but this does not excuse incomplete phase 04.
- Parent clarification: first-page selection/pin bookkeeping follows README's
  pinned-read contract. GET must not refresh/reconcile/mutate source,
  canonical, control or job authority; do not confuse necessary selected-read
  metadata with permission to restore GET-side product mutation.
- Existing production was not touched. The completed job work is retained
  while a fresh worker finishes the same manifest phase; denominator remains
  nine and phases 05-07 remain pending.
- While the continuation started, parent inspected the delivered metadata
  count SQL, scoped/revision-bound item paging, statement-level revision
  triggers, one-page/abort/restart UI and maintenance-aware draining recovery.
  No additional concrete defect was identified in this bounded inspection;
  it is not a substitute for final integrated inventory validation.

### Phase 04 full continuation returned; acceptance in progress

- The continuation reports activation of all inventory writers/readers/UI,
  selected controls/targets, durable exports and predecessor deletion, with
  migrations 53-73. This claim is under parent review, not yet acceptance.
  No advance to 05 or production action is authorized by this receipt alone.
- Parent independently verified all **700 current source hashes**, **199
  changed / 71 added / 10 deleted** paths, **14 protected inputs**, **nine
  immutable prompts**, **six historical receipts**, and the preserved
  historical completion prefix. There were no mismatches.
- Reported final exact inventory **556 backend / 354 frontend**; foundation
  **513**, retention **158**, compiled restart and real browser **325 passed /
  9 existing skips**. Parent's own `-Suite inventory` is running in an owned
  isolated fixture; no successful parent result is claimed yet.
- Final independent aggregate is **4/5**, not passing: backend terminated at
  **600,112ms**, with 32 completed files and 1,813 known passing tests, not a
  full result. Frontend **2,382**, typecheck, lint and production build passed.
  The original gate is actually **0/5**, backend **180s ETIMEDOUT** and four
  steps not run. This worsened cost remains an explicit 07 repair obligation,
  not an OOM diagnosis or permission to change deadlines/memory/fixtures.
- Two bounded read-only reviews cover the substantial current-control and
  inventory UI boundaries. Parent will resolve findings, verify exact cleanup
  and frozen migration identity, then accept or launch a precise fresh repair.
  The worker's elapsed time does not lower the acceptance standard.
- Parent independent exact inventory now **passed: 556 backend / 355 frontend**,
  including the final viewport overlay. Backend duration was **305.99s**;
  export build was **11,179ms**, 50,000 rows / 32,002,324 bytes / 123 chunks.
  Parent project `agent-control-ltdp-21c6f7aa3cd24e3c99b89f40a5b2f2ab` and all
  292 continuation projects have zero remaining exact-label containers,
  networks or volumes. All three protected images match. Executing schema
  exports from the immutable source image reproduced all **73** checksums;
  versions **1-52** match the historical job-slice receipt.
- The control reviewer found **three acceptance defects**, confirmed by the
  parent's focused source inspection: `JobRepository.markSent` does not
  recheck current staged source authority at final dispatch; two mutation
  selection/target gates omit `authority_expires_at`; quarantine job-status
  GET still calls global interrupted-job recovery. The first review probe
  was in-memory; repair must reproduce the real staged/database boundary,
  not rely on that probe alone.
- These are implementation correctness gaps, **not** qualification-cost risk.
  Phase 04 stays `in_progress` and cannot advance to 05. Preserve versions
  1-73 and all historical results; no provider mutation or production action.
- The UI reviewer identified two additional concrete failures: already-stale
  optional identity/detail evidence participates in frontend active-expiry
  calculation and makes a valid catalog unreadable; Viewer group selections
  are hidden by an Admin-only guard, preventing selected export of ordinary
  multi-version agents. The repair must preserve active-expiry enforcement,
  read/export roles and current-only mutation restrictions.
- Fresh worker `4c1a2900-92e9-49ab-8de0-81c14cb39d55` is implementing exactly
  these five findings with failing-then-passing real database/UI regressions,
  final-dispatch publication fencing and bounded durable authority, off-GET
  quarantine recovery, and shared expiry predicates. No full cutover rewrite
  or phase 05 work is assigned. Next action: read its final repair section,
  source/cleanup overlay and validation, independently verify the repaired
  boundaries, then decide acceptance. Do not restart the completed cutover.

### Phase 04 final parent acceptance

- Accepted **complete_with_risk** after repairing all five correctness findings.
  This completes step **6/9**; the only residual is explicitly non-passing
  integrated qualification/cost evidence, not missing cutover implementation.
- Parent inspected durable frozen job authority, publication-before-job lock
  order and dispatch checks, staged/shared clock-expiry predicates, real
  second-provider-read invalidation regressions, the separate approved-canary
  producer, quarantine projection-only GETs and bounded startup/background
  recovery, stale optional frontend expiry and Viewer read/export group state
  separated from Admin-only mutation requests.
- Parent independently passed **327 backend / 302 frontend** tests plus backend
  typecheck, frontend lint and build in `phase04-parent-repair-verification.log`.
  The 327 includes the final two recovery-overlay regressions beyond the
  worker's earlier 325. Independently passed **63 migration/recovery tests**
  plus typecheck in `phase04-parent-recovery-verification.log`; these overlap
  the first suite and are not an additional unique-test total.
- Worker exact inventory **556 backend / 359 frontend**, real desktop/mobile
  browser **4**, and schema/recovery **63** passed. Its independent aggregate
  remains **4/5**, backend **600,108ms ETIMEDOUT**; full frontend **2,388**,
  types/lint/build passed. One historical migration-fixture expectation
  exposed by that aggregate is repaired and covered by the final 63 tests.
  The documented eight-file post-aggregate overlay is not silently attributed
  to the earlier aggregate image.
- Parent verified **703 runtime hashes / 727 total manifest entries**,
  **28 modified / 3 added** repair paths, continued absence of all ten retired
  files, protected inputs/prompts/receipts and preserved completion prefixes.
  Executable source-image checks reproduced all **74 migration checksums**;
  **1-73** remain frozen. Freeze migration74 at
  `ab8d8d101426a17d1589f5a399a7ff5d57c7baea5b03c6918885024f4dc1d9ce`.
- All **14 repair projects plus two independent parent projects** have no
  remaining exact-owned containers, networks or volumes. Read-only schema
  proof containers are absent; all three protected image identities match.
  Diff hygiene is clean. No dependency install, commit, production reset,
  deployment, or external-provider mutation occurred.
- Phase **07** still owns the actual unchanged original **5/5** gate and clean
  teardown before maintenance/app stop/reset/deployment. Historical original
  result remains **0/5 / 180s ETIMEDOUT / no OOM**, not a successful rerun.
  Independent aggregate success, if later obtained, cannot substitute for it.
  Keep thresholds, resource budgets, cardinalities and assertions unchanged.
- Phase **05** now owns full lifecycle/GC/pin/quota/recovery, streaming
  schema-inventoried backup/restore, browser/restart and observability closure.
  It may rely on active bounded user/report/inventory consumers and repaired
  current-only mutation authority. Preserve the complete 04 source/overlay
  chain; do not repeat the cutover or reopen rejected compatibility paths.

### Phase 05 launch and exact next action

- Fresh sequential worker `da8361c0-62ed-421b-bfe3-cb879e3a22ed` received the
  full phase05 prompt/README/worker contract, accepted prior records, all-root
  scope, protected images/resources, package-feed rules, and full production
  continuation contract. No production action is assigned to 05.
- It must exercise actual lifecycle races and resumable row/byte/time-bounded
  cleanup, replace the guessed backup table ceiling with validated schema
  inventory, finish snapshot-consistent streaming restore evidence, and run
  the exact synthetic-auth browser and compiled-runtime restart matrix.
  Existing bounded APIs, repaired mutation authority, and all 1-74 migration
  checksums remain binding.
- Parent requested deeper progress proof beyond inventory runtime's existing
  17-scope/20-baseline windows and for recovery batching. This is a phase05
  lifecycle audit hypothesis, not a claimed new defect or permission to
  alter accepted semantics without failing evidence.
- Next action: await this known worker's final result; read the required
  completion, source/migration/cleanup receipts and exact validation outcomes,
  then perform independent phase05 acceptance. Do not poll prior workers or
  restart phases 01-04. The manifest remains nine, with exactly phase05 active.

### Phase 05 returned; parent acceptance in progress

- The worker delivered persistent shared lifecycle budgets/progress, bounded
  recovery, export retries/completion fencing, schema-inventoried streaming
  backup/restore, compiled restart, browser and observability implementation.
  It proposes `complete_with_risk`; parent has not accepted or advanced to 06.
- Parent independently passed the exact `lifecycle` selector: **379 backend /
  410 frontend**, backend typecheck and frontend lint. This includes the real
  shared-snapshot dump/restore into a distinct `agentcontrol_restore_*`,
  104-table inventory, grants, readiness **503 -> 200**, and provider work
  remaining disabled. Evidence: `artifacts/phase05/parent-lifecycle-verification.log`.
- Parent verified the ten-record source/overlay chain through the completion:
  **830 entries / 792 present / 38 inherited tombstones**, **23 protected
  inputs**, and frozen **1-74** checksums against the preceding accepted
  receipt. Only migration75 is new. All **46 worker projects** have zero
  remaining exact-label containers/networks/volumes; three protected image
  identities match.
- Parent inspected explicit primary-key backup inventory, chunked fingerprints
  and shared pg_dump snapshot, distinct guarded restore/authority invalidation,
  idempotent export intent and bounded frontend retries, and held-final-chunk
  delivery that cannot satisfy Content-Length before final checks/audit.
- Worker independent aggregate remains literal **3/5**: backend **600,031ms
  timeout**, frontend **2,379 passed / 14 failed**, types/lint/build passed.
  The subsequent full frontend **2,393 passed** closes those UI failures but
  does not rewrite the historical aggregate. Original gate cost remains 07.
- Final application bytes passed **509 browser cases / nine existing skips**;
  two later fixture-only repairs passed **22 focused cases**, not one uniform
  green wrapper. Parent subsequently ran the exact `-Suite browser` against
  final fixtures: **four focused and 509 unfiltered passed, nine existing
  skips, exit0**. This closes that wrapper residual for the pre-repair source;
  it does not establish correctness of the four findings below.
  Evidence: `artifacts/phase05/parent-uniform-browser-verification.log`;
  owned project `agent-control-ltdp-f935575c8c564f27a2ecdcaa50ba1c2b`.
  Its result receipt has no failures; DB cleanup reports zero connections
  and remaining databases. Parent exact-label container/network/volume
  inspection independently returned zero remaining resources.
- Executing the compiled runtime independently reproduced all **75** migration
  checksums, including new migration75
  `26fda951b402de9645f307cf49b7552030718e8a4efd2c19dcf81721e62ede73`.
  Parent lifecycle fixture `agent-control-ltdp-c8da134d4aeb43388d1d87ed220bb6cd`
  and the read-only schema proof container were verified clean.
- The completed lifecycle review identified four acceptance defects: accepted
  report staging can cascade-delete undrained children; package recovery's
  byte accounting omits repeated job-row revision-trigger writes; abandoned
  report versions lose their cleanup provenance when ingestion metadata is
  removed; explicit quarantine resume still recovers the tenant's oldest job
  rather than the requested principal/job. Parent inspected the concrete
  predicates/call sites and requires real regressions before repair acceptance.
- These findings are not merely capacity qualification risk. Phase05 stays
  `in_progress`; 06 must not start. Parent browser qualification is finished;
  assign a fresh bounded same-phase repair of the four findings, preserving
  all prior evidence and migrations1-75. Require regressions that reproduce
  legal API/DB states, observe all cascade/trigger changes, and protect
  current/pinned/other-principal data. Parent must independently validate the
  repairs before accepting this phase.
- Repair worker `92560d5d-2d6d-471a-bbfc-bf5f66fb5476` is now the sole active
  implementation worker. It must append real failing-then-passing evidence
  and source/migration/cleanup receipts to the existing completion, without
  editing this parent-owned ledger. Parent browser workload was finished and
  clean before launch. Next action: review the repair's completed handoff,
  independently run its combined discriminating suite, and decide phase05
  acceptance. Do not launch 06 while these correctness gaps remain.
- Independent parent follow-up verified all nine prompt SHA-256 identities
  unchanged and inspected the completed browser fixture's three container
  state streams (310/335/335 observations): no observed `OOMKilled`, only
  exit-code0; PostgreSQL was captured running before teardown. This is
  lifecycle evidence, not phase06 peak-memory/capacity qualification.

### Phase05 final parent acceptance

- Repair worker `92560d5d-2d6d-471a-bbfc-bf5f66fb5476` completed the four
  acceptance defects and a directly coupled resumed-retention-cursor
  convergence defect. Parent inspected shared child/orphan predicates,
  reservation/parent deletion ordering, actual trigger-inclusive job budgets,
  exact principal/job recovery before dispatch, and the physical-write
  observer and real legal-state regressions.
- Independent parent command:
  `pwsh -NoProfile -File ./scripts/large-tenant-tests.ps1 -Suite lifecycle-acceptance-related`
  passed **391 tests in17 files** and backend typecheck. Evidence:
  `artifacts/phase05/parent-acceptance-repair-verification.log`.
  Actual test-command duration69,058ms; exit0. This is not the original gate.
- Parent physical-write observations include every affected public relation,
  cascades and repeated trigger writes. Maximum committed rows/bytes:
  accepted staging **508/221,309**; interrupted acceptance **310/136,169**;
  expired package targets **39/718,022**; started attempts **73/709,494**;
  exact quarantine resume **52/50,889**. Every slice is below1,000rows/1MiB.
  The observer measures first-to-last write span; transaction deadlines and
  the explicit wall-clock checks remain distinct evidence, not conflated.
- Worker final serial lifecycle **379 backend/410 frontend**, real104-table
  backup/restore/readiness503->200/provider-disabled proof, exact compiled
  restart, **4 focused/509 unfiltered browser with9 existing skips**, frontend
  **2,393**, types/lint/build passed. Later operator/test/docs overlays are
  separately qualified; identical205 backend/4 frontend compiled files
  connect the earlier successful browser application to the final runtime.
- Parent verified all **833 manifest entries/795 present/38 tombstones** and
  the14-record base chain ending at
  `acceptance-repair-completion-overlay.json`,
  SHA`1f7be3dc76020ac20bbe3fdabcb6a853689f2acdc1046550c98a0b9ee3b7698f`.
  All nine prompt hashes and diff whitespace checks passed.
- Parent independently executed the final runtime's **75 migration checksums**;
  every frozen checksum matches, no76 was added. Receipt:
  `artifacts/phase05/parent-acceptance-repair-migrations.json`. Exact proof
  container had exit0/noOOM/no mounts and was removed.
- Parent exact-label checks verified all **22 repair projects** plus its
  `agent-control-ltdp-f53abf625f7247e6ba1219e41b3fbfe8` test project clean.
  Three protected image identities are unchanged; no production, retained
  secrets/configuration, branch, commit or push action occurred.
- Accept05 **complete_with_risk**, not a capacity or deployment-gate pass.
  Latest worker aggregate remains literal **4/5**, backend600,126ms timeout;
  prior3/5 and original180-second0/5 receipts remain historical.07 owns actual
  cost/root repair and unchanged5/5 plus clean teardown before promotion.
  No known targeted lifecycle defect is deferred. Seven of nine phases
  accepted;06 is now the sole active phase.

### Phase06 parent launch decisions

- Honor the exact06 resource shape, not the larger PostgreSQL settings in
  lifecycle fixtures: app1536MiB/1.5CPU/768MiB heap; PG1024MiB/0.5CPU,
  shared_buffers32MB/work_mem4MB/maintenance_work_mem64MB/no parallel gather;
  separate1024MiB/1CPU provider/load/browser controller.
- Before loading full data, verify owned disk-backed PGDATA/WAL/temp, at
  least64GiB free and enforce48GiB used stop. No production data or credentials.
- Full100k/200k/1m profiles, three clean repetitions, both5,000x20-key churn
  sweeps,600-second real Retry-After/30+ renewals, transient32MiB/<250ms probe
  and all precise thresholds remain mandatory attempts. Missing peak
  coverage or violated bounds is not a pass. No reduced dataset/RAM/CPU/
  timeout increase, forced-GC workload normalization or fabricated counter.
- Parent remains integration/acceptance owner; preserve accepted source,
  migration and cleanup receipts. Append source overlays and forward DDL only.
- Fresh worker `9c710182-d51b-413d-b8d7-b29fbfb543ad` is now implementing06,
  position8/9. Parent qualification workloads were complete/clean before
  launch. No nested delegation or concurrent implementation worker. Next:
  read its completed handoff, independently verify discriminating capacity,
  integrity and cleanup evidence, then decide acceptance and07 launch.

### Phase06 status checkpoint: 2026-10-01 14:22 UTC

- Worker `9c710182-d51b-413d-b8d7-b29fbfb543ad` remains active after about12h.
  Parent checked actual source modifications at14:14UTC and live workload
  output/cgroup artifacts at14:22UTC, not only the agent's running flag.
  Its status label says handoff, but the completion explicitly remains an
  in-progress execution record. No final acceptance or07 launch is implied.
- Draft evidence records a real100k-users/200k-agents/1m-relationships report
  acceptance and independently expected199,998 canonical records. It also
  records major failures:936 of1,008 concurrent HTTP requests failed, a
  canonical summary exceeded15seconds, full traversal expired its selection,
  and PostgreSQL charged-memory headroom/max-event gates failed without OOM.
- The worker is repairing summary/index/cache/query costs, plus a reproduced
  PostgreSQL17 physical-read-counter attribution defect. Earlier unsubtracted
  read totals/ratios are withdrawn as per-transaction work proof; write-trigger
  and separately labelled cluster-WAL evidence are not the same counters.
  Latest repairs require fresh qualification; parent has not accepted them.
- The actual unchanged software gate was retried and remains0/5 at180seconds;
  the four later checks were not run. This is not a production readiness pass.
  Seven phases remain accepted; production unchanged and06 remains active.

### Phase06 status checkpoint: 2026-10-01 17:21 UTC

- The same worker is still active after about15h. Source/schema edits were
  observed at17:20:55UTC. This is not a completed handoff despite the unchanged
  agent intent label.
- The latest serial `capacity-focused` run passed **613 tests in23 files**
  and backend typecheck at17:15UTC. Evidence:
  `artifacts/phase06/final-repairs-capacity-focused.log`.
- The following original software gate again failed **0/5** at its unchanged
  180-second backend limit. The earlier capacity-query command also exited1.
  These are not acceptance passes and do not authorize production action.
- The worker stopped only its owned serial driver after the gate child
  finished, before another full run began. It is repairing broad publication
  preparation because the measured publication transaction still exceeds
  the1-second requirement. See
  `artifacts/phase06/publication-preparation-boundary.json`.
  Latest edits need new proof; prior613-test evidence does not cover them.
-06 remains in_progress; seven phases accepted, production unchanged.

### Phase06 status checkpoint: 2026-10-02 06:22 UTC

- The same worker remains active after about28h. Latest runtime edit was
 05:16UTC; the latest completion draft was05:20UTC. Actual auxiliary receipts
  show445backend/410frontend lifecycle,6restore tests,compiled restart and
 509browser cases/nine existing skips passing before06:03UTC.
- New full attempt`94d8544b07b04b88a04fa6fbe7e7d2e6` is executing the87-schema
  candidate. Parent inspected live database diagnostics: active subsecond
  queries,zero waiting locks and no pool queue at that instant; PostgreSQL
  logs show continuing WAL/checkpoint activity. Sampling activity alone was
  not used as the only evidence that useful work continues.
- Recent real regressions repaired authorization-row rewrites by derived
  quota accounting that caused selected repeatable-read conflicts. The
 279-test87 runtime proof passed; the complete new concurrency workload
  remains unaccepted.
- Latest query-only diagnostic passed functional/list/head-swap checks, but
  PostgreSQL charged-cache headroom/max-event gates still failed and complete
  heap coverage remained inconclusive. Original software gate remains0/5
  at180seconds; independent aggregate remains4/5/backend600105ms timeout.
  Seven phases accepted; no06 acceptance,07 launch or production action.

### Phase06 status checkpoint: 2026-10-02 08:24 UTC

- Worker remains active after about30h; latest code modification07:56UTC,
  current full fixture`7367ad69f1de4bab9390e8c68cd1a79a` remains active.
- Completed stages of the preceding87 full attempt now recorded1,008
  authenticated HTTP requests with zero errors and exact100k cursor results.
  Its inventory/detail p95 remains about3.1seconds versus the2-second gate;
  the real-browser initial inventory response still timed out at20seconds.
  These successes do not constitute a completed or qualified full run.
- That preceding run was safely stopped when the disk measurement command
  failed,not because measured storage reached48GiB or PostgreSQL OOMed.
  Last reliable volume usage15,596,015,616bytes; remaining profiles not_run,
  cleanup complete. The exact failed command stderr was not retained,so
  its root cause remains unknown rather than presumed a changing-file race.
- Shared-read fencing,better browser diagnostics and bounded disk-counter
  retry/diagnostics are now workspace repairs awaiting real verification.
  Running full2 uses the earlier immutable image,not those latest changes.
  PostgreSQL headroom and original software-gate failures remain open.

### User-directed transition: 2026-10-02 13:35+04:00

The user asked to stop spending time on further synthetic capacity tests and
move to actual production deployment,checking remaining behavior with real
data. This newer direction overrides the original06 requirement for additional
full runs/three repetitions/detail sweeps/wide profiles and extra synthetic
capacity/soak cycles in07. It does not turn incomplete or failed evidence into
a pass,authorize stress tests or external provider mutations in production,
or remove the existing deployment safety gates.

- Parent sent worker`9c710182-d51b-413d-b8d7-b29fbfb543ad`an explicit stop:
  no new capacity runs,optimization/refactor work or broad validation ladders;
  freeze code,capture diagnostics,stop/clean exact owned workloads and resolve
  paused coordinators,then return the final source/migration/evidence handoff.
  Delivery was observed; completed cleanup/freeze still requires the worker's
  actual result and parent verification.
- Preserve essential focused checks for unverified deployment-critical
  changes,build/schema/grant/reset safeguards and the actual unchanged5/5
  deployment gate. Do not invoke`-Suite all`as a convenience wrapper when it
  automatically starts another capacity campaign. The known180-second backend
  timeout must be repaired in the official path,not waived or hidden.
- Preserve the prior authorization for one fresh application-DB reset of
  `seha`onlocalhost3002,with tenant/sign-in configuration,secrets,settings and
  backups retained. No second reset as a generic fix. Real-data validation is
  dependency-ordered,read-only/bounded refresh/import/export and observation;
  mutations remain under their existing closed qualification gates.
- Parent read-only target inspection found`seha-app-1`and`seha-postgres-1`
  running/healthy,project/service labels and repository working directory
  matching,loopback3002->3001,network`seha_default`,database volume`seha_data`
  and expected read-only secret/control mounts. No secret contents were
  printed and no maintenance/reset/deploy action occurred. This is preliminary
  evidence; reverify immediately before destructive work.
- Preliminary preservation check independently matched all seven saved
  `seha`configuration/secret files against the private baseline: contents,
  sizes and permissions unchanged,with no secret values emitted.
  Existing`http://127.0.0.1:3002/api/ready`returnedHTTP200.
- Seven phases remain accepted while06 handoff is pending. No claim of100k
  capacity support or completed production deployment is made.

### Stop-coordination incident: 2026-10-02 16:38+04:00

- Parent discovered the13:35stop message had not interrupted the06 worker's
  active turn. It continued editing capacity files and launched another full
  fixture. Production deployment had not started. Sending a stop message was
  not verified cancellation; the prior transition status must not imply it.
- Parent independently verified and stopped only owned fixture
  `agent-control-ltdp-7057dd6b8efc457d8c2ee16c844e2d4d`. Captured exact labels,
  images,mounts,logs/cgroups and process fingerprints before signalling its
  workloadPID322. Paused then terminated/resumed coordinator7786 so it could
  not launch another fixture; terminated watcher45740. Used the fixture's
  generated Compose contract to remove its three containers,internal network
  and sole owned data volume. Exact-label checks returned zero resources;
  both host coordinator/watcher PIDs are gone.
- Receipt:`artifacts/phase06/parent-user-directed-stop.json`; pre/post
  diagnostics and cleanup log remain in that fixture directory.
  The workload is`user_stopped_incomplete_not_passed`,not a successful run.
- Background worker cancellation is still **not confirmed**. Further messages
  were sent directing no restart/no edits and immediate handoff. The candidate
  must not be called frozen or deployed while that worker continues editing.
  Parent needs actual worker termination/acknowledgement before07 starts.
-`seha`readiness remainsHTTP200 and HEAD remains unchanged. No production
  maintenance,reset,deploy,external-provider mutation or retained-resource
  cleanup occurred.

### Phase06 frozen handoff verified; phase07 launch decision

- The completion notification and one full agent read confirmed worker
  `9c710182-d51b-413d-b8d7-b29fbfb543ad`is idle/concluded. All three queued
  parent directives were processed; it explicitly promises no more edits,
  tests or restarts. This resolves the cancellation interlock by observed
  worker completion,not an assumed answer to the unavailable-user question.
- Parent reconstructed`user-redirect-frozen-handoff.json`and independently
  matched **874 entries/836 present/38 tombstones**,with zero mismatches and
  unchanged HEAD. Receipt SHA:
  `2c94fe1df3011761d1d91e07de2f1736fa724ac0f5df267879a6867b47ebff93`;
  reconstructed map SHA:
  `be4b08f4514f02eecb954aa76922de31d98502d442ff5eff9d7a84c0e44ea73e`.
- The frozen candidate is **not built or qualified**. Executed proof ends at
 88migrations/106tables; appended89and107-table backup inventory are untested.
  Other unverified edits include lineage point reads,browser fixture secure
  context/native UUID handling and expired-reader rotation.07 must inspect
  and verify deployment-critical paths rather than treating older850/317
  focused passes as proof of these edits.
- Exact7057...fixture resources and host PIDs7786/45740/46249 are absent.
  Parent removed only its own generated
  `scripts/__pycache__/large-tenant-capacity.cpython-314.pyc`after verifying
  its handoff hash. This restores a temporary-bytecode tombstone,not a runtime
  deletion; no other source changed. Parent ledger/completion updates are
  intentional post-handoff documentation deltas.
- Close06 as **curtailed_by_user**,not passed or100k-capacity accepted.
  Seven earlier phases remain accepted;06's remaining proof is waived by the
  user direction,and its pending implementation/safety review is explicitly
  owned by07. No user-requested work is silently represented as qualified.
-07 scope is deployment-critical completion only: targeted correctness/
  migration/grant/backup checks,minimum real fresh-install/reset safety proof,
  actual unchanged5/5guard and cleanup,retained configuration/checkpoint,
  official`seha`rollout,then bounded real-data observation. No extra synthetic
  capacity/soak campaign,broader performance refactor,guard bypass,memory/
  deadline increase,test skipping or backend-parallelism increase.
- Fresh07 worker`7d4e5d66-8d25-4029-affc-46e044aaf19f`launched with the
  complete production-continuation/safeguard contract and explicit user scope
  override. Retain an actual fresh-installation safety path but waive its
  additional30-minute synthetic soak; retain30-minute LIVE observation.
  It owns minimum pending-code proof,actual gate root-cost repair,checkpoint,
  final physical revalidation,official single-reset rollout and bounded
  real-data checks. Parent has not performed a production reset/deploy.

### Phase07 bounded handoff: safety repairs verified, release still blocked

- Worker`7d4e5d66-8d25-4029-affc-46e044aaf19f`returned idle after1116seconds,
  with explicit`blocked_safety_check`. No background editing or test campaign
  remains assigned. The fresh-installation runner is still unimplemented;
  fresh Deploy proof,checkpoint,production reset/deploy and live observation
  are`not_run`. This is incomplete,not`complete_with_risk`.
- Parent read the completion and changed count/readiness/backup contracts,
  independently matched all875source-map entries with zero mismatches,and
  verified manifest SHA
  `25b1536863c1c869da4bd81e9b1f95cf48087f2611b5994a7868da4ce055848e`.
  Actual migration receipt SHA
  `0f32835c56ec6e19941beabc0db29e6c85faa9336596eda295eb1c6a4e07f276`
  matches the fresh/repeated/grants proof:89migrations,107tables,unchanged1–88.
  Migration89 checksum:
  `f0f64c22a6b1339fcb266b1b55e0b4a8ef7a5c576e9f1efe3d199147f2b9eaac`.
- Repairs add count SELECT-grant readiness,restore grant ordering before
  retention,and physical-count reconciliation before/after restore review.
  Corrupt count metadata refuses backup before dump/success-receipt creation.
  Illegal test setup was replaced with legal incomplete/untyped facts while
  retaining immutable-header assertions. Final25count/schema/backup tests
  and backend types passed; earlier349/351and22/24 failures remain recorded.
  Pending lineage/test-harness boundaries passed their direct earlier checks,
  not another full browser/capacity campaign.
-204identity/inventory tests passed in144,284ms; a fixture-only JIT experiment
  passed the same204in143,701ms,was ineffective and fully reverted. Other
  separately measured required files took43,358ms and50,265ms. These are
  separate-run observations,not an invented current full-suite total.
  Historical original gate0/5and600-second aggregate4/5remain failures;
  no new full gate was run after an unproved improvement.
-1,319deployment-script assertions passed; these are simulated orchestration
  checks,not fresh-install or production evidence. No guard/deadline/resource/
  assertion/parallelism change was made.
- Parent independently rechecked zero containers/networks/volumes for all six
  exact07fixture projects,three protected image identities unchanged,and all
  seven retained production file hashes/sizes/modes unchanged. Readiness is
  HTTP200 on the old deployment. No production reset,maintenance,deployment,
  external mutation or commit occurred.
- The user requested an end to testing/optimization detours. Rather than
  silently weaken an approved release constraint or start another such
  campaign,parent will request one explicit whole-suite-time-budget decision.
  Every test/assertion and actual5/5plus cleanup pass would still be required.
  Until answered,the180-second requirement remains unchanged and07 stays open.

### Autonomous continuation decision: 2026-10-02T17:37+04

- After the paused question,the user explicitly directed continued autonomous
  implementation and resolution of open questions/ambiguities rather than
  stopping. Parent resolves the pending decision by choosing the proposed
  **1,200-second whole-backend-suite budget only**. This follows the new user
  instruction; the earlier unavailable-question response is not consent.
- This supersedes the earlier parent prohibition on changing this one command
  budget. It is not a performance root fix,capacity qualification,test skip or
  deployment bypass. All five commands must actually pass and cleanup must
  succeed. The other four commands stay at180seconds; all per-test deadlines,
  assertions,fixture sizes,backend serial execution,memory/CPU/heap limits,
  provider bounds and product latency thresholds remain unchanged.
- Parent traced the CLI callers and actual orchestration. The unchanged outer
  owned-fixture deadline is30minutes and remains an additional aggregate bound.
  No production/UI API consumes this command budget and no external config
  changes are needed.
- Added exact per-step timeout/failure/cleanup regressions. Before the change,
  27/29passed and the two new backend-budget expectations failed. After the
  surgical implementation,**29/29passed** and backend typecheck passed:
  `npm run test --workspace backend -- scripts/softwareChecks.test.ts`
  and`npm run typecheck --workspace backend`. Editor diagnostics passed.
  The IDE test adapter found no registered tests; the existing npm runner
  supplied the actual execution. This is unit proof,not the real5/5gate.
- Updated current operations policy and clarified old foundation deadline
  statements as historical. Earlier180/600-second failure receipts remain
  failures. Next work is the missing real fresh-installation path and guarded
  rollout,not another capacity campaign. No production command/reset occurred.
- Fresh remaining-rollout worker`c837f34d-3935-4979-8467-835379e6cfd7`launched
  with the complete production-continuation contract and latest overrides.
  It must reuse the actual fresh Deploy gate rather than add a redundant
  standalone full-gate attempt,then continue through production and live
  observation. Earlier07count/migration repairs are verified prerequisites,
  not an invitation to re-review completed architecture. Parent owns final
  integration,independent acceptance and campaign closure.

### Parent progress verification: 2026-10-02T19:36+04

- Fresh attempt5log independently shows4,775backend tests passed,
  2,393frontend tests passed,all5/5software steps with database cleanup,
  and successful fresh-installation/exact-owned cleanup. Evidence:
  `artifacts/phase07/fresh-installation-05.log`,owned project
  `ac-ltdp-install-1aeda19efdf8`,run`9af3c5217668451ea4dbf8823cbeef2f`.
  Worker additionally reports89migrations/107tables,restart,persistence and
  isolated restore verified; parent final acceptance remains pending.
- Initial production invocation receipt records
  `pwsh ./deploy-local.ps1 start -Project seha -DbReset`
  at2026-10-02T15:26:17Z,once. Compatible old-schema checkpoint preceded the
  new operator build. Do not infer that invoking the command means reset ran.
- Parent inspected exact gate project
  `agent-control-check-62c1aeb5ec914bd09f591473e0576a3f`.
  Its live log completed`copilotUsageGraph`and`inventoryVerification`tests
  at15:36:21–24Z,with active app/PG CPU and a healthy fixture database.
  The outer deployment log is buffered while this owned workload runs;
  its quiet timestamp is not evidence the gate is stalled.
- Parent independently observed unchanged old`seha`app/PG image/start
  identities andHTTP200readiness. The streamed reset-boundary file was still
  empty. Production is not yet claimed migrated/deployed; the current
  invocation is doing actual required release checks,not a capacity campaign.

## Final parent acceptance: production deployed and observed

- Accepted07`complete_with_risk`and closed the campaign. Eight phases are
  accepted;06is explicitly user-curtailed,not a passing capacity result.
  Every ordered completion record exists. No worker remains active and no
  implementation/deployment step is awaiting execution.
- The official initial command's actual5/5gate passed4,775backend tests,
  2,393frontend tests,backend typecheck,frontend lint and production build
  with fixture cleanup. Parent independently read those raw success records;
  earlier failed fresh/gate attempts remain failures.
- Exactly one application reset start/finish is present. Reset finished at
  2026-10-02T15:40:59.769Z; migration finished15:41:00.576Z and host readiness
  passed15:41:04.812Z. No second reset,forward redeploy or external mutation
  was performed. The selected production is still`seha`:3002.
- Independent current read-only proof is
  `artifacts/phase07/parent-deployed-proof.json`:89executed checksums,
  107public tables/exact runtime grants,non-owner/non-superuser runtime role,
  and225compiled backend/frontend files identical to the successful fresh
  installation. App image:
  `sha256:5e04e79c8ee3468a2c88a1b80311e49142799f966a0d724f38e5b4b7e9ff6495`;
  operator:
  `sha256:ccabb48032a8b5120c26505ee1862ebb718d9147d0efd63bdad90e1a79cf280e`.
  Original PostgreSQL container/image,volume and network are preserved.
- Parent matched all780build inputs to fresh source manifest
  `e4495ab05a698ece4ddcc348239da637a393258f48e99ab735f3dbe0cbbd278d`
  before final documentation-only handoff updates. Reviewed runtime repairs
  preserve account-before-SQL publication ordering,cancellation fences,
  provider omissions and bounded telemetry. Final diagnostics/diff checks pass.
- Parent independently validated all60raw observations spanning at least
  1,800seconds:120healthy public responses,300expected protected401responses,
  stable app/PG identities,no restarts/OOM,and no changes to any cgroup event
  counter. Sixty runtime samples had no pool/foreground-queue waiters.
  Actual production ceilings remain`max`; no finite80%headroom or successful
  authenticated list latency is claimed.
- Seven protected configuration/secret files match baseline hashes/sizes/modes;
  three protected images,duplicate recovery and seven unrelated workloads
  remain unchanged. The40,586,150-byte schema46checkpoint's SHA/0600mode
  remains verified; it is forensic only.
- Parent rechecked all15continuation fixture projects empty,five fresh states
  removed,and the separate HTTP-network probe absent by exact resource IDs.
  Source and preserved evidence remain uncommitted; HEAD is unchanged at
  `7e2be0b6b844bd538dbdd15f3e8261ea0fc6aeb6`. No branch/commit/push.
- Final parent updates to this ledger,07completion and the current`seha`
  operations handoff are documentation-only,not a new runtime revision.
  Historical deployed-source identity remains exact; later handoff prose is
  not represented as included in the deployed image.
- Protected real-data workflows require an authorized user/session and actual
  report files. Final fresh datasets/sessions are empty,normal provider mode
  is preserved,and existing auth/capability/mutation gates apply. The
  installation operator/product owner owns these residual checks and the
  exact alert/containment/fix-forward table in07. Full100k-user capacity is
  unqualified; no more synthetic qualification was run against the user scope.
- Final session-state reconciliation closed eight stale subsidiary02B/06
  worker todos against later accepted evidence and the explicit capacity-stop
  scope. The final query reports no unfinished todos. Those bookkeeping
  closures do not relabel a failed/incomplete capacity attempt as passed.
