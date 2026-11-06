# Phase 01 completion — roleless discovery authority

## Outcome and scope

- Implemented and isolated-verified on 2026-11-06. Worker launch: `gpt-6.1-sol`, `reasoning_effort: xhigh`; no nested delegation.
- Repository baseline: `c28fa870c39a009c2f3537e0db87142739f893e4`. The only pre-existing work was the parent's campaign record; it remains unchanged. Parent alone advances manifest statuses.
- Authorized actions performed: local source/configuration/documentation edits, existing isolated PostgreSQL fixtures, cached local containers and mocked provider/control-plane tests on Docker Desktop. No production/remote actions, Entra changes, live reset, commits, pushes or branches.
- Phase 02 discovery/subject services and schema replacement, phase 03 projected native SDK surface, and phase 04 production deployment were not implemented early.
- Falsifiable hypothesis: removing the role-presence rejection alone would neither safely authorize an employee nor bootstrap first-run data. Cheapest checks were the finite route-policy inventory and existing Viewer guards in automatic collection. They confirmed both problems. The fix reuses those owners rather than introducing a second policy or scheduler.

## Baseline and authority contract

### Operations and role admission

- Baseline API policy: **172** registered method/route operations. Current policy: **174**, adding only the two MCP authority/entry routes below. `routes/policy.test.ts` asserts the complete operation list.
- Existing finite Python catalog: **105** distinct canonical method/route operations: **66 GET, 38 POST, 1 PATCH**. `tools.py`, public tool/domain composition and native SDK registration remain unchanged for phase 03. No existing business operation becomes an employee operation.
- Every sensitive authenticated API route already had an explicit staff role. The policy test now pins that invariant. The only role-unrestricted authenticated routes are the two new routes plus browser-only `/me` and `/auth/logout`; public login/callback/status/health behavior is preserved.
- Only absent or empty role claims are eligible for default employee authority. All present role values must be known current AppRole values; malformed, unknown, mixed known/unknown or oversized claims are rejected, not sanitized into empty roles. Saved sessions follow the same rule.
- Signed delegated-token issuer, tenant, audience, authorized client, delegated scope, expiry, same-user OBO, current authority and revocation checks remain. Workload tokens are rejected. Python rejects invalid `idtyp` values, including explicit null, and validates both upstream and exchanged API roles.
- The three AppRole values and `hasAppRole` hierarchy are unchanged. No EndUser role or registration-manifest role was created.

### Exact access profile

`GET /api/mcp/access-profile` is authenticated and `Cache-Control: no-store`; query options and subjects are rejected. Its only top-level keys are:

| Key | Contract |
| --- | --- |
| `audience` | `end_user`, `adoption` or `admin`, derived by the API from the actual current actor |
| `operations` | Sorted canonical `{method, route, inputChoices?}` entries |
| `staffPreviewAuthorized` | Current actor's Viewer hierarchy only |
| `privacy` | Effective API-owned `{hide_employee_details, hide_champion_employee}` |

Operations are derived from `declaredRoutePolicies`, excluding browser-only operations and applying actual role and existing capability internal-role guards. `POST /api/capabilities/:id/probe` has finite `inputChoices.capabilityId` from the existing capability registry; Viewer does not acquire Admin capability choices. This is not a copied Python tool catalog or provider-readiness report.

The roleless profile has **exactly two** entries:

```text
GET  /api/mcp/access-profile
POST /api/mcp/authenticated-entry
```

The profile contains no employee/workplace records, target roles, provider diagnostics, readiness gate or collection side effect. Missing/currently invalid authority fails closed. Actor roles, tenant and account are not replaced by a preview subject. Phase 02 must resolve a separate saved-account subject under this immutable actor; phase 01 implements no preview business endpoint.

### Bounded employee membership

- Roleless API/browser admission verifies the actual tenant-local `oid`, retained as `localAccountId`; it never guesses from email or uses the home-account identifier as Graph oid.
- Exact application Graph request: `/v1.0/users/<actual-local-oid>?$select=id,accountEnabled,userType`, using existing `graph.users.read` application-token acquisition. No broad directory fallback or Copilot license requirement.
- Exact matching UUID, enabled account and Member discriminator are required. Guest, disabled and missing accounts receive `403 employee_required`; wrong oid/malformed provider records fail `502 provider_schema`. Provider failure is explicit `503 employee_verification_unavailable`, not a fabricated membership result.
- Uses the existing shared authentication operation: **10-second** deadline, **16 KiB** bounded body, **1,024** evidence-entry maximum, and freshness no longer than **5 minutes** or principal expiry. In-flight capacity exhaustion is explicit `429`.
- Cache identity includes tenant, actual principal/local oid, authorization hash, session epoch, authenticated-at/expiry and tenant-configuration fingerprint. Current authority is checked before and after even cached evidence. Concurrent waiter cancellation is independent; failed operations are removed so recovery is possible.
- The middleware owns one verifier instance. There is no unused global verifier or employee-profile persistence owner.
- The eligibility lookup never writes canonical company/department or creates a workplace row. An unlicensed active member can remain catalog-only after automatic synchronization.

## Authenticated entry and first-run evidence

`POST /api/mcp/authenticated-entry` is authenticated, no-store, uses the existing browser CSRF policy and existing bearer exemption, and accepts only empty query/body. Role, subject, source and collection-option overrides are rejected.

- Normal response: `202 {admission: "scheduled" | "current", nextCheckAt}` with the next check five minutes ahead.
- Expected admission failures `429/502/503/504` explicitly return `202 {admission: "retryable", errorCode, nextCheckAt}` one minute ahead and emit safe warning telemetry. Unexpected/authentication failures propagate. This is not a catch-to-success path.
- Admission starts asynchronous existing DataSync work, not synchronous provider completion. Normal profile/business reads do not dispatch.
- The actual employee receives only automatic application sources **`graph_packages` and `users`**. A narrow async application-read credential context retains the genuine actor, credential source and **empty app roles**; it does not borrow Viewer or grant manual capability/probe/control access.
- The application-only exception is finite and checked by existing source/capability owners. Existing Viewer/Uploader/Admin automatic and delegated behavior remains governed by their real roles/provider availability.
- Existing six-hour successful-source and one-hour failed-source due rules remain. Fresh sign-in/recovery uses the existing owner. A tenant-scoped transactional advisory lock prevents two principals from admitting the same due application sources concurrently.
- Server-owned `sync_cleanup` can still cancel its own local saved child jobs after role loss. User-requested cancellation retains its staff-role and ownership checks. This fixes cleanup needed by the new roleless automatic path without granting user cancellation privileges.

### Actual isolated first-run checks

`automaticRefreshIntegration.test.ts` uses fresh isolated databases, real Express HTTP routing, signed bearer/OBO identity validation, existing authority/source/job services and actual persisted rows. Only external identity/provider responses are fixture-controlled; this is not live Entra/Graph proof.

1. A genuine roleless fixture actor calls the HTTP access profile: **zero** source dispatches.
2. Its first HTTP authenticated-entry returns scheduled. The worker dispatches **one** package job, **one** package-catalog collection, **zero** Power Platform jobs and **two** user-provider reads.
3. Persisted run attribution is exactly the initiating actor's `homeAccountId`; roles remain empty. Persisted source set is exactly packages/users. The unlicensed fixture leaves **zero** `directory_user_rows` workplace records.
4. Reconnect, concurrent other identity, repeated entry, recovery and subsequent entry do not produce another package/catalog dispatch.
5. Manual sync, direct staff auto-refresh and package/Power Platform user cancellation remain denied.
6. An interrupted employee worker is recovered by the existing restart owner and fresh same-user sign-in. Existing fresh Viewer and Admin first-run source sets are also exercised, without a Permissions visit, Check status or Sync click.
7. An additional real-database cold-race test starts **six simultaneous** due-admission calls across **two distinct principals** in a previously empty tenant. It asserts **one** created run, **one** actual winning input principal and exactly **two** source rows, without assuming which principal wins.

The combined suite also covers absent/empty roles, role inheritance, missing licensed snapshot, guest/disabled/wrong oid/tenant, malformed roles, timeout/expiry/cancellation, authority loss/demotion/revocation, principal separation, all sensitive-route denials, retryable admission, configuration variants and reset/current-schema behavior.

## Browser and deleted contracts

- A roleless session has no workbench view. The browser renders account information, a conversational discovery handoff and sign-out, not a catalog, staff page or instruction to obtain an EndUser role.
- The App roleless deep-link test asserts the complete request set: `/api/auth/status`, `/api/me`, `/api/mcp/authenticated-entry`. No operational metadata, capabilities, inventory, jobs or reports are fetched.
- The handoff automatically invokes authenticated entry, aborts on unmount and visibly reports transport/retryable errors. Subsequent admission checks are bounded to **one–five minutes**, including disagreement between browser/API clocks.
- Existing storage-cleanup warnings remain visible in the handoff.
- Deleted the superseded `roleAssignmentRequired` response/type/consumer/fixture contract without an alias. Repository search finds no remaining producer or consumer in application roots; its remaining mention in the assigned plan is historical task text.
- Removed the unreachable roleless exact-package lookup component, its refresh handler and associated CSS. The shared `startExactPackageRefresh` client function remains because actual Admin preparation still uses it.
- Updated permission explanations and affected browser fixtures together. Playwright execution itself is not claimed below.

## Deployment-owned privacy and registration configuration

| Persisted deployment key | API environment | Default |
| --- | --- | --- |
| `hide_employee_details` | `MCP_HIDE_EMPLOYEE_DETAILS` | `false` |
| `hide_champion_employee` | `MCP_HIDE_CHAMPION_EMPLOYEE` | `false` |

- These are independent deployment booleans. Local wizard/input accepts exact booleans, Enter preserves a saved value, import omission preserves saved values, and an initially absent setting defaults false. Null/string/numeric settings are rejected. Tests cover **all four combinations**, saved/import/edit round trips, omission/defaults and malformed values.
- Local environment production emits lowercase `true`/`false`; privacy-only edits are API application-setting changes, not identity/secret rotation.
- Both Compose MCP/metadata overlays pass the settings only to the API. Azure validates the input object and exact booleans, supplies the same API `mcpMetadata` values and defaults omitted fields false.
- `infra/main.bicep` explicitly emits lowercase environment literals using boolean ternaries; it does not depend on boolean stringification casing.
- API startup parsing is strict; clients and preview subjects have no override. The Python process and `infra/mcp.bicep` intentionally have no duplicate privacy owner/environment.
- Privacy does not disable collection, change source data, assign roles, rotate OAuth keys or gate sign-in/catalog availability. Phase 02 owns safe-output enforcement for both employee and staff preview.
- Registration guidance now documents assignment-required **No** where needed for employee admission. Azure no longer rejects the existing registration merely for that property; it records it without mutation.
- `infra/entra-id-api-mcp-app-registrations.md` gives phase 04 exact bounded control-plane instructions: verify the reconciled tenant, resolve each actual API/MCP appId to exactly one existing service-principal object ID, PATCH only `appRoleAssignmentRequired:false`, then GET-verify appId/property. Preserve assignments, consent, credentials, registrations and callbacks. No Entra write permission is granted to the MCP app.
- Phase 04 must deploy hardened API/MCP before widening assignment-required admission. No registration/configuration mutation was performed here.

## Verification commands and results

Final unique counts: **2,247 tests passed** (**787 backend + 1,301 frontend + 159 Python**), separately **2,004 PowerShell assertions passed**. Do not double-count earlier subsets or repaired attempts.

| Final command group | Result |
| --- | --- |
| Backend combined isolated selectors below | passed — 787 tests / 16 files |
| `npm run typecheck --workspace backend` inside the same isolated runner | passed |
| Frontend combined selectors below | passed — 1,301 tests / 10 files |
| `npm run typecheck --workspace frontend` | passed |
| `npm run lint --workspace frontend` | passed |
| `cd mcp && .venv/bin/python -m pytest tests/test_oauth.py tests/test_api_origin.py tests/test_onboarding.py` | passed — 159 tests |
| `cd mcp && .venv/bin/python -m ruff check src tests` | passed |
| `cd mcp && .venv/bin/python -m mypy` | passed — 24 source files |
| `& ./scripts/local-mcp.tests.ps1` | passed — 232 assertions |
| `& ./scripts/local-deployment.tests.ps1` | passed — 1,396 assertions |
| `& ./scripts/azure-deployment.unit.tests.ps1` | passed — 70 assertions |
| `& ./scripts/azure-deployment.tests.ps1` | passed — 306 assertions |
| `git diff --check` | passed |

Status ledger units are command groups/classes, not test cases: **13 passed, 0 final failed, 1 unavailable** (Bicep compilation), **3 not_run classes** (actual Playwright browser execution; production deployment/control-plane/reset; real production/client/model/restart/capacity/observation journeys), **0 inconclusive**. PowerShell external operations are mocked and are not deployment evidence. Template content/environment-contract assertions passed; compiler validation did not.

### Existing isolated backend runner

The new named `mcp-roleless-authority` selection is integrated with `scripts/large-tenant-tests.ps1` and `backend/scripts/largeTenantFixture.ts`:

```powershell
& ./scripts/large-tenant-tests.ps1 -Suite mcp-roleless-authority `
  -BaselineImage agent-control-roleless-baseline:local `
  -BaselineImageId sha256:cc9f4e9efb6428322b82764ba35c40bbbb49890cd76ef563c7967182d85ba9cd
```

Its exact combined test command is:

```sh
npm run test --workspace backend -- src/auth/mcpBearer.test.ts src/auth/requestPrincipal.test.ts src/auth/msal.test.ts src/middleware/auth.test.ts src/routes/policy.test.ts src/services/mcpAccess.unit.test.ts src/services/employeeProfile.unit.test.ts src/routes/mcpApiAuth.test.ts src/services/dataSync.test.ts src/services/automaticRefreshIntegration.test.ts src/db/dataSync.test.ts src/db/sessions.test.ts src/db/schema.test.ts src/app.test.ts scripts/dataSyncPersistence.test.ts scripts/databaseReset.test.ts --silent=false
```

Final evidence directory:
`artifacts/large-tenant-data-platform/e039ba1aac4f4e5ea23e5a59d6eb1cd4/`.
`result.json` has no failures. Work log
`cef61407a346c7f825f8ef749c6bb4f5430d1203d25b893456ee487b57549c0d.log`
records exit 0 for both the 787-test selection (60,664 ms) and backend typecheck (4,401 ms). Owned fixture containers and volume were removed; a final exact-name inspection found none remaining.

### Frontend command

```sh
npm run test --workspace frontend -- src/authorization.test.ts src/components/PermissionCenter.test.tsx src/components/EmployeeDiscoveryHandoff.test.tsx src/components/PermissionCheckProgress.test.tsx src/useCapabilities.test.tsx src/App.session.test.tsx src/App.inventory.test.tsx src/App.commands.test.tsx src/App.signIn.test.tsx src/api/client.test.ts
```

Retained local evidence: `artifacts/test-scratch/roleless-frontend-tests.log`,
`roleless-config-tests.log`, `roleless-isolated-tests.log` and the isolated runner's receipts. Earlier failing attempts were repaired: obsolete roleless/role-sanitization/heading expectations, a hidden storage warning, cleanup after role loss and incomplete new integration-fixture dependencies/spies. They are not unresolved residuals or weakened expectations.

## Environment, dependencies and reproducibility

- Host: macOS, Node `v24.22.2`; Python virtual environment **3.14.10**. Fixture Node **v24.20.0**, Vitest **4.1.11**.
- Docker **29.9.2**, existing context **`desktop-linux`**, exact socket **`unix:///Users/candede/.docker/run/docker.sock`**. No `DOCKER_HOST`/`DOCKER_CONTEXT` override; no production identity inferred from local running containers.
- Host `pwsh` and `dotnet` were killed with exit 137. Recovered PowerShell **7.4.7** through an existing cached amd64 image on the arm64 Docker engine. Its pre-existing image identity is `sha256:663a172849444279d8e7b50e19977b6e42380eae6856bdc8931ca08e2e03e92a`.
- Offline helper `agent-control-roleless-powershell:local` is `sha256:d8c890e2a42c8f7763b972e2c17e9bbf3e301597c0bc24d52eaf8332abb61162`. Its Dockerfile copies cached Docker 29 CLI/Compose into that PowerShell base. Launch uses `--rm --pull=never --network none --user 501:20 --group-add 0`, mounts the repository and existing Unix socket at their original absolute paths, and uses `PATH=/usr/local/bin:/usr/bin`. Non-root plus socket group preserves fixture guards.
- The Docker function in PowerShell invokes `/usr/local/bin/docker --config (Join-Path (Get-Location) "artifacts/test-scratch/roleless-docker-config") @args`; that created context contains the exact local endpoint, no mounted host credentials. Azure command tests use a `node` adapter to the cached baseline container with `--network none`, the same repository mount and `NODE_PATH=/app/node_modules`. Scratch/cache paths stay under the repository.
- Historical default fixture baseline `sha256:78f3cb9fa91e7a64960699899d8fe2eb56bdd77c8ee56490f1f5255855b3c235` did not match current locked manifests. Narrow cached-image checks found no matching candidate among the first 30 relevant operator images. A real focused run on the cached fallback then failed on missing `stream-json/parser.js`; guards were not disabled.
- Recovered the current baseline using the existing Dockerfile/target:

```sh
docker build --pull=false --progress=plain --target operator --build-arg DEPENDENCY_BASE=agent-control-fastmcp-04b-478805dbc951-operator:local -t agent-control-roleless-baseline:local .
```

All current dependency installation layers were **CACHED**. Current baseline identity is
`sha256:cc9f4e9efb6428322b82764ba35c40bbbb49890cd76ef563c7967182d85ba9cd`.
No dependency manifests changed, no package downloads/installations were performed, and no public npm/Python index was probed. Existing approved npm registry and Python environment were retained.

- Bicep compilation is **unavailable**: host compiler/az absent and dotnet killed; cached Azure CLI 2.77 image `sha256:d41153958a61392a4c9db1591e33b533ca8ab8b59529d212d06bb6ec7e9c1f25` reported Bicep CLI not installed during an offline probe. No download was attempted. This is not a template compile pass.
- Disposable test containers/volumes are cleaned. Local evidence and the exact offline helper/context/current baseline are retained for subsequent campaign phases. The `agent-control-roleless-powershell-base:local` tag points to a pre-existing formerly untagged cache image; it is deliberately not removed with an operation that could delete that pre-existing image. No broad cache/image pruning occurred.

## Changed files and unchanged-root impact

All five implicated roots were traced and changed coherently:

| Root | Changes and intentionally unchanged contracts |
| --- | --- |
| `backend` | Auth claims/session/local oid, member verification, access-profile/entry, narrow automatic application authority, admission/cleanup and isolated coverage. Existing policy/capability/source/directory owners reused. SQL schema and migration history unchanged; no employee store or discovery business services. |
| `frontend` | Roleless routing/handoff, exact request exclusions, API types, explanations and fixtures. Staff routing/control callers retained. No browser catalog. |
| `mcp` | Strict roleless OAuth/API exchange parity and privacy example settings. Native SDK tools/domains/catalog and business handlers unchanged; phase 03 owns authenticated initialize/list and projection. |
| `scripts` | Local/Azure privacy producers/validators/docs guidance and named existing fixture selection. No second deployment owner or live-control automation. |
| `infra` | API privacy environment, target example and precise registration instructions. `infra/mcp.bicep` and Entra app-role manifest intentionally unchanged; no Python-owned privacy duplicate, write grant or new role. |

Changed tracked paths, plus eight new implementation/test files and this completion record:

```text
backend/scripts/largeTenantFixture.ts
backend/src/app.test.ts
backend/src/app.ts
backend/src/auth/appRoleClaims.ts (new)
backend/src/auth/authorityContext.ts
backend/src/auth/mcpBearer.test.ts
backend/src/auth/mcpBearer.ts
backend/src/auth/msal.test.ts
backend/src/auth/msal.ts
backend/src/auth/requestPrincipal.ts
backend/src/config.ts
backend/src/db/dataSync.test.ts
backend/src/db/dataSync.ts
backend/src/db/sessions.test.ts
backend/src/db/sessions.ts
backend/src/middleware/requestAuthentication.ts
backend/src/routes/auth.ts
backend/src/routes/mcpAccess.ts (new)
backend/src/routes/mcpApiAuth.test.ts
backend/src/routes/policy.test.ts
backend/src/services/agentPeople.ts
backend/src/services/automaticRefreshIntegration.test.ts
backend/src/services/capabilities.ts
backend/src/services/copilotUsage.ts
backend/src/services/dataSync.test.ts
backend/src/services/dataSync.ts
backend/src/services/employeeProfile.ts (new)
backend/src/services/employeeProfile.unit.test.ts (new)
backend/src/services/mcpAccess.ts (new)
backend/src/services/mcpAccess.unit.test.ts (new)
backend/src/services/packageInventory.ts
backend/src/services/powerPlatformInventory.ts
backend/src/services/userSourceGraphFields.ts
backend/src/types/session.ts
compose.mcp-metadata.yaml
compose.mcp.yaml
docs/deployment-setup.md
docs/mcp-integration.md
docs/mcp-reference.md
docs/user-roles-and-permissions.md
docs/mcp-role-aware-agent-discovery/completions/01-roleless-discovery-authority.md (new)
frontend/browser/auditOrigin.spec.ts
frontend/browser/cumulativeUsage.spec.ts
frontend/browser/inlineAgentManage.spec.ts
frontend/browser/layoutFixtures.ts
frontend/browser/permissionLayout.spec.ts
frontend/browser/permissions.spec.ts
frontend/browser/reportSets.spec.ts
frontend/browser/selectedImportFixture.ts
frontend/src/App.css
frontend/src/App.tsx
frontend/src/api/client.test.ts
frontend/src/api/client.ts
frontend/src/authorization.test.ts
frontend/src/authorization.ts
frontend/src/components/EmployeeDiscoveryHandoff.tsx (new)
frontend/src/components/EmployeeDiscoveryHandoff.test.tsx (new)
frontend/src/components/PermissionCenter.test.tsx
frontend/src/components/PermissionCenter.tsx
frontend/src/components/PermissionCheckProgress.test.tsx
frontend/src/components/SignedInUserRoles.tsx
frontend/src/test/appSessionCases.tsx
frontend/src/useCapabilities.test.tsx
infra/entra-id-api-mcp-app-registrations.md
infra/main.bicep
infra/mcp-target.example.json
mcp/examples/local-settings.example.json
mcp/src/agent_control_mcp/auth.py
mcp/tests/test_api_origin.py
mcp/tests/test_oauth.py
scripts/azure-deployment.ps1
scripts/azure-deployment.tests.ps1
scripts/azure-deployment.unit.tests.ps1
scripts/large-tenant-tests.ps1
scripts/local-deployment.ps1
scripts/local-mcp.ps1
scripts/local-mcp.tests.ps1
```

### Content identities (SHA-256)

| Content | SHA-256 |
| --- | --- |
| Binding README | `e09a877b4a7a7ec13278c2eae52a8443f70f37b1f0428d4db4439a3ba0c4f519` |
| Assigned phase prompt | `e115dd40f3bbc0c75a61301f5e6b9b4f1ab0cb96f29555da45a383ef9f916a59` |
| Unchanged parent campaign record | `61be0c66a1189c4e97df090365f644e527be88007fe7e6917ef431bec073ad08` |
| `backend/src/services/mcpAccess.ts` | `4ad3b390208e5a3cc3c2f5cdab8435adee9ace314f33850a440fa4ca51bbe476` |
| `backend/src/services/employeeProfile.ts` | `692d36f2e9b2b38eec8abbf55adca7c3ffb2e8121378d501111359b038f3b6d0` |
| `backend/src/routes/mcpAccess.ts` | `4973d2fc97fa51e91c028723d1270793797a4786e6cd80100f93f82d14848a3c` |
| `frontend/src/components/EmployeeDiscoveryHandoff.tsx` | `297293777f15754524527eb5ae2e1f092527fdb47dc907e3df12feb8be7ac3cb` |
| `mcp/src/agent_control_mcp/auth.py` | `25372a091703b7b40cbf28f8c2a1b18f317b071e5aa7d40645c1fc8550ebf3a3` |

## Material simplicity decisions

1. One route-policy-derived authority contract, not a second role/tool policy map. Finer capability choices remain owned by the current registry.
2. One bounded exact eligibility lookup, not a second directory/profile writer or license gate.
3. One existing DataSync/job admission path with actual credentials and finite application-read context, not role borrowing, a scheduler or MCP provider writer.
4. Tenant-lock dedup in the current repository, not a new job/schema owner.
5. One API privacy owner with deployment producer parity, not per-user preferences or Python overrides.
6. Current-only deletion of the old browser flag/path; no compatibility alias, migration chain, additional approval or manual-start requirement.

## Residuals, release state and next preconditions

These are evidence/deployment bookkeeping, never runtime authorization or extra release approval.

| Residual / affected scope | Existing containment and live signal | Numeric threshold / owner / exact fix-forward trigger |
| --- | --- | --- |
| Bicep compiler unavailable; Azure API template syntax not compiler-proven | Strict producer tests and explicit lowercase template assertions pass; no Azure deployment was attempted | **1** compile/deployment validation error triggers template root fix and focused producer checks. Phase 04 owner runs supported `az bicep build --file infra/main.bicep` in an approved equipped environment and records actual output; no pretend compile success. |
| Actual browser/Studio/native client and provider journeys unproven | Isolated real HTTP/source/DB and App request-allowlist tests pass; existing staff authorization and explicit unavailable/retry paths remain | **1** forbidden roleless request, wrong-user attribution, privacy disclosure or failing first-entry bootstrap triggers containment, root fix, focused rerun and exact affected-service redeployment. Phase 03 owns native entry; phase 04 owns actual Playwright/client/read-only journeys and observation. |
| Current `seha` installation identity/deployment remains unreconciled | No local container was treated as production and no live mutation/reset occurred | **1** host/context/project/origin/image/service/volume mismatch prevents that control-plane mutation, not application availability. Phase 04 must reconcile the exact existing target, deploy API/frontend/MCP coherently, apply only necessary existing-SP property changes and execute the single authorized reset under existing guards; completed-reset retries omit `-DbReset`. |
| Real Graph/Power Platform/report availability is not demonstrated by fixture providers | Authorization/identity fail closed; source admission is asynchronous and retryable; roleless starts only application packages/users, not delegated Power Platform or fabricated reports | More than **1** active package/users source set for the same due revision, any source job attributed to a different actor, or membership exceeding **10 seconds / 16 KiB / 1,024 entries / 5-minute freshness** triggers existing bounds/error telemetry and owner fix-forward. Phase 04 verifies actual employee-first rebuild and real Viewer/Admin workflows; provider limitations are reported specifically, never replaced with fake data or manual Sync prerequisites. |

Phase 01 release state: **isolated implementation verified**. Campaign production remains **`deployment_pending`** until phase 04's exact-target deployment is executed; affected unproven live workflows remain **`production_hardening_pending`**. No production success, capacity result or published per-user identity is claimed.

Phase 02 can now consume the API-owned current actor/roles/privacy and canonical saved-account mapping, while keeping the active-member lookup separate. Implement subject/business discovery and current schema under its prompt; preserve catalog-only unlicensed behavior and apply both privacy settings to self-service and preview without changing catalog membership/source collection. Do not overwrite workplace fields from token/live identity lookup.

Phase 03 must call the exact authenticated-entry contract during native SDK initialize/list (including reconnect/refresh), consume the current access profile/finite capability choices and project only allowed operations. Normal list/tool reads must not become another source scheduler. Preview must keep the actual staff actor immutable and use phase 02's separately authorized subject; do not grant the target's roles.

Phase 04 alone owns reconciliation and bounded coherent production cutover, the necessary assignment-required changes and one authorized reset, preservation of registrations/assignments/consent/secrets/callbacks/keys/encrypted OAuth state, genuine report import, real client journeys and observation. Parent campaign statuses were not modified by this worker.

## Phase 04 owning-contract follow-up

Phase 04 added isolated employee/Viewer/Admin first-entry browser cases on
desktop/mobile, each with a fresh tenant and persisted automatic-source
assertions. These use the existing real browser/API/database runner, synthetic
OAuth/providers and the unchanged production membership/authority owners.
The first-entry cases explicitly do not use the permissions page, manual Sync
or an MCP-settings warm-up; automatic staff capability checks are not a manual
permissions visit. Their final results and content hashes are recorded in
[phase 04](04-verify-deploy-and-observe.md).

Four old session-test metadata producers were updated for the mandatory
effective API privacy fields; the production parser was not relaxed.
The full frontend suite subsequently passed **5,722 tests in 136 files**.
No live employee identity, Entra change, production reset or deployment is
established by these fixture results. The parent campaign manifest is unchanged
by the phase 04 worker.
