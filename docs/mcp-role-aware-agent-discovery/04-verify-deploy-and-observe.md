# 04 - Verify user journeys, deploy seha and observe

## Mission and prerequisites

Prove the requested employee, staff and employee-preview journeys together,
deploy to the existing `seha` production installation and converge through
live observation/fix-forward.
Prerequisites: phases 01/02/03 and their exact completion records:
`completions/01-roleless-discovery-authority.md`,
`completions/02-safe-agent-discovery-api.md`,
`completions/03-role-aware-mcp-surface.md`.

Read and obey [README](README.md), particularly its binding always-deploy
production contract and authorized target boundary. Execute only after the user
starts the future campaign. Do not create a second release acceptance,
qualification or feature-enable prerequisite.

## Read first

- All three prompts/completion records and
  `completions/IMPLEMENTATION_CAMPAIGN.md`; reconcile evidence with actual
  prompt/source/image identities.
- [Deployment entry point](../../deploy-local.ps1),
  [deployment owner](../../scripts/local-deployment.ps1),
  [runtime owner](../../scripts/local-runtime.ps1),
  [MCP lifecycle](../../scripts/local-mcp.ps1),
  [operations](../operations.md), [deployment setup](../deployment-setup.md).
- [Isolated test entry point](../../scripts/large-tenant-tests.ps1),
  [scale fixture](../../backend/scripts/largeTenantFixture.ts),
  [MCP fixture](../../scripts/local-mcp-fixture.ps1),
  [browser fixture](../../backend/scripts/browser-fixture.browser.ts),
  [fixture safeguards](../../backend/scripts/fixtureSupport.ts),
  [browser config](../../frontend/playwright.config.ts).
- [MCP workflow tests](../../mcp/tests/test_workflows.py),
  [container journey](../../mcp/tests/container_journey.py),
  [reference checks](../mcp-reference.md#verification),
  [Studio connection contract](../copilot-studio-mcp-connection.md) and
  [client/publication guide](../mcp-clients.md).

## Aggregate and real-journey verification

1. Reconcile all requirement owners, role/operation/schema mappings, DTO
   exclusions, private/draft scope, stored company/department identity,
   actor/preview-subject isolation, deployment privacy policy, report windows, source authority and
   first-run collection. Repair defects in their owning
   implementation/record, not a final-phase wrapper or fallback.
2. Run useful aggregate checks once against current content, reusing exact-content
   focused evidence from earlier phases rather than repeating full suites:

   ```sh
   cd mcp
   .venv/bin/python -m pytest
   .venv/bin/python -m ruff check src tests
   .venv/bin/python -m mypy
   ```

   From the repository root:

   ```sh
   npm run typecheck --workspace backend
   npm run typecheck --workspace frontend
   npm run test --workspace frontend
   npm run lint --workspace frontend
   npm run check:unused
   npm run build
   git diff --check
   ```

   Combine all affected backend authority/discovery/metadata/automatic-sync
   selectors in one runner invocation. Execute database-dependent SQL and route
   tests through the isolated runner; no production PostgreSQL credentials.
3. Use existing disposable MCP/API/browser tooling. Resolve current approved
   dependency/browser image tags and immutable IDs before running:

   ```powershell
   pwsh -NoLogo -NoProfile -File ./scripts/large-tenant-tests.ps1 -Suite mcp-end-to-end -BaselineImage <verified-image> -BaselineImageId <verified-sha256>
   pwsh -NoLogo -NoProfile -File ./scripts/large-tenant-tests.ps1 -Suite mcp-container
   pwsh -NoLogo -NoProfile -File ./scripts/large-tenant-tests.ps1 -Suite cutover-browser-contract -BrowserFiles "mcpSettings.spec.ts,signIn.spec.ts,permissions.spec.ts,dataSync.spec.ts" -BaselineImage <verified-image> -BaselineImageId <verified-sha256> -BrowserImage <verified-browser-image> -BrowserImageId <verified-sha256>
   ```

   Integrate the new cases into those runners in their owning phases. Record
   actual fixture resource identities and use current backend/frontend/MCP
   sources, not stale image contracts. No inherited production credentials,
   new public registries, Docker installation or external test VM.
4. Prove isolated fresh initialization/reset and employee-first browser **and**
   MCP sign-in. Automatic application read collection must start without an
   assigned Viewer or a permissions/manual-sync step; personal report evidence
   may be unavailable without making organization search unusable.
   Repeat Viewer/Admin first-run, saved-data outage and restart/OAuth continuity.
   Where schema/index changes occurred, prove data-preserving current-schema
   convergence, fresh-init parity and isolated restore/restart.
5. Complete the twelve deterministic relevance cases and capacity attempt in
   README. Record every measured/failed/unavailable result and actual scale;
   do not replace the required corpus with a convenient small happy path.
   Run all four privacy combinations in disposable deployments for genuine
   EndUser and staff previews. Verify persistence/restart, both raw MCP content
   forms, embedded/chunked identities, unchanged agent/ranking evidence, policy
   tightening with cached selections and unaffected ordinary staff operations.
   Verify default false/false preserves the approved name/contact behavior.
6. Exercise real natural-language questions through the supported native client:
   champions, department use cases, departmental popular agents, own champion
   status, BRD review and a paraphrased goal. Also ask for top three agents in
   both the real caller's department and company. Include a cross-department match,
   private/draft result, missing personal evidence, no match, unknown use access
   and hostile source text. Repeat the six primary prompts twice; retain every
   attempt, tool/action/term expansion, evidence source and answer outcome.
   Do not claim semantic/identity proof from SDK fixtures alone.
   With Viewer, Uploader and Admin identities, run:
   "Assume I am abc@domain.com and tell me who are agent champions in my
   department and what are the top three most popular AI agents in my
   department and company." Use controlled fixture accounts for deterministic
   comparison, then read-only authorized real accounts for client verification.
   Confirm scope comes from the selected stored account: company + department
   versus company alone. Compare with that member's genuine self-service on the
   same saved/report revisions. The actor remains the signed-in staff account;
   no target token, role lending, silent session switch or metric leakage.
   Verify EndUser cannot invoke preview, target Admin roles cannot escalate a
   Viewer, concurrent subjects stay separate, and normal self-service returns
   to the actor's own scope. Report shorter/unavailable lists honestly.
   In fresh isolated client conversations with either privacy flag enabled,
   verify descriptions/use cases and top-three scope remain useful while the
   hidden category's names/contact/identity proxies are absent. A hidden
   champion roster is not reported as no champions; own status remains usable.
7. Verify Copilot Studio OAuth dynamic discovery and the **published** intended
   Teams/Microsoft 365 channel with two roleless employees in different
   departments, plus separate Viewer/Admin connections and a roleless guest
   rejection. Confirm the API observes each person's actual tenant-local `oid`
   and role audience. Changing the chat speaker while reusing a maker/admin
   connection does not establish user authorization.
   Explicit staff preview is a separately labeled authorized read, not proof
   of that member's actual OAuth identity or live provider/use permissions.
   Never publish a broadly privileged shared connection as a workaround.
   Record absent publication access or client tool-cache limitations honestly.

## Production deployment and observation

1. Resolve the existing `seha` host/Docker context/project and its current
   authoritative deployment records/settings. Confirm exact origins, app/MCP
   registrations, images, mounted volumes and service identities without
   printing credentials. The user's target is that existing installation, not
   whichever Docker daemon happens to be available in this checkout.
2. Capture best-available health, saved data/revisions, OAuth continuity and
   checkpoint evidence. Preserve database/volumes/keys and do not use `-DbReset`.
   For every non-passing check, implement README-scoped containment and record
   signal, numeric threshold, owner and exact forward-repair trigger.
3. Apply the precise assignment-required No changes identified in phase 01 to
   the existing registrations where needed. Verify roleless employee OAuth/OBO
   while retaining admin consent, tenant restrictions, existing app roles,
   assigned privileges, callbacks and scopes. Use the actual authorized Entra
   control plane/interactive administrator identity; never grant the runtime
   service new write privileges or ask for secrets in chat.
4. Deploy the affected app/API/frontend and MCP services coherently with the
   existing `seha` lifecycle and exact immutable content identities. A Python-only
   redeploy cannot satisfy new API/auth contracts. Use the current supported
   lifecycle command after reading its configuration/receipt rules:

   ```powershell
   pwsh -NoLogo -NoProfile -File ./deploy-local.ps1 start -Project seha
   ```

   Run it only on the resolved installation owner/context; supply current
   pinned-candidate parameters when its lifecycle requires them. Do not add a
   release receipt as a runtime data/access check. Do not restart/recreate the
   database merely to deploy API/MCP changes.
   Preserve the project's explicit privacy values or the approved false/false
   defaults, and record the actual effective API values. Confirm the settings
   page/profile agree after restart. Never cycle production through less
   private settings for qualification; all-combination proof belongs in fixtures.
5. Qualify the exact running revision: verified roleless member connection;
   stored own-department/company and organization catalog questions;
   authorized staff preview with immutable actor and selected subject;
   private/draft limited
   metadata; no metrics/admin tool advertising or forged-call authority;
   Viewer saved adoption reads and absence of Admin tools; Admin saved reads
   and preview-only controls; settings metadata equality; normal first-sign-in
   automatic reads; configured EndUser/preview privacy enforcement and absence
   of identity leakage through detail/text/link paths. Live provider mutations
   are not authorized tests.
6. Observe for at least thirty minutes and at least ten successful real
   discovery reads across the two employee identities. Include normal
   reauthentication or the supported token-refresh path; preserve existing
   connections. Check unaffected staff saved reads, app/MCP health and existing
   collection outcomes. Record source/date evidence and actual attempts.
7. Use immediate fix-forward triggers for any forbidden field/tool/action,
   wrong actor/preview subject/company/department evidence or unauthorized
   successful invocation or one identity disclosed contrary to an active
   privacy switch
   (threshold **one**). Also investigate any safe discovery HTTP 5xx/error rate
   above **5% in ten minutes** or API search/popularity p95 above **two seconds**
   over at least fifty measured requests. Separate provider/auth/model latency.
   Existing telemetry must record codes, audience and request IDs without raw
   tokens, goals, descriptions, contacts or conversation transcripts.
   Missing traffic or telemetry is inconclusive, not a passing observation.
8. For a live defect: contain only affected unsafe authority using existing
   authentication/error/availability paths, repair the root cause, rerun the
   focused case, redeploy exact content and repeat its live journey.
   Normal supported safe flows remain automatic; do not add an unrequested
   feature-enable flag, manual-start, acceptance or requalification gate.
   The two approved privacy controls limit disclosure, not feature access.
9. Stop/delete only exact campaign-owned disposable resources and restore the
   safe pre-campaign test baseline. Preserve `seha` and unrelated resources.
   Cleanup failures remain explicitly owned incidents while deployment and
   hardening continue.

## Production continuation

This phase fulfills the README binding always-deploy contract. Failed/unavailable
preproduction checks never become passed and alone do not veto authorized safe
deployment. Literal unavailable production/Entra control-plane access leaves
`deployment_pending` with exact target/action/owner. Incomplete published-client
or live-journey proof leaves `production_hardening_pending`; do not report a
health check, deployment receipt or author test as completed employee behavior.
No fabricated consent, provider capabilities, user identity or measurement.

## Completion record and done conditions

Write `completions/04-verify-deploy-and-observe.md` with the README completion
content, exact deployed/observed identities, configuration changes, data/OAuth
preservation, effective privacy values and fixture matrix/leakage checks,
each account/channel/self-versus-preview journey and its true result,
stored workplace filter evidence, observation
duration/sample counts, capacity/client evidence, fix-forward cycles, cleanup
resources/incidents and operations handoff.
Update `completions/IMPLEMENTATION_CAMPAIGN.md` with the same release state.

Done when the agreed role-aware/employee outcomes work in the exact deployed
installation, normal first-run remains automatic, the required observation is
completed and all residuals have truthful status/containment/owners/actions.
If authorized access or required live proof is unavailable, keep the campaign
open with its exact resumable action rather than declaring test-only success.
