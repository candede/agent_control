# 07 — Production convergence

## Current disposition

`complete_with_risk`, independently accepted by the parent after actual
`seha`deployment, one authorized application-DB reset and thirty-minute live
observation. Protected real-data validation remains auth/data limited; phase06
is`curtailed_by_user`,not capacity-qualified. The chronological entries below
preserve earlier failures and pre-deployment states; they are not current
instructions to repeat the reset. Final parent acceptance is at the end.
Assigned prompt SHA-256:
`702f4a9425603b3c7829c44d67506e1202d294e343c6178d51827901dda820bf`.

## Initial hypothesis and verification

The pending migration89 count ledger can provide exact, bounded report reads
without weakening physical publication/backup integrity. The cheapest
discriminating check is the actual isolated membership INSERT/UPDATE/DELETE,
rollback, cascade, backfill, grants and EXPLAIN regression, followed by the
directly coupled schema, selected-read and snapshot/restore tests. A dedicated
`production-prerequisites` selector runs those checks and the pending lineage
and test-harness unit boundaries, without starting capacity/browser workloads.

The unchanged official five-step gate remains mandatory. Existing backend
180-second failures are accepted evidence; another full gate will run only
after a relevant measured cost repair. No timeout, resources, fixture sizes,
assertions, isolation, or backend file-parallelism change is authorized.

## Preserved boundaries

- HEAD starts at `7e2be0b6b844bd538dbdd15f3e8261ea0fc6aeb6`; all dirty work
  and `.azure/deployment-plan.md` are preserved.
- Executed migration prefix1–88 is frozen at
  `a1dac1eea0cd42edad77af1803389210603d9cf35f9fddf6e8173a8d59935286`.
- Authorized production remains only `seha`:3002, with one application-DB
  reset through `pwsh ./deploy-local.ps1 start -Project seha -DbReset` after
  prerequisites. No production reset/deploy has occurred.
- Duplicate-removal proof belongs to the parent; its retained volume/config/
  backups and the three protected image identities must remain untouched.
- The fresh-installation synthetic soak is waived; the real Deploy path,
  unchanged5/5 and cleanup gates, and live production30-minute observation
  are not waived.

## Validation milestones

- `production-prerequisites`: 349/351 passed, backend typecheck passed;
  `artifacts/phase07/production-prerequisites-before.log`. Both failures were
  newly added count tests trying to UPDATE an immutable version header or
  use prohibited typed_version=0. Corrected with a legally incomplete version,
  an explicit immutability assertion, and permitted NULL untyped facts.
- Migration89 executed, 107-table inventory and actual new-schema dump/restore
  passed in that run. Statement INSERT fires once for250 memberships, both
  foreign keys still check each membership. Actual selected read used the
  count primary key and sparse-invalid index, with zero membership scan loops.
  Existing1–88 migration checksum assertions passed.
- Added runtime SELECT-grant readiness validation. Its first narrow rerun
  correctly exposed the restored-database grant-order dependency (22/24 pass).
  Restores now grant only the derived count's SELECT before retention readiness,
  retaining mutable grants after authority review. Added corrupt-ledger backup
  refusal, before any dump/success receipt is written.
- `production-counts` after that repair:25 tests and backend typecheck passed,
  `artifacts/phase07/production-counts-restore-fixed.log`. The initial two
  failure receipts are preserved. Final pre-review and post-review restore
  reconciliation also passed25 tests and backend typecheck in9,525/2,399ms:
  `artifacts/phase07/production-counts-final.log`.
- Actual gate-cost investigation, with fixed budgets and unchanged assertions:
  agentIdentity112 + PowerPlatformInventory92 tests passed in144,284ms;
  `artifacts/phase07/gate-cost-before.log`. Database initialization645/186ms;
  files51,355/91,648ms. Captured SQL-duration evidence identifies80 retained
  identity-cache INSERT statements consuming36,139.548ms (max565.582ms);
  the bounded diagnostic tail is not an entire-run SQL census.
- One narrow fixture-only JIT repair was tested, not assumed:204 tests passed
  in143,701ms; identity file became97,175ms. Actual ten first-batch plans had
  no JIT and costs92.59–190.61. Hypothesis disproved; removed that worker-owned
  experiment completely. `artifacts/phase07/gate-cost-jit-repair.log` remains.
  This is not a gate pass or a retained performance improvement.
- `scripts/local-deployment.tests.ps1`:1,319 orchestration assertions passed.
  These exercise simulated refusal/reset sequencing, not real5/5 or deployment.
  `git diff --check` and editor diagnostics passed.

## Bounded stop decision

The unchanged backend guard still cannot be justified as satisfiable: the two
measured controlling files alone consume143seconds, while the directly
required inventoryGenerations and largeTenantUsersReports files independently
consume43,358ms and50,265ms. Setup is not the cause. This is not an exact
single-run total, but is decisive against another speculative180-second gate
retry. No assertion/cardinality/isolation/resource change is authorized, and
the narrow attempted repair did not improve cost. Per the parent scope, stop
the profiling campaign and hand off `blocked_safety_check`, not production
complete or missing production authorization. Do not rerun the known-failing
whole command without a demonstrated relevant repair.

The real fresh-installation Deploy proof, seha checkpoint/reset/rollout and
live observation remain `not_run`. No duplicate fresh installation was made;
the fresh-installation runner is still unimplemented. This is an explicit
incomplete phase, not a substituted test-only success.

## Changed contracts and cross-root impact

- `backend/`: repaired new count regression fixtures, added missing count SELECT
  readiness, added corrupt-count backup rejection, and reconciled restored
  memberships both before authority review/retention and after it. Historical
  migration SQL1–88 and the now-executed89 SQL are unchanged.
- `scripts/`: added bounded prerequisite/count/cost selectors using the existing
  owned disk-backed lifecycle, with no qualification guard/resource changes.
  The cost selector only adds synthetic statement-duration logging.
- `frontend/`: checked selected-report and harness consumers; no payload, route,
  auth, UI, or production browser-platform contract changed. No frontend edit
  or frontend pass is claimed for07.
- Database code is inside `backend/src/db/`; there is no separate `db/` root.
  Deployment is root `compose.yaml`/`Dockerfile` plus `scripts/`; no separate
  `deployment/` directory exists. These deployment producers were checked, not
  bypassed or modified. The pending streamed lineage/harness changes passed
  their direct tests and backend compile; no full browser/capacity claim.
- `docs/operations.md`: records current user scope, bounded selectors,
  count/snapshot/restore semantics and the unresolved deployment guard.

## Residual containment and exact continuation

All residuals remain owned by phase07 until parent handoff. No new production
admission or maintenance change was made: the old retained deployment continues
unchanged, and the candidate has no production exposure.

| Residual/status | Containment | Signal/threshold and exact trigger/action |
| --- | --- | --- |
| Actual official gate, failed historical0/5;07 cost repair ineffective | No candidate deployment, maintenance or reset | `npm run test --workspace backend` must exit0 within unchanged180,000ms, then all other four steps and cleanup must pass. Resume only with a demonstrated narrow SQL/fixture cost repair, not another blind full run. |
| Fresh installation, not_run/unimplemented | No fresh application resources or production-shaped synthetic auth were created | Implement actual `Invoke-LocalDeployment -Action Deploy` with fresh synthetic config and isolated `agentcontrol`, unchanged5/5; exact ownership/cleanup required. Do not replace with internal Start. |
| Production checkpoint/reset/deploy/live observation, not_run | Preserve seha config, volumes, images and data; no external provider writes | After gate/fresh proof, checkpoint with deployed operator, immediately reverify exact identity/config, then authorized `pwsh ./deploy-local.ps1 start -Project seha -DbReset` once. No reset has begun. |
| Capacity/full browser/long-lived pins, curtailed or earlier failed/inconclusive | On future rollout keep affected replacement/reconciliation/history/export admission closed through existing controls until real-data invariants hold; do not invent a smaller supported envelope | >80% charged memory, any OOM/max/restart/fence/cross-scope fault, heap>615MiB or coverage loss, list/detail p95>2s/p99>5s, summary/facet>5s, SQL>15s, lock>2s, head swap>1s, canonical gap>60s: stop affected work, capture, root-fix and official forward redeploy without reset. |
| Real protected production data/auth, not_run | No synthetic production auth/data; preserve mutation gates | After actual readiness observe at least30minutes, through a permitted directory/D30 then inventory/reconcile/read/small-export cycle where access permits. Alert5xx>1%, pool acquisition>5s, expired GC>600s; tiny samples must remain exact counts. |

Literal refusing boundary remains `Invoke-LocalSoftwareChecks` ->
`backend/scripts/softwareChecks.ts` -> `npm run test --workspace backend`,
180,000ms. Prior raw0/5 and600,106ms4/5 receipts remain failures. No official
production command was executed in07; target authorization is resolved and
is not the blocker. Model/evaluator/remote-VM qualification is not applicable.

## Final identity, preservation and cleanup

`artifacts/phase07/final-handoff.json` records source deltas, exact image
identities, seven retained file hash/size/mode comparisons and exact-label
cleanup. `final-source.json` is the source map, not a runtime-build receipt.
`actual-migrations.json` records executed SQL checksums; migration89 is
`f0f64c22a6b1339fcb266b1b55e0b4a8ef7a5c576e9f1efe3d199147f2b9eaac`.
No new production runtime image was built or deployed.

Read-only final inspection found the same seha app
`91bf71f6ff7145650c37462fb1bd1bf5a38bab2473ea6fdb2b2d4ad2420225e4`,
image`sha256:ab93a5a2fc650a9b7a903b3b5494659c4d779c19f1a4c972f2fe526dceada26e`,
and PostgreSQL
`22e6109e93c4c767ac706ab0a6b1d00a7c3575ec7145f670a4f13aaa8f21d048`,
image`sha256:051f7b7b3abdd564d5d1bd1e8c4b9c1b6e77087d1dd22020ede611c096a272e0`.
Both were running/healthy, root Compose/project/service/working-directory
metadata matched, with localhost3002->3001, seha_default, seha_data and the
expected read-only state/secret mounts. Public readiness returnedHTTP200.
This is an unchanged-old-deployment check, not30-minute new-release observation.

All seven seha configuration/secret files match the private before baseline
by SHA-256, size and0600 mode; no contents were printed. The first read-only
receipt attempt wrongly assumed PostgreSQL had only its data mount and refused
its expected read-only admin-secret mount. Inspection confirmed the checked-in
two-mount contract; no physical target mismatch or production action occurred.
The corrected verification preserves that failed assertion in the final receipt.

All six07 owned fixture projects have zero containers/networks/volumes.
Their unique operator images remain identified for reproducible evidence;
all three protected image tags/IDs are unchanged. Duplicate recovery volume
`agent-control-phase01_data` and retained state remain present. No duplicate
cleanup, global prune, retained-resource deletion, credential/provider change,
package installation, commit, push, branch or delegation occurred.

Exact next action belongs to the parent: accept this bounded
`blocked_safety_check` handoff and keep the campaign open. Production continuation
requires a demonstrated relevant backend cost repair under the same safeguards,
then the real fresh-installation path and official deployment; do not infer a
reset from an unexecuted command or another setup/readiness pass.

## Parent review of bounded handoff

Parent independently verified all875source-map entries with zero mismatches
and matched the actual89-migration/107-table receipt,including unchanged1–88.
Reviewed count readiness,backup refusal and restore grant/reconciliation
ordering agree with the focused evidence. These partial repairs are retained;
the phase itself is **not complete**.

Parent also rechecked all six exact fixture projects empty,all three protected
image identities unchanged,and all seven production configuration/secret file
hashes,sizes and modes unchanged. The old production readiness isHTTP200.
No production command or reset has begun.

The whole-backend180-second release guard remains unchanged. The user-directed
stop excludes another open-ended performance/capacity detour; it does not by
itself waive that approved guard. Parent is requesting an explicit decision
on extending only the whole-suite execution budget while preserving every
test/assertion/fixture/resource/per-test bound and all five actual gate steps
plus cleanup. No such authorization is presently recorded. A necessary
question pauses execution until an actual answer,not an unavailable response.

## Parent autonomous continuation and command-budget repair

The user's subsequent instruction explicitly requires autonomous resolution of
open questions and continued implementation. Parent chooses the previously
proposed1,200-second budget for the **whole backend-test command only**,without
treating the earlier unavailable-tool response as consent. The prior worker's
180-second stop remains historical evidence,not the current command policy.

The other four steps remain180seconds each. Per-test timeouts,all assertions,
fixture sizes,serial backend execution,resource budgets and cleanup are
unchanged; the owned-fixture outer deadline remains30minutes. A passing unit
test is not a substitute for the actual five-step gate.

Parent's exact per-step timeout/cleanup regression first failed2of29cases
against the old policy,then passed29/29after the surgical implementation.
Backend typecheck and editor diagnostics passed. No runtime schema or
production configuration changed. The next worker owns the missing
fresh-installation runner/real Deploy proof and official production rollout
plus live observation under the newer scope,not another capacity campaign.

## Fresh-installation and production continuation worker — 2026-10-02

Initial continuation state: implementing the missing checked-in fresh-installation runner.
No new gate, fresh deployment or production operation has yet run in this
continuation. The parent-owned twenty-minute backend-command budget and all
other limits are preserved; historical failures above remain failures.

Falsifiable hypothesis: the existing real Deploy path can initialize an
independently owned synthetic installation without reset, using context-local
offline dependency reuse and fixed resource overrides, without changing its
five-command gate or cleanup. Cheapest falsifier: guarded PowerShell regression
tests, followed by this suite's actual Deploy (not a redundant standalone gate).

Guarded runner implemented with actual Deploy, separate synthetic configuration,
fixed-budget/internal-network overrides, readiness/denial, backup fingerprints,
restart, isolated restore and ownership-checked cleanup. First optional-context
argument implementation introduced an empty positional argument: existing
orchestration regression failed; filtering absent options repaired it and
all1,319 assertions passed. New47guard assertions and editor diagnostics passed.
These mocked assertions are not fresh-deployment evidence.

Actual fresh attempt1 began in project`ac-ltdp-install-8905fe5afe32`.
During its backend gate, an exact image probe proved the real operator image
omitted all five tested root deployment files (scripts and Compose YAML), unlike
the earlier auxiliary fixture image. This is a genuine packaging defect:
the Dockerfile test/operator stage now copies current scripts/root contracts
and clears inherited scripts. The running attempt retains its original image
and truthful result; it is not silently hot-patched.

Production checkpoint completed **before overwriting the retained operator tag**,
through `Invoke-LocalDeployment -Action Backup` with deployed compatible
operator image`2fc0061b…aac39e`. The46-migration/58-table version3 receipt
and40,586,150-byte dump checksum verified (`production-checkpoint.json`).
This is forensic-only old-schema evidence, not a new-schema restore claim.
Exact project/service/working-dir/config-file/port/network/mount metadata and
all seven private config hash/size/modes matched before and after checkpoint.
Production initial Deploy/reset has **not** begun.

Added narrowly scoped thirty-second runtime heap/RSS/external-buffer and
pool-total/idle/waiting gauges to the existing observation timer, including
idle zeros.26telemetry tests, backend typecheck,48fresh guards and editor
diagnostics passed; IDE test discovery was unavailable, so npm ran actual tests.
No resource limit or provider/mutation admission changed.

The normal root command can now select an explicitly installed dependency image
via`AGENT_CONTROL_DEPENDENCY_IMAGE`, checking all four manifests and required
tools, pinning the exact image ID and disabling build networking. This preserves
the real new-source operator/runtime builds and five-step gate; it is not an
old-image startup substitute. This continuation uses that offline path because
the existing lockfile contains direct registry URLs and no package installation
is necessary.53fresh/build guards and1,319existing orchestration assertions
passed. No public/default registry request was made.

Attempt1's real backend gate additionally exposed the unchanged60-second
Graph publication test deadline (5000source records):60,004ms, with the
operation subsequently completing at about61seconds. Preserved its failure;
no deadline, record count, assertion, pacing or parallelism changed. A direct
trace found local freshness/control annotations being re-presented to the
provider sanitizer as unknown provider fields (1,609identical warnings even
in a partial saved tail). Projection now separates those already-retained
local annotations before provider validation and restores the same fields
afterwards. Genuine unknown-field diagnostics remain unchanged. This is a
bounded repair of the observed path, not another capacity/profile campaign;
its effect on the real gate is not yet claimed.

New projection tests and the existing unknown-field diagnostic assertion
passed3/3selected tests; typecheck passed. A broader host-only three-file run
passed63/65 and exposed two existing report-deadline/microtask assertions in
`providerJson.test.ts` on host Node24.18.1. Those failures remain recorded;
neither those assertions nor the unrelated report transport was changed.
The actual installed-image full gate remains authoritative and in progress.

### Actual gate1 finished; bounded failure repair

Actual fresh attempt1 **failed0/5**: backend4,757passed/14failed,191files
(9failed), plus an automatic-refresh afterAll timeout. Both its software-check
resources and fresh state/operator tag were exactly cleaned; no fresh runtime
or application DB was initialized and no production reset began.
Evidence:`fresh-installation-01.log`, owned installation receipt under
`artifacts/large-tenant-data-platform/a1ade30a083c4c3a83e82830ba855c0d/`.

Besides packaging/false omissions, this full gate exposed stale tests calling
today's accounting writer against historical62/68schemas, old receipt-v3/MD5
fingerprint expectations, stale count-query interception, and a source-deadline
fixture still mocking the removed whole-body timeout. Fixtures now exercise the
actual contracts: isolated historical SQL without runtime compatibility,
reviewed-key ordered v4SHA-256 streaming with Unicode/duplicates/oversized rows,
current count-query failure injection, and real source AbortSignals. Added
explicit cancellation fences before activity staging/finalization. All executed
1–89migration checksums remain identical.

The narrow real `production-gate-repairs` run passed189/191tests (9/10files),
leaving only both automatic-refresh cases plus their cleanup hook failure.
The unchanged5000-record Graph publication test passed in32,067ms; this proves
that case only, not capacity qualification. That run used
`agent-control-ltdp-136a99e1839c4e73be257c2c6fd6734b`, cleaned exactly.

Automatic refresh exposed an actual account-queue/database-lock inversion:
publication held run/source SQL locks before joining account serialization,
while progress tracking held account serialization before requesting those
SQL locks. Package and Power Platform publication now acquire the account
guard around the complete publication transaction, not inside its completion
callback. New ordering regression and both mocked pipeline contracts cover the
boundary; all163service tests and backend typecheck passed. No guard, polling
interval, test deadline or provider limit was enlarged. The next narrow actual
run verifies this fix before fresh Deploy is retried.

A host-only command accidentally included two DB-dependent fixture tests; both
correctly refused missing `agentcontrol_test_*` configuration (49other tests
passed). No production connection occurred. The subsequent actual owned
fixture passed those same tests. The39provider/projection host tests and
54fresh/build guard assertions now pass.

Second actual repair slice passed403/404tests across13files, including both
automatic-refresh cases and cleanup: the account/SQL ordering repair resolved
their reproduced deadlock without increasing the2-second assertions. Graph
publication passed33,855ms. One pre-existing GC index-plan assertion changed
after the new ordering test added a row to its shared fixture. The new ordering
test now owns a separate database so it cannot perturb unrelated planner
statistics; the original GC assertions and planner settings are unchanged.
The narrow publication slice is running before the fresh Deploy retry.

Offline dependency reuse now retains the validated local tag for BuildKit
resolution and compares its exact image identity before/after each build
(rather than assuming a bare image-ID Dockerfile reference is portable).
No registry probe or additional dependency installation was used.55fresh/build
guard assertions pass. Production remains healthy on its original image;
only its verified forensic checkpoint has been created so far.

The final isolated publication slice passed215/215tests across4files and
backend typecheck. Its exact-owned containers/volume were removed. The new
ordering test's separate database preserves the existing GC planner assertion.
The full1,319PowerShell orchestration assertions also pass after the final
offline-build identity checks. Actual fresh Deploy attempt2 is now running
its required five-command gate; production target/config revalidation passed
immediately beforehand. No production reset/deploy has started.

Actual fresh Deploy attempt2 refused at0/5:4,772/4,775backend tests passed
in697.02seconds; the three failures were the server timer's obsolete telemetry
mock missing the newly added `observeRuntimeResources` export. All earlier
gate defects passed. The mock now models the real producer and asserts the
timer samples its pool;42server/telemetry tests and backend typecheck pass.
The live sample also includes actual bounded-pool foreground/queue counts,
without changing admission or timing limits.56fresh guard assertions pass.
Restart proof now polls exact-owned health after `restart`, without a direct
runtime `compose up`. The source manifest includes all Dockerfile inputs.
Attempt2's fixture and synthetic state/operator tag were exactly cleaned;
its failure and cleanup receipts remain under
`artifacts/large-tenant-data-platform/dae05315597e429f962b77ab868e96a3`.
Attempt3 will again use actual fresh Deploy; production remains untouched.

Attempt3 actually passed all5/5commands and fixture cleanup:
4,775backend tests/192files (749.19s),2,393frontend tests/82files (110.43s),
backend typecheck, frontend lint and production build. It then performed
empty-DB preflight (`fresh`,0→89), migration/grants and actual app startup;
both app and PostgreSQL were healthy. Final host readiness refused
`Connection refused (localhost:51133)`. This is a failed fresh attempt,
not a production deploy or fully successful installation proof. All exact
owned resources/state/image tags were cleaned with preserved diagnostics at
`artifacts/large-tenant-data-platform/1852cd97f0644d6fa4e2b3997dbddec2`.

A minimal, separately owned HTTP network diagnostic reproduced refusal on
both127.0.0.1andlocalhost for an internal Docker network; its container/network
were exactly removed and the protected baseline image unchanged. Isolation
has **not** been relaxed. The fresh-only readiness transport now executes
actual HTTP inside its owned runtime container, while retained production
still requires host HTTP. Declared unique loopback binding/origin remains
verified; fresh host reachability is explicitly unavailable on this engine.
Code tracing also found scheduled lifecycle progress necessarily advances in
an otherwise empty runtime. Restart proof now checks all107row counts,
106unchanged data/schema fingerprints and the six workers' nonregressing
slice/unchanged collection counters, recording their metadata separately.

The transport/persistence guard changes passed63fresh assertions and all
1,319existing deployment assertions. Attempt4 is running the real fresh
Deploy boundary; no production reset has started. A private, non-secret
identity/health baseline now also covers the seven unrelated running
containers. The production verifier compares that baseline without changing
their resources. Frontend and infrastructure roots are untouched by this
remaining-rollout worker: no UI/wire contracts changed; the actual full gate
already exercised frontend tests/lint/build. Backend producers/consumers,
deployment scripts, root Docker packaging and directly related operations
documentation contain this worker's repairs.

Attempt4 passed the actual full5/5gate, empty initialization, actual runtime
200ready/auth and401protected denial,89migrations/107-table backup, restart,
and all107row-count/106data-schema fingerprint comparisons. It refused the
new harness's overly strict unchanged GC counters before restore. The actual
runtime emitted one row/512bytes per empty GC slice; `LifecycleSlice` explicitly
charges its own progress write. No data/schema fingerprints changed. The
harness now permits only nonregressing counters within the unchanged
1000-row/1-MiB slice limits, and preserves both backup receipts/progress
diagnostics **before** assertions. This is a harness correction, not a product
limit change. Attempt4 remains failed with exact-owned cleanup; evidence:
`artifacts/large-tenant-data-platform/d7a34bfe357d40e9977fa807ca4d276f`.

### Actual fresh installation accepted by worker; production rollout next

Attempt5 completed actual Deploy and **all5/5checks plus cleanup**:
4,775backend tests(755.81s),2,393frontend tests(111.36s), backend typecheck,
frontend lint and production build. Project`ac-ltdp-install-1aeda19efdf8`
was never-used, synthetic-only and separately owned. Empty preflight,
89migrations/107tables/grants, real runtime200ready/auth/401denial,
app+PostgreSQL restart/persistence and isolated
`agentcontrol_restore_1aeda19efdf8`restore passed. No fresh reset, synthetic
soak or capacity run occurred. Evidence:
`artifacts/large-tenant-data-platform/9af3c5217668451ea4dbf8823cbeef2f`.
The780-entry source manifest has zero current mismatches and SHA256
`e4495ab05a698ece4ddcc348239da637a393258f48e99ab735f3dbe0cbbd278d`;
all89executed checksums match the accepted lineage. Exact-owned containers,
volume, network, synthetic state and both image tags were removed after
diagnostic/image-identity capture. Historical attempts1–4remain failures.

The existing small `largeTenantData.spec.ts`synthetic browser contract is now
running separately; it is not authenticated production evidence. Next is
immediate seha identity/config/checkpoint revalidation and the authorized
root initial command once, followed by live observation—not another gate
profiling/capacity campaign. Production reset has not yet begun.

The focused browser fixture passed its two bounded export contracts
(one backend fixture host test;34.90seconds) and cleanup at
`artifacts/large-tenant-data-platform/82a8f2869b684076b85fd22113825055`.
This is synthetic browser evidence, not production sign-in.

The literal authorized initial command
`pwsh ./deploy-local.ps1 start -Project seha -DbReset`has now been invoked
**once**, after exact physical identity/seven-file/unrelated-health matching
and checkpoint SHA/size/mode revalidation. Its one-time invocation receipt is
`artifacts/phase07/production-initial-attempt.json`, with timestamped gate/reset/
migration/readiness boundaries streamed to`production-initial-events.jsonl`.
It is currently building/checking under the unchanged mandatory gate;
no reset-start boundary has yet been observed. The compatible old-schema
checkpoint was captured before this new operator tag build. Any subsequent
repair uses the official forward command without`-DbReset`.

### Authorized production reset/deployment executed

The official initial command exited0. Its independent real gate passed5/5
and cleanup:4,775backend tests(727.00s),2,393frontend tests(113.90s), backend
typecheck, frontend lint and production build. The actual logged application
reset began at2026-10-02T15:40:58.609Z, finished15:40:59.769Z, migration
finished15:41:00.576Z and host readiness passed15:41:04.812Z. These are
log-observation timestamps. **Production is deployed and the one authorized
application-DB reset finished. Never repeat it.**

The browser atlocalhost:3002renders the new sign-in page; no authorized
session is available and its protected request returns401. No username,
token, tenant fixture or provider mutation was supplied. Directory/D30/
inventory refresh, official import and protected export remain auth/data
limited rather than being represented as successful live workflows.

The first operational post-deploy verifier exposed a local evidence-parser
error: PostgreSQL `json_agg`composite rows contain newlines, while the helper
read only the first line. That verifier failed before observation started.
Both local read-only evidence parsers now decode the complete JSON value;
no runtime/schema/config change or redeployment was made. Deployed invariant
verification and the thirty-minute live observation are running.

Post-deploy verification now passes: all89checksums, all107table names and
their exact five-privilege grant matrix, non-superuser/non-owner runtime role,
and compiled backend/frontend artifacts identical to the successful fresh
runtime. All seven protected files and unrelated workloads match. Two more
local observer defects were repaired before any live sample: its grant parser
incorrectly required optional SQL semicolons (actual grants were correct),
and an appended import was below its first use. The failed verification/
observer logs remain failures. Observation attempt02is now running; these
evidence-tool repairs changed no deployed code, limits, schema or data.

Live attempt02started2026-10-02T15:47:37.711Z and its first three samples
passed, including real heap/pool/foreground-queue telemetry. Actual app
container`193909d807671ff7f4def1f1f54f8aceebdf7f89d082d8d505ab432bced87ff5`
runs image`sha256:5e04e79c8ee3468a2c88a1b80311e49142799f966a0d724f38e5b4b7e9ff6495`;
operator image is
`sha256:ccabb48032a8b5120c26505ee1862ebb718d9147d0efd63bdad90e1a79cf280e`.
The original PostgreSQL container/image, seha volume/network and all seven
configuration files are preserved. Both cgroups are intentionally unchanged
and unlimited (`memory.max=max`): actual charged bytes/events are sampled,
but no finite-budget80% headroom claim is available.

Early real data is honestly not synced/imported: zero sessions, directory/
D30 rows, inventory generations/heads/canonical rows, official sets, exports,
pins and jobs. Operational mode is normal and provider work is not globally
disabled. Existing session/role/capability/qualification/selected-data fences
remain in force; no production authentication or external mutations were
bypassed to create evidence. The final live receipt is still pending.

At14.48minutes,29live samples contain zero alerts and zero successful
protected list requests. Actual mounted route templates omit`/api`for
protected routers; the final raw-log window analyzer accounts for both
mounted/root templates. This correction cannot create a list percentile:
there are no successful authorized lists. Every raw status/duration sample
is retained, and the final analyzer rechecks the numeric windows.

### Residual controls and ownership (pending final observation closure)

| Residual / affected scope | Narrow containment and signal | Owner until handoff / exact trigger and action | Evidence |
| --- | --- | --- | --- |
| No authorized production session or supplied official files: directory/D30 refresh, Graph/PP inventory, canonical reconciliation, protected details/export not run | Existing auth/role/capability/qualification and selected-data fences remain; no fabricated tenant records, token extraction, canary writes or external mutation. Current sessions/heads/jobs/exports/pins are0; protected probes401. Normal mode remains enabled rather than globally disabling the product. | Phase07. When an assigned authorized session is available, perform one directory+D30 read/refresh, supplied real-file import only, Graph/PP read inventory, canonical reconciliation, then bounded query/details/small export. Close only the failing stage on any fence/cross-scope fault, head mismatch or unsafe publication; diagnose and use official forward deployment without reset. | Browser sign-in observation, live02raw/summary, production-deployed-proof.json |
| Full100k support/capacity remains unqualified by user direction | No synthetic capacity run, invented smaller envelope or support claim. Existing source/page/byte/deadline/admission limits unchanged. Real observed alerts remain80%finite charged memory, anyOOM/max/restart/fence/cross-scope fault, listp95>2000ms/5min,5xx>1%/5min, pool acquisition>5000ms, GC>600s. | Phase07. A threshold breach during real work triggers affected-source/job admission containment, preserved diagnostics, root repair and focused/implicated checks, then`pwsh ./deploy-local.ps1 start -Project seha`and renewed observation. Do not resume synthetic capacity without new instruction. | Inherited06residuals; actual fresh/production gates; live02 |
| Production cgroups have no finite memory ceiling; successful acquisition durations are not separately instrumented | Preserve existing limits. Collect actual charged/current/peak/events, RSS/heap/pool/foreground queue. No80%headroom claim for`memory.max=max`; existing5000ms acquisition timeout and queue/error signals remain enforced. | Phase07. AnyOOM/max event, restart, acquisition timeout or sustained queue requires narrow containment and diagnosis; no automatic limit increase or second reset. | Deployed identity and live cgroup/runtime samples |
| Fresh host-port reachability unavailable on this engine's internal network | Fresh actual HTTP runs inside its owned app container; unique loopback binding/origin and isolation verified. Production host readiness is separately proven and unaffected. | Phase07. If future qualification specifically requires host reachability, use an explicitly reviewed isolated-network design; never drop isolation or substitute a mocked endpoint. | fresh-loopback-network-probe.json; successful fresh05HTTP/resources |
| Old schema46checkpoint is forensic only | Preserve dump/receipt0600and exact hash; never restore its old data into new production. New schema89restore was separately verified in the owned fresh instance. | Phase07. Recovery investigation may inspect the checkpoint through its compatible retained operator; any production repair uses forward deployment, not an unapproved restore/reset. | production-checkpoint.json; fresh05restore |

Model/evaluator and remote-VM deployment categories are not applicable: this
campaign introduces no model logic or remote VM. Fresh synthetic soak and
new capacity runs are explicitly not run under the user's updated scope.

### Remaining deployment objective completed — 2026-10-02T16:18Z

**Worker outcome: deployed, reset completed once, live observation completed;
protected real-data qualification remains explicitly auth/data limited.**
Parent acceptance/campaign closure remains parent-owned. No second reset,
forward redeployment, production canary write, Entra/provider mutation,
commit, push or branch was performed.

Live observation ran from2026-10-02T15:47:37.711Z through16:17:37.745Z
(1800.986elapsed seconds), with60HTTP/DB/cgroup/config samples and60actual
runtime resource samples. All60readiness and60auth-configuration responses
were200; each of five protected routes returned401in all60probes. Exact
readiness duration range20.790–29.573ms; auth-status0.850–1.968ms. These are
individual observed samples, not invented load percentiles.

The50complete five-minute raw-log windows contained204–212requests each,
zero5xx and no successful authenticated list samples; listp95is unavailable.
No observed restart, OOM/max event, queue waiter, acquisition timeout,
fence/cross-scope fault or expired GC backlog occurred. All memory-event
counters had zero deltas; PostgreSQL's153`sock_throttled`events predated the
window and did not increase. App charged memory ranged69,341,184–82,935,808
bytes; PostgreSQL239,001,600–259,727,360bytes. Lifetime cgroup peaks were
143,458,304and860,585,984bytes respectively; the retained PostgreSQL peak is
**not** a thirty-minute workload peak. Both ceilings remain`max`, so finite
headroom is not asserted. Actual V8 heap-used22,219,304–29,802,600bytes,
RSS90,710,016–103,927,808bytes, pool2–3connections, foreground1–2,
pool waiters/foreground queue0.

Final read-only verification again passed all89migration checksums,
107table inventory/exact grants, restricted runtime role, and225compiled
backend/frontend files byte-identical to the successful fresh runtime.
Seven configuration files match their private SHA/size/mode baseline;
seven unrelated containers retain exact identities/health; three protected
images and duplicate recovery volume/state remain preserved. The old-schema
checkpoint's checksum/size/0600mode and780source-input hashes still match.
HEAD remains`7e2be0b6b844bd538dbdd15f3e8261ea0fc6aeb6`.

Final production has zero sessions, directory/D30 rows, inventory generations/
heads/canonical rows, official sets, jobs, pins and exports. Browser still
shows sign-in. No authorized refresh/reconcile or supplied-file import was
possible; normal provider mode is preserved behind existing auth/capability/
qualification gates. This is verified safe deployment/public operational
behavior, **not** enterprise data semantics or100kqualification.

| Final check | Status / evidence |
| --- | --- |
| Fresh actual Deploy,5/5gate, restart/persistence and schema89restore | Passed,`fresh-installation-05.log`; owned run`9af3c5217668451ea4dbf8823cbeef2f` |
| Production official single-reset Deploy,5/5gate and cleanup | Passed,`production-initial-attempt.json`,`production-initial-events.jsonl`,`production-initial-deploy.log` |
| Thirty-minute live public/operational observation | Passed,`production-observation-02.jsonl`,`production-observation-02-summary.json`,`production-live-final.json` |
| Final source/schema/grants/runtime/config/unrelated health | Passed,`production-final-deployed-proof.json`,`continuation-source.json` |
| Existing deployment guard regression / new fresh guards | Passed1,319/65assertions; mocked, not deployment substitutes |
| Focused browser lifecycle contracts | Passed2browser cases through1fixture host test; run`82a8f2869b684076b85fd22113825055` |
| Continuation fixture ownership cleanup | Passed15projects extracted from actual run logs; all five fresh states removed;`continuation-cleanup-verification.json` |
| Earlier actual fresh attempts1–4 / local observer-verifier failures | Failed as recorded; never relabeled |
| Protected production provider/data workflows | Not run: no authorized session or supplied official files; owner/trigger table above |
| New synthetic soak / capacity qualification | Not run by explicit updated user scope |
| Final editor diagnostics / diff hygiene | Passed; existing IDE test adapter unavailable, actual npm/container runners supplied test results |

The residual table above is the active handoff, not a request for another
budget decision or permission to rerun reset. Next permitted operational
action is the authorized signed-in, read-first dependency sequence when a
real session/data is available; any actual regression is fixed forward via
`pwsh ./deploy-local.ps1 start -Project seha`, never`-DbReset`. The new
fresh-installation runner, guarded deployment extension, tightly coupled
gate repairs, runtime telemetry and related documentation are implemented
and verified. Parent ledger and protected`.azure/deployment-plan.md`were
not edited by this worker.

## Final parent acceptance and operational handoff

Accepted **complete_with_risk**. The remaining implementation/deployment
objective is complete under the updated scope; no editing worker remains active.
Parent read the execution/failure/cleanup records and reviewed the new
publication/account lock ordering, cancellation and projection boundaries,
runtime telemetry, offline dependency identity checks, actual fresh Deploy
transport and exact-owned cleanup contracts.

Independent parent verification:

- All780build-source entries matched the successful fresh manifest
  `e4495ab05a698ece4ddcc348239da637a393258f48e99ab735f3dbe0cbbd278d`
  before the final documentation-only handoff updates.
- Re-executed the reviewed read-only deployed verifier against actual`seha`:
  all89migration checksums,107tables and exact grants,restricted runtime role,
  and225compiled backend/frontend files matched the successful fresh runtime.
  Receipt:`artifacts/phase07/parent-deployed-proof.json`. App image remains
  `sha256:5e04e79c8ee3468a2c88a1b80311e49142799f966a0d724f38e5b4b7e9ff6495`;
  original PostgreSQL container/volume/network and all seven protected files
  remain unchanged. Three protected images,duplicate recovery and seven
  unrelated workloads were independently reverified.
- Raw production log confirms the actual5/5gate with4,775backend and
  2,393frontend tests. Reset events contain exactly one start and one finish.
  The40,586,150-byte old-schema checkpoint still matches its SHA/0600mode;
  it remains forensic-only,not a new-schema restore source.
- Independently read all60raw samples spanning at least1,800seconds:
  all420HTTP responses match200health/auth-configuration or401protected
  endpoints; every app/PG identity is stable and healthy with no restart/OOM.
  Every cgroup event counter is unchanged;60runtime samples have zero pool
  waiters/foreground queue. Both memory ceilings are`max`,not finite headroom.
- Rechecked zero resources for all15continuation fixture projects and absence
  of all five fresh state directories. The separate network diagnostic was
  also checked absent by its exact container/network IDs. Current host
  readiness remainsHTTP200. Final source diagnostics/diff hygiene passed.

The final parent edits only update this completion, the parent campaign ledger
and the current`seha`section in`docs/operations.md`; they do not change deployed
application/build behavior. The deployed-source manifest remains the historical
build identity,not a claim that later handoff prose was baked into that image.
No additional release or reset is needed for those documentation updates.

The installation operator/product owner now owns the residual table's live
auth/data checks and threshold-triggered maintenance. Sign in with an assigned
account before the read-first collection/import/reconciliation sequence. Keep
external mutations behind their existing qualification/role gates. No successful
protected enterprise-data workflow or100k-capacity claim is made. Any future
actual regression uses diagnostics,focused checks and the normal forward
`start -Project seha`path **without `-DbReset`**.
