# Phase 05 - Microsoft 365 Package Management Hardening

## Status

```yaml
phase_file: 05-package-management.md
phase_status: complete
outcome: completed_with_disabled_capabilities
validated_at_utc: 2026-09-08T22:38:12Z
execution_target: retained local Docker project agent-control-phase01; isolated PostgreSQL/browser/restart fixtures; no Azure or live provider changes
```

Phase 05 is implemented, independently reviewed and locally validated in the current worktree. The retained installation uses checksum-verified schema version 12 and remains a healthy two-service Express/React/PostgreSQL deployment at `http://localhost:3001`, with `authConfigured:false`. No branch, commit, push, Azure deployment, provider grant, tenant mutation, reset, campaign ledger, Phase 06 implementation, collector, transcript feature or future-ideas work was created.

Package list/detail and directory contracts are fixture-qualified. Block/unblock are implemented but remain `preview_disabled` because no approved live reversible canary was available. Access replacement and owner reassignment remain independently disabled: their current Microsoft Graph beta contracts do not provide the conditional-write/readback guarantees required by the Phase 05 safety boundary.

## Prerequisite Verification

Read the binding README, Phase 05 prompt, Phase 01-04 completion records, security/setup/provider guides and current linked Microsoft package operation documentation. Verified the current worktree's durable job/audit, ephemeral OAuth, independent role, capability, private snapshot, exact identity, route policy, account-generation fencing and Docker fixture contracts rather than relying only on predecessor records. Existing data, restricted secrets, volume, network, canonical origin and cumulative uncommitted work were preserved. Phase 04's applied migrations 1-6 were immutable. Phase 05 added migrations 7-12; every subsequent repair used a new forward migration after earlier SQL was applied.

## Delivered Contracts

- **Saved package observations:** Package list/detail reads use independently consented delegated or explicitly enabled, administrator-scope-approved application `CopilotPackages.Read.All`. Explicit refresh jobs retain metadata for seven days and typed allowlisted Graph snapshots for thirty days. Complete broad/exact snapshots publish atomically; failed, partial or narrower refreshes do not replace the last valid broad snapshot. Navigation and startup read saved data and perform no provider scan. Saved reads remain authorized independently of provider availability.
- **Exact normalized identity:** Saved rows retain the native Graph package ID plus source/type identity projections. Exact mutation reads resolve the requested native targets under the current principal scope and never substitute a Power Platform ID, display name or association candidate. Missing/stale targets fail rather than redirecting a write.
- **Consent and roles:** Reader authorizes saved list/detail and broad refresh. Operator can perform exact target reads, read-only reconciliation and only operation-safe controls. Administrator creates canary approval; a distinct Operator must claim and execute restoration. SecurityReader remains independent. Application identity is read-only and never used for mutation.
- **Directory boundary:** Access principals must be native Entra UUIDs. Exact user/group resolution rejects malformed IDs, duplicate principals, deleted/unresolved objects and a Graph response whose ID differs from the requested identity. Only users, security groups and Microsoft 365 groups are projectable; provider responses and concurrency are bounded.
- **Durable mutation intent:** Every available write requires an Operator, current capability, explicit `risk: true` preview, exact targets, frozen mutation prestate, actor, provider/endpoint/permission/rollback summary, confirmation hash and durable `Idempotency-Key`. Retry validates the canonical route intent, including action, scope, normalized/sorted targets, exact body and confirmation, before returning an existing job. Same-key changed intent returns conflict, including block-all retries after saved inventory changes.
- **Dispatch and concurrency:** Per-tenant/package advisory locks serialize local operations. Under the lock the worker rereads the exact target, compares frozen mutation state, revalidates the current account generation and role/capability, and reacquires delegated authorization. Account replacement/logout aborts active work; dispatch and post-readback publication are fenced after awaited provider work. A mutation dispatches once and is never automatically retried. Local serialization is not described as provider atomicity.
- **Verification and uncertainty:** HTTP `204` means accepted only. Bounded detail reads must observe exact semantic convergence before success. Timeout/non-convergence after dispatch remains durable `inconclusive`; completed and uncertain items never replay automatically. Audit records requested, started, succeeded, skipped, failed, inconclusive and verified transitions without tokens or unrestricted provider payloads.
- **Read-only reconciliation:** `POST /api/agents/bulk-jobs/:id/reconcile` requires current Operator identity and delegated `CopilotPackages.Read.All`, not a still-qualified write capability. It revalidates account generation and role before each target and before publication, honors cancellation, uses a 30-second bounded read, redacts provider errors, and classifies observed-applied, verified-not-applied/retry-eligible or conflict. Any subsequent write needs a fresh preview and confirmation.
- **Operation-specific safety:** Only block/unblock currently pass the code-owned safety gate. Access update fixtures prove exact full-payload preservation and readback, but product routes fail closed because no documented ETag/`If-Match` or equivalent protects the unselected collection from external lost updates. Reassignment fixtures prove the documented body exactly, but routes fail closed because detail exposes no owner field and the operation exposes no conditional-write contract.
- **Full-cycle canary:** `POST /api/agents/mutation-canaries` accepts only exact typed action/target/prestate/poststate from an Administrator and derives contract/configuration/delegated-auth identity server-side. Two current workflow-v3 approvals must be exact inverses. `POST /api/agents/mutation-canaries/:id/execute` accepts only `{ "confirmed": true, "restorationApprovalId": "<uuid>" }`; an Operator distinct from both approving principals claims the pair atomically. The original and restoration directions run as separate normal durable jobs. Qualification publishes atomically only after both succeeded jobs/items and exact provider readbacks are revalidated. Uncertain response, account/role loss, intervening change, and process loss never create qualification or replay.
- **Schema and deployment:** Migration 11 adds paired qualification/job/stage ownership, expires workflow-v1/v2 qualified authority, and converts interrupted workflow-v2 work to non-authoritative terminal evidence. Migration 12 separates seven-day jobs from thirty-day verified evidence and expires the paired evidence as one cycle. Publication must still prove both durable jobs/items; retained job UUIDs become non-resumable evidence references after job expiry. Runtime cannot delete qualifications or mutate applied migration history. The final retained Docker deployment verified migrations 1-12 and exactly `app` plus `postgres`.
- **Package UI:** Saved package freshness/source/maturity, deployment, availability, assignments and block state are visible under role/capability gates. Preview identifies write risk and exact actor/target/provider contract. Access and reassignment remain visible but disabled with their exact limitations and provider link. Package block remains explicitly distinct from Copilot Studio quarantine. Mobile package filters, status text and confirmation layout remain within the 360px viewport.

### Forward Migrations

| Version | Phase 05 ownership |
| --- | --- |
| 7 | Scoped package refresh jobs, atomic broad/exact snapshots, typed resource projections and finite retention. |
| 8 | Immutable confirmation/prestate/poststate, per-attempt correlation/readback, reconciliation and initial qualification schema. |
| 9 | Requested audit status support. |
| 10 | Typed approval/restoration lifecycle with separate approver and actor; superseded as qualification authority by migration 11. |
| 11 | Paired workflow-v3 original/restoration jobs; old qualification invalidation and interrupted-cycle containment. |
| 12 | Independent verified-evidence retention and cascading paired-cycle expiry; fixes the job-expiry foreign-key/check-constraint conflict. |

Current-source tests cover fresh creation, upgrade from schema 6, preserved schema-7 jobs, schema-9/10 qualification invalidation, nonempty schema-11 upgrade, failure/rollback/retry, grants and retention. The new safety/qualification defects repaired during this session are attributed to Phase 05, not retroactively to the verified Phase 01-04 prerequisites.

## Endpoint And Version Evidence

Microsoft package operation pages and fixture request captures were rechecked on 2026-09-09 local time (2026-09-08 UTC). Every mutation is delegated-only with `CopilotPackages.ReadWrite.All`; list/detail use `CopilotPackages.Read.All` in delegated or separately enabled application mode.

| Operation | Exact provider contract | Delivered state |
| --- | --- | --- |
| List packages | `GET https://graph.microsoft.com/v1.0/copilot/admin/catalog/packages?$filter=supportedHosts/any(h:h eq 'Copilot')` | Available behind read capability; bounded pagination/read retry and typed complete publication. |
| Package detail/readback | `GET https://graph.microsoft.com/v1.0/copilot/admin/catalog/packages/{id}` | Available behind read capability; used for exact reads, mutation prestate and semantic readback. |
| Block | `POST https://graph.microsoft.com/beta/copilot/admin/catalog/packages/{id}/block` with no body | Implemented one-shot with readback; `preview_disabled` until separately restored `block` and `unblock` canaries exist. |
| Unblock | `POST https://graph.microsoft.com/beta/copilot/admin/catalog/packages/{id}/unblock` with no body | Implemented one-shot with readback; `preview_disabled` until both directional canaries exist. |
| Update access | `PATCH https://graph.microsoft.com/beta/copilot/admin/catalog/packages/{id}` with `allowedUsersAndGroups` and `acquireUsersAndGroups` | Exact adapter/preservation/readback fixtures pass; product dispatch disabled because the operation lacks a documented conditional-write/lost-update bound. |
| Reassign owner | `POST https://graph.microsoft.com/beta/copilot/admin/catalog/packages/{id}/reassign` with exactly `{ "userId": "<Entra user object ID>" }` | Exact adapter fixture passes; product dispatch disabled because package detail has no owner readback field and the operation has no conditional-write contract. |
| Directory user | `GET https://graph.microsoft.com/v1.0/users/{uuid}?$select=id,displayName,mail,userPrincipalName` | Exact UUID response identity required. |
| Directory group | `GET https://graph.microsoft.com/v1.0/groups/{uuid}?$select=id,displayName,description,mail,groupTypes,securityEnabled` | Exact UUID response identity and assignable group type required. |

Current references: [package list](https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/api/admin-settings/package/copilotpackages-list), [package detail](https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/api/admin-settings/package/copilotpackagedetail-get), [access update](https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/api/admin-settings/package/copilotpackagedetail-update), [block](https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/api/admin-settings/package/copilotpackage-block), [unblock](https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/api/admin-settings/package/copilotpackage-unblock), and [reassign](https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/api/admin-settings/package/copilotpackage-reassign). The reviewed evidence and safety interpretation are retained in the [provider inventory](../../../docs/provider-contract-inventory-2026-09-08.md) and [canary runbook](../../../docs/mutation-canaries.md).

## Coverage And Limitations

No approved live tenant credentials, Agent 365 license evidence, delegated consent, dedicated canary package, independent approval or live provider role was available. The retained app intentionally remains sign-in-unconfigured. No live list/detail probe or provider mutation was attempted, and no tenant data entered fixtures, artifacts or this record. Fixture qualification proves application behavior, not tenant eligibility or Microsoft service behavior.

Current continuation policy supersedes the original qualification gates: implemented access and block/unblock run on demand for an authorized, confirming Admin without prior canaries or extra configuration. Contract, permission, delegated-auth mode or configuration changes invalidate optional qualification evidence, not ordinary-write availability. Disclose the access endpoint's external concurrent-overwrite risk; owner reassignment has no implemented product workflow or documented owner readback. No new live provider success is asserted by this policy update.

Package API documentation names Microsoft Agent 365 licensing and global cloud but no additional human Entra administrator role. The app relies on current-account provider probes rather than inventing one. Package refresh jobs expire after seven days; saved snapshots and qualification evidence expire after no more than 30 days. This phase does not implement recurring collection, Power Platform quarantine, official usage ingestion, audit/Defender feeds, transcripts, Azure deployment or cross-source mutation fallback.

## Changed Files

- Package provider/state/safety/restoration: [graphPackages.ts](../../../backend/src/services/graphPackages.ts), [packageObservation.ts](../../../backend/src/services/packageObservation.ts), [packageMutationState.ts](../../../backend/src/services/packageMutationState.ts), [packageMutationSafety.ts](../../../backend/src/services/packageMutationSafety.ts), [packageCanaryRestoration.ts](../../../backend/src/services/packageCanaryRestoration.ts) and focused tests.
- Persistence/jobs: [package inventory repository](../../../backend/src/db/packageInventory.ts), [qualification repository](../../../backend/src/db/packageMutationQualifications.ts), [durable jobs](../../../backend/src/db/jobs.ts), [schema](../../../backend/src/db/schema.ts), database operator/tests and package/restart fixtures.
- Authorization/routes: [package routes](../../../backend/src/routes/agents.ts), [route policy](../../../backend/src/routes/policy.ts), [capability service](../../../backend/src/services/capabilities.ts), [directory resolver](../../../backend/src/services/directoryPrincipals.ts), MSAL/session/server integration and route/service tests.
- Frontend: [App.tsx](../../../frontend/src/App.tsx), [package mutation projection](../../../frontend/src/packageMutationState.ts), [API client](../../../frontend/src/api/client.ts), package table/detail/access/bulk components, capability state, styles and package/browser tests.
- Documentation/evidence: [root runbook](../../../README.md), [frontend runbook](../../../frontend/README.md), [security model](../../../docs/security-model.md), [provider inventory](../../../docs/provider-contract-inventory-2026-09-08.md), [canary runbook](../../../docs/mutation-canaries.md), [browser JSON](../../../artifacts/phase03/permission-browser-results.json) and this record.

## Validation Evidence

All application build/test/database/browser execution ran in Docker; only PowerShell, Git, Docker and HTTP health checks ran on the host. Guarded `agentcontrol_test_*` databases were used instead of application data and were removed. Final cumulative worktree remains uncommitted.

| Command / check | Status | Observed result |
| --- | --- | --- |
| Focused Docker Vitest batches for Phase 05 HTTP, worker, qualification, jobs, Graph and database paths | passed | HTTP 20/20; worker 12/12; qualification 7/7; jobs/Graph/database batch 53/53. Coverage includes canonical idempotency conflicts, frozen block-all retries, account replacement/logout races, post-readback publication fencing, read-only reconciliation bounds/redaction, exact inverse cycles, migration invalidation, typed scalar rejection and opaque Entra object IDs. |
| Parent bounded restoration validation at `2026-09-08T21:57:58Z` | passed | 37/37 checks passed before the focused worker completed the broader aggregate and deployment evidence below. |
| Parent isolated Docker qualification/database command below | passed | 21/21 twice, final `22:32:52Z`: nonempty schema-11 upgrade, seven-day job expiry preserving verified evidence, paired qualification expiry, runtime deletion denial, migration failure/retry and grants. Control and child fixture databases removed. |
| `pwsh -NoProfile -File ./deploy-local.ps1 -Project agent-control-phase01` | passed | Final schema-12 aggregate: backend 239/239 in 32 files; frontend 83/83 in 12 files; backend typecheck, frontend lint and both production builds passed. The persistence harness repeated the same baseline. |
| `pwsh -NoProfile -File ./scripts/permission-browser.tests.ps1 -Project agent-control-phase01` | passed | 34/34 Chromium scenarios at 1440x1000 and 360x780 plus the outer fixture test. Axe A/AA, role/status matrix, direct-write denial, exact disabled remediation, preview/cancel without a write, keyboard focus, outage behavior, no navigation scan and document-width bounds passed. Provider/auth were deterministic test-only mocks; zero mutation jobs remained. |
| `pwsh -NoProfile -File ./scripts/restart-runtime.tests.ps1 -Project agent-control-phase01` against the rebuilt operator image | passed | Compiled runtime recovery proved sent canary writes are not replayed (`canarySentReplays: 0`) and interrupted cycles do not publish qualification (`canaryQualifications: 0`). Receipt, fixture container and guarded databases were removed. |
| `docker build --platform linux/amd64 --target package -t agent-control-phase01-package .` | passed | Fresh Linux/x64 release image and ZIP built from the final source tree. |
| Extracted-ZIP command below | passed | Fresh schema-12 ZIP extracted and executed with Linux x64 / Node 24.20.0. Runtime-secret scan, startup, health/readiness, frontend assets, API 404, deep-link fallback and graceful shutdown passed. Existing secret files were mounted read-only; no value was logged. |
| `docker run --rm --network agent-control-phase01_default agent-control-phase01-operator:local backend/scripts/package-smoke.ts http://app:3001` | passed | Final deployed app readiness, API/static/callback/traversal/cache checks; `zipInspected:false`. ZIP execution is separate evidence above. |
| `pwsh -NoProfile -File ./scripts/persistence.tests.ps1 -Project agent-control-phase01 -Port 3001` | passed | Final rebuild/redeploy preserved data fingerprints, credential hashes, origin and retained volume/network; database recovery, two guarded backups, isolated native restore and exactly two-service health passed. All generated test/restore databases and receipts were cleaned. |
| `docker compose --project-name agent-control-phase01 ps`; SQL migration/database/qualification inventory; PowerShell HTTP health | passed | Final `22:38:12Z`: exactly healthy `app` and `postgres`, canonical port 3001; readiness true, `authConfigured:false`, exact callback; migrations 1-12 verified, zero live qualification records, only `agentcontrol` and `postgres` databases. Unrelated Docker containers preserved. |
| `pwsh -NoProfile -File ./scripts/local-deployment.tests.ps1`; `git diff --check`; editor diagnostics | passed | 19 preservation/orchestration assertions; whitespace clear; touched backend/frontend diagnostics clear. |
| Markdown fence/local-link validator over six runbooks and completion records | passed | All fences are balanced and every local link target resolves. |
| Fixture/debug/whitespace hygiene | passed | No permission-browser/restart/test/restore fixture container or temporary browser diagnostic remains. `git diff --check` and untracked-file `--no-index --check` produced no diagnostics. Existing cumulative dirty/untracked work was preserved; no commit or branch was created. |
| Live package list/detail and reversible canary | unavailable | No authorized tenant/session/approval; no live call, consent/grant, mutation or fabricated qualification occurred. |

Final frontend production output was 780.24 kB minified / 225.99 kB gzip for the main JS chunk. Vite emitted its existing over-500 kB warning; Phase 10 owns loading measurement/code splitting. No warning threshold or lint rule was suppressed.

The final browser report started at `2026-09-08T22:36:07.870Z`: 34 expected, zero unexpected, zero skipped and zero flaky. Parent inspected the [desktop confirmation](../../../artifacts/phase03/package-confirmation-desktop.png) and [mobile confirmation](../../../artifacts/phase03/package-confirmation-mobile.png); long IDs/permissions wrap and the mobile dialog scrolls within its bounded viewport. All browser evidence is synthetic, never tenant qualification.

Exact isolated focused Docker invocation, executed from PowerShell after creating `$databaseName = "agentcontrol_test_" + [Guid]::NewGuid().ToString("N")` with project PostgreSQL `CREATE DATABASE`, and dropped by exact name in `finally`:

```powershell
docker run --rm --network agent-control-phase01_default `
	--mount "type=bind,source=$PWD/.local/agent-control-phase01/secrets,target=/run/secrets,readonly" `
	--mount "type=bind,source=$PWD/backend/src,target=/app/backend/src,readonly" `
	--mount "type=bind,source=$PWD/backend/scripts,target=/app/backend/scripts,readonly" `
	-e PGHOST=postgres -e PGUSER=agentcontrol_admin -e "PGDATABASE=$databaseName" `
	-e PGPASSWORD_FILE=/run/secrets/postgres-admin -e APP_PGPASSWORD_FILE=/run/secrets/postgres-app `
	--entrypoint npm agent-control-phase01-operator:local run test --workspace backend -- `
	src/db/packageMutationQualifications.test.ts scripts/database.test.ts
```

Exact final extracted-ZIP invocation:

```bash
docker run --rm --platform linux/amd64 --network agent-control-phase01_default \
	--mount "type=bind,source=$PWD/.local/agent-control-phase01/secrets/postgres-app,target=/run/secrets/postgres-app,readonly" \
	--mount "type=bind,source=$PWD/.local/agent-control-phase01/secrets/session,target=/run/secrets/session,readonly" \
	-e PGHOST=postgres -e PGUSER=agentcontrol_app -e PGDATABASE=agentcontrol \
	-e PGPASSWORD_FILE=/run/secrets/postgres-app -e SESSION_SECRET_FILE=/run/secrets/session \
	--entrypoint node agent-control-phase01-package backend/scripts/zip-runtime-smoke.mjs
```

### Repair And Rerun Evidence

- Route idempotency now compares a canonical mutation descriptor rather than only a confirmation hash. Reordered targets remain the same intent, while changed action/scope/target/body conflicts. Block-all submission persists the exact original body and target set so a retry cannot silently incorporate a changed saved inventory.
- Active jobs now carry abort controllers and account-generation fences. Logout/account replacement signals cancellation without awaiting worker completion under the account lock; every provider dispatch and success publication rechecks authority after awaited work.
- Reconciliation now requires the current Operator and delegated read authority, rechecks both during iteration/publication, uses a 30-second provider-read bound, honors cancellation and emits redacted durable errors.
- Migration 11 replaces caller-claim/workflow-v2 authority with workflow-v3 exact-inverse approvals, paired durable jobs and atomic job-backed qualification. Interrupted sent work recovers to `inconclusive` with no replay or qualification.
- Strict scalar validation rejects coercible non-strings, while Entra object IDs are validated as opaque GUIDs rather than applying package-ID assumptions.
- The first post-repair browser run exposed a mobile document overflow. Computed geometry isolated a non-wrapping refresh status that widened the catalog action track; mobile grid/status and confirmation sizing were bounded, and the final uninstrumented run passed 34/34.
- Qualification fixtures and completion evidence contain only typed minimal state, identifiers/revisions, job linkage and redacted outcomes. They contain no tokens, unrestricted provider payloads or live tenant data.
- Parent review found that migration 11's job `ON DELETE SET NULL` conflicted with qualified records requiring a job reference, and separately expired members of an inverse pair could prevent cleanup. Forward migration 12 retains verified job UUIDs as evidence references and deletes expired paired cycles atomically. The nonempty-upgrade/real-retention regression passed, followed by the full 239/83 baseline, persistence, restart, browser34 and freshly executed Linux/x64 ZIP.

## Open Issues

| ID / origin | Scope / evidence | Containment | Signal / threshold | Owner | Exact fix-forward trigger |
| --- | --- | --- | --- | --- | --- |
| P05-LIVE-PACKAGE | No live tenant package eligibility, read-contract or block/unblock convergence proof was obtained in this phase | Saved data remains independent; actual provider authorization is checked at execution; optional canary evidence is not ordinary-write authority | Any claim of live readiness or write success based on fixtures, consent or HTTP acceptance | Tenant administrator and Phase 13 live qualification owner | Configure the approved existing single-tenant app through restricted inputs; sign in with the required app role/license and consent only the needed capability. Record actual operation results. If an optional qualification exercise is approved, use a dedicated nonproduction package and separately approved actor/restorer to execute and restore both directions; never require that exercise for ordinary Admin-confirmed writes. |
| P05-ACCESS-LOST-UPDATE | Beta package access update has no documented ETag/`If-Match` or equivalent protection for replacing a full access collection | Current policy permits on-demand confirmed access writes with local serialization, immediate prestate checks, preservation, audit and readback; these do not eliminate external concurrent-overwrite risk | Provider publishes and honors a conditional-write/revision contract, or an actual external-change conflict is observed | Phase 09 contract review and Phase 13 qualification owner | Keep exact provider fixtures and risk disclosure current; verify selected/unselected preservation and external-race behavior. Optional separately approved availability/installation canaries provide evidence only, never an activation prerequisite. No new live proof is claimed. |
| P05-REASSIGN-READBACK | Reassign operation accepts `userId`, but package detail exposes no owner readback and operation headers expose no conditional write | Exact adapter fixture retained; no implemented product workflow or documented owner readback | Provider exposes authoritative owner readback | Phase 09 contract review and Phase 13 qualification owner | Capture the changed contract and implement/test an exact user-resolution, confirmation, one-shot dispatch and authoritative readback workflow before claiming support. Any reversible qualification exercise is separately approved and optional. |

Inherited [P04-LIVE-INVENTORY](04-power-platform-inventory.md#open-issues), [P01-LIVE-IDENTITY](01-domain-persistence-foundations.md#open-issues) and [P01-BUNDLE-SIZE](01-domain-persistence-foundations.md#open-issues) remain open. Phase 05 implementation and deterministic validation are complete. No unresolved core defect, failed required local check or owned cleanup incident remains. Live provider qualification is unavailable and contained, not represented as passed.

## Phase 06 Preconditions

Phase 06 may consume checksum-verified PostgreSQL migrations/repositories, normalized exact identities, four independent app roles, Permission Center capability gates and server-side request limits. It must read this record plus Phase 04 identity, Phase 02 data-access policy and Phase 01 migration/job contracts. Native Graph package IDs remain package mutation targets, package observations remain a distinct source, and no display-name or cross-source association may become report identity.

Phase 06 owns the report-run, staging, immutable set/version, selection and retention schema. It must move official usage parsing/authority from browser storage to a durable audited backend cutover, require all three Microsoft admin-center exports, and never present package, audit, Defender, telemetry or transcript data as official usage. Existing browser rows must not be silently parsed, uploaded or promoted. Do not modify applied migrations 1-12, activate package writes, deploy Azure, automate unsupported report APIs or implement transcripts.

## Next Session

```text
Implement only plans/admin-poc-production/06-official-usage-ingestion.md.
Read the binding README and Phase01-05 completion records, then verify current
migration, identity, role, capability and report-parser artifacts. Preserve
data, secrets, browser-local report authority until its explicit cutover,
migrations1-12 and package safety gates. Use Docker and agent-control-phase01
at http://localhost:3001 with generated isolated fixtures. Do not activate
package writes, change provider grants, commit, push, deploy Azure, create
campaign bookkeeping or continue beyond Phase06.
```

This session stopped after Phase 05; Phase 06 was not executed.