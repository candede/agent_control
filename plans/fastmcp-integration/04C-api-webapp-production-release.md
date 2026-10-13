# 04C - API/web production release and manual-test handoff

## Mission

Deploy and live-observe Part 1 as the existing API/web application without MCP, then stop for the user's manual web testing and acceptance. This first release is real production convergence, not a readiness artifact or implicit authorization to begin Part 2.

## Prerequisites

Read [README](README.md), [04B](04B-webapp-cutover-and-qualification.md), all Part 1 completion records through 04B, and campaign state. Resolve the exact operator-approved API/web production target and bounded schema/application changes. Drafting this plan authorizes no production action. If target/change approval is missing, ask through the supported question tool and wait for the actual answer; never request secrets in chat.

## Read first

- [Azure entry point](../../deploy-azure.ps1), [deployment helpers](../../scripts/azure-deployment.ps1), [deployment tests](../../scripts/azure-deployment.tests.ps1), [production guide](../../docs/azure-production-deployment.md).
- [Target example](../../infra/production-target.example.json), [Bicep](../../infra/main.bicep), [recovery](../../infra/disaster-recovery.md), [local deployment](../../deploy-local.ps1), [local helpers](../../scripts/local-deployment.ps1).
- [Database operator](../../backend/scripts/database.ts), [schema verifier](../../backend/src/db/schema.ts), upgrade implementation from 03A and any 04/04A schema changes, qualification artifact/manual checklist from 04B.

## Required implementation and execution

1. Resolve exact approved tenant/subscription/resources, existing Node App Service/PostgreSQL target, artifact/content hashes, schema/route/DTO versions, allowed changes, maintenance window, budget, and disposable provider canaries. No MCP App Service, registry/image, mount, Python runtime, or MCP OAuth secret/connection setup.
2. Before deployment, wire Part 1's exact-prior-schema forward upgrades and checkpoints into existing local/Azure Plan/Deploy/resume tooling. 03A/04/04A own schema semantics; this phase owns deployment sequencing, prior-schema verification, target/approval safety, artifact receipts, interrupted/resumed upgrade and historical data preservation. 08/10 later extend this same workflow rather than implementing the first upgrade path.
3. Extend only necessary existing tooling/contracts for the API/web release, using existing mock executor/PowerShell tests. Keep no-MCP target files fully valid. Explicitly unsupported/unconfigured bearer admission stays closed through validated configuration/admission; missing MCP configuration cannot fail browser startup or trigger provisioning. No fabricated permissive client IDs or public bearer access.
4. Reconcile true qualification residuals with exact affected scope, containment, numeric telemetry/alert threshold, owner, and fix-forward action. Critical existing web behavior must not silently disappear behind containment: unresolved browser regressions remain open and are shown to the user. Record current web/API health and strongest available durable-state checkpoint/restore evidence; never reset data.
5. Run existing Plan against the approved target, check approval/resource/artifact differences, deploy the content-pinned API/web artifact and safe upgrades, and retain redacted resumable receipts. Renew approval for actual target/change mismatches. Part 1 deployment approval does not authorize later MCP resources/exposure.
6. Verify exact live revision, health/readiness, cookie sign-in/out/Origin/CSRF, Viewer/Admin/private scope, key current pages/reads, full detail/report semantics, uploads/exports, explicit refresh/investigations and job recovery. Inspect audit Origin/details/filter/CSV, preserved historical unknown, and stable append/projection behavior. Prove no MCP dependency in runtime/network/configuration.
7. Exercise block/unblock and quarantine/unquarantine only on explicitly approved disposable exact targets, recording prestate, provider effect, item readback and restored prestate. Do not run a real department-wide or last-three-days bulk canary. Any unavailable provider proof stays an explicit manual-test limitation; synthetic direct bearer proof never becomes live MCP evidence.
8. Observe the exact API/web release for the existing runbook's declared interval/sample set, using actual health/auth/error/latency/queue/audit/upgrade/resource signals and thresholds. For defects: contain narrowly, repair the Part 1 root, run focused tests, redeploy a new pinned artifact, and repeat affected live/browser regressions.
9. Give the user the actual deployed URL/revision and a concise feature-by-feature manual checklist from 04B, approved test targets, expected unchanged effects, audit additions, known unproven scope, and a safe bug-report/fix-forward handoff. Manual testing must not need MCP or authorize unapproved bulk writes.
10. Write the Part 1 deployment/observation completion record and set campaign state to `awaiting_user_acceptance`; leave 05 pending. Stop here. Do not generate `PART-1-ACCEPTANCE.md` as accepted, launch MCP workers, provision resources, or continue merely because tests passed.
11. On the user's later actual response, repair reported regressions through this same loop. Once the user explicitly accepts the exact deployed revision and authorizes Part 2, record the supporting `completions/PART-1-ACCEPTANCE.md` defined in README. If acceptance or start authorization is unclear, ask one question and wait. This user-owned rollout gate is not a per-command application approval system.

## Scope guard

No MCP implementation/dependency/resource/exposure, inferred production approval, destructive reset, arbitrary customer mutation, intentional current web behavior change, automatic Part 2 continuation, fictional acceptance, or claim of universally bug-free behavior.

## Validation

- Run changed existing local/Azure deployment suites with upgrade/receipt/no-MCP target/approval tests and available Bicep validation. Test interrupted/resumed upgrades and existing audit/job preservation using isolated fixtures.
- Use 04B's content-pinned artifact and exact documented Plan/Deploy commands for the approved target; validate live content hashes/schema versions and before/after health.
- Attempt every applicable Part 1 live regression/recovery/canary; record commands, timestamps, exact scope/sample counts, restored canary prestate, and passed/failed/unavailable/inconclusive results.
- After each root fix, run its smallest suite and relevant browser/API regression, rebuild/redeploy, and refresh the receipt/manual handoff for the new revision.
- Verify no MCP/Python dependency or provisioning and no omitted user-acceptance pause. Run documentation/link/redaction checks and `git diff --check`; obey README feeds.

## Production continuation

Apply README's Always-Deploy contract within Part 1. Missing approved target/control-plane access leaves `deployment_pending`; unresolved live issues leave `production_hardening_pending` with exact resumable actions. Once deployed/observed and handed off, `awaiting_user_acceptance` is the required user-requested boundary, not permission to proceed to MCP. Keep full campaign completion open until accepted Part 2 later converges in 12.

## Completion record

Write `completions/04C-api-webapp-production-release.md`: exact target/change approval references, API/web revision/content/schema/route hashes, upgrade/checkpoint/production receipts, live observation and before/after health, provider prestate restoration, true residuals, deployed URL and manual checklist, user-acceptance state, and explicit pending 05 prerequisites. Update `completions/IMPLEMENTATION_CAMPAIGN.md`; preserve this first release record separately from later 12 evidence.

## Done and handoff

Part 1 API/web is independently deployed and observed without MCP, and the user has a concrete manual-test handoff. Execution stops. Only actual acceptance of the deployed revision and explicit Part 2 authorization can unlock 05.
