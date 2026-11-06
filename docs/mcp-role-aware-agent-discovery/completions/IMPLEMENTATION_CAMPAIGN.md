# Role-aware MCP discovery implementation campaign

## Scope and execution

- Started: 2026-11-06, by explicit `/implement-folder` invocation.
- Plan: `docs/mcp-role-aware-agent-discovery`.
- Repository: `/Users/candede/repos/agent365/agent_control`.
- Application roots: `backend`, `mcp`, `frontend`, `scripts`, `infra`; all are in this repository.
- Baseline commit: `c28fa870c39a009c2f3537e0db87142739f893e4`.
- Initial tracked/untracked worktree status: clean.
- Execution: sequential phases, at most one active implementation worker.
- Required and supported worker launch: `model: gpt-6.1-sol`, `reasoning_effort: xhigh`, explicitly passed.
- Local validation: isolated fixture resources on the existing Docker Desktop runtime; no production credentials or synthetic production data.
- Production outcome: the binding README requires the existing `seha` installation, not an arbitrary local project. Exact installation host/context/origins/images/volumes must be reconciled before mutation.
- Authorization: the explicit campaign start activates the README's bounded affected-service deployment, existing-registration assignment-required changes, and one deliberate `seha` / `agentcontrol` reset. Preserve settings, secrets, roles, volumes, registrations, consent, callbacks and encrypted OAuth state. No commits, pushes, branches, tenant-wide grants or other destructive live tests.
- Release state: phases 01–03 implemented; phase 04 coherently deployed the confirmed Mac `seha` installation with exactly one actual application reset. Deployment is verified, no longer pending. Campaign remains `production_hardening_pending` for real individual MCP/employee/Studio/control-plane proof and failed scale capacity. No release bookkeeping becomes runtime authorization.
- Current composed release: application/operator remain `candidate-cutover`;
  the independently deployed durable-registration MCP is
  `sha256:f5b49c3022e453d7c8e7c5b4a322c0674ff369d20dda42506b276f35f9d45ffb`.
  The old candidate's embedded MCP image is historical, not the current MCP.

## Stable ordered manifest

Order follows the README links; no fallback sorting or additional phases.

| Order | Prompt | Dependencies | Completion record | Status |
| --- | --- | --- | --- | --- |
| 01 | [Roleless discovery authority](../01-roleless-discovery-authority.md) | None | [01 record](01-roleless-discovery-authority.md) | complete (isolated verification) |
| 02 | [Safe agent discovery API](../02-safe-agent-discovery-api.md) | 01 | [02 record](02-safe-agent-discovery-api.md) | complete_with_risk (capacity failed) |
| 03 | [Role-aware MCP surface](../03-role-aware-mcp-surface.md) | 01, 02 | [03 record](03-role-aware-mcp-surface.md) | complete_with_risk (container selector unavailable) |
| 04 | [Verify, deploy and observe](../04-verify-deploy-and-observe.md) | 01, 02, 03 | [04 record](04-verify-deploy-and-observe.md) | production_hardening_pending (deployed; remaining identity/channel proof pending) |

## Contract identities (SHA-256)

| Contract | Hash |
| --- | --- |
| `README.md` | `e09a877b4a7a7ec13278c2eae52a8443f70f37b1f0428d4db4439a3ba0c4f519` |
| `01-roleless-discovery-authority.md` | `e115dd40f3bbc0c75a61301f5e6b9b4f1ab0cb96f29555da45a383ef9f916a59` |
| `02-safe-agent-discovery-api.md` | `6516994a3a247359381a3af315d6b258d5dd5981ac72ff59988ecaeecc0bd2a5` |
| `03-role-aware-mcp-surface.md` | `cc2e58e545f06fbc21d6c4c4335e03f0f6f9d3685636b61d4b7273934472cb36` |
| `04-verify-deploy-and-observe.md` | `5ffb99a9146ded336203e535afdf141548487d8912a655f41e44f596ee3ade53` |
| Repository `AGENTS.md` | `eb9bb2400afb49e5500666234b385facde6cdbba874285e0f51d90c5a5d8a81e` |
| Installed implement-folder skill | `6931110e9e65d050fada7b1ba92e1c4c5873aeea87a98c2402bee02b4cbc18c7` |
| Installed step-worker contract | `7b581abbc75a1218c6740ec82693dd4043fc0ff9c7202f62c6b26883589511e4` |

## Parent decisions

1. Use the existing API policy, source/report owners and native MCP SDK. Do not add another role, catalog platform, scheduler, policy matrix, migration chain or compatibility alias.
2. Keep active-member verification separate from saved workplace ownership; unlicensed employees may legitimately remain catalog-only.
3. Preview is a request-scoped restricted lens with an immutable staff actor. Discovery privacy applies equally to self-service and preview.
4. Stage the coordinated code locally. Production cutover belongs to phase 04 and cannot run until the exact existing installation is verified.
5. Reuse the checked-in isolated fixture and approved dependency images. Install only after manifest changes or genuine missing dependency failures, using the approved package feeds in every subprocess/container.
6. The README contains no user-acceptance pause. Actual interactive provider/client credentials or an unresolved target boundary may still require the operator; never infer consent or claim unavailable live proof.

## Setup evidence

- All four phase prompts, README, repository instructions and installed worker contract read.
- Phase links, completion paths and dependency order checked; no existing campaign/completion records.
- `git status --short`: clean before campaign creation.
- `pwsh` available at `/Users/candede/.dotnet/tools/pwsh`.
- Docker contexts available: `default`, `desktop-linux`; runtime reports `docker-desktop`, Docker `29.9.2`.
- Local running containers include `seha-agent-control-app-1`, `seha-agent-control-mcp-1`, `seha-postgres-1`. Presence is not proof this is the roadmap's production installation; no mutation authorized by this observation alone.
- Read existing reset runbook and fixture entry points. Reset retries after successful reset must omit `-DbReset`.
- No environment lifecycle actions or production mutations performed.

## Validation and changed repositories

- Changed repository: `candede/agent_control`; phase 01 changed all five application roots coherently.
- Phase 01 launch: `gpt-6.1-sol`, `xhigh`, fresh sequential general-purpose worker. No nested agents.
- Phase 01: 787 backend tests (16 files), 1,301 frontend tests (10 files), 159 Python tests passed; 2,004 PowerShell assertions passed separately. Backend/frontend typechecks, frontend lint, Ruff, mypy and `git diff --check` passed.
- Parent reviewed the exact completion record, API operation projection, roleless membership verifier, authenticated-entry route, narrowed automatic source authority, tenant-lock admission and employee browser handoff. Real isolated first-authentication and six-way/two-principal cold-race evidence is recorded, not inferred from mocks alone.
- Isolated backend evidence: `artifacts/large-tenant-data-platform/e039ba1aac4f4e5ea23e5a59d6eb1cd4/result.json` has no failures; owned containers/volume cleaned.
- Reusable dependency baseline: `agent-control-roleless-baseline:local`, `sha256:cc9f4e9efb6428322b82764ba35c40bbbb49890cd76ef563c7967182d85ba9cd`.
- Host PowerShell/dotnet failed with exit 137. Existing offline helper `agent-control-roleless-powershell:local` (`sha256:d8c890e2a42c8f7763b972e2c17e9bbf3e301597c0bc24d52eaf8332abb61162`) and credential-free fixture Docker context under `artifacts/test-scratch/roleless-docker-config` recovered supported tests. See phase 01 record for exact non-root/socket command contract. No package installations or public indexes used.
- Bicep compilation unavailable (compiler absent); configuration/template assertions passed. Actual Playwright and live provider/client proof remain open for their later owners. This is not a compiler or live-flow pass.
- Phase 02 local focused proof: 222 tests passed; shared authority: 790 passed; discovery/SQL/reset/selection fixture: 535 passed, one Office restore failure independently reproduced in the pre-phase02 image. Typechecks and diff hygiene passed; lifecycle 451 assertions passed (not deployment proof).
- Phase 02 full capacity: accepted 100,000 people / 200,000 catalog records / 1,000,000 report facts. All four first query shapes cancelled at the existing 15-second SQL deadline; zero measured samples and no p95/scan/response qualification. This is failed capacity, not unavailable infrastructure or a pass. Practical SQL narrowing/ambiguity/hash repairs did not meet the threshold.
- Capacity residual owner: phase 02 query owner/parent. Any `57014`, or per-shape p95 >2 seconds across at least 50 post-warmup requests, triggers bounded plan-led root repair and remeasurement. Do not add availability/approval gates, unbounded SQL or unsafe fallback.
- Published Studio identities and thirty-minute production observation: not_run, not passed.
- Production remains `deployment_pending`; affected live workflows remain `production_hardening_pending`. No production mutation/reset has occurred.

## Phase 01 handoff decisions

- Current roleless access profile contains exactly the profile and authenticated-entry operations; phase 02 adds its finite discovery reads under existing route policy.
- `POST /api/mcp/authenticated-entry` is the native initialize/list integration target for phase 03. API source admission is due/idempotency owned; ordinary profile/catalog reads must not dispatch.
- `MCP_HIDE_EMPLOYEE_DETAILS` and `MCP_HIDE_CHAMPION_EMPLOYEE` carry the exact persisted deployment keys to the API. Phase 02 must enforce both on all safe output and permitted search evidence; Python must not independently own policy.
- Unlicensed membership verification never writes stored workplace data. Retain the tested catalog-only behavior.
- No shared contract/prompt changes, manifest amendments or new approval gates.

## Exact next action

Current staff MCP authentication and automatic native refresh have recovered; twenty-one native discovery reads succeeded, including two after the reference-access lifetime without another sign-in. Obtain the missing separate roleless employee/staff/guest, authorized Entra control-plane and published Studio connections. Use separate genuine employee identities, not the staff owner's connection or temporary removal of existing role assignments. Preserve current successful authentication. Do not repeat the database reset or already-verified aggregates. Capacity stays failed/owned until actual qualifying measurements exist.

**Durable-registration fix-forward completed:** MCP-only repair deployed and
parent native profile/search reads succeeded on the preserved connection,
without another sign-in. Existing registrations no longer expire daily;
credentials retain finite lifetimes. The already-missing Studio registration
requires one supported repair/reconnection, not a recurring daily procedure.
Remaining separate identity/channel checks stay pending as requested below.

The operator's latest actual response is **"None currently—leave those checks pending"**.
Leave the unavailable real-identity/control-plane/published-channel checks open
until that access becomes available; do not repeatedly request the current
staff sign-in or count previews as employee authentication. Production remains
running. Campaign is deployed but not fully qualified; scale capacity remains
an explicitly failed independent residual, not an authentication failure.

## User-requested pause

- User: "i need to move soon and will close the lid. give a pause where it's possible".
- Stop directive delivered to phase 02 worker `1dfaa47d-2091-4981-bf02-319470e10585`; no next phase may start.
- Phase 01 remains complete with its recorded isolated evidence; phase 02 is incomplete, not a passing phase.
- Parent snapshot: 87 tracked files changed, 21 untracked files; all edits retained, no commits.
- At pause request, the only running shell was `discovery-capacity-3` (specific PID 62879). Parent stopped it successfully with `stop_bash`; worker explicitly instructed not to restart it and to finish only exact-owned cleanup/checkpoint.
- Observed disposable project: `agent-control-ltdp-de5fca8f979e4542bf15c03aad5023dd` (`work`, `test-postgres`); helper container `vigilant_turing`. These observations are not deletion authority for unrelated resources.
- Existing `seha` containers must remain untouched. No production mutation/reset has occurred.
- Active capacity shell: stopped. Worker is now idle and acknowledged the safe pause.
- Detailed phase 02 checkpoint exists and was read by parent; includes current source hashes, partial-edit boundary, exact remaining work and resume command. Current code is not fully validated: the latest isolated functional snapshot had 496 passed / 12 failed, and subsequent edits invalidate that snapshot as final-source evidence.
- Latest functional failures: eleven invalid duplicate-natural-identity CSV fixture cases and one Office historical-selection restore failure with causation unproven. Required next repair is explicit in the phase 02 record; do not weaken importer or selection guards.
- Capacity intentionally interrupted; 100,000 directory people publication observed, complete catalog/edge scale and all measured samples/p95 remain unknown, not passed.
- Both worker-owned fixture projects (`agent-control-ltdp-b840d4a34d6844deaf651cc8e312df4f` and `agent-control-ltdp-de5fca8f979e4542bf15c03aad5023dd`) cleaned by existing finally blocks. Worker confirmed exact containers/networks/volumes absent; helper `vigilant_turing` also gone.
- Parent read-only Docker verification confirmed no capacity-project containers/networks/volumes remain; only the three pre-existing `seha` containers are running. No background measurement needs to survive laptop sleep.
- Pause finalized: all implementation/verification stopped, worktree/evidence retained, no further phase or production action scheduled.

## Resume reconciliation

- User requested "continue" on 2026-11-06 at 08:07 +04:00.
- Parent reread campaign/phase 02 checkpoint and current worktree. All phase/README hashes and the paused SQL/service hashes still match; no invalidation from new contract content.
- Existing Docker context remains `desktop-linux`; only pre-existing `seha` services run. No retained disposable fixture needs recovery.
- Retained phase 02 worker is unavailable after the pause (`write_agent`: no agent found). Resume through one fresh phase 02 repair context with explicit `gpt-6.1-sol` / `xhigh`, consuming the existing incomplete record rather than repeating completed work. No additional phase or denominator change.
- Preserve all paused edits and evidence. Remove only identified campaign scratch files after checking exact scope; no broad cleanup.

## Phase 02 parent review and bounded repair

- Resumed worker `1d98e912-ffad-4b85-9a13-8ef5ece0a3ec` returned `complete_with_risk`; parent read its exact record, typed API/action/selection map, safe projection/query boundaries and protected reset/authentication hunks.
- Per-source provenance and strict CSV fixture repairs are complete. The twelve deterministic retrieval cases, full paging/About, four privacy combinations, actor/subject/workplace isolation, current authority, reset/grants and first-run source recovery have real selected-source fixture coverage.
- Failed capacity remains a reproducible performance residual after practical attempts; under the binding Always-Deploy contract it is not fabricated as passing and does not add runtime/release authorization.
- Before advancing, parent identified a concrete reset-first-run question: a global now-based signed-token cutoff may reject a newly obtained Entra token whose `iat` is legitimately backdated up to 300 seconds. Same-phase worker is verifying that exact case and repairing only the protected revocation/normal-first-run contract if necessary. No grace bypass, forged timestamp, artificial wait or weakened known-account revocation permitted.
- Bounded repair reproduced the first-run bug and removed the blanket reset cutoff. Only actual positive per-principal revocation epochs/cutoffs are protected across reset and seeded into the existing canonical principal owner; no new runtime authority, grace bypass or timestamp rewriting.
- Fresh signed API/ID tokens with `iat`/`nbf` backdated 300 seconds now work immediately for unrevoked users. Actual revoked-principal issuance fences remain strict.
- Final repair evidence: 794 authority/reset tests passed; 375 focused tests passed; 316/317 expanded recovery tests passed, with the sole source-ceiling assertion independently reproduced in the exact pre-repair image. Existing discovery SQL/DTO/retrieval proof remains exact-current by hashes; changed auth/schema/backup owners were reverified.
- Current schema: 107 tables / 81 functions, fingerprint `78fa2785984b89e6e95a1c88ad60105138993c49ec517df457bb7f555006dd40`. Global singleton and all superseded consumers/tests/docs removed. Protected maintenance principal snapshot is reset recovery only, not a competing runtime data owner.
- Parent reviewed final record and current reset locking/publication/grants/schema hunks. Both the Office restore and source-ceiling residuals have independent pre-change controls and remain outside this campaign's unrelated repair scope.
- Phase 02 accepted `complete_with_risk` under Always-Deploy; failed scale capacity remains explicit. Phase 03 is next; current service identities unchanged and all owned fixtures cleaned.

## Phase 03 parent review

- Fresh sequential worker launched explicitly `gpt-6.1-sol` / `xhigh`, no nested agents.
- Parent read completion record and actual native projection, initialize/list/call middleware, canonical invocation permission checks, same-policy trusted metadata transport and browser privacy changes. No competing authorization matrix, shared registry mutation or custom protocol owner found.
- Actual native counts/bytes: EndUser 3 tools / 4 operations / 26,552 discovery bytes; Viewer 38/90/481,399; Uploader 38/90/481,425; Admin 54/113/616,237. Single-action families retain envelopes; unauthorized variants/definitions excluded.
- Passed: 628 Python tests, 162 isolated SDK/API/SQL tests, 66 backend and 44 frontend focused tests, 6 real settings-browser desktop/mobile cases; Ruff/mypy/typechecks/lint/diff hygiene.
- SDK fixture project `44cb6675533240dbbf0066fe9bb4d935` result has no failures; 54 SDK clients / 418 business calls. Admission/provider attempts counted separately from business reads.
- Separate `mcp-container` selector unavailable because Linux PowerShell helper cannot launch macOS host venv Python; 0 runtime restart/rotation journeys, not passed. Phase 04 owns minimum genuine cross-platform fixture recovery and rerun, not a bypass.
- Source identities and unchanged phase 02 query/schema/authority hashes documented in phase 03 record. Current schema stays 107/81 and no global reset cutoff returns.
- Phase 03 accepted `complete_with_risk`; inherited full-scale capacity remains failed. Production still `deployment_pending` / live proof `production_hardening_pending`. No live mutations/resets/Entra changes.

## Independent production-target investigation (read-only)

- Parent inspected only non-secret receipt fields, container ownership labels and mounts while phase 02 runs. No target mutation.
- Existing local `seha` receipts and container labels bind this macOS checkout to Docker Desktop `desktop-linux`, app port 3002, MCP port 3003, network `seha_default`, PostgreSQL volume `seha_data`, OAuth volume `seha_mcp-oauth` and recorder volume `seha_mcp-recordings`.
- Existing API origin: `https://mgzftq2n-3002.euw.devtunnels.ms`; MCP resource: `https://ddnv5p3z-3003.eun1.devtunnels.ms/mcp`. Origins are observed settings, not proven public reachability or production authorization.
- Current immutable images: app `sha256:3a32deea7d3d59b50c509029a8ded059481a70760ad365e5110fb288367718b9`; MCP `sha256:91067e659638b36d53ce8a2188f9cabd6f9f55b3ef5f75d15286ff596e2f8595`; PostgreSQL `sha256:051f7b7b3abdd564d5d1bd1e8c4b9c1b6e77087d1dd22020ede611c096a272e0`.
- Local operation receipt reports an older reset already completed/verified. It is historical evidence only, not this campaign's reset or permission to replay it.
- The Studio reference includes VPS instructions and also macOS Desktop-specific ownership evidence. Exact intended current production host remains unresolved: do not substitute the observed local project for a different installation.
- Phase 04 must settle that host/context boundary from the authoritative installation owner (or obtain focused operator clarification if still ambiguous), preserve current settings/privacy/OAuth state, verify exact candidate/action identities, and perform only the campaign's single approved reset.

## Phase 04 parent review and deployment handoff

- Fresh sequential worker launched explicitly `gpt-6.1-sol` / `xhigh`, no nested agents. Parent read the exact completion record, final metadata cancellation repair, tightened exact Desktop bind representation checks, candidate verification and cleanup receipts.
- Aggregate passes: 1,051 Python tests (21 guarded Azure-storage cases skipped), 5,722 frontend tests, 144 browser cases (8 existing cases skipped), Ruff/mypy/typechecks/frontend lint/build/diff hygiene.
- Actual current MCP container cold/restart/encryption/secret/signing rotation/revocation/drain journeys passed after the fixture's genuine locked Linux Python was used. The earlier phase 03 unavailable selector is now resolved, not waived. 235 packaged tests and 11 actual journey modes; final guarded cleanup passed.
- Six fresh employee/Viewer/Admin browser first-use tenants (desktop/mobile) each persisted exactly one automatic actor-attributed run with expected sources and no manual Sync/Permissions visit. Existing SDK/privacy/retrieval proof reused selectively by exact hashes; final metadata reader repaired and verified 71/71 on both Node 24.22.2 and 24.20.0.
- Combined isolated aggregate: 1,315 passed / 1 failed / 1 skipped; sole assertion failure independently pre-existing Office restore. Its two real metadata cancellation errors were repaired afterward and are not claimed retrospectively green. Current reset 18/18 and backup 4/4 passed; final-schema isolated restore passed.
- Knip still fails only two unchanged Office-owned exports; seven campaign-owned unused exports removed. No suppression/unrelated fix. Bicep compiler remains unavailable.
- Full-scale capacity remains the explicit phase 02 failed residual; no passing p95 or fabricated production observation. Real individual employee/staff/guest OAuth, natural-language repetitions, genuine report import and published Studio remain unrun/unavailable.
- Seven exact phase 04 fixture projects cleaned; parent read-only Docker check finds only the three original healthy `seha` containers. No live reset/deploy/rename/Entra change. Removed only confirmed generated `StartupProfileData-NonInteractive` binary cache (not in candidate manifest); final diff hygiene passed.

### Exact prepared release (not deployed)

- Candidate: `artifacts/test-scratch/phase04/candidate-release/build.json`.
- Candidate SHA-256: `9aad98d028b731cacc1fede2e53655315e38f49132698b6c9276bd2194ad9fb1`; parent independently matched it.
- Full source manifest: `2bc3e5f7e97697decede95595ac1db8a91d72c6bbc0b8d14788bcb92c16b0868`, 1,113 files.
- Runtime image: `sha256:08fd1480434d8e57da7ea2b27e993bcc44ce9801828ff04bed1e0c8c16211b42`.
- Operator image: `sha256:ee1d76a69c99b6916385273532f27611978056a8057d51091f46b113e82fb7f8`.
- MCP image: `sha256:8f0be092893649d984c2ad61af885fa0260fbf521fe51a22a5a170c5d0c2ae08`.
- Schema stays `78fa2785984b89e6e95a1c88ad60105138993c49ec517df457bb7f555006dd40` (107 tables / 81 functions).
- Existing verifier passed image/source/compiled/schema identities, but `deployed:false`, `targetBound:false`.
- Read-only local preflight rejected `Release container network/name mismatch`: current live PostgreSQL is `seha-postgres-1`, while current Compose requires `seha-agent-control-postgres-1`. No guard broadening or compatibility alias. Only after host confirmation, reconcile exact existing container ID/image/labels/volume and align that same container name, then regenerate preflight. This is target reconciliation, not an application-owned approval gate.
- Preserve saved privacy false/false (including defaults); no production cycling. Preserve service/volume/roles/secrets/OAuth state and registrations. A completed-reset retry must omit `-DbReset`.
- Phase 04 remains open; campaign is not complete.

## Exact production target answer

- Parent asked the single host/context question after all independent local work.
- Actual user answer: "This Mac: Docker Desktop desktop-linux, project seha, app 3002 / MCP 3003".
- This settles the existing-host ambiguity; it does not change content, broaden resources or replace authentication. The binding campaign authority now applies unambiguously to this exact installation, including its one deliberate `agentcontrol` reset.
- Resume the same phase 04 worker with this answer and the pinned candidate/action identities. No new release-acceptance, enable or requalification prerequisite.
- Before rename/cutover, freshly verify exact PostgreSQL container ID, project/service/root labels, image, network, volume and database ownership; preserve that service/volume and align only its Docker name with current Compose.
- Tool limitation: synchronous phase 04 worker cannot accept `write_agent` follow-up. Start one bounded background live-cutover continuation with the same explicit `gpt-6.1-sol` / `xhigh`, consuming the existing record/candidate/actual target answer; do not repeat local implementation or aggregate testing.
- Live continuation launched as `eaf27a1c-72b1-4840-9571-76dac12c4b83`, explicitly `gpt-6.1-sol` / `xhigh`. It owns this exact installation's fresh safeguards, same-container name alignment, single reset/coherent deployment and available genuine observation; parent performs no concurrent live mutations.

## Confirmed-target deployed result and parent verification

- Live worker is idle after all independently available authorized work; same context can resume once genuine interactive authentication exists.
- Exact same PostgreSQL container renamed to current `seha-agent-control-postgres-1`; original ID/image/started-at/volume/network preserved. One real `agentcontrol` reset completed, initialization/grants verified, normal operational mode restored and API/frontend/MCP coherently deployed.
- Cutover exposed nonenumerable `pg.Pool.options.password` omission when cloning protected connection options. Both operator clone sites now explicitly preserve it; 23 real SCRAM reset/backup tests passed with deliberately wrong ambient password. Backend typecheck passed.
- Existing lifecycle owner now recovers only proven typed pre-DROP validation denial with exact action/content/target/drain identity, preserving denial receipts. Unknown destructive outcomes remain closed. Completed-reset resume without `-DbReset` is supported and was actually used after a helper network-boundary failure, without repeating deletion. 459 lifecycle assertions passed.
- Parent read actual operator/password and lifecycle-recovery hunks, final record, candidate and protected deployment receipts; independent Docker inspection matched final images healthy with restart count zero. Final `git diff --check` passed.
- Final deployed candidate: `artifacts/test-scratch/phase04/candidate-cutover/build.json`, SHA-256 `66b818f16cc33576b810d39f212e0e9479276936832801c4a94f7e5eb171a609` (independently matched by parent).
- Final source manifest: `5210cfbf573003b2bdf81564799556c808b957e6ae84e6dbcd94f157d487576e`, 1,114 files. Earlier `candidate-release` is superseded, not a deployment pointer.
- Runtime: `sha256:ead305a676a5fd8c325c58a75d2a655898495b3b0781e41d845d16392443597f`; operator: `sha256:564715f159a0e340292512d84190b34b351be38e5eef3955130f57f91d65c4f6`; MCP: `sha256:9b8cffe2b7fc3c47f32daaf7d02dc9cb2f5b8f1210795e2ee2cef407dd7ab088`.
- Protected active operation records this exact candidate, reset preflight `05eb42189c208bbef52495cd8eee9e6464c109a462dc36e2738a0e0e459a4c5a`, `databaseAction:reset`, `resetStatus:completed`, `step:verified`. Parent independently read those fields. Actual live reset and nondestructive resume logs are distinct.
- Schema remains 107 tables / 81 functions, fingerprint `78fa2785984b89e6e95a1c88ad60105138993c49ec517df457bb7f555006dd40`; runtime grants verified. Saved privacy false/false, nine protected secret bindings unchanged, OAuth/recording volumes/storage retained. Storage retention is not proof of actual OAuth refresh.
- Thirty-minute passive health observation: 1,800.834 seconds / 366 local-public probes, all 200. This is not the required two-employee discovery observation.
- Real external normal browser sign-ins became available during observation. Worker observed automatic staff source publication (1,373 Graph packages, 1,700 Power Platform records) and later automatic directory recovery after genuine reauthentication interrupted the original run; no manual Sync. Three complete webapp report bundles were externally submitted/accepted; worker submitted none, original-export provenance belongs to uploading operator.
- Nine actual successful Viewer browser/API discovery reads, own-member preview→self, saved company-only honesty and Viewer settings/SDK metadata/false-false parity verified. These are one staff identity, not two roleless employees or native semantic proof.
- Remaining required proof: roleless employee-first sign-in, two employees/different departments and at least ten reads/refresh, genuine guest, separate staff target comparisons, actual natural-language repetitions and published Studio channel, existing-SP assignment-required inspection/change where necessary. Native client authentication and Entra/publication access unavailable; no borrowed identity or synthetic live substitute.
- Parent made one additional real `sehaAgentControl inventory.health` call after handoff; client explicitly requires authentication. Stop for that genuine interactive step, not another release approval.
- On the subsequent resume, the operator answered “Signed in—continue verification”. Parent retried the same harmless saved-health call; the MCP client still explicitly returned “requires authentication”. This is not a successful native read or evidence of rejected application authority. Reconnect/restart the existing client connection and complete its own sign-in before retrying; browser webapp authentication alone does not establish this connection's authentication.
- Operator then answered “Reconnected and authenticated—retry”. The next saved-health attempt returned the same client authentication requirement. No native business read succeeded, no live mutation/reset was attempted, and further identical retries were stopped. The current chat's connection remains unavailable; reload the client/session and re-establish its existing MCP connection before continuing native verification.
- Scale capacity remains failed (four 15-second statement cancellations, no p95); historical Office/source ceiling/Knip findings and unavailable Bicep unchanged. Existing numeric safety/performance signals/owners/fix-forward actions remain in phase 04 record.
- All four additional continuation fixture projects cleaned; no observer/helper remains running. Production stays running; no commits/pushes/branches.

## Native authentication follow-up: missing cached client registration

- Operator supplied the actual OAuth browser error `Client Not Registered` for its previously issued dynamic client ID.
- Parent read the current provider/store/SDK path and inspected only safe live storage identity/counts and the reported ID's presence. The healthy deployed MCP image still mounts `seha_mcp-oauth` at the configured OAuth path. No dynamic client records are currently present; exact reported-client lookup returned false. No token, secret or decrypted record body was exposed.
- The existing documented store contract caps every OAuth entry, including DCR metadata, at 24 hours. An absent historical record does not prove its original expiry/deletion cause. Preserving the volume during cutover does not preserve expired registrations, and no new registration has yet been verified.
- VS Code's specific stale-registration recovery command was verified through `microsoft/vscode#269379`'s recovery comment using `gh api`. Clearing only access/refresh tokens or restarting can retain the old client ID; remove only this issuer's dynamic authentication provider and reconnect for fresh normal DCR.
- Updated the directly related client troubleshooting documentation. No runtime/authentication-policy/retention change, fabricated registration, secret change, shared-volume deletion, deployment or reset was performed. Deployed runtime identity remains unchanged; source documentation now differs from the release snapshot. Documentation-only edit needs no runtime suite.
- Native verification remains blocked until this actual client-registration recovery completes; no additional release approval is required.
- Operator reported removal of the dynamic provider and renewed sign-in. This session's former tool catalog disappeared; invoking the current server-routing tool failed with `session.mcp.startServer ... requires authentication`. Safe live follow-up still found zero DCR records and no recent rejected-callback warnings. Public issuer/registration/authorize/token discovery endpoints match the confirmed MCP origin. No new registration is proved. The next interactive step must target this chat's active Copilot harness connection, not assume the editor's dynamic-provider cache and this harness share authentication. Updated the recovery documentation with that distinction.
- After the operator's next current-harness sign-in, a new DCR record and 38-tool staff catalog appeared. One native inventory-health read and 19 native discovery reads succeeded, including the six roadmap question/expansion shapes twice, complete selected detail/no-match, and a real different-member profile/workplace/search preview followed by return to self. See the latest phase 04 section for exact actions, terms, selections and grounded outcomes. No Admin controls advertised; Viewer versus Uploader is not inferred from their equal catalogs.
- Actual native self company is Microsoft with no saved department; department/champion data stayed explicitly unavailable. Explicit other-member preview used saved Sheikh Shakhbout Medical City / HR Operations and returned three champions, distinct department/company top-three sets and four created/used use cases. This is native staff preview proof, not another person's authentication or roleless self-service.
- Bounded continuity wait `mcp-native-refresh-window` is running attached for 910 seconds, with a verified live helper process. No new service, synthetic production data, token extraction, sign-out or production mutation. After it completes, retrieve the timer and make another native read; record observed renewal/limits without equating nineteen staff reads with two-employee or scale qualification.
- The timer subsequently completed normally, **12:16:20Z–12:31:30Z / 910 seconds**. Two further native reads (fresh self profile and expanded BRD search) passed without another sign-in, bringing discovery to **21/21**, plus one successful inventory health. Safe metadata confirms changed refresh-reference/JTI keysets and updated upstream state at Unix `1793968299`, 1,184 seconds after initial issuance; DCR identity and empty authorization transaction/code timestamps stayed unchanged. Actual automatic native refresh/continuity is now positive for this current staff connection, not proof for other clients/people.
- No observer/helper remains running; exact deployed MCP image healthy, zero restarts. Documentation-only follow-up, no reset/deployment/runtime changes. `git diff --check` passed. Remaining interactive owner needs are genuine roleless employees/different departments, separate staff/guest, authorized Entra property access and published intended Studio channel. Scale failure remains open and unaffected by these 21 small native reads.
- Asked once about availability of those remaining genuine identities/control-plane/channel connections after native refresh succeeded. Actual operator answer: **"None currently—leave those checks pending"**. Retain `production_hardening_pending` and the existing residual owners/evidence; no further identity substitutions, role changes, live mutations or repeated authentication requests.

## Fix-forward: durable OAuth client registrations

- User subsequently reported the same missing-client error in Copilot Studio and
  rejected automatic daily client deletion. Parent reproduced the actual
  consequence in isolated SDK OAuth: registration expiry left a valid access
  token but refresh failed `401 invalid_client`. This is an application-owned
  retention defect, not a provider role restriction or mandatory client policy.
- Safe actual lookup confirms the reported Studio client ID is already absent.
  An ID alone does not provide the original approved callback/client metadata;
  no registration/token was fabricated or resurrected.
- Parent implemented the repair in the existing FileTree/Azure storage owners.
  DCR metadata has no automatic TTL, while every credential/temporary-state
  retention cap, revocation, capacity, identity, callback, PKCE and lease/ETag
  check remains. Still-valid saved registrations are made durable during normal
  startup; missing/deleted/expired state is not restored.
- Local startup atomically rewraps retained current FileTree v1 encrypted
  envelopes and preserves credential expiry, so durable records do not prevent
  legitimate old-key retirement. Azure already rewrites its leased encrypted
  map at startup; only correctly keyed client registrations may have null expiry.
  No new store, runner, scheduler, role, compatibility route or database change.
- Updated current reference, client-recovery and Studio troubleshooting docs.
  Historical 24-hour statements above describe the former implementation.
- Final validation: **1,054 Python tests passed / 23 Azure-guarded skipped** in
  283.85 seconds; independent **23/23 actual Azure SDK/emulator tests passed**
  in 39.81 seconds. Covered 30-day registration retention, SDK authorization and
  refresh, restart, surviving finite-record promotion, no resurrection, exact
  deletion, key rotation/new-key-only startup, finite credential expiry, and
  rejection of persistent non-client Azure credentials.
- Ruff across all Python source/tests passed; mypy 26 source files passed;
  `git diff --check` passed. No dependency manifest changes/installations.
  The missing pinned official Azurite image was restored from MCR after its
  actual missing-image failure; no public package indexes.
- Exact isolated fixture `ac-oauth-durable-a3123a5f-f565-46`,
  container `0701779e15ca28dda12fdc0501a1f63f08831d3a2aa09dc20e29ceb6f34fabfe`
  and network `432113ad6d346736f2380e0130ee590a4e654330332e4a5ee6c52df637aa7d64`
  were removed by verified owner/ID, leaving production untouched.
- Prior live worker context `eaf27a1c-72b1-4840-9571-76dac12c4b83` is no longer
  available (`No agent found`). A fresh bounded context may perform only the
  MCP-only exact-target fix-forward; it must not repeat prior broad phases,
  reset SQL, delete OAuth storage or weaken release identity safeguards.
- Fresh deployment worker `5cff9224-8012-4756-b1e2-ad98db4001d6`, explicitly
  `gpt-6.1-sol` / `xhigh`, completed exact read-only target/source reconciliation
  but initially made no build/deployment because the MCP owner lacked cached
  dependency reuse and it considered the historical aggregate candidate receipt
  a supersession obstacle. Production still has the old expiring implementation
  until the continuation completes; local passing tests are not live proof.
- Parent resolved the ordinary delivery choices and resumed that same worker:
  repair only the existing MCP installed-dependency build owner, verifying exact
  unchanged manifests/immutable dependency identity and packaging current source
  without reinstalling unchanged third-party dependencies. No generalized build
  framework or runtime policy is needed.
- The historical `deployment.json` remains the last coordinated application
  release/reset receipt; independent MCP's existing `mcp-deployment.json` and
  `mcp-operation.json` own its actual current image. The campaign must state the
  composed app/MCP release explicitly. No new aggregate-supersession gate,
  receipt schema, app restart or manual protected-receipt rewrite is required
  merely to deploy an independently supported MCP fix.
- The worker is continuing the narrow owner repair, focused checks, immutable
  MCP-only build/deployment and actual safe state-preservation verification.
  Parent retains the final native-client read and consolidated evidence update.

### Completed independent MCP fix-forward

- Same worker completed the existing build-owner repair and live MCP-only
  deployment. `AGENT_CONTROL_MCP_DEPENDENCY_IMAGE` now supports manifest-checked,
  immutable, platform-matched offline dependency reuse; uv builds/replaces only
  the current application package and prunes development-only packages.
  No new release layer, application restart or dependency reinstall.
- Focused owner evidence: **34 container-contract tests** and **257 setup/
  lifecycle assertions** passed, plus actual offline wheel/runtime build and
  complete packaged-source/dependency comparisons. All 26 installed project
  files match the snapshot; all 86 runtime distributions match the previous
  production names/versions. Parent reviewed relevant Dockerfile and
  build-owner code, exact completion record and persistent receipts.
- New MCP source manifest, 1,114 files:
  `cf1814b6484ef572495853685423a849981bbc19f7d385217a6df1ed1b113e2f`;
  snapshot `artifacts/local-builds/b651dae78bf941669769598ee72dc0d6/source`.
  Current MCP image:
  `sha256:f5b49c3022e453d7c8e7c5b4a322c0674ff369d20dda42506b276f35f9d45ffb`.
- Both protected MCP receipts independently read by parent: version 1,
  step verified, exact new image, identity
  `3bdac04a08e92940968e3b3d9f6305dd25483aac5285be29b2ea9fe452edc0a2`.
  Historical app/candidate/reset receipts remain unchanged.
- App/frontend and PostgreSQL IDs/images/start times unchanged; all volumes,
  network, configuration, privacy false/false and 9/9 protected secrets
  preserved. No extra database reset, data clearing, provider mutation,
  key rotation or new registration. One already-expired JTI was normally
  culled; active credentials retained their exact original expiry.
- Parent independently inspected the actual healthy deployed image and
  persistent outer expiry metadata: **1/1 existing DCR record nonexpiring**,
  **1/1 upstream and 1/1 refresh record finite**; no record bodies/tokens exposed.
- Parent then made **two successful actual native discovery reads** without
  another interactive sign-in: fresh self profile and expanded BRD search.
  Selection `e12cf66b-5778-438c-8535-f4c3f03b9950`, revision
  `28412f1b-b89e-4d9f-88f0-45fc3803b776`; self Microsoft/null department,
  unchanged October report period and false/false privacy. Search returned the
  same two title-evidence candidates, no fabricated descriptions/use links,
  `nextCursor:null`. This brings observed current-staff native discovery
  evidence to **23 successful reads**, not two-employee proof.
- Worker observation: **32/32** local/public health/readiness probes over
  63.993 seconds, zero restart/OOM/errors. Parent independently confirmed
  healthy MCP, zero restarts; final diff hygiene passed.
- All helpers/build scratch cleaned. No commits/pushes/branches. Root defect
  is fixed and live; the already-missing Studio ID cannot be reconstructed
  from its ID alone. Separate real-user/Studio/control-plane proof and failed
  capacity remain unchanged, not blockers to ordinary use.
