# 12 - Production deployment and live hardening

## Mission

Deploy MCP beside the independently deployed, user-accepted API/web app in the current-host `seha` Compose project under an explicitly approved local change; qualify it live, repair root defects forward, and hand off operations. A readiness report or deploy command alone does not finish this second release. Azure hosting support is retained as tooling, not a production migration.

## Prerequisites

Read [README](README.md), [04C](04C-api-webapp-production-release.md), [08](08-local-container-integration.md), [10](10-azure-deployment-integration.md), [11](11-release-qualification.md), all prior completion records, actual `completions/PART-1-ACCEPTANCE.md`, and campaign state. Verify the current-host `seha` target and separately approved Part 2 release/resources/ingress/provider-canary boundary. Neither planning-target selection nor Part 1 deployment approval authorized MCP live resources/exposure.

If the operator has not explicitly approved the exact release and allowed actions, ask through the supported user-question tool, stop, and wait for the actual answer. Do not ask for secrets in chat or infer reset/mutation/ingress permission from existing files, credentials or historical `seha` receipts. Complete independent fixture/tooling work before asking.

## Read first

- [Local entry point](../../deploy-local.ps1), [deployment implementation](../../scripts/local-deployment.ps1), [artifact/runtime/receipts](../../scripts/local-runtime.ps1), [Compose](../../compose.yaml), [maintenance](../../docs/operations.md#existing-installation-maintenance), [backup/restore](../../docs/operations.md#backup-and-isolated-restore).
- Local API/MCP container/storage/ingress/monitoring/containment runbooks implemented in 04C/08; actual source/image identities, residual cases, thresholds and checkpoint requirements from 11. Read 10's Azure limitations as separate tooling evidence, not local release instructions.
- [Security](../../docs/security-model.md), [usage semantics](../../docs/official-usage-import.md), [canary restoration](../../docs/mutation-canaries.md), client onboarding/workflows from 09.

## Required implementation and execution

1. Reconcile true evidence/risk states and approved local identities: current host/Docker context, `seha` project and app/postgres/mcp services, `seha_default`, existing `seha_data`, dedicated `seha_mcp_oauth`, saved origin/port/configuration binding, registrations/scopes/roles, approved secret/key references, exact callbacks/ingress, source/image hashes, resource budget, maintenance window and intended tool exposure. Never hardcode a customer tenant into application behavior.
2. Verify current accepted portal/API health, route/schema compatibility and strongest available durable-state checkpoint, including historical unknown audit/job records. Start from 04C's already upgraded schema; do not rerun a prior upgrade/reset to introduce MCP. Record timestamp/identity/restore evidence; no restore drill means unknown recovery proof, not permission to reset.
3. Keep 08's extended read-only local preflight inside the existing start/Deploy workflow before production mutation; inspect project/action/source/image/schema/allowlist/approval differences. No new local Plan entry point. Obtain renewed approval for actual boundary mismatch rather than widening it. Deploy safe code/observability/unaffected paths forward with residual-specific containment from 08/11. Azure CLI, registry upload and Key Vault provisioning are not prerequisites.
4. Deploy the pinned MCP image and approved API/configuration changes using `pwsh ./deploy-local.ps1 start -Project seha` and 08's resumable local workflow, without `-DbReset`. Preserve both release receipts and existing data/settings/secrets. Reuse unchanged API/web content; build only what the existing workflow requires and verify unchanged snapshot identity. Material shared-contract changes require README's renewed web validation/user acceptance. Do not change grants, public ingress, host resources or unrelated projects outside approval.
5. Verify exact live source content and actual Docker image IDs, API/MCP health/readiness, safe approved headers/ingress, OAuth discovery/callback/PKCE, persistent encrypted state, audience-correct delegation, Viewer/Admin/guest private scope, claims challenges/refresh, and denied wrong-tenant/audience calls. Local readiness alone is not remote-client OAuth proof.
6. Qualify reads using 09's acceptance cases A-C under README's proven isolated tenant/principal/provider data boundary and approved saved-data canaries without exporting confidential content. Exercise all pages/About text, champion-only relationships, explicit refresh, supported/incomparable trends and source freshness. No customer report-selection changes, synthetic global sync or live fixture-auth mode. Provider canaries use only exact disposable approved targets, never a synthetic identifier that can resolve to a real customer target. Unavailable isolation keeps that live case open, not permission to pollute customer data.
7. Attempt real onboarding/tool calls for Copilot Studio and Microsoft 365 publication path, VS Code/GitHub Copilot, Claude, and the available customer cowork client. Verify actual interactive preview/confirmation and externally scheduled no-pause execution. Record unavailable client/account evidence separately; never claim universal support from SDK fixtures.
8. Exercise both block/unblock and quarantine/unquarantine only on explicitly approved disposable exact provider targets. Capture prestate, submit idempotently, observe item readback, restore the exact approved prestate, and verify it. No production department-wide or last-three-days bulk canary.
9. Verify API/MCP restart, persistent OAuth refresh, API ephemeral-cache loss and explicit same-user job resume, revoked-grant fences, sent-unknown reconciliation, bounded workload/backpressure, safe audit/correlation, monitoring/budget alerts, and unrelated portal workflows.
10. Observe the exact deployed revision for 08/11's concrete recorded duration/sample set, with auth/error/latency/queue/readback/persistence/current-host resource signals and numeric alert thresholds. Measure unrelated portal/API health before and after tool exposure. Do not mark an unmeasured quiet period healthy or a queued write completed.
11. For live defects: contain only the affected authority/tool exposure, identify root cause, implement the owning fix across all consumers, run focused tests, redeploy an exact new revision, and repeat the affected/live-regression canary. Do not bypass scope/provider checks, restore a superseded writer, or compensate with misleading answers.
12. Open contained scopes in dependency order only after their live authority/behavior is proven. If required scopes remain contained/unproven, record `production_hardening_pending` and keep iterating; deployed infrastructure alone is not completion.
13. Clean only exact approved disposable fixture resources/artifacts, revoke temporary test grants where approved and restore canary state. Never delete `seha` volumes/settings/secrets or unrelated host projects; production OAuth state is not disposable test output. Cleanup failure remains an owned cost/security incident with threshold/trigger, in parallel with production hardening.
14. Finalize operational docs, dashboards/alerts/owners, backup/key-rotation/reconnect/recovery procedures, current exact release receipts, known supported limitations, and customer onboarding instructions. Keep all facts secret-free and distinguish deployed/proven/unavailable.
15. Verify both interfaces call the same live canonical routes for matched agent/user listing and control intents. On approved disposable targets, observe the same authorized admin submitting through web and MCP with provider prestate restored between comparisons; do not use a real customer bulk selection to demonstrate parity.
16. Inspect persisted audit origin through web table/filter/details/CSV and MCP audit tools: verified user/channel/integration, available reported or authenticated client/agent fields with correct per-field evidence, unknown unsupported/historical values, parent/item/provider events, and provenance retained through restart/replay. A web lifecycle request on an MCP-origin job must not relabel the initial operation. Do not publish customer labels/UPNs in the completion receipt.

## Scope guard

No inferred live approval, Azure deployment/provisioning, automatic public ingress/tunnel, production reset/volume deletion/secret regeneration, broad cleanup, live bulk customer mutation, service-account fallback, relaxed authentication, hidden approval-policy/scheduler feature, fabricated measurements, commit/push/branch or test-only terminal state.

## Validation

- Use 08/11's exact local preflight/start/resume/canary commands with verified `seha` labels and approved release. Record snapshot hashes and live image IDs, not mutable tags alone. Do not run isolated test/lifecycle/restore runners against production.
- Attempt every residual live canary/client/provider/recovery case; record concrete outputs, dates, revisions, scope, sample counts, and pass/fail/unavailable/inconclusive states.
- After each fix, rerun its smallest behavior suite, relevant shared contract checks, and exact live canaries; rebuild/redeploy content-pinned artifacts.
- Verify unrelated portal/API health before/after exposure changes; check receipts, link/docs consistency, redaction, and `git diff --check`.
- No dependency/lock/build subprocess may bypass README feeds. Secrets remain in approved interactive terminal/secret storage.

## Production continuation

Apply README's Always-Deploy and two-part contracts. After actual Part 1 acceptance, Part 2 converges on `seha` deployment, observation and verified tool exposure while preserving the accepted web baseline. Missing separate release approval or literal inability to execute authorized local production actions leaves `deployment_pending` with exact owner/action; unavailable Azure access does not. Safe paths deploy despite preproduction gaps. Required remote-client/authority paths without approved reachability or proof remain contained as `production_hardening_pending` until fixed/proven. Neither pending state nor `awaiting_user_acceptance` is full-campaign completion.

## Completion record

Write `completions/12-production-convergence.md` under README's completion contract with approved `seha` host/context/project/release/ingress references, exact source/live image/content hashes, secret-free service/network/volume/receipt identities, checkpoint/upgrade evidence, live shared-route and origin/UI/CSV/MCP observations, query/control/client/restart proof, root-fix/redeploy history, canary restoration/cleanup, alert/operating owners and attribution/client limitations. State explicitly that Azure tooling was validated but no cloud production deployment is claimed.

Update `completions/IMPLEMENTATION_CAMPAIGN.md`. If externally blocked, record `deployment_pending` or `production_hardening_pending` truthfully and the exact resumable next action; never mark all phases done or manufacture a successful deployment.

## Done and handoff

The exact approved API/MCP revision is deployed in the existing `seha` Compose project, live-observed and stable; agreed read/control workflows and both execution modes are proven, canary prestate is restored, unrelated portal behavior remains intact, and operations ownership is explicit. Unavailable proof for a promised client/tool keeps its requirement open with a precise owner/action rather than a blanket success claim. Future Azure live qualification is an explicitly separate hosting obligation, not an excuse to skip or mislabel this production release.
