# Phase 11 — Integrated release, recovery and capacity verification

## Scope and result

Position **8 of 9**, application boundary
`/Users/candede/repos/agent365/agent_control`: backend, frontend, MCP,
deployment and operations. Validation date: **2026-10-17 UTC**.
Worker launch requested **GPT-6.1 Sol / xhigh**; no nested agents were used.
HEAD remains `d3a82a8d7673cb55300b6ab30fc3848d40554015`; there was no
commit, push, branch change, phase12 execution or live deployment.

This record distinguishes verified local behavior, a **failed resource-capacity
qualification**, and unavailable external evidence. It is not a production
approval, vendor compatibility claim, read-enable artifact or runtime gate.
Ordinary deployment, sign-in, automatic first synchronization, saved reads and
existing authorized operations do not acquire another prerequisite.
The authorized local implementation and deployment-testing qualification are
complete, with the failed/unavailable scopes explicitly preserved below.

Read: repository `AGENTS.md`, [manifest](../README.md), [phase11](../11-release-qualification.md),
implement-folder design/execution and step-worker contracts, parent campaign,
05–10 records, and current API/data/security/client/deployment/operations owners.
The parent campaign and historical completion records were not edited.
`artifacts/phase11/fastmcp-protected-input-hashes.json` preserves the ten protected
input hashes. The phase11 prompt is
`b5ba6f2d8108a4e3a5f1b0e3800b803e0547f2b18f41a8aad6ea3156b775d41d`;
the current phase10 prompt is
`955c7a8b8171493567cdce8e13bd801e1a023a5700ec92ba7b4073ca51602d91`.

Only local code/tests/docs and unique owned disposable Docker/SQL/Azurite
fixtures were used. Docker was `desktop-linux`, engine `29.8.2`, socket
`unix:///Users/candede/.docker/run/docker.sock`, without host/context overrides.
No inherited database/tenant/client/session authority, customer data, `seha`,
cloud login/API/resource/secret access, public ingress, registry publication,
paid model calls or real provider writes were used.

## Implemented repairs and simplifications

- The existing capacity owner now traverses **all 100/1000 pages**, not a
  three-page prefix, checks complete ordered identities/cursor termination and
  reports actual serialized bytes. Its parser refuses incomplete request-window
  evidence. Resource failures remain failures; no ceiling was raised.
- Extended the **existing** SQL fixture selector with `mcp-end-to-end`.
  Test-only Python/TypeScript support connects actual SDK OAuth/tool calls to
  the registered canonical Express HTTP handlers and real isolated PostgreSQL.
  It is not another route catalog, domain implementation or evaluator framework.
  Child execution is bounded, asynchronous, minimal-environment, loopback-only,
  redirect/proxy-free and exact-fixture guarded; private test state is removed.
- Replayed complete A–C results, including all 103 wide inventory rows, all
  relationship/champion pages, reporting-window comparisons, full Unicode About,
  and the exact native 100+1 boundary. Block/unblock traverse SDK preview,
  current receipt execution, durable SQL jobs, stable-key replay and saved
  receipt readback. Only Entra/provider transports are synthetic.
- A real mixed 100-row SQL DTO exceeded the unchanged SDK envelope and correctly
  failed 413. The wide workflow now reads **all five 25-row pages**, not a smaller
  favorable prefix. Native-only case C separately verifies 100+1 with the actual
  final SDK envelope.
- Matched results compare every business field. Only freshly reevaluated
  `selection.validatedAt`/`inventorySelection.validatedAt` clocks are independently
  checked for timezone/freshness/monotonicity and aligned for paired comparison.
  No business values or error results are ignored.
- Added actual two-principal container load/backpressure/recovery and immediate
  post-load cgroup capture; preserved distinct production and test image proof.
  Added exact final-envelope boundary regressions, including real SDK framing.
- Corrected the restart fixture's required Purview
  `authorizationPrincipalId`; the actual compiled crash/recovery owner then passed.
- The current-only fresh-install owner now actually collects, resets its exact
  disposable database, starts normally and recollects through compiled current
  services with synthetic provider transport. It no longer claims a skipped
  first synchronization.
- Corrected the browser cadence fixture to use its existing
  `metadataAfterPermissionCatalog` ordering. Exact observer/timing assertions
  remain; production refresh behavior was not changed.
- Repaired existing source/redaction/license tooling for explicitly synthetic
  support/install fixtures, narrow escaped fixture characters, non-package Vite
  cache directories, and the current tenant-registry vault contract. Added
  positive/negative tests instead of excluding tests or suppressing global checks.
  Two mechanical Ruff findings in the directly affected container-contract test
  were formatted; global checks remain enabled.
- Kept the approved npm registry in the **production runtime stage**, not only
  build/dependency stages, and in the combined SDK fixture. The new regression
  initially exposed a missing root Dockerfile in the SQL fixture; the existing
  owner now copies that actual file.
- The first B/C replay extension called the SDK helper in the ordinary Node-only
  read owner; its exact-fixture guard correctly refused two cases
  (645 passed/2 failed). Restored the same explicit named-SDK branch already used
  by A. The guard itself was not relaxed; ordinary SQL and named SDK owners are
  verified separately.
- One 123-case container check correctly refused private-file permissions on
  host-bound ephemeral test scratch. A metadata-only diagnostic reran all 123
  successfully without relaxing storage checks; the original transient cause
  was not established. Removed that unnecessary host-bind dependency: offline
  unit scratch is now UID/GID-owned 0700 Linux tmpfs, bounded 64MiB. All 123 cases
  and the complete durable-volume container journey passed afterward.
  **Production local strict FileTree behavior is unchanged.**
- Updated [operations](../../../docs/operations.md),
  [setup](../../../docs/deployment-setup.md),
  [data architecture](../../../docs/data-architecture.md),
  [MCP integration](../../../docs/mcp-integration.md) and
  [client guidance](../../../docs/mcp-clients.md). Commands use a freshly built
  exact-ID baseline and a unique owned tag.

Necessary new complexity is confined to the test-only SDK/actual-HTTP bridge
and complete measurement/ownership evidence. API authority, tool count, control
orchestration, frontend product behavior and deployment architecture were not
duplicated. No approval file, scheduler, provider mapper, legacy fallback or
Always-Deploy contract was introduced.

## Verification accounting

Counts below are **overlapping scopes, not an additive total**. Successful
selected aggregates have no skipped tests. A one-test selector used while
developing the fixture regression deselected23 others; it is not an aggregate
pass or evidence that those tests were unavailable.

| Owner / actual command boundary | Result |
| --- | --- |
| `./scripts/azure-oauth-fixture.ps1 -Full` | **583 passed**, zero skips, **240.17s**; includes **21 real Azurite/maintained-Azure-SDK cases**, including server-side 412 stale-writer rejection |
| Focused backend auth / HTTP / native-guest / privacy contracts | **214 passed / 5 files** |
| Directly coupled scanner/auth/support redaction regressions | **52 passed / 3 files**, final exact-current rerun |
| `large-tenant-tests.ps1 -Suite mcp-read-contracts` | **647 passed / 18 files**, actual isolated SQL and registered web/bearer handlers |
| `-Suite shared-agent-controls` | **695 passed / 24 backend files**, plus **524 / 5 frontend files** |
| `-Suite audit-origin` | **133 passed / 12 files**, real canonical HTTP/SQL audit owners |
| `-Suite capacity-focused` | **1008 passed / 31 files**; capacity parser **23 passed** |
| `-Suite deployment-current` after the root-Dockerfile copy repair | **390 passed / 14 files**, isolated SQL; previously389 passed/1 failed on missing `/app/Dockerfile` |
| `-Suite mcp-end-to-end` | **26 passed / 2 files**, **12 visible SDK receipts** across both matched transports, A–C and both control directions |
| Complete frontend `npm test --workspace frontend` | **5150 passed / 118 files** |
| Selected actual Chromium specs through the owned browser runner | **60 passed / 6 specs**, plus its **1 Vitest wrapper** |
| Deterministic official-SDK/browser client corpus | **27 passed**; actual measured A/B/C traces retained |
| Offline container config/storage/OAuth/API test scope | **123 passed**,58.15s, with bounded private Linux tmpfs; not a replacement for durable-volume tests |
| Deployment mock owners | Azure300 + local-deployment1375 + local-runtime315 + MCP67 + fresh-install113 = **2170 assertions**, explicitly mocks |
| Ruff / formatter / mypy | All checks passed; **34 Python files** formatted, **20 production modules** typed |
| Backend/frontend typechecks, frontend lint, root build and `npm run check:unused` | Passed; no global exclusions added |
| Existing dependency/redaction/static scanner | Passed; **854 source files / 17097009 bytes**,312 installed development-tree license identities,194 compiled backend runtime files |
| Offline `.local/phase10-bicep/bicep build infra/main.bicep` and `infra/mcp.bicep` | Both passed with0.48.1; no cloud validation/provisioning/what-if |
| Actual production image contents/policy | Node nonroot1000,127 production-only dependency-license identities; MCP nonroot10001,86 installed distributions, Azure SDK importable, development tools/SQL drivers absent |

The full Azure proof is
`artifacts/phase10-blob/ac-oauth-fixture-6a25d90c40494067982333c4/evidence.json`.
This final isolated run records responsive transport, exit0, exact container/
network removal and `priorContainersPreserved:true`. An earlier full run
`09f24d7c6ad840b78d37f7a9` recorded `priorContainersPreserved:false` while other
owned fixture lifecycles overlapped; that observation is retained, not claimed
as a preservation pass. The isolated recheck was performed without concurrent
Docker/build/SQL lifecycle work.
Ordinary pytest without that owner may correctly omit Azure cases and is not
equivalent. This emulator evidence does **not** certify App Service, UAMI,
Azure networking or cloud lease/replacement behavior.

The current Azure profile remains phase10's maintained-SDK, explicit-UAMI,
single bounded Fernet-encrypted Blob map: exact lease plus ETag on every write,
renewal/deadline/read/issuance/publication fail-closed, and no stale authorization
cache. The rejected NFS architecture was not restored.

Important local evidence directories under `artifacts/large-tenant-data-platform/`:

- `37d8613c1c604f10aeea361dac06f194`: shared controls.
- `433c623b7f3f466f9165877b2df5f0a8`: audit/origin.
- `c6abeb3536fc41bb8f80095af0313891`: capacity-focused owners.
- `b51cb1aaa6664f808e262908812b62ee`: final60-case Chromium run.
- `ff27ce9271384282b176033d5ae6028f`: actual current-only installation,
  collection/reset/recollection and incompatible-schema refusal.
- `dbcf9b39d7f5491fa35e40ec3a65d9a7`: current-image compiled SQL writer
  seed/dispatch/crash17/expiry/recovery.
- `f22d674f98a4419c8e229f114d918dca`: final durable-volume MCP lifecycle,
  load, drain, resource inspection and owned cleanup.
- `c7eee1f79b5a4972b411eadfc587ec99`: final390-case deployment aggregate.
- `f5a4fb1f71e042e3a807fbea3b1c36e2`: final647-case ordinary SQL read owner.
- `ca7a7bbe6b0248cb9593bbad4a2e994b`: final26-case actual SDK/HTTP/SQL A–C,
  both matched transports and both control directions,12 complete receipts.
- `fb7614f252eb47dcbe7c8d492f8a6695`: preceding complete SDK A–C diagnostic,
  not substituted for the final guarded rerun.
- `677e30771c8c41399ae307690476ab33`: full fixed-cohort query measurements,
  including failed PostgreSQL resource criteria.

Final rerun logs, including `read-contracts-all-cases-guarded.log`,
`mcp-end-to-end-final-guarded.log`, `python-isolated-final-aggregate.log`,
`retained-final-backend-typecheck.log`, `retained-final-knip.log`,
`retained-python-static-final.log`, `retained-security-redaction-units.log`,
`retained-*-mocks.log`, `retained-final-security-scan.log` and the recorded
failure/recheck diagnostics are in `artifacts/phase11/`. These are local ignored
artifacts, not committed files or a portable remote evidence service.

## Actual A–C flow, authority and budgets

There remain **124 concretely typed tools**:76GET,45POST,1PATCH,2DELETE.
The complete actual registered SDK schema/argument contract remains covered;
124 is an operation count, not a test count. Tools call only canonical API
routes. API/MSAL mapping, roles/private scopes, source identity, SQL joins,
champions, reports, receipts, provider work, jobs and audit remain API-owned.
Python does not become a SQL/provider business owner.

The actual connected client uses real SDK OAuth/protocol, JWT verification,
request-local origin propagation and actual loopback HTTP. Registered canonical
handlers execute real isolated SQL; synthetic Entra keys/accounts and provider
transport are explicit. Existing saved selections are pinned inputs, not
fabricated DTOs. Cookie/bearer fixtures bind the same intended principal and
compare each SDK result with its matched API request/result. Native/guest,
private scope, roles, source/resolution, stale/partial/malformed/duplicate/
out-of-order pages and error contracts also run in the broader SQL/auth/corpus
owners; there is no claim of live Entra native/guest proof.

Measured final connected run `ca7a7bbe…`, for both matched transport fixtures;
all12 full receipts are summarized in `sdk-sql-measurements.json`:

| Complete workflow | SDK calls | Aggregate RPC JSON bytes | Sum of actual tool-call seconds |
| --- | ---: | ---: | ---: |
| A: resolution, all relations, all103 inventory IDs in five25-row pages, full About |16|945128|0.467220 /0.414183|
| B:5001-directory cohort, all103 champion edges in three pages, four reporting-window comparisons |8|181718|0.571322 /0.545755|
| C: native-only exact cutoff, complete100+1 pages at the pinned evaluation time |2|528588|0.095513 /0.109690|

CaseC's largest actual invocation was **511186 bytes** in both transports,
below524288; aggregate workflow bytes may exceed one invocation's cap. A's
largest invocation was156196; B's65256. The synthetic SDK/browser corpus is
separate: A18calls/338956bytes, B6/53436, C3/386446, and does not replace the
larger actual SQL DTO measurements.

Every replay enforces≤32calls,≤4MiB aggregate JSON and≤180s, with a bounded
180s child lifetime; reported sums exclude fixture seeding/OAuth setup and
human/job wait. Tool invocation60s, API30s, OBO10s,4 concurrent API requests,
8 physical requests and2 exchanges remain unchanged. Final MCP text plus
structured JSON is bounded524288UTF-8 bytes, without truncation. Accounting
accepts exactly524288/rejects524289; actual SDK framing has tested representable
524287-accepted/524289-rejected cases.

Both control directions perform real SDK preview→execute→get against the
registered API. Actual SQL jobs settle through the existing canonical fixture
owner; same-key replay does not write again and the saved receipt is read back.
Matched private prestate, uncertainty, idempotency and resume are covered.
Interactive current-receipt confirmation is client-owned; externally scheduled
clients use the same current receipt without an artificial human pause.
**Provider-side effects are synthetic, not a live platform-write certification.**

The5001-user SQL measurement records27queries/24returned rows for resolution;
champions traverse all103 edges in3pages with243queries/327returned rows.
These are canonical database-owner work counters, not a claim that HTTP
authentication/session overhead executes zero additional queries. The actual
registered HTTP/SDK champion/history pages are separately exercised.

## Actual container, recovery and resource proof

The current application works without MCP. The owned installation fixture
exercises empty/current startup, compiled synthetic collection, explicit owned
reset, ordinary start and recollection; incompatible schemas are refused.
The Node crash/restart fixture uses durable SQL and compiled production
services. It does not infer provider success from an in-memory API stub.

The MCP owner first starts/inspects the actual **production** image
`sha256:20c61cf8177c057e7508c6fb72253eaa11d28f9372dc62ea487bc157f2784e97`,
then distinctly uses the test-only OAuth image
`sha256:6b4ee89ef4b533c2d9af716e6b5b83690e3a57fce4ef619efcd20686d8ad5e5f`.
Its exact project is `ac-mcp-fixture-08c262842b9944528936f872`; port/network/
mount/creation identities are retained in `mcp-ownership.json` and inspections.
Production-default UID10001 is distinct from the explicitly configured local
operator UID/GID501:20. Test helpers are not production-content proof.

Actual tests cover cold readiness, restart, independently rotated encryption
ring/client credential/signing key, API restart/credential loss, durable
revocation/reconnect, authenticated graceful drain, unsafe secret/state refusal
and recovery, and concurrent initialize/`_meta` principal isolation.
Synthetic API credential-loss protocol and real canonical Node/SQL auth/job
recovery are distinct proof scopes; live MSAL/provider recovery is unavailable.
Sent-unknown work is reconciled, never blindly redispatched.

Final measured two-principal load:4 isolated baseline calls;64 burst HTTP calls,
**10 admitted /54 rejected503**,3932response bytes in3.110031s;2 recovery calls;
whole capacity mode9.323518s. Admitted count over time is not a simultaneous
slot count. Post-load actual cgroups:

- memory peak147230720bytes /536870912limit; all memory max/OOM events0;
- CPU `50000 100000`, usage2676801µs,47/153 periods throttled,
  throttled2273644µs;
- PIDs current18, peak22, limit128;
- readonly root, cap-dropALL, no-new-privileges, loopback-only published MCP
  port, and json-file logs5m×2 verified by runtime inspection.

Later recreated/rotated container peak177299456bytes is a separate sample,
not one continuous lifetime maximum. Authenticated shutdown took3.2639841s.
These are bounded synthetic-container measurements, not provider/App Service
capacity certification. The application/SQL query fixture has separate1.5GiB
application and1GiB PostgreSQL limits, not the MCP512MiB profile.

## Complete large-cohort capacity result — not a pass

| Fixed canonical cohort | Complete pages/rows | Serialized bytes | p95 / p99 / maximum list latency |
| --- | --- | ---: | --- |
|10k|100 /10000|17229777|86.072751 /134.243417 /271.192709ms|
|100k|1000 /100000|172327574|75.269208 /87.613666 /1877.729334ms|

Complete ordered identity hashes:

- 10k: `7a2068bf29754d4d8b9341acbdfd84bf69f42984bc844cf911b2ce4d1ec4a322`
- 100k: `5eae6164b792be373413ca8dc17f8fcf6bc5ae5ed14cb14d09aa971d2a3ec70e`

All1100 request windows and679 identified workload GC records were accounted for,
with0malformed/dropped records. Peak-sensitive request-working-set
delta572640bytes passed64MiB; application kernel peak259141632bytes was within
its1610612736limit. Observed connection maximum3/shared limit4; pool wait
maximum0; measured SQL maximum1766.148042ms.

**Failed:** PostgreSQL kernel-charged peak1074098176bytes against1073741824,
8607memory-max events, and the80%-memory/cache-pressure criteria.
Observed file cache991920128bytes. No OOM/restart occurred; that does not make
the resource criteria pass. Backend RSS observations101928960maximum and
382824448sum are not an independently measured production resident-memory
working set or proof that shared pages are additive.

Functional complete rows/identities/paging/list latency/connection/application
memory checks passed. The strict capacity parser result is **failed**; the
query workload's broader production-profile qualification remains
**inconclusive**. Full steady cycles, export/import/mutation workload and other
unmeasured profile gates remain unknown, not zero. No caps were raised, cache
failures hidden or synthetic fixture benchmark called production acceptance.
The172MB unfiltered100k traversal is not a≤4MiB A–C workflow.
These are saved-query owner measurements, not whole HTTP/vendor-client latency.
JSON response bytes are not SQL wire bytes; that wire-volume measurement and
unmeasured production-profile fanout/cycle gates remain unknown, not zero.

## Origin, privacy and attribution

The133-case real HTTP/SQL origin owner, shared controls, SDK cases and actual
Chromium specs cover actor versus reported caller/agent; known/unknown origin;
append/projection/CSV/UI; concurrent initialize/`_meta`; initiator versus resume/
current origin; mixed children, retries, retention, privacy and spoofed labels.
Calling-agent labels remain reported annotations, **not** the managed target
or an authenticated actor. Current verified principal, role/private prestate,
target IDs and receipt authority are not replaced by those labels.
CSV formula protection and UI rendering remain at their existing owners.

## Current production artifacts and dependency policy

Final frozen local artifacts:
`artifacts/fastmcp-release-qualification-11-ae8b2098a330/`.
Owner `ac-mcp-release11-ae8b2098a330`; purpose
`fastmcp-phase11-deployment-testing`.

Source manifest SHA256:
`04587873657ef2e1a8b1a873b295ec8796cc80f71fc4dcc324b934a9a5e0a423`.
Its922 tracked/untracked current inputs exclude secrets, env files, installed
dependencies, local state and completion records. `snapshot.json` identifies
the retained frozen build-input directory:
`artifacts/local-builds/cbb0433f6c8141e1b1912d367189d2ae/source`.
All922 current files and all922 actual frozen files were hash-matched after
cleanup. `snapshot.json`'s former Compose environment is documentary, not a
retained fixture configuration; normal setup must create a fresh authorized
configuration. `contract-hashes.json`, production inspections,
image identities and final verification receipts retain exact content hashes.
No commit was manufactured for an identity.

Retained production images, both **linux/arm64 local Docker testing**, not
published App Service/amd64 artifacts:

- `agent-control-release11-ae8b2098a330-app:local`:
  `sha256:487934d7b1baffc79775994cc894da7021f4b5844a36797a9fa667483ccb1de9`.
- `agent-control-release11-ae8b2098a330-mcp:local`:
  `sha256:8f83cee24ee2dfdd6303a5c2542df33d0a7c379da8f8eda34f6d99b523920687`.

Current operator/test/inspection images were also built and tested; their IDs
remain in `images.json`, but they are helpers, not retained deployment promises.
Actual final production contents were inspected separately from test images.
The application content/modes/symlink digest is
`041a290271c39e44f9d272b8cd47f52188d639b11a07a8a36a9ccf4c996134fe`.
Actual file/config comparisons bind earlier current-runtime restart proof to
the final artifact after test-only/documentation changes; MCP runtime layers
and runtime configuration are identical apart from source/owner labels.
The final application tree inspection reports7467files/58561762bytes.
Its secret-comparison count is0: no real account secrets were supplied or read;
source, negative-marker, content, mount and credential-injection checks are not
misrepresented as comparison against unavailable real secrets.

Node runtime is24.20.0, default UID1000,127 inspected production dependencies
versus312 in the development tree. MCP has20 production Python modules,
99locked packages,86 installed Linux production distributions, UID10001;
pytest/ruff/mypy/uv and SQL drivers are absent. All85 third-party distributions
have SPDX/classifier or legacy license metadata; seven use legacy metadata.
The repository-owned package has no distribution SPDX declaration; no legal
approval is inferred from that omission. No database/provider secret is
injected into the production MCP image.

Effective npm registry is only `https://packagefeedproxy.microsoft.io/npm/`
on host/build/combined fixture/**actual production runtime**. The root lock has
522entries and intentionally0HTTP`resolved` URLs; registry independence is not
a public-registry fallback. All98 Python registry entries use
`https://packagefeedproxy.microsoft.io/pypi/simple`;710 locked artifact URLs
are credential/query-free Microsoft Azure Artifacts download URLs
(`ms-feed-25.pkgs.visualstudio.com`), not public PyPI/index fallbacks.
No guessed lock URLs or extra indexes were substituted.

Actual build manifest references include Node
`sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e`
and pinned Python
`sha256:4c92ffcde4dd6f1ff72a24518f49fd4990b27134987dfa31a733badde66df9f8`.
The real emulator is the authorized
`mcr.microsoft.com/azure-storage/azurite@sha256:647c63a91102a9d8e8000aab803436e1fc85fbb285e7ce830a82ee5d6661cf37`.
Future builds must recheck actual immutable identities; mutable local tags or
old phase08/initial-phase10 proofs are not a current-image substitute.

## Cleanup, persistence and final root hygiene

`cleanup.json` records **71 removed image references**:70 exact-owned helper/
superseded references and the one immutable official emulator fetched for this
task after a missing-image refusal. Each image's expected ID, ownership/purpose
where applicable, absence of container references and target engine were checked.
There was no force removal or global prune. Shared pre-existing Node/Python/
browser bases and BuildKit cache were untouched.

Removed **19 directories**:six old owned build snapshots, three phase11 pytest
scratch roots and ten owned home/cache/Chromium/unused-PG directories. Another
**20 exact directories were already absent**. Removed **25 ephemeral files**
(24 generated Compose environments and one Chromium scratch file). Preserved
redacted JSON/log/Chromium diagnostics; did not remove an artifact parent folder,
historical completion record or unrelated data. Known private key/signing/
encryption fixture paths are absent without reading their contents.

Final checks cover **53 exact owned projects /318 ownership-label queries**,
with no remaining owned containers/networks/volumes. The unrelated whole-engine
container/network/volume identity sets were unchanged during cleanup. Initial
cleanup preflights safely refused Docker's resource-specific not-found wording,
its duplicated immutable @digest tag/digest representation, and a regular
Chromium scratch file initially classified as a directory. Exact metadata was
checked before the scoped retries; the refusal receipts remain, and final
cleanup has no failures. No runtime storage or fixture authorization guard was
weakened to clean up.
`verification-notes.json` also preserves one-off evidence-reader corrections:
canonical SHA hex casing, approved Microsoft artifact-download origins, Docker's
configured username versus actual runtime UID, and full rather than short image
IDs. Actual contents/runtime/source checks were rechecked, not replaced with
weaker product assertions.

Only the two final production images above, the one identified frozen source
snapshot and redacted evidence are retained as explicit local testing
deliverables. Final helper images are intentionally gone; rebuild a new unique
operator for another test run. Once no authorized test/deployment uses these
deliverables, verify the recorded owner/purpose/source/IDs and no container
references before these **future cleanup commands**:

```powershell
docker image rm sha256:487934d7b1baffc79775994cc894da7021f4b5844a36797a9fa667483ccb1de9 `
  sha256:8f83cee24ee2dfdd6303a5c2542df33d0a7c379da8f8eda34f6d99b523920687
Remove-Item -LiteralPath ./artifacts/local-builds/cbb0433f6c8141e1b1912d367189d2ae -Recurse
```

Do not force image removal, substitute a mutable tag or delete another source
directory. Keep the redacted evidence ledger unless its owner separately
authorizes removal.

Whole-root `git diff --check` passes, as do no-index whitespace checks of
**51 untracked current-source/completion files**. All ten protected inputs and
HEAD are unchanged. The complete current dirty root contains **40 modified
tracked files /59 untracked files**, with tracked summary2442 additions/
165 deletions; these counts include preserved prior work, not worker-only
attribution. No files in another application root were changed. Static
configuration checks parsed21 PowerShell files,3 Compose YAML files and3 public
example JSON files; semantics/receipts are covered by the actual owners above,
not inferred from syntax. All148 local documentation/phase/completion file and
heading links passed. Final content/record/evidence hashes and root-impact/
cleanup receipts are in the identified release directory.

## Reproduction and phase12 handoff

Use the current [operations commands](../../../docs/operations.md#current-release-qualification-for-deployment-testing).
Build a unique owned current operator with approved feeds, capture its immutable
ID, and pass both explicitly; never use the obsolete default5096 image or weaken
manifest/image/socket/mount/ownership guards. Exact executed selectors include
`mcp-end-to-end`, `mcp-read-contracts`, `shared-agent-controls`, `audit-origin`,
`deployment-current`, `capacity-focused`, `capacity-query`, `restart`,
`fresh-installation-current`, `mcp-container`, and `cutover-browser-contract`.
BrowserFiles must be one quoted comma-separated argument:
`"auditOrigin.spec.ts,signIn.spec.ts,savedReadLifecycle.spec.ts,packageConfirmation.spec.ts,automaticRefresh.spec.ts,agentContext.spec.ts"`.
Run `./scripts/azure-oauth-fixture.ps1 -Full` for all583/real-server evidence.
Do not provide inherited PG/APP_PG/TENANT/CLIENT/SESSION or Docker authority.
Each existing fixture owner cleans its own exact disposable resources.

The final connected-owner arguments used these exact identities; its helper
has since been removed, so this is an execution record, not a runnable stale-tag
recommendation:

```powershell
& /Users/candede/.dotnet/tools/pwsh -NoProfile -File scripts/large-tenant-tests.ps1 `
  -Suite mcp-end-to-end `
  -BaselineImage agent-control-release11-ae8b2098a330-operator:local `
  -BaselineImageId sha256:753189dac0ce9eee3b7db8bd57d956bf8626fb5828fbcfa615129ae612b03d53
& /Users/candede/.dotnet/tools/pwsh -NoProfile -File scripts/azure-oauth-fixture.ps1 -Full
npm test --workspace backend -- scripts/security-scan.test.mjs src/routes/authHttp.test.ts src/services/temporaryAgentSharingDiagnostic.test.ts
npm run typecheck --workspace backend
npm run check:unused
node backend/scripts/security-scan.mjs
mcp/.venv/bin/ruff check mcp/src mcp/tests
mcp/.venv/bin/ruff format --check mcp/src mcp/tests
mcp/.venv/bin/mypy --config-file mcp/pyproject.toml mcp/src
```

The Azure fixture owner requires the exact emulator image already present; it
does not silently pull/install it. This task's copy was removed during cleanup.
For a separately authorized rerun, **only if that required image is missing**,
restore this exact public artifact, then run the owner:

```powershell
docker pull mcr.microsoft.com/azure-storage/azurite@sha256:647c63a91102a9d8e8000aab803436e1fc85fbb285e7ce830a82ee5d6661cf37
```

Do not probe other registries/tags, introduce public npm/Python indexes or use a
test image as production-content evidence.

Normal target commands below are **handoff only**, not executed or authorization
to start a configured project. Supply an exact separately authorized local
project and protected MCP configuration under the existing setup contract:

```powershell
./deploy-local.ps1 start -Project $authorizedProject
./deploy-local.ps1 check -Project $authorizedProject
./deploy-local.ps1 edit-config -Project $authorizedProject -McpConfig $protectedMcpImport
./deploy-local.ps1 start -Project $authorizedProject
./deploy-local.ps1 stop -Project $authorizedProject
```

There is no `-DbReset` in ordinary recovery. API/web remain independent of MCP.
Stop the exact project before coherent encrypted-state backup; retain original
binding, volume identity and separately protected independent signing/encryption/
confidential material. Import a new encryption ring with old material retained,
then normal `start`; retire old keys only after reconnect/expiry/required record
rewrites. Signing rotation requires reconnect, not a database/OAuth reset.
Restore only verified same-binding private0700/0600 state; do not silently replace
missing/corrupt/undecryptable state. API credentials remain ephemeral.

| Unavailable or failed evidence | Operating owner and safe next action |
| --- | --- |
| Real vendor clients/accounts/public synthetic endpoint and model-selected workflows | Client/identity test owner: separately authorize the exact client, callback, account and endpoint; no paid calls, login, new ingress or private-account probing occurred here. SDK success is not vendor certification. |
| Actual Entra native/guest home-account/OBO/consent and ephemeral-cache loss | Identity/API owner: use approved test principals and exact delegated scope; verify home-account mapping, roles, denial, fresh same-account reacquisition and eligible unsent resume. Do not replay sent-unknown writes. |
| Live provider RBAC/private prestate/write/readback | Provider canary owner: authorize one exact owned target/prestate; fresh current preview/receipt and stable operation key; poll canonical child/receipt/readback. Unknown outcome means read-only reconciliation, not another execute. |
| Canary restoration | Same owner: reverse only a verified own change with unchanged known prestate and no external conflict, using a **fresh reverse-action preview/receipt**. Never blindly invert mixed/already-blocked/uncertain batches. |
| Azure App Service/UAMI/real Blob lease/replacement/networking | Azure deployment owner: separately authorize the actual target/amd64 artifact, identity/RBAC/networking and SDK lease/ETag recovery tests. Emulator/Bicep/mocks are not cloud proof; do not revive the rejected NFS design. |
|100k PostgreSQL resource criteria and full production capacity profile | Capacity/operations owner: preserve the failed measurements, diagnose cache/SQL/resource pressure and measure the existing approved deployment tier with the exact intended complete workload. Any material tier change needs separate authorization, not a deferred architecture choice or a raised ceiling to manufacture acceptance. Do not block unrelated ordinary reads. |
| Host-bound private-file permission refusal | Local operator: preserve fail-closed private ownership checks and inspect the exact volume/UID/modes on a recurrence. Unit scratch is now Linux tmpfs; actual durable state still has its independent real-volume proof. |

Phase12 receives exact current artifacts, normal start/check/stop/recovery,
case-specific external proof and provider-canary restoration responsibilities.
Observation workload/signals are operator-selected: caller/target/principal
isolation, authorization/lease loss, response bytes/deadlines,4/8/2 admission,
503 recovery, SQL/query fanout, CPU/memory/PIDs, current origin, job uncertainty
and readback. No universal observation duration, blanket cloud/provider pass,
additional application approval system or unresolved architecture choice was
invented. Phase12 and production convergence were **not executed**.

## Parent-found source-packaging repair — current handoff supersedes earlier artifacts

Bounded same-phase repair, **2026-10-17**, actual **GPT-6.1 Sol / xhigh**,
without nested agents. Parent owns campaign state; no campaign/phase12 edit,
commit, push, branch or live action occurred. The earlier artifact/current-source
statements above are historical, not the current release identity.

**Cause:** `Get-LocalSourceFiles` excluded other generated directories but not
TSX's `tsx-<numeric uid>` cache directories. Five **pre-existing tracked** files
therefore entered the old922-input manifest. A parent host test purged three;
the frozen922 still matched their original hashes. The parent restored those
three byte-for-byte. This repair neither deleted nor untracked any of the five;
all five were checked against the old frozen manifest before retirement and
remain unchanged. The old complete922-file frozen inventory was also rechecked.

**Existing-owner fix:** `scripts/local-runtime.ps1` now excludes numeric TSX cache
path components regardless of tracking. `.gitignore` and `.dockerignore` exclude
generated UID directories without excluding `.ts`/`.tsx`, `tsx-source`,
`tsx-123-source` or `tsx-123.ts` source directories. Docker's glob language has
no digit-repetition operator; exact1–10-digit OS-UID patterns avoid a broad
numeric-prefix exclusion and the demonstrated recursive-negation bug that
reopened ordinary-named children inside a cache. The existing Azure
`backend/scripts/package.mjs` collector skips numeric-cache directories;
`release-inspect.mjs` rejects them in ZIPs and `production-inspect.mjs` rejects
them in production trees. Azure's existing Docker `package`/`export` stages
still obtain runtime payload exclusively from compiled build/runtime and pruned
dependencies; no alternate packager, application-domain change or runner was
introduced. The current operations runbook was updated **before freezing**.

The one repository/application boundary was traced: local snapshot/build,
Docker test/production/package stages, Azure ZIP collector/inspector and
production content inspection. Backend/frontend/MCP domain, protocol, SQL,
configuration and authorization code were unchanged; no other application root
needed edits.

### Newly executed focused proof

| Actual owner / command | Result |
| --- | --- |
| `pwsh -NoProfile -NonInteractive -File scripts/local-runtime.tests.ps1` | **352 assertions passed**; actual isolated Git tracked/untracked cache fixtures, ordinary source inclusion, all OS-UID Docker patterns, content/inventory race refusal and existing candidate-integrity guards |
| `... -File scripts/local-deployment.tests.ps1` | **1375 assertions passed**, mocked orchestration, no deployment |
| `... -File scripts/local-mcp.tests.ps1` | **67 assertions passed**, mocked lifecycle |
| `... -File scripts/azure-deployment.tests.ps1` | **302 assertions passed**, including **six actual checksummed ZIP inspector cases**: numeric caches rejected; ordinary source paths accepted |
| Actual `docker build --network none --provenance=false --output type=local,...` with repository `.dockerignore` and isolated tracked/untracked synthetic context | **6 ordinary sources preserved /15 cache paths excluded**, including all1–10-digit widths and an ordinary-named nested cache child |
| `npm test --workspace backend -- scripts/security-scan.test.mjs` | **6 tests passed**, one file, zero skips |
| `node backend/scripts/security-scan.mjs` | **passed**,854files /17102168bytes,312development dependency licenses,194runtime files; existing source/raw-secret rules unchanged |
| Current/frozen exhaustive inventories and SHA256 | **917 /917 files**, all **1834 hashes matched**; zero linked/external/numeric-cache inputs |
| Current source/lock/effective-feed checks | **passed**; npm approved registry,522lock entries,0HTTP resolved URLs;98Python registry entries and710credential/query-free approved Microsoft artifact URLs |
| Actual old/new production content and policy checks | **passed**; complete layers/config plus independent byte/UID/GID/mode/symlink inventories match, actual non-root UIDs1000/10001 and approved runtime feeds verified |
| Focused syntax/editor/diff/link checks | **passed**; six PowerShell owners, three Node packaging/inspection scripts, editor diagnostics,46local file/heading links, tracked `git diff --check` and58untracked source/completion whitespace checks |

These are overlapping scopes, not a new aggregate. No host SQL suite is claimed:
the parent's earlier selected host run remains **67 passed /5 isolated-DB guard
failures**. Parent-reviewed23capacity-parser, six scanner and15selected
MCP/container-envelope checks remain distinct prior proof. The earlier583Python,
SQL647reads/695controls/1008capacity-focused,5150frontend/60Chromium and actual
SDK-to-HTTP/SQL26cases/12receipt scopes were **not repeated**.

### One current canonical release and exact retained content

Current receipt directory:
`artifacts/fastmcp-release-qualification-11-packaging-49d8df58c2ad/`.
Owner `ac-mcp-release11-packaging-49d8df58c2ad`; purpose
`fastmcp-phase11-source-packaging-deployment-testing`.

- **917-input source manifest SHA256**:
  `cdbfd6922afea37b2a6e651ffad4d529258e5728cbd2814e65a187560685f848`.
- **New frozen inputs**, created by the existing `New-LocalBuildSnapshot` owner:
  `artifacts/local-builds/51e2d084729f43cb8eecee53f68a4d13/source`.
- **New application image**, built by `Build-LocalArtifact`, target `runtime`:
  `agent-control-release11-packaging-49d8df58c2ad-app:local`,
  `sha256:59faddb782d6368a5edaf136b6b2a6608943be97792c0e25aad19564143c2633`.
- **New MCP image**, same existing build owner with frozen `mcp/Dockerfile`,
  target `runtime`:
  `agent-control-release11-packaging-49d8df58c2ad-mcp:local`,
  `sha256:180e3a3fa2f8629346e45d7f614bc1686f81925a529d0361864f9e5b0e3de5df`.

Both final images are **linux/arm64**, local deployment-testing artifacts, not
published Azure/amd64 images. Actual tag/immutable-ID bindings and all three
`io.agent-control.source-sha256` /`owner` /`purpose` labels were re-inspected.
The IDs are newly built content identities, not old images relabelled in a
receipt. The initial offline-network build missed cache and failed approved-feed
DNS; no public fallback or dependency/manifest change was made. Reusing the
existing normal-network **exact BuildKit cache** succeeded, with package-install
layers cached. Failure logs remain. A metadata-label normalization rebuild
replaced two intermediate identities, already absent after tag replacement.

`runtime-content-equivalence.json` and `production-image-inspections.json`
compare both actual qualified old IDs with the new IDs: **all RootFS layers
identical**, and complete runtime configuration identical except the explicitly
listed source/owner/purpose metadata labels. Independent actual-container
inventories additionally hash file bytes, UID/GID, modes and symlink targets:

- Application:7968entries /7467files /58561762bytes,
  SHA256 `e9068d035a10ac537efe14800aa0e33be7c8e0508da35374d31ef0e9969c6c75`.
  All127distinct production package identities/licenses match the qualified
  receipt (128installed occurrences, one duplicate identity). Legacy npm
  `licenses` metadata is accounted for, not mistaken for an absent license.
- MCP:5012entries /4297files /75135782bytes,
  SHA256 `4e874284855f03d6aa40284835e35f4a57636e37e61194eac37e8a1f46ca9f40`.
  20production modules /86installed distributions; test/development/SQL
  tooling absent; license metadata and actual cap-drop/no-new-privileges pass.

Thus the previous real journeys/recovery/envelope evidence is explicitly
**reused by runtime equivalence**, not called a new execution. In particular
actual SDK/SQL envelope C remains511186bytes and the unchanged4MiB workflows
retain their prior proof. No new runtime checks of unchanged domain behavior,
capacity cap, deployment tier, approval file or feature gate were introduced.
The100k PostgreSQL memory/cache failure, full-profile inconclusive scope and
all unavailable client/provider/Azure proof above remain **failed/inconclusive/
unavailable**, never a pass. They do not block unrelated ordinary local
deployment testing or supported reads.

### Exact cleanup and historical status

After the new source/image/equivalence proofs passed, retired exactly the two
old owner/source/purpose-verified production image IDs and the old
`cbb0433f6c8141e1b1912d367189d2ae` frozen directory. Four exact synthetic Docker
context/output directories were also removed. Two replaced intermediate image
identities were already absent; the first cleanup's exact not-found refusal
and corrected final accounting are retained. No force/prune/global temporary
directory, broad-root deletion or unrelated resource operation occurred.
Final complete container/network/volume/image identity sets were unchanged
during the remaining cleanup; only the explicitly guarded old image IDs were
removed in its preceding stage. Original tracked cache hashes still match.
Parent `.local/parent-phase08-container`,09protocol,10config and11envelope
scratch, all unrelated bases/cache/resources and prior capacity/receipt
diagnostics were left alone.

The old `artifacts/fastmcp-release-qualification-11-ae8b2098a330/` ledger remains
intact **as history**, with `historical-status.json` explicitly identifying its
expired snapshot reference and this replacement. Its old image IDs and frozen
snapshot are **not current retained deliverables**. Current
`retained-deliverables.json`, `source-integrity.json`, `cleanup.json`, content/
feed/original-cache receipts and focused logs identify the **two new final
production images plus one new frozen artifact** ready for separately
authorized deployment testing. HEAD and protected parent campaign/phase inputs
remain unchanged. No phase12 execution or production/live action is asserted.
