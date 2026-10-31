# 03 - Verify and deploy locally

## Mission

Verify the integrated feature, deploy the current schema/application to the authorized local development installation, and prove ordinary sign-in automatically reaches Office adoption. Passing tests or green health endpoints alone do not finish the campaign.

## Prerequisites and read first

Read and obey [the roadmap README](README.md), especially its always-deploy local-runtime policy, and the implementation worker contract. Read the actual completion records:

- `completions/01-office-evidence-and-adoption-api.md`
- `completions/02-dashboard-and-users-adoption.md`

Read [local deployment](../../deploy-local.ps1), [deployment owner](../../scripts/local-deployment.ps1), [operations](../../docs/operations.md), [schema verification](../../backend/src/db/schema.ts), [software checks](../../backend/scripts/softwareChecks.ts), [Compose fixtures](../../compose.yaml), [larger fixture storage](../../compose.large-tenant-test.yaml), [Dockerfile](../../Dockerfile), and [browser configuration](../../frontend/playwright.config.ts).

Also read the [disposable fixture owner](../../scripts/large-tenant-tests.ps1), [SQL selectors](../../backend/scripts/largeTenantFixture.ts), [current-installation owner](../../scripts/fresh-installation.ps1), [restore tests](../../backend/scripts/largeTenantRestore.test.ts), and the README's verified baseline/evidence-reuse procedure.

## Scope and operating boundary

Own integrated validation, directly coupled defect repair, final operations documentation, `seha` deployment/reset, observation, exact test-resource cleanup, and factual handoff. No Azure/external deployment, commits/pushes, unrelated project resets, public registries, or fixture authentication/data in the deployed tenant database.

The user authorized local development replacement/reset, including the running app. Reverify `desktop-linux`, Compose project `seha`, `app`/`postgres`, volume `seha_data`, database `agentcontrol`, origin `http://localhost:3002`, and candidate/source identity before mutation. Preserve configuration, credentials, project volume, and unrelated services.

## Concrete work

### 1. Reconcile and verify the integrated artifact

Reconcile phase evidence against actual worktree/artifact identities. Run focused repair checks for concrete findings, then the relevant aggregates once using existing owners:

```bash
npm run build
npm run check:unused
git diff --check
pwsh ./deploy-local.ps1 check -Project seha
```

The build covers production compilation/backend type checking. `check` owns the full backend/frontend tests and frontend lint/typecheck in isolated databases, not the application database. Do not duplicate completed aggregates on the host. If this owner stops early or is unavailable, identify unattempted steps and run only the remaining infrastructure-free frontend checks using `npm run lint --workspace frontend`, `npm run typecheck --workspace frontend`, and `npm test --workspace frontend` as applicable. Preserve the actual database/aggregate failure or unavailability; repair/rerun as practical and continue authorized deployment under the README policy.

Reuse phase 02's focused/aggregate browser evidence only if source/artifact identity is unchanged. Otherwise rerun its exact combined browser-owner command with both desktop/mobile projects; `check` does not itself provide that browser proof.

For Docker backend tests importing frontend contracts, ensure current `frontend/src` is mounted/copied alongside current backend code; reused images must not test stale helpers. Keep approved registry configuration in builds/subprocesses. Restore/install declared tools only after a genuine missing-tool failure or manifest change.

Required integrated database/capacity proof:

- Fresh current-schema initialization, runtime grants, data accounting, retention/clear invalidation, interrupted/resumed derivation, and concurrent same-date correction.
- A faithful fixture at the existing 100,000-row app-report bound, plus a large department, multi-app overlap, unknown identities, and complete paginated reads. Verify exact full-dataset counts and champion ordering; no silent truncation.
- Enforced existing byte/row/request bounds and query-plan/index usage for new scans. Record actual runtime/memory/query measurements, not assumed performance. Fail the check if correctness requires materializing an unbounded browser/group result.
- Measure persisted bytes for representative observations and evaluate the twelve-month footprint against existing storage budgets. Distinguish measured storage from extrapolated capacity; explicit capacity failure must not silently shorten the approved retention or truncate people/history.
- Restore a current-schema fixture backup containing Office history into an isolated database, after original source generations have retired. Verify observation facts/counts/provenance, tenant isolation, revoked old selections/sessions, retained cleanup/clear fences, and byte accounting through the existing restore/reopen owner. This is not an old-schema upgrade or a promise to preserve the authorized reset's old data.
- Reset/fresh-init with directory-first and app-first publication, proving automatic derived history without direct helper invocation or imported agents.
- Live/fixture failures keep source availability and partial/stale/error metrics honest without new gates.

Own the Office scale, backup/restore, and first-run fixture additions here; extend the existing `report-source-scale`, `restore`, and `fresh-installation-current` owners/selections, not another runner. Ensure they actually exercise Office contracts, not only their pre-existing agent cases. Use the README's verified baseline variables:

```powershell
pwsh ./scripts/large-tenant-tests.ps1 -Suite report-source-scale -BaselineImage $baselineImage -BaselineImageId $baselineImageId
pwsh ./scripts/large-tenant-tests.ps1 -Suite restore -BaselineImage $baselineImage -BaselineImageId $baselineImageId
pwsh ./scripts/large-tenant-tests.ps1 -Suite fresh-installation-current -BaselineImage $baselineImage -BaselineImageId $baselineImageId
```

Do not rerun every suite after each fix. Invalidate proof selectively, repair the root contract, rerun affected selectors, and reconcile aggregate results once the artifact stabilizes.

### 2. Deploy and initialize the authorized local installation

Preflight with existing deployment tooling and read-only runtime identity/status checks. Record exact source revision/worktree identity, built image/artifact, schema fingerprint, target labels/origin, provider consent availability, and best-available checkpoint. Data retention is not requested; an optional protected existing-data backup must not be claimed as restorable into the new incompatible schema.

Use the normal deployment owner:

```powershell
pwsh ./deploy-local.ps1 start -Project seha -DbReset
```

This is the authorized database-only clean reset, not volume deletion. It clears saved inventory, users, reports/history, sessions, jobs, and other application database evidence. Do not modify settings/secrets or forge schema fingerprints to avoid initialization.

Do not add `-ForceChecks`, a feature flag, or an approval marker as a release/runtime prerequisite. If reset's result is uncertain, inspect and resume the existing operation; do not blindly request another reset. Once the new schema is initialized, later fix-forward starts use:

```powershell
pwsh ./deploy-local.ps1 start -Project seha
```

Verify the actual served revision/image and fingerprint. Check health/readiness, but continue to the journeys below. Non-passing predeployment evidence remains explicit and drives actual containment/repair/qualification, not a test-only terminal branch.

### 3. Prove ordinary first-run and affected journeys

Use real authorized browser sessions/provider data for the deployed installation. Do not manufacture application cookies or add runtime fixture mode. If sign-in/provider credentials require user interaction, record the specific missing action and complete independent proof; never pretend fixtures establish live provider access.

Required journeys:

1. After reset, sign in normally with a Viewer-capable account whose existing provider capabilities permit directory/license and Copilot report reads. Without admin presence, import, manual sync, feature-enable, inventory completion, or other intervention, normal read-only sync prepares directory/app sources and creates the first valid Office observation. Verify the real capabilities; Viewer role alone does not grant provider consent.
2. Before any agent CSV import, open the Office dashboard and Office Users adoption. Confirm paid denominator, seven-app scope, groups, per-app people counts, champions, and clear provider/report dates. The agent dashboard may truthfully remain empty.
3. Navigate company/department/app links to Users adoption. Match exact selected-observation counts/rankings across screens and people/group pages. Open a person and verify frozen Office evidence remains separate from any current profile/agent data.
4. Verify another authorized Viewer/Admin session reads the same tenant evidence even without provider collection permission; actor selections/tokens remain private. Real permission failures must be specific and must not hide saved data.
5. Reimport genuine authorized agent CSV reports if available and verify existing Agent adoption, Users/Agents report context, default Latest ordering, original group/champion semantics, and user-details agent totals. Report lack of genuine files honestly; it cannot block the Office journey.
6. Verify bookmark/Back/Forward/refresh/domain switches, independent baselines/pins, company/department/app filters, and desktop/mobile accessibility/loading behavior.
7. Verify automatic publication updates and idle selected-read renewal without manual restart, focus jumps, or cross-context data. Prove that recovery-only Office publication changes `users` without another Graph scan, and that a later point/source retirement does not move a historical pin. Exercise interruption/recovery with faithful disposable fixtures when changing provider/runtime availability would disturb unrelated local resources.

Do not wait for months or invent multiple live historical points. Use time-controlled isolated fixtures to prove two/three observations, baseline comparison, correction, twelve-month expiry, and historical license/department isolation. Distinguish that evidence from the actual first live observation.

A real denied permission, provider outage, or header-only report without a refresh date is a specific source limitation/unknown state, never a fabricated zero or implementation pass. Record the actual response and recovery action; unproven live workflow remains open for hardening. A missing source caused by broken automatic admission/publication is an implementation defect, not an external limitation.

### 4. Observe and fix forward

Observe the deployed revision for at least ten minutes, covering two normal five-minute idle checks, after the first available Office observation. Check sync/local-derivation errors, API failures, source freshness, selected-read renewal, agent-view regression, app health, and unrelated local service health.

Qualification alert thresholds:

- Any count/ranking mismatch, duplicate canonical provider-date point, tenant leak, source-clear resurrection, or fabricated zero is a correctness/security failure: repair immediately before claiming workflow proof.
- Any reproducible new Office endpoint 5xx, derivation failure without automatic recovery, or unintended first-run manual prerequisite triggers root-cause fix-forward.
- Any horizontal overflow or inaccessible view/context control at tested widths is a failed UI check.
- Existing provider throttling/permission/outage states are reported specifically; do not classify them as an implementation pass or invent restrictions.

Contain only invalid derived evidence through real existing failure/data-integrity controls; preserve working auth, ordinary automatic sync, agent views, and unaffected paths. Fix the root issue, run focused checks, redeploy the repaired artifact without another reset unless strictly required/authorized, and rerun the affected live/fixture canaries. Each unresolved residual needs scope, control, telemetry, numeric threshold, owner, and exact fix-forward action.

### 5. Clean up and hand off

Stop/remove only exact disposable projects, fixture databases/volumes, helper processes, and temporary files created for this campaign. Preserve `seha` running and unrelated Docker resources. Do not use Docker-wide prune, name-based process killing, wildcard deletion, or removal of the application volume. Cleanup failures stay owned incidents.

Own the final [operations](../../docs/operations.md) instructions: clean-reset consequence, current backup/isolated restore, automatic history/recovery, and honest first-run/report-import distinctions. Reconcile [data architecture](../../docs/data-architecture.md) and [licenses and usage](../../docs/copilot-license-usage.md) against phases 01/02's owned definitions; repair a contradiction with the parent and update its owning record, rather than create another metric/navigation authority.

## Production continuation

The README's always-deploy contract applies to the authorized **local development runtime**, not external production. No new human approval gate is required within that already approved boundary. Literal inability to deploy leaves `deployment_pending` with the exact command/resource/action to resume; incomplete real promised workflow proof leaves `production_hardening_pending`. Failed checks, unavailable genuine CSVs, or cleanup incidents do not become fake passes or test-only success.

## Completion record and done conditions

Write exactly `completions/03-verify-and-deploy-local.md`. Include:

- Actual deployed source/image/schema/target identity and reset/deployment actions.
- Focused/aggregate/fixture/restore/live/browser/capacity outcomes, exact commands/case counts, measured results, and evidence locations; distinguish identity-bound reused proof from newly run checks.
- First-run proof: which ordinary session triggered sync, source/observation publication order, absence of hidden prerequisites, and Office operation before agent import.
- Cross-screen reconciliation, original agent behavior, scope/access checks, idle observation duration/results, and recovered defects/redeployments.
- Cleanup and protected unrelated-resource baseline, documentation changes, and every residual's owner/containment/threshold/fix-forward trigger.
- Exact final state: complete, complete_with_risk, deployment_pending, or production_hardening_pending, without conflating mock/health/test evidence with live feature proof.

The campaign is complete only when the agreed feature is implemented and persistent, the authorized local deployment is observed, required journeys are proven with truthful evidence, and completion/campaign records are accurate. Do not relabel implementation-caused missing sources, broken first-run, or unimplemented historical drill-down as external limitations.
