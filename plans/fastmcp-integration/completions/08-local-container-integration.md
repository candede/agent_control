# Phase 08 — Local container and lifecycle integration

## Phase Result

**Complete for the authorized local, disposable, synthetic-validation scope.**
Position **5 of 9** in the stable manifest. Assigned execution:
**GPT-6.1 Sol (`gpt-6.1-sol`), `reasoning_effort: xhigh`**. No nested agents.

Application boundary:
`/Users/candede/repos/agent365/agent_control`, including backend, frontend, MCP
and local tooling. HEAD remains
`d3a82a8d7673cb55300b6ab30fc3848d40554015`. Prior uncommitted 05–07 changes and
records were preserved. The parent-owned `IMPLEMENTATION_CAMPAIGN.md` was read,
not modified. Validation occurred 2026-10-16 UTC / 2026-10-17 local time.

Required inputs were read: repository `AGENTS.md`, plan README/08/04C,
the implement-folder design/execution contract and step-worker reference,
campaign and 05/06/07 records, operations validation, existing large-tenant
runner, Compose, local deployment/runtime and directly implicated MCP contracts.
This implements 08, not 09–12. There is no Always-Deploy contract and no new
runtime acceptance, qualification, canary or enable gate. Authorized live
04C/12 convergence remains pending, not a condition for ordinary configured tools.

No production/settings/containers/volumes, `seha`, `.local/seha`, `seha_data`,
real `.env`/secrets, live Entra/provider/customer resources, registrations,
grants, ingress, tunnels, paid models or remote build services were used.
No commit, push or branch operation occurred.

## Follow-up — guided MCP setup and checked-in settings example

The user requested API-style guided setup instead of manually preparing MCP
keys. This source follow-up supersedes the manual-first-setup instructions in
the original phase record below; its container measurements and frozen artifacts
remain historical evidence, not newly rebuilt artifacts.

- Added explicit `-ConfigureMcp` to the existing `start`/`edit-config` owner.
  Normal unconfigured API startup remains prompt-free for MCP and provisions no
  MCP service. A combined genuine first run completes API setup, then MCP setup;
  an MCP-only edit does not ask for the API credential again.
- The operator chooses an existing API tenant, supplies the separate MCP Entra
  registration/credential and exact resource/callbacks, and selects a distinct
  loopback port. The owner prints the Entra callback and scope prerequisites;
  it creates no registration, consent or ingress.
- Generate independent 32-byte cryptographic signing/encryption keys only at
  explicit first setup. Keep protected existing keys on edits, rotation and
  retries; missing/corrupt keys, retained receipts or an existing OAuth volume
  prohibit generation. A missing confidential credential can be supplied using
  hidden input without replacing the keys. API credentials are not reused.
- Persist keys through the existing atomic protected writer before publishing
  the API integration binding and metadata. Compute integration metadata and
  change flags after setup; preserve other tenants and reject another existing
  integration. First API trust changes retain normal drain/session invalidation.
  MCP-only callback/credential edits do not drain the API during configuration.
- Added [six-field local sample](../../../mcp/examples/local-settings.example.json).
  Explicit metadata import can prompt for the credential and generate first
  keys; protected-file imports remain available without interactive prompts.
  Pinned deployment cannot silently change MCP credentials/configuration.
- Local and Azure metadata now accept an explicitly allowlisted canonical `/`
  callback, matching the existing Python runtime. Hosts, ports and paths remain
  exact; no wildcard, nonloopback HTTP or authentication exception was added.
- API/frontend/domain/schema and Python production authentication are unchanged.
  Client examples and native-client limitations are recorded in phase09 and the
  [current guide](../../../docs/mcp-clients.md).

Follow-up verification (overlapping scopes, not additive):

| Command / scope | Result |
| --- | --- |
| `pwsh -NoProfile -File scripts/local-mcp.tests.ps1` | **143 assertions**, synthetic protected filesystem and mocked Docker; includes three real CLI rejection cases before project access |
| `pwsh -NoProfile -File scripts/local-deployment.tests.ps1` | **1,376 assertions** |
| `pwsh -NoProfile -File scripts/local-runtime.tests.ps1` | **352 assertions** |
| `pwsh -NoProfile -File scripts/azure-deployment.tests.ps1` | **307 mocked assertions**, no Azure actions |
| From `mcp`: `.venv/bin/python -m pytest tests/test_config_storage.py tests/test_oauth.py tests/test_client_examples.py tests/test_onboarding.py` | **107 passed**, including real SDK synthetic OAuth flows for exact loopback/root callbacks and arbitrary downstream registration labels |
| Ruff check / format for the three changed Python test files | Passed |
| `git diff --check`; scoped new-file whitespace check | Passed |

Tests cover combined first onboarding, existing multi-tenant setup, exact
binding persistence, API/MCP port collision avoidance, hidden independent
credentials, generated file modes, unchanged-key/inode preservation, rotation,
credential recovery, missing/corrupt keys, retained receipts/orphan volume,
metadata-only and protected-file imports, normal configured/unconfigured start,
and unsupported/pinned CLI setup rejection. No real Entra/vendor login or
deployment occurred. The tagged API secret was not read.

## Implemented and design decisions

- Added `mcp/Dockerfile`: Python 3.14.6 slim pinned by digest, uv 0.12.17,
  frozen approved lock, separate minimal production/test/synthetic-fixture
  stages, non-root users and no secret or test-auth material in production.
  Runtime contains only installed package/dependencies, not uv or the checkout.
- Added optional `compose.mcp.yaml`, absent from default projects. It fixes the
  API origin at `http://app:3001`, requires a separate exact HTTPS public resource,
  binds only `127.0.0.1:<MCP port>:8000`, mounts only three read-only MCP secret
  files and a dedicated encrypted OAuth volume, and adds no API/web dependency.
- Extended the existing `deploy-local.ps1` / local-deployment/runtime owners,
  not a second deployment framework. `-McpConfig` participates in setup and
  edit-config; ordinary build/start/stop/check and pinned release identities
  understand configured MCP. Omitted configuration provisions nothing; supplied
  null, partial, unknown or invalid configuration fails.
- Exact tenant/MCP/API client binding must match an existing explicitly
  configured API integration and `AgentControl.Access`. No implicit tenant,
  arbitrary API origin, wildcard callback, forwarding trust or authentication
  exception was introduced. Existing Host/Origin/CSRF checks remain active.
- Added bounded local readiness and safe shutdown. Health performs an encrypted
  write/read/delete without provider work; authenticated tool calls are tested
  separately. Uvicorn disables proxy/access logging, bounds concurrency/backlog,
  and permits 65-second drain around the existing 60-second invocation deadline;
  Compose allows 75 seconds.
- Extended immutable MCP image, HMAC key/configuration and resumable
  `mcp-operation.json` / `mcp-deployment.json` receipts. Atomic independent key
  replacement recreates only MCP, even when image bytes do not change.
  Failure does not stop the API or authorize SQL reset. Ordinary retry recovers
  an interrupted MCP start without an additional enable action.
- Protected OAuth persistence is a dedicated labeled
  `<project>_mcp-oauth` named volume with `nocopy`, not PostgreSQL or a second
  tenant registry. `mcp-storage.json` binds its name/driver/creation identity;
  missing/replaced recorded state fails closed. No API/provider credentials are
  persisted by this integration.
- A network-free, secret-free, bounded one-shot initializer has only
  CHOWN/FOWNER and handles an **empty root-owned** volume. It refuses nonempty
  root-owned, foreign-owned or incorrectly protected existing state. The actual
  service remains non-root/capability-free and retains strict `os.getuid()`,
  regular-file, 0700-directory and 0600-file enforcement.

**Falsified initial hypothesis:** a protected bind directory appeared sufficient
on cold start. Docker Desktop changed its reported root UID to 0 after container
recreation while protected children remained UID 501. Real restart evidence is
retained under `artifacts/large-tenant-data-platform/bd239ec386314b64868740ab024d146d`.
The bind persistence path was removed, not retained as a fallback. The dedicated
named volume plus empty-volume-only initializer was the smallest working repair;
no ownership/security check was weakened.

Docker Desktop also sometimes reports an exact host secret bind as
`/host_mnt/Users/...`. The common existing owner now recognizes only that exact
expected path spelling under a verified local Desktop socket, without
environment-overridden/remote targets. Other paths still fail. Existing
release, MCP and disposable-resource mount consumers use the same check.

No Redis, SQL OAuth store, scheduler, provider writer, duplicate operation map,
automatic replay, migration, old-schema fallback or reset-on-failure was added.

## Changed roots and unchanged impacts

- **MCP:** image, entrypoint bounds, health/empty-volume initializer, package and
  real-container contracts/journeys. Test-only Entra/API transports stay in the
  fixture image; no runtime fixture-auth mode was added.
- **Local tooling:** optional setup/configuration, safe source snapshots,
  builds, starts/stops/checks, artifact/volume identities, retries and exact
  ownership cleanup. Existing fixture owners were extended.
- **Root Dockerfile:** three directly implicated workspace dependency-directory/
  copy lines preserve nested backend/frontend `node_modules` in the reusable
  operator. A real disposable frontend build exposed missing React declarations
  without these copies.
- **Backend tooling only:** replaced a nonexistent frontend test selector
  `BulkJobItems.test.tsx` with the existing `PowerPlatformSourceJob.test.tsx`.
  The actual SQL aggregate exposed this stale qualification selector.
- **Backend/frontend runtime, schemas, canonical API policies and provider
  writers:** unchanged. MCP remains a protocol adapter; the API owns roles,
  credential authority, jobs, receipts, writes and reconciliation. Existing
  current-schema installation/reset/backup semantics remain authoritative.
- **Documentation:** setup and operations describe configuration, exact resource/
  callback/redirect/proxy contracts, independent rotations, protected state/key
  backup, explicitly authorized restore/rebinding, diagnostics and targeted
  retirement. Public ingress is a separate authorized operation.

## Verification

Use `/Users/candede/.dotnet/tools/pwsh -NoProfile -File` for the PowerShell files
below. Full command logs and frozen source identities are retained in ignored
`artifacts/phase08-*` and the exact fixture directories listed below.

| Command / scope | Actual result |
| --- | --- |
| `scripts/local-deployment.tests.ps1` | 1,375 mocked assertions passed |
| `scripts/local-runtime.tests.ps1` | 315 mocked assertions passed |
| `scripts/local-mcp.tests.ps1` | 67 mocked assertions passed |
| `scripts/fresh-installation.tests.ps1` | 112 mocked assertions passed |
| `cd mcp && .venv/bin/pytest --basetemp=../.local/phase08-python-final` | 514 cases passed in 201.02s |
| Subsequent image/test-only changes: `pytest tests/test_container_contract.py --basetemp=../.local/phase08-container-contract` | 13 focused cases passed |
| `.venv/bin/ruff check src tests`; `.venv/bin/mypy src` | Passed; 19 source files checked |
| `UV_PYTHON_DOWNLOADS=never uv lock --check --offline` | 82-package frozen lock passed |
| `scripts/large-tenant-tests.ps1 -Suite mcp-container` | Actual locked non-root offline image: 104 cases passed in 56.00s; full container lifecycle below passed |
| `scripts/large-tenant-tests.ps1 -Suite deployment-current -BaselineImage ac-mcp-fixture-7293d218d6464e4fb0bb6246-operator:local -BaselineImageId sha256:7754cb2c54e9a430110bcc9bf6ef79735dc70dd01c641a180e90ca07b5f8bdc6` | 388 cases / 14 backend suites passed; backend typecheck passed |
| Same baseline arguments, `-Suite fresh-installation-current` | Actual empty installation, current restart, backups, explicit owned-fixture reset, incompatible refusal and exact cleanup passed |
| `npm run test --workspace frontend -- src/api/client.test.ts src/capabilityState.test.ts src/jobStatus.test.ts src/components/jobPresentation.test.ts src/components/PowerPlatformSourceJob.test.tsx` | 548 cases / 5 suites passed |
| `npm run typecheck --workspace frontend`; `npm run check:unused` | Passed |
| Editor diagnostics for affected runtime/package/Compose files; `git diff --check` | No errors |

The PowerShell aggregate is **1,869 mocked assertions**, not deployment proof.
The Python aggregate predates the final test-image-only work-mount/document-copy
adjustments; the final 13 focused package/image cases and actual 104-case image
run verify those adjustments. No package dependency/lock change was required.
All installs/build subprocesses use only the approved npm and Python feeds.

### Real local Docker proof

Exact authorized boundary: context `desktop-linux`, endpoint
`unix:///Users/candede/.docker/run/docker.sock`, engine **29.8.2**.
Host tools include Python **3.14.6**, uv **0.12.17**, Node **24.18.1** and the
existing PowerShell executable above; FastMCP **4.1.0**, MCP SDK **2.3.0**,
httpx2 **2.13.1**, cryptography **48.0.1**.

Final MCP evidence:
`artifacts/large-tenant-data-platform/5a4950f2d80a44e1bc702110ac230828`.

- Exact project `ac-mcp-fixture-305f93cfdf2e43d0883bac5d`; loopback port **57441**;
  network `<project>_default`, internal-only; state volume `<project>_mcp-oauth`.
  Actual runtime ownership **501:20**, never root; direct image default
  **10001:10001**.
- Exact production runtime image:
  `sha256:4ef78b6ffee6656510063268023106500b937626bbb6c50e26fff7e5a7f9958c`.
  Exact synthetic/test image:
  `sha256:cab511a4e1198f23158bca35e7e775435a262eb4cc92b2b5013b2adf6f5a53d3`.
  Both source-bound to frozen manifest
  `44c2e087e206d37b21b1772b9707e99ffbcf057621cc6b313af2fc27e114f8cd`
  (`mcp-source.json`).
- Synthetic tenant `11111111-1111-1111-1111-111111111111`, API client
  `22222222-2222-2222-2222-222222222222`, MCP client
  `33333333-3333-3333-3333-333333333333`;
  resource `https://mcp.example.test/mcp`,
  callback `https://mcp.example.test/auth/callback`,
  client redirect `https://client.example.test/callback`.
  Real HTTP remapping preserves public identity without creating ingress.
- Unmodified production-image cold readiness and protected non-root storage
  passed before switching only the MCP test image to synthetic upstreams.
- Ten actual HTTP OAuth journeys passed: cold start; MCP restart; encryption
  ring rotation; independent confidential credential rotation; synthetic API
  process restart; revoke; revocation after MCP restart; reconnect; old-token
  denial after independent signing rotation; reconnect.
  Authenticated SDK initialize/catalog/canonical tool calls see **124 tools**.
  Missing/bad credentials, wrong Host and wrong Origin are denied.
- A separately exact-owned client completed an authenticated in-flight delayed
  typed tool call while MCP received SIGTERM. Client journey **3.550087s**;
  measured container shutdown **3.072518s**, exit 0, no OOM.
- Actual insecure signing-file mode and insecure existing volume mode were
  specifically refused. Expected error text is checked; unrelated failures are
  rethrown. Protected atomic replacement/restoration then passed production
  preflight again. No catch-to-success or silent security repair was introduced.
- Synthetic API/web HTTP still worked with MCP stopped. Separately, the real
  Node API/compiled frontend disposable installation worked with MCP absent,
  without provisioning MCP state.

**Measured, not inferred capacity:** the sampled final MCP cgroup recorded
**164,761,600 bytes (157.13 MiB) memory peak**, memory ceiling **536,870,912**,
CPU ceiling `50000 100000`; actual Docker PID ceiling **128**.
Its encrypted state contained **27 files / 26,200 bytes**. Useful ordinary
fixture journeys took approximately **0.52–0.66 seconds**.
Configured limits remain 0.5 CPU / 512 MiB / 128 PIDs, 32 HTTP connections,
backlog 64, two 5 MiB logs, and existing 4096-file / 64 MiB / 24-hour state bounds.
This is a small synthetic journey, **not** throughput, tenant-size, production
load or live-provider capacity qualification.

### SQL, actual API/web and restart authority

SQL aggregate evidence:
`artifacts/large-tenant-data-platform/506cd978e07e48c38a3962041c6f8ee4`.
It runs canonical schema, backup/reset/session, MCP auth/read/control contracts
against isolated PostgreSQL as appropriate. API auth/provider/worker boundaries
remain synthetic where those tests mock them. In particular, canonical HTTP
tests cover lost request-local authority, exact same-principal Admin resume
scope, real worker launch and pausing if authority expires during a saved-job
await. Neither a saved job nor MCP OAuth state supplies provider credentials.
The separate container API restart journey is synthetic, not a claim of live
Entra authentication against a restarted production API.

Actual fresh API/web evidence:
`artifacts/large-tenant-data-platform/d817919cbd6b4408b201e70370d291bf`,
project `ac-ltdp-install-4dd997464050`, unpublished synthetic origin port **57093**.
It installed **104 current tables** with fingerprint
`7478af323658535b8a2c134f9c3a6d2b0c2471444acbc6301ab900ebc764b008`.
Actual readiness/auth-status were 200 and unauthenticated agents were 401.
Incompatible marker injection was refused without drain, implicit reset or
receipt replacement; original marker and the exact app container were retained.
Backups/restarts and the existing explicitly authorized disposable reset flow
passed. First provider sync was **not run**.

Exact fresh images, subsequently removed:
`sha256:47fa1c5e82fb6f3fd34233e8fded46465bdd323aaf87c1f0373410d359891bff`
(app) and
`sha256:3b4b41011b88ea1b2acd5b7031781e3cb17617dbb6a4094a3980ebfa3bb71632`
(operator).

## Failed attempts, repairs and cleanup

Failures were repaired and relevant checks rerun, not hidden:

1. The supplied installed operator
   `agent-control-scale-5096-operator:local`,
   `sha256:78f3cb9fa91e7a64960699899d8fe2eb56bdd77c8ee56490f1f5255855b3c235`,
   had different dependency manifests; the existing runner correctly refused
   reuse. Missing current Knip tooling also confirmed it was not the correct
   reusable dependency environment. That original image remains unchanged.
2. Built a uniquely labeled current operator
   `ac-mcp-fixture-7293d218d6464e4fb0bb6246-operator:local`,
   `sha256:7754cb2c54e9a430110bcc9bf6ef79735dc70dd01c641a180e90ca07b5f8bdc6`.
   The real frontend build exposed omitted nested workspace dependencies;
   the root Dockerfile copies were repaired. SQL's stale selector was repaired
   after its first 387/388 result; the rerun passed all 388.
3. Replaced bind-backed OAuth persistence after the actual UID regression.
   Exact Docker Desktop mount spelling and atomic secret replacement were
   subsequently verified without relaxing ownership/mode enforcement.
4. A failed fresh attempt exposed a retained-container source-identity cleanup
   case after a refused candidate. The guard now accepts only the exact
   previously verified retained container/image/config-file/source identity.
   Its regression passed and guarded cleanup was recovered for
   `ac-ltdp-install-d34ee4bd766c`; recovery evidence is retained under
   `e58b9c22c12542c6b6d3fda5c0793479`.
5. Actual read-only image tests exposed pytest capture's need for the protected
   work mount and the canonical document contract's missing test-image input.
   Set `TMPDIR=/work` for tests and copied only the required operation document
   into the test stage. The final image passed all 104, without skipping tests.

Final verification `artifacts/phase08-final-fixture-cleanup.json` independently
confirms all **nine** exact MCP fixture identities have zero containers, volumes,
networks or image tags and their synthetic state is removed. Historical failed
receipts retain their original outcome/early cleanup flag; the final absence
audit and explicit recovery receipts distinguish repaired cleanup from test
failure. Final MCP result itself is `passed`, `cleaned:true`, zero failures.

Fresh fixture `cleanup.json` records exact app/PostgreSQL/network/volume/image/
state removal. The failed retained fixture was also cleaned using the existing
guarded helper, never by weakening guards or issuing broad removal.
`artifacts/phase08-owned-image-cleanup.json` records removal of the exact current
baseline, two own derived SQL operator tags and early standalone MCP tag.
Owned test scratch and frozen failed-fixture snapshots were removed.
Diagnostics are retained, not credentials. No prune, global kill, unrelated
image removal or production resource operation was used.

## Reproducible identities and handoff

`artifacts/phase08-final-source-hashes.json` contains full current SHA-256 values
for required repository inputs and changed packaging/runtime/source artifacts.
Selected identities:

| Artifact | SHA-256 |
| --- | --- |
| Phase 08 plan | `fd470e5a9936e433d04e04ab3782c24b01438300d55dec78f6cf7913c9c07364` |
| Plan README | `40fdb91510ba7d8a8c0c844bf3bf0405f87384aaf214c829cb0ccfee8561ad71` |
| `compose.mcp.yaml` | `7b7e8c99cecfebaf4ff13dad12e556e60a13aa5de67982cbb5207bbce47b5d12` |
| `mcp/Dockerfile` | `ae2ccacf01a2e8f5393c44f04525f26355db8e92c4ab0c6f364b6f1651fcc829` |
| `mcp/uv.lock` | `ade31dbba896add3e8239694565477b6716b4a1d86da0e35f324e59a84b24864` |
| `scripts/local-mcp.ps1` | `755621ae103a0f376bef1b8bce929e8fdd5fc095b49f6a93f7aceb7c23bcf850` |
| `scripts/local-mcp-fixture.ps1` | `9dfa156be7f05e2831e1d45c97e87dd0a263ef2f134d1b6c0b1cb284fb70eb1e` |
| `docs/deployment-setup.md` | `70a7235fd63a343438c25625ba6fbe724b5fe38b621601c65ae241f77f6d81f9` |
| `docs/operations.md` | `299161171cfd5a4d8018c5dfd0d531190c197e1417866e1f34b5f7afac870655` |

Python base:
`python:3.14.6-slim-bookworm@sha256:4c92ffcde4dd6f1ff72a24518f49fd4990b27134987dfa31a733badde66df9f8`.
Approved feeds remain
`https://packagefeedproxy.microsoft.io/npm/` and
`https://packagefeedproxy.microsoft.io/pypi/simple`, with no public/extra fallback.

09 consumes the ordinary configured endpoint and 124-tool catalog; 10 consumes
the pinned image, exact identity/proxy contract and protected persistent storage.
11 can reuse the extended existing fixtures for aggregate qualification; it
must build/source-verify an appropriate current reusable operator rather than
force the mismatched supplied baseline through its guard. Removed fixture image
tags were intentionally not left as a deployment artifact.

External client onboarding, actual authorized public HTTPS/proxy/registrations,
live same-account/provider journeys, production capacity, actual production
04C/12 release/convergence and any customer mutation still require the parent's
remaining phases and explicit authority. Health and synthetic journeys do not
assert those outcomes. They are not new application runtime gates.
