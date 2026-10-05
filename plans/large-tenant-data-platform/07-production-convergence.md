# 07 — Retained production deployment and observation

## Mission and prerequisites

Fully build and qualify a fresh synthetic disposable installation, then deploy the complete new platform to the explicitly authorized **Compose project `seha`, exposing localhost:3002**, observe live behavior and fix forward. This is the sole production application-DB reset owner. Read [README](README.md), all **eight** prior completion records (01, 02, 02A, 02B, 03, 04, 05, 06), parent campaign state, current identity/authorization/access receipt, the completed parent duplicate-cleanup receipt below, residual ledger and dirty status. GPT-6 Astra, `xhigh`.

The user's explicit answer authorizes the checked-in `pwsh ./deploy-local.ps1 start -Project seha -DbReset` command. Reverify expected app `seha-app-1`, database container `seha-postgres-1`, volume `seha_data`, state `/Users/candede/repos/agent365/agent_control/.local/seha`, Compose project/service labels and localhost port 3002 immediately before reset. Resolve the actual network from verified metadata and preserve the existing public URL/callback without guessing it from localhost. Preserve all tenant/sign-in configuration, credentials, backups and saved port/origin settings.

Known parent preflight baseline HEAD: `7e2be0b6b844bd538dbdd15f3e8261ea0fc6aeb6`. The prior two-installation ambiguity and unavailable-question result are superseded: **do not claim `deployment_pending` because reset-target authorization is missing**. The user-identified localhost:3001 duplicate has already been removed as an application deployment by the parent; its recovery storage/configuration remains protected. Never use either installation's configuration/data for fixtures.

**Completed prerequisite, parent-reported 2026-09-28:** the parent verified Docker project/service labels, project `working_dir`, source mounts and port map, then used checked-in `Invoke-DockerCommand` and the `agent-control-phase01` context for Compose `down` with a 130-second timeout, **without `--volumes` or `--remove-orphans`**. Removed only `agent-control-phase01-app-1`, `agent-control-phase01-postgres-1` and `agent-control-phase01_default`. Retained `agent-control-phase01_data` and `.local/agent-control-phase01` configuration/secrets/backups. No precise action time is asserted without the underlying receipt. Parent observed `seha`:3002 healthy and untouched. **Do not repeat this completed deletion**, recreate the duplicate or require its removed containers/network or port 3001 health. Read-only recovery-resource checks are permitted; do not erase retained data/configuration/backups/images without a new explicit user instruction. Unrelated workload services are outside this cleanup.

If a new physical mismatch or other fact genuinely requires a user question, **stop and wait for the user's actual answer**. Do not continue from autopilot assumptions or an unavailable-question-tool result. The `seha` choice is already answered and needs revalidation, not redundant confirmation.

Hypothesis: official local deployment can replace only application data and deploy the complete revision while preserving tenant/domain/client/sign-in configuration and all credentials. First validate deployment/reset safeguards with isolated tests and a read-only identity comparison; do not begin with a reset.

## Tooling contract

- Company-protected machine: **NEVER contact default/public npm or PyPI registries**, including probes, fallbacks, subprocesses or containers. npm registry access must use `https://packagefeedproxy.microsoft.io/npm/` via approved config or explicit `NPM_CONFIG_REGISTRY`; preserve the already-approved Dockerfile environment and parent-maintained project config. Root `AGENTS.md`, `.npmrc` and the user's npm registry are confirmed configured for the approved feeds.
- Python installs only with `python -m pip install --index-url https://packagefeedproxy.microsoft.io/pypi/simple <package>`; no public extra index, including inherited settings.
- Use existing dependencies. Install only after a manifest change or genuine missing-tool/package failure; no implicit `npx` downloads. Verify effective config locally and retain/reinject the approved registry after environment scrubbing. If the feed is unavailable, report it without public fallback. Follow README's binding tooling contract.

## Read first

- `deploy-local.ps1`, `scripts/local-deployment.ps1`, `scripts/tenant-deployment.ps1`
- `scripts/local-deployment.tests.ps1`, `scripts/restart-runtime.tests.ps1`
- `backend/scripts/{database,databaseReset,backup,softwareChecks,test-all}.ts`
- `compose.yaml`, `Dockerfile`, startup/readiness/maintenance/drain code
- `docs/{deployment-setup,operations,security-model,mutation-canaries}.md`
- All completion records, capacity artifacts and residual owners from 01, 02, 02A, 02B, 03, 04, 05 and 06

## Required implementation and execution

1. **Reconcile evidence and finish independent qualification.** Attempt focused regressions for all fixes, aggregate software, schema/grants, browser, new-schema restore, concurrency/capacity and deployment-script tests. Complete the mandatory fresh-installation procedure below even though production authorization is now resolved. Preserve true statuses. For each residual record affected scope, containment, numeric telemetry/canary alert threshold, owner and exact fix-forward action. Record inapplicable model/evaluator/remote-VM categories explicitly; this campaign has no model logic to invent testing for.
2. **Reverify the authorized exact target without disclosure.** Compare the user's `seha` authorization and expected identities above to `New-LocalContext` metadata, live Compose project/service labels, host port 3002, actual `seha_data` mount, retained settings path, volume/network identity and health. Names alone are insufficient. Record the match immediately before destructive work. Use redacted identifiers/hashes in artifacts; never print secret contents or rendered Compose secrets/environment. Confirm application DB `agentcontrol`, the checked-in admin operator and DB-only reset path. Refuse any mismatch without selecting another target. Do not run `edit-config`, retained onboarding, internal `Reset`, volume deletion, role recreation or Entra changes. Consume the parent's completed duplicate-cleanup receipt without rerunning cleanup or requiring the duplicate to exist; independently preserve unrelated workload services and all retained duplicate recovery data.
3. **Preserve external configuration.** Record private before/after hashes and file existence/permissions for `tenants.json`, PostgreSQL admin/app passwords, session secret, any retained client-secret file and settings/compose configuration; never put bytes/values in logs or completions. Confirm tenant/client/domain/profile equivalence without exposing credentials. If the deploy path proposes to rewrite identity/config or prompts for missing onboarding, stop that attempt before reset and repair the configuration-preservation defect or report the literal access/config blocker. Existing user changes remain intact.
4. **Checkpoint and containment preflight.** Use the checked-in local operator backup path for best-available current-state checkpoint before the reset. A backup may reflect the previous schema and is forensic only; no old data restore into new production. Validate its receipt/checksum as far as the currently deployed operator safely supports, record any unavailable checkpoint/restore evidence truthfully and never claim new-schema restore proves the old dump. Use existing maintenance/provider/capability/queue controls for narrow containment; do not mutate external providers. The fresh DB must start with affected provider work/mutations closed until requalified if residuals require it. Any necessary safe default/admission initialization belongs in checked-in scripts/schema, tested first.
5. **Official initial deployment.** After verified identity, completed safety preflight and unchanged configuration evidence, execute the root script from the repository root:

   ```powershell
   pwsh ./deploy-local.ps1 start -Project seha -DbReset
   ```

   This exact command is authorized, subject to physical target revalidation and the existing safety gates. Capture exact worktree/source manifest hash, operator/runtime image digests, schema version, reset/deploy phase logs and identity/authorization receipt. Preserve software qualification, preflight-reset, maintenance, app drain, runtime build, database owner/confirmation, migration/grants and health checks. No direct internal `Start`, manual SQL DROP, direct runtime `compose up`, fake test success or skipped gate to force deployment.
6. **Handle refusal safely.** If `Invoke-LocalSoftwareChecks`, cleanup guard, schema/migration/readiness or identity gate refuses, diagnose and repair with bounded evidence and retry the same official `seha` command path only after the guard is satisfied. Do not reset a second time by default: determine whether reset began/finished from script evidence; use normal forward deploy after the new schema exists. Existing-script safety refusal or physical identity mismatch is `blocked_safety_check`, not a test-only successful campaign or a mislabeled lack of authorization. A real control-plane/access/authentication inability may be `deployment_pending`; the superseded target ambiguity may not. Record literal blocking command/guard, attempted fixes and exact resumable action. If you ask the user a necessary question, stop and wait for the answer.
7. **Qualification of exact deployed artifact.** Verify `/api/ready`, `/api/auth/status` with preserved sign-in configuration, app/postgres health, image/schema hashes and configuration hashes. No synthetic production-auth bypass. Use an authorized existing signed-in session for protected reads; if unavailable, record auth-limited evidence and observe unprotected health/logs, keeping protected stages closed. Synthetic large-scale qualification runs only in the owned isolated namespace against the exact built artifact, never as fake records in a real tenant or mutations to external providers.
8. **Dependency-ordered opening and new observations.** After authorized sign-in/capability checks, open read-only user directory and D30 activity collection, authorized new official report imports if actual files are available, Graph package/PP read inventory, canonical reconciliation, then enriched queries/details/exports. Existing datasets are gone by authorization; empty/not-synced/not-imported is honest, not a regression to be hidden with fabricated data. Catalog-only detail enrichment remains independently paced. Mutations remain under existing qualification/canary/role gates; this campaign does not authorize real mutation canary writes. Observe safe preview/denial paths instead.
9. **Live canaries and alert thresholds.** For at least 30 minutes after readiness and through one permitted complete refresh/reconciliation where credentials/data allow, sample Node and PG memory/cgroup/OOM metrics, queue/pool saturation, request p95/error rate, staged/head/canonical row counts, source freshness, pin/export/GC ages, sign-in/CSRF/session behavior and unrelated audit/hunting/workbench health. Use 06's measured support envelope; alert at 80% charged memory, any OOM/restart/fence violation or cross-scope leak, list p95 >2 seconds over 5 minutes, 5xx >1% over 5 minutes, queue acquisition >5 seconds, expired-GC backlog >10 minutes. At tiny request counts report exact samples, not misleading percentiles. Read existing cgroup support; do not pretend unlimited/unknown production limits match test budgets.
10. **Root-fix/redeploy loop.** On production symptoms, close only affected work using existing controls, capture diagnostics first, repair root code/query/index/admission defect, run focused plus implicated aggregate checks, and redeploy **without** reset:

    ```powershell
    pwsh ./deploy-local.ps1 start -Project seha
    ```

    Rerun affected live canaries and observe again. Never resurrect old readers/data or widen provider permissions to make a canary pass. If configuration hashes change unexpectedly, treat as an incident and restore only exact retained external configuration through the authorized checked-in path; do not regenerate secrets.
11. **Cleanup and handoff.** Remove exact-owned disposable fixtures only after diagnostics; retain sanitized evidence and backups per existing policy. Track cleanup failures as active incidents independently of production observation. Do not clean either retained installation's volumes/state/backups as fixture cleanup or repeat the parent's completed duplicate container/network removal. Cite that completed receipt as a parent action, with any later read-only recovery checks separately recorded. Update deployment/operations docs with actual schema, limits, admission settings, alerts, re-fetch/import workflow, current data state and forward recovery.

## Mandatory fresh disposable installation

Implement `-Suite fresh-installation` in `scripts/large-tenant-tests.ps1` and add its guarded integration coverage. This is a complete new local installation, **not merely the existing `test-db` container**; it remains mandatory before the authorized `seha` rollout.

1. Allocate a never-before-used project such as `ac-ltdp-install-<12 random hex characters>` (within `New-LocalContext`'s 40-character limit), separate state directory, labeled volume/network, uniquely tagged images and an available loopback port other than 3001/3002. Verify none exists before creation. Record exact ownership IDs and a cleanup manifest.
2. Create **only synthetic** tenant/client GUIDs, `example.invalid` domain, fixture credentials, session secret and local callback/origin in the owned state directory using the checked-in configuration shape/helpers. This real fresh application owns DB **`agentcontrol`** inside its unique instance/project; integration/browser/restart DBs remain `agentcontrol_test_*`, and isolated restore targets remain `agentcontrol_restore_*`. Keep those guards and roles separate; do not weaken `testDatabase.ts` or restore naming checks. Never copy, mount or derive settings/credentials from `.local/seha`, `.local/agent-control-phase01` or any retained installation. Real Entra/provider access is neither required nor attempted; provider mutations stay closed.
3. Exercise `New-LocalContext` plus the actual checked-in `Invoke-LocalDeployment -Action Deploy` machinery, including operator/runtime builds, **5/5 `Invoke-LocalSoftwareChecks` gate**, empty-DB preflight, bootstrap, migrations/grants, app startup and readiness. The existing local `Test` path also builds its operator and runs this gate; neither it nor the successful baseline build is a reset bypass. Supply fixture-only network/resource overrides through the owned context/runner without removing any guard. Use 06's measured disk-backed PGDATA/WAL storage and unchanged memory budgets, not the 256-MiB test tmpfs. Use fresh initialization, **not `-DbReset`**, because the installation does not exist. Do not replace this path with internal `Start`, direct ad hoc SQL/container launch or mocked deployment success. Keep protected feed settings from `AGENTS.md` and all disposable image tags distinct from both retained projects and `agent-control-scale-5096-operator:local`.
4. Qualify the exact runtime image/schema/source hashes: health/readiness, synthetic sign-in-configuration status and safe unauthenticated denials, complete new-schema initialization, runtime grants, page/streaming bounds against newly generated synthetic fixture facts, restart/persistence, restore and fixed-budget resource checks. Use the existing isolated browser/provider fixture contracts for protected workflow proofs; never add a production auth bypass or attempt a real external sign-in using synthetic credentials. Distinguish full-runtime installation observations from separate authenticated fixture observations in the report.
5. Observe the fresh installation for at least 30 minutes through fixture ingestion/reconciliation/read/export and restart where the fixture contracts permit; capture diagnostics, hashes, resource peaks, SQL plans and command results before cleanup. Repair root defects and rerun/redeploy this exact owned installation forward. Record that qualification itself left `seha`, duplicate recovery data and unrelated services untouched; the already-completed duplicate removal is accounted for by the parent's prerequisite receipt. Do not inspect secret contents.
6. Remove only resources in the owned disposable manifest after evidence collection. Configuration is synthetic; no production config copies, resets, migration, maintenance or app stops are allowed under this qualification procedure. A failed/unavailable fresh-installation check remains truthful and must be repaired/attempted; it does not reopen the resolved production-target question.

## Authorized target and duplicate-cleanup boundary

The production reset target is **resolved and authorized**: `seha` on localhost:3002, with exact labels/port/volume/state reverified before the initial command:

```powershell
pwsh ./deploy-local.ps1 start -Project seha -DbReset
```

This authorization does not erase the 5/5 software gate or identity/configuration safeguards. Preserve tenant/sign-in configuration, all secrets, backups and saved port/public URL. It authorizes application-data reset only, not Entra/provider changes.

The parent's separate duplicate cleanup is **already completed**, with the exact removed and retained resources listed in prerequisites. It used neither `--volumes` nor `--remove-orphans`. Keep `agent-control-phase01_data`, state/configuration/credentials/backups and recovery evidence; no erasure without a new explicit user request. Exclude unrelated workload services even if their names, ports or networks look similar; a later listener on port 3001 is not evidence this duplicate needs deleting again. This worker neither repeats nor broadens that completed action and never treats retained recovery data as a fixture or alternate production target.

Do not leave deployment pending under the old ambiguity. If verification reveals a real mismatch, stop before destructive work; if a user question is necessary, ask and actually wait for the answer rather than proceeding under autopilot.

## Validation commands and evidence

Run from root, with fixture scripts using only isolated synthetic credentials:

```powershell
pwsh -NoProfile -File ./scripts/large-tenant-tests.ps1 -Suite all
pwsh -NoProfile -File ./scripts/large-tenant-tests.ps1 -Suite fresh-installation
pwsh -NoProfile -File ./scripts/local-deployment.tests.ps1
pwsh -NoProfile -File ./scripts/large-tenant-tests.ps1 -Suite restart
```

Also `git diff --check`; capture scoped dirty diff/source digest rather than making a commit. Before container commands call the container configuration tool. The `all` result may satisfy the separate fresh-installation entry only if that exact suite actually ran and has complete evidence; do not create a second installation merely to duplicate it. Production commands are the authorized initial `seha` deploy and normal fix-forward redeploy above, subject to identity revalidation and all existing guards. Production HTTP observations use verified localhost:3002 and the unchanged saved public origin; disposable observations use their recorded unique fixture origin. Browser evidence covers Users, reporting/history, agents/details/responsibility and one small authorized export where real data is available; record unavailable data/auth separately.

New-schema restore and capacity failures must have repair attempts and production containment; they are not automatically passed because deployment works. Conversely a successful readiness response is not proof of signed-in semantic or large-tenant behavior. Preserve exact distinctions in the handoff.

## Scope guard and production continuation

README's Always-Deploy Production Contract is binding here. Deploy to the authorized `seha` project with truthful live evidence and bounded fix-forward handling, not unsafe feature exposure. Never bypass a safeguard. A literal safety refusal or physical identity mismatch leaves the campaign open with its exact blocker; only a real control-plane/access/authentication inability permits `deployment_pending`, not the old target ambiguity. Fresh disposable qualification and independent tests remain mandatory. If a necessary user question is asked, pause execution until the actual answer.

No commits/pushes/branches; preserve dirty changes. No credential content in logs, plan completions, screenshots or artifacts. No external-provider/Entra reset or mutation. Only this initial verified DB-only reset is authorized; future reset is not a generic repair step.

## Completion record and done conditions

Write exactly `completions/07-production-convergence.md` with:

- the explicit `seha` destructive-authorization receipt and immediate pre-reset label/port/volume/state revalidation evidence;
- fresh disposable installation ownership manifest, synthetic-configuration provenance, full official deploy/check commands, exact runtime image/schema hashes, qualification/observation evidence and cleanup;
- preserved `seha` configuration/secret/backups/port/public-URL evidence and the completed parent duplicate-cleanup prerequisite receipt, showing retained recovery data and unrelated workload services were not erased or modified by this worker;
- deployed worktree/image/schema hashes, official command/results, reset boundary and timestamps;
- complete attempted-check table and residual containment/owner/threshold/trigger;
- live user/data/provider/source/canonical status, observations and resource/headroom measurements;
- fix-forward changes/redeploys/retests, canary sample counts and uncertain/unavailable dimensions;
- isolated-resource cleanup and active incidents, operations handoff and exact next action for any blocked condition.

Complete production deployment only when exact `seha` identity was reverified, official deployment and observation actually occurred, working safe paths are demonstrated, and residual stages are narrowly contained with an owner. Do not report production deployed merely because the disposable installation passed, and do not reuse the resolved target ambiguity as `deployment_pending`. A genuine remaining blocker uses `deployment_pending` or `blocked_safety_check` according to README, with exact evidence and a resumable action; a necessary user question requires actually waiting for its answer.
