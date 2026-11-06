# Phase 04 — seha deployed; individual-user production proof pending

## Current outcome after the confirmed-target continuation

**Campaign state: `production_hardening_pending`. The coherent API/frontend/MCP
cutover and exactly one actual application-database reset are completed.**
The exact user-confirmed Mac installation is running the repaired pinned
`candidate-cutover` release, with current schema/grants, normal operational
mode, empty maintenance controls, preserved PostgreSQL/OAuth volumes and
unchanged protected secrets. Deployment is no longer pending.

Two-roleless-employee/published-channel and control-plane proof remains
open. Native authentication subsequently recovered: 21 real discovery reads
succeeded through the current staff connection, including repeated goal
expansion and a different-member preview. Automatic native OAuth refresh and
successful reads beyond the reference-access lifetime were observed without
another interactive sign-in. A real Viewer browser became authenticated during observation: actual
Settings/SDK metadata and nine self/own-member-preview API reads succeeded.
Automatic live collection and externally submitted accepted webapp report
bundles were also observed. These bounded positive results do not close the
remaining individual-user matrix.
The [live continuation](#confirmed-target-live-continuation-2026-11-06-utc)
below supersedes the earlier target ambiguity, undeployed candidate and
zero-minute status. The original worker's evidence and open residuals below
are retained as a chronological record, not restated as current status.

## Historical pre-confirmation outcome and authority boundary

**Campaign state: `deployment_pending`; live journeys: `production_hardening_pending`.**
This is not a completed deployment, a production acceptance claim or a
test-only substitute for the binding Always-Deploy outcome.

- Assigned worker: `gpt-6.1-sol` / `xhigh`; no nested agents.
- Preserved the pre-existing campaign worktree. No commit, push, branch,
  revert, production deployment/reset/restore or Entra/provider mutation.
- The launch expressly withheld live changes until the parent resolves the
  material host ambiguity. Local read-only inspection is not that answer.
- Only isolated, explicitly owned fixtures and source-pinned candidate images
  were changed. No runtime enable/approval/start/requalification gate was added.
- Parent alone owns `IMPLEMENTATION_CAMPAIGN.md`; this worker did not edit it.

Binding README SHA-256:
`e09a877b4a7a7ec13278c2eae52a8443f70f37b1f0428d4db4439a3ba0c4f519`.
Assigned prompt:
`5ffb99a9146ded336203e535afdf141548487d8912a655f41e44f596ee3ade53`.
Git HEAD is `c28fa870c39a009c2f3537e0db87142739f893e4`, **not** an identity for
the dirty campaign content; the candidate's full source manifest is authoritative.

## Bounded owning-root repairs

| Owner | Change and validation |
| --- | --- |
| `scripts/local-mcp-fixture.ps1` | Build genuine locked fixture Python before key generation; use its immutable image for initial RSA/Fernet and both rotations rather than the unusable macOS venv inside Linux. No fake interpreter or guard bypass. Preserve state/credentials if owned containers cannot be removed; separate workload failures from cleanup failures. Real final fixture passed and cleaned. |
| `scripts/local-deployment.ps1`, `scripts/local-mcp.tests.ps1` | Accept only Docker Desktop's exact `/host_mnt/Users` representation of the expected `/Users` source from either native macOS or the socket-mounted Linux helper. Still require `desktop-linux`, the exact Unix socket, no Docker overrides, exact paths, labels, images, mounts and access. **238** assertions passed, then actual mounted-container journeys passed. |
| `backend/src/services/mcpSettings.ts` | The Node 24.20 aggregate exposed two real uncaught `Readable.toWeb` errors when invalid/oversized bodies were cancelled. Consume the incoming message's async iterator through the existing reader contract instead. Cancellation destroys the native stream; bounded bytes, strict UTF-8, three-second deadline, caller abort, public Host/private TLS identity, binding and API privacy/projection remain unchanged. **71/71** native/service/route tests passed on host Node **24.22.2** and the exact failing container Node **24.20.0**. |
| `backend/scripts/largeTenantFixture.ts`, `.test.ts` | Extend the existing discovery selector with the affected authority, metadata, automatic-sync and persistence files; assert no duplicates. One combined isolated invocation, not a new runner. |
| `backend/scripts/browser-fixture.browser.ts`, `frontend/browser/{permissions.spec.ts,permissionFixtures.ts}` | Six fresh tenant identities: employee/Viewer/Admin × desktop/mobile. Roleless OAuth uses a real-shaped tenant-local UUID and exact enabled-Member response while all unintended live-provider traffic remains refused. First-use tests bypass the old automatic-refresh **test mock**, not application authorization. Staff automatic capability checks remain legitimate. Scope the legacy Admin quarantine fixture records to their actual tenant; do not feed those records to fresh tenants. Assert persisted real automatic runs/source completion and absence of manual Sync, Permissions navigation and MCP-settings warm-up. |
| `frontend/src/test/appSessionCases.tsx` | Repair four stale metadata payload producers with required effective privacy and scope fields. Do not weaken the production parser. Full frontend **5,722/5,722** passed. |
| `mcp/tests/{test_container_contract.py,test_controls.py}` | Correct current API-only Compose privacy ownership and the canonical **113-operation** catalog, explicitly including the eight discovery operations. Focused **139/139**, then full **1,051 passed/21 skipped**. |
| `backend/src/db/agentDiscoveryQueries.ts`, `backend/src/types/agentDiscovery.ts`, `backend/src/services/agentDiscovery.ts` | Delete the unused `discoveryCatalogSql` wrapper, make two SQL fragments and three internal aliases module-local, and use public `DiscoveryProfile` at its actual producer. Every emitted discovery SQL variant and service JavaScript remained byte-identical. No query/schema/selection behavior or compatibility path was added. |
| Documentation | Update the fixture interpreter note in `docs/operations.md`; append owning-contract/hash pointers to completions 01/02/03. No parent-manifest update. |

No phase-04 schema, authentication-cutoff, capability-policy, MCP projection,
privacy-policy, scheduler, source owner, compatibility adapter or dependency
change was introduced. Backend/frontend/MCP/scripts/Compose/infra producer
contracts remain one coherent current implementation.

## Aggregate commands and actual outcomes

Logs are under `artifacts/test-scratch/phase04/`; isolated receipts are under
`artifacts/large-tenant-data-platform/<id>/`.

| Verification | Actual result |
| --- | --- |
| `cd mcp; .venv/bin/python -m pytest -o addopts= --basetemp=../artifacts/test-scratch/phase04/pytest-final -q` | **1,051 passed, 21 skipped**, 328.48 s; `python-aggregate-final.log`. Host Python **3.14.10**. The 21 Azure-storage cases require the guarded emulator; no Azure-storage proof claimed. |
| `mcp/.venv/bin/python -m ruff check mcp/src mcp/tests` | Passed on final code. |
| `mcp/.venv/bin/python -m mypy --config-file mcp/pyproject.toml mcp/src` | Passed, **26** source files. |
| `npm run typecheck --workspace backend` / `frontend` | Both passed on final runtime code; backend rechecked after the final browser-fixture attribution repair. |
| `npm run test --workspace frontend` | **5,722 passed, 136 files**, 139.46 s; `frontend-tests-final.log`. |
| `npm run lint --workspace frontend` | Passed, including final first-use tags/assertions. |
| `npm run check:unused` | **Failed: two unchanged Office-owned exports**, `officeMetricProjection` and `officeReasons`. Initial nine findings were reduced by removing seven campaign-owned unused exports. Office files and `knip.json` exactly match HEAD; no unrelated fix or suppressed finding. |
| `npm run build` | Passed on final runtime code. Existing >500-KB chunk warning retained; JS `index-CJxhyNLZ.js`, 1,032,088 bytes; CSS `index-DSsaMD4I.css`. |
| `git diff --check` | Passed after code and owning-completion updates; rechecked at handoff. |
| Existing `mcp-agent-discovery` selector | Project **`563ac25cf7a24b9780e21bd4046fb662`**, **33 files: 1,315 passed, one failed, one skipped**, 350.40 s; two uncaught metadata cancellation errors. Backend typecheck separately passed, 4,058 ms. Sole assertion failure: independently baselined historical Office restore `selection_invalidated`. The metadata owner subsequently passed the focused 71-case repair on both runtimes; the historical aggregate is still failed, not retrospectively green. |
| Current reset and backup within that selector | **18/18 reset**, **4/4 backup**, **27/27 fixture-selector tests**. Isolated native PostgreSQL restore/schema/count/content check passed, 3,792 ms. No old schema/business dataset restored into production. |
| Focused metadata repair | `npm run test --workspace backend -- src/services/mcpSettings.unit.test.ts src/services/mcpSettings.test.ts src/routes/mcpSettings.unit.test.ts`: **71/71** host and **71/71** in exact Node 24.20 image `agent-control-ltdp-563ac25cf7a24b9780e21bd4046fb662-operator:local`, no uncaught adapter errors. Logs `metadata-host-repair.log`, `metadata-node2420-repair.log`. |
| Existing `mcp-container` selector | Project **`ac-mcp-fixture-a2a89deb88c54a78b844021f`**, evidence **`6762457dc2804d5592db016f0ec3ea5f`**: **235 packaged tests** passed, 89.40 s; all actual journeys/denials/drain passed; exact cleanup `cleaned:true`. |
| Final four-file browser selector | Project **`2b84f27d83b44cca95a297b0a4b1eb37`**: **144 passed, eight skipped, zero failed/flaky** in Chromium, 220.453 s; driver and persisted source assertions passed, 227.70 s. All six fresh first-use cases passed. |
| Bicep compilation | Unavailable: no approved installed Bicep/Azure CLI compiler. No public install/probe or inferred compilation pass. |

Final static batch `phase04-static-final` returned nonzero **only** for the two
truthfully retained Knip findings; its other seven checks returned zero.
No new dependency was installed. Builds reused declared locked cached
dependencies; npm/Python settings and cached build stages use only the approved
Microsoft package-feed proxy.

Earlier failed aggregates remain evidence, not final passes: Python initially
had **1,049 passed/two failed/21 skipped** (327.86 s); the first contract-only
repair had **138 passed/one failed** before the remaining stale operation-set
assertion was corrected, followed by **139/139** and the full result above.
Frontend initially had **5,718 passed/four failed**; focused producer repair
had **five passed/212 deselected-skipped**, then the full **5,722** passed.
Lifecycle assertions first passed **236**, then **238** after the exact
Desktop/helper cases were added. No earlier failed run was overwritten.

### Exact existing guarded runner

Host PowerShell/dotnet was already unusable (exit 137). Runs used the genuine
offline helper `agent-control-phase03-powershell:local`,
`sha256:adc88579e45b094c522501d10d9e5b778954c1bbb29883fe0d40a9c8bdb6386e`:

```sh
docker run --rm --pull=never --network none --user 501:20 --group-add 0 \
  -e HOME=/Users/candede -e PATH=/usr/local/bin:/usr/bin \
  -v "$PWD:$PWD" \
  -v /Users/candede/.docker/run/docker.sock:/Users/candede/.docker/run/docker.sock \
  -w "$PWD" --entrypoint pwsh agent-control-phase03-powershell:local \
  -NoProfile -Command 'function docker {
    & /usr/local/bin/docker --config (Join-Path (Get-Location) "artifacts/test-scratch/roleless-docker-config") @args
  }; & ./scripts/large-tenant-tests.ps1 -Suite <selector> <selector-arguments>'
```

Selectors: `mcp-agent-discovery`, `mcp-container`, and
`cutover-browser-contract -BrowserFiles "mcpSettings.spec.ts,signIn.spec.ts,permissions.spec.ts,dataSync.spec.ts"`.
Node baseline `agent-control-roleless-baseline:local` =
`sha256:cc9f4e9efb6428322b82764ba35c40bbbb49890cd76ef563c7967182d85ba9cd`.
Browser baseline
`agent-control-ltdp-55b8ba2a9e804915bc59384b13bb5b26-permission-browser-test:local` =
`sha256:505480f9b0aee32522714c3b49ce3382cd2037c4e6a41e4f1b84c1177d66aad1`,
arm64 Playwright 1.58.2. Supply their exact `-BaselineImage/-BaselineImageId`
and `-BrowserImage/-BrowserImageId` parameters as in the retained command logs.
No test received production PostgreSQL credentials.

## Browser and first-run evidence

Final project **`2b84f27d83b44cca95a297b0a4b1eb37`** passed **144 cases**,
with **eight skipped, zero failed and zero flaky**. Evidence includes
`permission-browser-results.json`, `result.json` with no failures, the existing
compiled-frontend identity check and workload log
`b056ca0dec5c752f60c9c42aa15d77207e027b4238b64d841029ed1493cf985b.log`.

All six first-use cases passed: employee **211/225 ms**, Viewer **2.2/2.2 s**,
Admin **2.3/2.3 s**, desktop/mobile respectively. The real database postcondition
then verified exactly one automatic, actor-attributed run in **each** fresh
tenant and all expected sources succeeded. Six
`fresh_browser_automatic_sources` receipts explicitly record
`manualSync:false,permissionsVisit:false`. Actual frontend → session →
API → Python SDK metadata cases in the same selection also passed on the
repaired native metadata reader.

The eight skips are the existing four log/identity-resolution/Purview/Defender
scenario cases on both viewports. They are not employee first-use or MCP
metadata passes, and no skipped case is counted as verified.

Earlier attempts are retained, not erased:

- `f60e16919f8942d49975da90c2d37562`: **140 passed, four failed, eight skipped**.
  Employee desktop/mobile passed; the four new staff cases still intercepted
  the automatic-refresh request with the old test mock.
- `e0a98e6493204a4d98647457048d1afc`: **142 passed, two failed, eight skipped**.
  Viewer and employee passed; fresh Admin failed on the legacy synthetic
  Power Platform records attributed to the original tenant. The fixture owner
  now checks the actual `expectedTenantId`.
- One attempted invocation used the nonexistent `-BrowserTestFiles` parameter:
  no journey ran. Another mistakenly used `-Suite browser`, which selects the
  unrelated full lifecycle/browser campaign rather than the four requested
  files. Project `f33a00de178240c3bfe968b1d1dcdaf2` exposed an unrelated Office
  adoption failure, then its exact owned browser workload was stopped;
  guarded cleanup completed. Neither attempt is qualification.

The first-run fixtures have distinct fresh tenant domains
`fresh-{employee|viewer|admin}-{desktop|mobile}.example.invalid`; they are not
real Entra accounts. Employee tenant-local UUID is
`eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee`. The unchanged production verifier sees
enabled `Member`; guest/disabled/unknown rejections remain independently tested.
Employee expected sources are `graph_packages,users`; Viewer/Admin additionally
collect `power_platform`. Persisted runs must be automatic, actor-attributed and
exactly one per fresh tenant. Ordinary staff's automatic capability check is
not a manual permissions step.

## SDK reuse, privacy, relevance and container recovery

- Reuse phase-03 project **`44cb6675533240dbbf0066fe9bb4d935`**: **162 passed,
  seven files, 54 actual SDK clients, 418 business calls**. Work-log SHA-256
  `d3ac92879666029649c0c45a10025877f33ccd665fca65dd8788d16014c87898`.
  This is actual local SQL/API/SDK proof, not a new whole-suite run or a real
  language-model/client/publication result.
- At phase-04 entry, **62/62** phase-03 recorded source files matched.
  Final selective reuse is **58/62**: two changes extend selector/tests only;
  the container fixture has the new real run; metadata transport has the
  dual-Node 71-case proof and current browser rerun. Native projection,
  authentication/business routes and serializers are unchanged.
- Existing 16 privacy/audience combinations remain valid: employee self,
  Viewer/Uploader/Admin preview × both API privacy flags. **80 admission calls**
  and **68 separately refused synthetic provider attempts** are not business
  discovery fetches or successful provider collection; business-discovery
  provider attempts remained **zero**.
- Projection sizes remain EndUser **three tools/four operations/26,552 bytes**,
  Viewer/Uploader **38/90**, Admin **54/113**. Exact SDK text/structured output,
  full paging/About, private/draft safe metadata, actor/subject isolation and
  metadata privacy under outage are prior proof plus focused current coverage,
  not copied policy or synthetic proof of a real employee identity.
- All twelve phase-02 deterministic relevance cases, stored company/department
  filters, pinned report/workplace/source authority, no-match/missing evidence,
  hostile descriptions and tightened policy with existing selections are
  selectively reused. Discovery SQL and emitted service JavaScript are exactly
  identical after unused-export cleanup:
  `discovery-*-unused-cleanup.json`. No huge capacity rerun without a plan-led fix.
- Container receipt records cold OAuth/SDK, two-principal bounded HTTP load,
  MCP restart, retained-old-key encryption rotation, independent confidential
  secret rotation, API restart, revoke, post-restart revoked denial/reconnect,
  signing-key rotation and another revoked denial/reconnect: **11 modes**.
  Graceful drain passed; shutdown **3.9486536 s**, client **4.194853752 s**.
  API/web remained usable with MCP stopped. Insecure state and unprotected
  secret were refused; protected configuration recovered.
- Synthetic HTTP load: two principals, four isolated calls, 64 burst calls
  (**four passed/60 rejected** by real budgets), two recovery calls. This is
  not directory/catalog query-scale or production/provider capacity.
- Actual production-target MCP-image cold storage/resource checks (not a
  `seha` qualification) preceded the
  OAuth-instrumented fixture image. Fixture images were
  `sha256:7e764d485e96c4d228fb855631c4281408a9b0211b7b756f26545496e3a3bf73`
  and
  `sha256:d0d5956441244c54752a44381ee2177cb06c2ec23a6b91f1acdfbbeb2791c9a7`,
  source `7842a662dbf86f59f2796ecd6aa0773d0cabc30ba05d2af068156a832ffa5c14`.
  They were deliberately removed by exact fixture cleanup, not deployed.

## Current schema, reset and recovery

Current schema: **107 tables/81 functions**, fingerprint
`78fa2785984b89e6e95a1c88ad60105138993c49ec517df457bb7f555006dd40`.
The isolated aggregate reverified initialization, runtime grants, protected
revocation authority, interruption/resume and native current-schema backup/
restore. Backup assertions include exact fingerprint/count/content, separate
guarded target, unchanged source after restore, no restored browser sessions,
maintenance/review handling and discarded stale selections.

Only genuinely positive per-principal revocation epochs/cutoffs survive reset
in protected maintenance storage and seed existing `data_principal_epochs`.
No blanket reset cutoff, token timestamp rewriting, permissive grace/wait
period or authentication bypass. A newly verified signed unrevoked bearer
with genuine `iat/nbf=now-300s` works immediately after reset; genuinely revoked
tokens remain refused. The existing owner locks/minimal protected authority
are unchanged.

**This campaign performed no live reset, database loss, restore, production
checkpoint, report import or source rebuild.** The historic local
`resetStatus=completed/step=verified` receipt predates this campaign and is
neither this reset nor authority to replay it.

## Real-client/account/channel matrix

| Journey | Controlled local proof | Real/native/published production result |
| --- | --- | --- |
| Roleless employee self/initial entry | API auth, first-entry, real SDK initialization/list/discovery, privacy/relevance; fresh browser cases as recorded above | **Not run**: no authorized individual interactive provider identity supplied |
| Second employee, different department/company comparisons | Controlled stored-scope and concurrent-user SDK/SQL cases | **Not run**: zero real employee identities qualified |
| Viewer/Admin first use and saved outage/restart | Fresh browser cases; actual container OAuth/restart and guarded saved-read tests | **Not run** on real individual connections |
| Uploader/Viewer/Admin labeled preview and return to self | Actual SDK/API controlled actor/selected-subject/target-Admin/concurrent cases across privacy settings | **Not run** with authorized separate real staff identities |
| Guest rejection/forged invocation/diagnostics admission | Existing actual API/SDK negative cases pass | **Not run** on a genuine guest published-channel connection |
| Six primary natural-language prompts, twice each; department/company top-three; cross-department/private/draft/no-match/hostile/privacy conversations | Twelve deterministic retrieval cases are not semantic/model proof | **Zero native model attempts**; all requested real prompt repetitions/conversations remain unrun |
| Copilot Studio OAuth and intended published Teams/M365 channel | Local synthetic OAuth/SDK dynamic discovery is not Studio publication | **Not run**: no authorized publication access or two distinct employee connections |
| Genuine report bundle import/export and report-grounded answers | Synthetic accepted-report lineage/selection fixtures only | **Unavailable/unrun**: genuine current report and authorized importer/exporter not provided |

Installed native Copilot CLI was inspected (1.0.105), not invoked in prompt
agent mode: that would violate this launch's no-nested-agents boundary and
would not establish the missing authorized employee identity. No shared
maker/Admin MCP connection, changed chat speaker, deterministic retrieval proxy,
target-role lending or guessed credentials substituted for per-user proof.
No real client tool-cache behavior, conversational quality or privacy leakage
rate is inferred from SDK fixtures.

## Read-only target findings — still needs parent target answer

Receipt: `artifacts/test-scratch/phase04/target-readonly.json`.

| Boundary | Observed, not inferred production authorization |
| --- | --- |
| Docker owner | `desktop-linux`, `unix:///Users/candede/.docker/run/docker.sock`; macOS checkout `/Users/candede/repos/agent365/agent_control` |
| Project/network | `seha` / `seha_default`; all three container working-directory labels bind this checkout |
| App | Port **3002**, `https://mgzftq2n-3002.euw.devtunnels.ms`; image `sha256:3a32deea7d3d59b50c509029a8ded059481a70760ad365e5110fb288367718b9` |
| MCP | Port **3003**, `https://ddnv5p3z-3003.eun1.devtunnels.ms/mcp`; image `sha256:91067e659638b36d53ce8a2188f9cabd6f9f55b3ef5f75d15286ff596e2f8595` |
| PostgreSQL | Image `sha256:051f7b7b3abdd564d5d1bd1e8c4b9c1b6e77087d1dd22020ede611c096a272e0`; volume `seha_data` |
| Protected MCP state | Existing `seha_mcp-oauth`, `seha_mcp-recordings`; secrets, signing/encryption keys and OAuth mounts untouched |
| Saved privacy | `hide_employee_details:false`, `hide_champion_employee:false` including absent-key defaults. No live privacy cycling. Effective **new-revision API** profile remains unverified because no deployment occurred. |
| Existing local database, strictly read-only | `agentcontrol`, mode `normal`, stored fingerprint `ecaed04f0cb13a364def08f14d0664fe0273b003ca2b44ac8df564d03596a11a`, not the candidate fingerprint. No business rows were collected or changed by this inspection. |
| Health | Existing local `/api/health` and `/api/ready` HTTP 200. This is not employee/discovery or deployment proof. |

The roadmap says current production `seha`, not whichever local daemon is
available. Existing Studio documentation contains both historical VPS
instructions and macOS ownership evidence; no authoritative current remote
host was established. No broad SSH/cloud/account probes or secret dumps.

**Parent's single missing answer:** Is the exact Docker Desktop installation
above the current production `seha` boundary, or what exact existing production
host/Docker context is authoritative? Credentials, local existence and a past
reset receipt do not answer that question. This worker cannot invent it.

### Additional read-only lifecycle finding

The exact candidate was also passed to the existing owner with **both**
`-ReadOnly -DbReset`:

```powershell
./deploy-local.ps1 start -Project seha -ReadOnly -DbReset `
  -Candidate ./artifacts/test-scratch/phase04/candidate-release/build.json `
  -CandidateSha256 9aad98d028b731cacc1fede2e53655315e38f49132698b6c9276bd2194ad9fb1
```

It **refused before maintenance/reset/database-preflight operator execution**:
`Release container network/name mismatch`. The recorded PostgreSQL container
is `/seha-postgres-1`, while current Compose and its exact ownership guard
require `/seha-agent-control-postgres-1`. App/MCP already use the current names.
This is not a successful target/preflight binding. Log:
`local-readonly-reset-preflight.log`.

No ownership guard was broadened, legacy alias added, or live container renamed.
Independent inspection of the same receipt-pinned PostgreSQL ID used a strict
`BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY` transaction solely to read the
database/fingerprint/mode shown above:
`local-current-schema-readonly.json`. It does not override the failed preflight.

If the parent confirms this exact Mac as production, the deployment owner must
fresh-reconcile PostgreSQL container
`05314812fa9289806d5086fcf94d2ad500fda3021cda3b3581c41abf54cfc813`
and align its Docker name to the current declaration without replacing its
volume/database, then obtain a fresh guarded read-only preflight. A bounded
same-container rename is the straightforward current-only reconciliation;
**it was not authorized or executed on this launch**. If another host is
authoritative, reconcile that host instead. This requires no second invented
feature/release approval.

## Source-pinned release candidate

The final candidate is prepared with the existing snapshot/build/candidate
owners by `artifacts/test-scratch/phase04/prepare-candidate.ps1 -CandidateName candidate-release`.
Authoritative files:

- `artifacts/test-scratch/phase04/candidate-release/build.json`
- `artifacts/test-scratch/phase04/candidate-release/source-sha256.json`
- `artifacts/test-scratch/phase04/candidate-release/verification.json`
- `artifacts/test-scratch/phase04/candidate-release-build.log`

The existing candidate verifier succeeded. Exact identities:

| Content | SHA-256 / identity |
| --- | --- |
| Candidate JSON | `9aad98d028b731cacc1fede2e53655315e38f49132698b6c9276bd2194ad9fb1` |
| Full source manifest, 1,113 files | `2bc3e5f7e97697decede95595ac1db8a91d72c6bbc0b8d14788bcb92c16b0868` |
| Immutable source snapshot | `artifacts/local-builds/636d25dee30849b78c01bd2cf824cf89/source` |
| Runtime `agent-control-role-discovery-runtime:phase04-release` | `sha256:08fd1480434d8e57da7ea2b27e993bcc44ce9801828ff04bed1e0c8c16211b42` |
| Operator `agent-control-role-discovery-operator:phase04-release` | `sha256:ee1d76a69c99b6916385273532f27611978056a8057d51091f46b113e82fb7f8` |
| MCP `agent-control-role-discovery-mcp:phase04-release` | `sha256:8f0be092893649d984c2ad61af885fa0260fbf521fe51a22a5a170c5d0c2ae08` |
| Compiled output, 223 files | `7aa625a3e7cb5bccfd58fd78daa8ee11d67c8741e0dc734cbf4917ad9c808b22` |
| Packaged database operator CLI | `65091050da474156934d787c06141bfcbf4b7f40ea1d8377868601c0d5bca22b` |
| Schema | `78fa2785984b89e6e95a1c88ad60105138993c49ec517df457bb7f555006dd40` |

All three immutable images carry the full source-manifest label; the existing
verifier rechecked every snapshot file, image ID/label, compiled output,
operator bytes and schema. All 1,113 inventoried files matched the checkout
after preparation. This final completion is deliberately post-build audit
bookkeeping, not an input to its own recursive content hash.
No authoritative production target is bound and nothing is deployed.
Earlier `candidate`/`candidate-final` preparations and logs are comparisons,
not the current release pointer. No new dependencies, runtime switches,
settings/secrets or production image references were applied.

## Residuals, thresholds and ownership

| Actual state | Containment / next owner and trigger |
| --- | --- |
| **Failed, accepted scoped capacity residual** | Actual 100,000 people/200,000 catalog/1,000,000 accepted report edges; search, department popularity, company popularity and combined preview each first failed **57014 at 15 s**. **Zero warmup/measured samples; p95/scanned rows/bytes unknown**, not zero/pass. Existing query owner/parent must use observed plans and a bounded query/materialization/scoped-popularity root repair, then the existing capacity selector. Any **57014**, or shape p95 **>2 s across ≥50 measured requests**, triggers fix-forward. No huge rerun or invented access gate here. |
| **Historical Office restore failure** | Existing Office owner; exact pre-phase-02 image independently reproduced `selection_invalidated`. Current isolated native backup/restore passes, but does not erase this separate historical-read failure. Preserve evidence; no unrelated workaround or test weakening. |
| **Generation ceiling pre-existing failure** | Existing generation/budget owner; raw source `row_count=100001` accepted in the pre-auth-repair baseline. Related quota logic unchanged. Retain the failed evidence and bounded collection/error paths; no claimed repair. |
| **Knip two baseline Office exports / unavailable Bicep** | Office/tooling owners; report exact findings/unavailable compiler. Not runtime feature prerequisites or fake passes. |
| **Deployment pending: host boundary** | Parent resolves the single exact-target question above; operator then uses that installation's current lifecycle and a fresh exact-content/read-only target binding. No extra release acceptance request invented. |
| **Local read-only preflight refused** | Current owner correctly rejects the local PostgreSQL container's superseded Docker name. Only after exact-host confirmation, fresh-reconcile that same container/labels/image/volume and align its name with current Compose, then regenerate preflight. No live rename, compatibility-name allowance or false preflight pass here. |
| **Production hardening pending: identities, report, native/Studio, observation** | Parent/operator with authorized individual employee/staff/guest identities and existing intended channel/report access; run actual workflows without sharing privileged connections or synthesizing history. |
| **Safety/privacy/actor/scope defect in live qualification** | Threshold **one** forbidden field/tool/action, unauthorized successful call, wrong actor/subject/company/department or hidden identity disclosure: contain only the affected unsafe authority through current error/auth paths; root fix, focused test, exact coherent redeploy, repeat affected live journey. |
| **Operational degradation** | Discovery errors **>5% in ten minutes**, or search/popularity p95 **>2 s over ≥50 requests**, trigger owner investigation/fix-forward; separate provider/auth/model latency. Missing traffic is inconclusive. |

Actual production observation: **0 minutes, 0 successful real discovery reads,
0 employee identities, 0 refresh journeys**. Error rate is **undefined (0/0)**;
p95 is **unknown**. Health requests do not count as discovery samples.

## Cleanup and exact continuation

The first MCP attempt `32697f28a8ff40929448e0d2c59f2746`,
project `ac-mcp-fixture-58ab6a785e5d4f2080772cf2`, passed packaged tests but
failed the exact Desktop mount representation check. A coupled cleanup bug
had already removed state while containers remained. Exact label/ID/image/
network/mount ownership was independently reconciled; only its two recorded
containers, internal network and OAuth/recording volumes were removed.
`cleanup-recovery.json` retains the incident. The owner is now repaired.
That first attempt had **235 packaged passes and zero OAuth/SDK journey modes**;
its healthy image is not substituted for the final journey run.
The final MCP fixture's `mcp-result.json` says passed/cleaned with no failures.
Final `artifacts/test-scratch/phase04/cleanup-final.json` reconciles **seven**
exact phase-04 project labels, including failed/interrupted attempts and the
final browser run: **zero remaining owned containers, fixture-client
containers, networks or volumes**. All three original `seha` container IDs,
names and immutable image IDs were unchanged and healthy; mounted volume names
were unchanged. No live PostgreSQL rename occurred.
Evidence, approved cached helpers/dependencies and final immutable candidate
are intentionally retained. Existing `seha` and unrelated resources stay intact.

Final `source-current-verification.json` confirms **all 1,113 candidate-source
files still match the checkout**; selected exact source hashes and observed
static outcomes are also persisted under phase-04 scratch. This post-build
completion file is additional audit evidence, not changed runtime content.

After the parent supplies the exact host boundary:

1. Reconcile the final candidate on that installation owner. If it is not this
   Mac, do not treat local images/paths as remotely deployed or silently
   substitute another host. Use the existing authorized staging/lifecycle.
2. Resolve the specific existing local PostgreSQL-name mismatch above if this
   is the confirmed host; do not broaden ownership or replace its volume.
   Obtain fresh read-only exact-target/content/reset preflight. Coherently
   deploy API/frontend/MCP with the pinned candidate and one guarded
   `agentcontrol` reset through `deploy-local.ps1 start -Project seha -DbReset`
   and its existing candidate/digest/preflight parameters. Never delete the
   PostgreSQL volume or reuse a historical reset receipt.
3. If reset completed but initialization failed, repair and resume **without
   `-DbReset`**. Unknown destructive outcome stays honestly in maintenance
   until recovered; never blindly repeat. Code-only fix-forward also omits it.
4. Preserve settings/secrets/roles/registrations/assignments/consent/callbacks/
   signing/encryption/OAuth storage. Deploy hardening before any necessary
   existing-SP assignment-required No change; no new registration/tenant-wide
   permission. Keep the saved privacy policy, not a live test cycle.
5. Genuine first employee sign-in must automatically publish supported
   application inventory/directory without manual Sync or a privileged visit.
   Record real delegated source gaps. Import only an authorized genuine
   current report; missing reports mean unavailable report answers, not a
   disabled catalog or fabricated usage.
6. Run every still-open per-user self/preview/native/guest/published-channel
   journey. Observe **≥30 minutes and ≥10 successful real discovery reads
   across two employees**, including refresh and unaffected staff reads.
   Retain every real semantic attempt, including both repetitions of each
   primary prompt; do not publish secrets/transcripts or infer success.
7. Apply the numeric fix-forward rules above and persist actual final
   deployment/reset/schema/grant/client/observation evidence. Parent then
   updates its manifest. This record alone does not close phase 04.

## Confirmed-target live continuation — 2026-11-06 UTC

### Actual authority and retained boundaries

The actual user answer was **“This Mac: Docker Desktop desktop-linux, project
seha, app 3002 / MCP 3003.”** This resolves the original host ambiguity.
The existing campaign/README authorization covers this exact installation's
coherent hardening deployment, one deliberate `agentcontrol` reset, and only
necessary assignment-required changes on the existing registrations after
hardening. No second release approval was requested or invented.

The reconciled tenant is `5dc17551-d2fb-4e89-93da-178b52154818`;
existing API appId `b62f0fb2-9348-42c4-8f6b-67b47c350659`;
existing MCP appId `7df4feb9-f721-4fc2-a8c3-7ff8458b3da9`.
Service-principal object IDs remain unknown until authorized control-plane
resolution; appIds were not substituted for them.
The exact Docker socket remains
`unix:///Users/candede/.docker/run/docker.sock`, project/network
`seha` / `seha_default`, with the original named PostgreSQL/OAuth/recording
volumes and the public origins recorded above.

This continuation ran as `gpt-6.1-sol` / `xhigh`, without nested agents.
No commit, push, branch, revert, PostgreSQL service/volume recreation, other
database/host reset, new tenant permission, provider write test, synthetic
production identity/data, or report-history restore was performed.
The parent-owned campaign manifest was not edited.

The original same PostgreSQL container was freshly reconciled against its
ID, immutable image, project/service/root labels, network, `seha_data` mount,
database owner and fingerprint. Only its Docker name was aligned:
`seha-postgres-1` → `seha-agent-control-postgres-1`, at
`2026-11-06T09:39:15.206947Z`. Its ID, image, started-at and mounts were unchanged.
The exact-name guard was not broadened and no compatibility alias was added.
Evidence: `live-postgres-name-alignment.json`, `live-before-containers.json`
and `live-before-database.json` under `artifacts/test-scratch/phase04/`.

The supported old-schema operator created the protected checkpoint
`.local/seha/backups/phase04-before-cutover.dump`, at `09:40:21Z`,
SHA-256 `5f9ecb4d6971192b3ce07b0512a661f95aa4f5f660c930813dede83662352252`.
Its receipt matches the original fingerprint. No restore was performed;
the checkpoint does not replace the authorized clean reset.

`Save-LocalConfiguration` persisted only the previously absent privacy keys
`hide_employee_details:false` and `hide_champion_employee:false`.
Their effective absent-key defaults were already false. No live privacy
cycling, key rotation, credential change or registration/callback change occurred.
All nine protected secret-file HMAC comparisons remain equal after deployment:
API/MCP credentials, signing/encryption/metadata keys, session secret, both
PostgreSQL secrets and protected tenant registry. Nonprivacy saved settings are
unchanged. Evidence: `live-protected-binding-{before,after}.json`.

### Real cutover failures, owning repairs and safe recovery

1. The original pinned release passed guarded read-only reset preflight after
   the name/default normalization. Its first reset command then emitted the
   typed `database_reset_denied`, phase `validation`, **before DROP/CREATE**.
   PostgreSQL reported a SASL response failure. Direct read-only inspection
   still found the old database, owner and original fingerprint; the protected
   maintenance revocation table had not been created. This was not a completed
   reset. The drained app and maintenance markers were retained; unknown
   outcomes were never blindly retried.
2. The root cause was genuine: `pg.Pool.options.password` is nonenumerable.
   Spreading `database.options` silently omitted the protected password from
   both the reset authority client and initialization maintenance pool.
   `backend/scripts/{databaseReset,database}.ts` now explicitly carry
   `password: database.options.password`. No fallback/ambient credential
   workaround or production trust-authentication change was made.
3. Focused real PostgreSQL regression uses deliberately wrong ambient
   `PGPASSWORD` and the genuine protected pool credential. The existing
   isolated fixture was initialized with host **SCRAM-SHA-256**, with zero
   host-trust HBA rules. Final result: **19 reset + 4 backup = 23/23 passed**,
   including reset, current initialization, protected revocation and native
   recovery behavior. Backend typecheck passed. Intermediate failed fixture/
   mocking/offline-build attempts remain recorded, not retrospectively green.
   Evidence: `live-reset-credentials-passed.log`,
   `live-reset-credential-typecheck-final.log` and the exact fixture workload
   log under `artifacts/large-tenant-data-platform/d981d7246b8e4b4e96a0a9594c1bc05a/`.
4. The existing lifecycle owner now provides `Resolve-LocalDeniedReset`.
   It accepts only the original typed pre-DROP validation denial with matching
   candidate/preflight/configuration/PostgreSQL/schema identity and retained
   maintenance/drain state. It preserves the attempted receipt and denial,
   then retains a truthful active `step/resetStatus: denied`. It does not
   convert unknown/drop/create failures into a safe retry. The preserved
   original receipt SHA-256 is
   `bf230c4aa71140531b958e763468781bace7698bef806f2e083995696d846bcb`.
   Active recovery evidence: `live-denied-reset-recovery-current.json`;
   protected adjacent archives stay in `.local/seha/`.
   An initial recovery iteration archived/removed active progress, causing the
   next preflight to correctly reject drained health without a pending receipt.
   The repaired owner retains truthful denied progress. Only the byte-identical
   original archive was restored to an absent active-receipt path, with its hash
   checked, before rerunning the corrected owner. No reset result was fabricated
   and maintenance was never bypassed.
5. The same owner now resumes an exact pending **completed** reset through
   normal start **without `-DbReset`**, using its original bound candidate/
   preflight and never repeating deletion. **459 lifecycle assertions passed**
   (mocked Docker, not deployment proof), including denial/unknown outcome/
   schema mismatch safeguards and no-switch initialization resume.
   `docs/operations.md` documents both owning recovery paths.
6. Final live reset and initialization actually succeeded. The isolated
   `--network none` PowerShell helper subsequently could not reach the host's
   localhost:3002 health listener; it correctly left maintenance and
   `resetStatus: completed`. This was a helper network boundary, not a second
   database failure. Host HTTP health was 200/readiness 503 in maintenance.
   A separate read verified that Docker Desktop `--network host` reaches the
   exact local listener. The exact pinned operation was then resumed **without
   `-DbReset`** using that network. It explicitly logged
   “Resuming the completed reset without repeating deletion,” verified current
   initialization/grants, resumed the app, and deployed/verified MCP.
   No production privacy test or destructive retry was used.

Final focused evidence is reused alongside the earlier aggregates above.
No full aggregate or failed huge-capacity campaign was repeated.

### Exact deployed content and actual reset receipt

The final repair candidate was built through the existing snapshot/build/
candidate owners, not a new build system. Its verifier rechecked the immutable
snapshot, image labels, packaged operator, compiled output and schema before
deployment. At `09:59:06.996277Z`, **all 1,114 final manifest files matched both
the immutable snapshot and checkout**. This appended completion is subsequent
audit bookkeeping, not changed runtime content.
The inventory increase from the original 1,113-file candidate is precisely
the original worker's now-existing phase-04 completion file. The final source
comparison otherwise contains only the six named owning repair/test/runbook
files and the parent's preexisting campaign-audit update.

| Final content | Actual immutable identity |
| --- | --- |
| Candidate | `artifacts/test-scratch/phase04/candidate-cutover/build.json` |
| Candidate SHA-256 | `66b818f16cc33576b810d39f212e0e9479276936832801c4a94f7e5eb171a609` |
| Full source manifest, 1,114 files | `5210cfbf573003b2bdf81564799556c808b957e6ae84e6dbcd94f157d487576e` |
| Immutable source snapshot | `artifacts/local-builds/4b4f93ebfe2d44d28911f65eec7aef10/source` |
| Runtime `agent-control-role-discovery-runtime:phase04-cutover` | `sha256:ead305a676a5fd8c325c58a75d2a655898495b3b0781e41d845d16392443597f` |
| Operator `agent-control-role-discovery-operator:phase04-cutover` | `sha256:564715f159a0e340292512d84190b34b351be38e5eef3955130f57f91d65c4f6` |
| MCP `agent-control-role-discovery-mcp:phase04-cutover` | `sha256:9b8cffe2b7fc3c47f32daaf7d02dc9cb2f5b8f1210795e2ee2cef407dd7ab088` |
| Compiled output, 223 files | `7aa625a3e7cb5bccfd58fd78daa8ee11d67c8741e0dc734cbf4917ad9c808b22` |
| Packaged database operator CLI | `42645e4ea497a989c7c906a82487b50e67743178921533e42aa90b936f462dab` |
| Fresh reset target/content preflight | `05eb42189c208bbef52495cd8eee9e6464c109a462dc36e2738a0e0e459a4c5a` |
| Postdeployment current-schema/grant read-only preflight | `c0c823de20a812eebf2d8bda883f854b4bcc764e8ed24b3e9309c6594e58a9e4` |

Original/intermediate candidates remain historical preparation/failure evidence,
not deployment pointers. `candidate-cutover/verification.json` deliberately
remains its original **predeployment** verifier receipt (`deployed:false`,
`targetBound:false`); it was not rewritten to fabricate deployment evidence.
Actual deployment evidence is the protected `.local/seha/deployment.json`,
`deployment-operation.json`, `mcp-deployment.json`, `mcp-operation.json`,
the live preflight and `live-deployed-identity.json`.

The application operation now records the exact final candidate and preflight,
`databaseAction: reset`, `resetStatus: completed`, **`step: verified`**.
MCP operation/deployment both record the final MCP image and `step: verified`.
`live-cutover-final.log` contains exactly one successful actual reset;
`live-cutover-resume-noreset.log` contains the nondestructive resume.
All prior reset attempts in this continuation failed before deletion.
The pre-campaign historical completed-reset receipt was not used as reset
authorization or counted as this campaign's reset.

The final application database is `agentcontrol`, owned by `agentcontrol_admin`,
with **107 public tables / 81 public functions**, fingerprint
`78fa2785984b89e6e95a1c88ad60105138993c49ec517df457bb7f555006dd40`.
The existing operator verifies the actual schema and runtime-role grants under
both operator and `agentcontrol_app`; postdeployment read-only preflight passed.
`agentcontrol_app` remains nonsuperuser, no create-db/create-role/replication/
bypass-RLS privileges. Operational mode is **normal**; maintenance/control
markers are absent. No old-schema adapter or dual writer was introduced.

The same PostgreSQL container remains
`05314812fa9289806d5086fcf94d2ad500fda3021cda3b3581c41abf54cfc813`,
on the original image, `seha_default` and `seha_data`.
Final app container:
`89b906bb76382b5161e574ee6ca26853ff8a772fb339e1ece53a7dcd300f2b64`;
final MCP container:
`032f54e8a0208ffb25671c683dc1fef128801014878413d446294e66e0d4236f`.
At the initial operational snapshot all three were healthy/running, restart
count zero, no OOM. Evidence: `live-deployed-database.json`,
`live-postdeploy-current-preflight.{json,log}`,
`live-operational-snapshot-initial.json`.

Positive principal revocations were **0 before / 0 after**, with the same empty
digest. The protected maintenance snapshot also has zero rows; runtime cannot
read/change it. Current canonical principal epochs have no manufactured
reset-time entry. No blanket token cutoff, backdated-token wait gate or grace
timestamp spoof was reintroduced. This live zero-revocation installation cannot
itself prove a positive revoked-principal journey; the focused protected
revocation fixtures supply that evidence.

`seha_mcp-oauth` and `seha_mcp-recordings` are retained. The encrypted OAuth
store still contains **11 files / 2,332 bytes**; the current digest is recorded
without raw contents in `live-oauth-storage-after.json`.
Protected signing/encryption/client keys are byte-identical by HMAC comparison.
This proves retained storage/keys, **not** authenticated refresh continuity.
Database-backed browser sessions, selections, saved business data and official
report imports/history were deliberately discarded as authorized.

### Available live proof and genuine authentication boundary

The initial coherent-release read was at `09:55:48.071724Z`.
Both local and public app `/api/health`, `/api/ready`, and MCP `/health`,
`/ready` returned 200. Public OAuth discovery advertises the exact configured
MCP resource/issuer, `Mcp.Access`, authorization-code/refresh-token grants and
PKCE S256. Public `/api/me`, `/api/mcp/settings` and MCP `/diagnostics` each
reject an unauthenticated caller with 401.

Initially the real app browser rendered the ordinary Entra sign-in page after
the standard developer-tunnel notice. No secret/account was filled by this
worker, no fake session or borrowed identity was injected, and no manual
Sync/Permissions warm-up was performed. Reading the **running compiled API
configuration** confirms both effective privacy values are false, matching
saved settings. Later normal browser authentication supplied additional real
Viewer proof below; no database session/CSRF/token was extracted or lent to
another account.

Four legitimate existing-MCP-connection read attempts were made:
`inventory.health` twice (including after observation), `capabilities.list`,
and `report_datasets.history`.
Each was refused by the MCP client before execution:
**“MCP server 'sehaAgentControl' requires authentication. Sign in through your
MCP client's authentication settings.”**
These are four blocked tool-invocation attempts, not successful discovery
reads, not four HTTP discovery failures and not natural-language proof.
No cause is inferred from this client message; retained OAuth files do not
establish that a usable client authorization is currently available.

The exact-tenant Entra portal likewise presents the Microsoft Azure interactive
sign-in form. No authenticated authorized control-plane identity is available
in this worker; host Azure/M365 CLIs and the default Azure CLI profile directory
are absent. Neither existing service
principal's current `appRoleAssignmentRequired` could therefore be read or
changed. It may already be No: **unknown is not Yes or a proven denial**.
The hardened release is now active, so an already-authorized tenant operator
can follow the bounded two-existing-SP procedure in
`infra/entra-id-api-mcp-app-registrations.md` without a second release approval.
Retain explicit staff assignments/consent/callbacks and do not grant runtime
Entra write permissions.

At `09:58:35Z`, strictly read-only first-run source inspection found **0**
directory users, package rows, canonical agents, generations, sync runs/source
jobs, report sets/bundle receipts, capability evidence or principal epochs.
No genuine user had signed in **at that early read**. This changed during the
last minute of the bounded observation and subsequent read-only follow-up;
the early zero-count snapshot is not the final source state.
Evidence: `live-first-run-source-state.json`,
`live-api-effective-privacy.json`, `live-public-admission-metadata.json`.

#### Late real authentication, automatic collection and accepted report

Real browser sign-in callbacks were observed at `10:25:53.072Z`,
`10:27:24.093Z` and `10:28:29.378Z`; the worker did not fill credentials or
select/borrow another account. Current session metadata establishes two
authenticated principals with Viewer/Admin role classes, **not two roleless
employees or two independently exercised native connections**.
The worker's existing approved browser page subsequently reloaded normally to
`/agents` with a genuine **Viewer** session.

Run `6210c3f4-296a-49f5-855f-756339ff930b` started at `10:25:56.080996Z`,
**`automatic:true`, incremental, `clearSavedData:false`**, for users,
Graph packages and Power Platform. Actual complete source publication:
Graph packages **1,373**, at `10:26:36.030297Z`; delegated Power Platform
**1,700**, at `10:26:19.116701Z`. This is real reader/source evidence, not an
assumed tenant-wide permission, provider write test or synthetic fixture.
Observed HTTP routes contained automatic refresh/state polling and **no manual
data-sync start route**; this worker never visited Permissions or pressed Sync.
It proves normal staff automatic collection, **not roleless employee-first
admission**, which remains open.

The first directory attempt reached 3,200 checked users then entered
`waiting_authorization` during renewed browser authentication. At
`10:27:24.214–10:27:24.747Z`, package detail, directory worker and package status
emitted application **401 / `unauthorized`**, on the original automatic run.
This interruption is real, not a passing initial run or an inferred Graph
permission denial. Its historical run remains truthfully partial. The same
normal flow admitted subsequent **automatic** directory runs, without a manual
start: `a838c0f3-0762-4ce6-8ca2-167566a2fe54` completed at `10:29:19.113710Z`
(4,054 checked users); `fc459292-4722-4b7a-8c72-fb768b47edd0` completed at
`10:31:41.130757Z` (3,984 checked users). These are per-run checks, **not additive
tenant headcount**. The latter saved **2,328 D28 Microsoft 365 Copilot activity
rows**, resolved 231 agent people, reported 16 not found and zero lookup
failures. No revoked authority was revived or old run falsely marked complete.

At `10:29:59.351332Z`, a separate normal **webapp** import accepted complete set
`15dbf376-a947-49a4-b84c-d84cc39ccd8c`, period **2026-10-01–2026-10-30**,
`period_provenance: activity_range`. The complete bundle receipt and three
accepted ingestions record **538 user-agent rows / 304 agent rows / 296 user
rows**, using the existing API integration client. This worker neither supplied
nor imported a file and did not restore discarded history. Receipt/channel/
period acceptance is directly observed; the uploading operator/parent owns the
original export's genuine-source provenance, which this worker did not inspect.
No new runtime approval/import gate was added. Subsequent discovery responses
actually report **`reportState: available`**, not the earlier missing state.
At the final `10:35:09.723870Z` handoff snapshot, **three retained report sets /
three complete bundle receipts** were present. The detailed row/period counts
above describe the first observed accepted bundle only; the uploading operator/
parent owns all original export provenance. These snapshots are not additive
activity totals. This worker submitted none of them.

Evidence: `live-real-automatic-collection{,-latest,-final}.json`,
`live-real-read-route-counts.json`, `live-source-errors-safe.json`,
`live-provider-coverage-telemetry.json`, `live-report-and-source-handoff.json`.
Unknown-field minimization warnings were retained, not treated as silently
captured fields or discovery failures: at `10:28:00Z`, **17** Power Platform and
**3,807** Graph-package warning events, respectively **18,642 / 11,421 omitted
field observations**. These are repeated field observations, not missing-agent
counts. The existing allowlist continues to omit unsupported fields; any needed
field contract belongs to its provider/schema owner, not a raw-payload fallback.

#### Actual Viewer settings, self-service and own-member preview

Authenticated `/api/me` and `/api/mcp/settings` returned 200. The same Viewer
actor remained unchanged before/after each bounded read sequence (opaque actor
hash `a936682a1cf1475c7b6a559c49cea4f739f65b616ee414aea110e687c107d28f`).
Settings state was **available**, encrypted storage ready, privacy **false/false**
and scope **`end_user_and_preview`**, matching saved/running API settings.
Its actual SDK-generated role projection exposed **38 tools**, including
`agent_catalog`, `my_workplace`, `my_discovery_profile`, `preview_end_user`;
Admin execute-control tools were absent. This is a genuine Viewer Settings/
SDK metadata read, **not** a native MCP connection or EndUser/Admin schema pass.

Nine actual typed browser/API discovery reads all returned **200**:
profile, workplace (both scopes, limit three), BRD-review search, a paraphrased
goal search, explicit own-member preview profile/workplace, then normal self
profile, and a fresh search plus its exact selected detail. The initial four
public-browser elapsed times were
**1,422 / 615 / 726 / 685 ms**; these include tunnel/browser overhead and are
not an API p95 measurement. One search returned **two candidates** with exactly
the current safe card keys; the paraphrase returned
`no_matching_saved_evidence`, **zero candidates**, without fabricated relevance.
The actual saved caller has a company but **no saved department**:
company top three returned **three**, department stayed unavailable/empty, and
own-champion status was unavailable despite report availability.
The exact detail used that search's saved selection and returned only
`context/selection/privacy/agent/description/nextCursor`, with the same safe
card keys, absent description and no continuation. The two search candidates'
lifecycles were **unknown / published**; neither is claimed as a private/draft
qualification pass.

Explicit preview targeted the same real staff member's saved identity, not a
borrowed member token. It returned `mode: preview / subject: selected_member`;
the subsequent normal read returned `self / current_account`; saved company/
department equality and unchanged actor were checked within the browser.
This proves a real own-member preview round trip and honest company-only
fallback. It does **not** prove a different target's self-service, two-department
isolation, guest policy, Uploader/Admin preview or semantic conversation quality.
No full descriptions, contacts, raw goals/tokens or conversation transcript are
copied into this record.

| Required real journey | Actual continuation result |
| --- | --- |
| Two employees, different departments; stored own company/department; private/draft/search/no-match/own champion/top-three scopes | **0 roleless employee reads**; nine Viewer reads do not prove this two-employee matrix |
| Separate Viewer/Uploader/Admin self/preview, immutable actor/subject, saved staff reads | **Nine real Viewer browser/API reads**, own-member preview/self round trip, exact saved detail and Settings parity observed. Separate Uploader/Admin preview and different-target comparison remain open; other live sessions are not borrowed proof. |
| Real roleless guest denial | **Not attempted with a genuine guest**; anonymous 401 is not guest-policy evidence |
| Employee-first automatic application users/packages, delegated Power Platform outcomes | Real **staff** automatic source publications and subsequent automatic directory completion observed, including actual delegated reader coverage. **Roleless employee-first** remains open. |
| Genuine report import/current lineage, personal/champion/popularity answers | **Three complete bundle receipts / three retained sets** at final handoff; first observed webapp bundle detailed above. Original export provenance belongs to its uploading operator/parent. Company top three available; missing department/personal evidence reported unavailable. |
| Six primary natural-language prompts twice; expanded request/tool/grounded outcomes and additional cases | **0 attempts / 0 repetitions**; SDK fixtures are not a semantic-client substitute |
| Published intended Teams/Microsoft 365 Studio channel with individual OAuth, refresh, unaffected staff | **Unavailable**; no authenticated individuals or publication access, no maker-connection substitution |
| SDK role-specific schemas, authenticated diagnostics/settings/profile parity | Genuine **Viewer** Settings/SDK metadata/privacy/storage parity observed; native EndUser/Admin/Uploader and authenticated diagnostics remain open. |

### Observation and continuation cleanup

A bounded passive health/readiness observation completed from
**09:56:18.946772Z to 10:26:19.740015Z**, actual **1,800.834 seconds**:
**61 rounds / 366 local/public probes, all 200**, no non-200 probe.
`live-observation-samples.jsonl` and `live-observation-summary.json` retain every
actual sample. All three deployed containers remained healthy, restart count
zero, no OOM; maintenance markers remained absent and operational mode normal.
The thirty-minute health window is satisfied, **not the required two-employee
journey observation**. The later application-401 source interruptions and
successful automatic recovery above are separately retained, not hidden by the
green health probes.

Actual worker live discovery sample: **9/9 successful Viewer API reads, one
staff identity**, including two own-member preview calls; **0 roleless employee
discovery reads / 0 native semantic attempts / 0 verified MCP refresh journeys**.
There is no ≥10-read two-employee sample. The nine-call observed error fraction
is 0/9, **not a passing ten-minute employee error-rate measurement**. Employee
discovery error rate remains **undefined (0/0)** and API p95 **unknown** (fewer
than fifty applicable samples). Health requests never enter these denominators.
The bounded observer finished normally; no campaign helper/service is left
running. `live-observation-final-verification.json` records its actual closing
identity/health/source snapshot; later source/report receipts explicitly record
the subsequent genuine changes.
`live-handoff-status.json` fixes the final operational observation at
`10:35:09.723870Z`: exact pinned images healthy, no restart/OOM, current schema,
normal mode, no maintenance markers, all protected secrets unchanged, positive
revocations zero, two completed automatic runs and one historical partial run.
Only this requested completion differs from the final source manifest; the
parent manifest and every runtime/implementation source remain candidate-identical.

The four exact continuation fixture projects
`agent-control-ltdp-{a9ebf2faed2b4595865a2e5374e9a8ac,c60c016f53b146928fe9634d40a6153f,d981d7246b8e4b4e96a0a9594c1bc05a,f37f5569f5f34c7abd4a5c101370e4b9}`
have **zero remaining owned containers/networks/volumes**.
For the rejected full-backend-bind attempt, only the independently verified
stopped exact workload container was removed before the existing owner cleaned
its PostgreSQL/volume. No broad prune/delete or `seha` cleanup occurred.
`live-cleanup-final.json` reconciles all four exact project labels.
The prior seven-project cleanup evidence remains valid historical evidence.
Candidate snapshots, focused evidence, protected checkpoint/denial archives and
all production OAuth/recording state are intentionally retained.

### Still-open owners, thresholds and next interactive action

| Residual | Owner / exact forward action |
| --- | --- |
| Interactive OAuth unavailable | Parent follow-up verified the reported `Client Not Registered` ID is absent from the healthy deployed encrypted registry; the original expiry/deletion cause is not provable. Authorized operator: clear only this issuer's cached dynamic client registration (VS Code: `Authentication: Remove Dynamic Authentication Providers`), then reconnect for normal DCR/sign-in. See the focused recovery in `docs/mcp-clients.md`; token clearing/restarting alone was insufficient. Do not share credentials/tokens, fabricate the old registration, delete the shared OAuth volume or repeat the database reset. Then perform actual read-only continuity/refresh and individual employee/staff journeys. |
| Existing-SP assignment setting unknown | Already-authorized Entra rollout operator: verify the exact tenant and resolve the API/MCP appIds to their existing SP object IDs, retain No or PATCH only necessary `appRoleAssignmentRequired:false`, GET-verify. No new permission/registration/assignment or additional approval. |
| Roleless first-run remains unproven; real staff collection now observed | Ordinary roleless employee signs in; observe the same due automatic sources without Sync/Permissions/manual start. Retain the actual staff publication counts, initial authorization interruption, automatic completed follow-ups and reader-specific coverage above. |
| Report accepted; original export provenance outside worker | Uploading operator/parent supplies its genuine current-export provenance. Preserve the observed complete webapp receipt/period and honest missing personal/department outcomes; do not synthesize/restore usage or add an import approval gate. |
| Two-person/different-target/Uploader/Admin/published-channel/semantic proof open | Existing individual employees, separate staff/guest and Studio publication owner complete the remaining matrix; reuse actual Viewer proof, preserve actor/saved scope/individual OAuth and every failed attempt. |
| Capacity already failed | Existing query owner/parent: observed-plan root fix first, then bounded selector. Original four 15-second `57014` failures at accepted 100k/200k/1m scale remain **failed**, not rerun or marked pass. |
| Baseline Office history, generation ceiling, two Office Knip exports, unavailable Bicep compiler | Their existing owners retain the earlier exact failed/unavailable evidence; no unrelated fixes or false passes in this continuation. |
| Any forbidden field/tool/action, unauthorized success, wrong actor/subject/company/department or active-policy identity disclosure | Threshold **1**: contain only the affected unsafe authority through current auth/error paths, root fix, focused test, exact coherent redeploy **without reset**, repeat actual affected journey. |
| Discovery degradation | Errors **>5% in ten minutes**, any `57014`, or p95 **>2 s across ≥50 measured requests** trigger the owning query/API investigation; separate provider/auth/model latency. Missing traffic is inconclusive. |

**Current next action:** obtain the still-missing genuine employee,
separate staff/guest, control-plane and published-channel access. Current staff
MCP authentication and native refresh are now working; do not keep repeating its sign-in.
Use separate genuine per-user employee connections for the roleless matrix,
not the privileged owner's OAuth connection. Secrets stay in the approved
sign-in client. Do not repeat the database reset or already-verified aggregates.

## Parent native-client continuation after registration recovery

The operator reported `Client Not Registered` for a cached client ID.
Safe live checks confirmed that ID was absent and the preserved OAuth volume
was still mounted correctly. The existing contract caps DCR metadata at
24 hours; the original disappearance cause is not provable. Restart/token
clearing alone did not recover this chat's connection. Following the documented
dynamic-provider reset and authentication in the current Copilot harness, a new
registration appeared and the current native catalog became available.
The transient `startServer` / `authenticationStateChanged` failures remain real
failed connection attempts; they are not discovery-API errors.

The current native catalog contains **38 staff tools**, including
`agent_catalog`, `my_workplace`, `my_discovery_profile`, `preview_end_user`,
and no advertised Admin control tools. This distinguishes the current non-Admin
staff surface, not Viewer versus Uploader (their catalogs are equal).
One actual native `inventory.health` read succeeded separately:
2,135 logical agents, source catalog data available, but `details_pending`
with 693 missing package details. That is not fully completed metadata.

### Actual native discovery calls

**Initial block: 19/19 successful native discovery calls**, one signed-in staff
identity, plus the inventory-health read above. The two successful post-lifetime
reads below bring the native discovery total to **21/21**.
The staff self-selection was
`21bf5928-fc16-4c85-8820-42dbabe49851`, revision
`fc4c9f9a-6189-420e-a952-1862a0beb08a`. Stored company `Microsoft`,
department null; report period `2026-10-01` through `2026-10-30`;
effective privacy false/false throughout. No report metrics, internal person
IDs or administrative data appeared in the positive discovery DTOs.

The parent drove the six roadmap questions through the actual native tools
twice in this same staff conversation, not SDK mocks or two independently
authored employee conversations:

| Question | Native request, in each repetition | Observed outcome, both repetitions |
| --- | --- | --- |
| Who are agent champions in my department? | `my_workplace.read`, both scopes, limit 3 | Champions unavailable because saved department is null; not "no champions". Company top three returned separately. |
| What agent use cases are used in my department? | `my_workplace.read`, department, limit 3 | Department/use cases unavailable; no inferred department from email or tenant. |
| What are the most popular agents in my department? | `my_workplace.read`, department, limit 3 | Department unavailable; a company-only answer is not substituted. |
| Am I an agent champion? | `my_discovery_profile.read` | `unavailable`, `saved_subject_report_link_unavailable`; not a negative champion answer. |
| Which agent can review a BRD? | `agent_catalog.search`; terms `BRD`, `business requirements document`, `requirements review`, `document review` | Two title-evidence candidates: SSMC BRD Builder and BRD Review Analyst, including a different company/department. Both descriptions absent, use links absent; no claim of verified task execution/access. |
| I need another pair of eyes on our requirements write-up | `agent_catalog.search`; terms `business requirements document`, `requirements review`, `document review`, `BRD review` | BRD Review Analyst returned in each repetition; title-only evidence, no fabricated description/use link. |

These are twelve actual question-driven reads. Seven additional reads were:
an initial BRD-creation search (two candidates), exact selected BRD detail
(description absent, `nextCursor:null`), preview profile/search/workplace,
return-to-self profile, and a distinct no-match search.
The latter goal was quantum-neutrino modelling, expanded to
`neutrino oscillation` / `cryogenic diamond lattice`; the result was explicitly
`no_matching_saved_evidence`, empty values and no next cursor, not a fabricated
recommendation. All search/detail continuations were complete (`nextCursor:null`).

### Different-member preview, then ordinary self

The exact saved member returned by the cross-company BRD search was supplied
explicitly to each preview action; no token/account switch occurred.
Preview selection `047233eb-6783-4225-ba73-70331705e313`, revision
`954a8865-dd47-4c9d-a6b8-64d91c926147`, returned `preview/selected_member`,
stored company `Sheikh Shakhbout Medical City`, department `HR Operations`,
and suggested own-champion status.

The native workplace read returned three suggested champions, independently
ranked department/company lists of three each, and four use cases with explicit
`created_here` versus `used_here` relationships. The company list included
Clinical Imaging while department results remained HR Operations. Source
evidence remained the saved Power Platform observation at
`2026-11-06T10:25:58.119+00:00`, with the same October report period.
Preview BRD search returned the same safe title-evidence candidates.

The subsequent ordinary profile returned the original
`self/current_account`, Microsoft/null-department context and unavailable own
champion state. This proves native visible subject isolation and a real
different-member preview, not that member's genuine self-service, borrowed
roles, or two-employee identity equality.

### Continuity observation and remaining limits

A bounded attached timer completed from **12:16:20Z to 12:31:30Z**, exactly
**910 seconds**, past the configured 900-second reference-access lifetime,
without signing out, rotating keys, accessing tokens or resetting state.
Before waiting, safe filesystem metadata established one DCR record,
one upstream record and one refresh record; initial token-record timestamps
were Unix `1793967115`. Only counts, keyset digests and timestamps were inspected;
no credentials/record bodies were exposed.

After the wait, **two further native calls succeeded without interactive
authentication**: a fresh `my_discovery_profile.read`, then the same expanded
BRD search with its new selection
`1fd77d82-84a7-4815-a108-6a6d53ca93f4`, revision
`e0b743db-e7e0-4b78-9632-8e1e5b9c6f7e`. The profile remained the same real
Microsoft/null-department self, privacy false/false and October period; search
returned the same two title-evidence candidates with complete continuation.
The expired original discovery selection was not reused.

Safe post-call metadata showed the **refresh-reference keyset changed** from
`269b5a9ff82b058f4f39e953839c6179546287df93fe4a4fd08392208f4f9b5c`
to `214b6ce440355260a425121ea0751149f8cda0adef79f092a0301329f2476d46`;
upstream and JTI records were updated at Unix `1793968299`, **1,184 seconds**
after initial issuance. The DCR record/keyset was unchanged, while authorization
transaction/code collections remained empty with unchanged timestamps.
This is actual current-staff native automatic OAuth-refresh/continuity evidence,
not a storage-retention assumption or another user/browser sign-in. No token
values were read or exposed. It does not certify every client's refresh or the
published Studio end-user flow.

The timer finished normally, leaving no campaign helper running. Deployed MCP
remained healthy, restart count zero and unchanged exact image
`sha256:9b8cffe2b7fc3c47f32daaf7d02dc9cb2f5b8f1210795e2ee2cef407dd7ab088`.
`git diff --check` passed during the observation; changes in this follow-up are
documentation only, not a new runtime deployment.

The first genuine staff native reads are now positive. Still **zero roleless
employee reads**, no two-employee denominator, no separate Admin/Uploader/guest
or published Studio proof. Private/draft and hostile-text live cases were not
observed; returned lifecycle values were unknown/published. No production
privacy flags were cycled. Scale p95 remains failed/unmeasured as already
recorded; twenty-one successful small saved-data reads do not repair that failure.

After these successful native checks, the parent asked which remaining genuine
employee/staff/guest, Entra control-plane and published-channel connections were
available. Actual operator response: **"None currently—leave those checks pending"**.
Those checks remain pending at the operator's request; current staff MCP sign-in
and refresh no longer block native reads. No identity substitution, temporary
role removal, extra reset, deployment or new runtime prerequisite was introduced.
The deployment stays running; campaign remains `production_hardening_pending`,
with the independent failed scale-capacity result still explicit.

## Parent repair: registration retention, pending MCP-only fix-forward

The user subsequently reported the same missing-client error from Copilot
Studio. Parent verified only that reported registration's absence and reproduced
the failing boundary with isolated synthetic SDK OAuth: a valid access token
could coexist with a forgotten registration, but refresh returned
`401 invalid_client`. The blanket DCR 24-hour limit was an application defect,
not an Entra or Studio requirement.

The existing local/Azure owners now persist DCR metadata without automatic
expiry. All credentials/transient state keep their finite lifetimes; callback,
PKCE, user/token authority, revocation, bounded capacity and Azure lease/ETag
checks remain. Startup preserves surviving current registrations without
reconstructing expired/deleted metadata. Local startup rewraps retained encrypted
FileTree envelopes atomically; Azure rewraps its leased map. This permits key
retirement without waiting for durable records to disappear.

Parent verification: full Python suite **1,054 passed / 23 Azure-guarded skipped**,
separate real Azure SDK/emulator suite **23 passed**, Ruff all source/tests,
mypy 26 source files and diff hygiene passed. The pinned emulator fixture and
its exact internal network were cleaned. Current docs describe durable client
registrations and one-time recovery only for already-missing IDs; the earlier
24-hour text above is historical. No API/frontend/database changes or new
dependency manifests/installations. This validated repair is not yet a live
deployment claim; the next action is the bounded MCP-only fix-forward preserving
application/PostgreSQL, secrets, volumes and the now-working staff connection.

## Bounded durable-registration deployment preflight — 2026-11-06 13:09Z

Fresh explicitly launched **GPT-6.1 Sol / xhigh** context, no nested agents.
This continuation did not restart a phase, repeat tests/reset, request another
approval or reopen unavailable identities. The authorized target remains this
Mac, Docker Desktop `desktop-linux`, project `seha`, app **3002** / MCP **3003**.
The existing deployment owners cannot currently satisfy both mandated cached
dependency reuse and truthful MCP-only aggregate release supersession.
**Repair deployment is `deployment_pending`; no new image was built or deployed.**
The already-running campaign remains `production_hardening_pending`.

### Exact-source and target reconciliation

Read `AGENTS.md`, the installed skill/worker contract, binding README/phase 04,
chronological completion evidence, operations, Dockerfiles and local
snapshot/build/runtime/MCP owners. Used the genuine pinned helper
`sha256:adc88579e45b094c522501d10d9e5b778954c1bbb29883fe0d40a9c8bdb6386e`
with original-path repo/socket bindings, UID/GID `501:20`, supplementary group
`0`, `--pull=never --network none`. Its Linux/amd64-on-arm64 warning did not
prevent success. No Desktop bind-check widening or alternate daemon.

Existing owner calls `Read-LocalCandidate`, `Get-LocalReleaseTarget` and
`New-LocalBuildSnapshot` succeeded. The first two only verified the prior
candidate/production target; the snapshot wrote only the repository artifact
tree. Evidence directory:
`artifacts/test-scratch/phase04/durable-registration-fixforward/`.

| Identity | Observed value |
| --- | --- |
| Docker endpoint | `unix:///Users/candede/.docker/run/docker.sock` |
| Engine | `e257bbe3-cb71-458e-a8c5-f6abfead0ea7` / `docker-desktop`, Linux |
| Prior current candidate | `candidate-cutover/build.json`, SHA-256 `66b818f16cc33576b810d39f212e0e9479276936832801c4a94f7e5eb171a609` |
| Pending repair source snapshot | `artifacts/local-builds/e3451827b7a1427c88872f0d8e29eb37/source` |
| Pending source manifest | `durable-registration-fixforward/source-sha256.json`, **1,114 files**, SHA-256 `5e0d47f4313c2b6b8b3540ba597e9d86e7e10ac61c19020a60b28219610fdc67` |
| Fresh protected target evidence | `target-before.json`, SHA-256 `87e4afdd558ecf908663faaa6b9b15e022988ca81ace522659bdff849d50e267` |
| Schema | `78fa2785984b89e6e95a1c88ad60105138993c49ec517df457bb7f555006dd40`, operational mode **normal** |
| Network | `seha_default`, ID `0687fdd649a831c7e3c89a3fc8cdcd222125ce45ee6628ab235209ad20cb674b` |

This appended audit record postdates that source snapshot. It is not a candidate
receipt, image identity, deployment claim or substitute for the parent tests.
`preflight-summary.json` and `preservation-and-health.json` retain the actual
read-only reconciliation. The protected aggregate and MCP receipts were not edited.

### Concrete build/deployment owner limitations

1. `mcp/pyproject.toml` and `mcp/uv.lock` are byte-identical to the deployed
   candidate snapshot (SHA-256 respectively
   `3d874de6d80d18c84a7cc1ce493aa0bbf5f1dd599da18f9bb13aa3383630c6e8`
   and `7b1460caa5f3e48b511090817f27188b7a4f43c0145f3747ede7a1477d196bda`).
   `Build-LocalMcpArtifact` accepts only context/snapshot/target and always uses
   `mcp/Dockerfile`. That Dockerfile copies changed `mcp/src` **before** its
   `uv sync --frozen --no-dev --no-editable`; with `UV_NO_CACHE=1`, the changed
   source invalidates the layer that creates and installs the entire venv.
   There is no MCP installed-dependency/base-image reuse input. The verified
   Node `AGENT_CONTROL_DEPENDENCY_IMAGE` path belongs to the separate application
   Dockerfile and is not forwarded by this MCP owner. Existing cached runtimes
   are present, but a package-only isolated inspection of the exact deployed
   runtime confirmed it lacks both `CLIENT_COLLECTION` and `oauth_ttl`.
   Therefore the current repair is not already packaged. No build was launched
   that would reinstall unchanged dependencies, access a registry or fabricate
   a cache-miss authorization. No ad hoc Dockerfile/runtime overlay was used.
2. `Start-LocalMcp` correctly uses `up --no-build --no-deps ... mcp` and writes
   `mcp-operation.json` / `mcp-deployment.json`, but has **no writer that
   supersedes the aggregate `deployment.json` candidate pointer**. That pointer
   still names `candidate-cutover`, whose manifest embeds the old MCP image.
   Its writer is the full `Invoke-LocalApplication` lifecycle; invoking it or
   rewriting protected receipts by hand would not meet this bounded MCP-only
   objective. No partial cutover was performed that would leave a falsely
   current aggregate MCP identity.

**Exact forward action, parent/deployment-owner:** add the narrow supported
cached, immutable MCP dependency-reuse/source-packaging path with manifest
verification, and owner-written MCP-only release supersession retaining the
unchanged app/operator provenance and historical candidate/reset receipts.
Then build the exact repair snapshot/current source and invoke the existing
MCP-only lifecycle, without `-DbReset`, followed by metadata/native continuity
verification. This is a tooling gap, not missing operator approval.

### Preservation and available live checks

At **13:09:32Z**, all three original container IDs/images/start times remained
unchanged, healthy, **zero restarts / no OOM**:

| Service | Container ID | Current immutable image |
| --- | --- | --- |
| API/frontend | `89b906bb76382b5161e574ee6ca26853ff8a772fb339e1ece53a7dcd300f2b64` | `sha256:ead305a676a5fd8c325c58a75d2a655898495b3b0781e41d845d16392443597f` |
| PostgreSQL | `05314812fa9289806d5086fcf94d2ad500fda3021cda3b3581c41abf54cfc813` | `sha256:051f7b7b3abdd564d5d1bd1e8c4b9c1b6e77087d1dd22020ede611c096a272e0` |
| MCP, **still the old release** | `032f54e8a0208ffb25671c683dc1fef128801014878413d446294e66e0d4236f` | `sha256:9b8cffe2b7fc3c47f32daaf7d02dc9cb2f5b8f1210795e2ee2cef407dd7ab088` |

- **9/9 original protected secret-file HMAC comparisons passed**, including
  tenant registry, session, both PostgreSQL secrets and all MCP keys/credentials.
  Existing protected action-target application/MCP/tenant bindings also match.
  An initial checker incorrectly compared those historical HMACs with plain
  SHA-256 and failed its assertion; using the original session-keyed HMAC
  algorithm yielded all nine exact matches. No secret changed or was exposed.
- Settings and `compose.env` SHA-256 values match the fresh preflight.
  Privacy remains **false/false**. Existing target identities, callbacks,
  read-only secret mounts, project labels and exact loopback ports passed the
  owner checks; no authentication/role/configuration mutation.
- `seha_data` (created `2026-09-11T19:26:51Z`),
  `seha_mcp-oauth` (`2026-11-04T07:54:46Z`) and `seha_mcp-recordings`
  (`2026-11-05T09:54:08Z`) retain their local-driver/project/purpose bindings.
  No database write/reset, volume deletion/recreation, OAuth-store
  initialization, registration recreation or key rotation was invoked.
- **8/8 local/public health/readiness probes returned HTTP 200**: app
  `/api/health`, `/api/ready`; MCP `/health`, `/ready`, on both confirmed origins.
  These do not prove the undeployed repair or a new native user journey.
- Safe raw-envelope metadata only: **one surviving DCR record**, still with
  its old finite expiry (**82,928 seconds remaining**, no persistent DCR yet);
  one upstream record, one refresh record and two JTI records, all finite and
  unexpired, maximum remaining **82,943 seconds**. This confirms preservation,
  **not** durable-registration convergence. No token, decrypted record body,
  other user's session or registration identifier was printed.
- Parent can continue the existing working native staff path with
  `my_discovery_profile.read` and expanded `agent_catalog.search`; this worker
  did not borrow/invoke that connection. Already-missing Studio registration
  still requires one supported reconnection, not fabricated restoration or a
  recurring daily workaround. Genuine roleless/separate staff/guest,
  control-plane and published-channel checks remain pending exactly as requested.

All helper/package-inspection containers were `--rm` and exited; no observer,
server or fixture was left running. No package installation, network fixture,
commit, push or branch. Only this existing completion record was edited among
campaign records; the parent manifest and all implementation/toolkit source
were preserved. Previous aggregate test results remain reused, not rerun or
reclassified. The retention defect remains live until the exact forward action
above completes; the retained working client must not be deleted to hide it.
Final `git diff --check` passed. Comparison against all 1,114 snapshotted files
found only this appended completion record changed; all five protected receipt
digests remained unchanged. Running pinned-helper count was zero and its empty
project-local scratch work directory was removed.

## Parent-scoped delivery-owner repair, superseding the preflight limitations

The parent explicitly resolved the bookkeeping interpretation: `deployment.json`
is the historical coordinated **application** candidate/reset receipt, not a
requirement to rewrite release evidence after independent MCP deployment.
`Start-LocalMcp`'s existing MCP operation/deployment receipts are current MCP
authority. The composed release must name unchanged app/operator
`candidate-cutover` plus the independent new MCP source/image. No new release
schema/layer/gate, receipt hand edit or application restart.

The parent also explicitly brought narrow installed-dependency reuse into this
worker's scope. Implemented in existing `mcp/Dockerfile` / `local-mcp.ps1`:
third-party installation is separated from source; an optional cached baseline
must have byte-matching manifests, consistent lock-pinned installed packages,
Python 3.14.6/uv 0.12.17 layout and supported Linux architecture. Test targets
require development packages. Resolve and recheck image identity before/after
build, bind the runtime platform, and force offline/no-network reuse.
Always remove the previous source tree, build the current wheel offline and
replace only the project package through uv's normal uninstall/install owner;
runtime dependency pruning removes cached development-only packages offline.
No custom package writer, compatibility overlay, registry fallback or new runner.

Actual cached baseline
`ac-mcp-fixture-58ab6a785e5d4f2080772cf2-mcp:local-test`,
`sha256:e6377346d2a380bd45d87e41c6ff3e4f8533012741ed08eec9c02b6f1b450d21`,
is Linux/arm64, with matching manifests and **95 compatible installed packages**.
Its genuine uv built the repaired application wheel successfully with no network
and no dependency installation; the new owner independently passed its real
baseline inspection. An initial direct `uv pip check` had no writable `/work`
because the test image's inherited scratch path was absent; the bounded
project-local scratch mount used by the owner corrected that inspection context.

Focused checks: **34/34** container-contract tests, Ruff for that file,
**257 MCP setup/lifecycle assertions**, and `git diff --check` passed.
Build-owner cases cover normal build, offline args/provenance/platform,
development target, either manifest mismatch, unexpected manifest inventory,
inconsistent/missing layout, invalid reference/identity/platform and changed
image identity. The earlier parent storage suite evidence remains unchanged.
Updated only directly related integration/build docs and focused tests.
No production mutation has occurred in this repair subsection; immutable
build/deployment evidence follows chronologically.

## Independent MCP fix-forward deployed and observed — 2026-11-06 13:23Z

**Bounded objective completed:** the durable-registration repair and narrow
build-owner improvement are now deployed to the exact confirmed installation.
The composed release is **unchanged application/operator `candidate-cutover` +
independent MCP below**, not a wholly current aggregate `candidate-cutover`.
The campaign's unrelated, operator-requested pending journeys and failed
capacity evidence remain `production_hardening_pending`. No extra approval,
identity substitution, live synthetic OAuth flow or database reset.

### Immutable build and existing-owner deployment

| Identity | Exact value |
| --- | --- |
| Independent MCP snapshot | `artifacts/local-builds/b651dae78bf941669769598ee72dc0d6/source` |
| Source manifest | `artifacts/test-scratch/phase04/durable-registration-release/source-sha256.json`, **1,114 files** |
| Source manifest SHA-256 / image source label | `cf1814b6484ef572495853685423a849981bbc19f7d385217a6df1ed1b113e2f` |
| New MCP image | `sha256:f5b49c3022e453d7c8e7c5b4a322c0674ff369d20dda42506b276f35f9d45ffb` |
| Build tag | `agent-control-role-discovery-mcp:durable-registration-fixforward` |
| Verified cached baseline | `sha256:e6377346d2a380bd45d87e41c6ff3e4f8533012741ed08eec9c02b6f1b450d21`, Linux/arm64 |
| MCP deployment verified | `2026-11-06T13:20:47.7684033Z` |
| New MCP container | `df36b1c01ea067d05ccbd44e146dff13fc116429c0dc1d427e39f6ca930c6a3e` |
| MCP start time | `2026-11-06T13:20:40.55756971Z` |
| Both current MCP receipts | Version **1**, step **verified**, exact new image above |
| MCP receipt identity | `3bdac04a08e92940968e3b3d9f6305dd25483aac5285be29b2ea9fe452edc0a2` |
| SHA-256 of each MCP receipt file | `65e399357386fde22c4fda79e799a5339d034e51c3e42c0c9e8694905a002253` |

`New-LocalBuildSnapshot` / `Build-LocalMcpArtifact` built from the immutable
snapshot with verified baseline identity before/after, matching manifests,
explicit `linux/arm64`, `--network none` and source label. Build log shows
only the local application package rebuilt/installed; runtime pruning removed
nine development-only packages, with **no third-party dependency installation
or package-registry access**. The resulting **86 installed distributions
exactly match the previous production runtime's names/versions**.
All **26 packaged application files** are byte-identical to snapshot source;
zero obsolete/extra package files. The console entry point and typed source
contracts are unchanged. The source does not declare a `py.typed` marker and
none was invented. Packaged `oauth_ttl` returns null for client metadata and
the unchanged **86,400-second** cap for credentials.

The first preparation attempt correctly hit the full coordinated-candidate
verifier's “invoking deployment tooling differs” guard after this authorized
owner change. It made no production mutation. The actual independent MCP path
did **not** relabel that old candidate as qualified current content: it verified
historical candidate digest/image/source provenance, loaded the existing
application receipt, generated a fresh exact-target read-only reconciliation
and used the newly snapshotted MCP owner. No guard was weakened.
The runtime Python base was absent as a separately tagged local image, but the
normal pinned build resolved successfully; no alternate base or feed was added.

Under the existing `artifacts/local-operations/seha.lock`, the live operation
rechecked all snapshot/checkout bytes, source/image identity, exact daemon,
root/project/origins/ports, protected bindings, container/resource identities,
normal schema and API readiness. `Write-LocalComposeEnvironment` changed
**only `MCP_IMAGE`**; every other generated setting was compared unchanged.
`Start-LocalMcp` then performed its existing
`compose up --no-build --no-deps ... --force-recreate mcp`, health verification
and MCP receipt writes. The genuine pinned helper used the already-supported
Desktop host network for real loopback API readiness before/after.
No application/operator deploy, stop/drain, maintenance, reset or SQL write.

`deployment.json` and `deployment-operation.json` remain byte-identical,
historical application/reset evidence:
candidate `66b818f16cc33576b810d39f212e0e9479276936832801c4a94f7e5eb171a609`,
app `sha256:ead305a676a5fd8c325c58a75d2a655898495b3b0781e41d845d16392443597f`,
operator `sha256:564715f159a0e340292512d84190b34b351be38e5eef3955130f57f91d65c4f6`.
The existing MCP receipt pair—not that candidate's historical embedded MCP
image—is current independent MCP deployment authority.
The OAuth volume receipt was rewritten by its existing owner with identical
version/name/driver/creation identity; JSON property order changed, not storage.

### Actual persistent-state preservation

- The **same existing DCR record/keyset** survived cutover and now has
  **no expiration: 1/1 durable**. No registration was created or fabricated.
  Upstream and refresh record keysets/counts/**exact expiry timestamps** are
  unchanged. Every non-client record remains finite.
- Startup ordinarily culled **one already-expired JTI**, whose saved expiry
  was `2026-11-06T13:20:07.193456+00:00`, before the new container started at
  13:20:40Z. The retained valid JTI has its exact original finite expiry.
  An initial verification assertion incorrectly expected even expired JTI
  state to remain; safe timestamp comparison corrected the checker, not
  storage/code. Service-binding health renewal likewise retains finite expiry.
  This is normal credential culling, not lost active authority.
- Exact safe lookup confirms the reported Studio client is **still absent**.
  Already-missing/expired/deleted registration metadata was not resurrected.
  That affected connection needs **one supported reconnection**; durable
  surviving/new registrations do not require daily client deletion.
- **9/9 original secret-file HMAC comparisons passed** after deployment.
  Tenant registry, application/MCP protected binding identities, saved
  settings, false/false privacy, callbacks, signing/encryption/client keys and
  database credentials remain unchanged. No token, decrypted record body,
  client metadata or another user's session was exposed.
- API/frontend ID
  `89b906bb76382b5161e574ee6ca26853ff8a772fb339e1ece53a7dcd300f2b64`
  and PostgreSQL ID
  `05314812fa9289806d5086fcf94d2ad500fda3021cda3b3581c41abf54cfc813`
  retain their exact prior images and start times. Both were continuously
  healthy; no restart, database reset or data mutation by this worker.
- `seha_data`, `seha_mcp-oauth`, `seha_mcp-recordings` retain the exact
  earlier creation times, local driver/project/logical ownership and mounts.
  `seha_default` network identity is unchanged. Current schema remains
  `78fa2785984b89e6e95a1c88ad60105138993c49ec517df457bb7f555006dd40`,
  normal mode. No storage clearing/recreation or key rotation.

### Observation, validation, cleanup and native handoff

Post-deployment observation: **63.993 seconds**, four samples,
**32/32 successful local/public app/MCP health/readiness probes**, zero failures.
All three services stayed healthy with **zero restarts / no OOM**; no
ERROR/CRITICAL/Traceback lines in the observed MCP log interval.
This bounded operational canary is not the unavailable two-employee observation,
a new native read or a passing scale-capacity qualification.

New checks are **34 container-contract tests**, **257 mocked Docker MCP
setup/lifecycle assertions**, real cached-baseline compatibility inspection,
actual no-network wheel/runtime build, complete packaged-source/dependency
comparison, exact-target MCP-only deployment, metadata/expiry preservation and
the 32 real health/readiness probes. Ruff and diff hygiene passed.
Reuse—not rerun—the parent's **1,054 Python passes / 23 Azure-guarded skips**,
separate **23/23 real Azure emulator passes**, all-source Ruff and mypy proof;
no Python runtime source changed in this delivery-owner follow-up.

All new build/deploy/preservation/observation evidence is under
`artifacts/test-scratch/phase04/durable-registration-release/`, with focused
logs under `durable-registration-build/`. Evidence is non-authoritative audit
output, not a new release layer or gate. Only this completion record changes
after the release snapshot; the parent campaign manifest is not edited.
Changed implementation roots are existing `scripts/local-mcp.ps1`,
`scripts/local-mcp.tests.ps1`, `mcp/Dockerfile`,
`mcp/tests/test_container_contract.py` and directly related integration docs.
Backend/frontend/infra require no new edit: current API, schema, privacy and
first-run contracts/images remain untouched.

All helper/inspection containers exited with `--rm`; no observer/server/fixture
was left running. Production stays up. Both old source evidence and the deployed
immutable snapshot were retained; this worker's disposable wheel/test/build-work
scratch was removed. Final snapshot comparison found only this appended audit
record changed, the parent manifest unchanged, and final diff hygiene passed.
No dependency manifest changes, third-party reinstall, new infrastructure,
nested agent, commit, push or branch.

**Parent's exact next action:** use the current native staff connection for
`my_discovery_profile.read` and expanded `agent_catalog.search`, without
clearing its client/provider or signing out. Confirm the preserved connection
against the independently updated MCP image. Genuine roleless/separate
staff/guest, Entra control-plane and published Studio checks remain pending
per “None currently—leave those checks pending”; do not borrow identities,
change roles/privacy or repeat the database reset. Existing numeric safety/
performance triggers and unrelated residual owners remain unchanged.

### Parent final native and persistent-state confirmation

After worker handoff, parent independently verified both current MCP receipts
are version 1 / step verified and reference the exact deployed
`sha256:f5b49c3022e453d7c8e7c5b4a322c0674ff369d20dda42506b276f35f9d45ffb`
image with receipt identity
`3bdac04a08e92940968e3b3d9f6305dd25483aac5285be29b2ea9fe452edc0a2`.
Direct container inspection confirmed that image healthy with zero restarts.
Safe outer-file metadata inspection independently found one client registration
with no expiry, while the single upstream and refresh records remain finite.
No record bodies or credentials were printed.

Two actual native calls then succeeded on the existing connection **without
another interactive sign-in**: fresh `my_discovery_profile.read`, then
`agent_catalog.search` for BRD review with terms `BRD`,
`business requirements document`, `requirements review`, `document review`.
Selection `e12cf66b-5778-438c-8535-f4c3f03b9950`, revision
`28412f1b-b89e-4d9f-88f0-45fc3803b776`, returned the same actual
Microsoft/null-department self, October period and privacy false/false.
Search returned two title-evidence candidates, no description/use link claims,
and `nextCursor:null`.

The current-staff native discovery total is now **23 successful reads** across
the recorded continuations. This closes the durable-registration repair's
post-deployment connection check, not the still-unavailable two-roleless-user,
published Studio, guest or Entra control-plane matrix. The reported already-
missing Studio ID still needs one supported registration recovery; no daily
connection recreation is intended or required by the repaired policy.
Parent reviewed the narrow Dockerfile/build-owner implementation and final
evidence; diff hygiene passed. No further deployment/reset was performed.
