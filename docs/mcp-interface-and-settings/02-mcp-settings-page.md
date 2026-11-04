# 02 - Expose exact runtime metadata and build the MCP settings page

## Mission and prerequisites

Deliver one complete path: running MCP metadata -> protected backend reader ->
read-only web page. The page is available to Viewer-capable users when MCP is
configured for their tenant and remains useful when the sidecar is unavailable.

Prerequisite: phase 01's current public contract and factual
`completions/01-simplify-mcp-contract.md`.
Read [README](README.md), all shared contracts, production-continuation policy,
and the installed implementation step-worker contract.

## Read first

- [MCP service](../../mcp/src/agent_control_mcp/service.py),
  [settings](../../mcp/src/agent_control_mcp/config.py),
  [catalog](../../mcp/src/agent_control_mcp/tools.py) and
  [storage readiness](../../mcp/src/agent_control_mcp/storage.py)
- [Backend configuration](../../backend/src/config.ts),
  [workbench route](../../backend/src/routes/workbench.ts),
  [workbench view owner](../../backend/src/services/workbenchMetadata.ts),
  [metadata parser/types](../../backend/src/types/workbench.ts),
  [route policy](../../backend/src/routes/policy.ts) and
  [API assembly](../../backend/src/app.ts)
- [Frontend application](../../frontend/src/App.tsx),
  [routing](../../frontend/src/workbenchRouting.ts),
  [authorization](../../frontend/src/authorization.ts),
  [API client](../../frontend/src/api/client.ts) and
  [styles](../../frontend/src/App.css)
- [Local MCP owner](../../scripts/local-mcp.ps1),
  [environment writer](../../scripts/local-deployment.ps1),
  [runtime](../../scripts/local-runtime.ps1), [Compose](../../compose.yaml),
  [MCP overlay](../../compose.mcp.yaml) and
  [fixture ownership checks](../../scripts/local-mcp-fixture.ps1)
- [Azure deployment owner](../../scripts/azure-deployment.ps1),
  [API infrastructure](../../infra/main.bicep),
  [MCP infrastructure](../../infra/mcp.bicep) and
  [target example](../../infra/mcp-target.example.json);
  [secret access](../../infra/key-vault-access.bicep) and the
  [prepared Azure secret contract](../mcp-reference.md#azure-hosting-profile)
- [Isolated suite entry point](../../scripts/large-tenant-tests.ps1),
  [suite/image owner](../../backend/scripts/largeTenantFixture.ts),
  [API/browser fixture](../../backend/scripts/browser-fixture.browser.ts) and
  [fixture safeguards](../../backend/scripts/fixtureSupport.ts)

Read scoped status and trace current secret/config producers and consumers before
editing. These anchors are entry points, not an edit boundary.

## Concrete work

### 1. Runtime producer and metadata-only authentication

- Implement `GET /internal/mcp-metadata` using the phase 01 registered SDK wire
  definitions and actual initialization information/instructions. Share the
  final serialization source, not a manually assembled second catalog.
- Return only the README's whitelisted runtime fields, tool schemas/annotations,
  binding and truthful readiness evidence. Use the actual MCP resource URL and
  current callback allowlist. Do not open/read OAuth transactions or credentials.
- Authenticate with a separately generated metadata-only credential, using
  constant-time comparison and repository-standard redacted failures. A dedicated
  `X-Agent-Control-Mcp-Metadata-Token` header avoids treating this key as
  an OAuth assertion. Keep it out of logs, error bodies and diagnostics.
- Unauthenticated/wrong-key callers cannot read the endpoint. The credential
  cannot initialize MCP, invoke tools, mint user tokens or authorize API actions.
  Reserve the route against configured MCP resource-path collisions in Python,
  local settings/import validation and supported Azure validation together.
- Reuse existing readiness semantics without starting provider work. If metadata
  protection/configuration is unavailable, fail that path explicitly and keep
  otherwise valid ordinary MCP operation intact. Optional metadata settings must
  not enter required OAuth/bootstrap configuration or weaken storage fencing.

### 2. Deployment and backend integration

- Extend the local secret/config owner to create/persist the independent
  `secrets/mcp-metadata` credential automatically. Reuse a valid existing file on
  restart; a missing metadata-only file may be generated without replacing any
  OAuth key. Invalid/link/unreadable files are explicit metadata errors, not
  permission to regenerate the three existing OAuth secrets or clear state.
- Mount only this new shared credential into API/MCP with protected files,
  matching UID/GID, correct modes and read-only access. Add no local wizard
  question, new user consent, feature switch or manual credential step.
  If metadata-only provisioning is unusable, surface the scoped failure and omit
  only its unusable inputs/mounts; deploy otherwise valid business configuration.
  A required Compose secret/mount or global configuration check must not turn
  the optional visibility failure into an API/MCP startup/deployment veto.
- Obey the approved Azure prepared-secret boundary in the README. Extend current
  targets, API/MCP templates, native Key Vault references and isolation checks
  for one prepared metadata secret pinned to the same version on both services.
  The API identity may read this secret, not the three MCP OAuth secrets;
  MCP gains no API/session/database secret access. Do not generate Azure secret
  values, add Key Vault write privileges or create another provisioning workflow.
- Wire the Azure API's fixed metadata origin and expected binding alongside its
  reference, not only the MCP template. Represent necessary API-to-MCP ingress in
  the existing explicit network contract; do not open public/wildcard access or
  silently assume that a client allowlist permits the API.
- Propagate only the nonsecret deployment-controlled binding needed by the API:
  metadata origin, expected tenant/application/resource identity and genuinely
  known local host-port information. The allowlist itself comes from MCP runtime.
- The local origin uses the existing `mcp` service DNS on the project network;
  it does not depend on the public tunnel working. Do not publish another port.
- Update normal startup, Compose rendering, one-shot storage/test invocations,
  fixture mount ownership checks and current Azure validators/templates/examples
  together. This includes any exact credential-name/count assumptions.
  Azure contract checks are offline; no Azure deployment is authorized.
- Implement browser-only `GET /api/mcp/settings` with the existing session and
  Viewer-role policy. No provider capability is required for metadata.
- Validate the current session tenant's configured binding before fetching or
  returning runtime metadata. Reuse that decision for workbench navigation.
  Do not infer a deployed service only from a global `integration` field or
  expose a different tenant's configured server.
- Enforce README C's deadline, streamed byte bound, fixed configured destination,
  no redirects, response validation and credential redaction. Avoid retries or
  background polling that can stall unrelated requests. Cancel on disconnect and
  recheck the initiating session/tenant authority after awaited work using
  existing helpers. Return `Cache-Control: no-store`; assign the observation
  time only after a complete, validated fetch.
- Distinguish no configured server, current validated runtime metadata, fetch/
  readiness failure and binding mismatch. Preserve known configured intent as
  explicitly configured values, never relabel it as observed runtime truth.
  Distinguish internal service reachability from public tunnel/client verification.
  No empty-success fallback or SQL catalog owner.
- Missing/invalid/unresolved metadata-only configuration is reported by the
  settings path without crashing API startup, sign-in or ordinary MCP admission.
  Keep the configured navigation visible during that failure.

### 3. Web page and navigation

- Add `mcp-settings` / `/mcp-settings` to every relevant shared view union,
  parser, navigation, authorization and direct-link surface. Scope configured
  presence by tenant, not by whether the latest metadata request succeeded.
- Keep the workbench metadata response small: navigation only. Use the dedicated
  settings endpoint for the catalog; do not weaken its existing 65,536-byte cap
  or shallow-parser contract to fit the new feature.
- Add a focused page component using existing query/cancellation/error patterns.
  Show purpose/instructions exactly, server/version, resource URL, observed
  readiness/time, tool count, searchable complete tool descriptions, safety
  hints and expandable input/output schemas.
- Explain the difference between the server's Entra `/auth/callback` and allowed
  downstream client redirects. Show actual known host port without confusing
  port 8000, the web-app URL or the public HTTPS endpoint.
- Preserve exact description and instruction strings; use inert text with useful
  whitespace handling. Do not execute source text, inject HTML, paraphrase,
  silently trim content or expose any secret via copy/export helpers.
- Include loading, not-configured, unavailable/mismatched and explicit retry
  states. A metadata refresh re-reads metadata only. There are no configuration
  editing controls or buttons that enroll a client or trigger a capability probe.
- Allow Viewer, Uploader and Admin as their existing role hierarchy permits.
  Reject unauthorized direct API calls and clear data across tenant/user changes.
  Long URLs/schema text must remain accessible at desktop and 360px widths.
- Update the relevant setup/client/reference/operations docs with the new page,
  field meanings, credentials boundary and honest limits of “active” status.

### 4. Existing integration-proof owners

- Extend the existing API/browser fixture with at least one same-run browser ->
  real API route -> real Python MCP metadata case, using synthetic bindings,
  a fixture-owned address/key and the actual registered SDK catalog. A Playwright
  interception of `/api/mcp/settings` alone cannot supply this proof.
- Reuse existing test images/fixtures and keep authentication stubs test-only.
  Preserve the browser fixture's loopback/provider restrictions. Add no production
  fixture-auth mode, generic test platform or hand-maintained catalog.
- Repair the implicated suite/image wiring described by README Verification
  boundaries. For `mcp-container`, enter the MCP-only branch without first
  requiring an unrelated old Node image. For browser runs, expose
  `-BrowserImage` / `-BrowserImageId` inputs and validate actual image identity,
  architecture and required contents rather than a historical campaign digest.
  Preserve current dependency-manifest matching and exact resource ownership.
  Record complete working invocations for phase 03.

## Verification

Add focused tests, including `mcp/tests/test_settings_metadata.py`, backend
`mcpSettings` route/service tests, frontend `McpSettings` component tests and
`frontend/browser/mcpSettings.spec.ts`. Use existing runners/fixtures, not a new
test platform.

```sh
cd mcp
.venv/bin/python -m pytest --basetemp=../.local/ac-mcp-interface-phase-02 tests/test_settings_metadata.py tests/test_config_storage.py tests/test_oauth.py tests/test_tools.py
.venv/bin/python -m ruff check src tests
.venv/bin/python -m mypy
```

From the repository root, combine new related selectors in each runner:

```sh
npm run test --workspace backend -- src/routes/mcpSettings.test.ts src/services/mcpSettings.test.ts src/routes/workbench.test.ts src/services/workbenchMetadata.test.ts
npm run test --workspace frontend -- src/components/McpSettings.test.tsx src/workbenchRouting.test.ts src/authorization.test.ts
npm run typecheck --workspace backend
npm run typecheck --workspace frontend
npm run lint --workspace frontend
pwsh -NoLogo -NoProfile -File ./scripts/local-runtime.tests.ps1
pwsh -NoLogo -NoProfile -File ./scripts/local-mcp.tests.ps1
pwsh -NoLogo -NoProfile -File ./scripts/azure-deployment.unit.tests.ps1
git diff --check
```

Run impacted additional Azure contract selectors offline after tracing their
owners; never call the Azure deployment entry point. Run the existing
`mcp-container` suite and the `cutover-browser-contract` suite with
`-BrowserFiles "mcpSettings.spec.ts,signIn.spec.ts,permissions.spec.ts"` and verified
current dependency/browser images under the repaired contract above.
Use the existing Playwright config and a campaign-owned evidence directory,
never default `/evidence` on the host. Record actual selected case counts for
desktop and mobile, including the non-intercepted integration case.

Required cases:

- Same-instance `initialize` and complete `tools/list` equal metadata exactly;
  displayed instruction/description strings remain identical.
- No/wrong metadata key, ordinary OAuth token used as metadata key and metadata
  key used as business authority are rejected; no key leaks.
- Viewer/Uploader/Admin visibility; unauthenticated/roleless denial; multiple
  tenants/projects, mismatched identities and cross-principal cache isolation.
- No MCP configured; configured but stopped/unreachable; invalid/oversized/
  duplicate-name metadata; 3-second timeout; credential/config failure and
  recovery; none becomes false “active” or a successful zero-tool list.
- Exact 4 MiB streamed byte boundary, absent/false Content-Length, a stalled
  response body under the same total 3-second deadline, redirects, cancellation
  and excessive nesting. Prove the configured valid catalog fits without
  dropping schemas or silently raising limits.
- Read-only API/page traffic causes no provider calls, sync, mutation, extra
  OAuth consent or credential writes. Automatic first-run sync remains unchanged.
- Desktop/mobile/keyboard, long exact descriptions/URLs, safe schema display,
  filtered versus total tool count, deep links, retry and logout cancellation.
- Normal existing-project MCP startup provisions only the new independent key;
  a second start reuses it and metadata-key recovery does not rotate OAuth keys.
  Existing OAuth key hashes/state are preserved, with no reset or new question.
- Missing/invalid metadata-only files, mount inputs and unresolved Azure references
  do not prevent valid business configuration from starting; settings explicitly
  reports the failure and never accepts an absent credential.
- Base Compose without MCP remains usable; both local and Azure supported
  configuration producers/consumers agree on the new metadata contract, including
  the Azure API-side reference/network binding and permitted shared-secret scope.

## Production continuation

Obey the README's binding production-continuation policy. Do not deploy during
this phase; phase 03 owns the complete future rollout. The metadata path is
read-only and isolated from business admission. Its failure must not disable
working web/MCP features or automatic synchronization.
Classify residuals truthfully with scoped production handling.

## Completion record and done conditions

Write exactly `completions/02-mcp-settings-page.md` under the shared worker contract.
Record the endpoint/credential ownership, exact metadata-equality evidence,
configuration and secret lifecycle, roles and tenant isolation, every changed
root, executed checks/results and residual handling. Include the same-run
non-intercepted browser/API/MCP proof, real selected case counts and complete
current-image fixture commands. Distinguish offline Azure contract checks from
unperformed Azure deployment/networking proof.

Done when the whole producer -> API -> page path works in the isolated fixtures,
failure cases are explicit, deployed-metadata drift cannot masquerade as success,
and no related deployment/client/type consumer is left behind.
Phase 03 may rely on the complete feature, existing OAuth continuity and
documented deployment configuration; it must not finish missing UI/API wiring.
