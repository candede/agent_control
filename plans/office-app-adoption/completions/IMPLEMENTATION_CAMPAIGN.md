# Office-app adoption implementation campaign

## State and execution boundary

- State: `production_hardening_pending`, phase 03 of 03; authorized local deployment is verified, and real sign-in/provider/journey/observation proof awaits interactive Microsoft authentication.
- Plan folder: `plans/office-app-adoption`.
- Repository/application root: `/Users/candede/repos/agent365/agent_control`.
- Implicated surfaces: backend, frontend, MCP, and local deployment/fixture tooling in this one repository.
- Initial revision: `a0e6585283dfbfe2b1117bb24e27e32ae013a3ec`; worktree was clean before campaign records were created.
- No prior campaign or phase completion records existed.
- User invocation authorizes all phases through readiness for local human testing. The binding roadmap additionally requires actual deployment, first-run qualification, observation, and fix-forward in the authorized local development installation.
- No commit, push, branch creation, external deployment, public package registry, unrelated cleanup, or unrelated resource mutation is authorized.
- No additional user-acceptance or application-owned runtime gate is required within the approved local boundary.
- Required worker settings: `model: "gpt-6.1-sol"`, `reasoning_effort: "xhigh"`, explicitly supplied for every launch. One phase at a time; no nested workers.

## Stable ordered manifest

| Order | Prompt | Completion record | Dependencies | State |
| --- | --- | --- | --- | --- |
| 01 | [Office evidence and adoption API](../01-office-evidence-and-adoption-api.md) | [01 completion](01-office-evidence-and-adoption-api.md) | Binding README decisions | `complete` |
| 02 | [Dashboard and Users adoption](../02-dashboard-and-users-adoption.md) | [02 completion](02-dashboard-and-users-adoption.md) | Implemented phase 01 API and factual record | `complete` |
| 03 | [Verify and deploy locally](../03-verify-and-deploy-local.md) | [03 completion](03-verify-and-deploy-local.md) | Implemented phases 01 and 02 and attempted checks | `production_hardening_pending` |

The denominator is three. All three prompts and the binding README/installed worker contract were read during setup. Linked phase paths are present and unique; dependencies follow manifest order. Supporting documents and completion records are not executable phases.

## Binding SHA-256 identities

| Contract | SHA-256 |
| --- | --- |
| `README.md` | `ef1298282bbebcbb9e85b462fc760c1a75bdb03c9a5b7e028ccedfa3fe485abb` |
| `01-office-evidence-and-adoption-api.md` | `56b581675ec70f1805d2318f402d94c342777924e46511abaf682c489b773d06` |
| `02-dashboard-and-users-adoption.md` | `004f21d5b2e5d56638eb6232b44c8fa9d80742af0f3c0063a72ed061c548a358` |
| `03-verify-and-deploy-local.md` | `ce3198a89ea62cf1840155ad190fe16cd102f73195b50e6f764c18f8c163fee8` |
| Repository `AGENTS.md` | `eb9bb2400afb49e5500666234b385facde6cdbba874285e0f51d90c5a5d8a81e` |
| Installed `implement-folder/SKILL.md` | `6931110e9e65d050fada7b1ba92e1c4c5873aeea87a98c2402bee02b4cbc18c7` |
| Installed `implement-folder/references/step-worker.md` | `7b581abbc75a1218c6740ec82693dd4043fc0ff9c7202f62c6b26883589511e4` |

Revalidate changed contracts and affected proof selectively on resume. Never treat a completion flag as evidence by itself.

## Verified local environment and resource baseline

Read-only setup on 2026-10-31 verified:

- Host: current macOS workspace; Docker context `desktop-linux`, endpoint `unix:///Users/candede/.docker/run/docker.sock`, engine `29.9.2`.
- Compose project `seha`, services `app` and `postgres`, working directory equal to this repository.
- App container `73b0371816ef7e3dd4d829d1db76bedab3c96fabbbf7436f555cf3a236801ca8`, image `sha256:379778aa5629095edebb0f8d499d1c8c2d0ce73509aa1c0bf88964c70b74a0db`, healthy before campaign.
- PostgreSQL container `05314812fa9289806d5086fcf94d2ad500fda3021cda3b3581c41abf54cfc813`, image `sha256:051f7b7b3abdd564d5d1bd1e8c4b9c1b6e77087d1dd22020ede611c096a272e0`, healthy before campaign.
- Database `agentcontrol`; project data volume `seha_data`, labels identify project `seha` and volume `data`.
- Project network `seha_default`, ID `0687fdd649a831c7e3c89a3fc8cdcd222125ce45ee6628ab235209ad20cb674b`.
- Loopback binding `127.0.0.1:3002 -> 3001/tcp`. Local access is `http://localhost:3002`.
- Existing configured browser/auth origin is `https://mgzftq2n-3002.euw.devtunnels.ms`, with its `/api/auth/callback`. Preserve it and the existing settings/secrets. This reconciles the roadmap's loopback address with the already shared browser origin; no external deployment or new tunnel is authorized.
- Protected unrelated running service: `workiq-demo-redis-state-1`, container `1a7fe51b9587`, image `redis:7.4.11-bookworm`, healthy. Existing stopped containers/images belong to prior work and are not campaign cleanup targets.
- Tools already installed: Node `v24.18.1`, npm `11.16.0`, PowerShell `7.6.6`. No dependency install occurred.

Before phase 03 mutation, reverify exact context/project/services/mounts/database/origin and candidate identity. The authorized reset is database-only via `pwsh ./deploy-local.ps1 start -Project seha -DbReset`; retain volume, settings, credentials and unrelated services. After a successful reset, fix-forward uses `start -Project seha` without `-DbReset`.

## Approved installed dependency baseline

- `$baselineImage = 'agent-control-office-adoption-baseline-4b34cc5b:local'`.
- `$baselineImageId = 'sha256:3f334d1f5324d9655f94cf4c0f0617d71e8a1c37c1b138f8bebe44783fbd50be'`.
- Architecture: `arm64`.
- Existing `seha-operator:local` was verified to contain tsx/Vitest and matching hashes for all four manifests, using `docker run --rm --pull=never --network none --entrypoint node ...`. Its immutable ID was then tagged under the separate campaign baseline above, so deployment cannot overwrite the dependency owner.
- Protected existing browser baseline: `agent-control:permission-browser-test-phase06`, ID `sha256:b4eda044a9e58194703b1aa3e3209d3a7ea9cc219f9df14d36d418db873bb60b`, architecture `arm64`.

| Dependency manifest | SHA-256 |
| --- | --- |
| `package.json` | `289b6aa00bdea3224fcdedcd1a5eb5f768cacf4ade5b0547590b07ba94b6366f` |
| `package-lock.json` | `2a84263c69982d579125b08da7d3da6c455a3e7d47cb07843b368d2fb9f6614a` |
| `backend/package.json` | `acd91a005e43d26a533bd9dd6ebbd6fc54b5fcb50d5f9a078ba15c387d2e5993` |
| `frontend/package.json` | `aecde6451f83aa45e284fbeac06251f7be2bd5f64fb9aa75ccc2a6bb25999785` |

Only the approved Microsoft npm/Python feeds are allowed. Reuse this verified baseline with the existing fixture/deployment owners; do not accept their historical default baseline or install unless a changed manifest or real missing-tool failure requires it.

## Parent decisions and target flow

1. Keep one compact retained Office evidence owner, not a dashboard over replaceable heads or invented agent-derived history.
2. Use the existing saved-source publication/recovery owner and `users` revision. No new Graph scan, provider source, polling framework, manual-start gate, or extra deployment authorization state.
3. Preserve agent contracts/defaults and personal agent report context. Office navigation has its own `adoption=office`, `officeSnapshot`, and `officeBaseline`.
4. One canonical immutable Office capture per provider refresh date/`D28`/`v2`. Semantic replays are no-ops; corrections replace and invalidate, without aliases or dual reads/writes.
5. Freeze paid/group context, exact identity, app dates and coverage. Seven Office apps only; missing/retained/ambiguous evidence is not measured inactivity.
6. Reuse existing actor-bound selected reads, lifecycle/accounting/backup machinery and concrete presentation. Preserve full-group licensed/app totals under app-filtered people/champion drill-down.
7. Local isolated SQL/browser/scale/restore/current-installation fixtures may be created through the checked-in owners. Synthetic data/auth must never enter `seha`.
8. Read-only origin reconciliation above does not widen the operating boundary. Existing browser sessions may be used for ordinary UI/provider proof; secret entry stays in the approved operator workflow, never chat or records.

## Validation and lifecycle actions so far

- `git status --short`: passed, initially clean.
- Contract/dependency SHA-256 capture: passed.
- Installed Node/npm/PowerShell discovery: passed.
- Exact Docker context, project labels, mounts, loopback/public origin, database, volume, network, dependency/browser image verification: passed.
- First Docker inspect template used an unsupported `hasPrefix` function; no mutation occurred. A bounded corrected inspect using Docker's `split` function passed.
- Network-free dependency-manifest comparison: passed, all four match.
- Created only the separate baseline image tag; its exact ID/architecture was rechecked.
- No fixture environment has yet been created. No application reset/deployment has occurred. No feature tests or real first-run proof are claimed.

## Launches, phase evidence and next action

| Phase | Agent ID | Actual launch settings | State |
| --- | --- | --- | --- |
| 01 | `29cacea3-8b62-4052-accf-a2c5acce9a84` | `model: "gpt-6.1-sol"`, `reasoning_effort: "xhigh"` | Complete; parent reviewed report, record and controlling changed contracts |
| 02 | `96fb8e21-ce79-47d1-b3e8-539ffb3d5835` | `model: "gpt-6.1-sol"`, `reasoning_effort: "xhigh"` | Complete with explicit aggregate risk; parent reviewed and repaired duplicate-history admission |
| 03 | `50543c00-e20f-4c1c-8af5-c247a4856502` | `model: "gpt-6.1-sol"`, `reasoning_effort: "xhigh"` | Qualification handoff complete; parent reviewed controlling changes and owns actual local deployment/live verification |

Parent preflight additionally confirmed untouched `/api/health` and `/api/ready` both return HTTP 200 with `{"ok":true}`. This is baseline health only, not feature/first-run proof.

Further read-only preflight:

- Existing database fingerprint: `920ee0e916ccf3fba54515f2a0ab077931480214d092579442be3d5bca4b25be`, operational mode `normal`, database size `385840819` bytes.
- PostgreSQL filesystem free space: `696011260` KiB; local state filesystem free space: `548763884` KiB. Both exceed the existing checkpoint owner's 10 GiB/three-database-size threshold at setup; remeasure at deployment.
- Existing shared browser session remains ordinarily authenticated. Direct navigation loaded existing Agents and Dashboard through the configured tunnel, without creating cookies or fixture authentication.
- Captured the existing agent dashboard's visual baseline in the shared browser: rounded panels, blue active-user/purple active-agent trends, three genuine saved agent observations, latest counts 296 active users and 304 active agents. This is pre-reset baseline/design evidence, not Office proof.
- The first pointer click on the initially hidden/stale shared page timed out; direct navigation/reload restored ordinary reads. No manual provider sync or application mutation was performed.
- Parent read deployment snapshot, preflight, reset-resumption, runtime verification and exact cleanup contracts; the existing owners already keep database-only reset separate from disposable fixture data and preserve project settings/secrets/volume.

### Phase 01 reconciliation

- Parent read the actual completion record, seven-app types/classifier, capture/replay/correction/failure-recovery implementation, selected-read/query/aggregate/paging implementation, immutable DDL/grants, and focused publication/clear/retention/backup wiring hunks.
- The direct two-table domain has one canonical existing-generation head per refresh date. Frozen facts survive source retirement; source vectors and staging leases are fenced; successful source publication precedes independently recoverable derivation. No new provider source, scheduler, runtime gate, aggregate authority, ID alias or migration was introduced.
- Concrete phase 02 contracts exist in `backend/src/types/officeAppAdoption.ts` and `frontend/src/api/officeAppAdoption.ts`. Parent verified organization/full-group denominators remain distinct from app-filtered people/rankings and that all pages bind one actor/query/observation.
- Phase 01's schema fingerprint is `05d36a05ce28de5573541ad107788edaab862688d70ae86ff7de83a9f101a0fc`. Its 41 changed application/test/tooling/doc files were compared by the worker against final SQL image `sha256:0c1c02e92a5ba1a65f22bc30229534687cb22a8c353e9e450678676e7afa7408`; digest `c90ff1a492190e8b883a5b3fb6391c6d7fbbb10fb6c311c17faf39035da79a1c`, receipt `artifacts/office-phase01-source-receipt.json`.
- Verified logs/owner receipt: backend focused 618 tests/13 files, frontend shared transport/details 90 tests/3 files, final isolated Office selector 529 tests/12 files with no failures and backend typecheck exit 0. Backend/frontend typechecks, focused lint and diff hygiene passed as recorded in the phase record.
- Seven earlier SQL attempts failed and were repaired; their failures remain in the phase record. Final owner result is passed, not a relabeling of those attempts.
- Cleanup receipt confirms all eight exact fixture projects have zero containers/networks/volumes and their image tags were removed; baseline, `seha`, project volume and unrelated resources were preserved.
- Parent found no unresolved material design/contract decision. MCP remains agent-specific; UI presentation/navigation and integrated scale/restore/current-installation/live proof remain correctly owned by phases 02/03.
- README and all three phase prompt hashes were rechecked and remain unchanged. No manifest amendment or new acceptance gate.

Parent independently rechecked the protected runtime after phase 01: exact `seha` app/PostgreSQL and unrelated `workiq-demo` Redis containers remain running/healthy, and the separate baseline tag still identifies `sha256:3f334d1f5324d9655f94cf4c0f0617d71e8a1c37c1b138f8bebe44783fbd50be`.

### Phase 03 preparation (not phase execution)

- Existing scale selector currently exercises only `largeTenantUsersReports.test.ts`; phase 03 must add actual Office 100,000-row/full-pagination/count/ranking/query/storage proof, not claim the unchanged selector as Office evidence.
- Existing restore selector runs `largeTenantRestore.test.ts` plus backup tests. Phase 03 must put nonempty Office history, retired original sources, clear/correction fences and revoked reads into that existing restore/reopen owner.
- Existing `fresh-installation-current` delegates to `fresh-installation.ps1`; its compiled `restart-runtime.mjs first-sync` currently proves inventory only. Phase 03 must extend the compiled fixture through ordinary user-source automatic admission/publication/recovery, including both publication orders and reset, not call the Office reconciliation helper directly and label it first-run proof.
- Existing relevant bounds are 100,000 source rows, 250-row/1-MiB batches, 100-row pages, 8-GiB generations and 64-GiB tenant storage. Measure actual Office persistence and twelve-month extrapolation; do not silently change retention/population or add runtime approval/enable gates to hide a capacity failure.
- Aggregate `deploy-local.ps1 check` runs frontend lint/typecheck, backend tests, then frontend tests in an isolated database with a fixed compiled source snapshot. If it stops early, preserve the failed result and attempt only remaining independent checks, rather than duplicate valid aggregates.

### Phase 02 reconciliation and carried risk

- Parent reviewed the factual completion record, one-context/lease/publication/page/history/person hook contracts, Dashboard/Users/detail/context consumers, shared chart extraction, and App/routing/personal-pin/account-cleanup hunks. Parent inspected actual packaged SQL dashboard captures at 1440 and 360 pixels: both domains share existing rounded blue/teal/purple/gold panels and accessible bounded layout.
- Owned implementation is complete. Source-specific Office facts remain separate from agent metrics; all selected pages/facets bind the same observation/query; organization/full-group totals are not page sums or filtered licensed denominators.
- Worker proof for its exact revision: 757 focused frontend tests/15 files; 32/32 focused desktop/mobile browser cases and the same 32 owned cases inside aggregate passed. Full aggregate **failed**: 759 passed, 82 unexpected, 17 skipped / 858; native fixture restart/readback **failed**, seven responses instead of nine. These are concrete current fixture/runtime findings, not proven pre-existing or external.
- Broad failure inventory: `artifacts/office-phase02-final-aggregate.json`; exact failed owner `agent-control-ltdp-ae74f964684c4336ac0471259d8393f8`. This includes current fixture identity admission mismatches, obsolete `/jobs` consumers, missing current mock endpoints, personal-report/cache/navigation expectations and native count drift. Phase 03 must diagnose roots and repair directly coupled implementation/verification contracts, not restore aliases, weaken assertions, invent runtime gates, or falsely report a green aggregate.
- All nine exact browser projects and 27 created image tags are cleaned; no fixture helper remains active. Existing `seha`, volume, configuration, dependency/browser baselines and unrelated services are preserved.
- Parent found one owned correctness gap: duplicate history IDs within a page and duplicate canonical provider dates could be admitted. Repaired the existing owner and added four within/across-page regression cases. New parent checks passed: **24 tests/3 Office files**, frontend typecheck, focused lint and diff hygiene.
- Parent repair changes current artifact identity. Prior browser/source receipts remain historical proof, not a current browser pass; rerun the exact combined browser owner once phase 03's artifact/fixtures stabilize. This is an evidence obligation, not an application authorization gate.
- During capacity qualification, measure actual late-page Office person opening/bookmark work: the current dialog searches bounded group pages again. If the required large-group journey exceeds existing bounds, repair the owning direct flow (reuse already validated frozen facts where available), not add an unapproved analytics/detail platform.
- README and all three phase hashes remain unchanged; manifest denominator remains three. No material scope/architecture/authorization decision is unsettled.

### Phase 03 launch and resumed target preflight

- Launched the one fresh phase 03 worker shown above with machine-enforced GPT-6.1 Sol / `xhigh`. Its bounded assignment extends the existing qualification owners, repairs coupled contracts, writes the factual phase 03 handoff, and leaves deployment/live proof explicitly pending for the parent. It may not mutate `seha`; no nested agents or overlapping heavy fixture owners.
- Parent resumed from this record and rechecked current worktree and all four roadmap hashes: unchanged contracts, preserved prior implementation changes, no commit/branch/reset/deployment.
- Read-only Docker reinspection confirms the exact original `seha` app/PostgreSQL container IDs and images still run healthy, the same `seha_data` volume mounts PostgreSQL, the loopback binding remains `127.0.0.1:3002`, and context/socket remain `desktop-linux` / the recorded local Docker socket.
- The separate dependency and protected browser baseline IDs/arm64 architecture still match. The exact unrelated `workiq-demo` Redis container is unchanged and healthy. Untouched `/api/health` and `/api/ready` remain HTTP 200; these are only baseline health checks.
- Existing guarded `Get-LocalReleaseTarget` / `Get-LocalReleaseObservations` read-only preflight passed at `2026-10-31T20:46:12Z`, with no deployment-owner start/reset call. It confirms the original schema/mode, exact network/volume and configured auth origin. Measured database size is now `675919539` bytes; Docker/host available space is `727252877312` / `574267600896` bytes, exceeding the existing 10-GiB/three-database-size checkpoint bounds.
- Protected settings SHA-256 is `f53a37334778220b2d145e0279211d27683d3cc627d68b02ab30f85e36fc4d04`; Compose environment SHA-256 is `4658a783fb5cca0d8d666829654b8a207cbe7ac452e5784c3951f680df6d0387`. These bind configuration without revealing secrets. Recheck before mutation and verify preserved settings afterward.
- Ordinary browser `/api/me` reports only `AgentControl.Viewer`, with role assignment complete. Read-only `/api/capabilities` reports `graph.users.read`, `graph.licenses.read` and `reports.copilotUsage.read` as application-mode enabled/available/authorized/fresh, `verification=on_demand`, and no recorded operation failure. This establishes the available authorization path, not actual post-reset provider collection or Office success. Existing normal remembered sign-in hint is present; no identity/secret is copied into campaign records and no cookie is created.
- Parent is preparing ordinary existing-session/provider and deployment-owner preflight while the worker performs independent qualification. Do not overlap its heavy owners or deploy mutable source before its stabilized handoff.

### Phase 03 capacity repair in progress

- The active worker reported through same-campaign owner coordination that its faithful 100,000-row capture completed in `111720` ms with heap/RSS `87.7` / `205.6` MB and maximum SQL batch `250` rows / `165936` parameter bytes. These are provisional, exact-attempt measurements awaiting the worker's final evidence, not a completed scale suite.
- The same aggregate attempt hit the unchanged `600`-second bound while reading every people page. The scale owner therefore **failed**; successful capture alone is not full-pagination/capacity proof. Its exact disposable resources were reported cleaned and `seha` untouched.
- Worker is repairing the actual existing read owner with bounded, group-indexed page/count queries and the existing sort-capable Office index, plus fenced staging finalization of the existing immutable observation header. No additional evidence/aggregate table, scheduler, compatibility route or runtime gate is authorized. Do not increase the timeout, truncate the people set or shorten retention to hide this failure.
- Backend/schema repairs invalidate affected phase 01 and browser artifact proof selectively. Phase 03 must requalify the changed capture/immutability/coverage/index/read/restore/first-run contracts, update their owning completion records, and report the new fingerprint/source/artifact identity before parent deployment. Earlier passing evidence remains historical rather than a current-artifact assertion.
- Prior phase owners acknowledged the controlling contracts; they are not concurrently editing or launching review/implementation pools. Phase 03 remains the single implementation owner.

### Phase 03 parent qualification reconciliation

- Worker returned the exact phase 03 record with implementation/qualification complete and **deployment_pending**, not a finished phase. Parent read its changed-contract/attempt/final-source/cleanup/live-handoff evidence and reviewed the actual fenced header/statement guard/narrow grants, source batching/accounting, full-denominator group/people/keyset reads, frozen fact validation/reuse and shared selector/personal-report consumer changes.
- The scale paging failure is repaired in its existing owner, not hidden through changed budgets/population/retention. Current proof traverses all 100,000 people, including 99,000 big-group people in `6936.545088` ms; real indexed seek EXPLAIN returns 100 rows in `0.352` ms. Capture is `113786.825302` ms, peak heap/RSS `87612576` / `208109568` bytes, maximum SQL batch 250 rows / 165936 parameter bytes and people page 68552 bytes. Representative conservative 367-point physical retention extrapolation is `42589569024` bytes; shared domain/reservation/headroom limits remain explicit.
- Final current receipts pass Office/coupled SQL 947 cases, scale 89 cases/full 100k population, restore seven cases, compiled ordinary automatic first-run/reset/restart/recovery, software 9373 backend / 5564 frontend cases, focused Office browser 32 cases, aggregate 841 passed / 17 intentionally skipped / zero unexpected or flaky of 858, and unchanged native nine responses / one active user / two writes. The earlier failed attempts are retained, not relabeled. Phase 02's broader failed aggregate/native receipt is superseded by these current checks; the seventeen deliberate deferred/duplicate-matrix skips remain skipped rather than passes.
- Parent independently used `Get-LocalSourceFiles` to verify **all 1021 supported source inputs**, with zero changed/added/missing files against candidate `fdc06bd67161b219c5e356e2a10ecc995709f6f16552611c5b11ca0ca7aaf118`. Final schema fingerprint is `3d4e39268129fe79f85b4d58e20091f921b2cc7ffc34c0828abd98a3b86c4b84`. Expected final compiled JS SHA-256 is `148e4cdeb37c3100caec43136ce40abbe852aa2f6b3618cd2c98cbb978f68795`, 1009319 bytes; deployed image/configuration identity must be measured separately.
- Parent independently verified all 43 exact phase 03 fixture projects have zero containers/networks/volumes. Worker exact image-tag cleanup remains recorded. The two protected offline baselines and original `seha`/unrelated Redis identities are preserved.
- Guarded read-only target/headroom preflight passed again at `2026-11-01T03:04:44Z`: exact original app/PostgreSQL, project/network/volume/context/socket and configured auth origin unchanged; original schema remains normal. Settings/Compose environment hashes match the protected values above. Database size `675509939` bytes; Docker/host available `722118012928` / `570968670208` bytes exceed existing checkpoint bounds.
- All binding roadmap/dependency hashes remain unchanged, and no material authorization/design decision is unsettled. No new dependency, runtime gate, alias/migration, extra evidence owner, commit/push/branch or synthetic deployed state is introduced. The original database-only clean reset remains expressly authorized.

### Authorized local deployment verified; genuine sign-in pending

- Parent executed the authorized database-only `seha` reset/deployment exactly once through the existing entrypoint and offline baseline. Reset and initialization succeeded; operation is `verified` / reset `completed`. Original PostgreSQL, `seha_data`, configuration/secret paths and unrelated Redis are preserved. No additional tunnel, synthetic data/auth, release gate, registry install or unrelated mutation.
- Deployed app is `f8b81a03f80bb3a97f5616d706ef49a9f4cf3a8f865bf08a88901b1f860a16df`, image `sha256:e10be4461c1d54de7d2c3b2e98d5fbb60b9b3e7609d2754ca7a731f89f95de68`. Actual schema is current `3d4e39268129fe79f85b4d58e20091f921b2cc7ffc34c0828abd98a3b86c4b84`, operational mode normal. Health/readiness/public origin return HTTP 200.
- All **208 actual compiled runtime files** exactly match final fresh06; both loopback and configured public origin serve qualified JS `index-DQUoO3Ix.js`, 1009319 bytes, SHA-256 `148e4cdeb37c3100caec43136ce40abbe852aa2f6b3618cd2c98cbb978f68795`. The settings hash is unchanged; the existing owner regenerated its image-pinned Compose environment with hash `73d11e0422cca581c9fb852c8eebebc49812d011fbfae6313faed3d99d2f6e95`.
- Read-only post-reset verification at `2026-11-01T03:08:41Z` showed zero Office observations/facts and zero saved heads before ordinary sign-in. No agent CSV was imported.
- Parent used the actual application sign-in button and existing remembered hint. Microsoft now requests **Enter password**. Interactive password/MFA must be completed by the user in the browser; no credential/cookie fabrication, auth-policy change or hidden Office prerequisite is allowed.
- Actual session/provider first-run, first Office observation, remaining user/access/navigation journeys and ten-minute post-observation watch are **pending**, not fixture/health-proven. Full deployment/authentication-boundary details are in phase 03's parent receipt. The application is deployed and available for normal sign-in; the campaign is not falsely declared complete.

Next action: user completes the existing Microsoft browser sign-in/password/MFA, without sending secrets to chat. Parent verifies the actual session, automatic real-source/Office convergence before CSV, affected/unaffected journeys and ten-minute observation, then finishes the phase/campaign. Do not repeat the successful database reset; any fix-forward start omits `DbReset`.
