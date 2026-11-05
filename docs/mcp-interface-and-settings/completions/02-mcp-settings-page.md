# Phase 02 — MCP settings page

## Phase result and authority

**complete_with_risk**: implementation and isolated producer → API → browser
journeys are complete. Literal macOS PowerShell entry-point execution remains
unverified because the host runtime exits 137 before executing scripts. The
actual Docker/Python/Node workloads passed separately; this is not a claim that
the PowerShell Docker runners passed.

Parent-assigned worker: `gpt-6.1-sol`, `xhigh`; no nested agents. Campaign state
and phase acceptance remain parent-owned. Phase 03 still owns normal deployment
of exact `seha` and at least ten minutes of observation. No production deployment,
Azure action, tunnel change, grant, reset, production key rotation, commit, push,
branch or rollback was performed here. No runtime approval or manual-sync gate
was added.

## Implemented contracts

- `GET /internal/mcp-metadata` authenticates only the independent
  `X-Agent-Control-Mcp-Metadata-Token`. Missing/wrong credentials return 401;
  unusable metadata configuration returns explicit 503. It cannot confer MCP,
  user-token or API business authority.
- Initialization information/instructions and complete tool definitions come
  from the same registered FastMCP instance and final SDK serialization, including
  complete local schemas, discriminators and annotations. There is no second
  runtime catalog.
- Readiness observation does not call the ordinary storage probe, read OAuth
  transactions/credentials, write probes or start provider work. Existing ordinary
  readiness/storage fencing remains authoritative.
- Local startup automatically creates one independent cryptographically random
  32-byte `secrets/mcp-metadata`, reuses valid owned 0600 material, and never
  replaces invalid/link/unreadable existing input. Scoped warnings and omission
  of the optional additive Compose overlay prevent broken mandatory mounts.
  API/MCP share only this new read-only credential; existing credentials/state
  remain owned by their original flows.
- Azure uses one already-prepared secret, the same version-pinned native Key
  Vault reference on API/MCP, fixed API metadata binding/origin and explicit API
  outbound `/32` ingress alongside existing client CIDRs. API isolation rejects
  access to each of the three OAuth secrets; MCP gains no API/session/database
  authority. Unresolved/invalid optional references do not veto business admission.
- Browser-session-only `GET /api/mcp/settings` uses the existing Viewer hierarchy,
  tenant/application/resource binding, disconnect cancellation and post-await
  authority revalidation. It has a three-second total fetch/body deadline,
  exact 4,194,304-byte streamed limit, fatal UTF-8 decoding, no redirects,
  bounded depth/shape/token validation, duplicate-key/tool rejection and no-store.
- Navigation and the API share the deployment binding decision. Workbench
  metadata remains shallow and bounded at 65,536 bytes; navigation makes no MCP
  request. Optional metadata failure leaves sign-in, saved reads and automatic
  first-run synchronization independent.
- `/mcp-settings` is read-only, tenant-scoped and principal-keyed. It displays
  exact inert instructions/descriptions, searchable names/descriptions/schemas,
  complete expandable schemas, safety hints and filtered/advertised counts.
  Configured intent, validated runtime, storage readiness, observation time,
  public reachability and client verification are distinguished honestly.
  The server callback is separate from the downstream callback allowlist.
  Known local host ports come from deployment evidence, not the container port.
- Loading, retry, unconfigured, unavailable and binding-mismatch states work on
  desktop and 360px mobile. Identity changes/logout abort and discard pending
  responses, including an A → B → A principal cycle. There is no editor, tool
  executor, provider probe, OAuth enrollment or polling loop.

### Deleted/simplified surfaces

- Removed the unrelated historical Node-image lookup from the MCP-only runner
  path and the hard-coded historical browser-image prerequisite. Browser runs
  accept verified `BrowserImage`/`BrowserImageId`, current manifest/engine,
  architecture, Playwright/core and installed browser-revision evidence.
- The affected capacity driver now uses the existing derived public-contract
  test adapter rather than calling a deleted leaf tool. Canonical request/result,
  isolation, burst/backpressure, recovery and drain assertions are preserved.
  No compatibility alias or runtime dispatch change was introduced.
- No schema, table, migration, SQL catalog, duplicate state owner or dependency
  manifest was added. Existing phase 01 changes and deleted aliases were preserved.

## Autonomous decisions

- Reuse final SDK serialization and the existing derived test adapter, not an
  alternate catalog or compatibility dispatcher: same-instance equality and
  unchanged discovery bytes demonstrate the single authority.
- Keep the optional credential mount in one conditional additive overlay.
  Compose cannot safely make a missing mandatory bind optional; actual outage/
  recovery and preserved business journeys justify this small deployment layer.
- Share one bounded runtime/API parser, separate from the existing shallow
  workbench contract. Duplicate-key detection must precede ordinary JSON parsing;
  streaming bounds and post-await authority checks address different boundaries.
- Observe existing readiness without running its mutating probe. The in-memory
  observation flag is not an admission switch or durable schema owner.
- Extend the existing browser fixture with a protected real Python companion,
  rather than intercepting the mandatory settings journey or adding a framework.
  Reuse verified installed browser/dependency images; do not install around
  historical prerequisite assumptions.

## Cross-root impact

| Root | Phase-owned changes and traced consumers |
| --- | --- |
| `mcp` | `config.py`, `service.py`, `storage.py`; metadata/auth/readiness tests and fixture; current capacity caller; test-image documentation/default selectors |
| `backend` | Shared `types/mcpSettings.ts`; fixed-origin service and browser route/tests; API assembly; shared workbench ID/navigation/tenant route/tests/policy; real Python browser fixture and existing fixture image owner |
| `frontend` | `McpSettings` and tests; App/routing/authorization/parser/API client/CSS; settings browser cases; existing quarantine case handles the real optional first-sync dialog using its Continue button |
| `scripts` | Local secret/config/environment/runtime/fixture owners and tests; Azure deployment/isolation/reference/network owners and tests; existing large-tenant runner |
| `infra` | API/MCP templates, bounded per-secret grant module, prepared target example |
| `docs` | MCP reference/integration/client guides, operations and Azure deployment guide; this exact completion |
| Repository root | Root Dockerfile adds the Python-enabled existing browser target; MCP Compose binding and conditional `compose.mcp-metadata.yaml` |

Database/schema implementation owners are unchanged. Disposable SQL tests reused
the existing sealed source-exact schema/clone owner; production data was not used.
The parent owns reconciliation of phase 01's missed capacity-test consumer.

## Factual validation

### Final native/static/offline checks

Commands were run from the repository root unless shown otherwise:

```sh
cd mcp
.venv/bin/python -m pytest --basetemp=../.local/ac-mcp-interface-phase-02/python-required-final-2 --junitxml=../.local/ac-mcp-interface-phase-02/python-required-final-2.xml -o junit_family=legacy tests/test_settings_metadata.py tests/test_config_storage.py tests/test_oauth.py tests/test_tools.py
.venv/bin/python -m ruff check src tests
.venv/bin/python -m mypy
cd ..
npm run test --workspace backend -- src/routes/mcpSettings.test.ts src/services/mcpSettings.test.ts src/routes/workbench.test.ts src/services/workbenchMetadata.test.ts src/routes/policy.test.ts
npm run typecheck --workspace backend
npm run test --workspace frontend -- src/components/McpSettings.test.tsx src/workbenchRouting.test.ts src/authorization.test.ts src/api/client.test.ts src/App.session.test.tsx
npm run typecheck --workspace frontend
npm run lint --workspace frontend
git diff --check
```

Results: **463 Python**, **79 backend**, **702 frontend** cases passed; Ruff,
strict mypy (22 source files), both typechecks, frontend lint and whitespace
validation passed. The Python selection includes **11 metadata cases**.
The existing host venv reports Python 3.14.10; actual MCP images retain pinned
Python 3.14.6. Both use MCP SDK 2.3.0 / FastMCP 4.1.0. No interpreter upgrade
was performed by this worker.

Same-instance, fully paginated real SDK equality measured:

| Evidence | Actual |
| --- | ---: |
| Public tools / unchanged canonical operations | 62 / 124 |
| Complete SDK discovery UTF-8 bytes | 677,526 |
| Protected metadata response UTF-8 bytes | 677,658 |
| Exact instructions words | 462 |
| Upstream byte ceiling | 4,194,304 |

No schema/description/instruction was dropped to fit. Missing/wrong keys,
business/metadata authority separation, optional configuration/readiness failures,
strict local file modes and no OAuth-record reads/writes are covered.
Backend cases cover roles, tenant/binding drift, credentials, actual stream
boundaries, missing/false Content-Length, stalled bodies, cancellation, redirects,
duplicate keys/names, malformed/deep shapes and scope-preserving recovery.

The host `pwsh` and `dotnet` processes were repeatedly killed with exit 137,
including trivial version commands. No cause was established or security setting
changed. These actual offline suites instead ran with no network in the existing
PowerShell 7.6.8/.NET 10.0.13 tooling image, binding only this repository and setting
`HOME`/`TMPDIR` to its owned work path:

```sh
docker run --rm --network none --user "$(id -u):$(id -g)" \
  --mount "type=bind,source=$PWD,target=$PWD" -w "$PWD" \
  -e TMPDIR="$PWD/.local/ac-mcp-interface-phase-02/pwsh-work" \
  -e HOME="$PWD/.local/ac-mcp-interface-phase-02/pwsh-work" \
  -e PATH=/usr/local/bin:/usr/bin --entrypoint pwsh \
  kloudmeta-functions-workspace:pwsh-7.6.8-dotnet-10.0.13 \
  -NoLogo -NoProfile -File ./scripts/local-runtime.tests.ps1
```

The same invocation with `local-mcp.tests.ps1`,
`azure-deployment.unit.tests.ps1` and `azure-deployment.tests.ps1` passed
**389 / 164 / 31 / 306 assertions**, respectively. All Azure control-plane,
compiler and HTTP operations in these suites were fixture-mocked.
Six changed PowerShell deployment/runner owners also parsed without errors.
No live Azure deployment, ARM compilation or Azure network proof is claimed.

### Actual isolated images and commands

Engine: Docker Desktop `desktop-linux`,
`unix:///Users/candede/.docker/run/docker.sock`; no Docker overrides.
Final application/SDK images are Linux/arm64. Inputs were preserved:

| Image | Immutable ID |
| --- | --- |
| Current dependency input | `sha256:7d398a507b26ead060f6fe949abd9b498331f0dae8786e33b42b027d760f9d34` |
| Verified browser input | `sha256:537119809ef81c495519e566018e3c8a078455f6ed3fe0d82a67b0a83c6a1d49` |
| Offline PowerShell tooling | `sha256:b3c8da404434d0f3b02cbb15e68374e2ddee71fa8f84c9d6d19d4e93809ca902` |
| Final MCP SDK/test | `sha256:d3d6062de0f84c5ea770fed1973e2cc1584e4e039f822d8dab4cba29c9dee962` |
| Final MCP synthetic fixture | `sha256:8589ec5136288d0de7e9af9a9e41458b09d8f4a3e781279b151718e5336448a6` |
| Final unmodified production MCP target | `sha256:36956fb57ddfa10c5385269afe283fbf64a93433dcf0ed91131178d603b94e02` |
| Final API/browser/Python fixture | `sha256:e66edfd674ad3ff6c1e1c024f8ae3cf592bf01eeb73ca77a680c09380dde0371` |

Browser input Playwright/test and core are 1.58.2. Installed revisions were
Chromium/headless 1208, Firefox 1509, WebKit 2248 and ffmpeg 1011; actual Chromium
launch and all selected cases succeeded. Current four dependency manifests and
Node engine compatibility were checked. No dependency manifest/package upgrade
was performed; standard image builds used only the configured company feeds.

Exact final builds:

```sh
docker build --provenance=false --target test -f mcp/Dockerfile --label io.agent-control.fixture=ac-mcp-interface-phase-02-final -t ac-mcp-interface-phase-02-sdk-final:local .
docker build --provenance=false --target fixture -f mcp/Dockerfile --label io.agent-control.fixture=ac-mcp-interface-phase-02-final -t ac-mcp-interface-phase-02-fixture-final:local .
docker build --provenance=false --target runtime -f mcp/Dockerfile --label io.agent-control.fixture=ac-mcp-interface-phase-02-final -t ac-mcp-interface-phase-02-runtime-final:local .
docker build --provenance=false --network none --build-arg DEPENDENCY_BASE=agent-control-import-fix-eaf8369f-dependencies:local --build-arg BROWSER_BASE=seha-permission-browser:local --build-arg REUSE_INSTALLED_DEPENDENCIES=1 --build-arg MCP_FIXTURE_BASE=ac-mcp-interface-phase-02-sdk-final:local --label io.agent-control.fixture=ac-mcp-interface-phase-02-final --target mcp-settings-browser-test -t ac-mcp-interface-phase-02-browser-final:local .
```

The final immutable MCP test image's default selectors passed **159 cases**,
running non-root 501:20, network none, read-only root, dropped capabilities,
no-new-privileges, 512 MiB/.5 CPU/128 PIDs and its existing private bounded
`/work` mount. Root Dockerfile's existing build stage also built backend/frontend.

### Real browser → actual API → actual Python producer

Exact owned project:
`agent-control-ltdp-0198cbe05c0a4dd9a4e2e33a806af268`.
Evidence:
`artifacts/large-tenant-data-platform/0198cbe05c0a4dd9a4e2e33a806af268`.
PG ID:
`954ae5a4aa93c8d990f824bdfb8c7d7d6a684e98fdb99599c2af55f5ff6b71ed`;
final browser workload:
`e031361ab2b58b4fb19336295da9793e3f68b62b2ce21158c97fb82100872d63`.

Actual existing workload invocation:

```sh
P=agent-control-ltdp-0198cbe05c0a4dd9a4e2e33a806af268
D="$PWD/artifacts/large-tenant-data-platform/0198cbe05c0a4dd9a4e2e33a806af268"
docker compose --project-directory "$PWD" --env-file "$D/compose.env" \
  -f compose.yaml -f compose.large-tenant-test.yaml -p "$P" --profile test-db \
  run -d --no-deps --name "$P-work" -v "$D:/evidence" --entrypoint node test-db \
  /app/node_modules/tsx/dist/cli.mjs /app/backend/scripts/largeTenantFixture.ts \
  cutover-browser-contract mcpSettings.spec.ts,signIn.spec.ts,permissions.spec.ts
```

PG retained network none, its exact owned disk volume and 1 GiB/.5 CPU.
The workload shared only that PG container's network namespace, 1.5 GiB/1.5 CPU,
and its exact evidence bind. Existing auth, synthetic provider, database,
manifest, image and resource isolation guards remained in place.

**78 selected, 70 passed, 8 existing skips, 0 failures/flaky cases**:

| Spec | Desktop passed/skipped | Mobile passed/skipped |
| --- | ---: | ---: |
| `mcpSettings.spec.ts` | 3 / 0 | 3 / 0 |
| `permissions.spec.ts` | 27 / 4 | 27 / 4 |
| `signIn.spec.ts` | 5 / 0 | 5 / 0 |

The settings catalog case has **no settings interception**. Existing guarded
fixture sign-in reaches the actual session API and protected loopback Python
service with the complete registered 62-tool catalog. It compares all displayed
instruction/description strings exactly, checks a complete schema, callbacks,
actual port, keyboard access, axe, responsive layout, refresh/reload and logout.
Only the separate UI-failure/long-text/late-response case intercepts settings.
No skip was added.

The same owned actual PG fixture also ran:

```sh
docker compose --project-directory "$PWD" --env-file "$D/compose.env" \
  -f compose.yaml -f compose.large-tenant-test.yaml -p "$P" --profile test-db \
  run --rm --no-deps --name "$P-firstsync-final" --entrypoint npm test-db \
  run test --workspace backend -- scripts/fixtureSupport.test.ts \
  scripts/largeTenantFixture.test.ts src/services/automaticRefreshIntegration.test.ts
```

**85 passed**: 56 isolation-owner, 26 fixture/image/schema-owner and 3 real-SQL
automatic-first-sync/recovery cases, with synthetic provider adapters.

### Actual MCP lifecycle, capacity, drain and containment

Owned project `ac-mcp-fixture-44c5659d213d44c09512b5ef`; evidence
`artifacts/large-tenant-data-platform/44c5659d213d44c09512b5ef95839f61`.
Loopback port 59102; exact internal project network and owned
`ac-mcp-fixture-44c5659d213d44c09512b5ef_mcp-oauth` volume.

Compose used root `compose.yaml`, `compose.mcp.yaml`, conditional
`compose.mcp-metadata.yaml`, and the evidence directory's existing
`mcp-fixture.yaml`/`mcp-auth.yaml`, with that directory's `compose.env`.
The auth override is test-only; the unmodified production target was separately
started and queried before/after the synthetic OAuth journeys.

Every existing journey was invoked as:

```sh
P=ac-mcp-fixture-44c5659d213d44c09512b5ef
D="$PWD/artifacts/large-tenant-data-platform/44c5659d213d44c09512b5ef95839f61"
docker run --rm --label "io.agent-control.fixture=$P" --network "${P}_default" \
  --user 501:20 --read-only --cap-drop ALL --security-opt no-new-privileges \
  --memory 512m --cpus 0.5 --pids-limit 128 \
  --mount "type=bind,source=$D,target=/work" --entrypoint python \
  sha256:8589ec5136288d0de7e9af9a9e41458b09d8f4a3e781279b151718e5336448a6 \
  tests/container_journey.py MODE
```

**14 successful driver executions**, including drain: cold; metadata-absent
restart; actual helper-generated metadata recovery restart; capacity; restart;
encryption rotation; confidential-client rotation; API restart; revoke; revoked
after MCP restart; reconnect; revoked after signing rotation; reconnect; drain.
All rotations were isolated synthetic fixture material, never production keys.

- Unmodified production target returned 62 tools, 677,658 metadata bytes and
  storage-ready true; absent/wrong keys returned 401.
- Metadata absent returned explicit 503 while ordinary authenticated MCP/OAuth
  continued. Actual local owner recreated only metadata material; all six
  original synthetic OAuth/session/database credential hashes remained unchanged.
- Exact service UID/GID, read-only secret mounts, writable owned OAuth volume,
  loopback port, internal network, resource limits and image identities were
  checked before journeys. Only the approved Docker Desktop `/host_mnt` mapping
  to the exact expected host source was accepted.
- Capacity: 2 principals, 4 isolated calls; 64-call burst = **4 passed / 60
  backpressured**, 2,572 response bytes in 3.072 seconds; 2 recovery calls passed.
  This is synthetic container load, not provider/production capacity.
- Drain: authenticated in-flight call completed; shutdown **3.171 seconds**
  against the unchanged 75-second bound, container exit 0 and no OOM.
- Synthetic API readiness and web responses remained 200 with MCP stopped.
  World-readable signing material and 0755 OAuth storage were rejected; storage
  was not silently repaired. Restoring protected modes recovered configuration
  and the healthy unmodified production target.
- Measured storage: 57 files / 78,232 bytes; peak memory **166,338,560 bytes**
  against 536,870,912; CPU cgroup `50000 100000`. Protected stored records did
  not contain the tested plaintext upstream refresh/client-secret values.
- Repaired driver content SHA-256:
  `cedf3b72310fca37a8035976bb7658e79dac217862f388586e0d1165f3acfd5d`.

### Practical failures repaired and rerun

- Initial backend role-success fixtures did not await the existing account-session
  activation owner; fixed fixture usage, not authorization policy.
- Initial image software check lacked `mcp-reference.md`; the current test image
  now copies its required documentation and all 159 cases pass.
- The stale capacity leaf call failed before load. Its current discriminator
  request/result adaptation now passes the original isolation/capacity assertions.
- The first full browser run had two quarantine clicks blocked by the real
  first-sync dialog. The test now uses that dialog's actual Continue button;
  both unchanged destructive-flow assertions pass in the final 70-case run.
- Unreadable optional-key testing exposed permissive owner-mode handling on the
  Desktop bind. Metadata-only consumers now require exact 0600; local 164,
  backend 79 and Python 463 cases pass without tightening ordinary OAuth admission.
- Direct denial orchestration initially matched the PowerShell preflight error
  text against the runtime-owned error. Final actual runtime probes assert
  `OAuth storage must be owned and access-restricted.`, retained 0755 on rejection,
  restored 0700 and recovered successfully. No checked-in test was weakened.
- An offline `--network none` build cache variant could not resolve the approved
  feed. Canonical normal builds succeeded; no public fallback was attempted.
- Cleanup guards initially stopped on short-vs-full container IDs, then detected
  the exited Compose one-off. Full-ID inspection and the existing explicit
  one-off removal contract completed cleanup; no guard was relaxed.

## Cleanup and protected continuity

Both owned stacks are gone: **4 final containers, 2 owned volumes, 1 internal
network and all 8 phase-owned image tags** removed. Synthetic RSA/signing/
encryption/connection files, isolated MCP state and nine named Python/PowerShell
scratch directories were removed. Test logs, measurements and nonsecret receipts
remain in the owned evidence paths. No broad prune was used.

Final resource IDs, images, start times and mounts matched the recorded protected
inventory exactly. In particular:

- `seha-postgres-1`:
  `05314812fa9289806d5086fcf94d2ad500fda3021cda3b3581c41abf54cfc813`;
- original running seha app/MCP containers and unrelated
  `workiq-demo-redis-state-1`;
- `seha_data`, `seha_mcp-oauth`, `seha_default`;
- both approved dependency/browser input images.

No production credential contents were read for this receipt; the parent's
independent original-key hash receipt remains authoritative for phase 03.
Cleanup proof: `.local/ac-mcp-interface-phase-02/cleanup-final.json`.
Wire/browser counts and literal host-command outcomes are preserved alongside it.
MCP command/image/journey/drain/containment receipts are in its evidence directory.

## Residuals and binding continuation

### Parent integration review and fix-forward

Parent reviewed the producer, final SDK serialization, optional configuration,
readiness observation, local mount/credential lifecycle, tenant-bound service
and route, navigation, principal-keyed page, parsers and Azure secret/network
contracts. Independent reruns passed **46 backend** route/service tests and
**10 frontend** page tests.

A concrete missing-file gap was found: an explicitly configured nonexistent
metadata credential path raised `FileNotFoundError` from `lstat`, outside the
optional configuration catch. Two new regression cases failed before the fix
(2 failed / 7 passed). The metadata-only boundary now also catches `OSError`;
it reports unavailable metadata while ordinary service readiness and OAuth
admission remain intact. Missing files are neither regenerated by the service
nor treated as business authority. The parent reran the complete phase-02
Python selection on this fix:

```sh
cd mcp
.venv/bin/python -m pytest --basetemp=../.local/mcp-interface-parent-phase-02-final -o addopts='' -q tests/test_settings_metadata.py tests/test_config_storage.py tests/test_oauth.py tests/test_tools.py
.venv/bin/python -m ruff check src tests
.venv/bin/python -m mypy
```

**465 passed, 118.35 seconds**; Ruff and strict mypy passed. Metadata coverage
is now **13 cases**. Phase-03 image builds must include this final parent fix;
phase-02 image identities above remain historical evidence, not final release
identities. `git diff --check` passed. Native PowerShell's executable signature
was verified valid without modifying it; the cause of host exit 137 is still
unknown and no security setting or binary signature was changed.

1. **Literal host PowerShell Docker-runner verification unavailable.** All three
   named local/offline script entry points and both named integration entry
   points were attempted on macOS and exited 137 before script execution.
   Scope: deployment/test-host runtime, not application authorization/runtime.
   Containment: unchanged identity/engine/resource guards, actual isolated
   workload proof, no unsupported Docker-socket/context shim. Signal/threshold:
   any one nonzero entry-point exit remains nonpassing. Owner: campaign parent
   / existing deployment-host owner. Trigger: when a supported native PowerShell
   runtime executes, rerun the exact commands below; a failure is fixed forward
   in its actual owning layer, not hidden or turned into a runtime approval gate.
2. **Azure compile/live network/reference proof not performed.** Scope: a future
   authorized Azure target only; current campaign target is local `seha`.
   Offline 31/306 assertions are not live ARM proof. Threshold: any one compiler
   error, unresolved shared reference, forbidden OAuth grant, or API ingress
   mismatch requires correction of the existing prepared target/template/owner.
   Owner: that future Azure deployment's authorized operator. Trigger: the next
   independently authorized Azure deployment, not a prerequisite for local rollout.
3. **Public tunnel/native-client/provider verification is unproven here.**
   Internal metadata reachability does not certify those journeys; the page says
   Unverified. Owner: parent/phase 03. Threshold: one failed actual client
   initialize/tools-list/OAuth journey must remain an explicit scoped limitation
   with its concrete provider/client cause, while unrelated supported reads and
   automatic synchronization remain usable. Trigger: the authorized phase 03
   normal deployment and available actual client authentication.

Literal integration commands attempted (not passed on this host):

```sh
pwsh -NoLogo -NoProfile -File ./scripts/large-tenant-tests.ps1 -Suite mcp-container
pwsh -NoLogo -NoProfile -File ./scripts/large-tenant-tests.ps1 \
  -Suite cutover-browser-contract \
  -BrowserFiles "mcpSettings.spec.ts,signIn.spec.ts,permissions.spec.ts" \
  -BaselineImage agent-control-import-fix-eaf8369f-dependencies:local \
  -BaselineImageId sha256:7d398a507b26ead060f6fe949abd9b498331f0dae8786e33b42b027d760f9d34 \
  -BrowserImage seha-permission-browser:local \
  -BrowserImageId sha256:537119809ef81c495519e566018e3c8a078455f6ed3fe0d82a67b0a83c6a1d49
```

Phase 03 may rely on complete API/UI/deployment wiring, full SDK-derived
metadata, first-run synchronization preservation and isolated OAuth continuity.
It must normal-deploy exact `seha`, preserve data/original OAuth material, allow
automatic creation of only the new independent metadata credential, and observe
at least ten minutes. Nonpassing proof remains truthful and scoped; it is not
permission for a test-only terminal state or an invented application approval.
