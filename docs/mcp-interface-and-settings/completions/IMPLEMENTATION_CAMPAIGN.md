# MCP interface and settings implementation campaign

## Current release state

**complete_with_risk**. The original metadata transport/readiness repairs and
the subsequent MCP-only tool retirement and enterprise page redesign were
normally deployed by the user. The latest live catalog contains **50 tools /
105 canonical operations**, with exact descriptions and **444 instruction
words**. Authenticated browser/API checks, search/filter/schema interactions,
desktop/mobile rendering and saved Agents/Users journeys passed. Original
PostgreSQL and seven retained credential/registry files are unchanged.

The original campaign's **600.103 seconds / 11 successful samples** observation
and 62-tool / 462-word evidence below are historical, not the current catalog.
Actual authenticated native/model-assisted MCP-client selection remains
unperformed; deterministic SDK and browser journeys are not that proof.
The latest follow-up deployment evidence is at the end of this record.

## Contract and target

- Started: 2026-11-04, on explicit user invocation of `implement-folder`.
- Repository: `/Users/candede/repos/agent365/agent_control`; initial HEAD
  `6266feca`; initial worktree clean.
- Plan: `docs/mcp-interface-and-settings/`.
- Application roots: `mcp`, `backend`, `frontend`, `scripts`, `infra`, and
  their documentation, all in this repository. No other workspace root.
- Disposable local integration stacks and normal final deployment to `seha`
  are authorized by the roadmap and this invocation. Azure checks are offline.
- Verified Docker context: `desktop-linux`;
  endpoint: `unix:///Users/candede/.docker/run/docker.sock`.
- Existing production services: `seha-app-1` (web 3002), `seha-mcp-1`
  (loopback 3003), `seha-postgres-1`. Retain PostgreSQL, `seha_data`,
  `seha_mcp-oauth`, `seha_default`, OAuth keys/state and tenant configuration.
- Initial production images: app `2206234c14e7`, MCP `1e348498509d`,
  operator `1a71ff0afbb5`. Resolve full identities again before deployment.
- Initial unrelated running container: `workiq-demo-redis-state-1`; preserve it.
- No commit, push, branch creation, database reset, existing-key rotation,
  production synthetic/provider-control work, Azure action, or broad cleanup.
- No additional acceptance gate. Real authentication and roles remain required.

## Stable ordered manifest

| Phase | Prompt | Completion | Prerequisites | Status |
| --- | --- | --- | --- | --- |
| 01 | `01-simplify-mcp-contract.md` | `completions/01-simplify-mcp-contract.md` | None | complete |
| 02 | `02-mcp-settings-page.md` | `completions/02-mcp-settings-page.md` | 01 | complete_with_risk |
| 03 | `03-verify-and-rollout.md` | `completions/03-verify-and-rollout.md` | 01, 02 | complete_with_risk |

README ordered links match the three existing phase prompts. Completion paths
are unique; prerequisites are feasible. There were no previous completion records.

## SHA-256 contract identities

| Contract | SHA-256 |
| --- | --- |
| `README.md` | `3caa68e855bd4a5de2c185a123451ad76cdc8e7119ddb81eddc1095492d8a1b5` |
| `01-simplify-mcp-contract.md` | `f212cddcbfc3836199ae2048da876aa3d0d30c7e163f79e73561ec962844dde5` |
| `02-mcp-settings-page.md` | `50b050a61b7ebe5cd0e949e154cd49a95ee868a235fa2d9d240059d3c2d534bb` |
| `03-verify-and-rollout.md` | `df5d94b8465fd464d9d0ec21212da9a8af2fc90753ea3337bed254e99212f0af` |
| Repository `AGENTS.md` | `eb9bb2400afb49e5500666234b385facde6cdbba874285e0f51d90c5a5d8a81e` |

## Runtime and design decisions

- Preserve the canonical API and its finite 124 operations; replace only the
  public tool registrations with typed coherent families and exact instructions.
- The running SDK catalog is the sole metadata owner. The settings path is
  optional read-only visibility, never a business/startup/synchronization gate.
- Preserve the prepared-secret Azure model; add no provisioning workflow.
- Execute phases sequentially, with at most one active phase. Requested worker
  launch settings are `gpt-6.1-sol` and `xhigh`; actual launches are recorded below.
- Use only approved package-feed proxies. Dependencies are present locally;
  no installation has been performed.
- Current Python verification environment: Python 3.14.6, pytest 9.1.1,
  MCP SDK 2.3.0. Editor/Pylance tooling was not available in tool discovery;
  Python behavior will be grounded in SDK/runtime tests and strict static checks.

## Validation and environment ledger (initial preflight; historical)

- Passed: initial worktree/status and ordered-manifest reconciliation.
- Passed: Docker context/socket, running-service names/ports, retained volume
  labels and network labels. No environment mutation.
- Passed: local pytest and SDK availability.
- Not run yet: implementation, protocol, browser, deployment and observation
  checks. Image compatibility still requires manifest/architecture validation.
- A read-only Docker inspect template failed because bind mounts have no `Name`
  field. No resources were changed; repeat using safe optional-field lookup.

## Worker and phase evidence

Phase 01 worker `589299ca-2eee-405b-9310-614a096e39e2` launched with explicit
machine parameters `model=gpt-6.1-sol`, `reasoning_effort=xhigh`; returned complete.
Parent read the full completion and mapping, reviewed domain registration,
strict discriminated request/result models, safety invariants, invocation/output
accounting, diagnostics and changed SDK/API consumers. Phase 01 accepted:

- 124 canonical operations retained exactly once; 62 public tools; 84 replaced
  public aliases rejected.
- Discovery: 1,130,328 -> 677,526 UTF-8 bytes (40.0593% reduction); 462-word
  exact initialization instructions, same SDK/serializer and full schemas.
- Worker: 824 Python passed, 21 unchanged guarded Azure-emulator skips;
  98 isolated backend tests passed and 12 real SDK/API journeys/58 calls;
  629 frontend regressions passed; Ruff, mypy and backend typecheck passed.
- Parent discriminating rerun:
  `cd mcp && .venv/bin/python -m pytest --basetemp=../.local/mcp-interface-parent-phase-01 -o addopts='' -q tests/test_discovery.py tests/test_tools.py::test_final_sdk_envelope_at_the_exact_representable_byte_boundary tests/test_tools.py::test_final_protocol_output_including_text_and_structure_is_bounded`
  -> **6 passed, 2.54 seconds**.
- Host SQL fixture-guard attempt remains recorded failed (44 passed, 2 failed);
  both refused-host cases passed in both authorized isolated 98-case runs.
- Actual model-assisted/native-client and interactive production proofs remain
  unperformed, not passing. Existing authority boundaries retained; exact owners,
  numeric triggers and continuation are in the phase completion.
- Worker cleaned its two exact disposable stacks and four owned image tags.
  Parent confirmed only the original four production/unrelated containers run.
- No plan contract changed; all four recorded hashes remain current.

Worker `cbd6fb01-b8bf-448e-a4b7-8205db5a01b7` launched with explicit machine
parameters `model=gpt-6.1-sol`, `reasoning_effort=xhigh`; returned complete_with_risk.
Parent accepted phase 02's implementation and actual isolated proof after review
and the missing-file fix below. Phase 03 is now the sole active phase.

During phase 02's real container verification, its worker found the capacity/drain
driver still calling the removed canonical leaf
`get_capability_check_progress`. Parent authorized the owning worker's narrow
consumer repair to the current `capabilities`/`progress` wire request, preserving
all capacity/drain assertions. This qualifies phase 01's prior consumer-coverage
claim. Parent reconciled phase 01's completion with phase 02's 14 successful
container driver runs, unchanged capacity/backpressure assertions and 3.171-second
drain against 75 seconds. No public alias or parallel owner was added.

Phase 02 evidence and parent decisions:

- Protected final-SDK metadata -> tenant-bound browser API -> read-only accessible
  page implemented across all roots; optional credential/configuration remains
  independent of ordinary startup/business admission and automatic sync.
- Actual metadata: 677,658 bytes; same-instance complete SDK discovery equality,
  62 tools, 124 operations, 462 instruction words; no catalog duplication.
- Worker: 463 Python, 79 backend, 702 frontend cases; 159 MCP image cases;
  78 browser selected / 70 passed / 8 existing skips; actual non-intercepted
  desktop/mobile browser/API/Python journey; 85 fixture/automatic-sync cases.
- Existing container owner: 14 successful synthetic journeys including restart,
  metadata outage/recovery, key continuity, capacity and authenticated drain.
  Exact owned resources cleaned; only original four containers remain running.
- Offline PowerShell suites ran in the existing no-network tooling image:
  389/164/31/306 assertions passed. Host entrypoints exited 137 before script
  execution; those literal commands remain unavailable, not passed.
- Parent independently reran 46 backend settings route/service and 10 frontend
  page cases: passed.
- Parent found a concrete configured-but-nonexistent metadata file startup bug.
  Added two failing regressions (2 failed / 7 passed); confined `OSError` to the
  optional metadata configuration boundary. Final complete phase-02 Python
  selection: **465 passed / 118.35 seconds**, Ruff and mypy passed.
  Phase 03 must rebuild with this final fix.
- Native PowerShell signature verifies valid. No cause of host exit 137 is
  established; no binary/security-policy alteration or socket shim is authorized.
- Azure live/compiler/network proof and real native/model-assisted/interactive
  production journeys remain explicit unperformed proof, not successful checks.
- Mandatory phase-03 normal deployment remains authorized; attempt it using the
  existing native owner and truthful exact-target preflight. If literal inability
  persists after safe supported-runtime investigation, preserve production and
  record deployment_pending with an exact owner/resumption command.

Phase 03 worker `26f49db4-8f6d-4402-9cca-63ce5a4aa2fb` launched with explicit
machine parameters `model=gpt-6.1-sol`, `reasoning_effort=xhigh`.
Immediately before this phase, parent's native PowerShell trivial command again
exited 137. Private continuity comparison confirmed all seven original
OAuth/session/database/tenant credential files unchanged in content, mode,
UID and GID; no production metadata credential exists yet. The worker must
investigate the runtime safely and attempt the exact normal deployment, not
silently replace its control-plane owner.

Phase 03 initial result: `deployment_pending`. Normal `seha` start attempted
twice, exit 137 before script execution. Native .NET also receives SIGKILL;
bounded supported-environment diagnosis did not establish the cause. No security
policy/binary/signature modification, alternate installation or socket shim.
Existing production remains on original app/MCP images and healthy.

- Aggregate: 837 Python passed / 21 guarded Azure skips; 5,686 frontend passed;
  267 isolated backend passed, including 12 real SDK/API journeys / 58 calls.
- Browser effective final coverage: 138 passed / 8 existing skips, from the
  original four-file run plus affected data-sync rerun, not a fictional single
  all-passing run. Exact non-intercepted settings journey passed at both widths.
- Builds, typechecks, frontend lint, Ruff, mypy and diff hygiene passed.
- `check:unused` failed on exactly two unrelated existing Office-adoption exports.
  Parent reproduced the count and verified both owners equal HEAD; not fixed
  outside scope or concealed as passing.
- Offline PowerShell 389/164/31/306 assertions and rebuilt MCP image 161 tests
  passed. Host literal toolkit commands remain unavailable, not passed.
- Parent read the full completion and final changed consumers, verified all 23
  content hashes and nine owner hashes, and independently reran final Compose/
  discovery/canonical mapping: 16 passed in 1.34 seconds. Scratch cleaned.
- Worker cleaned its exact stack, eight image identities and scratch. All 11
  pre-existing containers (four running/seven exited), production volumes/network,
  keys and approved input images were preserved. No new credential created.
- Live authenticated/native-client proof and post-deployment 600-second
  observation are not run; new-revision error/disclosure/dispatch counts unknown.

Parent retained-context follow-up confirmed and repaired the final lifecycle
defect: automatic metadata credential creation added a third Compose input while
the initial snapshot/applied records still listed two; the next unchanged start
then changed the receipt and restarted unnecessarily. The existing deployment
owner now reconciles its final frozen Compose command/files and applied inputs
before configuration validation and identity/receipt creation.

- New actual-owner offline regression failed before repair: three inputs used,
  two recorded, next start not a no-op, receipt changed.
- Repaired: all three frozen inputs recorded consistently; next start is a no-op,
  unchanged receipt and all seven original synthetic keys retained; independent
  metadata credential automatically created once and reused.
- Final focused offline proof: **424 runtime + 164 MCP + 113 fresh-installation
  assertions passed** (701 total). Only the existing owner/test changed.
- Final runtime owner SHA-256:
  `7d9ea28bd5945b481e069dbd49c656b51b172ed493c10801d709e693cff059fa`.
  Runtime tests:
  `a794cbc8e418558b6a2bd9c5a000b1f0c5d999e7fb5c8a7268fab9153ff155c0`.
- Parent reviewed the narrow owner diff and behavioral regression, checked the
  updated completion, and reverified that all 23 aggregate source hashes and
  the other eight recorded owner hashes remain unchanged. `git diff --check`
  passed; original four running containers remain intact; web ready is healthy.
- No further native/runtime diagnosis, production action or deployment retry
  occurred in this follow-up. All campaign workers are idle, no owned long-lived
  helper remains, scratch is cleaned, and no cleanup incident remains open.

All changes remain uncommitted in this repository; no branch, commit or push.
The stable three-phase denominator and all original plan/shared-contract hashes
are unchanged. Full phase receipts preserve earlier failed attempts, guarded
skips, reused proof and exact image/resource identities separately.

Parent additionally checked the final isolated phase-01 `result.json` (empty
failure array) and cleanup receipt. Its own exact pytest temporary directory was
removed after the six-test rerun. Original app/MCP images have no source-hash label,
so no pre-existing label-based source identity is claimed.

Parent independent preflight while phase 01 implements:

- Production PostgreSQL container identity:
  `05314812fa9289806d5086fcf94d2ad500fda3021cda3b3581c41abf54cfc813`;
  image `sha256:051f7b7b3abdd564d5d1bd1e8c4b9c1b6e77087d1dd22020ede611c096a272e0`.
  Healthy, retained volume mount `seha_data`.
- Existing network identity:
  `0687fdd649a831c7e3c89a3fc8cdcd222125ce45ee6628ab235209ad20cb674b`.
- `curl --max-time 10 http://127.0.0.1:3002/api/health` and `/api/ready`:
  passed (`{"ok":true}`). Auth status: configured. These are not saved-read proof.
- Integrated-browser page at `http://127.0.0.1:3002/` renders the ordinary
  sign-in form. No authenticated session available in that page; no sign-in
  automation, borrowed credentials or role bypass attempted.
- Original OAuth/client, session, tenant and database secret files are regular
  files with mode 0600. Protected hash-only continuity receipt captured in the
  session's private files directory, without copying or printing credential
  values. Compare it before/after final normal deployment.
- Verified installed-dependency image
  `agent-control-import-fix-eaf8369f-dependencies:local`,
  `sha256:7d398a507b26ead060f6fe949abd9b498331f0dae8786e33b42b027d760f9d34`,
  arm64, Node v24.20.0: all four dependency-manifest hashes match checkout.
  Read-only `docker run --rm --network none` inspection containers exited.
- Candidate browser image `seha-permission-browser:local`,
  `sha256:537119809ef81c495519e566018e3c8a078455f6ed3fe0d82a67b0a83c6a1d49`,
  arm64, contains Playwright packages and `/ms-playwright` browser binaries.
  Phase 02 must validate the exact required browser/package contract before use.
- Corrected Docker inspect confirmed expected production mounts read-only
  except application diagnostics and retained database/OAuth data.
- No production resource, key, configuration or data changed.

## User-deployment follow-up: metadata Host rejection

The user-deployed application and MCP are healthy but settings returned
`metadata_unavailable`. Direct authenticated API-container requests to
`http://mcp:8000/internal/mcp-metadata` returned **421 Misdirected Request**.
The independent metadata credential and mounts were valid. FastMCP correctly
retained its public Host/Origin protection; it was not an OAuth/provider error.

An actual Node v24.20.0 HTTP listener proved that built-in `fetch` silently sent
the destination Host despite a configured `Host` header. Native `http.request`
sent the required public Host and received **200**, with a complete payload
accepted by the deployed strict parser. The existing Python readiness check
already uses this same private-transport/public-Host pattern.

The existing backend reader now uses native HTTP(S), sending the Host from the
validated public resource while retaining the fixed private destination,
metadata-only credential, TLS verification against the destination, no redirects,
three-second total cancellation, 4 MiB streamed bound and strict binding/parser.
No MCP guard, role, OAuth, deployment, synchronization or database policy changed.

Focused evidence:

- The new real HTTP Host regression failed before repair and passes afterward.
- **75 backend tests passed**, including native stalled-header/body deadline
  cancellation, reader bounds, browser authorization and tenant navigation.
- **15 Python metadata tests passed**; public Host accepted, private Host rejected
  with 421, untrusted Origin rejected with 403, and metadata credential still
  cannot authorize a business request. The ASGI test explicitly models the
  deployed server bind instead of inferring it from the caller's Host.
- Backend typecheck/build, Python Ruff and `git diff --check` passed.
- A disposable read-only helper used the actual application image and its
  read-only mounts, replacing only its reader module with the current compiled
  source. Against the running MCP it returned `available`, **62 tools**,
  **462 instruction words**, ready storage and an exact resource binding.
  This is actual repaired-reader/live-MCP evidence, **not an app redeployment**.
- Helper `ac-mcp-live-metadata-4d80f604` was removed automatically; only the four
  existing production/unrelated containers remain. No production service,
  credential, OAuth record or database was changed.
- The signed-in shared browser session remains intact at `/mcp-settings`,
  showing the unrepaired application's honest unavailable state.

Initial user-deployed identities, unchanged during the first diagnostic follow-up:

| Resource | Container | Image |
| --- | --- | --- |
| App | `6f0a7960826ac9d21e26c7f57d99b505e2fea1a8b0a4c06efaa7ce9adf9e06f8` | `sha256:4ee57f2d2568886ea3a729d7c444a8b3c38e460b1cea60681a8ecae060977f98` |
| MCP | `40990c6f3c783c051acbc49738353eae396b04421e1d2db1bf1af33db6d1e250` | `sha256:ecba025f5cf7e9ba91d01680d724349e29eb26eb46d664a38ce90154784ae512` |
| PostgreSQL | `05314812fa9289806d5086fcf94d2ad500fda3021cda3b3581c41abf54cfc813` | `sha256:051f7b7b3abdd564d5d1bd1e8c4b9c1b6e77087d1dd22020ede611c096a272e0` |

### User normal redeployment and readiness follow-up

The user ran the normal owner successfully from PowerShell. App container is now
`56bb19ff503ff304d5e3f6f6c5b4ecbe172ab21a00ca7712ea524308fd0e0bb2`,
image `sha256:1383c69c91e23a130a4dc1bfb2df6e5f70edc77d29b857021f4b6896a3119973`.
MCP and PostgreSQL retained their preceding container/image identities.
Private comparisons confirmed byte-identical hashes, UID/GID and mode 0600 for
all seven original credential/registry files. An initial comparison incorrectly
interpreted the receipt's decimal mode 384 as octal; inspecting its encoding
resolved that diagnostic-only error without changing any file permissions.

The actual browser/API proof returned HTTP 200, `available`, 62 tools,
462 words, exact instruction/description equality and the correct callback.
The existing signed-in session survived the redeployment and showed its Sign out
control. Public endpoint/client qualification correctly remains `Unverified`.

One metadata observation returned `storageReady: false` while routine readiness
verification was in flight; subsequent actual reads returned true. The flag
added by this campaign cleared previously successful readiness at the start of
every probe. Two deterministic held-probe tests reproduced the false-negative.
The existing check now publishes its result only when completed, including
not-ready on any failure/cancellation, without suppressing errors or making
metadata perform OAuth-record reads/writes. The focused metadata/storage/OAuth/
onboarding suite passed **104 tests**; Ruff and strict mypy passed.

Opening saved Agents then requested Entra reauthentication (HTTP 401), and the
shared browser reached the real provider's MFA prompt. No sign-out was clicked,
authentication was not bypassed, and no credentials/MFA response were requested.
Complete normal authentication after the final readiness repair redeployment,
then verify saved Agents/Users and run the ten-minute observation.

## Original campaign final normal deployment and live qualification

The user completed the final normal deployment and shared-browser Entra sign-in.
App container/image remain `56bb19ff503ff304d5e3f6f6c5b4ecbe172ab21a00ca7712ea524308fd0e0bb2` /
`sha256:1383c69c91e23a130a4dc1bfb2df6e5f70edc77d29b857021f4b6896a3119973`.
Final MCP container/image are
`8b12ee628aa51a4640b3bc8c45a730573d552257930a28c188279d0188c9e6da` /
`sha256:9b309f8eae12421b12c6c01a68cfae01a7ea46536af7b41b222317f5e13dd96a`.
Its installed readiness source hash equals the current source. PostgreSQL retains
its original container/image. Private comparisons verified unchanged bytes,
0600 mode, UID and GID for all seven original credential/registry files.
Docker Desktop's `/host_mnt/Users/` inspect paths were normalized to their
verified macOS `/Users/` counterparts for that private comparison.

- Actual authenticated page/API: HTTP 200, 62 tools, 462 instruction words,
  exact full instruction/description equality and correct public callback.
- Actual refresh/search/schema: 33 inventory search matches, exact full input
  schema, no truncation; refresh issued only `/api/mcp/settings`, no sync/control
  requests. Viewport 360 x 780 retained all 62 tools without horizontal overflow;
  original viewport restored.
- Actual saved Agents: 1,348 total, 35 rendered rows; saved Users: 50 rendered
  rows. Both loaded without alerts or invented approval gates; no collection
  was forced. Returned the shared signed-in browser to MCP settings.
- Normal reauthentication recovered the stale verification session; subsequent
  `/api/me` and metadata reads remained HTTP 200 beyond the role-revalidation
  interval. No role/freshness/MFA check was weakened.
- Public tunnel health and protected-resource discovery: HTTP 200, exact resource
  binding; unauthenticated public MCP: HTTP 401 with OAuth challenge.
- Missing/invalid internal metadata credentials, unauthenticated public metadata
  and absent browser session: HTTP 401, no metadata disclosure.
- Observation `2026-11-04T12:52:24.497Z` through approximately
  `13:02:24.600Z`: **600.102751939 seconds**, **11/11 available**, 62 tools,
  ready storage and stable full catalog in every sample, zero metadata failures.
  The bounded HTTP log window contained 322 requests, six successful browser
  metadata reads and **zero 5xx**. Five 401s were the documented negative/stale
  authentication checks, not metadata success-shaped fallbacks.
- Only the three expected production containers and unrelated Redis remain.
  No disposable helper, database reset, original-key rotation, OAuth clearing,
  commit or push occurred. Final `git diff --check` passes.

Native PowerShell still exits 137 in the agent environment; the user's working
PowerShell terminal executed the normal owner without any orchestration bypass.
The first Bash-style assignment was rejected by PowerShell before deployment;
the corrected native PowerShell syntax succeeded.
Actual authenticated native/model-assisted client proof remains a documented
residual, never an application-owned runtime prerequisite.

## User follow-up: parked MCP tools and enterprise settings design

Source implementation and isolated verification completed on 2026-11-04.
Normal deployment and live browser/API verification also completed on that date.
The preceding 62-tool live evidence describes the historical original campaign.

### MCP-only retirement

Removed 12 public MCP tools covering 19 canonical operations: `purview`,
`hunting`, `get_agent_investigation`, `resolve_agent_identity`,
`start_purview_search`, `resume_purview_search`, `cancel_purview_search`,
`delete_purview_cache`, `start_hunt`, `resume_hunt`, `cancel_hunt`, and
`delete_hunting_cache`. Current source exposes **50 tools / 105 operations**.
Unused MCP-only definitions, registrations, instructions and affected tests/docs
were removed together, without aliases, hidden registrations or feature flags.
The corresponding canonical APIs, provider implementations, authorization and
complete shared response payloads are unchanged.

Retirement verification: **786 Python tests passed / 21 guarded skips**,
**95 focused backend tests passed**, Ruff, strict mypy and backend typecheck passed.
The bounded worker used GPT-6.1 Sol with xhigh reasoning as requested.

### Enterprise page redesign

The page distinguishes three kinds of information: deployment-owned connection
values, observed runtime facts, and exact client instructions/tool contracts.
Its visual language follows the existing Permissions and Sync pages: Segoe/system
type, restrained purple accents, a 28px desktop / 25px mobile heading, white
bordered cards, 12px corners and consistent spacing.

- Separate connection and runtime cards distinguish internal reachability, OAuth
  storage readiness, public endpoint verification and authenticated-client proof.
- Exact instructions use readable proportional prose, word count, copy action
  and progressive disclosure rather than an always-expanded monospace dump.
- The tool catalog searches full names, titles, descriptions and schemas, supports
  an explicit read-only-hint filter and provides a recoverable no-results state.
  Expandable rows retain full descriptions, all four annotation values and exact
  input/output schemas. Named keyboard-focusable schema panes scroll internally.
- Copy failures are visible. Server text remains inert. Principal-bound request
  cancellation, role checks and metadata-only reads are preserved. No new
  synchronization, provider operation or application-owned approval gate exists.

Verification:

- **77 focused frontend tests passed**, full frontend ESLint passed, and the
  existing Docker target built/typechecked both backend and frontend offline.
  No dependency installation was needed; the pre-existing large JS chunk warning
  remains unrelated.
- **6/6 real Chromium workflows passed**, desktop 1440 x 1000 and mobile
  360 x 780, through the actual browser session API and current Python service.
  The source fixture advertised **50 tools and 444 instruction words**.
- Verified exact instruction/description/schema equality, search and refresh,
  keyboard schema scrolling, no horizontal overflow, zero WCAG A/AA axe
  violations, unconfigured-tenant isolation, retry, long inert text, logout and
  cancellation of an outstanding refresh. Positive screenshots of overview,
  instructions, runtime and expanded contracts were visually inspected.
- The reused Python base originally imported its old installed wheel despite a
  source bind. Import provenance was checked; `PYTHONPATH=/opt/mcp/src` selected
  the current read-only source for the successful run. No application fallback
  or catalog-count workaround was introduced.
- Only declared isolated test PostgreSQL and the existing browser fixture were
  used, without live-provider network access. The exact `ac-mcp-ui-4d80` project,
  its disposable database volume and owned image tags were removed afterward.
  Original app/MCP/PostgreSQL containers and unrelated Redis remain unchanged.

### Follow-up normal deployment and live proof

The user executed the existing normal deployment owner from their working
PowerShell terminal and signed in. Current deployed identities:

| Service | Container | Image |
|---|---|---|
| App | `a5a2b2444231217c96be752bedadd969017bc8cdbe157982d3d9e438e3c88cfd` | `sha256:bdfd079f1b9d3f463d46e3f8528993b730f923bf7c7ebf5721de240f755f228e` |
| MCP | `6ad586e877bc320fb66380d502d2cbe51c0993481ca59f47051b4a7404af8a67` | `sha256:cca354abd3833372be4f4c3705830a65b1884f6a6873b149f3e218897d5a3bd9` |

- Authenticated metadata HTTP 200, `no-cache,no-store`, **50 tools**,
  **444 instruction words**, ready OAuth storage and all 12 retired names absent.
  Complete instruction and all 50 description strings equal the running server's
  metadata exactly.
- Actual browser interactions passed: expand instructions and inventory schema,
  complete schema equality, keyboard schema focus, search (**27 inventory
  matches**), explicit read-only filter (**19 tools**), no-results/reset, and
  metadata refresh. The recorded interaction requests were only two GETs to
  `/api/mcp/settings`; no synchronization/control request was issued.
- Actual deployed desktop screenshot visually inspected. Narrow 360 x 780
  rendering retained all 50 tools, a 25px heading and no horizontal overflow;
  positive overview/runtime screenshots were visually inspected. Temporary
  Chromium device metrics were cleared, preserving the original native viewport
  (`viewportSize() === null`), and the shared browser was returned to MCP settings.
- Saved Agents rendered **35 rows**, saved Users **50 rows**, both without
  alerts. No collection was forced and no application approval was required.
  Following the shared browser's real Entra/MFA sign-in, `/api/me` returned
  HTTP 200. No session, role, provider or MFA requirement was bypassed.
- Public MCP health HTTP 200; unauthenticated public MCP and metadata each
  HTTP 401. Public process health is not claimed as authenticated-client proof.
- PostgreSQL retains original container
  `05314812fa9289806d5086fcf94d2ad500fda3021cda3b3581c41abf54cfc813`
  and image `sha256:051f7b7b3abdd564d5d1bd1e8c4b9c1b6e77087d1dd22020ede611c096a272e0`.
  A private comparison confirmed unchanged bytes, 0600 mode, UID and GID for all
  seven original credential/registry files. No secret value/hash was output.

The redesigned page and tool retirement are deployed and ready for user testing.
Actual authenticated native/model-assisted MCP-client selection remains the
original documented residual, not an invented runtime prerequisite. No commit,
push, database reset, credential rotation or additional deployment gate was added.
