# Phase 03 — role-aware native MCP surface

## Result and authority

- **Result: `complete_with_risk` (2026-11-06).** The local implementation and
  affected native SDK/API/SQL/settings/browser journeys are complete. Required
  focused checks and the final isolated SDK selector pass. The separate
  production-image restart/rotation container selector is unavailable in this
  execution environment; inherited capacity remains failed, not qualified.
- Worker launch supplied by the parent: **`gpt-6.1-sol` / `xhigh`**. No nested
  agents were launched.
- Repository: `/Users/candede/repos/agent365/agent_control`. Existing campaign
  changes were preserved. No commit, push, branch, revert, production/seha
  mutation, Entra operation, live provider test or database reset occurred.
- The parent alone owns `completions/IMPLEMENTATION_CAMPAIGN.md`; this worker
  did not edit it. Phase 04 remains responsible for coordinated deployment.
  Production is **`deployment_pending` / `production_hardening_pending`**,
  not certified by local tests.
- No release approval, manual start, feature-enable, canary acceptance or other
  runtime prerequisite was added. Actual authentication, current permissions,
  selection integrity and destructive-action confirmation remain enforced.

## Native SDK feasibility and implementation

The feasibility test ran before the production cutover and passed with two
signed OAuth/OBO audiences: **1 passed in 0.45 seconds**. The installed public
contracts were inspected rather than inferred from a different SDK:
FastMCP **4.1.0**, MCP **2.3.0**, Pydantic **2.14.0**, host Python **3.14.10**.

- Supported `Middleware.on_initialize`, `on_list_tools` and `on_call_tool`
  receive authenticated request contexts. The additional supported modern
  `on_discover` hook also checks authority and enters API admission; its
  discovery result is private with zero cache TTL.
- Native tools use public `Tool.from_function` and the existing SDK
  serializer. There is no custom protocol server, generic route executor,
  universal discovery tool, mutable global role registry or full-catalog
  fallback.
- `projection.py` filters the immutable `PUBLIC_TOOLS` through the canonical
  API method/route/finite-input projection. It rebuilds surviving family
  models, dropping unauthorized actions, descriptions and unreachable input/
  output definitions. Capability probe input enums come from the API guard
  registry, not a Python role matrix.
- `PublicTool.grouped` is explicit. A two-action family reduced to search
  keeps `request:{action,input}` and `{action,result}`, with only surviving
  definitions. The real invocation returns exactly that envelope in text and
  structured content. Read-only/idempotent/destructive hints are recomputed
  from the surviving operations.
- Every call validates the current projected tool and exact request envelope
  before the canonical invocation rechecks operation permission and finite
  choices. The API remains final authority. Hidden names, forged actions,
  unauthorized capability IDs and employee subject/preview overrides fail
  without business/provider dispatch.
- The pinned MCP error constructor is `(code,message,data=None)`, not an
  `ErrorData` argument. Authority failures now produce supported native errors
  rather than raw transport exceptions or successful unrestricted discovery.

## Exact operation and audience contracts

All new public tools are native families. The adapter injects the immutable
canonical `operation`; callers cannot select an API route or arbitrary
discriminator.

| Tool | Action | Canonical operation | API body operation |
| --- | --- | --- | --- |
| `agent_catalog` | `search` | `search_agent_catalog` | `search` |
| `agent_catalog` | `detail` | `read_discovery_detail` | `detail` |
| `my_workplace` | `read` | `read_my_workplace` | `workplace` |
| `my_discovery_profile` | `read` | `read_my_discovery_profile` | `profile` |
| `preview_end_user` | `profile` | `preview_discovery_profile` | `profile` |
| `preview_end_user` | `search` | `preview_discovery_search` | `search` |
| `preview_end_user` | `detail` | `preview_discovery_detail` | `detail` |
| `preview_end_user` | `workplace` | `preview_discovery_workplace` | `workplace` |

The first four operations use `POST /api/discovery/read`; the last four use
`POST /api/discovery/preview` with an exact subject on every action.
`discovery_models.py` positively models the current safe API DTOs, not staff
inventory/adoption responses. Requests retain the canonical bounds: goal 512,
at most eight 128-character terms, 1–20 cards, cursor at most 4,096 characters,
typed exact IDs, optional opaque selection and finite workplace scope.

- **EndUser:** exactly the first three tools/four operations. No other-user
  subject or preview capability, administrative metrics, controls or jobs.
- **Viewer/Uploader:** 38 tools/90 operations: their existing 82 authorized
  canonical operations plus the eight safe discovery/preview operations.
- **Admin:** 54 tools/113 operations: all previously supported 105 canonical
  operations plus the eight additions.
- Viewer/Uploader exclude these 23 Admin-only canonical operations, including
  their family variants/definitions:
  `block_package`, `block_packages`, `block_selected_packages`,
  `cancel_package_control`, `cancel_studio_control`, `count_package_targets`,
  `execute_agent_control`, `execute_studio_control`, `get_agent_control`,
  `list_administrative_audit`, `list_agent_usage_candidates`,
  `preview_agent_control`, `preview_package_control`, `preview_studio_control`,
  `reconcile_package_control`, `reconcile_studio_control`,
  `resume_package_control`, `resume_studio_control`, `unblock_package`,
  `unblock_packages`, `unblock_selected_packages`, `update_package_access`,
  `update_packages_access`.
- Uploader and Viewer have the same operation count but different permitted
  capability-probe enum contents. No provider-readiness requirement is used
  as authorization.

The complete tool/action/canonical-method/route/body-operation maps are retained
in `artifacts/test-scratch/phase03-audience-operation-map.json`, SHA256
`4922f61e81a239f10310e8bf01e112ff01839802e01d084b9668a9a20f56095d`.
Its profile fixture is generated by actual `createApp` route policy and
`mcpAccessProfile`, with a source-workspace drift assertion; it is not a second
business policy owner.

### Actual SDK discovery measurements

Counts are measurements, not new target limits. “Discovery bytes” is compact
UTF-8 serialization of the actual SDK initialize-plus-tools document, without
HTTP/JSON-RPC framing. Metadata bytes are the actual private response body.

| Audience | Tools | Operations | Discovery bytes | Metadata bytes |
| --- | ---: | ---: | ---: | ---: |
| EndUser | 3 | 4 | 26,552 | 26,684 |
| Viewer | 38 | 90 | 481,399 | 481,531 |
| Uploader | 38 | 90 | 481,425 | 481,557 |
| Admin | 54 | 113 | 616,237 | 616,369 |

Complete nested schemas are preserved; the larger authorized staff catalog was
not truncated to an arbitrary count or byte-reduction goal.

## Current identity, bootstrap and non-tool admission

- Each invocation obtains `/api/mcp/access-profile` through validated same-user
  delegated/OBO authority. Its profile and coalescing lock live only inside that
  invocation, never across users, sessions or requests. Calls retain the existing
  60-second invocation, eight-request, two-exchange, four-concurrent-request and
  512-KiB business-output budgets. Internal authority responses remain individually
  bounded but are not counted as emitted business output.
- Initialize, list and modern discovery call the API-owned
  `/api/mcp/authenticated-entry` even without a business call. No scheduler,
  source selector or admission store was added to MCP. A real initialization-only
  test observes exactly profile plus admission before any business/list call;
  token refresh, reconnect and repeated lists still enter the same API owner.
- Native tests cover concurrent employee/Viewer/Admin on one server, current
  demotion, stale advertised schemas, finite input forgery, guest authority
  denial, expiry/refresh/revocation and explicit profile lookup failure.
  The existing canonical owner retains deduplication and principal-epoch rules.
- The SQL fixture now records automatic authenticated-entry work independently:
  all **16 privacy/audience combinations** produced **80 admission calls** and
  **68 separately refused synthetic provider-read attempts**, with **zero
  business-discovery provider attempts**. These are calls/attempts, not claims
  of 80 distinct jobs or successful live collection.
- Initial authentication legitimately refreshes source state. The authorized
  control fixture now authenticates before capturing its saved selection rather
  than expecting an earlier selection to survive bootstrap. Its synthetic
  provider distinguishes Graph read-only `$batch` POSTs from actual block/
  quarantine writes; bootstrap cannot silently become a fake control write.
  Destructive confirmation, stale-selection denial and provider effects are
  unchanged.
- `/diagnostics` requires the API's current staff audience/operational decision.
  Employee and guest callers are denied; Viewer/Uploader/Admin remain allowed.
  Public OAuth discovery/callback/health behavior and separately credentialed
  metadata/recorder boundaries remain separate, with no authentication cycle.

The reset/auth contract was not changed. The current schema remains **107
tables /81 functions**, fingerprint
`78fa2785984b89e6e95a1c88ad60105138993c49ec517df457bb7f555006dd40`.
Only genuine positive principal revocation epochs/cutoffs survive reset. No
blanket reset fence, timestamp rewriting or grace rule was reintroduced.

## Safe preview, privacy, instructions and settings

- Preview stays request-scoped to the actual actor and explicit saved subject.
  Target Admin assignment never lends a Viewer Admin authority. Genuine target
  self-service matches preview's exact department/company top-three answers,
  period and safe DTO, apart from opaque selection and neutral context labels.
  A subsequent default read still resolves the real actor.
- Department scope remains stored company **plus** department; company scope
  remains stored company alone. Missing stored scope/report evidence is explicit,
  not tenant scope, an email-domain guess, no agents or a provider-access grant.
- All four independent privacy combinations run through actual native MCP text
  and structured results, complete catalog pages, full description continuations,
  nested provenance and each staff preview. Current API sanitization is the sole
  owner. Tightening is reprojected on the same token; canonical stale selections/
  cursors do not recover hidden identities. Earlier conversation history cannot
  be erased by refreshing schemas.
- Initialization instructions are role-neutral. Projected descriptions condition
  owner/champion contact guidance on the API booleans. Hidden means withheld, not
  absent; source text is inert, not instructions. Goal expansion, evidence,
  complete paging, freshness/errors, honest use-link/access limitations and
  visible staff confirmation/recovery remain covered.
- Backend derives trusted projection from current policy and POSTs at most
  65,536 bytes to `/internal/mcp-metadata`. MCP returns the same projected SDK
  serializer/instructions used by actual native discovery. The independent
  metadata credential grants no business authority. Fixed origin, public Host,
  binding validation, no redirects, no-store, three-second deadline and streamed
  4-MiB response bound are retained.
- Settings exposes both API-owned booleans and `end_user_and_preview` scope
  independently of MCP reachability. The frontend is read-only: no policy toggle,
  editable catalog or client override. Four-combination component checks and
  real browser default/outage checks pass.
- Removed unconditional public metadata catalog GET, old all-users/full-catalog
  assumptions and stale 50/105 assertions. There is no `my_department` alias.
  The recorder's deliberate unprojected operator snapshot stays internal.
  Current reference/client/setup/Studio guidance describes individual identity,
  employee discovery and explicit staff preview without claiming live Studio
  publication was tested.

## Verification actually executed

### Host and browser

| Command/selection | Final result |
| --- | --- |
| Native pytest: discovery, tools, service, settings metadata, OAuth, workflows, recording; audience projection, SDK hooks, API origin, onboarding, client examples | **628 passed**, 214.81 seconds |
| `ruff check src tests` | passed |
| `mypy` | passed, 26 source files |
| Backend settings service/route unit, policy, canonical MCP access and contract feasibility | **66 passed /5 files** |
| Frontend MCP settings component, authorization and settings parser | **44 passed /3 files** |
| Backend/frontend typechecks | passed |
| Frontend ESLint | passed |
| `git diff --check` | passed |
| Existing `cutover-browser-contract`, only `mcpSettings.spec.ts` | **6 passed**, 3 desktop +3 mobile, 0 skipped/flaky/unexpected; 17,344.103 ms |

The final native command was:

```sh
cd mcp
.venv/bin/python -m pytest -o addopts= --basetemp=../artifacts/test-scratch/phase03-final-tests -q tests/test_discovery.py tests/test_tools.py tests/test_service.py tests/test_settings_metadata.py tests/test_oauth.py tests/test_workflows.py tests/test_recording.py tests/test_audience_projection.py tests/test_sdk_projection_hooks.py tests/test_api_origin.py tests/test_onboarding.py tests/test_client_examples.py
.venv/bin/python -m ruff check src tests
.venv/bin/python -m mypy
```

Final logs: `artifacts/test-scratch/phase03-python-current.log`,
`phase03-backend-verified.log`, `phase03-frontend-focused.log` and
`phase03-frontend-lint.log`. A prior overlapping pytest invocation collided with
the repository's shared default fixture directory; the final isolated path run
above replaces that failed setup attempt, not a waived test.

Browser project **`b42915597b2446b39b5628e4cba9af60`** selected exactly:
projected catalog/schema/instruction equality and keyboard/axe/layout checks;
unconfigured tenant isolation; and outage/retry/inert long text/logout-race
behavior, each on desktop/mobile. Its first case uses real browser → session
API → Python MCP with no route interception. The negative UI case deliberately
intercepts an actual settings response; it is not provider-policy evidence.
`permission-browser-results.json` and `result.json` retain the exact receipts.

### Final actual SDK → canonical API → isolated SQL

Existing selector **`mcp-end-to-end`**, project
**`44cb6675533240dbbf0066fe9bb4d935`**:

- **162 passed /7 files**, test command 343,102 ms; backend typecheck passed
  in 2,631 ms. `agentDiscovery.test.ts`: **14 passed**; existing authorized
  `sharedAgentControls.test.ts`: **21 passed**.
- **54 real SDK clients /418 native business calls**; 9,468,124 aggregate
  result bytes, maximum observed business call 0.416106 seconds. These small
  fixture timings are not large-tenant capacity measurements.
- The Python journey now uses actual `ClientSession` initialize/list/call,
  signed OAuth/OBO and the real canonical adapter, not its former manual
  protocol helper. Every journey asserts exact metadata/native schemas and
  instructions, text/structured parity, and two API admission entries.
- Source: current canonical bindings, selection/subject isolation, all privacy
  combinations, full continuations and unchanged authorized controls.
  Earlier nine/five/two-failure iterations exposed and repaired SDK constructor/
  typed-meta, stale contract-map and bootstrap-sensitive fixture defects.
  They are not reported as passing or left as residual production defects.
- Final work log:
  `artifacts/large-tenant-data-platform/44cb6675533240dbbf0066fe9bb4d935/ef63faa47b003b772b9596edbdeffb90f0961b47d044feb5f51a683f8e6e5fc7.log`,
  SHA256 `d3ac92879666029649c0c45a10025877f33ccd665fca65dd8788d16014c87898`.
  Final `result.json` has no failures.

Both selectors used the existing PowerShell runner through the offline helper,
not a new runner:

```sh
docker run --rm --pull=never --network none --user 501:20 --group-add 0 \
  -e HOME=/Users/candede -e PATH=/usr/local/bin:/usr/bin \
  -v "$PWD:$PWD" \
  -v /Users/candede/.docker/run/docker.sock:/Users/candede/.docker/run/docker.sock \
  -w "$PWD" --entrypoint pwsh agent-control-phase03-powershell:local \
  -NoProfile -Command 'function docker { & /usr/local/bin/docker --config (Join-Path (Get-Location) "artifacts/test-scratch/roleless-docker-config") @args }; & ./scripts/large-tenant-tests.ps1 -Suite mcp-end-to-end -BaselineImage agent-control-roleless-baseline:local -BaselineImageId sha256:cc9f4e9efb6428322b82764ba35c40bbbb49890cd76ef563c7967182d85ba9cd'
```

Browser used the same wrapper with
`-Suite cutover-browser-contract -BrowserFiles mcpSettings.spec.ts` and the exact
cached browser tag/ID below. The separate `-Suite mcp-container` attempt aborted
before any runtime journey, as classified under residuals.

### Environment and exact image identities

- Existing `desktop-linux` context and exact
  `unix:///Users/candede/.docker/run/docker.sock`; no environment target
  override or seha substitution.
- Node baseline: `agent-control-roleless-baseline:local`,
  `sha256:cc9f4e9efb6428322b82764ba35c40bbbb49890cd76ef563c7967182d85ba9cd`.
  Existing manifest/lockfile/engine guards passed.
- Browser:
  `agent-control-ltdp-55b8ba2a9e804915bc59384b13bb5b26-permission-browser-test:local`,
  `sha256:505480f9b0aee32522714c3b49ce3382cd2037c4e6a41e4f1b84c1177d66aad1`;
  arm64, Playwright/core 1.58.2 and matching cached browser revisions.
- Current SDK fixture image:
  `sha256:ddf59f5e929b10c90f1a151456cb7b7602dd1e9d4d886cef394ed022e905dbc6`.
- Helper: `agent-control-phase03-powershell:local`,
  `sha256:adc88579e45b094c522501d10d9e5b778954c1bbb29883fe0d40a9c8bdb6386e`.
  It adds the genuine cached Docker buildx plugin to the existing genuine-Git
  helper; the initial missing `--provenance` plugin failure was repaired without
  weakening fixture guards.
- A real container `No module named pytest` failure established the missing test
  dependency before the existing Docker test stage restored its committed lock.
  Python restoration used only the configured approved proxy. No manifest or
  package version changed, no npm install was needed and no public npm/Python
  registry was probed.

## Cross-root changes and retained owners

- **backend:** trusted settings projection transport/types/route; SDK and
  HTTP identity fixtures; native SQL discovery proof; accurate bootstrap/provider
  accounting; current route/operation-map assertions; existing selector coverage.
  Discovery business logic, SQL/schema, ranking, policy, membership, automatic
  admission and reset/revocation owners were not reimplemented.
- **mcp:** finite DTO/bindings, explicit families, request-local native projection,
  initialize/discover/list admission, call checks, neutral/projected instructions,
  staff diagnostics and projected private metadata; affected fixtures/tests.
  OAuth/token, encrypted-storage and recording authority remain existing owners.
- **frontend:** read-only effective privacy and caller-catalog presentation,
  corresponding parser/component/browser fixtures. Employee navigation and
  existing role checks remain unchanged.
- **scripts:** no phase03 source changes. Existing local/isolated/browser
  selectors and ownership guards were reused; only the backend selector's
  existing test list was expanded.
- **infra:** no phase03 source changes. Prior campaign privacy/deployment/Entra
  changes remain intact; no Bicep compiler or production deployment is claimed.
- **docs:** current MCP reference, clients, integration and Studio guidance;
  this exact completion record. No compatibility alias/catalog was retained.

Exact-content comparison against phase02 records: **26/27 binding/source hashes
unchanged**; the only changed entry is `routes/agentDiscovery.test.ts`, newly
extended and rerun here. Unchanged discovery SQL/service/DTO and genuine
revocation/reset/automatic-admission proofs may be reused at their stated
scope, not represented as a new 794-test or capacity rerun.

## Source identities

Binding README SHA256:
`e09a877b4a7a7ec13278c2eae52a8443f70f37b1f0428d4db4439a3ba0c4f519`.
Assigned prompt SHA256:
`cc2e58e545f06fbc21d6c4c4335e03f0f6f9d3685636b61d4b7273934472cb36`.

The complete **62-file** final source/manifest identity inventory is
`artifacts/test-scratch/phase03-source-sha256.json`, SHA256
`f883b2fc0abe312e503cbddb00ba5ca0f39b94a907e056c173c8758162484e78`.
All entries were rechecked after verification. Selected current implementation
identities:

```text
mcp/src/agent_control_mcp/api.py               6d8942aadf7c8deea00853bf10d2ff90a4f83ce4208f5a7086abd83fab90a514
mcp/src/agent_control_mcp/discovery_models.py  7235253edacfd7a7125eae3d61da7b3850f66f98357492850c952c23aff72ec1
mcp/src/agent_control_mcp/domains.py           61378d2c234771de0cf929e138094ec3f1b46e7257a0421860213cb9690bfe47
mcp/src/agent_control_mcp/instructions.py      77f8bbff9f040c8aece26f7caf0884d2dbb8a3ee44341d34fd854665d54f7060
mcp/src/agent_control_mcp/projection.py        e92483f8c07b79dd41fe0ac7558c44872fa02c11261158cce1a8678557579909
mcp/src/agent_control_mcp/service.py           097f89737b31c9426d661386875767ebefa12ce228e58bc45078176c0eb02c47
mcp/src/agent_control_mcp/tools.py             a7660c11ddef3610df4014618800ce6f1484f7bf3b2a246c32115e9db6bcc134
mcp/tests/sql_journey.py                      dc54e06f4468c5a1ee0a7969853dc3dece5b4a44192dfa2612abe44b7e768208
mcp/tests/test_audience_projection.py         2d2a81ab2775b387d3f4b28149e93478a935f8c04ffa6c4c81679c042e2d81d9
mcp/tests/fixtures/access_profiles.json       f3a3902c98b1f42b14947707a3f052f6246ccbaba2ce71343d30f038b24de54a
backend/src/routes/mcpSettings.ts             7add7b07d636b28a72c5d9e515023006b3d00c4427949f1a34a3eb771757140a
backend/src/services/mcpSettings.ts           2398ceef696ab9e1fa54165129ec7131531d2fd0103a0332eb5100c712ee285c
backend/src/types/mcpSettings.ts              a384e89b957b42d7cb9dd51acea273b11fda846ef5ad67da3882db5d96f9b688
backend/src/routes/agentDiscovery.test.ts     7ab1284fa3a88c95ee5bfc81607d7bdf2bfa64bbe1bc1bc1510961f45fe84d54
backend/src/routes/auditOriginHttpTestSupport.ts fb26fee4fed105e3ffa01458c48156aa22fd6afe3afa803c214ca85cdffebcf8
backend/src/routes/sharedAgentControls.test.ts 3a7f129ed374c5d65a19e24a2d0682cfdb614bbe6c88623cceaa60ab94d3c8a7
frontend/src/components/McpSettings.tsx       42089ff97a63ff294fec7652c5d44fadc76c2fbcd8a12ed07abb33ba0ef9549e
frontend/browser/mcpSettings.spec.ts          9d2f200cd9d9f1ae09545996293a3c5c0ff869f22490ef0d2835a96604fe7478
```

## Residuals, containment and exact continuation

| Status/scope | Containment and numeric signal | Owner and fix-forward trigger |
| --- | --- | --- |
| **Unavailable:** separate production-image cold/restart/rotation/drain container selector | **0 runtime journeys executed**. Existing Linux PowerShell helper cannot launch the host macOS `mcp/.venv/bin/python`; the guarded selector exits before synthetic key generation. Host pwsh/dotnet's earlier exit137 was not blindly retried. Native OAuth/storage tests, actual SQL SDK clients and real browser-to-Python settings pass, but do not replace this missing selector. | Phase04/local fixture owner: rerun existing `mcp-container` when a working approved native PowerShell/Python execution path is available; any nonzero exit or failed restart/rotation/drain case requires bounded repair. No runtime gate. |
| **Failed, inherited:** full-scale discovery capacity | Actual 100k people/200k catalog/1m edges accepted; four first SQL shapes each hit existing **15s /57014**. **0 samples; p95 unknown**, not passed. No huge rerun, new store/index or runner here. Existing bounded errors remain explicit. | Existing query owner/phase04: any **57014**, or per-shape **p95 >2s over >=50 samples**, triggers focused query repair and measurement. Do not restrict unaffected sign-in/catalog flows with an approval switch. |
| **Failed, independently pre-existing:** Office restore and generation source ceiling | Phase02 receipts remain **535/536** discovery and **316/317** recovery, with the separately proven Office restore and line339 source-ceiling failures. Their tests/owners were not weakened or modified. | Existing Office history and generation-capacity/schema owners: a restore losing retained observations or source metadata exceeding the intended **100,000 rows** triggers repair through the existing owners. |
| **Pending:** production identity, source coverage, published Studio and coordinated deployment | **0 live deployment/reset/Entra/Studio observations** here. Synthetic provider refusals and local consent flows are not real permissions or published per-user evidence. Power Platform delegated coverage and genuine report availability remain provider/data limitations, not invented authorization. | Phase04 resolves exact existing seha host/context/project/origins/services/volumes/images first; deploys API/frontend/MCP together, performs the one authorized guarded agentcontrol reset, then genuine individual sign-in/rebuild/employee/staff/Studio checks. Deploy hardening before widening assignment-required admission; preserve registrations, assignments, consent, callbacks, settings, secrets, keys and OAuth volumes. |

Unavailable-container evidence:
`artifacts/large-tenant-data-platform/d98747c4337c4cd4bd88f899bbc384b1/mcp-result.json`
and `artifacts/test-scratch/phase03-mcp-container.log`. The original receipt
reports `cleaned:false`; it was not rewritten. Independent exact-label checks
found **0 containers/networks/volumes** and the owned state directory absent.

Final exact-label checks also found **0 containers/networks/volumes** for all
five phase03 SQL/browser projects. Only completed phase03-specific isolated test
state and the worker's scratch helper Dockerfile were removed; evidence and
cached approved helpers/baselines remain. No production resource was cleaned.

The parent may advance to phase04 using this one current implementation and
the truthful residuals above. Target resolution and missing real provider/client
availability are exact continuation work, not new human acceptance or application
feature-enable prerequisites.

## Phase 04 owning-contract follow-up

The current full Python aggregate passes **1,051 tests, 21 skipped**; the
skipped Azure-storage cases require the guarded emulator and are not cloud
proof. Two stale contract tests were corrected to expect the API-owned privacy
environment and the canonical **113-operation** catalog, including the eight
discovery operations. Production policy/catalog behavior was not weakened.

The combined Node 24.20.0 aggregate exposed two real uncaught
`Readable.toWeb` cancellation errors on rejected metadata bodies. The private
native transport now consumes the incoming message's bounded async iterator
directly through the existing reader contract. Cancellation still destroys the
incoming stream; byte/UTF-8/deadline/binding/privacy checks are unchanged.
All **71** metadata service/route/native cases pass on both Node 24.22.2 and
the exact failing Node 24.20.0 image. Current
`backend/src/services/mcpSettings.ts` SHA-256:
`28bebf7673d827159d29ddb100ecdde266e93af5d1464ea917781bf1798afb6a`.

The existing container runner now uses its own immutable built Python for
fixture key generation/rotation, not the macOS host venv. Exact Docker Desktop
`/host_mnt/Users` mapping remains guarded by the matching `/Users` path,
`desktop-linux`, exact local Unix socket and absent Docker overrides.
Failed ownership cleanup now retains state/credentials if containers remain.
The real final container run `6762457dc2804d5592db016f0ec3ea5f` passed
**235 packaged tests**, all eleven recorded OAuth/SDK journey modes, graceful
drain, independent API/web availability and protected-secret/state denials.
Its exact disposable resources were cleaned. Lifecycle unit assertions:
**238 passed**. Current `scripts/local-mcp-fixture.ps1` SHA-256:
`422c53d6ca967dae156eb6859210f90ead019545b0536fe7003e2f3eaae02c19`.

The existing 162-case SQL/SDK proof is selectively reused, not called a new
whole-suite pass: 58/62 phase 03 recorded files remain byte-identical; two
changes only extend aggregate selection/tests, the fixture change has the new
container proof above, and metadata transport has the focused repair proof and
phase 04 browser coverage. Discovery SQL/service emission remains identical.
Native request-scoped projection, actor/subject authority and tool serializers
are unchanged. See [phase 04](04-verify-deploy-and-observe.md) for final browser,
candidate, target and unresolved real-client/production evidence.
