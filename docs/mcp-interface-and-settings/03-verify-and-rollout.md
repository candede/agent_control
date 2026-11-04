# 03 - Verify journeys, deploy and observe

## Mission and prerequisites

Prove all three outcomes together and finish the authorized future `seha`
deployment with real observation and fix-forward handling.

Prerequisites: phases 01 and 02 and their exact completion records:
`completions/01-simplify-mcp-contract.md` and
`completions/02-mcp-settings-page.md`.
Read [README](README.md), especially the binding production-continuation policy,
and the installed implementation/step-worker contracts.

This phase is executed only in a future campaign explicitly started by the user.
The plan's approval already covers that campaign's bounded local deployment;
do not invent another release/acceptance gate or infer permission for Azure,
database resets or live destructive tests.

## Read first

- Both phase prompts and completion records; reconcile evidence against actual
  current source/content identities and `completions/IMPLEMENTATION_CAMPAIGN.md`.
- [Local runtime](../../scripts/local-runtime.ps1),
  [MCP owner](../../scripts/local-mcp.ps1),
  [deployment entry point](../../deploy-local.ps1),
  [isolated suite entry point](../../scripts/large-tenant-tests.ps1),
  [isolated MCP fixture](../../scripts/local-mcp-fixture.ps1) and
  [operations](../operations.md)
- [MCP workflows](../../mcp/tests/test_workflows.py),
  [container journey](../../mcp/tests/container_journey.py),
  [browser configuration](../../frontend/playwright.config.ts),
  [reference verification](../mcp-reference.md#verification) and
  [deployment setup](../deployment-setup.md)

## Concrete work and aggregate verification

1. Reconcile the complete 124-operation coverage mapping, current public tool
   count/discovery bytes, exact instructions, metadata equality, tenant/role
   access and supported configuration contracts. Fix concrete integration defects
   in their owning implementation, not a second adapter.
2. Run the aggregate MCP suite and relevant frontend/backend checks once at this
   boundary, reusing still-valid focused results tied to exact content:

   ```sh
   cd mcp
   .venv/bin/python -m pytest --basetemp=../.local/ac-mcp-interface-phase-03
   .venv/bin/python -m ruff check src tests
   .venv/bin/python -m mypy
   ```

   From the repository root:

   ```sh
   npm run test --workspace frontend
   npm run typecheck --workspace backend
   npm run typecheck --workspace frontend
   npm run lint --workspace frontend
   npm run check:unused
   npm run build
   git diff --check
   ```

   Combine impacted backend contract/route selectors in one run and include new
   settings tests and existing authentication, saved-read, workbench and
   automatic-refresh regressions. Use the isolated database runner when required,
   not production PG credentials. Escalate unrelated full suites only when a
   targeted result warrants it; never turn a missing infrastructure dependency
   into an undocumented skip or installation from a blocked registry.
3. Use the existing local validation toolkit. Resolve a literal campaign context
   and verified current dependency/browser image identities before invocation:

   ```powershell
   pwsh -NoLogo -NoProfile -File ./deploy-local.ps1 check -Project <campaign-context>
   pwsh -NoLogo -NoProfile -File ./scripts/large-tenant-tests.ps1 -Suite mcp-end-to-end -BaselineImage <verified-dependency-image> -BaselineImageId <verified-sha256>
   pwsh -NoLogo -NoProfile -File ./scripts/large-tenant-tests.ps1 -Suite mcp-container
   pwsh -NoLogo -NoProfile -File ./scripts/large-tenant-tests.ps1 -Suite cutover-browser-contract -BrowserFiles "mcpSettings.spec.ts,signIn.spec.ts,permissions.spec.ts,dataSync.spec.ts" -BaselineImage <verified-dependency-image> -BaselineImageId <verified-sha256> -BrowserImage <verified-browser-image> -BrowserImageId <verified-sha256>
   ```

   Use phase 02's repaired runner contract and complete working commands.
   `check -Project` selects a context; the toolkit generates separate actual
   fixture projects. Prove ownership/absence from those actual identities and
   record exact resources before create/delete, not an assumed project prefix.
   Reuse valid exact-content results from earlier phases instead of repeating
   expensive suites. Neither `check` alone nor backend tests with the conditional
   Python SDK leg absent proves the listed integration journeys.
4. Run the new settings browser spec plus affected sign-in, permissions, routing
   and saved-read/automatic-sync journeys at desktop and mobile widths. Set
   `PLAYWRIGHT_BASE_URL` to the isolated app and `PLAYWRIGHT_EVIDENCE_DIR` to the
   campaign-owned directory. Reuse the existing Playwright config and phase 02's
   real browser/API/MCP fixture. Record selected/executed case counts and confirm
   that the integration case does not intercept the settings response.
5. Prove clean first deployment/sign-in without MCP and with MCP in isolated
   fixtures, including configured MCP with unavailable metadata credentials or
   service. Initial read-only sync starts automatically and saved reads are not
   gated by metadata reachability, new permission checks or a settings visit.
6. Exercise representative MCP workflows end to end using the real SDK/HTTP
   adapters: exact agent inventory and detail, full paging/About text, users/
   usage/report selection, job start/status/results/recovery, and explicit
   controls in synthetic fixtures only. Preserve API semantics and audit origin.
7. Attempt model-assisted tool selection in the available native client for
   a fixed set of saved-agent lookup, full About continuation, usage explanation,
   saved-job status and preview-only administrative requests. Record client/model,
   actual chosen tool/action, schema validity and result for every attempted
   case, including failed choices; do not keep only a favorable attempt.
   Saved-read requests must cause zero provider/control dispatches. Use synthetic
   fixtures for administrative previews; production qualification stays read-only.
   Do not execute a production mutation or turn deterministic SDK scripts into
   evidence that an LLM chose correctly. Fewer tools/bytes alone do not prove
   better selection. Record missing baseline comparison or unavailable client/
   model access honestly, with a precise remaining qualification action.
8. Verify metadata deadline/body bounds, worst-case current catalog size,
   cancellation, no cross-tenant reuse and readability with long strings.
   No separate load-testing platform is needed.

## Production continuation and exact target preflight

Obey the README's binding production-continuation policy throughout. Non-passing
preproduction evidence changes repair/containment/live qualification, not the
mandatory authorized deployment outcome. Do not stop at “ready to deploy.”

Before any live change:

- Verify this host, Docker context/socket, `seha` project labels, actual app/MCP/
  PostgreSQL services, retained volume/network identities, published ports and
  saved public resource URL. Do not rely on planning-time container IDs/names.
- Verify the exact source/image content to deploy and the current running images.
  Record nonsecret identities and best-available protected checkpoints.
- Verify PostgreSQL health and a usable existing web session/saved read. Preserve
  production database/container/data and original OAuth key/state identities.
  Do not stop the project for an unapproved backup or claim an untested restore.
- Confirm normal startup creates only the independent metadata credential and
  does not regenerate existing client/signing/encryption material. Capture and
  compare protected key/state continuity without printing credentials; verify
  the new file and both services' exact read-only mounts.
- Keep all synthetic identities/fixtures outside `seha`. Do not change tenant
  registrations, callback allowlists or the Dev Tunnel as a test shortcut.

Deploy using the existing normal path from the repository root:

```powershell
pwsh -NoLogo -NoProfile -File ./deploy-local.ps1 start -Project seha
```

Do not add `-ConfigureMcp`, reset, destroy, forced schema recreation or auth-state
clearing to this command. Repair a current deployment-tool defect within scope
instead of bypassing ownership/secret checks or inventing a migration chain.
Only app/MCP replacement/restart is authorized; PostgreSQL and retained volumes
must remain preserved.

## Live qualification and observation

Verify the exact deployed revision, not merely successful build/health output:

1. Web sign-in/saved inventory and users still work. Existing automatic due sync
   behavior is preserved; do not force provider collection to manufacture proof.
2. The current tenant's MCP settings page appears for authorized users and its
   full resource URL/callbacks match the running service's nonsecret settings.
3. Compare all advertised tool names, descriptions, schemas/annotations and
   instruction strings with authenticated native MCP discovery/initialization
   from that deployed instance. Follow discovery pagination completely.
4. Refresh the client's cached tool discovery normally after renamed tools.
   Existing OAuth keys/state remain valid; do not clear authentication merely
   because tool names changed. Real reauthorization uses the ordinary OAuth flow.
5. Perform read-only MCP agent/user lookups and one bounded cursor continuation
   when data provides it. Show unavailable/partial states as such. Tool count
   and metadata reachability alone do not prove business operation.
6. Verify Viewer/Admin behavior with actually available accounts. Do not invent
   accounts, borrow credentials or bypass roles; unavailable role/client proof
   remains explicitly unproven. Synthetic fixtures supply negative/failure cases.
7. Observe for at least **10 minutes** after deployment. Require zero unexpected
   app/MCP 5xx responses in exercised paths, zero unauthorized metadata disclosure,
   zero cross-tenant catalog exposure and zero new control/provider dispatches
   caused by opening or refreshing settings. Existing automatic synchronization
   is separate and must not be disabled.
8. Verify unrelated web health throughout. Do not stop the production MCP service
   merely to demonstrate the unavailable UI; that outage case belongs in fixtures.

If a live defect appears: contain only the affected proven-unsafe surface using
existing authorization/integrity boundaries, diagnose the root cause, fix it,
run the focused regression, redeploy the exact fix and repeat affected canaries
and the observation window. Never resurrect old tool aliases or mark a contained
missing capability complete.

Each residual must name scope, containment, measured signal/canary, numeric
threshold, owner and exact fix-forward trigger. Missing credentials or native
client availability is not a successful authenticated journey. Deploy safe code
as authorized and keep unproven promised behavior `production_hardening_pending`
until the remaining proof/fix is completed.

## Cleanup and completion record

Clean only the exact disposable resources created by this campaign, using their
verified project/purpose identities. Stop campaign-owned helpers, preserve the
pre-campaign unrelated Docker baseline and retain sanitized evidence.
Never remove `seha` volumes/network/keys or use broad Docker pruning.

Write exactly `completions/03-verify-and-rollout.md` and update
`completions/IMPLEMENTATION_CAMPAIGN.md`. Include:

- Implemented/deleted behavior and final capability/count/discovery-size results.
- Exact deployed source/image/resource identities and authorized actions.
- All checks, real environments, case counts, skips and truthful result classes.
- Live metadata equality, actual MCP/browser journeys, native/model-assisted
  evidence, observation duration and unrelated-service health.
- Data/key continuity, disposable cleanup and owned residual incidents.
- Remaining containment/proof limitations with owners and exact next actions.

Done only when all three promised outcomes are working and the deployed revision
has been observed. Literal inability to execute authorized deployment leaves
`deployment_pending` with an exact resumption command/target; deployed but
unproven promised behavior leaves `production_hardening_pending`.
Neither is a completed campaign or a test-only terminal result.
