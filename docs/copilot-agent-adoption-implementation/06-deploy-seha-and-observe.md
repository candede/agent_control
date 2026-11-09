# 06 - Deploy SEHA and observe

## Mission and prerequisites

Deploy the exact current campaign revision to the authorized existing SEHA
installation, execute the justified schema reset when required, and converge
through actual first-run/adoption observations and fix-forward.

Prerequisite: phase 05 evidence plus all 01-05 exact completion records:
`completions/01-evidence-apis-and-mcp-reads.md`,
`completions/02-safe-discovery-and-agent-descriptions.md`,
`completions/03-adoption-workspace-and-learning-cards.md`,
`completions/04-ai-guidance-and-customer-starter-kit.md`, and
`completions/05-end-to-end-and-capacity-verification.md`.
Read them, campaign state, [README](./README.md), [CONTRACT](./CONTRACT.md), and
obey [the binding production policy](./README.md#always-deploy-production-contract).
Future execution must have been started by the user; writing this plan does not
perform deployment.

## Production continuation

Obey [the binding production policy](./README.md#always-deploy-production-contract).
Reconcile every non-passing check truthfully and continue authorized safe
deployment, observation and fix-forward. Do not open unsafe authority or add
runtime approval/enable steps. Literal production control-plane/access inability
leaves `deployment_pending`; deployed but unproven required behavior remains
`production_hardening_pending`, with an exact owner and resumable action.

## Read first

- [Deployment entry](../../deploy-local.ps1),
  [deployment owner](../../scripts/local-deployment.ps1),
  [runtime owner](../../scripts/local-runtime.ps1),
  [MCP lifecycle](../../scripts/local-mcp.ps1).
- [Operations](../operations.md), especially
  [reset](../operations.md#reset-application-data),
  [database operator](../../backend/scripts/database.ts),
  [guarded reset](../../backend/scripts/databaseReset.ts),
  [backup owner](../../backend/scripts/backup.ts).
- [Deployment setup](../deployment-setup.md),
  [genuine CSV import](../official-usage-import.md),
  [MCP client setup](../mcp-clients.md),
  [Studio connection contract](../copilot-studio-mcp-connection.md).
- Actual phase-03 schema fingerprint/new grants, phase-04 packaged assets,
  phase-05 release identity, residuals, resource baseline and measurements.

## Exact target and preflight

1. Reconcile current workspace/revision/source digest, dependency images, Docker
   context, **Compose project `seha`**, named app/MCP/PostgreSQL containers,
   network/volume/config identities, port bindings and configured public origins.
   The container prefix is not the Compose project name. Do not select an
   unrelated project or stale immutable snapshot path.
2. Check non-secret auth/resource/redirect metadata and existing maintenance/
   health/source state. Do not log credentials, cookies, tokens or environment
   files. An available credential is not authority for a different target.
3. Reconcile actual tested current schema versus live fingerprint. If the new
   optimal schema requires a clean reset, use the authorization already recorded
   in README, the guarded operator and exact database confirmation. Do not add
   migration/compatibility scaffolding to avoid the accepted reset.
4. Before replacing/rebuilding the installed operator tag, pin the verified
   installed operator image ID matching the live schema and attempt its protected
   backup/checkpoint through the existing helper. The candidate operator cannot
   verify an incompatible old schema. Keep dump/receipt access-restricted and
   outside source control; distinguish that old-schema recovery artifact from
   candidate current-schema restore proof in isolation.
   Record actual backup/restore results, genuine CSV availability, expected loss
   of database-stored configuration/history and reset rationale. A missing
   measurement is not a pass. Never serve an old schema or add compatibility code
   to restore it. Preserve the installed operator until this attempt is recorded.
5. Prepare the existing deployment tooling's pinned candidate/preflight identity
   where supported. Record actual identities; no invented release receipt,
   acceptance token or runtime canary gate.
6. Each residual from phase 05 gets an exact existing containment mechanism,
   affected scope, observation/canary, numeric threshold, owner and repair
   trigger. Do not describe unimplemented promised behavior as deploy-ready.

## Forward deployment and clean recovery

Use current checked-in tooling; the relevant entry commands are:

```powershell
pwsh ./deploy-local.ps1 start -Project seha
```

Only when the recorded current-schema change requires the authorized clean
reset, follow the complete runbook/operator safeguards with:

```powershell
pwsh ./deploy-local.ps1 start -Project seha -DbReset
```

Read current help and lifecycle behavior before execution; preserve actual
candidate/preflight parameters when the existing tooling uses them. The reset
is a deliberate operation, not a retry option for ordinary restarts.
Bind the release to phase 05's actual source/asset digest and immutable app/MCP/
operator image IDs; requalify affected proof if source changes before deployment.
When using the existing pinned path, supply its actual `-Candidate`,
`-CandidateSha256` and `-ExpectedPreflight` values after `-ReadOnly` target/action
preflight. These are content/target integrity checks, not a new runtime enable or
routine human acceptance requirement. Never fabricate a candidate or preflight.

- Rebuild/update app and MCP from the same intended current source; apply
  current schema/grants and retain real revocation/maintenance safeguards.
- Resume an interrupted reset/initialization from recorded actual phase.
  Never repeat a completed destructive drop because the command response was
  lost, clear maintenance to force readiness, or reset an unrelated database.
- Preserve genuine auth/provider/role controls. No synthetic-auth mode, shared
  privileged employee connection, undocumented switch or manual-start sync.
- Keep ordinary safe reads/discovery usable without campaign qualification.
  A known unsafe disclosure/mutation remains denied by actual policy, not a new
  app-owned release prerequisite.

## Qualify the exact deployed release

First run synthetic checks in the isolated environment using the exact deployed
images/source; no synthetic reports, people or fixture roles in the live tenant.
Then observe genuine authorized live journeys:

1. Normal browser sign-in after deployment/reset automatically starts initial
   read-only collection while visible/online. Employee-first authenticated MCP
   entry admits application reads without needing a staff browser bootstrap.
   Verify Graph/package/user recovery and Office derivation for that entry;
   qualify delegated native collection separately with eligible staff authority.
2. Missing workplace/report/source states remain explicit and useful catalog
   discovery is still available where supported. No Permissions visit, capability
   check, feature-enable or adoption approval.
3. Current saved directory, inventory and Office evidence reappear through the
   existing collection flow. Real provider failures report their actual cause/
   retry state without converting saved or frozen evidence to zero.
   Verify project-retained privacy/connection configuration is applied by
   deployment; recover genuinely reset database-owned settings through normal
   management, not old-schema imports. Record retained versus reset settings.
   Configuration recovery must not add a staff/operator visit before ordinary
   sign-in, supported discovery or automatic initial sync.
4. If genuine official CSVs are available, use the existing authorized import
   flow to restore report-based analysis. If not, do not manufacture reports:
   prove missing-report behavior and record the exact unavailable live-analysis
   evidence. Automatic inventory recovery is not automatic CSV-history recovery.
5. Connected staff consumer retrieves the exact department evidence, complete
   agent descriptions, peer relationships and a useful starter brief. Sample
   facts come from the newly selected live contexts, not the old research counts.
6. On explicit request, save a genuine useful bounded brief/action/card through
   MCP, then
   verify fresh MCP reads, cross-account staff sharing, allowed owner progress and
   safe EndUser card retrieval with real authority. Use actual selected evidence
   and an appropriate nonsensitive workflow; do not invent participants,
   successful-use claims or synthetic learning to populate live tenant content.
   Employee-shared live proof uses a genuine author-shared card. Synthetic
   save/delete/conflict/privacy fixtures stay in the isolated exact-image stack,
   not a test audience/flag added to the production card schema.
   Verify tenant-wide employee sharing across department labels, unchanged
   aggregate baseline on reload and explicit follow-up drift/expired evidence.
   Lost-response retries and post-delete retries must not create new records.
   Inject lost responses/destructive failure cases only in isolation; do not
   disrupt live users to repeat already qualified failure proof.
   Retain genuine business records unless their author requests exact deletion;
   do not delete legitimate learning merely to tidy qualification evidence.
7. Observe roleless discovery/staff-preview/privacy behavior with actual
   permitted sessions or clearly distinguish fixture/preview proof from a real
   EndUser consumer. Do not impersonate users or claim a preview proves their
   provider access.
8. Download/copy the built customer kit and try representative prompts with
   the actual available client/Studio harness. Verify current instructions and
   descriptions on MCP initialize/tools-list and the app metadata page.
9. Check real verified use links and handoff where supported. Do not claim
   another agent executed a business task unless it actually did.

## Observation and fix-forward

Observe at least fifteen minutes after the final deployment/redeploy and attempt
at least three successful repeats of each available staff retrieval/save and
employee-safe discovery path. Exclude actual interactive consent waits from
retrieval timings; do not claim a complete sample when credentials are absent.

Use current logs/request IDs with no sensitive payloads:

- Any unauthorized cross-tenant/staff-to-EndUser disclosure, hidden identity
  leak, missing destructive confirmation or fabricated authority:
  threshold **one event**, contain the exact affected route/projection and fix.
- Any duplicate persisted canary on an idempotent retry:
  threshold **one duplicate**, repair write identity/revision handling.
- Any deleted record resurrected by retry, unauthorized cross-owner cascade,
  reused actor-bound lease or silent relabelling of saved baseline as current:
  threshold **one event**, contain the exact mutation/reference path and repair.
- Any ordinary first-run requiring a new manual gate or failing to admit
  automatic sync despite valid authority/source setup:
  threshold **one reproducible occurrence**, fix the owning entry/sync contract.
- Compact page exceeds **128 KiB**, representative retrieval exceeds
  **32 calls/4 MiB/180 seconds**, or measured compact-read p95 exceeds
  **two seconds** under the qualified load:
  record scope and reproduce in isolation; repair query/paging/recipe, not by
  truncating evidence or silently widening limits.
- Repeated server errors: threshold **two consecutive failures** for a critical
  canary; correlate actual code/retry state and distinguish provider outage from
  introduced defects.

Check existing sign-in, Users, Agents, Office dashboard, sync and genuine Admin
control surfaces for regressions. Unrelated installations stay untouched.

For a defect: contain through existing real policy/operational mechanisms,
diagnose root cause, fix the owning module/phase record, run the focused check,
redeploy the exact corrected current release, and restart relevant observations.
No rollback compatibility writer or false passing result.

## Cleanup and operations handoff

- Stop/delete only exact disposable campaign resources after all dependent work.
  Restore the safe pre-campaign Docker baseline; preserve live SEHA, other
  installations, operator backups and actual revocation authority.
- Synthetic qualification records are removed only from isolated targets.
  Live business-content deletion requires its normal exact-target confirmation;
  never delete unrelated content or globally shared cards as fixture cleanup.
- Cleanup failure remains an owned incident with resource, risk/cost, threshold
  and exact next action. Never broad-prune Docker or recursively delete roots.
- Update current runbooks with deployed contracts, kit installation, schema/reset
  outcome, source/report recovery, errors and fix-forward procedures.
- Record unavailable genuine CSV, client, account or provider proof honestly.
  Safe deployment does not mean an unproven promised journey is complete.

## Completion

Write `completions/06-deploy-seha-and-observe.md` using CONTRACT's factual fields
and update `completions/IMPLEMENTATION_CAMPAIGN.md`.

Include exact deployed source/image/schema/target identities, actual reset and
backup outcome, regained source/report state, live journey samples/timings,
consumer/host evidence, residual/containment ownership, cleanup and exact next
action.

Finish only with authorized deployment and useful whole-flow observation.
Literal control-plane/access inability leaves `deployment_pending`; deployed
but required unproven/contained behavior leaves `production_hardening_pending`.
Keep those states open and resumable. No test-only success, NO-GO terminal branch
or invented final acceptance gate.
