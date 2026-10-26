# Phase 09 — Client onboarding and workflow evaluation

## Phase result

**Complete for the authorized local, disposable, synthetic-validation scope.**
The final full Python aggregate and all required affected checks passed.
Position **6 of 9** in the stable manifest. Parent-supplied worker
launch settings: **GPT-6.1 Sol (`gpt-6.1-sol`), `xhigh`**; no nested agents.
No model-selection API or runtime configuration was changed.

Application boundary:
`/Users/candede/repos/agent365/agent_control` (backend/frontend/MCP/deployment
owners). HEAD remains `d3a82a8d7673cb55300b6ab30fc3848d40554015`.
Prior uncommitted work was preserved. Repository `AGENTS.md`, plan README/09,
implement-folder design/execution contract and `references/step-worker.md`,
parent campaign and 05/06/07/08 records, current usage/security/API contracts
were read. Parent campaign and previous completion records were **not edited**.
Validation: 2026-10-16 UTC / 2026-10-17 local.

This completes 09's authorized synthetic/local scope, **not** vendor/model/
Entra/provider certification or phases 10–12. No authorized existing account
plus public synthetic endpoint was available for vendor onboarding. No request
for credentials or new registration/ingress was made. Ordinary configured
application use has no acceptance, read-qualification, canary, enable or
Always-Deploy prerequisite.

## Follow-up — per-client templates and native OAuth evidence

The user's subsequent request added six checked-in native-format templates
under [mcp/examples/clients](../../../mcp/examples/clients): VS Code, Claude Code,
standalone Copilot CLI, GitHub cloud coding agent, OpenCode and Copilot Studio's
MCP OpenAPI connector. Hosted Claude Desktop/web use their connector UI rather
than a fabricated native remote-HTTP JSON configuration. Microsoft365 publication
is distinguished from Studio authoring; deprecated `gh copilot` is not treated
as the standalone `copilot` product.

One retained-context implementation/research agent used **GPT-6.1 Sol / xhigh**,
without nested workers. The [current guide](../../../docs/mcp-clients.md) includes
primary-source/function-level compatibility evidence. VS Code/OpenCode have
source-backed DCR/S256/resource behavior; CLI and Studio retain explicit
unverified endpoint-level behavior. Copilot CLI's prospective root callback is
not misrepresented as implementation-proven. GitHub cloud remote OAuth is
unsupported: its transport template is not an authenticated working recipe.
No app-only/shared-credential workaround was added.

The requested "any client" was clarified as any downstream consumer, not a
wildcard Entra identity. Existing DCR accepts arbitrary compatible consumers;
new tests verify independent opaque registrations without authorizing anonymous
API access. The server still enforces exact redirects, resource indicators,
PKCE, tenant/audiences, delegated roles and OBO. Local/Azure root-callback
metadata alignment is recorded in phase08; Python production auth is unchanged.

The agent's example/onboarding selector passed **27 tests**, Ruff/format and
**29 documentation links**. Parent aggregate verification passed **107 tests**
across config/storage, OAuth, examples and onboarding, including two synthetic
complete SDK OAuth flows using exact native loopback/root callbacks. These are
not live vendor sign-ins, product certification or model-selected workflow proof.
No deployment, production access, commit or push occurred. Previous frozen
images do not constitute a build of these new examples/setup changes.

## Implemented and simplified

- Added [client-specific current onboarding](../../../docs/mcp-clients.md):
  Copilot Studio authoring and Microsoft 365 publication, VS Code/GitHub
  Copilot, Claude web, Desktop remote connectors, independent Code CLI,
  Messages API, and primary-source-supported Cowork. Editions, exact callbacks,
  discovery/resource, DCR/S256, refresh/reconnect and surface-specific limits
  are separated. No universal compatibility claim or generic Claude recipe.
- Public research was product/protocol-only. Studio wizard and licensing
  revisions are dated 2026-10-15; publication 2026-10-03. VS Code redirects/
  PKCE/refresh are checked against **1.142.0 source**, not secondary summaries.
  Claude hosted/Code/API/Cowork sources are dated by access, with beta/rollout
  qualifications. **20 authored public primary URLs** passed HTTP link checks.
- VS Code DCR registers **four** exact redirects, not just the callback selected
  for the current flow. Hosted Claude uses
  `https://claude.ai/api/mcp/auth_callback`; Code uses a fixed
  `http://localhost:53109/callback` example. Studio's exact callback must be
  copied from its environment's wizard; none was invented. Entra's distinct
  return remains MCP origin-root `/auth/callback`.
- Current hosted Claude offers CIMD, but this server disables CIMD: select DCR
  **Register automatically**, not published identity. The Messages API caller
  supplies/rotates its own MCP-resource token; API token forwarding is not an
  OAuth browser/refresh implementation.
- One shared test corpus:
  `backend/scripts/fixtures/mcp-workflows.json`, consumed by the existing
  canonical SQL owner and deterministic SDK clients. Existing TypeScript DTO
  fixtures/compiler, HTTP/OAuth SDK fixture and actual frontend adapter imports
  are reused. No evaluator platform, production workflow engine, duplicate
  domain owner, plugin/proxy, new dependency or runtime fixture-auth mode.
- Added `mcp/tests/test_workflows.py` (21 parameterized cases) and
  `test_onboarding.py` (six documented SDK client wire profiles). Shared
  `protocol_client` retains ordinary fixture behavior, allows independent
  initialize identities/request `_meta`, and records actual sanitized tool
  request/status/JSON-byte/elapsed traces.
- Extended `browser_controls.mjs` to execute actual `client.ts`/`reportData.ts`
  adapters for the same read, refresh, curated investigation and control cases.
  The dedicated members adapter fixes limit 50; the limit-1 continuation case
  uses its existing generic `request` adapter, not a duplicate business mapper.
- Strengthened `backend/src/routes/mcpReadContracts.test.ts`: same corpus IDs/
  counts/edges, source membership references, raw source platforms, long/native
  Unicode and inert adversarial About, exact champion associations, frozen
  cutoff. Inventory pages now go through the actual typed HTTP projection,
  not database-internal rows.

### Exact scenarios and final claims

| Case | Observed deterministic outcome |
| --- | --- |
| A | Exact `alex@example.invalid` → native object ID `aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa`; duplicate saved username is ambiguous. Used pages50+49 contain canonical006..103 plus `report:P_report_only`: **99 used**, **3 created**001..003, **2 owned**004..005, **1 modified**005. Every person/relation/source-reference tuple is checked. SQL inventory is103 unique records over100+3. |
| A About | Complete long101 and native102 Unicode text, including all continuations and byte totals; About103 stays missing/unknown. Native102 member pages use limit1: package P102 first, native source second; choose the exact native source, never the first similarly named package. This bounded request asks for those About sources, not full descriptions of all103 agents. |
| B | Exact company `Example Company`, department `Research`; API-ranked p1/p2/p3, not response-heavy p4 or department agent8. **19 edges** over four association pages, **15 distinct canonical agents** plus report-only `report:P_extra`. Created/used edges remain distinct; source/count/ranking authority stays API-owned. |
| C | Frozen 2026-01-31 clock, Jan1 cutoff: **103 total,101 selected** over100+1, boundary included,1ms-before and unknown creation excluded. Native-only presence is not guessed from names/descriptions/import/modified dates. |
| Reports | Five snapshots over two history pages for each of four comparisons. Equal nonoverlapping Jan→Mar returns API +50 responses/+50%; overlapping, unequal and missing periods return incomparable/unknown, never fabricated growth or summed snapshots. Existing SQL owner also checks report/bridge discrepancy and non-additive counts. |
| Identity/platforms | Native and guest exact IDs, missing report counts null/unavailable; real SQL proves validated MSAL home-account key rather than guest oid/resource-tid guess. Duplicate names and source strings Studio/Agent Builder/Teams/SharePoint/future/absent platform remain source evidence, not client classification. |
| Interactive | Block and unblock × mismatch/receipt-expired/child-admission-expired. Direct event-controlled observation: preview only before first confirmation; rejected old execution then new preview only before second confirmation. Changed source ID/name is displayed; new receipt/hash is explicitly reconfirmed. No fabricated server human-consent assertion. |
| Scheduled | External client obtains current preview→same receipt/hash/key execute→saved status without any human event/pause. Partial child, authorization-wait and unknown readback are **not final verified success**. No server scheduler/bypass flag. |
| Explicit work | Saved refresh history and investigation context are GET-only. Explicit delegated package refresh is POST. Read curated Purview catalog, submit the returned permitted preset for exact agent/bounded window, then GET saved job. No hidden hunt, dynamic KQL, name-based identity join or application-identity fallback. |
| Failures/recovery | Role/scope/session/selection denial on second relationship page stops without recapture/substitution/write. Safe claims challenge/redaction, token refresh, actual revocation401 and reconnect read preserve exact identity and do not replay controls. Existing full auth suite covers expiry/PKCE/resource/token lifecycle faults. |
| Attribution | Concurrent initialize names/versions and per-call missing/present calling-agent fields do not cross sessions. Authenticated opaque downstream OAuth client IDs differ from reported vendor names/agents. Missing labels stay unknown. Canonical SQL control/audit suites prove retained initiator versus current lifecycle origin. |

Adversarial descriptions contain an inert synthetic “export/block/classify”
instruction and `attacker.invalid`. Tests return the complete source text while
asserting no classification, export or control submission in ordinary reads.
There was no paid-model prompt-injection test: deterministic traces do not prove
an LLM will reason safely.

### Measured complete workflow budgets

Final focused log `artifacts/phase09-focused-final3.log`, **27 passed in16.16s**.
These include every tool/page/About call listed above, not favorable first pages.
Times are sums of actual local HTTP tool-call durations; no model/network/
whole-tenant inference is claimed. Confirmation and job-completion waits are
excluded. Catalog discovery/OAuth setup are separate profile checks.

| Workflow | Actual tool/API calls | Actual response JSON bytes | Tool elapsed seconds |
| --- | ---: | ---: | ---: |
| A | 18 /18 | 338,956 | 0.119817 |
| B | 6 /6 | 53,436 | 0.031710 |
| C | 3 /3 | 386,446 | 0.023184 |
| Four report comparisons | 8 /8 | 62,464 | 0.042755 |
| Explicit refresh + curated investigation | 6 /6 | 9,602 | 0.032483 |

A–C individually assert ≤32 calls, ≤4MiB JSON and ≤180s. Existing per-invocation
60s/four-concurrent/eight-request/two-OBO/API30s/exchange10s/524,288-result-byte
limits are unchanged. Tool descriptions/annotations are not confirmation proof.
The retained polling recipe is ≤12 polls,≥2s apart,≤120s, then exact pending job
reference; acceptance is not completion or verified provider readback.

## Verification and actual environment

No host PostgreSQL authority was inherited or fabricated. Existing isolated
toolkit verified Docker context **desktop-linux** and exact socket
`unix:///Users/candede/.docker/run/docker.sock`, engine **29.8.2**, and used only
unique `agent-control-ltdp-<guid>` synthetic projects with owned volumes/networks.
No `seha` settings/ports/containers/volumes or production data were touched.

The provided old `agent-control-scale-5096-operator:local` image was **not reused**:
its current manifest mismatch was known. Phase08's matching7754 image was absent.
The initial cache-only/network-none build could not restore uncached packages;
the ordinary current operator build then restored dependencies **only through
`https://packagefeedproxy.microsoft.io/npm/`**, with no public fallback.
No repository manifest/lock changes or Python installs occurred.

Current disposable operator:
`agent-control-phase09-current-operator:local`,
`sha256:9f2a90eddc3a661ba27b23e891c7cd96d662ffc096a0a63b07403b6062b172f0`.
Labels `com.agent-control.fixture=phase09`,
`com.agent-control.fixture-purpose=synthetic-workflow-validation`.
Runner's guard verified all four image/current manifest SHA-256 values:

| Manifest | SHA-256 |
| --- | --- |
| `package.json` | `289b6aa00bdea3224fcdedcd1a5eb5f768cacf4ade5b0547590b07ba94b6366f` |
| `package-lock.json` | `2a84263c69982d579125b08da7d3da6c455a3e7d47cb07843b368d2fb9f6614a` |
| `backend/package.json` | `acd91a005e43d26a533bd9dd6ebbd6fc54b5fcb50d5f9a078ba15c387d2e5993` |
| `frontend/package.json` | `aecde6451f83aa45e284fbeac06251f7be2bd5f64fb9aa75ccc2a6bb25999785` |

Host: Node24.18.1; Python3.14.6, FastMCP4.1.0, MCP SDK2.3.0, httpx2 2.13.1,
uv0.12.17. Container operator observed Node24.20.0. VS Code1.142.0 was present;
availability of a binary alone was not used as sign-in/tool/refresh proof.
Claude CLI was unavailable.

| Command / scope | Actual result |
| --- | --- |
| VS Code test tool for the two new Python files | No test controller found; used the existing venv pytest runner, not an install |
| `cd mcp && .venv/bin/pytest tests/test_onboarding.py tests/test_workflows.py --basetemp=../.local/phase09-focused-final3 -s` | **27 passed**,16.16s; complete sanitized traces retained |
| `.venv/bin/ruff check src tests`; `.venv/bin/mypy src`; `UV_PYTHON_DOWNLOADS=never uv lock --check --offline` | Passed;19 source files;82-package unchanged lock |
| Prior full Python aggregate, `--basetemp=../.local/phase09-python-final2` | **541 passed**,219.81s; final strengthened test-only aggregate recorded below |
| Final full Python aggregate, `--basetemp=../.local/phase09-python-final4` | **541 passed**,199.77s, on the final strengthened corpus/profile code |
| Backend focused current feasibility/bearer/principal/delegated/MSAL suites | **214 passed**,5 files,2.19s |
| `scripts/large-tenant-tests.ps1 -Suite mcp-read-contracts -BaselineImage <current above> -BaselineImageId <exact above>` | **647 passed**,18 files,211.78s + backend typecheck; includes five real canonical workflow tests, both browser and bearer transports |
| Same runner `-Suite shared-agent-controls` | **695 passed**,24 backend files,98.02s; backend typecheck; **524 passed**,5 frontend files,6.11s; frontend build/lint passed |
| `npm run test --workspace frontend` | **5,150 passed**,118 files,126.71s; component/jsdom/adapter tests, not a live vendor/browser/provider journey |
| `npm run typecheck --workspace backend`; frontend typecheck/lint; `npm run check:unused` | All passed |
| Editor diagnostics on changed Python/JS/TS/docs; `git diff --check` | Passed |
| Final local Markdown file/anchor checks | **58 links checked**,zero failures across five changed documents; `artifacts/phase09-doc-links.json` |
| Public primary-source URL checks | **20 passed**,zero HTTP/redirect failures; `artifacts/phase09-public-links.json` |

SQL scopes overlap: **do not add their counts as unique tests**.
The read suite's actual fixture is
`artifacts/large-tenant-data-platform/0ee47ac10c834f2ebd17e269fab26c38`;
controls/audit fixture:
`artifacts/large-tenant-data-platform/5db7e862a2854492a70fb722a274e5f9`.
Both `result.json` files have `failures:[]`. Use
`/Users/candede/.dotnet/tools/pwsh -NoProfile -File` for this runner.
No tool/callback policy or baseline identity guard was bypassed.

### Failures, repairs and reruns retained

- Initial focused12 cases passed; expanded run had19 passes/one failure because
  a test fabricated unsupported refresh status `queued`. Corrected fixture to
  real `running`, not the production model.
- Next run incorrectly counted provider-free inventory selection capture POST
  as a provider write. Corrected accounting to exempt exactly
  `/api/agent-inventory/selections`; did not hide provider POSTs.
- First profile test guessed revoked refresh HTTP400. Pinned SDK2.3 actually
  returns **401 + `invalid_grant`**; checked its owner/existing contracts,
  asserted the actual status/code and documented reconnect. No auth weakening.
- First SQL read aggregate: **646 passed/one failed**, plus typecheck passed.
  A new test read `.packages` from DB-internal rows rather than public inventory
  DTOs. Repaired to actual typed HTTP pages; rerun all18 files:647 passed.
  Failure fixture `830041d834fd482d919b4ce77830508a` is retained.
- Host origin invocation: action-origin19 tests passed, but six durable
  audit-origin cases required a separately named `agentcontrol_test_*` database
  and did not run. A mistaken parser-only retry still required that database.
  No environment/production DB fallback was introduced. The existing isolated
  **shared-agent-controls** suite subsequently ran those durable audit-origin,
  HTTP/action, shared receipt/jobs/schema and recovery owners successfully.
- The initial backend focused selector included nonexistent
  `src/services/requestOrigin.test.ts`; Vitest ran the **five actual suites**
  reported above, not a claimed sixth. Actual origin files were separately
  exercised in the isolated suite.
- Repeated focused/full runs are retained, not substituted for final evidence.
  An intermediate full run was intentionally stopped before adding the final
  changed-source and explicit-investigation assertions; no runtime failure was
  suppressed. The final strengthened aggregate passed541 cases in199.77s.

### Cleanup and reuse boundaries

All three exact fixture projects have **zero** remaining containers, networks
and volumes under their project labels. All four own operator tags, including
the matching baseline above, were removed after checking purpose labels and
exact IDs; `artifacts/phase09-image-cleanup.json` records them. No prune or
unrelated image deletion. Redacted diagnostic/runlogs and source hashes remain;
all13 own disposable pytest OAuth scratch directories were removed after the
last run, recorded in `artifacts/phase09-scratch-cleanup.json`.

Phase08's514 Python/104 image/1,869 PowerShell/388 selected SQL/548 selected
frontend results and real disposable lifecycle evidence were read, not relabeled
as current client qualification. No runtime/image/lifecycle owner changed here,
so its non-root/persistence/restart/rotation/drain findings are reused only
within that recorded source/environment boundary. Phase09's current SQL,
browser-adapter and SDK proofs above are distinct. Phase11 owns the fresh
current-operator/release aggregate, not the mismatched old image.

## Changed roots and unchanged impacts

- **Backend test owners:** shared corpus and canonical SQL assertions only.
  No route, service, SQL schema, identity, source ranking/join, permission,
  provider writer, provider association or receipt semantics changed.
- **MCP tests:** protocol fixture extraction, test-only SDK profiles/corpus/
  actual browser-adapter capture. **All19 production Python modules,124-tool
  registry, invocation limits, auth/storage/origin and frozen dependencies are
  unchanged.** No second catalog or workflow authority.
- **Frontend runtime:** unchanged. Actual current adapters and component suite
  are exercised; no duplicate client business logic or fabricated provider
  classification was added. Generic request handles the deliberately smaller
  member-page limit that the existing dedicated UI adapter does not expose.
- **Deployment/container/operations owners:** unchanged. Current optional08
  setup is documented/reused, not redeployed or extended into10. No secret,
  environment/settings, tenant registration or runtime flag edit.
- **Docs:** new current client guide; README/setup/API links and stale corpus/
  exact-loopback-policy descriptions corrected. Existing campaign and earlier
  phase records remain parent-owned and untouched.

No shared production defect was confirmed: observed failures were test fixture/
projection/measurement/validation-environment mistakes, repaired in their test
owners. No hidden refresh, client-owned rank/join/trend engine, provider
authority inference, schema fallback or legacy compatibility implementation.

## Content identity and persistent evidence

`artifacts/phase09-source-hashes.json` freezes **34** prerequisite/current source,
manifest and doc identities, including AGENTS, README09, implement-folder/worker
contract, parent/05/06/07/08 records and production auth/catalog/origin/image
owners. Required 09 prompt SHA-256:
`d636986b34a2f5459e5b71d9b94206e05f39f5d11635b998fb716fa8129008d2`.

| Current file | SHA-256 |
| --- | --- |
| shared corpus | `2c92a057b58d2d4ab4694110e4c15a38f9e9ca46d5f6e9ed88a284c99e4c17ef` |
| canonical SQL workflow test | `95d0626767f555be51dd05a6ece67188dfff71780cfe39c1a15ba84e2f7aaef9` |
| SDK workflows | `9ba1c2ec4117637ccaeeff0bd904d755f9b8a7c9d7036f9f99392c47816d51dd` |
| SDK onboarding profiles | `1b9a4217c350555a6e314d808fdcfd8e1b5d77c1994d4dcd14c7ecbee71a892b` |
| current client guide | `39636e2d271e92dab74d976bdf85ae63a1a20e58d8b057176e91a62563f89bf6` |
| `mcp/uv.lock` | `ade31dbba896add3e8239694565477b6716b4a1d86da0e35f324e59a84b24864` |

Logs: `artifacts/phase09-focused*.log`, `phase09-onboarding*.log`,
`phase09-python-{static*,full*}.log`, `phase09-backend-focused.log`,
`phase09-origin-*.log`, `phase09-frontend-full.log`, `phase09-node-static.log`,
`phase09-sql-{read*,controls}.log`, operator-build logs, public-link JSON and
the exact fixture diagnostics above. They contain synthetic/redacted data, not
real secrets/customer exports. `artifacts/phase09-evidence.json` records the
final completion/runlog/link/cleanup hashes; the source snapshot was rechecked
with **zero mismatches**. Evidence identities must be refreshed after any further
source edit.

## Parent handoff: remaining external proof, not an application gate

1. **Phase10 owner:** hosting/forwarding/canonical URL/durable-state design;
   phase09 did not provision Azure, callbacks, ingress or tenant registrations.
2. **Phase11 qualification owner:** build a current approved-feed operator and
   run the required aggregate against exact current sources/manifests. Reuse
   local evidence only if source/environment identities still match. With an
   already authorized synthetic account and endpoint, separately record each
   actual Studio authoring and Microsoft365 published agent, VS Code harness/
   edition, Claude hosted web, Desktop, Code fixed callback, API application
   and Cowork surface/version. Observe124-schema discovery, actual multi-page/
   full-About final claims, access expiry/refresh/revocation/reconnect, private
   native/guest source scope, reported/unknown labels and no cross-caller leak.
   Observe real UI confirmation/reconfirmation and separately the external
   no-human-pause schedule. SDK fixtures are **not** substitutes for these.
3. **Phase12 authorized convergence owner:** actual approved endpoint/tenant/
   provider lifecycle, publication, persisted state/rotation/drain/recovery and
   exact verified provider readback. Production or remote mutation is not
   authorized by this local record. No new account/public tunnel/registration/
   grant/paid-model call or source/customer-data export follows implicitly.

No deployment was performed, no real provider write or external model call
occurred, and no git commit/push/branch was created.
