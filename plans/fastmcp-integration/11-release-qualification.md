# 11 - Release, recovery, and capacity qualification

## Mission

Qualify the complete cross-root revision and repair reproducible defects before production convergence. Produce truthful release/evidence artifacts and bounded residual obligations, not a test-only terminal result.

## Prerequisites

Read [README](README.md), every earlier manifest prompt through 10 including [03A](03A-shared-api-and-audit-origin.md), [04A](04A-api-agent-controls.md), [04B](04B-webapp-cutover-and-qualification.md), [04C](04C-api-webapp-production-release.md), and all fourteen earlier completion records, plus actual Part 1 acceptance. Verify current contracts/hashes/status against the independently deployed, user-accepted API/web baseline. Every earlier phase has a handoff; gaps are not silently completed requirements.

## Read first

- [Root runners](../../package.json), [backend runners](../../backend/package.json), [Compose](../../compose.yaml), [Dockerfile](../../Dockerfile), [local checks](../../deploy-local.ps1).
- [Fresh installation](../../scripts/fresh-installation.ps1), [persistence](../../scripts/persistence.tests.ps1), [restart](../../scripts/restart-runtime.tests.ps1), [browser smoke](../../scripts/browser-smoke.mjs), [capacity tooling](../../scripts/large-tenant-tests.ps1).
- [Azure runbook](../../docs/azure-production-deployment.md), [recovery](../../infra/disaster-recovery.md), new MCP fixtures/container/client/deployment scripts and integration docs from 01-10.

## Required implementation

1. Reconcile every README requirement with implemented owner and concrete tests. Repair defects in the owning modules and update affected completion records/contracts; do not solve missing behavior with docs, skipped fixtures, relaxed tests, or MCP-side business logic.
2. Execute the targeted auth/read/control/protocol suites, then existing aggregate backend/typecheck/build and directly affected frontend/browser/deployment checks. Check real test counts/skips and DB isolation, not only process exit codes.
3. Exercise cold install, existing-schema upgrade if changed, API/MCP restarts, graceful shutdown, key/client-secret rotation, OAuth state backup/recovery, cache loss, job waiting/resume, and sent-unknown reconciliation. Existing portal/session behavior and ephemeral API tokens remain intact.
4. Use fixed large synthetic cohorts to prove complete pagination, exact champion joins, bounded SQL/query counts, full description continuation, output bytes, request fan-out/deadlines, stable memory/CPU/storage, worker backpressure, and concurrent principal isolation.
5. Test prompt scenarios via protocol and each available real client. Keep SDK, deterministic, real-model, live-provider, recovery, and capacity evidence distinct; no fixture body becomes production proof.
6. Validate dependency/lock/license and secret/redaction checks using existing tooling. Inspect built image contents, users, effective feeds, secret handling, pinned digests, runtime resource budgets, and absence of app database credentials in MCP.
7. Reuse the accepted Part 1 API artifact/receipt when unchanged; package only changed API content and the MCP image using existing local source-snapshot/image-ID receipts, schemas/configuration/contract versions and non-secret dependency evidence. A local Docker image ID is not proof of registry publication or an App Service deployment. Uncommitted changes require content hashes; do not commit just to create an identifier.
8. Reuse existing qualification entry points, 03A parity fixtures, 04B coverage evidence and 09's corpus; extend only a missing selector/case, not a new release runner/framework. Record commands, environment identities, sample/case counts, outputs, measured limits and cleanup status in this exact completion record. Never embed UPNs/customer descriptions/tokens in evidence.
9. For every residual, record affected scope, narrow release containment, production signal/canary, numeric alert threshold tied to the measured/runtime contract, operating owner, exact fix-forward trigger, and resumable proof command.
10. Hand off 08's exact `seha` local preflight/start/resume commands, safe source refresh/client onboarding, provider canary restoration, fixed observation duration/samples/thresholds, root repair/redeploy and targeted cleanup. Verify pending release/ingress approvals explicitly. Reconcile Azure tooling results separately; absent Azure access/registry publication is not a local production prerequisite.
11. Qualify the canonical-route map end to end for web and MCP read/control operations. Verify equivalent data/defaults/eligibility/effects/errors under matched principal/input/source/prestate and web availability without MCP. Separately prove origin fields for the same admin across both channels and reported/unknown calling clients/agents.
12. Qualify the audit upgrade and append/projection/job/CSV/UI lifecycle: historical unknown, real actor versus calling agent versus managed target, direct SQL/quarantine writers, mixed children, retries/restart, idempotent cross-client replay, separate resume context, bounded inert metadata, spoof rejection, retention/privacy, and schema/DTO/artifact agreement.
13. Reconcile the complete 04B web feature/route map and 04C production receipt with the MCP release. Reuse valid first-release proof and run affected regressions; verify no route/default/effect was redesigned only for MCP. Any material API/web change must have the required renewed deployed web validation and actual user acceptance. Do not overwrite the first release receipt or label it MCP proof.

## Scope guard

No test-only completion, indiscriminate full-suite repetition, additional production deployment in this phase, broad reset, synthetic writes to customer targets, public dependency fallback, fabricated measurements, or bypass of Part 1 acceptance. The independent 04C release has already occurred; 12 owns the MCP release.

## Validation

- Run focused Python/API suites, then `npm run typecheck --workspace backend`, `npm run build`, and the repository's documented full isolated backend/local check path, including `pwsh ./deploy-local.ps1 check` where prerequisites are available.
- Run the complete Python test suite and configured static/type checks in the MCP test image.
- Run changed PowerShell deployment suites, protocol/client scenario corpus, named browser regressions, and fixed-budget capacity/recovery runs; collect exact pass/fail/skip counts.
- Include 03A's migration/origin/parity backend suites, frontend AuditLogView/API/routing suites, Python attribution/route-capture suites, and paired browser/MCP cases. Origin schema/writer gaps are explicit affected-write residuals, not a silent unknown fallback for new requests.
- Record external failures accurately and continue independent checks/fixes. Keep secret values in approved terminal/storage only.
- Run link/config/artifact/receipt validation and `git diff --check`; follow README approved feeds for all dependency subprocesses.

## Production continuation

Apply README's Always-Deploy and accepted-Part-2 contracts. Carry preproduction failures with containment, not a blanket deployment veto. Do not open unsafe paths, convert unknown to passed, or bypass acceptance; 12 remains the required second release/live-hardening outcome on `seha`, with Azure gaps owned separately.

## Completion record

Write `completions/11-release-qualification.md`: requirement/proof matrix, repaired roots/files, exact release hashes/digests, commands/case counts/results, measured limits, checkpoint/recovery evidence, residual operating owners/triggers, cleanup, and concrete 12 actions.

## Done and handoff

The complete release is reproducible, the implemented requirements are reconciled, and every unproven scope has operational containment/proof ownership. The campaign remains open until 12 deploys, observes, and hardens the exact approved production revision.
