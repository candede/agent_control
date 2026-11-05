# Phase 03 — aggregate verification and rollout

## Phase result and release state

**complete_with_risk.** Independent implementation,
aggregate verification, disposable integration and cleanup are finished. The
agent's two original normal deployment attempts exited **137 with no output**.
The user subsequently deployed and signed in, exposing a real metadata Host
rejection. That repair is now normally deployed and the actual authenticated
browser shows all 62 tools with exact instructions/descriptions. A subsequent
readiness-reporting race is repaired, tested and normally deployed. Final live
observation passed **600.103 seconds / 11 successful samples**, with zero
unexpected HTTP 5xx. Actual authenticated native/model-assisted client selection
remains unperformed; it is not inferred from deterministic SDK/browser proof.

Final live proof and exact deployed identities are in the authoritative campaign
record. The actual signed-in page displayed all 62 tools with exact instructions,
descriptions, schemas and callbacks; refresh issued only the metadata GET.
Saved Agents (1,348 total / 35 rendered rows) and Users (50 rows) loaded without
alerts or forced synchronization. Mobile 360 x 780 had no document overflow.
Public health/discovery and real OAuth/metadata/browser negative boundaries
passed. All seven original key/registry files retained bytes, mode 0600 and
UID/GID, and the original PostgreSQL container/image remains unchanged.
Normal shared-browser reauthentication resolved the stale verification session;
later authenticated reads stayed successful beyond role revalidation. No auth
or provider permission was bypassed. Native PowerShell remains exit 137 in the
agent environment, so both repairs were deployed by the user's normal owner.

- Executed 2026-11-04 in `/Users/candede/repos/agent365/agent_control`, HEAD
  `6266feca`; all pre-existing uncommitted campaign changes were preserved.
- Parent-supplied machine launch: `gpt-6.1-sol`, `reasoning_effort=xhigh`.
  No nested agents, commits, pushes, branches or reverts.
- README SHA-256:
  `3caa68e855bd4a5de2c185a123451ad76cdc8e7119ddb81eddc1095492d8a1b5`.
  Phase prompt SHA-256:
  `df5d94b8465fd464d9d0ec21212da9a8af2fc90753ea3337bed254e99212f0af`.
  Neither contract changed. The parent owns `IMPLEMENTATION_CAMPAIGN.md`;
  this worker deliberately did not edit it.
- No added application approval, feature-enable, manual-start or synchronization
  gate. Authentication, roles, provider permissions and confirmations remain.

### User-deployment follow-up: actual metadata HTTP 421

The authenticated settings page's `metadata_unavailable` was reproduced from the
running application: the fixed `http://mcp:8000` destination generated a Docker
Host that FastMCP correctly rejected with **421 Misdirected Request**. Credential
validation and mounts were already correct. A real Node listener demonstrated
that built-in `fetch` ignores an explicit Host override; native `http.request`
preserved the configured public Host and obtained strictly valid metadata.

The existing API reader now uses native HTTP(S) with the validated public resource
Host, fixed destination and destination-based TLS verification. Metadata-only
auth, no redirects, three-second total cancellation, 4 MiB streaming, strict
parser/binding validation and cancellation remain intact. MCP Host/Origin and
ordinary business authentication were not relaxed.

- New native HTTP Host regression failed before repair.
- **75 focused backend tests passed**, including native header/body stalls and
  existing browser-session/tenant isolation cases; backend typecheck/build passed.
- **15 Python metadata tests passed**, including 421 for the private Host,
  acceptance of the canonical public Host, 403 for an untrusted Origin and no
  business authority from the metadata token. Ruff passed.
- The actual current compiled reader, mounted read-only into a disposable helper
  using the user-deployed application image and read-only mounts, successfully
  read the real deployed MCP: **62 tools, 462 instruction words, ready storage,
  exact resource binding**. This did not replace or restart the actual app.
- The helper was removed; PostgreSQL, app, MCP, original keys/state and unrelated
  Redis remain unchanged. The existing authenticated browser session is intact.
- `git diff --check` passed. No dependencies were installed.

The authoritative campaign record contains the current user-deployed identities
and normal redeployment continuation. Earlier unchanged-deployment statements,
image identities and native-runtime failures below are historical evidence from
before the user's deployment, not current app identity claims.

After the user's normal redeployment, actual authenticated browser/API comparison
confirmed HTTP 200, `available`, 62 tools, 462 instruction words, exact full
instruction/description text and the correct server callback. All seven original
credential/registry files retained their bytes, UID/GID and mode 0600;
PostgreSQL and MCP retained their container identities.

A sampled false storage readiness exposed another campaign-introduced reporting
race: the check cleared the last successful flag before its asynchronous probe.
Two held-probe regressions failed before repair. The existing check now retains
its last completed result while checking, publishing success or failure in its
finalization without suppressing errors. Metadata still never runs the probe or
reads/writes OAuth records. **104 metadata/storage/OAuth/onboarding tests passed**;
Ruff and strict mypy passed. Normal MCP redeployment is still needed.

The saved Agents journey requested normal Entra reauthentication after the app
restart and reached the provider's MFA prompt. No sign-out was clicked and no
authentication control was bypassed. Complete normal authentication after final
redeployment before the saved-read and ten-minute live proof.

## Implemented, deleted and design decisions

Falsifiable hypothesis: the final phase-02 producer/API/page and deployment
binding preserve the 124-operation contract and ordinary first-run flows under
the aggregate suites. Actual aggregate failures exposed three missed consumers:

1. `mcp/tests/test_container_contract.py` still asserted that the MCP overlay
   contained only `mcp`. It now verifies the exact nonsecret API binding and the
   separately conditional, identical, read-only metadata mounts on API/MCP.
   The unchanged API dependency remains PostgreSQL only. No assertion concerning
   OAuth isolation, resource bounds, ownership or storage was removed.
2. `frontend/browser/dataSync.spec.ts` still assumed keyboard focus moved directly
   from Sync to Permissions. Both viewport failures showed focus correctly on the
   new MCP settings button. The test now verifies **both** successive focus stops.
3. The complete route table in `docs/mcp-reference.md` omitted the new browser-only
   settings route. Added `GET /api/mcp/settings`, its Viewer/browser-only policy
   and updated the exact registration count/assertion to **172**. The finite MCP
   business operation count remains **124**, not 172.
4. Parent integration review identified a first-metadata-start lifecycle defect.
   The existing offline runtime suite reproduced an actual three-file Compose
   invocation with only two snapshot/applied inputs and a needless restart on
   the next unchanged start. The existing `Invoke-LocalApplication` owner now
   reconciles the final snapshot command, its ordered file list and context
   applied inputs after configuration/environment save and before configuration
   validation, identity calculation or receipt publication. No second helper
   or deployment owner was introduced. Failure/repair evidence is recorded below.

Deleted the superseded test/documentation assumptions and stale applied-input
bookkeeping. No runtime alias,
adapter, schema, dependency, runner, service, state owner or rollout mechanism
was added. The existing final SDK metadata owner and existing fixture owners
remain authoritative. A failed manual fixture invocation was repaired by supplying
its existing `/evidence` mount, not by changing its SDK or isolation safeguards.

The parent's final optional-file fix is included in rebuilt images:
`mcp/src/agent_control_mcp/config.py` SHA-256
`48fb2535e535363b00cf5d02c8a4f6cddd65a8b1fdeabbdc7ae19991e038b266`.
The installed module inside the rebuilt normal MCP runtime had that exact hash.
Its `OSError` handling remains confined to optional metadata configuration.

### Cross-root impact

| Root | Phase-03 change / checked contract |
| --- | --- |
| `mcp` | Repaired the Compose contract test; complete SDK/metadata/OAuth/workflow suite and strict static checks exercised the final parent fix. Runtime code unchanged in this phase. |
| `backend` | Repaired the exact route-inventory assertion. Actual settings, browser auth, saved reads, workbench, controls, fixture guards and automatic-refresh selectors ran together against isolated SQL, including the real Python SDK leg. |
| `frontend` | Repaired the affected Sync keyboard consumer; full unit suite and affected desktop/mobile browser cases passed. Existing settings page/API/routing contracts unchanged. |
| `scripts` | Reconciled the existing runtime owner's final snapshot/applied Compose inputs after automatic metadata credential setup; added its existing-project/two-start regression. Initial four offline suites passed; the focused follow-up runtime/MCP/applied-input guard suites passed 424/164/113 assertions. No second deployment owner or socket/context shim. |
| `infra` | Existing prepared-secret/API-ingress/isolation contracts remain unchanged; offline Azure suites passed. No live Azure action or compiler proof claimed. |
| `docs` | Completed the missing current API table row/count and this exact record. Prerequisite completion records and plan prompts were preserved. |

No PostgreSQL/OAuth persistence format or lifecycle changed. Retaining those
stores and checking original-key continuity is appropriate; no reset, restore
exercise, migration chain or backup subsystem was introduced.

## Current contract measurements

The fully paginated real SDK capture uses SDK 2.3.0 and the same baseline
serializer: `model_dump(mode="json", by_alias=True, exclude_none=True)`, then
`json.dumps(ensure_ascii=False, separators=(",", ":")).encode("utf-8")`, over
`{"initialize": <complete InitializeResult>, "tools": [<every complete Tool>]}`.

| Measurement | Baseline | Final |
| --- | ---: | ---: |
| Public tools | 124 | **62** |
| Canonical operations preserved exactly once | 124 | **124** |
| Complete discovery UTF-8 bytes | 1,130,328 | **677,526** |
| Exact initialization instruction words | absent | **462** |
| Protected metadata UTF-8 bytes | not applicable | **677,658** |

Discovery reduction is **40.0593456%**. Final discovery SHA-256:
`5b2d01fcba4e710c9c8ba060f7c38d1b0c3b828fc32178ab52a9b20e38950609`.
The phase-01 complete operation mapping and canonical request/result/safety
classifications still pass; no removed public name was restored.

Same-instance metadata equals complete initialize/tool discovery, including exact
instructions, descriptions, schemas and annotations. The valid current catalog
fits the unchanged **4,194,304-byte** metadata limit. Tests cover the exact stream
boundary, total **3-second** deadline/body stalls, cancellation, redirects,
malformed/duplicate/deep input, tenant/role/principal isolation and inert long text.
Complete business output accounting remains bounded independently.

Evidence: `.local/ac-mcp-interface-phase-03/discovery-final.json`,
`discovery-final.measurement.json`, `python-final.xml`,
`final-python-summary.json` and `source-final-hashes.json`.
The last file records 23 relevant current source hashes, all unchanged by the
bounded lifecycle follow-up. `unchanged-owner-hashes.json` records the initial
nine deployment/infrastructure owners: eight remain unchanged; its
`scripts/local-runtime.ps1` entry is superseded by `lifecycle-hashes-after.json`.

## Newly executed verification

Host: macOS 26.7.2 arm64, Python **3.14.10**, Node **24.22.2**.
Application/browser fixture images: Linux arm64, Node **24.20.0**, Python
**3.14.6**, MCP SDK **2.3.0**, FastMCP **4.1.0**, Playwright **1.58.2**.
Pylance was unavailable; conclusions use actual tests, runtime values and strict
static checks. No dependency manifest changed and no host package was installed.
Builds used existing installed dependencies/caches and only approved feed settings.

### Aggregate software checks

```sh
cd mcp
.venv/bin/python -m pytest --basetemp=../.local/ac-mcp-interface-phase-03/container-contract -o addopts='' -q tests/test_container_contract.py
MCP_DISCOVERY_EVIDENCE=../.local/ac-mcp-interface-phase-03/discovery-final.json \
  .venv/bin/python -m pytest \
  --basetemp=../.local/ac-mcp-interface-phase-03/python-final \
  --junitxml=../.local/ac-mcp-interface-phase-03/python-final.xml \
  -o junit_family=legacy
.venv/bin/python -m ruff check src tests
.venv/bin/python -m mypy
cd ..
npm run test --workspace frontend
npm run typecheck --workspace backend
npm run typecheck --workspace frontend
npm run lint --workspace frontend
npm run check:unused
npm run build
git diff --check
```

| Check | Actual result |
| --- | --- |
| Initial MCP aggregate | **failed:** 836 passed / 1 failed / 21 skipped; stale Compose-only assertion above |
| Repaired Compose slice | **passed:** 13 tests, 0.04 seconds |
| Final MCP aggregate | **passed:** 837 passed / 21 skipped, 219.08 seconds; zero failures |
| Ruff / strict mypy | **passed**, mypy covers 22 source files; repeated after repair |
| Full frontend | **passed:** 134 files / 5,686 tests, 132.88 seconds |
| Backend/frontend typechecks, frontend lint | **passed**, relevant checks repeated after repairs |
| `check:unused` | **failed:** two existing Office-adoption exports; details below |
| Root backend/frontend build | **passed**; existing >500 kB frontend chunk warning retained |
| Diff whitespace validation | **passed**, including final repairs |

All 21 Python skips are the existing guarded Azure OAuth-emulator storage cases,
without an approved endpoint. They are unavailable proof, not successful tests.
`check:unused` reports `officeMetricProjection` in
`backend/src/db/officeAppAdoption.ts` and `officeReasons` in
`backend/src/services/officeAppAdoption.ts`. Both files were verified byte-identical
to HEAD and were not edited. This unrelated baseline is not concealed or repaired
as settings work. The build was run independently after Knip's nonzero exit.

### Actual isolated backend / SDK / SQL

Exact project:
`agent-control-ltdp-e1a4efd86cf04928a018365c1a3c24dd`.
Evidence:
`artifacts/large-tenant-data-platform/e1a4efd86cf04928a018365c1a3c24dd`.
Actual PostgreSQL ID:
`52eb6e60467bddc70f912efee849e057d10340edffc31cc7159f5d85c0d1776b`.

Before creation, that exact project's containers, volumes and networks were
absent. Canonical Compose configuration and actual inspected mounts/labels
verified a disk-backed, exact owned volume, PostgreSQL network `none`, 1 GiB/.5
CPU and workload namespace sharing only that PostgreSQL container, 1.5 GiB/1.5
CPU. No ambient/production database credentials were used.

The existing Compose workload ran this combined selection:

```sh
P=agent-control-ltdp-e1a4efd86cf04928a018365c1a3c24dd
D="$PWD/artifacts/large-tenant-data-platform/e1a4efd86cf04928a018365c1a3c24dd"
docker compose --project-directory "$PWD" --env-file "$D/compose.env" \
  -f compose.yaml -f compose.large-tenant-test.yaml -p "$P" --profile test-db \
  run --rm --no-deps --name "$P-backend-final" \
  -v "$D/backend-final-evidence:/evidence" \
  -e AGENT_CONTROL_MCP_SQL_JOURNEY=/opt/mcp/.venv/bin/python \
  -e NODE_OPTIONS=--max-old-space-size=768 --entrypoint npm test-db \
  run test --workspace backend -- \
  src/routes/mcpContractFeasibility.test.ts src/routes/mcpApiAuth.test.ts \
  src/routes/mcpReadContracts.test.ts src/routes/sharedAgentControls.test.ts \
  scripts/largeTenantFixture.test.ts src/routes/mcpSettings.test.ts \
  src/services/mcpSettings.test.ts src/routes/workbench.test.ts \
  src/services/workbenchMetadata.test.ts src/routes/policy.test.ts \
  src/routes/authHttp.test.ts src/routes/dataSync.test.ts \
  src/services/automaticRefreshIntegration.test.ts scripts/fixtureSupport.test.ts \
  --silent=false
```

**Passed: 14 files / 267 tests, 116.15 seconds.** This includes all 46 settings
route/service tests, real sign-in/session regressions, three real-SQL automatic
first-sync/recovery cases and the fixture guards.

The real SDK leg executed **12 journeys / 58 canonical HTTP calls**:
call counts `16,16,8,8,2,2,1,1,1,1,1,1`; **3,321,794** response bytes,
largest **511,010** bytes, slowest **0.380266334 seconds**. Actual public tools
include `inventory`, `users`, `adoption`, `agent_usage`,
`preview_agent_control`, `execute_agent_control` and `get_agent_control`.
Exact IDs, selections, full Unicode/About continuation, 100+1 paging and both
provider effects/control recovery remained synthetic and isolated.

The first invocation was **failed: 260 passed / 7 failed**. Two failures exposed
the missing documentation row; five SDK cases exposed this worker's missing
existing evidence bind. Both causes were repaired, not suppressed. The pure
feasibility slice also passed independently on the host: **20 tests**.
Final logs and `sql-summary.json` distinguish those attempts.

### Desktop/mobile browser, authentication and first-run flows

The existing `cutover-browser-contract` owner selected all four required files:
`mcpSettings.spec.ts,signIn.spec.ts,permissions.spec.ts,dataSync.spec.ts`.
It used the actual built frontend, real session API, actual isolated SQL and
protected loopback Python MCP companion. The settings integration case does
**not** intercept `/api/mcp/settings`; its exact strings and full schema,
callbacks, known port, keyboard/axe/layout, refresh/reload and logout checks passed.

Initial result: **146 selected / 136 passed / 8 existing skips / 2 failed**.
Only the two obsolete Sync keyboard expectations failed. After repair, the
smallest complete affected file was rerun through the same existing owner:

```sh
docker compose --project-directory "$PWD" --env-file "$D/compose.env" \
  -f compose.yaml -f compose.large-tenant-test.yaml -p "$P" --profile test-db \
  run --rm --no-deps --name "$P-browser-final" \
  -v "$D/retest:/evidence" --entrypoint node test-db \
  /app/node_modules/tsx/dist/cli.mjs /app/backend/scripts/largeTenantFixture.ts \
  cutover-browser-contract dataSync.spec.ts
```

**68 passed: 34 desktop / 34 mobile, 83.334 seconds, zero flaky/failed/skipped.**
The other unchanged files retain the same-run **70 passed / 8 skipped** proof:
settings 3+3, sign-in 5+5, permissions 27+27 passed and 4+4 skipped.
Effective final selected coverage is therefore **138 passed / 8 existing skips**,
assembled from these content-relevant runs, **not** a claimed single passing
146-case run. Initial and final JSON/log/screenshot evidence are retained separately.
Playwright base URL was the isolated loopback app; evidence binds were the
campaign directory, never a host-default `/evidence`.

Actual first Agents visits on fresh synthetic desktop/mobile tenants submitted
automatic read-only sync without a Permissions visit, manual start or metadata
visit, then read saved details. Configured-MCP browser/API/Python and unconfigured
tenant navigation both passed. Missing/unusable credentials and metadata outage
isolation are additionally proved by runtime, bounded API and UI failure cases;
the failure UI case intentionally intercepts its response, unlike the real
catalog case. These complementary fixture proofs are not a claim of interactive
production authentication or a production outage exercise.

The eight unchanged `test.fixme` cases concern deferred Security setup, selected
agent investigation, Purview and Defender UI, four cases at each width. They
remain explicitly skipped, not external authentication successes.

### Offline PowerShell and reused MCP lifecycle proof

Native entry points were unavailable; the current offline scripts nevertheless
ran in existing image
`kloudmeta-functions-workspace:pwsh-7.6.8-dotnet-10.0.13`,
`sha256:b3c8da404434d0f3b02cbb15e68374e2ddee71fa8f84c9d6d19d4e93809ca902`.
It is amd64 under local emulation. Each run had network `none`, host UID/GID,
only this repository bind, repository-owned `HOME`/`TMPDIR`, and no Docker socket:

```sh
docker run --rm --network none --user "$(id -u):$(id -g)" \
  --mount "type=bind,source=$PWD,target=$PWD" -w "$PWD" \
  -e TMPDIR="$PWD/.local/ac-mcp-interface-phase-03/pwsh-work" \
  -e HOME="$PWD/.local/ac-mcp-interface-phase-03/pwsh-work" \
  -e PATH=/usr/local/bin:/usr/bin --entrypoint pwsh \
  kloudmeta-functions-workspace:pwsh-7.6.8-dotnet-10.0.13 \
  -NoLogo -NoProfile -File ./scripts/local-runtime.tests.ps1
```

The initial same invocation for `local-mcp.tests.ps1`,
`azure-deployment.unit.tests.ps1` and `azure-deployment.tests.ps1` passed
**389 / 164 / 31 / 306 assertions**, respectively. Docker/Azure/HTTP operations
inside these suites were mocked. They are not literal native runner/deploy,
ARM compilation or live Azure network proof.

The freshly rebuilt MCP test image also passed **161 tests** under network none,
read-only root, non-root 501:20, dropped capabilities, no-new-privileges,
512 MiB/.5 CPU/128 PIDs and its exact owned `/work` bind, including the final
missing-file regressions.

Reused and rechecked phase-02 receipts contain 13 successful driver outcomes plus
authenticated drain: **14 successful executions**, including metadata absence/
recovery and original synthetic key continuity, restart/revoke/reconnect,
capacity and containment. The driver still hashes to
`cedf3b72310fca37a8035976bb7658e79dac217862f388586e0d1165f3acfd5d`.
Capacity remains **4 accepted / 60 expected backpressure** from 64 burst calls,
two recovery calls; drain **3.171432292 seconds < 75 seconds**.
No capacity/OAuth/storage implementation changed here. The optional-file fix was
newly rebuilt/tested; repeating unaffected rotation/load journeys was unnecessary.
This is reused lifecycle evidence, not a newly successful `mcp-container` command.

### Same-phase parent integration lifecycle repair

The bounded follow-up used only the existing offline image and existing
`scripts/local-runtime.tests.ps1`, with `local-mcp.tests.ps1` and
`fresh-installation.tests.ps1` as the directly implicated owners/consumer.
There was **no native-runtime diagnosis, deployment retry or production action**
in this follow-up. Network remained `none`, no Docker socket was mounted, and
all secret/configuration writes were confined to the suite's exact disposable
synthetic root under `artifacts/test-scratch`.

The regression models a retained MCP-enabled project whose original seven
synthetic secret/registry files and deployment receipt already exist, but whose
new metadata credential does not. It runs the actual configuration/snapshot/
deployment owner twice, including construction of a fresh context on the second
start; Docker, MCP build/storage validation and sidecar start are mocked.
The configuration-save and metadata-credential owners themselves are real.

| Signal | Unrepaired owner, exit 1 | Repaired owner, exit 0 |
| --- | ---: | ---: |
| Actual first-start Compose inputs | 3 | 3 |
| Snapshot recorded inputs | 2 | 3 |
| Applied ownership inputs | 2 | 3 |
| Next unchanged start is a no-op | false | true |
| Deployment receipt unchanged on that start | false | true |

The unrepaired run failed with “First metadata start omitted an actually
applied Compose input from ownership evidence.” The repaired regression also
asserts that both validation-time commands/file lists use existing files in the
same frozen snapshot root, ownership evidence matches the first actual app
startup command, all seven retained synthetic files preserve their bytes, and
the new independent metadata credential is generated automatically and is not
rotated. The second start performs no app shutdown/start or schema initialization.
A preliminary fixture-construction error was corrected before the genuine
defect reproduction; it is archived separately, not counted as a product defect.

Final focused offline results: **424 runtime + 164 MCP lifecycle + 113
fresh-installation guard assertions passed**. The original Azure suites were
not rerun: the other eight recorded deployment/infrastructure owners are
unchanged and this repair affects only local bookkeeping. Optional metadata failure
handling, original credential generation/retention and the applied-input guard
owner remain unchanged. No schema or persistence format changed.

Source SHA-256 evidence:

| File | Before / final |
| --- | --- |
| `scripts/local-runtime.ps1`, before repair | `6d389f996b946cdd7aeda02261735d0f7362ebc7e325777c9fed0a6c686b346e` |
| `scripts/local-runtime.ps1`, final | `7d9ea28bd5945b481e069dbd49c656b51b172ed493c10801d709e693cff059fa` |
| `scripts/local-runtime.tests.ps1`, final | `a794cbc8e418558b6a2bd9c5a000b1f0c5d999e7fb5c8a7268fab9153ff155c0` |

Logs/receipts under `.local/ac-mcp-interface-phase-03/`:
`local-runtime-lifecycle-before.log`, `local-lifecycle-final.log`,
`local-runtime-lifecycle-fixture-setup.log`, `lifecycle-hashes-before.json`,
`lifecycle-hashes-after.json` and `lifecycle-verification.json`.
Final `git diff --check` passes. Disposable test roots self-cleaned and the exact
follow-up PowerShell work tree was removed; sanitized evidence is retained.
Release state remains **deployment_pending**, not a successful live rollout.

## Build and input identities

The four installed dependency manifests matched the verified arm64 input
`agent-control-import-fix-eaf8369f-dependencies:local`,
`sha256:7d398a507b26ead060f6fe949abd9b498331f0dae8786e33b42b027d760f9d34`.
It was kept separate from the operator tag. Browser input
`seha-permission-browser:local`,
`sha256:537119809ef81c495519e566018e3c8a078455f6ed3fe0d82a67b0a83c6a1d49`
matched architecture, Playwright/core 1.58.2 and installed browser revisions
Chromium/headless 1208, Firefox 1509, WebKit 2248 and ffmpeg 1011.

| Built image | Immutable identity |
| --- | --- |
| Normal application runtime | `sha256:36d043bcd1e43982103b8735f16bc371d95ebc7c0314a485c5aa625a7bfdc444` |
| Normal MCP runtime, including parent fix | `sha256:4a92ffd4be91c3e88726bec0fa929bc33884e306b0615764cfd3b35842f3334b` |
| Final MCP SDK/test | `sha256:9c76a5f9067f70f4b49e911643daa2978d01b5a24b25fd97944ba17bfe26ab3f` |
| Final browser/API/Python fixture | `sha256:6f292dcbe15e4278531a6a2063924dc4b53846dae3d42db4292a9f4092ea8309` |
| Initial four-spec browser fixture | `sha256:79b173753c7c921237663bcbbd343201a6607ae73b8d8ebb696e26c21819dd10` |

Builds reused the checked-in Dockerfiles/targets, `--provenance=false`, exact
fixture-purpose labels and approved caches. Node builds used `--network none`,
`DEPENDENCY_BASE=agent-control-import-fix-eaf8369f-dependencies:local` and
`REUSE_INSTALLED_DEPENDENCIES=1`; the browser target additionally used the verified
`BROWSER_BASE` and current `MCP_FIXTURE_BASE`. Full commands/logs and eight
intermediate/final identities are in `.local/ac-mcp-interface-phase-03/`.
These are built/tested identities, **not deployed images**. Owned image tags
were cleaned after proof; normal resumption rebuilds through the normal owner.
These historical builds also predate the bounded lifecycle-owner repair above;
application/MCP source hashes are unchanged, and deployment resumption must
rebuild from the repaired current checkout rather than reuse those old images.

## Literal toolkit/deployment attempts and native host diagnosis

All five literal commands below were actually attempted with the verified input
identities and `AGENT_CONTROL_DEPENDENCY_IMAGE` set to the independent dependency
tag. Each exited **137**, before useful PowerShell output:

```sh
pwsh -NoLogo -NoProfile -File ./deploy-local.ps1 check -Project ac-mcp-interface-phase-03
pwsh -NoLogo -NoProfile -File ./scripts/large-tenant-tests.ps1 \
  -Suite mcp-end-to-end \
  -BaselineImage agent-control-import-fix-eaf8369f-dependencies:local \
  -BaselineImageId sha256:7d398a507b26ead060f6fe949abd9b498331f0dae8786e33b42b027d760f9d34
pwsh -NoLogo -NoProfile -File ./scripts/large-tenant-tests.ps1 -Suite mcp-container
pwsh -NoLogo -NoProfile -File ./scripts/large-tenant-tests.ps1 \
  -Suite cutover-browser-contract \
  -BrowserFiles "mcpSettings.spec.ts,signIn.spec.ts,permissions.spec.ts,dataSync.spec.ts" \
  -BaselineImage agent-control-import-fix-eaf8369f-dependencies:local \
  -BaselineImageId sha256:7d398a507b26ead060f6fe949abd9b498331f0dae8786e33b42b027d760f9d34 \
  -BrowserImage seha-permission-browser:local \
  -BrowserImageId sha256:537119809ef81c495519e566018e3c8a078455f6ed3fe0d82a67b0a83c6a1d49
pwsh -NoLogo -NoProfile -File ./deploy-local.ps1 start -Project seha
```

The final exact normal `start` was retried after the initial aggregate source
repairs, before the parent integration lifecycle follow-up: **137**,
zero stdout/stderr bytes, no deployment state/resource/key change.
No native command or deployment was retried during the bounded follow-up.

Bounded diagnosis established:

- Native `pwsh -NoLogo -NoProfile -NonInteractive -Command ...` also exits 137.
- Actual native .NET host
  `/Users/candede/.local/share/mise/dotnet-root/dotnet` receives SIGKILL even for
  `--version` and `--list-runtimes`.
- Correct-runtime-root, cleaned-process-environment PowerShell still exits 137;
  disabling .NET diagnostics/tiered compilation for one process did not help.
- Both executables are arm64 Mach-O and pass read-only `codesign --verify`.
  Existing hostfxr/runtime directories contain 10.0.12 and 10.0.14; disk space
  and installed physical memory were not exhausted. A deliberately incorrect
  `.dotnet` root returned the expected missing-runtime error, not a repair.

**Root cause remains unknown.** No security policy, signatures, xattrs or binaries
were changed; no alternate tool was installed, no Docker socket/context/OS shim
was created and no handwritten production deployment was substituted.
Receipts: `native-runtime*.json`, `runtime-layout.json`,
`literal-entrypoints.json`, `normal-start-final.json`.

## Exact production preflight, continuity and live-proof boundaries

Reverified macOS Docker Desktop `desktop-linux`,
`unix:///Users/candede/.docker/run/docker.sock`, without host/context overrides.
Actual Compose project/service labels, published web 3002 / loopback MCP 3003,
read-only credential mounts, PostgreSQL health and retained resources matched:

| Resource | Preserved identity |
| --- | --- |
| PostgreSQL container | `05314812fa9289806d5086fcf94d2ad500fda3021cda3b3581c41abf54cfc813` |
| PostgreSQL image | `sha256:051f7b7b3abdd564d5d1bd1e8c4b9c1b6e77087d1dd22020ede611c096a272e0` |
| App container | `8f36946c4fea270bb7c6da4ffd10277e706cce21f73e1d4088e96742ebaf5ccc` |
| App image | `sha256:2206234c14e724c034f0d0066c92f338e738107863c096d577db449f0aaf6b14` |
| MCP container | `7135965a51080a392939367c4ca25a708b79c5c6afba9767bc6dd0447c6cea37` |
| MCP image | `sha256:1e348498509d4e955f61c128568d524831e5b8d5f2053edae55a03dee83fd865` |
| Network `seha_default` | `0687fdd649a831c7e3c89a3fc8cdcd222125ce45ee6628ab235209ad20cb674b` |
| Retained volumes | `seha_data`, `seha_mcp-oauth` |

Whitelisted saved settings still specify web
`https://mgzftq2n-3002.euw.devtunnels.ms` and MCP
`https://ddnv5p3z-3003.eun1.devtunnels.ms/mcp`.
Web health/readiness and MCP health/readiness returned HTTP 200 on the correct
host binding. Auth status remains configured with the saved web callback.

The parent browser page at the saved origin showed the ordinary unauthenticated
sign-in form, one sign-in button and no authenticated MCP settings navigation.
No available authenticated session, Viewer/Admin account or Agent Control native
tool connection was found. No credentials were borrowed and no account/grant,
callback, tunnel, OAuth cache or authentication state was changed.

The protected parent continuity receipt was read privately and left untouched.
All seven original OAuth/session/database/tenant-key files remain regular files
with **unchanged bytes, mode and owner**; only boolean results were retained.
Original PostgreSQL/container/volume/network and OAuth state volume identities
were preserved. This does not claim that normal PostgreSQL background bytes
cannot change. The new production `secrets/mcp-metadata` file remains absent
because the normal owner could not execute; it was not manually pre-created.

**Not run:** successful current-source deployment, production key/mount creation,
authenticated live metadata/native discovery equality, saved MCP/browser reads,
actual Viewer/Admin live comparison and the required **>=10-minute
post-deployment observation**. The unchanged old deployment returns 404 for both
new metadata API paths; its good health is not proof of the new feature.
Unexpected-5xx/disclosure/cross-tenant/provider-dispatch counts on the new revision
are **unknown**, not measured zero. Baseline health samples are not substituted
for the missing post-deployment window.

### Native/model-assisted selection

Tool discovery found no connected Agent Control native client/tools. The
available browser is unauthenticated. Availability was checked; **zero model
selection calls** could execute. The requested five-case corpus remains:

| Requested case | Actual chosen tool/action | Schema/result proof |
| --- | --- | --- |
| Saved-agent lookup | unavailable | not executed |
| Full About continuation | unavailable | not executed |
| Usage explanation | unavailable | not executed |
| Saved-job status | unavailable | not executed |
| Administrative preview, synthetic only | unavailable | not executed |

No vendor/client model or baseline-comparison success is claimed. The deterministic
SDK journeys above prove protocol/API behavior, not an LLM's tool-selection quality.

## Cleanup

Exact fixture cleanup verified the actual project/container/image/volume labels
before canonical Compose `down --volumes`. The sole disposable PostgreSQL and
its exact owned disk volume were removed; four workload containers had already
auto-removed. **Zero** containers, volumes and networks remain for that project.
All one-shot image tests, input inspections and offline helpers exited/auto-removed.

Removed **six exact owned image tags**; all **eight recorded distinct image IDs**
are absent (two replaced intermediate IDs were already absent before deletion).
Every present image was checked for the exact phase label, expected tags, absence
of container users and exclusion of protected production/input images. No prune
or force deletion was used.

Removed six phase-owned Python/PowerShell scratch trees and the two explicitly
authorized parent phase-02 scratch trees after preserving their 465/Ruff/mypy
summary. SQL helpers removed their synthetic OAuth/key trees; zero `mcp-sql-*`
directories remain. Sanitized logs, measurements, JSON and browser evidence remain.

Final comparison preserved **all 11 pre-existing containers**, including their
images, names, start times, state and mounts: four running and seven exited.
This includes unrelated `workiq-demo-redis-state-1`. Retained seha resources,
the independent dependency/browser/tooling inputs and original protected keys
are unchanged. Receipts: `cleanup-final.json`, `fixture-cleanup.json`,
`image-cleanup.json`, `continuity-final.json` and `production-before.json`.
No cleanup incident remains open.

## Residuals, owners and exact continuation

| Status / scope | Existing containment and measured threshold | Owner / fix-forward trigger |
| --- | --- | --- |
| **unavailable — native deployment control plane** | Existing production left running, no bypass/shim; literal `start` exits 137 twice. Any one nonzero entry-point exit remains nonpassing. | Deployment-host owner restores a supported native PowerShell/.NET environment without weakening device controls; parent then rechecks exact identities and runs the normal command below. This is the reason for `deployment_pending`, not a new approval gate. |
| **not_run — new-revision live authentication, metadata/native equality, saved reads and observation** | Existing auth/roles/tenant binding remain; no synthetic identities in production and no disabling of automatic sync. New-revision signals remain unknown. Threshold: >=1 unexpected exercised-path 5xx, unauthorized metadata disclosure, cross-tenant catalog, settings-caused provider/control dispatch or failed saved-read canary requires focused fix-forward and renewed observation. | Parent plus actual configured-account/client owner perform ordinary authentication after normal deployment, read-only canaries and >=600 seconds of observation. Until proved, a deployed campaign would be `production_hardening_pending`. |
| **unavailable/inconclusive — model-assisted selection and baseline comparison** | Typed validation, existing permissions/previews/confirmations remain. Threshold: >=1 wrong action/target, unrequested provider/control call or incomplete required paging is a failure, never an omitted attempt. | Native-client owner connects through normal OAuth and records every fixed-corpus attempt/client/model/chosen action/schema/result. Administrative preview remains synthetic-only; production stays read-only. |
| **failed — existing Knip baseline, two exports** | No unrelated code changed; both files equal HEAD, types/tests/build pass. Current measured count is 2. >=1 newly introduced unused item or a demonstrated settings dependency triggers an owning repair. | Office-adoption code owner resolves the existing exports in its own scope; parent retains this nonpassing aggregate result. It is not a deployment veto. |
| **unavailable — 21 guarded Azure storage cases; not_run — live ARM/network/reference proof** | Existing storage authority/readiness fencing and prepared-secret isolation remain. No Azure resource or new storage owner. >=1 authority/isolation/compiler/network mismatch, or storage-readiness failure persisting 60 seconds, requires owning fix-forward. | Future authorized Azure/storage operator supplies its guarded endpoint and performs those checks when that target is actually authorized; not an invented local runtime prerequisite. |
| **skipped — eight existing investigation/security browser fixmes** | No new skip or feature disablement; retained component/unit and MCP protocol proof is separate. Skip count remains 8; any increase or >=1 settings-path regression triggers repair. | Existing Security/investigation UI owner qualifies those four deferred workflows at both widths in their owning scope. |

From the repository root, after the host runtime is repaired and the exact
`desktop-linux` / `seha` preflight is reverified:

```sh
AGENT_CONTROL_DEPENDENCY_IMAGE=agent-control-import-fix-eaf8369f-dependencies:local \
  pwsh -NoLogo -NoProfile -File ./deploy-local.ps1 start -Project seha
```

Do not add `-ConfigureMcp`, reset, destroy, auth clearing or forced schema
recreation. The existing owner must automatically create only the independent
metadata credential, reuse original material, preserve PostgreSQL and deploy
current source. Privately repeat continuity checks, confirm both new read-only
mounts, authenticate normally, refresh native discovery without clearing OAuth,
exercise read-only saved-agent/user/paging/settings journeys, and observe at least
600 seconds. The parent must reconcile campaign state with this exact record.
