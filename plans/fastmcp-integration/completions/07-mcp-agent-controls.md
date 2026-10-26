# Phase 07 — Thin MCP control and job tools

## Phase Result

**Complete for the authorized local-source/synthetic-validation scope.**
Position **4 of9**, assigned
`/Users/candede/repos/agent365/agent_control/plans/fastmcp-integration/07-mcp-agent-controls.md`.
The parent launched one `general-purpose` worker, agent
`93a645e5-bc71-4107-85c9-7b198a424542`, explicitly as
**GPT-6.1 Sol (`gpt-6.1-sol`), `reasoning_effort: xhigh`**.
No nested agents were launched.

Application/repository:
`/Users/candede/repos/agent365/agent_control`; backend, frontend and MCP are
one application. HEAD remains
`d3a82a8d7673cb55300b6ab30fc3848d40554015`.
Validation occurred2026-10-17 local time. Prior uncommitted05/06 work,
completion evidence and parent-owned `IMPLEMENTATION_CAMPAIGN.md` were preserved.
This implements07 only, not08+. There is no Always-Deploy contract.
04C/12 live outcomes remain pending and are **not runtime gates**.

No dependencies were installed. No `.env`/real secret was read.
No Docker/database provisioning, `seha`/customer/provider write, remote mutation/ingress/grant,
paid/model call, deployment, git commit/push or branch operation occurred.
All provider/Entra/API calls in Python checks used synthetic transports.

## Implemented

- **28 additional concrete tools** in the existing `tools.py` catalog:
  three generic receipt preview/execute/status operations;16 explicit package
  count/preview/block/unblock/access/job/item/cancel/resume/reconcile operations;
  nine explicit Studio status/preview/execute/job/cancel/resume/reconcile/audit
  operations. The two existing exact directory-principal adapters are reused.
- Ordinary configured construction now registers **124 tools**:
  **76 GET,45 POST,1 PATCH,2 DELETE**;37 explicitly provider-working operations.
  No enable flag, optional-canary requirement or MCP-only route/state was added.
- Strict frozen request/response DTOs preserve exact nested receipts, hashes,
  expiry, source/canonical/native/environment identity, names, prestates,
  principal collections, counts, already-state/ineligibility reasons, child
  references, partial/final/verified/readback semantics and attribution.
  Unknown/null evidence is neither inferred nor converted into success.
- All tools use the existing `CanonicalApi.invocation` dispatcher. The
  existing generic dispatcher already supported JSON mutation methods; only
  its one closed catalog's method type and canonical access registration
  needed PATCH support. There is no second dispatcher/control map.
- Canonical access requests are flat, not a nested `accessUpdate` wire wrapper.
  Single access is replace-only PATCH; bulk supports add/replace and
  specific/none with exact typed native directory UUIDs. Untouched scope
  preservation, principal resolution and provider limitations remain API-owned.
- Every execution requires the caller's stable operation key and exact
  current receipt/hash. The key is a header, never part of the API body.
  Generic keys are <=200 printable ASCII characters; package/Studio keys
  retain the canonical1–128 alphanumeric/underscore/hyphen grammar.
  POST/PATCH remain single-attempt even on503, timeout or lost accepted response.
- Existing saved status/items and explicit GET-only provider reconciliation
  are the recovery boundary. Resume forwards exactly `confirmed:true` for
  eligible unsent work. The boolean validator rejects numeric1 as well as
  false/strings; SDK/Pydantic otherwise coerces literal true from1.
  No automatic polling, stateful replay, receipt persistence or new job owner exists.
- Generic Studio block/unblock maps **only through API authority** to
  quarantine/unquarantine. Explicit package operations remain package-only,
  including Studio-linked packages. Python does not join/infer targets,
  project domain outcomes, access provider clients or decide authorization.
- Current SDK request-local origin is automatically forwarded. Returned
  accepted initiator remains unchanged, while cancel/resume/reconcile requests
  carry their own current attribution. API remains sole audit writer.
- Honest catalog annotations mark disruption/provider work and exact-key
  idempotent submissions; an idempotent hint never enables automatic retry.
  Interactive clients must show the exact preview and ask current confirmation.
  Scheduled clients obtain the same current receipt without a human pause.
  No fabricated human-intent proof, scheduler bypass or server approval task.
- Current API/setup/security/root documentation describes124 tools, provider/
  Admin requirements, bounds, source-owned expiry, partial outcomes and recovery.
  The source-only evidence is explicitly separate from live qualification.

## Design, deletions and autonomous decisions

**Hypothesis:** existing canonical control routes and the common invocation
owner suffice for complete thin wrappers; adding a Python control service,
receipt store or execution state would duplicate authority.
The cheapest falsification was a real SDK call matrix using TypeScript-source
DTOs and captured HTTP requests. The first focused matrix passed52 cases.
The final matrix covers all124 registered tools with minimal/optional nested
source evidence, plus independent browser adapter captures and recovery cases.

No backend/frontend runtime, schema, provider writer or supported UX was replaced.
Obsolete “controls not registered”/96-tool current prose and assertions were
revised, and operation-table headers now say MCP tool, not Future tool.
Historic05/06 completion records were intentionally not rewritten.

Necessary complexity is two cohesive typed modules for different canonical
wire contracts, not a generic control framework. Test-only TypeScript contracts
now inspect current control DTOs and inferred existing service/repository
returns in addition to06 read contracts. The compiler fixture omits optional
`never`/`undefined` fields from inferred discriminated return unions instead
of manufacturing invalid `{}` values or weakening Python models.

Shared SDK/source fixtures moved from `test_tools.py` into `conftest.py` to
avoid duplicating authentication/initialization. A test-only Node helper executes
the real browser adapters against the same synthetic responses. It disables
tsx's scratch cache, does not import application configuration/runtime services,
and cannot become a server route map. No dependency or production abstraction
was introduced.

Stable keys are required at the MCP boundary even where the API can generate
one for browser convenience. The client must retain operation identity after
uncertain transport; MCP does not invent a second key/receipt store. Generic
keys reject unsupported Unicode HTTP-header encoding before transport.
Package summaries preserve the API's first20 visible targets plus
`additionalTargetCount`; they are not falsely described as complete enumeration.
No source expiry is synthesized or extended.

## Changed roots and impact checks

**MCP added**

- `mcp/src/agent_control_mcp/control_inputs.py`
- `mcp/src/agent_control_mcp/control_models.py`
- `mcp/tests/test_controls.py`
- `mcp/tests/browser_controls.mjs`

**MCP updated**

- `mcp/src/agent_control_mcp/tools.py`
- `mcp/tests/{conftest.py,test_tools.py,wire_contracts.ts,wire_contracts.mjs}`

**Backend:** `src/routes/actionOrigin.test.ts` adds paired web/MCP/unknown
control audit -> canonical origin CSV projection, preserving event facts,
reported evidence and formula escaping. `src/routes/mcpContractFeasibility.test.ts`
updates coupled current-catalog/non-replay assertions.
`sharedAgentControls`, `inventoryMutations`, `agents`, quarantine routes,
`AgentControls`, mutation stages, package/quarantine jobs, access/prestate DTOs,
directory principal services and origin/audit owners were traced. Their
existing authority/contracts already implement the required effects. No shared
runtime/DTO/schema repair was necessary.

**Frontend unchanged after impact check:** current `api/client.ts` methods,
PackageManagement/BulkActions, AccessAssignmentModal/PrincipalPicker and
CopilotStudioQuarantineControls still call the same canonical methods, bodies,
defaults and effects. Actual adapters execute in the new paired capture test;
the536 existing affected cases pass. Generic controls have no dedicated generic
UI; their canonical shared client request path is tested without inventing one.
No browser confirmation or provider-specific button was reinterpreted.

**Current documentation:** `README.md`, `docs/mcp-integration.md`,
`docs/security-model.md`, `docs/deployment-setup.md`.
`docs/mutation-canaries.md` and data architecture were reviewed and remain
unchanged: optional validation is not ordinary control admission.
This completion file is the only new campaign artifact. Parent state and
previous completions were not edited. Prior `.gitignore`, `.dockerignore`,
Python manifest/lock and other05/06 changes remain intact.

## Validation

Environment: existing macOS Node24.18.1, Python3.14.6 `mcp/.venv`,
FastMCP4.1.0, MCP SDK2.3.0 and HTTPX2 2.13.1.
No install/restore or registry probe occurred. npm commands used
`npm_config_registry=https://packagefeedproxy.microsoft.io/npm/`;
offline uv used only the approved Python proxy. No public/default/extra feed.

| Status | Command / evidence | Actual result |
| --- | --- | --- |
| passed | `cd mcp && .venv/bin/python -m pytest tests/test_tools.py -k 'every_registered and (agent_control or package_control or studio_control or block_package or unblock_package or packages_access or package_access or package_targets or studio_status)' --tb=short` | First narrow52 passed,239 deselected |
| passed | `cd mcp && .venv/bin/python -m pytest tests/test_controls.py --tb=short` | Intermediate101 passed before final revocation/key/output regressions; final aggregate includes106 control cases |
| passed | `cd mcp && .venv/bin/python -m pytest tests/test_controls.py -k 'access_preview or control_inputs or connection_revocation' --tb=short` | Discriminating46 passed,57 deselected before output regressions |
| passed | `cd mcp && .venv/bin/python -m pytest tests/test_controls.py -k malformed_api_boolean --tb=short` | Final3 passed,103 deselected; numeric0/1 cannot impersonate API boolean literals |
| passed | `cd mcp && .venv/bin/ruff check src tests --output-format concise && .venv/bin/ruff format --check src tests && .venv/bin/mypy src` | Clean;23 formatted Python files,17 strict source files |
| passed | `cd mcp && .venv/bin/python -m pytest --tb=short` | **501 passed**, no skips,180.29s; includes real SDK list/call/auth/storage/origin/bounds and all prior05/06 cases |
| passed | `cd mcp && UV_PYTHON_DOWNLOADS=never uv lock --check --offline --index-url https://packagefeedproxy.microsoft.io/pypi/simple` |82 packages checked offline |
| passed | Backend13-suite command below | **697 passed**, no skips,10.13s |
| passed | `npm test --workspace backend -- src/routes/mcpContractFeasibility.test.ts --reporter=dot` | Final current-doc/map recheck20 passed |
| passed | Frontend6-suite command below | **536 passed**, no skips,5.90s |
| passed | `npm run typecheck --workspace backend && npm run typecheck --workspace frontend && npm run check:unused` | Both source roots and Knip clean |
| passed | Editor Problems on new Python/catalog/tests and coupled backend tests | No reported errors |
| passed | Local Markdown links/anchors, explicit new-file whitespace, `git diff --check` |49 targets/anchors across5 current/record files;27 untracked source/test/record files clean |
| unavailable | Initial backend selector also included `src/routes/quarantineJobReads.test.ts` | Guard failure: separately named `agentcontrol_test_*` database required. Overall exit1;13 suites/696 cases passed,4 skipped before the added CSV regression. No provisioning occurred |

Backend command, preceded by the npm registry environment above:

```sh
npm test --workspace backend -- \
  src/services/bulkJobs.unit.test.ts \
  src/services/copilotStudioQuarantineJobs.unit.test.ts \
  src/services/copilotStudioQuarantineControl.test.ts \
  src/routes/copilotStudioQuarantine.unit.test.ts \
  src/services/graphPackageAccessSafety.test.ts \
  src/services/directoryPrincipals.test.ts \
  src/services/packageMutationState.test.ts \
  src/services/packageControlProjection.test.ts \
  src/routes/packageCanaryAuthorization.test.ts \
  src/routes/actionOrigin.test.ts \
  src/services/auditLog.unit.test.ts \
  src/services/csvExport.test.ts \
  src/routes/mcpContractFeasibility.test.ts --reporter=dot
```

Frontend command, using that same registry environment:

```sh
npm test --workspace frontend -- \
  src/api/client.test.ts \
  src/components/BulkActions.test.tsx \
  src/components/PackageManagement.test.tsx \
  src/components/AccessAssignmentModal.test.tsx \
  src/components/PrincipalPicker.test.tsx \
  src/components/CopilotStudioQuarantineControls.test.tsx --reporter=dot
```

### Proof boundaries and failures repaired

The501-case aggregate includes248 minimal/nested-optional real SDK calls
(every124-tool registration) and106 dedicated control cases. The independent
30-operation HTTP matrix includes every added tool plus reused principal
adapters, exact encoded identities, methods/bodies/defaults/header placement,
current browser returns and domain-error parity.

Additional cases cover generic/Studio directions, package block/unblock routes,
availability/installation add/replace/specific/none previews and submissions,
multi-page inventory discovery and revision-bound items, report-only/unknown
identity and unknown inventory/readback dates, receipt expiry/current targets,
concurrent exact keys/current origins, partial/missing/waiting children,
role/principal/restart authorization errors, lost accepted responses,
same-request revocation after await, explicit reconciliation and immutable
returned initiator versus current lifecycle actor. Source/provider worker
fixtures cover the actual prestate/readback/lock/authority semantics.
Paired canonical CSV helpers preserve audit facts and evidence; actual
database-backed audit/CSV route parity remains unavailable, not claimed passed.

Ordinary local errors were repaired: a reserved pytest parameter name, formatting
violations, source-fixture optional-never placeholders and the observed
input/output boolean-literal numeric coercion. Output models reject numeric0/1
rather than coercing accepted/risk/atomicity semantics. Full aggregates passed
after repair. The early
SQL suite guard failure was not weakened or relabeled a pass; supported
database-independent tests were rerun green separately.

Owned `.local/control-wire-fixtures.json` and `.local/mcp-tests` scratch were
removed after verification; other local fixtures/cache/work were preserved.

### Unavailable / not run

- SQL-backed `sharedAgentControls`, `auditOriginHttp`, SQL `auditOrigin`,
  receipt durability/concurrent acceptance and database restart fixtures remain
  unavailable under this worker's no-provisioning boundary. Prior05/06 guard
  evidence is retained; only the quarantine-read guard was newly encountered.
  No SQL passes are invented. Parent11 owns authorized isolated-toolkit
  verification, including actual registered-handler/domain/audit/CSV parity.
- Live consent/native/guest tenant identity, real provider writes/readback,
  external clients/human confirmation, container/volume lifecycle, ingress,
  real restart/deployment and04C/12 live outcomes were not authorized/run.
  Synthetic protocol proof does not qualify those boundaries.
- No known failing owned local implementation check remains. These missing
  external checks do not gate supported tools at runtime.

## Content identities

SHA256 identifies local content, not an accepted/deployed release. Final
identity table follows; original05/06 identities remain in their untouched records.

| Content | SHA256 |
| --- | --- |
| Assigned07 prompt | `9b232673b0aee7ba53ed45208febe2f4a457cde4a8bbbbeb9087d07c5ac8b767` |
| Roadmap README | `40fdb91510ba7d8a8c0c844bf3bf0405f87384aaf214c829cb0ccfee8561ad71` |
| `AGENTS.md` | `eb9bb2400afb49e5500666234b385facde6cdbba874285e0f51d90c5a5d8a81e` |
| `docs/mcp-integration.md` | `ae95f0ff07fe0592dd777d866b52568fb3c784b63e65c9cacda54e25526a283f` |
| `docs/security-model.md` | `25177b33f9633165f7cdfa79b6475e76c70401628d4b3e38e9337d8fb7a3c036` |
| `docs/deployment-setup.md` | `47ef6ad418fe19b08c910ea40c87da486ae9af1ddcb30cdb516fb35e63ea1f19` |
| Root `README.md` | `5243c7a6e5b0d5cd383eb7bab88fe100d788c5a74f951edb19d95c0f181ad51e` |
| `docs/mutation-canaries.md` (unchanged) | `5ed629c08133018ee36f4c847cc33426690cd2ac3cb2eeb8a4230a35e8e92871` |
| `docs/data-architecture.md` (unchanged) | `8e0976f43498a8653faebfd97918c82fd7d0d24c7e41ad710b10e1f9eb503279` |
| `mcp/pyproject.toml` (unchanged) | `3a2f2047d79c94ba8e0e32102bc96ea8e36832c724f428e4b73859a814a5bf4b` |
| `mcp/uv.lock` (unchanged) | `ade31dbba896add3e8239694565477b6716b4a1d86da0e35f324e59a84b24864` |
| MCP aggregate,28 files | `00b805c53747200ec59daefcc12c43b50a95878cb5745153831611e8d06ae81d` |
| Control output models | `000ffb031d5f0b24389381f98bd0ab77cfc2aaf61b7caf682cd967de417a2f6f` |
| Dedicated control protocol tests | `5c03266caaea0335712a6f2a3467b5a92535fed5a85aa0b2a87a54a8f78587b2` |
| Prior05 completion, unchanged | `53979fc2e48cbfa15d1fca36c0aec8e5055a54f5dd310427fde5e16b4fcc1e9a` |
| Prior06 completion, unchanged | `ac565802bc5607af5dcd515a7c419d2e428d7f04e631c15ae3a5a38587d42443` |
| Parent campaign state, unchanged by this worker | `7cf7f236d6b73253ad2445363e23314b846c2f6ff6d2e8727df06bd1a04c5cc9` |
| Implement-folder skill contract | `6931110e9e65d050fada7b1ba92e1c4c5873aeea87a98c2402bee02b4cbc18c7` |
| Step-worker contract | `7b581abbc75a1218c6740ec82693dd4043fc0ff9c7202f62c6b26883589511e4` |

Aggregate algorithm: sort relative POSIX paths for manifest, lock,
`mcp/src/**/*.py`, `mcp/tests/*.py`, `mcp/tests/*.ts`, `mcp/tests/*.mjs`;
hash each `path + NUL + bytes + NUL`. Exclude environments/caches/scratch,
docs and completion records.

## Decision Needed / Next Preconditions

**No unsettled parent decision for07.** Parent may proceed08 using one normal
124-tool catalog, existing delegated invocation/OAuth/storage, exact shared
control receipts and the existing sole API provider/job/audit owners.
08 container/lifecycle tooling,09 client qualification,10 Azure source tooling,
11 isolated/integrated verification and12 deploy-for-testing handoff remain
parent-owned. Preserve the real SQL/live proof gaps and exact target/approval
requirements; do not add runtime canary/release gates or replay uncertain writes.
