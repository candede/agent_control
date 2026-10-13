# 04C - API/web production release and manual-test handoff

## Mission

Deploy and live-observe Part 1 in the existing current-host `seha` Compose project without MCP, then stop for the user's manual web testing and acceptance. This first release is real production convergence, not an Azure migration, readiness artifact or implicit authorization to begin Part 2.

## Prerequisites

Read [README](README.md), [04B](04B-webapp-cutover-and-qualification.md), all Part 1 completion records through 04B, and campaign state. Verify README's current-host `seha` target and obtain explicit approval for this exact API/web release, maintenance/checkpoint/upgrade actions and disposable provider canaries. Selecting the planning target did not authorize execution. If change approval is missing, ask through the supported question tool and wait for the actual answer; never request secrets in chat.

## Read first

- [Local entry point](../../deploy-local.ps1), [deployment helpers](../../scripts/local-deployment.ps1), [artifact/runtime/receipts](../../scripts/local-runtime.ps1), [deployment tests](../../scripts/local-deployment.tests.ps1), [runtime tests](../../scripts/local-runtime.tests.ps1).
- [Compose](../../compose.yaml), [existing-installation maintenance](../../docs/operations.md#existing-installation-maintenance), [backup/restore](../../docs/operations.md#backup-and-isolated-restore), [recovery](../../infra/disaster-recovery.md).
- [Database operator](../../backend/scripts/database.ts), [schema verifier](../../backend/src/db/schema.ts), upgrade implementation from 03A and any 04/04A schema changes, qualification artifact/manual checklist from 04B.

## Required implementation and execution

1. Resolve exact current host/Docker context, `seha` project/service/network/volume labels, existing configured origin/port, non-secret tenant-registry binding, artifact/content hashes, starting/final schema/route/DTO versions, allowed changes, maintenance window, resource budget and disposable provider canaries. Preserve the existing app/PostgreSQL installation and `seha_data`; no MCP image/volume/runtime/OAuth setup or Azure resource action.
2. Before deployment, wire README's complete known-fingerprint forward-upgrade chain and protected checkpoint into existing local preflight/Deploy/resume tooling. Schema owners supply semantics; this phase owns acceptance of only the recognized starting fingerprint, checkpoint before mutation, admission/worker drain, ordered upgrades, final schema/grant verification, interrupted/resumed execution and historical preservation. The current `start` rejects mismatched schemas, so extending it is required; `-DbReset` and marker editing are forbidden. 08 extends this same local workflow and 10 reuses its contracts for Azure tooling.
3. Extend only necessary local tooling/contracts, using existing mock executor/PowerShell tests. Preserve valid no-MCP settings/start paths and separate hard project/identity/action safety checks from qualification residuals; do not suppress errors or weaken tests. Explicitly unsupported/unconfigured bearer admission stays closed without failing browser startup or provisioning MCP. No fabricated permissive client IDs.
4. Reconcile 04B's actual evidence using README's residual contract. Set a concrete observation duration, sample/canary counts, resource ceilings and numeric alert thresholds in the existing runbook before release; carry unknown measurements honestly. Existing web regressions remain open and visible to the user. Record current web/API health and strongest available durable-state checkpoint/restore evidence.
5. Use `pwsh ./deploy-local.ps1 start -Project seha` without reset, keeping its extended read-only project/action/content/schema preflight before drain/upgrade. Do not invent a separate local Plan command or competing deployment entry point. Deploy the content-pinned API/web release and ordered safe upgrades; record exact source snapshot/image IDs and resumable receipt. Requalify changed content and renew approval for actual boundary mismatches. Build/preflight failures must not drain production. Part 1 approval does not authorize later MCP resources/exposure.
6. Verify exact live revision, health/readiness, cookie sign-in/out/Origin/CSRF, Viewer/Admin/private scope, current pages/reads, full detail/report semantics, exports, explicit refresh/investigations and job recovery. Upload/write tests require README's approved isolated tenant/principal/provider data boundary; do not change customer shared/latest-report selection or introduce fixture authentication. Inspect audit Origin/details/filter/CSV, preserved historical unknown, and stable append/projection behavior. Prove no MCP dependency in runtime/network/configuration.
7. Exercise block/unblock and quarantine/unquarantine only on explicitly approved disposable exact targets, recording prestate, provider effect, item readback and restored prestate. Do not run a real department-wide or last-three-days bulk canary. Any unavailable provider proof stays an explicit manual-test limitation; synthetic direct bearer proof never becomes live MCP evidence.
8. Observe the exact API/web release for the runbook's now-recorded interval/sample set, using actual health/auth/error/latency/queue/audit/upgrade/host-resource signals and thresholds. For defects: contain narrowly, repair the Part 1 root, run focused tests in isolated fixtures, redeploy a new pinned artifact to `seha`, and repeat affected live/browser regressions. Never run test-database/restore/lifecycle suites against production.
9. Give the user the actual deployed URL/revision and a concise feature-by-feature manual checklist from 04B, approved test targets, expected unchanged effects, audit additions, known unproven scope, and a safe bug-report/fix-forward handoff. Manual testing must not need MCP or authorize unapproved bulk writes.
10. Write the Part 1 deployment/observation completion record and set campaign state to `awaiting_user_acceptance`; leave 05 pending. Stop here. Do not generate `PART-1-ACCEPTANCE.md` as accepted, launch MCP workers, provision resources, or continue merely because tests passed.
11. On the user's later actual response, repair reported regressions through this same loop. Once the user explicitly accepts the exact deployed revision and authorizes Part 2, record the supporting `completions/PART-1-ACCEPTANCE.md` defined in README. If acceptance or start authorization is unclear, ask one question and wait. This user-owned rollout gate is not a per-command application approval system.

## Scope guard

No MCP implementation/dependency/resource/exposure, Azure provisioning/deployment, inferred live approval, destructive reset, arbitrary customer mutation, intentional current web behavior change, automatic Part 2 continuation, fictional acceptance, or claim of universally bug-free behavior. Do not regenerate production secrets or delete any existing project volume.

## Validation

- Run `pwsh ./scripts/local-deployment.tests.ps1` and `pwsh ./scripts/local-runtime.tests.ps1` with new recognized-schema/upgrade/receipt/no-MCP/approval cases; run their additional affected selectors from 01. Test the full baseline-to-final chain, fresh-init parity, interrupted/resumed steps, historical audit/jobs and denied unknown schemas using isolated fixtures.
- Use 04B's source/artifact evidence and the extended local preflight plus `pwsh ./deploy-local.ps1 start -Project seha`; validate live image/content hashes, final schema/grants and before/after health. Backup uses the approved existing operator helper; restore proof uses only a separately named isolated database.
- Attempt every applicable Part 1 live regression/recovery/canary; record commands, timestamps, exact scope/sample counts, restored canary prestate, and passed/failed/unavailable/inconclusive results.
- After each root fix, run its smallest suite and relevant browser/API regression, rebuild/redeploy, and refresh the receipt/manual handoff for the new revision.
- Verify no MCP/Python dependency or provisioning and no omitted user-acceptance pause. Run documentation/link/redaction checks and `git diff --check`; obey README feeds.

## Production continuation

Apply README's Always-Deploy contract within Part 1 on `seha`. Missing exact-release approval or literal inability to execute approved local production actions leaves `deployment_pending`; unresolved live issues leave `production_hardening_pending` with exact resumable actions. Azure access is not a production prerequisite. Once deployed/observed and handed off, `awaiting_user_acceptance` is the required boundary, not permission to proceed to MCP. Full campaign completion stays open until accepted Part 2 converges in 12.

## Completion record

Write `completions/04C-api-webapp-production-release.md` under README's completion contract: `seha` host/context/project/change approval references, source and actual image/content/schema/route identities, complete upgrade/checkpoint/production receipts, live observation and before/after health, provider prestate restoration, true residuals, deployed URL and manual checklist reference, user-acceptance state, and exact pending 05 prerequisites. Update `completions/IMPLEMENTATION_CAMPAIGN.md`; preserve this first release record separately from 12 evidence.

## Done and handoff

Part 1 API/web is independently deployed and observed without MCP, and the user has a concrete manual-test handoff. Execution stops. Only actual acceptance of the deployed revision and explicit Part 2 authorization can unlock 05.
