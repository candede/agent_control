# 12 - Production deployment and live hardening

## Mission

Deploy MCP beside the independently deployed, user-accepted API/web app under an explicitly approved exact Azure change; qualify it live, repair root defects forward, and hand off operations. A readiness report or deploy command alone does not finish this second release.

## Prerequisites

Read [README](README.md), [04C](04C-api-webapp-production-release.md), [10](10-azure-deployment-integration.md), [11](11-release-qualification.md), all prior completion records, actual `completions/PART-1-ACCEPTANCE.md`, and campaign state. Resolve the separately approved Part 2 target/change and bounded resource/provider-canary contract. Neither plan drafting nor the first API/web deployment approval authorized MCP production resources/exposure.

If the operator has not explicitly approved the exact production target and allowed actions, ask for that approval through the supported user-question tool, stop, and wait for the actual answer. Do not ask for secrets in chat or infer permission from existing files/credentials/historical `seha` approvals. Complete independent local work before asking.

## Read first

- [Azure entry point](../../deploy-azure.ps1), [deployment implementation](../../scripts/azure-deployment.ps1), [production guide](../../docs/azure-production-deployment.md), [target example](../../infra/production-target.example.json), [recovery](../../infra/disaster-recovery.md).
- API/MCP deployment/container/storage/monitoring/containment runbooks implemented in 08/10; release digests, residual proof cases, and checkpoint requirements from 11.
- [Security](../../docs/security-model.md), [usage semantics](../../docs/official-usage-import.md), [canary restoration](../../docs/mutation-canaries.md), client onboarding/workflows from 09.

## Required implementation and execution

1. Reconcile true evidence/risk states and explicitly approved target identities: tenant, subscription, region/resource group, API/MCP/plan/registry/storage/Key Vault resources, registrations/scopes/roles, secret versions, exact origins/callbacks, image/artifact hashes, budget, maintenance/change window, and intended exposure.
2. Verify current accepted portal/API health, route/schema compatibility and strongest available durable-state checkpoint, including historical unknown audit/job records. Start from 04C's already upgraded schema; do not rerun a prior upgrade/reset to introduce MCP. Record timestamp/identity/restore evidence; no restore drill means unknown recovery proof, not permission to reset.
3. Run the existing extended `Plan` workflow against the approved target; review resource/approval/digest differences. Obtain renewed approval for actual target/change mismatch rather than widening it. Deploy safe code/observability/unaffected paths forward with residual-specific containment from 10/11.
4. Deploy the immutable MCP image and explicitly approved API/configuration changes through the extended existing Deploy workflow, preserving resumable receipts and the separate 04C baseline. Unchanged API/web artifacts need not be redeployed solely to introduce MCP. Material shared business-contract changes need README's renewed web validation/user acceptance. Never change grants, roles, network rules, SKU/budget or unrelated services outside approval.
5. Verify the exact live content revision/image digest, API/MCP health/readiness, safe headers/ingress, OAuth discovery/callback/PKCE, persistent encrypted state, audience-correct delegation, Viewer/Admin/guest private-scope behavior, claims challenges/refresh, and denied wrong-tenant/audience calls.
6. Qualify reads against isolated synthetic namespaces where needed and approved authorized saved data without exporting confidential content. Exercise the three user prompts, all pages/About text, champion-only relationships, explicit refresh, supported/incomparable trends, and source freshness.
7. Attempt real onboarding/tool calls for Copilot Studio and Microsoft 365 publication path, VS Code/GitHub Copilot, Claude, and the available customer cowork client. Verify actual interactive preview/confirmation and externally scheduled no-pause execution. Record unavailable client/account evidence separately; never claim universal support from SDK fixtures.
8. Exercise both block/unblock and quarantine/unquarantine only on explicitly approved disposable exact provider targets. Capture prestate, submit idempotently, observe item readback, restore the exact approved prestate, and verify it. No production department-wide or last-three-days bulk canary.
9. Verify API/MCP restart, persistent OAuth refresh, API ephemeral-cache loss and explicit same-user job resume, revoked-grant fences, sent-unknown reconciliation, bounded workload/backpressure, safe audit/correlation, monitoring/budget alerts, and unrelated portal workflows.
10. Observe the deployed revision for the runbook's recorded interval/sample set with explicit auth/error/latency/queue/readback/persistence/resource signals and alert thresholds. Do not mark an unmeasured quiet period healthy or a queued write completed.
11. For live defects: contain only the affected authority/tool exposure, identify root cause, implement the owning fix across all consumers, run focused tests, redeploy an exact new revision, and repeat the affected/live-regression canary. Do not bypass scope/provider checks, restore a superseded writer, or compensate with misleading answers.
12. Open contained scopes in dependency order only after their live authority/behavior is proven. If required scopes remain contained/unproven, record `production_hardening_pending` and keep iterating; deployed infrastructure alone is not completion.
13. Clean only exact approved disposable resources/artifacts, revoke temporary test grants where approved, and restore canary state. Cleanup failure remains an owned cost/security incident with threshold/trigger, in parallel with production hardening.
14. Finalize operational docs, dashboards/alerts/owners, backup/key-rotation/reconnect/recovery procedures, current exact release receipts, known supported limitations, and customer onboarding instructions. Keep all facts secret-free and distinguish deployed/proven/unavailable.
15. Verify both interfaces call the same live canonical routes for matched agent/user listing and control intents. On approved disposable targets, observe the same authorized admin submitting through web and MCP with provider prestate restored between comparisons; do not use a real customer bulk selection to demonstrate parity.
16. Inspect persisted audit origin through web table/filter/details/CSV and MCP audit tools: verified user/channel/integration, available reported or authenticated client/agent fields with correct per-field evidence, unknown unsupported/historical values, parent/item/provider events, and provenance retained through restart/replay. A web lifecycle request on an MCP-origin job must not relabel the initial operation. Do not publish customer labels/UPNs in the completion receipt.

## Scope guard

No inferred approval, broad reset/destructive cleanup, live bulk customer mutation, service-account fallback, relaxed authentication, hidden approval-policy/scheduler feature, fabricated measurements, commit/push/branch, or test-only terminal state.

## Validation

- Use exact Plan/Deploy/qualification commands from 10/11 with the approved target, not copied guessed resource names.
- Attempt every residual live canary/client/provider/recovery case; record concrete outputs, dates, revisions, scope, sample counts, and pass/fail/unavailable/inconclusive states.
- After each fix, rerun its smallest behavior suite, relevant shared contract checks, and exact live canaries; rebuild/redeploy content-pinned artifacts.
- Verify unrelated portal/API health before/after exposure changes; check receipts, link/docs consistency, redaction, and `git diff --check`.
- No dependency/lock/build subprocess may bypass README feeds. Secrets remain in approved interactive terminal/secret storage.

## Production continuation

After the mandatory Part 1 user acceptance, Part 2 must converge on deployment, observation, and verified tool exposure while preserving the accepted web baseline. Missing separate approval/control-plane access leaves `deployment_pending` with exact owner/action. Safe paths continue despite preproduction gaps; unsafe required paths remain `production_hardening_pending` until fixed/proven. Neither pending state nor the earlier `awaiting_user_acceptance` state is full-campaign completion.

## Completion record

Write `completions/12-production-convergence.md` with approved target/change references, exact deployed artifact/image/content hashes, secret-free resource/receipt identities, checkpoint/upgrade evidence, live shared-route and origin/UI/CSV/MCP observations, query/control/client/restart proof, root-fix/redeploy history, canary restoration/cleanup, alert/operating owners, and remaining supported attribution/client limitations.

Update `completions/IMPLEMENTATION_CAMPAIGN.md`. If externally blocked, record `deployment_pending` or `production_hardening_pending` truthfully and the exact resumable next action; never mark all phases done or manufacture a successful deployment.

## Done and handoff

The exact approved production API and MCP revision is deployed, live-observed, and stable; agreed read/control workflows and both execution modes are proven, canary prestate is restored, unrelated portal behavior remains intact, and operations ownership is explicit. Unavailable proof for a promised client/tool keeps its requirement open with a precise owner/action rather than an unsupported blanket success claim.
