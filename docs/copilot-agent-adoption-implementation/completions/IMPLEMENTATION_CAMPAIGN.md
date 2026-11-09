# Copilot adoption implementation campaign

## Execution contract

- Started November 8, 2026, by explicit `implement-folder` invocation.
- Plan: [approved roadmap](../README.md) and [shared contract](../CONTRACT.md).
- Repository: `/Users/candede/repos/agent365/agent_control`.
- Application roots: `backend`, `mcp`, `frontend`, `scripts`, `infra`, and root deployment files in that repository.
- Initial revision: `ebe238cd03acf51a377cd34b1cb9ea40b8fe63a8`.
- Initial worktree: clean; no prior campaign/completion records existed.
- All six prompts and shared contracts were read; README order, prerequisites, unique completion paths, and file parity were checked.
- Workers: fresh sequential `general-purpose` agents, explicitly launched with model `gpt-6.1-sol` and reasoning effort `xhigh`; no nested workers or reviewer pool.
- No commit, push, branch creation, Azure deployment, unrelated installation changes, or public package registries.
- npm feed: `https://packagefeedproxy.microsoft.io/npm/`; Python feed: `https://packagefeedproxy.microsoft.io/pypi/simple`.

## Stable ordered manifest

Paths are relative to the plan folder. Hashes are SHA-256 of prompt bytes.

| Order | Phase prompt | Prerequisites | Completion record | Prompt SHA-256 | State |
| --- | --- | --- | --- | --- | --- |
| 01 | `01-evidence-apis-and-mcp-reads.md` | None | `completions/01-evidence-apis-and-mcp-reads.md` | `6e1e4d458cc8b0a00c3b482465666d9899a4d4015479754b0b2ebece1aea499c` | complete |
| 02 | `02-safe-discovery-and-agent-descriptions.md` | 01 | `completions/02-safe-discovery-and-agent-descriptions.md` | `3e753cb59980343b44531cb48306f9e4d5d8b2c4b34b2847287d45a610de6273` | complete |
| 03 | `03-adoption-workspace-and-learning-cards.md` | 01, 02 | `completions/03-adoption-workspace-and-learning-cards.md` | `5c6b96dc9feed2eed3a33b33cc62a2c6a34749168df9cb7630d258248b7b3fe5` | complete |
| 04 | `04-ai-guidance-and-customer-starter-kit.md` | 01, 02, 03 | `completions/04-ai-guidance-and-customer-starter-kit.md` | `06590f311a32f8efdb9bde316cc070b481bd212a7aa3eea85fd12663c73bb5b2` | complete_with_risk |
| 05 | `05-end-to-end-and-capacity-verification.md` | 01, 02, 03, 04 | `completions/05-end-to-end-and-capacity-verification.md` | `ff830029834a709f9737b15dda8661152c232a6c13895af88993876af3ee1f89` | complete_with_risk |
| 06 | `06-deploy-seha-and-observe.md` | 05 attempted checks and repair/residual evidence | `completions/06-deploy-seha-and-observe.md` | `fcccc0eddbf2558e9c45ec6ed1d45a5000bbb7058380a661d87c888c9cae68da` | production_hardening_pending |

Binding support hashes:

- `README.md`: `af135030546d7ccaa31d8604a721efc69215d3f6f2c7a5230e91a37713238452`.
- `CONTRACT.md`: `b8ef1438f187dacacbd36e299235019968e929779e2c9d461e605cae34388e35`.

## Outcome and parent decisions

Current flow: saved provider/report evidence -> canonical API-selected reads -> browser analytics and partial MCP coverage -> ad hoc advice.

Target flow: automatic authenticated read-only entry -> independent report/Office contexts -> exact API-owned department opportunities -> current source-qualified safe discovery -> customer-configured AI interpretation -> explicit revision-safe MCP save -> tenant-shared staff MCP content and explicitly employee-shared safe cards -> qualified aggregate group follow-up through MCP. No dedicated Adoption page or manual browser editor.

- Keep one authority per decision: backend owns calculations/storage/privacy/authorization; MCP owns typed transport/guidance; browser uses the API; the configured consumer owns interpretation only.
- No hosted model, second analytics/catalog owner, participant/champion registry, departmental card ACL, compatibility/migration chain, or runtime release/approval/enable gate.
- Exact company plus department includes legitimate nulls. Frozen Office identity/licensing/affiliation stays independent of newer directory/report evidence.
- Cards default to staff-only; explicit employee sharing is tenant-wide. Labels affect relevance, not authorization.
- Existing Viewer/Uploader/Admin roles only. Real active roleless members retain automatic application-read admission and safe catalog access without staff bootstrap.
- Clean reset is authorized only if the implemented optimal current schema requires it. Phase 03 proves it in isolation; phase 06 owns the justified live reset and installed-schema checkpoint attempt.
- No separate acceptance gate exists in the approved roadmap. Do not invent one.
- Required unavailable checks remain explicitly unavailable, with owner, numerical signal and exact resumption action; they are not passing evidence.

## Environments and resource baseline

Execution host is the current macOS workspace, not a remembered Ubuntu machine.

Disposable integration uses checked-in guarded runners, named isolated `agent-control-ltdp-*` projects and their exact owned resources. Read `scripts/large-tenant-tests.ps1`, fixture safeguards and suite contracts before use. Current frontend source must accompany backend fixtures. No live credentials, shared databases, public registry fallback, broad prune or unrelated cleanup.

Authorized local live target, rechecked read-only during setup:

- Docker context: `desktop-linux`; Compose project: `seha`.
- App: `seha-agent-control-app-1`, `127.0.0.1:3002`, image `sha256:f9f58d2d4b2cfa10af311d951cf8dbd50518722e16541ab1de6d2bbef6ddfe80`.
- MCP: `seha-agent-control-mcp-1`, `127.0.0.1:3003`, image `sha256:91a8bc2ff12f49ab4a652da7c5774cfe486a68c32a5b354652d24cc9c5dfc7d8`.
- PostgreSQL: `seha-agent-control-postgres-1`, no host port, image `sha256:051f7b7b3abdd564d5d1bd1e8c4b9c1b6e77087d1dd22020ede611c096a272e0`.
- Network: `seha_default`, ID `0687fdd649a831c7e3c89a3fc8cdcd222125ce45ee6628ab235209ad20cb674b`.
- Installed operator: `seha-operator:local`, `sha256:d75de71b71c044ca2f266d4f174f61c232fbfffd2ea7338d0226112e3f301e63`, arm64. Preserve this identity before operator-tag replacement and checkpoint using its matching schema.
- Recheck volumes/configuration/public resource metadata at rollout; do not infer secrets or copy environment files into records.
- Other running project: `automations-mcp-ui-dev`, five containers. It is out of scope and must remain untouched.

The binding Always-Deploy contract includes exact local SEHA deployment, observation and fix-forward, not Azure or a test-only terminal result. Ordinary local update and justified application-database reset were authorized in README and activated by this invocation. Live actions occur only in phase 06 through the checked-in bounded operator. Never reset volumes or erase revocation authority.

## Validation and lifecycle evidence

- Setup: `git status --short` was empty; revision resolved as above.
- Setup: roadmap SHA-256 hashes recorded above; no manifest amendment.
- Setup: Docker engine/context and exact live container/project/network identities inspected read-only.
- Setup: Node/npm commands available; project `typescript`, `vitest`, and `knip` resolve locally.
- Setup: `pwsh` and Docker available. Phase 01's actual mandated MCP command found Python 3.14.10; no host restore was needed. Linux runtime pytest was concretely missing, then restored through the existing guarded approved-feed test image.
- Phase 01 created seven exact disposable projects; all containers/volumes/networks were inspected absent and only eight owned image tags removed. Installed `seha-operator:local` identity remains unchanged. No live mutation/deployment/reset performed.
- No user-journey, model, capacity, backup, reset or restore proof claimed during setup.
- Phase 01: canonical independent Office/report opportunities and audience SQL, compact Office/adoption MCP bindings, typed browser/Pydantic contracts, policy parity and real fixtures completed. [Factual record](./01-evidence-apis-and-mcp-reads.md) retains failures, repairs, commands, identities and unchanged-root evidence.
- Phase 01 final checks: 1,190 isolated backend tests/26 files, 32 frontend tests, 168 real SDK-to-SQL tests/8 files, 456 MCP tests, 111 required host units; backend/frontend typechecks, Ruff/mypy, frontend lint and Knip passed.
- Phase 01 actual five-call SDK-to-SQL retrieval: 88,066 bytes, 0.449312 seconds, exact 15 negatives/seven positives. Compact-read scale: 10,000 people/500 groups/20 warmed reads, p95 287.146 ms, max aggregate 20,293 bytes. These are isolated measurements, not live/model/restore convergence.

## Current state and exact next action

Campaign: `production_hardening_pending`; phases 01-03 are `complete`; phases 04-05 are `complete_with_risk`; phase 06 is deployed with genuine authenticated journey verification pending.

Parent reviewed the phase-01 record, exact identity SQL reuse, whole-observation
cohort logic, combined selected-read scope/expiry fences, HTTP parsing/policies,
typed browser/MCP registration and preserved Office owners. Required passing
behavior evidence is content-bound in the phase record; no redundant full rerun
was needed. All eight binding prompt/support hashes still match. Parent
`git diff --check` passed. Phase 02 prerequisites are available.

## Phase 02 outcome

Decision: **complete**, explicitly executed with `gpt-6.1-sol` / `xhigh`, no
nested workers, commits, pushes, branches, questions or unrelated reverts.
[Exact factual record](./02-safe-discovery-and-agent-descriptions.md) preserves
the failed hypothesis, repairs, all attempted outcomes, current source hashes,
cross-root impacts, exact resource/image identities and residual ownership.

One backend classification now independently qualifies current organization-created
and Microsoft candidates, including exact report-verified Graph-only Agent Builder,
while linked permitted Graph About describes a native-description-absent candidate.
Search/detail/workplace/preview share this authority; privacy/unsafe/limit
withholding, exact selected-source/current-clock checks and broad staff inventory
are preserved. Roleless/missing-profile first use automatically enters the safe
catalog without a permissions visit, staff grant, manual Sync or approval switch.
Backend, MCP, browser and directly related docs are updated; no schema/content
storage, speculative collector, origin cache or phase-03 implementation.

Final checks: 96 exact host non-DB units; 1,380 isolated backend cases/36 files
(sixteen SDK-only scenarios explicitly skipped there); 187 real SDK-to-API-to-SQL
cases/eight files (all sixteen role/privacy scenarios passed); 94 actual browser
cases, zero failures/flakies, eight unchanged parked provider/security cases;
535 mandatory MCP cases; 714 affected frontend units. Backend/frontend typechecks,
Ruff, both mypy invocations (27 source files), frontend lint, Knip and diff hygiene
passed. Over-limit fixture setup respects staging/publication immutability; SDK
and browser matrix grouping retains every assertion with unchanged or stricter
per-scenario bounds.

All 27 exact phase-02 projects have zero named/fixture-labelled containers,
volumes, networks or images; 43 exact owned tags were identity/arm64-verified and
removed with `--no-prune`. Additional companion tags found by the broader exact-name
scan were corrected and reverified, not hidden. Installed operator/approved browser,
all six dependency manifest/lock hashes, all eight roadmap hashes and running
SEHA/automation identities remain unchanged. No live deployment/reset occurred.

Parent accepted phase 02 after reviewing the single source-qualified classification,
exact report/package origin matching, privacy/unsafe/limit withholding,
continuation and contributor source fences, and the roleless route correction.
The eight parked provider/security browser cases are unrelated, explicitly
unrun cases, not missing discovery proof. Parent diff hygiene passed.

Phase 03 is **complete** at the worker boundary; parent owns integration and
advancement. [Exact completion](./03-adoption-workspace-and-learning-cards.md)
records one tenant content/receipt owner, typed API/MCP/manual browser journeys,
employee-safe finite slots, fresh exact evidence, revision/idempotence/privacy,
current grants/reset/native restore and monotonic real revocation reconciliation.
Final proof: 321 current isolated SQL/lifecycle/SDK cases; 203 broad real SDK
cases; 5,752 frontend cases; 443 mandatory MCP cases; 102 actual browser cases
with eight unchanged parked provider/security skips. Final backend/frontend
typechecks, frontend lint, Knip, Ruff/mypy (28 files) and diff hygiene pass.
23 exact created fixture projects and 39 exact tags were cleaned; protected
operator/browser and live SEHA/automation identities remain unchanged.
No following phase is advanced here. Eight unrelated parked provider/security
cases remain `not_run`; configured-model/capacity measurements remain unknown
for phase 05. Actual authorized local SEHA checkpoint/reset/deployment,
observation and fix-forward remain mandatory phase 06, without an additional
runtime acceptance/enable gate.

## Parent phase 03 acceptance and next action

Parent reviewed durable schema/receipt quotas, tenant/object/revision
authorization, retry/lease/baseline binding, safe employee slots/current sharing,
exact source rendering and prompt handoff. Corrected independent follow-up
Office/report window disclosure in the existing content owner. Missing/partial
report ranges remain unknown. Backend typecheck, **21** required content unit/
route tests and diff hygiene passed. See the phase-03 parent repair record;
phase 05 must revalidate affected integrated follow-up proof against current
source rather than reuse the earlier worker digest.

Next: execute phase 04, delivering one canonical customer asset/recipe owner,
current MCP initialize/tool descriptions, role-aware copy/download controls and
honest harness/client support. Preserve exact current-schema/live rollout
authorization and installed operator checkpoint identity for phase 06.

## Phase 04 completion and current evidence

Phase 04 owned implementation is **complete_with_risk**. Exact
[factual completion](./04-ai-guidance-and-customer-starter-kit.md) records one
canonical shipped customer kit/recipe owner, native MCP initialize/operation
guidance, role-specific copy/download/connection delivery and actual image proof.
No phase 05/06 work was started; their states remain pending and parent owns
advancement.

- Current kit/source version:
  `58a87d618d8e11ab2bbb7b7e3d47207042c998a937d3309416b55266c42f0a35`.
  ZIP: `fdf4fed4fd2fdfea3cfaf6f5ba6a1f45c90724a20c82b3659d72596b8267dec7`.
- Current source aggregate including the parent's follow-up repair:
  `bfe5d52a5df2902a6c325fad8da9bbd8eaf80ddaca396596dd6baa797e4469ba`;
  schema unchanged:
  `159105fb7d890f8888eb7f4f4536e9409a0c10104b8dd09670d1b50dc6d8b6f8`.
- Required MCP suites plus asset tests: **541 passed**; additional discovery
  consumer **4 passed**; required backend metadata/feasibility **57 passed**;
  frontend focused **59 passed**, automatic-entry session **5 passed** and
  policy declaration **2 passed**. Typechecks/build/lint/Knip/Ruff/mypy passed.
- Actual controlled distributed department wire: **13 calls / 87,607 bytes /
  0.727409624 seconds**, complete peers/About then explicit save. This is
  controlled authenticated wire evidence, not SQL/model/production semantics.
- Actual combined browser: **75 passed / 8 existing skips / 1 mobile settings
  deadline failure**; all six new kit cases passed on desktop/mobile. Unchanged
  isolated settings rerun: **10 passed**, no timeout relaxation. Retain the
  first failure and scoped phase-05 timeline/repair trigger.
- Immutable app image canonical bytes/ZIP and installed SDK guidance hashes
  matched current source. Exactly two owned projects and four image tags
  cleaned; zero owned containers/volumes/networks remain. Protected installed
  operator/browser identities and live SEHA/automations containers unchanged.
- Official harness/skills/OAuth sources rechecked November 8, 2026; native
  Studio GitHub Copilot import is documented, other harness support is specific,
  not blanket. Actual attached `sehaAgentControl` own-profile attempt was
  **unavailable: existing MCP connection requires OAuth sign-in**. No customer
  task/model/Studio import or published employee semantic proof claimed.

Next parent-owned action: evaluate this exact phase-04 record, then launch
phase 05 separately with these distributed assets/current source. Revalidate
the parent's affected follow-up SQL instead of reusing the old phase-03 digest.
Phase 06's authorized local checkpoint/deployment/observation remains mandatory;
no extra runtime acceptance/enable/manual-start gate was added.

## Parent phase 04 review and next action

Accepted completed implementation with truthful OAuth/model and combined-load
browser uncertainty. Parent reviewed the single canonical skill/corpus/asset
owner, deterministic self-contained ZIP and generated employee projection,
server guidance, tenant-bound finite connection read and verified-byte browser
copy/download flow. No compatibility owner, new model service or runtime gate.
Parent diff hygiene passed; declared schema remains unchanged.

Next: phase 05 integrates current-source SQL/browser/reset/restore/capacity,
including the parent's independent-window repair and phase-04 combined mobile
settings timeline. Attempt available real-client qualification without
inventing credentials or provisioned paid models. OAuth requires genuine
interactive sign-in; absent identity remains unavailable, not a release veto
or fabricated semantic pass. Continue independent authorized work and phase 06
under the binding exact-local Always-Deploy contract.

## Phase 05 completion and parent handoff

Phase 05 owned implementation is **complete_with_risk**, explicitly executed
by the parent-launched `gpt-6.1-sol` / `xhigh` worker without nested workers,
commits, branches or live mutation. The exact
[completion record](./05-end-to-end-and-capacity-verification.md) contains the
eleven-journey matrix, every attempt, actual traces, candidate identities,
reset/restore and bounded residuals. Phases 01-04 retain their accepted states;
phase 06 remains **pending**, advanced only by the parent.

- Repaired real capture wire serialization/publication revisions in the backend
  authority and both capture projections; strict existing MCP/browser types
  needed no compatibility adapter. Current SDK retrieval, explicit save and
  cross-account browser lifecycle pass.
- Reproduced the settings timing failure, retained trace/timeline, and deferred
  hidden full-schema rendering without weakening deadlines/search/accessibility.
  Final combined browser: **186 passed / 8 preexisting parked**, including
  all **10** settings and **6** kit desktop/mobile cases.
- Required compact capacity: **10,000 people / 500 exact groups**, five warm-ups
  then twenty correct HTTP and SDK reads. Nearest-rank p95 **812.052 ms HTTP /
  1,072.719 ms SDK**; API **21,133 bytes**, envelope **45,703 bytes**, no errors.
  Controlled complete retrieval **15 calls / 92,843 bytes / 77.162 s**;
  explicit brief **16 / 120,593 / 84.623 s**; full cross-account lifecycle
  **26 / 183,959 / 114.595 s**. Auth waits excluded: **0**.
- Parent phase-03 independent-window/unknown-date repair revalidated in actual
  SQL. Fresh **109-table** current schema, automatic sync before/after guarded
  reset, native backup/isolated restore and restart fingerprints pass. Schema
  `159105fb7d890f8888eb7f4f4536e9409a0c10104b8dd09670d1b50dc6d8b6f8`.
- Final frontend **5,763 / 140 files**, full MCP **1,316 / 23 skipped**, current
  discovery **1,370 + 17 / 16 suite-skips**, and coupled backend non-DB
  **154 + 2 selected map cases** pass; typechecks/lint/Knip/build/Ruff/mypy and
  diff hygiene pass. Raw current `mcp-end-to-end` retained **315 passed /
  1 stale map assertion failed** plus passing compact proof. The exact failed
  test was repaired and passes focused and full discovery; the raw failed
  attempt is not relabelled passed.
- Preserved original discovery capacity achieved **100,000 people /
  200,000 agents / 1,000,000 edges**; all four shapes failed `57014` before
  measured samples. Its p95 is **unknown**, not zero. Existing 15-second SQL
  deadline/explicit failure contains it; record specifies owner/trigger/fix-forward.
- One actual attached own-profile read requires MCP-client authentication.
  Real customer-model/Studio and authenticated provider use remain unavailable;
  no semantic pass, paid model provisioning or privileged connection inferred.
- Canonical kit/ZIP remain unchanged. All **563** non-test snapshot inputs and
  **242** compiled runtime files match final isolated app bytes. Current
  verification-input digest is
  `777807ab8e0b45c5ef62d8a1203ef924e647333093dd31115cade9fca47c27a0`;
  runtime-file digest is
  `fa2cf2e1b61883ab49325c908c527c6daa87459014d4f59310d35c48f0ffadac`.
  Exact candidate images are recorded but removed by owned cleanup; rebuild
  attested current source for rollout, not a historical phase-04 image.
- Guarded cleanup plus **27** individually inspected owned tag removals leave
  **0** owned containers/networks/volumes; all **8** live container IDs/images/
  start times and protected operator/browser images remain unchanged.

Next, parent launches phase 06 for the already-authorized exact local SEHA
checkpoint/applicable reset/deployment and at least **15 minutes** observation,
with the recorded residual signals and fix-forward. This is mandatory production
continuation, not a release approval, feature-enable or manual-start gate.

## Parent phase 05 review and live continuation

Parent reviewed canonical inventory/package capture projections and
transaction-pinned publication revisions, lazy complete-schema rendering,
eleven-journey evidence, exact successful 10k/500 compact/workflow budgets,
current-source reset/restore and non-test/compiled candidate byte attestation.
Parent diff hygiene passed. The raw failed aggregate remains failed; its
test-only consumer is repaired and passes the focused/current full discovery
checks, so an identical 20-minute rerun is not required solely for that assertion.

Accepted phase 05 as `complete_with_risk`. Preserve the original larger
100k/200k-agent/1m-edge query timeout and actual unavailable OAuth/model/Studio
boundaries with their existing containment and numerical triggers. No test
status becomes runtime authorization.

Next: execute phase 06 on exact current `desktop-linux` / Compose `seha` only.
Checkpoint using installed operator ID before replacing its tag; rebuild/pin
attested current production bytes and perform the justified current-schema
application-database reset through the guarded operator. Observe at least
15 minutes after final deployment and attempt ordinary automatic first-run,
staff/adoption and safe employee journeys with genuine available authority.
Leave unprovable external journeys explicitly pending; never fabricate
business content, credentials, CSV recovery or model/provider success.

## Phase 06 actual checkpoint, reset and deployed continuation

The explicit parent-launched `gpt-6.1-sol` / `xhigh` worker executed the
authorized **existing local SEHA** lifecycle; no nested worker, question,
commit/push/branch, cloud resource or unrelated installation change.
Only phase 06 is active. The required factual
[phase-06 completion](./06-deploy-seha-and-observe.md) contains detailed target,
security, journey, numeric residual and cleanup evidence.

- Installed matching operator
  `sha256:d75de71b71c044ca2f266d4f174f61c232fbfffd2ea7338d0226112e3f301e63`
  was preserved as `seha-phase06-installed-operator:protected` **before**
  operator-tag replacement. Existing backup helper with this exact operator
  successfully checkpointed installed 107-table schema
  `164aa982a9853aa2ef757991d53632b315ee48196a35596fc84275dd4c939ecd`.
- Restricted `.local/seha/backups/phase06-installed-20261108T2137Z.dump`
  and adjacent receipt remain **0600**, outside git. Actual snapshot
  `2026-11-08T21:31:35.191Z`, receipt created `21:31:39.289Z`; dump
  **11,889,488 bytes**, SHA
  `efe25e9d9de2b63499d2d1bd5e0891d3c3455d37e1361992e3eb04acf2b3c187`,
  receipt SHA
  `5468fb1b1b07ddcb3db7579fd8c60ca9598ece491a09cc15db85bac5521ece03`.
  Old-schema restore **not_run**; current-schema isolated restore proof
  remains separately qualified. No old-schema serving/compatibility path.
- Rebuilt all 563 current production inputs and 242 runtime files with **zero
  mismatches/extras** against phase 05 final attestation. Verification digest
  `777807ab8e0b45c5ef62d8a1203ef924e647333093dd31115cade9fca47c27a0`;
  runtime digest
  `fa2cf2e1b61883ab49325c908c527c6daa87459014d4f59310d35c48f0ffadac`.
  No phase-06 production source change or blind aggregate rerun.
- Real candidate `artifacts/phase06/candidate.json`, SHA
  `5d0567342f819a026e4ab160f87b4f141b012422580590bed04513daeed6a54d`;
  source manifest
  `c7cc54de96d303a6251e737117757f4e0168b87ae0f0f13df0b2eaefb2163175`;
  actual read-only reset preflight
  `20ff8c4b4d4f43fd4bb43a48b85106590a02a7bcfdfc404f05f863cc3b823b98`.
- Actually executed existing `deploy-local.ps1 start -Project seha -DbReset`
  with real candidate/SHA/expected preflight. Final successful deployment
  **2026-11-08T21:34:37.7209880Z**. Persistent operation receipt
  `step=verified`, `resetStatus=completed`, `databaseAction=reset`.
  Reset was performed **once**; no marker/token rewrite or repeated drop.
- New Linux/arm64 installed app
  `sha256:4576f7812e0f6310ffebd0585f0cf77039cd3819ada78ba777fe5e99870684b9`;
  operator
  `sha256:2a4a570866eb23953bf2e2c8d244cf884c362852c12bb44961004e2663a6c364`;
  MCP
  `sha256:102ec81b434beef0826ffbf28c7d7c929d3c95cd3bf2a29d2e4e8de44b74e9fe`.
  Current **109-table** schema
  `159105fb7d890f8888eb7f4f4536e9409a0c10104b8dd09670d1b50dc6d8b6f8`,
  normal mode/effective grants passed.
- PostgreSQL/container/volume/network, project configuration, six MCP
  redirects, encrypted OAuth volume/key binding and privacy settings retained.
  Actual nonzero revocations **0 before/saved/after**; two unrevoked principal
  registrations were not miscounted as revocations. No cutoff manually changed.
- At `21:39Z`, current sessions/directory/inventory/official sets/content were
  zero. Recovery **not proven** because real sign-in is unavailable, not because
  of an added manual-first-sync gate. Scoped genuine CSV originals scan found
  none; old history is protected, not fabricated or silently imported.
- Real Microsoft login reached **Enter password**; existing browser shell had
  expired 401 authority and page remained hidden. Actual user must complete own
  password/MFA and keep the ordinary browser visible/online. Attached MCP
  profile and live public initialize/tools-list require per-user OAuth; both
  wire calls returned **401**. Correct-Origin discovery repeats **3/3 401**.
  Genuine successful staff retrieval/save/member/model/Studio/provider counts
  **0**; semantic/live p95 values **unknown**, not zero.
- Actual served protected-resource metadata matches retained real configured
  MCP origin. All eleven current kit assets and ZIP hash
  `fdf4fed4fd2fdfea3cfaf6f5ba6a1f45c90724a20c82b3659d72596b8267dec7`
  passed, including **3/3** public download repeats. This is deployed asset
  parity, not authenticated catalog/interpretation.
- Current-source isolated content **334** SQL/HTTP/SDK/lifecycle tests passed;
  required 10k/500 compact HTTP p95 **311.398 ms**, SDK p95 **394.325 ms**,
  API **21,133** / envelope **45,703** bytes, five warmups/20 measured each.
  Mocked lifecycle **459 + 276**, focused backend **29**, backend/frontend
  typechecks, frontend lint/Knip passed.
- Exact deployed MCP cold/protected-state passed; same-source synthetic
  OAuth/wire fixture passed **11** lifecycle modes and drain **4.306 s**.
  Burst **4 accepted/60 explicit rejections**, two recovery calls; no OOM.
  Its real result says `passed`, `failures=[]`, `cleaned=true`. Synthetic
  fixtures are explicitly distinct from genuine live authority.
- Full final-deploy observation completed **21:36:20.415265Z →
  21:51:20.427118Z**, **900.012 actual seconds**, ending **1,002.706 seconds**
  after deployment. **16 samples/112 HTTP checks**, **0** unexpected status/
  image/OOM/restart/health results. App logs: **562 requests**, **0 5xx**;
  MCP HTTP error count **unknown** (160 plain lines, no critical markers).
  Authenticated semantic/provider counts remain unknown. Initial wrong-path
  404 observer was stopped, retained and corrected; no defect was invented.
- Both disposable projects have **0 containers/networks/volumes**; exact fixture
  runner cleaned its two tags and four independently verified owned
  content/dependency-alias tags were removed without prune. Protected operator/
  browser images remain. All **five** automation IDs/images/start times and
  PostgreSQL remain unchanged; authorized SEHA remains running.

Deployment/observation/exact cleanup have happened; the outcome is not
**deployment_pending**. Required genuine journeys remain
**production_hardening_pending** until actual authority/intent permits proof.
Exact next action is ordinary own browser/MCP authentication, actual provider
CSV import only if originals exist, genuine author save intent and existing
customer consumer/Studio authentication. Then run the required repeated real
journeys; fix demonstrated defects through their canonical owners, focused
proof, exact local redeploy and new relevant fifteen-minute observation.
This is evidence resumption, **not** customer acceptance, a release veto,
feature-enable, manual sync bootstrap or other invented runtime permission.
Original larger discovery timeout/raw failed E2E/suite-skips remain with their
existing containment, numerical thresholds and exact owners in phase 06.

## Parent final integration checkpoint

Parent reviewed the actual installed-schema backup, immutable candidate and
read-only preflight bindings, single guarded completed reset, retained
PostgreSQL/OAuth/project identities, deployed byte/kit parity, 900.012-second
observation and truthful genuine-authentication limits. All six completion
records exist; manifest denominator/order and all eight binding hashes remain
unchanged. No commit, push or branch was created.

Parent independently confirmed both local app/MCP readiness responses, current
deployed app/MCP container IDs and all five untouched automation containers.
Workspace diagnostics across backend/frontend/MCP source report **no errors**;
`git diff --check` passed. The shared app browser is at ordinary Entra sign-in,
not an authenticated workspace. These checks establish local deployment and
source hygiene, not genuine first-run synchronization or customer-model proof.

Code and isolated local-testing delivery are persistent. Remaining real proof
requires the actual user's ordinary visible browser sign-in/password/MFA and
existing MCP-client OAuth, then genuine authorized reads and explicit
contributor save intent where applicable. Ask only for that real external
authentication/intent boundary; do not reset again, invent approval tokens,
impersonate members or claim the campaign is fully qualified.

## November 9 user-confirmed MCP-only correction

The user clarified: "i didnt want adoption page. i want adoption driven actions
to be taken via mcp server by an ai agent." The parent explained the original
phase-03 browser-workspace scope and asked specifically to remove the page,
navigation/manual editor and browser-only code/tests while retaining MCP tools,
backend evidence/persistence and existing analytics/sync/settings. The actual
structured answer was **true**. This supersedes the earlier browser-authoring
requirements, not the content/evidence/privacy contracts or live target authority.

The manifest still has six phases, the same paths/order/dependencies and the
same completion owners. README/CONTRACT and phases 03/05/06 now describe the
MCP-led workflow. Their new hashes are in the manifest; original hashes and
receipts remain in the dated completion evidence. Phases 01/02/04 prompt bytes
are unchanged. Revalidation is selective: backend calculations, SQL schema,
content lifecycle/permissions and MCP production operations are unchanged;
browser navigation/metadata, removed UI adapters and delivered skill guidance
are requalified. Existing research analytics under Dashboard/Users remain.

Parent removed the page/component, route/view metadata, authorization entry,
manual content adapters, browser-only opportunity adapters, analysis-copy helper,
editor-specific styling/tests and the obsolete fixture selection. Safe learning
in existing employee discovery remains. No replacement page, compatibility route,
new runtime authorization or schema/reset was introduced.

Current correction checks: **5,757 frontend / 139 files**, **70 backend / five
files**, **99 MCP guidance/workflow tests** passed; backend/frontend typechecks,
frontend lint, Knip, built ZIP/hash validation and diagnostics passed. Knip
first caught the now-local status type export; it was localized. The first MCP
attempt retained stale built-kit hashes and a removed-adapter reference in the
existing test bridge. Rebuilding the kit and switching only that bridge to the
existing generic report transport resolved both; no production browser authoring
adapter was reintroduced and no wire assertions were weakened.

New kit version
`0ff4421ef13d308746f680a9748b56f53333df057f1c81ada9346d08a1d4418a`;
ZIP SHA
`d07a4efa3e67dc9de32f02f333df4389282c8d4102f172f233dd2e4fd7b3c931`.
Historical kit/image identities above are not the corrected release identity.

Real authenticated Viewer browser reads before the corrected deployment showed
provider recovery: **4,047**
saved directory people, **1,383** Graph packages, **1,709** native records,
**2,339** Office activity rows and a genuine complete accepted CSV bundle.
A saved automatic incremental run completed all three provider stages.
Current opportunity evidence has **465** groups and **1,591** Office-active
people split exactly into **171** positive / **1,420** no-reported / **0**
unknown agent-evidence people. This is actual available evidence, not proof of
an observed first-ever roleless entry, causal outcomes or successful live saves.

The existing deployment owner completed the corrected **ordinary no-reset
update**. Installed app is
`sha256:9289c8cbaf8383a8101b50be9c72630688c1bb699fe198c53ab844bfdb3547d2`;
MCP is
`sha256:0a795a9d6317d3fb2326780f0fea5861a59db5958667a5f87f42a3c63c8f7417`.
PostgreSQL's exact original container/image and the 109-table current schema
fingerprint remained unchanged. Actual deployment log and source manifest are
`artifacts/phase06/mcp-only-deploy.log` and `mcp-only-source.json`.

At `2026-11-09T06:07:35.410Z`, actual served manifest, all eleven kit assets and
the **51,900-byte** ZIP matched the rebuilt version/hashes above; the served
application bundle no longer contains the removed workspace/editor labels.
All **1,118** non-documentation source-manifest entries matched current bytes;
removed authoring files are absent from that manifest.
`artifacts/phase06/mcp-only-observation/served-assets.json` retains the result.
The existing observer completed **900.004 seconds** against these exact
installed images, from `2026-11-09T06:05:27.351722Z` to
`2026-11-09T06:20:27.355608Z`. All **16 samples / 112 HTTP checks** passed:
zero unexpected HTTP results, image mismatches, unhealthy/stopped/OOM/restart
samples. Its separate evidence root preserves the original observation.

After a normal browser reload, the current session returned 401 and displayed
ordinary sign-in. Starting the normal sign-in reached Microsoft's password
prompt; no password was entered or token borrowed. This is not authenticated
browser absence/data-retention proof for the corrected release. A fresh explicit
MCP server connection attempt initially still reported authentication required.
The browser subsequently became genuinely authenticated as Viewer. Actual
Dashboard, Users, Agents, Sync, MCP settings/customer kit and Office analytics
journeys succeeded with no Adoption navigation/editor or false role warning.
Users and Agents render saved tables; Office returns the same 1,591 active/
2,267 licensed people as MCP. The removed `/adoption` path uses the existing
Page not found UI and working Open Agents link, not a compatibility alias.
`mcp-only-observation/authenticated-browser.json` records focused deployed
proof, not a full browser-suite rerun. No credentials or visibility overrides
were supplied by the agent.

The connection then advertised the current tools, and **14 genuine read-only
MCP calls succeeded** through this chat's configured SEHA connection (the
initial 13-call read flow plus a final saved sync-state check). Three
opportunity reads retained the exact independent Office/report/inventory pins
and identical values: 465 groups and 1,591 Office-active people split into
171 positive / 1,420 no-reported / 0 unknown. Sampled group's counts reconcile:
two positive people were exhausted over two exact-cursor pages; the no-reported
page reports 32 total with one read, not exhausted; unknown returns zero and
no cursor. Office summary independently returns 1,591 active people, 2,267
saved licensed people and seven apps. Office October 11-November 7 and report
October 11-November 9 windows remain explicit and independent.

Current MCP sync state confirms all recovered 4,047/1,383/1,709 saved source
counts, 2,339 Office rows, the completed automatic incremental run and a genuine
accepted CSV bundle after the update. Staff content list correctly returns empty.
Actual self-profile, task-driven safe catalog search and complete unclipped
detail also succeed; one candidate is not a task-fit/access claim or exhaustive
catalog search. No explicit provider collection, business-content mutation or
outreach was submitted; no token borrowing or roleless impersonation was used.

Exact application request events measure the three opportunity HTTP reads at
417/497/330 ms (three-sample HTTP p95 497 ms); discovery reads are 2,511/2,530/
1,620 ms. These are HTTP samples, not SDK end-to-end capacity qualification.
Content-free aggregate evidence is
`artifacts/phase06/mcp-only-observation/live-mcp-reads.json`.
Final read-only inspection confirms the five unrelated containers unchanged,
all 14 live mounts through the existing Docker Desktop-aware verifier, the
network/data-volume identities and protected original operator/0600 backup
checksums intact. Through `2026-11-09T06:22:47.829Z`, 745 application request
events contain zero 5xx or structured error events. MCP has zero error markers
in 193 plain lines; its HTTP error count is unknown, not zero. Optional Docker
health-map/raw host-path and browser-listener inspection issues were repaired
in the checks without runtime changes or relabeling failures as application
passes. Final evidence is `mcp-only-observation/final-system-verification.json`.

The corrected deployment is ready for ordinary local AI/MCP testing. Remaining
qualification is genuine roleless/cross-account and Studio journeys, explicit
contributor intent for real save/share/progress/follow-up, and the original
large-discovery residual. Appropriate account/content owners supply the actual
sessions and requested business operation; the discovery query owner retains
the exact isolated scale diagnosis/rerun action recorded in phase 06. Keep the
campaign `production_hardening_pending`, not fully qualified; never reset again
or turn this evidence bookkeeping into a runtime prerequisite.
