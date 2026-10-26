# FastMCP implementation campaign

## Scope, target and authority

- Plan folder: `plans/fastmcp-integration` in
  `/Users/candede/repos/agent365/agent_control`.
- Application/repository roots: this repository only; backend, frontend and the
  new MCP package are one application boundary.
- Original request: review the shared API/web foundation, then implement05.
  That requested slice completed locally; its proof and history remain below.
- Continuation authorized2026-10-17: **all remaining implementation and
  verification needed to make the application ready to deploy for testing**.
  Continue sequentially through06-11 and prepare12's release handoff; do not stop
  after each phase. Every subagent must use GPT-6.1 Sol / xhigh.
- Execution environment: local source changes and local synthetic validation.
  Read the existing isolated-test runbooks and verify their exact target/action
  safeguards before any disposable-environment operation. No production/live
  deployment, customer/provider mutation, remote resource, registration/grant,
  ingress, production reset, commit, push or branch action is authorized.
- Roadmap production target remains current-host Compose project `seha`.
  This planning target does not authorize actions against it. Deployment owners
  were exercised only in the separately bounded disposable local fixtures.
- No historical completion records existed. The initial worktree was clean;
  source revision is `d3a82a8d7673cb55300b6ab30fc3848d40554015`.
- State: **ready_for_local_deployment_testing**; actual live release remains
  **deployment_pending**. Phase05 content/contract hashes were
  revalidated unchanged; its104 Python/176 API proof is retained rather than
  blindly replayed. Existing worktree changes are prior-campaign work.
  No user acceptance or runtime feature-enable gate is introduced.
  No production revision has been accepted or deployed here.

## Stable ordered manifest

Order follows the README links. All phase files exist and are unique.
Completion paths below are relative to this folder; prompts are in its parent.
Supporting documents and the foundation review are not executable phases.

| Position | Prompt | Completion record | Dependencies | Status |
| --- | --- | --- | --- | --- |
| 1 | `04C-api-webapp-production-release.md` | `04C-api-webapp-production-release.md` | Current API/web source and exact live authorization | deployment_pending; live outcome unverified, outside current request |
| 2 | `05-fastmcp-service-and-auth.md` | `05-fastmcp-service-and-auth.md` | Current shared API/auth contracts | complete locally |
| 3 | `06-mcp-read-tools.md` | `06-mcp-read-tools.md` | 05 | complete locally |
| 4 | `07-mcp-agent-controls.md` | `07-mcp-agent-controls.md` | 05, 06 | complete locally |
| 5 | `08-local-container-integration.md` | `08-local-container-integration.md` | 05, 06, 07; existing deployment owner | complete locally and in isolated containers |
| 6 | `09-client-workflows-and-evaluation.md` | `09-client-workflows-and-evaluation.md` | 06, 07, 08 | complete for local synthetic scope; live clients unavailable |
| 7 | `10-azure-deployment-integration.md` | `10-azure-deployment-integration.md` | 05, 08, 09 | complete source/SDK/emulator scope; actual Azure unavailable |
| 8 | `11-release-qualification.md` | `11-release-qualification.md` | 05-10 | complete for controlled local testing; 100k capacity criteria failed, production profile unqualified |
| 9 | `12-production-convergence.md` | `12-production-convergence.md` | 08-11; exact live authorization | testing handoff complete; actual live deployment_pending |

The live 04C outcome is not claimed. README/05 explicitly make historical
release/acceptance records non-prerequisites to MCP coding; 05 depends on the
current API contracts, not a fabricated 04C deployment receipt.

## SHA-256 contract identities at setup

| Contract | SHA-256 |
| --- | --- |
| `README.md` | `40fdb91510ba7d8a8c0c844bf3bf0405f87384aaf214c829cb0ccfee8561ad71` |
| `04C-api-webapp-production-release.md` | `e2c64a4f737a8fe6ff9960be563325773e03ec8803d2f2d11340fd8be3ae59ad` |
| `05-fastmcp-service-and-auth.md` | `9cabaf0aa231dba5445d1796ac7c0960dca104610bab76c84fe5793ed7a4a445` |
| `06-mcp-read-tools.md` | `e1e3e8a6b85b55906c99bd82075653d6bf8779bfe47a149ef2e13abe264caf0e` |
| `07-mcp-agent-controls.md` | `9b232673b0aee7ba53ed45208febe2f4a457cde4a8bbbbeb9087d07c5ac8b767` |
| `08-local-container-integration.md` | `fd470e5a9936e433d04e04ab3782c24b01438300d55dec78f6cf7913c9c07364` |
| `09-client-workflows-and-evaluation.md` | `d636986b34a2f5459e5b71d9b94206e05f39f5d11635b998fb716fa8129008d2` |
| `10-azure-deployment-integration.md` | `c394f729d0575c70d420aa813dac4d3b3ff826d87d819c53d07885459f033cd0` |
| `11-release-qualification.md` | `b5ba6f2d8108a4e3a5f1b0e3800b803e0547f2b18f41a8aad6ea3156b775d41d` |
| `12-production-convergence.md` | `271cc5ab3b99763422caf730f37a9e3f9a316d859c5393e04c3d1b06a6691321` |
| `../../docs/mcp-integration.md` | `461c029acac169b632c3c5f48a9c292a6e559be43e643ab33287a373edf0d03a` |
| `../../docs/security-model.md` | `4886c286d31482fab36b98e982fd34cc8127dd5b3db9f29a2ded1f0ea2824a1f` |
| `../../docs/data-architecture.md` | `8e0976f43498a8653faebfd97918c82fd7d0d24c7e41ad710b10e1f9eb503279` |
| `../../docs/deployment-setup.md` | `6d2eb95ec3823087d3dd30af410c03cc1b2dd7f5f7fafb58cec25160c9262553` |
| `../../AGENTS.md` | `eb9bb2400afb49e5500666234b385facde6cdbba874285e0f51d90c5a5d8a81e` |

Changed shared contracts must retain these original identities and add their
new identities with affected-proof revalidation; do not overwrite history.

## Parent decisions and review

1. [Foundation review](API_FOUNDATION_REVIEW.md): the common registered-handler,
   principal, route/policy, browser parity and origin foundation is present.
   Seven local suites / 176 cases passed; actual SQL and live journeys remain
   unverified. No application-source prerequisite repair was identified.
2. Use FastMCP's supported pinned OAuth provider/token context and maintained
   encrypted storage. One fixed tenant/API binding and one API adapter owner.
   No custom cryptography, domain calculations, provider clients, SQL access,
   scheduler, business tools or duplicate route map in phase 05.
3. The maintained SDK must be inspected and executed against synthetic
   credentials; do not pretend its reference JWT is an Entra OBO assertion.
   Verify the documented 4.1.0 pin against the approved package feed.
4. Only approved npm/Python feeds are permitted in every subprocess.
   Dependencies may be installed after a new manifest/lock or a real missing
   tool failure, never via a public fallback.
5. Worker launch requires explicit model `gpt-6.1-sol`, reasoning effort
   `xhigh`, as requested by the invoked skill and repository instructions.
   One implementation worker, no nested/review pool.
6. Parent integration review retained the narrow SDK guards justified by actual
   executable behavior and repaired two concrete owned findings: challenge
   forwarding now matches the canonical API's access-token-only field/value
   grammar, and readiness handles expected storage errors with a safe operator
   log instead of a silent catch-all. Ten added regressions and the complete
   affected aggregates pass.
7. Runtime flow is now SDK OAuth -> verified upstream MCP assertion ->
   API-audience delegated OBO -> the existing canonical API -> typed bounded
   result. The three named adapter reads are not business tools. SDK encryption
   and exact binding/revocation guards are necessary; no domain logic, second
   writer, new application database or compatibility implementation was added.

## Validation and environment actions

- Editor `runTests`: no tests discovered; use existing Vitest CLI.
- Foundation check including `services/auditOrigin.test.ts`: seven suites /
  176 cases passed; one suite unavailable at isolated-database guard, six skipped;
  overall exit 1. Exact command is in the foundation review.
- Real-SQL read/control/origin checks attempted; unavailable at the same guard.
- Database-independent rerun of the seven foundation suites: 7 suites /
  176 tests passed, exit 0.
- `npm run typecheck --workspace backend`: passed.
- `npm run check:unused`: passed.
- `git diff --check`: passed at the foundation-review boundary.
- No environment lifecycle or live actions performed.
- Runtimes observed: Node `v24.18.1`, Python `3.14.6`.
- Final phase05 Python checks:104 cases passed, no skips,11.74s; offline lock
  resolves82 packages; Ruff/format clean on14 files; strict mypy clean on10
  source files.
- Final affected API checks:7 suites /176 cases passed, no skips,3.00s.
- Final backend typecheck, Knip and diff hygiene passed.
- Final local documentation target check:48 links across7 changed/review
  documents; explicit untracked package/record whitespace check:19 files clean.
- Exact owned `.local/mcp-tests` scratch removed and absence verified.
- Real SQL remains unavailable; live Entra/client/provider/container/deployment
  evidence remains not run/not authorized, not passed.

## Worker and parent completion

- Agent ID: `58bebec7-8e53-4d42-bf2b-d852b3bd397b`.
- Phase: 05 only; `general-purpose`, background, one fresh context.
- Actual explicit launch parameters: `model: gpt-6.1-sol`,
  `reasoning_effort: xhigh`.
- Parent source-only foundation checks are complete. No concurrent application
  edits by the parent; the worker owns phase implementation and its phase record.
- Worker returned complete local implementation. The parent then performed the
  required integration review and the bounded same-phase repairs above.
- [Phase05 completion record](05-fastmcp-service-and-auth.md) contains the actual
  settings, SDK guard rationale, producer/consumer impact checks, commands and
  both worker-handoff and final content identities.
- Changed repository: this repository only. Changes comprise the new Python
  package/tests/lock; related setup/security/API/root documentation; one coupled
  obsolete documentation assertion in the existing feasibility test; cache
  exclusions; and campaign records. Backend/frontend runtime/DTO/routes and
  deployment configuration remain unchanged.

## Final content identities and proof invalidation

Original setup hashes remain above; final hashes for changed contracts are:

| Contract/artifact | Final SHA-256 |
| --- | --- |
| `../../docs/mcp-integration.md` | `0692db114738cd770b757584761d898c1c40e0214edc095871859e426e05fc1e` |
| `../../docs/security-model.md` | `9e91116d7722088543769e68fef17946e5eef98718f3473fa7fcfdc2fbafdc03` |
| `../../docs/deployment-setup.md` | `9277e6a4ab2ddf67a4d8f685481c25c94be99ed1d3b54695f66b79edef3c3af6` |
| `../../mcp/pyproject.toml` | `3a2f2047d79c94ba8e0e32102bc96ea8e36832c724f428e4b73859a814a5bf4b` |
| `../../mcp/uv.lock` | `ade31dbba896add3e8239694565477b6716b4a1d86da0e35f324e59a84b24864` |
| Package aggregate,16 files, algorithm in phase record | `659504d1ad6a4ae6abaa6b3aec548b7af98a4ceab9e7cdfea7c10bde9791c8cd` |

The assigned prompt, ordered manifest, binding roadmap and data architecture
hashes are unchanged. The changed documentation describes implemented phase05,
not a changed API authority or wire contract. Revalidated Python/API parity and
type/dead-code checks cover the changed assertions and adapter boundaries; no
live proof or unavailable SQL proof was silently inherited.

## Current action and resumption

The requested local phase05 outcome is implemented and verified; no commit,
push, deployment or live mutation was performed. The Python environment and
dependency cache remain ignored for repeatable checks; owned synthetic test
scratch is cleaned after verification.

Continuation is now authorized: phase06's named read/refresh/investigation
tools are complete; implement07 controls,08 packaging/local lifecycle,09 client
workflows,10 Azure source tooling and11 integrated verification. Review/repair
each owner and advance autonomously without an after-phase user pause.
Prepare12's exact deploy-for-testing handoff and explicitly retain live
deployment/consent/provider proof as pending where not authorized/available.
Do not convert unavailable integration evidence into a readiness claim.

## Continuation progress

### 06 complete;07 active

- Fresh synchronous `general-purpose` worker launch explicitly used
  `model: gpt-6.1-sol`, `reasoning_effort: xhigh`; no nested agents.
- [06 record](06-mcp-read-tools.md):96 concrete typed tools, same canonical
  API methods/DTOs, explicit provider operations, no controls or domain logic.
- Worker proof:339 Python cases;176 API cases;473 frontend cases; both Node
  typechecks, Ruff/format/strict mypy, Knip/offline lock and links passed.
- Parent reviewed catalog registration, canonical request dispatch, endpoint
  wire validation, one-page/source continuity and final-envelope accounting.
  No owned defect was identified. Discriminating rerun:27 cases passed,
  208 deselected (`canonical_input_method|final_protocol_output|
  source_references|finite_inputs`),1.31s.
-06 package aggregate,24 files:
  `0fa1d8a7b72f88f8b6548956afc03989c8a1b0e80371a64d5dd51c15f5da8a6c`.
  Current shared hashes are preserved in the06 record; later phase changes
  revalidate affected proof rather than rewriting historical identities.
- Local test tooling is available: PowerShell and Docker Desktop context
  `desktop-linux`, engine29.8.2. Read-only discovery changed no infrastructure.
  Before isolated tests, confirm its local endpoint, pinned image/toolkit and
  unique project/resource/volume ownership safeguards. Production remains
  unauthorized and must not be used as the test environment.
- Exact next action: implement07 on the existing catalog/API owner, then
  continue08-11 and release-for-testing handoff without an after-phase pause.

### 07 complete;08 active

- Fresh synchronous GPT-6.1 Sol / xhigh worker; no nested agents.
  [07 record](07-mcp-agent-controls.md) preserves exact launch/content proof.
- Added28 typed control tools;124 total. Generic Studio and explicit package
  effects remain distinct, exact receipts/idempotency/current lifecycle origin
  are forwarded, and uncertain mutations are not automatically replayed.
- Worker proof:501 Python,697 API and536 frontend cases passed, static/type/
  dead-code/lock/link checks clean. Parent reviewed control inputs, canonical
  route/body/header dispatch and annotations, including source count semantics;
  no unsupported restriction/duplicate state owner was identified.
- Parent discriminating check:44 control cases passed,62 deselected,3.03s
  (`canonical|malformed_api_boolean|control_inputs|connection_revocation`).
-07 package aggregate,28 files:
  `00b805c53747200ec59daefcc12c43b50a95878cb5745153831611e8d06ae81d`.
- Local isolated-test boundary is now resolved from the checked-in operations,
  large-tenant runner and Compose fixture owners: Docker context `desktop-linux`,
  endpoint `unix:///Users/candede/.docker/run/docker.sock`, baseline image
  `agent-control-scale-5096-operator:local` exactly
  `sha256:78f3cb9fa91e7a64960699899d8fe2eb56bdd77c8ee56490f1f5255855b3c235`.
  Under the user's implementation/testing-readiness request, existing local
  purpose/ownership-guarded disposable fixture actions are allowed. Use only
  unique `agent-control-ltdp-<guid>` or explicitly guarded MCP fixture projects,
  their own generated synthetic config, ports, containers/networks and volumes.
  Existing runner image/manifest guards, inherited-authority rejection, exact
  mount checks, ownership verification and targeted cleanup remain mandatory.
  Never touch `seha`, `.local/seha`, production volumes/mounts/configuration,
  inherited customer credentials, live Entra/provider endpoints or remote Docker.
- Next:08 implements and verifies container/local lifecycle with this bounded
  disposable environment;11 must revisit earlier SQL-unavailable proof through
  the existing isolated runner. No production/cloud/ingress action is authorized.

### 08 complete;09 active

- Fresh synchronous GPT-6.1 Sol / xhigh worker, no nested agents.
  [08 record](08-local-container-integration.md) preserves exact source/image/
  fixture identities, repairs, commands and cleanup evidence.
- Optional Compose and pinned non-root runtime/test images now extend the
  existing local setup/build/start/stop/check/recovery owners. Separate public
  identity/internal API transport, protected independent secrets and one
  dedicated encrypted OAuth volume retain API/web independence.
- Actual Docker Desktop restart changed bind-root ownership; the failed bind
  design was removed. An empty-root-owned-volume-only, secret/network-free
  initializer plus strict non-root service is the verified replacement.
  Parent reviewed image/Compose, exact local Desktop mount equivalence,
  retained-container cleanup guards, volume ownership and lifecycle integration.
- Worker proof:514 Python cases;104 real image cases;1,869 mocked PowerShell
  assertions;388 backend/14 suites and548 frontend/5 suites; empty/current/
  incompatible-schema refusal, backup/restart/reset in exact disposable target.
  No production first-sync/provider result is inferred.
- Real MCP fixture
  `artifacts/large-tenant-data-platform/5a4950f2d80a44e1bc702110ac230828`:
  ten authenticated OAuth/restart/rotation/revoke/reconnect journeys;
 124-tool catalog; authority/Host/Origin and permission denials; authenticated
  drain3.072518s;157.13MiB observed memory peak under512MiB/0.5CPU/128PIDs.
  SQL/fresh-installation evidence is in the08 record. This supersedes only
  corresponding earlier unavailable checks, not every unrun SQL/browser case.
- Parent reran67 local-MCP PowerShell assertions and13 container contract cases
  successfully. Final cleanup evidence independently confirms all nine exact
  MCP fixture projects and task-owned images/state removed; original baseline
  retained. Parent-created test scratch is owned and cleaned at campaign end.
- The original supplied operator has mismatching manifests and was correctly
  refused. A current operator was built/verified through approved feeds and
  removed after fixtures.11 must rebuild/source-bind a current operator, not
  bypass the pinned manifest guard or depend on a removed tag.
- Next:09 synthetic client workflows and current onboarding evidence, then10
  source-only Azure tooling and11 aggregate deployment-for-testing readiness.

### 09 complete;10 active

- Fresh synchronous `gpt-6.1-sol` / `xhigh` worker; no nested agents.
  [09 record](09-client-workflows-and-evaluation.md) SHA-256
  `f300d5f496a799205da405657199833e11fb9768ccdd6320244bca8af856a23f`.
- One shared synthetic corpus exercises canonical SQL handlers, actual browser
  adapters and SDK HTTP clients. Complete relationship/About/champion/report
  pages, exact source identities, ambiguous/unknown evidence and inert malicious
  descriptions stay API-owned. No production workflow/evaluator framework or
  domain implementation was added.
- Parent reviewed measured actual protocol/browser traces, shared SQL corpus
  projection, event-controlled interactive confirmation/reconfirmation and
  current-receipt scheduled execution. Nine discriminating parent cases passed.
  Interactive-client policy is observed in deterministic fixtures, not falsely
  claimed as universal model/vendor behavior.
- Worker:541 final Python cases;214 database-independent API cases;647 read SQL
  cases/18 files;695 control SQL cases/24 files;5,150 frontend cases/118 files;
  types/build/lint/Knip/lock/links passed. SQL scopes overlap and must not be
  summed as unique cases. Earlier corresponding SQL-unavailable proof is now
  superseded by these isolated executions, not by a host database fallback.
- Complete A/B/C workflows measured respectively18/6/3 actual tool calls and
  338,956/53,436/386,446 JSON bytes; each met32calls/4MiB/180s bounds.
  Actual provider/model/client timing remains unknown.
- Current primary-source onboarding distinguishes each vendor/surface, edition,
  exact DCR callbacks, resource/scopes, refresh and reconnect. Twenty public
  primary URLs checked. No authorized real-client accounts/public endpoint or
  provider canary exists; those checks remain unavailable, not passed.
- All three exact SQL fixture projects and four task-owned operator tags were
  cleaned. Parent protocol scratch remains task-owned until final cleanup.
  No production resources, registration/grants or paid model calls were used.
- Current shared contract hashes:
  `docs/mcp-integration.md` =
  `437b482813f6b60362561ad8b2a47f4a5c9b132df652ada21044e8fec8e645e9`;
  `docs/security-model.md` =
  `25177b33f9633165f7cdfa79b6475e76c70401628d4b3e38e9337d8fb7a3c036`;
  `docs/deployment-setup.md` =
  `f6da221cd2c208db60d1edce33c4d30090649e27c4288717d04fa6a3f7502d2f`;
  new `docs/mcp-clients.md` =
  `39636e2d271e92dab74d976bdf85ae63a1a20e58d8b057176e91a62563f89bf6`.
- Next:10 extends existing Azure owners with optional MCP support and local
  source/mock validation only. No Azure provisioning, remote what-if, registry
  publication, secret/account access or topology/cost change is authorized.

### 10 parent review and bounded repair decision

- Initial10 worker implemented/verified optional Azure tooling and identified a
  genuine design gap: one App Service worker and owner-managed stop-before-
  update do not fence an old writer during platform-initiated replacement.
  A private NFS/POSIX mount proves neither that exclusivity nor safe concurrent
  authorization-code consumption/revocation. The initial source profile is
  not accepted as a deployable Azure implementation.
- Parent resolves this within the approved OAuth-connection-state boundary:
  replace the unreleased Azure NFS candidate with one bounded encrypted state
  blob using maintained Azure SDKs and server-enforced blob leases. All state
  writes must carry the current lease; stale/lost ownership fails closed.
  Use explicit managed identity and exact private account/container/blob binding.
  Preserve maintained record encryption, existing retention/capacity limits and
  local FileTree behavior. No business data/provider/database state moves.
- This is a narrowly justified hosting adapter, not a generic state platform,
  application scheduler or second authority. Remove the superseded NFS target/
  mount/transport-acceptance path instead of keeping dual cloud storage paths.
  No cloud action/resource/cost is approved by this source decision.
- A fresh bounded same-phase repair context may implement this substantial new
  storage slice; it is not a second review pool or repeated speculative audit.
  Keep10 active;11 awaits its source/mock/local proof. Actual Azure qualification
  still requires exact target authorization and remains unavailable.

### 10 accepted after fencing repair;11 active

- Initial implementation and bounded repair both launched synchronously with
  explicit `gpt-6.1-sol` / `xhigh`; no nested agents. The final
  [10 record](10-azure-deployment-integration.md) preserves the superseded NFS
  finding and final implementation, SHA-256
  `835d51f1fc4c74c37692e410c6e877b15e77f4bbd82eb58956730f09ab00b701`.
- Parent reviewed the entire bounded Azure state adapter, local/Blob selection,
  startup/renewal/shutdown lifecycle, exact-data-object lease/ETag writes,
  uncached encrypted reads, failure/publication barriers and Bicep/runtime
  identities. The old NFS cloud path was deleted. Explicit managed identity,
  maintained Azure SDKs and one encrypted connection-state blob are justified
  by the demonstrated platform-overlap gap, not speculative scale/reuse.
- Final worker proof:580 Python cases with zero skips, including21 real SDK/
  Azurite cases. Actual stale-writer write rejected by storage server with
  HTTP412 after lease expiry/replacement. Lost/ambiguous authority, corrupt
  state, capacity, cancellation, OAuth/revocation and publication tests pass.
  300 Azure mock assertions;2,169 total existing-owner mock assertions;
  214 backend cases; types/Knip/Bicep/links/static/lock checks passed.
- Parent reran300 Azure assertions plus focused local/config/container cases:
  passed. No new local lifecycle/image/actual-client proof is inferred from
  source mocks.20 production Python modules and99 locked packages now require
  fresh image qualification in11.
- Required SDK dependencies were manifested before installation; all Python
  resolution used the approved feed. Current `mcp/pyproject.toml` =
  `952856a74f7615843e26ff88ed015337c16eef95f12c0f8082fb08d99485c562`;
  `mcp/uv.lock` =
  `1af5397abd83f1bcfe63f26c61dce7c3e071bb776e5e88e27e9c6cd66f71941c`.
- The grounded10 prompt amendment preserves the original hash above; current
  SHA-256 =
  `955c7a8b8171493567cdce8e13bd801e1a023a5700ec92ba7b4073ca51602d91`.
  Runtime/storage/tooling proofs were rerun under the new contract; no manifest
  denominator or approved action/resource/cost boundary changed.
- Current shared hashes: API map
  `8c5d8fc8ebb3d4071bc88a63e05caa715ddad539fa10607b456d1e2b69e5fd9b`;
  security
  `7a49691ba371fa3713f82afd12d65cb6def41208339c2a8098bf74a48e36b4f9`;
  setup
  `f9e5ed31c6b033c262fa5e41abe81e9e7f81d893091ba3af5fa7415929df987d`;
  Azure guide
  `1f01c20bd36d145be20ceecd2714599fb1458bb1efb1951f3eb98e5e1e2234c2`.
- Exact task-owned Azurite containers/networks/anonymous volumes/image and
  synthetic scratch were cleaned; evidence is
  `artifacts/phase10-blob-cleanup.json`. No cloud/production actions occurred.
- Next:11 rebuilds current source-bound images/operator and performs aggregate
  local/disposable release, recovery, parity and capacity verification. Actual
  Azure/Entra/vendor/provider evidence remains unavailable without its exact
  target/accounts/actions; that is not a new gate on local API/web/MCP use.

### 11 parent review: source-identity repair remains active

- Worker completed the functional/deployment/browser/SQL/SDK aggregate and
  explicitly retained failed100k PostgreSQL memory/cache criteria. Those
  measurements are not a production-capacity pass; controlled local deployment
  testing does not imply100k/full-profile qualification.
- Parent reviewed full-page capacity accounting, scanner regressions and the
  actual SDK-to-registered-HTTP/SQL bridge.23 parser tests, six scanner tests
  and selected exact-envelope/container checks passed.
- A broader parent host selector also hit five correctly enforced isolated-SQL
  guards (67 other cases passed); it was not a successful aggregate. The worker's
  actual isolated1008-case capacity scope remains the corresponding valid proof;
  no host/production database fallback or assertion weakening was attempted.
- Final current/frozen-source comparison found three missing **pre-existing
  tracked generated TSX cache files** after the parent host test run. All922
  frozen files still match, and exact retained images/owner/source labels match.
  Deployment input enumeration should never have included transient TSX caches.
  Preserve/restore the three task-affected original generated files byte-for-byte
  from the verified frozen artifact, then repair snapshot/Docker eligibility and
  refresh final source/artifact identities in this owning phase.
- Keep11 active until that concrete packaging defect is fixed and its focused
  owner regressions plus source/image-equivalence checks pass. Do not repeat
  unrelated functional aggregates or delete tracked prior work as cleanup.

### 11 accepted after packaging repair;12 handoff prepared

- Both the implementation and bounded packaging repair used fresh synchronous
  `gpt-6.1-sol` / `xhigh` workers, no nested agents. Parent resolved the concrete
  source-identity defect, reviewed filtering and independently matched all917
  current/frozen inputs, live eligibility and both exact final image labels.
  All five original tracked caches remain unchanged; no deletion/untracking.
- Final [11 record](11-release-qualification.md) SHA-256
  `e7a8dd1b6d4f1cffe05049d29ca235c849d5c132d1e619019dddbfa0a2db503b`
  preserves the old artifact as history and the current packaging repair.
  Current ledger:
  `artifacts/fastmcp-release-qualification-11-packaging-49d8df58c2ad/`.
  Source SHA-256:
  `cdbfd6922afea37b2a6e651ffad4d529258e5728cbd2814e65a187560685f848`.
- Frozen inputs:
  `artifacts/local-builds/51e2d084729f43cb8eecee53f68a4d13/source`.
  Final local linux/arm64 application:
  `sha256:59faddb782d6368a5edaf136b6b2a6608943be97792c0e25aad19564143c2633`;
  MCP:
  `sha256:180e3a3fa2f8629346e45d7f614bc1686f81925a529d0361864f9e5b0e3de5df`.
  Source/owner/purpose labels match. Old final images/snapshot and helper
  resources retired through exact ownership guards. Keep only the new two
  images, one frozen snapshot and redacted evidence as explicit deliverables.
- Full functional proof:583 Python/zero skips including21 real SDK/Azurite
  cases;647 SQL reads;695 SQL controls;133 origin;390 deployment-current;
  1,008 capacity-focused;26 actual SDK/HTTP/SQL cases with12 full receipts;
  5,150 frontend cases and60 real Chromium cases. Scopes overlap.
  Complete connected A/B/C =16/8/2 calls; largest C invocation511,186bytes.
  Types/build/lint/format/Knip/Bicep/dependency/license/redaction checks passed.
- Actual MCP512MiB/0.5CPU/128PID load/recovery and authenticated drain were
  measured.64 burst requests produced10 admitted/54 explicit503; recovery
  passed, sampled peak147,230,720bytes, no max/OOM events, drain3.2639841s.
  This is synthetic local evidence, not provider/cloud capacity certification.
- Packaging repair:352 runtime/1,375 local deployment/67 MCP/302 Azure
  assertions, six real ZIP and Docker filtering checks passed. Current actual
  runtime layers/config/bytes/ownership/modes/symlinks match qualified payloads;
  unchanged runtime journeys are explicitly reused by equivalence, not rerun.
- **Failed optional production-scale evidence is retained:** all10k/100k pages
  and identities were verified, but PostgreSQL charged peak1,074,098,176bytes
  exceeded1,073,741,824bytes, with8,607 memory-max events and failed80% memory/
  cache criteria. Full production capacity remains inconclusive/unaccepted.
  No cap/tier/assertion was raised or failure converted to pass. Capacity owner
  has exact diagnostics/next action; ordinary supported reads have no new gate.
- Parent prepared [12 handoff](12-production-convergence.md) and
  [04C live status](04C-api-webapp-production-release.md) directly. These are
  deployment-for-testing preparation and truthful open live status, not
  deployment receipts. No normal configuration/secret/ingress/account is
  invented and no actual `seha`, provider or Azure action is authorized.
- Final task: validate new handoff links/hygiene and persistent source/artifact
  identities; remove only four exact parent-owned synthetic scratch roots.
  Then close requested preparation scope while leaving04C/12 live deployment
  and case-specific external/capacity proof explicitly pending.

### Requested preparation complete; live action remains pending

- Parent verified23 local links across the new04C/12 records and campaign,
  with no missing file/heading or trailing-whitespace errors. Whole-root
  `git diff --check` passed. Only completion/orchestration records changed after
  the final917-input source freeze; they are intentionally outside build inputs.
- All four exact parent-owned synthetic pytest/OAuth scratch directories were
  removed; `artifacts/fastmcp-parent-scratch-cleanup.json` records zero remaining.
  No other state was touched. Exact worker fixture cleanup and intentionally
  retained production images/frozen source remain in their existing receipts.
- Final parent source/image/prompt/record verification is persisted in
  `artifacts/fastmcp-parent-final-verification.json`. It is diagnostic evidence,
  not a runtime acceptance or candidate artifact.
- Seven implementation phases05-11 have their verified local scopes recorded;
  12's deployment-for-testing handoff is complete. The full live-roadmap outcome
  is **not complete**:04C/12 remain `deployment_pending`, actual client/Entra/
  provider/Azure scopes unavailable,100k PostgreSQL resource criteria failed
  and broader production capacity unqualified. These states are not tests
  silently skipped or converted to pass.
- The agreed current outcome is fulfilled: coherent implementation, current
  verified local linux/arm64 artifacts, normal setup/start/check/recovery
  instructions and explicit limitations, ready for **controlled local deployment
  testing** once the operator supplies the ordinary authorized configuration.
  No unresolved source architecture decision, extra runtime approval gate,
  commit, push, branch, production reset or live deployment was introduced.
- Exact next action: the release operator selects/authorizes the bounded test
  target and normal protected identity/secret/HTTPS configuration, then follows
  [12's handoff](12-production-convergence.md) through the existing deployment
  owner. A production/`seha` release, real provider canary, new remote resources
  or material tier change requires its own exact authorization. Continue live
  qualification only within that authorization; do not infer it from this
  implementation-complete state.

### Post-handoff follow-up — MCP setup wizard and consumer examples

- User requested a checked-in server sample, API-style credential/key setup,
  and examples for additional consumers. Their actual clarification was
  **downstream-clients**: accept compatible MCP consumers, not `clientId: "*"`
  for the server's Entra registration or a broader API integration trust rule.
- Parent implemented the existing deployment owner's explicit `-ConfigureMcp`
  wizard and first-setup metadata import. No second configuration writer,
  dependency, runtime feature-enable gate, API/provider owner or authentication
  bypass was introduced. Ordinary projects without MCP remain unchanged.
  [08's follow-up](08-local-container-integration.md) records generation,
  persistence, binding, port, recovery, rotation and CLI behavior.
- One examples/research agent ran with **`gpt-6.1-sol` / `xhigh`**, no nesting,
  limited to the guide, six client templates and their focused tests. A
  retained-context follow-up made compatibility limits explicit.
  [09's follow-up](09-client-workflows-and-evaluation.md) and the
  [client guide](../../../docs/mcp-clients.md) distinguish VS Code, standalone
  CLI versus legacy `gh copilot`, GitHub cloud, hosted Claude versus Code,
  OpenCode, Studio authoring and Microsoft365 publication.
- Local and Azure metadata accept an explicitly configured canonical root
  callback, matching the unchanged Python runtime. No wildcard ports/hosts,
  nonloopback HTTP, reduced resource/PKCE checks or cloud actions were added.
- Current-source focused verification: **143 MCP setup/lifecycle**, **1,376
  local deployment**, **352 runtime**, **307 Azure command-level assertions**;
  **107 Python tests passed** across config/storage, OAuth, examples/onboarding.
  Scopes overlap; do not add them to prior campaign totals. Ruff/check/format,
  29 agent-verified documentation links, patch/new-file whitespace and original
  tracked TSX-cache preservation passed. VS Code's unit-test tool discovered no
  Python tests; the existing MCP virtualenv pytest runner supplied the results.
- First-run/API/MCP persistence was exercised with synthetic credentials and
  actual protected files/cryptographic generation; Docker/Azure command owners
  were mocked for this enhancement. Two complete SDK OAuth fixture flows cover
  exact loopback/root callbacks and reject an alternate loopback hostname.
  Arbitrary downstream DCR labels do not grant unauthenticated access.
- Live client/Entra/provider/Azure qualification is still unavailable. GitHub
  cloud explicitly lacks remote OAuth; CLI/Studio endpoint-level OAuth details
  remain unverified, not declared universal compatibility. Existing100k
  PostgreSQL capacity failures and04C/12 live status are unchanged.

Selected final follow-up identities (not a new full release manifest):

| Input | SHA-256 |
| --- | --- |
| `docs/deployment-setup.md` | `53bee6d831e6b71b3de348e2a81fb37328f1b7e6c21494b805e07b1d6777fd0f` |
| `deploy-local.ps1` | `9fe58168ba7e8fccd77d9cbbef0d34ebf8ca60b8e9fc0d5dcfc5e9a45cba6a9d` |
| `scripts/local-deployment.ps1` | `97e36236b576b7300e2b3577aad11e334769ac07d645fb0303b807e8ecdbf8d8` |
| `scripts/local-runtime.ps1` | `54473ff42bac310faf9e1cef117c8b4e2568acde512a458d6145599b4f2ad5a5` |
| `scripts/local-mcp.ps1` | `bb029bde9fde71444c57c35262e5e4ede7ee10f3da559c790504ec40f9427901` |
| `scripts/azure-deployment.ps1` | `3577ece07b6cac84672c35a9c8ae9007363f391a77d68ea7f5667388174235a3` |
| `mcp/examples/local-settings.example.json` | `543aa900da6b879cb78825dc725a5a1f75cbe4e453fe108c3498d89f5e07c079` |

The earlier917-input snapshot and qualified local images are preserved as
**historical**, not a build of this enhancement. No image was rebuilt/published
or live deployment attempted for it; Python/API/frontend production runtime
source is unchanged. Use the normal deployment owner to build current source
when applying the operator's authorized test configuration.

Current state: enhanced source is **ready_for_local_deployment_testing**;
actual live release remains **deployment_pending**, not complete. All changes
are uncommitted. No tagged API secret, production settings, container, volume,
provider resource or Azure target was accessed by this follow-up. Exact next
action: supply the separate MCP registration credential, public HTTPS resource
and client callbacks through normal setup on the authorized target, then build/
start current source. No fabricated acceptance or extra runtime gate applies.
